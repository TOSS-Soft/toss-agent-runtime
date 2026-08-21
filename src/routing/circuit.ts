import { canonicalJson, sha256, type JsonLimits } from "../protocol/json.js";
import { isRuntimeProviderErrorCode, type RuntimeProviderErrorCode } from "../providers/errors.js";
import type { ProviderRouteIdentity } from "../providers/types.js";
import {
  hashModelSelectionPlan,
  hashRoutingPolicy,
  hashRoutingState,
  parseModelSelectionPlan,
  parseRoutingPolicy,
  parseRoutingState,
} from "./contracts.js";
import { calculateRoutingCost } from "./cost.js";
import { RuntimeRoutingError, type RuntimeRoutingErrorCode } from "./errors.js";
import type {
  ModelFallbackDecision,
  PlannedModelSelectionPlanV1,
  RecordedRoutingOutcome,
  RoutingAttemptResult,
  RoutingAttemptV1,
  RoutingCircuitV1,
  RoutingPolicyRuleV1,
  RoutingPolicyV1,
  RoutingOutcomeTransition,
  RoutingProviderOutcome,
  RoutingReservationV1,
  RoutingStateV1,
} from "./types.js";

const ROUTING_RUNTIME_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxMembers: 100_000,
});
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const FALLBACK_OUTCOMES = new Set<RuntimeProviderErrorCode>([
  "RUNTIME_PROVIDER_TIMEOUT",
  "RUNTIME_PROVIDER_TRANSIENT",
  "RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE",
]);

interface BudgetTotals {
  readonly input_tokens: bigint;
  readonly output_tokens: bigint;
  readonly cost_microusd: bigint;
  readonly duration_ms: bigint;
  readonly turns: bigint;
}

function invalid(): never {
  throw new RuntimeRoutingError("RUNTIME_ROUTING_INVALID");
}

function stale(): never {
  throw new RuntimeRoutingError("RUNTIME_ROUTING_STALE_STATE");
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeNonnegative(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return BigInt(value);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return (
      canonicalJson(left, ROUTING_RUNTIME_JSON_LIMITS) ===
      canonicalJson(right, ROUTING_RUNTIME_JSON_LIMITS)
    );
  } catch {
    return false;
  }
}

function timestamp(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null;
  return milliseconds;
}

function stateOrThrow(value: RoutingStateV1): RoutingStateV1 {
  let expectedHash: `sha256:${string}`;
  try {
    expectedHash = hashRoutingState(value);
  } catch {
    invalid();
  }
  if (expectedHash !== value.document_hash) stale();
  const parsed = parseRoutingState(canonicalJson(value, ROUTING_RUNTIME_JSON_LIMITS));
  if (!parsed.ok) invalid();
  return parsed.value;
}

function planOrThrow(value: PlannedModelSelectionPlanV1): PlannedModelSelectionPlanV1 {
  let expectedHash: `sha256:${string}`;
  try {
    expectedHash = hashModelSelectionPlan(value);
  } catch {
    invalid();
  }
  if (expectedHash !== value.document_hash) invalid();
  const parsed = parseModelSelectionPlan(canonicalJson(value, ROUTING_RUNTIME_JSON_LIMITS));
  if (!parsed.ok || parsed.value.status !== "planned") invalid();
  return parsed.value;
}

function policyOrThrow(value: RoutingPolicyV1): RoutingPolicyV1 {
  let expectedHash: `sha256:${string}`;
  try {
    expectedHash = hashRoutingPolicy(value);
  } catch {
    invalid();
  }
  if (expectedHash !== value.document_hash) invalid();
  const parsed = parseRoutingPolicy(canonicalJson(value, ROUTING_RUNTIME_JSON_LIMITS));
  if (!parsed.ok) invalid();
  return parsed.value;
}

function exactReservation(
  state: RoutingStateV1,
  plan: PlannedModelSelectionPlanV1,
): RoutingReservationV1 {
  const matches = state.reservations.filter(
    (reservation) => reservation.decision_id === plan.decision_id,
  );
  if (matches.length !== 1 || !canonicalEqual(matches[0], plan.reservation)) stale();
  return matches[0] as RoutingReservationV1;
}

