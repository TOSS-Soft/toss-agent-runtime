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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

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
  readonly scanScope?: (scope: CompiledProjectScope) => readonly ProjectChange[];
}

export interface ProjectWatcher {
  recover(): Promise<void>;
  register(root: string, operationId?: string): Promise<ProjectRegistration>;
  unregister(projectId: string, operationId?: string): Promise<ProjectRegistration>;
  list(): Promise<readonly ProjectRegistration[]>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}

interface ActiveProject {
  readonly registration: ProjectRegistration;
  readonly scope: CompiledProjectScope;
  baseline: ReadonlyMap<string, ProjectFileIdentity>;
  readonly subscriptions: ArmedSubscription[];
}

interface ArmedSubscription {
  readonly absolutePath: string;
  readonly recursive: boolean;
  readonly subscription: ProjectWatchSubscription;
}

function projectError(code: ConstructorParameters<typeof RuntimeProjectError>[0]): never {
  throw new RuntimeProjectError(code);
}

function canonicalProjectId(value: string): string {
  if (!UUID_PATTERN.test(value)) projectError("RUNTIME_PROJECT_NOT_FOUND");
  return value.toLowerCase();
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
  for (const armed of project.subscriptions.splice(0).toReversed()) {
    try {
      armed.subscription.close();
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
  const scanScope = options.scanScope ?? scanDeclaredScope;
  const active = new Map<string, ActiveProject>();
  const pendingEvents = new Map<string, ProjectWatchAdapterEvent>();
  const scheduledProjects = new Set<string>();
  const commandOperations = new Set<Promise<unknown>>();
  let eventTail: Promise<void> = Promise.resolve();
  let stopped = false;
  let dependenciesStopped = false;
  let eventFailure: unknown;
  let refreshSubscriptions: (project: ActiveProject) => void = () => undefined;

  const block = async (projectId: string): Promise<void> => {
    const project = active.get(projectId);
    if (project === undefined) return;
    active.delete(projectId);
    closeProject(project);
    await options.registry.blockUnavailable(projectId);
    await options.intake.discard(projectId);
  };

  const rescan = async (project: ActiveProject): Promise<void> => {
    let next: ReadonlyMap<string, ProjectFileIdentity>;
    try {
      next = snapshot(scanScope(project.scope));
    } catch (error) {
      if (error instanceof RuntimeProjectError) {
        await block(project.registration.project_id);
        return;
      }
      throw error;
    }
    const changes = difference(project.baseline, next);
    await options.intake.recordBatch(project.registration, changes);
    project.baseline = next;
    try {
      if (!stopped) refreshSubscriptions(project);
    } catch (error) {
      if (error instanceof RuntimeProjectError) {
        await block(project.registration.project_id);
        return;
      }
      throw error;
    }
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

  const mergeEvent = (
    current: ProjectWatchAdapterEvent | undefined,
    next: ProjectWatchAdapterEvent,
  ): ProjectWatchAdapterEvent => {
    if (current === undefined || next.kind === "error") return next;
    if (current.kind === "error") return current;
    if (current.kind === "overflow" || next.kind === "overflow") return { kind: "overflow" };
    return current.absolutePath === next.absolutePath ? current : { kind: "overflow" };
  };

  const scheduleWorker = (projectId: string): void => {
    if (scheduledProjects.has(projectId)) return;
    scheduledProjects.add(projectId);
    eventTail = eventTail
      .catch(() => undefined)
      .then(async () => {
        try {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const event = pendingEvents.get(projectId);
            if (event === undefined) break;
            pendingEvents.delete(projectId);
            await handle(projectId, event);
          }
        } finally {
          scheduledProjects.delete(projectId);
          if (pendingEvents.has(projectId)) scheduleWorker(projectId);
        }
      })
      .catch((error: unknown) => {
        eventFailure ??= error;
      });
  };

  const schedule = (projectId: string, event: ProjectWatchAdapterEvent): void => {
    pendingEvents.set(projectId, mergeEvent(pendingEvents.get(projectId), event));
    scheduleWorker(projectId);
  };

  const subscriptionTarget = (
    scope: CompiledProjectScope,
    watchPath: string,
  ): { readonly absolutePath: string; readonly recursive: boolean } => {
    let absolutePath = scope.canonicalRoot;
    for (const segment of watchPath.split("/")) {
      const nextPath = path.join(absolutePath, segment);
      try {
        const metadata = lstatSync(nextPath, { bigint: true });
        if (metadata.isSymbolicLink()) projectError("RUNTIME_PROJECT_PATH_UNSAFE");
        absolutePath = nextPath;
        if (!metadata.isDirectory() && segment !== watchPath.split("/").at(-1)) {
          projectError("RUNTIME_PROJECT_PATH_UNSAFE");
        }
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return { absolutePath, recursive: true };
        }
        throw error instanceof RuntimeProjectError
          ? error
          : new RuntimeProjectError("RUNTIME_PROJECT_PATH_UNSAFE");
      }
    }
    const metadata = lstatSync(absolutePath, { bigint: true });
    return { absolutePath, recursive: metadata.isDirectory() };
  };

  refreshSubscriptions = (project): void => {
    const targets = new Map<
      string,
      { readonly absolutePath: string; readonly recursive: boolean }
    >();
    for (const watchPath of project.scope.watchPaths) {
      const target = subscriptionTarget(project.scope, watchPath);
      targets.set(`${target.absolutePath}\u0000${target.recursive ? "1" : "0"}`, target);
    }
    const currentKeys = project.subscriptions.map(
      (armed) => `${armed.absolutePath}\u0000${armed.recursive ? "1" : "0"}`,
    );
    if (currentKeys.length === targets.size && currentKeys.every((key) => targets.has(key))) {
      return;
    }

    const next: ArmedSubscription[] = [];
    try {
      for (const target of targets.values()) {
        next.push({
          ...target,
          subscription: adapter.watch(target.absolutePath, target.recursive, (event) =>
            schedule(project.registration.project_id, event),
          ),
        });
      }
    } catch (error) {
      for (const armed of next.toReversed()) armed.subscription.close();
      throw error;
    }
    const previous = project.subscriptions.splice(0);
    project.subscriptions.push(...next);
    for (const armed of previous.toReversed()) armed.subscription.close();
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
      baseline: snapshot(scanScope(scope)),
      subscriptions: [],
    };
    active.set(registration.project_id, project);
    try {
      refreshSubscriptions(project);
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
      while (true) {
        const observed = eventTail;
        await Promise.race([observed, aborted]);
        if (observed === eventTail && pendingEvents.size === 0 && scheduledProjects.size === 0) {
          break;
        }
      }
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

  const trackCommand = <T>(operation: Promise<T>): Promise<T> => {
    commandOperations.add(operation);
    void operation.finally(() => commandOperations.delete(operation)).catch(() => undefined);
    return operation;
  };

  const awaitCommands = async (signal: AbortSignal): Promise<void> => {
    while (commandOperations.size > 0) {
      if (signal.aborted) projectError("RUNTIME_PROJECT_UNAVAILABLE");
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<void>((_resolve, reject) => {
        onAbort = () => reject(new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        await Promise.race([
          Promise.allSettled([...commandOperations]).then(() => undefined),
          aborted,
        ]);
      } finally {
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      }
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
    register(root, operationId) {
      return trackCommand(
        (async () => {
          if (stopped) projectError("RUNTIME_PROJECT_UNAVAILABLE");
          await awaitEvents(new AbortController().signal);
          if (stopped) projectError("RUNTIME_PROJECT_UNAVAILABLE");
          const registration = await options.registry.register(root, operationId);
          const current = await options.registry.get(registration.project_id);
          if (current?.registry_revision !== registration.registry_revision) return registration;
          const existing = active.get(registration.project_id);
          if (existing?.registration.registry_revision === registration.registry_revision) {
            return registration;
          }
          if (existing !== undefined) {
            active.delete(registration.project_id);
            closeProject(existing);
            await options.intake.discard(registration.project_id);
          }
          if (stopped) return registration;
          try {
            arm(registration);
          } catch (error) {
            await options.registry.blockUnavailable(registration.project_id);
            if (error instanceof RuntimeProjectError) throw error;
            projectError("RUNTIME_PROJECT_UNAVAILABLE");
          }
          return registration;
        })(),
      );
    },
    unregister(projectId, operationId) {
      return trackCommand(
        (async () => {
          if (stopped) projectError("RUNTIME_PROJECT_UNAVAILABLE");
          const canonicalId = canonicalProjectId(projectId);
          await awaitEvents(new AbortController().signal);
          if (stopped) projectError("RUNTIME_PROJECT_UNAVAILABLE");
          const registration = await options.registry.unregister(canonicalId, operationId);
          const current = await options.registry.get(canonicalId);
          if (current !== null) return registration;
          const existing = active.get(canonicalId);
          if (existing !== undefined) {
            active.delete(canonicalId);
            closeProject(existing);
          }
          await options.intake.discard(canonicalId);
          return registration;
        })(),
      );
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
        await awaitCommands(signal);
      } catch (error) {
        failure = error;
      }
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
