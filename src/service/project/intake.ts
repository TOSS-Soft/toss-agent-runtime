import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";

import { canonicalJson, parseJsonBytes, type JsonValue } from "../../protocol/json.js";
import {
  candidateJobKey,
  isSafeProjectRelativePath,
  parseCandidateJobIntent,
  PROJECT_CANDIDATE_JSON_LIMITS,
} from "./contracts.js";
import { RuntimeProjectError } from "./errors.js";
import type { CandidateJobIntentV1, ProjectChange, ProjectRegistration } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,19})$/u;
const FINAL_PENDING_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/iu;
const STAGED_PENDING_PATTERN =
  /^\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.stage$/iu;
const DEBOUNCE_MS = 200;
const MAX_DEBOUNCE_MS = 2_000;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 16 * 1024 * 1024;

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface FileSnapshot {
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
}

interface ProjectPendingWindowV1 {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "project-pending-window.v1";
  readonly document_type: "project-pending-window";
  readonly project_id: string;
  readonly registry_revision: number;
  readonly canonical_root: string;
  readonly manifest_hash: `sha256:${string}`;
  readonly opened_at: string;
  readonly updated_at: string;
  readonly deadline_at: string;
  readonly changes: readonly ProjectChange[];
}

interface PendingState {
  document: ProjectPendingWindowV1;
  file: FileSnapshot;
  timer?: ReturnType<typeof setTimeout>;
}

interface Coordinator {
  tail: Promise<unknown>;
  readonly windows: Map<string, PendingState>;
  publicationBlocked: boolean;
}

export interface ProjectIntakeOperationHooks {
  readonly beforePendingFileSync?: (stagePath: string) => void;
  readonly afterPendingFileSync?: (stagePath: string) => void;
  readonly beforeCandidateFileSync?: (candidatePath: string) => void;
  readonly beforePrivateFileReplaySync?: (privatePath: string) => void;
  readonly beforeDirectorySync?: (directoryPath: string) => void;
  readonly afterCandidateAppend?: (candidate: CandidateJobIntentV1) => void;
  readonly beforePendingUnlink?: (pendingPath: string) => void;
}

export interface CreateProjectIntakeOptions {
  readonly statePath: string;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly operationHooks?: ProjectIntakeOperationHooks;
}

export interface ProjectIntake {
  record(registration: ProjectRegistration, change: ProjectChange): Promise<void>;
  recordBatch(registration: ProjectRegistration, changes: readonly ProjectChange[]): Promise<void>;
  recover(registrations: readonly ProjectRegistration[]): Promise<void>;
  discard(projectId: string): Promise<void>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
  listCandidates(): Promise<readonly CandidateJobIntentV1[]>;
}

const coordinators = new Map<string, WeakRef<Coordinator>>();

