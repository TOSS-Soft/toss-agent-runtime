import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashProjectWatchManifest } from "../src/service/project/contracts.js";
import {
  classifyProjectChange,
  compileProjectScope,
  scanDeclaredScope,
} from "../src/service/project/paths.js";
import type { ProjectRegistration, ProjectWatchManifestV1 } from "../src/service/project/types.js";

const roots: string[] = [];

async function fixture(): Promise<{
  readonly root: string;
  readonly projectRoot: string;
  readonly outsideRoot: string;
}> {
  const temporary = await realpath("/tmp");
  const root = await mkdtemp(path.join(temporary, "toss-project-paths-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  const outsideRoot = path.join(root, "outside");
  await mkdir(path.join(projectRoot, "src", "generated"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(projectRoot, ".git"), { mode: 0o700 });
  await mkdir(path.join(projectRoot, ".toss", "runtime"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(projectRoot, "state"), { mode: 0o700 });
  await mkdir(outsideRoot, { mode: 0o700 });
  await Promise.all([
    writeFile(path.join(projectRoot, "src", "z.ts"), "z", { mode: 0o600 }),
    writeFile(path.join(projectRoot, "src", "a.ts"), "a", { mode: 0o600 }),
    writeFile(path.join(projectRoot, "src", "generated", "ignored.ts"), "ignored", {
      mode: 0o600,
    }),
    writeFile(path.join(projectRoot, "package.json"), "{}", { mode: 0o600 }),
    writeFile(path.join(projectRoot, ".git", "config"), "ignored", { mode: 0o600 }),
    writeFile(path.join(projectRoot, ".toss", "runtime", "generated"), "ignored", {
      mode: 0o600,
    }),
    writeFile(path.join(projectRoot, "state", "runtime-owned"), "ignored", { mode: 0o600 }),
    writeFile(path.join(outsideRoot, "outside.ts"), "outside", { mode: 0o600 }),
  ]);
  return { root, projectRoot, outsideRoot };
}

function manifest(): ProjectWatchManifestV1 {
  return {
    schema_version: "project-watch-manifest.v1",
    watch_paths: ["src", "package.json"],
    ignore_paths: ["src/generated"],
  };
}

function registration(projectRoot: string, value = manifest()): ProjectRegistration {
  return {
    project_id: "00000000-0000-4000-8000-000000000001",
    registry_revision: 1,
    canonical_root: projectRoot,
    manifest_hash: hashProjectWatchManifest(value),
    state: "ACTIVE",
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("project watch scope boundaries", () => {
  it("classifies only registered, watched, nonignored root-relative paths", async () => {
    const { projectRoot, outsideRoot } = await fixture();
    const value = manifest();
    const scope = compileProjectScope({
      registration: registration(projectRoot, value),
      manifest: value,
      runtimeStatePath: path.join(projectRoot, "state"),
    });

    expect(classifyProjectChange(scope, path.join(projectRoot, "src", "a.ts"))).toBe("src/a.ts");
    expect(classifyProjectChange(scope, path.join(projectRoot, "package.json"))).toBe(
      "package.json",
    );
    expect(
      classifyProjectChange(scope, path.join(projectRoot, "src", "generated", "ignored.ts")),
    ).toBeNull();
    expect(classifyProjectChange(scope, path.join(projectRoot, ".git", "config"))).toBeNull();
    expect(
      classifyProjectChange(scope, path.join(projectRoot, ".toss", "runtime", "generated")),
    ).toBeNull();
    expect(
      classifyProjectChange(scope, path.join(projectRoot, "state", "runtime-owned")),
    ).toBeNull();
    expect(classifyProjectChange(scope, path.join(outsideRoot, "outside.ts"))).toBeNull();
  });

  it("scans only real files in declared paths and returns bytewise order", async () => {
    const { projectRoot } = await fixture();
    await symlink(
      path.join(projectRoot, "src", "a.ts"),
      path.join(projectRoot, "src", "inside-link"),
    );
    const value = manifest();
    const scope = compileProjectScope({
      registration: registration(projectRoot, value),
      manifest: value,
      runtimeStatePath: path.join(projectRoot, "state"),
    });

    const changes = scanDeclaredScope(scope);

    expect(changes.map((change) => [change.kind, change.path])).toEqual([
      ["CHANGED", "package.json"],
      ["CHANGED", "src/a.ts"],
      ["CHANGED", "src/z.ts"],
    ]);
    expect(changes.every((change) => change.identity !== null)).toBe(true);
  });

  it("fails closed when a watched symlink escapes the canonical root", async () => {
    const { projectRoot, outsideRoot } = await fixture();
    await symlink(outsideRoot, path.join(projectRoot, "src", "escape"), "dir");
    const value = manifest();
    const scope = compileProjectScope({
      registration: registration(projectRoot, value),
      manifest: value,
      runtimeStatePath: path.join(projectRoot, "state"),
    });

    expect(() => scanDeclaredScope(scope)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_PROJECT_PATH_UNSAFE" }),
    );
  });

  it("fails closed when the canonical root is replaced after compilation", async () => {
    const { root, projectRoot } = await fixture();
    const value = manifest();
    const scope = compileProjectScope({
      registration: registration(projectRoot, value),
      manifest: value,
      runtimeStatePath: path.join(projectRoot, "state"),
    });
    await rename(projectRoot, path.join(root, "displaced-project"));
    await mkdir(projectRoot, { mode: 0o700 });

    expect(() => scanDeclaredScope(scope)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_PROJECT_PATH_UNSAFE" }),
    );
    expect(() => classifyProjectChange(scope, path.join(projectRoot, "src", "a.ts"))).toThrowError(
      expect.objectContaining({ code: "RUNTIME_PROJECT_PATH_UNSAFE" }),
    );
  });

  it("rejects a stale manifest hash and a symlink watch root", async () => {
    const { projectRoot, outsideRoot } = await fixture();
    const value = manifest();
    expect(() =>
      compileProjectScope({
        registration: {
          ...registration(projectRoot, value),
          manifest_hash: `sha256:${"f".repeat(64)}`,
        },
        manifest: value,
        runtimeStatePath: path.join(projectRoot, "state"),
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_PROJECT_INVALID" }));

    await symlink(outsideRoot, path.join(projectRoot, "linked-watch"), "dir");
    const linkedManifest: ProjectWatchManifestV1 = {
      schema_version: "project-watch-manifest.v1",
      watch_paths: ["linked-watch"],
      ignore_paths: [],
    };
    expect(() =>
      compileProjectScope({
        registration: registration(projectRoot, linkedManifest),
        manifest: linkedManifest,
        runtimeStatePath: path.join(projectRoot, "state"),
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_PROJECT_PATH_UNSAFE" }));
  });

  it("rejects manifest collections that bypass the closed parser limits", async () => {
    const { projectRoot } = await fixture();
    const duplicate: ProjectWatchManifestV1 = {
      schema_version: "project-watch-manifest.v1",
      watch_paths: ["src", "src"],
      ignore_paths: [],
    };
    expect(() =>
      compileProjectScope({
        registration: registration(projectRoot, duplicate),
        manifest: duplicate,
        runtimeStatePath: path.join(projectRoot, "state"),
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_PROJECT_INVALID" }));

    const excessive: ProjectWatchManifestV1 = {
      schema_version: "project-watch-manifest.v1",
      watch_paths: Array.from({ length: 257 }, (_, index) => `src/path-${index}`),
      ignore_paths: [],
    };
    expect(() =>
      compileProjectScope({
        registration: registration(projectRoot, excessive),
        manifest: excessive,
        runtimeStatePath: path.join(projectRoot, "state"),
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_PROJECT_INVALID" }));
  });

  it("preserves safe Unicode paths and rejects noncanonical event paths", async () => {
    const { projectRoot } = await fixture();
    await mkdir(path.join(projectRoot, "src", "İş"), { mode: 0o700 });
    await writeFile(path.join(projectRoot, "src", "İş", "ö.ts"), "unicode", { mode: 0o600 });
    const value = manifest();
    const scope = compileProjectScope({
      registration: registration(projectRoot, value),
      manifest: value,
      runtimeStatePath: path.join(projectRoot, "state"),
    });

    expect(classifyProjectChange(scope, path.join(projectRoot, "src", "İş", "ö.ts"))).toBe(
      "src/İş/ö.ts",
    );
    expect(classifyProjectChange(scope, `${projectRoot}/src/../src/a.ts`)).toBeNull();
    expect(classifyProjectChange(scope, path.join(projectRoot, "src", "bad\\name.ts"))).toBeNull();
  });
});
