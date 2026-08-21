# Governed Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the pure, deterministic Issue #6 model catalog, task router,
budget, circuit/fallback, independent-review planning, and exact route
verification surface for the macOS-only v1.0.0 runtime.

**Architecture:** Four closed, hash-bound protocol documents feed a pure
`src/routing/` core. Parsing and semantic validation establish immutable
catalog, policy, state, and plan values; selection intersects those governed
inputs with a fresh agentgateway capability document, reserves worst-case
integer-microusd budget, and returns a canonical plan plus the exact next state.
Separate pure modules settle usage, advance circuit state, expose only
preplanned fallbacks, and bind agentgateway route attestation to one attempt.

**Tech Stack:** TypeScript 6, Node.js 22.23.1 and 24, JSON Schema 2020-12,
Ajv 8, Vitest 4, existing canonical JSON/SHA-256 protocol helpers.

**Spec:**
`docs/superpowers/specs/2026-08-21-governed-model-routing-design.md`

## Global Constraints

- The supported v1.0.0 release platform is macOS only; CI runs Node 22.23.1
  and Node 24 on `macos-latest`.
- Add no runtime or development dependency.
- The routing core performs no filesystem, clock, environment, network,
  provider, gateway, journal, or retry side effect.
- Catalog and state documents are at most 2 MiB; policy is at most 512 KiB;
  selection plans are at most 2 MiB.
- Catalogs contain at most 1,024 entries, policies at most 256 rules, and live
  agentgateway documents at most 256 routes.
- Every decision-affecting value, including canonical decision time, is an
  explicit input. No process-local budget, circuit, cache, or score exists.
- Money is nonnegative integer microusd. All multiplication and division use
  `bigint`, round upward per priced component, and reject unsafe results.
- The control plane owns catalog, policy, task classification, and override
  authority. Prompt, model, provider, gateway, and repository content cannot
  create or widen them.
- Only timeout, transient provider failure, and gateway-unavailable outcomes
  advance circuit state or authorize fallback.
- Security, architecture, and irreversible tasks require an
  `independent-review` entry whose every provider/model pair differs from
  every accepted worker route.
- Every parser returns the existing closed `ValidationResult<T>` shape; every
  operational routing error contains only a stable code, category,
  retryability, and fixed safe message.
- Implement every behavior through a witnessed RED -> GREEN cycle and make a
  focused commit after each task.

---

### Task 1: Closed catalog contract and shared routing vocabulary

**Files:**

- Create: `contracts/runtime/model-catalog.v1.schema.json`
- Create: `src/routing/types.ts`
- Create: `src/routing/errors.ts`
- Create: `src/routing/contracts.ts`
- Create: `test/helpers/routing-fixtures.ts`
- Create: `test/routing-contracts.test.ts`
- Modify: `src/protocol/validator.ts`

**Interfaces:**

- Consumes: `RuntimeDocument`, `ValidationResult`, `ArtifactReference`,
  `RuntimeBudget`, `AgentgatewayCapabilitiesV1`,
  `ProviderAdapterCapabilities`, `ProviderKind`, `canonicalJson`, `sha256`, and
  `parseJsonBytes` from existing public protocol/provider/gateway modules.
- Produces:
  `LogicalModelClass`, `RoutingCapabilityName`, `LatencyClass`,
  `CatalogPricingV1`, `CatalogRouteV1`, `ModelCatalogEntryV1`,
  `ModelCatalogV1`, `RuntimeRoutingErrorCode`, `RuntimeRoutingError`,
  `parseModelCatalog()`, and `hashModelCatalog()`.

- [ ] **Step 1: Write the catalog contract tests**

  Add fixtures that build canonical catalog bytes by hashing the object with
  `document_hash` omitted. Cover one entry with two exact gateway routes and
  the six fixed classes. Add RED assertions for deep freeze, canonical hash,
  duplicate entry IDs, duplicate global route IDs, duplicate class
  requirements, mismatched `route_alias`, mismatched capability provider,
  missing/unsafe price fields, unknown fields, duplicate JSON keys, 1,025
  entries, and a 2 MiB + 1 input.

  The first valid fixture must use this shape:

  ```ts
  const catalog = {
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
  ```

- [ ] **Step 2: Run the catalog test to verify RED**

  Run: `npx vitest run test/routing-contracts.test.ts`

  Expected: FAIL because `src/routing/contracts.ts` and the catalog schema do
  not exist.

- [ ] **Step 3: Define the shared immutable catalog types and stable errors**

  In `src/routing/types.ts`, define the exact closed vocabulary:

  ```ts
  export type LogicalModelClass =
    | "economy"
    | "balanced-code"
    | "deep-reasoning"
    | "long-context"
    | "vision"
    | "independent-review";

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
  ```

  In `src/routing/errors.ts`, define fixed safe details for:
  `RUNTIME_ROUTING_INVALID`, `RUNTIME_ROUTING_BUDGET_EXCEEDED`,
  `RUNTIME_ROUTING_NO_CAPABLE_ROUTE`, `RUNTIME_ROUTING_REVIEW_UNAVAILABLE`,
  `RUNTIME_ROUTING_POLICY_DENIED`, `RUNTIME_ROUTING_CIRCUIT_OPEN`,
  `RUNTIME_ROUTING_STALE_STATE`, `RUNTIME_ROUTING_USAGE_UNKNOWN`, and
  `RUNTIME_ROUTING_RESOLUTION_MISMATCH`. Only `CIRCUIT_OPEN` is retryable;
  `STALE_STATE` uses `stale-revision`, resolution mismatch uses `integrity`,
  unknown usage uses `integrity`, no-route/review use
  `unsupported-capability`, budget/policy use `policy-denied`, and invalid uses
  `invalid-input`.

