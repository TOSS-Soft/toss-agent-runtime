import { createHash } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import {
  chmod,
  link,
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
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../src/protocol/json.js";
import {
  createSkillCatalogForTest,
  type SkillCatalog,
  type SkillPackageManifest,
  type SkillSelection,
} from "../src/skills/catalog.js";
import type { BundledCatalogTestOverride } from "../src/skills/bundled.js";
import { RuntimeSkillError } from "../src/skills/errors.js";
import { createSkillLoaderForTest, type SkillLoaderTestHooks } from "../src/skills/loader.js";
import type { SkillPrivateStoreOperationHooks } from "../src/skills/private-store.js";
import { SKILL_LIMITS, type SkillResourceV1 } from "../src/skills/types.js";

const temporaryDirectories: string[] = [];

function rawHash(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function packageManifest(
  name: string,
  skillMarkdown: Uint8Array,
  resources: readonly (SkillResourceV1 & { readonly content: Uint8Array })[],
): SkillPackageManifest {
  const declarations = resources
    .map((entry) => ({
      path: entry.path,
      role: entry.role,
      phases: entry.phases,
      priority: entry.priority,
      media_type: entry.media_type,
      bytes: entry.bytes,
      hash: entry.hash,
    }))
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const intrinsic = {
    name,
    description: `TOSS ${name} workflow guidance.`,
    version: "1.0.0",
    required_runtime_capabilities: [name],
    skill_markdown: {
      path: "SKILL.md" as const,
      media_type: "text/markdown" as const,
      bytes: skillMarkdown.byteLength,
      hash: rawHash(skillMarkdown),
    },
    resources: declarations,
  };
  const totalBytes =
    skillMarkdown.byteLength + declarations.reduce((total, entry) => total + entry.bytes, 0);
  const package_hash = sha256({
    name: intrinsic.name,
    description: intrinsic.description,
    version: intrinsic.version,
    required_runtime_capabilities: intrinsic.required_runtime_capabilities,
    skill_markdown_bytes: intrinsic.skill_markdown.bytes,
    skill_markdown_hash: intrinsic.skill_markdown.hash,
    resources: declarations,
  });
  return {
    ...intrinsic,
    resource_count: declarations.length,
    total_bytes: totalBytes,
    package_hash,
  };
}

async function privateTemporaryDirectory(prefix: string): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), prefix));
  const resolved = await realpath(created);
  await chmod(resolved, 0o700);
  temporaryDirectories.push(resolved);
  return resolved;
}

async function writePackage(
  root: string,
  name: string,
  skillMarkdown: Uint8Array,
  resources: readonly (SkillResourceV1 & { readonly content: Uint8Array })[],
): Promise<{ readonly directory: string; readonly manifest: SkillPackageManifest }> {
  const directory = path.join(root, name);
  const manifest = packageManifest(name, skillMarkdown, resources);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(directory, "skill.json"), canonicalJson(manifest), { mode: 0o600 });
  await writeFile(path.join(directory, "SKILL.md"), skillMarkdown, { mode: 0o600 });
  for (const resource of resources) {
    let parent = directory;
    for (const component of resource.path.split("/").slice(0, -1)) {
      parent = path.join(parent, component);
      await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      await chmod(parent, 0o700);
    }
    await writeFile(path.join(directory, resource.path), resource.content, { mode: 0o600 });
  }
  return { directory, manifest };
}

function resource(
  resourcePath: string,
  role: SkillResourceV1["role"],
  mediaType: string,
  content: Uint8Array,
): SkillResourceV1 & { readonly content: Uint8Array } {
  return {
    path: resourcePath,
    role,
    phases: role === "reference" ? ["GREEN"] : [],
    priority: null,
    media_type: mediaType,
    bytes: content.byteLength,
    hash: rawHash(content),
    content,
  };
}

