import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
import {
  approvalDecision,
  approvalDecisionCommand,
  approvalPendingCommand,
  approvalRequest,
  approvalTerminalPhase,
  requestSuperpowersApproval,
} from "../src/skills/approval.js";
import {
  canonicalSkillEvidenceJson,
  hashSkillCatalog,
  hashSkillExecutionEvidence,
  hashSkillExecutionHandoff,
  parseSkillExecutionEvidence,
  SKILL_EVIDENCE_JSON_LIMITS,
} from "../src/skills/contracts.js";
import * as skillContracts from "../src/skills/contracts.js";
import { SKILL_LIMITS, type SkillsHost } from "../src/skills/index.js";
import { createSkillEvidenceBuilder } from "../src/skills/evidence.js";
import type { SkillsEngine } from "../src/skills/engine.js";
import { builtInSuperpowersHandler } from "../src/skills/phases.js";
import { createSkillPrivateStoreForTest } from "../src/skills/private-store.js";
import { createSkillsRuntimeHostForTest } from "../src/skills/runtime-host.js";
import type { SkillSelection } from "../src/skills/catalog.js";
import type {
  SkillExecutionEvidenceV1,
  SkillJournalPathLinkV1,
  SkillSnapshotV1,
  SuperpowersPhaseName,
  SuperpowersPhaseV1,
} from "../src/skills/types.js";
import { validSkillExecutionEvidence, validSuperpowersPhase } from "./support/skill-fixtures.js";

const TRACE = {
  trace_id: "1".repeat(32),
  span_id: "2".repeat(16),
  trace_flags: 1,
} as const;
const EXECUTION_REQUEST_HASH = `sha256:${"e".repeat(64)}` as const;
const DENSE_HEAP_TEST = "rejects near-2-MiB dense shapes under a 64 MiB old-space bound";
const roots: string[] = [];

type EvidenceSerializationProbe = Readonly<{
  scanned_code_units: number;
  max_buffered_string_bytes: number;
  members: number;
}>;

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
  return {
    ...withHandoff,
    document_hash: hashSkillExecutionEvidence({
      ...withHandoff,
      document_hash: `sha256:${"0".repeat(64)}`,
    } as SkillExecutionEvidenceV1),
  };
}

function unboundedCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(unboundedCanonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("JSON value expected");
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${unboundedCanonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function unboundedHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(unboundedCanonicalJson(value), "utf8").digest("hex")}`;
}

function highMemberEvidence(packageCount = 224): SkillExecutionEvidenceV1 {
  const base = validSkillExecutionEvidence();
  const capabilities = Array.from(
    { length: 256 },
    (_unused, index) => `A${index.toString(16).padStart(2, "0")}`,
  );
  const snapshots = Array.from({ length: packageCount }, (_unused, index) => {
    const version = `1.0.${index.toString().padStart(3, "0")}`;
    const skillMarkdownHash = sha256({ kind: "high-member-markdown", index });
    const packageHash = sha256({
      name: "test-driven-development",
      description: "x",
      version,
      required_runtime_capabilities: capabilities,
      skill_markdown_bytes: 1,
      skill_markdown_hash: skillMarkdownHash,
      resources: [],
    });
    const descriptor = resign({
      protocol_version: "runtime-contract.v1",
      schema_version: "skill-descriptor.v1",
      document_type: "skill-descriptor",
      name: "test-driven-development",
      description: "x",
      version,
      source: { kind: "configured", identity: `skill-${index.toString().padStart(3, "0")}` },
      package_hash: packageHash,
      resource_count: 0,
      total_bytes: 1,
      required_runtime_capabilities: capabilities,
    });
    return resign({
      protocol_version: "runtime-contract.v1",
      schema_version: "skill-snapshot.v1",
      document_type: "skill-snapshot",
      descriptor,
      skill_markdown_hash: skillMarkdownHash,
      skill_markdown_bytes: 1,
      resources: [],
      package_hash: packageHash,
      total_bytes: 1,
    }) as unknown as SkillSnapshotV1;
  }).sort((left, right) => left.document_hash.localeCompare(right.document_hash));
  const descriptors = snapshots
    .map((snapshot) => snapshot.descriptor)
    .sort((left, right) => left.version.localeCompare(right.version));
  const catalogHash = hashSkillCatalog(
    descriptors.map((descriptor) => ({
      name: descriptor.name,
      version: descriptor.version,
      source: descriptor.source,
      package_hash: descriptor.package_hash,
      document_hash: descriptor.document_hash,
    })),
  );
  const handler = builtInSuperpowersHandler("TEST_DESIGN");
  const phases: SuperpowersPhaseV1[] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    const skill = {
      name: snapshot.descriptor.name,
      version: snapshot.descriptor.version,
      source: snapshot.descriptor.source,
      package_hash: snapshot.descriptor.package_hash,
      document_hash: snapshot.descriptor.document_hash,
      snapshot_hash: snapshot.document_hash,
    };
    const common = {
      protocol_version: "runtime-contract.v1",
      schema_version: "superpowers-phase.v1",
      document_type: "superpowers-phase",
      run_id: base.run_id,
      execution_request_hash: EXECUTION_REQUEST_HASH,
      observed_journal_head: base.journal_head,
      catalog_hash: catalogHash,
      skill,
      phase: "TEST_DESIGN",
      handler: { version: handler.version, hash: handler.hash },
      operation_id: `high-member-${index}`,
      predecessor_phase_hashes: [],
      input_hash: sha256({ kind: "high-member-input", index }),
      context_hash: sha256({ kind: "high-member-context", index }),
      context_accounting: {
        skill_markdown: {
          path: "SKILL.md",
          source_hash: snapshot.skill_markdown_hash,
          state: "INCLUDED",
          original_bytes: 1,
          included_bytes: 1,
          included_hash: snapshot.skill_markdown_hash,
          original_conservative_units: 1,
          included_conservative_units: 1,
        },
        resources: [],
        original_utf8_bytes: 1,
        included_utf8_bytes: 1,
        original_conservative_units: 1,
        included_conservative_units: 1,
        remaining_bytes: 0,
        remaining_conservative_units: 0,
        segment_count: 1,
        truncation_count: 0,
      },
      terminal_code: null,
      occurred_at: "2026-08-30T12:00:03.000Z",
      trace: TRACE,
    } as const;
    const started = resign({
      ...common,
      phase_revision: phases.length + 1,
      previous_phase_hash: phases.at(-1)?.document_hash ?? `sha256:${"0".repeat(64)}`,
      status: "STARTED",
      output_hash: null,
    }) as unknown as SuperpowersPhaseV1;
    phases.push(started);
    phases.push(
      resign({
        ...common,
        phase_revision: phases.length + 1,
        previous_phase_hash: started.document_hash,
        status: "COMPLETED",
        output_hash: sha256({ kind: "high-member-output", index }),
      }) as unknown as SuperpowersPhaseV1,
    );
  }
  const preimage = {
    protocol_version: base.protocol_version,
    schema_version: base.schema_version,
    document_type: base.document_type,
    run_id: base.run_id,
    journal_head: base.journal_head,
    run_state: base.run_state,
    journal_path: base.journal_path,
    terminal_journal_entry: null,
    catalogs: [{ descriptors, catalog_hash: catalogHash }],
    snapshots,
    phases,
    approvals: [],
    terminal_code: null,
  };
  const withHandoff = {
    ...preimage,
    handoff_hash: unboundedHash({
      schema_version: "skill-execution-handoff.v1",
      evidence: preimage,
    }),
  };
  return {
    ...withHandoff,
    document_hash: unboundedHash(withHandoff),
  };
}

function evidenceWithCatalogDescriptorCount(count: number): SkillExecutionEvidenceV1 {
  const base = validSkillExecutionEvidence();
  const selected = base.catalogs[0]!.descriptors[0]!;
  const descriptors = [
    selected,
    ...Array.from(
      { length: count - 1 },
      (_unused, index) =>
        resign({
          protocol_version: "runtime-contract.v1",
          schema_version: "skill-descriptor.v1",
          document_type: "skill-descriptor",
          name: `catalog-${String(index).padStart(4, "0")}`,
          description: "Legal multi-root catalog member.",
          version: "1.0.0",
          source: {
            kind: "configured",
            identity: `catalog-source-${String(index).padStart(4, "0")}`,
          },
          package_hash: sha256({ kind: "catalog-package", index }),
          resource_count: 0,
          total_bytes: 1,
          required_runtime_capabilities: [],
        }) as unknown as SkillSnapshotV1["descriptor"],
    ),
  ].sort((left, right) => {
    for (const [leftField, rightField] of [
      [left.name, right.name],
      [left.version, right.version],
      [left.source.kind, right.source.kind],
      [left.source.identity, right.source.identity],
      [left.package_hash, right.package_hash],
      [left.document_hash, right.document_hash],
    ] as const) {
      const order = Buffer.from(leftField).compare(Buffer.from(rightField));
      if (order !== 0) return order;
    }
    return 0;
  });
  const references = descriptors.map((descriptor) => ({
    name: descriptor.name,
    version: descriptor.version,
    source: descriptor.source,
    package_hash: descriptor.package_hash,
    document_hash: descriptor.document_hash,
  }));
  const catalogHash = unboundedHash(references);
  let previousPhaseHash = base.phases[0]!.previous_phase_hash;
  const phases = base.phases.map((phase) => {
    const next = resign({
      ...phase,
      catalog_hash: catalogHash,
      previous_phase_hash: previousPhaseHash,
    });
    previousPhaseHash = next.document_hash;
    return next;
  });
  return resignEvidence({
    ...base,
    catalogs: [{ descriptors, catalog_hash: catalogHash }],
    phases,
  }) as unknown as SkillExecutionEvidenceV1;
}

function validEvidenceJournalHistory(): readonly RunJournalEntryV1[] {
  const history: RunJournalEntryV1[] = [];
  for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
    const previous = history.at(-1);
    const transition = decideRunTransition(
      history,
      {
        run_id: "run-1",
        expected_revision: previous?.journal_revision ?? 0,
        expected_head_hash: previous?.entry_hash ?? ZERO_JOURNAL_HASH,
        command_id: `fixture-${state.toLowerCase()}`,
        operation_id: null,
        next_state: state,
        reason_code: `FIXTURE_${state}`,
        trace: TRACE,
        metadata: {},
        side_effect: null,
      },
      () => new Date(`2026-08-30T12:00:0${history.length}.000Z`),
    );
    if (transition.kind !== "append") throw new Error("fixture transition must append");
    history.push(transition.entry);
  }
  return history;
}

function denseSchemaOpenEvidence(shape: "array" | "object"): string {
  const prefix =
    '{"document_type":"skill-execution-evidence","schema_version":"skill-execution-evidence.v1","x":';
  const targetBytes = 2_000_000;
  if (shape === "array") {
    const members = Math.floor((targetBytes - prefix.length - 2) / 2);
    return `${prefix}[${"0,".repeat(members - 1)}0]}`;
  }
  const entries: string[] = [];
  let bytes = prefix.length + 2;
  for (let index = 0; ; index += 1) {
    const entry = `${index === 0 ? "" : ","}${JSON.stringify(index.toString(36))}:0`;
    if (bytes + entry.length > targetBytes) break;
    entries.push(entry);
    bytes += entry.length;
  }
  return `${prefix}{${entries.join("")}}}`;
}

function resignJournal(value: RunJournalEntryV1): RunJournalEntryV1 {
  const { entry_hash: entryHash, ...hashable } = value;
  void entryHash;
  return { ...hashable, entry_hash: hashRunJournalEntry(hashable) };
}

function resignJournalCommand(value: RunJournalEntryV1): RunJournalEntryV1 {
  return resignJournal({
    ...value,
    command_input_hash: sha256({
      run_id: value.run_id,
      expected_revision: value.journal_revision - 1,
      expected_head_hash: value.previous_entry_hash,
      operation_id: value.operation_id,
      next_state: value.state,
      reason_code: value.reason_code,
      trace: value.trace,
      metadata: value.metadata,
      side_effect: value.side_effect,
    }),
  });
}

function journalPathLink(entry: RunJournalEntryV1): SkillJournalPathLinkV1 {
  return {
    run_id: entry.run_id,
    journal_revision: entry.journal_revision,
    sequence: entry.sequence,
    previous_entry_hash: entry.previous_entry_hash,
    entry_hash: entry.entry_hash,
    previous_state: entry.previous_state,
    state: entry.state,
    run_attempt: entry.run_attempt,
  };
}

function resignZeroPhaseJournalPath(
  evidence: SkillExecutionEvidenceV1,
  mutate: (entry: SkillJournalPathLinkV1, index: number) => SkillJournalPathLinkV1,
): Record<string, unknown> {
  if (evidence.terminal_journal_entry === null || evidence.approvals.length !== 0) {
    throw new Error("zero-phase terminal evidence expected");
  }
  const terminalIndex = evidence.journal_path.length - 1;
  const path = evidence.journal_path.map((entry, index) => mutate(entry, index));
  const mutatedTerminalLink = path[terminalIndex]!;
  const terminal = resignJournalCommand({
    ...evidence.terminal_journal_entry,
    journal_revision: mutatedTerminalLink.journal_revision,
    sequence: mutatedTerminalLink.sequence,
    previous_entry_hash: mutatedTerminalLink.previous_entry_hash,
    previous_state: mutatedTerminalLink.previous_state,
    state: mutatedTerminalLink.state,
    run_attempt: mutatedTerminalLink.run_attempt,
  });
  path[terminalIndex] = journalPathLink(terminal);
  return resignEvidence({
    ...evidence,
    journal_path: path,
    terminal_journal_entry: terminal,
    journal_head: {
      journal_revision: terminal.journal_revision,
      sequence: terminal.sequence,
      entry_hash: terminal.entry_hash,
    },
    run_state: terminal.state,
  });
}

describe("canonical Agent Skills evidence", () => {
  it.each([257, 1_280])(
    "parses a legal %i-descriptor catalog root within the independent evidence envelope",
    (count) => {
      const evidence = evidenceWithCatalogDescriptorCount(count);
      const serialized = canonicalSkillEvidenceJson(evidence);
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(SKILL_LIMITS.evidenceBytes);
      expect(parseSkillExecutionEvidence(serialized)).toEqual({ ok: true, value: evidence });
    },
  );

  it("builds a real public evidence projection from a legal 257-descriptor catalog root", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-evidence-catalog-root-")));
    roots.push(root);
    const statePath = path.join(root, "state");
    const expected = evidenceWithCatalogDescriptorCount(257);
    const history = validEvidenceJournalHistory();
    const final = history.at(-1)!;
    const now = clock();
    const randomId = ids();
    const storeOptions = {
      statePath,
      now,
      randomId,
      hasServiceListener: () => Promise.resolve("absent" as const),
    };
    const store = createSkillPrivateStoreForTest(storeOptions);
    const catalog = expected.catalogs[0]!;
    const snapshot = expected.snapshots[0]!;
    await store.publishObject(
      catalog.catalog_hash,
      Buffer.from(
        canonicalJson({
          schema_version: "skill-private-catalog-root.v1",
          catalog_root: catalog,
        }),
        "utf8",
      ),
    );
    await store.publishObject(
      snapshot.package_hash,
      Buffer.from(
        canonicalJson({
          schema_version: "skill-private-object.v1",
          snapshot,
          skill_markdown_base64: "",
          resources: [],
        }),
        "utf8",
      ),
    );
    const engine = {
      evidenceHistory: () =>
        Promise.resolve({
          phases: expected.phases,
          journal: {
            run_id: "run-1",
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
    const builder = createSkillEvidenceBuilder({ ...storeOptions, engine });

    const evidence = await builder.evidence("run-1");
    expect(evidence).toEqual(expected);
    expect(parseSkillExecutionEvidence(canonicalSkillEvidenceJson(evidence))).toEqual({
      ok: true,
      value: expected,
    });
  });

  it("parses the legal 224-snapshot evidence shape below the byte limit", () => {
    const evidence = highMemberEvidence();
    let observed: EvidenceSerializationProbe | null = null;
    const serialized = skillContracts.withSkillEvidenceSerializationProbeForTest(
      (probe) => {
        observed = probe;
      },
      () => canonicalSkillEvidenceJson(evidence),
    );

    expect(serialized).toBe(unboundedCanonicalJson(evidence));
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(1_800_000);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(SKILL_LIMITS.evidenceBytes);
    expect(observed).not.toBeNull();
    expect(observed!.members).toBeGreaterThan(131_072);
    const parsed = parseSkillExecutionEvidence(serialized);
    expect(parsed).toEqual({ ok: true, value: evidence });
    if (parsed.ok) {
      expect(Object.isFrozen(parsed.value)).toBe(true);
      expect(Object.isFrozen(parsed.value.catalogs[0]?.descriptors[0])).toBe(true);
      expect(Object.isFrozen(parsed.value.phases.at(-1)?.context_accounting)).toBe(true);
    }
  });

  it("emits canonical JSON strings incrementally and stops before an escaping value can overflow", () => {
    const corpus = [
      "",
      'quote \" slash / backslash \\\\',
      "\u0000\b\t\n\f\r\u001f",
      "plain ASCII",
      "Türkçe 漢字",
      "emoji 😀 pair",
      "lone-high-\ud800",
      "lone-low-\udfff",
      "mixed-\ud800😀\udfff\u2028\u2029",
    ];
    for (const value of corpus) {
      expect(canonicalSkillEvidenceJson({ value })).toBe(canonicalJson({ value }));
    }

    const withProbe = (
      skillContracts as unknown as {
        withSkillEvidenceSerializationProbeForTest?: <T>(
          observe: (probe: EvidenceSerializationProbe) => void,
          operation: () => T,
        ) => T;
      }
    ).withSkillEvidenceSerializationProbeForTest;
    expect(withProbe).toBeTypeOf("function");

    const value = "\u0000".repeat(2_096_000);
    let observed: EvidenceSerializationProbe | null = null;
    expect(() =>
      withProbe?.(
        (probe) => {
          observed = probe;
        },
        () => hashSkillExecutionHandoff({ value } as never),
      ),
    ).toThrow(expect.objectContaining({ code: "RUNTIME_SKILL_LIMIT_EXCEEDED" }));
    expect(observed).not.toBeNull();
    expect(observed!.scanned_code_units).toBeLessThan(value.length);
    expect(observed!.scanned_code_units).toBeLessThan(400_000);
    expect(observed!.max_buffered_string_bytes).toBeLessThanOrEqual(4_096);
  });

  it("hashes only exact plain evidence documents without observing hidden properties", () => {
    const valid = Object.freeze({ ...validSkillExecutionEvidence() });
    expect(hashSkillExecutionEvidence(valid)).toBe(valid.document_hash);

    const invalidValues: object[] = [];
    const missing: Record<string, unknown> = { ...valid };
    delete missing.document_hash;
    invalidValues.push(missing);
    invalidValues.push({ ...valid, document_hash: 42 });

    let getterCalls = 0;
    for (const enumerable of [true, false]) {
      const accessor = { ...valid };
      Object.defineProperty(accessor, "document_hash", {
        enumerable,
        configurable: true,
        get() {
          getterCalls += 1;
          return valid.document_hash;
        },
      });
      invalidValues.push(accessor);
    }
    const hidden = { ...valid };
    Object.defineProperty(hidden, "document_hash", {
      enumerable: false,
      configurable: true,
      writable: true,
      value: valid.document_hash,
    });
    invalidValues.push(hidden);
    const exotic = Object.create({ inherited: true }) as object;
    invalidValues.push(Object.assign(exotic, valid));
    invalidValues.push(Object.assign({ ...valid }, { [Symbol("hidden")]: true }));
    const nestedAccessor = { ...valid, journal_head: { ...valid.journal_head } };
    Object.defineProperty(nestedAccessor.journal_head, "sequence", {
      enumerable: true,
      configurable: true,
      get: () => valid.journal_head.sequence,
    });
    invalidValues.push(nestedAccessor);
    const nestedHidden = { ...valid, journal_head: { ...valid.journal_head } };
    Object.defineProperty(nestedHidden.journal_head, "hidden", {
      enumerable: false,
      configurable: true,
      value: true,
    });
    invalidValues.push(nestedHidden);
    invalidValues.push({ ...valid, journal_head: { ...valid.journal_head, sequence: -0 } });
    invalidValues.push({ ...valid, journal_head: { ...valid.journal_head, sequence: Infinity } });
    const cycle: Record<string, unknown> = { ...valid };
    cycle.cycle = cycle;
    invalidValues.push(cycle);

    for (const candidate of invalidValues) {
      expect(() => hashSkillExecutionEvidence(candidate as SkillExecutionEvidenceV1)).toThrow(
        expect.objectContaining({ code: "RUNTIME_SKILL_LIMIT_EXCEEDED" }),
      );
    }
    expect(getterCalls).toBe(0);
  });

  it("rejects malformed or schema-open dense evidence and closes public hash limits", () => {
    const exactDense = `[${"0,".repeat(160_000 - 1)}0]`;
    expect(parseSkillExecutionEvidence(exactDense)).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: [{ keyword: "evidencePreflight" }],
    });

    const denseMembers = 180_000;
    const dense = `[${"0,".repeat(denseMembers - 1)}0]`;
    const denseResult = parseSkillExecutionEvidence(dense);
    expect(denseResult).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: [{ keyword: "evidencePreflight" }],
    });

    const tooDeep = `${"[".repeat(SKILL_EVIDENCE_JSON_LIMITS.maxDepth + 2)}0${"]".repeat(
      SKILL_EVIDENCE_JSON_LIMITS.maxDepth + 2,
    )}`;
    expect(parseSkillExecutionEvidence(tooDeep)).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: [{ keyword: "evidencePreflight" }],
    });

    const denseUnderByteLimit = `[${"0,".repeat(
      Math.floor((SKILL_LIMITS.evidenceBytes - 3) / 2),
    )}0]`;
    expect(Buffer.byteLength(denseUnderByteLimit, "utf8")).toBeLessThanOrEqual(
      SKILL_LIMITS.evidenceBytes,
    );
    expect(parseSkillExecutionEvidence(denseUnderByteLimit)).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: [{ keyword: "evidencePreflight" }],
    });

    const overByte = {
      run_id: "x".repeat(SKILL_LIMITS.evidenceBytes),
    };
    expect(() => hashSkillExecutionHandoff(overByte as never)).toThrow(
      expect.objectContaining({ code: "RUNTIME_SKILL_LIMIT_EXCEEDED" }),
    );
    expect(() => hashSkillExecutionEvidence(overByte as never)).toThrow(
      expect.objectContaining({ code: "RUNTIME_SKILL_LIMIT_EXCEEDED" }),
    );
    let overDepth: unknown = 0;
    for (let depth = 0; depth < SKILL_EVIDENCE_JSON_LIMITS.maxDepth + 2; depth += 1) {
      overDepth = [overDepth];
    }
    expect(() => hashSkillExecutionHandoff(overDepth as never)).toThrow(
      expect.objectContaining({ code: "RUNTIME_SKILL_LIMIT_EXCEEDED" }),
    );
    expect(() => hashSkillExecutionEvidence(overDepth as never)).toThrow(
      expect.objectContaining({ code: "RUNTIME_SKILL_LIMIT_EXCEEDED" }),
    );
    expect(parseSkillExecutionEvidence(" ".repeat(SKILL_LIMITS.evidenceBytes + 1))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });

    const exactDenseObject = `{${Array.from(
      { length: 160_000 },
      (_unused, index) => `${JSON.stringify(index.toString(36))}:0`,
    ).join(",")}}`;
    expect(Buffer.byteLength(exactDenseObject, "utf8")).toBeLessThan(SKILL_LIMITS.evidenceBytes);
    const denseObjectResult = parseSkillExecutionEvidence(exactDenseObject);
    expect(denseObjectResult).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
    if (!denseObjectResult.ok) {
      expect(denseObjectResult.issues.some((entry) => entry.keyword === "evidencePreflight")).toBe(
        false,
      );
    }
  });

  it("rejects nested duplicate keys including escaped-equivalent spellings", () => {
    for (const input of [
      '{"x":1,"x":2}',
      '{"outer":{"a":1,"\\u0061":2}}',
      '{"outer":{"\\ud83d\\ude00":1,"😀":2}}',
    ]) {
      expect(parseSkillExecutionEvidence(input)).toMatchObject({
        ok: false,
        code: "RUNTIME_DOCUMENT_INVALID",
        issues: [{ keyword: "evidencePreflight" }],
      });
    }

    const evidence = validSkillExecutionEvidence();
    const escaped = canonicalSkillEvidenceJson(evidence)
      .replace('"document_type"', '"document_\\u0074ype"')
      .replaceAll("run-1", "run\\u002d1");
    expect(parseSkillExecutionEvidence(escaped)).toEqual({ ok: true, value: evidence });
  });

  it("matches the generic parser's rejection of malformed JSON without leaking diagnostics", () => {
    const malformed = [
      "",
      '{"x":01}',
      '{"x":1.}',
      '{"x":1e}',
      '{"x":1e400}',
      '{"x":NaN}',
      '{"x":"\\v"}',
      '{"x":"line\nbreak"}',
      '{"x":true,}',
      '{"x":/* no */true}',
      '{"x" true}',
      '{"x":true "y":false}',
      '{"x":true} trailing',
      '{"x":[0,]}',
      '{"x":{}} garbage',
    ];
    for (const input of malformed) {
      expect(() => parseJsonBytes(input)).toThrow();
      expect(parseSkillExecutionEvidence(input)).toMatchObject({
        ok: false,
        code: "RUNTIME_DOCUMENT_INVALID",
        issues: [{ keyword: "evidencePreflight" }],
      });
    }
    const invalidUtf8 = Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28]);
    expect(() => parseJsonBytes(invalidUtf8)).toThrow();
    expect(parseSkillExecutionEvidence(invalidUtf8)).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: [{ keyword: "evidencePreflight" }],
    });
  });

  it(
    DENSE_HEAP_TEST,
    () => {
      const childShape = process.env.TOSS_SKILL_EVIDENCE_DENSE_SHAPE;
      if (childShape === "array" || childShape === "object") {
        const input = denseSchemaOpenEvidence(childShape);
        expect(Buffer.byteLength(input, "utf8")).toBeGreaterThan(1_900_000);
        expect(Buffer.byteLength(input, "utf8")).toBeLessThan(SKILL_LIMITS.evidenceBytes);
        const result = parseSkillExecutionEvidence(input);
        expect(result).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
        if (!result.ok) {
          expect(result.issues.some((entry) => entry.keyword === "evidencePreflight")).toBe(false);
        }
        return;
      }

      for (const shape of ["array", "object"] as const) {
        const child = spawnSync(
          process.execPath,
          [
            "--max-old-space-size=64",
            path.join(process.cwd(), "node_modules/vitest/vitest.mjs"),
            "run",
            path.join(process.cwd(), "test/skill-evidence.test.ts"),
            "-t",
            DENSE_HEAP_TEST,
            "--maxWorkers=1",
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: { ...process.env, TOSS_SKILL_EVIDENCE_DENSE_SHAPE: shape },
            maxBuffer: 1_048_576,
            timeout: 60_000,
          },
        );
        expect(child.signal, `${shape}: ${child.stderr}`).toBeNull();
        expect(child.status, `${shape}: ${child.stdout}\n${child.stderr}`).toBe(0);
      }
    },
    130_000,
  );

  it("projects a metadata-dense official history as compact closed journal path links", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-evidence-compact-path-")));
    roots.push(root);
    const runId = "run-compact-path";
    const history: RunJournalEntryV1[] = [];
    const now = clock();
    const states: RunState[] = ["CREATED", "ROUTED", "RUNNING"];
    while (states.length < 131) states.push(states.at(-1) === "RUNNING" ? "FAILED" : "RUNNING");
    states.push("BLOCKED");
    const legalMetadata = Array.from({ length: 1_000 }, (_unused, index) => index);
    for (const state of states) {
      const previous = history.at(-1);
      const transition = decideRunTransition(
        history,
        {
          ...journalCommand(
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
          command_id: `${runId}-${state.toLowerCase()}-${history.length}`,
          reason_code: state === "BLOCKED" ? "BLOCKED_SUPERPOWERS_MISSING" : `MOVE_${state}`,
          metadata: legalMetadata,
        },
        now,
      );
      if (transition.kind !== "append") throw new Error("compact path fixture must append");
      history.push(transition.entry);
    }
    const final = history.at(-1)!;
    const engine = {
      evidenceHistory: () =>
        Promise.resolve({
          phases: [],
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
    });

    const evidence = await builder.evidence(runId);
    if (evidence === null) throw new Error("compact journal-path evidence expected");
    const projected = evidence as unknown as Readonly<Record<string, unknown>>;
    const journalPath = projected.journal_path as readonly Readonly<Record<string, unknown>>[];
    expect(projected.journal_entries).toBeUndefined();
    expect(journalPath).toHaveLength(132);
    expect(Object.keys(journalPath[0]!).sort()).toEqual(
      [
        "entry_hash",
        "journal_revision",
        "previous_entry_hash",
        "previous_state",
        "run_attempt",
        "run_id",
        "sequence",
        "state",
      ].sort(),
    );
    expect(journalPath.map((entry) => entry.entry_hash)).toEqual(
      history.map((entry) => entry.entry_hash),
    );
    const serialized = canonicalSkillEvidenceJson(evidence);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(SKILL_LIMITS.evidenceBytes);
    expect(parseSkillExecutionEvidence(serialized)).toEqual({ ok: true, value: evidence });
  });

  it("admits the complete 1024-link closed path below the exclusive member ceiling", () => {
    const base = validSkillExecutionEvidence();
    const journalPath = [...base.journal_path];
    while (journalPath.length < 1_024) {
      const previous = journalPath.at(-1)!;
      const state = previous.state === "RUNNING" ? "TOOL_PENDING" : "RUNNING";
      const sequence = previous.sequence + 1;
      journalPath.push({
        run_id: base.run_id,
        journal_revision: sequence,
        sequence,
        previous_entry_hash: previous.entry_hash,
        entry_hash: sha256({ kind: "maximum-journal-path", sequence }),
        previous_state: previous.state,
        state,
        run_attempt: previous.run_attempt,
      });
    }
    const final = journalPath.at(-1)!;
    const evidence = resignEvidence({
      ...base,
      journal_path: journalPath,
      journal_head: {
        journal_revision: final.journal_revision,
        sequence: final.sequence,
        entry_hash: final.entry_hash,
      },
      run_state: final.state,
    }) as unknown as SkillExecutionEvidenceV1;
    let observed: EvidenceSerializationProbe | null = null;
    const serialized = skillContracts.withSkillEvidenceSerializationProbeForTest(
      (probe) => {
        observed = probe;
      },
      () => canonicalSkillEvidenceJson(evidence),
    );

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(SKILL_LIMITS.evidenceBytes);
    expect(observed).not.toBeNull();
    expect(observed!.members).toBeLessThan(SKILL_EVIDENCE_JSON_LIMITS.maxMembers);
    expect(parseSkillExecutionEvidence(serialized)).toEqual({ ok: true, value: evidence });
  });

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
  }, 20_000);

  it("builds and parses a canonical 25-approval history from one real approval", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "toss-evidence-many-approvals-")),
    );
    roots.push(root);
    const statePath = path.join(root, "state");
    const now = clock();
    const randomId = ids();
    const journal = createRunJournalStore({ statePath, now, randomId });
    let head: JournalHead | null = null;
    for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
      head = (await journal.transition(journalCommand("run-many-approvals", state, head))).head;
    }
    if (head === null) throw new Error("many-approval journal fixture failed");
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
      run_id: "run-many-approvals",
      expected_journal_head: head,
      execution_request_hash: EXECUTION_REQUEST_HASH,
      selection: brainstorming.selection,
      phase: "BRAINSTORMING",
      input: Buffer.from("brainstorming input 0", "utf8"),
      operation_id: "many-approval-phase-0",
      trace: TRACE,
    });
    const pending = await host.completePhase({
      run_id: "run-many-approvals",
      expected_phase_revision: started.phase.phase_revision,
      expected_phase_head_hash: started.phase.document_hash,
      phase: started.phase.phase,
      skill_snapshot_hash: started.phase.skill.snapshot_hash,
      operation_id: started.phase.operation_id,
      outcome: "COMPLETED",
      terminal_code: null,
      output: Buffer.from("approved plan 0", "utf8"),
      trace: TRACE,
    });
    if (pending.approval?.kind !== "REQUEST") throw new Error("approval request expected");
    const approved = await host.resumeApproval({
      run_id: "run-many-approvals",
      expected_journal_head: pending.approval.pending_journal_head,
      phase: pending.approval.phase,
      skill_name: pending.approval.skill_name,
      skill_version: pending.approval.skill_version,
      skill_snapshot_hash: pending.approval.skill_snapshot_hash,
      approval_request_hash: pending.approval.document_hash,
      operation_id: "a0000000-0000-4000-8000-000000000000",
      decision: "APPROVE",
      trace: TRACE,
    });
    const official = await journal.load("run-many-approvals");
    if (official === null) throw new Error("many-approval official journal missing");
    const journalEntries = [...official.entries];
    const phases: SuperpowersPhaseV1[] = [started.phase, pending.phase, approved.phase];
    let journalHead = approved.journal_head;
    let previousPhaseHash = approved.phase.document_hash;
    for (let index = 1; index < 25; index += 1) {
      const nextStarted = resign({
        ...started.phase,
        phase_revision: index * 3 + 1,
        previous_phase_hash: previousPhaseHash,
        observed_journal_head: journalHead,
        operation_id: `many-approval-phase-${index}`,
        input_hash: sha256({ index, kind: "input" }),
      });
      const nextPending = requestSuperpowersApproval({
        started: nextStarted,
        output_hash: sha256({ index, kind: "output" }),
        occurred_at: now().toISOString(),
        trace: TRACE,
      });
      const pendingTransition = decideRunTransition(
        journalEntries,
        approvalPendingCommand(nextPending),
        now,
      );
      if (pendingTransition.kind !== "append") throw new Error("pending transition must append");
      journalEntries.push(pendingTransition.entry);
      const request = approvalRequest(nextPending, {
        journal_revision: pendingTransition.entry.journal_revision,
        sequence: pendingTransition.entry.sequence,
        entry_hash: pendingTransition.entry.entry_hash,
      });
      const decision = approvalDecision(request, {
        run_id: request.run_id,
        expected_journal_head: request.pending_journal_head,
        phase: request.phase,
        skill_name: request.skill_name,
        skill_version: request.skill_version,
        skill_snapshot_hash: request.skill_snapshot_hash,
        approval_request_hash: request.document_hash,
        operation_id: `a0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        decision: "APPROVE",
        trace: TRACE,
      });
      const terminal = approvalTerminalPhase({
        pending: nextPending,
        decision,
        occurred_at: now().toISOString(),
      });
      const decisionTransition = decideRunTransition(
        journalEntries,
        approvalDecisionCommand({ request, decision, terminal }),
        now,
      );
      if (decisionTransition.kind !== "append") throw new Error("decision must append");
      journalEntries.push(decisionTransition.entry);
      phases.push(nextStarted, nextPending, terminal);
      journalHead = {
        journal_revision: decisionTransition.entry.journal_revision,
        sequence: decisionTransition.entry.sequence,
        entry_hash: decisionTransition.entry.entry_hash,
      };
      previousPhaseHash = terminal.document_hash;
    }
    const final = journalEntries.at(-1)!;
    const engine = {
      evidenceHistory: () =>
        Promise.resolve({
          phases,
          journal: {
            run_id: "run-many-approvals",
            state: final.state,
            head: journalHead,
            entries: journalEntries,
            unresolved_side_effects: [],
          },
        }),
    } as unknown as SkillsEngine;
    const builder = createSkillEvidenceBuilder({
      statePath,
      engine,
      now,
      randomId,
      hasServiceListener: () => Promise.resolve("absent"),
    });

    const evidence = await builder.evidence("run-many-approvals");
    if (evidence === null) throw new Error("many-approval evidence expected");
    const serialized = canonicalSkillEvidenceJson(evidence);
    const bytes = Buffer.byteLength(serialized, "utf8");
    expect(evidence.approvals).toHaveLength(25);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(SKILL_LIMITS.evidenceBytes);
    expect(parseSkillExecutionEvidence(serialized)).toEqual({
      ok: true,
      value: evidence,
    });
  }, 20_000);

  it("builds and parses a semantically closed near-byte-limit approval projection", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-evidence-near-byte-")));
    roots.push(root);
    const statePath = path.join(root, "state");
    const now = clock();
    const randomId = ids();
    const journal = createRunJournalStore({ statePath, now, randomId });
    let officialHead: JournalHead | null = null;
    for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
      officialHead = (
        await journal.transition(journalCommand("run-near-byte", state, officialHead))
      ).head;
    }
    if (officialHead === null) throw new Error("near-byte journal fixture failed");
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
    const template = await host.startPhase({
      run_id: "run-near-byte",
      expected_journal_head: officialHead,
      execution_request_hash: EXECUTION_REQUEST_HASH,
      selection: brainstorming.selection,
      phase: "BRAINSTORMING",
      input: Buffer.from("near-byte template", "utf8"),
      operation_id: "near-byte-template",
      trace: TRACE,
    });
    const official = await journal.load("run-near-byte");
    if (official === null) throw new Error("near-byte official journal missing");
    const journalEntries = [...official.entries];
    const phases: SuperpowersPhaseV1[] = [];
    let journalHead = official.head;
    let previousPhaseHash: `sha256:${string}` = `sha256:${"0".repeat(64)}`;
    for (let index = 0; index < 96; index += 1) {
      const started = resign({
        ...template.phase,
        phase_revision: index * 3 + 1,
        previous_phase_hash: previousPhaseHash,
        observed_journal_head: journalHead,
        operation_id: `near-byte-phase-${index}`,
        input_hash: sha256({ index, kind: "input" }),
      });
      const pending = requestSuperpowersApproval({
        started,
        output_hash: sha256({ index, kind: "output" }),
        occurred_at: now().toISOString(),
        trace: TRACE,
      });
      const pendingTransition = decideRunTransition(
        journalEntries,
        approvalPendingCommand(pending),
        now,
      );
      if (pendingTransition.kind !== "append") throw new Error("pending transition must append");
      journalEntries.push(pendingTransition.entry);
      const request = approvalRequest(pending, {
        journal_revision: pendingTransition.entry.journal_revision,
        sequence: pendingTransition.entry.sequence,
        entry_hash: pendingTransition.entry.entry_hash,
      });
      const decision = approvalDecision(request, {
        run_id: request.run_id,
        expected_journal_head: request.pending_journal_head,
        phase: request.phase,
        skill_name: request.skill_name,
        skill_version: request.skill_version,
        skill_snapshot_hash: request.skill_snapshot_hash,
        approval_request_hash: request.document_hash,
        operation_id: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        decision: "APPROVE",
        trace: TRACE,
      });
      const terminal = approvalTerminalPhase({
        pending,
        decision,
        occurred_at: now().toISOString(),
      });
      const decisionTransition = decideRunTransition(
        journalEntries,
        approvalDecisionCommand({ request, decision, terminal }),
        now,
      );
      if (decisionTransition.kind !== "append") throw new Error("decision must append");
      journalEntries.push(decisionTransition.entry);
      phases.push(started, pending, terminal);
      journalHead = {
        journal_revision: decisionTransition.entry.journal_revision,
        sequence: decisionTransition.entry.sequence,
        entry_hash: decisionTransition.entry.entry_hash,
      };
      previousPhaseHash = terminal.document_hash;
    }
    const engine = {
      evidenceHistory: () =>
        Promise.resolve({
          phases,
          journal: {
            run_id: "run-near-byte",
            state: "RUNNING" as const,
            head: journalHead,
            entries: journalEntries,
            unresolved_side_effects: [],
          },
        }),
    } as unknown as SkillsEngine;
    const builder = createSkillEvidenceBuilder({
      statePath,
      engine,
      now,
      randomId,
      hasServiceListener: () => Promise.resolve("absent"),
    });

    const evidence = await builder.evidence("run-near-byte");
    if (evidence === null) throw new Error("near-byte evidence expected");
    let observed: EvidenceSerializationProbe | null = null;
    const serialized = skillContracts.withSkillEvidenceSerializationProbeForTest(
      (probe) => {
        observed = probe;
      },
      () => canonicalSkillEvidenceJson(evidence),
    );
    const bytes = Buffer.byteLength(serialized, "utf8");
    expect(evidence.approvals).toHaveLength(96);
    expect(bytes).toBeGreaterThan(Math.floor((SKILL_LIMITS.evidenceBytes * 3) / 4));
    expect(bytes).toBeLessThanOrEqual(SKILL_LIMITS.evidenceBytes);
    expect(observed).not.toBeNull();
    expect(observed!.members).toBeLessThan(SKILL_EVIDENCE_JSON_LIMITS.maxMembers);
    expect(parseSkillExecutionEvidence(serialized)).toEqual({ ok: true, value: evidence });
  }, 20_000);

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
    const schemaOpenApprovalMetadata = {
      ...approvalEvidence,
      approvals: [
        {
          ...approvalProjection,
          request_journal_entry: {
            ...approvalProjection.request_journal_entry,
            metadata: Array.from({ length: 1_000 }, (_unused, index) => index),
          },
        },
      ],
    };
    expect(parseSkillExecutionEvidence(canonicalJson(schemaOpenApprovalMetadata))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: [
        expect.objectContaining({
          path: "/approvals/0/request_journal_entry/metadata",
          keyword: "type",
        }),
      ],
    });
    const approvedTerminal = approvalEvidence.phases.at(-1)!;
    const requestEntry = approvalProjection.request_journal_entry;
    const advancedWithoutDecision = resignJournalCommand({
      ...approvalProjection.decision_journal_entry!,
      command_id: "resume-without-approval-decision",
      operation_id: null,
      reason_code: "UNBOUND_RESUME",
      metadata: {},
    });
    const unresolvedAfterAdvance = resignEvidence({
      ...approvalEvidence,
      phases: approvalEvidence.phases.slice(0, -1),
      approvals: [
        {
          ...approvalProjection,
          decision: null,
          decision_journal_entry: null,
        },
      ],
      run_state: "RUNNING",
      journal_head: {
        journal_revision: advancedWithoutDecision.journal_revision,
        sequence: advancedWithoutDecision.sequence,
        entry_hash: advancedWithoutDecision.entry_hash,
      },
      terminal_journal_entry: null,
      terminal_code: null,
    });
    expect(parseSkillExecutionEvidence(canonicalJson(unresolvedAfterAdvance))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });

    const unequalAttemptDecisionEntry = resignJournalCommand({
      ...approvalProjection.decision_journal_entry!,
      run_attempt: requestEntry.run_attempt + 1,
    });
    const unequalAttempts = resignEvidence({
      ...approvalEvidence,
      approvals: [
        {
          ...approvalProjection,
          decision_journal_entry: unequalAttemptDecisionEntry,
        },
      ],
      journal_head: {
        journal_revision: unequalAttemptDecisionEntry.journal_revision,
        sequence: unequalAttemptDecisionEntry.sequence,
        entry_hash: unequalAttemptDecisionEntry.entry_hash,
      },
    });
    expect(parseSkillExecutionEvidence(canonicalJson(unequalAttempts))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });

    const contradictoryGapTerminal = resignJournalCommand({
      ...approvalProjection.decision_journal_entry!,
      journal_revision: approvalProjection.decision_journal_entry!.journal_revision + 2,
      sequence: approvalProjection.decision_journal_entry!.sequence + 2,
      previous_entry_hash: requestEntry.entry_hash,
      command_id: "terminal-after-omitted-ordinary-entry",
      operation_id: null,
      previous_state: "RUNNING",
      state: "BLOCKED",
      reason_code: "BLOCKED_SUPERPOWERS_MISSING",
      timestamp: "2026-08-30T12:59:00.000Z",
      metadata: {},
    });
    const contradictoryGap = resignEvidence({
      ...approvalEvidence,
      run_state: "BLOCKED",
      journal_head: {
        journal_revision: contradictoryGapTerminal.journal_revision,
        sequence: contradictoryGapTerminal.sequence,
        entry_hash: contradictoryGapTerminal.entry_hash,
      },
      terminal_journal_entry: contradictoryGapTerminal,
      terminal_code: "BLOCKED_SUPERPOWERS_MISSING",
    });
    expect(parseSkillExecutionEvidence(canonicalJson(contradictoryGap))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });

    const lifecycleMutations = [
      resignEvidence({
        ...approvalEvidence,
        approvals: [
          {
            ...approvalProjection,
            decision: null,
            decision_journal_entry: null,
          },
        ],
      }),
      resignEvidence({
        ...approvalEvidence,
        run_state: "BLOCKED",
        terminal_code: null,
        terminal_journal_entry: null,
      }),
    ];
    for (const mutation of lifecycleMutations) {
      expect(parseSkillExecutionEvidence(canonicalJson(mutation))).toMatchObject({
        ok: false,
        code: "RUNTIME_DOCUMENT_INVALID",
      });
    }

    const forgedReasonEntry = resignJournalCommand({
      ...approvalProjection.decision_journal_entry!,
      reason_code: "FORGED_REASON",
    });
    const forgedReason = resignEvidence({
      ...approvalEvidence,
      approvals: [
        {
          ...approvalProjection,
          decision_journal_entry: forgedReasonEntry,
        },
      ],
      journal_head: {
        journal_revision: forgedReasonEntry.journal_revision,
        sequence: forgedReasonEntry.sequence,
        entry_hash: forgedReasonEntry.entry_hash,
      },
    });
    expect(parseSkillExecutionEvidence(canonicalJson(forgedReason))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });

    const traceDriftRequest = resign({
      ...approvalProjection.request,
      trace: { ...TRACE, trace_id: "9".repeat(32) },
    });
    const traceDriftDecision = resign({
      ...approvalProjection.decision!,
      approval_request_hash: traceDriftRequest.document_hash,
    });
    const traceDriftEntry = resignJournalCommand({
      ...approvalProjection.decision_journal_entry!,
      metadata: parseJsonBytes(
        canonicalJson({
          kind: "superpowers-approval-decision",
          request: traceDriftRequest,
          decision: traceDriftDecision,
          occurred_at: approvedTerminal.occurred_at,
          phase: approvedTerminal,
        }),
      ),
    });
    const traceDrift = resignEvidence({
      ...approvalEvidence,
      approvals: [
        {
          ...approvalProjection,
          request: traceDriftRequest,
          decision: traceDriftDecision,
          decision_journal_entry: traceDriftEntry,
        },
      ],
      journal_head: {
        journal_revision: traceDriftEntry.journal_revision,
        sequence: traceDriftEntry.sequence,
        entry_hash: traceDriftEntry.entry_hash,
      },
    });
    expect(parseSkillExecutionEvidence(canonicalJson(traceDrift))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });

    const decisionTrace = resign({
      ...approvalProjection.decision!,
      trace: { ...TRACE, span_id: "8".repeat(16) },
    });
    const decisionTraceEntry = resignJournalCommand({
      ...approvalProjection.decision_journal_entry!,
      metadata: parseJsonBytes(
        canonicalJson({
          kind: "superpowers-approval-decision",
          request: approvalProjection.request,
          decision: decisionTrace,
          occurred_at: approvedTerminal.occurred_at,
          phase: approvedTerminal,
        }),
      ),
    });
    const decisionTraceDrift = resignEvidence({
      ...approvalEvidence,
      approvals: [
        {
          ...approvalProjection,
          decision: decisionTrace,
          decision_journal_entry: decisionTraceEntry,
        },
      ],
      journal_head: {
        journal_revision: decisionTraceEntry.journal_revision,
        sequence: decisionTraceEntry.sequence,
        entry_hash: decisionTraceEntry.entry_hash,
      },
    });
    expect(parseSkillExecutionEvidence(canonicalJson(decisionTraceDrift))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });

    const decisionEntry = approvalProjection.decision_journal_entry!;
    const decisionCommandMutations: readonly RunJournalEntryV1[] = [
      resignJournalCommand({ ...decisionEntry, command_id: "forged-command" }),
      resignJournal({ ...decisionEntry, command_input_hash: `sha256:${"7".repeat(64)}` }),
      resignJournalCommand({
        ...decisionEntry,
        operation_id: "c0000000-0000-4000-8000-000000000001",
      }),
      resignJournalCommand({ ...decisionEntry, state: "BLOCKED" }),
      forgedReasonEntry,
      resignJournalCommand({
        ...decisionEntry,
        trace: { ...TRACE, span_id: "7".repeat(16) },
      }),
      resignJournalCommand({
        ...decisionEntry,
        metadata: parseJsonBytes(canonicalJson({ kind: "forged-decision-metadata" })),
      }),
      resignJournalCommand({
        ...decisionEntry,
        side_effect: {
          identity: decisionEntry.operation_id!,
          phase: "INTENT",
          input_hash: `sha256:${"6".repeat(64)}`,
          output_hash: null,
        },
      }),
      resignJournal({ ...decisionEntry, timestamp: "2026-08-30T11:59:00.000Z" }),
    ];
    for (const mutatedEntry of decisionCommandMutations) {
      const mutation = resignEvidence({
        ...approvalEvidence,
        run_state: mutatedEntry.state,
        approvals: [
          {
            ...approvalProjection,
            decision_journal_entry: mutatedEntry,
          },
        ],
        journal_head: {
          journal_revision: mutatedEntry.journal_revision,
          sequence: mutatedEntry.sequence,
          entry_hash: mutatedEntry.entry_hash,
        },
      });
      expect(parseSkillExecutionEvidence(canonicalJson(mutation))).toMatchObject({
        ok: false,
        code: "RUNTIME_DOCUMENT_INVALID",
      });
    }
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

    const pendingEntry = approvalProjection.request_journal_entry;
    const pendingCommandMutations: readonly RunJournalEntryV1[] = [
      resignJournalCommand({ ...pendingEntry, command_id: "forged-pending-command" }),
      resignJournal({ ...pendingEntry, command_input_hash: `sha256:${"5".repeat(64)}` }),
      resignJournalCommand({ ...pendingEntry, operation_id: "forged-pending-operation" }),
      resignJournalCommand({ ...pendingEntry, state: "TOOL_PENDING" }),
      resignJournalCommand({ ...pendingEntry, reason_code: "FORGED_PENDING_REASON" }),
      resignJournalCommand({
        ...pendingEntry,
        trace: { ...TRACE, span_id: "5".repeat(16) },
      }),
      resignJournalCommand({
        ...pendingEntry,
        metadata: parseJsonBytes(canonicalJson({ kind: "forged-pending-metadata" })),
      }),
      resignJournalCommand({
        ...pendingEntry,
        side_effect: {
          identity: pendingEntry.operation_id!,
          phase: "INTENT",
          input_hash: `sha256:${"4".repeat(64)}`,
          output_hash: null,
        },
      }),
      resignJournal({ ...pendingEntry, timestamp: "2026-08-30T11:59:00.000Z" }),
    ];
    for (const mutatedEntry of pendingCommandMutations) {
      const mutatedHead = {
        journal_revision: mutatedEntry.journal_revision,
        sequence: mutatedEntry.sequence,
        entry_hash: mutatedEntry.entry_hash,
      };
      const mutatedRequest = resign({
        ...approvalProjection.request,
        pending_journal_head: mutatedHead,
      });
      const mutatedDecision = resign({
        ...approvalProjection.decision!,
        pending_journal_head: mutatedHead,
        approval_request_hash: mutatedRequest.document_hash,
      });
      const mutatedDecisionEntry = resignJournalCommand({
        ...approvalProjection.decision_journal_entry!,
        previous_entry_hash: mutatedEntry.entry_hash,
        metadata: parseJsonBytes(
          canonicalJson({
            kind: "superpowers-approval-decision",
            request: mutatedRequest,
            decision: mutatedDecision,
            occurred_at: approvedTerminal.occurred_at,
            phase: approvedTerminal,
          }),
        ),
      });
      const mutation = resignEvidence({
        ...approvalEvidence,
        approvals: [
          {
            request: mutatedRequest,
            request_journal_entry: mutatedEntry,
            decision: mutatedDecision,
            decision_journal_entry: mutatedDecisionEntry,
          },
        ],
        journal_head: {
          journal_revision: mutatedDecisionEntry.journal_revision,
          sequence: mutatedDecisionEntry.sequence,
          entry_hash: mutatedDecisionEntry.entry_hash,
        },
      });
      expect(parseSkillExecutionEvidence(canonicalJson(mutation))).toMatchObject({
        ok: false,
        code: "RUNTIME_DOCUMENT_INVALID",
      });
    }

    head = (
      await journal.transition({
        ...journalCommand("run-1", "TOOL_PENDING", head),
        command_id: "run-1-tool-after-approved-skill",
      })
    ).head;
    head = (
      await journal.transition({
        ...journalCommand("run-1", "RUNNING", head),
        command_id: "run-1-running-after-approved-skill",
      })
    ).head;
    const laterActivityEvidence = await host.evidence("run-1");
    if (laterActivityEvidence === null) throw new Error("later activity evidence expected");
    expect(laterActivityEvidence).toMatchObject({
      journal_head: head,
      run_state: "RUNNING",
      terminal_journal_entry: null,
    });
    expect(parseSkillExecutionEvidence(canonicalJson(laterActivityEvidence))).toEqual({
      ok: true,
      value: laterActivityEvidence,
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
    expect(
      parseSkillExecutionEvidence(
        canonicalJson(resignEvidence({ ...missingEvidence, terminal_journal_entry: null })),
      ),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });

    const closedJournalRuns = [
      {
        runId: "run-review-journal-path",
        states: ["CREATED", "ROUTED", "RUNNING", "REVIEW_PENDING", "BLOCKED"] as const,
      },
      {
        runId: "run-retry-journal-path",
        states: ["CREATED", "ROUTED", "RUNNING", "FAILED", "RUNNING", "BLOCKED"] as const,
      },
    ];
    const closedJournalEvidence: SkillExecutionEvidenceV1[] = [];
    for (const fixture of closedJournalRuns) {
      let fixtureHead: JournalHead | null = null;
      for (const state of fixture.states) {
        const command = journalCommand(fixture.runId, state, fixtureHead);
        const priorSequence = command.expected_revision;
        fixtureHead = (
          await journal.transition({
            ...command,
            command_id: `${fixture.runId}-${state.toLowerCase()}-${priorSequence}`,
            reason_code: state === "BLOCKED" ? "BLOCKED_SUPERPOWERS_MISSING" : command.reason_code,
          })
        ).head;
      }
      const projected = await host.evidence(fixture.runId);
      if (projected === null) throw new Error("closed journal evidence expected");
      expect(parseSkillExecutionEvidence(canonicalJson(projected))).toEqual({
        ok: true,
        value: projected,
      });
      expect(projected.journal_path.map((entry) => entry.state)).toEqual(fixture.states);
      closedJournalEvidence.push(projected);
    }

    const reviewEvidence = closedJournalEvidence[0]!;
    const impossibleCreatedPredecessor = resignZeroPhaseJournalPath(
      reviewEvidence,
      (entry, index) =>
        index === reviewEvidence.journal_path.length - 1
          ? { ...entry, previous_state: "CREATED" }
          : entry,
    );
    expect(parseSkillExecutionEvidence(canonicalJson(impossibleCreatedPredecessor))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });

    const retryJournalEvidence = closedJournalEvidence[1]!;
    const retryTerminalIndex = retryJournalEvidence.journal_path.length - 1;
    for (const runAttempt of [1, 99]) {
      const impossibleAttempt = resignZeroPhaseJournalPath(retryJournalEvidence, (entry, index) =>
        index === retryTerminalIndex ? { ...entry, run_attempt: runAttempt } : entry,
      );
      expect(parseSkillExecutionEvidence(canonicalJson(impossibleAttempt))).toMatchObject({
        ok: false,
        code: "RUNTIME_DOCUMENT_INVALID",
      });
    }
    const retryOmitted = resignEvidence({
      ...retryJournalEvidence,
      journal_path: retryJournalEvidence.journal_path.filter((_entry, index) => index !== 3),
    });
    const retryFork = resignEvidence({
      ...retryJournalEvidence,
      journal_path: [
        ...retryJournalEvidence.journal_path,
        {
          ...retryJournalEvidence.journal_path[2]!,
          entry_hash: sha256({ kind: "forked-running-entry" }),
        },
      ],
    });
    const retryDuplicate = resignEvidence({
      ...retryJournalEvidence,
      journal_path: [...retryJournalEvidence.journal_path, retryJournalEvidence.journal_path[2]!],
    });
    const retryTerminal = retryJournalEvidence.terminal_journal_entry!;
    const retryOrphan = resignEvidence({
      ...retryJournalEvidence,
      journal_path: [
        ...retryJournalEvidence.journal_path,
        {
          ...journalPathLink(retryTerminal),
          journal_revision: retryTerminal.journal_revision + 1,
          sequence: retryTerminal.sequence + 1,
          previous_entry_hash: retryTerminal.entry_hash,
          entry_hash: sha256({ kind: "orphan-retry-after-terminal" }),
          previous_state: retryTerminal.state,
          state: "RUNNING",
        },
      ],
    });
    for (const impossible of [retryOmitted, retryFork, retryDuplicate, retryOrphan]) {
      expect(parseSkillExecutionEvidence(canonicalJson(impossible))).toMatchObject({
        ok: false,
        code: "RUNTIME_DOCUMENT_INVALID",
      });
    }

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
    mixedHead = (
      await journal.transition(journalCommand("run-mixed-terminal", "TOOL_PENDING", mixedHead))
    ).head;
    mixedHead = (
      await journal.transition({
        ...journalCommand("run-mixed-terminal", "RUNNING", mixedHead),
        command_id: "run-mixed-terminal-running-after-tool",
      })
    ).head;
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
    const mixedJournalEntries = mixedEvidence.journal_path;
    expect(mixedJournalEntries.map((entry) => entry.state)).toEqual([
      "CREATED",
      "ROUTED",
      "RUNNING",
      "TOOL_PENDING",
      "RUNNING",
      "BLOCKED",
    ]);
    expect(parseSkillExecutionEvidence(canonicalJson(mixedEvidence))).toEqual({
      ok: true,
      value: mixedEvidence,
    });
    expect(
      parseSkillExecutionEvidence(
        canonicalJson(
          resignEvidence({
            ...approvalEvidence,
            journal_path: [
              ...approvalEvidence.journal_path,
              journalPathLink(approvalProjection.request_journal_entry),
            ],
          }),
        ),
      ),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
    expect(
      parseSkillExecutionEvidence(
        canonicalJson(resignEvidence({ ...mixedEvidence, terminal_journal_entry: null })),
      ),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });

    let ordinaryHead: JournalHead | null = null;
    for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
      ordinaryHead = (
        await journal.transition(journalCommand("run-ordinary-terminal", state, ordinaryHead))
      ).head;
    }
    if (ordinaryHead === null) throw new Error("ordinary terminal journal fixture failed");
    const ordinarySkill = await selected(host, "test-driven-development");
    const ordinaryStarted = await host.startPhase({
      run_id: "run-ordinary-terminal",
      expected_journal_head: ordinaryHead,
      execution_request_hash: EXECUTION_REQUEST_HASH,
      selection: ordinarySkill.selection,
      phase: "TEST_DESIGN",
      input: Buffer.from("completed before ordinary terminal", "utf8"),
      operation_id: "ordinary-terminal-phase",
      trace: TRACE,
    });
    await host.completePhase({
      run_id: "run-ordinary-terminal",
      expected_phase_revision: ordinaryStarted.phase.phase_revision,
      expected_phase_head_hash: ordinaryStarted.phase.document_hash,
      phase: ordinaryStarted.phase.phase,
      skill_snapshot_hash: ordinaryStarted.phase.skill.snapshot_hash,
      operation_id: ordinaryStarted.phase.operation_id,
      outcome: "COMPLETED",
      terminal_code: null,
      output: Buffer.from("completed output", "utf8"),
      trace: TRACE,
    });
    ordinaryHead = (
      await journal.transition({
        ...journalCommand("run-ordinary-terminal", "BLOCKED", ordinaryHead),
        reason_code: "ORDINARY_POLICY_BLOCK",
      })
    ).head;
    const ordinaryEvidence = await host.evidence("run-ordinary-terminal");
    expect(ordinaryEvidence).toMatchObject({
      journal_head: ordinaryHead,
      run_state: "BLOCKED",
      terminal_journal_entry: null,
      terminal_code: null,
    });
    if (ordinaryEvidence === null) throw new Error("ordinary terminal evidence expected");
    expect(parseSkillExecutionEvidence(canonicalJson(ordinaryEvidence))).toEqual({
      ok: true,
      value: ordinaryEvidence,
    });

    const { document_hash: evidenceDocumentHash, ...evidenceHashable } = evidence;
    expect(hashSkillExecutionEvidence(evidence)).toBe(evidenceDocumentHash);
    expect(evidenceDocumentHash).toBe(sha256(evidenceHashable));
    const forgedTerminalEntry = resignJournal({
      ...mixedEvidence.terminal_journal_entry!,
      previous_state: "COMPLETED",
    });
    expect(
      parseSkillExecutionEvidence(
        canonicalJson(
          resignEvidence({
            ...mixedEvidence,
            journal_head: {
              journal_revision: forgedTerminalEntry.journal_revision,
              sequence: forgedTerminalEntry.sequence,
              entry_hash: forgedTerminalEntry.entry_hash,
            },
            terminal_journal_entry: forgedTerminalEntry,
          }),
        ),
      ),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });

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
  }, 30_000);

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
