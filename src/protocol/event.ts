import { sha256, type JsonValue } from "./json.js";
import { sensitiveMetadataIssues } from "./metadata.js";
import type {
  ArtifactReference,
  ProducerIdentity,
  RuntimeDocument,
  TraceContext,
  ValidationResult,
} from "./types.js";
import { createProtocolValidator } from "./validator.js";

export type ExecutionEventType =
  | "CREATED"
  | "ROUTED"
  | "RUNNING"
  | "MODEL_STARTED"
  | "MODEL_DELTA"
  | "MODEL_COMPLETED"
  | "TOOL_PENDING"
  | "APPROVAL_PENDING"
  | "APPROVAL_RECORDED"
  | "TOOL_COMPLETED"
  | "REVIEW_PENDING"
  | "REVIEW_COMPLETED"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED"
  | "INTERRUPTED";

export interface ExecutionEventV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "execution-event.v1";
  readonly document_type: "execution-event";
  readonly run_id: string;
  readonly request_hash: `sha256:${string}`;
  readonly sequence: number;
  readonly run_revision: number;
  readonly previous_event_hash: `sha256:${string}`;
  readonly event_hash: `sha256:${string}`;
  readonly event_type: ExecutionEventType;
  readonly timestamp: string;
  readonly producer: ProducerIdentity;
  readonly trace: TraceContext;
  readonly input_reference: ArtifactReference;
  readonly payload: JsonValue;
}

export type HashableExecutionEventV1 = Omit<ExecutionEventV1, "event_hash">;

export function hashExecutionEvent(event: HashableExecutionEventV1): `sha256:${string}` {
  return sha256(event);
}

export function parseExecutionEvent(
  input: string | Uint8Array,
): ValidationResult<ExecutionEventV1> {
  const result = createProtocolValidator().parse<ExecutionEventV1>(input, "execution-event");
  if (!result.ok) {
    return result;
  }

  const metadataIssues = sensitiveMetadataIssues(result.value.payload, "/payload");
  if (metadataIssues.length > 0) {
    return { ok: false, code: "RUNTIME_DOCUMENT_INVALID", issues: metadataIssues };
  }

  const { event_hash: eventHash, ...hashable } = result.value;
  if (hashExecutionEvent(hashable) !== eventHash) {
    return {
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: [
        {
          path: "/event_hash",
          keyword: "contentHash",
          message: "must match the canonical event content",
        },
      ],
    };
  }
  return result;
}
