import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
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

import type { RunJournalStore } from "../journal/store.js";
import type { JournalHead } from "../journal/types.js";
import { canonicalJson, deepFreezeJson, sha256, type JsonValue } from "../protocol/json.js";
import type { TraceContext } from "../protocol/types.js";
import type {
  SkillCatalog,
  SkillCatalogSnapshot,
  SkillDiscoveryRequest,
  SkillSelection,
  SkillSelectionRequest,
} from "./catalog.js";
import type { SkillContext, SkillContextRequest } from "./context.js";
import { parseSkillSnapshot, parseSuperpowersPhase } from "./contracts.js";
import { RuntimeSkillError } from "./errors.js";
import type { SkillLoader } from "./loader.js";
import {
  BUILTIN_SUPERPOWERS_POLICY,
  builtInSuperpowersHandler,
  requiredBuiltInPhasePredecessors,
  type BuiltInSuperpowersCapability,
} from "./phases.js";
import {
  SKILL_LIMITS,
  type SkillSnapshotV1,
  type SuperpowersApprovalV1,
  type SuperpowersPhaseName,
  type SuperpowersPhaseV1,
} from "./types.js";

export const ZERO_PHASE_HASH = `sha256:${"0".repeat(64)}` as const;

const MAX_PHASE_HISTORY_BYTES = 64 * 1024 * 1024;
const MAX_PHASE_HISTORY_FILES = 4_096;
const MAX_QUARANTINE_BYTES = MAX_PHASE_HISTORY_BYTES * 2;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HISTORY_NAME_PATTERN = /^([A-Za-z][A-Za-z0-9._:-]{0,127})\.jsonl$/u;
const HISTORY_STAGE_PATTERN = /^\.phase-(?:create|recovery)\.[0-9a-f-]{36}\.stage$/u;
const QUARANTINE_STAGE_PATTERN = /^\.phase-quarantine\.[0-9a-f-]{36}\.stage$/u;
const QUARANTINE_NAME_PATTERN = /^phase-history-[0-9a-f]{64}-(0|[1-9][0-9]*)\.bin$/u;

type CurrentUserCheck = (userId: bigint, candidate: string) => boolean;

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface OpenedDirectory {
  readonly candidate: string;
  readonly descriptor: number;
  readonly identity: FileIdentity;
  readonly exactPrivate: boolean;
}

interface HistoryFileSnapshot {
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
}

interface LoadedHistory {
  readonly entries: readonly SuperpowersPhaseV1[];
  readonly file: HistoryFileSnapshot | null;
}

interface ParsedHistory {
  readonly entries: readonly SuperpowersPhaseV1[];
  readonly validPrefixLength: number;
  readonly fragment: Uint8Array;
}

interface PhaseCoordinator {
  queue: Promise<unknown>;
}

const COORDINATORS = new Map<string, PhaseCoordinator>();

export interface PhaseHistoryOperationHooks {
  readonly beforeAppendWrite?: (historyPath: string) => void | Promise<void>;
  readonly beforeHistoryFileSync?: (historyPath: string) => void | Promise<void>;
  readonly beforeHistoryDirectorySync?: (directoryPath: string) => void | Promise<void>;
  readonly beforeCreatePublication?: (
    stagePath: string,
    historyPath: string,
  ) => void | Promise<void>;
  readonly afterCreatePublication?: (
    stagePath: string,
    historyPath: string,
  ) => void | Promise<void>;
  readonly afterQuarantinePublished?: (quarantinePath: string) => void | Promise<void>;
  readonly beforeRecoveryRename?: (stagePath: string, historyPath: string) => void | Promise<void>;
}

export interface StartSuperpowersPhaseRequest {
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly execution_request_hash: `sha256:${string}`;
  readonly selection: SkillSelection;
  readonly phase: SuperpowersPhaseName;
  readonly input: Uint8Array;
  readonly operation_id: string;
  readonly trace: TraceContext;
}

export interface CompleteSuperpowersPhaseRequest {
  readonly run_id: string;
  readonly expected_phase_revision: number;
  readonly expected_phase_head_hash: `sha256:${string}`;
  readonly phase: SuperpowersPhaseName;
  readonly skill_snapshot_hash: `sha256:${string}`;
  readonly operation_id: string;
  readonly outcome: "COMPLETED" | "FAILED" | "BLOCKED";
  readonly output: Uint8Array;
  readonly trace: TraceContext;
}

export interface SuperpowersPhaseOutcome {
  readonly state: "RUNNING" | "APPROVAL_PENDING" | "BLOCKED";
  readonly phase: SuperpowersPhaseV1;
  readonly journal_head: JournalHead;
  readonly approval: SuperpowersApprovalV1 | null;
  readonly replayed: boolean;
}

export interface BrainstormingApprovalHandoffRequest {
  readonly started: SuperpowersPhaseV1;
  readonly completion: CompleteSuperpowersPhaseRequest;
  readonly output_hash: `sha256:${string}`;
}

export type BrainstormingApprovalHandoff = (
  request: BrainstormingApprovalHandoffRequest,
) => Promise<SuperpowersPhaseOutcome>;

export interface CreateSkillsEngineOptions {
  readonly statePath: string;
  readonly journal: RunJournalStore;
  readonly catalog: SkillCatalog;
  readonly loader: SkillLoader;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly brainstormingApprovalHandoff?: BrainstormingApprovalHandoff | undefined;
}

export interface CreateSkillsEngineForTestOptions extends CreateSkillsEngineOptions {
  readonly historyHooks?: PhaseHistoryOperationHooks | undefined;
  readonly isCurrentUser?: CurrentUserCheck | undefined;
}

export interface SkillsEngine {
  recover(): Promise<void>;
  discover(request: SkillDiscoveryRequest): Promise<SkillCatalogSnapshot>;
  select(snapshot: SkillCatalogSnapshot, request: SkillSelectionRequest): Promise<SkillSelection>;
  load(selection: SkillSelection): Promise<SkillSnapshotV1>;
  assembleContext(selection: SkillSelection, request: SkillContextRequest): Promise<SkillContext>;
  startPhase(request: StartSuperpowersPhaseRequest): Promise<SuperpowersPhaseOutcome>;
  completePhase(request: CompleteSuperpowersPhaseRequest): Promise<SuperpowersPhaseOutcome>;
  phaseHistory(runId: string): Promise<readonly SuperpowersPhaseV1[]>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}

function integrity(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY");
}

function pathUnsafe(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_PATH_UNSAFE");
}

function stale(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_STALE_STATE");
}

function conflict(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_OPERATION_CONFLICT");
}

function unavailable(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE");
}

function invalid(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_INVALID");
}

