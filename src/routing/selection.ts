import {
  hashAgentgatewayCapabilities,
  parseAgentgatewayCapabilities,
  type AgentgatewayCapabilitiesV1,
  type AgentgatewayRouteV1,
} from "../gateway/index.js";
import { hashProviderRouteRequirement } from "../gateway/attestation.js";
import { canonicalJson, sha256, type JsonLimits } from "../protocol/json.js";
import {
  hashExecutionRequest,
  parseExecutionRequest,
  type ExecutionRequestV1,
} from "../protocol/request.js";
import type { ProviderRouteRequirement } from "../providers/types.js";
import { estimateRoutingAllocation, reserveRoutingBudget } from "./cost.js";
import {
  hashModelCatalog,
  hashModelSelectionPlan,
  hashRoutingPolicy,
  hashRoutingState,
  parseGovernedRoutingOverride,
  parseModelCatalog,
  parseModelSelectionPlan,
  parseRoutingPolicy,
  parseRoutingState,
} from "./contracts.js";
import { RuntimeRoutingError } from "./errors.js";
import type {
  BlockedModelSelectionPlanV1,
  CatalogRouteV1,
  GovernedRoutingOverride,
  LatencyClass,
  LogicalModelClass,
  ModelCatalogEntryV1,
  ModelCatalogV1,
  ModelSelectionPlanV1,
  PlanModelSelectionInput,
  PlannedModelSelectionPlanV1,
  RoutingAcceptedRouteV1,
  RoutingBlockCode,
  RoutingCallCeilings,
  RoutingDecision,
  RoutingEliminationV1,
  RoutingPolicyRuleV1,
  RoutingPolicyV1,
  RoutingReservationV1,
  RoutingStateV1,
  RoutingTaskProfile,
  TaskComplexity,
  TaskPhase,
  TaskRisk,
} from "./types.js";

export type { PlanModelSelectionInput, RoutingDecision } from "./types.js";

const ROUTING_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxMembers: 100_000,
});
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const LOGICAL_CLASSES = new Set<LogicalModelClass>([
  "economy",
  "balanced-code",
  "deep-reasoning",
  "long-context",
  "vision",
  "independent-review",
]);
const ROUTING_CAPABILITIES = new Set([
  "independent-review",
  "json-schema",
  "long-context",
  "reasoning",
  "streaming",
  "text",
  "tools",
  "vision",
]);
const TASK_PHASES = new Set<TaskPhase>(["analysis", "implementation", "review"]);
const TASK_COMPLEXITIES = new Set<TaskComplexity>(["low", "medium", "high", "critical"]);
const TASK_RISKS = new Set<string>(["architecture", "irreversible", "security"]);
const LATENCY_RANK: Readonly<Record<LatencyClass, number>> = Object.freeze({
  interactive: 0,
  standard: 1,
  extended: 2,
});

interface ValidatedInputs {
  readonly request: ExecutionRequestV1;
  readonly catalog: ModelCatalogV1;
  readonly policy: RoutingPolicyV1;
  readonly live: AgentgatewayCapabilitiesV1;
  readonly state: RoutingStateV1 | null;
  readonly decision_ms: number;
  readonly stale: boolean;
}

interface EffectiveRoute {
  readonly catalog: CatalogRouteV1;
  readonly live: AgentgatewayRouteV1;
}

interface Candidate {
  readonly entry: ModelCatalogEntryV1;
  readonly class_rank: number;
  readonly accepted_routes: readonly RoutingAcceptedRouteV1[];
  readonly latency_class: LatencyClass;
  readonly allocation: Readonly<{
    input_tokens: number;
    output_tokens: number;
    cost_microusd: number;
    duration_ms: number;
    turns: 1;
  }>;
  readonly probe: boolean;
}

interface BudgetVector {
  readonly input_tokens: bigint;
  readonly output_tokens: bigint;
  readonly cost_microusd: bigint;
  readonly duration_ms: bigint;
  readonly turns: bigint;
}

function invalid(): never {
  throw new RuntimeRoutingError("RUNTIME_ROUTING_INVALID");
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left, ROUTING_JSON_LIMITS) === canonicalJson(right, ROUTING_JSON_LIMITS);
  } catch {
    return false;
  }
}

function timestamp(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null;
  return milliseconds;
}

function assertExactDataRecord(value: unknown, keys: readonly string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    invalid();
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    symbols.length !== 0 ||
    Object.keys(descriptors).sort().join("\u0000") !== [...keys].sort().join("\u0000")
  ) {
    invalid();
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      invalid();
    }
  }
}

function parseRequest(value: ExecutionRequestV1): ExecutionRequestV1 {
  const parsed = parseExecutionRequest(canonicalJson(value, ROUTING_JSON_LIMITS));
  if (!parsed.ok) invalid();
  return parsed.value;
}

function parseCatalog(value: ModelCatalogV1): ModelCatalogV1 {
  let expected: `sha256:${string}`;
  try {
    expected = hashModelCatalog(value);
  } catch {
    invalid();
  }
  if (expected !== value.document_hash) invalid();
  const parsed = parseModelCatalog(canonicalJson(value, ROUTING_JSON_LIMITS));
  if (!parsed.ok) invalid();
  return parsed.value;
}

function parsePolicy(value: RoutingPolicyV1): RoutingPolicyV1 {
  let expected: `sha256:${string}`;
  try {
    expected = hashRoutingPolicy(value);
  } catch {
    invalid();
  }
  if (expected !== value.document_hash) invalid();
  const parsed = parseRoutingPolicy(canonicalJson(value, ROUTING_JSON_LIMITS));
  if (!parsed.ok) invalid();
  return parsed.value;
}

