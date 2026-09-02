import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../src/protocol/json.js";
import { RuntimeToolError } from "../src/tools/errors.js";
import {
  createToolPrivateStore,
  type CreateToolPrivateStoreOptions,
  type ToolPrivateStoreOperationHooks,
  type ToolStoreOperationV1,
} from "../src/tools/private-store.js";
import type { ToolCallV1, ToolResultV1 } from "../src/tools/types.js";
import {
  validToolApprovalDecision,
  validToolApprovalRequest,
  validToolCall,
  validToolResult,
  withDocumentHash,
} from "./support/tool-fixtures.js";

const roots: string[] = [];

async function fixture(): Promise<{ readonly root: string; readonly statePath: string }> {
  const root = await mkdtemp(path.join(await realpath("/tmp"), "toss-tool-store-"));
  roots.push(root);
  return { root, statePath: path.join(root, "state") };
}

function options(
  statePath: string,
  overrides: Partial<CreateToolPrivateStoreOptions> = {},
): CreateToolPrivateStoreOptions {
  return {
    state_path: statePath,
    is_process_alive: () => "alive",
    has_service_listener: () => Promise.resolve("absent"),
    ...overrides,
  };
}

function toolPaths(statePath: string) {
  const tools = path.join(statePath, "tools");
  const agents = path.join(tools, "agents");
  return {
    tools,
    agents,
    objects: path.join(agents, "objects"),
    registry: path.join(agents, "registry"),
    quarantine: path.join(agents, "quarantine"),
    claim: path.join(agents, "registry", "mutation.claim"),
  };
}

function completedCall(result: ToolResultV1 = validToolResult()): ToolCallV1 {
  const prepared = validToolCall();
  return withDocumentHash({
    ...prepared,
    call_revision: 2,
    previous_call_hash: prepared.document_hash,
    stage: "COMPLETED" as const,
    dispatch_state: "RESULT_RECEIVED" as const,
    terminal_at: "2026-09-01T10:01:00.000Z",
    result_hash: result.document_hash,
  });
}

function operation(overrides: Partial<ToolStoreOperationV1> = {}): ToolStoreOperationV1 {
  const value = {
    schema_version: "tool-store-operation.v1" as const,
    operation_id: "tool-store-operation-1",
    operation_kind: "uncertain-disposition" as const,
    run_id: "run-1",
    call_id: "tool-call-1",
    request_hash: `sha256:${"4".repeat(64)}` as const,
    outcome_hash: `sha256:${"5".repeat(64)}` as const,
    occurred_at: "2026-09-01T10:02:00.000Z",
    ...overrides,
  };
  return Object.freeze({ ...value, record_hash: sha256(value) });
}

