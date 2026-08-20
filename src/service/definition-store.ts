import { constants, type BigIntStats, type PathLike } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
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
    readonly afterStateStageWrite?: () => Promise<void>;
    readonly afterStateLink?: () => Promise<void>;
    readonly afterStateSync?: () => Promise<void>;
    readonly beforeStateStageUnlink?: () => Promise<void>;
    readonly afterStateStageUnlink?: () => Promise<void>;
    readonly beforeRename?: () => Promise<void>;
    readonly afterRename?: () => Promise<void>;
    readonly afterSync?: () => Promise<void>;
    readonly beforeUnlink?: () => Promise<void>;
    readonly afterUnlink?: () => Promise<void>;
  };
  readonly claimOwnerState?: (pid: number) => "dead" | "live" | "unknown";
}

const DELETE_CLAIM_STAGE_FILE = "state.stage";
const DELETE_CLAIM_STATE_FILE = "state";
const DELETE_CLAIM_DEFINITION_FILE = "definition";
const MAX_DELETE_CLAIMS = 8;
const MAX_DELETE_CLAIM_BYTES = 1024;
const CLAIM_PID_MAX = 2_147_483_647;
const CLAIM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface DeleteClaimState {
  readonly schema_version: "service-definition-delete-claim.v2";
  readonly document_type: "service-definition-delete-claim";
  readonly expected_device: string;
  readonly expected_inode: string;
  readonly expected_sha256: string;
}

interface ClaimRecord {
  readonly path: string;
  readonly identity: OwnedFileIdentity;
  readonly pid: number;
}

interface ClaimStatePublication {
  readonly stage?: PrivateRegularFileSnapshot;
  readonly state?: PrivateRegularFileSnapshot;
}

function privateDirectoryMode(metadata: BigIntStats): boolean {
  return (safeStatNumber(metadata.mode) & 0o777) === 0o700;
}

function claimName(filePath: string, pid: number, uuid: string): string {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > CLAIM_PID_MAX || !CLAIM_UUID.test(uuid)) {
    servicePathUnsafe();
  }
  return `.${path.basename(filePath)}.${pid}.${uuid}.delete-claim`;
}