function assertLivePlanState(
  state: RoutingStateV1,
  plan: PlannedModelSelectionPlanV1,
): RoutingReservationV1 {
  if (
    state.state_id !== plan.prior_state_id ||
    state.run_id !== plan.run_id ||
    state.request_hash !== plan.request_hash ||
    state.catalog_hash !== plan.catalog_hash ||
    state.policy_hash !== plan.policy_hash ||
    state.revision < plan.next_state_revision ||
    (state.revision === plan.next_state_revision && state.document_hash !== plan.next_state_hash)
  ) {
    stale();
  }
  return exactReservation(state, plan);
}

function attemptOrThrow(plan: PlannedModelSelectionPlanV1, attemptId: string): RoutingAttemptV1 {
  const attempts = [
    ...plan.worker_attempts,
    ...(plan.reviewer_attempt === null ? [] : [plan.reviewer_attempt]),
  ].filter((attempt) => attempt.attempt_id === attemptId);
  if (attempts.length !== 1) invalid();
  return attempts[0] as RoutingAttemptV1;
}

function matchedRuleOrThrow(
  policy: RoutingPolicyV1,
  plan: PlannedModelSelectionPlanV1,
): RoutingPolicyRuleV1 {
  if (
    policy.policy_id !== plan.policy_id ||
    policy.revision !== plan.policy_revision ||
    policy.document_hash !== plan.policy_hash
  ) {
    stale();
  }
  const rules = policy.rules.filter((rule) => rule.rule_id === plan.matched_rule_id);
  if (rules.length !== 1) stale();
  return rules[0] as RoutingPolicyRuleV1;
}

function freezeState(state: RoutingStateV1, circuits: readonly RoutingCircuitV1[]): RoutingStateV1 {
  if (state.revision >= Number.MAX_SAFE_INTEGER) invalid();
  const candidate = {
    ...state,
    revision: state.revision + 1,
    previous_state_hash: state.document_hash,
    circuits: [...circuits].sort((left, right) => compareAscii(left.entry_id, right.entry_id)),
    document_hash: `sha256:${"0".repeat(64)}`,
  } as RoutingStateV1;
  const withHash = {
    ...candidate,
    document_hash: hashRoutingState(candidate),
  } as RoutingStateV1;
  const parsed = parseRoutingState(canonicalJson(withHash, ROUTING_RUNTIME_JSON_LIMITS));
  if (!parsed.ok) invalid();
  return parsed.value;
}

function changedCircuit(current: RoutingCircuitV1 | undefined, next: RoutingCircuitV1): boolean {
  return current === undefined || !canonicalEqual(current, next);
}

function cooldownAt(occurredAtMs: number, cooldownMs: number): string {
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs <= 0) invalid();
  const result = occurredAtMs + cooldownMs;
  if (!Number.isSafeInteger(result)) invalid();
  try {
    return new Date(result).toISOString();
  } catch {
    return invalid();
  }
}

function withEntryCircuit(
  state: RoutingStateV1,
  entryId: string,
  replacement: RoutingCircuitV1,
): RoutingStateV1 {
  const existing = state.circuits.find((circuit) => circuit.entry_id === entryId);
  if (!changedCircuit(existing, replacement)) return state;
  const circuits = [
    ...state.circuits.filter((circuit) => circuit.entry_id !== entryId),
    replacement,
  ];
  return freezeState(state, circuits);
}

function recordedOutcome(input: {
  readonly previous_state: RoutingStateV1;
  readonly state: RoutingStateV1;
  readonly plan: PlannedModelSelectionPlanV1;
  readonly policy: RoutingPolicyV1;
  readonly attempt_id: string;
  readonly outcome: RoutingProviderOutcome;
  readonly occurred_at: string;
}): RecordedRoutingOutcome {
  const projection = Object.freeze({
    previous_state_hash: input.previous_state.document_hash,
    next_state_hash: input.state.document_hash,
    decision_id: input.plan.decision_id,
    attempt_id: input.attempt_id,
    outcome: input.outcome,
    occurred_at: input.occurred_at,
    policy_hash: input.policy.document_hash,
  });
  const transition: RoutingOutcomeTransition = Object.freeze({
    ...projection,
    transition_hash: sha256(projection, ROUTING_RUNTIME_JSON_LIMITS),
  });
  return Object.freeze({ state: input.state, transition });
}

