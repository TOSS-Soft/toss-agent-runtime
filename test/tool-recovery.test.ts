import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import { createRunJournalStore, type RunJournalStore } from "../src/journal/store.js";
import type { JournalHead, RunState } from "../src/journal/types.js";
import { sha256 } from "../src/protocol/json.js";
import {
  createToolRecoveryParticipant,
  disposeUncertain,
  recoverToolCalls,
} from "../src/tools/broker.js";
import {
  createToolExecutor,
  ToolTransportDispatchError,
  type ToolExecutorFaultHooks,
} from "../src/tools/executor.js";
import { RuntimeToolError } from "../src/tools/errors.js";
import type { AuthorizedToolCall } from "../src/tools/policy.js";
import { createToolPrivateStore, type ToolPrivateStore } from "../src/tools/private-store.js";
import type {
  NativeToolCallRequest,
  ToolTransportConnection,
} from "../src/tools/transports/types.js";
import { validMcpProfile, validToolCall, validToolResult } from "./support/tool-fixtures.js";

const roots: string[] = [];
const RUN_ID = "run-1";
const CALL_ID = "tool-call-1";
const IDEMPOTENCY_KEY = `sha256:${"1".repeat(64)}` as const;
const SERVER_IDENTITY_HASH = sha256({
  name: "github-mcp",
  protocol_revision: "2025-06-18",
  version: "1.2.3",
});

async function fixture(): Promise<{ readonly statePath: string }> {
  const root = await mkdtemp(path.join(await realpath("/tmp"), "toss-tool-recovery-"));
  roots.push(root);
  return { statePath: path.join(root, "state") };
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
    trace: validToolResult().trace,
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

function authorized(): AuthorizedToolCall {
  const stored = validToolCall();
  const profile = validMcpProfile();
  const rule = profile.servers[0]!.tools[0]!;
  const result = validToolResult();
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
    trusted_meta: {
      toss: {
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
      },
    },
  });
}

function connection(error?: Error) {
  const calls: NativeToolCallRequest[] = [];
  const value: ToolTransportConnection = {
    server: {
      name: "github-mcp",
      version: "1.2.3",
      identity_hash: SERVER_IDENTITY_HASH,
      protocol_revision: "2025-06-18",
      transport: "agentgateway",
    },
    listTools: () => Promise.reject(new Error("not used")),
    callTool(request) {
      calls.push(request);
      if (error !== undefined) return Promise.reject(error);
      return Promise.resolve({
        content: [{ type: "text", text: "2 repositories" }],
        structured_content: { count: 2 },
        is_error: false,
      });
    },
    close: () => Promise.resolve(),
  };
  return { value: Object.freeze(value), calls };
}

async function executionFixture(hooks?: ToolExecutorFaultHooks, transport = connection()) {
  const { statePath } = await fixture();
  const journal = await runningJournal(statePath);
  const tools = createToolPrivateStore({
    state_path: statePath,
    is_process_alive: () => "alive",
    has_service_listener: () => Promise.resolve("absent"),
    now: () => new Date("2026-09-01T10:00:30.000Z"),
  });
  const executor = createToolExecutor({
    journal_store: journal,
    tool_store: tools,
    now: () => new Date("2026-09-01T10:00:30.000Z"),
    fault_hooks: hooks,
  });
  return { journal, tools, transport, executor };
}

async function invoke(execution: Awaited<ReturnType<typeof executionFixture>>) {
  return await execution.executor.invoke({
    call: authorized(),
    operation_id: "tool-operation-1",
    approval_request_hash: null,
    connection: execution.transport.value,
    signal: new AbortController().signal,
  });
}