function limitExceeded(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_LIMIT_EXCEEDED");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function defaultCurrentUser(userId: bigint): boolean {
  return typeof process.getuid !== "function" || BigInt(process.getuid()) === userId;
}

function identity(metadata: Pick<BigIntStats, "dev" | "ino">): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function identitiesMatch(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function rawHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function exactJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function assertIdentifier(value: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) invalid();
}

function assertHash(value: string): asserts value is `sha256:${string}` {
  if (!HASH_PATTERN.test(value)) invalid();
}

function validateAbsolutePath(candidate: string): void {
  if (
    !path.isAbsolute(candidate) ||
    candidate === path.parse(candidate).root ||
    path.normalize(candidate) !== candidate ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    pathUnsafe();
  }
  const parsed = path.parse(candidate);
  if (
    candidate
      .slice(parsed.root.length)
      .split(path.sep)
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    pathUnsafe();
  }
}

function directoryCandidates(candidate: string): readonly string[] {
  validateAbsolutePath(candidate);
  const parsed = path.parse(candidate);
  let current = parsed.root;
  return candidate
    .slice(parsed.root.length)
    .split(path.sep)
    .map((segment) => {
      current = path.join(current, segment);
      return current;
    });
}

function isAtOrBelow(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assertDirectory(
  metadata: BigIntStats,
  candidate: string,
  statePath: string,
  isCurrentUser: CurrentUserCheck,
  reachedCurrentUser: boolean,
): boolean {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) pathUnsafe();
  const mode = Number(metadata.mode & 0o7777n);
  const owned = isCurrentUser(metadata.uid, candidate);
  if (isAtOrBelow(candidate, statePath)) {
    if (!owned || (mode & 0o777) !== 0o700) pathUnsafe();
    return true;
  }
  if (owned) {
    if ((mode & 0o022) !== 0 && !((mode & 0o1000) !== 0 && metadata.uid === 0n)) {
      pathUnsafe();
    }
    return true;
  }
  if (
    reachedCurrentUser ||
    metadata.uid !== 0n ||
    ((mode & 0o022) !== 0 && (mode & 0o1000) === 0)
  ) {
    pathUnsafe();
  }
  return false;
}

function openDirectoryChain(
  candidate: string,
  statePath: string,
  isCurrentUser: CurrentUserCheck,
): readonly OpenedDirectory[] {
  const opened: OpenedDirectory[] = [];
  let reachedCurrentUser = false;
  try {
    for (const current of directoryCandidates(candidate)) {
      const before = lstatSync(current, { bigint: true });
      const nextReached = assertDirectory(
        before,
        current,
        statePath,
        isCurrentUser,
        reachedCurrentUser,
      );
      const descriptor = openSync(
        current,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const held = fstatSync(descriptor, { bigint: true });
      assertDirectory(held, current, statePath, isCurrentUser, reachedCurrentUser);
      if (!identitiesMatch(identity(before), identity(held))) pathUnsafe();
      opened.push({
        candidate: current,
        descriptor,
        identity: identity(held),
        exactPrivate: isAtOrBelow(current, statePath),
      });
      reachedCurrentUser = nextReached || reachedCurrentUser;
    }
    return opened;
  } catch (error) {
    for (const directory of opened.reverse()) closeSync(directory.descriptor);
    if (error instanceof RuntimeSkillError) throw error;
    pathUnsafe();
  }
}

function closeDirectoryChain(opened: readonly OpenedDirectory[]): void {
  for (const directory of [...opened].reverse()) closeSync(directory.descriptor);
}

function revalidateDirectoryChain(
  opened: readonly OpenedDirectory[],
  statePath: string,
  isCurrentUser: CurrentUserCheck,
): void {
  let reachedCurrentUser = false;
  for (const directory of opened) {
    const named = lstatSync(directory.candidate, { bigint: true });
    const held = fstatSync(directory.descriptor, { bigint: true });
    const nextReached = assertDirectory(
      named,
      directory.candidate,
      statePath,
      isCurrentUser,
      reachedCurrentUser,
    );
    assertDirectory(held, directory.candidate, statePath, isCurrentUser, reachedCurrentUser);
    if (
      !identitiesMatch(directory.identity, identity(named)) ||
      !identitiesMatch(directory.identity, identity(held))
    ) {
      pathUnsafe();
    }
    reachedCurrentUser = nextReached || reachedCurrentUser;
  }
}

function syncDirectoryChain(
  opened: readonly OpenedDirectory[],
  statePath: string,
  isCurrentUser: CurrentUserCheck,
): void {
  revalidateDirectoryChain(opened, statePath, isCurrentUser);
  for (const directory of [...opened].reverse()) fsyncSync(directory.descriptor);
  revalidateDirectoryChain(opened, statePath, isCurrentUser);
}

function ensurePrivateDirectory(
  candidate: string,
  statePath: string,
  isCurrentUser: CurrentUserCheck,
): void {
  let reachedCurrentUser = false;
  for (const current of directoryCandidates(candidate)) {
    let metadata: BigIntStats;
    try {
      metadata = lstatSync(current, { bigint: true });
    } catch (error) {
      if (!isMissing(error)) pathUnsafe();
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isExisting(mkdirError)) pathUnsafe();
      }
      metadata = lstatSync(current, { bigint: true });
      const parent = path.dirname(current);
      const parentChain = openDirectoryChain(parent, statePath, isCurrentUser);
      try {
        syncDirectoryChain(parentChain, statePath, isCurrentUser);
      } finally {
        closeDirectoryChain(parentChain);
      }
    }
    reachedCurrentUser =
      assertDirectory(metadata, current, statePath, isCurrentUser, reachedCurrentUser) ||
      reachedCurrentUser;
  }
}

function privateDirectoryExists(
  candidate: string,
  statePath: string,
  isCurrentUser: CurrentUserCheck,
): boolean {
  let reachedCurrentUser = false;
  for (const current of directoryCandidates(candidate)) {
    let metadata: BigIntStats;
    try {
      metadata = lstatSync(current, { bigint: true });
    } catch (error) {
      if (isMissing(error)) return false;
      pathUnsafe();
    }
    reachedCurrentUser =
      assertDirectory(metadata, current, statePath, isCurrentUser, reachedCurrentUser) ||
      reachedCurrentUser;
  }
  return true;
}

function assertPrivateFile(
  metadata: BigIntStats,
  candidate: string,
  isCurrentUser: CurrentUserCheck,
  allowedLinks: 1 | 2 = 1,
): void {
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !isCurrentUser(metadata.uid, candidate) ||
    Number(metadata.mode & 0o777n) !== 0o600 ||
    metadata.nlink !== BigInt(allowedLinks)
  ) {
    pathUnsafe();
  }
}

