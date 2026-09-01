import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashRunJournalEntry, ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import { createRunJournalStore, type RunJournalStore } from "../src/journal/store.js";
import type { TransitionCommand } from "../src/journal/state-machine.js";
import type {
  HashableRunJournalEntryV1,
  JournalHead,
  RunJournalEntryV1,
  RunState,
} from "../src/journal/types.js";
import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonValue,
} from "../src/protocol/json.js";
import type { SkillCatalog, SkillSelection } from "../src/skills/catalog.js";
import { hashSkillCatalog, hashSkillPackage } from "../src/skills/contracts.js";
import {
  createSkillsEngineForTest,
  type CompleteSuperpowersPhaseRequest,
  type PhaseHistoryOperationHooks,
  type SkillsEngine,
  type StartSuperpowersPhaseRequest,
} from "../src/skills/engine.js";
import { RuntimeSkillError } from "../src/skills/errors.js";
import type { SkillLoader } from "../src/skills/loader.js";
import { createSkillsRuntimeHostForTest } from "../src/skills/runtime-host.js";
import type {
  ResumeSuperpowersApprovalRequest,
  SuperpowersApprovalOutcome,
} from "../src/skills/approval.js";
import {
  approvalDecision,
  approvalDecisionCommand,
  approvalPendingCommand,
  approvalRequest,
  approvalTerminalPhase,
  decisionMetadata,
  requestSuperpowersApproval,
} from "../src/skills/approval.js";
import type { SkillSnapshotV1, SuperpowersPhaseV1 } from "../src/skills/types.js";

const roots: string[] = [];
const TRACE = {
  trace_id: "1".repeat(32),
  span_id: "2".repeat(16),
  trace_flags: 1,
} as const;
const EXECUTION_REQUEST_HASH = `sha256:${"e".repeat(64)}` as const;
const APPROVAL_OPERATION_ID = "a0000000-0000-4000-8000-000000000777";

function rawHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function document<T extends Record<string, unknown>>(
  value: T,
): T & { document_hash: `sha256:${string}` } {
  return { ...value, document_hash: sha256(value) };
}

function resignDocument<T extends Record<string, unknown>>(value: T): T {
  const hashable = { ...value };
  delete hashable.document_hash;
  return { ...hashable, document_hash: sha256(hashable) };
}

function brainstormingSnapshot(version = "1.0.0"): SkillSnapshotV1 {
  const bytes = Buffer.from("# brainstorming\n", "utf8");
  const descriptorBase = {
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "skill-descriptor.v1" as const,
    document_type: "skill-descriptor" as const,
    name: "brainstorming",
    description: "brainstorming fixture",
    version,
    source: { kind: "bundled" as const, identity: "brainstorming" },
    package_hash: `sha256:${"0".repeat(64)}` as const,
    resource_count: 0,
    total_bytes: bytes.byteLength,
    required_runtime_capabilities: [] as const,
  };
  const packageHash = hashSkillPackage({
    descriptor: document(descriptorBase),
    skill_markdown_hash: rawHash(bytes),
    skill_markdown_bytes: bytes.byteLength,
    resources: [],
  });
  const descriptor = document({ ...descriptorBase, package_hash: packageHash });
  return document({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "skill-snapshot.v1" as const,
    document_type: "skill-snapshot" as const,
    descriptor,
    skill_markdown_hash: rawHash(bytes),
    skill_markdown_bytes: bytes.byteLength,
    resources: [],
    package_hash: packageHash,
    total_bytes: bytes.byteLength,
  });
}

function selection(snapshot: SkillSnapshotV1): SkillSelection {
  const descriptors = [snapshot.descriptor];
  const catalogHash = hashSkillCatalog(
    descriptors.map((descriptor) => ({
      name: descriptor.name,
      version: descriptor.version,
      source: descriptor.source,
      package_hash: descriptor.package_hash,
      document_hash: descriptor.document_hash,
    })),
  );
  return deepFreezeJson({
    descriptor: snapshot.descriptor,
    catalog_hash: catalogHash,
    catalog_root: parseJsonBytes(canonicalJson({ descriptors, catalog_hash: catalogHash })),
    package_handle: sha256({ name: snapshot.descriptor.name }),
  } as unknown as JsonValue) as unknown as SkillSelection;
}

function fakeCatalog(): SkillCatalog {
  return {
    discover: () => Promise.resolve(Object.freeze({ descriptors: [], catalog_hash: sha256([]) })),
    select: () => {
      throw new Error("selection fixture is not configured");
    },
  };
}

function fakeLoader(snapshot: SkillSnapshotV1): SkillLoader {
  const exact = (selected: SkillSelection): SkillSnapshotV1 => {
    if (selected.descriptor.document_hash !== snapshot.descriptor.document_hash) {
      throw new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY");
    }
    return snapshot;
  };
  return {
    recover: () => Promise.resolve(),
    retainCatalogRoot: () => Promise.resolve(),
    load: (selected) => Promise.resolve(exact(selected)),
    assembleContext: (selected, request) => {
      const value = exact(selected);
      if (request.snapshot !== value || request.snapshot_hash !== value.document_hash) {
        throw new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY");
      }
      return Promise.resolve(
        Object.freeze({
          snapshot: Object.freeze({
            name: value.descriptor.name,
            version: value.descriptor.version,
            package_hash: value.package_hash,
            snapshot_hash: value.document_hash,
          }),
          phase: request.phase,
          segments: [
            {
              path: "SKILL.md",
              role: "skill" as const,
              source_hash: value.skill_markdown_hash,
              included_hash: value.skill_markdown_hash,
              original_bytes: value.skill_markdown_bytes,
              included_bytes: value.skill_markdown_bytes,
              conservative_tokens: Math.ceil(value.skill_markdown_bytes / 4),
              content: "",
            },
          ],
          included_resource_hashes: [],
          omitted_resource_hashes: [],
          original_utf8_bytes: value.skill_markdown_bytes,
          included_utf8_bytes: value.skill_markdown_bytes,
          original_tokens: Math.ceil(value.skill_markdown_bytes / 4),
          included_tokens: Math.ceil(value.skill_markdown_bytes / 4),
          remaining_bytes: request.max_bytes - value.skill_markdown_bytes,
          remaining_tokens: request.max_tokens - Math.ceil(value.skill_markdown_bytes / 4),
          truncations: [],
          resource_accounting: [],
          context_hash: sha256({ phase: request.phase }),
        }),
      );
    },
  };
}

function clock(): () => Date {
  let value = 0;
  return () => new Date(Date.UTC(2026, 7, 30, 12, 0, value++));
}

function ids(offset = 0): () => string {
  let value = offset;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

async function fixture(): Promise<{ readonly statePath: string }> {
  const root = await mkdtemp(path.join(await realpath("/tmp"), "toss-skill-approval-"));
  roots.push(root);
  return { statePath: path.join(root, "state") };
}

function journalCommand(
  runId: string,
  state: RunState,
  head: JournalHead | null,
): TransitionCommand {
  return {
    run_id: runId,
    expected_revision: head?.journal_revision ?? 0,
    expected_head_hash: head?.entry_hash ?? ZERO_JOURNAL_HASH,
    command_id: `${runId}-${state.toLowerCase()}`,
    operation_id: null,
    next_state: state,
    reason_code: `MOVE_${state}`,
    trace: TRACE,
    metadata: {},
    side_effect: null,
  };
}

async function runningJournal(
  statePath: string,
): Promise<{ readonly journal: RunJournalStore; readonly head: JournalHead }> {
  const journal = createRunJournalStore({ statePath, now: clock(), randomId: ids(100) });
  let head: JournalHead | null = null;
  for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
    head = (await journal.transition(journalCommand("run-1", state, head))).head;
  }
  if (head === null) throw new Error("running journal fixture did not produce a head");
  return { journal, head };
}

