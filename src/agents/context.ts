import {
  hashExecutionRequest,
  parseExecutionRequest,
  type ExecutionRequestV1,
} from "../protocol/request.js";
import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonValue,
} from "../protocol/json.js";
import type { ArtifactReference, RuntimeBudget } from "../protocol/types.js";
import { matchAgentAuthority, type EffectiveAgentAuthority } from "./authority.js";
import {
  AGENT_DOCUMENT_LIMITS,
  COMPILED_CONTEXT_RUNTIME_POLICY_V1,
  hashCompiledContext,
  parseAgentDefinition,
  parseCompiledContext,
  parsePromptTemplate,
} from "./contracts.js";
import { RuntimeAgentError } from "./errors.js";
import type {
  AgentDefinitionReference,
  AgentDefinitionV1,
  CompileAgentContextInput,
  CompiledContextSegmentV1,
  CompiledContextV1,
  ContextTruncationV1,
  ContextArtifactResolver,
  HashableCompiledContextV1,
  InputArtifactSegmentV1,
  McpProfileReference,
  OutputSchemaReference,
  PromptTemplateReference,
  ResolvedAgentBundle,
  ResolvedContextArtifact,
  TaskContractReference,
} from "./types.js";

export type {
  CompileAgentContextInput,
  ContextArtifactResolver,
  ResolvedContextArtifact,
} from "./types.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DOCUMENT_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const RELATIVE_LOCATION_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\u0000]+$/u;
const MAX_COMPILED_SEGMENT_BYTES = 1_048_576;
const MAX_COMPILED_SEGMENTS = 4_096;
const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;

const COMPILE_INPUT_KEYS = ["bundle", "request", "request_hash", "resolver"] as const;
const RESOLVED_ARTIFACT_KEYS = [
  "bytes",
  "media_type",
  "origin",
  "reference",
  "sensitivity",
] as const;
const REFERENCE_KEYS = ["artifact_id", "document_type", "hash", "revision"] as const;
const REFERENCE_KEYS_WITH_LOCATION = [...REFERENCE_KEYS, "location"] as const;
const MEDIA_TYPES = new Set(["application/json", "text/plain"]);
const SENSITIVITIES = new Set(["public", "internal", "confidential", "secret"]);
const ORIGINS = new Set(["control-plane", "repository", "web", "model", "skill", "tool"]);

interface CompileProjection {
  readonly request_hash: `sha256:${string}`;
  readonly request: ExecutionRequestV1;
  readonly bundle: ResolvedAgentBundle;
  readonly resolve: ContextArtifactResolver["resolve"];
  readonly resolverReceiver: ContextArtifactResolver;
}

interface ResolvedProjection {
  readonly reference: unknown;
  readonly media_type: ResolvedContextArtifact["media_type"];
  readonly sensitivity: ResolvedContextArtifact["sensitivity"];
  readonly origin: ResolvedContextArtifact["origin"];
  readonly bytes: Uint8Array;
  readonly byte_length: number;
}

interface NormalizedArtifact {
  readonly reference: ArtifactReference;
  readonly content: string;
  readonly original_bytes: number;
}

interface SortedInputReference {
  readonly reference: ArtifactReference;
  readonly priority: number;
  readonly max_bytes: number;
}

interface CompiledRepresentationState {
  readonly segments: CompiledContextSegmentV1[];
  readonly truncations: ContextTruncationV1[];
  segmentJsonBytes: number;
  truncationJsonBytes: number;
  inputBytes: number;
  untrustedBytes: number;
}

function contextError(code: ConstructorParameters<typeof RuntimeAgentError>[0]): never {
  throw new RuntimeAgentError(code);
}

function integrityError(): never {
  return contextError("RUNTIME_CONTEXT_INTEGRITY");
}

function unsupportedError(): never {
  return contextError("RUNTIME_CONTEXT_UNSUPPORTED");
}

function referenceMismatchError(): never {
  return contextError("RUNTIME_CONTEXT_REFERENCE_MISMATCH");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function captureDataDescriptors(value: unknown): Record<string, PropertyDescriptor> {
  let prototype: object | null;
  let symbols: readonly symbol[];
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    if (!isRecord(value)) return integrityError();
    prototype = Object.getPrototypeOf(value) as object | null;
    symbols = Object.getOwnPropertySymbols(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return integrityError();
  }
  if (prototype !== Object.prototype && prototype !== null) integrityError();
  if (symbols.length !== 0) integrityError();
  for (const descriptor of Object.values(descriptors)) {
    if (
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !("value" in descriptor)
    ) {
      integrityError();
    }
  }
  return descriptors;
}

function requireExactDescriptorKeys(
  descriptors: Record<string, PropertyDescriptor>,
  expectedKeys: readonly string[],
): void {
  const actualKeys = Object.keys(descriptors).sort(bytewiseCompare);
  const sortedExpected = [...expectedKeys].sort(bytewiseCompare);
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    integrityError();
  }
}

