import type { McpProfileReference } from "../agents/types.js";
import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  type JsonValue,
} from "../protocol/json.js";
import {
  hashMcpDiscoverySnapshot,
  parseMcpDiscoverySnapshot,
} from "./contracts.js";
import { RuntimeToolError } from "./errors.js";
import {
  captureToolServerObservation,
} from "./identity.js";
import type { McpProfileRegistry, RegisteredMcpProfile } from "./profile.js";
import type {
  McpDiscoveredServerV1,
  McpDiscoveredToolV1,
  McpDiscoverySnapshotV1,
  McpProfileServerRuleV1,
  McpProfileToolRuleV1,
  McpTransportKind,
} from "./types.js";
import { TOOL_HARD_LIMITS } from "./types.js";
import type {
  NativeToolDefinition,
  ToolTransportAdapter,
  ToolTransportConnection,
} from "./transports/types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface DiscoveredToolModelView {
  readonly alias: string;
  readonly description: string;
  readonly input_schema: JsonValue;
}

export interface DiscoveredToolView {
  readonly session_id: string;
  readonly profile: McpProfileReference;
  readonly discovery_snapshot_hash: `sha256:${string}`;
  readonly expires_at: string;
  readonly stale: boolean;
  readonly tools: readonly DiscoveredToolModelView[];
}

export interface ToolDiscoverySnapshotStore {
  publish(snapshot: McpDiscoverySnapshotV1, signal: AbortSignal): Promise<void>;
}

export interface OpenToolSessionRequest {
  readonly run_id: string;
  readonly execution_request_hash: `sha256:${string}`;
  readonly profile: McpProfileReference;
}

export interface ToolSession {
  readonly run_id: string;
  readonly session_id: string;
  readonly profile: McpProfileReference;
  discover(signal: AbortSignal): Promise<DiscoveredToolView>;
  snapshot(): McpDiscoverySnapshotV1 | null;
  connection(server_id: string): ToolTransportConnection;
  markListChanged(server_id: string): void;
  close(signal: AbortSignal): Promise<void>;
}

export interface ToolSessionManager {
  openSession(request: OpenToolSessionRequest): ToolSession;
  closeSession(
    request: Pick<OpenToolSessionRequest, "run_id" | "profile">,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface CreateToolSessionManagerOptions {
  readonly profile_registry: McpProfileRegistry;
  readonly adapters: Readonly<Record<string, ToolTransportAdapter>>;
  readonly snapshot_store: ToolDiscoverySnapshotStore;
  readonly now: () => Date;
  readonly create_session_id: () => string;
}

interface DiscoveryDeadline {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
}

interface DiscoveredServer {
  readonly entry: McpDiscoveredServerV1;
  readonly connection: ToolTransportConnection;
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function operationConflict(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_OPERATION_CONFLICT");
}

function unavailable(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
}

function resultInvalid(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_RESULT_INVALID");
}

function schemaMismatch(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_SCHEMA_MISMATCH");
}

function capturedJson<T>(value: T): T {
  try {
    return deepFreezeJson(parseJsonBytes(canonicalJson(value))) as unknown as T;
  } catch {
    resultInvalid();
  }
}

function canonicalTime(now: () => Date): number {
  let value: Date;
  try {
    value = now();
  } catch {
    unavailable();
  }
  const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(milliseconds)) unavailable();
  return milliseconds;
}

function normalizedProfileReference(value: McpProfileReference): McpProfileReference {
  const captured = capturedJson(value);
  if (
    captured.document_type !== "mcp-profile" ||
    typeof captured.artifact_id !== "string" ||
    !IDENTIFIER_PATTERN.test(captured.artifact_id) ||
    !Number.isSafeInteger(captured.revision) ||
    captured.revision < 1 ||
    typeof captured.hash !== "string" ||
    !SHA256_PATTERN.test(captured.hash)
  ) {
    throw new RuntimeToolError("RUNTIME_TOOL_INVALID");
  }
  return Object.freeze({
    document_type: "mcp-profile",
    artifact_id: captured.artifact_id,
    revision: captured.revision,
    hash: captured.hash,
  });
}

function normalizedOpenRequest(request: OpenToolSessionRequest): OpenToolSessionRequest {
  const captured = capturedJson(request);
  if (
    typeof captured.run_id !== "string" ||
    !IDENTIFIER_PATTERN.test(captured.run_id) ||
    typeof captured.execution_request_hash !== "string" ||
    !SHA256_PATTERN.test(captured.execution_request_hash)
  ) {
    throw new RuntimeToolError("RUNTIME_TOOL_INVALID");
  }
  return Object.freeze({
    run_id: captured.run_id,
    execution_request_hash: captured.execution_request_hash,
    profile: normalizedProfileReference(captured.profile),
  });
}

function sessionKey(runId: string, profile: McpProfileReference): string {
  return canonicalJson({ run_id: runId, profile });
}

function discoveryDeadline(signal: AbortSignal, timeoutMs: number): DiscoveryDeadline {
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw new RuntimeToolError("RUNTIME_TOOL_CANCELLED");
  }
  const timeout = new AbortController();
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    timeout.abort();
  }, timeoutMs);
  timer.unref();
  return {
    signal: AbortSignal.any([signal, timeout.signal]),
    timedOut: () => didTimeOut,
    dispose: () => clearTimeout(timer),
  };
}

