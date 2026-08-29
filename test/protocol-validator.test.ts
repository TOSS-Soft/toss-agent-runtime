import { describe, expect, it } from "vitest";

import { createProtocolValidator } from "../src/protocol/validator.js";

const VALID_ARTIFACT_REFERENCE = {
  document_type: "task-contract",
  artifact_id: "TASK-001",
  revision: 1,
  hash: `sha256:${"a".repeat(64)}`,
  location: "project-management/tasks/TASK-001.json",
} as const;

const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;
const PROMPT_REFERENCE = {
  document_type: "prompt-template",
  artifact_id: "prompt-template-public-api",
  revision: 1,
  hash: ZERO_HASH,
} as const;
const DEFINITION_REFERENCE = {
  document_type: "agent-definition",
  artifact_id: "agent-definition-public-api",
  revision: 1,
  hash: ZERO_HASH,
} as const;
const TASK_REFERENCE = {
  document_type: "task-contract",
  artifact_id: "task-contract-public-api",
  revision: 1,
  hash: ZERO_HASH,
} as const;
const MCP_REFERENCE = {
  document_type: "mcp-profile",
  artifact_id: "mcp-profile-public-api",
  revision: 1,
  hash: ZERO_HASH,
} as const;
const OUTPUT_REFERENCE = {
  document_type: "output-schema",
  artifact_id: "output-schema-public-api",
  revision: 1,
  hash: ZERO_HASH,
} as const;
const BUDGET = {
  max_input_tokens: 1000,
  max_output_tokens: 500,
  max_cost_microusd: 100_000,
  max_duration_ms: 60_000,
  max_turns: 4,
} as const;

function segment(
  segment_id: string,
  kind: string,
  trust: string,
  source: typeof TASK_REFERENCE | typeof PROMPT_REFERENCE | typeof OUTPUT_REFERENCE | null,
) {
  return {
    segment_id,
    kind,
    trust,
    source,
    original_hash: ZERO_HASH,
    included_hash: ZERO_HASH,
    original_bytes: 1,
    included_bytes: 1,
    tokens: 1,
    content: "x",
  };
}

const AGENT_SCHEMA_DOCUMENTS = [
  {
    protocol_version: "runtime-contract.v1",
    schema_version: "prompt-template.v1",
    document_type: "prompt-template",
    template_id: "prompt-template-public-api",
    revision: 1,
    instruction_blocks: [{ block_id: "role", content: "Stay within task authority." }],
    document_hash: ZERO_HASH,
  },
  {
    protocol_version: "runtime-contract.v1",
    schema_version: "agent-definition.v1",
    document_type: "agent-definition",
    agent_id: "agent-definition-public-api",
    revision: 1,
    name: "public-api-worker",
    role: "worker",
    prompt_template: PROMPT_REFERENCE,
    task_contracts: [TASK_REFERENCE],
    model: {
      logical_class: "balanced-code",
      required_capabilities: ["text"],
      allowed_capabilities: ["text"],
    },
    superpowers: {
      required: ["test-driven-development"],
      allowed: ["test-driven-development"],
    },
    mcp_profiles: [MCP_REFERENCE],
    budget_class: "standard",
    budget_ceiling: BUDGET,
    output_schemas: [OUTPUT_REFERENCE],
    context_policy: {
      truncation: "utf8-prefix.v1",
      max_untrusted_bytes: 256,
      inputs: [{ document_type: "source-artifact", priority: 1, max_bytes: 256 }],
    },
    document_hash: ZERO_HASH,
  },
  {
    protocol_version: "runtime-contract.v1",
    schema_version: "agent-registry-entry.v1",
    document_type: "agent-registry-entry",
    registry_revision: 1,
    previous_entry_hash: null,
    operation_id: "048e6b57-9448-4b11-b2f9-1bcf3b20c806",
    operation_hash: ZERO_HASH,
    definition: DEFINITION_REFERENCE,
    prompt_template: PROMPT_REFERENCE,
    state: "ACTIVE",
    occurred_at: "2026-08-21T12:00:00.000Z",
    entry_hash: ZERO_HASH,
  },
  {
    protocol_version: "runtime-contract.v1",
    schema_version: "compiled-context.v1",
    document_type: "compiled-context",
    request_hash: ZERO_HASH,
    definition: DEFINITION_REFERENCE,
    prompt_template: PROMPT_REFERENCE,
    task_contract: TASK_REFERENCE,
    output_schema: OUTPUT_REFERENCE,
    authority: {
      logical_class: "balanced-code",
      model_capabilities: ["text"],
      superpowers: ["test-driven-development"],
      mcp_profile: MCP_REFERENCE,
      budget: BUDGET,
    },
    runtime_policy: { revision: 1, hash: ZERO_HASH },
    segments: [
      segment("runtime-safety", "runtime-safety", "trusted-runtime", null),
      segment("task-contract", "task-contract", "trusted-control", TASK_REFERENCE),
      segment("prompt-template", "prompt-template", "trusted-control", PROMPT_REFERENCE),
      segment("output-schema", "output-schema", "trusted-control", OUTPUT_REFERENCE),
    ],
    accounting: {
      input_tokens: 4,
      input_bytes: 4,
      untrusted_bytes: 0,
      remaining_input_tokens: 996,
    },
    truncations: [],
    document_hash: ZERO_HASH,
  },
] as const;