function engine(
  statePath: string,
  journal: RunJournalStore,
  snapshot: SkillSnapshotV1,
  options: {
    readonly hooks?: PhaseHistoryOperationHooks;
    readonly idOffset?: number;
  } = {},
): SkillsEngine {
  return createSkillsEngineForTest({
    statePath,
    journal,
    catalog: fakeCatalog(),
    loader: fakeLoader(snapshot),
    now: clock(),
    randomId: ids(options.idOffset ?? 200),
    hasServiceListener: () => Promise.resolve("absent"),
    ...(options.hooks === undefined ? {} : { historyHooks: options.hooks }),
  });
}

function startRequest(head: JournalHead, snapshot: SkillSnapshotV1): StartSuperpowersPhaseRequest {
  return {
    run_id: "run-1",
    expected_journal_head: head,
    execution_request_hash: EXECUTION_REQUEST_HASH,
    selection: selection(snapshot),
    phase: "BRAINSTORMING",
    input: Buffer.from("brainstorming input", "utf8"),
    operation_id: "brainstorm-phase",
    trace: TRACE,
  };
}

function completeRequest(
  started: Awaited<ReturnType<SkillsEngine["startPhase"]>>,
): CompleteSuperpowersPhaseRequest {
  return {
    run_id: started.phase.run_id,
    expected_phase_revision: started.phase.phase_revision,
    expected_phase_head_hash: started.phase.document_hash,
    phase: started.phase.phase,
    skill_snapshot_hash: started.phase.skill.snapshot_hash,
    operation_id: started.phase.operation_id,
    outcome: "COMPLETED",
    terminal_code: null,
    output: Buffer.from("approved plan", "utf8"),
    trace: TRACE,
  };
}

function resumeRequest(
  pending: SuperpowersApprovalOutcome,
  decision: "APPROVE" | "REJECT" = "APPROVE",
  operationId = APPROVAL_OPERATION_ID,
): ResumeSuperpowersApprovalRequest {
  if (pending.approval.kind !== "REQUEST") throw new Error("expected approval request");
  return {
    run_id: pending.approval.run_id,
    expected_journal_head: pending.approval.pending_journal_head,
    phase: pending.approval.phase,
    skill_name: pending.approval.skill_name,
    skill_version: pending.approval.skill_version,
    skill_snapshot_hash: pending.approval.skill_snapshot_hash,
    approval_request_hash: pending.approval.document_hash,
    operation_id: operationId,
    decision,
    trace: TRACE,
  };
}

