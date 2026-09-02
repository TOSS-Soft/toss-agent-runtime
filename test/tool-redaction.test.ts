import { describe, expect, it } from "vitest";

import type { EffectiveAgentAuthority } from "../src/agents/authority.js";
import { sha256 } from "../src/protocol/json.js";
import type { ToolSession } from "../src/tools/discovery.js";
import { authorizeToolCall } from "../src/tools/policy.js";
import {
  normalizeToolResult,
  redactGenericSecrets,
  redactJsonPointers,
} from "../src/tools/redaction.js";
import type { NativeToolCallResult } from "../src/tools/transports/types.js";
import type {
  McpDiscoverySnapshotV1,
  McpProfileToolRuleV1,
  McpProfileV1,
} from "../src/tools/types.js";
import { rehashMcpProfile, validMcpProfile, withDocumentHash } from "./support/tool-fixtures.js";

const EXECUTION_HASH = `sha256:${"8".repeat(64)}` as const;
const TRACE = {
  trace_id: "1".repeat(32),
  span_id: "2".repeat(16),
  trace_flags: 1,
} as const;

function richProfile(
  overrides: Partial<McpProfileToolRuleV1> = {},
  limitOverrides: Partial<McpProfileV1["limits"]> = {},
): McpProfileV1 {
  const base = validMcpProfile();
  const tool = base.servers[0]!.tools[0]!;
  const outputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["count"],
    properties: {
      count: { type: "integer", minimum: 0 },
      credentials: {
        type: "object",
        additionalProperties: true,
      },
      "a/b": {
        type: "object",
        additionalProperties: true,
      },
      note: { type: "string" },
    },
  } as const;
  return rehashMcpProfile({
    ...base,
    limits: { ...base.limits, ...limitOverrides },
    servers: [
      {
        ...base.servers[0]!,
        tools: [
          {
            ...tool,
            output_schema: outputSchema,
            output_schema_hash: sha256(outputSchema),
            content_kinds: [
              "audio",
              "embedded-resource",
              "image",
              "resource-link",
              "text",
            ] as const,
            sensitive_output_pointers: ["/a~1b/tilde~0key", "/credentials/access_token"] as const,
            ...overrides,
          },
        ],
      },
    ],
  });
}

function discovery(profile: McpProfileV1): McpDiscoverySnapshotV1 {
  const server = profile.servers[0]!;
  const tool = server.tools[0]!;
  return withDocumentHash({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "mcp-discovery-snapshot.v1" as const,
    document_type: "mcp-discovery-snapshot" as const,
    run_id: "run-1",
    session_id: "session-1",
    execution_request_hash: EXECUTION_HASH,
    profile: {
      document_type: "mcp-profile" as const,
      artifact_id: profile.profile_id,
      revision: profile.revision,
      hash: profile.document_hash,
    },
    created_at: "2026-09-01T10:00:00.000Z",
    expires_at: "2026-09-01T10:05:00.000Z",
    stale: false,
    servers: [
      {
        server_id: server.server_id,
        binding_name: server.binding_name,
        transport: "stdio" as const,
        protocol_revision: server.protocol_revision,
        server: {
          name: "github-mcp",
          version: "1.2.3",
          identity_hash: sha256({
            name: "github-mcp",
            protocol_revision: server.protocol_revision,
            version: "1.2.3",
          }),
        },
        tools: [
          {
            alias: tool.alias,
            native_name: tool.native_name,
            input_schema_hash: tool.input_schema_hash,
            output_schema_hash: tool.output_schema_hash,
            operation_class: tool.operation_class,
            annotations: {
              read_only_hint: true,
              destructive_hint: false,
              idempotent_hint: true,
              open_world_hint: false,
            },
          },
        ],
      },
    ],
  });
}

function sessionFor(value: McpDiscoverySnapshotV1): ToolSession {
  return Object.freeze({
    run_id: value.run_id,
    session_id: value.session_id,
    profile: value.profile,
    discover: () => Promise.reject(new Error("not used")),
    snapshot: () => value,
    connection: () => {
      throw new Error("not used");
    },
    markListChanged: () => undefined,
    close: () => Promise.resolve(),
  });
}

