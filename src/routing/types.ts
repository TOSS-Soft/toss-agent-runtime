import type {
  ArtifactReference,
  RuntimeBudget,
  RuntimeDocument,
  UsageSummary,
} from "../protocol/types.js";
import type {
  ProviderAdapterCapabilities,
  ProviderKind,
  ProviderRouteIdentity,
  ProviderRouteRequirement,
  ProviderUsage,
} from "../providers/types.js";

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

export interface RoutingReservationV1 {
  readonly decision_id: string;
  readonly decision_hash: `sha256:${string}`;
  readonly request_id: string;
  readonly allocations: readonly Readonly<{
    attempt_id: string;
    entry_id: string;
    role: "reviewer" | "worker";
    input_tokens: number;
    output_tokens: number;
    cost_microusd: number;
    duration_ms: number;
    turns: 1;
  }>[];
  readonly created_at: string;
}

export type RoutingCircuitV1 =
  | Readonly<{
      entry_id: string;
      status: "closed";
      consecutive_failures: number;
      retry_at: null;
      probe_decision_id: null;
    }>
  | Readonly<{
      entry_id: string;
      status: "open";
      consecutive_failures: number;
      retry_at: string;
      probe_decision_id: null;
    }>
  | Readonly<{
      entry_id: string;
      status: "probe-reserved";
      consecutive_failures: number;
      retry_at: string;
      probe_decision_id: string;
    }>;

export interface RoutingStateV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "routing-state.v1";
  readonly document_type: "routing-state";
  readonly state_id: string;
  readonly revision: number;
  readonly previous_state_hash: `sha256:${string}` | null;
  readonly run_id: string;
  readonly request_hash: `sha256:${string}`;
  readonly catalog_hash: `sha256:${string}`;
  readonly policy_hash: `sha256:${string}`;
  readonly budget: RuntimeBudget;
  readonly settled: UsageSummary;
  readonly budget_status: "known" | "unknown";
  readonly reservations: readonly RoutingReservationV1[];
  readonly circuits: readonly RoutingCircuitV1[];
  readonly document_hash: `sha256:${string}`;
}

export interface RoutingAcceptedRouteV1 {
  readonly route_id: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly pricing: CatalogPricingV1;
}

export interface RoutingAttemptV1 {
  readonly attempt_id: string;
  readonly role: "reviewer" | "worker";
  readonly fallback_index: number | null;
  readonly entry_id: string;
  readonly alias: string;
  readonly gateway_profile: string;
  readonly gateway_revision: number;
  readonly capability_document_hash: `sha256:${string}`;
  readonly latency_class: LatencyClass;
  readonly requirement: ProviderRouteRequirement;
  readonly requirement_hash: `sha256:${string}`;
  readonly accepted_routes: readonly RoutingAcceptedRouteV1[];
  readonly reserved_cost_microusd: number;
}

export interface RoutingEliminationV1 {
  readonly entry_id: string;
  readonly reason:
    | "capability"
    | "circuit"
    | "latency"
    | "live-route"
    | "override"
    | "policy"
    | "review-independence"
    | "budget";
}

interface ModelSelectionPlanBindingV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "model-selection-plan.v1";
  readonly document_type: "model-selection-plan";
  readonly decision_id: string;
  readonly revision: 1;
  readonly run_id: string;
  readonly request_id: string;
  readonly request_hash: `sha256:${string}`;
  readonly task_contract: ArtifactReference & Readonly<{ document_type: "task-contract" }>;
  readonly catalog_id: string;
  readonly catalog_revision: number;
  readonly catalog_hash: `sha256:${string}`;
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly policy_hash: `sha256:${string}`;
  readonly prior_state_id: string;
  readonly prior_state_revision: number;
  readonly prior_state_hash: `sha256:${string}`;
  readonly gateway_profile: string;
  readonly gateway_revision: number;
  readonly capability_document_hash: `sha256:${string}`;
  readonly override: (ArtifactReference & Readonly<{ document_type: "routing-override" }>) | null;
  readonly decision_at: string;
  readonly matched_rule_id: string;
  readonly eliminations: readonly RoutingEliminationV1[];
  readonly document_hash: `sha256:${string}`;
}

export interface PlannedModelSelectionPlanV1 extends ModelSelectionPlanBindingV1 {
  readonly status: "planned";
  readonly worker_attempts: readonly RoutingAttemptV1[];
  readonly reviewer_attempt: RoutingAttemptV1 | null;
  readonly reservation: RoutingReservationV1;
  readonly next_state_revision: number;
  readonly next_state_hash: `sha256:${string}`;
}

export type RoutingBlockCode =
  | "RUNTIME_ROUTING_BUDGET_EXCEEDED"
  | "RUNTIME_ROUTING_CIRCUIT_OPEN"
  | "RUNTIME_ROUTING_NO_CAPABLE_ROUTE"
  | "RUNTIME_ROUTING_POLICY_DENIED"
  | "RUNTIME_ROUTING_REVIEW_UNAVAILABLE"
  | "RUNTIME_ROUTING_STALE_STATE"
  | "RUNTIME_ROUTING_USAGE_UNKNOWN";

export interface BlockedModelSelectionPlanV1 extends ModelSelectionPlanBindingV1 {
  readonly status: "blocked";
  readonly block_code: RoutingBlockCode;
  readonly retryable: boolean;
  readonly next_retry_at: string | null;
}

export type ModelSelectionPlanV1 = PlannedModelSelectionPlanV1 | BlockedModelSelectionPlanV1;

export interface RoutingAttemptResult {
  readonly attempt_id: string;
  readonly route_identity: ProviderRouteIdentity | null;
  readonly usage: ProviderUsage | null;
  readonly duration_ms: number;
  readonly effect_may_have_occurred: boolean;
}
