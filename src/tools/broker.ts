import { RuntimeJournalError } from "../journal/errors.js";
import {
  withRunJournalBarrier,
  type RunJournalSnapshot,
  type RunJournalStore,
  type TransitionResult,
} from "../journal/store.js";
import type { TransitionCommand } from "../journal/state-machine.js";
import type { JournalHead, SideEffectRecord } from "../journal/types.js";
import { canonicalJson, sha256 } from "../protocol/json.js";
import type { TraceContext } from "../protocol/types.js";
import { hashToolCall, parseToolCall } from "./contracts.js";
import { RuntimeToolError } from "./errors.js";
import { toolDispatchInputHash } from "./executor.js";
import type { ToolPrivateStore, ToolStoreOperationV1 } from "./private-store.js";
import type {
  HashableToolCallV1,
  ToolCallV1,
  ToolResultV1,
  ToolUncertainDisposition,
} from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface ToolRecoveryDependencies {
  readonly journal_store: RunJournalStore;
  readonly tool_store: ToolPrivateStore;
  readonly now: () => Date;
}

export interface ToolRecoveryOutcome {
  readonly completed: number;
  readonly failed: number;
  readonly uncertain: number;
  readonly untouched: number;
}

export interface DisposeUncertainInput extends ToolRecoveryDependencies {
  readonly operation_id: string;
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly call_id: string;
  readonly idempotency_key: `sha256:${string}`;
  readonly disposition: ToolUncertainDisposition;
  readonly trace: TraceContext;
}

export interface ToolDispositionOutcome {
  readonly state: "RUNNING" | "BLOCKED";
  readonly journal_head: JournalHead;
  readonly run_id: string;
  readonly call_id: string;
  readonly idempotency_key: `sha256:${string}`;
  readonly disposition: ToolUncertainDisposition;
  readonly operation_hash: `sha256:${string}`;
  readonly replayed: boolean;
}

export interface ToolRecoveryParticipant {
  recover(): Promise<void>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
  dispose(
    input: Omit<DisposeUncertainInput, keyof ToolRecoveryDependencies>,
  ): Promise<ToolDispositionOutcome>;
}

export interface CreateToolRecoveryParticipantOptions extends ToolRecoveryDependencies {
  readonly cancel_discovery_and_reads?: (signal: AbortSignal) => Promise<void>;
  readonly settle_write_results?: (signal: AbortSignal) => Promise<void>;
  readonly close_connections?: (signal: AbortSignal) => Promise<void>;
  readonly on_stop_intake?: () => void;
}

function conflict(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_OPERATION_CONFLICT");
}

function stale(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_APPROVAL_STALE");
}

function journalFailure(error: RuntimeJournalError): never {
  switch (error.code) {
    case "RUNTIME_STATE_STALE":
    case "RUNTIME_STATE_TRANSITION_INVALID":
      return stale();
    case "RUNTIME_OPERATION_CONFLICT":
      return conflict();
    case "RUNTIME_JOURNAL_UNAVAILABLE":
      throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
    case "RUNTIME_JOURNAL_CORRUPT":
    case "RUNTIME_JOURNAL_PATH_UNSAFE":
      throw new RuntimeToolError("RUNTIME_TOOL_INTERNAL");
  }
}

async function underBarrier<T>(
  store: RunJournalStore,
  runId: string,
  operation: (
    snapshot: RunJournalSnapshot | null,
    transition: (command: TransitionCommand) => Promise<TransitionResult>,
  ) => Promise<T>,
): Promise<T> {
  try {
    return await withRunJournalBarrier(store, runId, operation);
  } catch (error) {
    if (error instanceof RuntimeJournalError) journalFailure(error);
    throw error;
  }
}

function headMatches(left: JournalHead, right: JournalHead): boolean {
  return (
    left.journal_revision === right.journal_revision &&
    left.sequence === right.sequence &&
    left.entry_hash === right.entry_hash
  );
}

function headOf(entry: {
  readonly journal_revision: number;
  readonly sequence: number;
  readonly entry_hash: `sha256:${string}`;
}): JournalHead {
  return Object.freeze({
    journal_revision: entry.journal_revision,
    sequence: entry.sequence,
    entry_hash: entry.entry_hash,
  });
}

