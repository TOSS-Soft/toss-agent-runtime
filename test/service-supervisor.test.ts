import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadedConfig } from "../src/config/types.js";
import type { ServiceStatusV1 } from "../src/service/contracts.js";
import type { ServiceControlServer } from "../src/service/control.js";
import { RuntimeServiceError } from "../src/service/errors.js";
import type { InstanceLock } from "../src/service/instance-lock.js";
import {
  runSupervisor,
  type InterruptionRecorder,
  type RecoveryParticipant,
  type RunSupervisorOptions,
} from "../src/service/supervisor.js";
import { FakeSignals } from "./support/fake-signals.js";

const serviceInstanceId = "018f0f64-7b21-7d4f-8c3d-4a30413d5f42";
const executableHash = "a".repeat(64);
const startedAt = "2026-08-19T12:00:00.000Z";

const temporaryDirectories: string[] = [];

interface Fixture {
  readonly root: string;
  readonly runtimePath: string;
  readonly loaded: LoadedConfig;
}

let fixture: Fixture;
let signals: FakeSignals;
let readyCalls: number;
let readyObserved: Promise<void>;
let resolveReady: (() => void) | undefined;
let activeMask: number;

function owner() {
  return {
    schema_version: "service-lock.v1",
    document_type: "service-lock",
    service_instance_id: serviceInstanceId,
    pid: 4200,
    executable_hash: executableHash,
    created_at: startedAt,
  } as const;
}

function fakeLock(release: () => Promise<void> = () => Promise.resolve()): InstanceLock {
  return { owner: owner(), release };
}

