import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMainServices } from "../src/cli/main.js";
import { defaultConfig } from "../src/config/load.js";
import { ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import { createRunJournalStore, type TransitionResult } from "../src/journal/store.js";
import type { TransitionCommand } from "../src/journal/state-machine.js";
import type { JournalHead, RunState } from "../src/journal/types.js";
import { FakeSignals } from "./support/fake-signals.js";

const roots: string[] = [];
const TRACE = {
  trace_id: "1".repeat(32),
  span_id: "2".repeat(16),
  trace_flags: 1,
} as const;

function command(state: RunState, head: JournalHead | null): TransitionCommand {
  return {
    run_id: "run-active",
    expected_revision: head?.journal_revision ?? 0,
    expected_head_hash: head?.entry_hash ?? ZERO_JOURNAL_HASH,
    command_id: `active-${state.toLowerCase()}`,
    operation_id: null,
    next_state: state,
    reason_code: `MOVE_${state}`,
    trace: TRACE,
    metadata: {},
    side_effect: null,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("production journal supervisor integration", () => {
  it("durably interrupts a running journal before a graceful serve shutdown completes", async () => {
    const root = await mkdtemp(path.join(await realpath("/tmp"), "toss-journal-supervisor-"));
    roots.push(root);
    const statePath = path.join(root, "state");
    const runtimePath = path.join(root, "runtime");
    const config = {
      ...defaultConfig("darwin", root),
      shutdown_timeout_ms: 2_000,
      paths: {
        state: statePath,
        logs: path.join(root, "logs"),
        socket: path.join(runtimePath, "runtime.sock"),
      },
    } as const;
    let randomValue = 0;
    const seed = createRunJournalStore({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => `00000000-0000-4000-8000-${String(++randomValue).padStart(12, "0")}`,
    });
    let transition: TransitionResult | undefined;
    for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
      transition = await seed.transition(command(state, transition?.head ?? null));
    }
    expect((await seed.load("run-active"))?.state).toBe("RUNNING");

    const signals = new FakeSignals();
    let ready = 0;
    const services = createMainServices({
      platform: { os: "darwin", arch: process.arch, node: "22.23.1" },
      env: {},
      home: root,
      signals,
      pid: process.pid,
      now: () => new Date("2026-08-20T12:01:00.000Z"),
      createServiceInstanceId: () => "00000000-0000-4000-8000-000000000100",
      resolveExecutableHash: () => Promise.resolve("a".repeat(64)),
      sendReady: () => {
        ready += 1;
      },
      loadConfig: () => Promise.resolve({ config, source: "explicit" }),
    });

    const running = services.serve?.({});
    if (running === undefined) throw new Error("serve service is unavailable");
    await vi.waitFor(() => expect(ready).toBe(1));
    signals.emit("SIGTERM");

    await expect(running).resolves.toMatchObject({ reason: "SIGTERM", forced: false });
    const recovered = createRunJournalStore({
      statePath,
      now: () => new Date("2026-08-20T12:02:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000200",
    });
    expect((await recovered.load("run-active"))?.state).toBe("INTERRUPTED");
  });
});
