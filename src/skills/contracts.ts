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
  SuperpowersPhaseV1,
} from "./types.js";
import { SKILL_LIMITS } from "./types.js";

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

function snapshotIssues(value: SkillSnapshotV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
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
  if ((value.status === "COMPLETED") !== (value.output_hash !== null)) {
    issues.push(
      issue(
        "/output_hash",
        "status",
        "completed phases require output and incomplete phases do not",
      ),
    );
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

function evidenceIssues(value: SkillExecutionEvidenceV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stringSets: readonly [string, readonly string[]][] = [
    ["/resource_hashes", value.resource_hashes],
    ["/context_hashes", value.context_hashes],
    ["/phases", value.phases.map((phase) => phase.phase_hash)],
    ["/approvals", value.approvals.map((approval) => approval.request_hash)],
  ];
  for (const [path, values] of stringSets) {
    if (!orderedUnique(values))
      issues.push(issue(path, "order", "members must be ASCII-sorted and unique"));
  }
  const decisions = value.approvals.flatMap((approval) =>
    approval.decision_hash === null ? [] : [approval.decision_hash],
  );
  if (new Set(decisions).size !== decisions.length) {
    issues.push(issue("/approvals", "uniqueDecision", "approval decision hashes must be unique"));
  }
  if (!hashMatches(value))
    issues.push(
      issue("/document_hash", "canonicalHash", "document hash does not match canonical content"),
    );
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
