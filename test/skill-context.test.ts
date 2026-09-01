import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256 } from "../src/protocol/json.js";
import { hashSkillPackage } from "../src/skills/contracts.js";
import {
  assembleSkillContext,
  type SkillContextMaterial,
  type SkillContextRequest,
} from "../src/skills/context.js";
import { RuntimeSkillError } from "../src/skills/errors.js";
import type { SkillResourceV1, SkillSnapshotV1 } from "../src/skills/types.js";

const resourceBodies = new Map<string, string>();

function hash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function resource(
  path: string,
  role: SkillResourceV1["role"],
  phases: readonly SkillResourceV1["phases"][number][],
  priority: number | null,
  body: string,
): SkillResourceV1 {
  const bytes = Buffer.from(body, "utf8");
  resourceBodies.set(path, body);
  return {
    path,
    role,
    phases,
    priority,
    media_type: role === "asset" ? "application/octet-stream" : "text/markdown",
    bytes: bytes.byteLength,
    hash: hash(bytes),
  };
}

function fixture(resources: readonly SkillResourceV1[]) {
  const skillMarkdown = Buffer.from("# Skill\n", "utf8");
  const canonicalResources = [...resources].sort((left, right) =>
    Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")),
  );
  const descriptorBase = {
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "skill-descriptor.v1" as const,
    document_type: "skill-descriptor" as const,
    name: "testing",
    description: "Testing skill.",
    version: "1.0.0",
    source: { kind: "bundled" as const, identity: "testing" },
    resource_count: canonicalResources.length,
    total_bytes:
      skillMarkdown.byteLength + canonicalResources.reduce((sum, item) => sum + item.bytes, 0),
    required_runtime_capabilities: ["testing"],
  };
  const descriptorWithPlaceholder = {
    ...descriptorBase,
    package_hash: `sha256:${"0".repeat(64)}` as const,
    document_hash: `sha256:${"0".repeat(64)}` as const,
  };
  const packageHash = hashSkillPackage({
    descriptor: descriptorWithPlaceholder,
    skill_markdown_hash: hash(skillMarkdown),
    skill_markdown_bytes: skillMarkdown.byteLength,
    resources: canonicalResources,
  });
  const descriptor = {
    ...descriptorBase,
    package_hash: packageHash,
  };
  const signedDescriptor = { ...descriptor, document_hash: sha256(descriptor) };
  const snapshotBase = {
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "skill-snapshot.v1" as const,
    document_type: "skill-snapshot" as const,
    descriptor: signedDescriptor,
    skill_markdown_hash: hash(skillMarkdown),
    skill_markdown_bytes: skillMarkdown.byteLength,
    resources: canonicalResources,
    package_hash: packageHash,
    total_bytes: descriptor.total_bytes,
  };
  const snapshot = { ...snapshotBase, document_hash: sha256(snapshotBase) } as SkillSnapshotV1;
  return {
    snapshot,
    material: {
      skill_markdown: skillMarkdown,
      resources: resources.map((entry) => ({
        path: entry.path,
        bytes: Buffer.from(resourceBodies.get(entry.path)!, "utf8"),
      })),
    } as SkillContextMaterial,
  };
}

function request(
  snapshot: SkillSnapshotV1,
  maxBytes = 256,
  maxTokens = Math.ceil(maxBytes / 4),
): SkillContextRequest {
  return {
    snapshot,
    snapshot_hash: snapshot.document_hash,
    phase: "GREEN",
    max_bytes: maxBytes,
    max_tokens: maxTokens,
  };
}

