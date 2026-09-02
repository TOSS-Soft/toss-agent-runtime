import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  LOG_LEVEL_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import type { SecretReference } from "../../config/types.js";
import type {
  AgentgatewayFetch,
  AgentgatewayProfileV1,
  GatewayCredentialCoordinator,
} from "../../gateway/types.js";
import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonValue,
} from "../../protocol/json.js";
import type { TraceContext } from "../../protocol/types.js";
import { RuntimeToolError } from "../errors.js";
import type { McpAgentgatewayBinding, McpProtocolRevision } from "../types.js";
import { createToolSdkClientFactory } from "./sdk-client.js";
import type {
  ToolSdkClientFactory,
  ToolTransportAdapter,
  ToolTransportConnectRequest,
  ToolTransportConnection,
} from "./types.js";

const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/u;
const HEADER_VALUE_PATTERN = /^[\u0020-\u007e]{1,512}$/u;
const MCP_PARAMETER_HEADER = /^x-mcp-[a-z0-9-]{1,64}$/u;
const ALLOWED_SDK_HEADERS = new Set([
  "accept",
  "content-type",
  "last-event-id",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "mcp-session-id",
]);
const ALLOWED_SDK_META_KEYS = new Set([
  "toss",
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  LOG_LEVEL_META_KEY,
  PROTOCOL_VERSION_META_KEY,
]);

type SafeHttpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface AgentgatewayToolAuthority {
  readonly run_id: string;
  readonly request_id: string;
  readonly execution_request_hash: `sha256:${string}`;
  readonly agent_definition_hash: `sha256:${string}`;
  readonly task_contract_hash: `sha256:${string}`;
  readonly role: "worker" | "reviewer";
  readonly mcp_profile_hash: `sha256:${string}`;
  readonly server_id: string;
  readonly trace: TraceContext;
}

export interface CreateAgentgatewayToolTransportOptions {
  readonly binding: McpAgentgatewayBinding;
  readonly gateway_profiles: Readonly<Record<string, AgentgatewayProfileV1>>;
  readonly secret_references: Readonly<Record<string, SecretReference>>;
  readonly credential_coordinator: GatewayCredentialCoordinator;
  readonly fetch: AgentgatewayFetch;
  readonly authority: AgentgatewayToolAuthority;
  readonly approved_header_mappings: Readonly<Record<string, string>>;
  readonly sdk_client_factory?: ToolSdkClientFactory;
}

interface ToolCallIdentity {
  readonly discovery_snapshot_hash: `sha256:${string}`;
  readonly tool_alias: string;
  readonly native_tool_name: string;
  readonly call_id: string;
  readonly idempotency_key: `sha256:${string}`;
}

type GatewayOperation = "session" | "discovery" | "call";

interface RequestScope {
  readonly operation: GatewayOperation;
  readonly call: ToolCallIdentity | null;
  readonly arguments: Readonly<Record<string, JsonValue>> | null;
}

interface ApprovedHeaderMapping {
  readonly name: string;
  readonly path: readonly string[];
}

function invalid(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_INVALID");
}

function isRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function capturedRecord<T>(value: T): T {
  try {
    return deepFreezeJson(parseJsonBytes(canonicalJson(value))) as unknown as T;
  } catch {
    invalid();
  }
}

function parsePointer(pointer: string): readonly string[] {
  if (pointer === "" || !pointer.startsWith("/") || pointer.length > 512) invalid();
  return Object.freeze(
    pointer.slice(1).split("/").map((token) => {
      if (/~(?:[^01]|$)/u.test(token)) invalid();
      return token.replaceAll("~1", "/").replaceAll("~0", "~");
    }),
  );
}

function approvedMappings(
  value: Readonly<Record<string, string>>,
): readonly ApprovedHeaderMapping[] {
  const captured = capturedRecord(value);
  const names = Object.keys(captured);
  if (names.length > 32) invalid();
  return Object.freeze(
    names.sort().map((name) => {
      if (!MCP_PARAMETER_HEADER.test(name)) invalid();
      const pointer = captured[name];
      if (typeof pointer !== "string") invalid();
      return Object.freeze({ name, path: parsePointer(pointer) });
    }),
  );
}

