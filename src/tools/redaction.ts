import { canonicalJson, deepFreezeJson, parseJsonBytes, type JsonValue } from "../protocol/json.js";
import { hashToolResult, parseToolResult, validateStructuredToolOutput } from "./contracts.js";
import { RuntimeToolError, toolRuntimeError } from "./errors.js";
import { captureToolServerObservation } from "./identity.js";
import type { AuthorizedToolCall } from "./policy.js";
import type { NativeToolCallResult, ToolServerObservation } from "./transports/types.js";
import type { HashableToolResultV1, ToolResultContentV1, ToolResultV1 } from "./types.js";

const REDACTED = "[REDACTED]";
const SECRET_FIELD =
  /(?:authorization|api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|private[_-]?key|bearer)/iu;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+\-/]{0,255}$/u;

export interface NormalizeToolResultInput {
  readonly call: AuthorizedToolCall;
  readonly observation: ToolServerObservation;
  readonly result: NativeToolCallResult;
}

function invalid(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_RESULT_INVALID");
}

function schemaMismatch(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_SCHEMA_MISMATCH");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function capturedJson(value: JsonValue): JsonValue {
  try {
    return deepFreezeJson(parseJsonBytes(canonicalJson(value)));
  } catch {
    invalid();
  }
}

function decodedPointer(pointer: string): readonly string[] {
  if (!pointer.startsWith("/") || pointer.length > 512) invalid();
  return pointer
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~(?:[^01]|$)/u.test(token)) invalid();
      return token.replaceAll("~1", "/").replaceAll("~0", "~");
    });
}

function replaceAtPointer(value: JsonValue, tokens: readonly string[], index = 0): JsonValue {
  if (index === tokens.length) return REDACTED;
  const token = tokens[index]!;
  if (isJsonArray(value)) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) return value;
    const item = Number(token);
    if (!Number.isSafeInteger(item) || item >= value.length) return value;
    return value.map((child, childIndex) =>
      childIndex === item ? replaceAtPointer(child, tokens, index + 1) : child,
    );
  }
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, token)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === token ? replaceAtPointer(child, tokens, index + 1) : child,
    ]),
  );
}

export function redactJsonPointers(value: JsonValue, pointers: readonly string[]): JsonValue {
  let redacted = capturedJson(value);
  for (const pointer of pointers) redacted = replaceAtPointer(redacted, decodedPointer(pointer));
  return capturedJson(redacted);
}

function redactText(value: string): string {
  return value
    .replace(/\b(authorization\s*:\s*)(?:bearer\s+)?[^\s,;]+/giu, "$1[REDACTED]")
    .replace(
      /\b((?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?key|token)\s*[=:]\s*)["']?[^\s,;&"']+["']?/giu,
      "$1[REDACTED]",
    )
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED]");
}

function redactGeneric(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactText(value);
  if (isJsonArray(value)) return value.map((child) => redactGeneric(child));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SECRET_FIELD.test(key) ? REDACTED : redactGeneric(child),
    ]),
  );
}

export function redactGenericSecrets(value: JsonValue): JsonValue {
  return capturedJson(redactGeneric(capturedJson(value)));
}

function boundedString(value: unknown, maximumBytes: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    invalid();
  }
  return value;
}

function boundedBase64(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(maximumBytes / 3) * 4 ||
    !BASE64_PATTERN.test(value)
  ) {
    invalid();
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > maximumBytes || bytes.toString("base64") !== value) invalid();
  return value;
}

function mediaType(value: unknown): string {
  if (typeof value !== "string" || !MEDIA_TYPE_PATTERN.test(value)) invalid();
  return value;
}

function contentBytes(content: ToolResultContentV1): number {
  switch (content.type) {
    case "text":
      return Buffer.byteLength(content.text, "utf8");
    case "image":
    case "audio":
      return Buffer.from(content.data_base64, "base64").byteLength;
    case "resource-link":
      return Buffer.byteLength(content.uri + content.name + (content.mime_type ?? ""), "utf8");
    case "embedded-resource":
      return (
        Buffer.byteLength(content.uri + content.mime_type + (content.text ?? ""), "utf8") +
        (content.blob_base64 === null ? 0 : Buffer.from(content.blob_base64, "base64").byteLength)
      );
  }
}

interface NormalizedContent {
  readonly value: ToolResultContentV1;
  readonly observed_bytes: number;
}

