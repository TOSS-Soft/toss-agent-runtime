import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";

import { canonicalJson } from "../protocol/json.js";
import { createOperationalEvent, parseOperationalEvent } from "./contracts.js";
import { RuntimeLoggingError } from "./errors.js";
import type { OperationalEventInput, OperationalEventV1 } from "./types.js";

const ACTIVE_NAME = "operational-current.jsonl";
const CLOSED_PATTERN = /^operational-(\d{4}-\d{2}-\d{2})-(\d{6})\.jsonl$/u;
const DEFAULT_MAX_BYTES = 104_857_600;
const DEFAULT_RETENTION_DAYS = 7;
const MAX_EVENT_BYTES = 65_536;
const MAX_LOG_FILES = 10_000;

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface FileSnapshot {
  readonly identity: FileIdentity;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly links: bigint;
}

interface ActiveState extends FileSnapshot {
  readonly serviceInstanceId: string | null;
  readonly day: string | null;
  readonly lastSequence: number;
  readonly recoveredEvents: readonly OperationalEventV1[];
}

interface ClosedLog {
  readonly name: string;
  readonly path: string;
  readonly day: string;
  readonly fileSequence: number;
  readonly snapshot: FileSnapshot;
  readonly events: readonly OperationalEventV1[];
}

interface Coordinator {
  tail: Promise<unknown>;
  degraded: boolean;
  initialized: boolean;
  serviceInstanceId?: string;
  state?: ActiveState;
  pendingPartialBytes: number;
}

export interface OperationalLogOperationHooks {
  readonly beforeFileSync?: (filePath: string) => void;
  readonly beforeDirectorySync?: (directoryPath: string) => void;
  readonly beforeRotate?: (activePath: string, closedPath: string) => void;
  readonly afterClosedLink?: (activePath: string, closedPath: string) => void;
  readonly afterRotationDirectorySync?: (activePath: string, closedPath: string) => void;
  readonly beforeRetentionUnlink?: (closedPath: string) => void;
}

export interface CreateOperationalLogStoreOptions {
  readonly logsPath: string;
  readonly serviceInstanceId: string;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly maxBytes?: number;
  readonly retentionMaxBytes?: number;
  readonly retentionDays?: number;
  readonly operationHooks?: OperationalLogOperationHooks;
}

export interface OperationalLogStore {
  recover(): Promise<void>;
  write(input: OperationalEventInput): Promise<OperationalEventV1>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
  isDegraded(): boolean;
}

const coordinators = new Map<string, WeakRef<Coordinator>>();

function loggingError(code: ConstructorParameters<typeof RuntimeLoggingError>[0]): never {
  throw new RuntimeLoggingError(code);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function currentUid(): bigint | undefined {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
}

function identity(metadata: Pick<BigIntStats, "dev" | "ino">): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertAbsolutePath(candidate: string): void {
  if (
    !path.isAbsolute(candidate) ||
    candidate === path.parse(candidate).root ||
    path.normalize(candidate) !== candidate ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  }
}

function directoryCandidates(candidate: string): readonly string[] {
  assertAbsolutePath(candidate);
  const parsed = path.parse(candidate);
  const segments = candidate.slice(parsed.root.length).split(path.sep);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  }
  const candidates = [parsed.root];
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    candidates.push(current);
  }
  return candidates;
}

function isSafeRootAncestor(metadata: BigIntStats): boolean {
  if (metadata.uid !== 0n) return false;
  const writable = Number(metadata.mode & 0o022n) !== 0;
  return !writable || Number(metadata.mode & 0o1000n) !== 0;
}

function assertDirectory(metadata: BigIntStats, final: boolean): FileIdentity {
  const uid = currentUid();
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  }
  if (final) {
    if ((uid !== undefined && metadata.uid !== uid) || Number(metadata.mode & 0o777n) !== 0o700) {
      loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
    }
  } else if (uid === undefined) {
    if (Number(metadata.mode & 0o022n) !== 0) loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  } else if (metadata.uid === uid) {
    if (Number(metadata.mode & 0o022n) !== 0 && !isSafeRootAncestor(metadata)) {
      loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
    }
  } else if (!isSafeRootAncestor(metadata)) {
    loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  }
  return identity(metadata);
}

