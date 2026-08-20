import { canonicalJson, deepFreezeJson, parseJsonBytes, type JsonValue } from "../protocol/json.js";
import type { TraceContext } from "../protocol/types.js";
import { createProtocolValidator } from "../protocol/validator.js";
import { collectProviderEvents, parseProviderEvent } from "./contracts.js";
import { RuntimeProviderError, type RuntimeProviderErrorCode } from "./errors.js";
import type {
  ProviderAdapter,
  ProviderAdapterCapabilities,
  ProviderEventData,
  ProviderEventV1,
  ProviderExecutionOptions,
  ProviderHealth,
  ProviderKind,
  ProviderRequest,
  ProviderRouteIdentity,
  ProviderRouteRequirement,
  ProviderWireContext,
  ProviderWireTransport,
} from "./types.js";

export interface ProviderEventTemplate {
  readonly event_type: ProviderEventV1["event_type"];
  readonly data: ProviderEventData;
  readonly native_event: string;
  readonly lossy_fields?: readonly string[];
}

export interface ProviderMapper {
  readonly provider: ProviderKind;
  translate(request: ProviderRequest, stream: boolean): JsonValue;
  complete(native: unknown, request: ProviderRequest): readonly ProviderEventTemplate[];
  stream(
    native: unknown,
    request: ProviderRequest,
    state: Map<string, JsonValue>,
  ): readonly ProviderEventTemplate[];
}

export interface CreateProviderAdapterOptions {
  readonly transport: ProviderWireTransport;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly now: () => Date;
  readonly createEventId: () => string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const protocolValidator = createProtocolValidator();

function providerError(code: RuntimeProviderErrorCode): never {
  throw new RuntimeProviderError(code);
}

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function exactKeys(value: { readonly [key: string]: JsonValue }, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key)))
    providerError("RUNTIME_PROVIDER_INVALID");
}

function safeString(value: JsonValue | undefined, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function ownDataProperties(
  value: unknown,
  allowed: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    providerError("RUNTIME_PROVIDER_INVALID");
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    providerError("RUNTIME_PROVIDER_INVALID");
  }
  if (prototype !== Object.prototype) providerError("RUNTIME_PROVIDER_INVALID");
  const accepted = new Set(allowed);
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!accepted.has(key) || descriptor.get !== undefined || descriptor.set !== undefined) {
      providerError("RUNTIME_PROVIDER_INVALID");
    }
    result[key] = descriptor.value;
  }
  return result;
}

interface NormalizedExecution {
  readonly run_id: string;
  readonly trace: TraceContext;
  readonly signal?: AbortSignal;
}

function normalizeExecution(value: unknown): NormalizedExecution {
  const execution = ownDataProperties(value, ["run_id", "trace", "signal"]);
  if (typeof execution.run_id !== "string" || !RUN_ID_PATTERN.test(execution.run_id)) {
    providerError("RUNTIME_PROVIDER_INVALID");
  }
  const trace = ownDataProperties(execution.trace, [
    "trace_id",
    "span_id",
    "trace_flags",
    "trace_state",
  ]);
  const traceCandidate = {
    trace_id: trace.trace_id,
    span_id: trace.span_id,
    trace_flags: trace.trace_flags,
    ...(trace.trace_state === undefined ? {} : { trace_state: trace.trace_state }),
  };
  const traceResult = protocolValidator.validateFragment("trace-context", traceCandidate);
  if (!traceResult.ok) providerError("RUNTIME_PROVIDER_INVALID");
  if (execution.signal !== undefined && !(execution.signal instanceof AbortSignal)) {
    providerError("RUNTIME_PROVIDER_INVALID");
  }
  return Object.freeze({
    run_id: execution.run_id,
    trace: traceResult.value as unknown as TraceContext,
    ...(execution.signal === undefined ? {} : { signal: execution.signal }),
  });
}