function normalizeContent(raw: unknown, call: AuthorizedToolCall): NormalizedContent {
  if (!isRecord(raw) || typeof raw.type !== "string") invalid();
  const allowedKinds: readonly string[] = call.content_kinds;
  if (!allowedKinds.includes(raw.type)) {
    invalid();
  }
  const maximum = call.result_limits.content_block_bytes;
  let content: ToolResultContentV1;
  let observedBytes: number;
  switch (raw.type) {
    case "text": {
      if (!exactKeys(raw, ["text", "type"], ["annotations"])) invalid();
      const text = boundedString(raw.text, maximum, true);
      observedBytes = Buffer.byteLength(text, "utf8");
      content = Object.freeze({ type: "text", text: redactText(text) });
      break;
    }
    case "image":
    case "audio": {
      if (!exactKeys(raw, ["data_base64", "media_type", "type"], ["annotations"])) invalid();
      const data = boundedBase64(raw.data_base64, maximum);
      observedBytes = Buffer.from(data, "base64").byteLength;
      content = Object.freeze({
        type: raw.type,
        media_type: mediaType(raw.media_type),
        data_base64: data,
      });
      break;
    }
    case "resource-link": {
      if (!exactKeys(raw, ["mime_type", "name", "type", "uri"], ["annotations"])) invalid();
      const mime = raw.mime_type === null ? null : mediaType(raw.mime_type);
      const uri = boundedString(raw.uri, Math.min(4_096, maximum));
      const name = boundedString(raw.name, Math.min(1_024, maximum));
      observedBytes = Buffer.byteLength(uri + name + (mime ?? ""), "utf8");
      content = Object.freeze({
        type: "resource-link",
        uri: redactText(uri),
        name: redactText(name),
        mime_type: mime,
      });
      break;
    }
    case "embedded-resource": {
      if (
        !exactKeys(raw, ["blob_base64", "mime_type", "text", "type", "uri"], ["annotations"]) ||
        raw.mime_type === null ||
        (raw.text === null) === (raw.blob_base64 === null)
      ) {
        invalid();
      }
      const text = raw.text === null ? null : redactText(boundedString(raw.text, maximum, true));
      const blob = raw.blob_base64 === null ? null : boundedBase64(raw.blob_base64, maximum);
      const uri = boundedString(raw.uri, Math.min(4_096, maximum));
      const mime = mediaType(raw.mime_type);
      observedBytes =
        Buffer.byteLength(
          uri + mime + (raw.text === null ? "" : boundedString(raw.text, maximum, true)),
          "utf8",
        ) + (blob === null ? 0 : Buffer.from(blob, "base64").byteLength);
      content = Object.freeze({
        type: "embedded-resource",
        uri: redactText(uri),
        mime_type: mime,
        text,
        blob_base64: blob,
      });
      break;
    }
    default:
      return invalid();
  }
  if (observedBytes > maximum || contentBytes(content) > maximum) invalid();
  return Object.freeze({ value: content, observed_bytes: observedBytes });
}

export function normalizeToolResult(input: NormalizeToolResultInput): ToolResultV1 {
  const observation = captureToolServerObservation(input.observation, {
    protocol_revision: input.call.protocol_revision,
    transport: input.call.transport,
  });
  if (observation.identity_hash !== input.call.server_identity_hash) {
    throw new RuntimeToolError("RUNTIME_TOOL_PROTOCOL_DOWNGRADE");
  }
  if (
    !isRecord(input.result) ||
    !exactKeys(input.result, ["content", "is_error", "structured_content"]) ||
    !isUnknownArray(input.result.content) ||
    typeof input.result.is_error !== "boolean" ||
    input.result.content.length > input.call.result_limits.content_blocks
  ) {
    invalid();
  }

  const normalized = input.result.content.map((block) => normalizeContent(block, input.call));
  const content = Object.freeze(normalized.map((block) => block.value));
  const observedContentBytes = normalized.reduce((total, block) => total + block.observed_bytes, 0);
  const contentBytesAfterRedaction = content.reduce(
    (total, block) => total + contentBytes(block),
    0,
  );

  const validatedStructured = validateStructuredToolOutput(
    input.call.output_schema,
    input.result.structured_content,
    input.call.result_limits.structured_output_bytes,
  );
  if (!validatedStructured.ok) {
    if (
      validatedStructured.issues.some(
        (issue) => issue.keyword === "schema" || issue.keyword === "structuredOutput",
      )
    ) {
      schemaMismatch();
    }
    invalid();
  }
  const observedStructuredBytes =
    validatedStructured.value === null
      ? 0
      : Buffer.byteLength(canonicalJson(validatedStructured.value), "utf8");
  const structuredContent =
    validatedStructured.value === null
      ? null
      : redactGenericSecrets(
          redactJsonPointers(validatedStructured.value, input.call.sensitive_output_pointers),
        );
  const structuredBytes =
    structuredContent === null ? 0 : Buffer.byteLength(canonicalJson(structuredContent), "utf8");
  if (
    observedContentBytes + observedStructuredBytes > input.call.result_limits.result_bytes ||
    contentBytesAfterRedaction + structuredBytes > input.call.result_limits.result_bytes ||
    structuredBytes > input.call.result_limits.structured_output_bytes
  ) {
    invalid();
  }

  const hashable: HashableToolResultV1 = {
    protocol_version: "runtime-contract.v1",
    schema_version: "tool-result.v1",
    document_type: "tool-result",
    run_id: input.call.run_id,
    call_id: input.call.call_id,
    idempotency_key: input.call.idempotency_key,
    status: input.result.is_error ? "error" : "success",
    is_error: input.result.is_error,
    trust: "untrusted-content",
    content,
    structured_content: structuredContent,
    provenance: Object.freeze({
      profile: input.call.profile,
      discovery_snapshot_hash: input.call.discovery_snapshot_hash,
      server_id: input.call.server_id,
      server_identity_hash: input.call.server_identity_hash,
      protocol_revision: input.call.protocol_revision,
      transport: input.call.transport,
      alias: input.call.alias,
      native_name: input.call.native_name,
      input_schema_hash: input.call.input_schema_hash,
      output_schema_hash: input.call.output_schema_hash,
      call_id: input.call.call_id,
      idempotency_key: input.call.idempotency_key,
    }),
    trace: input.call.trace,
    accounting: Object.freeze({
      content_blocks: content.length,
      total_bytes: contentBytesAfterRedaction,
      structured_bytes: structuredBytes,
    }),
    error: input.result.is_error ? toolRuntimeError("RUNTIME_TOOL_INTERNAL") : null,
  };
  const candidate = { ...hashable, document_hash: hashToolResult(hashable) };
  const parsed = parseToolResult(canonicalJson(candidate));
  if (!parsed.ok) invalid();
  return parsed.value;
}
