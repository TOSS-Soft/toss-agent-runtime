import { hashExecutionEvent, type ExecutionEventV1 } from "./event.js";
import { hashExecutionRequest, type ExecutionRequestV1 } from "./request.js";
import { sensitiveMetadataIssues } from "./metadata.js";
import type {
  ArtifactReference,
  RuntimeDocument,
  RuntimeError,
  TraceContext,
  UsageSummary,
  ValidationIssue,
  ValidationResult,
} from "./types.js";
import { createProtocolValidator } from "./validator.js";

export type TerminalStatus = "COMPLETED" | "FAILED" | "BLOCKED" | "CANCELLED" | "INTERRUPTED";

export interface ExecutionResultV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "execution-result.v1";
  readonly document_type: "execution-result";
  readonly run_id: string;
  readonly request_hash: `sha256:${string}`;
  readonly journal_head: Readonly<{
    sequence: number;
    run_revision: number;
    event_hash: `sha256:${string}`;
  }>;
  readonly status: TerminalStatus;
  readonly finished_at: string;
  readonly outputs: readonly ArtifactReference[];
  readonly error: RuntimeError | null;
  readonly usage: UsageSummary;
  readonly evidence: readonly ArtifactReference[];
  readonly trace: TraceContext;
}

export function parseExecutionResult(
  input: string | Uint8Array,
): ValidationResult<ExecutionResultV1> {
  const result = createProtocolValidator().parse<ExecutionResultV1>(input, "execution-result");
  if (!result.ok || result.value.error?.metadata === undefined) return result;
  const issues = sensitiveMetadataIssues(result.value.error.metadata, "/error/metadata");
  return issues.length === 0 ? result : { ok: false, code: "RUNTIME_DOCUMENT_INVALID", issues };
}

function chainIssue(path: string, keyword: string, message: string): ValidationIssue {
  return { path, keyword, message };
}

export function validateExecutionChain(input: {
  readonly request: ExecutionRequestV1;
  readonly events: readonly ExecutionEventV1[];
  readonly result: ExecutionResultV1;
}): ValidationResult<true> {
  const issues: ValidationIssue[] = [];
  const requestHash = hashExecutionRequest(input.request);
  let previousHash = `sha256:${"0".repeat(64)}` as const;
  let previousRevision = 0;
  let previousTimestamp = Date.parse(input.request.created_at);

  if (input.events.length === 0) {
    issues.push(chainIssue("/events", "minItems", "journal must contain at least one event"));
  }
  for (const [index, event] of input.events.entries()) {
    const { event_hash: eventHash, ...hashable } = event;
    if (event.sequence !== index + 1)
      issues.push(
        chainIssue(`/events/${index}/sequence`, "sequence", "event sequence is not contiguous"),
      );
    if (event.run_revision !== previousRevision + 1)
      issues.push(
        chainIssue(`/events/${index}/run_revision`, "revision", "run revision is not contiguous"),
      );
    if (event.previous_event_hash !== previousHash)
      issues.push(
        chainIssue(
          `/events/${index}/previous_event_hash`,
          "hashLink",
          "previous event hash does not match",
        ),
      );
    if (eventHash !== hashExecutionEvent(hashable))
      issues.push(
        chainIssue(
          `/events/${index}/event_hash`,
          "contentHash",
          "event content hash does not match",
        ),
      );
    if (event.request_hash !== requestHash)
      issues.push(
        chainIssue(
          `/events/${index}/request_hash`,
          "requestHash",
          "event request hash does not match",
        ),
      );
    if (event.run_id !== input.request.run_id)
      issues.push(
        chainIssue(`/events/${index}/run_id`, "runIdentity", "event run identity does not match"),
      );
    if (event.trace.trace_id !== input.request.trace.trace_id)
      issues.push(
        chainIssue(
          `/events/${index}/trace/trace_id`,
          "traceIdentity",
          "event trace identity does not match",
        ),
      );
    const eventTimestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(eventTimestamp) || eventTimestamp < previousTimestamp)
      issues.push(
        chainIssue(
          `/events/${index}/timestamp`,
          "eventOrdering",
          "event timestamp must not precede request creation or the previous event",
        ),
      );
    previousHash = eventHash;
    previousRevision = event.run_revision;
    previousTimestamp = eventTimestamp;
  }

  const last = input.events.at(-1);
  if (input.result.request_hash !== requestHash)
    issues.push(
      chainIssue("/result/request_hash", "requestHash", "result request hash does not match"),
    );
  if (input.result.run_id !== input.request.run_id)
    issues.push(chainIssue("/result/run_id", "runIdentity", "result run identity does not match"));
  if (input.result.trace.trace_id !== input.request.trace.trace_id)
    issues.push(
      chainIssue("/result/trace/trace_id", "traceIdentity", "result trace identity does not match"),
    );
  if (
    last === undefined ||
    input.result.journal_head.sequence !== last.sequence ||
    input.result.journal_head.run_revision !== last.run_revision ||
    input.result.journal_head.event_hash !== last.event_hash
  ) {
    issues.push(
      chainIssue("/result/journal_head", "journalHead", "result journal head does not match"),
    );
  }
  const terminalEventStatus: Partial<Record<ExecutionEventV1["event_type"], TerminalStatus>> = {
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    BLOCKED: "BLOCKED",
    CANCELLED: "CANCELLED",
    INTERRUPTED: "INTERRUPTED",
  };
  if (last !== undefined && terminalEventStatus[last.event_type] !== input.result.status) {
    issues.push(
      chainIssue(
        "/result/status",
        "terminalStatus",
        "result status must match the final terminal event",
      ),
    );
  }
  if (last !== undefined && Date.parse(input.result.finished_at) < Date.parse(last.timestamp)) {
    issues.push(
      chainIssue(
        "/result/finished_at",
        "eventOrdering",
        "result timestamp must not precede the journal head",
      ),
    );
  }

  if (issues.length > 0) {
    issues.sort((left, right) =>
      `${left.path}\u0000${left.keyword}\u0000${left.message}`.localeCompare(
        `${right.path}\u0000${right.keyword}\u0000${right.message}`,
      ),
    );
    return { ok: false, code: "RUNTIME_DOCUMENT_INVALID", issues };
  }
  return { ok: true, value: true };
}
