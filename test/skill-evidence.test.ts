import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import type { TransitionCommand } from "../src/journal/state-machine.js";
import type { JournalHead, RunState } from "../src/journal/types.js";
import { createRunJournalStore } from "../src/journal/store.js";
import { canonicalJson, sha256 } from "../src/protocol/json.js";
import { hashSkillExecutionHandoff, parseSkillExecutionEvidence } from "../src/skills/contracts.js";
import { SKILL_LIMITS, type SkillsHost } from "../src/skills/index.js";
import { createSkillsRuntimeHostForTest } from "../src/skills/runtime-host.js";
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
    expect(evidence.snapshots).toHaveLength(5);
    expect(evidence.approvals).toHaveLength(1);
    expect(evidence.approvals[0]?.decision?.document_hash).toBe(approved.approval?.document_hash);
    expect(evidence.approvals[0]?.decision_journal_head).toEqual(approved.journal_head);
    expect(evidence.phases.every((phase) => phase.context_accounting.segment_count > 0)).toBe(true);
    expect(Buffer.byteLength(canonicalJson(evidence), "utf8")).toBeLessThanOrEqual(
      SKILL_LIMITS.evidenceBytes,
    );
    expect(canonicalJson(evidence)).not.toMatch(/SKILL\.md|approved plan|\/private\//u);

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
    const mutations: readonly Record<string, unknown>[] = [
      { snapshots: [...evidence.snapshots].reverse() },
      { phases: [...evidence.phases.slice(0, -1), mutatedLatest] },
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
            decision_journal_head: evidence.approvals[0]!.request.pending_journal_head,
          },
        ],
      },
      { journal_head: evidence.approvals[0]!.request.pending_journal_head },
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
});
