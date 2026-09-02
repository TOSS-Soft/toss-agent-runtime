import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import { createRunJournalStore, type RunJournalStore } from "../src/journal/store.js";
import type { JournalHead, RunState } from "../src/journal/types.js";
import { sha256 } from "../src/protocol/json.js";
import {
  requestToolApproval,
  resumeToolApproval,
  type ResumeToolApprovalInput,
} from "../src/tools/approval.js";
import type { ToolExecutor, ToolInvokeRequest } from "../src/tools/executor.js";
import type { AuthorizedToolCall } from "../src/tools/policy.js";
import { createToolPrivateStore } from "../src/tools/private-store.js";
import type { ToolTransportConnection } from "../src/tools/transports/types.js";
import type { McpDiscoverySnapshotV1, ToolResultV1 } from "../src/tools/types.js";
import {
  validMcpDiscoverySnapshot,
  validMcpProfile,
  validToolCall,
  validToolResult,
  withDocumentHash,
} from "./support/tool-fixtures.js";

const roots: string[] = [];
const RUN_ID = "run-1";
const APPROVAL_OPERATION_ID = "00000000-0000-4000-8000-000000000901";
const TRACE = validToolResult().trace;

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(await realpath("/tmp"), "toss-tool-approval-"));
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

function command(nextState: RunState, head: JournalHead | null, index: number, runId = RUN_ID) {
  return {
    run_id: runId,
    expected_revision: head?.journal_revision ?? 0,
    expected_head_hash: head?.entry_hash ?? ZERO_JOURNAL_HASH,
    command_id: `seed-${runId}-${index}`,
    operation_id: null,
    next_state: nextState,
    reason_code: `SEED_${nextState}`,
    trace: TRACE,
    metadata: {},
    side_effect: null,
  } as const;
}

async function runningJournal(statePath: string, runId = RUN_ID): Promise<RunJournalStore> {
  const store = createRunJournalStore({ statePath, now: journalClock(), randomId: ids() });
  let head: JournalHead | null = null;
  for (const [index, state] of (["CREATED", "ROUTED", "RUNNING"] as const).entries()) {
    head = (await store.transition(command(state, head, index + 1, runId))).head;
  }
  return store;
}

function writeSnapshot(overrides: Partial<McpDiscoverySnapshotV1> = {}): McpDiscoverySnapshotV1 {
  const base = validMcpDiscoverySnapshot();
  return withDocumentHash({
    ...base,
    servers: [
      {
        ...base.servers[0]!,
        tools: [
          {
            ...base.servers[0]!.tools[0]!,
            alias: "repo.create",
            native_name: "create_repository",
            operation_class: "reversible-write" as const,
          },
        ],
      },
    ],
    ...overrides,
  });
}

function authorized(
  snapshot = writeSnapshot(),
  overrides: Partial<AuthorizedToolCall> = {},
): AuthorizedToolCall {
  const stored = validToolCall();
  const profile = validMcpProfile();
  const rule = profile.servers[0]!.tools[0]!;
  const toss = {
    run_id: stored.run_id,
    execution_request_hash: stored.execution_request_hash,
    agent_definition_hash: stored.agent_definition.hash,
    task_contract_hash: stored.task_contract.hash,
    role: stored.role,
    mcp_profile_hash: stored.profile.hash,
    discovery_snapshot_hash: snapshot.document_hash,
    server_id: stored.server_id,
    tool_alias: "repo.create",
    native_tool_name: "create_repository",
    call_id: stored.call_id,
    idempotency_key: stored.idempotency_key,
    trace: TRACE,
  } as const;
  return Object.freeze({
    run_id: stored.run_id,
    execution_request_hash: stored.execution_request_hash,
    agent_definition: stored.agent_definition,
    task_contract: stored.task_contract,
    role: stored.role,
    profile: stored.profile,
    discovery_snapshot_hash: snapshot.document_hash,
    session_id: snapshot.session_id,
    server_id: stored.server_id,
    server_identity_hash: snapshot.servers[0]!.server.identity_hash,
    transport: stored.transport,
    protocol_revision: stored.protocol_revision,
    alias: "repo.create",
    native_name: "create_repository",
    input_schema: rule.input_schema,
    input_schema_hash: stored.input_schema_hash,
    output_schema: rule.output_schema,
    output_schema_hash: stored.output_schema_hash,
    operation_class: "reversible-write",
    approval: "required",
    approval_required: true,
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
    trace: TRACE,
    trusted_meta: { toss },
    ...overrides,
  });
}

