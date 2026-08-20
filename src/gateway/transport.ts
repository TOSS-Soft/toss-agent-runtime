import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  type JsonLimits,
  type JsonValue,
} from "../protocol/json.js";
import { RuntimeProviderError } from "../providers/errors.js";
import type {
  ProviderRouteIdentity,
  ProviderRouteRequirement,
  ProviderWireContext,
  ProviderWireResponse,
  ProviderWireStream,
  ProviderWireTransport,
} from "../providers/types.js";
import {
  hashProviderRouteRequirement,
  normalizeProviderRouteRequirement,
  parseAgentgatewayAttestation,
  requireExecutableRoute,
} from "./attestation.js";
import { createAgentgatewayClient, readBoundedAgentgatewayResponse } from "./client.js";
import { createGatewayCredentialCoordinator } from "./credentials.js";
import { agentgatewayError, classifyAgentgatewayResponseStatus } from "./errors.js";
import { parseBoundedSse } from "./sse.js";
import type {
  AgentgatewayFetchOptions,
  CreateAgentgatewayTransportOptions,
  GatewayObservation,
  GatewayObservationStatusClass,
} from "./types.js";

const RESPONSE_BYTES = 8 * 1024 * 1024;
const RESPONSE_LIMITS: JsonLimits = Object.freeze({
  maxBytes: RESPONSE_BYTES,
  maxDepth: 64,
  maxMembers: 100_000,
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const TRACE_STATE_PATTERN = /^[\u0020-\u007e]{0,512}$/;

function endpointBase(endpoint: string): URL {
  let value: URL;
  try {
    value = new URL(endpoint);
  } catch {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  if (!value.pathname.endsWith("/")) value.pathname = `${value.pathname}/`;
  return value;
}

function ownDataRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    symbols.length !== 0 ||
    Object.keys(descriptors).sort().join("\u0000") !== [...keys].sort().join("\u0000")
  ) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
    }
    record[key] = descriptor.value;
  }
  return record;
}

function normalizedContext(value: ProviderWireContext): {
  readonly request_id: string;
  readonly run_id: string;
  readonly trace: Readonly<{
    trace_id: string;
    span_id: string;
    trace_flags: number;
    trace_state?: string;
  }>;
  readonly requirement: ProviderRouteRequirement;
  readonly signal: AbortSignal;
} {
  const context = ownDataRecord(value, [
    "request_id",
    "run_id",
    "trace",
    "requirement",
    "signal",
    "timeout_ms",
  ]);
  const traceKeys =
    typeof context.trace === "object" &&
    context.trace !== null &&
    Object.hasOwn(context.trace, "trace_state")
      ? ["trace_id", "span_id", "trace_flags", "trace_state"]
      : ["trace_id", "span_id", "trace_flags"];
  const trace = ownDataRecord(context.trace, traceKeys);
  if (
    typeof context.request_id !== "string" ||
    !UUID_PATTERN.test(context.request_id) ||
    typeof context.run_id !== "string" ||
    !IDENTIFIER_PATTERN.test(context.run_id) ||
    !(context.signal instanceof AbortSignal) ||
    context.signal.aborted ||
    !Number.isSafeInteger(context.timeout_ms) ||
    Number(context.timeout_ms) < 1 ||
    typeof trace.trace_id !== "string" ||
    !TRACE_ID_PATTERN.test(trace.trace_id) ||
    typeof trace.span_id !== "string" ||
    !SPAN_ID_PATTERN.test(trace.span_id) ||
    !Number.isSafeInteger(trace.trace_flags) ||
    Number(trace.trace_flags) < 0 ||
    Number(trace.trace_flags) > 255 ||
    (trace.trace_state !== undefined &&
      (typeof trace.trace_state !== "string" ||
        !TRACE_STATE_PATTERN.test(trace.trace_state) ||
        trace.trace_state.trim() !== trace.trace_state))
  ) {
    if (context.signal instanceof AbortSignal && context.signal.aborted) {
      throw agentgatewayError("RUNTIME_PROVIDER_CANCELLED");
    }
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  return Object.freeze({
    request_id: context.request_id,
    run_id: context.run_id,
    trace: Object.freeze({
      trace_id: trace.trace_id,
      span_id: trace.span_id,
      trace_flags: Number(trace.trace_flags),
      ...(trace.trace_state === undefined ? {} : { trace_state: trace.trace_state }),
    }),
    requirement: normalizeProviderRouteRequirement(context.requirement),
    signal: context.signal,
  });
}

interface FrozenJsonState {
  members: number;
  readonly seen: WeakSet<object>;
}

function isDeepFrozenPlainJson(
  value: unknown,
  state: FrozenJsonState = { members: 0, seen: new WeakSet() },
  depth = 0,
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object" || depth > RESPONSE_LIMITS.maxDepth || state.seen.has(value)) {
    return false;
  }
  let frozen: boolean;
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let symbols: readonly symbol[];
  try {
    frozen = Object.isFrozen(value);
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return false;
  }
  if (!frozen || symbols.length !== 0) return false;
  state.seen.add(value);

  if (Array.isArray(value)) {
    const lengthDescriptor = descriptors.length;
    if (
      lengthDescriptor === undefined ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      Number(lengthDescriptor.value) < 0
    ) {
      return false;
    }
    const length = Number(lengthDescriptor.value);
    if (Object.keys(descriptors).length !== length + 1) return false;
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      state.members += 1;
      if (
        state.members > RESPONSE_LIMITS.maxMembers ||
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !isDeepFrozenPlainJson(descriptor.value, state, depth + 1)
      ) {
        return false;
      }
    }
    return true;
  }

  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const descriptor of Object.values(descriptors)) {
    state.members += 1;
    if (
      state.members > RESPONSE_LIMITS.maxMembers ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !isDeepFrozenPlainJson(descriptor.value, state, depth + 1)
    ) {
      return false;
    }
  }
  return true;
}

