import Ajv2020Module, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import { ProtocolJsonError } from "../protocol/errors.js";
import {
  canonicalJson,
  deepFreezeJson,
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
import {
  TOOL_HARD_LIMITS,
  type HashableMcpDiscoverySnapshotV1,
  type HashableMcpProfileV1,
  type HashableToolApprovalV1,
  type HashableToolCallV1,
  type HashableToolResultV1,
  type McpDiscoverySnapshotV1,
  type McpProfileToolRuleV1,
  type McpProfileV1,
  type ToolApprovalV1,
  type ToolCallV1,
  type ToolResultContentV1,
  type ToolResultV1,
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
const TOOL_DOCUMENT_LIMITS: JsonLimits = Object.freeze({
  maxBytes: TOOL_HARD_LIMITS.resultBytes,
  maxDepth: 64,
  maxMembers: 250_000,
});
const SECRET_FIELD =
  /(?:authorization|api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|private[_-]?key|bearer)/iu;
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

function documentHashIssue(
  value: { readonly document_hash: `sha256:${string}` },
  expected: `sha256:${string}`,
): ValidationIssue | undefined {
  return value.document_hash === expected
    ? undefined
    : issue("/document_hash", "canonicalHash", "document hash does not match canonical content");
}

function parseToolDocument<
  T extends RuntimeDocument & { readonly document_hash: `sha256:${string}` },
>(
  input: string | Uint8Array,
  documentType: string,
  semanticIssues: (value: T) => readonly ValidationIssue[],
): ValidationResult<T> {
  const parsed = VALIDATOR.parse<T>(input, documentType, TOOL_DOCUMENT_LIMITS);
  if (!parsed.ok) return parsed;
  try {
    const issues = semanticIssues(parsed.value);
    return issues.length === 0 ? { ok: true, value: parsed.value } : failure(issues);
  } catch {
    return failure([issue("", "semantic", "tool document semantics are invalid")]);
  }
}

function discoveryIssues(value: McpDiscoverySnapshotV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const created = Date.parse(value.created_at);
  const expires = Date.parse(value.expires_at);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || created >= expires) {
    issues.push(issue("/expires_at", "timeOrder", "discovery expiry must follow creation"));
  }
  if (!orderedUnique(value.servers.map((server) => server.server_id))) {
    issues.push(
      issue("/servers", "order", "discovered servers must be bytewise sorted and unique"),
    );
  }
  const aliases = new Set<string>();
  for (const [serverIndex, server] of value.servers.entries()) {
    if (!orderedUnique(server.tools.map((tool) => tool.alias))) {
      issues.push(
        issue(
          `/servers/${serverIndex}/tools`,
          "order",
          "discovered aliases must be bytewise sorted and unique",
        ),
      );
    }
    for (const tool of server.tools) {
      if (aliases.has(tool.alias)) {
        issues.push(issue("/servers", "uniqueAlias", "discovered aliases must be globally unique"));
      }
      aliases.add(tool.alias);
    }
  }
  const mismatch = documentHashIssue(value, hashMcpDiscoverySnapshot(value));
  if (mismatch !== undefined) issues.push(mismatch);
  return issues;
}

function approvalIssues(value: ToolApprovalV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (value.kind === "REQUEST") {
    if (Buffer.byteLength(value.summary, "utf8") > TOOL_HARD_LIMITS.approvalSummaryBytes) {
      issues.push(issue("/summary", "maxBytes", "approval summary exceeds its byte limit"));
    }
    if (value.operation_class === "read-only") {
      issues.push(issue("/operation_class", "policy", "read-only tools cannot request approval"));
    }
  }
  const mismatch = documentHashIssue(value, hashToolApproval(value));
  if (mismatch !== undefined) issues.push(mismatch);
  return issues;
}

function callIssues(value: ToolCallV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if ((value.call_revision === 1) !== (value.previous_call_hash === null)) {
    issues.push(
      issue(
        "/previous_call_hash",
        "hashChain",
        "first call revision has no predecessor and later revisions require one",
      ),
    );
  }
  if (value.logical_input_hash !== sha256(value.logical_arguments, TOOL_DOCUMENT_LIMITS)) {
    issues.push(
      issue("/logical_input_hash", "canonicalHash", "logical input hash does not match arguments"),
    );
  }
  if (value.operation_class === "irreversible" && value.approval_request_hash === null) {
    issues.push(
      issue("/approval_request_hash", "approval", "irreversible calls require an approval request"),
    );
  }

  const prepared =
    value.stage === "PREPARED" &&
    value.dispatch_state === "NOT_SENT" &&
    value.terminal_at === null &&
    value.result_hash === null &&
    value.terminal_code === null;
  const completed =
    value.stage === "COMPLETED" &&
    value.dispatch_state === "RESULT_RECEIVED" &&
    value.terminal_at !== null &&
    value.result_hash !== null &&
    value.terminal_code === null;
  const failed =
    value.stage === "FAILED" &&
    value.dispatch_state === "NOT_SENT" &&
    value.terminal_at !== null &&
    value.result_hash !== null &&
    value.terminal_code !== null;
  const uncertain =
    value.stage === "UNCERTAIN" &&
    value.dispatch_state === "MAYBE_SENT" &&
    value.terminal_at !== null &&
    value.result_hash === null &&
    value.terminal_code === "RUNTIME_TOOL_EFFECT_UNCERTAIN";
  if (!prepared && !completed && !failed && !uncertain) {
    issues.push(issue("/stage", "stage", "tool call stage fields are inconsistent"));
  }
  if (value.terminal_at !== null && Date.parse(value.terminal_at) < Date.parse(value.prepared_at)) {
    issues.push(issue("/terminal_at", "timeOrder", "terminal time precedes preparation"));
  }
  const mismatch = documentHashIssue(value, hashToolCall(value));
  if (mismatch !== undefined) issues.push(mismatch);
  return issues;
}

function decodedBase64Bytes(value: string): number {
  return Buffer.from(value, "base64").byteLength;
}

function contentBytes(content: ToolResultContentV1): number {
  switch (content.type) {
    case "text":
      return Buffer.byteLength(content.text, "utf8");
    case "image":
    case "audio":
      return decodedBase64Bytes(content.data_base64);
    case "resource-link":
      return Buffer.byteLength(content.uri + content.name + (content.mime_type ?? ""), "utf8");
    case "embedded-resource":
      return (
        Buffer.byteLength(content.uri + content.mime_type + (content.text ?? ""), "utf8") +
        (content.blob_base64 === null ? 0 : decodedBase64Bytes(content.blob_base64))
      );
  }
}

function resultIssues(value: ToolResultV1): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (value.call_id !== value.provenance.call_id) {
    issues.push(issue("/provenance/call_id", "identity", "result call identity does not match"));
  }
  if (value.idempotency_key !== value.provenance.idempotency_key) {
    issues.push(
      issue(
        "/provenance/idempotency_key",
        "identity",
        "result idempotency identity does not match",
      ),
    );
  }
  const success = value.status === "success" && !value.is_error && value.error === null;
  const error = value.status === "error" && value.is_error && value.error !== null;
  if (!success && !error) {
    issues.push(issue("/status", "status", "result status, error flag, and error must agree"));
  }
  if (value.structured_content !== null && value.provenance.output_schema_hash === null) {
    issues.push(
      issue(
        "/structured_content",
        "structuredOutput",
        "structured output requires a declared output schema",
      ),
    );
  }
  const blockBytes = value.content.map(contentBytes);
  if (blockBytes.some((bytes) => bytes > TOOL_HARD_LIMITS.contentBlockBytes)) {
    issues.push(issue("/content", "maxBytes", "result content block exceeds its byte limit"));
  }
  const totalBytes = blockBytes.reduce((total, bytes) => total + bytes, 0);
  const structuredBytes =
    value.structured_content === null
      ? 0
      : Buffer.byteLength(canonicalJson(value.structured_content, TOOL_DOCUMENT_LIMITS), "utf8");
  if (
    value.accounting.content_blocks !== value.content.length ||
    value.accounting.total_bytes !== totalBytes ||
    value.accounting.structured_bytes !== structuredBytes
  ) {
    issues.push(issue("/accounting", "accounting", "result byte accounting is inconsistent"));
  }
  if (totalBytes + structuredBytes > TOOL_HARD_LIMITS.resultBytes) {
    issues.push(issue("/accounting/total_bytes", "maxBytes", "tool result exceeds its byte limit"));
  }
  const mismatch = documentHashIssue(value, hashToolResult(value));
  if (mismatch !== undefined) issues.push(mismatch);
  return issues;
}

