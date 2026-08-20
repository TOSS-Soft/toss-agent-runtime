import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, parseJsonBytes, sha256, type JsonValue } from "../../protocol/json.js";
import {
  hashProjectRegistryEntry,
  hashProjectWatchManifest,
  parseProjectRegistryEntry,
  parseProjectWatchManifest,
} from "./contracts.js";
import { RuntimeProjectError } from "./errors.js";
import {
  canonicalProjectRoot,
  createPrivateRegistryFiles,
  type PrivateFileSnapshot,
} from "./private-files.js";
import {
  MAX_ACTIVE_PROJECT_REGISTRATIONS,
  MAX_PROJECT_ROOT_BYTES,
  type ProjectRegistration,
  type ProjectRegistryEntryV1,
  type ProjectRegistryState,
  type ProjectWatchManifestV1,
} from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;
const MAX_MANIFEST_BYTES = 65_536;
const MAX_OPERATION_RECORD_BYTES = 65_536;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface CreateProjectRegistryOptions {
  readonly statePath: string;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly operationHooks?: {
    readonly beforeManifestRead?: (canonicalRoot: string) => void;
    readonly beforeDirectorySync?: (directoryPath: string) => void;
  };
}

export interface ProjectRegistry {
  recover(): Promise<void>;
  register(root: string, operationId?: string): Promise<ProjectRegistration>;
  unregister(projectId: string, operationId?: string): Promise<ProjectRegistration>;
  blockUnavailable(projectId: string, operationId?: string): Promise<ProjectRegistration>;
  list(): Promise<readonly ProjectRegistration[]>;
  get(projectId: string): Promise<ProjectRegistration | null>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}

interface RegistryHistory {
  readonly file: PrivateFileSnapshot | null;
  readonly operationFile: PrivateFileSnapshot | null;
  readonly entries: readonly ProjectRegistryEntryV1[];
  readonly operationRecords: readonly ProjectOperationRecordV1[];
  readonly active: ReadonlyMap<string, ProjectRegistration>;
  readonly rootIds: ReadonlyMap<string, string>;
  readonly operations: ReadonlyMap<
    string,
    Readonly<{ operationHash: `sha256:${string}`; result: ProjectRegistration }>
  >;
}

interface HashableProjectOperationRecordV1 {
  readonly schema_version: "project-registry-operation.v1";
  readonly document_type: "project-registry-operation";
  readonly operation_revision: number;
  readonly previous_operation_hash: `sha256:${string}`;
  readonly operation_id: string;
  readonly operation_hash: `sha256:${string}`;
  readonly result: ProjectRegistration;
}

interface ProjectOperationRecordV1 extends HashableProjectOperationRecordV1 {
  readonly operation_record_hash: `sha256:${string}`;
}

interface ProjectBinding {
  readonly canonicalRoot: string;
  readonly manifest: ProjectWatchManifestV1;
  readonly manifestHash: `sha256:${string}`;
}

interface Coordinator {
  tail: Promise<unknown>;
}

const coordinators = new Map<string, WeakRef<Coordinator>>();

function projectError(code: ConstructorParameters<typeof RuntimeProjectError>[0]): never {
  throw new RuntimeProjectError(code);
}

function canonicalUuid(
  value: string,
  failureCode: "RUNTIME_PROJECT_INVALID" | "RUNTIME_PROJECT_NOT_FOUND",
): string {
  if (!UUID_PATTERN.test(value)) projectError(failureCode);
  return value.toLowerCase();
}

function currentUid(): bigint | undefined {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
}

function registration(entry: ProjectRegistryEntryV1): ProjectRegistration {
  return Object.freeze({
    project_id: entry.project_id,
    registry_revision: entry.registry_revision,
    canonical_root: entry.canonical_root,
    manifest_hash: entry.manifest_hash,
    state: entry.state,
  });
}

