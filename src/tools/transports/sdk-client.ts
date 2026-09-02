import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
  type Transport,
} from "@modelcontextprotocol/client";

import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonLimits,
  type JsonValue,
} from "../../protocol/json.js";
import { PACKAGE_VERSION } from "../../version.js";
import { RuntimeToolError } from "../errors.js";
import type { McpProtocolRevision } from "../types.js";
import type {
  NativeToolAnnotations,
  NativeToolCallRequest,
  NativeToolCallResult,
  NativeToolContent,
  NativeToolDefinition,
  ToolListPage,
  ToolSdkCallParams,
  ToolSdkClientConnectRequest,
  ToolSdkClientCreateOptions,
  ToolSdkClientFactory,
  ToolSdkClientFactoryOptions,
  ToolSdkClientPort,
  ToolSdkRequestOptions,
  ToolServerObservation,
  ToolTransportConnection,
} from "./types.js";

const NATIVE_FRAME_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxDepth: 64,
  maxMembers: 50_000,
});
const SCHEMA_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 262_144,
  maxDepth: 64,
  maxMembers: 10_000,
});
const MAX_PAGE_TOOLS = 256;
const MAX_CONTENT_BLOCKS = 128;
const MAX_CURSOR_LENGTH = 4_096;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedJson(value: unknown, limits: JsonLimits): JsonValue {
  return deepFreezeJson(parseJsonBytes(canonicalJson(value, limits), limits));
}

function resultInvalid(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_RESULT_INVALID");
}

function inputInvalid(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_INVALID");
}

function requestOptions(signal: AbortSignal, timeout_ms: number): ToolSdkRequestOptions {
  if (signal.aborted) throw new RuntimeToolError("RUNTIME_TOOL_CANCELLED");
  if (!Number.isSafeInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 300_000) inputInvalid();
  return Object.freeze({ signal, timeout_ms });
}

function exactKeys(value: object, allowed: readonly string[]): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
}

function stringField(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    resultInvalid();
  }
  return value;
}

function optionalBoolean(value: unknown): boolean | null {
  if (value === undefined) return null;
  if (typeof value !== "boolean") resultInvalid();
  return value;
}

function jsonObject(value: unknown, limits: JsonLimits): Readonly<Record<string, JsonValue>> {
  const copied = boundedJson(value, limits);
  if (!isRecord(copied)) resultInvalid();
  return copied;
}

function nativeAnnotations(value: unknown): NativeToolAnnotations {
  if (value === undefined) {
    return Object.freeze({
      read_only_hint: null,
      destructive_hint: null,
      idempotent_hint: null,
      open_world_hint: null,
    });
  }
  if (!isRecord(value)) resultInvalid();
  return Object.freeze({
    read_only_hint: optionalBoolean(value.readOnlyHint),
    destructive_hint: optionalBoolean(value.destructiveHint),
    idempotent_hint: optionalBoolean(value.idempotentHint),
    open_world_hint: optionalBoolean(value.openWorldHint),
  });
}

function nativeTool(value: unknown): NativeToolDefinition {
  if (!isRecord(value)) resultInvalid();
  const input_schema = jsonObject(value.inputSchema, SCHEMA_LIMITS);
  const output_schema =
    value.outputSchema === undefined ? null : jsonObject(value.outputSchema, SCHEMA_LIMITS);
  return Object.freeze({
    name: stringField(value.name, 128),
    input_schema,
    output_schema,
    annotations: nativeAnnotations(value.annotations),
  });
}

function toolListPage(value: unknown): ToolListPage {
  let copied: JsonValue;
  try {
    copied = boundedJson(value, NATIVE_FRAME_LIMITS);
  } catch {
    resultInvalid();
  }
  if (!isRecord(copied) || !Array.isArray(copied.tools) || copied.tools.length > MAX_PAGE_TOOLS) {
    resultInvalid();
  }
  const nextCursor = copied.nextCursor;
  if (
    nextCursor !== undefined &&
    (typeof nextCursor !== "string" || nextCursor.length < 1 || nextCursor.length > MAX_CURSOR_LENGTH)
  ) {
    resultInvalid();
  }
  return Object.freeze({
    tools: Object.freeze(copied.tools.map((tool) => nativeTool(tool))),
    next_cursor: nextCursor === undefined ? null : nextCursor,
  });
}

