import type { JournalHead } from "../journal/types.js";
import type { RuntimeDocument, TraceContext } from "../protocol/types.js";
import type { RuntimeSkillErrorCode } from "./errors.js";

export type SkillSourceKind = "configured" | "bundled";
export type SkillResourceRole = "reference" | "asset" | "script";
export type SuperpowersPhaseName =
  "BRAINSTORMING" | "TEST_DESIGN" | "RED" | "GREEN" | "DEBUGGING" | "REVIEW" | "VERIFICATION";
export type SuperpowersPhaseStatus =
  "STARTED" | "APPROVAL_PENDING" | "COMPLETED" | "FAILED" | "BLOCKED";

export const SKILL_LIMITS = Object.freeze({
  roots: 16,
  packagesPerRoot: 256,
  resourcesPerPackage: 256,
  nestingDepth: 8,
  descriptorBytes: 65_536,
  skillMarkdownBytes: 524_288,
  resourceBytes: 2_097_152,
  packageBytes: 16_777_216,
  storedObjectBytes: 25_165_824,
  phaseInputBytes: 2_097_152,
  phaseOutputBytes: 2_097_152,
  evidenceBytes: 2_097_152,
  queryBytes: 512,
} as const);

export interface SkillDescriptorReference {
  readonly name: string;
  readonly version: string;
  readonly source: Readonly<{ kind: SkillSourceKind; identity: string }>;
  readonly package_hash: `sha256:${string}`;
  readonly document_hash: `sha256:${string}`;
}

export interface SkillDescriptorV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "skill-descriptor.v1";
  readonly document_type: "skill-descriptor";
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly source: Readonly<{ kind: SkillSourceKind; identity: string }>;
  readonly package_hash: `sha256:${string}`;
  readonly resource_count: number;
  readonly total_bytes: number;
  readonly required_runtime_capabilities: readonly string[];
  readonly document_hash: `sha256:${string}`;
}

export interface SkillResourceV1 {
  readonly path: string;
  readonly role: SkillResourceRole;
  readonly phases: readonly SuperpowersPhaseName[];
  readonly priority: number | null;
  readonly media_type: string;
  readonly bytes: number;
  readonly hash: `sha256:${string}`;
}

export interface SkillSnapshotV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "skill-snapshot.v1";
  readonly document_type: "skill-snapshot";
  readonly descriptor: SkillDescriptorV1;
  readonly skill_markdown_hash: `sha256:${string}`;
  readonly skill_markdown_bytes: number;
  readonly resources: readonly SkillResourceV1[];
  readonly package_hash: `sha256:${string}`;
  readonly total_bytes: number;
  readonly document_hash: `sha256:${string}`;
}

export interface SuperpowersPhaseV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "superpowers-phase.v1";
  readonly document_type: "superpowers-phase";
  readonly run_id: string;
  readonly phase_revision: number;
  readonly previous_phase_hash: `sha256:${string}`;
  readonly execution_request_hash: `sha256:${string}`;
  readonly observed_journal_head: JournalHead;
  readonly skill: Readonly<{ name: string; version: string; snapshot_hash: `sha256:${string}` }>;
  readonly phase: SuperpowersPhaseName;
  readonly handler: Readonly<{ version: string; hash: `sha256:${string}` }>;
  readonly operation_id: string;
  readonly status: SuperpowersPhaseStatus;
  readonly predecessor_phase_hashes: readonly `sha256:${string}`[];
  readonly input_hash: `sha256:${string}`;
  readonly output_hash: `sha256:${string}` | null;
  readonly occurred_at: string;
  readonly trace: TraceContext;
  readonly document_hash: `sha256:${string}`;
}

export type SuperpowersApprovalV1 = SuperpowersApprovalRequestV1 | SuperpowersApprovalDecisionV1;

export interface SuperpowersApprovalRequestV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "superpowers-approval.v1";
  readonly document_type: "superpowers-approval";
  readonly kind: "REQUEST";
  readonly run_id: string;
  readonly pending_journal_head: JournalHead;
  readonly phase_document_hash: `sha256:${string}`;
  readonly phase: SuperpowersPhaseName;
  readonly skill_name: string;
  readonly skill_version: string;
  readonly skill_snapshot_hash: `sha256:${string}`;
  readonly phase_operation_id: string;
  readonly decision: null;
  readonly trace: TraceContext;
  readonly document_hash: `sha256:${string}`;
}

export interface SuperpowersApprovalDecisionV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "superpowers-approval.v1";
  readonly document_type: "superpowers-approval";
  readonly kind: "DECISION";
  readonly run_id: string;
  readonly pending_journal_head: JournalHead;
  readonly phase_document_hash: `sha256:${string}`;
  readonly phase: SuperpowersPhaseName;
  readonly skill_name: string;
  readonly skill_version: string;
  readonly skill_snapshot_hash: `sha256:${string}`;
  readonly phase_operation_id: string;
  readonly approval_request_hash: `sha256:${string}`;
  readonly operation_id: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly trace: TraceContext;
  readonly document_hash: `sha256:${string}`;
}

export interface SkillExecutionEvidenceV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "skill-execution-evidence.v1";
  readonly document_type: "skill-execution-evidence";
  readonly run_id: string;
  readonly catalog_hash: `sha256:${string}`;
  readonly skill: SkillDescriptorReference & Readonly<{ snapshot_hash: `sha256:${string}` }>;
  readonly resource_hashes: readonly `sha256:${string}`[];
  readonly phases: readonly Readonly<{
    phase: SuperpowersPhaseName;
    handler_hash: `sha256:${string}`;
    phase_hash: `sha256:${string}`;
    input_hash: `sha256:${string}`;
    output_hash: `sha256:${string}` | null;
  }>[];
  readonly approvals: readonly Readonly<{
    request_hash: `sha256:${string}`;
    decision_hash: `sha256:${string}` | null;
    journal_head: JournalHead;
  }>[];
  readonly context_hashes: readonly `sha256:${string}`[];
  readonly handoff_hash: `sha256:${string}`;
  readonly terminal_code: RuntimeSkillErrorCode | null;
  readonly document_hash: `sha256:${string}`;
}

export type HashableSkillDescriptorV1 = Omit<SkillDescriptorV1, "document_hash">;
export type HashableSkillSnapshotV1 = Omit<SkillSnapshotV1, "document_hash">;
export type HashableSuperpowersPhaseV1 = Omit<SuperpowersPhaseV1, "document_hash">;
export type HashableSuperpowersApprovalV1 = Omit<SuperpowersApprovalV1, "document_hash">;
export type HashableSkillExecutionEvidenceV1 = Omit<SkillExecutionEvidenceV1, "document_hash">;
