import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonValue,
} from "../protocol/json.js";
import { loadBundledCatalog, type BundledCatalogTestOverride } from "./bundled.js";
import { hashSkillCatalog, hashSkillDescriptor, parseSkillDescriptor } from "./contracts.js";
import { RuntimeSkillError } from "./errors.js";
import { assertConfiguredSkillRootPath, assertSkillRelativePath } from "./paths.js";
import {
  SKILL_LIMITS,
  type SkillDescriptorReference,
  type SkillDescriptorV1,
  type SkillResourceRole,
  type SkillResourceV1,
  type SkillSourceKind,
} from "./types.js";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface SkillMarkdownDeclaration {
  readonly path: "SKILL.md";
  readonly media_type: "text/markdown";
  readonly bytes: number;
  readonly hash: `sha256:${string}`;
}

export interface SkillPackageManifest {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly required_runtime_capabilities: readonly string[];
  readonly skill_markdown: SkillMarkdownDeclaration;
  readonly resources: readonly SkillResourceV1[];
  readonly resource_count: number;
  readonly total_bytes: number;
  readonly package_hash: `sha256:${string}`;
}

export interface SkillDiscoveryRequest {
  readonly query: string | null;
  readonly allowed_capabilities: readonly string[];
}

export interface SkillCatalogSnapshot {
  readonly descriptors: readonly SkillDescriptorV1[];
  readonly catalog_hash: `sha256:${string}`;
}

export interface SkillSelectionRequest {
  readonly mode: "explicit" | "implicit";
  readonly capability: string;
  readonly allowed_capabilities: readonly string[];
  readonly query: string | null;
  readonly descriptor: SkillDescriptorReference | null;
}

export interface SkillSelection {
  readonly descriptor: SkillDescriptorV1;
  readonly catalog_hash: `sha256:${string}`;
  readonly package_handle: `sha256:${string}`;
}

export interface SkillCatalog {
  discover(request: SkillDiscoveryRequest): Promise<SkillCatalogSnapshot>;
  select(snapshot: SkillCatalogSnapshot, request: SkillSelectionRequest): SkillSelection;
}

export interface CatalogFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: number;
  readonly uid: number;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface CatalogTestHooks {
  readonly onFileRead?: ((absolutePath: string) => void) | undefined;
  readonly afterManifestRead?: ((absolutePath: string) => void | Promise<void>) | undefined;
  readonly mapIdentity?:
    ((absolutePath: string, identity: CatalogFileIdentity) => CatalogFileIdentity) | undefined;
}

export interface CreateSkillCatalogOptions {
  readonly configuredRoots: readonly string[];
}

export interface CreateSkillCatalogForTestOptions extends Partial<CreateSkillCatalogOptions> {
  readonly includeBundled?: boolean | undefined;
  readonly bundled?: BundledCatalogTestOverride | undefined;
  readonly currentUid?: number | undefined;
  readonly hooks?: CatalogTestHooks | undefined;
}

interface PrivateCatalogEntry {
  readonly descriptor: SkillDescriptorV1;
  readonly manifest: SkillPackageManifest;
  readonly manifestIdentity: `sha256:${string}`;
  readonly absoluteDirectory: string;
  readonly sourceKind: SkillSourceKind;
}

interface OpenedDirectory {
  readonly handle: FileHandle;
  readonly identity: CatalogFileIdentity;
}

interface CatalogImplementationOptions {
  readonly configuredRoots: readonly string[];
  readonly includeBundled: boolean;
  readonly bundled?: BundledCatalogTestOverride | undefined;
  readonly currentUid: number;
  readonly hooks: CatalogTestHooks;
}

function integrity(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY");
}

function invalid(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_INVALID");
}

function limitExceeded(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_LIMIT_EXCEEDED");
}