function atPointer(root: unknown, tokens: readonly string[]): unknown {
  let current = root;
  for (const token of tokens) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      !Object.hasOwn(current, token)
    ) {
      return undefined;
    }
    current = (current as Readonly<Record<string, unknown>>)[token];
  }
  return current;
}

function parameterHeaderValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return String(value);
  }
  return null;
}

function encodedHeaderValue(value: string): string {
  return /^[\x20-\x7e]*$/u.test(value)
    ? value
    : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function validTrace(value: unknown): value is TraceContext {
  if (!isRecord(value)) return false;
  const keys = Object.hasOwn(value, "trace_state")
    ? ["span_id", "trace_flags", "trace_id", "trace_state"]
    : ["span_id", "trace_flags", "trace_id"];
  return (
    exactKeys(value, keys) &&
    typeof value.trace_id === "string" &&
    TRACE_ID_PATTERN.test(value.trace_id) &&
    typeof value.span_id === "string" &&
    SPAN_ID_PATTERN.test(value.span_id) &&
    Number.isSafeInteger(value.trace_flags) &&
    Number(value.trace_flags) >= 0 &&
    Number(value.trace_flags) <= 255 &&
    (value.trace_state === undefined ||
      (typeof value.trace_state === "string" &&
        value.trace_state.length <= 512 &&
        /^[\u0020-\u007e]*$/u.test(value.trace_state) &&
        value.trace_state.trim() === value.trace_state))
  );
}

function normalizedAuthority(value: AgentgatewayToolAuthority): AgentgatewayToolAuthority {
  const authority = capturedRecord(value);
  if (
    !isRecord(authority) ||
    !exactKeys(authority, [
      "agent_definition_hash",
      "execution_request_hash",
      "mcp_profile_hash",
      "request_id",
      "role",
      "run_id",
      "server_id",
      "task_contract_hash",
      "trace",
    ]) ||
    typeof authority.run_id !== "string" ||
    !IDENTIFIER_PATTERN.test(authority.run_id) ||
    typeof authority.request_id !== "string" ||
    !UUID_PATTERN.test(authority.request_id) ||
    typeof authority.execution_request_hash !== "string" ||
    !SHA256_PATTERN.test(authority.execution_request_hash) ||
    typeof authority.agent_definition_hash !== "string" ||
    !SHA256_PATTERN.test(authority.agent_definition_hash) ||
    typeof authority.task_contract_hash !== "string" ||
    !SHA256_PATTERN.test(authority.task_contract_hash) ||
    (authority.role !== "worker" && authority.role !== "reviewer") ||
    typeof authority.mcp_profile_hash !== "string" ||
    !SHA256_PATTERN.test(authority.mcp_profile_hash) ||
    typeof authority.server_id !== "string" ||
    !IDENTIFIER_PATTERN.test(authority.server_id) ||
    !validTrace(authority.trace)
  ) {
    invalid();
  }
  return authority;
}

function normalizedBinding(value: McpAgentgatewayBinding): McpAgentgatewayBinding {
  const binding = capturedRecord(value);
  if (
    !isRecord(binding) ||
    !exactKeys(binding, ["gateway_profile", "transport"]) ||
    binding.transport !== "agentgateway" ||
    typeof binding.gateway_profile !== "string" ||
    !IDENTIFIER_PATTERN.test(binding.gateway_profile)
  ) {
    invalid();
  }
  return binding;
}

function gatewayRoute(options: {
  readonly binding: McpAgentgatewayBinding;
  readonly profiles: Readonly<Record<string, AgentgatewayProfileV1>>;
  readonly server_id: string;
}): { readonly url: URL; readonly profile: AgentgatewayProfileV1 } {
  const profiles = capturedRecord(options.profiles);
  const profile = profiles[options.binding.gateway_profile];
  if (profile === undefined || profile.protocol !== "toss-agentgateway.v1") invalid();
  let endpoint: URL;
  try {
    endpoint = new URL(profile.endpoint);
  } catch {
    invalid();
  }
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
      ))
  ) {
    invalid();
  }
  return Object.freeze({
    url: new URL(`/v1/toss/mcp/${encodeURIComponent(options.server_id)}`, endpoint.origin),
    profile,
  });
}

