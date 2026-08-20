import { canonicalJson, deepFreezeJson, type JsonValue } from "../protocol/json.js";
import {
  classifyProviderFailure,
  createProviderAdapter,
  type CreateProviderAdapterOptions,
  type ProviderEventTemplate,
  type ProviderMapper,
} from "./adapter.js";
import { providerRuntimeError, RuntimeProviderError } from "./errors.js";
import type {
  ProviderAdapter,
  ProviderFinishReason,
  ProviderRequest,
  ProviderUsage,
} from "./types.js";

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.values(descriptors).some(
      (descriptor) => descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
  }
  return Object.fromEntries(
    Object.entries(descriptors)
      .filter(([, descriptor]) => descriptor.enumerable)
      .map(([key, descriptor]) => [key, descriptor.value]),
  );
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_048_576) {
    throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
  }
  return value;
}

function index(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 4095) {
    throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
  }
  return Number(value);
}

function tokens(value: unknown, fallback: number | null = null): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function usage(value: unknown): ProviderUsage {
  const source = record(value);
  return Object.freeze({
    input_tokens: tokens(source.input_tokens, 0) ?? 0,
    output_tokens: tokens(source.output_tokens, 0) ?? 0,
    cached_input_tokens: tokens(source.cache_read_input_tokens),
    reasoning_tokens: tokens(source.thinking_tokens),
  });
}

function translate(request: ProviderRequest, stream: boolean): JsonValue {
  const system: string[] = [];
  const messages: JsonValue[] = [];
  for (const message of request.messages) {
    const content: JsonValue[] = [];
    for (const block of message.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "image") {
        content.push({
          type: "image",
          source: { type: "url", url: block.url, media_type: block.media_type },
        });
      } else {
        content.push({
          type: "tool_result",
          tool_use_id: block.tool_call_id,
          content: block.content,
        });
      }
    }
    if (message.role === "system") {
      system.push(
        ...message.content.filter((block) => block.type === "text").map((block) => block.text),
      );
    } else {
      messages.push({ role: message.role === "assistant" ? "assistant" : "user", content });
    }
  }
  const result: Record<string, JsonValue> = {
    model: request.model,
    messages,
    max_tokens: request.max_output_tokens,
    stream,
  };
  if (system.length > 0) result.system = system.join("\n");
  if (request.temperature !== undefined) result.temperature = request.temperature;
  if (request.reasoning !== undefined && request.reasoning !== "none") {
    result.thinking = { type: "enabled", effort: request.reasoning };
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    result.tools = request.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      input_schema: tool.input_schema,
    }));
  }
  if (request.response_format?.type === "json-schema") {
    result.output_config = {
      format: {
        type: "json_schema",
        name: request.response_format.name,
        schema: request.response_format.schema,
      },
    };
  }
  return deepFreezeJson(result);
}

function finish(reason: unknown, sawTool = false): ProviderFinishReason {
  if (sawTool || reason === "tool_use") return "tool-calls";
  if (reason === "max_tokens") return "length";
  if (reason === "refusal") return "refusal";
  return "stop";
}

function complete(native: unknown): readonly ProviderEventTemplate[] {
  const message = record(native);
  const events: ProviderEventTemplate[] = [
    {
      event_type: "response-start",
      data: { response_id: string(message.id) },
      native_event: "message",
    },
  ];
  if (message.error !== undefined) {
    const failure = record(message.error);
    const classified = classifyProviderFailure({
      ...(typeof failure.status === "number" ? { status: failure.status } : {}),
      ...(typeof failure.type === "string" ? { code: failure.type } : {}),
    });
    events.push({
      event_type: "response-error",
      data: { error: providerRuntimeError(classified.code) },
      native_event: "error",
    });
    return events;
  }
  let textIndex = 0;
  let toolIndex = 0;
  let sawTool = false;
  for (const contentValue of array(message.content)) {
    const content = record(contentValue);
    if (content.type === "text") {
      events.push({
        event_type: "content-delta",
        data: { channel: "text", index: textIndex++, delta: string(content.text) },
        native_event: "content.text",
      });
    } else if (content.type === "thinking") {
      events.push({
        event_type: "content-delta",
        data: { channel: "reasoning", index: textIndex++, delta: string(content.thinking) },
        native_event: "content.thinking",
        lossy_fields: content.signature === undefined ? [] : ["content.signature"],
      });
    } else if (content.type === "tool_use") {
      sawTool = true;
      let argumentsJson: string;
      try {
        argumentsJson = canonicalJson(content.input);
      } catch {
        throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
      }
      events.push({
        event_type: "tool-call-delta",
        data: {
          index: toolIndex++,
          tool_call_id: string(content.id),
          name: string(content.name),
          arguments_delta: argumentsJson,
        },
        native_event: "content.tool_use",
      });
    } else if (content.type === "refusal") {
      events.push({
        event_type: "content-delta",
        data: { channel: "refusal", index: textIndex++, delta: string(content.refusal) },
        native_event: "content.refusal",
      });
    }
  }
  events.push({ event_type: "usage", data: usage(message.usage), native_event: "message.usage" });
  events.push({
    event_type: "response-completed",
    data: { finish_reason: finish(message.stop_reason, sawTool) },
    native_event: "message.completed",
  });
  return events;
}

