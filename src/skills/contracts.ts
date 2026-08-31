import {
  canonicalJson,
  parseJsonBytes,
  sha256,
  type JsonLimits,
  type JsonValue,
} from "../protocol/json.js";
import type {
  RuntimeDocument,
  ValidationFailure,
  ValidationIssue,
  ValidationResult,
} from "../protocol/types.js";
import { createProtocolValidator } from "../protocol/validator.js";
import type {
  HashableSkillDescriptorV1,
  HashableSkillExecutionEvidenceV1,
  HashableSkillSnapshotV1,
  HashableSuperpowersApprovalV1,
  HashableSuperpowersPhaseV1,
  SkillDescriptorReference,
  SkillDescriptorV1,
  SkillExecutionEvidenceV1,
  SkillSnapshotV1,
  SuperpowersApprovalV1,
  SuperpowersPhaseName,
  SuperpowersPhaseV1,
} from "./types.js";
import { SKILL_LIMITS } from "./types.js";
import { builtInSuperpowersHandler, requiredBuiltInPhasePredecessors } from "./phases.js";

const VALIDATOR = createProtocolValidator();

const DOCUMENT_LIMITS: JsonLimits = Object.freeze({
  maxBytes: SKILL_LIMITS.storedObjectBytes,
  maxDepth: SKILL_LIMITS.nestingDepth,
  maxMembers: 10_000,
});

type JsonRecord = { readonly [key: string]: JsonValue };

function isRecord(value: JsonValue): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(path: string, keyword: string, message: string): ValidationIssue {
  return { path, keyword, message };
}

function failure(issues: readonly ValidationIssue[]): ValidationFailure {
  return {
    ok: false,
    code: "RUNTIME_DOCUMENT_INVALID",
    issues: [...issues].sort((left, right) =>
      `${left.path}\u0000${left.keyword}\u0000${left.message}`.localeCompare(
        `${right.path}\u0000${right.keyword}\u0000${right.message}`,
      ),
    ),
  };
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function orderedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || bytewiseCompare(values[index - 1] as string, value) < 0,
  );
}

function hashable<T extends { readonly document_hash: `sha256:${string}` }>(
  value: T,
): Omit<T, "document_hash"> {
  const normalized = parseJsonBytes(canonicalJson(value, DOCUMENT_LIMITS), DOCUMENT_LIMITS);
  if (!isRecord(normalized)) throw new TypeError("skill document must be an object");
  const result = { ...normalized };
  delete result.document_hash;
  return result as Omit<T, "document_hash">;
}

function documentHash<T extends { readonly document_hash: `sha256:${string}` }>(
  value: T,
): `sha256:${string}` {
  return sha256(hashable(value), DOCUMENT_LIMITS);
}

function hashMatches<T extends { readonly document_hash: `sha256:${string}` }>(value: T): boolean {
  try {
    return value.document_hash === documentHash(value);
  } catch {
    return false;
  }
}

export function hashSkillDescriptor(value: SkillDescriptorV1): `sha256:${string}` {
  return documentHash(value);
}

export function hashSkillSnapshot(value: SkillSnapshotV1): `sha256:${string}` {
  return documentHash(value);
}

export function hashSuperpowersPhase(value: SuperpowersPhaseV1): `sha256:${string}` {
  return documentHash(value);
}

export function hashSuperpowersApproval(value: SuperpowersApprovalV1): `sha256:${string}` {
  return documentHash(value);
}

export function hashSkillExecutionEvidence(value: SkillExecutionEvidenceV1): `sha256:${string}` {
  return documentHash(value);
}

export function hashSkillExecutionHandoff(
  value: Omit<SkillExecutionEvidenceV1, "handoff_hash" | "document_hash">,
): `sha256:${string}` {
  return sha256({ schema_version: "skill-execution-handoff.v1", evidence: value }, DOCUMENT_LIMITS);
}

export function hashSkillPackage(
  value: Pick<
    SkillSnapshotV1,
    "descriptor" | "skill_markdown_hash" | "skill_markdown_bytes" | "resources"
  >,
): `sha256:${string}` {
  return sha256(
    {
      name: value.descriptor.name,
      description: value.descriptor.description,
      version: value.descriptor.version,
      required_runtime_capabilities: value.descriptor.required_runtime_capabilities,
      skill_markdown_bytes: value.skill_markdown_bytes,
      skill_markdown_hash: value.skill_markdown_hash,
      resources: value.resources.map((resource) => ({
        path: resource.path,
        role: resource.role,
        phases: resource.phases,
        priority: resource.priority,
        media_type: resource.media_type,
        bytes: resource.bytes,
        hash: resource.hash,
      })),
    },
    DOCUMENT_LIMITS,
  );
}

