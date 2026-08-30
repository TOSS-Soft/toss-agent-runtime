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

async function within<T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

  it("keeps a fire-and-forget scoped transition inside the run queue until it settles", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    const running = await advance(store, "run-fire-forget", ["CREATED", "ROUTED", "RUNNING"]);
    const order: string[] = [];
    let issued: Promise<TransitionResult> | undefined;

    const barrier = withRunJournalBarrier(store, "run-fire-forget", (_snapshot, transition) => {
      issued = transition(
        command("run-fire-forget", "APPROVAL_PENDING", running.head, {
          command_id: "fire-forget-pending",
        }),
      );
      void issued.then(() => order.push("scoped"));
      return Promise.resolve("callback-returned");
    });
    await barrier;
    order.push("barrier");
    if (issued === undefined) throw new Error("scoped transition was not issued");
    const pending = await issued;

    expect(order).toEqual(["scoped", "barrier"]);
    await expect(
      store.transition(
        command("run-fire-forget", "RUNNING", pending.head, {
          command_id: "after-fire-forget",
        }),
      ),
    ).resolves.toMatchObject({ entry: { state: "RUNNING" } });
  });

  it("propagates a fire-and-forget scoped failure without an unhandled rejection", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    const running = await advance(store, "run-fire-failure", ["CREATED", "ROUTED", "RUNNING"]);
    let issued: Promise<TransitionResult> | undefined;

    const barrier = withRunJournalBarrier(store, "run-fire-failure", (_snapshot, transition) => {
      issued = transition(command("run-fire-failure", "CREATED", running.head));
      void issued.catch(() => undefined);
      return Promise.resolve("callback-returned");
    });

    await expect(barrier).rejects.toMatchObject({ code: "RUNTIME_STATE_TRANSITION_INVALID" });
    if (issued === undefined) throw new Error("scoped transition was not issued");
    await expect(issued).rejects.toMatchObject({ code: "RUNTIME_STATE_TRANSITION_INVALID" });
    expect((await store.load("run-fire-failure"))?.head).toEqual(running.head);
  });

  it("settles a scoped transition before propagating a callback failure", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    const running = await advance(store, "run-fire-callback", ["CREATED", "ROUTED", "RUNNING"]);
    const order: string[] = [];
    let issued: Promise<TransitionResult> | undefined;

    const barrier = withRunJournalBarrier(store, "run-fire-callback", (_snapshot, transition) => {
      issued = transition(
        command("run-fire-callback", "APPROVAL_PENDING", running.head, {
          command_id: "fire-callback-pending",
        }),
      );
      void issued.then(() => order.push("scoped"));
      throw new Error("callback-failed-after-transition");
    });
    await expect(barrier).rejects.toThrow("callback-failed-after-transition");
    order.push("barrier");
    if (issued === undefined) throw new Error("scoped transition was not issued");
    await issued;

    expect(order).toEqual(["scoped", "barrier"]);
    expect((await store.load("run-fire-callback"))?.state).toBe("APPROVAL_PENDING");
  });

  it("keeps a fire-and-forget scoped transition visible to shutdown flush", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    const running = await advance(store, "run-fire-flush", ["CREATED", "ROUTED", "RUNNING"]);
    let issued: Promise<TransitionResult> | undefined;
    let settled = false;

    const barrier = withRunJournalBarrier(store, "run-fire-flush", (_snapshot, transition) => {
      issued = transition(
        command("run-fire-flush", "APPROVAL_PENDING", running.head, {
          command_id: "fire-flush-pending",
        }),
      );
      void issued.then(() => {
        settled = true;
      });
      return Promise.resolve();
    });
    store.stopIntake();
    await store.flush(new AbortController().signal);
    const settledWhenFlushReturned = settled;
    await barrier;
    if (issued === undefined) throw new Error("scoped transition was not issued");
    await issued;

    expect(settledWhenFlushReturned).toBe(true);
    expect((await store.load("run-fire-flush"))?.state).toBe("APPROVAL_PENDING");
  });

  it("rejects a direct same-run official barrier reacquisition before enqueue", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    await advance(store, "run-nested-direct", ["CREATED"]);

    const nested = withRunJournalBarrier(store, "run-nested-direct", async () =>
      withRunJournalBarrier(store, "run-nested-direct", () => Promise.resolve("unreachable")),
    );

    await expect(within(nested)).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_UNAVAILABLE",
    });
  });

  it("rejects same-run reacquisition across stores sharing the official run queue", async () => {
    const { statePath } = await fixture();
    const first = createStore(statePath);
    const second = createStore(statePath);
    await advance(first, "run-nested-shared", ["CREATED"]);

    const nested = withRunJournalBarrier(first, "run-nested-shared", async () =>
      withRunJournalBarrier(second, "run-nested-shared", () => Promise.resolve("unreachable")),
    );

    await expect(within(nested)).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_UNAVAILABLE",
    });
  });

  it.each(["return", "throw"] as const)(
    "rejects a fire-and-forget casing-alias reacquisition after outer callback $mode",
    async (mode) => {
      const { root, statePath } = await fixture();
      const store = createStore(statePath);
      const created = await advance(store, "run-delayed-alias", ["CREATED"]);
      const aliasPath = path.join(root, path.basename(statePath).toUpperCase());
      expect(await realpath(aliasPath)).toBe(await realpath(statePath));
      let aliasStore: RunJournalStore | undefined;
      let nested: Promise<unknown> | undefined;
      let nestedRan = false;

      const outer = withRunJournalBarrier(store, "run-delayed-alias", () => {
        aliasStore = createStore(aliasPath);
        nested = withRunJournalBarrier(
          aliasStore,
          "run-delayed-alias",
          async (_snapshot, transition) => {
            nestedRan = true;
            return transition(
              command("run-delayed-alias", "ROUTED", created.head, {
                command_id: `delayed-alias-${mode}`,
              }),
            );
          },
        );
        void nested.catch(() => undefined);
        if (mode === "throw") throw new Error("outer-alias-failed");
        return Promise.resolve("outer-returned");
      });

      if (mode === "throw") await expect(outer).rejects.toThrow("outer-alias-failed");
      else await expect(outer).resolves.toBe("outer-returned");
      if (nested === undefined || aliasStore === undefined) {
        throw new Error("nested alias barrier was not invoked");
      }
      await expect(within(nested)).rejects.toMatchObject({
        code: "RUNTIME_JOURNAL_UNAVAILABLE",
      });
      expect(nestedRan).toBe(false);
      expect((await store.load("run-delayed-alias"))?.head).toEqual(created.head);

      store.stopIntake();
      aliasStore.stopIntake();
      await expect(within(store.flush(new AbortController().signal))).resolves.toBeUndefined();
      await expect(within(aliasStore.flush(new AbortController().signal))).resolves.toBeUndefined();
    },
  );

  it("rejects a delayed same-store call but permits one invoked after callback closure", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    await advance(store, "run-call-time", ["CREATED"]);
    let nested: Promise<unknown> | undefined;
    let afterClose: Promise<unknown> | undefined;
    let afterCloseInvoked: (() => void) | undefined;
    const invoked = new Promise<void>((resolve) => {
      afterCloseInvoked = resolve;
    });

    await withRunJournalBarrier(store, "run-call-time", () => {
      nested = withRunJournalBarrier(store, "run-call-time", () => Promise.resolve("nested"));
      void nested.catch(() => undefined);
      setImmediate(() => {
        afterClose = withRunJournalBarrier(store, "run-call-time", () =>
          Promise.resolve("after-close"),
        );
        afterCloseInvoked?.();
      });
      return Promise.resolve();
    });
    if (nested === undefined) throw new Error("nested barrier was not invoked");
    await expect(nested).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_UNAVAILABLE" });
    await invoked;
    if (afterClose === undefined) throw new Error("post-callback barrier was not invoked");
    await expect(afterClose).resolves.toBe("after-close");
  });

  it("rejects a cyclic cross-run reacquisition through a canonical casing alias", async () => {
    const { root, statePath } = await fixture();
    const store = createStore(statePath);
    await advance(store, "run-alias-cycle-a", ["CREATED"]);
    await advance(store, "run-alias-cycle-b", ["CREATED"]);
    const aliasPath = path.join(root, path.basename(statePath).toUpperCase());
    const aliasStore = createStore(aliasPath);

    const cyclic = withRunJournalBarrier(store, "run-alias-cycle-a", async () =>
      withRunJournalBarrier(aliasStore, "run-alias-cycle-b", async () =>
        withRunJournalBarrier(store, "run-alias-cycle-a", () => Promise.resolve("unreachable")),
      ),
    );

    await expect(within(cyclic)).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_UNAVAILABLE",
    });
  });

  it("does not share active leases between parallel alias-store callers", async () => {
    const { root, statePath } = await fixture();
    const store = createStore(statePath);
    await advance(store, "run-alias-parallel", ["CREATED"]);
    const aliasPath = path.join(root, path.basename(statePath).toUpperCase());
    const aliasStore = createStore(aliasPath);
    const order: string[] = [];

    const first = withRunJournalBarrier(store, "run-alias-parallel", async () => {
      order.push("first");
      await new Promise<void>((resolve) => setImmediate(resolve));
      return 1;
    });
    const second = withRunJournalBarrier(aliasStore, "run-alias-parallel", () => {
      order.push("second");
      return Promise.resolve(2);
    });

    await expect(within(Promise.all([first, second]))).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first", "second"]);
  });

  it("keeps a symlink state-root alias closed without invoking its nested callback", async () => {
    const { root, statePath } = await fixture();
    const store = createStore(statePath);
    await advance(store, "run-symlink-alias", ["CREATED"]);
    const aliasPath = path.join(root, "state-link");
    await symlink(statePath, aliasPath);
    let nestedRan = false;
    let nested: Promise<unknown> | undefined;

    await withRunJournalBarrier(store, "run-symlink-alias", () => {
      const aliasStore = createStore(aliasPath);
      nested = withRunJournalBarrier(aliasStore, "run-symlink-alias", () => {
        nestedRan = true;
        return Promise.resolve();
      });
      void nested.catch(() => undefined);
      return Promise.resolve();
    });

    if (nested === undefined) throw new Error("symlink alias barrier was not invoked");
    await expect(within(nested)).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_PATH_UNSAFE",
    });
    expect(nestedRan).toBe(false);
  });

  it("allows bounded different-run nesting but rejects a cyclic reacquisition", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    await advance(store, "run-nested-a", ["CREATED"]);
    await advance(store, "run-nested-b", ["CREATED"]);

    await expect(
      within(
        withRunJournalBarrier(store, "run-nested-a", async () =>
          withRunJournalBarrier(store, "run-nested-b", () => Promise.resolve("different-run")),
        ),
      ),
    ).resolves.toBe("different-run");

    const cyclic = withRunJournalBarrier(store, "run-nested-a", async () =>
      withRunJournalBarrier(store, "run-nested-b", async () =>
        withRunJournalBarrier(store, "run-nested-a", () => Promise.resolve("unreachable")),
      ),
    );
    await expect(within(cyclic)).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_UNAVAILABLE",
    });
  });

  it("breaks concurrent cross-run barrier cycles without deadlocking either queue", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    await advance(store, "run-cycle-a", ["CREATED"]);
    await advance(store, "run-cycle-b", ["CREATED"]);
    let entered = 0;
    let release: (() => void) | undefined;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cyclic = (outerRun: string, innerRun: string) =>
      withRunJournalBarrier(store, outerRun, async () => {
        entered += 1;
        if (entered === 2) release?.();
        await bothEntered;
        return withRunJournalBarrier(store, innerRun, () =>
          Promise.resolve(`${outerRun}:${innerRun}`),
        );
      });

    const settled = await within(
      Promise.allSettled([
        cyclic("run-cycle-a", "run-cycle-b"),
        cyclic("run-cycle-b", "run-cycle-a"),
      ]),
      2_000,
    );

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "RUNTIME_JOURNAL_UNAVAILABLE" },
    });
    store.stopIntake();
    await expect(within(store.flush(new AbortController().signal))).resolves.toBeUndefined();
  });

  it("does not reject concurrent independent barriers on the same run", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    await advance(store, "run-independent", ["CREATED"]);
    const order: string[] = [];

    const first = withRunJournalBarrier(store, "run-independent", async () => {
      order.push("first");
      await new Promise<void>((resolve) => setImmediate(resolve));
      return 1;
    });
    const second = withRunJournalBarrier(store, "run-independent", () => {
      order.push("second");
      return Promise.resolve(2);
    });

    await expect(within(Promise.all([first, second]))).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first", "second"]);
  });

  it("keeps callback failure precedence after a rejected nested barrier", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    await advance(store, "run-nested-error", ["CREATED"]);

    const outer = withRunJournalBarrier(store, "run-nested-error", async () => {
      await expect(
        withRunJournalBarrier(store, "run-nested-error", () => Promise.resolve("unreachable")),
      ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_UNAVAILABLE" });
      throw new Error("outer-callback-failed");
    });

    await expect(within(outer)).rejects.toThrow("outer-callback-failed");
  });

  it("settles shutdown flush after rejecting a nested barrier", async () => {
    const { statePath } = await fixture();
    const store = createStore(statePath);
    await advance(store, "run-nested-flush", ["CREATED"]);

    const outer = withRunJournalBarrier(store, "run-nested-flush", async () => {
      await expect(
        withRunJournalBarrier(store, "run-nested-flush", () => Promise.resolve("unreachable")),
      ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_UNAVAILABLE" });
    });
    await expect(within(outer)).resolves.toBeUndefined();

    store.stopIntake();
    await expect(within(store.flush(new AbortController().signal))).resolves.toBeUndefined();
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