- [ ] **Step 4: Add and register the closed catalog schema**

  The root schema must require exactly:

  ```json
  [
    "protocol_version",
    "schema_version",
    "document_type",
    "catalog_id",
    "revision",
    "entries",
    "document_hash"
  ]
  ```

  Use the common identifier/SHA-256 definitions, `revision` in
  `1..9007199254740991`, `entries` in `1..1024`, classes from the fixed enum,
  route/provider/model constraints equal to the existing agentgateway schema,
  four required nonnegative safe-integer prices, and `additionalProperties:
false` at every object level. Register the schema import and schema-version
  ID in `src/protocol/validator.ts`.

- [ ] **Step 5: Implement bounded parse, hash, and catalog semantics**

  In `src/routing/contracts.ts`, use a 2 MiB/32-depth/100,000-member limit.
  Implement:

  ```ts
  export function hashModelCatalog(value: ModelCatalogV1): `sha256:${string}`;
  export function parseModelCatalog(input: string | Uint8Array): ValidationResult<ModelCatalogV1>;
  ```

  `hashModelCatalog()` canonicalizes the value, omits `document_hash`, and
  hashes the remainder. `parseModelCatalog()` parses with explicit bounds,
  delegates the root schema to `createProtocolValidator()`, then rejects:
  noncanonical hash, duplicate classes, duplicate entry/route IDs, and a route
  whose `capabilities.provider` differs from `provider`. Semantically unordered
  entry, class, and route arrays may arrive in any order; the exact document
  hash binds that order and selection later sorts copies without mutation. The
  entry's single `route_alias` is applied during live intersection; route
  objects deliberately do not carry a second alias.

- [ ] **Step 6: Run focused tests and typecheck**

  Run:

  ```bash
  npx vitest run test/routing-contracts.test.ts
  npm run typecheck
  ```

  Expected: all catalog tests pass; TypeScript reports no diagnostics.

- [ ] **Step 7: Commit the catalog boundary**

  ```bash
  git add contracts/runtime/model-catalog.v1.schema.json src/protocol/validator.ts src/routing/types.ts src/routing/errors.ts src/routing/contracts.ts test/helpers/routing-fixtures.ts test/routing-contracts.test.ts
  git commit -m "feat: add governed model catalog contract"
  ```

### Task 2: Routing policy, task profile, and governed override contract

**Files:**

- Create: `contracts/runtime/routing-policy.v1.schema.json`
- Modify: `src/routing/types.ts`
- Modify: `src/routing/contracts.ts`
- Modify: `src/protocol/validator.ts`
- Modify: `test/helpers/routing-fixtures.ts`
- Modify: `test/routing-contracts.test.ts`

**Interfaces:**

- Consumes: catalog vocabulary from Task 1 and existing `ArtifactReference`.
- Produces: `TaskPhase`, `TaskComplexity`, `TaskRisk`, `RoutingTaskProfile`,
  `RoutingCallCeilings`, `RoutingPolicyRuleV1`, `RoutingPolicyV1`,
  `RoutingOverrideFragmentV1`, `GovernedRoutingOverride`,
  `parseRoutingPolicy()`, `hashRoutingPolicy()`, and
  `parseGovernedRoutingOverride()`.

- [ ] **Step 1: Add RED policy and override tests**

  Test one catch-all plus higher-priority exact rules; all 96 combinations of
  three phases, four complexities, and eight risk subsets must match at least
  one rule. Add RED cases for duplicate IDs and same-priority overlap while
  keeping disjoint same-priority rules valid; also cover missing/multiple
  catch-all, a risk profile that can match a no-review rule,
  duplicate preference/capability/risk values, unsupported class,
  excessive fallback, unsafe circuit values, stale override hashes, target
  entry absent, artifact hash mismatch, and an override reason outside the
  fixed allowlist.

  The closed rule shape is:

  ```ts
  interface RoutingPolicyRuleV1 {
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
  ```

- [ ] **Step 2: Run focused tests to verify RED**

  Run: `npx vitest run test/routing-contracts.test.ts -t 'routing policy|override'`

  Expected: FAIL because policy functions and schema are missing.

- [ ] **Step 3: Define exact task, policy, and override types**

  Add:

  ```ts
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
  ```

- [ ] **Step 4: Add the closed policy schema and override `$defs` fragment**

  Require the seven policy document fields, `rules` in `1..256`, exact enums,
  safe integer limits, unique arrays, `max_fallbacks` in `0..15`, circuit
  threshold in `1..100`, and cooldown in `1..86400000`. Define
  `$defs/routing_override` with the exact fragment fields above; it is not a
  fifth protocol document or advertised schema version. Register only the
  `routing-policy.v1` root with `createProtocolValidator()`.

- [ ] **Step 5: Implement policy and override semantic validation**

  Add:

  ```ts
  export function hashRoutingPolicy(value: RoutingPolicyV1): `sha256:${string}`;
  export function parseRoutingPolicy(input: string | Uint8Array): ValidationResult<RoutingPolicyV1>;
  export function parseGovernedRoutingOverride(input: {
    readonly artifact: ArtifactReference;
    readonly value: unknown;
  }): ValidationResult<GovernedRoutingOverride>;
  ```

  Expand every finite phase/complexity/risk-set combination. A rule matches
  exact scalar values or `"*"`; an array risk matcher equals the complete
  sorted task risk set. Reject a combination with no matching rule or more
  than one winning rule at the same minimum priority. Require exactly one
  all-wildcard catch-all. Require every nonempty-risk combination's winning
  rule to specify `review: "independent"`; the reviewer class is the fixed
  `independent-review` class and is not inferred from worker preferences.
  Validate canonical UTC override time and require
  `sha256(value) === artifact.hash`.

- [ ] **Step 6: Run focused tests and commit**

  Run:

  ```bash
  npx vitest run test/routing-contracts.test.ts
  npm run typecheck
  ```

  Expected: catalog, policy, and override cases pass.

  Commit:

  ```bash
  git add contracts/runtime/routing-policy.v1.schema.json src/protocol/validator.ts src/routing/types.ts src/routing/contracts.ts test/helpers/routing-fixtures.ts test/routing-contracts.test.ts
  git commit -m "feat: add governed routing policy contract"
  ```

### Task 3: Routing state and canonical selection-plan contracts

**Files:**