function fixedResponseHeaders(options: {
  readonly token: string;
  readonly context: ReturnType<typeof normalizedContext>;
  readonly capabilityRevision: number;
  readonly capabilityHash: `sha256:${string}`;
  readonly requirementHash: `sha256:${string}`;
  readonly accept: "application/json" | "text/event-stream";
}): Headers {
  const headers = new Headers();
  headers.set("accept", options.accept);
  headers.set("authorization", `Bearer ${options.token}`);
  headers.set("content-type", "application/json");
  headers.set(
    "traceparent",
    `00-${options.context.trace.trace_id}-${options.context.trace.span_id}-${options.context.trace.trace_flags.toString(16).padStart(2, "0")}`,
  );
  if (options.context.trace.trace_state !== undefined) {
    headers.set("tracestate", options.context.trace.trace_state);
  }
  headers.set("x-toss-run-id", options.context.run_id);
  headers.set("x-toss-request-id", options.context.request_id);
  headers.set("x-toss-capability-revision", String(options.capabilityRevision));
  headers.set("x-toss-capability-document-sha256", options.capabilityHash);
  headers.set("x-toss-requirement-sha256", options.requirementHash);
  return headers;
}

function normalizeFailure(error: unknown, signal: AbortSignal): RuntimeProviderError {
  if (signal.aborted) return agentgatewayError("RUNTIME_PROVIDER_CANCELLED");
  if (error instanceof RuntimeProviderError) return error;
  return agentgatewayError("RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE");
}

function classifyResponseFailure(response: Response): RuntimeProviderError {
  let source: unknown = null;
  if (response.status >= 500 && response.status <= 599) {
    try {
      source = response.headers.get("x-toss-error-source");
    } catch {
      source = null;
    }
  }
  return classifyAgentgatewayResponseStatus(response.status, source);
}

function rejectRedirectedResponse(response: Response, expectedUrl: string): void {
  let redirected: boolean;
  let responseUrl: string;
  try {
    redirected = response.redirected;
    responseUrl = response.url;
  } catch {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE");
  }
  if (redirected || (responseUrl.length > 0 && responseUrl !== expectedUrl)) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE");
  }
}

async function cancelResponseBody(response: Response | undefined): Promise<void> {
  if (response?.body === null || response?.body === undefined) return;
  try {
    await response.body.cancel();
  } catch {
    // The stable request outcome owns failure precedence.
  }
}

function responseContentType(response: Response): string | null {
  let value: unknown;
  try {
    value = response.headers.get("content-type");
  } catch {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  return typeof value === "string" ? value : null;
}

const STREAM_EVENT_TYPES = new Set([
  "error",
  "response.completed",
  "response.created",
  "response.function_call_arguments.delta",
  "response.output_item.added",
  "response.output_text.delta",
  "response.refusal.delta",
]);

function streamEventType(value: JsonValue): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const descriptor = descriptors.type;
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    typeof descriptor.value !== "string" ||
    !STREAM_EVENT_TYPES.has(descriptor.value)
  ) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  return descriptor.value;
}