function secretReference(options: {
  readonly profile: AgentgatewayProfileV1;
  readonly references: Readonly<Record<string, SecretReference>>;
}): SecretReference {
  const references = capturedRecord(options.references);
  const reference = references[options.profile.credential_reference];
  if (
    reference === undefined ||
    (reference.source !== "env" && reference.source !== "command") ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(reference.key)
  ) {
    invalid();
  }
  return reference;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function callIdentity(
  message: Readonly<Record<string, JsonValue>>,
  authority: AgentgatewayToolAuthority,
): ToolCallIdentity {
  const params = message.params;
  if (!isRecord(params) || typeof params.name !== "string" || !isRecord(params._meta)) invalid();
  if (!isRecord(params.arguments)) invalid();
  const metadata = params._meta;
  if (
    Object.keys(metadata).some((key) => !ALLOWED_SDK_META_KEYS.has(key)) ||
    !isRecord(metadata.toss)
  ) {
    invalid();
  }
  const toss = metadata.toss;
  if (
    !exactKeys(toss, [
      "agent_definition_hash",
      "call_id",
      "discovery_snapshot_hash",
      "execution_request_hash",
      "idempotency_key",
      "mcp_profile_hash",
      "native_tool_name",
      "role",
      "run_id",
      "server_id",
      "task_contract_hash",
      "tool_alias",
      "trace",
    ]) ||
    toss.run_id !== authority.run_id ||
    toss.execution_request_hash !== authority.execution_request_hash ||
    toss.agent_definition_hash !== authority.agent_definition_hash ||
    toss.task_contract_hash !== authority.task_contract_hash ||
    toss.role !== authority.role ||
    toss.mcp_profile_hash !== authority.mcp_profile_hash ||
    toss.server_id !== authority.server_id ||
    !sameJson(toss.trace, authority.trace) ||
    typeof toss.discovery_snapshot_hash !== "string" ||
    !SHA256_PATTERN.test(toss.discovery_snapshot_hash) ||
    typeof toss.tool_alias !== "string" ||
    !IDENTIFIER_PATTERN.test(toss.tool_alias) ||
    typeof toss.native_tool_name !== "string" ||
    !IDENTIFIER_PATTERN.test(toss.native_tool_name) ||
    toss.native_tool_name !== params.name ||
    typeof toss.call_id !== "string" ||
    !IDENTIFIER_PATTERN.test(toss.call_id) ||
    typeof toss.idempotency_key !== "string" ||
    !SHA256_PATTERN.test(toss.idempotency_key)
  ) {
    throw new RuntimeToolError("RUNTIME_TOOL_POLICY_DENIED");
  }
  return Object.freeze({
    discovery_snapshot_hash: toss.discovery_snapshot_hash as `sha256:${string}`,
    tool_alias: toss.tool_alias,
    native_tool_name: toss.native_tool_name,
    call_id: toss.call_id,
    idempotency_key: toss.idempotency_key as `sha256:${string}`,
  });
}

function postScope(body: string | null, authority: AgentgatewayToolAuthority): RequestScope {
  if (body === null || Buffer.byteLength(body) > MAX_HTTP_BODY_BYTES) invalid();
  let message: JsonValue;
  try {
    message = parseJsonBytes(body, {
      maxBytes: MAX_HTTP_BODY_BYTES,
      maxDepth: 64,
      maxMembers: 50_000,
    });
  } catch {
    invalid();
  }
  if (!isRecord(message) || typeof message.method !== "string") invalid();
  switch (message.method) {
    case "server/discover":
    case "initialize":
    case "notifications/initialized":
      return Object.freeze({ operation: "session", call: null, arguments: null });
    case "tools/list":
      return Object.freeze({ operation: "discovery", call: null, arguments: null });
    case "tools/call": {
      const params = message.params;
      if (!isRecord(params) || !isRecord(params.arguments)) invalid();
      return Object.freeze({
        operation: "call",
        call: callIdentity(message, authority),
        arguments: params.arguments,
      });
    }
    default:
      throw new RuntimeToolError("RUNTIME_TOOL_UNSUPPORTED");
  }
}

function requestMethod(init?: RequestInit): "GET" | "POST" | "DELETE" {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST" && method !== "DELETE") invalid();
  return method;
}

function requestBody(init?: RequestInit): string | null {
  if (init?.body === undefined || init.body === null) return null;
  if (typeof init.body !== "string" || Buffer.byteLength(init.body) > MAX_HTTP_BODY_BYTES) {
    invalid();
  }
  return init.body;
}

function incomingHeaders(init?: RequestInit): Headers {
  let headers: Headers;
  try {
    headers = new Headers(init?.headers);
  } catch {
    invalid();
  }
  for (const name of headers.keys()) {
    if (!ALLOWED_SDK_HEADERS.has(name.toLowerCase())) invalid();
  }
  return headers;
}

function credentialScope(options: {
  readonly gateway_profile: string;
  readonly authority: AgentgatewayToolAuthority;
  readonly operation: GatewayOperation;
  readonly call: ToolCallIdentity | null;
  readonly protocol_revision: McpProtocolRevision;
}): Readonly<Record<string, JsonValue>> {
  const call = options.call;
  return deepFreezeJson({
    kind: "mcp",
    operation: options.operation,
    gateway_profile: options.gateway_profile,
    run_id: options.authority.run_id,
    request_id: options.authority.request_id,
    execution_request_hash: options.authority.execution_request_hash,
    agent_definition_hash: options.authority.agent_definition_hash,
    task_contract_hash: options.authority.task_contract_hash,
    role: options.authority.role,
    mcp_profile_hash: options.authority.mcp_profile_hash,
    discovery_snapshot_hash: call?.discovery_snapshot_hash ?? null,
    server_id: options.authority.server_id,
    tool_alias: call?.tool_alias ?? null,
    native_tool_name: call?.native_tool_name ?? null,
    call_id: call?.call_id ?? null,
    idempotency_key: call?.idempotency_key ?? null,
    protocol_revision: options.protocol_revision,
  });
}

function fixedHeaders(options: {
  readonly incoming: Headers;
  readonly method: "GET" | "POST" | "DELETE";
  readonly token: string;
  readonly authority: AgentgatewayToolAuthority;
  readonly call: ToolCallIdentity | null;
  readonly arguments: Readonly<Record<string, JsonValue>> | null;
  readonly mappings: readonly ApprovedHeaderMapping[];
  readonly scope_hash: `sha256:${string}`;
  readonly protocol_revision: McpProtocolRevision;
}): Headers {
  const headers = new Headers();
  if (options.method === "POST") {
    headers.set("accept", "application/json, text/event-stream");
    headers.set("content-type", "application/json");
  } else if (options.method === "GET") {
    headers.set("accept", "text/event-stream");
  }
  for (const name of [
    "last-event-id",
    "mcp-method",
    "mcp-name",
    "mcp-protocol-version",
    "mcp-session-id",
  ]) {
    const value = options.incoming.get(name);
    if (value !== null) headers.set(name, value);
  }
  const trace = options.authority.trace;
  headers.set("authorization", `Bearer ${options.token}`);
  headers.set(
    "traceparent",
    `00-${trace.trace_id}-${trace.span_id}-${trace.trace_flags.toString(16).padStart(2, "0")}`,
  );
  if (trace.trace_state !== undefined) headers.set("tracestate", trace.trace_state);
  headers.set("x-toss-run-id", options.authority.run_id);
  headers.set("x-toss-request-id", options.authority.request_id);
  headers.set("x-toss-execution-request-sha256", options.authority.execution_request_hash);
  headers.set("x-toss-agent-definition-sha256", options.authority.agent_definition_hash);
  headers.set("x-toss-task-contract-sha256", options.authority.task_contract_hash);
  headers.set("x-toss-agent-role", options.authority.role);
  headers.set("x-toss-mcp-profile-sha256", options.authority.mcp_profile_hash);
  headers.set("x-toss-mcp-server-id", options.authority.server_id);
  headers.set("x-toss-mcp-protocol-version", options.protocol_revision);
  headers.set("x-toss-mcp-scope-sha256", options.scope_hash);
  if (options.call !== null) {
    headers.set("x-toss-discovery-sha256", options.call.discovery_snapshot_hash);
    headers.set("x-toss-tool-alias", options.call.tool_alias);
    headers.set("x-toss-native-tool-name", options.call.native_tool_name);
    headers.set("x-toss-call-id", options.call.call_id);
    headers.set("x-toss-idempotency-key", options.call.idempotency_key);
    for (const mapping of options.mappings) {
      const value = parameterHeaderValue(atPointer(options.arguments, mapping.path));
      if (value !== null) headers.set(mapping.name, encodedHeaderValue(value));
    }
  }
  return headers;
}

function requiredHeader(response: Response, name: string): string {
  let value: string | null;
  try {
    value = response.headers.get(name);
  } catch {
    invalid();
  }
  if (value === null || !HEADER_VALUE_PATTERN.test(value)) invalid();
  return value;
}

function attestResponse(options: {
  readonly response: Response;
  readonly authority: AgentgatewayToolAuthority;
  readonly scope_hash: `sha256:${string}`;
  readonly protocol_revision: McpProtocolRevision;
}): void {
  const scope = requiredHeader(options.response, "x-toss-mcp-scope-sha256");
  const profile = requiredHeader(options.response, "x-toss-mcp-profile-sha256");
  const server = requiredHeader(options.response, "x-toss-mcp-server-id");
  const revision = requiredHeader(options.response, "x-toss-mcp-protocol-version");
  const capabilities = requiredHeader(options.response, "x-toss-mcp-capabilities");
  if (scope !== options.scope_hash) {
    throw new RuntimeToolError("RUNTIME_TOOL_POLICY_DENIED");
  }
  if (profile !== options.authority.mcp_profile_hash || server !== options.authority.server_id) {
    throw new RuntimeToolError("RUNTIME_TOOL_POLICY_DENIED");
  }
  if (revision !== options.protocol_revision) {
    throw new RuntimeToolError("RUNTIME_TOOL_PROTOCOL_DOWNGRADE");
  }
  if (capabilities !== "tools") {
    throw new RuntimeToolError("RUNTIME_TOOL_UNSUPPORTED");
  }
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch {
    // The stable tool-domain result owns failure precedence.
  }
}

function statusResponse(response: Response, status = response.status): Response {
  return new Response(null, {
    status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function boundedResponse(response: Response): Promise<Response> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > MAX_HTTP_BODY_BYTES) {
    throw new SdkError(SdkErrorCode.InvalidResult, "Response body exceeded its limit");
  }
  if (response.body === null) return response;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType === "application/json") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_HTTP_BODY_BYTES) {
      throw new SdkError(SdkErrorCode.InvalidResult, "Response body exceeded its limit");
    }
    try {
      parseJsonBytes(bytes, {
        maxBytes: MAX_HTTP_BODY_BYTES,
        maxDepth: 64,
        maxMembers: 50_000,
      });
    } catch {
      throw new SdkError(SdkErrorCode.InvalidResult, "Response body was invalid");
    }
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const reader = response.body.getReader() as {
    read(): Promise<
      | { readonly done: true; readonly value?: never }
      | { readonly done: false; readonly value: Uint8Array }
    >;
    cancel(reason?: unknown): Promise<void>;
  };
  let total = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      total += next.value.byteLength;
      if (total > MAX_HTTP_BODY_BYTES) {
        await reader.cancel();
        controller.error(new SdkError(SdkErrorCode.InvalidResult, "Response body exceeded its limit"));
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel(reason: unknown) {
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function createGatewayFetch(options: {
  readonly route: URL;
  readonly gateway_profile: string;
  readonly authority: AgentgatewayToolAuthority;
  readonly credential_reference: SecretReference;
  readonly credentials: GatewayCredentialCoordinator;
  readonly fetch: AgentgatewayFetch;
  readonly protocol_revision: McpProtocolRevision;
  readonly mappings: readonly ApprovedHeaderMapping[];
}): SafeHttpFetch {
  return async (input, init): Promise<Response> => {
    let requested: URL;
    try {
      requested = new URL(String(input));
    } catch {
      invalid();
    }
    if (requested.href !== options.route.href) invalid();
    const method = requestMethod(init);
    const body = requestBody(init);
    const incoming = incomingHeaders(init);
    const signal = init?.signal ?? new AbortController().signal;
    if (!(signal instanceof AbortSignal) || signal.aborted) {
      throw new RuntimeToolError("RUNTIME_TOOL_CANCELLED");
    }
    const requestScope =
      method === "POST"
        ? postScope(body, options.authority)
        : Object.freeze({ operation: "session" as const, call: null, arguments: null });
    const scope = credentialScope({
      gateway_profile: options.gateway_profile,
      authority: options.authority,
      operation: requestScope.operation,
      call: requestScope.call,
      protocol_revision: options.protocol_revision,
    });
    const scopeHash = sha256(scope);
    let token: string;
    try {
      token = (
        await options.credentials.resolve(options.credential_reference, signal, scope)
      ).token;
    } catch {
      throw new RuntimeToolError(
        signal.aborted ? "RUNTIME_TOOL_CANCELLED" : "RUNTIME_TOOL_AUTHENTICATION",
      );
    }
    const headers = fixedHeaders({
      incoming,
      method,
      token,
      authority: options.authority,
      call: requestScope.call,
      arguments: requestScope.arguments,
      mappings: options.mappings,
      scope_hash: scopeHash,
      protocol_revision: options.protocol_revision,
    });
    let response: Response;
    try {
      response = await options.fetch(options.route.href, {
        method,
        headers,
        redirect: "error",
        signal,
        ...(body === null ? {} : { body }),
      });
    } catch {
      throw new RuntimeToolError(
        signal.aborted ? "RUNTIME_TOOL_CANCELLED" : "RUNTIME_TOOL_UNAVAILABLE",
      );
    }
    if (!(response instanceof Response)) {
      throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
    }
    if (
      response.redirected ||
      (response.url.length > 0 && response.url !== options.route.href) ||
      (response.status >= 300 && response.status < 400)
    ) {
      await cancelBody(response);
      throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
    }
    if (response.status < 200 || response.status >= 300) {
      await cancelBody(response);
      return statusResponse(response, response.status === 403 ? 401 : response.status);
    }
    try {
      attestResponse({
        response,
        authority: options.authority,
        scope_hash: scopeHash,
        protocol_revision: options.protocol_revision,
      });
    } catch (error) {
      await cancelBody(response);
      throw error;
    }
    return await boundedResponse(response);
  };
}

export function createAgentgatewayToolTransport(
  options: CreateAgentgatewayToolTransportOptions,
): ToolTransportAdapter {
  const binding = normalizedBinding(options.binding);
  const authority = normalizedAuthority(options.authority);
  const route = gatewayRoute({
    binding,
    profiles: options.gateway_profiles,
    server_id: authority.server_id,
  });
  const credentialReference = secretReference({
    profile: route.profile,
    references: options.secret_references,
  });
  const mappings = approvedMappings(options.approved_header_mappings);
  const sdkFactory = options.sdk_client_factory ?? createToolSdkClientFactory();
  return Object.freeze({
    kind: "agentgateway",
    async connect(request: ToolTransportConnectRequest): Promise<ToolTransportConnection> {
      if (mappings.length > 0 && request.protocol_revision !== "2026-07-28") invalid();
      const fetch = createGatewayFetch({
        route: route.url,
        gateway_profile: binding.gateway_profile,
        authority,
        credential_reference: credentialReference,
        credentials: options.credential_coordinator,
        fetch: options.fetch,
        protocol_revision: request.protocol_revision,
        mappings,
      });
      const transport = new StreamableHTTPClientTransport(route.url, {
        fetch,
        onInsufficientScope: "throw",
        maxStepUpRetries: 0,
        reconnectionOptions: {
          initialReconnectionDelay: 1_000,
          maxReconnectionDelay: 1_000,
          reconnectionDelayGrowFactor: 1,
          maxRetries: 0,
        },
      });
      return await sdkFactory.connect({
        ...request,
        transport,
        transport_kind: "agentgateway",
      });
    },
  });
}
