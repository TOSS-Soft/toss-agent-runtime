import { createHash } from "node:crypto";

import { canonicalJson, deepFreezeJson, sha256, type JsonValue } from "../protocol/json.js";
import { parseSkillSnapshot } from "./contracts.js";
import { RuntimeSkillError } from "./errors.js";
import {
  SKILL_LIMITS,
  type SkillContextResourceAccounting,
  type SkillSnapshotV1,
  type SuperpowersPhaseName,
} from "./types.js";

export interface SkillContextRequest {
  readonly snapshot: SkillSnapshotV1;
  readonly snapshot_hash: `sha256:${string}`;
  readonly phase: SuperpowersPhaseName;
  readonly max_bytes: number;
  readonly max_tokens: number;
}

/** Internal loader-to-context handoff. It is intentionally not exported from the package entry point. */
export interface SkillContextMaterial {
  readonly skill_markdown: Uint8Array;
  readonly resources: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
}

export interface SkillContextSegment {
  readonly path: string;
  readonly role: "skill" | "reference" | "asset";
  readonly source_hash: `sha256:${string}`;
  readonly included_hash: `sha256:${string}`;
  readonly original_bytes: number;
  readonly included_bytes: number;
  readonly conservative_tokens: number;
  readonly content: string;
}

export interface SkillContextTruncation {
  readonly path: string;
  readonly original_bytes: number;
  readonly included_bytes: number;
}

export interface SkillContext {
  readonly snapshot: Readonly<{
    name: string;
    version: string;
    package_hash: `sha256:${string}`;
    snapshot_hash: `sha256:${string}`;
  }>;
  readonly phase: SuperpowersPhaseName;
  readonly segments: readonly SkillContextSegment[];
  readonly included_resource_hashes: readonly `sha256:${string}`[];
  readonly omitted_resource_hashes: readonly `sha256:${string}`[];
  readonly original_utf8_bytes: number;
  readonly included_utf8_bytes: number;
  readonly original_tokens: number;
  readonly included_tokens: number;
  readonly remaining_bytes: number;
  readonly remaining_tokens: number;
  readonly truncations: readonly SkillContextTruncation[];
  readonly resource_accounting: readonly SkillContextResourceAccounting[];
  readonly context_hash: `sha256:${string}`;
}

function integrity(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY");
}

function overflow(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_CONTEXT_OVERFLOW");
}

function rawHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function tokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function validBudget(request: SkillContextRequest): boolean {
  return (
    Number.isSafeInteger(request.max_bytes) &&
    request.max_bytes >= 0 &&
    request.max_bytes <= SKILL_LIMITS.phaseInputBytes &&
    Number.isSafeInteger(request.max_tokens) &&
    request.max_tokens >= 0 &&
    request.max_tokens <= tokens(SKILL_LIMITS.phaseInputBytes)
  );
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return integrity();
  }
}

function materialBytes(
  snapshot: SkillSnapshotV1,
  material: SkillContextMaterial,
): ReadonlyMap<string, Uint8Array> {
  if (
    material.skill_markdown.byteLength !== snapshot.skill_markdown_bytes ||
    rawHash(material.skill_markdown) !== snapshot.skill_markdown_hash
  ) {
    integrity();
  }
  const resources = new Map<string, Uint8Array>();
  for (const resource of material.resources) {
    if (resources.has(resource.path)) integrity();
    resources.set(resource.path, resource.bytes);
  }
  if (resources.size !== snapshot.resources.length) integrity();
  for (const declaration of snapshot.resources) {
    const bytes = resources.get(declaration.path);
    if (
      bytes === undefined ||
      bytes.byteLength !== declaration.bytes ||
      rawHash(bytes) !== declaration.hash
    ) {
      integrity();
    }
  }
  return resources;
}

function compareOptional(
  left: SkillSnapshotV1["resources"][number],
  right: SkillSnapshotV1["resources"][number],
): number {
  if (left.priority === null || right.priority === null) integrity();
  return (
    left.priority - right.priority ||
    Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8"))
  );
}

function segment(
  path: string,
  role: SkillContextSegment["role"],
  sourceHash: `sha256:${string}`,
  originalBytes: number,
  bytes: Uint8Array,
): SkillContextSegment {
  const content = decodeUtf8(bytes);
  return {
    path,
    role,
    source_hash: sourceHash,
    included_hash: rawHash(bytes),
    original_bytes: originalBytes,
    included_bytes: bytes.byteLength,
    conservative_tokens: tokens(bytes.byteLength),
    content,
  };
}

function segmentTokens(segments: readonly SkillContextSegment[]): number {
  return segments.reduce((total, entry) => total + entry.conservative_tokens, 0);
}

function largestUtf8Prefix(bytes: Uint8Array, maxBytes: number, maxTokens: number): Uint8Array {
  const content = decodeUtf8(bytes);
  let includedBytes = 0;
  for (const codePoint of content) {
    const nextBytes = includedBytes + Buffer.byteLength(codePoint, "utf8");
    if (nextBytes > maxBytes || tokens(nextBytes) > maxTokens) break;
    includedBytes = nextBytes;
  }
  return bytes.subarray(0, includedBytes);
}

