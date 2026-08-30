import type { TransitionResult } from "../journal/store.js";
import type { TransitionCommand } from "../journal/state-machine.js";
import type { JournalHead, RunJournalEntryV1 } from "../journal/types.js";
import { canonicalJson, deepFreezeJson, sha256, type JsonValue } from "../protocol/json.js";
import type { TraceContext } from "../protocol/types.js";
import { parseSuperpowersApproval, parseSuperpowersPhase } from "./contracts.js";
import { RuntimeSkillError } from "./errors.js";
import type {
  SuperpowersApprovalDecisionV1,
  SuperpowersApprovalRequestV1,
  SuperpowersApprovalV1,
  SuperpowersPhaseName,
  SuperpowersPhaseV1,
} from "./types.js";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SEMVER_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export interface ResumeSuperpowersApprovalRequest {
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly phase: SuperpowersPhaseName;
  readonly skill_name: string;
  readonly skill_version: string;
  readonly skill_snapshot_hash: `sha256:${string}`;
  readonly approval_request_hash: `sha256:${string}`;
  readonly operation_id: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly trace: TraceContext;
}

export interface SuperpowersApprovalOutcome {
  readonly state: "RUNNING" | "APPROVAL_PENDING" | "BLOCKED";
  readonly phase: SuperpowersPhaseV1;
  readonly journal_head: JournalHead;
  readonly approval: SuperpowersApprovalV1;
  readonly replayed: boolean;
}

export interface ApprovalPendingJournalMetadata {
  readonly kind: "superpowers-approval-pending";
  readonly phase: SuperpowersPhaseV1;
}

export interface ApprovalDecisionJournalMetadata {
  readonly kind: "superpowers-approval-decision";
  readonly request: SuperpowersApprovalRequestV1;
  readonly decision: SuperpowersApprovalDecisionV1;
  readonly occurred_at: string;
  readonly phase: SuperpowersPhaseV1;
}

function invalid(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_INVALID");
}

function integrity(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY");
}

function closedRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    invalid();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    invalid();
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      invalid();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function copyHead(value: unknown): JournalHead {
  const head = closedRecord(value, ["journal_revision", "sequence", "entry_hash"]);
  if (
    typeof head.journal_revision !== "number" ||
    !Number.isSafeInteger(head.journal_revision) ||
    head.journal_revision < 1 ||
    typeof head.sequence !== "number" ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 1 ||
    typeof head.entry_hash !== "string" ||
    !HASH_PATTERN.test(head.entry_hash)
  ) {
    invalid();
  }
  return Object.freeze({
    journal_revision: head.journal_revision,
    sequence: head.sequence,
    entry_hash: head.entry_hash as `sha256:${string}`,
  });
}

function copyTrace(value: unknown): TraceContext {
  if (typeof value !== "object" || value === null) invalid();
  const keys = Object.prototype.hasOwnProperty.call(value, "trace_state")
    ? ["trace_id", "span_id", "trace_flags", "trace_state"]
    : ["trace_id", "span_id", "trace_flags"];
  const trace = closedRecord(value, keys);
  if (
    typeof trace.trace_id !== "string" ||
    !/^[0-9a-f]{32}$/u.test(trace.trace_id) ||
    typeof trace.span_id !== "string" ||
    !/^[0-9a-f]{16}$/u.test(trace.span_id) ||
    typeof trace.trace_flags !== "number" ||
    !Number.isSafeInteger(trace.trace_flags) ||
    trace.trace_flags < 0 ||
    trace.trace_flags > 255 ||
    (trace.trace_state !== undefined &&
      (typeof trace.trace_state !== "string" || trace.trace_state.length > 512))
  ) {
    invalid();
  }
  return Object.freeze({
    trace_id: trace.trace_id,
    span_id: trace.span_id,
    trace_flags: trace.trace_flags,
    ...(trace.trace_state === undefined ? {} : { trace_state: trace.trace_state }),
  });
}

