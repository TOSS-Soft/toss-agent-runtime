import { constants } from "node:fs";
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
  readonly afterOwnerClaimRename?: (operation: "reclaim" | "release") => Promise<void>;
  readonly afterOwnerlessSentinelCreate?: () => Promise<void>;
  readonly afterDocumentStageOpen?: (kind: InstanceLockDocumentKind) => Promise<void>;
  readonly afterDocumentStagePartialWrite?: (kind: InstanceLockDocumentKind) => Promise<void>;
  readonly afterDocumentStageSync?: (kind: InstanceLockDocumentKind) => Promise<void>;
  readonly afterDocumentPublishSync?: (kind: InstanceLockDocumentKind) => Promise<void>;
}

export type InstanceLockDocumentKind = "owner" | "owner-claim" | "ownerless-claim";

type CurrentUserCheck = (userId: bigint, candidate?: string) => boolean;
type RootUserCheck = (userId: bigint, candidate?: string) => boolean;

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
  readonly isRootUser?: RootUserCheck;
  readonly operationHooks?: InstanceLockOperationHooks;
}

export interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export function fileIdentityMatches(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

interface OpenedDirectory {
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
  readonly modifiedAtNs: bigint;
}

interface OpenedOwner {
  readonly owner: ServiceLockV1;
  readonly identity: FileIdentity;
}

interface AcquiredIdentity {
  readonly directory: FileIdentity;
  readonly owner: FileIdentity;
}

interface LockClaimV1 {
  readonly schema_version: "service-lock-claim.v1";
  readonly document_type: "service-lock-claim";
  readonly claim_kind: "owner" | "ownerless";
  readonly claimant: ServiceLockV1;
  readonly original_owner: ServiceLockV1 | null;
  readonly ownerless_since_ns: string | null;
}

interface OpenedClaim {
  readonly claim: LockClaimV1;
  readonly identity: FileIdentity;
}

interface StageDescriptor {
  readonly kind: InstanceLockDocumentKind;
  readonly name: string;
  readonly claimant: ServiceLockV1;
  readonly ownerlessSinceNs?: bigint;
}

interface OpenedStage {
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
}

const OWNER_FILE_NAME = "owner.json";
const OWNERLESS_STALE_AFTER_NS = 30_000_000_000n;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OWNER_CLAIM_PATTERN = new RegExp(`^\\.owner-claim\\.(${UUID_PATTERN})\\.json$`);
const OWNERLESS_CLAIM_PATTERN = new RegExp(`^\\.ownerless-reclaim\\.(${UUID_PATTERN})\\.json$`);
const STAGE_PATTERN = new RegExp(
  `^\\.(owner|owner-claim|ownerless-claim)-stage\\.(${UUID_PATTERN})\\.([1-9][0-9]*)\\.([0-9a-f]{64})\\.([0-9]+)(?:\\.([0-9]+))?\\.json$`,
);
const internalServiceErrors = new WeakSet<RuntimeServiceError>();

function ownerClaimName(serviceInstanceId: string): string {
  return `.owner-claim.${serviceInstanceId}.json`;
}

function displacedOwnerName(serviceInstanceId: string): string {
  return `.owner-claim.${serviceInstanceId}.owner.json`;
}

function ownerlessSentinelName(serviceInstanceId: string): string {
  return `.ownerless-reclaim.${serviceInstanceId}.json`;
}

function stagePrefix(kind: InstanceLockDocumentKind): string {
  return `.${kind}-stage.`;
}

function stageName(
  kind: InstanceLockDocumentKind,
  claimant: ServiceLockV1,
  ownerlessSinceNs?: bigint,
): string {
  const createdAtNs = ownerTimestampNs(claimant);
  if (createdAtNs % 1_000_000n !== 0n) lockAmbiguous();
  const base = `${stagePrefix(kind)}${claimant.service_instance_id}.${claimant.pid}.${claimant.executable_hash}.${createdAtNs / 1_000_000n}`;
  if (kind === "ownerless-claim") {
    if (ownerlessSinceNs === undefined || ownerlessSinceNs < 0n) lockAmbiguous();
    return `${base}.${ownerlessSinceNs}.json`;
  }
  if (ownerlessSinceNs !== undefined) lockAmbiguous();
  return `${base}.json`;
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

function identityOf(metadata: { readonly dev: bigint; readonly ino: bigint }): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function defaultCurrentUserCheck(userId: bigint): boolean {
  return typeof process.getuid !== "function" || BigInt(process.getuid()) === userId;
}

function defaultRootUserCheck(userId: bigint): boolean {
  return userId === 0n;
}

function ownershipCheck(
  check: (userId: bigint, candidate?: string) => boolean,
  userId: bigint,
  candidate: string,
): boolean {
  try {
    return check(userId, candidate);
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

function parseStageDescriptor(name: string): StageDescriptor | undefined {
  const match = STAGE_PATTERN.exec(name);
  if (match === null) return undefined;
  const [, kindValue, serviceInstanceId, pidValue, executableHash, createdAtMsValue, sinceValue] =
    match;
  if (
    (kindValue !== "owner" && kindValue !== "owner-claim" && kindValue !== "ownerless-claim") ||
    serviceInstanceId === undefined ||
    pidValue === undefined ||
    executableHash === undefined ||
    createdAtMsValue === undefined
  ) {
    lockAmbiguous();
  }
  let createdAtMs: bigint;
  let pid: number;
  try {
    createdAtMs = BigInt(createdAtMsValue);
    const numericPid = Number(pidValue);
    const numericCreatedAt = Number(createdAtMs);
    if (
      !Number.isSafeInteger(numericPid) ||
      String(numericPid) !== pidValue ||
      !Number.isSafeInteger(numericCreatedAt) ||
      String(numericCreatedAt) !== createdAtMsValue
    ) {
      lockAmbiguous();
    }
    pid = numericPid;
  } catch {
    lockAmbiguous();
  }
  let createdAt: string;
  try {
    createdAt = new Date(Number(createdAtMs)).toISOString();
  } catch {
    lockAmbiguous();
  }
  const candidate = {
    schema_version: "service-lock.v1",
    document_type: "service-lock",
    service_instance_id: serviceInstanceId,
    pid,
    executable_hash: executableHash,
    created_at: createdAt,
  } as const;
  const parsed = parseServiceLock(Buffer.from(canonicalJson(candidate), "utf8"));
  if (!parsed.ok) lockAmbiguous();
  let ownerlessSinceNs: bigint | undefined;
  if (kindValue === "ownerless-claim") {
    if (sinceValue === undefined) lockAmbiguous();
    try {
      ownerlessSinceNs = BigInt(sinceValue);
    } catch {
      lockAmbiguous();
    }
    if (ownerlessSinceNs < 0n || ownerlessSinceNs.toString() !== sinceValue) lockAmbiguous();
  } else if (sinceValue !== undefined) {
    lockAmbiguous();
  }
  const descriptor: StageDescriptor = {
    kind: kindValue,
    name,
    claimant: parsed.value,
    ...(ownerlessSinceNs === undefined ? {} : { ownerlessSinceNs }),
  };
  if (stageName(kindValue, parsed.value, ownerlessSinceNs) !== name) lockAmbiguous();
  return descriptor;
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
  isRootUser: RootUserCheck,
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
      metadata = await lstat(current, { bigint: true });
    } catch {
      servicePathUnsafe();
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) servicePathUnsafe();

    const ownedByCurrentUser = ownershipCheck(isCurrentUser, metadata.uid, current);
    const rootOwned = ownershipCheck(isRootUser, metadata.uid, current);
    if (rootOwned && !reachedCurrentUserDirectory) {
      const writable = (metadata.mode & 0o022n) !== 0n;
      const sticky = (metadata.mode & 0o1000n) !== 0n;
      if (writable && !sticky) servicePathUnsafe();
    } else {
      if (!ownedByCurrentUser || (metadata.mode & 0o022n) !== 0n) servicePathUnsafe();
      reachedCurrentUserDirectory = true;
    }
    if (index === segments.length - 1) {
      if (!ownedByCurrentUser || (metadata.mode & 0o777n) !== 0o700n) servicePathUnsafe();
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
    metadata = await lstat(candidate, { bigint: true });
  } catch {
    servicePathUnsafe();
  }
  if (
    metadata.isSymbolicLink() ||
    (kind === "directory" ? !metadata.isDirectory() : !metadata.isFile()) ||
    !ownershipCheck(isCurrentUser, metadata.uid, candidate) ||
    (metadata.mode & 0o777n) !== BigInt(mode)
  ) {
    servicePathUnsafe();
  }
  if (!fileIdentityMatches(identityOf(metadata), expected)) {
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
    const metadata = await handle.stat({ bigint: true });
    const identity = identityOf(metadata);
    if (
      !metadata.isDirectory() ||
      !ownershipCheck(isCurrentUser, metadata.uid, directoryPath) ||
      (metadata.mode & 0o777n) !== 0o700n ||
      metadata.mtimeNs < 0n
    ) {
      servicePathUnsafe();
    }
    await assertCurrentIdentity(directoryPath, identity, "directory", 0o700, isCurrentUser);
    return { handle, identity, modifiedAtNs: metadata.mtimeNs };
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

async function readPrivateBytes(
  candidate: string,
  isCurrentUser: CurrentUserCheck,
): Promise<{ readonly bytes: Uint8Array; readonly identity: FileIdentity } | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return undefined;
    servicePathUnsafe();
  }

  try {
    const metadata = await handle.stat({ bigint: true });
    const identity = identityOf(metadata);
    if (
      !metadata.isFile() ||
      !ownershipCheck(isCurrentUser, metadata.uid, candidate) ||
      (metadata.mode & 0o777n) !== 0o600n
    ) {
      servicePathUnsafe();
    }
    if (metadata.size > BigInt(MAX_CONTROL_MESSAGE_BYTES)) lockAmbiguous();
    const bytes = await readBounded(handle);
    await assertCurrentIdentity(candidate, identity, "file", 0o600, isCurrentUser, true);
    return { bytes, identity };
  } catch (error) {
    if (isInternalServiceError(error)) throw error;
    lockAmbiguous();
  } finally {
    await handle.close();
  }
}

function parseCanonicalOwner(bytes: Uint8Array): ServiceLockV1 {
  const parsed = parseServiceLock(bytes);
  if (!parsed.ok) lockAmbiguous();
  if (!Buffer.from(bytes).equals(Buffer.from(canonicalJson(parsed.value), "utf8"))) lockAmbiguous();
  return parsed.value;
}

async function readPrivateOwner(
  ownerPath: string,
  isCurrentUser: CurrentUserCheck,
): Promise<OpenedOwner | undefined> {
  const opened = await readPrivateBytes(ownerPath, isCurrentUser);
  if (opened === undefined) return undefined;
  return { owner: parseCanonicalOwner(opened.bytes), identity: opened.identity };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function nestedOwner(value: unknown): ServiceLockV1 {
  if (!isRecord(value)) lockAmbiguous();
  return parseCanonicalOwner(Buffer.from(canonicalJson(value), "utf8"));
}

function parseCanonicalClaim(bytes: Uint8Array): LockClaimV1 {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    lockAmbiguous();
  }
  if (
    !isRecord(decoded) ||
    !exactKeys(decoded, [
      "schema_version",
      "document_type",
      "claim_kind",
      "claimant",
      "original_owner",
      "ownerless_since_ns",
    ]) ||
    decoded.schema_version !== "service-lock-claim.v1" ||
    decoded.document_type !== "service-lock-claim" ||
    (decoded.claim_kind !== "owner" && decoded.claim_kind !== "ownerless")
  ) {
    lockAmbiguous();
  }
  const claimant = nestedOwner(decoded.claimant);
  const originalOwner =
    decoded.original_owner === null ? null : nestedOwner(decoded.original_owner);
  const ownerlessSince = decoded.ownerless_since_ns;
  if (
    ownerlessSince !== null &&
    (typeof ownerlessSince !== "string" || !/^(0|[1-9]\d*)$/.test(ownerlessSince))
  ) {
    lockAmbiguous();
  }
  if (
    (decoded.claim_kind === "owner" && (originalOwner === null || ownerlessSince !== null)) ||
    (decoded.claim_kind === "ownerless" && (originalOwner !== null || ownerlessSince === null))
  ) {
    lockAmbiguous();
  }
  const claim: LockClaimV1 = {
    schema_version: "service-lock-claim.v1",
    document_type: "service-lock-claim",
    claim_kind: decoded.claim_kind,
    claimant,
    original_owner: originalOwner,
    ownerless_since_ns: ownerlessSince,
  };
  if (!Buffer.from(bytes).equals(Buffer.from(canonicalJson(claim), "utf8"))) lockAmbiguous();
  return claim;
}

async function readPrivateClaim(
  claimPath: string,
  isCurrentUser: CurrentUserCheck,
): Promise<OpenedClaim | undefined> {
  const opened = await readPrivateBytes(claimPath, isCurrentUser);
  if (opened === undefined) return undefined;
  return { claim: parseCanonicalClaim(opened.bytes), identity: opened.identity };
}

async function exactEntries(directoryPath: string, expected: readonly string[]): Promise<void> {
  let entries: string[];
  try {
    entries = (await readdir(directoryPath)).sort();
  } catch {
    lockAmbiguous();
  }
  const sortedExpected = [...expected].sort();
  if (
    entries.length !== sortedExpected.length ||
    entries.some((entry, index) => entry !== sortedExpected[index])
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
    if (liveness !== "alive" && liveness !== "dead" && liveness !== "unknown") lockAmbiguous();
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
    fileIdentityMatches(actual.identity, expected.identity) &&
    canonicalJson(actual.owner) === canonicalJson(expected.owner)
  );
}

function sameOwnerDocument(actual: ServiceLockV1, expected: ServiceLockV1): boolean {
  return canonicalJson(actual) === canonicalJson(expected);
}

function assertSameOwner(actual: OpenedOwner, expected: OpenedOwner): void {
  if (!sameOwner(actual, expected)) lockAmbiguous();
}

function sameClaim(actual: OpenedClaim, expected: OpenedClaim): boolean {
  return (
    fileIdentityMatches(actual.identity, expected.identity) &&
    canonicalJson(actual.claim) === canonicalJson(expected.claim)
  );
}

async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array,
  offset: number,
  length: number,
): Promise<void> {
  let written = 0;
  while (written < length) {
    const result = await handle.write(bytes, offset + written, length - written, offset + written);
    if (result.bytesWritten <= 0) lockAmbiguous();
    written += result.bytesWritten;
  }
}

function sameStage(actual: OpenedStage, expected: OpenedStage): boolean {
  return (
    fileIdentityMatches(actual.identity, expected.identity) &&
    Buffer.from(actual.bytes).equals(Buffer.from(expected.bytes))
  );
}

async function publishCanonicalDocument(options: {
  readonly kind: InstanceLockDocumentKind;
  readonly finalPath: string;
  readonly bytes: Uint8Array;
  readonly claimant: ServiceLockV1;
  readonly ownerlessSinceNs?: bigint;
  readonly lockPath: string;
  readonly directory: OpenedDirectory;
  readonly expectedEntries: readonly string[];
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
  readonly hooks?: InstanceLockOperationHooks;
}): Promise<FileIdentity> {
  const {
    bytes,
    claimant,
    directory,
    expectedEntries,
    finalPath,
    hooks,
    isCurrentUser,
    kind,
    lockPath,
    ownerlessSinceNs,
    runtimeIdentity,
  } = options;
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CONTROL_MESSAGE_BYTES) lockAmbiguous();
  const stageFileName = stageName(kind, claimant, ownerlessSinceNs);
  const stagePath = path.join(lockPath, stageFileName);
  let afterStageOpen: ((kind: InstanceLockDocumentKind) => Promise<void>) | undefined;
  let afterStagePartialWrite: ((kind: InstanceLockDocumentKind) => Promise<void>) | undefined;
  let afterStageSync: ((kind: InstanceLockDocumentKind) => Promise<void>) | undefined;
  let afterPublishSync: ((kind: InstanceLockDocumentKind) => Promise<void>) | undefined;
  try {
    afterStageOpen = hooks?.afterDocumentStageOpen;
    afterStagePartialWrite = hooks?.afterDocumentStagePartialWrite;
    afterStageSync = hooks?.afterDocumentStageSync;
    afterPublishSync = hooks?.afterDocumentPublishSync;
  } catch {
    lockAmbiguous();
  }
  await exactEntries(lockPath, expectedEntries);
  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });

  let handle: FileHandle;
  try {
    handle = await open(
      stagePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    lockAmbiguous();
  }
  let staged: OpenedStage;
  try {
    const metadata = await handle.stat({ bigint: true });
    const identity = identityOf(metadata);
    if (
      !metadata.isFile() ||
      !ownershipCheck(isCurrentUser, metadata.uid, stagePath) ||
      (metadata.mode & 0o777n) !== 0o600n
    ) {
      servicePathUnsafe();
    }
    await runOperationHook(afterStageOpen === undefined ? undefined : () => afterStageOpen(kind));
    const partialLength = Math.max(1, Math.floor(bytes.byteLength / 2));
    await writeAll(handle, bytes, 0, partialLength);
    await handle.sync();
    await runOperationHook(
      afterStagePartialWrite === undefined ? undefined : () => afterStagePartialWrite(kind),
    );
    await writeAll(handle, bytes, partialLength, bytes.byteLength - partialLength);
    await handle.sync();
    staged = { bytes, identity };
    await runOperationHook(afterStageSync === undefined ? undefined : () => afterStageSync(kind));
  } finally {
    await handle.close();
  }

  const currentStage = await readPrivateBytes(stagePath, isCurrentUser);
  if (currentStage === undefined || !sameStage(currentStage, staged)) lockAmbiguous();
  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });
  await exactEntries(lockPath, [...expectedEntries, stageFileName]);
  try {
    await link(stagePath, finalPath);
    await directory.handle.sync();
  } catch {
    lockAmbiguous();
  }
  await runOperationHook(afterPublishSync === undefined ? undefined : () => afterPublishSync(kind));

  const [publishedStage, publishedFinal] = await Promise.all([
    readPrivateBytes(stagePath, isCurrentUser),
    readPrivateBytes(finalPath, isCurrentUser),
  ]);
  if (
    publishedStage === undefined ||
    publishedFinal === undefined ||
    !sameStage(publishedStage, staged) ||
    !sameStage(publishedFinal, staged)
  ) {
    lockAmbiguous();
  }
  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });
  await exactEntries(lockPath, [...expectedEntries, stageFileName, path.basename(finalPath)]);
  try {
    await unlink(stagePath);
    await directory.handle.sync();
  } catch {
    lockAmbiguous();
  }
  const final = await readPrivateBytes(finalPath, isCurrentUser);
  if (final === undefined || !sameStage(final, staged)) lockAmbiguous();
  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });
  await exactEntries(lockPath, [...expectedEntries, path.basename(finalPath)]);
  return staged.identity;
}

