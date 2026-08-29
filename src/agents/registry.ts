import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";

import { canonicalJson, parseJsonBytes, sha256, type JsonValue } from "../protocol/json.js";
import type { ArtifactReference } from "../protocol/types.js";
import {
  AGENT_DOCUMENT_LIMITS,
  hashAgentRegistryEntry,
  parseAgentDefinition,
  parseAgentRegistryEntry,
  parsePromptTemplate,
} from "./contracts.js";
import { RuntimeAgentError, type RuntimeAgentErrorCode } from "./errors.js";
import {
  MAX_PRIVATE_OBJECT_BYTES,
  createPrivateAgentStore,
  type PrivateAgentStoreOperationHooks,
  type PrivateFileIdentity,
  type PrivateStoreProcessLiveness,
} from "./private-store.js";
import type {
  AgentDefinitionBundle,
  AgentDefinitionReference,
  AgentDefinitionV1,
  AgentRegistration,
  AgentRegistry,
  AgentRegistryEntryV1,
  PromptTemplateV1,
  PromptTemplateReference,
  ResolvedAgentBundle,
} from "./types.js";

export type { AgentRegistry } from "./types.js";

const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const MAX_OPERATION_RECORD_BYTES = 65_536;
const MAX_AGENTS_CANDIDATES = 3;
const MAX_OBJECT_CANDIDATES = 65_536;
const MAX_REGISTRY_CANDIDATES = 4;
const MAX_MUTATION_CLAIM_BYTES = 128;
const MAX_REGISTRY_AGGREGATE_BYTES = MAX_HISTORY_BYTES * 3 + MAX_MUTATION_CLAIM_BYTES;
const MAX_QUARANTINE_CANDIDATES = 4096;
const MAX_QUARANTINE_AGGREGATE_BYTES = MAX_HISTORY_BYTES;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const QUARANTINE_PATTERN =
  /^agent-registry(?:-operations)?-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/u;
const RECOVERY_STAGE_PATTERN =
  /^\.(lifecycle|operations)-recovery\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.stage$/u;

type AgentRegistryHistoryKind = "lifecycle" | "operations" | "quarantine" | "recovery";

interface AgentRegistryOperationHooks {
  readonly beforeHistoryFileSync?: (history: AgentRegistryHistoryKind, filePath: string) => void;
  readonly beforeHistoryDirectorySync?: (directoryPath: string) => void;
  readonly afterQuarantinePublished?: (filePath: string) => void;
  readonly afterObjectsPublished?: () => Promise<void>;
  readonly beforeRecoveryStageDirectorySync?: (
    kind: "lifecycle" | "operations",
    stagePath: string,
  ) => void;
  readonly beforeRecoveryRename?: (
    kind: "lifecycle" | "operations",
    stagePath: string,
    historyPath: string,
  ) => void;
  readonly afterRecoveryRename?: (kind: "lifecycle" | "operations", historyPath: string) => void;
}

export interface CreateAgentRegistryOptions {
  readonly statePath: string;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly hasServiceListener: () => Promise<"present" | "absent" | "unknown">;
}

interface CandidateDirectoryEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface CandidateDirectoryReader {
  readSync(): CandidateDirectoryEntry | null;
  closeSync(): void;
}

interface CandidateLimits {
  readonly objectCount: number;
  readonly registryCount: number;
  readonly registryAggregateBytes: number;
  readonly quarantineCount: number;
  readonly quarantineAggregateBytes: number;
}

interface CandidateScanOptions {
  readonly openCandidateDirectory?: (candidate: string) => CandidateDirectoryReader | undefined;
  readonly limits: CandidateLimits;
}

interface CandidateUsage {
  readonly count: number;
  readonly aggregateBytes: bigint;
  readonly candidates: readonly CandidateFileSnapshot[];
}

interface CandidateFileSnapshot {
  readonly name: string;
  readonly identity: PrivateFileIdentity;
  readonly size: bigint;
}

interface RecoveryStageSnapshot extends CandidateFileSnapshot {
  readonly kind: "lifecycle" | "operations";
  readonly operationId: string;
}

interface RegistryCandidateOptions {
  readonly allowMutationClaim: boolean;
  readonly allowRecoveryStage: boolean;
}

interface RegistryLoadOptions extends RegistryCandidateOptions {
  readonly recoverPartials: boolean;
  readonly nonCreatingObjectReads: boolean;
}

interface DirectoryContentToken {
  readonly identity: PrivateFileIdentity;
  readonly size: bigint;
  readonly modificationTimeNanoseconds: bigint;
  readonly changeTimeNanoseconds: bigint;
}

interface AgentRegistryInternalDependencies {
  readonly isProcessAlive?: (pid: number) => PrivateStoreProcessLiveness;
  readonly isCurrentUser?: (userId: bigint, candidate: string) => boolean;
  readonly privateStoreOperationHooks?: PrivateAgentStoreOperationHooks;
  readonly operationHooks?: AgentRegistryOperationHooks;
  readonly openCandidateDirectory?: (candidate: string) => CandidateDirectoryReader | undefined;
  readonly candidateLimits?: Partial<CandidateLimits>;
}

interface PrivateFileSnapshot {
  readonly bytes: Uint8Array;
  readonly identity: PrivateFileIdentity;
}

interface HashableAgentOperationRecordV1 {
  readonly schema_version: "agent-registry-operation.v1";
  readonly document_type: "agent-registry-operation";
  readonly operation_revision: number;
  readonly previous_operation_hash: `sha256:${string}` | null;
  readonly operation_id: string;
  readonly operation_hash: `sha256:${string}`;
  readonly lifecycle_head_revision: number;
  readonly lifecycle_head_hash: `sha256:${string}`;
  readonly result: AgentRegistration;
}

interface AgentOperationRecordV1 extends HashableAgentOperationRecordV1 {
  readonly operation_record_hash: `sha256:${string}`;
}

interface OperationResult {
  readonly operationHash: `sha256:${string}`;
  readonly result: AgentRegistration;
}

interface RegistryHistory {
  readonly lifecycleFile: PrivateFileSnapshot | null;
  readonly operationFile: PrivateFileSnapshot | null;
  readonly entries: readonly AgentRegistryEntryV1[];
  readonly operationRecords: readonly AgentOperationRecordV1[];
  readonly active: ReadonlyMap<string, AgentRegistration>;
  readonly bundles: ReadonlyMap<string, ResolvedAgentBundle>;
  readonly revisionHashes: ReadonlyMap<string, `sha256:${string}`>;
  readonly promptRevisionHashes: ReadonlyMap<string, `sha256:${string}`>;
  readonly maximumRevisions: ReadonlyMap<string, number>;
  readonly operations: ReadonlyMap<string, OperationResult>;
}

interface Coordinator {
  tail: Promise<unknown>;
}

interface PinnedDirectory {
  readonly candidate: string;
  readonly identity: PrivateFileIdentity;
}

interface RegistryContext {
  readonly shared: Coordinator;
  readonly directories: readonly PinnedDirectory[];
}

const coordinators = new Map<string, WeakRef<Coordinator>>();

function agentError(code: RuntimeAgentErrorCode): never {
  throw new RuntimeAgentError(code);
}

function registryCorrupt(): never {
  return agentError("RUNTIME_AGENT_REGISTRY_CORRUPT");
}

function pathUnsafe(): never {
  return agentError("RUNTIME_AGENT_PATH_UNSAFE");
}

