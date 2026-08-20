import { afterEach, describe, expect, it, vi } from "vitest";

import type { SecretReference } from "../src/config/types.js";
import {
  createAgentgatewayClient,
  hashAgentgatewayCapabilities,
  type AgentgatewayCapabilitiesV1,
  type AgentgatewayFetch,
  type AgentgatewayProfileV1,
  type GatewayCredentialCoordinator,
} from "../src/gateway/index.js";
import { canonicalJson } from "../src/protocol/json.js";
import { RuntimeProviderError } from "../src/providers/index.js";
import { startFakeAgentgateway, type FakeAgentgateway } from "./helpers/fake-agentgateway.js";

const now = () => new Date("2026-08-20T10:00:00.000Z");
const credentialReference: SecretReference = {
  source: "command",
  key: "TOSS_AGENTGATEWAY_TOKEN",
};
const virtualToken = "virtual-token-0123456789";
const activeGateways: FakeAgentgateway[] = [];

function capabilityDocument(): AgentgatewayCapabilitiesV1 {
  const document = {
    protocol_version: "runtime-contract.v1",
    schema_version: "agentgateway-capabilities.v1",
    document_type: "agentgateway-capabilities",
    gateway: { name: "fake-agentgateway", version: "1.0.0", revision: 7 },
    generated_at: "2026-08-20T09:59:00.000Z",
    expires_at: "2026-08-20T10:04:00.000Z",
    routes: [
      {
        alias: "balanced-code",
        route_id: "route-openai-primary",
        provider: "openai",
        model: "gpt-5.4",
        capabilities: {
          provider: "openai",
          tools: true,
          json_schema: true,
          vision: true,
          reasoning: true,
          streaming: true,
          max_context_tokens: 128_000,
          max_output_tokens: 16_384,
        },
      },
    ],
    document_hash: `sha256:${"0".repeat(64)}`,
  } as AgentgatewayCapabilitiesV1;
  return {
    ...document,
    document_hash: hashAgentgatewayCapabilities(document),
  };
}

function credentials(): GatewayCredentialCoordinator {
  return {
    resolve: vi.fn(() =>
      Promise.resolve({
        scheme: "Bearer" as const,
        token: virtualToken,
        expires_at: "2026-08-20T10:01:00.000Z",
      }),
    ),
    clear: vi.fn(),
  };
}

function profile(endpoint: string): AgentgatewayProfileV1 {
  return {
    protocol: "toss-agentgateway.v1",
    endpoint,
    credential_reference: "gateway-token",
    body_observability: "off",
  };
}

function client(options: {
  readonly endpoint: string;
  readonly fetch?: AgentgatewayFetch;
  readonly credentialCoordinator?: GatewayCredentialCoordinator;
}) {
  return createAgentgatewayClient({
    selectedProfile: { name: "primary", profile: profile(options.endpoint) },
    credentialReference,
    credentials: options.credentialCoordinator ?? credentials(),
    fetch: options.fetch ?? globalThis.fetch,
    now,
  });
}

async function gateway(): Promise<FakeAgentgateway> {
  const value = await startFakeAgentgateway();
  activeGateways.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(activeGateways.splice(0).map(async (value) => value.close()));
});

