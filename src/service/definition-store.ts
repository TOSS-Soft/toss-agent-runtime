import { constants, type BigIntStats, type PathLike } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { stringify } from "yaml";

import {
  defaultConfig,
  loadConfig,
  resolveDefaultConfigPath,
  RuntimeConfigError,
} from "../config/load.js";
import type { RuntimeEnvironment, RuntimePlatform } from "../config/types.js";
import { RuntimeServiceError } from "./errors.js";

export type ParentPolicy = "private" | "owned-not-writable";
type CurrentUserCheck = (userId: number, candidate?: string) => boolean;

interface StoreOperations {
  readonly lstat: (candidate: PathLike, options: { bigint: true }) => Promise<BigIntStats>;
  readonly mkdir: typeof mkdir;
  readonly open: typeof open;
  readonly rename: typeof rename;
  readonly unlink: typeof unlink;
}

interface OwnedFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

const DEFAULT_OPERATIONS: StoreOperations = {
  lstat: (candidate, options) => lstat(candidate, options),
  mkdir,
  open,
  rename,
  unlink,
};
const SAFE_SUFFIX = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PRIVATE_REGULAR_FILE_BYTES = 65_536;

function servicePathUnsafe(): never {
  throw new RuntimeServiceError("RUNTIME_SERVICE_PATH_UNSAFE");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function defaultCurrentUserCheck(userId: number): boolean {
  return typeof process.getuid !== "function" || process.getuid() === userId;
}

function isPrivateFileMode(mode: number): boolean {
  return (mode & 0o777) === 0o600;
}

function safeStatNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) servicePathUnsafe();
  return Number(value);
}

function isCurrentUserOwner(
  metadata: BigIntStats,
  candidate: string,
  isCurrentUser: CurrentUserCheck,
): boolean {
  return isCurrentUser(safeStatNumber(metadata.uid), candidate);
}

function privateFileMode(metadata: BigIntStats): boolean {
  return isPrivateFileMode(safeStatNumber(metadata.mode));
}

function assertAbsoluteTarget(target: string): void {
  if (!path.isAbsolute(target) || path.basename(target) === path.sep) servicePathUnsafe();
}

async function inspectDirectoryPath(
  directory: string,
  policy: ParentPolicy,
  create: boolean,
  operations: StoreOperations,
  isCurrentUser: CurrentUserCheck,
): Promise<boolean> {
  if (!path.isAbsolute(directory)) servicePathUnsafe();
  const parsed = path.parse(directory);
  const relative = directory.slice(parsed.root.length);
  const segments = relative.length === 0 ? [] : relative.split(path.sep);
  let current = parsed.root;
  let reachedCurrentUserDirectory = false;

  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0 || segment === "." || segment === "..") servicePathUnsafe();
    current = path.join(current, segment);
    const final = index === segments.length - 1;
    let created = false;
    let metadata;
    try {
      metadata = await operations.lstat(current, { bigint: true });
    } catch (error) {
      if (!create && isMissing(error)) return false;
      if (!isMissing(error)) servicePathUnsafe();
      try {
        await operations.mkdir(current, { mode: 0o700 });
        created = true;
        metadata = await operations.lstat(current, { bigint: true });
      } catch {
        servicePathUnsafe();
      }
    }

    if (metadata.isSymbolicLink()) servicePathUnsafe();
    if (!metadata.isDirectory()) servicePathUnsafe();
    const mode = safeStatNumber(metadata.mode);
    const ownedByCurrentUser = isCurrentUserOwner(metadata, current, isCurrentUser);
    const trustedSystemAncestor =
      safeStatNumber(metadata.uid) === 0 && !reachedCurrentUserDirectory;
    if (trustedSystemAncestor) {
      if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
        servicePathUnsafe();
      }
    } else {
      if (!ownedByCurrentUser || (mode & 0o022) !== 0) servicePathUnsafe();
      reachedCurrentUserDirectory = true;
    }
    if (created && (!ownedByCurrentUser || (mode & 0o777) !== 0o700)) {
      servicePathUnsafe();
    }
    if (final) {
      if (!ownedByCurrentUser) servicePathUnsafe();
      const permissions = mode & 0o777;
      if (policy === "private" ? permissions !== 0o700 : (permissions & 0o022) !== 0) {
        servicePathUnsafe();
      }
    }
  }
  return true;
}