const SCHEMA_VALIDATORS = new Map<string, ValidateFunction>();

function compiledSchema(schema: JsonValue): ValidateFunction {
  if (!isRecord(schema)) throw new TypeError("tool schema must be an object");
  const key = sha256(schema, PROFILE_DOCUMENT_LIMITS);
  const cached = SCHEMA_VALIDATORS.get(key);
  if (cached !== undefined) return cached;
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: false,
    coerceTypes: false,
    removeAdditional: false,
    strict: true,
    useDefaults: false,
  });
  addFormats(ajv);
  const validator = ajv.compile(schema);
  if (SCHEMA_VALIDATORS.size >= 256)
    SCHEMA_VALIDATORS.delete(SCHEMA_VALIDATORS.keys().next().value!);
  SCHEMA_VALIDATORS.set(key, validator);
  return validator;
}

function captureJson(value: JsonValue, maxBytes: number): ValidationResult<JsonValue> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > TOOL_HARD_LIMITS.argumentsBytes
  ) {
    return failure([issue("", "maxBytes", "tool value byte limit is invalid")]);
  }
  const limits: JsonLimits = { maxBytes, maxDepth: 32, maxMembers: 20_000 };
  try {
    return {
      ok: true,
      value: deepFreezeJson(parseJsonBytes(canonicalJson(value, limits), limits), limits),
    };
  } catch {
    return failure([issue("", "json", "tool value exceeds its structural limit")]);
  }
}