function routeRequirement(request: ProviderRequest, streaming: boolean): ProviderRouteRequirement {
  return Object.freeze({
    schema_version: "gateway-route-requirement.v1",
    alias: request.model,
    tools: (request.tools?.length ?? 0) > 0,
    json_schema: request.response_format?.type === "json-schema",
    vision: request.messages.some((message) =>
      message.content.some((block) => block.type === "image"),
    ),
    reasoning: request.reasoning !== undefined && request.reasoning !== "none",
    streaming,
    max_output_tokens: request.max_output_tokens,
  });
}

function normalizeRequest(input: ProviderRequest): ProviderRequest {
  let candidate: JsonValue;
  try {
    candidate = deepFreezeJson(parseJsonBytes(canonicalJson(input)));
  } catch {
    providerError("RUNTIME_PROVIDER_INVALID");
  }
  if (!isRecord(candidate)) providerError("RUNTIME_PROVIDER_INVALID");
  exactKeys(candidate, [
    "request_id",
    "model",
    "messages",
    "max_output_tokens",
    "timeout_ms",
    "tools",
    "response_format",
    "reasoning",
    "temperature",
  ]);
  if (
    typeof candidate.request_id !== "string" ||
    !UUID_PATTERN.test(candidate.request_id) ||
    typeof candidate.model !== "string" ||
    !MODEL_PATTERN.test(candidate.model) ||
    !Number.isSafeInteger(candidate.max_output_tokens) ||
    (candidate.max_output_tokens as number) < 1 ||
    !Number.isSafeInteger(candidate.timeout_ms) ||
    (candidate.timeout_ms as number) < 1 ||
    (candidate.timeout_ms as number) > 600_000 ||
    !isJsonArray(candidate.messages) ||
    candidate.messages.length < 1 ||
    candidate.messages.length > 1024
  ) {
    providerError("RUNTIME_PROVIDER_INVALID");
  }
  for (const message of candidate.messages) {
    if (!isRecord(message)) providerError("RUNTIME_PROVIDER_INVALID");
    exactKeys(message, ["role", "content"]);
    if (
      typeof message.role !== "string" ||
      !["system", "user", "assistant", "tool"].includes(message.role) ||
      !isJsonArray(message.content) ||
      message.content.length < 1 ||
      message.content.length > 128
    ) {
      providerError("RUNTIME_PROVIDER_INVALID");
    }
    for (const block of message.content) {
      if (!isRecord(block) || typeof block.type !== "string") {
        providerError("RUNTIME_PROVIDER_INVALID");
      }
      if (block.type === "text") {
        exactKeys(block, ["type", "text"]);
        if (!safeString(block.text, 1_048_576)) providerError("RUNTIME_PROVIDER_INVALID");
      } else if (block.type === "image") {
        exactKeys(block, ["type", "url", "media_type"]);
        if (!safeString(block.url, 4096) || !safeString(block.media_type, 128)) {
          providerError("RUNTIME_PROVIDER_INVALID");
        }
      } else if (block.type === "tool-result") {
        exactKeys(block, ["type", "tool_call_id", "content"]);
        if (!safeString(block.tool_call_id, 256) || !safeString(block.content, 1_048_576)) {
          providerError("RUNTIME_PROVIDER_INVALID");
        }
      } else {
        providerError("RUNTIME_PROVIDER_INVALID");
      }
    }
  }
  if (candidate.tools !== undefined) {
    if (!isJsonArray(candidate.tools) || candidate.tools.length > 128) {
      providerError("RUNTIME_PROVIDER_INVALID");
    }
    for (const tool of candidate.tools) {
      if (!isRecord(tool)) providerError("RUNTIME_PROVIDER_INVALID");
      exactKeys(tool, ["name", "description", "input_schema"]);
      if (
        typeof tool.name !== "string" ||
        !NAME_PATTERN.test(tool.name) ||
        (tool.description !== undefined && !safeString(tool.description, 4096)) ||
        !isRecord(tool.input_schema)
      ) {
        providerError("RUNTIME_PROVIDER_INVALID");
      }
    }
  }
  if (candidate.response_format !== undefined) {
    if (
      !isRecord(candidate.response_format) ||
      typeof candidate.response_format.type !== "string"
    ) {
      providerError("RUNTIME_PROVIDER_INVALID");
    }
    if (candidate.response_format.type === "text") {
      exactKeys(candidate.response_format, ["type"]);
    } else if (candidate.response_format.type === "json-schema") {
      exactKeys(candidate.response_format, ["type", "name", "schema"]);
      if (
        typeof candidate.response_format.name !== "string" ||
        !NAME_PATTERN.test(candidate.response_format.name) ||
        !isRecord(candidate.response_format.schema)
      ) {
        providerError("RUNTIME_PROVIDER_INVALID");
      }
    } else {
      providerError("RUNTIME_PROVIDER_INVALID");
    }
  }
  if (
    candidate.reasoning !== undefined &&
    (typeof candidate.reasoning !== "string" ||
      !["none", "low", "medium", "high"].includes(candidate.reasoning))
  ) {
    providerError("RUNTIME_PROVIDER_INVALID");
  }
  if (
    candidate.temperature !== undefined &&
    (typeof candidate.temperature !== "number" ||
      candidate.temperature < 0 ||
      candidate.temperature > 2)
  ) {
    providerError("RUNTIME_PROVIDER_INVALID");
  }
  return candidate as unknown as ProviderRequest;
}