export function captureResumeSuperpowersApprovalRequest(
  value: unknown,
): ResumeSuperpowersApprovalRequest {
  const request = closedRecord(value, [
    "run_id",
    "expected_journal_head",
    "phase",
    "skill_name",
    "skill_version",
    "skill_snapshot_hash",
    "approval_request_hash",
    "operation_id",
    "decision",
    "trace",
  ]);
  if (
    typeof request.run_id !== "string" ||
    !IDENTIFIER_PATTERN.test(request.run_id) ||
    typeof request.phase !== "string" ||
    ![
      "BRAINSTORMING",
      "TEST_DESIGN",
      "RED",
      "GREEN",
      "DEBUGGING",
      "REVIEW",
      "VERIFICATION",
    ].includes(request.phase) ||
    typeof request.skill_name !== "string" ||
    !IDENTIFIER_PATTERN.test(request.skill_name) ||
    typeof request.skill_version !== "string" ||
    !SEMVER_PATTERN.test(request.skill_version) ||
    typeof request.skill_snapshot_hash !== "string" ||
    !HASH_PATTERN.test(request.skill_snapshot_hash) ||
    typeof request.approval_request_hash !== "string" ||
    !HASH_PATTERN.test(request.approval_request_hash) ||
    typeof request.operation_id !== "string" ||
    !UUID_PATTERN.test(request.operation_id) ||
    (request.decision !== "APPROVE" && request.decision !== "REJECT")
  ) {
    invalid();
  }
  return Object.freeze({
    run_id: request.run_id,
    expected_journal_head: copyHead(request.expected_journal_head),
    phase: request.phase as SuperpowersPhaseName,
    skill_name: request.skill_name,
    skill_version: request.skill_version,
    skill_snapshot_hash: request.skill_snapshot_hash as `sha256:${string}`,
    approval_request_hash: request.approval_request_hash as `sha256:${string}`,
    operation_id: request.operation_id,
    decision: request.decision,
    trace: copyTrace(request.trace),
  });
}

function parsedPhase(value: Omit<SuperpowersPhaseV1, "document_hash">): SuperpowersPhaseV1 {
  const candidate = { ...value, document_hash: sha256(value) } as SuperpowersPhaseV1;
  const parsed = parseSuperpowersPhase(canonicalJson(candidate));
  if (!parsed.ok) invalid();
  return deepFreezeJson(parsed.value as unknown as JsonValue) as unknown as SuperpowersPhaseV1;
}

function parsedApproval<T extends SuperpowersApprovalV1>(value: Omit<T, "document_hash">): T {
  const candidate = { ...value, document_hash: sha256(value) } as T;
  const parsed = parseSuperpowersApproval(canonicalJson(candidate));
  if (!parsed.ok) invalid();
  return deepFreezeJson(parsed.value as unknown as JsonValue) as unknown as T;
}

export function requestSuperpowersApproval(options: {
  readonly started: SuperpowersPhaseV1;
  readonly output_hash: `sha256:${string}`;
  readonly occurred_at: string;
  readonly trace: TraceContext;
}): SuperpowersPhaseV1 {
  if (
    options.started.status !== "STARTED" ||
    options.started.phase !== "BRAINSTORMING" ||
    !HASH_PATTERN.test(options.output_hash)
  ) {
    invalid();
  }
  return parsedPhase({
    protocol_version: "runtime-contract.v1",
    schema_version: "superpowers-phase.v1",
    document_type: "superpowers-phase",
    run_id: options.started.run_id,
    phase_revision: options.started.phase_revision + 1,
    previous_phase_hash: options.started.document_hash,
    execution_request_hash: options.started.execution_request_hash,
    observed_journal_head: options.started.observed_journal_head,
    catalog_hash: options.started.catalog_hash,
    skill: options.started.skill,
    phase: options.started.phase,
    handler: options.started.handler,
    operation_id: options.started.operation_id,
    status: "APPROVAL_PENDING",
    predecessor_phase_hashes: options.started.predecessor_phase_hashes,
    input_hash: options.started.input_hash,
    context_hash: options.started.context_hash,
    output_hash: options.output_hash,
    occurred_at: options.occurred_at,
    trace: copyTrace(options.trace),
  });
}

export function approvalPendingCommand(pending: SuperpowersPhaseV1): TransitionCommand {
  if (pending.status !== "APPROVAL_PENDING" || pending.output_hash === null) invalid();
  const operationHash = sha256({
    kind: "superpowers-approval-pending",
    run_id: pending.run_id,
    operation_id: pending.operation_id,
  });
  return Object.freeze({
    run_id: pending.run_id,
    expected_revision: pending.observed_journal_head.journal_revision,
    expected_head_hash: pending.observed_journal_head.entry_hash,
    command_id: `approval-pending:${operationHash}`,
    operation_id: pending.operation_id,
    next_state: "APPROVAL_PENDING",
    reason_code: "SUPERPOWERS_APPROVAL_REQUIRED",
    trace: pending.trace,
    metadata: deepFreezeJson({
      kind: "superpowers-approval-pending",
      phase: pending,
    } as unknown as JsonValue),
    side_effect: null,
  });
}