function authorized(profile: McpProfileV1 = richProfile()) {
  const snapshot = discovery(profile);
  const tool = profile.servers[0]!.tools[0]!;
  const profileReference = snapshot.profile;
  const authority: EffectiveAgentAuthority = {
    definition: {
      document_type: "agent-definition",
      artifact_id: "worker-agent",
      revision: 1,
      hash: `sha256:${"b".repeat(64)}`,
    },
    role: "worker",
    task_contract: tool.task_contracts[0]!,
    logical_class: "balanced-code",
    model_capabilities: ["text", "tools"],
    superpowers_capabilities: [],
    mcp_profile: profileReference,
    budget: {
      max_input_tokens: 10_000,
      max_output_tokens: 2_000,
      max_cost_microusd: 1_000_000,
      max_duration_ms: 300_000,
      max_turns: 8,
    },
    output_schema: {
      document_type: "output-schema",
      artifact_id: "worker-output",
      revision: 1,
      hash: `sha256:${"c".repeat(64)}`,
    },
  };
  return authorizeToolCall({
    run_id: snapshot.run_id,
    execution_request_hash: snapshot.execution_request_hash,
    authority,
    profile,
    session: sessionFor(snapshot),
    discovery_snapshot: snapshot,
    now: new Date("2026-09-01T10:01:00.000Z"),
    trace: TRACE,
    request: {
      alias: tool.alias,
      logical_call_id: "model-call-1",
      arguments: { query: "runtime" },
      caller_meta: null,
    },
  });
}

function normalize(result: NativeToolCallResult, profile = richProfile()) {
  const call = authorized(profile);
  return normalizeToolResult({
    call,
    observation: {
      name: "github-mcp",
      version: "1.2.3",
      identity_hash: call.server_identity_hash,
      protocol_revision: call.protocol_revision,
      transport: call.transport,
    },
    result,
  });
}

