import { lstatSync, watch as watchFileSystem, type FSWatcher } from "node:fs";
import path from "node:path";

import { canonicalJson } from "../../protocol/json.js";
import { RuntimeProjectError } from "./errors.js";
import type { ProjectIntake } from "./intake.js";
import {
  classifyProjectChange,
  compileProjectScope,
  scanDeclaredScope,
  type CompiledProjectScope,
} from "./paths.js";
import { loadRegisteredProjectManifest, type ProjectRegistry } from "./registry.js";
import type { ProjectChange, ProjectFileIdentity, ProjectRegistration } from "./types.js";

export type ProjectWatchAdapterEvent =
  | { readonly kind: "change"; readonly absolutePath: string }
  | { readonly kind: "overflow" }
  | { readonly kind: "error" };

export interface ProjectWatchSubscription {
  close(): void;
}

export interface ProjectWatchAdapter {
  watch(
    absolutePath: string,
    recursive: boolean,
    listener: (event: ProjectWatchAdapterEvent) => void,
  ): ProjectWatchSubscription;
}

export interface CreateProjectWatcherOptions {
  readonly registry: ProjectRegistry;
  readonly intake: ProjectIntake;
  readonly runtimeStatePath: string;
  readonly adapter?: ProjectWatchAdapter;
}

export interface ProjectWatcher {
  recover(): Promise<void>;
  register(root: string): Promise<ProjectRegistration>;
  unregister(projectId: string): Promise<ProjectRegistration>;
  list(): Promise<readonly ProjectRegistration[]>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}

interface ActiveProject {
  readonly registration: ProjectRegistration;
  readonly scope: CompiledProjectScope;
  baseline: ReadonlyMap<string, ProjectFileIdentity>;
  readonly subscriptions: ProjectWatchSubscription[];
}

function projectError(code: ConstructorParameters<typeof RuntimeProjectError>[0]): never {
  throw new RuntimeProjectError(code);
}

