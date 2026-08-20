import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../src/protocol/json.js";
import { PROJECT_CANDIDATE_JSON_LIMITS } from "../src/service/project/contracts.js";
import { createProjectIntake } from "../src/service/project/intake.js";
import { RuntimeProjectError } from "../src/service/project/errors.js";
import { scanDeclaredScope } from "../src/service/project/paths.js";
import { createProjectRegistry } from "../src/service/project/registry.js";
import {
  createProjectWatcher,
  type ProjectWatchAdapter,
  type ProjectWatchAdapterEvent,
  type ProjectWatchSubscription,
} from "../src/service/project/watcher.js";
import type { ProjectChange } from "../src/service/project/types.js";

const roots: string[] = [];

class FakeWatchAdapter implements ProjectWatchAdapter {
  readonly listeners = new Set<(event: ProjectWatchAdapterEvent) => void>();
  readonly targets = new Map<
    (event: ProjectWatchAdapterEvent) => void,
    { readonly absolutePath: string; readonly recursive: boolean }
  >();
  closed = 0;

  watch(
    absolutePath: string,
    recursive: boolean,
    listener: (event: ProjectWatchAdapterEvent) => void,
  ): ProjectWatchSubscription {
    this.listeners.add(listener);
    this.targets.set(listener, { absolutePath, recursive });
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        this.closed += 1;
        this.listeners.delete(listener);
        this.targets.delete(listener);
      },
    };
  }

  activePaths(): readonly string[] {
    return [...this.targets.values()].map((target) => target.absolutePath).sort();
  }

  emit(event: ProjectWatchAdapterEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

async function fixture(): Promise<{
  readonly root: string;
  readonly statePath: string;
  readonly projectRoot: string;
  readonly outsideRoot: string;
}> {
  const temporary = await realpath("/tmp");
  const root = await mkdtemp(path.join(temporary, "toss-project-watcher-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  const outsideRoot = path.join(root, "outside");
  await mkdir(path.join(projectRoot, ".toss"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(projectRoot, "src", "generated"), { recursive: true, mode: 0o700 });
  await mkdir(outsideRoot, { mode: 0o700 });
  await Promise.all([
    writeFile(
      path.join(projectRoot, ".toss", "project.yaml"),
      [
        "schema_version: project-watch-manifest.v1",
        "watch_paths:",
        "  - src",
        "ignore_paths:",
        "  - src/generated",
        "",
      ].join("\n"),
      { mode: 0o600 },
    ),
    writeFile(path.join(projectRoot, "src", "old.ts"), "old", { mode: 0o600 }),
    writeFile(path.join(projectRoot, "src", "generated", "ignored.ts"), "ignored", {
      mode: 0o600,
    }),
    writeFile(path.join(outsideRoot, "outside.ts"), "outside", { mode: 0o600 }),
  ]);
  return { root, statePath: path.join(root, "state"), projectRoot, outsideRoot };
}

function services(statePath: string) {
  let registryId = 0;
  let intakeId = 100;
  let registryTick = 0;
  const registry = createProjectRegistry({
    statePath,
    now: () => new Date(Date.UTC(2026, 7, 20, 12, 0, registryTick++)),
    randomId: () => `00000000-0000-4000-8000-${String(++registryId).padStart(12, "0")}`,
  });
  const intake = createProjectIntake({
    statePath,
    now: () => new Date(Date.UTC(2026, 7, 20, 13, 0, 0)),
    randomId: () => `00000000-0000-4000-8000-${String(++intakeId).padStart(12, "0")}`,
  });
  return { registry, intake };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("registered project watcher coordinator", () => {
  it("arms explicit runtime registrations and stops them on unregister", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();

    const registered = await watcher.register(projectRoot);
    await writeFile(path.join(projectRoot, "src", "old.ts"), "changed");
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "old.ts") });
    await watcher.flush(signal());
    expect(await intake.listCandidates()).toHaveLength(1);

    const unregistered = await watcher.unregister(registered.project_id);
    expect(unregistered.state).toBe("UNREGISTERED");
    expect(adapter.listeners.size).toBe(0);
    expect(await watcher.list()).toEqual([]);
  });

  it("preserves active intake when an unregister operation id conflicts", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    const operationId = "00000000-0000-4000-8000-000000000090";
    const registered = await registry.register(projectRoot, operationId);
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();
    await writeFile(path.join(projectRoot, "src", "old.ts"), "changed");
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "old.ts") });

    await expect(watcher.unregister(registered.project_id, operationId)).rejects.toMatchObject({
      code: "RUNTIME_OPERATION_CONFLICT",
    });
    await watcher.flush(signal());

    expect(await registry.list()).toEqual([registered]);
    expect(await intake.listCandidates()).toHaveLength(1);
    expect(adapter.activePaths()).toEqual([path.join(projectRoot, "src")]);
  });

  it("canonicalizes an uppercase unregister id across watcher and pending intake", async () => {
    const { statePath, projectRoot } = await fixture();
    const { intake } = services(statePath);
    const ids = ["018f0b7a-5f2d-7abc-8def-0123456789ab", "018f0b7a-5f2d-7abc-8def-0123456789aa"];
    const registry = createProjectRegistry({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => ids.shift()!,
    });
    const registered = await registry.register(projectRoot);
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();
    await writeFile(path.join(projectRoot, "src", "old.ts"), "changed");
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "old.ts") });

    await expect(
      watcher.unregister(
        registered.project_id.toUpperCase(),
        "018F0B7A-5F2D-7ABC-8DEF-0123456789AC",
      ),
    ).resolves.toMatchObject({
      project_id: registered.project_id,
      state: "UNREGISTERED",
    });

    expect(await registry.list()).toEqual([]);
    expect(adapter.activePaths()).toEqual([]);
    expect(await readdir(path.join(statePath, "projects", "pending"))).toEqual([]);
  });

  it("does not re-arm a project when replaying an older register operation", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    const registerOperation = "00000000-0000-4000-8000-000000000090";
    const unregisterOperation = "00000000-0000-4000-8000-000000000091";
    const registered = await registry.register(projectRoot, registerOperation);
    await registry.unregister(registered.project_id, unregisterOperation);
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();

    await expect(watcher.register(projectRoot, registerOperation)).resolves.toEqual(registered);

    expect(await watcher.list()).toEqual([]);
    expect(adapter.activePaths()).toEqual([]);
  });

  it("does not stop a reactivated project when replaying an older unregister operation", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    const registered = await registry.register(projectRoot, "00000000-0000-4000-8000-000000000090");
    const unregistered = await registry.unregister(
      registered.project_id,
      "00000000-0000-4000-8000-000000000091",
    );
    const reactivated = await registry.register(
      projectRoot,
      "00000000-0000-4000-8000-000000000092",
    );
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();

    await expect(
      watcher.unregister(registered.project_id, "00000000-0000-4000-8000-000000000091"),
    ).resolves.toEqual(unregistered);

    expect(await watcher.list()).toEqual([reactivated]);
    expect(adapter.activePaths()).toEqual([path.join(projectRoot, "src")]);
  });

  it("does not arm a delayed registration after watcher shutdown has flushed", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    const registered = await registry.register(projectRoot, "00000000-0000-4000-8000-000000000090");
    await registry.unregister(registered.project_id, "00000000-0000-4000-8000-000000000091");
    let releaseRegister: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      releaseRegister = resolve;
    });
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry: {
        ...registry,
        list: () => Promise.resolve([]),
        register: async () => {
          signalStarted?.();
          await delayed;
          return registered;
        },
        get: () => Promise.resolve(registered),
      },
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();

    const registering = watcher.register(projectRoot, "00000000-0000-4000-8000-000000000092");
    await started;
    watcher.stopIntake();
    const flushing = watcher.flush(signal());
    let flushed = false;
    void flushing.then(() => {
      flushed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);
    releaseRegister?.();

    await expect(registering).resolves.toEqual(registered);
    await expect(flushing).resolves.toBeUndefined();
    expect(adapter.activePaths()).toEqual([]);
  });

  it("does not re-arm a delayed conflicting unregister after watcher shutdown", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    const registered = await registry.register(projectRoot);
    let releaseUnregister: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      releaseUnregister = resolve;
    });
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry: {
        ...registry,
        unregister: async () => {
          signalStarted?.();
          await delayed;
          throw new RuntimeProjectError("RUNTIME_OPERATION_CONFLICT");
        },
      },
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();

    const unregistering = watcher.unregister(
      registered.project_id,
      "00000000-0000-4000-8000-000000000090",
    );
    await started;
    watcher.stopIntake();
    const flushing = watcher.flush(signal());
    let flushed = false;
    void flushing.then(() => {
      flushed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);
    releaseUnregister?.();

    await expect(unregistering).rejects.toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
    await expect(flushing).resolves.toBeUndefined();
    expect(adapter.activePaths()).toEqual([]);
  });

  it("discards old-revision intake after a durable manifest update finishes during shutdown", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    const first = await registry.register(projectRoot, "00000000-0000-4000-8000-000000000090");
    const adapter = new FakeWatchAdapter();
    let releaseRegister: (() => void) | undefined;
    let signalDurable: (() => void) | undefined;
    const durable = new Promise<void>((resolve) => {
      signalDurable = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      releaseRegister = resolve;
    });
    const watcher = createProjectWatcher({
      registry: {
        ...registry,
        register: async (root, operationId) => {
          const result = await registry.register(root, operationId);
          signalDurable?.();
          await delayed;
          return result;
        },
      },
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();
    await writeFile(path.join(projectRoot, "src", "old.ts"), "changed");
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "old.ts") });
    await writeFile(
      path.join(projectRoot, ".toss", "project.yaml"),
      [
        "schema_version: project-watch-manifest.v1",
        "watch_paths:",
        "  - src",
        "  - package.json",
        "ignore_paths:",
        "  - src/generated",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const registering = watcher.register(projectRoot, "00000000-0000-4000-8000-000000000091");
    await durable;
    watcher.stopIntake();
    const flushing = watcher.flush(signal());
    releaseRegister?.();

    await expect(registering).resolves.toMatchObject({
      project_id: first.project_id,
      registry_revision: 2,
      state: "ACTIVE",
    });
    await expect(flushing).resolves.toBeUndefined();
    expect(await intake.listCandidates()).toEqual([]);
    expect(await readdir(path.join(statePath, "projects", "pending"))).toEqual([]);
    expect(adapter.activePaths()).toEqual([]);
  });

  it("discards pending intake after a durable unregister finishes during shutdown", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    const registered = await registry.register(projectRoot);
    const adapter = new FakeWatchAdapter();
    let releaseUnregister: (() => void) | undefined;
    let signalDurable: (() => void) | undefined;
    const durable = new Promise<void>((resolve) => {
      signalDurable = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      releaseUnregister = resolve;
    });
    const watcher = createProjectWatcher({
      registry: {
        ...registry,
        unregister: async (projectId, operationId) => {
          const result = await registry.unregister(projectId, operationId);
          signalDurable?.();
          await delayed;
          return result;
        },
      },
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();
    await writeFile(path.join(projectRoot, "src", "old.ts"), "changed");
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "old.ts") });

    const unregistering = watcher.unregister(
      registered.project_id,
      "00000000-0000-4000-8000-000000000090",
    );
    await durable;
    watcher.stopIntake();
    const flushing = watcher.flush(signal());
    releaseUnregister?.();

    await expect(unregistering).resolves.toMatchObject({ state: "UNREGISTERED" });
    await expect(flushing).resolves.toBeUndefined();
    expect(await registry.list()).toEqual([]);
    expect(await intake.listCandidates()).toEqual([]);
    expect(await readdir(path.join(statePath, "projects", "pending"))).toEqual([]);
    expect(adapter.activePaths()).toEqual([]);
  });

  it("keeps observing changes while a conflicting unregister is delayed", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    const operationId = "00000000-0000-4000-8000-000000000090";
    const registered = await registry.register(projectRoot, operationId);
    const adapter = new FakeWatchAdapter();
    let releaseUnregister: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      releaseUnregister = resolve;
    });
    const watcher = createProjectWatcher({
      registry: {
        ...registry,
        unregister: async () => {
          signalStarted?.();
          await delayed;
          throw new RuntimeProjectError("RUNTIME_OPERATION_CONFLICT");
        },
      },
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();

    const unregistering = watcher.unregister(registered.project_id, operationId);
    await started;
    await writeFile(path.join(projectRoot, "src", "old.ts"), "changed-during-conflict");
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "old.ts") });
    releaseUnregister?.();

    await expect(unregistering).rejects.toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
    await watcher.flush(signal());
    expect(await intake.listCandidates()).toHaveLength(1);
    expect(adapter.activePaths()).toEqual([path.join(projectRoot, "src")]);
  });

  it("keeps observing changes while an older unregister operation is replayed", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    const first = await registry.register(projectRoot, "00000000-0000-4000-8000-000000000090");
    const oldResult = await registry.unregister(
      first.project_id,
      "00000000-0000-4000-8000-000000000091",
    );
    await registry.register(projectRoot, "00000000-0000-4000-8000-000000000092");
    const adapter = new FakeWatchAdapter();
    let releaseUnregister: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      releaseUnregister = resolve;
    });
    const watcher = createProjectWatcher({
      registry: {
        ...registry,
        unregister: async (projectId, operationId) => {
          const result = await registry.unregister(projectId, operationId);
          signalStarted?.();
          await delayed;
          return result;
        },
      },
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();

    const unregistering = watcher.unregister(
      first.project_id,
      "00000000-0000-4000-8000-000000000091",
    );
    await started;
    await writeFile(path.join(projectRoot, "src", "old.ts"), "changed-during-replay");
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "old.ts") });
    releaseUnregister?.();

    await expect(unregistering).resolves.toEqual(oldResult);
    await watcher.flush(signal());
    expect(await intake.listCandidates()).toHaveLength(1);
    expect(adapter.activePaths()).toEqual([path.join(projectRoot, "src")]);
  });

  it("ignores unregistered, ignored, and runtime-owned changes", async () => {
    const { statePath, projectRoot, outsideRoot } = await fixture();
    const { registry, intake } = services(statePath);
    await registry.register(projectRoot);
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();

    await writeFile(path.join(outsideRoot, "outside.ts"), "changed");
    adapter.emit({ kind: "change", absolutePath: path.join(outsideRoot, "outside.ts") });
    await writeFile(path.join(projectRoot, "src", "generated", "ignored.ts"), "changed");
    adapter.emit({
      kind: "change",
      absolutePath: path.join(projectRoot, "src", "generated", "ignored.ts"),
    });
    adapter.emit({ kind: "change", absolutePath: path.join(statePath, "runtime-owned") });
    await watcher.flush(signal());

    expect(await intake.listCandidates()).toEqual([]);
  });

  it("coalesces rename, duplicate, and burst observations into one candidate", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    await registry.register(projectRoot);
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();

    await rename(path.join(projectRoot, "src", "old.ts"), path.join(projectRoot, "src", "new.ts"));
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "old.ts") });
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "new.ts") });
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "new.ts") });
    await watcher.flush(signal());

    const candidates = await intake.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.changes.map((change) => [change.kind, change.path])).toEqual([
      ["CREATED", "src/new.ts"],
      ["REMOVED", "src/old.ts"],
    ]);
  });

  it("bounds native duplicate bursts to one scan and one follow-up", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    await registry.register(projectRoot);
    const adapter = new FakeWatchAdapter();
    let scans = 0;
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
      scanScope: (scope) => {
        scans += 1;
        return scanDeclaredScope(scope);
      },
    });
    await watcher.recover();
    await writeFile(path.join(projectRoot, "src", "old.ts"), "changed");

    for (let index = 0; index < 1_000; index += 1) {
      adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "old.ts") });
    }
    await watcher.flush(signal());

    expect(scans).toBeLessThanOrEqual(3);
    expect(await intake.listCandidates()).toHaveLength(1);
  });

  it("partitions 4,097 distinct changes and advances the scan baseline", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    await registry.register(projectRoot);
    const adapter = new FakeWatchAdapter();
    let scanned: readonly ProjectChange[] = [];
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
      scanScope: () => scanned,
    });
    await watcher.recover();
    scanned = Object.freeze(
      Array.from({ length: 4_097 }, (_, index) =>
        Object.freeze({
          kind: "CHANGED" as const,
          path: `src/file-${index.toString().padStart(4, "0")}.ts`,
          identity: Object.freeze({
            device: "1",
            inode: String(index + 1),
            mtime_ns: "1",
            size: "1",
          }),
        }),
      ),
    );

    adapter.emit({ kind: "overflow" });
    await watcher.flush(signal());

    const candidates = await intake.listCandidates();
    expect(candidates.map((candidate) => candidate.changes.length)).toEqual([4_096, 1]);
    adapter.emit({ kind: "overflow" });
    await watcher.flush(signal());
    expect(await intake.listCandidates()).toHaveLength(2);
  });

  it("partitions a multi-megabyte long-path scan by exact document bytes", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    await registry.register(projectRoot);
    const adapter = new FakeWatchAdapter();
    let scanned: readonly ProjectChange[] = [];
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
      scanScope: () => scanned,
    });
    await watcher.recover();
    scanned = Object.freeze(
      Array.from({ length: 700 }, (_, index) =>
        Object.freeze({
          kind: "CHANGED" as const,
          path: `src/${index.toString().padStart(4, "0")}-${"a".repeat(3_500)}`,
          identity: Object.freeze({
            device: "1",
            inode: String(index + 1),
            mtime_ns: "1",
            size: "1",
          }),
        }),
      ),
    );

    adapter.emit({ kind: "overflow" });
    await watcher.flush(signal());

    const candidates = await intake.listCandidates();
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.reduce((total, candidate) => total + candidate.changes.length, 0)).toBe(700);
    for (const candidate of candidates) {
      expect(
        Buffer.byteLength(canonicalJson(candidate, PROJECT_CANDIDATE_JSON_LIMITS), "utf8") + 1,
      ).toBeLessThanOrEqual(2 * 1024 * 1024);
    }
  });

  it.each([
    {
      name: "delete then recreate",
      initial: true,
      intermediate: false,
      final: true,
      expected: { kind: "CHANGED", path: "src/transient.ts" },
    },
    {
      name: "create then delete",
      initial: false,
      intermediate: true,
      final: false,
      expected: null,
    },
  ] as const)("reduces a same-window $name transition coherently", async (scenario) => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    await registry.register(projectRoot);
    const adapter = new FakeWatchAdapter();
    const observed = (present: boolean, generation: number): readonly ProjectChange[] =>
      present
        ? [
            Object.freeze({
              kind: "CHANGED" as const,
              path: "src/transient.ts",
              identity: Object.freeze({
                device: "1",
                inode: "42",
                mtime_ns: String(generation),
                size: String(generation),
              }),
            }),
          ]
        : [];
    let scanned = observed(scenario.initial, 1);
    let signalFirstBatch: (() => void) | undefined;
    const firstBatch = new Promise<void>((resolve) => {
      signalFirstBatch = resolve;
    });
    let batches = 0;
    const watcher = createProjectWatcher({
      registry,
      intake: {
        ...intake,
        recordBatch: async (registration, changes) => {
          await intake.recordBatch(registration, changes);
          batches += 1;
          if (batches === 1) signalFirstBatch?.();
        },
      },
      runtimeStatePath: statePath,
      adapter,
      scanScope: () => scanned,
    });
    await watcher.recover();
    scanned = observed(scenario.intermediate, 2);
    adapter.emit({ kind: "overflow" });
    await firstBatch;
    scanned = observed(scenario.final, 3);
    adapter.emit({ kind: "overflow" });
    await watcher.flush(signal());

    const candidates = await intake.listCandidates();
    if (scenario.expected === null) {
      expect(candidates).toEqual([]);
    } else {
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.changes).toMatchObject([scenario.expected]);
    }
    expect(await readdir(path.join(statePath, "projects", "pending"))).toEqual([]);
  });

  it("rescans only the declared project scope on overflow", async () => {
    const { statePath, projectRoot, outsideRoot } = await fixture();
    const { registry, intake } = services(statePath);
    await registry.register(projectRoot);
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();

    await writeFile(path.join(projectRoot, "src", "new.ts"), "new", { mode: 0o600 });
    await writeFile(path.join(outsideRoot, "outside.ts"), "changed", { mode: 0o600 });
    adapter.emit({ kind: "overflow" });
    await watcher.flush(signal());

    expect((await intake.listCandidates())[0]?.changes.map((change) => change.path)).toEqual([
      "src/new.ts",
    ]);
  });

  it("emits removals when a declared watch path is deleted without blocking the project", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    const registered = await registry.register(projectRoot);
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();

    await rm(path.join(projectRoot, "src"), { recursive: true });
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src") });
    await watcher.flush(signal());

    expect(await registry.list()).toEqual([registered]);
    expect(
      (await intake.listCandidates())[0]?.changes.map((entry) => [entry.kind, entry.path]),
    ).toEqual([["REMOVED", "src/old.ts"]]);
    expect(adapter.activePaths()).toEqual([projectRoot]);

    await mkdir(path.join(projectRoot, "src"), { mode: 0o700 });
    await writeFile(path.join(projectRoot, "src", "new.ts"), "new", { mode: 0o600 });
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src") });
    await watcher.flush(signal());

    expect(
      (await intake.listCandidates())[1]?.changes.map((entry) => [entry.kind, entry.path]),
    ).toEqual([["CREATED", "src/new.ts"]]);
    expect(adapter.activePaths()).toEqual([path.join(projectRoot, "src")]);
  });

  it("recovers through an absent watch path and re-arms it when recreated", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    const registered = await registry.register(projectRoot);
    await rm(path.join(projectRoot, "src"), { recursive: true });
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
    });

    await watcher.recover();
    expect(await registry.list()).toEqual([registered]);
    expect(adapter.activePaths()).toEqual([projectRoot]);

    await mkdir(path.join(projectRoot, "src"), { mode: 0o700 });
    await writeFile(path.join(projectRoot, "src", "restored.ts"), "restored", { mode: 0o600 });
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src") });
    await watcher.flush(signal());

    expect((await intake.listCandidates())[0]?.changes).toMatchObject([
      { kind: "CREATED", path: "src/restored.ts" },
    ]);
    expect(adapter.activePaths()).toEqual([path.join(projectRoot, "src")]);
  });

  it.each(["moved root", "escaping symlink", "adapter error"] as const)(
    "blocks only the affected project for %s",
    async (failure) => {
      const { root, statePath, projectRoot, outsideRoot } = await fixture();
      const { registry, intake } = services(statePath);
      const registered = await registry.register(projectRoot);
      const adapter = new FakeWatchAdapter();
      const watcher = createProjectWatcher({
        registry,
        intake,
        runtimeStatePath: statePath,
        adapter,
      });
      await watcher.recover();

      if (failure === "moved root") {
        await rename(projectRoot, path.join(root, "moved-project"));
        adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "old.ts") });
      } else if (failure === "escaping symlink") {
        await symlink(outsideRoot, path.join(projectRoot, "src", "escape"), "dir");
        adapter.emit({ kind: "overflow" });
      } else {
        adapter.emit({ kind: "error" });
      }
      await watcher.flush(signal());

      expect(await registry.list()).toEqual([]);
      expect(await intake.listCandidates()).toEqual([]);
      const registryPath = path.join(statePath, "projects", "registry", "entries.jsonl");
      const last = JSON.parse(
        (await readFile(registryPath, "utf8")).trimEnd().split("\n").at(-1)!,
      ) as {
        readonly project_id: string;
        readonly state: string;
        readonly reason_code: string;
      };
      expect(last).toMatchObject({
        project_id: registered.project_id,
        state: "BLOCKED_PROJECT_UNAVAILABLE",
        reason_code: "PROJECT_ROOT_UNAVAILABLE",
      });
      expect(adapter.closed).toBeGreaterThan(0);
    },
  );

  it("discards a pending window after durably blocking its project", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    await registry.register(projectRoot);
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();
    await writeFile(path.join(projectRoot, "src", "old.ts"), "changed");

    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "old.ts") });
    adapter.emit({ kind: "error" });
    await watcher.flush(signal());

    expect(await registry.list()).toEqual([]);
    expect(await intake.listCandidates()).toEqual([]);
    expect(await readdir(path.join(statePath, "projects", "pending"))).toEqual([]);
  });

  it("stops native intake before flushing the final pending candidate", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    await registry.register(projectRoot);
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry,
      intake,
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();
    await writeFile(path.join(projectRoot, "src", "old.ts"), "changed");
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "old.ts") });

    watcher.stopIntake();
    adapter.emit({ kind: "overflow" });
    await watcher.flush(signal());

    expect(adapter.listeners.size).toBe(0);
    expect(await intake.listCandidates()).toHaveLength(1);
  });

  it("propagates intake corruption without misclassifying the project root", async () => {
    const { statePath, projectRoot } = await fixture();
    const { registry, intake } = services(statePath);
    await registry.register(projectRoot);
    const adapter = new FakeWatchAdapter();
    const watcher = createProjectWatcher({
      registry,
      intake: {
        ...intake,
        recordBatch: () =>
          Promise.reject(new RuntimeProjectError("RUNTIME_PROJECT_INTAKE_CORRUPT")),
      },
      runtimeStatePath: statePath,
      adapter,
    });
    await watcher.recover();
    await writeFile(path.join(projectRoot, "src", "old.ts"), "changed");
    adapter.emit({ kind: "change", absolutePath: path.join(projectRoot, "src", "old.ts") });

    await expect(watcher.flush(signal())).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_INTAKE_CORRUPT",
    });
    expect(await registry.list()).toHaveLength(1);
  });
});