function exactDataDescriptors(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, PropertyDescriptor> {
  const descriptors = captureDataDescriptors(value);
  requireExactDescriptorKeys(descriptors, expectedKeys);
  return descriptors;
}

function snapshotJson<T>(value: T): T {
  let encoded: string;
  try {
    encoded = canonicalJson(value, AGENT_DOCUMENT_LIMITS);
  } catch {
    return integrityError();
  }
  if (Buffer.byteLength(encoded, "utf8") > AGENT_DOCUMENT_LIMITS.maxBytes) integrityError();
  try {
    return deepFreezeJson(
      parseJsonBytes(encoded, AGENT_DOCUMENT_LIMITS),
      AGENT_DOCUMENT_LIMITS,
    ) as unknown as T;
  } catch {
    return integrityError();
  }
}

function acquireResolverMethod(value: unknown): {
  readonly resolve: ContextArtifactResolver["resolve"];
  readonly receiver: ContextArtifactResolver;
} {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    integrityError();
  }
  const receiver = value as ContextArtifactResolver;
  const visited = new Set<object>();
  let owner = value as object | null;
  for (let depth = 0; owner !== null && depth < 32; depth += 1) {
    if (visited.has(owner)) integrityError();
    visited.add(owner);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(owner, "resolve");
    } catch {
      return integrityError();
    }
    if (descriptor !== undefined) {
      if (
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "function"
      ) {
        integrityError();
      }
      return {
        resolve: descriptor.value as ContextArtifactResolver["resolve"],
        receiver,
      };
    }
    let prototype: unknown;
    try {
      prototype = Object.getPrototypeOf(owner) as unknown;
    } catch {
      return integrityError();
    }
    if (prototype !== null && typeof prototype !== "object") integrityError();
    owner = prototype;
  }
  return integrityError();
}

function projectCompileInput(input: CompileAgentContextInput): CompileProjection {
  const descriptors = exactDataDescriptors(input, COMPILE_INPUT_KEYS);
  const requestHash = descriptors.request_hash?.value as unknown;
  if (typeof requestHash !== "string" || !SHA256_PATTERN.test(requestHash)) integrityError();
  const requestSnapshot = snapshotJson(descriptors.request?.value) as ExecutionRequestV1;
  if (
    Array.isArray(requestSnapshot.input_artifacts) &&
    requestSnapshot.input_artifacts.length > MAX_COMPILED_SEGMENTS - 4
  ) {
    unsupportedError();
  }
  let requestResult: ReturnType<typeof parseExecutionRequest>;
  try {
    requestResult = parseExecutionRequest(canonicalJson(requestSnapshot, AGENT_DOCUMENT_LIMITS));
  } catch {
    return integrityError();
  }
  if (!requestResult.ok) integrityError();
  // Context compilation treats input artifacts as a semantic set, so its local
  // request identity projects away resolver-only locations and sorts exact refs.
  const request = Object.freeze({
    ...requestResult.value,
    input_artifacts: Object.freeze(
      requestResult.value.input_artifacts
        .map((reference) => projectReference(reference))
        .sort(compareArtifactReferences),
    ),
  });
  if (hashExecutionRequest(request) !== requestHash) integrityError();
  const bundle = snapshotJson(descriptors.bundle?.value) as ResolvedAgentBundle;

  const resolver = descriptors.resolver?.value as unknown;
  const resolverMethod = acquireResolverMethod(resolver);

  return {
    request_hash: requestHash,
    request,
    bundle,
    resolve: resolverMethod.resolve,
    resolverReceiver: resolverMethod.receiver,
  };
}

function validateLocation(location: unknown): void {
  if (
    typeof location !== "string" ||
    location.length < 1 ||
    location.length > 1024 ||
    !RELATIVE_LOCATION_PATTERN.test(location)
  ) {
    unsupportedError();
  }
}

function projectReference(value: unknown): ArtifactReference {
  const descriptors = captureDataDescriptors(value);
  const hasLocation = Object.prototype.hasOwnProperty.call(descriptors, "location");
  requireExactDescriptorKeys(
    descriptors,
    hasLocation ? REFERENCE_KEYS_WITH_LOCATION : REFERENCE_KEYS,
  );
  const documentType = descriptors.document_type?.value as unknown;
  const artifactId = descriptors.artifact_id?.value as unknown;
  const revision = descriptors.revision?.value as unknown;
  const hash = descriptors.hash?.value as unknown;
  if (
    typeof documentType !== "string" ||
    !DOCUMENT_TYPE_PATTERN.test(documentType) ||
    typeof artifactId !== "string" ||
    !IDENTIFIER_PATTERN.test(artifactId) ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 1 ||
    typeof hash !== "string" ||
    !SHA256_PATTERN.test(hash)
  ) {
    integrityError();
  }
  if (hasLocation) validateLocation(descriptors.location?.value);
  return Object.freeze({
    document_type: documentType,
    artifact_id: artifactId,
    revision: revision as number,
    hash: hash as `sha256:${string}`,
  });
}

