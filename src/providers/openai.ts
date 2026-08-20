import { deepFreezeJson, type JsonValue } from "../protocol/json.js";
import {
  classifyProviderFailure,
  createProviderAdapter,
  type CreateProviderAdapterOptions,
  type ProviderEventTemplate,
  type ProviderMapper,
} from "./adapter.js";
import { providerRuntimeError, RuntimeProviderError } from "./errors.js";
import type { ProviderAdapter, ProviderRequest, ProviderUsage } from "./types.js";

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
  }
  const symbols = Object.getOwnPropertySymbols(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    symbols.length > 0 ||
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

function string(value: unknown, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 1_048_576) {
    throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
  }
  return value;
}

function nonnegative(value: unknown, fallback: number | null = null): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function requiredIndex(value: unknown): number {
  const parsed = nonnegative(value);
  if (parsed === null || parsed > 4095) {
    throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
  }
  return parsed;
}

function openAIUsage(value: unknown): ProviderUsage {
  const usage = record(value);
  const inputDetails =
    usage.input_tokens_details === undefined ? {} : record(usage.input_tokens_details);
  const outputDetails =
    usage.output_tokens_details === undefined ? {} : record(usage.output_tokens_details);
  const inputTokens = nonnegative(usage.input_tokens, 0);
  const outputTokens = nonnegative(usage.output_tokens, 0);
  return Object.freeze({
    input_tokens: inputTokens ?? 0,
    output_tokens: outputTokens ?? 0,
    cached_input_tokens: nonnegative(inputDetails.cached_tokens),
    reasoning_tokens: nonnegative(outputDetails.reasoning_tokens),
  });
}

function translateContent(request: ProviderRequest): JsonValue[] {
  const input: JsonValue[] = [];
  for (const message of request.messages) {
    const content: JsonValue[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        content.push({ type: "input_text", text: block.text });
      } else if (block.type === "image") {
        content.push({ type: "input_image", image_url: block.url, media_type: block.media_type });
      } else {
        input.push({
          type: "function_call_output",
          call_id: block.tool_call_id,
          output: block.content,
        });
      }
    }
    if (content.length > 0) input.push({ role: message.role, content });
  }
  return input;
}

function translate(request: ProviderRequest, stream: boolean): JsonValue {
  const result: Record<string, JsonValue> = {
    model: request.model,
    input: translateContent(request),
    max_output_tokens: request.max_output_tokens,
    stream,
  };
  if (request.temperature !== undefined) result.temperature = request.temperature;
  if (request.reasoning !== undefined && request.reasoning !== "none") {
    result.reasoning = { effort: request.reasoning };
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    result.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.input_schema,
      strict: true,
    }));
  }
  if (request.response_format?.type === "json-schema") {
    result.text = {
      format: {
        type: "json_schema",
        name: request.response_format.name,
        schema: request.response_format.schema,
        strict: true,
      },
    };
  }
  return deepFreezeJson(result);
}

function finishReason(
  response: Readonly<Record<string, unknown>>,
  sawTool: boolean,
  sawRefusal: boolean,
) {
  if (sawRefusal) return "refusal" as const;
  if (sawTool) return "tool-calls" as const;
  if (response.status === "incomplete") {
    const detail =
      response.incomplete_details === undefined ? {} : record(response.incomplete_details);
    return detail.reason === "max_output_tokens"
      ? ("length" as const)
      : ("content-filter" as const);
  }
  return "stop" as const;
}

function lossy(response: Readonly<Record<string, unknown>>): readonly string[] {
  return [
    ...(response.service_tier === undefined ? [] : ["response.service_tier"]),
    ...(response.system_fingerprint === undefined ? [] : ["response.system_fingerprint"]),
  ];
}

