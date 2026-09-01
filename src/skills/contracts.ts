import { createHash } from "node:crypto";

import { createScanner } from "jsonc-parser";

import { parseRunJournalEntry, ZERO_JOURNAL_HASH } from "../journal/entry.js";
import { RUN_TRANSITION_MATRIX } from "../journal/state-machine.js";
import type { RunJournalEntryV1, RunState } from "../journal/types.js";
import {
  canonicalJson,
  parseJsonBytes,
  sha256,
  type JsonLimits,
  type JsonValue,
} from "../protocol/json.js";
import type {
  RuntimeDocument,
  TraceContext,
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
  SkillJournalPathLinkV1,
  SkillSnapshotV1,
  SuperpowersApprovalDecisionV1,
  SuperpowersApprovalRequestV1,
  SuperpowersApprovalV1,
  SuperpowersPhaseName,
  SuperpowersPhaseV1,
} from "./types.js";
import { SKILL_LIMITS } from "./types.js";
import { builtInSuperpowersHandler, requiredBuiltInPhasePredecessors } from "./phases.js";
import { isRuntimeSkillErrorCode, RuntimeSkillError } from "./errors.js";
import { assertSkillRelativePath } from "./paths.js";

const VALIDATOR = createProtocolValidator();

const DOCUMENT_LIMITS: JsonLimits = Object.freeze({
  maxBytes: SKILL_LIMITS.storedObjectBytes,
  maxDepth: SKILL_LIMITS.nestingDepth,
  maxMembers: 10_000,
});

const EVIDENCE_CLOSED_MEMBER_MIN_BYTES = 18;
const EVIDENCE_TERMINAL_DOCUMENT_MAX_MEMBERS = 10_000;
const EVIDENCE_FIXED_MEMBER_ALLOWANCE = 4_096;
const EVIDENCE_SCHEMA_MEMBER_UPPER_BOUND =
  Math.floor(SKILL_LIMITS.evidenceBytes / EVIDENCE_CLOSED_MEMBER_MIN_BYTES) +
  EVIDENCE_TERMINAL_DOCUMENT_MAX_MEMBERS +
  EVIDENCE_FIXED_MEMBER_ALLOWANCE;
const EVIDENCE_MEMBER_CEILING = 131_072;

if (EVIDENCE_SCHEMA_MEMBER_UPPER_BOUND >= EVIDENCE_MEMBER_CEILING) {
  throw new Error("skill evidence member ceiling is below the closed schema bound");
}

export const SKILL_EVIDENCE_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: SKILL_LIMITS.evidenceBytes,
  maxDepth: SKILL_LIMITS.nestingDepth + 8,
  // After ordinary journal metadata is replaced by eight-field path links,
  // every repeatable closed evidence unit uses at least 18 canonical bytes per
  // counted member. The sole arbitrary safe_json authority is the dedicated
  // terminal journal document, whose own parser admits at most 10,000 members;
  // 4,096 more cover every non-repeatable root/container member.
  // floor(2 MiB / 18) + 10,000 + 4,096 = 130,604, so the next power-of-two
  // ceiling is conservative for every byte-valid shape. The ceiling is exclusive.
  maxMembers: EVIDENCE_MEMBER_CEILING,
});

type EvidenceContainer =
  | { readonly kind: "array"; state: "valueOrEnd" | "commaOrEnd" }
  | { readonly kind: "object"; state: "keyOrEnd" | "colon" | "value" | "commaOrEnd" };

const EVIDENCE_TOKEN = Object.freeze({
  OPEN_BRACE: 1,
  CLOSE_BRACE: 2,
  OPEN_BRACKET: 3,
  CLOSE_BRACKET: 4,
  COMMA: 5,
  COLON: 6,
  NULL: 7,
  TRUE: 8,
  FALSE: 9,
  STRING: 10,
  NUMBER: 11,
  LINE_COMMENT: 12,
  BLOCK_COMMENT: 13,
  LINE_BREAK: 14,
  TRIVIA: 15,
  EOF: 17,
});

function evidenceInputText(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (bytes > SKILL_EVIDENCE_JSON_LIMITS.maxBytes) throw new Error("byte limit");
  if (typeof input === "string") return input;
  return new TextDecoder("utf-8", { fatal: true }).decode(input);
}

