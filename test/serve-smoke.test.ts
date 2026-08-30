import {
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
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { computeExecutableHash, createMainServices, runCli } from "../src/cli/main.js";
import { defaultConfig } from "../src/config/load.js";
import { ZERO_JOURNAL_HASH } from "../src/journal/entry.js";
import { createRunJournalStore } from "../src/journal/store.js";
import type { TransitionCommand } from "../src/journal/state-machine.js";
import type { JournalHead, RunState } from "../src/journal/types.js";
import {
  requestProjectOperation,
  requestSuperpowersApprovalDecision,
} from "../src/service/control.js";
import type { InstanceLock } from "../src/service/instance-lock.js";
import { runSupervisor } from "../src/service/supervisor.js";
import { createSkillsHost } from "../src/skills/index.js";
import { FakeSignals } from "./support/fake-signals.js";

const temporaryDirectories: string[] = [];
const TRACE = {
  trace_id: "1".repeat(32),
  span_id: "2".repeat(16),
  trace_flags: 1,
} as const;

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

async function transientSkillArtifacts(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { recursive: true }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  return entries.filter((entry) => /(?:\.stage|\.claim|\.lock|\.tombstone)(?:\.|$)/u.test(entry));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("serve command lifecycle integration", () => {
  it("changes executable identity when bytes change at the same paths and keeps read failures safe", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-runtime-identity-")));
    temporaryDirectories.push(root);
    const nodePath = path.join(root, "node");
    const cliPath = path.join(root, "cli.js");
    await writeFile(nodePath, "node-v1", { mode: 0o700 });
    await writeFile(cliPath, "cli-v1", { mode: 0o600 });

    const first = await computeExecutableHash({ nodePath, cliPath });
    await writeFile(cliPath, "cli-v2", { mode: 0o600 });
    const second = await computeExecutableHash({ nodePath, cliPath });

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).not.toBe(first);

    const missingPath = path.join(root, "private-missing-node");
    const error = await computeExecutableHash({ nodePath: missingPath, cliPath }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "RUNTIME_SERVICE_UNAVAILABLE" });
    expect(String(error)).not.toContain(missingPath);
    await rm(root, { recursive: true, force: true });
  });

  it("composes the production serve service with a real private supervisor", async () => {
    const root = await realpath(
      await mkdtemp(path.join(await realpath("/tmp"), "toss-runtime-main-")),
    );
    temporaryDirectories.push(root);
    await chmod(root, 0o700);
    const signals = new FakeSignals();
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const services = createMainServices({
      platform: { os: "darwin", arch: "arm64", node: "24.20.0" },
      env: {},
      home: root,
      signals,
      pid: process.pid,
      now: () => new Date("2026-08-19T12:00:00.000Z"),
      createServiceInstanceId: () => "018f0f64-7b21-7d4f-8c3d-4a30413d5f42",
      resolveExecutableHash: () => Promise.resolve("a".repeat(64)),
      sendReady: () => resolveReady?.(),
    });

    const running = services.serve?.({});
    await ready;
    const config = defaultConfig("darwin", root);
    const socket = await lstat(config.paths.socket);
    const ownerPath = path.join(path.dirname(config.paths.socket), "instance.lock", "owner.json");
    const lockOwner: unknown = JSON.parse(await readFile(ownerPath, "utf8"));

    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
    expect(lockOwner).toMatchObject({ executable_hash: "a".repeat(64) });
    expect(JSON.stringify(lockOwner)).not.toContain(process.execPath);
    expect((await lstat(path.join(config.paths.state, "skills", "phases"))).isDirectory()).toBe(
      true,
    );

    const journal = createRunJournalStore({
      statePath: config.paths.state,
      now: () => new Date("2026-08-19T12:00:01.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000101",
    });
    let head: JournalHead | null = null;
    for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
      head = (await journal.transition(journalCommand("run-production-skills", state, head))).head;
    }
    if (head === null) throw new Error("journal setup failed");
    const externalSkills = createSkillsHost({
      statePath: config.paths.state,
      configuredRoots: [],
      journal,
      now: () => new Date("2026-08-19T12:00:02.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000102",
      hasServiceListener: () => Promise.resolve("present"),
    });
    const selection = await externalSkills.select({
      mode: "implicit",
      capability: "brainstorming",
      allowed_capabilities: ["brainstorming"],
      query: null,
      descriptor: null,
    });
    const snapshot = await externalSkills.load(selection);
    const started = await externalSkills.startPhase({
      run_id: "run-production-skills",
      expected_journal_head: head,
      execution_request_hash: `sha256:${"e".repeat(64)}`,
      selection,
      phase: "BRAINSTORMING",
      input: Buffer.from("production brainstorming", "utf8"),
      operation_id: "production-brainstorming",
      trace: TRACE,
    });
    const pending = await externalSkills.completePhase({
      run_id: "run-production-skills",
      expected_phase_revision: started.phase.phase_revision,
      expected_phase_head_hash: started.phase.document_hash,
      phase: "BRAINSTORMING",
      skill_snapshot_hash: snapshot.document_hash,
      operation_id: started.phase.operation_id,
      outcome: "COMPLETED",
      output: Buffer.from("production plan", "utf8"),
      trace: TRACE,
    });
    if (pending.approval?.kind !== "REQUEST") throw new Error("approval request expected");
    const approvalControlRequest = {
      schema_version: "service-control-request.v1",
      document_type: "service-control-request",
      request_id: "00000000-0000-4000-8000-000000000103",
      command: "superpowers-approve",
      operation_id: "00000000-0000-4000-8000-000000000104",
      run_id: pending.approval.run_id,
      expected_journal_revision: pending.approval.pending_journal_head.journal_revision,
      expected_journal_head_hash: pending.approval.pending_journal_head.entry_hash,
      phase: pending.approval.phase,
      skill_name: pending.approval.skill_name,
      skill_version: pending.approval.skill_version,
      skill_snapshot_hash: pending.approval.skill_snapshot_hash,
      approval_request_hash: pending.approval.document_hash,
      decision: "APPROVE",
    } as const;
    await expect(
      requestSuperpowersApprovalDecision({
        socketPath: config.paths.socket,
        request: approvalControlRequest,
      }),
    ).resolves.toMatchObject({
      kind: "superpowers-approval",
      run_id: "run-production-skills",
      state: "RUNNING",
      approval_request_hash: pending.approval.document_hash,
    });
    await expect(
      requestSuperpowersApprovalDecision({
        socketPath: config.paths.socket,
        request: {
          ...approvalControlRequest,
          request_id: "00000000-0000-4000-8000-000000000105",
        },
      }),
    ).resolves.toMatchObject({
      run_id: "run-production-skills",
      state: "RUNNING",
      replayed: true,
    });

    const projectRoot = path.join(root, "project");
    await mkdir(path.join(projectRoot, ".toss"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(projectRoot, "src"), { mode: 0o700 });
    await writeFile(
      path.join(projectRoot, ".toss", "project.yaml"),
      "schema_version: project-watch-manifest.v1\nwatch_paths:\n  - src\n",
      { mode: 0o600 },
    );
    const sourcePath = path.join(projectRoot, "src", "main.ts");
    await writeFile(sourcePath, "first", { mode: 0o600 });
    const registered = await requestProjectOperation({
      socketPath: config.paths.socket,
      operation: { command: "project-register", root: projectRoot },
    });
    expect(registered).toMatchObject({
      kind: "project-registration",
      registration: { canonical_root: projectRoot, state: "ACTIVE" },
    });
    await writeFile(sourcePath, "second", { mode: 0o600 });
    const candidatesPath = path.join(config.paths.state, "projects", "intake", "candidates.jsonl");
    await vi.waitFor(
      async () => {
        const candidate = JSON.parse((await readFile(candidatesPath, "utf8")).trim()) as {
          readonly changes: readonly { readonly path: string }[];
        };
        expect(candidate.changes.map((change) => change.path)).toContain("src/main.ts");
      },
      { timeout: 2_000 },
    );
    if (registered.kind !== "project-registration") throw new Error("registration expected");
    await expect(
      requestProjectOperation({
        socketPath: config.paths.socket,
        operation: {
          command: "project-unregister",
          project_id: registered.registration.project_id,
        },
      }),
    ).resolves.toMatchObject({
      kind: "project-registration",
      registration: { state: "UNREGISTERED" },
    });
    signals.emit("SIGTERM");
    await expect(running).resolves.toMatchObject({ reason: "SIGTERM", forced: false });
    await expect(lstat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(config.paths.socket)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(transientSkillArtifacts(path.join(config.paths.state, "skills"))).resolves.toEqual(
      [],
    );
    await rm(root, { recursive: true, force: true });
  });

  it("returns one successful terminal JSON result after graceful shutdown", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-runtime-serve-")));
    temporaryDirectories.push(root);
    await chmod(root, 0o700);
    const signals = new FakeSignals();
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const running = runCli(["serve", "--json"], {
      platform: { os: "linux", arch: "x64", node: "22.23.1" },
      loadConfig: () =>
        Promise.resolve({ config: defaultConfig("linux", root), source: "defaults" }),
      serve: () => {
        const config = defaultConfig("linux", root);
        const lock: InstanceLock = {
          owner: {
            schema_version: "service-lock.v1",
            document_type: "service-lock",
            service_instance_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f42",
            pid: 4200,
            executable_hash: "a".repeat(64),
            created_at: "2026-08-19T12:00:00.000Z",
          },
          release: () => Promise.resolve(),
        };
        return runSupervisor({
          loaded: { config, source: "defaults" },
          signals,
          pid: 4200,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
          createServiceInstanceId: () => lock.owner.service_instance_id,
          executableHash: lock.owner.executable_hash,
          processProbe: { liveness: () => "dead" },
          socketProbe: { identify: () => Promise.resolve(null) },
          acquireLock: () => Promise.resolve(lock),
          createControlServer: () => ({
            listen: () => Promise.resolve(),
            stopAccepting: () => undefined,
            drain: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
          recoveryParticipants: [
            {
              recover: () => Promise.resolve(),
              stopIntake: () => undefined,
              flush: () => Promise.resolve(),
            },
          ],
          interruptionRecorder: { interruptActive: () => Promise.resolve() },
          umask: { set: () => 0o022 },
          onReady: () => resolveReady?.(),
        });
      },
    });
    await ready;
    signals.emit("SIGTERM");

    const output = await running;
    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({ command: "serve", ok: true, exit_code: 0 });
    await rm(root, { recursive: true, force: true });
  });
});