function validateAgainstSchema(
  schema: JsonValue,
  value: JsonValue,
  maxBytes: number,
): ValidationResult<JsonValue> {
  const captured = captureJson(value, maxBytes);
  if (!captured.ok) return captured;
  try {
    return compiledSchema(schema)(captured.value)
      ? captured
      : failure([issue("", "schema", "tool value does not satisfy its profile schema")]);
  } catch {
    return failure([issue("", "schema", "tool profile schema is unavailable")]);
  }
}

export function hashMcpDiscoverySnapshot(
  value: HashableMcpDiscoverySnapshotV1 | McpDiscoverySnapshotV1,
): `sha256:${string}` {
  return canonicalHash(value);
}

export function hashToolApproval(
  value: HashableToolApprovalV1 | ToolApprovalV1,
): `sha256:${string}` {
  return canonicalHash(value);
}

export function hashToolCall(value: HashableToolCallV1 | ToolCallV1): `sha256:${string}` {
  return canonicalHash(value);
}

export function hashToolResult(value: HashableToolResultV1 | ToolResultV1): `sha256:${string}` {
  return canonicalHash(value);
}

export function parseMcpDiscoverySnapshot(
  input: string | Uint8Array,
): ValidationResult<McpDiscoverySnapshotV1> {
  return parseToolDocument(input, "mcp-discovery-snapshot", discoveryIssues);
}

export function parseToolApproval(input: string | Uint8Array): ValidationResult<ToolApprovalV1> {
  return parseToolDocument(input, "tool-approval", approvalIssues);
}

export function parseToolCall(input: string | Uint8Array): ValidationResult<ToolCallV1> {
  return parseToolDocument(input, "tool-call", callIssues);
}

export function parseToolResult(input: string | Uint8Array): ValidationResult<ToolResultV1> {
  return parseToolDocument(input, "tool-result", resultIssues);
}

export function validateToolArguments(
  schema: JsonValue,
  value: JsonValue,
  maxBytes: number,
): ValidationResult<JsonValue> {
  return validateAgainstSchema(schema, value, maxBytes);
}

export function validateStructuredToolOutput(
  schema: JsonValue | null,
  value: JsonValue | null,
  maxBytes: number,
): ValidationResult<JsonValue | null> {
  if (value === null) return { ok: true, value: null };
  if (schema === null) {
    return failure([
      issue("", "structuredOutput", "structured output requires a declared output schema"),
    ]);
  }
  return validateAgainstSchema(schema, value, maxBytes);
}

export type {
  HashableMcpDiscoverySnapshotV1,
  HashableMcpProfileV1,
  HashableToolApprovalV1,
  HashableToolCallV1,
  HashableToolResultV1,
  McpDiscoverySnapshotV1,
  McpProfileV1,
  ToolApprovalV1,
  ToolCallV1,
  ToolResultV1,
};
