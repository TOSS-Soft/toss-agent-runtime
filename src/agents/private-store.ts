import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  fstatSync,
  lstatSync,
  readSync,
  renameSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import { chmod, link, lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { RuntimeAgentError } from "./errors.js";

export const MAX_PRIVATE_OBJECT_BYTES = 2 * 1024 * 1024;
const MAX_MUTATION_CLAIM_BYTES = 128;
const HASH_PATTERN = /^sha256:([0-9a-f]{64})$/u;
const STAGE_PATTERN = /^\.object-[1-9][0-9]*-[0-9a-f]{32}\.stage$/u;
const MUTATION_CLAIM_NAME = "mutation.claim";
const LISTENER_PROBE_TIMEOUT_MS = 250;

export type PrivateStoreProcessLiveness = "alive" | "dead" | "unknown";
export type PrivateStoreListenerState = "present" | "absent" | "unknown";
type CurrentUserCheck = (userId: bigint, candidate: string) => boolean;
type CleanupKind = "stage" | "claim" | "claim-recovery" | "claim-release";

export interface PrivateFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface PrivateObjectSnapshot {
  readonly bytes: Uint8Array;
  readonly identity: PrivateFileIdentity;
}

export interface PrivateMutationClaim {
  readonly ownerPid: number;
  release(): Promise<void>;
}

export interface PrivateAgentStoreOperationHooks {
  readonly beforeSnapshotAllocation?: () => void;
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
  readonly afterObjectMissing?: (objectPath: string) => Promise<void>;
  readonly afterLinkCollision?: (objectPath: string) => Promise<void>;
  readonly beforeClaimFileSync?: (claimPath: string) => Promise<void>;
  readonly beforeClaimRecovery?: (claimPath: string) => Promise<void>;
  readonly beforeCleanupSync?: (kind: CleanupKind, directoryPath: string) => Promise<void>;
  readonly afterCleanupSync?: (kind: CleanupKind, directoryPath: string) => Promise<void>;
  readonly afterFinalSourceIdentityValidation?: (kind: CleanupKind, candidatePath: string) => void;
  readonly afterTombstoneRename?: (
    kind: CleanupKind,
    candidatePath: string,
    tombstonePath: string,
  ) => void;
}

export interface CreatePrivateAgentStoreOptions {
  readonly statePath: string;
  readonly isProcessAlive?: (pid: number) => PrivateStoreProcessLiveness;
  readonly hasServiceListener: () => Promise<PrivateStoreListenerState>;
  readonly isCurrentUser?: CurrentUserCheck;
  readonly operationHooks?: PrivateAgentStoreOperationHooks;
}

export interface PrivateAgentStore {
  readonly statePath: string;
  readonly agentsPath: string;
  readonly objectsPath: string;
  readonly registryPath: string;
  readonly quarantinePath: string;
  readonly mutationClaimPath: string;
  ensureRoots(): Promise<void>;
  publishObject(hash: `sha256:${string}`, bytes: Uint8Array): Promise<PrivateObjectSnapshot>;
  readObject(hash: `sha256:${string}`): Promise<PrivateObjectSnapshot | null>;
  acquireMutationClaim(): Promise<PrivateMutationClaim>;
}

interface OpenedDirectory {
  readonly candidate: string;
  readonly exactPrivate: boolean;
  readonly handle: FileHandle;
  readonly identity: PrivateFileIdentity;
}

function pathUnsafe(): never {
  throw new RuntimeAgentError("RUNTIME_AGENT_PATH_UNSAFE");
}

function registryCorrupt(): never {
  throw new RuntimeAgentError("RUNTIME_AGENT_REGISTRY_CORRUPT");
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

function defaultCurrentUser(userId: bigint): boolean {
  return typeof process.getuid !== "function" || BigInt(process.getuid()) === userId;
}

function defaultProcessLiveness(pid: number): PrivateStoreProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (errorCode(error) === "ESRCH") return "dead";
    if (errorCode(error) === "EPERM") return "alive";
    return "unknown";
  }
}

