import { sha256 } from "../../src/protocol/json.js";
import { hashSkillCatalog } from "../../src/skills/contracts.js";
import { builtInSuperpowersHandler } from "../../src/skills/phases.js";

const HASH = `sha256:${"a".repeat(64)}` as const;
const OTHER_HASH = `sha256:${"b".repeat(64)}` as const;
const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;

function document<T extends Record<string, unknown>>(
  value: T,
): T & { document_hash: `sha256:${string}` } {
  const hashable = { ...value };
  delete hashable.document_hash;
  return { ...hashable, document_hash: sha256(hashable) };
}

function packageHash(input: {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly required_runtime_capabilities: readonly string[];
  readonly skill_markdown_bytes: number;
  readonly skill_markdown_hash: `sha256:${string}`;
  readonly resources: readonly {
    readonly path: string;
    readonly role: string;
    readonly phases: readonly string[];
    readonly priority: number | null;
    readonly media_type: string;
    readonly bytes: number;
    readonly hash: `sha256:${string}`;
  }[];
}): `sha256:${string}` {
  return sha256({
    name: input.name,
    description: input.description,
    version: input.version,
    required_runtime_capabilities: input.required_runtime_capabilities,
    skill_markdown_bytes: input.skill_markdown_bytes,
    skill_markdown_hash: input.skill_markdown_hash,
    resources: input.resources,
  });
}

export function validSkillDescriptor() {
  return document({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "skill-descriptor.v1" as const,
    document_type: "skill-descriptor" as const,
    name: "test-driven-development",
    description: "Guides a disciplined development workflow.",
    version: "1.0.0",
    source: { kind: "bundled" as const, identity: "test-driven-development" },
    package_hash: HASH,
    resource_count: 1,
    total_bytes: 13,
    required_runtime_capabilities: ["filesystem", "shell"],
  });
}

export function validSkillSnapshot() {
  const descriptor = validSkillDescriptor();
  const resources = [
    {
      path: "references/guide.md",
      role: "reference" as const,
      phases: ["GREEN"] as const,
      priority: null,
      media_type: "text/markdown",
      bytes: 5,
      hash: OTHER_HASH,
    },
  ];
  const skill_markdown_bytes = 8;
  const skill_markdown_hash = HASH;
  const package_hash = packageHash({
    ...descriptor,
    skill_markdown_bytes,
    skill_markdown_hash,
    resources,
  });
  const descriptorWithPackageHash = document({ ...descriptor, package_hash });
  return document({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "skill-snapshot.v1" as const,
    document_type: "skill-snapshot" as const,
    descriptor: descriptorWithPackageHash,
    skill_markdown_hash,
    skill_markdown_bytes,
    resources,
    package_hash,
    total_bytes: 13,
  });
}

const TRACE = { trace_id: "1".repeat(32), span_id: "2".repeat(16), trace_flags: 1 } as const;
const JOURNAL_HEAD = { journal_revision: 1, sequence: 1, entry_hash: ZERO_HASH } as const;

