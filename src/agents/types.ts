import type { ArtifactReference, RuntimeBudget, RuntimeDocument } from "../protocol/types.js";

export type AgentRole = "worker" | "reviewer";
export type AgentBudgetClass = "interactive" | "standard" | "extended";
export type AgentLogicalModelClass =
  "economy" | "balanced-code" | "deep-reasoning" | "long-context" | "vision" | "independent-review";
export type AgentCapability =
  | "independent-review"
  | "json-schema"
  | "long-context"
  | "reasoning"
  | "streaming"
  | "text"
  | "tools"
  | "vision";

export interface PromptInstructionBlockV1 {
  readonly block_id: string;
  readonly content: string;
}

export interface HashablePromptTemplateV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "prompt-template.v1";
  readonly document_type: "prompt-template";
  readonly template_id: string;
  readonly revision: number;
  readonly instruction_blocks: readonly PromptInstructionBlockV1[];
}

export interface PromptTemplateV1 extends HashablePromptTemplateV1 {
  readonly document_hash: `sha256:${string}`;
}

export interface AgentModelPolicyV1 {
  readonly logical_class: AgentLogicalModelClass;
  readonly required_capabilities: readonly AgentCapability[];
  readonly allowed_capabilities: readonly AgentCapability[];
}

export interface AgentSuperpowersPolicyV1 {
  readonly required: readonly string[];
  readonly allowed: readonly string[];
}

export interface ContextInputPolicyV1 {
  readonly document_type: string;
  readonly priority: number;
  readonly max_bytes: number;
}

export interface AgentContextPolicyV1 {
  readonly truncation: "utf8-prefix.v1";
  readonly max_untrusted_bytes: number;
  readonly inputs: readonly ContextInputPolicyV1[];
}

export interface HashableAgentDefinitionV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "agent-definition.v1";
  readonly document_type: "agent-definition";
  readonly agent_id: string;
  readonly revision: number;
  readonly name: string;
  readonly role: AgentRole;
  readonly prompt_template: ArtifactReference & Readonly<{ document_type: "prompt-template" }>;
  readonly task_contracts: readonly ArtifactReference[];
  readonly model: AgentModelPolicyV1;
  readonly superpowers: AgentSuperpowersPolicyV1;
  readonly mcp_profiles: readonly ArtifactReference[];
  readonly budget_class: AgentBudgetClass;
  readonly budget_ceiling: RuntimeBudget;
  readonly output_schemas: readonly ArtifactReference[];
  readonly context_policy: AgentContextPolicyV1;
}

export interface AgentDefinitionV1 extends HashableAgentDefinitionV1 {
  readonly document_hash: `sha256:${string}`;
}

export interface HashableAgentRegistryEntryV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "agent-registry-entry.v1";
  readonly document_type: "agent-registry-entry";
  readonly registry_revision: number;
  readonly previous_entry_hash: `sha256:${string}` | null;
  readonly operation_id: string;
  readonly operation_hash: `sha256:${string}`;
  readonly definition: ArtifactReference & Readonly<{ document_type: "agent-definition" }>;
  readonly prompt_template: ArtifactReference & Readonly<{ document_type: "prompt-template" }>;
  readonly state: "ACTIVE" | "RETIRED";
  readonly occurred_at: string;
}

export interface AgentRegistryEntryV1 extends HashableAgentRegistryEntryV1 {
  readonly entry_hash: `sha256:${string}`;
}

export type CompiledContextTrust = "trusted-runtime" | "trusted-control" | "untrusted-content";
export type CompiledContextSegmentKind =
  "runtime-safety" | "task-contract" | "prompt-template" | "output-schema" | "input-artifact";

export interface CompiledContextSegmentV1 {
  readonly segment_id: string;
  readonly kind: CompiledContextSegmentKind;
  readonly trust: CompiledContextTrust;
  readonly source: ArtifactReference | null;
  readonly original_hash: `sha256:${string}`;
  readonly included_hash: `sha256:${string}`;
  readonly original_bytes: number;
  readonly included_bytes: number;
  readonly tokens: number;
  readonly content: string;
}

export interface CompiledContextAuthorityV1 {
  readonly logical_class: AgentLogicalModelClass;
  readonly model_capabilities: readonly AgentCapability[];
  readonly superpowers: readonly string[];
  readonly mcp_profile: ArtifactReference;
  readonly budget: RuntimeBudget;
}

export interface CompiledContextAccountingV1 {
  readonly input_tokens: number;
  readonly input_bytes: number;
  readonly untrusted_bytes: number;
  readonly remaining_input_tokens: number;
}

export interface ContextTruncationV1 {
  readonly source: ArtifactReference;
  readonly reason: "input-budget" | "definition-ceiling";
  readonly original_bytes: number;
  readonly included_bytes: number;
}

export interface HashableCompiledContextV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "compiled-context.v1";
  readonly document_type: "compiled-context";
  readonly request_hash: `sha256:${string}`;
  readonly definition: ArtifactReference & Readonly<{ document_type: "agent-definition" }>;
  readonly prompt_template: ArtifactReference & Readonly<{ document_type: "prompt-template" }>;
  readonly task_contract: ArtifactReference & Readonly<{ document_type: "task-contract" }>;
  readonly output_schema: ArtifactReference & Readonly<{ document_type: "output-schema" }>;
  readonly authority: CompiledContextAuthorityV1;
  readonly runtime_policy: Readonly<{ revision: number; hash: `sha256:${string}` }>;
  readonly segments: readonly CompiledContextSegmentV1[];
  readonly accounting: CompiledContextAccountingV1;
  readonly truncations: readonly ContextTruncationV1[];
}

export interface CompiledContextV1 extends HashableCompiledContextV1 {
  readonly document_hash: `sha256:${string}`;
}

export interface AgentDefinitionBundle {
  readonly definition: AgentDefinitionV1;
  readonly prompt_template: PromptTemplateV1;
}

export type ResolvedAgentBundle = AgentDefinitionBundle;

export interface AgentRegistration {
  readonly registry_revision: number;
  readonly definition: ArtifactReference;
  readonly prompt_template: ArtifactReference;
  readonly state: "ACTIVE" | "RETIRED";
  readonly entry_hash: `sha256:${string}`;
}
