import type { JsonValue } from "./json.js";

export interface RuntimeDocument {
  readonly protocol_version: string;
  readonly schema_version: string;
  readonly document_type: string;
}

export interface ArtifactReference {
  readonly document_type: string;
  readonly artifact_id: string;
  readonly revision: number;
  readonly hash: `sha256:${string}`;
  readonly location?: string;
}

export interface ProducerIdentity {
  readonly kind: "runtime" | "gateway" | "provider" | "skill" | "tool";
  readonly name: string;
  readonly version: string;
  readonly revision?: number;
  readonly hash?: `sha256:${string}`;
}

export interface TraceContext {
  readonly trace_id: string;
  readonly span_id: string;
  readonly trace_flags: number;
  readonly trace_state?: string;
}

export interface RuntimeBudget {
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly max_cost_microusd: number;
  readonly max_duration_ms: number;
  readonly max_turns: number;
}

export interface UsageSummary {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_microusd: number | null;
  readonly duration_ms: number;
  readonly turns: number;
}

export interface RuntimeError {
  readonly code: string;
  readonly category:
    | "invalid-input"
    | "stale-revision"
    | "unsupported-capability"
    | "policy-denied"
    | "approval-required"
    | "authentication"
    | "rate-limit"
    | "refusal"
    | "timeout"
    | "cancelled"
    | "unavailable"
    | "integrity"
    | "internal";
  readonly retryable: boolean;
  readonly safe_message: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface ValidationIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export interface ValidationFailure {
  readonly ok: false;
  readonly code: "RUNTIME_DOCUMENT_INVALID" | "RUNTIME_DOCUMENT_UNSUPPORTED";
  readonly issues: readonly ValidationIssue[];
}

export interface ValidationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;
