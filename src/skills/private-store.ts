import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";

import { canonicalJson, parseJsonBytes, type JsonValue } from "../protocol/json.js";
import { RuntimeSkillError } from "./errors.js";
import { SKILL_LIMITS } from "./types.js";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OBJECT_PATTERN = /^(sha256:[0-9a-f]{64})\.json$/u;
const OPERATION_PATTERN = /^\.object-([1-9][0-9]*)-([0-9a-f-]{36})\.(claim|stage)$/u;
const MAX_OPERATION_BYTES = 2048;
const MAX_OBJECT_ENTRIES = SKILL_LIMITS.roots * SKILL_LIMITS.packagesPerRoot * 3;
const LISTENER_PROBE_TIMEOUT_MS = 250;
const ACTIVE_DIRECTORY_OPERATIONS = new Map<string, Promise<void>>();

export type SkillPrivateStoreProcessLiveness = "alive" | "dead" | "unknown";
export type SkillPrivateStoreListenerState = "present" | "absent" | "unknown";
type CurrentUserCheck = (userId: bigint, candidate: string) => boolean;
type CleanupKind = "claim" | "stage" | "recovery-claim" | "recovery-stage";

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface OpenedDirectory {
  readonly candidate: string;
  readonly exactPrivate: boolean;
  readonly handle: HeldDescriptor;
  readonly identity: FileIdentity;
}

interface OperationClaim {
  readonly schema_version: "skill-store-operation.v1";
  readonly operation_id: string;
  readonly owner_pid: number;
  readonly created_at: string;
  readonly object_hash: `sha256:${string}`;
  readonly record_bytes: number;
  readonly record_hash: `sha256:${string}`;
}

interface OpenedFile {
  readonly handle: HeldDescriptor;
  readonly identity: FileIdentity;
  readonly bytes: Uint8Array;
  readonly links: 1 | 2;
}

interface HeldDescriptor {
  readonly fd: number;
}

export interface SkillPrivateStoreOperationHooks {
  readonly beforeStageWrite?: (stagePath: string) => Promise<void>;
  readonly afterStageWrite?: (stagePath: string) => Promise<void>;
  readonly beforeFileSync?: (stagePath: string) => Promise<void>;
  readonly afterFileSync?: (stagePath: string) => Promise<void>;
  readonly beforeLinkPublication?: (stagePath: string, objectPath: string) => Promise<void>;
  readonly afterLinkPublication?: (stagePath: string, objectPath: string) => Promise<void>;
  readonly beforeParentSync?: (directoryPath: string) => Promise<void>;
  readonly afterParentSync?: (directoryPath: string) => Promise<void>;
  readonly beforeStageCleanup?: (stagePath: string) => Promise<void>;
  readonly afterStageCleanup?: (stagePath: string) => Promise<void>;
  readonly afterObjectOpen?: (objectPath: string) => Promise<void>;
  readonly afterObjectRead?: (objectPath: string) => Promise<void>;
  readonly beforeRecovery?: (claimPath: string) => Promise<void>;
  readonly beforeCleanupSync?: (kind: CleanupKind, directoryPath: string) => Promise<void>;
  readonly afterCleanupSync?: (kind: CleanupKind, directoryPath: string) => Promise<void>;
  readonly afterFinalSourceIdentityValidation?: (kind: CleanupKind, candidate: string) => void;
  readonly afterTombstoneRename?: (kind: CleanupKind, candidate: string, tombstone: string) => void;
}

export interface CreateSkillPrivateStoreOptions {
  readonly statePath: string;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly hasServiceListener: () => Promise<SkillPrivateStoreListenerState>;
}

export interface CreateSkillPrivateStoreForTestOptions extends CreateSkillPrivateStoreOptions {
  readonly isProcessAlive?: ((pid: number) => SkillPrivateStoreProcessLiveness) | undefined;
  readonly isCurrentUser?: CurrentUserCheck | undefined;
  readonly operationHooks?: SkillPrivateStoreOperationHooks | undefined;
}

export interface SkillPrivateStore {
  ensureRoots(): Promise<void>;
  publishObject(hash: `sha256:${string}`, bytes: Uint8Array): Promise<Uint8Array>;
  readObject(hash: `sha256:${string}`): Promise<Uint8Array | null>;
}

function integrity(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY");
}

function pathUnsafe(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_PATH_UNSAFE");
}

function limitExceeded(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_LIMIT_EXCEEDED");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function identity(metadata: Pick<BigIntStats, "dev" | "ino">): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function identitiesMatch(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function acquireDirectoryOperation(identity: FileIdentity): Promise<() => void> {
  const key = `${identity.device}:${identity.inode}`;
  const prior = ACTIVE_DIRECTORY_OPERATIONS.get(key);
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  ACTIVE_DIRECTORY_OPERATIONS.set(key, gate);
  await prior;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate?.();
    if (ACTIVE_DIRECTORY_OPERATIONS.get(key) === gate) ACTIVE_DIRECTORY_OPERATIONS.delete(key);
  };
}