function exactReference(left: ArtifactReference, right: ArtifactReference): boolean {
  return (
    left.document_type === right.document_type &&
    left.artifact_id === right.artifact_id &&
    left.revision === right.revision &&
    left.hash === right.hash
  );
}

function referenceKey(reference: ArtifactReference): string {
  return `${reference.document_type}\u0000${reference.artifact_id}\u0000${String(reference.revision)}\u0000${reference.hash}`;
}

function revisionKey(reference: ArtifactReference): string {
  return `${reference.document_type}\u0000${reference.artifact_id}\u0000${String(reference.revision)}`;
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function compareSafeIntegers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareArtifactReferences(left: ArtifactReference, right: ArtifactReference): number {
  return (
    bytewiseCompare(left.document_type, right.document_type) ||
    bytewiseCompare(left.artifact_id, right.artifact_id) ||
    compareSafeIntegers(left.revision, right.revision) ||
    bytewiseCompare(left.hash, right.hash)
  );
}

function compareSortedInputs(left: SortedInputReference, right: SortedInputReference): number {
  return (
    compareSafeIntegers(left.priority, right.priority) ||
    bytewiseCompare(left.reference.document_type, right.reference.document_type) ||
    bytewiseCompare(left.reference.artifact_id, right.reference.artifact_id) ||
    compareSafeIntegers(left.reference.revision, right.reference.revision) ||
    bytewiseCompare(left.reference.hash, right.reference.hash)
  );
}

function validatedBundle(bundle: ResolvedAgentBundle): ResolvedAgentBundle {
  let definitionResult: ReturnType<typeof parseAgentDefinition>;
  let promptResult: ReturnType<typeof parsePromptTemplate>;
  try {
    definitionResult = parseAgentDefinition(
      canonicalJson(bundle.definition, AGENT_DOCUMENT_LIMITS),
    );
    promptResult = parsePromptTemplate(
      canonicalJson(bundle.prompt_template, AGENT_DOCUMENT_LIMITS),
    );
  } catch {
    return integrityError();
  }
  if (!definitionResult.ok || !promptResult.ok) integrityError();
  const expectedPrompt = projectReference(definitionResult.value.prompt_template);
  const actualPrompt = Object.freeze({
    document_type: "prompt-template",
    artifact_id: promptResult.value.template_id,
    revision: promptResult.value.revision,
    hash: promptResult.value.document_hash,
  }) satisfies PromptTemplateReference;
  if (!exactReference(expectedPrompt, actualPrompt)) integrityError();
  return Object.freeze({
    definition: definitionResult.value,
    prompt_template: promptResult.value,
  });
}

function normalizeAuthority(authority: EffectiveAgentAuthority): EffectiveAgentAuthority {
  return Object.freeze({
    definition: projectReference(authority.definition),
    role: authority.role,
    task_contract: projectReference(authority.task_contract),
    logical_class: authority.logical_class,
    model_capabilities: Object.freeze([...authority.model_capabilities]),
    superpowers_capabilities: Object.freeze([...authority.superpowers_capabilities]),
    mcp_profile: projectReference(authority.mcp_profile),
    budget: Object.freeze(copyBudget(authority.budget)),
    output_schema: projectReference(authority.output_schema),
  });
}

function copyBudget(budget: RuntimeBudget): RuntimeBudget {
  return {
    max_input_tokens: budget.max_input_tokens,
    max_output_tokens: budget.max_output_tokens,
    max_cost_microusd: budget.max_cost_microusd,
    max_duration_ms: budget.max_duration_ms,
    max_turns: budget.max_turns,
  };
}

function sortedInputReferences(
  request: ExecutionRequestV1,
  definition: AgentDefinitionV1,
  taskReference: ArtifactReference,
  outputReference: ArtifactReference,
): readonly SortedInputReference[] {
  const policyByDocumentType = new Map(
    definition.context_policy.inputs.map((policy) => [policy.document_type, policy]),
  );
  const seenExact = new Set<string>();
  const revisionHashes = new Map<string, string>();
  const allReferences = [
    taskReference,
    outputReference,
    ...request.input_artifacts.map((reference) => projectReference(reference)),
  ];
  for (const reference of allReferences) {
    const exactKey = referenceKey(reference);
    if (seenExact.has(exactKey)) integrityError();
    seenExact.add(exactKey);
    const artifactRevision = revisionKey(reference);
    const priorHash = revisionHashes.get(artifactRevision);
    if (priorHash !== undefined && priorHash !== reference.hash) integrityError();
    revisionHashes.set(artifactRevision, reference.hash);
  }

  return Object.freeze(
    request.input_artifacts
      .map((candidate) => {
        const reference = projectReference(candidate);
        const policy = policyByDocumentType.get(reference.document_type);
        if (policy === undefined) unsupportedError();
        return Object.freeze({
          reference,
          priority: policy.priority,
          max_bytes: policy.max_bytes,
        });
      })
      .sort(compareSortedInputs),
  );
}

function inspectResolvedArtifact(value: unknown): ResolvedProjection {
  const descriptors = exactDataDescriptors(value, RESOLVED_ARTIFACT_KEYS);
  const bytesValue = descriptors.bytes?.value as unknown;
  let byteLength: number;
  let byteArray: Uint8Array;
  try {
    if (!(bytesValue instanceof Uint8Array)) return integrityError();
    byteArray = bytesValue;
    byteLength = byteArray.byteLength;
  } catch {
    return integrityError();
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) integrityError();
  if (byteLength > MAX_COMPILED_SEGMENT_BYTES) unsupportedError();

  const mediaType = descriptors.media_type?.value as unknown;
  const sensitivity = descriptors.sensitivity?.value as unknown;
  const origin = descriptors.origin?.value as unknown;
  if (typeof mediaType !== "string" || !MEDIA_TYPES.has(mediaType)) unsupportedError();
  if (typeof sensitivity !== "string" || !SENSITIVITIES.has(sensitivity)) unsupportedError();
  if (sensitivity === "secret") unsupportedError();
  if (typeof origin !== "string" || !ORIGINS.has(origin)) unsupportedError();

  return {
    reference: descriptors.reference?.value,
    media_type: mediaType as ResolvedContextArtifact["media_type"],
    sensitivity: sensitivity as ResolvedContextArtifact["sensitivity"],
    origin: origin as ResolvedContextArtifact["origin"],
    bytes: byteArray,
    byte_length: byteLength,
  };
}

async function resolveExactArtifact(
  projection: CompileProjection,
  requestedReference: ArtifactReference,
  trustedControl: boolean,
  beforeCopy?: (resolved: ResolvedProjection) => void,
): Promise<NormalizedArtifact> {
  let rawArtifact: unknown;
  try {
    rawArtifact = await Reflect.apply(projection.resolve, projection.resolverReceiver, [
      Object.freeze({ ...requestedReference }),
    ]);
  } catch {
    return integrityError();
  }

  const resolved = inspectResolvedArtifact(rawArtifact);
  if (trustedControl && resolved.origin !== "control-plane") unsupportedError();
  if (trustedControl && resolved.media_type !== "application/json") unsupportedError();
  beforeCopy?.(resolved);

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(resolved.byte_length);
    bytes.set(resolved.bytes);
  } catch {
    return integrityError();
  }
  const resolvedReference = projectReference(resolved.reference);
  if (!exactReference(resolvedReference, requestedReference)) referenceMismatchError();

  let content: string;
  let contentHash: `sha256:${string}`;
  if (resolved.media_type === "application/json") {
    let parsed: JsonValue;
    try {
      parsed = parseJsonBytes(bytes, AGENT_DOCUMENT_LIMITS);
      content = canonicalJson(parsed, AGENT_DOCUMENT_LIMITS);
      contentHash = sha256(parsed, AGENT_DOCUMENT_LIMITS);
    } catch {
      return referenceMismatchError();
    }
  } else {
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return unsupportedError();
    }
    contentHash = sha256(content, AGENT_DOCUMENT_LIMITS);
  }
  if (contentHash !== requestedReference.hash) referenceMismatchError();
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > MAX_COMPILED_SEGMENT_BYTES) unsupportedError();

  return Object.freeze({
    reference: requestedReference,
    content,
    original_bytes: contentBytes,
  });
}

