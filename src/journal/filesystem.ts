import {
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { RuntimeJournalError } from "./errors.js";

export const MAX_RUN_JOURNAL_BYTES = 64 * 1024 * 1024;

const RUN_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CREATE_STAGE_PATTERN = /^\.events-create\.[0-9a-f-]{36}\.stage$/u;
const RECOVERY_STAGE_PATTERN = /^\.events-recovery\.[0-9a-f-]{36}\.stage$/u;
const EVENTS_NAME = "events.jsonl";

type CurrentUserCheck = (userId: bigint, candidate: string) => boolean;

export interface JournalOperationHooks {
  readonly beforeJournalSync?: () => Promise<void>;
  readonly beforeDirectorySync?: (directoryPath: string) => Promise<void>;
  readonly beforeDirectoryCreationSync?: (
    directoryPath: string,
    parentPath: string,
  ) => Promise<void>;
  readonly beforeAppendWrite?: () => Promise<void>;
  readonly beforeStageCleanup?: (stagePath: string) => Promise<void>;
  readonly beforeRecoveryRename?: () => Promise<void>;
}

export interface CreateJournalFilesystemOptions {
  readonly statePath: string;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly isCurrentUser?: CurrentUserCheck;
  readonly operationHooks?: JournalOperationHooks;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface OpenedDirectory {
  readonly candidate: string;
  readonly exactPrivate: boolean;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
}

export interface JournalFileSnapshot {
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
}

export interface JournalFilesystem {
  readonly statePath: string;
  readonly journalsPath: string;
  readonly quarantinePath: string;
  ensureRoots(): Promise<void>;
  listRunIds(): Promise<readonly string[]>;
  read(runId: string): Promise<JournalFileSnapshot | null>;
  create(runId: string, bytes: Uint8Array): Promise<"created" | "existing">;
  append(runId: string, expected: JournalFileSnapshot, bytes: Uint8Array): Promise<void>;
  recoverPartial(
    runId: string,
    expected: FileIdentity,
    validPrefix: Uint8Array,
    fragment: Uint8Array,
  ): Promise<void>;
}

function pathUnsafe(): never {
  throw new RuntimeJournalError("RUNTIME_JOURNAL_PATH_UNSAFE");
}

function unavailable(): never {
  throw new RuntimeJournalError("RUNTIME_JOURNAL_UNAVAILABLE");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function defaultCurrentUser(userId: bigint): boolean {
  return typeof process.getuid !== "function" || BigInt(process.getuid()) === userId;
}

function identity(metadata: Pick<BigIntStats, "dev" | "ino">): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function identitiesMatch(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) pathUnsafe();
}

function assertRandomId(randomId: string): void {
  if (!UUID_PATTERN.test(randomId)) pathUnsafe();
}

function assertPrivateDirectory(
  metadata: BigIntStats,
  candidate: string,
  isCurrentUser: CurrentUserCheck,
  final: boolean,
  reachedCurrentUser: boolean,
): boolean {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) pathUnsafe();
  const mode = Number(metadata.mode & 0o7777n);
  const owned = isCurrentUser(metadata.uid, candidate);
  if (final) {
    if (!owned || (mode & 0o777) !== 0o700) pathUnsafe();
    return true;
  }
  if (owned) {
    if ((mode & 0o022) !== 0 && !((mode & 0o1000) !== 0 && metadata.uid === 0n)) {
      pathUnsafe();
    }
    return true;
  }
  if (
    reachedCurrentUser ||
    metadata.uid !== 0n ||
    ((mode & 0o022) !== 0 && (mode & 0o1000) === 0)
  ) {
    pathUnsafe();
  }
  return false;
}

async function ensurePrivateDirectory(
  candidate: string,
  isCurrentUser: CurrentUserCheck,
  exactPrivateRoot: string,
  beforeParentSync?: (directoryPath: string, parentPath: string) => Promise<void>,
): Promise<void> {
  if (
    !path.isAbsolute(candidate) ||
    candidate === path.parse(candidate).root ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    pathUnsafe();
  }
  const normalized = path.normalize(candidate);
  if (normalized !== candidate) pathUnsafe();
  const parsed = path.parse(candidate);
  const segments = candidate.slice(parsed.root.length).split(path.sep);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    pathUnsafe();
  }

  let current = parsed.root;
  let reachedCurrentUser = false;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const final = index === segments.length - 1;
    let metadata: BigIntStats;
    try {
      metadata = await lstat(current, { bigint: true });
    } catch (error) {
      if (!isMissing(error)) pathUnsafe();
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isExisting(mkdirError)) pathUnsafe();
      }
      try {
        metadata = await lstat(current, { bigint: true });
      } catch {
        pathUnsafe();
      }
    }
    reachedCurrentUser =
      assertPrivateDirectory(metadata, current, isCurrentUser, final, reachedCurrentUser) ||
      reachedCurrentUser;
  }
  await syncPrivateDirectoryEntry(candidate, isCurrentUser, exactPrivateRoot, beforeParentSync);
}

