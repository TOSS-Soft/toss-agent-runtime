import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonLimits,
} from "../protocol/json.js";
import type { ProviderRouteIdentity } from "../providers/types.js";
import { hashProviderRouteRequirement } from "../gateway/attestation.js";
import { parseModelSelectionPlan, parseRoutingState } from "./contracts.js";
import { RuntimeRoutingError } from "./errors.js";
import type {
  PlannedModelSelectionPlanV1,
  RoutingAttemptV1,
  RoutingReservationV1,
  RoutingStateV1,
} from "./types.js";

const ROUTING_RUNTIME_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxMembers: 100_000,
});
const IDENTITY_KEYS = [
  "capability_document_hash",
  "gateway_profile",
  "gateway_request_id",
  "gateway_revision",
  "requested_model",
  "requirement_hash",
  "resolved_model",
  "resolved_provider",
  "route_id",
  "transport",
] as const;
const INPUT_KEYS = ["attempt_id", "plan", "route_identity", "state"] as const;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

function mismatch(): never {
  throw new RuntimeRoutingError("RUNTIME_ROUTING_RESOLUTION_MISMATCH");
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) mismatch();
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return mismatch();
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    symbols.length !== 0 ||
    Object.keys(descriptors).sort().join("\u0000") !== [...keys].sort().join("\u0000")
  ) {
    mismatch();
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      mismatch();
    }
    record[key] = descriptor.value;
  }
  return record;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return (
    canonicalJson(left, ROUTING_RUNTIME_JSON_LIMITS) ===
    canonicalJson(right, ROUTING_RUNTIME_JSON_LIMITS)
  );
}

function parsedPlan(value: unknown): PlannedModelSelectionPlanV1 {
  const parsed = parseModelSelectionPlan(canonicalJson(value, ROUTING_RUNTIME_JSON_LIMITS));
  if (!parsed.ok || parsed.value.status !== "planned") mismatch();
  return parsed.value;
}

function parsedState(value: unknown): RoutingStateV1 {
  const parsed = parseRoutingState(canonicalJson(value, ROUTING_RUNTIME_JSON_LIMITS));
  if (!parsed.ok) mismatch();
  return parsed.value;
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
  return sha256(
    { ...decision, reservation: reservationWithoutDecisionHash },
    ROUTING_RUNTIME_JSON_LIMITS,
  );
}

function exactReservation(
  state: RoutingStateV1,
  plan: PlannedModelSelectionPlanV1,
): RoutingReservationV1 {
  const matches = state.reservations.filter(
    (reservation) => reservation.decision_id === plan.decision_id,
  );
  if (matches.length !== 1 || !canonicalEqual(matches[0], plan.reservation)) mismatch();
  return matches[0] as RoutingReservationV1;
}

function exactAttempt(plan: PlannedModelSelectionPlanV1, attemptId: string): RoutingAttemptV1 {
  const matches = [
    ...plan.worker_attempts,
    ...(plan.reviewer_attempt === null ? [] : [plan.reviewer_attempt]),
  ].filter((attempt) => attempt.attempt_id === attemptId);
  if (matches.length !== 1) mismatch();
  return matches[0] as RoutingAttemptV1;
}

function normalizedIdentity(value: unknown): ProviderRouteIdentity {
  const record = exactDataRecord(value, IDENTITY_KEYS);
  if (!Object.isFrozen(value)) mismatch();
  if (
    record.transport !== "agentgateway" ||
    typeof record.gateway_profile !== "string" ||
    !Number.isSafeInteger(record.gateway_revision) ||
    Number(record.gateway_revision) < 0 ||
    typeof record.route_id !== "string" ||
    typeof record.requested_model !== "string" ||
    typeof record.resolved_provider !== "string" ||
    !["openai", "anthropic", "gemini"].includes(record.resolved_provider) ||
    typeof record.resolved_model !== "string" ||
    typeof record.capability_document_hash !== "string" ||
    typeof record.requirement_hash !== "string" ||
    (record.gateway_request_id !== null &&
      (typeof record.gateway_request_id !== "string" ||
        !IDENTIFIER_PATTERN.test(record.gateway_request_id)))
  ) {
    mismatch();
  }
  const candidate: ProviderRouteIdentity = {
    transport: "agentgateway",
    gateway_profile: record.gateway_profile,
    gateway_revision: Number(record.gateway_revision),
    route_id: record.route_id,
    requested_model: record.requested_model,
    resolved_provider: record.resolved_provider as ProviderRouteIdentity["resolved_provider"],
    resolved_model: record.resolved_model,
    capability_document_hash:
      record.capability_document_hash as ProviderRouteIdentity["capability_document_hash"],
    requirement_hash: record.requirement_hash as ProviderRouteIdentity["requirement_hash"],
    gateway_request_id: record.gateway_request_id,
  };
  return deepFreezeJson(
    parseJsonBytes(
      canonicalJson(candidate, ROUTING_RUNTIME_JSON_LIMITS),
      ROUTING_RUNTIME_JSON_LIMITS,
    ),
    ROUTING_RUNTIME_JSON_LIMITS,
  ) as unknown as ProviderRouteIdentity;
}

function verify(input: unknown): ProviderRouteIdentity {
  const record = exactDataRecord(input, INPUT_KEYS);
  if (typeof record.attempt_id !== "string") mismatch();
  const plan = parsedPlan(record.plan);
  const state = parsedState(record.state);
  const identity = normalizedIdentity(record.route_identity);

  if (
    plannedDecisionHash(plan) !== plan.reservation.decision_hash ||
    state.state_id !== plan.prior_state_id ||
    state.run_id !== plan.run_id ||
    state.request_hash !== plan.request_hash ||
    state.catalog_hash !== plan.catalog_hash ||
    state.policy_hash !== plan.policy_hash
  ) {
    mismatch();
  }
  exactReservation(state, plan);
  if (
    state.revision !== plan.next_state_revision ||
    state.previous_state_hash !== plan.prior_state_hash ||
    state.document_hash !== plan.next_state_hash
  ) {
    mismatch();
  }

  const attempt = exactAttempt(plan, record.attempt_id);
  if (
    attempt.gateway_profile !== plan.gateway_profile ||
    attempt.gateway_revision !== plan.gateway_revision ||
    attempt.capability_document_hash !== plan.capability_document_hash ||
    attempt.requirement.alias !== attempt.alias ||
    hashProviderRouteRequirement(attempt.requirement) !== attempt.requirement_hash ||
    identity.gateway_profile !== attempt.gateway_profile ||
    identity.gateway_revision !== attempt.gateway_revision ||
    identity.requested_model !== attempt.alias ||
    identity.capability_document_hash !== attempt.capability_document_hash ||
    identity.requirement_hash !== attempt.requirement_hash
  ) {
    mismatch();
  }
  const accepted = attempt.accepted_routes.filter(
    (route) =>
      route.route_id === identity.route_id &&
      route.provider === identity.resolved_provider &&
      route.model === identity.resolved_model,
  );
  if (accepted.length !== 1) mismatch();
  return identity;
}

export function verifyResolvedRoute(input: {
  readonly state: RoutingStateV1;
  readonly plan: PlannedModelSelectionPlanV1;
  readonly attempt_id: string;
  readonly route_identity: ProviderRouteIdentity | null;
}): ProviderRouteIdentity {
  try {
    return verify(input);
  } catch {
    return mismatch();
  }
}
