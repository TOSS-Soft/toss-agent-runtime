import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, unlinkSync, type BigIntStats } from "node:fs";
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
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";

import { canonicalJson, parseJsonBytes, type JsonValue } from "../protocol/json.js";
import {
  MAX_CONTROL_MESSAGE_BYTES,
  parseServiceControlRequest,
  parseServiceControlResponse,
  type ServiceControlRequestV1,
  type ServiceControlResponseV1,
  type ServiceProjectDataV1,
  type ServiceProjectRequestV1,
  type ServiceSkillRequestV1,
  type ServiceStatusV1,
  type ServiceSuperpowersApproveRequestV1,
  type SuperpowersApprovalDataV1,
} from "./contracts.js";
import {
  isRuntimeServiceErrorCode,
  RuntimeServiceError,
  type RuntimeServiceErrorCode,
} from "./errors.js";
import {
  isServiceControlArtifactBasename,
  isServiceControlSocketClaimBasename,
  isServiceControlStagedArtifactBasename,
  isServiceSocketPlatform,
  serviceSocketLayoutFits,
} from "./paths.js";
import { RuntimeProjectError, type RuntimeProjectErrorCode } from "./project/errors.js";
import { RuntimeSkillError, type RuntimeSkillErrorCode } from "../skills/errors.js";

const RESPONSE_FRAME_BYTES = MAX_CONTROL_MESSAGE_BYTES + 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SOCKET_CLAIM_TOKEN_PATTERN = /^[0-9a-z]{10}$/u;
const MAX_SOCKET_CLAIMS = 1;
const internalServiceErrors = new WeakSet<RuntimeServiceError>();

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface CacheEntry {
  readonly requestHash: string;
  readonly response: string;
}

interface PendingCacheEntry {
  readonly requestHash: string;
  readonly response: Promise<string>;
}

