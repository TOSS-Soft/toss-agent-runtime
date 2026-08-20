import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRunJournalStore, type RunJournalStore } from "../src/journal/store.js";
import type { TransitionCommand } from "../src/journal/state-machine.js";
import type { JournalHead, RunState } from "../src/journal/types.js";
import { ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import { canonicalJson } from "../src/protocol/json.js";

const roots: string[] = [];
const TRACE = {
  trace_id: "1".repeat(32),
  span_id: "2".repeat(16),
  trace_flags: 1,
} as const;

async function fixture(): Promise<{ readonly root: string; readonly statePath: string }> {
  const root = await mkdtemp(path.join(await realpath("/tmp"), "toss-journal-recovery-"));
  roots.push(root);
  return { root, statePath: path.join(root, "state") };
}

function store(statePath: string): RunJournalStore {
  let id = 0;
  return createRunJournalStore({
    statePath,
    now: () => new Date("2026-08-20T12:00:00.000Z"),
    randomId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });
}

function command(runId: string, state: RunState, head: JournalHead | null): TransitionCommand {
  return {
    run_id: runId,
    expected_revision: head?.journal_revision ?? 0,
    expected_head_hash: head?.entry_hash ?? ZERO_JOURNAL_HASH,
    command_id: `${runId}-${state.toLowerCase()}-${head?.journal_revision ?? 0}`,
    operation_id: null,
    next_state: state,
    reason_code: `MOVE_${state}`,
    trace: TRACE,
    metadata: {},
    side_effect: null,
  };
}

async function running(journal: RunJournalStore, runId: string): Promise<JournalHead> {
  const created = await journal.transition(command(runId, "CREATED", null));
  const routed = await journal.transition(command(runId, "ROUTED", created.head));
  return (await journal.transition(command(runId, "RUNNING", routed.head))).head;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("run journal recovery", () => {
  it("quarantines an unpublished final fragment and restores the byte-identical prefix", async () => {
    const { statePath } = await fixture();
    const first = store(statePath);
    await running(first, "run-partial");
    const eventsPath = path.join(statePath, "journals", "run-partial", "events.jsonl");
    const prefix = await readFile(eventsPath);
    const partial = Buffer.from('{"schema_version":"run-journal', "utf8");
    await appendFile(eventsPath, partial);

    const recovered = store(statePath);
    await recovered.recover();

    expect(await readFile(eventsPath)).toEqual(prefix);
    expect((await recovered.load("run-partial"))?.state).toBe("RUNNING");
    const quarantinePath = path.join(statePath, "quarantine");
    const artifacts = await readdir(quarantinePath);
    expect(artifacts).toHaveLength(1);
    expect(await readFile(path.join(quarantinePath, artifacts[0]!))).toEqual(partial);
    expect((await lstat(path.join(quarantinePath, artifacts[0]!))).mode & 0o777).toBe(0o600);
  });

  it("blocks an invalid complete final line without truncating it", async () => {
    const { statePath } = await fixture();
    const first = store(statePath);
    await running(first, "run-corrupt");
    await running(first, "run-healthy");
    const eventsPath = path.join(statePath, "journals", "run-corrupt", "events.jsonl");
    await appendFile(eventsPath, '{"invalid":true}\n');
    const corruptedBytes = await readFile(eventsPath);

    const recovered = store(statePath);
    await recovered.recover();

    await expect(recovered.load("run-corrupt")).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_CORRUPT",
    });
    expect(await readFile(eventsPath)).toEqual(corruptedBytes);
    expect((await recovered.load("run-healthy"))?.state).toBe("RUNNING");
  });

  it("blocks a validly hashed entry whose interior previous hash is broken", async () => {
    const { statePath } = await fixture();
    const first = store(statePath);
    await running(first, "run-chain");
    const eventsPath = path.join(statePath, "journals", "run-chain", "events.jsonl");
    const lines = (await readFile(eventsPath, "utf8")).trimEnd().split("\n");
    const third = JSON.parse(lines[2]!) as Record<string, unknown>;
    delete third.entry_hash;
    third.previous_entry_hash = `sha256:${"f".repeat(64)}`;
    const digest = createHash("sha256").update(canonicalJson(third)).digest("hex");
    lines[2] = canonicalJson({ ...third, entry_hash: `sha256:${digest}` });
    const corrupted = `${lines.join("\n")}\n`;
    await writeFile(eventsPath, corrupted, { mode: 0o600 });

    const recovered = store(statePath);
    await recovered.recover();

    await expect(recovered.load("run-chain")).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_CORRUPT",
    });
    expect(await readFile(eventsPath, "utf8")).toBe(corrupted);
  });

  it("does not report success when journal synchronization fails", async () => {
    const { statePath } = await fixture();
    const failing = createRunJournalStore({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
      operationHooks: {
        beforeJournalSync: () => Promise.reject(new Error("simulated private sync failure")),
      },
    });

    await expect(failing.transition(command("run-sync", "CREATED", null))).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_UNAVAILABLE",
    });
  });
});