function readAll(descriptor: number, bytes: number): Uint8Array {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_PHASE_HISTORY_BYTES) {
    limitExceeded();
  }
  const result = Buffer.allocUnsafe(bytes);
  let offset = 0;
  while (offset < result.byteLength) {
    const count = readSync(descriptor, result, offset, result.byteLength - offset, offset);
    if (count === 0) integrity();
    offset += count;
  }
  return result;
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (count <= 0) integrity();
    offset += count;
  }
}

function exactFile(
  candidate: string,
  descriptor: number,
  expectedIdentity: FileIdentity,
  expectedBytes: Uint8Array,
  isCurrentUser: CurrentUserCheck,
  links: 1 | 2 = 1,
): void {
  const named = lstatSync(candidate, { bigint: true });
  const held = fstatSync(descriptor, { bigint: true });
  assertPrivateFile(named, candidate, isCurrentUser, links);
  assertPrivateFile(held, candidate, isCurrentUser, links);
  if (
    !identitiesMatch(expectedIdentity, identity(named)) ||
    !identitiesMatch(expectedIdentity, identity(held)) ||
    held.size !== BigInt(expectedBytes.byteLength)
  ) {
    pathUnsafe();
  }
  const observed = readAll(descriptor, expectedBytes.byteLength);
  if (!Buffer.from(observed).equals(Buffer.from(expectedBytes))) integrity();
}

