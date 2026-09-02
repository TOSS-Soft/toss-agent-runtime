import { describe, expect, it } from "vitest";

import { defaultConfig } from "../src/config/load.js";
import type { RuntimeConfigV1 } from "../src/config/types.js";
import { createMcpProfileRegistry } from "../src/tools/profile.js";
import type { McpProfileV1 } from "../src/tools/types.js";
import { rehashMcpProfile, validMcpProfile } from "./support/tool-fixtures.js";

function configuredRuntime(mutate?: (profile: McpProfileV1) => McpProfileV1): RuntimeConfigV1 {
  const base = defaultConfig("darwin", "/Users/test");
  const original: McpProfileV1 = validMcpProfile();
  const profile = mutate?.(original) ?? original;
  return {
    ...base,
    mcp_profiles: {
      [profile.profile_id]: {
        profile,
        servers: {
          github: {
            transport: "stdio",
            command: "/usr/bin/node",
            args: ["--stdio"],
            cwd: "/Users/test/Library/Application Support/TOSS/runtime",
            environment: {},
          },
        },
      },
    },
  };
}

describe("MCP profile registry", () => {
  it("resolves only the exact configured profile reference", () => {
    const registry = createMcpProfileRegistry(configuredRuntime());
    const listed = registry.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]?.transports).toEqual(["stdio"]);
    expect(registry.resolve(listed[0]!.reference)).toBe(listed[0]);
    expect(Object.isFrozen(listed[0])).toBe(true);
  });

  it("rejects a profile map key that differs from the signed profile identity", () => {
    const config = configuredRuntime();
    const entry = Object.values(config.mcp_profiles)[0]!;

    expect(() =>
      createMcpProfileRegistry({
        ...config,
        mcp_profiles: { unexpected: entry },
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_INVALID" }));
  });

  it("rejects a profile whose contents no longer match its hash", () => {
    const config = configuredRuntime();
    const [name, entry] = Object.entries(config.mcp_profiles)[0]!;

    expect(() =>
      createMcpProfileRegistry({
        ...config,
        mcp_profiles: {
          [name]: {
            ...entry,
            profile: { ...entry.profile, revision: entry.profile.revision + 1 },
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_INVALID" }));
  });

  it("rejects missing and extra machine bindings", () => {
    const config = configuredRuntime();
    const [name, entry] = Object.entries(config.mcp_profiles)[0]!;

    expect(() =>
      createMcpProfileRegistry({
        ...config,
        mcp_profiles: { [name]: { ...entry, servers: {} } },
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_INVALID" }));
    expect(() =>
      createMcpProfileRegistry({
        ...config,
        mcp_profiles: {
          [name]: {
            ...entry,
            servers: {
              ...entry.servers,
              extra: {
                transport: "stdio",
                command: "/usr/bin/node",
                args: [],
                cwd: "/Users/test",
                environment: {},
              },
            },
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_INVALID" }));
  });

  it("rejects 2026 header mappings on stdio bindings", () => {
    expect(() =>
      createMcpProfileRegistry(
        configuredRuntime((profile) => {
          const server = profile.servers[0]!;
          return rehashMcpProfile({
            ...profile,
            servers: [
              {
                ...server,
                protocol_revision: "2026-07-28" as const,
                x_mcp_headers: { "x-mcp-query": "/query" as const },
              },
            ],
          });
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_INVALID" }));
  });

  it("rejects header mappings on the 2025 protocol revision", () => {
    expect(() =>
      createMcpProfileRegistry(
        configuredRuntime((profile) => {
          const server = profile.servers[0]!;
          return rehashMcpProfile({
            ...profile,
            servers: [{ ...server, x_mcp_headers: { "x-mcp-query": "/query" as const } }],
          });
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_INVALID" }));
  });

  it("rejects two server rules that reuse one machine binding", () => {
    expect(() =>
      createMcpProfileRegistry(
        configuredRuntime((profile) => {
          const server = profile.servers[0]!;
          const tool = server.tools[0]!;
          return rehashMcpProfile({
            ...profile,
            servers: [
              server,
              {
                ...server,
                server_id: "github-mirror",
                tools: [{ ...tool, alias: "repo.search-mirror" }],
              },
            ],
          });
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_INVALID" }));
  });
});