interface PendingObservation {
  readonly start: number | null;
  readonly run_id: string;
  readonly request_id: string;
  readonly streaming: boolean;
  readonly request_bytes: number;
  readonly message_count: number;
  readonly content_block_count: number;
  readonly tool_count: number;
  route_id: string | null;
  response_bytes: number;
  status_class: GatewayObservationStatusClass;
  emitted: boolean;
}

function safeMonotonicNow(options: CreateAgentgatewayTransportOptions): number | null {
  try {
    const value = options.monotonicNow();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function arrayLength(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
  return Number.isSafeInteger(length) && Number(length) >= 0 ? Number(length) : 0;
}

function requestStructure(input: JsonValue): {
  readonly message_count: number;
  readonly content_block_count: number;
  readonly tool_count: number;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { message_count: 0, content_block_count: 0, tool_count: 0 };
  }
  const root = Object.getOwnPropertyDescriptors(input);
  const entries: unknown = root.input?.value;
  let messageCount = 0;
  let contentBlockCount = 0;
  if (Array.isArray(entries)) {
    const descriptors = Object.getOwnPropertyDescriptors(entries);
    for (let index = 0; index < entries.length; index += 1) {
      const entry: unknown = descriptors[String(index)]?.value;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const fields = Object.getOwnPropertyDescriptors(entry);
      const content: unknown = fields.content?.value;
      if (typeof fields.role?.value === "string" && Array.isArray(content)) {
        messageCount += 1;
        contentBlockCount += arrayLength(content);
      } else if (fields.type?.value === "function_call_output") {
        contentBlockCount += 1;
      }
    }
  }
  return {
    message_count: messageCount,
    content_block_count: contentBlockCount,
    tool_count: arrayLength(root.tools?.value),
  };
}

function createPendingObservation(options: {
  readonly transport: CreateAgentgatewayTransportOptions;
  readonly context: ReturnType<typeof normalizedContext>;
  readonly input: JsonValue;
  readonly body: string;
  readonly streaming: boolean;
}): PendingObservation | null {
  if (
    options.transport.selectedProfile.profile.body_observability !== "redacted-metadata" ||
    typeof options.transport.onObservation !== "function"
  ) {
    return null;
  }
  try {
    const structure = requestStructure(options.input);
    return {
      start: safeMonotonicNow(options.transport),
      run_id: options.context.run_id,
      request_id: options.context.request_id,
      streaming: options.streaming,
      request_bytes: Buffer.byteLength(options.body, "utf8"),
      response_bytes: 0,
      message_count: structure.message_count,
      content_block_count: structure.content_block_count,
      tool_count: structure.tool_count,
      route_id: null,
      status_class: "network",
      emitted: false,
    };
  } catch {
    return null;
  }
}

function statusClass(status: number): GatewayObservationStatusClass {
  if (status >= 200 && status <= 599) {
    return `${Math.floor(status / 100)}xx` as GatewayObservationStatusClass;
  }
  return "network";
}

function finishObservation(
  options: CreateAgentgatewayTransportOptions,
  pending: PendingObservation | null,
): void {
  if (pending === null || pending.emitted || typeof options.onObservation !== "function") return;
  pending.emitted = true;
  const end = safeMonotonicNow(options);
  const elapsed = pending.start === null || end === null ? Number.NaN : end - pending.start;
  const rounded = Number.isFinite(elapsed) && elapsed >= 0 ? Math.floor(elapsed) : 0;
  const duration = Number.isSafeInteger(rounded) ? rounded : 0;
  const observation: GatewayObservation = Object.freeze({
    run_id: pending.run_id,
    request_id: pending.request_id,
    route_id: pending.route_id,
    streaming: pending.streaming,
    request_bytes: pending.request_bytes,
    response_bytes: pending.response_bytes,
    message_count: pending.message_count,
    content_block_count: pending.content_block_count,
    tool_count: pending.tool_count,
    status_class: pending.status_class,
    duration_ms: duration,
  });
  try {
    options.onObservation(observation);
  } catch {
    // Observability cannot change the provider outcome.
  }
}

async function* validatedStreamEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  pending: PendingObservation | null,
  options: CreateAgentgatewayTransportOptions,
): AsyncIterable<JsonValue> {
  let terminal = false;
  try {
    for await (const event of parseBoundedSse(body, signal, (total) => {
      if (pending !== null) pending.response_bytes = total;
    })) {
      if (terminal) throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
      const type = streamEventType(event);
      if (type === "response.completed" || type === "error") terminal = true;
      yield event;
    }
    if (!terminal) throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  } finally {
    finishObservation(options, pending);
  }
}