function ownerClaimDocument(claimant: ServiceLockV1, originalOwner: ServiceLockV1): LockClaimV1 {
  return {
    schema_version: "service-lock-claim.v1",
    document_type: "service-lock-claim",
    claim_kind: "owner",
    claimant,
    original_owner: originalOwner,
    ownerless_since_ns: null,
  };
}

function ownerlessClaimDocument(claimant: ServiceLockV1, sinceMs: bigint): LockClaimV1 {
  return {
    schema_version: "service-lock-claim.v1",
    document_type: "service-lock-claim",
    claim_kind: "ownerless",
    claimant,
    original_owner: null,
    ownerless_since_ns: sinceMs.toString(),
  };
}

async function claimOwnerForRemoval(options: {
  readonly operation: "reclaim" | "release";
  readonly lockPath: string;
  readonly ownerPath: string;
  readonly directory: OpenedDirectory;
  readonly owner: OpenedOwner;
  readonly claimant: ServiceLockV1;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
  readonly hooks?: InstanceLockOperationHooks;
}): Promise<{
  readonly claimPath: string;
  readonly displacedPath: string;
  readonly claim: OpenedClaim;
  readonly displaced: OpenedOwner;
}> {
  const {
    claimant,
    directory,
    hooks,
    isCurrentUser,
    lockPath,
    operation,
    owner,
    ownerPath,
    runtimeIdentity,
  } = options;
  const claimName = ownerClaimName(claimant.service_instance_id);
  const displacedName = displacedOwnerName(claimant.service_instance_id);
  const claimPath = path.join(lockPath, claimName);
  const displacedPath = path.join(lockPath, displacedName);
  const claimantCreatedAt = ownerTimestampNs(claimant);
  if (ownerTimestampNs(owner.owner) > claimantCreatedAt) lockAmbiguous();
  const claimDocument = ownerClaimDocument(claimant, owner.owner);
  const claimBytes = Buffer.from(canonicalJson(claimDocument), "utf8");
  const validatedClaim = parseCanonicalClaim(claimBytes);

  await exactEntries(lockPath, [OWNER_FILE_NAME]);
  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });
  const claimIdentity = await publishCanonicalDocument({
    kind: "owner-claim",
    finalPath: claimPath,
    bytes: claimBytes,
    claimant,
    lockPath,
    directory,
    expectedEntries: [OWNER_FILE_NAME],
    isCurrentUser,
    runtimeIdentity,
    ...(hooks === undefined ? {} : { hooks }),
  });
  const claim: OpenedClaim = { claim: validatedClaim, identity: claimIdentity };
  await exactEntries(lockPath, [OWNER_FILE_NAME, claimName]);
  const currentOwner = await readPrivateOwner(ownerPath, isCurrentUser);
  if (currentOwner === undefined) lockAmbiguous();
  assertSameOwner(currentOwner, owner);
  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });

  const beforeHook = hooks?.beforeOwnerClaimRename;
  await runOperationHook(beforeHook === undefined ? undefined : () => beforeHook(operation));
  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });
  await exactEntries(lockPath, [OWNER_FILE_NAME, claimName]);
  const revalidatedOwner = await readPrivateOwner(ownerPath, isCurrentUser);
  const revalidatedClaim = await readPrivateClaim(claimPath, isCurrentUser);
  if (revalidatedOwner === undefined || revalidatedClaim === undefined) lockAmbiguous();
  assertSameOwner(revalidatedOwner, owner);
  if (!sameClaim(revalidatedClaim, claim)) lockAmbiguous();

  try {
    await rename(ownerPath, displacedPath);
    await directory.handle.sync();
  } catch {
    lockAmbiguous();
  }
  const afterHook = hooks?.afterOwnerClaimRename;
  await runOperationHook(afterHook === undefined ? undefined : () => afterHook(operation));

  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });
  await exactEntries(lockPath, [claimName, displacedName]);
  const displaced = await readPrivateOwner(displacedPath, isCurrentUser);
  const claimed = await readPrivateClaim(claimPath, isCurrentUser);
  if (displaced === undefined || claimed === undefined) lockAmbiguous();
  assertSameOwner(displaced, owner);
  if (!sameClaim(claimed, claim)) lockAmbiguous();
  return { claimPath, displacedPath, claim, displaced };
}

