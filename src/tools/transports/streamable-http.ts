import { lookup as nodeLookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import type { RuntimeMode, SecretReference } from "../../config/types.js";
import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  type JsonValue,
} from "../../protocol/json.js";
import { RuntimeToolError } from "../errors.js";
import type { McpProtocolRevision, McpStreamableHttpBinding } from "../types.js";
import { createToolSdkClientFactory } from "./sdk-client.js";
import type {
  ToolSdkClientFactory,
  ToolTransportAdapter,
  ToolTransportConnectRequest,
  ToolTransportConnection,
} from "./types.js";

const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const MAX_DNS_ADDRESSES = 16;
const ALLOWED_SDK_HEADERS = new Set([
  "accept",
  "content-type",
  "last-event-id",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "mcp-session-id",
]);
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const MCP_PARAMETER_HEADER = /^x-mcp-[a-z0-9-]{1,64}$/u;

export interface HttpDnsAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type HttpDnsLookup = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly HttpDnsAddress[]>;

export interface HttpBearerProvider {
  resolve(
    reference: SecretReference,
    options: {
      readonly signal: AbortSignal;
      readonly minimum_validity_ms: number;
    },
  ): Promise<unknown>;
}

export interface HttpNetworkRequest {
  readonly url: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly headers: Headers;
  readonly body: string | null;
  readonly signal: AbortSignal;
  readonly redirect: "error";
  readonly approved_addresses: readonly string[];
  readonly server_name: string;
}

export interface HttpNetworkResponse {
  readonly response: Response;
  readonly remote_address: string;
}

export type HttpNetworkFetch = (request: HttpNetworkRequest) => Promise<HttpNetworkResponse>;

type SafeHttpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface CreateSafeStreamableHttpFetchOptions {
  readonly endpoint: URL;
  readonly approved_addresses: readonly string[];
  readonly credential_reference: SecretReference | null;
  readonly secret_provider: HttpBearerProvider;
  readonly network_fetch: HttpNetworkFetch;
  readonly protocol_revision: McpProtocolRevision;
  readonly approved_header_mappings: Readonly<Record<string, string>>;
  readonly now?: () => Date;
}

export interface CreateStreamableHttpToolTransportOptions {
  readonly binding: McpStreamableHttpBinding;
  readonly mode: RuntimeMode;
  readonly secret_references: Readonly<Record<string, SecretReference>>;
  readonly secret_provider: HttpBearerProvider;
  readonly dns_lookup?: HttpDnsLookup;
  readonly network_fetch: HttpNetworkFetch;
  readonly approved_header_mappings: Readonly<Record<string, string>>;
  readonly sdk_client_factory?: ToolSdkClientFactory;
  readonly now?: () => Date;
}

function invalid(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_INVALID");
}

function unavailable(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
}

function normalizedIp(address: string): string | null {
  const family = isIP(address);
  if (family === 4)
    return address
      .split(".")
      .map((part) => String(Number(part)))
      .join(".");
  if (family !== 6) return null;
  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

function ipv4Parts(address: string): readonly number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

function isLoopbackAddress(address: string): boolean {
  const normalized = normalizedIp(address);
  if (normalized === null) return false;
  const ipv4 = ipv4Parts(normalized);
  if (ipv4 !== null) return ipv4[0] === 127;
  return normalized === "::1" || normalized.startsWith("::ffff:127.");
}

function isPublicAddress(address: string): boolean {
  const normalized = normalizedIp(address);
  if (normalized === null) return false;
  const ipv4 = ipv4Parts(normalized);
  if (ipv4 !== null) {
    const [a = 0, b = 0, c = 0] = ipv4;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  const lower = normalized.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    return isPublicAddress(lower.slice("::ffff:".length));
  }
  return !(
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    /^fe[89ab]/u.test(lower) ||
    lower.startsWith("ff") ||
    lower.startsWith("2001:db8:")
  );
}

function loopbackEndpoint(endpoint: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
}

function endpointFrom(binding: McpStreamableHttpBinding, mode: RuntimeMode): URL {
  if (binding.transport !== "streamable-http") invalid();
  let endpoint: URL;
  try {
    endpoint = new URL(binding.endpoint);
  } catch {
    invalid();
  }
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    invalid();
  }
  if (endpoint.protocol === "http:") {
    if (mode !== "development" || !loopbackEndpoint(endpoint)) invalid();
  } else if (endpoint.protocol !== "https:") {
    invalid();
  }
  return endpoint;
}

