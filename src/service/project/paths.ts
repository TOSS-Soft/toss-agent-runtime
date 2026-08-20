import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";

import { hashProjectWatchManifest, isSafeProjectRelativePath } from "./contracts.js";
import { RuntimeProjectError } from "./errors.js";
import type {
  ProjectChange,
  ProjectFileIdentity,
  ProjectRegistration,
  ProjectWatchManifestV1,
} from "./types.js";

const MAX_SCAN_ENTRIES = 100_000;
const MAX_SCAN_METADATA_BYTES = 256 * 1024 * 1024;
const BUILT_IN_IGNORES = [".git", ".toss/runtime"] as const;

export interface CompileProjectScopeOptions {
  readonly registration: ProjectRegistration;
  readonly manifest: ProjectWatchManifestV1;
  readonly runtimeStatePath: string;
}

export interface CompiledProjectScope {
  readonly registration: ProjectRegistration;
  readonly manifest: ProjectWatchManifestV1;
  readonly canonicalRoot: string;
  readonly rootIdentity: {
    readonly device: bigint;
    readonly inode: bigint;
  };
  readonly watchPaths: readonly string[];
  readonly ignorePaths: readonly string[];
}

interface ScanBudget {
  entries: number;
  metadataBytes: number;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function projectError(code: ConstructorParameters<typeof RuntimeProjectError>[0]): never {
  throw new RuntimeProjectError(code);
}

function currentUid(): bigint | undefined {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
}

function bytewise(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function containedBy(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function containsPath(candidate: string, nested: string): boolean {
  return (
    candidate === nested ||
    candidate.startsWith(`${nested}/`) ||
    candidate.endsWith(`/${nested}`) ||
    candidate.includes(`/${nested}/`)
  );
}

function isIgnored(scope: CompiledProjectScope, relativePath: string): boolean {
  return (
    BUILT_IN_IGNORES.some((ignored) => containsPath(relativePath, ignored)) ||
    scope.ignorePaths.some((ignored) => containedBy(relativePath, ignored))
  );
}

function rootRelative(canonicalRoot: string, absolutePath: string): string | null {
  if (!path.isAbsolute(absolutePath) || path.normalize(absolutePath) !== absolutePath) return null;
  const relative = path.relative(canonicalRoot, absolutePath);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return null;
  }
  const normalized = relative.split(path.sep).join("/");
  return isSafeProjectRelativePath(normalized) ? normalized : null;
}

function assertRoot(scope: CompiledProjectScope): void {
  try {
    const metadata = lstatSync(scope.canonicalRoot, { bigint: true });
    const uid = currentUid();
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.dev !== scope.rootIdentity.device ||
      metadata.ino !== scope.rootIdentity.inode ||
      (uid !== undefined && metadata.uid !== uid) ||
      realpathSync.native(scope.canonicalRoot) !== scope.canonicalRoot
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
  } catch (error) {
    throw error instanceof RuntimeProjectError
      ? error
      : new RuntimeProjectError("RUNTIME_PROJECT_PATH_UNSAFE");
  }
}

function assertPathComponents(canonicalRoot: string, relativePath: string): void {
  let candidate = canonicalRoot;
  try {
    for (const segment of relativePath.split("/")) {
      candidate = path.join(candidate, segment);
      const metadata = lstatSync(candidate, { bigint: true });
      if (metadata.isSymbolicLink()) projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
  } catch (error) {
    if (error instanceof RuntimeProjectError) throw error;
    if (isMissing(error)) return;
    projectError("RUNTIME_PROJECT_PATH_UNSAFE");
  }
}

function normalizedRuntimeIgnore(canonicalRoot: string, runtimeStatePath: string): string | null {
  if (!path.isAbsolute(runtimeStatePath)) projectError("RUNTIME_PROJECT_INVALID");
  const normalized = path.normalize(runtimeStatePath);
  if (normalized !== runtimeStatePath) projectError("RUNTIME_PROJECT_INVALID");
  if (normalized === canonicalRoot) projectError("RUNTIME_PROJECT_PATH_UNSAFE");
  return rootRelative(canonicalRoot, normalized);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(bytewise));
}

function validManifestPaths(values: readonly string[], maximum: number): boolean {
  return (
    values.length <= maximum &&
    new Set(values).size === values.length &&
    values.every((candidate) => candidate.length <= 1024 && isSafeProjectRelativePath(candidate))
  );
}

export function compileProjectScope(options: CompileProjectScopeOptions): CompiledProjectScope {
  if (
    options.registration.state !== "ACTIVE" ||
    options.registration.manifest_hash !== hashProjectWatchManifest(options.manifest) ||
    !path.isAbsolute(options.registration.canonical_root) ||
    path.normalize(options.registration.canonical_root) !== options.registration.canonical_root
  ) {
    projectError("RUNTIME_PROJECT_INVALID");
  }
  if (
    options.manifest.schema_version !== "project-watch-manifest.v1" ||
    options.manifest.watch_paths.length === 0 ||
    !validManifestPaths(options.manifest.watch_paths, 256) ||
    !validManifestPaths(options.manifest.ignore_paths, 256)
  ) {
    projectError("RUNTIME_PROJECT_INVALID");
  }

  let descriptor: number | undefined;
  try {
    const canonicalRoot = realpathSync.native(options.registration.canonical_root);
    if (canonicalRoot !== options.registration.canonical_root) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    const before = lstatSync(canonicalRoot, { bigint: true });
    const uid = currentUid();
    if (
      before.isSymbolicLink() ||
      !before.isDirectory() ||
      (uid !== undefined && before.uid !== uid)
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    descriptor = openSync(
      canonicalRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const held = fstatSync(descriptor, { bigint: true });
    if (held.dev !== before.dev || held.ino !== before.ino) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    for (const watchPath of options.manifest.watch_paths) {
      assertPathComponents(canonicalRoot, watchPath);
    }
    const runtimeIgnore = normalizedRuntimeIgnore(canonicalRoot, options.runtimeStatePath);
    const scope: CompiledProjectScope = Object.freeze({
      registration: options.registration,
      manifest: options.manifest,
      canonicalRoot,
      rootIdentity: Object.freeze({ device: before.dev, inode: before.ino }),
      watchPaths: uniqueSorted(options.manifest.watch_paths),
      ignorePaths: uniqueSorted([
        ...BUILT_IN_IGNORES,
        ...options.manifest.ignore_paths,
        ...(runtimeIgnore === null ? [] : [runtimeIgnore]),
      ]),
    });
    assertRoot(scope);
    return scope;
  } catch (error) {
    throw error instanceof RuntimeProjectError
      ? error
      : new RuntimeProjectError("RUNTIME_PROJECT_PATH_UNSAFE");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function classifyProjectChange(
  scope: CompiledProjectScope,
  absolutePath: string,
): string | null {
  assertRoot(scope);
  const relative = rootRelative(scope.canonicalRoot, absolutePath);
  if (relative === null) return null;
  if (isIgnored(scope, relative)) return null;
  if (!scope.watchPaths.some((watched) => containedBy(relative, watched))) return null;
  return relative;
}

function consumeBudget(budget: ScanBudget, relativePath: string): void {
  budget.entries += 1;
  budget.metadataBytes += Buffer.byteLength(relativePath, "utf8") + 128;
  if (budget.entries > MAX_SCAN_ENTRIES || budget.metadataBytes > MAX_SCAN_METADATA_BYTES) {
    projectError("RUNTIME_PROJECT_UNAVAILABLE");
  }
}

function fileIdentity(metadata: BigIntStats): ProjectFileIdentity {
  return Object.freeze({
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    mtime_ns: metadata.mtimeNs.toString(),
    size: metadata.size.toString(),
  });
}

function assertInternalSymlink(canonicalRoot: string, absolutePath: string): void {
  try {
    const target = realpathSync.native(absolutePath);
    if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
  } catch (error) {
    if (error instanceof RuntimeProjectError) throw error;
    projectError("RUNTIME_PROJECT_PATH_UNSAFE");
  }
}

function scanEntry(
  scope: CompiledProjectScope,
  absolutePath: string,
  relativePath: string,
  changes: Map<string, ProjectChange>,
  budget: ScanBudget,
): void {
  if (isIgnored(scope, relativePath)) return;
  consumeBudget(budget, relativePath);
  let before: BigIntStats;
  try {
    before = lstatSync(absolutePath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {
      assertRoot(scope);
      return;
    }
    throw new RuntimeProjectError("RUNTIME_PROJECT_PATH_UNSAFE");
  }
  if (before.isSymbolicLink()) {
    assertInternalSymlink(scope.canonicalRoot, absolutePath);
    return;
  }
  if (before.isDirectory()) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        absolutePath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const held = fstatSync(descriptor, { bigint: true });
      if (held.dev !== before.dev || held.ino !== before.ino) {
        projectError("RUNTIME_PROJECT_PATH_UNSAFE");
      }
      const names = readdirSync(absolutePath).sort(bytewise);
      for (const name of names) {
        const childRelative = `${relativePath}/${name}`;
        if (isIgnored(scope, childRelative)) continue;
        if (!isSafeProjectRelativePath(childRelative)) {
          projectError("RUNTIME_PROJECT_PATH_UNSAFE");
        }
        scanEntry(scope, path.join(absolutePath, name), childRelative, changes, budget);
      }
      const after = lstatSync(absolutePath, { bigint: true });
      const heldAfter = fstatSync(descriptor, { bigint: true });
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        heldAfter.dev !== before.dev ||
        heldAfter.ino !== before.ino
      ) {
        projectError("RUNTIME_PROJECT_PATH_UNSAFE");
      }
    } catch (error) {
      if (isMissing(error)) {
        assertRoot(scope);
        return;
      }
      if (error instanceof RuntimeProjectError) throw error;
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    return;
  }
  if (!before.isFile()) return;

  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const held = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(absolutePath, { bigint: true });
    if (
      held.dev !== before.dev ||
      held.ino !== before.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      held.size !== before.size ||
      held.mtimeNs !== before.mtimeNs
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    changes.set(
      relativePath,
      Object.freeze({ kind: "CHANGED", path: relativePath, identity: fileIdentity(held) }),
    );
  } catch (error) {
    if (isMissing(error)) {
      assertRoot(scope);
      return;
    }
    if (error instanceof RuntimeProjectError) throw error;
    projectError("RUNTIME_PROJECT_PATH_UNSAFE");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function scanDeclaredScope(scope: CompiledProjectScope): readonly ProjectChange[] {
  assertRoot(scope);
  const changes = new Map<string, ProjectChange>();
  const budget: ScanBudget = { entries: 0, metadataBytes: 0 };
  for (const watchPath of scope.watchPaths) {
    if (isIgnored(scope, watchPath)) continue;
    scanEntry(
      scope,
      path.join(scope.canonicalRoot, ...watchPath.split("/")),
      watchPath,
      changes,
      budget,
    );
  }
  assertRoot(scope);
  return Object.freeze(
    [...changes.values()].sort((left, right) => bytewise(left.path, right.path)),
  );
}
