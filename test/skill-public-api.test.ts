import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import * as rootApi from "../src/index.js";
import * as skillApi from "../src/skills/index.js";
import type {
  CompleteSuperpowersPhaseRequest,
  HashableSkillDescriptorV1,
  HashableSkillExecutionEvidenceV1,
  HashableSkillSnapshotV1,
  HashableSuperpowersApprovalV1,
  HashableSuperpowersPhaseV1,
  ResumeSuperpowersApprovalRequest,
  RuntimeSkillErrorCode,
  SkillCatalogSnapshot,
  SkillContext,
  SkillContextRequest,
  SkillContextSegment,
  SkillContextTruncation,
  SkillDescriptorReference,
  SkillDescriptorV1,
  SkillDiscoveryRequest,
  SkillExecutionEvidenceV1,
  SkillHostContextRequest,
  SkillResourceRole,
  SkillResourceV1,
  SkillSelection,
  SkillSelectionRequest,
  SkillsHost,
  SkillsHostConfig,
  SkillSnapshotV1,
  SkillSourceKind,
  StartSuperpowersPhaseRequest,
  SuperpowersApprovalDecisionV1,
  SuperpowersApprovalRequestV1,
  SuperpowersApprovalV1,
  SuperpowersPhaseName,
  SuperpowersPhaseOutcome,
  SuperpowersPhaseStatus,
  SuperpowersPhaseV1,
} from "../src/index.js";

const roots: string[] = [];
const PUBLIC_SKILL_VALUES = [
  "RuntimeSkillError",
  "SKILL_LIMITS",
  "createSkillsHost",
  "hashSkillCatalog",
  "hashSkillDescriptor",
  "hashSkillExecutionEvidence",
  "hashSkillPackage",
  "hashSkillSnapshot",
  "hashSuperpowersApproval",
  "hashSuperpowersPhase",
  "parseSkillDescriptor",
  "parseSkillExecutionEvidence",
  "parseSkillSnapshot",
  "parseSuperpowersApproval",
  "parseSuperpowersPhase",
] as const;
const PRIVATE_SKILL_NAMES = [
  "BUNDLED_MANIFEST_PATH",
  "CatalogTestHooks",
  "CreateSkillPrivateStoreOptions",
  "PhaseHistoryOperationHooks",
  "SkillContextMaterial",
  "auditBundledSkills",
  "bundledSkillsRoot",
  "createSkillCatalog",
  "createSkillCatalogForTest",
  "createSkillEvidenceBuilder",
  "createSkillLoader",
  "createSkillPrivateStore",
  "createSkillsEngine",
  "createSkillsEngineForTest",
  "requireSkillsHost",
  "resolveSkillSelectionForLoader",
] as const;

type PublicSkillTypeSurface = readonly [
  CompleteSuperpowersPhaseRequest,
  HashableSkillDescriptorV1,
  HashableSkillExecutionEvidenceV1,
  HashableSkillSnapshotV1,
  HashableSuperpowersApprovalV1,
  HashableSuperpowersPhaseV1,
  ResumeSuperpowersApprovalRequest,
  RuntimeSkillErrorCode,
  SkillCatalogSnapshot,
  SkillContext,
  SkillContextRequest,
  SkillContextSegment,
  SkillContextTruncation,
  SkillDescriptorReference,
  SkillDescriptorV1,
  SkillDiscoveryRequest,
  SkillExecutionEvidenceV1,
  SkillHostContextRequest,
  SkillResourceRole,
  SkillResourceV1,
  SkillSelection,
  SkillSelectionRequest,
  SkillsHost,
  SkillsHostConfig,
  SkillSnapshotV1,
  SkillSourceKind,
  StartSuperpowersPhaseRequest,
  SuperpowersApprovalDecisionV1,
  SuperpowersApprovalRequestV1,
  SuperpowersApprovalV1,
  SuperpowersPhaseName,
  SuperpowersPhaseOutcome,
  SuperpowersPhaseStatus,
  SuperpowersPhaseV1,
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent Skills public API", () => {
  it("publishes only the safe host, contracts, hashes, error, and immutable constants", () => {
    expect(Object.keys(skillApi).sort()).toEqual([...PUBLIC_SKILL_VALUES].sort());
    for (const name of PUBLIC_SKILL_VALUES) {
      expect(rootApi[name]).toBe(skillApi[name]);
    }
    expect(Object.isFrozen(skillApi.SKILL_LIMITS)).toBe(true);
  });

  it("publishes the immutable skill domain type surface", () => {
    expectTypeOf<PublicSkillTypeSurface>().toMatchTypeOf<readonly unknown[]>();
  });

  it("keeps paths, stored bytes, hooks, test seams, and private factories absent", () => {
    for (const privateName of PRIVATE_SKILL_NAMES) {
      expect(rootApi).not.toHaveProperty(privateName);
      expect(skillApi).not.toHaveProperty(privateName);
    }
  });

  it("keeps private skill modules blocked by the package export boundary", () => {
    expect(() => import.meta.resolve("@toss-software/agent-runtime/skills/private-store")).toThrow(
      expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
    );
    expect(() => import.meta.resolve("@toss-software/agent-runtime/src/skills/engine.js")).toThrow(
      expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
    );
  });

  it("creates a self-contained host without exposing native paths or test seams", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-skills-public-")));
    roots.push(root);
    const statePath = path.join(root, "state");
    const config: SkillsHostConfig = Object.freeze({
      state_path: statePath,
      socket_path: path.join(root, "runtime.sock"),
      skill_roots: Object.freeze([]),
    });
    const host = rootApi.createSkillsHost(config);

    expect(Object.keys(host).sort()).toEqual([
      "assembleContext",
      "completePhase",
      "discover",
      "evidence",
      "flush",
      "load",
      "recover",
      "resumeApproval",
      "select",
      "startPhase",
      "stopIntake",
    ]);
    expect(JSON.stringify(host)).not.toContain(root);
    const catalog = await host.discover({ query: null, allowed_capabilities: ["brainstorming"] });
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.descriptors)).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain(root);
  });

  it("emits public declarations without private skill hooks, native paths, or body stores", () => {
    const declarationRoot = mkdtempSync(path.join(tmpdir(), "toss-skill-public-api-"));
    try {
      execFileSync(
        process.execPath,
        [
          "node_modules/typescript/bin/tsc",
          "-p",
          "tsconfig.build.json",
          "--emitDeclarationOnly",
          "--declarationMap",
          "false",
          "--outDir",
          declarationRoot,
        ],
        { cwd: process.cwd(), stdio: "pipe" },
      );
      const skillsDeclaration = readFileSync(
        path.join(declarationRoot, "src/skills/index.d.ts"),
        "utf8",
      );
      const publicDeclarations = [
        readFileSync(path.join(declarationRoot, "src/index.d.ts"), "utf8"),
        skillsDeclaration,
      ].join("\n");
      for (const privateName of PRIVATE_SKILL_NAMES) {
        expect(publicDeclarations).not.toContain(privateName);
      }
      expect(publicDeclarations).not.toMatch(
        /absoluteDirectory|absolutePath|manifestPath|skill_markdown_base64/u,
      );
      expect(skillsDeclaration).toMatch(
        /createSkillsHost\(config: SkillsHostConfig\): SkillsHost/u,
      );
      expect(skillsDeclaration).not.toMatch(
        /RunJournalStore|hasServiceListener|randomId|readonly now|operationHooks|ForTest/u,
      );
    } finally {
      rmSync(declarationRoot, { recursive: true, force: true });
    }
  });
});