export function hashSkillCatalog(value: readonly SkillDescriptorReference[]): `sha256:${string}` {
  return sha256(value, DOCUMENT_LIMITS);
}

function parseDocument<T extends RuntimeDocument>(
  input: string | Uint8Array,
  documentType: T["document_type"],
  limits: JsonLimits,
  semanticValidator: (value: T) => readonly ValidationIssue[],
): ValidationResult<T> {
  const parsed = VALIDATOR.parse<T>(input, documentType, limits);
  if (!parsed.ok) return parsed;
  const issues = semanticValidator(parsed.value);
  return issues.length === 0 ? { ok: true, value: parsed.value } : failure(issues);
}

function descriptorIssues(value: SkillDescriptorV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!orderedUnique(value.required_runtime_capabilities)) {
    issues.push(
      issue(
        "/required_runtime_capabilities",
        "order",
        "capabilities must be ASCII-sorted and unique",
      ),
    );
  }
  if (!hashMatches(value))
    issues.push(
      issue("/document_hash", "canonicalHash", "document hash does not match canonical content"),
    );
  return issues;
}

function resourcePaths(resources: SkillSnapshotV1["resources"]): readonly string[] {
  return resources.map((resource) => resource.path);
}

const SUPERPOWERS_PHASES = new Set<SuperpowersPhaseName>([
  "BRAINSTORMING",
  "DEBUGGING",
  "GREEN",
  "RED",
  "REVIEW",
  "TEST_DESIGN",
  "VERIFICATION",
]);

function resourcePolicyIssues(value: SkillSnapshotV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [index, resource] of value.resources.entries()) {
    const path = `/resources/${index}`;
    if (!resource.phases.every((phase) => SUPERPOWERS_PHASES.has(phase))) {
      issues.push(issue(`${path}/phases`, "phase", "resource phases must be recognized"));
    }
    if (!orderedUnique(resource.phases)) {
      issues.push(
        issue(`${path}/phases`, "order", "resource phases must be UTF-8-byte sorted and unique"),
      );
    }
    if (resource.role === "reference") {
      if (resource.phases.length === 0) {
        issues.push(issue(`${path}/phases`, "required", "reference phases must be non-empty"));
      }
      if (
        resource.priority !== null &&
        (!Number.isSafeInteger(resource.priority) ||
          resource.priority < 0 ||
          resource.priority > 255)
      ) {
        issues.push(
          issue(
            `${path}/priority`,
            "range",
            "reference priority must be null or an integer from 0 through 255",
          ),
        );
      }
    } else if (resource.phases.length !== 0 || resource.priority !== null) {
      issues.push(
        issue(path, "policy", "assets and scripts must have empty phases and null priority"),
      );
    }
  }
  return issues;
}

function snapshotIssues(value: SkillSnapshotV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  issues.push(...resourcePolicyIssues(value));
  const descriptor = parseSkillDescriptor(canonicalJson(value.descriptor, DOCUMENT_LIMITS));
  if (!descriptor.ok) issues.push(issue("/descriptor", "semantic", "descriptor is invalid"));
  if (!orderedUnique(resourcePaths(value.resources))) {
    issues.push(issue("/resources", "order", "resources must be ASCII-sorted and unique by path"));
  }
  const resourceBytes = value.resources.reduce((total, resource) => total + resource.bytes, 0);
  const expectedTotal = value.skill_markdown_bytes + resourceBytes;
  if (value.descriptor.resource_count !== value.resources.length) {
    issues.push(
      issue("/descriptor/resource_count", "accounting", "resource count does not match resources"),
    );
  }
  if (value.descriptor.total_bytes !== expectedTotal || value.total_bytes !== expectedTotal) {
    issues.push(issue("/total_bytes", "accounting", "total bytes do not match package members"));
  }
  const packageHash = hashSkillPackage(value);
  if (value.package_hash !== packageHash || value.descriptor.package_hash !== packageHash) {
    issues.push(
      issue(
        "/package_hash",
        "packageHash",
        "package hash does not match intrinsic package content",
      ),
    );
  }
  if (!hashMatches(value))
    issues.push(
      issue("/document_hash", "canonicalHash", "document hash does not match canonical content"),
    );
  return issues;
}

