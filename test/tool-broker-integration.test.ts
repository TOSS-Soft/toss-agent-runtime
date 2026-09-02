import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EffectiveAgentAuthority } from "../src/agents/authority.js";
import { defaultConfig } from "../src/config/load.js";
import type { RuntimeConfigV1 } from "../src/config/types.js";
import { ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import { createRunJournalStore, type RunJournalStore } from "../src/journal/store.js";
import type { JournalHead, RunState } from "../src/journal/types.js";
import { sha256 } from "../src/protocol/json.js";
import { createToolBroker, type ToolBroker } from "../src/tools/broker.js";
import { ToolTransportDispatchError } from "../src/tools/executor.js";
import { RuntimeToolError } from "../src/tools/errors.js";
import type {
  NativeToolCallRequest,
  NativeToolCallResult,
  ToolTransportAdapter,
} from "../src/tools/transports/types.js";
import type { McpProfileV1, McpServerBinding, McpTransportKind } from "../src/tools/types.js";
import { rehashMcpProfile, validMcpProfile, validToolResult } from "./support/tool-fixtures.js";

const roots: string[] = [];
const RUN_ID = "run-1";
const EXECUTION_HASH = `sha256:${"2".repeat(64)}` as const;
const TRACE = validToolResult().trace;

async function tempState(): Promise<string> {
  const root = await mkdtemp(path.join(await realpath("/tmp"), "toss-tool-broker-"));
  roots.push(root);
  return path.join(root, "state");
}

function journalClock() {
  let milliseconds = Date.parse("2026-09-01T10:00:00.000Z");
  return () => {
    const value = new Date(milliseconds);
    milliseconds += 1_000;
    return value;
  };
}

function ids() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

function command(nextState: RunState, head: JournalHead | null, index: number) {
  return {
    run_id: RUN_ID,
    expected_revision: head?.journal_revision ?? 0,
    expected_head_hash: head?.entry_hash ?? ZERO_JOURNAL_HASH,
    command_id: `seed-${index}`,
    operation_id: null,
    next_state: nextState,
    reason_code: `SEED_${nextState}`,
    trace: TRACE,
    metadata: {},
    side_effect: null,
  } as const;
}

async function runningJournal(statePath: string): Promise<RunJournalStore> {
  const store = createRunJournalStore({ statePath, now: journalClock(), randomId: ids() });
  let head: JournalHead | null = null;
  for (const [index, state] of (["CREATED", "ROUTED", "RUNNING"] as const).entries()) {
    head = (await store.transition(command(state, head, index + 1))).head;
  }
  return store;
}

function binding(transport: McpTransportKind): McpServerBinding {
  if (transport === "stdio") {
    return {
      transport,
      command: "/usr/bin/true",
      args: [],
      cwd: "/private/runtime",
      environment: {},
    };
  }
  if (transport === "streamable-http") {
    return {
      transport,
      endpoint: "http://127.0.0.1:4123/mcp",
      credential_reference: null,
    };
  }
  return { transport, gateway_profile: "test-gateway" };
}

function configured(profile: McpProfileV1, transport: McpTransportKind): RuntimeConfigV1 {
  const base = defaultConfig("darwin", "/Users/test");
  return {
    ...base,
    mcp_profiles: {
      [profile.profile_id]: {
        profile,
        servers: { github: binding(transport) },
      },
    },
  };
}

function authority(profile: McpProfileV1): EffectiveAgentAuthority {
  const rule = profile.servers[0]!.tools[0]!;
  return Object.freeze({
    definition: {
      document_type: "agent-definition",
      artifact_id: "worker-agent",
      revision: 1,
      hash: `sha256:${"b".repeat(64)}` as const,
    },
    role: "worker",
    task_contract: rule.task_contracts[0]!,
    logical_class: "balanced-code",
    model_capabilities: ["text", "tools"],
    superpowers_capabilities: [],
    mcp_profile: {
      document_type: "mcp-profile",
      artifact_id: profile.profile_id,
      revision: profile.revision,
      hash: profile.document_hash,
    },
    budget: {
      max_input_tokens: 1_000,
      max_output_tokens: 1_000,
      max_cost_microusd: 1_000,
      max_duration_ms: 60_000,
      max_turns: 4,
    },
    output_schema: {
      document_type: "output-schema",
      artifact_id: "result",
      revision: 1,
      hash: `sha256:${"c".repeat(64)}` as const,
    },
  });
}

interface AdapterOptions {
  readonly call_result?: NativeToolCallResult;
  readonly call_error?: Error;
  readonly connect_error?: Error;
}

function adapter(profile: McpProfileV1, kind: McpTransportKind, options: AdapterOptions = {}) {
  const calls: NativeToolCallRequest[] = [];
  const defaultResult: NativeToolCallResult = {
    content: [{ type: "text", text: "password=server-secret" }],
    structured_content: { count: 2 },
    is_error: false,
  };
  let changed: (() => void) | undefined;
  const value: ToolTransportAdapter = {
    kind,
    async connect(request) {
      await Promise.resolve();
      if (options.connect_error !== undefined) throw options.connect_error;
      changed = request.on_tools_changed;
      const name = `${kind}-server`;
      return Object.freeze({
        server: {
          name,
          version: "1.0.0",
          identity_hash: sha256({
            name,
            protocol_revision: request.protocol_revision,
            version: "1.0.0",
          }),
          protocol_revision: request.protocol_revision,
          transport: kind,
        },
        listTools: () =>
          Promise.resolve({
            tools: profile.servers[0]!.tools.map((tool) => ({
              name: tool.native_name,
              input_schema: tool.input_schema as Readonly<Record<string, never>>,
              output_schema: tool.output_schema as Readonly<Record<string, never>>,
              annotations: {
                read_only_hint: tool.operation_class === "read-only",
                destructive_hint: tool.operation_class === "irreversible",
                idempotent_hint: true,
                open_world_hint: false,
              },
            })),
            next_cursor: null,
          }),
        callTool(call: NativeToolCallRequest) {
          calls.push(call);
          if (options.call_error !== undefined) return Promise.reject(options.call_error);
          return Promise.resolve(options.call_result ?? defaultResult);
        },
        close: () => Promise.resolve(),
      });
    },
  };
  return { value: Object.freeze(value), calls, markChanged: () => changed?.() };
}

async function brokerFixture(options: {
  readonly transport?: McpTransportKind;
  readonly profile?: McpProfileV1;
  readonly adapter?: AdapterOptions;
}) {
  const statePath = await tempState();
  const journal = await runningJournal(statePath);
  const profile = options.profile ?? validMcpProfile();
  const transport = options.transport ?? "stdio";
  const fake = adapter(profile, transport, options.adapter);
  const broker = createToolBroker({
    config: configured(profile, transport),
    journal_store: journal,
    state_path: statePath,
    platform: { os: "darwin", arch: "arm64", node: "24.8.0" },
    now: () => new Date("2026-09-01T10:00:30.000Z"),
    create_session_id: () => "session-1",
    create_adapters: () => ({ github: fake.value }),
    is_process_alive: () => "dead",
    has_service_listener: () => Promise.resolve("absent"),
  });
  await broker.recover();
  return { broker, journal, profile, fake };
}

async function opened(fixture: Awaited<ReturnType<typeof brokerFixture>>) {
  const handle = await fixture.broker.openSession({
    run_id: RUN_ID,
    execution_request_hash: EXECUTION_HASH,
    authority: authority(fixture.profile),
    trace: TRACE,
    signal: new AbortController().signal,
  });
  const view = await fixture.broker.discover({
    run_id: RUN_ID,
    session_id: handle.session_id,
    signal: new AbortController().signal,
  });
  return { handle, view };
}

async function invoke(
  broker: ToolBroker,
  sessionId: string,
  head: JournalHead,
  operationId = "tool-operation-1",
) {
  return await broker.invoke({
    run_id: RUN_ID,
    session_id: sessionId,
    expected_journal_head: head,
    alias: "repo.search",
    arguments: { query: "runtime" },
    logical_call_id: "model-call-1",
    operation_id: operationId,
    trace: TRACE,
    signal: new AbortController().signal,
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.sequential("scoped MCP tool broker integration", () => {
  it.each(["stdio", "streamable-http", "agentgateway"] as const)(
    "runs and exactly replays one read-only %s call",
    async (transport) => {
      const fixture = await brokerFixture({ transport });
      expect(fixture.broker.capabilities().features.mcp).toBe("blocked");
      const { handle, view } = await opened(fixture);

      expect(view.tools.map((tool) => tool.name)).toEqual(["repo.search"]);
      expect(fixture.broker.capabilities()).toMatchObject({
        features: { mcp: "available" },
        mcp_transports: [transport],
        mcp_profiles: [handle.profile],
      });
      expect(fixture.broker.health()).toEqual([
        { profile: handle.profile, status: "ready", findings: [] },
      ]);

      const initial = await fixture.journal.load(RUN_ID);
      if (initial === null) throw new Error("missing journal");
      const first = await invoke(fixture.broker, handle.session_id, initial.head);
      if (first.state !== "RUNNING") throw new Error("expected running outcome");
      const replay = await invoke(fixture.broker, handle.session_id, first.journal_head);

      expect(first.result).toMatchObject({
        trust: "untrusted-content",
        content: [{ type: "text", text: "password=[REDACTED]" }],
      });
      expect(Object.isFrozen(first.result)).toBe(true);
      expect(replay).toMatchObject({ state: "RUNNING", replayed: true });
      expect(fixture.fake.calls).toHaveLength(1);
    },
  );

  it("requires a durable exact approval before a reversible write", async () => {
    const base = validMcpProfile();
    const tool = base.servers[0]!.tools[0]!;
    const profile = rehashMcpProfile({
      ...base,
      profile_id: "engineering-write",
      servers: [
        {
          ...base.servers[0]!,
          tools: [
            {
              ...tool,
              operation_class: "reversible-write" as const,
              approval: "required" as const,
            },
          ],
        },
      ],
    });
    const fixture = await brokerFixture({ profile });
    const { handle } = await opened(fixture);
    const initial = await fixture.journal.load(RUN_ID);
    if (initial === null) throw new Error("missing journal");

    const pending = await invoke(fixture.broker, handle.session_id, initial.head);
    if (pending.state !== "APPROVAL_PENDING") throw new Error("expected approval");
    expect(fixture.fake.calls).toHaveLength(0);

    const approved = await fixture.broker.resumeApproval({
      run_id: RUN_ID,
      expected_journal_head: pending.journal_head,
      call_id: pending.call.call_id,
      approval_request_hash: pending.approval.document_hash,
      operation_id: "10000000-0000-4000-8000-000000000001",
      decision: "APPROVE",
      trace: TRACE,
      signal: new AbortController().signal,
    });

    expect(approved).toMatchObject({ state: "RUNNING", replayed: false });
    expect(fixture.fake.calls).toHaveLength(1);
  });

  it("returns a stable FAILED outcome for a proven-unsent authentication failure", async () => {
    const fixture = await brokerFixture({
      adapter: {
        call_error: new ToolTransportDispatchError(
          "NOT_SENT",
          new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION"),
        ),
      },
    });
    const { handle } = await opened(fixture);
    const initial = await fixture.journal.load(RUN_ID);
    if (initial === null) throw new Error("missing journal");

    await expect(invoke(fixture.broker, handle.session_id, initial.head)).resolves.toMatchObject({
      state: "FAILED",
      error: { code: "RUNTIME_TOOL_AUTHENTICATION" },
    });
  });

  it("blocks an uncertain malicious result without retrying it", async () => {
    const fixture = await brokerFixture({
      adapter: {
        call_result: {
          content: [{ type: "text", text: "token=raw-secret" }],
          structured_content: { count: -1 },
          is_error: false,
        },
      },
    });
    const { handle } = await opened(fixture);
    const initial = await fixture.journal.load(RUN_ID);
    if (initial === null) throw new Error("missing journal");

    const blocked = await invoke(fixture.broker, handle.session_id, initial.head);
    expect(blocked).toMatchObject({
      state: "BLOCKED",
      error: { code: "RUNTIME_TOOL_EFFECT_UNCERTAIN" },
    });
    await fixture.broker.recover();
    expect(fixture.fake.calls).toHaveLength(1);
    expect((await fixture.journal.load(RUN_ID))?.state).toBe("BLOCKED");
  });

  it("fails unavailable discovery safely and does not advertise the profile", async () => {
    const fixture = await brokerFixture({
      adapter: { connect_error: new Error("raw endpoint and credential detail") },
    });
    const handle = await fixture.broker.openSession({
      run_id: RUN_ID,
      execution_request_hash: EXECUTION_HASH,
      authority: authority(fixture.profile),
      trace: TRACE,
      signal: new AbortController().signal,
    });

    await expect(
      fixture.broker.discover({
        run_id: RUN_ID,
        session_id: handle.session_id,
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE"));
    expect(fixture.broker.capabilities()).toMatchObject({
      features: { mcp: "blocked" },
      mcp_profiles: [],
      mcp_transports: [],
    });
    expect(JSON.stringify(fixture.broker.health())).not.toContain("raw endpoint");
  });

  it("rejects a stale discovery snapshot before native execution", async () => {
    const fixture = await brokerFixture({});
    const { handle } = await opened(fixture);
    fixture.fake.markChanged();
    const initial = await fixture.journal.load(RUN_ID);
    if (initial === null) throw new Error("missing journal");

    await expect(invoke(fixture.broker, handle.session_id, initial.head)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_POLICY_DENIED",
    });
    expect(fixture.fake.calls).toHaveLength(0);
  });

  it("rejects a stale journal head inside the durable execution barrier", async () => {
    const fixture = await brokerFixture({});
    const { handle } = await opened(fixture);
    const initial = await fixture.journal.load(RUN_ID);
    if (initial === null) throw new Error("missing journal");
    const staleHead = {
      ...initial.head,
      entry_hash: `sha256:${"f".repeat(64)}` as const,
    };

    await expect(invoke(fixture.broker, handle.session_id, staleHead)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_OPERATION_CONFLICT",
    });
    expect(fixture.fake.calls).toHaveLength(0);
  });
});