function assertManifestFile(candidate: string): ProjectBinding {
  const canonicalRoot = path.dirname(path.dirname(candidate));
  let descriptor: number | undefined;
  try {
    const tossDirectory = path.dirname(candidate);
    const tossMetadata = lstatSync(tossDirectory, { bigint: true });
    const uid = currentUid();
    if (
      tossMetadata.isSymbolicLink() ||
      !tossMetadata.isDirectory() ||
      (uid !== undefined && tossMetadata.uid !== uid)
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    const before = lstatSync(candidate, { bigint: true });
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      (uid !== undefined && before.uid !== uid) ||
      Number(before.mode & 0o400n) === 0 ||
      Number(before.mode & 0o022n) !== 0
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const held = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== held.dev ||
      before.ino !== held.ino ||
      held.size > BigInt(MAX_MANIFEST_BYTES)
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    const bytes = readFileSync(descriptor);
    const after = lstatSync(candidate, { bigint: true });
    const heldAfter = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.dev !== heldAfter.dev ||
      before.ino !== heldAfter.ino ||
      before.size !== BigInt(bytes.byteLength) ||
      after.size !== BigInt(bytes.byteLength)
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    const parsed = parseProjectWatchManifest(bytes);
    if (!parsed.ok) projectError("RUNTIME_PROJECT_INVALID");
    return {
      canonicalRoot,
      manifest: parsed.value,
      manifestHash: hashProjectWatchManifest(parsed.value),
    };
  } catch (error) {
    if (error instanceof RuntimeProjectError) throw error;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      projectError("RUNTIME_PROJECT_INVALID");
    }
    return projectError("RUNTIME_PROJECT_PATH_UNSAFE");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function bindProject(
  root: string,
  beforeManifestRead?: (canonicalRoot: string) => void,
): ProjectBinding {
  const canonicalRoot = canonicalProjectRoot(root);
  let rootDescriptor: number | undefined;
  try {
    rootDescriptor = openSync(
      canonicalRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const openedRoot = fstatSync(rootDescriptor, { bigint: true });
    beforeManifestRead?.(canonicalRoot);
    const manifestPath = path.join(canonicalRoot, ".toss", "project.yaml");
    const binding = assertManifestFile(manifestPath);
    const currentRoot = canonicalProjectRoot(root);
    const currentMetadata = lstatSync(canonicalRoot, { bigint: true });
    const heldRoot = fstatSync(rootDescriptor, { bigint: true });
    if (
      currentRoot !== canonicalRoot ||
      binding.canonicalRoot !== canonicalRoot ||
      currentMetadata.dev !== openedRoot.dev ||
      currentMetadata.ino !== openedRoot.ino ||
      heldRoot.dev !== openedRoot.dev ||
      heldRoot.ino !== openedRoot.ino
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    return binding;
  } catch (error) {
    if (error instanceof RuntimeProjectError) throw error;
    return projectError("RUNTIME_PROJECT_PATH_UNSAFE");
  } finally {
    if (rootDescriptor !== undefined) closeSync(rootDescriptor);
  }
}

export function loadRegisteredProjectManifest(
  registration: ProjectRegistration,
): ProjectWatchManifestV1 {
  if (registration.state !== "ACTIVE") projectError("RUNTIME_PROJECT_UNAVAILABLE");
  const binding = bindProject(registration.canonical_root);
  if (
    binding.canonicalRoot !== registration.canonical_root ||
    binding.manifestHash !== registration.manifest_hash
  ) {
    projectError("RUNTIME_PROJECT_UNAVAILABLE");
  }
  return binding.manifest;
}

function jsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: { readonly [key: string]: JsonValue },
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function parseOperationRecord(bytes: Uint8Array): ProjectOperationRecordV1 {
  let value: JsonValue;
  try {
    value = parseJsonBytes(bytes, {
      maxBytes: MAX_OPERATION_RECORD_BYTES,
      maxDepth: 8,
      maxMembers: 32,
    });
  } catch {
    return projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
  }
  if (
    !jsonObject(value) ||
    !exactKeys(value, [
      "schema_version",
      "document_type",
      "operation_revision",
      "previous_operation_hash",
      "operation_id",
      "operation_hash",
      "result",
      "operation_record_hash",
    ]) ||
    value.schema_version !== "project-registry-operation.v1" ||
    value.document_type !== "project-registry-operation" ||
    !Number.isSafeInteger(value.operation_revision) ||
    typeof value.operation_revision !== "number" ||
    value.operation_revision < 1 ||
    typeof value.previous_operation_hash !== "string" ||
    !SHA256_PATTERN.test(value.previous_operation_hash) ||
    typeof value.operation_id !== "string" ||
    !UUID_PATTERN.test(value.operation_id) ||
    value.operation_id !== value.operation_id.toLowerCase() ||
    typeof value.operation_hash !== "string" ||
    !SHA256_PATTERN.test(value.operation_hash) ||
    typeof value.operation_record_hash !== "string" ||
    !SHA256_PATTERN.test(value.operation_record_hash) ||
    !jsonObject(value.result) ||
    !exactKeys(value.result, [
      "project_id",
      "registry_revision",
      "canonical_root",
      "manifest_hash",
      "state",
    ]) ||
    typeof value.result.project_id !== "string" ||
    !UUID_PATTERN.test(value.result.project_id) ||
    value.result.project_id !== value.result.project_id.toLowerCase() ||
    typeof value.result.registry_revision !== "number" ||
    !Number.isSafeInteger(value.result.registry_revision) ||
    value.result.registry_revision < 1 ||
    typeof value.result.canonical_root !== "string" ||
    !path.isAbsolute(value.result.canonical_root) ||
    path.normalize(value.result.canonical_root) !== value.result.canonical_root ||
    typeof value.result.manifest_hash !== "string" ||
    !SHA256_PATTERN.test(value.result.manifest_hash) ||
    value.result.state !== "ACTIVE"
  ) {
    return projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
  }
  if (!Buffer.from(canonicalJson(value), "utf8").equals(Buffer.from(bytes))) {
    return projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
  }
  const candidate = value as unknown as ProjectOperationRecordV1;
  const { operation_record_hash: recordHash, ...hashable } = candidate;
  if (
    sha256(hashable) !== recordHash ||
    operationHash({ command: "project-register", root: candidate.result.canonical_root }) !==
      candidate.operation_hash
  ) {
    return projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
  }
  return Object.freeze({ ...candidate, result: Object.freeze({ ...candidate.result }) });
}

function parseOperationHistoryBytes(bytes: Uint8Array): {
  readonly records: readonly ProjectOperationRecordV1[];
  readonly prefixLength: number;
  readonly fragment: Uint8Array;
} {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength === 0) projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
  const finalNewline = buffer.lastIndexOf(0x0a);
  const prefixLength = finalNewline < 0 ? 0 : finalNewline + 1;
  const records: ProjectOperationRecordV1[] = [];
  let start = 0;
  for (let end = 0; end < prefixLength; end += 1) {
    if (buffer[end] !== 0x0a) continue;
    records.push(parseOperationRecord(buffer.subarray(start, end)));
    start = end + 1;
  }
  return {
    records: Object.freeze(records),
    prefixLength,
    fragment: Buffer.from(buffer.subarray(prefixLength)),
  };
}

function parseHistoryBytes(bytes: Uint8Array): {
  readonly entries: readonly ProjectRegistryEntryV1[];
  readonly prefixLength: number;
  readonly fragment: Uint8Array;
} {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength === 0) projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
  const finalNewline = buffer.lastIndexOf(0x0a);
  const prefixLength = finalNewline < 0 ? 0 : finalNewline + 1;
  const entries: ProjectRegistryEntryV1[] = [];
  let start = 0;
  for (let end = 0; end < prefixLength; end += 1) {
    if (buffer[end] !== 0x0a) continue;
    const line = buffer.subarray(start, end);
    const parsed = parseProjectRegistryEntry(line);
    if (!parsed.ok || !Buffer.from(canonicalJson(parsed.value), "utf8").equals(line)) {
      projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    entries.push(parsed.value);
    start = end + 1;
  }
  return {
    entries: Object.freeze(entries),
    prefixLength,
    fragment: Buffer.from(buffer.subarray(prefixLength)),
  };
}

function validateHistory(entries: readonly ProjectRegistryEntryV1[]): {
  readonly active: ReadonlyMap<string, ProjectRegistration>;
  readonly rootIds: ReadonlyMap<string, string>;
  readonly operations: ReadonlyMap<
    string,
    Readonly<{ operationHash: `sha256:${string}`; result: ProjectRegistration }>
  >;
} {
  const active = new Map<string, ProjectRegistration>();
  const rootIds = new Map<string, string>();
  const idRoots = new Map<string, string>();
  const operations = new Map<
    string,
    Readonly<{ operationHash: `sha256:${string}`; result: ProjectRegistration }>
  >();
  let previousHash: `sha256:${string}` = ZERO_HASH;
  for (const [index, entry] of entries.entries()) {
    if (
      entry.registry_revision !== index + 1 ||
      entry.previous_entry_hash !== previousHash ||
      entry.operation_id !== entry.operation_id.toLowerCase() ||
      entry.project_id !== entry.project_id.toLowerCase()
    ) {
      projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    if (operations.has(entry.operation_id)) projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    const expectedOperationHash =
      entry.state === "ACTIVE"
        ? operationHash({ command: "project-register", root: entry.canonical_root })
        : entry.state === "UNREGISTERED"
          ? operationHash({ command: "project-unregister", project_id: entry.project_id })
          : operationHash({
              command: "project-block-unavailable",
              project_id: entry.project_id,
            });
    if (entry.operation_hash !== expectedOperationHash) {
      projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    const knownId = rootIds.get(entry.canonical_root);
    if (knownId !== undefined && knownId !== entry.project_id) {
      projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    const knownRoot = idRoots.get(entry.project_id);
    if (knownRoot !== undefined && knownRoot !== entry.canonical_root) {
      projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    const prior = active.get(entry.project_id);
    const expectedReason =
      entry.state === "ACTIVE"
        ? prior === undefined
          ? "PROJECT_REGISTERED"
          : "PROJECT_MANIFEST_UPDATED"
        : entry.state === "UNREGISTERED"
          ? "PROJECT_UNREGISTERED"
          : "PROJECT_ROOT_UNAVAILABLE";
    if (entry.reason_code !== expectedReason || (entry.state !== "ACTIVE" && prior === undefined)) {
      projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    rootIds.set(entry.canonical_root, entry.project_id);
    idRoots.set(entry.project_id, entry.canonical_root);
    if (entry.state === "ACTIVE") active.set(entry.project_id, registration(entry));
    else active.delete(entry.project_id);
    operations.set(
      entry.operation_id,
      Object.freeze({ operationHash: entry.operation_hash, result: registration(entry) }),
    );
    previousHash = entry.entry_hash;
  }
  return { active, rootIds, operations };
}

function operationHash(value: Readonly<Record<string, string>>): `sha256:${string}` {
  return sha256(value);
}

function validateOperationRecords(
  records: readonly ProjectOperationRecordV1[],
  entries: readonly ProjectRegistryEntryV1[],
  base: ReadonlyMap<
    string,
    Readonly<{ operationHash: `sha256:${string}`; result: ProjectRegistration }>
  >,
): ReadonlyMap<
  string,
  Readonly<{ operationHash: `sha256:${string}`; result: ProjectRegistration }>
> {
  const operations = new Map(base);
  const durableResults = new Set(entries.map((entry) => canonicalJson(registration(entry))));
  let previousHash: `sha256:${string}` = ZERO_HASH;
  for (const [index, record] of records.entries()) {
    if (
      record.operation_revision !== index + 1 ||
      record.previous_operation_hash !== previousHash ||
      operations.has(record.operation_id) ||
      !durableResults.has(canonicalJson(record.result))
    ) {
      projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    operations.set(
      record.operation_id,
      Object.freeze({ operationHash: record.operation_hash, result: record.result }),
    );
    previousHash = record.operation_record_hash;
  }
  return operations;
}

function operationRecordFor(options: {
  readonly operationId: string;
  readonly operationHash: `sha256:${string}`;
  readonly result: ProjectRegistration;
  readonly history: readonly ProjectOperationRecordV1[];
}): ProjectOperationRecordV1 {
  const previous = options.history.at(-1);
  const hashable = {
    schema_version: "project-registry-operation.v1",
    document_type: "project-registry-operation",
    operation_revision: options.history.length + 1,
    previous_operation_hash: previous?.operation_record_hash ?? ZERO_HASH,
    operation_id: options.operationId,
    operation_hash: options.operationHash,
    result: options.result,
  } as const;
  return Object.freeze({ ...hashable, operation_record_hash: sha256(hashable) });
}

function replayOperation(
  history: RegistryHistory,
  operationId: string | undefined,
  expectedHash: `sha256:${string}`,
): ProjectRegistration | undefined {
  if (operationId === undefined) return undefined;
  const known = history.operations.get(operationId);
  if (known === undefined) return undefined;
  if (known.operationHash !== expectedHash) projectError("RUNTIME_OPERATION_CONFLICT");
  return known.result;
}

function entryFor(options: {
  readonly operationId: string;
  readonly operationHash: `sha256:${string}`;
  readonly projectId: string;
  readonly canonicalRoot: string;
  readonly manifestHash: `sha256:${string}`;
  readonly state: ProjectRegistryState;
  readonly reasonCode: string;
  readonly history: readonly ProjectRegistryEntryV1[];
  readonly now: () => Date;
}): ProjectRegistryEntryV1 {
  const previous = options.history.at(-1);
  const hashable = {
    protocol_version: "runtime-contract.v1",
    schema_version: "project-registry-entry.v1",
    document_type: "project-registry-entry",
    registry_revision: options.history.length + 1,
    previous_entry_hash: previous?.entry_hash ?? ZERO_HASH,
    operation_id: options.operationId,
    operation_hash: options.operationHash,
    project_id: options.projectId,
    canonical_root: options.canonicalRoot,
    manifest_hash: options.manifestHash,
    state: options.state,
    reason_code: options.reasonCode,
    timestamp: options.now().toISOString(),
  } as const;
  return Object.freeze({ ...hashable, entry_hash: hashProjectRegistryEntry(hashable) });
}

export function createProjectRegistry(options: CreateProjectRegistryOptions): ProjectRegistry {
  const directorySyncOptions =
    options.operationHooks?.beforeDirectorySync === undefined
      ? {}
      : { beforeDirectorySync: options.operationHooks.beforeDirectorySync };
  const files = createPrivateRegistryFiles(options.statePath, {
    ...directorySyncOptions,
  });
  const operationFiles = createPrivateRegistryFiles(options.statePath, {
    fileName: "operations.jsonl",
    artifactPrefix: "project-registry-operations",
    ...directorySyncOptions,
  });
  const requestedRoot = path.resolve(options.statePath);
  let coordinatorPromise: Promise<Coordinator> | undefined;
  const pending = new Set<Promise<unknown>>();
  let intakeStopped = false;

  const coordinator = (): Promise<Coordinator> => {
    coordinatorPromise ??= (async () => {
      files.ensureRoots();
      const canonicalState = await realpath(requestedRoot);
      let shared = coordinators.get(canonicalState)?.deref();
      if (shared === undefined) {
        shared = { tail: Promise.resolve() };
        coordinators.set(canonicalState, new WeakRef(shared));
      }
      return shared;
    })();
    return coordinatorPromise;
  };

  const enqueue = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const scheduled = coordinator().then(async (shared) => {
      const current = shared.tail.catch(() => undefined).then(operation);
      shared.tail = current;
      return current;
    });
    pending.add(scheduled);
    void scheduled.finally(() => pending.delete(scheduled)).catch(() => undefined);
    return scheduled;
  };

  const load = (): RegistryHistory => {
    let file = files.read();
    if (file === null) {
      if (operationFiles.read() !== null) projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
      return {
        file: null,
        operationFile: null,
        entries: [],
        operationRecords: [],
        active: new Map(),
        rootIds: new Map(),
        operations: new Map(),
      };
    }
    let parsed = parseHistoryBytes(file.bytes);
    if (parsed.fragment.byteLength > 0) {
      if (parsed.entries.length === 0) projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
      const randomId = canonicalUuid(options.randomId(), "RUNTIME_PROJECT_INVALID");
      files.recoverPartial(
        file,
        file.bytes.subarray(0, parsed.prefixLength),
        parsed.fragment,
        randomId,
      );
      file = files.read();
      if (file === null) projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
      parsed = parseHistoryBytes(file.bytes);
      if (parsed.fragment.byteLength > 0) projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    const state = validateHistory(parsed.entries);
    let operationFile = operationFiles.read();
    let operationRecords: readonly ProjectOperationRecordV1[] = [];
    if (operationFile !== null) {
      let operationHistory = parseOperationHistoryBytes(operationFile.bytes);
      if (operationHistory.fragment.byteLength > 0) {
        if (operationHistory.records.length === 0) {
          projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
        }
        const randomId = canonicalUuid(options.randomId(), "RUNTIME_PROJECT_INVALID");
        operationFiles.recoverPartial(
          operationFile,
          operationFile.bytes.subarray(0, operationHistory.prefixLength),
          operationHistory.fragment,
          randomId,
        );
        operationFile = operationFiles.read();
        if (operationFile === null) projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
        operationHistory = parseOperationHistoryBytes(operationFile.bytes);
        if (operationHistory.fragment.byteLength > 0) {
          projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
        }
      }
      operationRecords = operationHistory.records;
    }
    const operations = validateOperationRecords(operationRecords, parsed.entries, state.operations);
    return {
      file,
      operationFile,
      entries: parsed.entries,
      operationRecords,
      active: state.active,
      rootIds: state.rootIds,
      operations,
    };
  };

  const append = (history: RegistryHistory, entry: ProjectRegistryEntryV1): void => {
    files.append(history.file, Buffer.from(`${canonicalJson(entry)}\n`, "utf8"));
  };

  const appendOperation = (history: RegistryHistory, record: ProjectOperationRecordV1): void => {
    operationFiles.append(history.operationFile, Buffer.from(`${canonicalJson(record)}\n`, "utf8"));
  };

  return {
    recover: () => enqueue(() => void load()),
    register(root, operationId) {
      if (intakeStopped)
        return Promise.reject(new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE"));
      return enqueue(() => {
        const canonicalOperationId =
          operationId === undefined
            ? undefined
            : canonicalUuid(operationId, "RUNTIME_PROJECT_INVALID");
        const expectedOperationHash = operationHash({ command: "project-register", root });
        const history = load();
        const replay = replayOperation(history, canonicalOperationId, expectedOperationHash);
        if (replay !== undefined) return replay;
        const binding = bindProject(root, options.operationHooks?.beforeManifestRead);
        if (Buffer.byteLength(binding.canonicalRoot, "utf8") > MAX_PROJECT_ROOT_BYTES) {
          projectError("RUNTIME_PROJECT_INVALID");
        }
        const knownId = history.rootIds.get(binding.canonicalRoot);
        const active = knownId === undefined ? undefined : history.active.get(knownId);
        if (active !== undefined && active.manifest_hash === binding.manifestHash) {
          if (canonicalOperationId !== undefined) {
            appendOperation(
              history,
              operationRecordFor({
                operationId: canonicalOperationId,
                operationHash: expectedOperationHash,
                result: active,
                history: history.operationRecords,
              }),
            );
          }
          return active;
        }
        if (active === undefined && history.active.size >= MAX_ACTIVE_PROJECT_REGISTRATIONS) {
          projectError("RUNTIME_PROJECT_UNAVAILABLE");
        }
        const projectId = knownId ?? canonicalUuid(options.randomId(), "RUNTIME_PROJECT_INVALID");
        const durableOperationId =
          canonicalOperationId ?? canonicalUuid(options.randomId(), "RUNTIME_PROJECT_INVALID");
        const entry = entryFor({
          operationId: durableOperationId,
          operationHash: expectedOperationHash,
          projectId,
          canonicalRoot: binding.canonicalRoot,
          manifestHash: binding.manifestHash,
          state: "ACTIVE",
          reasonCode: active === undefined ? "PROJECT_REGISTERED" : "PROJECT_MANIFEST_UPDATED",
          history: history.entries,
          now: options.now,
        });
        append(history, entry);
        return registration(entry);
      });
    },
    unregister(projectId, operationId) {
      if (intakeStopped)
        return Promise.reject(new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE"));
      return enqueue(() => {
        const canonicalProjectId = canonicalUuid(projectId, "RUNTIME_PROJECT_NOT_FOUND");
        const canonicalOperationId =
          operationId === undefined
            ? undefined
            : canonicalUuid(operationId, "RUNTIME_PROJECT_INVALID");
        const expectedOperationHash = operationHash({
          command: "project-unregister",
          project_id: canonicalProjectId,
        });
        const history = load();
        const replay = replayOperation(history, canonicalOperationId, expectedOperationHash);
        if (replay !== undefined) return replay;
        const current = history.active.get(canonicalProjectId);
        if (current === undefined) projectError("RUNTIME_PROJECT_NOT_FOUND");
        const durableOperationId =
          canonicalOperationId ?? canonicalUuid(options.randomId(), "RUNTIME_PROJECT_INVALID");
        const entry = entryFor({
          operationId: durableOperationId,
          operationHash: expectedOperationHash,
          projectId: canonicalProjectId,
          canonicalRoot: current.canonical_root,
          manifestHash: current.manifest_hash,
          state: "UNREGISTERED",
          reasonCode: "PROJECT_UNREGISTERED",
          history: history.entries,
          now: options.now,
        });
        append(history, entry);
        return registration(entry);
      });
    },
    blockUnavailable(projectId, operationId) {
      if (intakeStopped)
        return Promise.reject(new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE"));
      return enqueue(() => {
        const canonicalProjectId = canonicalUuid(projectId, "RUNTIME_PROJECT_NOT_FOUND");
        const canonicalOperationId =
          operationId === undefined
            ? undefined
            : canonicalUuid(operationId, "RUNTIME_PROJECT_INVALID");
        const expectedOperationHash = operationHash({
          command: "project-block-unavailable",
          project_id: canonicalProjectId,
        });
        const history = load();
        const replay = replayOperation(history, canonicalOperationId, expectedOperationHash);
        if (replay !== undefined) return replay;
        const current = history.active.get(canonicalProjectId);
        if (current === undefined) projectError("RUNTIME_PROJECT_NOT_FOUND");
        const durableOperationId =
          canonicalOperationId ?? canonicalUuid(options.randomId(), "RUNTIME_PROJECT_INVALID");
        const entry = entryFor({
          operationId: durableOperationId,
          operationHash: expectedOperationHash,
          projectId: canonicalProjectId,
          canonicalRoot: current.canonical_root,
          manifestHash: current.manifest_hash,
          state: "BLOCKED_PROJECT_UNAVAILABLE",
          reasonCode: "PROJECT_ROOT_UNAVAILABLE",
          history: history.entries,
          now: options.now,
        });
        append(history, entry);
        return registration(entry);
      });
    },
    list: () =>
      enqueue(() =>
        Object.freeze(
          [...load().active.values()].sort((left, right) =>
            Buffer.from(left.project_id).compare(Buffer.from(right.project_id)),
          ),
        ),
      ),
    get: (projectId) =>
      enqueue(
        () => load().active.get(canonicalUuid(projectId, "RUNTIME_PROJECT_NOT_FOUND")) ?? null,
      ),
    stopIntake() {
      intakeStopped = true;
    },
    async flush(signal) {
      if (signal.aborted || pending.size === 0) return;
      let listener: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        listener = resolve;
        signal.addEventListener("abort", listener, { once: true });
      });
      try {
        await Promise.race([Promise.allSettled([...pending]).then(() => undefined), aborted]);
      } finally {
        if (listener !== undefined) signal.removeEventListener("abort", listener);
      }
    },
  };
}
