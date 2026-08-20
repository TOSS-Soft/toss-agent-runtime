import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { computeExecutableHash, createMainServices, runCli } from "../src/cli/main.js";
import { defaultConfig } from "../src/config/load.js";
import type { InstanceLock } from "../src/service/instance-lock.js";
import { runSupervisor } from "../src/service/supervisor.js";
import { FakeSignals } from "./support/fake-signals.js";

const temporaryDirectories: string[] = [];

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
      platform: { os: "linux", arch: "x64", node: "22.23.1" },
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
    const config = defaultConfig("linux", root);
    const socket = await lstat(config.paths.socket);
    const ownerPath = path.join(path.dirname(config.paths.socket), "instance.lock", "owner.json");
    const lockOwner: unknown = JSON.parse(await readFile(ownerPath, "utf8"));

    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
    expect(lockOwner).toMatchObject({ executable_hash: "a".repeat(64) });
    expect(JSON.stringify(lockOwner)).not.toContain(process.execPath);
    signals.emit("SIGTERM");
    await expect(running).resolves.toMatchObject({ reason: "SIGTERM", forced: false });
    await expect(lstat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
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
