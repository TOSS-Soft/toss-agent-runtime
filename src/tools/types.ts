import type {
  AgentDefinitionReference,
  McpProfileReference,
  TaskContractReference,
} from "../agents/types.js";
import type { JournalHead } from "../journal/types.js";
import type { JsonValue } from "../protocol/json.js";
import type { RuntimeDocument, RuntimeError, TraceContext } from "../protocol/types.js";
import type { RuntimeToolErrorCode } from "./errors.js";

export type McpProtocolRevision = "2025-06-18" | "2026-07-28";
export type McpTransportKind = "stdio" | "streamable-http" | "agentgateway";
export type ToolOperationClass = "read-only" | "reversible-write" | "irreversible";
export type ToolApprovalRule = "required" | "not-required";
export type ToolContentKind = "text" | "image" | "audio" | "resource-link" | "embedded-resource";
export type ToolCallStage = "PREPARED" | "COMPLETED" | "FAILED" | "UNCERTAIN";
export type ToolUncertainDisposition = "NO_EFFECT_CONFIRMED" | "EFFECT_CONFIRMED";

export const TOOL_HARD_LIMITS = Object.freeze({
  profiles: 64,
  serversPerProfile: 32,
  toolsPerServer: 256,
  discoveryPagesPerServer: 64,
  schemaBytes: 262_144,
  argumentsBytes: 1_048_576,
  resultBytes: 4_194_304,
  contentBlocks: 128,
  contentBlockBytes: 1_048_576,
  structuredOutputBytes: 1_048_576,
  approvalSummaryBytes: 2_048,
  discoveryTimeoutMs: 30_000,
  callTimeoutMs: 120_000,
  sessionLifetimeMs: 900_000,
});

export interface McpProfileLimitsV1 {
  readonly discovery_pages_per_server: number;
  readonly tools_per_server: number;
  readonly schema_bytes: number;
  readonly arguments_bytes: number;
  readonly result_bytes: number;
  readonly content_blocks: number;
  readonly content_block_bytes: number;
  readonly structured_output_bytes: number;
  readonly discovery_timeout_ms: number;
  readonly call_timeout_ms: number;
  readonly session_lifetime_ms: number;
}

export interface McpProfileToolRuleV1 {
  readonly alias: string;
  readonly description: string;
  readonly native_name: string;
  readonly allowed_roles: readonly ("worker" | "reviewer")[];
  readonly task_contracts: readonly TaskContractReference[];
  readonly input_schema: JsonValue;
  readonly input_schema_hash: `sha256:${string}`;
  readonly output_schema: JsonValue | null;
  readonly output_schema_hash: `sha256:${string}` | null;
  readonly operation_class: ToolOperationClass;
  readonly approval: ToolApprovalRule;
  readonly content_kinds: readonly ToolContentKind[];
  readonly sensitive_output_pointers: readonly string[];
}

export interface McpProfileServerRuleV1 {
  readonly server_id: string;
  readonly binding_name: string;
  readonly protocol_revision: McpProtocolRevision;
  readonly x_mcp_headers: Readonly<Record<string, string>>;
  readonly tools: readonly McpProfileToolRuleV1[];
}

export interface HashableMcpProfileV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "mcp-profile.v1";
  readonly document_type: "mcp-profile";
  readonly profile_id: string;
  readonly revision: number;
  readonly limits: McpProfileLimitsV1;
  readonly servers: readonly McpProfileServerRuleV1[];
}

export interface McpProfileV1 extends HashableMcpProfileV1 {
  readonly document_hash: `sha256:${string}`;
}

export type McpEnvironmentValue =
  | Readonly<{ kind: "literal"; value: string }>
  | Readonly<{ kind: "secret-reference"; reference: string }>;

export interface McpStdioBinding {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, McpEnvironmentValue>>;
}

export interface McpStreamableHttpBinding {
  readonly transport: "streamable-http";
  readonly endpoint: string;
  readonly credential_reference: string | null;
}

