import { readFile } from "node:fs/promises";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  RuntimeToolError,
  createRuntimeCapabilities,
  createToolBroker,
  hashMcpDiscoverySnapshot,
  hashMcpProfile,
  hashToolApproval,
  hashToolCall,
  hashToolResult,
  parseMcpDiscoverySnapshot,
  parseMcpProfile,
  parseToolApproval,
  parseToolCall,
  parseToolResult,
  type ToolBroker,
  type ToolProfileHealth,
} from "../src/index.js";
import { validMcpProfile } from "./support/tool-fixtures.js";

const platform = { os: "darwin" as const, arch: "arm64", node: "24.8.0" };

describe("public scoped MCP broker API", () => {
  it("exports only the stable TOSS-owned broker and contract surface", () => {
    expect(createToolBroker).toBeTypeOf("function");
    expect(createRuntimeCapabilities).toBeTypeOf("function");
    expect(hashMcpProfile).toBeTypeOf("function");
    expect(hashMcpDiscoverySnapshot).toBeTypeOf("function");
    expect(hashToolApproval).toBeTypeOf("function");
    expect(hashToolCall).toBeTypeOf("function");
    expect(hashToolResult).toBeTypeOf("function");
    expect(parseMcpProfile).toBeTypeOf("function");
    expect(parseMcpDiscoverySnapshot).toBeTypeOf("function");
    expect(parseToolApproval).toBeTypeOf("function");
    expect(parseToolCall).toBeTypeOf("function");
    expect(parseToolResult).toBeTypeOf("function");
    expect(new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE")).toMatchObject({
      category: "unavailable",
      retryable: true,
    });
    expectTypeOf<ToolBroker["health"]>().returns.toEqualTypeOf<readonly ToolProfileHealth[]>();
  });

  it("projects unavailable, blocked, ready, and mixed profile readiness truthfully", () => {
    const first = validMcpProfile();
    const second = {
      ...first,
      profile_id: "engineering-secondary",
      document_hash: `sha256:${"9".repeat(64)}` as const,
    };
    const firstReference = {
      document_type: "mcp-profile",
      artifact_id: first.profile_id,
      revision: first.revision,
      hash: first.document_hash,
    } as const;
    const secondReference = {
      document_type: "mcp-profile",
      artifact_id: second.profile_id,
      revision: second.revision,
      hash: second.document_hash,
    } as const;

    expect(createRuntimeCapabilities(platform).features.mcp).toBe("unavailable");
    const blocked = createRuntimeCapabilities(platform, [
      { profile: firstReference, transports: ["stdio"], ready: false },
    ]);
    expect(blocked.features.mcp).toBe("blocked");
    expect(blocked.mcp_profiles).toEqual([]);
    expect(blocked.mcp_transports).toEqual([]);

    const mixed = createRuntimeCapabilities(platform, [
      { profile: secondReference, transports: ["streamable-http"], ready: false },
      { profile: firstReference, transports: ["stdio", "agentgateway"], ready: true },
    ]);
    expect(mixed.features.mcp).toBe("available");
    expect(mixed.mcp_profiles).toEqual([firstReference]);
    expect(mixed.mcp_transports).toEqual(["agentgateway", "stdio"]);
    expect(Object.isFrozen(mixed.mcp_profiles)).toBe(true);
  });

  it("keeps SDK and private-store names out of emitted public entry declarations", async () => {
    const declarations = [
      await readFile("dist/src/index.d.ts", "utf8"),
      await readFile("dist/src/tools/index.d.ts", "utf8"),
    ].join("\n");

    for (const forbidden of [
      "@modelcontextprotocol",
      "ToolPrivateStore",
      "ToolSdkClient",
      "NativeToolCallResult",
    ]) {
      expect(declarations).not.toContain(forbidden);
    }
  });
});