function segmentId(
  kind: CompiledContextSegmentV1["kind"],
  source: ArtifactReference | null,
  includedHash: `sha256:${string}`,
  discriminator?: string,
): string {
  const hash = sha256(
    discriminator === undefined
      ? { kind, source, included_hash: includedHash }
      : { kind, source, included_hash: includedHash, discriminator },
    AGENT_DOCUMENT_LIMITS,
  );
  return `ctx-${hash.slice("sha256:".length)}`;
}

function segmentBase(
  kind: CompiledContextSegmentV1["kind"],
  source: ArtifactReference | null,
  originalHash: `sha256:${string}`,
  content: string,
  discriminator?: string,
) {
  const includedHash = sha256(content, AGENT_DOCUMENT_LIMITS);
  const includedBytes = Buffer.byteLength(content, "utf8");
  return {
    segment_id: segmentId(kind, source, includedHash, discriminator),
    original_hash: originalHash,
    included_hash: includedHash,
    original_bytes: includedBytes,
    included_bytes: includedBytes,
    tokens: includedBytes,
    content,
  } as const;
}

function buildTrustedSegments(
  bundle: ResolvedAgentBundle,
  task: NormalizedArtifact,
  output: NormalizedArtifact,
  includeTruncationNotice = false,
): readonly CompiledContextSegmentV1[] {
  const noticePolicy = COMPILED_CONTEXT_RUNTIME_POLICY_V1.truncation_notice;
  const runtimeContent =
    COMPILED_CONTEXT_RUNTIME_POLICY_V1.safety_text +
    (includeTruncationNotice ? noticePolicy.framing + noticePolicy.content : "");
  const promptReference = projectReference(
    bundle.definition.prompt_template,
  ) as PromptTemplateReference;
  const segments: CompiledContextSegmentV1[] = [
    {
      ...segmentBase(
        noticePolicy.target.kind,
        noticePolicy.target.source,
        sha256(runtimeContent, AGENT_DOCUMENT_LIMITS),
        runtimeContent,
        COMPILED_CONTEXT_RUNTIME_POLICY_V1.reference.hash,
      ),
      kind: noticePolicy.target.kind,
      trust: "trusted-runtime",
      source: noticePolicy.target.source,
    },
    {
      ...segmentBase("task-contract", task.reference, task.reference.hash, task.content),
      kind: "task-contract",
      trust: "trusted-control",
      source: task.reference as TaskContractReference,
    },
  ];
  for (const block of bundle.prompt_template.instruction_blocks) {
    segments.push({
      ...segmentBase(
        "prompt-template",
        promptReference,
        promptReference.hash,
        block.content,
        block.block_id,
      ),
      kind: "prompt-template",
      trust: "trusted-control",
      source: promptReference,
    });
  }
  segments.push({
    ...segmentBase("output-schema", output.reference, output.reference.hash, output.content),
    kind: "output-schema",
    trust: "trusted-control",
    source: output.reference as OutputSchemaReference,
  });
  return Object.freeze(segments);
}

