import type { RuntimeDocument } from "../protocol/types.js";
import type { ProviderAdapterCapabilities, ProviderKind } from "../providers/types.js";

export type LogicalModelClass =
  "economy" | "balanced-code" | "deep-reasoning" | "long-context" | "vision" | "independent-review";

export type RoutingCapabilityName =
  | "independent-review"
  | "json-schema"
  | "long-context"
  | "reasoning"
  | "streaming"
  | "text"
  | "tools"
  | "vision";

export type LatencyClass = "interactive" | "standard" | "extended";

export interface CatalogPricingV1 {
  readonly input_microusd_per_million: number;
  readonly cached_input_microusd_per_million: number;
  readonly output_microusd_per_million: number;
  readonly reasoning_output_microusd_per_million: number;
}

export interface CatalogRouteV1 {
  readonly route_id: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly latency_class: LatencyClass;
  readonly pricing: CatalogPricingV1;
}

export interface ModelCatalogEntryV1 {
  readonly entry_id: string;
  readonly logical_classes: readonly LogicalModelClass[];
  readonly route_alias: string;
  readonly priority: number;
  readonly routes: readonly CatalogRouteV1[];
}

export interface ModelCatalogV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "model-catalog.v1";
  readonly document_type: "model-catalog";
  readonly catalog_id: string;
  readonly revision: number;
  readonly entries: readonly ModelCatalogEntryV1[];
  readonly document_hash: `sha256:${string}`;
}
