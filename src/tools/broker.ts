import { randomUUID } from "node:crypto";

import type { EffectiveAgentAuthority } from "../agents/authority.js";
import type { McpProfileReference } from "../agents/types.js";
import type { RuntimeConfigV1 } from "../config/types.js";
import { RuntimeJournalError } from "../journal/errors.js";
import {
  withRunJournalBarrier,
  type RunJournalSnapshot,
  type RunJournalStore,
  type TransitionResult,
} from "../journal/store.js";
import type { TransitionCommand } from "../journal/state-machine.js";
import type { JournalHead, SideEffectRecord } from "../journal/types.js";
import {
  createRuntimeCapabilities,
  type McpCapabilityReadiness,
  type RuntimeCapabilitiesV1,
} from "../protocol/capabilities.js";
import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonValue,
} from "../protocol/json.js";
import type { RuntimeError, TraceContext } from "../protocol/types.js";
import { requestToolApproval, resumeToolApproval } from "./approval.js";
import { hashToolCall, parseToolCall } from "./contracts.js";
import {
  createToolSessionManager,
  type DiscoveredToolView as InternalDiscoveredToolView,
  type ToolDiscoverySnapshotStore,
  type ToolSession,
  type ToolSessionManager,
} from "./discovery.js";
import { RuntimeToolError } from "./errors.js";
import { toolRuntimeError } from "./errors.js";
import { createToolExecutor, toolDispatchInputHash, type ToolExecutor } from "./executor.js";
import { authorizeToolCall, type AuthorizedToolCall } from "./policy.js";
import type { ToolPrivateStore, ToolStoreOperationV1 } from "./private-store.js";
import { createToolPrivateStore } from "./private-store.js";
import { createMcpProfileRegistry, type RegisteredMcpProfile } from "./profile.js";
import type { ToolTransportAdapter } from "./transports/types.js";
import type {
  HashableToolCallV1,
  McpDiscoverySnapshotV1,
  McpProfileV1,
  McpServerBinding,
  ToolApprovalV1,
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
  readonly call: ToolCallV1;
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
      call,
    });
  });
}

export interface ToolSessionHandle {
  readonly run_id: string;
  readonly session_id: string;
  readonly profile: McpProfileReference;
  readonly expires_at: string;
}

export interface OpenToolSessionRequest {
  readonly run_id: string;
  readonly execution_request_hash: `sha256:${string}`;
  readonly authority: EffectiveAgentAuthority;
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
}

export interface DiscoverToolsRequest {
  readonly run_id: string;
  readonly session_id: string;
  readonly signal: AbortSignal;
}

export interface DiscoveredToolView {
  readonly session_id: string;
  readonly snapshot_hash: `sha256:${string}`;
  readonly tools: readonly Readonly<{
    readonly name: string;
    readonly description: string;
    readonly input_schema: JsonValue;
  }>[];
}

export interface InvokeToolRequest {
  readonly run_id: string;
  readonly session_id: string;
  readonly expected_journal_head: JournalHead;
  readonly alias: string;
  readonly arguments: JsonValue;
  readonly logical_call_id: string;
  readonly operation_id: string;
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
}

export interface ResumeToolApprovalRequest {
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly call_id: string;
  readonly approval_request_hash: `sha256:${string}`;
  readonly operation_id: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
}

export interface DisposeUncertainToolRequest {
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly call_id: string;
  readonly idempotency_key: `sha256:${string}`;
  readonly operation_id: string;
  readonly disposition: ToolUncertainDisposition;
  readonly trace: TraceContext;
}

export type ToolInvocationOutcome =
  | Readonly<{
      readonly state: "RUNNING";
      readonly call: ToolCallV1;
      readonly result: ToolResultV1;
      readonly journal_head: JournalHead;
      readonly replayed: boolean;
      readonly approval?: ToolApprovalV1;
    }>
  | Readonly<{
      readonly state: "APPROVAL_PENDING";
      readonly call: ToolCallV1;
      readonly approval: ToolApprovalV1;
      readonly journal_head: JournalHead;
      readonly replayed: boolean;
    }>
  | Readonly<{
      readonly state: "FAILED" | "BLOCKED";
      readonly call: ToolCallV1;
      readonly error: RuntimeError;
      readonly journal_head: JournalHead;
      readonly replayed: boolean;
      readonly approval?: ToolApprovalV1;
    }>;

