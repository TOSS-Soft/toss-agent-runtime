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
  RoutingOverrideFragmentV1,
  RoutingPolicyRuleV1,
  RoutingPolicyV1,
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

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashModelCatalog(value: ModelCatalogV1): `sha256:${string}` {
  const normalized = parseJsonBytes(
    canonicalJson(value, MODEL_CATALOG_JSON_LIMITS),
    MODEL_CATALOG_JSON_LIMITS,
  );
  if (!isRecord(normalized)) throw new TypeError("model catalog is invalid");
  const { document_hash: _documentHash, ...hashable } = normalized;
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
  const { document_hash: _documentHash, ...hashable } = normalized;
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
