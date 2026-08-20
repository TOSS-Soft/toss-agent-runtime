import { constants, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
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
  append(runId: string, expected: FileIdentity, bytes: Uint8Array): Promise<void>;
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
        metadata = await lstat(current, { bigint: true });
      } catch {
        pathUnsafe();
      }
    }
    reachedCurrentUser =
      assertPrivateDirectory(metadata, current, isCurrentUser, final, reachedCurrentUser) ||
      reachedCurrentUser;
  }
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

async function openDirectory(candidate: string): Promise<{
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
}> {
  try {
    const handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat({ bigint: true });
    return { handle, identity: identity(metadata) };
  } catch (error) {
    if (error instanceof RuntimeJournalError) throw error;
    pathUnsafe();
  }
}

async function syncAndRevalidateDirectory(
  candidate: string,
  opened: { readonly handle: FileHandle; readonly identity: FileIdentity },
): Promise<void> {
  await opened.handle.sync();
  const current = await lstat(candidate, { bigint: true });
  const held = await opened.handle.stat({ bigint: true });
  if (
    !current.isDirectory() ||
    !identitiesMatch(opened.identity, identity(current)) ||
    !identitiesMatch(opened.identity, identity(held))
  ) {
    pathUnsafe();
  }
}

async function unlinkExactPrivateFile(
  candidate: string,
  expected: FileIdentity,
  isCurrentUser: CurrentUserCheck,
): Promise<void> {
  try {
    const metadata = await lstat(candidate, { bigint: true });
    assertPrivateFile(metadata, candidate, isCurrentUser);
    if (!identitiesMatch(expected, identity(metadata))) pathUnsafe();
    await unlink(candidate);
  } catch (error) {
    if (isMissing(error)) return;
    if (error instanceof RuntimeJournalError) throw error;
    unavailable();
  }
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
    await ensurePrivateDirectory(options.statePath, isCurrentUser);
    await ensurePrivateDirectory(journalsPath, isCurrentUser);
    await ensurePrivateDirectory(quarantinePath, isCurrentUser);
  };

  const runPath = (runId: string): string => {
    assertRunId(runId);
    return path.join(journalsPath, runId);
  };

  const ensureRun = async (runId: string): Promise<string> => {
    await ensureRoots();
    const candidate = runPath(runId);
    await ensurePrivateDirectory(candidate, isCurrentUser);
    return candidate;
  };

  const removeStages = async (directory: string, entries: readonly string[]): Promise<void> => {
    const stages = entries.filter(
      (entry) => CREATE_STAGE_PATTERN.test(entry) || RECOVERY_STAGE_PATTERN.test(entry),
    );
    for (const name of stages) {
      const candidate = path.join(directory, name);
      const metadata = await lstat(candidate, { bigint: true });
      assertPrivateFile(metadata, candidate, isCurrentUser);
      await unlinkExactPrivateFile(candidate, identity(metadata), isCurrentUser);
    }
    if (stages.length > 0) {
      const opened = await openDirectory(directory);
      try {
        await syncAndRevalidateDirectory(directory, opened);
      } finally {
        await opened.handle.close();
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
      const directory = await ensureRun(runId);
      const entries = await inspectRunEntries(directory);
      if (entries.length === 0) return null;
      const candidate = path.join(directory, EVENTS_NAME);
      const before = await lstat(candidate, { bigint: true });
      assertPrivateFile(before, candidate, isCurrentUser);
      const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat({ bigint: true });
        assertPrivateFile(opened, candidate, isCurrentUser);
        if (!identitiesMatch(identity(before), identity(opened))) pathUnsafe();
        const bytes = await readBounded(handle);
        const after = await lstat(candidate, { bigint: true });
        const held = await handle.stat({ bigint: true });
        if (
          !identitiesMatch(identity(opened), identity(after)) ||
          !identitiesMatch(identity(opened), identity(held))
        ) {
          pathUnsafe();
        }
        return { bytes, identity: identity(opened) };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof RuntimeJournalError) throw error;
      if (isMissing(error)) return null;
      unavailable();
    }
  };

  const create = async (runId: string, bytes: Uint8Array): Promise<"created" | "existing"> => {
    const directory = await ensureRun(runId);
    await inspectRunEntries(directory);
    const randomId = options.randomId();
    assertRandomId(randomId);
    const stagePath = path.join(directory, `.events-create.${randomId}.stage`);
    const eventsPath = path.join(directory, EVENTS_NAME);
    let stageIdentity: FileIdentity | undefined;
    try {
      const stage = await open(
        stagePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const metadata = await stage.stat({ bigint: true });
        assertPrivateFile(metadata, stagePath, isCurrentUser);
        stageIdentity = identity(metadata);
        await stage.writeFile(bytes);
        await options.operationHooks?.beforeJournalSync?.();
        await stage.sync();
      } finally {
        await stage.close();
      }
      try {
        await link(stagePath, eventsPath);
      } catch (error) {
        if (!isExisting(error)) throw error;
        await unlinkExactPrivateFile(stagePath, stageIdentity, isCurrentUser);
        stageIdentity = undefined;
        return "existing";
      }
      await unlinkExactPrivateFile(stagePath, stageIdentity, isCurrentUser);
      stageIdentity = undefined;
      const opened = await openDirectory(directory);
      try {
        await syncAndRevalidateDirectory(directory, opened);
      } finally {
        await opened.handle.close();
      }
      return "created";
    } catch (error) {
      if (stageIdentity !== undefined) {
        try {
          await unlinkExactPrivateFile(stagePath, stageIdentity, isCurrentUser);
        } catch {
          // Preserve the primary safe failure; later recovery validates the stage.
        }
      }
      if (error instanceof RuntimeJournalError) throw error;
      unavailable();
    }
  };

  const append = async (
    runId: string,
    expected: FileIdentity,
    bytes: Uint8Array,
  ): Promise<void> => {
    const directory = await ensureRun(runId);
    await inspectRunEntries(directory);
    const candidate = path.join(directory, EVENTS_NAME);
    try {
      const before = await lstat(candidate, { bigint: true });
      assertPrivateFile(before, candidate, isCurrentUser);
      if (!identitiesMatch(expected, identity(before))) pathUnsafe();
      const handle = await open(
        candidate,
        constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      );
      try {
        const opened = await handle.stat({ bigint: true });
        assertPrivateFile(opened, candidate, isCurrentUser);
        if (!identitiesMatch(expected, identity(opened))) pathUnsafe();
        await handle.writeFile(bytes);
        await options.operationHooks?.beforeJournalSync?.();
        await handle.sync();
        const after = await lstat(candidate, { bigint: true });
        const held = await handle.stat({ bigint: true });
        if (
          !identitiesMatch(expected, identity(after)) ||
          !identitiesMatch(expected, identity(held))
        ) {
          pathUnsafe();
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof RuntimeJournalError) throw error;
      unavailable();
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
    let stageIdentity: FileIdentity | undefined;
    try {
      const quarantine = await open(
        quarantineFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const metadata = await quarantine.stat({ bigint: true });
        assertPrivateFile(metadata, quarantineFile, isCurrentUser);
        await quarantine.writeFile(fragment);
        await quarantine.sync();
      } finally {
        await quarantine.close();
      }
      const quarantineDirectory = await openDirectory(quarantinePath);
      try {
        await syncAndRevalidateDirectory(quarantinePath, quarantineDirectory);
      } finally {
        await quarantineDirectory.handle.close();
      }

      const stage = await open(
        stagePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const metadata = await stage.stat({ bigint: true });
        assertPrivateFile(metadata, stagePath, isCurrentUser);
        stageIdentity = identity(metadata);
        await stage.writeFile(validPrefix);
        await stage.sync();
      } finally {
        await stage.close();
      }
      await options.operationHooks?.beforeRecoveryRename?.();
      const current = await lstat(eventsPath, { bigint: true });
      assertPrivateFile(current, eventsPath, isCurrentUser);
      if (!identitiesMatch(expected, identity(current))) pathUnsafe();
      await rename(stagePath, eventsPath);
      stageIdentity = undefined;
      const runDirectory = await openDirectory(directory);
      try {
        await syncAndRevalidateDirectory(directory, runDirectory);
      } finally {
        await runDirectory.handle.close();
      }
      const restored = await read(runId);
      if (restored === null || !Buffer.from(restored.bytes).equals(validPrefix)) unavailable();
    } catch (error) {
      if (stageIdentity !== undefined) {
        try {
          await unlinkExactPrivateFile(stagePath, stageIdentity, isCurrentUser);
        } catch {
          // Preserve the primary safe failure; later recovery validates the stage.
        }
      }
      if (error instanceof RuntimeJournalError) throw error;
      unavailable();
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
