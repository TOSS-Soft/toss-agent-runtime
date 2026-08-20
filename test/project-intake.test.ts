import {
  appendFile,
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProjectIntake,
  type CreateProjectIntakeOptions,
  type ProjectIntake,
} from "../src/service/project/intake.js";
import type { ProjectChange, ProjectRegistration } from "../src/service/project/types.js";

const roots: string[] = [];

async function fixture(): Promise<{ readonly root: string; readonly statePath: string }> {
  const temporary = await realpath("/tmp");
  const root = await mkdtemp(path.join(temporary, "toss-project-intake-"));
  roots.push(root);
  return { root, statePath: path.join(root, "state") };
}

function registration(revision = 1): ProjectRegistration {
  return Object.freeze({
    project_id: "00000000-0000-4000-8000-000000000001",
    registry_revision: revision,
    canonical_root: "/private/tmp/toss-project",
    manifest_hash: `sha256:${String(revision).padStart(64, "0")}` as const,
    state: "ACTIVE",
  });
}

function change(relativePath: string, size = "1"): ProjectChange {
  return Object.freeze({
    kind: "CHANGED",
    path: relativePath,
    identity: Object.freeze({ device: "1", inode: "2", mtime_ns: "3", size }),
  });
}

function intake(
  statePath: string,
  overrides: Partial<CreateProjectIntakeOptions> = {},
): ProjectIntake {
  let id = 0;
  return createProjectIntake({
    statePath,
    now: () => new Date(Date.now()),
    randomId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    ...overrides,
  });
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("durable project candidate intake", () => {
  it("persists before arming debounce and emits one deterministic candidate", async () => {
    const { statePath } = await fixture();
    const projectIntake = intake(statePath);
    const active = registration();

    await projectIntake.record(active, change("src/z.ts"));
    const pendingPath = path.join(statePath, "projects", "pending", `${active.project_id}.json`);
    expect(JSON.parse(await readFile(pendingPath, "utf8"))).toMatchObject({
      project_id: active.project_id,
      changes: [{ path: "src/z.ts" }],
    });
    await vi.advanceTimersByTimeAsync(100);
    await projectIntake.record(active, change("src/a.ts"));
    await projectIntake.record(active, change("src/a.ts"));
    await vi.advanceTimersByTimeAsync(199);
    expect(await projectIntake.listCandidates()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    const candidates = await projectIntake.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.changes.map((entry) => entry.path)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(candidates[0]?.candidate_key).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(await readdir(path.dirname(pendingPath))).toEqual([]);
    const candidatePath = path.join(statePath, "projects", "intake", "candidates.jsonl");
    expect((await lstat(candidatePath)).mode & 0o777).toBe(0o600);
    expect((await readFile(candidatePath, "utf8")).trimEnd().split("\n")).toHaveLength(1);
  });

  it("flushes a continuous burst at the hard two-second deadline", async () => {
    const { statePath } = await fixture();
    const projectIntake = intake(statePath);
    const active = registration();

    await projectIntake.record(active, change("src/0.ts"));
    for (let index = 1; index <= 13; index += 1) {
      await vi.advanceTimersByTimeAsync(150);
      await projectIntake.record(active, change(`src/${index}.ts`));
    }
    expect(await projectIntake.listCandidates()).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);

    expect(await projectIntake.listCandidates()).toHaveLength(1);
    expect((await projectIntake.listCandidates())[0]?.changes).toHaveLength(14);
  });

  it("flushes an overdue window before accepting the next change", async () => {
    const { statePath } = await fixture();
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const projectIntake = intake(statePath, { now: () => new Date(now) });
    const active = registration();

    await projectIntake.record(active, change("src/a.ts"));
    now += 2_100;
    await projectIntake.record(active, change("src/b.ts"));

    expect(await projectIntake.listCandidates()).toHaveLength(1);
    expect((await projectIntake.listCandidates())[0]?.changes[0]?.path).toBe("src/a.ts");
    const pending = JSON.parse(
      await readFile(
        path.join(statePath, "projects", "pending", `${active.project_id}.json`),
        "utf8",
      ),
    ) as { readonly changes: readonly { readonly path: string }[] };
    expect(pending.changes.map((entry) => entry.path)).toEqual(["src/b.ts"]);
  });

  it("recovers a synchronized pending stage after interruption", async () => {
    const { statePath } = await fixture();
    let interrupted = false;
    const first = intake(statePath, {
      operationHooks: {
        afterPendingFileSync: (stagePath) => {
          if (!interrupted) {
            interrupted = true;
            renameSync(
              stagePath,
              path.join(
                path.dirname(stagePath),
                `.${registration().project_id}.00000000-0000-4000-8000-000000000099.stage`,
              ),
            );
            throw new Error("simulated interruption");
          }
        },
      },
    });

    await expect(first.record(registration(), change("src/a.ts"))).rejects.toThrow(
      "simulated interruption",
    );
    const restarted = intake(statePath);
    await restarted.recover([registration()]);

    expect(await restarted.listCandidates()).toHaveLength(1);
    expect((await restarted.listCandidates())[0]?.changes[0]?.path).toBe("src/a.ts");
    expect(await readdir(path.join(statePath, "projects", "pending"))).toEqual([]);
  });

  it("retries an interrupted pending file barrier before recovery publication", async () => {
    const { statePath } = await fixture();
    let replaySyncs = 0;
    const first = intake(statePath, {
      operationHooks: {
        afterPendingFileSync: (stagePath) => {
          renameSync(
            stagePath,
            path.join(
              path.dirname(stagePath),
              `.${registration().project_id}.00000000-0000-4000-8000-000000000099.stage`,
            ),
          );
          throw new Error("simulated interruption after pending file sync");
        },
      },
    });

    await expect(first.record(registration(), change("src/a.ts"))).rejects.toThrow(
      "simulated interruption after pending file sync",
    );
    const restarted = intake(statePath, {
      operationHooks: {
        beforePrivateFileReplaySync: (privatePath) => {
          if (privatePath.endsWith(".stage")) replaySyncs += 1;
        },
      },
    });
    await restarted.recover([registration()]);

    expect(replaySyncs).toBeGreaterThan(0);
    expect(await restarted.listCandidates()).toHaveLength(1);
  });

  it("deduplicates restart after candidate append and before pending removal", async () => {
    const { statePath } = await fixture();
    for (const hook of ["afterCandidateAppend", "beforePendingUnlink"] as const) {
      const casePath = path.join(statePath, hook);
      const first = intake(casePath, {
        operationHooks: {
          [hook]: () => {
            throw new Error(`interrupted at ${hook}`);
          },
        },
      });
      await first.record(registration(), change("src/a.ts"));
      await expect(first.flush(signal())).rejects.toThrow(`interrupted at ${hook}`);

      const restarted = intake(casePath);
      await restarted.recover([registration()]);
      expect(await restarted.listCandidates()).toHaveLength(1);
      const lines = (
        await readFile(path.join(casePath, "projects", "intake", "candidates.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n");
      expect(lines).toHaveLength(1);
    }
  });

  it("retries the pending directory barrier after an exact unlink", async () => {
    const { statePath } = await fixture();
    const pendingPath = path.join(
      statePath,
      "projects",
      "pending",
      `${registration().project_id}.json`,
    );
    let unlinkStarted = false;
    let failed = false;
    const projectIntake = intake(statePath, {
      operationHooks: {
        beforePendingUnlink: () => {
          unlinkStarted = true;
        },
        beforeDirectorySync: (directoryPath) => {
          if (
            unlinkStarted &&
            directoryPath === path.dirname(pendingPath) &&
            !existsSync(pendingPath) &&
            !failed
          ) {
            failed = true;
            throw new Error("simulated post-unlink directory sync failure");
          }
        },
      },
    });
    await projectIntake.record(registration(), change("src/a.ts"));

    await expect(projectIntake.flush(signal())).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
    });
    await expect(projectIntake.flush(signal())).resolves.toBeUndefined();

    expect(failed).toBe(true);
    expect(existsSync(pendingPath)).toBe(false);
    expect(await projectIntake.listCandidates()).toHaveLength(1);
  });

  it("cleans an owned stage after a transient publication failure before accepting a retry", async () => {
    const { statePath } = await fixture();
    const pendingDirectory = path.join(statePath, "projects", "pending");
    let failed = false;
    const first = intake(statePath, {
      operationHooks: {
        beforeDirectorySync: (directoryPath) => {
          if (
            !failed &&
            directoryPath === pendingDirectory &&
            existsSync(pendingDirectory) &&
            readdirSync(pendingDirectory).some((name) => name.endsWith(".stage"))
          ) {
            failed = true;
            throw new Error("simulated staged publication directory sync failure");
          }
        },
      },
    });

    await expect(first.record(registration(), change("src/a.ts"))).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
    });
    expect(await readdir(pendingDirectory)).toEqual([]);
    await expect(first.record(registration(), change("src/b.ts"))).resolves.toBeUndefined();

    const restarted = intake(statePath);
    await expect(restarted.recover([registration()])).resolves.toBeUndefined();
    expect(await restarted.listCandidates()).toMatchObject([{ changes: [{ path: "src/b.ts" }] }]);
    expect(await readdir(pendingDirectory)).toEqual([]);
  });

  it("blocks live mutation when an owned stage cannot be durably cleaned", async () => {
    const { statePath } = await fixture();
    const pendingDirectory = path.join(statePath, "projects", "pending");
    let publicationFailed = false;
    const first = intake(statePath, {
      operationHooks: {
        beforeDirectorySync: (directoryPath) => {
          if (
            directoryPath === pendingDirectory &&
            (publicationFailed ||
              (existsSync(pendingDirectory) &&
                readdirSync(pendingDirectory).some((name) => name.endsWith(".stage"))))
          ) {
            publicationFailed = true;
            throw new Error("simulated persistent pending directory sync failure");
          }
        },
      },
    });

    await expect(first.record(registration(), change("src/a.ts"))).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
    });
    const second = intake(statePath);
    await expect(second.record(registration(), change("src/b.ts"))).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
    });
    expect(readdirSync(pendingDirectory)).toEqual([]);

    const restarted = intake(statePath);
    await expect(restarted.recover([registration()])).resolves.toBeUndefined();
    expect(await restarted.listCandidates()).toEqual([]);
    expect(await readdir(pendingDirectory)).toEqual([]);
  });

  it("completes a post-rename publication barrier before arming the updated window", async () => {
    const { statePath } = await fixture();
    const pendingDirectory = path.join(statePath, "projects", "pending");
    const pendingPath = path.join(pendingDirectory, `${registration().project_id}.json`);
    let failureEnabled = false;
    let failed = false;
    let sawStage = false;
    const projectIntake = intake(statePath, {
      operationHooks: {
        beforeDirectorySync: (directoryPath) => {
          if (
            failureEnabled &&
            directoryPath === pendingDirectory &&
            readdirSync(pendingDirectory).some((name) => name.endsWith(".stage"))
          ) {
            sawStage = true;
          }
          if (
            failureEnabled &&
            !failed &&
            sawStage &&
            directoryPath === pendingDirectory &&
            existsSync(pendingPath) &&
            !readdirSync(pendingDirectory).some((name) => name.endsWith(".stage"))
          ) {
            failed = true;
            throw new Error("simulated post-rename pending directory sync failure");
          }
        },
      },
    });
    await projectIntake.record(registration(), change("src/a.ts"));
    failureEnabled = true;

    await expect(projectIntake.record(registration(), change("src/b.ts"))).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);

    expect(failed).toBe(true);
    expect(await projectIntake.listCandidates()).toMatchObject([
      { changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
    ]);
    expect(await readdir(pendingDirectory)).toEqual([]);
  });

  it("does not flush an older window while a failed publication awaits recovery", async () => {
    const { statePath } = await fixture();
    const pendingDirectory = path.join(statePath, "projects", "pending");
    let failPublication = false;
    let failedStagePath: string | undefined;
    let failedStageBytes: Buffer | undefined;
    const projectIntake = intake(statePath, {
      operationHooks: {
        afterPendingFileSync: (stagePath) => {
          if (!failPublication) return;
          failedStagePath = stagePath;
          failedStageBytes = readFileSync(stagePath);
          throw new Error("simulated publication interruption");
        },
        beforeDirectorySync: (directoryPath) => {
          if (
            directoryPath !== pendingDirectory ||
            failedStagePath === undefined ||
            failedStageBytes === undefined ||
            existsSync(failedStagePath)
          ) {
            return;
          }
          writeFileSync(failedStagePath, failedStageBytes, { mode: 0o600 });
          throw new Error("simulated cleanup directory barrier failure");
        },
      },
    });
    await projectIntake.record(registration(), change("src/a.ts"));
    failPublication = true;

    await expect(projectIntake.record(registration(), change("src/b.ts"))).rejects.toThrow(
      "simulated publication interruption",
    );
    await expect(projectIntake.flush(signal())).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
    });
    expect(await projectIntake.listCandidates()).toEqual([]);

    const restarted = intake(statePath);
    await expect(restarted.recover([registration()])).resolves.toBeUndefined();
    expect(await restarted.listCandidates()).toMatchObject([
      { changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
    ]);
    expect(await readdir(pendingDirectory)).toEqual([]);
  });

  it("retries the pending directory barrier after stale recovery cleanup", async () => {
    const { statePath } = await fixture();
    await intake(statePath).record(registration(1), change("src/a.ts"));
    const pendingPath = path.join(
      statePath,
      "projects",
      "pending",
      `${registration().project_id}.json`,
    );
    let failed = false;
    const restarted = intake(statePath, {
      operationHooks: {
        beforeDirectorySync: (directoryPath) => {
          if (directoryPath === path.dirname(pendingPath) && !existsSync(pendingPath) && !failed) {
            failed = true;
            throw new Error("simulated stale cleanup directory sync failure");
          }
        },
      },
    });

    await expect(restarted.recover([registration(2)])).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
    });
    await expect(restarted.recover([registration(2)])).resolves.toBeUndefined();

    expect(failed).toBe(true);
    expect(existsSync(pendingPath)).toBe(false);
    expect(await restarted.listCandidates()).toEqual([]);
  });

  it("quarantines a partial candidate tail and restores the exact valid prefix", async () => {
    const { statePath } = await fixture();
    const first = intake(statePath);
    await first.record(registration(), change("src/a.ts"));
    await first.flush(signal());
    const candidatePath = path.join(statePath, "projects", "intake", "candidates.jsonl");
    const prefix = await readFile(candidatePath);
    const fragment = Buffer.from('{"partial":', "utf8");
    await appendFile(candidatePath, fragment);

    const restarted = intake(statePath);
    await restarted.recover([registration()]);

    expect(await readFile(candidatePath)).toEqual(prefix);
    expect(await restarted.listCandidates()).toHaveLength(1);
    const quarantinePath = path.join(statePath, "projects", "quarantine");
    const artifacts = (await readdir(quarantinePath)).filter((name) =>
      name.startsWith("project-intake-"),
    );
    expect(artifacts).toHaveLength(1);
    expect(await readFile(path.join(quarantinePath, artifacts[0]!))).toEqual(fragment);
  });

  it("re-synchronizes an already appended candidate before clearing pending recovery", async () => {
    const { statePath } = await fixture();
    let syncAttempts = 0;
    const first = intake(statePath, {
      operationHooks: {
        beforeCandidateFileSync: () => {
          syncAttempts += 1;
          throw new Error("simulated candidate sync failure");
        },
      },
    });
    await first.record(registration(), change("src/a.ts"));
    await expect(first.flush(signal())).rejects.toThrow("simulated candidate sync failure");

    const restarted = intake(statePath, {
      operationHooks: {
        beforeCandidateFileSync: () => {
          syncAttempts += 1;
        },
      },
    });
    await restarted.recover([registration()]);

    expect(syncAttempts).toBe(2);
    expect(await restarted.listCandidates()).toHaveLength(1);
    expect(await readdir(path.join(statePath, "projects", "pending"))).toEqual([]);
  });

  it("retries a visible candidate file barrier before replaying its result", async () => {
    const { statePath } = await fixture();
    const first = intake(statePath, {
      operationHooks: {
        beforeCandidateFileSync: () => {
          throw new Error("simulated candidate file sync failure");
        },
      },
    });
    await first.record(registration(), change("src/a.ts"));
    await expect(first.flush(signal())).rejects.toThrow("simulated candidate file sync failure");
    let replaySyncs = 0;
    const restarted = intake(statePath, {
      operationHooks: {
        beforePrivateFileReplaySync: (privatePath) => {
          if (privatePath.endsWith("candidates.jsonl")) replaySyncs += 1;
        },
      },
    });

    await restarted.recover([registration()]);

    expect(replaySyncs).toBeGreaterThan(0);
    expect(await restarted.listCandidates()).toHaveLength(1);
  });

  it("retries a failed parent barrier for an already visible intake directory", async () => {
    const { root, statePath } = await fixture();
    let failed = false;
    const projectIntake = intake(statePath, {
      operationHooks: {
        beforeDirectorySync: (directoryPath) => {
          if (directoryPath === root && existsSync(statePath) && !failed) {
            failed = true;
            throw new Error("simulated state parent sync failure");
          }
        },
      },
    });

    await expect(projectIntake.listCandidates()).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
    });
    await expect(projectIntake.listCandidates()).resolves.toEqual([]);
    expect(failed).toBe(true);
  });

  it("rejects an oversized candidate file before allocating its contents", async () => {
    const { statePath } = await fixture();
    const projectIntake = intake(statePath);
    await projectIntake.listCandidates();
    const candidatePath = path.join(statePath, "projects", "intake", "candidates.jsonl");
    await writeFile(candidatePath, "", { mode: 0o600 });
    await truncate(candidatePath, 16 * 1024 * 1024 + 1);

    await expect(intake(statePath).listCandidates()).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_INTAKE_CORRUPT",
    });
  });

  it("drops a stale registration window without emitting a candidate", async () => {
    const { statePath } = await fixture();
    const first = intake(statePath);
    await first.record(registration(1), change("src/a.ts"));

    const restarted = intake(statePath);
    await restarted.recover([registration(2)]);

    expect(await restarted.listCandidates()).toEqual([]);
    expect(await readdir(path.join(statePath, "projects", "pending"))).toEqual([]);
  });

  it("fails closed for unsafe pending state and rejects intake after stop", async () => {
    const { statePath } = await fixture();
    const first = intake(statePath);
    await first.record(registration(), change("src/a.ts"));
    const pendingPath = path.join(
      statePath,
      "projects",
      "pending",
      `${registration().project_id}.json`,
    );
    await chmod(pendingPath, 0o644);

    await expect(intake(statePath).recover([registration()])).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_PATH_UNSAFE",
    });
    first.stopIntake();
    await expect(first.record(registration(), change("src/b.ts"))).rejects.toMatchObject({
      code: "RUNTIME_PROJECT_UNAVAILABLE",
    });
  });

  it("refreshes the candidate head across public intake instances", async () => {
    const { statePath } = await fixture();
    const first = intake(statePath);
    const second = intake(statePath);
    const active = registration();
    expect(await second.listCandidates()).toEqual([]);

    await first.record(active, change("src/a.ts"));
    await first.flush(signal());
    await second.record(active, change("src/a.ts"));
    await second.flush(signal());

    expect(await second.listCandidates()).toHaveLength(1);
    expect(
      (await readFile(path.join(statePath, "projects", "intake", "candidates.jsonl"), "utf8"))
        .trimEnd()
        .split("\n"),
    ).toHaveLength(1);
  });

  it("serializes casing aliases of the same intake root", async (context) => {
    const { root, statePath } = await fixture();
    const first = intake(statePath);
    await first.listCandidates();
    const aliasPath = path.join(root, path.basename(statePath).toUpperCase());
    const aliasRealPath = await realpath(aliasPath).catch(() => undefined);
    if (aliasRealPath === undefined) {
      context.skip("the temporary volume is case-sensitive");
      return;
    }
    context.skip(
      aliasRealPath !== (await realpath(statePath)),
      "the temporary volume is case-sensitive",
    );
    const second = intake(aliasPath);

    await Promise.all([
      first.record(registration(), change("src/a.ts")),
      second.record(registration(), change("src/b.ts")),
    ]);
    await Promise.all([first.flush(signal()), second.flush(signal())]);

    const candidates = await first.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.changes.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("shares one debounce window and timer across public intake instances", async () => {
    const { statePath } = await fixture();
    const first = intake(statePath);
    const second = intake(statePath);
    const active = registration();

    await first.record(active, change("src/a.ts"));
    await second.record(active, change("src/b.ts"));
    await vi.advanceTimersByTimeAsync(250);

    const candidates = await first.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.changes.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(await readdir(path.join(statePath, "projects", "pending"))).toEqual([]);
  });

  it("rejects malformed registration and change values before persisting", async () => {
    const { statePath } = await fixture();
    const projectIntake = intake(statePath);

    await expect(
      projectIntake.record(
        { ...registration(), manifest_hash: "sha256:not-a-hash" },
        change("src/a.ts"),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_PROJECT_INVALID" });
    await expect(
      projectIntake.record(registration(), change("src/a.ts", "999999999999999999999")),
    ).rejects.toMatchObject({ code: "RUNTIME_PROJECT_INVALID" });
    expect(await readdir(path.join(statePath, "projects", "pending"))).toEqual([]);
  });

  it("detaches persisted changes from caller-owned mutable values", async () => {
    const { statePath } = await fixture();
    const projectIntake = intake(statePath);
    const callerOwned = {
      kind: "CHANGED",
      path: "src/original.ts",
      identity: { device: "1", inode: "2", mtime_ns: "3", size: "4" },
    } as ProjectChange;

    await projectIntake.record(registration(), callerOwned);
    (callerOwned as { path: string }).path = "src/mutated.ts";
    await projectIntake.flush(signal());

    expect((await projectIntake.listCandidates())[0]?.changes[0]?.path).toBe("src/original.ts");
  });
});