function nativeContent(value: unknown): NativeToolContent {
  if (!isRecord(value)) resultInvalid();
  switch (value.type) {
    case "text":
      return Object.freeze({ type: "text", text: stringField(value.text, 4 * 1024 * 1024) });
    case "image":
      return Object.freeze({
        type: "image",
        media_type: stringField(value.mimeType, 256),
        data_base64: stringField(value.data, 4 * 1024 * 1024),
      });
    case "audio":
      return Object.freeze({
        type: "audio",
        media_type: stringField(value.mimeType, 256),
        data_base64: stringField(value.data, 4 * 1024 * 1024),
      });
    case "resource_link":
      return Object.freeze({
        type: "resource-link",
        uri: stringField(value.uri, 4_096),
        name: stringField(value.name, 256),
        mime_type:
          value.mimeType === undefined ? null : stringField(value.mimeType, 256),
      });
    case "resource": {
      if (!isRecord(value.resource)) resultInvalid();
      const text = value.resource.text;
      const blob = value.resource.blob;
      if (
        (text === undefined && blob === undefined) ||
        (text !== undefined && blob !== undefined)
      ) {
        resultInvalid();
      }
      return Object.freeze({
        type: "embedded-resource",
        uri: stringField(value.resource.uri, 4_096),
        mime_type:
          value.resource.mimeType === undefined
            ? null
            : stringField(value.resource.mimeType, 256),
        text: text === undefined ? null : stringField(text, 4 * 1024 * 1024),
        blob_base64: blob === undefined ? null : stringField(blob, 4 * 1024 * 1024),
      });
    }
    default:
      return resultInvalid();
  }
}

function nativeCallResult(value: unknown): NativeToolCallResult {
  let copied: JsonValue;
  try {
    copied = boundedJson(value, NATIVE_FRAME_LIMITS);
  } catch {
    resultInvalid();
  }
  if (
    !isRecord(copied) ||
    !Array.isArray(copied.content) ||
    copied.content.length > MAX_CONTENT_BLOCKS ||
    (copied.isError !== undefined && typeof copied.isError !== "boolean")
  ) {
    resultInvalid();
  }
  return Object.freeze({
    content: Object.freeze(copied.content.map((content) => nativeContent(content))),
    structured_content:
      copied.structuredContent === undefined ? null : copied.structuredContent,
    is_error: copied.isError === true,
  });
}

function safeCallRequest(request: NativeToolCallRequest): ToolSdkCallParams {
  if (
    !isRecord(request) ||
    !exactKeys(request, ["name", "arguments", "trusted_meta"]) ||
    typeof request.name !== "string" ||
    request.name.length < 1 ||
    request.name.length > 128 ||
    !isRecord(request.arguments) ||
    (request.trusted_meta !== null && !isRecord(request.trusted_meta))
  ) {
    inputInvalid();
  }
  let argumentsCopy: Readonly<Record<string, JsonValue>>;
  let metadataCopy: Readonly<Record<string, JsonValue>> | undefined;
  try {
    argumentsCopy = jsonObject(request.arguments, NATIVE_FRAME_LIMITS);
    metadataCopy =
      request.trusted_meta === null
        ? undefined
        : jsonObject(request.trusted_meta, SCHEMA_LIMITS);
  } catch (error) {
    if (error instanceof RuntimeToolError) throw error;
    inputInvalid();
  }
  return Object.freeze({
    name: request.name,
    arguments: argumentsCopy,
    ...(metadataCopy === undefined ? {} : { _meta: metadataCopy }),
  });
}

function protocolRevisionOptions(revision: McpProtocolRevision): ToolSdkClientCreateOptions {
  const supportedProtocolVersions: readonly [McpProtocolRevision] = Object.freeze([revision]);
  return Object.freeze({
    supported_protocol_versions: supportedProtocolVersions,
    version_negotiation:
      revision === "2026-07-28" ? Object.freeze({ pin: revision }) : "legacy",
    client_capabilities: Object.freeze({}),
    accepts_server_requests: false,
    auto_fulfill: false,
    on_tools_changed: () => undefined,
  });
}