export function approvalRequest(
  pending: SuperpowersPhaseV1,
  pendingHead: JournalHead,
): SuperpowersApprovalRequestV1 {
  if (pending.status !== "APPROVAL_PENDING" || pending.output_hash === null) invalid();
  return parsedApproval<SuperpowersApprovalRequestV1>({
    protocol_version: "runtime-contract.v1",
    schema_version: "superpowers-approval.v1",
    document_type: "superpowers-approval",
    kind: "REQUEST",
    run_id: pending.run_id,
    pending_journal_head: Object.freeze({ ...pendingHead }),
    phase_document_hash: pending.document_hash,
    phase: pending.phase,
    skill_name: pending.skill.name,
    skill_version: pending.skill.version,
    skill_snapshot_hash: pending.skill.snapshot_hash,
    phase_operation_id: pending.operation_id,
    decision: null,
    trace: pending.trace,
  });
}

export function approvalDecision(
  request: SuperpowersApprovalRequestV1,
  resume: ResumeSuperpowersApprovalRequest,
): SuperpowersApprovalDecisionV1 {
  return parsedApproval<SuperpowersApprovalDecisionV1>({
    protocol_version: "runtime-contract.v1",
    schema_version: "superpowers-approval.v1",
    document_type: "superpowers-approval",
    kind: "DECISION",
    run_id: request.run_id,
    pending_journal_head: request.pending_journal_head,
    phase_document_hash: request.phase_document_hash,
    phase: request.phase,
    skill_name: request.skill_name,
    skill_version: request.skill_version,
    skill_snapshot_hash: request.skill_snapshot_hash,
    phase_operation_id: request.phase_operation_id,
    approval_request_hash: request.document_hash,
    operation_id: resume.operation_id,
    decision: resume.decision,
    trace: resume.trace,
  });
}

export function approvalTerminalPhase(options: {
  readonly pending: SuperpowersPhaseV1;
  readonly decision: SuperpowersApprovalDecisionV1;
  readonly occurred_at: string;
}): SuperpowersPhaseV1 {
  return parsedPhase({
    protocol_version: "runtime-contract.v1",
    schema_version: "superpowers-phase.v1",
    document_type: "superpowers-phase",
    run_id: options.pending.run_id,
    phase_revision: options.pending.phase_revision + 1,
    previous_phase_hash: options.pending.document_hash,
    execution_request_hash: options.pending.execution_request_hash,
    observed_journal_head: options.pending.observed_journal_head,
    catalog_hash: options.pending.catalog_hash,
    skill: options.pending.skill,
    phase: options.pending.phase,
    handler: options.pending.handler,
    operation_id: options.pending.operation_id,
    status: options.decision.decision === "APPROVE" ? "COMPLETED" : "BLOCKED",
    predecessor_phase_hashes: options.pending.predecessor_phase_hashes,
    input_hash: options.pending.input_hash,
    context_hash: options.pending.context_hash,
    output_hash: options.decision.decision === "APPROVE" ? options.pending.output_hash : null,
    occurred_at: options.occurred_at,
    trace: options.decision.trace,
  });
}

export function approvalDecisionCommand(options: {
  readonly request: SuperpowersApprovalRequestV1;
  readonly decision: SuperpowersApprovalDecisionV1;
  readonly terminal: SuperpowersPhaseV1;
}): TransitionCommand {
  return Object.freeze({
    run_id: options.request.run_id,
    expected_revision: options.request.pending_journal_head.journal_revision,
    expected_head_hash: options.request.pending_journal_head.entry_hash,
    command_id: `approval-decision:${options.decision.operation_id}`,
    operation_id: options.decision.operation_id,
    next_state: options.decision.decision === "APPROVE" ? "RUNNING" : "BLOCKED",
    reason_code:
      options.decision.decision === "APPROVE"
        ? "SUPERPOWERS_APPROVAL_GRANTED"
        : "SUPERPOWERS_APPROVAL_REJECTED",
    trace: options.decision.trace,
    metadata: deepFreezeJson({
      kind: "superpowers-approval-decision",
      request: options.request,
      decision: options.decision,
      occurred_at: options.terminal.occurred_at,
      phase: options.terminal,
    } as unknown as JsonValue),
    side_effect: null,
  });
}

export function pendingOutcome(options: {
  readonly phase: SuperpowersPhaseV1;
  readonly transition: TransitionResult;
  readonly replayed: boolean;
}): SuperpowersApprovalOutcome {
  return deepFreezeJson({
    state: "APPROVAL_PENDING",
    phase: options.phase,
    journal_head: options.transition.head,
    approval: approvalRequest(options.phase, options.transition.head),
    replayed: options.replayed,
  } as unknown as JsonValue) as unknown as SuperpowersApprovalOutcome;
}

export function decisionOutcome(options: {
  readonly phase: SuperpowersPhaseV1;
  readonly transition: TransitionResult;
  readonly approval: SuperpowersApprovalDecisionV1;
  readonly replayed: boolean;
}): SuperpowersApprovalOutcome {
  return deepFreezeJson({
    state: options.approval.decision === "APPROVE" ? "RUNNING" : "BLOCKED",
    phase: options.phase,
    journal_head: options.transition.head,
    approval: options.approval,
    replayed: options.replayed,
  } as unknown as JsonValue) as unknown as SuperpowersApprovalOutcome;
}