function parseLive(value: AgentgatewayCapabilitiesV1): AgentgatewayCapabilitiesV1 {
  let expected: `sha256:${string}`;
  try {
    expected = hashAgentgatewayCapabilities(value);
  } catch {
    invalid();
  }
  if (expected !== value.document_hash) invalid();
  const generatedAt = timestamp(value.generated_at);
  if (generatedAt === null) invalid();
  const parsed = parseAgentgatewayCapabilities(canonicalJson(value, ROUTING_JSON_LIMITS), {
    now: () => new Date(generatedAt),
  });
  if (!parsed.ok) invalid();
  return parsed.value;
}

function validateTask(task: RoutingTaskProfile): void {
  assertExactDataRecord(task, [
    "task_contract",
    "phase",
    "complexity",
    "risks",
    "max_latency_class",
  ]);
  const riskValues: unknown = task.risks;
  if (
    task.task_contract.document_type !== "task-contract" ||
    !TASK_PHASES.has(task.phase) ||
    !TASK_COMPLEXITIES.has(task.complexity) ||
    !(task.max_latency_class in LATENCY_RANK) ||
    !Array.isArray(riskValues)
  ) {
    invalid();
  }
  const risks = new Set<string>();
  for (const risk of riskValues) {
    if (typeof risk !== "string" || !TASK_RISKS.has(risk) || risks.has(risk)) invalid();
    risks.add(risk);
  }
  canonicalJson(task, ROUTING_JSON_LIMITS);
}

function validateCeilings(ceilings: RoutingCallCeilings): void {
  assertExactDataRecord(ceilings, ["max_input_tokens", "max_output_tokens", "max_duration_ms"]);
  for (const value of [
    ceilings.max_input_tokens,
    ceilings.max_output_tokens,
    ceilings.max_duration_ms,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) invalid();
  }
}

function addBudget(left: BudgetVector, right: BudgetVector): BudgetVector {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    cost_microusd: left.cost_microusd + right.cost_microusd,
    duration_ms: left.duration_ms + right.duration_ms,
    turns: left.turns + right.turns,
  };
}

function allocationBudget(allocation: Candidate["allocation"]): BudgetVector {
  return {
    input_tokens: BigInt(allocation.input_tokens),
    output_tokens: BigInt(allocation.output_tokens),
    cost_microusd: BigInt(allocation.cost_microusd),
    duration_ms: BigInt(allocation.duration_ms),
    turns: BigInt(allocation.turns),
  };
}

function remainingBudget(state: RoutingStateV1): BudgetVector {
  if (state.settled.cost_microusd === null) invalid();
  let used: BudgetVector = {
    input_tokens: BigInt(state.settled.input_tokens),
    output_tokens: BigInt(state.settled.output_tokens),
    cost_microusd: BigInt(state.settled.cost_microusd),
    duration_ms: BigInt(state.settled.duration_ms),
    turns: BigInt(state.settled.turns),
  };
  for (const reservation of state.reservations) {
    for (const allocation of reservation.allocations) {
      used = addBudget(used, {
        input_tokens: BigInt(allocation.input_tokens),
        output_tokens: BigInt(allocation.output_tokens),
        cost_microusd: BigInt(allocation.cost_microusd),
        duration_ms: BigInt(allocation.duration_ms),
        turns: BigInt(allocation.turns),
      });
    }
  }
  return {
    input_tokens: BigInt(state.budget.max_input_tokens) - used.input_tokens,
    output_tokens: BigInt(state.budget.max_output_tokens) - used.output_tokens,
    cost_microusd: BigInt(state.budget.max_cost_microusd) - used.cost_microusd,
    duration_ms: BigInt(state.budget.max_duration_ms) - used.duration_ms,
    turns: BigInt(state.budget.max_turns) - used.turns,
  };
}

function fitsBudget(usage: BudgetVector, remaining: BudgetVector): boolean {
  return (
    usage.input_tokens <= remaining.input_tokens &&
    usage.output_tokens <= remaining.output_tokens &&
    usage.cost_microusd <= remaining.cost_microusd &&
    usage.duration_ms <= remaining.duration_ms &&
    usage.turns <= remaining.turns
  );
}

function subtractBudget(available: BudgetVector, used: BudgetVector): BudgetVector {
  if (!fitsBudget(used, available)) invalid();
  return {
    input_tokens: available.input_tokens - used.input_tokens,
    output_tokens: available.output_tokens - used.output_tokens,
    cost_microusd: available.cost_microusd - used.cost_microusd,
    duration_ms: available.duration_ms - used.duration_ms,
    turns: available.turns - used.turns,
  };
}

function validateInputs(input: PlanModelSelectionInput): ValidatedInputs {
  const decisionMs = timestamp(input.decision_at);
  if (decisionMs === null || !IDENTIFIER_PATTERN.test(input.gateway_profile)) invalid();
  validateTask(input.task);
  validateCeilings(input.ceilings);

  const request = parseRequest(input.request);
  const catalog = parseCatalog(input.catalog);
  const policy = parsePolicy(input.policy);
  const live = parseLive(input.live);
  let state: RoutingStateV1 | null = null;
  let stale = false;
  try {
    if (hashRoutingState(input.state) === input.state.document_hash) {
      const parsed = parseRoutingState(canonicalJson(input.state, ROUTING_JSON_LIMITS));
      if (parsed.ok) state = parsed.value;
      else stale = true;
    } else {
      stale = true;
    }
  } catch {
    stale = true;
  }

  const generatedAt = timestamp(live.generated_at);
  const expiresAt = timestamp(live.expires_at);
  const createdAt = timestamp(request.created_at);
  const deadline = timestamp(request.deadline);
  if (
    generatedAt === null ||
    expiresAt === null ||
    createdAt === null ||
    deadline === null ||
    generatedAt > decisionMs ||
    decisionMs >= expiresAt ||
    decisionMs < createdAt ||
    decisionMs >= deadline ||
    input.ceilings.max_duration_ms > deadline - decisionMs
  ) {
    stale = true;
  }

  return { request, catalog, policy, live, state, decision_ms: decisionMs, stale };
}