class OfficialToolSdkClient implements ToolSdkClientPort {
  readonly #client: Client;

  constructor(options: ToolSdkClientCreateOptions) {
    this.#client = new Client(
      { name: "toss-agent-runtime", version: PACKAGE_VERSION },
      {
        capabilities: options.client_capabilities,
        enforceStrictCapabilities: true,
        inputRequired: { autoFulfill: options.auto_fulfill },
        supportedProtocolVersions: [...options.supported_protocol_versions],
        versionNegotiation: { mode: options.version_negotiation },
      },
    );
    this.#client.setNotificationHandler(
      "notifications/tools/list_changed",
      options.on_tools_changed,
    );
  }

  async connect(transport: unknown, options: ToolSdkRequestOptions): Promise<void> {
    await this.#client.connect(transport as Transport, {
      signal: options.signal,
      timeout: options.timeout_ms,
      maxTotalTimeout: options.timeout_ms,
    });
  }

  getNegotiatedProtocolVersion(): string | undefined {
    return this.#client.getNegotiatedProtocolVersion();
  }

  getServerVersion(): unknown {
    return this.#client.getServerVersion();
  }

  getServerCapabilities(): unknown {
    return this.#client.getServerCapabilities();
  }

  async listToolsPage(cursor: string | null, options: ToolSdkRequestOptions): Promise<unknown> {
    return await this.#client.request(
      {
        method: "tools/list",
        params: cursor === null ? {} : { cursor },
      },
      {
        signal: options.signal,
        timeout: options.timeout_ms,
        maxTotalTimeout: options.timeout_ms,
      },
    );
  }

  async callTool(request: ToolSdkCallParams, options: ToolSdkRequestOptions): Promise<unknown> {
    return await this.#client.callTool(request, {
      signal: options.signal,
      timeout: options.timeout_ms,
      maxTotalTimeout: options.timeout_ms,
    });
  }

  async close(): Promise<void> {
    await this.#client.close();
  }
}

function defaultCreateClient(options: ToolSdkClientCreateOptions): ToolSdkClientPort {
  return new OfficialToolSdkClient(options);
}

function sdkErrorCode(error: SdkError): SdkErrorCode {
  return error.code;
}

export function classifyMcpSdkError(error: unknown): RuntimeToolError {
  if (error instanceof RuntimeToolError) return error;
  if (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return new RuntimeToolError("RUNTIME_TOOL_CANCELLED");
  }
  if (UnauthorizedError.isInstance(error)) {
    return new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
  }
  if (SdkHttpError.isInstance(error)) {
    if (error.status === 401) return new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
    if (error.status === 403) return new RuntimeToolError("RUNTIME_TOOL_POLICY_DENIED");
    if (error.status === 404) return new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
    if (error.status === 429) return new RuntimeToolError("RUNTIME_TOOL_RATE_LIMIT");
    if (error.status >= 500) return new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
  }
  if (SdkError.isInstance(error)) {
    switch (sdkErrorCode(error)) {
      case SdkErrorCode.RequestTimeout:
        return new RuntimeToolError("RUNTIME_TOOL_TIMEOUT");
      case SdkErrorCode.NotConnected:
      case SdkErrorCode.ConnectionClosed:
      case SdkErrorCode.SendFailed:
      case SdkErrorCode.ClientHttpFailedToOpenStream:
        return new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
      case SdkErrorCode.CapabilityNotSupported:
      case SdkErrorCode.MethodNotSupportedByProtocolVersion:
      case SdkErrorCode.UnsupportedResultType:
        return new RuntimeToolError("RUNTIME_TOOL_UNSUPPORTED");
      case SdkErrorCode.InvalidResult:
        return new RuntimeToolError("RUNTIME_TOOL_RESULT_INVALID");
      case SdkErrorCode.EraNegotiationFailed:
        return new RuntimeToolError("RUNTIME_TOOL_PROTOCOL_DOWNGRADE");
      case SdkErrorCode.ClientHttpAuthentication:
        return new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
      default:
        return new RuntimeToolError("RUNTIME_TOOL_INTERNAL");
    }
  }
  if (ProtocolError.isInstance(error)) {
    if (error.code === -32601) return new RuntimeToolError("RUNTIME_TOOL_UNSUPPORTED");
    if (error.code === -32602) return new RuntimeToolError("RUNTIME_TOOL_INVALID");
  }
  return new RuntimeToolError("RUNTIME_TOOL_INTERNAL");
}