function phaseIssues(value: SuperpowersPhaseV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (
    (value.status === "COMPLETED" || value.status === "APPROVAL_PENDING") !==
    (value.output_hash !== null)
  ) {
    issues.push(
      issue(
        "/output_hash",
        "status",
        "completed and approval-pending phases require output and other phases do not",
      ),
    );
  }
  const requiresTerminalCode = value.status === "FAILED" || value.status === "BLOCKED";
  if (requiresTerminalCode !== (value.terminal_code !== null)) {
    issues.push(
      issue("/terminal_code", "status", "failed and blocked phases require an exact terminal code"),
    );
  }
  const accounting = value.context_accounting;
  if (
    accounting.included_utf8_bytes > accounting.original_utf8_bytes ||
    accounting.included_conservative_units > accounting.original_conservative_units ||
    accounting.segment_count < accounting.included_resource_hashes.length ||
    new Set([...accounting.included_resource_hashes, ...accounting.omitted_resource_hashes])
      .size !==
      accounting.included_resource_hashes.length + accounting.omitted_resource_hashes.length
  ) {
    issues.push(issue("/context_accounting", "accounting", "context accounting is inconsistent"));
  }
  if (!hashMatches(value))
    issues.push(
      issue("/document_hash", "canonicalHash", "document hash does not match canonical content"),
    );
  return issues;
}

function approvalIssues(value: SuperpowersApprovalV1): readonly ValidationIssue[] {
  return hashMatches(value)
    ? []
    : [issue("/document_hash", "canonicalHash", "document hash does not match canonical content")];
}

function exactJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameEvidencePhaseBinding(left: SuperpowersPhaseV1, right: SuperpowersPhaseV1): boolean {
  return (
    left.run_id === right.run_id &&
    left.execution_request_hash === right.execution_request_hash &&
    exactJson(left.observed_journal_head, right.observed_journal_head) &&
    left.catalog_hash === right.catalog_hash &&
    exactJson(left.skill, right.skill) &&
    left.phase === right.phase &&
    exactJson(left.handler, right.handler) &&
    exactJson(left.predecessor_phase_hashes, right.predecessor_phase_hashes) &&
    left.operation_id === right.operation_id &&
    left.input_hash === right.input_hash &&
    left.context_hash === right.context_hash &&
    exactJson(left.context_accounting, right.context_accounting)
  );
}

