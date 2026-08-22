export {
  hashAgentDefinition,
  hashAgentRegistryEntry,
  hashCompiledContext,
  hashPromptTemplate,
  parseAgentDefinition,
  parseAgentRegistryEntry,
  parseCompiledContext,
  parsePromptTemplate,
} from "./contracts.js";
export { matchAgentAuthority, type EffectiveAgentAuthority } from "./authority.js";
export { createAgentRegistry, type CreateAgentRegistryOptions } from "./registry.js";
import { UnavailableCapabilityError } from "../version.js";

export function requireAgentRegistry(): never {
  throw new UnavailableCapabilityError("agents");
}
export { RuntimeAgentError, type RuntimeAgentErrorCode } from "./errors.js";
export type {
  AgentBudgetClass,
  AgentArtifactReference,
  AgentCapability,
  AgentContextPolicyV1,
  AgentDefinitionBundle,
  AgentDefinitionReference,
  AgentDefinitionV1,
  AgentLogicalModelClass,
  AgentRegistration,
  AgentRegistry,
  AgentRegistryEntryV1,
  AgentRole,
  CompiledContextV1,
  CompiledContextSegmentV1,
  InputArtifactSegmentV1,
  HashableAgentDefinitionV1,
  HashableAgentRegistryEntryV1,
  HashableCompiledContextV1,
  HashablePromptTemplateV1,
  McpProfileReference,
  OutputSchemaReference,
  PromptTemplateReference,
  PromptTemplateSegmentV1,
  PromptTemplateV1,
  ResolvedAgentBundle,
  TaskContractReference,
  TaskContractSegmentV1,
  RuntimeSafetySegmentV1,
  OutputSchemaSegmentV1,
} from "./types.js";
