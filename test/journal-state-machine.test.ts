import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import {
  decideRunTransition,
  findUnresolvedSideEffects,
  type TransitionCommand,
} from "../src/journal/state-machine.js";
import type {
  HashableRunJournalEntryV1,
  RunJournalEntryV1,
  RunState,
} from "../src/journal/types.js";
import { canonicalJson } from "../src/protocol/json.js";

const STATES = [
  "CREATED",
  "ROUTED",
  "RUNNING",
  "TOOL_PENDING",
  "APPROVAL_PENDING",
  "REVIEW_PENDING",
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
  "INTERRUPTED",
] as const satisfies readonly RunState[];

const ALLOWED: Readonly<Record<"NONE" | RunState, readonly RunState[]>> = {
  NONE: ["CREATED"],
  CREATED: ["ROUTED", "BLOCKED", "CANCELLED", "INTERRUPTED"],
  ROUTED: ["RUNNING", "BLOCKED", "CANCELLED", "INTERRUPTED"],
  RUNNING: [
    "TOOL_PENDING",
    "APPROVAL_PENDING",
    "REVIEW_PENDING",
    "COMPLETED",
    "FAILED",
    "BLOCKED",
    "CANCELLED",
    "INTERRUPTED",
  ],
  TOOL_PENDING: ["RUNNING", "FAILED", "BLOCKED", "CANCELLED", "INTERRUPTED"],
  APPROVAL_PENDING: ["RUNNING", "BLOCKED", "CANCELLED", "INTERRUPTED"],
  REVIEW_PENDING: ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "INTERRUPTED"],
  FAILED: ["RUNNING", "CANCELLED"],
  BLOCKED: ["RUNNING", "CANCELLED"],
  INTERRUPTED: ["RUNNING", "BLOCKED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

const PATHS: Readonly<Record<RunState, readonly RunState[]>> = {
  CREATED: ["CREATED"],
  ROUTED: ["CREATED", "ROUTED"],
  RUNNING: ["CREATED", "ROUTED", "RUNNING"],
  TOOL_PENDING: ["CREATED", "ROUTED", "RUNNING", "TOOL_PENDING"],
  APPROVAL_PENDING: ["CREATED", "ROUTED", "RUNNING", "APPROVAL_PENDING"],
  REVIEW_PENDING: ["CREATED", "ROUTED", "RUNNING", "REVIEW_PENDING"],
  COMPLETED: ["CREATED", "ROUTED", "RUNNING", "COMPLETED"],
  FAILED: ["CREATED", "ROUTED", "RUNNING", "FAILED"],
  BLOCKED: ["CREATED", "ROUTED", "RUNNING", "BLOCKED"],
  CANCELLED: ["CREATED", "ROUTED", "RUNNING", "CANCELLED"],
  INTERRUPTED: ["CREATED", "ROUTED", "RUNNING", "INTERRUPTED"],
};

const TRACE = {
  trace_id: "1".repeat(32),
  span_id: "2".repeat(16),
  trace_flags: 1,
} as const;

function independentHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function historyFor(state: RunState | null): readonly RunJournalEntryV1[] {
  if (state === null) return [];
  const history: RunJournalEntryV1[] = [];
  for (const [index, nextState] of PATHS[state].entries()) {
    const previous = history.at(-1);
    const hashable: HashableRunJournalEntryV1 = {
      protocol_version: "runtime-contract.v1",
      schema_version: "run-journal-entry.v1",
      document_type: "run-journal-entry",
      run_id: "run-1",
      journal_revision: index + 1,
      run_attempt: 1,
      sequence: index + 1,
      previous_entry_hash: previous?.entry_hash ?? ZERO_JOURNAL_HASH,
      command_id: `seed-${index + 1}`,
      command_input_hash: `sha256:${String(index + 1).repeat(64)}`,
      operation_id: null,
      side_effect: null,
      previous_state: previous?.state ?? null,
      state: nextState,
      reason_code: `SEED_${nextState}`,
      timestamp: `2026-08-20T12:00:0${index}.000Z`,
      trace: TRACE,
      metadata: {},
    };
    history.push({ ...hashable, entry_hash: independentHash(hashable) });
  }
  return history;
}

function command(
  history: readonly RunJournalEntryV1[],
  nextState: RunState,
  overrides: Partial<TransitionCommand> = {},
): TransitionCommand {
  const previous = history.at(-1);
  return {
    run_id: "run-1",
    expected_revision: previous?.journal_revision ?? 0,
    expected_head_hash: previous?.entry_hash ?? ZERO_JOURNAL_HASH,
    command_id: `command-${nextState.toLowerCase()}`,
    operation_id: null,
    next_state: nextState,
    reason_code: `MOVE_${nextState}`,
    trace: TRACE,
    metadata: {},
    side_effect: null,
    ...overrides,
  };
}

describe("run transition matrix", () => {
  for (const source of [null, ...STATES] as const) {
    for (const target of STATES) {
      const sourceName = source ?? "NONE";
      const legal = ALLOWED[sourceName].includes(target);
      it(`${legal ? "allows" : "rejects"} ${sourceName} -> ${target}`, () => {
        const history = historyFor(source);
        const input = command(history, target);

        if (!legal) {
          expect(() =>
            decideRunTransition(history, input, () => new Date("2026-08-20T13:00:00.000Z")),
          ).toThrowError(expect.objectContaining({ code: "RUNTIME_STATE_TRANSITION_INVALID" }));
          return;
        }

        const result = decideRunTransition(
          history,
          input,
          () => new Date("2026-08-20T13:00:00.000Z"),
        );
        expect(result).toMatchObject({ kind: "append", entry: { state: target } });
        if (result.kind === "append") {
          expect(result.entry.previous_state).toBe(source);
          expect(result.entry.journal_revision).toBe(history.length + 1);
          expect(result.entry.sequence).toBe(history.length + 1);
          expect(result.entry.previous_entry_hash).toBe(
            history.at(-1)?.entry_hash ?? ZERO_JOURNAL_HASH,
          );
        }
      });
    }
  }

  it.each(["FAILED", "BLOCKED", "INTERRUPTED"] as const)(
    "increments run_attempt for explicit %s resume",
    (source) => {
      const history = historyFor(source);

      const result = decideRunTransition(
        history,
        command(history, "RUNNING"),
        () => new Date("2026-08-20T13:00:00.000Z"),
      );

      expect(result.entry.run_attempt).toBe(2);
    },
  );

  it("preserves run_attempt for ordinary progress", () => {
    const history = historyFor("ROUTED");

    const result = decideRunTransition(
      history,
      command(history, "RUNNING"),
      () => new Date("2026-08-20T13:00:00.000Z"),
    );

    expect(result.entry.run_attempt).toBe(1);
  });

  it("rejects stale revision or head before creating an entry", () => {
    const history = historyFor("RUNNING");

    expect(() =>
      decideRunTransition(
        history,
        command(history, "FAILED", { expected_revision: 1 }),
        () => new Date("2026-08-20T13:00:00.000Z"),
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_STATE_STALE" }));
    expect(() =>
      decideRunTransition(
        history,
        command(history, "FAILED", { expected_head_hash: `sha256:${"f".repeat(64)}` }),
        () => new Date("2026-08-20T13:00:00.000Z"),
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_STATE_STALE" }));
  });
});

describe("transition command idempotency", () => {
  it("replays the exact published approval resume without a new timestamp", () => {
    const waiting = historyFor("APPROVAL_PENDING");
    const resume = command(waiting, "RUNNING", {
      command_id: "approval-decision-1",
      operation_id: "approval-1",
      metadata: { decision: "approved" },
    });
    const first = decideRunTransition(waiting, resume, () => new Date("2026-08-20T13:00:00.000Z"));
    const published = [...waiting, first.entry];

    const replay = decideRunTransition(
      published,
      resume,
      () => new Date("2026-08-20T14:00:00.000Z"),
    );

    expect(replay).toEqual({ kind: "replay", entry: first.entry });
  });

  it("rejects reuse of a command id with different canonical input", () => {
    const history = historyFor("APPROVAL_PENDING");
    const resume = command(history, "RUNNING", {
      command_id: "approval-decision-1",
      operation_id: "approval-1",
      metadata: { decision: "approved" },
    });
    const first = decideRunTransition(history, resume, () => new Date("2026-08-20T13:00:00.000Z"));

    expect(() =>
      decideRunTransition(
        [...history, first.entry],
        { ...resume, metadata: { decision: "denied" } },
        () => new Date("2026-08-20T14:00:00.000Z"),
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_OPERATION_CONFLICT" }));
  });
});

describe("side-effect reconciliation", () => {
  const inputHash = `sha256:${"a".repeat(64)}` as const;
  const outputHash = `sha256:${"b".repeat(64)}` as const;

  it("exposes an unresolved intent without invoking or completing it", () => {
    const running = historyFor("RUNNING");
    const result = decideRunTransition(
      running,
      command(running, "TOOL_PENDING", {
        command_id: "tool-intent-1",
        operation_id: "tool-effect-1",
        side_effect: {
          identity: "tool-effect-1",
          phase: "INTENT",
          input_hash: inputHash,
          output_hash: null,
        },
      }),
      () => new Date("2026-08-20T13:00:00.000Z"),
    );

    expect(findUnresolvedSideEffects([...running, result.entry])).toEqual([
      result.entry.side_effect,
    ]);
  });

  it("resolves only a completion with the exact intent identity and input hash", () => {
    const running = historyFor("RUNNING");
    const intent = decideRunTransition(
      running,
      command(running, "TOOL_PENDING", {
        command_id: "tool-intent-1",
        operation_id: "tool-effect-1",
        side_effect: {
          identity: "tool-effect-1",
          phase: "INTENT",
          input_hash: inputHash,
          output_hash: null,
        },
      }),
      () => new Date("2026-08-20T13:00:00.000Z"),
    ).entry;
    const pending = [...running, intent];
    const completed = decideRunTransition(
      pending,
      command(pending, "RUNNING", {
        command_id: "tool-completed-1",
        operation_id: "tool-effect-1",
        side_effect: {
          identity: "tool-effect-1",
          phase: "COMPLETED",
          input_hash: inputHash,
          output_hash: outputHash,
        },
      }),
      () => new Date("2026-08-20T13:01:00.000Z"),
    ).entry;

    expect(findUnresolvedSideEffects([...pending, completed])).toEqual([]);
  });

  it("rejects completion without an exact unresolved intent", () => {
    const pending = historyFor("TOOL_PENDING");

    expect(() =>
      decideRunTransition(
        pending,
        command(pending, "RUNNING", {
          operation_id: "tool-effect-1",
          side_effect: {
            identity: "tool-effect-1",
            phase: "COMPLETED",
            input_hash: inputHash,
            output_hash: outputHash,
          },
        }),
        () => new Date("2026-08-20T13:01:00.000Z"),
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_OPERATION_CONFLICT" }));
  });

  it("rejects a second intent for an unresolved identity", () => {
    const running = historyFor("RUNNING");
    const intent = decideRunTransition(
      running,
      command(running, "TOOL_PENDING", {
        command_id: "tool-intent-1",
        operation_id: "tool-effect-1",
        side_effect: {
          identity: "tool-effect-1",
          phase: "INTENT",
          input_hash: inputHash,
          output_hash: null,
        },
      }),
      () => new Date("2026-08-20T13:00:00.000Z"),
    ).entry;
    const pending = [...running, intent];

    expect(() =>
      decideRunTransition(
        pending,
        command(pending, "RUNNING", {
          command_id: "tool-intent-2",
          operation_id: "tool-effect-1",
          side_effect: {
            identity: "tool-effect-1",
            phase: "INTENT",
            input_hash: inputHash,
            output_hash: null,
          },
        }),
        () => new Date("2026-08-20T13:01:00.000Z"),
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_OPERATION_CONFLICT" }));
  });
});