export interface McpAgentgatewayBinding {
  readonly transport: "agentgateway";
  readonly gateway_profile: string;
}

export type McpServerBinding = McpStdioBinding | McpStreamableHttpBinding | McpAgentgatewayBinding;

export interface McpProfileConfig {
  readonly profile: McpProfileV1;
  readonly servers: Readonly<Record<string, McpServerBinding>>;
}

export interface McpToolAnnotationsV1 {
  readonly read_only_hint: boolean | null;
  readonly destructive_hint: boolean | null;
  readonly idempotent_hint: boolean | null;
  readonly open_world_hint: boolean | null;
}

export interface McpDiscoveredToolV1 {
  readonly alias: string;
  readonly native_name: string;
  readonly input_schema_hash: `sha256:${string}`;
  readonly output_schema_hash: `sha256:${string}` | null;
  readonly operation_class: ToolOperationClass;
  readonly annotations: McpToolAnnotationsV1;
}

export interface McpDiscoveredServerV1 {
  readonly server_id: string;
  readonly binding_name: string;
  readonly transport: McpTransportKind;
  readonly protocol_revision: McpProtocolRevision;
  readonly server: Readonly<{
    name: string;
    version: string;
    identity_hash: `sha256:${string}`;
  }>;
  readonly tools: readonly McpDiscoveredToolV1[];
}

export interface HashableMcpDiscoverySnapshotV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "mcp-discovery-snapshot.v1";
  readonly document_type: "mcp-discovery-snapshot";
  readonly run_id: string;
  readonly session_id: string;
  readonly execution_request_hash: `sha256:${string}`;
  readonly profile: McpProfileReference;
  readonly created_at: string;
  readonly expires_at: string;
  readonly stale: boolean;
  readonly servers: readonly McpDiscoveredServerV1[];
}

export interface McpDiscoverySnapshotV1 extends HashableMcpDiscoverySnapshotV1 {
  readonly document_hash: `sha256:${string}`;
}

interface ToolApprovalBaseV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "tool-approval.v1";
  readonly document_type: "tool-approval";
  readonly run_id: string;
  readonly pending_journal_head: JournalHead;
  readonly call_id: string;
  readonly decision: "APPROVE" | "REJECT" | null;
  readonly trace: TraceContext;
}

export interface ToolApprovalRequestV1 extends ToolApprovalBaseV1 {
  readonly kind: "REQUEST";
  readonly execution_request_hash: `sha256:${string}`;
  readonly agent_definition: AgentDefinitionReference;
  readonly task_contract: TaskContractReference;
  readonly role: "worker" | "reviewer";
  readonly profile: McpProfileReference;
  readonly discovery_snapshot_hash: `sha256:${string}`;
  readonly server_id: string;
  readonly alias: string;
  readonly native_name: string;
  readonly input_schema_hash: `sha256:${string}`;
  readonly output_schema_hash: `sha256:${string}` | null;
  readonly operation_class: ToolOperationClass;
  readonly logical_input_hash: `sha256:${string}`;
  readonly idempotency_key: `sha256:${string}`;
  readonly summary: string;
  readonly decision: null;
  readonly document_hash: `sha256:${string}`;
}

export interface ToolApprovalDecisionV1 extends ToolApprovalBaseV1 {
  readonly kind: "DECISION";
  readonly approval_request_hash: `sha256:${string}`;
  readonly operation_id: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly decided_at: string;
  readonly document_hash: `sha256:${string}`;
}

export type ToolApprovalV1 = ToolApprovalRequestV1 | ToolApprovalDecisionV1;
export type HashableToolApprovalV1 =
  Omit<ToolApprovalRequestV1, "document_hash"> | Omit<ToolApprovalDecisionV1, "document_hash">;

export type ToolDispatchState = "NOT_SENT" | "MAYBE_SENT" | "RESULT_RECEIVED";

