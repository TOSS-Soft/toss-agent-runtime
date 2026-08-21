import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import definitionSchema from "../../contracts/runtime/agent-definition.v1.schema.json" with { type: "json" };
import registrySchema from "../../contracts/runtime/agent-registry-entry.v1.schema.json" with { type: "json" };
import contextSchema from "../../contracts/runtime/compiled-context.v1.schema.json" with { type: "json" };
import promptSchema from "../../contracts/runtime/prompt-template.v1.schema.json" with { type: "json" };
import commonSchema from "../../contracts/runtime/runtime-common.v1.schema.json" with { type: "json" };
import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonLimits,
  type JsonValue,
} from "../protocol/json.js";
import type { ValidationFailure, ValidationIssue, ValidationResult } from "../protocol/types.js";
import type {
  AgentDefinitionV1,
  AgentRegistryEntryV1,
  CompiledContextSegmentKind,
  CompiledContextV1,
  HashableAgentDefinitionV1,
  HashableAgentRegistryEntryV1,
  HashableCompiledContextV1,
  HashablePromptTemplateV1,
  PromptTemplateV1,
} from "./types.js";

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

export const AGENT_DOCUMENT_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxMembers: 100_000,
});

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: false,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
addFormats(ajv);
ajv.addSchema(commonSchema);

const validatePromptTemplate = ajv.compile(promptSchema);
const validateAgentDefinition = ajv.compile(definitionSchema);
const validateAgentRegistryEntry = ajv.compile(registrySchema);
const validateCompiledContext = ajv.compile(contextSchema);

type JsonRecord = { readonly [key: string]: JsonValue };

function isRecord(value: JsonValue): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(path: string, keyword: string, message: string): ValidationIssue {
  return { path, keyword, message };
}

function sortIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return [...issues].sort((left, right) =>
    `${left.path}\u0000${left.keyword}\u0000${left.message}`.localeCompare(
      `${right.path}\u0000${right.keyword}\u0000${right.message}`,
    ),
  );
}

function failure(issues: readonly ValidationIssue[]): ValidationFailure {
  return { ok: false, code: "RUNTIME_DOCUMENT_INVALID", issues: sortIssues(issues) };
}

function normalizeIssues(errors: readonly ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) =>
    issue(error.instancePath, error.keyword, error.message ?? "invalid value"),
  );
}

function parseAndValidateAgentDocument<T>(
  input: string | Uint8Array,
  validator: ValidateFunction,
  semanticValidator: (value: T) => readonly ValidationIssue[],
): ValidationResult<T> {
  let candidate: JsonValue;
  try {
    candidate = deepFreezeJson(parseJsonBytes(input, AGENT_DOCUMENT_LIMITS), AGENT_DOCUMENT_LIMITS);
  } catch {
    return failure([issue("", "json", "agent document is invalid")]);
  }
  if (!validator(candidate)) return failure(normalizeIssues(validator.errors));

  const value = candidate as unknown as T;
  const issues = semanticValidator(value);
  return issues.length === 0 ? { ok: true, value } : failure(issues);
}

function canonicalHash(
  value: unknown,
  omitted: "document_hash" | "entry_hash",
): `sha256:${string}` {
  const normalized = parseJsonBytes(
    canonicalJson(value, AGENT_DOCUMENT_LIMITS),
    AGENT_DOCUMENT_LIMITS,
  );
  if (!isRecord(normalized)) throw new TypeError("agent document is invalid");
  const hashable: Record<string, JsonValue> = { ...normalized };
  delete hashable[omitted];
  return sha256(hashable, AGENT_DOCUMENT_LIMITS);
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function orderedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || bytewiseCompare(values[index - 1] as string, value) < 0,
  );
}

function artifactKey(reference: {
  readonly document_type: string;
  readonly artifact_id: string;
  readonly revision: number;
  readonly hash: string;
}): string {
  return `${reference.document_type}\u0000${reference.artifact_id}\u0000${String(reference.revision).padStart(16, "0")}\u0000${reference.hash}`;
}