function transitionOrNull(value: RoutingOutcomeTransition): RoutingOutcomeTransition | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return null;
  }
  const keys = [
    "attempt_id",
    "decision_id",
    "next_state_hash",
    "occurred_at",
    "outcome",
    "policy_hash",
    "previous_state_hash",
    "transition_hash",
  ];
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    symbols.length !== 0 ||
    Object.keys(descriptors).sort().join("\u0000") !== keys.sort().join("\u0000")
  ) {
    return null;
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return null;
    }
  }
  if (
    typeof value.attempt_id !== "string" ||
    typeof value.decision_id !== "string" ||
    typeof value.next_state_hash !== "string" ||
    typeof value.occurred_at !== "string" ||
    typeof value.outcome !== "string" ||
    typeof value.policy_hash !== "string" ||
    typeof value.previous_state_hash !== "string" ||
    typeof value.transition_hash !== "string" ||
    timestamp(value.occurred_at) === null ||
    (value.outcome !== "RUNTIME_PROVIDER_SUCCESS" && !isRuntimeProviderErrorCode(value.outcome))
  ) {
    return null;
  }
  const { transition_hash: transitionHash, ...projection } = value;
  try {
    if (sha256(projection, ROUTING_RUNTIME_JSON_LIMITS) !== transitionHash) return null;
  } catch {
    return null;
  }
  return value;
}

export function recordRoutingOutcome(input: {
  readonly state: RoutingStateV1;
  readonly plan: PlannedModelSelectionPlanV1;
  readonly policy: RoutingPolicyV1;
  readonly attempt_id: string;
  readonly outcome: RoutingProviderOutcome;
  readonly occurred_at: string;
}): RecordedRoutingOutcome {
  const occurredAtMs = timestamp(input.occurred_at);
  const plan = planOrThrow(input.plan);
  const decisionAtMs = timestamp(plan.decision_at);
  if (occurredAtMs === null || decisionAtMs === null || occurredAtMs < decisionAtMs) invalid();
  const state = stateOrThrow(input.state);
  assertLivePlanState(state, plan);
  const policy = policyOrThrow(input.policy);
  const rule = matchedRuleOrThrow(policy, plan);
  const attempt = attemptOrThrow(plan, input.attempt_id);
  if (input.outcome !== "RUNTIME_PROVIDER_SUCCESS" && !isRuntimeProviderErrorCode(input.outcome)) {
    invalid();
  }

  const unresolvedOtherProbe = state.circuits.some(
    (circuit) =>
      circuit.status === "probe-reserved" &&
      circuit.probe_decision_id === plan.decision_id &&
      circuit.entry_id !== attempt.entry_id,
  );
  if (unresolvedOtherProbe) stale();
  const current = state.circuits.find((circuit) => circuit.entry_id === attempt.entry_id);
  if (
    current?.status === "open" ||
    (current?.status === "probe-reserved" && current.probe_decision_id !== plan.decision_id)
  ) {
    stale();
  }

  if (input.outcome === "RUNTIME_PROVIDER_SUCCESS") {
    if (
      current === undefined ||
      (current.status === "closed" && current.consecutive_failures === 0)
    ) {
      return recordedOutcome({
        previous_state: state,
        state: input.state,
        plan,
        policy,
        attempt_id: attempt.attempt_id,
        outcome: input.outcome,
        occurred_at: input.occurred_at,
      });
    }
    const nextState = withEntryCircuit(state, attempt.entry_id, {
      entry_id: attempt.entry_id,
      status: "closed",
      consecutive_failures: 0,
      retry_at: null,
      probe_decision_id: null,
    });
    return recordedOutcome({
      previous_state: state,
      state: nextState,
      plan,
      policy,
      attempt_id: attempt.attempt_id,
      outcome: input.outcome,
      occurred_at: input.occurred_at,
    });
  }

  if (!FALLBACK_OUTCOMES.has(input.outcome)) {
    const nextState =
      current?.status !== "probe-reserved"
        ? input.state
        : withEntryCircuit(state, attempt.entry_id, {
            entry_id: attempt.entry_id,
            status: "open",
            consecutive_failures: current.consecutive_failures,
            retry_at: current.retry_at,
            probe_decision_id: null,
          });
    return recordedOutcome({
      previous_state: state,
      state: nextState,
      plan,
      policy,
      attempt_id: attempt.attempt_id,
      outcome: input.outcome,
      occurred_at: input.occurred_at,
    });
  }
  const consecutiveFailures = (current?.consecutive_failures ?? 0) + 1;
  if (!Number.isSafeInteger(consecutiveFailures)) invalid();
  const opens =
    current?.status === "probe-reserved" ||
    consecutiveFailures >= rule.circuit.consecutive_failure_threshold;
  const next: RoutingCircuitV1 = opens
    ? {
        entry_id: attempt.entry_id,
        status: "open",
        consecutive_failures: consecutiveFailures,
        retry_at: cooldownAt(occurredAtMs, rule.circuit.cooldown_ms),
        probe_decision_id: null,
      }
    : {
        entry_id: attempt.entry_id,
        status: "closed",
        consecutive_failures: consecutiveFailures,
        retry_at: null,
        probe_decision_id: null,
      };
  const nextState = withEntryCircuit(state, attempt.entry_id, next);
  return recordedOutcome({
    previous_state: state,
    state: nextState,
    plan,
    policy,
    attempt_id: attempt.attempt_id,
    outcome: input.outcome,
    occurred_at: input.occurred_at,
  });
}

