import { constants, type BigIntStats, type PathLike } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
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

async function openPrivateRegularFile(
  filePath: string,
  isCurrentUser: CurrentUserCheck,
): Promise<FileHandle | undefined> {
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
      !isCurrentUserOwner(metadata, filePath, isCurrentUser) ||
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
  readonly isCurrentUser?: CurrentUserCheck;
}

export interface PrivateRegularFileSnapshot {
  readonly bytes: Uint8Array;
  readonly device: bigint;
  readonly inode: bigint;
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

export async function readPrivateRegularFileSnapshot(
  filePath: string,
  options: ReadPrivateRegularFileOptions = {},
): Promise<PrivateRegularFileSnapshot | undefined> {
  try {
    const handle = await openPrivateRegularFile(
      filePath,
      options.isCurrentUser ?? defaultCurrentUserCheck,
    );
    if (handle === undefined) return undefined;
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.size > BigInt(MAX_PRIVATE_REGULAR_FILE_BYTES)) servicePathUnsafe();
      await options.beforeRead?.();
      const bytes = await readBounded(handle);
      const current = await handle.stat({ bigint: true });
      if (current.dev !== opened.dev || current.ino !== opened.ino) servicePathUnsafe();
      return { bytes, device: current.dev, inode: current.ino };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RuntimeServiceError) throw error;
    servicePathUnsafe();
  }
}

export async function readPrivateRegularFile(
  filePath: string,
  options: ReadPrivateRegularFileOptions = {},
): Promise<Uint8Array | undefined> {
  const snapshot = await readPrivateRegularFileSnapshot(filePath, options);
  return snapshot?.bytes;
}

export interface RemoveOwnedDefinitionOptions {
  readonly expectedBytes?: Uint8Array;
  readonly expectedIdentity?: OwnedFileIdentity;
  readonly randomSuffix?: () => string;
  readonly isCurrentUser?: CurrentUserCheck;
  readonly hooks?: {
    readonly beforeClaim?: () => Promise<void>;
    readonly beforeRename?: () => Promise<void>;
    readonly afterRename?: () => Promise<void>;
    readonly afterSync?: () => Promise<void>;
    readonly beforeUnlink?: () => Promise<void>;
    readonly afterUnlink?: () => Promise<void>;
  };
  readonly claimOwnerState?: (pid: number) => "dead" | "live" | "unknown";
}

const DELETE_CLAIM_STATE_FILE = "state.json";
const DELETE_CLAIM_DISPLACED_FILE = "definition";
const MAX_DELETE_CLAIMS = 8;
const MAX_DELETE_CLAIM_BYTES = 1024;

interface DeleteClaimState {
  readonly schema_version: "service-definition-delete-claim.v1";
  readonly document_type: "service-definition-delete-claim";
  readonly phase: "prepared" | "deleting";
  readonly pid: number;
  readonly expected_device: string;
  readonly expected_inode: string;
  readonly expected_sha256: string;
}

function deleteClaimName(filePath: string, suffix: string): string {
  return `.${path.basename(filePath)}.${suffix}.delete-claim`;
}

