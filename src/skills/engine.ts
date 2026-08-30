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

import { RuntimeJournalError } from "../journal/errors.js";
import {
  hasOfficialRunJournalBarrier,
  withRunJournalBarrier,
  type RunJournalSnapshot,
  type RunJournalStore,
  type TransitionResult,
} from "../journal/store.js";
import type { TransitionCommand } from "../journal/state-machine.js";
import type { JournalHead, RunJournalEntryV1 } from "../journal/types.js";
import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonValue,
} from "../protocol/json.js";
import type { TraceContext } from "../protocol/types.js";
import {
  approvalDecision,
  approvalDecisionCommand,
  approvalRequest,
  approvalTerminalPhase,
  captureResumeSuperpowersApprovalRequest,
  decisionMetadata,
  decisionOutcome,
  pendingMetadata,
  pendingOutcome,
  requestSuperpowersApproval,
  approvalPendingCommand,
  type ApprovalDecisionJournalMetadata,
  type ApprovalPendingJournalMetadata,
  type ResumeSuperpowersApprovalRequest,
} from "./approval.js";
import type {
  SkillCatalog,
  SkillCatalogSnapshot,
  SkillDiscoveryRequest,
  SkillSelection,
  SkillSelectionRequest,
} from "./catalog.js";
import type { SkillContext, SkillContextRequest } from "./context.js";
import { parseSkillDescriptor, parseSkillSnapshot, parseSuperpowersPhase } from "./contracts.js";
import { RuntimeSkillError } from "./errors.js";
import type { SkillLoader } from "./loader.js";
import {
  builtInPhaseContextBudget,
  builtInSuperpowersHandler,
  requiredBuiltInPhasePredecessors,
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
const HISTORY_STAGE_PATTERN =
  /^\.phase-(?:create|recovery)\.([A-Za-z][A-Za-z0-9._:-]{0,127})\.([0-9a-f-]{36})\.stage$/u;
const QUARANTINE_STAGE_PATTERN =
  /^\.phase-quarantine\.([A-Za-z][A-Za-z0-9._:-]{0,127})\.([0-9a-f-]{36})\.stage$/u;
const QUARANTINE_NAME_PATTERN = /^phase-history-[0-9a-f]{64}-(0|[1-9][0-9]*)\.bin$/u;
const MUTATION_LOCK_PATTERN = /^\.phase-mutation-([0-9a-f]{64})\.lock$/u;
const MUTATION_STAGE_PATTERN =
  /^\.phase-mutation-stage\.([A-Za-z][A-Za-z0-9._:-]{0,127})\.([1-9][0-9]*)\.([0-9a-f-]{36})\.stage$/u;
const MUTATION_TOMBSTONE_PATTERN =
  /^\.phase-mutation-(release|recovery)-([0-9a-f]{64})\.([1-9][0-9]*)\.([0-9a-f-]{36})\.([0-9a-f]{64})\.tombstone$/u;
const MUTATION_TIMESTAMP_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const MAX_MUTATION_CLAIM_BYTES = 2_048;
const LISTENER_PROBE_TIMEOUT_MS = 250;

type CurrentUserCheck = (userId: bigint, candidate: string) => boolean;
export type PhaseMutationProcessLiveness = "alive" | "dead" | "unknown";
export type PhaseMutationListenerState = "present" | "absent" | "unknown";

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

interface MutationArtifactSnapshot extends HistoryFileSnapshot {
  readonly links: 1 | 2;
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

interface PhaseMutationClaim {
  readonly schema_version: "superpowers-phase-mutation.v1";
  readonly run_id: string;
  readonly operation_id: string;
  readonly owner_pid: number;
  readonly created_at: string;
}

const COORDINATORS = new Map<string, PhaseCoordinator>();

export interface PhaseHistoryOperationHooks {
  readonly afterMutationStageCreate?: (
    stagePath: string,
    claimPath: string,
  ) => void | Promise<void>;
  readonly afterMutationStageWrite?: (stagePath: string, claimPath: string) => void | Promise<void>;
  readonly afterMutationStageFileSync?: (
    stagePath: string,
    claimPath: string,
  ) => void | Promise<void>;
  readonly beforeMutationClaimLink?: (stagePath: string, claimPath: string) => void | Promise<void>;
  readonly afterMutationClaimDirectorySync?: (
    stagePath: string,
    claimPath: string,
  ) => void | Promise<void>;
  readonly beforeMutationStageCleanup?: (
    stagePath: string,
    claimPath: string,
  ) => void | Promise<void>;
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
  readonly afterApprovalPendingPhaseSync?: (state: "RUNNING") => void | Promise<void>;
  readonly afterApprovalPendingJournalSync?: (state: "APPROVAL_PENDING") => void | Promise<void>;
  readonly afterApprovalDecisionJournalSync?: (
    state: "RUNNING" | "BLOCKED",
  ) => void | Promise<void>;
  readonly afterApprovalDecisionPhaseSync?: () => void | Promise<void>;
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
  readonly hasServiceListener: () => Promise<PhaseMutationListenerState>;
  readonly brainstormingApprovalHandoff?: BrainstormingApprovalHandoff | undefined;
}

export interface CreateSkillsEngineForTestOptions extends CreateSkillsEngineOptions {
  readonly historyHooks?: PhaseHistoryOperationHooks | undefined;
  readonly isCurrentUser?: CurrentUserCheck | undefined;
  readonly isProcessAlive?: ((pid: number) => PhaseMutationProcessLiveness) | undefined;
}

export interface SkillsEngine {
  recover(): Promise<void>;
  discover(request: SkillDiscoveryRequest): Promise<SkillCatalogSnapshot>;
  select(snapshot: SkillCatalogSnapshot, request: SkillSelectionRequest): Promise<SkillSelection>;
  load(selection: SkillSelection): Promise<SkillSnapshotV1>;
  assembleContext(selection: SkillSelection, request: SkillContextRequest): Promise<SkillContext>;
  startPhase(request: StartSuperpowersPhaseRequest): Promise<SuperpowersPhaseOutcome>;
  completePhase(request: CompleteSuperpowersPhaseRequest): Promise<SuperpowersPhaseOutcome>;
  resumeApproval(request: ResumeSuperpowersApprovalRequest): Promise<SuperpowersPhaseOutcome>;
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

function defaultProcessLiveness(pid: number): PhaseMutationProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (errorCode(error) === "ESRCH") return "dead";
    if (errorCode(error) === "EPERM") return "alive";
    return "unknown";
  }
}

function safeProcessLiveness(
  probe: (pid: number) => PhaseMutationProcessLiveness,
  pid: number,
): PhaseMutationProcessLiveness {
  try {
    const value = probe(pid);
    return value === "alive" || value === "dead" || value === "unknown" ? value : "unknown";
  } catch {
    return "unknown";
  }
}

async function safeServiceListener(
  probe: () => Promise<PhaseMutationListenerState>,
): Promise<PhaseMutationListenerState> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(probe),
      new Promise<"unknown">((resolve) => {
        timeout = setTimeout(resolve, LISTENER_PROBE_TIMEOUT_MS, "unknown");
        timeout.unref();
      }),
    ]);
    return value === "present" || value === "absent" || value === "unknown" ? value : "unknown";
  } catch {
    return "unknown";
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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

function closedDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    invalid();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    invalid();
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      invalid();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function assertDeepFrozenData(
  value: unknown,
  state: { readonly seen: WeakSet<object>; members: number } = {
    seen: new WeakSet<object>(),
    members: 0,
  },
  depth = 0,
): void {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (depth > 64) limitExceeded();
  if (typeof value !== "object" || !Object.isFrozen(value)) integrity();
  if (state.seen.has(value)) integrity();
  state.seen.add(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) integrity();
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) integrity();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  state.members += Object.keys(descriptors).length;
  if (state.members > 10_000) limitExceeded();
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === "length") continue;
    if (
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      integrity();
    }
    assertDeepFrozenData(descriptor.value, state, depth + 1);
  }
  if (
    Array.isArray(value) &&
    Object.keys(descriptors).filter((key) => key !== "length").length !== value.length
  ) {
    integrity();
  }
}