function normalizeFailure(
  error: unknown,
  externalSignal: AbortSignal,
  deadline: DiscoveryDeadline,
): RuntimeToolError {
  if (externalSignal.aborted) return new RuntimeToolError("RUNTIME_TOOL_CANCELLED");
  if (deadline.timedOut()) return new RuntimeToolError("RUNTIME_TOOL_TIMEOUT");
  if (error instanceof RuntimeToolError) return error;
  return new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
}

function exactSchema(left: unknown, right: unknown, maxBytes: number): boolean {
  try {
    const leftJson = canonicalJson(left);
    const rightJson = canonicalJson(right);
    return (
      Buffer.byteLength(leftJson, "utf8") <= maxBytes &&
      Buffer.byteLength(rightJson, "utf8") <= maxBytes &&
      leftJson === rightJson
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capturedNativeTool(value: unknown, schemaBytes: number): NativeToolDefinition {
  const tool = capturedJson(value);
  if (
    !isRecord(tool) ||
    typeof tool.name !== "string" ||
    tool.name.length < 1 ||
    Buffer.byteLength(tool.name) > 256 ||
    /[\u0000-\u001f\u007f]/u.test(tool.name) ||
    !isRecord(tool.input_schema) ||
    (tool.output_schema !== null && !isRecord(tool.output_schema)) ||
    !isRecord(tool.annotations) ||
    Object.keys(tool.annotations).sort().join("\u0000") !==
      "destructive_hint\u0000idempotent_hint\u0000open_world_hint\u0000read_only_hint"
  ) {
    resultInvalid();
  }
  for (const value of Object.values(tool.annotations)) {
    if (value !== null && typeof value !== "boolean") resultInvalid();
  }
  try {
    if (
      Buffer.byteLength(canonicalJson(tool.input_schema)) > schemaBytes ||
      (tool.output_schema !== null &&
        Buffer.byteLength(canonicalJson(tool.output_schema)) > schemaBytes)
    ) {
      resultInvalid();
    }
  } catch (error) {
    if (error instanceof RuntimeToolError) throw error;
    resultInvalid();
  }
  return tool as unknown as NativeToolDefinition;
}

function operationRisk(operation: McpProfileToolRuleV1["operation_class"]): number {
  switch (operation) {
    case "read-only":
      return 0;
    case "reversible-write":
      return 1;
    case "irreversible":
      return 2;
  }
}

function nativeRisk(tool: NativeToolDefinition): number {
  if (tool.annotations.destructive_hint === true) return 2;
  if (tool.annotations.read_only_hint === true) return 0;
  return 1;
}

function validateNativeTool(
  native: NativeToolDefinition,
  rule: McpProfileToolRuleV1,
  schemaBytes: number,
): McpDiscoveredToolV1 {
  if (
    native.name !== rule.native_name ||
    !exactSchema(native.input_schema, rule.input_schema, schemaBytes) ||
    !exactSchema(native.output_schema, rule.output_schema, schemaBytes) ||
    nativeRisk(native) > operationRisk(rule.operation_class)
  ) {
    schemaMismatch();
  }
  const annotations = capturedJson(native.annotations);
  if (
    ![annotations.read_only_hint, annotations.destructive_hint, annotations.idempotent_hint,
      annotations.open_world_hint].every((value) => value === null || typeof value === "boolean")
  ) {
    resultInvalid();
  }
  return Object.freeze({
    alias: rule.alias,
    native_name: rule.native_name,
    input_schema_hash: rule.input_schema_hash,
    output_schema_hash: rule.output_schema_hash,
    operation_class: rule.operation_class,
    annotations: Object.freeze({
      read_only_hint: annotations.read_only_hint,
      destructive_hint: annotations.destructive_hint,
      idempotent_hint: annotations.idempotent_hint,
      open_world_hint: annotations.open_world_hint,
    }),
  });
}

function validPage(value: unknown): value is {
  readonly tools: readonly NativeToolDefinition[];
  readonly next_cursor: string | null;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { readonly tools?: unknown }).tools) &&
    ((value as { readonly next_cursor?: unknown }).next_cursor === null ||
      (typeof (value as { readonly next_cursor?: unknown }).next_cursor === "string" &&
        ((value as { readonly next_cursor: string }).next_cursor.length > 0) &&
        Buffer.byteLength((value as { readonly next_cursor: string }).next_cursor) <= 4_096))
  );
}

