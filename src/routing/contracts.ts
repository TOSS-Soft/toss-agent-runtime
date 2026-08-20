import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonLimits,
  type JsonValue,
} from "../protocol/json.js";
import type {
  ArtifactReference,
  ValidationFailure,
  ValidationIssue,
  ValidationResult,
} from "../protocol/types.js";
import { createProtocolValidator } from "../protocol/validator.js";
import type {
  GovernedRoutingOverride,
  ModelCatalogV1,
  ModelSelectionPlanV1,
  PlannedModelSelectionPlanV1,
  RoutingOverrideFragmentV1,
  RoutingPolicyRuleV1,
  RoutingPolicyV1,
  RoutingStateV1,
  TaskComplexity,
  TaskPhase,
  TaskRisk,
} from "./types.js";

const MODEL_CATALOG_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxMembers: 100_000,
});

const ROUTING_POLICY_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 512 * 1024,
  maxDepth: 32,
  maxMembers: 100_000,
});

const ROUTING_RUNTIME_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxMembers: 100_000,
});

const TASK_PHASES: readonly TaskPhase[] = ["analysis", "implementation", "review"];
const TASK_COMPLEXITIES: readonly TaskComplexity[] = ["low", "medium", "high", "critical"];
const TASK_RISKS: readonly TaskRisk[] = ["architecture", "irreversible", "security"];

function issue(path: string, keyword: string, message: string): ValidationIssue {
  return { path, keyword, message };
}

function failure(issues: readonly ValidationIssue[]): ValidationFailure {
  return {
    ok: false,
    code: "RUNTIME_DOCUMENT_INVALID",
    issues: [...issues].sort((left, right) =>
      `${left.path}\u0000${left.keyword}\u0000${left.message}`.localeCompare(
        `${right.path}\u0000${right.keyword}\u0000${right.message}`,
      ),
    ),
  };
}

function jsonFailure(): ValidationFailure {
  return failure([issue("", "json", "model catalog is invalid")]);
}

function routingPolicyJsonFailure(): ValidationFailure {
  return failure([issue("", "json", "routing policy is invalid")]);
}

function routingOverrideJsonFailure(): ValidationFailure {
  return failure([issue("", "json", "routing override is invalid")]);
}

function routingStateJsonFailure(): ValidationFailure {
  return failure([issue("", "json", "routing state is invalid")]);
}