function exactSelectionAuthority(value: unknown): SkillSelection {
  const selection = closedDataRecord(value, ["descriptor", "catalog_hash", "package_handle"]);
  assertDeepFrozenData(value);
  if (
    typeof selection.catalog_hash !== "string" ||
    !HASH_PATTERN.test(selection.catalog_hash) ||
    typeof selection.package_handle !== "string" ||
    !HASH_PATTERN.test(selection.package_handle)
  ) {
    invalid();
  }
  let parsed: ReturnType<typeof parseSkillDescriptor>;
  try {
    parsed = parseSkillDescriptor(canonicalJson(selection.descriptor));
  } catch {
    invalid();
  }
  if (!parsed.ok || canonicalJson(parsed.value) !== canonicalJson(selection.descriptor)) invalid();
  return value as SkillSelection;
}

function copiedJournalHead(value: unknown): JournalHead {
  const head = closedDataRecord(value, ["journal_revision", "sequence", "entry_hash"]);
  if (
    typeof head.journal_revision !== "number" ||
    !Number.isSafeInteger(head.journal_revision) ||
    head.journal_revision < 1 ||
    typeof head.sequence !== "number" ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 1 ||
    typeof head.entry_hash !== "string"
  ) {
    invalid();
  }
  assertHash(head.entry_hash);
  return Object.freeze({
    journal_revision: head.journal_revision,
    sequence: head.sequence,
    entry_hash: head.entry_hash,
  });
}

function copiedTrace(value: unknown): TraceContext {
  if (typeof value !== "object" || value === null) invalid();
  const keys = Object.prototype.hasOwnProperty.call(value, "trace_state")
    ? ["trace_id", "span_id", "trace_flags", "trace_state"]
    : ["trace_id", "span_id", "trace_flags"];
  const trace = closedDataRecord(value, keys);
  if (
    typeof trace.trace_id !== "string" ||
    !/^[0-9a-f]{32}$/u.test(trace.trace_id) ||
    typeof trace.span_id !== "string" ||
    !/^[0-9a-f]{16}$/u.test(trace.span_id) ||
    typeof trace.trace_flags !== "number" ||
    !Number.isSafeInteger(trace.trace_flags) ||
    trace.trace_flags < 0 ||
    trace.trace_flags > 255 ||
    (trace.trace_state !== undefined &&
      (typeof trace.trace_state !== "string" || trace.trace_state.length > 512))
  ) {
    invalid();
  }
  return Object.freeze({
    trace_id: trace.trace_id,
    span_id: trace.span_id,
    trace_flags: trace.trace_flags,
    ...(trace.trace_state === undefined ? {} : { trace_state: trace.trace_state }),
  });
}

interface CapturedStart {
  readonly request: StartSuperpowersPhaseRequest;
  readonly input: Uint8Array;
  readonly inputHash: `sha256:${string}`;
}

function captureStartRequest(value: unknown): CapturedStart {
  const source = closedDataRecord(value, [
    "run_id",
    "expected_journal_head",
    "execution_request_hash",
    "selection",
    "phase",
    "input",
    "operation_id",
    "trace",
  ]);
  if (
    typeof source.run_id !== "string" ||
    !IDENTIFIER_PATTERN.test(source.run_id) ||
    typeof source.execution_request_hash !== "string" ||
    !HASH_PATTERN.test(source.execution_request_hash) ||
    typeof source.phase !== "string" ||
    typeof source.operation_id !== "string" ||
    !IDENTIFIER_PATTERN.test(source.operation_id) ||
    !(source.input instanceof Uint8Array) ||
    source.input.byteLength > SKILL_LIMITS.phaseInputBytes
  ) {
    if (
      source.input instanceof Uint8Array &&
      source.input.byteLength > SKILL_LIMITS.phaseInputBytes
    ) {
      limitExceeded();
    }
    invalid();
  }
  let handler;
  try {
    handler = builtInSuperpowersHandler(source.phase as SuperpowersPhaseName);
  } catch {
    invalid();
  }
  const selection = exactSelectionAuthority(source.selection);
  if (selection.descriptor.name !== handler.capability) integrity();
  const expectedJournalHead = copiedJournalHead(source.expected_journal_head);
  const trace = copiedTrace(source.trace);
  const input = Buffer.from(source.input);
  const request = Object.freeze({
    run_id: source.run_id,
    expected_journal_head: expectedJournalHead,
    execution_request_hash: source.execution_request_hash as `sha256:${string}`,
    selection,
    phase: source.phase as SuperpowersPhaseName,
    input,
    operation_id: source.operation_id,
    trace,
  });
  return Object.freeze({ request, input, inputHash: rawHash(input) });
}

interface CapturedCompletion {
  readonly request: CompleteSuperpowersPhaseRequest;
  readonly output: Uint8Array;
  readonly outputHash: `sha256:${string}`;
}

function captureCompletionRequest(value: unknown): CapturedCompletion {
  const source = closedDataRecord(value, [
    "run_id",
    "expected_phase_revision",
    "expected_phase_head_hash",
    "phase",
    "skill_snapshot_hash",
    "operation_id",
    "outcome",
    "output",
    "trace",
  ]);
  if (
    typeof source.run_id !== "string" ||
    !IDENTIFIER_PATTERN.test(source.run_id) ||
    typeof source.expected_phase_revision !== "number" ||
    !Number.isSafeInteger(source.expected_phase_revision) ||
    source.expected_phase_revision < 1 ||
    typeof source.expected_phase_head_hash !== "string" ||
    !HASH_PATTERN.test(source.expected_phase_head_hash) ||
    typeof source.phase !== "string" ||
    typeof source.skill_snapshot_hash !== "string" ||
    !HASH_PATTERN.test(source.skill_snapshot_hash) ||
    typeof source.operation_id !== "string" ||
    !IDENTIFIER_PATTERN.test(source.operation_id) ||
    (source.outcome !== "COMPLETED" &&
      source.outcome !== "FAILED" &&
      source.outcome !== "BLOCKED") ||
    !(source.output instanceof Uint8Array) ||
    source.output.byteLength > SKILL_LIMITS.phaseOutputBytes
  ) {
    if (
      source.output instanceof Uint8Array &&
      source.output.byteLength > SKILL_LIMITS.phaseOutputBytes
    ) {
      limitExceeded();
    }
    invalid();
  }
  let handler;
  try {
    handler = builtInSuperpowersHandler(source.phase as SuperpowersPhaseName);
  } catch {
    invalid();
  }
  if (
    source.outcome !== handler.semantic.completion.success_status &&
    handler.semantic.completion.unsuccessful_output === "EMPTY" &&
    source.output.byteLength !== 0
  ) {
    invalid();
  }
  const trace = copiedTrace(source.trace);
  const output = Buffer.from(source.output);
  const request = Object.freeze({
    run_id: source.run_id,
    expected_phase_revision: source.expected_phase_revision,
    expected_phase_head_hash: source.expected_phase_head_hash as `sha256:${string}`,
    phase: source.phase as SuperpowersPhaseName,
    skill_snapshot_hash: source.skill_snapshot_hash as `sha256:${string}`,
    operation_id: source.operation_id,
    outcome: source.outcome,
    output,
    trace,
  });
  return Object.freeze({ request, output, outputHash: rawHash(output) });
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
  return builtInSuperpowersHandler(phase).capability === skillName;
}

function samePhaseBinding(left: SuperpowersPhaseV1, right: SuperpowersPhaseV1): boolean {
  return (
    left.run_id === right.run_id &&
    left.execution_request_hash === right.execution_request_hash &&
    exactJson(left.observed_journal_head, right.observed_journal_head) &&
    exactJson(left.skill, right.skill) &&
    left.phase === right.phase &&
    exactJson(left.handler, right.handler) &&
    exactJson(left.predecessor_phase_hashes, right.predecessor_phase_hashes) &&
    left.operation_id === right.operation_id &&
    left.input_hash === right.input_hash
  );
}

