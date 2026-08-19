import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, rmdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";

import { canonicalJson, parseJsonBytes, type JsonValue } from "../protocol/json.js";
import {
  MAX_CONTROL_MESSAGE_BYTES,
  parseServiceControlRequest,
  parseServiceControlResponse,
  type ServiceControlResponseV1,
  type ServiceStatusV1,
} from "./contracts.js";
import { RuntimeServiceError, type RuntimeServiceErrorCode } from "./errors.js";

const RESPONSE_FRAME_BYTES = MAX_CONTROL_MESSAGE_BYTES + 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const internalServiceErrors = new WeakSet<RuntimeServiceError>();

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface CacheEntry {
  readonly requestHash: string;
  readonly response: string;
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
  readonly classifyPathOwner?: PathOwnerClassifier;
  readonly operationHooks?: ServiceControlOperationHooks;
}

export type PathOwner = "root" | "current-user" | "other";
export type PathOwnerClassifier = (userId: number, candidate: string) => PathOwner;

export interface ServiceControlOperationHooks {
  readonly beforePublish?: () => Promise<void>;
  readonly onConnectionCountChanged?: (count: number) => void;
  readonly onConnectionClosed?: () => void;
}

export interface RequestServiceStatusOptions {
  readonly socketPath: string;
  readonly requestId?: string;
  readonly createRequestId?: () => string;
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

function defaultPathOwner(userId: number): PathOwner {
  if (userId === 0) return "root";
  return typeof process.getuid === "function" && process.getuid() === userId
    ? "current-user"
    : "other";
}

function classifyPathOwner(
  classifier: PathOwnerClassifier | undefined,
  userId: number,
  candidate: string,
): PathOwner {
  try {
    const owner = classifier?.(userId, candidate) ?? defaultPathOwner(userId);
    if (owner !== "root" && owner !== "current-user" && owner !== "other") pathUnsafe();
    return owner;
  } catch (error) {
    if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
    return pathUnsafe();
  }
}

function identityOf(metadata: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
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

async function assertPrivateRuntimeDirectory(
  socketPath: string,
  classifier?: PathOwnerClassifier,
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
      metadata = await lstat(candidate);
    } catch {
      pathUnsafe();
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) pathUnsafe();

    const owner = classifyPathOwner(classifier, metadata.uid, candidate);
    if (owner === "root" && !reachedCurrentUserDirectory) {
      if ((metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0) pathUnsafe();
    } else if (owner === "current-user") {
      if ((metadata.mode & 0o022) !== 0) pathUnsafe();
      reachedCurrentUserDirectory = true;
    } else {
      pathUnsafe();
    }
    if (
      index === candidates.length - 1 &&
      (owner !== "current-user" || (metadata.mode & 0o777) !== 0o700)
    ) {
      pathUnsafe();
    }
    if (index === candidates.length - 1) runtimeIdentity = identityOf(metadata);
  }
  if (segments.length === 0 || runtimeIdentity === undefined) pathUnsafe();
  return runtimeIdentity;
}

async function privateSocketIdentity(
  socketPath: string,
  classifier?: PathOwnerClassifier,
): Promise<FileIdentity | undefined> {
  let metadata;
  try {
    metadata = await lstat(socketPath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    pathUnsafe();
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isSocket() ||
    classifyPathOwner(classifier, metadata.uid, socketPath) !== "current-user" ||
    (metadata.mode & 0o777) !== 0o600
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

async function removeStaleSocket(
  socketPath: string,
  classifier?: PathOwnerClassifier,
): Promise<void> {
  const expected = await privateSocketIdentity(socketPath, classifier);
  if (expected === undefined) return;
  if (await socketHasListener(socketPath)) {
    throw serviceError("RUNTIME_SERVICE_ALREADY_RUNNING");
  }
  const current = await privateSocketIdentity(socketPath, classifier);
  if (current === undefined || !sameIdentity(current, expected)) pathUnsafe();
  try {
    await unlink(socketPath);
  } catch {
    pathUnsafe();
  }
}

function plainError(code: RuntimeServiceErrorCode): Readonly<{
  code: RuntimeServiceErrorCode;
  category: RuntimeServiceError["category"];
  retryable: boolean;
  safe_message: string;
}> {
  const error = new RuntimeServiceError(code);
  return {
    code: error.code,
    category: error.category,
    retryable: error.retryable,
    safe_message: error.safe_message,
  };
}

function failureResponse(
  requestId: string | null,
  code: RuntimeServiceErrorCode,
): ServiceControlResponseV1 {
  return {
    schema_version: "service-control-response.v1",
    document_type: "service-control-response",
    request_id: requestId,
    ok: false,
    status: null,
    error: plainError(code),
  };
}

function framedResponse(response: ServiceControlResponseV1): string {
  return `${canonicalJson(response)}\n`;
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
      error: null,
    };
    const parsed = parseServiceControlResponse(canonicalJson(response));
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

function validatedConfiguration(options: CreateServiceControlServerOptions): boolean {
  return (
    options.idleTimeoutMs === 5_000 &&
    options.maxConnections === 32 &&
    options.cacheSize === 256 &&
    typeof options.status === "function" &&
    typeof options.serviceInstanceId === "string" &&
    UUID_PATTERN.test(options.serviceInstanceId)
  );
}

export function createServiceControlServer(
  options: CreateServiceControlServerOptions,
): ServiceControlServer {
  const connections = new Set<Socket>();
  const drainWaiters = new Set<() => void>();
  const cache = new Map<string, CacheEntry>();
  const stagingSocketPath = path.join(
    path.dirname(options.socketPath),
    `.c${createHash("sha256").update(options.serviceInstanceId, "utf8").digest("hex").slice(0, 8)}`,
  );
  let ownedSocket: FileIdentity | undefined;
  let stagingGuard: FileIdentity | undefined;
  let listenPromise: Promise<void> | undefined;
  let acceptClosePromise: Promise<void> | undefined;
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
    if (connections.size !== 0) return;
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

  const responseForFrame = (frame: Buffer): string => {
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

    const parsed = parseServiceControlRequest(body);
    let response: string;
    if (!parsed.ok) {
      response = framedResponse(failureResponse(requestId, "RUNTIME_SERVICE_CONTROL_INVALID"));
    } else {
      const success = validatedSuccessResponse(options, requestId);
      response =
        success === undefined
          ? framedResponse(failureResponse(requestId, "RUNTIME_SERVICE_UNAVAILABLE"))
          : framedResponse(success);
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
      finish(oversized ? INVALID_RESPONSE : responseForFrame(Buffer.concat(chunks, totalBytes)));
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

  const stopAccepting = (): void => {
    stopRequested = true;
    if (!listening || acceptClosePromise !== undefined) return;
    acceptClosePromise = new Promise((resolve) => {
      nativeServer.close(() => {
        listening = false;
        resolve();
      });
    });
  };

  const cleanupOwnedSocket = async (): Promise<void> => {
    if (ownedSocket === undefined) return;
    let metadata;
    try {
      metadata = await lstat(options.socketPath);
    } catch (error) {
      if (isMissing(error)) return;
      return;
    }
    if (
      metadata.isSocket() &&
      classifyPathOwner(options.classifyPathOwner, metadata.uid, options.socketPath) ===
        "current-user" &&
      sameIdentity(identityOf(metadata), ownedSocket)
    ) {
      try {
        await unlink(options.socketPath);
      } catch {
        // Cleanup is best effort and never widens beyond the exact owned socket.
      }
    }
  };

  const cleanupStagingGuard = async (): Promise<void> => {
    if (stagingGuard === undefined) return;
    let metadata;
    try {
      metadata = await lstat(stagingSocketPath);
    } catch {
      return;
    }
    if (
      metadata.isDirectory() &&
      classifyPathOwner(options.classifyPathOwner, metadata.uid, stagingSocketPath) ===
        "current-user" &&
      sameIdentity(identityOf(metadata), stagingGuard)
    ) {
      try {
        await rmdir(stagingSocketPath);
      } catch {
        // Cleanup is best effort and never recurses into a changed guard directory.
      }
    }
  };

  const listen = (): Promise<void> => {
    if (listenPromise !== undefined) return listenPromise;
    listenPromise = (async () => {
      if (closing || !validatedConfiguration(options)) unavailable();
      const runtimeIdentity = await assertPrivateRuntimeDirectory(
        options.socketPath,
        options.classifyPathOwner,
      );
      await removeStaleSocket(options.socketPath, options.classifyPathOwner);
      try {
        await lstat(stagingSocketPath);
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
        created = await lstat(stagingSocketPath);
        if (
          created.isSymbolicLink() ||
          !created.isSocket() ||
          classifyPathOwner(options.classifyPathOwner, created.uid, stagingSocketPath) !==
            "current-user"
        ) {
          pathUnsafe();
        }
        const createdIdentity = identityOf(created);
        await chmod(stagingSocketPath, 0o600);
        const stagedSocket = await lstat(stagingSocketPath);
        if (
          stagedSocket.isSymbolicLink() ||
          !stagedSocket.isSocket() ||
          classifyPathOwner(options.classifyPathOwner, stagedSocket.uid, stagingSocketPath) !==
            "current-user" ||
          (stagedSocket.mode & 0o777) !== 0o600 ||
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
        );
        if (!sameIdentity(beforePublishRuntime, runtimeIdentity)) pathUnsafe();

        await link(stagingSocketPath, options.socketPath);
        ownedSocket = createdIdentity;
        const privateSocket = await lstat(options.socketPath);
        if (
          privateSocket.isSymbolicLink() ||
          !privateSocket.isSocket() ||
          classifyPathOwner(options.classifyPathOwner, privateSocket.uid, options.socketPath) !==
            "current-user" ||
          (privateSocket.mode & 0o777) !== 0o600 ||
          !sameIdentity(identityOf(privateSocket), createdIdentity)
        ) {
          pathUnsafe();
        }

        const linkedStage = await lstat(stagingSocketPath);
        if (
          linkedStage.isSymbolicLink() ||
          !linkedStage.isSocket() ||
          classifyPathOwner(options.classifyPathOwner, linkedStage.uid, stagingSocketPath) !==
            "current-user" ||
          (linkedStage.mode & 0o777) !== 0o600 ||
          !sameIdentity(identityOf(linkedStage), createdIdentity)
        ) {
          pathUnsafe();
        }
        await unlink(stagingSocketPath);
        await mkdir(stagingSocketPath, { mode: 0o700 });
        const createdGuard = await lstat(stagingSocketPath);
        if (
          createdGuard.isSymbolicLink() ||
          !createdGuard.isDirectory() ||
          classifyPathOwner(options.classifyPathOwner, createdGuard.uid, stagingSocketPath) !==
            "current-user"
        ) {
          pathUnsafe();
        }
        stagingGuard = identityOf(createdGuard);
        await chmod(stagingSocketPath, 0o700);
        const guard = await lstat(stagingSocketPath);
        if (
          guard.isSymbolicLink() ||
          !guard.isDirectory() ||
          classifyPathOwner(options.classifyPathOwner, guard.uid, stagingSocketPath) !==
            "current-user" ||
          (guard.mode & 0o777) !== 0o700 ||
          !sameIdentity(identityOf(guard), stagingGuard)
        ) {
          pathUnsafe();
        }
        const readyRuntime = await assertPrivateRuntimeDirectory(
          options.socketPath,
          options.classifyPathOwner,
        );
        if (!sameIdentity(readyRuntime, runtimeIdentity)) pathUnsafe();
        listening = true;
        if (stopRequested) stopAccepting();
      } catch (error) {
        await new Promise<void>((resolve) => nativeServer.close(() => resolve()));
        await cleanupOwnedSocket();
        await cleanupStagingGuard();
        if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
        pathUnsafe();
      }
    })();
    return listenPromise;
  };

  const drain = async (signal: AbortSignal): Promise<void> => {
    if (connections.size === 0) return;
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
      if (connections.size === 0) finish();
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
      if (connections.size !== 0) {
        await new Promise<void>((resolve) => drainWaiters.add(resolve));
      }
      await acceptClosePromise;
      await cleanupOwnedSocket();
      await cleanupStagingGuard();
    })();
    return closePromise;
  };

  return Object.freeze({ listen, stopAccepting, drain, close });
}

function requestIdFor(options: RequestServiceStatusOptions): string {
  try {
    const requestId = options.requestId ?? options.createRequestId?.() ?? randomUUID();
    if (!UUID_PATTERN.test(requestId)) controlInvalid();
    return requestId;
  } catch (error) {
    if (error instanceof RuntimeServiceError && internalServiceErrors.has(error)) throw error;
    controlInvalid();
  }
}

async function readStatusResponse(
  options: RequestServiceStatusOptions,
  requestId: string,
): Promise<ServiceStatusV1> {
  await assertPrivateRuntimeDirectory(options.socketPath);
  const expectedSocket = await privateSocketIdentity(options.socketPath);
  if (expectedSocket === undefined) unavailable();
  const timeout = options.idleTimeoutMs ?? 5_000;
  if (timeout !== 5_000) controlInvalid();
  const request = `${canonicalJson({
    schema_version: "service-control-request.v1",
    document_type: "service-control-request",
    request_id: requestId,
    command: "status",
  })}\n`;

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
    socket.once("connect", () => socket.end(request));
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
  if (parsed.value.request_id !== requestId) unavailable();
  if (!parsed.value.ok || parsed.value.status === null) {
    const code = parsed.value.error?.code as RuntimeServiceErrorCode | undefined;
    if (code === undefined) unavailable();
    throw serviceError(code);
  }
  return parsed.value.status;
}

export async function requestServiceStatus(
  options: RequestServiceStatusOptions,
): Promise<ServiceStatusV1> {
  try {
    const requestId = requestIdFor(options);
    return await readStatusResponse(options, requestId);
  } catch (error) {
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
