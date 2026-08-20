import { describe, expect, it, vi } from "vitest";

import type { SecretReference } from "../src/config/types.js";
import {
  createAgentgatewayTransport,
  hashAgentgatewayCapabilities,
  hashProviderRouteRequirement,
  type AgentgatewayCapabilitiesV1,
  type AgentgatewayFetch,
  type AgentgatewayProfileV1,
  type GatewayCredentialProvider,
  type GatewayObservation,
} from "../src/gateway/index.js";
import { canonicalJson, deepFreezeJson, type JsonValue } from "../src/protocol/json.js";
import type { ProviderRouteRequirement, ProviderWireContext } from "../src/providers/index.js";

const virtualToken = "virtual-token-observation-must-not-leak";
const endpoint = "https://gateway-observation.example.test/runtime";
const prompt = "prompt-observation-must-not-leak";
const toolName = "tool-name-observation-must-not-leak";
const toolSchema = "tool-schema-observation-must-not-leak";
const toolResult = "tool-result-observation-must-not-leak";
const modelOutput = "model-output-observation-must-not-leak";
const nativeDiagnostic = "native-diagnostic-observation-must-not-leak";
const credentialReference: SecretReference = {
  source: "command",
  key: "TOSS_AGENTGATEWAY_TOKEN",
};
const requirement: ProviderRouteRequirement = {
  schema_version: "gateway-route-requirement.v1",
  alias: "balanced-code",
  tools: true,
  json_schema: false,
  vision: true,
  reasoning: false,
  streaming: false,
  max_output_tokens: 128,
};
const wireInput = deepFreezeJson({
  model: "balanced-code",
  input: [
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        {
          type: "input_image",
          image_url: "https://private-image.example.test/must-not-leak.png",
          media_type: "image/png",
        },
      ],
    },
    { type: "function_call_output", call_id: toolName, output: toolResult },
  ],
  tools: [
    {
      type: "function",
      name: toolName,
      parameters: { type: "object", description: toolSchema },
      strict: true,
    },
  ],
  max_output_tokens: 128,
  stream: false,
});
const nativeResponse = deepFreezeJson({
  id: "resp_observation",
  output: [{ type: "message", content: [{ type: "output_text", text: modelOutput }] }],
  diagnostic: nativeDiagnostic,
});

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
        route_id: "route-openai-observation",
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
  return { ...document, document_hash: hashAgentgatewayCapabilities(document) };
}

function context(): ProviderWireContext {
  return {
    request_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f50",
    run_id: "RUN-OBSERVATION-001",
    trace: { trace_id: "1".repeat(32), span_id: "2".repeat(16), trace_flags: 1 },
    requirement,
    signal: new AbortController().signal,
    timeout_ms: 2_000,
  };
}

function profile(
  bodyObservability: AgentgatewayProfileV1["body_observability"],
): AgentgatewayProfileV1 {
  return {
    protocol: "toss-agentgateway.v1",
    endpoint,
    credential_reference: "gateway-token",
    body_observability: bodyObservability,
  };
}

function credentials(): GatewayCredentialProvider {
  return {
    resolve: () =>
      Promise.resolve({
        scheme: "Bearer",
        token: virtualToken,
        expires_at: "2026-08-20T10:01:00.000Z",
      }),
  };
}

function responseHeaders(
  capability: AgentgatewayCapabilitiesV1,
  candidateRequirement: ProviderRouteRequirement,
): Record<string, string> {
  return {
    "x-toss-route-id": "route-openai-observation",
    "x-toss-resolved-provider": "openai",
    "x-toss-resolved-model": "gpt-5.4",
    "x-toss-capability-revision": "7",
    "x-toss-capability-document-sha256": capability.document_hash,
    "x-toss-requirement-sha256": hashProviderRouteRequirement(candidateRequirement),
    "x-toss-gateway-request-id": "gw_req_observation",
    "x-native-diagnostic": nativeDiagnostic,
  };
}

function successfulFetch(): AgentgatewayFetch {
  const capability = capabilityDocument();
  let call = 0;
  return () => {
    call += 1;
    if (call === 1) {
      return Promise.resolve(new Response(canonicalJson(capability), { status: 200 }));
    }
    return Promise.resolve(
      new Response(canonicalJson(nativeResponse), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...responseHeaders(capability, requirement),
        },
      }),
    );
  };
}

function transport(options: {
  readonly bodyObservability: AgentgatewayProfileV1["body_observability"];
  readonly onObservation: (observation: GatewayObservation) => void;
  readonly monotonicValues?: readonly number[];
  readonly fetch?: AgentgatewayFetch;
}) {
  const monotonicValues = [...(options.monotonicValues ?? [100, 145])];
  return createAgentgatewayTransport({
    selectedProfile: {
      name: "gateway-observation",
      profile: profile(options.bodyObservability),
    },
    credentialReference,
    credentialProvider: credentials(),
    fetch: options.fetch ?? successfulFetch(),
    now: () => new Date("2026-08-20T10:00:00.000Z"),
    monotonicNow: () => monotonicValues.shift() ?? 145,
    onObservation: options.onObservation,
  });
}

