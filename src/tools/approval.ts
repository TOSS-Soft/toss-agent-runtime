import { RuntimeJournalError } from "../journal/errors.js";
import {
  withRunJournalBarrier,
  type RunJournalSnapshot,
  type RunJournalStore,
  type TransitionResult,
} from "../journal/store.js";
import type { TransitionCommand } from "../journal/state-machine.js";
import type { JournalHead } from "../journal/types.js";
import { canonicalJson, sha256, type JsonValue } from "../protocol/json.js";
import type { TraceContext } from "../protocol/types.js";
import {
  hashToolApproval,
  hashToolCall,
  parseMcpDiscoverySnapshot,
  parseToolApproval,
  parseToolCall,
} from "./contracts.js";
import { RuntimeToolError } from "./errors.js";
import type { ToolExecutor } from "./executor.js";
import type { AuthorizedToolCall } from "./policy.js";
import type { ToolPrivateStore, ToolStoreOperationV1 } from "./private-store.js";
import type { ToolTransportConnection } from "./transports/types.js";
import type {
  HashableToolApprovalV1,
  HashableToolCallV1,
  McpDiscoverySnapshotV1,
  ToolApprovalDecisionV1,
  ToolApprovalRequestV1,
  ToolCallV1,
  ToolResultV1,
} from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface ToolApprovalDependencies {
  readonly journal_store: RunJournalStore;
  readonly tool_store: ToolPrivateStore;
  readonly now: () => Date;
}

export interface RequestToolApprovalInput extends ToolApprovalDependencies {
  readonly call: AuthorizedToolCall;
  readonly operation_id: string;
  readonly expected_journal_head?: JournalHead | undefined;
}

export interface ToolApprovalPendingOutcome {
  readonly state: "APPROVAL_PENDING";
  readonly journal_head: JournalHead;
  readonly call: ToolCallV1;
  readonly approval: ToolApprovalRequestV1;
  readonly replayed: boolean;
}

export interface ResumeToolApprovalInput extends ToolApprovalDependencies {
  readonly executor: ToolExecutor;
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly call_id: string;
  readonly approval_request_hash: `sha256:${string}`;
  readonly operation_id: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly trace: TraceContext;
  readonly current_call: AuthorizedToolCall;
  readonly discovery_snapshot: McpDiscoverySnapshotV1;
  readonly connection: ToolTransportConnection;
  readonly signal: AbortSignal;
}

export interface ToolApprovalDecisionOutcome {
  readonly state: "RUNNING" | "BLOCKED";
  readonly journal_head: JournalHead;
  readonly call: ToolCallV1;
  readonly approval: ToolApprovalDecisionV1;
  readonly result: ToolResultV1 | null;
  readonly replayed: boolean;
}

function invalid(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_INVALID");
}

function denied(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_POLICY_DENIED");
}

function stale(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_APPROVAL_STALE");
}

function conflict(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_OPERATION_CONFLICT");
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

function exactJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
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
    approval_request_hash: null,
    prepared_at: timestamp,
    terminal_at: null,
    result_hash: null,
    terminal_code: null,
  });
}

function bindApproval(call: ToolCallV1, approvalHash: `sha256:${string}`): ToolCallV1 {
  return parsedCall({
    protocol_version: call.protocol_version,
    schema_version: call.schema_version,
    document_type: call.document_type,
    run_id: call.run_id,
    call_revision: call.call_revision + 1,
    previous_call_hash: call.document_hash,
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
    operation_id: call.operation_id,
    call_id: call.call_id,
    idempotency_key: call.idempotency_key,
    logical_arguments: call.logical_arguments,
    logical_input_hash: call.logical_input_hash,
    approval_request_hash: approvalHash,
    prepared_at: call.prepared_at,
    terminal_at: null,
    result_hash: null,
    terminal_code: null,
  });
}

function exactAuthorizedCall(
  stored: ToolCallV1,
  authorized: AuthorizedToolCall,
  operationId: string,
  approvalHash: `sha256:${string}` | null,
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
    stored.approval_request_hash === approvalHash
  );
}

function headMatches(left: JournalHead, right: JournalHead): boolean {
  return (
    left.journal_revision === right.journal_revision &&
    left.sequence === right.sequence &&
    left.entry_hash === right.entry_hash
  );
}

