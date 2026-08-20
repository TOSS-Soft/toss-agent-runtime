import { afterEach, describe, expect, it, vi } from "vitest";

import type { SecretReference } from "../src/config/types.js";
import {
  createAgentgatewayTransport,
  hashAgentgatewayCapabilities,
  hashProviderRouteRequirement,
  type AgentgatewayCapabilitiesV1,
  type AgentgatewayFetch,
  type AgentgatewayRouteV1,
  type GatewayCredentialProvider,
} from "../src/gateway/index.js";
import { canonicalJson, deepFreezeJson, type JsonValue } from "../src/protocol/json.js";
import {
  createOpenAIAdapter,
  RuntimeProviderError,
  type ProviderAdapterCapabilities,
  type ProviderExecutionOptions,
  type ProviderRequest,
  type ProviderRouteRequirement,
  type ProviderWireContext,
} from "../src/providers/index.js";
import { startFakeAgentgateway, type FakeAgentgateway } from "./helpers/fake-agentgateway.js";

const now = () => new Date("2026-08-20T10:00:00.000Z");
const virtualToken = "virtual-token-0123456789";
const credentialReference: SecretReference = {
  source: "command",
  key: "TOSS_AGENTGATEWAY_TOKEN",
};
const request: ProviderRequest = {
  request_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f50",
  model: "balanced-code",
  messages: [{ role: "user", content: [{ type: "text", text: "hello gateway" }] }],
  max_output_tokens: 128,
  timeout_ms: 2_000,
};
const execution = {
  run_id: "RUN-001",
  trace: {
    trace_id: "1".repeat(32),
    span_id: "2".repeat(16),
    trace_flags: 1,
    trace_state: "toss=opaque",
  },
} satisfies ProviderExecutionOptions;
const adapterCapabilities: ProviderAdapterCapabilities = {
  provider: "openai",
  tools: true,
  json_schema: true,
  vision: true,
  reasoning: true,
  streaming: true,
  max_context_tokens: 200_000,
  max_output_tokens: 16_384,
};
const activeGateways: FakeAgentgateway[] = [];

const strongRoute: AgentgatewayRouteV1 = {
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
};
const equivalentRoute: AgentgatewayRouteV1 = {
  ...strongRoute,
  route_id: "route-openai-secondary",
  model: "gpt-5.4-secondary",
};
const weakRoute: AgentgatewayRouteV1 = {
  ...strongRoute,
  route_id: "route-openai-weak",
  model: "gpt-5.4-weak",
  capabilities: {
    ...strongRoute.capabilities,
    max_output_tokens: 64,
  },
};
const otherAliasRoute: AgentgatewayRouteV1 = {
  ...strongRoute,
  alias: "other-code",
  route_id: "route-openai-other",
  model: "gpt-5.4-other",
};

function capabilityDocument(
  routes: readonly AgentgatewayRouteV1[] = [
    strongRoute,
    equivalentRoute,
    weakRoute,
    otherAliasRoute,
  ],
): AgentgatewayCapabilitiesV1 {
  const document = {
    protocol_version: "runtime-contract.v1",
    schema_version: "agentgateway-capabilities.v1",
    document_type: "agentgateway-capabilities",
    gateway: { name: "fake-agentgateway", version: "1.0.0", revision: 7 },
    generated_at: "2026-08-20T09:59:00.000Z",
    expires_at: "2026-08-20T10:04:00.000Z",
    routes,
    document_hash: `sha256:${"0".repeat(64)}`,
  } as AgentgatewayCapabilitiesV1;
  return {
    ...document,
    document_hash: hashAgentgatewayCapabilities(document),
  };
}

function nativeCompletion(): JsonValue {
  return {
    id: "resp_1",
    model: "gpt-5.4",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "gateway answer" }] }],
    usage: { input_tokens: 3, output_tokens: 2 },
  };
}

function credentials(): GatewayCredentialProvider {
  return {
    resolve: vi.fn(() =>
      Promise.resolve({
        scheme: "Bearer",
        token: virtualToken,
        expires_at: "2026-08-20T10:01:00.000Z",
      }),
    ),
  };
}