function defaultCurrentUser(userId: bigint): boolean {
  return typeof process.getuid !== "function" || BigInt(process.getuid()) === userId;
}

function defaultProcessLiveness(pid: number): SkillPrivateStoreProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (errorCode(error) === "ESRCH") return "dead";
    if (errorCode(error) === "EPERM") return "alive";
    return "unknown";
  }
}

function validateAbsolutePath(candidate: string): void {
  if (
    !path.isAbsolute(candidate) ||
    candidate === path.parse(candidate).root ||
    path.normalize(candidate) !== candidate ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    pathUnsafe();
  }
  const parsed = path.parse(candidate);
  if (
    candidate
      .slice(parsed.root.length)
      .split(path.sep)
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    pathUnsafe();
  }
}

function directoryCandidates(candidate: string): readonly string[] {
  validateAbsolutePath(candidate);
  const parsed = path.parse(candidate);
  let current = parsed.root;
  return candidate
    .slice(parsed.root.length)
    .split(path.sep)
    .map((segment) => {
      current = path.join(current, segment);
      return current;
    });
}

function isAtOrBelow(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assertDirectory(
  metadata: BigIntStats,
  candidate: string,
  isCurrentUser: CurrentUserCheck,
  exactPrivate: boolean,
  reachedCurrentUser: boolean,
): boolean {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) pathUnsafe();
  const mode = Number(metadata.mode & 0o7777n);
  const owned = isCurrentUser(metadata.uid, candidate);
  if (exactPrivate) {
    if (!owned || mode !== 0o700) pathUnsafe();
    return true;
  }
  if (owned) {
    if ((mode & 0o022) !== 0 && !((mode & 0o1000) !== 0 && metadata.uid === 0n)) pathUnsafe();
    return true;
  }
  if (
    reachedCurrentUser ||
    metadata.uid !== 0n ||
    ((mode & 0o022) !== 0 && (mode & 0o1000) === 0)
  ) {
    pathUnsafe();
  }
  return false;
}

function openDirectoryChain(
  candidate: string,
  privateRoot: string,
  isCurrentUser: CurrentUserCheck,
): readonly OpenedDirectory[] {
  const opened: OpenedDirectory[] = [];
  let reachedCurrentUser = false;
  try {
    for (const current of directoryCandidates(candidate)) {
      const exactPrivate = isAtOrBelow(current, privateRoot);
      const before = lstatSync(current, { bigint: true });
      const nextReached = assertDirectory(
        before,
        current,
        isCurrentUser,
        exactPrivate,
        reachedCurrentUser,
      );
      const descriptor = openSync(
        current,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const handle = { fd: descriptor };
      const held = fstatSync(descriptor, { bigint: true });
      assertDirectory(held, current, isCurrentUser, exactPrivate, reachedCurrentUser);
      if (!identitiesMatch(identity(before), identity(held))) pathUnsafe();
      opened.push({ candidate: current, exactPrivate, handle, identity: identity(held) });
      reachedCurrentUser = nextReached || reachedCurrentUser;
    }
    return opened;
  } catch (error) {
    closeDirectoryChain(opened);
    if (error instanceof RuntimeSkillError) throw error;
    pathUnsafe();
  }
}

function closeDirectoryChain(opened: readonly OpenedDirectory[]): void {
  for (const directory of [...opened].reverse()) {
    try {
      closeSync(directory.handle.fd);
    } catch {
      // Preserve the operation result fixed before descriptor cleanup.
    }
  }
}

function revalidateDirectoryChain(
  opened: readonly OpenedDirectory[],
  isCurrentUser: CurrentUserCheck,
): void {
  try {
    let reachedCurrentUser = false;
    for (const directory of opened) {
      const named = lstatSync(directory.candidate, { bigint: true });
      const held = fstatSync(directory.handle.fd, { bigint: true });
      const nextReached = assertDirectory(
        named,
        directory.candidate,
        isCurrentUser,
        directory.exactPrivate,
        reachedCurrentUser,
      );
      assertDirectory(
        held,
        directory.candidate,
        isCurrentUser,
        directory.exactPrivate,
        reachedCurrentUser,
      );
      if (
        !identitiesMatch(directory.identity, identity(named)) ||
        !identitiesMatch(directory.identity, identity(held))
      ) {
        pathUnsafe();
      }
      reachedCurrentUser = nextReached || reachedCurrentUser;
    }
  } catch (error) {
    if (error instanceof RuntimeSkillError) throw error;
    pathUnsafe();
  }
}

async function syncDirectory(
  opened: readonly OpenedDirectory[],
  isCurrentUser: CurrentUserCheck,
  before?: (directoryPath: string) => Promise<void>,
  after?: (directoryPath: string) => Promise<void>,
): Promise<void> {
  const directory = opened.at(-1);
  if (directory === undefined) pathUnsafe();
  revalidateDirectoryChain(opened, isCurrentUser);
  await before?.(directory.candidate);
  revalidateDirectoryChain(opened, isCurrentUser);
  fsyncSync(directory.handle.fd);
  await after?.(directory.candidate);
  revalidateDirectoryChain(opened, isCurrentUser);
}

async function ensureDirectory(
  candidate: string,
  privateRoot: string,
  isCurrentUser: CurrentUserCheck,
): Promise<void> {
  let reachedCurrentUser = false;
  for (const current of directoryCandidates(candidate)) {
    const exactPrivate = isAtOrBelow(current, privateRoot);
    let metadata: BigIntStats;
    try {
      metadata = lstatSync(current, { bigint: true });
    } catch (error) {
      if (!isMissing(error)) pathUnsafe();
      try {
        mkdirSync(current, { mode: 0o700 });
        chmodSync(current, 0o700);
      } catch (mkdirError) {
        if (!isExisting(mkdirError)) integrity();
      }
      try {
        metadata = lstatSync(current, { bigint: true });
      } catch {
        pathUnsafe();
      }
    }
    reachedCurrentUser =
      assertDirectory(metadata, current, isCurrentUser, exactPrivate, reachedCurrentUser) ||
      reachedCurrentUser;
  }
  const opened = openDirectoryChain(candidate, privateRoot, isCurrentUser);
  try {
    await syncDirectory(opened, isCurrentUser);
    revalidateDirectoryChain(opened, isCurrentUser);
  } finally {
    closeDirectoryChain(opened);
  }
}

function assertPrivateFile(
  metadata: BigIntStats,
  candidate: string,
  isCurrentUser: CurrentUserCheck,
  links: 1 | 2,
  expected?: FileIdentity,
): FileIdentity {
  const actual = identity(metadata);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !isCurrentUser(metadata.uid, candidate) ||
    Number(metadata.mode & 0o7777n) !== 0o600 ||
    metadata.nlink !== BigInt(links) ||
    (expected !== undefined && !identitiesMatch(actual, expected))
  ) {
    pathUnsafe();
  }
  return actual;
}

