import { createHash } from "node:crypto";

import {
  parseTree,
  printParseErrorCode,
  type Node as JsoncNode,
  type ParseError,
} from "jsonc-parser";

import { ProtocolJsonError } from "./errors.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface JsonLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxMembers: number;
}

export const DEFAULT_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 64,
  maxMembers: 10_000,
});

interface TraversalState {
  members: number;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function validateLimits(limits: JsonLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ProtocolJsonError(`${name} must be a positive safe integer`);
    }
  }
}

function decodeInput(input: string | Uint8Array, limits: JsonLimits): string {
  const byteLength = typeof input === "string" ? Buffer.byteLength(input) : input.byteLength;
  if (byteLength > limits.maxBytes) {
    throw new ProtocolJsonError(`JSON byte limit exceeded: ${byteLength} > ${limits.maxBytes}`);
  }

  if (typeof input === "string") {
    return input;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new ProtocolJsonError("Invalid UTF-8 JSON input");
  }
}

function countMember(state: TraversalState, limits: JsonLimits, offset: number): void {
  state.members += 1;
  if (state.members > limits.maxMembers) {
    throw new ProtocolJsonError(
      `JSON member limit exceeded: ${state.members} > ${limits.maxMembers}`,
      offset,
    );
  }
}

function nodeToValue(
  node: JsoncNode,
  limits: JsonLimits,
  state: TraversalState,
  depth: number,
): JsonValue {
  if (depth > limits.maxDepth) {
    throw new ProtocolJsonError(
      `JSON depth limit exceeded: ${depth} > ${limits.maxDepth}`,
      node.offset,
    );
  }

  switch (node.type) {
    case "null":
      return null;
    case "boolean":
    case "string":
      return node.value as boolean | string;
    case "number": {
      const value = node.value as number;
      if (!Number.isFinite(value)) {
        throw new ProtocolJsonError("JSON numbers must be finite", node.offset);
      }
      return value;
    }
    case "array": {
      const result: JsonValue[] = [];
      for (const child of node.children ?? []) {
        countMember(state, limits, child.offset);
        result.push(nodeToValue(child, limits, state, depth + 1));
      }
      return result;
    }
    case "object": {
      const result: Record<string, JsonValue> = {};
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const [keyNode, valueNode] = property.children ?? [];
        if (keyNode?.type !== "string" || valueNode === undefined) {
          throw new ProtocolJsonError("Invalid JSON object property", property.offset);
        }
        const key = keyNode.value as string;
        if (keys.has(key)) {
          throw new ProtocolJsonError(
            `Duplicate object key ${JSON.stringify(key)}`,
            keyNode.offset,
          );
        }
        keys.add(key);
        countMember(state, limits, property.offset);
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: nodeToValue(valueNode, limits, state, depth + 1),
          writable: true,
        });
      }
      return result;
    }
    case "property":
    default:
      throw new ProtocolJsonError(`Unsupported JSON node type: ${node.type}`, node.offset);
  }
}

export function parseJsonBytes(
  input: string | Uint8Array,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): JsonValue {
  validateLimits(limits);
  const text = decodeInput(input, limits);
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });

  if (errors.length > 0 || root === undefined) {
    const first = errors[0];
    const detail = first === undefined ? "empty document" : printParseErrorCode(first.error);
    throw new ProtocolJsonError(`Invalid JSON: ${detail}`, first?.offset);
  }

  return nodeToValue(root, limits, { members: 0 }, 0);
}

function normalizedJson(
  value: unknown,
  limits: JsonLimits,
  state: TraversalState,
  depth: number,
): JsonValue {
  if (depth > limits.maxDepth) {
    throw new ProtocolJsonError(`JSON depth limit exceeded: ${depth} > ${limits.maxDepth}`);
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ProtocolJsonError("JSON numbers must be finite");
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value !== "object") {
    throw new ProtocolJsonError(`Unsupported JSON value type: ${typeof value}`);
  }

  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    throw new ProtocolJsonError("JSON values cannot contain symbol properties");
  }

  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined) {
        throw new ProtocolJsonError(`Sparse JSON array at index ${index}`);
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new ProtocolJsonError(`JSON accessor property at array index ${index}`);
      }
      countMember(state, limits, index);
      result.push(normalizedJson(descriptor.value, limits, state, depth + 1));
    }

    const allowedKeys = new Set(["length", ...result.map((_entry, index) => String(index))]);
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!allowedKeys.has(key)) {
        throw new ProtocolJsonError(`Unexpected JSON array property ${JSON.stringify(key)}`);
      }
    }
    return result;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolJsonError("JSON objects must have a plain prototype");
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      throw new ProtocolJsonError(`Missing JSON property descriptor ${JSON.stringify(key)}`);
    }
    if (!descriptor.enumerable) {
      throw new ProtocolJsonError(`JSON property must be enumerable: ${JSON.stringify(key)}`);
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new ProtocolJsonError(`JSON accessor property ${JSON.stringify(key)}`);
    }
    countMember(state, limits, 0);
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: normalizedJson(descriptor.value, limits, state, depth + 1),
      writable: true,
    });
  }
  return result;
}

export function assertPlainJson(
  value: unknown,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): asserts value is JsonValue {
  validateLimits(limits);
  normalizedJson(value, limits, { members: 0 }, 0);
}

export function canonicalJson(value: unknown): string {
  const normalized = normalizedJson(value, DEFAULT_JSON_LIMITS, { members: 0 }, 0);
  return JSON.stringify(normalized);
}

export function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function freezeJson(value: JsonValue): void {
  if (typeof value !== "object" || value === null) {
    return;
  }

  if (isJsonArray(value)) {
    for (const child of value) {
      freezeJson(child);
    }
  } else {
    for (const child of Object.values(value)) {
      freezeJson(child);
    }
  }
  Object.freeze(value);
}

export function deepFreezeJson<T extends JsonValue>(value: T): T {
  assertPlainJson(value);
  freezeJson(value);
  return value;
}
