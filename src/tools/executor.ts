import { canonicalJson, sha256, type JsonValue } from "../protocol/json.js";
import type { TraceContext } from "../protocol/types.js";
import { RuntimeJournalError } from "../journal/errors.js";
import {
  withRunJournalBarrier,
  type RunJournalSnapshot,
  type RunJournalStore,
  type TransitionResult,
} from "../journal/store.js";
import type { TransitionCommand } from "../journal/state-machine.js";
import type { SideEffectRecord } from "../journal/types.js";
import { hashToolCall, hashToolResult, parseToolCall, parseToolResult } from "./contracts.js";
import { RuntimeToolError, toolRuntimeError, type RuntimeToolErrorCode } from "./errors.js";
import type { AuthorizedToolCall } from "./policy.js";
import type { ToolPrivateStore } from "./private-store.js";
import { normalizeToolResult } from "./redaction.js";
import type { NativeToolCallResult, ToolTransportConnection } from "./transports/types.js";
import type {
  HashableToolCallV1,
  HashableToolResultV1,
  ToolCallStage,
  ToolCallV1,
  ToolDispatchState,
  ToolResultV1,
} from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;

export type ToolTransportDispatchState = "NOT_SENT" | "MAYBE_SENT";

/**
 * A transport may use this error only when it has positive dispatch evidence.
 * Ordinary transport errors are conservatively treated as MAYBE_SENT.
 */
export class ToolTransportDispatchError extends Error {
  constructor(
    readonly dispatch_state: ToolTransportDispatchState,
    readonly error: RuntimeToolError,
  ) {
    super(error.safe_message);
    this.name = "ToolTransportDispatchError";
  }
}

export interface ToolExecutorFaultHooks {
  readonly before_prepared?: () => unknown;
  readonly after_prepared?: (call: ToolCallV1) => unknown;
  readonly before_intent?: (call: ToolCallV1) => unknown;
  readonly after_intent?: (call: ToolCallV1) => unknown;
  readonly before_dispatch?: (call: ToolCallV1) => unknown;
  readonly after_native_result?: (result: NativeToolCallResult) => unknown;
  readonly after_result_published?: (result: ToolResultV1) => unknown;
  readonly after_call_completed?: (call: ToolCallV1) => unknown;
  readonly after_call_failed?: (call: ToolCallV1) => unknown;
  readonly before_journal_completion?: (call: ToolCallV1) => unknown;
  readonly after_journal_completed?: (result: ToolResultV1) => unknown;
}

export interface CreateToolExecutorOptions {
  readonly journal_store: RunJournalStore;
  readonly tool_store: ToolPrivateStore;
  readonly now: () => Date;
  readonly fault_hooks?: ToolExecutorFaultHooks | undefined;
}

export interface ToolInvokeRequest {
  readonly call: AuthorizedToolCall;
  readonly operation_id: string;
  readonly approval_request_hash: `sha256:${string}` | null;
  readonly connection: ToolTransportConnection;
  readonly signal: AbortSignal;
}

export interface ToolExecutor {
  invoke(request: ToolInvokeRequest): Promise<ToolResultV1>;
}

function invalid(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_INVALID");
}

function conflict(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_OPERATION_CONFLICT");
}

function journalFailure(error: RuntimeJournalError): never {
  switch (error.code) {
    case "RUNTIME_STATE_STALE":
    case "RUNTIME_STATE_TRANSITION_INVALID":
    case "RUNTIME_OPERATION_CONFLICT":
      throw new RuntimeToolError("RUNTIME_TOOL_OPERATION_CONFLICT");
    case "RUNTIME_JOURNAL_UNAVAILABLE":
      throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
    case "RUNTIME_JOURNAL_CORRUPT":
    case "RUNTIME_JOURNAL_PATH_UNSAFE":
      throw new RuntimeToolError("RUNTIME_TOOL_INTERNAL");
  }
}

function exactJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function exactAuthorizedCall(
  stored: ToolCallV1,
  authorized: AuthorizedToolCall,
  operationId: string,
  approvalRequestHash: `sha256:${string}` | null,
): boolean {
  return (
    stored.run_id === authorized.run_id &&
    stored.execution_request_hash === authorized.execution_request_hash &&
    exactJson(stored.agent_definition, authorized.agent_definition) &&
    exactJson(stored.task_contract, authorized.task_contract) &&
    stored.role === authorized.role &&
    exactJson(stored.profile, authorized.profile) &&
    stored.discovery_snapshot_hash === authorized.discovery_snapshot_hash &&
    stored.session_id === authorized.session_id &&
    stored.server_id === authorized.server_id &&
    stored.transport === authorized.transport &&
    stored.protocol_revision === authorized.protocol_revision &&
    stored.alias === authorized.alias &&
    stored.native_name === authorized.native_name &&
    stored.input_schema_hash === authorized.input_schema_hash &&
    stored.output_schema_hash === authorized.output_schema_hash &&
    stored.operation_class === authorized.operation_class &&
    stored.logical_call_id === authorized.logical_call_id &&
    stored.operation_id === operationId &&
    stored.call_id === authorized.call_id &&
    stored.idempotency_key === authorized.idempotency_key &&
    exactJson(stored.logical_arguments, authorized.logical_arguments) &&
    stored.logical_input_hash === authorized.logical_input_hash &&
    stored.approval_request_hash === approvalRequestHash
  );
}

function parsedCall(hashable: HashableToolCallV1): ToolCallV1 {
  const candidate = { ...hashable, document_hash: hashToolCall(hashable) };
  const parsed = parseToolCall(canonicalJson(candidate));
  if (!parsed.ok) invalid();
  return parsed.value;
}

function preparedCall(
  call: AuthorizedToolCall,
  operationId: string,
  approvalRequestHash: `sha256:${string}` | null,
  timestamp: string,
): ToolCallV1 {
  return parsedCall({
    protocol_version: "runtime-contract.v1",
    schema_version: "tool-call.v1",
    document_type: "tool-call",
    run_id: call.run_id,
    call_revision: 1,
    previous_call_hash: null,
    stage: "PREPARED",
    dispatch_state: "NOT_SENT",
    execution_request_hash: call.execution_request_hash,
    agent_definition: call.agent_definition,
    task_contract: call.task_contract,
    role: call.role,
    profile: call.profile,
    discovery_snapshot_hash: call.discovery_snapshot_hash,
    session_id: call.session_id,
    server_id: call.server_id,
    transport: call.transport,
    protocol_revision: call.protocol_revision,
    alias: call.alias,
    native_name: call.native_name,
    input_schema_hash: call.input_schema_hash,
    output_schema_hash: call.output_schema_hash,
    operation_class: call.operation_class,
    logical_call_id: call.logical_call_id,
    operation_id: operationId,
    call_id: call.call_id,
    idempotency_key: call.idempotency_key,
    logical_arguments: call.logical_arguments,
    logical_input_hash: call.logical_input_hash,
    approval_request_hash: approvalRequestHash,
    prepared_at: timestamp,
    terminal_at: null,
    result_hash: null,
    terminal_code: null,
  });
}

function terminalCall(
  previous: ToolCallV1,
  stage: Exclude<ToolCallStage, "PREPARED">,
  dispatchState: ToolDispatchState,
  resultHash: `sha256:${string}` | null,
  terminalCode: RuntimeToolErrorCode | null,
  timestamp: string,
): ToolCallV1 {
  return parsedCall({
    protocol_version: previous.protocol_version,
    schema_version: previous.schema_version,
    document_type: previous.document_type,
    run_id: previous.run_id,
    call_revision: previous.call_revision + 1,
    previous_call_hash: previous.document_hash,
    stage,
    dispatch_state: dispatchState,
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
    result_hash: resultHash,
    terminal_code: terminalCode,
  });
}

