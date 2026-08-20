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