function evidenceIssues(value: SkillExecutionEvidenceV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const snapshotHashes = value.snapshots.map((snapshot) => snapshot.document_hash);
  if (!orderedUnique(snapshotHashes)) {
    issues.push(issue("/snapshots", "order", "snapshots must be hash-sorted and unique"));
  }
  const snapshots = new Map(value.snapshots.map((snapshot) => [snapshot.document_hash, snapshot]));
  for (const [index, snapshot] of value.snapshots.entries()) {
    if (!parseSkillSnapshot(canonicalJson(snapshot)).ok) {
      issues.push(issue(`/snapshots/${index}`, "innerDocument", "snapshot is not self-verifying"));
    }
  }

  let unmatched: SuperpowersPhaseV1 | null = null;
  let executionRequestHash: `sha256:${string}` | null = null;
  const seenOperations = new Set<string>();
  const requestedPhases: SuperpowersPhaseName[] = [];
  const latestAttempts = new Map<
    SuperpowersPhaseName,
    { readonly started: SuperpowersPhaseV1; terminal: SuperpowersPhaseV1 | null }
  >();
  for (const [index, phase] of value.phases.entries()) {
    const previous = value.phases[index - 1];
    const snapshot = snapshots.get(phase.skill.snapshot_hash);
    const reference =
      snapshot === undefined
        ? null
        : {
            name: snapshot.descriptor.name,
            version: snapshot.descriptor.version,
            source: snapshot.descriptor.source,
            package_hash: snapshot.descriptor.package_hash,
            document_hash: snapshot.descriptor.document_hash,
          };
    if (!parseSuperpowersPhase(canonicalJson(phase)).ok) {
      issues.push(issue(`/phases/${index}`, "innerDocument", "phase is not self-verifying"));
    }
    const handler = builtInSuperpowersHandler(phase.phase);
    if (
      phase.run_id !== value.run_id ||
      phase.phase_revision !== index + 1 ||
      phase.previous_phase_hash !== (previous?.document_hash ?? `sha256:${"0".repeat(64)}`) ||
      phase.observed_journal_head.sequence > value.journal_head.sequence ||
      phase.skill.name !== handler.capability ||
      phase.handler.version !== handler.version ||
      phase.handler.hash !== handler.hash ||
      reference === null ||
      canonicalJson(reference) !==
        canonicalJson({
          name: phase.skill.name,
          version: phase.skill.version,
          source: phase.skill.source,
          package_hash: phase.skill.package_hash,
          document_hash: phase.skill.document_hash,
        })
    ) {
      issues.push(issue(`/phases/${index}`, "binding", "phase history binding is inconsistent"));
    }
    if (executionRequestHash === null) executionRequestHash = phase.execution_request_hash;
    else if (executionRequestHash !== phase.execution_request_hash) {
      issues.push(
        issue(`/phases/${index}/execution_request_hash`, "binding", "execution request changed"),
      );
    }
    if (phase.status === "STARTED") {
      const expectedPredecessors: `sha256:${string}`[] = [];
      for (const predecessor of requiredBuiltInPhasePredecessors(phase.phase, requestedPhases)) {
        const attempt = latestAttempts.get(predecessor);
        const terminal = attempt?.terminal;
        const exactSkill =
          (phase.phase === "RED" && predecessor === "TEST_DESIGN") ||
          (phase.phase === "GREEN" && predecessor === "RED");
        if (
          attempt === undefined ||
          terminal?.status !== "COMPLETED" ||
          (exactSkill && !exactJson(terminal.skill, phase.skill))
        ) {
          issues.push(
            issue(
              `/phases/${index}/predecessor_phase_hashes`,
              "binding",
              "phase predecessors are not satisfied",
            ),
          );
        } else {
          expectedPredecessors.push(terminal.document_hash);
        }
      }
      if (
        unmatched !== null ||
        seenOperations.has(phase.operation_id) ||
        !exactJson(phase.predecessor_phase_hashes, expectedPredecessors)
      ) {
        issues.push(issue(`/phases/${index}`, "attempt", "phase attempt start is inconsistent"));
      }
      seenOperations.add(phase.operation_id);
      unmatched = phase;
      requestedPhases.push(phase.phase);
      latestAttempts.set(phase.phase, { started: phase, terminal: null });
    } else if (phase.status === "APPROVAL_PENDING") {
      if (
        unmatched === null ||
        unmatched.phase !== "BRAINSTORMING" ||
        !sameEvidencePhaseBinding(unmatched, phase)
      ) {
        issues.push(issue(`/phases/${index}`, "attempt", "pending attempt is inconsistent"));
      }
    } else {
      if (unmatched === null || !sameEvidencePhaseBinding(unmatched, phase)) {
        issues.push(issue(`/phases/${index}`, "attempt", "terminal attempt is inconsistent"));
      }
      const attempt = latestAttempts.get(phase.phase);
      if (attempt === undefined || attempt.terminal !== null) {
        issues.push(issue(`/phases/${index}`, "attempt", "terminal attempt is not unique"));
      } else {
        attempt.terminal = phase;
      }
      unmatched = null;
    }
  }

  const requests = new Set<string>();
  const decisions = new Set<string>();
  for (const [index, approval] of value.approvals.entries()) {
    const requestResult = parseSuperpowersApproval(canonicalJson(approval.request));
    const decisionResult =
      approval.decision === null
        ? null
        : parseSuperpowersApproval(canonicalJson(approval.decision));
    const phase = value.phases.find(
      (candidate) => candidate.document_hash === approval.request.phase_document_hash,
    );
    if (
      !requestResult.ok ||
      approval.request.kind !== "REQUEST" ||
      phase === undefined ||
      phase.status !== "APPROVAL_PENDING" ||
      approval.request.run_id !== value.run_id ||
      approval.request.phase !== phase.phase ||
      approval.request.skill_name !== phase.skill.name ||
      approval.request.skill_version !== phase.skill.version ||
      approval.request.skill_snapshot_hash !== phase.skill.snapshot_hash ||
      approval.request.phase_operation_id !== phase.operation_id ||
      requests.has(approval.request.document_hash)
    ) {
      issues.push(
        issue(`/approvals/${index}/request`, "binding", "approval request is inconsistent"),
      );
    }
    requests.add(approval.request.document_hash);
    if (approval.decision === null) {
      if (approval.decision_journal_head !== null) {
        issues.push(
          issue(`/approvals/${index}`, "decisionHead", "missing decision has no journal head"),
        );
      }
    } else {
      const terminal = value.phases.find(
        (candidate) => candidate.previous_phase_hash === phase?.document_hash,
      );
      const expectedStatus = approval.decision.decision === "APPROVE" ? "COMPLETED" : "BLOCKED";
      const expectedCode =
        approval.decision.decision === "APPROVE" ? null : "RUNTIME_SKILL_APPROVAL_REJECTED";
      if (
        decisionResult === null ||
        !decisionResult.ok ||
        approval.decision.kind !== "DECISION" ||
        approval.decision.approval_request_hash !== approval.request.document_hash ||
        approval.decision.run_id !== approval.request.run_id ||
        !exactJson(approval.decision.pending_journal_head, approval.request.pending_journal_head) ||
        approval.decision.phase_document_hash !== approval.request.phase_document_hash ||
        approval.decision.phase !== approval.request.phase ||
        approval.decision.skill_name !== approval.request.skill_name ||
        approval.decision.skill_version !== approval.request.skill_version ||
        approval.decision.skill_snapshot_hash !== approval.request.skill_snapshot_hash ||
        approval.decision.phase_operation_id !== approval.request.phase_operation_id ||
        terminal?.status !== expectedStatus ||
        terminal.terminal_code !== expectedCode ||
        approval.decision_journal_head === null ||
        approval.decision_journal_head.sequence <= approval.request.pending_journal_head.sequence ||
        decisions.has(approval.decision.document_hash)
      ) {
        issues.push(
          issue(`/approvals/${index}/decision`, "binding", "approval decision is inconsistent"),
        );
      }
      decisions.add(approval.decision.document_hash);
    }
  }
  if (
    value.approvals.some(
      (approval, index) =>
        index > 0 &&
        value.approvals[index - 1]!.request.pending_journal_head.sequence >=
          approval.request.pending_journal_head.sequence,
    ) ||
    value.approvals.some(
      (approval) =>
        (approval.decision_journal_head ?? approval.request.pending_journal_head).sequence >
        value.journal_head.sequence,
    )
  ) {
    issues.push(issue("/approvals", "order", "approval journal heads are not ordered"));
  }

  const latest = value.phases.at(-1);
  const expectedTerminal = latest?.terminal_code ?? null;
  if (
    (latest === undefined &&
      (value.terminal_code === null ||
        (value.run_state !== "FAILED" && value.run_state !== "BLOCKED"))) ||
    (latest !== undefined && value.terminal_code !== expectedTerminal)
  ) {
    issues.push(issue("/terminal_code", "state", "terminal code does not match current execution"));
  }
  if (!hashMatches(value))
    issues.push(
      issue("/document_hash", "canonicalHash", "document hash does not match canonical content"),
    );
  const { handoff_hash: handoffHash, document_hash: documentHashValue, ...handoffInput } = value;
  void documentHashValue;
  if (handoffHash !== hashSkillExecutionHandoff(handoffInput)) {
    issues.push(issue("/handoff_hash", "handoffHash", "handoff hash does not match evidence"));
  }
  return issues;
}

