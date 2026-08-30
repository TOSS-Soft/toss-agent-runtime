import { realpath } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../protocol/json.js";
import { parseRunJournalEntry, ZERO_JOURNAL_HASH } from "./entry.js";
import { RuntimeJournalError } from "./errors.js";
import { createJournalFilesystem, type JournalFileSnapshot } from "./filesystem.js";
import {
  decideRunTransition,
  findUnresolvedSideEffects,
  RUN_TRANSITION_MATRIX,
  type TransitionCommand,
} from "./state-machine.js";
import type { JournalHead, RunJournalEntryV1, RunState, SideEffectRecord } from "./types.js";

export interface TransitionResult {
  readonly entry: RunJournalEntryV1;
  readonly head: JournalHead;
  readonly replayed: boolean;
}

export interface RunJournalSnapshot {
  readonly run_id: string;
  readonly state: RunState;
  readonly head: JournalHead;
  readonly entries: readonly RunJournalEntryV1[];
  readonly unresolved_side_effects: readonly SideEffectRecord[];
}

export interface CreateRunJournalStoreOptions {
  readonly statePath: string;
  readonly now: () => Date;
  readonly randomId: () => string;
}

export interface RunJournalStore {
  recover(): Promise<void>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
  transition(command: TransitionCommand): Promise<TransitionResult>;
  load(runId: string): Promise<RunJournalSnapshot | null>;
  list(): Promise<readonly RunJournalSnapshot[]>;
  unresolvedSideEffects(runId: string): Promise<readonly SideEffectRecord[]>;
  interruptActive(signal: AbortSignal): Promise<void>;
}

const INTERNAL_RUN_JOURNAL_BARRIER = Symbol("toss.run-journal-barrier");

interface OfficialRunJournalStore extends RunJournalStore {
  [INTERNAL_RUN_JOURNAL_BARRIER]<T>(
    runId: string,
    operation: (snapshot: RunJournalSnapshot | null) => Promise<T>,
  ): Promise<T>;
}

export function withRunJournalBarrier<T>(
  store: RunJournalStore,
  runId: string,
  operation: (snapshot: RunJournalSnapshot | null) => Promise<T>,
): Promise<T> {
  const barrier = (store as Partial<OfficialRunJournalStore>)[INTERNAL_RUN_JOURNAL_BARRIER];
  if (typeof barrier !== "function") {
    return Promise.reject(new RuntimeJournalError("RUNTIME_JOURNAL_UNAVAILABLE"));
  }
  return barrier.call(store, runId, operation) as Promise<T>;
}

interface ParsedJournal {
  readonly entries: readonly RunJournalEntryV1[];
  readonly validPrefixLength: number;
  readonly fragment: Uint8Array;
}

interface JournalCoordinator {
  readonly queues: Map<string, Promise<unknown>>;
}

const coordinatorInitializers = new Map<string, Promise<JournalCoordinator>>();
const coordinators = new Map<string, WeakRef<JournalCoordinator>>();
const coordinatorFinalizer = new FinalizationRegistry<string>((canonicalRoot) => {
  if (coordinators.get(canonicalRoot)?.deref() === undefined) {
    coordinators.delete(canonicalRoot);
  }
});

function coordinatorFor(filesystem: ReturnType<typeof createJournalFilesystem>) {
  const requestedRoot = path.resolve(filesystem.statePath);
  const existing = coordinatorInitializers.get(requestedRoot);
  if (existing !== undefined) return existing;

  const initialized = (async () => {
    await filesystem.ensureRoots();
    const canonicalRoot = await realpath(filesystem.statePath);
    let coordinator = coordinators.get(canonicalRoot)?.deref();
    if (coordinator === undefined) {
      coordinator = { queues: new Map() };
      coordinators.set(canonicalRoot, new WeakRef(coordinator));
      coordinatorFinalizer.register(coordinator, canonicalRoot);
    }
    return coordinator;
  })();
  coordinatorInitializers.set(requestedRoot, initialized);
  void initialized
    .finally(() => {
      if (coordinatorInitializers.get(requestedRoot) === initialized) {
        coordinatorInitializers.delete(requestedRoot);
      }
    })
    .catch(() => undefined);
  return initialized;
}

function corrupt(): never {
  throw new RuntimeJournalError("RUNTIME_JOURNAL_CORRUPT");
}

function journalLine(entry: RunJournalEntryV1): Uint8Array {
  return Buffer.from(`${canonicalJson(entry)}\n`, "utf8");
}

function head(entry: RunJournalEntryV1): JournalHead {
  return Object.freeze({
    journal_revision: entry.journal_revision,
    sequence: entry.sequence,
    entry_hash: entry.entry_hash,
  });
}

