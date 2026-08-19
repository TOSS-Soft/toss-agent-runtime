import { PACKAGE_NAME, PACKAGE_VERSION, PROTOCOL_VERSION } from "../version.js";
import type { ExecutionRequestV1 } from "./request.js";
import type {
  ProducerIdentity,
  RuntimeDocument,
  ValidationIssue,
  ValidationResult,
} from "./types.js";
import { createProtocolValidator } from "./validator.js";

export type Availability = "available" | "unavailable" | "blocked";

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
      "execution-request.v1",
      "execution-event.v1",
      "execution-result.v1",
      "runtime-capabilities.v1",
    ]),
    provider_transports: Object.freeze([]),
    model_classes: Object.freeze([]),
    skill_host_versions: Object.freeze([]),
    superpowers_capabilities: Object.freeze([]),
    mcp_transports: Object.freeze([]),
    execution_topologies: Object.freeze([]),
    features: Object.freeze({
      providers: "unavailable",
      routing: "unavailable",
      skills: "unavailable",
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
  return createProtocolValidator().parse<RuntimeCapabilitiesV1>(input, "runtime-capabilities");
}

function capabilityIssue(path: string, keyword: string, message: string): ValidationIssue {
  return { path, keyword, message };
}

export function negotiateRequest(
  request: ExecutionRequestV1,
  capabilities: RuntimeCapabilitiesV1,
): ValidationResult<Readonly<{ protocol: "runtime-contract.v1" }>> {
  const issues: ValidationIssue[] = [];
  if (!capabilities.supported_protocols.includes(request.protocol_version)) {
    issues.push(capabilityIssue("/protocol_version", "protocol", "protocol is unsupported"));
  }
  if (!capabilities.supported_schemas.includes(request.schema_version)) {
    issues.push(capabilityIssue("/schema_version", "schema", "request schema is unsupported"));
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
