import { PACKAGE_NAME, PACKAGE_VERSION, PROTOCOL_VERSION } from "../version.js";
import type { ExecutionRequestV1 } from "./request.js";
import type {
  ArtifactReference,
  ProducerIdentity,
  RuntimeDocument,
  ValidationIssue,
  ValidationResult,
} from "./types.js";
import { createProtocolValidator } from "./validator.js";

export type Availability = "available" | "unavailable" | "blocked";

const AGENT_SKILL_HOST_VERSIONS = Object.freeze(["agent-skills.v1"]);
const SUPERPOWERS_CAPABILITIES = Object.freeze([
  "brainstorming",
  "requesting-code-review",
  "systematic-debugging",
  "test-driven-development",
  "verification-before-completion",
]);

export interface RuntimeCapabilitiesV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "runtime-capabilities.v1";
  readonly document_type: "runtime-capabilities";
  readonly runtime: ProducerIdentity & Readonly<{ kind: "runtime" }>;
  readonly package: Readonly<{ name: typeof PACKAGE_NAME; version: string }>;
  readonly platform: Readonly<{ os: "darwin" | "linux"; arch: string; node: string }>;
  readonly supported_protocols: readonly string[];
  readonly supported_schemas: readonly string[];
  readonly provider_transports: readonly string[];
  readonly model_classes: readonly Readonly<{
    logical_class: string;
    capabilities: readonly string[];
  }>[];
  readonly skill_host_versions: readonly string[];
  readonly superpowers_capabilities: readonly string[];
  readonly mcp_transports: readonly string[];
  readonly mcp_profiles: readonly ArtifactReference[];
  readonly execution_topologies: readonly "sequential-worker-reviewer"[];
  readonly features: Readonly<{
    providers: Availability;
    routing: Availability;
    skills: Availability;
    mcp: Availability;
    agent_loop: Availability;
    review: Availability;
    evidence: Availability;
  }>;
}

export function createBaselineCapabilities(platform: {
  readonly os: "darwin" | "linux";
  readonly arch: string;
  readonly node: string;
}): RuntimeCapabilitiesV1 {
  return Object.freeze({
    protocol_version: PROTOCOL_VERSION,
    schema_version: "runtime-capabilities.v1",
    document_type: "runtime-capabilities",
    runtime: Object.freeze({
      kind: "runtime",
      name: "toss-agent-runtime",
      version: PACKAGE_VERSION,
    }),
    package: Object.freeze({ name: PACKAGE_NAME, version: PACKAGE_VERSION }),
    platform: Object.freeze({ ...platform }),
    supported_protocols: Object.freeze([PROTOCOL_VERSION]),
    supported_schemas: Object.freeze([
      "agent-definition.v1",
      "agent-registry-entry.v1",
      "agentgateway-capabilities.v1",
      "candidate-job-intent.v1",
      "compiled-context.v1",
      "execution-event.v1",
      "execution-request.v1",
      "execution-result.v1",
      "model-catalog.v1",
      "model-selection-plan.v1",
      "operational-event.v1",
      "project-registry-entry.v1",
      "project-watch-manifest.v1",
      "prompt-template.v1",
      "provider-event.v1",
      "routing-policy.v1",
      "routing-state.v1",
      "run-journal-entry.v1",
      "runtime-capabilities.v1",
      "service-control-request.v1",
      "service-control-response.v1",
      "service-lock.v1",
      "skill-descriptor.v1",
      "skill-execution-evidence.v1",
      "skill-snapshot.v1",
      "superpowers-approval.v1",
      "superpowers-phase.v1",
    ]),
    provider_transports: Object.freeze(["agentgateway", "openai", "anthropic", "gemini"]),
    model_classes: Object.freeze([
      Object.freeze({ logical_class: "economy", capabilities: Object.freeze(["text"]) }),
      Object.freeze({
        logical_class: "balanced-code",
        capabilities: Object.freeze(["json-schema", "text", "tools"]),
      }),
      Object.freeze({
        logical_class: "deep-reasoning",
        capabilities: Object.freeze(["reasoning", "text"]),
      }),
      Object.freeze({
        logical_class: "long-context",
        capabilities: Object.freeze(["long-context", "text"]),
      }),
      Object.freeze({
        logical_class: "vision",
        capabilities: Object.freeze(["text", "vision"]),
      }),
      Object.freeze({
        logical_class: "independent-review",
        capabilities: Object.freeze(["independent-review", "reasoning", "text"]),
      }),
    ]),
    skill_host_versions: AGENT_SKILL_HOST_VERSIONS,
    superpowers_capabilities: SUPERPOWERS_CAPABILITIES,
    mcp_transports: Object.freeze([]),
    mcp_profiles: Object.freeze([]),
    execution_topologies: Object.freeze([]),
    features: Object.freeze({
      providers: "available",
      routing: "available",
      skills: "available",
      mcp: "unavailable",
      agent_loop: "unavailable",
      review: "unavailable",
      evidence: "unavailable",
    }),
  });
}