async function inspectReplaceableTarget(
  target: string,
  operations: StoreOperations,
  isCurrentUser: CurrentUserCheck,
): Promise<boolean> {
  let metadata;
  try {
    metadata = await operations.lstat(target, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return false;
    servicePathUnsafe();
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !isCurrentUserOwner(metadata, target, isCurrentUser) ||
    !privateFileMode(metadata)
  ) {
    servicePathUnsafe();
  }
  return true;
}

async function syncDirectory(parent: string, operations: StoreOperations): Promise<void> {
  const directory = await operations.open(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function removeCreatedTemporary(
  temporary: string,
  identity: OwnedFileIdentity | undefined,
  operations: StoreOperations,
  isCurrentUser: CurrentUserCheck,
): Promise<void> {
  if (identity === undefined) return;
  try {
    const metadata = await operations.lstat(temporary, { bigint: true });
    if (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      isCurrentUserOwner(metadata, temporary, isCurrentUser) &&
      metadata.dev === identity.device &&
      metadata.ino === identity.inode
    ) {
      await operations.unlink(temporary);
    }
  } catch {
    // Cleanup is limited to the exact private file created by this operation.
  }
}

export interface WritePrivateAtomicOptions {
  readonly target: string;
  readonly bytes: Uint8Array;
  readonly randomSuffix: () => string;
  readonly parentPolicy: ParentPolicy;
  readonly isCurrentUser?: CurrentUserCheck;
  readonly operations?: StoreOperations;
}

async function publishPrivateAtomic(
  options: WritePrivateAtomicOptions,
  publication: "replace" | "create-if-missing",
  beforePublish?: () => Promise<void>,
): Promise<"published" | "existing"> {
  const { target, bytes, randomSuffix, parentPolicy } = options;
  const operations = options.operations ?? DEFAULT_OPERATIONS;
  const isCurrentUser = options.isCurrentUser ?? defaultCurrentUserCheck;
  let temporary = "";
  let temporaryIdentity: OwnedFileIdentity | undefined;

  try {
    assertAbsoluteTarget(target);
    const parent = path.dirname(target);
    await inspectDirectoryPath(parent, parentPolicy, true, operations, isCurrentUser);
    const targetExists = await inspectReplaceableTarget(target, operations, isCurrentUser);
    if (publication === "create-if-missing" && targetExists) return "existing";

    const suffix = randomSuffix();
    if (!SAFE_SUFFIX.test(suffix)) servicePathUnsafe();
    temporary = path.join(parent, `.${path.basename(target)}.${suffix}.tmp`);
    const handle = await operations.open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || !isCurrentUserOwner(metadata, temporary, isCurrentUser)) {
        servicePathUnsafe();
      }
      temporaryIdentity = { device: metadata.dev, inode: metadata.ino };
      if (!privateFileMode(metadata)) servicePathUnsafe();
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await beforePublish?.();
    if (publication === "replace") {
      await inspectReplaceableTarget(target, operations, isCurrentUser);
      await operations.rename(temporary, target);
      temporaryIdentity = undefined;
    } else {
      try {
        await link(temporary, target);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        if (!(await inspectReplaceableTarget(target, operations, isCurrentUser))) {
          servicePathUnsafe();
        }
        await removeCreatedTemporary(temporary, temporaryIdentity, operations, isCurrentUser);
        temporaryIdentity = undefined;
        await syncDirectory(parent, operations);
        return "existing";
      }
      await operations.unlink(temporary);
      temporaryIdentity = undefined;
    }
    await syncDirectory(parent, operations);
    return "published";
  } catch (error) {
    await removeCreatedTemporary(temporary, temporaryIdentity, operations, isCurrentUser);
    if (error instanceof RuntimeServiceError) throw error;
    servicePathUnsafe();
  }
}

export async function writePrivateAtomic(options: WritePrivateAtomicOptions): Promise<void> {
  await publishPrivateAtomic(options, "replace");
}

export interface CreatePrivateAtomicIfMissingOptions extends WritePrivateAtomicOptions {
  readonly beforePublish?: () => Promise<void>;
}

export async function createPrivateAtomicIfMissing(
  options: CreatePrivateAtomicIfMissingOptions,
): Promise<"created" | "existing"> {
  const result = await publishPrivateAtomic(options, "create-if-missing", options.beforePublish);
  return result === "published" ? "created" : "existing";
}

async function openPrivateRegularFile(filePath: string): Promise<FileHandle | undefined> {
  assertAbsoluteTarget(filePath);
  const parentExists = await inspectDirectoryPath(
    path.dirname(filePath),
    "owned-not-writable",
    false,
    DEFAULT_OPERATIONS,
    defaultCurrentUserCheck,
  );
  if (!parentExists) return undefined;
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return undefined;
    servicePathUnsafe();
  }

  try {
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isFile() ||
      !isCurrentUserOwner(metadata, filePath, defaultCurrentUserCheck) ||
      !privateFileMode(metadata)
    ) {
      servicePathUnsafe();
    }
    return handle;
  } catch (error) {
    await handle.close();
    if (error instanceof RuntimeServiceError) throw error;
    servicePathUnsafe();
  }
}

export interface ReadPrivateRegularFileOptions {
  readonly beforeRead?: () => Promise<void>;
}

