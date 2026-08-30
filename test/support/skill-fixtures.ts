import { sha256 } from "../../src/protocol/json.js";

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
    name: "superpowers",
    description: "Guides a disciplined development workflow.",
    version: "1.0.0",
    source: { kind: "bundled" as const, identity: "superpowers" },
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
  return document({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "superpowers-phase.v1" as const,
    document_type: "superpowers-phase" as const,
    run_id: "run-1",
    phase_revision: 1,
    previous_phase_hash: ZERO_HASH,
    execution_request_hash: HASH,
    observed_journal_head: JOURNAL_HEAD,
    skill: { name: "superpowers", version: "1.0.0", snapshot_hash: OTHER_HASH },
    phase: "GREEN" as const,
    handler: { version: "1.0.0", hash: HASH },
    operation_id: "operation-1",
    status: "COMPLETED" as const,
    input_hash: OTHER_HASH,
    output_hash: HASH,
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
  return document({
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "skill-execution-evidence.v1" as const,
    document_type: "skill-execution-evidence" as const,
    run_id: "run-1",
    catalog_hash: HASH,
    skill: {
      name: "superpowers",
      version: "1.0.0",
      source: { kind: "bundled" as const, identity: "superpowers" },
      package_hash: HASH,
      document_hash: OTHER_HASH,
      snapshot_hash: ZERO_HASH,
    },
    resource_hashes: [HASH, OTHER_HASH],
    phases: [
      {
        phase: "GREEN" as const,
        handler_hash: HASH,
        phase_hash: OTHER_HASH,
        input_hash: HASH,
        output_hash: OTHER_HASH,
      },
    ],
    approvals: [{ request_hash: HASH, decision_hash: null, journal_head: JOURNAL_HEAD }],
    context_hashes: [OTHER_HASH],
    handoff_hash: ZERO_HASH,
    terminal_code: null,
  });
}
