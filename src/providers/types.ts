import type { JsonValue } from "../protocol/json.js";
import type {
  RuntimeDocument,
  RuntimeError,
  TraceContext,
  ValidationResult,
} from "../protocol/types.js";

export type ProviderKind = "openai" | "anthropic" | "gemini";
export type ProviderReasoningEffort = "none" | "low" | "medium" | "high";

export type ProviderContentBlock =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "image"; url: string; media_type: string }>
  | Readonly<{ type: "tool-result"; tool_call_id: string; content: string }>;

export interface ProviderMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: readonly ProviderContentBlock[];
}

export interface ProviderToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly input_schema: JsonValue;
}

export type ProviderResponseFormat =
  Readonly<{ type: "text" }> | Readonly<{ type: "json-schema"; name: string; schema: JsonValue }>;

export interface ProviderRequest {
  readonly request_id: string;
  readonly model: string;
  readonly messages: readonly ProviderMessage[];
  readonly max_output_tokens: number;
  readonly timeout_ms: number;
  readonly tools?: readonly ProviderToolDefinition[];
  readonly response_format?: ProviderResponseFormat;
  readonly reasoning?: ProviderReasoningEffort;
  readonly temperature?: number;
}

export interface ProviderAdapterCapabilities {
  readonly provider: ProviderKind;
  readonly tools: boolean;
  readonly json_schema: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  readonly streaming: boolean;
  readonly max_context_tokens: number;
  readonly max_output_tokens: number;
}

export interface ProviderRouteRequirement {
  readonly schema_version: "gateway-route-requirement.v1";
  readonly alias: string;
  readonly tools: boolean;
  readonly json_schema: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  readonly streaming: boolean;
  readonly max_output_tokens: number;
}

export interface ProviderRouteIdentity {
  readonly transport: "agentgateway";
  readonly gateway_profile: string;
  readonly gateway_revision: number;
  readonly route_id: string;
  readonly requested_model: string;
  readonly resolved_provider: ProviderKind;
  readonly resolved_model: string;
  readonly capability_document_hash: `sha256:${string}`;
  readonly requirement_hash: `sha256:${string}`;
  readonly gateway_request_id: string | null;
}

export interface ProviderWireContext {
  readonly request_id: string;
  readonly run_id: string;
  readonly trace: TraceContext;
  readonly requirement: ProviderRouteRequirement;
  readonly signal: AbortSignal;
  readonly timeout_ms: number;
}

export interface ProviderWireResponse {
  readonly payload: unknown;
  readonly route_identity: ProviderRouteIdentity | null;
}

export interface ProviderWireStream {
  readonly events: AsyncIterable<unknown>;
  readonly route_identity: ProviderRouteIdentity | null;
}

export interface ProviderWireTransport {
  complete(input: JsonValue, context: ProviderWireContext): Promise<ProviderWireResponse>;
  stream(input: JsonValue, context: ProviderWireContext): Promise<ProviderWireStream>;
  cancel?(requestId: string): Promise<void>;
  health?(): Promise<unknown>;
}

export interface ProviderExecutionOptions {
  readonly run_id: string;
  readonly trace: TraceContext;
  readonly signal?: AbortSignal;
}

export interface ProviderHealth {
  readonly status: "healthy" | "degraded" | "unavailable";
}

export interface ProviderAdapter {
  readonly provider: ProviderKind;
  readonly capabilities: ProviderAdapterCapabilities;
  complete(
    request: ProviderRequest,
    options: ProviderExecutionOptions,
  ): Promise<ProviderCompletion>;
  stream(
    request: ProviderRequest,
    options: ProviderExecutionOptions,
  ): AsyncIterable<ProviderEventV1>;
  cancel(requestId: string): Promise<void>;
  health(): Promise<ProviderHealth>;
}
export type ProviderFinishReason =
  "stop" | "length" | "tool-calls" | "refusal" | "content-filter" | "cancelled";

export interface ProviderEventProvenance {
  readonly native_event: string;
  readonly lossy_fields: readonly string[];
}

export interface ProviderUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_input_tokens: number | null;
  readonly reasoning_tokens: number | null;
}

export type ProviderEventData =
  | Readonly<{ response_id?: string; route_identity?: ProviderRouteIdentity }>
  | Readonly<{ channel: "text" | "reasoning" | "refusal"; index: number; delta: string }>
  | Readonly<{
      index: number;
      tool_call_id: string;
      name?: string;
      arguments_delta: string;
    }>
  | ProviderUsage
  | Readonly<{ finish_reason: ProviderFinishReason; structured_output?: JsonValue }>
  | Readonly<{ error: RuntimeError }>;

interface ProviderEventBase extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "provider-event.v1";
  readonly document_type: "provider-event";
  readonly event_id: string;
  readonly request_id: string;
  readonly sequence: number;
  readonly occurred_at: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly provenance: ProviderEventProvenance;
}

export type ProviderEventV1 = ProviderEventBase &
  (
    | Readonly<{
        event_type: "response-start";
        data: Readonly<{ response_id?: string; route_identity?: ProviderRouteIdentity }>;
      }>
    | Readonly<{
        event_type: "content-delta";
        data: Readonly<{
          channel: "text" | "reasoning" | "refusal";
          index: number;
          delta: string;
        }>;
      }>
    | Readonly<{
        event_type: "tool-call-delta";
        data: Readonly<{
          index: number;
          tool_call_id: string;
          name?: string;
          arguments_delta: string;
        }>;
      }>
    | Readonly<{ event_type: "usage"; data: ProviderUsage }>
    | Readonly<{
        event_type: "response-completed";
        data: Readonly<{ finish_reason: ProviderFinishReason; structured_output?: JsonValue }>;
      }>
    | Readonly<{ event_type: "response-error"; data: Readonly<{ error: RuntimeError }> }>
  );

export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonValue;
}

export interface ProviderCompletion {
  readonly request_id: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly response_id: string | null;
  readonly text: string;
  readonly reasoning: string;
  readonly refusal: string | null;
  readonly tool_calls: readonly ProviderToolCall[];
  readonly usage: ProviderUsage;
  readonly finish_reason: ProviderFinishReason;
  readonly structured_output: JsonValue | null;
  readonly route_identity: ProviderRouteIdentity | null;
}

export type ProviderEventValidationResult = ValidationResult<ProviderEventV1>;