async function expectToolError(
  promise: Promise<unknown>,
  code:
    | "RUNTIME_TOOL_INTERNAL"
    | "RUNTIME_TOOL_INVALID"
    | "RUNTIME_TOOL_OPERATION_CONFLICT"
    | "RUNTIME_TOOL_UNAVAILABLE",
): Promise<void> {
  await expect(promise).rejects.toEqual(expect.objectContaining({ code }));
  await promise.catch((error: unknown) => {
    expect(error).toBeInstanceOf(RuntimeToolError);
    expect(String(error)).not.toContain("/tmp/");
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.sequential("private durable tool store", () => {
  it("creates current-user 0700 roots and one-link 0600 content objects", async () => {
    const { statePath } = await fixture();
    const store = createToolPrivateStore(options(statePath));
    await store.appendCall(validToolCall());
    const paths = toolPaths(statePath);

    for (const directory of [
      statePath,
      paths.tools,
      paths.agents,
      paths.objects,
      paths.registry,
      paths.quarantine,
    ]) {
      const metadata = await lstat(directory, { bigint: true });
      expect(metadata.isDirectory()).toBe(true);
      expect(Number(metadata.mode & 0o7777n)).toBe(0o700);
      if (typeof process.getuid === "function") expect(metadata.uid).toBe(BigInt(process.getuid()));
    }
    const names = await readdir(paths.objects);
    expect(names.length).toBeGreaterThanOrEqual(2);
    for (const name of names) {
      const metadata = await lstat(path.join(paths.objects, name), { bigint: true });
      expect(metadata.isFile()).toBe(true);
      expect(Number(metadata.mode & 0o7777n)).toBe(0o600);
      expect(metadata.nlink).toBe(1n);
      expect(metadata.dev).toBeTypeOf("bigint");
      expect(metadata.ino).toBeTypeOf("bigint");
    }
  });

  it("denies symlinked private roots and loose same-user ancestors without following them", async () => {
    const linked = await fixture();
    await mkdir(linked.statePath, { mode: 0o700 });
    const target = path.join(linked.root, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, toolPaths(linked.statePath).tools);
    await expectToolError(
      createToolPrivateStore(options(linked.statePath)).ensureRoots(),
      "RUNTIME_TOOL_INTERNAL",
    );

    const loose = await fixture();
    await chmod(loose.root, 0o777);
    await expectToolError(
      createToolPrivateStore(options(loose.statePath)).ensureRoots(),
      "RUNTIME_TOOL_INTERNAL",
    );
  });

  it("publishes calls append-only and replays an exact duplicate", async () => {
    const { statePath } = await fixture();
    const store = createToolPrivateStore(options(statePath));
    const prepared = validToolCall();

    await expect(store.appendCall(prepared)).resolves.toEqual(prepared);
    await expect(store.appendCall(prepared)).resolves.toEqual(prepared);
    expect(await store.callHistory(prepared.run_id, prepared.call_id)).toEqual([prepared]);

    const conflicting = withDocumentHash({
      ...prepared,
      logical_arguments: { query: "different" },
      logical_input_hash: sha256({ query: "different" }),
    });
    await expectToolError(store.appendCall(conflicting), "RUNTIME_TOOL_OPERATION_CONFLICT");
  });

  it("requires a contiguous immutable call chain and a published result before completion", async () => {
    const { statePath } = await fixture();
    const store = createToolPrivateStore(options(statePath));
    const prepared = validToolCall();
    const result = validToolResult();
    const completed = completedCall(result);
    await store.appendCall(prepared);

    await expectToolError(store.appendCall(completed), "RUNTIME_TOOL_OPERATION_CONFLICT");
    await store.publishResult(result);
    await expect(store.appendCall(completed)).resolves.toEqual(completed);
    await expect(store.latestCall(prepared.run_id, prepared.call_id)).resolves.toEqual(completed);

    const skipped = withDocumentHash({ ...completed, call_revision: 4 });
    await expectToolError(store.appendCall(skipped), "RUNTIME_TOOL_OPERATION_CONFLICT");
  });

  it("rejects secret-shaped prepared arguments before writing any object", async () => {
    const { statePath } = await fixture();
    const store = createToolPrivateStore(options(statePath));
    const prepared = validToolCall();
    const argumentsWithSecret = { query: "runtime", nested: { api_token: "must-not-persist" } };
    const secret = withDocumentHash({
      ...prepared,
      logical_arguments: argumentsWithSecret,
      logical_input_hash: sha256(argumentsWithSecret),
    });

    await expectToolError(store.appendCall(secret), "RUNTIME_TOOL_INVALID");
    await expect(lstat(toolPaths(statePath).objects)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes exact approvals and rejects conflicting operation IDs", async () => {
    const { statePath } = await fixture();
    const store = createToolPrivateStore(options(statePath));
    const prepared = withDocumentHash({
      ...validToolCall(),
      alias: "repo.create",
      native_name: "create_repository",
      operation_class: "reversible-write" as const,
    });
    const request = withDocumentHash({
      ...validToolApprovalRequest(),
      logical_input_hash: prepared.logical_input_hash,
    });
    const decision = withDocumentHash({
      ...validToolApprovalDecision(),
      approval_request_hash: request.document_hash,
    });
    await store.appendCall(prepared);

    await expect(store.publishApproval(request)).resolves.toEqual(request);
    await expect(store.publishApproval(decision)).resolves.toEqual(decision);
    await expect(store.approval(request.document_hash)).resolves.toEqual(request);

    const conflict = withDocumentHash({ ...decision, decision: "REJECT" as const });
    await expectToolError(store.publishApproval(conflict), "RUNTIME_TOOL_OPERATION_CONFLICT");
  });

  it("publishes a result exactly once and durably quarantines an orphan", async () => {
    const first = await fixture();
    const store = createToolPrivateStore(options(first.statePath));
    const prepared = validToolCall();
    const result = validToolResult();
    await store.appendCall(prepared);
    await expect(store.publishResult(result)).resolves.toEqual(result);
    await expect(store.publishResult(result)).resolves.toEqual(result);
    await expect(store.result(result.run_id, result.call_id)).resolves.toEqual(result);

    const orphanFixture = await fixture();
    const orphanStore = createToolPrivateStore(options(orphanFixture.statePath));
    await expectToolError(orphanStore.publishResult(result), "RUNTIME_TOOL_OPERATION_CONFLICT");
    const recovered = await createToolPrivateStore(options(orphanFixture.statePath)).recover();
    expect(recovered).toMatchObject({ results: 0, quarantined: 1 });
    await expect(orphanStore.result(result.run_id, result.call_id)).resolves.toBeNull();
  });

  it("never persists an unredacted native-looking result", async () => {
    const { statePath } = await fixture();
    const store = createToolPrivateStore(options(statePath));
    const base = validToolResult();
    const text = "api_token=must-not-persist";
    const unsafe = withDocumentHash({
      ...base,
      content: [{ type: "text" as const, text }],
      structured_content: null,
      accounting: {
        content_blocks: 1,
        total_bytes: Buffer.byteLength(text),
        structured_bytes: 0,
      },
    });
    await store.appendCall(validToolCall());

    await expectToolError(store.publishResult(unsafe), "RUNTIME_TOOL_INVALID");
    for (const name of await readdir(toolPaths(statePath).objects)) {
      const bytes = await readFile(path.join(toolPaths(statePath).objects, name));
      expect(bytes.includes(Buffer.from("must-not-persist"))).toBe(false);
    }
  });

  it("records a closed operation once and detects operation-ID conflicts", async () => {
    const { statePath } = await fixture();
    const store = createToolPrivateStore(options(statePath));
    await store.appendCall(validToolCall());
    const first = operation();
    await expect(store.recordOperation(first)).resolves.toEqual(first);
    await expect(store.recordOperation(first)).resolves.toEqual(first);
    await expect(store.operation(first.operation_id)).resolves.toEqual(first);

    const conflict = operation({ outcome_hash: `sha256:${"6".repeat(64)}` });
    await expectToolError(store.recordOperation(conflict), "RUNTIME_TOOL_OPERATION_CONFLICT");
  });

  it("serializes same-process mutation races and preserves one exact winner", async () => {
    const { statePath } = await fixture();
    const first = createToolPrivateStore(options(statePath));
    const second = createToolPrivateStore(options(statePath));
    const prepared = validToolCall();
    const conflict = withDocumentHash({
      ...prepared,
      operation_id: "tool-operation-conflict",
    });

    const settled = await Promise.allSettled([
      first.appendCall(prepared),
      second.appendCall(conflict),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    const recovered = await createToolPrivateStore(options(statePath)).latestCall(
      prepared.run_id,
      prepared.call_id,
    );
    expect([prepared.document_hash, conflict.document_hash]).toContain(recovered?.document_hash);
  });

  it("recovers only a dead writer with an absent authoritative listener", async () => {
    const live = await fixture();
    const liveStore = createToolPrivateStore(options(live.statePath));
    await liveStore.ensureRoots();
    await writeFile(toolPaths(live.statePath).claim, JSON.stringify({ pid: 12345 }), {
      mode: 0o700,
    });
    await expectToolError(liveStore.appendCall(validToolCall()), "RUNTIME_TOOL_INTERNAL");
    await expect(lstat(toolPaths(live.statePath).claim)).resolves.toBeDefined();

    const dead = await fixture();
    const deadStore = createToolPrivateStore(
      options(dead.statePath, {
        is_process_alive: () => "dead",
        has_service_listener: () => Promise.resolve("absent"),
      }),
    );
    await deadStore.ensureRoots();
    await writeFile(toolPaths(dead.statePath).claim, JSON.stringify({ pid: 12345 }), {
      mode: 0o700,
    });
    await expect(deadStore.appendCall(validToolCall())).resolves.toEqual(validToolCall());
    await expect(lstat(toolPaths(dead.statePath).claim)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("logically quarantines truncated or oversized content objects", async () => {
    const truncatedFixture = await fixture();
    const store = createToolPrivateStore(options(truncatedFixture.statePath));
    await store.appendCall(validToolCall());
    const objectNames = await readdir(toolPaths(truncatedFixture.statePath).objects);
    await truncate(path.join(toolPaths(truncatedFixture.statePath).objects, objectNames[0]!), 1);
    const truncated = await createToolPrivateStore(options(truncatedFixture.statePath)).recover();
    expect(truncated.quarantined).toBeGreaterThanOrEqual(1);

    const oversizedFixture = await fixture();
    const oversized = createToolPrivateStore(options(oversizedFixture.statePath));
    await oversized.ensureRoots();
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    const name = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(toolPaths(oversizedFixture.statePath).objects, name), bytes, {
      mode: 0o600,
    });
    await expect(oversized.recover()).resolves.toMatchObject({ quarantined: 1 });
  });

  it.each([
    "beforeFileSync",
    "afterFileSync",
    "beforeLinkPublication",
    "afterLinkPublication",
    "beforeParentSync",
    "afterParentSync",
  ] as const)("recovers to absent-or-exact after an injected %s crash", async (hook) => {
    const { statePath } = await fixture();
    let failed = false;
    const crash = (): Promise<void> => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error("injected crash"));
      }
      return Promise.resolve();
    };
    const hooks = { [hook]: crash } as ToolPrivateStoreOperationHooks;
    const failing = createToolPrivateStore(options(statePath, { operation_hooks: hooks }));
    await expectToolError(failing.appendCall(validToolCall()), "RUNTIME_TOOL_INTERNAL");

    const recovered = createToolPrivateStore(options(statePath));
    await recovered.recover();
    const call = await recovered.latestCall("run-1", "tool-call-1");
    expect(call === null || call.document_hash === validToolCall().document_hash).toBe(true);
  });

  it("stops intake atomically, permits reads, and flushes outstanding work", async () => {
    const { statePath } = await fixture();
    const store = createToolPrivateStore(options(statePath));
    const prepared = validToolCall();
    await store.appendCall(prepared);

    store.stopIntake();
    await expectToolError(store.appendCall(prepared), "RUNTIME_TOOL_UNAVAILABLE");
    await expect(store.latestCall(prepared.run_id, prepared.call_id)).resolves.toEqual(prepared);
    await expect(store.flush()).resolves.toBeUndefined();
  });

  it("supports a multi-megabyte normalized result through bounded chunks", async () => {
    const { statePath } = await fixture();
    const store = createToolPrivateStore(options(statePath));
    const prepared = validToolCall();
    const base = validToolResult();
    const texts = Array.from({ length: 3 }, () => "x".repeat(800 * 1024));
    const result = withDocumentHash({
      ...base,
      content: texts.map((text) => ({ type: "text" as const, text })),
      structured_content: null,
      accounting: {
        content_blocks: texts.length,
        total_bytes: texts.reduce((total, text) => total + Buffer.byteLength(text), 0),
        structured_bytes: 0,
      },
    });
    await store.appendCall(prepared);

    await expect(store.publishResult(result)).resolves.toEqual(result);
    await expect(store.result(result.run_id, result.call_id)).resolves.toEqual(result);
    expect((await readdir(toolPaths(statePath).objects)).length).toBeGreaterThan(3);
  });
});