function writeAll(handle: HeldDescriptor, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(handle.fd, bytes, offset, bytes.byteLength - offset, offset);
    if (written === 0) integrity();
    offset += written;
  }
}

function readHeldExact(handle: HeldDescriptor, size: number): Uint8Array {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(handle.fd, bytes, offset, size - offset, offset);
    if (count === 0) integrity();
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (readSync(handle.fd, extra, 0, 1, size) !== 0) integrity();
  return bytes;
}

function exactFile(
  candidate: string,
  handle: HeldDescriptor,
  expectedIdentity: FileIdentity,
  expectedBytes: Uint8Array,
  isCurrentUser: CurrentUserCheck,
  links: 1 | 2,
): void {
  try {
    const named = lstatSync(candidate, { bigint: true });
    const held = fstatSync(handle.fd, { bigint: true });
    assertPrivateFile(named, candidate, isCurrentUser, links, expectedIdentity);
    assertPrivateFile(held, candidate, isCurrentUser, links, expectedIdentity);
    if (
      named.size !== BigInt(expectedBytes.byteLength) ||
      held.size !== BigInt(expectedBytes.byteLength) ||
      !Buffer.from(readHeldExact(handle, expectedBytes.byteLength)).equals(
        Buffer.from(expectedBytes),
      )
    ) {
      pathUnsafe();
    }
    const namedAfter = lstatSync(candidate, { bigint: true });
    const heldAfter = fstatSync(handle.fd, { bigint: true });
    assertPrivateFile(namedAfter, candidate, isCurrentUser, links, expectedIdentity);
    assertPrivateFile(heldAfter, candidate, isCurrentUser, links, expectedIdentity);
  } catch (error) {
    if (error instanceof RuntimeSkillError) throw error;
    pathUnsafe();
  }
}

function rawHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function objectPath(objectsPath: string, hash: `sha256:${string}`): string {
  if (!HASH_PATTERN.test(hash)) integrity();
  return path.join(objectsPath, `${hash}.json`);
}