function sortedRisks(risks: readonly TaskRisk[]): readonly TaskRisk[] {
  return [...risks].sort(compareAscii);
}

function ruleMatches(rule: RoutingPolicyRuleV1, task: RoutingTaskProfile): boolean {
  if (rule.match.phase !== "*" && rule.match.phase !== task.phase) return false;
  if (rule.match.complexity !== "*" && rule.match.complexity !== task.complexity) return false;
  if (rule.match.risks === "*") return true;
  return canonicalEqual([...rule.match.risks].sort(compareAscii), sortedRisks(task.risks));
}

function matchedRule(policy: RoutingPolicyV1, task: RoutingTaskProfile): RoutingPolicyRuleV1 {
  const matches = policy.rules.filter((rule) => ruleMatches(rule, task));
  matches.sort(
    (left, right) => left.priority - right.priority || compareAscii(left.rule_id, right.rule_id),
  );
  const selected = matches[0];
  if (selected === undefined) invalid();
  if (matches[1]?.priority === selected.priority) invalid();
  return selected;
}

function decisionId(input: {
  readonly request_hash: `sha256:${string}`;
  readonly task: RoutingTaskProfile;
  readonly ceilings: RoutingCallCeilings;
  readonly catalog_hash: `sha256:${string}`;
  readonly policy_hash: `sha256:${string}`;
  readonly state_hash: `sha256:${string}`;
  readonly live_hash: `sha256:${string}`;
  readonly gateway_profile: string;
  readonly decision_at: string;
  readonly override: GovernedRoutingOverride | null;
  readonly override_supplied: boolean;
}): string {
  return `decision-${sha256(input, ROUTING_JSON_LIMITS).slice("sha256:".length)}`;
}

function inputBindings(
  input: PlanModelSelectionInput,
  validated: ValidatedInputs,
  rule: RoutingPolicyRuleV1,
  id: string,
  override: GovernedRoutingOverride | null,
) {
  return {
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "model-selection-plan.v1" as const,
    document_type: "model-selection-plan" as const,
    decision_id: id,
    revision: 1 as const,
    run_id: validated.request.run_id,
    request_id: validated.request.request_id,
    request_hash: hashExecutionRequest(validated.request),
    task_contract: validated.request.task_contract as PlannedModelSelectionPlanV1["task_contract"],
    catalog_id: validated.catalog.catalog_id,
    catalog_revision: validated.catalog.revision,
    catalog_hash: validated.catalog.document_hash,
    policy_id: validated.policy.policy_id,
    policy_revision: validated.policy.revision,
    policy_hash: validated.policy.document_hash,
    prior_state_id: input.state.state_id,
    prior_state_revision: input.state.revision,
    prior_state_hash: input.state.document_hash,
    gateway_profile: input.gateway_profile,
    gateway_revision: validated.live.gateway.revision,
    capability_document_hash: validated.live.document_hash,
    override:
      override === null ? null : (override.artifact as PlannedModelSelectionPlanV1["override"]),
    decision_at: input.decision_at,
    matched_rule_id: rule.rule_id,
  };
}

function completeEliminations(
  catalog: ModelCatalogV1,
  reasons: ReadonlyMap<string, RoutingEliminationV1["reason"]>,
  fallback: RoutingEliminationV1["reason"],
): readonly RoutingEliminationV1[] {
  return catalog.entries
    .map((entry) => ({ entry_id: entry.entry_id, reason: reasons.get(entry.entry_id) ?? fallback }))
    .sort((left, right) => compareAscii(left.entry_id, right.entry_id));
}

function sortedEliminations(
  reasons: ReadonlyMap<string, RoutingEliminationV1["reason"]>,
): readonly RoutingEliminationV1[] {
  return [...reasons]
    .map(([entry_id, reason]) => ({ entry_id, reason }))
    .sort((left, right) => compareAscii(left.entry_id, right.entry_id));
}

function freezePlan<T extends ModelSelectionPlanV1>(value: T): T {
  const candidate = {
    ...value,
    document_hash: `sha256:${"0".repeat(64)}`,
  } as T;
  const withHash = { ...candidate, document_hash: hashModelSelectionPlan(candidate) } as T;
  const parsed = parseModelSelectionPlan(canonicalJson(withHash, ROUTING_JSON_LIMITS));
  if (!parsed.ok || parsed.value.status !== value.status) invalid();
  return parsed.value as T;
}

function blockedDecision(
  bindings: ReturnType<typeof inputBindings>,
  catalog: ModelCatalogV1,
  reasons: ReadonlyMap<string, RoutingEliminationV1["reason"]>,
  code: RoutingBlockCode,
  fallbackReason: RoutingEliminationV1["reason"],
  nextRetryAt: string | null = null,
): RoutingDecision {
  const plan = freezePlan<BlockedModelSelectionPlanV1>({
    ...bindings,
    status: "blocked",
    block_code: code,
    retryable: code === "RUNTIME_ROUTING_CIRCUIT_OPEN",
    next_retry_at: nextRetryAt,
    eliminations: completeEliminations(catalog, reasons, fallbackReason),
    document_hash: `sha256:${"0".repeat(64)}`,
  });
  return Object.freeze({ status: "blocked", plan, next_state: null });
}

function requiredCapabilities(
  request: ExecutionRequestV1,
  rule: RoutingPolicyRuleV1,
): readonly string[] | null {
  const values = new Set<string>();
  for (const value of [...request.model.required_capabilities, ...rule.required_capabilities]) {
    if (!ROUTING_CAPABILITIES.has(value)) return null;
    values.add(value);
  }
  return [...values].sort(compareAscii);
}

function effectiveLatency(task: RoutingTaskProfile, rule: RoutingPolicyRuleV1): LatencyClass {
  return LATENCY_RANK[task.max_latency_class] <= LATENCY_RANK[rule.max_latency_class]
    ? task.max_latency_class
    : rule.max_latency_class;
}