function validateHistory(runId: string, entries: readonly SuperpowersPhaseV1[]): void {
  let unmatched: SuperpowersPhaseV1 | null = null;
  const seenOperations = new Set<string>();
  const requestedPhases: SuperpowersPhaseName[] = [];
  const latestAttempts = new Map<
    SuperpowersPhaseName,
    { readonly started: SuperpowersPhaseV1; terminal: SuperpowersPhaseV1 | null }
  >();
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
      const expectedPredecessors: `sha256:${string}`[] = [];
      for (const predecessor of requiredBuiltInPhasePredecessors(entry.phase, requestedPhases)) {
        const attempt = latestAttempts.get(predecessor);
        const evidence = attempt?.terminal;
        const exactTddEvidence =
          (entry.phase === "RED" && predecessor === "TEST_DESIGN") ||
          (entry.phase === "GREEN" && predecessor === "RED");
        if (
          attempt === undefined ||
          evidence?.status !== "COMPLETED" ||
          attempt.started.execution_request_hash !== entry.execution_request_hash ||
          evidence.execution_request_hash !== entry.execution_request_hash ||
          !exactJson(evidence.handler, attempt.started.handler) ||
          (exactTddEvidence && !exactJson(evidence.skill, entry.skill))
        ) {
          integrity();
        }
        expectedPredecessors.push(evidence.document_hash);
      }
      if (
        entry.output_hash !== null ||
        unmatched !== null ||
        seenOperations.has(entry.operation_id) ||
        !exactJson(entry.predecessor_phase_hashes, expectedPredecessors)
      ) {
        integrity();
      }
      seenOperations.add(entry.operation_id);
      unmatched = entry;
      requestedPhases.push(entry.phase);
      latestAttempts.set(entry.phase, { started: entry, terminal: null });
      continue;
    }
    if (entry.status === "APPROVAL_PENDING") {
      if (
        unmatched === null ||
        unmatched.phase !== "BRAINSTORMING" ||
        !samePhaseBinding(unmatched, entry) ||
        entry.output_hash === null
      ) {
        integrity();
      }
      continue;
    }
    if (unmatched === null || !samePhaseBinding(unmatched, entry)) integrity();
    const latestAttempt = latestAttempts.get(entry.phase);
    if (
      latestAttempt === undefined ||
      latestAttempt.started.operation_id !== entry.operation_id ||
      latestAttempt.terminal !== null
    ) {
      integrity();
    }
    latestAttempt.terminal = entry;
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

function journalHeadForEntry(entry: RunJournalEntryV1): JournalHead {
  return Object.freeze({
    journal_revision: entry.journal_revision,
    sequence: entry.sequence,
    entry_hash: entry.entry_hash,
  });
}

function metadataKind(entry: RunJournalEntryV1): JsonValue | undefined {
  const metadata = entry.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
    return undefined;
  return (metadata as Readonly<Record<string, JsonValue>>).kind;
}

function approvalDecisionRecords(journal: RunJournalSnapshot): readonly Readonly<{
  entry: RunJournalEntryV1;
  metadata: ApprovalDecisionJournalMetadata;
}>[] {
  return Object.freeze(
    journal.entries
      .filter((entry) => metadataKind(entry) === "superpowers-approval-decision")
      .map((entry) => {
        const pendingEntry = journal.entries.find(
          (candidate) => candidate.entry_hash === entry.previous_entry_hash,
        );
        if (pendingEntry === undefined) integrity();
        return Object.freeze({ entry, metadata: decisionMetadata(entry, pendingEntry) });
      }),
  );
}

