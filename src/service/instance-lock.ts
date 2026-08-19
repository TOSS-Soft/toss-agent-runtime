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
  readonly afterOwnerClaimRename?: (operation: "reclaim" | "release") => Promise<void>;
  readonly afterOwnerlessSentinelCreate?: () => Promise<void>;
}

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

const OWNER_FILE_NAME = "owner.json";
const OWNERLESS_STALE_AFTER_NS = 30_000_000_000n;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OWNER_CLAIM_PATTERN = new RegExp(`^\\.owner-claim\\.(${UUID_PATTERN})\\.json$`);
const OWNERLESS_CLAIM_PATTERN = new RegExp(`^\\.ownerless-reclaim\\.(${UUID_PATTERN})\\.json$`);
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

async function writePrivateClaim(
  claimPath: string,
  claim: LockClaimV1,
  isCurrentUser: CurrentUserCheck,
): Promise<OpenedClaim> {
  const bytes = Buffer.from(canonicalJson(claim), "utf8");
  const validated = parseCanonicalClaim(bytes);
  if (bytes.byteLength > MAX_CONTROL_MESSAGE_BYTES) lockAmbiguous();
  let handle: FileHandle;
  try {
    handle = await open(
      claimPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    lockAmbiguous();
  }
  let identity: FileIdentity;
  try {
    const metadata = await handle.stat({ bigint: true });
    identity = identityOf(metadata);
    if (
      !metadata.isFile() ||
      !ownershipCheck(isCurrentUser, metadata.uid, claimPath) ||
      (metadata.mode & 0o777n) !== 0o600n
    ) {
      servicePathUnsafe();
    }
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertCurrentIdentity(claimPath, identity, "file", 0o600, isCurrentUser, true);
  return { claim: validated, identity };
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

  await exactEntries(lockPath, [OWNER_FILE_NAME]);
  await assertRemovalContext({ lockPath, directory, isCurrentUser, runtimeIdentity });
  const claim = await writePrivateClaim(
    claimPath,
    ownerClaimDocument(claimant, owner.owner),
    isCurrentUser,
  );
  try {
    await directory.handle.sync();
  } catch {
    lockAmbiguous();
  }
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
  const sentinel = await writePrivateClaim(
    sentinelPath,
    ownerlessClaimDocument(claimant, directory.modifiedAtNs),
    isCurrentUser,
  );
  try {
    await directory.handle.sync();
  } catch {
    lockAmbiguous();
  }
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let entries: string[];
      try {
        entries = (await readdir(acquire.lockPath)).sort();
      } catch {
        lockAmbiguous();
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
      const metadata = await ownerHandle.stat({ bigint: true });
      ownerIdentity = identityOf(metadata);
      if (
        !metadata.isFile() ||
        !ownershipCheck(isCurrentUser, metadata.uid, ownerPath) ||
        (metadata.mode & 0o777n) !== 0o600n
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
