import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../../protocol/json.js";
import {
  hashProjectRegistryEntry,
  hashProjectWatchManifest,
  parseProjectRegistryEntry,
  parseProjectWatchManifest,
} from "./contracts.js";
import { RuntimeProjectError } from "./errors.js";
import {
  canonicalProjectRoot,
  createPrivateRegistryFiles,
  type PrivateFileSnapshot,
} from "./private-files.js";
import type {
  ProjectRegistration,
  ProjectRegistryEntryV1,
  ProjectRegistryState,
  ProjectWatchManifestV1,
} from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;
const MAX_MANIFEST_BYTES = 65_536;

export interface CreateProjectRegistryOptions {
  readonly statePath: string;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly operationHooks?: {
    readonly beforeManifestRead?: (canonicalRoot: string) => void;
  };
}

export interface ProjectRegistry {
  recover(): Promise<void>;
  register(root: string): Promise<ProjectRegistration>;
  unregister(projectId: string): Promise<ProjectRegistration>;
  blockUnavailable(projectId: string): Promise<ProjectRegistration>;
  list(): Promise<readonly ProjectRegistration[]>;
  get(projectId: string): Promise<ProjectRegistration | null>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}

interface RegistryHistory {
  readonly file: PrivateFileSnapshot | null;
  readonly entries: readonly ProjectRegistryEntryV1[];
  readonly active: ReadonlyMap<string, ProjectRegistration>;
  readonly rootIds: ReadonlyMap<string, string>;
}

interface ProjectBinding {
  readonly canonicalRoot: string;
  readonly manifest: ProjectWatchManifestV1;
  readonly manifestHash: `sha256:${string}`;
}

interface Coordinator {
  tail: Promise<unknown>;
}

const coordinators = new Map<string, WeakRef<Coordinator>>();

function projectError(code: ConstructorParameters<typeof RuntimeProjectError>[0]): never {
  throw new RuntimeProjectError(code);
}

function currentUid(): bigint | undefined {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
}

function registration(entry: ProjectRegistryEntryV1): ProjectRegistration {
  return Object.freeze({
    project_id: entry.project_id,
    registry_revision: entry.registry_revision,
    canonical_root: entry.canonical_root,
    manifest_hash: entry.manifest_hash,
    state: entry.state,
  });
}