function captureRecord<T>(value: T): T {
  try {
    return deepFreezeJson(parseJsonBytes(canonicalJson(value))) as unknown as T;
  } catch {
    invalid();
  }
}

function isJsonObject(value: unknown): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePointer(pointer: string): readonly string[] {
  if (pointer === "" || !pointer.startsWith("/") || pointer.length > 1_024) invalid();
  return Object.freeze(
    pointer
      .slice(1)
      .split("/")
      .map((token) => {
        if (/~(?:[^01]|$)/u.test(token)) invalid();
        return token.replaceAll("~1", "/").replaceAll("~0", "~");
      }),
  );
}

interface ApprovedHeaderMapping {
  readonly name: string;
  readonly path: readonly string[];
}

function approvedMappings(
  value: Readonly<Record<string, string>>,
): readonly ApprovedHeaderMapping[] {
  const captured = captureRecord(value);
  const names = Object.keys(captured);
  if (names.length > 32) invalid();
  const lowerNames = new Set<string>();
  return Object.freeze(
    names.sort().map((name) => {
      const lower = name.toLowerCase();
      if (
        name.length < 1 ||
        name.length > 64 ||
        !HEADER_TOKEN.test(name) ||
        !MCP_PARAMETER_HEADER.test(name) ||
        lowerNames.has(lower)
      ) {
        invalid();
      }
      lowerNames.add(lower);
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

function headerValue(value: unknown): string | null {
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

function toolArguments(body: string | null): unknown {
  if (body === null || Buffer.byteLength(body) > MAX_HTTP_BODY_BYTES) return undefined;
  let parsed: JsonValue;
  try {
    parsed = parseJsonBytes(body, {
      maxBytes: MAX_HTTP_BODY_BYTES,
      maxDepth: 64,
      maxMembers: 50_000,
    });
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed) || parsed.method !== "tools/call" || !isJsonObject(parsed.params)) {
    return undefined;
  }
  return parsed.params.arguments;
}

function sourceHeaders(init?: RequestInit): Headers {
  try {
    return new Headers(init?.headers);
  } catch {
    invalid();
  }
}

function fixedHeaders(options: {
  readonly init?: RequestInit;
  readonly method: HttpNetworkRequest["method"];
  readonly body: string | null;
  readonly mappings: readonly ApprovedHeaderMapping[];
  readonly protocol_revision: McpProtocolRevision;
}): Headers {
  const incoming = sourceHeaders(options.init);
  for (const name of incoming.keys()) {
    if (!ALLOWED_SDK_HEADERS.has(name.toLowerCase())) invalid();
  }
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
    const value = incoming.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (options.protocol_revision === "2026-07-28") {
    const argumentsValue = toolArguments(options.body);
    for (const mapping of options.mappings) {
      const value = headerValue(atPointer(argumentsValue, mapping.path));
      if (value !== null) headers.set(mapping.name, encodedHeaderValue(value));
    }
  }
  return headers;
}

function normalizeBearer(value: unknown, now: () => Date): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
  }
  let parsed: JsonValue;
  try {
    parsed = parseJsonBytes(canonicalJson(value));
  } catch {
    throw new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
  }
  if (
    !isJsonObject(parsed) ||
    Object.keys(parsed).sort().join("\u0000") !== "expires_at\u0000scheme\u0000token" ||
    parsed.scheme !== "Bearer" ||
    typeof parsed.token !== "string" ||
    Buffer.byteLength(parsed.token) < 16 ||
    Buffer.byteLength(parsed.token) > 8_192 ||
    /[\s\u0000-\u001f\u007f]/u.test(parsed.token) ||
    typeof parsed.expires_at !== "string"
  ) {
    throw new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
  }
  const expiresAt = Date.parse(parsed.expires_at);
  const current = now().getTime();
  if (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== parsed.expires_at ||
    !Number.isFinite(current) ||
    expiresAt - current < 1
  ) {
    throw new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
  }
  return parsed.token;
}

function requestUrl(input: string | URL): string {
  return String(input);
}

function requestMethod(init?: RequestInit): HttpNetworkRequest["method"] {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST" && method !== "DELETE") invalid();
  return method;
}

function requestBody(init?: RequestInit): string | null {
  const body = init?.body;
  if (body === undefined || body === null) return null;
  if (typeof body !== "string" || Buffer.byteLength(body) > MAX_HTTP_BODY_BYTES) invalid();
  return body;
}

async function boundedResponse(response: Response): Promise<Response> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > MAX_HTTP_BODY_BYTES) {
    throw new SdkError(SdkErrorCode.InvalidResult, "Response body exceeded its limit");
  }
  if (response.status < 200 || response.status >= 300) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  if (response.body === null) return response;
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() === "application/json") {
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
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      bytes += next.value.byteLength;
      if (bytes > MAX_HTTP_BODY_BYTES) {
        await reader.cancel();
        controller.error(
          new SdkError(SdkErrorCode.InvalidResult, "Response body exceeded its limit"),
        );
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

export function createSafeStreamableHttpFetch(
  options: CreateSafeStreamableHttpFetchOptions,
): SafeHttpFetch {
  const endpoint = new URL(options.endpoint.href);
  const approvedAddresses = Object.freeze(
    options.approved_addresses.map((address) => {
      const normalized = normalizedIp(address);
      if (normalized === null) invalid();
      return normalized;
    }),
  );
  const mappings = approvedMappings(options.approved_header_mappings);
  if (mappings.length > 0 && options.protocol_revision !== "2026-07-28") invalid();
  const now = options.now ?? (() => new Date());

  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    let requested: URL;
    try {
      requested = new URL(requestUrl(input));
    } catch {
      invalid();
    }
    if (requested.href !== endpoint.href) invalid();
    const method = requestMethod(init);
    const body = requestBody(init);
    const signal = init?.signal ?? new AbortController().signal;
    if (!(signal instanceof AbortSignal) || signal.aborted) {
      throw new RuntimeToolError("RUNTIME_TOOL_CANCELLED");
    }
    const headers = fixedHeaders({
      ...(init === undefined ? {} : { init }),
      method,
      body,
      mappings,
      protocol_revision: options.protocol_revision,
    });
    if (options.credential_reference !== null) {
      let token: string;
      try {
        token = normalizeBearer(
          await options.secret_provider.resolve(options.credential_reference, {
            signal,
            minimum_validity_ms: 1,
          }),
          now,
        );
      } catch {
        throw new RuntimeToolError(
          signal.aborted ? "RUNTIME_TOOL_CANCELLED" : "RUNTIME_TOOL_AUTHENTICATION",
        );
      }
      headers.set("authorization", `Bearer ${token}`);
    }
    let network: HttpNetworkResponse;
    try {
      network = await options.network_fetch(
        Object.freeze({
          url: endpoint.href,
          method,
          headers,
          body,
          signal,
          redirect: "error",
          approved_addresses: approvedAddresses,
          server_name: endpoint.hostname,
        }),
      );
    } catch (error) {
      if (error instanceof RuntimeToolError || error instanceof SdkError) throw error;
      if (signal.aborted) throw new RuntimeToolError("RUNTIME_TOOL_CANCELLED");
      throw new SdkError(SdkErrorCode.SendFailed, "Network request failed");
    }
    const remote = normalizedIp(network.remote_address);
    if (remote === null || !approvedAddresses.includes(remote)) {
      throw new SdkError(SdkErrorCode.SendFailed, "Remote address did not match DNS");
    }
    if (
      !(network.response instanceof Response) ||
      network.response.redirected ||
      (network.response.status >= 300 && network.response.status < 400)
    ) {
      const status = network.response instanceof Response ? network.response.status : 500;
      throw new SdkHttpError(SdkErrorCode.SendFailed, "Redirect refused", { status });
    }
    return await boundedResponse(network.response);
  };
}

const defaultDnsLookup: HttpDnsLookup = async (hostname) => {
  const resolved = await nodeLookup(hostname.replace(/^\[|\]$/gu, ""), {
    all: true,
    verbatim: true,
  });
  return resolved.map((entry) => {
    if (entry.family !== 4 && entry.family !== 6) unavailable();
    return { address: entry.address, family: entry.family };
  });
};

async function approvedResolution(
  endpoint: URL,
  mode: RuntimeMode,
  lookup: HttpDnsLookup,
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (signal.aborted) throw new RuntimeToolError("RUNTIME_TOOL_CANCELLED");
  let resolved: readonly HttpDnsAddress[];
  try {
    resolved = await lookup(endpoint.hostname.replace(/^\[|\]$/gu, ""), signal);
  } catch {
    throw new RuntimeToolError(
      signal.aborted ? "RUNTIME_TOOL_CANCELLED" : "RUNTIME_TOOL_UNAVAILABLE",
    );
  }
  if (resolved.length < 1 || resolved.length > MAX_DNS_ADDRESSES) unavailable();
  const allowLoopback = mode === "development" && endpoint.protocol === "http:";
  const addresses = new Set<string>();
  for (const entry of resolved) {
    const normalized = normalizedIp(entry.address);
    if (
      normalized === null ||
      isIP(normalized) !== entry.family ||
      (allowLoopback ? !isLoopbackAddress(normalized) : !isPublicAddress(normalized))
    ) {
      unavailable();
    }
    addresses.add(normalized);
  }
  return Object.freeze([...addresses].sort());
}

function sameAddresses(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((address, index) => address === right[index]);
}

export function createStreamableHttpToolTransport(
  options: CreateStreamableHttpToolTransportOptions,
): ToolTransportAdapter {
  const binding = captureRecord(options.binding);
  const endpoint = endpointFrom(binding, options.mode);
  const secretReferences = captureRecord(options.secret_references);
  const mappings = captureRecord(options.approved_header_mappings);
  const dnsLookup = options.dns_lookup ?? defaultDnsLookup;
  const sdkFactory = options.sdk_client_factory ?? createToolSdkClientFactory();
  const configurationResolution = approvedResolution(
    endpoint,
    options.mode,
    dnsLookup,
    new AbortController().signal,
  );
  void configurationResolution.catch(() => undefined);

  let credentialReference: SecretReference | null = null;
  if (binding.credential_reference !== null) {
    credentialReference = secretReferences[binding.credential_reference] ?? null;
    if (
      credentialReference === null ||
      (options.mode === "production" && credentialReference.source !== "command")
    ) {
      invalid();
    }
  }

  const adapter: ToolTransportAdapter = {
    kind: "streamable-http",
    async connect(request: ToolTransportConnectRequest): Promise<ToolTransportConnection> {
      if (Object.keys(mappings).length > 0 && request.protocol_revision !== "2026-07-28") {
        invalid();
      }
      const configuredAddresses = await configurationResolution;
      const connectedAddresses = await approvedResolution(
        endpoint,
        options.mode,
        dnsLookup,
        request.signal,
      );
      if (!sameAddresses(configuredAddresses, connectedAddresses)) unavailable();
      const safeFetch = createSafeStreamableHttpFetch({
        endpoint,
        approved_addresses: connectedAddresses,
        credential_reference: credentialReference,
        secret_provider: options.secret_provider,
        network_fetch: options.network_fetch,
        protocol_revision: request.protocol_revision,
        approved_header_mappings: mappings,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        fetch: safeFetch,
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
        transport_kind: "streamable-http",
      });
    },
  };
  return Object.freeze(adapter);
}