function pendingCommand(
  snapshot: RunJournalSnapshot,
  call: ToolCallV1,
  trace: TraceContext,
): TransitionCommand {
  const identity = sha256({
    kind: "tool-approval-pending",
    run_id: call.run_id,
    operation_id: call.operation_id,
    call_id: call.call_id,
    call_hash: call.document_hash,
  });
  return {
    run_id: call.run_id,
    expected_revision: snapshot.head.journal_revision,
    expected_head_hash: snapshot.head.entry_hash,
    command_id: `tool-pending-${identity.slice(7, 39)}`,
    operation_id: call.operation_id,
    next_state: "APPROVAL_PENDING",
    reason_code: "TOOL_APPROVAL_REQUIRED",
    trace,
    metadata: {
      kind: "tool-approval-pending",
      call_id: call.call_id,
      call_hash: call.document_hash,
      input_hash: call.logical_input_hash,
    },
    side_effect: null,
  };
}

function approvalSummary(call: ToolCallV1): string {
  return `${call.operation_class} tool ${call.alias}; input ${call.logical_input_hash}`;
}

function parsedApproval<T extends ToolApprovalRequestV1 | ToolApprovalDecisionV1>(
  hashable: HashableToolApprovalV1,
): T {
  const candidate = { ...hashable, document_hash: hashToolApproval(hashable) };
  const parsed = parseToolApproval(canonicalJson(candidate));
  if (!parsed.ok) invalid();
  return parsed.value as T;
}

function approvalRequest(call: ToolCallV1, pendingHead: JournalHead, trace: TraceContext) {
  return parsedApproval<ToolApprovalRequestV1>({
    protocol_version: "runtime-contract.v1",
    schema_version: "tool-approval.v1",
    document_type: "tool-approval",
    kind: "REQUEST",
    run_id: call.run_id,
    pending_journal_head: pendingHead,
    execution_request_hash: call.execution_request_hash,
    agent_definition: call.agent_definition,
    task_contract: call.task_contract,
    role: call.role,
    profile: call.profile,
    discovery_snapshot_hash: call.discovery_snapshot_hash,
    server_id: call.server_id,
    alias: call.alias,
    native_name: call.native_name,
    input_schema_hash: call.input_schema_hash,
    output_schema_hash: call.output_schema_hash,
    operation_class: call.operation_class,
    logical_input_hash: call.logical_input_hash,
    call_id: call.call_id,
    idempotency_key: call.idempotency_key,
    summary: approvalSummary(call),
    decision: null,
    trace,
  });
}

function exactRequestCall(request: ToolApprovalRequestV1, call: ToolCallV1): boolean {
  return (
    request.run_id === call.run_id &&
    request.execution_request_hash === call.execution_request_hash &&
    exactJson(request.agent_definition, call.agent_definition) &&
    exactJson(request.task_contract, call.task_contract) &&
    request.role === call.role &&
    exactJson(request.profile, call.profile) &&
    request.discovery_snapshot_hash === call.discovery_snapshot_hash &&
    request.server_id === call.server_id &&
    request.alias === call.alias &&
    request.native_name === call.native_name &&
    request.input_schema_hash === call.input_schema_hash &&
    request.output_schema_hash === call.output_schema_hash &&
    request.operation_class === call.operation_class &&
    request.logical_input_hash === call.logical_input_hash &&
    request.call_id === call.call_id &&
    request.idempotency_key === call.idempotency_key
  );
}

function decisionDocument(
  request: ToolApprovalRequestV1,
  input: ResumeToolApprovalInput,
  decidedAt: string,
): ToolApprovalDecisionV1 {
  return parsedApproval<ToolApprovalDecisionV1>({
    protocol_version: "runtime-contract.v1",
    schema_version: "tool-approval.v1",
    document_type: "tool-approval",
    kind: "DECISION",
    run_id: request.run_id,
    pending_journal_head: request.pending_journal_head,
    call_id: request.call_id,
    approval_request_hash: request.document_hash,
    operation_id: input.operation_id,
    decision: input.decision,
    decided_at: decidedAt,
    trace: input.trace,
  });
}

function decisionCommand(
  request: ToolApprovalRequestV1,
  decision: ToolApprovalDecisionV1,
): TransitionCommand {
  return {
    run_id: request.run_id,
    expected_revision: request.pending_journal_head.journal_revision,
    expected_head_hash: request.pending_journal_head.entry_hash,
    command_id: `tool-decision-${decision.operation_id}`,
    operation_id: decision.operation_id,
    next_state: decision.decision === "APPROVE" ? "RUNNING" : "BLOCKED",
    reason_code:
      decision.decision === "APPROVE" ? "TOOL_APPROVAL_GRANTED" : "TOOL_APPROVAL_REJECTED",
    trace: decision.trace,
    metadata: {
      kind: "tool-approval-decision",
      call_id: request.call_id,
      request_hash: request.document_hash,
      decision_hash: decision.document_hash,
      decision: decision.decision,
    },
    side_effect: null,
  };
}

