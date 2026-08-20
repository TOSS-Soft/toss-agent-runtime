import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
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
        afterPendingFileSync: () => {
          if (!interrupted) {
            interrupted = true;
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
