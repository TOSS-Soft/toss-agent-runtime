import { describe, expect, it } from "vitest";

import { matchAgentAuthority } from "../src/agents/authority.js";
import { RuntimeAgentError } from "../src/agents/errors.js";
import type { AgentDefinitionV1 } from "../src/agents/types.js";
import type { ExecutionRequestV1 } from "../src/protocol/request.js";
import type { ArtifactReference } from "../src/protocol/types.js";

const HASH_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const HASH_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const HASH_C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as const;
const HASH_D = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as const;
const HASH_E = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;

function ref<T extends string>(
  document_type: T,
  artifact_id: string,
  revision: number,
  hash: `sha256:${string}`,
): ArtifactReference & Readonly<{ document_type: T }> {
  return { document_type, artifact_id, revision, hash };
}

function definition(): AgentDefinitionV1 {
  return {
    protocol_version: "runtime-contract.v1",
    schema_version: "agent-definition.v1",
    document_type: "agent-definition",
    agent_id: "AGENT-WORKER",
    revision: 1,
    name: "implementation-worker",
    role: "worker",
    prompt_template: ref("prompt-template", "PROMPT-001", 1, HASH_B),
    task_contracts: [ref("task-contract", "TASK-001", 3, HASH_A)],
    model: {
      logical_class: "balanced-code",
      required_capabilities: ["text"],
      allowed_capabilities: ["text", "tools"],
    },
    superpowers: {
      required: ["test-driven-development"],
      allowed: ["test-driven-development", "verification-before-completion"],
    },
    mcp_profiles: [ref("mcp-profile", "MCP-READONLY", 1, HASH_C)],
    budget_class: "standard",
    budget_ceiling: {
      max_input_tokens: 8000,
      max_output_tokens: 4000,
      max_cost_microusd: 500000,
      max_duration_ms: 600000,
      max_turns: 8,
    },
    output_schemas: [ref("output-schema", "OUTPUT-JSON", 1, HASH_D)],
    context_policy: {
      truncation: "utf8-prefix.v1",
      max_untrusted_bytes: 4096,
      inputs: [{ document_type: "source-artifact", priority: 10, max_bytes: 2048 }],
    },
    document_hash: HASH_E,
  };
}

function request(overrides: Partial<ExecutionRequestV1> = {}): ExecutionRequestV1 {
  return {
    protocol_version: "runtime-contract.v1",
    schema_version: "execution-request.v1",
    document_type: "execution-request",
    request_id: "REQ-001",
    run_id: "RUN-001",
    created_at: "2026-08-19T00:00:00.000Z",
    deadline: "2026-08-19T00:10:00.000Z",
    task_contract: ref("task-contract", "TASK-001", 3, HASH_A),
    input_artifacts: [],
    agent: {
      definition: ref("agent-definition", "AGENT-WORKER", 1, HASH_E),
      role: "worker",
    },
    model: { logical_class: "balanced-code", required_capabilities: ["tools", "text"] },
    superpowers: { required: ["test-driven-development"] },
    mcp: { profile: ref("mcp-profile", "MCP-READONLY", 1, HASH_C) },
    budget: {
      max_input_tokens: 7000,
      max_output_tokens: 3000,
      max_cost_microusd: 400000,
      max_duration_ms: 500000,
      max_turns: 7,
    },
    review_policy: ref("review-policy", "REVIEW-001", 1, HASH_B),
    output: { schema: ref("output-schema", "OUTPUT-JSON", 1, HASH_D) },
    trace: {
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      trace_flags: 1,
    },
    ...overrides,
  };
}

function authorityMismatch(
  actualRequest: ExecutionRequestV1,
  actualDefinition: AgentDefinitionV1 = definition(),
): void {
  try {
    matchAgentAuthority(actualRequest, actualDefinition);
    throw new Error("expected authority mismatch");
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeAgentError);
    expect(error).toMatchObject({ code: "RUNTIME_CONTEXT_AUTHORITY_MISMATCH" });
  }
}

type AuthorityReferenceTarget = "definition" | "Task Contract" | "MCP profile" | "output schema";

function replaceAuthorityReference(
  target: AuthorityReferenceTarget,
  reference: ArtifactReference,
): ExecutionRequestV1 {
  const actual = request();
  switch (target) {
    case "definition":
      return request({ agent: { definition: reference, role: actual.agent.role } });
    case "Task Contract":
      return request({ task_contract: reference });
    case "MCP profile":
      return request({ mcp: { profile: reference } });
    case "output schema":
      return request({ output: { schema: reference } });
  }
}

function authorityReference(target: AuthorityReferenceTarget): ArtifactReference {
  const actual = request();
  switch (target) {
    case "definition":
      return actual.agent.definition;
    case "Task Contract":
      return actual.task_contract;
    case "MCP profile":
      return actual.mcp.profile;
    case "output schema":
      return actual.output.schema;
  }
}

