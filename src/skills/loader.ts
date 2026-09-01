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
import { assembleSkillContext, type SkillContext, type SkillContextRequest } from "./context.js";
import {
  resolveSkillSelectionForLoader,
  type CatalogFileIdentity,
  type InternalSkillDirectorySnapshot,
  type InternalSkillPackageSource,
  type SkillCatalog,
  type SkillPackageManifest,
  type SkillSelection,
} from "./catalog.js";
import {
  canonicalSkillCatalogRoot,
  hashSkillPackage,
  parseSkillSnapshot,
  SKILL_CATALOG_ROOT_JSON_LIMITS,
} from "./contracts.js";
import { RuntimeSkillError } from "./errors.js";
import { assertSkillRelativePath } from "./paths.js";
import {
  createSkillPrivateStore,
  createSkillPrivateStoreForTest,
  type CreateSkillPrivateStoreOptions,
  type CreateSkillPrivateStoreForTestOptions,
  type SkillPrivateStore,
} from "./private-store.js";
import { SKILL_LIMITS, type SkillResourceV1, type SkillSnapshotV1 } from "./types.js";

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export type SkillLoaderBoundary = "source-open" | "manifest-read" | "member-read" | "source-final";

export interface SkillLoaderTestHooks {
  readonly beforeBoundary?: (boundary: SkillLoaderBoundary) => void | Promise<void>;
  readonly afterBoundary?: (boundary: SkillLoaderBoundary) => void | Promise<void>;
  readonly onFileRead?: (absolutePath: string) => void;
  readonly onProcess?: (command: string) => void;
  readonly afterPathOperation?: (
    operation: "lstat" | "open" | "enumerate",
    absolutePath: string,
  ) => void;
}

export interface CreateSkillLoaderOptions extends CreateSkillPrivateStoreOptions {
  readonly catalog: SkillCatalog;
}

export interface CreateSkillLoaderForTestOptions extends CreateSkillLoaderOptions {
  readonly hooks?: SkillLoaderTestHooks | undefined;
  readonly isProcessAlive?: CreateSkillPrivateStoreForTestOptions["isProcessAlive"];
  readonly isCurrentUser?: CreateSkillPrivateStoreForTestOptions["isCurrentUser"];
  readonly privateStoreOperationHooks?: CreateSkillPrivateStoreForTestOptions["operationHooks"];
}

export interface SkillLoader {
  recover(): Promise<void>;
  retainCatalogRoot(selection: SkillSelection): Promise<void>;
  load(selection: SkillSelection): Promise<SkillSnapshotV1>;
  assembleContext(selection: SkillSelection, request: SkillContextRequest): Promise<SkillContext>;
}

interface HeldDirectory {
  readonly descriptor: number;
  readonly absolutePath: string;
  readonly identity: CatalogFileIdentity;
  readonly configured: boolean;
  expectedEntries?: readonly string[];
}

interface HeldMember {
  readonly descriptor: number;
  readonly absolutePath: string;
  readonly identity: CatalogFileIdentity;
  readonly declaration: SkillResourceV1 | SkillPackageManifest["skill_markdown"];
  bytes?: Uint8Array;
}

interface HeldManifest {
  readonly descriptor: number;
  readonly absolutePath: string;
  readonly identity: CatalogFileIdentity;
  bytes?: Uint8Array;
}

interface ExpectedDirectory {
  readonly directories: Map<string, ExpectedDirectory>;
  readonly files: Map<
    string,
    SkillResourceV1 | SkillPackageManifest["skill_markdown"] | "manifest"
  >;
}

interface PrivateSkillRecord {
  readonly schema_version: "skill-private-object.v1";
  readonly snapshot: SkillSnapshotV1;
  readonly skill_markdown_base64: string;
  readonly resources: readonly Readonly<{ path: string; bytes_base64: string }>[];
}

function integrity(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY");
}

function limitExceeded(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_LIMIT_EXCEEDED");
}

function rawHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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

function isRegular(identity: CatalogFileIdentity): boolean {
  return (identity.mode & constants.S_IFMT) === constants.S_IFREG;
}