async function discoverServer(options: {
  readonly adapter: ToolTransportAdapter;
  readonly binding_transport: McpTransportKind;
  readonly rule: McpProfileServerRuleV1;
  readonly profile: RegisteredMcpProfile;
  readonly signal: AbortSignal;
  readonly on_tools_changed: () => void;
  readonly previous: McpDiscoveredServerV1 | undefined;
}): Promise<DiscoveredServer> {
  if (options.adapter.kind !== options.binding_transport) {
    throw new RuntimeToolError("RUNTIME_TOOL_PROTOCOL_DOWNGRADE");
  }
  const connection = await options.adapter.connect({
    protocol_revision: options.rule.protocol_revision,
    timeout_ms: options.profile.profile.limits.discovery_timeout_ms,
    signal: options.signal,
    on_tools_changed: options.on_tools_changed,
  });
  try {
    const producer = captureToolServerObservation(connection.server, {
      protocol_revision: options.rule.protocol_revision,
      transport: options.binding_transport,
    });
    if (
      options.previous !== undefined &&
      (producer.identity_hash !== options.previous.server.identity_hash ||
        producer.protocol_revision !== options.previous.protocol_revision ||
        producer.transport !== options.previous.transport)
    ) {
      throw new RuntimeToolError("RUNTIME_TOOL_PROTOCOL_DOWNGRADE");
    }
    const maxPages = Math.min(
      options.profile.profile.limits.discovery_pages_per_server,
      TOOL_HARD_LIMITS.discoveryPagesPerServer,
    );
    const maxTools = Math.min(
      options.profile.profile.limits.tools_per_server,
      TOOL_HARD_LIMITS.toolsPerServer,
    );
    const native = new Map<string, NativeToolDefinition>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      pages += 1;
      if (pages > maxPages) resultInvalid();
      const page = await connection.listTools(cursor, options.signal);
      if (!validPage(page)) resultInvalid();
      if (native.size + page.tools.length > maxTools) resultInvalid();
      for (const rawTool of page.tools) {
        const tool = capturedNativeTool(
          rawTool,
          Math.min(options.profile.profile.limits.schema_bytes, TOOL_HARD_LIMITS.schemaBytes),
        );
        if (native.has(tool.name)) resultInvalid();
        native.set(tool.name, tool);
      }
      if (page.next_cursor === null) break;
      if (cursors.has(page.next_cursor)) resultInvalid();
      cursors.add(page.next_cursor);
      cursor = page.next_cursor;
    }
    const tools = options.rule.tools.map((rule) => {
      const observed = native.get(rule.native_name);
      if (observed === undefined) schemaMismatch();
      return validateNativeTool(
        observed,
        rule,
        Math.min(options.profile.profile.limits.schema_bytes, TOOL_HARD_LIMITS.schemaBytes),
      );
    });
    tools.sort((left, right) => bytewiseCompare(left.alias, right.alias));
    return Object.freeze({
      entry: Object.freeze({
        server_id: options.rule.server_id,
        binding_name: options.rule.binding_name,
        transport: options.binding_transport,
        protocol_revision: options.rule.protocol_revision,
        server: Object.freeze({
          name: producer.name,
          version: producer.version,
          identity_hash: producer.identity_hash,
        }),
        tools: Object.freeze(tools),
      }),
      connection,
    });
  } catch (error) {
    await connection.close(new AbortController().signal).catch(() => undefined);
    throw error;
  }
}