function deleteClaimNamePattern(filePath: string): RegExp {
  const basename = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^\\.${basename}\\.([1-9][0-9]{0,9})\\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\.delete-claim$`,
    "u",
  );
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
    keys.join(",") !== "document_type,expected_device,expected_inode,expected_sha256,schema_version"
  ) {
    servicePathUnsafe();
  }
  if (
    value.schema_version !== "service-definition-delete-claim.v2" ||
    value.document_type !== "service-definition-delete-claim" ||
    expectedDevice === undefined ||
    expectedInode === undefined ||
    typeof value.expected_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.expected_sha256)
  ) {
    servicePathUnsafe();
  }
  const state: DeleteClaimState = {
    schema_version: "service-definition-delete-claim.v2",
    document_type: "service-definition-delete-claim",
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

async function claimDirectoryIdentity(
  claimPath: string,
  isCurrentUser: CurrentUserCheck,
): Promise<OwnedFileIdentity> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(claimPath, { bigint: true });
  } catch {
    servicePathUnsafe();
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !isCurrentUserOwner(metadata, claimPath, isCurrentUser) ||
    !privateDirectoryMode(metadata)
  ) {
    servicePathUnsafe();
  }
  return { device: metadata.dev, inode: metadata.ino };
}

async function prepareClaimDirectory(
  claimPath: string,
  pid: number,
  isCurrentUser: CurrentUserCheck,
): Promise<ClaimRecord> {
  let identity: OwnedFileIdentity | undefined;
  try {
    await mkdir(claimPath, { mode: 0o700 });
    await chmod(claimPath, 0o700);
    identity = await claimDirectoryIdentity(claimPath, isCurrentUser);
    const handle = await open(
      claimPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.chmod(0o700);
      const metadata = await handle.stat({ bigint: true });
      if (
        !metadata.isDirectory() ||
        !isCurrentUserOwner(metadata, claimPath, isCurrentUser) ||
        !privateDirectoryMode(metadata)
      ) {
        servicePathUnsafe();
      }
      const heldIdentity = { device: metadata.dev, inode: metadata.ino };
      const current = await claimDirectoryIdentity(claimPath, isCurrentUser);
      if (!sameIdentity(heldIdentity, current) || !sameIdentity(identity, current)) {
        servicePathUnsafe();
      }
      return { path: claimPath, identity: heldIdentity, pid };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (identity !== undefined) {
      try {
        const current = await claimDirectoryIdentity(claimPath, isCurrentUser);
        if (sameIdentity(identity, current) && (await readdir(claimPath)).length === 0) {
          await rmdir(claimPath);
          await syncDirectory(path.dirname(claimPath), DEFAULT_OPERATIONS);
        }
      } catch {
        // A changed or nonempty setup directory is retained and fails closed.
      }
    }
    if (error instanceof RuntimeServiceError) throw error;
    servicePathUnsafe();
  }
}

async function verifyClaimDirectory(
  claim: ClaimRecord,
  isCurrentUser: CurrentUserCheck,
): Promise<void> {
  if (!sameIdentity(await claimDirectoryIdentity(claim.path, isCurrentUser), claim.identity)) {
    servicePathUnsafe();
  }
}

async function claimEntries(
  claim: ClaimRecord,
  isCurrentUser: CurrentUserCheck,
): Promise<string[]> {
  await verifyClaimDirectory(claim, isCurrentUser);
  let entries: string[];
  try {
    entries = (await readdir(claim.path)).sort();
  } catch {
    servicePathUnsafe();
  }
  await verifyClaimDirectory(claim, isCurrentUser);
  if (
    entries.some(
      (entry) =>
        entry !== DELETE_CLAIM_STAGE_FILE &&
        entry !== DELETE_CLAIM_STATE_FILE &&
        entry !== DELETE_CLAIM_DEFINITION_FILE,
    )
  ) {
    servicePathUnsafe();
  }
  return entries;
}

async function readClaimFile(
  claim: ClaimRecord,
  name: string,
  isCurrentUser: CurrentUserCheck,
): Promise<PrivateRegularFileSnapshot> {
  await verifyClaimDirectory(claim, isCurrentUser);
  const snapshot = await readPrivateRegularFileSnapshot(path.join(claim.path, name), {
    isCurrentUser,
  });
  if (snapshot === undefined) servicePathUnsafe();
  await verifyClaimDirectory(claim, isCurrentUser);
  return snapshot;
}

async function claimEntryIdentity(
  claim: ClaimRecord,
  name: string,
  isCurrentUser: CurrentUserCheck,
): Promise<OwnedFileIdentity> {
  await verifyClaimDirectory(claim, isCurrentUser);
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path.join(claim.path, name), { bigint: true });
  } catch {
    servicePathUnsafe();
  }
  await verifyClaimDirectory(claim, isCurrentUser);
  return { device: metadata.dev, inode: metadata.ino };
}

async function unlinkExactClaimEntry(
  claim: ClaimRecord,
  name: string,
  expected: OwnedFileIdentity,
  isCurrentUser: CurrentUserCheck,
): Promise<void> {
  const current = await claimEntryIdentity(claim, name, isCurrentUser);
  if (!sameIdentity(current, expected)) servicePathUnsafe();
  await verifyClaimDirectory(claim, isCurrentUser);
  try {
    await unlink(path.join(claim.path, name));
  } catch {
    servicePathUnsafe();
  }
  await verifyClaimDirectory(claim, isCurrentUser);
  await syncDirectory(claim.path, DEFAULT_OPERATIONS);
  await verifyClaimDirectory(claim, isCurrentUser);
}

async function unlinkExactClaimFile(
  claim: ClaimRecord,
  name: string,
  expected: PrivateRegularFileSnapshot,
  isCurrentUser: CurrentUserCheck,
): Promise<void> {
  const entryPath = path.join(claim.path, name);
  const current = await readClaimFile(claim, name, isCurrentUser);
  if (!sameIdentity(current, expected) || !Buffer.from(current.bytes).equals(expected.bytes)) {
    servicePathUnsafe();
  }
  await verifyClaimDirectory(claim, isCurrentUser);
  try {
    await unlink(entryPath);
  } catch {
    servicePathUnsafe();
  }
  await verifyClaimDirectory(claim, isCurrentUser);
  await syncDirectory(claim.path, DEFAULT_OPERATIONS);
  await verifyClaimDirectory(claim, isCurrentUser);
}

async function removeClaimDirectory(
  claim: ClaimRecord,
  isCurrentUser: CurrentUserCheck,
): Promise<void> {
  if ((await claimEntries(claim, isCurrentUser)).length !== 0) servicePathUnsafe();
  await verifyClaimDirectory(claim, isCurrentUser);
  try {
    await rmdir(claim.path);
    await syncDirectory(path.dirname(claim.path), DEFAULT_OPERATIONS);
  } catch {
    servicePathUnsafe();
  }
}

async function cleanClaim(
  claim: ClaimRecord,
  entries: readonly string[],
  state: PrivateRegularFileSnapshot | undefined,
  definition: PrivateRegularFileSnapshot | undefined,
  stage: PrivateRegularFileSnapshot | undefined,
  isCurrentUser: CurrentUserCheck,
): Promise<void> {
  if (entries.includes(DELETE_CLAIM_DEFINITION_FILE)) {
    if (definition === undefined) servicePathUnsafe();
    await unlinkExactClaimFile(claim, DELETE_CLAIM_DEFINITION_FILE, definition, isCurrentUser);
  }
  if (entries.includes(DELETE_CLAIM_STAGE_FILE)) {
    if (stage === undefined) servicePathUnsafe();
    await unlinkExactClaimFile(claim, DELETE_CLAIM_STAGE_FILE, stage, isCurrentUser);
  }
  if (entries.includes(DELETE_CLAIM_STATE_FILE)) {
    if (state === undefined) servicePathUnsafe();
    await unlinkExactClaimFile(claim, DELETE_CLAIM_STATE_FILE, state, isCurrentUser);
  }
  await removeClaimDirectory(claim, isCurrentUser);
}

async function cleanAcceptedClaim(
  claim: ClaimRecord,
  state: PrivateRegularFileSnapshot,
  expected: PrivateRegularFileSnapshot,
  isCurrentUser: CurrentUserCheck,
): Promise<void> {
  const definition = await readClaimFile(claim, DELETE_CLAIM_DEFINITION_FILE, isCurrentUser);
  if (
    !sameIdentity(definition, expected) ||
    !Buffer.from(definition.bytes).equals(expected.bytes)
  ) {
    servicePathUnsafe();
  }
  await cleanClaim(
    claim,
    [DELETE_CLAIM_STATE_FILE, DELETE_CLAIM_DEFINITION_FILE],
    state,
    definition,
    undefined,
    isCurrentUser,
  );
}

async function cleanExactUnlinkedClaim(
  claim: ClaimRecord,
  publication: ClaimStatePublication,
  isCurrentUser: CurrentUserCheck,
): Promise<boolean> {
  const entries = await claimEntries(claim, isCurrentUser);
  if (entries.includes(DELETE_CLAIM_DEFINITION_FILE)) return false;
  const hasStage = entries.includes(DELETE_CLAIM_STAGE_FILE);
  const hasState = entries.includes(DELETE_CLAIM_STATE_FILE);
  if (hasStage && publication.stage === undefined) {
    return false;
  }
  if (!hasStage && publication.stage !== undefined && publication.state === undefined) {
    return false;
  }
  if (hasState !== (publication.state !== undefined)) {
    return false;
  }
  if (hasStage && publication.stage !== undefined) {
    const current = await readClaimFile(claim, DELETE_CLAIM_STAGE_FILE, isCurrentUser);
    if (
      !sameIdentity(current, publication.stage) ||
      !Buffer.from(current.bytes).equals(publication.stage.bytes)
    ) {
      return false;
    }
  }
  if (hasState && publication.state !== undefined) {
    const current = await readClaimFile(claim, DELETE_CLAIM_STATE_FILE, isCurrentUser);
    if (
      !sameIdentity(current, publication.state) ||
      !Buffer.from(current.bytes).equals(publication.state.bytes)
    ) {
      return false;
    }
  }
  await cleanClaim(claim, entries, publication.state, undefined, publication.stage, isCurrentUser);
  return true;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath, { bigint: true });
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    servicePathUnsafe();
  }
}

async function publishClaimState(
  claim: ClaimRecord,
  bytes: Uint8Array,
  isCurrentUser: CurrentUserCheck,
  hooks: RemoveOwnedDefinitionOptions["hooks"],
  retainClaim: () => void,
  recordPublication: (publication: ClaimStatePublication) => void,
): Promise<PrivateRegularFileSnapshot> {
  const stagePath = path.join(claim.path, DELETE_CLAIM_STAGE_FILE);
  const statePath = path.join(claim.path, DELETE_CLAIM_STATE_FILE);
  let stage: PrivateRegularFileSnapshot;
  await verifyClaimDirectory(claim, isCurrentUser);
  try {
    const handle = await open(
      stagePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      const metadata = await handle.stat({ bigint: true });
      if (
        !metadata.isFile() ||
        !isCurrentUserOwner(metadata, stagePath, isCurrentUser) ||
        !privateFileMode(metadata)
      ) {
        servicePathUnsafe();
      }
      await handle.writeFile(bytes);
      await handle.sync();
      const persisted = await handle.stat({ bigint: true });
      if (
        !persisted.isFile() ||
        !isCurrentUserOwner(persisted, stagePath, isCurrentUser) ||
        !privateFileMode(persisted) ||
        persisted.dev !== metadata.dev ||
        persisted.ino !== metadata.ino ||
        persisted.size !== BigInt(bytes.byteLength)
      ) {
        servicePathUnsafe();
      }
      stage = {
        bytes: Uint8Array.from(bytes),
        device: persisted.dev,
        inode: persisted.ino,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RuntimeServiceError) throw error;
    servicePathUnsafe();
  }
  recordPublication({ stage });
  try {
    await hooks?.afterStateStageWrite?.();
  } catch {
    retainClaim();
    throw new Error("interrupted state-stage write");
  }
  await verifyClaimDirectory(claim, isCurrentUser);
  const staged = await readClaimFile(claim, DELETE_CLAIM_STAGE_FILE, isCurrentUser);
  if (!sameIdentity(staged, stage) || !Buffer.from(staged.bytes).equals(stage.bytes)) {
    servicePathUnsafe();
  }
  try {
    await link(stagePath, statePath);
  } catch {
    servicePathUnsafe();
  }
  const state = await readClaimFile(claim, DELETE_CLAIM_STATE_FILE, isCurrentUser);
  if (!sameIdentity(stage, state) || !Buffer.from(state.bytes).equals(stage.bytes))
    servicePathUnsafe();
  recordPublication({ stage, state });
  try {
    await hooks?.afterStateLink?.();
  } catch {
    retainClaim();
    throw new Error("interrupted state link");
  }
  await verifyClaimDirectory(claim, isCurrentUser);
  await syncDirectory(claim.path, DEFAULT_OPERATIONS);
  await verifyClaimDirectory(claim, isCurrentUser);
  try {
    await hooks?.afterStateSync?.();
  } catch {
    retainClaim();
    throw new Error("interrupted state sync");
  }
  const currentState = await readClaimFile(claim, DELETE_CLAIM_STATE_FILE, isCurrentUser);
  if (!sameIdentity(currentState, state) || !Buffer.from(currentState.bytes).equals(state.bytes)) {
    servicePathUnsafe();
  }
  try {
    await hooks?.beforeStateStageUnlink?.();
  } catch {
    retainClaim();
    throw new Error("interrupted state-stage unlink");
  }
  await unlinkExactClaimFile(claim, DELETE_CLAIM_STAGE_FILE, stage, isCurrentUser);
  try {
    await hooks?.afterStateStageUnlink?.();
  } catch {
    retainClaim();
    throw new Error("interrupted state-stage unlink");
  }
  await verifyClaimDirectory(claim, isCurrentUser);
  return state;
}

function readDeleteClaimState(snapshot: PrivateRegularFileSnapshot): DeleteClaimState {
  return parseDeleteClaimState(snapshot.bytes);
}

async function recoverDeleteClaim(
  filePath: string,
  claim: ClaimRecord,
  isCurrentUser: CurrentUserCheck,
  claimOwnerState: (pid: number) => "dead" | "live" | "unknown",
): Promise<void> {
  const entries = await claimEntries(claim, isCurrentUser);
  if (claimOwnerState(claim.pid) !== "dead") servicePathUnsafe();
  const stage = entries.includes(DELETE_CLAIM_STAGE_FILE)
    ? await readClaimFile(claim, DELETE_CLAIM_STAGE_FILE, isCurrentUser)
    : undefined;
  const state = entries.includes(DELETE_CLAIM_STATE_FILE)
    ? await readClaimFile(claim, DELETE_CLAIM_STATE_FILE, isCurrentUser)
    : undefined;
  const definition = entries.includes(DELETE_CLAIM_DEFINITION_FILE)
    ? await readClaimFile(claim, DELETE_CLAIM_DEFINITION_FILE, isCurrentUser)
    : undefined;

  if (state === undefined) {
    if (definition !== undefined) servicePathUnsafe();
    await cleanClaim(claim, entries, undefined, undefined, stage, isCurrentUser);
    return;
  }
  const descriptor = readDeleteClaimState(state);
  if (stage !== undefined) {
    if (!sameIdentity(stage, state) || !Buffer.from(stage.bytes).equals(state.bytes))
      servicePathUnsafe();
    await unlinkExactClaimFile(claim, DELETE_CLAIM_STAGE_FILE, stage, isCurrentUser);
  }
  if (definition === undefined) {
    await cleanClaim(claim, [DELETE_CLAIM_STATE_FILE], state, undefined, undefined, isCurrentUser);
    return;
  }
  if (!snapshotMatches(definition, descriptor)) servicePathUnsafe();
  let canonical: PrivateRegularFileSnapshot | undefined;
  let canonicalSafe = true;
  try {
    canonical = await readPrivateRegularFileSnapshot(filePath, { isCurrentUser });
  } catch {
    canonicalSafe = false;
  }
  if (canonicalSafe && canonical !== undefined && !snapshotMatches(canonical, descriptor)) {
    canonicalSafe = false;
  }
  await cleanClaim(
    claim,
    [DELETE_CLAIM_STATE_FILE, DELETE_CLAIM_DEFINITION_FILE],
    state,
    definition,
    undefined,
    isCurrentUser,
  );
  if (!canonicalSafe) servicePathUnsafe();
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
    const prefix = `.${path.basename(filePath)}.`;
    const claims = (await readdir(parent))
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".delete-claim"))
      .sort();
    if (claims.length > MAX_DELETE_CLAIMS) servicePathUnsafe();
    for (const name of claims) {
      const match = pattern.exec(name);
      if (match === null || match[1] === undefined) servicePathUnsafe();
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid < 1 || pid > CLAIM_PID_MAX) servicePathUnsafe();
      const claim: ClaimRecord = {
        path: path.join(parent, name),
        identity: await claimDirectoryIdentity(path.join(parent, name), isCurrentUser),
        pid,
      };
      await recoverDeleteClaim(
        filePath,
        claim,
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
  let claim: ClaimRecord | undefined;
  let state: PrivateRegularFileSnapshot | undefined;
  let publication: ClaimStatePublication = {};
  let linked = false;
  let retainUnlinkedClaim = false;
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
    const uuid = (options.randomSuffix ?? randomUUID)();
    const claimPath = path.join(parent, claimName(filePath, process.pid, uuid));
    claim = await prepareClaimDirectory(claimPath, process.pid, isCurrentUser);
    await syncDirectory(parent, DEFAULT_OPERATIONS);
    await verifyClaimDirectory(claim, isCurrentUser);
    const descriptor: DeleteClaimState = {
      schema_version: "service-definition-delete-claim.v2",
      document_type: "service-definition-delete-claim",
      expected_device: snapshot.device.toString(),
      expected_inode: snapshot.inode.toString(),
      expected_sha256: sha256(snapshot.bytes),
    };
    state = await publishClaimState(
      claim,
      claimStateBytes(descriptor),
      isCurrentUser,
      options.hooks,
      () => {
        retainUnlinkedClaim = true;
      },
      (published) => {
        publication = published;
      },
    );
    const current = await readPrivateRegularFileSnapshot(filePath, { isCurrentUser });
    if (
      current === undefined ||
      !sameIdentity(snapshot, current) ||
      !expectedSnapshotMatches(current, options)
    ) {
      await cleanClaim(
        claim,
        [DELETE_CLAIM_STATE_FILE],
        state,
        undefined,
        undefined,
        isCurrentUser,
      );
      claim = undefined;
      servicePathUnsafe();
    }
    if ((await claimEntries(claim, isCurrentUser)).join(",") !== DELETE_CLAIM_STATE_FILE)
      servicePathUnsafe();
    await options.hooks?.beforeRename?.();
    await link(filePath, path.join(claim.path, DELETE_CLAIM_DEFINITION_FILE));
    linked = true;
    const linkedIdentity = await claimEntryIdentity(
      claim,
      DELETE_CLAIM_DEFINITION_FILE,
      isCurrentUser,
    );
    await options.hooks?.afterRename?.();
    await syncDirectory(claim.path, DEFAULT_OPERATIONS);
    await verifyClaimDirectory(claim, isCurrentUser);
    await options.hooks?.afterSync?.();
    let claimed: PrivateRegularFileSnapshot;
    try {
      claimed = await readClaimFile(claim, DELETE_CLAIM_DEFINITION_FILE, isCurrentUser);
    } catch {
      await unlinkExactClaimEntry(
        claim,
        DELETE_CLAIM_DEFINITION_FILE,
        linkedIdentity,
        isCurrentUser,
      );
      await cleanClaim(
        claim,
        [DELETE_CLAIM_STATE_FILE],
        state,
        undefined,
        undefined,
        isCurrentUser,
      );
      claim = undefined;
      servicePathUnsafe();
    }
    if (!sameIdentity(snapshot, claimed) || !expectedSnapshotMatches(claimed, options)) {
      await cleanClaim(
        claim,
        [DELETE_CLAIM_STATE_FILE, DELETE_CLAIM_DEFINITION_FILE],
        state,
        claimed,
        undefined,
        isCurrentUser,
      );
      claim = undefined;
      servicePathUnsafe();
    }
    let linkedCurrent: PrivateRegularFileSnapshot | undefined;
    try {
      linkedCurrent = await readPrivateRegularFileSnapshot(filePath, { isCurrentUser });
    } catch {
      await cleanAcceptedClaim(claim, state, claimed, isCurrentUser);
      claim = undefined;
      servicePathUnsafe();
    }
    if (
      linkedCurrent === undefined ||
      !sameIdentity(snapshot, linkedCurrent) ||
      !expectedSnapshotMatches(linkedCurrent, options)
    ) {
      await cleanClaim(
        claim,
        [DELETE_CLAIM_STATE_FILE, DELETE_CLAIM_DEFINITION_FILE],
        state,
        claimed,
        undefined,
        isCurrentUser,
      );
      claim = undefined;
      servicePathUnsafe();
    }
    await options.hooks?.beforeUnlink?.();
    let finalCurrent: PrivateRegularFileSnapshot | undefined;
    let finalClaim: PrivateRegularFileSnapshot;
    try {
      finalClaim = await readClaimFile(claim, DELETE_CLAIM_DEFINITION_FILE, isCurrentUser);
      finalCurrent = await readPrivateRegularFileSnapshot(filePath, { isCurrentUser });
    } catch {
      await cleanAcceptedClaim(claim, state, claimed, isCurrentUser);
      claim = undefined;
      servicePathUnsafe();
    }
    if (
      finalCurrent === undefined ||
      !sameIdentity(snapshot, finalCurrent) ||
      !expectedSnapshotMatches(finalCurrent, options) ||
      !sameIdentity(snapshot, finalClaim) ||
      !expectedSnapshotMatches(finalClaim, options)
    ) {
      await cleanAcceptedClaim(claim, state, claimed, isCurrentUser);
      claim = undefined;
      servicePathUnsafe();
    }
    await unlink(filePath);
    const immediateReappearance = await pathExists(filePath);
    const immediateClaim = await readClaimFile(claim, DELETE_CLAIM_DEFINITION_FILE, isCurrentUser);
    if (
      immediateReappearance ||
      !sameIdentity(immediateClaim, snapshot) ||
      !expectedSnapshotMatches(immediateClaim, options)
    ) {
      await cleanAcceptedClaim(claim, state, snapshot, isCurrentUser);
      claim = undefined;
      servicePathUnsafe();
    }
    if (options.hooks?.afterUnlink !== undefined) await options.hooks.afterUnlink();
    const reappeared = await pathExists(filePath);
    const remainingClaim = await readClaimFile(claim, DELETE_CLAIM_DEFINITION_FILE, isCurrentUser);
    if (
      !sameIdentity(remainingClaim, snapshot) ||
      !expectedSnapshotMatches(remainingClaim, options)
    ) {
      servicePathUnsafe();
    }
    await cleanAcceptedClaim(claim, state, snapshot, isCurrentUser);
    claim = undefined;
    if (reappeared) servicePathUnsafe();
  } catch (error) {
    if (!linked && !retainUnlinkedClaim && claim !== undefined) {
      try {
        await cleanExactUnlinkedClaim(claim, publication, isCurrentUser);
      } catch {
        // A changed or malformed claim is retained and fails closed.
      }
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
