import type { EffectiveAgentAuthority } from "../agents/authority.js";
import type {
  AgentDefinitionReference,
  McpProfileReference,
  TaskContractReference,
} from "../agents/types.js";
import { canonicalJson, type JsonValue } from "../protocol/json.js";
import type { TraceContext } from "../protocol/types.js";
import { parseMcpDiscoverySnapshot, parseMcpProfile, validateToolArguments } from "./contracts.js";
import type { ToolSession } from "./discovery.js";
import { RuntimeToolError } from "./errors.js";
import { deriveToolIdentity } from "./identity.js";
import type {
  McpDiscoverySnapshotV1,
  McpProfileToolRuleV1,
  McpProfileV1,
  McpProtocolRevision,
  McpTransportKind,
  ToolApprovalRule,
  ToolContentKind,
  ToolOperationClass,
} from "./types.js";
import { TOOL_HARD_LIMITS } from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/u;
const SECRET_FIELD =
  /(?:authorization|api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|private[_-]?key|bearer)/iu;

export interface ToolCallRequestInput {
  readonly alias: string;
  readonly logical_call_id: string;
  readonly arguments: JsonValue;
  readonly caller_meta: null | Readonly<Record<string, JsonValue>>;
}

export interface AuthorizeToolCallInput {
  readonly run_id: string;
  readonly execution_request_hash: `sha256:${string}`;
  readonly authority: EffectiveAgentAuthority;
  readonly profile: McpProfileV1;
  readonly session: ToolSession;
  readonly discovery_snapshot: McpDiscoverySnapshotV1;
  readonly now: Date;
  readonly trace: TraceContext;
  readonly request: ToolCallRequestInput;
}

export type TossToolTraceV1 = Readonly<{
  readonly trace_id: string;
  readonly span_id: string;
  readonly trace_flags: number;
  readonly trace_state?: string;
}>;

export type TossToolMetaV1 = Readonly<{
  readonly run_id: string;
  readonly execution_request_hash: `sha256:${string}`;
  readonly agent_definition_hash: `sha256:${string}`;
  readonly task_contract_hash: `sha256:${string}`;
  readonly role: "worker" | "reviewer";
  readonly mcp_profile_hash: `sha256:${string}`;
  readonly discovery_snapshot_hash: `sha256:${string}`;
  readonly server_id: string;
  readonly tool_alias: string;
  readonly native_tool_name: string;
  readonly call_id: string;
  readonly idempotency_key: `sha256:${string}`;
  readonly trace: TossToolTraceV1;
}>;

export type TossTrustedToolMetaV1 = Readonly<Record<string, JsonValue>> &
  Readonly<{ readonly toss: TossToolMetaV1 }>;

export interface AuthorizedToolResultLimits {
  readonly result_bytes: number;
  readonly content_blocks: number;
  readonly content_block_bytes: number;
  readonly structured_output_bytes: number;
}

export interface AuthorizedToolCall {
  readonly run_id: string;
  readonly execution_request_hash: `sha256:${string}`;
  readonly agent_definition: AgentDefinitionReference;
  readonly task_contract: TaskContractReference;
  readonly role: "worker" | "reviewer";
  readonly profile: McpProfileReference;
  readonly discovery_snapshot_hash: `sha256:${string}`;
  readonly session_id: string;
  readonly server_id: string;
  readonly server_identity_hash: `sha256:${string}`;
  readonly transport: McpTransportKind;
  readonly protocol_revision: McpProtocolRevision;
  readonly alias: string;
  readonly native_name: string;
  readonly input_schema: JsonValue;
  readonly input_schema_hash: `sha256:${string}`;
  readonly output_schema: JsonValue | null;
  readonly output_schema_hash: `sha256:${string}` | null;
  readonly operation_class: ToolOperationClass;
  readonly approval: ToolApprovalRule;
  readonly approval_required: boolean;
  readonly content_kinds: readonly ToolContentKind[];
  readonly sensitive_output_pointers: readonly string[];
  readonly logical_call_id: string;
  readonly logical_arguments: JsonValue;
  readonly logical_input_hash: `sha256:${string}`;
  readonly call_id: string;
  readonly idempotency_key: `sha256:${string}`;
  readonly timeout_ms: number;
  readonly result_limits: AuthorizedToolResultLimits;
  readonly trace: TraceContext;
  readonly trusted_meta: TossTrustedToolMetaV1;
}

