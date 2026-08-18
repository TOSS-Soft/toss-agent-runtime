import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import commonSchema from "../../contracts/runtime/runtime-common.v1.schema.json" with { type: "json" };
import { canonicalJson, deepFreezeJson, parseJsonBytes, type JsonValue } from "./json.js";
import type {
  RuntimeDocument,
  ValidationFailure,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

const COMMON_SCHEMA_ID = "https://toss.software/schemas/runtime/v1/runtime-common.v1.schema.json";
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

const FRAGMENTS = {
  "artifact-reference": "artifact_reference",
  "runtime-error": "runtime_error",
  "trace-context": "trace_context",
} as const;

export type FragmentName = keyof typeof FRAGMENTS;

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function jsonFailure(error: unknown): ValidationFailure {
  const message = error instanceof Error ? error.message : "Invalid JSON value";
  return {
    ok: false,
    code: "RUNTIME_DOCUMENT_INVALID",
    issues: [{ path: "", keyword: "json", message }],
  };
}

function cloneAndFreeze(value: unknown): JsonValue {
  return deepFreezeJson(parseJsonBytes(canonicalJson(value)));
}

export interface ProtocolValidator {
  validateFragment(name: FragmentName, value: unknown): ValidationResult<JsonValue>;
  parse<T extends RuntimeDocument>(
    input: string | Uint8Array,
    expectedType: T["document_type"],
  ): ValidationResult<T>;
}

export function createProtocolValidator(): ProtocolValidator {
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

  const fragmentValidators = Object.fromEntries(
    Object.entries(FRAGMENTS).map(([name, definition]) => {
      const validator = ajv.getSchema(`${COMMON_SCHEMA_ID}#/$defs/${definition}`);
      if (validator === undefined) {
        throw new Error(`Common schema fragment is not registered: ${definition}`);
      }
      return [name, validator];
    }),
  ) as Record<FragmentName, ValidateFunction>;

  return {
    validateFragment(name, value) {
      let candidate: JsonValue;
      try {
        candidate = cloneAndFreeze(value);
      } catch (error) {
        return jsonFailure(error);
      }

      const validate = fragmentValidators[name];
      if (!validate(candidate)) {
        return {
          ok: false,
          code: "RUNTIME_DOCUMENT_INVALID",
          issues: normalizeIssues(validate.errors),
        };
      }
      return { ok: true, value: candidate };
    },

    parse(input, expectedType) {
      let candidate: JsonValue;
      try {
        candidate = deepFreezeJson(parseJsonBytes(input));
      } catch (error) {
        return jsonFailure(error);
      }

      if (!isJsonObject(candidate) || candidate.document_type !== expectedType) {
        return {
          ok: false,
          code: "RUNTIME_DOCUMENT_INVALID",
          issues: [
            {
              path: "/document_type",
              keyword: "const",
              message: `must equal ${JSON.stringify(expectedType)}`,
            },
          ],
        };
      }

      return {
        ok: false,
        code: "RUNTIME_DOCUMENT_UNSUPPORTED",
        issues: [
          {
            path: "/schema_version",
            keyword: "supported",
            message: "schema version is not registered",
          },
        ],
      };
    },
  };
}
