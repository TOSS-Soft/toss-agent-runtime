import { describe, expect, it } from "vitest";

import {
  hashAgentDefinition,
  hashAgentRegistryEntry,
  hashCompiledContext,
  hashPromptTemplate,
  parseAgentDefinition,
  parseAgentRegistryEntry,
  parseCompiledContext,
  parsePromptTemplate,
} from "../src/agents/contracts.js";
import type {
  AgentDefinitionV1,
  AgentRegistryEntryV1,
  CompiledContextV1,
  PromptTemplateV1,
} from "../src/agents/types.js";

const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;
const TASK_HASH = `sha256:${"1".repeat(64)}` as const;
const MCP_HASH = `sha256:${"2".repeat(64)}` as const;
const OUTPUT_HASH = `sha256:${"3".repeat(64)}` as const;
const TEMPLATE_ID = "template-implementation";
const AGENT_ID = "agent-implementation";
const TASK_ID = "task-contract-implementation";
const MCP_ID = "mcp-profile-development";
const OUTPUT_ID = "output-schema-implementation";

function ref<T extends string>(
  document_type: T,
  artifact_id: string,
  revision: number,
  hash: `sha256:${string}`,
): {
  readonly document_type: T;
  readonly artifact_id: string;
  readonly revision: number;
  readonly hash: `sha256:${string}`;
} {
  return { document_type, artifact_id, revision, hash };
}

function fixturePrompt(): PromptTemplateV1 {
  const prompt: PromptTemplateV1 = {
    protocol_version: "runtime-contract.v1",
    schema_version: "prompt-template.v1",
    document_type: "prompt-template",
    template_id: TEMPLATE_ID,
    revision: 1,
    instruction_blocks: [{ block_id: "role", content: "Act within the task contract." }],
    document_hash: ZERO_HASH,
  };
  return { ...prompt, document_hash: hashPromptTemplate(prompt) };
}

function fixtureDefinition(promptHash: `sha256:${string}`): AgentDefinitionV1 {
  const definition: AgentDefinitionV1 = {
    protocol_version: "runtime-contract.v1",
    schema_version: "agent-definition.v1",
    document_type: "agent-definition",
    agent_id: AGENT_ID,
    revision: 1,
    name: "implementation-worker",
    role: "worker",
    prompt_template: ref("prompt-template", TEMPLATE_ID, 1, promptHash),
    task_contracts: [ref("task-contract", TASK_ID, 3, TASK_HASH)],
    model: {
      logical_class: "balanced-code",
      required_capabilities: ["text"],
      allowed_capabilities: ["json-schema", "text", "tools"],
    },
    superpowers: {
      required: ["test-driven-development"],
      allowed: ["test-driven-development", "verification-before-completion"],
    },
    mcp_profiles: [ref("mcp-profile", MCP_ID, 2, MCP_HASH)],
    budget_class: "standard",
    budget_ceiling: {
      max_input_tokens: 8000,
      max_output_tokens: 4000,
      max_cost_microusd: 500000,
      max_duration_ms: 600000,
      max_turns: 8,
    },
    output_schemas: [ref("output-schema", OUTPUT_ID, 4, OUTPUT_HASH)],
    context_policy: {
      truncation: "utf8-prefix.v1",
      max_untrusted_bytes: 4096,
      inputs: [{ document_type: "source-artifact", priority: 10, max_bytes: 2048 }],
    },
    document_hash: ZERO_HASH,
  };
  return { ...definition, document_hash: hashAgentDefinition(definition) };
}

function fixtureRegistry(promptHash: `sha256:${string}`, definitionHash: `sha256:${string}`) {
  const entry: AgentRegistryEntryV1 = {
    protocol_version: "runtime-contract.v1",
    schema_version: "agent-registry-entry.v1",
    document_type: "agent-registry-entry",
    registry_revision: 1,
    previous_entry_hash: null,
    operation_id: "048e6b57-9448-4b11-b2f9-1bcf3b20c806",
    operation_hash: TASK_HASH,
    definition: ref("agent-definition", AGENT_ID, 1, definitionHash),
    prompt_template: ref("prompt-template", TEMPLATE_ID, 1, promptHash),
    state: "ACTIVE",
    occurred_at: "2026-08-21T12:00:00.000Z",
    entry_hash: ZERO_HASH,
  };
  return { ...entry, entry_hash: hashAgentRegistryEntry(entry) };
}