describe("runtime common schema", () => {
  it("registers exactly the four agent document schemas", () => {
    const validator = createProtocolValidator();

    for (const document of AGENT_SCHEMA_DOCUMENTS) {
      expect(
        validator.parse(JSON.stringify(document), document.document_type),
        document.schema_version,
      ).toMatchObject({ ok: true, value: document });
    }
  });

  it("accepts and freezes an exact artifact reference", () => {
    const result = createProtocolValidator().validateFragment(
      "artifact-reference",
      VALID_ARTIFACT_REFERENCE,
    );

    expect(result).toMatchObject({ ok: true, value: VALID_ARTIFACT_REFERENCE });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it.each([
    ["an unknown field", { ...VALID_ARTIFACT_REFERENCE, accepted: true }, "additionalProperties"],
    ["revision zero", { ...VALID_ARTIFACT_REFERENCE, revision: 0 }, "minimum"],
    [
      "an uppercase hash",
      { ...VALID_ARTIFACT_REFERENCE, hash: `sha256:${"A".repeat(64)}` },
      "pattern",
    ],
    [
      "an absolute location",
      { ...VALID_ARTIFACT_REFERENCE, location: "/tmp/task.json" },
      "pattern",
    ],
    ["a traversing location", { ...VALID_ARTIFACT_REFERENCE, location: "../task.json" }, "pattern"],
  ])("rejects %s", (_name, value, keyword) => {
    const result = createProtocolValidator().validateFragment("artifact-reference", value);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.keyword === keyword)).toBe(true);
    }
  });

  it("rejects secret-shaped safe metadata keys", () => {
    const result = createProtocolValidator().validateFragment("runtime-error", {
      code: "PROVIDER_UNAVAILABLE",
      category: "unavailable",
      retryable: true,
      safe_message: "Provider unavailable",
      metadata: { api_token: "must-not-persist" },
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.keyword === "propertyNames")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("must-not-persist");
    }
  });

  it.each([
    "APIKey",
    "APIKEY",
    "CLIENTSECRET",
    "GOVERNANCEAPPROVAL",
    "TOKENVALUE",
    "ACCESSTOKENVALUE",
    "CLIENTTOKENVALUE",
  ])("rejects compact sensitive runtime-error metadata key %s", (key) => {
    const result = createProtocolValidator().validateFragment("runtime-error", {
      code: "PROVIDER_UNAVAILABLE",
      category: "unavailable",
      retryable: true,
      safe_message: "Provider unavailable",
      metadata: { [key]: "must-not-persist" },
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.keyword === "sensitiveMetadata")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("must-not-persist");
    }
  });

  it("rejects accessors without evaluating them", () => {
    let invoked = false;
    const value = Object.defineProperty({ ...VALID_ARTIFACT_REFERENCE }, "location", {
      enumerable: true,
      get() {
        invoked = true;
        return "task.json";
      },
    });

    const result = createProtocolValidator().validateFragment("artifact-reference", value);
    expect(result).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
    expect(invoked).toBe(false);
  });

  it("sorts validation issues by path, keyword, and message", () => {
    const result = createProtocolValidator().validateFragment("artifact-reference", {
      document_type: "",
      artifact_id: "",
      revision: 0,
      hash: "bad",
      location: "../bad",
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      const order = result.issues.map(
        (issue) => `${issue.path}\u0000${issue.keyword}\u0000${issue.message}`,
      );
      expect(order).toEqual([...order].sort());
    }
  });
});
