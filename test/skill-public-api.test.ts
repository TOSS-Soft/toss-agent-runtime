import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import { createRunJournalStore } from "../src/journal/store.js";
import type { TransitionCommand } from "../src/journal/state-machine.js";
import type { JournalHead, RunState } from "../src/journal/types.js";
import { canonicalJson, sha256 } from "../src/protocol/json.js";
import * as rootApi from "../src/index.js";
import * as skillApi from "../src/skills/index.js";
import type {
  CompleteSuperpowersPhaseRequest,
  HashableSkillDescriptorV1,
  HashableSkillExecutionEvidenceV1,
  HashableSkillSnapshotV1,
  HashableSuperpowersApprovalV1,
  HashableSuperpowersPhaseV1,
  ResumeSuperpowersApprovalRequest,
  RuntimeSkillErrorCode,
  SkillCatalogRoot,
  SkillCatalogSnapshot,
  SkillContext,
  SkillContextRequest,
  SkillContextSegment,
  SkillContextTruncation,
  SkillDescriptorReference,
  SkillDescriptorV1,
  SkillDiscoveryRequest,
  SkillExecutionEvidenceV1,
  SkillHostContextRequest,
  SkillResourceRole,
  SkillResourceV1,
  SkillSelection,
  SkillSelectionRequest,
  SkillsHost,
  SkillsHostConfig,
  SkillSnapshotV1,
  SkillSourceKind,
  StartSuperpowersPhaseRequest,
  SuperpowersApprovalDecisionV1,
  SuperpowersApprovalRequestV1,
  SuperpowersApprovalV1,
  SuperpowersPhaseName,
  SuperpowersPhaseOutcome,
  SuperpowersPhaseStatus,
  SuperpowersPhaseV1,
} from "../src/index.js";

const roots: string[] = [];
const TRACE = {
  trace_id: "1".repeat(32),
  span_id: "2".repeat(16),
  trace_flags: 1,
} as const;
const EXECUTION_REQUEST_HASH = `sha256:${"e".repeat(64)}` as const;
const PUBLIC_SKILL_VALUES = [
  "RuntimeSkillError",
  "SKILL_LIMITS",
  "createSkillsHost",
  "hashSkillCatalog",
  "hashSkillDescriptor",
  "hashSkillExecutionEvidence",
  "hashSkillPackage",
  "hashSkillSnapshot",
  "hashSuperpowersApproval",
  "hashSuperpowersPhase",
  "parseSkillDescriptor",
  "parseSkillExecutionEvidence",
  "parseSkillSnapshot",
  "parseSuperpowersApproval",
  "parseSuperpowersPhase",
] as const;
const PRIVATE_SKILL_NAMES = [
  "BUNDLED_MANIFEST_PATH",
  "CatalogTestHooks",
  "CreateSkillPrivateStoreOptions",
  "PhaseHistoryOperationHooks",
  "SkillContextMaterial",
  "auditBundledSkills",
  "bundledSkillsRoot",
  "createSkillCatalog",
  "createSkillCatalogForTest",
  "createSkillEvidenceBuilder",
  "createSkillLoader",
  "createSkillPrivateStore",
  "createSkillsEngine",
  "createSkillsEngineForTest",
  "requireSkillsHost",
  "resolveSkillSelectionForLoader",
] as const;

type PublicSkillTypeSurface = readonly [
  CompleteSuperpowersPhaseRequest,
  HashableSkillDescriptorV1,
  HashableSkillExecutionEvidenceV1,
  HashableSkillSnapshotV1,
  HashableSuperpowersApprovalV1,
  HashableSuperpowersPhaseV1,
  ResumeSuperpowersApprovalRequest,
  RuntimeSkillErrorCode,
  SkillCatalogRoot,
  SkillCatalogSnapshot,
  SkillContext,
  SkillContextRequest,
  SkillContextSegment,
  SkillContextTruncation,
  SkillDescriptorReference,
  SkillDescriptorV1,
  SkillDiscoveryRequest,
  SkillExecutionEvidenceV1,
  SkillHostContextRequest,
  SkillResourceRole,
  SkillResourceV1,
  SkillSelection,
  SkillSelectionRequest,
  SkillsHost,
  SkillsHostConfig,
  SkillSnapshotV1,
  SkillSourceKind,
  StartSuperpowersPhaseRequest,
  SuperpowersApprovalDecisionV1,
  SuperpowersApprovalRequestV1,
  SuperpowersApprovalV1,
  SuperpowersPhaseName,
  SuperpowersPhaseOutcome,
  SuperpowersPhaseStatus,
  SuperpowersPhaseV1,
];

function rawHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function clock(): () => Date {
  let second = 0;
  return () => new Date(Date.UTC(2026, 7, 30, 12, 0, second++));
}

function ids(): () => string {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

function journalCommand(
  runId: string,
  state: RunState,
  head: JournalHead | null,
): TransitionCommand {
  return {
    run_id: runId,
    expected_revision: head?.journal_revision ?? 0,
    expected_head_hash: head?.entry_hash ?? ZERO_JOURNAL_HASH,
    command_id: `${runId}-${state.toLowerCase()}`,
    operation_id: null,
    next_state: state,
    reason_code: `MOVE_${state}`,
    trace: TRACE,
    metadata: {},
    side_effect: null,
  };
}

async function runningJournal(statePath: string, runId: string): Promise<JournalHead> {
  const journal = createRunJournalStore({ statePath, now: clock(), randomId: ids() });
  let head: JournalHead | null = null;
  for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
    head = (await journal.transition(journalCommand(runId, state, head))).head;
  }
  journal.stopIntake();
  await journal.flush(AbortSignal.timeout(5_000));
  if (head === null) throw new Error("running journal fixture did not produce a head");
  return head;
}

async function writeConfiguredBrainstormingPackage(
  configuredRoot: string,
  requiredCapabilities: readonly string[],
  scriptBody: string,
): Promise<void> {
  const packageRoot = path.join(configuredRoot, "brainstorming");
  const script = Buffer.from(scriptBody, "utf8");
  const skillMarkdown = Buffer.from("# Configured brainstorming\n", "utf8");
  const resources = [
    {
      path: "scripts/check.mjs",
      role: "script" as const,
      phases: [] as const,
      priority: null,
      media_type: "text/javascript",
      bytes: script.byteLength,
      hash: rawHash(script),
    },
  ];
  const intrinsic = {
    name: "brainstorming",
    description: "Configured brainstorming package with inert script data.",
    version: "1.0.0",
    required_runtime_capabilities: requiredCapabilities,
    skill_markdown: {
      path: "SKILL.md" as const,
      media_type: "text/markdown" as const,
      bytes: skillMarkdown.byteLength,
      hash: rawHash(skillMarkdown),
    },
    resources,
  };
  const manifest = {
    ...intrinsic,
    resource_count: resources.length,
    total_bytes: skillMarkdown.byteLength + script.byteLength,
    package_hash: sha256({
      name: intrinsic.name,
      description: intrinsic.description,
      version: intrinsic.version,
      required_runtime_capabilities: intrinsic.required_runtime_capabilities,
      skill_markdown_bytes: intrinsic.skill_markdown.bytes,
      skill_markdown_hash: intrinsic.skill_markdown.hash,
      resources,
    }),
  };
  await mkdir(path.join(packageRoot, "scripts"), { recursive: true, mode: 0o700 });
  await chmod(configuredRoot, 0o700);
  await chmod(packageRoot, 0o700);
  await chmod(path.join(packageRoot, "scripts"), 0o700);
  await writeFile(path.join(packageRoot, "skill.json"), canonicalJson(manifest), { mode: 0o600 });
  await writeFile(path.join(packageRoot, "SKILL.md"), skillMarkdown, { mode: 0o600 });
  await writeFile(path.join(packageRoot, "scripts", "check.mjs"), script, { mode: 0o600 });
}

function configuredSnapshot(descriptor: SkillDescriptorV1, scriptBody: string): SkillSnapshotV1 {
  const script = Buffer.from(scriptBody, "utf8");
  const skillMarkdown = Buffer.from("# Configured brainstorming\n", "utf8");
  const resources = [
    {
      path: "scripts/check.mjs",
      role: "script" as const,
      phases: [] as const,
      priority: null,
      media_type: "text/javascript",
      bytes: script.byteLength,
      hash: rawHash(script),
    },
  ];
  const hashable = {
    protocol_version: "runtime-contract.v1" as const,
    schema_version: "skill-snapshot.v1" as const,
    document_type: "skill-snapshot" as const,
    descriptor,
    skill_markdown_hash: rawHash(skillMarkdown),
    skill_markdown_bytes: skillMarkdown.byteLength,
    resources,
    package_hash: descriptor.package_hash,
    total_bytes: skillMarkdown.byteLength + script.byteLength,
  };
  return { ...hashable, document_hash: sha256(hashable) };
}