export interface ServiceControlServer {
  listen(): Promise<void>;
  stopAccepting(): void;
  drain(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface CreateServiceControlServerOptions {
  readonly socketPath: string;
  readonly serviceInstanceId: string;
  readonly status: () => ServiceStatusV1;
  readonly idleTimeoutMs: 5_000;
  readonly maxConnections: 32;
  readonly cacheSize: 256;
  readonly handleProjectRequest?: (
    request: ServiceProjectRequestV1,
  ) => Promise<ServiceProjectDataV1>;
  readonly handleSkillRequest?: (
    request: ServiceSkillRequestV1,
  ) => Promise<SuperpowersApprovalDataV1>;
  /** @internal Deterministic current-platform seam for portable path-budget tests. */
  readonly socketPathPlatform?: "darwin" | "linux";
  /** @internal Deterministic Unix-socket ABI-budget seam for portable tests. */
  readonly socketPathByteLimit?: number;
  readonly classifyPathOwner?: PathOwnerClassifier;
  /** @internal Test seam for modeling the current process UID. */
  readonly currentUid?: () => number;
  readonly operationHooks?: ServiceControlOperationHooks;
}

export type PathOwner = "root" | "current-user" | "other";
export type PathOwnerClassifier = (userId: number, candidate: string) => PathOwner | number;

export interface ServiceControlOperationHooks {
  readonly beforePublish?: () => Promise<void>;
  /** @internal Test seam for modeling lossless runtime-directory identities. */
  readonly modelRuntimeIdentity?: (candidatePath: string, observed: FileIdentity) => FileIdentity;
  /** @internal Test seam for deterministic publication-guard races. */
  readonly afterPublicationGuardClaim?: (candidatePath: string, claimPath: string) => Promise<void>;
  /** @internal Test seam for deterministic native-close publication races. */
  readonly beforePublicationGuardCloseClaim?: (candidatePath: string) => Promise<void>;
  /** @internal Test seam for deterministic staged-socket replacement races. */
  readonly beforeStagedSocketUnlink?: (candidatePath: string) => Promise<void>;
  /** @internal Test seam for deterministic staged-socket parent revalidation. */
  readonly afterStagedSocketParentSync?: (candidatePath: string) => Promise<void>;
  /** @internal Test seam for deterministic socket-claim names. */
  readonly createSocketClaimToken?: () => string;
  /** @internal Test seam immediately before the controlled destination-absence check. */
  readonly beforeSocketClaimDestinationCheck?: (
    candidatePath: string,
    claimPath: string,
  ) => Promise<void>;
  /** @internal Test seam after a socket claim has been synced and revalidated. */
  readonly afterSocketClaimParentSync?: (candidatePath: string, claimPath: string) => Promise<void>;
  readonly onConnectionCountChanged?: (count: number) => void;
  readonly onConnectionClosed?: () => void;
}

export interface RequestServiceStatusOptions {
  readonly socketPath: string;
  readonly requestId?: string;
  readonly createRequestId?: () => string;
  readonly idleTimeoutMs?: 5_000;
}

export type ProjectControlOperation =
  | { readonly command: "project-register"; readonly root: string }
  | { readonly command: "project-unregister"; readonly project_id: string }
  | { readonly command: "project-list" };

export interface RequestProjectOperationOptions {
  readonly socketPath: string;
  readonly operation: ProjectControlOperation;
  readonly requestId?: string;
  readonly createRequestId?: () => string;
  readonly operationId?: string;
  readonly createOperationId?: () => string;
  readonly idleTimeoutMs?: 5_000;
}

export interface RequestSuperpowersApprovalDecisionOptions {
  readonly socketPath: string;
  readonly request: ServiceSuperpowersApproveRequestV1;
  readonly idleTimeoutMs?: 5_000;
}

export interface ProbeServiceIdentityOptions {
  readonly socketPath: string;
  readonly createRequestId?: () => string;
  readonly idleTimeoutMs?: 5_000;
}

function serviceError(code: RuntimeServiceErrorCode): RuntimeServiceError {
  const error = new RuntimeServiceError(code);
  internalServiceErrors.add(error);
  return error;
}

function pathUnsafe(): never {
  throw serviceError("RUNTIME_SERVICE_PATH_UNSAFE");
}

function unavailable(): never {
  throw serviceError("RUNTIME_SERVICE_UNAVAILABLE");
}

function controlInvalid(): never {
  throw serviceError("RUNTIME_SERVICE_CONTROL_INVALID");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function processCurrentUid(): number {
  if (typeof process.getuid !== "function") pathUnsafe();
  return process.getuid();
}

function defaultPathOwner(userId: number, currentUid: number): PathOwner {
  if (userId === currentUid) return "current-user";
  if (userId === 0) return "root";
  return "other";
}

function classifyPathOwner(
  classifier: PathOwnerClassifier | undefined,
  currentUid: (() => number) | undefined,
  userId: number,
  candidate: string,
  leadingAncestor = false,
): PathOwner {
  try {
    const classified = classifier?.(userId, candidate) ?? userId;
    const owner =
      typeof classified === "number"
        ? leadingAncestor && classified === 0
          ? "root"
          : defaultPathOwner(classified, (currentUid ?? processCurrentUid)())
        : classified;
    if (owner !== "root" && owner !== "current-user" && owner !== "other") pathUnsafe();
    return owner;
  } catch (error) {
    if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
    return pathUnsafe();
  }
}

function identityOf(metadata: { readonly dev: bigint; readonly ino: bigint }): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function safeUserId(userId: bigint): number {
  if (userId < 0n || userId > BigInt(Number.MAX_SAFE_INTEGER)) pathUnsafe();
  return Number(userId);
}

async function lstatBigInt(candidate: string): Promise<BigIntStats> {
  return lstat(candidate, { bigint: true });
}

function runtimeIdentityOf(
  metadata: BigIntStats,
  candidate: string,
  model?: ServiceControlOperationHooks["modelRuntimeIdentity"],
): FileIdentity {
  const observed = identityOf(metadata);
  if (model === undefined) return observed;
  try {
    const modeled = model(candidate, observed);
    if (typeof modeled.device !== "bigint" || typeof modeled.inode !== "bigint") pathUnsafe();
    return { device: modeled.device, inode: modeled.inode };
  } catch (error) {
    if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
    return pathUnsafe();
  }
}

function assertSocketPath(candidate: string): void {
  if (
    !path.isAbsolute(candidate) ||
    candidate === path.parse(candidate).root ||
    path.basename(candidate).length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    pathUnsafe();
  }
}

function assertServiceSocketLayout(options: CreateServiceControlServerOptions): void {
  assertSocketPath(options.socketPath);
  const platform = options.socketPathPlatform ?? process.platform;
  if (!isServiceSocketPlatform(platform)) unavailable();
  if (
    !serviceSocketLayoutFits({
      socketPath: options.socketPath,
      platform,
      ...(options.socketPathByteLimit === undefined
        ? {}
        : { pathByteLimit: options.socketPathByteLimit }),
    })
  ) {
    pathUnsafe();
  }
}

async function assertPrivateRuntimeDirectory(
  socketPath: string,
  classifier?: PathOwnerClassifier,
  currentUid?: () => number,
  modelRuntimeIdentity?: ServiceControlOperationHooks["modelRuntimeIdentity"],
): Promise<FileIdentity> {
  assertSocketPath(socketPath);
  const runtimePath = path.dirname(socketPath);
  const parsed = path.parse(runtimePath);
  const relative = runtimePath.slice(parsed.root.length);
  const segments = relative.length === 0 ? [] : relative.split(path.sep);
  const candidates = [parsed.root];
  let current = parsed.root;
  let reachedCurrentUserDirectory = false;

  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") pathUnsafe();
    current = path.join(current, segment);
    candidates.push(current);
  }

  let runtimeIdentity: FileIdentity | undefined;
  for (const [index, candidate] of candidates.entries()) {
    let metadata;
    try {
      metadata = await lstatBigInt(candidate);
    } catch {
      pathUnsafe();
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) pathUnsafe();

    const owner = classifyPathOwner(
      classifier,
      currentUid,
      safeUserId(metadata.uid),
      candidate,
      index !== candidates.length - 1,
    );
    if (owner === "root" && !reachedCurrentUserDirectory) {
      if ((metadata.mode & 0o022n) !== 0n && (metadata.mode & 0o1000n) === 0n) pathUnsafe();
    } else if (owner === "current-user") {
      if ((metadata.mode & 0o022n) !== 0n) pathUnsafe();
      reachedCurrentUserDirectory = true;
    } else {
      pathUnsafe();
    }
    if (
      index === candidates.length - 1 &&
      (owner !== "current-user" || (metadata.mode & 0o777n) !== 0o700n)
    ) {
      pathUnsafe();
    }
    if (index === candidates.length - 1) {
      runtimeIdentity = runtimeIdentityOf(metadata, candidate, modelRuntimeIdentity);
    }
  }
  if (segments.length === 0 || runtimeIdentity === undefined) pathUnsafe();
  return runtimeIdentity;
}

function publicationGuardName(serviceInstanceId: string): string {
  return `.c${createHash("sha256").update(serviceInstanceId, "utf8").digest("hex")}`;
}

function stagedSocketName(serviceInstanceId: string): string {
  const entropy = BigInt(
    `0x${createHash("sha256").update(serviceInstanceId, "utf8").digest("hex")}`,
  );
  const token = (entropy % 36n ** 10n).toString(36).padStart(10, "0");
  return `.s${token}`;
}

function identityBoundSocketClaimToken(identity: FileIdentity, variant: "0" | "1"): string {
  const entropy = BigInt(
    `0x${createHash("sha256")
      .update(identity.device.toString(), "utf8")
      .update("\u0000", "utf8")
      .update(identity.inode.toString(), "utf8")
      .update("\u0000", "utf8")
      .update(variant, "utf8")
      .digest("hex")}`,
  );
  return (entropy % 36n ** 10n).toString(36).padStart(10, "0");
}

function socketClaimToken(
  candidatePath: string,
  expected: FileIdentity,
  hooks?: ServiceControlOperationHooks,
): string {
  try {
    const supplied = hooks?.createSocketClaimToken?.();
    if (supplied !== undefined) {
      if (!SOCKET_CLAIM_TOKEN_PATTERN.test(supplied)) pathUnsafe();
      return supplied;
    }
    const first = identityBoundSocketClaimToken(expected, "0");
    const second = identityBoundSocketClaimToken(expected, "1");
    if (first === second) pathUnsafe();
    const candidateName = path.basename(candidatePath);
    const token = isServiceControlSocketClaimBasename(candidateName)
      ? candidateName === `.x${first}`
        ? second
        : candidateName === `.x${second}`
          ? first
          : pathUnsafe()
      : first;
    if (!SOCKET_CLAIM_TOKEN_PATTERN.test(token)) pathUnsafe();
    return token;
  } catch (error) {
    if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
    return pathUnsafe();
  }
}

function publicationClaimName(serviceInstanceId: string, candidateName: string): string {
  return `.r${createHash("sha256")
    .update(serviceInstanceId, "utf8")
    .update("\u0000", "utf8")
    .update(candidateName, "utf8")
    .digest("hex")}`;
}

async function requiredMetadata(candidate: string): Promise<BigIntStats> {
  try {
    return await lstatBigInt(candidate);
  } catch {
    return pathUnsafe();
  }
}

async function requiredEntries(candidate: string): Promise<readonly string[]> {
  try {
    return await readdir(candidate);
  } catch {
    return pathUnsafe();
  }
}

function assertPrivatePublicationGuard(
  metadata: BigIntStats,
  candidate: string,
  classifier: PathOwnerClassifier | undefined,
  currentUid: (() => number) | undefined,
  expectedIdentity?: FileIdentity,
): FileIdentity {
  const identity = identityOf(metadata);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    classifyPathOwner(classifier, currentUid, safeUserId(metadata.uid), candidate) !==
      "current-user" ||
    (metadata.mode & 0o777n) !== 0o700n ||
    (expectedIdentity !== undefined && !sameIdentity(identity, expectedIdentity))
  ) {
    pathUnsafe();
  }
  return identity;
}

async function inspectEmptyPublicationGuard(options: {
  readonly candidate: string;
  readonly classifier?: PathOwnerClassifier | undefined;
  readonly currentUid?: (() => number) | undefined;
}): Promise<FileIdentity> {
  const { candidate, classifier, currentUid } = options;
  const identity = assertPrivatePublicationGuard(
    await requiredMetadata(candidate),
    candidate,
    classifier,
    currentUid,
  );
  if ((await requiredEntries(candidate)).length !== 0) pathUnsafe();
  assertPrivatePublicationGuard(
    await requiredMetadata(candidate),
    candidate,
    classifier,
    currentUid,
    identity,
  );
  return identity;
}

async function assertUnchangedRuntimeDirectory(options: {
  readonly socketPath: string;
  readonly expected: FileIdentity;
  readonly classifier?: PathOwnerClassifier | undefined;
  readonly currentUid?: (() => number) | undefined;
  readonly modelRuntimeIdentity?: ServiceControlOperationHooks["modelRuntimeIdentity"] | undefined;
}): Promise<void> {
  const current = await assertPrivateRuntimeDirectory(
    options.socketPath,
    options.classifier,
    options.currentUid,
    options.modelRuntimeIdentity,
  );
  if (!sameIdentity(current, options.expected)) pathUnsafe();
}

async function removeClaimedPublicationGuard(options: {
  readonly claimPath: string;
  readonly expectedGuard: FileIdentity;
  readonly socketPath: string;
  readonly runtimeIdentity: FileIdentity;
  readonly classifier?: PathOwnerClassifier | undefined;
  readonly currentUid?: (() => number) | undefined;
  readonly modelRuntimeIdentity?: ServiceControlOperationHooks["modelRuntimeIdentity"] | undefined;
}): Promise<void> {
  const {
    claimPath,
    classifier,
    currentUid,
    expectedGuard,
    modelRuntimeIdentity,
    runtimeIdentity,
    socketPath,
  } = options;
  let handle;
  try {
    handle = await open(
      claimPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    pathUnsafe();
  }
  try {
    assertPrivatePublicationGuard(
      await handle.stat({ bigint: true }),
      claimPath,
      classifier,
      currentUid,
      expectedGuard,
    );
    if ((await requiredEntries(claimPath)).length !== 0) pathUnsafe();
    assertPrivatePublicationGuard(
      await requiredMetadata(claimPath),
      claimPath,
      classifier,
      currentUid,
      expectedGuard,
    );
    await assertUnchangedRuntimeDirectory({
      socketPath,
      expected: runtimeIdentity,
      classifier,
      currentUid,
      modelRuntimeIdentity,
    });
    assertPrivatePublicationGuard(
      await handle.stat({ bigint: true }),
      claimPath,
      classifier,
      currentUid,
      expectedGuard,
    );
    assertPrivatePublicationGuard(
      await requiredMetadata(claimPath),
      claimPath,
      classifier,
      currentUid,
      expectedGuard,
    );
    try {
      await rmdir(claimPath);
    } catch {
      pathUnsafe();
    }
  } finally {
    try {
      await handle.close();
    } catch {
      // The directory operation is already complete or failed closed.
    }
  }
}

async function reclaimStalePublicationGuards(options: {
  readonly socketPath: string;
  readonly serviceInstanceId: string;
  readonly runtimeIdentity: FileIdentity;
  readonly classifier?: PathOwnerClassifier | undefined;
  readonly currentUid?: (() => number) | undefined;
  readonly hooks?: ServiceControlOperationHooks | undefined;
}): Promise<void> {
  const { classifier, currentUid, hooks, runtimeIdentity, serviceInstanceId, socketPath } = options;
  const runtimePath = path.dirname(socketPath);
  const candidates = (await requiredEntries(runtimePath))
    .filter(isServiceControlArtifactBasename)
    .sort();

  for (const candidateName of candidates) {
    const candidatePath = path.join(runtimePath, candidateName);
    if (
      isServiceControlStagedArtifactBasename(candidateName) &&
      !(await requiredMetadata(candidatePath)).isDirectory()
    ) {
      continue;
    }
    const expectedGuard = await inspectEmptyPublicationGuard({
      candidate: candidatePath,
      classifier,
      currentUid,
    });
    await assertUnchangedRuntimeDirectory({
      socketPath,
      expected: runtimeIdentity,
      classifier,
      currentUid,
      modelRuntimeIdentity: hooks?.modelRuntimeIdentity,
    });

    const claimPath = path.join(
      runtimePath,
      publicationClaimName(serviceInstanceId, candidateName),
    );
    try {
      await lstatBigInt(claimPath);
      pathUnsafe();
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
        pathUnsafe();
      }
    }
    try {
      await rename(candidatePath, claimPath);
    } catch {
      pathUnsafe();
    }
    try {
      await hooks?.afterPublicationGuardClaim?.(candidatePath, claimPath);
    } catch {
      pathUnsafe();
    }
    await removeClaimedPublicationGuard({
      claimPath,
      expectedGuard,
      socketPath,
      runtimeIdentity,
      classifier,
      currentUid,
      modelRuntimeIdentity: hooks?.modelRuntimeIdentity,
    });
  }

  await assertUnchangedRuntimeDirectory({
    socketPath,
    expected: runtimeIdentity,
    classifier,
    currentUid,
    modelRuntimeIdentity: hooks?.modelRuntimeIdentity,
  });
  if ((await requiredEntries(runtimePath)).some(isServiceControlArtifactBasename)) pathUnsafe();
}

async function privateSocketIdentity(
  socketPath: string,
  classifier?: PathOwnerClassifier,
  currentUid?: () => number,
): Promise<FileIdentity | undefined> {
  let metadata;
  try {
    metadata = await lstatBigInt(socketPath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    pathUnsafe();
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isSocket() ||
    classifyPathOwner(classifier, currentUid, safeUserId(metadata.uid), socketPath) !==
      "current-user" ||
    (metadata.mode & 0o777n) !== 0o600n
  ) {
    pathUnsafe();
  }
  return identityOf(metadata);
}

async function socketHasListener(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    const finish = (listener: boolean, error?: RuntimeServiceError): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error === undefined) resolve(listener);
      else reject(error);
    };
    socket.setTimeout(5_000, () => finish(false, serviceError("RUNTIME_SERVICE_PATH_UNSAFE")));
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => {
      const code = errorCode(error);
      if (code === "ECONNREFUSED" || code === "ENOENT") finish(false);
      else finish(false, serviceError("RUNTIME_SERVICE_PATH_UNSAFE"));
    });
  });
}