function parsedApprovalDocument(value: unknown): SuperpowersApprovalV1 {
  const parsed = parseSuperpowersApproval(canonicalJson(value));
  if (!parsed.ok) integrity();
  return parsed.value;
}

function parsedPhaseDocument(value: unknown): SuperpowersPhaseV1 {
  const parsed = parseSuperpowersPhase(canonicalJson(value));
  if (!parsed.ok) integrity();
  return parsed.value;
}

function transitionCommandInputHash(command: TransitionCommand): `sha256:${string}` {
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
}

export function pendingMetadata(entry: RunJournalEntryV1): ApprovalPendingJournalMetadata {
  const metadata = closedRecord(entry.metadata, ["kind", "phase"]);
  if (metadata.kind !== "superpowers-approval-pending") integrity();
  const phase = parsedPhaseDocument(metadata.phase);
  const command = approvalPendingCommand(phase);
  if (
    entry.state !== "APPROVAL_PENDING" ||
    entry.previous_state !== "RUNNING" ||
    phase.status !== "APPROVAL_PENDING" ||
    phase.run_id !== entry.run_id ||
    phase.operation_id !== entry.operation_id ||
    entry.command_id !== command.command_id ||
    entry.command_input_hash !== transitionCommandInputHash(command) ||
    phase.observed_journal_head.journal_revision !== entry.journal_revision - 1 ||
    phase.observed_journal_head.entry_hash !== entry.previous_entry_hash
  ) {
    integrity();
  }
  return Object.freeze({ kind: "superpowers-approval-pending", phase });
}

function decisionMetadataInternal(
  entry: RunJournalEntryV1,
  pendingEntry: RunJournalEntryV1,
): ApprovalDecisionJournalMetadata {
  const metadata = closedRecord(entry.metadata, [
    "kind",
    "request",
    "decision",
    "occurred_at",
    "phase",
  ]);
  if (metadata.kind !== "superpowers-approval-decision") integrity();
  const persistedRequest = parsedApprovalDocument(metadata.request);
  const persistedDecision = parsedApprovalDocument(metadata.decision);
  if (typeof metadata.occurred_at !== "string") integrity();
  const pending = pendingMetadata(pendingEntry);
  const request = approvalRequest(pending.phase, {
    journal_revision: pendingEntry.journal_revision,
    sequence: pendingEntry.sequence,
    entry_hash: pendingEntry.entry_hash,
  });
  if (persistedRequest.kind !== "REQUEST" || persistedDecision.kind !== "DECISION") integrity();
  const decision = approvalDecision(request, {
    run_id: request.run_id,
    expected_journal_head: request.pending_journal_head,
    phase: request.phase,
    skill_name: request.skill_name,
    skill_version: request.skill_version,
    skill_snapshot_hash: request.skill_snapshot_hash,
    approval_request_hash: request.document_hash,
    operation_id: persistedDecision.operation_id,
    decision: persistedDecision.decision,
    trace: persistedDecision.trace,
  });
  const phase = approvalTerminalPhase({
    pending: pending.phase,
    decision,
    occurred_at: metadata.occurred_at,
  });
  const command = approvalDecisionCommand({ request, decision, terminal: phase });
  if (
    canonicalJson(persistedRequest) !== canonicalJson(request) ||
    canonicalJson(persistedDecision) !== canonicalJson(decision) ||
    canonicalJson(metadata.phase) !== canonicalJson(phase) ||
    entry.command_id !== command.command_id ||
    entry.command_input_hash !== transitionCommandInputHash(command) ||
    entry.operation_id !== decision.operation_id ||
    entry.run_id !== request.run_id ||
    entry.previous_state !== "APPROVAL_PENDING" ||
    entry.previous_entry_hash !== pendingEntry.entry_hash ||
    entry.journal_revision !== pendingEntry.journal_revision + 1 ||
    entry.sequence !== pendingEntry.sequence + 1 ||
    entry.state !== (decision.decision === "APPROVE" ? "RUNNING" : "BLOCKED")
  ) {
    integrity();
  }
  return Object.freeze({
    kind: "superpowers-approval-decision",
    request,
    decision,
    occurred_at: metadata.occurred_at,
    phase,
  });
}

export function decisionMetadata(
  entry: RunJournalEntryV1,
  pendingEntry: RunJournalEntryV1,
): ApprovalDecisionJournalMetadata {
  try {
    return decisionMetadataInternal(entry, pendingEntry);
  } catch (error) {
    if (error instanceof RuntimeSkillError && error.code === "RUNTIME_SKILL_INTEGRITY") throw error;
    integrity();
  }
}