function terminalCall(previous: ToolCallV1, result: ToolResultV1, timestamp: string): ToolCallV1 {
  const hashable: HashableToolCallV1 = {
    protocol_version: previous.protocol_version,
    schema_version: previous.schema_version,
    document_type: previous.document_type,
    run_id: previous.run_id,
    call_revision: previous.call_revision + 1,
    previous_call_hash: previous.document_hash,
    stage: "COMPLETED",
    dispatch_state: "RESULT_RECEIVED",
    execution_request_hash: previous.execution_request_hash,
    agent_definition: previous.agent_definition,
    task_contract: previous.task_contract,
    role: previous.role,
    profile: previous.profile,
    discovery_snapshot_hash: previous.discovery_snapshot_hash,
    session_id: previous.session_id,
    server_id: previous.server_id,
    transport: previous.transport,
    protocol_revision: previous.protocol_revision,
    alias: previous.alias,
    native_name: previous.native_name,
    input_schema_hash: previous.input_schema_hash,
    output_schema_hash: previous.output_schema_hash,
    operation_class: previous.operation_class,
    logical_call_id: previous.logical_call_id,
    operation_id: previous.operation_id,
    call_id: previous.call_id,
    idempotency_key: previous.idempotency_key,
    logical_arguments: previous.logical_arguments,
    logical_input_hash: previous.logical_input_hash,
    approval_request_hash: previous.approval_request_hash,
    prepared_at: previous.prepared_at,
    terminal_at: timestamp,
    result_hash: result.document_hash,
    terminal_code: null,
  };
  const candidate = { ...hashable, document_hash: hashToolCall(hashable) };
  const parsed = parseToolCall(canonicalJson(candidate));
  if (!parsed.ok) throw new RuntimeToolError("RUNTIME_TOOL_INTERNAL");
  return parsed.value;
}

function uncertainCall(previous: ToolCallV1, timestamp: string): ToolCallV1 {
  const hashable: HashableToolCallV1 = {
    protocol_version: previous.protocol_version,
    schema_version: previous.schema_version,
    document_type: previous.document_type,
    run_id: previous.run_id,
    call_revision: previous.call_revision + 1,
    previous_call_hash: previous.document_hash,
    stage: "UNCERTAIN",
    dispatch_state: "MAYBE_SENT",
    execution_request_hash: previous.execution_request_hash,
    agent_definition: previous.agent_definition,
    task_contract: previous.task_contract,
    role: previous.role,
    profile: previous.profile,
    discovery_snapshot_hash: previous.discovery_snapshot_hash,
    session_id: previous.session_id,
    server_id: previous.server_id,
    transport: previous.transport,
    protocol_revision: previous.protocol_revision,
    alias: previous.alias,
    native_name: previous.native_name,
    input_schema_hash: previous.input_schema_hash,
    output_schema_hash: previous.output_schema_hash,
    operation_class: previous.operation_class,
    logical_call_id: previous.logical_call_id,
    operation_id: previous.operation_id,
    call_id: previous.call_id,
    idempotency_key: previous.idempotency_key,
    logical_arguments: previous.logical_arguments,
    logical_input_hash: previous.logical_input_hash,
    approval_request_hash: previous.approval_request_hash,
    prepared_at: previous.prepared_at,
    terminal_at: timestamp,
    result_hash: null,
    terminal_code: "RUNTIME_TOOL_EFFECT_UNCERTAIN",
  };
  const candidate = { ...hashable, document_hash: hashToolCall(hashable) };
  const parsed = parseToolCall(canonicalJson(candidate));
  if (!parsed.ok) throw new RuntimeToolError("RUNTIME_TOOL_INTERNAL");
  return parsed.value;
}

function recoveryCommand(
  snapshot: RunJournalSnapshot,
  call: ToolCallV1,
  trace: TraceContext,
  phase: "completed" | "failed" | "uncertain",
  outputHash: `sha256:${string}` | null,
): TransitionCommand {
  const inputHash = toolDispatchInputHash(call);
  const sideEffect: SideEffectRecord | null =
    phase === "uncertain"
      ? null
      : {
          identity: call.operation_id,
          phase: "COMPLETED",
          input_hash: inputHash,
          output_hash: outputHash,
        };
  return {
    run_id: call.run_id,
    expected_revision: snapshot.head.journal_revision,
    expected_head_hash: snapshot.head.entry_hash,
    command_id: `tool-recover-${phase}-${sha256({ call_id: call.call_id, input_hash: inputHash }).slice(7, 31)}`,
    operation_id: sideEffect === null ? null : call.operation_id,
    next_state: phase === "completed" ? "RUNNING" : phase === "failed" ? "FAILED" : "BLOCKED",
    reason_code:
      phase === "completed"
        ? "TOOL_RESULT_RECOVERED"
        : phase === "failed"
          ? "TOOL_NOT_SENT_RECOVERED"
          : "TOOL_EFFECT_UNCERTAIN",
    trace,
    metadata: {
      kind: "tool-recovery",
      call_id: call.call_id,
      input_hash: inputHash,
      outcome_hash: outputHash,
    },
    side_effect: sideEffect,
  };
}

