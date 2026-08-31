import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashRunJournalEntry, ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import { decideRunTransition } from "../src/journal/state-machine.js";
import type { TransitionCommand } from "../src/journal/state-machine.js";
import type { JournalHead, RunJournalEntryV1, RunState } from "../src/journal/types.js";
import { createRunJournalStore } from "../src/journal/store.js";
import { canonicalJson, parseJsonBytes, sha256 } from "../src/protocol/json.js";
import { approvalPendingCommand, requestSuperpowersApproval } from "../src/skills/approval.js";
import {
  hashSkillCatalog,
  hashSkillExecutionHandoff,
  parseSkillExecutionEvidence,
} from "../src/skills/contracts.js";
import { SKILL_LIMITS, type SkillsHost } from "../src/skills/index.js";
import { createSkillEvidenceBuilder } from "../src/skills/evidence.js";
import type { SkillsEngine } from "../src/skills/engine.js";
import { builtInSuperpowersHandler } from "../src/skills/phases.js";
import { createSkillsRuntimeHostForTest } from "../src/skills/runtime-host.js";
import type { SkillSelection } from "../src/skills/catalog.js";
import type { SkillSnapshotV1, SuperpowersPhaseName } from "../src/skills/types.js";
import { validSuperpowersPhase } from "./support/skill-fixtures.js";

const TRACE = {
  trace_id: "1".repeat(32),
  span_id: "2".repeat(16),
  trace_flags: 1,
} as const;
const EXECUTION_REQUEST_HASH = `sha256:${"e".repeat(64)}` as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function clock(): () => Date {
  let second = 0;
  return () => new Date(Date.UTC(2026, 7, 30, 12, 0, second++));
}

