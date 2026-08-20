import { describe, expect, it } from "vitest";

import {
  collectProviderEvents,
  parseProviderEvent,
  RuntimeProviderError,
  type ProviderEventV1,
  type ProviderRouteIdentity,
} from "../src/providers/index.js";
import { canonicalJson } from "../src/protocol/json.js";

function event(
  sequence: number,
  eventType: ProviderEventV1["event_type"],
  data: ProviderEventV1["data"],
): ProviderEventV1 {
  return {
    protocol_version: "runtime-contract.v1",
    schema_version: "provider-event.v1",
    document_type: "provider-event",
    event_id: `018f0f64-7b21-7d4f-8c3d-4a30413d5f4${sequence}`,
    request_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f50",
    sequence,
    occurred_at: `2026-08-20T10:00:0${sequence}.000Z`,
    provider: "openai",
    model: "gpt-5",
    event_type: eventType,
    provenance: { native_event: `fixture.${eventType}`, lossy_fields: [] },
    data,
  } as ProviderEventV1;
}

const routeIdentity: ProviderRouteIdentity = {
  transport: "agentgateway",
  gateway_profile: "gateway-production",
  gateway_revision: 7,
  route_id: "balanced-openai-primary",
  requested_model: "balanced-code",
  resolved_provider: "openai",
  resolved_model: "gpt-5",
  capability_document_hash: `sha256:${"a".repeat(64)}`,
  requirement_hash: `sha256:${"b".repeat(64)}`,
  gateway_request_id: "gw_req_1",
};

describe("provider event contract", () => {
  it("parses and freezes one closed provider event", () => {
    const candidate = event(0, "response-start", { response_id: "resp_123" });
    const result = parseProviderEvent(canonicalJson(candidate));

    expect(result).toEqual({ ok: true, value: candidate });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.provenance)).toBe(true);
      expect(Object.isFrozen(result.value.data)).toBe(true);
    }
  });

  it("collects one closed agentgateway route identity", () => {
    const completion = collectProviderEvents([
      event(0, "response-start", { response_id: "resp_1", route_identity: routeIdentity }),
      event(1, "response-completed", { finish_reason: "stop" }),
    ]);

    expect(completion.route_identity).toEqual(routeIdentity);
    expect(Object.isFrozen(completion.route_identity)).toBe(true);
  });

  it.each(["authorization", "endpoint", "headers", "token"])(
    "rejects route identity native field %s",
    (field) => {
      const candidate = event(0, "response-start", {
        route_identity: { ...routeIdentity, [field]: "must-not-leak" },
      });
      expect(parseProviderEvent(canonicalJson(candidate)).ok).toBe(false);
    },
  );

  it.each([
    ["native payload", { ...event(0, "response-start", {}), native_response: { secret: "x" } }],
    ["unknown event type", { ...event(0, "response-start", {}), event_type: "response.native" }],
    [
      "unsafe provenance field",
      {
        ...event(0, "response-start", {}),
        provenance: { native_event: "response.created", lossy_fields: ["authorization"] },
      },
    ],
  ])("rejects %s without reflecting native values", (_name, candidate) => {
    const result = parseProviderEvent(canonicalJson(candidate));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('"secret":"x"');
  });

  it("collects normalized deltas into one canonical completion", () => {
    const events = [
      event(0, "response-start", { response_id: "resp_123" }),
      event(1, "content-delta", { channel: "text", index: 0, delta: "Hello " }),
      event(2, "content-delta", { channel: "text", index: 0, delta: "world" }),
      event(3, "content-delta", { channel: "reasoning", index: 0, delta: "brief" }),
      event(4, "tool-call-delta", {
        index: 0,
        tool_call_id: "call_1",
        name: "lookup",
        arguments_delta: '{"q":"docs"}',
      }),
      event(5, "usage", {
        input_tokens: 10,
        output_tokens: 4,
        cached_input_tokens: 2,
        reasoning_tokens: 1,
      }),
      event(6, "response-completed", { finish_reason: "tool-calls" }),
    ] as const;

    expect(collectProviderEvents(events)).toEqual({
      request_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f50",
      provider: "openai",
      model: "gpt-5",
      response_id: "resp_123",
      text: "Hello world",
      reasoning: "brief",
      refusal: null,
      tool_calls: [{ id: "call_1", name: "lookup", arguments: { q: "docs" } }],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cached_input_tokens: 2,
        reasoning_tokens: 1,
      },
      finish_reason: "tool-calls",
      structured_output: null,
      route_identity: null,
    });
  });

  it.each([
    [
      "gap",
      [event(0, "response-start", {}), event(2, "response-completed", { finish_reason: "stop" })],
    ],
    [
      "identity change",
      [
        event(0, "response-start", {}),
        { ...event(1, "response-completed", { finish_reason: "stop" }), model: "other" },
      ],
    ],
    [
      "post terminal event",
      [
        event(0, "response-start", {}),
        event(1, "response-completed", { finish_reason: "stop" }),
        event(2, "content-delta", { channel: "text", index: 0, delta: "late" }),
      ],
    ],
    [
      "invalid tool json",
      [
        event(0, "response-start", {}),
        event(1, "tool-call-delta", {
          index: 0,
          tool_call_id: "call_1",
          name: "lookup",
          arguments_delta: "{",
        }),
        event(2, "response-completed", { finish_reason: "tool-calls" }),
      ],
    ],
  ])("fails closed for a %s stream", (_name, events) => {
    expect(() => collectProviderEvents(events as readonly ProviderEventV1[])).toThrowError(
      new RuntimeProviderError("RUNTIME_PROVIDER_INVALID"),
    );
  });

  it("turns a normalized terminal error into its stable public failure", () => {
    const events = [
      event(0, "response-start", {}),
      event(1, "response-error", {
        error: {
          code: "RUNTIME_PROVIDER_RATE_LIMIT",
          category: "rate-limit",
          retryable: true,
          safe_message: "Provider rate limit exceeded",
        },
      }),
    ];
    expect(() => collectProviderEvents(events)).toThrowError(
      new RuntimeProviderError("RUNTIME_PROVIDER_RATE_LIMIT"),
    );
  });
});