function openDirectory(candidate: string): number {
  try {
    return openSync(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  }
}

function syncDirectory(
  candidate: string,
  beforeSync: ((directoryPath: string) => void) | undefined,
): void {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(candidate, { bigint: true });
    const expected = assertDirectory(before, true);
    descriptor = openDirectory(candidate);
    const held = fstatSync(descriptor, { bigint: true });
    assertDirectory(held, true);
    if (!sameIdentity(expected, identity(held))) loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
    beforeSync?.(candidate);
    fsyncSync(descriptor);
    const after = lstatSync(candidate, { bigint: true });
    assertDirectory(after, true);
    if (!sameIdentity(expected, identity(after))) loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  } catch (error) {
    if (error instanceof RuntimeLoggingError) throw error;
    return loggingError("RUNTIME_LOGGING_DEGRADED");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensurePrivateDirectory(
  candidate: string,
  beforeSync: ((directoryPath: string) => void) | undefined,
): void {
  const candidates = directoryCandidates(candidate);
  for (const [index, current] of candidates.entries()) {
    const final = index === candidates.length - 1;
    let metadata: BigIntStats;
    let created = false;
    try {
      metadata = lstatSync(current, { bigint: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || index === 0) {
        loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      }
      try {
        mkdirSync(current, { mode: 0o700 });
        created = true;
        metadata = lstatSync(current, { bigint: true });
      } catch {
        return loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      }
    }
    assertDirectory(metadata, final);
    if (created) {
      const parent = path.dirname(current);
      let parentDescriptor: number | undefined;
      try {
        const parentBefore = lstatSync(parent, { bigint: true });
        const parentIdentity = assertDirectory(parentBefore, false);
        parentDescriptor = openDirectory(parent);
        const held = fstatSync(parentDescriptor, { bigint: true });
        if (!sameIdentity(parentIdentity, identity(held))) {
          loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
        }
        beforeSync?.(parent);
        fsyncSync(parentDescriptor);
        const parentAfter = lstatSync(parent, { bigint: true });
        if (!sameIdentity(parentIdentity, identity(parentAfter))) {
          loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
        }
      } catch (error) {
        if (error instanceof RuntimeLoggingError) throw error;
        loggingError("RUNTIME_LOGGING_DEGRADED");
      } finally {
        if (parentDescriptor !== undefined) closeSync(parentDescriptor);
      }
    }
  }
  syncDirectory(candidate, beforeSync);
}

function assertPrivateFile(metadata: BigIntStats, expected?: FileIdentity): FileSnapshot {
  const actual = identity(metadata);
  const uid = currentUid();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (uid !== undefined && metadata.uid !== uid) ||
    Number(metadata.mode & 0o777n) !== 0o600 ||
    (expected !== undefined && !sameIdentity(expected, actual))
  ) {
    loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  }
  return {
    identity: actual,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    links: metadata.nlink,
  };
}

function exactFile(candidate: string, descriptor: number, expected: FileSnapshot): FileSnapshot {
  const pathState = assertPrivateFile(lstatSync(candidate, { bigint: true }), expected.identity);
  const held = assertPrivateFile(fstatSync(descriptor, { bigint: true }), expected.identity);
  if (
    pathState.size !== expected.size ||
    held.size !== expected.size ||
    pathState.mtimeNs !== expected.mtimeNs ||
    held.mtimeNs !== expected.mtimeNs ||
    pathState.links !== expected.links ||
    held.links !== expected.links
  ) {
    loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  }
  return held;
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = writeSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
    if (written === 0) loggingError("RUNTIME_LOGGING_DEGRADED");
    offset += written;
  }
}

function readTail(descriptor: number, offset: bigint, length: number): Buffer {
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) loggingError("RUNTIME_LOGGING_CORRUPT");
  const result = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(descriptor, result, read, length - read, Number(offset) + read);
    if (count === 0) loggingError("RUNTIME_LOGGING_DEGRADED");
    read += count;
  }
  return result;
}

