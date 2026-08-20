import path from "node:path";

import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { parseDocument } from "yaml";

import candidateSchema from "../../../contracts/runtime/candidate-job-intent.v1.schema.json" with { type: "json" };
import registrySchema from "../../../contracts/runtime/project-registry-entry.v1.schema.json" with { type: "json" };
import manifestSchema from "../../../contracts/runtime/project-watch-manifest.v1.schema.json" with { type: "json" };
import {
  assertPlainJson,
  canonicalJson,
  deepFreezeJson,
  DEFAULT_JSON_LIMITS,
  parseJsonBytes,
  sha256,
  type JsonValue,
} from "../../protocol/json.js";
import type { ValidationFailure, ValidationIssue, ValidationResult } from "../../protocol/types.js";
import type {
  CandidateJobIntentV1,
  HashableProjectRegistryEntryV1,
  ProjectChange,
  ProjectRegistryEntryV1,
  ProjectWatchManifestV1,
} from "./types.js";

const MAX_PROJECT_DOCUMENT_BYTES = 65_536;
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;
const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: false,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
addFormats(ajv);

const validateManifest = ajv.compile(manifestSchema);
const validateRegistry = ajv.compile(registrySchema);
const validateCandidate = ajv.compile(candidateSchema);

function issueOrder(issue: ValidationIssue): string {
  return `${issue.path}\u0000${issue.keyword}\u0000${issue.message}`;
}

function normalizeIssues(errors: readonly ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? [])
    .map((error) => ({
      path: error.instancePath,
      keyword: error.keyword,
      message: error.message ?? "invalid value",
    }))
    .sort((left, right) => issueOrder(left).localeCompare(issueOrder(right)));
}

function invalid(
  pathValue = "",
  keyword = "semantic",
  message = "project document is invalid",
): ValidationFailure {
  return {
    ok: false,
    code: "RUNTIME_DOCUMENT_INVALID",
    issues: [{ path: pathValue, keyword, message }],
  };
}

function parseJsonContract<T>(
  input: string | Uint8Array,
  validator: ValidateFunction,
): ValidationResult<T> {
  let candidate: JsonValue;
  try {
    candidate = deepFreezeJson(
      parseJsonBytes(input, {
        ...DEFAULT_JSON_LIMITS,
        maxBytes: MAX_PROJECT_DOCUMENT_BYTES,
      }),
    );
  } catch {
    return invalid("", "json", "invalid JSON input");
  }
  if (!validator(candidate)) {
    return {
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: normalizeIssues(validator.errors),
    };
  }
  return { ok: true, value: candidate as unknown as T };
}

export function isSafeProjectRelativePath(candidate: string): boolean {
  if (
    candidate.length === 0 ||
    path.posix.isAbsolute(candidate) ||
    candidate.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(candidate) ||
    path.posix.normalize(candidate) !== candidate
  ) {
    return false;
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return false;
  }
  return (
    candidate !== ".git" &&
    !candidate.startsWith(".git/") &&
    candidate !== ".toss/runtime" &&
    !candidate.startsWith(".toss/runtime/")
  );
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function hashProjectWatchManifest(manifest: ProjectWatchManifestV1): `sha256:${string}` {
  return sha256(manifest);
}

export function parseProjectWatchManifest(
  input: string | Uint8Array,
): ValidationResult<ProjectWatchManifestV1> {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (bytes.byteLength > MAX_PROJECT_DOCUMENT_BYTES)
    return invalid("", "maxBytes", "input is too large");
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const document = parseDocument(text, { schema: "core", uniqueKeys: true });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      return invalid("", "yaml", "invalid YAML input");
    }
    value = document.toJS({ maxAliasCount: 0 });
    assertPlainJson(value);
  } catch {
    return invalid("", "yaml", "invalid YAML input");
  }
  if (!validateManifest(value)) {
    return {
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: normalizeIssues(validateManifest.errors),
    };
  }
  const raw = value as {
    readonly schema_version: "project-watch-manifest.v1";
    readonly watch_paths: readonly string[];
    readonly ignore_paths?: readonly string[];
  };
  const ignorePaths = raw.ignore_paths ?? [];
  if (
    !unique(raw.watch_paths) ||
    !unique(ignorePaths) ||
    raw.watch_paths.some((candidate) => !isSafeProjectRelativePath(candidate)) ||
    ignorePaths.some((candidate) => !isSafeProjectRelativePath(candidate))
  ) {
    return invalid("", "relativePath", "manifest paths must be safe and unique");
  }
  const normalized = deepFreezeJson({
    schema_version: raw.schema_version,
    watch_paths: raw.watch_paths,
    ignore_paths: ignorePaths,
  }) as unknown as ProjectWatchManifestV1;
  return { ok: true, value: normalized };
}

export function hashProjectRegistryEntry(
  entry: HashableProjectRegistryEntryV1,
): `sha256:${string}` {
  return sha256(entry);
}

export function parseProjectRegistryEntry(
  input: string | Uint8Array,
): ValidationResult<ProjectRegistryEntryV1> {
  const parsed = parseJsonContract<ProjectRegistryEntryV1>(input, validateRegistry);
  if (!parsed.ok) return parsed;
  if (
    !path.isAbsolute(parsed.value.canonical_root) ||
    path.normalize(parsed.value.canonical_root) !== parsed.value.canonical_root ||
    /[\u0000-\u001f\u007f]/u.test(parsed.value.canonical_root)
  ) {
    return invalid("/canonical_root", "absolutePath", "canonical root must be absolute");
  }
  const { entry_hash: entryHash, ...hashable } = parsed.value;
  if (hashProjectRegistryEntry(hashable) !== entryHash) {
    return invalid("/entry_hash", "contentHash", "entry hash must match canonical content");
  }
  return parsed;
}

function changeOrder(change: ProjectChange): string {
  return `${change.path}\u0000${change.kind}\u0000${canonicalJson(change.identity)}`;
}

export function candidateJobKey(
  candidate: Pick<
    CandidateJobIntentV1,
    "project_id" | "registry_revision" | "manifest_hash" | "changes"
  >,
): `sha256:${string}` {
  return sha256({
    project_id: candidate.project_id,
    registry_revision: candidate.registry_revision,
    manifest_hash: candidate.manifest_hash,
    changes: candidate.changes,
  });
}

export function parseCandidateJobIntent(
  input: string | Uint8Array,
): ValidationResult<CandidateJobIntentV1> {
  const parsed = parseJsonContract<CandidateJobIntentV1>(input, validateCandidate);
  if (!parsed.ok) return parsed;
  if (parsed.value.changes.some((change) => !isSafeProjectRelativePath(change.path))) {
    return invalid("/changes", "relativePath", "candidate paths must be safe and relative");
  }
  const order = parsed.value.changes.map(changeOrder);
  const sorted = [...order].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (!unique(order) || order.some((value, index) => value !== sorted[index])) {
    return invalid("/changes", "order", "candidate changes must be sorted and unique");
  }
  if (candidateJobKey(parsed.value) !== parsed.value.candidate_key) {
    return invalid("/candidate_key", "contentHash", "candidate key must match canonical input");
  }
  return parsed;
}
