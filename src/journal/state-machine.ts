import { canonicalJson, sha256, type JsonValue } from "../protocol/json.js";
import type { TraceContext } from "../protocol/types.js";
import { hashRunJournalEntry, parseRunJournalEntry, ZERO_JOURNAL_HASH } from "./entry.js";
import { RuntimeJournalError } from "./errors.js";
import type {
  HashableRunJournalEntryV1,
  RunJournalEntryV1,
  RunState,
  SideEffectRecord,
} from "./types.js";

export const RUN_TRANSITION_MATRIX = Object.freeze({
  CREATED: Object.freeze(["ROUTED", "BLOCKED", "CANCELLED", "INTERRUPTED"]),
  ROUTED: Object.freeze(["RUNNING", "BLOCKED", "CANCELLED", "INTERRUPTED"]),
  RUNNING: Object.freeze([
    "TOOL_PENDING",
    "APPROVAL_PENDING",
    "REVIEW_PENDING",
    "COMPLETED",
    "FAILED",
    "BLOCKED",
    "CANCELLED",
    "INTERRUPTED",
  ]),
  TOOL_PENDING: Object.freeze(["RUNNING", "FAILED", "BLOCKED", "CANCELLED", "INTERRUPTED"]),
  APPROVAL_PENDING: Object.freeze(["RUNNING", "BLOCKED", "CANCELLED", "INTERRUPTED"]),
  REVIEW_PENDING: Object.freeze(["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "INTERRUPTED"]),
  FAILED: Object.freeze(["RUNNING", "CANCELLED"]),
  BLOCKED: Object.freeze(["RUNNING", "CANCELLED"]),
  INTERRUPTED: Object.freeze(["RUNNING", "BLOCKED", "CANCELLED"]),
  COMPLETED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
} as const satisfies Readonly<Record<RunState, readonly RunState[]>>);

export interface TransitionCommand {
  readonly run_id: string;
  readonly expected_revision: number;
  readonly expected_head_hash: `sha256:${string}`;
  readonly command_id: string;
  readonly operation_id: string | null;
  readonly next_state: RunState;
  readonly reason_code: string;
  readonly trace: TraceContext;
  readonly metadata: JsonValue;
  readonly side_effect: SideEffectRecord | null;
}

export type TransitionDecision =
  | { readonly kind: "append"; readonly entry: RunJournalEntryV1 }
  | { readonly kind: "replay"; readonly entry: RunJournalEntryV1 };

interface EffectLedgerEntry {
  readonly intent: SideEffectRecord;
  completed: boolean;
}

function transitionInvalid(): never {
  throw new RuntimeJournalError("RUNTIME_STATE_TRANSITION_INVALID");
}

function operationConflict(): never {
  throw new RuntimeJournalError("RUNTIME_OPERATION_CONFLICT");
}

function commandInputHash(command: TransitionCommand): `sha256:${string}` {
  try {
    return sha256({
      run_id: command.run_id,
      expected_revision: command.expected_revision,
      expected_head_hash: command.expected_head_hash,
      operation_id: command.operation_id,
      next_state: command.next_state,
      reason_code: command.reason_code,
      trace: command.trace,
      metadata: command.metadata,
      side_effect: command.side_effect,
    });
  } catch {
    transitionInvalid();
  }
}

function buildEffectLedger(history: readonly RunJournalEntryV1[]): Map<string, EffectLedgerEntry> {
  const ledger = new Map<string, EffectLedgerEntry>();
  for (const entry of history) {
    const effect = entry.side_effect;
    if (effect === null) continue;
    const existing = ledger.get(effect.identity);
    if (effect.phase === "INTENT") {
      if (effect.output_hash !== null || existing !== undefined) operationConflict();
      ledger.set(effect.identity, { intent: effect, completed: false });
      continue;
    }
    if (
      effect.output_hash === null ||
      existing === undefined ||
      existing.completed ||
      existing.intent.input_hash !== effect.input_hash
    ) {
      operationConflict();
    }
    existing.completed = true;
  }
  return ledger;
}

function assertSideEffectCanAppend(
  history: readonly RunJournalEntryV1[],
  effect: SideEffectRecord | null,
): void {
  if (effect === null) return;
  const ledger = buildEffectLedger(history);
  const existing = ledger.get(effect.identity);
  if (effect.phase === "INTENT") {
    if (effect.output_hash !== null || existing !== undefined) operationConflict();
    return;
  }
  if (
    effect.output_hash === null ||
    existing === undefined ||
    existing.completed ||
    existing.intent.input_hash !== effect.input_hash
  ) {
    operationConflict();
  }
}

export function findUnresolvedSideEffects(
  history: readonly RunJournalEntryV1[],
): readonly SideEffectRecord[] {
  const ledger = buildEffectLedger(history);
  return Object.freeze(
    [...ledger.values()]
      .filter((entry) => !entry.completed)
      .map((entry) => entry.intent)
      .sort((left, right) => Buffer.from(left.identity).compare(Buffer.from(right.identity))),
  );
}

function nextAttempt(previous: RunJournalEntryV1 | undefined, nextState: RunState): number {
  if (previous === undefined) return 1;
  if (
    nextState === "RUNNING" &&
    (previous.state === "FAILED" ||
      previous.state === "BLOCKED" ||
      previous.state === "INTERRUPTED")
  ) {
    return previous.run_attempt + 1;
  }
  return previous.run_attempt;
}

function transitionAllowed(previous: RunJournalEntryV1 | undefined, nextState: RunState): boolean {
  if (previous === undefined) return nextState === "CREATED";
  return (RUN_TRANSITION_MATRIX[previous.state] as readonly RunState[]).includes(nextState);
}

export function decideRunTransition(
  history: readonly RunJournalEntryV1[],
  command: TransitionCommand,
  now: () => Date,
): TransitionDecision {
  const inputHash = commandInputHash(command);
  const existingCommand = history.find((entry) => entry.command_id === command.command_id);
  if (existingCommand !== undefined) {
    if (existingCommand.command_input_hash !== inputHash) operationConflict();
    return { kind: "replay", entry: existingCommand };
  }

  const previous = history.at(-1);
  const expectedRevision = previous?.journal_revision ?? 0;
  const expectedHash = previous?.entry_hash ?? ZERO_JOURNAL_HASH;
  if (
    command.run_id !== (previous?.run_id ?? command.run_id) ||
    command.expected_revision !== expectedRevision ||
    command.expected_head_hash !== expectedHash
  ) {
    throw new RuntimeJournalError("RUNTIME_STATE_STALE");
  }
  if (!transitionAllowed(previous, command.next_state)) transitionInvalid();
  assertSideEffectCanAppend(history, command.side_effect);

  let timestamp: string;
  try {
    timestamp = now().toISOString();
  } catch {
    transitionInvalid();
  }

  const hashable: HashableRunJournalEntryV1 = {
    protocol_version: "runtime-contract.v1",
    schema_version: "run-journal-entry.v1",
    document_type: "run-journal-entry",
    run_id: command.run_id,
    journal_revision: expectedRevision + 1,
    run_attempt: nextAttempt(previous, command.next_state),
    sequence: (previous?.sequence ?? 0) + 1,
    previous_entry_hash: expectedHash,
    command_id: command.command_id,
    command_input_hash: inputHash,
    operation_id: command.operation_id,
    side_effect: command.side_effect,
    previous_state: previous?.state ?? null,
    state: command.next_state,
    reason_code: command.reason_code,
    timestamp,
    trace: command.trace,
    metadata: command.metadata,
  };
  const candidate = { ...hashable, entry_hash: hashRunJournalEntry(hashable) };
  const parsed = parseRunJournalEntry(canonicalJson(candidate));
  if (!parsed.ok) transitionInvalid();
  return { kind: "append", entry: parsed.value };
}