function blocked(code: RuntimeRoutingErrorCode): ModelFallbackDecision {
  return Object.freeze({
    status: "blocked" as const,
    code,
    retryable: code === "RUNTIME_ROUTING_CIRCUIT_OPEN",
  });
}

function zeroTotals(): BudgetTotals {
  return {
    input_tokens: 0n,
    output_tokens: 0n,
    cost_microusd: 0n,
    duration_ms: 0n,
    turns: 0n,
  };
}

function addTotals(left: BudgetTotals, right: BudgetTotals): BudgetTotals {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    cost_microusd: left.cost_microusd + right.cost_microusd,
    duration_ms: left.duration_ms + right.duration_ms,
    turns: left.turns + right.turns,
  };
}

function allocationTotals(allocation: RoutingReservationV1["allocations"][number]): BudgetTotals {
  if (allocation.turns !== 1) invalid();
  return {
    input_tokens: safeNonnegative(allocation.input_tokens),
    output_tokens: safeNonnegative(allocation.output_tokens),
    cost_microusd: safeNonnegative(allocation.cost_microusd),
    duration_ms: safeNonnegative(allocation.duration_ms),
    turns: 1n,
  };
}

function settledTotals(state: RoutingStateV1): BudgetTotals | null {
  if (state.budget_status !== "known" || state.settled.cost_microusd === null) return null;
  return {
    input_tokens: safeNonnegative(state.settled.input_tokens),
    output_tokens: safeNonnegative(state.settled.output_tokens),
    cost_microusd: safeNonnegative(state.settled.cost_microusd),
    duration_ms: safeNonnegative(state.settled.duration_ms),
    turns: safeNonnegative(state.settled.turns),
  };
}

function routeMatchesAttempt(identity: ProviderRouteIdentity, attempt: RoutingAttemptV1): boolean {
  if (
    identity.transport !== "agentgateway" ||
    identity.gateway_profile !== attempt.gateway_profile ||
    identity.gateway_revision !== attempt.gateway_revision ||
    identity.requested_model !== attempt.alias ||
    identity.capability_document_hash !== attempt.capability_document_hash ||
    identity.requirement_hash !== attempt.requirement_hash
  ) {
    return false;
  }
  return attempt.accepted_routes.some(
    (route) =>
      route.route_id === identity.route_id &&
      route.provider === identity.resolved_provider &&
      route.model === identity.resolved_model,
  );
}

