import { afterEach, describe, expect, it, vi } from "vitest";

import { runService } from "../src/service/lifecycle.js";
import { FakeSignals } from "./support/fake-signals.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("service lifecycle", () => {
  it("stops accepting and drains exactly once after SIGTERM", async () => {
    const signals = new FakeSignals();
    const events: string[] = [];
    const running = runService({
      signals,
      stopAccepting: () => events.push("stop-accepting"),
      drain: () => {
        events.push("drain");
        return Promise.resolve();
      },
      shutdownTimeoutMs: 1000,
    });

    signals.emit("SIGTERM");
    await expect(running).resolves.toEqual({ reason: "SIGTERM", forced: false });
    expect(events).toEqual(["stop-accepting", "drain"]);
    expect(signals.count()).toBe(0);
  });

  it("coalesces duplicate signals into the same drain", async () => {
    const signals = new FakeSignals();
    let drains = 0;
    let finishDrain: (() => void) | undefined;
    const running = runService({
      signals,
      stopAccepting: () => undefined,
      drain: () => {
        drains += 1;
        return new Promise<void>((resolve) => {
          finishDrain = resolve;
        });
      },
      shutdownTimeoutMs: 1000,
    });
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    finishDrain?.();

    await expect(running).resolves.toEqual({ reason: "SIGINT", forced: false });
    expect(drains).toBe(1);
  });

  it("supports an injected requested stop and removes its listener", async () => {
    const signals = new FakeSignals();
    let requestStop: (() => void) | undefined;
    let requestedListenerActive = false;
    const running = runService({
      signals,
      registerRequestedStop(listener) {
        requestStop = listener;
        requestedListenerActive = true;
        return () => {
          requestedListenerActive = false;
        };
      },
      stopAccepting: () => undefined,
      drain: () => Promise.resolve(),
      shutdownTimeoutMs: 1000,
    });

    requestStop?.();

    await expect(running).resolves.toEqual({ reason: "requested", forced: false });
    expect(requestedListenerActive).toBe(false);
    expect(signals.count()).toBe(0);
  });

  it("runs the started callback only after every stop listener is installed", async () => {
    const signals = new FakeSignals();
    const events: string[] = [];
    let requestStop: (() => void) | undefined;
    const running = runService({
      signals: {
        subscribe(signal, listener) {
          events.push(`subscribe-${signal}`);
          return signals.subscribe(signal, listener);
        },
      },
      registerRequestedStop(listener) {
        events.push("subscribe-requested");
        requestStop = listener;
        return () => undefined;
      },
      onStarted: () => events.push("started"),
      stopAccepting: () => undefined,
      drain: () => Promise.resolve(),
      shutdownTimeoutMs: 1000,
    });

    expect(events).toEqual([
      "subscribe-SIGINT",
      "subscribe-SIGTERM",
      "subscribe-requested",
      "started",
    ]);
    requestStop?.();
    await running;
  });

  it("does not run the started callback when stop is requested during registration", async () => {
    const signals = new FakeSignals();
    let started = false;
    const running = runService({
      signals,
      registerRequestedStop(listener) {
        listener();
        return () => undefined;
      },
      onStarted: () => {
        started = true;
      },
      stopAccepting: () => undefined,
      drain: () => Promise.resolve(),
      shutdownTimeoutMs: 1000,
    });

    await expect(running).resolves.toEqual({ reason: "requested", forced: false });
    expect(started).toBe(false);
  });

  it("coalesces a requested stop with later signals", async () => {
    const signals = new FakeSignals();
    let requestStop: (() => void) | undefined;
    let drains = 0;
    let finishDrain: (() => void) | undefined;
    const running = runService({
      signals,
      registerRequestedStop(listener) {
        requestStop = listener;
        return () => undefined;
      },
      stopAccepting: () => undefined,
      drain: () => {
        drains += 1;
        return new Promise<void>((resolve) => {
          finishDrain = resolve;
        });
      },
      shutdownTimeoutMs: 1000,
    });

    requestStop?.();
    signals.emit("SIGTERM");
    finishDrain?.();

    await expect(running).resolves.toEqual({ reason: "requested", forced: false });
    expect(drains).toBe(1);
  });

  it("aborts a drain that exceeds the configured deadline", async () => {
    vi.useFakeTimers();
    const signals = new FakeSignals();
    let observedAbort = false;
    const running = runService({
      signals,
      stopAccepting: () => undefined,
      drain: (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          });
        }),
      shutdownTimeoutMs: 250,
    });
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(250);

    await expect(running).resolves.toEqual({ reason: "SIGTERM", forced: true });
    expect(observedAbort).toBe(true);
  });

  it("can wait for abort-responsive whole-drain cleanup before returning a timeout", async () => {
    vi.useFakeTimers();
    const signals = new FakeSignals();
    const events: string[] = [];
    const running = runService({
      signals,
      stopAccepting: () => events.push("stop"),
      drain: (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              events.push("abort");
              queueMicrotask(() => {
                events.push("cleanup");
                resolve();
              });
            },
            { once: true },
          );
        }),
      shutdownTimeoutMs: 250,
      settleDrainAfterAbort: true,
    });
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(250);

    await expect(running).resolves.toEqual({ reason: "SIGTERM", forced: true });
    expect(events).toEqual(["stop", "abort", "cleanup"]);
  });

  it("preserves the forced outcome when abort-responsive cleanup rejects", async () => {
    vi.useFakeTimers();
    const signals = new FakeSignals();
    const running = runService({
      signals,
      stopAccepting: () => undefined,
      drain: (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("late cleanup failure")), {
            once: true,
          });
        }),
      shutdownTimeoutMs: 250,
      settleDrainAfterAbort: true,
    });
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(250);

    await expect(running).resolves.toEqual({ reason: "SIGTERM", forced: true });
  });

  it("surfaces drain failures after cleaning signal listeners", async () => {
    const signals = new FakeSignals();
    const running = runService({
      signals,
      stopAccepting: () => undefined,
      drain: () => Promise.reject(new Error("drain failed")),
      shutdownTimeoutMs: 1000,
    });
    signals.emit("SIGTERM");
    await expect(running).rejects.toThrow("drain failed");
    expect(signals.count()).toBe(0);
  });

  it.each([
    [
      "stop accepting",
      () => {
        throw new Error("stop accepting failed");
      },
      () => Promise.resolve(),
    ],
    [
      "starting drain",
      () => undefined,
      () => {
        throw new Error("drain start failed");
      },
    ],
  ])("cleans listeners and keepalive when %s throws synchronously", async (_name, stop, drain) => {
    vi.useFakeTimers();
    const signals = new FakeSignals();
    const running = runService({
      signals,
      stopAccepting: stop,
      drain,
      shutdownTimeoutMs: 1000,
    });
    signals.emit("SIGTERM");
    await expect(running).rejects.toThrow();
    expect(signals.count()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans the first listener and keepalive when second subscription fails", async () => {
    vi.useFakeTimers();
    let firstListenerActive = false;
    const running = runService({
      signals: {
        subscribe(signal) {
          if (signal === "SIGINT") {
            firstListenerActive = true;
            return () => {
              firstListenerActive = false;
            };
          }
          throw new Error("subscription failed");
        },
      },
      stopAccepting: () => undefined,
      drain: () => Promise.resolve(),
      shutdownTimeoutMs: 1000,
    });
    await expect(running).rejects.toThrow("subscription failed");
    expect(firstListenerActive).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans signal listeners when requested-stop registration fails", async () => {
    vi.useFakeTimers();
    const signals = new FakeSignals();
    const running = runService({
      signals,
      registerRequestedStop() {
        throw new Error("requested-stop registration failed");
      },
      stopAccepting: () => undefined,
      drain: () => Promise.resolve(),
      shutdownTimeoutMs: 1000,
    });

    await expect(running).rejects.toThrow("requested-stop registration failed");
    expect(signals.count()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans every listener when the started callback fails", async () => {
    vi.useFakeTimers();
    const signals = new FakeSignals();
    let requestedListenerActive = false;
    const running = runService({
      signals,
      registerRequestedStop() {
        requestedListenerActive = true;
        return () => {
          requestedListenerActive = false;
        };
      },
      onStarted() {
        throw new Error("started callback failed");
      },
      stopAccepting: () => undefined,
      drain: () => Promise.resolve(),
      shutdownTimeoutMs: 1000,
    });

    await expect(running).rejects.toThrow("started callback failed");
    expect(signals.count()).toBe(0);
    expect(requestedListenerActive).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("attempts every listener removal when one removal fails", async () => {
    const handlers = new Map<string, () => void>();
    const active = new Set<string>();
    const running = runService({
      signals: {
        subscribe(signal, listener) {
          handlers.set(signal, listener);
          active.add(signal);
          return () => {
            active.delete(signal);
            if (signal === "SIGINT") throw new Error("removal failed");
          };
        },
      },
      registerRequestedStop(listener) {
        handlers.set("requested", listener);
        active.add("requested");
        return () => {
          active.delete("requested");
        };
      },
      stopAccepting: () => undefined,
      drain: () => Promise.resolve(),
      shutdownTimeoutMs: 1000,
    });

    handlers.get("SIGTERM")?.();

    await expect(running).resolves.toEqual({ reason: "SIGTERM", forced: false });
    expect([...active]).toEqual([]);
  });
});
