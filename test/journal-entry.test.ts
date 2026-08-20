import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  hashRunJournalEntry,
  parseRunJournalEntry,
  ZERO_JOURNAL_HASH,
} from "../src/journal/entry.js";
import { RuntimeJournalError } from "../src/journal/errors.js";
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

function independentHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function hashable(overrides: Partial<HashableRunJournalEntryV1> = {}): HashableRunJournalEntryV1 {
  return {
    protocol_version: "runtime-contract.v1",
    schema_version: "run-journal-entry.v1",
    document_type: "run-journal-entry",
    run_id: "run-1",
    journal_revision: 1,
    run_attempt: 1,
    sequence: 1,
    previous_entry_hash: ZERO_JOURNAL_HASH,
    command_id: "command-1",
    command_input_hash: `sha256:${"1".repeat(64)}`,
    operation_id: null,
    side_effect: null,
    previous_state: null,
    state: "CREATED",
    reason_code: "RUN_CREATED",
    timestamp: "2026-08-20T12:00:00.000Z",
    trace: { trace_id: "1".repeat(32), span_id: "2".repeat(16), trace_flags: 1 },
    metadata: {},
    ...overrides,
  };
}

function entry(overrides: Partial<HashableRunJournalEntryV1> = {}): RunJournalEntryV1 {
  const value = hashable(overrides);
  return { ...value, entry_hash: independentHash(value) };
}

describe("run journal entry contract", () => {
  it("accepts an independently hashed closed entry and deep-freezes it", () => {
    const candidate = entry();

    const result = parseRunJournalEntry(canonicalJson(candidate));

    expect(result).toEqual({ ok: true, value: candidate });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.trace)).toBe(true);
      expect(Object.isFrozen(result.value.metadata)).toBe(true);
    }
    expect(hashRunJournalEntry(hashable())).toBe(candidate.entry_hash);
  });

  it("rejects an entry whose published content changed without a new hash", () => {
    const candidate = { ...entry(), state: "RUNNING" } as const;

    expect(parseRunJournalEntry(canonicalJson(candidate))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: [expect.objectContaining({ path: "/entry_hash", keyword: "contentHash" })],
    });
  });

  it("rejects secret-shaped metadata even when the content hash is valid", () => {
    const candidate = entry({ metadata: { apiTokenValue: "must-not-persist" } });

    const result = parseRunJournalEntry(canonicalJson(candidate));

    expect(result).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: [expect.objectContaining({ keyword: "sensitiveMetadata" })],
    });
    expect(JSON.stringify(result)).not.toContain("must-not-persist");
  });

  it("rejects unknown fields as a closed document", () => {
    expect(parseRunJournalEntry(canonicalJson({ ...entry(), unexpected: true }))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });

  it.each(STATES)("accepts the %s state vocabulary", (state) => {
    expect(parseRunJournalEntry(canonicalJson(entry({ state })))).toMatchObject({ ok: true });
  });

  it("accepts exact intent and completion side-effect records", () => {
    const intent = entry({
      operation_id: "effect-1",
      side_effect: {
        identity: "effect-1",
        phase: "INTENT",
        input_hash: `sha256:${"2".repeat(64)}`,
        output_hash: null,
      },
    });
    const completed = entry({
      operation_id: "effect-1",
      side_effect: {
        identity: "effect-1",
        phase: "COMPLETED",
        input_hash: `sha256:${"2".repeat(64)}`,
        output_hash: `sha256:${"3".repeat(64)}`,
      },
    });

    expect(parseRunJournalEntry(canonicalJson(intent))).toMatchObject({ ok: true });
    expect(parseRunJournalEntry(canonicalJson(completed))).toMatchObject({ ok: true });
  });

  it("accepts an operation id without a provider or tool side effect", () => {
    expect(
      parseRunJournalEntry(canonicalJson(entry({ operation_id: "approval-1" }))),
    ).toMatchObject({ ok: true });
  });

  it.each([
    {
      name: "intent output",
      value: {
        identity: "effect-1",
        phase: "INTENT",
        input_hash: `sha256:${"2".repeat(64)}`,
        output_hash: `sha256:${"3".repeat(64)}`,
      },
    },
    {
      name: "missing completion output",
      value: {
        identity: "effect-1",
        phase: "COMPLETED",
        input_hash: `sha256:${"2".repeat(64)}`,
        output_hash: null,
      },
    },
  ] as const)("rejects an invalid $name side-effect record", ({ value }) => {
    expect(
      parseRunJournalEntry(canonicalJson(entry({ operation_id: "effect-1", side_effect: value }))),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it("rejects a side-effect identity that differs from operation_id", () => {
    const candidate = entry({
      operation_id: "effect-1",
      side_effect: {
        identity: "effect-2",
        phase: "INTENT",
        input_hash: `sha256:${"2".repeat(64)}`,
        output_hash: null,
      },
    });

    expect(parseRunJournalEntry(canonicalJson(candidate))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: [expect.objectContaining({ path: "/side_effect/identity" })],
    });
  });

  it("rejects an oversized document before validation", () => {
    const oversized = canonicalJson({
      ...entry(),
      metadata: { note: "x".repeat(2 * 1024 * 1024) },
    });

    expect(parseRunJournalEntry(oversized)).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });
});

describe("runtime journal errors", () => {
  it.each([
    ["RUNTIME_STATE_STALE", "stale-revision", false],
    ["RUNTIME_STATE_TRANSITION_INVALID", "invalid-input", false],
    ["RUNTIME_OPERATION_CONFLICT", "stale-revision", false],
    ["RUNTIME_JOURNAL_CORRUPT", "integrity", false],
    ["RUNTIME_JOURNAL_PATH_UNSAFE", "integrity", false],
    ["RUNTIME_JOURNAL_UNAVAILABLE", "unavailable", true],
  ] as const)("uses fixed safe details for %s", (code, category, retryable) => {
    const error = new RuntimeJournalError(code);

    expect(error).toMatchObject({ code, category, retryable });
    expect(error.safe_message.length).toBeGreaterThan(0);
    expect(JSON.stringify(error)).not.toContain("private-path-or-payload");
  });
});
