import type { ArtifactReference, RuntimeDocument } from "../protocol/types.js";
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

export type TaskPhase = "analysis" | "implementation" | "review";
export type TaskComplexity = "low" | "medium" | "high" | "critical";
export type TaskRisk = "architecture" | "irreversible" | "security";

export interface RoutingTaskProfile {
  readonly task_contract: ArtifactReference;
  readonly phase: TaskPhase;
  readonly complexity: TaskComplexity;
  readonly risks: readonly TaskRisk[];
  readonly max_latency_class: LatencyClass;
}

export interface RoutingCallCeilings {
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly max_duration_ms: number;
}

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

export interface RoutingPolicyRuleV1 {
  readonly rule_id: string;
  readonly priority: number;
  readonly match: Readonly<{
    phase: TaskPhase | "*";
    complexity: TaskComplexity | "*";
    risks: readonly TaskRisk[] | "*";
  }>;
  readonly worker_class_preference: readonly LogicalModelClass[];
  readonly required_capabilities: readonly RoutingCapabilityName[];
  readonly max_latency_class: LatencyClass;
  readonly review: "none" | "independent";
  readonly max_fallbacks: number;
  readonly circuit: Readonly<{
    consecutive_failure_threshold: number;
    cooldown_ms: number;
  }>;
}

export interface RoutingPolicyV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "routing-policy.v1";
  readonly document_type: "routing-policy";
  readonly policy_id: string;
  readonly revision: number;
  readonly rules: readonly RoutingPolicyRuleV1[];
  readonly document_hash: `sha256:${string}`;
}

export interface RoutingOverrideFragmentV1 {
  readonly version: "routing-override.v1";
  readonly override_id: string;
  readonly issued_at: string;
  readonly catalog_hash: `sha256:${string}`;
  readonly policy_hash: `sha256:${string}`;
  readonly target_entry_id: string;
  readonly reason_code:
    "capacity-control" | "cost-control" | "incident-mitigation" | "latency-control";
}

export interface GovernedRoutingOverride {
  readonly artifact: ArtifactReference & Readonly<{ document_type: "routing-override" }>;
  readonly value: RoutingOverrideFragmentV1;
}