- Create: `contracts/runtime/routing-state.v1.schema.json`
- Create: `contracts/runtime/model-selection-plan.v1.schema.json`
- Modify: `src/routing/types.ts`
- Modify: `src/routing/contracts.ts`
- Modify: `src/protocol/validator.ts`
- Modify: `test/helpers/routing-fixtures.ts`
- Modify: `test/routing-contracts.test.ts`

**Interfaces:**

- Consumes: Task 1/2 types, `RuntimeBudget`, `UsageSummary`,
  `ProviderRouteRequirement`, and `ProviderRouteIdentity`.
- Produces: `RoutingReservationV1`, `RoutingCircuitV1`, `RoutingStateV1`,
  `RoutingAcceptedRouteV1`, `RoutingAttemptV1`, `RoutingEliminationV1`,
  `PlannedModelSelectionPlanV1`, `BlockedModelSelectionPlanV1`,
  `ModelSelectionPlanV1`, plus state/plan parse and hash functions.

- [ ] **Step 1: Add RED state/plan schema and invariant tests**

  Cover valid empty state, each circuit variant, one combined reservation,
  planned and blocked plans, deep freeze, hash mismatch, wrong prior hash,
  duplicate reservation/entry/attempt IDs, invalid closed/open/probe field
  combinations, unknown budget with active reservations, plan attempt order,
  blocked plan carrying executable attempts, planned plan lacking next state,
  unsafe elimination text/metadata, 2 MiB + 1 input, and cyclic-hash avoidance.

- [ ] **Step 2: Run the new tests to verify RED**

  Run: `npx vitest run test/routing-contracts.test.ts -t 'routing state|selection plan'`

  Expected: FAIL because state/plan schemas and parsers do not exist.

- [ ] **Step 3: Add the immutable state and plan types**

  Use these acyclic bindings:

  ```ts
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
  ```

  Define the accepted-route and attempt snapshots exactly:

  ```ts
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
  ```

  `RoutingEliminationV1` contains only entry ID and one enum reason:
  `capability`, `circuit`, `latency`, `live-route`, `override`, `policy`,
  `review-independence`, or `budget`.

  `ModelSelectionPlanV1` is a discriminated union. Both variants carry exact
  request/task/catalog/policy/prior-state/live/override bindings, decision
  time, matched rule, eliminations, revision `1`, and `document_hash`.
  Planned adds worker attempts, nullable reviewer, reservation, and exact next
  state revision/hash. Blocked adds one stable block code, `retryable`, and
  nullable `next_retry_at`; it contains no attempts, reservation, or next
  state. Export the discriminant aliases explicitly:

  ```ts
  export type ModelSelectionPlanV1 = PlannedModelSelectionPlanV1 | BlockedModelSelectionPlanV1;
  ```

- [ ] **Step 4: Add and register the two closed schemas**

  Encode the union invariants with root `$defs` and `oneOf`. All arrays are
  bounded: 16 worker attempts, 1,024 eliminations, 1,024 circuits, and 1,024
  reservations. Provider/model/route identities use the same patterns and
  provider enum as the gateway contract. Stable block codes are exactly:

  ```text
  RUNTIME_ROUTING_BUDGET_EXCEEDED
  RUNTIME_ROUTING_CIRCUIT_OPEN
  RUNTIME_ROUTING_NO_CAPABLE_ROUTE
  RUNTIME_ROUTING_POLICY_DENIED
  RUNTIME_ROUTING_REVIEW_UNAVAILABLE
  RUNTIME_ROUTING_STALE_STATE
  RUNTIME_ROUTING_USAGE_UNKNOWN
  ```

  Register both schema versions with `createProtocolValidator()`.

- [ ] **Step 5: Implement bounded hash/parse semantics**

  Add:

  ```ts
  export function hashRoutingState(value: RoutingStateV1): `sha256:${string}`;
  export function parseRoutingState(input: string | Uint8Array): ValidationResult<RoutingStateV1>;
  export function hashModelSelectionPlan(value: ModelSelectionPlanV1): `sha256:${string}`;
  export function parseModelSelectionPlan(
    input: string | Uint8Array,
  ): ValidationResult<ModelSelectionPlanV1>;
  ```

  Validate sorted unique reservations, allocations, circuits, attempts,
  routes, and eliminations,
  exact hash, canonical timestamps, known-cost coherence, closed/open/probe
  field coherence, and planned/blocked exclusivity. A planned reservation's
  `decision_hash` is SHA-256 of the complete planned decision payload with the
  reservation's `decision_hash`, next-state identity, and final
  `document_hash` omitted. The state binds that decision hash; the final plan
  binds the resulting state hash, avoiding a cyclic hash while preventing a
  caller from substituting attempts, prices, requirements, or eliminations.

- [ ] **Step 6: Run contract tests and commit**

  Run:

  ```bash
  npx vitest run test/routing-contracts.test.ts
  npm run typecheck
  ```

  Expected: every four-document contract test passes.

  Commit:

  ```bash
  git add contracts/runtime/routing-state.v1.schema.json contracts/runtime/model-selection-plan.v1.schema.json src/protocol/validator.ts src/routing/types.ts src/routing/contracts.ts test/helpers/routing-fixtures.ts test/routing-contracts.test.ts
  git commit -m "feat: add routing state and plan contracts"
  ```

### Task 4: Exact microusd reservation and settlement

**Files:**

- Create: `src/routing/cost.ts`
- Create: `test/routing-cost.test.ts`
- Modify: `src/routing/types.ts`
- Modify: `test/helpers/routing-fixtures.ts`

**Interfaces:**

- Consumes: catalog pricing, call ceilings, routing reservation/state/plan,
  `ProviderUsage`, and existing budget types.
- Produces: `RoutingAttemptResult`, `calculateRoutingCost()`,
  `estimateRoutingAllocation()`, `reserveRoutingBudget()`, and
  `settleRoutingDecision()`.