async function assertRuntimeDirectoryHandle(options: {
  readonly handle: FileHandle;
  readonly socketPath: string;
  readonly expected: FileIdentity;
  readonly classifier?: PathOwnerClassifier | undefined;
  readonly currentUid?: (() => number) | undefined;
  readonly modelRuntimeIdentity?: ServiceControlOperationHooks["modelRuntimeIdentity"] | undefined;
}): Promise<void> {
  const runtimePath = path.dirname(options.socketPath);
  let metadata;
  try {
    metadata = await options.handle.stat({ bigint: true });
  } catch {
    pathUnsafe();
  }
  if (
    !metadata.isDirectory() ||
    classifyPathOwner(
      options.classifier,
      options.currentUid,
      safeUserId(metadata.uid),
      runtimePath,
    ) !== "current-user" ||
    (metadata.mode & 0o777n) !== 0o700n ||
    !sameIdentity(
      runtimeIdentityOf(metadata, runtimePath, options.modelRuntimeIdentity),
      options.expected,
    )
  ) {
    pathUnsafe();
  }
  await assertUnchangedRuntimeDirectory({
    socketPath: options.socketPath,
    expected: options.expected,
    classifier: options.classifier,
    currentUid: options.currentUid,
    modelRuntimeIdentity: options.modelRuntimeIdentity,
  });
}