function buildInputSegment(
  input: NormalizedArtifact,
  includedContent = input.content,
): InputArtifactSegmentV1 {
  return {
    ...segmentBase("input-artifact", input.reference, input.reference.hash, includedContent),
    kind: "input-artifact",
    trust: "untrusted-content",
    source: input.reference,
    original_bytes: input.original_bytes,
  };
}

function truncationRecord(
  input: NormalizedArtifact,
  includedBytes: number,
  reason: ContextTruncationV1["reason"],
): ContextTruncationV1 {
  return Object.freeze({
    source: input.reference,
    reason,
    original_bytes: input.original_bytes,
    included_bytes: includedBytes,
  });
}

function utf8PrefixWithinBytes(content: string, ceiling: number): string {
  let end = 0;
  let bytes = 0;
  for (const scalar of content) {
    const scalarBytes = Buffer.byteLength(scalar, "utf8");
    if (bytes > ceiling - scalarBytes) break;
    bytes += scalarBytes;
    end += scalar.length;
  }
  return content.slice(0, end);
}

function boundedJsonStringByteLength(value: string): number {
  const limit = AGENT_DOCUMENT_LIMITS.maxBytes;
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let increment: number;
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      increment = 2;
    } else if (codeUnit <= 0x1f) {
      increment =
        codeUnit === 0x08 ||
        codeUnit === 0x09 ||
        codeUnit === 0x0a ||
        codeUnit === 0x0c ||
        codeUnit === 0x0d
          ? 2
          : 6;
    } else if (codeUnit <= 0x7f) {
      increment = 1;
    } else if (codeUnit <= 0x7ff) {
      increment = 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        increment = 4;
        index += 1;
      } else {
        increment = 6;
      }
    } else {
      increment = codeUnit >= 0xdc00 && codeUnit <= 0xdfff ? 6 : 3;
    }
    if (bytes > limit - increment) return limit + 1;
    bytes += increment;
  }
  return bytes;
}

function safeSum(...values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) integrityError();
  return total;
}

function segmentJsonByteLengthForContent(
  segment: CompiledContextSegmentV1,
  encodedContentBytes: number,
): number {
  let baseBytes: number;
  try {
    baseBytes = Buffer.byteLength(canonicalJson({ ...segment, content: "" }), "utf8");
  } catch {
    return integrityError();
  }
  return safeSum(baseBytes, encodedContentBytes - 2);
}

function segmentJsonByteLength(segment: CompiledContextSegmentV1): number {
  return segmentJsonByteLengthForContent(segment, boundedJsonStringByteLength(segment.content));
}