function bytewise(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function sameIdentity(
  left: ProjectFileIdentity | undefined,
  right: ProjectFileIdentity | undefined,
): boolean {
  return left !== undefined && right !== undefined && canonicalJson(left) === canonicalJson(right);
}

function snapshot(changes: readonly ProjectChange[]): ReadonlyMap<string, ProjectFileIdentity> {
  const result = new Map<string, ProjectFileIdentity>();
  for (const change of changes) {
    if (change.identity !== null) result.set(change.path, change.identity);
  }
  return result;
}

function difference(
  previous: ReadonlyMap<string, ProjectFileIdentity>,
  next: ReadonlyMap<string, ProjectFileIdentity>,
): readonly ProjectChange[] {
  const paths = [...new Set([...previous.keys(), ...next.keys()])].sort(bytewise);
  const changes: ProjectChange[] = [];
  for (const relativePath of paths) {
    const before = previous.get(relativePath);
    const after = next.get(relativePath);
    if (before === undefined && after !== undefined) {
      changes.push(Object.freeze({ kind: "CREATED", path: relativePath, identity: after }));
    } else if (before !== undefined && after === undefined) {
      changes.push(Object.freeze({ kind: "REMOVED", path: relativePath, identity: null }));
    } else if (!sameIdentity(before, after) && after !== undefined) {
      changes.push(Object.freeze({ kind: "CHANGED", path: relativePath, identity: after }));
    }
  }
  return Object.freeze(changes);
}

function closeProject(project: ActiveProject): void {
  for (const subscription of project.subscriptions.splice(0).toReversed()) {
    try {
      subscription.close();
    } catch {
      // The registry transition below is the durable source of the blocked state.
    }
  }
}

class NodeProjectWatchAdapter implements ProjectWatchAdapter {
  watch(
    absolutePath: string,
    recursive: boolean,
    listener: (event: ProjectWatchAdapterEvent) => void,
  ): ProjectWatchSubscription {
    if (process.platform !== "darwin") projectError("RUNTIME_PROJECT_UNAVAILABLE");
    let watcher: FSWatcher;
    try {
      watcher = watchFileSystem(
        absolutePath,
        { persistent: false, recursive, encoding: "utf8" },
        (_eventType, filename) => {
          if (filename === null) {
            listener({ kind: "overflow" });
            return;
          }
          const observed = recursive ? path.join(absolutePath, filename) : absolutePath;
          listener({ kind: "change", absolutePath: observed });
        },
      );
      watcher.on("error", () => listener({ kind: "error" }));
    } catch {
      projectError("RUNTIME_PROJECT_UNAVAILABLE");
    }
    return { close: () => watcher.close() };
  }
}

export function createProjectWatcher(options: CreateProjectWatcherOptions): ProjectWatcher {
  const adapter = options.adapter ?? new NodeProjectWatchAdapter();
  const active = new Map<string, ActiveProject>();
  let eventTail: Promise<void> = Promise.resolve();
  let stopped = false;
  let dependenciesStopped = false;
  let eventFailure: unknown;

  const block = async (projectId: string): Promise<void> => {
    const project = active.get(projectId);
    if (project === undefined) return;
    active.delete(projectId);
    closeProject(project);
    await options.registry.blockUnavailable(projectId);
  };

  const rescan = async (project: ActiveProject): Promise<void> => {
    let next: ReadonlyMap<string, ProjectFileIdentity>;
    try {
      next = snapshot(scanDeclaredScope(project.scope));
    } catch (error) {
      if (error instanceof RuntimeProjectError) {
        await block(project.registration.project_id);
        return;
      }
      throw error;
    }
    const changes = difference(project.baseline, next);
    for (const change of changes) {
      await options.intake.record(project.registration, change);
    }
    project.baseline = next;
  };

  const handle = async (projectId: string, event: ProjectWatchAdapterEvent): Promise<void> => {
    const project = active.get(projectId);
    if (project === undefined) return;
    if (event.kind === "error") {
      await block(projectId);
      return;
    }
    if (event.kind === "change") {
      try {
        if (classifyProjectChange(project.scope, event.absolutePath) === null) return;
      } catch (error) {
        if (error instanceof RuntimeProjectError) {
          await block(projectId);
          return;
        }
        throw error;
      }
    }
    await rescan(project);
  };

  const schedule = (projectId: string, event: ProjectWatchAdapterEvent): void => {
    eventTail = eventTail
      .catch(() => undefined)
      .then(() => handle(projectId, event))
      .catch((error: unknown) => {
        eventFailure ??= error;
      });
  };

  const arm = (registration: ProjectRegistration): void => {
    const manifest = loadRegisteredProjectManifest(registration);
    const scope = compileProjectScope({
      registration,
      manifest,
      runtimeStatePath: options.runtimeStatePath,
    });
    const project: ActiveProject = {
      registration,
      scope,
      baseline: snapshot(scanDeclaredScope(scope)),
      subscriptions: [],
    };
    active.set(registration.project_id, project);
    try {
      for (const watchPath of scope.watchPaths) {
        const absolutePath = path.join(scope.canonicalRoot, ...watchPath.split("/"));
        const metadata = lstatSync(absolutePath, { bigint: true });
        const subscription = adapter.watch(absolutePath, metadata.isDirectory(), (event) =>
          schedule(registration.project_id, event),
        );
        project.subscriptions.push(subscription);
      }
    } catch (error) {
      active.delete(registration.project_id);
      closeProject(project);
      throw error;
    }
  };

  const awaitEvents = async (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) projectError("RUNTIME_PROJECT_UNAVAILABLE");
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<void>((_resolve, reject) => {
      onAbort = () => reject(new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([eventTail, aborted]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
    if (eventFailure !== undefined) {
      const failure = eventFailure;
      eventFailure = undefined;
      throw failure instanceof Error
        ? failure
        : new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE");
    }
  };

  return {
    async recover() {
      if (stopped) projectError("RUNTIME_PROJECT_UNAVAILABLE");
      await options.registry.recover();
      const registrations = await options.registry.list();
      await options.intake.recover(registrations);
      for (const registration of registrations) {
        try {
          arm(registration);
        } catch (error) {
          if (!(error instanceof RuntimeProjectError)) throw error;
          await options.registry.blockUnavailable(registration.project_id);
        }
      }
    },
    async register(root) {
      if (stopped) projectError("RUNTIME_PROJECT_UNAVAILABLE");
      await awaitEvents(new AbortController().signal);
      const registration = await options.registry.register(root);
      const existing = active.get(registration.project_id);
      if (existing?.registration.registry_revision === registration.registry_revision) {
        return registration;
      }
      if (existing !== undefined) {
        active.delete(registration.project_id);
        closeProject(existing);
        await options.intake.discard(registration.project_id);
      }
      try {
        arm(registration);
      } catch (error) {
        await options.registry.blockUnavailable(registration.project_id);
        if (error instanceof RuntimeProjectError) throw error;
        projectError("RUNTIME_PROJECT_UNAVAILABLE");
      }
      return registration;
    },
    async unregister(projectId) {
      if (stopped) projectError("RUNTIME_PROJECT_UNAVAILABLE");
      const existing = active.get(projectId);
      if (existing !== undefined) {
        active.delete(projectId);
        closeProject(existing);
      }
      await awaitEvents(new AbortController().signal);
      await options.intake.discard(projectId);
      try {
        return await options.registry.unregister(projectId);
      } catch (error) {
        if (existing !== undefined) arm(existing.registration);
        throw error;
      }
    },
    async list() {
      if (stopped) projectError("RUNTIME_PROJECT_UNAVAILABLE");
      await awaitEvents(new AbortController().signal);
      return options.registry.list();
    },
    stopIntake() {
      if (stopped) return;
      stopped = true;
      for (const project of [...active.values()].toReversed()) closeProject(project);
    },
    async flush(signal) {
      let failure: unknown;
      try {
        await awaitEvents(signal);
      } catch (error) {
        failure = error;
      }
      if (stopped && !dependenciesStopped) {
        active.clear();
        dependenciesStopped = true;
        try {
          options.intake.stopIntake();
        } catch (error) {
          failure ??= error;
        }
        try {
          options.registry.stopIntake();
        } catch (error) {
          failure ??= error;
        }
      }
      try {
        await options.intake.flush(signal);
      } catch (error) {
        failure ??= error;
      }
      try {
        await options.registry.flush(signal);
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) {
        throw failure instanceof Error
          ? failure
          : new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE");
      }
    },
  };
}
