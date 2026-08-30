import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import { createRunJournalStore, type RunJournalStore } from "../src/journal/store.js";
import type { TransitionCommand } from "../src/journal/state-machine.js";
import type { JournalHead, RunState } from "../src/journal/types.js";
import { canonicalJson, sha256 } from "../src/protocol/json.js";
import type { SkillCatalog, SkillSelection } from "../src/skills/catalog.js";
import { hashSkillPackage } from "../src/skills/contracts.js";
import {
  createSkillsEngineForTest,
  ZERO_PHASE_HASH,
  type CompleteSuperpowersPhaseRequest,
  type PhaseHistoryOperationHooks,
  type SkillsEngine,
  type StartSuperpowersPhaseRequest,
} from "../src/skills/engine.js";
import { RuntimeSkillError } from "../src/skills/errors.js";
import type { SkillLoader } from "../src/skills/loader.js";
import { builtInSuperpowersHandler } from "../src/skills/phases.js";
import type { SkillSnapshotV1, SuperpowersPhaseName } from "../src/skills/types.js";

const roots: string[] = [];
const TRACE = {
  trace_id: "1".repeat(32),
  span_id: "2".repeat(16),
  trace_flags: 1,
} as const;
const EXECUTION_REQUEST_HASH = `sha256:${"e".repeat(64)}` as const;

function rawHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function document<T extends Record<string, unknown>>(
  value: T,
): T & { document_hash: `sha256:${string}` } {
  return { ...value, document_hash: sha256(value) };
}

function snapshot(name: string): SkillSnapshotV1 {
  const skillBytes = Buffer.from(`# ${name}\n`, "utf8");
  const descriptorBase = {
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "skill-descriptor.v1" as const,
    document_type: "skill-descriptor" as const,
    name,
    description: `${name} fixture`,
    version: "1.0.0",
    source: { kind: "bundled" as const, identity: name },
    package_hash: `sha256:${"0".repeat(64)}` as const,
    resource_count: 0,
    total_bytes: skillBytes.byteLength,
    required_runtime_capabilities: [] as const,
  };
  const package_hash = hashSkillPackage({
    descriptor: document(descriptorBase),
    skill_markdown_hash: rawHash(skillBytes),
    skill_markdown_bytes: skillBytes.byteLength,
    resources: [],
  });
  const descriptor = document({ ...descriptorBase, package_hash });
  return document({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "skill-snapshot.v1" as const,
    document_type: "skill-snapshot" as const,
    descriptor,
    skill_markdown_hash: rawHash(skillBytes),
    skill_markdown_bytes: skillBytes.byteLength,
    resources: [],
    package_hash,
    total_bytes: skillBytes.byteLength,
  });
}

function selection(value: SkillSnapshotV1): SkillSelection {
  return Object.freeze({
    descriptor: value.descriptor,
    catalog_hash: `sha256:${"c".repeat(64)}`,
    package_handle: sha256({ name: value.descriptor.name }),
  });
}

function fakeCatalog(): SkillCatalog {
  return {
    discover: () => Promise.resolve(Object.freeze({ descriptors: [], catalog_hash: sha256([]) })),
    select: () => {
      throw new Error("selection fixture is not configured");
    },
  };
}