async function removeClaimedLock(options: {
  readonly lockPath: string;
  readonly claimPath: string;
  readonly displacedPath: string;
  readonly directory: OpenedDirectory;
  readonly claim: OpenedClaim;
  readonly displaced: OpenedOwner;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
}): Promise<void> {
  const {
    claimPath,
    displacedPath,
    directory,
    claim,
    displaced,
    isCurrentUser,
    lockPath,
    runtimeIdentity,
  } = options;
  const currentClaim = await readPrivateClaim(claimPath, isCurrentUser);
  const currentDisplaced = await readPrivateOwner(displacedPath, isCurrentUser);
  if (currentClaim === undefined || currentDisplaced === undefined) lockAmbiguous();
  if (!sameClaim(currentClaim, claim)) lockAmbiguous();
  assertSameOwner(currentDisplaced, displaced);
  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });
  await exactEntries(lockPath, [path.basename(claimPath), path.basename(displacedPath)]);
  try {
    await unlink(displacedPath);
  } catch {
    lockAmbiguous();
  }
  const finalClaim = await readPrivateClaim(claimPath, isCurrentUser);
  if (finalClaim === undefined || !sameClaim(finalClaim, claim)) lockAmbiguous();
  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });
  await exactEntries(lockPath, [path.basename(claimPath)]);
  try {
    await unlink(claimPath);
    await rmdir(lockPath);
  } catch {
    lockAmbiguous();
  }
}

