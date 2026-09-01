import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import { ProtocolJsonError } from "../protocol/errors.js";
import {
  canonicalJson,
  parseJsonBytes,
  sha256,
  type JsonLimits,
  type JsonValue,
} from "../protocol/json.js";
import type { ValidationFailure, ValidationIssue, ValidationResult } from "../protocol/types.js";
import { createProtocolValidator } from "../protocol/validator.js";
import {
  TOOL_HARD_LIMITS,
  type HashableMcpProfileV1,
  type McpProfileToolRuleV1,
  type McpProfileV1,
} from "./types.js";

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;
const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const PROFILE_DOCUMENT_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxDepth: 64,
  maxMembers: 250_000,
});
const MAX_SCHEMA_DEPTH = 32;
const SECRET_FIELD =
  /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|private[_-]?key|bearer)/iu;
const VALIDATOR = createProtocolValidator();

type JsonRecord = { readonly [key: string]: JsonValue };

function isRecord(value: JsonValue): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function issue(path: string, keyword: string, message: string): ValidationIssue {
  return { path, keyword, message };
}

function issueKey(value: ValidationIssue): string {
  return `${value.path}\u0000${value.keyword}\u0000${value.message}`;
}

function failure(issues: readonly ValidationIssue[]): ValidationFailure {
  return {
    ok: false,
    code: "RUNTIME_DOCUMENT_INVALID",
    issues: [...issues].sort((left, right) => issueKey(left).localeCompare(issueKey(right))),
  };
}

function parseFailure(error: unknown): ValidationFailure {
  if (error instanceof ProtocolJsonError) {
    if (error.message.startsWith("JSON byte limit exceeded:")) {
      return failure([issue("", "maxBytes", "MCP profile exceeds its byte limit")]);
    }
    if (error.message.startsWith("JSON member limit exceeded:")) {
      return failure([issue("", "maxMembers", "MCP profile exceeds its member limit")]);
    }
  }
  return failure([issue("", "json", "MCP profile JSON is invalid")]);
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function orderedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || bytewiseCompare(values[index - 1]!, value) < 0,
  );
}

function artifactKey(reference: {
  readonly document_type: string;
  readonly artifact_id: string;
  readonly revision: number;
  readonly hash: string;
}): string {
  return [
    reference.document_type,
    reference.artifact_id,
    String(reference.revision).padStart(16, "0"),
    reference.hash,
  ].join("\u0000");
}

function canonicalHash(value: unknown): `sha256:${string}` {
  const normalized = parseJsonBytes(
    canonicalJson(value, PROFILE_DOCUMENT_LIMITS),
    PROFILE_DOCUMENT_LIMITS,
  );
  if (!isRecord(normalized)) throw new TypeError("MCP profile is not an object");
  const hashable: Record<string, JsonValue> = { ...normalized };
  delete hashable.document_hash;
  return sha256(hashable, PROFILE_DOCUMENT_LIMITS);
}

function jsonDepth(value: JsonValue, depth = 0): number {
  if (typeof value !== "object" || value === null) return depth;
  const children = isJsonArray(value) ? value : Object.values(value);
  return children.reduce<number>(
    (maximum, child) => Math.max(maximum, jsonDepth(child, depth + 1)),
    depth,
  );
}

