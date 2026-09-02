import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import { createRunJournalStore, type RunJournalStore } from "../src/journal/store.js";
import type { JournalHead, RunState } from "../src/journal/types.js";
import { sha256 } from "../src/protocol/json.js";
import {
  createToolExecutor,
  ToolTransportDispatchError,
  type ToolExecutorFaultHooks,
} from "../src/tools/executor.js";
import { RuntimeToolError } from "../src/tools/errors.js";
import type { AuthorizedToolCall } from "../src/tools/policy.js";
import { createToolPrivateStore } from "../src/tools/private-store.js";
import type {
  NativeToolCallRequest,
  NativeToolCallResult,
  ToolTransportConnection,
} from "../src/tools/transports/types.js";
import { validMcpProfile, validToolCall, validToolResult } from "./support/tool-fixtures.js";

const roots: string[] = [];
const RUN_ID = "run-1";
const SERVER_IDENTITY_HASH = sha256({
  name: "github-mcp",
  protocol_revision: "2025-06-18",
  version: "1.2.3",
});

async function fixture(): Promise<{ readonly root: string; readonly statePath: string }> {
  const root = await mkdtemp(path.join(await realpath("/tmp"), "toss-tool-executor-"));
  roots.push(root);
  return { root, statePath: path.join(root, "state") };
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

function command(nextState: RunState, head: JournalHead | null, index: number, runId = RUN_ID) {
  return {
    run_id: runId,
    expected_revision: head?.journal_revision ?? 0,
    expected_head_hash: head?.entry_hash ?? ZERO_JOURNAL_HASH,
    command_id: `seed-${index}`,
    operation_id: null,
    next_state: nextState,
    reason_code: `SEED_${nextState}`,
    trace: {
      trace_id: "1".repeat(32),
      span_id: "2".repeat(16),
      trace_flags: 1,
    },
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

function authorized(overrides: Partial<AuthorizedToolCall> = {}): AuthorizedToolCall {
  const stored = validToolCall();
  const profile = validMcpProfile();
  const rule = profile.servers[0]!.tools[0]!;
  const result = validToolResult();
  const toss = {
    run_id: stored.run_id,
    execution_request_hash: stored.execution_request_hash,
    agent_definition_hash: stored.agent_definition.hash,
    task_contract_hash: stored.task_contract.hash,
    role: stored.role,
    mcp_profile_hash: stored.profile.hash,
    discovery_snapshot_hash: stored.discovery_snapshot_hash,
    server_id: stored.server_id,
    tool_alias: stored.alias,
    native_tool_name: stored.native_name,
    call_id: stored.call_id,
    idempotency_key: stored.idempotency_key,
    trace: result.trace,
  } as const;
  return Object.freeze({
    run_id: stored.run_id,
    execution_request_hash: stored.execution_request_hash,
    agent_definition: stored.agent_definition,
    task_contract: stored.task_contract,
    role: stored.role,
    profile: stored.profile,
    discovery_snapshot_hash: stored.discovery_snapshot_hash,
    session_id: stored.session_id,
    server_id: stored.server_id,
    server_identity_hash: SERVER_IDENTITY_HASH,
    transport: stored.transport,
    protocol_revision: stored.protocol_revision,
    alias: stored.alias,
    native_name: stored.native_name,
    input_schema: rule.input_schema,
    input_schema_hash: stored.input_schema_hash,
    output_schema: rule.output_schema,
    output_schema_hash: stored.output_schema_hash,
    operation_class: stored.operation_class,
    approval: "not-required",
    approval_required: false,
    content_kinds: ["text"] as const,
    sensitive_output_pointers: [] as const,
    logical_call_id: stored.logical_call_id,
    logical_arguments: stored.logical_arguments,
    logical_input_hash: stored.logical_input_hash,
    call_id: stored.call_id,
    idempotency_key: stored.idempotency_key,
    timeout_ms: 30_000,
    result_limits: {
      result_bytes: 524_288,
      content_blocks: 32,
      content_block_bytes: 131_072,
      structured_output_bytes: 131_072,
    },
    trace: result.trace,
    trusted_meta: { toss },
    ...overrides,
  });
}

interface ConnectionFixture {
  readonly result?: NativeToolCallResult;
  readonly error?: Error;
  readonly before_call?: () => void;
}

function connection(fixture: ConnectionFixture = {}) {
  const calls: NativeToolCallRequest[] = [];
  const call: ToolTransportConnection = {
    server: {
      name: "github-mcp",
      version: "1.2.3",
      identity_hash: SERVER_IDENTITY_HASH,
      protocol_revision: "2025-06-18",
      transport: "agentgateway",
    },
    listTools: () => Promise.reject(new Error("not used")),
    callTool(request) {
      fixture.before_call?.();
      calls.push(request);
      if (fixture.error !== undefined) return Promise.reject(fixture.error);
      return Promise.resolve(
        fixture.result ?? {
          content: [{ type: "text", text: "2 repositories" }],
          structured_content: { count: 2 },
          is_error: false,
        },
      );
    },
    close: () => Promise.resolve(),
  };
  return { value: Object.freeze(call), calls };
}

async function executionFixture(
  options: {
    readonly hooks?: ToolExecutorFaultHooks;
    readonly connection?: ReturnType<typeof connection>;
  } = {},
) {
  const { statePath } = await fixture();
  const journal = await runningJournal(statePath);
  const tools = createToolPrivateStore({
    state_path: statePath,
    is_process_alive: () => "alive",
    has_service_listener: () => Promise.resolve("absent"),
    now: () => new Date("2026-09-01T10:00:30.000Z"),
  });
  const transport = options.connection ?? connection();
  const executor = createToolExecutor({
    journal_store: journal,
    tool_store: tools,
    now: () => new Date("2026-09-01T10:00:30.000Z"),
    fault_hooks: options.hooks,
  });
  return { statePath, journal, tools, transport, executor };
}

function invoke(fixture: Awaited<ReturnType<typeof executionFixture>>, call = authorized()) {
  return fixture.executor.invoke({
    call,
    operation_id: "tool-operation-1",
    approval_request_hash: null,
    connection: fixture.transport.value,
    signal: new AbortController().signal,
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.sequential("durable one-dispatch tool executor", () => {
  it("persists intent before one dispatch and completes store before journal", async () => {
    const events: string[] = [];
    let intentPersisted = false;
    const transport = connection({
      before_call: () => {
        expect(intentPersisted).toBe(true);
        events.push("transport:call");
      },
    });
    const fixture = await executionFixture({
      connection: transport,
      hooks: {
        after_prepared: () => events.push("store:PREPARED"),
        after_intent: () => {
          intentPersisted = true;
          events.push("journal:TOOL_PENDING:INTENT");
        },
        after_result_published: () => events.push("store:result"),
        after_call_completed: () => events.push("store:COMPLETED"),
        after_journal_completed: () => events.push("journal:RUNNING:COMPLETED"),
      },
    });

    const result = await invoke(fixture);

    expect(events).toEqual([
      "store:PREPARED",
      "journal:TOOL_PENDING:INTENT",
      "transport:call",
      "store:result",
      "store:COMPLETED",
      "journal:RUNNING:COMPLETED",
    ]);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toEqual({
      name: "search_repositories",
      arguments: { query: "runtime" },
      trusted_meta: authorized().trusted_meta,
    });
    expect(result).toMatchObject({ status: "success", trust: "untrusted-content" });
    expect((await fixture.journal.load(RUN_ID))?.state).toBe("RUNNING");
    expect(await fixture.journal.unresolvedSideEffects(RUN_ID)).toEqual([]);
    expect(await fixture.tools.latestCall(RUN_ID, "tool-call-1")).toMatchObject({
      stage: "COMPLETED",
      dispatch_state: "RESULT_RECEIVED",
      result_hash: result.document_hash,
    });
  });

  it("replays a completed exact call without redispatch", async () => {
    const fixture = await executionFixture();
    const first = await invoke(fixture);
    expect(fixture.transport.calls).toHaveLength(1);

    const replay = await invoke(fixture);

    expect(replay).toEqual(first);
    expect(fixture.transport.calls).toHaveLength(1);
  });

  it("finishes a persisted result after restart without redispatch", async () => {
    const fixture = await executionFixture({
      hooks: {
        after_result_published: () => {
          throw new Error("crash:after-result");
        },
      },
    });
    await expect(invoke(fixture)).rejects.toThrow("crash:after-result");
    expect(fixture.transport.calls).toHaveLength(1);

    const replacementTransport = connection();
    const executor = createToolExecutor({
      journal_store: fixture.journal,
      tool_store: fixture.tools,
      now: () => new Date("2026-09-01T10:00:30.000Z"),
    });
    const result = await executor.invoke({
      call: authorized(),
      operation_id: "tool-operation-1",
      approval_request_hash: null,
      connection: replacementTransport.value,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("success");
    expect(replacementTransport.calls).toHaveLength(0);
    expect((await fixture.journal.load(RUN_ID))?.state).toBe("RUNNING");
    expect(await fixture.tools.latestCall(RUN_ID, "tool-call-1")).toMatchObject({
      stage: "COMPLETED",
    });
  });

  it("rejects the same call identity with changed arguments before another intent", async () => {
    const fixture = await executionFixture();
    await invoke(fixture);
    const changedArguments = { query: "different" };
    const changed = authorized({
      logical_arguments: changedArguments,
      logical_input_hash: sha256(changedArguments),
    });

    await expect(invoke(fixture, changed)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_OPERATION_CONFLICT",
    });
    expect(fixture.transport.calls).toHaveLength(1);
  });

  it("closes a proven-unsent failure and reaches FAILED", async () => {
    const transport = connection({
      error: new ToolTransportDispatchError(
        "NOT_SENT",
        new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION"),
      ),
    });
    const fixture = await executionFixture({ connection: transport });

    await expect(invoke(fixture)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_AUTHENTICATION",
    });

    expect(transport.calls).toHaveLength(1);
    expect((await fixture.journal.load(RUN_ID))?.state).toBe("FAILED");
    expect(await fixture.journal.unresolvedSideEffects(RUN_ID)).toEqual([]);
    expect(await fixture.tools.latestCall(RUN_ID, "tool-call-1")).toMatchObject({
      stage: "FAILED",
      dispatch_state: "NOT_SENT",
      terminal_code: "RUNTIME_TOOL_AUTHENTICATION",
    });
    expect(await fixture.tools.result(RUN_ID, "tool-call-1")).toMatchObject({
      status: "error",
      error: { code: "RUNTIME_TOOL_AUTHENTICATION" },
    });
  });

  it.each([
    "RUNTIME_TOOL_AUTHENTICATION",
    "RUNTIME_TOOL_RATE_LIMIT",
    "RUNTIME_TOOL_TIMEOUT",
    "RUNTIME_TOOL_CANCELLED",
    "RUNTIME_TOOL_UNAVAILABLE",
  ] as const)("never retries an unproven %s dispatch failure", async (code) => {
    const transport = connection({ error: new RuntimeToolError(code) });
    const fixture = await executionFixture({ connection: transport });

    await expect(invoke(fixture)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_EFFECT_UNCERTAIN",
    });
    expect(transport.calls).toHaveLength(1);
    expect((await fixture.journal.load(RUN_ID))?.state).toBe("BLOCKED");
    expect(await fixture.journal.unresolvedSideEffects(RUN_ID)).toHaveLength(1);
    expect(await fixture.tools.latestCall(RUN_ID, "tool-call-1")).toMatchObject({
      stage: "UNCERTAIN",
      dispatch_state: "MAYBE_SENT",
      terminal_code: "RUNTIME_TOOL_EFFECT_UNCERTAIN",
    });
  });

  it("treats invalid post-dispatch output as uncertain and never persists it", async () => {
    const transport = connection({
      result: {
        content: [{ type: "text", text: "token=raw-server-secret" }],
        structured_content: { count: -1 },
        is_error: false,
      },
    });
    const fixture = await executionFixture({ connection: transport });

    await expect(invoke(fixture)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_EFFECT_UNCERTAIN",
    });
    expect(await fixture.tools.result(RUN_ID, "tool-call-1")).toBeNull();
    expect(transport.calls).toHaveLength(1);
  });

  it("returns a normalized native error while completing the side-effect ledger", async () => {
    const fixture = await executionFixture({
      connection: connection({
        result: {
          content: [{ type: "text", text: "password=server-secret" }],
          structured_content: null,
          is_error: true,
        },
      }),
    });

    const result = await invoke(fixture);

    expect(result).toMatchObject({
      status: "error",
      content: [{ type: "text", text: "password=[REDACTED]" }],
      error: { code: "RUNTIME_TOOL_INTERNAL" },
    });
    expect((await fixture.journal.load(RUN_ID))?.state).toBe("RUNNING");
    expect(await fixture.journal.unresolvedSideEffects(RUN_ID)).toEqual([]);
  });

  it.each([
    ["before_prepared", null, "RUNNING", 0],
    ["after_prepared", "PREPARED", "RUNNING", 0],
    ["before_intent", "PREPARED", "RUNNING", 0],
    ["after_intent", "PREPARED", "TOOL_PENDING", 0],
    ["before_dispatch", "PREPARED", "TOOL_PENDING", 0],
    ["after_native_result", "PREPARED", "TOOL_PENDING", 1],
    ["after_result_published", "PREPARED", "TOOL_PENDING", 1],
    ["after_call_completed", "COMPLETED", "TOOL_PENDING", 1],
    ["before_journal_completion", "COMPLETED", "TOOL_PENDING", 1],
  ] as const)(
    "leaves only durable exact state at crash hook %s",
    async (point, expectedStage, expectedJournal, calls) => {
      const hooks = {
        [point]: () => {
          throw new Error(`crash:${point}`);
        },
      } as ToolExecutorFaultHooks;
      const fixture = await executionFixture({ hooks });

      await expect(invoke(fixture)).rejects.toThrow(`crash:${point}`);

      const stored = await fixture.tools.latestCall(RUN_ID, "tool-call-1");
      expect(stored?.stage ?? null).toBe(expectedStage);
      expect((await fixture.journal.load(RUN_ID))?.state).toBe(expectedJournal);
      expect(fixture.transport.calls).toHaveLength(calls);
      if (point === "after_result_published") {
        await expect(fixture.tools.result(RUN_ID, "tool-call-1")).resolves.not.toBeNull();
      }
    },
  );

  it("requires explicit approval evidence for an approval-gated call", async () => {
    const fixture = await executionFixture();
    const gated = authorized({
      operation_class: "reversible-write",
      approval: "required",
      approval_required: true,
    });

    await expect(invoke(fixture, gated)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_APPROVAL_REQUIRED",
    });
    expect(fixture.transport.calls).toHaveLength(0);
    expect(await fixture.tools.latestCall(RUN_ID, "tool-call-1")).toBeNull();
  });

  it("keeps journal metadata free of raw arguments and native output", async () => {
    const fixture = await executionFixture();
    await invoke(fixture);

    const journal = await fixture.journal.load(RUN_ID);
    const metadata = JSON.stringify(journal?.entries.map((entry) => entry.metadata));
    expect(metadata).not.toContain("runtime");
    expect(metadata).not.toContain("2 repositories");
    expect(metadata).not.toContain("trusted_meta");
  });
});