function isDirectory(identity: CatalogFileIdentity): boolean {
  return (identity.mode & constants.S_IFMT) === constants.S_IFDIR;
}

function namedIdentity(absolutePath: string): CatalogFileIdentity {
  return identityFromStats(lstatSync(absolutePath, { bigint: true }));
}

function descriptorIdentity(descriptor: number): CatalogFileIdentity {
  return identityFromStats(fstatSync(descriptor, { bigint: true }));
}

function assertSourceDirectory(
  identity: CatalogFileIdentity,
  absolutePath: string,
  source: InternalSkillPackageSource,
): void {
  if (!isDirectory(identity)) integrity();
  if (source.sourceKind === "configured") {
    const configuredRoot = source.configuredRoot;
    if (configuredRoot === null) integrity();
    const relative = path.relative(configuredRoot, absolutePath);
    const exactPrivate =
      relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
    if (exactPrivate) {
      if (identity.uid !== source.currentUid || (identity.mode & 0o7777) !== 0o700) integrity();
    } else if ((identity.mode & 0o022) !== 0 && (identity.mode & 0o1000) === 0) {
      integrity();
    }
    return;
  }
  if ((identity.mode & 0o022) !== 0) integrity();
  if (absolutePath === source.absoluteDirectory && (identity.mode & 0o022) !== 0) integrity();
}

function assertSourceFile(
  identity: CatalogFileIdentity,
  source: InternalSkillPackageSource,
  expectedBytes: number,
): void {
  if (!isRegular(identity) || identity.nlink !== 1n || identity.size !== BigInt(expectedBytes)) {
    integrity();
  }
  if (source.sourceKind === "configured") {
    if (identity.uid !== source.currentUid || (identity.mode & 0o7777) !== 0o600) integrity();
  } else if ((identity.mode & 0o022) !== 0) {
    integrity();
  }
}

function validateHeldOperationChain(
  retained: readonly InternalSkillDirectorySnapshot[],
  held: readonly HeldDirectory[],
  source: InternalSkillPackageSource,
): void {
  if (held.length < retained.length || retained.length === 0) integrity();
  for (let index = 0; index < held.length; index += 1) {
    const opened = held[index]!;
    const descriptor = descriptorIdentity(opened.descriptor);
    assertSourceDirectory(descriptor, opened.absolutePath, source);
    const expected = index < retained.length ? retained[index]!.identity : opened.identity;
    const same = index < retained.length ? sameDirectoryIdentity : sameIdentity;
    if (!same(expected, opened.identity) || !same(expected, descriptor)) {
      integrity();
    }
  }
}

function descriptorSandwich<T>(
  source: InternalSkillPackageSource,
  retained: readonly InternalSkillDirectorySnapshot[],
  held: readonly HeldDirectory[],
  operation: () => T,
): T {
  if (held.length === 0) {
    const result = operation();
    return result;
  }
  validateHeldOperationChain(retained, held, source);
  const result = operation();
  validateHeldOperationChain(retained, held, source);
  return result;
}

function validateNamedOperationChain(
  retained: readonly InternalSkillDirectorySnapshot[],
  held: readonly HeldDirectory[],
  source: InternalSkillPackageSource,
): void {
  validateHeldOperationChain(retained, held, source);
  for (let index = 0; index < held.length; index += 1) {
    const opened = held[index]!;
    const named = descriptorSandwich(source, retained, held, () =>
      namedIdentity(opened.absolutePath),
    );
    assertSourceDirectory(named, opened.absolutePath, source);
    const expected = index < retained.length ? retained[index]!.identity : opened.identity;
    const same = index < retained.length ? sameDirectoryIdentity : sameIdentity;
    if (!same(expected, opened.identity) || !same(expected, named)) integrity();
  }
  validateHeldOperationChain(retained, held, source);
}