function deny(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_POLICY_DENIED");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function sameReference(
  left: Readonly<{
    document_type: string;
    artifact_id: string;
    revision: number;
    hash: string;
  }>,
  right: Readonly<{
    document_type: string;
    artifact_id: string;
    revision: number;
    hash: string;
  }>,
): boolean {
  return (
    left.document_type === right.document_type &&
    left.artifact_id === right.artifact_id &&
    left.revision === right.revision &&
    left.hash === right.hash
  );
}

function validReference(
  value: Readonly<{
    document_type: string;
    artifact_id: string;
    revision: number;
    hash: string;
  }>,
  documentType: string,
): boolean {
  return (
    value.document_type === documentType &&
    IDENTIFIER_PATTERN.test(value.artifact_id) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    SHA256_PATTERN.test(value.hash)
  );
}

function validTrace(value: unknown): value is TraceContext {
  if (!isRecord(value)) return false;
  const keys = Object.hasOwn(value, "trace_state")
    ? ["span_id", "trace_flags", "trace_id", "trace_state"]
    : ["span_id", "trace_flags", "trace_id"];
  return (
    exactKeys(value, keys) &&
    typeof value.trace_id === "string" &&
    TRACE_ID_PATTERN.test(value.trace_id) &&
    typeof value.span_id === "string" &&
    SPAN_ID_PATTERN.test(value.span_id) &&
    Number.isSafeInteger(value.trace_flags) &&
    Number(value.trace_flags) >= 0 &&
    Number(value.trace_flags) <= 255 &&
    (value.trace_state === undefined ||
      (typeof value.trace_state === "string" &&
        Buffer.byteLength(value.trace_state, "utf8") <= 512 &&
        /^[\u0020-\u007e]*$/u.test(value.trace_state) &&
        value.trace_state.trim() === value.trace_state))
  );
}

function hasSecretShapedKey(value: JsonValue): boolean {
  if (isJsonArray(value)) return value.some((child) => hasSecretShapedKey(child));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) => SECRET_FIELD.test(key) || hasSecretShapedKey(child),
  );
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function coherentOperation(rule: McpProfileToolRuleV1): boolean {
  return !(
    (rule.operation_class === "read-only" && rule.approval !== "not-required") ||
    (rule.operation_class === "irreversible" && rule.approval !== "required")
  );
}

function validLimits(profile: McpProfileV1, snapshot: McpDiscoverySnapshotV1): boolean {
  const limits = profile.limits;
  const pairs: readonly (readonly [number, number])[] = [
    [limits.discovery_pages_per_server, TOOL_HARD_LIMITS.discoveryPagesPerServer],
    [limits.tools_per_server, TOOL_HARD_LIMITS.toolsPerServer],
    [limits.schema_bytes, TOOL_HARD_LIMITS.schemaBytes],
    [limits.arguments_bytes, TOOL_HARD_LIMITS.argumentsBytes],
    [limits.result_bytes, TOOL_HARD_LIMITS.resultBytes],
    [limits.content_blocks, TOOL_HARD_LIMITS.contentBlocks],
    [limits.content_block_bytes, TOOL_HARD_LIMITS.contentBlockBytes],
    [limits.structured_output_bytes, TOOL_HARD_LIMITS.structuredOutputBytes],
    [limits.discovery_timeout_ms, TOOL_HARD_LIMITS.discoveryTimeoutMs],
    [limits.call_timeout_ms, TOOL_HARD_LIMITS.callTimeoutMs],
    [limits.session_lifetime_ms, TOOL_HARD_LIMITS.sessionLifetimeMs],
  ];
  const created = Date.parse(snapshot.created_at);
  const expires = Date.parse(snapshot.expires_at);
  return (
    pairs.every(
      ([value, maximum]) => Number.isSafeInteger(value) && value > 0 && value <= maximum,
    ) &&
    limits.content_block_bytes <= limits.result_bytes &&
    limits.structured_output_bytes <= limits.result_bytes &&
    limits.discovery_timeout_ms <= limits.session_lifetime_ms &&
    limits.call_timeout_ms <= limits.session_lifetime_ms &&
    Number.isFinite(created) &&
    Number.isFinite(expires) &&
    created < expires &&
    expires - created <= limits.session_lifetime_ms
  );
}

function immutableReference<
  T extends AgentDefinitionReference | TaskContractReference | McpProfileReference,
>(value: T): T {
  return Object.freeze({
    document_type: value.document_type,
    artifact_id: value.artifact_id,
    revision: value.revision,
    hash: value.hash,
  }) as T;
}