function fakeLoader(snapshots: ReadonlyMap<string, SkillSnapshotV1>): SkillLoader {
  const exact = (selected: SkillSelection): SkillSnapshotV1 => {
    const value = snapshots.get(selected.descriptor.name);
    if (value === undefined) throw new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY");
    return value;
  };
  return {
    load: (selected) => Promise.resolve(exact(selected)),
    assembleContext: (selected, request) => {
      const value = exact(selected);
      if (request.snapshot_hash !== value.document_hash || request.snapshot !== value) {
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
          segments: [],
          included_resource_hashes: [],
          omitted_resource_hashes: [],
          original_utf8_bytes: 0,
          included_utf8_bytes: 0,
          original_tokens: 0,
          included_tokens: 0,
          remaining_bytes: request.max_bytes,
          remaining_tokens: request.max_tokens,
          truncations: [],
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

async function fixture(): Promise<{ readonly root: string; readonly statePath: string }> {
  const root = await mkdtemp(path.join(await realpath("/tmp"), "toss-skill-engine-"));
  roots.push(root);
  return { root, statePath: path.join(root, "state") };
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
  runId = "run-1",
): Promise<{ journal: RunJournalStore; head: JournalHead }> {
  const journal = createRunJournalStore({ statePath, now: clock(), randomId: ids(100) });
  let head: JournalHead | null = null;
  for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
    head = (await journal.transition(journalCommand(runId, state, head))).head;
  }
  if (head === null) throw new Error("running journal fixture did not produce a head");
  return { journal, head };
}

function engine(
  statePath: string,
  journal: RunJournalStore,
  values: readonly SkillSnapshotV1[],
  options: { readonly hooks?: PhaseHistoryOperationHooks; readonly idOffset?: number } = {},
): SkillsEngine {
  return createSkillsEngineForTest({
    statePath,
    journal,
    catalog: fakeCatalog(),
    loader: fakeLoader(new Map(values.map((value) => [value.descriptor.name, value]))),
    now: clock(),
    randomId: ids(options.idOffset ?? 200),
    ...(options.hooks === undefined ? {} : { historyHooks: options.hooks }),
  });
}

function startRequest(
  head: JournalHead,
  value: SkillSnapshotV1,
  phase: SuperpowersPhaseName,
  operationId: string,
  overrides: Partial<StartSuperpowersPhaseRequest> = {},
): StartSuperpowersPhaseRequest {
  return {
    run_id: "run-1",
    expected_journal_head: head,
    execution_request_hash: EXECUTION_REQUEST_HASH,
    selection: selection(value),
    phase,
    input: Buffer.from(`${phase} input`, "utf8"),
    operation_id: operationId,
    trace: TRACE,
    ...overrides,
  };
}

function completeRequest(
  started: Awaited<ReturnType<SkillsEngine["startPhase"]>>,
  outcome: "COMPLETED" | "FAILED" | "BLOCKED" = "COMPLETED",
  output: Uint8Array = Buffer.from("phase output", "utf8"),
  overrides: Partial<CompleteSuperpowersPhaseRequest> = {},
): CompleteSuperpowersPhaseRequest {
  return {
    run_id: started.phase.run_id,
    expected_phase_revision: started.phase.phase_revision,
    expected_phase_head_hash: started.phase.document_hash,
    phase: started.phase.phase,
    skill_snapshot_hash: started.phase.skill.snapshot_hash,
    operation_id: started.phase.operation_id,
    outcome,
    output,
    trace: TRACE,
    ...overrides,
  };
}

async function runPhase(
  host: SkillsEngine,
  head: JournalHead,
  value: SkillSnapshotV1,
  phase: SuperpowersPhaseName,
  operationId: string,
) {
  const started = await host.startPhase(startRequest(head, value, phase, operationId));
  return host.completePhase(completeRequest(started));
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("hash-chained Superpowers phase history", () => {
  it("persists a private first record and an exact hash-linked completion", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const tdd = snapshot("test-driven-development");
    const host = engine(statePath, journal, [tdd]);

    const started = await host.startPhase(startRequest(head, tdd, "TEST_DESIGN", "operation-1"));
    const completed = await host.completePhase(completeRequest(started));
    const history = await host.phaseHistory("run-1");
    const historyPath = path.join(statePath, "skills", "phases", "run-1.jsonl");

    expect(started.phase).toMatchObject({
      phase_revision: 1,
      previous_phase_hash: ZERO_PHASE_HASH,
      status: "STARTED",
      observed_journal_head: head,
      input_hash: rawHash(Buffer.from("TEST_DESIGN input")),
      handler: {
        version: builtInSuperpowersHandler("TEST_DESIGN").version,
        hash: builtInSuperpowersHandler("TEST_DESIGN").hash,
      },
    });
    expect(completed.phase).toMatchObject({
      phase_revision: 2,
      previous_phase_hash: started.phase.document_hash,
      status: "COMPLETED",
      output_hash: rawHash(Buffer.from("phase output")),
    });
    expect(history).toEqual([started.phase, completed.phase]);
    expect((await lstat(statePath)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.dirname(historyPath))).mode & 0o777).toBe(0o700);
    expect((await lstat(historyPath)).mode & 0o777).toBe(0o600);
  });

  it("replays an identical operation without growth and rejects conflicting reuse", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const tdd = snapshot("test-driven-development");
    const host = engine(statePath, journal, [tdd]);
    const request = startRequest(head, tdd, "TEST_DESIGN", "operation-1");
    const first = await host.startPhase(request);
    const historyPath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    const size = (await lstat(historyPath)).size;

    await expect(host.startPhase(request)).resolves.toEqual({ ...first, replayed: true });
    expect((await lstat(historyPath)).size).toBe(size);
    await expect(
      host.startPhase({ ...request, input: Buffer.from("different") }),
    ).rejects.toMatchObject({ code: "RUNTIME_SKILL_OPERATION_CONFLICT" });
  });

  it("replays an exact completion and rejects changed output without growing history", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const tdd = snapshot("test-driven-development");
    const host = engine(statePath, journal, [tdd]);
    const started = await host.startPhase(startRequest(head, tdd, "TEST_DESIGN", "operation-1"));
    const request = completeRequest(started);
    const first = await host.completePhase(request);
    const historyPath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    const size = (await lstat(historyPath)).size;

    await expect(host.completePhase(request)).resolves.toEqual({ ...first, replayed: true });
    expect((await lstat(historyPath)).size).toBe(size);
    await expect(
      host.completePhase({ ...request, output: Buffer.from("different output") }),
    ).rejects.toMatchObject({ code: "RUNTIME_SKILL_OPERATION_CONFLICT" });
  });

  it("recovers and quarantines only an exact partial final record", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const tdd = snapshot("test-driven-development");
    const first = engine(statePath, journal, [tdd]);
    const started = await first.startPhase(startRequest(head, tdd, "TEST_DESIGN", "operation-1"));
    const fragment = Buffer.from('{"partial":', "utf8");
    const historyPath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    await appendFile(historyPath, fragment);

    const restarted = engine(statePath, journal, [tdd], { idOffset: 300 });
    await restarted.recover();

    expect(await restarted.phaseHistory("run-1")).toEqual([started.phase]);
    const artifacts = await readdir(path.join(statePath, "skills", "phases", "quarantine"));
    expect(artifacts).toHaveLength(1);
    expect(
      await readFile(path.join(statePath, "skills", "phases", "quarantine", artifacts[0]!)),
    ).toEqual(fragment);
  });

  it("coordinates two hosts so the same exact operation has one durable record", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const tdd = snapshot("test-driven-development");
    const first = engine(statePath, journal, [tdd], { idOffset: 400 });
    const second = engine(statePath, journal, [tdd], { idOffset: 500 });
    const request = startRequest(head, tdd, "TEST_DESIGN", "operation-1");

    const outcomes = await Promise.all([first.startPhase(request), second.startPhase(request)]);

    expect(outcomes.filter((outcome) => !outcome.replayed)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.replayed)).toHaveLength(1);
    expect(await first.phaseHistory("run-1")).toHaveLength(1);
  });
});

