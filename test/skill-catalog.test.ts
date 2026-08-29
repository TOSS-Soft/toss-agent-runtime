import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
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
  type SkillCatalogSnapshot,
  type SkillPackageManifest,
  type SkillSelectionRequest,
} from "../src/skills/catalog.js";
import {
  auditBundledSkillInstallation,
  BUNDLED_MANIFEST_PATH,
  type BundledCatalogTestOverride,
} from "../src/skills/bundled.js";
import { RuntimeSkillError } from "../src/skills/errors.js";
import type { SkillDescriptorReference, SkillResourceV1 } from "../src/skills/types.js";

const temporaryDirectories: string[] = [];

function rawHash(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function privateTemporaryDirectory(prefix: string): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), prefix));
  const resolved = await realpath(created);
  await chmod(resolved, 0o700);
  temporaryDirectories.push(resolved);
  return resolved;
}

function packageManifest(
  name: string,
  options: {
    readonly description?: string;
    readonly version?: string;
    readonly capabilities?: readonly string[];
    readonly skillMarkdown?: string;
    readonly resources?: readonly SkillResourceV1[];
  } = {},
): SkillPackageManifest {
  const skillMarkdown = options.skillMarkdown ?? `# ${name}\n`;
  const resources = options.resources ?? [];
  const intrinsic = {
    name,
    description: options.description ?? `TOSS ${name} workflow guidance.`,
    version: options.version ?? "1.0.0",
    required_runtime_capabilities: options.capabilities ?? [name],
    skill_markdown: {
      path: "SKILL.md" as const,
      media_type: "text/markdown" as const,
      bytes: Buffer.byteLength(skillMarkdown),
      hash: rawHash(skillMarkdown),
    },
    resources,
  };
  const totalBytes =
    intrinsic.skill_markdown.bytes + resources.reduce((sum, item) => sum + item.bytes, 0);
  const package_hash = sha256({
    name: intrinsic.name,
    description: intrinsic.description,
    version: intrinsic.version,
    required_runtime_capabilities: intrinsic.required_runtime_capabilities,
    skill_markdown_bytes: intrinsic.skill_markdown.bytes,
    skill_markdown_hash: intrinsic.skill_markdown.hash,
    resources,
  });
  return { ...intrinsic, resource_count: resources.length, total_bytes: totalBytes, package_hash };
}

async function writeConfiguredPackage(
  root: string,
  name: string,
  options: Parameters<typeof packageManifest>[1] = {},
): Promise<{
  readonly directory: string;
  readonly manifestPath: string;
  readonly manifest: SkillPackageManifest;
}> {
  const directory = path.join(root, name);
  const manifestPath = path.join(directory, "skill.json");
  const manifest = packageManifest(name, options);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(manifestPath, canonicalJson(manifest), { mode: 0o600 });
  await writeFile(path.join(directory, "SKILL.md"), options.skillMarkdown ?? `# ${name}\n`, {
    mode: 0o600,
  });
  for (const resource of manifest.resources) {
    const components = resource.path.split("/").slice(0, -1);
    let parent = directory;
    for (const component of components) {
      parent = path.join(parent, component);
      await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      await chmod(parent, 0o700);
    }
    await writeFile(path.join(directory, resource.path), Buffer.alloc(resource.bytes), {
      mode: 0o600,
    });
  }
  return { directory, manifestPath, manifest };
}

async function configuredCatalog(
  packages: readonly {
    readonly name: string;
    readonly description?: string;
    readonly capabilities?: readonly string[];
    readonly skillMarkdown?: string;
  }[],
  options: Parameters<typeof createSkillCatalogForTest>[0] = {},
): Promise<{ readonly root: string; readonly catalog: SkillCatalog }> {
  const root = await privateTemporaryDirectory("toss-skill-root-");
  for (const entry of packages) await writeConfiguredPackage(root, entry.name, entry);
  return {
    root,
    catalog: createSkillCatalogForTest({
      configuredRoots: [root],
      includeBundled: false,
      ...options,
    }),
  };
}

