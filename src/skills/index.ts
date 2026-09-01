import { randomUUID } from "node:crypto";
import path from "node:path";

import { createRunJournalStore } from "../journal/store.js";
import {
  type SkillCatalogSnapshot,
  type SkillDiscoveryRequest,
  type SkillSelection,
  type SkillSelectionRequest,
} from "./catalog.js";
import type { SkillContext, SkillContextRequest } from "./context.js";
import {
  type CompleteSuperpowersPhaseRequest,
  type StartSuperpowersPhaseRequest,
  type SuperpowersPhaseOutcome,
} from "./engine.js";
import type { ResumeSuperpowersApprovalRequest } from "./approval.js";
import { assertConfiguredSkillRootPath } from "./paths.js";
import { createSkillsRuntimeHost } from "./runtime-host.js";
import { SKILL_LIMITS, type SkillExecutionEvidenceV1, type SkillSnapshotV1 } from "./types.js";

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

export interface SkillHostContextRequest extends SkillContextRequest {
  readonly selection: SkillSelection;
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
  SkillCatalogSnapshot,
  SkillDiscoveryRequest,
  SkillSelection,
  SkillSelectionRequest,
} from "./catalog.js";
export type {
  SkillContext,
  SkillContextRequest,
  SkillContextSegment,
  SkillContextTruncation,
} from "./context.js";
export type {
  CompleteSuperpowersPhaseRequest,
  StartSuperpowersPhaseRequest,
  SuperpowersPhaseOutcome,
} from "./engine.js";
export type { ResumeSuperpowersApprovalRequest } from "./approval.js";
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