async function openRuntimeDirectoryHandle(options: {
  readonly socketPath: string;
  readonly expected: FileIdentity;
  readonly classifier?: PathOwnerClassifier | undefined;
  readonly currentUid?: (() => number) | undefined;
  readonly modelRuntimeIdentity?: ServiceControlOperationHooks["modelRuntimeIdentity"] | undefined;
}): Promise<FileHandle> {
  let handle;
  try {
    handle = await open(
      path.dirname(options.socketPath),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    pathUnsafe();
  }
  try {
    await assertRuntimeDirectoryHandle({ handle, ...options });
    return handle;
  } catch (error) {
    await handle.close();
    if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
    pathUnsafe();
  }
}

async function requireMissing(candidatePath: string): Promise<void> {
  try {
    await lstatBigInt(candidatePath);
  } catch (error) {
    if (isMissing(error)) return;
    pathUnsafe();
  }
  pathUnsafe();
}

async function socketClaimNames(runtimePath: string): Promise<readonly string[]> {
  return (await requiredEntries(runtimePath)).filter(isServiceControlSocketClaimBasename).sort();
}

function unlinkExactPrivateSocketSync(options: {
  readonly candidatePath: string;
  readonly expected: FileIdentity;
  readonly classifier?: PathOwnerClassifier | undefined;
  readonly currentUid?: (() => number) | undefined;
}): void {
  let before: BigIntStats;
  try {
    before = lstatSync(options.candidatePath, { bigint: true });
  } catch {
    pathUnsafe();
  }
  if (
    before.isSymbolicLink() ||
    !before.isSocket() ||
    (before.mode & 0o777n) !== 0o600n ||
    !sameIdentity(identityOf(before), options.expected) ||
    classifyPathOwner(
      options.classifier,
      options.currentUid,
      safeUserId(before.uid),
      options.candidatePath,
    ) !== "current-user"
  ) {
    pathUnsafe();
  }

  let final: BigIntStats;
  try {
    final = lstatSync(options.candidatePath, { bigint: true });
  } catch {
    pathUnsafe();
  }
  if (
    final.isSymbolicLink() ||
    !final.isSocket() ||
    final.uid !== before.uid ||
    (final.mode & 0o777n) !== 0o600n ||
    !sameIdentity(identityOf(final), options.expected)
  ) {
    pathUnsafe();
  }
  try {
    // Keep the last exact identity check and unlink in one synchronous turn. POSIX
    // has no portable conditional unlink-by-inode primitive for Unix sockets.
    unlinkSync(options.candidatePath);
  } catch {
    pathUnsafe();
  }
}

async function claimAndRemoveStaleSocket(options: {
  readonly candidatePath: string;
  readonly socketPath: string;
  readonly runtimeIdentity: FileIdentity;
  readonly allowMissing: boolean;
  readonly staged: boolean;
  readonly classifier?: PathOwnerClassifier | undefined;
  readonly currentUid?: (() => number) | undefined;
  readonly hooks?: ServiceControlOperationHooks | undefined;
}): Promise<void> {
  const {
    allowMissing,
    candidatePath,
    classifier,
    currentUid,
    hooks,
    runtimeIdentity,
    socketPath,
    staged,
  } = options;
  const expected = await privateSocketIdentity(candidatePath, classifier, currentUid);
  if (expected === undefined) {
    if (allowMissing) return;
    pathUnsafe();
  }
  if (await socketHasListener(candidatePath)) {
    throw serviceError("RUNTIME_SERVICE_ALREADY_RUNNING");
  }
  await assertUnchangedRuntimeDirectory({
    socketPath,
    expected: runtimeIdentity,
    classifier,
    currentUid,
    modelRuntimeIdentity: hooks?.modelRuntimeIdentity,
  });
  const runtimeHandle = await openRuntimeDirectoryHandle({
    socketPath,
    expected: runtimeIdentity,
    classifier,
    currentUid,
    modelRuntimeIdentity: hooks?.modelRuntimeIdentity,
  });
  const runtimePath = path.dirname(socketPath);
  try {
    if (staged) {
      try {
        await hooks?.beforeStagedSocketUnlink?.(candidatePath);
      } catch {
        pathUnsafe();
      }
    }
    const claimPath = path.join(
      runtimePath,
      `.x${socketClaimToken(candidatePath, expected, hooks)}`,
    );
    try {
      await hooks?.beforeSocketClaimDestinationCheck?.(candidatePath, claimPath);
    } catch {
      pathUnsafe();
    }
    await requireMissing(claimPath);
    const current = await privateSocketIdentity(candidatePath, classifier, currentUid);
    if (current === undefined || !sameIdentity(current, expected)) pathUnsafe();
    await assertRuntimeDirectoryHandle({
      handle: runtimeHandle,
      socketPath,
      expected: runtimeIdentity,
      classifier,
      currentUid,
      modelRuntimeIdentity: hooks?.modelRuntimeIdentity,
    });
    try {
      await rename(candidatePath, claimPath);
    } catch {
      pathUnsafe();
    }

    let moved: FileIdentity | undefined;
    let movedFailure: unknown;
    try {
      moved = await privateSocketIdentity(claimPath, classifier, currentUid);
    } catch (error) {
      movedFailure = error;
    }
    try {
      await runtimeHandle.sync();
    } catch {
      pathUnsafe();
    }
    await assertRuntimeDirectoryHandle({
      handle: runtimeHandle,
      socketPath,
      expected: runtimeIdentity,
      classifier,
      currentUid,
      modelRuntimeIdentity: hooks?.modelRuntimeIdentity,
    });
    if (movedFailure !== undefined) {
      if (movedFailure instanceof RuntimeServiceError && internalServiceErrors.has(movedFailure)) {
        throw movedFailure;
      }
      pathUnsafe();
    }
    if (moved === undefined || !sameIdentity(moved, expected)) pathUnsafe();
    try {
      await hooks?.afterSocketClaimParentSync?.(candidatePath, claimPath);
    } catch {
      pathUnsafe();
    }
    if (staged) {
      try {
        await hooks?.afterStagedSocketParentSync?.(candidatePath);
      } catch {
        pathUnsafe();
      }
    }
    await assertRuntimeDirectoryHandle({
      handle: runtimeHandle,
      socketPath,
      expected: runtimeIdentity,
      classifier,
      currentUid,
      modelRuntimeIdentity: hooks?.modelRuntimeIdentity,
    });
    await requireMissing(candidatePath);
    const activeClaims = await socketClaimNames(runtimePath);
    if (activeClaims.length !== 1 || path.join(runtimePath, activeClaims[0]!) !== claimPath) {
      pathUnsafe();
    }
    if (await socketHasListener(claimPath)) {
      throw serviceError("RUNTIME_SERVICE_ALREADY_RUNNING");
    }
    const finalClaim = await privateSocketIdentity(claimPath, classifier, currentUid);
    if (finalClaim === undefined || !sameIdentity(finalClaim, expected)) pathUnsafe();
    await assertRuntimeDirectoryHandle({
      handle: runtimeHandle,
      socketPath,
      expected: runtimeIdentity,
      classifier,
      currentUid,
      modelRuntimeIdentity: hooks?.modelRuntimeIdentity,
    });
    unlinkExactPrivateSocketSync({
      candidatePath: claimPath,
      expected,
      classifier,
      currentUid,
    });
    try {
      await runtimeHandle.sync();
    } catch {
      pathUnsafe();
    }
    await assertRuntimeDirectoryHandle({
      handle: runtimeHandle,
      socketPath,
      expected: runtimeIdentity,
      classifier,
      currentUid,
      modelRuntimeIdentity: hooks?.modelRuntimeIdentity,
    });
    await requireMissing(claimPath);
    if ((await socketClaimNames(runtimePath)).length !== 0) pathUnsafe();
  } finally {
    try {
      await runtimeHandle.close();
    } catch {
      // The directory operation is already complete or failed closed.
    }
  }
}

async function reclaimStaleSocketClaims(options: {
  readonly socketPath: string;
  readonly runtimeIdentity: FileIdentity;
  readonly classifier?: PathOwnerClassifier | undefined;
  readonly currentUid?: (() => number) | undefined;
  readonly hooks?: ServiceControlOperationHooks | undefined;
}): Promise<void> {
  const claims = await socketClaimNames(path.dirname(options.socketPath));
  if (claims.length > MAX_SOCKET_CLAIMS) pathUnsafe();
  if (claims.length === 1) {
    await claimAndRemoveStaleSocket({
      candidatePath: path.join(path.dirname(options.socketPath), claims[0]!),
      allowMissing: false,
      staged: false,
      ...options,
    });
  }
}

async function removeStaleSocket(options: {
  readonly socketPath: string;
  readonly runtimeIdentity: FileIdentity;
  readonly classifier?: PathOwnerClassifier | undefined;
  readonly currentUid?: (() => number) | undefined;
  readonly hooks?: ServiceControlOperationHooks | undefined;
}): Promise<void> {
  await claimAndRemoveStaleSocket({
    candidatePath: options.socketPath,
    allowMissing: true,
    staged: false,
    ...options,
  });
}

async function reclaimStaleStagedSocket(options: {
  readonly candidatePath: string;
  readonly socketPath: string;
  readonly runtimeIdentity: FileIdentity;
  readonly classifier?: PathOwnerClassifier | undefined;
  readonly currentUid?: (() => number) | undefined;
  readonly hooks?: ServiceControlOperationHooks | undefined;
}): Promise<void> {
  await claimAndRemoveStaleSocket({
    allowMissing: false,
    staged: true,
    ...options,
  });
}

async function reclaimStaleStagedSockets(options: {
  readonly socketPath: string;
  readonly runtimeIdentity: FileIdentity;
  readonly classifier?: PathOwnerClassifier | undefined;
  readonly currentUid?: (() => number) | undefined;
  readonly hooks?: ServiceControlOperationHooks | undefined;
}): Promise<void> {
  const runtimePath = path.dirname(options.socketPath);
  const candidates = (await requiredEntries(runtimePath))
    .filter(isServiceControlStagedArtifactBasename)
    .sort();
  for (const candidateName of candidates) {
    const candidatePath = path.join(runtimePath, candidateName);
    if ((await requiredMetadata(candidatePath)).isDirectory()) continue;
    await reclaimStaleStagedSocket({ candidatePath, ...options });
  }
}

type ControlErrorCode = RuntimeServiceErrorCode | RuntimeProjectErrorCode | RuntimeSkillErrorCode;

function plainError(code: ControlErrorCode): Readonly<{
  code: ControlErrorCode;
  category: RuntimeServiceError["category"];
  retryable: boolean;
  safe_message: string;
}> {
  const error =
    code === "BLOCKED_SUPERPOWERS_MISSING" || code.startsWith("RUNTIME_SKILL_")
      ? new RuntimeSkillError(code as RuntimeSkillErrorCode)
      : code.startsWith("RUNTIME_PROJECT_") || code === "RUNTIME_OPERATION_CONFLICT"
        ? new RuntimeProjectError(code as RuntimeProjectErrorCode)
        : new RuntimeServiceError(code as RuntimeServiceErrorCode);
  return {
    code: error.code,
    category: error.category,
    retryable: error.retryable,
    safe_message: error.safe_message,
  };
}

function failureResponse(
  requestId: string | null,
  code: ControlErrorCode,
): ServiceControlResponseV1 {
  return {
    schema_version: "service-control-response.v1",
    document_type: "service-control-response",
    request_id: requestId,
    ok: false,
    status: null,
    data: null,
    error: plainError(code),
  };
}

function framedResponse(response: ServiceControlResponseV1): string {
  const framed = `${canonicalJson(response)}\n`;
  if (Buffer.byteLength(framed, "utf8") <= RESPONSE_FRAME_BYTES) return framed;
  return `${canonicalJson(failureResponse(response.request_id, "RUNTIME_SERVICE_UNAVAILABLE"))}\n`;
}

const INVALID_RESPONSE = framedResponse(failureResponse(null, "RUNTIME_SERVICE_CONTROL_INVALID"));

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatedRequestId(value: JsonValue): string | null {
  if (!isJsonObject(value)) return null;
  const requestId = value.request_id;
  return typeof requestId === "string" && UUID_PATTERN.test(requestId) ? requestId : null;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validatedSuccessResponse(
  options: CreateServiceControlServerOptions,
  requestId: string,
): ServiceControlResponseV1 | undefined {
  try {
    const status = options.status();
    if (status.service_instance_id !== options.serviceInstanceId) return undefined;
    const response: ServiceControlResponseV1 = {
      schema_version: "service-control-response.v1",
      document_type: "service-control-response",
      request_id: requestId,
      ok: true,
      status,
      data: null,
      error: null,
    };
    const parsed = parseServiceControlResponse(canonicalJson(response));
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

function validatedProjectResponse(
  request: ServiceProjectRequestV1,
  data: ServiceProjectDataV1,
): ServiceControlResponseV1 | undefined {
  try {
    if (
      (request.command === "project-list" && data.kind !== "project-list") ||
      (request.command !== "project-list" && data.kind !== "project-registration") ||
      (request.command === "project-register" &&
        data.kind === "project-registration" &&
        (data.registration.state !== "ACTIVE" ||
          data.registration.canonical_root !== request.root)) ||
      (request.command === "project-unregister" &&
        data.kind === "project-registration" &&
        (data.registration.state !== "UNREGISTERED" ||
          data.registration.project_id !== request.project_id.toLowerCase()))
    ) {
      return undefined;
    }
    const response: ServiceControlResponseV1 = {
      schema_version: "service-control-response.v1",
      document_type: "service-control-response",
      request_id: request.request_id,
      ok: true,
      status: null,
      data,
      error: null,
    };
    const parsed = parseServiceControlResponse(canonicalJson(response));
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

function validatedSkillResponse(
  request: ServiceSkillRequestV1,
  data: SuperpowersApprovalDataV1,
): ServiceControlResponseV1 | undefined {
  try {
    if (
      data.kind !== "superpowers-approval" ||
      data.run_id !== request.run_id ||
      data.phase !== request.phase ||
      data.approval_request_hash !== request.approval_request_hash ||
      data.state !== (request.decision === "APPROVE" ? "RUNNING" : "BLOCKED") ||
      data.journal_head.journal_revision !== request.expected_journal_revision + 1 ||
      data.journal_head.sequence !== request.expected_journal_revision + 1 ||
      data.journal_head.entry_hash === request.expected_journal_head_hash
    ) {
      return undefined;
    }
    const response: ServiceControlResponseV1 = {
      schema_version: "service-control-response.v1",
      document_type: "service-control-response",
      request_id: request.request_id,
      ok: true,
      status: null,
      data,
      error: null,
    };
    const parsed = parseServiceControlResponse(canonicalJson(response));
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

function canonicalProjectRequest(request: ServiceProjectRequestV1): ServiceProjectRequestV1 {
  if (request.command === "project-list") return request;
  if (request.command === "project-register") {
    return { ...request, operation_id: request.operation_id.toLowerCase() };
  }
  return {
    ...request,
    operation_id: request.operation_id.toLowerCase(),
    project_id: request.project_id.toLowerCase(),
  };
}

function canonicalSkillRequest(request: ServiceSkillRequestV1): ServiceSkillRequestV1 {
  return { ...request, operation_id: request.operation_id.toLowerCase() };
}

function safeOperationFailure(error: unknown): ControlErrorCode {
  if (error instanceof RuntimeSkillError) {
    try {
      return new RuntimeSkillError(error.code).code;
    } catch {
      return "RUNTIME_SERVICE_UNAVAILABLE";
    }
  }
  if (error instanceof RuntimeProjectError) {
    try {
      return new RuntimeProjectError(error.code).code;
    } catch {
      return "RUNTIME_SERVICE_UNAVAILABLE";
    }
  }
  if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) return error.code;
  return "RUNTIME_SERVICE_UNAVAILABLE";
}

function validatedConfiguration(options: CreateServiceControlServerOptions): boolean {
  return (
    options.idleTimeoutMs === 5_000 &&
    options.maxConnections === 32 &&
    options.cacheSize === 256 &&
    typeof options.status === "function" &&
    (options.handleProjectRequest === undefined ||
      typeof options.handleProjectRequest === "function") &&
    (options.handleSkillRequest === undefined ||
      typeof options.handleSkillRequest === "function") &&
    typeof options.serviceInstanceId === "string" &&
    UUID_PATTERN.test(options.serviceInstanceId)
  );
}

export function createServiceControlServer(
  options: CreateServiceControlServerOptions,
): ServiceControlServer {
  const connections = new Set<Socket>();
  const activeOperations = new Set<Promise<void>>();
  const drainWaiters = new Set<() => void>();
  const cache = new Map<string, CacheEntry>();
  const pendingCache = new Map<string, PendingCacheEntry>();
  const publicationGuardPath = path.join(
    path.dirname(options.socketPath),
    publicationGuardName(options.serviceInstanceId),
  );
  const stagingSocketPath = path.join(
    path.dirname(options.socketPath),
    stagedSocketName(options.serviceInstanceId),
  );
  let ownedSocket: FileIdentity | undefined;
  let publicationGuard: FileIdentity | undefined;
  let ownedGuardPath = publicationGuardPath;
  let ownedRuntime: FileIdentity | undefined;
  let listenPromise: Promise<void> | undefined;
  let acceptClosePromise: Promise<void> | undefined;
  let resolveAcceptClose: (() => void) | undefined;
  let closeAttemptRunning = false;
  let publicSocketUnpublished = false;
  let closePromise: Promise<void> | undefined;
  let listening = false;
  let closing = false;
  let stopRequested = false;

  const notifyConnectionCount = (): void => {
    try {
      options.operationHooks?.onConnectionCountChanged?.(connections.size);
    } catch {
      // Observability hooks cannot affect the transport lifecycle.
    }
  };

  const notifyConnectionClosed = (): void => {
    try {
      options.operationHooks?.onConnectionClosed?.();
    } catch {
      // Observability hooks cannot affect the transport lifecycle.
    }
  };

  const resolveDrains = (): void => {
    if (connections.size !== 0 || activeOperations.size !== 0) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };

  const writeOnce = (socket: Socket, response: string): void => {
    if (socket.destroyed || socket.writableEnded) return;
    const forceClose = setTimeout(() => socket.destroy(), options.idleTimeoutMs);
    socket.once("close", () => clearTimeout(forceClose));
    socket.end(response, () => socket.destroy());
  };

  const storeResponse = (requestId: string, requestHash: string, response: string): void => {
    cache.delete(requestId);
    cache.set(requestId, { requestHash, response });
    while (cache.size > options.cacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const dispatch = async (request: ServiceControlRequestV1): Promise<string> => {
    if (request.command === "status") {
      const success = validatedSuccessResponse(options, request.request_id);
      return framedResponse(
        success ?? failureResponse(request.request_id, "RUNTIME_SERVICE_UNAVAILABLE"),
      );
    }
    if (request.command === "superpowers-approve") {
      if (options.handleSkillRequest === undefined) {
        return framedResponse(failureResponse(request.request_id, "RUNTIME_SERVICE_UNAVAILABLE"));
      }
      try {
        const canonicalRequest = canonicalSkillRequest(request);
        const data = await options.handleSkillRequest(canonicalRequest);
        const success = validatedSkillResponse(canonicalRequest, data);
        return framedResponse(
          success ?? failureResponse(request.request_id, "RUNTIME_SERVICE_UNAVAILABLE"),
        );
      } catch (error) {
        return framedResponse(failureResponse(request.request_id, safeOperationFailure(error)));
      }
    }
    if (options.handleProjectRequest === undefined) {
      return framedResponse(failureResponse(request.request_id, "RUNTIME_SERVICE_UNAVAILABLE"));
    }
    try {
      const canonicalRequest = canonicalProjectRequest(request);
      const data = await options.handleProjectRequest(canonicalRequest);
      const success = validatedProjectResponse(canonicalRequest, data);
      return framedResponse(
        success ?? failureResponse(request.request_id, "RUNTIME_SERVICE_UNAVAILABLE"),
      );
    } catch (error) {
      return framedResponse(failureResponse(request.request_id, safeOperationFailure(error)));
    }
  };

  const responseForFrame = async (frame: Buffer, allowDispatch = true): Promise<string> => {
    if (
      frame.byteLength < 2 ||
      frame.byteLength > RESPONSE_FRAME_BYTES ||
      frame[frame.byteLength - 1] !== 0x0a ||
      frame.subarray(0, frame.byteLength - 1).includes(0x0a)
    ) {
      return INVALID_RESPONSE;
    }
    const body = frame.subarray(0, frame.byteLength - 1);
    let document: JsonValue;
    try {
      document = parseJsonBytes(body, {
        maxBytes: MAX_CONTROL_MESSAGE_BYTES,
        maxDepth: 16,
        maxMembers: 64,
      });
      if (!Buffer.from(canonicalJson(document), "utf8").equals(body)) return INVALID_RESPONSE;
    } catch {
      return INVALID_RESPONSE;
    }

    const requestId = validatedRequestId(document);
    if (requestId === null) return INVALID_RESPONSE;
    const requestHash = hashBytes(body);
    const existing = cache.get(requestId);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        return framedResponse(failureResponse(requestId, "RUNTIME_SERVICE_CONTROL_CONFLICT"));
      }
      cache.delete(requestId);
      cache.set(requestId, existing);
      return existing.response;
    }
    const pending = pendingCache.get(requestId);
    if (pending !== undefined) {
      return pending.requestHash === requestHash
        ? pending.response
        : framedResponse(failureResponse(requestId, "RUNTIME_SERVICE_CONTROL_CONFLICT"));
    }

    const parsed = parseServiceControlRequest(body);
    let responsePromise: Promise<string>;
    if (!parsed.ok) {
      responsePromise = Promise.resolve(
        framedResponse(failureResponse(requestId, "RUNTIME_SERVICE_CONTROL_INVALID")),
      );
    } else if (!allowDispatch) {
      responsePromise = Promise.resolve(
        framedResponse(failureResponse(requestId, "RUNTIME_SERVICE_UNAVAILABLE")),
      );
    } else {
      responsePromise = dispatch(parsed.value);
    }
    pendingCache.set(requestId, { requestHash, response: responsePromise });
    let response: string;
    try {
      response = await responsePromise;
    } finally {
      if (pendingCache.get(requestId)?.response === responsePromise) pendingCache.delete(requestId);
    }
    storeResponse(requestId, requestHash, response);
    return response;
  };

  const handleConnection = (socket: Socket): void => {
    if (closing || stopRequested || connections.size >= options.maxConnections) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    notifyConnectionCount();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let oversized = false;
    let responded = false;
    let idleTimer: ReturnType<typeof setTimeout>;

    const finish = (response: string): void => {
      if (responded) return;
      responded = true;
      clearTimeout(idleTimer);
      writeOnce(socket, response);
    };

    const refreshIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(INVALID_RESPONSE), options.idleTimeoutMs);
    };
    refreshIdleTimer();
    socket.on("data", (chunk: Buffer) => {
      if (responded || oversized) return;
      refreshIdleTimer();
      totalBytes += chunk.byteLength;
      if (totalBytes > RESPONSE_FRAME_BYTES) {
        oversized = true;
        chunks.splice(0);
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      const operation = (
        oversized
          ? Promise.resolve(INVALID_RESPONSE)
          : responseForFrame(Buffer.concat(chunks, totalBytes), !stopRequested && !closing)
      )
        .then(finish)
        .catch(() => finish(framedResponse(failureResponse(null, "RUNTIME_SERVICE_UNAVAILABLE"))))
        .finally(() => {
          activeOperations.delete(operation);
          resolveDrains();
        });
      activeOperations.add(operation);
    });
    socket.once("error", () => {
      socket.destroy();
    });
    socket.once("close", () => {
      clearTimeout(idleTimer);
      connections.delete(socket);
      notifyConnectionCount();
      notifyConnectionClosed();
      resolveDrains();
    });
  };

  const nativeServer = createServer({ allowHalfOpen: true }, handleConnection);
  nativeServer.maxConnections = options.maxConnections;
  nativeServer.on("error", () => {
    // Listening failures are handled by listen(); later transport failures are contained.
  });

  function stopAccepting(): void {
    stopRequested = true;
    if (!listening) return;
    acceptClosePromise ??= new Promise((resolve) => {
      resolveAcceptClose = resolve;
    });
    try {
      unpublishOwnedSocket();
    } catch {
      return;
    }
    void attemptNativeClose();
  }

  const cleanupOwnedSocket = async (): Promise<void> => {
    if (ownedSocket === undefined) return;
    let metadata;
    try {
      metadata = await lstatBigInt(options.socketPath);
    } catch (error) {
      if (isMissing(error)) return;
      return;
    }
    if (
      metadata.isSocket() &&
      classifyPathOwner(
        options.classifyPathOwner,
        options.currentUid,
        safeUserId(metadata.uid),
        options.socketPath,
      ) === "current-user" &&
      sameIdentity(identityOf(metadata), ownedSocket)
    ) {
      try {
        await unlink(options.socketPath);
      } catch {
        // Cleanup is best effort and never widens beyond the exact owned socket.
      }
    }
  };

  function unpublishOwnedSocket(): void {
    if (publicSocketUnpublished) return;
    if (ownedSocket === undefined) pathUnsafe();
    let metadata: BigIntStats;
    try {
      metadata = lstatSync(options.socketPath, { bigint: true });
    } catch (error) {
      if (isMissing(error)) {
        publicSocketUnpublished = true;
        return;
      }
      pathUnsafe();
    }
    const exactOwnedSocket =
      !metadata.isSymbolicLink() &&
      metadata.isSocket() &&
      classifyPathOwner(
        options.classifyPathOwner,
        options.currentUid,
        safeUserId(metadata.uid),
        options.socketPath,
      ) === "current-user" &&
      (metadata.mode & 0o777n) === 0o600n &&
      sameIdentity(identityOf(metadata), ownedSocket);
    if (!exactOwnedSocket) {
      publicSocketUnpublished = true;
      return;
    }
    try {
      unlinkSync(options.socketPath);
    } catch {
      pathUnsafe();
    }
    publicSocketUnpublished = true;
  }

  const cleanupPublicationGuard = async (): Promise<void> => {
    if (publicationGuard === undefined) return;
    let metadata;
    try {
      metadata = await lstatBigInt(ownedGuardPath);
    } catch {
      return;
    }
    if (
      metadata.isDirectory() &&
      classifyPathOwner(
        options.classifyPathOwner,
        options.currentUid,
        safeUserId(metadata.uid),
        ownedGuardPath,
      ) === "current-user" &&
      (metadata.mode & 0o777n) === 0o700n &&
      sameIdentity(identityOf(metadata), publicationGuard)
    ) {
      try {
        await rmdir(ownedGuardPath);
      } catch {
        // Cleanup is best effort and never recurses into a changed guard directory.
      }
    }
  };

  async function armPublicationGuardForNativeClose(): Promise<void> {
    if (publicationGuard === undefined || ownedRuntime === undefined) pathUnsafe();
    if (ownedGuardPath === stagingSocketPath) {
      const armed = await inspectEmptyPublicationGuard({
        candidate: stagingSocketPath,
        classifier: options.classifyPathOwner,
        currentUid: options.currentUid,
      });
      if (!sameIdentity(armed, publicationGuard)) pathUnsafe();
      await assertUnchangedRuntimeDirectory({
        socketPath: options.socketPath,
        expected: ownedRuntime,
        classifier: options.classifyPathOwner,
        currentUid: options.currentUid,
        modelRuntimeIdentity: options.operationHooks?.modelRuntimeIdentity,
      });
      return;
    }

    const expected = await inspectEmptyPublicationGuard({
      candidate: publicationGuardPath,
      classifier: options.classifyPathOwner,
      currentUid: options.currentUid,
    });
    if (!sameIdentity(expected, publicationGuard)) pathUnsafe();
    await assertUnchangedRuntimeDirectory({
      socketPath: options.socketPath,
      expected: ownedRuntime,
      classifier: options.classifyPathOwner,
      currentUid: options.currentUid,
      modelRuntimeIdentity: options.operationHooks?.modelRuntimeIdentity,
    });
    try {
      await options.operationHooks?.beforePublicationGuardCloseClaim?.(stagingSocketPath);
    } catch {
      pathUnsafe();
    }
    try {
      await lstatBigInt(stagingSocketPath);
      pathUnsafe();
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
        pathUnsafe();
      }
    }
    try {
      await rename(publicationGuardPath, stagingSocketPath);
    } catch {
      pathUnsafe();
    }
    ownedGuardPath = stagingSocketPath;
    const armed = await inspectEmptyPublicationGuard({
      candidate: stagingSocketPath,
      classifier: options.classifyPathOwner,
      currentUid: options.currentUid,
    });
    if (!sameIdentity(armed, publicationGuard)) pathUnsafe();
    await assertUnchangedRuntimeDirectory({
      socketPath: options.socketPath,
      expected: ownedRuntime,
      classifier: options.classifyPathOwner,
      currentUid: options.currentUid,
      modelRuntimeIdentity: options.operationHooks?.modelRuntimeIdentity,
    });
  }

  async function attemptNativeClose(): Promise<void> {
    if (!listening || closeAttemptRunning) return;
    closeAttemptRunning = true;
    try {
      await armPublicationGuardForNativeClose();
    } catch {
      closeAttemptRunning = false;
      return;
    }
    try {
      nativeServer.close(() => {
        listening = false;
        closeAttemptRunning = false;
        resolveAcceptClose?.();
      });
    } catch {
      closeAttemptRunning = false;
    }
  }

  const listen = (): Promise<void> => {
    if (listenPromise !== undefined) return listenPromise;
    listenPromise = (async () => {
      if (closing || !validatedConfiguration(options)) unavailable();
      assertServiceSocketLayout(options);
      const runtimeIdentity = await assertPrivateRuntimeDirectory(
        options.socketPath,
        options.classifyPathOwner,
        options.currentUid,
        options.operationHooks?.modelRuntimeIdentity,
      );
      ownedRuntime = runtimeIdentity;
      await reclaimStaleSocketClaims({
        socketPath: options.socketPath,
        runtimeIdentity,
        classifier: options.classifyPathOwner,
        currentUid: options.currentUid,
        hooks: options.operationHooks,
      });
      await removeStaleSocket({
        socketPath: options.socketPath,
        runtimeIdentity,
        classifier: options.classifyPathOwner,
        currentUid: options.currentUid,
        hooks: options.operationHooks,
      });
      await reclaimStaleStagedSockets({
        socketPath: options.socketPath,
        runtimeIdentity,
        classifier: options.classifyPathOwner,
        currentUid: options.currentUid,
        hooks: options.operationHooks,
      });
      await reclaimStalePublicationGuards({
        socketPath: options.socketPath,
        serviceInstanceId: options.serviceInstanceId,
        runtimeIdentity,
        classifier: options.classifyPathOwner,
        currentUid: options.currentUid,
        hooks: options.operationHooks,
      });
      try {
        await lstatBigInt(stagingSocketPath);
        pathUnsafe();
      } catch (error) {
        if (!isMissing(error)) {
          if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
          pathUnsafe();
        }
      }

      await new Promise<void>((resolve, reject) => {
        const onError = (): void => {
          nativeServer.off("listening", onListening);
          reject(serviceError("RUNTIME_SERVICE_UNAVAILABLE"));
        };
        const onListening = (): void => {
          nativeServer.off("error", onError);
          resolve();
        };
        nativeServer.once("error", onError);
        nativeServer.once("listening", onListening);
        nativeServer.listen(stagingSocketPath);
      });

      let created;
      try {
        created = await lstatBigInt(stagingSocketPath);
        if (
          created.isSymbolicLink() ||
          !created.isSocket() ||
          classifyPathOwner(
            options.classifyPathOwner,
            options.currentUid,
            safeUserId(created.uid),
            stagingSocketPath,
          ) !== "current-user"
        ) {
          pathUnsafe();
        }
        const createdIdentity = identityOf(created);
        await chmod(stagingSocketPath, 0o600);
        const stagedSocket = await lstatBigInt(stagingSocketPath);
        if (
          stagedSocket.isSymbolicLink() ||
          !stagedSocket.isSocket() ||
          classifyPathOwner(
            options.classifyPathOwner,
            options.currentUid,
            safeUserId(stagedSocket.uid),
            stagingSocketPath,
          ) !== "current-user" ||
          (stagedSocket.mode & 0o777n) !== 0o600n ||
          !sameIdentity(identityOf(stagedSocket), createdIdentity)
        ) {
          pathUnsafe();
        }

        try {
          await options.operationHooks?.beforePublish?.();
        } catch {
          pathUnsafe();
        }
        const beforePublishRuntime = await assertPrivateRuntimeDirectory(
          options.socketPath,
          options.classifyPathOwner,
          options.currentUid,
          options.operationHooks?.modelRuntimeIdentity,
        );
        if (!sameIdentity(beforePublishRuntime, runtimeIdentity)) pathUnsafe();

        await link(stagingSocketPath, options.socketPath);
        ownedSocket = createdIdentity;
        const privateSocket = await lstatBigInt(options.socketPath);
        if (
          privateSocket.isSymbolicLink() ||
          !privateSocket.isSocket() ||
          classifyPathOwner(
            options.classifyPathOwner,
            options.currentUid,
            safeUserId(privateSocket.uid),
            options.socketPath,
          ) !== "current-user" ||
          (privateSocket.mode & 0o777n) !== 0o600n ||
          !sameIdentity(identityOf(privateSocket), createdIdentity)
        ) {
          pathUnsafe();
        }

        const linkedStage = await lstatBigInt(stagingSocketPath);
        if (
          linkedStage.isSymbolicLink() ||
          !linkedStage.isSocket() ||
          classifyPathOwner(
            options.classifyPathOwner,
            options.currentUid,
            safeUserId(linkedStage.uid),
            stagingSocketPath,
          ) !== "current-user" ||
          (linkedStage.mode & 0o777n) !== 0o600n ||
          !sameIdentity(identityOf(linkedStage), createdIdentity)
        ) {
          pathUnsafe();
        }
        await unlink(stagingSocketPath);
        await mkdir(publicationGuardPath, { mode: 0o700 });
        const createdGuard = await lstatBigInt(publicationGuardPath);
        if (
          createdGuard.isSymbolicLink() ||
          !createdGuard.isDirectory() ||
          classifyPathOwner(
            options.classifyPathOwner,
            options.currentUid,
            safeUserId(createdGuard.uid),
            publicationGuardPath,
          ) !== "current-user"
        ) {
          pathUnsafe();
        }
        publicationGuard = identityOf(createdGuard);
        ownedGuardPath = publicationGuardPath;
        await chmod(publicationGuardPath, 0o700);
        const guard = await lstatBigInt(publicationGuardPath);
        if (
          guard.isSymbolicLink() ||
          !guard.isDirectory() ||
          classifyPathOwner(
            options.classifyPathOwner,
            options.currentUid,
            safeUserId(guard.uid),
            publicationGuardPath,
          ) !== "current-user" ||
          (guard.mode & 0o777n) !== 0o700n ||
          !sameIdentity(identityOf(guard), publicationGuard)
        ) {
          pathUnsafe();
        }
        const readyRuntime = await assertPrivateRuntimeDirectory(
          options.socketPath,
          options.classifyPathOwner,
          options.currentUid,
          options.operationHooks?.modelRuntimeIdentity,
        );
        if (!sameIdentity(readyRuntime, runtimeIdentity)) pathUnsafe();
        listening = true;
        if (stopRequested) stopAccepting();
      } catch (error) {
        await new Promise<void>((resolve) => nativeServer.close(() => resolve()));
        await cleanupOwnedSocket();
        await cleanupPublicationGuard();
        if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
        pathUnsafe();
      }
    })();
    return listenPromise;
  };

  const drain = async (signal: AbortSignal): Promise<void> => {
    if (connections.size === 0 && activeOperations.size === 0) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        signal.removeEventListener("abort", abort);
        drainWaiters.delete(finish);
        resolve();
      };
      const abort = (): void => {
        for (const socket of connections) socket.destroy();
        if (connections.size === 0) finish();
      };
      drainWaiters.add(finish);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      if (connections.size === 0 && activeOperations.size === 0) finish();
    });
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      closing = true;
      if (listenPromise !== undefined) {
        try {
          await listenPromise;
        } catch {
          await cleanupOwnedSocket();
          return;
        }
      }
      stopAccepting();
      for (const socket of connections) socket.destroy();
      if (connections.size !== 0 || activeOperations.size !== 0) {
        await new Promise<void>((resolve) => drainWaiters.add(resolve));
      }
      await acceptClosePromise;
      await cleanupOwnedSocket();
      await cleanupPublicationGuard();
    })();
    return closePromise;
  };

  return Object.freeze({ listen, stopAccepting, drain, close });
}