export interface HashableToolCallV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "tool-call.v1";
  readonly document_type: "tool-call";
  readonly run_id: string;
  readonly call_revision: number;
  readonly previous_call_hash: `sha256:${string}` | null;
  readonly stage: ToolCallStage;
  readonly dispatch_state: ToolDispatchState;
  readonly execution_request_hash: `sha256:${string}`;
  readonly agent_definition: AgentDefinitionReference;
  readonly task_contract: TaskContractReference;
  readonly role: "worker" | "reviewer";
  readonly profile: McpProfileReference;
  readonly discovery_snapshot_hash: `sha256:${string}`;
  readonly session_id: string;
  readonly server_id: string;
  readonly transport: McpTransportKind;
  readonly protocol_revision: McpProtocolRevision;
  readonly alias: string;
  readonly native_name: string;
  readonly input_schema_hash: `sha256:${string}`;
  readonly output_schema_hash: `sha256:${string}` | null;
  readonly operation_class: ToolOperationClass;
  readonly logical_call_id: string;
  readonly operation_id: string;
  readonly call_id: string;
  readonly idempotency_key: `sha256:${string}`;
  readonly logical_arguments: JsonValue;
  readonly logical_input_hash: `sha256:${string}`;
  readonly approval_request_hash: `sha256:${string}` | null;
  readonly prepared_at: string;
  readonly terminal_at: string | null;
  readonly result_hash: `sha256:${string}` | null;
  readonly terminal_code: RuntimeToolErrorCode | null;
}

export interface ToolCallV1 extends HashableToolCallV1 {
  readonly document_hash: `sha256:${string}`;
}

export interface ToolTextContentV1 {
  readonly type: "text";
  readonly text: string;
}

export interface ToolImageContentV1 {
  readonly type: "image";
  readonly media_type: string;
  readonly data_base64: string;
}

export interface ToolAudioContentV1 {
  readonly type: "audio";
  readonly media_type: string;
  readonly data_base64: string;
}

export interface ToolResourceLinkContentV1 {
  readonly type: "resource-link";
  readonly uri: string;
  readonly name: string;
  readonly mime_type: string | null;
}

export interface ToolEmbeddedResourceContentV1 {
  readonly type: "embedded-resource";
  readonly uri: string;
  readonly mime_type: string;
  readonly text: string | null;
  readonly blob_base64: string | null;
}

export type ToolResultContentV1 =
  | ToolTextContentV1
  | ToolImageContentV1
  | ToolAudioContentV1
  | ToolResourceLinkContentV1
  | ToolEmbeddedResourceContentV1;

export interface ToolResultProvenanceV1 {
  readonly profile: McpProfileReference;
  readonly discovery_snapshot_hash: `sha256:${string}`;
  readonly server_id: string;
  readonly server_identity_hash: `sha256:${string}`;
  readonly protocol_revision: McpProtocolRevision;
  readonly transport: McpTransportKind;
  readonly alias: string;
  readonly native_name: string;
  readonly input_schema_hash: `sha256:${string}`;
  readonly output_schema_hash: `sha256:${string}` | null;
  readonly call_id: string;
  readonly idempotency_key: `sha256:${string}`;
}

export interface HashableToolResultV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "tool-result.v1";
  readonly document_type: "tool-result";
  readonly run_id: string;
  readonly call_id: string;
  readonly idempotency_key: `sha256:${string}`;
  readonly status: "success" | "error";
  readonly is_error: boolean;
  readonly trust: "untrusted-content";
  readonly content: readonly ToolResultContentV1[];
  readonly structured_content: JsonValue | null;
  readonly provenance: ToolResultProvenanceV1;
  readonly trace: TraceContext;
  readonly accounting: Readonly<{
    content_blocks: number;
    total_bytes: number;
    structured_bytes: number;
  }>;
  readonly error: RuntimeError | null;
}

export interface ToolResultV1 extends HashableToolResultV1 {
  readonly document_hash: `sha256:${string}`;
}