describe("execution request authority matching", () => {
  it.each([
    [
      "role",
      () => request({ agent: { definition: request().agent.definition, role: "reviewer" } }),
    ],
    [
      "definition reference",
      () =>
        request({
          agent: { definition: ref("agent-definition", "OTHER", 1, HASH_E), role: "worker" },
        }),
    ],
    [
      "Task Contract",
      () => request({ task_contract: ref("task-contract", "OTHER-TASK", 3, HASH_A) }),
    ],
    [
      "logical class",
      () =>
        request({ model: { logical_class: "deep-reasoning", required_capabilities: ["text"] } }),
    ],
    [
      "missing required model capability",
      () => request({ model: { logical_class: "balanced-code", required_capabilities: [] } }),
    ],
    [
      "extra disallowed model capability",
      () =>
        request({
          model: { logical_class: "balanced-code", required_capabilities: ["text", "vision"] },
        }),
    ],
    ["missing required Superpowers capability", () => request({ superpowers: { required: [] } })],
    [
      "extra disallowed Superpowers capability",
      () => request({ superpowers: { required: ["test-driven-development", "forbidden-skill"] } }),
    ],
    [
      "MCP profile",
      () => request({ mcp: { profile: ref("mcp-profile", "OTHER-MCP", 1, HASH_C) } }),
    ],
    ...(
      [
        "max_input_tokens",
        "max_output_tokens",
        "max_cost_microusd",
        "max_duration_ms",
        "max_turns",
      ] as const
    ).map(
      (dimension) =>
        [
          `budget ${dimension}`,
          () =>
            request({
              budget: {
                ...request().budget,
                [dimension]: definition().budget_ceiling[dimension] + 1,
              },
            }),
        ] as const,
    ),
    [
      "output schema",
      () => request({ output: { schema: ref("output-schema", "OTHER-OUTPUT", 1, HASH_D) } }),
    ],
  ] as const)("rejects %s before any resolver can be called", (_name, makeRequest) => {
    authorityMismatch(makeRequest());
  });

  it.each(
    (["definition", "Task Contract", "MCP profile", "output schema"] as const).flatMap((target) => {
      const reference = authorityReference(target);
      return [
        [
          target,
          "document type",
          { ...reference, document_type: `${reference.document_type}-other` },
        ],
        [target, "artifact ID", { ...reference, artifact_id: `${reference.artifact_id}-other` }],
        [target, "revision", { ...reference, revision: reference.revision + 1 }],
        [target, "hash", { ...reference, hash: reference.hash === HASH_A ? HASH_B : HASH_A }],
      ] as const;
    }),
  )("rejects %s reference %s mismatch", (target, _component, reference) => {
    authorityMismatch(replaceAuthorityReference(target, reference));
  });

  it("ignores location hints for every exact authority reference", () => {
    const actual = request();
    const withLocations = request({
      agent: {
        definition: { ...actual.agent.definition, location: "governance/agent.json" },
        role: actual.agent.role,
      },
      task_contract: { ...actual.task_contract, location: "governance/task.json" },
      mcp: { profile: { ...actual.mcp.profile, location: "governance/mcp.json" } },
      output: { schema: { ...actual.output.schema, location: "governance/output.json" } },
    });

    expect(matchAgentAuthority(withLocations, definition())).toMatchObject({
      definition: withLocations.agent.definition,
      task_contract: withLocations.task_contract,
      mcp_profile: withLocations.mcp.profile,
      output_schema: withLocations.output.schema,
    });
  });

  it("rejects duplicate requested model and Superpowers capabilities", () => {
    authorityMismatch(
      request({
        model: { logical_class: "balanced-code", required_capabilities: ["text", "text"] },
      }),
    );
    authorityMismatch(
      request({
        superpowers: {
          required: ["test-driven-development", "test-driven-development"],
        },
      }),
    );
  });

  it("returns only sorted, narrowed authority as independent deeply frozen values", () => {
    const actualRequest = request({
      agent: {
        definition: { ...request().agent.definition, location: "/caller/request.json" },
        role: "worker",
      },
    });
    const actualDefinition = definition();
    const result = matchAgentAuthority(actualRequest, actualDefinition);

    expect(actualRequest.model.required_capabilities).toEqual(["tools", "text"]);
    expect(result).toEqual({
      definition: actualRequest.agent.definition,
      role: "worker",
      task_contract: actualRequest.task_contract,
      logical_class: "balanced-code",
      model_capabilities: ["text", "tools"],
      superpowers_capabilities: ["test-driven-development"],
      mcp_profile: actualRequest.mcp.profile,
      budget: actualRequest.budget,
      output_schema: actualRequest.output.schema,
    });
    expect(result.definition).not.toBe(actualRequest.agent.definition);
    expect(result.task_contract).not.toBe(actualRequest.task_contract);
    expect(result.mcp_profile).not.toBe(actualRequest.mcp.profile);
    expect(result.output_schema).not.toBe(actualRequest.output.schema);
    expect(result.budget).not.toBe(actualRequest.budget);
    expect(result.model_capabilities).not.toBe(actualRequest.model.required_capabilities);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.definition)).toBe(true);
    expect(Object.isFrozen(result.task_contract)).toBe(true);
    expect(Object.isFrozen(result.model_capabilities)).toBe(true);
    expect(Object.isFrozen(result.superpowers_capabilities)).toBe(true);
    expect(Object.isFrozen(result.mcp_profile)).toBe(true);
    expect(Object.isFrozen(result.budget)).toBe(true);
    expect(Object.isFrozen(result.output_schema)).toBe(true);
  });
});