function expectedAttempt(previous: RunJournalEntryV1, current: RunJournalEntryV1): number {
  if (
    current.state === "RUNNING" &&
    (previous.state === "FAILED" ||
      previous.state === "BLOCKED" ||
      previous.state === "INTERRUPTED")
  ) {
    return previous.run_attempt + 1;
  }
  return previous.run_attempt;
}

function validateHistory(runId: string, entries: readonly RunJournalEntryV1[]): void {
  const commandIds = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (
      entry.run_id !== runId ||
      entry.sequence !== index + 1 ||
      entry.journal_revision !== index + 1 ||
      commandIds.has(entry.command_id)
    ) {
      corrupt();
    }
    commandIds.add(entry.command_id);
    const previous = entries[index - 1];
    if (previous === undefined) {
      if (
        entry.previous_entry_hash !== ZERO_JOURNAL_HASH ||
        entry.previous_state !== null ||
        entry.state !== "CREATED" ||
        entry.run_attempt !== 1
      ) {
        corrupt();
      }
      continue;
    }
    if (
      entry.previous_entry_hash !== previous.entry_hash ||
      entry.previous_state !== previous.state ||
      !(RUN_TRANSITION_MATRIX[previous.state] as readonly RunState[]).includes(entry.state) ||
      entry.run_attempt !== expectedAttempt(previous, entry)
    ) {
      corrupt();
    }
  }
  try {
    findUnresolvedSideEffects(entries);
  } catch {
    corrupt();
  }
}

function parseJournal(runId: string, bytes: Uint8Array): ParsedJournal {
  const buffer = Buffer.from(bytes);
  if (buffer.length === 0) corrupt();
  const finalNewline = buffer.lastIndexOf(0x0a);
  const validPrefixLength = finalNewline < 0 ? 0 : finalNewline + 1;
  const complete = buffer.subarray(0, validPrefixLength);
  const fragment = buffer.subarray(validPrefixLength);
  const entries: RunJournalEntryV1[] = [];
  if (complete.length > 0) {
    let start = 0;
    for (let end = 0; end < complete.length; end += 1) {
      if (complete[end] !== 0x0a) continue;
      const line = complete.subarray(start, end);
      const parsed = parseRunJournalEntry(line);
      if (!parsed.ok) corrupt();
      if (!Buffer.from(canonicalJson(parsed.value), "utf8").equals(line)) {
        corrupt();
      }
      entries.push(parsed.value);
      start = end + 1;
    }
  }
  validateHistory(runId, entries);
  return {
    entries: Object.freeze(entries),
    validPrefixLength,
    fragment: Buffer.from(fragment),
  };
}

function snapshotOf(
  runId: string,
  entries: readonly RunJournalEntryV1[],
): RunJournalSnapshot | null {
  const latest = entries.at(-1);
  if (latest === undefined) return null;
  return Object.freeze({
    run_id: runId,
    state: latest.state,
    head: head(latest),
    entries,
    unresolved_side_effects: findUnresolvedSideEffects(entries),
  });
}

function isCorrupt(error: unknown): boolean {
  return error instanceof RuntimeJournalError && error.code === "RUNTIME_JOURNAL_CORRUPT";
}

function activeState(state: RunState): boolean {
  return (
    state === "CREATED" ||
    state === "ROUTED" ||
    state === "RUNNING" ||
    state === "TOOL_PENDING" ||
    state === "APPROVAL_PENDING" ||
    state === "REVIEW_PENDING"
  );
}