function buildHashableContext(
  requestHash: `sha256:${string}`,
  authority: EffectiveAgentAuthority,
  bundle: ResolvedAgentBundle,
  segments: readonly CompiledContextSegmentV1[],
  truncations: readonly ContextTruncationV1[],
  inputBytes: number,
  untrustedBytes: number,
): HashableCompiledContextV1 {
  return {
    protocol_version: "runtime-contract.v1",
    schema_version: "compiled-context.v1",
    document_type: "compiled-context",
    request_hash: requestHash,
    definition: authority.definition as AgentDefinitionReference,
    prompt_template: projectReference(bundle.definition.prompt_template) as PromptTemplateReference,
    task_contract: authority.task_contract as TaskContractReference,
    output_schema: authority.output_schema as OutputSchemaReference,
    authority: {
      logical_class:
        authority.logical_class as HashableCompiledContextV1["authority"]["logical_class"],
      model_capabilities:
        authority.model_capabilities as HashableCompiledContextV1["authority"]["model_capabilities"],
      superpowers: authority.superpowers_capabilities,
      mcp_profile: authority.mcp_profile as McpProfileReference,
      budget: copyBudget(authority.budget),
    },
    runtime_policy: {
      revision: COMPILED_CONTEXT_RUNTIME_POLICY_V1.reference.revision,
      hash: COMPILED_CONTEXT_RUNTIME_POLICY_V1.reference.hash,
    },
    segments,
    accounting: {
      input_tokens: inputBytes,
      input_bytes: inputBytes,
      untrusted_bytes: untrustedBytes,
      remaining_input_tokens: authority.budget.max_input_tokens - inputBytes,
    },
    truncations,
  };
}

function compiledDocumentByteLength(
  requestHash: `sha256:${string}`,
  authority: EffectiveAgentAuthority,
  bundle: ResolvedAgentBundle,
  segmentJsonBytes: number,
  segmentCount: number,
  truncationJsonBytes: number,
  truncationCount: number,
  inputBytes: number,
  untrustedBytes: number,
): number {
  let skeletonBytes: number;
  try {
    const skeleton = {
      ...buildHashableContext(
        requestHash,
        authority,
        bundle,
        Object.freeze([]),
        Object.freeze([]),
        inputBytes,
        untrustedBytes,
      ),
      document_hash: ZERO_HASH,
    };
    skeletonBytes = Buffer.byteLength(canonicalJson(skeleton, AGENT_DOCUMENT_LIMITS), "utf8");
  } catch {
    return unsupportedError();
  }
  return safeSum(
    skeletonBytes,
    segmentJsonBytes,
    Math.max(0, segmentCount - 1),
    truncationJsonBytes,
    Math.max(0, truncationCount - 1),
  );
}

function projectedRepresentation(
  requestHash: `sha256:${string}`,
  authority: EffectiveAgentAuthority,
  bundle: ResolvedAgentBundle,
  state: CompiledRepresentationState,
  segment: CompiledContextSegmentV1,
  candidateJsonBytes: number,
  truncation?: ContextTruncationV1,
): Readonly<{
  inputBytes: number;
  untrustedBytes: number;
  segmentJsonBytes: number;
  truncationJsonBytes: number;
}> {
  const inputBytes = safeSum(state.inputBytes, segment.included_bytes);
  const untrustedBytes = safeSum(
    state.untrustedBytes,
    segment.trust === "untrusted-content" ? segment.included_bytes : 0,
  );
  if (inputBytes > authority.budget.max_input_tokens) {
    contextError("RUNTIME_CONTEXT_OVERFLOW");
  }
  const segmentJsonBytes = safeSum(state.segmentJsonBytes, candidateJsonBytes);
  let truncationJsonBytes = state.truncationJsonBytes;
  if (truncation !== undefined) {
    try {
      truncationJsonBytes = safeSum(
        truncationJsonBytes,
        Buffer.byteLength(canonicalJson(truncation, AGENT_DOCUMENT_LIMITS), "utf8"),
      );
    } catch {
      return integrityError();
    }
  }
  const documentBytes = compiledDocumentByteLength(
    requestHash,
    authority,
    bundle,
    segmentJsonBytes,
    state.segments.length + 1,
    truncationJsonBytes,
    state.truncations.length + (truncation === undefined ? 0 : 1),
    inputBytes,
    untrustedBytes,
  );
  if (documentBytes > AGENT_DOCUMENT_LIMITS.maxBytes) unsupportedError();
  return { inputBytes, untrustedBytes, segmentJsonBytes, truncationJsonBytes };
}