export function validSuperpowersPhase() {
  const snapshot = validSkillSnapshot();
  const descriptor = snapshot.descriptor;
  const handler = builtInSuperpowersHandler("TEST_DESIGN");
  return document({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "superpowers-phase.v1" as const,
    document_type: "superpowers-phase" as const,
    run_id: "run-1",
    phase_revision: 1,
    previous_phase_hash: ZERO_HASH,
    execution_request_hash: HASH,
    observed_journal_head: JOURNAL_HEAD,
    catalog_hash: ZERO_HASH,
    skill: {
      name: descriptor.name,
      version: descriptor.version,
      source: descriptor.source,
      package_hash: descriptor.package_hash,
      document_hash: descriptor.document_hash,
      snapshot_hash: snapshot.document_hash,
    },
    phase: "TEST_DESIGN" as const,
    handler: { version: handler.version, hash: handler.hash },
    operation_id: "operation-1",
    status: "COMPLETED" as const,
    predecessor_phase_hashes: [],
    input_hash: OTHER_HASH,
    context_hash: ZERO_HASH,
    context_accounting: {
      skill_markdown: {
        path: "SKILL.md" as const,
        source_hash: HASH,
        state: "INCLUDED" as const,
        original_bytes: 8,
        included_bytes: 8,
        included_hash: HASH,
        original_conservative_units: 2,
        included_conservative_units: 2,
      },
      resources: [
        {
          path: "references/guide.md",
          source_hash: OTHER_HASH,
          state: "OMITTED" as const,
          original_bytes: 5,
          included_bytes: 0,
          included_hash: null,
          original_conservative_units: 2,
          included_conservative_units: 0,
        },
      ],
      original_utf8_bytes: 13,
      included_utf8_bytes: 8,
      original_conservative_units: 4,
      included_conservative_units: 2,
      remaining_bytes: 10,
      remaining_conservative_units: 2,
      segment_count: 1,
      truncation_count: 0,
    },
    output_hash: HASH,
    terminal_code: null,
    occurred_at: "2026-08-30T12:00:00.000Z",
    trace: TRACE,
  });
}

export function validSuperpowersApproval() {
  return document({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "superpowers-approval.v1" as const,
    document_type: "superpowers-approval" as const,
    kind: "REQUEST" as const,
    run_id: "run-1",
    pending_journal_head: JOURNAL_HEAD,
    phase_document_hash: HASH,
    phase: "GREEN" as const,
    skill_name: "superpowers",
    skill_version: "1.0.0",
    skill_snapshot_hash: OTHER_HASH,
    phase_operation_id: "operation-1",
    decision: null,
    trace: TRACE,
  });
}

export function validSuperpowersApprovalDecision() {
  return document({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "superpowers-approval.v1" as const,
    document_type: "superpowers-approval" as const,
    kind: "DECISION" as const,
    run_id: "run-1",
    pending_journal_head: JOURNAL_HEAD,
    phase_document_hash: HASH,
    phase: "GREEN" as const,
    skill_name: "superpowers",
    skill_version: "1.0.0",
    skill_snapshot_hash: OTHER_HASH,
    phase_operation_id: "operation-1",
    approval_request_hash: ZERO_HASH,
    operation_id: "decision-1",
    decision: "APPROVE" as const,
    trace: TRACE,
  });
}

export function validSkillExecutionEvidence() {
  const snapshot = validSkillSnapshot();
  const catalogs = [
    {
      descriptors: [snapshot.descriptor],
      catalog_hash: hashSkillCatalog([
        {
          name: snapshot.descriptor.name,
          version: snapshot.descriptor.version,
          source: snapshot.descriptor.source,
          package_hash: snapshot.descriptor.package_hash,
          document_hash: snapshot.descriptor.document_hash,
        },
      ]),
    },
  ];
  const terminal = validSuperpowersPhase();
  const started = document({
    ...terminal,
    catalog_hash: catalogs[0]!.catalog_hash,
    status: "STARTED" as const,
    output_hash: null,
  });
  const completed = document({
    ...started,
    phase_revision: 2,
    previous_phase_hash: started.document_hash,
    status: "COMPLETED" as const,
    output_hash: terminal.output_hash,
  });
  const hashable = {
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "skill-execution-evidence.v1" as const,
    document_type: "skill-execution-evidence" as const,
    run_id: "run-1",
    journal_head: JOURNAL_HEAD,
    run_state: "RUNNING" as const,
    terminal_journal_entry: null,
    catalogs,
    snapshots: [snapshot],
    phases: [started, completed],
    approvals: [],
    terminal_code: null,
  };
  return document({
    ...hashable,
    handoff_hash: sha256({ schema_version: "skill-execution-handoff.v1", evidence: hashable }),
  });
}
