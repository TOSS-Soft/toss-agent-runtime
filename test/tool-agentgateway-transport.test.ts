import { afterEach, describe, expect, it, vi } from "vitest";

import type { SecretReference } from "../src/config/types.js";
import {
  createGatewayCredentialCoordinator,
  type AgentgatewayFetch,
  type GatewayCredentialProvider,
} from "../src/gateway/index.js";
import {
  createAgentgatewayToolTransport,
  type AgentgatewayToolAuthority,
} from "../src/tools/transports/agentgateway.js";
import type { NativeToolCallRequest } from "../src/tools/transports/types.js";
import type { McpAgentgatewayBinding } from "../src/tools/types.js";
import {
  startFakeAgentgateway,
  type CapturedGatewayRequest,
  type FakeAgentgateway,
  type FakeGatewayResponse,
} from "./helpers/fake-agentgateway.js";

const NOW = new Date("2026-09-01T10:00:00.000Z");
const TOKEN = "scoped-virtual-token-0123456789";
const PROFILE_HASH = `sha256:${"1".repeat(64)}` as const;
const EXECUTION_HASH = `sha256:${"2".repeat(64)}` as const;
const AGENT_HASH = `sha256:${"3".repeat(64)}` as const;
const TASK_HASH = `sha256:${"4".repeat(64)}` as const;
const SNAPSHOT_HASH = `sha256:${"5".repeat(64)}` as const;
const IDEMPOTENCY_KEY = `sha256:${"6".repeat(64)}` as const;
const GATEWAY_CREDENTIAL: SecretReference = {
  source: "command",
  key: "TOSS_AGENTGATEWAY_TOKEN",
};

const authority: AgentgatewayToolAuthority = {
  run_id: "RUN-001",
  request_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f50",
  execution_request_hash: EXECUTION_HASH,
  agent_definition_hash: AGENT_HASH,
  task_contract_hash: TASK_HASH,
  role: "worker",
  mcp_profile_hash: PROFILE_HASH,
  server_id: "github:enterprise",
  trace: {
    trace_id: "a".repeat(32),
    span_id: "b".repeat(16),
    trace_flags: 1,
    trace_state: "toss=opaque",
  },
};

const activeGateways: FakeAgentgateway[] = [];

afterEach(async () => {
  await Promise.all(activeGateways.splice(0).map(async (gateway) => gateway.close()));
});

function credentials(
  options: {
    readonly scopes?: unknown[];
    readonly expires_at?: string;
  } = {},
) {
  const provider: GatewayCredentialProvider = {
    resolve(_reference, resolveOptions) {
      options.scopes?.push(
        (resolveOptions as typeof resolveOptions & { readonly scope?: unknown }).scope,
      );
      return Promise.resolve({
        scheme: "Bearer",
        token: TOKEN,
        expires_at: options.expires_at ?? "2026-09-01T10:02:00.000Z",
      });
    },
  };
  return createGatewayCredentialCoordinator({ provider, now: () => NOW });
}

function adapterOptions(options: {
  readonly endpoint: string;
  readonly fetch?: AgentgatewayFetch;
  readonly coordinator?: ReturnType<typeof credentials>;
  readonly binding?: McpAgentgatewayBinding;
  readonly approved_header_mappings?: Readonly<Record<string, string>>;
}) {
  return {
    binding: options.binding ?? {
      transport: "agentgateway" as const,
      gateway_profile: "gateway-production",
    },
    gateway_profiles: {
      "gateway-production": {
        protocol: "toss-agentgateway.v1" as const,
        endpoint: options.endpoint,
        credential_reference: "gateway-token",
        body_observability: "off" as const,
      },
    },
    secret_references: { "gateway-token": GATEWAY_CREDENTIAL },
    credential_coordinator: options.coordinator ?? credentials(),
    fetch: options.fetch ?? globalThis.fetch,
    authority,
    approved_header_mappings: options.approved_header_mappings ?? {},
  };
}