function deleteClaimNamePattern(filePath: string): RegExp {
  const basename = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\.${basename}\\.([A-Za-z0-9_-]{1,64})\\.delete-claim$`, "u");
}

function sameIdentity(left: OwnedFileIdentity, right: OwnedFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function claimStateBytes(state: DeleteClaimState): Uint8Array {
  return Buffer.from(
    `${JSON.stringify({
      schema_version: state.schema_version,
      document_type: state.document_type,
      phase: state.phase,
      pid: state.pid,
      expected_device: state.expected_device,
      expected_inode: state.expected_inode,
      expected_sha256: state.expected_sha256,
    })}\n`,
    "utf8",
  );
}

function parseClaimInteger(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  try {
    BigInt(value);
    return value;
  } catch {
    return undefined;
  }
}

function parseDeleteClaimState(bytes: Uint8Array): DeleteClaimState {
  if (bytes.byteLength > MAX_DELETE_CLAIM_BYTES) servicePathUnsafe();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    servicePathUnsafe();
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
    servicePathUnsafe();
  const value = decoded as Record<string, unknown>;
  const expectedDevice = parseClaimInteger(value.expected_device);
  const expectedInode = parseClaimInteger(value.expected_inode);
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !==
    "document_type,expected_device,expected_inode,expected_sha256,phase,pid,schema_version"
  ) {
    servicePathUnsafe();
  }
  if (
    value.schema_version !== "service-definition-delete-claim.v1" ||
    value.document_type !== "service-definition-delete-claim" ||
    (value.phase !== "prepared" && value.phase !== "deleting") ||
    !Number.isSafeInteger(value.pid) ||
    typeof value.pid !== "number" ||
    value.pid <= 0 ||
    expectedDevice === undefined ||
    expectedInode === undefined ||
    typeof value.expected_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.expected_sha256)
  ) {
    servicePathUnsafe();
  }
  const state: DeleteClaimState = {
    schema_version: "service-definition-delete-claim.v1",
    document_type: "service-definition-delete-claim",
    phase: value.phase,
    pid: value.pid,
    expected_device: expectedDevice,
    expected_inode: expectedInode,
    expected_sha256: value.expected_sha256,
  };
  if (!Buffer.from(claimStateBytes(state)).equals(Buffer.from(bytes))) servicePathUnsafe();
  return state;
}

function snapshotMatches(
  snapshot: PrivateRegularFileSnapshot,
  state: Pick<DeleteClaimState, "expected_device" | "expected_inode" | "expected_sha256">,
): boolean {
  return (
    snapshot.device === BigInt(state.expected_device) &&
    snapshot.inode === BigInt(state.expected_inode) &&
    sha256(snapshot.bytes) === state.expected_sha256
  );
}

function expectedSnapshotMatches(
  snapshot: PrivateRegularFileSnapshot,
  options: RemoveOwnedDefinitionOptions,
): boolean {
  return (
    (options.expectedBytes === undefined ||
      Buffer.from(snapshot.bytes).equals(Buffer.from(options.expectedBytes))) &&
    (options.expectedIdentity === undefined ||
      sameIdentity({ device: snapshot.device, inode: snapshot.inode }, options.expectedIdentity))
  );
}

function defaultClaimOwnerState(pid: number): "dead" | "live" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return "dead";
    return "unknown";
  }
}

async function inspectPrivateClaimDirectory(
  claimPath: string,
  isCurrentUser: CurrentUserCheck,
): Promise<void> {
  const exists = await inspectDirectoryPath(
    claimPath,
    "private",
    false,
    DEFAULT_OPERATIONS,
    isCurrentUser,
  );
  if (!exists) servicePathUnsafe();
}

async function claimEntries(claimPath: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await readdir(claimPath)).sort();
  } catch {
    servicePathUnsafe();
  }
  if (
    entries.some(
      (entry) => entry !== DELETE_CLAIM_STATE_FILE && entry !== DELETE_CLAIM_DISPLACED_FILE,
    )
  ) {
    servicePathUnsafe();
  }
  return entries;
}

async function removeClaimDirectory(claimPath: string, entries: readonly string[]): Promise<void> {
  try {
    if (entries.includes(DELETE_CLAIM_DISPLACED_FILE)) {
      await unlink(path.join(claimPath, DELETE_CLAIM_DISPLACED_FILE));
      await syncDirectory(claimPath, DEFAULT_OPERATIONS);
    }
    if (entries.includes(DELETE_CLAIM_STATE_FILE)) {
      await unlink(path.join(claimPath, DELETE_CLAIM_STATE_FILE));
      await syncDirectory(claimPath, DEFAULT_OPERATIONS);
    }
    await rmdir(claimPath);
    await syncDirectory(path.dirname(claimPath), DEFAULT_OPERATIONS);
  } catch {
    servicePathUnsafe();
  }
}

async function currentPathExists(filePath: string): Promise<boolean> {
  try {
    await DEFAULT_OPERATIONS.lstat(filePath, { bigint: true });
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    servicePathUnsafe();
  }
}

async function restoreDisplacedDefinition(
  filePath: string,
  claimPath: string,
  displacedPath: string,
): Promise<void> {
  if (await currentPathExists(filePath)) servicePathUnsafe();
  try {
    await rename(displacedPath, filePath);
    await syncDirectory(path.dirname(filePath), DEFAULT_OPERATIONS);
    await removeClaimDirectory(claimPath, await claimEntries(claimPath));
  } catch (error) {
    if (error instanceof RuntimeServiceError) throw error;
    servicePathUnsafe();
  }
}

async function readDeleteClaimState(
  statePath: string,
  isCurrentUser: CurrentUserCheck,
): Promise<DeleteClaimState> {
  const snapshot = await readPrivateRegularFileSnapshot(statePath, { isCurrentUser });
  if (snapshot === undefined) servicePathUnsafe();
  return parseDeleteClaimState(snapshot.bytes);
}

async function recoverDeleteClaim(
  filePath: string,
  claimPath: string,
  isCurrentUser: CurrentUserCheck,
  claimOwnerState: (pid: number) => "dead" | "live" | "unknown",
): Promise<void> {
  await inspectPrivateClaimDirectory(claimPath, isCurrentUser);
  const entries = await claimEntries(claimPath);
  if (entries.length === 0) {
    await removeClaimDirectory(claimPath, entries);
    return;
  }
  if (!entries.includes(DELETE_CLAIM_STATE_FILE)) servicePathUnsafe();
  const state = await readDeleteClaimState(
    path.join(claimPath, DELETE_CLAIM_STATE_FILE),
    isCurrentUser,
  );
  if (claimOwnerState(state.pid) !== "dead") servicePathUnsafe();
  const displacedPath = path.join(claimPath, DELETE_CLAIM_DISPLACED_FILE);
  const targetExists = await currentPathExists(filePath);
  const displacedExists = entries.includes(DELETE_CLAIM_DISPLACED_FILE);

  if (targetExists && displacedExists) servicePathUnsafe();
  if (targetExists) {
    if (state.phase !== "prepared") servicePathUnsafe();
    const target = await readPrivateRegularFileSnapshot(filePath, { isCurrentUser });
    if (target === undefined || !snapshotMatches(target, state)) servicePathUnsafe();
    await removeClaimDirectory(claimPath, entries);
    return;
  }
  if (displacedExists) {
    const displaced = await readPrivateRegularFileSnapshot(displacedPath, { isCurrentUser });
    if (displaced === undefined || !snapshotMatches(displaced, state)) servicePathUnsafe();
    await removeClaimDirectory(claimPath, entries);
    return;
  }
  if (state.phase !== "deleting") servicePathUnsafe();
  await removeClaimDirectory(claimPath, entries);
}

export interface RecoverOwnedDefinitionClaimsOptions {
  readonly isCurrentUser?: CurrentUserCheck;
  readonly claimOwnerState?: (pid: number) => "dead" | "live" | "unknown";
}

export async function recoverOwnedDefinitionClaims(
  filePath: string,
  options: RecoverOwnedDefinitionClaimsOptions = {},
): Promise<void> {
  assertAbsoluteTarget(filePath);
  const parent = path.dirname(filePath);
  const isCurrentUser = options.isCurrentUser ?? defaultCurrentUserCheck;
  try {
    const parentExists = await inspectDirectoryPath(
      parent,
      "owned-not-writable",
      false,
      DEFAULT_OPERATIONS,
      isCurrentUser,
    );
    if (!parentExists) return;
    const pattern = deleteClaimNamePattern(filePath);
    const claims = (await readdir(parent)).filter((entry) => pattern.test(entry)).sort();
    if (claims.length > MAX_DELETE_CLAIMS) servicePathUnsafe();
    for (const name of claims) {
      await recoverDeleteClaim(
        filePath,
        path.join(parent, name),
        isCurrentUser,
        options.claimOwnerState ?? defaultClaimOwnerState,
      );
    }
  } catch (error) {
    if (error instanceof RuntimeServiceError) throw error;
    servicePathUnsafe();
  }
}

export async function removeOwnedDefinition(
  filePath: string,
  options: RemoveOwnedDefinitionOptions = {},
): Promise<void> {
  assertAbsoluteTarget(filePath);
  const parent = path.dirname(filePath);
  const isCurrentUser = options.isCurrentUser ?? defaultCurrentUserCheck;
  try {
    await recoverOwnedDefinitionClaims(filePath, {
      ...(options.isCurrentUser === undefined ? {} : { isCurrentUser: options.isCurrentUser }),
      ...(options.claimOwnerState === undefined
        ? {}
        : { claimOwnerState: options.claimOwnerState }),
    });
    const snapshot = await readPrivateRegularFileSnapshot(filePath, { isCurrentUser });
    if (snapshot === undefined) return;
    if (!expectedSnapshotMatches(snapshot, options)) servicePathUnsafe();
    await options.hooks?.beforeClaim?.();
    const suffix = (options.randomSuffix ?? randomUUID)();
    if (!SAFE_SUFFIX.test(suffix)) servicePathUnsafe();
    const claimPath = path.join(parent, deleteClaimName(filePath, suffix));
    const statePath = path.join(claimPath, DELETE_CLAIM_STATE_FILE);
    const displacedPath = path.join(claimPath, DELETE_CLAIM_DISPLACED_FILE);
    try {
      await mkdir(claimPath, { mode: 0o700 });
    } catch {
      servicePathUnsafe();
    }
    await inspectPrivateClaimDirectory(claimPath, isCurrentUser);
    await syncDirectory(parent, DEFAULT_OPERATIONS);
    const state: DeleteClaimState = {
      schema_version: "service-definition-delete-claim.v1",
      document_type: "service-definition-delete-claim",
      phase: "prepared",
      pid: process.pid,
      expected_device: snapshot.device.toString(),
      expected_inode: snapshot.inode.toString(),
      expected_sha256: sha256(snapshot.bytes),
    };
    const published = await createPrivateAtomicIfMissing({
      target: statePath,
      bytes: claimStateBytes(state),
      randomSuffix: options.randomSuffix ?? randomUUID,
      parentPolicy: "private",
      isCurrentUser,
    });
    if (
      published !== "created" ||
      (await claimEntries(claimPath)).join(",") !== DELETE_CLAIM_STATE_FILE
    ) {
      servicePathUnsafe();
    }
    await syncDirectory(claimPath, DEFAULT_OPERATIONS);
    const current = await readPrivateRegularFileSnapshot(filePath, { isCurrentUser });
    if (
      current === undefined ||
      !sameIdentity(snapshot, current) ||
      !expectedSnapshotMatches(current, options)
    ) {
      servicePathUnsafe();
    }
    if ((await claimEntries(claimPath)).join(",") !== DELETE_CLAIM_STATE_FILE) servicePathUnsafe();
    await options.hooks?.beforeRename?.();
    await rename(filePath, displacedPath);
    await options.hooks?.afterRename?.();
    await syncDirectory(claimPath, DEFAULT_OPERATIONS);
    await syncDirectory(parent, DEFAULT_OPERATIONS);
    await options.hooks?.afterSync?.();
    let claimed: PrivateRegularFileSnapshot | undefined;
    try {
      claimed = await readPrivateRegularFileSnapshot(displacedPath, { isCurrentUser });
    } catch {
      await restoreDisplacedDefinition(filePath, claimPath, displacedPath);
      servicePathUnsafe();
    }
    if (
      claimed === undefined ||
      !sameIdentity(snapshot, claimed) ||
      !expectedSnapshotMatches(claimed, options)
    ) {
      await restoreDisplacedDefinition(filePath, claimPath, displacedPath);
      servicePathUnsafe();
    }
    const deleting: DeleteClaimState = { ...state, phase: "deleting" };
    await writePrivateAtomic({
      target: statePath,
      bytes: claimStateBytes(deleting),
      randomSuffix: options.randomSuffix ?? randomUUID,
      parentPolicy: "private",
      isCurrentUser,
    });
    await syncDirectory(claimPath, DEFAULT_OPERATIONS);
    await options.hooks?.beforeUnlink?.();
    await unlink(displacedPath);
    await options.hooks?.afterUnlink?.();
    await syncDirectory(claimPath, DEFAULT_OPERATIONS);
    await removeClaimDirectory(claimPath, await claimEntries(claimPath));
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
