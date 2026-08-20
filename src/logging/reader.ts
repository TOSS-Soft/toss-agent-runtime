import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";

import { canonicalJson } from "../protocol/json.js";
import { parseOperationalEvent } from "./contracts.js";
import { RuntimeLoggingError } from "./errors.js";
import type { OperationalEventV1, OperationalLogLevel } from "./types.js";

const ACTIVE_NAME = "operational-current.jsonl";
const CLOSED_PATTERN = /^operational-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/u;
const MAX_FILE_BYTES = 104_857_600;
const MAX_LOG_FILES = 10_000;
const LEVEL_RANK: Readonly<Record<OperationalLogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface FileSnapshot extends FileIdentity {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly links: bigint;
}

export interface OperationalLogFilter {
  readonly level?: OperationalLogLevel;
  readonly projectId?: string;
  readonly runId?: string;
}

export interface OperationalLogReadResult {
  readonly events: readonly OperationalEventV1[];
  readonly partialTailBytes: number;
}

export interface CreateOperationalLogReaderOptions {
  readonly logsPath: string;
  readonly pollIntervalMs?: number;
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface OperationalLogReader {
  read(filter: OperationalLogFilter): OperationalLogReadResult;
  follow(
    filter: OperationalLogFilter,
    signal: AbortSignal,
  ): AsyncGenerator<OperationalEventV1, void>;
}

function loggingError(code: ConstructorParameters<typeof RuntimeLoggingError>[0]): never {
  throw new RuntimeLoggingError(code);
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

function identityKey(value: FileIdentity): string {
  return `${value.device}:${value.inode}`;
}

function assertPrivateDirectory(candidate: string): void {
  let metadata: BigIntStats;
  try {
    metadata = lstatSync(candidate, { bigint: true });
  } catch {
    return loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  }
  const uid = currentUid();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (uid !== undefined && metadata.uid !== uid) ||
    Number(metadata.mode & 0o777n) !== 0o700 ||
    realpathSync(candidate) !== candidate
  ) {
    loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  }
}

function snapshot(metadata: BigIntStats): FileSnapshot {
  const uid = currentUid();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (uid !== undefined && metadata.uid !== uid) ||
    Number(metadata.mode & 0o777n) !== 0o600 ||
    metadata.nlink < 1n ||
    metadata.nlink > 2n ||
    metadata.size > BigInt(MAX_FILE_BYTES)
  ) {
    loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  }
  return {
    ...identity(metadata),
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    links: metadata.nlink,
  };
}

function exactSnapshot(
  candidate: string,
  descriptor: number,
  expected: FileSnapshot,
  allowGrowth: boolean,
): void {
  const pathState = snapshot(lstatSync(candidate, { bigint: true }));
  const held = snapshot(fstatSync(descriptor, { bigint: true }));
  if (
    !sameIdentity(pathState, expected) ||
    !sameIdentity(held, expected) ||
    (allowGrowth ? pathState.size < expected.size : pathState.size !== expected.size) ||
    (allowGrowth ? held.size < expected.size : held.size !== expected.size) ||
    (!allowGrowth && pathState.mtimeNs !== expected.mtimeNs) ||
    (!allowGrowth && held.mtimeNs !== expected.mtimeNs) ||
    pathState.links !== expected.links ||
    held.links !== expected.links
  ) {
    loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  }
}

