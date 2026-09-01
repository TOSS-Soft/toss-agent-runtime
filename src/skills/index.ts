import { randomUUID } from "node:crypto";
import path from "node:path";
import { types as utilTypes } from "node:util";

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

function invalidSkillsHostConfig(): never {
  throw new Error("Invalid SkillsHostConfig");
}

function capturedStringArray(value: unknown): readonly string[] {
  if (
    typeof value !== "object" ||
    value === null ||
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return invalidSkillsHostConfig();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > SKILL_LIMITS.roots
  ) {
    return invalidSkillsHostConfig();
  }
  const length = lengthDescriptor.value;
  const expectedNames = ["length", ...Array.from({ length }, (_unused, index) => String(index))];
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== expectedNames.length ||
    names.some((name) => !expectedNames.includes(name))
  ) {
    return invalidSkillsHostConfig();
  }
  const captured: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      typeof descriptor.value !== "string"
    ) {
      return invalidSkillsHostConfig();
    }
    captured.push(descriptor.value);
  }
  return Object.freeze(captured);
}

function captureSkillsHostConfig(value: unknown): Readonly<SkillsHostConfig> {
  if (
    typeof value !== "object" ||
    value === null ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return invalidSkillsHostConfig();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expectedNames = ["skill_roots", "socket_path", "state_path"];
  const names = Object.getOwnPropertyNames(value).sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    return invalidSkillsHostConfig();
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of expectedNames) {
    const descriptor = descriptors[name];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return invalidSkillsHostConfig();
    }
    captured[name] = descriptor.value;
  }
  if (typeof captured.state_path !== "string" || typeof captured.socket_path !== "string") {
    return invalidSkillsHostConfig();
  }
  return Object.freeze({
    state_path: captured.state_path,
    socket_path: captured.socket_path,
    skill_roots: capturedStringArray(captured.skill_roots),
  });
}

export function createSkillsHost(config: SkillsHostConfig): SkillsHost {
  const captured = captureSkillsHostConfig(config);
  if (
    !path.isAbsolute(captured.state_path) ||
    path.normalize(captured.state_path) !== captured.state_path ||
    !path.isAbsolute(captured.socket_path) ||
    path.normalize(captured.socket_path) !== captured.socket_path ||
    /[\u0000-\u001f\u007f]/u.test(captured.state_path) ||
    /[\u0000-\u001f\u007f]/u.test(captured.socket_path)
  ) {
    return invalidSkillsHostConfig();
  }
  const roots = [...captured.skill_roots];
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
    return invalidSkillsHostConfig();
  }
  const statePath = captured.state_path;
  const socketPath = captured.socket_path;
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
