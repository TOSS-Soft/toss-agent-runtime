import { createHash } from "node:crypto";
import { once } from "node:events";
import { renameSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalJson } from "../src/protocol/json.js";
import type { ServiceStatusV1 } from "../src/service/contracts.js";
import { RuntimeProjectError } from "../src/service/project/errors.js";
import {
  createServiceControlServer,
  probeServiceIdentity,
  requestProjectOperation,
  requestServiceStatus,
  type ServiceControlOperationHooks,
  type ServiceControlServer,
} from "../src/service/control.js";

const serviceInstanceId = "018f0f64-7b21-7d4f-8c3d-4a30413d5f41";
const fixedRequestId = "018f0f64-7b21-7d4f-8c3d-4a30413d5f42";
const otherRequestId = "018f0f64-7b21-7d4f-8c3d-4a30413d5f43";
const currentPublicationGuard =
  ".c8fcfb3a77b48dbef2c3eab57379addc10c8368ab3418574a3d8dc1c68536feb9";
const currentStagedSocket = ".siieudk9fi1";
const previousStagedSocket = ".s8ii47i6hu9f6rrdwudifbfef5";
const legacyStagedSocket = ".c8fcfb3a7";
const socketClaimPattern = /^\.x[0-9a-z]{10}$/u;
const reservedArtifactBasenames = [
  ".c1234abcd",
  `.c${"a".repeat(64)}`,
  `.r${"a".repeat(64)}`,
  `.s${"a".repeat(25)}`,
  ".sabcdefghij",
  ".xabcdefghij",
] as const;
const nearMissArtifactBasenames = [
  "xabcdefghij",
  ".xabcdefghi",
  ".xabcdefghijk",
  ".xabcdefghiA",
  ".xabcdefghié",
  ".sabcdefghi",
  ".sabcdefghijk",
  `.s${"a".repeat(24)}`,
  `.s${"a".repeat(26)}`,
  ".cgggggggg",
  `.c${"a".repeat(63)}`,
  `.c${"a".repeat(63)}g`,
  `.r${"a".repeat(63)}`,
  `.r${"a".repeat(63)}g`,
] as const;
const temporaryDirectories: string[] = [];
const controlServers: ServiceControlServer[] = [];
const nativeServers: Server[] = [];
const clientSockets = new Set<Socket>();

type SocketClaimTestHooks = ServiceControlOperationHooks & {
  readonly createSocketClaimToken?: () => string;
  readonly beforeSocketClaimDestinationCheck?: (
    candidatePath: string,
    claimPath: string,
  ) => Promise<void>;
  readonly afterSocketClaimParentSync?: (candidatePath: string, claimPath: string) => Promise<void>;
};

let runtimePath: string;
let temporaryRoot: string;
let socketPath: string;
let statusCalls: number;

function status(): ServiceStatusV1 {
  statusCalls += 1;
  return {
    package_version: "1.2.3",
    service_instance_id: serviceInstanceId,
    pid: 4200,
    started_at: "2026-08-19T12:00:00.000Z",
    health: "healthy",
    accepting: true,
  };
}

function options(
  overrides: Partial<Parameters<typeof createServiceControlServer>[0]> = {},
): Parameters<typeof createServiceControlServer>[0] {
  return {
    socketPath,
    serviceInstanceId,
    status,
    idleTimeoutMs: 5_000,
    maxConnections: 32,
    cacheSize: 256,
    ...overrides,
  };
}

function statusRequest(requestId: string): string {
  return `${canonicalJson({
    schema_version: "service-control-request.v1",
    document_type: "service-control-request",
    request_id: requestId,
    command: "status",
  })}\n`;
}

function projectRequest(
  command: "project-register" | "project-unregister" | "project-list",
  requestId = fixedRequestId,
  argument: Readonly<{ root?: string; project_id?: string }> = {},
): string {
  return `${canonicalJson({
    schema_version: "service-control-request.v1",
    document_type: "service-control-request",
    request_id: requestId,
    command,
    ...(command === "project-list" ? {} : { operation_id: fixedOperationId }),
    ...argument,
  })}\n`;
}

const projectRegistration = {
  project_id: "00000000-0000-4000-8000-000000000001",
  registry_revision: 1,
  canonical_root: "/private/tmp/project",
  manifest_hash: `sha256:${"a".repeat(64)}` as const,
  state: "ACTIVE",
} as const;
const fixedOperationId = "00000000-0000-4000-8000-000000000090";

function numberedRequestId(index: number): string {
  return `018f0f64-7b21-7d4f-8c3d-${index.toString(16).padStart(12, "0")}`;
}

function responseFrom(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}

async function openClient(candidate: string = socketPath): Promise<Socket> {
  const socket = createConnection({ path: candidate });
  clientSockets.add(socket);
  socket.once("close", () => clientSockets.delete(socket));
  await once(socket, "connect");
  return socket;
}

async function openHalfOpenClient(candidate: string = socketPath): Promise<Socket> {
  const socket = new Socket({ allowHalfOpen: true });
  clientSockets.add(socket);
  socket.once("close", () => clientSockets.delete(socket));
  socket.connect({ path: candidate });
  await once(socket, "connect");
  return socket;
}

async function connectUntilClosed(candidate: string = socketPath): Promise<void> {
  const socket = new Socket();
  clientSockets.add(socket);
  socket.once("close", () => clientSockets.delete(socket));
  await new Promise<void>((resolve) => {
    socket.once("error", () => undefined);
    socket.once("close", resolve);
    socket.connect({ path: candidate });
  });
}

interface PathSnapshot {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly kind: "directory" | "file" | "socket" | "symlink";
  readonly content: readonly string[] | string | null;
}

async function snapshotPath(candidate: string): Promise<PathSnapshot> {
  const metadata = await lstat(candidate);
  const kind = metadata.isDirectory()
    ? "directory"
    : metadata.isFile()
      ? "file"
      : metadata.isSocket()
        ? "socket"
        : "symlink";
  const content =
    kind === "directory"
      ? (await readdir(candidate)).sort()
      : kind === "file"
        ? await readFile(candidate, "utf8")
        : kind === "symlink"
          ? await readlink(candidate)
          : null;
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    kind,
    content,
  };
}

function classifyActualOwner(userId: number): "root" | "current-user" | "other" {
  if (userId === 0) return "root";
  return typeof process.getuid === "function" && process.getuid() === userId
    ? "current-user"
    : "other";
}

function replaceSocketOnSecondOwnershipCheck(options: {
  readonly target: string;
  readonly displaced: string;
  readonly replacement: string;
}): (userId: number, candidate: string) => "root" | "current-user" | "other" {
  let targetChecks = 0;
  return (userId, candidate) => {
    if (candidate === options.target) {
      targetChecks += 1;
      if (targetChecks === 2) {
        renameSync(options.target, options.displaced);
        renameSync(options.replacement, options.target);
      }
    }
    return classifyActualOwner(userId);
  };
}

function replaceSocketOnMatchingOwnershipCheck(options: {
  readonly matches: (candidate: string) => boolean;
  readonly check: number;
  readonly displaced: string;
  readonly replacement: string;
}): (userId: number, candidate: string) => "root" | "current-user" | "other" {
  let targetChecks = 0;
  return (userId, candidate) => {
    if (options.matches(candidate)) {
      targetChecks += 1;
      if (targetChecks === options.check) {
        renameSync(candidate, options.displaced);
        renameSync(options.replacement, candidate);
      }
    }
    return classifyActualOwner(userId);
  };
}

function socketClaimEntries(entries: readonly string[]): readonly string[] {
  return entries.filter((entry) => socketClaimPattern.test(entry)).sort();
}

async function sendRaw(bytes: string | Uint8Array): Promise<string> {
  const socket = await openClient();
  const response = responseFrom(socket);
  socket.end(bytes);
  return response;
}

async function listenControl(
  overrides: Partial<Parameters<typeof createServiceControlServer>[0]> = {},
): Promise<ServiceControlServer> {
  const server = createServiceControlServer(options(overrides));
  controlServers.push(server);
  await server.listen();
  return server;
}