function assertOwnerlessStale(modifiedAtNs: bigint, nowNs: bigint): void {
  if (
    modifiedAtNs < 0n ||
    nowNs < modifiedAtNs ||
    nowNs - modifiedAtNs < OWNERLESS_STALE_AFTER_NS
  ) {
    lockAmbiguous();
  }
}

async function removeExactClaimFile(options: {
  readonly acquire: AcquireInstanceLockOptions;
  readonly directory: OpenedDirectory;
  readonly claimPath: string;
  readonly claim: OpenedClaim;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
  readonly removeDirectory: boolean;
}): Promise<void> {
  const { acquire, claim, claimPath, directory, isCurrentUser, removeDirectory, runtimeIdentity } =
    options;
  const current = await readPrivateClaim(claimPath, isCurrentUser);
  if (current === undefined || !sameClaim(current, claim)) lockAmbiguous();
  await assertRemovalContext({
    lockPath: acquire.lockPath,
    directory,
    isCurrentUser,
    runtimeIdentity,
  });
  await exactEntries(acquire.lockPath, [path.basename(claimPath)]);
  try {
    await unlink(claimPath);
    if (removeDirectory) await rmdir(acquire.lockPath);
  } catch {
    lockAmbiguous();
  }
}

async function reclaimOwnerlessLock(options: {
  readonly acquire: AcquireInstanceLockOptions;
  readonly directory: OpenedDirectory;
  readonly nowNs: bigint;
  readonly claimant: ServiceLockV1;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
  readonly hooks?: InstanceLockOperationHooks;
}): Promise<void> {
  const { acquire, claimant, directory, hooks, isCurrentUser, nowNs, runtimeIdentity } = options;
  await exactEntries(acquire.lockPath, []);
  assertOwnerlessStale(directory.modifiedAtNs, nowNs);
  const claimantCreatedAt = ownerTimestampNs(claimant);
  if (directory.modifiedAtNs > claimantCreatedAt) lockAmbiguous();
  await assertRemovalContext({
    lockPath: acquire.lockPath,
    directory,
    isCurrentUser,
    runtimeIdentity,
  });

  const sentinelPath = path.join(
    acquire.lockPath,
    ownerlessSentinelName(claimant.service_instance_id),
  );
  const sentinelDocument = ownerlessClaimDocument(claimant, directory.modifiedAtNs);
  const sentinelBytes = Buffer.from(canonicalJson(sentinelDocument), "utf8");
  const validatedSentinel = parseCanonicalClaim(sentinelBytes);
  const sentinelIdentity = await publishCanonicalDocument({
    kind: "ownerless-claim",
    finalPath: sentinelPath,
    bytes: sentinelBytes,
    claimant,
    ownerlessSinceNs: directory.modifiedAtNs,
    lockPath: acquire.lockPath,
    directory,
    expectedEntries: [],
    isCurrentUser,
    runtimeIdentity,
    ...(hooks === undefined ? {} : { hooks }),
  });
  const sentinel: OpenedClaim = { claim: validatedSentinel, identity: sentinelIdentity };
  await runOperationHook(hooks?.afterOwnerlessSentinelCreate);
  assertOwnerlessStale(directory.modifiedAtNs, nowNs);
  await assertRemovalContext({
    lockPath: acquire.lockPath,
    directory,
    isCurrentUser,
    runtimeIdentity,
  });
  await exactEntries(acquire.lockPath, [path.basename(sentinelPath)]);

  let socketIdentity: string | null;
  try {
    socketIdentity = await identifySocket(() => acquire.socketProbe, acquire.socketPath);
  } catch (error) {
    await removeExactClaimFile({
      acquire,
      directory,
      claimPath: sentinelPath,
      claim: sentinel,
      isCurrentUser,
      runtimeIdentity,
      removeDirectory: false,
    });
    throw error;
  }
  if (socketIdentity !== null) {
    await removeExactClaimFile({
      acquire,
      directory,
      claimPath: sentinelPath,
      claim: sentinel,
      isCurrentUser,
      runtimeIdentity,
      removeDirectory: false,
    });
    lockAmbiguous();
  }

  await removeExactClaimFile({
    acquire,
    directory,
    claimPath: sentinelPath,
    claim: sentinel,
    isCurrentUser,
    runtimeIdentity,
    removeDirectory: true,
  });
}

