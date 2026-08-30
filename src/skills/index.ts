import type { RunJournalStore } from "../journal/store.js";
import {
  createSkillCatalog,
  type SkillCatalogSnapshot,
  type SkillDiscoveryRequest,
  type SkillSelection,
  type SkillSelectionRequest,
} from "./catalog.js";
import type { SkillContext, SkillContextRequest } from "./context.js";
import {
  createSkillsEngine,
  type CompleteSuperpowersPhaseRequest,
  type StartSuperpowersPhaseRequest,
  type SuperpowersPhaseOutcome,
} from "./engine.js";
import { createSkillEvidenceBuilder } from "./evidence.js";
import { RuntimeSkillError } from "./errors.js";
import { createSkillLoader } from "./loader.js";
import type { ResumeSuperpowersApprovalRequest } from "./approval.js";
import type { SkillExecutionEvidenceV1, SkillSnapshotV1 } from "./types.js";

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
export { SKILL_LIMITS } from "./types.js";

export interface CreateSkillsHostOptions {
  readonly statePath: string;
  readonly configuredRoots: readonly string[];
  readonly journal: RunJournalStore;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly hasServiceListener: () => Promise<"present" | "absent" | "unknown">;
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

export function createSkillsHost(options: CreateSkillsHostOptions): SkillsHost {
  const catalog = createSkillCatalog({ configuredRoots: options.configuredRoots });
  const loader = createSkillLoader({
    statePath: options.statePath,
    catalog,
    now: options.now,
    randomId: options.randomId,
    hasServiceListener: options.hasServiceListener,
  });
  const engine = createSkillsEngine({
    statePath: options.statePath,
    journal: options.journal,
    catalog,
    loader,
    now: options.now,
    randomId: options.randomId,
    hasServiceListener: options.hasServiceListener,
  });
  const evidence = createSkillEvidenceBuilder({
    statePath: options.statePath,
    engine,
    now: options.now,
    randomId: options.randomId,
    hasServiceListener: options.hasServiceListener,
  });
  const pending = new Set<Promise<unknown>>();
  let stopped = false;

  const accept = <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopped) return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE"));
    const accepted = Promise.resolve().then(operation);
    pending.add(accepted);
    void accepted.finally(() => pending.delete(accepted)).catch(() => undefined);
    return accepted;
  };

  const host: SkillsHost = {
    recover: () => accept(() => engine.recover()),
    discover: (request) => accept(() => engine.discover(request)),
    select: (request) =>
      accept(async () => {
        const snapshot = await engine.discover({
          query: request.query,
          allowed_capabilities: request.allowed_capabilities,
        });
        return engine.select(snapshot, request);
      }),
    load: (selection) => accept(() => engine.load(selection)),
    assembleContext: (request) => {
      const { selection, ...contextRequest } = request;
      return accept(() => engine.assembleContext(selection, contextRequest));
    },
    startPhase: (request) => accept(() => engine.startPhase(request)),
    completePhase: (request) => accept(() => engine.completePhase(request)),
    resumeApproval: (request) => accept(() => engine.resumeApproval(request)),
    evidence: (runId) => accept(() => evidence.evidence(runId)),
    stopIntake() {
      if (stopped) return;
      stopped = true;
      engine.stopIntake();
    },
    async flush(signal) {
      while (!signal.aborted && pending.size > 0) {
        let listener: (() => void) | undefined;
        const aborted = new Promise<void>((resolve) => {
          listener = () => resolve();
          signal.addEventListener("abort", listener, { once: true });
        });
        try {
          await Promise.race([Promise.allSettled([...pending]).then(() => undefined), aborted]);
        } finally {
          if (listener !== undefined) signal.removeEventListener("abort", listener);
        }
      }
      await engine.flush(signal);
    },
  };
  return Object.freeze(host);
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
  SkillExecutionEvidenceV1,
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
