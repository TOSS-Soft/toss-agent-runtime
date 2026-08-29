import type { ExecutionRequestV1 } from "../protocol/request.js";
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

export type AgentArtifactReference<TDocumentType extends string> = ArtifactReference &
  Readonly<{ document_type: TDocumentType }>;
export type PromptTemplateReference = AgentArtifactReference<"prompt-template">;
export type TaskContractReference = AgentArtifactReference<"task-contract">;
export type McpProfileReference = AgentArtifactReference<"mcp-profile">;
export type OutputSchemaReference = AgentArtifactReference<"output-schema">;
export type AgentDefinitionReference = AgentArtifactReference<"agent-definition">;

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
  readonly prompt_template: PromptTemplateReference;
  readonly task_contracts: readonly TaskContractReference[];
  readonly model: AgentModelPolicyV1;
  readonly superpowers: AgentSuperpowersPolicyV1;
  readonly mcp_profiles: readonly McpProfileReference[];
  readonly budget_class: AgentBudgetClass;
  readonly budget_ceiling: RuntimeBudget;
  readonly output_schemas: readonly OutputSchemaReference[];
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
  readonly definition: AgentDefinitionReference;
  readonly prompt_template: PromptTemplateReference;
  readonly state: "ACTIVE" | "RETIRED";
  readonly occurred_at: string;
}

export interface AgentRegistryEntryV1 extends HashableAgentRegistryEntryV1 {
  readonly entry_hash: `sha256:${string}`;
}

export type CompiledContextTrust = "trusted-runtime" | "trusted-control" | "untrusted-content";
export type CompiledContextSegmentKind =
  "runtime-safety" | "task-contract" | "prompt-template" | "output-schema" | "input-artifact";

export interface CompiledContextSegmentBaseV1 {
  readonly segment_id: string;
  readonly original_hash: `sha256:${string}`;
  readonly included_hash: `sha256:${string}`;
  readonly original_bytes: number;
  readonly included_bytes: number;
  readonly tokens: number;
  readonly content: string;
}

export interface RuntimeSafetySegmentV1 extends CompiledContextSegmentBaseV1 {
  readonly kind: "runtime-safety";
  readonly trust: "trusted-runtime";
  readonly source: null;
}

export interface TaskContractSegmentV1 extends CompiledContextSegmentBaseV1 {
  readonly kind: "task-contract";
  readonly trust: "trusted-control";
  readonly source: TaskContractReference;
}

export interface PromptTemplateSegmentV1 extends CompiledContextSegmentBaseV1 {
  readonly kind: "prompt-template";
  readonly trust: "trusted-control";
  readonly source: PromptTemplateReference;
  readonly block_id: string;
}

export interface OutputSchemaSegmentV1 extends CompiledContextSegmentBaseV1 {
  readonly kind: "output-schema";
  readonly trust: "trusted-control";
  readonly source: OutputSchemaReference;
}

export interface InputArtifactSegmentV1 extends CompiledContextSegmentBaseV1 {
  readonly kind: "input-artifact";
  readonly trust: "untrusted-content";
  readonly source: ArtifactReference;
}

export type CompiledContextSegmentV1 =
  | RuntimeSafetySegmentV1
  | TaskContractSegmentV1
  | PromptTemplateSegmentV1
  | OutputSchemaSegmentV1
  | InputArtifactSegmentV1;

export interface CompiledContextAuthorityV1 {
  readonly logical_class: AgentLogicalModelClass;
  readonly model_capabilities: readonly AgentCapability[];
  readonly superpowers: readonly string[];
  readonly mcp_profile: McpProfileReference;
  readonly budget: RuntimeBudget;
}

export interface CompiledContextAccountingV1 {
  readonly input_tokens: number;
  readonly input_bytes: number;
  readonly untrusted_bytes: number;
  readonly remaining_input_tokens: number;
}

export interface CompiledContextAllocationPolicyV1 {
  readonly definition_max_input_tokens: number;
  readonly truncation: "utf8-prefix.v1";
  readonly max_untrusted_bytes: number;
  readonly inputs: readonly ContextInputPolicyV1[];
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
  readonly definition: AgentDefinitionReference;
  readonly prompt_template: PromptTemplateReference;
  readonly task_contract: TaskContractReference;
  readonly output_schema: OutputSchemaReference;
  readonly authority: CompiledContextAuthorityV1;
  readonly runtime_policy: Readonly<{ revision: number; hash: `sha256:${string}` }>;
  readonly allocation_policy: CompiledContextAllocationPolicyV1;
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

export interface ResolvedContextArtifact {
  readonly reference: ArtifactReference;
  readonly media_type: "application/json" | "text/plain";
  readonly sensitivity: "public" | "internal" | "confidential" | "secret";
  readonly origin: "control-plane" | "repository" | "web" | "model" | "skill" | "tool";
  readonly bytes: Uint8Array;
}

export interface ContextArtifactResolver {
  resolve(reference: ArtifactReference): Promise<ResolvedContextArtifact>;
}

export interface CompileAgentContextInput {
  readonly request_hash: `sha256:${string}`;
  readonly request: ExecutionRequestV1;
  readonly bundle: ResolvedAgentBundle;
  readonly resolver: ContextArtifactResolver;
}

export interface AgentRegistration {
  readonly registry_revision: number;
  readonly definition: ArtifactReference;
  readonly prompt_template: ArtifactReference;
  readonly state: "ACTIVE" | "RETIRED";
  readonly entry_hash: `sha256:${string}`;
}

export interface AgentRegistry {
  recover(): Promise<void>;
  publish(bundle: AgentDefinitionBundle, operationId: string): Promise<AgentRegistration>;
  retire(definition: ArtifactReference, operationId: string): Promise<AgentRegistration>;
  resolveForExecution(definition: ArtifactReference): Promise<ResolvedAgentBundle>;
  resolveForResume(definition: ArtifactReference): Promise<ResolvedAgentBundle>;
  list(): Promise<readonly AgentRegistration[]>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}
