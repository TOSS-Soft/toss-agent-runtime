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
const TOMBSTONE_PATTERN =
  /^\.delete-(claim|stage|recovery-claim|recovery-stage)-([1-9][0-9]*)-([0-9a-f-]{36})-(claim|stage)-(0|[1-9][0-9]*)-([0-9a-f]{64})\.tombstone$/u;
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

interface TombstoneBinding {
  readonly kind: CleanupKind;
  readonly ownerPid: number;
  readonly operationId: string;
  readonly artifact: "claim" | "stage";
  readonly bytes: number;
  readonly hash: `sha256:${string}`;
}

interface ExactObject {
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
}

interface RecoveryArtifact {
  readonly path: string;
  readonly opened: OpenedFile;
  readonly tombstone: TombstoneBinding | null;
}

interface OpenedRecoveryFinal {
  readonly hash: `sha256:${string}`;
  readonly path: string;
  readonly opened: OpenedFile;
  transaction: OpenedRecoveryTransaction | null;
}

interface OpenedRecoveryTransaction {
  readonly key: string;
  readonly ownerPid: number;
  readonly operationId: string;
  readonly claimDocument: OperationClaim;
  readonly claim: RecoveryArtifact;
  stage: RecoveryArtifact | undefined;
  readonly finalPath: string;
  readonly final: OpenedFile | null;
  finalLinks: 1 | 2;
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
  readonly beforeCleanupRename?: (kind: CleanupKind, candidate: string) => Promise<void>;
  readonly afterCleanupRename?: (
    kind: CleanupKind,
    candidate: string,
    tombstone: string,
  ) => Promise<void>;
  readonly beforeCleanupParentSync?: (kind: CleanupKind, directoryPath: string) => Promise<void>;
  readonly afterCleanupParentSync?: (kind: CleanupKind, directoryPath: string) => Promise<void>;
  readonly beforeCleanupUnlink?: (kind: CleanupKind, tombstone: string) => Promise<void>;
  readonly afterCleanupUnlink?: (kind: CleanupKind, tombstone: string) => Promise<void>;
  readonly beforeCleanupFinalSync?: (kind: CleanupKind, directoryPath: string) => Promise<void>;
  readonly afterCleanupFinalSync?: (kind: CleanupKind, directoryPath: string) => Promise<void>;
  readonly beforeTombstoneRecovery?: (tombstonePath: string) => Promise<void>;
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
  readonly linkFile?: ((source: string, destination: string) => void) | undefined;
}

export interface SkillPrivateStore {
  ensureRoots(): Promise<void>;
  recover(): Promise<void>;
  publishObject(hash: `sha256:${string}`, bytes: Uint8Array): Promise<Uint8Array>;
  objectBytes(hash: `sha256:${string}`): Promise<number | null>;
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

function parseTombstoneName(name: string): TombstoneBinding | null {
  const match = TOMBSTONE_PATTERN.exec(name);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined ||
    match[5] === undefined ||
    match[6] === undefined
  ) {
    return null;
  }
  const kind = match[1] as CleanupKind;
  const ownerPid = Number(match[2]);
  const operationId = match[3];
  const artifact = match[4] as "claim" | "stage";
  const bytes = Number(match[5]);
  const expectedArtifact = kind.endsWith("claim") ? "claim" : "stage";
  const maximum = artifact === "claim" ? MAX_OPERATION_BYTES : SKILL_LIMITS.storedObjectBytes;
  if (
    !Number.isSafeInteger(ownerPid) ||
    ownerPid <= 0 ||
    !UUID_PATTERN.test(operationId) ||
    artifact !== expectedArtifact ||
    !Number.isSafeInteger(bytes) ||
    bytes < (artifact === "claim" ? 1 : 0) ||
    bytes > maximum
  ) {
    integrity();
  }
  return {
    kind,
    ownerPid,
    operationId,
    artifact,
    bytes,
    hash: `sha256:${match[6]}`,
  };
}

