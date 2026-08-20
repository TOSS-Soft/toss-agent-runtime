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
import { MAX_PROJECT_ROOT_BYTES, type ProjectRegistration } from "./project/types.js";

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

interface ServiceControlRequestBaseV1 {
  readonly schema_version: "service-control-request.v1";
  readonly document_type: "service-control-request";
  readonly request_id: string;
}

export interface ServiceStatusRequestV1 extends ServiceControlRequestBaseV1 {
  readonly command: "status";
}

export interface ServiceProjectRegisterRequestV1 extends ServiceControlRequestBaseV1 {
  readonly command: "project-register";
  readonly operation_id: string;
  readonly root: string;
}

export interface ServiceProjectUnregisterRequestV1 extends ServiceControlRequestBaseV1 {
  readonly command: "project-unregister";
  readonly operation_id: string;
  readonly project_id: string;
}

export interface ServiceProjectListRequestV1 extends ServiceControlRequestBaseV1 {
  readonly command: "project-list";
}

export type ServiceProjectRequestV1 =
  ServiceProjectRegisterRequestV1 | ServiceProjectUnregisterRequestV1 | ServiceProjectListRequestV1;

export type ServiceControlRequestV1 = ServiceStatusRequestV1 | ServiceProjectRequestV1;

export interface ServiceStatusV1 {
  readonly package_version: string;
  readonly service_instance_id: string;
  readonly pid: number;
  readonly started_at: string;
  readonly health: "healthy" | "degraded" | "stopping";
  readonly accepting: boolean;
}

export type ServiceProjectDataV1 =
  | {
      readonly kind: "project-registration";
      readonly registration: ProjectRegistration;
    }
  | {
      readonly kind: "project-list";
      readonly registrations: readonly ProjectRegistration[];
    };

export interface ServiceControlResponseV1 {
  readonly schema_version: "service-control-response.v1";
  readonly document_type: "service-control-response";
  readonly request_id: string | null;
  readonly ok: boolean;
  readonly status: ServiceStatusV1 | null;
  readonly data: ServiceProjectDataV1 | null;
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
  maxMembers = 64,
): ValidationResult<T> {
  let candidate: JsonValue;
  try {
    candidate = deepFreezeJson(
      parseJsonBytes(input, {
        maxBytes: MAX_CONTROL_MESSAGE_BYTES,
        maxDepth: 16,
        maxMembers,
      }),
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
  const parsed = parseServiceDocument<ServiceControlRequestV1>(input, validators.request, true);
  if (!parsed.ok) return parsed;
  if (
    parsed.value.command === "project-register" &&
    (!path.isAbsolute(parsed.value.root) ||
      path.normalize(parsed.value.root) !== parsed.value.root ||
      Buffer.byteLength(parsed.value.root, "utf8") > MAX_PROJECT_ROOT_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(parsed.value.root))
  ) {
    return {
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: [{ path: "/root", keyword: "absolutePath", message: "root must be absolute" }],
    };
  }
  return parsed;
}

export function parseServiceControlResponse(
  input: string | Uint8Array,
): ValidationResult<ServiceControlResponseV1> {
  const parsed = parseServiceDocument<ServiceControlResponseV1>(
    input,
    validators.response,
    true,
    10_000,
  );
  if (!parsed.ok) return parsed;
  const registrations =
    parsed.value.data?.kind === "project-registration"
      ? [parsed.value.data.registration]
      : (parsed.value.data?.registrations ?? []);
  if (
    registrations.some(
      (registration) =>
        !path.isAbsolute(registration.canonical_root) ||
        path.normalize(registration.canonical_root) !== registration.canonical_root ||
        Buffer.byteLength(registration.canonical_root, "utf8") > MAX_PROJECT_ROOT_BYTES ||
        /[\u0000-\u001f\u007f]/u.test(registration.canonical_root),
    )
  ) {
    return {
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
      issues: [
        {
          path: "/data",
          keyword: "absolutePath",
          message: "project roots must be absolute",
        },
      ],
    };
  }
  if (parsed.value.data?.kind === "project-list") {
    const ids = registrations.map((registration) => registration.project_id);
    const sorted = [...ids].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    if (new Set(ids).size !== ids.length || ids.some((value, index) => value !== sorted[index])) {
      return {
        ok: false,
        code: "RUNTIME_DOCUMENT_INVALID",
        issues: [{ path: "/data/registrations", keyword: "order", message: "invalid order" }],
      };
    }
  }
  return parsed;
}
import path from "node:path";
