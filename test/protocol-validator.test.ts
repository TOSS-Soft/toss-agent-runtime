import { describe, expect, it } from "vitest";

import { createProtocolValidator } from "../src/protocol/validator.js";

const VALID_ARTIFACT_REFERENCE = {
  document_type: "task-contract",
  artifact_id: "TASK-001",
  revision: 1,
  hash: `sha256:${"a".repeat(64)}`,
  location: "project-management/tasks/TASK-001.json",
} as const;

describe("runtime common schema", () => {
  it("accepts and freezes an exact artifact reference", () => {
    const result = createProtocolValidator().validateFragment(
      "artifact-reference",
      VALID_ARTIFACT_REFERENCE,
    );

    expect(result).toMatchObject({ ok: true, value: VALID_ARTIFACT_REFERENCE });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it.each([
    ["an unknown field", { ...VALID_ARTIFACT_REFERENCE, accepted: true }, "additionalProperties"],
    ["revision zero", { ...VALID_ARTIFACT_REFERENCE, revision: 0 }, "minimum"],
    [
      "an uppercase hash",
      { ...VALID_ARTIFACT_REFERENCE, hash: `sha256:${"A".repeat(64)}` },
      "pattern",
    ],
    [
      "an absolute location",
      { ...VALID_ARTIFACT_REFERENCE, location: "/tmp/task.json" },
      "pattern",
    ],
    ["a traversing location", { ...VALID_ARTIFACT_REFERENCE, location: "../task.json" }, "pattern"],
  ])("rejects %s", (_name, value, keyword) => {
    const result = createProtocolValidator().validateFragment("artifact-reference", value);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.keyword === keyword)).toBe(true);
    }
  });

  it("rejects secret-shaped safe metadata keys", () => {
    const result = createProtocolValidator().validateFragment("runtime-error", {
      code: "PROVIDER_UNAVAILABLE",
      category: "unavailable",
      retryable: true,
      safe_message: "Provider unavailable",
      metadata: { api_token: "must-not-persist" },
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.keyword === "propertyNames")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("must-not-persist");
    }
  });

  it("rejects accessors without evaluating them", () => {
    let invoked = false;
    const value = Object.defineProperty({ ...VALID_ARTIFACT_REFERENCE }, "location", {
      enumerable: true,
      get() {
        invoked = true;
        return "task.json";
      },
    });

    const result = createProtocolValidator().validateFragment("artifact-reference", value);
    expect(result).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
    expect(invoked).toBe(false);
  });

  it("sorts validation issues by path, keyword, and message", () => {
    const result = createProtocolValidator().validateFragment("artifact-reference", {
      document_type: "",
      artifact_id: "",
      revision: 0,
      hash: "bad",
      location: "../bad",
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      const order = result.issues.map(
        (issue) => `${issue.path}\u0000${issue.keyword}\u0000${issue.message}`,
      );
      expect(order).toEqual([...order].sort());
    }
  });
});