function decodePointerToken(token: string): string | undefined {
  if (/~(?![01])/u.test(token)) return undefined;
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveJsonPointer(root: JsonValue, reference: string): JsonValue | undefined {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  let current: JsonValue = root;
  for (const encoded of reference.slice(2).split("/")) {
    const token = decodePointerToken(encoded);
    if (token === undefined || !isRecord(current) || !Object.hasOwn(current, token)) {
      return undefined;
    }
    current = current[token]!;
  }
  return current;
}

function inspectSchemaReferences(root: JsonValue, basePath: string): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const walk = (value: JsonValue, path: string, activeReferences: ReadonlySet<string>): void => {
    if (isJsonArray(value)) {
      value.forEach((child, index) => walk(child, `${path}/${index}`, activeReferences));
      return;
    }
    if (!isRecord(value)) return;

    for (const prohibited of ["$dynamicRef", "$recursiveRef"] as const) {
      if (Object.hasOwn(value, prohibited)) {
        issues.push(
          issue(`${path}/${prohibited}`, "schemaReference", "dynamic schema references are denied"),
        );
      }
    }

    const reference = value.$ref;
    if (typeof reference === "string") {
      if (!reference.startsWith("#")) {
        issues.push(
          issue(`${path}/$ref`, "schemaReference", "remote schema references are denied"),
        );
      } else {
        const target = resolveJsonPointer(root, reference);
        if (target === undefined) {
          issues.push(
            issue(`${path}/$ref`, "schemaReference", "local schema reference is unresolved"),
          );
        } else if (activeReferences.has(reference)) {
          issues.push(
            issue(`${path}/$ref`, "schemaReference", "cyclic schema references are denied"),
          );
        } else {
          walk(target, `${path}/$ref`, new Set([...activeReferences, reference]));
        }
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== "$ref") walk(child, `${path}/${key}`, activeReferences);
    }
  };

  walk(root, basePath, new Set());
  return issues;
}

function inspectSecretFields(schema: JsonValue, basePath: string): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const walk = (value: JsonValue, path: string): void => {
    if (isJsonArray(value)) {
      value.forEach((child, index) => walk(child, `${path}/${index}`));
      return;
    }
    if (!isRecord(value)) return;

    const schemaProperties: JsonValue | undefined = value.properties;
    if (schemaProperties !== undefined && isRecord(schemaProperties)) {
      for (const [name, child] of Object.entries(schemaProperties)) {
        if (SECRET_FIELD.test(name)) {
          issues.push(
            issue(
              `${path}/properties/${name}`,
              "secretField",
              "secret-shaped tool inputs are denied",
            ),
          );
        }
        walk(child, `${path}/properties/${name}`);
      }
    }
    const requiredProperties: JsonValue | undefined = value.required;
    if (requiredProperties !== undefined && isJsonArray(requiredProperties)) {
      for (const [index, required] of requiredProperties.entries()) {
        if (typeof required === "string" && SECRET_FIELD.test(required)) {
          issues.push(
            issue(
              `${path}/required/${index}`,
              "secretField",
              "secret-shaped tool inputs are denied",
            ),
          );
        }
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== "properties" && key !== "required") walk(child, `${path}/${key}`);
    }
  };

  walk(schema, basePath);
  return issues;
}

function instancePointerExists(schema: JsonValue, pointer: string): boolean {
  if (!isRecord(schema) || !pointer.startsWith("/")) return false;
  let current: JsonValue = schema;
  for (const encoded of pointer.slice(1).split("/")) {
    const token = decodePointerToken(encoded);
    if (token === undefined || !isRecord(current)) return false;
    const properties: JsonValue | undefined = current.properties;
    if (properties === undefined || !isRecord(properties) || !Object.hasOwn(properties, token)) {
      return false;
    }
    current = properties[token]!;
  }
  return true;
}