function exactLiveRoutes(
  entry: ModelCatalogEntryV1,
  catalogRoute: CatalogRouteV1,
  live: AgentgatewayCapabilitiesV1,
): readonly AgentgatewayRouteV1[] {
  return live.routes.filter(
    (route) =>
      route.alias === entry.route_alias &&
      route.route_id === catalogRoute.route_id &&
      route.provider === catalogRoute.provider &&
      route.model === catalogRoute.model,
  );
}

function routeHasCapabilities(
  entry: ModelCatalogEntryV1,
  effective: EffectiveRoute,
  required: readonly string[],
  ceilings: RoutingCallCeilings,
): boolean {
  const catalogCapabilities = effective.catalog.capabilities;
  const liveCapabilities = effective.live.capabilities;
  const booleans = {
    tools: catalogCapabilities.tools && liveCapabilities.tools,
    "json-schema": catalogCapabilities.json_schema && liveCapabilities.json_schema,
    vision: catalogCapabilities.vision && liveCapabilities.vision,
    reasoning: catalogCapabilities.reasoning && liveCapabilities.reasoning,
    streaming: catalogCapabilities.streaming && liveCapabilities.streaming,
  } as const;
  const maxOutput = Math.min(
    catalogCapabilities.max_output_tokens,
    liveCapabilities.max_output_tokens,
  );
  const maxContext = Math.min(
    catalogCapabilities.max_context_tokens,
    liveCapabilities.max_context_tokens,
  );
  if (
    ceilings.max_output_tokens > maxOutput ||
    BigInt(ceilings.max_input_tokens) + BigInt(ceilings.max_output_tokens) > BigInt(maxContext)
  ) {
    return false;
  }
  for (const capability of required) {
    if (capability === "text") continue;
    if (capability === "long-context") {
      if (!entry.logical_classes.includes("long-context")) return false;
      continue;
    }
    if (capability === "independent-review") {
      if (!entry.logical_classes.includes("independent-review")) return false;
      continue;
    }
    if (!booleans[capability as keyof typeof booleans]) return false;
  }
  return true;
}

function candidateForEntry(input: {
  readonly entry: ModelCatalogEntryV1;
  readonly rule: RoutingPolicyRuleV1;
  readonly requestClass: LogicalModelClass;
  readonly required: readonly string[];
  readonly ceilings: RoutingCallCeilings;
  readonly maxLatency: LatencyClass;
  readonly live: AgentgatewayCapabilitiesV1;
  readonly state: RoutingStateV1;
  readonly decisionMs: number;
  readonly remainingBudget: BudgetVector;
  readonly role: "reviewer" | "worker";
}): Readonly<{ candidate: Candidate | null; reason: RoutingEliminationV1["reason"] }> {
  const classRank =
    input.role === "worker"
      ? input.rule.worker_class_preference.findIndex((value) =>
          input.entry.logical_classes.includes(value),
        )
      : 0;
  if (
    (input.role === "worker" &&
      (!input.entry.logical_classes.includes(input.requestClass) || classRank < 0)) ||
    (input.role === "reviewer" && !input.entry.logical_classes.includes("independent-review"))
  ) {
    return { candidate: null, reason: "policy" };
  }

  const exact: EffectiveRoute[] = [];
  for (const catalogRoute of input.entry.routes) {
    for (const liveRoute of exactLiveRoutes(input.entry, catalogRoute, input.live)) {
      exact.push({ catalog: catalogRoute, live: liveRoute });
    }
  }
  if (exact.length === 0) return { candidate: null, reason: "live-route" };

  const capable = exact.filter((value) =>
    routeHasCapabilities(input.entry, value, input.required, input.ceilings),
  );
  if (capable.length === 0) return { candidate: null, reason: "capability" };
  const accepted = capable.filter(
    (value) => LATENCY_RANK[value.catalog.latency_class] <= LATENCY_RANK[input.maxLatency],
  );
  if (accepted.length === 0) return { candidate: null, reason: "latency" };

  accepted.sort((left, right) => compareAscii(left.catalog.route_id, right.catalog.route_id));
  let allocation = estimateRoutingAllocation({
    pricing: accepted[0]!.catalog.pricing,
    ceilings: input.ceilings,
  });
  let worstLatency = accepted[0]!.catalog.latency_class;
  for (const value of accepted.slice(1)) {
    const next = estimateRoutingAllocation({
      pricing: value.catalog.pricing,
      ceilings: input.ceilings,
    });
    if (next.cost_microusd > allocation.cost_microusd) allocation = next;
    if (LATENCY_RANK[value.catalog.latency_class] > LATENCY_RANK[worstLatency]) {
      worstLatency = value.catalog.latency_class;
    }
  }
  if (!fitsBudget(allocationBudget(allocation), input.remainingBudget)) {
    return { candidate: null, reason: "budget" };
  }
  const circuit = input.state.circuits.find((value) => value.entry_id === input.entry.entry_id);
  let probe = false;
  if (circuit?.status === "probe-reserved") return { candidate: null, reason: "circuit" };
  if (circuit?.status === "open") {
    const retryAt = timestamp(circuit.retry_at);
    if (retryAt === null) invalid();
    if (input.decisionMs < retryAt) return { candidate: null, reason: "circuit" };
    probe = true;
  }
  return {
    candidate: {
      entry: input.entry,
      class_rank: classRank,
      accepted_routes: accepted.map((value) => ({
        route_id: value.catalog.route_id,
        provider: value.catalog.provider,
        model: value.catalog.model,
        pricing: value.catalog.pricing,
      })),
      latency_class: worstLatency,
      allocation,
      probe,
    },
    reason: "policy",
  };
}

function compareCandidate(left: Candidate, right: Candidate): number {
  return (
    left.class_rank - right.class_rank ||
    left.entry.priority - right.entry.priority ||
    left.allocation.cost_microusd - right.allocation.cost_microusd ||
    LATENCY_RANK[left.latency_class] - LATENCY_RANK[right.latency_class] ||
    compareAscii(left.entry.entry_id, right.entry.entry_id)
  );
}

