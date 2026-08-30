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
        bytes: Buffer.from(
          entry.path === "references/green.md"
            ? "green\n"
            : entry.path === "references/optional-a.md"
              ? "optional-a\n"
              : entry.path === "references/optional-b.md"
                ? "optional-b\n"
                : entry.path === "references/unicode.md"
                  ? "😀\n"
                  : entry.path === "references/red.md"
                    ? "red\n"
                    : entry.path === "assets/private.bin"
                      ? "asset\n"
                      : "script\n",
          "utf8",
        ),
      })),
    } as SkillContextMaterial,
  };
}

function request(snapshot: SkillSnapshotV1, maxBytes = 256): SkillContextRequest {
  return {
    snapshot,
    snapshot_hash: snapshot.document_hash,
    phase: "GREEN",
    max_bytes: maxBytes,
    max_tokens: Math.ceil(maxBytes / 4),
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
        hash: optionalB.hash,
        bytes: optionalB.bytes,
        reason: "budget",
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

  it("rejects an altered stored resource and never exposes absolute paths, secrets, or executable handles", () => {
    const required = resource("references/green.md", "reference", ["GREEN"], null, "green\n");
    const { snapshot, material } = fixture([required]);
    const altered = {
      ...material,
      resources: [{ path: required.path, bytes: Buffer.from("other\n") }],
    };

    expect(() => assembleSkillContext(request(snapshot), altered)).toThrowError(
      new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY"),
    );
    const context = assembleSkillContext(request(snapshot), material);
    expect(JSON.stringify(context)).not.toContain("/private/");
    expect(JSON.stringify(context)).not.toContain("SECRET");
    expect(Object.values(context).some((value) => typeof value === "function")).toBe(false);
  });
});
