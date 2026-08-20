import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";

import { RuntimeProjectError } from "./errors.js";

const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;

export interface PrivateFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface PrivateFileSnapshot {
  readonly bytes: Uint8Array;
  readonly identity: PrivateFileIdentity;
}

export interface PrivateRegistryFiles {
  readonly registryPath: string;
  readonly quarantinePath: string;
  ensureRoots(): void;
  read(): PrivateFileSnapshot | null;
  append(expected: PrivateFileSnapshot | null, bytes: Uint8Array): void;
  recoverPartial(
    expected: PrivateFileSnapshot,
    prefix: Uint8Array,
    fragment: Uint8Array,
    randomId: string,
  ): void;
}

function pathUnsafe(): never {
  throw new RuntimeProjectError("RUNTIME_PROJECT_PATH_UNSAFE");
}

function unavailable(): never {
  throw new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE");
}

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function currentUid(): bigint | undefined {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
}

function identity(metadata: Pick<BigIntStats, "dev" | "ino">): PrivateFileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function sameIdentity(left: PrivateFileIdentity, right: PrivateFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function isAtOrBelow(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function directoryCandidates(candidate: string): readonly string[] {
  if (
    !path.isAbsolute(candidate) ||
    path.normalize(candidate) !== candidate ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    pathUnsafe();
  }
  const parsed = path.parse(candidate);
  const segments = candidate.slice(parsed.root.length).split(path.sep);
  let current = parsed.root;
  return segments.map((segment) => {
    if (segment.length === 0 || segment === "." || segment === "..") pathUnsafe();
    current = path.join(current, segment);
    return current;
  });
}

function assertDirectory(metadata: BigIntStats, candidate: string, exactPrivate: boolean): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) pathUnsafe();
  const uid = currentUid();
  const mode = Number(metadata.mode & 0o7777n);
  if (exactPrivate) {
    if ((uid !== undefined && metadata.uid !== uid) || (mode & 0o777) !== 0o700) pathUnsafe();
    return;
  }
  if (uid !== undefined && metadata.uid === uid) {
    if ((mode & 0o022) !== 0) pathUnsafe();
    return;
  }
  if (metadata.uid !== 0n || ((mode & 0o022) !== 0 && (mode & 0o1000) === 0)) pathUnsafe();
}

function syncDirectory(candidate: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      candidate,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof RuntimeProjectError) throw error;
    unavailable();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensurePrivateDirectory(candidate: string, privateRoot: string): void {
  for (const current of directoryCandidates(candidate)) {
    let metadata: BigIntStats;
    try {
      metadata = lstatSync(current, { bigint: true });
    } catch (error) {
      if (code(error) !== "ENOENT") pathUnsafe();
      try {
        mkdirSync(current, { mode: 0o700 });
        syncDirectory(current);
        syncDirectory(path.dirname(current));
        metadata = lstatSync(current, { bigint: true });
      } catch (mkdirError) {
        if (code(mkdirError) !== "EEXIST") unavailable();
        metadata = lstatSync(current, { bigint: true });
      }
    }
    assertDirectory(metadata, current, isAtOrBelow(current, privateRoot));
  }
}

function assertPrivateFile(
  metadata: BigIntStats,
  expected?: PrivateFileIdentity,
): PrivateFileIdentity {
  const uid = currentUid();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (uid !== undefined && metadata.uid !== uid) ||
    Number(metadata.mode & 0o777n) !== 0o600 ||
    (expected !== undefined && !sameIdentity(expected, identity(metadata)))
  ) {
    pathUnsafe();
  }
  return identity(metadata);
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = writeSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
    if (written === 0) unavailable();
    offset += written;
  }
}

function exactBytes(
  candidate: string,
  descriptor: number,
  expectedIdentity: PrivateFileIdentity,
  expectedBytes: Uint8Array,
): void {
  const pathMetadata = lstatSync(candidate, { bigint: true });
  const heldMetadata = fstatSync(descriptor, { bigint: true });
  assertPrivateFile(pathMetadata, expectedIdentity);
  assertPrivateFile(heldMetadata, expectedIdentity);
  const actual = Buffer.allocUnsafe(expectedBytes.byteLength);
  let offset = 0;
  while (offset < actual.byteLength) {
    const bytesRead = readSync(descriptor, actual, offset, actual.byteLength - offset, offset);
    if (bytesRead === 0) pathUnsafe();
    offset += bytesRead;
  }
  if (
    pathMetadata.size !== BigInt(expectedBytes.byteLength) ||
    heldMetadata.size !== BigInt(expectedBytes.byteLength) ||
    !actual.equals(Buffer.from(expectedBytes))
  ) {
    pathUnsafe();
  }
}