function preflight(
  request: ProviderRequest,
  capabilities: ProviderAdapterCapabilities,
  stream: boolean,
): void {
  if (request.max_output_tokens > capabilities.max_output_tokens) {
    providerError("RUNTIME_PROVIDER_UNSUPPORTED");
  }
  if ((request.tools?.length ?? 0) > 0 && !capabilities.tools) {
    providerError("RUNTIME_PROVIDER_UNSUPPORTED");
  }
  if (request.response_format?.type === "json-schema" && !capabilities.json_schema) {
    providerError("RUNTIME_PROVIDER_UNSUPPORTED");
  }
  if (
    request.messages.some((message) => message.content.some((block) => block.type === "image")) &&
    !capabilities.vision
  ) {
    providerError("RUNTIME_PROVIDER_UNSUPPORTED");
  }
  if (request.reasoning !== undefined && request.reasoning !== "none" && !capabilities.reasoning) {
    providerError("RUNTIME_PROVIDER_UNSUPPORTED");
  }
  if (stream && !capabilities.streaming) providerError("RUNTIME_PROVIDER_UNSUPPORTED");
}

export interface ProviderFailureDescriptor {
  readonly status?: number;
  readonly code?: string;
}

export function classifyProviderFailure(
  descriptor: ProviderFailureDescriptor,
): RuntimeProviderError {
  if (descriptor.status === 401 || descriptor.status === 403) {
    return new RuntimeProviderError("RUNTIME_PROVIDER_AUTHENTICATION");
  }
  if (descriptor.status === 429 || descriptor.code === "rate_limit") {
    return new RuntimeProviderError("RUNTIME_PROVIDER_RATE_LIMIT");
  }
  if (descriptor.status === 408 || descriptor.code === "timeout") {
    return new RuntimeProviderError("RUNTIME_PROVIDER_TIMEOUT");
  }
  if (
    descriptor.code === "content_filter" ||
    descriptor.code === "refusal" ||
    descriptor.code === "safety"
  ) {
    return new RuntimeProviderError("RUNTIME_PROVIDER_REFUSAL");
  }
  if (
    descriptor.status !== undefined &&
    (descriptor.status === 409 || descriptor.status === 425 || descriptor.status >= 500)
  ) {
    return new RuntimeProviderError("RUNTIME_PROVIDER_TRANSIENT");
  }
  if (descriptor.status !== undefined && descriptor.status >= 400 && descriptor.status < 500) {
    return new RuntimeProviderError("RUNTIME_PROVIDER_INVALID");
  }
  return new RuntimeProviderError("RUNTIME_PROVIDER_INTERNAL");
}