function ids(): () => string {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

function rawHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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

async function selected(
  host: SkillsHost,
  capability: string,
): Promise<{
  readonly selection: SkillSelection;
  readonly snapshot: SkillSnapshotV1;
}> {
  const selection = await host.select({
    mode: "implicit",
    capability,
    allowed_capabilities: [capability],
    query: null,
    descriptor: null,
  });
  return { selection, snapshot: await host.load(selection) };
}

async function complete(
  host: SkillsHost,
  head: JournalHead,
  capability: string,
  phase: SuperpowersPhaseName,
  index: number,
): Promise<void> {
  const skill = await selected(host, capability);
  const started = await host.startPhase({
    run_id: "run-1",
    expected_journal_head: head,
    execution_request_hash: EXECUTION_REQUEST_HASH,
    selection: skill.selection,
    phase,
    input: Buffer.from(`${phase} input`, "utf8"),
    operation_id: `phase-${index}`,
    trace: TRACE,
  });
  await host.completePhase({
    run_id: "run-1",
    expected_phase_revision: started.phase.phase_revision,
    expected_phase_head_hash: started.phase.document_hash,
    phase,
    skill_snapshot_hash: skill.snapshot.document_hash,
    operation_id: started.phase.operation_id,
    outcome: "COMPLETED",
    terminal_code: null,
    output: Buffer.from(`${phase} output`, "utf8"),
    trace: TRACE,
  });
}

function resign<T extends Record<string, unknown>>(value: T): T {
  const hashable = { ...value };
  delete hashable.document_hash;
  return { ...hashable, document_hash: sha256(hashable) };
}

function resignEvidence(value: Record<string, unknown>): Record<string, unknown> {
  const preimage = { ...value };
  delete preimage.document_hash;
  delete preimage.handoff_hash;
  const withHandoff = {
    ...preimage,
    handoff_hash: hashSkillExecutionHandoff(preimage as never),
  };
  return { ...withHandoff, document_hash: sha256(withHandoff) };
}

function resignJournal(value: RunJournalEntryV1): RunJournalEntryV1 {
  const { entry_hash: entryHash, ...hashable } = value;
  void entryHash;
  return { ...hashable, entry_hash: hashRunJournalEntry(hashable) };
}

describe("canonical Agent Skills evidence", () => {
  it("rejects the 129th approval in the first linear journal pass before object reads", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "toss-evidence-approval-limit-")),
    );
    roots.push(root);
    const runId = "run-approval-limit";
    const history: RunJournalEntryV1[] = [];
    const now = clock();
    for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
      const previous = history.at(-1);
      const decision = decideRunTransition(
        history,
        journalCommand(
          runId,
          state,
          previous === undefined
            ? null
            : {
                journal_revision: previous.journal_revision,
                sequence: previous.sequence,
                entry_hash: previous.entry_hash,
              },
        ),
        now,
      );
      if (decision.kind !== "append") throw new Error("journal fixture must append");
      history.push(decision.entry);
    }
    for (let index = 0; index < 129; index += 1) {
      const previous = history.at(-1)!;
      const base = validSuperpowersPhase();
      const handler = builtInSuperpowersHandler("BRAINSTORMING");
      const started = resign({
        ...base,
        run_id: runId,
        phase: "BRAINSTORMING" as const,
        handler: { version: handler.version, hash: handler.hash },
        operation_id: `approval-limit-${index}`,
        status: "STARTED" as const,
        observed_journal_head: {
          journal_revision: previous.journal_revision,
          sequence: previous.sequence,
          entry_hash: previous.entry_hash,
        },
        output_hash: null,
      });
      const pending = requestSuperpowersApproval({
        started,
        output_hash: sha256({ index }),
        occurred_at: now().toISOString(),
        trace: TRACE,
      });
      const pendingDecision = decideRunTransition(history, approvalPendingCommand(pending), now);
      if (pendingDecision.kind !== "append") throw new Error("pending fixture must append");
      history.push(pendingDecision.entry);
      const pendingHead = pendingDecision.entry;
      const resumeDecision = decideRunTransition(
        history,
        {
          ...journalCommand(runId, "RUNNING", {
            journal_revision: pendingHead.journal_revision,
            sequence: pendingHead.sequence,
            entry_hash: pendingHead.entry_hash,
          }),
          command_id: `approval-limit-resume-${index}`,
        },
        now,
      );
      if (resumeDecision.kind !== "append") throw new Error("resume fixture must append");
      history.push(resumeDecision.entry);
    }
    const final = history.at(-1)!;
    let reads = 0;
    const engine = {
      evidenceHistory: () =>
        Promise.resolve({
          phases: [validSuperpowersPhase()],
          journal: {
            run_id: runId,
            state: final.state,
            head: {
              journal_revision: final.journal_revision,
              sequence: final.sequence,
              entry_hash: final.entry_hash,
            },
            entries: history,
            unresolved_side_effects: [],
          },
        }),
    } as unknown as SkillsEngine;
    const builder = createSkillEvidenceBuilder({
      statePath: path.join(root, "state"),
      engine,
      now,
      randomId: ids(),
      hasServiceListener: () => Promise.resolve("absent"),
      operationHooks: {
        afterObjectRead: () => {
          reads += 1;
          return Promise.resolve();
        },
      },
    });

    await expect(builder.evidence(runId)).rejects.toMatchObject({
      code: "RUNTIME_SKILL_LIMIT_EXCEEDED",
    });
    expect(reads).toBe(0);
  });

  it("binds the complete governed phase, approval, context, resource, and handoff history", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-skill-evidence-")));
    roots.push(root);
    const statePath = path.join(root, "state");
    const now = clock();
    const randomId = ids();
    const journal = createRunJournalStore({ statePath, now, randomId });
    let head: JournalHead | null = null;
    for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
      head = (await journal.transition(journalCommand("run-1", state, head))).head;
    }
    if (head === null) throw new Error("journal fixture failed");
    const host = createSkillsRuntimeHostForTest({
      statePath,
      socketPath: path.join(root, "runtime.sock"),
      configuredRoots: [],
      journal,
      now,
      randomId,
      hasServiceListener: () => Promise.resolve("absent"),
    });

    const brainstorming = await selected(host, "brainstorming");
    const started = await host.startPhase({
      run_id: "run-1",
      expected_journal_head: head,
      execution_request_hash: EXECUTION_REQUEST_HASH,
      selection: brainstorming.selection,
      phase: "BRAINSTORMING",
      input: Buffer.from("brainstorming input", "utf8"),
      operation_id: "phase-0",
      trace: TRACE,
    });
    const pending = await host.completePhase({
      run_id: "run-1",
      expected_phase_revision: started.phase.phase_revision,
      expected_phase_head_hash: started.phase.document_hash,
      phase: "BRAINSTORMING",
      skill_snapshot_hash: brainstorming.snapshot.document_hash,
      operation_id: started.phase.operation_id,
      outcome: "COMPLETED",
      terminal_code: null,
      output: Buffer.from("approved plan", "utf8"),
      trace: TRACE,
    });
    if (pending.approval?.kind !== "REQUEST") throw new Error("approval challenge expected");
    const approved = await host.resumeApproval({
      run_id: "run-1",
      expected_journal_head: pending.approval.pending_journal_head,
      phase: pending.approval.phase,
      skill_name: pending.approval.skill_name,
      skill_version: pending.approval.skill_version,
      skill_snapshot_hash: pending.approval.skill_snapshot_hash,
      approval_request_hash: pending.approval.document_hash,
      operation_id: "a0000000-0000-4000-8000-000000000777",
      decision: "APPROVE",
      trace: TRACE,
    });
    head = approved.journal_head;

    const approvalEvidence = await host.evidence("run-1");
    if (approvalEvidence === null) throw new Error("approved evidence expected");
    const approvalProjection = approvalEvidence.approvals[0]!;
    const approvedTerminal = approvalEvidence.phases.at(-1)!;
    const outputDriftTerminal = resign({
      ...approvedTerminal,
      output_hash: sha256({ false_output: true }),
    });
    const outputDriftDecisionEntry = resignJournal({
      ...approvalProjection.decision_journal_entry!,
      metadata: parseJsonBytes(
        canonicalJson({
          kind: "superpowers-approval-decision",
          request: approvalProjection.request,
          decision: approvalProjection.decision,
          occurred_at: outputDriftTerminal.occurred_at,
          phase: outputDriftTerminal,
        }),
      ),
    });
    const outputDrift = resignEvidence({
      ...approvalEvidence,
      phases: [...approvalEvidence.phases.slice(0, -1), outputDriftTerminal],
      approvals: [
        {
          ...approvalProjection,
          decision_journal_entry: outputDriftDecisionEntry,
        },
      ],
      journal_head: {
        journal_revision: outputDriftDecisionEntry.journal_revision,
        sequence: outputDriftDecisionEntry.sequence,
        entry_hash: outputDriftDecisionEntry.entry_hash,
      },
    });
    expect(parseSkillExecutionEvidence(canonicalJson(outputDrift))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });

    const driftedRequestEntry = resignJournal({
      ...approvalProjection.request_journal_entry,
      previous_entry_hash: `sha256:${"c".repeat(64)}`,
    });
    const driftedRequestHead = {
      journal_revision: driftedRequestEntry.journal_revision,
      sequence: driftedRequestEntry.sequence,
      entry_hash: driftedRequestEntry.entry_hash,
    };
    const adjacencyRequest = resign({
      ...approvalProjection.request,
      pending_journal_head: driftedRequestHead,
    });
    const adjacencyDecision = resign({
      ...approvalProjection.decision!,
      pending_journal_head: driftedRequestHead,
      approval_request_hash: adjacencyRequest.document_hash,
    });
    const adjacencyDecisionEntry = resignJournal({
      ...approvalProjection.decision_journal_entry!,
      previous_entry_hash: driftedRequestEntry.entry_hash,
      metadata: parseJsonBytes(
        canonicalJson({
          kind: "superpowers-approval-decision",
          request: adjacencyRequest,
          decision: adjacencyDecision,
          occurred_at: approvedTerminal.occurred_at,
          phase: approvedTerminal,
        }),
      ),
    });
    const adjacencyDrift = resignEvidence({
      ...approvalEvidence,
      approvals: [
        {
          request: adjacencyRequest,
          request_journal_entry: driftedRequestEntry,
          decision: adjacencyDecision,
          decision_journal_entry: adjacencyDecisionEntry,
        },
      ],
      journal_head: {
        journal_revision: adjacencyDecisionEntry.journal_revision,
        sequence: adjacencyDecisionEntry.sequence,
        entry_hash: adjacencyDecisionEntry.entry_hash,
      },
    });
    expect(parseSkillExecutionEvidence(canonicalJson(adjacencyDrift))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });

    const phases = [
      ["test-driven-development", "TEST_DESIGN"],
      ["test-driven-development", "RED"],
      ["test-driven-development", "GREEN"],
      ["systematic-debugging", "DEBUGGING"],
      ["requesting-code-review", "REVIEW"],
      ["verification-before-completion", "VERIFICATION"],
    ] as const;
    for (const [index, [capability, phase]] of phases.entries()) {
      await complete(host, head, capability, phase, index + 1);
    }

    const evidence = await host.evidence("run-1");
    expect(evidence).not.toBeNull();
    if (evidence === null) return;
    expect(parseSkillExecutionEvidence(canonicalJson(evidence))).toEqual({
      ok: true,
      value: evidence,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.snapshots)).toBe(true);
    expect(Object.isFrozen(evidence.phases)).toBe(true);
    expect(Object.isFrozen(evidence.approvals)).toBe(true);
    expect(evidence.phases.map((phase) => phase.status)).toEqual([
      "STARTED",
      "APPROVAL_PENDING",
      "COMPLETED",
      "STARTED",
      "COMPLETED",
      "STARTED",
      "COMPLETED",
      "STARTED",
      "COMPLETED",
      "STARTED",
      "COMPLETED",
      "STARTED",
      "COMPLETED",
      "STARTED",
      "COMPLETED",
    ]);
    expect(new Set(evidence.phases.map((phase) => phase.catalog_hash)).size).toBeGreaterThan(1);
    expect(evidence.catalogs.length).toBeGreaterThan(1);
    for (const catalog of evidence.catalogs) {
      expect(
        hashSkillCatalog(
          catalog.descriptors.map((descriptor) => ({
            name: descriptor.name,
            version: descriptor.version,
            source: descriptor.source,
            package_hash: descriptor.package_hash,
            document_hash: descriptor.document_hash,
          })),
        ),
      ).toBe(catalog.catalog_hash);
    }
    expect(evidence.snapshots).toHaveLength(5);
    expect(evidence.approvals).toHaveLength(1);
    expect(evidence.approvals[0]?.decision?.document_hash).toBe(approved.approval?.document_hash);
    expect(evidence.approvals[0]?.decision_journal_entry).toMatchObject({
      journal_revision: approved.journal_head.journal_revision,
      sequence: approved.journal_head.sequence,
      entry_hash: approved.journal_head.entry_hash,
    });
    expect(evidence.phases.every((phase) => phase.context_accounting.segment_count > 0)).toBe(true);
    expect(Buffer.byteLength(canonicalJson(evidence), "utf8")).toBeLessThanOrEqual(
      SKILL_LIMITS.evidenceBytes,
    );
    expect(canonicalJson(evidence)).not.toMatch(/approved plan|\/private\//u);

    const latest = evidence.phases.at(-1)!;
    const mutatedLatest = resign({
      ...latest,
      context_accounting: {
        ...latest.context_accounting,
        included_utf8_bytes: latest.context_accounting.original_utf8_bytes + 1,
      },
    });
    const driftedRequest = resign({
      ...evidence.approvals[0]!.request,
      skill_version: "9.9.9",
    });
    const driftedDecision = resign({
      ...evidence.approvals[0]!.decision!,
      skill_version: "9.9.9",
      approval_request_hash: driftedRequest.document_hash,
    });
    const unknownResourceLatest = resign({
      ...latest,
      context_accounting: {
        ...latest.context_accounting,
        resources: [
          ...latest.context_accounting.resources,
          {
            path: "references/unknown.md",
            source_hash: `sha256:${"f".repeat(64)}`,
            state: "OMITTED",
            original_bytes: 1,
            included_bytes: 0,
            included_hash: null,
            original_conservative_units: 1,
            included_conservative_units: 0,
          },
        ],
        original_utf8_bytes: latest.context_accounting.original_utf8_bytes + 1,
        original_conservative_units: latest.context_accounting.original_conservative_units + 1,
      },
    });
    const mutations: readonly Record<string, unknown>[] = [
      { snapshots: [...evidence.snapshots].reverse() },
      { snapshots: evidence.snapshots.slice(1) },
      { catalogs: evidence.catalogs.slice(1) },
      { approvals: [] },
      { phases: [...evidence.phases.slice(0, -1), mutatedLatest] },
      { phases: [...evidence.phases.slice(0, -1), unknownResourceLatest] },
      {
        approvals: [
          {
            ...evidence.approvals[0]!,
            request: driftedRequest,
            decision: driftedDecision,
          },
        ],
      },
      {
        approvals: [
          {
            ...evidence.approvals[0]!,
            decision_journal_entry: null,
          },
        ],
      },
      { journal_head: evidence.approvals[0]!.request.pending_journal_head },
      { run_state: "CREATED" },
      { run_state: "APPROVAL_PENDING" },
      { terminal_code: "RUNTIME_SKILL_UNAVAILABLE" },
    ];
    for (const mutation of mutations) {
      const parsed = parseSkillExecutionEvidence(
        canonicalJson(resignEvidence({ ...evidence, ...mutation })),
      );
      expect(parsed).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
    }

    const review = await selected(host, "requesting-code-review");
    const retry = await host.startPhase({
      run_id: "run-1",
      expected_journal_head: head,
      execution_request_hash: EXECUTION_REQUEST_HASH,
      selection: review.selection,
      phase: "REVIEW",
      input: Buffer.from("new review attempt", "utf8"),
      operation_id: "phase-review-retry",
      trace: TRACE,
    });
    const retryEvidence = await host.evidence("run-1");
    expect(retryEvidence?.phases.at(-1)?.document_hash).toBe(retry.phase.document_hash);
    expect(retryEvidence?.phases.at(-1)?.status).toBe("STARTED");
    expect(retryEvidence?.terminal_code).toBeNull();

    await host.completePhase({
      run_id: "run-1",
      expected_phase_revision: retry.phase.phase_revision,
      expected_phase_head_hash: retry.phase.document_hash,
      phase: retry.phase.phase,
      skill_snapshot_hash: retry.phase.skill.snapshot_hash,
      operation_id: retry.phase.operation_id,
      outcome: "FAILED",
      terminal_code: "RUNTIME_SKILL_UNAVAILABLE",
      output: Buffer.alloc(0),
      trace: TRACE,
    });
    const failedEvidence = await host.evidence("run-1");
    expect(failedEvidence?.phases.at(-1)?.status).toBe("FAILED");
    expect(failedEvidence?.terminal_code).toBe("RUNTIME_SKILL_UNAVAILABLE");

    let missingHead: JournalHead | null = null;
    for (const state of ["CREATED", "ROUTED", "RUNNING", "BLOCKED"] as const) {
      const command = journalCommand("run-missing-skill", state, missingHead);
      missingHead = (
        await journal.transition({
          ...command,
          reason_code: state === "BLOCKED" ? "BLOCKED_SUPERPOWERS_MISSING" : command.reason_code,
        })
      ).head;
    }
    const missingEvidence = await host.evidence("run-missing-skill");
    expect(missingEvidence).toMatchObject({
      phases: [],
      snapshots: [],
      run_state: "BLOCKED",
      terminal_code: "BLOCKED_SUPERPOWERS_MISSING",
    });
    if (missingEvidence === null) throw new Error("missing capability evidence expected");
    expect(parseSkillExecutionEvidence(canonicalJson(missingEvidence))).toEqual({
      ok: true,
      value: missingEvidence,
    });

    let mixedHead: JournalHead | null = null;
    for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
      mixedHead = (await journal.transition(journalCommand("run-mixed-terminal", state, mixedHead)))
        .head;
    }
    if (mixedHead === null) throw new Error("mixed terminal journal fixture failed");
    const mixedSkill = await selected(host, "test-driven-development");
    const mixedStarted = await host.startPhase({
      run_id: "run-mixed-terminal",
      expected_journal_head: mixedHead,
      execution_request_hash: EXECUTION_REQUEST_HASH,
      selection: mixedSkill.selection,
      phase: "TEST_DESIGN",
      input: Buffer.from("completed before later capability failure", "utf8"),
      operation_id: "mixed-terminal-phase",
      trace: TRACE,
    });
    await host.completePhase({
      run_id: "run-mixed-terminal",
      expected_phase_revision: mixedStarted.phase.phase_revision,
      expected_phase_head_hash: mixedStarted.phase.document_hash,
      phase: mixedStarted.phase.phase,
      skill_snapshot_hash: mixedStarted.phase.skill.snapshot_hash,
      operation_id: mixedStarted.phase.operation_id,
      outcome: "COMPLETED",
      terminal_code: null,
      output: Buffer.from("completed output", "utf8"),
      trace: TRACE,
    });
    const blockedCommand = journalCommand("run-mixed-terminal", "BLOCKED", mixedHead);
    mixedHead = (
      await journal.transition({
        ...blockedCommand,
        reason_code: "BLOCKED_SUPERPOWERS_MISSING",
      })
    ).head;
    const mixedEvidence = await host.evidence("run-mixed-terminal");
    expect(mixedEvidence).toMatchObject({
      journal_head: mixedHead,
      run_state: "BLOCKED",
      terminal_code: "BLOCKED_SUPERPOWERS_MISSING",
    });
    expect(mixedEvidence?.phases.at(-1)?.status).toBe("COMPLETED");
    if (mixedEvidence === null) throw new Error("mixed terminal evidence expected");
    expect(parseSkillExecutionEvidence(canonicalJson(mixedEvidence))).toEqual({
      ok: true,
      value: mixedEvidence,
    });

    const configuredRoot = path.join(root, "configured-skills");
    const packageRoot = path.join(configuredRoot, "test-driven-development");
    const resourceBytes = Buffer.alloc(SKILL_LIMITS.resourceBytes);
    const skillMarkdown = "# Requesting code review\n";
    const resource = {
      path: "assets/evidence.bin",
      role: "asset" as const,
      phases: [] as const,
      priority: null,
      media_type: "application/octet-stream",
      bytes: resourceBytes.byteLength,
      hash: rawHash(resourceBytes),
    };
    const intrinsic = {
      name: "test-driven-development",
      description: "Bounded evidence preflight fixture.",
      version: "1.0.0",
      required_runtime_capabilities: ["test-driven-development"],
      skill_markdown: {
        path: "SKILL.md",
        media_type: "text/markdown",
        bytes: Buffer.byteLength(skillMarkdown),
        hash: rawHash(Buffer.from(skillMarkdown)),
      },
      resources: [resource],
    };
    const manifest = {
      ...intrinsic,
      resource_count: 1,
      total_bytes: intrinsic.skill_markdown.bytes + resource.bytes,
      package_hash: sha256({
        name: intrinsic.name,
        description: intrinsic.description,
        version: intrinsic.version,
        required_runtime_capabilities: intrinsic.required_runtime_capabilities,
        skill_markdown_bytes: intrinsic.skill_markdown.bytes,
        skill_markdown_hash: intrinsic.skill_markdown.hash,
        resources: intrinsic.resources,
      }),
    };
    await mkdir(path.join(packageRoot, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(packageRoot, "skill.json"), canonicalJson(manifest), { mode: 0o600 });
    await writeFile(path.join(packageRoot, "SKILL.md"), skillMarkdown, { mode: 0o600 });
    await writeFile(path.join(packageRoot, resource.path), resourceBytes, { mode: 0o600 });
    let evidenceReads = 0;
    const boundedHost = createSkillsRuntimeHostForTest({
      statePath,
      socketPath: path.join(root, "runtime.sock"),
      configuredRoots: [configuredRoot],
      journal,
      now,
      randomId,
      hasServiceListener: () => Promise.resolve("absent"),
      evidenceStoreOperationHooks: {
        afterObjectRead: () => {
          evidenceReads += 1;
          return Promise.resolve();
        },
      },
    });
    let boundedHead: JournalHead | null = null;
    for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
      boundedHead = (
        await journal.transition(journalCommand("run-bounded-evidence", state, boundedHead))
      ).head;
    }
    if (boundedHead === null) throw new Error("bounded journal fixture failed");
    const boundedCatalog = await boundedHost.discover({
      query: null,
      allowed_capabilities: ["test-driven-development"],
    });
    const boundedDescriptor = boundedCatalog.descriptors.find(
      (descriptor) => descriptor.source.kind === "configured",
    );
    if (boundedDescriptor === undefined) throw new Error("configured skill fixture missing");
    const boundedSelection = await boundedHost.select({
      mode: "explicit",
      capability: "test-driven-development",
      allowed_capabilities: ["test-driven-development"],
      query: null,
      descriptor: {
        name: boundedDescriptor.name,
        version: boundedDescriptor.version,
        source: boundedDescriptor.source,
        package_hash: boundedDescriptor.package_hash,
        document_hash: boundedDescriptor.document_hash,
      },
    });
    await boundedHost.load(boundedSelection);
    await boundedHost.startPhase({
      run_id: "run-bounded-evidence",
      expected_journal_head: boundedHead,
      execution_request_hash: EXECUTION_REQUEST_HASH,
      selection: boundedSelection,
      phase: "TEST_DESIGN",
      input: Buffer.from("bounded evidence", "utf8"),
      operation_id: "bounded-evidence-phase",
      trace: TRACE,
    });
    await expect(boundedHost.evidence("run-bounded-evidence")).rejects.toMatchObject({
      code: "RUNTIME_SKILL_LIMIT_EXCEEDED",
    });
    expect(evidenceReads).toBe(0);
  }, 20_000);

  it("records distinct same-digest resources as included, partial, and omitted", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-skill-accounting-")));
    roots.push(root);
    const configuredRoot = path.join(root, "configured");
    const packageRoot = path.join(configuredRoot, "test-driven-development");
    const skillMarkdown = "# test-driven-development\n";
    const shared = Buffer.alloc(600_000, 0x78);
    const sharedHash = rawHash(shared);
    const resources = Array.from({ length: 5 }, (_, index) => ({
      path: `references/shared-${index}.md`,
      role: "reference" as const,
      phases: ["TEST_DESIGN"] as const,
      priority: index,
      media_type: "text/markdown",
      bytes: shared.byteLength,
      hash: sharedHash,
    }));
    const intrinsic = {
      name: "test-driven-development",
      description: "Exact same-digest context accounting fixture.",
      version: "1.0.0",
      required_runtime_capabilities: ["test-driven-development"],
      skill_markdown: {
        path: "SKILL.md",
        media_type: "text/markdown",
        bytes: Buffer.byteLength(skillMarkdown),
        hash: rawHash(Buffer.from(skillMarkdown)),
      },
      resources,
    };
    const manifest = {
      ...intrinsic,
      resource_count: resources.length,
      total_bytes:
        intrinsic.skill_markdown.bytes +
        resources.reduce((total, resource) => total + resource.bytes, 0),
      package_hash: sha256({
        name: intrinsic.name,
        description: intrinsic.description,
        version: intrinsic.version,
        required_runtime_capabilities: intrinsic.required_runtime_capabilities,
        skill_markdown_bytes: intrinsic.skill_markdown.bytes,
        skill_markdown_hash: intrinsic.skill_markdown.hash,
        resources,
      }),
    };
    await mkdir(path.join(packageRoot, "references"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(packageRoot, "skill.json"), canonicalJson(manifest), { mode: 0o600 });
    await writeFile(path.join(packageRoot, "SKILL.md"), skillMarkdown, { mode: 0o600 });
    await Promise.all(
      resources.map((resource) =>
        writeFile(path.join(packageRoot, resource.path), shared, { mode: 0o600 }),
      ),
    );

    const statePath = path.join(root, "state");
    const now = clock();
    const randomId = ids();
    const journal = createRunJournalStore({ statePath, now, randomId });
    let head: JournalHead | null = null;
    for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
      head = (await journal.transition(journalCommand("run-accounting", state, head))).head;
    }
    if (head === null) throw new Error("accounting journal fixture failed");
    const host = createSkillsRuntimeHostForTest({
      statePath,
      socketPath: path.join(root, "runtime.sock"),
      configuredRoots: [configuredRoot],
      journal,
      now,
      randomId,
      hasServiceListener: () => Promise.resolve("absent"),
    });
    const catalog = await host.discover({
      query: null,
      allowed_capabilities: ["test-driven-development"],
    });
    const descriptor = catalog.descriptors.find(
      (candidate) => candidate.source.kind === "configured",
    );
    if (descriptor === undefined) throw new Error("configured descriptor expected");
    const selected = await host.select({
      mode: "explicit",
      capability: "test-driven-development",
      allowed_capabilities: ["test-driven-development"],
      query: null,
      descriptor: {
        name: descriptor.name,
        version: descriptor.version,
        source: descriptor.source,
        package_hash: descriptor.package_hash,
        document_hash: descriptor.document_hash,
      },
    });
    const started = await host.startPhase({
      run_id: "run-accounting",
      expected_journal_head: head,
      execution_request_hash: EXECUTION_REQUEST_HASH,
      selection: selected,
      phase: "TEST_DESIGN",
      input: Buffer.from("account exact resources", "utf8"),
      operation_id: "accounting-phase",
      trace: TRACE,
    });

    expect(started.phase.context_accounting.resources.map((resource) => resource.state)).toEqual([
      "INCLUDED",
      "INCLUDED",
      "INCLUDED",
      "PARTIAL",
      "OMITTED",
    ]);
    expect(
      new Set(started.phase.context_accounting.resources.map((resource) => resource.path)).size,
    ).toBe(5);
    expect(
      new Set(started.phase.context_accounting.resources.map((resource) => resource.source_hash)),
    ).toEqual(new Set([sharedHash]));
    const partial = started.phase.context_accounting.resources[3]!;
    expect(partial.included_bytes).toBeGreaterThan(0);
    expect(partial.included_bytes).toBeLessThan(partial.original_bytes);
  }, 20_000);
});
