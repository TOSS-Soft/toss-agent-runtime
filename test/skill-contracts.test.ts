import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../src/protocol/json.js";
import {
  parseSkillDescriptor,
  parseSkillExecutionEvidence,
  parseSkillSnapshot,
  parseSuperpowersApproval,
  parseSuperpowersPhase,
} from "../src/skills/contracts.js";
import {
  validSkillDescriptor,
  validSkillExecutionEvidence,
  validSkillSnapshot,
  validSuperpowersApproval,
  validSuperpowersApprovalDecision,
  validSuperpowersPhase,
} from "./support/skill-fixtures.js";

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function resignDocument<T extends Record<string, unknown>>(value: T): T {
  const hashable = { ...value };
  delete hashable.document_hash;
  return { ...hashable, document_hash: sha256(hashable) };
}

describe("skill runtime contracts", () => {
  it.each([
    ["descriptor", parseSkillDescriptor, validSkillDescriptor()],
    ["snapshot", parseSkillSnapshot, validSkillSnapshot()],
    ["phase", parseSuperpowersPhase, validSuperpowersPhase()],
    ["approval", parseSuperpowersApproval, validSuperpowersApproval()],
    ["evidence", parseSkillExecutionEvidence, validSkillExecutionEvidence()],
  ])("parses and recursively freezes canonical %s documents", (_name, parse, fixture) => {
    const parsed = parse(canonicalJson(fixture));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expectDeepFrozen(parsed.value);
  });

  it.each([
    ["descriptor", parseSkillDescriptor, validSkillDescriptor()],
    ["snapshot", parseSkillSnapshot, validSkillSnapshot()],
    ["phase", parseSuperpowersPhase, validSuperpowersPhase()],
    ["approval", parseSuperpowersApproval, validSuperpowersApproval()],
    ["evidence", parseSkillExecutionEvidence, validSkillExecutionEvidence()],
  ])("rejects unknown keys in %s documents", (_name, parse, fixture) => {
    expect(parse(canonicalJson({ ...fixture, internal_hook: true }))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });

  it("rejects a snapshot with duplicate or non-ASCII ordered resources", () => {
    const fixture = validSkillSnapshot();
    const duplicate = {
      ...fixture,
      resources: [fixture.resources[0], fixture.resources[0]],
    };
    expect(parseSkillSnapshot(canonicalJson(duplicate))).toMatchObject({ ok: false });

    const unordered = {
      ...fixture,
      resources: [
        { ...fixture.resources[0], path: "z.md" },
        { ...fixture.resources[0], path: "A.md" },
      ],
    };
    expect(parseSkillSnapshot(canonicalJson(unordered))).toMatchObject({ ok: false });
  });

  it.each([
    ["duplicate phases", { phases: ["GREEN", "GREEN"] }],
    ["noncanonical phases", { phases: ["GREEN", "DEBUGGING"] }],
    ["empty reference phases", { phases: [] }],
    ["out-of-range reference priority", { priority: 256 }],
    ["asset phase policy", { role: "asset", phases: ["GREEN"], priority: null }],
    ["script priority policy", { role: "script", phases: [], priority: 0 }],
  ])("rejects %s resource policy", (_name, mutation) => {
    const fixture = validSkillSnapshot();
    expect(
      parseSkillSnapshot(
        canonicalJson({
          ...fixture,
          resources: [{ ...fixture.resources[0], ...mutation }],
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects uppercase hashes and bad document hashes", () => {
    const fixture = validSkillDescriptor();
    expect(
      parseSkillDescriptor(canonicalJson({ ...fixture, package_hash: `sha256:${"A".repeat(64)}` })),
    ).toMatchObject({ ok: false });
    expect(
      parseSkillDescriptor(
        canonicalJson({ ...fixture, document_hash: `sha256:${"f".repeat(64)}` }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects phases with status/output combinations that cannot occur", () => {
    const fixture = validSuperpowersPhase();
    expect(
      parseSuperpowersPhase(
        canonicalJson({ ...fixture, status: "STARTED", output_hash: fixture.output_hash }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseSuperpowersPhase(canonicalJson({ ...fixture, status: "COMPLETED", output_hash: null })),
    ).toMatchObject({ ok: false });
  });

  it("rejects a snapshot with inconsistent package accounting", () => {
    const fixture = validSkillSnapshot();
    expect(
      parseSkillSnapshot(canonicalJson({ ...fixture, total_bytes: fixture.total_bytes + 1 })),
    ).toMatchObject({ ok: false });
  });

  it.each(["approval_request_hash", "operation_id"] as const)(
    "rejects re-signed REQUEST documents with unbound %s",
    (field) => {
      const fixture = validSuperpowersApproval();
      const mutated = resignDocument({ ...fixture, [field]: fixture.phase_document_hash });
      expect(parseSuperpowersApproval(canonicalJson(mutated))).toMatchObject({ ok: false });
    },
  );

  it("parses a closed approval decision", () => {
    expect(
      parseSuperpowersApproval(canonicalJson(validSuperpowersApprovalDecision())),
    ).toMatchObject({
      ok: true,
      value: { kind: "DECISION", decision: "APPROVE" },
    });
  });

  it("rejects evidence with duplicate resource and phase hashes", () => {
    const fixture = validSkillExecutionEvidence();
    expect(
      parseSkillExecutionEvidence(
        canonicalJson({
          ...fixture,
          resource_hashes: [fixture.resource_hashes[0], fixture.resource_hashes[0]],
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseSkillExecutionEvidence(
        canonicalJson({ ...fixture, phases: [fixture.phases[0], fixture.phases[0]] }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects an approval whose skill identity changed without a new document hash", () => {
    const original = validSuperpowersApproval();
    const mutated = {
      ...original,
      skill_snapshot_hash: `sha256:${"f".repeat(64)}`,
    };
    expect(parseSuperpowersApproval(canonicalJson(mutated))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });
});
