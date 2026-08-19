import type { Stats } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import type { LoadedConfig } from "../config/types.js";
import type { SignalSource } from "../platform/signals.js";
import { PACKAGE_VERSION } from "../version.js";
import type { ServiceStatusV1 } from "./contracts.js";
import {
  createServiceControlServer,
  type CreateServiceControlServerOptions,
  type ServiceControlServer,
} from "./control.js";
import { RuntimeServiceError } from "./errors.js";
import {
  acquireInstanceLock,
  type AcquireInstanceLockOptions,
  type InstanceLock,
  type ProcessProbe,
  type SocketIdentityProbe,
} from "./instance-lock.js";
import { runService, type ServiceOutcome } from "./lifecycle.js";

export interface RecoveryParticipant {
  recover(): Promise<void>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}

export interface InterruptionRecorder {
  interruptActive(signal: AbortSignal): Promise<void>;
}

export interface SupervisorOutcome extends ServiceOutcome {
  readonly serviceInstanceId: string;
}

export interface UmaskAdapter {
  set(mask: number): number;
}

export interface RunSupervisorOptions {
  readonly loaded: LoadedConfig;
  readonly signals: SignalSource;
  readonly registerRequestedStop?: (listener: () => void) => () => void;
  readonly pid: number;
  readonly now: () => Date;
  readonly createServiceInstanceId: () => string;
  readonly executableHash: string;
  readonly processProbe: ProcessProbe;
  readonly socketProbe: SocketIdentityProbe;
  readonly recoveryParticipants: readonly RecoveryParticipant[];
  readonly interruptionRecorder: InterruptionRecorder;
  readonly onReady: () => void;
  readonly acquireLock?: (options: AcquireInstanceLockOptions) => Promise<InstanceLock>;
  readonly createControlServer?: (
    options: CreateServiceControlServerOptions,
  ) => ServiceControlServer;
  readonly umask?: UmaskAdapter;
}

type SupervisorError = RuntimeServiceError;

interface StageResult {
  readonly completed: boolean;
  readonly error?: SupervisorError;
}

const abortedStage: StageResult = { completed: false };
const completedStage: StageResult = { completed: true };

function safeError(error: unknown): SupervisorError {
  if (error instanceof RuntimeServiceError) {
    try {
      return new RuntimeServiceError(error.code);
    } catch {
      // Caller-created or mutated service errors are not trusted as stable failures.
    }
  }
  return new RuntimeServiceError("RUNTIME_SERVICE_UNAVAILABLE");
}

function pathUnsafe(): never {
  throw new RuntimeServiceError("RUNTIME_SERVICE_PATH_UNSAFE");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function currentUserId(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isSafeRootAncestor(userId: number, mode: number): boolean {
  if (userId !== 0) return false;
  const writable = (mode & 0o022) !== 0;
  return !writable || (mode & 0o1000) !== 0;
}

function assertDirectoryMetadata(metadata: Stats, final: boolean): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) pathUnsafe();
  const uid = currentUserId();
  if (uid === undefined) {
    if ((metadata.mode & 0o022) !== 0 || (final && (metadata.mode & 0o777) !== 0o700)) {
      pathUnsafe();
    }
    return;
  }
  if (final) {
    if (metadata.uid !== uid || (metadata.mode & 0o777) !== 0o700) pathUnsafe();
    return;
  }
  if (metadata.uid === uid) {
    if ((metadata.mode & 0o022) !== 0 && !(uid === 0 && (metadata.mode & 0o1000) !== 0)) {
      pathUnsafe();
    }
    return;
  }
  if (!isSafeRootAncestor(metadata.uid, metadata.mode)) pathUnsafe();
}

function directoryCandidates(candidate: string): readonly string[] {
  if (
    !path.isAbsolute(candidate) ||
    candidate === path.parse(candidate).root ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    pathUnsafe();
  }
  const normalized = path.normalize(candidate);
  const parsed = path.parse(normalized);
  const relative = normalized.slice(parsed.root.length);
  const segments = relative.length === 0 ? [] : relative.split(path.sep);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    pathUnsafe();
  }
  const candidates = [parsed.root];
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    candidates.push(current);
  }
  return candidates;
}

async function ensurePrivateDirectory(candidate: string): Promise<void> {
  const candidates = directoryCandidates(candidate);
  for (const [index, current] of candidates.entries()) {
    const final = index === candidates.length - 1;
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (!isMissing(error) || index === 0) pathUnsafe();
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isExisting(mkdirError)) pathUnsafe();
      }
      try {
        metadata = await lstat(current);
      } catch {
        pathUnsafe();
      }
    }
    assertDirectoryMetadata(metadata, final);
  }
}

async function ensurePrivateRoots(loaded: LoadedConfig): Promise<void> {
  const runtimePath = path.dirname(loaded.config.paths.socket);
  await ensurePrivateDirectory(loaded.config.paths.state);
  await ensurePrivateDirectory(loaded.config.paths.logs);
  await ensurePrivateDirectory(runtimePath);
}

function defaultUmaskAdapter(): UmaskAdapter {
  return { set: (mask) => process.umask(mask) };
}

