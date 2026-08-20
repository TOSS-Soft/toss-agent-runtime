import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createJournalFilesystem, MAX_RUN_JOURNAL_BYTES } from "../src/journal/filesystem.js";
import { createRunJournalStore, type RunJournalStore } from "../src/journal/store.js";
import { decideRunTransition, type TransitionCommand } from "../src/journal/state-machine.js";
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

  it("blocks an empty published journal instead of treating the run as missing", async () => {
    const { statePath } = await fixture();
    const journal = store(statePath);
    await journal.transition(command("run-empty", "CREATED", null));
    const eventsPath = path.join(statePath, "journals", "run-empty", "events.jsonl");
    await truncate(eventsPath, 0);

    await expect(store(statePath).load("run-empty")).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_CORRUPT",
    });
    expect((await lstat(eventsPath)).size).toBe(0);
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

  it("rejects noncanonical raw bytes even when the embedded content hash is valid", async () => {
    const { statePath } = await fixture();
    const journal = store(statePath);
    await journal.transition(command("run-noncanonical", "CREATED", null));
    const eventsPath = path.join(statePath, "journals", "run-noncanonical", "events.jsonl");
    const value = JSON.parse(await readFile(eventsPath, "utf8")) as Record<string, unknown>;
    const noncanonical = ` ${JSON.stringify(value)}\n`;
    await writeFile(eventsPath, noncanonical, { mode: 0o600 });

    await expect(store(statePath).load("run-noncanonical")).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_CORRUPT",
    });
    expect(await readFile(eventsPath, "utf8")).toBe(noncanonical);
  });

  it("rejects invalid UTF-8 bytes instead of normalizing them before canonical comparison", async () => {
    const { statePath } = await fixture();
    const journal = store(statePath);
    await journal.transition({
      ...command("run-invalid-utf8", "CREATED", null),
      metadata: { note: "\uFFFD" },
    });
    const eventsPath = path.join(statePath, "journals", "run-invalid-utf8", "events.jsonl");
    const canonical = await readFile(eventsPath);
    const encodedReplacement = Buffer.from("\uFFFD", "utf8");
    const offset = canonical.indexOf(encodedReplacement);
    if (offset < 0) throw new Error("fixture must contain a replacement character");
    const invalid = Buffer.concat([
      canonical.subarray(0, offset),
      Buffer.from([0xff]),
      canonical.subarray(offset + encodedReplacement.byteLength),
    ]);
    await writeFile(eventsPath, invalid, { mode: 0o600 });

    await expect(store(statePath).load("run-invalid-utf8")).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_CORRUPT",
    });
    expect(await readFile(eventsPath)).toEqual(invalid);
  });

  it("does not report success when journal synchronization fails", async () => {
    const { statePath } = await fixture();
    const failing = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
      operationHooks: {
        beforeJournalSync: () => Promise.reject(new Error("simulated private sync failure")),
      },
    });

    await expect(failing.create("run-sync", Buffer.from("{}\n", "utf8"))).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_UNAVAILABLE",
    });
  });

  it("does not publish when the new run directory parent cannot be synchronized", async () => {
    const { statePath } = await fixture();
    const runId = "run-parent-directory-sync";
    const runPath = path.join(statePath, "journals", runId);
    const journalsPath = path.dirname(runPath);
    const filesystem = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
      operationHooks: {
        beforeDirectoryCreationSync: (directoryPath, parentPath) =>
          directoryPath === runPath && parentPath === journalsPath
            ? Promise.reject(new Error("simulated parent directory sync failure"))
            : Promise.resolve(),
      },
    });

    await expect(
      filesystem.create(runId, Buffer.from("expected bytes\n", "utf8")),
    ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_UNAVAILABLE" });
    await expect(lstat(path.join(runPath, "events.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires a successful run-directory barrier before replaying a linked create", async () => {
    const { statePath } = await fixture();
    const runId = "run-create-directory-sync";
    const input = command(runId, "CREATED", null);
    const decision = decideRunTransition([], input, () => new Date("2026-08-20T12:00:00.000Z"));
    if (decision.kind !== "append") throw new Error("the first transition must append");
    const bytes = Buffer.from(`${canonicalJson(decision.entry)}\n`, "utf8");
    const runPath = path.join(statePath, "journals", runId);
    const failing = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
      operationHooks: {
        beforeDirectorySync: (directoryPath) =>
          directoryPath === runPath
            ? Promise.reject(new Error("simulated run directory sync failure"))
            : Promise.resolve(),
      },
    });

    await expect(failing.create(runId, bytes)).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_UNAVAILABLE",
    });
    await expect(failing.read(runId)).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_UNAVAILABLE",
    });

    const replay = await store(statePath).transition(input);
    expect(replay.replayed).toBe(true);
    expect(replay.entry).toEqual(decision.entry);
  });

  it("rejects linked journal bytes changed during the create directory barrier", async () => {
    const { statePath } = await fixture();
    const runId = "run-create-directory-rewrite";
    const expected = Buffer.from("expected-bytes\n", "utf8");
    const replacement = Buffer.from("rewritten-byte\n", "utf8");
    const runPath = path.join(statePath, "journals", runId);
    const eventsPath = path.join(runPath, "events.jsonl");
    const filesystem = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
      operationHooks: {
        beforeDirectorySync: (directoryPath) =>
          directoryPath === runPath
            ? writeFile(eventsPath, replacement, { mode: 0o600 })
            : Promise.resolve(),
      },
    });

    await expect(filesystem.create(runId, expected)).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_PATH_UNSAFE",
    });
    expect(await readFile(eventsPath)).toEqual(replacement);
  });

  it("requires a successful run-directory barrier before replaying a recovery rename", async () => {
    const { statePath } = await fixture();
    const runId = "run-recovery-directory-sync";
    const journal = store(statePath);
    await journal.transition(command(runId, "CREATED", null));
    const eventsPath = path.join(statePath, "journals", runId, "events.jsonl");
    const validPrefix = await readFile(eventsPath);
    const fragment = Buffer.from('{"partial":', "utf8");
    await appendFile(eventsPath, fragment);
    const runPath = path.dirname(eventsPath);
    const normal = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
    });
    const snapshot = await normal.read(runId);
    if (snapshot === null) throw new Error("the partial journal must exist");
    const failing = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000002",
      operationHooks: {
        beforeDirectorySync: (directoryPath) =>
          directoryPath === runPath
            ? Promise.reject(new Error("simulated recovery directory sync failure"))
            : Promise.resolve(),
      },
    });

    await expect(
      failing.recoverPartial(runId, snapshot.identity, validPrefix, fragment),
    ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_UNAVAILABLE" });
    await expect(failing.read(runId)).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_UNAVAILABLE",
    });

    expect((await store(statePath).load(runId))?.state).toBe("CREATED");
    expect(await readFile(eventsPath)).toEqual(validPrefix);
  });

  it("rejects publication when an intermediate journal directory becomes a symlink", async () => {
    const { statePath } = await fixture();
    const journalsPath = path.join(statePath, "journals");
    const displacedPath = path.join(statePath, "journals-displaced");
    const filesystem = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
      operationHooks: {
        beforeJournalSync: async () => {
          await rename(journalsPath, displacedPath);
          await symlink(displacedPath, journalsPath, "dir");
        },
      },
    });

    await expect(
      filesystem.create("run-parent-symlink", Buffer.from("expected bytes\n", "utf8")),
    ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_PATH_UNSAFE" });
    await expect(
      lstat(path.join(displacedPath, "run-parent-symlink", "events.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects publication when a protected intermediate directory is not mode 0700", async () => {
    const { statePath } = await fixture();
    const journalsPath = path.join(statePath, "journals");
    const filesystem = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
      operationHooks: {
        beforeJournalSync: () => chmod(journalsPath, 0o755),
      },
    });

    await expect(
      filesystem.create("run-parent-mode", Buffer.from("expected bytes\n", "utf8")),
    ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_PATH_UNSAFE" });
    await expect(
      lstat(path.join(journalsPath, "run-parent-mode", "events.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects quarantine bytes changed during the directory durability barrier", async () => {
    const { statePath } = await fixture();
    const runId = "run-quarantine-directory-rewrite";
    const journal = store(statePath);
    await journal.transition(command(runId, "CREATED", null));
    const eventsPath = path.join(statePath, "journals", runId, "events.jsonl");
    const validPrefix = await readFile(eventsPath);
    const fragment = Buffer.from('{"partial":', "utf8");
    await appendFile(eventsPath, fragment);
    const quarantinePath = path.join(statePath, "quarantine");
    const normal = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
    });
    const snapshot = await normal.read(runId);
    if (snapshot === null) throw new Error("the partial journal must exist");
    const mutating = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000002",
      operationHooks: {
        beforeDirectorySync: async (directoryPath) => {
          if (directoryPath !== quarantinePath) return;
          const artifacts = await readdir(quarantinePath);
          if (artifacts.length !== 1) throw new Error("one quarantine artifact must exist");
          await writeFile(path.join(quarantinePath, artifacts[0]!), "evil", { mode: 0o600 });
        },
      },
    });

    await expect(
      mutating.recoverPartial(runId, snapshot.identity, validPrefix, fragment),
    ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_PATH_UNSAFE" });
    const artifacts = await readdir(quarantinePath);
    expect(artifacts).toHaveLength(1);
    expect(await readFile(path.join(quarantinePath, artifacts[0]!))).toEqual(
      Buffer.from("evil", "utf8"),
    );
    expect(await readFile(eventsPath)).toEqual(Buffer.concat([validPrefix, fragment]));
  });

  it("rejects a different journal inode installed during the recovery directory barrier", async () => {
    const { root, statePath } = await fixture();
    const runId = "run-recovery-directory-replacement";
    const journal = store(statePath);
    await journal.transition(command(runId, "CREATED", null));
    const eventsPath = path.join(statePath, "journals", runId, "events.jsonl");
    const runPath = path.dirname(eventsPath);
    const validPrefix = await readFile(eventsPath);
    const fragment = Buffer.from('{"partial":', "utf8");
    await appendFile(eventsPath, fragment);
    const normal = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
    });
    const snapshot = await normal.read(runId);
    if (snapshot === null) throw new Error("the partial journal must exist");
    const replacementPath = path.join(root, "replacement-journal");
    const displacedPath = path.join(root, "displaced-recovered-journal");
    await writeFile(replacementPath, validPrefix, { mode: 0o600 });
    let replaced = false;
    const mutating = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000002",
      operationHooks: {
        beforeDirectorySync: async (directoryPath) => {
          if (directoryPath !== runPath || replaced) return;
          await rename(eventsPath, displacedPath);
          await link(replacementPath, eventsPath);
          replaced = true;
        },
      },
    });

    await expect(
      mutating.recoverPartial(runId, snapshot.identity, validPrefix, fragment),
    ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_PATH_UNSAFE" });
    expect((await lstat(eventsPath)).ino).toBe((await lstat(replacementPath)).ino);
    expect(await readFile(eventsPath)).toEqual(validPrefix);
  });

  it("refuses to publish a create stage whose bytes changed before linking", async () => {
    const { statePath } = await fixture();
    const runPath = path.join(statePath, "journals", "run-stage-rewrite");
    const filesystem = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
      operationHooks: {
        beforeJournalSync: async () => {
          const stage = (await readdir(runPath)).find((entry) => entry.endsWith(".stage"));
          if (stage === undefined) throw new Error("create stage must exist");
          await writeFile(path.join(runPath, stage), "replacement bytes\n", { mode: 0o600 });
        },
      },
    });

    await expect(
      filesystem.create("run-stage-rewrite", Buffer.from("expected bytes\n", "utf8")),
    ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_PATH_UNSAFE" });
    await expect(lstat(path.join(runPath, "events.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not publish a replacement installed at the create-stage path", async () => {
    const { statePath } = await fixture();
    const runPath = path.join(statePath, "journals", "run-stage-replaced");
    let replacementPath = "";
    const filesystem = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
      operationHooks: {
        beforeJournalSync: async () => {
          const stage = (await readdir(runPath)).find((entry) => entry.endsWith(".stage"));
          if (stage === undefined) throw new Error("create stage must exist");
          replacementPath = path.join(runPath, stage);
          await rename(replacementPath, path.join(runPath, ".displaced-stage"));
          await writeFile(replacementPath, "untrusted replacement\n", { mode: 0o600 });
        },
      },
    });

    await expect(
      filesystem.create("run-stage-replaced", Buffer.from("expected bytes\n", "utf8")),
    ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_PATH_UNSAFE" });
    await expect(lstat(path.join(runPath, "events.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(replacementPath, "utf8")).toBe("untrusted replacement\n");
  });

  it("preserves a replacement installed at a crash-stage cleanup boundary", async () => {
    const { statePath } = await fixture();
    const journal = store(statePath);
    await journal.transition(command("run-stage-cleanup", "CREATED", null));
    const runPath = path.join(statePath, "journals", "run-stage-cleanup");
    const stagePath = path.join(
      runPath,
      ".events-recovery.00000000-0000-4000-8000-000000000001.stage",
    );
    const displacedPath = path.join(runPath, ".displaced-cleanup-stage");
    await writeFile(stagePath, "crash-left stage\n", { mode: 0o600 });
    const filesystem = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000002",
      operationHooks: {
        beforeStageCleanup: async () => {
          await rename(stagePath, displacedPath);
          await writeFile(stagePath, "replacement stage\n", { mode: 0o600 });
        },
      },
    });

    await expect(filesystem.read("run-stage-cleanup")).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_PATH_UNSAFE",
    });
    expect(await readFile(stagePath, "utf8")).toBe("replacement stage\n");
    expect(await readFile(displacedPath, "utf8")).toBe("crash-left stage\n");
  });

  it("does not overwrite same-inode bytes appended during partial-tail recovery", async () => {
    const { statePath } = await fixture();
    const journal = store(statePath);
    await journal.transition(command("run-recovery-race", "CREATED", null));
    const eventsPath = path.join(statePath, "journals", "run-recovery-race", "events.jsonl");
    const validPrefix = await readFile(eventsPath);
    const fragment = Buffer.from('{"partial":', "utf8");
    await appendFile(eventsPath, fragment);
    const filesystem = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
      operationHooks: {
        beforeRecoveryRename: () => appendFile(eventsPath, "concurrent bytes"),
      },
    });
    const snapshot = await filesystem.read("run-recovery-race");
    if (snapshot === null) throw new Error("journal must exist");

    await expect(
      filesystem.recoverPartial("run-recovery-race", snapshot.identity, validPrefix, fragment),
    ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_PATH_UNSAFE" });
    expect(await readFile(eventsPath)).toEqual(
      Buffer.concat([validPrefix, fragment, Buffer.from("concurrent bytes", "utf8")]),
    );
  });

  it("requires a successful durability barrier before replaying a sync-failed append", async () => {
    const { statePath } = await fixture();
    const journal = store(statePath);
    const created = await journal.transition(command("run-sync-retry", "CREATED", null));
    const input = command("run-sync-retry", "ROUTED", created.head);
    const loaded = await journal.load("run-sync-retry");
    if (loaded === null) throw new Error("created journal must load");
    const decision = decideRunTransition(loaded.entries, input, () => new Date());
    if (decision.kind !== "append") throw new Error("route must append");

    const normalFilesystem = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
    });
    const snapshot = await normalFilesystem.read("run-sync-retry");
    if (snapshot === null) throw new Error("created journal file must exist");
    const failingFilesystem = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000002",
      operationHooks: {
        beforeJournalSync: () => Promise.reject(new Error("simulated sync failure")),
      },
    });
    const line = Buffer.from(`${canonicalJson(decision.entry)}\n`, "utf8");

    await expect(failingFilesystem.append("run-sync-retry", snapshot, line)).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_UNAVAILABLE",
    });
    await expect(failingFilesystem.read("run-sync-retry")).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_UNAVAILABLE",
    });

    const replay = await store(statePath).transition(input);
    expect(replay.replayed).toBe(true);
    expect(replay.entry.state).toBe("ROUTED");
  });

  it("rejects a same-length rewrite that occurs while a journal read is synchronizing", async () => {
    const { statePath } = await fixture();
    const normal = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
    });
    const original = Buffer.from("alpha\n", "utf8");
    const replacement = Buffer.from("bravo\n", "utf8");
    await normal.create("run-read-rewrite", original);
    const eventsPath = path.join(statePath, "journals", "run-read-rewrite", "events.jsonl");
    const mutating = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000002",
      operationHooks: {
        beforeJournalSync: () => writeFile(eventsPath, replacement, { mode: 0o600 }),
      },
    });

    await expect(mutating.read("run-read-rewrite")).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_PATH_UNSAFE",
    });
    expect(await readFile(eventsPath)).toEqual(replacement);
  });

  it("accepts the exact journal byte limit and rejects one-byte overflow without growth", async () => {
    const { statePath } = await fixture();
    const filesystem = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: idsForLimit(),
    });
    const appended = Buffer.from("next line\n", "utf8");

    await filesystem.create("run-limit-exact", Buffer.from("first\n", "utf8"));
    const exactPath = path.join(statePath, "journals", "run-limit-exact", "events.jsonl");
    await truncate(exactPath, MAX_RUN_JOURNAL_BYTES - appended.byteLength);
    const exact = await filesystem.read("run-limit-exact");
    if (exact === null) throw new Error("exact-limit journal must exist");
    await filesystem.append("run-limit-exact", exact, appended);
    expect((await lstat(exactPath)).size).toBe(MAX_RUN_JOURNAL_BYTES);

    await filesystem.create("run-limit-overflow", Buffer.from("first\n", "utf8"));
    const overflowPath = path.join(statePath, "journals", "run-limit-overflow", "events.jsonl");
    const overflowSize = MAX_RUN_JOURNAL_BYTES - appended.byteLength + 1;
    await truncate(overflowPath, overflowSize);
    const overflow = await filesystem.read("run-limit-overflow");
    if (overflow === null) throw new Error("overflow journal must exist");
    await expect(filesystem.append("run-limit-overflow", overflow, appended)).rejects.toMatchObject(
      { code: "RUNTIME_JOURNAL_UNAVAILABLE" },
    );
    expect((await lstat(overflowPath)).size).toBe(overflowSize);
  });

  it("rejects an oversized initial journal before creating a run directory", async () => {
    const { statePath } = await fixture();
    const filesystem = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
    });
    const runPath = path.join(statePath, "journals", "run-create-overflow");

    await expect(
      filesystem.create("run-create-overflow", Buffer.alloc(MAX_RUN_JOURNAL_BYTES + 1)),
    ).rejects.toMatchObject({ code: "RUNTIME_JOURNAL_UNAVAILABLE" });
    await expect(lstat(runPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not append after the held journal changes at the final write boundary", async () => {
    const { statePath } = await fixture();
    const normal = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
    });
    const initial = Buffer.from("first line\n", "utf8");
    const mutation = Buffer.from("competing line\n", "utf8");
    const successor = Buffer.from("next line\n", "utf8");
    await normal.create("run-append-race", initial);
    const eventsPath = path.join(statePath, "journals", "run-append-race", "events.jsonl");
    const snapshot = await normal.read("run-append-race");
    if (snapshot === null) throw new Error("journal must exist");
    const mutating = createJournalFilesystem({
      statePath,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000002",
      operationHooks: {
        beforeAppendWrite: () => appendFile(eventsPath, mutation),
      },
    });

    await expect(mutating.append("run-append-race", snapshot, successor)).rejects.toMatchObject({
      code: "RUNTIME_JOURNAL_PATH_UNSAFE",
    });
    expect(await readFile(eventsPath)).toEqual(Buffer.concat([initial, mutation]));
  });
});

function idsForLimit(): () => string {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}