function preflightEvidenceStructure(input: string | Uint8Array): void {
  const scanner = createScanner(evidenceInputText(input), false);
  const containers: EvidenceContainer[] = [];
  let rootState: "value" | "end" = "value";
  let members = 0;

  const countMember = () => {
    members += 1;
    if (members >= SKILL_EVIDENCE_JSON_LIMITS.maxMembers) throw new Error("member limit");
  };
  const beginValue = (token: number): void => {
    if (token === EVIDENCE_TOKEN.OPEN_BRACKET || token === EVIDENCE_TOKEN.OPEN_BRACE) {
      if (token === EVIDENCE_TOKEN.OPEN_BRACKET) {
        containers.push({ kind: "array", state: "valueOrEnd" });
      } else {
        containers.push({ kind: "object", state: "keyOrEnd" });
      }
      if (containers.length > SKILL_EVIDENCE_JSON_LIMITS.maxDepth + 1) {
        throw new Error("depth limit");
      }
      return;
    }
    if (
      token !== EVIDENCE_TOKEN.NULL &&
      token !== EVIDENCE_TOKEN.TRUE &&
      token !== EVIDENCE_TOKEN.FALSE &&
      token !== EVIDENCE_TOKEN.STRING &&
      token !== EVIDENCE_TOKEN.NUMBER
    ) {
      throw new Error("invalid value");
    }
  };

  for (;;) {
    const token: number = Number(scanner.scan());
    if (Number(scanner.getTokenError()) !== 0) throw new Error("invalid token");
    if (token === EVIDENCE_TOKEN.TRIVIA || token === EVIDENCE_TOKEN.LINE_BREAK) continue;
    if (token === EVIDENCE_TOKEN.EOF) break;
    if (token === EVIDENCE_TOKEN.LINE_COMMENT || token === EVIDENCE_TOKEN.BLOCK_COMMENT) {
      throw new Error("comments unavailable");
    }

    const container = containers.at(-1);
    if (container === undefined) {
      if (rootState !== "value") throw new Error("trailing value");
      if (token !== EVIDENCE_TOKEN.OPEN_BRACE) throw new Error("evidence root must be an object");
      rootState = "end";
      beginValue(token);
      continue;
    }

    if (container.kind === "array") {
      if (container.state === "valueOrEnd") {
        if (token === EVIDENCE_TOKEN.CLOSE_BRACKET) {
          containers.pop();
          continue;
        }
        countMember();
        container.state = "commaOrEnd";
        beginValue(token);
        continue;
      }
      if (token === EVIDENCE_TOKEN.COMMA) {
        container.state = "valueOrEnd";
        continue;
      }
      if (token === EVIDENCE_TOKEN.CLOSE_BRACKET) {
        containers.pop();
        continue;
      }
      throw new Error("invalid array");
    }

    if (container.state === "keyOrEnd") {
      if (token === EVIDENCE_TOKEN.CLOSE_BRACE) {
        containers.pop();
        continue;
      }
      if (token !== EVIDENCE_TOKEN.STRING) throw new Error("invalid object key");
      countMember();
      container.state = "colon";
      continue;
    }
    if (container.state === "colon") {
      if (token !== EVIDENCE_TOKEN.COLON) throw new Error("missing colon");
      container.state = "value";
      continue;
    }
    if (container.state === "value") {
      container.state = "commaOrEnd";
      beginValue(token);
      continue;
    }
    if (token === EVIDENCE_TOKEN.COMMA) {
      container.state = "keyOrEnd";
      continue;
    }
    if (token === EVIDENCE_TOKEN.CLOSE_BRACE) {
      containers.pop();
      continue;
    }
    throw new Error("invalid object");
  }
  if (rootState !== "end" || containers.length !== 0) throw new Error("incomplete JSON");
}

interface EvidenceSerializationState {
  readonly chunks: string[];
  readonly active: WeakSet<object>;
  bytes: number;
  members: number;
}

interface EvidenceSerializationProbe {
  scanned_code_units: number;
  max_buffered_string_bytes: number;
  members: number;
}

let evidenceSerializationProbe: EvidenceSerializationProbe | null = null;

export function withSkillEvidenceSerializationProbeForTest<T>(
  observe: (probe: Readonly<EvidenceSerializationProbe>) => void,
  operation: () => T,
): T {
  if (evidenceSerializationProbe !== null) throw new Error("evidence probe is already active");
  const probe: EvidenceSerializationProbe = {
    scanned_code_units: 0,
    max_buffered_string_bytes: 0,
    members: 0,
  };
  evidenceSerializationProbe = probe;
  try {
    return operation();
  } finally {
    evidenceSerializationProbe = null;
    observe(Object.freeze({ ...probe }));
  }
}

function evidenceLimit(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_LIMIT_EXCEEDED");
}

function appendEvidenceChunk(state: EvidenceSerializationState, chunk: string): void {
  const bytes = Buffer.byteLength(chunk, "utf8");
  if (state.bytes + bytes > SKILL_EVIDENCE_JSON_LIMITS.maxBytes) evidenceLimit();
  state.bytes += bytes;
  state.chunks.push(chunk);
}

function escapedEvidenceStringAtom(
  value: string,
  index: number,
): Readonly<{ chunk: string; bytes: number; codeUnits: number }> {
  const code = value.charCodeAt(index);
  if (code === 0x22) return { chunk: '\\"', bytes: 2, codeUnits: 1 };
  if (code === 0x5c) return { chunk: "\\\\", bytes: 2, codeUnits: 1 };
  if (code === 0x08) return { chunk: "\\b", bytes: 2, codeUnits: 1 };
  if (code === 0x09) return { chunk: "\\t", bytes: 2, codeUnits: 1 };
  if (code === 0x0a) return { chunk: "\\n", bytes: 2, codeUnits: 1 };
  if (code === 0x0c) return { chunk: "\\f", bytes: 2, codeUnits: 1 };
  if (code === 0x0d) return { chunk: "\\r", bytes: 2, codeUnits: 1 };
  if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        return { chunk: value.slice(index, index + 2), bytes: 4, codeUnits: 2 };
      }
    }
    return {
      chunk: `\\u${code.toString(16).padStart(4, "0")}`,
      bytes: 6,
      codeUnits: 1,
    };
  }
  return {
    chunk: value[index]!,
    bytes: code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3,
    codeUnits: 1,
  };
}