export function assembleSkillContext(
  request: SkillContextRequest,
  material: SkillContextMaterial,
): SkillContext {
  if (!validBudget(request) || request.snapshot_hash !== request.snapshot.document_hash)
    integrity();
  const parsed = parseSkillSnapshot(canonicalJson(request.snapshot));
  if (!parsed.ok || parsed.value.document_hash !== request.snapshot_hash) integrity();
  const snapshot = parsed.value;
  const bytes = materialBytes(snapshot, material);
  const mandatory = snapshot.resources.filter(
    (resource) =>
      resource.role === "reference" &&
      resource.phases.includes(request.phase) &&
      resource.priority === null,
  );
  const optional = snapshot.resources
    .filter(
      (resource) =>
        resource.role === "reference" &&
        resource.phases.includes(request.phase) &&
        resource.priority !== null,
    )
    .sort(compareOptional);
  const selected = [
    segment(
      "SKILL.md",
      "skill",
      snapshot.skill_markdown_hash,
      snapshot.skill_markdown_bytes,
      material.skill_markdown,
    ),
    ...mandatory.map((resource) =>
      segment(resource.path, "reference", resource.hash, resource.bytes, bytes.get(resource.path)!),
    ),
  ];
  let includedBytes = selected.reduce((total, entry) => total + entry.included_bytes, 0);
  let includedTokens = segmentTokens(selected);
  if (includedBytes > request.max_bytes || includedTokens > request.max_tokens) overflow();
  const truncations: SkillContextTruncation[] = [];
  const includedResourcePaths = new Set<string>(mandatory.map((resource) => resource.path));
  for (const resource of optional) {
    const candidate = bytes.get(resource.path)!;
    const candidateBytes = includedBytes + candidate.byteLength;
    const candidateTokens = includedTokens + tokens(candidate.byteLength);
    if (candidateBytes <= request.max_bytes && candidateTokens <= request.max_tokens) {
      selected.push(segment(resource.path, "reference", resource.hash, resource.bytes, candidate));
      includedBytes = candidateBytes;
      includedTokens = candidateTokens;
      includedResourcePaths.add(resource.path);
    } else {
      const prefix = largestUtf8Prefix(
        candidate,
        request.max_bytes - includedBytes,
        request.max_tokens - includedTokens,
      );
      if (prefix.byteLength > 0) {
        const partial = segment(resource.path, "reference", resource.hash, resource.bytes, prefix);
        selected.push(partial);
        includedBytes += partial.included_bytes;
        includedTokens += partial.conservative_tokens;
      }
      truncations.push({
        path: resource.path,
        original_bytes: resource.bytes,
        included_bytes: prefix.byteLength,
      });
      break;
    }
  }
  const includedResourceHashes = [...new Set(selected.slice(1).map((entry) => entry.source_hash))];
  const omittedResourceHashes = [
    ...new Set(
      snapshot.resources
        .filter((resource) => !includedResourcePaths.has(resource.path))
        .map((resource) => resource.hash),
    ),
  ];
  const originalBytes =
    material.skill_markdown.byteLength +
    [...mandatory, ...optional].reduce((total, resource) => total + resource.bytes, 0);
  const originalTokens =
    tokens(material.skill_markdown.byteLength) +
    [...mandatory, ...optional].reduce((total, resource) => total + tokens(resource.bytes), 0);
  const segmentByPath = new Map(selected.slice(1).map((entry) => [entry.path, entry]));
  const resourceAccounting = snapshot.resources.map((resource) => {
    const included = segmentByPath.get(resource.path);
    const includedBytes = included?.included_bytes ?? 0;
    const state: SkillContextResourceAccounting["state"] =
      includedBytes === 0 ? "OMITTED" : includedBytes === resource.bytes ? "INCLUDED" : "PARTIAL";
    return {
      path: resource.path,
      source_hash: resource.hash,
      state,
      original_bytes: resource.bytes,
      included_bytes: includedBytes,
      included_hash: included?.included_hash ?? null,
      original_conservative_units: tokens(resource.bytes),
      included_conservative_units: tokens(includedBytes),
    };
  });
  const hashable = {
    snapshot: {
      name: snapshot.descriptor.name,
      version: snapshot.descriptor.version,
      package_hash: snapshot.package_hash,
      snapshot_hash: snapshot.document_hash,
    },
    phase: request.phase,
    segments: selected,
    included_resource_hashes: includedResourceHashes,
    omitted_resource_hashes: omittedResourceHashes,
    original_utf8_bytes: originalBytes,
    included_utf8_bytes: includedBytes,
    original_tokens: originalTokens,
    included_tokens: includedTokens,
    remaining_bytes: request.max_bytes - includedBytes,
    remaining_tokens: request.max_tokens - includedTokens,
    truncations,
    resource_accounting: resourceAccounting,
  };
  return deepFreezeJson({
    ...hashable,
    context_hash: sha256(hashable),
  } as unknown as JsonValue) as unknown as SkillContext;
}
