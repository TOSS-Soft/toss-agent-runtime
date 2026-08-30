import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";

import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonValue,
} from "../protocol/json.js";
import {
  BUNDLED_MANIFEST_PATH,
  loadBundledCatalog,
  type BundledCatalogTestOverride,
} from "./bundled.js";
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

export type ConfiguredCatalogBoundary =
  | "root-open"
  | "root-enumerate"
  | "package-open"
  | "package-enumerate"
  | "manifest-open"
  | "manifest-read"
  | "member-stat"
  | "package-final-revalidate";

export interface CatalogTestHooks {
  readonly onFileRead?: ((absolutePath: string) => void) | undefined;
  readonly afterManifestRead?: ((absolutePath: string) => void | Promise<void>) | undefined;
  readonly mapIdentity?:
    ((absolutePath: string, identity: CatalogFileIdentity) => CatalogFileIdentity) | undefined;
  readonly beforeConfiguredBoundary?:
    | ((boundary: ConfiguredCatalogBoundary, absolutePath: string) => void | Promise<void>)
    | undefined;
  readonly afterConfiguredBoundary?:
    | ((boundary: ConfiguredCatalogBoundary, absolutePath: string) => void | Promise<void>)
    | undefined;
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
  readonly source: InternalSkillPackageSource;
}

/** @internal Retained authority passed only from the catalog to the loader. */
export interface InternalSkillDirectorySnapshot {
  readonly absolutePath: string;
  readonly identity: CatalogFileIdentity;
}

/** @internal Retained authority passed only from the catalog to the loader. */
export interface InternalSkillPackageSource {
  readonly absoluteDirectory: string;
  readonly sourceKind: SkillSourceKind;
  readonly currentUid: number;
  readonly configuredRoot: string | null;
  readonly manifest: SkillPackageManifest;
  readonly manifestPath: string;
  readonly manifestHash: `sha256:${string}`;
  readonly manifestFileIdentity: CatalogFileIdentity;
  readonly packageChain: readonly InternalSkillDirectorySnapshot[];
}

interface HeldDirectory {
  readonly descriptor: number;
  readonly absolutePath: string;
  readonly identity: CatalogFileIdentity;
}