type ClaimState =
  | {
      readonly kind: "owner";
      readonly claimName: string;
      readonly displacedName?: string;
      readonly ownerPresent: boolean;
    }
  | { readonly kind: "ownerless"; readonly claimName: string };

interface StageState {
  readonly descriptor: StageDescriptor;
  readonly finalName?: string;
}

function looksLikeStage(name: string): boolean {
  return (
    name.startsWith(stagePrefix("owner")) ||
    name.startsWith(stagePrefix("owner-claim")) ||
    name.startsWith(stagePrefix("ownerless-claim"))
  );
}

function classifyStageState(entries: readonly string[]): StageState | undefined {
  const stageEntries = entries.filter(looksLikeStage);
  if (stageEntries.length === 0) return undefined;
  if (stageEntries.length !== 1) lockAmbiguous();
  const descriptor = parseStageDescriptor(stageEntries[0]!);
  if (descriptor === undefined) lockAmbiguous();
  let expected: string[];
  let finalName: string | undefined;
  if (descriptor.kind === "owner") {
    finalName = entries.includes(OWNER_FILE_NAME) ? OWNER_FILE_NAME : undefined;
    expected = [descriptor.name, ...(finalName === undefined ? [] : [finalName])];
  } else if (descriptor.kind === "owner-claim") {
    const claimName = ownerClaimName(descriptor.claimant.service_instance_id);
    finalName = entries.includes(claimName) ? claimName : undefined;
    expected = [OWNER_FILE_NAME, descriptor.name, ...(finalName === undefined ? [] : [finalName])];
  } else {
    const claimName = ownerlessSentinelName(descriptor.claimant.service_instance_id);
    finalName = entries.includes(claimName) ? claimName : undefined;
    expected = [descriptor.name, ...(finalName === undefined ? [] : [finalName])];
  }
  const sortedExpected = expected.sort();
  if (
    entries.length !== sortedExpected.length ||
    entries.some((entry, index) => entry !== sortedExpected[index])
  ) {
    lockAmbiguous();
  }
  return { descriptor, ...(finalName === undefined ? {} : { finalName }) };
}