describe("agentgateway authenticated discovery client", () => {
  it("discovers frozen capabilities through the exact authenticated profile path", async () => {
    const fake = await gateway();
    const document = capabilityDocument();
    fake.setResponse("/runtime/v1/toss/capabilities", {
      status: 200,
      headers: { "content-type": "application/json" },
      body: canonicalJson(document),
    });

    const result = await client({ endpoint: fake.endpoint }).discover(new AbortController().signal);

    expect(result).toEqual(document);
    expect(Object.isFrozen(result)).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: "GET",
      path: "/runtime/v1/toss/capabilities",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${virtualToken}`,
      },
    });
    expect(fake.requests[0]?.headers["x-native-secret"]).toBeUndefined();
    expect(fake.requests[0]?.headers["x-caller-header"]).toBeUndefined();
    expect(fake.requests[0]?.body).toHaveLength(0);
  });

  it("uses only fixed headers, the exact signal, and redirect error mode", async () => {
    const expectedSignal = new AbortController().signal;
    const document = capabilityDocument();
    const fetch = vi.fn<AgentgatewayFetch>(() =>
      Promise.resolve(
        new Response(canonicalJson(document), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-native-secret": "must-not-enter-runtime",
          },
        }),
      ),
    );

    await client({ endpoint: "https://gateway.example.test/base", fetch }).discover(expectedSignal);

    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0];
    expect(call?.[0]).toBe("https://gateway.example.test/base/v1/toss/capabilities");
    expect(call?.[1].method).toBe("GET");
    expect(call?.[1].redirect).toBe("error");
    expect(call?.[1].signal).toBe(expectedSignal);
    expect([...new Headers(call?.[1].headers).entries()]).toEqual([
      ["accept", "application/json"],
      ["authorization", `Bearer ${virtualToken}`],
    ]);
  });

  it("rejects a capability body above 512 KiB and cancels its reader", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(512 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetch: AgentgatewayFetch = () => Promise.resolve(new Response(body, { status: 200 }));

    await expect(
      client({ endpoint: "https://gateway.example.test", fetch }).discover(
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_PROVIDER_GATEWAY_INVALID" });
    expect(cancelled).toBe(true);
  });

  it.each([
    [301, "RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE"],
    [401, "RUNTIME_PROVIDER_AUTHENTICATION"],
    [403, "RUNTIME_PROVIDER_AUTHENTICATION"],
    [404, "RUNTIME_PROVIDER_ROUTE_NOT_FOUND"],
    [429, "RUNTIME_PROVIDER_RATE_LIMIT"],
    [502, "RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE"],
    [503, "RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE"],
    [504, "RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE"],
  ] as const)("maps HTTP %i to %s without reading or reflecting its body", async (status, code) => {
    const body = `native-body-${status}-${virtualToken}-must-not-leak`;
    const fetch: AgentgatewayFetch = () => Promise.resolve(new Response(body, { status }));

    let error: unknown;
    try {
      await client({ endpoint: "https://gateway.example.test", fetch }).discover(
        new AbortController().signal,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(body);
    expect(String(error)).not.toContain(virtualToken);
  });

  it("normalizes malformed capability JSON without reflecting native bytes", async () => {
    const nativeBody = `{\"native\":\"${virtualToken}-must-not-leak\"}`;
    const fetch: AgentgatewayFetch = () =>
      Promise.resolve(new Response(nativeBody, { status: 200 }));

    let error: unknown;
    try {
      await client({ endpoint: "https://gateway.example.test", fetch }).discover(
        new AbortController().signal,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "RUNTIME_PROVIDER_GATEWAY_INVALID" });
    expect(String(error)).not.toContain(nativeBody);
    expect(String(error)).not.toContain(virtualToken);
  });

  it("normalizes redirects and connection failures without native diagnostics", async () => {
    const nativeError = "tls-certificate-native-detail-must-not-leak";
    const fetch: AgentgatewayFetch = () => Promise.reject(new Error(nativeError));

    let error: unknown;
    try {
      await client({ endpoint: "https://gateway.example.test", fetch }).discover(
        new AbortController().signal,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE" });
    expect(String(error)).not.toContain(nativeError);
  });

  it("preserves caller cancellation before credentials or fetch begin", async () => {
    const fetch = vi.fn<AgentgatewayFetch>();
    const resolve = vi.fn<GatewayCredentialCoordinator["resolve"]>(() =>
      Promise.resolve({
        scheme: "Bearer",
        token: virtualToken,
        expires_at: "2026-08-20T10:01:00.000Z",
      }),
    );
    const credentialCoordinator: GatewayCredentialCoordinator = {
      resolve,
      clear: vi.fn(),
    };
    const controller = new AbortController();
    controller.abort();

    await expect(
      client({
        endpoint: "https://gateway.example.test",
        fetch,
        credentialCoordinator,
      }).discover(controller.signal),
    ).rejects.toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_CANCELLED"));
    expect(resolve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves credential authentication failures without starting fetch", async () => {
    const fetch = vi.fn<AgentgatewayFetch>();
    const credentialCoordinator: GatewayCredentialCoordinator = {
      resolve: () => Promise.reject(new RuntimeProviderError("RUNTIME_PROVIDER_AUTHENTICATION")),
      clear: vi.fn(),
    };

    await expect(
      client({
        endpoint: "https://gateway.example.test",
        fetch,
        credentialCoordinator,
      }).discover(new AbortController().signal),
    ).rejects.toMatchObject({ code: "RUNTIME_PROVIDER_AUTHENTICATION" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("agentgateway health client", () => {
  it("returns a frozen closed health result from the exact profile path", async () => {
    const fake = await gateway();
    fake.setResponse("/runtime/healthz", {
      status: 200,
      body: '{"status":"healthy","revision":7}',
    });

    const result = await client({ endpoint: fake.endpoint }).health();

    expect(result).toEqual({ status: "healthy", revision: 7 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: "GET",
      path: "/runtime/healthz",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${virtualToken}`,
      },
    });
  });

  it.each([
    ["malformed", () => Promise.resolve(new Response('{"native":"must-not-leak"}'))],
    ["non-success", () => Promise.resolve(new Response("must-not-leak", { status: 503 }))],
    ["network", () => Promise.reject(new Error("native-health-must-not-leak"))],
  ] as const)("reduces %s health failures to frozen unavailable", async (_name, execute) => {
    const fetch: AgentgatewayFetch = execute;

    const result = await client({ endpoint: "https://gateway.example.test", fetch }).health();

    expect(result).toEqual({ status: "unavailable" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(virtualToken);
  });
});