function modelSelectionPlanJsonFailure(): ValidationFailure {
  return failure([issue("", "json", "model selection plan is invalid")]);
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashModelCatalog(value: ModelCatalogV1): `sha256:${string}` {
  const normalized = parseJsonBytes(
    canonicalJson(value, MODEL_CATALOG_JSON_LIMITS),
    MODEL_CATALOG_JSON_LIMITS,
  );
  if (!isRecord(normalized)) throw new TypeError("model catalog is invalid");
  const hashable = { ...normalized };
  delete hashable.document_hash;
  return sha256(hashable, MODEL_CATALOG_JSON_LIMITS);
}

export function parseModelCatalog(input: string | Uint8Array): ValidationResult<ModelCatalogV1> {
  let canonical: string;
  try {
    canonical = canonicalJson(
      deepFreezeJson(parseJsonBytes(input, MODEL_CATALOG_JSON_LIMITS), MODEL_CATALOG_JSON_LIMITS),
      MODEL_CATALOG_JSON_LIMITS,
    );
  } catch {
    return jsonFailure();
  }

  const parsed = createProtocolValidator().parse<ModelCatalogV1>(
    canonical,
    "model-catalog",
    MODEL_CATALOG_JSON_LIMITS,
  );
  if (!parsed.ok) return parsed;

  const issues: ValidationIssue[] = [];
  const entryIds = new Set<string>();
  const routeIds = new Set<string>();
  for (const [entryIndex, entry] of parsed.value.entries.entries()) {
    if (entryIds.has(entry.entry_id)) {
      issues.push(
        issue(`/entries/${entryIndex}/entry_id`, "uniqueEntry", "entry_id must be unique"),
      );
    }
    entryIds.add(entry.entry_id);

    const classes = new Set<string>();
    for (const [classIndex, logicalClass] of entry.logical_classes.entries()) {
      if (classes.has(logicalClass)) {
        issues.push(
          issue(
            `/entries/${entryIndex}/logical_classes/${classIndex}`,
            "uniqueClass",
            "logical classes must be unique",
          ),
        );
      }
      classes.add(logicalClass);
    }

    for (const [routeIndex, route] of entry.routes.entries()) {
      if (routeIds.has(route.route_id)) {
        issues.push(
          issue(
            `/entries/${entryIndex}/routes/${routeIndex}/route_id`,
            "uniqueRoute",
            "route_id must be globally unique",
          ),
        );
      }
      routeIds.add(route.route_id);
      if (route.provider !== route.capabilities.provider) {
        issues.push(
          issue(
            `/entries/${entryIndex}/routes/${routeIndex}/capabilities/provider`,
            "providerCoherence",
            "route and capability providers must match",
          ),
        );
      }
    }
  }

  let expectedHash: `sha256:${string}` | undefined;
  try {
    expectedHash = hashModelCatalog(parsed.value);
  } catch {
    issues.push(issue("/document_hash", "canonicalHash", "catalog hash is invalid"));
  }
  if (expectedHash !== undefined && parsed.value.document_hash !== expectedHash) {
    issues.push(issue("/document_hash", "canonicalHash", "catalog hash does not match"));
  }

  return issues.length === 0 ? parsed : failure(issues);
}

function isCatchAll(rule: RoutingPolicyRuleV1): boolean {
  return rule.match.phase === "*" && rule.match.complexity === "*" && rule.match.risks === "*";
}

function hasExactRiskSet(matcher: readonly TaskRisk[], risks: readonly TaskRisk[]): boolean {
  return matcher.length === risks.length && matcher.every((risk) => risks.includes(risk));
}

function matchesTaskProfile(
  rule: RoutingPolicyRuleV1,
  phase: TaskPhase,
  complexity: TaskComplexity,
  risks: readonly TaskRisk[],
): boolean {
  return (
    (rule.match.phase === "*" || rule.match.phase === phase) &&
    (rule.match.complexity === "*" || rule.match.complexity === complexity) &&
    (rule.match.risks === "*" || hasExactRiskSet(rule.match.risks, risks))
  );
}

function taskRiskSets(): readonly (readonly TaskRisk[])[] {
  return Array.from({ length: 1 << TASK_RISKS.length }, (_, mask) =>
    TASK_RISKS.filter((_, index) => (mask & (1 << index)) !== 0),
  );
}

export function hashRoutingPolicy(value: RoutingPolicyV1): `sha256:${string}` {
  const normalized = parseJsonBytes(
    canonicalJson(value, ROUTING_POLICY_JSON_LIMITS),
    ROUTING_POLICY_JSON_LIMITS,
  );
  if (!isRecord(normalized)) throw new TypeError("routing policy is invalid");
  const hashable = { ...normalized };
  delete hashable.document_hash;
  return sha256(hashable, ROUTING_POLICY_JSON_LIMITS);
}

export function parseRoutingPolicy(input: string | Uint8Array): ValidationResult<RoutingPolicyV1> {
  let canonical: string;
  try {
    canonical = canonicalJson(
      deepFreezeJson(parseJsonBytes(input, ROUTING_POLICY_JSON_LIMITS), ROUTING_POLICY_JSON_LIMITS),
      ROUTING_POLICY_JSON_LIMITS,
    );
  } catch {
    return routingPolicyJsonFailure();
  }

  const parsed = createProtocolValidator().parse<RoutingPolicyV1>(
    canonical,
    "routing-policy",
    ROUTING_POLICY_JSON_LIMITS,
  );
  if (!parsed.ok) return parsed;

  const issues: ValidationIssue[] = [];
  const ruleIds = new Set<string>();
  const catchAllRules: number[] = [];
  for (const [ruleIndex, rule] of parsed.value.rules.entries()) {
    if (ruleIds.has(rule.rule_id)) {
      issues.push(issue(`/rules/${ruleIndex}/rule_id`, "uniqueRule", "rule_id must be unique"));
    }
    ruleIds.add(rule.rule_id);
    if (isCatchAll(rule)) catchAllRules.push(ruleIndex);
  }
  if (catchAllRules.length !== 1) {
    issues.push(issue("/rules", "catchAll", "exactly one catch-all rule is required"));
  }

  for (const phase of TASK_PHASES) {
    for (const complexity of TASK_COMPLEXITIES) {
      for (const risks of taskRiskSets()) {
        const matchingRules = parsed.value.rules.filter((rule) =>
          matchesTaskProfile(rule, phase, complexity, risks),
        );
        if (matchingRules.length === 0) {
          issues.push(issue("/rules", "coverage", "every task profile must match a rule"));
          continue;
        }
        const winningPriority = Math.min(...matchingRules.map((rule) => rule.priority));
        const winners = matchingRules.filter((rule) => rule.priority === winningPriority);
        if (winners.length !== 1) {
          issues.push(issue("/rules", "priority", "task profiles must have one winning rule"));
          continue;
        }
        if (risks.length > 0 && winners[0]?.review !== "independent") {
          issues.push(
            issue(
              "/rules",
              "independentReview",
              "risk-bearing task profiles require independent review",
            ),
          );
        }
      }
    }
  }

  let expectedHash: `sha256:${string}` | undefined;
  try {
    expectedHash = hashRoutingPolicy(parsed.value);
  } catch {
    issues.push(issue("/document_hash", "canonicalHash", "policy hash is invalid"));
  }
  if (expectedHash !== undefined && parsed.value.document_hash !== expectedHash) {
    issues.push(issue("/document_hash", "canonicalHash", "policy hash does not match"));
  }

  return issues.length === 0 ? parsed : failure(issues);
}

function isCanonicalUtcTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

export function parseGovernedRoutingOverride(input: {
  readonly artifact: ArtifactReference;
  readonly value: unknown;
}): ValidationResult<GovernedRoutingOverride> {
  let candidate: JsonValue;
  try {
    candidate = deepFreezeJson(
      parseJsonBytes(canonicalJson(input, ROUTING_POLICY_JSON_LIMITS), ROUTING_POLICY_JSON_LIMITS),
      ROUTING_POLICY_JSON_LIMITS,
    );
  } catch {
    return routingOverrideJsonFailure();
  }
  if (!isRecord(candidate) || !("artifact" in candidate) || !("value" in candidate)) {
    return routingOverrideJsonFailure();
  }

  const validator = createProtocolValidator();
  const artifact = validator.validateFragment("artifact-reference", candidate.artifact);
  const value = validator.validateFragment("routing-override", candidate.value);
  if (!artifact.ok || !value.ok) {
    return failure([...(artifact.ok ? [] : artifact.issues), ...(value.ok ? [] : value.issues)]);
  }

  const artifactValue = artifact.value as unknown as ArtifactReference;
  const overrideValue = value.value as unknown as RoutingOverrideFragmentV1;
  const issues: ValidationIssue[] = [];
  if (artifactValue.document_type !== "routing-override") {
    issues.push(issue("/artifact/document_type", "const", "must equal routing-override"));
  }
  if (!isCanonicalUtcTimestamp(overrideValue.issued_at)) {
    issues.push(issue("/value/issued_at", "canonicalUtc", "override time must be canonical UTC"));
  }
  if (sha256(overrideValue, ROUTING_POLICY_JSON_LIMITS) !== artifactValue.hash) {
    issues.push(issue("/artifact/hash", "canonicalHash", "override hash does not match"));
  }
  if (issues.length > 0) return failure(issues);

  return {
    ok: true,
    value: candidate as unknown as GovernedRoutingOverride,
  };
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateSortedUnique<T>(
  values: readonly T[],
  identity: (value: T) => string,
  path: string,
  keyword: string,
  issues: ValidationIssue[],
  seen: Set<string> = new Set<string>(),
): void {
  let previous: string | undefined;
  for (const [index, value] of values.entries()) {
    const current = identity(value);
    if (seen.has(current)) {
      issues.push(issue(`${path}/${index}`, keyword, "identities must be unique"));
    }
    seen.add(current);
    if (previous !== undefined && compareAscii(previous, current) >= 0) {
      issues.push(issue(`${path}/${index}`, "canonicalOrder", "values must use fixed ordering"));
    }
    previous = current;
  }
}

function normalizedRecord(value: JsonValue, message: string): Readonly<Record<string, JsonValue>> {
  if (!isRecord(value)) throw new TypeError(message);
  return value;
}

export function hashRoutingState(value: RoutingStateV1): `sha256:${string}` {
  const normalized = normalizedRecord(
    parseJsonBytes(canonicalJson(value, ROUTING_RUNTIME_JSON_LIMITS), ROUTING_RUNTIME_JSON_LIMITS),
    "routing state is invalid",
  );
  const { document_hash: _documentHash, ...hashable } = normalized;
  void _documentHash;
  return sha256(hashable, ROUTING_RUNTIME_JSON_LIMITS);
}

export function parseRoutingState(input: string | Uint8Array): ValidationResult<RoutingStateV1> {
  let canonical: string;
  try {
    canonical = canonicalJson(
      deepFreezeJson(
        parseJsonBytes(input, ROUTING_RUNTIME_JSON_LIMITS),
        ROUTING_RUNTIME_JSON_LIMITS,
      ),
      ROUTING_RUNTIME_JSON_LIMITS,
    );
  } catch {
    return routingStateJsonFailure();
  }

  const parsed = createProtocolValidator().parse<RoutingStateV1>(
    canonical,
    "routing-state",
    ROUTING_RUNTIME_JSON_LIMITS,
  );
  if (!parsed.ok) return parsed;

  const issues: ValidationIssue[] = [];
  if (
    (parsed.value.revision === 1 && parsed.value.previous_state_hash !== null) ||
    (parsed.value.revision > 1 && parsed.value.previous_state_hash === null)
  ) {
    issues.push(
      issue(
        "/previous_state_hash",
        "stateChain",
        "previous state hash must match the state revision",
      ),
    );
  }
  if (
    (parsed.value.budget_status === "known" && parsed.value.settled.cost_microusd === null) ||
    (parsed.value.budget_status === "unknown" && parsed.value.settled.cost_microusd !== null)
  ) {
    issues.push(
      issue("/settled/cost_microusd", "budgetStatus", "settled cost must match budget status"),
    );
  }
  if (parsed.value.budget_status === "unknown" && parsed.value.reservations.length > 0) {
    issues.push(
      issue("/reservations", "budgetStatus", "unknown budget cannot carry active reservations"),
    );
  }

  validateSortedUnique(
    parsed.value.reservations,
    (reservation) => reservation.decision_id,
    "/reservations",
    "uniqueReservation",
    issues,
  );
  const allocationIds = new Set<string>();
  for (const [reservationIndex, reservation] of parsed.value.reservations.entries()) {
    if (!isCanonicalUtcTimestamp(reservation.created_at)) {
      issues.push(
        issue(
          `/reservations/${reservationIndex}/created_at`,
          "canonicalUtc",
          "reservation time must be canonical UTC",
        ),
      );
    }
    validateSortedUnique(
      reservation.allocations,
      (allocation) => allocation.attempt_id,
      `/reservations/${reservationIndex}/allocations`,
      "uniqueAttempt",
      issues,
      allocationIds,
    );
  }
  validateSortedUnique(
    parsed.value.circuits,
    (circuit) => circuit.entry_id,
    "/circuits",
    "uniqueEntry",
    issues,
  );
  for (const [circuitIndex, circuit] of parsed.value.circuits.entries()) {
    if (circuit.retry_at !== null && !isCanonicalUtcTimestamp(circuit.retry_at)) {
      issues.push(
        issue(
          `/circuits/${circuitIndex}/retry_at`,
          "canonicalUtc",
          "circuit retry time must be canonical UTC",
        ),
      );
    }
    if (circuit.status === "probe-reserved") {
      const matchingReservations = parsed.value.reservations.filter(
        (reservation) => reservation.decision_id === circuit.probe_decision_id,
      );
      if (
        matchingReservations.length !== 1 ||
        !matchingReservations[0]?.allocations.some(
          (allocation) => allocation.entry_id === circuit.entry_id,
        )
      ) {
        issues.push(
          issue(
            `/circuits/${circuitIndex}/probe_decision_id`,
            "probeReservation",
            "probe must match one active reservation allocation for its entry",
          ),
        );
      }
    }
  }

  let expectedHash: `sha256:${string}` | undefined;
  try {
    expectedHash = hashRoutingState(parsed.value);
  } catch {
    issues.push(issue("/document_hash", "canonicalHash", "routing state hash is invalid"));
  }
  if (expectedHash !== undefined && parsed.value.document_hash !== expectedHash) {
    issues.push(issue("/document_hash", "canonicalHash", "routing state hash does not match"));
  }

  return issues.length === 0 ? parsed : failure(issues);
}

function plannedDecisionHash(value: PlannedModelSelectionPlanV1): `sha256:${string}` {
  const normalized = normalizedRecord(
    parseJsonBytes(canonicalJson(value, ROUTING_RUNTIME_JSON_LIMITS), ROUTING_RUNTIME_JSON_LIMITS),
    "model selection plan is invalid",
  );
  const {
    document_hash: _documentHash,
    next_state_revision: _nextStateRevision,
    next_state_hash: _nextStateHash,
    reservation,
    ...decision
  } = normalized;
  void _documentHash;
  void _nextStateRevision;
  void _nextStateHash;
  if (reservation === undefined) throw new TypeError("model selection reservation is invalid");
  const reservationRecord = normalizedRecord(reservation, "model selection reservation is invalid");
  const { decision_hash: _decisionHash, ...reservationWithoutDecisionHash } = reservationRecord;
  void _decisionHash;
  return sha256(
    { ...decision, reservation: reservationWithoutDecisionHash },
    ROUTING_RUNTIME_JSON_LIMITS,
  );
}

export function hashModelSelectionPlan(value: ModelSelectionPlanV1): `sha256:${string}` {
  const normalized = normalizedRecord(
    parseJsonBytes(canonicalJson(value, ROUTING_RUNTIME_JSON_LIMITS), ROUTING_RUNTIME_JSON_LIMITS),
    "model selection plan is invalid",
  );
  const { document_hash: _documentHash, ...hashable } = normalized;
  void _documentHash;
  return sha256(hashable, ROUTING_RUNTIME_JSON_LIMITS);
}

function validatePlanAttempt(
  attempt: PlannedModelSelectionPlanV1["worker_attempts"][number],
  path: string,
  plan: PlannedModelSelectionPlanV1,
  issues: ValidationIssue[],
  routeIds: Set<string>,
): void {
  if (attempt.gateway_profile !== plan.gateway_profile) {
    issues.push(issue(`${path}/gateway_profile`, "liveBinding", "gateway profile must match plan"));
  }
  if (attempt.gateway_revision !== plan.gateway_revision) {
    issues.push(
      issue(`${path}/gateway_revision`, "liveBinding", "gateway revision must match plan"),
    );
  }
  if (attempt.capability_document_hash !== plan.capability_document_hash) {
    issues.push(
      issue(
        `${path}/capability_document_hash`,
        "liveBinding",
        "capability document hash must match plan",
      ),
    );
  }
  if (attempt.requirement.alias !== attempt.alias) {
    issues.push(issue(`${path}/requirement/alias`, "aliasBinding", "requirement alias must match"));
  }
  if (sha256(attempt.requirement, ROUTING_RUNTIME_JSON_LIMITS) !== attempt.requirement_hash) {
    issues.push(
      issue(`${path}/requirement_hash`, "canonicalHash", "requirement hash does not match"),
    );
  }
  validateSortedUnique(
    attempt.accepted_routes,
    (route) => route.route_id,
    `${path}/accepted_routes`,
    "uniqueRoute",
    issues,
    routeIds,
  );
}

export function parseModelSelectionPlan(
  input: string | Uint8Array,
): ValidationResult<ModelSelectionPlanV1> {
  let canonical: string;
  try {
    canonical = canonicalJson(
      deepFreezeJson(
        parseJsonBytes(input, ROUTING_RUNTIME_JSON_LIMITS),
        ROUTING_RUNTIME_JSON_LIMITS,
      ),
      ROUTING_RUNTIME_JSON_LIMITS,
    );
  } catch {
    return modelSelectionPlanJsonFailure();
  }

  const parsed = createProtocolValidator().parse<ModelSelectionPlanV1>(
    canonical,
    "model-selection-plan",
    ROUTING_RUNTIME_JSON_LIMITS,
  );
  if (!parsed.ok) return parsed;

  const issues: ValidationIssue[] = [];
  if (!isCanonicalUtcTimestamp(parsed.value.decision_at)) {
    issues.push(issue("/decision_at", "canonicalUtc", "decision time must be canonical UTC"));
  }
  validateSortedUnique(
    parsed.value.eliminations,
    (elimination) => elimination.entry_id,
    "/eliminations",
    "uniqueEntry",
    issues,
  );

  if (parsed.value.status === "planned") {
    const plan = parsed.value;
    const attemptIds = new Set<string>();
    const entryIds = new Set<string>();
    const routeIds = new Set<string>();
    for (const [attemptIndex, attempt] of plan.worker_attempts.entries()) {
      const path = `/worker_attempts/${attemptIndex}`;
      if (attempt.fallback_index !== attemptIndex) {
        issues.push(
          issue(
            `${path}/fallback_index`,
            "canonicalOrder",
            "worker fallback indices must be contiguous and ordered",
          ),
        );
      }
      if (attemptIds.has(attempt.attempt_id)) {
        issues.push(issue(`${path}/attempt_id`, "uniqueAttempt", "attempt_id must be unique"));
      }
      attemptIds.add(attempt.attempt_id);
      if (entryIds.has(attempt.entry_id)) {
        issues.push(issue(`${path}/entry_id`, "uniqueEntry", "selected entry_id must be unique"));
      }
      entryIds.add(attempt.entry_id);
      validatePlanAttempt(attempt, path, plan, issues, routeIds);
    }
    if (plan.reviewer_attempt !== null) {
      const reviewer = plan.reviewer_attempt;
      if (attemptIds.has(reviewer.attempt_id)) {
        issues.push(
          issue("/reviewer_attempt/attempt_id", "uniqueAttempt", "attempt_id must be unique"),
        );
      }
      attemptIds.add(reviewer.attempt_id);
      if (entryIds.has(reviewer.entry_id)) {
        issues.push(
          issue("/reviewer_attempt/entry_id", "uniqueEntry", "selected entry_id must be unique"),
        );
      }
      entryIds.add(reviewer.entry_id);
      validatePlanAttempt(reviewer, "/reviewer_attempt", plan, issues, routeIds);
    }
    for (const [eliminationIndex, elimination] of plan.eliminations.entries()) {
      if (entryIds.has(elimination.entry_id)) {
        issues.push(
          issue(
            `/eliminations/${eliminationIndex}/entry_id`,
            "selectionExclusive",
            "selected entries cannot also be eliminated",
          ),
        );
      }
    }

    if (plan.reservation.decision_id !== plan.decision_id) {
      issues.push(
        issue("/reservation/decision_id", "decisionBinding", "reservation decision must match"),
      );
    }
    if (plan.reservation.request_id !== plan.request_id) {
      issues.push(
        issue("/reservation/request_id", "requestBinding", "reservation request must match"),
      );
    }
    if (
      !isCanonicalUtcTimestamp(plan.reservation.created_at) ||
      plan.reservation.created_at !== plan.decision_at
    ) {
      issues.push(
        issue(
          "/reservation/created_at",
          "decisionBinding",
          "reservation time must equal canonical decision time",
        ),
      );
    }
    validateSortedUnique(
      plan.reservation.allocations,
      (allocation) => allocation.attempt_id,
      "/reservation/allocations",
      "uniqueAttempt",
      issues,
    );
    const plannedAttempts = [
      ...plan.worker_attempts,
      ...(plan.reviewer_attempt === null ? [] : [plan.reviewer_attempt]),
    ];
    const attemptsById = new Map(plannedAttempts.map((attempt) => [attempt.attempt_id, attempt]));
    if (plan.reservation.allocations.length !== plannedAttempts.length) {
      issues.push(
        issue(
          "/reservation/allocations",
          "attemptBinding",
          "reservation must allocate every planned attempt exactly once",
        ),
      );
    }
    for (const [allocationIndex, allocation] of plan.reservation.allocations.entries()) {
      const attempt = attemptsById.get(allocation.attempt_id);
      if (
        attempt === undefined ||
        allocation.entry_id !== attempt.entry_id ||
        allocation.role !== attempt.role ||
        allocation.cost_microusd !== attempt.reserved_cost_microusd
      ) {
        issues.push(
          issue(
            `/reservation/allocations/${allocationIndex}`,
            "attemptBinding",
            "allocation must match its planned attempt",
          ),
        );
      }
    }
    if (plan.next_state_revision !== plan.prior_state_revision + 1) {
      issues.push(
        issue(
          "/next_state_revision",
          "stateBinding",
          "next state revision must immediately follow prior state",
        ),
      );
    }
    if (plannedDecisionHash(plan) !== plan.reservation.decision_hash) {
      issues.push(
        issue(
          "/reservation/decision_hash",
          "decisionBinding",
          "reservation decision hash does not match",
        ),
      );
    }
  } else {
    const circuitRetry = parsed.value.block_code === "RUNTIME_ROUTING_CIRCUIT_OPEN";
    if (
      parsed.value.retryable !== circuitRetry ||
      (circuitRetry && parsed.value.next_retry_at === null) ||
      (!circuitRetry && parsed.value.next_retry_at !== null)
    ) {
      issues.push(
        issue(
          "/retryable",
          "blockCoherence",
          "blocked retry fields must match the stable block code",
        ),
      );
    }
    if (
      parsed.value.next_retry_at !== null &&
      !isCanonicalUtcTimestamp(parsed.value.next_retry_at)
    ) {
      issues.push(
        issue("/next_retry_at", "canonicalUtc", "blocked retry time must be canonical UTC"),
      );
    }
  }

  let expectedHash: `sha256:${string}` | undefined;
  try {
    expectedHash = hashModelSelectionPlan(parsed.value);
  } catch {
    issues.push(issue("/document_hash", "canonicalHash", "selection plan hash is invalid"));
  }
  if (expectedHash !== undefined && parsed.value.document_hash !== expectedHash) {
    issues.push(issue("/document_hash", "canonicalHash", "selection plan hash does not match"));
  }

  return issues.length === 0 ? parsed : failure(issues);
}