function complete(native: unknown): readonly ProviderEventTemplate[] {
  const response = record(native);
  const events: ProviderEventTemplate[] = [
    {
      event_type: "response-start",
      data: {
        ...(response.id === undefined ? {} : { response_id: string(response.id) as string }),
      },
      native_event: "response",
      lossy_fields: lossy(response),
    },
  ];
  if (response.error !== undefined) {
    const failure = record(response.error);
    const classified = classifyProviderFailure({
      ...(typeof failure.status === "number" ? { status: failure.status } : {}),
      ...(typeof failure.code === "string" ? { code: failure.code } : {}),
    });
    events.push({
      event_type: "response-error",
      data: { error: providerRuntimeError(classified.code) },
      native_event: "response.error",
    });
    return events;
  }

  let contentIndex = 0;
  let toolIndex = 0;
  let sawTool = false;
  let sawRefusal = false;
  for (const itemValue of array(response.output)) {
    const item = record(itemValue);
    if (item.type === "message") {
      for (const partValue of array(item.content)) {
        const part = record(partValue);
        if (part.type === "output_text") {
          events.push({
            event_type: "content-delta",
            data: { channel: "text", index: contentIndex, delta: string(part.text) as string },
            native_event: "response.output_text",
          });
          contentIndex += 1;
        } else if (part.type === "refusal") {
          sawRefusal = true;
          events.push({
            event_type: "content-delta",
            data: {
              channel: "refusal",
              index: contentIndex,
              delta: string(part.refusal) as string,
            },
            native_event: "response.refusal",
          });
          contentIndex += 1;
        }
      }
    } else if (item.type === "function_call") {
      sawTool = true;
      events.push({
        event_type: "tool-call-delta",
        data: {
          index: toolIndex,
          tool_call_id: string(item.call_id ?? item.id) as string,
          name: string(item.name) as string,
          arguments_delta: string(item.arguments) as string,
        },
        native_event: "response.function_call",
      });
      toolIndex += 1;
    }
  }
  if (response.usage !== undefined) {
    events.push({
      event_type: "usage",
      data: openAIUsage(response.usage),
      native_event: "response.usage",
    });
  }
  let structuredOutput: JsonValue | undefined;
  if (response.output_parsed !== undefined) {
    try {
      structuredOutput = deepFreezeJson(response.output_parsed as JsonValue);
    } catch {
      throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
    }
  }
  events.push({
    event_type: "response-completed",
    data: {
      finish_reason: finishReason(response, sawTool, sawRefusal),
      ...(structuredOutput === undefined ? {} : { structured_output: structuredOutput }),
    },
    native_event: "response.completed",
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
  const type = string(event.type) as string;
  if (type === "response.created") {
    const response = record(event.response);
    return [
      {
        event_type: "response-start",
        data: { response_id: string(response.id) as string },
        native_event: type,
        lossy_fields: lossy(response),
      },
    ];
  }
  if (type === "response.output_text.delta") {
    return [
      {
        event_type: "content-delta",
        data: {
          channel: "text",
          index: requiredIndex(event.output_index),
          delta: string(event.delta) as string,
        },
        native_event: type,
      },
    ];
  }
  if (type === "response.refusal.delta") {
    state.set("saw_refusal", true);
    return [
      {
        event_type: "content-delta",
        data: {
          channel: "refusal",
          index: requiredIndex(event.output_index),
          delta: string(event.delta) as string,
        },
        native_event: type,
      },
    ];
  }
  if (type === "response.output_item.added") {
    const item = record(event.item);
    if (item.type !== "function_call") return [];
    const nativeIndex = requiredIndex(event.output_index);
    const canonicalIndex = Number(state.get("tool_count") ?? 0);
    const id = string(item.call_id ?? item.id) as string;
    const name = string(item.name) as string;
    state.set("tool_count", canonicalIndex + 1);
    state.set(`tool.${nativeIndex}.index`, canonicalIndex);
    state.set(`tool.${nativeIndex}.id`, id);
    state.set(`tool.${nativeIndex}.name`, name);
    return [
      {
        event_type: "tool-call-delta",
        data: {
          index: canonicalIndex,
          tool_call_id: id,
          name,
          arguments_delta: "",
        },
        native_event: type,
      },
    ];
  }
  if (type === "response.function_call_arguments.delta") {
    const nativeIndex = requiredIndex(event.output_index);
    const canonicalIndex = state.get(`tool.${nativeIndex}.index`);
    const id = state.get(`tool.${nativeIndex}.id`);
    const name = state.get(`tool.${nativeIndex}.name`);
    if (typeof canonicalIndex !== "number" || typeof id !== "string" || typeof name !== "string") {
      throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
    }
    return [
      {
        event_type: "tool-call-delta",
        data: {
          index: canonicalIndex,
          tool_call_id: id,
          name,
          arguments_delta: string(event.delta) as string,
        },
        native_event: type,
      },
    ];
  }
  if (type === "response.completed") {
    const response = record(event.response);
    const templates: ProviderEventTemplate[] = [];
    if (response.usage !== undefined) {
      templates.push({
        event_type: "usage",
        data: openAIUsage(response.usage),
        native_event: type,
      });
    }
    templates.push({
      event_type: "response-completed",
      data: {
        finish_reason: finishReason(
          response,
          Number(state.get("tool_count") ?? 0) > 0,
          state.get("saw_refusal") === true,
        ),
      },
      native_event: type,
      lossy_fields: lossy(response),
    });
    return templates;
  }
  if (type === "error") {
    const failure = record(event.error);
    const classified = classifyProviderFailure({
      ...(typeof failure.status === "number" ? { status: failure.status } : {}),
      ...(typeof failure.code === "string" ? { code: failure.code } : {}),
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

const mapper: ProviderMapper = {
  provider: "openai",
  translate,
  complete,
  stream,
};

export function createOpenAIAdapter(options: CreateProviderAdapterOptions): ProviderAdapter {
  return createProviderAdapter(mapper, options);
}
