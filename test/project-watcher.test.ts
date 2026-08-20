import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProjectIntake } from "../src/service/project/intake.js";
import { RuntimeProjectError } from "../src/service/project/errors.js";
import { createProjectRegistry } from "../src/service/project/registry.js";
import {
  createProjectWatcher,
  type ProjectWatchAdapter,
  type ProjectWatchAdapterEvent,
  type ProjectWatchSubscription,
} from "../src/service/project/watcher.js";

const roots: string[] = [];

class FakeWatchAdapter implements ProjectWatchAdapter {
  readonly listeners = new Set<(event: ProjectWatchAdapterEvent) => void>();
  closed = 0;

  watch(
    _absolutePath: string,
    _recursive: boolean,
    listener: (event: ProjectWatchAdapterEvent) => void,
  ): ProjectWatchSubscription {
    this.listeners.add(listener);
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        this.closed += 1;
        this.listeners.delete(listener);
      },
    };
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
        record: () => Promise.reject(new RuntimeProjectError("RUNTIME_PROJECT_INTAKE_CORRUPT")),
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