function failureDescriptor(error: unknown): ProviderFailureDescriptor {
  if (typeof error !== "object" || error === null) return {};
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(error);
  } catch {
    return {};
  }
  const status: unknown = descriptors.status?.value;
  const codeValue: unknown = descriptors.code?.value;
  const typeValue: unknown = descriptors.type?.value;
  const code = codeValue ?? typeValue;
  return {
    ...(typeof status === "number" && Number.isSafeInteger(status) ? { status } : {}),
    ...(typeof code === "string" && code.length <= 128 ? { code } : {}),
  };
}

function safeDate(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    providerError("RUNTIME_PROVIDER_INTERNAL");
  return value.toISOString();
}

function makeEvent(
  mapper: ProviderMapper,
  request: ProviderRequest,
  template: ProviderEventTemplate,
  sequence: number,
  options: CreateProviderAdapterOptions,
): ProviderEventV1 {
  const candidate = {
    protocol_version: "runtime-contract.v1",
    schema_version: "provider-event.v1",
    document_type: "provider-event",
    event_id: options.createEventId(),
    request_id: request.request_id,
    sequence,
    occurred_at: safeDate(options.now),
    provider: mapper.provider,
    model: request.model,
    event_type: template.event_type,
    provenance: {
      native_event: template.native_event,
      lossy_fields: [...(template.lossy_fields ?? [])].sort(),
    },
    data: template.data,
  } as ProviderEventV1;
  const result = parseProviderEvent(canonicalJson(candidate));
  if (!result.ok) providerError("RUNTIME_PROVIDER_INTERNAL");
  return result.value;
}

function withRouteIdentity(
  template: ProviderEventTemplate,
  routeIdentity: ProviderRouteIdentity | null,
): ProviderEventTemplate {
  if (routeIdentity === null || template.event_type !== "response-start") return template;
  return {
    ...template,
    data: { ...template.data, route_identity: routeIdentity },
  };
}

interface DeadlineScope {
  readonly context: ProviderWireContext;
  readonly aborted: Promise<never>;
  readonly cleanup: () => void;
}

function deadlineScope(
  request: ProviderRequest,
  execution: NormalizedExecution,
  requirement: ProviderRouteRequirement,
): DeadlineScope {
  if (execution.signal?.aborted) providerError("RUNTIME_PROVIDER_CANCELLED");
  const controller = new AbortController();
  let rejectAbort: ((reason: RuntimeProviderError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    rejectAbort?.(new RuntimeProviderError("RUNTIME_PROVIDER_TIMEOUT"));
    controller.abort();
  }, request.timeout_ms);
  timer.unref?.();
  const onAbort = () => {
    if (timedOut) return;
    rejectAbort?.(new RuntimeProviderError("RUNTIME_PROVIDER_CANCELLED"));
    controller.abort();
  };
  execution.signal?.addEventListener("abort", onAbort, { once: true });
  return {
    context: {
      request_id: request.request_id,
      run_id: execution.run_id,
      trace: execution.trace,
      requirement,
      signal: controller.signal,
      timeout_ms: request.timeout_ms,
    },
    aborted,
    cleanup: () => {
      clearTimeout(timer);
      execution.signal?.removeEventListener("abort", onAbort);
    },
  };
}

function normalizedHealth(value: unknown): ProviderHealth {
  if (typeof value !== "object" || value === null) return Object.freeze({ status: "unavailable" });
  const status: unknown = Object.getOwnPropertyDescriptor(value, "status")?.value;
  if (status === "healthy" || status === "degraded" || status === "unavailable") {
    return Object.freeze({ status });
  }
  return Object.freeze({ status: "unavailable" });
}

