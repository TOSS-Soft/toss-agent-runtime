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
import { sha256 } from "../src/protocol/json.js";
import type { ArtifactReference } from "../src/protocol/types.js";
import type {
  AgentDefinitionV1,
  AgentRegistryEntryV1,
  CompiledContextV1,
  HashableAgentDefinitionV1,
  HashableAgentRegistryEntryV1,
  HashableCompiledContextV1,
  HashablePromptTemplateV1,
  PromptTemplateV1,
} from "../src/agents/types.js";

const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;
const TASK_HASH = `sha256:${"1".repeat(64)}` as const;
const MCP_HASH = `sha256:${"2".repeat(64)}` as const;
const OUTPUT_HASH = `sha256:${"3".repeat(64)}` as const;
const INPUT_HASH = sha256("untrusted source artifact");
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
      segment(
        "runtime-safety",
        "trusted-runtime",
        null,
        sha256("runtime safety"),
        "runtime safety",
      ),
      segment(
        "task-contract",
        "trusted-control",
        ref("task-contract", TASK_ID, 3, TASK_HASH),
        TASK_HASH,
        "task contract",
      ),
      segment(
        "prompt-template",
        "trusted-control",
        ref("prompt-template", TEMPLATE_ID, 1, promptHash),
        promptHash,
        "prompt template",
      ),
      segment(
        "output-schema",
        "trusted-control",
        ref("output-schema", OUTPUT_ID, 4, OUTPUT_HASH),
        OUTPUT_HASH,
        "output schema",
      ),
      segment(
        "input-artifact",
        "untrusted-content",
        ref("source-artifact", "source-implementation", 1, INPUT_HASH),
        INPUT_HASH,
        "untrusted source artifact",
      ),
    ],
    accounting: { input_tokens: 0, input_bytes: 0, untrusted_bytes: 0, remaining_input_tokens: 0 },
    truncations: [],
    document_hash: ZERO_HASH,
  };
  return resignedContext(context);
}

function segment(
  kind: string,
  trust: string,
  source: ReturnType<typeof ref> | null,
  original_hash: `sha256:${string}`,
  content: string,
): CompiledContextV1["segments"][number] {
  const included_bytes = Buffer.byteLength(content, "utf8");
  return {
    segment_id: `${kind}-segment`,
    kind,
    trust,
    source,
    original_hash,
    included_hash: sha256(content),
    original_bytes: included_bytes,
    included_bytes,
    tokens: included_bytes,
    content,
  } as unknown as CompiledContextV1["segments"][number];
}

function resignedDefinition(value: AgentDefinitionV1): AgentDefinitionV1 {
  return { ...value, document_hash: hashAgentDefinition(value) };
}

function resignedRegistry(value: AgentRegistryEntryV1): AgentRegistryEntryV1 {
  return { ...value, entry_hash: hashAgentRegistryEntry(value) };
}

interface ContextSegmentForHash {
  readonly segment_id: string;
  readonly kind: string;
  readonly trust: string;
  readonly source: ArtifactReference | null;
  readonly original_hash: `sha256:${string}`;
  readonly included_hash: `sha256:${string}`;
  readonly original_bytes: number;
  readonly included_bytes: number;
  readonly tokens: number;
  readonly content: string;
}

type ContextForHash = Omit<CompiledContextV1, "authority" | "segments"> & {
  readonly authority: Omit<CompiledContextV1["authority"], "mcp_profile"> & {
    readonly mcp_profile: ArtifactReference;
  };
  readonly segments: readonly ContextSegmentForHash[];
};

