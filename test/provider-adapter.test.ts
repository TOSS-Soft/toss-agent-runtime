import { describe, expect, it, vi } from "vitest";

import {
  classifyProviderFailure,
  collectProviderEvents,
  createOpenAIAdapter,
  RuntimeProviderError,
  type ProviderAdapterCapabilities,
  type ProviderEventV1,
  type ProviderRequest,
  type ProviderWireContext,
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

class FakeTransport implements ProviderWireTransport {
  readonly calls: { kind: "complete" | "stream" | "cancel"; input: JsonValue | string }[] = [];
  completeResult: unknown = {
    id: "resp_1",
    model: "gpt-5",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  complete(input: JsonValue, _context: ProviderWireContext): Promise<unknown> {
    void _context;
    this.calls.push({ kind: "complete", input });
    return Promise.resolve(this.completeResult);
  }

  async *stream(input: JsonValue): AsyncIterable<unknown> {
    this.calls.push({ kind: "stream", input });
    await Promise.resolve();
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
            for await (const providerEvent of instance.stream(candidate)) void providerEvent;
          }
        : () => instance.complete(candidate);
      await expect(operation()).rejects.toEqual(
        new RuntimeProviderError("RUNTIME_PROVIDER_UNSUPPORTED"),
      );
      expect(transport.calls).toEqual([]);
    },
  );

  it("rejects an externally cancelled request before transport", async () => {
    const transport = new FakeTransport();
    const instance = adapter(transport);
    const controller = new AbortController();
    controller.abort();

    await expect(instance.complete(request, { signal: controller.signal })).rejects.toEqual(
      new RuntimeProviderError("RUNTIME_PROVIDER_CANCELLED"),
    );
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
    const operation = instance.complete({ ...request, timeout_ms: 10 });
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
    const operation = instance.complete(request, { signal: controller.signal });

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

    await expect(instance.complete(request)).rejects.toEqual(
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

    await expect(instance.complete(request)).rejects.toEqual(
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

    const completion = await instance.complete(request);
    expect(completion.text).toBe("plain");
    expect(Object.getPrototypeOf(completion)).toBe(Object.prototype);
    expect(Object.isFrozen(completion)).toBe(true);
    expect(JSON.stringify(completion)).not.toContain("must-not-leak");
    expect(completion).not.toHaveProperty("nativeHandle");
    expect(completion).not.toHaveProperty("nativeMethod");
  });

  it("normalizes a first streamed provider failure as start plus terminal error", async () => {
    const transport = new FakeTransport();
    transport.stream = async function* () {
      await Promise.resolve();
      yield { type: "error", error: { status: 429, message: "must-not-leak" } };
    };
    const instance = adapter(transport);
    const events: ProviderEventV1[] = [];

    for await (const event of instance.stream(request)) events.push(event);

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