- [ ] **Step 1: Write RED cost and budget tests**

  Cover per-component upward rounding, cached input/reasoning subsets, null
  subsets charged at ordinary rates, negative subsets, unsafe multiplication,
  result above safe integer, exact-limit acceptance, one-unit-over rejection,
  input/output/cost/duration/turn limits, primary-plus-fallback-plus-reviewer
  atomic reserve,
  duplicate/stale reservation rejection, exact settlement, post-effect
  overage `FAILED`, missing trusted usage setting `budget_status: "unknown"`,
  and subsequent reservation blocked with `RUNTIME_ROUTING_USAGE_UNKNOWN`.

- [ ] **Step 2: Run cost tests to verify RED**

  Run: `npx vitest run test/routing-cost.test.ts`

  Expected: FAIL because `src/routing/cost.ts` does not exist.

- [ ] **Step 3: Implement exact arithmetic primitives**

  Implement the signatures:

  ```ts
  export function calculateRoutingCost(pricing: CatalogPricingV1, usage: ProviderUsage): number;

  export function estimateRoutingAllocation(input: {
    readonly pricing: CatalogPricingV1;
    readonly ceilings: RoutingCallCeilings;
  }): Readonly<{
    input_tokens: number;
    output_tokens: number;
    cost_microusd: number;
    duration_ms: number;
    turns: 1;
  }>;
  ```

  Use `ceilDiv(tokens * rate, 1_000_000n)` separately for uncached input,
  cached input, ordinary output, and reasoning output. Treat null cached or
  reasoning counts as zero; reject a subset greater than its total. Worst-case
  reservation charges all input at the input rate and all output at the larger
  ordinary/reasoning rate.

- [ ] **Step 4: Implement pure reserve and settle transitions**

  Add:

  ```ts
  export function reserveRoutingBudget(input: {
    readonly state: RoutingStateV1;
    readonly reservation: RoutingReservationV1;
  }): RoutingStateV1;

  export interface RoutingAttemptResult {
    readonly attempt_id: string;
    readonly route_identity: ProviderRouteIdentity | null;
    readonly usage: ProviderUsage | null;
    readonly duration_ms: number;
    readonly effect_may_have_occurred: boolean;
  }

  export function settleRoutingDecision(input: {
    readonly state: RoutingStateV1;
    readonly plan: PlannedModelSelectionPlanV1;
    readonly attempts: readonly RoutingAttemptResult[];
    readonly settled_at: string;
  }): Readonly<{
    status: "SETTLED" | "FAILED";
    state: RoutingStateV1;
  }>;
  ```

  Sum every allocation before reserving against `settled + active
reservations` for every budget dimension, increment state revision/hash
  exactly once, and never mutate the input. Settlement requires the plan's
  exact hash, recomputed decision hash, catalog/policy/run/request bindings,
  its exact reservation on the
  input state, unique attempted allocation IDs, and for every priced attempt
  an attested route in the plan's accepted route set. When the input is the
  initially reserved state its hash must equal `next_state_hash`; a later
  circuit revision is accepted only while retaining those exact bindings and
  reservation. Release unused allocations, price/sum attempted usage, and
  hash a new state. A missing route or usage after a possible effect sets
  unknown; actual overage returns `FAILED` while preserving the over-limit
  settled totals so later calls remain blocked.

- [ ] **Step 5: Run tests and commit**

  Run:

  ```bash
  npx vitest run test/routing-cost.test.ts test/routing-contracts.test.ts
  npm run typecheck
  ```

  Expected: all cost and contract tests pass.

  Commit:

  ```bash
  git add src/routing/cost.ts src/routing/types.ts test/helpers/routing-fixtures.ts test/routing-cost.test.ts
  git commit -m "feat: reserve and settle routing budgets"
  ```

### Task 5: Deterministic worker selection and capability-equivalent fallbacks

**Files:**

- Create: `src/routing/selection.ts`
- Create: `test/routing-selection.test.ts`
- Modify: `src/routing/types.ts`
- Modify: `test/helpers/routing-fixtures.ts`

**Interfaces:**

- Consumes: parsed execution request/catalog/policy/state/live capabilities,
  task profile, call ceilings, explicit decision time/gateway profile, and
  Task 4 budget primitives.
- Produces: `PlanModelSelectionInput`, `RoutingDecision`,
  `planModelSelection()`, deterministic attempt/decision IDs, complete
  eliminations, and the exact reserved next state.

- [ ] **Step 1: Write the worker routing matrix as RED tests**

  Add table tests for phase, complexity, exact risk set, requested class,
  required capabilities, context/output limits, latency, live expiry, provider
  mismatch, absent route, catalog/live capability intersection, open circuit,
  cooldown-expired half-open probe reservation, budget, and stable
  tie-breaking. Rehash permutations of semantically equivalent catalog and
  live-route arrays and assert identical selected entries, attempt order, and
  elimination reasons. Also assert that decision, plan, and next-state hashes
  change to bind the newly rehashed authoritative input.

- [ ] **Step 2: Run selection tests to verify RED**

  Run: `npx vitest run test/routing-selection.test.ts`

  Expected: FAIL because `planModelSelection()` is missing.

- [ ] **Step 3: Implement validation and effective-route intersection**

  Define:

  ```ts
  export interface PlanModelSelectionInput {
    readonly request: ExecutionRequestV1;
    readonly task: RoutingTaskProfile;
    readonly ceilings: RoutingCallCeilings;
    readonly catalog: ModelCatalogV1;
    readonly policy: RoutingPolicyV1;
    readonly state: RoutingStateV1;
    readonly live: AgentgatewayCapabilitiesV1;
    readonly gateway_profile: string;
    readonly decision_at: string;
    readonly override?: GovernedRoutingOverride;
  }

  export type RoutingDecision =
    | Readonly<{
        status: "planned";
        plan: PlannedModelSelectionPlanV1;
        next_state: RoutingStateV1;
      }>
    | Readonly<{
        status: "blocked";
        plan: BlockedModelSelectionPlanV1;
        next_state: null;
      }>;

  export function planModelSelection(input: PlanModelSelectionInput): RoutingDecision;
  ```

  Before eligibility, verify all catalog/policy/request/state hashes and run
  bindings, exact task-contract equality, canonical decision time, live
  `generated_at <= decision_at < expires_at`, supported logical class and
  fixed required capability names, positive ceilings, deadline, and state
  budget status. Stale bindings produce a blocked stale-state plan without
  state mutation.

  Intersect by exact catalog `route_alias` to live `alias`, plus exact route
  ID/provider/model. Effective booleans are catalog AND live; effective limits
  are the minimum. Require every named capability, output ceiling no greater
  than effective output limit, and input + output ceilings no greater than
  effective context. A live route can remove authority but never add it.
  `text` is always present for a structurally valid route; `tools`,
  `json-schema`, `vision`, `reasoning`, and `streaming` map to the effective
  booleans; `long-context` and `independent-review` require their exact entry
  logical class in addition to numeric and feature checks.