export function parseRuntimeCapabilities(
  input: string | Uint8Array,
): ValidationResult<RuntimeCapabilitiesV1> {
  const result = createProtocolValidator().parse<RuntimeCapabilitiesV1>(
    input,
    "runtime-capabilities",
  );
  if (!result.ok) return result;

  const issues: ValidationIssue[] = [];
  if (
    result.value.features.providers === "unavailable" &&
    result.value.provider_transports.length > 0
  ) {
    issues.push(
      capabilityIssue(
        "/provider_transports",
        "featureCoherence",
        "unavailable providers cannot advertise provider transports",
      ),
    );
  }
  if (result.value.features.routing === "unavailable" && result.value.model_classes.length > 0) {
    issues.push(
      capabilityIssue(
        "/model_classes",
        "featureCoherence",
        "unavailable routing cannot advertise model classes",
      ),
    );
  }
  if (
    result.value.features.skills === "unavailable" &&
    (result.value.skill_host_versions.length > 0 ||
      result.value.superpowers_capabilities.length > 0)
  ) {
    issues.push(
      capabilityIssue(
        "/skill_host_versions",
        "featureCoherence",
        "unavailable skills cannot advertise skill resources",
      ),
    );
  }
  if (
    result.value.features.mcp === "unavailable" &&
    (result.value.mcp_transports.length > 0 || result.value.mcp_profiles.length > 0)
  ) {
    issues.push(
      capabilityIssue(
        "/mcp_transports",
        "featureCoherence",
        "unavailable MCP cannot advertise transports or profiles",
      ),
    );
  }
  if (
    (result.value.features.agent_loop === "unavailable" ||
      result.value.features.review === "unavailable") &&
    result.value.execution_topologies.length > 0
  ) {
    issues.push(
      capabilityIssue(
        "/execution_topologies",
        "featureCoherence",
        "unavailable execution or review cannot advertise topologies",
      ),
    );
  }
  if (
    result.value.features.providers === "available" &&
    result.value.provider_transports.length === 0
  ) {
    issues.push(
      capabilityIssue(
        "/provider_transports",
        "featureCoherence",
        "available providers require at least one provider transport",
      ),
    );
  }
  if (
    result.value.features.routing === "available" &&
    (result.value.features.providers !== "available" || result.value.model_classes.length === 0)
  ) {
    issues.push(
      capabilityIssue(
        "/model_classes",
        "featureCoherence",
        "available routing requires available providers and at least one model class",
      ),
    );
  }
  if (
    result.value.features.skills === "available" &&
    (result.value.skill_host_versions.length === 0 ||
      result.value.superpowers_capabilities.length === 0)
  ) {
    issues.push(
      capabilityIssue(
        "/skill_host_versions",
        "featureCoherence",
        "available skills require a host version and declared Superpowers capabilities",
      ),
    );
  }
  if (
    result.value.features.skills === "available" &&
    (JSON.stringify(result.value.skill_host_versions) !==
      JSON.stringify(AGENT_SKILL_HOST_VERSIONS) ||
      JSON.stringify(result.value.superpowers_capabilities) !==
        JSON.stringify(SUPERPOWERS_CAPABILITIES))
  ) {
    issues.push(
      capabilityIssue(
        "/superpowers_capabilities",
        "featureCoherence",
        "available skills require the exact built-in Agent Skills host and capability set",
      ),
    );
  }
  if (
    result.value.features.mcp === "available" &&
    (result.value.mcp_transports.length === 0 || result.value.mcp_profiles.length === 0)
  ) {
    issues.push(
      capabilityIssue(
        "/mcp_transports",
        "featureCoherence",
        "available MCP requires a transport and an exact profile identity",
      ),
    );
  }
  if (
    (result.value.features.agent_loop === "available" ||
      result.value.features.review === "available") &&
    result.value.execution_topologies.length === 0
  ) {
    issues.push(
      capabilityIssue(
        "/execution_topologies",
        "featureCoherence",
        "available execution or review requires an execution topology",
      ),
    );
  }
  if (issues.length === 0) return result;
  issues.sort((left, right) =>
    `${left.path}\u0000${left.keyword}\u0000${left.message}`.localeCompare(
      `${right.path}\u0000${right.keyword}\u0000${right.message}`,
    ),
  );
  return { ok: false, code: "RUNTIME_DOCUMENT_INVALID", issues };
}