describe("agentgateway redacted observations", () => {
  it("emits nothing while body observability is off", async () => {
    const onObservation = vi.fn<(observation: GatewayObservation) => void>();

    await transport({ bodyObservability: "off", onObservation }).complete(wireInput, context());

    expect(onObservation).not.toHaveBeenCalled();
  });

  it("emits only one exact frozen structural summary", async () => {
    const observations: GatewayObservation[] = [];

    const result = await transport({
      bodyObservability: "redacted-metadata",
      onObservation: (observation) => observations.push(observation),
    }).complete(wireInput, context());

    const requestBytes = Buffer.byteLength(canonicalJson(wireInput), "utf8");
    const responseBytes = Buffer.byteLength(canonicalJson(nativeResponse), "utf8");
    expect(result.payload).toEqual(nativeResponse);
    expect(observations).toEqual([
      {
        run_id: "RUN-OBSERVATION-001",
        request_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f50",
        route_id: "route-openai-observation",
        streaming: false,
        request_bytes: requestBytes,
        response_bytes: responseBytes,
        message_count: 1,
        content_block_count: 3,
        tool_count: 1,
        status_class: "2xx",
        duration_ms: 45,
      },
    ]);
    expect(Object.isFrozen(observations[0])).toBe(true);
    expect(Object.keys(observations[0] ?? {}).sort()).toEqual([
      "content_block_count",
      "duration_ms",
      "message_count",
      "request_bytes",
      "request_id",
      "response_bytes",
      "route_id",
      "run_id",
      "status_class",
      "streaming",
      "tool_count",
    ]);
    const serialized = JSON.stringify(observations);
    for (const sentinel of [
      prompt,
      toolName,
      toolSchema,
      toolResult,
      modelOutput,
      endpoint,
      virtualToken,
      nativeDiagnostic,
      "authorization",
      "headers",
      "environment",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("does not let a throwing observation callback change the provider result", async () => {
    const callbackError = "observation-callback-must-not-leak";
    let callbackCalls = 0;
    const instance = transport({
      bodyObservability: "redacted-metadata",
      onObservation: () => {
        callbackCalls += 1;
        throw new Error(callbackError);
      },
    });

    const result = await instance.complete(wireInput, context());

    expect(callbackCalls).toBe(1);
    expect(result.payload).toEqual(nativeResponse);
    expect(JSON.stringify(result)).not.toContain(callbackError);
  });

  it("emits streaming bytes only after the bounded SSE iterable is consumed", async () => {
    const streamingRequirement = { ...requirement, streaming: true };
    const streamingContext = { ...context(), requirement: streamingRequirement };
    const streamingInput = deepFreezeJson({
      ...(wireInput as Readonly<Record<string, JsonValue>>),
      stream: true,
    });
    const capability = capabilityDocument();
    const sse = Buffer.from(
      [
        `data: ${canonicalJson({ type: "response.created", response: { id: "resp_observation" } })}`,
        "",
        `data: ${canonicalJson({ type: "response.completed", response: { status: "completed" } })}`,
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"),
    );
    let call = 0;
    const fetch: AgentgatewayFetch = () => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? new Response(canonicalJson(capability), { status: 200 })
          : new Response(sse, {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                ...responseHeaders(capability, streamingRequirement),
              },
            }),
      );
    };
    const observations: GatewayObservation[] = [];
    const instance = transport({
      bodyObservability: "redacted-metadata",
      onObservation: (observation) => observations.push(observation),
      fetch,
    });

    const stream = await instance.stream(streamingInput, streamingContext);
    expect(observations).toEqual([]);
    for await (const event of stream.events) void event;

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      streaming: true,
      response_bytes: sse.byteLength,
      route_id: "route-openai-observation",
      status_class: "2xx",
      duration_ms: 45,
    });
  });

  it("normalizes an overflowing monotonic clock without changing the result", async () => {
    const observations: GatewayObservation[] = [];
    const instance = transport({
      bodyObservability: "redacted-metadata",
      onObservation: (observation) => observations.push(observation),
      monotonicValues: [-Number.MAX_VALUE, Number.MAX_VALUE],
    });

    const result = await instance.complete(wireInput, context());

    expect(result.payload).toEqual(nativeResponse);
    expect(observations[0]?.duration_ms).toBe(0);
    expect(Number.isSafeInteger(observations[0]?.duration_ms)).toBe(true);
  });
});