function requireMissing(candidate: string): void {
  try {
    lstatSync(candidate, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    pathUnsafe();
  }
  pathUnsafe();
}

async function cleanupOwnedEntry(
  candidate: string,
  expectedIdentity: FileIdentity,
  isCurrentUser: CurrentUserCheck,
  links: 1 | 2,
  kind: CleanupKind,
  directories: readonly OpenedDirectory[],
  operationId: string,
  hooks: SkillPrivateStoreOperationHooks | undefined,
): Promise<void> {
  const tombstone = path.join(path.dirname(candidate), `.delete-${kind}-${operationId}.tombstone`);
  try {
    revalidateDirectoryChain(directories, isCurrentUser);
    requireMissing(tombstone);
    const source = lstatSync(candidate, { bigint: true });
    assertPrivateFile(source, candidate, isCurrentUser, links, expectedIdentity);
    hooks?.afterFinalSourceIdentityValidation?.(kind, candidate);

    // Node has no unlinkat/openat identity primitive. This accepted same-UID
    // interval is kept synchronous: validate, rename once, revalidate, unlink.
    renameSync(candidate, tombstone);
    hooks?.afterTombstoneRename?.(kind, candidate, tombstone);
    const moved = lstatSync(tombstone, { bigint: true });
    assertPrivateFile(moved, tombstone, isCurrentUser, links, expectedIdentity);
    requireMissing(candidate);
    unlinkSync(tombstone);
    requireMissing(tombstone);
    revalidateDirectoryChain(directories, isCurrentUser);
  } catch (error) {
    if (error instanceof RuntimeSkillError) throw error;
    pathUnsafe();
  }
  await syncDirectory(
    directories,
    isCurrentUser,
    hooks?.beforeCleanupSync === undefined
      ? undefined
      : (directoryPath) =>
          invokeExactNamespaceHook(directories, isCurrentUser, path.dirname(candidate), () =>
            hooks.beforeCleanupSync!(kind, directoryPath),
          ),
    hooks?.afterCleanupSync === undefined
      ? undefined
      : (directoryPath) =>
          invokeExactNamespaceHook(directories, isCurrentUser, path.dirname(candidate), () =>
            hooks.afterCleanupSync!(kind, directoryPath),
          ),
  );
}

function openExactFile(
  candidate: string,
  maximumBytes: number,
  isCurrentUser: CurrentUserCheck,
): OpenedFile {
  let handle: HeldDescriptor | undefined;
  try {
    const named = lstatSync(candidate, { bigint: true });
    const expectedIdentity = assertPrivateFile(named, candidate, isCurrentUser, 1);
    if (named.size < 1n || named.size > BigInt(maximumBytes)) integrity();
    handle = {
      fd: openSync(candidate, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW),
    };
    const held = fstatSync(handle.fd, { bigint: true });
    assertPrivateFile(held, candidate, isCurrentUser, 1, expectedIdentity);
    if (held.size !== named.size) integrity();
    const bytes = readHeldExact(handle, Number(held.size));
    exactFile(candidate, handle, expectedIdentity, bytes, isCurrentUser, 1);
    return { handle, identity: expectedIdentity, bytes, links: 1 };
  } catch (error) {
    if (handle !== undefined) closeSync(handle.fd);
    if (error instanceof RuntimeSkillError) throw error;
    integrity();
  }
}

function openRecoveryStage(
  candidate: string,
  maximumBytes: number,
  isCurrentUser: CurrentUserCheck,
): OpenedFile {
  let handle: HeldDescriptor | undefined;
  try {
    const named = lstatSync(candidate, { bigint: true });
    const links = named.nlink === 2n ? 2 : 1;
    const expectedIdentity = assertPrivateFile(named, candidate, isCurrentUser, links);
    if (named.size > BigInt(maximumBytes)) integrity();
    handle = {
      fd: openSync(candidate, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW),
    };
    const held = fstatSync(handle.fd, { bigint: true });
    assertPrivateFile(held, candidate, isCurrentUser, links, expectedIdentity);
    if (held.size !== named.size) integrity();
    const bytes = readHeldExact(handle, Number(held.size));
    exactFile(candidate, handle, expectedIdentity, bytes, isCurrentUser, links);
    return { handle, identity: expectedIdentity, bytes, links };
  } catch (error) {
    if (handle !== undefined) closeSync(handle.fd);
    if (error instanceof RuntimeSkillError) throw error;
    integrity();
  }
}

function parseClaim(bytes: Uint8Array): OperationClaim {
  let value: JsonValue;
  try {
    value = parseJsonBytes(bytes, { maxBytes: MAX_OPERATION_BYTES, maxDepth: 3, maxMembers: 8 });
  } catch {
    integrity();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) integrity();
  const keys = Object.keys(value).sort();
  const expected = [
    "created_at",
    "object_hash",
    "operation_id",
    "owner_pid",
    "record_bytes",
    "record_hash",
    "schema_version",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    integrity();
  }
  const candidate = value as unknown as Partial<OperationClaim>;
  if (
    candidate.schema_version !== "skill-store-operation.v1" ||
    typeof candidate.operation_id !== "string" ||
    !UUID_PATTERN.test(candidate.operation_id) ||
    !Number.isSafeInteger(candidate.owner_pid) ||
    Number(candidate.owner_pid) <= 0 ||
    typeof candidate.created_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.created_at)) ||
    new Date(candidate.created_at).toISOString() !== candidate.created_at ||
    typeof candidate.object_hash !== "string" ||
    !HASH_PATTERN.test(candidate.object_hash) ||
    !Number.isSafeInteger(candidate.record_bytes) ||
    Number(candidate.record_bytes) < 1 ||
    Number(candidate.record_bytes) > SKILL_LIMITS.storedObjectBytes ||
    typeof candidate.record_hash !== "string" ||
    !HASH_PATTERN.test(candidate.record_hash)
  ) {
    integrity();
  }
  const claim = candidate as OperationClaim;
  if (canonicalJson(claim) !== Buffer.from(bytes).toString("utf8")) {
    integrity();
  }
  return claim;
}

