import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import type { TransitionCommand } from "../src/journal/state-machine.js";
import type { JournalHead, RunState } from "../src/journal/types.js";
import { createRunJournalStore } from "../src/journal/store.js";
import { canonicalJson, sha256 } from "../src/protocol/json.js";
import { parseSkillExecutionEvidence } from "../src/skills/contracts.js";
import { createSkillsHost, SKILL_LIMITS, type SkillsHost } from "../src/skills/index.js";
import type { SkillSelection } from "../src/skills/catalog.js";
import type { SkillSnapshotV1, SuperpowersPhaseName } from "../src/skills/types.js";

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
    output: Buffer.from(`${phase} output`, "utf8"),
    trace: TRACE,
  });
}

function resign<T extends Record<string, unknown>>(value: T): T {
  const hashable = { ...value };
  delete hashable.document_hash;
  return { ...hashable, document_hash: sha256(hashable) };
}

describe("canonical Agent Skills evidence", () => {
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
    const host = createSkillsHost({
      statePath,
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
    expect(Object.isFrozen(evidence.skill)).toBe(true);
    expect(Object.isFrozen(evidence.phases)).toBe(true);
    expect(Object.isFrozen(evidence.approvals)).toBe(true);
    expect(evidence.phases.map((phase) => phase.phase)).toEqual([
      "BRAINSTORMING",
      "TEST_DESIGN",
      "RED",
      "GREEN",
      "DEBUGGING",
      "REVIEW",
      "VERIFICATION",
    ]);
    expect(evidence.approvals).toHaveLength(1);
    expect(evidence.approvals[0]?.decision_hash).toBe(approved.approval?.document_hash);
    expect(evidence.context_hashes).toHaveLength(7);
    expect(Buffer.byteLength(canonicalJson(evidence), "utf8")).toBeLessThanOrEqual(
      SKILL_LIMITS.evidenceBytes,
    );
    expect(canonicalJson(evidence)).not.toMatch(/SKILL\.md|approved plan|\/private\//u);

    const mutations: readonly Record<string, unknown>[] = [
      { catalog_hash: `sha256:${"1".repeat(64)}` },
      { skill: { ...evidence.skill, package_hash: `sha256:${"2".repeat(64)}` } },
      { resource_hashes: [`sha256:${"3".repeat(64)}`] },
      {
        phases: [
          { ...evidence.phases[0], handler_hash: `sha256:${"4".repeat(64)}` },
          ...evidence.phases.slice(1),
        ],
      },
      {
        approvals: [{ ...evidence.approvals[0]!, request_hash: `sha256:${"5".repeat(64)}` }],
      },
      {
        context_hashes: evidence.context_hashes
          .map((hash, index) => (index === 0 ? `sha256:${"6".repeat(64)}` : hash))
          .sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
      },
      { handoff_hash: `sha256:${"7".repeat(64)}` },
    ];
    for (const mutation of mutations) {
      const parsed = parseSkillExecutionEvidence(
        canonicalJson(resign({ ...evidence, ...mutation })),
      );
      expect(parsed).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
      if (!parsed.ok) expect(parsed.issues.map((issue) => issue.keyword)).toContain("handoffHash");
    }
  }, 20_000);
});