function connection(): ToolTransportConnection {
  return Object.freeze({
    server: {
      name: "github-mcp",
      version: "1.2.3",
      identity_hash: writeSnapshot().servers[0]!.server.identity_hash,
      protocol_revision: "2025-06-18" as const,
      transport: "agentgateway" as const,
    },
    listTools: () => Promise.reject(new Error("not used")),
    callTool: () => Promise.reject(new Error("executor seam only")),
    close: () => Promise.resolve(),
  });
}

function fakeExecutor() {
  const calls: ToolInvokeRequest[] = [];
  const executor: ToolExecutor = {
    invoke(request) {
      calls.push(request);
      return Promise.resolve(validToolResult() as ToolResultV1);
    },
  };
  return { executor, calls };
}

async function approvalFixture() {
  const statePath = await fixture();
  const journal = await runningJournal(statePath);
  const tools = createToolPrivateStore({
    state_path: statePath,
    is_process_alive: () => "alive",
    has_service_listener: () => Promise.resolve("absent"),
    now: () => new Date("2026-09-01T10:01:00.000Z"),
  });
  const execution = fakeExecutor();
  return { statePath, journal, tools, ...execution };
}

async function requestApproval(
  fixture: Awaited<ReturnType<typeof approvalFixture>>,
  call = authorized(),
) {
  return await requestToolApproval({
    journal_store: fixture.journal,
    tool_store: fixture.tools,
    now: () => new Date("2026-09-01T10:01:00.000Z"),
    call,
    operation_id: "tool-operation-1",
  });
}