function stream(
  native: unknown,
  _request: ProviderRequest,
  state: Map<string, JsonValue>,
): readonly ProviderEventTemplate[] {
  void _request;
  const event = record(native);
  const type = string(event.type);
  if (type === "message_start") {
    const message = record(event.message);
    const initial = usage(message.usage);
    state.set("input_tokens", initial.input_tokens);
    if (initial.cached_input_tokens !== null)
      state.set("cached_tokens", initial.cached_input_tokens);
    if (initial.reasoning_tokens !== null) state.set("reasoning_tokens", initial.reasoning_tokens);
    return [
      {
        event_type: "response-start",
        data: { response_id: string(message.id) },
        native_event: type,
      },
    ];
  }
  if (type === "content_block_start") {
    const nativeIndex = index(event.index);
    const block = record(event.content_block);
    if (block.type === "tool_use") {
      const toolIndex = Number(state.get("tool_count") ?? 0);
      state.set("tool_count", toolIndex + 1);
      state.set(`tool.${nativeIndex}.index`, toolIndex);
      state.set(`tool.${nativeIndex}.id`, string(block.id));
      state.set(`tool.${nativeIndex}.name`, string(block.name));
      return [
        {
          event_type: "tool-call-delta",
          data: {
            index: toolIndex,
            tool_call_id: string(block.id),
            name: string(block.name),
            arguments_delta: "",
          },
          native_event: type,
        },
      ];
    }
    if (block.type === "thinking" && block.signature !== undefined) {
      state.set(`thinking.${nativeIndex}.lossy`, true);
    }
    return [];
  }
  if (type === "content_block_delta") {
    const nativeIndex = index(event.index);
    const delta = record(event.delta);
    if (delta.type === "text_delta") {
      return [
        {
          event_type: "content-delta",
          data: { channel: "text", index: nativeIndex, delta: string(delta.text) },
          native_event: type,
        },
      ];
    }
    if (delta.type === "thinking_delta") {
      return [
        {
          event_type: "content-delta",
          data: { channel: "reasoning", index: nativeIndex, delta: string(delta.thinking) },
          native_event: type,
          lossy_fields:
            state.get(`thinking.${nativeIndex}.lossy`) === true ? ["content.signature"] : [],
        },
      ];
    }
    if (delta.type === "input_json_delta") {
      const toolIndex = state.get(`tool.${nativeIndex}.index`);
      const id = state.get(`tool.${nativeIndex}.id`);
      const name = state.get(`tool.${nativeIndex}.name`);
      if (typeof toolIndex !== "number" || typeof id !== "string" || typeof name !== "string") {
        throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
      }
      return [
        {
          event_type: "tool-call-delta",
          data: {
            index: toolIndex,
            tool_call_id: id,
            name,
            arguments_delta: string(delta.partial_json),
          },
          native_event: type,
        },
      ];
    }
    throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
  }
  if (type === "message_delta") {
    const delta = record(event.delta);
    const update = usage(event.usage);
    const normalizedUsage: ProviderUsage = Object.freeze({
      input_tokens: Number(state.get("input_tokens") ?? 0),
      output_tokens: update.output_tokens,
      cached_input_tokens:
        typeof state.get("cached_tokens") === "number"
          ? (state.get("cached_tokens") as number)
          : null,
      reasoning_tokens:
        update.reasoning_tokens ??
        (typeof state.get("reasoning_tokens") === "number"
          ? (state.get("reasoning_tokens") as number)
          : null),
    });
    return [
      { event_type: "usage", data: normalizedUsage, native_event: type },
      {
        event_type: "response-completed",
        data: {
          finish_reason: finish(delta.stop_reason, Number(state.get("tool_count") ?? 0) > 0),
        },
        native_event: type,
      },
    ];
  }
  if (type === "message_stop") return [];
  if (type === "error") {
    const failure = record(event.error);
    const classified = classifyProviderFailure({
      ...(typeof failure.status === "number" ? { status: failure.status } : {}),
      ...(typeof failure.type === "string" ? { code: failure.type } : {}),
    });
    return [
      {
        event_type: "response-error",
        data: { error: providerRuntimeError(classified.code) },
        native_event: type,
      },
    ];
  }
  throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
}

const mapper: ProviderMapper = { provider: "anthropic", translate, complete, stream };

export function createAnthropicAdapter(options: CreateProviderAdapterOptions): ProviderAdapter {
  return createProviderAdapter(mapper, options);
}