function fakeServer(overrides: Partial<ServiceControlServer> = {}): ServiceControlServer {
  return {
    listen: () => Promise.resolve(),
    stopAccepting: () => undefined,
    drain: () => Promise.resolve(),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

function noOpRecovery(): RecoveryParticipant {
  return {
    recover: () => Promise.resolve(),
    stopIntake: () => undefined,
    flush: () => Promise.resolve(),
  };
}

function noOpInterruption(): InterruptionRecorder {
  return { interruptActive: () => Promise.resolve() };
}

function options(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
  return {
    loaded: fixture.loaded,
    signals,
    pid: 4200,
    now: () => new Date(startedAt),
    createServiceInstanceId: () => serviceInstanceId,
    executableHash,
    processProbe: { liveness: () => "dead" },
    socketProbe: { identify: () => Promise.resolve(null) },
    recoveryParticipants: [noOpRecovery()],
    interruptionRecorder: noOpInterruption(),
    acquireLock: () => Promise.resolve(fakeLock()),
    createControlServer: () => fakeServer(),
    umask: {
      set(mask) {
        const previous = activeMask;
        activeMask = mask;
        return previous;
      },
    },
    onReady: () => {
      readyCalls += 1;
      resolveReady?.();
    },
    ...overrides,
  };
}

function shutdownOptions(events: string[]): RunSupervisorOptions {
  return options({
    recoveryParticipants: [
      {
        recover: () => Promise.resolve(),
        stopIntake: () => events.push("stop-watchers"),
        flush: () => {
          events.push("flush");
          return Promise.resolve();
        },
      },
    ],
    interruptionRecorder: {
      interruptActive: () => {
        events.push("interrupt-active");
        return Promise.resolve();
      },
    },
    acquireLock: () =>
      Promise.resolve(
        fakeLock(() => {
          events.push("release-lock");
          return Promise.resolve();
        }),
      ),
    createControlServer: () =>
      fakeServer({
        stopAccepting: () => events.push("stop-accepting"),
        drain: () => {
          events.push("drain-control");
          return Promise.resolve();
        },
        close: () => {
          events.push("close-socket");
          return Promise.resolve();
        },
      }),
  });
}

beforeEach(async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-runtime-supervisor-")));
  temporaryDirectories.push(root);
  await chmod(root, 0o700);
  const runtimePath = path.join(root, "runtime");
  fixture = {
    root,
    runtimePath,
    loaded: {
      source: "test",
      config: {
        schema_version: "runtime-config.v1",
        document_type: "runtime-config",
        mode: "development",
        paths: {
          state: path.join(root, "state"),
          logs: path.join(root, "logs"),
          socket: path.join(runtimePath, "runtime.sock"),
        },
        shutdown_timeout_ms: 1000,
        logs: { level: "info", retention_days: 7, max_bytes: 104857600 },
        gateway_profile: null,
        provider_profiles: [],
        mcp_profiles: [],
        secret_references: {},
      },
    },
  };
  signals = new FakeSignals();
  readyCalls = 0;
  readyObserved = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  activeMask = 0o022;
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("runtime service supervisor", () => {
  it("announces readiness only after lock, recovery, listeners, and private socket", async () => {
    const events: string[] = [];
    const recordingSignals = {
      subscribe(signal: "SIGINT" | "SIGTERM", listener: () => void): () => void {
        events.push(`subscribe-${signal}`);
        return signals.subscribe(signal, listener);
      },
    };
    const running = runSupervisor(
      options({
        signals: recordingSignals,
        acquireLock: () => {
          events.push("lock");
          return Promise.resolve(fakeLock());
        },
        recoveryParticipants: [
          {
            ...noOpRecovery(),
            recover: () => {
              events.push("recover");
              return Promise.resolve();
            },
          },
        ],
        createControlServer: () =>
          fakeServer({
            listen: () => {
              events.push("listen");
              return Promise.resolve();
            },
          }),
        onReady: () => {
          events.push("ready");
          resolveReady?.();
        },
      }),
    );

    await readyObserved;
    expect(events).toEqual([
      "lock",
      "recover",
      "listen",
      "subscribe-SIGINT",
      "subscribe-SIGTERM",
      "ready",
    ]);
    signals.emit("SIGTERM");
    await expect(running).resolves.toEqual({
      reason: "SIGTERM",
      forced: false,
      serviceInstanceId,
    });
  });

  it("sets umask before creating exact private roots and restores it after shutdown", async () => {
    const masks: number[] = [];
    const running = runSupervisor(
      options({
        umask: {
          set(mask) {
            masks.push(mask);
            const previous = activeMask;
            activeMask = mask;
            return previous;
          },
        },
      }),
    );
    await readyObserved;

    for (const directory of [
      fixture.loaded.config.paths.state,
      fixture.loaded.config.paths.logs,
      fixture.runtimePath,
    ]) {
      const metadata = await lstat(directory);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.mode & 0o777).toBe(0o700);
    }
    expect(masks).toEqual([0o077]);
    signals.emit("SIGTERM");
    await running;
    expect(masks).toEqual([0o077, 0o022]);
    expect(activeMask).toBe(0o022);
  });

  it("passes only fixed private paths and the precomputed executable hash into lock acquisition", async () => {
    let acquired: Parameters<NonNullable<RunSupervisorOptions["acquireLock"]>>[0] | undefined;
    const running = runSupervisor(
      options({
        acquireLock: (lockOptions) => {
          acquired = lockOptions;
          return Promise.resolve(fakeLock());
        },
      }),
    );
    await readyObserved;

    expect(acquired).toMatchObject({
      lockPath: path.join(fixture.runtimePath, "instance.lock"),
      socketPath: fixture.loaded.config.paths.socket,
      executableHash,
      pid: 4200,
    });
    expect(JSON.stringify(acquired)).not.toContain(process.execPath);
    signals.emit("SIGTERM");
    await running;
  });

  it("supplies healthy accepting status and changes it synchronously when shutdown starts", async () => {
    let status: (() => ServiceStatusV1) | undefined;
    let finishDrain: (() => void) | undefined;
    const running = runSupervisor(
      options({
        createControlServer: (serverOptions) => {
          status = serverOptions.status;
          return fakeServer({
            drain: () =>
              new Promise<void>((resolve) => {
                finishDrain = resolve;
              }),
          });
        },
      }),
    );
    await readyObserved;

    expect(status?.()).toMatchObject({
      service_instance_id: serviceInstanceId,
      pid: 4200,
      started_at: startedAt,
      health: "healthy",
      accepting: true,
    });
    signals.emit("SIGTERM");
    expect(status?.()).toMatchObject({ health: "stopping", accepting: false });
    await vi.waitFor(() => expect(finishDrain).toBeTypeOf("function"));
    finishDrain?.();
    await running;
  });

  it("persists interruption before flushing and removing socket or lock", async () => {
    const events: string[] = [];
    const running = runSupervisor(shutdownOptions(events));
    await readyObserved;

    signals.emit("SIGTERM");
    await running;

    expect(events).toEqual([
      "stop-accepting",
      "stop-watchers",
      "interrupt-active",
      "drain-control",
      "flush",
      "close-socket",
      "release-lock",
    ]);
  });

  it("coalesces duplicate signals and a requested stop into one shutdown", async () => {
    const events: string[] = [];
    let requestStop: (() => void) | undefined;
    const running = runSupervisor({
      ...shutdownOptions(events),
      registerRequestedStop(listener) {
        requestStop = listener;
        return () => undefined;
      },
    });
    await readyObserved;

    signals.emit("SIGINT");
    requestStop?.();
    signals.emit("SIGTERM");

    await expect(running).resolves.toMatchObject({ reason: "SIGINT", forced: false });
    expect(events).toEqual([
      "stop-accepting",
      "stop-watchers",
      "interrupt-active",
      "drain-control",
      "flush",
      "close-socket",
      "release-lock",
    ]);
    expect(signals.count()).toBe(0);
  });

  it("supports an injected requested stop without a process signal", async () => {
    let requestStop: (() => void) | undefined;
    const running = runSupervisor(
      options({
        registerRequestedStop(listener) {
          requestStop = listener;
          return () => undefined;
        },
      }),
    );
    await readyObserved;

    requestStop?.();

    await expect(running).resolves.toEqual({
      reason: "requested",
      forced: false,
      serviceInstanceId,
    });
  });

  it("aborts remaining participant work at the whole shutdown deadline and still attempts final cleanup", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const running = runSupervisor({
      ...shutdownOptions(events),
      loaded: {
        ...fixture.loaded,
        config: { ...fixture.loaded.config, shutdown_timeout_ms: 25 },
      },
      interruptionRecorder: {
        interruptActive: (signal) =>
          new Promise<void>(() => {
            signal.addEventListener(
              "abort",
              () => {
                events.push("abort");
              },
              { once: true },
            );
          }),
      },
    });
    await readyObserved;

    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(25);

    await expect(running).resolves.toEqual({
      reason: "SIGTERM",
      forced: true,
      serviceInstanceId,
    });
    expect(events).toEqual([
      "stop-accepting",
      "stop-watchers",
      "abort",
      "close-socket",
      "release-lock",
    ]);
  });

  it.each([
    ["socket close", true, false, false],
    ["lock release", false, true, false],
    ["umask restore", false, false, true],
    ["all finalizers", true, true, true],
  ] as const)(
    "preserves the forced shutdown outcome when %s fails",
    async (_failure, failClose, failRelease, failRestore) => {
      vi.useFakeTimers();
      const events: string[] = [];
      const privateDetails = [
        "private socket /var/run/runtime.sock stack",
        "private lock /tmp/instance.lock stack",
        "private umask /Users/operator stack",
      ];
      const running = runSupervisor({
        ...shutdownOptions(events),
        loaded: {
          ...fixture.loaded,
          config: { ...fixture.loaded.config, shutdown_timeout_ms: 25 },
        },
        interruptionRecorder: {
          interruptActive: () => new Promise<void>(() => undefined),
        },
        acquireLock: () =>
          Promise.resolve(
            fakeLock(() => {
              events.push("release-lock");
              return failRelease ? Promise.reject(new Error(privateDetails[1])) : Promise.resolve();
            }),
          ),
        createControlServer: () =>
          fakeServer({
            stopAccepting: () => events.push("stop-accepting"),
            close: () => {
              events.push("close-socket");
              return failClose ? Promise.reject(new Error(privateDetails[0])) : Promise.resolve();
            },
          }),
        umask: {
          set(mask) {
            if (mask === 0o022) {
              events.push("restore-umask");
              if (failRestore) throw new Error(privateDetails[2]);
            }
            const previous = activeMask;
            activeMask = mask;
            return previous;
          },
        },
      });
      const completion = running.then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      await readyObserved;

      signals.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(25);

      const { result, error } = await completion;
      expect(error).toBeUndefined();
      expect(result).toEqual({
        reason: "SIGTERM",
        forced: true,
        serviceInstanceId,
      });
      expect(events.slice(-3)).toEqual(["close-socket", "release-lock", "restore-umask"]);
      expect(JSON.stringify(result)).not.toContain("private");
      for (const detail of privateDetails) expect(JSON.stringify(result)).not.toContain(detail);
    },
  );

  it("finishes socket close before releasing the lock after a deadline abort", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let finishClose: (() => void) | undefined;
    const running = runSupervisor({
      ...shutdownOptions(events),
      loaded: {
        ...fixture.loaded,
        config: { ...fixture.loaded.config, shutdown_timeout_ms: 25 },
      },
      interruptionRecorder: {
        interruptActive: () => new Promise<void>(() => undefined),
      },
      createControlServer: () =>
        fakeServer({
          stopAccepting: () => events.push("stop-accepting"),
          close: () =>
            new Promise<void>((resolve) => {
              events.push("close-socket");
              finishClose = resolve;
            }),
        }),
    });
    await readyObserved;

    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(25);

    expect(events).toEqual(["stop-accepting", "stop-watchers", "close-socket"]);
    finishClose?.();
    await expect(running).resolves.toMatchObject({ forced: true });
    expect(events).toEqual(["stop-accepting", "stop-watchers", "close-socket", "release-lock"]);
  });

  it("continues ordered participant cleanup after interruption persistence fails", async () => {
    const events: string[] = [];
    const running = runSupervisor({
      ...shutdownOptions(events),
      interruptionRecorder: {
        interruptActive: () => {
          events.push("interrupt-active");
          return Promise.reject(new Error("private interruption detail"));
        },
      },
    });
    await readyObserved;
    signals.emit("SIGTERM");

    const error = await running.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "RUNTIME_SERVICE_UNAVAILABLE" });
    expect(String(error)).not.toContain("private interruption detail");
    expect(events).toEqual([
      "stop-accepting",
      "stop-watchers",
      "interrupt-active",
      "drain-control",
      "flush",
      "close-socket",
      "release-lock",
    ]);
  });

  it("releases the lock when socket close fails and restores umask after lock release fails", async () => {
    const events: string[] = [];
    const running = runSupervisor({
      ...shutdownOptions(events),
      acquireLock: () =>
        Promise.resolve(
          fakeLock(() => {
            events.push("release-lock");
            return Promise.reject(new Error("private lock detail"));
          }),
        ),
      createControlServer: () =>
        fakeServer({
          stopAccepting: () => events.push("stop-accepting"),
          drain: () => {
            events.push("drain-control");
            return Promise.resolve();
          },
          close: () => {
            events.push("close-socket");
            return Promise.reject(new Error("private socket detail"));
          },
        }),
      umask: {
        set(mask) {
          if (mask === 0o022) events.push("restore-umask");
          const previous = activeMask;
          activeMask = mask;
          return previous;
        },
      },
    });
    await readyObserved;
    signals.emit("SIGTERM");

    const error = await running.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "RUNTIME_SERVICE_UNAVAILABLE" });
    expect(String(error)).not.toMatch(/private (socket|lock) detail/u);
    expect(events.slice(-3)).toEqual(["close-socket", "release-lock", "restore-umask"]);
  });

  it("preserves a non-forced primary shutdown error across finalizer failures", async () => {
    const events: string[] = [];
    const running = runSupervisor({
      ...shutdownOptions(events),
      interruptionRecorder: {
        interruptActive: () =>
          Promise.reject(new RuntimeServiceError("RUNTIME_SERVICE_PATH_UNSAFE")),
      },
      acquireLock: () =>
        Promise.resolve(
          fakeLock(() => {
            events.push("release-lock");
            return Promise.reject(new Error("private lock /tmp/instance.lock stack"));
          }),
        ),
      createControlServer: () =>
        fakeServer({
          stopAccepting: () => events.push("stop-accepting"),
          drain: () => {
            events.push("drain-control");
            return Promise.resolve();
          },
          close: () => {
            events.push("close-socket");
            return Promise.reject(new Error("private socket /var/run/runtime.sock stack"));
          },
        }),
      umask: {
        set(mask) {
          if (mask === 0o022) {
            events.push("restore-umask");
            throw new Error("private umask /Users/operator stack");
          }
          const previous = activeMask;
          activeMask = mask;
          return previous;
        },
      },
    });
    await readyObserved;
    signals.emit("SIGTERM");

    const error = await running.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    expect(String(error)).not.toMatch(/private|\/tmp|\/var|\/Users|stack/u);
    expect(events.slice(-3)).toEqual(["close-socket", "release-lock", "restore-umask"]);
  });

  it.each([
    ["lock", ["restore-umask"]],
    ["recovery", ["release-lock", "restore-umask"]],
    ["server construction", ["release-lock", "restore-umask"]],
    ["socket listen", ["close-socket", "release-lock", "restore-umask"]],
    ["signal registration", ["close-socket", "release-lock", "restore-umask"]],
    ["readiness callback", ["close-socket", "release-lock", "restore-umask"]],
  ] as const)(
    "does not announce readiness and unwinds only owned resources after %s failure",
    async (stage, expected) => {
      const events: string[] = [];
      let subscription = 0;
      const stageOptions = options({
        acquireLock: () => {
          if (stage === "lock") return Promise.reject(new Error("private startup detail"));
          return Promise.resolve(
            fakeLock(() => {
              events.push("release-lock");
              return Promise.resolve();
            }),
          );
        },
        recoveryParticipants: [
          {
            ...noOpRecovery(),
            recover: () => {
              return stage === "recovery"
                ? Promise.reject(new Error("private startup detail"))
                : Promise.resolve();
            },
          },
        ],
        createControlServer: () => {
          if (stage === "server construction") throw new Error("private startup detail");
          return fakeServer({
            listen: () => {
              return stage === "socket listen"
                ? Promise.reject(new Error("private startup detail"))
                : Promise.resolve();
            },
            close: () => {
              events.push("close-socket");
              return Promise.resolve();
            },
          });
        },
        signals: {
          subscribe(signal, listener) {
            subscription += 1;
            if (stage === "signal registration" && subscription === 2) {
              throw new Error("private startup detail");
            }
            return signals.subscribe(signal, listener);
          },
        },
        onReady: () => {
          if (stage === "readiness callback") throw new Error("private startup detail");
          readyCalls += 1;
        },
        umask: {
          set(mask) {
            if (mask === 0o022) events.push("restore-umask");
            const previous = activeMask;
            activeMask = mask;
            return previous;
          },
        },
      });

      const error = await runSupervisor(stageOptions).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "RUNTIME_SERVICE_UNAVAILABLE" });
      expect(String(error)).not.toContain("private startup detail");
      expect(readyCalls).toBe(0);
      expect(events).toEqual(expected);
      expect(signals.count()).toBe(0);
      expect(activeMask).toBe(0o022);
    },
  );

  it("unwinds only successfully recovered participants when a later recovery fails", async () => {
    const events: string[] = [];
    const running = runSupervisor(
      options({
        recoveryParticipants: [
          {
            recover: () => {
              events.push("recover-first");
              return Promise.resolve();
            },
            stopIntake: () => events.push("stop-first"),
            flush: () => {
              events.push("flush-first");
              return Promise.resolve();
            },
          },
          {
            recover: () => {
              events.push("recover-second");
              return Promise.reject(new Error("private recovery detail"));
            },
            stopIntake: () => events.push("stop-second"),
            flush: () => Promise.resolve(),
          },
        ],
        acquireLock: () =>
          Promise.resolve(
            fakeLock(() => {
              events.push("release-lock");
              return Promise.resolve();
            }),
          ),
        umask: {
          set(mask) {
            if (mask === 0o022) events.push("restore-umask");
            const previous = activeMask;
            activeMask = mask;
            return previous;
          },
        },
      }),
    );

    await expect(running).rejects.toMatchObject({ code: "RUNTIME_SERVICE_UNAVAILABLE" });
    expect(events).toEqual([
      "recover-first",
      "recover-second",
      "stop-first",
      "flush-first",
      "release-lock",
      "restore-umask",
    ]);
  });

  it("fails an unsafe root before lock acquisition or readiness", async () => {
    let lockCalls = 0;
    const unsafe = options({
      loaded: {
        ...fixture.loaded,
        config: {
          ...fixture.loaded.config,
          paths: { ...fixture.loaded.config.paths, state: path.parse(fixture.root).root },
        },
      },
      acquireLock: () => {
        lockCalls += 1;
        return Promise.resolve(fakeLock());
      },
    });

    await expect(runSupervisor(unsafe)).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(lockCalls).toBe(0);
    expect(readyCalls).toBe(0);
    expect(activeMask).toBe(0o022);
  });

  it("preserves the primary stable startup failure across cleanup failures", async () => {
    const running = runSupervisor(
      options({
        acquireLock: () =>
          Promise.resolve(fakeLock(() => Promise.reject(new Error("private release path")))),
        createControlServer: () =>
          fakeServer({
            listen: () => Promise.reject(new RuntimeServiceError("RUNTIME_SERVICE_PATH_UNSAFE")),
            close: () => Promise.reject(new Error("private close path")),
          }),
      }),
    );

    const error = await running.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    expect(String(error)).not.toMatch(/private (release|close) path/u);
    expect(readyCalls).toBe(0);
    expect(activeMask).toBe(0o022);
  });

  it("normalizes an untrusted service-error code without reflecting its detail", async () => {
    const untrusted = new RuntimeServiceError("RUNTIME_SERVICE_ALREADY_RUNNING");
    Object.defineProperty(untrusted, "code", { value: "PRIVATE_INVALID_CODE" });
    untrusted.message = "private callback path";

    const error = await runSupervisor(
      options({
        onReady: () => {
          throw untrusted;
        },
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "RUNTIME_SERVICE_UNAVAILABLE" });
    expect(String(error)).not.toContain("private callback path");
    expect(activeMask).toBe(0o022);
  });
});