function makeSnapshot(options: {
  readonly run_id: string;
  readonly session_id: string;
  readonly execution_request_hash: `sha256:${string}`;
  readonly profile: McpProfileReference;
  readonly created_at: string;
  readonly expires_at: string;
  readonly stale: boolean;
  readonly servers: readonly McpDiscoveredServerV1[];
}): McpDiscoverySnapshotV1 {
  const hashable = {
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "mcp-discovery-snapshot.v1" as const,
    document_type: "mcp-discovery-snapshot" as const,
    ...options,
  };
  const candidate = { ...hashable, document_hash: hashMcpDiscoverySnapshot(hashable) };
  const parsed = parseMcpDiscoverySnapshot(canonicalJson(candidate));
  if (!parsed.ok) resultInvalid();
  return parsed.value;
}

function staleSnapshot(snapshot: McpDiscoverySnapshotV1): McpDiscoverySnapshotV1 {
  return makeSnapshot({
    run_id: snapshot.run_id,
    session_id: snapshot.session_id,
    execution_request_hash: snapshot.execution_request_hash,
    profile: snapshot.profile,
    created_at: snapshot.created_at,
    expires_at: snapshot.expires_at,
    stale: true,
    servers: snapshot.servers,
  });
}

function viewFor(
  snapshot: McpDiscoverySnapshotV1,
  profile: RegisteredMcpProfile,
): DiscoveredToolView {
  const tools = profile.profile.servers
    .flatMap((server) => server.tools)
    .map((tool) =>
      Object.freeze({
        alias: tool.alias,
        description: tool.description,
        input_schema: capturedJson(tool.input_schema),
      }),
    )
    .sort((left, right) => bytewiseCompare(left.alias, right.alias));
  return Object.freeze({
    session_id: snapshot.session_id,
    profile: snapshot.profile,
    discovery_snapshot_hash: snapshot.document_hash,
    expires_at: snapshot.expires_at,
    stale: snapshot.stale,
    tools: Object.freeze(tools),
  });
}

async function closeConnections(
  connections: ReadonlyMap<string, ToolTransportConnection>,
  signal: AbortSignal,
): Promise<void> {
  const settled = await Promise.allSettled(
    [...connections.values()].map(async (connection) => connection.close(signal)),
  );
  const failure = settled.find((result) => result.status === "rejected");
  if (failure !== undefined) unavailable();
}