function skillError(code: ConstructorParameters<typeof RuntimeSkillError>[0]): RuntimeSkillError {
  return new RuntimeSkillError(code);
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function reference(snapshot: SkillCatalogSnapshot, name: string): SkillDescriptorReference {
  const descriptor = snapshot.descriptors.find((entry) => entry.name === name);
  if (descriptor === undefined) throw new Error(`missing descriptor ${name}`);
  return {
    name: descriptor.name,
    version: descriptor.version,
    source: descriptor.source,
    package_hash: descriptor.package_hash,
    document_hash: descriptor.document_hash,
  };
}

async function copyBundledFixture(): Promise<BundledCatalogTestOverride> {
  const sourceManifest = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(BUNDLED_MANIFEST_PATH, "utf8"),
    ),
  ) as {
    readonly packages: readonly { readonly directory: string }[];
  };
  const root = await privateTemporaryDirectory("toss-bundled-");
  const sourceRoot = path.dirname(BUNDLED_MANIFEST_PATH);
  const manifestPath = path.join(root, "manifest.json");
  await copyFile(BUNDLED_MANIFEST_PATH, manifestPath);
  await chmod(manifestPath, 0o600);
  for (const entry of sourceManifest.packages) {
    const directory = path.join(root, entry.directory);
    await mkdir(directory, { mode: 0o700 });
    await copyFile(
      path.join(sourceRoot, entry.directory, "SKILL.md"),
      path.join(directory, "SKILL.md"),
    );
    await chmod(path.join(directory, "SKILL.md"), 0o600);
  }
  return {
    root,
    manifestPath,
    expectedManifestHash: rawHash(
      await import("node:fs/promises").then(({ readFile }) => readFile(manifestPath)),
    ),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("skill catalog metadata discovery", () => {
  it("reads only configured skill.json and the bundled manifest before selection", async () => {
    const reads: string[] = [];
    const { root, catalog } = await configuredCatalog(
      [
        {
          name: "testing",
          description: "Test first with TOSS controls.",
          capabilities: ["testing"],
        },
        { name: "reviewing", description: "Review TOSS changes.", capabilities: ["reviewing"] },
      ],
      { hooks: { onFileRead: (name) => reads.push(name) } },
    );
    await writeFile(path.join(root, "testing", "SKILL.md"), "x".repeat(10), { mode: 0o600 });
    const snapshot = await catalog.discover({
      query: "test first",
      allowed_capabilities: ["testing"],
    });
    expect(snapshot.descriptors.map((entry) => entry.name)).toEqual(["testing"]);
    expect(reads.map((name) => path.basename(name))).toEqual(["skill.json", "skill.json"]);

    const bundledReads: string[] = [];
    const bundled = createSkillCatalogForTest({
      configuredRoots: [],
      hooks: { onFileRead: (name) => bundledReads.push(name) },
    });
    await bundled.discover({
      query: "test first",
      allowed_capabilities: ["test-driven-development"],
    });
    expect(bundledReads.map((name) => path.basename(name))).toEqual(["manifest.json"]);
  });

  it("matches bounded normalized name and description metadata and capability subsets", async () => {
    const { catalog } = await configuredCatalog([
      {
        name: "testing",
        description: "TOSS   Test\u212A discipline",
        capabilities: ["shell", "testing"],
      },
      { name: "reviewing", description: "Review TOSS changes", capabilities: ["reviewing"] },
    ]);
    const snapshot = await catalog.discover({
      query: "testk discipline",
      allowed_capabilities: ["shell", "testing"],
    });
    expect(snapshot.descriptors.map((entry) => entry.name)).toEqual(["testing"]);
    await expect(
      catalog.discover({ query: "x".repeat(513), allowed_capabilities: ["testing"] }),
    ).rejects.toEqual(skillError("RUNTIME_SKILL_LIMIT_EXCEEDED"));
  });

  it("constructs location-free recursively frozen public descriptors and snapshots", async () => {
    const { root, catalog } = await configuredCatalog([
      { name: "testing", capabilities: ["testing"] },
    ]);
    const snapshot = await catalog.discover({ query: null, allowed_capabilities: ["testing"] });
    expectDeepFrozen(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain(root);
    expect(snapshot.descriptors[0]).toMatchObject({
      protocol_version: "runtime-contract.v1",
      schema_version: "skill-descriptor.v1",
      document_type: "skill-descriptor",
      name: "testing",
      source: { kind: "configured" },
    });
    expect(snapshot.descriptors[0]?.source.identity).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it.each([
    ["root mode", async (root: string) => chmod(root, 0o755)],
    ["package mode", async (root: string) => chmod(path.join(root, "testing"), 0o755)],
    [
      "manifest mode",
      async (root: string) => chmod(path.join(root, "testing", "skill.json"), 0o640),
    ],
    [
      "manifest hardlink",
      async (root: string) =>
        link(path.join(root, "testing", "skill.json"), path.join(root, "manifest-copy")),
    ],
    ["special directory mode", async (root: string) => chmod(path.join(root, "testing"), 0o4700)],
    [
      "case alias",
      async (root: string) => rename(path.join(root, "testing"), path.join(root, "Testing")),
    ],
  ])("rejects unsafe configured %s", async (_name, mutate) => {
    const { root, catalog } = await configuredCatalog([
      { name: "testing", capabilities: ["testing"] },
    ]);
    await mutate(root);
    await expect(
      catalog.discover({ query: null, allowed_capabilities: ["testing"] }),
    ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
  });

  it("rejects symlink ancestry for configured roots and packages", async () => {
    const target = await privateTemporaryDirectory("toss-skill-target-");
    await writeConfiguredPackage(target, "testing", { capabilities: ["testing"] });
    const parent = await privateTemporaryDirectory("toss-skill-link-");
    const linkedRoot = path.join(parent, "root");
    await symlink(target, linkedRoot, "dir");
    const rootCatalog = createSkillCatalogForTest({
      configuredRoots: [linkedRoot],
      includeBundled: false,
    });
    await expect(
      rootCatalog.discover({ query: null, allowed_capabilities: ["testing"] }),
    ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));

    const root = await privateTemporaryDirectory("toss-skill-root-");
    await symlink(path.join(target, "testing"), path.join(root, "testing"), "dir");
    const packageCatalog = createSkillCatalogForTest({
      configuredRoots: [root],
      includeBundled: false,
    });
    await expect(
      packageCatalog.discover({ query: null, allowed_capabilities: ["testing"] }),
    ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
  });

  it.each([
    [
      "cross-owner manifest",
      (identity: { uid: number; mode: number }) => ({ ...identity, uid: identity.uid + 1 }),
    ],
    [
      "FIFO manifest",
      (identity: { uid: number; mode: number }) => ({ ...identity, mode: 0o010600 }),
    ],
  ])("rejects modeled %s metadata", async (_name, alter) => {
    const { catalog } = await configuredCatalog([{ name: "testing", capabilities: ["testing"] }], {
      hooks: {
        mapIdentity: (name, identity) =>
          path.basename(name) === "skill.json" ? { ...identity, ...alter(identity) } : identity,
      },
    });
    await expect(
      catalog.discover({ query: null, allowed_capabilities: ["testing"] }),
    ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
  });

  it("rejects package-directory identity aliases", async () => {
    const root = await privateTemporaryDirectory("toss-skill-root-");
    await writeConfiguredPackage(root, "alpha", { capabilities: ["alpha"] });
    await writeConfiguredPackage(root, "beta", { capabilities: ["beta"] });
    let firstPackageIdentity: { dev: bigint; ino: bigint } | undefined;
    const catalog = createSkillCatalogForTest({
      configuredRoots: [root],
      includeBundled: false,
      hooks: {
        mapIdentity(name, identity) {
          if (!["alpha", "beta"].includes(path.basename(name))) return identity;
          firstPackageIdentity ??= { dev: identity.dev, ino: identity.ino };
          return { ...identity, ...firstPackageIdentity };
        },
      },
    });
    await expect(
      catalog.discover({ query: null, allowed_capabilities: ["alpha", "beta"] }),
    ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
  });

  it("detects manifest identity replacement during a bounded read", async () => {
    const { root, catalog } = await configuredCatalog(
      [{ name: "testing", capabilities: ["testing"] }],
      {
        hooks: {
          async afterManifestRead(name) {
            if (path.basename(name) !== "skill.json") return;
            const replacement = `${name}.replacement`;
            await writeFile(
              replacement,
              canonicalJson(packageManifest("testing", { capabilities: ["testing"] })),
              { mode: 0o600 },
            );
            await rename(replacement, name);
          },
        },
      },
    );
    expect(root).toBeTruthy();
    await expect(
      catalog.discover({ query: null, allowed_capabilities: ["testing"] }),
    ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
  });

  it.each(
    (
      [
        "root-open",
        "root-enumerate",
        "package-open",
        "package-enumerate",
        "manifest-open",
        "manifest-read",
        "member-stat",
        "package-final-revalidate",
      ] as const
    ).flatMap((boundary) => ["before", "after"].map((phase) => [boundary, phase] as const)),
  )(
    "rejects ancestor replacement at the %s boundary during %s validation",
    async (boundary, phase) => {
      const base = await privateTemporaryDirectory("toss-skill-race-");
      const trusted = path.join(base, "trusted");
      const preserved = path.join(base, "trusted-preserved");
      const replacement = path.join(base, "replacement");
      const root = path.join(trusted, "root");
      const replacementRoot = path.join(replacement, "root");
      await mkdir(root, { recursive: true, mode: 0o700 });
      await chmod(trusted, 0o700);
      await chmod(root, 0o700);
      await mkdir(replacementRoot, { recursive: true, mode: 0o700 });
      await chmod(replacement, 0o700);
      await chmod(replacementRoot, 0o700);
      await writeConfiguredPackage(root, "testing", { capabilities: ["testing"] });
      await writeConfiguredPackage(replacementRoot, "testing", { capabilities: ["testing"] });
      let swapped = false;
      const catalog = createSkillCatalogForTest({
        configuredRoots: [root],
        includeBundled: false,
        hooks: {
          async beforeConfiguredBoundary(observedBoundary) {
            if (phase !== "before" || observedBoundary !== boundary || swapped) return;
            await rename(trusted, preserved);
            await rename(replacement, trusted);
            swapped = true;
          },
          async afterConfiguredBoundary(observedBoundary) {
            if (phase !== "after" || observedBoundary !== boundary || swapped) return;
            await rename(trusted, preserved);
            await rename(replacement, trusted);
            swapped = true;
          },
        },
      });
      try {
        await expect(
          catalog.discover({ query: null, allowed_capabilities: ["testing"] }),
        ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
        expect(swapped).toBe(true);
        await expect(lstat(preserved)).resolves.toBeDefined();
        await expect(lstat(trusted)).resolves.toBeDefined();
      } finally {
        if (swapped) {
          await rename(trusted, replacement);
          await rename(preserved, trusted);
        }
      }
    },
  );

  it("rejects same-size configured member replacement after metadata stat", async () => {
    const root = await privateTemporaryDirectory("toss-skill-root-");
    await writeConfiguredPackage(root, "testing", { capabilities: ["testing"] });
    const skill = path.join(root, "testing", "SKILL.md");
    const preserved = path.join(root, "testing", "SKILL.preserved");
    let replaced = false;
    const catalog = createSkillCatalogForTest({
      configuredRoots: [root],
      includeBundled: false,
      hooks: {
        async afterConfiguredBoundary(boundary, target) {
          if (boundary !== "member-stat" || target !== skill || replaced) return;
          await rename(skill, preserved);
          await writeFile(skill, "z".repeat(10), { mode: 0o600 });
          replaced = true;
        },
      },
    });
    try {
      await expect(
        catalog.discover({ query: null, allowed_capabilities: ["testing"] }),
      ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
      await expect(lstat(skill)).resolves.toBeDefined();
      await expect(lstat(preserved)).resolves.toBeDefined();
    } finally {
      if (replaced) {
        await rm(skill);
        await rename(preserved, skill);
      }
    }
  });

  it.each(["missing", "extra", "symlink", "directory", "mode", "size"] as const)(
    "rejects configured package closure with a %s member mutation without reading bodies",
    async (mutation) => {
      const reads: string[] = [];
      const { root, catalog } = await configuredCatalog(
        [{ name: "testing", capabilities: ["testing"] }],
        { hooks: { onFileRead: (name) => reads.push(name) } },
      );
      const skill = path.join(root, "testing", "SKILL.md");
      if (mutation === "missing") await rm(skill);
      if (mutation === "extra") {
        await writeFile(path.join(root, "testing", "undeclared.txt"), "x", { mode: 0o600 });
      }
      if (mutation === "symlink") {
        await rm(skill);
        await symlink(path.join(root, "testing", "skill.json"), skill);
      }
      if (mutation === "directory") {
        await rm(skill);
        await mkdir(skill, { mode: 0o700 });
      }
      if (mutation === "mode") await chmod(skill, 0o640);
      if (mutation === "size") await writeFile(skill, "wrong", { mode: 0o600 });
      await expect(
        catalog.discover({ query: null, allowed_capabilities: ["testing"] }),
      ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
      expect(reads.every((name) => path.basename(name) === "skill.json")).toBe(true);
    },
  );

  it.each(["owner", "fifo", "device"] as const)(
    "rejects configured package closure with modeled %s metadata",
    async (mutation) => {
      const { catalog } = await configuredCatalog(
        [{ name: "testing", capabilities: ["testing"] }],
        {
          hooks: {
            mapIdentity(name, identity) {
              if (path.basename(name) !== "SKILL.md") return identity;
              if (mutation === "owner") return { ...identity, uid: identity.uid + 1 };
              if (mutation === "fifo") return { ...identity, mode: 0o010600 };
              return { ...identity, mode: 0o060600 };
            },
          },
        },
      );
      await expect(
        catalog.discover({ query: null, allowed_capabilities: ["testing"] }),
      ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
    },
  );

  it("rejects configured member inode aliases and accepts complete declared resource metadata", async () => {
    const resource = {
      path: "references/guide.md",
      role: "reference" as const,
      media_type: "text/markdown",
      bytes: 4,
      hash: rawHash(Buffer.alloc(4)),
    };
    const root = await privateTemporaryDirectory("toss-skill-root-");
    await writeConfiguredPackage(root, "testing", {
      capabilities: ["testing"],
      resources: [resource],
    });
    const catalog = createSkillCatalogForTest({ configuredRoots: [root], includeBundled: false });
    await expect(
      catalog.discover({ query: null, allowed_capabilities: ["testing"] }),
    ).resolves.toMatchObject({ descriptors: [{ name: "testing", resource_count: 1 }] });

    await rm(path.join(root, "testing", resource.path));
    await link(path.join(root, "testing", "SKILL.md"), path.join(root, "testing", resource.path));
    await expect(
      catalog.discover({ query: null, allowed_capabilities: ["testing"] }),
    ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
  });

  it("revalidates exact package entries after the asynchronous manifest hook", async () => {
    const { root, catalog } = await configuredCatalog(
      [{ name: "testing", capabilities: ["testing"] }],
      {
        hooks: {
          async afterManifestRead(name) {
            await writeFile(path.join(path.dirname(name), "late-extra"), "x", { mode: 0o600 });
          },
        },
      },
    );
    expect(root).toBeTruthy();
    await expect(
      catalog.discover({ query: null, allowed_capabilities: ["testing"] }),
    ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
  });

  it("rejects unknown manifest keys and accounting/hash mutations", async () => {
    const root = await privateTemporaryDirectory("toss-skill-root-");
    const fixture = await writeConfiguredPackage(root, "testing", { capabilities: ["testing"] });
    await writeFile(
      fixture.manifestPath,
      canonicalJson({ ...fixture.manifest, path: fixture.directory }),
      { mode: 0o600 },
    );
    const catalog = createSkillCatalogForTest({ configuredRoots: [root], includeBundled: false });
    await expect(
      catalog.discover({ query: null, allowed_capabilities: ["testing"] }),
    ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
  });

  it("fails closed after 256 packages without reading package bodies", async () => {
    const root = await privateTemporaryDirectory("toss-skill-root-");
    for (let index = 0; index < 257; index += 1) {
      await mkdir(path.join(root, `package-${String(index).padStart(3, "0")}`), { mode: 0o700 });
    }
    const catalog = createSkillCatalogForTest({ configuredRoots: [root], includeBundled: false });
    await expect(catalog.discover({ query: null, allowed_capabilities: [] })).rejects.toEqual(
      skillError("RUNTIME_SKILL_LIMIT_EXCEEDED"),
    );
  });

  it("fails closed before enumerating more than 16 configured roots", async () => {
    const roots = await Promise.all(
      Array.from({ length: 17 }, (_unused, index) =>
        privateTemporaryDirectory(`toss-skill-root-${String(index).padStart(2, "0")}-`),
      ),
    );
    const catalog = createSkillCatalogForTest({
      configuredRoots: roots.sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
      includeBundled: false,
    });
    await expect(catalog.discover({ query: null, allowed_capabilities: [] })).rejects.toEqual(
      skillError("RUNTIME_SKILL_LIMIT_EXCEEDED"),
    );
  });

  it("rejects duplicate semantic source identities whose intrinsic bytes differ", async () => {
    const first = await privateTemporaryDirectory("toss-skill-root-a-");
    const second = await privateTemporaryDirectory("toss-skill-root-b-");
    await writeConfiguredPackage(first, "testing", {
      description: "first",
      capabilities: ["testing"],
    });
    await writeConfiguredPackage(second, "testing", {
      description: "second",
      capabilities: ["testing"],
    });
    const catalog = createSkillCatalogForTest({
      configuredRoots: [first, second].sort(),
      includeBundled: false,
      hooks: {
        mapIdentity(name, identity) {
          if (path.basename(name) === "skill.json") return identity;
          const isRoot = name === first || name === second;
          return isRoot ? { ...identity, dev: 11n, ino: 12n } : { ...identity, dev: 21n, ino: 22n };
        },
      },
    });
    await expect(
      catalog.discover({ query: null, allowed_capabilities: ["testing"] }),
    ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
  });
});

describe("bundled catalog authentication", () => {
  it("advertises the five audited TOSS packages without reading body bytes", async () => {
    const reads: string[] = [];
    const catalog = createSkillCatalogForTest({
      configuredRoots: [],
      hooks: { onFileRead: (name) => reads.push(name) },
    });
    const snapshot = await catalog.discover({
      query: null,
      allowed_capabilities: [
        "brainstorming",
        "requesting-code-review",
        "systematic-debugging",
        "test-driven-development",
        "verification-before-completion",
      ],
    });
    expect(snapshot.descriptors.map((entry) => entry.name)).toEqual([
      "brainstorming",
      "requesting-code-review",
      "systematic-debugging",
      "test-driven-development",
      "verification-before-completion",
    ]);
    expect(reads.map((name) => path.basename(name))).toEqual(["manifest.json"]);
  });

  it.each(["missing", "directory", "writable", "wrong-size"] as const)(
    "rejects bundled body metadata that is %s without reading the body",
    async (mutation) => {
      const override = await copyBundledFixture();
      const target = path.join(override.root, "brainstorming", "SKILL.md");
      if (mutation === "missing") await rm(target);
      if (mutation === "directory") {
        await rm(target);
        await mkdir(target, { mode: 0o700 });
      }
      if (mutation === "writable") await chmod(target, 0o622);
      if (mutation === "wrong-size") await writeFile(target, "wrong size", { mode: 0o600 });
      const reads: string[] = [];
      const catalog = createSkillCatalogForTest({
        configuredRoots: [],
        bundled: override,
        hooks: { onFileRead: (name) => reads.push(name) },
      });
      await expect(
        catalog.discover({ query: null, allowed_capabilities: ["brainstorming"] }),
      ).rejects.toEqual(skillError("RUNTIME_SKILL_INTEGRITY"));
      expect(reads.map((name) => path.basename(name))).toEqual(["manifest.json"]);
    },
  );

  it("keeps same-size body alteration out of discovery and catches it in the audit helper", async () => {
    const override = await copyBundledFixture();
    const target = path.join(override.root, "brainstorming", "SKILL.md");
    const original = await import("node:fs/promises").then(({ readFile }) => readFile(target));
    const altered = Buffer.from(original);
    altered[0] = altered[0] === 35 ? 36 : 35;
    await writeFile(target, altered, { mode: 0o600 });

    const runtimeReads: string[] = [];
    const catalog = createSkillCatalogForTest({
      configuredRoots: [],
      bundled: override,
      hooks: { onFileRead: (name) => runtimeReads.push(name) },
    });
    await expect(
      catalog.discover({ query: null, allowed_capabilities: ["brainstorming"] }),
    ).resolves.toBeDefined();
    expect(runtimeReads.map((name) => path.basename(name))).toEqual(["manifest.json"]);
    await expect(auditBundledSkillInstallation(override)).rejects.toEqual(
      skillError("RUNTIME_SKILL_INTEGRITY"),
    );
  });
});

describe("skill selection", () => {
  it("requires an exact descriptor reference for explicit selection", async () => {
    const { catalog } = await configuredCatalog([{ name: "testing", capabilities: ["testing"] }]);
    const snapshot = await catalog.discover({ query: null, allowed_capabilities: ["testing"] });
    const exact = reference(snapshot, "testing");
    const selection = catalog.select(snapshot, {
      mode: "explicit",
      capability: "testing",
      allowed_capabilities: ["testing"],
      query: null,
      descriptor: exact,
    });
    expect(selection.descriptor).toEqual(snapshot.descriptors[0]);
    expectDeepFrozen(selection);
    expect(() =>
      catalog.select(snapshot, {
        mode: "explicit",
        capability: "testing",
        allowed_capabilities: ["testing"],
        query: null,
        descriptor: { ...exact, package_hash: rawHash("different") },
      }),
    ).toThrowError(skillError("BLOCKED_SUPERPOWERS_MISSING"));
  });

  it("ignores query for exact explicit selection but still enforces allowed capabilities", async () => {
    const { catalog } = await configuredCatalog([
      {
        name: "testing",
        description: "TOSS test first discipline",
        capabilities: ["shell", "testing"],
      },
    ]);
    const snapshot = await catalog.discover({
      query: null,
      allowed_capabilities: ["shell", "testing"],
    });
    const descriptor = reference(snapshot, "testing");
    expect(
      catalog.select(snapshot, {
        mode: "explicit",
        capability: "testing",
        allowed_capabilities: ["shell", "testing"],
        query: "does not match this descriptor",
        descriptor,
      }).descriptor.name,
    ).toBe("testing");
    expect(() =>
      catalog.select(snapshot, {
        mode: "explicit",
        capability: "testing",
        allowed_capabilities: ["testing"],
        query: null,
        descriptor,
      }),
    ).toThrowError(skillError("BLOCKED_SUPERPOWERS_MISSING"));
  });

  it("rejects malformed mode/descriptor combinations", async () => {
    const { catalog } = await configuredCatalog([{ name: "testing", capabilities: ["testing"] }]);
    const snapshot = await catalog.discover({ query: null, allowed_capabilities: ["testing"] });
    expect(() =>
      catalog.select(snapshot, {
        mode: "explicit",
        capability: "testing",
        allowed_capabilities: ["testing"],
        query: null,
        descriptor: null,
      }),
    ).toThrowError(skillError("RUNTIME_SKILL_INVALID"));
    expect(() =>
      catalog.select(snapshot, {
        mode: "implicit",
        capability: "testing",
        allowed_capabilities: ["testing"],
        query: null,
        descriptor: reference(snapshot, "testing"),
      }),
    ).toThrowError(skillError("RUNTIME_SKILL_INVALID"));
  });

  it("rejects an explicit descriptor reference with untrusted extra fields", async () => {
    const { catalog } = await configuredCatalog([{ name: "testing", capabilities: ["testing"] }]);
    const snapshot = await catalog.discover({
      query: null,
      allowed_capabilities: ["testing"],
    });
    const request = {
      mode: "explicit",
      capability: "testing",
      allowed_capabilities: ["testing"],
      query: null,
      descriptor: { ...reference(snapshot, "testing"), absolute_path: "/private/skill" },
    } as unknown as SkillSelectionRequest;
    expect(() => catalog.select(snapshot, request)).toThrowError(
      skillError("RUNTIME_SKILL_INVALID"),
    );
  });

  it("allows one implicit capability/query intersection and blocks zero candidates", async () => {
    const { catalog } = await configuredCatalog([
      { name: "testing", description: "TOSS test first discipline", capabilities: ["testing"] },
    ]);
    const snapshot = await catalog.discover({ query: null, allowed_capabilities: ["testing"] });
    expect(
      catalog.select(snapshot, {
        mode: "implicit",
        capability: "testing",
        allowed_capabilities: ["testing"],
        query: "test first",
        descriptor: null,
      }).descriptor.name,
    ).toBe("testing");
    expect(() =>
      catalog.select(snapshot, {
        mode: "implicit",
        capability: "testing",
        allowed_capabilities: [],
        query: null,
        descriptor: null,
      }),
    ).toThrowError(skillError("BLOCKED_SUPERPOWERS_MISSING"));
  });

  it("fails implicit ambiguity without precedence or fallback", async () => {
    const first = await privateTemporaryDirectory("toss-skill-root-a-");
    const second = await privateTemporaryDirectory("toss-skill-root-b-");
    await writeConfiguredPackage(first, "testing", {
      description: "TOSS test first",
      capabilities: ["testing"],
    });
    await writeConfiguredPackage(second, "testing", {
      description: "TOSS test first",
      capabilities: ["testing"],
    });
    const catalog = createSkillCatalogForTest({
      configuredRoots: [first, second].sort(),
      includeBundled: false,
    });
    const snapshot = await catalog.discover({ query: null, allowed_capabilities: ["testing"] });
    expect(() =>
      catalog.select(snapshot, {
        mode: "implicit",
        capability: "testing",
        allowed_capabilities: ["testing"],
        query: "test first",
        descriptor: null,
      }),
    ).toThrowError(skillError("RUNTIME_SKILL_INTEGRITY"));
  });
});