async function sdkOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw classifyMcpSdkError(error);
  }
}

function serverObservation(
  port: ToolSdkClientPort,
  protocol_revision: McpProtocolRevision,
  transport: ToolServerObservation["transport"],
): ToolServerObservation {
  let version: JsonValue;
  let capabilities: JsonValue;
  try {
    version = boundedJson(port.getServerVersion(), SCHEMA_LIMITS);
    capabilities = boundedJson(port.getServerCapabilities(), SCHEMA_LIMITS);
  } catch {
    resultInvalid();
  }
  if (!isRecord(version) || !isRecord(capabilities)) resultInvalid();
  if (Object.keys(capabilities).some((capability) => capability !== "tools")) {
    throw new RuntimeToolError("RUNTIME_TOOL_UNSUPPORTED");
  }
  const name = stringField(version.name, 128);
  const serverVersion = stringField(version.version, 128);
  return Object.freeze({
    name,
    version: serverVersion,
    identity_hash: sha256({ name, protocol_revision, version: serverVersion }),
    protocol_revision,
    transport,
  });
}

async function closeAfterFailure(port: ToolSdkClientPort): Promise<void> {
  await port.close().catch(() => undefined);
}

export function createToolSdkClientFactory(
  options: ToolSdkClientFactoryOptions = {},
): ToolSdkClientFactory {
  const createClient = options.createClient ?? defaultCreateClient;
  const factory: ToolSdkClientFactory = {
    async connect(request: ToolSdkClientConnectRequest): Promise<ToolTransportConnection> {
      const operationOptions = requestOptions(request.signal, request.timeout_ms);
      const clientOptions = {
        ...protocolRevisionOptions(request.protocol_revision),
        on_tools_changed: request.on_tools_changed,
      } satisfies ToolSdkClientCreateOptions;
      const port = createClient(Object.freeze(clientOptions));
      try {
        await sdkOperation(async () => port.connect(request.transport, operationOptions));
        if (port.getNegotiatedProtocolVersion() !== request.protocol_revision) {
          throw new RuntimeToolError("RUNTIME_TOOL_PROTOCOL_DOWNGRADE");
        }
        const server = serverObservation(
          port,
          request.protocol_revision,
          request.transport_kind,
        );
        const connection: ToolTransportConnection = {
          server,
          async listTools(cursor: string | null, signal: AbortSignal): Promise<ToolListPage> {
            if (
              cursor !== null &&
              (cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH)
            ) {
              inputInvalid();
            }
            const raw = await sdkOperation(async () =>
              port.listToolsPage(
                cursor,
                requestOptions(signal, request.timeout_ms),
              ),
            );
            return toolListPage(raw);
          },
          async callTool(
            call: NativeToolCallRequest,
            signal: AbortSignal,
          ): Promise<NativeToolCallResult> {
            const safeRequest = safeCallRequest(call);
            const raw = await sdkOperation(async () =>
              port.callTool(safeRequest, requestOptions(signal, request.timeout_ms)),
            );
            return nativeCallResult(raw);
          },
          async close(signal: AbortSignal): Promise<void> {
            requestOptions(signal, request.timeout_ms);
            await sdkOperation(async () => port.close());
          },
        };
        return Object.freeze(connection);
      } catch (error) {
        await closeAfterFailure(port);
        if (request.signal.aborted) {
          throw new RuntimeToolError("RUNTIME_TOOL_CANCELLED");
        }
        throw classifyMcpSdkError(error);
      }
    },
  };
  return Object.freeze(factory);
}