- [ ] **Step 4: Implement stable matching, ordering, fallback, and reservation**

  An entry is class-eligible when it contains the request logical class and at
  least one matched-rule worker preference. Its class rank is the first such
  preference. Sort eligible entries by:

  ```text
  class rank
  catalog priority
  worst-case reserved microusd
  latency rank (interactive, standard, extended)
  ASCII entry_id
  ```

  Sort accepted routes by route ID. Choose the first worker and up to
  `max_fallbacks` following entries that independently satisfy the complete
  worker requirement. Calculate each alias cost from its most expensive
  accepted route. Create stable attempt IDs from decision ID, role, and index;
  create `ProviderRouteRequirement` with exact alias/booleans/output ceiling
  and hash it with existing `hashProviderRouteRequirement()`.

  Generate the decision ID from canonical request/task/catalog/policy/state/
  live/gateway/time/override bindings. Build attempts, eliminations, and
  allocations; compute the decision hash without next-state/final hashes;
  place it in the combined reservation; call `reserveRoutingBudget()`; then
  build/hash the plan with the returned state
  revision/hash. If the selected primary is open and decision time is at or
  after its `retry_at`, the same next-state transition marks it `probe-reserved` for this
  decision; a stale competing head cannot reserve the same probe. Open entries
  never appear as fallback or reviewer attempts, even after cooldown, because
  each probe requires its own exact reservation. A blocked plan has no
  executable values and no state change.

- [ ] **Step 5: Assert bounded explanations and fixed blocked results**

  Add assertions that each catalog entry appears once either as selected or
  eliminated; eliminations are sorted and contain only fixed codes. Test
  no-capable-route, all-open circuit with earliest safe `next_retry_at`, budget
  exceeded, stale state, and unknown usage. Ensure prompts, endpoints, headers,
  tokens, provider messages, and arbitrary native values never occur in plan
  JSON.

- [ ] **Step 6: Run focused tests and commit**

  Run:

  ```bash
  npx vitest run test/routing-selection.test.ts test/routing-cost.test.ts test/routing-contracts.test.ts
  npm run typecheck
  ```

  Expected: deterministic worker/fallback selection and all prior tests pass.

  Commit:

  ```bash
  git add src/routing/selection.ts src/routing/types.ts test/helpers/routing-fixtures.ts test/routing-selection.test.ts
  git commit -m "feat: plan deterministic model routing"
  ```

### Task 6: Independent reviewer pairing and governed override narrowing

**Files:**

- Modify: `src/routing/selection.ts`
- Modify: `src/routing/types.ts`
- Modify: `test/routing-selection.test.ts`

**Interfaces:**

- Consumes: worker candidates and governed override from Task 5.
- Produces: atomic worker/fallback/reviewer decisions and fail-closed override
  enforcement through the same `planModelSelection()` API.

- [ ] **Step 1: Add RED reviewer/override tests**

  Cover security, architecture, irreversible, and multi-risk profiles;
  different aliases that resolve to the same provider/model; multi-route
  aliases where one pair collides; deterministic reviewer ranking; reviewer
  plus worker budget; a cheaper pairing that preserves independence; no valid
  reviewer; valid narrowing override; stale catalog/policy override; absent,
  circuit-open, too-slow, under-capable, over-budget target; and attempts to
  reduce review or increase budget/tool capability.

- [ ] **Step 2: Run the reviewer/override tests to verify RED**

  Run: `npx vitest run test/routing-selection.test.ts -t 'review|override'`

  Expected: reviewer pairing and override cases fail.

- [ ] **Step 3: Implement deterministic independent pairing**

  For an independent rule, form reviewer candidates containing
  `independent-review`. A worker/reviewer pair is valid only if every accepted
  reviewer route has both a different provider and a different model from
  every accepted route of primary and included fallbacks. Enumerate candidates
  in the already stable order and choose the lexicographically smallest tuple:

  ```text
  worker rank
  reviewer rank
  negative number of valid fallbacks (prefer more up to policy maximum)
  ordered fallback entry IDs
  reviewer entry ID
  ```

  Reserve primary worker, every included fallback, and reviewer ceilings
  atomically. This covers the worst case in which each failed worker attempt
  incurs usage before the next preplanned fallback and the reviewer also runs.
  If no independent pair fits, return `RUNTIME_ROUTING_REVIEW_UNAVAILABLE`
  with no next state.

- [ ] **Step 4: Enforce override as a narrowing filter**

  Require exact catalog/policy hashes, artifact hash, `issued_at` no later than
  `decision_at`, and a target in the already eligible worker set. Apply the
  target before tuple selection. Never
  treat a stale or invalid override as absent; return
  `RUNTIME_ROUTING_POLICY_DENIED`. The override cannot change call ceilings,
  required capabilities, risk, reviewer rule, fallback limit, circuit state,
  or state budget.

- [ ] **Step 5: Run selection tests and commit**

  Run:

  ```bash
  npx vitest run test/routing-selection.test.ts test/routing-cost.test.ts
  npm run typecheck
  ```

  Expected: all worker, fallback, reviewer, and override tests pass.

  Commit:

  ```bash
  git add src/routing/selection.ts src/routing/types.ts test/routing-selection.test.ts
  git commit -m "feat: require governed independent routing review"
  ```