function appendRepresentableSegment(
  requestHash: `sha256:${string}`,
  authority: EffectiveAgentAuthority,
  bundle: ResolvedAgentBundle,
  state: CompiledRepresentationState,
  segment: CompiledContextSegmentV1,
  truncation?: ContextTruncationV1,
): void {
  const projected = projectedRepresentation(
    requestHash,
    authority,
    bundle,
    state,
    segment,
    segmentJsonByteLength(segment),
    truncation,
  );
  state.inputBytes = projected.inputBytes;
  state.untrustedBytes = projected.untrustedBytes;
  state.segmentJsonBytes = projected.segmentJsonBytes;
  state.truncationJsonBytes = projected.truncationJsonBytes;
  state.segments.push(segment);
  if (truncation !== undefined) state.truncations.push(truncation);
}

function assertRawInputCanFit(
  requestHash: `sha256:${string}`,
  authority: EffectiveAgentAuthority,
  bundle: ResolvedAgentBundle,
  state: CompiledRepresentationState,
  requestedReference: ArtifactReference,
  resolved: ResolvedProjection,
): void {
  const minimumContentBytes = resolved.media_type === "text/plain" ? resolved.byte_length : 1;
  const minimumSegment: InputArtifactSegmentV1 = {
    segment_id: `ctx-${"0".repeat(64)}`,
    kind: "input-artifact",
    trust: "untrusted-content",
    source: requestedReference,
    original_hash: requestedReference.hash,
    included_hash: ZERO_HASH,
    original_bytes: minimumContentBytes,
    included_bytes: minimumContentBytes,
    tokens: minimumContentBytes,
    content: "",
  };
  projectedRepresentation(
    requestHash,
    authority,
    bundle,
    state,
    minimumSegment,
    segmentJsonByteLengthForContent(minimumSegment, minimumContentBytes + 2),
  );
}

function buildCompiledContext(
  requestHash: `sha256:${string}`,
  authority: EffectiveAgentAuthority,
  bundle: ResolvedAgentBundle,
  state: CompiledRepresentationState,
): CompiledContextV1 {
  const segments = Object.freeze([...state.segments]);
  const truncations = Object.freeze([...state.truncations]);
  const unsigned = buildHashableContext(
    requestHash,
    authority,
    bundle,
    segments,
    truncations,
    state.inputBytes,
    state.untrustedBytes,
  );

  if (
    compiledDocumentByteLength(
      requestHash,
      authority,
      bundle,
      state.segmentJsonBytes,
      segments.length,
      state.truncationJsonBytes,
      truncations.length,
      state.inputBytes,
      state.untrustedBytes,
    ) > AGENT_DOCUMENT_LIMITS.maxBytes
  ) {
    unsupportedError();
  }

  let document: CompiledContextV1;
  let encoded: string;
  try {
    document = { ...unsigned, document_hash: hashCompiledContext(unsigned) };
    encoded = canonicalJson(document, AGENT_DOCUMENT_LIMITS);
  } catch {
    return integrityError();
  }
  const parsed = parseCompiledContext(encoded);
  if (!parsed.ok) integrityError();
  return parsed.value;
}

function newRepresentationState(): CompiledRepresentationState {
  return {
    segments: [],
    truncations: [],
    segmentJsonBytes: 0,
    truncationJsonBytes: 0,
    inputBytes: 0,
    untrustedBytes: 0,
  };
}

function appendTrustedSegments(
  requestHash: `sha256:${string}`,
  authority: EffectiveAgentAuthority,
  bundle: ResolvedAgentBundle,
  task: NormalizedArtifact,
  output: NormalizedArtifact,
  includeTruncationNotice: boolean,
): CompiledRepresentationState {
  const state = newRepresentationState();
  for (const segment of buildTrustedSegments(bundle, task, output, includeTruncationNotice)) {
    appendRepresentableSegment(requestHash, authority, bundle, state, segment);
  }
  return state;
}

function remaining(ceiling: number, used: number): number {
  if (!Number.isSafeInteger(ceiling) || !Number.isSafeInteger(used) || ceiling < 0 || used < 0) {
    integrityError();
  }
  return used >= ceiling ? 0 : ceiling - used;
}

function allocationCeilings(
  state: CompiledRepresentationState,
  effectiveInputCeiling: number,
  maxUntrustedBytes: number,
  maxDocumentBytes: number,
): Readonly<{
  allowed: number;
  definitionAllowance: number;
  requestAllowance: number;
}> {
  const requestAllowance = remaining(effectiveInputCeiling, state.inputBytes);
  const definitionAllowance = Math.min(
    maxDocumentBytes,
    remaining(maxUntrustedBytes, state.untrustedBytes),
  );
  return {
    allowed: Math.min(requestAllowance, definitionAllowance),
    definitionAllowance,
    requestAllowance,
  };
}