export interface ToolProfileHealth {
  readonly profile: McpProfileReference;
  readonly status: "ready" | "blocked" | "unavailable";
  readonly findings: readonly RuntimeError[];
}

export interface ToolBrokerAdapterContext {
  readonly run_id: string;
  readonly execution_request_hash: `sha256:${string}`;
  readonly authority: EffectiveAgentAuthority;
  readonly trace: TraceContext;
  readonly profile: McpProfileV1;
  readonly bindings: Readonly<Record<string, McpServerBinding>>;
}

export interface CreateToolBrokerOptions {
  readonly config: RuntimeConfigV1;
  readonly journal_store: RunJournalStore;
  readonly state_path: string;
  readonly platform: Readonly<{
    readonly os: "darwin" | "linux";
    readonly arch: string;
    readonly node: string;
  }>;
  readonly now?: () => Date;
  readonly create_session_id?: () => string;
  readonly create_adapters?: (
    context: ToolBrokerAdapterContext,
  ) => Readonly<Record<string, ToolTransportAdapter>>;
  readonly snapshot_store?: ToolDiscoverySnapshotStore;
  readonly is_process_alive?: (pid: number) => "alive" | "dead" | "unknown";
  readonly has_service_listener?: () => Promise<"present" | "absent" | "unknown">;
}

export interface ToolBroker {
  recover(): Promise<void>;
  openSession(request: OpenToolSessionRequest): Promise<ToolSessionHandle>;
  discover(request: DiscoverToolsRequest): Promise<DiscoveredToolView>;
  invoke(request: InvokeToolRequest): Promise<ToolInvocationOutcome>;
  resumeApproval(request: ResumeToolApprovalRequest): Promise<ToolInvocationOutcome>;
  disposeUncertain(request: DisposeUncertainToolRequest): Promise<ToolDispositionOutcome>;
  result(runId: string, callId: string): Promise<ToolResultV1 | null>;
  trace(runId: string, callId: string): Promise<ToolCallV1 | null>;
  capabilities(): RuntimeCapabilitiesV1;
  health(): readonly ToolProfileHealth[];
  closeSession(runId: string): Promise<void>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}

interface BrokerSession {
  readonly fingerprint: `sha256:${string}`;
  readonly authority: EffectiveAgentAuthority;
  readonly trace: TraceContext;
  readonly execution_request_hash: `sha256:${string}`;
  readonly registered: RegisteredMcpProfile;
  readonly manager: ToolSessionManager;
  readonly session: ToolSession;
  readonly handle: ToolSessionHandle;
}

function capturedJson<T>(value: T): T {
  try {
    return deepFreezeJson(parseJsonBytes(canonicalJson(value))) as unknown as T;
  } catch {
    throw new RuntimeToolError("RUNTIME_TOOL_INVALID");
  }
}

function exactHead(left: JournalHead, right: JournalHead): boolean {
  return (
    left.journal_revision === right.journal_revision &&
    left.sequence === right.sequence &&
    left.entry_hash === right.entry_hash
  );
}

function brokerError(error: unknown): RuntimeToolError {
  if (error instanceof RuntimeToolError) return new RuntimeToolError(error.code);
  return new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
}

function publicView(view: InternalDiscoveredToolView): DiscoveredToolView {
  return Object.freeze({
    session_id: view.session_id,
    snapshot_hash: view.discovery_snapshot_hash,
    tools: Object.freeze(
      view.tools.map((tool) =>
        Object.freeze({
          name: tool.alias,
          description: tool.description,
          input_schema: tool.input_schema,
        }),
      ),
    ),
  });
}

