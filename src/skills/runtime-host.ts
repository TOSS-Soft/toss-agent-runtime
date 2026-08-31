import type { RunJournalStore } from "../journal/store.js";
import { probePrivateServiceSocketListener } from "../service/control.js";
import { createSkillCatalog } from "./catalog.js";
import { createSkillsEngine } from "./engine.js";
import { createSkillEvidenceBuilder } from "./evidence.js";
import { RuntimeSkillError } from "./errors.js";
import { createSkillLoader } from "./loader.js";
import type { SkillPrivateStoreOperationHooks } from "./private-store.js";
import type { SkillsHost } from "./index.js";

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

  const accept = <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopped) return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE"));
    const accepted = Promise.resolve().then(operation);
    pending.add(accepted);
    void accepted.finally(() => pending.delete(accepted)).catch(() => undefined);
    return accepted;
  };

  const host: SkillsHost = {
    recover: () =>
      accept(async () => {
        await loader.recover();
        await engine.recover();
      }),
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