function failureResult(call: AuthorizedToolCall, code: RuntimeToolErrorCode): ToolResultV1 {
  const hashable: HashableToolResultV1 = {
    protocol_version: "runtime-contract.v1",
    schema_version: "tool-result.v1",
    document_type: "tool-result",
    run_id: call.run_id,
    call_id: call.call_id,
    idempotency_key: call.idempotency_key,
    status: "error",
    is_error: true,
    trust: "untrusted-content",
    content: Object.freeze([]),
    structured_content: null,
    provenance: Object.freeze({
      profile: call.profile,
      discovery_snapshot_hash: call.discovery_snapshot_hash,
      server_id: call.server_id,
      server_identity_hash: call.server_identity_hash,
      protocol_revision: call.protocol_revision,
      transport: call.transport,
      alias: call.alias,
      native_name: call.native_name,
      input_schema_hash: call.input_schema_hash,
      output_schema_hash: call.output_schema_hash,
      call_id: call.call_id,
      idempotency_key: call.idempotency_key,
    }),
    trace: call.trace,
    accounting: Object.freeze({ content_blocks: 0, total_bytes: 0, structured_bytes: 0 }),
    error: toolRuntimeError(code),
  };
  const candidate = { ...hashable, document_hash: hashToolResult(hashable) };
  const parsed = parseToolResult(canonicalJson(candidate));
  if (!parsed.ok) invalid();
  return parsed.value;
}

/** @internal Durable recovery must use the exact side-effect input identity. */
export function toolDispatchInputHash(call: ToolCallV1): `sha256:${string}` {
  return sha256({
    run_id: call.run_id,
    operation_id: call.operation_id,
    call_id: call.call_id,
    idempotency_key: call.idempotency_key,
    profile_hash: call.profile.hash,
    discovery_snapshot_hash: call.discovery_snapshot_hash,
    server_id: call.server_id,
    alias: call.alias,
    native_name: call.native_name,
    input_schema_hash: call.input_schema_hash,
    output_schema_hash: call.output_schema_hash,
    logical_input_hash: call.logical_input_hash,
    role: call.role,
  });
}

function commandId(phase: "intent" | "complete" | "failed" | "blocked", inputHash: string): string {
  return `tool-${phase}-${sha256({ phase, input_hash: inputHash }).slice(7, 39)}`;
}

function safeMetadata(call: ToolCallV1, inputHash: `sha256:${string}`): JsonValue {
  return {
    call_id: call.call_id,
    server_id: call.server_id,
    alias: call.alias,
    input_hash: inputHash,
  };
}

function transitionCommand(
  snapshot: Pick<RunJournalSnapshot, "head">,
  call: ToolCallV1,
  inputHash: `sha256:${string}`,
  trace: TraceContext,
  phase: "intent" | "complete" | "failed" | "blocked",
  outputHash: `sha256:${string}` | null,
): TransitionCommand {
  const sideEffect: SideEffectRecord | null =
    phase === "blocked"
      ? null
      : Object.freeze({
          identity: call.operation_id,
          phase: phase === "intent" ? "INTENT" : "COMPLETED",
          input_hash: inputHash,
          output_hash: phase === "intent" ? null : outputHash,
        });
  return {
    run_id: call.run_id,
    expected_revision: snapshot.head.journal_revision,
    expected_head_hash: snapshot.head.entry_hash,
    command_id: commandId(phase, inputHash),
    operation_id: phase === "blocked" ? null : call.operation_id,
    next_state:
      phase === "intent"
        ? "TOOL_PENDING"
        : phase === "complete"
          ? "RUNNING"
          : phase === "failed"
            ? "FAILED"
            : "BLOCKED",
    reason_code:
      phase === "intent"
        ? "TOOL_DISPATCH_INTENT"
        : phase === "complete"
          ? "TOOL_DISPATCH_COMPLETED"
          : phase === "failed"
            ? "TOOL_DISPATCH_NOT_SENT"
            : "TOOL_EFFECT_UNCERTAIN",
    trace,
    metadata: safeMetadata(call, inputHash),
    side_effect: sideEffect,
  };
}

async function journalTransition(
  transition: (command: TransitionCommand) => Promise<TransitionResult>,
  command: TransitionCommand,
): Promise<TransitionResult> {
  try {
    return await transition(command);
  } catch (error) {
    if (error instanceof RuntimeJournalError) journalFailure(error);
    throw error;
  }
}

function runtimeDispatchFailure(error: unknown): {
  readonly dispatch_state: ToolTransportDispatchState;
  readonly error: RuntimeToolError;
} {
  if (error instanceof ToolTransportDispatchError) {
    return { dispatch_state: error.dispatch_state, error: error.error };
  }
  return {
    dispatch_state: "MAYBE_SENT",
    error:
      error instanceof RuntimeToolError ? error : new RuntimeToolError("RUNTIME_TOOL_INTERNAL"),
  };
}