export function createAgentgatewayTransport(
  options: CreateAgentgatewayTransportOptions,
): ProviderWireTransport {
  if (!IDENTIFIER_PATTERN.test(options.selectedProfile.name)) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  const base = endpointBase(options.selectedProfile.profile.endpoint);
  const responseUrl = new URL("v1/responses", base).href;
  const credentials = createGatewayCredentialCoordinator({
    provider: options.credentialProvider,
    now: options.now,
  });
  const client = createAgentgatewayClient({
    selectedProfile: options.selectedProfile,
    credentialReference: options.credentialReference,
    credentials,
    fetch: options.fetch,
    now: options.now,
  });

  async function performRequest(
    input: JsonValue,
    wireContext: ProviderWireContext,
    streaming: boolean,
  ): Promise<{
    readonly response: Response;
    readonly context: ReturnType<typeof normalizedContext>;
    readonly routeIdentity: ProviderRouteIdentity;
    readonly observation: PendingObservation | null;
  }> {
    let context: ReturnType<typeof normalizedContext>;
    let body: string;
    try {
      context = normalizedContext(wireContext);
      if (context.requirement.streaming !== streaming || !isDeepFrozenPlainJson(input)) {
        throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
      }
      body = canonicalJson(input, RESPONSE_LIMITS);
    } catch (error) {
      if (error instanceof RuntimeProviderError) throw error;
      throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
    }
    const observation = createPendingObservation({
      transport: options,
      context,
      input,
      body,
      streaming,
    });

    let response: Response | undefined;
    try {
      const capability = await client.discover(context.signal);
      requireExecutableRoute(capability, context.requirement);
      const requirementHash = hashProviderRouteRequirement(context.requirement);
      const lease = await credentials.resolve(options.credentialReference, context.signal);
      const request: AgentgatewayFetchOptions = {
        method: "POST",
        headers: fixedResponseHeaders({
          token: lease.token,
          context,
          capabilityRevision: capability.gateway.revision,
          capabilityHash: capability.document_hash,
          requirementHash,
          accept: streaming ? "text/event-stream" : "application/json",
        }),
        redirect: "error",
        signal: context.signal,
        body,
      };
      response = await options.fetch(responseUrl, request);
      if (observation !== null) observation.status_class = statusClass(response.status);
      rejectRedirectedResponse(response, responseUrl);
      if (response.status < 200 || response.status >= 300) {
        throw classifyResponseFailure(response);
      }
      const routeIdentity = parseAgentgatewayAttestation({
        headers: response.headers,
        capability,
        requirement: context.requirement,
        requirementHash,
        gatewayProfile: options.selectedProfile.name,
      });
      if (observation !== null) observation.route_id = routeIdentity.route_id;
      return { response, context, routeIdentity, observation };
    } catch (error) {
      await cancelResponseBody(response);
      finishObservation(options, observation);
      throw normalizeFailure(error, context.signal);
    }
  }

  return Object.freeze({
    async complete(
      input: JsonValue,
      wireContext: ProviderWireContext,
    ): Promise<ProviderWireResponse> {
      const prepared = await performRequest(input, wireContext, false);
      try {
        let payload: JsonValue;
        try {
          payload = deepFreezeJson(
            parseJsonBytes(
              await readBoundedAgentgatewayResponse(prepared.response, RESPONSE_BYTES, (total) => {
                if (prepared.observation !== null) prepared.observation.response_bytes = total;
              }),
              RESPONSE_LIMITS,
            ),
            RESPONSE_LIMITS,
          );
        } catch (error) {
          if (error instanceof RuntimeProviderError) throw error;
          throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
        }
        finishObservation(options, prepared.observation);
        return Object.freeze({ payload, route_identity: prepared.routeIdentity });
      } catch (error) {
        finishObservation(options, prepared.observation);
        throw normalizeFailure(error, prepared.context.signal);
      }
    },
    async stream(input: JsonValue, context: ProviderWireContext): Promise<ProviderWireStream> {
      const prepared = await performRequest(input, context, true);
      const contentType = responseContentType(prepared.response);
      if (!/^text\/event-stream(?:;[ \t]*charset=utf-8)?$/iu.test(contentType ?? "")) {
        await cancelResponseBody(prepared.response);
        finishObservation(options, prepared.observation);
        throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
      }
      if (prepared.response.body === null) {
        finishObservation(options, prepared.observation);
        throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
      }
      return Object.freeze({
        route_identity: prepared.routeIdentity,
        events: validatedStreamEvents(
          prepared.response.body,
          prepared.context.signal,
          prepared.observation,
          options,
        ),
      });
    },
    health() {
      return client.health();
    },
  });
}