### Task 7: Explicit circuit transitions and preplanned fallback consumption

**Files:**

- Create: `src/routing/circuit.ts`
- Create: `test/routing-circuit.test.ts`
- Modify: `src/routing/types.ts`
- Modify: `test/helpers/routing-fixtures.ts`

**Interfaces:**

- Consumes: planned decision, routing state, policy circuit values, and
  existing `RuntimeProviderErrorCode` outcomes.
- Produces: `recordRoutingOutcome()` and `nextModelFallback()`.

- [ ] **Step 1: Write RED circuit/fallback state-machine tests**

  Cover threshold-1 and multi-failure opening, cooldown boundary, one
  `probe-reserved` decision, concurrent stale probe rejection, successful
  close, failed probe reopen, exact cooldown timestamp, success reset, and
  immutable exact-head revisions. Table-test every provider outcome to prove
  only `RUNTIME_PROVIDER_TIMEOUT`, `RUNTIME_PROVIDER_TRANSIENT`, and
  `RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE` change counters or permit fallback.
  Include auth, rate-limit, refusal, cancellation, invalid, capability
  downgrade, route-not-found, integrity, and internal negative cases.

- [ ] **Step 2: Run circuit tests to verify RED**

  Run: `npx vitest run test/routing-circuit.test.ts`

  Expected: FAIL because circuit operations do not exist.

- [ ] **Step 3: Implement exact-head circuit transitions**

  Add:

  ```ts
  export function recordRoutingOutcome(input: {
    readonly state: RoutingStateV1;
    readonly plan: PlannedModelSelectionPlanV1;
    readonly policy: RoutingPolicyV1;
    readonly attempt_id: string;
    readonly outcome: RuntimeProviderErrorCode | "RUNTIME_PROVIDER_SUCCESS";
    readonly occurred_at: string;
  }): RoutingStateV1;
  ```

  Verify plan hash, decision reservation, attempt identity, catalog/policy
  bindings, and canonical time. Success closes/reset; allowed failures
  increment; threshold opens until `occurred_at + cooldown_ms`; a failed probe
  reopens; every other outcome returns a new state only if another documented
  field changes, otherwise returns the exact immutable input. Circuit records
  remain sorted by entry ID.

- [ ] **Step 4: Implement explicit fallback consumption**

  Add:

  ```ts
  export function nextModelFallback(input: {
    readonly state: RoutingStateV1;
    readonly plan: PlannedModelSelectionPlanV1;
    readonly current_attempt_id: string;
    readonly outcome: RuntimeProviderErrorCode;
    readonly attempt_results: readonly RoutingAttemptResult[];
    readonly remaining_duration_ms: number;
  }):
    | Readonly<{ status: "ready"; attempt: RoutingAttemptV1 }>
    | Readonly<{
        status: "blocked";
        code: RuntimeRoutingErrorCode;
        retryable: boolean;
      }>;
  ```

  Return only the next worker attempt already present in the plan. Require an
  allowed fallback outcome, matching live reservation, positive remaining
  duration, no newly open circuit, and sufficient still-reserved budget after
  pricing every prior result against its exact accepted route. Result IDs must
  be unique, ordered plan attempts ending at `current_attempt_id`, and cannot
  include unattempted fallback/reviewer allocations. A possible effect with
  missing route/usage blocks with `RUNTIME_ROUTING_USAGE_UNKNOWN`; cumulative
  actual usage plus remaining allocations that crosses a run limit blocks with
  `RUNTIME_ROUTING_BUDGET_EXCEEDED`. Do not reselect, reorder, invoke
  transport, sleep, or retry.

- [ ] **Step 5: Run tests and commit**

  Run:

  ```bash
  npx vitest run test/routing-circuit.test.ts test/routing-selection.test.ts test/routing-cost.test.ts
  npm run typecheck
  ```

  Expected: circuit and fallback matrices pass.

  Commit:

  ```bash
  git add src/routing/circuit.ts src/routing/types.ts test/helpers/routing-fixtures.ts test/routing-circuit.test.ts
  git commit -m "feat: advance routing circuits and fallbacks"
  ```

### Task 8: Exact agentgateway route-resolution verification

**Files:**

- Create: `src/routing/resolution.ts`
- Create: `test/routing-resolution.test.ts`
- Modify: `test/helpers/fake-agentgateway.ts`
- Modify: `test/helpers/routing-fixtures.ts`

**Interfaces:**

- Consumes: planned attempt, exact current routing state, and existing frozen
  `ProviderRouteIdentity` from the agentgateway transport.
- Produces: `verifyResolvedRoute()`.

- [ ] **Step 1: Add RED attestation binding tests**

  Start with a valid selected plan and exact fake-gateway route identity. Add
  one negative test for each field: missing/non-agentgateway identity, gateway
  profile, gateway revision, requested alias, route ID, provider, model,
  capability-document hash, requirement hash, state head, catalog hash, policy
  hash, decision reservation, and attempt ID. Assert fixed
  `RUNTIME_ROUTING_RESOLUTION_MISMATCH` and no native value reflection.

- [ ] **Step 2: Run resolution tests to verify RED**

  Run: `npx vitest run test/routing-resolution.test.ts`

  Expected: FAIL because `verifyResolvedRoute()` is missing.

- [ ] **Step 3: Implement exact route verification**

  Add:

  ```ts
  export function verifyResolvedRoute(input: {
    readonly state: RoutingStateV1;
    readonly plan: PlannedModelSelectionPlanV1;
    readonly attempt_id: string;
    readonly route_identity: ProviderRouteIdentity | null;
  }): ProviderRouteIdentity;
  ```

  Locate exactly one attempt, recompute its plan decision hash, require the
  state still contains that exact decision reservation and equals the plan's
  reserved next-state identity, then compare every governed route field.
  Accept only a route in the attempt's sorted accepted set. Return a deeply
  frozen canonical identity; throw only the fixed routing error for every
  mismatch.