function requestIdFor(
  options: Pick<RequestServiceStatusOptions, "requestId" | "createRequestId">,
): string {
  try {
    const requestId = options.requestId ?? options.createRequestId?.() ?? randomUUID();
    if (!UUID_PATTERN.test(requestId)) controlInvalid();
    return requestId;
  } catch (error) {
    if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
    controlInvalid();
  }
}

async function readControlResponse(
  options: Pick<RequestServiceStatusOptions, "socketPath" | "idleTimeoutMs">,
  request: ServiceControlRequestV1,
): Promise<ServiceControlResponseV1> {
  await assertPrivateRuntimeDirectory(options.socketPath);
  const expectedSocket = await privateSocketIdentity(options.socketPath);
  if (expectedSocket === undefined) unavailable();
  const timeout = options.idleTimeoutMs ?? 5_000;
  if (timeout !== 5_000) controlInvalid();
  const requestFrame = `${canonicalJson(request)}\n`;

  const frame = await new Promise<Buffer>((resolve, reject) => {
    const socket = createConnection({ path: options.socketPath });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (error?: RuntimeServiceError): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error === undefined) resolve(Buffer.concat(chunks, totalBytes));
      else reject(error);
    };
    socket.setTimeout(timeout, () => finish(serviceError("RUNTIME_SERVICE_UNAVAILABLE")));
    socket.once("connect", () => socket.end(requestFrame));
    socket.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > RESPONSE_FRAME_BYTES) {
        finish(serviceError("RUNTIME_SERVICE_UNAVAILABLE"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => finish());
    socket.once("error", () => finish(serviceError("RUNTIME_SERVICE_UNAVAILABLE")));
  });

  await assertPrivateRuntimeDirectory(options.socketPath);
  const currentSocket = await privateSocketIdentity(options.socketPath);
  if (currentSocket === undefined || !sameIdentity(currentSocket, expectedSocket)) pathUnsafe();

  if (
    frame.byteLength < 2 ||
    frame.byteLength > RESPONSE_FRAME_BYTES ||
    frame[frame.byteLength - 1] !== 0x0a ||
    frame.subarray(0, frame.byteLength - 1).includes(0x0a)
  ) {
    unavailable();
  }
  const body = frame.subarray(0, frame.byteLength - 1);
  const parsed = parseServiceControlResponse(body);
  if (!parsed.ok || !Buffer.from(canonicalJson(parsed.value), "utf8").equals(body)) unavailable();
  if (parsed.value.request_id !== request.request_id) unavailable();
  return parsed.value;
}