function safeLiveness(
  probe: (pid: number) => SkillPrivateStoreProcessLiveness,
  pid: number,
): SkillPrivateStoreProcessLiveness {
  try {
    const value = probe(pid);
    return value === "alive" || value === "dead" || value === "unknown" ? value : "unknown";
  } catch {
    return "unknown";
  }
}

async function safeListener(
  probe: () => Promise<SkillPrivateStoreListenerState>,
): Promise<SkillPrivateStoreListenerState> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(probe),
      new Promise<"unknown">((resolve) => {
        timeout = setTimeout(resolve, LISTENER_PROBE_TIMEOUT_MS, "unknown");
        timeout.unref();
      }),
    ]);
    return value === "present" || value === "absent" || value === "unknown" ? value : "unknown";
  } catch {
    return "unknown";
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function scanObjectNames(objectsPath: string): readonly string[] {
  const opened = opendirSync(objectsPath);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > MAX_OBJECT_ENTRIES) limitExceeded();
    }
  } finally {
    opened.closeSync();
  }
  return names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

interface NamespaceEntrySnapshot {
  readonly name: string;
  readonly identity: CatalogNamespaceIdentity;
}

interface CatalogNamespaceIdentity extends FileIdentity {
  readonly mode: number;
  readonly links: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function namespaceSnapshot(
  objectsPath: string,
  isCurrentUser: CurrentUserCheck,
): readonly NamespaceEntrySnapshot[] {
  return scanObjectNames(objectsPath).map((name) => {
    const candidate = path.join(objectsPath, name);
    const metadata = lstatSync(candidate, { bigint: true });
    const operation = OPERATION_PATTERN.exec(name);
    const final = OBJECT_PATTERN.exec(name);
    if (operation === null && final === null) integrity();
    const links: 1 | 2 = metadata.nlink === 2n ? 2 : 1;
    if (operation?.[3] === "claim" && links !== 1) integrity();
    assertPrivateFile(metadata, candidate, isCurrentUser, links);
    const maximum =
      operation?.[3] === "claim" ? MAX_OPERATION_BYTES : SKILL_LIMITS.storedObjectBytes;
    if (metadata.size > BigInt(maximum)) limitExceeded();
    if (final !== null && metadata.size < 1n) integrity();
    return {
      name,
      identity: {
        ...identity(metadata),
        mode: Number(metadata.mode),
        links: metadata.nlink,
        size: metadata.size,
        mtimeNs: metadata.mtimeNs,
        ctimeNs: metadata.ctimeNs,
      },
    };
  });
}

function sameNamespace(
  left: readonly NamespaceEntrySnapshot[],
  right: readonly NamespaceEntrySnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        entry.name === other.name &&
        entry.identity.device === other.identity.device &&
        entry.identity.inode === other.identity.inode &&
        entry.identity.mode === other.identity.mode &&
        entry.identity.links === other.identity.links &&
        entry.identity.size === other.identity.size &&
        entry.identity.mtimeNs === other.identity.mtimeNs &&
        entry.identity.ctimeNs === other.identity.ctimeNs
      );
    })
  );
}

async function invokeExactNamespaceHook<T>(
  directories: readonly OpenedDirectory[],
  isCurrentUser: CurrentUserCheck,
  objectsPath: string,
  hook: () => T | Promise<T>,
): Promise<T> {
  revalidateDirectoryChain(directories, isCurrentUser);
  const before = namespaceSnapshot(objectsPath, isCurrentUser);
  const result = await hook();
  revalidateDirectoryChain(directories, isCurrentUser);
  const after = namespaceSnapshot(objectsPath, isCurrentUser);
  if (!sameNamespace(before, after)) integrity();
  return result;
}