function immutableTrace(value: TraceContext): TossToolTraceV1 {
  return Object.freeze({
    trace_id: value.trace_id,
    span_id: value.span_id,
    trace_flags: value.trace_flags,
    ...(value.trace_state === undefined ? {} : { trace_state: value.trace_state }),
  });
}

export function authorizeToolCall(input: AuthorizeToolCallInput): AuthorizedToolCall {
  // 1. Run, request and trace identities.
  if (
    !IDENTIFIER_PATTERN.test(input.run_id) ||
    !SHA256_PATTERN.test(input.execution_request_hash) ||
    !validTrace(input.trace)
  ) {
    deny();
  }

  let profile: McpProfileV1;
  let snapshot: McpDiscoverySnapshotV1;
  try {
    const parsedProfile = parseMcpProfile(canonicalJson(input.profile));
    const parsedSnapshot = parseMcpDiscoverySnapshot(canonicalJson(input.discovery_snapshot));
    if (!parsedProfile.ok || !parsedSnapshot.ok) deny();
    profile = parsedProfile.value;
    snapshot = parsedSnapshot.value;
  } catch {
    deny();
  }
  if (
    snapshot.run_id !== input.run_id ||
    snapshot.execution_request_hash !== input.execution_request_hash
  ) {
    deny();
  }

  // 2. Exact Task Contract, agent definition, role and MCP profile references.
  if (
    !validReference(input.authority.definition, "agent-definition") ||
    !validReference(input.authority.task_contract, "task-contract") ||
    (input.authority.role !== "worker" && input.authority.role !== "reviewer") ||
    !sameReference(input.authority.mcp_profile, snapshot.profile) ||
    !sameReference(input.authority.mcp_profile, {
      document_type: "mcp-profile",
      artifact_id: profile.profile_id,
      revision: profile.revision,
      hash: profile.document_hash,
    })
  ) {
    deny();
  }

  // 3. Active virtual session and unexpired discovery snapshot.
  let activeSnapshot: McpDiscoverySnapshotV1 | null;
  try {
    activeSnapshot = input.session.snapshot();
  } catch {
    deny();
  }
  const now = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  if (
    activeSnapshot === null ||
    input.session.run_id !== input.run_id ||
    input.session.session_id !== snapshot.session_id ||
    !sameReference(input.session.profile, snapshot.profile) ||
    activeSnapshot.document_hash !== snapshot.document_hash ||
    snapshot.stale ||
    !Number.isFinite(now) ||
    now < Date.parse(snapshot.created_at) ||
    now >= Date.parse(snapshot.expires_at)
  ) {
    deny();
  }

  // The caller owns only these three logical fields. `_meta` and all physical fields are local.
  if (
    !isRecord(input.request) ||
    !exactKeys(input.request, ["alias", "arguments", "caller_meta", "logical_call_id"]) ||
    input.request.caller_meta !== null ||
    typeof input.request.alias !== "string" ||
    !IDENTIFIER_PATTERN.test(input.request.alias) ||
    typeof input.request.logical_call_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.request.logical_call_id) ||
    !isRecord(input.request.arguments)
  ) {
    deny();
  }

  // 4. Exact model alias to server/native-tool mapping.
  let selected:
    | Readonly<{
        serverRule: McpProfileV1["servers"][number];
        toolRule: McpProfileToolRuleV1;
      }>
    | undefined;
  for (const serverRule of profile.servers) {
    const toolRule = serverRule.tools.find((candidate) => candidate.alias === input.request.alias);
    if (toolRule !== undefined) selected = { serverRule, toolRule };
  }
  if (selected === undefined) deny();
  const discoveredServer = snapshot.servers.find(
    (candidate) => candidate.server_id === selected.serverRule.server_id,
  );
  const discoveredTool = discoveredServer?.tools.find(
    (candidate) => candidate.alias === selected.toolRule.alias,
  );
  if (
    discoveredServer === undefined ||
    discoveredTool === undefined ||
    discoveredServer.binding_name !== selected.serverRule.binding_name ||
    discoveredServer.protocol_revision !== selected.serverRule.protocol_revision ||
    discoveredTool.native_name !== selected.toolRule.native_name
  ) {
    deny();
  }

  // 5. Role and exact Task Contract membership.
  if (
    !selected.toolRule.allowed_roles.includes(input.authority.role) ||
    !selected.toolRule.task_contracts.some((candidate) =>
      sameReference(candidate, input.authority.task_contract),
    )
  ) {
    deny();
  }

  // 6. Canonical schema identity.
  if (
    discoveredTool.input_schema_hash !== selected.toolRule.input_schema_hash ||
    discoveredTool.output_schema_hash !== selected.toolRule.output_schema_hash
  ) {
    deny();
  }

  // 7. Bounded arguments and input-schema validation.
  const validatedArguments = validateToolArguments(
    selected.toolRule.input_schema,
    input.request.arguments,
    profile.limits.arguments_bytes,
  );
  if (!validatedArguments.ok || !isRecord(validatedArguments.value)) deny();

  // 8. Secret-shaped model arguments are never durable in v1.
  if (hasSecretShapedKey(validatedArguments.value)) deny();

  // 9. Operation class and approval rule, including the reviewer safety ceiling.
  if (
    discoveredTool.operation_class !== selected.toolRule.operation_class ||
    !coherentOperation(selected.toolRule) ||
    (input.authority.role === "reviewer" && selected.toolRule.operation_class !== "read-only")
  ) {
    deny();
  }
  const approvalRequired =
    selected.toolRule.operation_class === "irreversible" ||
    selected.toolRule.approval === "required";

  // 10. Call timeout, result and session ceilings.
  if (!validLimits(profile, snapshot)) deny();
  const remainingSessionMs = Date.parse(snapshot.expires_at) - now;
  const timeoutMs = Math.min(profile.limits.call_timeout_ms, remainingSessionMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) deny();

  const identity = deriveToolIdentity({
    run_id: input.run_id,
    logical_call_id: input.request.logical_call_id,
    mcp_profile_hash: profile.document_hash,
    discovery_snapshot_hash: snapshot.document_hash,
    server_id: selected.serverRule.server_id,
    tool_alias: selected.toolRule.alias,
    native_tool_name: selected.toolRule.native_name,
    logical_arguments: validatedArguments.value,
  });
  const trace = immutableTrace(input.trace);
  const toss: TossToolMetaV1 = Object.freeze({
    run_id: input.run_id,
    execution_request_hash: input.execution_request_hash,
    agent_definition_hash: input.authority.definition.hash,
    task_contract_hash: input.authority.task_contract.hash,
    role: input.authority.role,
    mcp_profile_hash: profile.document_hash,
    discovery_snapshot_hash: snapshot.document_hash,
    server_id: selected.serverRule.server_id,
    tool_alias: selected.toolRule.alias,
    native_tool_name: selected.toolRule.native_name,
    call_id: identity.call_id,
    idempotency_key: identity.idempotency_key,
    trace,
  });
  const trustedMeta: TossTrustedToolMetaV1 = Object.freeze({ toss });
  return Object.freeze({
    run_id: input.run_id,
    execution_request_hash: input.execution_request_hash,
    agent_definition: immutableReference(input.authority.definition as AgentDefinitionReference),
    task_contract: immutableReference(input.authority.task_contract as TaskContractReference),
    role: input.authority.role,
    profile: immutableReference(snapshot.profile),
    discovery_snapshot_hash: snapshot.document_hash,
    session_id: snapshot.session_id,
    server_id: selected.serverRule.server_id,
    server_identity_hash: discoveredServer.server.identity_hash,
    transport: discoveredServer.transport,
    protocol_revision: discoveredServer.protocol_revision,
    alias: selected.toolRule.alias,
    native_name: selected.toolRule.native_name,
    input_schema: selected.toolRule.input_schema,
    input_schema_hash: selected.toolRule.input_schema_hash,
    output_schema: selected.toolRule.output_schema,
    output_schema_hash: selected.toolRule.output_schema_hash,
    operation_class: selected.toolRule.operation_class,
    approval: selected.toolRule.approval,
    approval_required: approvalRequired,
    content_kinds: selected.toolRule.content_kinds,
    sensitive_output_pointers: selected.toolRule.sensitive_output_pointers,
    logical_call_id: input.request.logical_call_id,
    logical_arguments: validatedArguments.value,
    logical_input_hash: identity.logical_input_hash,
    call_id: identity.call_id,
    idempotency_key: identity.idempotency_key,
    timeout_ms: timeoutMs,
    result_limits: Object.freeze({
      result_bytes: profile.limits.result_bytes,
      content_blocks: profile.limits.content_blocks,
      content_block_bytes: profile.limits.content_block_bytes,
      structured_output_bytes: profile.limits.structured_output_bytes,
    }),
    trace,
    trusted_meta: trustedMeta,
  });
}