export function createProviderAdapter(
  mapper: ProviderMapper,
  options: CreateProviderAdapterOptions,
): ProviderAdapter {
  if (options.capabilities.provider !== mapper.provider) {
    providerError("RUNTIME_PROVIDER_INVALID");
  }
  const capabilities = Object.freeze({ ...options.capabilities });
  return Object.freeze({
    provider: mapper.provider,
    capabilities,
    async complete(input: ProviderRequest, execution: ProviderExecutionOptions) {
      const request = normalizeRequest(input);
      const correlated = normalizeExecution(execution);
      preflight(request, capabilities, false);
      const scope = deadlineScope(request, correlated, routeRequirement(request, false));
      try {
        const wireRequest = mapper.translate(request, false);
        const response = await Promise.race([
          options.transport.complete(wireRequest, scope.context),
          scope.aborted,
        ]);
        const events = mapper
          .complete(response.payload, request)
          .map((template, sequence) =>
            makeEvent(
              mapper,
              request,
              sequence === 0 ? withRouteIdentity(template, response.route_identity) : template,
              sequence,
              options,
            ),
          );
        return collectProviderEvents(events);
      } catch (error) {
        if (error instanceof RuntimeProviderError) throw error;
        throw classifyProviderFailure(failureDescriptor(error));
      } finally {
        scope.cleanup();
      }
    },
    async *stream(input: ProviderRequest, execution: ProviderExecutionOptions) {
      const request = normalizeRequest(input);
      const correlated = normalizeExecution(execution);
      preflight(request, capabilities, true);
      const scope = deadlineScope(request, correlated, routeRequirement(request, true));
      let sequence = 0;
      const state = new Map<string, JsonValue>();
      let iterator: AsyncIterator<unknown> | undefined;
      let iteratorDone = false;
      let routeInjected = false;
      try {
        const wireRequest = mapper.translate(request, true);
        const response = await Promise.race([
          options.transport.stream(wireRequest, scope.context),
          scope.aborted,
        ]);
        iterator = response.events[Symbol.asyncIterator]();
        while (true) {
          const next = await Promise.race([iterator.next(), scope.aborted]);
          if (next.done) {
            iteratorDone = true;
            break;
          }
          const templates = mapper.stream(next.value, request, state);
          if (sequence === 0 && templates[0]?.event_type === "response-error") {
            yield makeEvent(
              mapper,
              request,
              withRouteIdentity(
                {
                  event_type: "response-start",
                  data: {},
                  native_event: templates[0].native_event,
                },
                response.route_identity,
              ),
              sequence,
              options,
            );
            routeInjected = response.route_identity !== null;
            sequence += 1;
          }
          for (const template of templates) {
            const routed =
              !routeInjected && template.event_type === "response-start"
                ? withRouteIdentity(template, response.route_identity)
                : template;
            if (template.event_type === "response-start") routeInjected = true;
            yield makeEvent(mapper, request, routed, sequence, options);
            sequence += 1;
          }
        }
      } catch (error) {
        if (error instanceof RuntimeProviderError) throw error;
        throw classifyProviderFailure(failureDescriptor(error));
      } finally {
        if (!iteratorDone && iterator?.return !== undefined) {
          try {
            await iterator.return();
          } catch {
            // The stable provider result already owns cancellation/error precedence.
          }
        }
        scope.cleanup();
      }
    },
    async cancel(requestId: string) {
      if (!UUID_PATTERN.test(requestId)) providerError("RUNTIME_PROVIDER_INVALID");
      try {
        await options.transport.cancel?.(requestId);
      } catch (error) {
        throw classifyProviderFailure(failureDescriptor(error));
      }
    },
    async health() {
      if (options.transport.health === undefined) return Object.freeze({ status: "unavailable" });
      try {
        return normalizedHealth(await options.transport.health());
      } catch {
        return Object.freeze({ status: "unavailable" });
      }
    },
  });
}