function appendEvidenceString(state: EvidenceSerializationState, value: string): void {
  if (state.bytes + 2 > SKILL_EVIDENCE_JSON_LIMITS.maxBytes) evidenceLimit();
  appendEvidenceChunk(state, '"');
  let buffered = "";
  let bufferedBytes = 0;
  const flush = (): void => {
    if (bufferedBytes === 0) return;
    if (bufferedBytes > (evidenceSerializationProbe?.max_buffered_string_bytes ?? 0)) {
      if (evidenceSerializationProbe !== null) {
        evidenceSerializationProbe.max_buffered_string_bytes = bufferedBytes;
      }
    }
    appendEvidenceChunk(state, buffered);
    buffered = "";
    bufferedBytes = 0;
  };
  for (let index = 0; index < value.length;) {
    const atom = escapedEvidenceStringAtom(value, index);
    if (state.bytes + bufferedBytes + atom.bytes + 1 > SKILL_EVIDENCE_JSON_LIMITS.maxBytes) {
      evidenceLimit();
    }
    if (bufferedBytes + atom.bytes > 4_096) flush();
    buffered += atom.chunk;
    bufferedBytes += atom.bytes;
    index += atom.codeUnits;
    if (evidenceSerializationProbe !== null) {
      evidenceSerializationProbe.scanned_code_units += atom.codeUnits;
    }
  }
  flush();
  appendEvidenceChunk(state, '"');
}

function countEvidenceMembers(state: EvidenceSerializationState, count: number): void {
  if (state.members + count >= SKILL_EVIDENCE_JSON_LIMITS.maxMembers) evidenceLimit();
  state.members += count;
  if (evidenceSerializationProbe !== null) evidenceSerializationProbe.members += count;
}

function serializeEvidenceValue(
  value: unknown,
  state: EvidenceSerializationState,
  depth: number,
  omittedRootKey: string | null,
): void {
  if (depth > SKILL_EVIDENCE_JSON_LIMITS.maxDepth) evidenceLimit();
  if (value === null) return appendEvidenceChunk(state, "null");
  if (typeof value === "string") return appendEvidenceString(state, value);
  if (typeof value === "boolean") return appendEvidenceChunk(state, value ? "true" : "false");
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) evidenceLimit();
    return appendEvidenceChunk(state, JSON.stringify(value));
  }
  if (typeof value !== "object") evidenceLimit();
  if (Object.getOwnPropertySymbols(value).length !== 0) evidenceLimit();
  if (state.active.has(value)) evidenceLimit();
  state.active.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) evidenceLimit();
    countEvidenceMembers(state, value.length);
    const ownNames = Object.getOwnPropertyNames(value);
    if (ownNames.length !== value.length + 1) evidenceLimit();
    appendEvidenceChunk(state, "[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) appendEvidenceChunk(state, ",");
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        evidenceLimit();
      }
      serializeEvidenceValue(descriptor.value, state, depth + 1, null);
    }
    appendEvidenceChunk(state, "]");
    state.active.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) evidenceLimit();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownNames = Object.getOwnPropertyNames(value);
  const enumerableNames = Object.keys(value);
  if (ownNames.length !== enumerableNames.length) evidenceLimit();
  for (const key of ownNames) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      evidenceLimit();
    }
  }
  if (depth === 0 && omittedRootKey !== null) {
    const omitted = descriptors[omittedRootKey];
    if (
      omitted === undefined ||
      typeof omitted.value !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(omitted.value)
    ) {
      evidenceLimit();
    }
  }
  const keys = ownNames.filter((key) => depth !== 0 || key !== omittedRootKey).sort();
  countEvidenceMembers(state, keys.length);
  appendEvidenceChunk(state, "{");
  for (const [index, key] of keys.entries()) {
    if (index > 0) appendEvidenceChunk(state, ",");
    const descriptor = descriptors[key]!;
    appendEvidenceString(state, key);
    appendEvidenceChunk(state, ":");
    serializeEvidenceValue(descriptor.value, state, depth + 1, null);
  }
  appendEvidenceChunk(state, "}");
  state.active.delete(value);
}

function boundedEvidenceJson(value: unknown, omittedRootKey: string | null = null): string {
  const state: EvidenceSerializationState = {
    chunks: [],
    active: new WeakSet<object>(),
    bytes: 0,
    members: 0,
  };
  serializeEvidenceValue(value, state, 0, omittedRootKey);
  return state.chunks.join("");
}

