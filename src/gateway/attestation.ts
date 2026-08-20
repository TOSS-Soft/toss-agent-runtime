import { sha256 } from "../protocol/json.js";
import type { ProviderRouteIdentity, ProviderRouteRequirement } from "../providers/types.js";
import { agentgatewayError } from "./errors.js";
import type { AgentgatewayCapabilitiesV1, AgentgatewayRouteV1 } from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HEADER_CONTROL_PATTERN = /[\u0000-\u001f\u007f,]/u;
const REQUIREMENT_KEYS = [
  "alias",
  "json_schema",
  "max_output_tokens",
  "reasoning",
  "schema_version",
  "streaming",
  "tools",
  "vision",
] as const;

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  if (symbols.length !== 0) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  if (Object.keys(descriptors).sort().join("\u0000") !== [...keys].sort().join("\u0000")) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function normalizeProviderRouteRequirement(value: unknown): ProviderRouteRequirement {
  const record = exactRecord(value, REQUIREMENT_KEYS);
  if (
    record.schema_version !== "gateway-route-requirement.v1" ||
    typeof record.alias !== "string" ||
    !IDENTIFIER_PATTERN.test(record.alias) ||
    typeof record.tools !== "boolean" ||
    typeof record.json_schema !== "boolean" ||
    typeof record.vision !== "boolean" ||
    typeof record.reasoning !== "boolean" ||
    typeof record.streaming !== "boolean" ||
    !Number.isSafeInteger(record.max_output_tokens) ||
    Number(record.max_output_tokens) < 1 ||
    Number(record.max_output_tokens) > 1_000_000_000
  ) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  return Object.freeze({
    schema_version: "gateway-route-requirement.v1",
    alias: record.alias,
    tools: record.tools,
    json_schema: record.json_schema,
    vision: record.vision,
    reasoning: record.reasoning,
    streaming: record.streaming,
    max_output_tokens: Number(record.max_output_tokens),
  });
}

export function hashProviderRouteRequirement(
  requirement: ProviderRouteRequirement,
): `sha256:${string}` {
  return sha256(normalizeProviderRouteRequirement(requirement));
}

export function routeSatisfiesRequirement(
  route: AgentgatewayRouteV1,
  requirement: ProviderRouteRequirement,
): boolean {
  const capabilities = route.capabilities;
  return (
    (!requirement.tools || capabilities.tools) &&
    (!requirement.json_schema || capabilities.json_schema) &&
    (!requirement.vision || capabilities.vision) &&
    (!requirement.reasoning || capabilities.reasoning) &&
    (!requirement.streaming || capabilities.streaming) &&
    capabilities.max_output_tokens >= requirement.max_output_tokens
  );
}

export function requireExecutableRoute(
  capability: AgentgatewayCapabilitiesV1,
  requirement: ProviderRouteRequirement,
): void {
  const aliased = capability.routes.filter((route) => route.alias === requirement.alias);
  if (aliased.length === 0) throw agentgatewayError("RUNTIME_PROVIDER_ROUTE_NOT_FOUND");
  if (!aliased.some((route) => routeSatisfiesRequirement(route, requirement))) {
    throw agentgatewayError("RUNTIME_PROVIDER_CAPABILITY_DOWNGRADE");
  }
}

function requiredHeader(headers: Pick<Headers, "get">, name: string): string {
  let value: unknown;
  try {
    value = headers.get(name);
  } catch {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    HEADER_CONTROL_PATTERN.test(value)
  ) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  return value;
}

function optionalHeader(headers: Pick<Headers, "get">, name: string): string | null {
  let value: unknown;
  try {
    value = headers.get(name);
  } catch {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    HEADER_CONTROL_PATTERN.test(value)
  ) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  return value;
}

export function parseAgentgatewayAttestation(options: {
  readonly headers: Pick<Headers, "get">;
  readonly capability: AgentgatewayCapabilitiesV1;
  readonly requirement: ProviderRouteRequirement;
  readonly requirementHash: `sha256:${string}`;
  readonly gatewayProfile: string;
}): ProviderRouteIdentity {
  const routeId = requiredHeader(options.headers, "x-toss-route-id");
  const provider = requiredHeader(options.headers, "x-toss-resolved-provider");
  const model = requiredHeader(options.headers, "x-toss-resolved-model");
  const revision = requiredHeader(options.headers, "x-toss-capability-revision");
  const documentHash = requiredHeader(options.headers, "x-toss-capability-document-sha256");
  const requirementHash = requiredHeader(options.headers, "x-toss-requirement-sha256");
  const gatewayRequestId = optionalHeader(options.headers, "x-toss-gateway-request-id");

  if (
    !IDENTIFIER_PATTERN.test(routeId) ||
    !["openai", "anthropic", "gemini"].includes(provider) ||
    !MODEL_PATTERN.test(model) ||
    !/^(0|[1-9][0-9]*)$/.test(revision) ||
    !Number.isSafeInteger(Number(revision)) ||
    !SHA256_PATTERN.test(documentHash) ||
    !SHA256_PATTERN.test(requirementHash) ||
    (gatewayRequestId !== null && !IDENTIFIER_PATTERN.test(gatewayRequestId)) ||
    Number(revision) !== options.capability.gateway.revision ||
    documentHash !== options.capability.document_hash ||
    requirementHash !== options.requirementHash
  ) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }

  const route = options.capability.routes.find((candidate) => candidate.route_id === routeId);
  if (route === undefined || route.alias !== options.requirement.alias) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  if (!routeSatisfiesRequirement(route, options.requirement)) {
    throw agentgatewayError("RUNTIME_PROVIDER_CAPABILITY_DOWNGRADE");
  }
  if (route.provider !== provider || route.model !== model) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }

  return Object.freeze({
    transport: "agentgateway",
    gateway_profile: options.gatewayProfile,
    gateway_revision: options.capability.gateway.revision,
    route_id: route.route_id,
    requested_model: options.requirement.alias,
    resolved_provider: provider,
    resolved_model: route.model,
    capability_document_hash: options.capability.document_hash,
    requirement_hash: options.requirementHash,
    gateway_request_id: gatewayRequestId,
  });
}
