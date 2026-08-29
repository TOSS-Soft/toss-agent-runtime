import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseJsonBytes, type JsonValue } from "../protocol/json.js";
import {
  parseSkillPackageManifest,
  type CatalogFileIdentity,
  type CatalogTestHooks,
  type SkillPackageManifest,
} from "./catalog.js";
import { RuntimeSkillError } from "./errors.js";
import { assertSkillRelativePath } from "./paths.js";
import { SKILL_LIMITS } from "./types.js";

const BUNDLED_MANIFEST_HASH =
  "sha256:f10088565ee4d9cd7f02356804cf5b943a56e41209a8a5dd8a2f8d79feb3ab97" as const;
const BUNDLED_MANIFEST_MAX_BYTES = 65_536;
const POLICY_VERSION = "toss-superpowers.v1";

export const BUNDLED_MANIFEST_PATH = fileURLToPath(
  new URL("../../skills/bundled/manifest.json", import.meta.url),
);

export interface BundledCatalogTestOverride {
  readonly root: string;
  readonly manifestPath: string;
  readonly expectedManifestHash: `sha256:${string}`;
}

export interface BundledCatalogRecord {
  readonly manifest: SkillPackageManifest;
  readonly manifestIdentity: `sha256:${string}`;
  readonly sourceIdentity: `sha256:${string}`;
  readonly absoluteDirectory: string;
  readonly handler: Readonly<{ capability: string; policy_version: string }>;
}

interface LoadBundledCatalogOptions {
  readonly override?: BundledCatalogTestOverride | undefined;
  readonly hooks?: CatalogTestHooks | undefined;
}

interface BundledManifestPackage {
  readonly directory: string;
  readonly manifest: SkillPackageManifest;
  readonly handler: Readonly<{ capability: string; policy_version: string }>;
}

function integrity(): never {
  throw new RuntimeSkillError("RUNTIME_SKILL_INTEGRITY");
}

function rawHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
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

function isRegular(identity: CatalogFileIdentity): boolean {
  return (identity.mode & constants.S_IFMT) === constants.S_IFREG;
}

function isDirectory(identity: CatalogFileIdentity): boolean {
  return (identity.mode & constants.S_IFMT) === constants.S_IFDIR;
}

function assertInstalledFile(identity: CatalogFileIdentity, expectedBytes: number): void {
  if (
    !isRegular(identity) ||
    (identity.mode & 0o022) !== 0 ||
    identity.nlink !== 1n ||
    identity.size !== BigInt(expectedBytes)
  ) {
    integrity();
  }
}

async function readHeldFile(
  absolutePath: string,
  maximumBytes: number,
  hooks: CatalogTestHooks,
): Promise<{ readonly bytes: Uint8Array; readonly identity: CatalogFileIdentity }> {
  let namedBefore: CatalogFileIdentity;
  try {
    namedBefore = await pathIdentity(absolutePath, hooks);
  } catch {
    integrity();
  }
  if (
    !isRegular(namedBefore) ||
    (namedBefore.mode & 0o022) !== 0 ||
    namedBefore.nlink !== 1n ||
    namedBefore.size < 1n ||
    namedBefore.size > BigInt(maximumBytes)
  ) {
    integrity();
  }
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
    if (
      !isRegular(before) ||
      (before.mode & 0o022) !== 0 ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes)
    ) {
      integrity();
    }
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
    const after = await handleIdentity(handle, absolutePath, hooks);
    const namedAfter = await pathIdentity(absolutePath, hooks);
    if (!sameIdentity(before, after) || !sameIdentity(before, namedAfter)) integrity();
    return { bytes: buffer.subarray(0, offset), identity: before };
  } finally {
    await handle.close();
  }
}

function parseBundledManifest(bytes: Uint8Array): readonly BundledManifestPackage[] {
  let value: JsonValue;
  try {
    value = parseJsonBytes(bytes, {
      maxBytes: BUNDLED_MANIFEST_MAX_BYTES,
      maxDepth: SKILL_LIMITS.nestingDepth,
      maxMembers: 8192,
    });
  } catch {
    integrity();
  }
  if (!isRecord(value) || !hasExactKeys(value, ["schema_version", "packages"])) integrity();
  const schemaVersion = requiredMember(value, "schema_version");
  const packageMembers = requiredMember(value, "packages");
  if (
    schemaVersion !== "bundled-skill-manifest.v1" ||
    !isJsonArray(packageMembers) ||
    packageMembers.length === 0 ||
    packageMembers.length > SKILL_LIMITS.packagesPerRoot
  ) {
    integrity();
  }
  const packages: BundledManifestPackage[] = [];
  for (const member of packageMembers) {
    if (!isRecord(member) || !hasExactKeys(member, ["directory", "manifest", "handler"]))
      integrity();
    const memberDirectory = requiredMember(member, "directory");
    const memberManifest = requiredMember(member, "manifest");
    const memberHandler = requiredMember(member, "handler");
    if (typeof memberDirectory !== "string" || !isRecord(memberHandler)) integrity();
    let directory: string;
    try {
      directory = assertSkillRelativePath(memberDirectory);
    } catch {
      integrity();
    }
    if (directory.includes("/")) integrity();
    if (
      !hasExactKeys(memberHandler, ["capability", "policy_version"]) ||
      typeof requiredMember(memberHandler, "capability") !== "string" ||
      requiredMember(memberHandler, "policy_version") !== POLICY_VERSION
    ) {
      integrity();
    }
    const handlerCapability = requiredMember(memberHandler, "capability") as string;
    const manifest = parseSkillPackageManifest(memberManifest);
    if (
      manifest.name !== directory ||
      handlerCapability !== manifest.name ||
      manifest.resources.some(
        (resource) => resource.role === "script" || resource.path.split("/").includes("scripts"),
      )
    ) {
      integrity();
    }
    packages.push({
      directory,
      manifest,
      handler: { capability: handlerCapability, policy_version: POLICY_VERSION },
    });
  }
  if (
    !packages.every(
      (entry, index) =>
        index === 0 || bytewiseCompare(packages[index - 1]!.directory, entry.directory) < 0,
    )
  ) {
    integrity();
  }
  return packages;
}