function approvalPendingRecords(journal: RunJournalSnapshot): readonly Readonly<{
  entry: RunJournalEntryV1;
  metadata: ApprovalPendingJournalMetadata;
}>[] {
  return Object.freeze(
    journal.entries
      .filter((entry) => metadataKind(entry) === "superpowers-approval-pending")
      .map((entry) => Object.freeze({ entry, metadata: pendingMetadata(entry) })),
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

interface PhaseSkillBinding {
  readonly name: string;
  readonly version: string;
  readonly snapshot_hash: `sha256:${string}`;
}

function predecessorEvidenceHashes(
  entries: readonly SuperpowersPhaseV1[],
  phase: SuperpowersPhaseName,
  skill: PhaseSkillBinding,
  executionRequestHash: `sha256:${string}`,
): readonly `sha256:${string}`[] | null {
  if (
    latestUnmatchedStart(entries) !== null ||
    entries.some((entry) => entry.execution_request_hash !== executionRequestHash)
  ) {
    return null;
  }
  const requested = entries
    .filter((entry) => entry.status === "STARTED")
    .map((entry) => entry.phase);
  const hashes: `sha256:${string}`[] = [];
  for (const predecessor of requiredBuiltInPhasePredecessors(phase, requested)) {
    const latest = entries
      .filter((entry) => entry.phase === predecessor && entry.status === "STARTED")
      .at(-1);
    if (latest === undefined) return null;
    const evidence = entries.find(
      (entry) =>
        entry.operation_id === latest.operation_id &&
        entry.status !== "STARTED" &&
        entry.status !== "APPROVAL_PENDING",
    );
    const exactTddEvidence =
      (phase === "RED" && predecessor === "TEST_DESIGN") ||
      (phase === "GREEN" && predecessor === "RED");
    if (
      evidence === undefined ||
      evidence.status !== "COMPLETED" ||
      latest.execution_request_hash !== executionRequestHash ||
      evidence.execution_request_hash !== latest.execution_request_hash ||
      !exactJson(evidence.handler, latest.handler) ||
      (exactTddEvidence &&
        (evidence.skill.name !== skill.name ||
          evidence.skill.version !== skill.version ||
          evidence.skill.snapshot_hash !== skill.snapshot_hash))
    ) {
      return null;
    }
    hashes.push(evidence.document_hash);
  }
  return Object.freeze(hashes);
}

function enforcePredecessors(
  entries: readonly SuperpowersPhaseV1[],
  phase: SuperpowersPhaseName,
  snapshot: SkillSnapshotV1,
  executionRequestHash: `sha256:${string}`,
): readonly `sha256:${string}`[] {
  const hashes = predecessorEvidenceHashes(
    entries,
    phase,
    {
      name: snapshot.descriptor.name,
      version: snapshot.descriptor.version,
      snapshot_hash: snapshot.document_hash,
    },
    executionRequestHash,
  );
  if (hashes === null) stale();
  return hashes;
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
  const isProcessAlive = options.isProcessAlive ?? defaultProcessLiveness;
  const hooks = options.historyHooks;
  const journalStore = options.journal;
  const officialJournal = hasOfficialRunJournalBarrier(journalStore);
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

  const readMutationArtifact = (
    candidate: string,
    parentDirectories: readonly OpenedDirectory[],
  ): MutationArtifactSnapshot => {
    const before = lstatSync(candidate, { bigint: true });
    const links = before.nlink === 1n ? 1 : before.nlink === 2n ? 2 : pathUnsafe();
    assertPrivateFile(before, candidate, isCurrentUser, links);
    if (before.size > BigInt(MAX_MUTATION_CLAIM_BYTES)) limitExceeded();
    const descriptor = openSync(
      candidate,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const held = fstatSync(descriptor, { bigint: true });
      assertPrivateFile(held, candidate, isCurrentUser, links);
      if (
        !identitiesMatch(identity(before), identity(held)) ||
        held.size > BigInt(MAX_MUTATION_CLAIM_BYTES)
      ) {
        pathUnsafe();
      }
      const bytes = readAll(descriptor, Number(held.size));
      exactFile(candidate, descriptor, identity(held), bytes, isCurrentUser, links);
      revalidateDirectoryChain(parentDirectories, statePath, isCurrentUser);
      return { bytes, identity: identity(held), links };
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

  const mutationLockPath = (runId: string): string => {
    assertIdentifier(runId);
    return path.join(
      phasesPath,
      `.phase-mutation-${rawHash(Buffer.from(runId)).slice("sha256:".length)}.lock`,
    );
  };

  const parseMutationClaim = (runId: string | null, bytes: Uint8Array): PhaseMutationClaim => {
    try {
      const value = parseJsonBytes(bytes, {
        maxBytes: MAX_MUTATION_CLAIM_BYTES,
        maxDepth: 3,
        maxMembers: 8,
      });
      const claim = closedDataRecord(value, [
        "schema_version",
        "run_id",
        "operation_id",
        "owner_pid",
        "created_at",
      ]);
      if (
        claim.schema_version !== "superpowers-phase-mutation.v1" ||
        typeof claim.run_id !== "string" ||
        !IDENTIFIER_PATTERN.test(claim.run_id) ||
        (runId !== null && claim.run_id !== runId) ||
        typeof claim.operation_id !== "string" ||
        !UUID_PATTERN.test(claim.operation_id) ||
        typeof claim.owner_pid !== "number" ||
        !Number.isSafeInteger(claim.owner_pid) ||
        claim.owner_pid <= 0 ||
        typeof claim.created_at !== "string" ||
        !MUTATION_TIMESTAMP_PATTERN.test(claim.created_at)
      ) {
        integrity();
      }
      const createdAt = new Date(claim.created_at);
      if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== claim.created_at) {
        integrity();
      }
      const parsed = claim as unknown as PhaseMutationClaim;
      if (canonicalJson(parsed) !== Buffer.from(bytes).toString("utf8")) {
        integrity();
      }
      return parsed;
    } catch {
      integrity();
    }
  };

  const isMutationClaimPrefix = (
    runId: string,
    ownerPid: number,
    operationId: string,
    bytes: Uint8Array,
  ): boolean => {
    const text = Buffer.from(bytes).toString("utf8");
    if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) return false;
    const prefix = '{"created_at":"';
    if (text.length <= prefix.length) return prefix.startsWith(text);
    if (!text.startsWith(prefix)) return false;
    const remainder = text.slice(prefix.length);
    let offset = 0;
    const decimal = (
      width: number,
      minimum: number,
      maximum: number,
    ):
      | { readonly state: "complete"; readonly value: number }
      | { readonly state: "partial" }
      | null => {
      const available = Math.min(width, remainder.length - offset);
      const observed = remainder.slice(offset, offset + available);
      if (!/^[0-9]*$/u.test(observed)) return null;
      if (available < width) {
        const lower = Number(observed.padEnd(width, "0"));
        const upper = Number(observed.padEnd(width, "9"));
        return lower <= maximum && upper >= minimum ? { state: "partial" } : null;
      }
      const value = Number(observed);
      if (value < minimum || value > maximum) return null;
      offset += width;
      return { state: "complete", value };
    };
    const literal = (expected: string): "complete" | "partial" | null => {
      const observed = remainder.slice(offset, offset + expected.length);
      if (!expected.startsWith(observed)) return null;
      if (observed.length < expected.length) return "partial";
      offset += expected.length;
      return "complete";
    };

    const year = decimal(4, 0, 9_999);
    if (year === null) return false;
    if (year.state === "partial") return true;
    let boundary = literal("-");
    if (boundary !== "complete") return boundary === "partial";
    const month = decimal(2, 1, 12);
    if (month === null) return false;
    if (month.state === "partial") return true;
    boundary = literal("-");
    if (boundary !== "complete") return boundary === "partial";
    const leapYear = year.value % 4 === 0 && (year.value % 100 !== 0 || year.value % 400 === 0);
    const maximumDay = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
      month.value - 1
    ]!;
    const day = decimal(2, 1, maximumDay);
    if (day === null) return false;
    if (day.state === "partial") return true;
    boundary = literal("T");
    if (boundary !== "complete") return boundary === "partial";
    const hour = decimal(2, 0, 23);
    if (hour === null) return false;
    if (hour.state === "partial") return true;
    boundary = literal(":");
    if (boundary !== "complete") return boundary === "partial";
    const minute = decimal(2, 0, 59);
    if (minute === null) return false;
    if (minute.state === "partial") return true;
    boundary = literal(":");
    if (boundary !== "complete") return boundary === "partial";
    const second = decimal(2, 0, 59);
    if (second === null) return false;
    if (second.state === "partial") return true;
    boundary = literal(".");
    if (boundary !== "complete") return boundary === "partial";
    const millisecond = decimal(3, 0, 999);
    if (millisecond === null) return false;
    if (millisecond.state === "partial") return true;
    boundary = literal("Z");
    if (boundary !== "complete") return boundary === "partial";
    const suffix = `","operation_id":"${operationId}","owner_pid":${ownerPid},"run_id":"${runId}","schema_version":"superpowers-phase-mutation.v1"}`;
    return suffix.startsWith(remainder.slice(offset));
  };

  const syncPhaseDirectory = (): void => {
    const directories = openDirectoryChain(phasesPath, statePath, isCurrentUser);
    try {
      syncDirectoryChain(directories, statePath, isCurrentUser);
    } finally {
      closeDirectoryChain(directories);
    }
  };

  const removeExactMutationArtifact = (
    candidate: string,
    expected: MutationArtifactSnapshot,
  ): void => {
    const directories = openDirectoryChain(phasesPath, statePath, isCurrentUser);
    const descriptor = openSync(
      candidate,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      exactFile(
        candidate,
        descriptor,
        expected.identity,
        expected.bytes,
        isCurrentUser,
        expected.links,
      );
      revalidateDirectoryChain(directories, statePath, isCurrentUser);
      unlinkSync(candidate);
      requireMissing(candidate);
      syncDirectoryChain(directories, statePath, isCurrentUser);
      requireMissing(candidate);
    } finally {
      closeSync(descriptor);
      closeDirectoryChain(directories);
    }
  };

  const cleanupMutationTombstones = async (runId: string): Promise<void> => {
    const runHash = rawHash(Buffer.from(runId)).slice("sha256:".length);
    const directories = openDirectoryChain(phasesPath, statePath, isCurrentUser);
    try {
      for (const name of scanNames(phasesPath, MAX_PHASE_HISTORY_FILES * 4 + 32)) {
        const match = MUTATION_TOMBSTONE_PATTERN.exec(name);
        if (match?.[2] !== runHash) continue;
        const cleanerPid = Number(match[3]);
        if (
          !Number.isSafeInteger(cleanerPid) ||
          cleanerPid <= 0 ||
          match[4] === undefined ||
          match[5] === undefined ||
          !UUID_PATTERN.test(match[4])
        ) {
          integrity();
        }
        const candidate = path.join(phasesPath, name);
        let exact: MutationArtifactSnapshot;
        try {
          exact = readMutationArtifact(candidate, directories);
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        if (exact.links !== 1) pathUnsafe();
        parseMutationClaim(runId, exact.bytes);
        if (rawHash(exact.bytes).slice("sha256:".length) !== match[5]) integrity();
        const cleanerLiveness = safeProcessLiveness(isProcessAlive, cleanerPid);
        if (cleanerLiveness === "alive") continue;
        if (
          cleanerLiveness !== "dead" ||
          (await safeServiceListener(options.hasServiceListener)) !== "absent"
        ) {
          integrity();
        }
        try {
          removeExactMutationArtifact(candidate, exact);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    } finally {
      closeDirectoryChain(directories);
    }
  };

  const reconcileMutationStages = async (runId: string): Promise<"ready" | "busy"> => {
    let busy = false;
    const recoverable: {
      readonly candidate: string;
      readonly artifact: MutationArtifactSnapshot;
    }[] = [];
    const directories = openDirectoryChain(phasesPath, statePath, isCurrentUser);
    try {
      for (const name of scanNames(phasesPath, MAX_PHASE_HISTORY_FILES * 4 + 32)) {
        const match = MUTATION_STAGE_PATTERN.exec(name);
        if (match?.[1] !== runId) continue;
        const ownerPid = Number(match[2]);
        const operationId = match[3];
        if (
          !Number.isSafeInteger(ownerPid) ||
          ownerPid <= 0 ||
          operationId === undefined ||
          !UUID_PATTERN.test(operationId)
        ) {
          integrity();
        }
        const candidate = path.join(phasesPath, name);
        let named: BigIntStats;
        try {
          named = lstatSync(candidate, { bigint: true });
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        const namedLinks = named.nlink === 1n ? 1 : named.nlink === 2n ? 2 : pathUnsafe();
        assertPrivateFile(named, candidate, isCurrentUser, namedLinks);
        if (named.size > BigInt(MAX_MUTATION_CLAIM_BYTES)) limitExceeded();
        const liveness = safeProcessLiveness(isProcessAlive, ownerPid);
        if (liveness === "alive") {
          busy = true;
          continue;
        }
        if (
          liveness !== "dead" ||
          (await safeServiceListener(options.hasServiceListener)) !== "absent"
        ) {
          integrity();
        }
        let artifact: MutationArtifactSnapshot;
        try {
          artifact = readMutationArtifact(candidate, directories);
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }

        let claim: PhaseMutationClaim | null = null;
        try {
          claim = parseMutationClaim(runId, artifact.bytes);
        } catch (error) {
          if (
            artifact.links !== 1 ||
            !isMutationClaimPrefix(runId, ownerPid, operationId, artifact.bytes)
          ) {
            throw error;
          }
        }
        if (
          claim !== null &&
          (claim.owner_pid !== ownerPid || claim.operation_id !== operationId)
        ) {
          integrity();
        }
        if (artifact.links === 2) {
          if (claim === null) integrity();
          let final: MutationArtifactSnapshot;
          try {
            final = readMutationArtifact(mutationLockPath(runId), directories);
          } catch (error) {
            if (isMissing(error)) pathUnsafe();
            throw error;
          }
          if (
            final.links !== 2 ||
            !identitiesMatch(final.identity, artifact.identity) ||
            !Buffer.from(final.bytes).equals(Buffer.from(artifact.bytes))
          ) {
            pathUnsafe();
          }
        }
        recoverable.push({ candidate, artifact });
      }
      if (busy) return "busy";
      for (const { candidate, artifact } of recoverable) {
        try {
          removeExactMutationArtifact(candidate, artifact);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    } finally {
      closeDirectoryChain(directories);
    }
    return "ready";
  };

  const acquireMutationClaim = async (runId: string): Promise<() => void> => {
    assertIdentifier(runId);
    for (;;) {
      ensureRoots();
      await cleanupMutationTombstones(runId);
      if ((await reconcileMutationStages(runId)) === "busy") {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        continue;
      }
      const candidate = mutationLockPath(runId);
      const operationId = options.randomId();
      if (!UUID_PATTERN.test(operationId)) integrity();
      const occurredAt = options.now();
      if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) integrity();
      const createdAt = occurredAt.toISOString();
      if (!MUTATION_TIMESTAMP_PATTERN.test(createdAt)) integrity();
      const claim: PhaseMutationClaim = Object.freeze({
        schema_version: "superpowers-phase-mutation.v1",
        run_id: runId,
        operation_id: operationId,
        owner_pid: process.pid,
        created_at: createdAt,
      });
      const bytes = Buffer.from(canonicalJson(claim as unknown as JsonValue), "utf8");
      const stagePath = path.join(
        phasesPath,
        `.phase-mutation-stage.${runId}.${process.pid}.${operationId}.stage`,
      );
      let descriptor: number | undefined;
      let published = false;
      let claimIdentity: FileIdentity | undefined;
      const publicationDirectories = openDirectoryChain(phasesPath, statePath, isCurrentUser);
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
        const metadata = fstatSync(descriptor, { bigint: true });
        assertPrivateFile(metadata, stagePath, isCurrentUser);
        claimIdentity = identity(metadata);
        exactFile(stagePath, descriptor, claimIdentity, Buffer.alloc(0), isCurrentUser);
        await invokeHook(
          hooks?.afterMutationStageCreate === undefined
            ? undefined
            : () => hooks.afterMutationStageCreate!(stagePath, candidate),
          publicationDirectories,
        );
        exactFile(stagePath, descriptor, claimIdentity, Buffer.alloc(0), isCurrentUser);
        writeAll(descriptor, bytes);
        exactFile(stagePath, descriptor, claimIdentity, bytes, isCurrentUser);
        await invokeHook(
          hooks?.afterMutationStageWrite === undefined
            ? undefined
            : () => hooks.afterMutationStageWrite!(stagePath, candidate),
          publicationDirectories,
        );
        exactFile(stagePath, descriptor, claimIdentity, bytes, isCurrentUser);
        fsyncSync(descriptor);
        exactFile(stagePath, descriptor, claimIdentity, bytes, isCurrentUser);
        await invokeHook(
          hooks?.afterMutationStageFileSync === undefined
            ? undefined
            : () => hooks.afterMutationStageFileSync!(stagePath, candidate),
          publicationDirectories,
        );
        exactFile(stagePath, descriptor, claimIdentity, bytes, isCurrentUser);
        await invokeHook(
          hooks?.beforeMutationClaimLink === undefined
            ? undefined
            : () => hooks.beforeMutationClaimLink!(stagePath, candidate),
          publicationDirectories,
        );
        exactFile(stagePath, descriptor, claimIdentity, bytes, isCurrentUser);

        // Node 24 exposes no openat/linkat. Under the descriptor-held private directory,
        // the irreducible same-UID pathname interval stays synchronous: no hook or await is
        // permitted between namespace revalidation, no-overwrite link, and directory sync.
        revalidateDirectoryChain(publicationDirectories, statePath, isCurrentUser);
        try {
          linkSync(stagePath, candidate);
          published = true;
        } catch (error) {
          if (!isExisting(error)) throw error;
        }
        if (published) {
          exactFile(stagePath, descriptor, claimIdentity, bytes, isCurrentUser, 2);
          syncDirectoryChain(publicationDirectories, statePath, isCurrentUser);
          exactFile(candidate, descriptor, claimIdentity, bytes, isCurrentUser, 2);
          exactFile(stagePath, descriptor, claimIdentity, bytes, isCurrentUser, 2);
          await invokeHook(
            hooks?.afterMutationClaimDirectorySync === undefined
              ? undefined
              : () => hooks.afterMutationClaimDirectorySync!(stagePath, candidate),
            publicationDirectories,
          );
          exactFile(candidate, descriptor, claimIdentity, bytes, isCurrentUser, 2);
          exactFile(stagePath, descriptor, claimIdentity, bytes, isCurrentUser, 2);
          await invokeHook(
            hooks?.beforeMutationStageCleanup === undefined
              ? undefined
              : () => hooks.beforeMutationStageCleanup!(stagePath, candidate),
            publicationDirectories,
          );
          exactFile(candidate, descriptor, claimIdentity, bytes, isCurrentUser, 2);
          exactFile(stagePath, descriptor, claimIdentity, bytes, isCurrentUser, 2);
          // Node has no fd-relative conditional unlink. Keep exact revalidation, unlink,
          // absence proof, and parent sync in one synchronous, non-hooked interval.
          unlinkSync(stagePath);
          requireMissing(stagePath);
          syncDirectoryChain(publicationDirectories, statePath, isCurrentUser);
          exactFile(candidate, descriptor, claimIdentity, bytes, isCurrentUser);
        } else {
          exactFile(stagePath, descriptor, claimIdentity, bytes, isCurrentUser);
          await invokeHook(
            hooks?.beforeMutationStageCleanup === undefined
              ? undefined
              : () => hooks.beforeMutationStageCleanup!(stagePath, candidate),
            publicationDirectories,
          );
          exactFile(stagePath, descriptor, claimIdentity, bytes, isCurrentUser);
          // The same accepted Node conditional-unlink interval applies to a losing stage.
          unlinkSync(stagePath);
          requireMissing(stagePath);
          syncDirectoryChain(publicationDirectories, statePath, isCurrentUser);
        }
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        closeDirectoryChain(publicationDirectories);
        if (isExisting(error) && !published) integrity();
        throw error;
      }
      closeDirectoryChain(publicationDirectories);
      if (published && descriptor !== undefined && claimIdentity !== undefined) {
        const publishedIdentity = claimIdentity;
        closeSync(descriptor);
        descriptor = undefined;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          const held = openSync(
            candidate,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
          );
          const tombstone = path.join(
            phasesPath,
            `.phase-mutation-release-${rawHash(Buffer.from(runId)).slice("sha256:".length)}.${process.pid}.${operationId}.${rawHash(bytes).slice("sha256:".length)}.tombstone`,
          );
          try {
            exactFile(candidate, held, publishedIdentity, bytes, isCurrentUser);
            requireMissing(tombstone);
            renameSync(candidate, tombstone);
            requireMissing(candidate);
            exactFile(tombstone, held, publishedIdentity, bytes, isCurrentUser);
            syncPhaseDirectory();
            exactFile(tombstone, held, publishedIdentity, bytes, isCurrentUser);
            unlinkSync(tombstone);
            requireMissing(tombstone);
            syncPhaseDirectory();
          } finally {
            closeSync(held);
          }
        };
      }
      if (descriptor !== undefined) closeSync(descriptor);

      const directories = openDirectoryChain(phasesPath, statePath, isCurrentUser);
      let existing: MutationArtifactSnapshot | undefined;
      try {
        try {
          existing = readMutationArtifact(candidate, directories);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      } finally {
        closeDirectoryChain(directories);
      }
      if (existing === undefined) continue;
      let existingClaim = parseMutationClaim(runId, existing.bytes);
      if (existing.links === 2) {
        const expectedStage = path.join(
          phasesPath,
          `.phase-mutation-stage.${runId}.${existingClaim.owner_pid}.${existingClaim.operation_id}.stage`,
        );
        const linkedDirectories = openDirectoryChain(phasesPath, statePath, isCurrentUser);
        try {
          try {
            const linked = readMutationArtifact(expectedStage, linkedDirectories);
            if (
              linked.links !== 2 ||
              !identitiesMatch(linked.identity, existing.identity) ||
              !Buffer.from(linked.bytes).equals(Buffer.from(existing.bytes))
            ) {
              pathUnsafe();
            }
            continue;
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
          const refreshed = readMutationArtifact(candidate, linkedDirectories);
          if (
            refreshed.links !== 1 ||
            !identitiesMatch(refreshed.identity, existing.identity) ||
            !Buffer.from(refreshed.bytes).equals(Buffer.from(existing.bytes))
          ) {
            pathUnsafe();
          }
          existing = refreshed;
          existingClaim = parseMutationClaim(runId, refreshed.bytes);
        } finally {
          closeDirectoryChain(linkedDirectories);
        }
      }
      const liveness = safeProcessLiveness(isProcessAlive, existingClaim.owner_pid);
      if (liveness === "alive") {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        continue;
      }
      if (
        liveness !== "dead" ||
        (await safeServiceListener(options.hasServiceListener)) !== "absent"
      ) {
        integrity();
      }
      const recoveryId = options.randomId();
      if (!UUID_PATTERN.test(recoveryId)) integrity();
      const tombstone = path.join(
        phasesPath,
        `.phase-mutation-recovery-${rawHash(Buffer.from(runId)).slice("sha256:".length)}.${process.pid}.${recoveryId}.${rawHash(existing.bytes).slice("sha256:".length)}.tombstone`,
      );
      let held: number;
      try {
        held = openSync(
          candidate,
          constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      try {
        exactFile(candidate, held, existing.identity, existing.bytes, isCurrentUser);
        requireMissing(tombstone);
        try {
          renameSync(candidate, tombstone);
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        requireMissing(candidate);
        exactFile(tombstone, held, existing.identity, existing.bytes, isCurrentUser);
        syncPhaseDirectory();
        exactFile(tombstone, held, existing.identity, existing.bytes, isCurrentUser);
        unlinkSync(tombstone);
        requireMissing(tombstone);
        syncPhaseDirectory();
      } finally {
        closeSync(held);
      }
    }
  };

  const cleanupStages = (runId: string): void => {
    assertIdentifier(runId);
    const phaseDirectories = openDirectoryChain(phasesPath, statePath, isCurrentUser);
    const quarantineDirectories = openDirectoryChain(quarantinePath, statePath, isCurrentUser);
    try {
      const phaseNames = scanNames(phasesPath, MAX_PHASE_HISTORY_FILES * 4 + 32);
      const finalIdentities = new Map<string, FileIdentity>();
      for (const name of phaseNames) {
        if (
          name === "quarantine" ||
          HISTORY_STAGE_PATTERN.test(name) ||
          MUTATION_LOCK_PATTERN.test(name) ||
          MUTATION_STAGE_PATTERN.test(name) ||
          MUTATION_TOMBSTONE_PATTERN.test(name)
        ) {
          continue;
        }
        const match = HISTORY_NAME_PATTERN.exec(name);
        if (match?.[1] === undefined) pathUnsafe();
        const candidate = path.join(phasesPath, name);
        const metadata = lstatSync(candidate, { bigint: true });
        const links = metadata.nlink === 1n ? 1 : metadata.nlink === 2n ? 2 : pathUnsafe();
        assertPrivateFile(metadata, candidate, isCurrentUser, links);
        finalIdentities.set(candidate, identity(metadata));
      }
      for (const name of phaseNames.filter(
        (entry) => HISTORY_STAGE_PATTERN.exec(entry)?.[1] === runId,
      )) {
        const expectedFinal = historyPath(runId);
        const expectedIdentity = finalIdentities.get(expectedFinal);
        unlinkOwnedStage(
          path.join(phasesPath, name),
          expectedIdentity === undefined ? new Map() : new Map([[expectedFinal, expectedIdentity]]),
          phaseDirectories,
        );
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
      for (const name of quarantineNames.filter(
        (entry) => QUARANTINE_STAGE_PATTERN.exec(entry)?.[1] === runId,
      )) {
        unlinkOwnedStage(path.join(quarantinePath, name), quarantineFinals, quarantineDirectories);
      }
      syncDirectoryChain(phaseDirectories, statePath, isCurrentUser);
      syncDirectoryChain(quarantineDirectories, statePath, isCurrentUser);
    } finally {
      closeDirectoryChain(quarantineDirectories);
      closeDirectoryChain(phaseDirectories);
    }
  };

  const withMutationClaim = async <T>(runId: string, operation: () => Promise<T>): Promise<T> => {
    const release = await acquireMutationClaim(runId);
    try {
      cleanupStages(runId);
      return await operation();
    } finally {
      release();
    }
  };

  const publishStaged = async (
    directoryPath: string,
    stagePrefix: "create" | "quarantine",
    runId: string,
    finalPath: string,
    bytes: Uint8Array,
    beforePublication?: (stagePath: string, finalPath: string) => void | Promise<void>,
    afterPublication?: (stagePath: string, finalPath: string) => void | Promise<void>,
  ): Promise<"created" | "existing"> => {
    const randomId = options.randomId();
    if (!UUID_PATTERN.test(randomId)) pathUnsafe();
    const stageName =
      stagePrefix === "create"
        ? `.phase-create.${runId}.${randomId}.stage`
        : `.phase-quarantine.${runId}.${randomId}.stage`;
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
    const publication = await publishStaged(
      quarantinePath,
      "quarantine",
      runId,
      candidate,
      fragment,
    );
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
    const stagePath = path.join(phasesPath, `.phase-recovery.${runId}.${randomId}.stage`);
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
      runId,
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

  const journalBarrier = async <T>(
    runId: string,
    operation: (
      snapshot: RunJournalSnapshot | null,
      transition: (command: TransitionCommand) => Promise<TransitionResult>,
    ) => Promise<T>,
  ): Promise<T> => {
    try {
      return await withRunJournalBarrier(journalStore, runId, operation);
    } catch (error) {
      if (error instanceof RuntimeSkillError) throw error;
      if (error instanceof RuntimeJournalError) {
        if (error.code === "RUNTIME_STATE_STALE") stale();
        if (error.code === "RUNTIME_OPERATION_CONFLICT") conflict();
        if (
          error.code === "RUNTIME_JOURNAL_CORRUPT" ||
          error.code === "RUNTIME_JOURNAL_PATH_UNSAFE"
        ) {
          integrity();
        }
        unavailable();
      }
      throw error;
    }
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

    const journal = await journalStore.load(request.run_id);
    if (
      journal === null ||
      journal.state !== "RUNNING" ||
      !exactJournalHead(journal.head, request.expected_journal_head)
    ) {
      stale();
    }
    const snapshot = await options.loader.load(request.selection);
    validateLoadedSnapshot(request.selection, snapshot);
    enforcePredecessors(loaded.entries, request.phase, snapshot, request.execution_request_hash);
    const contextBudget = builtInPhaseContextBudget(request.phase, input.byteLength);
    await options.loader.assembleContext(request.selection, {
      snapshot,
      snapshot_hash: snapshot.document_hash,
      phase: request.phase,
      max_bytes: contextBudget.max_bytes,
      max_tokens: contextBudget.max_tokens,
    });
    return journalBarrier(request.run_id, async (currentJournal) => {
      if (
        currentJournal === null ||
        currentJournal.state !== "RUNNING" ||
        !exactJournalHead(currentJournal.head, request.expected_journal_head)
      ) {
        stale();
      }
      loaded = await loadExisting(request.run_id);
      if (latestOperation(loaded.entries, request.operation_id).length > 0) conflict();
      const predecessorPhaseHashes = enforcePredecessors(
        loaded.entries,
        request.phase,
        snapshot,
        request.execution_request_hash,
      );
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
        predecessor_phase_hashes: predecessorPhaseHashes,
        input_hash: inputHash,
        output_hash: null,
        occurred_at: options.now().toISOString(),
        trace: copyTrace(request.trace),
      });
      await appendRecord(request.run_id, loaded, started);
      return phaseOutcome(started, false);
    });
  };

  const completeInternal = async (
    request: CompleteSuperpowersPhaseRequest,
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
    const pending = operation.find((entry) => entry.status === "APPROVAL_PENDING");
    const terminal = operation.find(
      (entry) => entry.status !== "STARTED" && entry.status !== "APPROVAL_PENDING",
    );
    if (terminal !== undefined) {
      if (pending !== undefined && started.phase === "BRAINSTORMING") {
        if (
          request.expected_phase_revision !== started.phase_revision ||
          request.expected_phase_head_hash !== started.document_hash ||
          request.phase !== pending.phase ||
          request.skill_snapshot_hash !== pending.skill.snapshot_hash ||
          request.outcome !== "COMPLETED" ||
          pending.output_hash !== outputHash ||
          !exactJson(request.trace, pending.trace)
        ) {
          conflict();
        }
        return journalBarrier(request.run_id, (journal) => {
          if (journal === null) stale();
          const matches = approvalDecisionRecords(journal).filter(
            ({ metadata }) => metadata.phase.document_hash === terminal.document_hash,
          );
          if (matches.length !== 1) integrity();
          const record = matches[0]!;
          return Promise.resolve(
            decisionOutcome({
              phase: terminal,
              transition: Object.freeze({
                entry: record.entry,
                head: journalHeadForEntry(record.entry),
                replayed: true,
              }),
              approval: record.metadata.decision,
              replayed: true,
            }),
          );
        });
      }
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
    if (pending !== undefined) {
      if (
        request.expected_phase_revision !== started.phase_revision ||
        request.expected_phase_head_hash !== started.document_hash ||
        request.phase !== pending.phase ||
        request.skill_snapshot_hash !== pending.skill.snapshot_hash ||
        request.outcome !== "COMPLETED" ||
        pending.output_hash !== outputHash ||
        !exactJson(request.trace, pending.trace) ||
        loaded.entries.at(-1)?.document_hash !== pending.document_hash
      ) {
        conflict();
      }
      return journalBarrier(request.run_id, async (journal, transition) => {
        if (journal === null) stale();
        let result: TransitionResult;
        if (
          journal.state === "RUNNING" &&
          exactJournalHead(journal.head, pending.observed_journal_head)
        ) {
          result = await transition(approvalPendingCommand(pending));
          await hooks?.afterApprovalPendingJournalSync?.("APPROVAL_PENDING");
        } else if (journal.state === "APPROVAL_PENDING") {
          const metadata = pendingMetadata(journal.entries.at(-1)!);
          if (metadata.phase.document_hash !== pending.document_hash) integrity();
          result = Object.freeze({
            entry: journal.entries.at(-1)!,
            head: journal.head,
            replayed: true,
          });
        } else {
          stale();
        }
        return pendingOutcome({ phase: pending, transition: result, replayed: true });
      });
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
    return journalBarrier(request.run_id, async (journal, transition) => {
      if (
        journal === null ||
        journal.state !== "RUNNING" ||
        !exactJournalHead(journal.head, started.observed_journal_head)
      ) {
        stale();
      }
      const current = await loadExisting(request.run_id);
      if (current.entries.at(-1)?.document_hash !== started.document_hash) stale();
      if (
        handler.semantic.completion.approval === "REQUIRED" &&
        request.outcome === handler.semantic.completion.success_status
      ) {
        const pending = requestSuperpowersApproval({
          started,
          output_hash: outputHash,
          occurred_at: options.now().toISOString(),
          trace: request.trace,
        });
        const pendingCommand = approvalPendingCommand(pending);
        await appendRecord(request.run_id, current, pending);
        await hooks?.afterApprovalPendingPhaseSync?.("RUNNING");
        const result = await transition(pendingCommand);
        await hooks?.afterApprovalPendingJournalSync?.("APPROVAL_PENDING");
        return pendingOutcome({ phase: pending, transition: result, replayed: false });
      }
      const latest = current.entries.at(-1)!;
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
        predecessor_phase_hashes: started.predecessor_phase_hashes,
        input_hash: started.input_hash,
        output_hash: request.outcome === "COMPLETED" ? outputHash : null,
        occurred_at: options.now().toISOString(),
        trace: copyTrace(request.trace),
      });
      await appendRecord(request.run_id, current, completed);
      return phaseOutcome(completed, false);
    });
  };

  const resumeInternal = async (
    request: ResumeSuperpowersApprovalRequest,
  ): Promise<SuperpowersPhaseOutcome> => {
    return journalBarrier(request.run_id, async (journal, transition) => {
      if (journal === null) stale();
      let loaded = await loadExisting(request.run_id);
      const pending = [...loaded.entries]
        .reverse()
        .find((entry) => entry.status === "APPROVAL_PENDING");
      if (pending === undefined || pending.phase !== "BRAINSTORMING") stale();
      const terminal = loaded.entries.find(
        (entry) =>
          entry.previous_phase_hash === pending.document_hash &&
          entry.status !== "STARTED" &&
          entry.status !== "APPROVAL_PENDING",
      );

      const pendingMatches = journal.entries
        .filter((entry) => metadataKind(entry) === "superpowers-approval-pending")
        .map((entry) => Object.freeze({ entry, metadata: pendingMetadata(entry) }))
        .filter(({ metadata }) => metadata.phase.document_hash === pending.document_hash);
      if (pendingMatches.length !== 1) integrity();
      const pendingRecord = pendingMatches[0]!;
      const challenge = approvalRequest(pending, journalHeadForEntry(pendingRecord.entry));
      const exactBinding =
        request.run_id === challenge.run_id &&
        exactJournalHead(request.expected_journal_head, challenge.pending_journal_head) &&
        request.phase === challenge.phase &&
        request.skill_name === challenge.skill_name &&
        request.skill_version === challenge.skill_version &&
        request.skill_snapshot_hash === challenge.skill_snapshot_hash &&
        request.approval_request_hash === challenge.document_hash;
      if (!exactBinding) stale();

      const decision = approvalDecision(challenge, request);
      const decisions = approvalDecisionRecords(journal);
      const challengeDecisions = decisions.filter(
        ({ metadata }) => metadata.request.document_hash === challenge.document_hash,
      );
      if (challengeDecisions.length > 1) integrity();
      const decided = challengeDecisions[0];
      if (decided !== undefined) {
        if (decided.metadata.decision.operation_id !== request.operation_id) stale();
        if (decided.metadata.decision.document_hash !== decision.document_hash) conflict();
        if (terminal === undefined) {
          loaded = await loadExisting(request.run_id);
          if (loaded.entries.at(-1)?.document_hash !== pending.document_hash) integrity();
          await appendRecord(request.run_id, loaded, decided.metadata.phase);
          await hooks?.afterApprovalDecisionPhaseSync?.();
        } else if (terminal.document_hash !== decided.metadata.phase.document_hash) {
          integrity();
        }
        return decisionOutcome({
          phase: decided.metadata.phase,
          transition: Object.freeze({
            entry: decided.entry,
            head: journalHeadForEntry(decided.entry),
            replayed: true,
          }),
          approval: decided.metadata.decision,
          replayed: true,
        });
      }
      if (decisions.some(({ entry }) => entry.operation_id === request.operation_id)) conflict();
      if (terminal !== undefined) integrity();
      if (
        journal.state !== "APPROVAL_PENDING" ||
        !exactJournalHead(journal.head, journalHeadForEntry(pendingRecord.entry))
      ) {
        stale();
      }

      const completed = approvalTerminalPhase({
        pending,
        decision,
        occurred_at: options.now().toISOString(),
      });
      const result = await transition(
        approvalDecisionCommand({ request: challenge, decision, terminal: completed }),
      );
      await hooks?.afterApprovalDecisionJournalSync?.(
        decision.decision === "APPROVE" ? "RUNNING" : "BLOCKED",
      );
      loaded = await loadExisting(request.run_id);
      if (loaded.entries.at(-1)?.document_hash !== pending.document_hash) integrity();
      await appendRecord(request.run_id, loaded, completed);
      await hooks?.afterApprovalDecisionPhaseSync?.();
      return decisionOutcome({
        phase: completed,
        transition: result,
        approval: decision,
        replayed: false,
      });
    });
  };

  return {
    recover() {
      return accept(() =>
        schedule(async () => {
          ensureRoots();
          const names = scanNames(phasesPath, MAX_PHASE_HISTORY_FILES * 4 + 32);
          const runIds = new Set<string>();
          for (const journal of await journalStore.list()) runIds.add(journal.run_id);
          for (const name of names) {
            if (name === "quarantine") continue;
            const historyStage = HISTORY_STAGE_PATTERN.exec(name);
            const mutationStage = MUTATION_STAGE_PATTERN.exec(name);
            const lock = MUTATION_LOCK_PATTERN.exec(name);
            const tombstone = MUTATION_TOMBSTONE_PATTERN.exec(name);
            if (historyStage?.[1] !== undefined) {
              runIds.add(historyStage[1]);
              continue;
            }
            if (mutationStage?.[1] !== undefined) {
              runIds.add(mutationStage[1]);
              continue;
            }
            if (lock?.[1] !== undefined || tombstone?.[1] !== undefined) {
              const directories = openDirectoryChain(phasesPath, statePath, isCurrentUser);
              try {
                const exact = readMutationArtifact(path.join(phasesPath, name), directories);
                if (tombstone !== null && exact.links !== 1) pathUnsafe();
                const claim = parseMutationClaim(null, exact.bytes);
                const expectedRunHash = rawHash(Buffer.from(claim.run_id)).slice("sha256:".length);
                if ((lock?.[1] ?? tombstone?.[2]) !== expectedRunHash) integrity();
                if (
                  tombstone?.[5] !== undefined &&
                  rawHash(exact.bytes).slice("sha256:".length) !== tombstone[5]
                ) {
                  integrity();
                }
                runIds.add(claim.run_id);
              } finally {
                closeDirectoryChain(directories);
              }
              continue;
            }
            const match = HISTORY_NAME_PATTERN.exec(name);
            if (match?.[1] === undefined) pathUnsafe();
            runIds.add(match[1]);
          }
          if (privateDirectoryExists(quarantinePath, statePath, isCurrentUser)) {
            for (const name of scanNames(quarantinePath, MAX_PHASE_HISTORY_FILES * 2 + 1)) {
              const stage = QUARANTINE_STAGE_PATTERN.exec(name);
              if (stage?.[1] !== undefined) runIds.add(stage[1]);
              else if (!QUARANTINE_NAME_PATTERN.test(name)) pathUnsafe();
            }
          }
          for (const runId of [...runIds].sort((left, right) =>
            Buffer.from(left).compare(Buffer.from(right)),
          )) {
            await withMutationClaim(runId, async () => {
              await journalBarrier(runId, async (journal, transition) => {
                const loaded = await loadExisting(runId);
                const latest = loaded.entries.at(-1);
                if (latest === undefined) {
                  if (journal?.state === "APPROVAL_PENDING") integrity();
                  return;
                }
                const pending = [...loaded.entries]
                  .reverse()
                  .find((entry) => entry.status === "APPROVAL_PENDING");
                if (pending === undefined) {
                  if (
                    journal !== null &&
                    (approvalPendingRecords(journal).length > 0 ||
                      approvalDecisionRecords(journal).length > 0)
                  ) {
                    integrity();
                  }
                  return;
                }
                if (journal === null) integrity();
                const pendingMatches = approvalPendingRecords(journal).filter(
                  ({ metadata }) => metadata.phase.document_hash === pending.document_hash,
                );
                if (pendingMatches.length === 0) {
                  if (
                    latest.status === "APPROVAL_PENDING" &&
                    journal.state === "RUNNING" &&
                    exactJournalHead(journal.head, pending.observed_journal_head)
                  ) {
                    await transition(approvalPendingCommand(pending));
                    return;
                  }
                  integrity();
                }
                if (pendingMatches.length !== 1) integrity();
                const pendingRecord = pendingMatches[0]!;
                const decisions = approvalDecisionRecords(journal).filter(
                  ({ metadata }) => metadata.request.phase_document_hash === pending.document_hash,
                );
                if (decisions.length === 0) {
                  if (
                    latest.status !== "APPROVAL_PENDING" ||
                    journal.state !== "APPROVAL_PENDING" ||
                    !exactJournalHead(journal.head, journalHeadForEntry(pendingRecord.entry))
                  ) {
                    integrity();
                  }
                  return;
                }
                if (decisions.length !== 1) integrity();
                const decided = decisions[0]!;
                const terminals = loaded.entries.filter(
                  (entry) =>
                    entry.previous_phase_hash === pending.document_hash &&
                    entry.status !== "STARTED" &&
                    entry.status !== "APPROVAL_PENDING",
                );
                if (terminals.length === 0) {
                  if (latest.document_hash !== pending.document_hash) integrity();
                  await appendRecord(runId, loaded, decided.metadata.phase);
                  return;
                }
                if (
                  terminals.length !== 1 ||
                  terminals[0]!.document_hash !== decided.metadata.phase.document_hash
                ) {
                  integrity();
                }
              });
            });
          }
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
      if (!officialJournal)
        return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE"));
      if (intakeStopped) return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE"));
      let captured: CapturedStart;
      try {
        captured = captureStartRequest(request);
      } catch (error) {
        return Promise.reject(
          error instanceof RuntimeSkillError
            ? error
            : new RuntimeSkillError("RUNTIME_SKILL_INVALID"),
        );
      }
      return accept(() =>
        schedule(() =>
          withMutationClaim(captured.request.run_id, () =>
            startInternal(captured.request, captured.input, captured.inputHash),
          ),
        ),
      );
    },
    completePhase(request) {
      if (!officialJournal)
        return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE"));
      if (intakeStopped) return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE"));
      let captured: CapturedCompletion;
      try {
        captured = captureCompletionRequest(request);
      } catch (error) {
        return Promise.reject(
          error instanceof RuntimeSkillError
            ? error
            : new RuntimeSkillError("RUNTIME_SKILL_INVALID"),
        );
      }
      return accept(() =>
        schedule(() =>
          withMutationClaim(captured.request.run_id, () =>
            completeInternal(captured.request, captured.outputHash),
          ),
        ),
      );
    },
    resumeApproval(request) {
      if (!officialJournal)
        return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE"));
      if (intakeStopped) return Promise.reject(new RuntimeSkillError("RUNTIME_SKILL_UNAVAILABLE"));
      let captured: ResumeSuperpowersApprovalRequest;
      try {
        captured = captureResumeSuperpowersApprovalRequest(request);
      } catch (error) {
        return Promise.reject(
          error instanceof RuntimeSkillError
            ? error
            : new RuntimeSkillError("RUNTIME_SKILL_INVALID"),
        );
      }
      return accept(() =>
        schedule(() => withMutationClaim(captured.run_id, () => resumeInternal(captured))),
      );
    },
    phaseHistory(runId) {
      return accept(() =>
        schedule(() => withMutationClaim(runId, async () => (await loadExisting(runId)).entries)),
      );
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
