import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonLimits,
  type JsonValue,
} from "../protocol/json.js";
import type { ValidationFailure, ValidationIssue, ValidationResult } from "../protocol/types.js";
import { createProtocolValidator } from "../protocol/validator.js";
import type { ModelCatalogV1 } from "./types.js";

const MODEL_CATALOG_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxMembers: 100_000,
});

function issue(path: string, keyword: string, message: string): ValidationIssue {
  return { path, keyword, message };
}

function failure(issues: readonly ValidationIssue[]): ValidationFailure {
  return {
    ok: false,
    code: "RUNTIME_DOCUMENT_INVALID",
    issues: [...issues].sort((left, right) =>
      `${left.path}\u0000${left.keyword}\u0000${left.message}`.localeCompare(
        `${right.path}\u0000${right.keyword}\u0000${right.message}`,
      ),
    ),
  };
}

function jsonFailure(): ValidationFailure {
  return failure([issue("", "json", "model catalog is invalid")]);
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashModelCatalog(value: ModelCatalogV1): `sha256:${string}` {
  const normalized = parseJsonBytes(
    canonicalJson(value, MODEL_CATALOG_JSON_LIMITS),
    MODEL_CATALOG_JSON_LIMITS,
  );
  if (!isRecord(normalized)) throw new TypeError("model catalog is invalid");
  const { document_hash: _documentHash, ...hashable } = normalized;
  return sha256(hashable, MODEL_CATALOG_JSON_LIMITS);
}

export function parseModelCatalog(input: string | Uint8Array): ValidationResult<ModelCatalogV1> {
  let canonical: string;
  try {
    canonical = canonicalJson(
      deepFreezeJson(parseJsonBytes(input, MODEL_CATALOG_JSON_LIMITS), MODEL_CATALOG_JSON_LIMITS),
      MODEL_CATALOG_JSON_LIMITS,
    );
  } catch {
    return jsonFailure();
  }

  const parsed = createProtocolValidator().parse<ModelCatalogV1>(
    canonical,
    "model-catalog",
    MODEL_CATALOG_JSON_LIMITS,
  );
  if (!parsed.ok) return parsed;

  const issues: ValidationIssue[] = [];
  const entryIds = new Set<string>();
  const routeIds = new Set<string>();
  for (const [entryIndex, entry] of parsed.value.entries.entries()) {
    if (entryIds.has(entry.entry_id)) {
      issues.push(
        issue(`/entries/${entryIndex}/entry_id`, "uniqueEntry", "entry_id must be unique"),
      );
    }
    entryIds.add(entry.entry_id);

    const classes = new Set<string>();
    for (const [classIndex, logicalClass] of entry.logical_classes.entries()) {
      if (classes.has(logicalClass)) {
        issues.push(
          issue(
            `/entries/${entryIndex}/logical_classes/${classIndex}`,
            "uniqueClass",
            "logical classes must be unique",
          ),
        );
      }
      classes.add(logicalClass);
    }

    for (const [routeIndex, route] of entry.routes.entries()) {
      if (routeIds.has(route.route_id)) {
        issues.push(
          issue(
            `/entries/${entryIndex}/routes/${routeIndex}/route_id`,
            "uniqueRoute",
            "route_id must be globally unique",
          ),
        );
      }
      routeIds.add(route.route_id);
      if (route.provider !== route.capabilities.provider) {
        issues.push(
          issue(
            `/entries/${entryIndex}/routes/${routeIndex}/capabilities/provider`,
            "providerCoherence",
            "route and capability providers must match",
          ),
        );
      }
    }
  }

  let expectedHash: `sha256:${string}` | undefined;
  try {
    expectedHash = hashModelCatalog(parsed.value);
  } catch {
    issues.push(issue("/document_hash", "canonicalHash", "catalog hash is invalid"));
  }
  if (expectedHash !== undefined && parsed.value.document_hash !== expectedHash) {
    issues.push(issue("/document_hash", "canonicalHash", "catalog hash does not match"));
  }

  return issues.length === 0 ? parsed : failure(issues);
}
