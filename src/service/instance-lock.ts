import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../protocol/json.js";
import { MAX_CONTROL_MESSAGE_BYTES, parseServiceLock, type ServiceLockV1 } from "./contracts.js";
import { RuntimeServiceError } from "./errors.js";

export type ProcessLiveness = "alive" | "dead" | "unknown";

export interface ProcessProbe {
  liveness(pid: number): ProcessLiveness;
}

export interface SocketIdentityProbe {
  identify(socketPath: string): Promise<string | null>;
}

export interface InstanceLock {
  readonly owner: ServiceLockV1;
  release(): Promise<void>;
}

export interface InstanceLockOperationHooks {
  readonly beforeOwnerClaimRename?: (operation: "reclaim" | "release") => Promise<void>;
  readonly afterOwnerlessSentinelCreate?: () => Promise<void>;
}

type CurrentUserCheck = (userId: number, candidate?: string) => boolean;

export interface AcquireInstanceLockOptions {
  readonly lockPath: string;
  readonly socketPath: string;
  readonly pid: number;
  readonly now: () => Date;
  readonly createServiceInstanceId: () => string;
  readonly executableHash: string;
  readonly processProbe: ProcessProbe;
  readonly socketProbe: SocketIdentityProbe;
  readonly isCurrentUser?: CurrentUserCheck;
  readonly operationHooks?: InstanceLockOperationHooks;
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface OpenedDirectory {
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
  readonly modifiedAtMs: number;
}

interface OpenedOwner {
  readonly owner: ServiceLockV1;
  readonly identity: FileIdentity;
}

interface AcquiredIdentity {
  readonly directory: FileIdentity;
  readonly owner: FileIdentity;
}

const OWNER_FILE_NAME = "owner.json";
const OWNERLESS_STALE_AFTER_MS = 30_000;
const internalServiceErrors = new WeakSet<RuntimeServiceError>();

function ownerClaimName(serviceInstanceId: string): string {
  return `.owner-claim.${serviceInstanceId}.json`;
}

function ownerlessSentinelName(serviceInstanceId: string): string {
  return `.ownerless-reclaim.${serviceInstanceId}`;
}

function servicePathUnsafe(): never {
  const error = new RuntimeServiceError("RUNTIME_SERVICE_PATH_UNSAFE");
  internalServiceErrors.add(error);
  throw error;
}

function lockAmbiguous(): never {
  const error = new RuntimeServiceError("RUNTIME_SERVICE_LOCK_AMBIGUOUS");
  internalServiceErrors.add(error);
  throw error;
}

function alreadyRunning(): never {
  const error = new RuntimeServiceError("RUNTIME_SERVICE_ALREADY_RUNNING");
  internalServiceErrors.add(error);
  throw error;
}

function isInternalServiceError(error: unknown): error is RuntimeServiceError {
  return error instanceof RuntimeServiceError && internalServiceErrors.has(error);
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

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function identityOf(metadata: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function defaultCurrentUserCheck(userId: number): boolean {
  return typeof process.getuid !== "function" || process.getuid() === userId;
}

function currentUserOwns(
  isCurrentUser: CurrentUserCheck,
  userId: number,
  candidate: string,
): boolean {
  try {
    return isCurrentUser(userId, candidate);
  } catch {
    servicePathUnsafe();
  }
}

function createOwnerDocument(
  options: AcquireInstanceLockOptions,
  createdAt: string,
): Readonly<{ owner: ServiceLockV1; bytes: Uint8Array }> {
  try {
    const candidate = {
      schema_version: "service-lock.v1",
      document_type: "service-lock",
      service_instance_id: options.createServiceInstanceId(),
      pid: options.pid,
      executable_hash: options.executableHash,
      created_at: createdAt,
    } as const;
    const bytes = Buffer.from(canonicalJson(candidate), "utf8");
    const validated = parseServiceLock(bytes);
    if (!validated.ok || bytes.byteLength > MAX_CONTROL_MESSAGE_BYTES) lockAmbiguous();
    return { owner: validated.value, bytes };
  } catch {
    lockAmbiguous();
  }
}

function assertAbsolutePath(candidate: string): void {
  if (
    !path.isAbsolute(candidate) ||
    candidate === path.parse(candidate).root ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    servicePathUnsafe();
  }
}

async function assertPrivateRuntimePath(
  runtimePath: string,
  isCurrentUser: CurrentUserCheck,
): Promise<FileIdentity> {
  assertAbsolutePath(runtimePath);
  const parsed = path.parse(runtimePath);
  const relative = runtimePath.slice(parsed.root.length);
  const segments = relative.length === 0 ? [] : relative.split(path.sep);
  let current = parsed.root;
  let reachedCurrentUserDirectory = false;
  let finalIdentity: FileIdentity | undefined;

  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0 || segment === "." || segment === "..") servicePathUnsafe();
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      servicePathUnsafe();
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) servicePathUnsafe();

    const ownedByCurrentUser = currentUserOwns(isCurrentUser, metadata.uid, current);
    const trustedSystemAncestor = metadata.uid === 0 && !reachedCurrentUserDirectory;
    if (!trustedSystemAncestor) {
      if (!ownedByCurrentUser || (metadata.mode & 0o022) !== 0) servicePathUnsafe();
      reachedCurrentUserDirectory = true;
    }
    if (index === segments.length - 1) {
      if (!ownedByCurrentUser || (metadata.mode & 0o777) !== 0o700) servicePathUnsafe();
      finalIdentity = identityOf(metadata);
    }
  }