/*
 * Node does not expose openat(2)/fdopendir(3). Each named-chain lstat is first
 * enclosed by its own descriptor validation sandwich, then the one requested
 * pathname operation is enclosed by complete named-chain validation. No await
 * or caller hook occurs inside. The irreducible same-UID interval between the
 * final validation and one syscall is accepted; no native addon is used.
 */
function onePathOperation<T>(
  source: InternalSkillPackageSource,
  retained: readonly InternalSkillDirectorySnapshot[],
  held: readonly HeldDirectory[],
  operation: () => T,
): T {
  if (held.length === 0) return operation();
  validateNamedOperationChain(retained, held, source);
  const result = descriptorSandwich(source, retained, held, operation);
  validateNamedOperationChain(retained, held, source);
  return result;
}

function revalidateOperationChain(
  retained: readonly InternalSkillDirectorySnapshot[],
  held: readonly HeldDirectory[],
  source: InternalSkillPackageSource,
): void {
  validateNamedOperationChain(retained, held, source);
}

function revalidateRetainedChain(
  retained: readonly InternalSkillDirectorySnapshot[],
  held: readonly HeldDirectory[],
  source: InternalSkillPackageSource,
): void {
  if (retained.length !== held.length) integrity();
  revalidateOperationChain(retained, held, source);
}

function syncSandwich<T>(
  source: InternalSkillPackageSource,
  retained: readonly InternalSkillDirectorySnapshot[],
  held: readonly HeldDirectory[],
  operation: () => T,
): T {
  return onePathOperation(source, retained, held, operation);
}

function openSourceChain(source: InternalSkillPackageSource): HeldDirectory[] {
  const opened: HeldDirectory[] = [];
  try {
    for (let index = 0; index < source.packageChain.length; index += 1) {
      const retained = source.packageChain[index]!;
      const parentRetained = source.packageChain.slice(0, index);
      const before = onePathOperation(source, parentRetained, opened, () =>
        namedIdentity(retained.absolutePath),
      );
      assertSourceDirectory(before, retained.absolutePath, source);
      const descriptor = onePathOperation(source, parentRetained, opened, () =>
        openSync(
          retained.absolutePath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
      );
      const heldIdentity = descriptorIdentity(descriptor);
      const tentative: HeldDirectory = {
        descriptor,
        absolutePath: retained.absolutePath,
        identity: heldIdentity,
        configured: source.sourceKind === "configured",
      };
      const after = onePathOperation(
        source,
        source.packageChain.slice(0, index + 1),
        [...opened, tentative],
        () => namedIdentity(retained.absolutePath),
      );
      assertSourceDirectory(heldIdentity, retained.absolutePath, source);
      if (
        !sameDirectoryIdentity(retained.identity, before) ||
        !sameDirectoryIdentity(retained.identity, heldIdentity) ||
        !sameDirectoryIdentity(retained.identity, after)
      ) {
        closeSync(descriptor);
        integrity();
      }
      opened.push(tentative);
    }
    return opened;
  } catch (error) {
    for (const directory of opened.reverse()) closeSync(directory.descriptor);
    if (error instanceof RuntimeSkillError) throw error;
    integrity();
  }
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function directoryNames(absolutePath: string): readonly string[] {
  const opened = opendirSync(absolutePath);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > SKILL_LIMITS.resourcesPerPackage + 2) limitExceeded();
    }
  } finally {
    opened.closeSync();
  }
  return names.sort(bytewiseCompare);
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function expectedTree(source: InternalSkillPackageSource): ExpectedDirectory {
  const root: ExpectedDirectory = { directories: new Map(), files: new Map() };
  if (source.sourceKind === "configured") root.files.set("skill.json", "manifest");
  root.files.set("SKILL.md", source.manifest.skill_markdown);
  for (const resource of source.manifest.resources) {
    const safePath = assertSkillRelativePath(resource.path);
    if (safePath === "SKILL.md" || safePath === "skill.json") integrity();
    const components = safePath.split("/");
    const basename = components.pop();
    if (basename === undefined) integrity();
    let current = root;
    for (const component of components) {
      let child = current.directories.get(component);
      if (child === undefined) {
        child = { directories: new Map(), files: new Map() };
        current.directories.set(component, child);
      }
      current = child;
    }
    if (current.files.has(basename) || current.directories.has(basename)) integrity();
    current.files.set(basename, resource);
  }
  return root;
}

