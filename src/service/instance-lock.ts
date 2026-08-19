import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rmdir, unlink, type FileHandle } from "node:fs/promises";
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

function servicePathUnsafe(): never {
  throw new RuntimeServiceError("RUNTIME_SERVICE_PATH_UNSAFE");
}

function lockAmbiguous(): never {
  throw new RuntimeServiceError("RUNTIME_SERVICE_LOCK_AMBIGUOUS");
}

function alreadyRunning(): never {
  throw new RuntimeServiceError("RUNTIME_SERVICE_ALREADY_RUNNING");
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
  } catch (error) {
    if (error instanceof RuntimeServiceError) throw error;
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
    (metadata.mode & 0o777) !== mode ||
    !sameIdentity(identityOf(metadata), expected)
  ) {
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
    if (error instanceof RuntimeServiceError) throw error;
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
    await assertCurrentIdentity(ownerPath, identity, "file", 0o600, isCurrentUser);
    const parsed = parseServiceLock(bytes);
    if (!parsed.ok) lockAmbiguous();
    const canonicalBytes = Buffer.from(canonicalJson(parsed.value), "utf8");
    if (!Buffer.from(bytes).equals(canonicalBytes)) lockAmbiguous();
    return { owner: parsed.value, identity };
  } catch (error) {
    if (error instanceof RuntimeServiceError) throw error;
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
  probe: SocketIdentityProbe,
  socketPath: string,
): Promise<string | null> {
  try {
    return await probe.identify(socketPath);
  } catch {
    lockAmbiguous();
  }
}

function processLiveness(probe: ProcessProbe, pid: number): ProcessLiveness {
  try {
    const liveness = probe.liveness(pid);
    if (liveness !== "alive" && liveness !== "dead" && liveness !== "unknown") {
      lockAmbiguous();
    }
    return liveness;
  } catch (error) {
    if (error instanceof RuntimeServiceError) throw error;
    lockAmbiguous();
  }
}

async function removeValidatedLock(options: {
  readonly lockPath: string;
  readonly ownerPath: string;
  readonly directory: OpenedDirectory;
  readonly owner?: OpenedOwner;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
}): Promise<void> {
  const { directory, isCurrentUser, lockPath, owner, ownerPath, runtimeIdentity } = options;
  await exactEntries(lockPath, owner === undefined ? [] : [OWNER_FILE_NAME]);
  await assertCurrentIdentity(lockPath, directory.identity, "directory", 0o700, isCurrentUser);
  await assertCurrentIdentity(
    path.dirname(lockPath),
    runtimeIdentity,
    "directory",
    0o700,
    isCurrentUser,
  );
  if (owner !== undefined) {
    await assertCurrentIdentity(ownerPath, owner.identity, "file", 0o600, isCurrentUser);
    try {
      await unlink(ownerPath);
    } catch {
      lockAmbiguous();
    }
  }
  try {
    await rmdir(lockPath);
  } catch {
    lockAmbiguous();
  }
}

async function inspectAndReclaim(options: {
  readonly acquire: AcquireInstanceLockOptions;
  readonly ownerPath: string;
  readonly nowMs: number;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
}): Promise<void> {
  const { acquire, isCurrentUser, nowMs, ownerPath, runtimeIdentity } = options;
  const directory = await openPrivateDirectory(acquire.lockPath, isCurrentUser);
  if (directory === undefined) lockAmbiguous();
  try {
    const owner = await readPrivateOwner(ownerPath, isCurrentUser);
    if (owner === undefined) {
      await exactEntries(acquire.lockPath, []);
      if (
        !Number.isFinite(directory.modifiedAtMs) ||
        nowMs - directory.modifiedAtMs < OWNERLESS_STALE_AFTER_MS
      ) {
        lockAmbiguous();
      }
      if ((await identifySocket(acquire.socketProbe, acquire.socketPath)) !== null) {
        lockAmbiguous();
      }
      await removeValidatedLock({
        lockPath: acquire.lockPath,
        ownerPath,
        directory,
        isCurrentUser,
        runtimeIdentity,
      });
      return;
    }

    await exactEntries(acquire.lockPath, [OWNER_FILE_NAME]);
    const liveness = processLiveness(acquire.processProbe, owner.owner.pid);
    if (liveness === "unknown") lockAmbiguous();
    if (liveness === "alive") {
      if (owner.owner.executable_hash === acquire.executableHash) alreadyRunning();
      lockAmbiguous();
    }

    const socketIdentity = await identifySocket(acquire.socketProbe, acquire.socketPath);
    if (socketIdentity === owner.owner.service_instance_id) alreadyRunning();
    if (socketIdentity !== null) lockAmbiguous();
    await removeValidatedLock({
      lockPath: acquire.lockPath,
      ownerPath,
      directory,
      owner,
      isCurrentUser,
      runtimeIdentity,
    });
  } finally {
    await directory.handle.close();
  }
}

async function cleanupFailedClaim(options: {
  readonly lockPath: string;
  readonly ownerPath: string;
  readonly directoryIdentity: FileIdentity;
  readonly ownerIdentity?: FileIdentity;
  readonly isCurrentUser: CurrentUserCheck;
}): Promise<void> {
  const { directoryIdentity, isCurrentUser, lockPath, ownerIdentity, ownerPath } = options;
  try {
    await exactEntries(lockPath, ownerIdentity === undefined ? [] : [OWNER_FILE_NAME]);
    await assertCurrentIdentity(lockPath, directoryIdentity, "directory", 0o700, isCurrentUser);
    if (ownerIdentity !== undefined) {
      await assertCurrentIdentity(ownerPath, ownerIdentity, "file", 0o600, isCurrentUser);
      await unlink(ownerPath);
    }
    await rmdir(lockPath);
  } catch {
    // Cleanup is limited to the exact private objects created by this acquisition.
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
    if (directory !== undefined) {
      await cleanupFailedClaim({
        lockPath: acquire.lockPath,
        ownerPath,
        directoryIdentity: directory.identity,
        ...(ownerIdentity === undefined ? {} : { ownerIdentity }),
        isCurrentUser,
      });
    }
    if (error instanceof RuntimeServiceError) throw error;
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
}): Promise<void> {
  const { acquiredIdentity, expectedOwner, isCurrentUser, lockPath, ownerPath } = options;
  const runtimePath = path.dirname(lockPath);
  const runtimeIdentity = await assertPrivateRuntimePath(runtimePath, isCurrentUser);
  const directory = await openPrivateDirectory(lockPath, isCurrentUser, true);
  if (directory === undefined) return;
  try {
    if (!sameIdentity(directory.identity, acquiredIdentity.directory)) return;
    const owner = await readPrivateOwner(ownerPath, isCurrentUser);
    if (owner === undefined) return;
    if (
      owner.owner.service_instance_id !== expectedOwner.service_instance_id ||
      canonicalJson(owner.owner) !== canonicalJson(expectedOwner) ||
      !sameIdentity(owner.identity, acquiredIdentity.owner)
    ) {
      return;
    }
    await removeValidatedLock({
      lockPath,
      ownerPath,
      directory,
      owner,
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
      isCurrentUser,
      runtimeIdentity,
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
        });
        released = true;
      } catch (error) {
        if (error instanceof RuntimeServiceError) throw error;
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
    if (error instanceof RuntimeServiceError) throw error;
    return servicePathUnsafe();
  }
}
