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

function tokens(value: unknown, fallback: number | null = null): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function usage(value: unknown): ProviderUsage {
  const source = record(value);
  return Object.freeze({
    input_tokens: tokens(source.promptTokenCount, 0) ?? 0,
    output_tokens: tokens(source.candidatesTokenCount, 0) ?? 0,
    cached_input_tokens: tokens(source.cachedContentTokenCount),
    reasoning_tokens: tokens(source.thoughtsTokenCount),
  });
}

function translate(request: ProviderRequest, stream: boolean): JsonValue {
  const system: string[] = [];
  const contents: JsonValue[] = [];
  for (const message of request.messages) {
    const parts: JsonValue[] = [];
    for (const block of message.content) {
      if (block.type === "text") parts.push({ text: block.text });
      else if (block.type === "image") {
        parts.push({ fileData: { fileUri: block.url, mimeType: block.media_type } });
      } else {
        parts.push({
          functionResponse: { name: block.tool_call_id, response: { output: block.content } },
        });
      }
    }
    if (message.role === "system") {
      system.push(
        ...message.content.filter((block) => block.type === "text").map((block) => block.text),
      );
    } else {
      contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
    }
  }
  const generationConfig: Record<string, JsonValue> = {
    maxOutputTokens: request.max_output_tokens,
  };
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.response_format?.type === "json-schema") {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = request.response_format.schema;
  }
  if (request.reasoning !== undefined && request.reasoning !== "none") {
    generationConfig.thinkingConfig = { effort: request.reasoning };
  }
  const result: Record<string, JsonValue> = {
    model: request.model,
    contents,
    generationConfig,
    stream,
  };
  if (system.length > 0) result.systemInstruction = { parts: [{ text: system.join("\n") }] };
  if (request.tools !== undefined && request.tools.length > 0) {
    result.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          parametersJsonSchema: tool.input_schema,
        })),
      },
    ];
  }
  return deepFreezeJson(result);
}

function finish(reason: unknown, sawTool: boolean): ProviderFinishReason {
  if (sawTool) return "tool-calls";
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "BLOCKLIST" || reason === "PROHIBITED_CONTENT") {
    return "content-filter";
  }
  return "stop";
}

function lossy(
  response: Readonly<Record<string, unknown>>,
  candidate?: Readonly<Record<string, unknown>>,
) {
  return [
    ...(response.modelVersion === undefined ? [] : ["response.model_version"]),
    ...(candidate?.safetyRatings === undefined ? [] : ["candidate.safety_ratings"]),
  ];
}

function partTemplates(
  parts: readonly unknown[],
  state: Map<string, JsonValue>,
  nativeEvent: string,
): ProviderEventTemplate[] {
  const events: ProviderEventTemplate[] = [];
  for (const partValue of parts) {
    const part = record(partValue);
    if (part.text !== undefined) {
      const contentIndex = Number(state.get("content_count") ?? 0);
      state.set("content_count", contentIndex + 1);
      events.push({
        event_type: "content-delta",
        data: {
          channel: part.thought === true ? "reasoning" : "text",
          index: contentIndex,
          delta: string(part.text),
        },
        native_event: nativeEvent,
      });
    } else if (part.functionCall !== undefined) {
      const call = record(part.functionCall);
      const toolIndex = Number(state.get("tool_count") ?? 0);
      state.set("tool_count", toolIndex + 1);
      let argumentsJson: string;
      try {
        argumentsJson = canonicalJson(call.args);
      } catch {
        throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
      }
      events.push({
        event_type: "tool-call-delta",
        data: {
          index: toolIndex,
          tool_call_id: `call_${toolIndex + 1}`,
          name: string(call.name),
          arguments_delta: argumentsJson,
        },
        native_event: nativeEvent,
      });
    }
  }
  return events;
}

function complete(native: unknown): readonly ProviderEventTemplate[] {
  const response = record(native);
  if (response.error !== undefined) {
    const failure = record(response.error);
    const classified = classifyProviderFailure({
      ...(typeof failure.code === "number" ? { status: failure.code } : {}),
      ...(typeof failure.status === "string" ? { code: failure.status.toLowerCase() } : {}),
    });
    return [
      { event_type: "response-start", data: {}, native_event: "generate_content" },
      {
        event_type: "response-error",
        data: { error: providerRuntimeError(classified.code) },
        native_event: "generate_content.error",
      },
    ];
  }
  const candidate = record(array(response.candidates)[0]);
  const content = record(candidate.content);
  const state = new Map<string, JsonValue>();
  const events: ProviderEventTemplate[] = [
    {
      event_type: "response-start",
      data: {},
      native_event: "generate_content",
      lossy_fields: response.modelVersion === undefined ? [] : ["response.model_version"],
    },
    ...partTemplates(array(content.parts), state, "candidate.part"),
  ];
  if (response.usageMetadata !== undefined) {
    events.push({
      event_type: "usage",
      data: usage(response.usageMetadata),
      native_event: "usage_metadata",
    });
  }
  events.push({
    event_type: "response-completed",
    data: {
      finish_reason: finish(candidate.finishReason, Number(state.get("tool_count") ?? 0) > 0),
    },
    native_event: "candidate.completed",
    lossy_fields: lossy(response, candidate),
  });
  return events;
}

function stream(
  native: unknown,
  _request: ProviderRequest,
  state: Map<string, JsonValue>,
): readonly ProviderEventTemplate[] {
  void _request;
  const response = record(native);
  const events: ProviderEventTemplate[] = [];
  if (state.get("started") !== true) {
    state.set("started", true);
    events.push({
      event_type: "response-start",
      data: {},
      native_event: "generate_content.chunk",
      lossy_fields: response.modelVersion === undefined ? [] : ["response.model_version"],
    });
  }
  const candidateValue = array(response.candidates)[0];
  if (candidateValue === undefined) {
    const feedback = response.promptFeedback === undefined ? {} : record(response.promptFeedback);
    if (feedback.blockReason !== undefined) {
      events.push({
        event_type: "response-error",
        data: { error: providerRuntimeError("RUNTIME_PROVIDER_REFUSAL") },
        native_event: "prompt_feedback",
      });
      return events;
    }
    throw new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
  }
  const candidate = record(candidateValue);
  const content = record(candidate.content);
  events.push(...partTemplates(array(content.parts), state, "candidate.part"));
  if (response.usageMetadata !== undefined) {
    events.push({
      event_type: "usage",
      data: usage(response.usageMetadata),
      native_event: "usage_metadata",
    });
  }
  if (candidate.finishReason !== undefined) {
    events.push({
      event_type: "response-completed",
      data: {
        finish_reason: finish(candidate.finishReason, Number(state.get("tool_count") ?? 0) > 0),
      },
      native_event: "candidate.completed",
      lossy_fields: lossy(response, candidate),
    });
  }
  return events;
}

const mapper: ProviderMapper = { provider: "gemini", translate, complete, stream };

export function createGeminiAdapter(options: CreateProviderAdapterOptions): ProviderAdapter {
  return createProviderAdapter(mapper, options);
}