function capabilityIssue(path: string, keyword: string, message: string): ValidationIssue {
  return { path, keyword, message };
}

export function negotiateRequest(
  request: ExecutionRequestV1,
  capabilities: RuntimeCapabilitiesV1,
): ValidationResult<Readonly<{ protocol: "runtime-contract.v1" }>> {
  const issues: ValidationIssue[] = [];
  for (const feature of [
    "providers",
    "routing",
    "skills",
    "mcp",
    "agent_loop",
    "review",
    "evidence",
  ] as const) {
    if (capabilities.features[feature] !== "available") {
      issues.push(
        capabilityIssue(
          `/features/${feature}`,
          "featureAvailability",
          `required feature is not available: ${feature}`,
        ),
      );
    }
  }
  if (!capabilities.supported_protocols.includes(request.protocol_version)) {
    issues.push(capabilityIssue("/protocol_version", "protocol", "protocol is unsupported"));
  }
  if (!capabilities.supported_schemas.includes(request.schema_version)) {
    issues.push(capabilityIssue("/schema_version", "schema", "request schema is unsupported"));
  }
  if (capabilities.provider_transports.length === 0) {
    issues.push(
      capabilityIssue(
        "/provider_transports",
        "providerTransport",
        "provider transport is unavailable",
      ),
    );
  }
  if (capabilities.skill_host_versions.length === 0) {
    issues.push(capabilityIssue("/skill_host_versions", "skillHost", "skill host is unavailable"));
  }

  const modelClass = capabilities.model_classes.find(
    (entry) => entry.logical_class === request.model.logical_class,
  );
  if (modelClass === undefined) {
    issues.push(
      capabilityIssue("/model/logical_class", "modelClass", "model class is unavailable"),
    );
  } else {
    for (const required of request.model.required_capabilities) {
      if (!modelClass.capabilities.includes(required)) {
        issues.push(
          capabilityIssue(
            "/model/required_capabilities",
            "modelCapability",
            `required model capability is unavailable: ${required}`,
          ),
        );
      }
    }
  }

  for (const required of request.superpowers.required) {
    if (!capabilities.superpowers_capabilities.includes(required)) {
      issues.push(
        capabilityIssue(
          "/superpowers/required",
          "superpowersCapability",
          `required Superpowers capability is unavailable: ${required}`,
        ),
      );
    }
  }
  if (capabilities.mcp_transports.length === 0) {
    issues.push(capabilityIssue("/mcp/profile", "mcpTransport", "MCP is unavailable"));
  }
  const requestedProfile = request.mcp.profile;
  const profileAvailable = capabilities.mcp_profiles.some(
    (profile) =>
      profile.document_type === requestedProfile.document_type &&
      profile.artifact_id === requestedProfile.artifact_id &&
      profile.revision === requestedProfile.revision &&
      profile.hash === requestedProfile.hash,
  );
  if (!profileAvailable) {
    issues.push(capabilityIssue("/mcp/profile", "mcpProfile", "exact MCP profile is unavailable"));
  }
  if (!capabilities.execution_topologies.includes("sequential-worker-reviewer")) {
    issues.push(
      capabilityIssue(
        "/review_policy",
        "executionTopology",
        "sequential worker-reviewer execution is unavailable",
      ),
    );
  }

  if (issues.length > 0) {
    issues.sort((left, right) =>
      `${left.path}\u0000${left.keyword}\u0000${left.message}`.localeCompare(
        `${right.path}\u0000${right.keyword}\u0000${right.message}`,
      ),
    );
    return { ok: false, code: "RUNTIME_DOCUMENT_UNSUPPORTED", issues };
  }
  return { ok: true, value: { protocol: "runtime-contract.v1" } };
}