function identity(metadata: Pick<BigIntStats, "dev" | "ino">): PrivateFileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function identitiesMatch(left: PrivateFileIdentity, right: PrivateFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function isAtOrBelow(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
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
  const segments = candidate.slice(parsed.root.length).split(path.sep);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
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

function assertPrivateDirectory(
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

async function ensurePrivateDirectory(
  candidate: string,
  privateRoot: string,
  isCurrentUser: CurrentUserCheck,
): Promise<void> {
  let reachedCurrentUser = false;
  for (const current of directoryCandidates(candidate)) {
    const exactPrivate = isAtOrBelow(current, privateRoot);
    let metadata: BigIntStats;
    let created = false;
    try {
      metadata = await lstat(current, { bigint: true });
    } catch (error) {
      if (!isMissing(error)) pathUnsafe();
      try {
        await mkdir(current, { mode: 0o700 });
        created = true;
      } catch (mkdirError) {
        if (!isExisting(mkdirError)) registryCorrupt();
      }
      if (created) {
        try {
          await chmod(current, 0o700);
        } catch {
          registryCorrupt();
        }
      }
      try {
        metadata = await lstat(current, { bigint: true });
      } catch {
        pathUnsafe();
      }
    }
    const nextReached = assertPrivateDirectory(
      metadata,
      current,
      isCurrentUser,
      exactPrivate,
      reachedCurrentUser,
    );
    reachedCurrentUser = nextReached || reachedCurrentUser;
  }
  const opened = await openDirectoryChain(candidate, privateRoot, isCurrentUser);
  try {
    await syncDirectoryChain(opened, isCurrentUser);
    const parent = opened.slice(0, -1);
    if (parent.length === 0) pathUnsafe();
    await syncDirectoryChain(parent, isCurrentUser);
    revalidateDirectoryChain(opened, isCurrentUser);
  } finally {
    await closeDirectoryChain(opened);
  }
}

async function openDirectoryChain(
  candidate: string,
  privateRoot: string,
  isCurrentUser: CurrentUserCheck,
): Promise<readonly OpenedDirectory[]> {
  const opened: OpenedDirectory[] = [];
  let reachedCurrentUser = false;
  try {
    for (const current of directoryCandidates(candidate)) {
      const exactPrivate = isAtOrBelow(current, privateRoot);
      const before = await lstat(current, { bigint: true });
      const nextReached = assertPrivateDirectory(
        before,
        current,
        isCurrentUser,
        exactPrivate,
        reachedCurrentUser,
      );
      const handle = await open(
        current,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      opened.push({ candidate: current, exactPrivate, handle, identity: identity(before) });
      const held = await handle.stat({ bigint: true });
      assertPrivateDirectory(held, current, isCurrentUser, exactPrivate, reachedCurrentUser);
      if (!identitiesMatch(identity(before), identity(held))) pathUnsafe();
      reachedCurrentUser = nextReached || reachedCurrentUser;
    }
    return opened;
  } catch (error) {
    await closeDirectoryChain(opened);
    if (error instanceof RuntimeAgentError) throw error;
    pathUnsafe();
  }
}

async function closeDirectoryChain(opened: readonly OpenedDirectory[]): Promise<void> {
  for (const directory of [...opened].reverse()) {
    await directory.handle.close().catch(() => undefined);
  }
}

function revalidateDirectoryChain(
  opened: readonly OpenedDirectory[],
  isCurrentUser: CurrentUserCheck,
): void {
  try {
    let reachedCurrentUser = false;
    for (const directory of opened) {
      const current = lstatSyncBigInt(directory.candidate);
      const held = fstatSyncBigInt(directory.handle);
      const nextReached = assertPrivateDirectory(
        current,
        directory.candidate,
        isCurrentUser,
        directory.exactPrivate,
        reachedCurrentUser,
      );
      assertPrivateDirectory(
        held,
        directory.candidate,
        isCurrentUser,
        directory.exactPrivate,
        reachedCurrentUser,
      );
      if (
        !identitiesMatch(directory.identity, identity(current)) ||
        !identitiesMatch(directory.identity, identity(held))
      ) {
        pathUnsafe();
      }
      reachedCurrentUser = nextReached || reachedCurrentUser;
    }
  } catch (error) {
    if (error instanceof RuntimeAgentError) throw error;
    pathUnsafe();
  }
}

function lstatSyncBigInt(candidate: string): BigIntStats {
  return lstatSync(candidate, { bigint: true });
}

function fstatSyncBigInt(handle: FileHandle): BigIntStats {
  return fstatSync(handle.fd, { bigint: true });
}

async function syncDirectoryChain(
  opened: readonly OpenedDirectory[],
  isCurrentUser: CurrentUserCheck,
  beforeSync?: (directoryPath: string) => Promise<void>,
  afterSync?: (directoryPath: string) => Promise<void>,
): Promise<void> {
  const directory = opened.at(-1);
  if (directory === undefined) pathUnsafe();
  revalidateDirectoryChain(opened, isCurrentUser);
  await beforeSync?.(directory.candidate);
  revalidateDirectoryChain(opened, isCurrentUser);
  await directory.handle.sync();
  await afterSync?.(directory.candidate);
  revalidateDirectoryChain(opened, isCurrentUser);
}

function assertPrivateFile(
  metadata: BigIntStats,
  candidate: string,
  isCurrentUser: CurrentUserCheck,
  mode: 0o600 | 0o700,
  links: 1 | 2,
  expected?: PrivateFileIdentity,
): PrivateFileIdentity {
  const actual = identity(metadata);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !isCurrentUser(metadata.uid, candidate) ||
    Number(metadata.mode & 0o7777n) !== mode ||
    metadata.nlink !== BigInt(links) ||
    (expected !== undefined && !identitiesMatch(actual, expected))
  ) {
    pathUnsafe();
  }
  return actual;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten === 0) registryCorrupt();
    offset += result.bytesWritten;
  }
}

async function readExactly(handle: FileHandle, size: number): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) registryCorrupt();
    offset += result.bytesRead;
  }
  return bytes;
}