function readExactFile(
  candidate: string,
  maximumBytes: number,
): {
  readonly bytes: Buffer;
  readonly snapshot: FileSnapshot;
} {
  let descriptor: number | undefined;
  try {
    const before = assertPrivateFile(lstatSync(candidate, { bigint: true }));
    descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const held = assertPrivateFile(fstatSync(descriptor, { bigint: true }), before.identity);
    if (held.size > BigInt(maximumBytes) || held.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      loggingError("RUNTIME_LOGGING_CORRUPT");
    }
    const bytes = readTail(descriptor, 0n, Number(held.size));
    const extra = Buffer.alloc(1);
    if (readSync(descriptor, extra, 0, 1, Number(held.size)) !== 0) {
      loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
    }
    exactFile(candidate, descriptor, held);
    return { bytes, snapshot: held };
  } catch (error) {
    if (error instanceof RuntimeLoggingError) throw error;
    return loggingError("RUNTIME_LOGGING_DEGRADED");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function canonicalDay(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function parseLogBytes(
  bytes: Buffer,
  allowPartialTail: boolean,
): { readonly events: readonly OperationalEventV1[]; readonly prefixBytes: number } {
  const lastNewline = bytes.lastIndexOf(0x0a);
  const prefixBytes = lastNewline < 0 ? 0 : lastNewline + 1;
  if (!allowPartialTail && prefixBytes !== bytes.byteLength)
    loggingError("RUNTIME_LOGGING_CORRUPT");
  if (prefixBytes === 0 && bytes.byteLength > 0 && !allowPartialTail) {
    loggingError("RUNTIME_LOGGING_CORRUPT");
  }
  const events: OperationalEventV1[] = [];
  const ids = new Set<string>();
  let priorService: string | undefined;
  let priorSequence = 0;
  let start = 0;
  for (let end = 0; end < prefixBytes; end += 1) {
    if (bytes[end] !== 0x0a) continue;
    const line = bytes.subarray(start, end);
    const parsed = parseOperationalEvent(line);
    if (!parsed.ok || !Buffer.from(canonicalJson(parsed.value), "utf8").equals(line)) {
      loggingError("RUNTIME_LOGGING_CORRUPT");
    }
    if (ids.has(parsed.value.event_id)) loggingError("RUNTIME_LOGGING_CORRUPT");
    ids.add(parsed.value.event_id);
    if (priorService === parsed.value.service_instance_id) {
      if (parsed.value.service_sequence !== priorSequence + 1) {
        loggingError("RUNTIME_LOGGING_CORRUPT");
      }
    } else if (priorService !== undefined) {
      priorService = parsed.value.service_instance_id;
      if (parsed.value.service_sequence !== 1) loggingError("RUNTIME_LOGGING_CORRUPT");
    } else {
      priorService = parsed.value.service_instance_id;
    }
    priorSequence = parsed.value.service_sequence;
    events.push(parsed.value);
    start = end + 1;
  }
  return { events: Object.freeze(events), prefixBytes };
}

function validateEventOrder(events: readonly OperationalEventV1[]): void {
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.event_id)) loggingError("RUNTIME_LOGGING_CORRUPT");
    ids.add(event.event_id);
  }
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1]!;
    const current = events[index]!;
    if (
      Date.parse(current.timestamp) < Date.parse(previous.timestamp) ||
      (current.service_instance_id === previous.service_instance_id &&
        current.service_sequence !== previous.service_sequence + 1) ||
      (current.service_instance_id !== previous.service_instance_id &&
        current.service_sequence !== 1)
    ) {
      loggingError("RUNTIME_LOGGING_CORRUPT");
    }
  }
}