function isExactPrefix(actual: Uint8Array, expected: Uint8Array): boolean {
  return (
    actual.byteLength <= expected.byteLength &&
    Buffer.from(actual).equals(Buffer.from(expected).subarray(0, actual.byteLength))
  );
}

async function recoverDocumentStage(options: {
  readonly acquire: AcquireInstanceLockOptions;
  readonly directory: OpenedDirectory;
  readonly state: StageState;
  readonly nowNs: bigint;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
}): Promise<"retry" | "reclaimed"> {
  const { acquire, directory, isCurrentUser, nowNs, runtimeIdentity, state } = options;
  const { descriptor, finalName } = state;
  const stagePath = path.join(acquire.lockPath, descriptor.name);
  const stage = await readPrivateBytes(stagePath, isCurrentUser);
  if (stage === undefined) lockAmbiguous();
  const claimantCreatedAt = ownerTimestampNs(descriptor.claimant);
  if (claimantCreatedAt > nowNs) lockAmbiguous();

  let expectedBytes: Uint8Array;
  let original: OpenedOwner | undefined;
  if (descriptor.kind === "owner") {
    expectedBytes = Buffer.from(canonicalJson(descriptor.claimant), "utf8");
  } else if (descriptor.kind === "owner-claim") {
    original = await readPrivateOwner(path.join(acquire.lockPath, OWNER_FILE_NAME), isCurrentUser);
    if (original === undefined || ownerTimestampNs(original.owner) > claimantCreatedAt) {
      lockAmbiguous();
    }
    expectedBytes = Buffer.from(
      canonicalJson(ownerClaimDocument(descriptor.claimant, original.owner)),
      "utf8",
    );
    parseCanonicalClaim(expectedBytes);
  } else {
    if (descriptor.ownerlessSinceNs === undefined) lockAmbiguous();
    assertOwnerlessStale(descriptor.ownerlessSinceNs, nowNs);
    if (descriptor.ownerlessSinceNs > claimantCreatedAt) lockAmbiguous();
    expectedBytes = Buffer.from(
      canonicalJson(ownerlessClaimDocument(descriptor.claimant, descriptor.ownerlessSinceNs)),
      "utf8",
    );
    parseCanonicalClaim(expectedBytes);
  }
  if (!isExactPrefix(stage.bytes, expectedBytes)) lockAmbiguous();

  let published: OpenedStage | undefined;
  if (finalName !== undefined) {
    published = await readPrivateBytes(path.join(acquire.lockPath, finalName), isCurrentUser);
    if (
      published === undefined ||
      !fileIdentityMatches(published.identity, stage.identity) ||
      !Buffer.from(published.bytes).equals(Buffer.from(expectedBytes))
    ) {
      lockAmbiguous();
    }
  }
  assertDeadClaimProcess(acquire, descriptor.claimant);
  if ((await identifySocket(() => acquire.socketProbe, acquire.socketPath)) !== null) {
    lockAmbiguous();
  }

  const currentStage = await readPrivateBytes(stagePath, isCurrentUser);
  if (currentStage === undefined || !sameStage(currentStage, stage)) lockAmbiguous();
  if (original !== undefined) {
    const currentOriginal = await readPrivateOwner(
      path.join(acquire.lockPath, OWNER_FILE_NAME),
      isCurrentUser,
    );
    if (currentOriginal === undefined || !sameOwner(currentOriginal, original)) lockAmbiguous();
  }
  if (finalName !== undefined && published !== undefined) {
    const currentPublished = await readPrivateBytes(
      path.join(acquire.lockPath, finalName),
      isCurrentUser,
    );
    if (currentPublished === undefined || !sameStage(currentPublished, published)) lockAmbiguous();
  }
  await assertRemovalContext({
    lockPath: acquire.lockPath,
    directory,
    isCurrentUser,
    runtimeIdentity,
  });
  const expectedEntries = [descriptor.name];
  if (descriptor.kind === "owner-claim") expectedEntries.push(OWNER_FILE_NAME);
  if (finalName !== undefined) expectedEntries.push(finalName);
  await exactEntries(acquire.lockPath, expectedEntries);
  try {
    await unlink(stagePath);
    await directory.handle.sync();
  } catch {
    lockAmbiguous();
  }

  if (finalName !== undefined || descriptor.kind === "owner-claim") return "retry";
  try {
    await rmdir(acquire.lockPath);
  } catch {
    lockAmbiguous();
  }
  return "reclaimed";
}

function classifyClaimState(entries: readonly string[]): ClaimState | "owner" | "ownerless" {
  if (entries.length === 0) return "ownerless";
  if (entries.length === 1 && entries[0] === OWNER_FILE_NAME) return "owner";
  if (entries.length === 1) {
    const ownerless = OWNERLESS_CLAIM_PATTERN.exec(entries[0]!);
    if (ownerless !== null) return { kind: "ownerless", claimName: entries[0]! };
    const owner = OWNER_CLAIM_PATTERN.exec(entries[0]!);
    if (owner !== null) return { kind: "owner", claimName: entries[0]!, ownerPresent: false };
  }
  const claimName = entries.find((entry) => OWNER_CLAIM_PATTERN.test(entry));
  if (claimName !== undefined) {
    const match = OWNER_CLAIM_PATTERN.exec(claimName);
    if (match === null) lockAmbiguous();
    const displacedName = displacedOwnerName(match[1]!);
    if (entries.length === 2 && entries.includes(OWNER_FILE_NAME)) {
      return { kind: "owner", claimName, ownerPresent: true };
    }
    if (entries.length === 2 && entries.includes(displacedName)) {
      return { kind: "owner", claimName, displacedName, ownerPresent: false };
    }
  }
  lockAmbiguous();
}