function exactFile(
  candidate: string,
  handle: FileHandle,
  expectedIdentity: PrivateFileIdentity,
  expectedBytes: Uint8Array,
  isCurrentUser: CurrentUserCheck,
  mode: 0o600 | 0o700,
  links: 1 | 2,
): void {
  try {
    const pathMetadata = lstatSyncBigInt(candidate);
    const heldMetadata = fstatSyncBigInt(handle);
    assertPrivateFile(pathMetadata, candidate, isCurrentUser, mode, links, expectedIdentity);
    assertPrivateFile(heldMetadata, candidate, isCurrentUser, mode, links, expectedIdentity);
    if (
      pathMetadata.size !== BigInt(expectedBytes.byteLength) ||
      heldMetadata.size !== BigInt(expectedBytes.byteLength)
    ) {
      pathUnsafe();
    }
    const actual = Buffer.allocUnsafe(expectedBytes.byteLength);
    let offset = 0;
    while (offset < actual.byteLength) {
      const bytesRead = readSync(handle.fd, actual, offset, actual.byteLength - offset, offset);
      if (bytesRead === 0) pathUnsafe();
      offset += bytesRead;
    }
    if (!actual.equals(Buffer.from(expectedBytes))) pathUnsafe();
    const pathAfter = lstatSyncBigInt(candidate);
    const heldAfter = fstatSyncBigInt(handle);
    assertPrivateFile(pathAfter, candidate, isCurrentUser, mode, links, expectedIdentity);
    assertPrivateFile(heldAfter, candidate, isCurrentUser, mode, links, expectedIdentity);
    if (
      pathAfter.size !== BigInt(expectedBytes.byteLength) ||
      heldAfter.size !== BigInt(expectedBytes.byteLength)
    ) {
      pathUnsafe();
    }
  } catch (error) {
    if (error instanceof RuntimeAgentError) throw error;
    pathUnsafe();
  }
}

function assertHeldObjectHash(handle: FileHandle, size: number, expectedName: string): void {
  if (size > MAX_PRIVATE_OBJECT_BYTES) registryCorrupt();
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(handle.fd, bytes, offset, size - offset, offset);
    if (bytesRead === 0) registryCorrupt();
    offset += bytesRead;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== expectedName) registryCorrupt();
}

