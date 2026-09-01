import type { RunJournalStore } from "../journal/store.js";
import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  type JsonLimits,
  type JsonValue,
} from "../protocol/json.js";
import { probePrivateServiceSocketListener } from "../service/control.js";
import { createSkillCatalog } from "./catalog.js";
import { createSkillsEngine } from "./engine.js";
import { createSkillEvidenceBuilder } from "./evidence.js";
import { RuntimeSkillError } from "./errors.js";
import { createSkillLoader } from "./loader.js";
import type { SkillPrivateStoreOperationHooks } from "./private-store.js";
import type { SkillsHost, SkillSelectionRequest } from "./index.js";
import { SKILL_LIMITS } from "./types.js";

export interface CreateSkillsRuntimeHostOptions {
  readonly statePath: string;
  readonly socketPath: string;
  readonly configuredRoots: readonly string[];
  readonly journal: RunJournalStore;
  readonly now: () => Date;
  readonly randomId: () => string;
}

interface CreateSkillsRuntimeHostTestOptions extends CreateSkillsRuntimeHostOptions {
  readonly hasServiceListener: () => Promise<"present" | "absent" | "unknown">;
  readonly evidenceStoreOperationHooks?: SkillPrivateStoreOperationHooks;
}

const SELECTION_REQUEST_LIMITS: JsonLimits = Object.freeze({
  maxBytes: SKILL_LIMITS.descriptorBytes + SKILL_LIMITS.queryBytes + 16_384,
  maxDepth: SKILL_LIMITS.nestingDepth,
  maxMembers: SKILL_LIMITS.resourcesPerPackage + 64,
});

function captureSelectionRequest(value: unknown): SkillSelectionRequest {
  let captured: JsonValue;
  try {
    const canonical = canonicalJson(value, SELECTION_REQUEST_LIMITS);
    if (Buffer.byteLength(canonical, "utf8") > SELECTION_REQUEST_LIMITS.maxBytes) {
      throw new Error("selection request byte limit");
    }
    captured = deepFreezeJson(
      parseJsonBytes(canonical, SELECTION_REQUEST_LIMITS),
      SELECTION_REQUEST_LIMITS,
    );
  } catch {
    throw new RuntimeSkillError("RUNTIME_SKILL_INVALID");
  }
  const record = captured as { readonly [key: string]: JsonValue };
  if (
    typeof captured !== "object" ||
    captured === null ||
    Array.isArray(captured) ||
    Object.keys(captured).sort().join("\u0000") !==
      ["allowed_capabilities", "capability", "descriptor", "mode", "query"].sort().join("\u0000") ||
    (record.mode !== "explicit" && record.mode !== "implicit")
  ) {
    throw new RuntimeSkillError("RUNTIME_SKILL_INVALID");
  }
  return captured as unknown as SkillSelectionRequest;
}

function createHost(options: CreateSkillsRuntimeHostTestOptions): SkillsHost {
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
    ...(options.evidenceStoreOperationHooks === undefined
      ? {}
      : { operationHooks: options.evidenceStoreOperationHooks }),
  });
  const pending = new Set<Promise<unknown>>();
  let stopped = false;
  let engineStopped = false;

  const stopEngineWhenDrained = (): void => {
    if (!stopped || engineStopped || pending.size !== 0) return;
    engineStopped = true;
    engine.stopIntake();
  };

  const accept = <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopped) return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE"));
    let accepted: Promise<T>;
    try {
      accepted = operation();
    } catch (error) {
      accepted = Promise.reject(
        error instanceof Error ? error : new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY"),
      );
    }
    pending.add(accepted);
    void accepted
      .finally(() => {
        pending.delete(accepted);
        stopEngineWhenDrained();
      })
      .catch(() => undefined);
    return accepted;
  };

  const host: SkillsHost = {
    recover: () =>
      accept(async () => {
        await loader.recover();
        await engine.recover();
      }),
    discover: (request) => accept(() => engine.discover(request)),
    select(request) {
      if (stopped) return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE"));
      let captured: SkillSelectionRequest;
      try {
        captured = captureSelectionRequest(request);
      } catch (error) {
        return Promise.reject(
          error instanceof RuntimeSkillError
            ? error
            : new RuntimeSkillError("RUNTIME_SKILL_INVALID"),
        );
      }
      return accept(async () => {
        const snapshot = await engine.discover({
          query: captured.mode === "explicit" ? null : captured.query,
          allowed_capabilities: captured.allowed_capabilities,
        });
        return engine.select(snapshot, captured);
      });
    },
    load: (selection) => accept(() => engine.load(selection)),
    assembleContext: (request) => accept(() => engine.assembleContext(request)),
    startPhase: (request) => accept(() => engine.startPhase(request)),
    completePhase: (request) => accept(() => engine.completePhase(request)),
    resumeApproval: (request) => accept(() => engine.resumeApproval(request)),
    evidence: (runId) => accept(() => evidence.evidence(runId)),
    stopIntake() {
      if (stopped) return;
      stopped = true;
      stopEngineWhenDrained();
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
      stopEngineWhenDrained();
      await engine.flush(signal);
    },
  };
  return Object.freeze(host);
}

export function createSkillsRuntimeHost(options: CreateSkillsRuntimeHostOptions): SkillsHost {
  return createHost({
    ...options,
    hasServiceListener: () => probePrivateServiceSocketListener({ socketPath: options.socketPath }),
  });
}

export function createSkillsRuntimeHostForTest(
  options: CreateSkillsRuntimeHostTestOptions,
): SkillsHost {
  return createHost(options);
}
