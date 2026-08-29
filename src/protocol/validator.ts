import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import agentDefinitionSchema from "../../contracts/runtime/agent-definition.v1.schema.json" with { type: "json" };
import agentRegistryEntrySchema from "../../contracts/runtime/agent-registry-entry.v1.schema.json" with { type: "json" };
import agentgatewayCapabilitiesSchema from "../../contracts/runtime/agentgateway-capabilities.v1.schema.json" with { type: "json" };
import compiledContextSchema from "../../contracts/runtime/compiled-context.v1.schema.json" with { type: "json" };
import modelCatalogSchema from "../../contracts/runtime/model-catalog.v1.schema.json" with { type: "json" };
import modelSelectionPlanSchema from "../../contracts/runtime/model-selection-plan.v1.schema.json" with { type: "json" };
import routingPolicySchema from "../../contracts/runtime/routing-policy.v1.schema.json" with { type: "json" };
import routingStateSchema from "../../contracts/runtime/routing-state.v1.schema.json" with { type: "json" };
import commonSchema from "../../contracts/runtime/runtime-common.v1.schema.json" with { type: "json" };
import executionEventSchema from "../../contracts/runtime/execution-event.v1.schema.json" with { type: "json" };
import executionRequestSchema from "../../contracts/runtime/execution-request.v1.schema.json" with { type: "json" };
import executionResultSchema from "../../contracts/runtime/execution-result.v1.schema.json" with { type: "json" };
import operationalEventSchema from "../../contracts/runtime/operational-event.v1.schema.json" with { type: "json" };
import promptTemplateSchema from "../../contracts/runtime/prompt-template.v1.schema.json" with { type: "json" };
import providerEventSchema from "../../contracts/runtime/provider-event.v1.schema.json" with { type: "json" };
import runJournalEntrySchema from "../../contracts/runtime/run-journal-entry.v1.schema.json" with { type: "json" };
import runtimeCapabilitiesSchema from "../../contracts/runtime/runtime-capabilities.v1.schema.json" with { type: "json" };
import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  type JsonLimits,
  type JsonValue,
} from "./json.js";
import { sensitiveMetadataIssues } from "./metadata.js";
import type {
  RuntimeDocument,
  ValidationFailure,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

const COMMON_SCHEMA_ID = "https://toss.software/schemas/runtime/v1/runtime-common.v1.schema.json";
const ROUTING_POLICY_SCHEMA_ID =
  "https://toss.software/schemas/runtime/v1/routing-policy.v1.schema.json";
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

const REGISTERED_SCHEMAS: Readonly<Record<string, string>> = {
  "agent-definition.v1": "https://toss.software/schemas/runtime/v1/agent-definition.v1.schema.json",
  "agent-registry-entry.v1":
    "https://toss.software/schemas/runtime/v1/agent-registry-entry.v1.schema.json",
  "agentgateway-capabilities.v1":
    "https://toss.software/schemas/runtime/v1/agentgateway-capabilities.v1.schema.json",
  "compiled-context.v1": "https://toss.software/schemas/runtime/v1/compiled-context.v1.schema.json",
  "execution-event.v1": "https://toss.software/schemas/runtime/v1/execution-event.v1.schema.json",
  "execution-request.v1":
    "https://toss.software/schemas/runtime/v1/execution-request.v1.schema.json",
  "execution-result.v1": "https://toss.software/schemas/runtime/v1/execution-result.v1.schema.json",
  "model-catalog.v1": "https://toss.software/schemas/runtime/v1/model-catalog.v1.schema.json",
  "model-selection-plan.v1":
    "https://toss.software/schemas/runtime/v1/model-selection-plan.v1.schema.json",
  "operational-event.v1":
    "https://toss.software/schemas/runtime/v1/operational-event.v1.schema.json",
  "prompt-template.v1": "https://toss.software/schemas/runtime/v1/prompt-template.v1.schema.json",
  "provider-event.v1": "https://toss.software/schemas/runtime/v1/provider-event.v1.schema.json",
  "routing-policy.v1": ROUTING_POLICY_SCHEMA_ID,
  "routing-state.v1": "https://toss.software/schemas/runtime/v1/routing-state.v1.schema.json",
  "run-journal-entry.v1":
    "https://toss.software/schemas/runtime/v1/run-journal-entry.v1.schema.json",
  "runtime-capabilities.v1":
    "https://toss.software/schemas/runtime/v1/runtime-capabilities.v1.schema.json",
};

const FRAGMENTS = {
  "artifact-reference": `${COMMON_SCHEMA_ID}#/$defs/artifact_reference`,
  "runtime-error": `${COMMON_SCHEMA_ID}#/$defs/runtime_error`,
  "trace-context": `${COMMON_SCHEMA_ID}#/$defs/trace_context`,
  "routing-override": `${ROUTING_POLICY_SCHEMA_ID}#/$defs/routing_override`,
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
    limits?: JsonLimits,
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
  ajv.addSchema(agentDefinitionSchema);
  ajv.addSchema(agentRegistryEntrySchema);
  ajv.addSchema(agentgatewayCapabilitiesSchema);
  ajv.addSchema(compiledContextSchema);
  ajv.addSchema(modelCatalogSchema);
  ajv.addSchema(modelSelectionPlanSchema);
  ajv.addSchema(routingPolicySchema);
  ajv.addSchema(routingStateSchema);
  ajv.addSchema(executionEventSchema);
  ajv.addSchema(executionRequestSchema);
  ajv.addSchema(executionResultSchema);
  ajv.addSchema(operationalEventSchema);
  ajv.addSchema(promptTemplateSchema);
  ajv.addSchema(providerEventSchema);
  ajv.addSchema(runJournalEntrySchema);
  ajv.addSchema(runtimeCapabilitiesSchema);

  const fragmentValidators = Object.fromEntries(
    Object.entries(FRAGMENTS).map(([name, schemaReference]) => {
      const validator = ajv.getSchema(schemaReference);
      if (validator === undefined) {
        throw new Error(`Schema fragment is not registered: ${schemaReference}`);
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
      if (name === "runtime-error") {
        const issues = sensitiveMetadataIssues(candidate, "");
        if (issues.length > 0) {
          return { ok: false, code: "RUNTIME_DOCUMENT_INVALID", issues };
        }
      }
      return { ok: true, value: candidate };
    },

    parse<T extends RuntimeDocument>(
      input: string | Uint8Array,
      expectedType: T["document_type"],
      limits?: JsonLimits,
    ): ValidationResult<T> {
      let candidate: JsonValue;
      try {
        candidate = deepFreezeJson(parseJsonBytes(input, limits), limits);
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

      const schemaVersion = candidate.schema_version;
      if (typeof schemaVersion !== "string") {
        return {
          ok: false,
          code: "RUNTIME_DOCUMENT_INVALID",
          issues: [{ path: "/schema_version", keyword: "type", message: "must be string" }],
        };
      }

      const schemaId = REGISTERED_SCHEMAS[schemaVersion];
      if (schemaId === undefined) {
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
      }

      const validate = ajv.getSchema(schemaId);
      if (validate === undefined) {
        throw new Error(`Registered schema is unavailable: ${schemaId}`);
      }
      if (!validate(candidate)) {
        return {
          ok: false,
          code: "RUNTIME_DOCUMENT_INVALID",
          issues: normalizeIssues(validate.errors),
        };
      }

      return { ok: true, value: candidate as unknown as T };
    },
  };
}