function projectError(code: ConstructorParameters<typeof RuntimeProjectError>[0]): never {
  throw new RuntimeProjectError(code);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function currentUid(): bigint | undefined {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
}

function identity(metadata: Pick<BigIntStats, "dev" | "ino">): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertAbsolutePath(candidate: string): void {
  if (
    !path.isAbsolute(candidate) ||
    path.normalize(candidate) !== candidate ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    projectError("RUNTIME_PROJECT_PATH_UNSAFE");
  }
}

function directoryCandidates(candidate: string): readonly string[] {
  assertAbsolutePath(candidate);
  const parsed = path.parse(candidate);
  const segments = candidate.slice(parsed.root.length).split(path.sep);
  let current = parsed.root;
  return segments.map((segment) => {
    if (segment.length === 0 || segment === "." || segment === "..") {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    current = path.join(current, segment);
    return current;
  });
}

function isAtOrBelow(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assertDirectory(metadata: BigIntStats, exactPrivate: boolean): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    projectError("RUNTIME_PROJECT_PATH_UNSAFE");
  }
  const uid = currentUid();
  const mode = Number(metadata.mode & 0o7777n);
  if (exactPrivate) {
    if ((uid !== undefined && metadata.uid !== uid) || (mode & 0o777) !== 0o700) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    return;
  }
  if (uid !== undefined && metadata.uid === uid) {
    if ((mode & 0o022) !== 0) projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    return;
  }
  if (metadata.uid !== 0n || ((mode & 0o022) !== 0 && (mode & 0o1000) === 0)) {
    projectError("RUNTIME_PROJECT_PATH_UNSAFE");
  }
}

function syncDirectory(
  candidate: string,
  privateRoot: string,
  beforeSync?: (directoryPath: string) => void,
): void {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(candidate, { bigint: true });
    assertDirectory(before, isAtOrBelow(candidate, privateRoot));
    descriptor = openSync(
      candidate,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const held = fstatSync(descriptor, { bigint: true });
    assertDirectory(held, isAtOrBelow(candidate, privateRoot));
    if (!sameIdentity(identity(before), identity(held))) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    beforeSync?.(candidate);
    fsyncSync(descriptor);
    const after = lstatSync(candidate, { bigint: true });
    const heldAfter = fstatSync(descriptor, { bigint: true });
    assertDirectory(after, isAtOrBelow(candidate, privateRoot));
    assertDirectory(heldAfter, isAtOrBelow(candidate, privateRoot));
    if (
      !sameIdentity(identity(before), identity(after)) ||
      !sameIdentity(identity(before), identity(heldAfter))
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
  } catch (error) {
    if (error instanceof RuntimeProjectError) throw error;
    projectError("RUNTIME_PROJECT_UNAVAILABLE");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensurePrivateDirectory(
  candidate: string,
  privateRoot: string,
  beforeSync?: (directoryPath: string) => void,
): void {
  for (const current of directoryCandidates(candidate)) {
    let metadata: BigIntStats;
    try {
      metadata = lstatSync(current, { bigint: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") projectError("RUNTIME_PROJECT_PATH_UNSAFE");
      try {
        mkdirSync(current, { mode: 0o700 });
        metadata = lstatSync(current, { bigint: true });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") projectError("RUNTIME_PROJECT_UNAVAILABLE");
        metadata = lstatSync(current, { bigint: true });
      }
    }
    assertDirectory(metadata, isAtOrBelow(current, privateRoot));
    syncDirectory(current, privateRoot, beforeSync);
    syncDirectory(path.dirname(current), privateRoot, beforeSync);
    const after = lstatSync(current, { bigint: true });
    assertDirectory(after, isAtOrBelow(current, privateRoot));
    if (!sameIdentity(identity(metadata), identity(after))) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
  }
}

function assertPrivateFile(metadata: BigIntStats, expected?: FileIdentity): FileIdentity {
  const uid = currentUid();
  const actual = identity(metadata);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (uid !== undefined && metadata.uid !== uid) ||
    Number(metadata.mode & 0o777n) !== 0o600 ||
    (expected !== undefined && !sameIdentity(expected, actual))
  ) {
    projectError("RUNTIME_PROJECT_PATH_UNSAFE");
  }
  return actual;
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = writeSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
    if (written === 0) projectError("RUNTIME_PROJECT_UNAVAILABLE");
    offset += written;
  }
}

function exactBytes(
  candidate: string,
  descriptor: number,
  expectedIdentity: FileIdentity,
  expectedBytes: Uint8Array,
): void {
  const pathMetadata = lstatSync(candidate, { bigint: true });
  const heldMetadata = fstatSync(descriptor, { bigint: true });
  assertPrivateFile(pathMetadata, expectedIdentity);
  assertPrivateFile(heldMetadata, expectedIdentity);
  if (
    pathMetadata.size !== BigInt(expectedBytes.byteLength) ||
    heldMetadata.size !== BigInt(expectedBytes.byteLength)
  ) {
    projectError("RUNTIME_PROJECT_PATH_UNSAFE");
  }
  const actual = Buffer.allocUnsafe(expectedBytes.byteLength);
  let offset = 0;
  while (offset < actual.byteLength) {
    const count = readSync(descriptor, actual, offset, actual.byteLength - offset, offset);
    if (count === 0) projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    offset += count;
  }
  if (!actual.equals(Buffer.from(expectedBytes))) projectError("RUNTIME_PROJECT_PATH_UNSAFE");
}

function readPrivateFile(
  candidate: string,
  maximumBytes: number,
  privateRoot: string,
  beforeFileSync?: (privatePath: string) => void,
  beforeDirectorySync?: (directoryPath: string) => void,
): FileSnapshot | null {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(candidate, { bigint: true });
    const expectedIdentity = assertPrivateFile(before);
    if (before.size > BigInt(maximumBytes)) projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
    descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const held = fstatSync(descriptor, { bigint: true });
    assertPrivateFile(held, expectedIdentity);
    if (held.size > BigInt(maximumBytes)) projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
    const bytes = Buffer.alloc(Number(held.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) projectError("RUNTIME_PROJECT_PATH_UNSAFE");
      offset += count;
    }
    beforeFileSync?.(candidate);
    fsyncSync(descriptor);
    exactBytes(candidate, descriptor, expectedIdentity, bytes);
    syncDirectory(path.dirname(candidate), privateRoot, beforeDirectorySync);
    exactBytes(candidate, descriptor, expectedIdentity, bytes);
    return { bytes, identity: expectedIdentity };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (error instanceof RuntimeProjectError) throw error;
    throw new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value, PROJECT_CANDIDATE_JSON_LIMITS), "utf8");
}

function plainObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: { readonly [key: string]: JsonValue },
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

function changeOrder(change: ProjectChange): string {
  return `${change.path}\u0000${change.kind}\u0000${canonicalJson(change.identity)}`;
}

function sortedChanges(changes: Iterable<ProjectChange>): readonly ProjectChange[] {
  return Object.freeze(
    [...changes].sort((left, right) =>
      Buffer.from(changeOrder(left)).compare(Buffer.from(changeOrder(right))),
    ),
  );
}

function reduceChange(
  current: ProjectChange | undefined,
  next: ProjectChange,
): ProjectChange | null {
  if (current === undefined) return next;
  if (current.kind === "CREATED" && next.kind === "REMOVED") return null;
  if (current.kind === "REMOVED" && next.kind !== "REMOVED") {
    return Object.freeze({ kind: "CHANGED", path: next.path, identity: next.identity });
  }
  if (current.kind === "CREATED" && next.kind === "CHANGED") {
    return Object.freeze({ kind: "CREATED", path: next.path, identity: next.identity });
  }
  return next;
}

function candidateFor(
  registration: ProjectRegistration,
  changes: readonly ProjectChange[],
  createdAt: string,
): CandidateJobIntentV1 {
  const hashable = {
    project_id: registration.project_id,
    registry_revision: registration.registry_revision,
    manifest_hash: registration.manifest_hash,
    changes,
  } as const;
  return Object.freeze({
    protocol_version: "runtime-contract.v1",
    schema_version: "candidate-job-intent.v1",
    document_type: "candidate-job-intent",
    candidate_key: candidateJobKey(hashable),
    kind: "PROJECT_CHANGED",
    ...hashable,
    created_at: createdAt,
  });
}

function validatedCandidate(
  registration: ProjectRegistration,
  changes: readonly ProjectChange[],
  createdAt: string,
): CandidateJobIntentV1 {
  const candidate = candidateFor(registration, sortedChanges(changes), createdAt);
  const parsed = parseCandidateJobIntent(canonicalJson(candidate, PROJECT_CANDIDATE_JSON_LIMITS));
  if (!parsed.ok) projectError("RUNTIME_PROJECT_INVALID");
  return parsed.value;
}

function parsePending(bytes: Uint8Array): ProjectPendingWindowV1 {
  try {
    const value = parseJsonBytes(bytes, {
      maxBytes: MAX_PENDING_BYTES,
      maxDepth: 16,
      maxMembers: PROJECT_CANDIDATE_JSON_LIMITS.maxMembers,
    });
    const keys = [
      "canonical_root",
      "changes",
      "deadline_at",
      "document_type",
      "manifest_hash",
      "opened_at",
      "project_id",
      "protocol_version",
      "registry_revision",
      "schema_version",
      "updated_at",
    ];
    if (
      !plainObject(value) ||
      !exactKeys(value, keys) ||
      value.protocol_version !== "runtime-contract.v1" ||
      value.schema_version !== "project-pending-window.v1" ||
      value.document_type !== "project-pending-window" ||
      typeof value.project_id !== "string" ||
      !UUID_PATTERN.test(value.project_id) ||
      typeof value.registry_revision !== "number" ||
      !Number.isSafeInteger(value.registry_revision) ||
      value.registry_revision < 1 ||
      typeof value.canonical_root !== "string" ||
      !path.isAbsolute(value.canonical_root) ||
      path.normalize(value.canonical_root) !== value.canonical_root ||
      typeof value.manifest_hash !== "string" ||
      !HASH_PATTERN.test(value.manifest_hash) ||
      !validTimestamp(value.opened_at) ||
      !validTimestamp(value.updated_at) ||
      !validTimestamp(value.deadline_at) ||
      !Array.isArray(value.changes) ||
      value.changes.length === 0 ||
      value.changes.length > 4096 ||
      Date.parse(value.opened_at) > Date.parse(value.updated_at) ||
      Date.parse(value.updated_at) > Date.parse(value.deadline_at) ||
      Date.parse(value.deadline_at) - Date.parse(value.opened_at) !== MAX_DEBOUNCE_MS
    ) {
      projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
    }
    const registration: ProjectRegistration = {
      project_id: value.project_id,
      registry_revision: value.registry_revision,
      canonical_root: value.canonical_root,
      manifest_hash: value.manifest_hash as `sha256:${string}`,
      state: "ACTIVE",
    };
    const candidate = validatedCandidate(
      registration,
      value.changes as readonly ProjectChange[],
      value.updated_at,
    );
    const pending: ProjectPendingWindowV1 = Object.freeze({
      protocol_version: "runtime-contract.v1",
      schema_version: "project-pending-window.v1",
      document_type: "project-pending-window",
      project_id: registration.project_id,
      registry_revision: registration.registry_revision,
      canonical_root: registration.canonical_root,
      manifest_hash: registration.manifest_hash,
      opened_at: value.opened_at,
      updated_at: value.updated_at,
      deadline_at: value.deadline_at,
      changes: candidate.changes,
    });
    if (
      !Buffer.from(bytes).equals(
        Buffer.from(canonicalJson(pending, PROJECT_CANDIDATE_JSON_LIMITS), "utf8"),
      )
    ) {
      projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
    }
    return pending;
  } catch (error) {
    if (error instanceof RuntimeProjectError) throw error;
    projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
  }
}

function matchingRegistration(
  pending: ProjectPendingWindowV1,
  registration: ProjectRegistration | undefined,
): boolean {
  return (
    registration?.state === "ACTIVE" &&
    registration.registry_revision === pending.registry_revision &&
    registration.canonical_root === pending.canonical_root &&
    registration.manifest_hash === pending.manifest_hash
  );
}

function assertChange(change: ProjectChange): void {
  if (
    !["CREATED", "CHANGED", "REMOVED"].includes(change.kind) ||
    !isSafeProjectRelativePath(change.path) ||
    change.path.length > 4096 ||
    (change.kind === "REMOVED" && change.identity !== null) ||
    (change.kind !== "REMOVED" && change.identity === null)
  ) {
    projectError("RUNTIME_PROJECT_INVALID");
  }
  if (
    change.identity !== null &&
    [
      change.identity.device,
      change.identity.inode,
      change.identity.mtime_ns,
      change.identity.size,
    ].some((value) => !DECIMAL_PATTERN.test(value))
  ) {
    projectError("RUNTIME_PROJECT_INVALID");
  }
}

export function createProjectIntake(options: CreateProjectIntakeOptions): ProjectIntake {
  assertAbsolutePath(options.statePath);
  const projectsPath = path.join(options.statePath, "projects");
  const pendingDirectory = path.join(projectsPath, "pending");
  const intakeDirectory = path.join(projectsPath, "intake");
  const quarantineDirectory = path.join(projectsPath, "quarantine");
  const candidatesPath = path.join(intakeDirectory, "candidates.jsonl");
  const requestedStatePath = path.resolve(options.statePath);
  let windows = new Map<string, PendingState>();
  const candidates = new Map<string, CandidateJobIntentV1>();
  let candidateFile: FileSnapshot | null = null;
  let candidateLoaded = false;
  let stopped = false;
  let sharedCoordinator: Coordinator | undefined;
  let coordinatorPromise: Promise<Coordinator> | undefined;
  const pendingOperations = new Set<Promise<unknown>>();
  const readPrivate = (candidate: string, maximumBytes: number): FileSnapshot | null =>
    readPrivateFile(
      candidate,
      maximumBytes,
      requestedStatePath,
      options.operationHooks?.beforePrivateFileReplaySync,
      options.operationHooks?.beforeDirectorySync,
    );

  const ensureRoots = (): void => {
    const beforeSync = options.operationHooks?.beforeDirectorySync;
    ensurePrivateDirectory(options.statePath, requestedStatePath, beforeSync);
    ensurePrivateDirectory(projectsPath, requestedStatePath, beforeSync);
    ensurePrivateDirectory(pendingDirectory, requestedStatePath, beforeSync);
    ensurePrivateDirectory(intakeDirectory, requestedStatePath, beforeSync);
    ensurePrivateDirectory(quarantineDirectory, requestedStatePath, beforeSync);
  };

  const coordinator = async (): Promise<Coordinator> => {
    if (coordinatorPromise === undefined) {
      coordinatorPromise = Promise.resolve()
        .then(() => {
          ensureRoots();
          let canonicalStatePath: string;
          try {
            canonicalStatePath = realpathSync(requestedStatePath);
          } catch {
            return projectError("RUNTIME_PROJECT_UNAVAILABLE");
          }
          let shared = coordinators.get(canonicalStatePath)?.deref();
          if (shared === undefined) {
            shared = { tail: Promise.resolve(), windows: new Map(), publicationBlocked: false };
            coordinators.set(canonicalStatePath, new WeakRef(shared));
          }
          return shared;
        })
        .catch((error: unknown) => {
          coordinatorPromise = undefined;
          throw error;
        });
    }
    return coordinatorPromise;
  };

  const enqueue = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const scheduled = coordinator().then(async (shared) => {
      const current = shared.tail
        .catch(() => undefined)
        .then(() => {
          sharedCoordinator = shared;
          windows = shared.windows;
          return operation();
        });
      shared.tail = current;
      return current;
    });
    pendingOperations.add(scheduled);
    void scheduled.finally(() => pendingOperations.delete(scheduled)).catch(() => undefined);
    return scheduled;
  };

  const recoverPartialCandidates = (
    expected: FileSnapshot,
    prefix: Uint8Array,
    fragment: Uint8Array,
  ): FileSnapshot => {
    const randomId = options.randomId();
    if (!UUID_PATTERN.test(randomId)) projectError("RUNTIME_PROJECT_INVALID");
    const quarantinePath = path.join(quarantineDirectory, `project-intake-${randomId}.bin`);
    const stagePath = path.join(intakeDirectory, `.candidates-recovery.${randomId}.stage`);
    let quarantine: number | undefined;
    let stage: number | undefined;
    let current: number | undefined;
    try {
      quarantine = openSync(
        quarantinePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      const quarantineIdentity = assertPrivateFile(fstatSync(quarantine, { bigint: true }));
      writeAll(quarantine, fragment);
      fsyncSync(quarantine);
      exactBytes(quarantinePath, quarantine, quarantineIdentity, fragment);
      syncDirectory(
        quarantineDirectory,
        requestedStatePath,
        options.operationHooks?.beforeDirectorySync,
      );
      exactBytes(quarantinePath, quarantine, quarantineIdentity, fragment);

      stage = openSync(
        stagePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      const stageIdentity = assertPrivateFile(fstatSync(stage, { bigint: true }));
      writeAll(stage, prefix);
      fsyncSync(stage);
      exactBytes(stagePath, stage, stageIdentity, prefix);
      current = openSync(candidatesPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      exactBytes(candidatesPath, current, expected.identity, expected.bytes);
      renameSync(stagePath, candidatesPath);
      exactBytes(candidatesPath, stage, stageIdentity, prefix);
      syncDirectory(
        intakeDirectory,
        requestedStatePath,
        options.operationHooks?.beforeDirectorySync,
      );
      exactBytes(candidatesPath, stage, stageIdentity, prefix);
    } catch (error) {
      if (error instanceof RuntimeProjectError) throw error;
      projectError("RUNTIME_PROJECT_UNAVAILABLE");
    } finally {
      if (current !== undefined) closeSync(current);
      if (stage !== undefined) closeSync(stage);
      if (quarantine !== undefined) closeSync(quarantine);
    }
    const recovered = readPrivate(candidatesPath, MAX_CANDIDATE_BYTES);
    if (recovered === null || !Buffer.from(recovered.bytes).equals(Buffer.from(prefix))) {
      projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
    }
    return recovered;
  };

  const loadCandidates = (): void => {
    if (candidateLoaded) return;
    candidateFile = readPrivate(candidatesPath, MAX_CANDIDATE_BYTES);
    candidates.clear();
    if (candidateFile !== null) {
      const buffer = Buffer.from(candidateFile.bytes);
      if (buffer.byteLength === 0) projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
      const lastNewline = buffer.lastIndexOf(0x0a);
      const prefixLength = lastNewline < 0 ? 0 : lastNewline + 1;
      const fragment = buffer.subarray(prefixLength);
      if (fragment.byteLength > 0 && prefixLength === 0) {
        projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
      }
      let start = 0;
      for (let end = 0; end < prefixLength; end += 1) {
        if (buffer[end] !== 0x0a) continue;
        const line = buffer.subarray(start, end);
        const parsed = parseCandidateJobIntent(line);
        if (
          !parsed.ok ||
          !Buffer.from(canonicalJson(parsed.value, PROJECT_CANDIDATE_JSON_LIMITS), "utf8").equals(
            line,
          ) ||
          candidates.has(parsed.value.candidate_key)
        ) {
          projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
        }
        candidates.set(parsed.value.candidate_key, parsed.value);
        start = end + 1;
      }
      if (fragment.byteLength > 0) {
        candidateFile = recoverPartialCandidates(
          candidateFile,
          buffer.subarray(0, prefixLength),
          fragment,
        );
      }
    }
    candidateLoaded = true;
  };

  const synchronizeCandidateFile = (): void => {
    if (candidateFile === null) projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
    let descriptor: number | undefined;
    try {
      descriptor = openSync(candidatesPath, constants.O_RDWR | constants.O_NOFOLLOW);
      exactBytes(candidatesPath, descriptor, candidateFile.identity, candidateFile.bytes);
      options.operationHooks?.beforeCandidateFileSync?.(candidatesPath);
      fsyncSync(descriptor);
      exactBytes(candidatesPath, descriptor, candidateFile.identity, candidateFile.bytes);
      syncDirectory(
        intakeDirectory,
        requestedStatePath,
        options.operationHooks?.beforeDirectorySync,
      );
      exactBytes(candidatesPath, descriptor, candidateFile.identity, candidateFile.bytes);
    } catch (error) {
      if (error instanceof RuntimeProjectError) throw error;
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };

  const appendCandidate = (candidate: CandidateJobIntentV1): void => {
    candidateLoaded = false;
    loadCandidates();
    if (candidates.has(candidate.candidate_key)) {
      synchronizeCandidateFile();
      return;
    }
    const line = Buffer.from(
      `${canonicalJson(candidate, PROJECT_CANDIDATE_JSON_LIMITS)}\n`,
      "utf8",
    );
    const priorBytes = candidateFile?.bytes ?? Buffer.alloc(0);
    if (priorBytes.byteLength + line.byteLength > MAX_CANDIDATE_BYTES) {
      projectError("RUNTIME_PROJECT_UNAVAILABLE");
    }
    let descriptor: number | undefined;
    try {
      if (candidateFile === null) {
        descriptor = openSync(
          candidatesPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        );
        const created = assertPrivateFile(fstatSync(descriptor, { bigint: true }));
        writeAll(descriptor, line);
        options.operationHooks?.beforeCandidateFileSync?.(candidatesPath);
        fsyncSync(descriptor);
        exactBytes(candidatesPath, descriptor, created, line);
        syncDirectory(
          intakeDirectory,
          requestedStatePath,
          options.operationHooks?.beforeDirectorySync,
        );
        exactBytes(candidatesPath, descriptor, created, line);
        candidateFile = { bytes: line, identity: created };
      } else {
        descriptor = openSync(
          candidatesPath,
          constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW,
        );
        exactBytes(candidatesPath, descriptor, candidateFile.identity, candidateFile.bytes);
        writeAll(descriptor, line);
        const combined = Buffer.concat([Buffer.from(candidateFile.bytes), line]);
        options.operationHooks?.beforeCandidateFileSync?.(candidatesPath);
        fsyncSync(descriptor);
        exactBytes(candidatesPath, descriptor, candidateFile.identity, combined);
        candidateFile = { bytes: combined, identity: candidateFile.identity };
      }
      candidates.set(candidate.candidate_key, candidate);
      options.operationHooks?.afterCandidateAppend?.(candidate);
    } catch (error) {
      if (error instanceof RuntimeProjectError) throw error;
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };

  const pendingPath = (projectId: string): string =>
    path.join(pendingDirectory, `${projectId}.json`);

  const refreshWindow = (projectId: string): PendingState | undefined => {
    const previous = windows.get(projectId);
    if (previous?.timer !== undefined) clearTimeout(previous.timer);
    const file = readPrivate(pendingPath(projectId), MAX_PENDING_BYTES);
    if (file === null) {
      syncDirectory(
        pendingDirectory,
        requestedStatePath,
        options.operationHooks?.beforeDirectorySync,
      );
      windows.delete(projectId);
      return undefined;
    }
    const document = parsePending(file.bytes);
    if (document.project_id !== projectId) projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
    const state: PendingState = { document, file };
    windows.set(projectId, state);
    return state;
  };

  const publishPending = (
    document: ProjectPendingWindowV1,
    expected: FileSnapshot | null,
  ): FileSnapshot => {
    const randomId = options.randomId();
    if (!UUID_PATTERN.test(randomId)) projectError("RUNTIME_PROJECT_INVALID");
    const finalPath = pendingPath(document.project_id);
    const stagePath = path.join(pendingDirectory, `.${document.project_id}.${randomId}.stage`);
    const bytes = canonicalBytes(document);
    if (bytes.byteLength > MAX_PENDING_BYTES) projectError("RUNTIME_PROJECT_UNAVAILABLE");
    let stage: number | undefined;
    let stageIdentity: FileIdentity | undefined;
    let current: number | undefined;
    try {
      stage = openSync(
        stagePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      stageIdentity = assertPrivateFile(fstatSync(stage, { bigint: true }));
      writeAll(stage, bytes);
      options.operationHooks?.beforePendingFileSync?.(stagePath);
      fsyncSync(stage);
      exactBytes(stagePath, stage, stageIdentity, bytes);
      syncDirectory(
        pendingDirectory,
        requestedStatePath,
        options.operationHooks?.beforeDirectorySync,
      );
      exactBytes(stagePath, stage, stageIdentity, bytes);
      options.operationHooks?.afterPendingFileSync?.(stagePath);
      if (expected === null) {
        if (readPrivate(finalPath, MAX_PENDING_BYTES) !== null) {
          projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
        }
      } else {
        current = openSync(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        exactBytes(finalPath, current, expected.identity, expected.bytes);
      }
      renameSync(stagePath, finalPath);
      exactBytes(finalPath, stage, stageIdentity, bytes);
      syncDirectory(
        pendingDirectory,
        requestedStatePath,
        options.operationHooks?.beforeDirectorySync,
      );
      exactBytes(finalPath, stage, stageIdentity, bytes);
      return { bytes, identity: stageIdentity };
    } catch (error) {
      if (stage !== undefined && stageIdentity !== undefined) {
        try {
          let stageExists = true;
          try {
            assertPrivateFile(lstatSync(stagePath, { bigint: true }), stageIdentity);
          } catch (stageError) {
            if (errorCode(stageError) !== "ENOENT") throw stageError;
            stageExists = false;
          }
          if (stageExists) {
            unlinkSync(stagePath);
            syncDirectory(
              pendingDirectory,
              requestedStatePath,
              options.operationHooks?.beforeDirectorySync,
            );
            try {
              lstatSync(stagePath, { bigint: true });
              projectError("RUNTIME_PROJECT_PATH_UNSAFE");
            } catch (absenceError) {
              if (errorCode(absenceError) !== "ENOENT") throw absenceError;
            }
          } else {
            exactBytes(finalPath, stage, stageIdentity, bytes);
            fsyncSync(stage);
            exactBytes(finalPath, stage, stageIdentity, bytes);
            syncDirectory(
              pendingDirectory,
              requestedStatePath,
              options.operationHooks?.beforeDirectorySync,
            );
            exactBytes(finalPath, stage, stageIdentity, bytes);
            return { bytes, identity: stageIdentity };
          }
        } catch {
          if (sharedCoordinator !== undefined) sharedCoordinator.publicationBlocked = true;
          for (const state of windows.values()) {
            if (state.timer !== undefined) clearTimeout(state.timer);
            delete state.timer;
          }
        }
      }
      if (stage !== undefined && stageIdentity === undefined && sharedCoordinator !== undefined) {
        sharedCoordinator.publicationBlocked = true;
      }
      if (error instanceof RuntimeProjectError) throw error;
      throw error;
    } finally {
      if (current !== undefined) closeSync(current);
      if (stage !== undefined) closeSync(stage);
    }
  };

  const removeExactPending = (state: PendingState): void => {
    const candidate = pendingPath(state.document.project_id);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      exactBytes(candidate, descriptor, state.file.identity, state.file.bytes);
      options.operationHooks?.beforePendingUnlink?.(candidate);
      exactBytes(candidate, descriptor, state.file.identity, state.file.bytes);
      unlinkSync(candidate);
      syncDirectory(
        pendingDirectory,
        requestedStatePath,
        options.operationHooks?.beforeDirectorySync,
      );
      if (readPrivate(candidate, MAX_PENDING_BYTES) !== null) {
        projectError("RUNTIME_PROJECT_PATH_UNSAFE");
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        syncDirectory(
          pendingDirectory,
          requestedStatePath,
          options.operationHooks?.beforeDirectorySync,
        );
        if (readPrivate(candidate, MAX_PENDING_BYTES) !== null) {
          projectError("RUNTIME_PROJECT_PATH_UNSAFE");
        }
        return;
      }
      if (error instanceof RuntimeProjectError) throw error;
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };

  const flushWindow = (projectId: string): void => {
    const state = windows.get(projectId);
    if (state === undefined) return;
    if (state.timer !== undefined) clearTimeout(state.timer);
    const registration: ProjectRegistration = {
      project_id: state.document.project_id,
      registry_revision: state.document.registry_revision,
      canonical_root: state.document.canonical_root,
      manifest_hash: state.document.manifest_hash,
      state: "ACTIVE",
    };
    const candidate = validatedCandidate(
      registration,
      state.document.changes,
      options.now().toISOString(),
    );
    appendCandidate(candidate);
    removeExactPending(state);
    windows.delete(projectId);
  };

  const arm = (state: PendingState): void => {
    if (state.timer !== undefined) clearTimeout(state.timer);
    const now = options.now().getTime();
    const deadline = Date.parse(state.document.deadline_at);
    const updated = Date.parse(state.document.updated_at);
    const delay = Math.max(0, Math.min(updated + DEBOUNCE_MS, deadline) - now);
    state.timer = setTimeout(() => {
      delete state.timer;
      void enqueue(() => {
        refreshWindow(state.document.project_id);
        flushWindow(state.document.project_id);
      }).catch(() => undefined);
    }, delay);
  };

  const removeSnapshot = (candidate: string, snapshot: FileSnapshot): void => {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      exactBytes(candidate, descriptor, snapshot.identity, snapshot.bytes);
      unlinkSync(candidate);
      syncDirectory(
        pendingDirectory,
        requestedStatePath,
        options.operationHooks?.beforeDirectorySync,
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        syncDirectory(
          pendingDirectory,
          requestedStatePath,
          options.operationHooks?.beforeDirectorySync,
        );
        if (readPrivate(candidate, MAX_PENDING_BYTES) !== null) {
          projectError("RUNTIME_PROJECT_PATH_UNSAFE");
        }
        return;
      }
      if (error instanceof RuntimeProjectError) throw error;
      projectError("RUNTIME_PROJECT_UNAVAILABLE");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };

  const recoverFiles = (registrations: readonly ProjectRegistration[]): void => {
    loadCandidates();
    for (const state of windows.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer);
    }
    windows.clear();
    const active = new Map(registrations.map((entry) => [entry.project_id, entry]));
    const finals = new Map<string, { path: string; snapshot: FileSnapshot }>();
    const stages = new Map<string, { path: string; snapshot: FileSnapshot }>();
    for (const name of readdirSync(pendingDirectory)) {
      const finalMatch = FINAL_PENDING_PATTERN.exec(name);
      const stageMatch = STAGED_PENDING_PATTERN.exec(name);
      if (finalMatch === null && stageMatch === null) {
        projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
      }
      const projectId = finalMatch?.[1] ?? stageMatch?.[1];
      if (projectId === undefined) projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
      const candidate = path.join(pendingDirectory, name);
      const snapshot = readPrivate(candidate, MAX_PENDING_BYTES);
      if (snapshot === null) projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
      if (finalMatch !== null) {
        if (finals.has(projectId)) projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
        finals.set(projectId, { path: candidate, snapshot });
      } else {
        if (stages.has(projectId)) projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
        stages.set(projectId, { path: candidate, snapshot });
      }
    }

    for (const [projectId, staged] of stages) {
      const stagedDocument = parsePending(staged.snapshot.bytes);
      if (stagedDocument.project_id !== projectId) {
        projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
      }
      const existing = finals.get(projectId);
      if (existing !== undefined) {
        const existingDocument = parsePending(existing.snapshot.bytes);
        if (
          existingDocument.project_id !== projectId ||
          Date.parse(stagedDocument.updated_at) < Date.parse(existingDocument.updated_at)
        ) {
          projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
        }
      }
      renameSync(staged.path, pendingPath(projectId));
      syncDirectory(
        pendingDirectory,
        requestedStatePath,
        options.operationHooks?.beforeDirectorySync,
      );
      const published = readPrivate(pendingPath(projectId), MAX_PENDING_BYTES);
      if (published === null || !sameIdentity(published.identity, staged.snapshot.identity)) {
        projectError("RUNTIME_PROJECT_PATH_UNSAFE");
      }
      finals.set(projectId, { path: pendingPath(projectId), snapshot: published });
    }

    for (const [projectId, final] of finals) {
      const document = parsePending(final.snapshot.bytes);
      if (document.project_id !== projectId) projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
      if (!matchingRegistration(document, active.get(projectId))) {
        removeSnapshot(final.path, final.snapshot);
        continue;
      }
      windows.set(projectId, { document, file: final.snapshot });
    }
    for (const projectId of [...windows.keys()].sort()) flushWindow(projectId);
  };

  const recordBatch = (
    registration: ProjectRegistration,
    requestedChanges: readonly ProjectChange[],
  ): Promise<void> => {
    if (stopped) {
      return Promise.reject(new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE"));
    }
    return enqueue(() => {
      if (stopped || sharedCoordinator?.publicationBlocked || registration.state !== "ACTIVE") {
        projectError("RUNTIME_PROJECT_UNAVAILABLE");
      }
      const now = options.now();
      if (Number.isNaN(now.getTime())) projectError("RUNTIME_PROJECT_INVALID");
      if (
        !UUID_PATTERN.test(registration.project_id) ||
        !Number.isSafeInteger(registration.registry_revision) ||
        registration.registry_revision < 1 ||
        !HASH_PATTERN.test(registration.manifest_hash) ||
        !path.isAbsolute(registration.canonical_root) ||
        path.normalize(registration.canonical_root) !== registration.canonical_root
      ) {
        projectError("RUNTIME_PROJECT_INVALID");
      }
      const normalizedChanges = sortedChanges(
        requestedChanges.map((change) => {
          assertChange(change);
          const normalized = validatedCandidate(registration, [change], now.toISOString())
            .changes[0];
          if (normalized === undefined) projectError("RUNTIME_PROJECT_INVALID");
          return normalized;
        }),
      );
      if (normalizedChanges.length === 0) return;
      loadCandidates();
      let existing = refreshWindow(registration.project_id);
      if (existing !== undefined && !matchingRegistration(existing.document, registration)) {
        projectError("RUNTIME_PROJECT_INTAKE_CORRUPT");
      }
      if (existing !== undefined && now.getTime() >= Date.parse(existing.document.deadline_at)) {
        flushWindow(registration.project_id);
        existing = undefined;
      }
      let changes = new Map(existing?.document.changes.map((entry) => [entry.path, entry]) ?? []);
      let changeBytes = new Map(
        [...changes].map(([relativePath, change]) => [
          relativePath,
          Buffer.byteLength(canonicalJson(change, PROJECT_CANDIDATE_JSON_LIMITS), "utf8"),
        ]),
      );
      let totalChangeBytes = [...changeBytes.values()].reduce((total, bytes) => total + bytes, 0);

      const documentFor = (documentChanges: readonly ProjectChange[]): ProjectPendingWindowV1 => {
        const openedAt = existing?.document.opened_at ?? now.toISOString();
        const deadlineAt =
          existing?.document.deadline_at ?? new Date(now.getTime() + MAX_DEBOUNCE_MS).toISOString();
        return Object.freeze({
          protocol_version: "runtime-contract.v1",
          schema_version: "project-pending-window.v1",
          document_type: "project-pending-window",
          project_id: registration.project_id,
          registry_revision: registration.registry_revision,
          canonical_root: registration.canonical_root,
          manifest_hash: registration.manifest_hash,
          opened_at: openedAt,
          updated_at: now.toISOString(),
          deadline_at: deadlineAt,
          changes: documentChanges,
        });
      };

      const emptyPendingBytes = canonicalBytes(documentFor([])).byteLength;
      const emptyCandidateBytes = Buffer.byteLength(
        canonicalJson(
          candidateFor(registration, [], now.toISOString()),
          PROJECT_CANDIDATE_JSON_LIMITS,
        ),
        "utf8",
      );
      const windowFits = (count: number, serializedChangeBytes: number): boolean => {
        const arrayBytes = serializedChangeBytes + Math.max(0, count - 1);
        return (
          count <= 4096 &&
          emptyPendingBytes + arrayBytes <= MAX_PENDING_BYTES &&
          emptyCandidateBytes + arrayBytes + 1 <= MAX_PENDING_BYTES
        );
      };

      const publishWindow = (): void => {
        if (changes.size === 0) return;
        const document = documentFor(sortedChanges(changes.values()));
        const file = publishPending(document, existing?.file ?? null);
        const state: PendingState = { document, file };
        if (existing?.timer !== undefined) clearTimeout(existing.timer);
        windows.set(registration.project_id, state);
        arm(state);
        existing = state;
      };

      for (const change of normalizedChanges) {
        const current = changes.get(change.path);
        let reduced = reduceChange(current, change);
        if (reduced === null) {
          changes.delete(change.path);
          totalChangeBytes -= changeBytes.get(change.path) ?? 0;
          changeBytes.delete(change.path);
          continue;
        }
        let serialized = Buffer.byteLength(
          canonicalJson(reduced, PROJECT_CANDIDATE_JSON_LIMITS),
          "utf8",
        );
        const proposedCount = current === undefined ? changes.size + 1 : changes.size;
        const proposedBytes = totalChangeBytes - (changeBytes.get(change.path) ?? 0) + serialized;
        if (!windowFits(proposedCount, proposedBytes)) {
          if (changes.size === 0) projectError("RUNTIME_PROJECT_UNAVAILABLE");
          publishWindow();
          flushWindow(registration.project_id);
          existing = undefined;
          changes = new Map();
          changeBytes = new Map();
          totalChangeBytes = 0;
          reduced = change;
          serialized = Buffer.byteLength(
            canonicalJson(reduced, PROJECT_CANDIDATE_JSON_LIMITS),
            "utf8",
          );
          if (!windowFits(1, serialized)) projectError("RUNTIME_PROJECT_UNAVAILABLE");
        }
        totalChangeBytes -= changeBytes.get(change.path) ?? 0;
        changes.set(change.path, reduced);
        changeBytes.set(change.path, serialized);
        totalChangeBytes += serialized;
      }
      if (changes.size === 0) {
        if (existing?.timer !== undefined) clearTimeout(existing.timer);
        if (existing !== undefined) removeExactPending(existing);
        windows.delete(registration.project_id);
        return;
      }
      publishWindow();
    });
  };

  return {
    record(registration, change) {
      return recordBatch(registration, [change]);
    },
    recordBatch,
    recover(registrations) {
      return enqueue(() => {
        recoverFiles(registrations);
        if (sharedCoordinator !== undefined) sharedCoordinator.publicationBlocked = false;
      });
    },
    discard(projectId) {
      return enqueue(() => {
        if (!UUID_PATTERN.test(projectId)) projectError("RUNTIME_PROJECT_INVALID");
        const canonicalId = projectId.toLowerCase();
        const state = refreshWindow(canonicalId);
        if (state === undefined) return;
        if (state.timer !== undefined) clearTimeout(state.timer);
        removeExactPending(state);
        windows.delete(canonicalId);
      });
    },
    stopIntake() {
      stopped = true;
      for (const state of windows.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer);
        delete state.timer;
      }
    },
    flush(signal) {
      return enqueue(() => {
        if (signal.aborted || sharedCoordinator?.publicationBlocked) {
          projectError("RUNTIME_PROJECT_UNAVAILABLE");
        }
        const persistedProjectIds = readdirSync(pendingDirectory)
          .map((name) => FINAL_PENDING_PATTERN.exec(name)?.[1])
          .filter((projectId): projectId is string => projectId !== undefined);
        for (const projectId of new Set([...windows.keys(), ...persistedProjectIds])) {
          refreshWindow(projectId);
        }
        for (const projectId of [...windows.keys()].sort()) {
          if (signal.aborted) projectError("RUNTIME_PROJECT_UNAVAILABLE");
          flushWindow(projectId);
        }
      });
    },
    listCandidates() {
      return enqueue(() => {
        candidateLoaded = false;
        loadCandidates();
        return Object.freeze([...candidates.values()]);
      });
    },
  };
}