function operationClaim(
  request: ToolApprovalRequestV1,
  decision: ToolApprovalDecisionV1,
): ToolStoreOperationV1 {
  const hashable = {
    schema_version: "tool-store-operation.v1" as const,
    operation_id: `tool-decision-${request.document_hash.slice(7, 47)}`,
    operation_kind: "approval-decision" as const,
    run_id: request.run_id,
    call_id: request.call_id,
    request_hash: request.document_hash,
    outcome_hash: decision.document_hash,
    occurred_at: decision.decided_at,
  };
  return Object.freeze({ ...hashable, record_hash: sha256(hashable) });
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

function freshCurrentCall(input: ResumeToolApprovalInput, stored: ToolCallV1): void {
  const parsed = parseMcpDiscoverySnapshot(canonicalJson(input.discovery_snapshot));
  if (!parsed.ok) stale();
  const snapshot = parsed.value;
  let now: number;
  try {
    now = input.now().getTime();
  } catch {
    stale();
  }
  const server = snapshot.servers.find((candidate) => candidate.server_id === stored.server_id);
  const tool = server?.tools.find((candidate) => candidate.alias === stored.alias);
  if (
    !Number.isFinite(now) ||
    snapshot.stale ||
    now >= Date.parse(snapshot.expires_at) ||
    snapshot.document_hash !== stored.discovery_snapshot_hash ||
    snapshot.run_id !== stored.run_id ||
    snapshot.session_id !== stored.session_id ||
    !exactJson(snapshot.profile, stored.profile) ||
    input.current_call.approval_required !== true ||
    !exactAuthorizedCall(
      stored,
      input.current_call,
      stored.operation_id,
      stored.approval_request_hash,
    ) ||
    server === undefined ||
    server.transport !== stored.transport ||
    server.protocol_revision !== stored.protocol_revision ||
    server.server.identity_hash !== input.current_call.server_identity_hash ||
    tool === undefined ||
    tool.native_name !== stored.native_name ||
    tool.input_schema_hash !== stored.input_schema_hash ||
    tool.output_schema_hash !== stored.output_schema_hash ||
    tool.operation_class !== stored.operation_class
  ) {
    stale();
  }
}

export async function requestToolApproval(
  input: RequestToolApprovalInput,
): Promise<ToolApprovalPendingOutcome> {
  if (!IDENTIFIER_PATTERN.test(input.operation_id)) invalid();
  if (
    !input.call.approval_required ||
    input.call.approval !== "required" ||
    input.call.operation_class === "read-only"
  ) {
    denied();
  }
  return await underBarrier(
    input.journal_store,
    input.call.run_id,
    async (snapshot, transition) => {
      if (snapshot === null) stale();
      if (
        input.expected_journal_head !== undefined &&
        !headMatches(snapshot.head, input.expected_journal_head)
      ) {
        stale();
      }
      let call = await input.tool_store.latestCall(input.call.run_id, input.call.call_id);
      if (call !== null) {
        const expectedApproval = call.approval_request_hash;
        if (!exactAuthorizedCall(call, input.call, input.operation_id, expectedApproval))
          conflict();
        if (expectedApproval !== null) {
          const existing = await input.tool_store.approval(expectedApproval);
          if (
            existing === null ||
            existing.kind !== "REQUEST" ||
            !exactRequestCall(existing, call) ||
            snapshot.state !== "APPROVAL_PENDING" ||
            !headMatches(snapshot.head, existing.pending_journal_head)
          ) {
            conflict();
          }
          return Object.freeze({
            state: "APPROVAL_PENDING",
            journal_head: snapshot.head,
            call,
            approval: existing,
            replayed: true,
          });
        }
      } else {
        if (snapshot.state !== "RUNNING") stale();
        call = await input.tool_store.appendCall(
          preparedCall(input.call, input.operation_id, input.now().toISOString()),
        );
      }

      let pendingHead: JournalHead;
      let replayed = false;
      if (snapshot.state === "RUNNING") {
        const pending = await transition(pendingCommand(snapshot, call, input.call.trace));
        pendingHead = pending.head;
        replayed = pending.replayed;
      } else if (
        snapshot.state === "APPROVAL_PENDING" &&
        snapshot.entries.at(-1)?.metadata !== null &&
        (snapshot.entries.at(-1)?.metadata as Readonly<Record<string, JsonValue>>).call_id ===
          call.call_id
      ) {
        pendingHead = snapshot.head;
        replayed = true;
      } else {
        stale();
      }

      const request = await input.tool_store.publishApproval(
        approvalRequest(call, pendingHead, input.call.trace),
      );
      if (request.kind !== "REQUEST") conflict();
      call = await input.tool_store.appendCall(bindApproval(call, request.document_hash));
      return Object.freeze({
        state: "APPROVAL_PENDING",
        journal_head: pendingHead,
        call,
        approval: request,
        replayed,
      });
    },
  );
}

export async function resumeToolApproval(
  input: ResumeToolApprovalInput,
): Promise<ToolApprovalDecisionOutcome> {
  if (
    !IDENTIFIER_PATTERN.test(input.run_id) ||
    !IDENTIFIER_PATTERN.test(input.call_id) ||
    !HASH_PATTERN.test(input.approval_request_hash) ||
    !UUID_PATTERN.test(input.operation_id) ||
    (input.decision !== "APPROVE" && input.decision !== "REJECT")
  ) {
    invalid();
  }

  const resolved = await underBarrier(
    input.journal_store,
    input.run_id,
    async (snapshot, transition) => {
      if (snapshot === null) stale();
      const approval = await input.tool_store.approval(input.approval_request_hash);
      const call = await input.tool_store.latestCall(input.run_id, input.call_id);
      if (
        approval === null ||
        approval.kind !== "REQUEST" ||
        call === null ||
        call.stage !== "PREPARED" ||
        call.approval_request_hash !== approval.document_hash ||
        !exactRequestCall(approval, call) ||
        approval.run_id !== input.run_id ||
        approval.call_id !== input.call_id ||
        !headMatches(approval.pending_journal_head, input.expected_journal_head)
      ) {
        stale();
      }

      const claimId = `tool-decision-${approval.document_hash.slice(7, 47)}`;
      const existingClaim = await input.tool_store.operation(claimId);
      if (existingClaim !== null) {
        if (
          existingClaim.operation_kind !== "approval-decision" ||
          existingClaim.run_id !== input.run_id ||
          existingClaim.call_id !== input.call_id ||
          existingClaim.request_hash !== approval.document_hash
        ) {
          conflict();
        }
        const existingDecision = await input.tool_store.approval(existingClaim.outcome_hash);
        if (
          existingDecision === null ||
          existingDecision.kind !== "DECISION" ||
          existingDecision.operation_id !== input.operation_id ||
          existingDecision.decision !== input.decision ||
          !exactJson(existingDecision.trace, input.trace)
        ) {
          conflict();
        }
        const decisionEntry = snapshot.entries.find(
          (entry) => entry.command_id === `tool-decision-${existingDecision.operation_id}`,
        );
        if (decisionEntry !== undefined) {
          return {
            call,
            approval: existingDecision,
            journal_head: headOf(decisionEntry),
            replayed: true,
          };
        }
        if (
          snapshot.state !== "APPROVAL_PENDING" ||
          !headMatches(snapshot.head, approval.pending_journal_head)
        ) {
          conflict();
        }
        const resumed = await transition(decisionCommand(approval, existingDecision));
        return {
          call,
          approval: existingDecision,
          journal_head: resumed.head,
          replayed: true,
        };
      }

      if (
        snapshot.state !== "APPROVAL_PENDING" ||
        !headMatches(snapshot.head, input.expected_journal_head)
      ) {
        stale();
      }
      freshCurrentCall(input, call);
      const decision = await input.tool_store.publishApproval(
        decisionDocument(approval, input, input.now().toISOString()),
      );
      if (decision.kind !== "DECISION") conflict();
      await input.tool_store.recordOperation(operationClaim(approval, decision));
      const resumed = await transition(decisionCommand(approval, decision));
      return { call, approval: decision, journal_head: resumed.head, replayed: false };
    },
  );

  let result: ToolResultV1 | null = null;
  if (resolved.approval.decision === "APPROVE" && !resolved.replayed) {
    result = await input.executor.invoke({
      call: input.current_call,
      operation_id: resolved.call.operation_id,
      approval_request_hash: resolved.approval.approval_request_hash,
      expected_journal_head: resolved.journal_head,
      connection: input.connection,
      signal: input.signal,
    });
  }
  return Object.freeze({
    state: resolved.approval.decision === "APPROVE" ? "RUNNING" : "BLOCKED",
    journal_head: resolved.journal_head,
    call: resolved.call,
    approval: resolved.approval,
    result,
    replayed: resolved.replayed,
  });
}