function assertManifestFile(candidate: string): ProjectBinding {
  const canonicalRoot = path.dirname(path.dirname(candidate));
  let descriptor: number | undefined;
  try {
    const tossDirectory = path.dirname(candidate);
    const tossMetadata = lstatSync(tossDirectory, { bigint: true });
    const uid = currentUid();
    if (
      tossMetadata.isSymbolicLink() ||
      !tossMetadata.isDirectory() ||
      (uid !== undefined && tossMetadata.uid !== uid)
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    const before = lstatSync(candidate, { bigint: true });
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      (uid !== undefined && before.uid !== uid) ||
      Number(before.mode & 0o400n) === 0 ||
      Number(before.mode & 0o022n) !== 0
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const held = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== held.dev ||
      before.ino !== held.ino ||
      held.size > BigInt(MAX_MANIFEST_BYTES)
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    const bytes = readFileSync(descriptor);
    const after = lstatSync(candidate, { bigint: true });
    const heldAfter = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.dev !== heldAfter.dev ||
      before.ino !== heldAfter.ino ||
      before.size !== BigInt(bytes.byteLength) ||
      after.size !== BigInt(bytes.byteLength)
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    const parsed = parseProjectWatchManifest(bytes);
    if (!parsed.ok) projectError("RUNTIME_PROJECT_INVALID");
    return {
      canonicalRoot,
      manifest: parsed.value,
      manifestHash: hashProjectWatchManifest(parsed.value),
    };
  } catch (error) {
    if (error instanceof RuntimeProjectError) throw error;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      projectError("RUNTIME_PROJECT_INVALID");
    }
    return projectError("RUNTIME_PROJECT_PATH_UNSAFE");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function bindProject(
  root: string,
  beforeManifestRead?: (canonicalRoot: string) => void,
): ProjectBinding {
  const canonicalRoot = canonicalProjectRoot(root);
  let rootDescriptor: number | undefined;
  try {
    rootDescriptor = openSync(
      canonicalRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const openedRoot = fstatSync(rootDescriptor, { bigint: true });
    beforeManifestRead?.(canonicalRoot);
    const manifestPath = path.join(canonicalRoot, ".toss", "project.yaml");
    const binding = assertManifestFile(manifestPath);
    const currentRoot = canonicalProjectRoot(root);
    const currentMetadata = lstatSync(canonicalRoot, { bigint: true });
    const heldRoot = fstatSync(rootDescriptor, { bigint: true });
    if (
      currentRoot !== canonicalRoot ||
      binding.canonicalRoot !== canonicalRoot ||
      currentMetadata.dev !== openedRoot.dev ||
      currentMetadata.ino !== openedRoot.ino ||
      heldRoot.dev !== openedRoot.dev ||
      heldRoot.ino !== openedRoot.ino
    ) {
      projectError("RUNTIME_PROJECT_PATH_UNSAFE");
    }
    return binding;
  } catch (error) {
    if (error instanceof RuntimeProjectError) throw error;
    return projectError("RUNTIME_PROJECT_PATH_UNSAFE");
  } finally {
    if (rootDescriptor !== undefined) closeSync(rootDescriptor);
  }
}

export function loadRegisteredProjectManifest(
  registration: ProjectRegistration,
): ProjectWatchManifestV1 {
  if (registration.state !== "ACTIVE") projectError("RUNTIME_PROJECT_UNAVAILABLE");
  const binding = bindProject(registration.canonical_root);
  if (
    binding.canonicalRoot !== registration.canonical_root ||
    binding.manifestHash !== registration.manifest_hash
  ) {
    projectError("RUNTIME_PROJECT_UNAVAILABLE");
  }
  return binding.manifest;
}

function parseHistoryBytes(bytes: Uint8Array): {
  readonly entries: readonly ProjectRegistryEntryV1[];
  readonly prefixLength: number;
  readonly fragment: Uint8Array;
} {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength === 0) projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
  const finalNewline = buffer.lastIndexOf(0x0a);
  const prefixLength = finalNewline < 0 ? 0 : finalNewline + 1;
  const entries: ProjectRegistryEntryV1[] = [];
  let start = 0;
  for (let end = 0; end < prefixLength; end += 1) {
    if (buffer[end] !== 0x0a) continue;
    const line = buffer.subarray(start, end);
    const parsed = parseProjectRegistryEntry(line);
    if (!parsed.ok || !Buffer.from(canonicalJson(parsed.value), "utf8").equals(line)) {
      projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    entries.push(parsed.value);
    start = end + 1;
  }
  return {
    entries: Object.freeze(entries),
    prefixLength,
    fragment: Buffer.from(buffer.subarray(prefixLength)),
  };
}

function validateHistory(entries: readonly ProjectRegistryEntryV1[]): {
  readonly active: ReadonlyMap<string, ProjectRegistration>;
  readonly rootIds: ReadonlyMap<string, string>;
} {
  const active = new Map<string, ProjectRegistration>();
  const rootIds = new Map<string, string>();
  const idRoots = new Map<string, string>();
  let previousHash: `sha256:${string}` = ZERO_HASH;
  for (const [index, entry] of entries.entries()) {
    if (entry.registry_revision !== index + 1 || entry.previous_entry_hash !== previousHash) {
      projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    const knownId = rootIds.get(entry.canonical_root);
    if (knownId !== undefined && knownId !== entry.project_id) {
      projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    const knownRoot = idRoots.get(entry.project_id);
    if (knownRoot !== undefined && knownRoot !== entry.canonical_root) {
      projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    const prior = active.get(entry.project_id);
    const expectedReason =
      entry.state === "ACTIVE"
        ? prior === undefined
          ? "PROJECT_REGISTERED"
          : "PROJECT_MANIFEST_UPDATED"
        : entry.state === "UNREGISTERED"
          ? "PROJECT_UNREGISTERED"
          : "PROJECT_ROOT_UNAVAILABLE";
    if (entry.reason_code !== expectedReason || (entry.state !== "ACTIVE" && prior === undefined)) {
      projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    rootIds.set(entry.canonical_root, entry.project_id);
    idRoots.set(entry.project_id, entry.canonical_root);
    if (entry.state === "ACTIVE") active.set(entry.project_id, registration(entry));
    else active.delete(entry.project_id);
    previousHash = entry.entry_hash;
  }
  return { active, rootIds };
}

function entryFor(options: {
  readonly projectId: string;
  readonly canonicalRoot: string;
  readonly manifestHash: `sha256:${string}`;
  readonly state: ProjectRegistryState;
  readonly reasonCode: string;
  readonly history: readonly ProjectRegistryEntryV1[];
  readonly now: () => Date;
}): ProjectRegistryEntryV1 {
  const previous = options.history.at(-1);
  const hashable = {
    protocol_version: "runtime-contract.v1",
    schema_version: "project-registry-entry.v1",
    document_type: "project-registry-entry",
    registry_revision: options.history.length + 1,
    previous_entry_hash: previous?.entry_hash ?? ZERO_HASH,
    project_id: options.projectId,
    canonical_root: options.canonicalRoot,
    manifest_hash: options.manifestHash,
    state: options.state,
    reason_code: options.reasonCode,
    timestamp: options.now().toISOString(),
  } as const;
  return Object.freeze({ ...hashable, entry_hash: hashProjectRegistryEntry(hashable) });
}

export function createProjectRegistry(options: CreateProjectRegistryOptions): ProjectRegistry {
  const files = createPrivateRegistryFiles(options.statePath);
  const requestedRoot = path.resolve(options.statePath);
  let coordinatorPromise: Promise<Coordinator> | undefined;
  const pending = new Set<Promise<unknown>>();
  let intakeStopped = false;

  const coordinator = (): Promise<Coordinator> => {
    coordinatorPromise ??= (async () => {
      files.ensureRoots();
      const canonicalState = await realpath(requestedRoot);
      let shared = coordinators.get(canonicalState)?.deref();
      if (shared === undefined) {
        shared = { tail: Promise.resolve() };
        coordinators.set(canonicalState, new WeakRef(shared));
      }
      return shared;
    })();
    return coordinatorPromise;
  };

  const enqueue = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const scheduled = coordinator().then(async (shared) => {
      const current = shared.tail.catch(() => undefined).then(operation);
      shared.tail = current;
      return current;
    });
    pending.add(scheduled);
    void scheduled.finally(() => pending.delete(scheduled)).catch(() => undefined);
    return scheduled;
  };

  const load = (): RegistryHistory => {
    let file = files.read();
    if (file === null) {
      return { file: null, entries: [], active: new Map(), rootIds: new Map() };
    }
    let parsed = parseHistoryBytes(file.bytes);
    if (parsed.fragment.byteLength > 0) {
      if (parsed.entries.length === 0) projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
      const randomId = options.randomId();
      if (!UUID_PATTERN.test(randomId)) projectError("RUNTIME_PROJECT_INVALID");
      files.recoverPartial(
        file,
        file.bytes.subarray(0, parsed.prefixLength),
        parsed.fragment,
        randomId,
      );
      file = files.read();
      if (file === null) projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
      parsed = parseHistoryBytes(file.bytes);
      if (parsed.fragment.byteLength > 0) projectError("RUNTIME_PROJECT_REGISTRY_CORRUPT");
    }
    const state = validateHistory(parsed.entries);
    return { file, entries: parsed.entries, ...state };
  };

  const append = (history: RegistryHistory, entry: ProjectRegistryEntryV1): void => {
    files.append(history.file, Buffer.from(`${canonicalJson(entry)}\n`, "utf8"));
  };

  return {
    recover: () => enqueue(() => void load()),
    register(root) {
      if (intakeStopped)
        return Promise.reject(new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE"));
      return enqueue(() => {
        const binding = bindProject(root, options.operationHooks?.beforeManifestRead);
        const history = load();
        const knownId = history.rootIds.get(binding.canonicalRoot);
        const active = knownId === undefined ? undefined : history.active.get(knownId);
        if (active !== undefined && active.manifest_hash === binding.manifestHash) return active;
        const projectId = knownId ?? options.randomId();
        if (!UUID_PATTERN.test(projectId)) projectError("RUNTIME_PROJECT_INVALID");
        const entry = entryFor({
          projectId,
          canonicalRoot: binding.canonicalRoot,
          manifestHash: binding.manifestHash,
          state: "ACTIVE",
          reasonCode: active === undefined ? "PROJECT_REGISTERED" : "PROJECT_MANIFEST_UPDATED",
          history: history.entries,
          now: options.now,
        });
        append(history, entry);
        return registration(entry);
      });
    },
    unregister(projectId) {
      if (intakeStopped)
        return Promise.reject(new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE"));
      return enqueue(() => {
        if (!UUID_PATTERN.test(projectId)) projectError("RUNTIME_PROJECT_NOT_FOUND");
        const history = load();
        const current = history.active.get(projectId);
        if (current === undefined) projectError("RUNTIME_PROJECT_NOT_FOUND");
        const entry = entryFor({
          projectId,
          canonicalRoot: current.canonical_root,
          manifestHash: current.manifest_hash,
          state: "UNREGISTERED",
          reasonCode: "PROJECT_UNREGISTERED",
          history: history.entries,
          now: options.now,
        });
        append(history, entry);
        return registration(entry);
      });
    },
    blockUnavailable(projectId) {
      if (intakeStopped)
        return Promise.reject(new RuntimeProjectError("RUNTIME_PROJECT_UNAVAILABLE"));
      return enqueue(() => {
        if (!UUID_PATTERN.test(projectId)) projectError("RUNTIME_PROJECT_NOT_FOUND");
        const history = load();
        const current = history.active.get(projectId);
        if (current === undefined) projectError("RUNTIME_PROJECT_NOT_FOUND");
        const entry = entryFor({
          projectId,
          canonicalRoot: current.canonical_root,
          manifestHash: current.manifest_hash,
          state: "BLOCKED_PROJECT_UNAVAILABLE",
          reasonCode: "PROJECT_ROOT_UNAVAILABLE",
          history: history.entries,
          now: options.now,
        });
        append(history, entry);
        return registration(entry);
      });
    },
    list: () =>
      enqueue(() =>
        Object.freeze(
          [...load().active.values()].sort((left, right) =>
            Buffer.from(left.project_id).compare(Buffer.from(right.project_id)),
          ),
        ),
      ),
    get: (projectId) => enqueue(() => load().active.get(projectId) ?? null),
    stopIntake() {
      intakeStopped = true;
    },
    async flush(signal) {
      if (signal.aborted || pending.size === 0) return;
      let listener: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        listener = resolve;
        signal.addEventListener("abort", listener, { once: true });
      });
      try {
        await Promise.race([Promise.allSettled([...pending]).then(() => undefined), aborted]);
      } finally {
        if (listener !== undefined) signal.removeEventListener("abort", listener);
      }
    },
  };
}
