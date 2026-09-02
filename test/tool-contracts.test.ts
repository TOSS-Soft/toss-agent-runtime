import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/protocol/json.js";
import {
  hashMcpDiscoverySnapshot,
  hashToolApproval,
  hashToolCall,
  hashToolResult,
  parseMcpDiscoverySnapshot,
  parseToolApproval,
  parseToolCall,
  parseToolResult,
  validateStructuredToolOutput,
  validateToolArguments,
} from "../src/tools/contracts.js";
import {
  validMcpDiscoverySnapshot,
  validMcpProfile,
  validToolApprovalDecision,
  validToolApprovalRequest,
  validToolCall,
  validToolResult,
  withDocumentHash,
} from "./support/tool-fixtures.js";

describe("durable tool documents", () => {
  it.each([
    ["discovery", parseMcpDiscoverySnapshot, validMcpDiscoverySnapshot()],
    ["approval request", parseToolApproval, validToolApprovalRequest()],
    ["approval decision", parseToolApproval, validToolApprovalDecision()],
    ["call", parseToolCall, validToolCall()],
    ["result", parseToolResult, validToolResult()],
  ] as const)("parses, verifies, and freezes %s", (_name, parse, fixture) => {
    const parsed = parse(canonicalJson(fixture));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.isFrozen(parsed.value)).toBe(true);
  });

  it("binds every durable document hash to canonical content", () => {
    const discovery = validMcpDiscoverySnapshot();
    const request = validToolApprovalRequest();
    const decision = validToolApprovalDecision();
    const call = validToolCall();
    const result = validToolResult();

    expect(hashMcpDiscoverySnapshot(discovery)).toBe(discovery.document_hash);
    expect(hashToolApproval(request)).toBe(request.document_hash);
    expect(hashToolApproval(decision)).toBe(decision.document_hash);
    expect(hashToolCall(call)).toBe(call.document_hash);
    expect(hashToolResult(result)).toBe(result.document_hash);
  });

  it("rejects connection authority in discovery snapshots", () => {
    const snapshot = validMcpDiscoverySnapshot();
    const server = snapshot.servers[0]!;
    const parsed = parseMcpDiscoverySnapshot(
      canonicalJson(
        withDocumentHash({
          ...snapshot,
          servers: [{ ...server, endpoint: "https://secret.invalid/mcp" }],
        }),
      ),
    );

    expect(parsed.ok).toBe(false);
  });

  it("rejects raw logical arguments in approval requests", () => {
    const parsed = parseToolApproval(
      canonicalJson(
        withDocumentHash({
          ...validToolApprovalRequest(),
          logical_arguments: { repository: "private" },
        }),
      ),
    );

    expect(parsed.ok).toBe(false);
  });

  it("rejects a PREPARED call that claims a received result", () => {
    const parsed = parseToolCall(
      canonicalJson(
        withDocumentHash({
          ...validToolCall(),
          dispatch_state: "RESULT_RECEIVED",
          result_hash: `sha256:${"9".repeat(64)}`,
        }),
      ),
    );

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some((entry) => entry.keyword === "stage")).toBe(true);
    }
  });

  it("allows only the initial irreversible preparation to await its approval hash", () => {
    const prepared = withDocumentHash({
      ...validToolCall(),
      operation_class: "irreversible" as const,
    });
    const uncertain = withDocumentHash({
      ...prepared,
      stage: "UNCERTAIN" as const,
      dispatch_state: "MAYBE_SENT" as const,
      terminal_at: "2026-09-01T10:01:00.000Z",
      terminal_code: "RUNTIME_TOOL_EFFECT_UNCERTAIN" as const,
    });

    expect(parseToolCall(canonicalJson(prepared))).toMatchObject({ ok: true });
    expect(parseToolCall(canonicalJson(uncertain))).toMatchObject({ ok: false });
  });

  it("rejects result annotations instead of treating them as trust", () => {
    const result = validToolResult();
    const parsed = parseToolResult(
      canonicalJson(
        withDocumentHash({
          ...result,
          content: [{ ...result.content[0]!, annotations: { audience: ["assistant"] } }],
        }),
      ),
    );

    expect(parsed.ok).toBe(false);
  });

  it("requires every result to remain untrusted content", () => {
    const parsed = parseToolResult(
      canonicalJson(withDocumentHash({ ...validToolResult(), trust: "trusted-control" })),
    );

    expect(parsed.ok).toBe(false);
  });

  it("rejects structured output when provenance declares no output schema", () => {
    const result = validToolResult();
    const parsed = parseToolResult(
      canonicalJson(
        withDocumentHash({
          ...result,
          provenance: { ...result.provenance, output_schema_hash: null },
        }),
      ),
    );

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some((entry) => entry.keyword === "structuredOutput")).toBe(true);
    }
  });

  it("validates and freezes logical arguments against the profile schema", () => {
    const schema = validMcpProfile().servers[0]!.tools[0]!.input_schema;

    const valid = validateToolArguments(schema, { query: "runtime" }, 1024);
    const invalid = validateToolArguments(schema, { query: "" }, 1024);

    expect(valid.ok).toBe(true);
    if (valid.ok) expect(Object.isFrozen(valid.value)).toBe(true);
    expect(invalid.ok).toBe(false);
  });

  it("requires an output schema before accepting structured output", () => {
    const value = { count: 2 };
    const schema = validMcpProfile().servers[0]!.tools[0]!.output_schema;

    expect(validateStructuredToolOutput(schema, value, 1024).ok).toBe(true);
    expect(validateStructuredToolOutput(null, value, 1024).ok).toBe(false);
    expect(validateStructuredToolOutput(null, null, 1024).ok).toBe(true);
  });
});
