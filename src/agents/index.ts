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
import { UnavailableCapabilityError } from "../version.js";

export function requireAgentRegistry(): never {
  throw new UnavailableCapabilityError("agents");
}
export { RuntimeAgentError, type RuntimeAgentErrorCode } from "./errors.js";
export type {
  AgentBudgetClass,
  AgentCapability,
  AgentContextPolicyV1,
  AgentDefinitionBundle,
  AgentDefinitionV1,
  AgentLogicalModelClass,
  AgentRegistration,
  AgentRegistryEntryV1,
  AgentRole,
  CompiledContextV1,
  HashableAgentDefinitionV1,
  HashableAgentRegistryEntryV1,
  HashableCompiledContextV1,
  HashablePromptTemplateV1,
  PromptTemplateV1,
  ResolvedAgentBundle,
} from "./types.js";
