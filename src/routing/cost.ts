import { canonicalJson, type JsonLimits } from "../protocol/json.js";
import type { UsageSummary } from "../protocol/types.js";
import type { ProviderRouteIdentity, ProviderUsage } from "../providers/types.js";
import {
  hashModelSelectionPlan,
  hashRoutingState,
  parseModelSelectionPlan,
  parseRoutingState,
} from "./contracts.js";
import { RuntimeRoutingError } from "./errors.js";
import type {
  CatalogPricingV1,
  PlannedModelSelectionPlanV1,
  RoutingAcceptedRouteV1,
  RoutingAttemptResult,
  RoutingCallCeilings,
  RoutingReservationV1,
  RoutingStateV1,
} from "./types.js";

export type { RoutingAttemptResult } from "./types.js";

const MICROS_PER_UNIT = 1_000_000n;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const ROUTING_RUNTIME_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxMembers: 100_000,
});

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

function assertSafeNonnegative(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
}

function safeBigInt(value: number): bigint {
  assertSafeNonnegative(value);
  return BigInt(value);
}

function safeNumber(value: bigint): number {
  if (value < 0n || value > MAX_SAFE_INTEGER) invalid();
  return Number(value);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function pricedComponent(tokens: number, microusdPerMillion: number): bigint {
  return ceilDiv(safeBigInt(tokens) * safeBigInt(microusdPerMillion), MICROS_PER_UNIT);
}

function worstCaseTwoComponentCost(
  totalTokens: number,
  firstRate: number,
  secondRate: number,
): bigint {
  const total = safeBigInt(totalTokens);
  const first = safeBigInt(firstRate);
  const second = safeBigInt(secondRate);
  const maximumRate = first > second ? first : second;
  const splitRoundingSlack = total >= 2n && first > 0n && second > 0n ? 1n : 0n;
  return ceilDiv(total * maximumRate, MICROS_PER_UNIT) + splitRoundingSlack;
}

function validatePricing(pricing: CatalogPricingV1): void {
  assertSafeNonnegative(pricing.input_microusd_per_million);
  assertSafeNonnegative(pricing.cached_input_microusd_per_million);
  assertSafeNonnegative(pricing.output_microusd_per_million);
  assertSafeNonnegative(pricing.reasoning_output_microusd_per_million);
}

function isCanonicalUtcTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function stateOrThrow(state: RoutingStateV1): RoutingStateV1 {
  let expectedHash: `sha256:${string}`;
  try {
    expectedHash = hashRoutingState(state);
  } catch {
    invalid();
  }
  if (expectedHash !== state.document_hash) {
    throw new RuntimeRoutingError("RUNTIME_ROUTING_STALE_STATE");
  }
  const parsed = parseRoutingState(canonicalJson(state, ROUTING_RUNTIME_JSON_LIMITS));
  if (!parsed.ok) invalid();
  return parsed.value;
}

function planOrThrow(plan: PlannedModelSelectionPlanV1): PlannedModelSelectionPlanV1 {
  let expectedHash: `sha256:${string}`;
  try {
    expectedHash = hashModelSelectionPlan(plan);
  } catch {
    invalid();
  }
  if (expectedHash !== plan.document_hash) invalid();
  const parsed = parseModelSelectionPlan(canonicalJson(plan, ROUTING_RUNTIME_JSON_LIMITS));
  if (!parsed.ok || parsed.value.status !== "planned") invalid();
  return parsed.value;
}

function totalsFromReservation(reservation: RoutingReservationV1): BudgetTotals {
  let inputTokens = 0n;
  let outputTokens = 0n;
  let costMicrousd = 0n;
  let durationMs = 0n;
  let turns = 0n;
  for (const allocation of reservation.allocations) {
    inputTokens += safeBigInt(allocation.input_tokens);
    outputTokens += safeBigInt(allocation.output_tokens);
    costMicrousd += safeBigInt(allocation.cost_microusd);
    durationMs += safeBigInt(allocation.duration_ms);
    if (allocation.turns !== 1) invalid();
    turns += 1n;
  }
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_microusd: costMicrousd,
    duration_ms: durationMs,
    turns,
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

function totalsFromState(state: RoutingStateV1): BudgetTotals {
  if (state.settled.cost_microusd === null) invalid();
  let totals: BudgetTotals = {
    input_tokens: safeBigInt(state.settled.input_tokens),
    output_tokens: safeBigInt(state.settled.output_tokens),
    cost_microusd: safeBigInt(state.settled.cost_microusd),
    duration_ms: safeBigInt(state.settled.duration_ms),
    turns: safeBigInt(state.settled.turns),
  };
  for (const reservation of state.reservations) {
    totals = addTotals(totals, totalsFromReservation(reservation));
  }
  return totals;
}

function exceedsBudget(state: RoutingStateV1, totals: BudgetTotals): boolean {
  return (
    totals.input_tokens > safeBigInt(state.budget.max_input_tokens) ||
    totals.output_tokens > safeBigInt(state.budget.max_output_tokens) ||
    totals.cost_microusd > safeBigInt(state.budget.max_cost_microusd) ||
    totals.duration_ms > safeBigInt(state.budget.max_duration_ms) ||
    totals.turns > safeBigInt(state.budget.max_turns)
  );
}

function freezeState(value: Omit<RoutingStateV1, "document_hash">): RoutingStateV1 {
  const candidate = { ...value, document_hash: `sha256:${"0".repeat(64)}` } as RoutingStateV1;
  const withHash = { ...candidate, document_hash: hashRoutingState(candidate) };
  const parsed = parseRoutingState(canonicalJson(withHash, ROUTING_RUNTIME_JSON_LIMITS));
  if (!parsed.ok) invalid();
  return parsed.value;
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

function reservationAttemptIds(reservations: readonly RoutingReservationV1[]): Set<string> {
  const result = new Set<string>();
  for (const reservation of reservations) {
    for (const allocation of reservation.allocations) {
      if (result.has(allocation.attempt_id)) invalid();
      result.add(allocation.attempt_id);
    }
  }
  return result;
}

export function calculateRoutingCost(pricing: CatalogPricingV1, usage: ProviderUsage): number {
  validatePricing(pricing);
  assertSafeNonnegative(usage.input_tokens);
  assertSafeNonnegative(usage.output_tokens);
  const cachedInputTokens = usage.cached_input_tokens ?? 0;
  const reasoningTokens = usage.reasoning_tokens ?? 0;
  assertSafeNonnegative(cachedInputTokens);
  assertSafeNonnegative(reasoningTokens);
  if (cachedInputTokens > usage.input_tokens || reasoningTokens > usage.output_tokens) invalid();

  const uncachedInputTokens = usage.input_tokens - cachedInputTokens;
  const ordinaryOutputTokens = usage.output_tokens - reasoningTokens;
  const total =
    pricedComponent(uncachedInputTokens, pricing.input_microusd_per_million) +
    pricedComponent(cachedInputTokens, pricing.cached_input_microusd_per_million) +
    pricedComponent(ordinaryOutputTokens, pricing.output_microusd_per_million) +
    pricedComponent(reasoningTokens, pricing.reasoning_output_microusd_per_million);
  return safeNumber(total);
}

export function estimateRoutingAllocation(input: {
  readonly pricing: CatalogPricingV1;
  readonly ceilings: RoutingCallCeilings;
}): Readonly<{
  input_tokens: number;
  output_tokens: number;
  cost_microusd: number;
  duration_ms: number;
  turns: 1;
}> {
  validatePricing(input.pricing);
  assertSafeNonnegative(input.ceilings.max_input_tokens);
  assertSafeNonnegative(input.ceilings.max_output_tokens);
  assertSafeNonnegative(input.ceilings.max_duration_ms);
  const cost =
    worstCaseTwoComponentCost(
      input.ceilings.max_input_tokens,
      input.pricing.input_microusd_per_million,
      input.pricing.cached_input_microusd_per_million,
    ) +
    worstCaseTwoComponentCost(
      input.ceilings.max_output_tokens,
      input.pricing.output_microusd_per_million,
      input.pricing.reasoning_output_microusd_per_million,
    );
  return Object.freeze({
    input_tokens: input.ceilings.max_input_tokens,
    output_tokens: input.ceilings.max_output_tokens,
    cost_microusd: safeNumber(cost),
    duration_ms: input.ceilings.max_duration_ms,
    turns: 1,
  });
}

export function reserveRoutingBudget(input: {
  readonly state: RoutingStateV1;
  readonly reservation: RoutingReservationV1;
}): RoutingStateV1 {
  const state = stateOrThrow(input.state);
  if (state.budget_status === "unknown") {
    throw new RuntimeRoutingError("RUNTIME_ROUTING_USAGE_UNKNOWN");
  }
  if (state.revision >= Number.MAX_SAFE_INTEGER) invalid();
  if (!isCanonicalUtcTimestamp(input.reservation.created_at)) invalid();
  if (input.reservation.allocations.length === 0) invalid();
  if (state.reservations.some((value) => value.decision_id === input.reservation.decision_id)) {
    throw new RuntimeRoutingError("RUNTIME_ROUTING_STALE_STATE");
  }

  const existingAttemptIds = reservationAttemptIds(state.reservations);
  const newAttemptIds = new Set<string>();
  for (const allocation of input.reservation.allocations) {
    if (existingAttemptIds.has(allocation.attempt_id) || newAttemptIds.has(allocation.attempt_id)) {
      throw new RuntimeRoutingError("RUNTIME_ROUTING_STALE_STATE");
    }
    newAttemptIds.add(allocation.attempt_id);
  }

  const totals = addTotals(totalsFromState(state), totalsFromReservation(input.reservation));
  if (exceedsBudget(state, totals)) {
    throw new RuntimeRoutingError("RUNTIME_ROUTING_BUDGET_EXCEEDED");
  }

  const reservations = [...state.reservations, input.reservation].sort((left, right) =>
    left.decision_id < right.decision_id ? -1 : left.decision_id > right.decision_id ? 1 : 0,
  );
  return freezeState({
    ...state,
    revision: state.revision + 1,
    previous_state_hash: state.document_hash,
    reservations,
  });
}

function assertReservedPlanBindings(
  reservedState: RoutingStateV1,
  plan: PlannedModelSelectionPlanV1,
): void {
  if (
    reservedState.state_id !== plan.prior_state_id ||
    reservedState.revision !== plan.next_state_revision ||
    reservedState.previous_state_hash !== plan.prior_state_hash ||
    reservedState.document_hash !== plan.next_state_hash ||
    reservedState.run_id !== plan.run_id ||
    reservedState.request_hash !== plan.request_hash ||
    reservedState.catalog_hash !== plan.catalog_hash ||
    reservedState.policy_hash !== plan.policy_hash ||
    plan.reservation.decision_id !== plan.decision_id ||
    plan.reservation.request_id !== plan.request_id
  ) {
    throw new RuntimeRoutingError("RUNTIME_ROUTING_STALE_STATE");
  }
}

function stateWithoutTransitionFields(state: RoutingStateV1): unknown {
  const {
    circuits: _circuits,
    document_hash: _documentHash,
    previous_state_hash: _previousStateHash,
    revision: _revision,
    ...governed
  } = state;
  void _circuits;
  void _documentHash;
  void _previousStateHash;
  void _revision;
  return governed;
}

function changedCircuitEntryIds(
  reservedState: RoutingStateV1,
  currentState: RoutingStateV1,
): readonly string[] {
  const reserved = new Map(reservedState.circuits.map((circuit) => [circuit.entry_id, circuit]));
  const current = new Map(currentState.circuits.map((circuit) => [circuit.entry_id, circuit]));
  const entryIds = [...new Set([...reserved.keys(), ...current.keys()])].sort();
  return entryIds.filter((entryId) => !canonicalEqual(reserved.get(entryId), current.get(entryId)));
}

function assertCurrentStateDescendsFromReservation(
  currentState: RoutingStateV1,
  reservedState: RoutingStateV1,
  plan: PlannedModelSelectionPlanV1,
): void {
  if (
    currentState.document_hash === reservedState.document_hash &&
    canonicalEqual(currentState, reservedState)
  ) {
    return;
  }
  if (
    currentState.revision !== reservedState.revision + 1 ||
    currentState.previous_state_hash !== reservedState.document_hash ||
    !canonicalEqual(
      stateWithoutTransitionFields(currentState),
      stateWithoutTransitionFields(reservedState),
    )
  ) {
    throw new RuntimeRoutingError("RUNTIME_ROUTING_STALE_STATE");
  }

  const changedEntryIds = changedCircuitEntryIds(reservedState, currentState);
  const plannedEntryIds = new Set([
    ...plan.worker_attempts.map((attempt) => attempt.entry_id),
    ...(plan.reviewer_attempt === null ? [] : [plan.reviewer_attempt.entry_id]),
  ]);
  const changedEntryId = changedEntryIds[0];
  if (
    changedEntryIds.length !== 1 ||
    changedEntryId === undefined ||
    !plannedEntryIds.has(changedEntryId)
  ) {
    throw new RuntimeRoutingError("RUNTIME_ROUTING_STALE_STATE");
  }
}

function exactReservation(
  state: RoutingStateV1,
  plan: PlannedModelSelectionPlanV1,
): RoutingReservationV1 {
  const matches = state.reservations.filter(
    (reservation) => reservation.decision_id === plan.decision_id,
  );
  if (matches.length !== 1 || !canonicalEqual(matches[0], plan.reservation)) {
    throw new RuntimeRoutingError("RUNTIME_ROUTING_STALE_STATE");
  }
  return matches[0] as RoutingReservationV1;
}

function acceptedRoute(
  plan: PlannedModelSelectionPlanV1,
  attemptId: string,
  identity: ProviderRouteIdentity,
): RoutingAcceptedRouteV1 {
  const attempts = [
    ...plan.worker_attempts,
    ...(plan.reviewer_attempt === null ? [] : [plan.reviewer_attempt]),
  ];
  const attempt = attempts.find((value) => value.attempt_id === attemptId);
  if (
    attempt === undefined ||
    identity.transport !== "agentgateway" ||
    identity.gateway_profile !== attempt.gateway_profile ||
    identity.gateway_revision !== attempt.gateway_revision ||
    identity.requested_model !== attempt.alias ||
    identity.capability_document_hash !== attempt.capability_document_hash ||
    identity.requirement_hash !== attempt.requirement_hash
  ) {
    throw new RuntimeRoutingError("RUNTIME_ROUTING_RESOLUTION_MISMATCH");
  }
  const route = attempt.accepted_routes.find(
    (value) =>
      value.route_id === identity.route_id &&
      value.provider === identity.resolved_provider &&
      value.model === identity.resolved_model,
  );
  if (route === undefined) {
    throw new RuntimeRoutingError("RUNTIME_ROUTING_RESOLUTION_MISMATCH");
  }
  return route;
}

function addKnownUsage(
  settled: UsageSummary,
  usageValue: ProviderUsage,
  costMicrousd: number,
  durationMs: number,
): UsageSummary {
  if (settled.cost_microusd === null) invalid();
  return {
    input_tokens: safeNumber(
      safeBigInt(settled.input_tokens) + safeBigInt(usageValue.input_tokens),
    ),
    output_tokens: safeNumber(
      safeBigInt(settled.output_tokens) + safeBigInt(usageValue.output_tokens),
    ),
    cost_microusd: safeNumber(safeBigInt(settled.cost_microusd) + safeBigInt(costMicrousd)),
    duration_ms: safeNumber(safeBigInt(settled.duration_ms) + safeBigInt(durationMs)),
    turns: safeNumber(safeBigInt(settled.turns) + 1n),
  };
}

export function settleRoutingDecision(input: {
  readonly state: RoutingStateV1;
  readonly reserved_state: RoutingStateV1;
  readonly plan: PlannedModelSelectionPlanV1;
  readonly attempts: readonly RoutingAttemptResult[];
  readonly settled_at: string;
}): Readonly<{ status: "SETTLED" | "FAILED"; state: RoutingStateV1 }> {
  if (!isCanonicalUtcTimestamp(input.settled_at)) invalid();
  const state = stateOrThrow(input.state);
  const reservedState = stateOrThrow(input.reserved_state);
  const plan = planOrThrow(input.plan);
  if (state.revision >= Number.MAX_SAFE_INTEGER) invalid();
  assertReservedPlanBindings(reservedState, plan);
  assertCurrentStateDescendsFromReservation(state, reservedState, plan);
  exactReservation(reservedState, plan);
  const reservation = exactReservation(state, plan);
  if (
    state.circuits.some(
      (circuit) =>
        circuit.status === "probe-reserved" &&
        circuit.probe_decision_id === reservation.decision_id,
    )
  ) {
    throw new RuntimeRoutingError("RUNTIME_ROUTING_STALE_STATE");
  }
  if (state.budget_status !== "known" || state.settled.cost_microusd === null) {
    throw new RuntimeRoutingError("RUNTIME_ROUTING_USAGE_UNKNOWN");
  }
  const allocations = new Map(
    reservation.allocations.map((allocation) => [allocation.attempt_id, allocation]),
  );
  const seen = new Set<string>();
  let nextSettled: UsageSummary = state.settled;
  let unknown = false;

  for (const result of input.attempts) {
    assertSafeNonnegative(result.duration_ms);
    if (seen.has(result.attempt_id) || !allocations.has(result.attempt_id)) invalid();
    seen.add(result.attempt_id);
    if (result.route_identity === null || result.usage === null) {
      if (result.effect_may_have_occurred) unknown = true;
      continue;
    }
    const route = acceptedRoute(plan, result.attempt_id, result.route_identity);
    const costMicrousd = calculateRoutingCost(route.pricing, result.usage);
    nextSettled = addKnownUsage(nextSettled, result.usage, costMicrousd, result.duration_ms);
  }

  const reservations = state.reservations.filter(
    (value) => value.decision_id !== reservation.decision_id,
  );
  const budgetStatus = unknown ? "unknown" : "known";
  const removedDecisionIds = new Set(
    unknown ? state.reservations.map((value) => value.decision_id) : [reservation.decision_id],
  );
  if (
    state.circuits.some(
      (circuit) =>
        circuit.status === "probe-reserved" && removedDecisionIds.has(circuit.probe_decision_id),
    )
  ) {
    throw new RuntimeRoutingError("RUNTIME_ROUTING_STALE_STATE");
  }
  const settled: UsageSummary = unknown ? { ...nextSettled, cost_microusd: null } : nextSettled;
  const nextState = freezeState({
    ...state,
    revision: state.revision + 1,
    previous_state_hash: state.document_hash,
    budget_status: budgetStatus,
    reservations: unknown ? [] : reservations,
    settled,
  });
  const failed = unknown || exceedsBudget(nextState, totalsFromState(nextState));
  return Object.freeze({ status: failed ? "FAILED" : "SETTLED", state: nextState });
}