function embeddedSchemaIssues(
  schema: JsonValue,
  path: string,
  byteLimit: number,
  inspectSecrets: boolean,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(schema)) return [issue(path, "schema", "tool schema must be an object")];

  let bytes: number;
  try {
    bytes = Buffer.byteLength(canonicalJson(schema, PROFILE_DOCUMENT_LIMITS), "utf8");
  } catch {
    return [issue(path, "schema", "tool schema is not canonical JSON")];
  }
  if (bytes > Math.min(byteLimit, TOOL_HARD_LIMITS.schemaBytes)) {
    issues.push(issue(path, "maxBytes", "tool schema exceeds its configured byte limit"));
  }
  if (jsonDepth(schema) > MAX_SCHEMA_DEPTH) {
    issues.push(issue(path, "maxDepth", "tool schema exceeds its nesting limit"));
  }
  if (schema.$schema !== JSON_SCHEMA_2020_12) {
    issues.push(
      issue(`${path}/$schema`, "schemaDialect", "tool schema must declare JSON Schema 2020-12"),
    );
  }
  issues.push(...inspectSchemaReferences(schema, path));
  if (inspectSecrets) issues.push(...inspectSecretFields(schema, path));

  try {
    const ajv = new Ajv2020({
      allErrors: true,
      allowUnionTypes: false,
      coerceTypes: false,
      removeAdditional: false,
      strict: true,
      useDefaults: false,
    });
    addFormats(ajv);
    ajv.compile(schema);
  } catch {
    issues.push(issue(path, "schema", "tool schema is not a valid self-contained schema"));
  }
  return issues;
}

function toolIssues(
  tool: McpProfileToolRuleV1,
  path: string,
  schemaByteLimit: number,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sets: readonly [string, readonly string[]][] = [
    [`${path}/allowed_roles`, tool.allowed_roles],
    [`${path}/task_contracts`, tool.task_contracts.map(artifactKey)],
    [`${path}/content_kinds`, tool.content_kinds],
    [`${path}/sensitive_output_pointers`, tool.sensitive_output_pointers],
  ];
  for (const [setPath, values] of sets) {
    if (!orderedUnique(values)) {
      issues.push(issue(setPath, "order", "set must be bytewise sorted and unique"));
    }
  }

  if (
    (tool.operation_class === "read-only" && tool.approval !== "not-required") ||
    (tool.operation_class === "irreversible" && tool.approval !== "required")
  ) {
    issues.push(
      issue(`${path}/approval`, "policy", "approval rule conflicts with the operation class"),
    );
  }

  issues.push(
    ...embeddedSchemaIssues(tool.input_schema, `${path}/input_schema`, schemaByteLimit, true),
  );
  try {
    if (tool.input_schema_hash !== sha256(tool.input_schema, PROFILE_DOCUMENT_LIMITS)) {
      issues.push(
        issue(
          `${path}/input_schema_hash`,
          "canonicalHash",
          "input schema hash does not match canonical content",
        ),
      );
    }
  } catch {
    issues.push(
      issue(`${path}/input_schema_hash`, "canonicalHash", "input schema hash is invalid"),
    );
  }

  if (tool.output_schema === null) {
    if (tool.output_schema_hash !== null) {
      issues.push(
        issue(
          `${path}/output_schema_hash`,
          "presence",
          "absent output schema requires a null hash",
        ),
      );
    }
  } else {
    issues.push(
      ...embeddedSchemaIssues(tool.output_schema, `${path}/output_schema`, schemaByteLimit, false),
    );
    try {
      if (tool.output_schema_hash !== sha256(tool.output_schema, PROFILE_DOCUMENT_LIMITS)) {
        issues.push(
          issue(
            `${path}/output_schema_hash`,
            "canonicalHash",
            "output schema hash does not match canonical content",
          ),
        );
      }
    } catch {
      issues.push(
        issue(`${path}/output_schema_hash`, "canonicalHash", "output schema hash is invalid"),
      );
    }
  }
  return issues;
}

