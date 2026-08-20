import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  collectProviderEvents,
  createAnthropicAdapter,
  createGeminiAdapter,
  createOpenAIAdapter,
  type CreateProviderAdapterOptions,
  type ProviderAdapter,
  type ProviderAdapterCapabilities,
  type ProviderEventV1,
  type ProviderExecutionOptions,
  type ProviderKind,
  type ProviderRequest,
  type ProviderWireContext,
  type ProviderWireResponse,
  type ProviderWireStream,
  type ProviderWireTransport,
} from "../src/providers/index.js";
import type { JsonValue } from "../src/protocol/json.js";

async function fixture(provider: ProviderKind, kind: "complete" | "stream"): Promise<unknown> {
  return JSON.parse(await readFile(`test/fixtures/providers/${provider}-${kind}.json`, "utf8"));
}

class FixtureTransport implements ProviderWireTransport {
  readonly calls: {
    kind: "complete" | "stream";
    input: JsonValue;
    context: ProviderWireContext;
  }[] = [];

  constructor(
    private readonly completeFixture: unknown,
    private readonly streamFixture: readonly unknown[],
  ) {}

  complete(input: JsonValue, context: ProviderWireContext): Promise<ProviderWireResponse> {
    this.calls.push({ kind: "complete", input, context });
    return Promise.resolve({ payload: this.completeFixture, route_identity: null });
  }

  stream(input: JsonValue, context: ProviderWireContext): Promise<ProviderWireStream> {
    this.calls.push({ kind: "stream", input, context });
    const events = this.streamFixture;
    return Promise.resolve({
      route_identity: null,
      events: (async function* () {
        await Promise.resolve();
        for (const event of events) yield event;
      })(),
    });
  }
}

const execution = {
  run_id: "RUN-001",
  trace: {
    trace_id: "1".repeat(32),
    span_id: "2".repeat(16),
    trace_flags: 1,
  },
} satisfies ProviderExecutionOptions;

const createAdapter = {
  openai: createOpenAIAdapter,
  anthropic: createAnthropicAdapter,
  gemini: createGeminiAdapter,
} satisfies Record<ProviderKind, (options: CreateProviderAdapterOptions) => ProviderAdapter>;

const models: Record<ProviderKind, string> = {
  openai: "gpt-5",
  anthropic: "claude-sonnet-4-5",
  gemini: "gemini-2.5-pro",
};

const nativeRequestKeys: Record<ProviderKind, string> = {
  openai: "input",
  anthropic: "messages",
  gemini: "contents",
};

const expectedResponseIds: Record<ProviderKind, string | null> = {
  openai: "resp_1",
  anthropic: "msg_1",
  gemini: null,
};

const expectedLoss: Record<ProviderKind, string> = {
  openai: "response.service_tier",
  anthropic: "content.signature",
  gemini: "candidate.safety_ratings",
};

function request(provider: ProviderKind): ProviderRequest {
  return {
    request_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f50",
    model: models[provider],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [{ name: "lookup", input_schema: { type: "object" } }],
    response_format: { type: "json-schema", name: "answer", schema: { type: "object" } },
    reasoning: "medium",
    max_output_tokens: 128,
    timeout_ms: 1000,
  };
}

function capabilities(provider: ProviderKind): ProviderAdapterCapabilities {
  return {
    provider,
    tools: true,
    json_schema: true,
    vision: true,
    reasoning: true,
    streaming: true,
    max_context_tokens: 200_000,
    max_output_tokens: 16_384,
  };
}

async function configured(provider: ProviderKind) {
  const completeNative = await fixture(provider, "complete");
  const streamNative = (await fixture(provider, "stream")) as readonly unknown[];
  const transport = new FixtureTransport(completeNative, streamNative);
  let event = 0;
  const adapter = createAdapter[provider]({
    transport,
    capabilities: capabilities(provider),
    now: () => new Date("2026-08-20T10:00:00.000Z"),
    createEventId: () => `018f0f64-7b21-7d4f-8c3d-4a30413d5f4${event++ % 10}`,
  });
  return { adapter, transport };
}

describe("recorded provider conformance", () => {
  it.each(["openai", "anthropic", "gemini"] as const)(
    "normalizes %s streaming and non-streaming to one completion",
    async (provider) => {
      const { adapter, transport } = await configured(provider);
      const input = request(provider);

      const complete = await adapter.complete(input, execution);
      const events: ProviderEventV1[] = [];
      for await (const event of adapter.stream(input, execution)) events.push(event);
      const streamed = collectProviderEvents(events);

      const expected = {
        request_id: input.request_id,
        provider,
        model: models[provider],
        response_id: expectedResponseIds[provider],
        text: "Hello",
        reasoning: provider === "openai" ? "" : "think",
        refusal: null,
        tool_calls: [{ id: "call_1", name: "lookup", arguments: { q: "docs" } }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cached_input_tokens: 2,
          reasoning_tokens: 1,
        },
        finish_reason: "tool-calls",
        structured_output: null,
        route_identity: null,
      };
      expect(complete).toEqual(expected);
      expect(streamed).toEqual(expected);
      expect(Object.isFrozen(complete)).toBe(true);
      expect(Object.isFrozen(events[0])).toBe(true);
      expect(events.flatMap((event) => event.provenance.lossy_fields)).toContain(
        expectedLoss[provider],
      );
      expect(transport.calls).toHaveLength(2);
      for (const call of transport.calls) {
        expect(call.input).toHaveProperty(nativeRequestKeys[provider]);
        expect(call.context.request_id).toBe(input.request_id);
        expect(call.context.run_id).toBe(execution.run_id);
        expect(call.context.trace).toEqual(execution.trace);
        expect(call.context.timeout_ms).toBe(input.timeout_ms);
        expect(call.context.signal).toBeInstanceOf(AbortSignal);
        expect(call.context.requirement).toMatchObject({
          schema_version: "gateway-route-requirement.v1",
          alias: input.model,
          tools: true,
          json_schema: true,
          reasoning: true,
          streaming: call.kind === "stream",
          max_output_tokens: input.max_output_tokens,
        });
      }
      expect(JSON.stringify(complete)).not.toContain("default");
      expect(JSON.stringify(complete)).not.toContain("omitted");
      expect(JSON.stringify(complete)).not.toContain("HARM_CATEGORY");
    },
  );
});