function toolMetadata() {
  return {
    toss: {
      run_id: authority.run_id,
      execution_request_hash: authority.execution_request_hash,
      agent_definition_hash: authority.agent_definition_hash,
      task_contract_hash: authority.task_contract_hash,
      role: authority.role,
      mcp_profile_hash: authority.mcp_profile_hash,
      discovery_snapshot_hash: SNAPSHOT_HASH,
      server_id: authority.server_id,
      tool_alias: "repo.search",
      native_tool_name: "search",
      call_id: "call-001",
      idempotency_key: IDEMPOTENCY_KEY,
      trace: authority.trace,
    },
  } as const;
}

function mcpResponse(
  request: CapturedGatewayRequest,
  protocolRevision: "2025-06-18" | "2026-07-28" = "2025-06-18",
): FakeGatewayResponse {
  if (request.method === "DELETE") return { status: 200 };
  const message = JSON.parse(Buffer.from(request.body).toString("utf8")) as {
    readonly id?: string | number;
    readonly method?: string;
  };
  if (message.id === undefined) return { status: 202 };
  let result: unknown;
  if (message.method === "server/discover") {
    result = {
      supportedVersions: [protocolRevision],
      capabilities: { tools: {} },
      _meta: {
        "io.modelcontextprotocol/serverInfo": { name: "gateway-mcp", version: "1.0.0" },
      },
    };
  } else if (message.method === "initialize") {
    result = {
      protocolVersion: protocolRevision,
      capabilities: { tools: {} },
      serverInfo: { name: "gateway-mcp", version: "1.0.0" },
    };
  } else if (message.method === "tools/list") {
    result = {
      tools: [
        {
          name: "search",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
            properties: { query: { type: "string" } },
          },
        },
      ],
    };
  } else {
    result = { content: [{ type: "text", text: "gateway result" }], isError: false };
  }
  if (protocolRevision === "2026-07-28" && message.method !== "server/discover") {
    result = { ...(result as Readonly<Record<string, unknown>>), resultType: "complete" };
  }
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
  };
}

async function gateway(): Promise<FakeAgentgateway> {
  const value = await startFakeAgentgateway();
  activeGateways.push(value);
  return value;
}