function assertPrivateFile(
  metadata: BigIntStats,
  candidate: string,
  isCurrentUser: CurrentUserCheck,
): void {
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !isCurrentUser(metadata.uid, candidate) ||
    Number(metadata.mode & 0o777n) !== 0o600
  ) {
    pathUnsafe();
  }
}

function directoryChainPaths(candidate: string): readonly string[] {
  const parsed = path.parse(candidate);
  const segments = candidate.slice(parsed.root.length).split(path.sep);
  let current = parsed.root;
  return segments.map((segment) => {
    current = path.join(current, segment);
    return current;
  });
}

function isAtOrBelow(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function openDirectoryChain(
  candidate: string,
  isCurrentUser: CurrentUserCheck,
  exactPrivateRoot: string,
): Promise<readonly OpenedDirectory[]> {
  const result: OpenedDirectory[] = [];
  let reachedCurrentUser = false;
  try {
    const candidates = directoryChainPaths(candidate);
    for (const current of candidates) {
      const exactPrivate = isAtOrBelow(current, exactPrivateRoot);
      const before = await lstat(current, { bigint: true });
      const nextReached = assertPrivateDirectory(
        before,
        current,
        isCurrentUser,
        exactPrivate,
        reachedCurrentUser,
      );
      const handle = await open(
        current,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      result.push({ candidate: current, exactPrivate, handle, identity: identity(before) });
      const held = await handle.stat({ bigint: true });
      assertPrivateDirectory(held, current, isCurrentUser, exactPrivate, reachedCurrentUser);
      if (!identitiesMatch(identity(before), identity(held))) pathUnsafe();
      reachedCurrentUser = nextReached || reachedCurrentUser;
    }
    return result;
  } catch (error) {
    for (const opened of result.reverse()) {
      await opened.handle.close().catch(() => undefined);
    }
    if (error instanceof RuntimeJournalError) throw error;
    pathUnsafe();
  }
}

async function closeDirectoryChain(opened: readonly OpenedDirectory[]): Promise<void> {
  for (const directory of [...opened].reverse()) {
    await directory.handle.close();
  }
}

function readExactSync(fileDescriptor: number, expectedBytes: Uint8Array): void {
  const actual = Buffer.allocUnsafe(expectedBytes.byteLength);
  let offset = 0;
  while (offset < actual.byteLength) {
    const bytesRead = readSync(fileDescriptor, actual, offset, actual.byteLength - offset, offset);
    if (bytesRead === 0) pathUnsafe();
    offset += bytesRead;
  }
  if (!actual.equals(Buffer.from(expectedBytes))) pathUnsafe();
}

function writeAllSync(fileDescriptor: number, bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const bytesWritten = writeSync(
      fileDescriptor,
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    );
    if (bytesWritten === 0) unavailable();
    offset += bytesWritten;
  }
}

function assertExactPrivateFileSync(
  candidate: string,
  fileDescriptor: number,
  expectedIdentity: FileIdentity,
  expectedBytes: Uint8Array,
  isCurrentUser: CurrentUserCheck,
): void {
  try {
    const before = lstatSync(candidate, { bigint: true });
    const heldBefore = fstatSync(fileDescriptor, { bigint: true });
    assertPrivateFile(before, candidate, isCurrentUser);
    assertPrivateFile(heldBefore, candidate, isCurrentUser);
    if (
      !identitiesMatch(expectedIdentity, identity(before)) ||
      !identitiesMatch(expectedIdentity, identity(heldBefore)) ||
      before.size !== BigInt(expectedBytes.byteLength) ||
      heldBefore.size !== BigInt(expectedBytes.byteLength)
    ) {
      pathUnsafe();
    }
    readExactSync(fileDescriptor, expectedBytes);
    const after = lstatSync(candidate, { bigint: true });
    const heldAfter = fstatSync(fileDescriptor, { bigint: true });
    assertPrivateFile(after, candidate, isCurrentUser);
    assertPrivateFile(heldAfter, candidate, isCurrentUser);
    if (
      !identitiesMatch(expectedIdentity, identity(after)) ||
      !identitiesMatch(expectedIdentity, identity(heldAfter)) ||
      after.size !== BigInt(expectedBytes.byteLength) ||
      heldAfter.size !== BigInt(expectedBytes.byteLength)
    ) {
      pathUnsafe();
    }
  } catch (error) {
    if (error instanceof RuntimeJournalError) throw error;
    pathUnsafe();
  }
}

function assertLinkedPrivateFileSync(
  candidate: string,
  expectedIdentity: FileIdentity,
  isCurrentUser: CurrentUserCheck,
): void {
  try {
    const metadata = lstatSync(candidate, { bigint: true });
    assertPrivateFile(metadata, candidate, isCurrentUser);
    if (!identitiesMatch(expectedIdentity, identity(metadata))) pathUnsafe();
  } catch (error) {
    if (error instanceof RuntimeJournalError) throw error;
    pathUnsafe();
  }
}

function revalidateDirectoryChainSync(
  opened: readonly OpenedDirectory[],
  isCurrentUser: CurrentUserCheck,
): void {
  try {
    let reachedCurrentUser = false;
    for (const directory of opened) {
      const current = lstatSync(directory.candidate, { bigint: true });
      const held = fstatSync(directory.handle.fd, { bigint: true });
      const nextReached = assertPrivateDirectory(
        current,
        directory.candidate,
        isCurrentUser,
        directory.exactPrivate,
        reachedCurrentUser,
      );
      assertPrivateDirectory(
        held,
        directory.candidate,
        isCurrentUser,
        directory.exactPrivate,
        reachedCurrentUser,
      );
      if (
        !identitiesMatch(directory.identity, identity(current)) ||
        !identitiesMatch(directory.identity, identity(held))
      ) {
        pathUnsafe();
      }
      reachedCurrentUser = nextReached || reachedCurrentUser;
    }
  } catch (error) {
    if (error instanceof RuntimeJournalError) throw error;
    pathUnsafe();
  }
}

async function syncAndRevalidateDirectoryChain(
  opened: readonly OpenedDirectory[],
  isCurrentUser: CurrentUserCheck,
  beforeSync?: (directoryPath: string) => Promise<void>,
): Promise<void> {
  const final = opened.at(-1);
  if (final === undefined) pathUnsafe();
  revalidateDirectoryChainSync(opened, isCurrentUser);
  await beforeSync?.(final.candidate);
  await final.handle.sync();
  revalidateDirectoryChainSync(opened, isCurrentUser);
}

async function syncPrivateDirectoryEntry(
  candidate: string,
  isCurrentUser: CurrentUserCheck,
  exactPrivateRoot: string,
  beforeParentSync?: (directoryPath: string, parentPath: string) => Promise<void>,
): Promise<void> {
  const opened = await openDirectoryChain(candidate, isCurrentUser, exactPrivateRoot);
  try {
    const parentDirectories = opened.slice(0, -1);
    const parent = parentDirectories.at(-1);
    if (parent === undefined) pathUnsafe();
    await syncAndRevalidateDirectoryChain(opened, isCurrentUser);
    await syncAndRevalidateDirectoryChain(
      parentDirectories,
      isCurrentUser,
      beforeParentSync === undefined
        ? undefined
        : (parentPath) => beforeParentSync(candidate, parentPath),
    );
    revalidateDirectoryChainSync(opened, isCurrentUser);
  } catch (error) {
    if (error instanceof RuntimeJournalError) throw error;
    unavailable();
  } finally {
    await closeDirectoryChain(opened);
  }
}

function unlinkExactPrivateFileSync(
  candidate: string,
  expected: FileIdentity,
  isCurrentUser: CurrentUserCheck,
): void {
  try {
    assertLinkedPrivateFileSync(candidate, expected, isCurrentUser);
    assertLinkedPrivateFileSync(candidate, expected, isCurrentUser);
    unlinkSync(candidate);
  } catch (error) {
    if (isMissing(error)) return;
    if (error instanceof RuntimeJournalError) throw error;
    unavailable();
  }
}

function requireMissingSync(candidate: string): void {
  try {
    lstatSync(candidate, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    pathUnsafe();
  }
  pathUnsafe();
}

async function readBounded(handle: FileHandle): Promise<Uint8Array> {
  const metadata = await handle.stat({ bigint: true });
  if (metadata.size > BigInt(MAX_RUN_JOURNAL_BYTES)) unavailable();
  const expected = Number(metadata.size);
  const bytes = Buffer.allocUnsafe(expected);
  let offset = 0;
  while (offset < expected) {
    const result = await handle.read(bytes, offset, expected - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== expected) unavailable();
  return bytes;
}

export function createJournalFilesystem(
  options: CreateJournalFilesystemOptions,
): JournalFilesystem {
  const isCurrentUser = options.isCurrentUser ?? defaultCurrentUser;
  const journalsPath = path.join(options.statePath, "journals");
  const quarantinePath = path.join(options.statePath, "quarantine");

  const ensureRoots = async (): Promise<void> => {
    await ensurePrivateDirectory(
      options.statePath,
      isCurrentUser,
      options.statePath,
      options.operationHooks?.beforeDirectoryCreationSync,
    );
    await ensurePrivateDirectory(
      journalsPath,
      isCurrentUser,
      options.statePath,
      options.operationHooks?.beforeDirectoryCreationSync,
    );
    await ensurePrivateDirectory(
      quarantinePath,
      isCurrentUser,
      options.statePath,
      options.operationHooks?.beforeDirectoryCreationSync,
    );
  };

  const runPath = (runId: string): string => {
    assertRunId(runId);
    return path.join(journalsPath, runId);
  };

  const ensureRun = async (runId: string): Promise<string> => {
    await ensureRoots();
    const candidate = runPath(runId);
    await ensurePrivateDirectory(
      candidate,
      isCurrentUser,
      options.statePath,
      options.operationHooks?.beforeDirectoryCreationSync,
    );
    return candidate;
  };

  const existingRun = async (runId: string): Promise<string | null> => {
    await ensureRoots();
    const candidate = runPath(runId);
    try {
      const metadata = await lstat(candidate, { bigint: true });
      assertPrivateDirectory(metadata, candidate, isCurrentUser, true, true);
      return candidate;
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof RuntimeJournalError) throw error;
      pathUnsafe();
    }
  };

  const removeStages = async (directory: string, entries: readonly string[]): Promise<void> => {
    const stages = entries.filter(
      (entry) => CREATE_STAGE_PATTERN.test(entry) || RECOVERY_STAGE_PATTERN.test(entry),
    );
    if (stages.length > 0) {
      const opened = await openDirectoryChain(directory, isCurrentUser, options.statePath);
      try {
        for (const name of stages) {
          const candidate = path.join(directory, name);
          const metadata = await lstat(candidate, { bigint: true });
          assertPrivateFile(metadata, candidate, isCurrentUser);
          await options.operationHooks?.beforeStageCleanup?.(candidate);
          revalidateDirectoryChainSync(opened, isCurrentUser);
          unlinkExactPrivateFileSync(candidate, identity(metadata), isCurrentUser);
          revalidateDirectoryChainSync(opened, isCurrentUser);
        }
        await syncAndRevalidateDirectoryChain(
          opened,
          isCurrentUser,
          options.operationHooks?.beforeDirectorySync,
        );
      } finally {
        await closeDirectoryChain(opened);
      }
    }
  };

  const inspectRunEntries = async (directory: string): Promise<readonly string[]> => {
    const entries = await readdir(directory);
    if (
      entries.some(
        (entry) =>
          entry !== EVENTS_NAME &&
          !CREATE_STAGE_PATTERN.test(entry) &&
          !RECOVERY_STAGE_PATTERN.test(entry),
      )
    ) {
      pathUnsafe();
    }
    await removeStages(directory, entries);
    return entries.filter((entry) => entry === EVENTS_NAME);
  };

  const read = async (runId: string): Promise<JournalFileSnapshot | null> => {
    try {
      const directory = await existingRun(runId);
      if (directory === null) return null;
      const entries = await inspectRunEntries(directory);
      if (entries.length === 0) return null;
      const candidate = path.join(directory, EVENTS_NAME);
      const runDirectories = await openDirectoryChain(directory, isCurrentUser, options.statePath);
      try {
        const before = await lstat(candidate, { bigint: true });
        assertPrivateFile(before, candidate, isCurrentUser);
        const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat({ bigint: true });
          assertPrivateFile(opened, candidate, isCurrentUser);
          if (!identitiesMatch(identity(before), identity(opened))) pathUnsafe();
          const bytes = await readBounded(handle);
          await options.operationHooks?.beforeJournalSync?.();
          await handle.sync();
          assertExactPrivateFileSync(candidate, handle.fd, identity(opened), bytes, isCurrentUser);
          await syncAndRevalidateDirectoryChain(
            runDirectories,
            isCurrentUser,
            options.operationHooks?.beforeDirectorySync,
          );
          assertExactPrivateFileSync(candidate, handle.fd, identity(opened), bytes, isCurrentUser);
          revalidateDirectoryChainSync(runDirectories, isCurrentUser);
          return { bytes, identity: identity(opened) };
        } finally {
          await handle.close();
        }
      } finally {
        await closeDirectoryChain(runDirectories);
      }
    } catch (error) {
      if (error instanceof RuntimeJournalError) throw error;
      if (isMissing(error)) return null;
      unavailable();
    }
  };

  const create = async (runId: string, bytes: Uint8Array): Promise<"created" | "existing"> => {
    if (bytes.byteLength > MAX_RUN_JOURNAL_BYTES) unavailable();
    const directory = await ensureRun(runId);
    await inspectRunEntries(directory);
    const randomId = options.randomId();
    assertRandomId(randomId);
    const stagePath = path.join(directory, `.events-create.${randomId}.stage`);
    const eventsPath = path.join(directory, EVENTS_NAME);
    const runDirectories = await openDirectoryChain(directory, isCurrentUser, options.statePath);
    let stageIdentity: FileIdentity | undefined;
    try {
      const stage = await open(
        stagePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const metadata = await stage.stat({ bigint: true });
        assertPrivateFile(metadata, stagePath, isCurrentUser);
        stageIdentity = identity(metadata);
        await stage.writeFile(bytes);
        await options.operationHooks?.beforeJournalSync?.();
        await stage.sync();
        revalidateDirectoryChainSync(runDirectories, isCurrentUser);
        assertExactPrivateFileSync(stagePath, stage.fd, stageIdentity, bytes, isCurrentUser);
        try {
          linkSync(stagePath, eventsPath);
        } catch (error) {
          if (!isExisting(error)) throw error;
          revalidateDirectoryChainSync(runDirectories, isCurrentUser);
          unlinkExactPrivateFileSync(stagePath, stageIdentity, isCurrentUser);
          stageIdentity = undefined;
          await syncAndRevalidateDirectoryChain(
            runDirectories,
            isCurrentUser,
            options.operationHooks?.beforeDirectorySync,
          );
          return "existing";
        }
        const publishedIdentity = stageIdentity;
        assertExactPrivateFileSync(stagePath, stage.fd, stageIdentity, bytes, isCurrentUser);
        assertLinkedPrivateFileSync(eventsPath, stageIdentity, isCurrentUser);
        revalidateDirectoryChainSync(runDirectories, isCurrentUser);
        unlinkExactPrivateFileSync(stagePath, stageIdentity, isCurrentUser);
        stageIdentity = undefined;
        await syncAndRevalidateDirectoryChain(
          runDirectories,
          isCurrentUser,
          options.operationHooks?.beforeDirectorySync,
        );
        assertExactPrivateFileSync(eventsPath, stage.fd, publishedIdentity, bytes, isCurrentUser);
        revalidateDirectoryChainSync(runDirectories, isCurrentUser);
        return "created";
      } finally {
        await stage.close();
      }
    } catch (error) {
      if (stageIdentity !== undefined) {
        try {
          revalidateDirectoryChainSync(runDirectories, isCurrentUser);
          unlinkExactPrivateFileSync(stagePath, stageIdentity, isCurrentUser);
        } catch {
          // Preserve the primary safe failure; later recovery validates the stage.
        }
      }
      if (error instanceof RuntimeJournalError) throw error;
      unavailable();
    } finally {
      await closeDirectoryChain(runDirectories);
    }
  };

  const append = async (
    runId: string,
    expected: JournalFileSnapshot,
    bytes: Uint8Array,
  ): Promise<void> => {
    const directory = await ensureRun(runId);
    await inspectRunEntries(directory);
    const candidate = path.join(directory, EVENTS_NAME);
    const runDirectories = await openDirectoryChain(directory, isCurrentUser, options.statePath);
    try {
      const before = await lstat(candidate, { bigint: true });
      assertPrivateFile(before, candidate, isCurrentUser);
      if (!identitiesMatch(expected.identity, identity(before))) pathUnsafe();
      const handle = await open(
        candidate,
        constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW,
      );
      try {
        const opened = await handle.stat({ bigint: true });
        assertPrivateFile(opened, candidate, isCurrentUser);
        if (!identitiesMatch(expected.identity, identity(opened))) pathUnsafe();
        if (
          expected.bytes.byteLength + bytes.byteLength > MAX_RUN_JOURNAL_BYTES ||
          opened.size !== BigInt(expected.bytes.byteLength)
        ) {
          unavailable();
        }
        await options.operationHooks?.beforeAppendWrite?.();
        revalidateDirectoryChainSync(runDirectories, isCurrentUser);
        assertExactPrivateFileSync(
          candidate,
          handle.fd,
          expected.identity,
          expected.bytes,
          isCurrentUser,
        );
        writeAllSync(handle.fd, bytes);
        await options.operationHooks?.beforeJournalSync?.();
        await handle.sync();
        assertExactPrivateFileSync(
          candidate,
          handle.fd,
          expected.identity,
          Buffer.concat([Buffer.from(expected.bytes), Buffer.from(bytes)]),
          isCurrentUser,
        );
        revalidateDirectoryChainSync(runDirectories, isCurrentUser);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof RuntimeJournalError) throw error;
      unavailable();
    } finally {
      await closeDirectoryChain(runDirectories);
    }
  };

  const recoverPartial = async (
    runId: string,
    expected: FileIdentity,
    validPrefix: Uint8Array,
    fragment: Uint8Array,
  ): Promise<void> => {
    const directory = await ensureRun(runId);
    const randomId = options.randomId();
    assertRandomId(randomId);
    const timestamp = options.now().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const digest = createHash("sha256").update(fragment).digest("hex");
    const quarantineFile = path.join(
      quarantinePath,
      `run-journal-${timestamp}-${digest}-${randomId}.bin`,
    );
    const stagePath = path.join(directory, `.events-recovery.${randomId}.stage`);
    const eventsPath = path.join(directory, EVENTS_NAME);
    const runDirectories = await openDirectoryChain(directory, isCurrentUser, options.statePath);
    let stageIdentity: FileIdentity | undefined;
    try {
      const quarantineDirectories = await openDirectoryChain(
        quarantinePath,
        isCurrentUser,
        options.statePath,
      );
      try {
        const quarantine = await open(
          quarantineFile,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const metadata = await quarantine.stat({ bigint: true });
          assertPrivateFile(metadata, quarantineFile, isCurrentUser);
          const quarantineIdentity = identity(metadata);
          await quarantine.writeFile(fragment);
          await quarantine.sync();
          assertExactPrivateFileSync(
            quarantineFile,
            quarantine.fd,
            quarantineIdentity,
            fragment,
            isCurrentUser,
          );
          await syncAndRevalidateDirectoryChain(
            quarantineDirectories,
            isCurrentUser,
            options.operationHooks?.beforeDirectorySync,
          );
          assertExactPrivateFileSync(
            quarantineFile,
            quarantine.fd,
            quarantineIdentity,
            fragment,
            isCurrentUser,
          );
          revalidateDirectoryChainSync(quarantineDirectories, isCurrentUser);
        } finally {
          await quarantine.close();
        }
      } finally {
        await closeDirectoryChain(quarantineDirectories);
      }

      const stage = await open(
        stagePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const metadata = await stage.stat({ bigint: true });
        assertPrivateFile(metadata, stagePath, isCurrentUser);
        stageIdentity = identity(metadata);
        let publishedIdentity: FileIdentity | undefined;
        await stage.writeFile(validPrefix);
        await stage.sync();
        await options.operationHooks?.beforeRecoveryRename?.();
        const expectedCurrentBytes = Buffer.concat([validPrefix, fragment]);
        const currentHandle = await open(eventsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          assertExactPrivateFileSync(
            eventsPath,
            currentHandle.fd,
            expected,
            expectedCurrentBytes,
            isCurrentUser,
          );
          assertExactPrivateFileSync(
            stagePath,
            stage.fd,
            stageIdentity,
            validPrefix,
            isCurrentUser,
          );
          revalidateDirectoryChainSync(runDirectories, isCurrentUser);
          publishedIdentity = stageIdentity;
          renameSync(stagePath, eventsPath);
          stageIdentity = undefined;
          requireMissingSync(stagePath);
          assertExactPrivateFileSync(
            eventsPath,
            stage.fd,
            publishedIdentity,
            validPrefix,
            isCurrentUser,
          );
          revalidateDirectoryChainSync(runDirectories, isCurrentUser);
        } finally {
          await currentHandle.close();
        }
        await syncAndRevalidateDirectoryChain(
          runDirectories,
          isCurrentUser,
          options.operationHooks?.beforeDirectorySync,
        );
        if (publishedIdentity === undefined) pathUnsafe();
        assertExactPrivateFileSync(
          eventsPath,
          stage.fd,
          publishedIdentity,
          validPrefix,
          isCurrentUser,
        );
        revalidateDirectoryChainSync(runDirectories, isCurrentUser);
      } finally {
        await stage.close();
      }
      const restored = await read(runId);
      if (restored === null || !Buffer.from(restored.bytes).equals(validPrefix)) unavailable();
    } catch (error) {
      if (stageIdentity !== undefined) {
        try {
          revalidateDirectoryChainSync(runDirectories, isCurrentUser);
          unlinkExactPrivateFileSync(stagePath, stageIdentity, isCurrentUser);
        } catch {
          // Preserve the primary safe failure; later recovery validates the stage.
        }
      }
      if (error instanceof RuntimeJournalError) throw error;
      unavailable();
    } finally {
      await closeDirectoryChain(runDirectories);
    }
  };

  return {
    statePath: options.statePath,
    journalsPath,
    quarantinePath,
    ensureRoots,
    async listRunIds() {
      await ensureRoots();
      const entries = await readdir(journalsPath);
      const result: string[] = [];
      for (const entry of entries) {
        assertRunId(entry);
        const candidate = path.join(journalsPath, entry);
        const metadata = await lstat(candidate, { bigint: true });
        assertPrivateDirectory(metadata, candidate, isCurrentUser, true, true);
        result.push(entry);
      }
      return Object.freeze(
        result.sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
      );
    },
    read,
    create,
    append,
    recoverPartial,
  };
}