function throwControlFailure(response: ServiceControlResponseV1): never {
  const code = response.error?.code;
  if (typeof code !== "string") unavailable();
  if (code === "BLOCKED_SUPERPOWERS_MISSING" || code.startsWith("RUNTIME_SKILL_")) {
    try {
      throw new RuntimeSkillError(code as RuntimeSkillErrorCode);
    } catch (error) {
      if (error instanceof RuntimeSkillError) throw error;
      unavailable();
    }
  }
  if (code.startsWith("RUNTIME_PROJECT_") || code === "RUNTIME_OPERATION_CONFLICT") {
    try {
      throw new RuntimeProjectError(code as RuntimeProjectErrorCode);
    } catch (error) {
      if (error instanceof RuntimeProjectError) throw error;
      unavailable();
    }
  }
  if (!isRuntimeServiceErrorCode(code)) unavailable();
  throw serviceError(code);
}

export async function requestServiceStatus(
  options: RequestServiceStatusOptions,
): Promise<ServiceStatusV1> {
  try {
    const requestId = requestIdFor(options);
    const response = await readControlResponse(options, {
      schema_version: "service-control-request.v1",
      document_type: "service-control-request",
      request_id: requestId,
      command: "status",
    });
    if (!response.ok) throwControlFailure(response);
    if (response.status === null || response.data !== null) unavailable();
    return response.status;
  } catch (error) {
    if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
    unavailable();
  }
}