function actualResultTotals(
  result: RoutingAttemptResult,
  attempt: RoutingAttemptV1,
): BudgetTotals | RuntimeRoutingErrorCode {
  const duration = safeNonnegative(result.duration_ms);
  const hasRoute = result.route_identity !== null;
  const hasUsage = result.usage !== null;
  if (result.effect_may_have_occurred && (!hasRoute || !hasUsage)) {
    return "RUNTIME_ROUTING_USAGE_UNKNOWN";
  }
  if (hasRoute !== hasUsage) return "RUNTIME_ROUTING_USAGE_UNKNOWN";
  if (!hasRoute || !hasUsage) {
    return {
      ...zeroTotals(),
      duration_ms: duration,
      turns: 1n,
    };
  }
  const identity = result.route_identity;
  const usage = result.usage;
  if (!routeMatchesAttempt(identity, attempt)) return "RUNTIME_ROUTING_RESOLUTION_MISMATCH";
  const route = attempt.accepted_routes.find(
    (candidate) =>
      candidate.route_id === identity.route_id &&
      candidate.provider === identity.resolved_provider &&
      candidate.model === identity.resolved_model,
  );
  if (route === undefined) return "RUNTIME_ROUTING_RESOLUTION_MISMATCH";
  let cost: number;
  try {
    cost = calculateRoutingCost(route.pricing, usage);
  } catch (error) {
    if (error instanceof RuntimeRoutingError) return error.code;
    throw error;
  }
  return {
    input_tokens: safeNonnegative(usage.input_tokens),
    output_tokens: safeNonnegative(usage.output_tokens),
    cost_microusd: safeNonnegative(cost),
    duration_ms: duration,
    turns: 1n,
  };
}

function exceedsBudget(state: RoutingStateV1, totals: BudgetTotals): boolean {
  return (
    totals.input_tokens > safeNonnegative(state.budget.max_input_tokens) ||
    totals.output_tokens > safeNonnegative(state.budget.max_output_tokens) ||
    totals.cost_microusd > safeNonnegative(state.budget.max_cost_microusd) ||
    totals.duration_ms > safeNonnegative(state.budget.max_duration_ms) ||
    totals.turns > safeNonnegative(state.budget.max_turns) ||
    totals.input_tokens > MAX_SAFE_INTEGER ||
    totals.output_tokens > MAX_SAFE_INTEGER ||
    totals.cost_microusd > MAX_SAFE_INTEGER ||
    totals.duration_ms > MAX_SAFE_INTEGER ||
    totals.turns > MAX_SAFE_INTEGER
  );
}

function cumulativeBudget(
  state: RoutingStateV1,
  plan: PlannedModelSelectionPlanV1,
  results: readonly RoutingAttemptResult[],
  attempts: readonly RoutingAttemptV1[],
): BudgetTotals | RuntimeRoutingErrorCode {
  let totals = settledTotals(state);
  if (totals === null) return "RUNTIME_ROUTING_USAGE_UNKNOWN";
  for (const reservation of state.reservations) {
    if (reservation.decision_id === plan.decision_id) continue;
    for (const allocation of reservation.allocations) {
      totals = addTotals(totals, allocationTotals(allocation));
    }
  }

  const attemptedIds = new Set(results.map((result) => result.attempt_id));
  for (const allocation of plan.reservation.allocations) {
    if (!attemptedIds.has(allocation.attempt_id)) {
      totals = addTotals(totals, allocationTotals(allocation));
    }
  }
  for (const [index, result] of results.entries()) {
    const attempt = attempts[index];
    if (attempt === undefined) return "RUNTIME_ROUTING_STALE_STATE";
    const actual = actualResultTotals(result, attempt);
    if (typeof actual === "string") return actual;
    totals = addTotals(totals, actual);
  }
  return totals;
}

