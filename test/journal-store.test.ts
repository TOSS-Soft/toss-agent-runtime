import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import { RuntimeJournalError } from "../src/journal/errors.js";
import {
  createRunJournalStore,
  type RunJournalStore,
  type TransitionResult,
  withRunJournalBarrier,
} from "../src/journal/store.js";
import type { TransitionCommand } from "../src/journal/state-machine.js";
import type { JournalHead, RunState, SideEffectRecord } from "../src/journal/types.js";

const roots: string[] = [];
const TRACE = {
  trace_id: "1".repeat(32),
  span_id: "2".repeat(16),
  trace_flags: 1,
} as const;

async function fixture(): Promise<{ readonly root: string; readonly statePath: string }> {
  const temporary = await realpath("/tmp");
  const root = await mkdtemp(path.join(temporary, "toss-journal-store-"));
  roots.push(root);
  const statePath = path.join(root, "state");
  return { root, statePath };
}

function clock(): () => Date {
  let value = 0;
  return () => new Date(Date.UTC(2026, 7, 20, 12, 0, value++));
}

function ids(): () => string {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

function createStore(statePath: string): RunJournalStore {
  return createRunJournalStore({ statePath, now: clock(), randomId: ids() });
}

function command(
  runId: string,
  nextState: RunState,
  head: JournalHead | null,
  overrides: Partial<TransitionCommand> = {},
): TransitionCommand {
  return {
    run_id: runId,
    expected_revision: head?.journal_revision ?? 0,
    expected_head_hash: head?.entry_hash ?? ZERO_JOURNAL_HASH,
    command_id: `${runId}-${nextState.toLowerCase()}-${head?.journal_revision ?? 0}`,
    operation_id: null,
    next_state: nextState,
    reason_code: `MOVE_${nextState}`,
    trace: TRACE,
    metadata: {},
    side_effect: null,
    ...overrides,
  };
}

async function advance(
  store: RunJournalStore,
  runId: string,
  states: readonly RunState[],
): Promise<TransitionResult> {
  let result: TransitionResult | undefined;
  for (const state of states) {
    result = await store.transition(command(runId, state, result?.head ?? null));
  }
  if (result === undefined) throw new Error("states must not be empty");
  return result;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("private append-only run journal store", () => {
  it("serializes official external effects with transitions on the exact run queue", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    const created = await store.transition(command("run-barrier", "CREATED", null));
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const atBarrier = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = withRunJournalBarrier(store, "run-barrier", async (snapshot) => {
      entered?.();
      await gate;
      return snapshot?.head;
    });
    await atBarrier;
    let transitioned = false;
    const routed = store
      .transition(command("run-barrier", "ROUTED", created.head))
      .then((result) => {
        transitioned = true;
        return result;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transitioned).toBe(false);

    release?.();

    await expect(barrier).resolves.toEqual(created.head);
    await expect(routed).resolves.toMatchObject({ head: { journal_revision: 2 } });
  });

  it("permits one run-bound transition only while the exact official barrier is held", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    const running = await advance(store, "run-scoped", ["CREATED", "ROUTED", "RUNNING"]);
    let escaped: ((command: TransitionCommand) => Promise<TransitionResult>) | undefined;

    const pending = await withRunJournalBarrier(
      store,
      "run-scoped",
      async (snapshot, transition) => {
        expect(snapshot?.head).toEqual(running.head);
        escaped = transition;
        return transition(
          command("run-scoped", "APPROVAL_PENDING", running.head, {
            command_id: "scoped-approval-pending",
          }),
        );
      },
    );

    expect(pending).toMatchObject({ replayed: false, entry: { state: "APPROVAL_PENDING" } });
    expect((await store.load("run-scoped"))?.head).toEqual(pending.head);
    if (escaped === undefined) throw new Error("scoped transition was not captured");
    await expect(
      escaped(
        command("run-scoped", "RUNNING", pending.head, {
          command_id: "escaped-approval-decision",
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_UNAVAILABLE" });
  });

  it("rejects a scoped transition for another run without creating that run", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    const running = await advance(store, "run-bound", ["CREATED", "ROUTED", "RUNNING"]);

    await expect(
      withRunJournalBarrier(store, "run-bound", async (_snapshot, transition) =>
        transition(
          command("run-other", "CREATED", null, {
            command_id: "wrong-run",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_UNAVAILABLE" });
    expect((await store.load("run-bound"))?.head).toEqual(running.head);
    expect(await store.load("run-other")).toBeNull();
  });

  it("rejects a custom journal that cannot provide the official atomic barrier", async () => {
    const custom = {
      recover: () => Promise.resolve(),
      stopIntake: () => undefined,
      flush: () => Promise.resolve(),
      transition: () => Promise.reject(new Error("unused")),
      load: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
      unresolvedSideEffects: () => Promise.resolve([]),
      interruptActive: () => Promise.resolve(),
    } satisfies RunJournalStore;

    await expect(
      withRunJournalBarrier(custom, "run-1", () => Promise.resolve()),
    ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_UNAVAILABLE" });
  });

  it("preserves every published byte while appending an exact hash-linked successor", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    const created = await store.transition(command("run-1", "CREATED", null));
    const eventsPath = path.join(statePath, "journals", "run-1", "events.jsonl");
    const firstBytes = await readFile(eventsPath);

    const routed = await store.transition(command("run-1", "ROUTED", created.head));
    const allBytes = await readFile(eventsPath);

    expect(allBytes.subarray(0, firstBytes.length).equals(firstBytes)).toBe(true);
    expect(routed).toMatchObject({
      replayed: false,
      head: { journal_revision: 2, sequence: 2 },
      entry: { previous_entry_hash: created.head.entry_hash },
    });
    expect((await lstat(statePath)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.dirname(eventsPath))).mode & 0o777).toBe(0o700);
    expect((await lstat(eventsPath)).mode & 0o777).toBe(0o600);
  });

  it("returns an exact command replay without growing the journal", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    const input = command("run-1", "CREATED", null);
    const first = await store.transition(input);
    const eventsPath = path.join(statePath, "journals", "run-1", "events.jsonl");
    const size = (await lstat(eventsPath)).size;

    const replay = await store.transition(input);

    expect(replay).toEqual({ entry: first.entry, head: first.head, replayed: true });
    expect((await lstat(eventsPath)).size).toBe(size);
  });

  it("does not create run directories while reading missing or stale runs", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);

    expect(await store.load("run-missing")).toBeNull();
    await expect(
      store.transition(
        command("run-stale", "CREATED", {
          journal_revision: 1,
          sequence: 1,
          entry_hash: `sha256:${"a".repeat(64)}`,
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_STATE_STALE" });
    expect(await readdir(path.join(statePath, "journals"))).toEqual([]);
  });

  it("serializes competing commands so only one exact head can append", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    const created = await store.transition(command("run-1", "CREATED", null));

    const results = await Promise.allSettled([
      store.transition(command("run-1", "ROUTED", created.head, { command_id: "route-a" })),
      store.transition(command("run-1", "BLOCKED", created.head, { command_id: "block-b" })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status).toBe("rejected");
    if (rejection?.status !== "rejected") throw new Error("expected one stale rejection");
    expect(rejection.reason).toBeInstanceOf(RuntimeJournalError);
    if (rejection.reason instanceof RuntimeJournalError) {
      expect(rejection.reason.code).toBe("RUNTIME_STATE_STALE");
    }
    expect((await store.load("run-1"))?.entries).toHaveLength(2);
  });

  it("serializes exact-head transitions across public store instances", async () => {
    const { statePath } = await fixture();
    const firstStore = createStore(statePath);
    const secondStore = createStore(statePath);
    const created = await firstStore.transition(command("run-shared", "CREATED", null));

    const results = await Promise.allSettled([
      firstStore.transition(
        command("run-shared", "ROUTED", created.head, { command_id: "shared-route" }),
      ),
      secondStore.transition(
        command("run-shared", "BLOCKED", created.head, { command_id: "shared-block" }),
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await createStore(statePath).load("run-shared")).toMatchObject({
      head: { journal_revision: 2, sequence: 2 },
    });
  });

  it("persists approval waiting across store instances and resumes idempotently", async () => {
    const { statePath } = await fixture();
    const firstStore = createStore(statePath);
    const waiting = await advance(firstStore, "run-approval", [
      "CREATED",
      "ROUTED",
      "RUNNING",
      "APPROVAL_PENDING",
    ]);
    const resume = command("run-approval", "RUNNING", waiting.head, {
      command_id: "approval-decision-1",
      operation_id: "approval-1",
      metadata: { decision: "approved" },
    });
    const secondStore = createStore(statePath);

    expect((await secondStore.load("run-approval"))?.state).toBe("APPROVAL_PENDING");
    const resumed = await secondStore.transition(resume);
    const replay = await createStore(statePath).transition(resume);

    expect(resumed.entry.state).toBe("RUNNING");
    expect(replay).toEqual({ ...resumed, replayed: true });
  });

  it("persists unresolved side-effect intent for reconciliation without running it", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    const running = await advance(store, "run-tool", ["CREATED", "ROUTED", "RUNNING"]);
    const intent: SideEffectRecord = {
      identity: "tool-effect-1",
      phase: "INTENT",
      input_hash: `sha256:${"a".repeat(64)}`,
      output_hash: null,
    };
    await store.transition(
      command("run-tool", "TOOL_PENDING", running.head, {
        operation_id: intent.identity,
        side_effect: intent,
      }),
    );

    expect(await createStore(statePath).unresolvedSideEffects("run-tool")).toEqual([intent]);
  });

  it("allows durable shutdown interruption after external intake stops", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    await advance(store, "run-active", ["CREATED", "ROUTED", "RUNNING"]);
    store.stopIntake();

    await expect(store.transition(command("run-new", "CREATED", null))).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_UNAVAILABLE",
    });
    await store.interruptActive(new AbortController().signal);

    expect((await store.load("run-active"))?.state).toBe("INTERRUPTED");
  });

  it("fails closed on a symlink journal without changing its target", async () => {
    const { root, statePath } = await fixture();
    const store = createStore(statePath);
    await store.recover();
    const runPath = path.join(statePath, "journals", "run-linked");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(runPath, { mode: 0o700 }));
    const outside = path.join(root, "outside.jsonl");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(outside, "outside"));
    await symlink(outside, path.join(runPath, "events.jsonl"));

    await expect(store.load("run-linked")).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_PATH_UNSAFE",
    });
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it("fails closed on a group-readable journal", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    await store.transition(command("run-1", "CREATED", null));
    const eventsPath = path.join(statePath, "journals", "run-1", "events.jsonl");
    await chmod(eventsPath, 0o640);

    await expect(createStore(statePath).load("run-1")).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_PATH_UNSAFE",
    });
  });

  it("does not quarantine or rewrite a journal containing only a partial entry", async () => {
    const { statePath } = await fixture();
    const journal = createStore(statePath);
    await journal.transition(command("run-partial-only", "CREATED", null));
    const eventsPath = path.join(statePath, "journals", "run-partial-only", "events.jsonl");
    const partial = Buffer.from('{"partial":', "utf8");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(eventsPath, partial, { mode: 0o600 }),
    );

    await expect(createStore(statePath).load("run-partial-only")).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_CORRUPT",
    });
    expect(await readFile(eventsPath)).toEqual(partial);
    expect(await readdir(path.join(statePath, "quarantine"))).toEqual([]);
  });
});