function unresolvedFor(snapshot: RunJournalSnapshot, call: ToolCallV1): boolean {
  const inputHash = toolDispatchInputHash(call);
  return snapshot.unresolved_side_effects.some(
    (effect) => effect.identity === call.operation_id && effect.input_hash === inputHash,
  );
}

export async function recoverToolCalls(
  dependencies: ToolRecoveryDependencies,
): Promise<ToolRecoveryOutcome> {
  const calls = await dependencies.tool_store.latestCalls();
  const journals = await dependencies.journal_store.list();
  let completed = 0;
  let failed = 0;
  let uncertain = 0;
  let untouched = 0;

  for (const observed of journals) {
    const outcome = await underBarrier(
      dependencies.journal_store,
      observed.run_id,
      async (snapshot, transition): Promise<"completed" | "failed" | "uncertain" | "untouched"> => {
        if (snapshot === null || snapshot.unresolved_side_effects.length === 0) return "untouched";
        if (snapshot.unresolved_side_effects.length !== 1) conflict();
        const effect = snapshot.unresolved_side_effects[0]!;
        let call = calls.find(
          (candidate) =>
            candidate.run_id === snapshot.run_id && candidate.operation_id === effect.identity,
        );
        if (call === undefined || !unresolvedFor(snapshot, call)) conflict();
        if (snapshot.state === "BLOCKED") return "untouched";
        if (snapshot.state !== "TOOL_PENDING") conflict();
        const trace = snapshot.entries.at(-1)!.trace;

        if (call.stage === "COMPLETED" || call.stage === "FAILED") {
          const result = await dependencies.tool_store.result(call.run_id, call.call_id);
          if (result === null || result.document_hash !== call.result_hash) conflict();
          const phase = call.stage === "COMPLETED" ? "completed" : "failed";
          await transition(recoveryCommand(snapshot, call, trace, phase, result.document_hash));
          return phase;
        }
        if (call.stage === "UNCERTAIN") {
          await transition(recoveryCommand(snapshot, call, trace, "uncertain", null));
          return "uncertain";
        }

        const result = await dependencies.tool_store.result(call.run_id, call.call_id);
        if (result !== null) {
          call = await dependencies.tool_store.appendCall(
            terminalCall(call, result, dependencies.now().toISOString()),
          );
          await transition(
            recoveryCommand(snapshot, call, trace, "completed", result.document_hash),
          );
          return "completed";
        }
        call = await dependencies.tool_store.appendCall(
          uncertainCall(call, dependencies.now().toISOString()),
        );
        await transition(recoveryCommand(snapshot, call, trace, "uncertain", null));
        return "uncertain";
      },
    );
    if (outcome === "completed") completed += 1;
    else if (outcome === "failed") failed += 1;
    else if (outcome === "uncertain") uncertain += 1;
    else untouched += 1;
  }
  return Object.freeze({ completed, failed, uncertain, untouched });
}

function dispositionRequestHash(input: DisposeUncertainInput): `sha256:${string}` {
  return sha256({
    kind: "tool-uncertain-disposition",
    operation_id: input.operation_id,
    run_id: input.run_id,
    expected_journal_head: input.expected_journal_head,
    call_id: input.call_id,
    idempotency_key: input.idempotency_key,
    disposition: input.disposition,
    trace: input.trace,
  });
}

function dispositionOperation(
  input: DisposeUncertainInput,
  outcomeHash: `sha256:${string}`,
): ToolStoreOperationV1 {
  const hashable = {
    schema_version: "tool-store-operation.v1" as const,
    operation_id: input.operation_id,
    operation_kind: "uncertain-disposition" as const,
    run_id: input.run_id,
    call_id: input.call_id,
    request_hash: dispositionRequestHash(input),
    outcome_hash: outcomeHash,
    occurred_at: input.now().toISOString(),
  };
  return Object.freeze({ ...hashable, record_hash: sha256(hashable) });
}

