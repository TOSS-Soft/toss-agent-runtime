import type { JsonValue } from "../../protocol/json.js";
import type { McpProtocolRevision, McpTransportKind } from "../types.js";

export interface ToolServerObservation {
  readonly name: string;
  readonly version: string;
  readonly identity_hash: `sha256:${string}`;
  readonly protocol_revision: McpProtocolRevision;
  readonly transport: McpTransportKind;
}

export interface NativeToolAnnotations {
  readonly read_only_hint: boolean | null;
  readonly destructive_hint: boolean | null;
  readonly idempotent_hint: boolean | null;
  readonly open_world_hint: boolean | null;
}

export interface NativeToolDefinition {
  readonly name: string;
  readonly input_schema: Readonly<Record<string, JsonValue>>;
  readonly output_schema: Readonly<Record<string, JsonValue>> | null;
  readonly annotations: NativeToolAnnotations;
}

export interface ToolListPage {
  readonly tools: readonly NativeToolDefinition[];
  readonly next_cursor: string | null;
}

export interface NativeToolTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface NativeToolImageContent {
  readonly type: "image";
  readonly media_type: string;
  readonly data_base64: string;
}

export interface NativeToolAudioContent {
  readonly type: "audio";
  readonly media_type: string;
  readonly data_base64: string;
}

export interface NativeToolResourceLinkContent {
  readonly type: "resource-link";
  readonly uri: string;
  readonly name: string;
  readonly mime_type: string | null;
}

export interface NativeToolEmbeddedResourceContent {
  readonly type: "embedded-resource";
  readonly uri: string;
  readonly mime_type: string | null;
  readonly text: string | null;
  readonly blob_base64: string | null;
}

export type NativeToolContent =
  | NativeToolTextContent
  | NativeToolImageContent
  | NativeToolAudioContent
  | NativeToolResourceLinkContent
  | NativeToolEmbeddedResourceContent;

export interface NativeToolCallRequest {
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly trusted_meta: Readonly<Record<string, JsonValue>> | null;
}

export interface NativeToolCallResult {
  readonly content: readonly NativeToolContent[];
  readonly structured_content: JsonValue | null;
  readonly is_error: boolean;
}

export interface ToolTransportConnection {
  readonly server: ToolServerObservation;
  listTools(cursor: string | null, signal: AbortSignal): Promise<ToolListPage>;
  callTool(request: NativeToolCallRequest, signal: AbortSignal): Promise<NativeToolCallResult>;
  close(signal: AbortSignal): Promise<void>;
}

export interface ToolTransportConnectRequest {
  readonly protocol_revision: McpProtocolRevision;
  readonly timeout_ms: number;
  readonly signal: AbortSignal;
  readonly on_tools_changed: () => void;
}

export interface ToolTransportAdapter {
  readonly kind: McpTransportKind;
  connect(request: ToolTransportConnectRequest): Promise<ToolTransportConnection>;
}

export interface ToolSdkClientConnectRequest extends ToolTransportConnectRequest {
  readonly transport: unknown;
  readonly transport_kind: McpTransportKind;
}

export interface ToolSdkClientFactory {
  connect(request: ToolSdkClientConnectRequest): Promise<ToolTransportConnection>;
}

export interface ToolSdkRequestOptions {
  readonly signal: AbortSignal;
  readonly timeout_ms: number;
}

export interface ToolSdkCallParams {
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly _meta?: Readonly<Record<string, JsonValue>>;
}

export interface ToolSdkClientCreateOptions {
  readonly supported_protocol_versions: readonly [McpProtocolRevision];
  readonly version_negotiation: "legacy" | Readonly<{ pin: "2026-07-28" }>;
  readonly client_capabilities: Readonly<Record<string, never>>;
  readonly accepts_server_requests: false;
  readonly auto_fulfill: false;
  readonly on_tools_changed: () => void;
}

/** @internal Test and transport seam. No SDK-owned type crosses this interface. */
export interface ToolSdkClientPort {
  connect(transport: unknown, options: ToolSdkRequestOptions): Promise<void>;
  getNegotiatedProtocolVersion(): string | undefined;
  getServerVersion(): unknown;
  getServerCapabilities(): unknown;
  listToolsPage(cursor: string | null, options: ToolSdkRequestOptions): Promise<unknown>;
  callTool(request: ToolSdkCallParams, options: ToolSdkRequestOptions): Promise<unknown>;
  close(): Promise<void>;
}

export interface ToolSdkClientFactoryOptions {
  readonly createClient?: (options: ToolSdkClientCreateOptions) => ToolSdkClientPort;
}
