import Ajv2020Module, { type ErrorObject } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import operationalEventSchema from "../../contracts/runtime/operational-event.v1.schema.json" with { type: "json" };
import { canonicalJson, deepFreezeJson, parseJsonBytes, type JsonValue } from "../protocol/json.js";
import { sensitiveMetadataIssues } from "../protocol/metadata.js";
import type { ValidationFailure, ValidationIssue, ValidationResult } from "../protocol/types.js";
import { RuntimeLoggingError } from "./errors.js";
import type {
  OperationalEventInput,
  OperationalEventV1,
  OperationalMetadata,
  SensitiveOperationalValue,
} from "./types.js";

const MAX_OPERATIONAL_EVENT_BYTES = 65_536;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const METADATA_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const FORBIDDEN_METADATA_FRAGMENTS = [
  "argument",
  "args",
  "argv",
  "command",
  "credential",
  "environment",
  "env",
  "mcp",
  "mcppayload",
  "output",
  "payload",
  "password",
  "privatekey",
  "prompt",
  "provider",
  "providerpayload",
  "secret",
  "token",
  "tooloutput",
] as const;

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
const validateOperationalEvent = ajv.compile(operationalEventSchema);

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
  path = "",
  keyword = "semantic",
  message = "operational event is invalid",
): ValidationFailure {
  return { ok: false, code: "RUNTIME_DOCUMENT_INVALID", issues: [{ path, keyword, message }] };
}

function canonicalUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new RuntimeLoggingError("RUNTIME_LOGGING_INVALID");
  return value;
}

function canonicalTimestamp(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new RuntimeLoggingError("RUNTIME_LOGGING_INVALID");
  return value.toISOString();
}

function compactKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

function safeMetadataKey(key: string): boolean {
  if (!METADATA_KEY_PATTERN.test(key)) return false;
  const compact = compactKey(key);
  return !FORBIDDEN_METADATA_FRAGMENTS.some((fragment) => compact.includes(fragment));
}

function isSensitiveValue(value: unknown): value is SensitiveOperationalValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "sensitivity" in value &&
    value.sensitivity === "secret"
  );
}

export function sensitiveOperationalValue(value: unknown): SensitiveOperationalValue {
  return Object.freeze({ sensitivity: "secret", value });
}

export function sanitizeOperationalMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  allowedKeys: readonly string[] | undefined,
): OperationalMetadata {
  if (metadata === undefined || allowedKeys === undefined || allowedKeys.length === 0) {
    return Object.freeze({});
  }
  const allowed = new Set(allowedKeys.filter(safeMetadataKey));
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const key of [...Object.keys(metadata)].sort()) {
    if (!allowed.has(key) || !safeMetadataKey(key)) continue;
    const value = metadata[key];
    if (isSensitiveValue(value)) continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      sanitized[key] = value;
    }
  }
  return Object.freeze(sanitized);
}

export function createOperationalEvent(options: {
  readonly eventId: string;
  readonly timestamp: Date;
  readonly serviceInstanceId: string;
  readonly serviceSequence: number;
  readonly input: OperationalEventInput;
}): OperationalEventV1 {
  if (!Number.isSafeInteger(options.serviceSequence) || options.serviceSequence < 1) {
    throw new RuntimeLoggingError("RUNTIME_LOGGING_INVALID");
  }
  const document = {
    protocol_version: "runtime-contract.v1",
    schema_version: "operational-event.v1",
    document_type: "operational-event",
    event_id: canonicalUuid(options.eventId),
    timestamp: canonicalTimestamp(options.timestamp),
    service_instance_id: canonicalUuid(options.serviceInstanceId),
    service_sequence: options.serviceSequence,
    level: options.input.level,
    component: options.input.component,
    event: options.input.event,
    correlation_id: canonicalUuid(options.input.correlationId),
    ...(options.input.projectId === undefined
      ? {}
      : { project_id: canonicalUuid(options.input.projectId) }),
    ...(options.input.jobId === undefined ? {} : { job_id: canonicalUuid(options.input.jobId) }),
    ...(options.input.runId === undefined ? {} : { run_id: canonicalUuid(options.input.runId) }),
    metadata: sanitizeOperationalMetadata(
      options.input.metadata,
      options.input.allowedMetadataKeys,
    ),
  } as const;
  const parsed = parseOperationalEvent(canonicalJson(document));
  if (!parsed.ok) throw new RuntimeLoggingError("RUNTIME_LOGGING_INVALID");
  return parsed.value;
}

export function parseOperationalEvent(
  input: string | Uint8Array,
): ValidationResult<OperationalEventV1> {
  let candidate: JsonValue;
  try {
    candidate = deepFreezeJson(
      parseJsonBytes(input, {
        maxBytes: MAX_OPERATIONAL_EVENT_BYTES,
        maxDepth: 8,
        maxMembers: 128,
      }),
    );
  } catch {
    return invalid("", "json", "invalid operational event JSON");
  }
  if (!validateOperationalEvent(candidate)) {
    return {
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: normalizeIssues(validateOperationalEvent.errors),
    };
  }
  const event = candidate as unknown as OperationalEventV1;
  for (const [field, value] of [
    ["event_id", event.event_id],
    ["service_instance_id", event.service_instance_id],
    ["correlation_id", event.correlation_id],
    ["project_id", event.project_id],
    ["job_id", event.job_id],
    ["run_id", event.run_id],
  ] as const) {
    if (value !== undefined && !UUID_PATTERN.test(value)) {
      return invalid(`/${field}`, "canonicalUuid", "UUID must be canonical lowercase");
    }
  }
  if (new Date(event.timestamp).toISOString() !== event.timestamp) {
    return invalid("/timestamp", "canonicalTimestamp", "timestamp must be canonical UTC");
  }
  const sensitiveIssues = sensitiveMetadataIssues(event.metadata, "/metadata");
  if (sensitiveIssues.length > 0) {
    return { ok: false, code: "RUNTIME_DOCUMENT_INVALID", issues: sensitiveIssues };
  }
  return { ok: true, value: event };
}
