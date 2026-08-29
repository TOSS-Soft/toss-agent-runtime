import type { ExecutionRequestV1 } from "../protocol/request.js";
import type { ArtifactReference, RuntimeBudget } from "../protocol/types.js";
import { RuntimeAgentError } from "./errors.js";
import type { AgentDefinitionV1 } from "./types.js";

export interface EffectiveAgentAuthority {
  readonly definition: ArtifactReference;
  readonly role: string;
  readonly task_contract: ArtifactReference;
  readonly logical_class: string;
  readonly model_capabilities: readonly string[];
  readonly superpowers_capabilities: readonly string[];
  readonly mcp_profile: ArtifactReference;
  readonly budget: RuntimeBudget;
  readonly output_schema: ArtifactReference;
}

const BUDGET_DIMENSIONS = [
  "max_input_tokens",
  "max_output_tokens",
  "max_cost_microusd",
  "max_duration_ms",
  "max_turns",
] as const satisfies readonly (keyof RuntimeBudget)[];

function sameReference(left: ArtifactReference, right: ArtifactReference): boolean {
  return (
    left.document_type === right.document_type &&
    left.artifact_id === right.artifact_id &&
    left.revision === right.revision &&
    left.hash === right.hash
  );
}

function copyReference(reference: ArtifactReference): ArtifactReference {
  return reference.location === undefined
    ? {
        document_type: reference.document_type,
        artifact_id: reference.artifact_id,
        revision: reference.revision,
        hash: reference.hash,
      }
    : {
        document_type: reference.document_type,
        artifact_id: reference.artifact_id,
        revision: reference.revision,
        hash: reference.hash,
        location: reference.location,
      };
}

function copyBudget(budget: RuntimeBudget): RuntimeBudget {
  return {
    max_input_tokens: budget.max_input_tokens,
    max_output_tokens: budget.max_output_tokens,
    max_cost_microusd: budget.max_cost_microusd,
    max_duration_ms: budget.max_duration_ms,
    max_turns: budget.max_turns,
  };
}

function sortedCapabilities(capabilities: readonly string[]): string[] {
  return [...capabilities].sort();
}

function isNarrowedSet(
  requestedCapabilities: readonly string[],
  requiredCapabilities: readonly string[],
  allowedCapabilities: readonly string[],
): boolean {
  const requested = sortedCapabilities(requestedCapabilities);
  const required = sortedCapabilities(requiredCapabilities);
  const allowed = new Set(sortedCapabilities(allowedCapabilities));
  if (new Set(requested).size !== requested.length) return false;
  return (
    requested.every((capability) => allowed.has(capability)) &&
    required.every((capability) => requested.includes(capability))
  );
}

function requireAuthority(condition: boolean): asserts condition {
  if (!condition) throw new RuntimeAgentError("RUNTIME_CONTEXT_AUTHORITY_MISMATCH");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function matchAgentAuthority(
  request: ExecutionRequestV1,
  definition: AgentDefinitionV1,
): EffectiveAgentAuthority {
  requireAuthority(
    sameReference(request.agent.definition, {
      document_type: "agent-definition",
      artifact_id: definition.agent_id,
      revision: definition.revision,
      hash: definition.document_hash,
    }),
  );
  requireAuthority(request.agent.role === definition.role);
  requireAuthority(
    definition.task_contracts.some((candidate) => sameReference(request.task_contract, candidate)),
  );
  requireAuthority(request.model.logical_class === definition.model.logical_class);

  const modelCapabilities = sortedCapabilities(request.model.required_capabilities);
  requireAuthority(
    isNarrowedSet(
      modelCapabilities,
      definition.model.required_capabilities,
      definition.model.allowed_capabilities,
    ),
  );

  const superpowersCapabilities = sortedCapabilities(request.superpowers.required);
  requireAuthority(
    isNarrowedSet(
      superpowersCapabilities,
      definition.superpowers.required,
      definition.superpowers.allowed,
    ),
  );

  const mcpProfile = definition.mcp_profiles.find((candidate) =>
    sameReference(request.mcp.profile, candidate),
  );
  requireAuthority(mcpProfile !== undefined);

  for (const dimension of BUDGET_DIMENSIONS) {
    requireAuthority(request.budget[dimension] <= definition.budget_ceiling[dimension]);
  }

  const outputSchema = definition.output_schemas.find((candidate) =>
    sameReference(request.output.schema, candidate),
  );
  requireAuthority(outputSchema !== undefined);

  return deepFreeze({
    definition: copyReference(request.agent.definition),
    role: request.agent.role,
    task_contract: copyReference(request.task_contract),
    logical_class: request.model.logical_class,
    model_capabilities: modelCapabilities,
    superpowers_capabilities: superpowersCapabilities,
    mcp_profile: copyReference(request.mcp.profile),
    budget: copyBudget(request.budget),
    output_schema: copyReference(request.output.schema),
  });
}