async function makeUncertain() {
  const execution = await executionFixture({
    after_intent: () => {
      throw new Error("crash:after-intent");
    },
  });
  await expect(invoke(execution)).rejects.toThrow("crash:after-intent");
  await recoverToolCalls({
    journal_store: execution.journal,
    tool_store: execution.tools,
    now: () => new Date("2026-09-01T10:00:40.000Z"),
  });
  const snapshot = await execution.journal.load(RUN_ID);
  if (snapshot === null) throw new Error("missing test journal");
  return { ...execution, snapshot };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.sequential("tool recovery broker", () => {
  it("finishes a persisted result on startup without redispatch", async () => {
    const execution = await executionFixture({
      after_result_published: () => {
        throw new Error("crash:after-result");
      },
    });
    await expect(invoke(execution)).rejects.toThrow("crash:after-result");

    const outcome = await recoverToolCalls({
      journal_store: execution.journal,
      tool_store: execution.tools,
      now: () => new Date("2026-09-01T10:00:40.000Z"),
    });

    expect(outcome).toMatchObject({ completed: 1, failed: 0, uncertain: 0 });
    expect(execution.transport.calls).toHaveLength(1);
    expect((await execution.journal.load(RUN_ID))?.state).toBe("RUNNING");
    expect(await execution.journal.unresolvedSideEffects(RUN_ID)).toEqual([]);
    expect(await execution.tools.latestCall(RUN_ID, CALL_ID)).toMatchObject({
      stage: "COMPLETED",
      dispatch_state: "RESULT_RECEIVED",
    });
  });

  it("conservatively blocks an unresolved intent and never retries it", async () => {
    const execution = await executionFixture({
      before_dispatch: () => {
        throw new Error("crash:before-dispatch");
      },
    });
    await expect(invoke(execution)).rejects.toThrow("crash:before-dispatch");

    const outcome = await recoverToolCalls({
      journal_store: execution.journal,
      tool_store: execution.tools,
      now: () => new Date("2026-09-01T10:00:40.000Z"),
    });

    expect(outcome.uncertain).toBe(1);
    expect(execution.transport.calls).toHaveLength(0);
    expect((await execution.journal.load(RUN_ID))?.state).toBe("BLOCKED");
    expect(await execution.journal.unresolvedSideEffects(RUN_ID)).toHaveLength(1);
    expect(await execution.tools.latestCall(RUN_ID, CALL_ID)).toMatchObject({
      stage: "UNCERTAIN",
      dispatch_state: "MAYBE_SENT",
    });
  });

  it("leaves a prepared call with no journal intent available for safe retry", async () => {
    const execution = await executionFixture({
      after_prepared: () => {
        throw new Error("crash:after-prepared");
      },
    });
    await expect(invoke(execution)).rejects.toThrow("crash:after-prepared");

    const outcome = await recoverToolCalls({
      journal_store: execution.journal,
      tool_store: execution.tools,
      now: () => new Date("2026-09-01T10:00:40.000Z"),
    });

    expect(outcome).toMatchObject({ completed: 0, failed: 0, uncertain: 0, untouched: 1 });
    expect((await execution.journal.load(RUN_ID))?.state).toBe("RUNNING");
    expect(await execution.tools.latestCall(RUN_ID, CALL_ID)).toMatchObject({
      stage: "PREPARED",
      dispatch_state: "NOT_SENT",
    });
  });

  it("quarantines an orphan result and never applies it to a journal", async () => {
    const execution = await executionFixture();

    await expect(execution.tools.publishResult(validToolResult())).rejects.toMatchObject({
      code: "RUNTIME_TOOL_OPERATION_CONFLICT",
    });
    await expect(execution.tools.recover()).resolves.toMatchObject({
      results: 0,
      quarantined: 1,
    });
    expect((await execution.journal.load(RUN_ID))?.state).toBe("RUNNING");
  });

  it("preserves approval-pending state without requiring a live client", async () => {
    const execution = await executionFixture();
    const running = await execution.journal.load(RUN_ID);
    if (running === null) throw new Error("missing test journal");
    await execution.journal.transition(command("APPROVAL_PENDING", running.head, 4));

    const outcome = await recoverToolCalls({
      journal_store: execution.journal,
      tool_store: execution.tools,
      now: () => new Date("2026-09-01T10:00:40.000Z"),
    });

    expect(outcome.untouched).toBe(1);
    expect((await execution.journal.load(RUN_ID))?.state).toBe("APPROVAL_PENDING");
  });

  it("closes a persisted proven-unsent failure after restart", async () => {
    const transport = connection(
      new ToolTransportDispatchError(
        "NOT_SENT",
        new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION"),
      ),
    );
    const execution = await executionFixture(
      {
        after_call_failed: () => {
          throw new Error("crash:after-call-failed");
        },
      },
      transport,
    );
    await expect(invoke(execution)).rejects.toThrow("crash:after-call-failed");

    const outcome = await recoverToolCalls({
      journal_store: execution.journal,
      tool_store: execution.tools,
      now: () => new Date("2026-09-01T10:00:40.000Z"),
    });

    expect(outcome.failed).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect((await execution.journal.load(RUN_ID))?.state).toBe("FAILED");
    expect(await execution.journal.unresolvedSideEffects(RUN_ID)).toEqual([]);
  });

  it("resumes only after NO_EFFECT_CONFIRMED and replays the same disposition", async () => {
    const execution = await makeUncertain();
    const input = {
      journal_store: execution.journal,
      tool_store: execution.tools,
      now: () => new Date("2026-09-01T10:00:50.000Z"),
      operation_id: "10000000-0000-4000-8000-000000000001",
      run_id: RUN_ID,
      expected_journal_head: execution.snapshot.head,
      call_id: CALL_ID,
      idempotency_key: IDEMPOTENCY_KEY,
      disposition: "NO_EFFECT_CONFIRMED" as const,
      trace: validToolResult().trace,
    };

    const first = await disposeUncertain(input);
    const replay = await disposeUncertain(input);

    expect(first).toMatchObject({ state: "RUNNING", replayed: false });
    expect(replay).toMatchObject({
      state: "RUNNING",
      replayed: true,
      operation_hash: first.operation_hash,
      journal_head: first.journal_head,
    });
    expect(await execution.journal.unresolvedSideEffects(RUN_ID)).toEqual([]);
    expect(execution.transport.calls).toHaveLength(0);
    await expect(
      disposeUncertain({ ...input, disposition: "EFFECT_CONFIRMED" }),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_OPERATION_CONFLICT" });
    await expect(
      disposeUncertain({
        ...input,
        operation_id: "10000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_OPERATION_CONFLICT" });
  });

  it("records EFFECT_CONFIRMED while keeping the run blocked and unresolved", async () => {
    const execution = await makeUncertain();
    const input = {
      journal_store: execution.journal,
      tool_store: execution.tools,
      now: () => new Date("2026-09-01T10:00:50.000Z"),
      operation_id: "10000000-0000-4000-8000-000000000002",
      run_id: RUN_ID,
      expected_journal_head: execution.snapshot.head,
      call_id: CALL_ID,
      idempotency_key: IDEMPOTENCY_KEY,
      disposition: "EFFECT_CONFIRMED" as const,
      trace: validToolResult().trace,
    };

    const first = await disposeUncertain(input);
    const replay = await disposeUncertain(input);

    expect(first).toMatchObject({ state: "BLOCKED", replayed: false });
    expect(replay).toMatchObject({ state: "BLOCKED", replayed: true });
    expect((await execution.journal.load(RUN_ID))?.head).toEqual(execution.snapshot.head);
    expect(await execution.journal.unresolvedSideEffects(RUN_ID)).toHaveLength(1);
    expect(execution.transport.calls).toHaveLength(0);
  });

  it("shuts down intake, reads, writes, recovery, connections, store, then journal", async () => {
    const execution = await executionFixture();
    const events: string[] = [];
    const wrappedStore: ToolPrivateStore = {
      ...execution.tools,
      async latestCalls() {
        events.push("classify");
        return await execution.tools.latestCalls();
      },
      stopIntake() {
        events.push("store:stop");
        execution.tools.stopIntake();
      },
      async flush() {
        events.push("store:flush");
        await execution.tools.flush();
      },
    };
    const participant = createToolRecoveryParticipant({
      journal_store: execution.journal,
      tool_store: wrappedStore,
      now: () => new Date("2026-09-01T10:00:40.000Z"),
      on_stop_intake: () => events.push("intake:stop"),
      cancel_discovery_and_reads: () => {
        events.push("reads:cancel");
        return Promise.resolve();
      },
      settle_write_results: () => {
        events.push("writes:settle");
        return Promise.resolve();
      },
      close_connections: () => {
        events.push("connections:close");
        return Promise.resolve();
      },
    });

    participant.stopIntake();
    await participant.flush(new AbortController().signal);
    events.push("journal:flush");

    expect(events).toEqual([
      "intake:stop",
      "reads:cancel",
      "writes:settle",
      "classify",
      "connections:close",
      "store:stop",
      "store:flush",
      "journal:flush",
    ]);
  });
});