async function pendingApproval(options: {
  readonly statePath: string;
  readonly journal: RunJournalStore;
  readonly head: JournalHead;
  readonly snapshot: SkillSnapshotV1;
  readonly hooks?: PhaseHistoryOperationHooks;
}): Promise<{
  readonly host: SkillsEngine;
  readonly completion: CompleteSuperpowersPhaseRequest;
  readonly pending: SuperpowersApprovalOutcome;
}> {
  const host = engine(options.statePath, options.journal, options.snapshot, {
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  const started = await host.startPhase(startRequest(options.head, options.snapshot));
  const completion = completeRequest(started);
  const pending = await host.completePhase(completion);
  if (pending.approval === null) throw new Error("approval challenge was not returned");
  return { host, completion, pending: pending as SuperpowersApprovalOutcome };
}

function nextApprovalPhases(options: {
  readonly previous: SuperpowersPhaseV1;
  readonly observedHead: JournalHead;
  readonly operationId: string;
  readonly decisionOperationId: string;
  readonly decision: "APPROVE" | "REJECT";
}): Readonly<{
  started: SuperpowersPhaseV1;
  pending: SuperpowersPhaseV1;
  terminal: SuperpowersPhaseV1;
  decisionRequest: ResumeSuperpowersApprovalRequest;
}> {
  const started = resignDocument({
    ...options.previous,
    phase_revision: options.previous.phase_revision + 1,
    previous_phase_hash: options.previous.document_hash,
    observed_journal_head: options.observedHead,
    operation_id: options.operationId,
    status: "STARTED",
    output_hash: null,
    occurred_at: "2026-08-30T13:00:00.000Z",
  }) as SuperpowersPhaseV1;
  const pending = requestSuperpowersApproval({
    started,
    output_hash: rawHash(Buffer.from(`plan:${options.operationId}`, "utf8")),
    occurred_at: "2026-08-30T13:00:01.000Z",
    trace: TRACE,
  });
  const placeholderHead = Object.freeze({
    journal_revision: options.observedHead.journal_revision + 1,
    sequence: options.observedHead.sequence + 1,
    entry_hash: `sha256:${"f".repeat(64)}` as const,
  });
  const challenge = approvalRequest(pending, placeholderHead);
  const decisionRequest = {
    run_id: challenge.run_id,
    expected_journal_head: challenge.pending_journal_head,
    phase: challenge.phase,
    skill_name: challenge.skill_name,
    skill_version: challenge.skill_version,
    skill_snapshot_hash: challenge.skill_snapshot_hash,
    approval_request_hash: challenge.document_hash,
    operation_id: options.decisionOperationId,
    decision: options.decision,
    trace: TRACE,
  } as const;
  const decision = approvalDecision(challenge, decisionRequest);
  return Object.freeze({
    started,
    pending,
    terminal: approvalTerminalPhase({
      pending,
      decision,
      occurred_at: "2026-08-30T13:00:02.000Z",
    }),
    decisionRequest,
  });
}

async function appendUnlinkedJournalApproval(options: {
  readonly journal: RunJournalStore;
  readonly previous: SuperpowersPhaseV1;
  readonly head: JournalHead;
  readonly operationId: string;
  readonly decisionOperationId: string;
  readonly decision?: "APPROVE" | "REJECT";
}): Promise<
  Readonly<{ head: JournalHead; started: SuperpowersPhaseV1; pending: SuperpowersPhaseV1 }>
> {
  const phases = nextApprovalPhases({
    previous: options.previous,
    observedHead: options.head,
    operationId: options.operationId,
    decisionOperationId: options.decisionOperationId,
    decision: options.decision ?? "APPROVE",
  });
  const pendingTransition = await options.journal.transition(
    approvalPendingCommand(phases.pending),
  );
  if (options.decision === undefined) {
    return Object.freeze({ ...phases, head: pendingTransition.head });
  }
  const request = approvalRequest(phases.pending, pendingTransition.head);
  const decision = approvalDecision(request, {
    ...phases.decisionRequest,
    expected_journal_head: pendingTransition.head,
    approval_request_hash: request.document_hash,
  });
  const terminal = approvalTerminalPhase({
    pending: phases.pending,
    decision,
    occurred_at: "2026-08-30T13:00:02.000Z",
  });
  const decided = await options.journal.transition(
    approvalDecisionCommand({ request, decision, terminal }),
  );
  return Object.freeze({ ...phases, head: decided.head });
}

async function expectGlobalApprovalIntegrityFailure(options: {
  readonly statePath: string;
  readonly journal: RunJournalStore;
  readonly snapshot: SkillSnapshotV1;
  readonly host: SkillsEngine;
  readonly completion: CompleteSuperpowersPhaseRequest;
  readonly resume: ResumeSuperpowersApprovalRequest;
  readonly currentHead: JournalHead;
}): Promise<void> {
  const phasePath = path.join(options.statePath, "skills", "phases", "run-1.jsonl");
  const journalPath = path.join(options.statePath, "journals", "run-1", "events.jsonl");
  const before = [await readFile(phasePath), await readFile(journalPath)] as const;
  const restarted = engine(options.statePath, options.journal, options.snapshot, {
    idOffset: 1_300,
  });
  const operations = [
    () => options.host.resumeApproval(options.resume),
    () => options.host.completePhase(options.completion),
    () => options.host.phaseHistory("run-1"),
    () =>
      options.host.startPhase({
        ...startRequest(options.currentHead, options.snapshot),
        operation_id: "fresh-after-unlinked-approval",
      }),
    () => restarted.recover(),
  ] as const;

  for (const operation of operations) {
    await expect(operation()).rejects.toMatchObject({
      code: "RUNTIME_SKILL_INTEGRITY",
    });
  }
  expect(await readFile(phasePath)).toEqual(before[0]);
  expect(await readFile(journalPath)).toEqual(before[1]);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("durable Superpowers approval transaction", { timeout: 20_000 }, () => {
  it("persists phase-first pending state and exposes one exact challenge only after both barriers", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const observed: string[] = [];
    const { host, pending } = await pendingApproval({
      statePath,
      journal,
      head,
      snapshot,
      hooks: {
        afterApprovalPendingPhaseSync: (state) => {
          observed.push(state);
        },
        afterApprovalPendingJournalSync: (state) => {
          observed.push(state);
        },
      },
    });

    expect(observed).toEqual(["RUNNING", "APPROVAL_PENDING"]);
    expect(pending).toMatchObject({
      state: "APPROVAL_PENDING",
      replayed: false,
      phase: { status: "APPROVAL_PENDING", output_hash: rawHash(Buffer.from("approved plan")) },
      journal_head: { journal_revision: head.journal_revision + 1 },
      approval: {
        kind: "REQUEST",
        decision: null,
        pending_journal_head: { journal_revision: head.journal_revision + 1 },
        phase_operation_id: "brainstorm-phase",
      },
    });
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending.approval)).toBe(true);
    expect(await host.phaseHistory("run-1")).toHaveLength(2);
    const loaded = await journal.load("run-1");
    expect(loaded?.state).toBe("APPROVAL_PENDING");
    expect(loaded?.entries.at(-1)?.metadata).toMatchObject({
      kind: "superpowers-approval-pending",
      phase: pending.phase,
    });
  });

  it("persists and recovers approval for the maximum phase operation identifier", async () => {
    const maximumOperationId = `p${"x".repeat(127)}`;
    for (const crashAfterPhase of [false, true]) {
      const { statePath } = await fixture();
      const { journal, head } = await runningJournal(statePath);
      const snapshot = brainstormingSnapshot();
      let crash = crashAfterPhase;
      const host = engine(statePath, journal, snapshot, {
        hooks: {
          afterApprovalPendingPhaseSync: () => {
            if (crash) throw new Error("crash:maximum-operation");
          },
        },
      });
      const started = await host.startPhase({
        ...startRequest(head, snapshot),
        operation_id: maximumOperationId,
      });
      const completion = completeRequest(started);
      if (crashAfterPhase) {
        await expect(host.completePhase(completion)).rejects.toThrow("crash:maximum-operation");
        crash = false;
      } else {
        await expect(host.completePhase(completion)).resolves.toMatchObject({
          state: "APPROVAL_PENDING",
        });
      }

      const restarted = engine(statePath, journal, snapshot, { idOffset: 575 });
      await restarted.recover();
      const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
      const journalPath = path.join(statePath, "journals", "run-1", "events.jsonl");
      const before = [(await lstat(phasePath)).size, (await lstat(journalPath)).size] as const;
      const replay = await restarted.completePhase(completion);

      expect(replay).toMatchObject({
        state: "APPROVAL_PENDING",
        replayed: true,
        phase: { operation_id: maximumOperationId },
      });
      const pendingEntry = (await journal.load("run-1"))?.entries.at(-1);
      expect(pendingEntry).toMatchObject({
        operation_id: maximumOperationId,
      });
      expect(pendingEntry?.command_id).toMatch(/^approval-pending:sha256:[0-9a-f]{64}$/u);
      expect(pendingEntry?.command_id).toHaveLength(88);
      expect(pendingEntry?.command_id).not.toContain(maximumOperationId);
      expect([(await lstat(phasePath)).size, (await lstat(journalPath)).size]).toEqual(before);
    }
  });

  it.each([`p${"x".repeat(128)}`, `p${"x".repeat(126)}é`] as const)(
    "rejects an over-bound or non-ASCII phase operation identifier before persistence",
    async (operationId) => {
      const { statePath } = await fixture();
      const { journal, head } = await runningJournal(statePath);
      const snapshot = brainstormingSnapshot();
      const host = engine(statePath, journal, snapshot);

      await expect(
        host.startPhase({ ...startRequest(head, snapshot), operation_id: operationId }),
      ).rejects.toMatchObject({ code: "RUNTIME_SKILL_INVALID" });
      await expect(host.phaseHistory("run-1")).resolves.toEqual([]);
    },
  );

  it("reconstructs a byte-identical challenge after restart without growing either history", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const first = await pendingApproval({ statePath, journal, head, snapshot });
    const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    const journalPath = path.join(statePath, "journals", "run-1", "events.jsonl");
    const before = [(await lstat(phasePath)).size, (await lstat(journalPath)).size] as const;

    const restarted = engine(statePath, journal, snapshot, { idOffset: 500 });
    await restarted.recover();
    const replay = await restarted.completePhase(first.completion);

    expect(replay).toEqual({ ...first.pending, replayed: true });
    expect([(await lstat(phasePath)).size, (await lstat(journalPath)).size]).toEqual(before);
  });

  it("accepts every exact binding, durably binds the decision, and replays without growth", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, pending } = await pendingApproval({ statePath, journal, head, snapshot });
    const request = resumeRequest(pending);
    const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    const journalPath = path.join(statePath, "journals", "run-1", "events.jsonl");

    const approved = await host.resumeApproval(request);
    const after = [(await lstat(phasePath)).size, (await lstat(journalPath)).size] as const;
    const replay = await host.resumeApproval(request);

    expect(approved).toMatchObject({
      state: "RUNNING",
      replayed: false,
      phase: { status: "COMPLETED", output_hash: pending.phase.output_hash },
      approval: { kind: "DECISION", decision: "APPROVE", operation_id: request.operation_id },
    });
    expect((await journal.load("run-1"))?.state).toBe("RUNNING");
    expect(await host.phaseHistory("run-1")).toHaveLength(3);
    expect(replay).toEqual({ ...approved, replayed: true });
    expect([(await lstat(phasePath)).size, (await lstat(journalPath)).size]).toEqual(after);
  });

  it("replays the original brainstorming completion as the exact durable approval decision", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, completion, pending } = await pendingApproval({
      statePath,
      journal,
      head,
      snapshot,
    });
    const approved = await host.resumeApproval(resumeRequest(pending));

    await expect(host.completePhase(completion)).resolves.toEqual({
      ...approved,
      replayed: true,
    });
  });

  it("replays the exact durable decision after unrelated journal advancement", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, completion, pending } = await pendingApproval({
      statePath,
      journal,
      head,
      snapshot,
    });
    const request = resumeRequest(pending);
    const approved = await host.resumeApproval(request);
    const advanced = await journal.transition(
      journalCommand("run-1", "REVIEW_PENDING", approved.journal_head),
    );
    const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    const journalPath = path.join(statePath, "journals", "run-1", "events.jsonl");
    const before = [(await lstat(phasePath)).size, (await lstat(journalPath)).size] as const;

    await expect(host.resumeApproval(request)).resolves.toEqual({ ...approved, replayed: true });
    await expect(host.completePhase(completion)).resolves.toEqual({ ...approved, replayed: true });
    await expect(host.phaseHistory("run-1")).resolves.toEqual([
      expect.objectContaining({ status: "STARTED" }),
      expect.objectContaining({ status: "APPROVAL_PENDING" }),
      expect.objectContaining({ status: "COMPLETED" }),
    ]);
    expect([(await lstat(phasePath)).size, (await lstat(journalPath)).size]).toEqual(before);
    expect((await journal.load("run-1"))?.head).toEqual(advanced.head);
  });

  it("rejects a live replay when a later command-only entry claims approval pending", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, completion, pending } = await pendingApproval({
      statePath,
      journal,
      head,
      snapshot,
    });
    const request = resumeRequest(pending);
    const approved = await host.resumeApproval(request);
    await journal.transition({
      ...journalCommand("run-1", "APPROVAL_PENDING", approved.journal_head),
      command_id: `approval-pending:sha256:${"a".repeat(64)}`,
      reason_code: "MOVE_APPROVAL_PENDING",
      metadata: {},
    });
    const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    const journalPath = path.join(statePath, "journals", "run-1", "events.jsonl");
    const before = [await readFile(phasePath), await readFile(journalPath)] as const;

    const results = await Promise.allSettled([
      host.resumeApproval(request),
      host.completePhase(completion),
      host.phaseHistory("run-1"),
    ]);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: { code: "RUNTIME_SKILL_INTEGRITY" },
      });
    }
    expect(await readFile(phasePath)).toEqual(before[0]);
    expect(await readFile(journalPath)).toEqual(before[1]);
  });

  it("rejects one extra canonical approval-pending journal projection with no phase record", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, completion, pending } = await pendingApproval({
      statePath,
      journal,
      head,
      snapshot,
    });
    const resume = resumeRequest(pending);
    const approved = await host.resumeApproval(resume);
    const extra = await appendUnlinkedJournalApproval({
      journal,
      previous: approved.phase,
      head: approved.journal_head,
      operationId: "unlinked-pending-phase",
      decisionOperationId: "a0000000-0000-4000-8000-000000000801",
    });

    await expectGlobalApprovalIntegrityFailure({
      statePath,
      journal,
      snapshot,
      host,
      completion,
      resume,
      currentHead: extra.head,
    });
  });

  it.each([
    { decision: "APPROVE", successors: [] },
    { decision: "APPROVE", successors: ["TOOL_PENDING", "RUNNING"] },
    { decision: "REJECT", successors: [] },
    { decision: "REJECT", successors: ["RUNNING", "TOOL_PENDING", "RUNNING"] },
  ] as const)(
    "rejects one extra canonical $decision projection with $successors.length later successors",
    async ({ decision, successors }) => {
      const { statePath } = await fixture();
      const { journal, head } = await runningJournal(statePath);
      const snapshot = brainstormingSnapshot();
      const { host, completion, pending } = await pendingApproval({
        statePath,
        journal,
        head,
        snapshot,
      });
      const resume = resumeRequest(pending);
      const approved = await host.resumeApproval(resume);
      const extra = await appendUnlinkedJournalApproval({
        journal,
        previous: approved.phase,
        head: approved.journal_head,
        operationId: `unlinked-${decision.toLowerCase()}-phase`,
        decisionOperationId:
          decision === "APPROVE"
            ? "a0000000-0000-4000-8000-000000000802"
            : "a0000000-0000-4000-8000-000000000803",
        decision,
      });
      let currentHead = extra.head;
      for (const [index, state] of successors.entries()) {
        currentHead = (
          await journal.transition({
            ...journalCommand("run-1", state, currentHead),
            command_id: `unlinked-successor-${decision.toLowerCase()}-${index}`,
          })
        ).head;
      }

      await expectGlobalApprovalIntegrityFailure({
        statePath,
        journal,
        snapshot,
        host,
        completion,
        resume,
        currentHead,
      });
    },
  );

  it("rejects multiple distinct canonical approval roots that share no phase-history record", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, completion, pending } = await pendingApproval({
      statePath,
      journal,
      head,
      snapshot,
    });
    const resume = resumeRequest(pending);
    const approved = await host.resumeApproval(resume);
    const first = await appendUnlinkedJournalApproval({
      journal,
      previous: approved.phase,
      head: approved.journal_head,
      operationId: "unlinked-root-one",
      decisionOperationId: "a0000000-0000-4000-8000-000000000804",
      decision: "APPROVE",
    });
    const second = await appendUnlinkedJournalApproval({
      journal,
      previous: approved.phase,
      head: first.head,
      operationId: "unlinked-root-two",
      decisionOperationId: "a0000000-0000-4000-8000-000000000805",
      decision: "APPROVE",
    });

    await expectGlobalApprovalIntegrityFailure({
      statePath,
      journal,
      snapshot,
      host,
      completion,
      resume,
      currentHead: second.head,
    });
  });

  it.each(["stale-pending", "terminal-without-decision"] as const)(
    "rejects an orphan phase approval projection: $caseName",
    async (caseName) => {
      const { statePath } = await fixture();
      const { journal, head } = await runningJournal(statePath);
      const snapshot = brainstormingSnapshot();
      const { host, completion, pending } = await pendingApproval({
        statePath,
        journal,
        head,
        snapshot,
      });
      const resume = resumeRequest(pending);
      const approved = await host.resumeApproval(resume);
      const orphan = nextApprovalPhases({
        previous: approved.phase,
        observedHead: approved.journal_head,
        operationId: `orphan-${caseName}`,
        decisionOperationId: "a0000000-0000-4000-8000-000000000806",
        decision: "APPROVE",
      });
      let currentHead = approved.journal_head;
      if (caseName === "stale-pending") {
        currentHead = (
          await journal.transition({
            ...journalCommand("run-1", "REVIEW_PENDING", currentHead),
            command_id: "orphan-pending-successor",
          })
        ).head;
      }
      const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
      const currentBytes = await readFile(phasePath);
      const orphanRecords =
        caseName === "stale-pending"
          ? [orphan.started, orphan.pending]
          : [orphan.started, orphan.pending, orphan.terminal];
      await writeFile(
        phasePath,
        Buffer.concat([
          currentBytes,
          Buffer.from(orphanRecords.map((record) => `${canonicalJson(record)}\n`).join(""), "utf8"),
        ]),
      );

      await expectGlobalApprovalIntegrityFailure({
        statePath,
        journal,
        snapshot,
        host,
        completion,
        resume,
        currentHead,
      });
    },
  );

  it("rejects approval phase records when their entire journal projection is absent", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, pending } = await pendingApproval({ statePath, journal, head, snapshot });
    await host.resumeApproval(resumeRequest(pending));
    const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    const phaseBytes = await readFile(phasePath);
    await rm(path.join(statePath, "journals", "run-1"), { recursive: true });

    await expect(host.phaseHistory("run-1")).rejects.toMatchObject({
      code: "RUNTIME_SKILL_INTEGRITY",
    });
    await expect(host.startPhase(startRequest(head, snapshot))).rejects.toMatchObject({
      code: "RUNTIME_SKILL_INTEGRITY",
    });
    expect(await readFile(phasePath)).toEqual(phaseBytes);
  });

  it.each([
    { claim: "reason-only", decision: "REJECT", successors: ["RUNNING"] },
    {
      claim: "wrong-kind",
      decision: "APPROVE",
      successors: ["TOOL_PENDING", "RUNNING"],
    },
    {
      claim: "duplicate",
      decision: "REJECT",
      successors: ["RUNNING", "TOOL_PENDING", "RUNNING"],
    },
    { claim: "resigned-conflict", decision: "APPROVE", successors: [] },
    { claim: "wrong-phase", decision: "REJECT", successors: ["RUNNING"] },
    {
      claim: "decision-command-only",
      decision: "APPROVE",
      successors: ["TOOL_PENDING", "RUNNING"],
    },
  ] as const)(
    "keeps live and restart reads aligned for a $claim approval claim",
    async ({ claim, decision, successors }) => {
      const { statePath } = await fixture();
      const { journal, head } = await runningJournal(statePath);
      const snapshot = brainstormingSnapshot();
      const { host, completion, pending } = await pendingApproval({
        statePath,
        journal,
        head,
        snapshot,
      });
      const request = resumeRequest(pending, decision);
      const pendingEntry = (await journal.load("run-1"))?.entries.at(-1);
      if (
        pendingEntry === undefined ||
        typeof pendingEntry.metadata !== "object" ||
        pendingEntry.metadata === null
      ) {
        throw new Error("pending journal metadata was not persisted");
      }
      const pendingMetadata = pendingEntry.metadata as Record<string, unknown>;
      const pendingPhase = pendingMetadata.phase as Record<string, unknown>;
      const decided = await host.resumeApproval(request);
      let advancedHead = decided.journal_head;
      for (const [index, state] of successors.entries()) {
        advancedHead = (
          await journal.transition({
            ...journalCommand("run-1", state, advancedHead),
            command_id: `live-validation-successor-${index}-${state.toLowerCase()}`,
          })
        ).head;
      }
      const claimedMetadata: JsonValue =
        claim === "wrong-kind"
          ? { kind: "superpowers-approval-decision" }
          : claim === "duplicate"
            ? pendingEntry.metadata
            : claim === "resigned-conflict" || claim === "wrong-phase"
              ? {
                  kind: "superpowers-approval-pending",
                  phase: resignDocument({
                    ...pendingPhase,
                    ...(claim === "wrong-phase"
                      ? { phase: "RED" }
                      : { output_hash: `sha256:${"8".repeat(64)}` }),
                  }),
                }
              : {};
      await journal.transition({
        ...journalCommand("run-1", "APPROVAL_PENDING", advancedHead),
        command_id:
          claim === "decision-command-only"
            ? "approval-decision:a0000000-0000-4000-8000-000000000780"
            : claim === "reason-only"
              ? "malformed-reason-only-approval"
              : claim === "duplicate"
                ? "malformed-duplicate-approval"
                : `approval-pending:sha256:${"b".repeat(64)}`,
        reason_code:
          claim === "reason-only" ? "SUPERPOWERS_APPROVAL_REQUIRED" : "MOVE_APPROVAL_PENDING",
        metadata: claimedMetadata,
      });
      const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
      const journalPath = path.join(statePath, "journals", "run-1", "events.jsonl");
      const bytes = [await readFile(phasePath), await readFile(journalPath)] as const;

      await expect(host.resumeApproval(request)).rejects.toMatchObject({
        code: "RUNTIME_SKILL_INTEGRITY",
      });
      await expect(host.completePhase(completion)).rejects.toMatchObject({
        code: "RUNTIME_SKILL_INTEGRITY",
      });
      await expect(host.phaseHistory("run-1")).rejects.toMatchObject({
        code: "RUNTIME_SKILL_INTEGRITY",
      });
      const restarted = engine(statePath, journal, snapshot, { idOffset: 575 });
      await expect(restarted.recover()).rejects.toMatchObject({
        code: "RUNTIME_SKILL_INTEGRITY",
      });
      expect(await readFile(phasePath)).toEqual(bytes[0]);
      expect(await readFile(journalPath)).toEqual(bytes[1]);
    },
  );

  it.each([
    { decision: "APPROVE", successors: ["REVIEW_PENDING"] },
    { decision: "APPROVE", successors: ["TOOL_PENDING", "RUNNING", "REVIEW_PENDING"] },
    { decision: "REJECT", successors: ["RUNNING"] },
    { decision: "REJECT", successors: ["RUNNING", "TOOL_PENDING", "RUNNING"] },
  ] as const)(
    "recovers historical $decision after $successors.length legitimate later journal transitions",
    async ({ decision, successors }) => {
      const { statePath } = await fixture();
      const { journal, head } = await runningJournal(statePath);
      const snapshot = brainstormingSnapshot();
      const { host, completion, pending } = await pendingApproval({
        statePath,
        journal,
        head,
        snapshot,
      });
      const request = resumeRequest(pending, decision);
      const decided = await host.resumeApproval(request);
      let advancedHead = decided.journal_head;
      for (const [index, state] of successors.entries()) {
        advancedHead = (
          await journal.transition({
            ...journalCommand("run-1", state, advancedHead),
            command_id: `approval-successor-${index}-${state.toLowerCase()}`,
          })
        ).head;
      }
      const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
      const journalPath = path.join(statePath, "journals", "run-1", "events.jsonl");
      const before = [(await lstat(phasePath)).size, (await lstat(journalPath)).size] as const;

      const restarted = engine(statePath, journal, snapshot, { idOffset: 580 });
      await restarted.recover();
      await expect(restarted.resumeApproval(request)).resolves.toEqual({
        ...decided,
        replayed: true,
      });
      await expect(restarted.completePhase(completion)).resolves.toEqual({
        ...decided,
        replayed: true,
      });
      expect((await journal.load("run-1"))?.head).toEqual(advancedHead);
      expect([(await lstat(phasePath)).size, (await lstat(journalPath)).size]).toEqual(before);
    },
  );

  it("transitions an exact rejection to BLOCKED without a successful phase output", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, pending } = await pendingApproval({ statePath, journal, head, snapshot });

    const rejected = await host.resumeApproval(resumeRequest(pending, "REJECT"));

    expect(rejected).toMatchObject({
      state: "BLOCKED",
      phase: { status: "BLOCKED", output_hash: null },
      approval: { kind: "DECISION", decision: "REJECT" },
    });
    expect((await journal.load("run-1"))?.state).toBe("BLOCKED");
  });

  it("rejects every stale or conflicting approval binding", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, pending } = await pendingApproval({ statePath, journal, head, snapshot });
    const exact = resumeRequest(pending);
    const staleMutations: readonly Partial<ResumeSuperpowersApprovalRequest>[] = [
      {
        expected_journal_head: {
          ...exact.expected_journal_head,
          entry_hash: `sha256:${"a".repeat(64)}`,
        },
      },
      { run_id: "run-other" },
      { phase: "RED" },
      { skill_name: "test-driven-development" },
      { skill_version: "9.9.9" },
      { skill_snapshot_hash: `sha256:${"b".repeat(64)}` },
      { approval_request_hash: `sha256:${"d".repeat(64)}` },
    ];
    for (const mutation of staleMutations) {
      await expect(host.resumeApproval({ ...exact, ...mutation })).rejects.toMatchObject({
        code: "RUNTIME_SKILL_STALE_STATE",
      });
    }

    const approved = await host.resumeApproval(exact);
    await expect(host.resumeApproval({ ...exact, decision: "REJECT" })).rejects.toMatchObject({
      code: "RUNTIME_SKILL_OPERATION_CONFLICT",
    });
    await expect(
      host.resumeApproval({ ...exact, operation_id: "00000000-0000-4000-8000-000000000778" }),
    ).rejects.toMatchObject({ code: "RUNTIME_SKILL_STALE_STATE" });
    expect(approved.state).toBe("RUNNING");
  });

  it("recovers every two-file crash cut to the same pause or decision and never auto-approves", async () => {
    const pendingCuts = [
      "afterApprovalPendingPhaseSync",
      "afterApprovalPendingJournalSync",
    ] as const;
    for (const [index, hookName] of pendingCuts.entries()) {
      const { statePath } = await fixture();
      const { journal, head } = await runningJournal(statePath);
      const snapshot = brainstormingSnapshot();
      let crash = true;
      const hooks: PhaseHistoryOperationHooks = {
        [hookName]: () => {
          if (crash) throw new Error(`crash:${hookName}`);
        },
      };
      const host = engine(statePath, journal, snapshot, { hooks, idOffset: 600 + index * 20 });
      const started = await host.startPhase(startRequest(head, snapshot));
      const completion = completeRequest(started);
      await expect(host.completePhase(completion)).rejects.toThrow(`crash:${hookName}`);
      crash = false;

      const restarted = engine(statePath, journal, snapshot, { idOffset: 700 + index * 20 });
      await restarted.recover();
      expect((await journal.load("run-1"))?.state).toBe("APPROVAL_PENDING");
      const pending = await restarted.completePhase(completion);
      expect(pending).toMatchObject({ state: "APPROVAL_PENDING", replayed: true });
      expect(await restarted.phaseHistory("run-1")).toHaveLength(2);
    }

    const decisionCuts = [
      "afterApprovalDecisionPhaseSync",
      "afterApprovalDecisionJournalSync",
    ] as const;
    for (const [index, hookName] of decisionCuts.entries()) {
      const { statePath } = await fixture();
      const { journal, head } = await runningJournal(statePath);
      const snapshot = brainstormingSnapshot();
      const initial = await pendingApproval({ statePath, journal, head, snapshot });
      let crash = true;
      const hooks: PhaseHistoryOperationHooks = {
        [hookName]: () => {
          if (crash) throw new Error(`crash:${hookName}`);
        },
      };
      const crashing = engine(statePath, journal, snapshot, {
        hooks,
        idOffset: 800 + index * 20,
      });
      const request = resumeRequest(initial.pending);
      await expect(crashing.resumeApproval(request)).rejects.toThrow(`crash:${hookName}`);
      crash = false;

      const restarted = engine(statePath, journal, snapshot, { idOffset: 900 + index * 20 });
      await restarted.recover();
      expect((await journal.load("run-1"))?.state).toBe("RUNNING");
      const replay = await restarted.resumeApproval(request);
      expect(replay).toMatchObject({ state: "RUNNING", replayed: true });
      expect(await restarted.phaseHistory("run-1")).toHaveLength(3);
    }
  });

  it("fails recovery when the journal pause has no exact phase record", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    await pendingApproval({ statePath, journal, head, snapshot });
    const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    await rm(phasePath);

    const restarted = engine(statePath, journal, snapshot, { idOffset: 950 });
    await expect(restarted.recover()).rejects.toMatchObject({
      code: "RUNTIME_SKILL_INTEGRITY",
    });
    expect((await journal.load("run-1"))?.state).toBe("APPROVAL_PENDING");
  });

  it.each([
    { decision: "APPROVE", successors: [] },
    { decision: "APPROVE", successors: ["REVIEW_PENDING"] },
    { decision: "APPROVE", successors: ["TOOL_PENDING", "RUNNING", "REVIEW_PENDING"] },
    { decision: "REJECT", successors: [] },
    { decision: "REJECT", successors: ["RUNNING"] },
    { decision: "REJECT", successors: ["RUNNING", "TOOL_PENDING", "RUNNING"] },
  ] as const)(
    "fails closed when all phase history is missing after $decision and $successors.length successors",
    async ({ decision, successors }) => {
      const { statePath } = await fixture();
      const { journal, head } = await runningJournal(statePath);
      const snapshot = brainstormingSnapshot();
      const { host, pending } = await pendingApproval({ statePath, journal, head, snapshot });
      const decided = await host.resumeApproval(resumeRequest(pending, decision));
      let advancedHead = decided.journal_head;
      for (const [index, state] of successors.entries()) {
        advancedHead = (
          await journal.transition({
            ...journalCommand("run-1", state, advancedHead),
            command_id: `missing-history-successor-${index}-${state.toLowerCase()}`,
          })
        ).head;
      }
      const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
      const journalPath = path.join(statePath, "journals", "run-1", "events.jsonl");
      const journalBytes = await readFile(journalPath);
      await rm(phasePath);

      const restarted = engine(statePath, journal, snapshot, { idOffset: 960 });
      await expect(restarted.recover()).rejects.toMatchObject({
        code: "RUNTIME_SKILL_INTEGRITY",
      });
      expect(await readFile(journalPath)).toEqual(journalBytes);
      await expect(lstat(phasePath)).rejects.toMatchObject({ code: "ENOENT" });

      if (decision === "APPROVE" && successors.length === 0) {
        await expect(
          restarted.startPhase({
            ...startRequest(advancedHead, snapshot),
            operation_id: "fresh-after-missing-history",
          }),
        ).rejects.toMatchObject({ code: "RUNTIME_SKILL_INTEGRITY" });
        await expect(lstat(phasePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("fails closed when a journal-first approval decision loses its phase history", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const initial = await pendingApproval({ statePath, journal, head, snapshot });
    const crashing = engine(statePath, journal, snapshot, {
      hooks: {
        afterApprovalDecisionJournalSync: () => {
          throw new Error("crash:journal-first-missing-history");
        },
      },
      idOffset: 970,
    });
    await expect(crashing.resumeApproval(resumeRequest(initial.pending))).rejects.toThrow(
      "crash:journal-first-missing-history",
    );
    const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    const journalPath = path.join(statePath, "journals", "run-1", "events.jsonl");
    const journalBytes = await readFile(journalPath);
    await rm(phasePath);

    const restarted = engine(statePath, journal, snapshot, { idOffset: 980 });
    await expect(restarted.recover()).rejects.toMatchObject({
      code: "RUNTIME_SKILL_INTEGRITY",
    });
    expect(await readFile(journalPath)).toEqual(journalBytes);
    await expect(lstat(phasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows empty phase history only when the verified journal has no approval evidence", async () => {
    const { statePath } = await fixture();
    const { journal } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");

    const restarted = engine(statePath, journal, snapshot, { idOffset: 985 });
    await expect(restarted.recover()).resolves.toBeUndefined();
    await expect(lstat(phasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    {
      state: "APPROVAL_PENDING",
      command_id: `approval-pending:sha256:${"a".repeat(64)}`,
      reason_code: "MOVE_APPROVAL_PENDING",
    },
    {
      state: "REVIEW_PENDING",
      command_id: "approval-decision:a0000000-0000-4000-8000-000000000779",
      reason_code: "SUPERPOWERS_APPROVAL_GRANTED",
    },
  ] as const)(
    "rejects claimed approval journal evidence without closed canonical metadata",
    async ({ state, command_id, reason_code }) => {
      const { statePath } = await fixture();
      const { journal, head } = await runningJournal(statePath);
      const snapshot = brainstormingSnapshot();
      await journal.transition({
        ...journalCommand("run-1", state, head),
        command_id,
        reason_code,
      });
      const journalPath = path.join(statePath, "journals", "run-1", "events.jsonl");
      const journalBytes = await readFile(journalPath);

      const restarted = engine(statePath, journal, snapshot, { idOffset: 988 });
      await expect(restarted.recover()).rejects.toMatchObject({
        code: "RUNTIME_SKILL_INTEGRITY",
      });
      expect(await readFile(journalPath)).toEqual(journalBytes);
    },
  );

  it.each(["truncated", "replaced"] as const)(
    "fails closed when durable approval phase history is $caseName",
    async (caseName) => {
      const { statePath } = await fixture();
      const { journal, head } = await runningJournal(statePath);
      const snapshot = brainstormingSnapshot();
      const { host, pending } = await pendingApproval({ statePath, journal, head, snapshot });
      await host.resumeApproval(resumeRequest(pending));
      const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
      const original = await readFile(phasePath);
      if (caseName === "truncated") {
        const firstLineEnd = original.indexOf(0x0a);
        await writeFile(phasePath, original.subarray(0, firstLineEnd + 1));
      } else {
        const first = JSON.parse(original.toString("utf8").split("\n")[0]!) as Record<
          string,
          unknown
        >;
        const replacement = resignDocument({
          ...first,
          operation_id: "replacement-phase",
          input_hash: `sha256:${"9".repeat(64)}`,
        });
        await writeFile(phasePath, `${canonicalJson(replacement)}\n`);
      }

      const restarted = engine(statePath, journal, snapshot, { idOffset: 990 });
      await expect(restarted.recover()).rejects.toMatchObject({
        code: "RUNTIME_SKILL_INTEGRITY",
      });
    },
  );

  it("rejects approval after the shutdown intake cut before reading mutable request fields", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, pending } = await pendingApproval({ statePath, journal, head, snapshot });
    host.stopIntake();
    let reads = 0;
    const request = new Proxy(resumeRequest(pending), {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    await expect(host.resumeApproval(request)).rejects.toMatchObject({
      code: "RUNTIME_SKILL_UNAVAILABLE",
    });
    expect(reads).toBe(0);
  });

  it("durably completes approval accepted in the same turn as the host intake cut", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const host = createSkillsRuntimeHostForTest({
      statePath,
      socketPath: path.join(statePath, "runtime.sock"),
      configuredRoots: [],
      journal,
      now: clock(),
      randomId: ids(1_300),
      hasServiceListener: () => Promise.resolve("absent"),
    });
    const selected = await host.select({
      mode: "implicit",
      capability: "brainstorming",
      allowed_capabilities: ["brainstorming"],
      query: null,
      descriptor: null,
    });
    const snapshot = await host.load(selected);
    const started = await host.startPhase({
      run_id: "run-1",
      expected_journal_head: head,
      execution_request_hash: EXECUTION_REQUEST_HASH,
      selection: selected,
      phase: "BRAINSTORMING",
      input: Buffer.from("same-turn shutdown", "utf8"),
      operation_id: "same-turn-brainstorming",
      trace: TRACE,
    });
    const pending = await host.completePhase({
      ...completeRequest(started),
      skill_snapshot_hash: snapshot.document_hash,
    });
    if (pending.approval === null) throw new Error("approval request expected");
    const request = resumeRequest(pending as SuperpowersApprovalOutcome);

    const accepted = host.resumeApproval(request);
    host.stopIntake();
    await expect(accepted).resolves.toMatchObject({ state: "RUNNING", replayed: false });
    await host.flush(new AbortController().signal);
    expect((await journal.load("run-1"))?.state).toBe("RUNNING");

    const restarted = createSkillsRuntimeHostForTest({
      statePath,
      socketPath: path.join(statePath, "runtime.sock"),
      configuredRoots: [],
      journal,
      now: clock(),
      randomId: ids(1_400),
      hasServiceListener: () => Promise.resolve("absent"),
    });
    await restarted.recover();
    await expect(restarted.resumeApproval(request)).resolves.toMatchObject({
      state: "RUNNING",
      replayed: true,
    });
    expect(
      (await readdir(path.join(statePath, "skills"), { recursive: true })).filter((entry) =>
        /(?:\.stage|\.claim|\.lock|\.tombstone)(?:\.|$)/u.test(entry),
      ),
    ).toEqual([]);
  });

  it("keeps exact canonical approval and phase bytes private and bounded", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, pending } = await pendingApproval({ statePath, journal, head, snapshot });
    await host.resumeApproval(resumeRequest(pending));

    const phaseBytes = await readFile(path.join(statePath, "skills", "phases", "run-1.jsonl"));
    const journalBytes = await readFile(path.join(statePath, "journals", "run-1", "events.jsonl"));
    expect(phaseBytes.byteLength).toBeLessThan(64 * 1024);
    expect(journalBytes.byteLength).toBeLessThan(64 * 1024);
    expect(phaseBytes.toString("utf8")).not.toContain(statePath);
    expect(journalBytes.toString("utf8")).not.toContain(statePath);
  });

  it("rejects a re-signed journal decision whose repeated approval binding changed", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, pending } = await pendingApproval({ statePath, journal, head, snapshot });
    await host.resumeApproval(resumeRequest(pending));
    const entry = (await journal.load("run-1"))?.entries.at(-1);
    if (entry === undefined || typeof entry.metadata !== "object" || entry.metadata === null) {
      throw new Error("decision journal entry was not persisted");
    }
    const metadata = entry.metadata as Record<string, unknown>;
    const decision = metadata.decision as Record<string, unknown>;
    const mutatedDecision = resignDocument({ ...decision, skill_version: "9.9.9" });
    const pendingEntry = (await journal.load("run-1"))?.entries.at(-2);
    if (pendingEntry === undefined) throw new Error("pending journal entry was not persisted");

    expect(() =>
      decisionMetadata(
        {
          ...entry,
          metadata: { ...metadata, decision: mutatedDecision },
        },
        pendingEntry,
      ),
    ).toThrowError(new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY"));
  });

  it("rejects every re-signed terminal field that is not derived from pending and decision", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, pending } = await pendingApproval({ statePath, journal, head, snapshot });
    await host.resumeApproval(resumeRequest(pending));
    const loaded = await journal.load("run-1");
    const pendingEntry = loaded?.entries.at(-2);
    const decisionEntry = loaded?.entries.at(-1);
    if (
      pendingEntry === undefined ||
      decisionEntry === undefined ||
      typeof decisionEntry.metadata !== "object" ||
      decisionEntry.metadata === null
    ) {
      throw new Error("approval journal transaction was not persisted");
    }
    const metadata = decisionEntry.metadata as Record<string, unknown>;
    const phase = metadata.phase as Record<string, unknown>;
    const mutations: readonly Readonly<Record<string, unknown>>[] = [
      { output_hash: `sha256:${"9".repeat(64)}` },
      { input_hash: `sha256:${"8".repeat(64)}` },
      { phase_revision: (phase.phase_revision as number) + 1 },
      { previous_phase_hash: `sha256:${"7".repeat(64)}` },
      { execution_request_hash: `sha256:${"6".repeat(64)}` },
      { catalog_hash: `sha256:${"5".repeat(64)}` },
      { context_hash: `sha256:${"4".repeat(64)}` },
      {
        context_accounting: {
          ...(phase.context_accounting as Record<string, unknown>),
          remaining_bytes:
            ((phase.context_accounting as Record<string, unknown>).remaining_bytes as number) + 1,
        },
      },
      { terminal_code: "RUNTIME_SKILL_UNAVAILABLE" },
      {
        observed_journal_head: {
          ...(phase.observed_journal_head as Record<string, unknown>),
          entry_hash: `sha256:${"3".repeat(64)}`,
        },
      },
      {
        skill: {
          ...(phase.skill as Record<string, unknown>),
          snapshot_hash: `sha256:${"2".repeat(64)}`,
        },
      },
      {
        skill: {
          ...(phase.skill as Record<string, unknown>),
          package_hash: `sha256:${"1".repeat(64)}`,
        },
      },
      {
        handler: {
          ...(phase.handler as Record<string, unknown>),
          hash: `sha256:${"0".repeat(64)}`,
        },
      },
      { predecessor_phase_hashes: [`sha256:${"2".repeat(64)}`] },
      { trace: { ...TRACE, span_id: "3".repeat(16) } },
      { occurred_at: "2026-08-30T23:59:59.999Z" },
      { status: "BLOCKED", output_hash: null },
    ];

    for (const mutation of mutations) {
      const mutatedPhase = resignDocument({ ...phase, ...mutation });
      expect(() =>
        decisionMetadata(
          {
            ...decisionEntry,
            metadata: { ...metadata, phase: mutatedPhase } as JsonValue,
          },
          pendingEntry,
        ),
      ).toThrowError(new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY"));
    }
    expect(() =>
      decisionMetadata(
        {
          ...decisionEntry,
          metadata: { ...metadata, occurred_at: "not-a-timestamp" },
        },
        pendingEntry,
      ),
    ).toThrowError(new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY"));
    const changedTimestamp = "2026-08-30T23:59:59.999Z";
    const timestampPhase = resignDocument({ ...phase, occurred_at: changedTimestamp });
    expect(() =>
      decisionMetadata(
        {
          ...decisionEntry,
          metadata: {
            ...metadata,
            occurred_at: changedTimestamp,
            phase: timestampPhase,
          },
        },
        pendingEntry,
      ),
    ).toThrowError(new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY"));
  });

  it("preserves a forged journal-first terminal and never appends it during restart", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const initial = await pendingApproval({ statePath, journal, head, snapshot });
    const crashing = engine(statePath, journal, snapshot, {
      hooks: {
        afterApprovalDecisionJournalSync: () => {
          throw new Error("crash:journal-first-forgery");
        },
      },
    });
    await expect(crashing.resumeApproval(resumeRequest(initial.pending))).rejects.toThrow(
      "crash:journal-first-forgery",
    );
    const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    const journalPath = path.join(statePath, "journals", "run-1", "events.jsonl");
    const lines = (await readFile(journalPath, "utf8")).trimEnd().split("\n");
    const decisionEntry = JSON.parse(lines.at(-1)!) as RunJournalEntryV1;
    const metadata = decisionEntry.metadata as Record<string, unknown>;
    const phase = metadata.phase as Record<string, unknown>;
    const mutatedPhase = resignDocument({
      ...phase,
      output_hash: `sha256:${"9".repeat(64)}`,
    });
    const hashable = {
      ...decisionEntry,
      metadata: { ...metadata, phase: mutatedPhase },
    } as RunJournalEntryV1;
    const unsigned = { ...hashable } as Record<string, unknown>;
    delete unsigned.entry_hash;
    const resigned = {
      ...unsigned,
      entry_hash: hashRunJournalEntry(unsigned as HashableRunJournalEntryV1),
    } as RunJournalEntryV1;
    lines[lines.length - 1] = canonicalJson(resigned);
    await writeFile(journalPath, `${lines.join("\n")}\n`);
    const forgedJournalBytes = await readFile(journalPath);
    const pendingPhaseBytes = await readFile(phasePath);

    const restarted = engine(
      statePath,
      createRunJournalStore({ statePath, now: clock(), randomId: ids(990) }),
      snapshot,
      {
        idOffset: 990,
      },
    );
    await expect(restarted.recover()).rejects.toMatchObject({ code: "RUNTIME_SKILL_INTEGRITY" });
    expect(await readFile(journalPath)).toEqual(forgedJournalBytes);
    expect(await readFile(phasePath)).toEqual(pendingPhaseBytes);
  });

  it("preserves duplicate decision metadata in a later journal transition and fails closed", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const snapshot = brainstormingSnapshot();
    const { host, pending } = await pendingApproval({ statePath, journal, head, snapshot });
    const approved = await host.resumeApproval(resumeRequest(pending));
    const decisionEntry = (await journal.load("run-1"))?.entries.at(-1);
    if (decisionEntry === undefined) throw new Error("approval decision was not persisted");
    await journal.transition({
      ...journalCommand("run-1", "REVIEW_PENDING", approved.journal_head),
      command_id: "duplicate-decision-metadata",
      metadata: decisionEntry.metadata,
    });
    const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    const journalPath = path.join(statePath, "journals", "run-1", "events.jsonl");
    const phaseBytes = await readFile(phasePath);
    const journalBytes = await readFile(journalPath);

    const restarted = engine(statePath, journal, snapshot, { idOffset: 995 });
    await expect(restarted.recover()).rejects.toMatchObject({ code: "RUNTIME_SKILL_INTEGRITY" });
    expect(await readFile(phasePath)).toEqual(phaseBytes);
    expect(await readFile(journalPath)).toEqual(journalBytes);
  });
});