interface HeldManifest {
  readonly descriptor: number;
  readonly absolutePath: string;
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

function identityFromStats(value: BigIntStats): CatalogFileIdentity {
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

function syncPathIdentity(absolutePath: string, hooks: CatalogTestHooks): CatalogFileIdentity {
  const identity = identityFromStats(lstatSync(absolutePath, { bigint: true }));
  return hooks.mapIdentity?.(absolutePath, identity) ?? identity;
}

function syncDescriptorIdentity(
  descriptor: number,
  absolutePath: string,
  hooks: CatalogTestHooks,
): CatalogFileIdentity {
  const identity = identityFromStats(fstatSync(descriptor, { bigint: true }));
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

function sameDirectoryIdentity(left: CatalogFileIdentity, right: CatalogFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
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

function assertPrivateMember(
  identity: CatalogFileIdentity,
  currentUid: number,
  expectedBytes: number,
): void {
  if (
    !isFileMode(identity.mode) ||
    identity.uid !== currentUid ||
    (identity.mode & 0o7777) !== PRIVATE_FILE_MODE ||
    identity.nlink !== 1n ||
    identity.size !== BigInt(expectedBytes)
  ) {
    integrity();
  }
}

function configuredAncestorPaths(absolutePath: string): readonly string[] {
  const parsed = path.parse(absolutePath);
  const result = [parsed.root];
  let current = parsed.root;
  for (const component of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    result.push(current);
  }
  return result;
}

function revalidateHeldChain(chain: readonly HeldDirectory[], hooks: CatalogTestHooks): void {
  for (const held of chain) {
    const descriptorIdentity = syncDescriptorIdentity(held.descriptor, held.absolutePath, hooks);
    const pathIdentity = syncPathIdentity(held.absolutePath, hooks);
    if (
      !sameDirectoryIdentity(held.identity, descriptorIdentity) ||
      !sameDirectoryIdentity(held.identity, pathIdentity)
    ) {
      integrity();
    }
  }
}

function revalidateHeldManifest(
  manifest: HeldManifest,
  chain: readonly HeldDirectory[],
  hooks: CatalogTestHooks,
): void {
  const descriptorBefore = syncDescriptorIdentity(
    manifest.descriptor,
    manifest.absolutePath,
    hooks,
  );
  const pathIdentity = syncSandwich(chain, hooks, () =>
    syncPathIdentity(manifest.absolutePath, hooks),
  );
  const descriptorAfter = syncDescriptorIdentity(manifest.descriptor, manifest.absolutePath, hooks);
  if (
    !sameIdentity(manifest.identity, descriptorBefore) ||
    !sameIdentity(manifest.identity, descriptorAfter) ||
    !sameIdentity(manifest.identity, pathIdentity)
  ) {
    integrity();
  }
}

/*
 * Node does not expose openat(2)/fdopendir(3). Each pathname syscall is therefore
 * enclosed in a synchronous held-chain validation sandwich. A same-UID external
 * actor could theoretically switch and restore a name entirely inside that
 * non-yielding syscall interval; the controller accepts this Node platform limit.
 */
function syncSandwich<T>(
  chain: readonly HeldDirectory[],
  hooks: CatalogTestHooks,
  operation: () => T,
): T {
  revalidateHeldChain(chain, hooks);
  const result = operation();
  revalidateHeldChain(chain, hooks);
  return result;
}

function openHeldDirectorySync(
  absolutePath: string,
  parentChain: readonly HeldDirectory[],
  hooks: CatalogTestHooks,
): HeldDirectory {
  const before = syncSandwich(parentChain, hooks, () => syncPathIdentity(absolutePath, hooks));
  if (!isDirectoryMode(before.mode)) integrity();
  const descriptor = syncSandwich(parentChain, hooks, () =>
    openSync(absolutePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
  );
  try {
    const held = syncDescriptorIdentity(descriptor, absolutePath, hooks);
    const namedAfter = syncSandwich(parentChain, hooks, () =>
      syncPathIdentity(absolutePath, hooks),
    );
    if (!sameDirectoryIdentity(before, held) || !sameDirectoryIdentity(before, namedAfter)) {
      integrity();
    }
    return { descriptor, absolutePath, identity: held };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function openHeldManifestSync(
  absolutePath: string,
  chain: readonly HeldDirectory[],
  currentUid: number,
  hooks: CatalogTestHooks,
): HeldManifest {
  const before = syncSandwich(chain, hooks, () => syncPathIdentity(absolutePath, hooks));
  assertPrivateManifest(before, currentUid);
  const descriptor = syncSandwich(chain, hooks, () =>
    openSync(absolutePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW),
  );
  try {
    const held = syncDescriptorIdentity(descriptor, absolutePath, hooks);
    const namedAfter = syncSandwich(chain, hooks, () => syncPathIdentity(absolutePath, hooks));
    assertPrivateManifest(held, currentUid);
    if (!sameIdentity(before, held) || !sameIdentity(before, namedAfter)) integrity();
    return { descriptor, absolutePath, identity: held };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function closeHeldDirectories(chain: readonly HeldDirectory[]): void {
  for (const held of [...chain].reverse()) closeSync(held.descriptor);
}

function retainedDirectoryChain(
  chain: readonly HeldDirectory[],
): readonly InternalSkillDirectorySnapshot[] {
  return chain.map((held) => ({
    absolutePath: held.absolutePath,
    identity: held.identity,
  }));
}

function captureDirectoryChain(
  absoluteDirectory: string,
  hooks: CatalogTestHooks,
): readonly InternalSkillDirectorySnapshot[] {
  const chain: HeldDirectory[] = [];
  try {
    for (const candidate of configuredAncestorPaths(absoluteDirectory)) {
      chain.push(openHeldDirectorySync(candidate, chain, hooks));
    }
    return retainedDirectoryChain(chain);
  } finally {
    closeHeldDirectories(chain);
  }
}

function readDirectoryNamesSync(
  absolutePath: string,
  chain: readonly HeldDirectory[],
  hooks: CatalogTestHooks,
  maximumEntries: number,
): readonly string[] {
  return syncSandwich(chain, hooks, () => {
    const directory = opendirSync(absolutePath);
    const names: string[] = [];
    try {
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) break;
        names.push(entry.name);
        if (names.length > maximumEntries) limitExceeded();
      }
    } finally {
      directory.closeSync();
    }
    return names.sort(bytewiseCompare);
  });
}

function readHeldManifestSync(
  manifest: HeldManifest,
  chain: readonly HeldDirectory[],
  hooks: CatalogTestHooks,
): Uint8Array {
  const bytes = syncSandwich(chain, hooks, () => {
    const buffer = Buffer.alloc(Number(manifest.identity.size) + 1);
    hooks.onFileRead?.(manifest.absolutePath);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(
        manifest.descriptor,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== Number(manifest.identity.size)) integrity();
    return buffer.subarray(0, offset);
  });
  revalidateHeldManifest(manifest, chain, hooks);
  return bytes;
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

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

async function configuredBoundary<T>(
  boundary: ConfiguredCatalogBoundary,
  absolutePath: string,
  chain: readonly HeldDirectory[],
  hooks: CatalogTestHooks,
  operation: () => T,
  postHookValidation: (result: T) => void,
): Promise<T> {
  await hooks.beforeConfiguredBoundary?.(boundary, absolutePath);
  const result = operation();
  await hooks.afterConfiguredBoundary?.(boundary, absolutePath);
  revalidateHeldChain(chain, hooks);
  postHookValidation(result);
  return result;
}

async function openConfiguredDirectoryBoundary(
  boundary: "root-open" | "package-open" | "member-stat",
  absolutePath: string,
  parentChain: readonly HeldDirectory[],
  hooks: CatalogTestHooks,
  additionalPostHookValidation: () => void = () => undefined,
): Promise<HeldDirectory> {
  let opened: HeldDirectory | undefined;
  try {
    opened = await configuredBoundary(
      boundary,
      absolutePath,
      parentChain,
      hooks,
      () => {
        opened = openHeldDirectorySync(absolutePath, parentChain, hooks);
        return opened;
      },
      (result) => {
        revalidateHeldChain([...parentChain, result], hooks);
        additionalPostHookValidation();
      },
    );
    return opened;
  } catch (error) {
    if (opened !== undefined) closeSync(opened.descriptor);
    throw error;
  }
}

async function enumerateConfiguredDirectoryBoundary(
  boundary: "root-enumerate" | "package-enumerate" | "member-stat",
  absolutePath: string,
  chain: readonly HeldDirectory[],
  hooks: CatalogTestHooks,
  maximumEntries: number,
  additionalPostHookValidation: () => void = () => undefined,
): Promise<readonly string[]> {
  return configuredBoundary(
    boundary,
    absolutePath,
    chain,
    hooks,
    () => readDirectoryNamesSync(absolutePath, chain, hooks, maximumEntries),
    (result) => {
      const current = readDirectoryNamesSync(absolutePath, chain, hooks, maximumEntries);
      if (!sameNames(result, current)) integrity();
      additionalPostHookValidation();
    },
  );
}

async function openConfiguredManifestBoundary(
  absolutePath: string,
  chain: readonly HeldDirectory[],
  currentUid: number,
  packageEntries: readonly string[],
  hooks: CatalogTestHooks,
  additionalPostHookValidation: () => void,
): Promise<HeldManifest> {
  let opened: HeldManifest | undefined;
  try {
    opened = await configuredBoundary(
      "manifest-open",
      absolutePath,
      chain,
      hooks,
      () => {
        opened = openHeldManifestSync(absolutePath, chain, currentUid, hooks);
        return opened;
      },
      (result) => {
        revalidateHeldManifest(result, chain, hooks);
        const current = readDirectoryNamesSync(
          path.dirname(absolutePath),
          chain,
          hooks,
          SKILL_LIMITS.resourcesPerPackage + 2,
        );
        if (!sameNames(packageEntries, current)) integrity();
        additionalPostHookValidation();
      },
    );
    return opened;
  } catch (error) {
    if (opened !== undefined) closeSync(opened.descriptor);
    throw error;
  }
}

interface ExpectedDirectory {
  readonly directories: Map<string, ExpectedDirectory>;
  readonly files: Map<string, number>;
}

interface RetainedConfiguredDirectorySnapshot {
  readonly absolutePath: string;
  readonly identity: CatalogFileIdentity;
  readonly expectedEntries: readonly string[];
  readonly directories: RetainedConfiguredDirectorySnapshot[];
  readonly members: RetainedConfiguredMemberSnapshot[];
}

interface RetainedConfiguredMemberSnapshot {
  readonly absolutePath: string;
  readonly identity: CatalogFileIdentity;
}

interface RetainedConfiguredSnapshotContainer {
  readonly directories: RetainedConfiguredDirectorySnapshot[];
  readonly members: RetainedConfiguredMemberSnapshot[];
}

interface RetainedConfiguredClosure extends RetainedConfiguredSnapshotContainer {
  count: number;
}

const MAX_CONFIGURED_CLOSURE_SNAPSHOTS =
  SKILL_LIMITS.resourcesPerPackage * SKILL_LIMITS.nestingDepth + 1;

function retainConfiguredSnapshot(
  closure: RetainedConfiguredClosure,
  container: RetainedConfiguredSnapshotContainer,
  snapshot: RetainedConfiguredDirectorySnapshot | RetainedConfiguredMemberSnapshot,
): void {
  if (closure.count >= MAX_CONFIGURED_CLOSURE_SNAPSHOTS) limitExceeded();
  closure.count += 1;
  if ("expectedEntries" in snapshot) container.directories.push(snapshot);
  else container.members.push(snapshot);
}

function revalidateConfiguredSnapshots(
  closure: RetainedConfiguredClosure,
  packageChain: readonly HeldDirectory[],
  hooks: CatalogTestHooks,
): void {
  if (closure.count > MAX_CONFIGURED_CLOSURE_SNAPSHOTS) limitExceeded();

  const revalidateContainer = (
    container: RetainedConfiguredSnapshotContainer,
    chain: readonly HeldDirectory[],
  ): void => {
    for (const snapshot of container.directories) {
      const opened = openHeldDirectorySync(snapshot.absolutePath, chain, hooks);
      try {
        if (!sameIdentity(snapshot.identity, opened.identity)) integrity();
        const currentEntries = readDirectoryNamesSync(
          snapshot.absolutePath,
          [...chain, opened],
          hooks,
          SKILL_LIMITS.resourcesPerPackage + 2,
        );
        if (!sameNames(snapshot.expectedEntries, currentEntries)) integrity();
        const exactAfter = syncSandwich([...chain, opened], hooks, () =>
          syncPathIdentity(snapshot.absolutePath, hooks),
        );
        if (!sameIdentity(snapshot.identity, exactAfter)) integrity();
        revalidateContainer(snapshot, [...chain, opened]);
      } finally {
        closeSync(opened.descriptor);
      }
    }

    for (const snapshot of container.members) {
      const current = syncSandwich(chain, hooks, () =>
        syncPathIdentity(snapshot.absolutePath, hooks),
      );
      if (!sameIdentity(snapshot.identity, current)) integrity();
    }
  };

  revalidateContainer(closure, packageChain);
}

function expectedPackageTree(manifest: SkillPackageManifest): ExpectedDirectory {
  const root: ExpectedDirectory = { directories: new Map(), files: new Map() };
  root.files.set("skill.json", -1);
  root.files.set("SKILL.md", manifest.skill_markdown.bytes);
  for (const resource of manifest.resources) {
    const components = resource.path.split("/");
    const basename = components.pop();
    if (basename === undefined) integrity();
    let directory = root;
    for (const component of components) {
      let child = directory.directories.get(component);
      if (child === undefined) {
        child = { directories: new Map(), files: new Map() };
        directory.directories.set(component, child);
      }
      directory = child;
    }
    if (directory.files.has(basename) || directory.directories.has(basename)) integrity();
    directory.files.set(basename, resource.bytes);
  }
  return root;
}

function expectedDirectoryNames(directory: ExpectedDirectory): readonly string[] {
  return [...directory.directories.keys(), ...directory.files.keys()].sort(bytewiseCompare);
}

async function validateConfiguredClosure(
  absoluteDirectory: string,
  chain: readonly HeldDirectory[],
  expected: ExpectedDirectory,
  currentUid: number,
  hooks: CatalogTestHooks,
  identities: Set<string>,
  retainedClosure: RetainedConfiguredClosure,
  retainedContainer: RetainedConfiguredSnapshotContainer,
  revalidatePackageGuard: () => void,
  rootSnapshot?: readonly string[],
): Promise<void> {
  const expectedNames = expectedDirectoryNames(expected);
  const actualNames =
    rootSnapshot ??
    (await enumerateConfiguredDirectoryBoundary(
      "member-stat",
      absoluteDirectory,
      chain,
      hooks,
      SKILL_LIMITS.resourcesPerPackage + 2,
      revalidatePackageGuard,
    ));
  if (!sameNames(expectedNames, actualNames)) integrity();

  for (const [name, child] of expected.directories) {
    const childPath = path.join(absoluteDirectory, name);
    const held = await openConfiguredDirectoryBoundary(
      "member-stat",
      childPath,
      chain,
      hooks,
      revalidatePackageGuard,
    );
    try {
      assertPrivateDirectory(held.identity, currentUid);
      const identityKey = `${held.identity.dev}:${held.identity.ino}`;
      if (identities.has(identityKey)) integrity();
      identities.add(identityKey);
      const retainedDirectory: RetainedConfiguredDirectorySnapshot = {
        absolutePath: childPath,
        identity: held.identity,
        expectedEntries: expectedDirectoryNames(child),
        directories: [],
        members: [],
      };
      retainConfiguredSnapshot(retainedClosure, retainedContainer, retainedDirectory);
      await validateConfiguredClosure(
        childPath,
        [...chain, held],
        child,
        currentUid,
        hooks,
        identities,
        retainedClosure,
        retainedDirectory,
        revalidatePackageGuard,
      );
    } finally {
      closeSync(held.descriptor);
    }
  }

  for (const [name, expectedBytes] of expected.files) {
    if (name === "skill.json") continue;
    const memberPath = path.join(absoluteDirectory, name);
    const identity = await configuredBoundary(
      "member-stat",
      memberPath,
      chain,
      hooks,
      () => syncSandwich(chain, hooks, () => syncPathIdentity(memberPath, hooks)),
      (result) => {
        const current = syncSandwich(chain, hooks, () => syncPathIdentity(memberPath, hooks));
        if (!sameIdentity(result, current)) integrity();
        revalidatePackageGuard();
      },
    );
    assertPrivateMember(identity, currentUid, expectedBytes);
    const identityKey = `${identity.dev}:${identity.ino}`;
    if (identities.has(identityKey)) integrity();
    identities.add(identityKey);
    retainConfiguredSnapshot(retainedClosure, retainedContainer, {
      absolutePath: memberPath,
      identity,
    });
  }
}

function openConfiguredAncestorChain(
  configuredRoot: string,
  hooks: CatalogTestHooks,
): HeldDirectory[] {
  const chain: HeldDirectory[] = [];
  const ancestors = configuredAncestorPaths(configuredRoot).slice(0, -1);
  try {
    for (const ancestor of ancestors) {
      chain.push(openHeldDirectorySync(ancestor, chain, hooks));
    }
    return chain;
  } catch (error) {
    closeHeldDirectories(chain);
    throw error;
  }
}

async function configuredEntries(
  options: CatalogImplementationOptions,
): Promise<readonly PrivateCatalogEntry[]> {
  const entries: PrivateCatalogEntry[] = [];
  for (const root of validatedConfiguredRoots(options.configuredRoots)) {
    const ancestorChain = openConfiguredAncestorChain(root, options.hooks);
    let openedRoot: HeldDirectory | undefined;
    try {
      openedRoot = await openConfiguredDirectoryBoundary(
        "root-open",
        root,
        ancestorChain,
        options.hooks,
      );
      assertPrivateDirectory(openedRoot.identity, options.currentUid);
      const rootChain = [...ancestorChain, openedRoot];
      const packageNames = await enumerateConfiguredDirectoryBoundary(
        "root-enumerate",
        root,
        rootChain,
        options.hooks,
        SKILL_LIMITS.packagesPerRoot,
      );
      const revalidateRootSnapshot = (): void => {
        const current = readDirectoryNamesSync(
          root,
          rootChain,
          options.hooks,
          SKILL_LIMITS.packagesPerRoot,
        );
        if (!sameNames(packageNames, current)) integrity();
      };
      const packageIdentities = new Set<string>();
      for (const packageName of packageNames) {
        if (!NAME_PATTERN.test(packageName)) integrity();
        const packagePath = path.join(root, packageName);
        const openedPackage = await openConfiguredDirectoryBoundary(
          "package-open",
          packagePath,
          rootChain,
          options.hooks,
          revalidateRootSnapshot,
        );
        try {
          assertPrivateDirectory(openedPackage.identity, options.currentUid);
          const packageChain = [...rootChain, openedPackage];
          const aliasKey = `${openedPackage.identity.dev}:${openedPackage.identity.ino}`;
          if (packageIdentities.has(aliasKey)) integrity();
          packageIdentities.add(aliasKey);
          const packageSnapshot = await enumerateConfiguredDirectoryBoundary(
            "package-enumerate",
            packagePath,
            packageChain,
            options.hooks,
            SKILL_LIMITS.resourcesPerPackage + 2,
            revalidateRootSnapshot,
          );
          const manifestPath = path.join(packagePath, "skill.json");
          const heldManifest = await openConfiguredManifestBoundary(
            manifestPath,
            packageChain,
            options.currentUid,
            packageSnapshot,
            options.hooks,
            revalidateRootSnapshot,
          );
          const retainedClosure: RetainedConfiguredClosure = {
            count: 0,
            directories: [],
            members: [],
          };
          try {
            const revalidatePackageGuard = (): void => {
              revalidateRootSnapshot();
              revalidateHeldManifest(heldManifest, packageChain, options.hooks);
              const current = readDirectoryNamesSync(
                packagePath,
                packageChain,
                options.hooks,
                SKILL_LIMITS.resourcesPerPackage + 2,
              );
              if (!sameNames(packageSnapshot, current)) integrity();
              revalidateConfiguredSnapshots(retainedClosure, packageChain, options.hooks);
            };
            const manifestBytes = await configuredBoundary(
              "manifest-read",
              manifestPath,
              packageChain,
              options.hooks,
              () => readHeldManifestSync(heldManifest, packageChain, options.hooks),
              revalidatePackageGuard,
            );
            await options.hooks.afterManifestRead?.(manifestPath);
            revalidatePackageGuard();

            let parsed: JsonValue;
            try {
              parsed = parseJsonBytes(manifestBytes, {
                maxBytes: SKILL_LIMITS.descriptorBytes,
                maxDepth: SKILL_LIMITS.nestingDepth,
                maxMembers: 4096,
              });
            } catch {
              integrity();
            }
            const manifest = parseSkillPackageManifest(parsed);
            if (manifest.name !== packageName) integrity();
            const identities = new Set<string>([
              `${heldManifest.identity.dev}:${heldManifest.identity.ino}`,
              `${openedPackage.identity.dev}:${openedPackage.identity.ino}`,
            ]);
            await validateConfiguredClosure(
              packagePath,
              packageChain,
              expectedPackageTree(manifest),
              options.currentUid,
              options.hooks,
              identities,
              retainedClosure,
              retainedClosure,
              revalidatePackageGuard,
              packageSnapshot,
            );
            await configuredBoundary(
              "package-final-revalidate",
              packagePath,
              packageChain,
              options.hooks,
              revalidatePackageGuard,
              revalidatePackageGuard,
            );
            const sourceIdentity = configuredSourceIdentity(
              openedRoot.identity,
              openedPackage.identity,
            );
            entries.push({
              descriptor: descriptorFor(manifest, {
                kind: "configured",
                identity: sourceIdentity,
              }),
              manifest,
              manifestIdentity: rawHash(manifestBytes),
              absoluteDirectory: packagePath,
              sourceKind: "configured",
              source: {
                absoluteDirectory: packagePath,
                sourceKind: "configured",
                currentUid: options.currentUid,
                configuredRoot: root,
                manifest,
                manifestPath,
                manifestHash: rawHash(manifestBytes),
                manifestFileIdentity: heldManifest.identity,
                packageChain: retainedDirectoryChain(packageChain),
              },
            });
          } finally {
            closeSync(heldManifest.descriptor);
          }
        } finally {
          closeSync(openedPackage.descriptor);
        }
      }
    } finally {
      if (openedRoot !== undefined) closeSync(openedRoot.descriptor);
      closeHeldDirectories(ancestorChain);
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

const INTERNAL_RESOLVE: unique symbol = Symbol("skill-catalog-loader-resolver");

interface RetainedSkillSelection {
  readonly entry: PrivateCatalogEntry;
  readonly catalogHash: `sha256:${string}`;
  readonly packageHandle: `sha256:${string}`;
}

class FileSystemSkillCatalog implements SkillCatalog {
  private readonly snapshots = new WeakMap<
    SkillCatalogSnapshot,
    ReadonlyMap<string, PrivateCatalogEntry>
  >();
  private readonly selections = new WeakMap<SkillSelection, RetainedSkillSelection>();

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
    const bundledManifestPath = this.options.bundled?.manifestPath ?? BUNDLED_MANIFEST_PATH;
    const bundledManifestIdentity = syncPathIdentity(bundledManifestPath, this.options.hooks);
    const bundled: PrivateCatalogEntry[] = bundledRecords.map((entry) => {
      const packageChain = captureDirectoryChain(entry.absoluteDirectory, this.options.hooks);
      return {
        descriptor: descriptorFor(entry.manifest, {
          kind: "bundled",
          identity: entry.sourceIdentity,
        }),
        manifest: entry.manifest,
        manifestIdentity: entry.manifestIdentity,
        absoluteDirectory: entry.absoluteDirectory,
        sourceKind: "bundled",
        source: {
          absoluteDirectory: entry.absoluteDirectory,
          sourceKind: "bundled",
          currentUid: this.options.currentUid,
          configuredRoot: null,
          manifest: entry.manifest,
          manifestPath: bundledManifestPath,
          manifestHash: entry.manifestIdentity,
          manifestFileIdentity: bundledManifestIdentity,
          packageChain,
        },
      };
    });
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
          ),
      );
      if (candidates.length !== 1) blocked();
    } else if (request.mode === "implicit") {
      if (request.descriptor !== null) invalid();
      const query = validateQuery(request.query);
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
    const selection = deepFreezeJson({
      descriptor: entry.descriptor,
      catalog_hash: snapshot.catalog_hash,
      package_handle: packageHandle,
    } as unknown as JsonValue) as unknown as SkillSelection;
    this.selections.set(selection, {
      entry,
      catalogHash: snapshot.catalog_hash,
      packageHandle,
    });
    return selection;
  }

  [INTERNAL_RESOLVE](selection: SkillSelection): InternalSkillPackageSource {
    if (
      !isClosedDataObject(selection, ["descriptor", "catalog_hash", "package_handle"]) ||
      typeof selection.catalog_hash !== "string" ||
      !HASH_PATTERN.test(selection.catalog_hash) ||
      typeof selection.package_handle !== "string" ||
      !HASH_PATTERN.test(selection.package_handle)
    ) {
      integrity();
    }
    const retained = this.selections.get(selection);
    if (retained === undefined) integrity();
    let parsed: ReturnType<typeof parseSkillDescriptor>;
    try {
      parsed = parseSkillDescriptor(canonicalJson(selection.descriptor));
    } catch {
      integrity();
    }
    if (!parsed.ok) integrity();
    const { entry } = retained;
    const expectedHandle = sha256({
      catalog_hash: retained.catalogHash,
      descriptor: referenceOf(entry.descriptor),
      manifest_identity: entry.manifestIdentity,
    });
    if (
      selection.catalog_hash !== retained.catalogHash ||
      selection.package_handle !== retained.packageHandle ||
      selection.package_handle !== expectedHandle ||
      canonicalJson(parsed.value) !== canonicalJson(entry.descriptor)
    ) {
      integrity();
    }
    return entry.source;
  }
}

interface InternalResolvableSkillCatalog extends SkillCatalog {
  [INTERNAL_RESOLVE](selection: SkillSelection): InternalSkillPackageSource;
}

/** @internal Loader-only bridge; not re-exported from the package root. */
export function resolveSkillSelectionForLoader(
  catalog: SkillCatalog,
  selection: SkillSelection,
): InternalSkillPackageSource {
  const candidate = catalog as Partial<InternalResolvableSkillCatalog>;
  const resolver = candidate[INTERNAL_RESOLVE];
  if (typeof resolver !== "function") integrity();
  return resolver.call(catalog, selection);
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