describe("scoped agentgateway MCP transport", () => {
  it("derives the route and binds credentials, headers, tool scope, and idempotency", async () => {
    const fake = await gateway();
    const scopes: unknown[] = [];
    fake.configureMcpRoute({
      server_id: authority.server_id,
      protocol_revision: "2025-06-18",
      respond: mcpResponse,
    });
    const adapter = createAgentgatewayToolTransport(
      adapterOptions({ endpoint: fake.endpoint, coordinator: credentials({ scopes }) }),
    );
    const connection = await adapter.connect({
      protocol_revision: "2025-06-18",
      timeout_ms: 1_000,
      signal: new AbortController().signal,
      on_tools_changed: () => undefined,
    });
    await connection.listTools(null, new AbortController().signal);
    const call: NativeToolCallRequest = {
      name: "search",
      arguments: { query: "runtime" },
      trusted_meta: toolMetadata() as unknown as NonNullable<NativeToolCallRequest["trusted_meta"]>,
    };
    await expect(connection.callTool(call, new AbortController().signal)).resolves.toMatchObject({
      content: [{ type: "text", text: "gateway result" }],
    });
    await connection.close(new AbortController().signal);

    expect(fake.requests.length).toBeGreaterThanOrEqual(5);
    expect(fake.requests.map((request) => request.path)).toEqual(
      Array.from({ length: fake.requests.length }, () => "/v1/toss/mcp/github%3Aenterprise"),
    );
    const callRequest = fake.requests.find((request) =>
      Buffer.from(request.body).includes(Buffer.from('"method":"tools/call"')),
    );
    expect(callRequest?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      traceparent: `00-${authority.trace.trace_id}-${authority.trace.span_id}-01`,
      tracestate: "toss=opaque",
      "x-toss-run-id": authority.run_id,
      "x-toss-request-id": authority.request_id,
      "x-toss-execution-request-sha256": EXECUTION_HASH,
      "x-toss-agent-definition-sha256": AGENT_HASH,
      "x-toss-task-contract-sha256": TASK_HASH,
      "x-toss-agent-role": "worker",
      "x-toss-mcp-profile-sha256": PROFILE_HASH,
      "x-toss-discovery-sha256": SNAPSHOT_HASH,
      "x-toss-mcp-server-id": authority.server_id,
      "x-toss-tool-alias": "repo.search",
      "x-toss-native-tool-name": "search",
      "x-toss-call-id": "call-001",
      "x-toss-idempotency-key": IDEMPOTENCY_KEY,
    });
    expect(callRequest?.headers).not.toHaveProperty("x-forwarded-authorization");
    expect(scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "session", server_id: authority.server_id }),
        expect.objectContaining({ operation: "discovery", server_id: authority.server_id }),
        expect.objectContaining({
          operation: "call",
          run_id: authority.run_id,
          execution_request_hash: EXECUTION_HASH,
          agent_definition_hash: AGENT_HASH,
          task_contract_hash: TASK_HASH,
          role: authority.role,
          mcp_profile_hash: PROFILE_HASH,
          discovery_snapshot_hash: SNAPSHOT_HASH,
          server_id: authority.server_id,
          tool_alias: "repo.search",
          native_tool_name: "search",
          idempotency_key: IDEMPOTENCY_KEY,
        }),
      ]),
    );
    expect(JSON.stringify(scopes)).not.toContain(TOKEN);
  });

  it("emits only profile-approved 2026 x-mcp parameter headers", async () => {
    const fake = await gateway();
    fake.configureMcpRoute({
      server_id: authority.server_id,
      protocol_revision: "2026-07-28",
      respond: (request) => mcpResponse(request, "2026-07-28"),
    });
    const adapter = createAgentgatewayToolTransport(
      adapterOptions({
        endpoint: fake.endpoint,
        approved_header_mappings: { "x-mcp-tenant": "/tenant" },
      }),
    );
    const connection = await adapter.connect({
      protocol_revision: "2026-07-28",
      timeout_ms: 1_000,
      signal: new AbortController().signal,
      on_tools_changed: () => undefined,
    });
    await connection.callTool(
      {
        name: "search",
        arguments: { query: "runtime", tenant: "acme" },
        trusted_meta: toolMetadata() as unknown as NonNullable<
          NativeToolCallRequest["trusted_meta"]
        >,
      },
      new AbortController().signal,
    );
    await connection.close(new AbortController().signal);

    const callRequest = fake.requests.find((request) =>
      Buffer.from(request.body).includes(Buffer.from('"method":"tools/call"')),
    );
    expect(callRequest?.headers["x-mcp-tenant"]).toBe("acme");
    expect(callRequest?.headers).not.toHaveProperty("x-mcp-attacker");
  });

  it("rejects a call whose trusted metadata widens the captured authority", async () => {
    const fake = await gateway();
    fake.configureMcpRoute({
      server_id: authority.server_id,
      protocol_revision: "2025-06-18",
      respond: mcpResponse,
    });
    const adapter = createAgentgatewayToolTransport(adapterOptions({ endpoint: fake.endpoint }));
    const connection = await adapter.connect({
      protocol_revision: "2025-06-18",
      timeout_ms: 1_000,
      signal: new AbortController().signal,
      on_tools_changed: () => undefined,
    });
    const metadata = toolMetadata();
    await expect(
      connection.callTool(
        {
          name: "search",
          arguments: { query: "runtime" },
          trusted_meta: {
            toss: {
              ...metadata.toss,
              task_contract_hash: `sha256:${"9".repeat(64)}`,
            },
          } as unknown as NonNullable<NativeToolCallRequest["trusted_meta"]>,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_POLICY_DENIED" });
    expect(
      fake.requests.filter((request) =>
        Buffer.from(request.body).includes(Buffer.from('"method":"tools/call"')),
      ),
    ).toHaveLength(0);
  });

  it("rejects a caller endpoint instead of overriding the selected gateway origin", async () => {
    const fake = await gateway();
    expect(() =>
      createAgentgatewayToolTransport(
        adapterOptions({
          endpoint: fake.endpoint,
          binding: {
            transport: "agentgateway",
            gateway_profile: "gateway-production",
            endpoint: "https://attacker.invalid/mcp",
          } as never,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_INVALID" }));
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    [401, "RUNTIME_TOOL_AUTHENTICATION"],
    [403, "RUNTIME_TOOL_AUTHENTICATION"],
    [404, "RUNTIME_TOOL_UNAVAILABLE"],
    [429, "RUNTIME_TOOL_RATE_LIMIT"],
    [503, "RUNTIME_TOOL_UNAVAILABLE"],
  ] as const)("maps gateway HTTP %s without disclosing its body", async (status, code) => {
    const fake = await gateway();
    fake.setResponse("/v1/toss/mcp/github%3Aenterprise", {
      status,
      body: `native-provider-token-${TOKEN}`,
    });
    const adapter = createAgentgatewayToolTransport(adapterOptions({ endpoint: fake.endpoint }));
    let failure: unknown;
    try {
      await adapter.connect({
        protocol_revision: "2025-06-18",
        timeout_ms: 1_000,
        signal: new AbortController().signal,
        on_tools_changed: () => undefined,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code });
    expect(String(failure)).not.toContain(TOKEN);
    expect(String(failure)).not.toContain("native-provider");
    expect(fake.requests).toHaveLength(1);
  });

  it("rejects an expired scoped lease before sending the request", async () => {
    const fake = await gateway();
    const adapter = createAgentgatewayToolTransport(
      adapterOptions({
        endpoint: fake.endpoint,
        coordinator: credentials({ expires_at: "2026-09-01T10:00:29.999Z" }),
      }),
    );
    await expect(
      adapter.connect({
        protocol_revision: "2025-06-18",
        timeout_ms: 1_000,
        signal: new AbortController().signal,
        on_tools_changed: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_AUTHENTICATION" });
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    [
      "scope",
      { "x-toss-mcp-scope-sha256": `sha256:${"f".repeat(64)}` },
      "RUNTIME_TOOL_POLICY_DENIED",
    ],
    [
      "capability downgrade",
      { "x-toss-mcp-capabilities": "tools/list" },
      "RUNTIME_TOOL_UNSUPPORTED",
    ],
    [
      "protocol mismatch",
      { "x-toss-mcp-protocol-version": "2026-07-28" },
      "RUNTIME_TOOL_PROTOCOL_DOWNGRADE",
    ],
  ] as const)("rejects a gateway %s attestation", async (_name, headers, code) => {
    const fake = await gateway();
    fake.configureMcpRoute({
      server_id: authority.server_id,
      protocol_revision: "2025-06-18",
      respond: (request) => {
        const response = mcpResponse(request);
        return { ...response, headers: { ...response.headers, ...headers } };
      },
    });
    const adapter = createAgentgatewayToolTransport(adapterOptions({ endpoint: fake.endpoint }));
    await expect(
      adapter.connect({
        protocol_revision: "2025-06-18",
        timeout_ms: 1_000,
        signal: new AbortController().signal,
        on_tools_changed: () => undefined,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("propagates cancellation and never exposes the token", async () => {
    const fetch = vi.fn<AgentgatewayFetch>(
      async (_input, options) =>
        await new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error(`native cancellation ${TOKEN}`)),
            { once: true },
          );
        }),
    );
    const adapter = createAgentgatewayToolTransport(
      adapterOptions({ endpoint: "https://gateway.example.test/runtime", fetch }),
    );
    const controller = new AbortController();
    const pending = adapter.connect({
      protocol_revision: "2025-06-18",
      timeout_ms: 1_000,
      signal: controller.signal,
      on_tools_changed: () => undefined,
    });
    controller.abort();

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "RUNTIME_TOOL_CANCELLED" });
    expect(String(failure)).not.toContain(TOKEN);
  });
});