  if (finalIdentity === undefined) servicePathUnsafe();
  return finalIdentity;
}

async function assertCurrentIdentity(
  candidate: string,
  expected: FileIdentity,
  kind: "directory" | "file",
  mode: 0o700 | 0o600,
  isCurrentUser: CurrentUserCheck,
  identityMismatchIsAmbiguous = false,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch {
    servicePathUnsafe();
  }
  if (
    metadata.isSymbolicLink() ||
    (kind === "directory" ? !metadata.isDirectory() : !metadata.isFile()) ||
    !currentUserOwns(isCurrentUser, metadata.uid, candidate) ||
    (metadata.mode & 0o777) !== mode
  ) {
    servicePathUnsafe();
  }
  if (!sameIdentity(identityOf(metadata), expected)) {
    if (identityMismatchIsAmbiguous) lockAmbiguous();
    servicePathUnsafe();
  }
}

async function openPrivateDirectory(
  directoryPath: string,
  isCurrentUser: CurrentUserCheck,
  missingIsAllowed = false,
): Promise<OpenedDirectory | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (missingIsAllowed && isMissing(error)) return undefined;
    servicePathUnsafe();
  }

  try {
    const metadata = await handle.stat();
    const identity = identityOf(metadata);
    if (
      !metadata.isDirectory() ||
      !currentUserOwns(isCurrentUser, metadata.uid, directoryPath) ||
      (metadata.mode & 0o777) !== 0o700
    ) {
      servicePathUnsafe();
    }
    await assertCurrentIdentity(directoryPath, identity, "directory", 0o700, isCurrentUser);
    return { handle, identity, modifiedAtMs: metadata.mtimeMs };
  } catch (error) {
    await handle.close();
    if (isInternalServiceError(error)) throw error;
    servicePathUnsafe();
  }
}

async function readBounded(handle: FileHandle): Promise<Uint8Array> {
  const buffer = Buffer.alloc(MAX_CONTROL_MESSAGE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > MAX_CONTROL_MESSAGE_BYTES) lockAmbiguous();
  return buffer.subarray(0, offset);
}

async function readPrivateOwner(
  ownerPath: string,
  isCurrentUser: CurrentUserCheck,
): Promise<OpenedOwner | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return undefined;
    servicePathUnsafe();
  }

  try {
    const metadata = await handle.stat();
    const identity = identityOf(metadata);
    if (
      !metadata.isFile() ||
      !currentUserOwns(isCurrentUser, metadata.uid, ownerPath) ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      servicePathUnsafe();
    }
    if (metadata.size > MAX_CONTROL_MESSAGE_BYTES) lockAmbiguous();
    const bytes = await readBounded(handle);
    await assertCurrentIdentity(ownerPath, identity, "file", 0o600, isCurrentUser, true);
    const parsed = parseServiceLock(bytes);
    if (!parsed.ok) lockAmbiguous();
    const canonicalBytes = Buffer.from(canonicalJson(parsed.value), "utf8");
    if (!Buffer.from(bytes).equals(canonicalBytes)) lockAmbiguous();
    return { owner: parsed.value, identity };
  } catch (error) {
    if (isInternalServiceError(error)) throw error;
    lockAmbiguous();
  } finally {
    await handle.close();
  }
}