function expectedNames(tree: ExpectedDirectory): readonly string[] {
  return [...tree.directories.keys(), ...tree.files.keys()].sort(bytewiseCompare);
}

function openManifest(
  source: InternalSkillPackageSource,
  retained: readonly InternalSkillDirectorySnapshot[],
  chain: readonly HeldDirectory[],
): HeldManifest {
  try {
    const before = syncSandwich(source, retained, chain, () => namedIdentity(source.manifestPath));
    if (!sameIdentity(before, source.manifestFileIdentity)) integrity();
    const descriptor = syncSandwich(source, retained, chain, () =>
      openSync(
        source.manifestPath,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      ),
    );
    const held = descriptorIdentity(descriptor);
    const after = syncSandwich(source, retained, chain, () => namedIdentity(source.manifestPath));
    if (
      !isRegular(held) ||
      held.nlink !== 1n ||
      held.size < 1n ||
      held.size > BigInt(SKILL_LIMITS.descriptorBytes) ||
      !sameIdentity(source.manifestFileIdentity, held) ||
      !sameIdentity(source.manifestFileIdentity, after) ||
      (source.sourceKind === "configured" &&
        (held.uid !== source.currentUid || (held.mode & 0o7777) !== 0o600)) ||
      (source.sourceKind === "bundled" && (held.mode & 0o022) !== 0)
    ) {
      closeSync(descriptor);
      integrity();
    }
    return {
      descriptor,
      absolutePath: source.manifestPath,
      identity: held,
    };
  } catch (error) {
    if (error instanceof RuntimeSkillError) throw error;
    return integrity();
  }
}

function openDeclaredTree(
  source: InternalSkillPackageSource,
  retainedChain: readonly InternalSkillDirectorySnapshot[],
  chain: HeldDirectory[],
  tree: ExpectedDirectory,
  manifest: HeldManifest,
  directories: HeldDirectory[],
  members: HeldMember[],
): void {
  const current = chain.at(-1);
  if (current === undefined) integrity();
  const names = syncSandwich(source, retainedChain, chain, () =>
    directoryNames(current.absolutePath),
  );
  const wanted = expectedNames(tree);
  if (!sameNames(names, wanted)) integrity();
  current.expectedEntries = wanted;

  for (const [name, child] of tree.directories) {
    const childPath = path.join(current.absolutePath, name);
    const before = syncSandwich(source, retainedChain, chain, () => namedIdentity(childPath));
    assertSourceDirectory(before, childPath, source);
    const descriptor = syncSandwich(source, retainedChain, chain, () =>
      openSync(childPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
    );
    const held = descriptorIdentity(descriptor);
    const tentative: HeldDirectory = {
      descriptor,
      absolutePath: childPath,
      identity: held,
      configured: source.sourceKind === "configured",
    };
    const after = syncSandwich(source, retainedChain, [...chain, tentative], () =>
      namedIdentity(childPath),
    );
    assertSourceDirectory(held, childPath, source);
    if (!sameIdentity(before, held) || !sameIdentity(before, after)) {
      closeSync(descriptor);
      integrity();
    }
    const opened = tentative;
    directories.push(opened);
    openDeclaredTree(
      source,
      retainedChain,
      [...chain, opened],
      child,
      manifest,
      directories,
      members,
    );
  }

  for (const [name, declaration] of tree.files) {
    if (declaration === "manifest") {
      if (path.join(current.absolutePath, name) !== manifest.absolutePath) integrity();
      continue;
    }
    const memberPath = path.join(current.absolutePath, name);
    const before = syncSandwich(source, retainedChain, chain, () => namedIdentity(memberPath));
    assertSourceFile(before, source, declaration.bytes);
    const descriptor = syncSandwich(source, retainedChain, chain, () =>
      openSync(memberPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW),
    );
    const held = descriptorIdentity(descriptor);
    const after = syncSandwich(source, retainedChain, chain, () => namedIdentity(memberPath));
    assertSourceFile(held, source, declaration.bytes);
    if (!sameIdentity(before, held) || !sameIdentity(before, after)) {
      closeSync(descriptor);
      integrity();
    }
    members.push({ descriptor, absolutePath: memberPath, identity: held, declaration });
  }
}

function readDescriptor(descriptor: number, expectedBytes: number): Uint8Array {
  const bytes = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const count = readSync(descriptor, bytes, offset, expectedBytes - offset, offset);
    if (count === 0) integrity();
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (readSync(descriptor, extra, 0, 1, expectedBytes) !== 0) integrity();
  return bytes;
}

function validateText(bytes: Uint8Array): void {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    integrity();
  }
}

