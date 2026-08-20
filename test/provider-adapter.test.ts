import { describe, expect, it, vi } from "vitest";

import {
  classifyProviderFailure,
  collectProviderEvents,
  createOpenAIAdapter,
  RuntimeProviderError,
  type ProviderAdapterCapabilities,
  type ProviderEventV1,
  type ProviderExecutionOptions,
  type ProviderRequest,
  type ProviderRouteIdentity,
  type ProviderWireContext,
  type ProviderWireResponse,
  type ProviderWireStream,
  type ProviderWireTransport,
} from "../src/providers/index.js";
import type { JsonValue } from "../src/protocol/json.js";

const request: ProviderRequest = {
  request_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f50",
  model: "gpt-5",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  max_output_tokens: 128,
  timeout_ms: 1000,
};

const capabilities: ProviderAdapterCapabilities = {
  provider: "openai",
  tools: true,
  json_schema: true,
  vision: true,
  reasoning: true,
  streaming: true,
  max_context_tokens: 200_000,
  max_output_tokens: 16_384,
};

const execution = {
  run_id: "RUN-001",
  trace: {
    trace_id: "1".repeat(32),
    span_id: "2".repeat(16),
    trace_flags: 1,
  },
} satisfies ProviderExecutionOptions;

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

class FakeTransport implements ProviderWireTransport {
  readonly calls: {
    kind: "complete" | "stream" | "cancel";
    input: JsonValue | string;
    context?: ProviderWireContext;
  }[] = [];
  completeResult: unknown = {
    id: "resp_1",
    model: "gpt-5",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  streamResult: readonly unknown[] = [];
  routeIdentity: ProviderRouteIdentity | null = null;

  complete(input: JsonValue, context: ProviderWireContext): Promise<ProviderWireResponse> {
    this.calls.push({ kind: "complete", input, context });
    return Promise.resolve({ payload: this.completeResult, route_identity: this.routeIdentity });
  }

  stream(input: JsonValue, context: ProviderWireContext): Promise<ProviderWireStream> {
    this.calls.push({ kind: "stream", input, context });
    const events = this.streamResult;
    return Promise.resolve({
      route_identity: this.routeIdentity,
      events: (async function* () {
        await Promise.resolve();
        for (const event of events) yield event;
      })(),
    });
  }

  cancel(requestId: string): Promise<void> {
    this.calls.push({ kind: "cancel", input: requestId });
    return Promise.resolve();
  }

  health(): Promise<unknown> {
    return Promise.resolve({ status: "healthy", native_diagnostics: { api_key: "never" } });
  }
}

function adapter(transport: ProviderWireTransport, overrides = {}) {
  let event = 0;
  return createOpenAIAdapter({
    transport,
    capabilities: { ...capabilities, ...overrides },
    now: () => new Date("2026-08-20T10:00:00.000Z"),
    createEventId: () => `018f0f64-7b21-7d4f-8c3d-4a30413d5f4${event++}`,
  });
}

describe("provider adapter lifecycle", () => {
  it.each([
    [
      "tools",
      { tools: false },
      { ...request, tools: [{ name: "lookup", input_schema: { type: "object" } }] },
      false,
    ],
    [
      "JSON schema",
      { json_schema: false },
      {
        ...request,
        response_format: { type: "json-schema", name: "answer", schema: { type: "object" } },
      },
      false,
    ],
    [
      "vision",
      { vision: false },
      {
        ...request,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", url: "https://example.test/image.png", media_type: "image/png" },
            ],
          },
        ],
      },
      false,
    ],
    ["reasoning", { reasoning: false }, { ...request, reasoning: "high" }, false],
    ["streaming", { streaming: false }, request, true],
    ["output limit", { max_output_tokens: 64 }, request, false],
  ] as const)(
    "rejects unsupported %s before the wire transport",
    async (_name, overrides, candidate, stream) => {
      const transport = new FakeTransport();
      const instance = adapter(transport, overrides);

      const operation = stream
        ? async () => {
            for await (const providerEvent of instance.stream(candidate, execution))
              void providerEvent;
          }
        : () => instance.complete(candidate, execution);
      await expect(operation()).rejects.toEqual(
        new RuntimeProviderError("RUNTIME_PROVIDER_UNSUPPORTED"),
      );
      expect(transport.calls).toEqual([]);
    },
  );

  it.each([
    ["missing execution", undefined],
    ["missing run identity", { trace: execution.trace }],
    ["malformed run identity", { ...execution, run_id: "1-invalid" }],
    [
      "malformed trace identity",
      { ...execution, trace: { ...execution.trace, trace_id: "not-a-trace-id" } },
    ],
    ["out-of-range trace flags", { ...execution, trace: { ...execution.trace, trace_flags: 256 } }],
  ])("rejects %s before the wire transport", async (_name, candidate) => {
    const transport = new FakeTransport();
    const instance = adapter(transport);

    await expect(instance.complete(request, candidate as ProviderExecutionOptions)).rejects.toEqual(
      new RuntimeProviderError("RUNTIME_PROVIDER_INVALID"),
    );
    expect(transport.calls).toEqual([]);
  });

  it("passes exact correlation and route requirements without exposing wire wrappers", async () => {
    const transport = new FakeTransport();
    transport.routeIdentity = routeIdentity;
    const nativeSecret = "native-wrapper-must-not-leak";
    transport.complete = (input, context) => {
      transport.calls.push({ kind: "complete", input, context });
      return Promise.resolve({
        payload: transport.completeResult,
        route_identity: routeIdentity,
        headers: { authorization: nativeSecret },
        token: nativeSecret,
      } as ProviderWireResponse);
    };
    const instance = adapter(transport);

    const completion = await instance.complete(request, execution);
    const call = transport.calls[0];

    expect(call?.context).toMatchObject({
      request_id: request.request_id,
      run_id: execution.run_id,
      trace: execution.trace,
      timeout_ms: request.timeout_ms,
      requirement: {
        schema_version: "gateway-route-requirement.v1",
        alias: request.model,
        tools: false,
        json_schema: false,
        vision: false,
        reasoning: false,
        streaming: false,
        max_output_tokens: request.max_output_tokens,
      },
    });
    expect(call?.context?.signal).toBeInstanceOf(AbortSignal);
    expect(completion.route_identity).toEqual(routeIdentity);
    expect(Object.isFrozen(completion.route_identity)).toBe(true);
    expect(JSON.stringify(completion)).not.toContain(nativeSecret);
  });

  it("injects the stream wrapper route only into the first normalized event", async () => {
    const transport = new FakeTransport();
    transport.routeIdentity = routeIdentity;
    transport.streamResult = [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.completed", response: { status: "completed" } },
    ];
    const instance = adapter(transport);
    const events: ProviderEventV1[] = [];

    for await (const event of instance.stream(request, execution)) events.push(event);

    expect(events[0]).toMatchObject({
      event_type: "response-start",
      data: { route_identity: routeIdentity },
    });
    expect(events[1]?.data).not.toHaveProperty("route_identity");
    expect(collectProviderEvents(events).route_identity).toEqual(routeIdentity);
    expect(transport.calls[0]?.context?.requirement.streaming).toBe(true);
  });

  it("races stream setup against the adapter-owned deadline", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      transport.stream = (_input, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("native stream setup abort must not win")),
            { once: true },
          );
        });
      const instance = adapter(transport);
      const operation = (async () => {
        for await (const event of instance.stream({ ...request, timeout_ms: 10 }, execution)) {
          void event;
        }
      })();
      const expectation = expect(operation).rejects.toEqual(
        new RuntimeProviderError("RUNTIME_PROVIDER_TIMEOUT"),
      );

      await vi.advanceTimersByTimeAsync(10);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the wire iterator exactly once when a consumer stops early", async () => {
    const transport = new FakeTransport();
    let returned = 0;
    transport.stream = () =>
      Promise.resolve({
        route_identity: null,
        events: {
          [Symbol.asyncIterator]() {
            let yielded = false;
            return {
              next() {
                if (yielded) return Promise.resolve({ done: true, value: undefined });
                yielded = true;
                return Promise.resolve({
                  done: false,
                  value: { type: "response.created", response: { id: "resp_1" } },
                });
              },
              return() {
                returned += 1;
                return Promise.resolve({ done: true, value: undefined });
              },
            };
          },
        },
      });
    const instance = adapter(transport);

    for await (const event of instance.stream(request, execution)) {
      expect(event.event_type).toBe("response-start");
      break;
    }

    expect(returned).toBe(1);
  });

  it("rejects an externally cancelled request before transport", async () => {
    const transport = new FakeTransport();
    const instance = adapter(transport);
    const controller = new AbortController();
    controller.abort();

    await expect(
      instance.complete(request, { ...execution, signal: controller.signal }),
    ).rejects.toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_CANCELLED"));
    expect(transport.calls).toEqual([]);
  });

  it("maps an adapter-owned deadline to timeout without reflecting native errors", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    transport.complete = (_input, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => reject(new Error("native abort must not win the deadline race")),
          { once: true },
        );
      });
    const instance = adapter(transport);
    const operation = instance.complete({ ...request, timeout_ms: 10 }, execution);
    const expectation = expect(operation).rejects.toEqual(
      new RuntimeProviderError("RUNTIME_PROVIDER_TIMEOUT"),
    );

    await vi.advanceTimersByTimeAsync(10);
    await expectation;
    vi.useRealTimers();
  });

  it("maps in-flight external cancellation before a native abort failure", async () => {
    const transport = new FakeTransport();
    transport.complete = (_input, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => reject(new Error("native abort must not win cancellation")),
          { once: true },
        );
      });
    const instance = adapter(transport);
    const controller = new AbortController();
    const operation = instance.complete(request, { ...execution, signal: controller.signal });

    controller.abort();

    await expect(operation).rejects.toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_CANCELLED"));
  });

  it("does not invoke accessors or reflect native SDK failures", async () => {
    const transport = new FakeTransport();
    let getterCalls = 0;
    const nativeError = new Error("must-not-leak");
    Object.defineProperty(nativeError, "status", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must-not-run");
      },
    });
    transport.complete = () => Promise.reject(nativeError);
    const instance = adapter(transport);

    await expect(instance.complete(request, execution)).rejects.toEqual(
      new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL"),
    );
    expect(getterCalls).toBe(0);
  });

  it("normalizes failure objects whose SDK reflection traps throw", async () => {
    const transport = new FakeTransport();
    const nativeError = new Proxy(new Error("must-not-leak"), {
      getOwnPropertyDescriptor() {
        throw new Error("must-not-leak-reflection");
      },
    });
    transport.complete = () => Promise.reject(nativeError);
    const instance = adapter(transport);

    await expect(instance.complete(request, execution)).rejects.toEqual(
      new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL"),
    );
  });

  it("projects SDK class instances into frozen plain completions", async () => {
    class NativeResponse {
      readonly id = "resp_sdk";
      readonly status = "completed";
      readonly output = [{ type: "message", content: [{ type: "output_text", text: "plain" }] }];
      readonly usage = { input_tokens: 2, output_tokens: 1 };

      nativeMethod(): string {
        return "must-not-leak";
      }
    }
    const native = new NativeResponse();
    Object.defineProperty(native, "nativeHandle", {
      enumerable: false,
      value: { authorization: "must-not-leak" },
    });
    const transport = new FakeTransport();
    transport.completeResult = native;
    const instance = adapter(transport);

    const completion = await instance.complete(request, execution);
    expect(completion.text).toBe("plain");
    expect(Object.getPrototypeOf(completion)).toBe(Object.prototype);
    expect(Object.isFrozen(completion)).toBe(true);
    expect(JSON.stringify(completion)).not.toContain("must-not-leak");
    expect(completion).not.toHaveProperty("nativeHandle");
    expect(completion).not.toHaveProperty("nativeMethod");
  });

  it("normalizes a first streamed provider failure as start plus terminal error", async () => {
    const transport = new FakeTransport();
    transport.streamResult = [{ type: "error", error: { status: 429, message: "must-not-leak" } }];
    const instance = adapter(transport);
    const events: ProviderEventV1[] = [];

    for await (const event of instance.stream(request, execution)) events.push(event);

    expect(events.map((event) => event.event_type)).toEqual(["response-start", "response-error"]);
    expect(() => collectProviderEvents(events)).toThrow(
      new RuntimeProviderError("RUNTIME_PROVIDER_RATE_LIMIT"),
    );
    expect(JSON.stringify(events)).not.toContain("must-not-leak");
  });

  it.each([
    [{ status: 401 }, "RUNTIME_PROVIDER_AUTHENTICATION"],
    [{ status: 429 }, "RUNTIME_PROVIDER_RATE_LIMIT"],
    [{ status: 408 }, "RUNTIME_PROVIDER_TIMEOUT"],
    [{ status: 503 }, "RUNTIME_PROVIDER_TRANSIENT"],
    [{ code: "content_filter" }, "RUNTIME_PROVIDER_REFUSAL"],
    [{ status: 400 }, "RUNTIME_PROVIDER_INVALID"],
    [{ code: "unmapped", message: "must-not-leak" }, "RUNTIME_PROVIDER_INTERNAL"],
  ] as const)("classifies one safe failure descriptor %#", (descriptor, code) => {
    const error = classifyProviderFailure(descriptor);
    expect(error.code).toBe(code);
    expect(String(error)).not.toContain("must-not-leak");
  });

  it("forwards cancellation and reduces health without native diagnostics", async () => {
    const transport = new FakeTransport();
    const instance = adapter(transport);

    await instance.cancel(request.request_id);
    await expect(instance.health()).resolves.toEqual({ status: "healthy" });
    expect(transport.calls).toEqual([{ kind: "cancel", input: request.request_id }]);
  });
});