function routeRequirement(
  alias: string,
  required: readonly string[],
  ceilings: RoutingCallCeilings,
): ProviderRouteRequirement {
  return Object.freeze({
    schema_version: "gateway-route-requirement.v1",
    alias,
    tools: required.includes("tools"),
    json_schema: required.includes("json-schema"),
    vision: required.includes("vision"),
    reasoning: required.includes("reasoning"),
    streaming: required.includes("streaming"),
    max_output_tokens: ceilings.max_output_tokens,
  });
}

function attemptId(decision: string, role: "reviewer" | "worker", index: number): string {
  return `attempt-${decision.slice("decision-".length, "decision-".length + 32)}-${role}-${String(index).padStart(2, "0")}`;
}

function plannedDecisionHash(value: PlannedModelSelectionPlanV1): `sha256:${string}` {
  const {
    document_hash: _documentHash,
    next_state_revision: _nextStateRevision,
    next_state_hash: _nextStateHash,
    reservation,
    ...decision
  } = value;
  void _documentHash;
  void _nextStateRevision;
  void _nextStateHash;
  const { decision_hash: _decisionHash, ...reservationWithoutDecisionHash } = reservation;
  void _decisionHash;
  return sha256({ ...decision, reservation: reservationWithoutDecisionHash }, ROUTING_JSON_LIMITS);
}

function stateWithProbe(
  state: RoutingStateV1,
  primary: Candidate,
  decision: string,
): RoutingStateV1 {
  if (!primary.probe) return state;
  const circuits = state.circuits
    .map((circuit) =>
      circuit.entry_id === primary.entry.entry_id && circuit.status === "open"
        ? {
            ...circuit,
            status: "probe-reserved" as const,
            probe_decision_id: decision,
          }
        : circuit,
    )
    .sort((left, right) => compareAscii(left.entry_id, right.entry_id));
  const candidate = {
    ...state,
    circuits,
    document_hash: `sha256:${"0".repeat(64)}`,
  } as RoutingStateV1;
  const withHash = { ...candidate, document_hash: hashRoutingState(candidate) } as RoutingStateV1;
  const parsed = parseRoutingState(canonicalJson(withHash, ROUTING_JSON_LIMITS));
  if (!parsed.ok) invalid();
  return parsed.value;
}

function initialReasons(catalog: ModelCatalogV1): Map<string, RoutingEliminationV1["reason"]> {
  return new Map(catalog.entries.map((entry) => [entry.entry_id, "policy" as const]));
}

function validatedOverride(
  value: GovernedRoutingOverride | undefined,
): GovernedRoutingOverride | null {
  if (value === undefined) return null;
  try {
    assertExactDataRecord(value, ["artifact", "value"]);
    const parsed = parseGovernedRoutingOverride(value);
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

function independentRoutes(reviewer: Candidate, workers: readonly Candidate[]): boolean {
  return workers.every((worker) =>
    reviewer.accepted_routes.every((reviewRoute) =>
      worker.accepted_routes.every(
        (workerRoute) =>
          reviewRoute.provider !== workerRoute.provider && reviewRoute.model !== workerRoute.model,
      ),
    ),
  );
}

interface ReviewPairing {
  readonly primary: Candidate;
  readonly fallbacks: readonly Candidate[];
  readonly reviewer: Candidate;
  readonly reasons: ReadonlyMap<string, RoutingEliminationV1["reason"]>;
}

function chooseReviewFallbacks(input: {
  readonly candidates: readonly Candidate[];
  readonly reviewer: Candidate;
  readonly maxFallbacks: number;
  readonly baseBudget: BudgetVector;
  readonly availableBudget: BudgetVector;
}): Readonly<{
  fallbacks: readonly Candidate[];
  reasons: ReadonlyMap<string, RoutingEliminationV1["reason"]>;
}> {
  const reasons = new Map<string, RoutingEliminationV1["reason"]>();
  const valid: Candidate[] = [];
  for (const candidate of input.candidates) {
    if (candidate.probe) {
      reasons.set(candidate.entry.entry_id, "circuit");
    } else if (
      candidate.entry.entry_id === input.reviewer.entry.entry_id ||
      !independentRoutes(input.reviewer, [candidate])
    ) {
      reasons.set(candidate.entry.entry_id, "review-independence");
    } else {
      valid.push(candidate);
    }
  }
  if (valid.length === 0 || input.maxFallbacks === 0) {
    for (const candidate of valid) reasons.set(candidate.entry.entry_id, "policy");
    return Object.freeze({ fallbacks: [], reasons });
  }

  const remaining = subtractBudget(input.availableBudget, input.baseBudget);
  const firstAllocation = allocationBudget(valid[0]!.allocation);
  const nonCostLimit = [
    remaining.input_tokens / firstAllocation.input_tokens,
    remaining.output_tokens / firstAllocation.output_tokens,
    remaining.duration_ms / firstAllocation.duration_ms,
    remaining.turns / firstAllocation.turns,
    BigInt(input.maxFallbacks),
    BigInt(valid.length),
  ].reduce((minimum, value) => (value < minimum ? value : minimum));
  const countLimit = Number(nonCostLimit);
  const suffix: (bigint | null)[][] = Array.from({ length: valid.length + 1 }, () =>
    Array<bigint | null>(countLimit + 1).fill(null),
  );
  suffix[valid.length]![0] = 0n;
  for (let index = valid.length - 1; index >= 0; index -= 1) {
    suffix[index]![0] = 0n;
    const cost = BigInt(valid[index]!.allocation.cost_microusd);
    for (let count = 1; count <= countLimit; count += 1) {
      const skipped = suffix[index + 1]![count] ?? null;
      const tail = suffix[index + 1]![count - 1] ?? null;
      const taken = tail === null ? null : cost + tail;
      suffix[index]![count] =
        skipped === null ? taken : taken === null || skipped <= taken ? skipped : taken;
    }
  }

  let targetCount = countLimit;
  while (
    targetCount > 0 &&
    ((suffix[0]![targetCount] ?? null) === null ||
      (suffix[0]![targetCount] ?? 0n) > remaining.cost_microusd)
  ) {
    targetCount -= 1;
  }
  const selected: Candidate[] = [];
  let start = 0;
  let remainingCost = remaining.cost_microusd;
  for (let slots = targetCount; slots > 0; slots -= 1) {
    const choices = valid
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ index }) => index >= start && valid.length - index >= slots)
      .sort(
        (left, right) =>
          compareAscii(left.candidate.entry.entry_id, right.candidate.entry.entry_id) ||
          left.index - right.index,
      );
    const choice = choices.find(({ candidate, index }) => {
      const tail = suffix[index + 1]![slots - 1] ?? null;
      return tail !== null && BigInt(candidate.allocation.cost_microusd) + tail <= remainingCost;
    });
    if (choice === undefined) invalid();
    selected.push(choice.candidate);
    remainingCost -= BigInt(choice.candidate.allocation.cost_microusd);
    start = choice.index + 1;
  }

  const selectedIds = new Set(selected.map((candidate) => candidate.entry.entry_id));
  for (const candidate of valid) {
    if (!selectedIds.has(candidate.entry.entry_id)) {
      reasons.set(candidate.entry.entry_id, targetCount < input.maxFallbacks ? "budget" : "policy");
    }
  }
  return Object.freeze({ fallbacks: selected, reasons });
}