function orderedUniqueReferences(
  references: readonly {
    readonly document_type: string;
    readonly artifact_id: string;
    readonly revision: number;
    readonly hash: string;
  }[],
): boolean {
  return orderedUnique(references.map(artifactKey));
}

function hashIssue<T extends { readonly document_hash: `sha256:${string}` }>(
  value: T,
  hash: `sha256:${string}`,
): ValidationIssue | undefined {
  return value.document_hash === hash
    ? undefined
    : issue("/document_hash", "canonicalHash", "document hash does not match canonical content");
}

function validatePromptSemantics(value: PromptTemplateV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const blockIds = value.instruction_blocks.map((block) => block.block_id);
  if (new Set(blockIds).size !== blockIds.length) {
    issues.push(
      issue("/instruction_blocks", "uniqueBlock", "instruction block IDs must be unique"),
    );
  }
  try {
    const mismatch = hashIssue(value, hashPromptTemplate(value));
    if (mismatch !== undefined) issues.push(mismatch);
  } catch {
    issues.push(issue("/document_hash", "canonicalHash", "document hash is invalid"));
  }
  return issues;
}

function validateDefinitionSemantics(value: AgentDefinitionV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sets: readonly [string, readonly string[]][] = [
    ["/model/required_capabilities", value.model.required_capabilities],
    ["/model/allowed_capabilities", value.model.allowed_capabilities],
    ["/superpowers/required", value.superpowers.required],
    ["/superpowers/allowed", value.superpowers.allowed],
  ];
  for (const [path, members] of sets) {
    if (!orderedUnique(members))
      issues.push(issue(path, "order", "set must be ASCII-sorted and unique"));
  }
  if (
    !value.model.required_capabilities.every((capability) =>
      value.model.allowed_capabilities.includes(capability),
    )
  ) {
    issues.push(
      issue("/model/required_capabilities", "subset", "required capabilities must be allowed"),
    );
  }
  if (
    !value.superpowers.required.every((capability) =>
      value.superpowers.allowed.includes(capability),
    )
  ) {
    issues.push(issue("/superpowers/required", "subset", "required capabilities must be allowed"));
  }
  const referenceSets: readonly [
    string,
    readonly {
      readonly document_type: string;
      readonly artifact_id: string;
      readonly revision: number;
      readonly hash: string;
    }[],
  ][] = [
    ["/task_contracts", value.task_contracts],
    ["/mcp_profiles", value.mcp_profiles],
    ["/output_schemas", value.output_schemas],
  ];
  for (const [path, references] of referenceSets) {
    if (!orderedUniqueReferences(references)) {
      issues.push(issue(path, "order", "artifact references must be ASCII-sorted and unique"));
    }
  }
  const documentTypes = value.context_policy.inputs.map((input) => input.document_type);
  const priorities = value.context_policy.inputs.map((input) => input.priority);
  if (new Set(documentTypes).size !== documentTypes.length) {
    issues.push(
      issue("/context_policy/inputs", "uniqueDocumentType", "document types must be unique"),
    );
  }
  if (new Set(priorities).size !== priorities.length) {
    issues.push(issue("/context_policy/inputs", "uniquePriority", "priorities must be unique"));
  }
  try {
    const mismatch = hashIssue(value, hashAgentDefinition(value));
    if (mismatch !== undefined) issues.push(mismatch);
  } catch {
    issues.push(issue("/document_hash", "canonicalHash", "document hash is invalid"));
  }
  return issues;
}

function validateRegistrySemantics(value: AgentRegistryEntryV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if ((value.registry_revision === 1) !== (value.previous_entry_hash === null)) {
    issues.push(
      issue(
        "/previous_entry_hash",
        "hashChain",
        "first registry entry has no predecessor and later entries require one",
      ),
    );
  }
  try {
    const expected = hashAgentRegistryEntry(value);
    if (value.entry_hash !== expected) {
      issues.push(
        issue("/entry_hash", "canonicalHash", "entry hash does not match canonical content"),
      );
    }
  } catch {
    issues.push(issue("/entry_hash", "canonicalHash", "entry hash is invalid"));
  }
  return issues;
}

