import type { TaskContractReference } from "../agents/types.js";
import type { JsonValue } from "../protocol/json.js";
import type { RuntimeDocument } from "../protocol/types.js";

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