function definitionInvalid(): never {
  return agentError("RUNTIME_AGENT_DEFINITION_INVALID");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function currentUid(): bigint | undefined {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
}

function identity(metadata: Pick<BigIntStats, "dev" | "ino">): PrivateFileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function identitiesMatch(left: PrivateFileIdentity, right: PrivateFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function directoryContentToken(metadata: BigIntStats): DirectoryContentToken {
  return {
    identity: assertPrivateDirectory(metadata),
    size: metadata.size,
    modificationTimeNanoseconds: metadata.mtimeNs,
    changeTimeNanoseconds: metadata.ctimeNs,
  };
}

function directoryContentTokensMatch(
  left: DirectoryContentToken,
  right: DirectoryContentToken,
): boolean {
  return (
    identitiesMatch(left.identity, right.identity) &&
    left.size === right.size &&
    left.modificationTimeNanoseconds === right.modificationTimeNanoseconds &&
    left.changeTimeNanoseconds === right.changeTimeNanoseconds
  );
}

function assertPrivateDirectory(metadata: BigIntStats): PrivateFileIdentity {
  const uid = currentUid();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (uid !== undefined && metadata.uid !== uid) ||
    Number(metadata.mode & 0o7777n) !== 0o700
  ) {
    registryCorrupt();
  }
  return identity(metadata);
}

function pinPrivateDirectories(candidates: readonly string[]): readonly PinnedDirectory[] {
  try {
    return Object.freeze(
      candidates.map((candidate) => {
        if (realpathSync(candidate) !== candidate) pathUnsafe();
        return Object.freeze({
          candidate,
          identity: assertPrivateDirectory(lstatSync(candidate, { bigint: true })),
        });
      }),
    );
  } catch {
    return pathUnsafe();
  }
}

function assertPinnedDirectories(directories: readonly PinnedDirectory[]): void {
  for (const directory of directories) {
    let descriptor: number | undefined;
    try {
      const before = assertPrivateDirectory(lstatSync(directory.candidate, { bigint: true }));
      if (!identitiesMatch(before, directory.identity)) pathUnsafe();
      descriptor = openSync(
        directory.candidate,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const held = assertPrivateDirectory(fstatSync(descriptor, { bigint: true }));
      const after = assertPrivateDirectory(lstatSync(directory.candidate, { bigint: true }));
      if (
        !identitiesMatch(held, directory.identity) ||
        !identitiesMatch(after, directory.identity)
      ) {
        pathUnsafe();
      }
    } catch {
      return pathUnsafe();
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

function assertPrivateFile(
  metadata: BigIntStats,
  expected?: PrivateFileIdentity,
  expectedMode = 0o600,
): PrivateFileIdentity {
  const candidate = identity(metadata);
  const uid = currentUid();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1n ||
    (uid !== undefined && metadata.uid !== uid) ||
    Number(metadata.mode & 0o7777n) !== expectedMode ||
    (expected !== undefined && !identitiesMatch(expected, candidate))
  ) {
    registryCorrupt();
  }
  return candidate;
}

function boundedCandidateLimit(candidate: number | undefined, fallback: number): number {
  if (candidate === undefined) return fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > fallback) {
    registryCorrupt();
  }
  return candidate;
}

function resolveCandidateLimits(overrides?: Partial<CandidateLimits>): CandidateLimits {
  return Object.freeze({
    objectCount: boundedCandidateLimit(overrides?.objectCount, MAX_OBJECT_CANDIDATES),
    registryCount: boundedCandidateLimit(overrides?.registryCount, MAX_REGISTRY_CANDIDATES),
    registryAggregateBytes: boundedCandidateLimit(
      overrides?.registryAggregateBytes,
      MAX_REGISTRY_AGGREGATE_BYTES,
    ),
    quarantineCount: boundedCandidateLimit(overrides?.quarantineCount, MAX_QUARANTINE_CANDIDATES),
    quarantineAggregateBytes: boundedCandidateLimit(
      overrides?.quarantineAggregateBytes,
      MAX_QUARANTINE_AGGREGATE_BYTES,
    ),
  });
}

function scanCandidateDirectory(
  candidate: string,
  maximumCount: number,
  visit: (entry: CandidateDirectoryEntry) => void,
  openCandidateDirectory?: (candidate: string) => CandidateDirectoryReader | undefined,
): void {
  let directory: CandidateDirectoryReader | undefined;
  let failure: unknown;
  try {
    directory = openCandidateDirectory?.(candidate) ?? opendirSync(candidate, { bufferSize: 32 });
    let count = 0;
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      count += 1;
      if (count > maximumCount) registryCorrupt();
      visit(entry);
    }
  } catch (error) {
    failure = error;
  }
  if (directory !== undefined) {
    try {
      directory.closeSync();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    if (failure instanceof RuntimeAgentError) throw failure;
    registryCorrupt();
  }
}

function syncPrivateDirectory(candidate: string, beforeSync?: (candidate: string) => void): void {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(candidate, { bigint: true });
    const expected = assertPrivateDirectory(before);
    descriptor = openSync(
      candidate,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    assertPrivateDirectory(fstatSync(descriptor, { bigint: true }));
    beforeSync?.(candidate);
    fsyncSync(descriptor);
    assertPrivateDirectory(lstatSync(candidate, { bigint: true }));
    const held = assertPrivateDirectory(fstatSync(descriptor, { bigint: true }));
    if (!identitiesMatch(expected, held)) registryCorrupt();
  } catch (error) {
    if (error instanceof RuntimeAgentError) throw error;
    return registryCorrupt();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readAll(descriptor: number, size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, bytes, offset, size - offset, offset);
    if (count === 0) registryCorrupt();
    offset += count;
  }
  return bytes;
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  const source = Buffer.from(bytes);
  let offset = 0;
  while (offset < source.byteLength) {
    const count = writeSync(descriptor, source, offset, source.byteLength - offset, null);
    if (count === 0) registryCorrupt();
    offset += count;
  }
}

function exactFile(
  candidate: string,
  descriptor: number,
  expectedIdentity: PrivateFileIdentity,
  expectedBytes: Uint8Array,
): void {
  const pathMetadata = lstatSync(candidate, { bigint: true });
  const heldMetadata = fstatSync(descriptor, { bigint: true });
  assertPrivateFile(pathMetadata, expectedIdentity);
  assertPrivateFile(heldMetadata, expectedIdentity);
  if (
    pathMetadata.size !== BigInt(expectedBytes.byteLength) ||
    heldMetadata.size !== BigInt(expectedBytes.byteLength) ||
    !readAll(descriptor, expectedBytes.byteLength).equals(Buffer.from(expectedBytes))
  ) {
    registryCorrupt();
  }
}

function canonicalStatePath(candidate: string): string {
  if (
    !path.isAbsolute(candidate) ||
    path.normalize(candidate) !== candidate ||
    candidate === path.parse(candidate).root ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    return agentError("RUNTIME_AGENT_PATH_UNSAFE");
  }
  const suffix: string[] = [];
  let cursor = candidate;
  for (;;) {
    try {
      return path.join(realpathSync(cursor), ...suffix);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return agentError("RUNTIME_AGENT_PATH_UNSAFE");
      const parent = path.dirname(cursor);
      if (parent === cursor) return agentError("RUNTIME_AGENT_PATH_UNSAFE");
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function assertRegistryCandidates(
  registryPath: string,
  scans: CandidateScanOptions,
  options: RegistryCandidateOptions,
): readonly RecoveryStageSnapshot[] {
  const allowed = new Set(["entries.jsonl", "operations.jsonl"]);
  let aggregateBytes = 0n;
  const recoveryStages: RecoveryStageSnapshot[] = [];
  scanCandidateDirectory(
    registryPath,
    scans.limits.registryCount,
    (entry) => {
      const claim = entry.name === "mutation.claim";
      const recoveryStage = RECOVERY_STAGE_PATTERN.exec(entry.name);
      if (
        (!allowed.has(entry.name) &&
          !(claim && options.allowMutationClaim) &&
          !(recoveryStage !== null && options.allowRecoveryStage)) ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      ) {
        registryCorrupt();
      }
      const maximumBytes = claim ? MAX_MUTATION_CLAIM_BYTES : MAX_HISTORY_BYTES;
      const metadata = lstatSync(path.join(registryPath, entry.name), { bigint: true });
      const candidateIdentity = assertPrivateFile(metadata, undefined, claim ? 0o700 : 0o600);
      if (metadata.size > BigInt(maximumBytes)) registryCorrupt();
      aggregateBytes += metadata.size;
      if (aggregateBytes > BigInt(scans.limits.registryAggregateBytes)) registryCorrupt();
      if (recoveryStage !== null) {
        const kind = recoveryStage[1];
        const operationId = recoveryStage[2];
        if ((kind !== "lifecycle" && kind !== "operations") || operationId === undefined) {
          registryCorrupt();
        }
        recoveryStages.push({
          name: entry.name,
          identity: candidateIdentity,
          size: metadata.size,
          kind,
          operationId,
        });
        if (recoveryStages.length > 1) registryCorrupt();
      }
    },
    scans.openCandidateDirectory,
  );
  return Object.freeze(recoveryStages);
}

function assertCanonicalStoredAgentObject(bytes: Uint8Array, hash: `sha256:${string}`): void {
  if (createHash("sha256").update(bytes).digest("hex") !== hash.slice("sha256:".length)) {
    registryCorrupt();
  }
  let value: JsonValue;
  try {
    value = parseJsonBytes(bytes, AGENT_DOCUMENT_LIMITS);
  } catch {
    return registryCorrupt();
  }
  if (
    !jsonObject(value) ||
    "document_hash" in value ||
    !Buffer.from(canonicalJson(value), "utf8").equals(Buffer.from(bytes))
  ) {
    registryCorrupt();
  }
  const candidate = Buffer.from(canonicalJson({ ...value, document_hash: hash }), "utf8");
  if (value.document_type === "agent-definition") {
    const parsed = parseAgentDefinition(candidate);
    if (!parsed.ok || parsed.value.document_hash !== hash) registryCorrupt();
    return;
  }
  if (value.document_type === "prompt-template") {
    const parsed = parsePromptTemplate(candidate);
    if (!parsed.ok || parsed.value.document_hash !== hash) registryCorrupt();
    return;
  }
  registryCorrupt();
}

function assertAgentCandidates(
  agentsPath: string,
  objectsPath: string,
  scans: CandidateScanOptions,
): void {
  const ownedDirectories = new Set(["objects", "quarantine", "registry"]);
  scanCandidateDirectory(
    agentsPath,
    MAX_AGENTS_CANDIDATES,
    (entry) => {
      if (!ownedDirectories.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        registryCorrupt();
      }
    },
    scans.openCandidateDirectory,
  );
  scanCandidateDirectory(
    objectsPath,
    scans.limits.objectCount,
    (entry) => {
      if (!entry.isFile() || !/^[0-9a-f]{64}$/u.test(entry.name)) registryCorrupt();
      const candidate = path.join(objectsPath, entry.name);
      let descriptor: number | undefined;
      try {
        const metadata = lstatSync(candidate, { bigint: true });
        const expected = assertPrivateFile(metadata);
        if (metadata.size > BigInt(MAX_PRIVATE_OBJECT_BYTES)) registryCorrupt();
        descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
        const held = fstatSync(descriptor, { bigint: true });
        assertPrivateFile(held, expected);
        if (held.size > BigInt(MAX_PRIVATE_OBJECT_BYTES)) registryCorrupt();
        const bytes = readAll(descriptor, Number(held.size));
        fsyncSync(descriptor);
        exactFile(candidate, descriptor, expected, bytes);
        assertCanonicalStoredAgentObject(bytes, `sha256:${entry.name}`);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    },
    scans.openCandidateDirectory,
  );
}

function assertQuarantineCandidates(
  quarantinePath: string,
  scans: CandidateScanOptions,
): CandidateUsage {
  let count = 0;
  let aggregateBytes = 0n;
  const candidates: CandidateFileSnapshot[] = [];
  scanCandidateDirectory(
    quarantinePath,
    scans.limits.quarantineCount,
    (entry) => {
      count += 1;
      if (!entry.isFile() || !QUARANTINE_PATTERN.test(entry.name)) registryCorrupt();
      const metadata = lstatSync(path.join(quarantinePath, entry.name), { bigint: true });
      const candidateIdentity = assertPrivateFile(metadata);
      if (metadata.size > BigInt(MAX_HISTORY_BYTES)) registryCorrupt();
      aggregateBytes += metadata.size;
      if (aggregateBytes > BigInt(scans.limits.quarantineAggregateBytes)) registryCorrupt();
      candidates.push({ name: entry.name, identity: candidateIdentity, size: metadata.size });
    },
    scans.openCandidateDirectory,
  );
  return { count, aggregateBytes, candidates };
}

function assertCandidateSnapshot(directoryPath: string, candidate: CandidateFileSnapshot): void {
  const candidatePath = path.join(directoryPath, candidate.name);
  let descriptor: number | undefined;
  try {
    const before = lstatSync(candidatePath, { bigint: true });
    assertPrivateFile(before, candidate.identity);
    if (before.size !== candidate.size) registryCorrupt();
    descriptor = openSync(candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const held = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(candidatePath, { bigint: true });
    assertPrivateFile(held, candidate.identity);
    assertPrivateFile(after, candidate.identity);
    if (held.size !== candidate.size || after.size !== candidate.size) registryCorrupt();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertStableQuarantineCandidates(
  quarantinePath: string,
  scans: CandidateScanOptions,
): CandidateUsage {
  let descriptor: number | undefined;
  try {
    const pathBefore = lstatSync(quarantinePath, { bigint: true });
    const expectedIdentity = assertPrivateDirectory(pathBefore);
    descriptor = openSync(
      quarantinePath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const before = directoryContentToken(fstatSync(descriptor, { bigint: true }));
    const pathAfterOpen = assertPrivateDirectory(lstatSync(quarantinePath, { bigint: true }));
    if (
      !identitiesMatch(expectedIdentity, before.identity) ||
      !identitiesMatch(expectedIdentity, pathAfterOpen)
    ) {
      registryCorrupt();
    }

    const usage = assertQuarantineCandidates(quarantinePath, scans);
    for (const candidate of usage.candidates) {
      assertCandidateSnapshot(quarantinePath, candidate);
    }

    const after = directoryContentToken(fstatSync(descriptor, { bigint: true }));
    const pathAfterScan = assertPrivateDirectory(lstatSync(quarantinePath, { bigint: true }));
    if (
      !identitiesMatch(expectedIdentity, pathAfterScan) ||
      !directoryContentTokensMatch(before, after)
    ) {
      registryCorrupt();
    }
    return usage;
  } catch (error) {
    if (error instanceof RuntimeAgentError) throw error;
    return registryCorrupt();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readHistoryFile(
  candidate: string,
  registryPath: string,
  scans: CandidateScanOptions,
  candidateOptions: RegistryCandidateOptions,
): PrivateFileSnapshot | null {
  assertRegistryCandidates(registryPath, scans, candidateOptions);
  let descriptor: number | undefined;
  try {
    let before: BigIntStats;
    try {
      before = lstatSync(candidate, { bigint: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    const expectedIdentity = assertPrivateFile(before);
    if (before.size > BigInt(MAX_HISTORY_BYTES)) registryCorrupt();
    descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const held = fstatSync(descriptor, { bigint: true });
    assertPrivateFile(held, expectedIdentity);
    if (held.size > BigInt(MAX_HISTORY_BYTES)) registryCorrupt();
    const bytes = readAll(descriptor, Number(held.size));
    fsyncSync(descriptor);
    exactFile(candidate, descriptor, expectedIdentity, bytes);
    syncPrivateDirectory(registryPath);
    exactFile(candidate, descriptor, expectedIdentity, bytes);
    return { bytes, identity: expectedIdentity };
  } catch (error) {
    if (error instanceof RuntimeAgentError) throw error;
    return registryCorrupt();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readExactPrivateFile(options: {
  readonly candidate: string;
  readonly parentPath: string;
  readonly maximumBytes: number;
  readonly expectedIdentity?: PrivateFileIdentity;
}): PrivateFileSnapshot {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(options.candidate, { bigint: true });
    const expected = assertPrivateFile(before, options.expectedIdentity);
    if (before.size > BigInt(options.maximumBytes)) registryCorrupt();
    descriptor = openSync(options.candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const held = fstatSync(descriptor, { bigint: true });
    assertPrivateFile(held, expected);
    if (held.size > BigInt(options.maximumBytes)) registryCorrupt();
    const bytes = readAll(descriptor, Number(held.size));
    fsyncSync(descriptor);
    exactFile(options.candidate, descriptor, expected, bytes);
    syncPrivateDirectory(options.parentPath);
    exactFile(options.candidate, descriptor, expected, bytes);
    return { bytes, identity: expected };
  } catch (error) {
    if (error instanceof RuntimeAgentError) throw error;
    return registryCorrupt();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function quarantineArtifactName(kind: "lifecycle" | "operations", operationId: string): string {
  return kind === "lifecycle"
    ? `agent-registry-${operationId}.bin`
    : `agent-registry-operations-${operationId}.bin`;
}

function quarantineOperationId(kind: "lifecycle" | "operations", name: string): string | undefined {
  const prefix = kind === "lifecycle" ? "agent-registry-" : "agent-registry-operations-";
  if (!name.startsWith(prefix) || !name.endsWith(".bin")) return undefined;
  const operationId = name.slice(prefix.length, -".bin".length);
  return UUID_PATTERN.test(operationId) ? operationId : undefined;
}

function reusableQuarantine(options: {
  readonly quarantinePath: string;
  readonly kind: "lifecycle" | "operations";
  readonly fragment: Uint8Array;
  readonly scans: CandidateScanOptions;
}):
  | Readonly<{
      operationId: string;
      candidate: string;
      identity: PrivateFileIdentity;
    }>
  | undefined {
  const usage = assertStableQuarantineCandidates(options.quarantinePath, options.scans);
  const matches: {
    operationId: string;
    candidate: string;
    identity: PrivateFileIdentity;
  }[] = [];
  for (const snapshot of usage.candidates) {
    if (snapshot.size !== BigInt(options.fragment.byteLength)) continue;
    const operationId = quarantineOperationId(options.kind, snapshot.name);
    if (operationId === undefined) continue;
    const candidate = path.join(options.quarantinePath, snapshot.name);
    const exact = readExactPrivateFile({
      candidate,
      parentPath: options.quarantinePath,
      maximumBytes: MAX_HISTORY_BYTES,
      expectedIdentity: snapshot.identity,
    });
    if (Buffer.from(exact.bytes).equals(Buffer.from(options.fragment))) {
      matches.push({ operationId, candidate, identity: exact.identity });
      if (matches.length > 1) registryCorrupt();
    }
  }
  return matches[0] === undefined ? undefined : Object.freeze(matches[0]);
}

function cleanupOwnedRecoveryStage(
  stagePath: string,
  registryPath: string,
  expectedIdentity: PrivateFileIdentity,
): void {
  try {
    const metadata = lstatSync(stagePath, { bigint: true });
    assertPrivateFile(metadata, expectedIdentity);
    unlinkSync(stagePath);
    syncPrivateDirectory(registryPath);
  } catch {
    // A missing or identity-replaced path is not ours to remove. Preserve it so
    // the next explicit recovery can fail closed against the exact candidate.
  }
}

function assertExactRecoveryStageCandidate(options: {
  readonly stageName: string;
  readonly stageIdentity: PrivateFileIdentity;
  readonly stageSize: bigint;
  readonly registryPath: string;
  readonly scans: CandidateScanOptions;
}): void {
  const stages = assertRegistryCandidates(options.registryPath, options.scans, {
    allowMutationClaim: true,
    allowRecoveryStage: true,
  });
  const stage = stages[0];
  if (
    stages.length !== 1 ||
    stage === undefined ||
    stage.name !== options.stageName ||
    stage.size !== options.stageSize ||
    !identitiesMatch(stage.identity, options.stageIdentity)
  ) {
    registryCorrupt();
  }
}

function completeRecoveryStage(options: {
  readonly stage: RecoveryStageSnapshot;
  readonly candidate: string;
  readonly registryPath: string;
  readonly quarantinePath: string;
  readonly expected: PrivateFileSnapshot;
  readonly prefix: Uint8Array;
  readonly fragment: Uint8Array;
  readonly scans: CandidateScanOptions;
  readonly assertRegistryIdentity: () => void;
  readonly hooks?: AgentRegistryOperationHooks;
}): void {
  const stagePath = path.join(options.registryPath, options.stage.name);
  const quarantineName = quarantineArtifactName(options.stage.kind, options.stage.operationId);
  const quarantinePath = path.join(options.quarantinePath, quarantineName);
  let quarantineDescriptor: number | undefined;
  let stageDescriptor: number | undefined;
  let currentDescriptor: number | undefined;
  try {
    options.assertRegistryIdentity();
    const quarantineUsage = assertStableQuarantineCandidates(options.quarantinePath, options.scans);
    const quarantineSnapshot = quarantineUsage.candidates.find(
      (candidate) => candidate.name === quarantineName,
    );
    if (
      quarantineSnapshot === undefined ||
      quarantineSnapshot.size !== BigInt(options.fragment.byteLength)
    ) {
      registryCorrupt();
    }
    const quarantine = readExactPrivateFile({
      candidate: quarantinePath,
      parentPath: options.quarantinePath,
      maximumBytes: MAX_HISTORY_BYTES,
      expectedIdentity: quarantineSnapshot.identity,
    });
    if (!Buffer.from(quarantine.bytes).equals(Buffer.from(options.fragment))) registryCorrupt();
    const stableQuarantine = assertStableQuarantineCandidates(
      options.quarantinePath,
      options.scans,
    ).candidates.find((candidate) => candidate.name === quarantineName);
    if (
      stableQuarantine === undefined ||
      stableQuarantine.size !== quarantineSnapshot.size ||
      !identitiesMatch(stableQuarantine.identity, quarantineSnapshot.identity)
    ) {
      registryCorrupt();
    }
    quarantineDescriptor = openSync(quarantinePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    exactFile(quarantinePath, quarantineDescriptor, quarantineSnapshot.identity, options.fragment);

    const stageBefore = lstatSync(stagePath, { bigint: true });
    assertPrivateFile(stageBefore, options.stage.identity);
    if (stageBefore.size !== options.stage.size) registryCorrupt();
    stageDescriptor = openSync(stagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const heldStage = fstatSync(stageDescriptor, { bigint: true });
    assertPrivateFile(heldStage, options.stage.identity);
    if (
      heldStage.size !== BigInt(options.prefix.byteLength) ||
      !readAll(stageDescriptor, options.prefix.byteLength).equals(Buffer.from(options.prefix))
    ) {
      registryCorrupt();
    }
    fsyncSync(stageDescriptor);
    exactFile(stagePath, stageDescriptor, options.stage.identity, options.prefix);

    currentDescriptor = openSync(options.candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    exactFile(
      options.candidate,
      currentDescriptor,
      options.expected.identity,
      options.expected.bytes,
    );
    options.hooks?.beforeRecoveryRename?.(options.stage.kind, stagePath, options.candidate);
    assertExactRecoveryStageCandidate({
      stageName: options.stage.name,
      stageIdentity: options.stage.identity,
      stageSize: options.stage.size,
      registryPath: options.registryPath,
      scans: options.scans,
    });
    options.assertRegistryIdentity();
    exactFile(quarantinePath, quarantineDescriptor, quarantineSnapshot.identity, options.fragment);
    exactFile(
      options.candidate,
      currentDescriptor,
      options.expected.identity,
      options.expected.bytes,
    );
    renameSync(stagePath, options.candidate);
    exactFile(options.candidate, stageDescriptor, options.stage.identity, options.prefix);
    options.hooks?.afterRecoveryRename?.(options.stage.kind, options.candidate);
    assertRegistryCandidates(options.registryPath, options.scans, {
      allowMutationClaim: true,
      allowRecoveryStage: false,
    });
    syncPrivateDirectory(options.registryPath, options.hooks?.beforeHistoryDirectorySync);
    exactFile(options.candidate, stageDescriptor, options.stage.identity, options.prefix);
    options.assertRegistryIdentity();
    exactFile(quarantinePath, quarantineDescriptor, quarantineSnapshot.identity, options.fragment);
  } catch (error) {
    if (error instanceof RuntimeAgentError) throw error;
    registryCorrupt();
  } finally {
    if (currentDescriptor !== undefined) closeSync(currentDescriptor);
    if (stageDescriptor !== undefined) closeSync(stageDescriptor);
    if (quarantineDescriptor !== undefined) closeSync(quarantineDescriptor);
  }
}

function appendHistoryFile(options: {
  readonly candidate: string;
  readonly registryPath: string;
  readonly expected: PrivateFileSnapshot | null;
  readonly bytes: Uint8Array;
  readonly kind: "lifecycle" | "operations";
  readonly scans: CandidateScanOptions;
  readonly hooks?: AgentRegistryOperationHooks;
}): void {
  assertRegistryCandidates(options.registryPath, options.scans, {
    allowMutationClaim: true,
    allowRecoveryStage: false,
  });
  const prefix = options.expected?.bytes ?? new Uint8Array();
  if (prefix.byteLength + options.bytes.byteLength > MAX_HISTORY_BYTES) registryCorrupt();
  let descriptor: number | undefined;
  try {
    if (options.expected === null) {
      descriptor = openSync(
        options.candidate,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(descriptor, 0o600);
      const created = assertPrivateFile(fstatSync(descriptor, { bigint: true }));
      writeAll(descriptor, options.bytes);
      options.hooks?.beforeHistoryFileSync?.(options.kind, options.candidate);
      fsyncSync(descriptor);
      exactFile(options.candidate, descriptor, created, options.bytes);
      syncPrivateDirectory(options.registryPath, options.hooks?.beforeHistoryDirectorySync);
      exactFile(options.candidate, descriptor, created, options.bytes);
      return;
    }

    descriptor = openSync(
      options.candidate,
      constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW,
    );
    exactFile(options.candidate, descriptor, options.expected.identity, prefix);
    writeAll(descriptor, options.bytes);
    const combined = Buffer.concat([Buffer.from(prefix), Buffer.from(options.bytes)]);
    options.hooks?.beforeHistoryFileSync?.(options.kind, options.candidate);
    fsyncSync(descriptor);
    exactFile(options.candidate, descriptor, options.expected.identity, combined);
    syncPrivateDirectory(options.registryPath, options.hooks?.beforeHistoryDirectorySync);
    exactFile(options.candidate, descriptor, options.expected.identity, combined);
  } catch (error) {
    if (error instanceof RuntimeAgentError) throw error;
    registryCorrupt();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function canonicalUuid(value: string, code: RuntimeAgentErrorCode): string {
  if (!UUID_PATTERN.test(value)) return agentError(code);
  return value;
}

function recoverPartial(options: {
  readonly candidate: string;
  readonly registryPath: string;
  readonly quarantinePath: string;
  readonly expected: PrivateFileSnapshot;
  readonly prefix: Uint8Array;
  readonly fragment: Uint8Array;
  readonly kind: "lifecycle" | "operations";
  readonly randomId: () => string;
  readonly scans: CandidateScanOptions;
  readonly assertRegistryIdentity: () => void;
  readonly hooks?: AgentRegistryOperationHooks;
}): void {
  if (options.prefix.byteLength === 0 || options.fragment.byteLength === 0) registryCorrupt();
  assertRegistryCandidates(options.registryPath, options.scans, {
    allowMutationClaim: true,
    allowRecoveryStage: false,
  });
  const reusable = reusableQuarantine({
    quarantinePath: options.quarantinePath,
    kind: options.kind,
    fragment: options.fragment,
    scans: options.scans,
  });
  if (reusable === undefined) {
    const quarantineUsage = assertQuarantineCandidates(options.quarantinePath, options.scans);
    if (
      quarantineUsage.count >= options.scans.limits.quarantineCount ||
      quarantineUsage.aggregateBytes + BigInt(options.fragment.byteLength) >
        BigInt(options.scans.limits.quarantineAggregateBytes)
    ) {
      registryCorrupt();
    }
  }
  const randomId =
    reusable?.operationId ?? canonicalUuid(options.randomId(), "RUNTIME_AGENT_REGISTRY_CORRUPT");
  const quarantineFile =
    reusable?.candidate ??
    path.join(options.quarantinePath, quarantineArtifactName(options.kind, randomId));
  const stagePath = path.join(options.registryPath, `.${options.kind}-recovery.${randomId}.stage`);
  let quarantine: number | undefined;
  let stage: number | undefined;
  let current: number | undefined;
  let quarantineIdentity: PrivateFileIdentity | undefined;
  let stageIdentity: PrivateFileIdentity | undefined;
  let renamed = false;
  let failure: unknown;
  try {
    if (reusable === undefined) {
      quarantine = openSync(
        quarantineFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(quarantine, 0o600);
      quarantineIdentity = assertPrivateFile(fstatSync(quarantine, { bigint: true }));
      writeAll(quarantine, options.fragment);
      options.hooks?.beforeHistoryFileSync?.("quarantine", quarantineFile);
      fsyncSync(quarantine);
      exactFile(quarantineFile, quarantine, quarantineIdentity, options.fragment);
      syncPrivateDirectory(options.quarantinePath, options.hooks?.beforeHistoryDirectorySync);
      exactFile(quarantineFile, quarantine, quarantineIdentity, options.fragment);
      options.hooks?.afterQuarantinePublished?.(quarantineFile);
    } else {
      quarantine = openSync(quarantineFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      quarantineIdentity = assertPrivateFile(
        fstatSync(quarantine, { bigint: true }),
        reusable.identity,
      );
      exactFile(quarantineFile, quarantine, quarantineIdentity, options.fragment);
      fsyncSync(quarantine);
      syncPrivateDirectory(options.quarantinePath);
      exactFile(quarantineFile, quarantine, quarantineIdentity, options.fragment);
    }
    options.assertRegistryIdentity();
    try {
      assertStableQuarantineCandidates(options.quarantinePath, options.scans);
    } finally {
      options.assertRegistryIdentity();
    }
    exactFile(quarantineFile, quarantine, quarantineIdentity, options.fragment);

    stage = openSync(
      stagePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(stage, 0o600);
    stageIdentity = assertPrivateFile(fstatSync(stage, { bigint: true }));
    writeAll(stage, options.prefix);
    options.hooks?.beforeHistoryFileSync?.("recovery", stagePath);
    fsyncSync(stage);
    exactFile(stagePath, stage, stageIdentity, options.prefix);
    syncPrivateDirectory(options.registryPath, (directoryPath) => {
      options.hooks?.beforeRecoveryStageDirectorySync?.(options.kind, stagePath);
      options.hooks?.beforeHistoryDirectorySync?.(directoryPath);
    });
    exactFile(stagePath, stage, stageIdentity, options.prefix);
    current = openSync(options.candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    exactFile(options.candidate, current, options.expected.identity, options.expected.bytes);
    options.hooks?.beforeRecoveryRename?.(options.kind, stagePath, options.candidate);
    assertExactRecoveryStageCandidate({
      stageName: path.basename(stagePath),
      stageIdentity,
      stageSize: BigInt(options.prefix.byteLength),
      registryPath: options.registryPath,
      scans: options.scans,
    });
    options.assertRegistryIdentity();
    exactFile(quarantineFile, quarantine, quarantineIdentity, options.fragment);
    exactFile(options.candidate, current, options.expected.identity, options.expected.bytes);
    renameSync(stagePath, options.candidate);
    renamed = true;
    exactFile(options.candidate, stage, stageIdentity, options.prefix);
    options.hooks?.afterRecoveryRename?.(options.kind, options.candidate);
    assertRegistryCandidates(options.registryPath, options.scans, {
      allowMutationClaim: true,
      allowRecoveryStage: false,
    });
    syncPrivateDirectory(options.registryPath, options.hooks?.beforeHistoryDirectorySync);
    exactFile(options.candidate, stage, stageIdentity, options.prefix);
    options.assertRegistryIdentity();
    exactFile(quarantineFile, quarantine, quarantineIdentity, options.fragment);
  } catch (error) {
    failure = error;
  } finally {
    if (current !== undefined) closeSync(current);
    if (stage !== undefined) closeSync(stage);
    if (quarantine !== undefined) closeSync(quarantine);
  }
  if (failure !== undefined) {
    if (stageIdentity !== undefined && !renamed) {
      cleanupOwnedRecoveryStage(stagePath, options.registryPath, stageIdentity);
    }
    if (failure instanceof RuntimeAgentError) throw failure;
    registryCorrupt();
  }
}

function jsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: { readonly [key: string]: JsonValue },
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactReference(left: ArtifactReference, right: ArtifactReference): boolean {
  return (
    left.document_type === right.document_type &&
    left.artifact_id === right.artifact_id &&
    left.revision === right.revision &&
    left.hash === right.hash
  );
}

function referenceKey(candidate: ArtifactReference): string {
  return `${candidate.document_type}\u0000${candidate.artifact_id}\u0000${String(candidate.revision)}\u0000${candidate.hash}`;
}

function revisionKey(candidate: ArtifactReference): string {
  return `${candidate.artifact_id}\u0000${String(candidate.revision)}`;
}

function immutableReference(candidate: ArtifactReference): ArtifactReference {
  return Object.freeze({
    document_type: candidate.document_type,
    artifact_id: candidate.artifact_id,
    revision: candidate.revision,
    hash: candidate.hash,
  });
}

function immutableDefinitionReference(candidate: ArtifactReference): AgentDefinitionReference {
  if (candidate.document_type !== "agent-definition") registryCorrupt();
  return Object.freeze({
    document_type: "agent-definition",
    artifact_id: candidate.artifact_id,
    revision: candidate.revision,
    hash: candidate.hash,
  });
}

function immutablePromptReference(candidate: ArtifactReference): PromptTemplateReference {
  if (candidate.document_type !== "prompt-template") registryCorrupt();
  return Object.freeze({
    document_type: "prompt-template",
    artifact_id: candidate.artifact_id,
    revision: candidate.revision,
    hash: candidate.hash,
  });
}

function definitionReference(candidate: AgentDefinitionV1): AgentDefinitionReference {
  return Object.freeze({
    document_type: "agent-definition",
    artifact_id: candidate.agent_id,
    revision: candidate.revision,
    hash: candidate.document_hash,
  });
}

function promptReference(candidate: PromptTemplateV1): PromptTemplateReference {
  return Object.freeze({
    document_type: "prompt-template",
    artifact_id: candidate.template_id,
    revision: candidate.revision,
    hash: candidate.document_hash,
  });
}

function normalizeDefinitionReference(candidate: ArtifactReference): AgentDefinitionReference {
  try {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !Object.keys(candidate).every((key) =>
        ["document_type", "artifact_id", "revision", "hash", "location"].includes(key),
      ) ||
      candidate.document_type !== "agent-definition" ||
      typeof candidate.artifact_id !== "string" ||
      !IDENTIFIER_PATTERN.test(candidate.artifact_id) ||
      typeof candidate.revision !== "number" ||
      !Number.isSafeInteger(candidate.revision) ||
      candidate.revision < 1 ||
      typeof candidate.hash !== "string" ||
      !SHA256_PATTERN.test(candidate.hash) ||
      (candidate.location !== undefined && typeof candidate.location !== "string")
    ) {
      return agentError("RUNTIME_AGENT_NOT_FOUND");
    }
    return Object.freeze({
      document_type: "agent-definition",
      artifact_id: candidate.artifact_id,
      revision: candidate.revision,
      hash: candidate.hash,
    });
  } catch {
    return agentError("RUNTIME_AGENT_NOT_FOUND");
  }
}

function snapshotBundle(candidate: AgentDefinitionBundle): {
  readonly bundle: ResolvedAgentBundle;
  readonly definitionBytes: Uint8Array;
  readonly promptBytes: Uint8Array;
} {
  try {
    const parsedDefinition = parseAgentDefinition(
      Buffer.from(canonicalJson(candidate.definition as never), "utf8"),
    );
    const parsedPrompt = parsePromptTemplate(
      Buffer.from(canonicalJson(candidate.prompt_template as never), "utf8"),
    );
    if (!parsedDefinition.ok || !parsedPrompt.ok) definitionInvalid();
    const expectedPrompt = promptReference(parsedPrompt.value);
    if (!exactReference(parsedDefinition.value.prompt_template, expectedPrompt))
      definitionInvalid();
    const { document_hash: definitionHash, ...hashableDefinition } = parsedDefinition.value;
    const { document_hash: promptHash, ...hashablePrompt } = parsedPrompt.value;
    const definitionBytes = Buffer.from(canonicalJson(hashableDefinition as never), "utf8");
    const promptBytes = Buffer.from(canonicalJson(hashablePrompt as never), "utf8");
    if (sha256(hashableDefinition) !== definitionHash || sha256(hashablePrompt) !== promptHash) {
      definitionInvalid();
    }
    return {
      bundle: Object.freeze({
        definition: parsedDefinition.value,
        prompt_template: parsedPrompt.value,
      }),
      definitionBytes,
      promptBytes,
    };
  } catch (error) {
    if (error instanceof RuntimeAgentError) throw error;
    definitionInvalid();
  }
}

function registration(entry: AgentRegistryEntryV1): AgentRegistration {
  return Object.freeze({
    registry_revision: entry.registry_revision,
    definition: immutableReference(entry.definition),
    prompt_template: immutableReference(entry.prompt_template),
    state: entry.state,
    entry_hash: entry.entry_hash,
  });
}

function parseRegistration(value: JsonValue | undefined): AgentRegistration {
  if (
    !jsonObject(value) ||
    !exactKeys(value, [
      "registry_revision",
      "definition",
      "prompt_template",
      "state",
      "entry_hash",
    ]) ||
    typeof value.registry_revision !== "number" ||
    !Number.isSafeInteger(value.registry_revision) ||
    value.registry_revision < 1 ||
    !jsonObject(value.definition) ||
    !exactKeys(value.definition, ["document_type", "artifact_id", "revision", "hash"]) ||
    value.definition.document_type !== "agent-definition" ||
    typeof value.definition.artifact_id !== "string" ||
    !IDENTIFIER_PATTERN.test(value.definition.artifact_id) ||
    typeof value.definition.revision !== "number" ||
    !Number.isSafeInteger(value.definition.revision) ||
    value.definition.revision < 1 ||
    typeof value.definition.hash !== "string" ||
    !SHA256_PATTERN.test(value.definition.hash) ||
    !jsonObject(value.prompt_template) ||
    !exactKeys(value.prompt_template, ["document_type", "artifact_id", "revision", "hash"]) ||
    value.prompt_template.document_type !== "prompt-template" ||
    typeof value.prompt_template.artifact_id !== "string" ||
    !IDENTIFIER_PATTERN.test(value.prompt_template.artifact_id) ||
    typeof value.prompt_template.revision !== "number" ||
    !Number.isSafeInteger(value.prompt_template.revision) ||
    value.prompt_template.revision < 1 ||
    typeof value.prompt_template.hash !== "string" ||
    !SHA256_PATTERN.test(value.prompt_template.hash) ||
    (value.state !== "ACTIVE" && value.state !== "RETIRED") ||
    typeof value.entry_hash !== "string" ||
    !SHA256_PATTERN.test(value.entry_hash)
  ) {
    registryCorrupt();
  }
  return Object.freeze({
    registry_revision: value.registry_revision,
    definition: immutableReference(value.definition as unknown as ArtifactReference),
    prompt_template: immutableReference(value.prompt_template as unknown as ArtifactReference),
    state: value.state,
    entry_hash: value.entry_hash as `sha256:${string}`,
  });
}

function publishOperationHash(
  definition: ArtifactReference,
  promptTemplate: ArtifactReference,
): `sha256:${string}` {
  return sha256({
    command: "agent-publish",
    definition: immutableReference(definition),
    prompt_template: immutableReference(promptTemplate),
  });
}

function retireOperationHash(definition: ArtifactReference): `sha256:${string}` {
  return sha256({ command: "agent-retire", definition: immutableReference(definition) });
}

function parseOperationRecord(bytes: Uint8Array): AgentOperationRecordV1 {
  let value: JsonValue;
  try {
    value = parseJsonBytes(bytes, {
      maxBytes: MAX_OPERATION_RECORD_BYTES,
      maxDepth: 8,
      maxMembers: 64,
    });
  } catch {
    return registryCorrupt();
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
      "lifecycle_head_revision",
      "lifecycle_head_hash",
      "result",
      "operation_record_hash",
    ]) ||
    value.schema_version !== "agent-registry-operation.v1" ||
    value.document_type !== "agent-registry-operation" ||
    typeof value.operation_revision !== "number" ||
    !Number.isSafeInteger(value.operation_revision) ||
    value.operation_revision < 1 ||
    !(
      value.previous_operation_hash === null ||
      (typeof value.previous_operation_hash === "string" &&
        SHA256_PATTERN.test(value.previous_operation_hash))
    ) ||
    typeof value.operation_id !== "string" ||
    !UUID_PATTERN.test(value.operation_id) ||
    typeof value.operation_hash !== "string" ||
    !SHA256_PATTERN.test(value.operation_hash) ||
    typeof value.lifecycle_head_revision !== "number" ||
    !Number.isSafeInteger(value.lifecycle_head_revision) ||
    value.lifecycle_head_revision < 1 ||
    typeof value.lifecycle_head_hash !== "string" ||
    !SHA256_PATTERN.test(value.lifecycle_head_hash) ||
    typeof value.operation_record_hash !== "string" ||
    !SHA256_PATTERN.test(value.operation_record_hash)
  ) {
    return registryCorrupt();
  }
  const result = parseRegistration(value.result);
  const record = {
    schema_version: value.schema_version,
    document_type: value.document_type,
    operation_revision: value.operation_revision,
    previous_operation_hash: value.previous_operation_hash as `sha256:${string}` | null,
    operation_id: value.operation_id,
    operation_hash: value.operation_hash as `sha256:${string}`,
    lifecycle_head_revision: value.lifecycle_head_revision,
    lifecycle_head_hash: value.lifecycle_head_hash as `sha256:${string}`,
    result,
    operation_record_hash: value.operation_record_hash as `sha256:${string}`,
  } satisfies AgentOperationRecordV1;
  if (!Buffer.from(canonicalJson(record as never), "utf8").equals(Buffer.from(bytes))) {
    return registryCorrupt();
  }
  const { operation_record_hash: actual, ...hashable } = record;
  if (sha256(hashable) !== actual) return registryCorrupt();
  return Object.freeze(record);
}

function parseJsonl<T>(
  bytes: Uint8Array,
  parseLine: (line: Uint8Array) => T,
): {
  readonly records: readonly T[];
  readonly prefixLength: number;
  readonly fragment: Uint8Array;
} {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength === 0) registryCorrupt();
  const lastNewline = buffer.lastIndexOf(0x0a);
  const prefixLength = lastNewline < 0 ? 0 : lastNewline + 1;
  const records: T[] = [];
  let start = 0;
  for (let end = 0; end < prefixLength; end += 1) {
    if (buffer[end] !== 0x0a) continue;
    if (end === start) registryCorrupt();
    records.push(parseLine(buffer.subarray(start, end)));
    start = end + 1;
  }
  return {
    records: Object.freeze(records),
    prefixLength,
    fragment: Buffer.from(buffer.subarray(prefixLength)),
  };
}

function parseLifecycleLine(bytes: Uint8Array): AgentRegistryEntryV1 {
  const parsed = parseAgentRegistryEntry(bytes);
  if (!parsed.ok || !Buffer.from(canonicalJson(parsed.value as never), "utf8").equals(bytes)) {
    return registryCorrupt();
  }
  return parsed.value;
}

function entryFor(options: {
  readonly operationId: string;
  readonly operationHash: `sha256:${string}`;
  readonly definition: AgentDefinitionReference;
  readonly promptTemplate: PromptTemplateReference;
  readonly state: "ACTIVE" | "RETIRED";
  readonly entries: readonly AgentRegistryEntryV1[];
  readonly now: () => Date;
}): AgentRegistryEntryV1 {
  let occurredAt: string;
  try {
    const date = options.now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) definitionInvalid();
    occurredAt = date.toISOString();
  } catch (error) {
    if (error instanceof RuntimeAgentError) throw error;
    return definitionInvalid();
  }
  const previous = options.entries.at(-1);
  const hashable = {
    protocol_version: "runtime-contract.v1",
    schema_version: "agent-registry-entry.v1",
    document_type: "agent-registry-entry",
    registry_revision: options.entries.length + 1,
    previous_entry_hash: previous?.entry_hash ?? null,
    operation_id: options.operationId,
    operation_hash: options.operationHash,
    definition: immutableDefinitionReference(options.definition),
    prompt_template: immutablePromptReference(options.promptTemplate),
    state: options.state,
    occurred_at: occurredAt,
  } as const;
  return Object.freeze({ ...hashable, entry_hash: hashAgentRegistryEntry(hashable) });
}

function operationRecordFor(options: {
  readonly operationId: string;
  readonly operationHash: `sha256:${string}`;
  readonly result: AgentRegistration;
  readonly records: readonly AgentOperationRecordV1[];
  readonly entries: readonly AgentRegistryEntryV1[];
}): AgentOperationRecordV1 {
  const previous = options.records.at(-1);
  const head = options.entries.at(-1);
  if (head === undefined) registryCorrupt();
  const hashable = {
    schema_version: "agent-registry-operation.v1",
    document_type: "agent-registry-operation",
    operation_revision: options.records.length + 1,
    previous_operation_hash: previous?.operation_record_hash ?? null,
    operation_id: options.operationId,
    operation_hash: options.operationHash,
    lifecycle_head_revision: head.registry_revision,
    lifecycle_head_hash: head.entry_hash,
    result: options.result,
  } as const;
  return Object.freeze({ ...hashable, operation_record_hash: sha256(hashable) });
}

export function createAgentRegistry(options: CreateAgentRegistryOptions): AgentRegistry {
  return createAgentRegistryImplementation(options, {});
}

export function createAgentRegistryForTest(
  options: CreateAgentRegistryOptions,
  dependencies: unknown = {},
): AgentRegistry {
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    registryCorrupt();
  }
  return createAgentRegistryImplementation(options, dependencies);
}

function createAgentRegistryImplementation(
  options: CreateAgentRegistryOptions,
  dependencies: AgentRegistryInternalDependencies,
): AgentRegistry {
  if (typeof options.hasServiceListener !== "function") registryCorrupt();
  const statePath = canonicalStatePath(options.statePath);
  const storeOptions = {
    statePath,
    hasServiceListener: options.hasServiceListener,
    ...(dependencies.isProcessAlive === undefined
      ? {}
      : { isProcessAlive: dependencies.isProcessAlive }),
    ...(dependencies.isCurrentUser === undefined
      ? {}
      : { isCurrentUser: dependencies.isCurrentUser }),
    ...(dependencies.privateStoreOperationHooks === undefined
      ? {}
      : { operationHooks: dependencies.privateStoreOperationHooks }),
  };
  const store = createPrivateAgentStore(storeOptions);
  const lifecyclePath = path.join(store.registryPath, "entries.jsonl");
  const operationPath = path.join(store.registryPath, "operations.jsonl");
  const scans = Object.freeze({
    ...(dependencies.openCandidateDirectory === undefined
      ? {}
      : { openCandidateDirectory: dependencies.openCandidateDirectory }),
    limits: resolveCandidateLimits(dependencies.candidateLimits),
  });
  let contextPromise: Promise<RegistryContext> | undefined;
  let pinnedDirectories: readonly PinnedDirectory[] | undefined;
  const pendingMutations = new Set<Promise<unknown>>();
  let intakeStopped = false;

  const bindContext = (
    canonical: string,
    directories: readonly PinnedDirectory[],
  ): RegistryContext => {
    pinnedDirectories = directories;
    const stateIdentity = directories[0]?.identity;
    if (stateIdentity === undefined) registryCorrupt();
    const key = `${canonical}\u0000${String(stateIdentity.device)}:${String(stateIdentity.inode)}`;
    let shared = coordinators.get(key)?.deref();
    if (shared === undefined) {
      shared = { tail: Promise.resolve() };
      coordinators.set(key, new WeakRef(shared));
    }
    assertPinnedDirectories(directories);
    return Object.freeze({ shared, directories });
  };

  const context = (): Promise<RegistryContext> => {
    contextPromise ??= (async () => {
      await store.ensureRoots();
      const canonical = realpathSync(statePath);
      if (canonical !== statePath) pathUnsafe();
      return bindContext(
        canonical,
        pinPrivateDirectories([
          statePath,
          store.agentsPath,
          store.objectsPath,
          store.registryPath,
          store.quarantinePath,
        ]),
      );
    })();
    return contextPromise;
  };

  const existingContext = (): Promise<RegistryContext | null> => {
    if (contextPromise !== undefined) return contextPromise;
    return Promise.resolve().then(() => {
      if (contextPromise !== undefined) return contextPromise;
      try {
        lstatSync(statePath, { bigint: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        return pathUnsafe();
      }
      try {
        const canonical = realpathSync(statePath);
        if (canonical !== statePath) pathUnsafe();
        const bound = bindContext(
          canonical,
          pinPrivateDirectories([
            statePath,
            store.agentsPath,
            store.objectsPath,
            store.registryPath,
            store.quarantinePath,
          ]),
        );
        contextPromise = Promise.resolve(bound);
        return bound;
      } catch (error) {
        if (error instanceof RuntimeAgentError) throw error;
        return pathUnsafe();
      }
    });
  };

  const assertRegistryIdentity = (): void => {
    if (pinnedDirectories === undefined) registryCorrupt();
    assertPinnedDirectories(pinnedDirectories);
  };

  const schedule = <T>(shared: Coordinator, operation: () => Promise<T>): Promise<T> => {
    const current = shared.tail
      .catch(() => undefined)
      .then(async () => {
        assertRegistryIdentity();
        try {
          return await operation();
        } finally {
          assertRegistryIdentity();
        }
      });
    shared.tail = current;
    return current;
  };

  const enqueue = <T>(operation: () => Promise<T>, mutation: boolean): Promise<T> => {
    const scheduled = context().then(({ shared }) => schedule(shared, operation));
    if (mutation) {
      pendingMutations.add(scheduled);
      void scheduled.finally(() => pendingMutations.delete(scheduled)).catch(() => undefined);
    }
    return scheduled;
  };

  const enqueueExisting = <T>(operation: () => Promise<T>, absent: () => T): Promise<T> =>
    existingContext().then((existing) =>
      existing === null ? absent() : schedule(existing.shared, operation),
    );

  const withClaim = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertRegistryIdentity();
    const claim = await store.acquireMutationClaim();
    try {
      assertRegistryIdentity();
      const result = await operation();
      assertRegistryIdentity();
      await claim.release();
      assertRegistryIdentity();
      return result;
    } catch (error) {
      await claim.release().catch(() => undefined);
      assertRegistryIdentity();
      throw error;
    }
  };

  const readBundle = async (
    definition: ArtifactReference,
    promptTemplate: ArtifactReference,
    cache: Map<string, ResolvedAgentBundle>,
    nonCreatingObjectReads: boolean,
  ): Promise<ResolvedAgentBundle> => {
    const key = referenceKey(definition);
    const cached = cache.get(key);
    if (cached !== undefined) {
      if (!exactReference(cached.definition.prompt_template, promptTemplate)) registryCorrupt();
      return cached;
    }
    const [definitionObject, promptObject] = nonCreatingObjectReads
      ? [
          readExactPrivateFile({
            candidate: path.join(store.objectsPath, definition.hash.slice("sha256:".length)),
            parentPath: store.objectsPath,
            maximumBytes: MAX_PRIVATE_OBJECT_BYTES,
          }),
          readExactPrivateFile({
            candidate: path.join(store.objectsPath, promptTemplate.hash.slice("sha256:".length)),
            parentPath: store.objectsPath,
            maximumBytes: MAX_PRIVATE_OBJECT_BYTES,
          }),
        ]
      : await Promise.all([
          store.readObject(definition.hash),
          store.readObject(promptTemplate.hash),
        ]);
    if (definitionObject === null || promptObject === null) return registryCorrupt();
    let storedDefinition: JsonValue;
    let storedPrompt: JsonValue;
    try {
      storedDefinition = parseJsonBytes(definitionObject.bytes, AGENT_DOCUMENT_LIMITS);
      storedPrompt = parseJsonBytes(promptObject.bytes, AGENT_DOCUMENT_LIMITS);
    } catch {
      return registryCorrupt();
    }
    if (
      !jsonObject(storedDefinition) ||
      !jsonObject(storedPrompt) ||
      "document_hash" in storedDefinition ||
      "document_hash" in storedPrompt ||
      !Buffer.from(canonicalJson(storedDefinition), "utf8").equals(
        Buffer.from(definitionObject.bytes),
      ) ||
      !Buffer.from(canonicalJson(storedPrompt), "utf8").equals(Buffer.from(promptObject.bytes))
    ) {
      return registryCorrupt();
    }
    const parsedDefinition = parseAgentDefinition(
      Buffer.from(canonicalJson({ ...storedDefinition, document_hash: definition.hash }), "utf8"),
    );
    const parsedPrompt = parsePromptTemplate(
      Buffer.from(canonicalJson({ ...storedPrompt, document_hash: promptTemplate.hash }), "utf8"),
    );
    if (
      !parsedDefinition.ok ||
      !parsedPrompt.ok ||
      !exactReference(definitionReference(parsedDefinition.value), definition) ||
      !exactReference(promptReference(parsedPrompt.value), promptTemplate) ||
      !exactReference(parsedDefinition.value.prompt_template, promptTemplate)
    ) {
      return registryCorrupt();
    }
    const resolved = Object.freeze({
      definition: parsedDefinition.value,
      prompt_template: parsedPrompt.value,
    });
    cache.set(key, resolved);
    return resolved;
  };

  const validateLifecycle = async (
    entries: readonly AgentRegistryEntryV1[],
    nonCreatingObjectReads: boolean,
  ): Promise<{
    readonly active: ReadonlyMap<string, AgentRegistration>;
    readonly bundles: ReadonlyMap<string, ResolvedAgentBundle>;
    readonly revisionHashes: ReadonlyMap<string, `sha256:${string}`>;
    readonly promptRevisionHashes: ReadonlyMap<string, `sha256:${string}`>;
    readonly maximumRevisions: ReadonlyMap<string, number>;
    readonly operations: ReadonlyMap<string, OperationResult>;
  }> => {
    const active = new Map<string, AgentRegistration>();
    const bundles = new Map<string, ResolvedAgentBundle>();
    const revisionHashes = new Map<string, `sha256:${string}`>();
    const promptRevisionHashes = new Map<string, `sha256:${string}`>();
    const maximumRevisions = new Map<string, number>();
    const operations = new Map<string, OperationResult>();
    let previousHash: `sha256:${string}` | null = null;
    for (const [index, entry] of entries.entries()) {
      if (
        entry.registry_revision !== index + 1 ||
        entry.previous_entry_hash !== previousHash ||
        operations.has(entry.operation_id)
      ) {
        registryCorrupt();
      }
      const resolved = await readBundle(
        entry.definition,
        entry.prompt_template,
        bundles,
        nonCreatingObjectReads,
      );
      const agentId = resolved.definition.agent_id;
      if (entry.definition.artifact_id !== agentId) registryCorrupt();
      const result = registration(entry);
      if (entry.state === "ACTIVE") {
        const pair = revisionKey(entry.definition);
        if (revisionHashes.has(pair)) registryCorrupt();
        const maximum = maximumRevisions.get(agentId);
        if (maximum !== undefined && entry.definition.revision <= maximum) registryCorrupt();
        if (
          entry.operation_hash !== publishOperationHash(entry.definition, entry.prompt_template)
        ) {
          registryCorrupt();
        }
        revisionHashes.set(pair, entry.definition.hash);
        const promptPair = revisionKey(entry.prompt_template);
        const knownPromptHash = promptRevisionHashes.get(promptPair);
        if (knownPromptHash !== undefined && knownPromptHash !== entry.prompt_template.hash) {
          registryCorrupt();
        }
        promptRevisionHashes.set(promptPair, entry.prompt_template.hash);
        maximumRevisions.set(agentId, entry.definition.revision);
        active.set(agentId, result);
      } else {
        const current = active.get(agentId);
        if (
          current === undefined ||
          !exactReference(current.definition, entry.definition) ||
          !exactReference(current.prompt_template, entry.prompt_template) ||
          entry.operation_hash !== retireOperationHash(entry.definition)
        ) {
          registryCorrupt();
        }
        active.delete(agentId);
      }
      operations.set(
        entry.operation_id,
        Object.freeze({ operationHash: entry.operation_hash, result }),
      );
      previousHash = entry.entry_hash;
    }
    return {
      active,
      bundles,
      revisionHashes,
      promptRevisionHashes,
      maximumRevisions,
      operations,
    };
  };

  const validateOperationRecords = (
    records: readonly AgentOperationRecordV1[],
    entries: readonly AgentRegistryEntryV1[],
    base: ReadonlyMap<string, OperationResult>,
  ): ReadonlyMap<string, OperationResult> => {
    const operations = new Map(base);
    const activeAtHead = new Map<string, AgentRegistration>();
    let lifecycleIndex = 0;
    let previousHash: `sha256:${string}` | null = null;
    for (const [index, record] of records.entries()) {
      if (
        record.lifecycle_head_revision < lifecycleIndex ||
        record.lifecycle_head_revision > entries.length
      ) {
        registryCorrupt();
      }
      while (lifecycleIndex < record.lifecycle_head_revision) {
        const entry = entries[lifecycleIndex];
        if (entry === undefined) registryCorrupt();
        if (entry.state === "ACTIVE") {
          activeAtHead.set(entry.definition.artifact_id, registration(entry));
        } else {
          activeAtHead.delete(entry.definition.artifact_id);
        }
        lifecycleIndex += 1;
      }
      const head = entries[record.lifecycle_head_revision - 1];
      const active = activeAtHead.get(record.result.definition.artifact_id);
      if (
        record.operation_revision !== index + 1 ||
        record.previous_operation_hash !== previousHash ||
        operations.has(record.operation_id) ||
        record.result.state !== "ACTIVE" ||
        head === undefined ||
        head.entry_hash !== record.lifecycle_head_hash ||
        record.operation_hash !==
          publishOperationHash(record.result.definition, record.result.prompt_template) ||
        active === undefined ||
        canonicalJson(active) !== canonicalJson(record.result)
      ) {
        registryCorrupt();
      }
      operations.set(
        record.operation_id,
        Object.freeze({ operationHash: record.operation_hash, result: record.result }),
      );
      previousHash = record.operation_record_hash;
    }
    return operations;
  };

  const load = async (loadOptions: RegistryLoadOptions): Promise<RegistryHistory> => {
    assertRegistryIdentity();
    const recoveryStages = assertRegistryCandidates(store.registryPath, scans, loadOptions);
    const recoveryStage = recoveryStages[0];
    let recoveryStageConsumed = false;
    assertAgentCandidates(store.agentsPath, store.objectsPath, scans);
    assertQuarantineCandidates(store.quarantinePath, scans);
    let lifecycleFile = readHistoryFile(lifecyclePath, store.registryPath, scans, loadOptions);
    if (lifecycleFile === null) {
      if (
        recoveryStage !== undefined ||
        readHistoryFile(operationPath, store.registryPath, scans, loadOptions) !== null
      ) {
        registryCorrupt();
      }
      assertRegistryIdentity();
      return {
        lifecycleFile: null,
        operationFile: null,
        entries: Object.freeze([]),
        operationRecords: Object.freeze([]),
        active: new Map(),
        bundles: new Map(),
        revisionHashes: new Map(),
        promptRevisionHashes: new Map(),
        maximumRevisions: new Map(),
        operations: new Map(),
      };
    }

    let lifecycle = parseJsonl(lifecycleFile.bytes, parseLifecycleLine);
    if (lifecycle.fragment.byteLength > 0) {
      if (lifecycle.records.length === 0) registryCorrupt();
      await validateLifecycle(lifecycle.records, loadOptions.nonCreatingObjectReads);
      if (!loadOptions.recoverPartials) registryCorrupt();
      assertRegistryIdentity();
      if (recoveryStage !== undefined) {
        if (recoveryStage.kind !== "lifecycle") registryCorrupt();
        completeRecoveryStage({
          stage: recoveryStage,
          candidate: lifecyclePath,
          registryPath: store.registryPath,
          quarantinePath: store.quarantinePath,
          expected: lifecycleFile,
          prefix: lifecycleFile.bytes.subarray(0, lifecycle.prefixLength),
          fragment: lifecycle.fragment,
          scans,
          assertRegistryIdentity,
          ...(dependencies.operationHooks === undefined
            ? {}
            : { hooks: dependencies.operationHooks }),
        });
        recoveryStageConsumed = true;
      } else {
        recoverPartial({
          candidate: lifecyclePath,
          registryPath: store.registryPath,
          quarantinePath: store.quarantinePath,
          expected: lifecycleFile,
          prefix: lifecycleFile.bytes.subarray(0, lifecycle.prefixLength),
          fragment: lifecycle.fragment,
          kind: "lifecycle",
          randomId: options.randomId,
          scans,
          assertRegistryIdentity,
          ...(dependencies.operationHooks === undefined
            ? {}
            : { hooks: dependencies.operationHooks }),
        });
      }
      assertRegistryIdentity();
      lifecycleFile = readHistoryFile(lifecyclePath, store.registryPath, scans, loadOptions);
      if (lifecycleFile === null) registryCorrupt();
      lifecycle = parseJsonl(lifecycleFile.bytes, parseLifecycleLine);
      if (lifecycle.fragment.byteLength > 0) registryCorrupt();
    } else if (recoveryStage?.kind === "lifecycle") {
      registryCorrupt();
    }
    const lifecycleState = await validateLifecycle(
      lifecycle.records,
      loadOptions.nonCreatingObjectReads,
    );

    let operationFile = readHistoryFile(operationPath, store.registryPath, scans, loadOptions);
    let operationRecords: readonly AgentOperationRecordV1[] = Object.freeze([]);
    if (operationFile !== null) {
      let operationHistory = parseJsonl(operationFile.bytes, parseOperationRecord);
      if (operationHistory.fragment.byteLength > 0) {
        if (operationHistory.records.length === 0) registryCorrupt();
        validateOperationRecords(
          operationHistory.records,
          lifecycle.records,
          lifecycleState.operations,
        );
        if (!loadOptions.recoverPartials) registryCorrupt();
        assertRegistryIdentity();
        if (recoveryStage !== undefined && !recoveryStageConsumed) {
          if (recoveryStage.kind !== "operations") registryCorrupt();
          completeRecoveryStage({
            stage: recoveryStage,
            candidate: operationPath,
            registryPath: store.registryPath,
            quarantinePath: store.quarantinePath,
            expected: operationFile,
            prefix: operationFile.bytes.subarray(0, operationHistory.prefixLength),
            fragment: operationHistory.fragment,
            scans,
            assertRegistryIdentity,
            ...(dependencies.operationHooks === undefined
              ? {}
              : { hooks: dependencies.operationHooks }),
          });
          recoveryStageConsumed = true;
        } else {
          recoverPartial({
            candidate: operationPath,
            registryPath: store.registryPath,
            quarantinePath: store.quarantinePath,
            expected: operationFile,
            prefix: operationFile.bytes.subarray(0, operationHistory.prefixLength),
            fragment: operationHistory.fragment,
            kind: "operations",
            randomId: options.randomId,
            scans,
            assertRegistryIdentity,
            ...(dependencies.operationHooks === undefined
              ? {}
              : { hooks: dependencies.operationHooks }),
          });
        }
        assertRegistryIdentity();
        operationFile = readHistoryFile(operationPath, store.registryPath, scans, loadOptions);
        if (operationFile === null) registryCorrupt();
        operationHistory = parseJsonl(operationFile.bytes, parseOperationRecord);
        if (operationHistory.fragment.byteLength > 0) registryCorrupt();
      } else if (recoveryStage?.kind === "operations") {
        registryCorrupt();
      }
      operationRecords = operationHistory.records;
    } else if (recoveryStage?.kind === "operations") {
      registryCorrupt();
    }
    if (recoveryStage !== undefined && !recoveryStageConsumed) registryCorrupt();
    const operations = validateOperationRecords(
      operationRecords,
      lifecycle.records,
      lifecycleState.operations,
    );
    assertRegistryIdentity();
    return {
      lifecycleFile,
      operationFile,
      entries: lifecycle.records,
      operationRecords,
      active: lifecycleState.active,
      bundles: lifecycleState.bundles,
      revisionHashes: lifecycleState.revisionHashes,
      promptRevisionHashes: lifecycleState.promptRevisionHashes,
      maximumRevisions: lifecycleState.maximumRevisions,
      operations,
    };
  };

  const replay = (
    history: RegistryHistory,
    operationId: string,
    expectedHash: `sha256:${string}`,
  ): AgentRegistration | undefined => {
    const known = history.operations.get(operationId);
    if (known === undefined) return undefined;
    if (known.operationHash !== expectedHash) {
      return agentError("RUNTIME_AGENT_OPERATION_CONFLICT");
    }
    return known.result;
  };

  const readValidated = <T>(
    operation: (history: RegistryHistory) => Promise<T> | T,
    absent: () => T,
  ): Promise<T> => {
    const claimAcceptedBeforeStop = !intakeStopped;
    if (claimAcceptedBeforeStop) {
      return enqueue(
        () =>
          withClaim(async () =>
            operation(
              await load({
                recoverPartials: false,
                nonCreatingObjectReads: false,
                allowMutationClaim: true,
                allowRecoveryStage: false,
              }),
            ),
          ),
        true,
      );
    }
    return enqueueExisting(
      async () =>
        operation(
          await load({
            recoverPartials: false,
            nonCreatingObjectReads: true,
            allowMutationClaim: false,
            allowRecoveryStage: false,
          }),
        ),
      absent,
    );
  };

  const appendEntry = (history: RegistryHistory, entry: AgentRegistryEntryV1): void => {
    assertRegistryIdentity();
    appendHistoryFile({
      candidate: lifecyclePath,
      registryPath: store.registryPath,
      expected: history.lifecycleFile,
      bytes: Buffer.from(`${canonicalJson(entry as never)}\n`, "utf8"),
      kind: "lifecycle",
      scans,
      ...(dependencies.operationHooks === undefined ? {} : { hooks: dependencies.operationHooks }),
    });
    assertRegistryIdentity();
  };

  const appendOperation = (history: RegistryHistory, record: AgentOperationRecordV1): void => {
    assertRegistryIdentity();
    appendHistoryFile({
      candidate: operationPath,
      registryPath: store.registryPath,
      expected: history.operationFile,
      bytes: Buffer.from(`${canonicalJson(record as never)}\n`, "utf8"),
      kind: "operations",
      scans,
      ...(dependencies.operationHooks === undefined ? {} : { hooks: dependencies.operationHooks }),
    });
    assertRegistryIdentity();
  };

  return {
    recover: () => {
      if (intakeStopped) return Promise.reject(new RuntimeAgentError("RUNTIME_AGENT_NOT_FOUND"));
      return enqueue(
        () =>
          withClaim(
            async () =>
              void (await load({
                recoverPartials: true,
                nonCreatingObjectReads: false,
                allowMutationClaim: true,
                allowRecoveryStage: true,
              })),
          ),
        true,
      );
    },
    async publish(candidate, operationId) {
      if (intakeStopped) return Promise.reject(new RuntimeAgentError("RUNTIME_AGENT_NOT_FOUND"));
      const snapshot = snapshotBundle(candidate);
      const canonicalOperationId = canonicalUuid(operationId, "RUNTIME_AGENT_DEFINITION_INVALID");
      const definitionRef = definitionReference(snapshot.bundle.definition);
      const promptRef = promptReference(snapshot.bundle.prompt_template);
      const operationHash = publishOperationHash(definitionRef, promptRef);
      return enqueue(
        () =>
          withClaim(async () => {
            const history = await load({
              recoverPartials: false,
              nonCreatingObjectReads: false,
              allowMutationClaim: true,
              allowRecoveryStage: false,
            });
            const replayed = replay(history, canonicalOperationId, operationHash);
            if (replayed !== undefined) return replayed;
            const active = history.active.get(snapshot.bundle.definition.agent_id);
            if (
              active !== undefined &&
              exactReference(active.definition, definitionRef) &&
              exactReference(active.prompt_template, promptRef)
            ) {
              const record = operationRecordFor({
                operationId: canonicalOperationId,
                operationHash,
                result: active,
                records: history.operationRecords,
                entries: history.entries,
              });
              appendOperation(history, record);
              return active;
            }

            const pair = revisionKey(definitionRef);
            const knownHash = history.revisionHashes.get(pair);
            if (knownHash !== undefined) {
              if (knownHash !== definitionRef.hash) definitionInvalid();
              return agentError("RUNTIME_AGENT_STALE_REVISION");
            }
            const maximumRevision = history.maximumRevisions.get(
              snapshot.bundle.definition.agent_id,
            );
            if (maximumRevision !== undefined && definitionRef.revision <= maximumRevision) {
              definitionInvalid();
            }
            const knownPromptHash = history.promptRevisionHashes.get(revisionKey(promptRef));
            if (knownPromptHash !== undefined && knownPromptHash !== promptRef.hash) {
              definitionInvalid();
            }

            await store.publishObject(promptRef.hash, snapshot.promptBytes);
            await store.publishObject(definitionRef.hash, snapshot.definitionBytes);
            assertRegistryIdentity();
            await dependencies.operationHooks?.afterObjectsPublished?.();
            assertRegistryIdentity();
            const entry = entryFor({
              operationId: canonicalOperationId,
              operationHash,
              definition: definitionRef,
              promptTemplate: promptRef,
              state: "ACTIVE",
              entries: history.entries,
              now: options.now,
            });
            appendEntry(history, entry);
            return registration(entry);
          }),
        true,
      );
    },
    async retire(candidate, operationId) {
      if (intakeStopped) return Promise.reject(new RuntimeAgentError("RUNTIME_AGENT_NOT_FOUND"));
      const definitionRef = normalizeDefinitionReference(candidate);
      const canonicalOperationId = canonicalUuid(operationId, "RUNTIME_AGENT_DEFINITION_INVALID");
      const operationHash = retireOperationHash(definitionRef);
      return enqueue(
        () =>
          withClaim(async () => {
            const history = await load({
              recoverPartials: false,
              nonCreatingObjectReads: false,
              allowMutationClaim: true,
              allowRecoveryStage: false,
            });
            const replayed = replay(history, canonicalOperationId, operationHash);
            if (replayed !== undefined) return replayed;
            const resolved = history.bundles.get(referenceKey(definitionRef));
            if (resolved === undefined) return agentError("RUNTIME_AGENT_NOT_FOUND");
            const active = history.active.get(definitionRef.artifact_id);
            if (active === undefined || !exactReference(active.definition, definitionRef)) {
              return agentError("RUNTIME_AGENT_STALE_REVISION");
            }
            const entry = entryFor({
              operationId: canonicalOperationId,
              operationHash,
              definition: definitionRef,
              promptTemplate: immutablePromptReference(active.prompt_template),
              state: "RETIRED",
              entries: history.entries,
              now: options.now,
            });
            appendEntry(history, entry);
            return registration(entry);
          }),
        true,
      );
    },
    async resolveForExecution(candidate) {
      const definitionRef = normalizeDefinitionReference(candidate);
      return readValidated(
        (history) => {
          const resolved = history.bundles.get(referenceKey(definitionRef));
          if (resolved === undefined) return agentError("RUNTIME_AGENT_NOT_FOUND");
          const active = history.active.get(definitionRef.artifact_id);
          if (active === undefined || !exactReference(active.definition, definitionRef)) {
            return agentError("RUNTIME_AGENT_STALE_REVISION");
          }
          return resolved;
        },
        () => agentError("RUNTIME_AGENT_NOT_FOUND"),
      );
    },
    async resolveForResume(candidate) {
      const definitionRef = normalizeDefinitionReference(candidate);
      return readValidated(
        (history) => {
          const resolved = history.bundles.get(referenceKey(definitionRef));
          if (resolved === undefined) return agentError("RUNTIME_AGENT_NOT_FOUND");
          return resolved;
        },
        () => agentError("RUNTIME_AGENT_NOT_FOUND"),
      );
    },
    list: () =>
      readValidated(
        (history) =>
          Object.freeze(
            [...history.active.values()].sort((left, right) =>
              Buffer.from(
                `${left.definition.artifact_id}\u0000${String(left.definition.revision)}`,
                "utf8",
              ).compare(
                Buffer.from(
                  `${right.definition.artifact_id}\u0000${String(right.definition.revision)}`,
                  "utf8",
                ),
              ),
            ),
          ),
        () => Object.freeze([]),
      ),
    stopIntake() {
      intakeStopped = true;
    },
    async flush(signal) {
      if (signal.aborted || pendingMutations.size === 0) return;
      let listener: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        listener = resolve;
        signal.addEventListener("abort", listener, { once: true });
      });
      try {
        await Promise.race([
          Promise.allSettled([...pendingMutations]).then(() => undefined),
          aborted,
        ]);
      } finally {
        if (listener !== undefined) signal.removeEventListener("abort", listener);
      }
    },
  };
}