function readExact(
  candidate: string,
  allowGrowth: boolean,
): { readonly bytes: Buffer; readonly state: FileSnapshot } {
  let descriptor: number | undefined;
  try {
    const before = snapshot(lstatSync(candidate, { bigint: true }));
    descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    exactSnapshot(candidate, descriptor, before, allowGrowth);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) loggingError("RUNTIME_LOGGING_DEGRADED");
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(descriptor, extra, 0, 1, bytes.byteLength) !== 0) {
      loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
    }
    exactSnapshot(candidate, descriptor, before, allowGrowth);
    return { bytes, state: before };
  } catch (error) {
    if (error instanceof RuntimeLoggingError) throw error;
    return loggingError("RUNTIME_LOGGING_DEGRADED");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseLines(
  bytes: Buffer,
  allowPartialTail: boolean,
): { readonly events: readonly OperationalEventV1[]; readonly partialTailBytes: number } {
  const newline = bytes.lastIndexOf(0x0a);
  const prefixBytes = newline < 0 ? 0 : newline + 1;
  if (!allowPartialTail && prefixBytes !== bytes.byteLength) {
    loggingError("RUNTIME_LOGGING_CORRUPT");
  }
  const events: OperationalEventV1[] = [];
  let start = 0;
  for (let end = 0; end < prefixBytes; end += 1) {
    if (bytes[end] !== 0x0a) continue;
    const line = bytes.subarray(start, end);
    const parsed = parseOperationalEvent(line);
    if (!parsed.ok || !Buffer.from(canonicalJson(parsed.value), "utf8").equals(line)) {
      loggingError("RUNTIME_LOGGING_CORRUPT");
    }
    events.push(parsed.value);
    start = end + 1;
  }
  return { events, partialTailBytes: bytes.byteLength - prefixBytes };
}

function matches(event: OperationalEventV1, filter: OperationalLogFilter): boolean {
  return (
    (filter.level === undefined || LEVEL_RANK[event.level] >= LEVEL_RANK[filter.level]) &&
    (filter.projectId === undefined || event.project_id === filter.projectId) &&
    (filter.runId === undefined || event.run_id === filter.runId)
  );
}

function validateOrder(events: readonly OperationalEventV1[]): void {
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

function defaultWait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(done, delayMs);
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function renderOperationalEventHuman(event: OperationalEventV1): string {
  const fields = [
    event.timestamp,
    event.level.toUpperCase(),
    event.component,
    event.event,
    `event_id=${event.event_id}`,
    `correlation_id=${event.correlation_id}`,
  ];
  if (event.project_id !== undefined) fields.push(`project_id=${event.project_id}`);
  if (event.job_id !== undefined) fields.push(`job_id=${event.job_id}`);
  if (event.run_id !== undefined) fields.push(`run_id=${event.run_id}`);
  if (Object.keys(event.metadata).length > 0)
    fields.push(`metadata=${canonicalJson(event.metadata)}`);
  return fields.join(" ");
}

export function renderOperationalEventsJson(events: readonly OperationalEventV1[]): string {
  return canonicalJson({ events });
}

export function createOperationalLogReader(
  options: CreateOperationalLogReaderOptions,
): OperationalLogReader {
  const logsPath = path.resolve(options.logsPath);
  if (logsPath !== options.logsPath || logsPath === path.parse(logsPath).root) {
    loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
  }
  const wait = options.wait ?? defaultWait;
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
    loggingError("RUNTIME_LOGGING_INVALID");
  }

  const readOnce = (filter: OperationalLogFilter): OperationalLogReadResult => {
    assertPrivateDirectory(logsPath);
    const names = readdirSync(logsPath);
    if (names.length > MAX_LOG_FILES) loggingError("RUNTIME_LOGGING_CORRUPT");
    const owned = names
      .filter((name) => name === ACTIVE_NAME || CLOSED_PATTERN.test(name))
      .sort((left, right) => {
        if (left === ACTIVE_NAME) return 1;
        if (right === ACTIVE_NAME) return -1;
        return left.localeCompare(right);
      });
    const occurrences = new Map<string, { links: bigint; names: string[] }>();
    const events: OperationalEventV1[] = [];
    const allEvents: OperationalEventV1[] = [];
    const eventIds = new Set<string>();
    let partialTailBytes = 0;
    for (const name of owned) {
      const filePath = path.join(logsPath, name);
      const { bytes, state } = readExact(filePath, name === ACTIVE_NAME);
      const key = identityKey(state);
      const occurrence = occurrences.get(key) ?? { links: state.links, names: [] };
      occurrence.names.push(name);
      occurrences.set(key, occurrence);
      if (occurrence.names.length > 1) continue;
      const parsed = parseLines(bytes, name === ACTIVE_NAME);
      partialTailBytes += parsed.partialTailBytes;
      for (const event of parsed.events) {
        if (eventIds.has(event.event_id)) loggingError("RUNTIME_LOGGING_CORRUPT");
        eventIds.add(event.event_id);
        allEvents.push(event);
        if (matches(event, filter)) events.push(event);
      }
    }
    for (const occurrence of occurrences.values()) {
      if (
        (occurrence.links === 1n && occurrence.names.length !== 1) ||
        (occurrence.links === 2n &&
          (occurrence.names.length !== 2 || !occurrence.names.includes(ACTIVE_NAME)))
      ) {
        loggingError("RUNTIME_LOGGING_PATH_UNSAFE");
      }
    }
    validateOrder(allEvents);
    return { events: Object.freeze(events), partialTailBytes };
  };

  const read = (filter: OperationalLogFilter): OperationalLogReadResult => {
    let lastError: RuntimeLoggingError | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return readOnce(filter);
      } catch (error) {
        if (
          !(error instanceof RuntimeLoggingError) ||
          (error.code !== "RUNTIME_LOGGING_PATH_UNSAFE" &&
            error.code !== "RUNTIME_LOGGING_DEGRADED")
        ) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError ?? new RuntimeLoggingError("RUNTIME_LOGGING_DEGRADED");
  };

  return {
    read,
    async *follow(filter, signal) {
      const seen = new Set<string>();
      while (!signal.aborted) {
        const result = read(filter);
        for (const event of result.events) {
          if (seen.has(event.event_id)) continue;
          seen.add(event.event_id);
          yield event;
          if (signal.aborted) return;
        }
        await wait(pollIntervalMs, signal);
      }
    },
  };
}
