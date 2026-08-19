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
});