async function exactDirectoryEntries(
  directory: string,
  expected: readonly string[],
): Promise<void> {
  const entries: string[] = [];
  try {
    const opened = await opendir(directory);
    for await (const entry of opened) {
      entries.push(entry.name);
      if (entries.length > SKILL_LIMITS.resourcesPerPackage + 1) integrity();
    }
  } catch {
    integrity();
  }
  entries.sort(bytewiseCompare);
  const orderedExpected = [...expected].sort(bytewiseCompare);
  if (
    entries.length !== orderedExpected.length ||
    entries.some((entry, index) => entry !== orderedExpected[index])
  ) {
    integrity();
  }
}

async function assertBundledMember(
  absolutePath: string,
  expectedBytes: number,
  hooks: CatalogTestHooks,
): Promise<void> {
  let identity: CatalogFileIdentity;
  try {
    identity = await pathIdentity(absolutePath, hooks);
  } catch {
    integrity();
  }
  assertInstalledFile(identity, expectedBytes);
}

export async function loadBundledCatalog(
  options: LoadBundledCatalogOptions = {},
): Promise<readonly BundledCatalogRecord[]> {
  const override = options.override;
  const manifestPath = override?.manifestPath ?? BUNDLED_MANIFEST_PATH;
  const root = override?.root ?? path.dirname(BUNDLED_MANIFEST_PATH);
  const expectedManifestHash = override?.expectedManifestHash ?? BUNDLED_MANIFEST_HASH;
  const hooks = options.hooks ?? {};
  let read: { readonly bytes: Uint8Array; readonly identity: CatalogFileIdentity };
  try {
    read = await readHeldFile(manifestPath, BUNDLED_MANIFEST_MAX_BYTES, hooks);
  } catch (error) {
    if (error instanceof RuntimeSkillError) throw error;
    integrity();
  }
  const manifestHash = rawHash(read.bytes);
  if (manifestHash !== expectedManifestHash) integrity();
  const packages = parseBundledManifest(read.bytes);
  await exactDirectoryEntries(root, ["manifest.json", ...packages.map((entry) => entry.directory)]);

  const records: BundledCatalogRecord[] = [];
  for (const entry of packages) {
    const absoluteDirectory = path.join(root, entry.directory);
    let directoryIdentity: CatalogFileIdentity;
    try {
      directoryIdentity = await pathIdentity(absoluteDirectory, hooks);
    } catch {
      integrity();
    }
    if (!isDirectory(directoryIdentity) || (directoryIdentity.mode & 0o022) !== 0) integrity();
    const declaredMembers = [entry.manifest.skill_markdown, ...entry.manifest.resources];
    await exactDirectoryEntries(
      absoluteDirectory,
      declaredMembers.map((member) => member.path),
    );
    for (const member of declaredMembers) {
      await assertBundledMember(path.join(absoluteDirectory, member.path), member.bytes, hooks);
    }
    records.push({
      manifest: entry.manifest,
      manifestIdentity: manifestHash,
      sourceIdentity: manifestHash,
      absoluteDirectory,
      handler: entry.handler,
    });
  }
  return records;
}

export async function auditBundledSkillInstallation(
  override?: BundledCatalogTestOverride,
): Promise<void> {
  const records = await loadBundledCatalog(override === undefined ? {} : { override });
  for (const record of records) {
    const declaredMembers = [record.manifest.skill_markdown, ...record.manifest.resources];
    for (const member of declaredMembers) {
      const read = await readHeldFile(
        path.join(record.absoluteDirectory, member.path),
        member.bytes,
        {},
      );
      if (read.bytes.byteLength !== member.bytes || rawHash(read.bytes) !== member.hash)
        integrity();
    }
  }
}