export function createSkillPrivateStoreForTest(
  options: CreateSkillPrivateStoreForTestOptions,
): SkillPrivateStore {
  const { statePath } = options;
  const skillsPath = path.join(statePath, "skills");
  const objectsPath = path.join(skillsPath, "objects");
  const isCurrentUser = options.isCurrentUser ?? defaultCurrentUser;
  const isProcessAlive = options.isProcessAlive ?? defaultProcessLiveness;
  const hooks = options.operationHooks;

  const ensureRoots = async (): Promise<void> => {
    validateAbsolutePath(statePath);
    await ensureDirectory(statePath, statePath, isCurrentUser);
    await ensureDirectory(skillsPath, statePath, isCurrentUser);
    await ensureDirectory(objectsPath, statePath, isCurrentUser);
  };

  const readExactObject = async (
    hash: `sha256:${string}`,
    directories: readonly OpenedDirectory[],
  ): Promise<Uint8Array | null> => {
    const candidate = objectPath(objectsPath, hash);
    let handle: HeldDescriptor | undefined;
    try {
      let named: BigIntStats;
      try {
        named = lstatSync(candidate, { bigint: true });
      } catch (error) {
        if (isMissing(error)) return null;
        pathUnsafe();
      }
      const expectedIdentity = assertPrivateFile(named, candidate, isCurrentUser, 1);
      if (named.size < 1n || named.size > BigInt(SKILL_LIMITS.storedObjectBytes)) limitExceeded();
      handle = {
        fd: openSync(candidate, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW),
      };
      const held = fstatSync(handle.fd, { bigint: true });
      assertPrivateFile(held, candidate, isCurrentUser, 1, expectedIdentity);
      if (hooks?.afterObjectOpen !== undefined) {
        await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
          hooks.afterObjectOpen!(candidate),
        );
      }
      if (held.size !== named.size) integrity();
      const bytes = readHeldExact(handle, Number(held.size));
      if (hooks?.afterObjectRead !== undefined) {
        await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
          hooks.afterObjectRead!(candidate),
        );
      }
      fsyncSync(handle.fd);
      exactFile(candidate, handle, expectedIdentity, bytes, isCurrentUser, 1);
      await syncDirectory(directories, isCurrentUser);
      exactFile(candidate, handle, expectedIdentity, bytes, isCurrentUser, 1);
      return Buffer.from(bytes);
    } catch (error) {
      if (error instanceof RuntimeSkillError) throw error;
      integrity();
    } finally {
      if (handle !== undefined) closeSync(handle.fd);
    }
  };

  const recoverOperations = async (directories: readonly OpenedDirectory[]): Promise<void> => {
    revalidateDirectoryChain(directories, isCurrentUser);
    const names = scanObjectNames(objectsPath);
    const claims = new Map<string, string>();
    const stages = new Map<string, string>();
    for (const name of names) {
      const final = OBJECT_PATTERN.exec(name);
      if (final !== null) {
        const metadata = lstatSync(path.join(objectsPath, name), { bigint: true });
        assertPrivateFile(metadata, path.join(objectsPath, name), isCurrentUser, 1);
        if (metadata.size < 1n || metadata.size > BigInt(SKILL_LIMITS.storedObjectBytes)) {
          limitExceeded();
        }
        continue;
      }
      const operation = OPERATION_PATTERN.exec(name);
      if (
        operation?.[1] === undefined ||
        operation[2] === undefined ||
        operation[3] === undefined
      ) {
        integrity();
      }
      if (!UUID_PATTERN.test(operation[2])) integrity();
      const key = `${operation[1]}:${operation[2]}`;
      const destination = operation[3] === "claim" ? claims : stages;
      if (destination.has(key)) integrity();
      destination.set(key, name);
    }
    for (const key of stages.keys()) if (!claims.has(key)) integrity();
    for (const [key, claimName] of claims) {
      const [pidText, operationId] = key.split(":");
      const ownerPid = Number(pidText);
      if (!Number.isSafeInteger(ownerPid) || operationId === undefined) integrity();
      const claimPath = path.join(objectsPath, claimName);
      const openedClaim = openExactFile(claimPath, MAX_OPERATION_BYTES, isCurrentUser);
      let openedStage: OpenedFile | undefined;
      try {
        const claim = parseClaim(openedClaim.bytes);
        if (claim.owner_pid !== ownerPid || claim.operation_id !== operationId) integrity();
        const stageName = stages.get(key);
        if (stageName !== undefined) {
          openedStage = openRecoveryStage(
            path.join(objectsPath, stageName),
            SKILL_LIMITS.storedObjectBytes,
            isCurrentUser,
          );
          if (openedStage.bytes.byteLength > claim.record_bytes) integrity();
        }
        const liveness = safeLiveness(isProcessAlive, ownerPid);
        if (liveness !== "dead") integrity();
        const listener = await invokeExactNamespaceHook(
          directories,
          isCurrentUser,
          objectsPath,
          () => safeListener(options.hasServiceListener),
        );
        if (listener !== "absent") integrity();
        revalidateDirectoryChain(directories, isCurrentUser);
        if (hooks?.beforeRecovery !== undefined) {
          await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
            hooks.beforeRecovery!(claimPath),
          );
        }
        exactFile(
          claimPath,
          openedClaim.handle,
          openedClaim.identity,
          openedClaim.bytes,
          isCurrentUser,
          1,
        );
        const finalPath = objectPath(objectsPath, claim.object_hash);
        if (openedStage?.links === 2) {
          const published = lstatSync(finalPath, { bigint: true });
          assertPrivateFile(published, finalPath, isCurrentUser, 2, openedStage.identity);
          if (
            openedStage.bytes.byteLength !== claim.record_bytes ||
            rawHash(openedStage.bytes) !== claim.record_hash
          ) {
            integrity();
          }
        }
        if (openedStage !== undefined) {
          await cleanupOwnedEntry(
            path.join(objectsPath, stages.get(key)!),
            openedStage.identity,
            isCurrentUser,
            openedStage.links,
            "recovery-stage",
            directories,
            operationId,
            hooks,
          );
          closeSync(openedStage.handle.fd);
          openedStage = undefined;
        }
        const final = await readExactObject(claim.object_hash, directories);
        if (
          final !== null &&
          (final.byteLength !== claim.record_bytes || rawHash(final) !== claim.record_hash)
        ) {
          integrity();
        }
        await cleanupOwnedEntry(
          claimPath,
          openedClaim.identity,
          isCurrentUser,
          1,
          "recovery-claim",
          directories,
          operationId,
          hooks,
        );
      } finally {
        if (openedStage !== undefined) closeSync(openedStage.handle.fd);
        closeSync(openedClaim.handle.fd);
      }
    }
    revalidateDirectoryChain(directories, isCurrentUser);
  };

  const readObject = async (hash: `sha256:${string}`): Promise<Uint8Array | null> => {
    await ensureRoots();
    const directories = openDirectoryChain(objectsPath, statePath, isCurrentUser);
    const operationDirectory = directories.at(-1);
    if (operationDirectory === undefined) pathUnsafe();
    const releaseOperation = await acquireDirectoryOperation(operationDirectory.identity);
    try {
      await recoverOperations(directories);
      return await readExactObject(hash, directories);
    } finally {
      releaseOperation();
      closeDirectoryChain(directories);
    }
  };

  const publishObject = async (
    hash: `sha256:${string}`,
    bytes: Uint8Array,
  ): Promise<Uint8Array> => {
    objectPath(objectsPath, hash);
    if (bytes.byteLength < 1) integrity();
    if (bytes.byteLength > SKILL_LIMITS.storedObjectBytes) limitExceeded();
    const canonicalBytes = Buffer.from(bytes);
    await ensureRoots();
    const directories = openDirectoryChain(objectsPath, statePath, isCurrentUser);
    const operationDirectory = directories.at(-1);
    if (operationDirectory === undefined) pathUnsafe();
    const releaseOperation = await acquireDirectoryOperation(operationDirectory.identity);
    let claim: Readonly<{ fd: number }> | undefined;
    let claimIdentity: FileIdentity | undefined;
    let stage: HeldDescriptor | undefined;
    let stageIdentity: FileIdentity | undefined;
    let stageLinks: 1 | 2 = 1;
    let operationId = "";
    let claimPath = "";
    let stagePath = "";
    try {
      await recoverOperations(directories);
      const existing = await readExactObject(hash, directories);
      if (existing !== null) {
        if (!Buffer.from(existing).equals(canonicalBytes)) integrity();
        return existing;
      }

      operationId = options.randomId();
      if (!UUID_PATTERN.test(operationId)) integrity();
      const createdAt = options.now();
      if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) integrity();
      const operationBase = `.object-${process.pid}-${operationId}`;
      claimPath = path.join(objectsPath, `${operationBase}.claim`);
      stagePath = path.join(objectsPath, `${operationBase}.stage`);
      const claimDocument: OperationClaim = {
        schema_version: "skill-store-operation.v1",
        operation_id: operationId,
        owner_pid: process.pid,
        created_at: createdAt.toISOString(),
        object_hash: hash,
        record_bytes: canonicalBytes.byteLength,
        record_hash: rawHash(canonicalBytes),
      };
      const claimBytes = Buffer.from(canonicalJson(claimDocument as unknown as JsonValue), "utf8");
      revalidateDirectoryChain(directories, isCurrentUser);
      const claimDescriptor = openSync(
        claimPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      claim = { fd: claimDescriptor };
      fchmodSync(claimDescriptor, 0o600);
      claimIdentity = assertPrivateFile(
        fstatSync(claimDescriptor, { bigint: true }),
        claimPath,
        isCurrentUser,
        1,
      );
      let claimOffset = 0;
      while (claimOffset < claimBytes.byteLength) {
        const written = writeSync(
          claimDescriptor,
          claimBytes,
          claimOffset,
          claimBytes.byteLength - claimOffset,
          claimOffset,
        );
        if (written === 0) integrity();
        claimOffset += written;
      }
      fsyncSync(claimDescriptor);
      exactFile(claimPath, claim, claimIdentity, claimBytes, isCurrentUser, 1);
      revalidateDirectoryChain(directories, isCurrentUser);
      await syncDirectory(directories, isCurrentUser);

      const stageDescriptor = openSync(
        stagePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      stage = { fd: stageDescriptor };
      fchmodSync(stageDescriptor, 0o600);
      stageIdentity = assertPrivateFile(
        fstatSync(stageDescriptor, { bigint: true }),
        stagePath,
        isCurrentUser,
        1,
      );
      if (hooks?.beforeStageWrite !== undefined) {
        await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
          hooks.beforeStageWrite!(stagePath),
        );
      }
      writeAll(stage, canonicalBytes);
      if (hooks?.afterStageWrite !== undefined) {
        await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
          hooks.afterStageWrite!(stagePath),
        );
      }
      if (hooks?.beforeFileSync !== undefined) {
        await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
          hooks.beforeFileSync!(stagePath),
        );
      }
      fsyncSync(stage.fd);
      if (hooks?.afterFileSync !== undefined) {
        await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
          hooks.afterFileSync!(stagePath),
        );
      }
      exactFile(stagePath, stage, stageIdentity, canonicalBytes, isCurrentUser, 1);

      const finalPath = objectPath(objectsPath, hash);
      if (hooks?.beforeLinkPublication !== undefined) {
        await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
          hooks.beforeLinkPublication!(stagePath, finalPath),
        );
      }
      try {
        linkSync(stagePath, finalPath);
        stageLinks = 2;
      } catch (error) {
        if (!isExisting(error)) throw error;
        await cleanupOwnedEntry(
          stagePath,
          stageIdentity,
          isCurrentUser,
          1,
          "stage",
          directories,
          operationId,
          hooks,
        );
        stageIdentity = undefined;
        const collision = await readExactObject(hash, directories);
        if (collision === null || !Buffer.from(collision).equals(canonicalBytes)) integrity();
        await cleanupOwnedEntry(
          claimPath,
          claimIdentity,
          isCurrentUser,
          1,
          "claim",
          directories,
          operationId,
          hooks,
        );
        claimIdentity = undefined;
        return collision;
      }
      exactFile(stagePath, stage, stageIdentity, canonicalBytes, isCurrentUser, 2);
      if (hooks?.afterLinkPublication !== undefined) {
        await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
          hooks.afterLinkPublication!(stagePath, finalPath),
        );
      }
      await syncDirectory(
        directories,
        isCurrentUser,
        hooks?.beforeParentSync === undefined
          ? undefined
          : (directoryPath) =>
              invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
                hooks.beforeParentSync!(directoryPath),
              ),
        hooks?.afterParentSync === undefined
          ? undefined
          : (directoryPath) =>
              invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
                hooks.afterParentSync!(directoryPath),
              ),
      );
      exactFile(finalPath, stage, stageIdentity, canonicalBytes, isCurrentUser, 2);
      const publishedIdentity = stageIdentity;
      if (hooks?.beforeStageCleanup !== undefined) {
        await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
          hooks.beforeStageCleanup!(stagePath),
        );
      }
      await cleanupOwnedEntry(
        stagePath,
        stageIdentity,
        isCurrentUser,
        2,
        "stage",
        directories,
        operationId,
        hooks,
      );
      stageIdentity = undefined;
      stageLinks = 1;
      if (hooks?.afterStageCleanup !== undefined) {
        await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
          hooks.afterStageCleanup!(stagePath),
        );
      }
      exactFile(finalPath, stage, publishedIdentity, canonicalBytes, isCurrentUser, 1);
      await cleanupOwnedEntry(
        claimPath,
        claimIdentity,
        isCurrentUser,
        1,
        "claim",
        directories,
        operationId,
        hooks,
      );
      claimIdentity = undefined;
      return Buffer.from(canonicalBytes);
    } catch (error) {
      if (stageIdentity !== undefined && stagePath !== "" && operationId !== "") {
        try {
          await cleanupOwnedEntry(
            stagePath,
            stageIdentity,
            isCurrentUser,
            stageLinks,
            "stage",
            directories,
            operationId,
            hooks,
          );
          stageIdentity = undefined;
        } catch {
          // Preserve the primary safe failure and any identity replacement.
        }
      }
      if (claimIdentity !== undefined && claimPath !== "" && operationId !== "") {
        try {
          await cleanupOwnedEntry(
            claimPath,
            claimIdentity,
            isCurrentUser,
            1,
            "claim",
            directories,
            operationId,
            hooks,
          );
          claimIdentity = undefined;
        } catch {
          // Preserve the primary safe failure and any identity replacement.
        }
      }
      if (error instanceof RuntimeSkillError) throw error;
      integrity();
    } finally {
      if (stage !== undefined) {
        try {
          closeSync(stage.fd);
        } catch {
          // Preserve the operation result fixed before descriptor cleanup.
        }
      }
      if (claim !== undefined) {
        try {
          closeSync(claim.fd);
        } catch {
          // The operation result is already fixed before descriptor cleanup.
        }
      }
      releaseOperation();
      closeDirectoryChain(directories);
    }
  };

  return { ensureRoots, publishObject, readObject };
}

export function createSkillPrivateStore(
  options: CreateSkillPrivateStoreOptions,
): SkillPrivateStore {
  return createSkillPrivateStoreForTest(options);
}
