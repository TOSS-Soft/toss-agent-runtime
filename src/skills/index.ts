import { randomUUID } from "node:crypto";
import path from "node:path";

import { createRunJournalStore } from "../journal/store.js";
import type { JournalHead } from "../journal/types.js";
import type { TraceContext } from "../protocol/types.js";
import { assertConfiguredSkillRootPath } from "./paths.js";
import { createSkillsRuntimeHost } from "./runtime-host.js";
import type { RuntimeSkillErrorCode } from "./errors.js";
import {
  SKILL_LIMITS,
  type SkillCatalogRoot,
  type SkillDescriptorReference,
  type SkillDescriptorV1,
  type SkillExecutionEvidenceV1,
  type SkillSnapshotV1,
  type SuperpowersApprovalV1,
  type SuperpowersPhaseName,
  type SuperpowersPhaseV1,
} from "./types.js";

export {
  hashSkillCatalog,
  hashSkillDescriptor,
  hashSkillExecutionEvidence,
  hashSkillPackage,
  hashSkillSnapshot,
  hashSuperpowersApproval,
  hashSuperpowersPhase,
  parseSkillDescriptor,
  parseSkillExecutionEvidence,
  parseSkillSnapshot,
  parseSuperpowersApproval,
  parseSuperpowersPhase,
} from "./contracts.js";
export { RuntimeSkillError, type RuntimeSkillErrorCode } from "./errors.js";
export { SKILL_LIMITS };

export interface SkillsHostConfig {
  readonly state_path: string;
  readonly socket_path: string;
  readonly skill_roots: readonly string[];
}

export interface SkillDiscoveryRequest {
  readonly query: string | null;
  readonly allowed_capabilities: readonly string[];
}

export type SkillCatalogSnapshot = SkillCatalogRoot;

export interface SkillSelectionRequest {
  readonly mode: "explicit" | "implicit";
  readonly capability: string;
  readonly allowed_capabilities: readonly string[];
  readonly query: string | null;
  readonly descriptor: SkillDescriptorReference | null;
}

export interface SkillSelection {
  readonly descriptor: SkillDescriptorV1;
  readonly catalog_hash: `sha256:${string}`;
  readonly catalog_root: SkillCatalogRoot;
  readonly package_handle: `sha256:${string}`;
}

export interface SkillContextRequest {
  readonly snapshot: SkillSnapshotV1;
  readonly snapshot_hash: `sha256:${string}`;
  readonly phase: SuperpowersPhaseName;
  readonly max_bytes: number;
  readonly max_tokens: number;
}

export interface SkillContextSegment {
  readonly path: string;
  readonly role: "skill" | "reference" | "asset";
  readonly source_hash: `sha256:${string}`;
  readonly included_hash: `sha256:${string}`;
  readonly original_bytes: number;
  readonly included_bytes: number;
  readonly conservative_tokens: number;
  readonly content: string;
}

export interface SkillContextTruncation {
  readonly path: string;
  readonly original_bytes: number;
  readonly included_bytes: number;
}

export interface SkillContext {
  readonly snapshot: Readonly<{
    name: string;
    version: string;
    package_hash: `sha256:${string}`;
    snapshot_hash: `sha256:${string}`;
  }>;
  readonly phase: SuperpowersPhaseName;
  readonly segments: readonly SkillContextSegment[];
  readonly included_resource_hashes: readonly `sha256:${string}`[];
  readonly omitted_resource_hashes: readonly `sha256:${string}`[];
  readonly original_utf8_bytes: number;
  readonly included_utf8_bytes: number;
  readonly original_tokens: number;
  readonly included_tokens: number;
  readonly remaining_bytes: number;
  readonly remaining_tokens: number;
  readonly truncations: readonly SkillContextTruncation[];
  readonly resource_accounting: readonly Readonly<{
    path: string;
    source_hash: `sha256:${string}`;
    state: "INCLUDED" | "PARTIAL" | "OMITTED";
    original_bytes: number;
    included_bytes: number;
    included_hash: `sha256:${string}` | null;
    original_conservative_units: number;
    included_conservative_units: number;
  }>[];
  readonly context_hash: `sha256:${string}`;
}

export interface SkillHostContextRequest extends SkillContextRequest {
  readonly selection: SkillSelection;
}

export interface StartSuperpowersPhaseRequest {
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly execution_request_hash: `sha256:${string}`;
  readonly selection: SkillSelection;
  readonly phase: SuperpowersPhaseName;
  readonly input: Uint8Array;
  readonly operation_id: string;
  readonly trace: TraceContext;
}

