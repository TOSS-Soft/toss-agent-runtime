import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../src/protocol/json.js";
import { createProtocolValidator } from "../src/protocol/validator.js";
import { hashMcpProfile, parseMcpProfile } from "../src/tools/contracts.js";
import { isRuntimeToolErrorCode, RuntimeToolError } from "../src/tools/errors.js";
import { rehashMcpProfile, validMcpProfile } from "./support/tool-fixtures.js";

function withTool(change: Readonly<Record<string, unknown>>) {
  const profile = validMcpProfile();
  const server = profile.servers[0]!;
  const tool = server.tools[0]!;
  return rehashMcpProfile({
    ...profile,
    servers: [{ ...server, tools: [{ ...tool, ...change }] }],
  });
}

function withInputSchema(input_schema: Readonly<Record<string, unknown>>) {
  return withTool({ input_schema, input_schema_hash: sha256(input_schema) });
}

describe("MCP profile contract", () => {
  it("accepts, verifies, and recursively freezes one canonical profile", () => {
    const parsed = parseMcpProfile(canonicalJson(validMcpProfile()));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(hashMcpProfile(parsed.value)).toBe(parsed.value.document_hash);
      expect(Object.isFrozen(parsed.value)).toBe(true);
      expect(Object.isFrozen(parsed.value.servers)).toBe(true);
      expect(Object.isFrozen(parsed.value.servers[0]?.tools[0]?.input_schema)).toBe(true);
    }
  });

  it("is registered by the generic protocol validator", () => {
    const parsed = createProtocolValidator().parse(canonicalJson(validMcpProfile()), "mcp-profile");

    expect(parsed.ok).toBe(true);
  });

  it("rejects unknown fields", () => {
    const profile = validMcpProfile();
    const parsed = parseMcpProfile(canonicalJson({ ...profile, endpoint: "https://invalid.test" }));

    expect(parsed).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it("rejects a document hash that does not bind canonical content", () => {
    const parsed = parseMcpProfile(
      canonicalJson({ ...validMcpProfile(), document_hash: `sha256:${"f".repeat(64)}` }),
    );

    expect(parsed).toMatchObject({
      ok: false,
    });
    if (!parsed.ok) {
      expect(
        parsed.issues.some(
          (entry) => entry.path === "/document_hash" && entry.keyword === "canonicalHash",
        ),
      ).toBe(true);
    }
  });

  it.each([
    ["read-only", "required"],
    ["irreversible", "not-required"],
  ] as const)("rejects incoherent %s/%s policy", (operation_class, approval) => {
    const parsed = parseMcpProfile(canonicalJson(withTool({ operation_class, approval })));

    expect(parsed).toMatchObject({
      ok: false,
    });
    if (!parsed.ok) {
      expect(
        parsed.issues.some(
          (entry) => entry.path === "/servers/0/tools/0/approval" && entry.keyword === "policy",
        ),
      ).toBe(true);
    }
  });

  it("accepts reversible writes with either explicit approval rule", () => {
    for (const approval of ["required", "not-required"] as const) {
      expect(
        parseMcpProfile(canonicalJson(withTool({ operation_class: "reversible-write", approval })))
          .ok,
      ).toBe(true);
    }
  });

  it("rejects unordered set-like profile fields", () => {
    const profile = validMcpProfile();
    const server = profile.servers[0]!;
    const tool = server.tools[0]!;
    const secondTask = {
      ...tool.task_contracts[0]!,
      artifact_id: "TASK-000",
      hash: `sha256:${"b".repeat(64)}` as const,
    };
    const parsed = parseMcpProfile(
      canonicalJson(
        rehashMcpProfile({
          ...profile,
          servers: [
            {
              ...server,
              tools: [
                {
                  ...tool,
                  allowed_roles: ["worker", "reviewer"],
                  task_contracts: [tool.task_contracts[0]!, secondTask],
                  content_kinds: ["text", "image"],
                  sensitive_output_pointers: ["/z", "/a"],
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(parsed).toMatchObject({
      ok: false,
    });
    if (!parsed.ok) expect(parsed.issues.some((entry) => entry.keyword === "order")).toBe(true);
  });

  it("rejects duplicate aliases across servers", () => {
    const profile = validMcpProfile();
    const first = profile.servers[0]!;
    const duplicate = {
      ...first,
      server_id: "gitlab",
      binding_name: "gitlab",
    };
    const parsed = parseMcpProfile(
      canonicalJson(rehashMcpProfile({ ...profile, servers: [first, duplicate] })),
    );

    expect(parsed).toMatchObject({
      ok: false,
    });
    if (!parsed.ok) {
      expect(
        parsed.issues.some((entry) => entry.path === "/servers" && entry.keyword === "uniqueAlias"),
      ).toBe(true);
    }
  });

  it("rejects live-secret shaped input fields", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { api_key: { type: "string" } },
    };
    const parsed = parseMcpProfile(canonicalJson(withInputSchema(schema)));

    expect(parsed).toMatchObject({
      ok: false,
    });
    if (!parsed.ok) {
      expect(parsed.issues.some((entry) => entry.keyword === "secretField")).toBe(true);
    }
  });

  it.each([
    { $ref: "https://schemas.invalid/tool.json" },
    { $defs: { node: { $ref: "#/$defs/node" } }, $ref: "#/$defs/node" },
  ])("rejects remote and cyclic schema references", (schema) => {
    const parsed = parseMcpProfile(canonicalJson(withInputSchema(schema)));

    expect(parsed).toMatchObject({
      ok: false,
    });
    if (!parsed.ok) {
      expect(parsed.issues.some((entry) => entry.keyword === "schemaReference")).toBe(true);
    }
  });

  it("rejects schema hashes that do not match canonical schema bytes", () => {
    const parsed = parseMcpProfile(
      canonicalJson(withTool({ input_schema_hash: `sha256:${"f".repeat(64)}` })),
    );

    expect(parsed).toMatchObject({
      ok: false,
    });
    if (!parsed.ok) {
      expect(
        parsed.issues.some((entry) => entry.path === "/servers/0/tools/0/input_schema_hash"),
      ).toBe(true);
    }
  });

  it("rejects 2025 protocol header mappings", () => {
    const profile = validMcpProfile();
    const server = profile.servers[0]!;
    const parsed = parseMcpProfile(
      canonicalJson(
        rehashMcpProfile({
          ...profile,
          servers: [{ ...server, x_mcp_headers: { "x-mcp-query": "/query" } }],
        }),
      ),
    );

    expect(parsed).toMatchObject({
      ok: false,
    });
    if (!parsed.ok) {
      expect(
        parsed.issues.some(
          (entry) => entry.path === "/servers/0/x_mcp_headers" && entry.keyword === "protocol",
        ),
      ).toBe(true);
    }
  });

  it("accepts a bounded 2026 header-to-input mapping", () => {
    const profile = validMcpProfile();
    const server = profile.servers[0]!;
    const parsed = parseMcpProfile(
      canonicalJson(
        rehashMcpProfile({
          ...profile,
          servers: [
            {
              ...server,
              protocol_revision: "2026-07-28",
              x_mcp_headers: { "x-mcp-query": "/query" },
            },
          ],
        }),
      ),
    );

    expect(parsed.ok).toBe(true);
  });
});

describe("tool errors", () => {
  it("exposes only the fixed safe descriptor for authentication failure", () => {
    const error = new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");

    expect(error).toMatchObject({
      code: "RUNTIME_TOOL_AUTHENTICATION",
      category: "authentication",
      retryable: false,
      safe_message: "Tool authentication failed",
    });
    expect(isRuntimeToolErrorCode(error.code)).toBe(true);
    expect(isRuntimeToolErrorCode("native ECONNREFUSED token=secret")).toBe(false);
  });
});
