import { sha256 } from "./json.js";
import type {
  ArtifactReference,
  RuntimeBudget,
  RuntimeDocument,
  TraceContext,
  ValidationFailure,
  ValidationIssue,
  ValidationResult,
} from "./types.js";
import { createProtocolValidator } from "./validator.js";

export interface ExecutionRequestV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "execution-request.v1";
  readonly document_type: "execution-request";
  readonly request_id: string;
  readonly run_id: string;
  readonly created_at: string;
  readonly deadline: string;
  readonly task_contract: ArtifactReference;
  readonly input_artifacts: readonly ArtifactReference[];
  readonly agent: Readonly<{ definition: ArtifactReference; role: string }>;
  readonly model: Readonly<{
    logical_class: string;
    required_capabilities: readonly string[];
  }>;
  readonly superpowers: Readonly<{ required: readonly string[] }>;
  readonly mcp: Readonly<{ profile: ArtifactReference }>;
  readonly budget: RuntimeBudget;
  readonly review_policy: ArtifactReference;
  readonly output: Readonly<{ schema: ArtifactReference }>;
  readonly trace: TraceContext;
}

function sortIssues(issues: ValidationIssue[]): readonly ValidationIssue[] {
  return issues.sort((left, right) =>
    `${left.path}\u0000${left.keyword}\u0000${left.message}`.localeCompare(
      `${right.path}\u0000${right.keyword}\u0000${right.message}`,
    ),
  );
}

function semanticFailure(issues: ValidationIssue[]): ValidationFailure {
  return {
    ok: false,
    code: "RUNTIME_DOCUMENT_INVALID",
    issues: sortIssues(issues),
  };
}

function validateSemantics(request: ExecutionRequestV1): ValidationFailure | null {
  const issues: ValidationIssue[] = [];

  if (Date.parse(request.deadline) <= Date.parse(request.created_at)) {
    issues.push({
      path: "/deadline",
      keyword: "afterCreatedAt",
      message: "must be later than created_at",
    });
  }

  const artifacts = [request.task_contract, ...request.input_artifacts];
  const identities = new Set<string>();
  for (const [index, artifact] of artifacts.entries()) {
    const identity = `${artifact.artifact_id}\u0000${artifact.revision}`;
    if (identities.has(identity)) {
      issues.push({
        path: index === 0 ? "/task_contract" : `/input_artifacts/${index - 1}`,
        keyword: "uniqueArtifactRevision",
        message: "artifact_id and revision must be unique across canonical inputs",
      });
    }
    identities.add(identity);
  }

  return issues.length === 0 ? null : semanticFailure(issues);
}

export function parseExecutionRequest(
  input: string | Uint8Array,
): ValidationResult<ExecutionRequestV1> {
  const result = createProtocolValidator().parse<ExecutionRequestV1>(input, "execution-request");
  if (!result.ok) {
    return result;
  }
  return validateSemantics(result.value) ?? result;
}

export function hashExecutionRequest(request: ExecutionRequestV1): `sha256:${string}` {
  return sha256(request);
}