async function listenNative(candidate: string, allowHalfOpen = false): Promise<Server> {
  const server = createServer({ allowHalfOpen });
  nativeServers.push(server);
  server.listen(candidate);
  await once(server, "listening");
  return server;
}

async function closeNative(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  const index = nativeServers.indexOf(server);
  if (index >= 0) nativeServers.splice(index, 1);
}

async function nativePathBindsExactly(candidate: string): Promise<boolean> {
  const server = createServer();
  const listened = await new Promise<boolean>((resolve) => {
    const onError = (): void => {
      server.off("listening", onListening);
      resolve(false);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(candidate);
  });
  if (!listened) return false;
  let exact = false;
  try {
    exact = (await lstat(candidate)).isSocket();
  } catch {
    // Some Unix implementations accept then truncate an overlong pathname.
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return exact;
}

async function findNativeSocketPathBoundary(
  basename: string,
): Promise<{ readonly exact: string; readonly firstInexact: string }> {
  let exact: string | undefined;
  for (let padding = 0; padding < 256; padding += 1) {
    const candidateRuntime = path.join(temporaryRoot, `b${"x".repeat(padding)}`);
    await mkdir(candidateRuntime, { mode: 0o700 });
    await chmod(candidateRuntime, 0o700);
    const candidate = path.join(candidateRuntime, basename);
    if (await nativePathBindsExactly(candidate)) {
      if (exact !== undefined) await rmdir(path.dirname(exact));
      exact = candidate;
      continue;
    }
    await rm(candidateRuntime, { force: true, recursive: true });
    await mkdir(candidateRuntime, { mode: 0o700 });
    await chmod(candidateRuntime, 0o700);
    if (exact === undefined) throw new Error("native Unix socket path boundary was too short");
    return { exact, firstInexact: candidate };
  }
  throw new Error("native Unix socket path boundary was not found");
}

async function useShortRuntimePath(basename: string): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(await realpath("/tmp"), "trc-short-")));
  temporaryDirectories.push(root);
  await chmod(root, 0o700);
  temporaryRoot = root;
  runtimePath = path.join(root, "r");
  await mkdir(runtimePath, { mode: 0o700 });
  await chmod(runtimePath, 0o700);
  socketPath = path.join(runtimePath, basename);
}

function firstIdentityBoundSocketClaimName(device: bigint, inode: bigint): string {
  const entropy = BigInt(
    `0x${createHash("sha256")
      .update(device.toString(), "utf8")
      .update("\u0000", "utf8")
      .update(inode.toString(), "utf8")
      .update("\u0000", "utf8")
      .update("0", "utf8")
      .digest("hex")}`,
  );
  return `.x${(entropy % 36n ** 10n).toString(36).padStart(10, "0")}`;
}

async function leaveClosedSocketLinks(...candidates: readonly string[]): Promise<void> {
  const source = path.join(runtimePath, "crash-source.sock");
  const server = await listenNative(source);
  await chmod(source, 0o600);
  for (const candidate of candidates) await link(source, candidate);
  await unlink(source);
  await closeNative(server);
}

async function pathIsMissing(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return false;
  } catch (error) {
    return (
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
  }
}