function requireMissingSync(candidate: string): void {
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
  expectedIdentity: PrivateFileIdentity,
  isCurrentUser: CurrentUserCheck,
  mode: 0o600 | 0o700,
  links: 1 | 2,
  kind: CleanupKind,
  directories: readonly OpenedDirectory[],
  hooks: PrivateAgentStoreOperationHooks | undefined,
): Promise<void> {
  const tombstone = path.join(
    path.dirname(candidate),
    `.delete-${kind}-${process.pid}-${randomBytes(16).toString("hex")}.tombstone`,
  );
  try {
    revalidateDirectoryChain(directories, isCurrentUser);
    requireMissingSync(tombstone);
    const source = lstatSync(candidate, { bigint: true });
    assertPrivateFile(source, candidate, isCurrentUser, mode, links, expectedIdentity);
    hooks?.afterFinalSourceIdentityValidation?.(kind, candidate);

    // Node has no conditional unlink-by-inode primitive. Keep the final
    // path-resolution interval synchronous: atomically move to an unpredictable
    // operation-owned name, then validate and delete that moved identity with
    // no injectable or await boundary between the final check and unlink.
    renameSync(candidate, tombstone);
    hooks?.afterTombstoneRename?.(kind, candidate, tombstone);
    const moved = lstatSync(tombstone, { bigint: true });
    assertPrivateFile(moved, tombstone, isCurrentUser, mode, links, expectedIdentity);
    requireMissingSync(candidate);
    const finalMoved = lstatSync(tombstone, { bigint: true });
    assertPrivateFile(finalMoved, tombstone, isCurrentUser, mode, links, expectedIdentity);
    unlinkSync(tombstone);
    requireMissingSync(tombstone);
    revalidateDirectoryChain(directories, isCurrentUser);
  } catch (error) {
    if (error instanceof RuntimeAgentError) throw error;
    pathUnsafe();
  }

  let syncError: unknown;
  try {
    await syncDirectoryChain(
      directories,
      isCurrentUser,
      hooks?.beforeCleanupSync === undefined
        ? undefined
        : (directoryPath) => hooks.beforeCleanupSync!(kind, directoryPath),
      hooks?.afterCleanupSync === undefined
        ? undefined
        : (directoryPath) => hooks.afterCleanupSync!(kind, directoryPath),
    );
  } catch (error) {
    syncError = error;
    try {
      await syncDirectoryChain(directories, isCurrentUser);
    } catch {
      // The caller receives the original fixed safe failure. Recovery will
      // revalidate the complete namespace before accepting another mutation.
    }
  }
  if (syncError instanceof Error) throw syncError;
  if (syncError !== undefined) registryCorrupt();
}

function hashName(hash: `sha256:${string}`): string {
  const match = HASH_PATTERN.exec(hash);
  if (match?.[1] === undefined) registryCorrupt();
  return match[1];
}

function validateObject(hash: `sha256:${string}`, bytes: Uint8Array): string {
  const name = hashName(hash);
  if (bytes.byteLength > MAX_PRIVATE_OBJECT_BYTES) registryCorrupt();
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== name) registryCorrupt();
  return name;
}

function safeProbeLiveness(
  probe: (pid: number) => PrivateStoreProcessLiveness,
  pid: number,
): PrivateStoreProcessLiveness {
  try {
    const result = probe(pid);
    return result === "alive" || result === "dead" || result === "unknown" ? result : "unknown";
  } catch {
    return "unknown";
  }
}

async function safeProbeListener(
  probe: () => Promise<PrivateStoreListenerState>,
): Promise<PrivateStoreListenerState> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(probe),
      new Promise<"unknown">((resolve) => {
        timeout = setTimeout(resolve, LISTENER_PROBE_TIMEOUT_MS, "unknown");
        timeout.unref();
      }),
    ]);
    return result === "present" || result === "absent" || result === "unknown" ? result : "unknown";
  } catch {
    return "unknown";
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function parseClaim(bytes: Uint8Array): number {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MUTATION_CLAIM_BYTES) registryCorrupt();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !("pid" in value) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      text !== JSON.stringify({ pid: value.pid })
    ) {
      registryCorrupt();
    }
    return Number(value.pid);
  } catch (error) {
    if (error instanceof RuntimeAgentError) throw error;
    registryCorrupt();
  }
}