function appendAllocatedInput(
  requestHash: `sha256:${string}`,
  authority: EffectiveAgentAuthority,
  bundle: ResolvedAgentBundle,
  state: CompiledRepresentationState,
  input: NormalizedArtifact,
  allowedBytes: number,
  reason: ContextTruncationV1["reason"],
): boolean {
  const includedContent =
    input.original_bytes <= allowedBytes
      ? input.content
      : utf8PrefixWithinBytes(input.content, allowedBytes);
  const includedBytes = Buffer.byteLength(includedContent, "utf8");
  const shortened = includedBytes < input.original_bytes;
  const record = shortened ? truncationRecord(input, includedBytes, reason) : undefined;
  appendRepresentableSegment(
    requestHash,
    authority,
    bundle,
    state,
    buildInputSegment(input, includedContent),
    record,
  );
  return shortened;
}

export async function compileAgentContext(
  input: CompileAgentContextInput,
): Promise<CompiledContextV1> {
  const projection = projectCompileInput(input);
  const bundle = validatedBundle(projection.bundle);
  const authority = normalizeAuthority(matchAgentAuthority(projection.request, bundle.definition));
  const taskReference = authority.task_contract;
  const outputReference = authority.output_schema;
  const inputReferences = sortedInputReferences(
    projection.request,
    bundle.definition,
    taskReference,
    outputReference,
  );
  if (
    safeSum(inputReferences.length, bundle.prompt_template.instruction_blocks.length, 3) >
    MAX_COMPILED_SEGMENTS
  ) {
    unsupportedError();
  }

  const task = await resolveExactArtifact(projection, taskReference, true);
  const output = await resolveExactArtifact(projection, outputReference, true);
  const effectiveInputCeiling = Math.min(
    authority.budget.max_input_tokens,
    bundle.definition.budget_ceiling.max_input_tokens,
  );
  const maxUntrustedBytes = bundle.definition.context_policy.max_untrusted_bytes;
  let state = appendTrustedSegments(
    projection.request_hash,
    authority,
    bundle,
    task,
    output,
    false,
  );
  if (state.inputBytes > effectiveInputCeiling) contextError("RUNTIME_CONTEXT_OVERFLOW");

  const resolvedInputs: NormalizedArtifact[] = [];
  let firstShortenedIndex = -1;
  for (const [index, candidate] of inputReferences.entries()) {
    const ceilings = allocationCeilings(
      state,
      effectiveInputCeiling,
      maxUntrustedBytes,
      candidate.max_bytes,
    );
    const resolved = await resolveExactArtifact(
      projection,
      candidate.reference,
      false,
      (artifact) => {
        if (artifact.byte_length > 0 && ceilings.allowed === 0) return;
        if (artifact.media_type !== "text/plain" || artifact.byte_length <= ceilings.allowed) {
          assertRawInputCanFit(
            projection.request_hash,
            authority,
            bundle,
            state,
            candidate.reference,
            artifact,
          );
        }
      },
    );
    resolvedInputs.push(resolved);
    if (resolved.original_bytes > ceilings.allowed) {
      firstShortenedIndex = index;
      break;
    }
    appendRepresentableSegment(
      projection.request_hash,
      authority,
      bundle,
      state,
      buildInputSegment(resolved),
    );
  }

  if (firstShortenedIndex === -1) {
    return buildCompiledContext(projection.request_hash, authority, bundle, state);
  }

  state = appendTrustedSegments(projection.request_hash, authority, bundle, task, output, true);
  if (state.inputBytes > effectiveInputCeiling) contextError("RUNTIME_CONTEXT_OVERFLOW");

  let stopReason: ContextTruncationV1["reason"] | undefined;
  for (const [index, resolved] of resolvedInputs.entries()) {
    const candidate = inputReferences[index];
    if (candidate === undefined) integrityError();
    if (stopReason !== undefined) {
      appendAllocatedInput(
        projection.request_hash,
        authority,
        bundle,
        state,
        resolved,
        0,
        stopReason,
      );
      continue;
    }
    const ceilings = allocationCeilings(
      state,
      effectiveInputCeiling,
      maxUntrustedBytes,
      candidate.max_bytes,
    );
    const reason =
      ceilings.definitionAllowance <= ceilings.requestAllowance
        ? "definition-ceiling"
        : "input-budget";
    if (
      appendAllocatedInput(
        projection.request_hash,
        authority,
        bundle,
        state,
        resolved,
        ceilings.allowed,
        reason,
      )
    ) {
      stopReason = reason;
    }
  }
  if (stopReason === undefined) integrityError();

  for (let index = resolvedInputs.length; index < inputReferences.length; index += 1) {
    const candidate = inputReferences[index];
    if (candidate === undefined) integrityError();
    const omitted = await resolveExactArtifact(projection, candidate.reference, false);
    appendAllocatedInput(projection.request_hash, authority, bundle, state, omitted, 0, stopReason);
  }

  return buildCompiledContext(projection.request_hash, authority, bundle, state);
}