function transport(options: {
  readonly endpoint: string;
  readonly fetch?: AgentgatewayFetch;
  readonly credentialProvider?: GatewayCredentialProvider;
}) {
  return createAgentgatewayTransport({
    selectedProfile: {
      name: "gateway-production",
      profile: {
        protocol: "toss-agentgateway.v1",
        endpoint: options.endpoint,
        credential_reference: "gateway-token",
        body_observability: "off",
      },
    },
    credentialReference,
    credentialProvider: options.credentialProvider ?? credentials(),
    fetch: options.fetch ?? globalThis.fetch,
    now,
  });
}

function adapter(endpoint: string) {
  let event = 0;
  return createOpenAIAdapter({
    transport: transport({ endpoint }),
    capabilities: adapterCapabilities,
    now,
    createEventId: () => `018f0f64-7b21-7d4f-8c3d-4a30413d5f4${event++}`,
  });
}

function attestationHeaders(
  options: {
    readonly capability?: AgentgatewayCapabilitiesV1;
    readonly route?: AgentgatewayRouteV1;
    readonly requirement?: ProviderRouteRequirement;
  } = {},
): Record<string, string> {
  const capability = options.capability ?? capabilityDocument();
  const route = options.route ?? strongRoute;
  const requirement =
    options.requirement ??
    ({
      schema_version: "gateway-route-requirement.v1",
      alias: "balanced-code",
      tools: false,
      json_schema: false,
      vision: false,
      reasoning: false,
      streaming: false,
      max_output_tokens: 128,
    } satisfies ProviderRouteRequirement);
  return {
    "content-type": "application/json",
    "x-toss-route-id": route.route_id,
    "x-toss-resolved-provider": route.provider,
    "x-toss-resolved-model": route.model,
    "x-toss-capability-revision": String(capability.gateway.revision),
    "x-toss-capability-document-sha256": capability.document_hash,
    "x-toss-requirement-sha256": hashProviderRouteRequirement(requirement),
    "x-toss-gateway-request-id": "gw_req_1",
  };
}

async function gateway(): Promise<FakeAgentgateway> {
  const value = await startFakeAgentgateway();
  activeGateways.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(activeGateways.splice(0).map(async (value) => value.close()));
});

