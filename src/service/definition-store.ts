import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
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

type ParentPolicy = "private" | "owned-not-writable";
type CurrentUserCheck = (userId: number) => boolean;

interface StoreOperations {
  readonly lstat: typeof lstat;
  readonly mkdir: typeof mkdir;
  readonly open: typeof open;
  readonly rename: typeof rename;
  readonly unlink: typeof unlink;
}

interface OwnedFileIdentity {
  readonly device: number;
  readonly inode: number;
}

const DEFAULT_OPERATIONS: StoreOperations = { lstat, mkdir, open, rename, unlink };
const SAFE_SUFFIX = /^[A-Za-z0-9_-]{1,64}$/;

function servicePathUnsafe(): never {
  throw new RuntimeServiceError("RUNTIME_SERVICE_PATH_UNSAFE");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function defaultCurrentUserCheck(userId: number): boolean {
  return typeof process.getuid !== "function" || process.getuid() === userId;
}

function isPrivateFileMode(mode: number): boolean {
  return (mode & 0o777) === 0o600;
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

  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0 || segment === "." || segment === "..") servicePathUnsafe();
    current = path.join(current, segment);
    const final = index === segments.length - 1;
    let created = false;
    let metadata;
    try {
      metadata = await operations.lstat(current);
    } catch (error) {
      if (!create && isMissing(error)) return false;
      if (!isMissing(error)) servicePathUnsafe();
      try {
        await operations.mkdir(current, { mode: 0o700 });
        created = true;
        metadata = await operations.lstat(current);
      } catch {
        servicePathUnsafe();
      }
    }

    if (metadata.isSymbolicLink()) servicePathUnsafe();
    if (!metadata.isDirectory()) servicePathUnsafe();
    if (created && (!isCurrentUser(metadata.uid) || (metadata.mode & 0o777) !== 0o700)) {
      servicePathUnsafe();
    }
    if (final) {
      if (!isCurrentUser(metadata.uid)) servicePathUnsafe();
      const mode = metadata.mode & 0o777;
      if (policy === "private" ? mode !== 0o700 : (mode & 0o022) !== 0) {
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
): Promise<void> {
  let metadata;
  try {
    metadata = await operations.lstat(target);
  } catch (error) {
    if (isMissing(error)) return;
    servicePathUnsafe();
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !isCurrentUser(metadata.uid) ||
    !isPrivateFileMode(metadata.mode)
  ) {
    servicePathUnsafe();
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
    const metadata = await operations.lstat(temporary);
    if (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      isCurrentUser(metadata.uid) &&
      isPrivateFileMode(metadata.mode) &&
      metadata.dev === identity.device &&
      metadata.ino === identity.inode
    ) {
      await operations.unlink(temporary);
    }
  } catch {
    // Cleanup is limited to the exact private file created by this operation.
  }
}

export async function writePrivateAtomic(options: {
  readonly target: string;
  readonly bytes: Uint8Array;
  readonly randomSuffix: () => string;
  readonly parentPolicy: ParentPolicy;
  readonly isCurrentUser?: CurrentUserCheck;
  readonly operations?: StoreOperations;
}): Promise<void> {
  const { target, bytes, randomSuffix, parentPolicy } = options;
  const operations = options.operations ?? DEFAULT_OPERATIONS;
  const isCurrentUser = options.isCurrentUser ?? defaultCurrentUserCheck;
  let temporary = "";
  let temporaryIdentity: OwnedFileIdentity | undefined;

  try {
    assertAbsoluteTarget(target);
    const parent = path.dirname(target);
    await inspectDirectoryPath(parent, parentPolicy, true, operations, isCurrentUser);
    await inspectReplaceableTarget(target, operations, isCurrentUser);

    const suffix = randomSuffix();
    if (!SAFE_SUFFIX.test(suffix)) servicePathUnsafe();
    temporary = path.join(parent, `.${path.basename(target)}.${suffix}.tmp`);
    const handle = await operations.open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || !isCurrentUser(metadata.uid) || !isPrivateFileMode(metadata.mode)) {
        servicePathUnsafe();
      }
      temporaryIdentity = { device: metadata.dev, inode: metadata.ino };
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await inspectReplaceableTarget(target, operations, isCurrentUser);
    await operations.rename(temporary, target);
    temporaryIdentity = undefined;

    const directory = await operations.open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await removeCreatedTemporary(temporary, temporaryIdentity, operations, isCurrentUser);
    if (error instanceof RuntimeServiceError) throw error;
    servicePathUnsafe();
  }
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
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      !defaultCurrentUserCheck(metadata.uid) ||
      !isPrivateFileMode(metadata.mode)
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

export async function readPrivateRegularFile(filePath: string): Promise<Uint8Array | undefined> {
  try {
    const handle = await openPrivateRegularFile(filePath);
    if (handle === undefined) return undefined;
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RuntimeServiceError) throw error;
    servicePathUnsafe();
  }
}

export async function removeOwnedDefinition(filePath: string): Promise<void> {
  assertAbsoluteTarget(filePath);
  const parent = path.dirname(filePath);
  try {
    const handle = await openPrivateRegularFile(filePath);
    if (handle === undefined) return;
    let opened;
    try {
      opened = await handle.stat();
    } finally {
      await handle.close();
    }
    const current = await lstat(filePath);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      servicePathUnsafe();
    }
    await unlink(filePath);
    const directory = await open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
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
  await writePrivateAtomic({
    target: configPath,
    bytes,
    randomSuffix: options.randomSuffix,
    parentPolicy: "private",
  });
  const loaded = await loadConfig({ ...options, explicitPath: configPath });
  return path.resolve(loaded.source);
}