function fixtureContext(
  promptHash: `sha256:${string}`,
  definitionHash: `sha256:${string}`,
): CompiledContextV1 {
  const context: CompiledContextV1 = {
    protocol_version: "runtime-contract.v1",
    schema_version: "compiled-context.v1",
    document_type: "compiled-context",
    request_hash: TASK_HASH,
    definition: ref("agent-definition", AGENT_ID, 1, definitionHash),
    prompt_template: ref("prompt-template", TEMPLATE_ID, 1, promptHash),
    task_contract: ref("task-contract", TASK_ID, 3, TASK_HASH),
    output_schema: ref("output-schema", OUTPUT_ID, 4, OUTPUT_HASH),
    authority: {
      logical_class: "balanced-code",
      model_capabilities: ["text"],
      superpowers: ["test-driven-development"],
      mcp_profile: ref("mcp-profile", MCP_ID, 2, MCP_HASH),
      budget: {
        max_input_tokens: 8000,
        max_output_tokens: 4000,
        max_cost_microusd: 500000,
        max_duration_ms: 600000,
        max_turns: 8,
      },
    },
    runtime_policy: { revision: 1, hash: OUTPUT_HASH },
    segments: [
      {
        segment_id: "runtime-safety",
        kind: "runtime-safety",
        trust: "trusted-runtime",
        source: null,
        original_hash: TASK_HASH,
        included_hash: TASK_HASH,
        original_bytes: 1,
        included_bytes: 1,
        tokens: 1,
        content: "x",
      },
    ],
    accounting: {
      input_tokens: 1,
      input_bytes: 1,
      untrusted_bytes: 0,
      remaining_input_tokens: 7999,
    },
    truncations: [],
    document_hash: ZERO_HASH,
  };
  return { ...context, document_hash: hashCompiledContext(context) };
}

describe("agent contract documents", () => {
  it("parses canonical hash-bound documents as deeply frozen values", () => {
    const prompt = fixturePrompt();
    const definition = fixtureDefinition(prompt.document_hash);
    const registry = fixtureRegistry(prompt.document_hash, definition.document_hash);
    const context = fixtureContext(prompt.document_hash, definition.document_hash);

    for (const [parse, value] of [
      [parsePromptTemplate, prompt],
      [parseAgentDefinition, definition],
      [parseAgentRegistryEntry, registry],
      [parseCompiledContext, context],
    ] as const) {
      const parsed = parse(JSON.stringify(value));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(Object.isFrozen(parsed.value)).toBe(true);
    }
  });

  it("rejects duplicate keys, unknown fields, bounds, invalid hashes, and noncanonical sets", () => {
    const prompt = fixturePrompt();
    const definition = fixtureDefinition(prompt.document_hash);
    const duplicate = JSON.stringify(prompt).replace(
      '"template_id"',
      `"template_id":"${TEMPLATE_ID}","template_id"`,
    );
    expect(parsePromptTemplate(duplicate).ok).toBe(false);
    expect(parsePromptTemplate(JSON.stringify({ ...prompt, unexpected: true })).ok).toBe(false);
    expect(
      parsePromptTemplate(
        JSON.stringify({
          ...prompt,
          instruction_blocks: Array.from({ length: 1025 }, () => prompt.instruction_blocks[0]),
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseAgentDefinition(JSON.stringify({ ...definition, document_hash: ZERO_HASH })).ok,
    ).toBe(false);
    expect(
      parseAgentDefinition(
        JSON.stringify({
          ...definition,
          model: { ...definition.model, allowed_capabilities: ["text", "json-schema"] },
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseAgentDefinition(
        JSON.stringify({
          ...definition,
          task_contracts: [...definition.task_contracts, definition.task_contracts[0]],
        }),
      ).ok,
    ).toBe(false);
  });
});