function tombstonePath(
  candidate: string,
  kind: CleanupKind,
  operationId: string,
  expectedBytes: Uint8Array,
): string {
  const operation = OPERATION_PATTERN.exec(path.basename(candidate));
  if (
    operation?.[1] === undefined ||
    operation[2] === undefined ||
    operation[3] === undefined ||
    operation[2] !== operationId ||
    !UUID_PATTERN.test(operationId)
  ) {
    integrity();
  }
  const artifact = operation[3] as "claim" | "stage";
  if ((kind.endsWith("claim") ? "claim" : "stage") !== artifact) integrity();
  return path.join(
    path.dirname(candidate),
    `.delete-${kind}-${operation[1]}-${operationId}-${artifact}-${expectedBytes.byteLength}-${rawHash(expectedBytes).slice("sha256:".length)}.tombstone`,
  );
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
  expectedHandle: HeldDescriptor,
  expectedIdentity: FileIdentity,
  expectedBytes: Uint8Array,
  isCurrentUser: CurrentUserCheck,
  links: 1 | 2,
  kind: CleanupKind,
  directories: readonly OpenedDirectory[],
  operationId: string,
  hooks: SkillPrivateStoreOperationHooks | undefined,
  validateParticipants?: () => void,
): Promise<void> {
  const objectsPath = path.dirname(candidate);
  const tombstone = tombstonePath(candidate, kind, operationId, expectedBytes);
  const exactHook = async (hook: () => void | Promise<void>): Promise<void> => {
    validateParticipants?.();
    await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, hook);
    validateParticipants?.();
  };
  try {
    if (hooks?.beforeCleanupRename !== undefined) {
      await exactHook(() => hooks.beforeCleanupRename!(kind, candidate));
    }
    validateParticipants?.();
    revalidateDirectoryChain(directories, isCurrentUser);
    requireMissing(tombstone);
    exactFile(candidate, expectedHandle, expectedIdentity, expectedBytes, isCurrentUser, links);
    hooks?.afterFinalSourceIdentityValidation?.(kind, candidate);

    // Node has no unlinkat/openat identity primitive. This accepted same-UID
    // interval is kept synchronous: validate, rename once, revalidate.
    renameSync(candidate, tombstone);
    hooks?.afterTombstoneRename?.(kind, candidate, tombstone);
    exactFile(tombstone, expectedHandle, expectedIdentity, expectedBytes, isCurrentUser, links);
    requireMissing(candidate);
    revalidateDirectoryChain(directories, isCurrentUser);
  } catch (error) {
    if (error instanceof RuntimeSkillError) throw error;
    pathUnsafe();
  }

  if (hooks?.afterCleanupRename !== undefined) {
    await exactHook(() => hooks.afterCleanupRename!(kind, candidate, tombstone));
  }
  await syncDirectory(
    directories,
    isCurrentUser,
    hooks?.beforeCleanupParentSync === undefined
      ? undefined
      : (directoryPath) => exactHook(() => hooks.beforeCleanupParentSync!(kind, directoryPath)),
    hooks?.afterCleanupParentSync === undefined
      ? undefined
      : (directoryPath) => exactHook(() => hooks.afterCleanupParentSync!(kind, directoryPath)),
  );

  exactFile(tombstone, expectedHandle, expectedIdentity, expectedBytes, isCurrentUser, links);
  validateParticipants?.();
  if (hooks?.beforeCleanupUnlink !== undefined) {
    await exactHook(() => hooks.beforeCleanupUnlink!(kind, tombstone));
  }
  try {
    revalidateDirectoryChain(directories, isCurrentUser);
    exactFile(tombstone, expectedHandle, expectedIdentity, expectedBytes, isCurrentUser, links);
    validateParticipants?.();
    unlinkSync(tombstone);
    requireMissing(tombstone);
    revalidateDirectoryChain(directories, isCurrentUser);
  } catch (error) {
    if (error instanceof RuntimeSkillError) throw error;
    pathUnsafe();
  }
  if (hooks?.afterCleanupUnlink !== undefined) {
    await exactHook(() => hooks.afterCleanupUnlink!(kind, tombstone));
  }
  await syncDirectory(
    directories,
    isCurrentUser,
    hooks?.beforeCleanupFinalSync === undefined && hooks?.beforeCleanupSync === undefined
      ? undefined
      : async (directoryPath) => {
          if (hooks?.beforeCleanupFinalSync !== undefined) {
            await exactHook(() => hooks.beforeCleanupFinalSync!(kind, directoryPath));
          }
          if (hooks?.beforeCleanupSync !== undefined) {
            await exactHook(() => hooks.beforeCleanupSync!(kind, directoryPath));
          }
        },
    hooks?.afterCleanupFinalSync === undefined && hooks?.afterCleanupSync === undefined
      ? undefined
      : async (directoryPath) => {
          if (hooks?.afterCleanupSync !== undefined) {
            await exactHook(() => hooks.afterCleanupSync!(kind, directoryPath));
          }
          if (hooks?.afterCleanupFinalSync !== undefined) {
            await exactHook(() => hooks.afterCleanupFinalSync!(kind, directoryPath));
          }
        },
  );
  validateParticipants?.();
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