function chooseReviewPairing(input: {
  readonly workers: readonly Candidate[];
  readonly reviewers: readonly Candidate[];
  readonly maxFallbacks: number;
  readonly availableBudget: BudgetVector;
}): ReviewPairing | null {
  const observedReasons = new Map<string, RoutingEliminationV1["reason"]>();
  for (const [workerRank, primary] of input.workers.entries()) {
    for (const reviewer of input.reviewers) {
      if (reviewer.probe) {
        observedReasons.set(reviewer.entry.entry_id, "circuit");
        continue;
      }
      if (
        reviewer.entry.entry_id === primary.entry.entry_id ||
        !independentRoutes(reviewer, [primary])
      ) {
        observedReasons.set(reviewer.entry.entry_id, "review-independence");
        continue;
      }
      const selectedBudget = addBudget(
        allocationBudget(primary.allocation),
        allocationBudget(reviewer.allocation),
      );
      if (!fitsBudget(selectedBudget, input.availableBudget)) {
        observedReasons.set(reviewer.entry.entry_id, "budget");
        continue;
      }

      const fallbackSelection = chooseReviewFallbacks({
        candidates: input.workers.slice(workerRank + 1),
        reviewer,
        maxFallbacks: input.maxFallbacks,
        baseBudget: selectedBudget,
        availableBudget: input.availableBudget,
      });
      return Object.freeze({
        primary,
        fallbacks: fallbackSelection.fallbacks,
        reviewer,
        reasons: new Map([...observedReasons, ...fallbackSelection.reasons]),
      });
    }
    observedReasons.set(primary.entry.entry_id, "review-independence");
  }
  return null;
}