const SEGMENT_ORDER: Readonly<Record<CompiledContextSegmentKind, number>> = {
  "runtime-safety": 0,
  "task-contract": 1,
  "prompt-template": 2,
  "output-schema": 3,
  "input-artifact": 4,
};

function validateContextSemantics(value: CompiledContextV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const segmentIds = value.segments.map((segment) => segment.segment_id);
  if (new Set(segmentIds).size !== segmentIds.length) {
    issues.push(issue("/segments", "uniqueSegment", "segment IDs must be unique"));
  }
  if (
    !value.segments.every(
      (segment, index) =>
        index === 0 ||
        SEGMENT_ORDER[value.segments[index - 1]!.kind] <= SEGMENT_ORDER[segment.kind],
    )
  ) {
    issues.push(issue("/segments", "order", "segments must follow fixed precedence"));
  }
  let inputTokens = 0;
  let inputBytes = 0;
  let untrustedBytes = 0;
  for (const [index, segment] of value.segments.entries()) {
    const bytes = Buffer.byteLength(segment.content, "utf8");
    if (segment.included_bytes !== bytes || segment.original_bytes < segment.included_bytes) {
      issues.push(issue(`/segments/${index}`, "byteCount", "segment byte counts are inconsistent"));
    }
    if (segment.tokens !== segment.included_bytes) {
      issues.push(
        issue(`/segments/${index}/tokens`, "tokenCount", "tokens must equal included bytes"),
      );
    }
    if ((segment.kind === "runtime-safety") !== (segment.source === null)) {
      issues.push(
        issue(`/segments/${index}/source`, "source", "runtime safety source must be null"),
      );
    }
    inputTokens += segment.tokens;
    inputBytes += segment.included_bytes;
    if (segment.trust === "untrusted-content") untrustedBytes += segment.included_bytes;
  }
  if (
    value.accounting.input_tokens !== inputTokens ||
    value.accounting.input_bytes !== inputBytes ||
    value.accounting.untrusted_bytes !== untrustedBytes ||
    value.accounting.remaining_input_tokens !==
      value.authority.budget.max_input_tokens - inputTokens
  ) {
    issues.push(issue("/accounting", "arithmetic", "context accounting is inconsistent"));
  }
  if (inputTokens > value.authority.budget.max_input_tokens) {
    issues.push(issue("/accounting", "bound", "context exceeds input token budget"));
  }
  try {
    const mismatch = hashIssue(value, hashCompiledContext(value));
    if (mismatch !== undefined) issues.push(mismatch);
  } catch {
    issues.push(issue("/document_hash", "canonicalHash", "document hash is invalid"));
  }
  return issues;
}

export function hashPromptTemplate(value: HashablePromptTemplateV1): `sha256:${string}` {
  return canonicalHash(value, "document_hash");
}

export function hashAgentDefinition(value: HashableAgentDefinitionV1): `sha256:${string}` {
  return canonicalHash(value, "document_hash");
}

export function hashAgentRegistryEntry(value: HashableAgentRegistryEntryV1): `sha256:${string}` {
  return canonicalHash(value, "entry_hash");
}

export function hashCompiledContext(value: HashableCompiledContextV1): `sha256:${string}` {
  return canonicalHash(value, "document_hash");
}

export function parsePromptTemplate(
  input: string | Uint8Array,
): ValidationResult<PromptTemplateV1> {
  return parseAndValidateAgentDocument(input, validatePromptTemplate, validatePromptSemantics);
}

export function parseAgentDefinition(
  input: string | Uint8Array,
): ValidationResult<AgentDefinitionV1> {
  return parseAndValidateAgentDocument(input, validateAgentDefinition, validateDefinitionSemantics);
}

export function parseAgentRegistryEntry(
  input: string | Uint8Array,
): ValidationResult<AgentRegistryEntryV1> {
  return parseAndValidateAgentDocument(
    input,
    validateAgentRegistryEntry,
    validateRegistrySemantics,
  );
}

export function parseCompiledContext(
  input: string | Uint8Array,
): ValidationResult<CompiledContextV1> {
  return parseAndValidateAgentDocument(input, validateCompiledContext, validateContextSemantics);
}