function isTextual(resource: SkillResourceV1 | SkillPackageManifest["skill_markdown"]): boolean {
  return (
    resource.media_type.startsWith("text/") ||
    /^application\/(?:json|javascript|typescript|yaml|x-yaml|xml)$/u.test(resource.media_type)
  );
}

function revalidateLoadedSource(
  source: InternalSkillPackageSource,
  retainedChain: readonly InternalSkillDirectorySnapshot[],
  sourceChain: readonly HeldDirectory[],
  directories: readonly HeldDirectory[],
  manifest: HeldManifest,
  members: readonly HeldMember[],
  hooks: SkillLoaderTestHooks,
): void {
  const allDirectories = [...sourceChain, ...directories];
  revalidateOperationChain(retainedChain, allDirectories, source);
  for (let index = 0; index < allDirectories.length; index += 1) {
    const directory = allDirectories[index]!;
    const named = syncSandwich(source, retainedChain, allDirectories, () =>
      namedIdentity(directory.absolutePath),
    );
    hooks.afterPathOperation?.("lstat", directory.absolutePath);
    const held = descriptorIdentity(directory.descriptor);
    assertSourceDirectory(named, directory.absolutePath, source);
    assertSourceDirectory(held, directory.absolutePath, source);
    const same = index < sourceChain.length ? sameDirectoryIdentity : sameIdentity;
    if (!same(directory.identity, named) || !same(directory.identity, held)) {
      integrity();
    }
    if (directory.expectedEntries !== undefined) {
      const actual = syncSandwich(source, retainedChain, allDirectories, () =>
        directoryNames(directory.absolutePath),
      );
      hooks.afterPathOperation?.("enumerate", directory.absolutePath);
      if (!sameNames(directory.expectedEntries, actual)) integrity();
    }
  }
  const manifestNamed = syncSandwich(source, retainedChain, allDirectories, () =>
    namedIdentity(manifest.absolutePath),
  );
  hooks.afterPathOperation?.("lstat", manifest.absolutePath);
  const manifestHeld = descriptorIdentity(manifest.descriptor);
  if (
    !sameIdentity(manifest.identity, manifestNamed) ||
    !sameIdentity(manifest.identity, manifestHeld)
  ) {
    integrity();
  }
  if (manifest.bytes !== undefined) {
    const bytes = readDescriptor(manifest.descriptor, manifest.bytes.byteLength);
    if (!Buffer.from(bytes).equals(Buffer.from(manifest.bytes))) integrity();
  }
  for (const member of members) {
    const named = syncSandwich(source, retainedChain, allDirectories, () =>
      namedIdentity(member.absolutePath),
    );
    hooks.afterPathOperation?.("lstat", member.absolutePath);
    const held = descriptorIdentity(member.descriptor);
    assertSourceFile(named, source, member.declaration.bytes);
    assertSourceFile(held, source, member.declaration.bytes);
    if (!sameIdentity(member.identity, named) || !sameIdentity(member.identity, held)) integrity();
    if (member.bytes !== undefined) {
      const bytes = readDescriptor(member.descriptor, member.bytes.byteLength);
      if (!Buffer.from(bytes).equals(Buffer.from(member.bytes))) integrity();
    }
  }
  revalidateOperationChain(retainedChain, allDirectories, source);
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (!BASE64_PATTERN.test(value)) integrity();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) integrity();
  return bytes;
}

function isRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: unknown): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function exactKeys(value: { readonly [key: string]: JsonValue }, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(bytewiseCompare);
  const expected = [...keys].sort(bytewiseCompare);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parsePrivateRecord(bytes: Uint8Array, selection: SkillSelection): PrivateSkillRecord {
  let value: JsonValue;
  try {
    value = parseJsonBytes(bytes, {
      maxBytes: SKILL_LIMITS.storedObjectBytes,
      maxDepth: SKILL_LIMITS.nestingDepth,
      maxMembers: SKILL_LIMITS.resourcesPerPackage * 4 + 128,
    });
  } catch {
    integrity();
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schema_version", "snapshot", "skill_markdown_base64", "resources"]) ||
    value.schema_version !== "skill-private-object.v1" ||
    value.snapshot === undefined ||
    typeof value.skill_markdown_base64 !== "string" ||
    !isJsonArray(value.resources)
  ) {
    integrity();
  }
  const parsedSnapshot = parseSkillSnapshot(canonicalJson(value.snapshot));
  if (!parsedSnapshot.ok) integrity();
  const snapshot = parsedSnapshot.value;
  if (
    snapshot.package_hash !== selection.descriptor.package_hash ||
    canonicalJson(snapshot.descriptor) !== canonicalJson(selection.descriptor) ||
    value.resources.length !== snapshot.resources.length
  ) {
    integrity();
  }
  const skillBytes = decodeCanonicalBase64(value.skill_markdown_base64);
  if (
    skillBytes.byteLength !== snapshot.skill_markdown_bytes ||
    rawHash(skillBytes) !== snapshot.skill_markdown_hash
  ) {
    integrity();
  }
  let decodedTotal = skillBytes.byteLength;
  const storedResources: { path: string; bytes_base64: string }[] = [];
  for (let index = 0; index < value.resources.length; index += 1) {
    const member = value.resources[index];
    const declaration = snapshot.resources[index]!;
    if (
      !isRecord(member) ||
      !exactKeys(member, ["path", "bytes_base64"]) ||
      typeof member.path !== "string" ||
      typeof member.bytes_base64 !== "string" ||
      member.path !== declaration.path
    ) {
      integrity();
    }
    const decoded = decodeCanonicalBase64(member.bytes_base64);
    if (decoded.byteLength !== declaration.bytes || rawHash(decoded) !== declaration.hash) {
      integrity();
    }
    decodedTotal += decoded.byteLength;
    if (!Number.isSafeInteger(decodedTotal) || decodedTotal > SKILL_LIMITS.packageBytes) {
      limitExceeded();
    }
    storedResources.push({ path: member.path, bytes_base64: member.bytes_base64 });
  }
  if (decodedTotal !== snapshot.total_bytes) integrity();
  const record: PrivateSkillRecord = {
    schema_version: "skill-private-object.v1",
    snapshot,
    skill_markdown_base64: value.skill_markdown_base64,
    resources: storedResources,
  };
  if (canonicalJson(record) !== Buffer.from(bytes).toString("utf8")) {
    integrity();
  }
  return record;
}

function createSnapshot(
  selection: SkillSelection,
  manifest: SkillPackageManifest,
  skillMarkdown: Uint8Array,
  resourceBytes: readonly Uint8Array[],
): SkillSnapshotV1 {
  const resources = manifest.resources.map((resource, index) => {
    const bytes = resourceBytes[index]!;
    if (bytes.byteLength !== resource.bytes || rawHash(bytes) !== resource.hash) integrity();
    return resource;
  });
  const packageHash = hashSkillPackage({
    descriptor: selection.descriptor,
    skill_markdown_hash: rawHash(skillMarkdown),
    skill_markdown_bytes: skillMarkdown.byteLength,
    resources,
  });
  if (
    rawHash(skillMarkdown) !== manifest.skill_markdown.hash ||
    skillMarkdown.byteLength !== manifest.skill_markdown.bytes ||
    packageHash !== manifest.package_hash ||
    packageHash !== selection.descriptor.package_hash
  ) {
    integrity();
  }
  const totalBytes =
    skillMarkdown.byteLength + resources.reduce((sum, item) => sum + item.bytes, 0);
  if (totalBytes !== manifest.total_bytes || totalBytes > SKILL_LIMITS.packageBytes) integrity();
  const hashable = {
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "skill-snapshot.v1" as const,
    document_type: "skill-snapshot" as const,
    descriptor: selection.descriptor,
    skill_markdown_hash: manifest.skill_markdown.hash,
    skill_markdown_bytes: manifest.skill_markdown.bytes,
    resources,
    package_hash: packageHash,
    total_bytes: totalBytes,
  };
  const snapshot: SkillSnapshotV1 = { ...hashable, document_hash: sha256(hashable) };
  const parsed = parseSkillSnapshot(canonicalJson(snapshot));
  if (!parsed.ok) integrity();
  return parsed.value;
}

async function loadSource(
  source: InternalSkillPackageSource,
  selection: SkillSelection,
  hooks: SkillLoaderTestHooks,
): Promise<PrivateSkillRecord> {
  const sourceChain = openSourceChain(source);
  const retainedChain = source.packageChain;
  const nestedDirectories: HeldDirectory[] = [];
  const members: HeldMember[] = [];
  let manifest: HeldManifest | undefined;
  const revalidate = (): void => {
    if (manifest === undefined) {
      revalidateRetainedChain(retainedChain, sourceChain, source);
      return;
    }
    revalidateLoadedSource(
      source,
      retainedChain,
      sourceChain,
      nestedDirectories,
      manifest,
      members,
      hooks,
    );
  };
  const boundary = async (name: SkillLoaderBoundary): Promise<void> => {
    await hooks.beforeBoundary?.(name);
    revalidate();
    await hooks.afterBoundary?.(name);
    revalidate();
  };
  try {
    manifest = openManifest(source, retainedChain, sourceChain);
    openDeclaredTree(
      source,
      retainedChain,
      sourceChain,
      expectedTree(source),
      manifest,
      nestedDirectories,
      members,
    );
    await boundary("source-open");

    hooks.onFileRead?.(manifest.absolutePath);
    const manifestBytes = readDescriptor(manifest.descriptor, Number(manifest.identity.size));
    manifest.bytes = manifestBytes;
    if (rawHash(manifestBytes) !== source.manifestHash) integrity();
    await boundary("manifest-read");

    for (const member of members) {
      hooks.onFileRead?.(member.absolutePath);
      const bytes = readDescriptor(member.descriptor, member.declaration.bytes);
      member.bytes = bytes;
      if (rawHash(bytes) !== member.declaration.hash) integrity();
      if (isTextual(member.declaration)) validateText(bytes);
      await boundary("member-read");
    }
    await boundary("source-final");

    const skillMember = members.find((member) => member.declaration.path === "SKILL.md");
    if (skillMember?.bytes === undefined) integrity();
    validateText(skillMember.bytes);
    const resourceMap = new Map(
      members
        .filter((member) => member.declaration.path !== "SKILL.md")
        .map((member) => [member.declaration.path, member.bytes] as const),
    );
    const resourceBytes = source.manifest.resources.map((resource) => {
      const bytes = resourceMap.get(resource.path);
      if (bytes === undefined) integrity();
      return bytes;
    });
    const snapshot = createSnapshot(selection, source.manifest, skillMember.bytes, resourceBytes);
    return {
      schema_version: "skill-private-object.v1",
      snapshot,
      skill_markdown_base64: Buffer.from(skillMember.bytes).toString("base64"),
      resources: source.manifest.resources.map((resource, index) => ({
        path: resource.path,
        bytes_base64: Buffer.from(resourceBytes[index]!).toString("base64"),
      })),
    };
  } catch (error) {
    if (error instanceof RuntimeSkillError) throw error;
    return integrity();
  } finally {
    for (const member of members.reverse()) closeSync(member.descriptor);
    if (manifest !== undefined) closeSync(manifest.descriptor);
    for (const directory of nestedDirectories.reverse()) closeSync(directory.descriptor);
    for (const directory of sourceChain.reverse()) closeSync(directory.descriptor);
  }
}

function createLoader(
  options: CreateSkillLoaderForTestOptions,
  store: SkillPrivateStore,
): SkillLoader {
  const hooks = options.hooks ?? {};
  const exactRecord = async (selection: SkillSelection): Promise<PrivateSkillRecord> => {
    const source = resolveSkillSelectionForLoader(options.catalog, selection);
    const record = await loadSource(source, selection, hooks);
    const canonical = Buffer.from(canonicalJson(record as unknown as JsonValue), "utf8");
    if (canonical.byteLength > SKILL_LIMITS.storedObjectBytes) limitExceeded();
    const replay = await store.readObject(selection.descriptor.package_hash);
    if (replay !== null) {
      if (!Buffer.from(replay).equals(canonical)) integrity();
      return parsePrivateRecord(replay, selection);
    }
    return parsePrivateRecord(
      await store.publishObject(selection.descriptor.package_hash, canonical),
      selection,
    );
  };
  const retainCatalogRoot = async (selection: SkillSelection): Promise<void> => {
    resolveSkillSelectionForLoader(options.catalog, selection);
    canonicalSkillCatalogRoot(selection.catalog_root);
    const record = {
      schema_version: "skill-private-catalog-root.v1" as const,
      catalog_root: selection.catalog_root,
    };
    const canonical = Buffer.from(
      canonicalJson(record as unknown as JsonValue, {
        ...SKILL_CATALOG_ROOT_JSON_LIMITS,
        maxBytes: SKILL_LIMITS.catalogRootBytes + 128,
        maxMembers: SKILL_LIMITS.catalogRootMembers + 4,
      }),
      "utf8",
    );
    if (canonical.byteLength > SKILL_LIMITS.storedObjectBytes) limitExceeded();
    const replay = await store.readObject(selection.catalog_hash);
    if (replay !== null) {
      if (!Buffer.from(replay).equals(canonical)) integrity();
      return;
    }
    const published = await store.publishObject(selection.catalog_hash, canonical);
    if (!Buffer.from(published).equals(canonical)) integrity();
  };
  return {
    recover: () => store.recover(),
    retainCatalogRoot,
    async load(selection: SkillSelection): Promise<SkillSnapshotV1> {
      const record = await exactRecord(selection);
      return deepFreezeJson(record.snapshot as unknown as JsonValue) as unknown as SkillSnapshotV1;
    },
    async assembleContext(
      selection: SkillSelection,
      request: SkillContextRequest,
    ): Promise<SkillContext> {
      const record = await exactRecord(selection);
      if (
        request.snapshot_hash !== record.snapshot.document_hash ||
        canonicalJson(request.snapshot) !== canonicalJson(record.snapshot)
      ) {
        integrity();
      }
      return assembleSkillContext(request, {
        skill_markdown: decodeCanonicalBase64(record.skill_markdown_base64),
        resources: record.resources.map((resource) => ({
          path: resource.path,
          bytes: decodeCanonicalBase64(resource.bytes_base64),
        })),
      });
    },
  };
}

export function createSkillLoaderForTest(options: CreateSkillLoaderForTestOptions): SkillLoader {
  const store = createSkillPrivateStoreForTest({
    statePath: options.statePath,
    now: options.now,
    randomId: options.randomId,
    hasServiceListener: options.hasServiceListener,
    ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
    ...(options.isCurrentUser === undefined ? {} : { isCurrentUser: options.isCurrentUser }),
    ...(options.privateStoreOperationHooks === undefined
      ? {}
      : { operationHooks: options.privateStoreOperationHooks }),
  });
  return createLoader(options, store);
}

export function createSkillLoader(options: CreateSkillLoaderOptions): SkillLoader {
  return createLoader(options, createSkillPrivateStore(options));
}