describe("agentgateway non-streaming transport", () => {
  it("correlates the request and injects one closed attested route identity", async () => {
    const fake = await gateway();
    const capability = capabilityDocument();
    fake.setResponse("/runtime/v1/toss/capabilities", {
      status: 200,
      body: canonicalJson(capability),
    });
    fake.setResponse("/runtime/v1/responses", {
      status: 200,
      headers: attestationHeaders({ capability }),
      body: canonicalJson(nativeCompletion()),
    });
    const requirement = {
      schema_version: "gateway-route-requirement.v1",
      alias: request.model,
      tools: false,
      json_schema: false,
      vision: false,
      reasoning: false,
      streaming: false,
      max_output_tokens: request.max_output_tokens,
    } satisfies ProviderRouteRequirement;

    const completion = await adapter(fake.endpoint).complete(request, execution);

    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]).toMatchObject({
      method: "POST",
      path: "/runtime/v1/responses",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${virtualToken}`,
        "content-type": "application/json",
        traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
        tracestate: "toss=opaque",
        "x-toss-run-id": "RUN-001",
        "x-toss-request-id": request.request_id,
        "x-toss-capability-revision": "7",
        "x-toss-capability-document-sha256": capability.document_hash,
        "x-toss-requirement-sha256": hashProviderRouteRequirement(requirement),
      },
    });
    expect(JSON.parse(Buffer.from(fake.requests[1]?.body ?? []).toString("utf8"))).toMatchObject({
      model: "balanced-code",
      stream: false,
    });
    expect(completion.route_identity).toEqual({
      transport: "agentgateway",
      gateway_profile: "gateway-production",
      gateway_revision: 7,
      route_id: "route-openai-primary",
      requested_model: "balanced-code",
      resolved_provider: "openai",
      resolved_model: "gpt-5.4",
      capability_document_hash: capability.document_hash,
      requirement_hash: hashProviderRouteRequirement(requirement),
      gateway_request_id: "gw_req_1",
    });
    expect(Object.isFrozen(completion.route_identity)).toBe(true);
    expect(Object.keys(completion.route_identity ?? {}).sort()).toEqual([
      "capability_document_hash",
      "gateway_profile",
      "gateway_request_id",
      "gateway_revision",
      "requested_model",
      "requirement_hash",
      "resolved_model",
      "resolved_provider",
      "route_id",
      "transport",
    ]);
    expect(JSON.stringify(completion)).not.toContain(virtualToken);
    expect(JSON.stringify(completion)).not.toContain(fake.endpoint);
    expect(completion.text).toBe("gateway answer");
  });

  it("accepts an exactly equivalent secondary attested route", async () => {
    const capability = capabilityDocument();
    const fetch = scriptedFetch({
      capability,
      headers: attestationHeaders({ capability, route: equivalentRoute }),
    });

    const result = await transport({
      endpoint: "https://gateway.example.test/runtime",
      fetch,
    }).complete(deepFreezeJson({ model: "balanced-code", stream: false }), context());

    expect(result.route_identity).toMatchObject({
      route_id: "route-openai-secondary",
      resolved_model: "gpt-5.4-secondary",
    });
  });

  it.each([
    ["missing route", "route", undefined, "RUNTIME_PROVIDER_GATEWAY_INVALID"],
    [
      "joined duplicate route",
      "route",
      "route-openai-primary, route-openai-primary",
      "RUNTIME_PROVIDER_GATEWAY_INVALID",
    ],
    ["control route", "route", "route-openai-primary\nother", "RUNTIME_PROVIDER_GATEWAY_INVALID"],
    ["oversized route", "route", "r".repeat(513), "RUNTIME_PROVIDER_GATEWAY_INVALID"],
    ["revision mismatch", "revision", "8", "RUNTIME_PROVIDER_GATEWAY_INVALID"],
    [
      "document hash mismatch",
      "document",
      `sha256:${"a".repeat(64)}`,
      "RUNTIME_PROVIDER_GATEWAY_INVALID",
    ],
    [
      "requirement mismatch",
      "requirement",
      `sha256:${"b".repeat(64)}`,
      "RUNTIME_PROVIDER_GATEWAY_INVALID",
    ],
    ["unknown route", "route", "route-unknown", "RUNTIME_PROVIDER_GATEWAY_INVALID"],
    ["other alias route", "route", "route-openai-other", "RUNTIME_PROVIDER_GATEWAY_INVALID"],
    ["provider mismatch", "provider", "anthropic", "RUNTIME_PROVIDER_GATEWAY_INVALID"],
    ["model mismatch", "model", "gpt-5.4-mutated", "RUNTIME_PROVIDER_GATEWAY_INVALID"],
    [
      "gateway request id",
      "gateway-request",
      "not allowed value",
      "RUNTIME_PROVIDER_GATEWAY_INVALID",
    ],
    ["weaker route", "route", "route-openai-weak", "RUNTIME_PROVIDER_CAPABILITY_DOWNGRADE"],
  ] as const)(
    "rejects %s attestation before adapter completion",
    async (_name, field, value, code) => {
      const capability = capabilityDocument();
      const headers: Record<string, string> = attestationHeaders({ capability });
      const headerName = {
        route: "x-toss-route-id",
        revision: "x-toss-capability-revision",
        document: "x-toss-capability-document-sha256",
        requirement: "x-toss-requirement-sha256",
        provider: "x-toss-resolved-provider",
        model: "x-toss-resolved-model",
        "gateway-request": "x-toss-gateway-request-id",
      }[field];
      if (value === undefined) delete headers[headerName];
      else headers[headerName] = value;
      const fetch = scriptedFetch({ capability, headers });
      const instance = createOpenAIAdapter({
        transport: transport({ endpoint: "https://gateway.example.test/runtime", fetch }),
        capabilities: adapterCapabilities,
        now,
        createEventId: () => "018f0f64-7b21-7d4f-8c3d-4a30413d5f41",
      });

      await expect(instance.complete(request, execution)).rejects.toEqual(
        new RuntimeProviderError(code),
      );
    },
  );

  it("rejects an unknown alias and a known-but-weaker catalog before Responses fetch", async () => {
    const unknownFetch = scriptedFetch({ capability: capabilityDocument([otherAliasRoute]) });
    await expect(
      transport({ endpoint: "https://gateway.example.test/runtime", fetch: unknownFetch }).complete(
        deepFreezeJson({ model: "balanced-code", stream: false }),
        context(),
      ),
    ).rejects.toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_ROUTE_NOT_FOUND"));
    expect(unknownFetch).toHaveBeenCalledTimes(1);

    const weakFetch = scriptedFetch({ capability: capabilityDocument([weakRoute]) });
    await expect(
      transport({ endpoint: "https://gateway.example.test/runtime", fetch: weakFetch }).complete(
        deepFreezeJson({ model: "balanced-code", stream: false }),
        context(),
      ),
    ).rejects.toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_CAPABILITY_DOWNGRADE"));
    expect(weakFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and oversized JSON without exposing native bytes", async () => {
    for (const body of ["{not-json", "x".repeat(8 * 1024 * 1024 + 1)]) {
      const capability = capabilityDocument();
      const fetch = scriptedFetch({
        capability,
        headers: attestationHeaders({ capability }),
        body,
      });
      let error: unknown;
      try {
        await transport({ endpoint: "https://gateway.example.test/runtime", fetch }).complete(
          deepFreezeJson({ model: "balanced-code", stream: false }),
          context(),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_GATEWAY_INVALID"));
      expect(String(error)).not.toContain(body.slice(0, 32));
      expect(String(error)).not.toContain(virtualToken);
    }
  });

  it("rejects a redirected successful response before attestation or payload mapping", async () => {
    const capability = capabilityDocument();
    let call = 0;
    const fetch = vi.fn<AgentgatewayFetch>(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(new Response(canonicalJson(capability), { status: 200 }));
      }
      const response = new Response(canonicalJson(nativeCompletion()), {
        status: 200,
        headers: attestationHeaders({ capability }),
      });
      Object.defineProperty(response, "redirected", { value: true });
      return Promise.resolve(response);
    });

    await expect(
      transport({ endpoint: "https://gateway.example.test/runtime", fetch }).complete(
        deepFreezeJson({ model: "balanced-code", stream: false }),
        context(),
      ),
    ).rejects.toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE"));
  });

  it.each([
    ["provider", "RUNTIME_PROVIDER_TRANSIENT"],
    ["gateway", "RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE"],
    ["invalid-source", "RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE"],
  ] as const)("classifies a %s sourced 503 without reading its body", async (source, code) => {
    const capability = capabilityDocument();
    let call = 0;
    const nativeBody = `${source}-${virtualToken}-must-not-leak`;
    const fetch = vi.fn<AgentgatewayFetch>(() => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? new Response(canonicalJson(capability), { status: 200 })
          : new Response(nativeBody, {
              status: 503,
              headers: { "x-toss-error-source": source },
            }),
      );
    });
    let error: unknown;
    try {
      await transport({ endpoint: "https://gateway.example.test/runtime", fetch }).complete(
        deepFreezeJson({ model: "balanced-code", stream: false }),
        context(),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toEqual(new RuntimeProviderError(code));
    expect(String(error)).not.toContain(nativeBody);
  });

  it("rejects a trace state that the HTTP layer would silently trim", async () => {
    const fetch = scriptedFetch({ capability: capabilityDocument() });
    const invalidContext = context();
    const candidate = {
      ...invalidContext,
      trace: { ...invalidContext.trace, trace_state: " toss=opaque" },
    };

    await expect(
      transport({ endpoint: "https://gateway.example.test/runtime", fetch }).complete(
        deepFreezeJson({ model: "balanced-code", stream: false }),
        candidate,
      ),
    ).rejects.toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_GATEWAY_INVALID"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes a trapping direct JSON input without reflecting native detail", async () => {
    const nativeDetail = "json-proxy-trap-must-not-leak";
    const input = new Proxy(deepFreezeJson({ model: "balanced-code", stream: false }), {
      isExtensible() {
        throw new Error(nativeDetail);
      },
    });
    let error: unknown;
    try {
      await transport({
        endpoint: "https://gateway.example.test/runtime",
        fetch: scriptedFetch({ capability: capabilityDocument() }),
      }).complete(input, context());
    } catch (caught) {
      error = caught;
    }

    expect(error).toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_GATEWAY_INVALID"));
    expect(String(error)).not.toContain(nativeDetail);
  });

  it("does not invoke an accessor hidden in a frozen direct JSON array", async () => {
    let getterCalls = 0;
    const input: unknown[] = [];
    Object.defineProperty(input, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("frozen-array-getter-must-not-run");
      },
    });
    Object.defineProperty(input, "length", { value: 1 });
    Object.freeze(input);

    await expect(
      transport({
        endpoint: "https://gateway.example.test/runtime",
        fetch: scriptedFetch({ capability: capabilityDocument() }),
      }).complete(input as JsonValue, context()),
    ).rejects.toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_GATEWAY_INVALID"));
    expect(getterCalls).toBe(0);
  });

  it("rejects a non-string native attestation value without invoking it", async () => {
    const capability = capabilityDocument();
    const headers = attestationHeaders({ capability });
    let toStringCalls = 0;
    const hostile = {
      toString() {
        toStringCalls += 1;
        throw new Error("header-to-string-must-not-run");
      },
    };
    let call = 0;
    const fetch = vi.fn<AgentgatewayFetch>(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(new Response(canonicalJson(capability), { status: 200 }));
      }
      const response = new Response(canonicalJson(nativeCompletion()), { status: 200 });
      Object.defineProperty(response, "headers", {
        value: {
          get(name: string) {
            return name === "x-toss-route-id" ? hostile : (headers[name] ?? null);
          },
        },
      });
      return Promise.resolve(response);
    });

    await expect(
      transport({ endpoint: "https://gateway.example.test/runtime", fetch }).complete(
        deepFreezeJson({ model: "balanced-code", stream: false }),
        context(),
      ),
    ).rejects.toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_GATEWAY_INVALID"));
    expect(toStringCalls).toBe(0);
  });
});

function context(): ProviderWireContext {
  return {
    request_id: request.request_id,
    run_id: execution.run_id,
    trace: execution.trace,
    requirement: {
      schema_version: "gateway-route-requirement.v1",
      alias: "balanced-code",
      tools: false,
      json_schema: false,
      vision: false,
      reasoning: false,
      streaming: false,
      max_output_tokens: 128,
    },
    signal: new AbortController().signal,
    timeout_ms: request.timeout_ms,
  };
}

function scriptedFetch(options: {
  readonly capability: AgentgatewayCapabilitiesV1;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}): ReturnType<typeof vi.fn<AgentgatewayFetch>> {
  return vi.fn<AgentgatewayFetch>((input) => {
    if (input.endsWith("/v1/toss/capabilities")) {
      return Promise.resolve(new Response(canonicalJson(options.capability), { status: 200 }));
    }
    const body = options.body ?? canonicalJson(nativeCompletion());
    try {
      return Promise.resolve(
        new Response(body, {
          status: 200,
          ...(options.headers === undefined ? {} : { headers: options.headers }),
        }),
      );
    } catch {
      const response = new Response(body, { status: 200 });
      const headers = new Map(
        Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
      );
      Object.defineProperty(response, "headers", {
        configurable: false,
        enumerable: true,
        value: Object.freeze({ get: (name: string) => headers.get(name.toLowerCase()) ?? null }),
        writable: false,
      });
      return Promise.resolve(response);
    }
  });
}
