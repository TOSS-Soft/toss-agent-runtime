import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/protocol/json.js";
import {
  hashExecutionRequest,
  parseExecutionRequest,
  type ExecutionRequestV1,
} from "../src/protocol/request.js";

const VALID_PATH = "test/fixtures/protocol/valid/execution-request.v1.json";

async function validRequest(): Promise<ExecutionRequestV1> {
  const result = parseExecutionRequest(await readFile(VALID_PATH));
  if (!result.ok) {
    throw new Error(`Valid request fixture was rejected: ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

describe("execution-request.v1", () => {
  it("accepts, freezes, and hashes the complete request", async () => {
    const result = parseExecutionRequest(await readFile(VALID_PATH));

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.task_contract)).toBe(true);
      expect(hashExecutionRequest(result.value)).toBe(
        "sha256:70d377068f5fe9a7031876978a1092aee6b8548b2dc35a300eb79475e7734f37",
      );
    }
  });

  it.each(["request-authority.json", "request-secret.json"])(
    "rejects forbidden persisted fields in %s without echoing values",
    async (name) => {
      const input = await readFile(`test/fixtures/protocol/invalid/${name}`);
      const result = parseExecutionRequest(input);
      expect(result).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
      expect(JSON.stringify(result)).not.toContain("must-not-persist");
    },
  );

  it("rejects deadlines that do not follow creation", async () => {
    const request = await validRequest();
    const result = parseExecutionRequest(
      canonicalJson({ ...request, deadline: "2026-08-18T23:59:59.000Z" }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "/deadline",
        keyword: "afterCreatedAt",
        message: "must be later than created_at",
      });
    }
  });

  it("rejects duplicate artifact identities across canonical inputs", async () => {
    const request = await validRequest();
    const duplicate = { ...request.task_contract };
    const result = parseExecutionRequest(
      canonicalJson({ ...request, input_artifacts: [duplicate] }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.keyword === "uniqueArtifactRevision")).toBe(true);
    }
  });

  it.each([
    [
      "unsupported protocol",
      (request: ExecutionRequestV1) => ({ ...request, protocol_version: "runtime-contract.v2" }),
    ],
    [
      "duplicate capability",
      (request: ExecutionRequestV1) => ({
        ...request,
        model: { ...request.model, required_capabilities: ["tools", "tools"] },
      }),
    ],
    [
      "zero budget",
      (request: ExecutionRequestV1) => ({
        ...request,
        budget: { ...request.budget, max_turns: 0 },
      }),
    ],
    [
      "wrong task type",
      (request: ExecutionRequestV1) => ({
        ...request,
        task_contract: { ...request.task_contract, document_type: "pm-analysis" },
      }),
    ],
  ])("rejects %s", async (_name, mutate) => {
    const result = parseExecutionRequest(canonicalJson(mutate(await validRequest())));
    expect(result).toMatchObject({ ok: false });
  });
});
