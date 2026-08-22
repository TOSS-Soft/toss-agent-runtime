import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  hashAgentDefinition,
  hashAgentRegistryEntry,
  hashPromptTemplate,
} from "../src/agents/contracts.js";
import {
  createAgentRegistry,
  type AgentRegistry,
  type CreateAgentRegistryOptions,
} from "../src/agents/registry.js";
import { canonicalJson, sha256 } from "../src/protocol/json.js";
import type { ArtifactReference } from "../src/protocol/types.js";
import type {
  AgentDefinitionBundle,
  AgentDefinitionV1,
  AgentRegistration,
  AgentRegistryEntryV1,
  HashableAgentRegistryEntryV1,
  PromptTemplateV1,
} from "../src/agents/types.js";

const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;
const TASK_HASH = `sha256:${"1".repeat(64)}` as const;
const MCP_HASH = `sha256:${"2".repeat(64)}` as const;
const OUTPUT_HASH = `sha256:${"3".repeat(64)}` as const;
const AGENT_ID = "agent-implementation";
const OPERATION_1 = "10000000-0000-4000-8000-000000000001";
const OPERATION_2 = "10000000-0000-4000-8000-000000000002";
const OPERATION_3 = "10000000-0000-4000-8000-000000000003";
const OPERATION_4 = "10000000-0000-4000-8000-000000000004";
const roots: string[] = [];

interface RegistryTestDependencies {
  readonly isProcessAlive?: (pid: number) => "alive" | "dead" | "unknown";
  readonly isCurrentUser?: (userId: bigint, candidate: string) => boolean;
  readonly privateStoreOperationHooks?: {
    readonly afterObjectOpen?: (objectPath: string) => Promise<void>;
    readonly beforeClaimFileSync?: (claimPath: string) => Promise<void>;
  };
  readonly operationHooks?: {
    readonly beforeHistoryFileSync?: (
      history: "lifecycle" | "operations" | "quarantine" | "recovery",
      filePath: string,
    ) => void;
    readonly beforeHistoryDirectorySync?: (directoryPath: string) => void;
    readonly afterObjectsPublished?: () => Promise<void>;
  };
}

type RegistryTestOverrides = Partial<CreateAgentRegistryOptions> & RegistryTestDependencies;

type InternalCreateAgentRegistry = (
  options: CreateAgentRegistryOptions,
  dependencies?: RegistryTestDependencies,
) => AgentRegistry;

function reference<T extends string>(
  document_type: T,
  artifact_id: string,
  revision: number,
  hash: `sha256:${string}`,
): ArtifactReference & Readonly<{ document_type: T }> {
  return { document_type, artifact_id, revision, hash };
}

function prompt(
  revision: number,
  content = `Implementation instructions ${revision}.`,
): PromptTemplateV1 {
  const candidate: PromptTemplateV1 = {
    protocol_version: "runtime-contract.v1",
    schema_version: "prompt-template.v1",
    document_type: "prompt-template",
    template_id: "template-implementation",
    revision,
    instruction_blocks: [{ block_id: "role", content }],
    document_hash: ZERO_HASH,
  };
  return { ...candidate, document_hash: hashPromptTemplate(candidate) };
}

function definition(
  revision: number,
  promptTemplate: PromptTemplateV1,
  name = `implementation-worker-${revision}`,
): AgentDefinitionV1 {
  const candidate: AgentDefinitionV1 = {
    protocol_version: "runtime-contract.v1",
    schema_version: "agent-definition.v1",
    document_type: "agent-definition",
    agent_id: AGENT_ID,
    revision,
    name,
    role: "worker",
    prompt_template: reference(
      "prompt-template",
      promptTemplate.template_id,
      promptTemplate.revision,
      promptTemplate.document_hash,
    ),
    task_contracts: [reference("task-contract", "task-implementation", 3, TASK_HASH)],
    model: {
      logical_class: "balanced-code",
      required_capabilities: ["text"],
      allowed_capabilities: ["json-schema", "text", "tools"],
    },
    superpowers: {
      required: ["test-driven-development"],
      allowed: ["test-driven-development", "verification-before-completion"],
    },
    mcp_profiles: [reference("mcp-profile", "mcp-development", 2, MCP_HASH)],
    budget_class: "standard",
    budget_ceiling: {
      max_input_tokens: 8000,
      max_output_tokens: 4000,
      max_cost_microusd: 500000,
      max_duration_ms: 600000,
      max_turns: 8,
    },
    output_schemas: [reference("output-schema", "output-implementation", 4, OUTPUT_HASH)],
    context_policy: {
      truncation: "utf8-prefix.v1",
      max_untrusted_bytes: 4096,
      inputs: [{ document_type: "source-artifact", priority: 10, max_bytes: 2048 }],
    },
    document_hash: ZERO_HASH,
  };
  return { ...candidate, document_hash: hashAgentDefinition(candidate) };
}