function dispositionCommand(
  snapshot: RunJournalSnapshot,
  call: ToolCallV1,
  input: DisposeUncertainInput,
  outputHash: `sha256:${string}`,
): TransitionCommand {
  const inputHash = toolDispatchInputHash(call);
  return {
    run_id: call.run_id,
    expected_revision: snapshot.head.journal_revision,
    expected_head_hash: snapshot.head.entry_hash,
    command_id: `tool-disposition-${input.operation_id}`,
    operation_id: call.operation_id,
    next_state: "RUNNING",
    reason_code: "TOOL_NO_EFFECT_CONFIRMED",
    trace: input.trace,
    metadata: {
      kind: "tool-uncertain-disposition",
      call_id: call.call_id,
      disposition: input.disposition,
      operation_hash: outputHash,
    },
    side_effect: {
      identity: call.operation_id,
      phase: "COMPLETED",
      input_hash: inputHash,
      output_hash: outputHash,
    },
  };
}

export async function disposeUncertain(
  input: DisposeUncertainInput,
): Promise<ToolDispositionOutcome> {
  if (
    !UUID_PATTERN.test(input.operation_id) ||
    !IDENTIFIER_PATTERN.test(input.run_id) ||
    !IDENTIFIER_PATTERN.test(input.call_id) ||
    !HASH_PATTERN.test(input.idempotency_key) ||
    (input.disposition !== "NO_EFFECT_CONFIRMED" && input.disposition !== "EFFECT_CONFIRMED")
  ) {
    throw new RuntimeToolError("RUNTIME_TOOL_INVALID");
  }
  return await underBarrier(input.journal_store, input.run_id, async (snapshot, transition) => {
    if (snapshot === null) stale();
    const call = await input.tool_store.latestCall(input.run_id, input.call_id);
    if (
      call === null ||
      call.stage !== "UNCERTAIN" ||
      call.idempotency_key !== input.idempotency_key
    ) {
      stale();
    }
    const previous = (await input.tool_store.operationsForCall(input.run_id, input.call_id)).filter(
      (operation) => operation.operation_kind === "uncertain-disposition",
    );
    if (previous.length > 1) conflict();
    const requestHash = dispositionRequestHash(input);
    let operation = previous[0];
    let replayed = operation !== undefined;
    if (operation !== undefined) {
      if (operation.operation_id !== input.operation_id || operation.request_hash !== requestHash) {
        conflict();
      }
    } else {
      if (
        snapshot.state !== "BLOCKED" ||
        !unresolvedFor(snapshot, call) ||
        !headMatches(snapshot.head, input.expected_journal_head)
      ) {
        stale();
      }
      const outcomeHash = sha256({
        kind: "tool-uncertain-disposition-outcome",
        request_hash: requestHash,
        disposition: input.disposition,
      });
      operation = await input.tool_store.recordOperation(dispositionOperation(input, outcomeHash));
      replayed = false;
    }

    let journalHead = snapshot.head;
    if (input.disposition === "NO_EFFECT_CONFIRMED") {
      if (snapshot.state === "BLOCKED") {
        const resumed = await transition(
          dispositionCommand(snapshot, call, input, operation.outcome_hash),
        );
        journalHead = resumed.head;
      } else if (snapshot.state === "RUNNING") {
        const decisionEntry = snapshot.entries.find(
          (entry) => entry.command_id === `tool-disposition-${input.operation_id}`,
        );
        if (decisionEntry === undefined) conflict();
        journalHead = headOf(decisionEntry);
      } else {
        conflict();
      }
    } else if (snapshot.state !== "BLOCKED") {
      conflict();
    }

    return Object.freeze({
      state: input.disposition === "NO_EFFECT_CONFIRMED" ? "RUNNING" : "BLOCKED",
      journal_head: journalHead,
      run_id: input.run_id,
      call_id: input.call_id,
      idempotency_key: input.idempotency_key,
      disposition: input.disposition,
      operation_hash: operation.record_hash,
      replayed,
    });
  });
}

export function createToolRecoveryParticipant(
  options: CreateToolRecoveryParticipantOptions,
): ToolRecoveryParticipant {
  let accepting = true;
  return Object.freeze({
    async recover(): Promise<void> {
      await options.tool_store.recover();
      await recoverToolCalls(options);
    },
    stopIntake(): void {
      accepting = false;
      options.on_stop_intake?.();
    },
    async flush(signal: AbortSignal): Promise<void> {
      await options.cancel_discovery_and_reads?.(signal);
      await options.settle_write_results?.(signal);
      await recoverToolCalls(options);
      await options.close_connections?.(signal);
      options.tool_store.stopIntake();
      await options.tool_store.flush();
    },
    async dispose(
      input: Omit<DisposeUncertainInput, keyof ToolRecoveryDependencies>,
    ): Promise<ToolDispositionOutcome> {
      if (!accepting) throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
      return await disposeUncertain({ ...options, ...input });
    },
  });
}
