import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { RuntimeAgentError } from "../agents/errors.js";
import {
  createPrivateAgentStore,
  type PrivateAgentStore,
  type PrivateAgentStoreOperationHooks,
  type PrivateStoreListenerState,
  type PrivateStoreProcessLiveness,
} from "../agents/private-store.js";
import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonValue,
} from "../protocol/json.js";
import { parseToolApproval, parseToolCall, parseToolResult } from "./contracts.js";
import { RuntimeToolError } from "./errors.js";
import type { ToolApprovalV1, ToolCallV1, ToolResultV1 } from "./types.js";
import { TOOL_HARD_LIMITS } from "./types.js";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OBJECT_NAME_PATTERN = /^[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STORE_RECORD_SCHEMA = "tool-private-record.v1";
const CHUNK_BYTES = 512 * 1024;
const MAX_OBJECT_ENTRIES = 8_192;
const MAX_DOCUMENT_BYTES = TOOL_HARD_LIMITS.resultBytes;
const REDACTED = "[REDACTED]";
const SECRET_FIELD =
  /(?:authorization|api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|private[_-]?key|bearer)/iu;

type StoredRecordType = "approval" | "call" | "operation" | "quarantine" | "result";
type QuarantineReason =
  | "invalid-chain"
  | "orphan-approval"
  | "orphan-chunk"
  | "orphan-operation"
  | "orphan-result"
  | "record-conflict";

export type ToolPrivateStoreProcessLiveness = PrivateStoreProcessLiveness;
export type ToolPrivateStoreListenerState = PrivateStoreListenerState;
export type ToolPrivateStoreOperationHooks = PrivateAgentStoreOperationHooks;

export interface ToolStoreOperationV1 {
  readonly schema_version: "tool-store-operation.v1";
  readonly operation_id: string;
  readonly operation_kind: "approval-decision" | "recovery" | "uncertain-disposition";
  readonly run_id: string;
  readonly call_id: string;
  readonly request_hash: `sha256:${string}`;
  readonly outcome_hash: `sha256:${string}`;
  readonly occurred_at: string;
  readonly record_hash: `sha256:${string}`;
}

interface ToolStoreQuarantineV1 {
  readonly schema_version: "tool-store-quarantine.v1";
  readonly target_object_hash: `sha256:${string}`;
  readonly reason: QuarantineReason;
  readonly recorded_at: string;
  readonly record_hash: `sha256:${string}`;
}

interface StoredManifest {
  readonly schema_version: typeof STORE_RECORD_SCHEMA;
  readonly record_type: StoredRecordType;
  readonly record_hash: `sha256:${string}`;
  readonly run_id: string;
  readonly call_id: string;
  readonly call_revision: number | null;
  readonly operation_id: string | null;
  readonly payload_bytes: number;
  readonly payload_hash: `sha256:${string}`;
  readonly chunks: readonly `sha256:${string}`[];
}

interface LoadedRecord<T> {
  readonly object_hash: `sha256:${string}`;
  readonly manifest: StoredManifest;
  readonly value: T;
}

interface QuarantineCandidate {
  readonly target_object_hash: `sha256:${string}`;
  readonly reason: QuarantineReason;
}

interface StoreScan {
  readonly calls: ReadonlyMap<string, readonly LoadedRecord<ToolCallV1>[]>;
  readonly approvals: ReadonlyMap<`sha256:${string}`, LoadedRecord<ToolApprovalV1>>;
  readonly results: ReadonlyMap<string, LoadedRecord<ToolResultV1>>;
  readonly operations: ReadonlyMap<string, LoadedRecord<ToolStoreOperationV1>>;
  readonly quarantine_targets: ReadonlySet<`sha256:${string}`>;
  readonly pending_quarantine: readonly QuarantineCandidate[];
}

export interface ToolPrivateStoreRecovery {
  readonly calls: number;
  readonly approvals: number;
  readonly results: number;
  readonly operations: number;
  readonly quarantined: number;
}

export interface CreateToolPrivateStoreOptions {
  readonly state_path: string;
  readonly now?: () => Date;
  readonly is_process_alive?: (pid: number) => ToolPrivateStoreProcessLiveness;
  readonly has_service_listener: () => Promise<ToolPrivateStoreListenerState>;
  readonly is_current_user?: (userId: bigint, candidate: string) => boolean;
  readonly operation_hooks?: ToolPrivateStoreOperationHooks;
}

export interface ToolPrivateStore {
  ensureRoots(): Promise<void>;
  recover(): Promise<ToolPrivateStoreRecovery>;
  appendCall(call: ToolCallV1): Promise<ToolCallV1>;
  latestCall(run_id: string, call_id: string): Promise<ToolCallV1 | null>;
  callHistory(run_id: string, call_id: string): Promise<readonly ToolCallV1[]>;
  publishApproval(approval: ToolApprovalV1): Promise<ToolApprovalV1>;
  approval(document_hash: `sha256:${string}`): Promise<ToolApprovalV1 | null>;
  publishResult(result: ToolResultV1): Promise<ToolResultV1>;
  result(run_id: string, call_id: string): Promise<ToolResultV1 | null>;
  recordOperation(operation: ToolStoreOperationV1): Promise<ToolStoreOperationV1>;
  operation(operation_id: string): Promise<ToolStoreOperationV1 | null>;
  stopIntake(): void;
  flush(): Promise<void>;
}

const ACTIVE_MUTATIONS = new Map<string, Promise<void>>();

function invalid(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_INVALID");
}

function conflict(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_OPERATION_CONFLICT");
}

function unavailable(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
}

function internal(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_INTERNAL");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function contentHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function recordKey(runId: string, callId: string): string {
  return `${runId}\u0000${callId}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function genericRedactedText(value: string): string {
  return value
    .replace(/\b(authorization\s*:\s*)(?:bearer\s+)?[^\s,;]+/giu, "$1[REDACTED]")
    .replace(
      /\b((?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?key|token)\s*[=:]\s*)["']?[^\s,;&"']+["']?/giu,
      "$1[REDACTED]",
    )
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED]");
}

function containsUnredactedSecret(value: JsonValue): boolean {
  if (typeof value === "string") return genericRedactedText(value) !== value;
  if (isJsonArray(value)) return value.some((child) => containsUnredactedSecret(child));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      (SECRET_FIELD.test(key) && child !== REDACTED) || containsUnredactedSecret(child),
  );
}

function hasSecretShapedKey(value: JsonValue): boolean {
  if (isJsonArray(value)) return value.some((child) => hasSecretShapedKey(child));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) => SECRET_FIELD.test(key) || hasSecretShapedKey(child),
  );
}

function asJson(value: unknown): JsonValue {
  try {
    return parseJsonBytes(
      canonicalJson(value, {
        maxBytes: MAX_DOCUMENT_BYTES,
        maxDepth: 64,
        maxMembers: 250_000,
      }),
      {
        maxBytes: MAX_DOCUMENT_BYTES,
        maxDepth: 64,
        maxMembers: 250_000,
      },
    );
  } catch {
    invalid();
  }
}

function safeNow(now: () => Date): string {
  let value: Date;
  try {
    value = now();
  } catch {
    internal();
  }
  const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(milliseconds)) internal();
  return new Date(milliseconds).toISOString();
}

function parseManifest(bytes: Uint8Array): StoredManifest | null {
  let value: JsonValue;
  try {
    value = parseJsonBytes(bytes, { maxBytes: 64 * 1024, maxDepth: 8, maxMembers: 128 });
  } catch {
    return null;
  }
  if (!isRecord(value) || value.schema_version !== STORE_RECORD_SCHEMA) return null;
  if (
    !exactKeys(value, [
      "call_id",
      "call_revision",
      "chunks",
      "operation_id",
      "payload_bytes",
      "payload_hash",
      "record_hash",
      "record_type",
      "run_id",
      "schema_version",
    ]) ||
    typeof value.record_type !== "string" ||
    !["approval", "call", "operation", "quarantine", "result"].includes(value.record_type) ||
    typeof value.record_hash !== "string" ||
    !HASH_PATTERN.test(value.record_hash) ||
    typeof value.run_id !== "string" ||
    !IDENTIFIER_PATTERN.test(value.run_id) ||
    typeof value.call_id !== "string" ||
    !IDENTIFIER_PATTERN.test(value.call_id) ||
    (value.call_revision !== null &&
      (!Number.isSafeInteger(value.call_revision) || Number(value.call_revision) < 1)) ||
    (value.operation_id !== null &&
      (typeof value.operation_id !== "string" ||
        (!IDENTIFIER_PATTERN.test(value.operation_id) &&
          !UUID_PATTERN.test(value.operation_id)))) ||
    !Number.isSafeInteger(value.payload_bytes) ||
    Number(value.payload_bytes) < 2 ||
    Number(value.payload_bytes) > MAX_DOCUMENT_BYTES ||
    typeof value.payload_hash !== "string" ||
    !HASH_PATTERN.test(value.payload_hash) ||
    !Array.isArray(value.chunks) ||
    value.chunks.length < 1 ||
    value.chunks.length > Math.ceil(MAX_DOCUMENT_BYTES / CHUNK_BYTES) + 1 ||
    !value.chunks.every((chunk) => typeof chunk === "string" && HASH_PATTERN.test(chunk))
  ) {
    internal();
  }
  const manifest = deepFreezeJson(value) as unknown as StoredManifest;
  if (canonicalJson(manifest) !== Buffer.from(bytes).toString("utf8")) internal();
  return manifest;
}

function operationHash(value: Omit<ToolStoreOperationV1, "record_hash">): `sha256:${string}` {
  return sha256(value);
}

function parseOperation(value: JsonValue): ToolStoreOperationV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "call_id",
      "occurred_at",
      "operation_id",
      "operation_kind",
      "outcome_hash",
      "record_hash",
      "request_hash",
      "run_id",
      "schema_version",
    ]) ||
    value.schema_version !== "tool-store-operation.v1" ||
    typeof value.operation_id !== "string" ||
    !IDENTIFIER_PATTERN.test(value.operation_id) ||
    typeof value.operation_kind !== "string" ||
    !["approval-decision", "recovery", "uncertain-disposition"].includes(value.operation_kind) ||
    typeof value.run_id !== "string" ||
    !IDENTIFIER_PATTERN.test(value.run_id) ||
    typeof value.call_id !== "string" ||
    !IDENTIFIER_PATTERN.test(value.call_id) ||
    typeof value.request_hash !== "string" ||
    !HASH_PATTERN.test(value.request_hash) ||
    typeof value.outcome_hash !== "string" ||
    !HASH_PATTERN.test(value.outcome_hash) ||
    typeof value.occurred_at !== "string" ||
    !Number.isFinite(Date.parse(value.occurred_at)) ||
    !value.occurred_at.endsWith("Z") ||
    typeof value.record_hash !== "string" ||
    !HASH_PATTERN.test(value.record_hash)
  ) {
    invalid();
  }
  const operation = deepFreezeJson(value) as unknown as ToolStoreOperationV1;
  const hashable = {
    schema_version: operation.schema_version,
    operation_id: operation.operation_id,
    operation_kind: operation.operation_kind,
    run_id: operation.run_id,
    call_id: operation.call_id,
    request_hash: operation.request_hash,
    outcome_hash: operation.outcome_hash,
    occurred_at: operation.occurred_at,
  };
  if (operation.record_hash !== operationHash(hashable)) invalid();
  return operation;
}

function parseQuarantine(value: JsonValue): ToolStoreQuarantineV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "reason",
      "record_hash",
      "recorded_at",
      "schema_version",
      "target_object_hash",
    ]) ||
    value.schema_version !== "tool-store-quarantine.v1" ||
    typeof value.target_object_hash !== "string" ||
    !HASH_PATTERN.test(value.target_object_hash) ||
    typeof value.reason !== "string" ||
    ![
      "invalid-chain",
      "orphan-approval",
      "orphan-chunk",
      "orphan-operation",
      "orphan-result",
      "record-conflict",
    ].includes(value.reason) ||
    typeof value.recorded_at !== "string" ||
    !Number.isFinite(Date.parse(value.recorded_at)) ||
    !value.recorded_at.endsWith("Z") ||
    typeof value.record_hash !== "string" ||
    !HASH_PATTERN.test(value.record_hash)
  ) {
    internal();
  }
  const quarantine = deepFreezeJson(value) as unknown as ToolStoreQuarantineV1;
  const hashable = {
    schema_version: quarantine.schema_version,
    target_object_hash: quarantine.target_object_hash,
    reason: quarantine.reason,
    recorded_at: quarantine.recorded_at,
  };
  if (quarantine.record_hash !== sha256(hashable)) internal();
  return quarantine;
}

function manifestFor(
  recordType: StoredRecordType,
  value: ToolApprovalV1 | ToolCallV1 | ToolResultV1 | ToolStoreOperationV1 | ToolStoreQuarantineV1,
  payload: Uint8Array,
  chunks: readonly `sha256:${string}`[],
): StoredManifest {
  let runId: string;
  let callId: string;
  let recordHash: `sha256:${string}`;
  let callRevision: number | null = null;
  let operationId: string | null = null;
  switch (recordType) {
    case "call": {
      const call = value as ToolCallV1;
      runId = call.run_id;
      callId = call.call_id;
      recordHash = call.document_hash;
      callRevision = call.call_revision;
      break;
    }
    case "approval": {
      const approval = value as ToolApprovalV1;
      runId = approval.run_id;
      callId = approval.call_id;
      recordHash = approval.document_hash;
      operationId = approval.kind === "DECISION" ? approval.operation_id : null;
      break;
    }
    case "result": {
      const result = value as ToolResultV1;
      runId = result.run_id;
      callId = result.call_id;
      recordHash = result.document_hash;
      break;
    }
    case "operation": {
      const operation = value as ToolStoreOperationV1;
      runId = operation.run_id;
      callId = operation.call_id;
      recordHash = operation.record_hash;
      operationId = operation.operation_id;
      break;
    }
    case "quarantine": {
      const quarantine = value as ToolStoreQuarantineV1;
      runId = "quarantine";
      callId = `object-${quarantine.target_object_hash.slice("sha256:".length, 39)}`;
      recordHash = quarantine.record_hash;
      break;
    }
  }
  return Object.freeze({
    schema_version: STORE_RECORD_SCHEMA,
    record_type: recordType,
    record_hash: recordHash,
    run_id: runId,
    call_id: callId,
    call_revision: callRevision,
    operation_id: operationId,
    payload_bytes: payload.byteLength,
    payload_hash: contentHash(payload),
    chunks: Object.freeze([...chunks]),
  });
}

function immutableCallFields(call: ToolCallV1): JsonValue {
  return asJson({
    run_id: call.run_id,
    execution_request_hash: call.execution_request_hash,
    agent_definition: call.agent_definition,
    task_contract: call.task_contract,
    role: call.role,
    profile: call.profile,
    discovery_snapshot_hash: call.discovery_snapshot_hash,
    session_id: call.session_id,
    server_id: call.server_id,
    transport: call.transport,
    protocol_revision: call.protocol_revision,
    alias: call.alias,
    native_name: call.native_name,
    input_schema_hash: call.input_schema_hash,
    output_schema_hash: call.output_schema_hash,
    operation_class: call.operation_class,
    logical_call_id: call.logical_call_id,
    operation_id: call.operation_id,
    call_id: call.call_id,
    idempotency_key: call.idempotency_key,
    logical_arguments: call.logical_arguments,
    logical_input_hash: call.logical_input_hash,
    prepared_at: call.prepared_at,
  });
}

function validCallSuccessor(previous: ToolCallV1, next: ToolCallV1): boolean {
  if (
    next.call_revision !== previous.call_revision + 1 ||
    next.previous_call_hash !== previous.document_hash ||
    !sameJson(immutableCallFields(previous), immutableCallFields(next)) ||
    previous.terminal_at !== null
  ) {
    return false;
  }
  if (next.stage === "PREPARED") {
    return (
      previous.stage === "PREPARED" &&
      previous.approval_request_hash === null &&
      next.approval_request_hash !== null
    );
  }
  return previous.stage === "PREPARED";
}

function exactApprovalCall(approval: ToolApprovalV1, call: ToolCallV1): boolean {
  if (approval.kind === "DECISION")
    return approval.run_id === call.run_id && approval.call_id === call.call_id;
  return (
    approval.run_id === call.run_id &&
    approval.execution_request_hash === call.execution_request_hash &&
    sameJson(approval.agent_definition, call.agent_definition) &&
    sameJson(approval.task_contract, call.task_contract) &&
    approval.role === call.role &&
    sameJson(approval.profile, call.profile) &&
    approval.discovery_snapshot_hash === call.discovery_snapshot_hash &&
    approval.server_id === call.server_id &&
    approval.alias === call.alias &&
    approval.native_name === call.native_name &&
    approval.input_schema_hash === call.input_schema_hash &&
    approval.output_schema_hash === call.output_schema_hash &&
    approval.operation_class === call.operation_class &&
    approval.logical_input_hash === call.logical_input_hash &&
    approval.call_id === call.call_id &&
    approval.idempotency_key === call.idempotency_key
  );
}

function exactResultCall(result: ToolResultV1, call: ToolCallV1): boolean {
  return (
    result.run_id === call.run_id &&
    result.call_id === call.call_id &&
    result.idempotency_key === call.idempotency_key &&
    sameJson(result.provenance.profile, call.profile) &&
    result.provenance.discovery_snapshot_hash === call.discovery_snapshot_hash &&
    result.provenance.server_id === call.server_id &&
    result.provenance.protocol_revision === call.protocol_revision &&
    result.provenance.transport === call.transport &&
    result.provenance.alias === call.alias &&
    result.provenance.native_name === call.native_name &&
    result.provenance.input_schema_hash === call.input_schema_hash &&
    result.provenance.output_schema_hash === call.output_schema_hash
  );
}

function parseStoredValue(
  manifest: StoredManifest,
  payload: Uint8Array,
): ToolApprovalV1 | ToolCallV1 | ToolResultV1 | ToolStoreOperationV1 | ToolStoreQuarantineV1 {
  const text = Buffer.from(payload).toString("utf8");
  switch (manifest.record_type) {
    case "call": {
      const parsed = parseToolCall(text);
      if (
        !parsed.ok ||
        parsed.value.document_hash !== manifest.record_hash ||
        parsed.value.run_id !== manifest.run_id ||
        parsed.value.call_id !== manifest.call_id ||
        parsed.value.call_revision !== manifest.call_revision ||
        manifest.operation_id !== null
      ) {
        internal();
      }
      return parsed.value;
    }
    case "approval": {
      const parsed = parseToolApproval(text);
      if (
        !parsed.ok ||
        parsed.value.document_hash !== manifest.record_hash ||
        parsed.value.run_id !== manifest.run_id ||
        parsed.value.call_id !== manifest.call_id ||
        manifest.call_revision !== null ||
        manifest.operation_id !==
          (parsed.value.kind === "DECISION" ? parsed.value.operation_id : null)
      ) {
        internal();
      }
      return parsed.value;
    }
    case "result": {
      const parsed = parseToolResult(text);
      if (
        !parsed.ok ||
        parsed.value.document_hash !== manifest.record_hash ||
        parsed.value.run_id !== manifest.run_id ||
        parsed.value.call_id !== manifest.call_id ||
        manifest.call_revision !== null ||
        manifest.operation_id !== null
      ) {
        internal();
      }
      return parsed.value;
    }
    case "operation": {
      const value = parseOperation(parseJsonBytes(payload));
      if (
        value.record_hash !== manifest.record_hash ||
        value.run_id !== manifest.run_id ||
        value.call_id !== manifest.call_id ||
        manifest.call_revision !== null ||
        value.operation_id !== manifest.operation_id
      ) {
        internal();
      }
      return value;
    }
    case "quarantine": {
      const value = parseQuarantine(parseJsonBytes(payload));
      if (
        value.record_hash !== manifest.record_hash ||
        manifest.run_id !== "quarantine" ||
        manifest.call_revision !== null ||
        manifest.operation_id !== null
      ) {
        internal();
      }
      return value;
    }
  }
}

function safeRecord<T>(record: LoadedRecord<T>): LoadedRecord<T> {
  return Object.freeze(record);
}

async function serializeMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = ACTIVE_MUTATIONS.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(operation, operation);
  ACTIVE_MUTATIONS.set(key, gate);
  try {
    return await queued;
  } finally {
    release?.();
    if (ACTIVE_MUTATIONS.get(key) === gate) ACTIVE_MUTATIONS.delete(key);
  }
}

async function translateFailure<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RuntimeToolError) throw error;
    if (error instanceof RuntimeAgentError) internal();
    internal();
  }
}

export function createToolPrivateStore(options: CreateToolPrivateStoreOptions): ToolPrivateStore {
  const storeStatePath = path.join(options.state_path, "tools");
  const mutationKey = path.resolve(storeStatePath);
  const now = options.now ?? (() => new Date());
  const privateStore: PrivateAgentStore = createPrivateAgentStore({
    statePath: storeStatePath,
    hasServiceListener: options.has_service_listener,
    ...(options.is_process_alive === undefined ? {} : { isProcessAlive: options.is_process_alive }),
    ...(options.is_current_user === undefined ? {} : { isCurrentUser: options.is_current_user }),
    ...(options.operation_hooks === undefined ? {} : { operationHooks: options.operation_hooks }),
  });
  let intakeStopped = false;

  async function publishRecord(
    recordType: StoredRecordType,
    value:
      ToolApprovalV1 | ToolCallV1 | ToolResultV1 | ToolStoreOperationV1 | ToolStoreQuarantineV1,
  ): Promise<`sha256:${string}`> {
    const payload = Buffer.from(
      canonicalJson(value, {
        maxBytes: MAX_DOCUMENT_BYTES,
        maxDepth: 64,
        maxMembers: 250_000,
      }),
      "utf8",
    );
    if (payload.byteLength < 2 || payload.byteLength > MAX_DOCUMENT_BYTES) invalid();
    const chunks: `sha256:${string}`[] = [];
    for (let offset = 0; offset < payload.byteLength; offset += CHUNK_BYTES) {
      const chunk = payload.subarray(offset, Math.min(offset + CHUNK_BYTES, payload.byteLength));
      const hash = contentHash(chunk);
      await privateStore.publishObject(hash, chunk);
      chunks.push(hash);
    }
    const manifest = manifestFor(recordType, value, payload, chunks);
    const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
    const manifestHash = contentHash(manifestBytes);
    await privateStore.publishObject(manifestHash, manifestBytes);
    return manifestHash;
  }

  async function scan(): Promise<StoreScan> {
    await privateStore.ensureRoots();
    const names = await readdir(privateStore.objectsPath);
    if (
      names.length > MAX_OBJECT_ENTRIES ||
      names.some((name) => !OBJECT_NAME_PATTERN.test(name))
    ) {
      internal();
    }
    const objects = new Map<`sha256:${string}`, Uint8Array>();
    const manifests = new Map<`sha256:${string}`, StoredManifest>();
    const pending = new Map<`sha256:${string}`, QuarantineReason>();
    for (const name of names) {
      const hash = `sha256:${name}` as const;
      let snapshot;
      try {
        snapshot = await privateStore.readObject(hash);
      } catch (error) {
        if (error instanceof RuntimeAgentError && error.code === "RUNTIME_AGENT_REGISTRY_CORRUPT") {
          pending.set(hash, "orphan-chunk");
          continue;
        }
        throw error;
      }
      if (snapshot === null) internal();
      objects.set(hash, snapshot.bytes);
      let manifest: StoredManifest | null;
      try {
        manifest = parseManifest(snapshot.bytes);
      } catch (error) {
        if (error instanceof RuntimeToolError) {
          pending.set(hash, "record-conflict");
          continue;
        }
        throw error;
      }
      if (manifest !== null) manifests.set(hash, manifest);
    }

    const chunkReferences = new Set<`sha256:${string}`>();
    const loaded: LoadedRecord<
      ToolApprovalV1 | ToolCallV1 | ToolResultV1 | ToolStoreOperationV1 | ToolStoreQuarantineV1
    >[] = [];
    for (const [objectHash, manifest] of manifests) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      let exact = true;
      for (const chunkHash of manifest.chunks) {
        if (chunkHash === objectHash) {
          exact = false;
          break;
        }
        const bytes = objects.get(chunkHash);
        if (bytes === undefined) {
          exact = false;
          break;
        }
        chunkReferences.add(chunkHash);
        total += bytes.byteLength;
        if (total > MAX_DOCUMENT_BYTES) {
          exact = false;
          break;
        }
        chunks.push(bytes);
      }
      if (!exact) {
        pending.set(objectHash, "record-conflict");
        continue;
      }
      const payload = Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        total,
      );
      if (total !== manifest.payload_bytes || contentHash(payload) !== manifest.payload_hash) {
        pending.set(objectHash, "record-conflict");
        continue;
      }
      try {
        const value = parseStoredValue(manifest, payload);
        loaded.push(safeRecord({ object_hash: objectHash, manifest, value }));
      } catch (error) {
        if (error instanceof RuntimeToolError) {
          pending.set(objectHash, "record-conflict");
          continue;
        }
        throw error;
      }
    }

    for (const objectHash of objects.keys()) {
      if (!manifests.has(objectHash) && !chunkReferences.has(objectHash)) {
        pending.set(objectHash, "orphan-chunk");
      }
    }
    const quarantineRecords = loaded.filter(
      (record): record is LoadedRecord<ToolStoreQuarantineV1> =>
        record.manifest.record_type === "quarantine",
    );
    const quarantineTargets = new Set(
      quarantineRecords.map((record) => record.value.target_object_hash),
    );
    const active = loaded.filter(
      (record) =>
        record.manifest.record_type !== "quarantine" && !quarantineTargets.has(record.object_hash),
    );

    const calls = new Map<string, LoadedRecord<ToolCallV1>[]>();
    for (const record of active) {
      if (record.manifest.record_type !== "call") continue;
      const callRecord = record as LoadedRecord<ToolCallV1>;
      const key = recordKey(callRecord.value.run_id, callRecord.value.call_id);
      const history = calls.get(key) ?? [];
      history.push(callRecord);
      calls.set(key, history);
    }
    const idempotency = new Map<string, string>();
    for (const [key, history] of calls) {
      history.sort((left, right) => left.value.call_revision - right.value.call_revision);
      let valid =
        history[0]?.value.call_revision === 1 &&
        history[0].value.stage === "PREPARED" &&
        history[0].value.previous_call_hash === null;
      for (let index = 1; valid && index < history.length; index += 1) {
        valid = validCallSuccessor(history[index - 1]!.value, history[index]!.value);
      }
      const identityKey = history[0]?.value.idempotency_key;
      const existingIdentity = identityKey === undefined ? undefined : idempotency.get(identityKey);
      if (!valid || (existingIdentity !== undefined && existingIdentity !== key)) {
        for (const record of history) pending.set(record.object_hash, "invalid-chain");
        calls.delete(key);
      } else if (identityKey !== undefined) {
        idempotency.set(identityKey, key);
      }
    }

    const latestCall = (runId: string, callId: string): ToolCallV1 | undefined =>
      calls.get(recordKey(runId, callId))?.at(-1)?.value;

    const approvals = new Map<`sha256:${string}`, LoadedRecord<ToolApprovalV1>>();
    const approvalOperations = new Map<string, LoadedRecord<ToolApprovalV1>>();
    const approvalRecords = active.filter(
      (record): record is LoadedRecord<ToolApprovalV1> =>
        record.manifest.record_type === "approval",
    );
    for (const record of approvalRecords.filter(
      (candidate) => candidate.value.kind === "REQUEST",
    )) {
      const call = latestCall(record.value.run_id, record.value.call_id);
      if (call === undefined || !exactApprovalCall(record.value, call)) {
        pending.set(record.object_hash, "orphan-approval");
      } else {
        approvals.set(record.value.document_hash, record);
      }
    }
    for (const record of approvalRecords.filter(
      (candidate) => candidate.value.kind === "DECISION",
    )) {
      const decision = record.value;
      if (decision.kind !== "DECISION") continue;
      const request = approvals.get(decision.approval_request_hash)?.value;
      const prior = approvalOperations.get(decision.operation_id);
      if (
        request === undefined ||
        request.kind !== "REQUEST" ||
        decision.run_id !== request.run_id ||
        decision.call_id !== request.call_id ||
        (prior !== undefined && prior.value.document_hash !== decision.document_hash)
      ) {
        pending.set(record.object_hash, "orphan-approval");
      } else {
        approvals.set(decision.document_hash, record);
        approvalOperations.set(decision.operation_id, record);
      }
    }

    const results = new Map<string, LoadedRecord<ToolResultV1>>();
    for (const record of active) {
      if (record.manifest.record_type !== "result") continue;
      const resultRecord = record as LoadedRecord<ToolResultV1>;
      const key = recordKey(resultRecord.value.run_id, resultRecord.value.call_id);
      const call = latestCall(resultRecord.value.run_id, resultRecord.value.call_id);
      const prior = results.get(key);
      if (
        call === undefined ||
        !exactResultCall(resultRecord.value, call) ||
        (prior !== undefined && prior.value.document_hash !== resultRecord.value.document_hash)
      ) {
        pending.set(
          resultRecord.object_hash,
          call === undefined ? "orphan-result" : "record-conflict",
        );
        if (prior !== undefined) {
          pending.set(prior.object_hash, "record-conflict");
          results.delete(key);
        }
      } else {
        results.set(key, resultRecord);
      }
    }
    for (const [key, history] of calls) {
      const terminal = history.at(-1);
      if (
        terminal !== undefined &&
        (terminal.value.stage === "COMPLETED" || terminal.value.stage === "FAILED") &&
        results.get(key)?.value.document_hash !== terminal.value.result_hash
      ) {
        pending.set(terminal.object_hash, "invalid-chain");
        history.pop();
        if (history.length === 0) calls.delete(key);
      }
    }

    const operations = new Map<string, LoadedRecord<ToolStoreOperationV1>>();
    for (const record of active) {
      if (record.manifest.record_type !== "operation") continue;
      const operationRecord = record as LoadedRecord<ToolStoreOperationV1>;
      const call = latestCall(operationRecord.value.run_id, operationRecord.value.call_id);
      const prior = operations.get(operationRecord.value.operation_id);
      if (
        call === undefined ||
        (prior !== undefined && prior.value.record_hash !== operationRecord.value.record_hash)
      ) {
        pending.set(
          operationRecord.object_hash,
          call === undefined ? "orphan-operation" : "record-conflict",
        );
        if (prior !== undefined) {
          pending.set(prior.object_hash, "record-conflict");
          operations.delete(operationRecord.value.operation_id);
        }
      } else {
        operations.set(operationRecord.value.operation_id, operationRecord);
      }
    }

    for (const target of quarantineTargets) pending.delete(target);
    return Object.freeze({
      calls,
      approvals,
      results,
      operations,
      quarantine_targets: quarantineTargets,
      pending_quarantine: Object.freeze(
        [...pending].map(([target_object_hash, reason]) =>
          Object.freeze({ target_object_hash, reason }),
        ),
      ),
    });
  }

  async function publishQuarantine(candidate: QuarantineCandidate): Promise<void> {
    const hashable = {
      schema_version: "tool-store-quarantine.v1" as const,
      target_object_hash: candidate.target_object_hash,
      reason: candidate.reason,
      recorded_at: safeNow(now),
    };
    const record: ToolStoreQuarantineV1 = Object.freeze({
      ...hashable,
      record_hash: sha256(hashable),
    });
    await publishRecord("quarantine", record);
  }

  async function withMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (intakeStopped) unavailable();
    return await translateFailure(async () =>
      serializeMutation(mutationKey, async () => {
        const claim = await privateStore.acquireMutationClaim();
        try {
          return await operation();
        } finally {
          await claim.release();
        }
      }),
    );
  }

  async function readScan(): Promise<StoreScan> {
    return await translateFailure(async () => {
      await ACTIVE_MUTATIONS.get(mutationKey);
      return await scan();
    });
  }

  async function recover(): Promise<ToolPrivateStoreRecovery> {
    return await withMutation(async () => {
      const first = await scan();
      for (const candidate of first.pending_quarantine) await publishQuarantine(candidate);
      const recovered = first.pending_quarantine.length === 0 ? first : await scan();
      return Object.freeze({
        calls: [...recovered.calls.values()].reduce((total, history) => total + history.length, 0),
        approvals: recovered.approvals.size,
        results: recovered.results.size,
        operations: recovered.operations.size,
        quarantined: recovered.quarantine_targets.size,
      });
    });
  }

  async function appendCall(input: ToolCallV1): Promise<ToolCallV1> {
    const parsed = parseToolCall(canonicalJson(input));
    if (!parsed.ok || containsUnredactedSecret(asJson(parsed.value))) invalid();
    if (hasSecretShapedKey(parsed.value.logical_arguments)) invalid();
    const call = parsed.value;
    return await withMutation(async () => {
      const state = await scan();
      const key = recordKey(call.run_id, call.call_id);
      const history = state.calls.get(key) ?? [];
      const duplicate = history.find((record) => record.value.document_hash === call.document_hash);
      if (duplicate !== undefined) return duplicate.value;
      const sameRevision = history.find(
        (record) => record.value.call_revision === call.call_revision,
      );
      if (sameRevision !== undefined) conflict();
      const idempotencyOwner = [...state.calls.entries()].find(
        ([candidateKey, records]) =>
          candidateKey !== key && records[0]?.value.idempotency_key === call.idempotency_key,
      );
      if (idempotencyOwner !== undefined) conflict();
      const previous = history.at(-1)?.value;
      if (
        (previous === undefined &&
          (call.call_revision !== 1 ||
            call.previous_call_hash !== null ||
            call.stage !== "PREPARED")) ||
        (previous !== undefined && !validCallSuccessor(previous, call))
      ) {
        conflict();
      }
      if (call.stage === "COMPLETED" || call.stage === "FAILED") {
        const result = state.results.get(key)?.value;
        if (result === undefined || result.document_hash !== call.result_hash) conflict();
      }
      await publishRecord("call", call);
      return call;
    });
  }

  async function publishApproval(input: ToolApprovalV1): Promise<ToolApprovalV1> {
    const parsed = parseToolApproval(canonicalJson(input));
    if (!parsed.ok || containsUnredactedSecret(asJson(parsed.value))) invalid();
    const approval = parsed.value;
    return await withMutation(async () => {
      const state = await scan();
      const duplicate = state.approvals.get(approval.document_hash);
      if (duplicate !== undefined) return duplicate.value;
      const call = state.calls.get(recordKey(approval.run_id, approval.call_id))?.at(-1)?.value;
      if (call === undefined || !exactApprovalCall(approval, call)) conflict();
      if (approval.kind === "DECISION") {
        const request = state.approvals.get(approval.approval_request_hash)?.value;
        if (request === undefined || request.kind !== "REQUEST") conflict();
        const operation = [...state.approvals.values()].find(
          (record) =>
            record.value.kind === "DECISION" && record.value.operation_id === approval.operation_id,
        );
        if (operation !== undefined) conflict();
      }
      await publishRecord("approval", approval);
      return approval;
    });
  }

  async function publishResult(input: ToolResultV1): Promise<ToolResultV1> {
    const parsed = parseToolResult(canonicalJson(input));
    if (!parsed.ok || containsUnredactedSecret(asJson(parsed.value))) invalid();
    const result = parsed.value;
    return await withMutation(async () => {
      const state = await scan();
      const key = recordKey(result.run_id, result.call_id);
      const duplicate = state.results.get(key);
      if (duplicate !== undefined) {
        if (duplicate.value.document_hash !== result.document_hash) conflict();
        return duplicate.value;
      }
      const call = state.calls.get(key)?.at(-1)?.value;
      if (call === undefined || !exactResultCall(result, call)) {
        const target = await publishRecord("result", result);
        await publishQuarantine({ target_object_hash: target, reason: "orphan-result" });
        conflict();
      }
      await publishRecord("result", result);
      return result;
    });
  }

  async function recordOperation(input: ToolStoreOperationV1): Promise<ToolStoreOperationV1> {
    const operation = parseOperation(asJson(input));
    if (containsUnredactedSecret(asJson(operation))) invalid();
    return await withMutation(async () => {
      const state = await scan();
      const duplicate = state.operations.get(operation.operation_id);
      if (duplicate !== undefined) {
        if (duplicate.value.record_hash !== operation.record_hash) conflict();
        return duplicate.value;
      }
      if (!state.calls.has(recordKey(operation.run_id, operation.call_id))) conflict();
      await publishRecord("operation", operation);
      return operation;
    });
  }

  return Object.freeze({
    ensureRoots: async (): Promise<void> => {
      await translateFailure(async () => privateStore.ensureRoots());
    },
    recover,
    appendCall,
    async latestCall(runId: string, callId: string): Promise<ToolCallV1 | null> {
      const state = await readScan();
      return state.calls.get(recordKey(runId, callId))?.at(-1)?.value ?? null;
    },
    async callHistory(runId: string, callId: string): Promise<readonly ToolCallV1[]> {
      const state = await readScan();
      return Object.freeze(
        (state.calls.get(recordKey(runId, callId)) ?? []).map((record) => record.value),
      );
    },
    publishApproval,
    async approval(documentHash: `sha256:${string}`): Promise<ToolApprovalV1 | null> {
      if (!HASH_PATTERN.test(documentHash)) invalid();
      return (await readScan()).approvals.get(documentHash)?.value ?? null;
    },
    publishResult,
    async result(runId: string, callId: string): Promise<ToolResultV1 | null> {
      return (await readScan()).results.get(recordKey(runId, callId))?.value ?? null;
    },
    recordOperation,
    async operation(operationId: string): Promise<ToolStoreOperationV1 | null> {
      if (!IDENTIFIER_PATTERN.test(operationId)) invalid();
      return (await readScan()).operations.get(operationId)?.value ?? null;
    },
    stopIntake(): void {
      intakeStopped = true;
    },
    async flush(): Promise<void> {
      await translateFailure(async () => {
        for (;;) {
          const active = ACTIVE_MUTATIONS.get(mutationKey);
          if (active === undefined) return;
          await active;
        }
      });
    },
  });
}