export function canonicalSkillEvidenceJson(value: unknown): string {
  return boundedEvidenceJson(value);
}

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
  limits: JsonLimits = DOCUMENT_LIMITS,
): Omit<T, "document_hash"> {
  const normalized = parseJsonBytes(canonicalJson(value, limits), limits);
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
  const bytes = boundedEvidenceJson(value, "document_hash");
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

export function hashSkillExecutionHandoff(
  value: Omit<SkillExecutionEvidenceV1, "handoff_hash" | "document_hash">,
): `sha256:${string}` {
  const bytes = boundedEvidenceJson({
    schema_version: "skill-execution-handoff.v1",
    evidence: value,
  });
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
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
  const members = [accounting.skill_markdown, ...accounting.resources];
  const invalidMember = members.some((resource, index) => {
    if (index > 0) {
      try {
        assertSkillRelativePath(resource.path);
      } catch {
        return true;
      }
    }
    const originalUnits = Math.ceil(resource.original_bytes / 4);
    const includedUnits = Math.ceil(resource.included_bytes / 4);
    if (
      resource.original_conservative_units !== originalUnits ||
      resource.included_conservative_units !== includedUnits ||
      resource.included_bytes > resource.original_bytes
    ) {
      return true;
    }
    if (resource.state === "INCLUDED") {
      return (
        resource.included_bytes !== resource.original_bytes ||
        resource.included_hash === null ||
        resource.included_hash !== resource.source_hash
      );
    }
    if (resource.state === "PARTIAL") {
      return (
        resource.included_bytes <= 0 ||
        resource.included_bytes >= resource.original_bytes ||
        resource.included_hash === null
      );
    }
    return (
      resource.included_bytes !== 0 ||
      resource.included_hash !== null ||
      resource.included_conservative_units !== 0
    );
  });
  const originalBytes = members.reduce((total, resource) => total + resource.original_bytes, 0);
  const includedBytes = members.reduce((total, resource) => total + resource.included_bytes, 0);
  const originalUnits = members.reduce(
    (total, resource) => total + resource.original_conservative_units,
    0,
  );
  const includedUnits = members.reduce(
    (total, resource) => total + resource.included_conservative_units,
    0,
  );
  if (
    invalidMember ||
    !orderedUnique(accounting.resources.map((resource) => resource.path)) ||
    accounting.resources.some((resource) => resource.path === "SKILL.md") ||
    accounting.original_utf8_bytes !== originalBytes ||
    accounting.included_utf8_bytes !== includedBytes ||
    accounting.original_conservative_units !== originalUnits ||
    accounting.included_conservative_units !== includedUnits ||
    accounting.segment_count !==
      members.filter((resource) => resource.state !== "OMITTED").length ||
    accounting.truncation_count !==
      accounting.resources.filter((resource) => resource.state === "PARTIAL").length ||
    accounting.included_utf8_bytes + accounting.remaining_bytes > SKILL_LIMITS.phaseInputBytes ||
    accounting.included_conservative_units + accounting.remaining_conservative_units >
      Math.ceil(SKILL_LIMITS.phaseInputBytes / 4)
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

function catalogDescriptorOrder(left: SkillDescriptorV1, right: SkillDescriptorV1): number {
  for (const [leftField, rightField] of [
    [left.name, right.name],
    [left.version, right.version],
    [left.source.kind, right.source.kind],
    [left.source.identity, right.source.identity],
    [left.package_hash, right.package_hash],
    [left.document_hash, right.document_hash],
  ] as const) {
    const order = bytewiseCompare(leftField, rightField);
    if (order !== 0) return order;
  }
  return 0;
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

function evidenceCommandInputHash(command: {
  readonly run_id: string;
  readonly expected_revision: number;
  readonly expected_head_hash: `sha256:${string}`;
  readonly operation_id: string | null;
  readonly next_state: RunState;
  readonly reason_code: string;
  readonly trace: TraceContext;
  readonly metadata: JsonValue;
  readonly side_effect: null;
}): `sha256:${string}` {
  return sha256({
    run_id: command.run_id,
    expected_revision: command.expected_revision,
    expected_head_hash: command.expected_head_hash,
    operation_id: command.operation_id,
    next_state: command.next_state,
    reason_code: command.reason_code,
    trace: command.trace,
    metadata: command.metadata,
    side_effect: command.side_effect,
  });
}

function pendingEvidenceCommand(phase: SuperpowersPhaseV1) {
  const operationHash = sha256({
    kind: "superpowers-approval-pending",
    run_id: phase.run_id,
    operation_id: phase.operation_id,
  });
  return {
    run_id: phase.run_id,
    expected_revision: phase.observed_journal_head.journal_revision,
    expected_head_hash: phase.observed_journal_head.entry_hash,
    command_id: `approval-pending:${operationHash}`,
    operation_id: phase.operation_id,
    next_state: "APPROVAL_PENDING" as const,
    reason_code: "SUPERPOWERS_APPROVAL_REQUIRED",
    trace: phase.trace,
    metadata: { kind: "superpowers-approval-pending", phase } as unknown as JsonValue,
    side_effect: null,
  };
}

function decisionEvidenceCommand(
  request: SuperpowersApprovalRequestV1,
  decision: SuperpowersApprovalDecisionV1,
  terminal: SuperpowersPhaseV1,
) {
  return {
    run_id: request.run_id,
    expected_revision: request.pending_journal_head.journal_revision,
    expected_head_hash: request.pending_journal_head.entry_hash,
    command_id: `approval-decision:${decision.operation_id}`,
    operation_id: decision.operation_id,
    next_state: decision.decision === "APPROVE" ? ("RUNNING" as const) : ("BLOCKED" as const),
    reason_code:
      decision.decision === "APPROVE"
        ? "SUPERPOWERS_APPROVAL_GRANTED"
        : "SUPERPOWERS_APPROVAL_REJECTED",
    trace: decision.trace,
    metadata: {
      kind: "superpowers-approval-decision",
      request,
      decision,
      occurred_at: terminal.occurred_at,
      phase: terminal,
    } as unknown as JsonValue,
    side_effect: null,
  };
}

function orderedTimestamp(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime <= rightTime;
}

function projectedRunAttempt(
  previous: Readonly<Pick<RunJournalEntryV1, "state" | "run_attempt">>,
  nextState: RunState,
): number {
  return nextState === "RUNNING" &&
    (previous.state === "FAILED" ||
      previous.state === "BLOCKED" ||
      previous.state === "INTERRUPTED")
    ? previous.run_attempt + 1
    : previous.run_attempt;
}

function projectedTransitionAllowed(previous: RunState, next: RunState): boolean {
  return (RUN_TRANSITION_MATRIX[previous] as readonly RunState[]).includes(next);
}

function journalPathLinkMatchesEntry(
  link: SkillJournalPathLinkV1,
  entry: RunJournalEntryV1,
): boolean {
  return (
    link.run_id === entry.run_id &&
    link.journal_revision === entry.journal_revision &&
    link.sequence === entry.sequence &&
    link.previous_entry_hash === entry.previous_entry_hash &&
    link.entry_hash === entry.entry_hash &&
    link.previous_state === entry.previous_state &&
    link.state === entry.state &&
    link.run_attempt === entry.run_attempt
  );
}

function evidenceIssues(value: SkillExecutionEvidenceV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const catalogHashes = value.catalogs.map((catalog) => catalog.catalog_hash);
  if (!orderedUnique(catalogHashes)) {
    issues.push(issue("/catalogs", "order", "catalog roots must be hash-sorted and unique"));
  }
  const catalogs = new Map(value.catalogs.map((catalog) => [catalog.catalog_hash, catalog]));
  const catalogMembers = new Map<
    `sha256:${string}`,
    ReadonlyMap<`sha256:${string}`, SkillDescriptorV1>
  >();
  for (const [index, catalog] of value.catalogs.entries()) {
    const descriptors = catalog.descriptors;
    const references = descriptors.map((descriptor) => ({
      name: descriptor.name,
      version: descriptor.version,
      source: descriptor.source,
      package_hash: descriptor.package_hash,
      document_hash: descriptor.document_hash,
    }));
    if (
      descriptors.some((descriptor) => !parseSkillDescriptor(canonicalJson(descriptor)).ok) ||
      descriptors.some(
        (descriptor, descriptorIndex) =>
          descriptorIndex > 0 &&
          catalogDescriptorOrder(descriptors[descriptorIndex - 1]!, descriptor) >= 0,
      ) ||
      hashSkillCatalog(references) !== catalog.catalog_hash
    ) {
      issues.push(issue(`/catalogs/${index}`, "binding", "catalog root is inconsistent"));
    }
    catalogMembers.set(
      catalog.catalog_hash,
      new Map(descriptors.map((descriptor) => [descriptor.document_hash, descriptor])),
    );
  }
  const snapshotHashes = value.snapshots.map((snapshot) => snapshot.document_hash);
  if (!orderedUnique(snapshotHashes)) {
    issues.push(issue("/snapshots", "order", "snapshots must be hash-sorted and unique"));
  }
  const snapshots = new Map(value.snapshots.map((snapshot) => [snapshot.document_hash, snapshot]));
  const usedSnapshots = new Set<`sha256:${string}`>();
  const usedCatalogs = new Set<`sha256:${string}`>();
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
    const contextMatchesSnapshot =
      snapshot !== undefined &&
      phase.context_accounting.skill_markdown.source_hash === snapshot.skill_markdown_hash &&
      phase.context_accounting.skill_markdown.original_bytes === snapshot.skill_markdown_bytes &&
      phase.context_accounting.resources.length === snapshot.resources.length &&
      phase.context_accounting.resources.every((accounted, resourceIndex) => {
        const resource = snapshot.resources[resourceIndex];
        if (
          resource === undefined ||
          accounted.path !== resource.path ||
          accounted.source_hash !== resource.hash ||
          accounted.original_bytes !== resource.bytes
        ) {
          return false;
        }
        const applicable = resource.role === "reference" && resource.phases.includes(phase.phase);
        if (!applicable) return accounted.state === "OMITTED";
        return resource.priority !== null || accounted.state === "INCLUDED";
      });
    if (!parseSuperpowersPhase(canonicalJson(phase)).ok) {
      issues.push(issue(`/phases/${index}`, "innerDocument", "phase is not self-verifying"));
    }
    const handler = builtInSuperpowersHandler(phase.phase);
    const catalogMember = catalogMembers.get(phase.catalog_hash)?.get(phase.skill.document_hash);
    if (
      phase.run_id !== value.run_id ||
      phase.phase_revision !== index + 1 ||
      phase.previous_phase_hash !== (previous?.document_hash ?? `sha256:${"0".repeat(64)}`) ||
      phase.observed_journal_head.sequence > value.journal_head.sequence ||
      phase.skill.name !== handler.capability ||
      phase.handler.version !== handler.version ||
      phase.handler.hash !== handler.hash ||
      !contextMatchesSnapshot ||
      catalogMember === undefined ||
      !exactJson(
        {
          name: catalogMember.name,
          version: catalogMember.version,
          source: catalogMember.source,
          package_hash: catalogMember.package_hash,
          document_hash: catalogMember.document_hash,
        },
        {
          name: phase.skill.name,
          version: phase.skill.version,
          source: phase.skill.source,
          package_hash: phase.skill.package_hash,
          document_hash: phase.skill.document_hash,
        },
      ) ||
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
    usedSnapshots.add(phase.skill.snapshot_hash);
    usedCatalogs.add(phase.catalog_hash);
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
  if (
    usedSnapshots.size !== snapshots.size ||
    usedCatalogs.size !== catalogs.size ||
    [...usedSnapshots].some((snapshotHash) => !snapshots.has(snapshotHash)) ||
    [...snapshots.keys()].some((snapshotHash) => !usedSnapshots.has(snapshotHash)) ||
    [...usedCatalogs].some((catalogHash) => !catalogs.has(catalogHash)) ||
    [...catalogs.keys()].some((catalogHash) => !usedCatalogs.has(catalogHash))
  ) {
    issues.push(
      issue("/snapshots", "projection", "snapshot and catalog roots must be used exactly once"),
    );
  }

  const phasesByHash = new Map(value.phases.map((phase) => [phase.document_hash, phase]));
  const phaseByPreviousHash = new Map(
    value.phases.slice(1).map((phase) => [phase.previous_phase_hash, phase]),
  );
  const pendingPhaseHashes = new Set(
    value.phases
      .filter((phase) => phase.status === "APPROVAL_PENDING")
      .map((phase) => phase.document_hash),
  );
  const requests = new Set<string>();
  const decisions = new Set<string>();
  const journalPathByHash = new Map<`sha256:${string}`, SkillJournalPathLinkV1>();
  const journalPathSequences = new Set<number>();
  for (const [index, link] of value.journal_path.entries()) {
    const previous = value.journal_path[index - 1];
    const duplicate =
      journalPathByHash.has(link.entry_hash) || journalPathSequences.has(link.sequence);
    const firstInvalid =
      previous === undefined &&
      (link.journal_revision !== 1 ||
        link.sequence !== 1 ||
        link.run_attempt !== 1 ||
        link.previous_entry_hash !== ZERO_JOURNAL_HASH ||
        link.previous_state !== null ||
        link.state !== "CREATED");
    const successorInvalid =
      previous !== undefined &&
      (link.journal_revision !== previous.journal_revision + 1 ||
        link.sequence !== previous.sequence + 1 ||
        link.previous_entry_hash !== previous.entry_hash ||
        link.previous_state !== previous.state ||
        !projectedTransitionAllowed(previous.state, link.state) ||
        link.run_attempt !== projectedRunAttempt(previous, link.state));
    if (link.run_id !== value.run_id || duplicate || firstInvalid || successorInvalid) {
      issues.push(issue(`/journal_path/${index}`, "chain", "journal path link is inconsistent"));
    }
    journalPathByHash.set(link.entry_hash, link);
    journalPathSequences.add(link.sequence);
  }
  const journalPathHead = value.journal_path.at(-1);
  if (
    value.journal_path.length === 0 ||
    journalPathHead === undefined ||
    value.journal_path.length !== value.journal_head.sequence ||
    journalPathHead.journal_revision !== value.journal_head.journal_revision ||
    journalPathHead.sequence !== value.journal_head.sequence ||
    journalPathHead.entry_hash !== value.journal_head.entry_hash ||
    journalPathHead.state !== value.run_state
  ) {
    issues.push(issue("/journal_head", "chain", "journal head is not the exact compact path head"));
  }

  const projectedJournalEntries = new Map<`sha256:${string}`, RunJournalEntryV1>();
  const projectedJournalSources = new Map<
    `sha256:${string}`,
    "approval-request" | "approval-decision" | "terminal"
  >();
  const addProjectedJournalEntry = (
    entry: RunJournalEntryV1,
    source: "approval-request" | "approval-decision" | "terminal",
  ): void => {
    const link = journalPathByHash.get(entry.entry_hash);
    if (
      projectedJournalEntries.has(entry.entry_hash) ||
      link === undefined ||
      !journalPathLinkMatchesEntry(link, entry)
    ) {
      issues.push(
        issue("/journal_path", "projection", "full journal entries must match one path link"),
      );
      return;
    }
    projectedJournalEntries.set(entry.entry_hash, entry);
    projectedJournalSources.set(entry.entry_hash, source);
  };
  for (const [index, approval] of value.approvals.entries()) {
    const requestResult = parseSuperpowersApproval(canonicalJson(approval.request));
    const decisionResult =
      approval.decision === null
        ? null
        : parseSuperpowersApproval(canonicalJson(approval.decision));
    const phase = phasesByHash.get(approval.request.phase_document_hash);
    const requestEntryResult = parseRunJournalEntry(canonicalJson(approval.request_journal_entry));
    const requestEntry = approval.request_journal_entry;
    const pendingCommand = phase === undefined ? null : pendingEvidenceCommand(phase);
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
      !exactJson(approval.request.trace, phase.trace) ||
      !requestEntryResult.ok ||
      requestEntry.run_id !== value.run_id ||
      requestEntry.previous_entry_hash !== phase.observed_journal_head.entry_hash ||
      requestEntry.journal_revision !== phase.observed_journal_head.journal_revision + 1 ||
      requestEntry.sequence !== phase.observed_journal_head.sequence + 1 ||
      requestEntry.previous_state !== "RUNNING" ||
      requestEntry.state !== "APPROVAL_PENDING" ||
      pendingCommand === null ||
      requestEntry.command_id !== pendingCommand.command_id ||
      requestEntry.command_input_hash !== evidenceCommandInputHash(pendingCommand) ||
      requestEntry.operation_id !== pendingCommand.operation_id ||
      requestEntry.reason_code !== pendingCommand.reason_code ||
      !exactJson(requestEntry.trace, pendingCommand.trace) ||
      !exactJson(requestEntry.metadata, pendingCommand.metadata) ||
      requestEntry.side_effect !== null ||
      !orderedTimestamp(phase.occurred_at, requestEntry.timestamp) ||
      !exactJson(approval.request.pending_journal_head, {
        journal_revision: requestEntry.journal_revision,
        sequence: requestEntry.sequence,
        entry_hash: requestEntry.entry_hash,
      }) ||
      requests.has(approval.request.document_hash)
    ) {
      issues.push(
        issue(`/approvals/${index}/request`, "binding", "approval request is inconsistent"),
      );
    }
    requests.add(approval.request.document_hash);
    addProjectedJournalEntry(requestEntry, "approval-request");
    if (phase !== undefined) pendingPhaseHashes.delete(phase.document_hash);
    if (approval.decision === null) {
      const terminal =
        phase === undefined ? undefined : phaseByPreviousHash.get(phase.document_hash);
      if (approval.decision_journal_entry !== null || terminal !== undefined) {
        issues.push(
          issue(`/approvals/${index}`, "decisionEntry", "missing decision has no journal entry"),
        );
      }
    } else {
      const terminal =
        phase === undefined ? undefined : phaseByPreviousHash.get(phase.document_hash);
      const expectedStatus = approval.decision.decision === "APPROVE" ? "COMPLETED" : "BLOCKED";
      const expectedCode =
        approval.decision.decision === "APPROVE" ? null : "RUNTIME_SKILL_APPROVAL_REJECTED";
      const decisionEntry = approval.decision_journal_entry;
      const decisionEntryResult =
        decisionEntry === null ? null : parseRunJournalEntry(canonicalJson(decisionEntry));
      const decisionCommand =
        terminal === undefined
          ? null
          : decisionEvidenceCommand(approval.request, approval.decision, terminal);
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
        !exactJson(approval.decision.trace, terminal?.trace) ||
        terminal?.status !== expectedStatus ||
        terminal.terminal_code !== expectedCode ||
        terminal.output_hash !==
          (approval.decision.decision === "APPROVE" ? phase?.output_hash : null) ||
        decisionEntry === null ||
        decisionEntryResult === null ||
        !decisionEntryResult.ok ||
        decisionEntry.run_id !== value.run_id ||
        decisionEntry.previous_entry_hash !== requestEntry.entry_hash ||
        decisionEntry.journal_revision !== requestEntry.journal_revision + 1 ||
        decisionEntry.sequence !== requestEntry.sequence + 1 ||
        decisionEntry.run_attempt !== requestEntry.run_attempt ||
        decisionEntry.previous_state !== "APPROVAL_PENDING" ||
        decisionEntry.state !==
          (approval.decision.decision === "APPROVE" ? "RUNNING" : "BLOCKED") ||
        decisionCommand === null ||
        decisionEntry.command_id !== decisionCommand.command_id ||
        decisionEntry.command_input_hash !== evidenceCommandInputHash(decisionCommand) ||
        decisionEntry.operation_id !== decisionCommand.operation_id ||
        decisionEntry.reason_code !== decisionCommand.reason_code ||
        !exactJson(decisionEntry.trace, decisionCommand.trace) ||
        !exactJson(decisionEntry.metadata, decisionCommand.metadata) ||
        decisionEntry.side_effect !== null ||
        !orderedTimestamp(requestEntry.timestamp, terminal.occurred_at) ||
        !orderedTimestamp(terminal.occurred_at, decisionEntry.timestamp) ||
        decisions.has(approval.decision.document_hash)
      ) {
        issues.push(
          issue(`/approvals/${index}/decision`, "binding", "approval decision is inconsistent"),
        );
      }
      decisions.add(approval.decision.document_hash);
      if (decisionEntry !== null) {
        addProjectedJournalEntry(decisionEntry, "approval-decision");
      }
    }
  }
  if (pendingPhaseHashes.size !== 0) {
    issues.push(issue("/approvals", "projection", "every pending phase requires one approval"));
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
        (approval.decision_journal_entry?.sequence ?? approval.request_journal_entry.sequence) >
        value.journal_head.sequence,
    )
  ) {
    issues.push(issue("/approvals", "order", "approval journal heads are not ordered"));
  }

  const latest = value.phases.at(-1);
  const unresolvedApprovals = value.approvals.filter((approval) => approval.decision === null);
  const unresolvedApproval = unresolvedApprovals[0];
  const approvalPendingTruth =
    unresolvedApprovals.length === 1 &&
    unresolvedApproval !== undefined &&
    latest?.status === "APPROVAL_PENDING" &&
    latest.document_hash === unresolvedApproval.request.phase_document_hash &&
    exactJson(value.journal_head, {
      journal_revision: unresolvedApproval.request_journal_entry.journal_revision,
      sequence: unresolvedApproval.request_journal_entry.sequence,
      entry_hash: unresolvedApproval.request_journal_entry.entry_hash,
    });
  if (
    (value.run_state === "APPROVAL_PENDING") !== approvalPendingTruth ||
    unresolvedApprovals.length > 1 ||
    (unresolvedApprovals.length !== 0 && !approvalPendingTruth)
  ) {
    issues.push(
      issue("/run_state", "approvalState", "approval-pending state is not current journal truth"),
    );
  }
  const terminalEntry = value.terminal_journal_entry;
  const terminalEntryResult =
    terminalEntry === null ? null : parseRunJournalEntry(canonicalJson(terminalEntry));
  if (
    terminalEntry !== null &&
    (terminalEntryResult === null ||
      !terminalEntryResult.ok ||
      terminalEntry.run_id !== value.run_id ||
      terminalEntry.entry_hash !== value.journal_head.entry_hash ||
      terminalEntry.journal_revision !== value.journal_head.journal_revision ||
      terminalEntry.sequence !== value.journal_head.sequence ||
      terminalEntry.state !== value.run_state ||
      (terminalEntry.state !== "FAILED" && terminalEntry.state !== "BLOCKED") ||
      !isRuntimeSkillErrorCode(terminalEntry.reason_code))
  ) {
    issues.push(
      issue("/terminal_journal_entry", "binding", "terminal journal entry is inconsistent"),
    );
  }
  if (terminalEntry !== null) addProjectedJournalEntry(terminalEntry, "terminal");

  for (const [index, phase] of value.phases.entries()) {
    const observed = journalPathByHash.get(phase.observed_journal_head.entry_hash);
    if (
      observed === undefined ||
      observed.journal_revision !== phase.observed_journal_head.journal_revision ||
      observed.sequence !== phase.observed_journal_head.sequence ||
      observed.state !== "RUNNING"
    ) {
      issues.push(
        issue(
          `/phases/${index}/observed_journal_head`,
          "binding",
          "phase journal anchor is not exact RUNNING truth",
        ),
      );
    }
  }
  for (const entry of projectedJournalEntries.values()) {
    const metadataKind =
      typeof entry.metadata === "object" &&
      entry.metadata !== null &&
      !Array.isArray(entry.metadata)
        ? (entry.metadata as Readonly<Record<string, JsonValue>>).kind
        : undefined;
    const source = projectedJournalSources.get(entry.entry_hash);
    if (
      (metadataKind === "superpowers-approval-pending" && source !== "approval-request") ||
      (metadataKind === "superpowers-approval-decision" && source !== "approval-decision") ||
      (source === "approval-request" && metadataKind !== "superpowers-approval-pending") ||
      (source === "approval-decision" && metadataKind !== "superpowers-approval-decision")
    ) {
      issues.push(issue("/approvals", "projection", "approval journal entries are not one-to-one"));
    }
  }
  const finalApprovalEntry = value.approvals
    .map((approval) => approval.decision_journal_entry ?? approval.request_journal_entry)
    .find((entry) => entry.entry_hash === value.journal_head.entry_hash);
  const finalApprovalReject =
    finalApprovalEntry !== undefined &&
    finalApprovalEntry.state === "BLOCKED" &&
    value.run_state === "BLOCKED";
  if (
    (finalApprovalEntry !== undefined && finalApprovalEntry.state !== value.run_state) ||
    (terminalEntry !== null && value.run_state !== "FAILED" && value.run_state !== "BLOCKED") ||
    (latest === undefined && terminalEntry === null) ||
    (terminalEntry === null &&
      !finalApprovalReject &&
      value.terminal_code !== (latest?.terminal_code ?? null))
  ) {
    issues.push(
      issue(
        "/terminal_journal_entry",
        "presence",
        "final journal proof is not present exactly once",
      ),
    );
  }
  if (value.phases.length > 0 && (value.run_state === "CREATED" || value.run_state === "ROUTED")) {
    issues.push(issue("/run_state", "state", "run state cannot precede retained skill phases"));
  }
  const expectedTerminal =
    terminalEntry !== null && isRuntimeSkillErrorCode(terminalEntry.reason_code)
      ? terminalEntry.reason_code
      : (latest?.terminal_code ?? null);
  if (
    (latest === undefined &&
      (value.terminal_code === null ||
        (value.run_state !== "FAILED" && value.run_state !== "BLOCKED"))) ||
    (latest !== undefined && value.terminal_code !== expectedTerminal)
  ) {
    issues.push(issue("/terminal_code", "state", "terminal code does not match current execution"));
  }
  if (value.document_hash !== hashSkillExecutionEvidence(value))
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
  try {
    preflightEvidenceStructure(input);
  } catch {
    return failure([issue("", "evidencePreflight", "evidence JSON exceeds its structural budget")]);
  }
  try {
    return parseDocument(
      input,
      "skill-execution-evidence",
      SKILL_EVIDENCE_JSON_LIMITS,
      evidenceIssues,
    );
  } catch {
    return failure([
      issue("", "evidenceSemantic", "evidence exceeds a nested semantic document budget"),
    ]);
  }
}

export type {
  HashableSkillDescriptorV1,
  HashableSkillExecutionEvidenceV1,
  HashableSkillSnapshotV1,
  HashableSuperpowersApprovalV1,
  HashableSuperpowersPhaseV1,
};
