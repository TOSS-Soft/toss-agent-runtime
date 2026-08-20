import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonLimits,
  type JsonValue,
} from "../protocol/json.js";
import type { RuntimeConfigV1 } from "../config/types.js";
import type { ValidationFailure, ValidationIssue } from "../protocol/types.js";
import { createProtocolValidator } from "../protocol/validator.js";
import type {
  AgentgatewayCapabilitiesV1,
  AgentgatewayCapabilitiesValidationResult,
  AgentgatewayHealth,
  AgentgatewayHealthValidationResult,
  ParseAgentgatewayCapabilitiesOptions,
  SelectedAgentgatewayProfile,
} from "./types.js";

const CAPABILITY_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 512 * 1024,
  maxDepth: 16,
  maxMembers: 10_000,
});
const HEALTH_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 64 * 1024,
  maxDepth: 4,
  maxMembers: 16,
});
const MAX_CAPABILITY_LIFETIME_MS = 5 * 60 * 1000;

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
  return failure([issue("", "json", "Agentgateway document is invalid")]);
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalTimestamp(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null;
  return milliseconds;
}

export function hashAgentgatewayCapabilities(
  document: AgentgatewayCapabilitiesV1,
): `sha256:${string}` {
  const normalized = parseJsonBytes(canonicalJson(document, CAPABILITY_LIMITS), CAPABILITY_LIMITS);
  if (!isRecord(normalized)) throw new TypeError("Agentgateway capability document is invalid");
  const { document_hash: documentHash, ...hashable } = normalized;
  void documentHash;
  return sha256(hashable, CAPABILITY_LIMITS);
}

export function parseAgentgatewayCapabilities(
  input: string | Uint8Array,
  options: ParseAgentgatewayCapabilitiesOptions,
): AgentgatewayCapabilitiesValidationResult {
  let canonical: string;
  try {
    canonical = canonicalJson(parseJsonBytes(input, CAPABILITY_LIMITS), CAPABILITY_LIMITS);
  } catch {
    return jsonFailure();
  }

  const parsed = createProtocolValidator().parse<AgentgatewayCapabilitiesV1>(
    canonical,
    "agentgateway-capabilities",
  );
  if (!parsed.ok) return parsed;

  const issues: ValidationIssue[] = [];
  const generated = canonicalTimestamp(parsed.value.generated_at);
  const expires = canonicalTimestamp(parsed.value.expires_at);
  let current: number;
  try {
    const value = options.now();
    current = value instanceof Date ? value.getTime() : Number.NaN;
  } catch {
    current = Number.NaN;
  }
  if (generated === null) {
    issues.push(issue("/generated_at", "canonicalTimestamp", "must be canonical UTC"));
  }
  if (expires === null) {
    issues.push(issue("/expires_at", "canonicalTimestamp", "must be canonical UTC"));
  }
  if (generated !== null && expires !== null) {
    if (expires <= generated) {
      issues.push(issue("/expires_at", "chronology", "must be later than generated_at"));
    } else if (expires - generated > MAX_CAPABILITY_LIFETIME_MS) {
      issues.push(issue("/expires_at", "lifetime", "capability lifetime exceeds five minutes"));
    }
    if (!Number.isFinite(current) || expires <= current) {
      issues.push(issue("/expires_at", "expired", "capability document is expired"));
    }
  }

  const routeIds = new Set<string>();
  for (const [index, route] of parsed.value.routes.entries()) {
    if (routeIds.has(route.route_id)) {
      issues.push(issue(`/routes/${index}/route_id`, "uniqueRoute", "route_id must be unique"));
    }
    routeIds.add(route.route_id);
    if (route.provider !== route.capabilities.provider) {
      issues.push(
        issue(
          `/routes/${index}/capabilities/provider`,
          "providerCoherence",
          "route and capability providers must match",
        ),
      );
    }
  }

  let expectedHash: `sha256:${string}` | undefined;
  try {
    expectedHash = hashAgentgatewayCapabilities(parsed.value);
  } catch {
    issues.push(issue("/document_hash", "canonicalHash", "capability hash is invalid"));
  }
  if (expectedHash !== undefined && parsed.value.document_hash !== expectedHash) {
    issues.push(issue("/document_hash", "canonicalHash", "capability hash does not match"));
  }

  return issues.length === 0 ? parsed : failure(issues);
}

export function parseAgentgatewayHealth(
  input: string | Uint8Array,
): AgentgatewayHealthValidationResult {
  let value: JsonValue;
  try {
    value = parseJsonBytes(input, HEALTH_LIMITS);
  } catch {
    return jsonFailure();
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\u0000") !== "revision\u0000status" ||
    typeof value.status !== "string" ||
    !["healthy", "degraded", "unavailable"].includes(value.status) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    return failure([issue("", "health", "Agentgateway health document is invalid")]);
  }
  const health = {
    status: value.status,
    revision: value.revision,
  } as AgentgatewayHealth;
  return {
    ok: true,
    value: deepFreezeJson(health as unknown as JsonValue) as unknown as AgentgatewayHealth,
  };
}

export function selectedAgentgatewayProfile(
  config: RuntimeConfigV1,
): SelectedAgentgatewayProfile | null {
  if (config.gateway_profile === null) return null;
  const profile = config.gateway_profiles[config.gateway_profile];
  if (profile === undefined) return null;
  return Object.freeze({ name: config.gateway_profile, profile });
}