export function createPrivateAgentStore(
  options: CreatePrivateAgentStoreOptions,
): PrivateAgentStore {
  const statePath = options.statePath;
  const agentsPath = path.join(statePath, "agents");
  const objectsPath = path.join(agentsPath, "objects");
  const registryPath = path.join(agentsPath, "registry");
  const quarantinePath = path.join(agentsPath, "quarantine");
  const mutationClaimPath = path.join(registryPath, MUTATION_CLAIM_NAME);
  const isCurrentUser = options.isCurrentUser ?? defaultCurrentUser;
  const isProcessAlive = options.isProcessAlive ?? defaultProcessLiveness;
  const hasServiceListener = options.hasServiceListener;

  const ensureRoots = async (): Promise<void> => {
    validateAbsolutePath(statePath);
    await ensurePrivateDirectory(statePath, statePath, isCurrentUser);
    await ensurePrivateDirectory(agentsPath, statePath, isCurrentUser);
    await ensurePrivateDirectory(objectsPath, statePath, isCurrentUser);
    await ensurePrivateDirectory(registryPath, statePath, isCurrentUser);
    await ensurePrivateDirectory(quarantinePath, statePath, isCurrentUser);
  };

  const readObject = async (hash: `sha256:${string}`): Promise<PrivateObjectSnapshot | null> => {
    const name = hashName(hash);
    await ensureRoots();
    const candidate = path.join(objectsPath, name);
    const directories = await openDirectoryChain(objectsPath, statePath, isCurrentUser);
    let handle: FileHandle | undefined;
    try {
      let before: BigIntStats;
      try {
        before = await lstat(candidate, { bigint: true });
      } catch (error) {
        if (isMissing(error)) {
          await options.operationHooks?.afterObjectMissing?.(candidate);
          revalidateDirectoryChain(directories, isCurrentUser);
          return null;
        }
        pathUnsafe();
      }
      const expectedIdentity = assertPrivateFile(before, candidate, isCurrentUser, 0o600, 1);
      handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const held = await handle.stat({ bigint: true });
      assertPrivateFile(held, candidate, isCurrentUser, 0o600, 1, expectedIdentity);
      await options.operationHooks?.afterObjectOpen?.(candidate);
      revalidateDirectoryChain(directories, isCurrentUser);
      if (
        before.size > BigInt(MAX_PRIVATE_OBJECT_BYTES) ||
        held.size > BigInt(MAX_PRIVATE_OBJECT_BYTES)
      ) {
        registryCorrupt();
      }
      const bytes = await readExactly(handle, Number(held.size));
      await options.operationHooks?.afterObjectRead?.(candidate);
      await handle.sync();
      exactFile(candidate, handle, expectedIdentity, bytes, isCurrentUser, 0o600, 1);
      await syncDirectoryChain(directories, isCurrentUser);
      exactFile(candidate, handle, expectedIdentity, bytes, isCurrentUser, 0o600, 1);
      if (createHash("sha256").update(bytes).digest("hex") !== name) registryCorrupt();
      return { bytes, identity: expectedIdentity };
    } catch (error) {
      if (error instanceof RuntimeAgentError) throw error;
      registryCorrupt();
    } finally {
      await handle?.close().catch(() => undefined);
      await closeDirectoryChain(directories);
    }
  };

  const publishObject = async (
    hash: `sha256:${string}`,
    bytes: Uint8Array,
  ): Promise<PrivateObjectSnapshot> => {
    if (bytes.byteLength > MAX_PRIVATE_OBJECT_BYTES) registryCorrupt();
    options.operationHooks?.beforeSnapshotAllocation?.();
    const canonicalBytes = Buffer.from(bytes);
    const name = validateObject(hash, canonicalBytes);
    await ensureRoots();
    const objectPath = path.join(objectsPath, name);
    const stagePath = path.join(
      objectsPath,
      `.object-${process.pid}-${randomBytes(16).toString("hex")}.stage`,
    );
    if (!STAGE_PATTERN.test(path.basename(stagePath))) registryCorrupt();
    const directories = await openDirectoryChain(objectsPath, statePath, isCurrentUser);
    let stage: FileHandle | undefined;
    let stageIdentity: PrivateFileIdentity | undefined;
    let stageLinks: 1 | 2 = 1;
    try {
      stage = await open(
        stagePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      await stage.chmod(0o600);
      const created = await stage.stat({ bigint: true });
      stageIdentity = assertPrivateFile(created, stagePath, isCurrentUser, 0o600, 1);
      await writeAll(stage, canonicalBytes);
      await options.operationHooks?.beforeFileSync?.(stagePath);
      await stage.sync();
      await options.operationHooks?.afterFileSync?.(stagePath);
      revalidateDirectoryChain(directories, isCurrentUser);
      exactFile(stagePath, stage, stageIdentity, canonicalBytes, isCurrentUser, 0o600, 1);

      await options.operationHooks?.beforeLinkPublication?.(stagePath, objectPath);
      try {
        await link(stagePath, objectPath);
        stageLinks = 2;
      } catch (error) {
        if (!isExisting(error)) throw error;
        await cleanupOwnedEntry(
          stagePath,
          stageIdentity,
          isCurrentUser,
          0o600,
          1,
          "stage",
          directories,
          options.operationHooks,
        );
        stageIdentity = undefined;
        await options.operationHooks?.afterStageCleanup?.(stagePath);
        await options.operationHooks?.afterLinkCollision?.(objectPath);
        revalidateDirectoryChain(directories, isCurrentUser);
        const existing = await readObject(hash);
        revalidateDirectoryChain(directories, isCurrentUser);
        if (existing === null || !Buffer.from(existing.bytes).equals(canonicalBytes)) {
          registryCorrupt();
        }
        return existing;
      }
      exactFile(stagePath, stage, stageIdentity, canonicalBytes, isCurrentUser, 0o600, 2);
      const publishedMetadata = await lstat(objectPath, { bigint: true });
      assertPrivateFile(publishedMetadata, objectPath, isCurrentUser, 0o600, 2, stageIdentity);
      await options.operationHooks?.afterLinkPublication?.(stagePath, objectPath);
      revalidateDirectoryChain(directories, isCurrentUser);
      await syncDirectoryChain(
        directories,
        isCurrentUser,
        options.operationHooks?.beforeParentSync,
        options.operationHooks?.afterParentSync,
      );
      exactFile(objectPath, stage, stageIdentity, canonicalBytes, isCurrentUser, 0o600, 2);
      await options.operationHooks?.beforeStageCleanup?.(stagePath);
      await cleanupOwnedEntry(
        stagePath,
        stageIdentity,
        isCurrentUser,
        0o600,
        2,
        "stage",
        directories,
        options.operationHooks,
      );
      stageIdentity = undefined;
      stageLinks = 1;
      await options.operationHooks?.afterStageCleanup?.(stagePath);
      exactFile(
        objectPath,
        stage,
        identity(publishedMetadata),
        canonicalBytes,
        isCurrentUser,
        0o600,
        1,
      );
      assertHeldObjectHash(stage, canonicalBytes.byteLength, name);
      return { bytes: Buffer.from(canonicalBytes), identity: identity(publishedMetadata) };
    } catch (error) {
      if (stageIdentity !== undefined) {
        try {
          revalidateDirectoryChain(directories, isCurrentUser);
          await cleanupOwnedEntry(
            stagePath,
            stageIdentity,
            isCurrentUser,
            0o600,
            stageLinks,
            "stage",
            directories,
            options.operationHooks,
          );
          stageIdentity = undefined;
        } catch {
          // Preserve the primary safe failure and never unlink an identity replacement.
        }
      }
      if (error instanceof RuntimeAgentError) throw error;
      registryCorrupt();
    } finally {
      await stage?.close().catch(() => undefined);
      await closeDirectoryChain(directories);
    }
  };

  const acquireMutationClaim = async (): Promise<PrivateMutationClaim> => {
    await ensureRoots();
    const claimBytes = Buffer.from(JSON.stringify({ pid: process.pid }), "utf8");
    const directories = await openDirectoryChain(registryPath, statePath, isCurrentUser);
    let directoriesTransferred = false;

    const createClaim = async (): Promise<PrivateMutationClaim> => {
      let claim: FileHandle;
      try {
        claim = await open(
          mutationClaimPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
          0o700,
        );
      } catch (error) {
        if (isExisting(error)) throw error;
        registryCorrupt();
      }
      let claimIdentity: PrivateFileIdentity | undefined;
      try {
        await claim.chmod(0o700);
        const created = await claim.stat({ bigint: true });
        claimIdentity = assertPrivateFile(created, mutationClaimPath, isCurrentUser, 0o700, 1);
        await writeAll(claim, claimBytes);
        await options.operationHooks?.beforeClaimFileSync?.(mutationClaimPath);
        await claim.sync();
        exactFile(mutationClaimPath, claim, claimIdentity, claimBytes, isCurrentUser, 0o700, 1);
        await syncDirectoryChain(directories, isCurrentUser);
        const heldIdentity = claimIdentity;
        let releasePromise: Promise<void> | undefined;
        return {
          ownerPid: process.pid,
          release(): Promise<void> {
            releasePromise ??= (async () => {
              try {
                exactFile(
                  mutationClaimPath,
                  claim,
                  heldIdentity,
                  claimBytes,
                  isCurrentUser,
                  0o700,
                  1,
                );
                await cleanupOwnedEntry(
                  mutationClaimPath,
                  heldIdentity,
                  isCurrentUser,
                  0o700,
                  1,
                  "claim-release",
                  directories,
                  options.operationHooks,
                );
              } catch (error) {
                if (error instanceof RuntimeAgentError) throw error;
                registryCorrupt();
              } finally {
                await claim.close().catch(() => undefined);
                await closeDirectoryChain(directories);
              }
            })();
            return releasePromise;
          },
        };
      } catch (error) {
        if (claimIdentity !== undefined) {
          try {
            await cleanupOwnedEntry(
              mutationClaimPath,
              claimIdentity,
              isCurrentUser,
              0o700,
              1,
              "claim",
              directories,
              options.operationHooks,
            );
          } catch {
            // Preserve the first safe failure.
          }
        }
        await claim.close().catch(() => undefined);
        if (error instanceof RuntimeAgentError) throw error;
        registryCorrupt();
      }
    };

    try {
      try {
        const claim = await createClaim();
        directoriesTransferred = true;
        return claim;
      } catch (error) {
        if (!isExisting(error)) throw error;
      }

      let existing: FileHandle | undefined;
      try {
        const before = await lstat(mutationClaimPath, { bigint: true });
        const expectedIdentity = assertPrivateFile(
          before,
          mutationClaimPath,
          isCurrentUser,
          0o700,
          1,
        );
        if (before.size > BigInt(MAX_MUTATION_CLAIM_BYTES)) registryCorrupt();
        existing = await open(mutationClaimPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const held = await existing.stat({ bigint: true });
        assertPrivateFile(held, mutationClaimPath, isCurrentUser, 0o700, 1, expectedIdentity);
        if (held.size > BigInt(MAX_MUTATION_CLAIM_BYTES)) registryCorrupt();
        const bytes = await readExactly(existing, Number(held.size));
        await existing.sync();
        exactFile(mutationClaimPath, existing, expectedIdentity, bytes, isCurrentUser, 0o700, 1);
        const ownerPid = parseClaim(bytes);
        if (safeProbeLiveness(isProcessAlive, ownerPid) !== "dead") registryCorrupt();
        if ((await safeProbeListener(hasServiceListener)) !== "absent") registryCorrupt();
        await options.operationHooks?.beforeClaimRecovery?.(mutationClaimPath);
        revalidateDirectoryChain(directories, isCurrentUser);
        exactFile(mutationClaimPath, existing, expectedIdentity, bytes, isCurrentUser, 0o700, 1);
        await cleanupOwnedEntry(
          mutationClaimPath,
          expectedIdentity,
          isCurrentUser,
          0o700,
          1,
          "claim-recovery",
          directories,
          options.operationHooks,
        );
      } catch (error) {
        if (error instanceof RuntimeAgentError) throw error;
        registryCorrupt();
      } finally {
        await existing?.close().catch(() => undefined);
      }

      try {
        const claim = await createClaim();
        directoriesTransferred = true;
        return claim;
      } catch {
        registryCorrupt();
      }
    } finally {
      if (!directoriesTransferred) await closeDirectoryChain(directories);
    }
  };

  return {
    statePath,
    agentsPath,
    objectsPath,
    registryPath,
    quarantinePath,
    mutationClaimPath,
    ensureRoots,
    publishObject,
    readObject,
    acquireMutationClaim,
  };
}