- [ ] **Step 4: Add real loopback fake-gateway integration**

  Extend the existing fake only with a configuration that returns a chosen
  route from its published capabilities. Plan from that exact capability
  document, make one credential-free loopback request through
  `createAgentgatewayTransport()`, collect the normalized completion, and pass
  its route identity to `verifyResolvedRoute()`. Mutate the fake attestation in
  a second test and prove the transport or resolver fails closed. Do not add
  live credentials or external network access.

- [ ] **Step 5: Run gateway/routing tests and commit**

  Run:

  ```bash
  npx vitest run test/routing-resolution.test.ts test/agentgateway-transport.test.ts test/agentgateway-contracts.test.ts
  npm run typecheck
  ```

  Expected: exact-route loopback and all existing gateway tests pass.

  Commit:

  ```bash
  git add src/routing/resolution.ts test/helpers/fake-agentgateway.ts test/helpers/routing-fixtures.ts test/routing-resolution.test.ts
  git commit -m "feat: verify planned gateway route resolution"
  ```

### Task 9: Safe public API and truthful routing capability advertisement

**Files:**

- Modify: `src/routing/index.ts`
- Modify: `src/index.ts`
- Modify: `src/protocol/capabilities.ts`
- Modify: `contracts/runtime/runtime-capabilities.v1.schema.json`
- Modify: `test/fixtures/protocol/valid/runtime-capabilities.v1.json`
- Modify: `test/package-metadata.test.ts`
- Modify: `test/documentation-integrity.test.ts`
- Modify: `test/unavailable-boundaries.test.ts`
- Create: `test/routing-public-api.test.ts`

**Interfaces:**

- Consumes: every safe pure function/type from Tasks 1-8.
- Produces: the supported top-level routing API and a truthful available
  routing capability document.

- [ ] **Step 1: Write RED public-surface and capability tests**

  Assert top-level availability of parsers, hashes, planning, cost,
  settlement, circuit, fallback, and route verification. Assert absence of
  internal validators, Ajv instances, mutable caches, filesystem/persistence
  constructors, test fixtures, arbitrary scoring callbacks, and the old
  `requireModelRouter` unavailable boundary. Assert baseline routing is
  `available`, all six classes are present in fixed order, and all four routing
  schema versions are advertised.

- [ ] **Step 2: Run public tests to verify RED**

  Run:

  ```bash
  npx vitest run test/routing-public-api.test.ts test/package-metadata.test.ts test/unavailable-boundaries.test.ts
  ```

  Expected: FAIL because routing is still unavailable and exports are absent.

- [ ] **Step 3: Export only the safe routing surface**

  Replace `src/routing/index.ts` with explicit exports for:

  ```text
  parse/hash model catalog, routing policy, routing state, selection plan
  parse governed override
  calculate/estimate/reserve/settle budget
  plan model selection
  record routing outcome
  next model fallback
  verify resolved route
  RuntimeRoutingError and immutable public types
  ```

  Re-export those names from `src/index.ts`. Do not export internal schema
  validators, mutable collections, test helpers, candidate sorting functions,
  or hash-without-document helpers.

- [ ] **Step 4: Make baseline capability advertisement truthful**

  Add these schema versions in sorted order:

  ```text
  model-catalog.v1
  model-selection-plan.v1
  routing-policy.v1
  routing-state.v1
  ```

  Set `features.routing` to `available` and publish fixed classes/capabilities:

  ```ts
  [
    { logical_class: "economy", capabilities: ["text"] },
    { logical_class: "balanced-code", capabilities: ["json-schema", "text", "tools"] },
    { logical_class: "deep-reasoning", capabilities: ["reasoning", "text"] },
    { logical_class: "long-context", capabilities: ["long-context", "text"] },
    { logical_class: "vision", capabilities: ["text", "vision"] },
    {
      logical_class: "independent-review",
      capabilities: ["independent-review", "reasoning", "text"],
    },
  ];
  ```

  Keep agent loop and review execution unavailable and topologies empty. Update
  the closed runtime-capabilities enum and fixture accordingly.

- [ ] **Step 5: Run public/capability tests and commit**

  Run:

  ```bash
  npx vitest run test/routing-public-api.test.ts test/package-metadata.test.ts test/documentation-integrity.test.ts test/unavailable-boundaries.test.ts
  npm run typecheck
  ```

  Expected: safe public routing API and capability coherence pass.

  Commit:

  ```bash
  git add src/routing/index.ts src/index.ts src/protocol/capabilities.ts contracts/runtime/runtime-capabilities.v1.schema.json test/fixtures/protocol/valid/runtime-capabilities.v1.json test/package-metadata.test.ts test/documentation-integrity.test.ts test/unavailable-boundaries.test.ts test/routing-public-api.test.ts
  git commit -m "feat: publish governed routing capability"
  ```

### Task 10: Protocol examples, documentation, package allowlist, and bounded integration

**Files:**

- Create: `examples/runtime-contract-v1/model-catalog.json`
- Create: `examples/runtime-contract-v1/routing-policy.json`
- Create: `examples/runtime-contract-v1/routing-state.json`
- Create: `examples/runtime-contract-v1/model-selection-plan.json`
- Create: `test/routing-integration.test.ts`
- Modify: `docs/contracts/runtime-contract-v1.manifest.json`
- Modify: `docs/contracts/runtime-contract-protocol-v1.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `scripts/package-files.json`
- Modify: `test/documentation-integrity.test.ts`
- Modify: `test/package-metadata.test.ts`

**Interfaces:**

- Consumes: complete public routing API.
- Produces: packaged canonical contracts/examples/docs and final bounded
  acceptance evidence for Issue #6.

- [ ] **Step 1: Add RED documentation/package/integration assertions**

  Require the manifest to list all four schema IDs/files, examples to parse and
  hash through the public API, README/protocol/changelog to document authority,
  deterministic selection, independent review planning, integer budget,
  explicit circuits/fallback, exact route verification, and later-issue
  boundaries. Require exact package allowlist inclusion of schemas, examples,
  and all public routing JS/declarations while excluding test helpers and
  internal source maps if the existing package policy excludes them.

  Add a 1,024-entry/256-live-route integration fixture that completes within a
  fixed 5-second Vitest timeout and produces a plan below 2 MiB. Add catalog and
  live-array permutation/property loops that preserve semantic selection while
  rebinding exact input hashes, combined primary/fallback/reviewer reservation,
  fallback after timeout, successful route verification, and settlement.

- [ ] **Step 2: Run the new tests to verify RED**

  Run:

  ```bash
  npx vitest run test/routing-integration.test.ts test/documentation-integrity.test.ts test/package-metadata.test.ts
  ```

  Expected: FAIL because examples/docs/manifest/package list are not updated.

- [ ] **Step 3: Publish canonical schemas and examples**

  Add the four schema entries to the manifest in alphabetical schema-version
  order with exact `https://toss.software/schemas/runtime/v1/...` IDs. Create
  canonical examples using the same fixture values as the integration test and
  compute each `document_hash` through its public hash function. The planned
  example must reference the exact next-state hash without embedding a cyclic
  plan hash in the state reservation.