async function runParticipantStage(
  signal: AbortSignal,
  operation: () => Promise<void>,
): Promise<StageResult> {
  if (signal.aborted) return abortedStage;
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<StageResult>((resolve) => {
    onAbort = () => resolve(abortedStage);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const operationPromise = Promise.resolve()
    .then(operation)
    .then<StageResult>(() => completedStage)
    .catch<StageResult>((error: unknown) => ({ completed: true, error: safeError(error) }));
  try {
    const result = await Promise.race([operationPromise, abortPromise]);
    if (!result.completed) void operationPromise.catch(() => undefined);
    return result;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function firstError(current: SupervisorError | undefined, next: SupervisorError): SupervisorError {
  return current ?? next;
}

export async function runSupervisor(options: RunSupervisorOptions): Promise<SupervisorOutcome> {
  const setUmask = options.umask ?? defaultUmaskAdapter();
  let previousUmask: number | undefined;
  let lock: InstanceLock | undefined;
  let server: ServiceControlServer | undefined;
  let closeAttempted = false;
  let releaseAttempted = false;
  const recoveredParticipants: RecoveryParticipant[] = [];
  let shutdownSequenceStarted = false;
  let accepting = false;
  let health: ServiceStatusV1["health"] = "healthy";
  let primaryError: SupervisorError | undefined;
  let outcome: ServiceOutcome | undefined;

  const closeOwnedServer = async (): Promise<void> => {
    if (server === undefined || closeAttempted) return;
    closeAttempted = true;
    await server.close();
  };

  const releaseOwnedLock = async (): Promise<void> => {
    if (lock === undefined || releaseAttempted) return;
    releaseAttempted = true;
    await lock.release();
  };

  const capture = (error: unknown): void => {
    primaryError = firstError(primaryError, safeError(error));
  };

  try {
    try {
      previousUmask = setUmask.set(0o077);
    } catch (error) {
      primaryError = safeError(error);
    }

    if (primaryError === undefined) {
      try {
        await ensurePrivateRoots(options.loaded);
        if (!/^[0-9a-f]{64}$/u.test(options.executableHash)) pathUnsafe();

        lock = await (options.acquireLock ?? acquireInstanceLock)({
          lockPath: path.join(path.dirname(options.loaded.config.paths.socket), "instance.lock"),
          socketPath: options.loaded.config.paths.socket,
          pid: options.pid,
          now: options.now,
          createServiceInstanceId: options.createServiceInstanceId,
          executableHash: options.executableHash,
          processProbe: options.processProbe,
          socketProbe: options.socketProbe,
        });

        for (const participant of options.recoveryParticipants) {
          await participant.recover();
          recoveredParticipants.push(participant);
        }

        const status = (): ServiceStatusV1 => ({
          package_version: PACKAGE_VERSION,
          service_instance_id: lock!.owner.service_instance_id,
          pid: options.pid,
          started_at: lock!.owner.created_at,
          health,
          accepting,
        });
        server = (options.createControlServer ?? createServiceControlServer)({
          socketPath: options.loaded.config.paths.socket,
          serviceInstanceId: lock.owner.service_instance_id,
          status,
          idleTimeoutMs: 5_000,
          maxConnections: 32,
          cacheSize: 256,
        });
        await server.listen();
        accepting = true;

        outcome = await runService({
          signals: options.signals,
          ...(options.registerRequestedStop === undefined
            ? {}
            : { registerRequestedStop: options.registerRequestedStop }),
          onStarted: options.onReady,
          stopAccepting: () => {
            accepting = false;
            health = "stopping";
            try {
              server!.stopAccepting();
            } catch (error) {
              capture(error);
            }
          },
          drain: async (signal) => {
            shutdownSequenceStarted = true;
            try {
              for (const participant of options.recoveryParticipants) {
                if (signal.aborted) break;
                try {
                  participant.stopIntake();
                } catch (error) {
                  capture(error);
                }
              }

              const interruption = await runParticipantStage(signal, () =>
                options.interruptionRecorder.interruptActive(signal),
              );
              if (interruption.error !== undefined) capture(interruption.error);

              if (!signal.aborted) {
                const controlDrain = await runParticipantStage(signal, () => server!.drain(signal));
                if (controlDrain.error !== undefined) capture(controlDrain.error);
              }

              for (const participant of options.recoveryParticipants) {
                if (signal.aborted) break;
                const flushed = await runParticipantStage(signal, () => participant.flush(signal));
                if (flushed.error !== undefined) capture(flushed.error);
              }
            } finally {
              try {
                try {
                  await closeOwnedServer();
                } catch (error) {
                  capture(error);
                }
              } finally {
                try {
                  await releaseOwnedLock();
                } catch (error) {
                  capture(error);
                }
              }
            }
            if (primaryError !== undefined) throw primaryError;
          },
          shutdownTimeoutMs: options.loaded.config.shutdown_timeout_ms,
          settleDrainAfterAbort: true,
        });
      } catch (error) {
        capture(error);
      }
    }
  } finally {
    if (!closeAttempted) {
      try {
        await closeOwnedServer();
      } catch (error) {
        capture(error);
      }
    }
    if (!shutdownSequenceStarted) {
      for (const participant of recoveredParticipants.toReversed()) {
        try {
          participant.stopIntake();
        } catch (error) {
          capture(error);
        }
      }
      const cleanupSignal = new AbortController().signal;
      for (const participant of recoveredParticipants.toReversed()) {
        try {
          await participant.flush(cleanupSignal);
        } catch (error) {
          capture(error);
        }
      }
    }
    if (!releaseAttempted) {
      try {
        await releaseOwnedLock();
      } catch (error) {
        capture(error);
      }
    }
    if (previousUmask !== undefined) {
      try {
        setUmask.set(previousUmask);
      } catch (error) {
        capture(error);
      }
    }
  }

  if (primaryError !== undefined) throw primaryError;
  if (outcome === undefined || lock === undefined) {
    throw new RuntimeServiceError("RUNTIME_SERVICE_UNAVAILABLE");
  }
  return { ...outcome, serviceInstanceId: lock.owner.service_instance_id };
}
