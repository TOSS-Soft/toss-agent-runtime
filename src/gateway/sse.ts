import {
  deepFreezeJson,
  parseJsonBytes,
  type JsonLimits,
  type JsonValue,
} from "../protocol/json.js";
import { RuntimeProviderError } from "../providers/errors.js";
import { agentgatewayError } from "./errors.js";

const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_EVENTS = 10_000;
const EVENT_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: MAX_EVENT_BYTES,
  maxDepth: 64,
  maxMembers: 10_000,
});

interface SseState {
  eventBytes: number;
  events: number;
  done: boolean;
  readonly data: string[];
}

function invalid(): RuntimeProviderError {
  return agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
}

function lineBytes(rawLine: string): number {
  return Buffer.byteLength(rawLine, "utf8") + 1;
}

function parseLine(rawLine: string, state: SseState): JsonValue | null {
  state.eventBytes += lineBytes(rawLine);
  if (state.eventBytes > MAX_EVENT_BYTES) throw invalid();
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (line.length === 0) {
    if (state.data.length === 0) {
      state.eventBytes = 0;
      return null;
    }
    const data = state.data.join("\n");
    state.data.length = 0;
    state.eventBytes = 0;
    if (state.done) throw invalid();
    if (data === "[DONE]") {
      state.done = true;
      return null;
    }
    state.events += 1;
    if (state.events > MAX_EVENTS) throw invalid();
    try {
      return deepFreezeJson(parseJsonBytes(data, EVENT_JSON_LIMITS), EVENT_JSON_LIMITS);
    } catch {
      throw invalid();
    }
  }
  if (state.done) throw invalid();
  if (line.startsWith(":")) return null;
  const separator = line.indexOf(":");
  const field = separator === -1 ? line : line.slice(0, separator);
  let value = separator === -1 ? "" : line.slice(separator + 1);
  if (value.startsWith(" ")) value = value.slice(1);
  if (field === "data") {
    state.data.push(value);
    return null;
  }
  if (field === "event" || field === "id" || field === "retry") return null;
  throw invalid();
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The stable stream outcome owns failure precedence.
  }
}

export async function* parseBoundedSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onBytes?: (total: number) => void,
): AsyncIterable<JsonValue> {
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw agentgatewayError("RUNTIME_PROVIDER_CANCELLED");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const state: SseState = { eventBytes: 0, events: 0, done: false, data: [] };
  let totalBytes = 0;
  let buffer = "";
  let rejectAborted!: (reason: RuntimeProviderError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  void aborted.catch(() => undefined);
  const onAbort = () => rejectAborted(agentgatewayError("RUNTIME_PROVIDER_CANCELLED"));
  signal.addEventListener("abort", onAbort, { once: true });

  function* processLines(): Generator<JsonValue> {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const rawLine = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const event = parseLine(rawLine, state);
      if (event !== null) yield event;
    }
    if (state.eventBytes + Buffer.byteLength(buffer, "utf8") > MAX_EVENT_BYTES) {
      throw invalid();
    }
  }

  try {
    for (;;) {
      const pending = reader.read();
      void pending.catch(() => undefined);
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await Promise.race([pending, aborted]);
      } catch (error) {
        if (error instanceof RuntimeProviderError) throw error;
        if (signal.aborted) throw agentgatewayError("RUNTIME_PROVIDER_CANCELLED");
        throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE");
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw invalid();
      totalBytes += result.value.byteLength;
      try {
        onBytes?.(totalBytes);
      } catch {
        // Internal measurement cannot change the SSE result.
      }
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) throw invalid();
      try {
        buffer += decoder.decode(result.value, { stream: true });
      } catch {
        throw invalid();
      }
      yield* processLines();
    }
    try {
      buffer += decoder.decode();
    } catch {
      throw invalid();
    }
    yield* processLines();
    if (buffer.length !== 0 || state.eventBytes !== 0 || state.data.length !== 0 || !state.done) {
      throw invalid();
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await cancelReader(reader);
    reader.releaseLock();
  }
}