describe("governed phase execution", () => {
  it("enforces the exact TDD, debugging, review, and verification predecessors", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const tdd = snapshot("test-driven-development");
    const debugging = snapshot("systematic-debugging");
    const review = snapshot("requesting-code-review");
    const verification = snapshot("verification-before-completion");
    const host = engine(statePath, journal, [tdd, debugging, review, verification]);

    await expect(
      host.startPhase(startRequest(head, tdd, "RED", "red-early")),
    ).rejects.toMatchObject({
      code: "RUNTIME_SKILL_STALE_STATE",
    });
    await runPhase(host, head, tdd, "TEST_DESIGN", "test-design");
    await runPhase(host, head, tdd, "RED", "red");
    await expect(
      host.startPhase(startRequest(head, review, "REVIEW", "review-early")),
    ).rejects.toMatchObject({
      code: "RUNTIME_SKILL_STALE_STATE",
    });
    await runPhase(host, head, tdd, "GREEN", "green");
    await runPhase(host, head, debugging, "DEBUGGING", "debugging");
    await runPhase(host, head, review, "REVIEW", "review");
    await expect(
      runPhase(host, head, verification, "VERIFICATION", "verification"),
    ).resolves.toMatchObject({
      phase: { status: "COMPLETED", phase: "VERIFICATION" },
    });
  });

  it("rejects stale journals, relabeled capabilities, wrong snapshots, and changed handlers", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const tdd = snapshot("test-driven-development");
    const host = engine(statePath, journal, [tdd]);
    await expect(
      host.startPhase(
        startRequest(head, tdd, "TEST_DESIGN", "stale", {
          expected_journal_head: { ...head, entry_hash: `sha256:${"a".repeat(64)}` },
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SKILL_STALE_STATE" });
    await expect(
      host.startPhase(startRequest(head, tdd, "DEBUGGING", "relabel")),
    ).rejects.toMatchObject({
      code: "RUNTIME_SKILL_INTEGRITY",
    });

    const started = await host.startPhase(startRequest(head, tdd, "TEST_DESIGN", "operation-1"));
    await expect(
      host.completePhase(
        completeRequest(started, "COMPLETED", Buffer.from("output"), {
          skill_snapshot_hash: `sha256:${"a".repeat(64)}`,
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SKILL_STALE_STATE" });

    const phasePath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    const altered = JSON.parse((await readFile(phasePath, "utf8")).trim()) as Record<
      string,
      unknown
    >;
    altered.handler = { version: "different", hash: `sha256:${"b".repeat(64)}` };
    delete altered.document_hash;
    altered.document_hash = sha256(altered);
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(phasePath, `${canonicalJson(altered)}\n`, { mode: 0o600 }),
    );
    await expect(
      engine(statePath, journal, [tdd], { idOffset: 600 }).recover(),
    ).rejects.toMatchObject({
      code: "RUNTIME_SKILL_STALE_STATE",
    });
  });

  it("rejects oversized bytes and requires failed or blocked outputs to be empty", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const tdd = snapshot("test-driven-development");
    const host = engine(statePath, journal, [tdd]);
    await expect(
      host.startPhase(
        startRequest(head, tdd, "TEST_DESIGN", "too-large", {
          input: new Uint8Array(2_097_153),
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SKILL_LIMIT_EXCEEDED" });
    const started = await host.startPhase(startRequest(head, tdd, "TEST_DESIGN", "operation-1"));
    await expect(
      host.completePhase(completeRequest(started, "COMPLETED", new Uint8Array(2_097_153))),
    ).rejects.toMatchObject({ code: "RUNTIME_SKILL_LIMIT_EXCEEDED" });
    await expect(
      host.completePhase(completeRequest(started, "FAILED", Buffer.from("unpersistable"))),
    ).rejects.toMatchObject({ code: "RUNTIME_SKILL_INVALID" });
  });

  it("leaves brainstorming completion at the unavailable approval handoff without fake completion", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const brainstorming = snapshot("brainstorming");
    const host = engine(statePath, journal, [brainstorming]);
    const started = await host.startPhase(
      startRequest(head, brainstorming, "BRAINSTORMING", "brainstorm"),
    );

    await expect(host.completePhase(completeRequest(started))).rejects.toMatchObject({
      code: "RUNTIME_SKILL_UNAVAILABLE",
    });
    expect(await host.phaseHistory("run-1")).toEqual([started.phase]);
  });
});

describe("skills engine lifecycle and crash boundaries", () => {
  it("recovers an append interrupted before publication and can retry the exact operation", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const tdd = snapshot("test-driven-development");
    let crash = true;
    const crashing = engine(statePath, journal, [tdd], {
      hooks: {
        beforeCreatePublication: () => {
          if (crash) throw new Error("simulated crash");
        },
      },
      idOffset: 700,
    });
    const request = startRequest(head, tdd, "TEST_DESIGN", "operation-1");
    await expect(crashing.startPhase(request)).rejects.toThrow("simulated crash");
    crash = false;

    const restarted = engine(statePath, journal, [tdd], { idOffset: 800 });
    await restarted.recover();
    await expect(restarted.startPhase(request)).resolves.toMatchObject({ replayed: false });
    expect(await restarted.phaseHistory("run-1")).toHaveLength(1);
  });

  it("reconciles an exact first record published before a simulated crash", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const tdd = snapshot("test-driven-development");
    const crashing = engine(statePath, journal, [tdd], {
      hooks: {
        afterCreatePublication: (stagePath, historyPath) => {
          expect(path.basename(stagePath)).toMatch(/^\.phase-create\.[0-9a-f-]{36}\.stage$/u);
          expect(historyPath).toBe(path.join(statePath, "skills", "phases", "run-1.jsonl"));
          throw new Error("simulated post-publication crash");
        },
      },
      idOffset: 850,
    });
    const request = startRequest(head, tdd, "TEST_DESIGN", "operation-1");
    await expect(crashing.startPhase(request)).rejects.toThrow("simulated post-publication crash");

    const restarted = engine(statePath, journal, [tdd], { idOffset: 875 });
    await restarted.recover();

    await expect(restarted.startPhase(request)).resolves.toMatchObject({ replayed: true });
    expect(await restarted.phaseHistory("run-1")).toHaveLength(1);
  });

  it("retries partial-tail recovery after a crash before the identity-bound rename", async () => {
    const { statePath } = await fixture();
    const { journal, head } = await runningJournal(statePath);
    const tdd = snapshot("test-driven-development");
    const first = engine(statePath, journal, [tdd], { idOffset: 880 });
    const started = await first.startPhase(startRequest(head, tdd, "TEST_DESIGN", "operation-1"));
    const fragment = Buffer.from('{"partial":', "utf8");
    const historyPath = path.join(statePath, "skills", "phases", "run-1.jsonl");
    await appendFile(historyPath, fragment);
    const crashing = engine(statePath, journal, [tdd], {
      hooks: {
        beforeRecoveryRename: () => {
          throw new Error("simulated recovery crash");
        },
      },
      idOffset: 890,
    });
    await expect(crashing.recover()).rejects.toThrow("simulated recovery crash");

    const restarted = engine(statePath, journal, [tdd], { idOffset: 895 });
    await restarted.recover();

    expect(await restarted.phaseHistory("run-1")).toEqual([started.phase]);
    expect(await readdir(path.join(statePath, "skills", "phases", "quarantine"))).toHaveLength(1);
  });

  it("rejects symlink ancestry even when the requested history file is absent", async () => {
    const { root, statePath } = await fixture();
    const journalState = path.join(root, "journal-state");
    const { journal } = await runningJournal(journalState);
    const outside = path.join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, statePath);
    const host = engine(statePath, journal, [snapshot("test-driven-development")]);

    await expect(host.phaseHistory("run-1")).rejects.toMatchObject({
      code: "RUNTIME_SKILL_PATH_UNSAFE",
    });
  });

  it("waits for accepted durability barriers and rejects all work after stop without creating roots", async () => {
    const { root, statePath } = await fixture();
    const separateState = path.join(root, "never-created");
    const { journal, head } = await runningJournal(statePath);
    const tdd = snapshot("test-driven-development");
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const atBarrier = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = engine(statePath, journal, [tdd], {
      hooks: {
        beforeHistoryFileSync: async () => {
          entered?.();
          await barrier;
        },
      },
      idOffset: 900,
    });
    const accepted = host.startPhase(startRequest(head, tdd, "TEST_DESIGN", "operation-1"));
    await atBarrier;
    host.stopIntake();
    await expect(host.discover({ query: null, allowed_capabilities: [] })).rejects.toMatchObject({
      code: "RUNTIME_SKILL_UNAVAILABLE",
    });
    const flushed = host.flush(new AbortController().signal);
    let flushFinished = false;
    void flushed.then(() => {
      flushFinished = true;
    });
    await Promise.resolve();
    expect(flushFinished).toBe(false);
    release?.();
    await accepted;
    await flushed;

    const stopped = engine(separateState, journal, [tdd], { idOffset: 1_000 });
    stopped.stopIntake();
    await expect(stopped.recover()).rejects.toMatchObject({ code: "RUNTIME_SKILL_UNAVAILABLE" });
    await expect(stopped.phaseHistory("run-1")).rejects.toMatchObject({
      code: "RUNTIME_SKILL_UNAVAILABLE",
    });
    await expect(
      stopped.startPhase(
        startRequest(head, tdd, "TEST_DESIGN", "stopped-large", {
          input: new Uint8Array(2_097_153),
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SKILL_UNAVAILABLE" });
    await expect(access(separateState)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
