import { canonicalJson, deepFreezeJson, parseJsonBytes, type JsonValue } from "../protocol/json.js";
import { createProtocolValidator } from "../protocol/validator.js";
import type { ValidationResult } from "../protocol/types.js";
import {
  isRuntimeProviderErrorCode,
  RuntimeProviderError,
  type RuntimeProviderErrorCode,
} from "./errors.js";
import type {
  ProviderCompletion,
  ProviderEventV1,
  ProviderFinishReason,
  ProviderToolCall,
  ProviderUsage,
} from "./types.js";

const MAX_PROVIDER_EVENTS = 10_000;
const MAX_PROVIDER_OUTPUT_BYTES = 4 * 1024 * 1024;

function invalid(): never {
  throw new RuntimeProviderError("RUNTIME_PROVIDER_INVALID");
}

function validatedEvent(event: ProviderEventV1): ProviderEventV1 {
  const result = parseProviderEvent(canonicalJson(event));
  if (!result.ok) invalid();
  return result.value;
}

function sameIdentity(left: ProviderEventV1, right: ProviderEventV1): boolean {
  return (
    left.request_id === right.request_id &&
    left.provider === right.provider &&
    left.model === right.model
  );
}

function addBytes(current: number, value: string): number {
  const next = current + Buffer.byteLength(value, "utf8");
  if (!Number.isSafeInteger(next) || next > MAX_PROVIDER_OUTPUT_BYTES) invalid();
  return next;
}

function checkedTerminalError(event: Extract<ProviderEventV1, { event_type: "response-error" }>) {
  const candidate = event.data.error;
  if (!isRuntimeProviderErrorCode(candidate.code)) invalid();
  const expected = new RuntimeProviderError(candidate.code);
  if (
    candidate.category !== expected.category ||
    candidate.retryable !== expected.retryable ||
    candidate.safe_message !== expected.safe_message ||
    candidate.metadata !== undefined
  ) {
    invalid();
  }
  return expected;
}

interface MutableToolCall {
  id: string;
  name: string | undefined;
  arguments: string;
}

function completeToolCalls(
  tools: ReadonlyMap<number, MutableToolCall>,
): readonly ProviderToolCall[] {
  const result: ProviderToolCall[] = [];
  for (const [index, tool] of [...tools.entries()].sort(([left], [right]) => left - right)) {
    if (index !== result.length || tool.name === undefined) invalid();
    let parsed: JsonValue;
    try {
      parsed = parseJsonBytes(tool.arguments);
    } catch {
      invalid();
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
    result.push(Object.freeze({ id: tool.id, name: tool.name, arguments: parsed }));
  }
  return Object.freeze(result);
}

const EMPTY_USAGE: ProviderUsage = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cached_input_tokens: null,
  reasoning_tokens: null,
});

export function parseProviderEvent(input: string | Uint8Array): ValidationResult<ProviderEventV1> {
  return createProtocolValidator().parse<ProviderEventV1>(input, "provider-event");
}

export function collectProviderEvents(events: readonly ProviderEventV1[]): ProviderCompletion {
  if (events.length < 2 || events.length > MAX_PROVIDER_EVENTS) invalid();
  const normalized = events.map(validatedEvent);
  const first = normalized[0];
  if (first?.event_type !== "response-start" || first.sequence !== 0) invalid();

  let responseId = first.data.response_id ?? null;
  let text = "";
  let reasoning = "";
  let refusal = "";
  let usage: ProviderUsage = EMPTY_USAGE;
  let sawUsage = false;
  let terminal: ProviderFinishReason | undefined;
  let structuredOutput: JsonValue | null = null;
  let outputBytes = 0;
  const tools = new Map<number, MutableToolCall>();

  for (const [index, event] of normalized.entries()) {
    if (event.sequence !== index || !sameIdentity(first, event)) invalid();
    if (index > 0 && event.event_type === "response-start") invalid();
    if (terminal !== undefined) invalid();

    switch (event.event_type) {
      case "response-start":
        responseId = event.data.response_id ?? responseId;
        break;
      case "content-delta":
        outputBytes = addBytes(outputBytes, event.data.delta);
        if (event.data.channel === "text") text += event.data.delta;
        else if (event.data.channel === "reasoning") reasoning += event.data.delta;
        else refusal += event.data.delta;
        break;
      case "tool-call-delta": {
        outputBytes = addBytes(outputBytes, event.data.arguments_delta);
        const current = tools.get(event.data.index);
        if (current === undefined) {
          tools.set(event.data.index, {
            id: event.data.tool_call_id,
            name: event.data.name,
            arguments: event.data.arguments_delta,
          });
          break;
        }
        if (
          current.id !== event.data.tool_call_id ||
          (current.name !== undefined &&
            event.data.name !== undefined &&
            current.name !== event.data.name)
        ) {
          invalid();
        }
        current.name ??= event.data.name;
        current.arguments += event.data.arguments_delta;
        break;
      }
      case "usage":
        if (sawUsage) invalid();
        usage = event.data;
        sawUsage = true;
        break;
      case "response-completed":
        terminal = event.data.finish_reason;
        structuredOutput = event.data.structured_output ?? null;
        break;
      case "response-error":
        throw checkedTerminalError(event);
    }
  }

  if (terminal === undefined) invalid();
  const completion = {
    request_id: first.request_id,
    provider: first.provider,
    model: first.model,
    response_id: responseId,
    text,
    reasoning,
    refusal: refusal.length === 0 ? null : refusal,
    tool_calls: completeToolCalls(tools),
    usage,
    finish_reason: terminal,
    structured_output: structuredOutput,
    route_identity: first.data.route_identity ?? null,
  } satisfies ProviderCompletion;
  return deepFreezeJson(completion as unknown as JsonValue) as unknown as ProviderCompletion;
}

export function providerErrorCodeFromRuntime(code: string): RuntimeProviderErrorCode {
  if (!isRuntimeProviderErrorCode(code)) invalid();
  return code;
}