function descriptorReference(descriptor: SkillDescriptorV1): SkillDescriptorReference {
  return {
    name: descriptor.name,
    version: descriptor.version,
    source: descriptor.source,
    package_hash: descriptor.package_hash,
    document_hash: descriptor.document_hash,
  };
}

async function residualSkillArtifacts(statePath: string): Promise<readonly string[]> {
  try {
    const names = await readdir(statePath, { recursive: true });
    return names.filter((name) => /(?:\.stage|\.claim|\.tombstone)$/u.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function directoryContentSnapshot(root: string): Promise<readonly string[]> {
  let names: string[];
  try {
    names = await readdir(root, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const snapshot: string[] = [];
  for (const name of names.sort()) {
    const absolutePath = path.join(root, name);
    const stats = await lstat(absolutePath);
    if (stats.isDirectory()) {
      snapshot.push(`directory:${name}`);
    } else if (stats.isFile()) {
      snapshot.push(`file:${name}:${rawHash(await readFile(absolutePath))}`);
    } else {
      snapshot.push(`other:${name}`);
    }
  }
  return snapshot;
}

function expectRecursivelyFrozenPlainData(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  expect(typeof value).toBe("object");
  if (typeof value !== "object" || value === null) return;
  expect(seen.has(value)).toBe(false);
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.getOwnPropertySymbols(value)).toEqual([]);
  expect(Object.getPrototypeOf(value)).toBe(
    Array.isArray(value) ? Array.prototype : Object.prototype,
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === "length") continue;
    expect(descriptor.enumerable).toBe(true);
    expect(descriptor).not.toHaveProperty("get");
    expect(descriptor).not.toHaveProperty("set");
    expectRecursivelyFrozenPlainData(descriptor.value, seen);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent Skills public API", () => {
  it("publishes only the safe host, contracts, hashes, error, and immutable constants", () => {
    expect(Object.keys(skillApi).sort()).toEqual([...PUBLIC_SKILL_VALUES].sort());
    for (const name of PUBLIC_SKILL_VALUES) {
      expect(rootApi[name]).toBe(skillApi[name]);
    }
    expect(Object.isFrozen(skillApi.SKILL_LIMITS)).toBe(true);
  });

  it("publishes the immutable skill domain type surface", () => {
    expectTypeOf<PublicSkillTypeSurface>().toMatchTypeOf<readonly unknown[]>();
  });

  it("keeps paths, stored bytes, hooks, test seams, and private factories absent", () => {
    for (const privateName of PRIVATE_SKILL_NAMES) {
      expect(rootApi).not.toHaveProperty(privateName);
      expect(skillApi).not.toHaveProperty(privateName);
    }
  });

  it("keeps private skill modules blocked by the package export boundary", () => {
    expect(() => import.meta.resolve("@toss-software/agent-runtime/skills/private-store")).toThrow(
      expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
    );
    expect(() => import.meta.resolve("@toss-software/agent-runtime/src/skills/engine.js")).toThrow(
      expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
    );
  });

  it("creates a self-contained host without exposing native paths or test seams", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-skills-public-")));
    roots.push(root);
    const statePath = path.join(root, "state");
    const config: SkillsHostConfig = Object.freeze({
      state_path: statePath,
      socket_path: path.join(root, "runtime.sock"),
      skill_roots: Object.freeze([]),
    });
    const host = rootApi.createSkillsHost(config);
    try {
      await host.recover();
      expect(Object.keys(host).sort()).toEqual([
        "assembleContext",
        "completePhase",
        "discover",
        "evidence",
        "flush",
        "load",
        "recover",
        "resumeApproval",
        "select",
        "startPhase",
        "stopIntake",
      ]);
      expect(JSON.stringify(host)).not.toContain(root);
      const catalog = await host.discover({ query: null, allowed_capabilities: ["brainstorming"] });
      expect(Object.isFrozen(catalog)).toBe(true);
      expect(Object.isFrozen(catalog.descriptors)).toBe(true);
      expect(JSON.stringify(catalog)).not.toContain(root);
    } finally {
      host.stopIntake();
      await host.flush(AbortSignal.timeout(5_000));
    }
  });

  it("ignores a nonmatching query for exact public selection and captures the request before discovery", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-skills-select-")));
    roots.push(root);
    const host = rootApi.createSkillsHost({
      state_path: path.join(root, "state"),
      socket_path: path.join(root, "runtime.sock"),
      skill_roots: [],
    });
    try {
      await host.recover();
      const catalog = await host.discover({
        query: null,
        allowed_capabilities: ["brainstorming"],
      });
      const descriptor = catalog.descriptors.find((entry) => entry.name === "brainstorming");
      if (descriptor === undefined) throw new Error("bundled brainstorming descriptor missing");
      const request: {
        mode: "explicit" | "implicit";
        capability: string;
        allowed_capabilities: string[];
        query: string | null;
        descriptor: SkillDescriptorReference | null;
      } = {
        mode: "explicit",
        capability: "brainstorming",
        allowed_capabilities: ["brainstorming"],
        query: "definitely-no-match",
        descriptor: descriptorReference(descriptor),
      };
      const accepted = host.select(request);
      request.mode = "implicit";
      request.capability = "systematic-debugging";
      request.allowed_capabilities.splice(0, 1, "systematic-debugging");
      request.query = null;
      request.descriptor = null;

      await expect(accepted).resolves.toMatchObject({
        descriptor: { document_hash: descriptor.document_hash },
      });
    } finally {
      host.stopIntake();
      await host.flush(AbortSignal.timeout(5_000));
    }
  });

  it("drains same-turn accepted recover and select operations while rejecting new intake", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-skills-drain-")));
    roots.push(root);
    const recoverState = path.join(root, "recover-state");
    const recovering = rootApi.createSkillsHost({
      state_path: recoverState,
      socket_path: path.join(root, "recover.sock"),
      skill_roots: [],
    });
    const acceptedRecovery = recovering.recover();
    recovering.stopIntake();
    await expect(acceptedRecovery).resolves.toBeUndefined();
    await expect(
      recovering.discover({ query: null, allowed_capabilities: ["brainstorming"] }),
    ).rejects.toMatchObject({ code: "RUNTIME_SKILL_UNAVAILABLE" });
    await recovering.flush(AbortSignal.timeout(5_000));
    expect(await residualSkillArtifacts(recoverState)).toEqual([]);

    const selectState = path.join(root, "select-state");
    const selecting = rootApi.createSkillsHost({
      state_path: selectState,
      socket_path: path.join(root, "select.sock"),
      skill_roots: [],
    });
    await selecting.recover();
    const acceptedSelection = selecting.select({
      mode: "implicit",
      capability: "brainstorming",
      allowed_capabilities: ["brainstorming"],
      query: null,
      descriptor: null,
    });
    selecting.stopIntake();
    await expect(acceptedSelection).resolves.toMatchObject({
      descriptor: { name: "brainstorming" },
    });
    await expect(
      selecting.select({
        mode: "implicit",
        capability: "brainstorming",
        allowed_capabilities: ["brainstorming"],
        query: null,
        descriptor: null,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SKILL_UNAVAILABLE" });
    await selecting.flush(AbortSignal.timeout(5_000));
    expect(await residualSkillArtifacts(selectState)).toEqual([]);
  });

  it.each([
    [["brainstorming", "external-scripts"], "RUNTIME_SKILL_SCRIPT_UNAVAILABLE"],
    [["brainstorming", "future-runtime"], "BLOCKED_SUPERPOWERS_MISSING"],
  ] as const)(
    "rejects context, load, and phase for an authorized but undelivered configured dependency %j before any runtime effect",
    async (requiredCapabilities, code) => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-skills-runtime-cap-")));
      roots.push(root);
      const configuredRoot = path.join(root, "configured");
      await mkdir(configuredRoot, { mode: 0o700 });
      const processWitness = path.join(root, "script-process-witness");
      let networkConnections = 0;
      const server = createServer((socket) => {
        networkConnections += 1;
        socket.end();
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("TCP witness missing");
      const scriptBody = [
        'import { appendFileSync } from "node:fs";',
        'import { createConnection } from "node:net";',
        `appendFileSync(${JSON.stringify(processWitness)}, String(process.pid));`,
        `createConnection({ host: "127.0.0.1", port: ${address.port} }).end();`,
      ].join("\n");
      await writeConfiguredBrainstormingPackage(
        configuredRoot,
        [...requiredCapabilities].sort(),
        scriptBody,
      );
      const statePath = path.join(root, "state");
      const head = await runningJournal(statePath, "run-unavailable-capability");
      const host = rootApi.createSkillsHost({
        state_path: statePath,
        socket_path: path.join(root, "runtime.sock"),
        skill_roots: [configuredRoot],
      });
      try {
        await host.recover();
        const allowedCapabilities = [...requiredCapabilities].sort();
        const catalog = await host.discover({
          query: null,
          allowed_capabilities: allowedCapabilities,
        });
        const descriptor = catalog.descriptors.find(
          (entry) => entry.name === "brainstorming" && entry.source.kind === "configured",
        );
        if (descriptor === undefined) throw new Error("configured descriptor missing");
        const selection = await host.select({
          mode: "explicit",
          capability: "brainstorming",
          allowed_capabilities: allowedCapabilities,
          query: null,
          descriptor: descriptorReference(descriptor),
        });
        const snapshot = configuredSnapshot(selection.descriptor, scriptBody);
        const contextRequest = {
          selection,
          snapshot,
          snapshot_hash: snapshot.document_hash,
          phase: "BRAINSTORMING" as const,
          max_bytes: 4_096,
          max_tokens: 1_024,
        };
        const request = {
          run_id: "run-unavailable-capability",
          expected_journal_head: head,
          execution_request_hash: EXECUTION_REQUEST_HASH,
          selection,
          phase: "BRAINSTORMING" as const,
          input: Buffer.from("propose a bounded design", "utf8"),
          operation_id: "unavailable-capability",
          trace: TRACE,
        };
        const sourceBeforeRejection = await directoryContentSnapshot(configuredRoot);
        const stateBeforeRejection = await directoryContentSnapshot(statePath);
        await expect(host.assembleContext(contextRequest)).rejects.toMatchObject({ code });
        await expect(host.assembleContext(contextRequest)).rejects.toMatchObject({ code });
        await expect(host.load(selection)).rejects.toMatchObject({ code });
        await expect(host.load(selection)).rejects.toMatchObject({ code });
        await expect(host.startPhase(request)).rejects.toMatchObject({ code });
        await expect(host.startPhase(request)).rejects.toMatchObject({ code });
        expect(await directoryContentSnapshot(configuredRoot)).toEqual(sourceBeforeRejection);
        expect(await directoryContentSnapshot(statePath)).toEqual(stateBeforeRejection);
        expect(await residualSkillArtifacts(statePath)).toEqual([]);
        await expect(access(processWitness)).rejects.toMatchObject({ code: "ENOENT" });
        await new Promise((resolve) => setImmediate(resolve));
        expect(networkConnections).toBe(0);
      } finally {
        host.stopIntake();
        await host.flush(AbortSignal.timeout(5_000));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("keeps a script resource inert and usable when execution is not a declared dependency", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-skills-inert-script-")));
    roots.push(root);
    const configuredRoot = path.join(root, "configured");
    await mkdir(configuredRoot, { mode: 0o700 });
    const witness = path.join(root, "must-not-exist");
    await writeConfiguredBrainstormingPackage(
      configuredRoot,
      ["brainstorming"],
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(witness)}, "x");`,
    );
    const statePath = path.join(root, "state");
    const head = await runningJournal(statePath, "run-inert-script");
    const host = rootApi.createSkillsHost({
      state_path: statePath,
      socket_path: path.join(root, "runtime.sock"),
      skill_roots: [configuredRoot],
    });
    try {
      await host.recover();
      const catalog = await host.discover({
        query: null,
        allowed_capabilities: ["brainstorming"],
      });
      const descriptor = catalog.descriptors.find(
        (entry) => entry.name === "brainstorming" && entry.source.kind === "configured",
      );
      if (descriptor === undefined) throw new Error("configured descriptor missing");
      const selection = await host.select({
        mode: "explicit",
        capability: "brainstorming",
        allowed_capabilities: ["brainstorming"],
        query: null,
        descriptor: descriptorReference(descriptor),
      });
      const snapshot = await host.load(selection);
      await expect(host.load(selection)).resolves.toEqual(snapshot);
      const mutableSnapshot = JSON.parse(canonicalJson(snapshot)) as Record<string, unknown>;
      const mutableContextRequest = {
        selection,
        snapshot: mutableSnapshot,
        snapshot_hash: snapshot.document_hash,
        phase: "BRAINSTORMING",
        max_bytes: 4_096,
        max_tokens: 1_024,
      };
      const acceptedContext = host.assembleContext(
        mutableContextRequest as unknown as SkillHostContextRequest,
      );
      mutableSnapshot.total_bytes = 0;
      mutableContextRequest.snapshot_hash = `sha256:${"f".repeat(64)}`;
      mutableContextRequest.phase = "RED";
      mutableContextRequest.max_bytes = 0;
      mutableContextRequest.max_tokens = 0;
      const context = await acceptedContext;
      expect(context).toMatchObject({
        phase: "BRAINSTORMING",
        snapshot: { snapshot_hash: snapshot.document_hash },
      });
      await expect(
        host.assembleContext({
          selection,
          snapshot,
          snapshot_hash: snapshot.document_hash,
          phase: "BRAINSTORMING",
          max_bytes: 4_096,
          max_tokens: 1_024,
        }),
      ).resolves.toEqual(context);
      await expect(
        host.startPhase({
          run_id: "run-inert-script",
          expected_journal_head: head,
          execution_request_hash: EXECUTION_REQUEST_HASH,
          selection,
          phase: "BRAINSTORMING",
          input: Buffer.from("propose a bounded design", "utf8"),
          operation_id: "inert-script",
          trace: TRACE,
        }),
      ).resolves.toMatchObject({ phase: { status: "STARTED" } });
      const acceptedReplay = host.assembleContext({
        selection,
        snapshot,
        snapshot_hash: snapshot.document_hash,
        phase: "BRAINSTORMING",
        max_bytes: 4_096,
        max_tokens: 1_024,
      });
      host.stopIntake();
      await expect(acceptedReplay).resolves.toEqual(context);
      await expect(
        host.assembleContext({
          selection,
          snapshot,
          snapshot_hash: snapshot.document_hash,
          phase: "BRAINSTORMING",
          max_bytes: 4_096,
          max_tokens: 1_024,
        }),
      ).rejects.toMatchObject({ code: "RUNTIME_SKILL_UNAVAILABLE" });
      await expect(access(witness)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      host.stopIntake();
      await host.flush(AbortSignal.timeout(5_000));
    }
  });

  it("returns only frozen public data without private root, environment, or native authority", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-skills-public-context-")));
    roots.push(root);
    const configuredRoot = path.join(root, "configured-private-source");
    await mkdir(configuredRoot, { mode: 0o700 });
    await writeConfiguredBrainstormingPackage(
      configuredRoot,
      ["brainstorming"],
      "export {}; // inert package content intentionally contains no authority sentinel\n",
    );
    const environmentSentinel = `PRIVATE_ENV_${randomUUID()}`;
    vi.stubEnv("TOSS_SKILL_PRIVATE_SENTINEL", environmentSentinel);
    const host = rootApi.createSkillsHost({
      state_path: path.join(root, "state"),
      socket_path: path.join(root, "runtime.sock"),
      skill_roots: [configuredRoot],
    });
    try {
      await host.recover();
      const catalog = await host.discover({
        query: null,
        allowed_capabilities: ["brainstorming"],
      });
      const descriptor = catalog.descriptors.find(
        (entry) => entry.name === "brainstorming" && entry.source.kind === "configured",
      );
      if (descriptor === undefined) throw new Error("configured descriptor missing");
      const selection = await host.select({
        mode: "explicit",
        capability: "brainstorming",
        allowed_capabilities: ["brainstorming"],
        query: null,
        descriptor: descriptorReference(descriptor),
      });
      const snapshot = await host.load(selection);
      const context = await host.assembleContext({
        selection,
        snapshot,
        snapshot_hash: snapshot.document_hash,
        phase: "BRAINSTORMING",
        max_bytes: 4_096,
        max_tokens: 1_024,
      });

      expectRecursivelyFrozenPlainData(context);
      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain(configuredRoot);
      expect(serialized).not.toContain(environmentSentinel);
      expect(serialized).not.toContain("FileHandle");
      expect(serialized).not.toContain("Socket");
    } finally {
      host.stopIntake();
      await host.flush(AbortSignal.timeout(5_000));
      vi.unstubAllEnvs();
    }
  });

  it("captures exact data-only config once and rejects active or exotic authority", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-skills-config-")));
    roots.push(root);
    const originalState = path.join(root, "original-state");
    const movedState = path.join(root, "moved-state");
    const rootsAuthority: string[] = [];
    const mutable: SkillsHostConfig = {
      state_path: originalState,
      socket_path: path.join(root, "runtime.sock"),
      skill_roots: rootsAuthority,
    };
    const host = rootApi.createSkillsHost(mutable);
    (mutable as { state_path: string }).state_path = movedState;
    rootsAuthority.push(path.join(root, "late-root"));
    try {
      await host.recover();
      await expect(access(originalState)).resolves.toBeUndefined();
      await expect(access(movedState)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      host.stopIntake();
      await host.flush(AbortSignal.timeout(5_000));
    }

    let getterReads = 0;
    const accessorConfig = Object.freeze(
      Object.defineProperties(
        {},
        {
          state_path: {
            enumerable: true,
            get: () => {
              getterReads += 1;
              return originalState;
            },
          },
          socket_path: { enumerable: true, value: path.join(root, "accessor.sock") },
          skill_roots: { enumerable: true, value: Object.freeze([]) },
        },
      ),
    ) as SkillsHostConfig;
    expect(() => rootApi.createSkillsHost(accessorConfig)).toThrow("Invalid SkillsHostConfig");
    expect(getterReads).toBe(0);

    const valid = () => ({
      state_path: originalState,
      socket_path: path.join(root, "runtime.sock"),
      skill_roots: [] as string[],
    });
    const hidden = valid();
    Object.defineProperty(hidden, "hidden", { value: true });
    const symbol = valid() as SkillsHostConfig & { [key: symbol]: boolean };
    Object.defineProperty(symbol, Symbol("hidden"), { enumerable: true, value: true });
    const sparse = valid();
    sparse.skill_roots = new Array<string>(1);
    const extraArray = valid();
    Object.defineProperty(extraArray.skill_roots, "hidden", { value: true });
    const cyclic = valid();
    (cyclic.skill_roots as unknown[]).push(cyclic.skill_roots);
    const proxyGets = vi.fn();
    const proxied = new Proxy(valid(), {
      get(target, property, receiver): unknown {
        proxyGets(property);
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    for (const candidate of [hidden, symbol, sparse, extraArray, cyclic, proxied]) {
      expect(() => rootApi.createSkillsHost(candidate as SkillsHostConfig)).toThrow(
        "Invalid SkillsHostConfig",
      );
    }
    expect(proxyGets).not.toHaveBeenCalled();
  });

  it("emits public declarations without private skill hooks, native paths, or body stores", () => {
    const declarationRoot = mkdtempSync(path.join(tmpdir(), "toss-skill-public-api-"));
    try {
      execFileSync(
        process.execPath,
        [
          "node_modules/typescript/bin/tsc",
          "-p",
          "tsconfig.build.json",
          "--emitDeclarationOnly",
          "--declarationMap",
          "false",
          "--outDir",
          declarationRoot,
        ],
        { cwd: process.cwd(), stdio: "pipe" },
      );
      const skillsDeclaration = readFileSync(
        path.join(declarationRoot, "src/skills/index.d.ts"),
        "utf8",
      );
      const publicDeclarations = [
        readFileSync(path.join(declarationRoot, "src/index.d.ts"), "utf8"),
        skillsDeclaration,
      ].join("\n");
      for (const privateName of PRIVATE_SKILL_NAMES) {
        expect(publicDeclarations).not.toContain(privateName);
      }
      expect(publicDeclarations).not.toMatch(
        /absoluteDirectory|absolutePath|manifestPath|skill_markdown_base64/u,
      );
      expect(skillsDeclaration).toMatch(
        /createSkillsHost\(config: SkillsHostConfig\): SkillsHost/u,
      );
      expect(skillsDeclaration).not.toMatch(
        /RunJournalStore|hasServiceListener|randomId|readonly now|operationHooks|ForTest/u,
      );
      expect(skillsDeclaration).not.toMatch(
        /from "\.\/(?:approval|catalog|context|engine|loader|private-store|runtime-host)\.js"/u,
      );
      expect(skillsDeclaration).toMatch(/export interface SkillSelection \{/u);
      expect(skillsDeclaration).toMatch(/export interface StartSuperpowersPhaseRequest \{/u);
      expect(skillsDeclaration).toMatch(/export interface ResumeSuperpowersApprovalRequest \{/u);
    } finally {
      rmSync(declarationRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