export function createToolSessionManager(
  options: CreateToolSessionManagerOptions,
): ToolSessionManager {
  const sessions = new Map<
    string,
    Readonly<{
      session: ToolSession;
      execution_request_hash: `sha256:${string}`;
    }>
  >();
  const sessionIds = new Set<string>();

  function createSession(
    request: OpenToolSessionRequest,
    profile: RegisteredMcpProfile,
    key: string,
  ): ToolSession {
    const openedAt = canonicalTime(options.now);
    const expiresAt = openedAt + profile.profile.limits.session_lifetime_ms;
    let sessionId: string;
    try {
      sessionId = options.create_session_id();
    } catch {
      unavailable();
    }
    if (
      typeof sessionId !== "string" ||
      !IDENTIFIER_PATTERN.test(sessionId) ||
      sessionIds.has(sessionId)
    ) {
      unavailable();
    }
    sessionIds.add(sessionId);
    let closed = false;
    let dirty = false;
    let currentSnapshot: McpDiscoverySnapshotV1 | null = null;
    let currentView: DiscoveredToolView | null = null;
    let connections = new Map<string, ToolTransportConnection>();
    let pendingStaleSnapshot: McpDiscoverySnapshotV1 | null = null;
    let serial: Promise<void> = Promise.resolve();

    function serialize<T>(operation: () => Promise<T>): Promise<T> {
      const result = serial.then(operation, operation);
      serial = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }

    function ensureActive(signal: AbortSignal): void {
      if (!(signal instanceof AbortSignal) || signal.aborted) {
        throw new RuntimeToolError("RUNTIME_TOOL_CANCELLED");
      }
      if (closed || canonicalTime(options.now) >= expiresAt) unavailable();
    }

    function markListChanged(serverId: string): void {
      if (
        closed ||
        !profile.profile.servers.some((server) => server.server_id === serverId)
      ) {
        return;
      }
      dirty = true;
      if (currentSnapshot !== null && !currentSnapshot.stale) {
        currentSnapshot = staleSnapshot(currentSnapshot);
        currentView = viewFor(currentSnapshot, profile);
        pendingStaleSnapshot = currentSnapshot;
      }
    }

    const session: ToolSession = {
      run_id: request.run_id,
      session_id: sessionId,
      profile: request.profile,
      discover(signal: AbortSignal): Promise<DiscoveredToolView> {
        return serialize(async () => {
          ensureActive(signal);
          if (currentView !== null && !dirty && !currentView.stale) return currentView;
          const deadline = discoveryDeadline(
            signal,
            profile.profile.limits.discovery_timeout_ms,
          );
          const previousSnapshot = currentSnapshot;
          const previousConnections = connections;
          const discoveredConnections = new Map<string, ToolTransportConnection>();
          try {
            if (pendingStaleSnapshot !== null) {
              await options.snapshot_store.publish(pendingStaleSnapshot, deadline.signal);
              pendingStaleSnapshot = null;
            }
            if (previousConnections.size > 0) {
              await closeConnections(previousConnections, deadline.signal);
              connections = new Map();
            }
            dirty = false;
            const settled = await Promise.allSettled(
              profile.profile.servers.map(async (rule) => {
                const binding = profile.bindings[rule.binding_name];
                const adapter = options.adapters[rule.binding_name];
                if (binding === undefined || adapter === undefined) unavailable();
                const result = await discoverServer({
                  adapter,
                  binding_transport: binding.transport,
                  rule,
                  profile,
                  signal: deadline.signal,
                  on_tools_changed: () => markListChanged(rule.server_id),
                  previous: previousSnapshot?.servers.find(
                    (server) => server.server_id === rule.server_id,
                  ),
                });
                discoveredConnections.set(rule.server_id, result.connection);
                return result.entry;
              }),
            );
            const rejected = settled.find(
              (result): result is PromiseRejectedResult => result.status === "rejected",
            );
            if (rejected !== undefined) throw rejected.reason;
            const servers = settled
              .map((result) => (result as PromiseFulfilledResult<McpDiscoveredServerV1>).value)
              .sort((left, right) => bytewiseCompare(left.server_id, right.server_id));
            const created = canonicalTime(options.now);
            if (created >= expiresAt) unavailable();
            const snapshot = makeSnapshot({
              run_id: request.run_id,
              session_id: sessionId,
              execution_request_hash: request.execution_request_hash,
              profile: request.profile,
              created_at: new Date(created).toISOString(),
              expires_at: new Date(expiresAt).toISOString(),
              stale: dirty,
              servers,
            });
            await options.snapshot_store.publish(snapshot, deadline.signal);
            currentSnapshot = snapshot;
            currentView = viewFor(snapshot, profile);
            connections = discoveredConnections;
            return currentView;
          } catch (error) {
            await closeConnections(discoveredConnections, new AbortController().signal).catch(
              () => undefined,
            );
            throw normalizeFailure(error, signal, deadline);
          } finally {
            deadline.dispose();
          }
        });
      },
      snapshot(): McpDiscoverySnapshotV1 | null {
        return currentSnapshot;
      },
      connection(serverId: string): ToolTransportConnection {
        if (
          closed ||
          currentSnapshot === null ||
          currentSnapshot.stale ||
          canonicalTime(options.now) >= expiresAt
        ) {
          unavailable();
        }
        const connection = connections.get(serverId);
        if (connection === undefined) unavailable();
        return connection;
      },
      markListChanged,
      close(signal: AbortSignal): Promise<void> {
        return serialize(async () => {
          if (closed) return;
          if (!(signal instanceof AbortSignal) || signal.aborted) {
            throw new RuntimeToolError("RUNTIME_TOOL_CANCELLED");
          }
          closed = true;
          await closeConnections(connections, signal);
          connections = new Map();
          sessions.delete(key);
          sessionIds.delete(sessionId);
        });
      },
    };
    return Object.freeze(session);
  }

  return Object.freeze({
    openSession(input: OpenToolSessionRequest): ToolSession {
      const request = normalizedOpenRequest(input);
      const key = sessionKey(request.run_id, request.profile);
      const existing = sessions.get(key);
      if (existing !== undefined) {
        if (existing.execution_request_hash !== request.execution_request_hash) {
          operationConflict();
        }
        return existing.session;
      }
      let profile: RegisteredMcpProfile;
      try {
        profile = options.profile_registry.resolve(request.profile);
      } catch (error) {
        if (error instanceof RuntimeToolError) throw error;
        unavailable();
      }
      const session = createSession(request, profile, key);
      sessions.set(
        key,
        Object.freeze({
          session,
          execution_request_hash: request.execution_request_hash,
        }),
      );
      return session;
    },
    async closeSession(
      input: Pick<OpenToolSessionRequest, "run_id" | "profile">,
      signal: AbortSignal,
    ): Promise<void> {
      const profile = normalizedProfileReference(input.profile);
      const entry = sessions.get(sessionKey(input.run_id, profile));
      if (entry !== undefined) await entry.session.close(signal);
    },
  });
}