export function planModelSelection(input: PlanModelSelectionInput): RoutingDecision {
  const validated = validateInputs(input);
  const rule = matchedRule(validated.policy, input.task);
  const requestHash = hashExecutionRequest(validated.request);
  const overrideSupplied = input.override !== undefined;
  const override = validatedOverride(input.override);
  const id = decisionId({
    request_hash: requestHash,
    task: input.task,
    ceilings: input.ceilings,
    catalog_hash: validated.catalog.document_hash,
    policy_hash: validated.policy.document_hash,
    state_hash: input.state.document_hash,
    live_hash: validated.live.document_hash,
    gateway_profile: input.gateway_profile,
    decision_at: input.decision_at,
    override,
    override_supplied: overrideSupplied,
  });
  const bindings = inputBindings(input, validated, rule, id, override);
  const reasons = initialReasons(validated.catalog);

  if (
    validated.stale ||
    validated.state === null ||
    validated.state.run_id !== validated.request.run_id ||
    validated.state.request_hash !== requestHash ||
    validated.state.catalog_hash !== validated.catalog.document_hash ||
    validated.state.policy_hash !== validated.policy.document_hash ||
    !canonicalEqual(validated.state.budget, validated.request.budget)
  ) {
    return blockedDecision(
      bindings,
      validated.catalog,
      reasons,
      "RUNTIME_ROUTING_STALE_STATE",
      "policy",
    );
  }
  const state = validated.state;
  const catalogEntryIds = new Set(validated.catalog.entries.map((entry) => entry.entry_id));
  if (
    state.circuits.some((circuit) => !catalogEntryIds.has(circuit.entry_id)) ||
    !canonicalEqual(input.task.task_contract, validated.request.task_contract)
  ) {
    return blockedDecision(
      bindings,
      validated.catalog,
      reasons,
      "RUNTIME_ROUTING_STALE_STATE",
      "policy",
    );
  }
  if (state.budget_status === "unknown") {
    return blockedDecision(
      bindings,
      validated.catalog,
      reasons,
      "RUNTIME_ROUTING_USAGE_UNKNOWN",
      "budget",
    );
  }
  if (
    overrideSupplied &&
    (override === null ||
      override.value.catalog_hash !== validated.catalog.document_hash ||
      override.value.policy_hash !== validated.policy.document_hash ||
      timestamp(override.value.issued_at) === null ||
      timestamp(override.value.issued_at)! > validated.decision_ms)
  ) {
    return blockedDecision(
      bindings,
      validated.catalog,
      reasons,
      "RUNTIME_ROUTING_POLICY_DENIED",
      "override",
    );
  }
  if (!LOGICAL_CLASSES.has(validated.request.model.logical_class as LogicalModelClass)) {
    return blockedDecision(
      bindings,
      validated.catalog,
      reasons,
      "RUNTIME_ROUTING_POLICY_DENIED",
      "policy",
    );
  }
  const required = requiredCapabilities(validated.request, rule);
  if (required === null) {
    return blockedDecision(
      bindings,
      validated.catalog,
      reasons,
      "RUNTIME_ROUTING_POLICY_DENIED",
      "policy",
    );
  }

  let candidates: Candidate[] = [];
  const maxLatency = effectiveLatency(input.task, rule);
  const availableBudget = remainingBudget(state);
  for (const catalogEntry of validated.catalog.entries) {
    const evaluated = candidateForEntry({
      entry: catalogEntry,
      rule,
      requestClass: validated.request.model.logical_class as LogicalModelClass,
      required,
      ceilings: input.ceilings,
      maxLatency,
      live: validated.live,
      state,
      decisionMs: validated.decision_ms,
      remainingBudget: availableBudget,
      role: "worker",
    });
    if (evaluated.candidate === null) reasons.set(catalogEntry.entry_id, evaluated.reason);
    else candidates.push(evaluated.candidate);
  }
  candidates.sort(compareCandidate);

  if (override !== null) {
    const target = candidates.find(
      (candidate) => candidate.entry.entry_id === override.value.target_entry_id,
    );
    if (target === undefined) {
      return blockedDecision(
        bindings,
        validated.catalog,
        reasons,
        "RUNTIME_ROUTING_POLICY_DENIED",
        "override",
      );
    }
    for (const candidate of candidates) {
      if (candidate.entry.entry_id !== target.entry.entry_id) {
        reasons.set(candidate.entry.entry_id, "override");
      }
    }
    candidates = [target];
  }

  if (candidates.length === 0) {
    const circuitEntryIds = new Set(
      [...reasons].filter(([, reason]) => reason === "circuit").map(([entryId]) => entryId),
    );
    const probeReserved = state.circuits.some(
      (circuit) => circuit.status === "probe-reserved" && circuitEntryIds.has(circuit.entry_id),
    );
    if (probeReserved) {
      return blockedDecision(
        bindings,
        validated.catalog,
        reasons,
        "RUNTIME_ROUTING_STALE_STATE",
        "circuit",
      );
    }
    const requestDeadline = timestamp(validated.request.deadline);
    if (requestDeadline === null) invalid();
    const retryTimes = state.circuits
      .flatMap((circuit) =>
        circuit.status === "open" && circuitEntryIds.has(circuit.entry_id)
          ? [circuit.retry_at]
          : [],
      )
      .filter((value) => {
        const retryAt = timestamp(value);
        return (
          retryAt !== null &&
          retryAt > validated.decision_ms &&
          retryAt < requestDeadline &&
          input.ceilings.max_duration_ms <= requestDeadline - retryAt
        );
      })
      .sort(compareAscii);
    if (retryTimes.length > 0) {
      return blockedDecision(
        bindings,
        validated.catalog,
        reasons,
        "RUNTIME_ROUTING_CIRCUIT_OPEN",
        "circuit",
        retryTimes[0],
      );
    }
    if ([...reasons.values()].includes("budget")) {
      return blockedDecision(
        bindings,
        validated.catalog,
        reasons,
        "RUNTIME_ROUTING_BUDGET_EXCEEDED",
        "budget",
      );
    }
    return blockedDecision(
      bindings,
      validated.catalog,
      reasons,
      "RUNTIME_ROUTING_NO_CAPABLE_ROUTE",
      "capability",
    );
  }

  let selected: Candidate[];
  let selectedReviewer: Candidate | null = null;
  let reviewerRequired: readonly string[] = [];
  if (rule.review === "independent") {
    reviewerRequired = [...new Set([...required, "independent-review"])].sort(compareAscii);
    const reviewerCandidates: Candidate[] = [];
    const reviewerReasons = new Map<string, RoutingEliminationV1["reason"]>();
    for (const catalogEntry of validated.catalog.entries) {
      const evaluated = candidateForEntry({
        entry: catalogEntry,
        rule,
        requestClass: validated.request.model.logical_class as LogicalModelClass,
        required: reviewerRequired,
        ceilings: input.ceilings,
        maxLatency,
        live: validated.live,
        state,
        decisionMs: validated.decision_ms,
        remainingBudget: availableBudget,
        role: "reviewer",
      });
      if (evaluated.candidate === null) {
        reviewerReasons.set(catalogEntry.entry_id, evaluated.reason);
      } else {
        reviewerCandidates.push(evaluated.candidate);
      }
    }
    reviewerCandidates.sort(compareCandidate);
    const pairing = chooseReviewPairing({
      workers: candidates,
      reviewers: reviewerCandidates,
      maxFallbacks: rule.max_fallbacks,
      availableBudget,
    });
    if (pairing === null) {
      for (const candidate of candidates) {
        reasons.set(candidate.entry.entry_id, "review-independence");
      }
      for (const candidate of reviewerCandidates) {
        reasons.set(candidate.entry.entry_id, candidate.probe ? "circuit" : "review-independence");
      }
      for (const [entryId, reason] of reviewerReasons) {
        if (reasons.get(entryId) === "policy") reasons.set(entryId, reason);
      }
      return blockedDecision(
        bindings,
        validated.catalog,
        reasons,
        "RUNTIME_ROUTING_REVIEW_UNAVAILABLE",
        "review-independence",
      );
    }
    selected = [pairing.primary, ...pairing.fallbacks];
    selectedReviewer = pairing.reviewer;
    for (const [entryId, reason] of reviewerReasons) {
      if (reasons.get(entryId) === "policy") reasons.set(entryId, reason);
    }
    for (const [entryId, reason] of pairing.reasons) reasons.set(entryId, reason);
    for (const candidate of reviewerCandidates) {
      if (candidate.entry.entry_id !== selectedReviewer.entry.entry_id) {
        reasons.set(
          candidate.entry.entry_id,
          pairing.reasons.get(candidate.entry.entry_id) ?? "review-independence",
        );
      }
    }
  } else {
    const primary = candidates[0]!;
    selected = [primary];
    let selectedBudget = allocationBudget(primary.allocation);
    for (const candidate of candidates.slice(1)) {
      if (candidate.probe) {
        reasons.set(candidate.entry.entry_id, "circuit");
        continue;
      }
      if (selected.length > rule.max_fallbacks) {
        reasons.set(candidate.entry.entry_id, "policy");
        continue;
      }
      const combinedBudget = addBudget(selectedBudget, allocationBudget(candidate.allocation));
      if (!fitsBudget(combinedBudget, availableBudget)) {
        reasons.set(candidate.entry.entry_id, "budget");
        continue;
      }
      selected.push(candidate);
      selectedBudget = combinedBudget;
    }
  }
  const primary = selected[0]!;
  for (const candidate of selected) reasons.delete(candidate.entry.entry_id);
  if (selectedReviewer !== null) reasons.delete(selectedReviewer.entry.entry_id);

  const workerAttempts = selected.map((candidate, index) => {
    const requirement = routeRequirement(candidate.entry.route_alias, required, input.ceilings);
    return {
      attempt_id: attemptId(id, "worker", index),
      role: "worker" as const,
      fallback_index: index,
      entry_id: candidate.entry.entry_id,
      alias: candidate.entry.route_alias,
      gateway_profile: input.gateway_profile,
      gateway_revision: validated.live.gateway.revision,
      capability_document_hash: validated.live.document_hash,
      latency_class: candidate.latency_class,
      requirement,
      requirement_hash: hashProviderRouteRequirement(requirement),
      accepted_routes: candidate.accepted_routes,
      reserved_cost_microusd: candidate.allocation.cost_microusd,
    };
  });
  const reviewerAttempt =
    selectedReviewer === null
      ? null
      : (() => {
          const requirement = routeRequirement(
            selectedReviewer.entry.route_alias,
            reviewerRequired,
            input.ceilings,
          );
          return {
            attempt_id: attemptId(id, "reviewer", 0),
            role: "reviewer" as const,
            fallback_index: null,
            entry_id: selectedReviewer.entry.entry_id,
            alias: selectedReviewer.entry.route_alias,
            gateway_profile: input.gateway_profile,
            gateway_revision: validated.live.gateway.revision,
            capability_document_hash: validated.live.document_hash,
            latency_class: selectedReviewer.latency_class,
            requirement,
            requirement_hash: hashProviderRouteRequirement(requirement),
            accepted_routes: selectedReviewer.accepted_routes,
            reserved_cost_microusd: selectedReviewer.allocation.cost_microusd,
          };
        })();
  const allocations = [
    ...selected.map((candidate, index) => ({
      attempt_id: attemptId(id, "worker", index),
      entry_id: candidate.entry.entry_id,
      role: "worker" as const,
      input_tokens: candidate.allocation.input_tokens,
      output_tokens: candidate.allocation.output_tokens,
      cost_microusd: candidate.allocation.cost_microusd,
      duration_ms: candidate.allocation.duration_ms,
      turns: 1 as const,
    })),
    ...(selectedReviewer === null
      ? []
      : [
          {
            attempt_id: attemptId(id, "reviewer", 0),
            entry_id: selectedReviewer.entry.entry_id,
            role: "reviewer" as const,
            input_tokens: selectedReviewer.allocation.input_tokens,
            output_tokens: selectedReviewer.allocation.output_tokens,
            cost_microusd: selectedReviewer.allocation.cost_microusd,
            duration_ms: selectedReviewer.allocation.duration_ms,
            turns: 1 as const,
          },
        ]),
  ].sort((left, right) => compareAscii(left.attempt_id, right.attempt_id));
  const reservation: RoutingReservationV1 = {
    decision_id: id,
    decision_hash: `sha256:${"0".repeat(64)}`,
    request_id: validated.request.request_id,
    allocations,
    created_at: input.decision_at,
  };
  let draft: PlannedModelSelectionPlanV1 = {
    ...bindings,
    status: "planned",
    worker_attempts: workerAttempts,
    reviewer_attempt: reviewerAttempt,
    reservation,
    next_state_revision: state.revision + 1,
    next_state_hash: `sha256:${"0".repeat(64)}`,
    eliminations: sortedEliminations(reasons),
    document_hash: `sha256:${"0".repeat(64)}`,
  };
  draft = {
    ...draft,
    reservation: { ...reservation, decision_hash: plannedDecisionHash(draft) },
  };

  let nextState: RoutingStateV1;
  try {
    nextState = reserveRoutingBudget({ state, reservation: draft.reservation });
  } catch (error) {
    if (error instanceof RuntimeRoutingError) {
      if (error.code === "RUNTIME_ROUTING_BUDGET_EXCEEDED") {
        return blockedDecision(
          bindings,
          validated.catalog,
          reasons,
          "RUNTIME_ROUTING_BUDGET_EXCEEDED",
          "budget",
        );
      }
      if (error.code === "RUNTIME_ROUTING_USAGE_UNKNOWN") {
        return blockedDecision(
          bindings,
          validated.catalog,
          reasons,
          "RUNTIME_ROUTING_USAGE_UNKNOWN",
          "budget",
        );
      }
      if (error.code === "RUNTIME_ROUTING_STALE_STATE") {
        return blockedDecision(
          bindings,
          validated.catalog,
          reasons,
          "RUNTIME_ROUTING_STALE_STATE",
          "circuit",
        );
      }
    }
    throw error;
  }
  nextState = stateWithProbe(nextState, primary, id);
  const plan = freezePlan<PlannedModelSelectionPlanV1>({
    ...draft,
    next_state_revision: nextState.revision,
    next_state_hash: nextState.document_hash,
  });
  return Object.freeze({ status: "planned", plan, next_state: nextState });
}