function profileIssues(value: McpProfileV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const serverIds = value.servers.map((server) => server.server_id);
  const bindingNames = value.servers.map((server) => server.binding_name);
  if (!orderedUnique(serverIds)) {
    issues.push(issue("/servers", "order", "server IDs must be bytewise sorted and unique"));
  }
  if (new Set(bindingNames).size !== bindingNames.length) {
    issues.push(issue("/servers", "uniqueBinding", "server binding names must be unique"));
  }

  const aliases = new Set<string>();
  for (const [serverIndex, server] of value.servers.entries()) {
    const serverPath = `/servers/${serverIndex}`;
    const toolAliases = server.tools.map((tool) => tool.alias);
    const nativeNames = server.tools.map((tool) => tool.native_name);
    if (!orderedUnique(toolAliases)) {
      issues.push(
        issue(`${serverPath}/tools`, "order", "tool aliases must be bytewise sorted and unique"),
      );
    }
    if (new Set(nativeNames).size !== nativeNames.length) {
      issues.push(
        issue(`${serverPath}/tools`, "uniqueNativeName", "native tool names must be unique"),
      );
    }
    if (server.tools.length > value.limits.tools_per_server) {
      issues.push(
        issue(`${serverPath}/tools`, "profileLimit", "tool count exceeds the profile limit"),
      );
    }
    if (server.protocol_revision === "2025-06-18" && Object.keys(server.x_mcp_headers).length > 0) {
      issues.push(
        issue(
          `${serverPath}/x_mcp_headers`,
          "protocol",
          "2025 protocol forbids MCP header mappings",
        ),
      );
    }
    for (const [header, pointer] of Object.entries(server.x_mcp_headers)) {
      if (SECRET_FIELD.test(pointer) || SECRET_FIELD.test(header)) {
        issues.push(
          issue(
            `${serverPath}/x_mcp_headers/${header}`,
            "secretField",
            "secret header mappings are denied",
          ),
        );
      }
      if (!server.tools.every((tool) => instancePointerExists(tool.input_schema, pointer))) {
        issues.push(
          issue(
            `${serverPath}/x_mcp_headers/${header}`,
            "schemaPointer",
            "header mapping must name an input property on every server tool",
          ),
        );
      }
    }

    for (const [toolIndex, tool] of server.tools.entries()) {
      if (aliases.has(tool.alias)) {
        issues.push(issue("/servers", "uniqueAlias", "tool aliases must be globally unique"));
      }
      aliases.add(tool.alias);
      issues.push(
        ...toolIssues(tool, `${serverPath}/tools/${toolIndex}`, value.limits.schema_bytes),
      );
    }
  }

  if (value.limits.content_block_bytes > value.limits.result_bytes) {
    issues.push(
      issue("/limits/content_block_bytes", "coherence", "content block limit exceeds result limit"),
    );
  }
  if (value.limits.structured_output_bytes > value.limits.result_bytes) {
    issues.push(
      issue(
        "/limits/structured_output_bytes",
        "coherence",
        "structured output limit exceeds result limit",
      ),
    );
  }
  if (value.limits.discovery_timeout_ms > value.limits.session_lifetime_ms) {
    issues.push(
      issue(
        "/limits/discovery_timeout_ms",
        "coherence",
        "discovery timeout exceeds session lifetime",
      ),
    );
  }
  if (value.limits.call_timeout_ms > value.limits.session_lifetime_ms) {
    issues.push(
      issue("/limits/call_timeout_ms", "coherence", "call timeout exceeds session lifetime"),
    );
  }

  try {
    if (value.document_hash !== hashMcpProfile(value)) {
      issues.push(
        issue("/document_hash", "canonicalHash", "document hash does not match canonical content"),
      );
    }
  } catch {
    issues.push(issue("/document_hash", "canonicalHash", "document hash is invalid"));
  }
  return issues;
}

export function hashMcpProfile(value: HashableMcpProfileV1 | McpProfileV1): `sha256:${string}` {
  return canonicalHash(value);
}

export function parseMcpProfile(input: string | Uint8Array): ValidationResult<McpProfileV1> {
  let parsed: ValidationResult<McpProfileV1>;
  try {
    parsed = VALIDATOR.parse<McpProfileV1>(input, "mcp-profile", PROFILE_DOCUMENT_LIMITS);
  } catch (error) {
    return parseFailure(error);
  }
  if (!parsed.ok) return parsed;

  try {
    const issues = profileIssues(parsed.value);
    return issues.length === 0 ? parsed : failure(issues);
  } catch {
    return failure([issue("", "semantic", "MCP profile semantics are invalid")]);
  }
}

export type { HashableMcpProfileV1, McpProfileV1 };
