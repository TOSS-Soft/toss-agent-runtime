import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../src/protocol/json.js";
import { hashProjectRegistryEntry } from "../src/service/project/contracts.js";
import {
  createProjectRegistry,
  type CreateProjectRegistryOptions,
  type ProjectRegistry,
} from "../src/service/project/registry.js";

const roots: string[] = [];

async function fixture(): Promise<{
  readonly root: string;
  readonly statePath: string;
  readonly projectRoot: string;
}> {
  const temporary = await realpath("/tmp");
  const root = await mkdtemp(path.join(temporary, "toss-project-registry-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  await mkdir(path.join(projectRoot, ".toss"), { recursive: true, mode: 0o700 });
  await writeManifest(projectRoot, ["src"]);
  await mkdir(path.join(projectRoot, "src"), { mode: 0o700 });
  return { root, statePath: path.join(root, "state"), projectRoot };
}

async function writeManifest(projectRoot: string, watchPaths: readonly string[]): Promise<void> {
  await writeFile(
    path.join(projectRoot, ".toss", "project.yaml"),
    [
      "schema_version: project-watch-manifest.v1",
      "watch_paths:",
      ...watchPaths.map((candidate) => `  - ${candidate}`),
      "ignore_paths:",
      "  - dist",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function registry(
  statePath: string,
  overrides: Partial<CreateProjectRegistryOptions> = {},
): ProjectRegistry {
  let id = 0;
  let tick = 0;
  return createProjectRegistry({
    statePath,
    now: () => new Date(Date.UTC(2026, 7, 20, 12, 0, tick++)),
    randomId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    ...overrides,
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("private append-only project registry", () => {
  it("replays exact registration, revisions changed manifests, and appends a tombstone", async () => {
    const { statePath, projectRoot } = await fixture();
    const projects = registry(statePath);

    const first = await projects.register(projectRoot);
    const registryPath = path.join(statePath, "projects", "registry", "entries.jsonl");
    const firstBytes = await readFile(registryPath);
    const replay = await projects.register(projectRoot);
    await writeManifest(projectRoot, ["src", "package.json"]);
    const updatedManifestBytes = await readFile(path.join(projectRoot, ".toss", "project.yaml"));
    const updated = await projects.register(projectRoot);
    const unregistered = await projects.unregister(first.project_id);

    expect(first).toMatchObject({
      project_id: "00000000-0000-4000-8000-000000000001",
      registry_revision: 1,
      canonical_root: projectRoot,
      state: "ACTIVE",
    });
    expect(replay).toEqual(first);
    expect((await readFile(registryPath)).subarray(0, firstBytes.length)).toEqual(firstBytes);
    expect(updated).toMatchObject({
      project_id: first.project_id,
      registry_revision: 2,
      state: "ACTIVE",
    });
    expect(updated.manifest_hash).not.toBe(first.manifest_hash);
    expect(unregistered).toMatchObject({
      project_id: first.project_id,
      registry_revision: 3,
      state: "UNREGISTERED",
    });
    expect(await projects.list()).toEqual([]);
    expect((await readFile(registryPath, "utf8")).trimEnd().split("\n")).toHaveLength(3);
    expect(await readFile(path.join(projectRoot, ".toss", "project.yaml"))).toEqual(
      updatedManifestBytes,
    );
    expect((await lstat(path.dirname(registryPath))).mode & 0o777).toBe(0o700);
    expect((await lstat(registryPath)).mode & 0o777).toBe(0o600);
  });

  it("serializes exact registration across public registry instances", async () => {
    const { statePath, projectRoot } = await fixture();
    const first = registry(statePath, {
      randomId: () => "00000000-0000-4000-8000-000000000010",
    });
    const second = registry(statePath, {
      randomId: () => "00000000-0000-4000-8000-000000000020",
    });

    const registrations = await Promise.all([
      first.register(projectRoot),
      second.register(projectRoot),
    ]);

    expect(registrations[0]).toEqual(registrations[1]);
    const registryPath = path.join(statePath, "projects", "registry", "entries.jsonl");
    expect((await readFile(registryPath, "utf8")).trimEnd().split("\n")).toHaveLength(1);
  });

  it("recovers only a partial final record and quarantines its exact bytes", async () => {
    const { statePath, projectRoot } = await fixture();
    const first = registry(statePath);
    await first.register(projectRoot);
    const registryPath = path.join(statePath, "projects", "registry", "entries.jsonl");
    const prefix = await readFile(registryPath);
    const fragment = Buffer.from('{"partial":', "utf8");
    await appendFile(registryPath, fragment);

    const recovered = registry(statePath);
    await recovered.recover();

    expect(await readFile(registryPath)).toEqual(prefix);
    expect(await recovered.list()).toHaveLength(1);
    const quarantinePath = path.join(statePath, "projects", "quarantine");
    const artifacts = await readdir(quarantinePath);
    expect(artifacts).toHaveLength(1);
    expect(await readFile(path.join(quarantinePath, artifacts[0]!))).toEqual(fragment);
  });

  it("preserves and rejects invalid complete registry content", async () => {
    const { statePath, projectRoot } = await fixture();
    const first = registry(statePath);
    await first.register(projectRoot);
    const registryPath = path.join(statePath, "projects", "registry", "entries.jsonl");
    await appendFile(registryPath, '{"invalid":true}\n');
    const corrupted = await readFile(registryPath);

    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_REGISTRY_CORRUPT",
    });
    expect(await readFile(registryPath)).toEqual(corrupted);
  });

  it("rejects a validly hashed history that moves a stable project ID to another root", async () => {
    const { root, statePath, projectRoot } = await fixture();
    const projects = registry(statePath);
    const registered = await projects.register(projectRoot);
    await projects.unregister(registered.project_id);
    const registryPath = path.join(statePath, "projects", "registry", "entries.jsonl");
    const lines = (await readFile(registryPath, "utf8")).trimEnd().split("\n");
    const previous = JSON.parse(lines[1]!) as { readonly entry_hash: `sha256:${string}` };
    const hashable = {
      protocol_version: "runtime-contract.v1",
      schema_version: "project-registry-entry.v1",
      document_type: "project-registry-entry",
      registry_revision: 3,
      previous_entry_hash: previous.entry_hash,
      project_id: registered.project_id,
      canonical_root: path.join(root, "different-project"),
      manifest_hash: registered.manifest_hash,
      state: "ACTIVE",
      reason_code: "PROJECT_REGISTERED",
      timestamp: "2026-08-20T12:00:03.000Z",
    } as const;
    const moved = { ...hashable, entry_hash: hashProjectRegistryEntry(hashable) };
    await appendFile(registryPath, `${canonicalJson(moved)}\n`);

    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_REGISTRY_CORRUPT",
    });
  });

  it("rejects a partial first record without rewriting or quarantining it", async () => {
    const { statePath, projectRoot } = await fixture();
    const first = registry(statePath);
    await first.register(projectRoot);
    const registryPath = path.join(statePath, "projects", "registry", "entries.jsonl");
    const partial = Buffer.from('{"partial":', "utf8");
    await writeFile(registryPath, partial, { mode: 0o600 });

    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_REGISTRY_CORRUPT",
    });
    expect(await readFile(registryPath)).toEqual(partial);
    expect(await readdir(path.join(statePath, "projects", "quarantine"))).toEqual([]);
  });

  it("rejects missing, relative, final-symlink, and manifest-less roots", async () => {
    const { root, statePath, projectRoot } = await fixture();
    const linkedRoot = path.join(root, "linked-project");
    await symlink(projectRoot, linkedRoot, "dir");
    const withoutManifest = path.join(root, "without-manifest");
    await mkdir(withoutManifest, { mode: 0o700 });
    const projects = registry(statePath);

    await expect(projects.register("relative/project")).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_PATH_UNSAFE",
    });
    await expect(projects.register(path.join(root, "missing"))).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
    });
    await expect(projects.register(linkedRoot)).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_PATH_UNSAFE",
    });
    await expect(projects.register(withoutManifest)).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_INVALID",
    });
  });

  it("rejects a project root replaced before its manifest is read", async () => {
    const { root, statePath, projectRoot } = await fixture();
    const displacedRoot = path.join(root, "displaced-project");
    const projects = registry(statePath, {
      operationHooks: {
        beforeManifestRead: () => {
          renameSync(projectRoot, displacedRoot);
          mkdirSync(path.join(projectRoot, ".toss"), { recursive: true, mode: 0o700 });
          writeFileSync(
            path.join(projectRoot, ".toss", "project.yaml"),
            "schema_version: project-watch-manifest.v1\nwatch_paths: [src]\n",
            { mode: 0o600 },
          );
        },
      },
    });

    await expect(projects.register(projectRoot)).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_PATH_UNSAFE",
    });
    expect(await readFile(path.join(displacedRoot, ".toss", "project.yaml"), "utf8")).toContain(
      "ignore_paths",
    );
    await expect(
      lstat(path.join(statePath, "projects", "registry", "entries.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unregistering an unknown project", async () => {
    const { statePath } = await fixture();
    await expect(
      registry(statePath).unregister("00000000-0000-4000-8000-000000000099"),
    ).rejects.toMatchObject({ code: "RUNTIME_PROJECT_NOT_FOUND" });
  });
});