export function createRunJournalStore(options: CreateRunJournalStoreOptions): RunJournalStore {
  const filesystem = createJournalFilesystem({
    statePath: options.statePath,
    now: options.now,
    randomId: options.randomId,
  });
  const coordinator = coordinatorFor(filesystem);
  const pending = new Set<Promise<unknown>>();
  const corruptRuns = new Set<string>();
  let intakeStopped = false;

  const enqueue = <T>(runId: string, operation: () => Promise<T>): Promise<T> => {
    const scheduled = coordinator.then(async (shared) => {
      const previous = shared.queues.get(runId) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(operation);
      shared.queues.set(runId, current);
      try {
        return await current;
      } finally {
        if (shared.queues.get(runId) === current) shared.queues.delete(runId);
      }
    });
    pending.add(scheduled);
    void scheduled
      .finally(() => {
        pending.delete(scheduled);
      })
      .catch(() => undefined);
    return scheduled;
  };

  const loadInternal = async (runId: string): Promise<RunJournalSnapshot | null> => {
    if (corruptRuns.has(runId)) corrupt();
    let file: JournalFileSnapshot | null;
    try {
      file = await filesystem.read(runId);
      if (file === null) return null;
      let parsed = parseJournal(runId, file.bytes);
      if (parsed.fragment.length > 0) {
        if (parsed.entries.length === 0) corrupt();
        await filesystem.recoverPartial(
          runId,
          file.identity,
          file.bytes.subarray(0, parsed.validPrefixLength),
          parsed.fragment,
        );
        file = await filesystem.read(runId);
        if (file === null) corrupt();
        parsed = parseJournal(runId, file.bytes);
        if (parsed.fragment.length > 0) corrupt();
      }
      return snapshotOf(runId, parsed.entries);
    } catch (error) {
      if (isCorrupt(error)) corruptRuns.add(runId);
      throw error;
    }
  };

  const appendInternal = async (command: TransitionCommand): Promise<TransitionResult> => {
    let current = await loadInternal(command.run_id);
    let decision = decideRunTransition(current?.entries ?? [], command, options.now);
    if (decision.kind === "replay") {
      return { entry: decision.entry, head: head(decision.entry), replayed: true };
    }
    const bytes = journalLine(decision.entry);
    if (current === null) {
      const publication = await filesystem.create(command.run_id, bytes);
      if (publication === "existing") {
        current = await loadInternal(command.run_id);
        decision = decideRunTransition(current?.entries ?? [], command, options.now);
        if (decision.kind === "replay") {
          return { entry: decision.entry, head: head(decision.entry), replayed: true };
        }
        throw new RuntimeJournalError("RUNTIME_STATE_STALE");
      }
    } else {
      const file = await filesystem.read(command.run_id);
      if (file === null) throw new RuntimeJournalError("RUNTIME_STATE_STALE");
      const observed = parseJournal(command.run_id, file.bytes);
      const observedSnapshot = snapshotOf(command.run_id, observed.entries);
      if (
        observed.fragment.length > 0 ||
        observedSnapshot === null ||
        observedSnapshot.head.journal_revision !== current.head.journal_revision ||
        observedSnapshot.head.entry_hash !== current.head.entry_hash
      ) {
        throw new RuntimeJournalError("RUNTIME_STATE_STALE");
      }
      await filesystem.append(command.run_id, file, bytes);
    }
    return { entry: decision.entry, head: head(decision.entry), replayed: false };
  };

  const listInternal = async (): Promise<readonly RunJournalSnapshot[]> => {
    const result: RunJournalSnapshot[] = [];
    for (const runId of await filesystem.listRunIds()) {
      try {
        const loaded = await enqueue(runId, () => loadInternal(runId));
        if (loaded !== null) result.push(loaded);
      } catch (error) {
        if (!isCorrupt(error)) throw error;
      }
    }
    return Object.freeze(result);
  };

  const store: OfficialRunJournalStore = {
    [INTERNAL_RUN_JOURNAL_BARRIER](runId, operation) {
      if (intakeStopped) {
        return Promise.reject(new RuntimeJournalError("RUNTIME_JOURNAL_UNAVAILABLE"));
      }
      return enqueue(runId, async () => operation(await loadInternal(runId)));
    },
    async recover() {
      await coordinator;
      await listInternal();
    },
    stopIntake() {
      intakeStopped = true;
    },
    async flush(signal) {
      if (signal.aborted || pending.size === 0) return;
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
    },
    transition(command) {
      if (intakeStopped) {
        return Promise.reject(new RuntimeJournalError("RUNTIME_JOURNAL_UNAVAILABLE"));
      }
      return enqueue(command.run_id, () => appendInternal(command));
    },
    load(runId) {
      return enqueue(runId, () => loadInternal(runId));
    },
    list: listInternal,
    async unresolvedSideEffects(runId) {
      return (await enqueue(runId, () => loadInternal(runId)))?.unresolved_side_effects ?? [];
    },
    async interruptActive(signal) {
      const journals = await listInternal();
      for (const journal of journals) {
        if (signal.aborted) return;
        if (!activeState(journal.state)) continue;
        const interruption = (current: RunJournalSnapshot): TransitionCommand => ({
          run_id: current.run_id,
          expected_revision: current.head.journal_revision,
          expected_head_hash: current.head.entry_hash,
          command_id: `shutdown:${current.head.journal_revision}:${current.head.entry_hash.slice("sha256:".length)}`,
          operation_id: null,
          next_state: "INTERRUPTED",
          reason_code: "SERVICE_SHUTDOWN",
          trace: current.entries.at(-1)!.trace,
          metadata: {},
          side_effect: null,
        });
        try {
          await enqueue(journal.run_id, () => appendInternal(interruption(journal)));
        } catch (error) {
          if (!(error instanceof RuntimeJournalError) || error.code !== "RUNTIME_STATE_STALE") {
            throw error;
          }
          const reloaded = await enqueue(journal.run_id, () => loadInternal(journal.run_id));
          if (reloaded !== null && activeState(reloaded.state)) {
            await enqueue(journal.run_id, () => appendInternal(interruption(reloaded)));
          }
        }
      }
    },
  };
  return store;
}