export interface CompleteSuperpowersPhaseRequest {
  readonly run_id: string;
  readonly expected_phase_revision: number;
  readonly expected_phase_head_hash: `sha256:${string}`;
  readonly phase: SuperpowersPhaseName;
  readonly skill_snapshot_hash: `sha256:${string}`;
  readonly operation_id: string;
  readonly outcome: "COMPLETED" | "FAILED" | "BLOCKED";
  readonly terminal_code: RuntimeSkillErrorCode | null;
  readonly output: Uint8Array;
  readonly trace: TraceContext;
}

export interface ResumeSuperpowersApprovalRequest {
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly phase: SuperpowersPhaseName;
  readonly skill_name: string;
  readonly skill_version: string;
  readonly skill_snapshot_hash: `sha256:${string}`;
  readonly approval_request_hash: `sha256:${string}`;
  readonly operation_id: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly trace: TraceContext;
}

export interface SuperpowersPhaseOutcome {
  readonly state: "RUNNING" | "APPROVAL_PENDING" | "BLOCKED";
  readonly phase: SuperpowersPhaseV1;
  readonly journal_head: JournalHead;
  readonly approval: SuperpowersApprovalV1 | null;
  readonly replayed: boolean;
}

export interface SkillsHost {
  recover(): Promise<void>;
  discover(request: SkillDiscoveryRequest): Promise<SkillCatalogSnapshot>;
  select(request: SkillSelectionRequest): Promise<SkillSelection>;
  load(selection: SkillSelection): Promise<SkillSnapshotV1>;
  assembleContext(request: SkillHostContextRequest): Promise<SkillContext>;
  startPhase(request: StartSuperpowersPhaseRequest): Promise<SuperpowersPhaseOutcome>;
  completePhase(request: CompleteSuperpowersPhaseRequest): Promise<SuperpowersPhaseOutcome>;
  resumeApproval(request: ResumeSuperpowersApprovalRequest): Promise<SuperpowersPhaseOutcome>;
  evidence(runId: string): Promise<SkillExecutionEvidenceV1 | null>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    (value as readonly unknown[]).every((entry) => typeof entry === "string")
  );
}

export function createSkillsHost(config: SkillsHostConfig): SkillsHost {
  const keys = Object.keys(config).sort();
  if (
    Object.getPrototypeOf(config) !== Object.prototype ||
    keys.join("\u0000") !== ["skill_roots", "socket_path", "state_path"].join("\u0000") ||
    !path.isAbsolute(config.state_path) ||
    path.normalize(config.state_path) !== config.state_path ||
    !path.isAbsolute(config.socket_path) ||
    path.normalize(config.socket_path) !== config.socket_path ||
    /[\u0000-\u001f\u007f]/u.test(config.state_path) ||
    /[\u0000-\u001f\u007f]/u.test(config.socket_path) ||
    !isStringArray(config.skill_roots)
  ) {
    throw new Error("Invalid SkillsHostConfig");
  }
  const roots = [...config.skill_roots];
  for (const root of roots) assertConfiguredSkillRootPath(root);
  if (
    roots.length > SKILL_LIMITS.roots ||
    roots.some(
      (root, index) =>
        index > 0 && Buffer.from(roots[index - 1]!, "utf8").compare(Buffer.from(root, "utf8")) >= 0,
    ) ||
    roots.some((root, index) =>
      roots.slice(index + 1).some((candidate) => {
        const relative = path.relative(root, candidate);
        return (
          relative !== "" && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`)
        );
      }),
    )
  ) {
    throw new Error("Invalid SkillsHostConfig");
  }
  const statePath = config.state_path;
  const socketPath = config.socket_path;
  const now = () => new Date();
  const journal = createRunJournalStore({ statePath, now, randomId: randomUUID });
  return createSkillsRuntimeHost({
    statePath,
    socketPath,
    configuredRoots: Object.freeze(roots),
    journal,
    now,
    randomId: randomUUID,
  });
}

export type {
  HashableSkillDescriptorV1,
  HashableSkillExecutionEvidenceV1,
  HashableSkillSnapshotV1,
  HashableSuperpowersApprovalV1,
  HashableSuperpowersPhaseV1,
  SkillDescriptorReference,
  SkillDescriptorV1,
  SkillCatalogRoot,
  SkillExecutionEvidenceV1,
  SkillJournalPathLinkV1,
  SkillResourceRole,
  SkillResourceV1,
  SkillSnapshotV1,
  SkillSourceKind,
  SuperpowersApprovalDecisionV1,
  SuperpowersApprovalRequestV1,
  SuperpowersApprovalV1,
  SuperpowersPhaseName,
  SuperpowersPhaseStatus,
  SuperpowersPhaseV1,
} from "./types.js";
