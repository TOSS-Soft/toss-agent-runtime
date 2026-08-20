import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../src/protocol/json.js";
import { hashProjectRegistryEntry } from "../src/service/project/contracts.js";
import {
  createProjectRegistry,
  type CreateProjectRegistryOptions,
  type ProjectRegistry,
} from "../src/service/project/registry.js";
import type {
  HashableProjectRegistryEntryV1,
  ProjectRegistration,
} from "../src/service/project/types.js";

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

  it("caps active registrations at the bounded project-list response limit", async () => {
    const { root, statePath } = await fixture();
    const projects = registry(statePath);
    const projectRoots: string[] = [];
    for (let index = 1; index <= 13; index += 1) {
      const projectRoot = path.join(root, `bounded-project-${index}`);
      await mkdir(path.join(projectRoot, ".toss"), { recursive: true, mode: 0o700 });
      await mkdir(path.join(projectRoot, "src"), { mode: 0o700 });
      await writeManifest(projectRoot, ["src"]);
      projectRoots.push(projectRoot);
    }

    for (const projectRoot of projectRoots.slice(0, 12)) {
      await expect(projects.register(projectRoot)).resolves.toMatchObject({ state: "ACTIVE" });
    }
    await expect(projects.register(projectRoots[12]!)).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
    });

    expect(await projects.list()).toHaveLength(12);
    expect(
      (await readFile(path.join(statePath, "projects", "registry", "entries.jsonl"), "utf8"))
        .trimEnd()
        .split("\n"),
    ).toHaveLength(12);
  });

  it("durably replays state-changing operation ids and rejects conflicting reuse", async () => {
    const { statePath, projectRoot } = await fixture();
    const registerOperation = "00000000-0000-4000-8000-000000000090";
    const unregisterOperation = "00000000-0000-4000-8000-000000000091";
    const first = registry(statePath);

    const registered = await first.register(projectRoot, registerOperation);
    const unregistered = await first.unregister(registered.project_id, unregisterOperation);
    const restarted = registry(statePath);

    await expect(restarted.unregister(registered.project_id, unregisterOperation)).resolves.toEqual(
      unregistered,
    );
    await expect(
      restarted.unregister(registered.project_id, registerOperation),
    ).rejects.toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
    expect(
      (await readFile(path.join(statePath, "projects", "registry", "entries.jsonl"), "utf8"))
        .trimEnd()
        .split("\n"),
    ).toHaveLength(2);
  });

  it("accepts generic UUID versions and canonicalizes their durable identity", async () => {
    const { statePath, projectRoot } = await fixture();
    const projectId = "018F0B7A-5F2D-7ABC-8DEF-0123456789AB";
    const registerOperation = "018F0B7A-5F2D-7ABC-8DEF-0123456789AC";
    const unregisterOperation = "018f0b7a-5f2d-7abc-8def-0123456789ad";
    const projects = registry(statePath, { randomId: () => projectId });

    const registered = await projects.register(projectRoot, registerOperation);
    expect(registered.project_id).toBe(projectId.toLowerCase());
    await expect(
      registry(statePath).register(projectRoot, registerOperation.toLowerCase()),
    ).resolves.toEqual(registered);
    await expect(
      registry(statePath).unregister(projectId, unregisterOperation),
    ).resolves.toMatchObject({ state: "UNREGISTERED" });
    const entries = (
      await readFile(path.join(statePath, "projects", "registry", "entries.jsonl"), "utf8")
    )
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { operation_id: string; project_id: string });
    expect(entries).toMatchObject([
      {
        operation_id: registerOperation.toLowerCase(),
        project_id: projectId.toLowerCase(),
      },
      {
        operation_id: unregisterOperation,
        project_id: projectId.toLowerCase(),
      },
    ]);
  });

  it("persists a new operation id for an exact active registration", async () => {
    const { statePath, projectRoot } = await fixture();
    const firstOperation = "00000000-0000-4000-8000-000000000090";
    const confirmationOperation = "00000000-0000-4000-8000-000000000091";
    const first = registry(statePath);
    const registered = await first.register(projectRoot, firstOperation);

    const confirmed = await first.register(projectRoot, confirmationOperation);
    const restarted = registry(statePath);

    expect(confirmed).toEqual(registered);
    await expect(restarted.register(projectRoot, confirmationOperation)).resolves.toEqual(
      confirmed,
    );
    await expect(
      restarted.unregister(registered.project_id, confirmationOperation),
    ).rejects.toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
    expect(
      (await readFile(path.join(statePath, "projects", "registry", "entries.jsonl"), "utf8"))
        .trimEnd()
        .split("\n"),
    ).toHaveLength(1);
    expect(
      (await readFile(path.join(statePath, "projects", "registry", "operations.jsonl"), "utf8"))
        .trimEnd()
        .split("\n"),
    ).toHaveLength(1);
  });

  it("recovers near-bound registry and operation histories with linear validation", async () => {
    const { statePath, projectRoot } = await fixture();
    await registry(statePath).register(projectRoot);
    const registryDirectory = path.join(statePath, "projects", "registry");
    const longRoot = `/tmp/${"a".repeat(4_000)}`;
    const projectId = "018f0b7a-5f2d-7abc-8def-0123456789ab";
    const manifestHash = `sha256:${"a".repeat(64)}` as const;
    const registerHash = sha256({ command: "project-register", root: longRoot });
    const unregisterHash = sha256({
      command: "project-unregister",
      project_id: projectId,
    });
    const entryLines: string[] = [];
    let previousEntryHash = `sha256:${"0".repeat(64)}` as const;
    let firstResult: ProjectRegistration | undefined;
    for (let revision = 1; revision <= 3_000; revision += 1) {
      const active = revision % 2 === 1;
      const hashable: HashableProjectRegistryEntryV1 = {
        protocol_version: "runtime-contract.v1",
        schema_version: "project-registry-entry.v1",
        document_type: "project-registry-entry",
        registry_revision: revision,
        previous_entry_hash: previousEntryHash,
        operation_id: `10000000-0000-7000-8000-${revision.toString(16).padStart(12, "0")}`,
        operation_hash: active ? registerHash : unregisterHash,
        project_id: projectId,
        canonical_root: longRoot,
        manifest_hash: manifestHash,
        state: active ? "ACTIVE" : "UNREGISTERED",
        reason_code: active ? "PROJECT_REGISTERED" : "PROJECT_UNREGISTERED",
        timestamp: "2026-08-20T12:00:00.000Z",
      };
      const entry = { ...hashable, entry_hash: hashProjectRegistryEntry(hashable) } as const;
      previousEntryHash = entry.entry_hash;
      entryLines.push(`${canonicalJson(entry)}\n`);
      firstResult ??= {
        project_id: projectId,
        registry_revision: revision,
        canonical_root: longRoot,
        manifest_hash: manifestHash,
        state: "ACTIVE",
      };
    }
    if (firstResult === undefined) throw new Error("expected a registry result fixture");
    const operationLines: string[] = [];
    let previousOperationHash = `sha256:${"0".repeat(64)}` as const;
    for (let revision = 1; revision <= 3_000; revision += 1) {
      const hashable = {
        schema_version: "project-registry-operation.v1",
        document_type: "project-registry-operation",
        operation_revision: revision,
        previous_operation_hash: previousOperationHash,
        operation_id: `20000000-0000-7000-8000-${revision.toString(16).padStart(12, "0")}`,
        operation_hash: registerHash,
        result: firstResult,
      } as const;
      const record = { ...hashable, operation_record_hash: sha256(hashable) } as const;
      previousOperationHash = record.operation_record_hash;
      operationLines.push(`${canonicalJson(record)}\n`);
    }
    const entryBytes = Buffer.from(entryLines.join(""), "utf8");
    const operationBytes = Buffer.from(operationLines.join(""), "utf8");
    expect(entryBytes.byteLength).toBeGreaterThan(12 * 1024 * 1024);
    expect(operationBytes.byteLength).toBeGreaterThan(12 * 1024 * 1024);
    expect(entryBytes.byteLength).toBeLessThan(16 * 1024 * 1024);
    expect(operationBytes.byteLength).toBeLessThan(16 * 1024 * 1024);
    await writeFile(path.join(registryDirectory, "entries.jsonl"), entryBytes, { mode: 0o600 });
    await writeFile(path.join(registryDirectory, "operations.jsonl"), operationBytes, {
      mode: 0o600,
    });

    await expect(registry(statePath).recover()).resolves.toBeUndefined();
  });

  it("replays a completed registration without reopening an unavailable root", async () => {
    const { statePath, projectRoot } = await fixture();
    const operationId = "00000000-0000-4000-8000-000000000092";
    const first = registry(statePath);
    const registered = await first.register(projectRoot, operationId);
    await rm(projectRoot, { recursive: true });

    await expect(registry(statePath).register(projectRoot, operationId)).resolves.toEqual(
      registered,
    );
  });

  it("preserves stable identity across a blocked root and explicit re-registration", async () => {
    const { statePath, projectRoot } = await fixture();
    const projects = registry(statePath);
    const first = await projects.register(projectRoot);

    const blocked = await projects.blockUnavailable(first.project_id);
    expect(blocked).toMatchObject({
      project_id: first.project_id,
      registry_revision: 2,
      state: "BLOCKED_PROJECT_UNAVAILABLE",
    });
    expect(await projects.list()).toEqual([]);
    const reactivated = await projects.register(projectRoot);
    expect(reactivated).toMatchObject({
      project_id: first.project_id,
      registry_revision: 3,
      state: "ACTIVE",
    });
    const entries = (
      await readFile(path.join(statePath, "projects", "registry", "entries.jsonl"), "utf8")
    )
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly reason_code: string });
    expect(entries.map((entry) => entry.reason_code)).toEqual([
      "PROJECT_REGISTERED",
      "PROJECT_ROOT_UNAVAILABLE",
      "PROJECT_REGISTERED",
    ]);
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

  it("retries the registry directory barrier after initial publication sync fails", async () => {
    const { statePath, projectRoot } = await fixture();
    const registryPath = path.join(statePath, "projects", "registry", "entries.jsonl");
    let failed = false;
    const projects = registry(statePath, {
      operationHooks: {
        beforeDirectorySync: (directoryPath) => {
          if (path.basename(directoryPath) !== "registry" || !existsSync(registryPath) || failed) {
            return;
          }
          failed = true;
          throw new Error("simulated registry directory sync failure");
        },
      },
    });
    const operationId = "00000000-0000-4000-8000-000000000090";

    await expect(projects.register(projectRoot, operationId)).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
    });
    expect(existsSync(registryPath)).toBe(true);
    await expect(projects.register(projectRoot, operationId)).resolves.toMatchObject({
      registry_revision: 1,
      state: "ACTIVE",
    });
    expect(failed).toBe(true);
  });

  it("retries the registry directory barrier after recovery rename sync fails", async () => {
    const { statePath, projectRoot } = await fixture();
    await registry(statePath).register(projectRoot);
    const registryPath = path.join(statePath, "projects", "registry", "entries.jsonl");
    await appendFile(registryPath, '{"partial":');
    let failed = false;
    const recovered = registry(statePath, {
      operationHooks: {
        beforeDirectorySync: (directoryPath) => {
          if (
            path.basename(directoryPath) !== "registry" ||
            failed ||
            !readFileSync(registryPath).subarray(-1).equals(Buffer.from("\n"))
          ) {
            return;
          }
          failed = true;
          throw new Error("simulated recovery directory sync failure");
        },
      },
    });

    await expect(recovered.recover()).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
    });
    await expect(recovered.recover()).resolves.toBeUndefined();
    expect(failed).toBe(true);
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

  it("rejects an oversized registry before allocating its contents", async () => {
    const { statePath, projectRoot } = await fixture();
    await registry(statePath).register(projectRoot);
    const registryPath = path.join(statePath, "projects", "registry", "entries.jsonl");
    await truncate(registryPath, 16 * 1024 * 1024 + 1);

    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
    });
  });

  it("rejects an entry whose operation hash does not match its state command", async () => {
    const { statePath, projectRoot } = await fixture();
    await registry(statePath).register(projectRoot, "00000000-0000-4000-8000-000000000090");
    const registryPath = path.join(statePath, "projects", "registry", "entries.jsonl");
    const stored = JSON.parse((await readFile(registryPath, "utf8")).trim()) as Record<
      string,
      unknown
    >;
    const hashable = {
      ...stored,
      operation_hash: `sha256:${"9".repeat(64)}`,
    };
    Reflect.deleteProperty(hashable, "entry_hash");
    const replaced = { ...hashable, entry_hash: hashProjectRegistryEntry(hashable as never) };
    await writeFile(registryPath, `${canonicalJson(replaced)}\n`, { mode: 0o600 });

    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_REGISTRY_CORRUPT",
    });
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
      operation_id: "00000000-0000-4000-8000-000000000099",
      operation_hash: `sha256:${"9".repeat(64)}`,
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

  it("rejects a project root reached through an intermediate symlink", async () => {
    const { root, statePath, projectRoot } = await fixture();
    const realParent = path.join(root, "real-parent");
    const linkedParent = path.join(root, "linked-parent");
    await mkdir(realParent, { mode: 0o700 });
    await rename(projectRoot, path.join(realParent, "project"));
    await symlink(realParent, linkedParent, "dir");

    await expect(
      registry(statePath).register(path.join(linkedParent, "project")),
    ).rejects.toMatchObject({ code: "RUNTIME_PROJECT_PATH_UNSAFE" });
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