function timedSignal(
  signal: AbortSignal,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  timer.unref();
  return {
    signal: AbortSignal.any([signal, timeout.signal]),
    dispose: () => clearTimeout(timer),
  };
}

function unresolvedIntent(
  snapshot: RunJournalSnapshot,
  call: ToolCallV1,
  inputHash: `sha256:${string}`,
): boolean {
  return snapshot.unresolved_side_effects.some(
    (effect) => effect.identity === call.operation_id && effect.input_hash === inputHash,
  );
}

export function createToolExecutor(options: CreateToolExecutorOptions): ToolExecutor {
  const hooks = options.fault_hooks ?? {};
  const active = new Map<
    string,
    Readonly<{ fingerprint: `sha256:${string}`; promise: Promise<ToolResultV1> }>
  >();

  type StartResult =
    | Readonly<{ kind: "replay"; result: ToolResultV1 }>
    | Readonly<{
        kind: "dispatch";
        stored: ToolCallV1;
        input_hash: `sha256:${string}`;
      }>;

  async function underBarrier<T>(
    runId: string,
    operation: (
      snapshot: RunJournalSnapshot | null,
      transition: (command: TransitionCommand) => Promise<TransitionResult>,
    ) => Promise<T>,
  ): Promise<T> {
    try {
      return await withRunJournalBarrier(options.journal_store, runId, operation);
    } catch (error) {
      if (error instanceof RuntimeJournalError) journalFailure(error);
      throw error;
    }
  }

  async function startInvocation(request: ToolInvokeRequest): Promise<StartResult> {
    return await underBarrier(request.call.run_id, async (snapshot, transition) => {
      if (snapshot === null) conflict();
      let stored = await options.tool_store.latestCall(request.call.run_id, request.call.call_id);
      if (
        stored !== null &&
        !exactAuthorizedCall(
          stored,
          request.call,
          request.operation_id,
          request.approval_request_hash,
        )
      ) {
        conflict();
      }

      if (stored?.stage === "COMPLETED") {
        const result = await options.tool_store.result(stored.run_id, stored.call_id);
        if (result === null || result.document_hash !== stored.result_hash) conflict();
        const inputHash = toolDispatchInputHash(stored);
        if (snapshot.state === "TOOL_PENDING" && unresolvedIntent(snapshot, stored, inputHash)) {
          await hooks.before_journal_completion?.(stored);
          await journalTransition(
            transition,
            transitionCommand(
              snapshot,
              stored,
              inputHash,
              request.call.trace,
              "complete",
              result.document_hash,
            ),
          );
          await hooks.after_journal_completed?.(result);
        } else if (snapshot.state !== "RUNNING") {
          conflict();
        }
        return { kind: "replay", result };
      }
      if (stored?.stage === "FAILED") {
        const inputHash = toolDispatchInputHash(stored);
        const result = await options.tool_store.result(stored.run_id, stored.call_id);
        if (result === null || result.document_hash !== stored.result_hash) conflict();
        if (snapshot.state === "TOOL_PENDING" && unresolvedIntent(snapshot, stored, inputHash)) {
          await journalTransition(
            transition,
            transitionCommand(
              snapshot,
              stored,
              inputHash,
              request.call.trace,
              "failed",
              result.document_hash,
            ),
          );
        } else if (snapshot.state !== "FAILED") {
          conflict();
        }
        throw new RuntimeToolError(stored.terminal_code ?? "RUNTIME_TOOL_INTERNAL");
      }
      if (stored?.stage === "UNCERTAIN") {
        const inputHash = toolDispatchInputHash(stored);
        if (snapshot.state === "TOOL_PENDING" && unresolvedIntent(snapshot, stored, inputHash)) {
          await journalTransition(
            transition,
            transitionCommand(snapshot, stored, inputHash, request.call.trace, "blocked", null),
          );
        } else if (snapshot.state !== "BLOCKED") {
          conflict();
        }
        throw new RuntimeToolError("RUNTIME_TOOL_EFFECT_UNCERTAIN");
      }

      if (stored === null) {
        if (snapshot.state !== "RUNNING") conflict();
        await hooks.before_prepared?.();
        stored = await options.tool_store.appendCall(
          preparedCall(
            request.call,
            request.operation_id,
            request.approval_request_hash,
            options.now().toISOString(),
          ),
        );
        await hooks.after_prepared?.(stored);
      }

      const inputHash = toolDispatchInputHash(stored);
      if (snapshot.state === "TOOL_PENDING" && unresolvedIntent(snapshot, stored, inputHash)) {
        const persistedResult = await options.tool_store.result(stored.run_id, stored.call_id);
        if (persistedResult !== null) {
          const completedCall = await options.tool_store.appendCall(
            terminalCall(
              stored,
              "COMPLETED",
              "RESULT_RECEIVED",
              persistedResult.document_hash,
              null,
              options.now().toISOString(),
            ),
          );
          await hooks.after_call_completed?.(completedCall);
          await hooks.before_journal_completion?.(completedCall);
          await journalTransition(
            transition,
            transitionCommand(
              snapshot,
              completedCall,
              inputHash,
              request.call.trace,
              "complete",
              persistedResult.document_hash,
            ),
          );
          await hooks.after_journal_completed?.(persistedResult);
          return { kind: "replay", result: persistedResult };
        }
        const uncertain = await options.tool_store.appendCall(
          terminalCall(
            stored,
            "UNCERTAIN",
            "MAYBE_SENT",
            null,
            "RUNTIME_TOOL_EFFECT_UNCERTAIN",
            options.now().toISOString(),
          ),
        );
        await journalTransition(
          transition,
          transitionCommand(snapshot, uncertain, inputHash, request.call.trace, "blocked", null),
        );
        throw new RuntimeToolError("RUNTIME_TOOL_EFFECT_UNCERTAIN");
      }
      if (snapshot.state !== "RUNNING") conflict();

      await hooks.before_intent?.(stored);
      await journalTransition(
        transition,
        transitionCommand(snapshot, stored, inputHash, request.call.trace, "intent", null),
      );
      await hooks.after_intent?.(stored);
      return { kind: "dispatch", stored, input_hash: inputHash };
    });
  }

  async function closeLedger(
    call: ToolCallV1,
    inputHash: `sha256:${string}`,
    trace: TraceContext,
    phase: "complete" | "failed" | "blocked",
    outputHash: `sha256:${string}` | null,
    result: ToolResultV1 | null,
  ): Promise<void> {
    await underBarrier(call.run_id, async (snapshot, transition) => {
      if (snapshot === null) conflict();
      if (phase === "complete") await hooks.before_journal_completion?.(call);
      if (snapshot.state === "TOOL_PENDING" && unresolvedIntent(snapshot, call, inputHash)) {
        await journalTransition(
          transition,
          transitionCommand(snapshot, call, inputHash, trace, phase, outputHash),
        );
      } else {
        const terminalState =
          (phase === "complete" && snapshot.state === "RUNNING") ||
          (phase === "failed" && snapshot.state === "FAILED") ||
          (phase === "blocked" && snapshot.state === "BLOCKED");
        if (!terminalState) conflict();
      }
      if (phase === "complete" && result !== null) {
        await hooks.after_journal_completed?.(result);
      }
    });
  }

  async function finishNotSent(
    request: ToolInvokeRequest,
    stored: ToolCallV1,
    inputHash: `sha256:${string}`,
    failure: RuntimeToolError,
  ): Promise<never> {
    const result = await options.tool_store.publishResult(
      failureResult(request.call, failure.code),
    );
    const failedCall = await options.tool_store.appendCall(
      terminalCall(
        stored,
        "FAILED",
        "NOT_SENT",
        result.document_hash,
        failure.code,
        options.now().toISOString(),
      ),
    );
    await hooks.after_call_failed?.(failedCall);
    await closeLedger(
      failedCall,
      inputHash,
      request.call.trace,
      "failed",
      result.document_hash,
      null,
    );
    throw failure;
  }

  async function finishUncertain(
    request: ToolInvokeRequest,
    stored: ToolCallV1,
    inputHash: `sha256:${string}`,
  ): Promise<never> {
    const uncertain = await options.tool_store.appendCall(
      terminalCall(
        stored,
        "UNCERTAIN",
        "MAYBE_SENT",
        null,
        "RUNTIME_TOOL_EFFECT_UNCERTAIN",
        options.now().toISOString(),
      ),
    );
    await closeLedger(uncertain, inputHash, request.call.trace, "blocked", null, null);
    throw new RuntimeToolError("RUNTIME_TOOL_EFFECT_UNCERTAIN");
  }

  async function execute(request: ToolInvokeRequest): Promise<ToolResultV1> {
    const start = await startInvocation(request);
    if (start.kind === "replay") return start.result;
    const { stored, input_hash: inputHash } = start;
    await hooks.before_dispatch?.(stored);

    if (request.signal.aborted) {
      return await finishNotSent(
        request,
        stored,
        inputHash,
        new RuntimeToolError("RUNTIME_TOOL_CANCELLED"),
      );
    }

    let nativeResult: NativeToolCallResult;
    const deadline = timedSignal(request.signal, request.call.timeout_ms);
    try {
      nativeResult = await request.connection.callTool(
        {
          name: request.call.native_name,
          arguments: request.call.logical_arguments as Readonly<Record<string, JsonValue>>,
          trusted_meta: request.call.trusted_meta,
        },
        deadline.signal,
      );
    } catch (error) {
      const failure = runtimeDispatchFailure(error);
      if (failure.dispatch_state === "NOT_SENT") {
        return await finishNotSent(request, stored, inputHash, failure.error);
      }
      return await finishUncertain(request, stored, inputHash);
    } finally {
      deadline.dispose();
    }

    await hooks.after_native_result?.(nativeResult);
    let result: ToolResultV1;
    try {
      result = normalizeToolResult({
        call: request.call,
        observation: request.connection.server,
        result: nativeResult,
      });
      result = await options.tool_store.publishResult(result);
    } catch {
      return await finishUncertain(request, stored, inputHash);
    }
    await hooks.after_result_published?.(result);
    const completedCall = await options.tool_store.appendCall(
      terminalCall(
        stored,
        "COMPLETED",
        "RESULT_RECEIVED",
        result.document_hash,
        null,
        options.now().toISOString(),
      ),
    );
    await hooks.after_call_completed?.(completedCall);
    await closeLedger(
      completedCall,
      inputHash,
      request.call.trace,
      "complete",
      result.document_hash,
      result,
    );
    return result;
  }

  return Object.freeze({
    async invoke(request: ToolInvokeRequest): Promise<ToolResultV1> {
      if (!IDENTIFIER_PATTERN.test(request.operation_id)) invalid();
      if (request.call.approval_required && request.approval_request_hash === null) {
        throw new RuntimeToolError("RUNTIME_TOOL_APPROVAL_REQUIRED");
      }
      const key = `${request.call.run_id}\0${request.call.call_id}`;
      const fingerprint = sha256({
        operation_id: request.operation_id,
        approval_request_hash: request.approval_request_hash,
        call_id: request.call.call_id,
        idempotency_key: request.call.idempotency_key,
        run_id: request.call.run_id,
        execution_request_hash: request.call.execution_request_hash,
        agent_definition: request.call.agent_definition,
        task_contract: request.call.task_contract,
        logical_input_hash: request.call.logical_input_hash,
        logical_call_id: request.call.logical_call_id,
        profile_hash: request.call.profile.hash,
        discovery_snapshot_hash: request.call.discovery_snapshot_hash,
        session_id: request.call.session_id,
        server_id: request.call.server_id,
        transport: request.call.transport,
        protocol_revision: request.call.protocol_revision,
        alias: request.call.alias,
        native_name: request.call.native_name,
        input_schema_hash: request.call.input_schema_hash,
        output_schema_hash: request.call.output_schema_hash,
        operation_class: request.call.operation_class,
        approval_required: request.call.approval_required,
        role: request.call.role,
      });
      const existing = active.get(key);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) conflict();
        return await existing.promise;
      }
      const promise = execute(request);
      active.set(key, Object.freeze({ fingerprint, promise }));
      try {
        return await promise;
      } finally {
        if (active.get(key)?.promise === promise) active.delete(key);
      }
    },
  });
}
