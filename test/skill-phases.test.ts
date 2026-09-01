import { describe, expect, it } from "vitest";

import {
  BUILTIN_SUPERPOWERS_HANDLERS,
  BUILTIN_SUPERPOWERS_POLICY,
  BUILTIN_SUPERPOWERS_SEMANTICS,
  compileBuiltInSuperpowersSemantics,
  hashBuiltInPhasePolicy,
  requiredBuiltInPhasePredecessors,
} from "../src/skills/phases.js";

const EXPECTED_PHASES = {
  brainstorming: ["BRAINSTORMING"],
  "test-driven-development": ["TEST_DESIGN", "RED", "GREEN"],
  "systematic-debugging": ["DEBUGGING"],
  "requesting-code-review": ["REVIEW"],
  "verification-before-completion": ["VERIFICATION"],
} as const;

describe("built-in Superpowers phase policy", () => {
  it("maps each audited built-in capability to only its own phases", () => {
    expect(BUILTIN_SUPERPOWERS_POLICY).toEqual(EXPECTED_PHASES);
    expect(Object.isFrozen(BUILTIN_SUPERPOWERS_POLICY)).toBe(true);
    for (const phases of Object.values(BUILTIN_SUPERPOWERS_POLICY)) {
      expect(Object.isFrozen(phases)).toBe(true);
    }
  });

  it("binds each immutable handler identity to one phase and the complete policy", () => {
    expect(BUILTIN_SUPERPOWERS_HANDLERS.map((handler) => handler.phase)).toEqual([
      "BRAINSTORMING",
      "TEST_DESIGN",
      "RED",
      "GREEN",
      "DEBUGGING",
      "REVIEW",
      "VERIFICATION",
    ]);
    expect(new Set(BUILTIN_SUPERPOWERS_HANDLERS.map((handler) => handler.hash))).toHaveLength(7);
    for (const handler of BUILTIN_SUPERPOWERS_HANDLERS) {
      expect(Object.isFrozen(handler)).toBe(true);
      expect(handler.hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(handler.policy_hash).toBe(hashBuiltInPhasePolicy());
    }
  });

  it("changes the policy hash when a caller mutates any mapped phase", () => {
    expect(
      hashBuiltInPhasePolicy({
        ...EXPECTED_PHASES,
        brainstorming: ["RED"],
      }),
    ).not.toBe(hashBuiltInPhasePolicy());
  });

  it("changes handler identity and interpreted ordering when semantic data changes", () => {
    const changed = BUILTIN_SUPERPOWERS_SEMANTICS.map((descriptor) =>
      descriptor.phase === "RED"
        ? { ...descriptor, predecessors: { ...descriptor.predecessors, required: [] } }
        : descriptor,
    );
    const compiled = compileBuiltInSuperpowersSemantics(changed);

    expect(compiled.policy_hash).not.toBe(hashBuiltInPhasePolicy());
    expect(compiled.handlers.find((handler) => handler.phase === "RED")?.hash).not.toBe(
      BUILTIN_SUPERPOWERS_HANDLERS.find((handler) => handler.phase === "RED")?.hash,
    );
    expect(requiredBuiltInPhasePredecessors("RED", [], compiled)).toEqual([]);
  });

  it("derives the closed predecessor graph including requested optional work", () => {
    expect(requiredBuiltInPhasePredecessors("TEST_DESIGN", [])).toEqual([]);
    expect(requiredBuiltInPhasePredecessors("RED", [])).toEqual(["TEST_DESIGN"]);
    expect(requiredBuiltInPhasePredecessors("GREEN", [])).toEqual(["RED"]);
    expect(requiredBuiltInPhasePredecessors("DEBUGGING", [])).toEqual(["RED"]);
    expect(requiredBuiltInPhasePredecessors("REVIEW", [])).toEqual(["GREEN"]);
    expect(requiredBuiltInPhasePredecessors("VERIFICATION", [])).toEqual(["GREEN"]);
    expect(requiredBuiltInPhasePredecessors("VERIFICATION", ["REVIEW", "DEBUGGING"])).toEqual([
      "GREEN",
      "DEBUGGING",
      "REVIEW",
    ]);
  });
});