function openPrivateRead(candidate: string): PrivateFileSnapshot | null {
  let descriptor: number | undefined;
  try {
    const pathMetadata = lstatSync(candidate, { bigint: true });
    const expectedIdentity = assertPrivateFile(pathMetadata);
    descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    assertPrivateFile(fstatSync(descriptor, { bigint: true }), expectedIdentity);
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength > MAX_REGISTRY_BYTES) unavailable();
    fsyncSync(descriptor);
    exactBytes(candidate, descriptor, expectedIdentity, bytes);
    return { bytes, identity: expectedIdentity };
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    if (error instanceof RuntimeProjectError) throw error;
    return unavailable();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function createPrivateRegistryFiles(statePath: string): PrivateRegistryFiles {
  const projectsPath = path.join(statePath, "projects");
  const directoryPath = path.join(projectsPath, "registry");
  const quarantinePath = path.join(projectsPath, "quarantine");
  const registryPath = path.join(directoryPath, "entries.jsonl");

  const ensureRoots = (): void => {
    ensurePrivateDirectory(statePath, statePath);
    ensurePrivateDirectory(projectsPath, statePath);
    ensurePrivateDirectory(directoryPath, statePath);
    ensurePrivateDirectory(quarantinePath, statePath);
  };

  return {
    registryPath,
    quarantinePath,
    ensureRoots,
    read() {
      ensureRoots();
      return openPrivateRead(registryPath);
    },
    append(expected, bytes) {
      ensureRoots();
      if ((expected?.bytes.byteLength ?? 0) + bytes.byteLength > MAX_REGISTRY_BYTES) unavailable();
      let descriptor: number | undefined;
      try {
        if (expected === null) {
          descriptor = openSync(
            registryPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
            0o600,
          );
          const created = assertPrivateFile(fstatSync(descriptor, { bigint: true }));
          writeAll(descriptor, bytes);
          fsyncSync(descriptor);
          exactBytes(registryPath, descriptor, created, bytes);
          syncDirectory(directoryPath);
          exactBytes(registryPath, descriptor, created, bytes);
          return;
        }
        descriptor = openSync(
          registryPath,
          constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW,
        );
        exactBytes(registryPath, descriptor, expected.identity, expected.bytes);
        writeAll(descriptor, bytes);
        const combined = Buffer.concat([Buffer.from(expected.bytes), Buffer.from(bytes)]);
        fsyncSync(descriptor);
        exactBytes(registryPath, descriptor, expected.identity, combined);
      } catch (error) {
        if (error instanceof RuntimeProjectError) throw error;
        unavailable();
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    },
    recoverPartial(expected, prefix, fragment, randomId) {
      ensureRoots();
      const quarantineFile = path.join(quarantinePath, `project-registry-${randomId}.bin`);
      const stagePath = path.join(directoryPath, `.entries-recovery.${randomId}.stage`);
      let quarantine: number | undefined;
      let stage: number | undefined;
      let current: number | undefined;
      try {
        quarantine = openSync(
          quarantineFile,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        );
        const quarantineIdentity = assertPrivateFile(fstatSync(quarantine, { bigint: true }));
        writeAll(quarantine, fragment);
        fsyncSync(quarantine);
        exactBytes(quarantineFile, quarantine, quarantineIdentity, fragment);
        syncDirectory(quarantinePath);
        exactBytes(quarantineFile, quarantine, quarantineIdentity, fragment);

        stage = openSync(
          stagePath,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        );
        const stageIdentity = assertPrivateFile(fstatSync(stage, { bigint: true }));
        writeAll(stage, prefix);
        fsyncSync(stage);
        exactBytes(stagePath, stage, stageIdentity, prefix);
        current = openSync(registryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        exactBytes(registryPath, current, expected.identity, expected.bytes);
        renameSync(stagePath, registryPath);
        exactBytes(registryPath, stage, stageIdentity, prefix);
        syncDirectory(directoryPath);
        exactBytes(registryPath, stage, stageIdentity, prefix);
      } catch (error) {
        if (error instanceof RuntimeProjectError) throw error;
        unavailable();
      } finally {
        if (current !== undefined) closeSync(current);
        if (stage !== undefined) closeSync(stage);
        if (quarantine !== undefined) closeSync(quarantine);
      }
    },
  };
}

export function canonicalProjectRoot(candidate: string): string {
  if (
    !path.isAbsolute(candidate) ||
    path.normalize(candidate) !== candidate ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    pathUnsafe();
  }
  try {
    const finalMetadata = lstatSync(candidate, { bigint: true });
    if (finalMetadata.isSymbolicLink()) pathUnsafe();
    const canonical = realpathSync(candidate);
    const metadata = lstatSync(canonical, { bigint: true });
    const uid = currentUid();
    if (
      !metadata.isDirectory() ||
      (uid !== undefined && metadata.uid !== uid) ||
      (Number(metadata.mode & 0o700n) & 0o500) !== 0o500
    ) {
      pathUnsafe();
    }
    return canonical;
  } catch (error) {
    if (error instanceof RuntimeProjectError) throw error;
    if (code(error) === "ENOENT") unavailable();
    pathUnsafe();
  }
}