beforeEach(async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "trc-")));
  temporaryDirectories.push(root);
  await chmod(root, 0o700);
  temporaryRoot = root;
  runtimePath = path.join(root, "runtime");
  await mkdir(runtimePath, { mode: 0o700 });
  await chmod(runtimePath, 0o700);
  socketPath = path.join(runtimePath, "runtime.sock");
  statusCalls = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of clientSockets) socket.destroy();
  clientSockets.clear();
  await Promise.allSettled(controlServers.splice(0).map((server) => server.close()));
  await Promise.allSettled(nativeServers.splice(0).map((server) => closeNative(server)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("private service control socket", () => {
  it("announces listening only after the Unix socket is mode 0600", async () => {
    const server = createServiceControlServer(options());
    controlServers.push(server);

    await server.listen();

    const metadata = await lstat(socketPath);
    expect(metadata.isSocket()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o600);
  });

  it("requires a current-user-owned runtime directory with exact mode 0700", async () => {
    await chmod(runtimePath, 0o755);
    const server = createServiceControlServer(options());
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await pathIsMissing(socketPath)).toBe(true);
  });

  it("fails closed when an ancestor of the private runtime directory is a symlink", async () => {
    const actualRoot = path.join(temporaryRoot, "actual");
    const actualRuntime = path.join(actualRoot, "runtime");
    await mkdir(actualRoot, { mode: 0o700 });
    await mkdir(actualRuntime, { mode: 0o700 });
    await symlink(actualRoot, path.join(temporaryRoot, "linked"));
    socketPath = path.join(temporaryRoot, "linked", "runtime", "runtime.sock");
    const server = createServiceControlServer(options());
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await pathIsMissing(path.join(actualRuntime, "runtime.sock"))).toBe(true);
  });

  it("treats modeled uid 0 private paths as current-user-owned for a root process", async () => {
    const server = createServiceControlServer(
      options({
        classifyPathOwner: (_userId: number, candidate: string) =>
          candidate === temporaryRoot ||
          candidate === runtimePath ||
          path.dirname(candidate) === runtimePath
            ? 0
            : "root",
        currentUid: () => 0,
      }),
    );
    controlServers.push(server);

    await server.listen();

    const metadata = await lstat(socketPath);
    expect(metadata.isSocket()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o600);
  });

  it("allows a modeled root process through a leading UID-0 sticky directory", async () => {
    await chmod(temporaryRoot, 0o1777);
    const server = createServiceControlServer(
      options({
        classifyPathOwner: () => 0,
        currentUid: () => 0,
      }),
    );
    controlServers.push(server);

    await server.listen();

    const runtime = await lstat(runtimePath);
    const socket = await lstat(socketPath);
    expect(runtime.mode & 0o777).toBe(0o700);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
  });

  it("rejects an injected non-root, non-current owner in the runtime ancestry", async () => {
    const filesystemRoot = path.parse(runtimePath).root;
    const server = createServiceControlServer(
      options({
        classifyPathOwner: (userId: number, candidate: string) =>
          candidate === filesystemRoot ? "other" : classifyActualOwner(userId),
      }),
    );
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await pathIsMissing(socketPath)).toBe(true);
  });

  it("allows writable leading root ancestry only when the injected root directory is sticky", async () => {
    const classifyLeadingAncestorsAsRoot = (_userId: number, candidate: string) => {
      if (candidate === runtimePath || path.dirname(candidate) === runtimePath) {
        return "current-user" as const;
      }
      return "root" as const;
    };
    await chmod(temporaryRoot, 0o777);
    const unsafe = createServiceControlServer(
      options({ classifyPathOwner: classifyLeadingAncestorsAsRoot }),
    );
    controlServers.push(unsafe);
    await expect(unsafe.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });

    await chmod(temporaryRoot, 0o1777);
    const sticky = createServiceControlServer(
      options({ classifyPathOwner: classifyLeadingAncestorsAsRoot }),
    );
    controlServers.push(sticky);
    await sticky.listen();

    expect((await lstat(socketPath)).isSocket()).toBe(true);
  });

  it("fails closed for distinct bigint identities that collapse to the same number", async () => {
    const firstInode = 9_007_199_254_740_992n;
    const replacementInode = 9_007_199_254_740_993n;
    expect(Number(firstInode)).toBe(Number(replacementInode));
    let runtimeObservations = 0;
    const server = createServiceControlServer(
      options({
        operationHooks: {
          modelRuntimeIdentity: (candidatePath, observed) => {
            if (candidatePath !== runtimePath) return observed;
            runtimeObservations += 1;
            return {
              device: 9_007_199_254_740_994n,
              inode: runtimeObservations === 1 ? firstInode : replacementInode,
            };
          },
        },
      }),
    );
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await pathIsMissing(socketPath)).toBe(true);
  });

  it("preserves a public-socket replacement inserted after final validation", async () => {
    const displaced = path.join(runtimePath, "displaced-public.sock");
    const preparedReplacement = path.join(runtimePath, "prepared-public.sock");
    await leaveClosedSocketLinks(socketPath);
    const original = await snapshotPath(socketPath);
    await leaveClosedSocketLinks(preparedReplacement);
    const replacement = await snapshotPath(preparedReplacement);
    const server = createServiceControlServer(
      options({
        classifyPathOwner: replaceSocketOnSecondOwnershipCheck({
          target: socketPath,
          displaced,
          replacement: preparedReplacement,
        }),
      }),
    );
    controlServers.push(server);
    let failure: unknown;

    try {
      await server.listen();
    } catch (error) {
      failure = error;
    }

    const claims = socketClaimEntries(await readdir(runtimePath));
    expect(claims).toHaveLength(1);
    expect(await snapshotPath(displaced)).toEqual(original);
    expect(await snapshotPath(path.join(runtimePath, claims[0]!))).toEqual(replacement);
    expect(await pathIsMissing(socketPath)).toBe(true);
    expect(failure).toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });

    const retry = createServiceControlServer(options());
    controlServers.push(retry);
    await expect(retry.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await snapshotPath(path.join(runtimePath, claims[0]!))).toEqual(replacement);
  });

  it("preserves a staged-socket replacement inserted after final validation", async () => {
    const stagedPath = path.join(runtimePath, currentStagedSocket);
    const displaced = path.join(runtimePath, "displaced-final-stage.sock");
    const preparedReplacement = path.join(runtimePath, "prepared-stage.sock");
    await leaveClosedSocketLinks(stagedPath);
    const original = await snapshotPath(stagedPath);
    await leaveClosedSocketLinks(preparedReplacement);
    const replacement = await snapshotPath(preparedReplacement);
    const server = createServiceControlServer(
      options({
        classifyPathOwner: replaceSocketOnSecondOwnershipCheck({
          target: stagedPath,
          displaced,
          replacement: preparedReplacement,
        }),
      }),
    );
    controlServers.push(server);
    let failure: unknown;

    try {
      await server.listen();
    } catch (error) {
      failure = error;
    }

    const claims = socketClaimEntries(await readdir(runtimePath));
    expect(claims).toHaveLength(1);
    expect(await snapshotPath(displaced)).toEqual(original);
    expect(await snapshotPath(path.join(runtimePath, claims[0]!))).toEqual(replacement);
    expect(await pathIsMissing(stagedPath)).toBe(true);
    expect(await pathIsMissing(socketPath)).toBe(true);
    expect(failure).toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });

    const retry = createServiceControlServer(options());
    controlServers.push(retry);
    await expect(retry.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await snapshotPath(path.join(runtimePath, claims[0]!))).toEqual(replacement);
  });

  it("preserves a public-socket claim replacement inserted after final claim validation", async () => {
    const claimPath = path.join(runtimePath, ".x0123456789");
    const displaced = path.join(runtimePath, "displaced-public-claim.sock");
    const preparedReplacement = path.join(runtimePath, "prepared-public-claim.sock");
    await leaveClosedSocketLinks(socketPath);
    const original = await snapshotPath(socketPath);
    await leaveClosedSocketLinks(preparedReplacement);
    const replacement = await snapshotPath(preparedReplacement);
    const server = createServiceControlServer(
      options({
        classifyPathOwner: replaceSocketOnMatchingOwnershipCheck({
          matches: (candidate) => candidate === claimPath,
          check: 3,
          displaced,
          replacement: preparedReplacement,
        }),
        operationHooks: { createSocketClaimToken: () => "0123456789" },
      }),
    );
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await snapshotPath(displaced)).toEqual(original);
    expect(await snapshotPath(claimPath)).toEqual(replacement);
    expect(await pathIsMissing(socketPath)).toBe(true);
  });

  it("preserves a staged-socket claim replacement inserted after final claim validation", async () => {
    const stagedPath = path.join(runtimePath, currentStagedSocket);
    const claimPath = path.join(runtimePath, ".x0123456789");
    const displaced = path.join(runtimePath, "displaced-stage-claim.sock");
    const preparedReplacement = path.join(runtimePath, "prepared-stage-claim.sock");
    await leaveClosedSocketLinks(stagedPath);
    const original = await snapshotPath(stagedPath);
    await leaveClosedSocketLinks(preparedReplacement);
    const replacement = await snapshotPath(preparedReplacement);
    const server = createServiceControlServer(
      options({
        classifyPathOwner: replaceSocketOnMatchingOwnershipCheck({
          matches: (candidate) => candidate === claimPath,
          check: 3,
          displaced,
          replacement: preparedReplacement,
        }),
        operationHooks: { createSocketClaimToken: () => "0123456789" },
      }),
    );
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await snapshotPath(displaced)).toEqual(original);
    expect(await snapshotPath(claimPath)).toEqual(replacement);
    expect(await pathIsMissing(stagedPath)).toBe(true);
    expect(await pathIsMissing(socketPath)).toBe(true);
  });

  it("reclaims one private crash-left socket claim before publishing", async () => {
    await leaveClosedSocketLinks(socketPath);
    let claimPath: string | undefined;
    const hooks: SocketClaimTestHooks = {
      afterSocketClaimParentSync: (candidatePath, candidateClaimPath) => {
        expect(candidatePath).toBe(socketPath);
        claimPath = candidateClaimPath;
        return Promise.reject(new Error("simulated socket-claim interruption"));
      },
    };
    const interrupted = createServiceControlServer(options({ operationHooks: hooks }));
    controlServers.push(interrupted);

    await expect(interrupted.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(path.basename(claimPath!)).toMatch(socketClaimPattern);
    expect((await lstat(claimPath!)).isSocket()).toBe(true);
    expect(await pathIsMissing(socketPath)).toBe(true);

    const server = await listenControl();

    expect((await readdir(runtimePath)).sort()).toEqual([currentPublicationGuard, "runtime.sock"]);
    await server.close();
    expect(await readdir(runtimePath)).toEqual([]);
  });

  it("fails closed without moving a live crash-left socket claim", async () => {
    const claimPath = path.join(runtimePath, ".xabcdefghij");
    await listenNative(claimPath);
    await chmod(claimPath, 0o600);
    const before = await snapshotPath(claimPath);
    const server = createServiceControlServer(options());
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_ALREADY_RUNNING",
    });
    expect(await snapshotPath(claimPath)).toEqual(before);
    expect(await pathIsMissing(socketPath)).toBe(true);
  });

  it("fails closed without changing an unsafe crash-left socket claim", async () => {
    const claimPath = path.join(runtimePath, ".xabcdefghij");
    await writeFile(claimPath, "preserve-claim", { mode: 0o600 });
    const before = await snapshotPath(claimPath);
    const server = createServiceControlServer(options());
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await snapshotPath(claimPath)).toEqual(before);
    expect(await pathIsMissing(socketPath)).toBe(true);
  });

  it("fails closed when more than one socket claim is present", async () => {
    const first = path.join(runtimePath, ".xabcdefghij");
    const second = path.join(runtimePath, ".xjihgfedcba");
    await leaveClosedSocketLinks(first, second);
    const firstBefore = await snapshotPath(first);
    const secondBefore = await snapshotPath(second);
    const server = createServiceControlServer(options());
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await snapshotPath(first)).toEqual(firstBefore);
    expect(await snapshotPath(second)).toEqual(secondBefore);
    expect(await pathIsMissing(socketPath)).toBe(true);
  });

  it("preserves a socket-claim destination present at the controlled boundary", async () => {
    const claimPath = path.join(runtimePath, ".x0123456789");
    await leaveClosedSocketLinks(socketPath);
    const publicBefore = await snapshotPath(socketPath);
    let claimBefore: PathSnapshot | undefined;
    const hooks: SocketClaimTestHooks = {
      createSocketClaimToken: () => "0123456789",
      beforeSocketClaimDestinationCheck: async (candidatePath, candidateClaimPath) => {
        expect(candidatePath).toBe(socketPath);
        expect(candidateClaimPath).toBe(claimPath);
        await writeFile(candidateClaimPath, "preserve-destination", { mode: 0o600 });
        claimBefore = await snapshotPath(candidateClaimPath);
      },
    };
    const server = createServiceControlServer(options({ operationHooks: hooks }));
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await snapshotPath(socketPath)).toEqual(publicBefore);
    expect(await snapshotPath(claimPath)).toEqual(claimBefore);
  });

  it("preserves source reappearance after a staged socket is durably claimed", async () => {
    const stagedPath = path.join(runtimePath, currentStagedSocket);
    const preparedReplacement = path.join(runtimePath, "prepared-reappearance.sock");
    await leaveClosedSocketLinks(stagedPath);
    const original = await snapshotPath(stagedPath);
    await leaveClosedSocketLinks(preparedReplacement);
    const replacement = await snapshotPath(preparedReplacement);
    const server = createServiceControlServer(
      options({
        operationHooks: {
          afterStagedSocketParentSync: async (candidatePath) => {
            expect(candidatePath).toBe(stagedPath);
            await rename(preparedReplacement, candidatePath);
          },
        },
      }),
    );
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    const claims = socketClaimEntries(await readdir(runtimePath));
    expect(claims).toHaveLength(1);
    expect(await snapshotPath(stagedPath)).toEqual(replacement);
    expect(await snapshotPath(path.join(runtimePath, claims[0]!))).toEqual(original);
    expect(await pathIsMissing(socketPath)).toBe(true);
  });

  it("publishes and reclaims at the native exact Unix socket path boundary", async () => {
    const boundary = await findNativeSocketPathBoundary("runtime.sock");
    expect(Buffer.byteLength(boundary.firstInexact)).toBe(Buffer.byteLength(boundary.exact) + 1);
    expect(await nativePathBindsExactly(boundary.firstInexact)).toBe(false);
    expect(await nativePathBindsExactly(boundary.exact)).toBe(true);
    runtimePath = path.dirname(boundary.exact);
    socketPath = boundary.exact;
    let stagedPath: string | undefined;
    const server = await listenControl({
      operationHooks: {
        beforePublish: async () => {
          for (const entry of await readdir(runtimePath)) {
            const candidate = path.join(runtimePath, entry);
            if ((await lstat(candidate)).isSocket()) stagedPath = candidate;
          }
        },
      },
    });

    expect(stagedPath).toBeDefined();
    expect(path.basename(stagedPath!)).toBe(currentStagedSocket);
    expect(Buffer.byteLength(stagedPath!)).toBeLessThanOrEqual(Buffer.byteLength(socketPath));
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    await server.close();

    const crashed = await listenNative(socketPath);
    await chmod(socketPath, 0o600);
    await link(socketPath, stagedPath!);
    await unlink(socketPath);
    await closeNative(crashed);
    expect((await lstat(stagedPath!)).isSocket()).toBe(true);

    const recovered = await listenControl();
    expect(await pathIsMissing(stagedPath!)).toBe(true);
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    await recovered.close();
    expect(await readdir(runtimePath)).toEqual([]);
  });

  it.runIf(process.platform === "darwin")(
    "rejects a native-exact short public path before its longer internal stage is created",
    async () => {
      const boundary = await findNativeSocketPathBoundary("a");
      runtimePath = path.dirname(boundary.exact);
      socketPath = boundary.exact;
      const internalStage = path.join(runtimePath, currentStagedSocket);
      expect(await nativePathBindsExactly(socketPath)).toBe(true);
      expect(Buffer.byteLength(socketPath)).toBe(104);
      expect(Buffer.byteLength(internalStage)).toBeGreaterThan(
        Buffer.byteLength(boundary.firstInexact),
      );
      const server = createServiceControlServer(options());
      controlServers.push(server);

      await expect(server.listen()).rejects.toMatchObject({
        code: "RUNTIME_SERVICE_PATH_UNSAFE",
      });
      expect(await readdir(runtimePath)).toEqual([]);
      expect(statusCalls).toBe(0);
    },
  );

  it("rejects an injected socket layout budget before creating runtime artifacts", async () => {
    socketPath = path.join(runtimePath, "a");
    const server = createServiceControlServer(
      options({
        socketPathPlatform: "darwin",
        socketPathByteLimit: Buffer.byteLength(socketPath),
      }),
    );
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await readdir(runtimePath)).toEqual([]);
    expect(statusCalls).toBe(0);
  });

  it("counts multibyte runtime and basename characters as UTF-8 socket-path bytes", async () => {
    runtimePath = path.join(runtimePath, "🚀");
    await mkdir(runtimePath, { mode: 0o700 });
    await chmod(runtimePath, 0o700);
    socketPath = path.join(runtimePath, "é");
    const internalClaim = path.join(runtimePath, ".x0123456789");
    const server = createServiceControlServer(
      options({
        socketPathPlatform: "linux",
        socketPathByteLimit: Buffer.byteLength(internalClaim) - 1,
      }),
    );
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await readdir(runtimePath)).toEqual([]);
  });

  it("accepts a short public socket at the exact injected internal-sibling budget", async () => {
    socketPath = path.join(runtimePath, "a");
    const internalStage = path.join(runtimePath, currentStagedSocket);
    const server = await listenControl({
      socketPathPlatform: "linux",
      socketPathByteLimit: Buffer.byteLength(internalStage),
    });

    expect((await lstat(socketPath)).isSocket()).toBe(true);
    await server.close();
    expect(await readdir(runtimePath)).toEqual([]);
  });

  it.each(reservedArtifactBasenames)(
    "rejects the reserved public socket basename %s before creating artifacts",
    async (basename) => {
      await useShortRuntimePath(basename);
      const server = createServiceControlServer(options());
      controlServers.push(server);

      await expect(server.listen()).rejects.toMatchObject({
        code: "RUNTIME_SERVICE_PATH_UNSAFE",
      });
      expect(await readdir(runtimePath)).toEqual([]);
      expect(statusCalls).toBe(0);
    },
  );

  it.each(nearMissArtifactBasenames)(
    "allows the non-reserved public socket basename %s",
    async (basename) => {
      await useShortRuntimePath(basename);
      const server = await listenControl();

      expect((await lstat(socketPath)).isSocket()).toBe(true);
      await server.close();
      expect(await readdir(runtimePath)).toEqual([]);
    },
  );

  it("preserves a crash-left public socket whose basename equals its recovery claim token", async () => {
    await useShortRuntimePath("source.sock");
    const crashed = await listenNative(socketPath);
    await chmod(socketPath, 0o600);
    const crashedIdentity = await lstat(socketPath, { bigint: true });
    const reservedPath = path.join(
      runtimePath,
      firstIdentityBoundSocketClaimName(crashedIdentity.dev, crashedIdentity.ino),
    );
    await link(socketPath, reservedPath);
    await closeNative(crashed);
    socketPath = reservedPath;
    const before = await snapshotPath(socketPath);
    const server = createServiceControlServer(options());
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await snapshotPath(socketPath)).toEqual(before);
    expect(await readdir(runtimePath)).toEqual([path.basename(socketPath)]);
  });

  it.each([legacyStagedSocket, previousStagedSocket, currentStagedSocket])(
    "reclaims a crashed staged socket before publication: %s",
    async (stagedName) => {
      const stagedPath = path.join(runtimePath, stagedName);
      await leaveClosedSocketLinks(stagedPath);
      expect((await lstat(stagedPath)).isSocket()).toBe(true);

      const server = await listenControl();

      expect((await readdir(runtimePath)).sort()).toEqual([
        currentPublicationGuard,
        "runtime.sock",
      ]);
      await server.close();
      expect(await readdir(runtimePath)).toEqual([]);
    },
  );

  it.each([legacyStagedSocket, previousStagedSocket, currentStagedSocket])(
    "reclaims a crash between hard-link publication and staged unlink: %s",
    async (stagedName) => {
      const stagedPath = path.join(runtimePath, stagedName);
      await leaveClosedSocketLinks(stagedPath, socketPath);
      const stagedBefore = await snapshotPath(stagedPath);
      const publicBefore = await snapshotPath(socketPath);
      expect(stagedBefore.kind).toBe("socket");
      expect(publicBefore.kind).toBe("socket");
      expect(publicBefore.device).toBe(stagedBefore.device);
      expect(publicBefore.inode).toBe(stagedBefore.inode);

      const server = await listenControl();

      expect((await readdir(runtimePath)).sort()).toEqual([
        currentPublicationGuard,
        "runtime.sock",
      ]);
      expect((await lstat(socketPath)).isSocket()).toBe(true);
      await server.close();
      expect(await readdir(runtimePath)).toEqual([]);
    },
  );

  it.each([legacyStagedSocket, previousStagedSocket, currentStagedSocket])(
    "fails closed without removing a live staged socket: %s",
    async (stagedName) => {
      const stagedPath = path.join(runtimePath, stagedName);
      await listenNative(stagedPath);
      await chmod(stagedPath, 0o600);
      const before = await snapshotPath(stagedPath);
      const server = createServiceControlServer(options());
      controlServers.push(server);

      await expect(server.listen()).rejects.toMatchObject({
        code: "RUNTIME_SERVICE_ALREADY_RUNNING",
      });
      expect(await snapshotPath(stagedPath)).toEqual(before);
      expect(await pathIsMissing(socketPath)).toBe(true);
    },
  );

  it.each(["symlink", "regular file", "wrong-mode socket"] as const)(
    "fails closed without changing an unsafe recognized staged socket: %s",
    async (kind) => {
      const stagedPath = path.join(runtimePath, currentStagedSocket);
      if (kind === "symlink") {
        const target = path.join(runtimePath, "staged-target");
        await writeFile(target, "preserve-target", { mode: 0o600 });
        await symlink(target, stagedPath);
      } else if (kind === "regular file") {
        await writeFile(stagedPath, "preserve-file", { mode: 0o600 });
      } else {
        await leaveClosedSocketLinks(stagedPath);
        await chmod(stagedPath, 0o644);
      }
      const before = await snapshotPath(stagedPath);
      const server = createServiceControlServer(options());
      controlServers.push(server);

      await expect(server.listen()).rejects.toMatchObject({
        code: "RUNTIME_SERVICE_PATH_UNSAFE",
      });
      expect(await snapshotPath(stagedPath)).toEqual(before);
      expect(await pathIsMissing(socketPath)).toBe(true);
    },
  );

  it("preserves a staged-socket replacement inserted after the listener probe", async () => {
    const stagedPath = path.join(runtimePath, currentStagedSocket);
    const displaced = path.join(runtimePath, "displaced-staged.sock");
    await leaveClosedSocketLinks(stagedPath);
    let replacement: PathSnapshot | undefined;
    const server = createServiceControlServer(
      options({
        operationHooks: {
          beforeStagedSocketUnlink: async (candidatePath) => {
            expect(candidatePath).toBe(stagedPath);
            await rename(candidatePath, displaced);
            await writeFile(candidatePath, "preserve-replacement", { mode: 0o600 });
            replacement = await snapshotPath(candidatePath);
          },
        },
      }),
    );
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await snapshotPath(stagedPath)).toEqual(replacement);
    expect((await lstat(displaced)).isSocket()).toBe(true);
    expect(await pathIsMissing(socketPath)).toBe(true);
  });

  it("revalidates the synced runtime parent after staged-socket removal", async () => {
    const stagedPath = path.join(runtimePath, currentStagedSocket);
    const displacedRuntime = `${runtimePath}.displaced`;
    await leaveClosedSocketLinks(stagedPath);
    const server = createServiceControlServer(
      options({
        operationHooks: {
          afterStagedSocketParentSync: async (candidatePath) => {
            expect(candidatePath).toBe(stagedPath);
            await rename(runtimePath, displacedRuntime);
            await mkdir(runtimePath, { mode: 0o700 });
            await chmod(runtimePath, 0o700);
          },
        },
      }),
    );
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await readdir(runtimePath)).toEqual([]);
    expect(await pathIsMissing(path.join(displacedRuntime, currentStagedSocket))).toBe(true);
    expect(await pathIsMissing(socketPath)).toBe(true);
  });

  it("reclaims legacy, full-hash, and interrupted-claim guards before publishing one current guard", async () => {
    const staleGuards = [`.c${"1".repeat(8)}`, `.c${"2".repeat(64)}`, `.r${"3".repeat(64)}`];
    for (const name of staleGuards) {
      const candidate = path.join(runtimePath, name);
      await mkdir(candidate, { mode: 0o700 });
      await chmod(candidate, 0o700);
    }

    const server = await listenControl();

    expect((await readdir(runtimePath)).sort()).toEqual([currentPublicationGuard, "runtime.sock"]);
    await server.close();
    expect(await readdir(runtimePath)).toEqual([]);
  });

  it.each(["symlink", "regular file", "wrong mode", "nonempty directory"] as const)(
    "fails closed without changing an unsafe stale publication guard: %s",
    async (kind) => {
      const candidate = path.join(runtimePath, `.c${"4".repeat(64)}`);
      if (kind === "symlink") {
        const target = path.join(runtimePath, "guard-target");
        await writeFile(target, "preserve-target", { mode: 0o600 });
        await symlink(target, candidate);
      } else if (kind === "regular file") {
        await writeFile(candidate, "preserve-file", { mode: 0o600 });
      } else {
        await mkdir(candidate, { mode: kind === "wrong mode" ? 0o755 : 0o700 });
        await chmod(candidate, kind === "wrong mode" ? 0o755 : 0o700);
        if (kind === "nonempty directory") {
          await writeFile(path.join(candidate, "preserve-child"), "preserve-child", {
            mode: 0o600,
          });
        }
      }
      const before = await snapshotPath(candidate);
      const server = createServiceControlServer(options());
      controlServers.push(server);

      await expect(server.listen()).rejects.toMatchObject({
        code: "RUNTIME_SERVICE_PATH_UNSAFE",
      });

      expect(await snapshotPath(candidate)).toEqual(before);
      expect(await pathIsMissing(socketPath)).toBe(true);
    },
  );

  it("deletes only the exact guard inode atomically claimed for reclamation", async () => {
    const staleGuard = path.join(runtimePath, `.c${"5".repeat(64)}`);
    await mkdir(staleGuard, { mode: 0o700 });
    await chmod(staleGuard, 0o700);
    const original = await snapshotPath(staleGuard);
    let claimedPath: string | undefined;
    let replacement: PathSnapshot | undefined;
    const server = createServiceControlServer(
      options({
        operationHooks: {
          afterPublicationGuardClaim: async (_candidatePath: string, claimPath: string) => {
            claimedPath = claimPath;
            await rename(claimPath, staleGuard);
            await mkdir(claimPath, { mode: 0o700 });
            await chmod(claimPath, 0o700);
            replacement = await snapshotPath(claimPath);
          },
        },
      }),
    );
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });

    expect(claimedPath).toMatch(new RegExp(`^${runtimePath}/\\.r[0-9a-f]{64}$`, "u"));
    expect(await snapshotPath(staleGuard)).toEqual(original);
    expect(await snapshotPath(claimedPath!)).toEqual(replacement);
    expect(await pathIsMissing(socketPath)).toBe(true);
  });

  it("reclaims an interrupted recognized guard claim on the next safe startup", async () => {
    const staleGuard = path.join(runtimePath, `.c${"6".repeat(64)}`);
    await mkdir(staleGuard, { mode: 0o700 });
    await chmod(staleGuard, 0o700);
    let interruptedClaim: string | undefined;
    const interrupted = createServiceControlServer(
      options({
        operationHooks: {
          afterPublicationGuardClaim: (_candidatePath: string, claimPath: string) => {
            interruptedClaim = claimPath;
            return Promise.reject(new Error("simulated reclamation interruption"));
          },
        },
      }),
    );
    controlServers.push(interrupted);

    await expect(interrupted.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(path.basename(interruptedClaim!)).toMatch(/^\.r[0-9a-f]{64}$/u);
    expect((await lstat(interruptedClaim!)).isDirectory()).toBe(true);

    await listenControl();

    expect((await readdir(runtimePath)).sort()).toEqual([currentPublicationGuard, "runtime.sock"]);
  });

  it.each([
    [
      "mode",
      async () => {
        await chmod(runtimePath, 0o755);
      },
    ],
    [
      "identity",
      async () => {
        await rename(runtimePath, `${runtimePath}.displaced`);
        await mkdir(runtimePath, { mode: 0o700 });
        await chmod(runtimePath, 0o700);
      },
    ],
  ] as const)(
    "revalidates runtime directory %s immediately before publication",
    async (_name, mutate) => {
      const server = createServiceControlServer(
        options({ operationHooks: { beforePublish: mutate } }),
      );
      controlServers.push(server);

      await expect(server.listen()).rejects.toMatchObject({
        code: "RUNTIME_SERVICE_PATH_UNSAFE",
      });
      expect(await pathIsMissing(socketPath)).toBe(true);
    },
  );

  it("removes a stale private socket only after proving it has no listener", async () => {
    const stagingPath = path.join(runtimePath, "staging.sock");
    const staleServer = await listenNative(stagingPath);
    await chmod(stagingPath, 0o600);
    await rename(stagingPath, socketPath);
    await closeNative(staleServer);
    expect((await lstat(socketPath)).isSocket()).toBe(true);

    await listenControl();

    expect(JSON.parse(await sendRaw(statusRequest(fixedRequestId)))).toMatchObject({ ok: true });
  });

  it("does not remove a private socket with an active listener", async () => {
    await listenNative(socketPath);
    await chmod(socketPath, 0o600);
    const server = createServiceControlServer(options());
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_ALREADY_RUNNING",
    });
    expect((await lstat(socketPath)).isSocket()).toBe(true);
  });

  it.each(["symlink", "regular file"])("fails closed for an existing %s target", async (kind) => {
    if (kind === "symlink") {
      await symlink(path.join(runtimePath, "missing"), socketPath);
    } else {
      await writeFile(socketPath, "do-not-delete", { mode: 0o600 });
    }
    const server = createServiceControlServer(options());
    controlServers.push(server);

    await expect(server.listen()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await pathIsMissing(socketPath)).toBe(false);
  });

  it.each(["regular file", "symlink", "foreign socket"] as const)(
    "atomically preserves a publish-time %s winner",
    async (kind) => {
      let winner: PathSnapshot | undefined;
      const beforePublish = async () => {
        if (kind === "regular file") {
          await writeFile(socketPath, "publish-winner", { mode: 0o600 });
          await chmod(socketPath, 0o600);
        } else if (kind === "symlink") {
          const target = path.join(runtimePath, "winner-target");
          await writeFile(target, "symlink-winner", { mode: 0o600 });
          await symlink(target, socketPath);
        } else {
          await listenNative(socketPath);
          await chmod(socketPath, 0o600);
        }
        winner = await snapshotPath(socketPath);
      };
      const server = createServiceControlServer(options({ operationHooks: { beforePublish } }));
      controlServers.push(server);

      await expect(server.listen()).rejects.toMatchObject({
        code: "RUNTIME_SERVICE_PATH_UNSAFE",
      });

      expect(winner).toBeDefined();
      expect(await snapshotPath(socketPath)).toEqual(winner);
    },
  );

  it("returns one cached response for a duplicate canonical request id", async () => {
    await listenControl();
    const request = statusRequest(fixedRequestId);

    const first = await sendRaw(request);
    const second = await sendRaw(request);

    expect(second).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.trim().split("\n")).toHaveLength(1);
    expect(statusCalls).toBe(1);
  });

  it("dispatches and byte-replays one completed async project operation", async () => {
    let handlerCalls = 0;
    await listenControl({
      handleProjectRequest: (request) => {
        handlerCalls += 1;
        expect(request).toMatchObject({
          command: "project-register",
          root: "/private/tmp/project",
        });
        return Promise.resolve({
          kind: "project-registration",
          registration: projectRegistration,
        });
      },
    });
    const request = projectRequest("project-register", fixedRequestId, {
      root: "/private/tmp/project",
    });

    const first = await sendRaw(request);
    const second = await sendRaw(request);

    expect(second).toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      request_id: fixedRequestId,
      ok: true,
      status: null,
      data: { kind: "project-registration", registration: projectRegistration },
      error: null,
    });
    expect(handlerCalls).toBe(1);
  });

  it("returns a fixed project error and never reflects handler details", async () => {
    const secret = "private-project-handler-stack";
    await listenControl({
      handleProjectRequest: () => {
        const error = new RuntimeProjectError("RUNTIME_PROJECT_NOT_FOUND");
        Object.assign(error, { stack: secret });
        return Promise.reject(error);
      },
    });

    const response = await sendRaw(
      projectRequest("project-unregister", fixedRequestId, {
        project_id: projectRegistration.project_id,
      }),
    );

    expect(response).not.toContain(secret);
    expect(JSON.parse(response)).toMatchObject({
      request_id: fixedRequestId,
      ok: false,
      status: null,
      data: null,
      error: { code: "RUNTIME_PROJECT_NOT_FOUND" },
    });
  });

  it("conflicts a changed project input while the original request is in flight", async () => {
    let resolveHandler: (() => void) | undefined;
    let handlerCalls = 0;
    await listenControl({
      handleProjectRequest: async () => {
        handlerCalls += 1;
        await new Promise<void>((resolve) => {
          resolveHandler = resolve;
        });
        return { kind: "project-registration", registration: projectRegistration };
      },
    });
    const original = sendRaw(
      projectRequest("project-register", fixedRequestId, { root: "/private/tmp/project" }),
    );
    await vi.waitFor(() => expect(resolveHandler).toBeTypeOf("function"));

    const conflict = await sendRaw(
      projectRequest("project-register", fixedRequestId, { root: "/private/tmp/other" }),
    );
    resolveHandler?.();
    await original;

    expect(JSON.parse(conflict)).toMatchObject({
      request_id: fixedRequestId,
      ok: false,
      error: { code: "RUNTIME_SERVICE_CONTROL_CONFLICT" },
    });
    expect(handlerCalls).toBe(1);
  });

  it("drains an in-flight project handler before shutdown completes", async () => {
    let resolveHandler: (() => void) | undefined;
    const server = await listenControl({
      handleProjectRequest: async () => {
        await new Promise<void>((resolve) => {
          resolveHandler = resolve;
        });
        return { kind: "project-list", registrations: [projectRegistration] };
      },
    });
    const response = sendRaw(projectRequest("project-list"));
    await vi.waitFor(() => expect(resolveHandler).toBeTypeOf("function"));
    server.stopAccepting();
    let drained = false;
    const draining = server.drain(new AbortController().signal).then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    resolveHandler?.();
    await response;
    await draining;
    expect(drained).toBe(true);
  });

  it("does not dispatch a request completed after accepting has stopped", async () => {
    let handlerCalls = 0;
    const server = await listenControl({
      handleProjectRequest: () => {
        handlerCalls += 1;
        return Promise.resolve({ kind: "project-list", registrations: [projectRegistration] });
      },
    });
    const socket = await openHalfOpenClient();
    const response = responseFrom(socket);

    server.stopAccepting();
    socket.end(projectRequest("project-list"));

    expect(JSON.parse(await response)).toMatchObject({
      request_id: fixedRequestId,
      ok: false,
      error: { code: "RUNTIME_SERVICE_UNAVAILABLE" },
    });
    expect(handlerCalls).toBe(0);
  });

  it("returns a fixed conflict when an existing request id has different canonical bytes", async () => {
    await listenControl();
    await sendRaw(statusRequest(fixedRequestId));
    const conflicting = `${canonicalJson({
      schema_version: "service-control-request.v1",
      document_type: "service-control-request",
      request_id: fixedRequestId,
      command: "restart",
    })}\n`;

    const response = JSON.parse(await sendRaw(conflicting)) as Record<string, unknown>;

    expect(response).toMatchObject({
      request_id: fixedRequestId,
      ok: false,
      error: { code: "RUNTIME_SERVICE_CONTROL_CONFLICT" },
    });
    expect(statusCalls).toBe(1);
  });

  it("refreshes and evicts least-recently-used entries within the 256-entry cache", async () => {
    await listenControl();
    for (let index = 0; index < 256; index += 1) {
      await sendRaw(statusRequest(numberedRequestId(index)));
    }
    expect(statusCalls).toBe(256);

    await sendRaw(statusRequest(numberedRequestId(0)));
    await sendRaw(statusRequest(numberedRequestId(256)));
    await sendRaw(statusRequest(numberedRequestId(0)));
    expect(statusCalls).toBe(257);

    await sendRaw(statusRequest(numberedRequestId(1)));

    expect(statusCalls).toBe(258);
  });

  it("rejects oversize input without reflecting its bytes", async () => {
    await listenControl();
    const response = await sendRaw(`${"x".repeat(65_537)}\n`);

    expect(response).not.toContain("x".repeat(64));
    expect(JSON.parse(response)).toMatchObject({
      request_id: null,
      ok: false,
      error: { code: "RUNTIME_SERVICE_CONTROL_INVALID" },
    });
  });

  it.each([
    ["EOF before newline", statusRequest(fixedRequestId).slice(0, -1)],
    ["an extra line", `${statusRequest(fixedRequestId)}${statusRequest(otherRequestId)}`],
    [
      "noncanonical JSON",
      `${JSON.stringify({ command: "status", request_id: fixedRequestId, document_type: "service-control-request", schema_version: "service-control-request.v1" })}\n`,
    ],
    ["malformed JSON", "{not-json}\n"],
    [
      "a duplicate JSON key",
      `{"schema_version":"service-control-request.v1","document_type":"service-control-request","request_id":"${fixedRequestId}","request_id":"${otherRequestId}","command":"status"}\n`,
    ],
  ])("rejects %s before accepting a request id", async (_name, bytes) => {
    await listenControl();

    const response = await sendRaw(bytes);

    expect(JSON.parse(response)).toMatchObject({
      request_id: null,
      ok: false,
      error: { code: "RUNTIME_SERVICE_CONTROL_INVALID" },
    });
    expect(statusCalls).toBe(0);
  });

  it.each([
    ["unknown command", { command: "restart" }],
    ["unknown version", { schema_version: "service-control-request.v2" }],
    ["unknown field", { unexpected: true }],
  ])("rejects an %s with only its independently valid request id", async (_name, patch) => {
    await listenControl();
    const request = {
      schema_version: "service-control-request.v1",
      document_type: "service-control-request",
      request_id: fixedRequestId,
      command: "status",
      ...patch,
    };

    const response = JSON.parse(await sendRaw(`${canonicalJson(request)}\n`)) as Record<
      string,
      unknown
    >;

    expect(response).toMatchObject({
      request_id: fixedRequestId,
      ok: false,
      error: { code: "RUNTIME_SERVICE_CONTROL_INVALID" },
    });
    expect(statusCalls).toBe(0);
  });

  it("rejects secret-shaped metadata without reflecting its key or value", async () => {
    await listenControl();
    const secretValue = "sensitive-control-value";
    const request = `${canonicalJson({
      schema_version: "service-control-request.v1",
      document_type: "service-control-request",
      request_id: fixedRequestId,
      command: "status",
      api_key: secretValue,
    })}\n`;

    const response = await sendRaw(request);

    expect(response).not.toContain("api_key");
    expect(response).not.toContain(secretValue);
    expect(JSON.parse(response)).toMatchObject({ ok: false });
  });

  it("does not reflect status supplier failures", async () => {
    const secret = "sensitive-status-supplier-detail";
    await listenControl({
      status: () => {
        throw new Error(secret);
      },
    });

    const response = await sendRaw(statusRequest(fixedRequestId));

    expect(response).not.toContain(secret);
    expect(JSON.parse(response)).toMatchObject({
      request_id: fixedRequestId,
      ok: false,
      error: { code: "RUNTIME_SERVICE_UNAVAILABLE" },
    });
  });

  it("hard-caps live server connections at 32 during an overflow flood and recovers capacity", async () => {
    let liveConnections = 0;
    let maximumLiveConnections = 0;
    let capacityReached = false;
    let resolveCapacityReached: (() => void) | undefined;
    let resolveCapacityFreed: (() => void) | undefined;
    const capacityReachedPromise = new Promise<void>((resolve) => {
      resolveCapacityReached = resolve;
    });
    const capacityFreedPromise = new Promise<void>((resolve) => {
      resolveCapacityFreed = resolve;
    });
    await listenControl({
      operationHooks: {
        onConnectionCountChanged: (count: number) => {
          liveConnections = count;
          maximumLiveConnections = Math.max(maximumLiveConnections, count);
          if (count === 32) {
            capacityReached = true;
            resolveCapacityReached?.();
          } else if (capacityReached && count === 31) {
            resolveCapacityFreed?.();
          }
        },
      },
    });
    const held = await Promise.all(Array.from({ length: 32 }, () => openClient()));
    await capacityReachedPromise;
    expect(liveConnections).toBe(32);

    await Promise.all(Array.from({ length: 256 }, () => connectUntilClosed()));

    expect(maximumLiveConnections).toBe(32);
    expect(liveConnections).toBe(32);
    const firstClosed = once(held[0]!, "close");
    held[0]!.destroy();
    await firstClosed;
    await capacityFreedPromise;
    expect(JSON.parse(await sendRaw(statusRequest(fixedRequestId)))).toMatchObject({ ok: true });
    for (const socket of held.slice(1)) socket.destroy();
  }, 10_000);

  it("fully closes and releases an idle half-open client after exactly five seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let liveConnections = 0;
    let serverCloseEvents = 0;
    await listenControl({
      operationHooks: {
        onConnectionCountChanged: (count: number) => {
          liveConnections = count;
        },
        onConnectionClosed: () => {
          serverCloseEvents += 1;
        },
      },
    });
    const socket = await openHalfOpenClient();
    const response = responseFrom(socket);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(JSON.parse(await response)).toMatchObject({
      request_id: null,
      ok: false,
      error: { code: "RUNTIME_SERVICE_CONTROL_INVALID" },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const held = await Promise.all(Array.from({ length: 31 }, () => openClient()));
    expect(JSON.parse(await sendRaw(statusRequest(fixedRequestId)))).toMatchObject({ ok: true });
    expect(serverCloseEvents).toBeGreaterThanOrEqual(1);
    expect(liveConnections).toBe(31);
    for (const heldSocket of held) heldSocket.destroy();
  });

  it("stops accepting and aborts a drain without leaving connected clients", async () => {
    const server = await listenControl();
    const socket = await openClient();
    const closed = once(socket, "close");
    server.stopAccepting();
    const controller = new AbortController();
    const draining = server.drain(controller.signal);

    controller.abort();
    await draining;
    await closed;

    await expect(openClient()).rejects.toBeDefined();
  });

  it("server close destroys connected clients and removes its owned socket", async () => {
    const server = await listenControl();
    const socket = await openClient();
    const closed = once(socket, "close");

    await server.close();
    await closed;

    expect(await pathIsMissing(socketPath)).toBe(true);
    expect(await readdir(runtimePath)).toEqual([]);
  });

  it("keeps repeated and interleaved stop, drain, and close calls idempotent", async () => {
    const server = await listenControl();
    const firstClient = await openClient();
    const secondClient = await openClient();
    const firstClosed = once(firstClient, "close");
    const secondClosed = once(secondClient, "close");
    const firstDrainController = new AbortController();
    const secondDrainController = new AbortController();

    server.stopAccepting();
    server.stopAccepting();
    const firstDrain = server.drain(firstDrainController.signal);
    const secondDrain = server.drain(secondDrainController.signal);
    const firstClose = server.close();
    const repeatedClose = server.close();
    server.stopAccepting();

    expect(repeatedClose).toBe(firstClose);
    await Promise.all([
      firstDrain,
      secondDrain,
      firstClose,
      repeatedClose,
      firstClosed,
      secondClosed,
    ]);
    await server.close();
    server.stopAccepting();
    await server.drain(new AbortController().signal);

    expect(await pathIsMissing(socketPath)).toBe(true);
    expect(await readdir(runtimePath)).toEqual([]);
  });

  it("preserves a short bind-path replacement without falsely completing close", async () => {
    const shortBindPath = path.join(runtimePath, currentStagedSocket);
    expect(await pathIsMissing(shortBindPath)).toBe(true);
    let replacement: PathSnapshot | undefined;
    let injected = false;
    let signalReplacementReady: (() => void) | undefined;
    const replacementReady = new Promise<void>((resolve) => {
      signalReplacementReady = resolve;
    });
    const server = await listenControl({
      operationHooks: {
        beforePublicationGuardCloseClaim: async (candidatePath: string) => {
          if (injected) return;
          injected = true;
          expect(candidatePath).toBe(shortBindPath);
          await mkdir(candidatePath, { mode: 0o700 });
          await chmod(candidatePath, 0o700);
          replacement = await snapshotPath(candidatePath);
          signalReplacementReady?.();
        },
      },
    });
    let closeSettled = false;
    const closing = server.close().then(() => {
      closeSettled = true;
    });

    await replacementReady;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(closeSettled).toBe(false);
    expect(await snapshotPath(shortBindPath)).toEqual(replacement);
    expect(await pathIsMissing(socketPath)).toBe(true);

    await rmdir(shortBindPath);
    server.stopAccepting();
    await closing;
    expect(await readdir(runtimePath)).toEqual([]);
  });

  it("does not clean a replacement at the owned socket path", async () => {
    const server = await listenControl();
    const displaced = path.join(runtimePath, "displaced.sock");
    await rename(socketPath, displaced);
    await writeFile(socketPath, "replacement", { mode: 0o600 });

    await server.close();

    expect(await readFile(socketPath, "utf8")).toBe("replacement");
  });

  it("requests one validated status over a real Unix socket", async () => {
    await listenControl();

    const result = await requestServiceStatus({
      socketPath,
      requestId: fixedRequestId,
      idleTimeoutMs: 5_000,
    });

    expect(result).toEqual({
      package_version: "1.2.3",
      service_instance_id: serviceInstanceId,
      pid: 4200,
      started_at: "2026-08-19T12:00:00.000Z",
      health: "healthy",
      accepting: true,
    });
    expect(statusCalls).toBe(1);
  });

  it("requests one validated project operation over the private socket", async () => {
    await listenControl({
      handleProjectRequest: (request) => {
        expect(request).toMatchObject({ command: "project-list" });
        return Promise.resolve({ kind: "project-list", registrations: [projectRegistration] });
      },
    });

    await expect(
      requestProjectOperation({
        socketPath,
        requestId: fixedRequestId,
        idleTimeoutMs: 5_000,
        operation: { command: "project-list" },
      }),
    ).resolves.toEqual({ kind: "project-list", registrations: [projectRegistration] });
  });

  it("returns a structured failure when a project list exceeds the transport bound", async () => {
    const registrations = Array.from({ length: 13 }, (_, index) => ({
      ...projectRegistration,
      project_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      canonical_root: `/private/tmp/project-${index + 1}`,
    }));
    await listenControl({
      handleProjectRequest: () => Promise.resolve({ kind: "project-list", registrations }),
    });

    await expect(
      requestProjectOperation({
        socketPath,
        requestId: fixedRequestId,
        idleTimeoutMs: 5_000,
        operation: { command: "project-list" },
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_UNAVAILABLE" });
  });

  it("round-trips a version 7 durable operation id over the private socket", async () => {
    const operationId = "018F0B7A-5F2D-7ABC-8DEF-0123456789AC";
    const genericRegistration = {
      ...projectRegistration,
      project_id: "018f0b7a-5f2d-7abc-8def-0123456789ab",
      state: "UNREGISTERED" as const,
    };
    await listenControl({
      handleProjectRequest: (request) => {
        expect(request).toMatchObject({
          command: "project-unregister",
          operation_id: operationId.toLowerCase(),
          project_id: genericRegistration.project_id,
        });
        return Promise.resolve({ kind: "project-registration", registration: genericRegistration });
      },
    });

    await expect(
      requestProjectOperation({
        socketPath,
        requestId: fixedRequestId,
        operationId,
        idleTimeoutMs: 5_000,
        operation: {
          command: "project-unregister",
          project_id: genericRegistration.project_id.toUpperCase(),
        },
      }),
    ).resolves.toEqual({ kind: "project-registration", registration: genericRegistration });
  });

  it("returns one normalized project failure through the control client", async () => {
    await listenControl({
      handleProjectRequest: (request) => {
        expect(request).toMatchObject({ operation_id: fixedOperationId });
        return Promise.reject(new RuntimeProjectError("RUNTIME_PROJECT_NOT_FOUND"));
      },
    });

    await expect(
      requestProjectOperation({
        socketPath,
        requestId: fixedRequestId,
        operationId: fixedOperationId,
        idleTimeoutMs: 5_000,
        operation: {
          command: "project-unregister",
          project_id: projectRegistration.project_id,
        },
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_NOT_FOUND",
      safe_message: "Project registration was not found",
    });
  });

  it("round-trips a durable operation conflict through the real control socket", async () => {
    await listenControl({
      handleProjectRequest: () =>
        Promise.reject(new RuntimeProjectError("RUNTIME_OPERATION_CONFLICT")),
    });

    await expect(
      requestProjectOperation({
        socketPath,
        requestId: fixedRequestId,
        operationId: fixedOperationId,
        idleTimeoutMs: 5_000,
        operation: {
          command: "project-unregister",
          project_id: projectRegistration.project_id,
        },
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_OPERATION_CONFLICT",
      category: "stale-revision",
      safe_message: "Project operation conflicts with an existing operation",
    });
  });

  it("fails closed when the socket path changes while a status response is in flight", async () => {
    const nativeServer = await listenNative(socketPath, true);
    await chmod(socketPath, 0o600);
    nativeServer.once("connection", (socket) => {
      socket.resume();
      socket.once("end", () => {
        void (async () => {
          const displaced = path.join(runtimePath, "original.sock");
          await rename(socketPath, displaced);
          await writeFile(socketPath, "replacement", { mode: 0o600 });
          socket.end(
            `${canonicalJson({
              schema_version: "service-control-response.v1",
              document_type: "service-control-response",
              request_id: fixedRequestId,
              ok: true,
              status: {
                package_version: "1.2.3",
                service_instance_id: serviceInstanceId,
                pid: 4200,
                started_at: "2026-08-19T12:00:00.000Z",
                health: "healthy",
                accepting: true,
              },
              data: null,
              error: null,
            })}\n`,
          );
        })();
      });
    });

    await expect(
      requestServiceStatus({ socketPath, requestId: fixedRequestId, idleTimeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
  });

  it("probes with a fresh request id and maps every failure to null", async () => {
    await listenControl();
    const ids = [fixedRequestId, otherRequestId];
    const createRequestId = () => {
      const id = ids.shift();
      if (id === undefined) throw new Error("no request id");
      return id;
    };

    await expect(
      probeServiceIdentity({ socketPath, createRequestId, idleTimeoutMs: 5_000 }),
    ).resolves.toBe(serviceInstanceId);
    await expect(
      probeServiceIdentity({ socketPath, createRequestId, idleTimeoutMs: 5_000 }),
    ).resolves.toBe(serviceInstanceId);
    expect(statusCalls).toBe(2);

    await expect(
      probeServiceIdentity({
        socketPath: path.join(runtimePath, "missing.sock"),
        createRequestId: () => {
          throw new Error("sensitive-id-error");
        },
        idleTimeoutMs: 5_000,
      }),
    ).resolves.toBeNull();
  });
});
