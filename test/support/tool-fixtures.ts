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
