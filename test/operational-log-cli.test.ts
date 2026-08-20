import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMainServices, runCli, type CliServices } from "../src/cli/main.js";
import { defaultConfig } from "../src/config/load.js";
import { createOperationalLogStore } from "../src/logging/store.js";
import type { ServiceManagerStatus } from "../src/service/manager.js";
import type { OperationalEventV1 } from "../src/logging/types.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
const event: OperationalEventV1 = {
  protocol_version: "runtime-contract.v1",
  schema_version: "operational-event.v1",
  document_type: "operational-event",
  event_id: "00000000-0000-4000-8000-000000000003",
  timestamp: "2026-08-20T12:00:00.000Z",
  service_instance_id: "00000000-0000-4000-8000-000000000004",
  service_sequence: 1,
  level: "error",
  component: "worker",
  event: "run.failed",
  correlation_id: "00000000-0000-4000-8000-000000000005",
  project_id: PROJECT_ID,
  run_id: RUN_ID,
  metadata: { reason_code: "PROVIDER_TIMEOUT" },
};

function services(): CliServices {
  return {
    platform: { os: "darwin", arch: "arm64", node: "22.23.1" },
    readOperationalLogs: (filter) =>
      Promise.resolve({ events: [event], partialTailBytes: 0, filter }),
    followOperationalLogs: () =>
      Promise.resolve(
        (async function* () {
          await Promise.resolve();
          yield event;
        })(),
      ),
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("operational log CLI", () => {
  it("returns one deterministic command result with exact filters", async () => {
    const output = await runCli(
      ["logs", "--level", "warn", "--project", PROJECT_ID, "--run", RUN_ID, "--json"],
      services(),
    );

    expect(output).toMatchObject({ exitCode: 0, stderr: "" });
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      command: "logs",
      ok: true,
      data: { events: [{ event_id: event.event_id }], partial_tail_bytes: 0 },
    });
  });

  it("returns a human stream for follow mode", async () => {
    const output = await runCli(["logs", "--follow", "--level", "info"], services());
    const lines: string[] = [];
    for await (const line of output.stdoutStream ?? []) lines.push(line);

    expect(output).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(event.event_id);
    expect(lines[0]).toContain("run.failed");
  });

  it("proves the live private service identity before reading configured files", async () => {
    const root = await mkdtemp(path.join(await realpath("/tmp"), "toss-log-cli-main-"));
    roots.push(root);
    const cliPath = path.join(root, "cli.js");
    const configPath = path.join(root, "runtime.json");
    await writeFile(cliPath, "", { mode: 0o600 });
    const config = defaultConfig("darwin", root);
    const store = createOperationalLogStore({
      logsPath: config.paths.logs,
      serviceInstanceId: event.service_instance_id,
      now: () => new Date(event.timestamp),
      randomId: () => event.event_id,
    });
    await store.write({
      level: event.level,
      component: event.component,
      event: event.event,
      correlationId: event.correlation_id,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      metadata: event.metadata,
      allowedMetadataKeys: ["reason_code"],
    });
    const manager: ServiceManagerStatus = {
      installed: true,
      enabled: true,
      active: true,
      backoff: false,
      restartCount: 0,
      lastExitCode: 0,
    };
    const mainServices = createMainServices({
      platform: { os: "darwin", arch: "arm64", node: "22.23.1" },
      env: {},
      home: root,
      signals: { subscribe: () => () => undefined },
      pid: 42,
      now: () => new Date(event.timestamp),
      createServiceInstanceId: () => event.service_instance_id,
      resolveExecutableHash: () => Promise.resolve("a".repeat(64)),
      sendReady: () => undefined,
      cliPath,
      uid: typeof process.getuid === "function" ? process.getuid() : 501,
      loadConfig: () => Promise.resolve({ config, source: configPath }),
      createServiceManager: () => ({
        install: () => Promise.resolve(manager),
        start: () => Promise.resolve(manager),
        stop: () => Promise.resolve(manager),
        restart: () => Promise.resolve(manager),
        status: () => Promise.resolve(manager),
        uninstall: () => Promise.resolve({ ...manager, installed: false }),
        installedConfigPath: () => Promise.resolve(configPath),
      }),
      requestServiceStatus: () =>
        Promise.resolve({
          package_version: "0.0.0-development",
          service_instance_id: event.service_instance_id,
          pid: 42,
          started_at: event.timestamp,
          health: "healthy",
          accepting: true,
        }),
      probeServiceIdentity: () => Promise.resolve(event.service_instance_id),
    });

    const output = await runCli(["logs", "--json"], mainServices);
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({
      data: { events: [{ event_id: event.event_id }] },
    });
  });

  it.each([
    ["JSON follow", ["logs", "--follow", "--json"]],
    ["invalid level", ["logs", "--level", "trace"]],
    ["missing project", ["logs", "--project"]],
    ["duplicate run", ["logs", "--run", RUN_ID, "--run", RUN_ID]],
  ])("rejects %s before reading files", async (_name, argv) => {
    const output = await runCli(argv, {
      platform: { os: "darwin", arch: "arm64", node: "22.23.1" },
      readOperationalLogs: () => Promise.reject(new Error("must not run")),
    });
    expect(output.exitCode).toBe(2);
  });
});