export async function requestProjectOperation(
  options: RequestProjectOperationOptions,
): Promise<ServiceProjectDataV1> {
  try {
    const requestId = requestIdFor(options);
    const request = {
      schema_version: "service-control-request.v1",
      document_type: "service-control-request",
      request_id: requestId,
      ...(options.operation.command === "project-list"
        ? {}
        : { operation_id: options.operationId ?? options.createOperationId?.() ?? randomUUID() }),
      ...options.operation,
    } as const;
    const validated = parseServiceControlRequest(canonicalJson(request));
    if (
      !validated.ok ||
      validated.value.command === "status" ||
      validated.value.command === "superpowers-approve"
    ) {
      controlInvalid();
    }
    const response = await readControlResponse(options, validated.value);
    if (!response.ok) throwControlFailure(response);
    if (response.status !== null || response.data === null) unavailable();
    if (
      (options.operation.command === "project-list" && response.data.kind !== "project-list") ||
      (options.operation.command !== "project-list" &&
        response.data.kind !== "project-registration")
    ) {
      unavailable();
    }
    return response.data as ServiceProjectDataV1;
  } catch (error) {
    if (error instanceof RuntimeProjectError) {
      let normalized: RuntimeProjectError;
      try {
        normalized = new RuntimeProjectError(error.code);
      } catch {
        unavailable();
      }
      throw normalized;
    }
    if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
    unavailable();
  }
}