export function createToolBroker(options: CreateToolBrokerOptions): ToolBroker {
  const now = options.now ?? (() => new Date());
  const registry = createMcpProfileRegistry(options.config);
  const toolStore = createToolPrivateStore({
    state_path: options.state_path,
    now,
    ...(options.is_process_alive === undefined
      ? {}
      : { is_process_alive: options.is_process_alive }),
    has_service_listener: options.has_service_listener ?? (() => Promise.resolve("absent")),
  });
  const executor: ToolExecutor = createToolExecutor({
    journal_store: options.journal_store,
    tool_store: toolStore,
    now,
  });
  const sessions = new Map<string, BrokerSession>();
  const readiness = new Map<
    string,
    Readonly<{ status: ToolProfileHealth["status"]; findings: readonly RuntimeError[] }>
  >();
  const activeWrites = new Set<Promise<unknown>>();
  const runSerial = new Map<string, Promise<void>>();
  let accepting = true;
  const readController = new AbortController();

  for (const profile of registry.list()) {
    readiness.set(
      profile.reference.hash,
      Object.freeze({
        status: "blocked",
        findings: Object.freeze([toolRuntimeError("RUNTIME_TOOL_UNAVAILABLE")]),
      }),
    );
  }

  const snapshotStore: ToolDiscoverySnapshotStore =
    options.snapshot_store ??
    Object.freeze({
      publish: (_snapshot: McpDiscoverySnapshotV1, signal: AbortSignal) => {
        if (signal.aborted) return Promise.reject(new RuntimeToolError("RUNTIME_TOOL_CANCELLED"));
        return Promise.resolve();
      },
    });

  function ensureAccepting(signal?: AbortSignal): void {
    if (!accepting) throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
    if (signal !== undefined && (!(signal instanceof AbortSignal) || signal.aborted)) {
      throw new RuntimeToolError("RUNTIME_TOOL_CANCELLED");
    }
  }

  function updateHealth(profile: RegisteredMcpProfile, error?: unknown): void {
    if (error === undefined) {
      readiness.set(
        profile.reference.hash,
        Object.freeze({ status: "ready", findings: Object.freeze([]) }),
      );
      return;
    }
    const normalized = brokerError(error);
    const status = [
      "RUNTIME_TOOL_INVALID",
      "RUNTIME_TOOL_SCHEMA_MISMATCH",
      "RUNTIME_TOOL_PROTOCOL_DOWNGRADE",
      "RUNTIME_TOOL_RESULT_INVALID",
      "RUNTIME_TOOL_POLICY_DENIED",
    ].includes(normalized.code)
      ? "unavailable"
      : "blocked";
    readiness.set(
      profile.reference.hash,
      Object.freeze({ status, findings: Object.freeze([toolRuntimeError(normalized.code)]) }),
    );
  }

  function sessionFor(runId: string, sessionId?: string): BrokerSession {
    const entry = sessions.get(runId);
    if (entry === undefined || (sessionId !== undefined && entry.handle.session_id !== sessionId)) {
      throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
    }
    return entry;
  }

  async function serializeRun<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = runSerial.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    runSerial.set(runId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (runSerial.get(runId) === tail) runSerial.delete(runId);
    }
  }

  async function currentJournal(runId: string, expected?: JournalHead) {
    const snapshot = await options.journal_store.load(runId);
    if (snapshot === null || (expected !== undefined && !exactHead(snapshot.head, expected))) {
      throw new RuntimeToolError("RUNTIME_TOOL_OPERATION_CONFLICT");
    }
    return snapshot;
  }

  function authorize(
    entry: BrokerSession,
    request: Readonly<{
      alias: string;
      arguments: JsonValue;
      logical_call_id: string;
      trace: TraceContext;
    }>,
  ): AuthorizedToolCall {
    const snapshot = entry.session.snapshot();
    if (snapshot === null) throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
    return authorizeToolCall({
      run_id: entry.handle.run_id,
      execution_request_hash: entry.execution_request_hash,
      authority: entry.authority,
      profile: entry.registered.profile,
      session: entry.session,
      discovery_snapshot: snapshot,
      now: now(),
      trace: request.trace,
      request: {
        alias: request.alias,
        logical_call_id: request.logical_call_id,
        arguments: request.arguments,
        caller_meta: null,
      },
    });
  }

  async function failureOutcome(
    runId: string,
    callId: string,
    error: RuntimeToolError,
    replayed: boolean,
    approval?: ToolApprovalV1,
  ): Promise<ToolInvocationOutcome> {
    const call = await toolStore.latestCall(runId, callId);
    const journal = await currentJournal(runId);
    if (call === null || (journal.state !== "FAILED" && journal.state !== "BLOCKED")) throw error;
    return Object.freeze({
      state: journal.state,
      call,
      error: toolRuntimeError(error.code),
      journal_head: journal.head,
      replayed,
      ...(approval === undefined ? {} : { approval }),
    });
  }

  async function executeAuthorized(
    call: AuthorizedToolCall,
    operationId: string,
    approvalRequestHash: `sha256:${string}` | null,
    expectedJournalHead: JournalHead,
    connection: ReturnType<ToolSession["connection"]>,
    signal: AbortSignal,
    replayed: boolean,
    approval?: ToolApprovalV1,
  ): Promise<ToolInvocationOutcome> {
    const invocation = executor.invoke({
      call,
      operation_id: operationId,
      approval_request_hash: approvalRequestHash,
      expected_journal_head: expectedJournalHead,
      connection,
      signal,
    });
    if (call.operation_class !== "read-only") activeWrites.add(invocation);
    try {
      const result = await invocation;
      const stored = await toolStore.latestCall(call.run_id, call.call_id);
      const journal = await currentJournal(call.run_id);
      if (stored === null || stored.stage !== "COMPLETED" || journal.state !== "RUNNING") {
        throw new RuntimeToolError("RUNTIME_TOOL_INTERNAL");
      }
      return Object.freeze({
        state: "RUNNING",
        call: stored,
        result,
        journal_head: journal.head,
        replayed,
        ...(approval === undefined ? {} : { approval }),
      });
    } catch (error) {
      const normalized = brokerError(error);
      return await failureOutcome(call.run_id, call.call_id, normalized, replayed, approval);
    } finally {
      activeWrites.delete(invocation);
    }
  }

  async function closeAllSessions(signal: AbortSignal): Promise<void> {
    const entries = [...sessions.values()];
    sessions.clear();
    const settled = await Promise.allSettled(
      entries.map((entry) =>
        entry.manager.closeSession(
          { run_id: entry.handle.run_id, profile: entry.handle.profile },
          signal,
        ),
      ),
    );
    if (settled.some((result) => result.status === "rejected")) {
      throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
    }
  }

  const recovery = createToolRecoveryParticipant({
    journal_store: options.journal_store,
    tool_store: toolStore,
    now,
    on_stop_intake: () => readController.abort(),
    cancel_discovery_and_reads: () => {
      readController.abort();
      return Promise.resolve();
    },
    settle_write_results: async (signal) => {
      const settled = Promise.allSettled([...activeWrites]);
      if (signal.aborted) return;
      await Promise.race([
        settled,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    },
    close_connections: closeAllSessions,
  });

  const broker: ToolBroker = {
    recover: () => recovery.recover(),
    async openSession(input) {
      await Promise.resolve();
      ensureAccepting(input.signal);
      const captured = capturedJson({
        run_id: input.run_id,
        execution_request_hash: input.execution_request_hash,
        authority: input.authority,
        trace: input.trace,
      });
      const profileReference = captured.authority.mcp_profile as McpProfileReference;
      let registered: RegisteredMcpProfile;
      try {
        registered = registry.resolve(profileReference);
      } catch (error) {
        throw brokerError(error);
      }
      const fingerprint = sha256(captured);
      const existing = sessions.get(captured.run_id);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new RuntimeToolError("RUNTIME_TOOL_OPERATION_CONFLICT");
        }
        return existing.handle;
      }
      let adapters: Readonly<Record<string, ToolTransportAdapter>>;
      try {
        adapters = Object.freeze(
          options.create_adapters?.({
            run_id: captured.run_id,
            execution_request_hash: captured.execution_request_hash,
            authority: captured.authority,
            trace: captured.trace,
            profile: registered.profile,
            bindings: registered.bindings,
          }) ?? {},
        );
      } catch (error) {
        updateHealth(registered, error);
        throw brokerError(error);
      }
      const expectedBindings = Object.keys(registered.bindings).sort();
      const actualBindings = Object.keys(adapters).sort();
      if (canonicalJson(expectedBindings) !== canonicalJson(actualBindings)) {
        updateHealth(registered, new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE"));
        throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
      }
      const singleRegistry = Object.freeze({
        list: () => Object.freeze([registered]),
        resolve: (reference: McpProfileReference) => registry.resolve(reference),
      });
      const manager = createToolSessionManager({
        profile_registry: singleRegistry,
        adapters,
        snapshot_store: snapshotStore,
        now,
        create_session_id: options.create_session_id ?? (() => `session-${randomUUID()}`),
      });
      const session = manager.openSession({
        run_id: captured.run_id,
        execution_request_hash: captured.execution_request_hash,
        profile: registered.reference,
      });
      const handle = Object.freeze({
        run_id: captured.run_id,
        session_id: session.session_id,
        profile: registered.reference,
        expires_at: new Date(
          now().getTime() + registered.profile.limits.session_lifetime_ms,
        ).toISOString(),
      });
      sessions.set(
        captured.run_id,
        Object.freeze({
          fingerprint,
          authority: captured.authority,
          trace: captured.trace,
          execution_request_hash: captured.execution_request_hash,
          registered,
          manager,
          session,
          handle,
        }),
      );
      return handle;
    },
    async discover(input) {
      ensureAccepting(input.signal);
      const request = capturedJson({ run_id: input.run_id, session_id: input.session_id });
      const entry = sessionFor(request.run_id, request.session_id);
      try {
        const view = await entry.session.discover(
          AbortSignal.any([input.signal, readController.signal]),
        );
        updateHealth(entry.registered);
        return publicView(view);
      } catch (error) {
        updateHealth(entry.registered, error);
        throw brokerError(error);
      }
    },
    async invoke(input) {
      ensureAccepting(input.signal);
      const request = capturedJson({
        run_id: input.run_id,
        session_id: input.session_id,
        expected_journal_head: input.expected_journal_head,
        alias: input.alias,
        arguments: input.arguments,
        logical_call_id: input.logical_call_id,
        operation_id: input.operation_id,
        trace: input.trace,
      });
      return await serializeRun(request.run_id, async () => {
        const entry = sessionFor(request.run_id, request.session_id);
        await currentJournal(request.run_id, request.expected_journal_head);
        const call = authorize(entry, request);
        const previous = await toolStore.latestCall(call.run_id, call.call_id);
        if (call.approval_required) {
          const pending = await requestToolApproval({
            journal_store: options.journal_store,
            tool_store: toolStore,
            now,
            call,
            operation_id: request.operation_id,
            expected_journal_head: request.expected_journal_head,
          });
          return Object.freeze({
            state: "APPROVAL_PENDING",
            call: pending.call,
            approval: pending.approval,
            journal_head: pending.journal_head,
            replayed: pending.replayed,
          });
        }
        const signal =
          call.operation_class === "read-only"
            ? AbortSignal.any([input.signal, readController.signal])
            : input.signal;
        return await executeAuthorized(
          call,
          request.operation_id,
          null,
          request.expected_journal_head,
          entry.session.connection(call.server_id),
          signal,
          previous?.stage === "COMPLETED",
        );
      });
    },
    async resumeApproval(input) {
      ensureAccepting(input.signal);
      const request = capturedJson({
        run_id: input.run_id,
        expected_journal_head: input.expected_journal_head,
        call_id: input.call_id,
        approval_request_hash: input.approval_request_hash,
        operation_id: input.operation_id,
        decision: input.decision,
        trace: input.trace,
      });
      return await serializeRun(request.run_id, async () => {
        const entry = sessionFor(request.run_id);
        await currentJournal(request.run_id, request.expected_journal_head);
        const stored = await toolStore.latestCall(request.run_id, request.call_id);
        if (stored === null) throw new RuntimeToolError("RUNTIME_TOOL_APPROVAL_STALE");
        const call = authorize(entry, {
          alias: stored.alias,
          arguments: stored.logical_arguments,
          logical_call_id: stored.logical_call_id,
          trace: request.trace,
        });
        const snapshot = entry.session.snapshot();
        if (snapshot === null) throw new RuntimeToolError("RUNTIME_TOOL_APPROVAL_STALE");
        const connection = entry.session.connection(call.server_id);
        const resolved = await resumeToolApproval({
          journal_store: options.journal_store,
          tool_store: toolStore,
          now,
          executor,
          run_id: request.run_id,
          expected_journal_head: request.expected_journal_head,
          call_id: request.call_id,
          approval_request_hash: request.approval_request_hash,
          operation_id: request.operation_id,
          decision: request.decision,
          trace: request.trace,
          current_call: call,
          discovery_snapshot: snapshot,
          connection,
          signal: input.signal,
        });
        if (resolved.approval.decision === "REJECT") {
          return Object.freeze({
            state: "BLOCKED",
            call: resolved.call,
            error: toolRuntimeError("RUNTIME_TOOL_APPROVAL_REJECTED"),
            journal_head: resolved.journal_head,
            replayed: resolved.replayed,
            approval: resolved.approval,
          });
        }
        if (resolved.result !== null) {
          const completed = await toolStore.latestCall(request.run_id, request.call_id);
          if (completed === null) throw new RuntimeToolError("RUNTIME_TOOL_INTERNAL");
          return Object.freeze({
            state: "RUNNING",
            call: completed,
            result: resolved.result,
            journal_head: (await currentJournal(request.run_id)).head,
            replayed: resolved.replayed,
            approval: resolved.approval,
          });
        }
        return await executeAuthorized(
          call,
          stored.operation_id,
          resolved.approval.approval_request_hash,
          resolved.journal_head,
          connection,
          input.signal,
          true,
          resolved.approval,
        );
      });
    },
    async disposeUncertain(input) {
      ensureAccepting();
      const request = capturedJson(input);
      return await serializeRun(request.run_id, async () =>
        disposeUncertain({
          journal_store: options.journal_store,
          tool_store: toolStore,
          now,
          operation_id: request.operation_id,
          run_id: request.run_id,
          expected_journal_head: request.expected_journal_head,
          call_id: request.call_id,
          idempotency_key: request.idempotency_key,
          disposition: request.disposition,
          trace: request.trace,
        }),
      );
    },
    result: (runId, callId) => toolStore.result(runId, callId),
    trace: (runId, callId) => toolStore.latestCall(runId, callId),
    capabilities() {
      const observations: McpCapabilityReadiness[] = registry.list().map((profile) => ({
        profile: profile.reference,
        transports: profile.transports,
        ready: readiness.get(profile.reference.hash)?.status === "ready",
      }));
      return createRuntimeCapabilities(options.platform, observations);
    },
    health() {
      return Object.freeze(
        registry.list().map((profile) => {
          const observed = readiness.get(profile.reference.hash)!;
          return Object.freeze({
            profile: profile.reference,
            status: observed.status,
            findings: observed.findings,
          });
        }),
      );
    },
    async closeSession(runId) {
      ensureAccepting();
      const entry = sessions.get(runId);
      if (entry === undefined) return;
      sessions.delete(runId);
      await entry.manager.closeSession(
        { run_id: runId, profile: entry.handle.profile },
        new AbortController().signal,
      );
    },
    stopIntake() {
      if (!accepting) return;
      accepting = false;
      recovery.stopIntake();
    },
    flush: (signal) => recovery.flush(signal),
  };
  return Object.freeze(broker);
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