function openRecoveryFinal(candidate: string, isCurrentUser: CurrentUserCheck): OpenedFile | null {
  try {
    lstatSync(candidate, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    pathUnsafe();
  }
  const opened = openRecoveryStage(candidate, SKILL_LIMITS.storedObjectBytes, isCurrentUser);
  if (opened.bytes.byteLength < 1) {
    closeSync(opened.handle.fd);
    integrity();
  }
  return opened;
}

function validateRecoveryArtifact(
  artifact: RecoveryArtifact,
  isCurrentUser: CurrentUserCheck,
): void {
  exactFile(
    artifact.path,
    artifact.opened.handle,
    artifact.opened.identity,
    artifact.opened.bytes,
    isCurrentUser,
    artifact.opened.links,
  );
  const binding = artifact.tombstone;
  if (
    binding !== null &&
    (artifact.opened.bytes.byteLength !== binding.bytes ||
      rawHash(artifact.opened.bytes) !== binding.hash)
  ) {
    integrity();
  }
}

function validateRecoveryTransaction(
  transaction: OpenedRecoveryTransaction,
  isCurrentUser: CurrentUserCheck,
): void {
  validateRecoveryArtifact(transaction.claim, isCurrentUser);
  const claim = parseClaim(transaction.claim.opened.bytes);
  if (
    claim.owner_pid !== transaction.ownerPid ||
    claim.operation_id !== transaction.operationId ||
    canonicalJson(claim) !== canonicalJson(transaction.claimDocument)
  ) {
    integrity();
  }
  const claimBinding = transaction.claim.tombstone;
  if (
    claimBinding !== null &&
    (claimBinding.artifact !== "claim" ||
      claimBinding.ownerPid !== transaction.ownerPid ||
      claimBinding.operationId !== transaction.operationId)
  ) {
    integrity();
  }

  const stage = transaction.stage;
  if (stage !== undefined) {
    validateRecoveryArtifact(stage, isCurrentUser);
    const stageBinding = stage.tombstone;
    if (
      stageBinding !== null &&
      (stageBinding.artifact !== "stage" ||
        stageBinding.ownerPid !== transaction.ownerPid ||
        stageBinding.operationId !== transaction.operationId)
    ) {
      integrity();
    }
    if (
      stage.opened.bytes.byteLength > claim.record_bytes ||
      (stage.opened.bytes.byteLength === claim.record_bytes &&
        rawHash(stage.opened.bytes) !== claim.record_hash)
    ) {
      integrity();
    }
  }

  const final = transaction.final;
  if (final === null) {
    requireMissing(transaction.finalPath);
    if (stage?.opened.links === 2) integrity();
    return;
  }
  exactFile(
    transaction.finalPath,
    final.handle,
    final.identity,
    final.bytes,
    isCurrentUser,
    transaction.finalLinks,
  );
  if (final.bytes.byteLength !== claim.record_bytes || rawHash(final.bytes) !== claim.record_hash) {
    integrity();
  }
  if (transaction.finalLinks === 2) {
    if (
      stage === undefined ||
      stage.opened.links !== 2 ||
      !identitiesMatch(stage.opened.identity, final.identity)
    ) {
      integrity();
    }
  } else if (stage?.opened.links === 2) {
    integrity();
  }
}

function validateRecoveryCleanupContext(
  transaction: OpenedRecoveryTransaction,
  cleanedArtifact: "claim" | "stage",
  isCurrentUser: CurrentUserCheck,
): void {
  if (cleanedArtifact === "stage") {
    validateRecoveryArtifact(transaction.claim, isCurrentUser);
  }
  const final = transaction.final;
  if (final === null) {
    requireMissing(transaction.finalPath);
    return;
  }
  const held = fstatSync(final.handle.fd, { bigint: true });
  const links: 1 | 2 = held.nlink === 2n ? 2 : 1;
  exactFile(transaction.finalPath, final.handle, final.identity, final.bytes, isCurrentUser, links);
  if (
    final.bytes.byteLength !== transaction.claimDocument.record_bytes ||
    rawHash(final.bytes) !== transaction.claimDocument.record_hash ||
    (cleanedArtifact === "claim" && links !== 1)
  ) {
    integrity();
  }
  transaction.finalLinks = links;
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
    const tombstone = parseTombstoneName(name);
    if (operation === null && final === null && tombstone === null) integrity();
    const links: 1 | 2 = metadata.nlink === 2n ? 2 : 1;
    if ((operation?.[3] === "claim" || tombstone?.artifact === "claim") && links !== 1) {
      integrity();
    }
    assertPrivateFile(metadata, candidate, isCurrentUser, links);
    const maximum =
      operation?.[3] === "claim" || tombstone?.artifact === "claim"
        ? MAX_OPERATION_BYTES
        : SKILL_LIMITS.storedObjectBytes;
    if (metadata.size > BigInt(maximum)) limitExceeded();
    if (tombstone !== null && metadata.size !== BigInt(tombstone.bytes)) integrity();
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
  let result: T | undefined;
  let hookError: unknown;
  try {
    result = await hook();
  } catch (error) {
    hookError = error;
  }
  revalidateDirectoryChain(directories, isCurrentUser);
  const after = namespaceSnapshot(objectsPath, isCurrentUser);
  if (!sameNamespace(before, after)) integrity();
  if (hookError !== undefined) {
    if (hookError instanceof Error) throw hookError;
    integrity();
  }
  return result as T;
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
  const linkFile = options.linkFile ?? linkSync;

  const ensureRoots = async (): Promise<void> => {
    validateAbsolutePath(statePath);
    await ensureDirectory(statePath, statePath, isCurrentUser);
    await ensureDirectory(skillsPath, statePath, isCurrentUser);
    await ensureDirectory(objectsPath, statePath, isCurrentUser);
  };

  const readExactObject = async (
    hash: `sha256:${string}`,
    directories: readonly OpenedDirectory[],
    expectedIdentity?: FileIdentity,
    requireCleanNamespace = false,
  ): Promise<ExactObject | null> => {
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
      const openedIdentity = assertPrivateFile(
        named,
        candidate,
        isCurrentUser,
        1,
        expectedIdentity,
      );
      if (named.size < 1n || named.size > BigInt(SKILL_LIMITS.storedObjectBytes)) limitExceeded();
      handle = {
        fd: openSync(candidate, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW),
      };
      const held = fstatSync(handle.fd, { bigint: true });
      assertPrivateFile(held, candidate, isCurrentUser, 1, openedIdentity);
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
      exactFile(candidate, handle, openedIdentity, bytes, isCurrentUser, 1);
      await syncDirectory(directories, isCurrentUser);
      exactFile(candidate, handle, openedIdentity, bytes, isCurrentUser, 1);
      if (requireCleanNamespace) {
        const namespace = namespaceSnapshot(objectsPath, isCurrentUser);
        if (namespace.some((entry) => OBJECT_PATTERN.exec(entry.name) === null)) integrity();
        revalidateDirectoryChain(directories, isCurrentUser);
        exactFile(candidate, handle, openedIdentity, bytes, isCurrentUser, 1);
      }
      return { bytes: Buffer.from(bytes), identity: openedIdentity };
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
    const claimTombstones = new Map<
      string,
      Readonly<{ name: string; binding: TombstoneBinding }>
    >();
    const stageTombstones = new Map<
      string,
      Readonly<{ name: string; binding: TombstoneBinding }>
    >();
    const finalNames = new Map<`sha256:${string}`, string>();
    for (const name of names) {
      const final = OBJECT_PATTERN.exec(name);
      if (final !== null) {
        const hash = final[1] as `sha256:${string}`;
        if (finalNames.has(hash)) integrity();
        finalNames.set(hash, name);
        continue;
      }
      const tombstone = parseTombstoneName(name);
      if (tombstone !== null) {
        const key = `${tombstone.ownerPid}:${tombstone.operationId}`;
        const destination = tombstone.artifact === "claim" ? claimTombstones : stageTombstones;
        if (destination.has(key)) integrity();
        destination.set(key, { name, binding: tombstone });
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

    const operationKeys = new Set([
      ...claims.keys(),
      ...stages.keys(),
      ...claimTombstones.keys(),
      ...stageTombstones.keys(),
    ]);
    const transactions: OpenedRecoveryTransaction[] = [];
    const heldDescriptors: number[] = [];
    const objectTransactions = new Map<string, string>();
    const openedFinals = new Map<`sha256:${string}`, OpenedRecoveryFinal>();
    try {
      const finalIdentities = new Map<string, string>();
      for (const [hash, name] of finalNames) {
        const finalPath = path.join(objectsPath, name);
        const opened = openRecoveryFinal(finalPath, isCurrentUser);
        if (opened === null) pathUnsafe();
        heldDescriptors.push(opened.handle.fd);
        const identityKey = `${opened.identity.device}:${opened.identity.inode}`;
        if (finalIdentities.has(identityKey)) pathUnsafe();
        finalIdentities.set(identityKey, finalPath);
        openedFinals.set(hash, { hash, path: finalPath, opened, transaction: null });
      }

      for (const key of operationKeys) {
        const regularClaimName = claims.get(key);
        const claimTombstone = claimTombstones.get(key);
        const regularStageName = stages.get(key);
        const stageTombstone = stageTombstones.get(key);
        if (
          (regularClaimName === undefined) === (claimTombstone === undefined) ||
          (regularStageName !== undefined && stageTombstone !== undefined) ||
          (claimTombstone !== undefined &&
            (regularStageName !== undefined || stageTombstone !== undefined)) ||
          (stageTombstone !== undefined && regularClaimName === undefined)
        ) {
          integrity();
        }
        const [pidText, operationId] = key.split(":");
        const ownerPid = Number(pidText);
        if (
          !Number.isSafeInteger(ownerPid) ||
          ownerPid <= 0 ||
          operationId === undefined ||
          !UUID_PATTERN.test(operationId)
        ) {
          integrity();
        }

        const claimPath = path.join(objectsPath, regularClaimName ?? claimTombstone!.name);
        const openedClaim = openExactFile(claimPath, MAX_OPERATION_BYTES, isCurrentUser);
        heldDescriptors.push(openedClaim.handle.fd);
        const claimDocument = parseClaim(openedClaim.bytes);
        const claimArtifact: RecoveryArtifact = {
          path: claimPath,
          opened: openedClaim,
          tombstone: claimTombstone?.binding ?? null,
        };

        let stageArtifact: RecoveryArtifact | undefined;
        const stageName = regularStageName ?? stageTombstone?.name;
        if (stageName !== undefined) {
          const stagePath = path.join(objectsPath, stageName);
          const openedStage = openRecoveryStage(
            stagePath,
            SKILL_LIMITS.storedObjectBytes,
            isCurrentUser,
          );
          heldDescriptors.push(openedStage.handle.fd);
          stageArtifact = {
            path: stagePath,
            opened: openedStage,
            tombstone: stageTombstone?.binding ?? null,
          };
        }

        const finalPath = objectPath(objectsPath, claimDocument.object_hash);
        const finalEntry = openedFinals.get(claimDocument.object_hash);
        const openedFinal = finalEntry?.opened ?? null;
        const priorTransaction = objectTransactions.get(claimDocument.object_hash);
        if (priorTransaction !== undefined && priorTransaction !== key) integrity();
        objectTransactions.set(claimDocument.object_hash, key);
        const transaction: OpenedRecoveryTransaction = {
          key,
          ownerPid,
          operationId,
          claimDocument,
          claim: claimArtifact,
          stage: stageArtifact,
          finalPath,
          final: openedFinal,
          finalLinks: openedFinal?.links ?? 1,
        };
        if (finalEntry !== undefined) {
          if (finalEntry.transaction !== null) integrity();
          finalEntry.transaction = transaction;
        }
        validateRecoveryTransaction(transaction, isCurrentUser);
        transactions.push(transaction);
      }

      for (const final of openedFinals.values()) {
        if (final.transaction === null && final.opened.links !== 1) pathUnsafe();
      }

      const validateFinalNamespace = (): void => {
        const currentFinals = scanObjectNames(objectsPath)
          .filter((name) => OBJECT_PATTERN.test(name))
          .map((name) => path.join(objectsPath, name));
        const expectedFinals = [...openedFinals.values()]
          .map((entry) => entry.path)
          .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
        if (
          currentFinals.length !== expectedFinals.length ||
          currentFinals.some((candidate, index) => candidate !== expectedFinals[index])
        ) {
          integrity();
        }
        const identities = new Set<string>();
        for (const final of openedFinals.values()) {
          if (final.path !== objectPath(objectsPath, final.hash)) integrity();
          const links = final.transaction?.finalLinks ?? 1;
          exactFile(
            final.path,
            final.opened.handle,
            final.opened.identity,
            final.opened.bytes,
            isCurrentUser,
            links,
          );
          const identityKey = `${final.opened.identity.device}:${final.opened.identity.inode}`;
          if (identities.has(identityKey)) pathUnsafe();
          identities.add(identityKey);
        }
      };

      const validateTransactions = (active: ReadonlySet<OpenedRecoveryTransaction>): void => {
        revalidateDirectoryChain(directories, isCurrentUser);
        validateFinalNamespace();
        for (const transaction of active) {
          validateRecoveryTransaction(transaction, isCurrentUser);
        }
      };
      const validateCleanupParticipants = (
        active: ReadonlySet<OpenedRecoveryTransaction>,
        transaction: OpenedRecoveryTransaction,
        artifact: "claim" | "stage",
      ): void => {
        revalidateDirectoryChain(directories, isCurrentUser);
        validateRecoveryCleanupContext(transaction, artifact, isCurrentUser);
        validateFinalNamespace();
        for (const other of active) {
          if (other !== transaction) validateRecoveryTransaction(other, isCurrentUser);
        }
      };
      const active = new Set(transactions);
      validateTransactions(active);
      const initialNamespace = namespaceSnapshot(objectsPath, isCurrentUser);
      for (const transaction of transactions) {
        if (safeLiveness(isProcessAlive, transaction.ownerPid) !== "dead") integrity();
        validateTransactions(active);
        const listener = await invokeExactNamespaceHook(
          directories,
          isCurrentUser,
          objectsPath,
          () => safeListener(options.hasServiceListener),
        );
        if (listener !== "absent") integrity();
        validateTransactions(active);
        if (!sameNamespace(initialNamespace, namespaceSnapshot(objectsPath, isCurrentUser))) {
          integrity();
        }
        if (hooks?.beforeRecovery !== undefined && transaction.claim.tombstone === null) {
          await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
            hooks.beforeRecovery!(transaction.claim.path),
          );
          validateTransactions(active);
        }
      }

      let expectedNamespace = namespaceSnapshot(objectsPath, isCurrentUser);
      const requireExpectedNamespace = (): void => {
        if (!sameNamespace(expectedNamespace, namespaceSnapshot(objectsPath, isCurrentUser))) {
          integrity();
        }
      };
      const cleanupTombstone = async (
        transaction: OpenedRecoveryTransaction,
        artifact: RecoveryArtifact,
      ): Promise<void> => {
        if (artifact.tombstone === null) integrity();
        requireExpectedNamespace();
        validateTransactions(active);
        if (hooks?.beforeTombstoneRecovery !== undefined) {
          await invokeExactNamespaceHook(directories, isCurrentUser, objectsPath, () =>
            hooks.beforeTombstoneRecovery!(artifact.path),
          );
          validateTransactions(active);
          requireExpectedNamespace();
        }
        validateTransactions(active);
        unlinkSync(artifact.path);
        requireMissing(artifact.path);
        revalidateDirectoryChain(directories, isCurrentUser);
        await syncDirectory(directories, isCurrentUser);
        requireMissing(artifact.path);
        expectedNamespace = namespaceSnapshot(objectsPath, isCurrentUser);
      };

      for (const transaction of transactions) {
        requireExpectedNamespace();
        validateTransactions(active);
        const stage = transaction.stage;
        if (stage !== undefined) {
          if (stage.tombstone === null) {
            await cleanupOwnedEntry(
              stage.path,
              stage.opened.handle,
              stage.opened.identity,
              stage.opened.bytes,
              isCurrentUser,
              stage.opened.links,
              "recovery-stage",
              directories,
              transaction.operationId,
              hooks,
              () => validateCleanupParticipants(active, transaction, "stage"),
            );
            expectedNamespace = namespaceSnapshot(objectsPath, isCurrentUser);
          } else {
            await cleanupTombstone(transaction, stage);
          }
          if (transaction.final !== null && transaction.finalLinks === 2) {
            transaction.finalLinks = 1;
          }
          transaction.stage = undefined;
          validateTransactions(active);
        }

        requireExpectedNamespace();
        validateRecoveryTransaction(transaction, isCurrentUser);
        if (transaction.claim.tombstone === null) {
          await cleanupOwnedEntry(
            transaction.claim.path,
            transaction.claim.opened.handle,
            transaction.claim.opened.identity,
            transaction.claim.opened.bytes,
            isCurrentUser,
            1,
            "recovery-claim",
            directories,
            transaction.operationId,
            hooks,
            () => validateCleanupParticipants(active, transaction, "claim"),
          );
          expectedNamespace = namespaceSnapshot(objectsPath, isCurrentUser);
        } else {
          await cleanupTombstone(transaction, transaction.claim);
        }
        active.delete(transaction);
        validateTransactions(active);
        if (transaction.final !== null) {
          exactFile(
            transaction.finalPath,
            transaction.final.handle,
            transaction.final.identity,
            transaction.final.bytes,
            isCurrentUser,
            1,
          );
        } else {
          requireMissing(transaction.finalPath);
        }
      }
    } finally {
      for (const descriptor of [...heldDescriptors].reverse()) closeSync(descriptor);
    }
    revalidateDirectoryChain(directories, isCurrentUser);
    for (const name of scanObjectNames(objectsPath)) {
      if (OBJECT_PATTERN.exec(name) === null) integrity();
      const candidate = path.join(objectsPath, name);
      const metadata = lstatSync(candidate, { bigint: true });
      assertPrivateFile(metadata, candidate, isCurrentUser, 1);
    }
  };

  const readObject = async (hash: `sha256:${string}`): Promise<Uint8Array | null> => {
    await ensureRoots();
    const directories = openDirectoryChain(objectsPath, statePath, isCurrentUser);
    const operationDirectory = directories.at(-1);
    if (operationDirectory === undefined) pathUnsafe();
    const releaseOperation = await acquireDirectoryOperation(operationDirectory.identity);
    try {
      await recoverOperations(directories);
      return (await readExactObject(hash, directories, undefined, true))?.bytes ?? null;
    } finally {
      releaseOperation();
      closeDirectoryChain(directories);
    }
  };

  const objectBytes = async (hash: `sha256:${string}`): Promise<number | null> => {
    await ensureRoots();
    const directories = openDirectoryChain(objectsPath, statePath, isCurrentUser);
    const operationDirectory = directories.at(-1);
    if (operationDirectory === undefined) pathUnsafe();
    const releaseOperation = await acquireDirectoryOperation(operationDirectory.identity);
    try {
      await recoverOperations(directories);
      const candidate = objectPath(objectsPath, hash);
      let before: BigIntStats;
      try {
        before = lstatSync(candidate, { bigint: true });
      } catch (error) {
        if (isMissing(error)) return null;
        pathUnsafe();
      }
      const identity = assertPrivateFile(before, candidate, isCurrentUser, 1);
      if (before.size < 1n || before.size > BigInt(SKILL_LIMITS.storedObjectBytes)) limitExceeded();
      await syncDirectory(directories, isCurrentUser);
      const after = lstatSync(candidate, { bigint: true });
      assertPrivateFile(after, candidate, isCurrentUser, 1, identity);
      if (after.size !== before.size) integrity();
      return Number(after.size);
    } finally {
      releaseOperation();
      closeDirectoryChain(directories);
    }
  };

  const recover = async (): Promise<void> => {
    await ensureRoots();
    const directories = openDirectoryChain(objectsPath, statePath, isCurrentUser);
    const operationDirectory = directories.at(-1);
    if (operationDirectory === undefined) pathUnsafe();
    const releaseOperation = await acquireDirectoryOperation(operationDirectory.identity);
    try {
      await recoverOperations(directories);
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
    let claimBytes: Uint8Array | undefined;
    let stage: HeldDescriptor | undefined;
    let stageIdentity: FileIdentity | undefined;
    let stageBytes: Uint8Array = Buffer.alloc(0);
    let stageLinks: 1 | 2 = 1;
    let operationId = "";
    let claimPath = "";
    let stagePath = "";
    try {
      await recoverOperations(directories);
      const existing = await readExactObject(hash, directories);
      if (existing !== null) {
        if (!Buffer.from(existing.bytes).equals(canonicalBytes)) integrity();
        const rebound = await readExactObject(hash, directories, existing.identity, true);
        if (rebound === null || !Buffer.from(rebound.bytes).equals(canonicalBytes)) integrity();
        return rebound.bytes;
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
      claimBytes = Buffer.from(canonicalJson(claimDocument as unknown as JsonValue), "utf8");
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
      stageBytes = canonicalBytes;
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
        linkFile(stagePath, finalPath);
        stageLinks = 2;
      } catch (error) {
        if (!isExisting(error)) throw error;
        await cleanupOwnedEntry(
          stagePath,
          stage,
          stageIdentity,
          canonicalBytes,
          isCurrentUser,
          1,
          "stage",
          directories,
          operationId,
          hooks,
        );
        stageIdentity = undefined;
        const collision = await readExactObject(hash, directories);
        if (collision === null || !Buffer.from(collision.bytes).equals(canonicalBytes)) integrity();
        await cleanupOwnedEntry(
          claimPath,
          claim,
          claimIdentity,
          claimBytes,
          isCurrentUser,
          1,
          "claim",
          directories,
          operationId,
          hooks,
        );
        claimIdentity = undefined;
        const rebound = await readExactObject(hash, directories, collision.identity, true);
        if (rebound === null || !Buffer.from(rebound.bytes).equals(canonicalBytes)) integrity();
        return rebound.bytes;
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
        stage,
        stageIdentity,
        canonicalBytes,
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
        claim,
        claimIdentity,
        claimBytes,
        isCurrentUser,
        1,
        "claim",
        directories,
        operationId,
        hooks,
      );
      claimIdentity = undefined;
      const rebound = await readExactObject(hash, directories, publishedIdentity, true);
      if (rebound === null || !Buffer.from(rebound.bytes).equals(canonicalBytes)) integrity();
      return rebound.bytes;
    } catch (error) {
      let stageCleanupComplete = stageIdentity === undefined;
      if (
        stage !== undefined &&
        stageIdentity !== undefined &&
        stagePath !== "" &&
        operationId !== ""
      ) {
        try {
          await cleanupOwnedEntry(
            stagePath,
            stage,
            stageIdentity,
            stageBytes,
            isCurrentUser,
            stageLinks,
            "stage",
            directories,
            operationId,
            hooks,
          );
          stageIdentity = undefined;
          stageCleanupComplete = true;
        } catch {
          stageCleanupComplete = false;
          // Preserve the primary safe failure and any identity replacement.
        }
      }
      if (
        stageCleanupComplete &&
        claim !== undefined &&
        claimIdentity !== undefined &&
        claimBytes !== undefined &&
        claimPath !== "" &&
        operationId !== ""
      ) {
        try {
          await cleanupOwnedEntry(
            claimPath,
            claim,
            claimIdentity,
            claimBytes,
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

  return { ensureRoots, recover, publishObject, objectBytes, readObject };
}

export function createSkillPrivateStore(
  options: CreateSkillPrivateStoreOptions,
): SkillPrivateStore {
  return createSkillPrivateStoreForTest(options);
}