function resignedContext(value: ContextForHash): CompiledContextV1 {
  const input_tokens = value.segments.reduce((total, item) => total + item.tokens, 0);
  const input_bytes = value.segments.reduce((total, item) => total + item.included_bytes, 0);
  const untrusted_bytes = value.segments.reduce(
    (total, item) => total + (item.trust === "untrusted-content" ? item.included_bytes : 0),
    0,
  );
  const unsigned = {
    ...value,
    accounting: {
      input_tokens,
      input_bytes,
      untrusted_bytes,
      remaining_input_tokens: value.authority.budget.max_input_tokens - input_tokens,
    },
  };
  return {
    ...unsigned,
    document_hash: hashCompiledContext(unsigned as unknown as HashableCompiledContextV1),
  } as CompiledContextV1;
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
    const parsedPrompt = parsePromptTemplate(JSON.stringify(prompt));
    const parsedDefinition = parseAgentDefinition(JSON.stringify(definition));
    const parsedRegistry = parseAgentRegistryEntry(JSON.stringify(registry));
    const parsedContext = parseCompiledContext(JSON.stringify(context));
    if (parsedPrompt.ok) {
      expect(Object.isFrozen(parsedPrompt.value.instruction_blocks)).toBe(true);
      expect(Object.isFrozen(parsedPrompt.value.instruction_blocks[0]!)).toBe(true);
    }
    if (parsedDefinition.ok) expect(Object.isFrozen(parsedDefinition.value.model)).toBe(true);
    if (parsedRegistry.ok) expect(Object.isFrozen(parsedRegistry.value.definition)).toBe(true);
    if (parsedContext.ok) expect(Object.isFrozen(parsedContext.value.segments[0]!)).toBe(true);
  });

  it("rejects duplicate keys, unknown fields, and bounds for every document", () => {
    const prompt = fixturePrompt();
    const definition = fixtureDefinition(prompt.document_hash);
    const registry = fixtureRegistry(prompt.document_hash, definition.document_hash);
    const context = fixtureContext(prompt.document_hash, definition.document_hash);
    const matrix = [
      [parsePromptTemplate, prompt],
      [parseAgentDefinition, definition],
      [parseAgentRegistryEntry, registry],
      [parseCompiledContext, context],
    ] as const;
    for (const [parse, value] of matrix) {
      const duplicate = JSON.stringify(value).replace(
        '"protocol_version"',
        '"protocol_version":"runtime-contract.v1","protocol_version"',
      );
      expect(parse(duplicate).ok).toBe(false);
      expect(parse(JSON.stringify({ ...value, unexpected: true })).ok).toBe(false);
    }
    expect(
      parsePromptTemplate(
        JSON.stringify({
          ...prompt,
          instruction_blocks: Array.from({ length: 1025 }, () => prompt.instruction_blocks[0]),
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseAgentDefinition(
        JSON.stringify({
          ...definition,
          task_contracts: Array.from({ length: 257 }, () => definition.task_contracts[0]),
        }),
      ).ok,
    ).toBe(false);
    expect(parseAgentRegistryEntry(JSON.stringify({ ...registry, registry_revision: 0 })).ok).toBe(
      false,
    );
    expect(
      parseCompiledContext(
        JSON.stringify({
          ...context,
          segments: Array.from({ length: 4097 }, () => context.segments[0]),
        }),
      ).ok,
    ).toBe(false);
  });

  it("keeps all document hashes invariant across object key permutations", () => {
    const prompt = fixturePrompt();
    const definition = fixtureDefinition(prompt.document_hash);
    const registry = fixtureRegistry(prompt.document_hash, definition.document_hash);
    const context = fixtureContext(prompt.document_hash, definition.document_hash);
    const permute = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(permute);
      if (typeof value !== "object" || value === null) return value;
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, item]) => [key, permute(item)]),
      );
    };

    expect(hashPromptTemplate(permute(prompt) as HashablePromptTemplateV1)).toBe(
      prompt.document_hash,
    );
    expect(hashAgentDefinition(permute(definition) as HashableAgentDefinitionV1)).toBe(
      definition.document_hash,
    );
    expect(hashAgentRegistryEntry(permute(registry) as HashableAgentRegistryEntryV1)).toBe(
      registry.entry_hash,
    );
    expect(hashCompiledContext(permute(context) as HashableCompiledContextV1)).toBe(
      context.document_hash,
    );
  });

  it("rejects bad document and entry hashes", () => {
    const prompt = fixturePrompt();
    const definition = fixtureDefinition(prompt.document_hash);
    const registry = fixtureRegistry(prompt.document_hash, definition.document_hash);
    const context = fixtureContext(prompt.document_hash, definition.document_hash);
    expect(parsePromptTemplate(JSON.stringify({ ...prompt, document_hash: ZERO_HASH })).ok).toBe(
      false,
    );
    expect(
      parseAgentDefinition(JSON.stringify({ ...definition, document_hash: ZERO_HASH })).ok,
    ).toBe(false);
    expect(parseAgentRegistryEntry(JSON.stringify({ ...registry, entry_hash: ZERO_HASH })).ok).toBe(
      false,
    );
    expect(parseCompiledContext(JSON.stringify({ ...context, document_hash: ZERO_HASH })).ok).toBe(
      false,
    );
  });

  it("reports fixed safe failures for syntactically valid byte and member limit overflows", () => {
    const overBytes = JSON.stringify({
      protocol_version: "runtime-contract.v1",
      schema_version: "prompt-template.v1",
      document_type: "prompt-template",
      template_id: TEMPLATE_ID,
      revision: 1,
      instruction_blocks: Array.from({ length: 33 }, (_, index) => ({
        block_id: `block-${String(index).padStart(4, "0")}`,
        content: "x".repeat(65_536),
      })),
      document_hash: ZERO_HASH,
    });
    const overMembers = `{${Array.from(
      { length: 100_001 },
      (_, index) => `"member-${index}":0`,
    ).join(",")}}`;
    expect(Buffer.byteLength(overBytes, "utf8")).toBeGreaterThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(overMembers, "utf8")).toBeLessThan(2 * 1024 * 1024);
    for (const parse of [
      parsePromptTemplate,
      parseAgentDefinition,
      parseAgentRegistryEntry,
      parseCompiledContext,
    ]) {
      expect(parse(overBytes)).toEqual({
        ok: false,
        code: "RUNTIME_DOCUMENT_INVALID",
        issues: [{ path: "", keyword: "maxBytes", message: "agent document exceeds byte limit" }],
      });
      expect(parse(overMembers)).toEqual({
        ok: false,
        code: "RUNTIME_DOCUMENT_INVALID",
        issues: [
          { path: "", keyword: "maxMembers", message: "agent document exceeds member limit" },
        ],
      });
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
          ...resignedDefinition({
            ...definition,
            model: { ...definition.model, allowed_capabilities: ["text", "json-schema"] },
          }),
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseAgentDefinition(
        JSON.stringify({
          ...resignedDefinition({
            ...definition,
            task_contracts: [...definition.task_contracts, definition.task_contracts[0]!],
          }),
        }),
      ).ok,
    ).toBe(false);
  });

  it("rejects a hash-valid context without all fixed trusted segments", () => {
    const prompt = fixturePrompt();
    const definition = fixtureDefinition(prompt.document_hash);
    const context = fixtureContext(prompt.document_hash, definition.document_hash);
    const missing = resignedContext({
      ...context,
      segments: [context.segments[0]!],
    });

    expect(parseCompiledContext(JSON.stringify(missing)).ok).toBe(false);
  });

  it("rejects a hash-valid context that relabels input content as trusted", () => {
    const prompt = fixturePrompt();
    const definition = fixtureDefinition(prompt.document_hash);
    const context = fixtureContext(prompt.document_hash, definition.document_hash);
    const relabeled = resignedContext({
      ...context,
      segments: context.segments.map((entry) =>
        entry.kind === "input-artifact" ? { ...entry, trust: "trusted-control" } : entry,
      ),
    });

    expect(parseCompiledContext(JSON.stringify(relabeled)).ok).toBe(false);
  });

  it("rejects hash-valid contexts whose trusted segment sources differ from top-level bindings", () => {
    const prompt = fixturePrompt();
    const definition = fixtureDefinition(prompt.document_hash);
    const context = fixtureContext(prompt.document_hash, definition.document_hash);
    for (const kind of ["task-contract", "prompt-template", "output-schema"] as const) {
      const mismatched = resignedContext({
        ...context,
        segments: context.segments.map((entry) =>
          entry.kind === kind
            ? {
                ...entry,
                source: ref(entry.source.document_type, `other-${kind}`, 1, entry.original_hash),
              }
            : entry,
        ),
      });
      expect(parseCompiledContext(JSON.stringify(mismatched)).ok).toBe(false);
    }
  });

  it("rejects hash-valid contexts with invalid runtime source, MCP profile, or segment precedence", () => {
    const prompt = fixturePrompt();
    const definition = fixtureDefinition(prompt.document_hash);
    const context = fixtureContext(prompt.document_hash, definition.document_hash);
    const runtimeSource = resignedContext({
      ...context,
      segments: context.segments.map((entry) =>
        entry.kind === "runtime-safety"
          ? { ...entry, source: ref("source-artifact", "unsafe-runtime", 1, entry.original_hash) }
          : entry,
      ),
    });
    const wrongMcp = resignedContext({
      ...context,
      authority: {
        ...context.authority,
        mcp_profile: ref("source-artifact", "not-an-mcp-profile", 1, MCP_HASH),
      },
    });
    const reordered = resignedContext({
      ...context,
      segments: [context.segments[1]!, context.segments[0]!, ...context.segments.slice(2)],
    });

    expect(parseCompiledContext(JSON.stringify(runtimeSource)).ok).toBe(false);
    expect(parseCompiledContext(JSON.stringify(wrongMcp)).ok).toBe(false);
    expect(parseCompiledContext(JSON.stringify(reordered)).ok).toBe(false);
  });

  it("rejects a hash-valid context with unbound source or included content hashes", () => {
    const prompt = fixturePrompt();
    const definition = fixtureDefinition(prompt.document_hash);
    const context = fixtureContext(prompt.document_hash, definition.document_hash);
    const sourceMismatch = resignedContext({
      ...context,
      segments: context.segments.map((entry) =>
        entry.kind === "input-artifact" ? { ...entry, original_hash: ZERO_HASH } : entry,
      ),
    });
    const contentMismatch = resignedContext({
      ...context,
      segments: context.segments.map((entry) =>
        entry.kind === "input-artifact" ? { ...entry, included_hash: ZERO_HASH } : entry,
      ),
    });

    expect(parseCompiledContext(JSON.stringify(sourceMismatch)).ok).toBe(false);
    expect(parseCompiledContext(JSON.stringify(contentMismatch)).ok).toBe(false);
  });

  it("rejects a hash-valid shortened input without its exact truncation record", () => {
    const prompt = fixturePrompt();
    const definition = fixtureDefinition(prompt.document_hash);
    const context = fixtureContext(prompt.document_hash, definition.document_hash);
    const shortened = resignedContext({
      ...context,
      segments: context.segments.map((entry) =>
        entry.kind === "input-artifact"
          ? {
              ...entry,
              content: "untrusted",
              included_bytes: 9,
              tokens: 9,
              original_bytes: 24,
              included_hash: sha256("untrusted"),
            }
          : entry,
      ),
    });

    expect(parseCompiledContext(JSON.stringify(shortened)).ok).toBe(false);
  });

  it("accepts one exact truncation record and rejects duplicate or unrelated records", () => {
    const prompt = fixturePrompt();
    const definition = fixtureDefinition(prompt.document_hash);
    const context = fixtureContext(prompt.document_hash, definition.document_hash);
    const input = context.segments.find((entry) => entry.kind === "input-artifact");
    if (input === undefined || input.source === null) throw new Error("input fixture is invalid");
    const shortened = resignedContext({
      ...context,
      segments: context.segments.map((entry) =>
        entry.kind === "input-artifact"
          ? {
              ...entry,
              content: "untrusted",
              included_bytes: 9,
              tokens: 9,
              original_bytes: 24,
              included_hash: sha256("untrusted"),
            }
          : entry,
      ),
      truncations: [
        {
          source: input.source,
          reason: "input-budget",
          original_bytes: 24,
          included_bytes: 9,
        },
      ],
    });
    const duplicate = resignedContext({
      ...shortened,
      truncations: [...shortened.truncations, shortened.truncations[0]!],
    });
    const unrelated = resignedContext({
      ...shortened,
      truncations: [
        {
          source: ref("source-artifact", "unrelated-source", 1, INPUT_HASH),
          reason: "input-budget",
          original_bytes: 24,
          included_bytes: 9,
        },
      ],
    });

    expect(parseCompiledContext(JSON.stringify(shortened)).ok).toBe(true);
    expect(parseCompiledContext(JSON.stringify(duplicate)).ok).toBe(false);
    expect(parseCompiledContext(JSON.stringify(unrelated)).ok).toBe(false);
  });

  it("rejects hash-valid unsorted authority sets and noncanonical operation UUID aliases", () => {
    const prompt = fixturePrompt();
    const definition = fixtureDefinition(prompt.document_hash);
    const context = fixtureContext(prompt.document_hash, definition.document_hash);
    const registry = fixtureRegistry(prompt.document_hash, definition.document_hash);
    const unsorted = resignedContext({
      ...context,
      authority: { ...context.authority, model_capabilities: ["text", "json-schema"] },
    });
    const duplicate = resignedContext({
      ...context,
      authority: {
        ...context.authority,
        superpowers: ["test-driven-development", "test-driven-development"],
      },
    });
    const uppercase = resignedRegistry({
      ...registry,
      operation_id: registry.operation_id.toUpperCase(),
    });
    const urn = resignedRegistry({
      ...registry,
      operation_id: `urn:uuid:${registry.operation_id}`,
    });

    expect(parseCompiledContext(JSON.stringify(unsorted)).ok).toBe(false);
    expect(parseCompiledContext(JSON.stringify(duplicate)).ok).toBe(false);
    expect(parseAgentRegistryEntry(JSON.stringify(uppercase)).ok).toBe(false);
    expect(parseAgentRegistryEntry(JSON.stringify(urn)).ok).toBe(false);
  });
});
