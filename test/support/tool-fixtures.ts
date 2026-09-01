import { sha256 } from "../../src/protocol/json.js";

const TASK_CONTRACT = {
  document_type: "task-contract" as const,
  artifact_id: "TASK-001",
  revision: 1,
  hash: `sha256:${"a".repeat(64)}` as const,
};

export function rehashMcpProfile<T extends Readonly<Record<string, unknown>>>(
  value: T,
): Omit<T, "document_hash"> & { readonly document_hash: `sha256:${string}` } {
  const hashable: Record<string, unknown> = { ...value };
  delete hashable.document_hash;
  return { ...value, document_hash: sha256(hashable) };
}

export function validMcpProfile() {
  const inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: 256 },
    },
  } as const;
  const outputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["count"],
    properties: {
      count: { type: "integer", minimum: 0 },
    },
  } as const;

  return rehashMcpProfile({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "mcp-profile.v1" as const,
    document_type: "mcp-profile" as const,
    profile_id: "engineering-readonly",
    revision: 1,
    limits: {
      discovery_pages_per_server: 8,
      tools_per_server: 32,
      schema_bytes: 65_536,
      arguments_bytes: 131_072,
      result_bytes: 524_288,
      content_blocks: 32,
      content_block_bytes: 131_072,
      structured_output_bytes: 131_072,
      discovery_timeout_ms: 10_000,
      call_timeout_ms: 30_000,
      session_lifetime_ms: 300_000,
    },
    servers: [
      {
        server_id: "github",
        binding_name: "github",
        protocol_revision: "2025-06-18" as const,
        x_mcp_headers: {},
        tools: [
          {
            alias: "repo.search",
            description: "Search repositories allowed by the task.",
            native_name: "search_repositories",
            allowed_roles: ["reviewer", "worker"] as const,
            task_contracts: [TASK_CONTRACT],
            input_schema: inputSchema,
            input_schema_hash: sha256(inputSchema),
            output_schema: outputSchema,
            output_schema_hash: sha256(outputSchema),
            operation_class: "read-only" as const,
            approval: "not-required" as const,
            content_kinds: ["text"] as const,
            sensitive_output_pointers: [] as const,
          },
        ],
      },
    ],
  });
}

const PROFILE_REFERENCE = {
  document_type: "mcp-profile" as const,
  artifact_id: "engineering-readonly",
  revision: 1,
  hash: validMcpProfile().document_hash,
};
const AGENT_REFERENCE = {
  document_type: "agent-definition" as const,
  artifact_id: "worker-agent",
  revision: 1,
  hash: `sha256:${"b".repeat(64)}` as const,
};
const TRACE = {
  trace_id: "1".repeat(32),
  span_id: "2".repeat(16),
  trace_flags: 1,
} as const;
const JOURNAL_HEAD = {
  journal_revision: 4,
  sequence: 4,
  entry_hash: `sha256:${"c".repeat(64)}` as const,
} as const;
const SNAPSHOT_HASH = `sha256:${"d".repeat(64)}` as const;
const INPUT_HASH = `sha256:${"e".repeat(64)}` as const;
const OUTPUT_HASH = `sha256:${"f".repeat(64)}` as const;
const IDEMPOTENCY_KEY = `sha256:${"1".repeat(64)}` as const;

export function withDocumentHash<T extends Readonly<Record<string, unknown>>>(
  value: T,
): Omit<T, "document_hash"> & { readonly document_hash: `sha256:${string}` } {
  const hashable: Record<string, unknown> = { ...value };
  delete hashable.document_hash;
  return { ...value, document_hash: sha256(hashable) };
}

export function validMcpDiscoverySnapshot() {
  return withDocumentHash({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "mcp-discovery-snapshot.v1" as const,
    document_type: "mcp-discovery-snapshot" as const,
    run_id: "run-1",
    session_id: "session-1",
    execution_request_hash: `sha256:${"2".repeat(64)}` as const,
    profile: PROFILE_REFERENCE,
    created_at: "2026-09-01T10:00:00.000Z",
    expires_at: "2026-09-01T10:05:00.000Z",
    stale: false,
    servers: [
      {
        server_id: "github",
        binding_name: "github",
        transport: "agentgateway" as const,
        protocol_revision: "2025-06-18" as const,
        server: {
          name: "github-mcp",
          version: "1.2.3",
          identity_hash: `sha256:${"3".repeat(64)}` as const,
        },
        tools: [
          {
            alias: "repo.search",
            native_name: "search_repositories",
            input_schema_hash: INPUT_HASH,
            output_schema_hash: OUTPUT_HASH,
            operation_class: "read-only" as const,
            annotations: {
              read_only_hint: true,
              destructive_hint: false,
              idempotent_hint: true,
              open_world_hint: true,
            },
          },
        ],
      },
    ],
  });
}