function assertDeadClaimProcess(acquire: AcquireInstanceLockOptions, owner: ServiceLockV1): void {
  if (processLiveness(() => acquire.processProbe, owner.pid) !== "dead") lockAmbiguous();
}

function ownerTimestampNs(owner: ServiceLockV1): bigint {
  const timestamp = Date.parse(owner.created_at);
  if (!Number.isSafeInteger(timestamp)) lockAmbiguous();
  return BigInt(timestamp) * 1_000_000n;
}

async function recoverOwnerClaim(options: {
  readonly acquire: AcquireInstanceLockOptions;
  readonly directory: OpenedDirectory;
  readonly state: Extract<ClaimState, { kind: "owner" }>;
  readonly nowNs: bigint;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
}): Promise<"retry" | "reclaimed"> {
  const { acquire, directory, isCurrentUser, nowNs, runtimeIdentity, state } = options;
  const claimPath = path.join(acquire.lockPath, state.claimName);
  const claim = await readPrivateClaim(claimPath, isCurrentUser);
  if (
    claim === undefined ||
    claim.claim.claim_kind !== "owner" ||
    claim.claim.original_owner === null
  ) {
    lockAmbiguous();
  }
  if (ownerClaimName(claim.claim.claimant.service_instance_id) !== state.claimName) lockAmbiguous();
  const claimantCreatedAt = ownerTimestampNs(claim.claim.claimant);
  if (
    claimantCreatedAt > nowNs ||
    ownerTimestampNs(claim.claim.original_owner) > claimantCreatedAt
  ) {
    lockAmbiguous();
  }

  let originalPath: string | undefined;
  let original: OpenedOwner | undefined;
  if (state.ownerPresent) originalPath = path.join(acquire.lockPath, OWNER_FILE_NAME);
  else if (state.displacedName !== undefined) {
    originalPath = path.join(acquire.lockPath, state.displacedName);
  }
  if (originalPath !== undefined) {
    original = await readPrivateOwner(originalPath, isCurrentUser);
    if (original === undefined || !sameOwnerDocument(original.owner, claim.claim.original_owner)) {
      lockAmbiguous();
    }
  }

  assertDeadClaimProcess(acquire, claim.claim.claimant);
  assertDeadClaimProcess(acquire, claim.claim.original_owner);
  if ((await identifySocket(() => acquire.socketProbe, acquire.socketPath)) !== null)
    lockAmbiguous();

  const currentClaim = await readPrivateClaim(claimPath, isCurrentUser);
  if (currentClaim === undefined || !sameClaim(currentClaim, claim)) lockAmbiguous();
  if (originalPath !== undefined && original !== undefined) {
    const currentOriginal = await readPrivateOwner(originalPath, isCurrentUser);
    if (currentOriginal === undefined || !sameOwner(currentOriginal, original)) lockAmbiguous();
  }
  await assertRemovalContext({
    lockPath: acquire.lockPath,
    directory,
    isCurrentUser,
    runtimeIdentity,
  });
  const expected = [state.claimName];
  if (state.ownerPresent) expected.push(OWNER_FILE_NAME);
  else if (state.displacedName !== undefined) expected.push(state.displacedName);
  await exactEntries(acquire.lockPath, expected);

  if (state.ownerPresent) {
    try {
      await unlink(claimPath);
    } catch {
      lockAmbiguous();
    }
    return "retry";
  }
  if (originalPath !== undefined) {
    try {
      await unlink(originalPath);
    } catch {
      lockAmbiguous();
    }
    const finalClaim = await readPrivateClaim(claimPath, isCurrentUser);
    if (finalClaim === undefined || !sameClaim(finalClaim, claim)) lockAmbiguous();
    await assertRemovalContext({
      lockPath: acquire.lockPath,
      directory,
      isCurrentUser,
      runtimeIdentity,
    });
    await exactEntries(acquire.lockPath, [state.claimName]);
  }
  try {
    await unlink(claimPath);
    await rmdir(acquire.lockPath);
  } catch {
    lockAmbiguous();
  }
  return "reclaimed";
}

async function recoverOwnerlessClaim(options: {
  readonly acquire: AcquireInstanceLockOptions;
  readonly directory: OpenedDirectory;
  readonly state: Extract<ClaimState, { kind: "ownerless" }>;
  readonly nowNs: bigint;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
}): Promise<void> {
  const { acquire, directory, isCurrentUser, nowNs, runtimeIdentity, state } = options;
  const claimPath = path.join(acquire.lockPath, state.claimName);
  const claim = await readPrivateClaim(claimPath, isCurrentUser);
  if (
    claim === undefined ||
    claim.claim.claim_kind !== "ownerless" ||
    claim.claim.ownerless_since_ns === null ||
    ownerlessSentinelName(claim.claim.claimant.service_instance_id) !== state.claimName
  ) {
    lockAmbiguous();
  }
  assertOwnerlessStale(BigInt(claim.claim.ownerless_since_ns), nowNs);
  const claimantCreatedAt = ownerTimestampNs(claim.claim.claimant);
  if (claimantCreatedAt > nowNs || BigInt(claim.claim.ownerless_since_ns) > claimantCreatedAt) {
    lockAmbiguous();
  }
  assertDeadClaimProcess(acquire, claim.claim.claimant);
  if ((await identifySocket(() => acquire.socketProbe, acquire.socketPath)) !== null)
    lockAmbiguous();
  await removeExactClaimFile({
    acquire,
    directory,
    claimPath,
    claim,
    isCurrentUser,
    runtimeIdentity,
    removeDirectory: true,
  });
}