function resumeInput(
  fixture: Awaited<ReturnType<typeof approvalFixture>>,
  pending: Awaited<ReturnType<typeof requestApproval>>,
  overrides: Partial<ResumeToolApprovalInput> = {},
): ResumeToolApprovalInput {
  const snapshot = writeSnapshot();
  return {
    journal_store: fixture.journal,
    tool_store: fixture.tools,
    executor: fixture.executor,
    now: () => new Date("2026-09-01T10:02:00.000Z"),
    run_id: RUN_ID,
    expected_journal_head: pending.journal_head,
    call_id: pending.call.call_id,
    approval_request_hash: pending.approval.document_hash,
    operation_id: APPROVAL_OPERATION_ID,
    decision: "APPROVE",
    trace: TRACE,
    current_call: authorized(snapshot),
    discovery_snapshot: snapshot,
    connection: connection(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.sequential("tool approval lifecycle", () => {
  it("persists an exact prepared write and pauses before any execution", async () => {
    const fixture = await approvalFixture();

    const outcome = await requestApproval(fixture);

    expect(outcome.state).toBe("APPROVAL_PENDING");
    expect((await fixture.journal.load(RUN_ID))?.state).toBe("APPROVAL_PENDING");
    expect(fixture.calls).toHaveLength(0);
    expect(outcome.approval.summary).not.toContain("runtime");
    expect(Buffer.byteLength(outcome.approval.summary, "utf8")).toBeLessThanOrEqual(2_048);
    expect(await fixture.tools.latestCall(RUN_ID, "tool-call-1")).toMatchObject({
      stage: "PREPARED",
      approval_request_hash: outcome.approval.document_hash,
      logical_arguments: { query: "runtime" },
    });
    expect(await fixture.tools.approval(outcome.approval.document_hash)).toEqual(outcome.approval);
  });

  it("replays one exact pending request without another journal transition", async () => {
    const fixture = await approvalFixture();
    const first = await requestApproval(fixture);
    const entries = (await fixture.journal.load(RUN_ID))?.entries.length ?? 0;

    const replay = await requestApproval(fixture);

    expect(replay.approval).toEqual(first.approval);
    expect(replay.call).toEqual(first.call);
    expect(replay.replayed).toBe(true);
    expect((await fixture.journal.load(RUN_ID))?.entries).toHaveLength(entries);
  });

  it("pauses an irreversible call while allowing an explicit reversible waiver", async () => {
    const irreversibleFixture = await approvalFixture();
    const irreversible = authorized(writeSnapshot(), { operation_class: "irreversible" });
    await expect(requestApproval(irreversibleFixture, irreversible)).resolves.toMatchObject({
      state: "APPROVAL_PENDING",
    });

    const waivedFixture = await approvalFixture();
    const waived = authorized(writeSnapshot(), {
      approval: "not-required",
      approval_required: false,
    });
    await expect(requestApproval(waivedFixture, waived)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_POLICY_DENIED",
    });
    expect((await waivedFixture.journal.load(RUN_ID))?.state).toBe("RUNNING");
  });

  it("approves after restart, returns RUNNING, then invokes the durable executor", async () => {
    const fixture = await approvalFixture();
    const pending = await requestApproval(fixture);

    const outcome = await resumeToolApproval(resumeInput(fixture, pending));

    expect(outcome).toMatchObject({
      state: "RUNNING",
      replayed: false,
      approval: { kind: "DECISION", decision: "APPROVE" },
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({
      operation_id: "tool-operation-1",
      approval_request_hash: pending.approval.document_hash,
    });
  });

  it("rejects to BLOCKED without creating a side-effect intent", async () => {
    const fixture = await approvalFixture();
    const pending = await requestApproval(fixture);

    const outcome = await resumeToolApproval(resumeInput(fixture, pending, { decision: "REJECT" }));

    expect(outcome.state).toBe("BLOCKED");
    expect(fixture.calls).toHaveLength(0);
    expect((await fixture.journal.load(RUN_ID))?.state).toBe("BLOCKED");
    expect(await fixture.journal.unresolvedSideEffects(RUN_ID)).toEqual([]);
  });

  it("replays one exact decision and rejects a changed decision", async () => {
    const fixture = await approvalFixture();
    const pending = await requestApproval(fixture);
    const input = resumeInput(fixture, pending);
    const first = await resumeToolApproval(input);

    const replay = await resumeToolApproval(input);
    expect(replay.approval).toEqual(first.approval);
    expect(replay.replayed).toBe(true);
    expect(fixture.calls).toHaveLength(1);

    await expect(resumeToolApproval({ ...input, decision: "REJECT" })).rejects.toMatchObject({
      code: "RUNTIME_TOOL_OPERATION_CONFLICT",
    });
  });

  it("rejects a stale pending journal head", async () => {
    const fixture = await approvalFixture();
    const pending = await requestApproval(fixture);
    const stale = {
      ...pending.journal_head,
      entry_hash: `sha256:${"9".repeat(64)}` as const,
    };

    await expect(
      resumeToolApproval(resumeInput(fixture, pending, { expected_journal_head: stale })),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_APPROVAL_STALE" });
    expect(fixture.calls).toHaveLength(0);
  });

  it.each([
    ["stale", { stale: true }],
    ["expired", { expires_at: "2026-09-01T10:01:59.000Z" }],
  ] as const)("rejects a %s discovery snapshot on resume", async (_name, snapshotOverrides) => {
    const fixture = await approvalFixture();
    const pending = await requestApproval(fixture);
    const snapshot = writeSnapshot(snapshotOverrides);

    await expect(
      resumeToolApproval(
        resumeInput(fixture, pending, {
          discovery_snapshot: snapshot,
          current_call: authorized(snapshot),
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_APPROVAL_STALE" });
    expect(fixture.calls).toHaveLength(0);
  });

  it.each([
    [
      "input",
      { logical_arguments: { query: "changed" }, logical_input_hash: sha256({ query: "changed" }) },
    ],
    ["tool", { alias: "repo.delete" }],
    ["schema", { input_schema_hash: `sha256:${"8".repeat(64)}` as const }],
    [
      "profile",
      { profile: { ...validToolCall().profile, hash: `sha256:${"7".repeat(64)}` as const } },
    ],
    ["role", { role: "reviewer" as const }],
    ["run", { run_id: "run-other" }],
  ] as const)("rejects changed %s authority on resume", async (_name, callOverrides) => {
    const fixture = await approvalFixture();
    const pending = await requestApproval(fixture);
    const snapshot = writeSnapshot();

    await expect(
      resumeToolApproval(
        resumeInput(fixture, pending, {
          current_call: authorized(snapshot, callOverrides),
          discovery_snapshot: snapshot,
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_APPROVAL_STALE" });
    expect(fixture.calls).toHaveLength(0);
  });

  it("rejects cross-run request reuse and a conflicting operation identity", async () => {
    const fixture = await approvalFixture();
    const pending = await requestApproval(fixture);
    const input = resumeInput(fixture, pending);

    await expect(resumeToolApproval({ ...input, run_id: "run-other" })).rejects.toMatchObject({
      code: "RUNTIME_TOOL_APPROVAL_STALE",
    });

    await resumeToolApproval(input);
    await expect(
      resumeToolApproval({
        ...input,
        operation_id: "00000000-0000-4000-8000-000000000902",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_OPERATION_CONFLICT" });
  });

  it("fails closed when approval intake has stopped", async () => {
    const fixture = await approvalFixture();
    fixture.tools.stopIntake();

    await expect(requestApproval(fixture)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_UNAVAILABLE",
    });
    expect((await fixture.journal.load(RUN_ID))?.state).toBe("RUNNING");
  });
});