function bundle(revision: number): AgentDefinitionBundle {
  const promptTemplate = prompt(revision);
  return {
    definition: definition(revision, promptTemplate),
    prompt_template: promptTemplate,
  };
}

function definitionReference(candidate: AgentDefinitionV1): ArtifactReference {
  return reference(
    "agent-definition",
    candidate.agent_id,
    candidate.revision,
    candidate.document_hash,
  );
}

function publishOperationHash(candidate: AgentDefinitionBundle): `sha256:${string}` {
  return sha256({
    command: "agent-publish",
    definition: definitionReference(candidate.definition),
    prompt_template: candidate.definition.prompt_template,
  });
}

function retireOperationHash(candidate: ArtifactReference): `sha256:${string}` {
  return sha256({ command: "agent-retire", definition: candidate });
}

async function fixture(): Promise<{ readonly root: string; readonly statePath: string }> {
  const temporary = await realpath("/tmp");
  const root = await mkdtemp(path.join(temporary, "toss-agent-registry-"));
  roots.push(root);
  return { root, statePath: path.join(root, "state") };
}

function registry(statePath: string, overrides: RegistryTestOverrides = {}): AgentRegistry {
  let tick = 0;
  let id = 0;
  const {
    isProcessAlive,
    isCurrentUser,
    privateStoreOperationHooks,
    operationHooks,
    ...publicOverrides
  } = overrides;
  const createInternal: InternalCreateAgentRegistry = createAgentRegistry;
  return createInternal(
    {
      statePath,
      now: () => new Date(Date.UTC(2026, 7, 21, 12, 0, tick++)),
      randomId: () => `70000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      hasServiceListener: () => Promise.resolve("absent"),
      ...publicOverrides,
    },
    {
      ...(isProcessAlive === undefined ? {} : { isProcessAlive }),
      ...(isCurrentUser === undefined ? {} : { isCurrentUser }),
      ...(privateStoreOperationHooks === undefined ? {} : { privateStoreOperationHooks }),
      ...(operationHooks === undefined ? {} : { operationHooks }),
    },
  );
}

function registryDirectory(statePath: string): string {
  return path.join(statePath, "agents", "registry");
}

function entriesPath(statePath: string): string {
  return path.join(registryDirectory(statePath), "entries.jsonl");
}

function operationsPath(statePath: string): string {
  return path.join(registryDirectory(statePath), "operations.jsonl");
}

function objectPath(statePath: string, hash: `sha256:${string}`): string {
  return path.join(statePath, "agents", "objects", hash.slice("sha256:".length));
}

async function lines(candidate: string): Promise<string[]> {
  return (await readFile(candidate, "utf8")).trimEnd().split("\n");
}

function rehashEntry(value: Record<string, unknown>): AgentRegistryEntryV1 {
  const hashable = { ...value };
  Reflect.deleteProperty(hashable, "entry_hash");
  return {
    ...hashable,
    entry_hash: hashAgentRegistryEntry(hashable as unknown as HashableAgentRegistryEntryV1),
  } as unknown as AgentRegistryEntryV1;
}

function rawSha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function registrationFromEntry(entry: AgentRegistryEntryV1): AgentRegistration {
  return {
    registry_revision: entry.registry_revision,
    definition: entry.definition,
    prompt_template: entry.prompt_template,
    state: entry.state,
    entry_hash: entry.entry_hash,
  };
}

function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null || seen.has(value)) return true;
  seen.add(value);
  return (
    Object.isFrozen(value) && Object.values(value).every((member) => isDeepFrozen(member, seen))
  );
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("immutable agent lifecycle registry", () => {
  it("exposes only the narrow production construction dependencies", () => {
    expectTypeOf<keyof CreateAgentRegistryOptions>().toEqualTypeOf<
      "statePath" | "now" | "randomId" | "hasServiceListener"
    >();
  });

  it("rejects a missing authoritative listener dependency before state creation", async () => {
    const { statePath } = await fixture();

    expect(() =>
      createAgentRegistry({
        statePath,
        now: () => new Date(0),
        randomId: () => OPERATION_1,
        hasServiceListener: undefined as never,
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_AGENT_REGISTRY_CORRUPT" }));
    expect(existsSync(statePath)).toBe(false);
  });

  it("publishes an exact bundle, replays its operation without history growth, and resolves it", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const v1 = bundle(1);

    const first = await agents.publish(v1, OPERATION_1);
    const history = await readFile(entriesPath(statePath));
    const replay = await agents.publish(v1, OPERATION_1);

    expect(first).toMatchObject({
      registry_revision: 1,
      definition: definitionReference(v1.definition),
      prompt_template: v1.definition.prompt_template,
      state: "ACTIVE",
    });
    expect(first.entry_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(replay).toEqual(first);
    expect(await readFile(entriesPath(statePath))).toEqual(history);
    expect(existsSync(operationsPath(statePath))).toBe(false);
    expect(await agents.resolveForExecution(definitionReference(v1.definition))).toEqual(v1);
    expect(await agents.resolveForResume(definitionReference(v1.definition))).toEqual(v1);
  });

  it("persists a separate no-op result for a new operation and rejects conflicting reuse", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const v1 = bundle(1);
    const first = await agents.publish(v1, OPERATION_1);

    await expect(agents.publish(v1, OPERATION_2)).resolves.toEqual(first);
    await expect(
      agents.retire(definitionReference(v1.definition), OPERATION_2),
    ).rejects.toMatchObject({
      code: "RUNTIME_AGENT_OPERATION_CONFLICT",
    });

    expect(await lines(entriesPath(statePath))).toHaveLength(1);
    expect(await lines(operationsPath(statePath))).toHaveLength(1);
    await expect(registry(statePath).publish(v1, OPERATION_2)).resolves.toEqual(first);
  });

  it("activates revision 2, rejects revision 1 for execution, and retains revision 1 for resume", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const v1 = bundle(1);
    const v2 = bundle(2);
    await agents.publish(v1, OPERATION_1);

    const second = await agents.publish(v2, OPERATION_2);

    await expect(
      agents.resolveForExecution(definitionReference(v1.definition)),
    ).rejects.toMatchObject({
      code: "RUNTIME_AGENT_STALE_REVISION",
    });
    await expect(agents.resolveForExecution(definitionReference(v2.definition))).resolves.toEqual(
      v2,
    );
    await expect(agents.resolveForResume(definitionReference(v1.definition))).resolves.toEqual(v1);
    expect(second).toMatchObject({ registry_revision: 2, state: "ACTIVE" });
    expect(await agents.list()).toEqual([second]);
  });

  it("retires only the exact active revision and durably replays the retirement", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const v1 = bundle(1);
    const active = await agents.publish(v1, OPERATION_1);

    const retired = await agents.retire(definitionReference(v1.definition), OPERATION_2);

    expect(retired).toMatchObject({
      definition: active.definition,
      prompt_template: active.prompt_template,
      registry_revision: 2,
      state: "RETIRED",
    });
    expect(retired.entry_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(retired.entry_hash).not.toBe(active.entry_hash);
    await expect(agents.retire(definitionReference(v1.definition), OPERATION_2)).resolves.toEqual(
      retired,
    );
    await expect(
      agents.resolveForExecution(definitionReference(v1.definition)),
    ).rejects.toMatchObject({
      code: "RUNTIME_AGENT_STALE_REVISION",
    });
    await expect(agents.resolveForResume(definitionReference(v1.definition))).resolves.toEqual(v1);
    await expect(
      agents.retire(definitionReference(v1.definition), OPERATION_3),
    ).rejects.toMatchObject({
      code: "RUNTIME_AGENT_STALE_REVISION",
    });
    expect(await agents.list()).toEqual([]);
  });

  it("distinguishes an absent definition from a retained stale revision", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const v1 = bundle(1);
    await agents.publish(v1, OPERATION_1);
    await agents.retire(definitionReference(v1.definition), OPERATION_2);
    const missing = { ...definitionReference(v1.definition), revision: 99 };

    await expect(agents.resolveForResume(missing)).rejects.toMatchObject({
      code: "RUNTIME_AGENT_NOT_FOUND",
    });
    await expect(agents.resolveForExecution(missing)).rejects.toMatchObject({
      code: "RUNTIME_AGENT_NOT_FOUND",
    });
  });

  it("rejects reuse of an agent revision with different canonical bytes", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const v1 = bundle(1);
    await agents.publish(v1, OPERATION_1);
    const changedDefinition = definition(1, v1.prompt_template, "changed-name");

    await expect(
      agents.publish(
        { definition: changedDefinition, prompt_template: v1.prompt_template },
        OPERATION_2,
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_AGENT_DEFINITION_INVALID" });
    expect(await lines(entriesPath(statePath))).toHaveLength(1);
  });

  it("rejects reuse of a prompt revision with different canonical bytes", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    await agents.publish(bundle(1), OPERATION_1);
    const changedPrompt = prompt(1, "Changed instructions at the same revision.");
    const changedDefinition = definition(2, changedPrompt);

    await expect(
      agents.publish(
        { definition: changedDefinition, prompt_template: changedPrompt },
        OPERATION_2,
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_AGENT_DEFINITION_INVALID" });
    expect(await lines(entriesPath(statePath))).toHaveLength(1);
  });

  it("rejects a prompt that does not match the definition's exact template binding", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const v1 = bundle(1);
    const otherPrompt = prompt(2, "Different instructions.");

    await expect(
      agents.publish({ definition: v1.definition, prompt_template: otherPrompt }, OPERATION_1),
    ).rejects.toMatchObject({ code: "RUNTIME_AGENT_DEFINITION_INVALID" });
    expect(existsSync(entriesPath(statePath))).toBe(false);
  });

  it("returns body-free sorted registrations and deeply frozen domain values", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const first = bundle(1);
    const secondPromptCandidate = {
      ...prompt(1, "Review exactly."),
      template_id: "template-review",
      document_hash: ZERO_HASH,
    };
    const secondPrompt = {
      ...secondPromptCandidate,
      document_hash: hashPromptTemplate(secondPromptCandidate),
    };
    const secondDefinition = { ...definition(1, secondPrompt), agent_id: "agent-review" };
    const rehashedSecond = {
      ...secondDefinition,
      document_hash: hashAgentDefinition(secondDefinition),
    };
    await agents.publish(first, OPERATION_1);
    await agents.publish(
      { definition: rehashedSecond, prompt_template: secondPrompt },
      OPERATION_2,
    );

    const listed = await agents.list();
    const resolved = await agents.resolveForExecution(definitionReference(first.definition));

    expect(listed.map((item) => item.definition.artifact_id)).toEqual([
      "agent-implementation",
      "agent-review",
    ]);
    expect(JSON.stringify(listed)).not.toContain("instruction_blocks");
    expect(JSON.stringify(listed)).not.toContain("implementation-worker");
    expect(isDeepFrozen(listed)).toBe(true);
    expect(isDeepFrozen(resolved)).toBe(true);
  });

  it("stops mutation intake while preserving read access", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const v1 = bundle(1);
    const registration = await agents.publish(v1, OPERATION_1);

    agents.stopIntake();

    await expect(agents.publish(bundle(2), OPERATION_2)).rejects.toMatchObject({
      code: "RUNTIME_AGENT_NOT_FOUND",
    });
    await expect(
      agents.retire(definitionReference(v1.definition), OPERATION_3),
    ).rejects.toMatchObject({
      code: "RUNTIME_AGENT_NOT_FOUND",
    });
    await expect(agents.recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_NOT_FOUND",
    });
    await expect(agents.resolveForExecution(definitionReference(v1.definition))).resolves.toEqual(
      v1,
    );
    await expect(agents.list()).resolves.toEqual([registration]);
  });
});

describe("agent registry recovery and fail-closed history validation", () => {
  it("writes a canonical append-only lifecycle hash chain with exact semantic operation hashes", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const v1 = bundle(1);
    const v2 = bundle(2);
    await agents.publish(v1, OPERATION_1);
    await agents.publish(v2, OPERATION_2);
    await agents.retire(definitionReference(v2.definition), OPERATION_3);

    const rawLines = await lines(entriesPath(statePath));
    const entries = rawLines.map((line) => JSON.parse(line) as AgentRegistryEntryV1);

    expect(rawLines).toHaveLength(3);
    expect(rawLines).toEqual(entries.map((entry) => canonicalJson(entry)));
    expect(entries.map((entry) => entry.registry_revision)).toEqual([1, 2, 3]);
    expect(entries.map((entry) => entry.previous_entry_hash)).toEqual([
      null,
      entries[0]!.entry_hash,
      entries[1]!.entry_hash,
    ]);
    expect(entries.map((entry) => entry.operation_hash)).toEqual([
      publishOperationHash(v1),
      publishOperationHash(v2),
      retireOperationHash(definitionReference(v2.definition)),
    ]);
    await expect(registry(statePath).recover()).resolves.toBeUndefined();
  });

  it("quarantines only an exact partial final lifecycle fragment and publishes the valid prefix", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    await agents.publish(bundle(1), OPERATION_1);
    const prefix = await readFile(entriesPath(statePath));
    const fragment = Buffer.from('{"partial":', "utf8");
    await appendFile(entriesPath(statePath), fragment);

    await expect(registry(statePath).recover()).resolves.toBeUndefined();

    expect(await readFile(entriesPath(statePath))).toEqual(prefix);
    const artifacts = await readdir(path.join(statePath, "agents", "quarantine"));
    expect(artifacts).toHaveLength(1);
    expect(await readFile(path.join(statePath, "agents", "quarantine", artifacts[0]!))).toEqual(
      fragment,
    );
  });

  it("quarantines an exact partial final operation result without growing lifecycle state", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const v1 = bundle(1);
    await agents.publish(v1, OPERATION_1);
    await agents.publish(v1, OPERATION_2);
    const entryPrefix = await readFile(entriesPath(statePath));
    const operationPrefix = await readFile(operationsPath(statePath));
    const fragment = Buffer.from("{", "utf8");
    await appendFile(operationsPath(statePath), fragment);

    await expect(registry(statePath).recover()).resolves.toBeUndefined();

    expect(await readFile(entriesPath(statePath))).toEqual(entryPrefix);
    expect(await readFile(operationsPath(statePath))).toEqual(operationPrefix);
    await expect(registry(statePath).publish(v1, OPERATION_2)).resolves.toMatchObject({
      registry_revision: 1,
    });
  });

  it("preserves and rejects a partial first line and invalid complete interior content", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    await agents.recover();
    await writeFile(entriesPath(statePath), '{"partial":', { mode: 0o600 });
    const partial = await readFile(entriesPath(statePath));

    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
    expect(await readFile(entriesPath(statePath))).toEqual(partial);
    expect(await readdir(path.join(statePath, "agents", "quarantine"))).toEqual([]);

    await writeFile(entriesPath(statePath), '{"invalid":true}\n', { mode: 0o600 });
    const invalid = await readFile(entriesPath(statePath));
    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
    expect(await readFile(entriesPath(statePath))).toEqual(invalid);
  });

  it("rejects reordered history and a validly rehashed random operation hash", async () => {
    const firstFixture = await fixture();
    const firstRegistry = registry(firstFixture.statePath);
    await firstRegistry.publish(bundle(1), OPERATION_1);
    await firstRegistry.publish(bundle(2), OPERATION_2);
    const originalLines = await lines(entriesPath(firstFixture.statePath));
    await writeFile(
      entriesPath(firstFixture.statePath),
      `${[...originalLines].reverse().join("\n")}\n`,
      {
        mode: 0o600,
      },
    );

    await expect(registry(firstFixture.statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });

    const secondFixture = await fixture();
    await registry(secondFixture.statePath).publish(bundle(1), OPERATION_1);
    const entry = JSON.parse((await lines(entriesPath(secondFixture.statePath)))[0]!) as Record<
      string,
      unknown
    >;
    const corrupted = rehashEntry({ ...entry, operation_hash: `sha256:${"9".repeat(64)}` });
    await writeFile(entriesPath(secondFixture.statePath), `${canonicalJson(corrupted)}\n`, {
      mode: 0o600,
    });

    await expect(registry(secondFixture.statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
  });

  it("rejects a duplicate published revision and an ambiguous second lifecycle head", async () => {
    const firstFixture = await fixture();
    const agents = registry(firstFixture.statePath);
    const v1 = bundle(1);
    await agents.publish(v1, OPERATION_1);
    const first = JSON.parse(
      (await lines(entriesPath(firstFixture.statePath)))[0]!,
    ) as AgentRegistryEntryV1;
    const duplicate = rehashEntry({
      ...first,
      registry_revision: 2,
      previous_entry_hash: first.entry_hash,
      operation_id: OPERATION_2,
    });
    await appendFile(entriesPath(firstFixture.statePath), `${canonicalJson(duplicate)}\n`);

    await expect(registry(firstFixture.statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });

    const secondFixture = await fixture();
    await registry(secondFixture.statePath).publish(bundle(1), OPERATION_1);
    await writeFile(
      path.join(registryDirectory(secondFixture.statePath), "entries-copy.jsonl"),
      await readFile(entriesPath(secondFixture.statePath)),
      { mode: 0o600 },
    );
    await expect(registry(secondFixture.statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
  });

  it("rejects a quarantine candidate without an exact canonical artifact name", async () => {
    const { statePath } = await fixture();
    await registry(statePath).recover();
    await writeFile(
      path.join(statePath, "agents", "quarantine", `agent-registry-${"-".repeat(36)}.bin`),
      "candidate",
      { mode: 0o600 },
    );

    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
  });

  it("rejects an unrecognized object-store candidate without deleting it", async () => {
    const { statePath } = await fixture();
    await registry(statePath).recover();
    const candidate = path.join(statePath, "agents", "objects", ".unexpected");
    await writeFile(candidate, "preserve", { mode: 0o600 });

    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
    expect(await readFile(candidate, "utf8")).toBe("preserve");
  });

  it("bounded-reads every orphan object and rejects a hash-to-name mismatch", async () => {
    const { statePath } = await fixture();
    await registry(statePath).recover();
    const candidate = path.join(statePath, "agents", "objects", "a".repeat(64));
    await writeFile(candidate, "garbage", { mode: 0o600 });

    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
    expect(await readFile(candidate, "utf8")).toBe("garbage");
  });

  it("rejects a hash-correct orphan outside the recognized canonical object grammar", async () => {
    const { statePath } = await fixture();
    await registry(statePath).recover();
    const bytes = Buffer.from(canonicalJson({ document_type: "unrecognized" }), "utf8");
    const candidate = objectPath(statePath, rawSha256(bytes));
    await writeFile(candidate, bytes, { mode: 0o600 });

    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
    expect(await readFile(candidate)).toEqual(bytes);
  });

  it.each(["prompt", "definition"] as const)(
    "accepts a hash-correct canonical orphan %s left before lifecycle publication",
    async (kind) => {
      const { statePath } = await fixture();
      await registry(statePath).recover();
      const orphan = kind === "prompt" ? prompt(1) : definition(1, prompt(1));
      const { document_hash: hash, ...hashable } = orphan;
      const bytes = Buffer.from(canonicalJson(hashable), "utf8");
      expect(rawSha256(bytes)).toBe(hash);
      await writeFile(objectPath(statePath, hash), bytes, { mode: 0o600 });

      await expect(registry(statePath).recover()).resolves.toBeUndefined();
    },
  );

  it("rejects an operation result that is not bound to an exact durable lifecycle result", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const v1 = bundle(1);
    await agents.publish(v1, OPERATION_1);
    await agents.publish(v1, OPERATION_2);
    const record = JSON.parse((await lines(operationsPath(statePath)))[0]!) as Record<
      string,
      unknown
    >;
    const result = record.result as AgentRegistration;
    const hashable = {
      ...record,
      result: { ...result, registry_revision: result.registry_revision + 1 },
    };
    Reflect.deleteProperty(hashable, "operation_record_hash");
    const rebound = { ...hashable, operation_record_hash: sha256(hashable) };
    await writeFile(operationsPath(statePath), `${canonicalJson(rebound)}\n`, { mode: 0o600 });

    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
  });

  it("binds a no-op operation result to the exact lifecycle head", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const v1 = bundle(1);
    await agents.publish(v1, OPERATION_1);
    await agents.publish(v1, OPERATION_2);
    const firstEntry = JSON.parse(
      (await lines(entriesPath(statePath)))[0]!,
    ) as AgentRegistryEntryV1;
    const record = JSON.parse((await lines(operationsPath(statePath)))[0]!) as Record<
      string,
      unknown
    >;

    expect(record).toMatchObject({
      lifecycle_head_revision: 1,
      lifecycle_head_hash: firstEntry.entry_hash,
    });

    await agents.publish(bundle(2), OPERATION_3);
    const secondEntry = JSON.parse(
      (await lines(entriesPath(statePath)))[1]!,
    ) as AgentRegistryEntryV1;
    const rebound = {
      ...record,
      lifecycle_head_revision: secondEntry.registry_revision,
      lifecycle_head_hash: secondEntry.entry_hash,
    };
    Reflect.deleteProperty(rebound, "operation_record_hash");
    await writeFile(
      operationsPath(statePath),
      `${canonicalJson({ ...rebound, operation_record_hash: sha256(rebound) })}\n`,
      { mode: 0o600 },
    );

    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
  });

  it("rejects a canonical operation record containing an impossible retired result", async () => {
    const { statePath } = await fixture();
    const agents = registry(statePath);
    const v1 = bundle(1);
    await agents.publish(v1, OPERATION_1);
    await agents.retire(definitionReference(v1.definition), OPERATION_2);
    const retired = JSON.parse((await lines(entriesPath(statePath)))[1]!) as AgentRegistryEntryV1;
    const hashable = {
      schema_version: "agent-registry-operation.v1",
      document_type: "agent-registry-operation",
      operation_revision: 1,
      previous_operation_hash: null,
      operation_id: OPERATION_4,
      operation_hash: retireOperationHash(definitionReference(v1.definition)),
      lifecycle_head_revision: retired.registry_revision,
      lifecycle_head_hash: retired.entry_hash,
      result: registrationFromEntry(retired),
    };
    const impossible = { ...hashable, operation_record_hash: sha256(hashable) };
    await writeFile(operationsPath(statePath), `${canonicalJson(impossible)}\n`, { mode: 0o600 });

    await expect(registry(statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
  });

  it("fails closed when a referenced immutable object is missing or tampered", async () => {
    const missingFixture = await fixture();
    const missingBundle = bundle(1);
    await registry(missingFixture.statePath).publish(missingBundle, OPERATION_1);
    await rm(objectPath(missingFixture.statePath, missingBundle.definition.document_hash));
    await expect(registry(missingFixture.statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });

    const tamperedFixture = await fixture();
    const tamperedBundle = bundle(1);
    await registry(tamperedFixture.statePath).publish(tamperedBundle, OPERATION_1);
    const candidate = objectPath(
      tamperedFixture.statePath,
      tamperedBundle.prompt_template.document_hash,
    );
    await chmod(candidate, 0o600);
    await writeFile(candidate, "tampered", { mode: 0o600 });
    await expect(registry(tamperedFixture.statePath).recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
  });
});

describe("agent registry durability and coordination", () => {
  it.each(["file", "directory"] as const)(
    "replays after an initial %s sync failure",
    async (kind) => {
      const { statePath } = await fixture();
      let failed = false;
      const agents = registry(statePath, {
        operationHooks: {
          beforeHistoryFileSync: (history) => {
            if (kind === "file" && history === "lifecycle" && !failed) {
              failed = true;
              throw new Error("simulated file sync failure");
            }
          },
          beforeHistoryDirectorySync: () => {
            if (kind === "directory" && existsSync(entriesPath(statePath)) && !failed) {
              failed = true;
              throw new Error("simulated directory sync failure");
            }
          },
        },
      });

      await expect(agents.publish(bundle(1), OPERATION_1)).rejects.toMatchObject({
        code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
      });
      await expect(agents.publish(bundle(1), OPERATION_1)).resolves.toMatchObject({
        registry_revision: 1,
        state: "ACTIVE",
      });
      expect(await lines(entriesPath(statePath))).toHaveLength(1);
    },
  );

  it("serializes public instances through canonical real state-path aliases", async () => {
    const { root, statePath } = await fixture();
    await registry(statePath).recover();
    const alias = path.join(root, "state-alias");
    await symlink(statePath, alias, "dir");
    const v1 = bundle(1);

    const results = await Promise.all([
      registry(statePath).publish(v1, OPERATION_1),
      registry(alias).publish(v1, OPERATION_2),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(await lines(entriesPath(statePath))).toHaveLength(1);
    expect(await lines(operationsPath(statePath))).toHaveLength(1);
  });

  it.each(["state root", "registry directory"] as const)(
    "pins the original %s identity across later operations",
    async (kind) => {
      const { root, statePath } = await fixture();
      const agents = registry(statePath);
      const v1 = bundle(1);
      const registration = await agents.publish(v1, OPERATION_1);
      const candidate = kind === "state root" ? statePath : registryDirectory(statePath);
      const displaced = path.join(root, kind === "state root" ? "old-state" : "old-registry");
      renameSync(candidate, displaced);
      mkdirSync(candidate, { mode: 0o700 });

      try {
        await expect(agents.list()).rejects.toMatchObject({
          code: "RUNTIME_AGENT_PATH_UNSAFE",
        });
      } finally {
        await rm(candidate, { recursive: true, force: true });
        renameSync(displaced, candidate);
      }

      await expect(agents.list()).resolves.toEqual([registration]);
    },
  );

  it("fails closed when the state root is swapped during an object read", async () => {
    const { root, statePath } = await fixture();
    const displaced = path.join(root, "state-during-read");
    let swapped = false;
    const agents = registry(statePath, {
      privateStoreOperationHooks: {
        afterObjectOpen: () => {
          if (swapped) return Promise.resolve();
          swapped = true;
          renameSync(statePath, displaced);
          mkdirSync(statePath, { mode: 0o700 });
          return Promise.resolve();
        },
      },
    });
    const v1 = bundle(1);
    await agents.publish(v1, OPERATION_1);

    try {
      await expect(
        agents.resolveForResume(definitionReference(v1.definition)),
      ).rejects.toMatchObject({ code: "RUNTIME_AGENT_PATH_UNSAFE" });
    } finally {
      await rm(statePath, { recursive: true, force: true });
      renameSync(displaced, statePath);
    }
  });

  it("never makes lifecycle state visible through a root swapped after object barriers", async () => {
    const { root, statePath } = await fixture();
    const replacement = path.join(root, "prepared-state");
    const displaced = path.join(root, "state-after-objects");
    await registry(replacement).recover();
    let swapped = false;
    const agents = registry(statePath, {
      operationHooks: {
        afterObjectsPublished: () => {
          if (swapped) return Promise.resolve();
          swapped = true;
          renameSync(statePath, displaced);
          renameSync(replacement, statePath);
          return Promise.resolve();
        },
      },
    });

    try {
      await expect(agents.publish(bundle(1), OPERATION_1)).rejects.toMatchObject({
        code: "RUNTIME_AGENT_PATH_UNSAFE",
      });
      expect(existsSync(entriesPath(statePath))).toBe(false);
    } finally {
      await rm(statePath, { recursive: true, force: true });
      renameSync(displaced, statePath);
    }
  });

  it("rejects and preserves a history path replacement at the final append barrier", async () => {
    const { root, statePath } = await fixture();
    await registry(statePath).publish(bundle(1), OPERATION_1);
    const historyPath = entriesPath(statePath);
    const displaced = path.join(root, "displaced-entries.jsonl");
    let replaced = false;
    const agents = registry(statePath, {
      operationHooks: {
        beforeHistoryDirectorySync: (directoryPath) => {
          if (directoryPath !== registryDirectory(statePath) || replaced) return;
          replaced = true;
          renameSync(historyPath, displaced);
          writeFileSync(historyPath, "replacement", { mode: 0o600 });
        },
      },
    });

    await expect(agents.publish(bundle(2), OPERATION_2)).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
    expect(await readFile(historyPath, "utf8")).toBe("replacement");
    expect(await lines(displaced)).toHaveLength(2);
  });

  it.each([
    ["alive", "absent", false],
    ["unknown", "absent", false],
    ["dead", "present", false],
    ["dead", "unknown", false],
    ["dead", "absent", true],
  ] as const)(
    "recovers a claim only for owner=%s and listener=%s",
    async (ownerState, listenerState, recovered) => {
      const { statePath } = await fixture();
      await registry(statePath).recover();
      const claim = path.join(registryDirectory(statePath), "mutation.claim");
      await writeFile(claim, JSON.stringify({ pid: 987654 }), { mode: 0o700 });
      const agents = registry(statePath, {
        isProcessAlive: () => ownerState,
        hasServiceListener: () => Promise.resolve(listenerState),
      });

      if (recovered) {
        await expect(agents.recover()).resolves.toBeUndefined();
        expect(existsSync(claim)).toBe(false);
      } else {
        await expect(agents.recover()).rejects.toMatchObject({
          code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
        });
        expect(existsSync(claim)).toBe(true);
      }
    },
  );

  it("tracks an accepted mutation through stop and flush and bounds waiting by abort", async () => {
    const { statePath } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    const agents = registry(statePath, {
      operationHooks: {
        afterObjectsPublished: async () => {
          reached = true;
          await gate;
        },
      },
    });
    const accepted = agents.publish(bundle(1), OPERATION_1);
    while (!reached) await new Promise((resolve) => setImmediate(resolve));
    agents.stopIntake();
    const flush = agents.flush(new AbortController().signal);
    let flushed = false;
    void flush.then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(flushed).toBe(false);
    await expect(agents.publish(bundle(2), OPERATION_2)).rejects.toMatchObject({
      code: "RUNTIME_AGENT_NOT_FOUND",
    });

    const controller = new AbortController();
    const bounded = agents.flush(controller.signal);
    controller.abort();
    await expect(bounded).resolves.toBeUndefined();
    expect(flushed).toBe(false);

    release();
    await expect(accepted).resolves.toMatchObject({ state: "ACTIVE" });
    await expect(flush).resolves.toBeUndefined();
  });

  it("rejects post-stop recovery and flushes a recovery accepted before stop", async () => {
    const { statePath } = await fixture();
    let release!: () => void;
    let reached!: () => void;
    let firstClaim = true;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claimed = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const agents = registry(statePath, {
      privateStoreOperationHooks: {
        beforeClaimFileSync: async () => {
          if (!firstClaim) return;
          firstClaim = false;
          reached();
          await gate;
        },
      },
    });
    const accepted = agents.recover();
    await claimed;
    agents.stopIntake();
    const rejected = expect(agents.recover()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_NOT_FOUND",
    });
    const flush = agents.flush(new AbortController().signal);
    let flushed = false;
    void flush.then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(flushed).toBe(false);
    release();
    await expect(accepted).resolves.toBeUndefined();
    await rejected;
    await expect(flush).resolves.toBeUndefined();
  });
});