async function readBounded(handle: FileHandle): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(MAX_PRIVATE_REGULAR_FILE_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > MAX_PRIVATE_REGULAR_FILE_BYTES) servicePathUnsafe();
  return bytes.subarray(0, offset);
}

export async function readPrivateRegularFile(
  filePath: string,
  options: ReadPrivateRegularFileOptions = {},
): Promise<Uint8Array | undefined> {
  try {
    const handle = await openPrivateRegularFile(filePath);
    if (handle === undefined) return undefined;
    try {
      const metadata = await handle.stat({ bigint: true });
      if (metadata.size > BigInt(MAX_PRIVATE_REGULAR_FILE_BYTES)) servicePathUnsafe();
      await options.beforeRead?.();
      return await readBounded(handle);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RuntimeServiceError) throw error;
    servicePathUnsafe();
  }
}

export interface RemoveOwnedDefinitionOptions {
  readonly expectedBytes?: Uint8Array;
  readonly randomSuffix?: () => string;
}

async function restoreClaimedDefinition(
  claimPath: string,
  filePath: string,
  parent: string,
): Promise<void> {
  try {
    await link(claimPath, filePath);
    await unlink(claimPath);
    await syncDirectory(parent, DEFAULT_OPERATIONS);
  } catch {
    servicePathUnsafe();
  }
}

export async function removeOwnedDefinition(
  filePath: string,
  options: RemoveOwnedDefinitionOptions = {},
): Promise<void> {
  assertAbsoluteTarget(filePath);
  const parent = path.dirname(filePath);
  let claimPath: string | undefined;
  let claimed = false;
  try {
    const parentExists = await inspectDirectoryPath(
      parent,
      "owned-not-writable",
      false,
      DEFAULT_OPERATIONS,
      defaultCurrentUserCheck,
    );
    if (!parentExists) return;
    const suffix = (options.randomSuffix ?? randomUUID)();
    if (!SAFE_SUFFIX.test(suffix)) servicePathUnsafe();
    claimPath = path.join(parent, `.${path.basename(filePath)}.${suffix}.delete-claim`);
    try {
      await DEFAULT_OPERATIONS.lstat(claimPath, { bigint: true });
      servicePathUnsafe();
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof RuntimeServiceError) throw error;
        servicePathUnsafe();
      }
    }
    try {
      await rename(filePath, claimPath);
      claimed = true;
      await syncDirectory(parent, DEFAULT_OPERATIONS);
    } catch (error) {
      if (isMissing(error)) return;
      servicePathUnsafe();
    }

    let claimedBytes: Uint8Array | undefined;
    try {
      claimedBytes = await readPrivateRegularFile(claimPath);
    } catch (error) {
      await restoreClaimedDefinition(claimPath, filePath, parent);
      claimed = false;
      if (error instanceof RuntimeServiceError) throw error;
      servicePathUnsafe();
    }
    if (
      claimedBytes === undefined ||
      (options.expectedBytes !== undefined &&
        !Buffer.from(claimedBytes).equals(Buffer.from(options.expectedBytes)))
    ) {
      await restoreClaimedDefinition(claimPath, filePath, parent);
      claimed = false;
      servicePathUnsafe();
    }
    await unlink(claimPath);
    claimed = false;
    await syncDirectory(parent, DEFAULT_OPERATIONS);
  } catch (error) {
    if (claimed && claimPath !== undefined) {
      await restoreClaimedDefinition(claimPath, filePath, parent);
    }
    if (error instanceof RuntimeServiceError) throw error;
    servicePathUnsafe();
  }
}

export async function ensureServiceConfig(options: {
  readonly explicitPath?: string;
  readonly platform: RuntimePlatform;
  readonly home: string;
  readonly env: RuntimeEnvironment;
  readonly randomSuffix: () => string;
  readonly beforeConfigPublish?: () => Promise<void>;
}): Promise<string> {
  if (options.explicitPath !== undefined) {
    if (!path.isAbsolute(options.explicitPath)) {
      throw new RuntimeConfigError("RUNTIME_CONFIG_INVALID", "Configuration path must be absolute");
    }
    const loaded = await loadConfig(options);
    return path.resolve(loaded.source);
  }

  const configPath = resolveDefaultConfigPath(options.platform, options.home, options.env);
  const existing = await loadConfig(options);
  if (existing.source !== "defaults") return path.resolve(existing.source);

  const config = defaultConfig(options.platform, options.home, options.env);
  const bytes = new TextEncoder().encode(stringify(config, { sortMapEntries: true }));
  await publishPrivateAtomic(
    {
      target: configPath,
      bytes,
      randomSuffix: options.randomSuffix,
      parentPolicy: "private",
    },
    "create-if-missing",
    options.beforeConfigPublish,
  );
  const loaded = await loadConfig({ ...options, explicitPath: configPath });
  return path.resolve(loaded.source);
}