export async function requestSuperpowersApprovalDecision(
  options: RequestSuperpowersApprovalDecisionOptions,
): Promise<SuperpowersApprovalDataV1> {
  try {
    const validated = parseServiceControlRequest(canonicalJson(options.request));
    if (!validated.ok || validated.value.command !== "superpowers-approve") controlInvalid();
    const response = await readControlResponse(
      { socketPath: options.socketPath, idleTimeoutMs: options.idleTimeoutMs ?? 5_000 },
      validated.value,
    );
    if (!response.ok) throwControlFailure(response);
    if (
      response.status !== null ||
      response.data?.kind !== "superpowers-approval" ||
      response.data.run_id !== validated.value.run_id ||
      response.data.phase !== validated.value.phase ||
      response.data.approval_request_hash !== validated.value.approval_request_hash ||
      response.data.state !== (validated.value.decision === "APPROVE" ? "RUNNING" : "BLOCKED") ||
      response.data.journal_head.journal_revision !==
        validated.value.expected_journal_revision + 1 ||
      response.data.journal_head.sequence !== validated.value.expected_journal_revision + 1 ||
      response.data.journal_head.entry_hash === validated.value.expected_journal_head_hash
    ) {
      unavailable();
    }
    return response.data;
  } catch (error) {
    if (error instanceof RuntimeSkillError) {
      try {
        throw new RuntimeSkillError(error.code);
      } catch (normalized) {
        if (normalized instanceof RuntimeSkillError) throw normalized;
        unavailable();
      }
    }
    if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
    unavailable();
  }
}

export async function probeServiceIdentity(
  options: ProbeServiceIdentityOptions,
): Promise<string | null> {
  try {
    const requestId = options.createRequestId?.() ?? randomUUID();
    const status = await requestServiceStatus({
      socketPath: options.socketPath,
      requestId,
      idleTimeoutMs: options.idleTimeoutMs ?? 5_000,
    });
    return status.service_instance_id;
  } catch {
    return null;
  }
}