async function exactEntries(directoryPath: string, expected: readonly string[]): Promise<void> {
  let entries: string[];
  try {
    entries = (await readdir(directoryPath)).sort();
  } catch {
    lockAmbiguous();
  }
  if (
    entries.length !== expected.length ||
    entries.some((entry, index) => entry !== expected[index])
  ) {
    lockAmbiguous();
  }
}

async function identifySocket(
  probe: () => SocketIdentityProbe,
  socketPath: string,
): Promise<string | null> {
  try {
    return await probe().identify(socketPath);
  } catch {
    lockAmbiguous();
  }
}

function processLiveness(probe: () => ProcessProbe, pid: number): ProcessLiveness {
  try {
    const liveness = probe().liveness(pid);
    if (liveness !== "alive" && liveness !== "dead" && liveness !== "unknown") {
      lockAmbiguous();
    }
    return liveness;
  } catch {
    lockAmbiguous();
  }
}

async function runOperationHook(hook: (() => Promise<void>) | undefined): Promise<void> {
  try {
    await hook?.();
  } catch {
    lockAmbiguous();
  }
}

function readOperationHooks(
  options: AcquireInstanceLockOptions,
): InstanceLockOperationHooks | undefined {
  try {
    return options.operationHooks;
  } catch {
    lockAmbiguous();
  }
}

async function assertRemovalContext(options: {
  readonly lockPath: string;
  readonly directory: OpenedDirectory;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
}): Promise<void> {
  const { directory, isCurrentUser, lockPath, runtimeIdentity } = options;
  await assertCurrentIdentity(
    lockPath,
    directory.identity,
    "directory",
    0o700,
    isCurrentUser,
    true,
  );
  await assertCurrentIdentity(
    path.dirname(lockPath),
    runtimeIdentity,
    "directory",
    0o700,
    isCurrentUser,
    true,
  );
}

function sameOwner(actual: OpenedOwner, expected: OpenedOwner): boolean {
  return (
    sameIdentity(actual.identity, expected.identity) &&
    canonicalJson(actual.owner) === canonicalJson(expected.owner)
  );
}

function assertSameOwner(actual: OpenedOwner, expected: OpenedOwner): void {
  if (!sameOwner(actual, expected)) lockAmbiguous();
}

async function claimOwnerForRemoval(options: {
  readonly operation: "reclaim" | "release";
  readonly lockPath: string;
  readonly ownerPath: string;
  readonly claimPath: string;
  readonly directory: OpenedDirectory;
  readonly owner: OpenedOwner;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
  readonly hooks?: InstanceLockOperationHooks;
}): Promise<OpenedOwner> {
  const {
    claimPath,
    directory,
    hooks,
    isCurrentUser,
    lockPath,
    operation,
    owner,
    ownerPath,
    runtimeIdentity,
  } = options;
  await exactEntries(lockPath, [OWNER_FILE_NAME]);
  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });
  const hook = hooks?.beforeOwnerClaimRename;
  await runOperationHook(hook === undefined ? undefined : () => hook(operation));
  try {
    await rename(ownerPath, claimPath);
  } catch {
    lockAmbiguous();
  }

  const claimed = await readPrivateOwner(claimPath, isCurrentUser);
  if (claimed === undefined) lockAmbiguous();
  assertSameOwner(claimed, owner);
  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });
  await exactEntries(lockPath, [path.basename(claimPath)]);
  return claimed;
}