- [ ] **Step 4: Document the governed boundary**

  Add a README section named `Governed model routing and budgets` and a
  normative protocol section covering the four documents, authority,
  deterministic ordering, capability intersection, independent review,
  microusd formulas, circuit outcomes, explicit fallback, override narrowing,
  route attestation, and safe errors. Remove Issue #6 from later/unavailable
  wording while keeping execution #10, review proof #11, reconciliation #12,
  hardening #13, and protected live smoke #15 explicitly pending. Add an
  Issue #6 entry to `CHANGELOG.md` without claiming provider execution.

- [ ] **Step 5: Update and verify the exact package allowlist**

  Run `npm run build`, inspect the generated routing/schema/example files, and
  update `scripts/package-files.json` in sorted exact order. Do not add test
  helpers, fake gateway code, source secrets, SDD files, or release evidence.

- [ ] **Step 6: Run focused and full local acceptance**

  Run on Node 22.23.1:

  ```bash
  npx vitest run test/routing-contracts.test.ts test/routing-cost.test.ts test/routing-selection.test.ts test/routing-circuit.test.ts test/routing-resolution.test.ts test/routing-public-api.test.ts test/routing-integration.test.ts test/documentation-integrity.test.ts test/package-metadata.test.ts
  npm run verify
  npm audit --omit=dev
  git diff --check
  ```

  Switch to Node 24 and run:

  ```bash
  npm run verify
  npm audit --omit=dev
  git diff --check
  ```

  Expected on both Node lines: format, lint, typecheck, all tests, build, exact
  installed-package acceptance, and production audit pass; audit reports zero
  vulnerabilities; only the documented native-host test may skip.

- [ ] **Step 7: Commit the delivery boundary**

  ```bash
  git add examples/runtime-contract-v1/model-catalog.json examples/runtime-contract-v1/routing-policy.json examples/runtime-contract-v1/routing-state.json examples/runtime-contract-v1/model-selection-plan.json test/routing-integration.test.ts docs/contracts/runtime-contract-v1.manifest.json docs/contracts/runtime-contract-protocol-v1.md README.md CHANGELOG.md scripts/package-files.json test/documentation-integrity.test.ts test/package-metadata.test.ts
  git commit -m "docs: publish governed routing contract"
  ```

### Task 11: Exact-head review, CI, GitHub status, and release-branch integration

**Files:**

- Modify only if review finds a concrete defect: the smallest owning source,
  test, schema, example, or documentation files.
- Do not add Issue #6 evidence to the v1 release evidence document; final
  cross-issue release evidence belongs to its owning release issue.

**Interfaces:**

- Consumes: complete Issue #6 branch and PR #46.
- Produces: reviewed exact head, green macOS CI, synchronized Issue/PR/Project/
  Epic state, and one merge into `release/v1.0.0` after acceptance.

- [ ] **Step 1: Perform a fresh self-review against the spec**

  Compare every design section and Issue #6 acceptance criterion to tests and
  code. Specifically audit hash cycles, money overflow, array-order
  determinism, multi-route reviewer independence, stale/unknown state,
  override escalation, circuit trigger allowlist, safe errors, top-level
  exports, package contents, and truthful capability availability.

- [ ] **Step 2: Run verification-before-completion on the exact clean head**

  Confirm `git status --short` is empty, then rerun Node 22.23.1 and Node 24
  `npm run verify`, production audit, and `git diff --check`. Record exact test
  totals, package file count/size/hash, Node/npm versions, and any single
  documented platform skip in PR #46.

- [ ] **Step 3: Request a code review and fix only verified findings**

  Review the complete diff from `origin/release/v1.0.0` to HEAD. For each
  Important/Minor finding, reproduce it with a failing test, implement the
  smallest owner-file correction, rerun focused/full gates, and commit with a
  scoped `fix:` message. If the finding is distinct and not owned by Issue #6,
  open a dedicated v1.0.0 issue/branch/PR instead of expanding this branch.

- [ ] **Step 4: Push exact head and wait for both required CI jobs**

  Push `issue/6-governed-model-router`, mark PR #46 ready only after local
  acceptance, and require the exact PR SHA to pass:

  ```text
  Node 22.23.1 / macos-latest
  Node 24 / macos-latest
  ```

  A previous commit's CI result is not acceptance evidence.

- [ ] **Step 5: Update GitHub continuously under the approved policy**

  While work is active, keep Issue #6 and PR #46 `In progress`; post plan,
  implementation, review, and exact-CI updates to Issue #6 and Epic #16. Once
  the exact PR head is green and every criterion is met, check the Issue #6 and
  PR acceptance lists, set both Project #2 items to `Done`, and close Issue #6
  as completed before merge, per the approved project rule.

- [ ] **Step 6: Merge only the accepted PR into the version branch**

  Merge PR #46 into `release/v1.0.0`, verify the remote merge commit contains
  the exact accepted head, update Epic #16's Issue #6 delivery/integration
  checkboxes and merge/CI comment, then continue with the next unfinished
  v1.0.0 issue. Do not tag or publish v1.0.0 until every epic gate is complete.
