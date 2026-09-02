import { describe, expect, it } from "vitest";

import type { EffectiveAgentAuthority } from "../src/agents/authority.js";
import type { McpProfileReference } from "../src/agents/types.js";
import { sha256 } from "../src/protocol/json.js";
import type { TraceContext } from "../src/protocol/types.js";
import type { ToolSession } from "../src/tools/discovery.js";
import { authorizeToolCall, type AuthorizeToolCallInput } from "../src/tools/policy.js";
import type { McpDiscoverySnapshotV1, McpProfileV1 } from "../src/tools/types.js";
import { rehashMcpProfile, validMcpProfile, withDocumentHash } from "./support/tool-fixtures.js";

const EXECUTION_HASH = `sha256:${"8".repeat(64)}` as const;
const TRACE = {
  trace_id: "1".repeat(32),
  span_id: "2".repeat(16),
  trace_flags: 1,
  trace_state: "toss=opaque",
} as const satisfies TraceContext;

function profileReference(profile: McpProfileV1): McpProfileReference {
  return {
    document_type: "mcp-profile",
    artifact_id: profile.profile_id,
    revision: profile.revision,
    hash: profile.document_hash,
  };
}

function snapshot(profile: McpProfileV1): McpDiscoverySnapshotV1 {
  const server = profile.servers[0]!;
  const tool = server.tools[0]!;
  return withDocumentHash({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "mcp-discovery-snapshot.v1" as const,
    document_type: "mcp-discovery-snapshot" as const,
    run_id: "run-1",
    session_id: "session-1",
    execution_request_hash: EXECUTION_HASH,
    profile: profileReference(profile),
    created_at: "2026-09-01T10:00:00.000Z",
    expires_at: "2026-09-01T10:05:00.000Z",
    stale: false,
    servers: [
      {
        server_id: server.server_id,
        binding_name: server.binding_name,
        transport: "agentgateway" as const,
        protocol_revision: server.protocol_revision,
        server: {
          name: "github-mcp",
          version: "1.2.3",
          identity_hash: sha256({
            name: "github-mcp",
            protocol_revision: server.protocol_revision,
            version: "1.2.3",
          }),
        },
        tools: [
          {
            alias: tool.alias,
            native_name: tool.native_name,
            input_schema_hash: tool.input_schema_hash,
            output_schema_hash: tool.output_schema_hash,
            operation_class: tool.operation_class,
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

function authority(profile: McpProfileV1): EffectiveAgentAuthority {
  const taskContract = profile.servers[0]!.tools[0]!.task_contracts[0]!;
  return Object.freeze({
    definition: {
      document_type: "agent-definition",
      artifact_id: "worker-agent",
      revision: 1,
      hash: `sha256:${"b".repeat(64)}` as const,
    },
    role: "worker",
    task_contract: taskContract,
    logical_class: "balanced-code",
    model_capabilities: ["text", "tools"],
    superpowers_capabilities: [],
    mcp_profile: profileReference(profile),
    budget: {
      max_input_tokens: 10_000,
      max_output_tokens: 2_000,
      max_cost_microusd: 1_000_000,
      max_duration_ms: 300_000,
      max_turns: 8,
    },
    output_schema: {
      document_type: "output-schema",
      artifact_id: "worker-output",
      revision: 1,
      hash: `sha256:${"c".repeat(64)}` as const,
    },
  });
}

function sessionFor(value: McpDiscoverySnapshotV1): ToolSession {
  return Object.freeze({
    run_id: value.run_id,
    session_id: value.session_id,
    profile: value.profile,
    discover: () => Promise.reject(new Error("not used")),
    snapshot: () => value,
    connection: () => {
      throw new Error("not used");
    },
    markListChanged: () => undefined,
    close: () => Promise.resolve(),
  });
}

type MutablePolicyInput = {
  -readonly [Key in keyof AuthorizeToolCallInput]: AuthorizeToolCallInput[Key];
};

function fixture(): MutablePolicyInput {
  const profile = validMcpProfile();
  const discoverySnapshot = snapshot(profile);
  return {
    run_id: discoverySnapshot.run_id,
    execution_request_hash: EXECUTION_HASH,
    authority: authority(profile),
    profile,
    session: sessionFor(discoverySnapshot),
    discovery_snapshot: discoverySnapshot,
    now: new Date("2026-09-01T10:01:00.000Z"),
    trace: TRACE,
    request: {
      alias: "repo.search",
      logical_call_id: "model-call-1",
      arguments: { query: "runtime" },
      caller_meta: null,
    },
  };
}

function denied(input: AuthorizeToolCallInput): void {
  expect(() => authorizeToolCall(input)).toThrowError(
    expect.objectContaining({ code: "RUNTIME_TOOL_POLICY_DENIED" }),
  );
}

describe("ordered MCP tool policy", () => {
  it("derives a stable, closed call identity and TOSS-owned metadata", () => {
    const input = fixture();
    const first = authorizeToolCall(input);
    const second = authorizeToolCall(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      run_id: "run-1",
      role: "worker",
      session_id: "session-1",
      server_id: "github",
      alias: "repo.search",
      native_name: "search_repositories",
      operation_class: "read-only",
      approval_required: false,
      logical_arguments: { query: "runtime" },
      timeout_ms: 30_000,
    });
    expect(first.call_id).toMatch(/^tool-call-[0-9a-f]{32}$/u);
    expect(first.idempotency_key).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.trusted_meta).toEqual({
      toss: {
        run_id: "run-1",
        execution_request_hash: EXECUTION_HASH,
        agent_definition_hash: input.authority.definition.hash,
        task_contract_hash: input.authority.task_contract.hash,
        role: "worker",
        mcp_profile_hash: input.profile.document_hash,
        discovery_snapshot_hash: input.discovery_snapshot.document_hash,
        server_id: "github",
        tool_alias: "repo.search",
        native_tool_name: "search_repositories",
        call_id: first.call_id,
        idempotency_key: first.idempotency_key,
        trace: TRACE,
      },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.trusted_meta.toss)).toBe(true);
  });

  it("binds identity to the logical input and exact tool", () => {
    const base = authorizeToolCall(fixture());
    const changedInput = fixture();
    changedInput.request = { ...changedInput.request, arguments: { query: "other" } };
    const changedCall = fixture();
    changedCall.request = { ...changedCall.request, logical_call_id: "model-call-2" };

    expect(authorizeToolCall(changedInput).idempotency_key).not.toBe(base.idempotency_key);
    expect(authorizeToolCall(changedCall).idempotency_key).not.toBe(base.idempotency_key);
  });

  it("denies caller or model metadata instead of merging it", () => {
    const input = fixture();
    input.request = { ...input.request, caller_meta: { toss: { role: "reviewer" } } };
    denied(input);
  });

  it.each(["run", "request", "definition", "role", "task-contract", "profile", "trace"] as const)(
    "denies a mismatched %s authority dimension",
    (dimension) => {
      const input = fixture();
      switch (dimension) {
        case "run":
          input.run_id = "run-2";
          break;
        case "request":
          input.execution_request_hash = `sha256:${"9".repeat(64)}`;
          break;
        case "definition":
          input.authority = {
            ...input.authority,
            definition: { ...input.authority.definition, document_type: "prompt-template" },
          };
          break;
        case "role":
          input.authority = { ...input.authority, role: "owner" };
          break;
        case "task-contract":
          input.authority = {
            ...input.authority,
            task_contract: {
              ...input.authority.task_contract,
              hash: `sha256:${"4".repeat(64)}`,
            },
          };
          break;
        case "profile":
          input.authority = {
            ...input.authority,
            mcp_profile: { ...input.authority.mcp_profile, revision: 2 },
          };
          break;
        case "trace":
          input.trace = { ...input.trace, trace_id: "not-a-trace" };
          break;
      }
      denied(input);
    },
  );

  it.each(["closed", "wrong-session", "stale", "expired", "detached"] as const)(
    "denies a %s discovery session",
    (state) => {
      const input = fixture();
      if (state === "closed") {
        input.session = { ...sessionFor(input.discovery_snapshot), snapshot: () => null };
      } else if (state === "wrong-session") {
        input.session = { ...input.session, session_id: "session-2" };
      } else if (state === "stale") {
        input.discovery_snapshot = withDocumentHash({
          ...input.discovery_snapshot,
          stale: true,
        });
        input.session = sessionFor(input.discovery_snapshot);
      } else if (state === "expired") {
        input.now = new Date("2026-09-01T10:05:00.000Z");
      } else {
        input.session = {
          ...input.session,
          snapshot: () => withDocumentHash({ ...input.discovery_snapshot, stale: true }),
        };
      }
      denied(input);
    },
  );

  it("denies unknown aliases and alias-to-native mapping drift", () => {
    const unknown = fixture();
    unknown.request = { ...unknown.request, alias: "repo.delete" };
    denied(unknown);

    const drift = fixture();
    const server = drift.discovery_snapshot.servers[0]!;
    drift.discovery_snapshot = withDocumentHash({
      ...drift.discovery_snapshot,
      servers: [
        {
          ...server,
          tools: [{ ...server.tools[0]!, native_name: "delete_repository" }],
        },
      ],
    });
    drift.session = sessionFor(drift.discovery_snapshot);
    denied(drift);
  });

  it("enforces role and exact Task Contract membership", () => {
    const role = fixture();
    const tool = role.profile.servers[0]!.tools[0]!;
    role.profile = rehashMcpProfile({
      ...role.profile,
      servers: [
        {
          ...role.profile.servers[0]!,
          tools: [{ ...tool, allowed_roles: ["reviewer"] as const }],
        },
      ],
    });
    denied(role);

    const contract = fixture();
    contract.authority = {
      ...contract.authority,
      task_contract: {
        ...contract.authority.task_contract,
        artifact_id: "TASK-OTHER",
      },
    };
    denied(contract);
  });

  it.each(["input", "output", "operation"] as const)(
    "denies discovered %s schema or policy drift",
    (dimension) => {
      const input = fixture();
      const server = input.discovery_snapshot.servers[0]!;
      const tool = server.tools[0]!;
      input.discovery_snapshot = withDocumentHash({
        ...input.discovery_snapshot,
        servers: [
          {
            ...server,
            tools: [
              {
                ...tool,
                ...(dimension === "input"
                  ? { input_schema_hash: `sha256:${"5".repeat(64)}` as const }
                  : {}),
                ...(dimension === "output"
                  ? { output_schema_hash: `sha256:${"6".repeat(64)}` as const }
                  : {}),
                ...(dimension === "operation" ? { operation_class: "irreversible" as const } : {}),
              },
            ],
          },
        ],
      });
      input.session = sessionFor(input.discovery_snapshot);
      denied(input);
    },
  );

  it("validates bounded arguments and rejects secret-shaped keys recursively", () => {
    const schema = fixture();
    schema.request = { ...schema.request, arguments: { query: 7 } };
    denied(schema);

    const secret = fixture();
    secret.request = {
      ...secret.request,
      arguments: { query: "runtime", nested: { api_token: "do-not-store" } },
    };
    denied(secret);

    const oversized = fixture();
    oversized.request = {
      ...oversized.request,
      arguments: { query: "x".repeat(oversized.profile.limits.arguments_bytes) },
    };
    denied(oversized);
  });

  it.each(["reversible-write", "irreversible"] as const)(
    "prevents reviewer execution of %s",
    (operationClass) => {
      const input = fixture();
      const baseTool = input.profile.servers[0]!.tools[0]!;
      const profile = rehashMcpProfile({
        ...input.profile,
        servers: [
          {
            ...input.profile.servers[0]!,
            tools: [
              {
                ...baseTool,
                operation_class: operationClass,
                approval: "required" as const,
              },
            ],
          },
        ],
      });
      const discoverySnapshot = snapshot(profile);
      input.profile = profile;
      input.discovery_snapshot = discoverySnapshot;
      input.session = sessionFor(discoverySnapshot);
      input.authority = { ...authority(profile), role: "reviewer" };
      denied(input);
    },
  );

  it("derives approval from coherent operation policy", () => {
    const input = fixture();
    const baseTool = input.profile.servers[0]!.tools[0]!;
    const profile = rehashMcpProfile({
      ...input.profile,
      servers: [
        {
          ...input.profile.servers[0]!,
          tools: [
            {
              ...baseTool,
              operation_class: "reversible-write" as const,
              approval: "required" as const,
            },
          ],
        },
      ],
    });
    const discoverySnapshot = snapshot(profile);
    input.profile = profile;
    input.discovery_snapshot = discoverySnapshot;
    input.session = sessionFor(discoverySnapshot);
    input.authority = authority(profile);

    expect(authorizeToolCall(input).approval_required).toBe(true);
  });

  it("denies incoherent call, result, and session ceilings", () => {
    const input = fixture();
    input.profile = {
      ...input.profile,
      limits: { ...input.profile.limits, call_timeout_ms: 400_000 },
    };
    denied(input);
  });

  it("ignores non-authoritative descriptions and server annotations", () => {
    const first = authorizeToolCall(fixture());
    const input = fixture();
    const server = input.discovery_snapshot.servers[0]!;
    input.discovery_snapshot = withDocumentHash({
      ...input.discovery_snapshot,
      servers: [
        {
          ...server,
          tools: [
            {
              ...server.tools[0]!,
              annotations: {
                read_only_hint: false,
                destructive_hint: false,
                idempotent_hint: false,
                open_world_hint: false,
              },
            },
          ],
        },
      ],
    });
    input.session = sessionFor(input.discovery_snapshot);
    const second = authorizeToolCall(input);

    expect(second.operation_class).toBe(first.operation_class);
    expect(second.approval_required).toBe(first.approval_required);
  });
});
