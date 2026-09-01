import { describe, expect, it, vi } from "vitest";

import type { SecretReference } from "../src/config/types.js";
import {
  createSafeStreamableHttpFetch,
  createStreamableHttpToolTransport,
  type HttpBearerProvider,
  type HttpDnsLookup,
  type HttpNetworkFetch,
  type HttpNetworkRequest,
} from "../src/tools/transports/streamable-http.js";
import { createToolSdkClientFactory } from "../src/tools/transports/sdk-client.js";
import type { McpStreamableHttpBinding } from "../src/tools/types.js";
import { fakeMcpClientFactoryCapture } from "./helpers/fake-mcp.js";

const PUBLIC_ADDRESS = "93.184.216.34";
const ENDPOINT = "https://mcp.example.test/service";

function binding(endpoint = ENDPOINT): McpStreamableHttpBinding {
  return {
    transport: "streamable-http",
    endpoint,
    credential_reference: "mcp_token",
  };
}

function bearerProvider(calls: SecretReference[] = []): HttpBearerProvider {
  return {
    resolve(reference) {
      calls.push(reference);
      return Promise.resolve({
        scheme: "Bearer",
        token: "http-secret-value-1234",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    },
  };
}

function fixedDns(
  resolutions: readonly (readonly string[])[] = [[PUBLIC_ADDRESS], [PUBLIC_ADDRESS]],
): HttpDnsLookup {
  let index = 0;
  return async () => {
    await Promise.resolve();
    const addresses = resolutions[Math.min(index, resolutions.length - 1)]!;
    index += 1;
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

function jsonRpcResponse(id: string | number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeMcpNetwork(
  requests: HttpNetworkRequest[],
  options: { readonly sseCalls?: boolean } = {},
): HttpNetworkFetch {
  return async (request) => {
    await Promise.resolve();
    requests.push(request);
    if (request.method === "GET") {
      return {
        response: new Response(null, { status: 405 }),
        remote_address: PUBLIC_ADDRESS,
      };
    }
    if (request.method === "DELETE") {
      return {
        response: new Response(null, { status: 200 }),
        remote_address: PUBLIC_ADDRESS,
      };
    }
    const message = JSON.parse(request.body ?? "null") as {
      readonly id?: string | number;
      readonly method?: string;
      readonly params?: Readonly<Record<string, unknown>>;
    };
    if (message.id === undefined) {
      return {
        response: new Response(null, { status: 202 }),
        remote_address: PUBLIC_ADDRESS,
      };
    }
    let response: Response;
    if (message.method === "initialize") {
      response = jsonRpcResponse(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "http-fixture", version: "1.0.0" },
      });
    } else if (message.method === "tools/list") {
      response = jsonRpcResponse(message.id, {
        tools: [
          {
            name: "echo",
            inputSchema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              additionalProperties: false,
              properties: { value: { type: "string" } },
            },
          },
        ],
      });
    } else {
      const argumentValue = (
        message.params?.arguments as Readonly<Record<string, unknown>> | undefined
      )?.value;
      const result = {
        content: [
          {
            type: "text",
            text: typeof argumentValue === "string" ? argumentValue : "",
          },
        ],
        isError: false,
      };
      response = options.sseCalls
        ? new Response(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          )
        : jsonRpcResponse(message.id, result);
    }
    return { response, remote_address: PUBLIC_ADDRESS };
  };
}

function adapterOptions(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    binding: binding(),
    mode: "production" as const,
    secret_references: {
      mcp_token: { source: "command", key: "MCP_TOKEN" } as const,
    },
    secret_provider: bearerProvider(),
    dns_lookup: fixedDns(),
    network_fetch: fakeMcpNetwork([]),
    approved_header_mappings: {},
    ...overrides,
  };
}

describe("safe Streamable HTTP MCP transport", () => {
  it.each([
    ["production HTTP", "http://127.0.0.1:3000/mcp", "production"],
    ["development public HTTP", "http://example.test/mcp", "development"],
    ["userinfo", "https://user@example.test/mcp", "development"],
    ["query", "https://example.test/mcp?token=value", "development"],
    ["fragment", "https://example.test/mcp#fragment", "development"],
  ] as const)("rejects %s", (_name, endpoint, mode) => {
    expect(() =>
      createStreamableHttpToolTransport(
        adapterOptions({ binding: binding(endpoint), mode }),
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_INVALID" }));
  });

  it("allows exact development loopback HTTP", async () => {
    const requests: HttpNetworkRequest[] = [];
    const adapter = createStreamableHttpToolTransport(
      adapterOptions({
        binding: binding("http://127.0.0.1:3000/mcp"),
        mode: "development",
        dns_lookup: fixedDns([["127.0.0.1"], ["127.0.0.1"]]),
        network_fetch: async (request: HttpNetworkRequest) => {
          await Promise.resolve();
          requests.push(request);
          const message = JSON.parse(request.body ?? "null") as {
            readonly id?: string | number;
            readonly method?: string;
          };
          return {
            response:
              message.id === undefined
                ? new Response(null, { status: 202 })
                : jsonRpcResponse(message.id, {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "loopback", version: "1.0.0" },
                  }),
            remote_address: "127.0.0.1",
          };
        },
      }),
    );
    const connection = await adapter.connect({
      protocol_revision: "2025-06-18",
      timeout_ms: 1_000,
      signal: new AbortController().signal,
      on_tools_changed: () => undefined,
    });
    await connection.close(new AbortController().signal);
    expect(requests.length).toBeGreaterThan(0);
  });

  it.each([
    ["private", "10.0.0.1"],
    ["link-local", "169.254.1.1"],
    ["metadata", "169.254.169.254"],
    ["IPv6 private", "fd00::1"],
  ])("rejects a %s DNS address", async (_name, address) => {
    const adapter = createStreamableHttpToolTransport(
      adapterOptions({ dns_lookup: fixedDns([[address]]) }),
    );
    await expect(
      adapter.connect({
        protocol_revision: "2025-06-18",
        timeout_ms: 1_000,
        signal: new AbortController().signal,
        on_tools_changed: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_UNAVAILABLE" });
  });

  it("rejects public-to-private rebinding before creating a connection", async () => {
    const adapter = createStreamableHttpToolTransport(
      adapterOptions({ dns_lookup: fixedDns([[PUBLIC_ADDRESS], ["10.0.0.1"]]) }),
    );
    await expect(
      adapter.connect({
        protocol_revision: "2025-06-18",
        timeout_ms: 1_000,
        signal: new AbortController().signal,
        on_tools_changed: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_UNAVAILABLE" });
  });

  it("uses fixed headers, resolves bearer per request, and accepts JSON plus SSE", async () => {
    const requests: HttpNetworkRequest[] = [];
    const credentialCalls: SecretReference[] = [];
    const adapter = createStreamableHttpToolTransport(
      adapterOptions({
        network_fetch: fakeMcpNetwork(requests, { sseCalls: true }),
        secret_provider: bearerProvider(credentialCalls),
      }),
    );
    const connection = await adapter.connect({
      protocol_revision: "2025-06-18",
      timeout_ms: 1_000,
      signal: new AbortController().signal,
      on_tools_changed: () => undefined,
    });
    await expect(
      connection.listTools(null, new AbortController().signal),
    ).resolves.toMatchObject({ tools: [{ name: "echo" }] });
    await expect(
      connection.callTool(
        { name: "echo", arguments: { value: "hello" }, trusted_meta: null },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "hello" }] });
    await connection.close(new AbortController().signal);

    expect(credentialCalls).toHaveLength(requests.length);
    for (const request of requests) {
      expect(request.redirect).toBe("error");
      expect(request.approved_addresses).toEqual([PUBLIC_ADDRESS]);
      expect(request.headers.get("authorization")).toBe("Bearer http-secret-value-1234");
      if (request.method === "POST") {
        expect(request.headers.get("accept")).toBe("application/json, text/event-stream");
        expect(request.headers.get("content-type")).toBe("application/json");
      }
      expect(request.headers.has("x-forwarded-for")).toBe(false);
    }
  });

  it("does not follow redirects or retry a 401", async () => {
    for (const [status, code] of [
      [302, "RUNTIME_TOOL_UNAVAILABLE"],
      [401, "RUNTIME_TOOL_AUTHENTICATION"],
    ] as const) {
      const requests: HttpNetworkRequest[] = [];
      const adapter = createStreamableHttpToolTransport(
        adapterOptions({
          network_fetch: async (request: HttpNetworkRequest) => {
            await Promise.resolve();
            requests.push(request);
            return {
              response: new Response(null, {
                status,
                headers: status === 302 ? { location: "http://127.0.0.1/private" } : {},
              }),
              remote_address: PUBLIC_ADDRESS,
            };
          },
        }),
      );
      await expect(
        adapter.connect({
          protocol_revision: "2025-06-18",
          timeout_ms: 1_000,
          signal: new AbortController().signal,
          on_tools_changed: () => undefined,
        }),
      ).rejects.toMatchObject({ code });
      expect(requests).toHaveLength(1);
    }
  });

  it("rejects a socket address outside the approved resolution", async () => {
    const adapter = createStreamableHttpToolTransport(
      adapterOptions({
        network_fetch: () =>
          Promise.resolve({
            response: new Response(null, { status: 200 }),
            remote_address: "93.184.216.35",
          }),
      }),
    );
    await expect(
      adapter.connect({
        protocol_revision: "2025-06-18",
        timeout_ms: 1_000,
        signal: new AbortController().signal,
        on_tools_changed: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_UNAVAILABLE" });
  });

  it.each([
    [429, "RUNTIME_TOOL_RATE_LIMIT"],
    [200, "RUNTIME_TOOL_RESULT_INVALID"],
  ] as const)("classifies an HTTP %s failure without response text", async (status, code) => {
    const adapter = createStreamableHttpToolTransport(
      adapterOptions({
        network_fetch: () =>
          Promise.resolve({
            response: new Response(status === 200 ? "not-json" : "native secret", {
              status,
              headers: { "content-type": "application/json" },
            }),
            remote_address: PUBLIC_ADDRESS,
          }),
      }),
    );
    await expect(
      adapter.connect({
        protocol_revision: "2025-06-18",
        timeout_ms: 1_000,
        signal: new AbortController().signal,
        on_tools_changed: () => undefined,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("propagates request cancellation", async () => {
    const adapter = createStreamableHttpToolTransport(
      adapterOptions({
        network_fetch: async (request: HttpNetworkRequest) =>
          await new Promise((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(new DOMException("native abort", "AbortError")),
              { once: true },
            );
          }),
      }),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(
      adapter.connect({
        protocol_revision: "2025-06-18",
        timeout_ms: 1_000,
        signal: controller.signal,
        on_tools_changed: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_CANCELLED" });
  });

  it("enforces the connection timeout", async () => {
    const adapter = createStreamableHttpToolTransport(
      adapterOptions({
        network_fetch: async (request: HttpNetworkRequest) =>
          await new Promise((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(new DOMException("native timeout", "AbortError")),
              { once: true },
            );
          }),
      }),
    );
    await expect(
      adapter.connect({
        protocol_revision: "2025-06-18",
        timeout_ms: 20,
        signal: new AbortController().signal,
        on_tools_changed: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_TIMEOUT" });
  });

  it("pins the requested revision and rejects a negotiated mismatch", async () => {
    const capture = fakeMcpClientFactoryCapture();
    const adapter = createStreamableHttpToolTransport(
      adapterOptions({
        sdk_client_factory: createToolSdkClientFactory({ createClient: capture.createClient }),
      }),
    );
    const pending = adapter.connect({
      protocol_revision: "2026-07-28",
      timeout_ms: 1_000,
      signal: new AbortController().signal,
      on_tools_changed: () => undefined,
    });
    const settled = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(capture.clients).toHaveLength(1));
    capture.clients[0]!.negotiatedProtocolVersion = "2025-06-18";

    await expect(settled).resolves.toMatchObject({ code: "RUNTIME_TOOL_PROTOCOL_DOWNGRADE" });
  });

  it("emits only profile-approved x-mcp-header mappings", async () => {
    const requests: HttpNetworkRequest[] = [];
    const safeFetch = createSafeStreamableHttpFetch({
      endpoint: new URL(ENDPOINT),
      approved_addresses: [PUBLIC_ADDRESS],
      credential_reference: { source: "command", key: "MCP_TOKEN" },
      secret_provider: bearerProvider(),
      network_fetch: async (request) => {
        await Promise.resolve();
        requests.push(request);
        return {
          response: new Response(null, { status: 202 }),
          remote_address: PUBLIC_ADDRESS,
        };
      },
      protocol_revision: "2026-07-28",
      approved_header_mappings: { Tenant: "/tenant", Enabled: "/nested/enabled" },
    });
    await safeFetch(ENDPOINT, {
      method: "POST",
      headers: { accept: "anything", "content-type": "text/plain" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { tenant: "acme", nested: { enabled: true } } },
      }),
    });

    expect(requests[0]?.headers.get("mcp-param-tenant")).toBe("acme");
    expect(requests[0]?.headers.get("mcp-param-enabled")).toBe("true");
    expect(requests[0]?.headers.get("accept")).toBe("application/json, text/event-stream");
    await expect(
      safeFetch(ENDPOINT, {
        method: "POST",
        headers: { "mcp-param-attacker": "widen" },
        body: "{}",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_INVALID" });
  });
});
