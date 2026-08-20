import type { JsonValue } from "../protocol/json.js";
import type { RuntimeDocument, TraceContext } from "../protocol/types.js";

export type RunState =
  | "CREATED"
  | "ROUTED"
  | "RUNNING"
  | "TOOL_PENDING"
  | "APPROVAL_PENDING"
  | "REVIEW_PENDING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED"
  | "INTERRUPTED";

export interface JournalHead {
  readonly journal_revision: number;
  readonly sequence: number;
  readonly entry_hash: `sha256:${string}`;
}

export interface SideEffectRecord {
  readonly identity: string;
  readonly phase: "INTENT" | "COMPLETED";
  readonly input_hash: `sha256:${string}`;
  readonly output_hash: `sha256:${string}` | null;
}

export interface RunJournalEntryV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "run-journal-entry.v1";
  readonly document_type: "run-journal-entry";
  readonly run_id: string;
  readonly journal_revision: number;
  readonly run_attempt: number;
  readonly sequence: number;
  readonly previous_entry_hash: `sha256:${string}`;
  readonly entry_hash: `sha256:${string}`;
  readonly command_id: string;
  readonly command_input_hash: `sha256:${string}`;
  readonly operation_id: string | null;
  readonly side_effect: SideEffectRecord | null;
  readonly previous_state: RunState | null;
  readonly state: RunState;
  readonly reason_code: string;
  readonly timestamp: string;
  readonly trace: TraceContext;
  readonly metadata: JsonValue;
}

export type HashableRunJournalEntryV1 = Omit<RunJournalEntryV1, "entry_hash">;