export function createOperationalLogStore(
  options: CreateOperationalLogStoreOptions,
): OperationalLogStore {
  const requestedLogsPath = path.resolve(options.logsPath);
  if (requestedLogsPath !== options.logsPath) loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  const activePath = path.join(requestedLogsPath, ACTIVE_NAME);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const retentionMaxBytes = options.retentionMaxBytes ?? DEFAULT_MAX_BYTES;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < MAX_EVENT_BYTES ||
    maxBytes > DEFAULT_MAX_BYTES ||
    !Number.isSafeInteger(retentionMaxBytes) ||
    retentionMaxBytes < MAX_EVENT_BYTES ||
    retentionMaxBytes > DEFAULT_MAX_BYTES ||
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > DEFAULT_RETENTION_DAYS
  ) {
    loggingError("RUNTIME_LOGGING_INVALID");
  }
  let stopped = false;
  let coordinatorPromise: Promise<Coordinator> | undefined;
  let sharedCoordinator: Coordinator | undefined;
  const pending = new Set<Promise<unknown>>();

  const coordinator = (): Promise<Coordinator> => {
    if (coordinatorPromise === undefined) {
      coordinatorPromise = Promise.resolve()
        .then(() => {
          ensurePrivateDirectory(requestedLogsPath, options.operationHooks?.beforeDirectorySync);
          const canonical = realpathSync(requestedLogsPath);
          if (canonical !== requestedLogsPath) loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
          let shared = coordinators.get(canonical)?.deref();
          if (shared === undefined) {
            shared = {
              tail: Promise.resolve(),
              degraded: false,
              initialized: false,
              pendingPartialBytes: 0,
            };
            coordinators.set(canonical, new WeakRef(shared));
          }
          if (
            shared.serviceInstanceId !== undefined &&
            shared.serviceInstanceId !== options.serviceInstanceId
          ) {
            loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
          }
          shared.serviceInstanceId = options.serviceInstanceId;
          return shared;
        })
        .catch((error: unknown) => {
          coordinatorPromise = undefined;
          throw error;
        });
    }
    return coordinatorPromise;
  };

  const enqueue = <T>(operation: (shared: Coordinator) => Promise<T> | T): Promise<T> => {
    const scheduled = coordinator().then(async (shared) => {
      const current = shared.tail
        .catch(() => undefined)
        .then(() => {
          sharedCoordinator = shared;
          return operation(shared);
        });
      shared.tail = current;
      return current;
    });
    pending.add(scheduled);
    void scheduled.finally(() => pending.delete(scheduled)).catch(() => undefined);
    return scheduled;
  };

  const readClosedLogs = (): ClosedLog[] => {
    const names = readdirSync(requestedLogsPath);
    if (names.length > MAX_LOG_FILES) loggingError("RUNTIME_LOGGING_CORRUPT");
    const closed: ClosedLog[] = [];
    for (const name of names.sort()) {
      const match = CLOSED_PATTERN.exec(name);
      if (match === null) continue;
      const filePath = path.join(requestedLogsPath, name);
      const metadata = lstatSync(filePath, { bigint: true });
      const initial = assertPrivateFile(metadata);
      if (metadata.nlink !== 1n || initial.size > BigInt(maxBytes)) {
        loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      }
      const { bytes, snapshot } = readExactFile(filePath, maxBytes);
      if (!sameIdentity(initial.identity, snapshot.identity)) {
        loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      }
      if (initial.links !== snapshot.links) loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      const parsed = parseLogBytes(bytes, false);
      validateEventOrder(parsed.events);
      closed.push({
        name,
        path: filePath,
        day: match[1]!,
        fileSequence: Number(match[2]),
        snapshot,
        events: parsed.events,
      });
    }
    return closed;
  };

  const recoverInterruptedRotation = (): void => {
    const names = readdirSync(requestedLogsPath);
    const linkedClosed = names.filter((name) => {
      if (!CLOSED_PATTERN.test(name)) return false;
      const metadata = lstatSync(path.join(requestedLogsPath, name), { bigint: true });
      return metadata.nlink === 2n;
    });
    let activeMetadata: BigIntStats | undefined;
    try {
      activeMetadata = lstatSync(activePath, { bigint: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (linkedClosed.length === 0) {
      if (activeMetadata !== undefined && activeMetadata.nlink !== 1n) {
        loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      }
      return;
    }
    if (linkedClosed.length !== 1 || activeMetadata === undefined || activeMetadata.nlink !== 2n) {
      loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
    }
    const closedPath = path.join(requestedLogsPath, linkedClosed[0]!);
    const activeSnapshot = assertPrivateFile(activeMetadata);
    const closedSnapshot = assertPrivateFile(lstatSync(closedPath, { bigint: true }));
    if (
      !sameIdentity(activeSnapshot.identity, closedSnapshot.identity) ||
      activeSnapshot.size !== closedSnapshot.size ||
      activeSnapshot.mtimeNs !== closedSnapshot.mtimeNs
    ) {
      loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
    }
    const { snapshot } = readExactFile(closedPath, maxBytes);
    if (!sameIdentity(snapshot.identity, activeSnapshot.identity)) {
      loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
    }
    syncDirectory(requestedLogsPath, options.operationHooks?.beforeDirectorySync);
    const activeAgain = lstatSync(activePath, { bigint: true });
    assertPrivateFile(activeAgain, activeSnapshot.identity);
    const closedAgain = lstatSync(closedPath, { bigint: true });
    assertPrivateFile(closedAgain, closedSnapshot.identity);
    if (activeAgain.nlink !== 2n || closedAgain.nlink !== 2n) {
      loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
    }
    unlinkSync(activePath);
    syncDirectory(requestedLogsPath, options.operationHooks?.beforeDirectorySync);
    const finalClosed = lstatSync(closedPath, { bigint: true });
    assertPrivateFile(finalClosed, closedSnapshot.identity);
    if (finalClosed.nlink !== 1n) loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  };

  const loadActive = (shared: Coordinator): ActiveState => {
    let descriptor: number | undefined;
    try {
      const metadata = lstatSync(activePath, { bigint: true });
      const snapshot = assertPrivateFile(metadata);
      if (metadata.nlink !== 1n || snapshot.size > BigInt(maxBytes)) {
        loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      }
      descriptor = openSync(activePath, constants.O_RDWR | constants.O_NOFOLLOW);
      exactFile(activePath, descriptor, snapshot);
      const bytes = readFileSync(descriptor);
      if (BigInt(bytes.byteLength) !== snapshot.size) loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      const parsed = parseLogBytes(bytes, true);
      if (parsed.prefixBytes !== bytes.byteLength) {
        const partialBytes = bytes.byteLength - parsed.prefixBytes;
        ftruncateSync(descriptor, parsed.prefixBytes);
        options.operationHooks?.beforeFileSync?.(activePath);
        fsyncSync(descriptor);
        syncDirectory(requestedLogsPath, options.operationHooks?.beforeDirectorySync);
        shared.pendingPartialBytes += partialBytes;
      } else {
        options.operationHooks?.beforeFileSync?.(activePath);
        fsyncSync(descriptor);
        syncDirectory(requestedLogsPath, options.operationHooks?.beforeDirectorySync);
      }
      validateEventOrder(parsed.events);
      const last = parsed.events.at(-1);
      const current = assertPrivateFile(fstatSync(descriptor, { bigint: true }), snapshot.identity);
      const pathCurrent = assertPrivateFile(
        lstatSync(activePath, { bigint: true }),
        snapshot.identity,
      );
      if (
        current.size !== BigInt(parsed.prefixBytes) ||
        pathCurrent.size !== current.size ||
        pathCurrent.mtimeNs !== current.mtimeNs
      ) {
        loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      }
      return {
        ...current,
        serviceInstanceId: last?.service_instance_id ?? null,
        day: last === undefined ? null : canonicalDay(last.timestamp),
        lastSequence: last?.service_sequence ?? 0,
        recoveredEvents: parsed.events,
      };
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return {
          identity: { device: 0n, inode: 0n },
          size: 0n,
          mtimeNs: 0n,
          links: 0n,
          serviceInstanceId: null,
          day: null,
          lastSequence: 0,
          recoveredEvents: [],
        };
      }
      if (error instanceof RuntimeLoggingError) throw error;
      loggingError("RUNTIME_LOGGING_DEGRADED");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };

  const closedName = (day: string, closed: readonly ClosedLog[]): string => {
    const next =
      Math.max(
        0,
        ...closed.filter((entry) => entry.day === day).map((entry) => entry.fileSequence),
      ) + 1;
    if (next > 999_999) loggingError("RUNTIME_LOGGING_DEGRADED");
    return `operational-${day}-${String(next).padStart(6, "0")}.jsonl`;
  };

  const rotate = (shared: Coordinator, closed: ClosedLog[], preserveSequence = true): void => {
    const state = shared.state;
    if (state === undefined || state.size === 0n || state.day === null) return;
    const targetPath = path.join(requestedLogsPath, closedName(state.day, closed));
    try {
      const activeMetadata = lstatSync(activePath, { bigint: true });
      assertPrivateFile(activeMetadata, state.identity);
      if (activeMetadata.nlink !== 1n) loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      options.operationHooks?.beforeRotate?.(activePath, targetPath);
      linkSync(activePath, targetPath);
      const targetMetadata = lstatSync(targetPath, { bigint: true });
      assertPrivateFile(targetMetadata, state.identity);
      if (targetMetadata.nlink !== 2n) loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      options.operationHooks?.afterClosedLink?.(activePath, targetPath);
      syncDirectory(requestedLogsPath, options.operationHooks?.beforeDirectorySync);
      options.operationHooks?.afterRotationDirectorySync?.(activePath, targetPath);
      const activeAgain = lstatSync(activePath, { bigint: true });
      assertPrivateFile(activeAgain, state.identity);
      const targetAgain = lstatSync(targetPath, { bigint: true });
      assertPrivateFile(targetAgain, state.identity);
      if (activeAgain.nlink !== 2n || targetAgain.nlink !== 2n) {
        loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      }
      unlinkSync(activePath);
      syncDirectory(requestedLogsPath, options.operationHooks?.beforeDirectorySync);
      try {
        lstatSync(activePath, { bigint: true });
        loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      const closedMetadata = lstatSync(targetPath, { bigint: true });
      assertPrivateFile(closedMetadata, state.identity);
      if (closedMetadata.nlink !== 1n) loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      shared.state = {
        identity: { device: 0n, inode: 0n },
        size: 0n,
        mtimeNs: 0n,
        links: 0n,
        serviceInstanceId: options.serviceInstanceId,
        day: null,
        lastSequence: preserveSequence ? state.lastSequence : 0,
        recoveredEvents: [],
      };
    } catch (error) {
      if (error instanceof RuntimeLoggingError) throw error;
      loggingError("RUNTIME_LOGGING_DEGRADED");
    }
  };

  const applyRetention = (closed: readonly ClosedLog[]): void => {
    const now = options.now();
    if (Number.isNaN(now.getTime())) loggingError("RUNTIME_LOGGING_INVALID");
    const newest = [...closed].sort((left, right) => right.name.localeCompare(left.name));
    let retainedBytes = 0n;
    for (const entry of newest) {
      const lastTimestamp = entry.events.at(-1)?.timestamp;
      const ageMs =
        lastTimestamp === undefined
          ? Number.POSITIVE_INFINITY
          : now.getTime() - Date.parse(lastTimestamp);
      const expired = ageMs > retentionDays * 86_400_000;
      const overBudget = retainedBytes + entry.snapshot.size > BigInt(retentionMaxBytes);
      if (!expired && !overBudget) {
        retainedBytes += entry.snapshot.size;
        continue;
      }
      let descriptor: number | undefined;
      try {
        descriptor = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        exactFile(entry.path, descriptor, entry.snapshot);
        options.operationHooks?.beforeRetentionUnlink?.(entry.path);
        exactFile(entry.path, descriptor, entry.snapshot);
        unlinkSync(entry.path);
        syncDirectory(requestedLogsPath, options.operationHooks?.beforeDirectorySync);
      } catch (error) {
        if (error instanceof RuntimeLoggingError) throw error;
        loggingError("RUNTIME_LOGGING_DEGRADED");
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
  };

  const createActive = (shared: Coordinator): ActiveState => {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        activePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      const snapshot = assertPrivateFile(fstatSync(descriptor, { bigint: true }));
      options.operationHooks?.beforeFileSync?.(activePath);
      fsyncSync(descriptor);
      syncDirectory(requestedLogsPath, options.operationHooks?.beforeDirectorySync);
      const exact = assertPrivateFile(lstatSync(activePath, { bigint: true }), snapshot.identity);
      return {
        ...exact,
        serviceInstanceId: options.serviceInstanceId,
        day: null,
        lastSequence: shared.state?.lastSequence ?? 0,
        recoveredEvents: [],
      };
    } catch (error) {
      if (error instanceof RuntimeLoggingError) throw error;
      loggingError("RUNTIME_LOGGING_DEGRADED");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };

  const append = (shared: Coordinator, input: OperationalEventInput): OperationalEventV1 => {
    if (shared.degraded) loggingError("RUNTIME_LOGGING_DEGRADED");
    let state = shared.state ?? loadActive(shared);
    const timestamp = options.now();
    if (Number.isNaN(timestamp.getTime())) loggingError("RUNTIME_LOGGING_INVALID");
    const event = createOperationalEvent({
      eventId: options.randomId(),
      timestamp,
      serviceInstanceId: options.serviceInstanceId,
      serviceSequence: state.lastSequence + 1,
      input,
    });
    const line = Buffer.from(`${canonicalJson(event)}\n`, "utf8");
    if (line.byteLength > MAX_EVENT_BYTES || line.byteLength > maxBytes) {
      loggingError("RUNTIME_LOGGING_INVALID");
    }
    const eventDay = canonicalDay(event.timestamp);
    if (
      state.size > 0n &&
      (state.day !== eventDay || state.size + BigInt(line.byteLength) > BigInt(maxBytes))
    ) {
      const closed = readClosedLogs();
      rotate(shared, closed);
      applyRetention(readClosedLogs());
      state = shared.state!;
    }
    if (state.size === 0n && state.identity.inode === 0n) {
      state = createActive(shared);
      shared.state = state;
    }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        activePath,
        constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW,
      );
      exactFile(activePath, descriptor, state);
      writeAll(descriptor, line);
      options.operationHooks?.beforeFileSync?.(activePath);
      fsyncSync(descriptor);
      const after = assertPrivateFile(fstatSync(descriptor, { bigint: true }), state.identity);
      if (after.size !== state.size + BigInt(line.byteLength)) {
        loggingError("RUNTIME_LOGGING_DEGRADED");
      }
      if (!readTail(descriptor, state.size, line.byteLength).equals(line)) {
        loggingError("RUNTIME_LOGGING_DEGRADED");
      }
      const pathAfter = assertPrivateFile(lstatSync(activePath, { bigint: true }), state.identity);
      if (pathAfter.size !== after.size || pathAfter.mtimeNs !== after.mtimeNs) {
        loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      }
      shared.state = {
        ...after,
        serviceInstanceId: options.serviceInstanceId,
        day: eventDay,
        lastSequence: event.service_sequence,
        recoveredEvents: [],
      };
      return event;
    } catch (error) {
      shared.degraded = true;
      if (error instanceof RuntimeLoggingError) throw error;
      loggingError("RUNTIME_LOGGING_DEGRADED");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };

  const recover = (shared: Coordinator): void => {
    recoverInterruptedRotation();
    const closed = readClosedLogs();
    const events = closed.flatMap((entry) => entry.events);
    validateEventOrder(events);
    shared.state = loadActive(shared);
    validateEventOrder([...events, ...shared.state.recoveredEvents]);
    if (
      shared.state.size > 0n &&
      shared.state.serviceInstanceId !== null &&
      shared.state.serviceInstanceId !== options.serviceInstanceId
    ) {
      rotate(shared, closed, false);
    }
    applyRetention(readClosedLogs());
    shared.degraded = false;
    shared.initialized = true;
    const partialBytes = shared.pendingPartialBytes;
    shared.pendingPartialBytes = 0;
    if (partialBytes > 0) {
      append(shared, {
        level: "warn",
        component: "logger",
        event: "logging.partial-tail-recovered",
        correlationId: options.randomId(),
        metadata: { recovered_bytes: partialBytes },
        allowedMetadataKeys: ["recovered_bytes"],
      });
    }
  };

  const ensureRecovered = (shared: Coordinator): void => {
    if (!shared.initialized) recover(shared);
  };

  return {
    recover: () =>
      enqueue((shared) => {
        try {
          recover(shared);
        } catch (error) {
          if ((error as Partial<RuntimeLoggingError>).code !== "RUNTIME_LOGGING_CORRUPT") {
            shared.degraded = true;
          }
          throw error;
        }
      }),
    write(input) {
      if (stopped) return Promise.reject(new RuntimeLoggingError("RUNTIME_LOGGING_DEGRADED"));
      return enqueue((shared) => {
        try {
          ensureRecovered(shared);
          return append(shared, input);
        } catch (error) {
          if ((error as Partial<RuntimeLoggingError>).code === "RUNTIME_LOGGING_DEGRADED") {
            shared.degraded = true;
          }
          throw error;
        }
      });
    },
    stopIntake() {
      stopped = true;
    },
    flush(signal) {
      return enqueue((shared) => {
        if (signal.aborted || shared.degraded) loggingError("RUNTIME_LOGGING_DEGRADED");
        ensureRecovered(shared);
        if (shared.state === undefined || shared.state.size === 0n) return;
        let descriptor: number | undefined;
        try {
          descriptor = openSync(activePath, constants.O_RDWR | constants.O_NOFOLLOW);
          exactFile(activePath, descriptor, shared.state);
          options.operationHooks?.beforeFileSync?.(activePath);
          fsyncSync(descriptor);
          syncDirectory(requestedLogsPath, options.operationHooks?.beforeDirectorySync);
          exactFile(activePath, descriptor, shared.state);
        } catch (error) {
          shared.degraded = true;
          if (error instanceof RuntimeLoggingError) throw error;
          loggingError("RUNTIME_LOGGING_DEGRADED");
        } finally {
          if (descriptor !== undefined) closeSync(descriptor);
        }
      });
    },
    isDegraded: () => sharedCoordinator?.degraded ?? false,
  };
}
