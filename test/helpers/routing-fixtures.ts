import { canonicalJson, sha256 } from "../../src/protocol/json.js";
import type { ProviderAdapterCapabilities, ProviderKind } from "../../src/providers/types.js";

export function providerCapabilities(provider: ProviderKind): ProviderAdapterCapabilities {
  return {
    provider,
    tools: true,
    json_schema: true,
    vision: false,
    reasoning: true,
    streaming: true,
    max_context_tokens: 200_000,
    max_output_tokens: 16_384,
  };
}

export function pricing(
  input: number,
  cachedInput: number,
  output: number,
  reasoningOutput: number,
) {
  return {
    input_microusd_per_million: input,
    cached_input_microusd_per_million: cachedInput,
    output_microusd_per_million: output,
    reasoning_output_microusd_per_million: reasoningOutput,
  };
}

export function catalogDocumentHash(value: Record<string, unknown>): `sha256:${string}` {
  const { document_hash: _documentHash, ...hashable } = value;
  return sha256(hashable);
}

export function catalogBytes(value: Record<string, unknown>): string {
  return canonicalJson({ ...value, document_hash: catalogDocumentHash(value) });
}

export function policyDocumentHash(value: Record<string, unknown>): `sha256:${string}` {
  const { document_hash: _documentHash, ...hashable } = value;
  return sha256(hashable);
}

export function policyBytes(value: Record<string, unknown>): string {
  return canonicalJson({ ...value, document_hash: policyDocumentHash(value) });
}

export function overrideValueHash(value: Record<string, unknown>): `sha256:${string}` {
  return sha256(value);
}

export function validCatalog(): Record<string, unknown> {
  return {
    protocol_version: "runtime-contract.v1",
    schema_version: "model-catalog.v1",
    document_type: "model-catalog",
    catalog_id: "catalog-production",
    revision: 7,
    entries: [
      {
        entry_id: "balanced-primary",
        logical_classes: ["balanced-code", "economy"],
        route_alias: "balanced-code",
        priority: 10,
        routes: [
          {
            route_id: "balanced-anthropic",
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            capabilities: providerCapabilities("anthropic"),
            latency_class: "standard",
            pricing: pricing(3_000_000, 300_000, 15_000_000, 15_000_000),
          },
          {
            route_id: "balanced-openai",
            provider: "openai",
            model: "gpt-5",
            capabilities: providerCapabilities("openai"),
            latency_class: "standard",
            pricing: pricing(2_000_000, 200_000, 10_000_000, 12_000_000),
          },
        ],
      },
    ],
  };
}

export function validRoutingPolicy(): Record<string, unknown> {
  return {
    protocol_version: "runtime-contract.v1",
    schema_version: "routing-policy.v1",
    document_type: "routing-policy",
    policy_id: "routing-production",
    revision: 3,
    rules: [
      {
        rule_id: "non-risk-default",
        priority: 10,
        match: { phase: "*", complexity: "*", risks: [] },
        worker_class_preference: ["balanced-code", "economy"],
        required_capabilities: ["json-schema", "text"],
        max_latency_class: "standard",
        review: "none",
        max_fallbacks: 2,
        circuit: { consecutive_failure_threshold: 3, cooldown_ms: 60_000 },
      },
      {
        rule_id: "security-review",
        priority: 5,
        match: { phase: "implementation", complexity: "high", risks: ["security"] },
        worker_class_preference: ["deep-reasoning"],
        required_capabilities: ["reasoning", "tools"],
        max_latency_class: "extended",
        review: "independent",
        max_fallbacks: 1,
        circuit: { consecutive_failure_threshold: 2, cooldown_ms: 120_000 },
      },
      {
        rule_id: "risk-default",
        priority: 20,
        match: { phase: "*", complexity: "*", risks: "*" },
        worker_class_preference: ["deep-reasoning", "balanced-code"],
        required_capabilities: ["reasoning"],
        max_latency_class: "extended",
        review: "independent",
        max_fallbacks: 3,
        circuit: { consecutive_failure_threshold: 3, cooldown_ms: 60_000 },
      },
    ],
  };
}

export function validRoutingOverride(): Record<string, unknown> {
  return {
    version: "routing-override.v1",
    override_id: "override-incident-1",
    issued_at: "2026-08-21T12:00:00.000Z",
    catalog_hash: `sha256:${"a".repeat(64)}`,
    policy_hash: `sha256:${"b".repeat(64)}`,
    target_entry_id: "balanced-primary",
    reason_code: "incident-mitigation",
  };
}