async function removeClaimedLock(options: {
  readonly lockPath: string;
  readonly claimPath: string;
  readonly directory: OpenedDirectory;
  readonly claimedOwner: OpenedOwner;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
}): Promise<void> {
  const { claimPath, claimedOwner, directory, isCurrentUser, lockPath, runtimeIdentity } = options;
  const revalidated = await readPrivateOwner(claimPath, isCurrentUser);
  if (revalidated === undefined) lockAmbiguous();
  assertSameOwner(revalidated, claimedOwner);
  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });
  await exactEntries(lockPath, [path.basename(claimPath)]);
  try {
    await unlink(claimPath);
  } catch {
    lockAmbiguous();
  }
  try {
    await rmdir(lockPath);
  } catch {
    lockAmbiguous();
  }
}

async function createOwnerlessSentinel(options: {
  readonly sentinelPath: string;
  readonly isCurrentUser: CurrentUserCheck;
}): Promise<FileIdentity> {
  const { isCurrentUser, sentinelPath } = options;
  let handle: FileHandle;
  try {
    handle = await open(
      sentinelPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    lockAmbiguous();
  }

  try {
    const metadata = await handle.stat();
    const identity = identityOf(metadata);
    if (
      !metadata.isFile() ||
      !currentUserOwns(isCurrentUser, metadata.uid, sentinelPath) ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      servicePathUnsafe();
    }
    await handle.sync();
    await assertCurrentIdentity(sentinelPath, identity, "file", 0o600, isCurrentUser, true);
    return identity;
  } finally {
    await handle.close();
  }
}

function assertOwnerlessStale(directory: OpenedDirectory, nowMs: number): void {
  if (
    !Number.isFinite(directory.modifiedAtMs) ||
    nowMs - directory.modifiedAtMs < OWNERLESS_STALE_AFTER_MS
  ) {
    lockAmbiguous();
  }
}

async function reclaimOwnerlessLock(options: {
  readonly acquire: AcquireInstanceLockOptions;
  readonly directory: OpenedDirectory;
  readonly nowMs: number;
  readonly claimServiceInstanceId: string;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
  readonly hooks?: InstanceLockOperationHooks;
}): Promise<void> {
  const {
    acquire,
    claimServiceInstanceId,
    directory,
    hooks,
    isCurrentUser,
    nowMs,
    runtimeIdentity,
  } = options;
  await exactEntries(acquire.lockPath, []);
  assertOwnerlessStale(directory, nowMs);
  await assertRemovalContext({
    lockPath: acquire.lockPath,
    directory,
    isCurrentUser,
    runtimeIdentity,
  });

  const sentinelPath = path.join(acquire.lockPath, ownerlessSentinelName(claimServiceInstanceId));
  const sentinelIdentity = await createOwnerlessSentinel({ sentinelPath, isCurrentUser });
  await runOperationHook(hooks?.afterOwnerlessSentinelCreate);
  assertOwnerlessStale(directory, nowMs);
  await assertRemovalContext({
    lockPath: acquire.lockPath,
    directory,
    isCurrentUser,
    runtimeIdentity,
  });
  await assertCurrentIdentity(sentinelPath, sentinelIdentity, "file", 0o600, isCurrentUser, true);
  await exactEntries(acquire.lockPath, [path.basename(sentinelPath)]);
  if ((await identifySocket(() => acquire.socketProbe, acquire.socketPath)) !== null) {
    lockAmbiguous();
  }

  await assertRemovalContext({
    lockPath: acquire.lockPath,
    directory,
    isCurrentUser,
    runtimeIdentity,
  });
  await assertCurrentIdentity(sentinelPath, sentinelIdentity, "file", 0o600, isCurrentUser, true);
  await exactEntries(acquire.lockPath, [path.basename(sentinelPath)]);
  try {
    await unlink(sentinelPath);
  } catch {
    lockAmbiguous();
  }
  try {
    await rmdir(acquire.lockPath);
  } catch {
    lockAmbiguous();
  }
}

async function inspectAndReclaim(options: {
  readonly acquire: AcquireInstanceLockOptions;
  readonly ownerPath: string;
  readonly nowMs: number;
  readonly claimServiceInstanceId: string;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
  readonly hooks?: InstanceLockOperationHooks;
}): Promise<void> {
  const {
    acquire,
    claimServiceInstanceId,
    hooks,
    isCurrentUser,
    nowMs,
    ownerPath,
    runtimeIdentity,
  } = options;
  const directory = await openPrivateDirectory(acquire.lockPath, isCurrentUser);
  if (directory === undefined) lockAmbiguous();
  try {
    const owner = await readPrivateOwner(ownerPath, isCurrentUser);
    if (owner === undefined) {
      await reclaimOwnerlessLock({
        acquire,
        directory,
        nowMs,
        claimServiceInstanceId,
        isCurrentUser,
        runtimeIdentity,
        ...(hooks === undefined ? {} : { hooks }),
      });
      return;
    }

    await exactEntries(acquire.lockPath, [OWNER_FILE_NAME]);
    const liveness = processLiveness(() => acquire.processProbe, owner.owner.pid);
    if (liveness === "unknown") lockAmbiguous();
    if (liveness === "alive") {
      if (owner.owner.executable_hash === acquire.executableHash) alreadyRunning();
      lockAmbiguous();
    }

    const socketIdentity = await identifySocket(() => acquire.socketProbe, acquire.socketPath);
    if (socketIdentity === owner.owner.service_instance_id) alreadyRunning();
    if (socketIdentity !== null) lockAmbiguous();
    const claimPath = path.join(acquire.lockPath, ownerClaimName(claimServiceInstanceId));
    const claimedOwner = await claimOwnerForRemoval({
      operation: "reclaim",
      lockPath: acquire.lockPath,
      ownerPath,
      claimPath,
      directory,
      owner,
      isCurrentUser,
      runtimeIdentity,
      ...(hooks === undefined ? {} : { hooks }),
    });
    await removeClaimedLock({
      lockPath: acquire.lockPath,
      claimPath,
      directory,
      claimedOwner,
      isCurrentUser,
      runtimeIdentity,
    });
  } finally {
    await directory.handle.close();
  }
}

async function createClaim(options: {
  readonly acquire: AcquireInstanceLockOptions;
  readonly ownerBytes: Uint8Array;
  readonly ownerPath: string;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
}): Promise<AcquiredIdentity | "existing"> {
  const { acquire, isCurrentUser, ownerBytes, ownerPath, runtimeIdentity } = options;
  try {
    await mkdir(acquire.lockPath, { mode: 0o700 });
  } catch (error) {
    if (isExisting(error)) return "existing";
    servicePathUnsafe();
  }

  let directory: OpenedDirectory | undefined;
  let ownerIdentity: FileIdentity | undefined;
  try {
    await assertCurrentIdentity(
      path.dirname(acquire.lockPath),
      runtimeIdentity,
      "directory",
      0o700,
      isCurrentUser,
    );
    directory = await openPrivateDirectory(acquire.lockPath, isCurrentUser);
    if (directory === undefined) servicePathUnsafe();
    const ownerHandle = await open(
      ownerPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const metadata = await ownerHandle.stat();
      ownerIdentity = identityOf(metadata);
      if (
        !metadata.isFile() ||
        !currentUserOwns(isCurrentUser, metadata.uid, ownerPath) ||
        (metadata.mode & 0o777) !== 0o600
      ) {
        servicePathUnsafe();
      }
      await ownerHandle.writeFile(ownerBytes);
      await ownerHandle.sync();
    } finally {
      await ownerHandle.close();
    }
    if (ownerIdentity === undefined) servicePathUnsafe();
    await assertCurrentIdentity(ownerPath, ownerIdentity, "file", 0o600, isCurrentUser);
    await exactEntries(acquire.lockPath, [OWNER_FILE_NAME]);
    await directory.handle.sync();
    const runtimeHandle = await open(
      path.dirname(acquire.lockPath),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await runtimeHandle.sync();
    } finally {
      await runtimeHandle.close();
    }
    return { directory: directory.identity, owner: ownerIdentity };
  } catch (error) {
    if (isInternalServiceError(error)) throw error;
    return servicePathUnsafe();
  } finally {
    await directory?.handle.close();
  }
}

async function releaseAcquiredLock(options: {
  readonly lockPath: string;
  readonly ownerPath: string;
  readonly expectedOwner: ServiceLockV1;
  readonly acquiredIdentity: AcquiredIdentity;
  readonly isCurrentUser: CurrentUserCheck;
  readonly hooks?: InstanceLockOperationHooks;
}): Promise<void> {
  const { acquiredIdentity, expectedOwner, hooks, isCurrentUser, lockPath, ownerPath } = options;
  const runtimePath = path.dirname(lockPath);
  const runtimeIdentity = await assertPrivateRuntimePath(runtimePath, isCurrentUser);
  const directory = await openPrivateDirectory(lockPath, isCurrentUser, true);
  if (directory === undefined) return;
  try {
    if (!sameIdentity(directory.identity, acquiredIdentity.directory)) return;
    const owner = await readPrivateOwner(ownerPath, isCurrentUser);
    if (owner === undefined) return;
    const expectedOpenedOwner: OpenedOwner = {
      owner: expectedOwner,
      identity: acquiredIdentity.owner,
    };
    if (owner.owner.service_instance_id !== expectedOwner.service_instance_id) {
      return;
    }
    if (!sameOwner(owner, expectedOpenedOwner)) return;
    const claimPath = path.join(lockPath, ownerClaimName(expectedOwner.service_instance_id));
    const claimedOwner = await claimOwnerForRemoval({
      operation: "release",
      lockPath,
      ownerPath,
      claimPath,
      directory,
      owner,
      isCurrentUser,
      runtimeIdentity,
      ...(hooks === undefined ? {} : { hooks }),
    });
    await removeClaimedLock({
      lockPath,
      claimPath,
      directory,
      claimedOwner,
      isCurrentUser,
      runtimeIdentity,
    });
  } finally {
    await directory.handle.close();
  }
}

async function acquireInstanceLockInternal(
  options: AcquireInstanceLockOptions,
): Promise<InstanceLock> {
  assertAbsolutePath(options.lockPath);
  assertAbsolutePath(options.socketPath);
  if (path.basename(options.lockPath) !== "instance.lock") servicePathUnsafe();
  const runtimePath = path.dirname(options.lockPath);
  if (path.dirname(options.socketPath) !== runtimePath) servicePathUnsafe();
  const isCurrentUser = options.isCurrentUser ?? defaultCurrentUserCheck;
  const runtimeIdentity = await assertPrivateRuntimePath(runtimePath, isCurrentUser);

  let createdAt: string;
  let nowMs: number;
  try {
    const current = options.now();
    nowMs = current.getTime();
    createdAt = current.toISOString();
  } catch {
    lockAmbiguous();
  }
  if (!Number.isFinite(nowMs)) lockAmbiguous();

  const { owner, bytes: ownerBytes } = createOwnerDocument(options, createdAt);
  const ownerPath = path.join(options.lockPath, OWNER_FILE_NAME);
  const operationHooks = readOperationHooks(options);

  let acquiredIdentity = await createClaim({
    acquire: options,
    ownerBytes,
    ownerPath,
    isCurrentUser,
    runtimeIdentity,
  });
  if (acquiredIdentity === "existing") {
    await inspectAndReclaim({
      acquire: options,
      ownerPath,
      nowMs,
      claimServiceInstanceId: owner.service_instance_id,
      isCurrentUser,
      runtimeIdentity,
      ...(operationHooks === undefined ? {} : { hooks: operationHooks }),
    });
    acquiredIdentity = await createClaim({
      acquire: options,
      ownerBytes,
      ownerPath,
      isCurrentUser,
      runtimeIdentity,
    });
    if (acquiredIdentity === "existing") lockAmbiguous();
  }

  let released = false;
  return Object.freeze({
    owner,
    async release(): Promise<void> {
      if (released) return;
      try {
        await releaseAcquiredLock({
          lockPath: options.lockPath,
          ownerPath,
          expectedOwner: owner,
          acquiredIdentity,
          isCurrentUser,
          ...(operationHooks === undefined ? {} : { hooks: operationHooks }),
        });
        released = true;
      } catch (error) {
        if (isInternalServiceError(error)) throw error;
        lockAmbiguous();
      }
    },
  });
}

export async function acquireInstanceLock(
  options: AcquireInstanceLockOptions,
): Promise<InstanceLock> {
  try {
    return await acquireInstanceLockInternal(options);
  } catch (error) {
    if (isInternalServiceError(error)) throw error;
    return servicePathUnsafe();
  }
}