function ids(): () => string {
  let next = 0;
  return () => `75000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}

async function fixture(
  options: {
    readonly skillMarkdown?: Uint8Array;
    readonly resources?: readonly (SkillResourceV1 & { readonly content: Uint8Array })[];
    readonly hooks?: SkillLoaderTestHooks;
    readonly privateStoreOperationHooks?: SkillPrivateStoreOperationHooks;
    readonly isProcessAlive?: (pid: number) => "alive" | "dead" | "unknown";
  } = {},
): Promise<{
  readonly root: string;
  readonly statePath: string;
  readonly directory: string;
  readonly catalog: SkillCatalog;
  readonly selection: SkillSelection;
  readonly loader: ReturnType<typeof createSkillLoaderForTest>;
}> {
  const root = await privateTemporaryDirectory("toss-skill-source-");
  const statePath = await privateTemporaryDirectory("toss-skill-state-");
  const skillMarkdown = options.skillMarkdown ?? Buffer.from("# Testing\n", "utf8");
  const resources = options.resources ?? [
    resource("references/guide.md", "reference", "text/markdown", Buffer.from("guide\n", "utf8")),
  ];
  const written = await writePackage(root, "testing", skillMarkdown, resources);
  const catalog = createSkillCatalogForTest({
    configuredRoots: [root],
    includeBundled: false,
  });
  const snapshot = await catalog.discover({ query: null, allowed_capabilities: ["testing"] });
  const descriptor = snapshot.descriptors[0]!;
  const selection = catalog.select(snapshot, {
    mode: "explicit",
    capability: "testing",
    allowed_capabilities: ["testing"],
    query: null,
    descriptor: {
      name: descriptor.name,
      version: descriptor.version,
      source: descriptor.source,
      package_hash: descriptor.package_hash,
      document_hash: descriptor.document_hash,
    },
  });
  const loader = createSkillLoaderForTest({
    catalog,
    statePath,
    now: () => new Date("2026-08-30T12:00:00.000Z"),
    randomId: ids(),
    hasServiceListener: () => Promise.resolve("absent"),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.privateStoreOperationHooks === undefined
      ? {}
      : { privateStoreOperationHooks: options.privateStoreOperationHooks }),
    ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
  });
  return { root, statePath, directory: written.directory, catalog, selection, loader };
}

function expectSkillError(
  operation: Promise<unknown>,
  code: ConstructorParameters<typeof RuntimeSkillError>[0] = "RUNTIME_SKILL_INTEGRITY",
): Promise<void> {
  return expect(operation).rejects.toEqual(new RuntimeSkillError(code));
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("immutable skill loading", () => {
  it("exposes explicit startup recovery without forcing a source or object read", async () => {
    const loaded = await fixture();
    await expect(loaded.loader.recover()).resolves.toBeUndefined();
    expect(await readdir(path.join(loaded.statePath, "skills", "objects"))).toEqual([]);
  });

  it("loads SKILL.md and every declared role in bytewise path order and freezes the snapshot", async () => {
    const resources = [
      resource("scripts/check.mjs", "script", "text/javascript", Buffer.from("export {};\n")),
      resource("assets/pixel.bin", "asset", "application/octet-stream", Buffer.from([0, 255, 1])),
      resource("references/guide.md", "reference", "text/markdown", Buffer.from("guide\n")),
    ];
    const { loader, selection, statePath } = await fixture({ resources });

    const snapshot = await loader.load(selection);

    expect(snapshot.package_hash).toBe(selection.descriptor.package_hash);
    expect(snapshot.resources.map((entry) => entry.path)).toEqual([
      "assets/pixel.bin",
      "references/guide.md",
      "scripts/check.mjs",
    ]);
    expect(snapshot.resources[0]?.hash).toBe(rawHash(Buffer.from([0, 255, 1])));
    expectDeepFrozen(snapshot);
    const records = await readdir(path.join(statePath, "skills", "objects"));
    expect(records).toEqual([`${snapshot.package_hash}.json`]);
    const stored = JSON.parse(
      await readFile(path.join(statePath, "skills", "objects", records[0]!), "utf8"),
    ) as {
      readonly snapshot: unknown;
      readonly skill_markdown_base64: string;
      readonly resources: unknown;
    };
    expect(stored.snapshot).toEqual(snapshot);
    expect(Buffer.from(stored.skill_markdown_base64, "base64")).toEqual(
      Buffer.from("# Testing\n", "utf8"),
    );
    expect(stored.resources).toEqual([
      { path: "assets/pixel.bin", bytes_base64: Buffer.from([0, 255, 1]).toString("base64") },
      {
        path: "references/guide.md",
        bytes_base64: Buffer.from("guide\n").toString("base64"),
      },
      {
        path: "scripts/check.mjs",
        bytes_base64: Buffer.from("export {};\n").toString("base64"),
      },
    ]);
  });

  it("hashes scripts but never executes, imports, evaluates, or spawns them", async () => {
    const processes: string[] = [];
    const { loader, selection } = await fixture({
      resources: [
        resource(
          "scripts/attack.mjs",
          "script",
          "text/javascript",
          Buffer.from("process.exit(91);\n", "utf8"),
        ),
      ],
      hooks: { onProcess: (command) => processes.push(command) },
    });

    const snapshot = await loader.load(selection);
    expect(snapshot.resources.some((entry) => entry.role === "script")).toBe(true);
    expect(processes).toEqual([]);
  });

  it("assembles context only from the exact selected stored snapshot", async () => {
    const first = await fixture();
    const second = await fixture();
    const snapshot = await first.loader.load(first.selection);
    const otherSnapshot = await second.loader.load(second.selection);
    const request = {
      snapshot,
      snapshot_hash: snapshot.document_hash,
      phase: "GREEN" as const,
      max_bytes: 1024,
      max_tokens: 256,
    };

    await expect(first.loader.assembleContext(first.selection, request)).resolves.toMatchObject({
      snapshot: { snapshot_hash: snapshot.document_hash },
      segments: [{ path: "SKILL.md" }, { path: "references/guide.md" }],
    });
    await expect(
      first.loader.assembleContext(first.selection, {
        ...request,
        snapshot: otherSnapshot,
        snapshot_hash: otherSnapshot.document_hash,
      }),
    ).rejects.toEqual(new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY"));
  });

  it.each(["deleted", "altered", "mode", "extra"] as const)(
    "fails closed on a cached load when the exact selected source is %s",
    async (kind) => {
      const { loader, selection, directory } = await fixture();
      await loader.load(selection);
      const member = path.join(directory, "references", "guide.md");
      if (kind === "deleted") await rm(directory, { recursive: true });
      if (kind === "altered") await writeFile(member, Buffer.from("xxxxx\n"), { mode: 0o600 });
      if (kind === "mode") await chmod(member, 0o640);
      if (kind === "extra") {
        await writeFile(path.join(directory, "extra.txt"), "x", { mode: 0o600 });
      }

      await expectSkillError(loader.load(selection));
    },
  );

  it.each(["handle", "descriptor", "catalog", "unknown"] as const)(
    "rejects a forged, rebound, stale, or %s selection without reopening a caller path",
    async (kind) => {
      const first = await fixture();
      let selection: SkillSelection;
      let loader = first.loader;
      if (kind === "unknown") {
        const second = await fixture();
        loader = second.loader;
        selection = first.selection;
      } else {
        selection = {
          ...first.selection,
          ...(kind === "handle" ? { package_handle: `sha256:${"f".repeat(64)}` as const } : {}),
          ...(kind === "catalog" ? { catalog_hash: `sha256:${"e".repeat(64)}` as const } : {}),
          ...(kind === "descriptor"
            ? {
                descriptor: {
                  ...first.selection.descriptor,
                  package_hash: `sha256:${"d".repeat(64)}` as const,
                },
              }
            : {}),
        };
      }

      await expectSkillError(loader.load(selection));
    },
  );

  it.each(["missing", "extra", "symlink", "hardlink", "mode", "growth"] as const)(
    "rejects a %s member mutation after exact selection",
    async (kind) => {
      const item = resource(
        "references/guide.md",
        "reference",
        "text/markdown",
        Buffer.from("guide\n", "utf8"),
      );
      const loaded = await fixture({ resources: [item] });
      const candidate = path.join(loaded.directory, item.path);
      const preserved = `${candidate}.preserved`;
      if (kind === "missing") await rm(candidate);
      if (kind === "extra")
        await writeFile(path.join(loaded.directory, "extra.txt"), "x", { mode: 0o600 });
      if (kind === "symlink") {
        await rename(candidate, preserved);
        await symlink(preserved, candidate);
      }
      if (kind === "hardlink") {
        await link(candidate, preserved);
      }
      if (kind === "mode") await chmod(candidate, 0o640);
      if (kind === "growth") await writeFile(candidate, "guide!\n", { mode: 0o600 });

      await expectSkillError(loaded.loader.load(loaded.selection));
    },
  );

  it.each([
    ["SKILL.md", Buffer.from([0xc3, 0x28])],
    ["references/guide.md", Buffer.from([0xc3, 0x28])],
  ] as const)("rejects invalid UTF-8 in text member %s", async (member, bytes) => {
    const resources =
      member === "SKILL.md" ? [] : [resource(member, "reference", "text/markdown", bytes)];
    const skillMarkdown = member === "SKILL.md" ? bytes : Buffer.from("# Testing\n");
    const loaded = await fixture({ skillMarkdown, resources });

    await expectSkillError(loaded.loader.load(loaded.selection));
  });

  it("rejects same-size content alteration for a selected member", async () => {
    const loaded = await fixture();
    await writeFile(path.join(loaded.directory, "references", "guide.md"), Buffer.from("xxxxx\n"), {
      mode: 0o600,
    });

    await expectSkillError(loaded.loader.load(loaded.selection));
  });

  it("rejects a same-size bundled SKILL.md alteration after exact selection", async () => {
    const root = await privateTemporaryDirectory("toss-bundled-source-");
    const statePath = await privateTemporaryDirectory("toss-bundled-state-");
    const directory = path.join(root, "testing");
    const skillMarkdown = Buffer.from("# Testing\n", "utf8");
    const manifest = packageManifest("testing", skillMarkdown, []);
    const bundledManifest = {
      schema_version: "bundled-skill-manifest.v1",
      packages: [
        {
          directory: "testing",
          manifest,
          handler: { capability: "testing", policy_version: "toss-superpowers.v1" },
        },
      ],
    };
    await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, "SKILL.md"), skillMarkdown, { mode: 0o644 });
    await chmod(path.join(directory, "SKILL.md"), 0o644);
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(manifestPath, canonicalJson(bundledManifest), { mode: 0o644 });
    await chmod(manifestPath, 0o644);
    const bundled: BundledCatalogTestOverride = {
      root,
      manifestPath,
      expectedManifestHash: rawHash(await readFile(manifestPath)),
    };
    const catalog = createSkillCatalogForTest({ configuredRoots: [], bundled });
    const discovered = await catalog.discover({
      query: null,
      allowed_capabilities: ["testing"],
    });
    const descriptor = discovered.descriptors[0]!;
    const selection = catalog.select(discovered, {
      mode: "explicit",
      capability: "testing",
      allowed_capabilities: ["testing"],
      query: null,
      descriptor: {
        name: descriptor.name,
        version: descriptor.version,
        source: descriptor.source,
        package_hash: descriptor.package_hash,
        document_hash: descriptor.document_hash,
      },
    });
    await writeFile(path.join(directory, "SKILL.md"), Buffer.from("# Changed\n", "utf8"), {
      mode: 0o644,
    });
    await chmod(path.join(directory, "SKILL.md"), 0o644);
    const loader = createSkillLoaderForTest({
      catalog,
      statePath,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      randomId: ids(),
      hasServiceListener: () => Promise.resolve("absent"),
    });

    await expectSkillError(loader.load(selection));
  });

  it.each([
    ["skill", SKILL_LIMITS.skillMarkdownBytes + 1],
    ["resource", SKILL_LIMITS.resourceBytes + 1],
  ] as const)("rejects a declared %s above its byte limit", async (kind, size) => {
    const root = await privateTemporaryDirectory("toss-skill-source-");
    const statePath = await privateTemporaryDirectory("toss-skill-state-");
    const markdown = Buffer.from("# Testing\n");
    const resources = [
      resource("assets/blob.bin", "asset", "application/octet-stream", Buffer.alloc(1)),
    ];
    const written = await writePackage(root, "testing", markdown, resources);
    const manifest = JSON.parse(
      await readFile(path.join(written.directory, "skill.json"), "utf8"),
    ) as Record<string, unknown>;
    if (kind === "skill") {
      manifest.skill_markdown = {
        path: "SKILL.md",
        media_type: "text/markdown",
        bytes: size,
        hash: rawHash(Buffer.alloc(1)),
      };
    } else {
      manifest.resources = [
        {
          path: "assets/blob.bin",
          role: "asset",
          phases: [],
          priority: null,
          media_type: "application/octet-stream",
          bytes: size,
          hash: rawHash(Buffer.alloc(1)),
        },
      ];
    }
    await writeFile(path.join(written.directory, "skill.json"), canonicalJson(manifest), {
      mode: 0o600,
    });
    const catalog = createSkillCatalogForTest({ configuredRoots: [root], includeBundled: false });

    await expectSkillError(
      catalog.discover({ query: null, allowed_capabilities: ["testing"] }),
      "RUNTIME_SKILL_INTEGRITY",
    );
    expect(await readdir(statePath)).toEqual([]);
  });

  it("revalidates the complete package after every asynchronous loader hook", async () => {
    let mutate = false;
    let target = "";
    const hooks: SkillLoaderTestHooks = {
      async afterBoundary() {
        if (!mutate) return;
        mutate = false;
        await chmod(target, 0o640);
      },
    };
    const loaded = await fixture({ hooks });
    target = path.join(loaded.directory, "SKILL.md");
    mutate = true;

    await expectSkillError(loaded.loader.load(loaded.selection));
  });

  it("starts a fresh held-chain sandwich before every post-hook pathname operation", async () => {
    let packageDirectory = "";
    let displacedDirectory = "";
    let mutated = false;
    const hooks: SkillLoaderTestHooks = {
      afterPathOperation(operation, candidate) {
        if (
          mutated ||
          operation !== "lstat" ||
          candidate !== path.join(packageDirectory, "SKILL.md")
        ) {
          return;
        }
        mutated = true;
        renameSync(packageDirectory, displacedDirectory);
        mkdirSync(packageDirectory, { mode: 0o700 });
      },
    };
    const loaded = await fixture({ hooks });
    packageDirectory = loaded.directory;
    displacedDirectory = `${loaded.directory}.displaced`;

    await expectSkillError(loaded.loader.load(loaded.selection));
    expect(mutated).toBe(true);
  });

  it("lets two loader hosts converge on one byte-identical object", async () => {
    const loaded = await fixture();
    const second = createSkillLoaderForTest({
      catalog: loaded.catalog,
      statePath: loaded.statePath,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      randomId: () => "76000000-0000-4000-8000-000000000001",
      hasServiceListener: () => Promise.resolve("absent"),
    });

    const [left, right] = await Promise.all([
      loaded.loader.load(loaded.selection),
      second.load(loaded.selection),
    ]);
    expect(right).toEqual(left);
    expect(await readdir(path.join(loaded.statePath, "skills", "objects"))).toEqual([
      `${left.package_hash}.json`,
    ]);
  });
});