export function parseSkillDescriptor(
  input: string | Uint8Array,
): ValidationResult<SkillDescriptorV1> {
  return parseDocument(
    input,
    "skill-descriptor",
    { ...DOCUMENT_LIMITS, maxBytes: SKILL_LIMITS.descriptorBytes },
    descriptorIssues,
  );
}

export function parseSkillSnapshot(input: string | Uint8Array): ValidationResult<SkillSnapshotV1> {
  return parseDocument(input, "skill-snapshot", DOCUMENT_LIMITS, snapshotIssues);
}

export function parseSuperpowersPhase(
  input: string | Uint8Array,
): ValidationResult<SuperpowersPhaseV1> {
  return parseDocument(
    input,
    "superpowers-phase",
    { ...DOCUMENT_LIMITS, maxBytes: SKILL_LIMITS.phaseOutputBytes },
    phaseIssues,
  );
}

export function parseSuperpowersApproval(
  input: string | Uint8Array,
): ValidationResult<SuperpowersApprovalV1> {
  return parseDocument(input, "superpowers-approval", DOCUMENT_LIMITS, approvalIssues);
}

export function parseSkillExecutionEvidence(
  input: string | Uint8Array,
): ValidationResult<SkillExecutionEvidenceV1> {
  return parseDocument(
    input,
    "skill-execution-evidence",
    { ...DOCUMENT_LIMITS, maxBytes: SKILL_LIMITS.evidenceBytes },
    evidenceIssues,
  );
}

export type {
  HashableSkillDescriptorV1,
  HashableSkillExecutionEvidenceV1,
  HashableSkillSnapshotV1,
  HashableSuperpowersApprovalV1,
  HashableSuperpowersPhaseV1,
};