describe("bounded MCP result normalization", () => {
  it("normalizes all five supported content kinds and drops annotations", () => {
    const result = normalize({
      content: [
        { type: "text", text: "safe text", annotations: { priority: 1 } },
        { type: "image", media_type: "image/png", data_base64: "aW1hZ2U=" },
        { type: "audio", media_type: "audio/wav", data_base64: "YXVkaW8=" },
        {
          type: "resource-link",
          uri: "https://example.test/resource",
          name: "resource",
          mime_type: "text/plain",
        },
        {
          type: "embedded-resource",
          uri: "memory://result",
          mime_type: "text/plain",
          text: "embedded",
          blob_base64: null,
          annotations: { audience: ["assistant"] },
        },
      ] as unknown as NativeToolCallResult["content"],
      structured_content: { count: 2 },
      is_error: false,
    });

    expect(result.status).toBe("success");
    expect(result.trust).toBe("untrusted-content");
    expect(result.content).toEqual([
      { type: "text", text: "safe text" },
      { type: "image", media_type: "image/png", data_base64: "aW1hZ2U=" },
      { type: "audio", media_type: "audio/wav", data_base64: "YXVkaW8=" },
      {
        type: "resource-link",
        uri: "https://example.test/resource",
        name: "resource",
        mime_type: "text/plain",
      },
      {
        type: "embedded-resource",
        uri: "memory://result",
        mime_type: "text/plain",
        text: "embedded",
        blob_base64: null,
      },
    ]);
    expect(result.accounting).toEqual({
      content_blocks: 5,
      total_bytes: 99,
      structured_bytes: 11,
    });
    expect(result.error).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("validates structured output before pointer and generic redaction", () => {
    const result = normalize({
      content: [
        {
          type: "text",
          text: "Authorization: Bearer abc.def-123 and api_key=plain-secret",
        },
      ],
      structured_content: {
        count: 1,
        credentials: { access_token: "structural-secret", password: "generic-secret" },
        "a/b": { "tilde~key": "escaped-pointer-secret" },
        note: "Bearer another.secret-value",
      },
      is_error: false,
    });

    expect(result.content[0]).toEqual({
      type: "text",
      text: "Authorization: [REDACTED] and api_key=[REDACTED]",
    });
    expect(result.structured_content).toEqual({
      count: 1,
      credentials: "[REDACTED]",
      "a/b": { "tilde~key": "[REDACTED]" },
      note: "Bearer [REDACTED]",
    });
  });

  it("exports deterministic structural and generic redaction helpers", () => {
    const value = {
      nested: { "a/b": { "~token": "secret" }, apiKey: "another" },
      text: "token=visible-before-redaction",
    } as const;
    expect(redactJsonPointers(value, ["/nested/a~1b/~0token"])).toEqual({
      nested: { "a/b": { "~token": "[REDACTED]" }, apiKey: "another" },
      text: "token=visible-before-redaction",
    });
    expect(redactGenericSecrets(value)).toEqual({
      nested: { "a/b": { "~token": "secret" }, apiKey: "[REDACTED]" },
      text: "token=[REDACTED]",
    });
  });

  it.each(["count", "block", "total", "structured"] as const)(
    "rejects %s result ceiling violations",
    (ceiling) => {
      const profile = richProfile(
        {},
        ceiling === "count"
          ? { content_blocks: 1 }
          : ceiling === "block"
            ? { content_block_bytes: 4 }
            : ceiling === "total"
              ? { result_bytes: 8, content_block_bytes: 8, structured_output_bytes: 8 }
              : { structured_output_bytes: 8 },
      );
      const content =
        ceiling === "count"
          ? ([
              { type: "text", text: "one" },
              { type: "text", text: "two" },
            ] as const)
          : ([{ type: "text", text: "123456789" }] as const);
      const structured = ceiling === "structured" ? { count: 123_456 } : null;

      expect(() =>
        normalize({ content, structured_content: structured, is_error: false }, profile),
      ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_RESULT_INVALID" }));
    },
  );

  it("applies the total ceiling before secret redaction can shrink native content", () => {
    const profile = richProfile(
      {},
      {
        result_bytes: 32,
        content_blocks: 2,
        content_block_bytes: 32,
        structured_output_bytes: 16,
      },
    );
    expect(() =>
      normalize(
        {
          content: [
            { type: "text", text: "token=first-secret-value" },
            { type: "text", text: "token=second-secret-value" },
          ],
          structured_content: null,
          is_error: false,
        },
        profile,
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_RESULT_INVALID" }));
  });

  it.each(["invalid padding", "not-base64!", "a===", "abcd="])(
    "rejects non-canonical base64 %s",
    (data) => {
      expect(() =>
        normalize({
          content: [{ type: "image", media_type: "image/png", data_base64: data }],
          structured_content: null,
          is_error: false,
        }),
      ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_RESULT_INVALID" }));
    },
  );

  it("rejects embedded resources with missing media type or ambiguous bodies", () => {
    for (const content of [
      {
        type: "embedded-resource",
        uri: "memory://result",
        mime_type: null,
        text: "value",
        blob_base64: null,
      },
      {
        type: "embedded-resource",
        uri: "memory://result",
        mime_type: "text/plain",
        text: "value",
        blob_base64: "dmFsdWU=",
      },
    ]) {
      expect(() =>
        normalize({
          content: [content] as NativeToolCallResult["content"],
          structured_content: null,
          is_error: false,
        }),
      ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_RESULT_INVALID" }));
    }
  });

  it("rejects structured schema mismatch and undeclared structured output", () => {
    expect(() =>
      normalize({ content: [], structured_content: { count: -1 }, is_error: false }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_SCHEMA_MISMATCH" }));

    const profile = richProfile({
      output_schema: null,
      output_schema_hash: null,
      sensitive_output_pointers: [],
    });
    expect(() =>
      normalize({ content: [], structured_content: { count: 1 }, is_error: false }, profile),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_SCHEMA_MISMATCH" }));
  });

  it("returns only a stable safe error for native tool failures", () => {
    const result = normalize({
      content: [{ type: "text", text: "password=server-secret" }],
      structured_content: null,
      is_error: true,
    });

    expect(result).toMatchObject({
      status: "error",
      is_error: true,
      content: [{ type: "text", text: "password=[REDACTED]" }],
      error: {
        code: "RUNTIME_TOOL_INTERNAL",
        category: "internal",
        retryable: false,
        safe_message: "Tool operation failed",
      },
    });
    expect(JSON.stringify(result)).not.toContain("server-secret");
  });

  it("rejects malformed, partial, disallowed, and identity-conflicting results", () => {
    const call = authorized();
    const observation = {
      name: "github-mcp",
      version: "1.2.3",
      identity_hash: call.server_identity_hash,
      protocol_revision: call.protocol_revision,
      transport: call.transport,
    };
    const malformed: readonly unknown[] = [
      null,
      { content: [], structured_content: null },
      { content: [{ type: "video", data: "x" }], structured_content: null, is_error: false },
      {
        content: [{ type: "text", text: "ok" }],
        structured_content: null,
        is_error: false,
        raw_output: "must-not-survive",
      },
    ];
    for (const result of malformed) {
      expect(() =>
        normalizeToolResult({
          call,
          observation,
          result: result as NativeToolCallResult,
        }),
      ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_RESULT_INVALID" }));
    }

    expect(() =>
      normalizeToolResult({
        call,
        observation: { ...observation, identity_hash: `sha256:${"9".repeat(64)}` },
        result: { content: [], structured_content: null, is_error: false },
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_PROTOCOL_DOWNGRADE" }));

    const textOnly = richProfile({ content_kinds: ["text"] });
    expect(() =>
      normalize(
        {
          content: [{ type: "image", media_type: "image/png", data_base64: "aW1hZ2U=" }],
          structured_content: null,
          is_error: false,
        },
        textOnly,
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_RESULT_INVALID" }));
  });

  it("does not retain raw arguments, native output, or annotations in safe metadata", () => {
    const result = normalize({
      content: [{ type: "text", text: "token=private-native-output" }],
      structured_content: { count: 1 },
      is_error: false,
    });
    const serialized = JSON.stringify({
      provenance: result.provenance,
      accounting: result.accounting,
      error: result.error,
    });

    expect(serialized).not.toContain("runtime");
    expect(serialized).not.toContain("private-native-output");
    expect(serialized).not.toContain("annotations");
  });
});