function requireMissing(candidate: string): void {
  try {
    lstatSync(candidate, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    pathUnsafe();
  }
  pathUnsafe();
}

function historyLine(entry: SuperpowersPhaseV1): Uint8Array {
  return Buffer.from(`${canonicalJson(entry as unknown as JsonValue)}\n`, "utf8");
}

function handlerMatches(entry: SuperpowersPhaseV1): boolean {
  const handler = builtInSuperpowersHandler(entry.phase);
  return entry.handler.version === handler.version && entry.handler.hash === handler.hash;
}

function phaseBelongsToSkill(skillName: string, phase: SuperpowersPhaseName): boolean {
  const phases = BUILTIN_SUPERPOWERS_POLICY[skillName as BuiltInSuperpowersCapability];
  return phases !== undefined && phases.includes(phase);
}

function samePhaseBinding(left: SuperpowersPhaseV1, right: SuperpowersPhaseV1): boolean {
  return (
    left.run_id === right.run_id &&
    left.execution_request_hash === right.execution_request_hash &&
    exactJson(left.observed_journal_head, right.observed_journal_head) &&
    exactJson(left.skill, right.skill) &&
    left.phase === right.phase &&
    exactJson(left.handler, right.handler) &&
    left.operation_id === right.operation_id &&
    left.input_hash === right.input_hash
  );
}

function validateHistory(runId: string, entries: readonly SuperpowersPhaseV1[]): void {
  let unmatched: SuperpowersPhaseV1 | null = null;
  const seenOperations = new Set<string>();
  let executionRequestHash: `sha256:${string}` | undefined;
  for (const [index, entry] of entries.entries()) {
    const previous = entries[index - 1];
    if (
      entry.run_id !== runId ||
      entry.phase_revision !== index + 1 ||
      entry.previous_phase_hash !== (previous?.document_hash ?? ZERO_PHASE_HASH) ||
      !phaseBelongsToSkill(entry.skill.name, entry.phase)
    ) {
      integrity();
    }
    if (!handlerMatches(entry)) stale();
    if (executionRequestHash === undefined) executionRequestHash = entry.execution_request_hash;
    else if (executionRequestHash !== entry.execution_request_hash) integrity();

    if (entry.status === "STARTED") {
      if (
        entry.output_hash !== null ||
        unmatched !== null ||
        seenOperations.has(entry.operation_id)
      ) {
        integrity();
      }
      seenOperations.add(entry.operation_id);
      unmatched = entry;
      continue;
    }
    if (entry.status === "APPROVAL_PENDING") {
      if (
        unmatched === null ||
        unmatched.phase !== "BRAINSTORMING" ||
        !samePhaseBinding(unmatched, entry) ||
        entry.output_hash !== null
      ) {
        integrity();
      }
      continue;
    }
    if (unmatched === null || !samePhaseBinding(unmatched, entry)) integrity();
    unmatched = null;
  }
}

function parseHistory(runId: string, bytes: Uint8Array): ParsedHistory {
  if (bytes.byteLength === 0) integrity();
  const buffer = Buffer.from(bytes);
  const finalNewline = buffer.lastIndexOf(0x0a);
  const validPrefixLength = finalNewline < 0 ? 0 : finalNewline + 1;
  const complete = buffer.subarray(0, validPrefixLength);
  const fragment = Buffer.from(buffer.subarray(validPrefixLength));
  const entries: SuperpowersPhaseV1[] = [];
  let start = 0;
  for (let end = 0; end < complete.byteLength; end += 1) {
    if (complete[end] !== 0x0a) continue;
    const line = complete.subarray(start, end);
    const parsed = parseSuperpowersPhase(line);
    if (!parsed.ok || canonicalJson(parsed.value) !== line.toString("utf8")) {
      integrity();
    }
    entries.push(
      deepFreezeJson(parsed.value as unknown as JsonValue) as unknown as SuperpowersPhaseV1,
    );
    start = end + 1;
  }
  validateHistory(runId, entries);
  return { entries: Object.freeze(entries), validPrefixLength, fragment };
}

function phaseOutcome(phase: SuperpowersPhaseV1, replayed: boolean): SuperpowersPhaseOutcome {
  const state =
    phase.status === "APPROVAL_PENDING"
      ? "APPROVAL_PENDING"
      : phase.status === "FAILED" || phase.status === "BLOCKED"
        ? "BLOCKED"
        : "RUNNING";
  return Object.freeze({
    state,
    phase,
    journal_head: Object.freeze({ ...phase.observed_journal_head }),
    approval: null,
    replayed,
  });
}

function record(value: Omit<SuperpowersPhaseV1, "document_hash">): SuperpowersPhaseV1 {
  const withHash = {
    ...value,
    document_hash: sha256(value),
  } as SuperpowersPhaseV1;
  const parsed = parseSuperpowersPhase(canonicalJson(withHash));
  if (!parsed.ok) invalid();
  return deepFreezeJson(parsed.value as unknown as JsonValue) as unknown as SuperpowersPhaseV1;
}

function exactJournalHead(left: JournalHead, right: JournalHead): boolean {
  return (
    left.journal_revision === right.journal_revision &&
    left.sequence === right.sequence &&
    left.entry_hash === right.entry_hash
  );
}

function copyTrace(trace: TraceContext): TraceContext {
  return Object.freeze({
    trace_id: trace.trace_id,
    span_id: trace.span_id,
    trace_flags: trace.trace_flags,
    ...(trace.trace_state === undefined ? {} : { trace_state: trace.trace_state }),
  });
}

function latestOperation(
  entries: readonly SuperpowersPhaseV1[],
  operationId: string,
): readonly SuperpowersPhaseV1[] {
  return entries.filter((entry) => entry.operation_id === operationId);
}

function latestUnmatchedStart(entries: readonly SuperpowersPhaseV1[]): SuperpowersPhaseV1 | null {
  let unmatched: SuperpowersPhaseV1 | null = null;
  for (const entry of entries) {
    if (entry.status === "STARTED") unmatched = entry;
    else if (entry.status !== "APPROVAL_PENDING") unmatched = null;
  }
  return unmatched;
}

function completedEvidence(
  entries: readonly SuperpowersPhaseV1[],
  phase: SuperpowersPhaseName,
): readonly SuperpowersPhaseV1[] {
  return entries.filter((entry) => entry.phase === phase && entry.status === "COMPLETED");
}

function enforcePredecessors(
  entries: readonly SuperpowersPhaseV1[],
  phase: SuperpowersPhaseName,
  snapshot: SkillSnapshotV1,
): void {
  if (latestUnmatchedStart(entries) !== null) stale();
  const requested = entries
    .filter((entry) => entry.status === "STARTED")
    .map((entry) => entry.phase);
  for (const predecessor of requiredBuiltInPhasePredecessors(phase, requested)) {
    const evidence = completedEvidence(entries, predecessor);
    const exactTddEvidence =
      (phase === "RED" && predecessor === "TEST_DESIGN") ||
      (phase === "GREEN" && predecessor === "RED");
    if (
      !evidence.some(
        (entry) =>
          !exactTddEvidence ||
          (entry.skill.name === snapshot.descriptor.name &&
            entry.skill.version === snapshot.descriptor.version &&
            entry.skill.snapshot_hash === snapshot.document_hash),
      )
    ) {
      stale();
    }
  }
}

function validateLoadedSnapshot(selection: SkillSelection, snapshot: SkillSnapshotV1): void {
  const parsed = parseSkillSnapshot(canonicalJson(snapshot));
  if (
    !parsed.ok ||
    parsed.value.document_hash !== snapshot.document_hash ||
    snapshot.descriptor.document_hash !== selection.descriptor.document_hash ||
    snapshot.descriptor.package_hash !== selection.descriptor.package_hash ||
    snapshot.package_hash !== selection.descriptor.package_hash
  ) {
    integrity();
  }
}

function createEngine(options: CreateSkillsEngineForTestOptions): SkillsEngine {
  validateAbsolutePath(options.statePath);
  const statePath = options.statePath;
  const skillsPath = path.join(statePath, "skills");
  const phasesPath = path.join(skillsPath, "phases");
  const quarantinePath = path.join(phasesPath, "quarantine");
  const isCurrentUser = options.isCurrentUser ?? defaultCurrentUser;
  const hooks = options.historyHooks;
  const coordinatorKey = path.resolve(statePath);
  const pending = new Set<Promise<unknown>>();
  let intakeStopped = false;

  const coordinator = (): PhaseCoordinator => {
    let shared = COORDINATORS.get(coordinatorKey);
    if (shared === undefined) {
      shared = { queue: Promise.resolve() };
      COORDINATORS.set(coordinatorKey, shared);
    }
    return shared;
  };

  const ensureRoots = (): void => {
    ensurePrivateDirectory(statePath, statePath, isCurrentUser);
    ensurePrivateDirectory(skillsPath, statePath, isCurrentUser);
    ensurePrivateDirectory(phasesPath, statePath, isCurrentUser);
    ensurePrivateDirectory(quarantinePath, statePath, isCurrentUser);
    const actual = realpathSync(statePath);
    if (actual !== statePath) pathUnsafe();
  };

  const historyPath = (runId: string): string => {
    assertIdentifier(runId);
    return path.join(phasesPath, `${runId}.jsonl`);
  };

  const invokeHook = async (
    hook: (() => void | Promise<void>) | undefined,
    directories: readonly OpenedDirectory[],
  ): Promise<void> => {
    if (hook === undefined) return;
    revalidateDirectoryChain(directories, statePath, isCurrentUser);
    await hook();
    revalidateDirectoryChain(directories, statePath, isCurrentUser);
  };

  const readExactFile = (
    candidate: string,
    parentDirectories: readonly OpenedDirectory[],
    maxBytes: number,
  ): HistoryFileSnapshot => {
    const before = lstatSync(candidate, { bigint: true });
    assertPrivateFile(before, candidate, isCurrentUser);
    if (before.size > BigInt(maxBytes)) limitExceeded();
    const descriptor = openSync(
      candidate,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const held = fstatSync(descriptor, { bigint: true });
      assertPrivateFile(held, candidate, isCurrentUser);
      if (!identitiesMatch(identity(before), identity(held)) || held.size > BigInt(maxBytes)) {
        pathUnsafe();
      }
      const bytes = readAll(descriptor, Number(held.size));
      exactFile(candidate, descriptor, identity(held), bytes, isCurrentUser);
      revalidateDirectoryChain(parentDirectories, statePath, isCurrentUser);
      return { bytes, identity: identity(held) };
    } finally {
      closeSync(descriptor);
    }
  };

  const unlinkOwnedStage = (
    candidate: string,
    allowedFinals: ReadonlyMap<string, FileIdentity>,
    directories: readonly OpenedDirectory[],
  ): void => {
    const descriptor = openSync(
      candidate,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const held = fstatSync(descriptor, { bigint: true });
      const links = held.nlink === 1n ? 1 : held.nlink === 2n ? 2 : pathUnsafe();
      assertPrivateFile(held, candidate, isCurrentUser, links);
      if (held.size > BigInt(MAX_PHASE_HISTORY_BYTES)) limitExceeded();
      const bytes = readAll(descriptor, Number(held.size));
      exactFile(candidate, descriptor, identity(held), bytes, isCurrentUser, links);
      if (links === 2) {
        const matches = [...allowedFinals.entries()].filter(([, finalIdentity]) =>
          identitiesMatch(finalIdentity, identity(held)),
        );
        if (matches.length !== 1) pathUnsafe();
        const final = matches[0]![0];
        const finalDescriptor = openSync(
          final,
          constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
        try {
          exactFile(final, finalDescriptor, identity(held), bytes, isCurrentUser, 2);
        } finally {
          closeSync(finalDescriptor);
        }
      }
      revalidateDirectoryChain(directories, statePath, isCurrentUser);
      exactFile(candidate, descriptor, identity(held), bytes, isCurrentUser, links);
      unlinkSync(candidate);
      requireMissing(candidate);
      revalidateDirectoryChain(directories, statePath, isCurrentUser);
    } finally {
      closeSync(descriptor);
    }
  };

  const scanNames = (candidate: string, maximum: number): readonly string[] => {
    const opened = opendirSync(candidate);
    const names: string[] = [];
    try {
      for (;;) {
        const entry = opened.readSync();
        if (entry === null) break;
        names.push(entry.name);
        if (names.length > maximum) limitExceeded();
      }
    } finally {
      opened.closeSync();
    }
    return names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  };

  const cleanupStages = (): void => {
    const phaseDirectories = openDirectoryChain(phasesPath, statePath, isCurrentUser);
    const quarantineDirectories = openDirectoryChain(quarantinePath, statePath, isCurrentUser);
    try {
      const phaseNames = scanNames(phasesPath, MAX_PHASE_HISTORY_FILES * 2 + 1);
      const finalIdentities = new Map<string, FileIdentity>();
      for (const name of phaseNames) {
        if (name === "quarantine" || HISTORY_STAGE_PATTERN.test(name)) continue;
        const match = HISTORY_NAME_PATTERN.exec(name);
        if (match?.[1] === undefined) pathUnsafe();
        const candidate = path.join(phasesPath, name);
        const metadata = lstatSync(candidate, { bigint: true });
        const links = metadata.nlink === 1n ? 1 : metadata.nlink === 2n ? 2 : pathUnsafe();
        assertPrivateFile(metadata, candidate, isCurrentUser, links);
        finalIdentities.set(candidate, identity(metadata));
      }
      for (const name of phaseNames.filter((entry) => HISTORY_STAGE_PATTERN.test(entry))) {
        unlinkOwnedStage(path.join(phasesPath, name), finalIdentities, phaseDirectories);
      }

      const quarantineNames = scanNames(quarantinePath, MAX_PHASE_HISTORY_FILES);
      const quarantineFinals = new Map<string, FileIdentity>();
      let aggregateBytes = 0n;
      for (const name of quarantineNames) {
        if (QUARANTINE_STAGE_PATTERN.test(name)) continue;
        const match = QUARANTINE_NAME_PATTERN.exec(name);
        if (match?.[1] === undefined) pathUnsafe();
        const candidate = path.join(quarantinePath, name);
        const metadata = lstatSync(candidate, { bigint: true });
        const links = metadata.nlink === 1n ? 1 : metadata.nlink === 2n ? 2 : pathUnsafe();
        assertPrivateFile(metadata, candidate, isCurrentUser, links);
        aggregateBytes += metadata.size;
        if (aggregateBytes > BigInt(MAX_QUARANTINE_BYTES)) limitExceeded();
        quarantineFinals.set(candidate, identity(metadata));
      }
      for (const name of quarantineNames.filter((entry) => QUARANTINE_STAGE_PATTERN.test(entry))) {
        unlinkOwnedStage(path.join(quarantinePath, name), quarantineFinals, quarantineDirectories);
      }
      syncDirectoryChain(phaseDirectories, statePath, isCurrentUser);
      syncDirectoryChain(quarantineDirectories, statePath, isCurrentUser);
    } finally {
      closeDirectoryChain(quarantineDirectories);
      closeDirectoryChain(phaseDirectories);
    }
  };

  const publishStaged = async (
    directoryPath: string,
    stagePrefix: "create" | "quarantine",
    finalPath: string,
    bytes: Uint8Array,
    beforePublication?: (stagePath: string, finalPath: string) => void | Promise<void>,
    afterPublication?: (stagePath: string, finalPath: string) => void | Promise<void>,
  ): Promise<"created" | "existing"> => {
    const randomId = options.randomId();
    if (!UUID_PATTERN.test(randomId)) pathUnsafe();
    const stageName =
      stagePrefix === "create"
        ? `.phase-create.${randomId}.stage`
        : `.phase-quarantine.${randomId}.stage`;
    const stagePath = path.join(directoryPath, stageName);
    const directories = openDirectoryChain(directoryPath, statePath, isCurrentUser);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        stagePath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_RDWR |
          constants.O_NONBLOCK |
          constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(descriptor, 0o600);
      const held = fstatSync(descriptor, { bigint: true });
      assertPrivateFile(held, stagePath, isCurrentUser);
      const stageIdentity = identity(held);
      writeAll(descriptor, bytes);
      await invokeHook(
        hooks?.beforeHistoryFileSync === undefined
          ? undefined
          : () => hooks.beforeHistoryFileSync!(finalPath),
        directories,
      );
      fsyncSync(descriptor);
      exactFile(stagePath, descriptor, stageIdentity, bytes, isCurrentUser);
      await invokeHook(
        beforePublication === undefined ? undefined : () => beforePublication(stagePath, finalPath),
        directories,
      );
      try {
        linkSync(stagePath, finalPath);
      } catch (error) {
        if (!isExisting(error)) throw error;
        exactFile(stagePath, descriptor, stageIdentity, bytes, isCurrentUser);
        unlinkSync(stagePath);
        await invokeHook(
          hooks?.beforeHistoryDirectorySync === undefined
            ? undefined
            : () => hooks.beforeHistoryDirectorySync!(directoryPath),
          directories,
        );
        syncDirectoryChain(directories, statePath, isCurrentUser);
        return "existing";
      }
      exactFile(stagePath, descriptor, stageIdentity, bytes, isCurrentUser, 2);
      const finalDescriptor = openSync(
        finalPath,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      try {
        exactFile(finalPath, finalDescriptor, stageIdentity, bytes, isCurrentUser, 2);
      } finally {
        closeSync(finalDescriptor);
      }
      await invokeHook(
        afterPublication === undefined ? undefined : () => afterPublication(stagePath, finalPath),
        directories,
      );
      exactFile(stagePath, descriptor, stageIdentity, bytes, isCurrentUser, 2);
      unlinkSync(stagePath);
      requireMissing(stagePath);
      await invokeHook(
        hooks?.beforeHistoryDirectorySync === undefined
          ? undefined
          : () => hooks.beforeHistoryDirectorySync!(directoryPath),
        directories,
      );
      syncDirectoryChain(directories, statePath, isCurrentUser);
      exactFile(finalPath, descriptor, stageIdentity, bytes, isCurrentUser);
      return "created";
    } catch (error) {
      if (error instanceof RuntimeSkillError) throw error;
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      closeDirectoryChain(directories);
    }
  };

  const quarantineFragment = async (runId: string, fragment: Uint8Array): Promise<void> => {
    const digest = createHash("sha256")
      .update(runId, "utf8")
      .update(Buffer.from([0]))
      .update(fragment)
      .digest("hex");
    const candidate = path.join(
      quarantinePath,
      `phase-history-${digest}-${fragment.byteLength}.bin`,
    );
    try {
      const directories = openDirectoryChain(quarantinePath, statePath, isCurrentUser);
      try {
        const existing = readExactFile(candidate, directories, MAX_PHASE_HISTORY_BYTES);
        if (!Buffer.from(existing.bytes).equals(Buffer.from(fragment))) integrity();
      } finally {
        closeDirectoryChain(directories);
      }
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const directories = openDirectoryChain(quarantinePath, statePath, isCurrentUser);
    try {
      const names = scanNames(quarantinePath, MAX_PHASE_HISTORY_FILES);
      let count = 0;
      let aggregateBytes = 0n;
      for (const name of names) {
        if (QUARANTINE_STAGE_PATTERN.test(name)) continue;
        const match = QUARANTINE_NAME_PATTERN.exec(name);
        if (match?.[1] === undefined) pathUnsafe();
        const declaredBytes = Number(match[1]);
        if (!Number.isSafeInteger(declaredBytes)) pathUnsafe();
        const existing = path.join(quarantinePath, name);
        const metadata = lstatSync(existing, { bigint: true });
        assertPrivateFile(metadata, existing, isCurrentUser);
        if (metadata.size !== BigInt(declaredBytes)) integrity();
        count += 1;
        aggregateBytes += metadata.size;
      }
      if (
        count >= MAX_PHASE_HISTORY_FILES ||
        aggregateBytes + BigInt(fragment.byteLength) > BigInt(MAX_QUARANTINE_BYTES)
      ) {
        limitExceeded();
      }
      revalidateDirectoryChain(directories, statePath, isCurrentUser);
    } finally {
      closeDirectoryChain(directories);
    }
    const publication = await publishStaged(quarantinePath, "quarantine", candidate, fragment);
    if (publication === "existing") {
      const directories = openDirectoryChain(quarantinePath, statePath, isCurrentUser);
      try {
        const existing = readExactFile(candidate, directories, MAX_PHASE_HISTORY_BYTES);
        if (!Buffer.from(existing.bytes).equals(Buffer.from(fragment))) integrity();
      } finally {
        closeDirectoryChain(directories);
      }
    }
    await hooks?.afterQuarantinePublished?.(candidate);
  };

  const recoverPartial = async (
    runId: string,
    expected: HistoryFileSnapshot,
    validPrefix: Uint8Array,
    fragment: Uint8Array,
  ): Promise<void> => {
    if (validPrefix.byteLength === 0 || fragment.byteLength === 0) integrity();
    await quarantineFragment(runId, fragment);
    const randomId = options.randomId();
    if (!UUID_PATTERN.test(randomId)) pathUnsafe();
    const stagePath = path.join(phasesPath, `.phase-recovery.${randomId}.stage`);
    const finalPath = historyPath(runId);
    const directories = openDirectoryChain(phasesPath, statePath, isCurrentUser);
    let stage: number | undefined;
    let current: number | undefined;
    try {
      stage = openSync(
        stagePath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_RDWR |
          constants.O_NONBLOCK |
          constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(stage, 0o600);
      const stageMetadata = fstatSync(stage, { bigint: true });
      assertPrivateFile(stageMetadata, stagePath, isCurrentUser);
      const stageIdentity = identity(stageMetadata);
      writeAll(stage, validPrefix);
      await invokeHook(
        hooks?.beforeHistoryFileSync === undefined
          ? undefined
          : () => hooks.beforeHistoryFileSync!(finalPath),
        directories,
      );
      fsyncSync(stage);
      exactFile(stagePath, stage, stageIdentity, validPrefix, isCurrentUser);
      await invokeHook(
        hooks?.beforeRecoveryRename === undefined
          ? undefined
          : () => hooks.beforeRecoveryRename!(stagePath, finalPath),
        directories,
      );
      current = openSync(
        finalPath,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      const expectedBytes = Buffer.concat([Buffer.from(validPrefix), Buffer.from(fragment)]);
      exactFile(finalPath, current, expected.identity, expectedBytes, isCurrentUser);
      exactFile(stagePath, stage, stageIdentity, validPrefix, isCurrentUser);
      revalidateDirectoryChain(directories, statePath, isCurrentUser);
      renameSync(stagePath, finalPath);
      requireMissing(stagePath);
      exactFile(finalPath, stage, stageIdentity, validPrefix, isCurrentUser);
      await invokeHook(
        hooks?.beforeHistoryDirectorySync === undefined
          ? undefined
          : () => hooks.beforeHistoryDirectorySync!(phasesPath),
        directories,
      );
      syncDirectoryChain(directories, statePath, isCurrentUser);
      exactFile(finalPath, stage, stageIdentity, validPrefix, isCurrentUser);
    } finally {
      if (current !== undefined) closeSync(current);
      if (stage !== undefined) closeSync(stage);
      closeDirectoryChain(directories);
    }
  };

  const loadExisting = async (runId: string): Promise<LoadedHistory> => {
    const candidate = historyPath(runId);
    if (!privateDirectoryExists(phasesPath, statePath, isCurrentUser)) {
      return { entries: Object.freeze([]), file: null };
    }
    const directories = openDirectoryChain(phasesPath, statePath, isCurrentUser);
    try {
      let file: HistoryFileSnapshot;
      try {
        file = readExactFile(candidate, directories, MAX_PHASE_HISTORY_BYTES);
      } catch (error) {
        if (isMissing(error)) return { entries: Object.freeze([]), file: null };
        throw error;
      }
      let parsed = parseHistory(runId, file.bytes);
      if (parsed.fragment.byteLength > 0) {
        if (parsed.entries.length === 0) integrity();
        await recoverPartial(
          runId,
          file,
          file.bytes.subarray(0, parsed.validPrefixLength),
          parsed.fragment,
        );
        file = readExactFile(candidate, directories, MAX_PHASE_HISTORY_BYTES);
        parsed = parseHistory(runId, file.bytes);
        if (parsed.fragment.byteLength > 0) integrity();
      }
      return { entries: parsed.entries, file };
    } finally {
      closeDirectoryChain(directories);
    }
  };

  const createHistory = async (
    runId: string,
    bytes: Uint8Array,
  ): Promise<"created" | "existing"> => {
    ensureRoots();
    return publishStaged(
      phasesPath,
      "create",
      historyPath(runId),
      bytes,
      hooks?.beforeCreatePublication,
      hooks?.afterCreatePublication,
    );
  };

  const appendHistory = async (
    runId: string,
    expected: HistoryFileSnapshot,
    bytes: Uint8Array,
  ): Promise<void> => {
    if (expected.bytes.byteLength + bytes.byteLength > MAX_PHASE_HISTORY_BYTES) limitExceeded();
    const candidate = historyPath(runId);
    const directories = openDirectoryChain(phasesPath, statePath, isCurrentUser);
    let descriptor: number | undefined;
    try {
      const before = lstatSync(candidate, { bigint: true });
      assertPrivateFile(before, candidate, isCurrentUser);
      if (!identitiesMatch(expected.identity, identity(before))) stale();
      descriptor = openSync(
        candidate,
        constants.O_APPEND | constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      const held = fstatSync(descriptor, { bigint: true });
      assertPrivateFile(held, candidate, isCurrentUser);
      if (
        !identitiesMatch(expected.identity, identity(held)) ||
        held.size !== BigInt(expected.bytes.byteLength)
      ) {
        stale();
      }
      exactFile(candidate, descriptor, expected.identity, expected.bytes, isCurrentUser);
      await invokeHook(
        hooks?.beforeAppendWrite === undefined
          ? undefined
          : () => hooks.beforeAppendWrite!(candidate),
        directories,
      );
      exactFile(candidate, descriptor, expected.identity, expected.bytes, isCurrentUser);
      writeAll(descriptor, bytes);
      await invokeHook(
        hooks?.beforeHistoryFileSync === undefined
          ? undefined
          : () => hooks.beforeHistoryFileSync!(candidate),
        directories,
      );
      fsyncSync(descriptor);
      const combined = Buffer.concat([Buffer.from(expected.bytes), Buffer.from(bytes)]);
      exactFile(candidate, descriptor, expected.identity, combined, isCurrentUser);
      await invokeHook(
        hooks?.beforeHistoryDirectorySync === undefined
          ? undefined
          : () => hooks.beforeHistoryDirectorySync!(phasesPath),
        directories,
      );
      syncDirectoryChain(directories, statePath, isCurrentUser);
      exactFile(candidate, descriptor, expected.identity, combined, isCurrentUser);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      closeDirectoryChain(directories);
    }
  };

  const appendRecord = async (
    runId: string,
    loaded: LoadedHistory,
    entry: SuperpowersPhaseV1,
  ): Promise<void> => {
    const line = historyLine(entry);
    if (loaded.file === null) {
      const publication = await createHistory(runId, line);
      if (publication === "existing") stale();
      return;
    }
    await appendHistory(runId, loaded.file, line);
  };

  const schedule = <T>(operation: () => Promise<T>): Promise<T> => {
    const shared = coordinator();
    const scheduled = shared.queue.catch(() => undefined).then(operation);
    shared.queue = scheduled;
    return scheduled;
  };

  const accept = <T>(operation: () => Promise<T>): Promise<T> => {
    if (intakeStopped) return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE"));
    const accepted = Promise.resolve().then(operation);
    pending.add(accepted);
    void accepted.finally(() => pending.delete(accepted)).catch(() => undefined);
    return accepted;
  };

  const exactSnapshotForReplay = async (
    selection: SkillSelection,
    expectedHash: `sha256:${string}`,
  ): Promise<void> => {
    const snapshot = await options.loader.load(selection);
    validateLoadedSnapshot(selection, snapshot);
    if (snapshot.document_hash !== expectedHash) conflict();
  };

  const startInternal = async (
    request: StartSuperpowersPhaseRequest,
    input: Uint8Array,
    inputHash: `sha256:${string}`,
  ): Promise<SuperpowersPhaseOutcome> => {
    assertIdentifier(request.run_id);
    assertIdentifier(request.operation_id);
    assertHash(request.execution_request_hash);
    assertHash(request.expected_journal_head.entry_hash);
    if (!phaseBelongsToSkill(request.selection.descriptor.name, request.phase)) integrity();
    const handler = builtInSuperpowersHandler(request.phase);
    let loaded = await loadExisting(request.run_id);
    const replay = latestOperation(loaded.entries, request.operation_id);
    if (replay.length > 0) {
      const started = replay[0]!;
      if (
        started.status !== "STARTED" ||
        started.execution_request_hash !== request.execution_request_hash ||
        !exactJournalHead(started.observed_journal_head, request.expected_journal_head) ||
        started.skill.name !== request.selection.descriptor.name ||
        started.skill.version !== request.selection.descriptor.version ||
        started.phase !== request.phase ||
        started.handler.version !== handler.version ||
        started.handler.hash !== handler.hash ||
        started.input_hash !== inputHash ||
        !exactJson(started.trace, request.trace)
      ) {
        conflict();
      }
      await exactSnapshotForReplay(request.selection, started.skill.snapshot_hash);
      return phaseOutcome(replay.at(-1)!, true);
    }

    const journal = await options.journal.load(request.run_id);
    if (
      journal === null ||
      journal.state !== "RUNNING" ||
      !exactJournalHead(journal.head, request.expected_journal_head)
    ) {
      stale();
    }
    const snapshot = await options.loader.load(request.selection);
    validateLoadedSnapshot(request.selection, snapshot);
    enforcePredecessors(loaded.entries, request.phase, snapshot);
    const contextBytes = SKILL_LIMITS.phaseInputBytes - input.byteLength;
    await options.loader.assembleContext(request.selection, {
      snapshot,
      snapshot_hash: snapshot.document_hash,
      phase: request.phase,
      max_bytes: contextBytes,
      max_tokens: Math.ceil(contextBytes / 4),
    });
    const currentJournal = await options.journal.load(request.run_id);
    if (
      currentJournal === null ||
      currentJournal.state !== "RUNNING" ||
      !exactJournalHead(currentJournal.head, request.expected_journal_head)
    ) {
      stale();
    }
    loaded = await loadExisting(request.run_id);
    if (latestOperation(loaded.entries, request.operation_id).length > 0) conflict();
    enforcePredecessors(loaded.entries, request.phase, snapshot);
    const latest = loaded.entries.at(-1);
    const started = record({
      protocol_version: "runtime-contract.v1",
      schema_version: "superpowers-phase.v1",
      document_type: "superpowers-phase",
      run_id: request.run_id,
      phase_revision: (latest?.phase_revision ?? 0) + 1,
      previous_phase_hash: latest?.document_hash ?? ZERO_PHASE_HASH,
      execution_request_hash: request.execution_request_hash,
      observed_journal_head: Object.freeze({ ...request.expected_journal_head }),
      skill: Object.freeze({
        name: snapshot.descriptor.name,
        version: snapshot.descriptor.version,
        snapshot_hash: snapshot.document_hash,
      }),
      phase: request.phase,
      handler: Object.freeze({ version: handler.version, hash: handler.hash }),
      operation_id: request.operation_id,
      status: "STARTED",
      input_hash: inputHash,
      output_hash: null,
      occurred_at: options.now().toISOString(),
      trace: copyTrace(request.trace),
    });
    await appendRecord(request.run_id, loaded, started);
    return phaseOutcome(started, false);
  };

  const completeInternal = async (
    request: CompleteSuperpowersPhaseRequest,
    output: Uint8Array,
    outputHash: `sha256:${string}`,
  ): Promise<SuperpowersPhaseOutcome> => {
    assertIdentifier(request.run_id);
    assertIdentifier(request.operation_id);
    assertHash(request.expected_phase_head_hash);
    assertHash(request.skill_snapshot_hash);
    const loaded = await loadExisting(request.run_id);
    const operation = latestOperation(loaded.entries, request.operation_id);
    const started = operation[0];
    if (started === undefined || started.status !== "STARTED") stale();
    const terminal = operation.find(
      (entry) => entry.status !== "STARTED" && entry.status !== "APPROVAL_PENDING",
    );
    if (terminal !== undefined) {
      const expectedOutput = request.outcome === "COMPLETED" ? outputHash : null;
      if (
        request.expected_phase_revision !== started.phase_revision ||
        request.expected_phase_head_hash !== started.document_hash ||
        request.phase !== terminal.phase ||
        request.skill_snapshot_hash !== terminal.skill.snapshot_hash ||
        request.outcome !== terminal.status ||
        expectedOutput !== terminal.output_hash ||
        !exactJson(request.trace, terminal.trace)
      ) {
        conflict();
      }
      return phaseOutcome(terminal, true);
    }
    if (
      request.expected_phase_revision !== started.phase_revision ||
      request.expected_phase_head_hash !== started.document_hash ||
      request.phase !== started.phase ||
      request.skill_snapshot_hash !== started.skill.snapshot_hash ||
      loaded.entries.at(-1)?.document_hash !== started.document_hash
    ) {
      stale();
    }
    const handler = builtInSuperpowersHandler(started.phase);
    if (started.handler.version !== handler.version || started.handler.hash !== handler.hash)
      stale();
    const journal = await options.journal.load(request.run_id);
    if (
      journal === null ||
      journal.state !== "RUNNING" ||
      !exactJournalHead(journal.head, started.observed_journal_head)
    ) {
      stale();
    }
    if (request.phase === "BRAINSTORMING" && request.outcome === "COMPLETED") {
      if (options.brainstormingApprovalHandoff === undefined) unavailable();
      return options.brainstormingApprovalHandoff({
        started,
        completion: Object.freeze({ ...request, output: Buffer.from(output) }),
        output_hash: outputHash,
      });
    }
    const latest = loaded.entries.at(-1)!;
    const completed = record({
      protocol_version: "runtime-contract.v1",
      schema_version: "superpowers-phase.v1",
      document_type: "superpowers-phase",
      run_id: started.run_id,
      phase_revision: latest.phase_revision + 1,
      previous_phase_hash: latest.document_hash,
      execution_request_hash: started.execution_request_hash,
      observed_journal_head: started.observed_journal_head,
      skill: started.skill,
      phase: started.phase,
      handler: started.handler,
      operation_id: started.operation_id,
      status: request.outcome,
      input_hash: started.input_hash,
      output_hash: request.outcome === "COMPLETED" ? outputHash : null,
      occurred_at: options.now().toISOString(),
      trace: copyTrace(request.trace),
    });
    await appendRecord(request.run_id, loaded, completed);
    return phaseOutcome(completed, false);
  };

  return {
    recover() {
      return accept(() =>
        schedule(async () => {
          ensureRoots();
          cleanupStages();
          const names = scanNames(phasesPath, MAX_PHASE_HISTORY_FILES * 2 + 1);
          const runIds: string[] = [];
          for (const name of names) {
            if (name === "quarantine" || HISTORY_STAGE_PATTERN.test(name)) continue;
            const match = HISTORY_NAME_PATTERN.exec(name);
            if (match?.[1] === undefined) pathUnsafe();
            runIds.push(match[1]);
          }
          for (const runId of runIds) await loadExisting(runId);
        }),
      );
    },
    discover(request) {
      return accept(() => options.catalog.discover(request));
    },
    select(snapshot, request) {
      return accept(() => Promise.resolve(options.catalog.select(snapshot, request)));
    },
    load(selection) {
      return accept(() => options.loader.load(selection));
    },
    assembleContext(selection, request) {
      return accept(() => options.loader.assembleContext(selection, request));
    },
    startPhase(request) {
      if (intakeStopped) return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE"));
      if (!(request.input instanceof Uint8Array))
        return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_INVALID"));
      if (request.input.byteLength > SKILL_LIMITS.phaseInputBytes) {
        return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_LIMIT_EXCEEDED"));
      }
      const input = Buffer.from(request.input);
      const inputHash = rawHash(input);
      return accept(() => schedule(() => startInternal(request, input, inputHash)));
    },
    completePhase(request) {
      if (intakeStopped) return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE"));
      if (!(request.output instanceof Uint8Array))
        return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_INVALID"));
      if (request.output.byteLength > SKILL_LIMITS.phaseOutputBytes) {
        return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_LIMIT_EXCEEDED"));
      }
      if (request.outcome !== "COMPLETED" && request.output.byteLength !== 0) {
        return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_INVALID"));
      }
      const output = Buffer.from(request.output);
      const outputHash = rawHash(output);
      return accept(() => schedule(() => completeInternal(request, output, outputHash)));
    },
    phaseHistory(runId) {
      return accept(() => schedule(async () => (await loadExisting(runId)).entries));
    },
    stopIntake() {
      intakeStopped = true;
    },
    async flush(signal) {
      while (!signal.aborted && pending.size > 0) {
        let listener: (() => void) | undefined;
        const aborted = new Promise<void>((resolve) => {
          listener = () => resolve();
          signal.addEventListener("abort", listener, { once: true });
        });
        try {
          await Promise.race([Promise.allSettled([...pending]).then(() => undefined), aborted]);
        } finally {
          if (listener !== undefined) signal.removeEventListener("abort", listener);
        }
      }
    },
  };
}

export function createSkillsEngineForTest(options: CreateSkillsEngineForTestOptions): SkillsEngine {
  return createEngine(options);
}

export function createSkillsEngine(options: CreateSkillsEngineOptions): SkillsEngine {
  return createEngine(options);
}

export const createSkillsHostEngine = createSkillsEngine;