async function inspectAndReclaim(options: {
  readonly acquire: AcquireInstanceLockOptions;
  readonly ownerPath: string;
  readonly nowNs: bigint;
  readonly claimant: ServiceLockV1;
  readonly isCurrentUser: CurrentUserCheck;
  readonly runtimeIdentity: FileIdentity;
  readonly hooks?: InstanceLockOperationHooks;
}): Promise<void> {
  const { acquire, claimant, hooks, isCurrentUser, nowNs, ownerPath, runtimeIdentity } = options;
  const directory = await openPrivateDirectory(acquire.lockPath, isCurrentUser);
  if (directory === undefined) lockAmbiguous();
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let entries: string[];
      try {
        entries = (await readdir(acquire.lockPath)).sort();
      } catch {
        lockAmbiguous();
      }
      const stageState = classifyStageState(entries);
      if (stageState !== undefined) {
        const recovery = await recoverDocumentStage({
          acquire,
          directory,
          state: stageState,
          nowNs,
          isCurrentUser,
          runtimeIdentity,
        });
        if (recovery === "reclaimed") return;
        continue;
      }
      const state = classifyClaimState(entries);
      if (state === "ownerless") {
        await reclaimOwnerlessLock({
          acquire,
          directory,
          nowNs,
          claimant,
          isCurrentUser,
          runtimeIdentity,
          ...(hooks === undefined ? {} : { hooks }),
        });
        return;
      }
      if (state === "owner") {
        const owner = await readPrivateOwner(ownerPath, isCurrentUser);
        if (owner === undefined) lockAmbiguous();
        const liveness = processLiveness(() => acquire.processProbe, owner.owner.pid);
        if (liveness === "unknown") lockAmbiguous();
        if (liveness === "alive") {
          if (owner.owner.executable_hash === acquire.executableHash) alreadyRunning();
          lockAmbiguous();
        }
        const socketIdentity = await identifySocket(() => acquire.socketProbe, acquire.socketPath);
        if (socketIdentity === owner.owner.service_instance_id) alreadyRunning();
        if (socketIdentity !== null) lockAmbiguous();
        const claimed = await claimOwnerForRemoval({
          operation: "reclaim",
          lockPath: acquire.lockPath,
          ownerPath,
          directory,
          owner,
          claimant,
          isCurrentUser,
          runtimeIdentity,
          ...(hooks === undefined ? {} : { hooks }),
        });
        await removeClaimedLock({
          lockPath: acquire.lockPath,
          directory,
          isCurrentUser,
          runtimeIdentity,
          ...claimed,
        });
        return;
      }
      if (state.kind === "ownerless") {
        await recoverOwnerlessClaim({
          acquire,
          directory,
          state,
          nowNs,
          isCurrentUser,
          runtimeIdentity,
        });
        return;
      }
      const recovery = await recoverOwnerClaim({
        acquire,
        directory,
        state,
        nowNs,
        isCurrentUser,
        runtimeIdentity,
      });
      if (recovery === "reclaimed") return;
    }
    lockAmbiguous();
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
  readonly hooks?: InstanceLockOperationHooks;
}): Promise<AcquiredIdentity | "existing"> {
  const { acquire, hooks, isCurrentUser, ownerBytes, ownerPath, runtimeIdentity } = options;
  try {
    await mkdir(acquire.lockPath, { mode: 0o700 });
  } catch (error) {
    if (isExisting(error)) return "existing";
    servicePathUnsafe();
  }

  let directory: OpenedDirectory | undefined;
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
    const owner = parseCanonicalOwner(ownerBytes);
    const ownerIdentity = await publishCanonicalDocument({
      kind: "owner",
      finalPath: ownerPath,
      bytes: ownerBytes,
      claimant: owner,
      lockPath: acquire.lockPath,
      directory,
      expectedEntries: [],
      isCurrentUser,
      runtimeIdentity,
      ...(hooks === undefined ? {} : { hooks }),
    });
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
  readonly isRootUser: RootUserCheck;
  readonly hooks?: InstanceLockOperationHooks;
}): Promise<void> {
  const { acquiredIdentity, expectedOwner, hooks, isCurrentUser, isRootUser, lockPath, ownerPath } =
    options;
  const runtimePath = path.dirname(lockPath);
  const runtimeIdentity = await assertPrivateRuntimePath(runtimePath, isCurrentUser, isRootUser);
  const directory = await openPrivateDirectory(lockPath, isCurrentUser, true);
  if (directory === undefined) return;
  try {
    if (!fileIdentityMatches(directory.identity, acquiredIdentity.directory)) return;
    const owner = await readPrivateOwner(ownerPath, isCurrentUser);
    if (owner === undefined) return;
    const expectedOpenedOwner: OpenedOwner = {
      owner: expectedOwner,
      identity: acquiredIdentity.owner,
    };
    if (owner.owner.service_instance_id !== expectedOwner.service_instance_id) return;
    if (!sameOwner(owner, expectedOpenedOwner)) return;
    const claimed = await claimOwnerForRemoval({
      operation: "release",
      lockPath,
      ownerPath,
      directory,
      owner,
      claimant: expectedOwner,
      isCurrentUser,
      runtimeIdentity,
      ...(hooks === undefined ? {} : { hooks }),
    });
    await removeClaimedLock({
      lockPath,
      directory,
      isCurrentUser,
      runtimeIdentity,
      ...claimed,
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
  const isRootUser = options.isRootUser ?? defaultRootUserCheck;
  const runtimeIdentity = await assertPrivateRuntimePath(runtimePath, isCurrentUser, isRootUser);

  let createdAt: string;
  let nowNs: bigint;
  try {
    const current = options.now();
    const numericNow = current.getTime();
    if (!Number.isSafeInteger(numericNow)) lockAmbiguous();
    nowNs = BigInt(numericNow) * 1_000_000n;
    createdAt = current.toISOString();
  } catch {
    lockAmbiguous();
  }

  const { owner, bytes: ownerBytes } = createOwnerDocument(options, createdAt);
  const ownerPath = path.join(options.lockPath, OWNER_FILE_NAME);
  const operationHooks = readOperationHooks(options);

  let acquiredIdentity = await createClaim({
    acquire: options,
    ownerBytes,
    ownerPath,
    isCurrentUser,
    runtimeIdentity,
    ...(operationHooks === undefined ? {} : { hooks: operationHooks }),
  });
  if (acquiredIdentity === "existing") {
    await inspectAndReclaim({
      acquire: options,
      ownerPath,
      nowNs,
      claimant: owner,
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
      ...(operationHooks === undefined ? {} : { hooks: operationHooks }),
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
          isRootUser,
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