export function nextModelFallback(input: {
  readonly state: RoutingStateV1;
  readonly previous_state: RoutingStateV1;
  readonly plan: PlannedModelSelectionPlanV1;
  readonly policy: RoutingPolicyV1;
  readonly transition: RoutingOutcomeTransition;
  readonly current_attempt_id: string;
  readonly outcome: RuntimeProviderErrorCode;
  readonly occurred_at: string;
  readonly attempt_results: readonly RoutingAttemptResult[];
  readonly remaining_duration_ms: number;
}): ModelFallbackDecision {
  const plan = planOrThrow(input.plan);
  const state = stateOrThrow(input.state);
  const previousState = stateOrThrow(input.previous_state);
  assertLivePlanState(state, plan);
  assertLivePlanState(previousState, plan);
  if (!isRuntimeProviderErrorCode(input.outcome)) invalid();
  const currentIndex = plan.worker_attempts.findIndex(
    (attempt) => attempt.attempt_id === input.current_attempt_id,
  );
  if (currentIndex < 0) invalid();
  const transition = transitionOrNull(input.transition);
  if (transition === null) return blocked("RUNTIME_ROUTING_STALE_STATE");
  let recomputed: RecordedRoutingOutcome;
  try {
    recomputed = recordRoutingOutcome({
      state: previousState,
      plan,
      policy: input.policy,
      attempt_id: input.current_attempt_id,
      outcome: input.outcome,
      occurred_at: input.occurred_at,
    });
  } catch (error) {
    if (error instanceof RuntimeRoutingError) return blocked(error.code);
    throw error;
  }
  if (
    !canonicalEqual(recomputed.state, state) ||
    !canonicalEqual(recomputed.transition, transition) ||
    transition.previous_state_hash !== previousState.document_hash ||
    transition.next_state_hash !== state.document_hash ||
    transition.decision_id !== plan.decision_id ||
    transition.attempt_id !== input.current_attempt_id ||
    transition.outcome !== input.outcome ||
    transition.occurred_at !== input.occurred_at ||
    transition.policy_hash !== input.policy.document_hash
  ) {
    return blocked("RUNTIME_ROUTING_STALE_STATE");
  }
  const prefix = plan.worker_attempts.slice(0, currentIndex + 1);
  if (
    input.attempt_results.length !== prefix.length ||
    input.attempt_results.some(
      (result, index) => result.attempt_id !== prefix[index]?.attempt_id,
    ) ||
    new Set(input.attempt_results.map((result) => result.attempt_id)).size !==
      input.attempt_results.length
  ) {
    return blocked("RUNTIME_ROUTING_STALE_STATE");
  }

  const budget = cumulativeBudget(state, plan, input.attempt_results, prefix);
  if (typeof budget === "string") return blocked(budget);
  if (!FALLBACK_OUTCOMES.has(input.outcome)) {
    return blocked("RUNTIME_ROUTING_POLICY_DENIED");
  }
  if (exceedsBudget(state, budget)) return blocked("RUNTIME_ROUTING_BUDGET_EXCEEDED");

  const nextAttempt = plan.worker_attempts[currentIndex + 1];
  if (nextAttempt === undefined) return blocked("RUNTIME_ROUTING_NO_CAPABLE_ROUTE");
  if (
    !Number.isSafeInteger(input.remaining_duration_ms) ||
    input.remaining_duration_ms <= 0 ||
    input.remaining_duration_ms <
      (plan.reservation.allocations.find(
        (allocation) => allocation.attempt_id === nextAttempt.attempt_id,
      )?.duration_ms ?? Number.MAX_SAFE_INTEGER)
  ) {
    return blocked("RUNTIME_ROUTING_BUDGET_EXCEEDED");
  }
  const nextCircuit = state.circuits.find((circuit) => circuit.entry_id === nextAttempt.entry_id);
  if (nextCircuit !== undefined && nextCircuit.status !== "closed") {
    return blocked("RUNTIME_ROUTING_CIRCUIT_OPEN");
  }

  return Object.freeze({ status: "ready", attempt: nextAttempt });
}