function blocked(): never {
  throw new RuntimeSkillError("BLOCKED_SUPERPOWERS_MISSING");
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function hasExactKeys(
  value: { readonly [key: string]: JsonValue },
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(bytewiseCompare);
  const expected = [...keys].sort(bytewiseCompare);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requiredMember(value: { readonly [key: string]: JsonValue }, key: string): JsonValue {
  const member = value[key];
  if (member === undefined) integrity();
  return member;
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function isNestedPath(ancestor: string, descendant: string): boolean {
  const relative = path.relative(ancestor, descendant);
  return relative !== "" && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`);
}

function validatedConfiguredRoots(roots: readonly string[]): readonly string[] {
  if (!Array.isArray(roots)) invalid();
  if (roots.length > SKILL_LIMITS.roots) limitExceeded();
  const validated: string[] = [];
  for (const root of roots) {
    if (typeof root !== "string") invalid();
    try {
      validated.push(assertConfiguredSkillRootPath(root));
    } catch {
      integrity();
    }
  }
  if (!isOrderedUnique(validated)) integrity();
  for (let index = 0; index < validated.length; index += 1) {
    for (let nested = index + 1; nested < validated.length; nested += 1) {
      if (isNestedPath(validated[index]!, validated[nested]!)) integrity();
    }
  }
  return validated;
}

function isOrderedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || bytewiseCompare(values[index - 1]!, value) < 0,
  );
}

function isSafeCount(value: JsonValue, maximum: number): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0 && value <= maximum;
}

function isHash(value: JsonValue): value is `sha256:${string}` {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function parseResources(value: JsonValue): readonly SkillResourceV1[] {
  if (!isJsonArray(value) || value.length > SKILL_LIMITS.resourcesPerPackage) integrity();
  const resources: SkillResourceV1[] = [];
  for (const member of value) {
    if (!isRecord(member) || !hasExactKeys(member, ["path", "role", "media_type", "bytes", "hash"]))
      integrity();
    const resourcePath = requiredMember(member, "path");
    const role = requiredMember(member, "role");
    const mediaType = requiredMember(member, "media_type");
    const bytes = requiredMember(member, "bytes");
    const hash = requiredMember(member, "hash");
    if (
      typeof resourcePath !== "string" ||
      typeof role !== "string" ||
      !(["reference", "asset", "script"] as readonly string[]).includes(role) ||
      typeof mediaType !== "string" ||
      !MEDIA_TYPE_PATTERN.test(mediaType) ||
      !isSafeCount(bytes, SKILL_LIMITS.resourceBytes) ||
      !isHash(hash)
    ) {
      integrity();
    }
    let portablePath: string;
    try {
      portablePath = assertSkillRelativePath(resourcePath);
    } catch {
      integrity();
    }
    if (portablePath === "SKILL.md") integrity();
    resources.push({
      path: portablePath,
      role: role as SkillResourceRole,
      media_type: mediaType,
      bytes,
      hash,
    });
  }
  if (!isOrderedUnique(resources.map((resource) => resource.path))) integrity();
  return resources;
}

export function parseSkillPackageManifest(value: JsonValue): SkillPackageManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "name",
      "description",
      "version",
      "required_runtime_capabilities",
      "skill_markdown",
      "resources",
      "resource_count",
      "total_bytes",
      "package_hash",
    ])
  ) {
    integrity();
  }

  const name = requiredMember(value, "name");
  const description = requiredMember(value, "description");
  const version = requiredMember(value, "version");
  const capabilities = requiredMember(value, "required_runtime_capabilities");
  const skillMarkdown = requiredMember(value, "skill_markdown");
  const resourceValue = requiredMember(value, "resources");
  const resourceCount = requiredMember(value, "resource_count");
  const declaredTotalBytes = requiredMember(value, "total_bytes");
  const declaredPackageHash = requiredMember(value, "package_hash");
  if (
    typeof name !== "string" ||
    !NAME_PATTERN.test(name) ||
    Buffer.byteLength(name) > 128 ||
    typeof description !== "string" ||
    description.trim() !== description ||
    description.length === 0 ||
    Buffer.byteLength(description) > 4096 ||
    typeof version !== "string" ||
    !VERSION_PATTERN.test(version) ||
    !Array.isArray(capabilities) ||
    capabilities.length > SKILL_LIMITS.resourcesPerPackage ||
    !capabilities.every((entry) => typeof entry === "string" && NAME_PATTERN.test(entry)) ||
    !isOrderedUnique(capabilities as readonly string[]) ||
    !isRecord(skillMarkdown) ||
    !hasExactKeys(skillMarkdown, ["path", "media_type", "bytes", "hash"]) ||
    skillMarkdown.path !== "SKILL.md" ||
    skillMarkdown.media_type !== "text/markdown" ||
    !isSafeCount(requiredMember(skillMarkdown, "bytes"), SKILL_LIMITS.skillMarkdownBytes) ||
    requiredMember(skillMarkdown, "bytes") === 0 ||
    !isHash(requiredMember(skillMarkdown, "hash")) ||
    !isSafeCount(resourceCount, SKILL_LIMITS.resourcesPerPackage) ||
    !isSafeCount(declaredTotalBytes, SKILL_LIMITS.packageBytes) ||
    !isHash(declaredPackageHash)
  ) {
    integrity();
  }

  const skillMarkdownBytes = requiredMember(skillMarkdown, "bytes") as number;
  const skillMarkdownHash = requiredMember(skillMarkdown, "hash") as `sha256:${string}`;
  const resources = parseResources(resourceValue);
  const resourceBytes = resources.reduce((total, resource) => total + resource.bytes, 0);
  const totalBytes = skillMarkdownBytes + resourceBytes;
  if (
    resourceCount !== resources.length ||
    declaredTotalBytes !== totalBytes ||
    totalBytes > SKILL_LIMITS.packageBytes
  ) {
    integrity();
  }
  const manifest: SkillPackageManifest = {
    name,
    description,
    version,
    required_runtime_capabilities: capabilities as readonly string[],
    skill_markdown: {
      path: "SKILL.md",
      media_type: "text/markdown",
      bytes: skillMarkdownBytes,
      hash: skillMarkdownHash,
    },
    resources,
    resource_count: resources.length,
    total_bytes: totalBytes,
    package_hash: declaredPackageHash,
  };
  const expectedHash = sha256({
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    required_runtime_capabilities: manifest.required_runtime_capabilities,
    skill_markdown_bytes: manifest.skill_markdown.bytes,
    skill_markdown_hash: manifest.skill_markdown.hash,
    resources: manifest.resources.map((resource) => ({
      path: resource.path,
      role: resource.role,
      media_type: resource.media_type,
      bytes: resource.bytes,
      hash: resource.hash,
    })),
  });
  if (manifest.package_hash !== expectedHash) integrity();
  return deepFreezeJson(manifest as unknown as JsonValue) as unknown as SkillPackageManifest;
}

function identityFromStats(stats: Awaited<ReturnType<FileHandle["stat"]>>): CatalogFileIdentity {
  const value = stats as unknown as {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mode: bigint;
    readonly uid: bigint;
    readonly nlink: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  };
  return {
    dev: value.dev,
    ino: value.ino,
    mode: Number(value.mode),
    uid: Number(value.uid),
    nlink: value.nlink,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

async function pathIdentity(
  absolutePath: string,
  hooks: CatalogTestHooks,
): Promise<CatalogFileIdentity> {
  const stats = await lstat(absolutePath, { bigint: true });
  const identity = identityFromStats(stats);
  return hooks.mapIdentity?.(absolutePath, identity) ?? identity;
}

async function handleIdentity(
  handle: FileHandle,
  absolutePath: string,
  hooks: CatalogTestHooks,
): Promise<CatalogFileIdentity> {
  const identity = identityFromStats(await handle.stat({ bigint: true }));
  return hooks.mapIdentity?.(absolutePath, identity) ?? identity;
}

function sameIdentity(left: CatalogFileIdentity, right: CatalogFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isFileMode(mode: number): boolean {
  return (mode & constants.S_IFMT) === constants.S_IFREG;
}

function isDirectoryMode(mode: number): boolean {
  return (mode & constants.S_IFMT) === constants.S_IFDIR;
}

function assertPrivateDirectory(identity: CatalogFileIdentity, currentUid: number): void {
  if (
    !isDirectoryMode(identity.mode) ||
    identity.uid !== currentUid ||
    (identity.mode & 0o7777) !== DIRECTORY_MODE
  )
    integrity();
}

function assertPrivateManifest(identity: CatalogFileIdentity, currentUid: number): void {
  if (
    !isFileMode(identity.mode) ||
    identity.uid !== currentUid ||
    (identity.mode & 0o7777) !== PRIVATE_FILE_MODE ||
    identity.nlink !== 1n ||
    identity.size < 1n ||
    identity.size > BigInt(SKILL_LIMITS.descriptorBytes)
  ) {
    integrity();
  }
}

async function assertNoSymlinkAncestry(absolutePath: string): Promise<void> {
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const component of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const identity = await lstat(current, { bigint: true });
    if ((Number(identity.mode) & constants.S_IFMT) === constants.S_IFLNK) integrity();
  }
}

async function openPrivateDirectory(
  absolutePath: string,
  currentUid: number,
  hooks: CatalogTestHooks,
): Promise<OpenedDirectory> {
  await assertNoSymlinkAncestry(absolutePath);
  const before = await pathIdentity(absolutePath, hooks);
  assertPrivateDirectory(before, currentUid);
  let handle: FileHandle;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    integrity();
  }
  const held = await handleIdentity(handle, absolutePath, hooks);
  if (!sameIdentity(before, held)) {
    await handle.close();
    integrity();
  }
  return { handle, identity: held };
}

async function revalidateDirectory(
  opened: OpenedDirectory,
  absolutePath: string,
  hooks: CatalogTestHooks,
): Promise<void> {
  const held = await handleIdentity(opened.handle, absolutePath, hooks);
  const named = await pathIdentity(absolutePath, hooks);
  if (!sameIdentity(opened.identity, held) || !sameIdentity(opened.identity, named)) integrity();
}

async function readBoundedPrivateManifest(
  absolutePath: string,
  currentUid: number,
  hooks: CatalogTestHooks,
): Promise<{ readonly bytes: Uint8Array; readonly identity: CatalogFileIdentity }> {
  let namedBefore: CatalogFileIdentity;
  try {
    namedBefore = await pathIdentity(absolutePath, hooks);
  } catch {
    integrity();
  }
  assertPrivateManifest(namedBefore, currentUid);
  let handle: FileHandle;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch {
    integrity();
  }
  try {
    const before = await handleIdentity(handle, absolutePath, hooks);
    assertPrivateManifest(before, currentUid);
    if (!sameIdentity(before, namedBefore)) integrity();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    hooks.onFileRead?.(absolutePath);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== Number(before.size)) integrity();
    await hooks.afterManifestRead?.(absolutePath);
    const after = await handleIdentity(handle, absolutePath, hooks);
    const namedAfter = await pathIdentity(absolutePath, hooks);
    if (!sameIdentity(before, after) || !sameIdentity(before, namedAfter)) integrity();
    return { bytes: buffer.subarray(0, offset), identity: before };
  } finally {
    await handle.close();
  }
}

function rawHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function descriptorFor(
  manifest: SkillPackageManifest,
  source: SkillDescriptorV1["source"],
): SkillDescriptorV1 {
  const hashable = {
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "skill-descriptor.v1" as const,
    document_type: "skill-descriptor" as const,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    source,
    package_hash: manifest.package_hash,
    resource_count: manifest.resource_count,
    total_bytes: manifest.total_bytes,
    required_runtime_capabilities: manifest.required_runtime_capabilities,
  };
  const candidate: SkillDescriptorV1 = { ...hashable, document_hash: sha256(hashable) };
  if (candidate.document_hash !== hashSkillDescriptor(candidate)) integrity();
  const parsed = parseSkillDescriptor(canonicalJson(candidate));
  if (!parsed.ok) integrity();
  return parsed.value;
}

function configuredSourceIdentity(
  root: CatalogFileIdentity,
  packageDirectory: CatalogFileIdentity,
): `sha256:${string}` {
  return sha256({
    root: { dev: root.dev.toString(), ino: root.ino.toString() },
    package: { dev: packageDirectory.dev.toString(), ino: packageDirectory.ino.toString() },
  });
}

async function configuredEntries(
  options: CatalogImplementationOptions,
): Promise<readonly PrivateCatalogEntry[]> {
  const entries: PrivateCatalogEntry[] = [];
  for (const root of validatedConfiguredRoots(options.configuredRoots)) {
    const openedRoot = await openPrivateDirectory(root, options.currentUid, options.hooks);
    try {
      const packageNames: string[] = [];
      const directory = await opendir(root);
      for await (const entry of directory) {
        packageNames.push(entry.name);
        if (packageNames.length > SKILL_LIMITS.packagesPerRoot) limitExceeded();
      }
      packageNames.sort(bytewiseCompare);
      const packageIdentities = new Set<string>();
      for (const packageName of packageNames) {
        if (!NAME_PATTERN.test(packageName)) integrity();
        const packagePath = path.join(root, packageName);
        const openedPackage = await openPrivateDirectory(
          packagePath,
          options.currentUid,
          options.hooks,
        );
        try {
          const aliasKey = `${openedPackage.identity.dev}:${openedPackage.identity.ino}`;
          if (packageIdentities.has(aliasKey)) integrity();
          packageIdentities.add(aliasKey);
          const manifestPath = path.join(packagePath, "skill.json");
          const read = await readBoundedPrivateManifest(
            manifestPath,
            options.currentUid,
            options.hooks,
          );
          let parsed: JsonValue;
          try {
            parsed = parseJsonBytes(read.bytes, {
              maxBytes: SKILL_LIMITS.descriptorBytes,
              maxDepth: SKILL_LIMITS.nestingDepth,
              maxMembers: 4096,
            });
          } catch {
            integrity();
          }
          const manifest = parseSkillPackageManifest(parsed);
          if (manifest.name !== packageName) integrity();
          const sourceIdentity = configuredSourceIdentity(
            openedRoot.identity,
            openedPackage.identity,
          );
          entries.push({
            descriptor: descriptorFor(manifest, { kind: "configured", identity: sourceIdentity }),
            manifest,
            manifestIdentity: rawHash(read.bytes),
            absoluteDirectory: packagePath,
            sourceKind: "configured",
          });
          await revalidateDirectory(openedPackage, packagePath, options.hooks);
        } finally {
          await openedPackage.handle.close();
        }
      }
      await revalidateDirectory(openedRoot, root, options.hooks);
    } finally {
      await openedRoot.handle.close();
    }
  }
  return entries;
}

function normalizedMetadata(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

function validateQuery(query: string | null): string | null {
  if (query === null) return null;
  if (Buffer.byteLength(query) > SKILL_LIMITS.queryBytes) limitExceeded();
  if (/\p{Cc}/u.test(query)) invalid();
  const normalized = normalizedMetadata(query);
  if (normalized.length === 0) invalid();
  return normalized;
}

function capabilitySet(values: readonly string[]): ReadonlySet<string> {
  if (values.length > SKILL_LIMITS.resourcesPerPackage) limitExceeded();
  const result = new Set<string>();
  for (const value of values) {
    if (!NAME_PATTERN.test(value) || result.has(value)) invalid();
    result.add(value);
  }
  return result;
}

function metadataMatches(descriptor: SkillDescriptorV1, query: string | null): boolean {
  if (query === null) return true;
  return normalizedMetadata(`${descriptor.name} ${descriptor.description}`).includes(query);
}

function referenceOf(descriptor: SkillDescriptorV1): SkillDescriptorReference {
  return {
    name: descriptor.name,
    version: descriptor.version,
    source: descriptor.source,
    package_hash: descriptor.package_hash,
    document_hash: descriptor.document_hash,
  };
}

function exactReference(left: SkillDescriptorReference, right: SkillDescriptorReference): boolean {
  return (
    left.name === right.name &&
    left.version === right.version &&
    left.source.kind === right.source.kind &&
    left.source.identity === right.source.identity &&
    left.package_hash === right.package_hash &&
    left.document_hash === right.document_hash
  );
}

function isClosedDataObject(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort(bytewiseCompare);
  const expected = [...expectedKeys].sort(bytewiseCompare);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return false;
  }
  return Object.values(descriptors).every(
    (descriptor) =>
      descriptor.enumerable === true &&
      descriptor.get === undefined &&
      descriptor.set === undefined,
  );
}

function assertDescriptorReference(value: unknown): asserts value is SkillDescriptorReference {
  if (
    !isClosedDataObject(value, ["name", "version", "source", "package_hash", "document_hash"]) ||
    typeof value.name !== "string" ||
    !NAME_PATTERN.test(value.name) ||
    typeof value.version !== "string" ||
    !VERSION_PATTERN.test(value.version) ||
    typeof value.package_hash !== "string" ||
    !HASH_PATTERN.test(value.package_hash) ||
    typeof value.document_hash !== "string" ||
    !HASH_PATTERN.test(value.document_hash) ||
    !isClosedDataObject(value.source, ["kind", "identity"]) ||
    (value.source.kind !== "configured" && value.source.kind !== "bundled") ||
    typeof value.source.identity !== "string" ||
    !HASH_PATTERN.test(value.source.identity)
  ) {
    invalid();
  }
}

function entryOrder(left: PrivateCatalogEntry, right: PrivateCatalogEntry): number {
  const fields: readonly [string, string][] = [
    [left.descriptor.name, right.descriptor.name],
    [left.descriptor.version, right.descriptor.version],
    [left.descriptor.source.kind, right.descriptor.source.kind],
    [left.descriptor.source.identity, right.descriptor.source.identity],
    [left.descriptor.package_hash, right.descriptor.package_hash],
  ];
  for (const [leftField, rightField] of fields) {
    const order = bytewiseCompare(leftField, rightField);
    if (order !== 0) return order;
  }
  return bytewiseCompare(left.descriptor.document_hash, right.descriptor.document_hash);
}

function deduplicateEntries(
  entries: readonly PrivateCatalogEntry[],
): readonly PrivateCatalogEntry[] {
  const semantic = new Map<string, PrivateCatalogEntry>();
  for (const entry of entries) {
    const key = canonicalJson({
      name: entry.descriptor.name,
      version: entry.descriptor.version,
      source: entry.descriptor.source,
    });
    const prior = semantic.get(key);
    if (prior === undefined) {
      semantic.set(key, entry);
      continue;
    }
    if (
      prior.descriptor.package_hash !== entry.descriptor.package_hash ||
      prior.descriptor.document_hash !== entry.descriptor.document_hash
    ) {
      integrity();
    }
  }
  return [...semantic.values()].sort(entryOrder);
}

class FileSystemSkillCatalog implements SkillCatalog {
  private readonly snapshots = new WeakMap<
    SkillCatalogSnapshot,
    ReadonlyMap<string, PrivateCatalogEntry>
  >();

  constructor(private readonly options: CatalogImplementationOptions) {}

  async discover(request: SkillDiscoveryRequest): Promise<SkillCatalogSnapshot> {
    const query = validateQuery(request.query);
    const allowed = capabilitySet(request.allowed_capabilities);
    let configured: readonly PrivateCatalogEntry[];
    try {
      configured = await configuredEntries(this.options);
    } catch (error) {
      if (error instanceof RuntimeSkillError) throw error;
      integrity();
    }
    const bundledRecords = this.options.includeBundled
      ? await loadBundledCatalog({
          ...(this.options.bundled === undefined ? {} : { override: this.options.bundled }),
          hooks: this.options.hooks,
        })
      : [];
    const bundled: PrivateCatalogEntry[] = bundledRecords.map((entry) => ({
      descriptor: descriptorFor(entry.manifest, {
        kind: "bundled",
        identity: entry.sourceIdentity,
      }),
      manifest: entry.manifest,
      manifestIdentity: entry.manifestIdentity,
      absoluteDirectory: entry.absoluteDirectory,
      sourceKind: "bundled",
    }));
    const entries = deduplicateEntries([...configured, ...bundled]);
    const selected = entries.filter(
      (entry) =>
        entry.descriptor.required_runtime_capabilities.every((capability) =>
          allowed.has(capability),
        ) && metadataMatches(entry.descriptor, query),
    );
    const descriptors = selected.map((entry) => entry.descriptor);
    const catalogHash = hashSkillCatalog(descriptors.map(referenceOf));
    const snapshot = deepFreezeJson({
      descriptors,
      catalog_hash: catalogHash,
    } as unknown as JsonValue) as unknown as SkillCatalogSnapshot;
    this.snapshots.set(
      snapshot,
      new Map(selected.map((entry) => [entry.descriptor.document_hash, entry])),
    );
    return snapshot;
  }

  select(snapshot: SkillCatalogSnapshot, request: SkillSelectionRequest): SkillSelection {
    const entries = this.snapshots.get(snapshot);
    if (entries === undefined) invalid();
    const query = validateQuery(request.query);
    const allowed = capabilitySet(request.allowed_capabilities);
    if (!NAME_PATTERN.test(request.capability)) invalid();

    let candidates: PrivateCatalogEntry[];
    if (request.mode === "explicit") {
      if (request.descriptor === null) invalid();
      assertDescriptorReference(request.descriptor);
      candidates = [...entries.values()].filter(
        (entry) =>
          exactReference(referenceOf(entry.descriptor), request.descriptor!) &&
          entry.descriptor.name === request.capability &&
          allowed.has(request.capability) &&
          entry.descriptor.required_runtime_capabilities.every((capability) =>
            allowed.has(capability),
          ) &&
          metadataMatches(entry.descriptor, query),
      );
      if (candidates.length !== 1) blocked();
    } else if (request.mode === "implicit") {
      if (request.descriptor !== null) invalid();
      candidates = [...entries.values()].filter(
        (entry) =>
          allowed.has(request.capability) &&
          entry.descriptor.name === request.capability &&
          entry.descriptor.required_runtime_capabilities.every((capability) =>
            allowed.has(capability),
          ) &&
          metadataMatches(entry.descriptor, query),
      );
      if (candidates.length === 0) blocked();
      if (candidates.length > 1) integrity();
    } else {
      invalid();
    }

    const entry = candidates[0]!;
    const packageHandle = sha256({
      catalog_hash: snapshot.catalog_hash,
      descriptor: referenceOf(entry.descriptor),
      manifest_identity: entry.manifestIdentity,
    });
    return deepFreezeJson({
      descriptor: entry.descriptor,
      catalog_hash: snapshot.catalog_hash,
      package_handle: packageHandle,
    } as unknown as JsonValue) as unknown as SkillSelection;
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) integrity();
  return uid;
}

export function createSkillCatalog(options: CreateSkillCatalogOptions): SkillCatalog {
  return new FileSystemSkillCatalog({
    configuredRoots: [...options.configuredRoots],
    includeBundled: true,
    currentUid: currentUid(),
    hooks: {},
  });
}

export function createSkillCatalogForTest(
  options: CreateSkillCatalogForTestOptions = {},
): SkillCatalog {
  return new FileSystemSkillCatalog({
    configuredRoots: [...(options.configuredRoots ?? [])],
    includeBundled: options.includeBundled ?? true,
    ...(options.bundled === undefined ? {} : { bundled: options.bundled }),
    currentUid: options.currentUid ?? currentUid(),
    hooks: options.hooks ?? {},
  });
}