describe("bounded skill context", () => {
  it("includes SKILL.md and only phase-required reference bodies", () => {
    const green = resource("references/green.md", "reference", ["GREEN"], null, "green\n");
    const red = resource("references/red.md", "reference", ["RED"], null, "red\n");
    const asset = resource("assets/private.bin", "asset", [], null, "asset\n");
    const script = resource("scripts/check.md", "script", [], null, "script\n");
    const { snapshot, material } = fixture([asset, green, red, script]);

    const context = assembleSkillContext(request(snapshot), material);

    expect(context.segments.map((segment) => segment.path)).toEqual([
      "SKILL.md",
      "references/green.md",
    ]);
    expect(context.segments.map((segment) => segment.role)).toEqual(["skill", "reference"]);
    expect(context.included_resource_hashes).toEqual([green.hash]);
    expect(context.omitted_resource_hashes).toEqual([asset.hash, red.hash, script.hash]);
  });

  it("orders optional references by declared priority then portable path and records exact truncation", () => {
    const required = resource("references/green.md", "reference", ["GREEN"], null, "green\n");
    const optionalB = resource(
      "references/optional-b.md",
      "reference",
      ["GREEN"],
      10,
      "optional-b\n",
    );
    const optionalA = resource(
      "references/optional-a.md",
      "reference",
      ["GREEN"],
      10,
      "optional-a\n",
    );
    const { snapshot, material } = fixture([optionalB, required, optionalA]);
    const budget =
      Buffer.byteLength("# Skill\n") +
      Buffer.byteLength("green\n") +
      Buffer.byteLength("optional-a\n");

    const context = assembleSkillContext(request(snapshot, budget), material);

    expect(context.segments.map((segment) => segment.path)).toEqual([
      "SKILL.md",
      "references/green.md",
      "references/optional-a.md",
    ]);
    expect(context.truncations).toEqual([
      {
        path: "references/optional-b.md",
        original_bytes: optionalB.bytes,
        included_bytes: 0,
      },
    ]);
    expect(context.remaining_bytes).toBe(0);
    expect(context.remaining_tokens).toBe(0);
  });

  it("is deterministic across material permutations and honors priority before path", () => {
    const lowerPriority = resource("references/z-first.md", "reference", ["GREEN"], 1, "script\n");
    const laterPath = resource("references/a-later.md", "reference", ["GREEN"], 10, "script\n");
    const { snapshot, material } = fixture([laterPath, lowerPriority]);
    const budget = Buffer.byteLength("# Skill\n") + lowerPriority.bytes;
    const first = assembleSkillContext(request(snapshot, budget), material);
    const second = assembleSkillContext(request(snapshot, budget), {
      ...material,
      resources: [...material.resources].reverse(),
    });

    expect(first).toEqual(second);
    expect(first.segments.map((segment) => segment.path)).toEqual([
      "SKILL.md",
      "references/z-first.md",
    ]);
  });

  it("fails before phase execution when mandatory content exceeds its budget", () => {
    const required = resource("references/green.md", "reference", ["GREEN"], null, "green\n");
    const { snapshot, material } = fixture([required]);

    expect(() => assembleSkillContext(request(snapshot, 1), material)).toThrowError(
      new RuntimeSkillError("RUNTIME_SKILL_CONTEXT_OVERFLOW"),
    );
  });

  it("uses UTF-8 bytes and conservative tokens", () => {
    const unicode = resource("references/unicode.md", "reference", ["GREEN"], null, "😀\n");
    const { snapshot, material } = fixture([unicode]);

    const context = assembleSkillContext(request(snapshot), material);

    expect(context.included_utf8_bytes).toBe(Buffer.byteLength("# Skill\n😀\n"));
    expect(context.included_tokens).toBe(Math.ceil(context.included_utf8_bytes / 4));
  });

  it("rejects an altered stored resource", () => {
    const required = resource("references/green.md", "reference", ["GREEN"], null, "green\n");
    const { snapshot, material } = fixture([required]);
    const altered = {
      ...material,
      resources: [{ path: required.path, bytes: Buffer.from("other\n") }],
    };

    expect(() => assembleSkillContext(request(snapshot), altered)).toThrowError(
      new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY"),
    );
  });

  it("partially includes the largest UTF-8-safe optional prefix and stops lower priorities", () => {
    const first = resource("references/first.md", "reference", ["GREEN"], 1, "abcdef");
    const later = resource("references/later.md", "reference", ["GREEN"], 2, "later");
    const { snapshot, material } = fixture([later, first]);

    const context = assembleSkillContext(request(snapshot, 11, 3), material);
    const partial = context.segments[1]!;

    expect(partial).toMatchObject({
      path: first.path,
      role: "reference",
      source_hash: first.hash,
      included_hash: hash(Buffer.from("abc")),
      original_bytes: 6,
      included_bytes: 3,
      conservative_tokens: 1,
      content: "abc",
    });
    expect(context.truncations).toEqual([
      { path: first.path, original_bytes: 6, included_bytes: 3 },
    ]);
    expect(context.omitted_resource_hashes).toEqual([first.hash, later.hash]);
  });

  it("accounts conservative tokens per segment and accepts zero budgets as overflow", () => {
    const first = resource("references/first.md", "reference", ["GREEN"], 1, "a");
    const second = resource("references/second.md", "reference", ["GREEN"], 2, "b");
    const { snapshot, material } = fixture([second, first]);

    const context = assembleSkillContext(request(snapshot, 10, 4), material);

    expect(context.included_tokens).toBe(4);
    expect(context.remaining_tokens).toBe(0);
    expect(() => assembleSkillContext(request(snapshot, 0, 0), material)).toThrowError(
      new RuntimeSkillError("RUNTIME_SKILL_CONTEXT_OVERFLOW"),
    );
  });

  it("uses the token budget independently and never splits a multibyte code point", () => {
    const optional = resource("references/unicode-optional.md", "reference", ["GREEN"], 1, "😀a");
    const { snapshot, material } = fixture([optional]);

    const context = assembleSkillContext(request(snapshot, 64, 3), material);

    expect(context.segments[1]).toMatchObject({
      content: "😀",
      included_bytes: 4,
      conservative_tokens: 1,
    });
    expect(context.truncations).toEqual([
      { path: optional.path, original_bytes: 5, included_bytes: 4 },
    ]);
  });

  it("keeps an omitted digest when identical content is also included", () => {
    const included = resource("references/included.md", "reference", ["GREEN"], null, "same");
    const omittedFirst = resource("references/omitted-a.md", "reference", ["RED"], null, "same");
    const { snapshot, material } = fixture([included, omittedFirst]);

    const context = assembleSkillContext(request(snapshot), material);

    expect(context.included_resource_hashes).toContain(included.hash);
    expect(context.omitted_resource_hashes).toEqual([included.hash]);
  });

  it("deduplicates omitted hashes for multiple same-content resources", () => {
    const omittedFirst = resource("references/omitted-a.md", "reference", ["RED"], null, "same");
    const omittedSecond = resource("references/omitted-b.md", "reference", ["RED"], null, "same");
    const { snapshot, material } = fixture([omittedSecond, omittedFirst]);

    expect(assembleSkillContext(request(snapshot), material).omitted_resource_hashes).toEqual([
      omittedFirst.hash,
    ]);
  });
});