export function validToolApprovalRequest() {
  return withDocumentHash({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "tool-approval.v1" as const,
    document_type: "tool-approval" as const,
    kind: "REQUEST" as const,
    run_id: "run-1",
    pending_journal_head: JOURNAL_HEAD,
    execution_request_hash: `sha256:${"2".repeat(64)}` as const,
    agent_definition: AGENT_REFERENCE,
    task_contract: TASK_CONTRACT,
    role: "worker" as const,
    profile: PROFILE_REFERENCE,
    discovery_snapshot_hash: SNAPSHOT_HASH,
    server_id: "github",
    alias: "repo.create",
    native_name: "create_repository",
    input_schema_hash: INPUT_HASH,
    output_schema_hash: OUTPUT_HASH,
    operation_class: "reversible-write" as const,
    logical_input_hash: `sha256:${"4".repeat(64)}` as const,
    call_id: "tool-call-1",
    idempotency_key: IDEMPOTENCY_KEY,
    summary: "Create repository redacted-name",
    decision: null,
    trace: TRACE,
  });
}

export function validToolApprovalDecision() {
  const request = validToolApprovalRequest();
  return withDocumentHash({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "tool-approval.v1" as const,
    document_type: "tool-approval" as const,
    kind: "DECISION" as const,
    run_id: request.run_id,
    pending_journal_head: request.pending_journal_head,
    call_id: request.call_id,
    approval_request_hash: request.document_hash,
    operation_id: "approval-operation-1",
    decision: "APPROVE" as const,
    decided_at: "2026-09-01T10:01:00.000Z",
    trace: TRACE,
  });
}

export function validToolCall() {
  return withDocumentHash({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "tool-call.v1" as const,
    document_type: "tool-call" as const,
    run_id: "run-1",
    call_revision: 1,
    previous_call_hash: null,
    stage: "PREPARED" as const,
    dispatch_state: "NOT_SENT" as const,
    execution_request_hash: `sha256:${"2".repeat(64)}` as const,
    agent_definition: AGENT_REFERENCE,
    task_contract: TASK_CONTRACT,
    role: "worker" as const,
    profile: PROFILE_REFERENCE,
    discovery_snapshot_hash: SNAPSHOT_HASH,
    session_id: "session-1",
    server_id: "github",
    transport: "agentgateway" as const,
    protocol_revision: "2025-06-18" as const,
    alias: "repo.search",
    native_name: "search_repositories",
    input_schema_hash: INPUT_HASH,
    output_schema_hash: OUTPUT_HASH,
    operation_class: "read-only" as const,
    logical_call_id: "model-call-1",
    operation_id: "tool-operation-1",
    call_id: "tool-call-1",
    idempotency_key: IDEMPOTENCY_KEY,
    logical_arguments: { query: "runtime" },
    logical_input_hash: sha256({ query: "runtime" }),
    approval_request_hash: null,
    prepared_at: "2026-09-01T10:00:30.000Z",
    terminal_at: null,
    result_hash: null,
    terminal_code: null,
  });
}

export function validToolResult() {
  return withDocumentHash({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "tool-result.v1" as const,
    document_type: "tool-result" as const,
    run_id: "run-1",
    call_id: "tool-call-1",
    idempotency_key: IDEMPOTENCY_KEY,
    status: "success" as const,
    is_error: false,
    trust: "untrusted-content" as const,
    content: [{ type: "text" as const, text: "2 repositories" }],
    structured_content: { count: 2 },
    provenance: {
      profile: PROFILE_REFERENCE,
      discovery_snapshot_hash: SNAPSHOT_HASH,
      server_id: "github",
      server_identity_hash: `sha256:${"3".repeat(64)}` as const,
      protocol_revision: "2025-06-18" as const,
      transport: "agentgateway" as const,
      alias: "repo.search",
      native_name: "search_repositories",
      input_schema_hash: INPUT_HASH,
      output_schema_hash: OUTPUT_HASH,
      call_id: "tool-call-1",
      idempotency_key: IDEMPOTENCY_KEY,
    },
    trace: TRACE,
    accounting: {
      content_blocks: 1,
      total_bytes: 14,
      structured_bytes: 11,
    },
    error: null,
  });
}
