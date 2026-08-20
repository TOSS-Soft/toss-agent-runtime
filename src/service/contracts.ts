import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import lockSchema from "../../contracts/runtime/service-lock.v1.schema.json" with { type: "json" };
import requestSchema from "../../contracts/runtime/service-control-request.v1.schema.json" with { type: "json" };
import responseSchema from "../../contracts/runtime/service-control-response.v1.schema.json" with { type: "json" };
import { deepFreezeJson, parseJsonBytes, type JsonValue } from "../protocol/json.js";
import { sensitiveMetadataIssues } from "../protocol/metadata.js";
import type {
  RuntimeError,
  ValidationFailure,
  ValidationIssue,
  ValidationResult,
} from "../protocol/types.js";

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

const SERVICE_SCHEMAS = {
  lock: lockSchema,
  request: requestSchema,
  response: responseSchema,
} as const;

export const MAX_CONTROL_MESSAGE_BYTES = 65_536;

export interface ServiceLockV1 {
  readonly schema_version: "service-lock.v1";
  readonly document_type: "service-lock";
  readonly service_instance_id: string;
  readonly pid: number;
  readonly executable_hash: string;
  readonly created_at: string;
}

export interface ServiceControlRequestV1 {
  readonly schema_version: "service-control-request.v1";
  readonly document_type: "service-control-request";
  readonly request_id: string;
  readonly command: "status";
}

export interface ServiceStatusV1 {
  readonly package_version: string;
  readonly service_instance_id: string;
  readonly pid: number;
  readonly started_at: string;
  readonly health: "healthy" | "degraded" | "stopping";
  readonly accepting: boolean;
}

export interface ServiceControlResponseV1 {
  readonly schema_version: "service-control-response.v1";
  readonly document_type: "service-control-response";
  readonly request_id: string | null;
  readonly ok: boolean;
  readonly status: ServiceStatusV1 | null;
  readonly error: RuntimeError | null;
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issueOrder(issue: ValidationIssue): string {
  return `${issue.path}\u0000${issue.keyword}\u0000${issue.message}`;
}

function normalizeIssues(
  errors: readonly ErrorObject[] | null | undefined,
): readonly ValidationIssue[] {
  return (errors ?? [])
    .map((error) => ({
      path: error.instancePath,
      keyword: error.keyword,
      message: error.message ?? "invalid value",
    }))
    .sort((left, right) => issueOrder(left).localeCompare(issueOrder(right)));
}

function invalidJsonFailure(): ValidationFailure {
  return {
    ok: false,
    code: "RUNTIME_DOCUMENT_INVALID",
    issues: [{ path: "", keyword: "json", message: "invalid JSON input" }],
  };
}

function createValidators(): Readonly<Record<keyof typeof SERVICE_SCHEMAS, ValidateFunction>> {
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: false,
    coerceTypes: false,
    removeAdditional: false,
    strict: true,
    useDefaults: false,
  });
  addFormats(ajv);

  return Object.fromEntries(
    Object.entries(SERVICE_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]),
  ) as Record<keyof typeof SERVICE_SCHEMAS, ValidateFunction>;
}

const validators = createValidators();

function parseServiceDocument<T>(
  input: string | Uint8Array,
  validator: ValidateFunction,
  inspectSensitiveMetadata: boolean,
): ValidationResult<T> {
  let candidate: JsonValue;
  try {
    candidate = deepFreezeJson(
      parseJsonBytes(input, { maxBytes: MAX_CONTROL_MESSAGE_BYTES, maxDepth: 16, maxMembers: 64 }),
    );
  } catch {
    return invalidJsonFailure();
  }

  if (inspectSensitiveMetadata) {
    const issues = sensitiveMetadataIssues(candidate, "");
    if (issues.length > 0) {
      return { ok: false, code: "RUNTIME_DOCUMENT_INVALID", issues };
    }
  }

  const valid = validator(candidate);
  if (!isJsonObject(candidate) || !valid) {
    return {
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: normalizeIssues(validator.errors),
    };
  }

  return { ok: true, value: candidate as unknown as T };
}

export function parseServiceLock(input: string | Uint8Array): ValidationResult<ServiceLockV1> {
  return parseServiceDocument<ServiceLockV1>(input, validators.lock, false);
}

export function parseServiceControlRequest(
  input: string | Uint8Array,
): ValidationResult<ServiceControlRequestV1> {
  return parseServiceDocument<ServiceControlRequestV1>(input, validators.request, true);
}

export function parseServiceControlResponse(
  input: string | Uint8Array,
): ValidationResult<ServiceControlResponseV1> {
  return parseServiceDocument<ServiceControlResponseV1>(input, validators.response, true);
}
