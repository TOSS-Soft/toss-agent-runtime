import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner } from "../src/platform/commands.js";
import { renderServiceDefinition } from "../src/service/definition.js";
import { ensureServiceConfig } from "../src/service/definition-store.js";
import { createServiceManager, type ServiceManager } from "../src/service/manager.js";

const temporaryDirectories: string[] = [];

class RecordingRunner implements CommandRunner {
  readonly calls: { file: string; args: readonly string[] }[] = [];

  constructor(
    private readonly results: readonly (CommandResult | Error)[] = [
      { exitCode: 0, stdout: "", stderr: "" },
    ],
  ) {}

  run(file: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ file, args: [...args] });
    const result = this.results[this.calls.length - 1] ?? { exitCode: 0, stdout: "", stderr: "" };
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }
}

interface ManagerFixture {
  readonly manager: ServiceManager;
  readonly platform: "darwin" | "linux";
  readonly home: string;
  readonly definition: string;
  readonly config: string;
  readonly canonicalRunArtifact: string;
  readonly journal: string;
  readonly registry: string;
  readonly pendingIntake: string;
  readonly operationalLog: string;
}

interface FixtureOptions {
  readonly beforeDefinitionPublish?: (input: {
    readonly definition: string;
    readonly config: string;
  }) => Promise<void>;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "toss-runtime-manager-")));
  temporaryDirectories.push(directory);
  return directory;
}

async function fixture(
  platform: "darwin" | "linux",
  runner: CommandRunner,
  options: FixtureOptions = {},
): Promise<ManagerFixture> {
  const home = await temporaryDirectory();
  const config = await ensureServiceConfig({
    platform,
    home,
    env: {},
    randomSuffix: () => "config",
  });
  const state = path.join(home, "state");
  const logs = path.join(home, "logs");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const canonicalRunArtifact = path.join(state, "canonical-run.json");
  const journal = path.join(state, "journal.ndjson");
  const registry = path.join(state, "registry.json");
  const pendingIntake = path.join(state, "pending.ndjson");
  const operationalLog = path.join(logs, "runtime.log");
  await Promise.all(
    [canonicalRunArtifact, journal, registry, pendingIntake, operationalLog].map(
      async (filePath) => {
        await writeFile(filePath, "preserve", { mode: 0o600 });
        await chmod(filePath, 0o600);
      },
    ),
  );

  const definition =
    platform === "linux"
      ? path.join(home, ".config", "systemd", "user", "toss-agent-runtime.service")
      : path.join(home, "Library", "LaunchAgents", "software.toss.agent-runtime.plist");
  const beforeDefinitionPublish = options.beforeDefinitionPublish;
  const manager = createServiceManager({
    platform,
    home,
    env: {},
    uid: 501,
    currentUid: () => 501,
    nodePath: "/opt/toss/node/bin/node",
    cliPath: "/opt/toss/bin/toss-runtime.js",
    configPath: config,
    randomSuffix: () => "definition",
    runner,
    ...(beforeDefinitionPublish === undefined
      ? {}
      : { beforeDefinitionPublish: () => beforeDefinitionPublish({ definition, config }) }),
  });
  return {
    manager,
    platform,
    home,
    definition,
    config,
    canonicalRunArtifact,
    journal,
    registry,
    pendingIntake,
    operationalLog,
  };
}

function managerFor(
  fixture: ManagerFixture,
  runner: CommandRunner,
  configPath: string,
  overrides: Readonly<{
    uid?: number;
    currentUid?: () => number;
    cliPath?: string;
    env?: Readonly<Record<string, string | undefined>>;
  }> = {},
): ServiceManager {
  return createServiceManager({
    platform: fixture.platform,
    home: fixture.home,
    env: overrides.env ?? {},
    uid: overrides.uid ?? 501,
    currentUid: overrides.currentUid ?? (() => 501),
    nodePath: "/opt/toss/node/bin/node",
    cliPath: overrides.cliPath ?? "/opt/toss/bin/toss-runtime.js",
    configPath,
    randomSuffix: () => "alternate-definition",
    runner,
  });
}

function linuxFixture(runner: CommandRunner, options?: FixtureOptions): Promise<ManagerFixture> {
  return fixture("linux", runner, options);
}

function darwinFixture(runner: CommandRunner, options?: FixtureOptions): Promise<ManagerFixture> {
  return fixture("darwin", runner, options);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("native per-user service manager", () => {
  it.each([
    ["linux", "different CLI entry", { cliPath: "/opt/other/toss-runtime.js" }],
    ["darwin", "different CLI entry", { cliPath: "/opt/other/toss-runtime.js" }],
    ["linux", "different allowlisted environment", { env: { LANG: "C" } }],
    ["darwin", "different allowlisted environment", { env: { LANG: "C" } }],
  ] as const)(
    "rejects %s custom-config recovery with a %s before native mutation",
    async (platform, _name, overrides) => {
      const runner = new RecordingRunner();
      const artifacts = await fixture(platform, runner);
      const customConfig = path.join(artifacts.home, "custom-config.yaml");
      await managerFor(artifacts, runner, customConfig).install();
      const definitionBefore = await readFile(artifacts.definition);
      runner.calls.splice(0);

      const incompatible = managerFor(artifacts, runner, artifacts.config, overrides);
      await expect(incompatible.status()).rejects.toMatchObject({
        code: "RUNTIME_SERVICE_DEFINITION_UNSAFE",
      });
      expect(runner.calls).toEqual([]);
      expect(await readFile(artifacts.definition)).toEqual(definitionBefore);
    },
  );

  it.each([
    ["mismatched", (): number => 502],
    ["negative", (): number => -1],
    [
      "unavailable",
      (): number => {
        throw new Error("uid unavailable");
      },
    ],
  ] as const)(
    "rejects a %s current UID before definition or native mutation",
    async (_name, currentUid) => {
      const runner = new RecordingRunner();
      const artifacts = await linuxFixture(runner);
      const customConfig = path.join(artifacts.home, "custom-config.yaml");
      await managerFor(artifacts, runner, customConfig).install();
      const definitionBefore = await readFile(artifacts.definition);
      runner.calls.splice(0);

      expect(() => managerFor(artifacts, runner, artifacts.config, { currentUid })).toThrowError(
        expect.objectContaining({ code: "RUNTIME_SERVICE_DEFINITION_UNSAFE" }),
      );
      expect(runner.calls).toEqual([]);
      expect(await readFile(artifacts.definition)).toEqual(definitionBefore);
    },
  );

  it.each(["linux", "darwin"] as const)(
    "rejects malformed, control-bearing, and noncanonical %s definition bytes before native mutation",
    async (platform) => {
      const cases: Uint8Array[] = [];
      const runner = new RecordingRunner();
      const artifacts = await fixture(platform, runner);
      const customConfig = path.join(
        artifacts.home,
        platform === "linux" ? "custom%config.yaml" : "custom&config.yaml",
      );
      await managerFor(artifacts, runner, customConfig).install();
      runner.calls.splice(0);
      const canonical = await readFile(artifacts.definition);
      const encodedConfig =
        platform === "linux"
          ? customConfig.replaceAll("%", "%%")
          : customConfig.replaceAll("&", "&amp;");
      const configBytes = Buffer.from(encodedConfig, "utf8");
      const configOffset = canonical.indexOf(configBytes);
      expect(configOffset).toBeGreaterThanOrEqual(0);
      cases.push(
        Buffer.concat([
          canonical.subarray(0, configOffset),
          Buffer.from([0xff]),
          canonical.subarray(configOffset + 1),
        ]),
      );
      cases.push(
        Buffer.from(canonical.toString("utf8").replace(encodedConfig, "/tmp/control\u0001.yaml")),
      );
      cases.push(
        Buffer.from(
          platform === "linux"
            ? canonical.toString("utf8").replace("custom%%config.yaml", "custom%config.yaml")
            : canonical
                .toString("utf8")
                .replace("custom&amp;config.yaml", "custom&#38;config.yaml"),
        ),
      );

      for (const tampered of cases) {
        await writeFile(artifacts.definition, tampered, { mode: 0o600 });
        await chmod(artifacts.definition, 0o600);
        await expect(artifacts.manager.status()).rejects.toMatchObject({
          code: "RUNTIME_SERVICE_DEFINITION_UNSAFE",
        });
        expect(runner.calls).toEqual([]);
      }
    },
  );

  it.each(["linux", "darwin"] as const)(
    "recognizes a canonical %s definition installed with a custom config for every later action",
    async (platform) => {
      const runner = new RecordingRunner();
      const artifacts = await fixture(platform, runner);
      const customConfig = path.join(artifacts.home, 'custom % $ \\ " & < >.yaml');
      await managerFor(artifacts, runner, customConfig).install();

      await expect(artifacts.manager.installedConfigPath()).resolves.toBe(customConfig);
      await expect(artifacts.manager.start()).resolves.toMatchObject({ installed: true });
      await expect(artifacts.manager.stop()).resolves.toMatchObject({ installed: true });
      await expect(artifacts.manager.restart()).resolves.toMatchObject({ installed: true });
      await expect(artifacts.manager.status()).resolves.toMatchObject({ backoff: false });
      await expect(artifacts.manager.uninstall()).resolves.toMatchObject({ installed: false });
      await expect(lstat(artifacts.definition)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["linux", "darwin"] as const)(
    "rejects a %s definition whose recovered config path is not absolute before native mutation",
    async (platform) => {
      const runner = new RecordingRunner();
      const artifacts = await fixture(platform, runner);
      const customConfig = path.join(artifacts.home, "custom-config.yaml");
      const installer = managerFor(artifacts, runner, customConfig);
      await installer.install();
      runner.calls.splice(0);
      const canonical = await readFile(artifacts.definition, "utf8");
      await writeFile(artifacts.definition, canonical.replace(customConfig, "relative.yaml"), {
        mode: 0o600,
      });
      await chmod(artifacts.definition, 0o600);

      await expect(artifacts.manager.status()).rejects.toMatchObject({
        code: "RUNTIME_SERVICE_DEFINITION_UNSAFE",
      });
      expect(runner.calls).toEqual([]);
    },
  );

  it.each(["linux", "darwin"] as const)(
    "rejects a canonical %s definition generated for another executable before native mutation",
    async (platform) => {
      const runner = new RecordingRunner();
      const artifacts = await fixture(platform, runner);
      const customConfig = path.join(artifacts.home, "custom-config.yaml");
      await managerFor(artifacts, runner, customConfig).install();
      runner.calls.splice(0);
      await writeFile(
        artifacts.definition,
        renderServiceDefinition({
          platform,
          uid: 501,
          nodePath: "/opt/untrusted/node",
          cliPath: "/opt/toss/bin/toss-runtime.js",
          configPath: customConfig,
          environment: {},
        }),
        { mode: 0o600 },
      );
      await chmod(artifacts.definition, 0o600);

      await expect(artifacts.manager.status()).rejects.toMatchObject({
        code: "RUNTIME_SERVICE_DEFINITION_UNSAFE",
      });
      expect(runner.calls).toEqual([]);
    },
  );

  it("enables Linux login startup without starting during install", async () => {
    const runner = new RecordingRunner();
    const { manager } = await linuxFixture(runner);

    await expect(manager.install()).resolves.toEqual({
      installed: true,
      enabled: true,
      active: false,
      backoff: false,
      restartCount: 0,
      lastExitCode: null,
    });
    expect(runner.calls).toEqual([
      { file: "/usr/bin/systemctl", args: ["--user", "daemon-reload"] },
      { file: "/usr/bin/systemctl", args: ["--user", "enable", "toss-agent-runtime.service"] },
    ]);
    expect(runner.calls.flatMap((entry) => entry.args)).not.toContain("start");
  });

  it("writes a Darwin login definition without starting during install", async () => {
    const runner = new RecordingRunner();
    const { manager, definition } = await darwinFixture(runner);

    await manager.install();

    expect(runner.calls).toEqual([]);
    expect(await readFile(definition, "utf8")).toContain("<key>RunAtLoad</key>");
  });

  it.each([
    ["start", ["--user", "start", "toss-agent-runtime.service"]],
    ["stop", ["--user", "stop", "toss-agent-runtime.service"]],
    ["restart", ["--user", "restart", "toss-agent-runtime.service"]],
  ] as const)("uses the exact Linux %s boundary", async (method, args) => {
    const runner = new RecordingRunner();
    const { manager } = await linuxFixture(runner);
    await manager.install();
    runner.calls.splice(0);

    await manager[method]();

    expect(runner.calls).toEqual([{ file: "/usr/bin/systemctl", args }]);
  });

  it.each([
    ["start", ["bootstrap", "gui/501", "DEFINITION"]],
    ["stop", ["bootout", "gui/501/software.toss.agent-runtime"]],
    ["restart", ["kickstart", "-k", "gui/501/software.toss.agent-runtime"]],
  ] as const)("uses the exact Darwin %s boundary", async (method, expectedArgs) => {
    const runner = new RecordingRunner();
    const { manager, definition } = await darwinFixture(runner);
    await manager.install();

    await manager[method]();

    const args = expectedArgs.map((value) => (value === "DEFINITION" ? definition : value));
    expect(runner.calls).toEqual([{ file: "/bin/launchctl", args }]);
  });

  it("parses every Linux manager status field from the native status output", async () => {
    const runner = new RecordingRunner([
      {
        exitCode: 0,
        stdout:
          "LoadState=loaded\nUnitFileState=enabled\nActiveState=activating\nSubState=auto-restart\nResult=success\nNRestarts=7\nExecMainStatus=23\n",
        stderr: "",
      },
    ]);
    const { manager } = await linuxFixture(runner);
    await manager.install();
    runner.calls.splice(0);

    await expect(manager.status()).resolves.toEqual({
      installed: true,
      enabled: true,
      active: false,
      backoff: true,
      restartCount: 7,
      lastExitCode: 23,
    });
    expect(runner.calls).toEqual([
      {
        file: "/usr/bin/systemctl",
        args: [
          "--user",
          "show",
          "toss-agent-runtime.service",
          "--property=LoadState,UnitFileState,ActiveState,SubState,Result,NRestarts,ExecMainStatus",
          "--no-pager",
        ],
      },
    ]);
  });

  it("parses terminal systemd start-limit failures as actionable restart backoff", async () => {
    const runner = new RecordingRunner([
      {
        exitCode: 0,
        stdout:
          "LoadState=loaded\nUnitFileState=enabled\nActiveState=failed\nSubState=failed\nResult=start-limit-hit\nNRestarts=5\nExecMainStatus=70\n",
        stderr: "",
      },
    ]);
    const { manager } = await linuxFixture(runner);
    await manager.install();
    runner.calls.splice(0);

    await expect(manager.status()).resolves.toEqual({
      installed: true,
      enabled: true,
      active: false,
      backoff: true,
      restartCount: 5,
      lastExitCode: 70,
    });
    expect(runner.calls).toEqual([
      {
        file: "/usr/bin/systemctl",
        args: [
          "--user",
          "show",
          "toss-agent-runtime.service",
          "--property=LoadState,UnitFileState,ActiveState,SubState,Result,NRestarts,ExecMainStatus",
          "--no-pager",
        ],
      },
    ]);
  });

  it("returns an absent status without invoking a manager for a missing definition", async () => {
    const runner = new RecordingRunner();
    const { manager } = await linuxFixture(runner);

    await expect(manager.status()).resolves.toEqual({
      installed: false,
      enabled: false,
      active: false,
      backoff: false,
      restartCount: 0,
      lastExitCode: null,
    });
    expect(runner.calls).toEqual([]);
  });

  it("returns an absent status when Linux reports an installed unit as not found", async () => {
    const runner = new RecordingRunner([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "LoadState=not-found\n", stderr: "" },
    ]);
    const { manager } = await linuxFixture(runner);
    await manager.install();

    await expect(manager.status()).resolves.toEqual({
      installed: false,
      enabled: false,
      active: false,
      backoff: false,
      restartCount: 0,
      lastExitCode: null,
    });
  });

  it("parses a Darwin running status and uses the exact print boundary", async () => {
    const runner = new RecordingRunner([
      { exitCode: 0, stdout: "state = running\nruns = 4\nlast exit code = 0\n", stderr: "" },
    ]);
    const { manager } = await darwinFixture(runner);
    await manager.install();

    await expect(manager.status()).resolves.toEqual({
      installed: true,
      enabled: true,
      active: true,
      backoff: false,
      restartCount: 4,
      lastExitCode: 0,
    });
    expect(runner.calls).toEqual([
      { file: "/bin/launchctl", args: ["print", "gui/501/software.toss.agent-runtime"] },
    ]);
  });

  it("returns an absent status when Darwin reports no registered service", async () => {
    const runner = new RecordingRunner([
      {
        exitCode: 1,
        stdout: "",
        stderr: "Could not find service gui/501/software.toss.agent-runtime",
      },
    ]);
    const { manager } = await darwinFixture(runner);
    await manager.install();

    await expect(manager.status()).resolves.toEqual({
      installed: false,
      enabled: false,
      active: false,
      backoff: false,
      restartCount: 0,
      lastExitCode: null,
    });
  });

  it("treats a repeated Darwin bootstrap as an idempotent start", async () => {
    const runner = new RecordingRunner([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "service software.toss.agent-runtime already loaded" },
    ]);
    const { manager } = await darwinFixture(runner);
    await manager.install();

    await manager.start();
    await expect(manager.start()).resolves.toMatchObject({ installed: true, active: true });
  });

  it("remains idempotent when Linux stop and disable report an absent unit", async () => {
    const runner = new RecordingRunner([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "Unit toss-agent-runtime.service not loaded" },
      { exitCode: 1, stdout: "", stderr: "Unit file toss-agent-runtime.service does not exist" },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
    const { manager, definition } = await linuxFixture(runner);
    await manager.install();

    await expect(manager.uninstall()).resolves.toMatchObject({ installed: false, enabled: false });
    await expect(lstat(definition)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runner.calls).toEqual([
      { file: "/usr/bin/systemctl", args: ["--user", "daemon-reload"] },
      { file: "/usr/bin/systemctl", args: ["--user", "enable", "toss-agent-runtime.service"] },
      { file: "/usr/bin/systemctl", args: ["--user", "stop", "toss-agent-runtime.service"] },
      { file: "/usr/bin/systemctl", args: ["--user", "disable", "toss-agent-runtime.service"] },
      { file: "/usr/bin/systemctl", args: ["--user", "daemon-reload"] },
    ]);
  });

  it("keeps repeated Linux install, start, stop, and uninstall operations within manager scope", async () => {
    const runner = new RecordingRunner();
    const { manager } = await linuxFixture(runner);

    await manager.install();
    await manager.install();
    await manager.start();
    await manager.start();
    await manager.stop();
    await manager.stop();
    await manager.uninstall();
    await manager.uninstall();

    expect(runner.calls).toEqual([
      { file: "/usr/bin/systemctl", args: ["--user", "daemon-reload"] },
      { file: "/usr/bin/systemctl", args: ["--user", "enable", "toss-agent-runtime.service"] },
      { file: "/usr/bin/systemctl", args: ["--user", "daemon-reload"] },
      { file: "/usr/bin/systemctl", args: ["--user", "enable", "toss-agent-runtime.service"] },
      { file: "/usr/bin/systemctl", args: ["--user", "start", "toss-agent-runtime.service"] },
      { file: "/usr/bin/systemctl", args: ["--user", "start", "toss-agent-runtime.service"] },
      { file: "/usr/bin/systemctl", args: ["--user", "stop", "toss-agent-runtime.service"] },
      { file: "/usr/bin/systemctl", args: ["--user", "stop", "toss-agent-runtime.service"] },
      { file: "/usr/bin/systemctl", args: ["--user", "stop", "toss-agent-runtime.service"] },
      { file: "/usr/bin/systemctl", args: ["--user", "disable", "toss-agent-runtime.service"] },
      { file: "/usr/bin/systemctl", args: ["--user", "daemon-reload"] },
    ]);
  });

  it("uninstalls only native manager artifacts and preserves state, intake, and logs", async () => {
    const runner = new RecordingRunner();
    const artifacts = await linuxFixture(runner);
    await artifacts.manager.install();
    runner.calls.splice(0);

    await artifacts.manager.uninstall();

    await expect(lstat(artifacts.definition)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(artifacts.config, "utf8")).resolves.toContain("schema_version");
    await expect(readFile(artifacts.canonicalRunArtifact, "utf8")).resolves.toBe("preserve");
    await expect(readFile(artifacts.journal, "utf8")).resolves.toBe("preserve");
    await expect(readFile(artifacts.registry, "utf8")).resolves.toBe("preserve");
    await expect(readFile(artifacts.pendingIntake, "utf8")).resolves.toBe("preserve");
    await expect(readFile(artifacts.operationalLog, "utf8")).resolves.toBe("preserve");
  });

  it("rejects an incompatible installed definition without replacing it", async () => {
    const runner = new RecordingRunner();
    const { manager, definition } = await linuxFixture(runner);
    await manager.install();
    await writeFile(definition, "[Service]\nExecStart=/untrusted\n", { mode: 0o600 });
    await chmod(definition, 0o600);

    await expect(manager.install()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_DEFINITION_UNSAFE",
    });
    expect(await readFile(definition, "utf8")).toBe("[Service]\nExecStart=/untrusted\n");
  });

  it("rejects a symlinked installed definition without touching its target", async () => {
    const runner = new RecordingRunner();
    const { manager, definition } = await linuxFixture(runner);
    await manager.install();
    const target = path.join(path.dirname(definition), "target.service");
    await writeFile(target, "preserve", { mode: 0o600 });
    await chmod(target, 0o600);
    await rm(definition);
    await symlink(target, definition);

    await expect(manager.install()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_DEFINITION_UNSAFE",
    });
    expect(await readFile(target, "utf8")).toBe("preserve");
  });

  it("normalizes an oversized definition before any native mutation without reflecting its path", async () => {
    const runner = new RecordingRunner();
    const { manager, definition } = await linuxFixture(runner);
    await mkdir(path.dirname(definition), { recursive: true, mode: 0o700 });
    await writeFile(definition, "", { mode: 0o600 });
    await chmod(definition, 0o600);
    await truncate(definition, 65_537);

    let error: unknown;
    try {
      await manager.install();
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "RUNTIME_SERVICE_DEFINITION_UNSAFE" });
    expect(String(error)).not.toContain(definition);
    expect(runner.calls).toEqual([]);
  });

  it("maps a missing native manager executable to the fixed unavailable error", async () => {
    const missing = Object.assign(new Error("ENOENT /untrusted/path"), { code: "ENOENT" });
    const runner = new RecordingRunner([missing]);
    const { manager } = await linuxFixture(runner);

    await expect(manager.install()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_MANAGER_UNAVAILABLE",
    });
  });

  it("maps nonzero manager results to a fixed error without reflecting command output", async () => {
    const runner = new RecordingRunner([
      { exitCode: 71, stdout: "secret=/private/runtime", stderr: "token=must-not-leak" },
    ]);
    const { manager } = await linuxFixture(runner);

    let error: unknown;
    try {
      await manager.install();
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "RUNTIME_SERVICE_MANAGER_FAILED" });
    expect(String(error)).not.toContain("private/runtime");
    expect(String(error)).not.toContain("must-not-leak");
  });

  it.each([
    ["linux", "stop", "incompatible"],
    ["linux", "uninstall", "incompatible"],
    ["darwin", "stop", "incompatible"],
    ["darwin", "uninstall", "incompatible"],
    ["linux", "stop", "symlink"],
    ["linux", "uninstall", "symlink"],
    ["darwin", "stop", "symlink"],
    ["darwin", "uninstall", "symlink"],
  ] as const)(
    "refuses %s %s before native mutation when its definition is %s",
    async (platform, action, unsafeKind) => {
      const runner = new RecordingRunner();
      const fixtureForPlatform = platform === "linux" ? linuxFixture : darwinFixture;
      const { manager, definition } = await fixtureForPlatform(runner);
      await manager.install();
      runner.calls.splice(0);

      const target = path.join(path.dirname(definition), "preserved-definition");
      if (unsafeKind === "incompatible") {
        await writeFile(definition, "untrusted-definition", { mode: 0o600 });
        await chmod(definition, 0o600);
      } else {
        await writeFile(target, "preserve", { mode: 0o600 });
        await chmod(target, 0o600);
        await rm(definition);
        await symlink(target, definition);
      }

      await expect(manager[action]()).rejects.toMatchObject({
        code: "RUNTIME_SERVICE_DEFINITION_UNSAFE",
      });
      expect(runner.calls).toEqual([]);
      if (unsafeKind === "incompatible") {
        expect(await readFile(definition, "utf8")).toBe("untrusted-definition");
      } else {
        expect(await readFile(target, "utf8")).toBe("preserve");
      }
    },
  );

  it("uses the Darwin bootout boundary while preserving config, state, intake, and logs", async () => {
    const runner = new RecordingRunner();
    const artifacts = await darwinFixture(runner);
    await artifacts.manager.install();

    await artifacts.manager.uninstall();

    expect(runner.calls).toEqual([
      { file: "/bin/launchctl", args: ["bootout", "gui/501/software.toss.agent-runtime"] },
    ]);
    await expect(lstat(artifacts.definition)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(artifacts.config, "utf8")).resolves.toContain("schema_version");
    await expect(readFile(artifacts.canonicalRunArtifact, "utf8")).resolves.toBe("preserve");
    await expect(readFile(artifacts.journal, "utf8")).resolves.toBe("preserve");
    await expect(readFile(artifacts.registry, "utf8")).resolves.toBe("preserve");
    await expect(readFile(artifacts.pendingIntake, "utf8")).resolves.toBe("preserve");
    await expect(readFile(artifacts.operationalLog, "utf8")).resolves.toBe("preserve");
  });

  it("keeps repeated Darwin stop and uninstall operations idempotent", async () => {
    const runner = new RecordingRunner([
      { exitCode: 0, stdout: "", stderr: "" },
      {
        exitCode: 1,
        stdout: "",
        stderr: "Could not find service gui/501/software.toss.agent-runtime",
      },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
    const { manager } = await darwinFixture(runner);
    await manager.install();

    await manager.stop();
    await manager.stop();
    await manager.uninstall();
    await manager.uninstall();

    expect(runner.calls).toEqual([
      { file: "/bin/launchctl", args: ["bootout", "gui/501/software.toss.agent-runtime"] },
      { file: "/bin/launchctl", args: ["bootout", "gui/501/software.toss.agent-runtime"] },
      { file: "/bin/launchctl", args: ["bootout", "gui/501/software.toss.agent-runtime"] },
    ]);
  });

  it("preserves and rejects an incompatible definition that wins the install publication race", async () => {
    const runner = new RecordingRunner();
    const { manager, definition } = await linuxFixture(runner, {
      beforeDefinitionPublish: async () => {
        await writeFile(definition, "raced-untrusted-definition", { mode: 0o600 });
        await chmod(definition, 0o600);
      },
    });

    await expect(manager.install()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_DEFINITION_UNSAFE",
    });
    expect(runner.calls).toEqual([]);
    expect(await readFile(definition, "utf8")).toBe("raced-untrusted-definition");
  });

  it("accepts a byte-compatible definition that wins the install publication race", async () => {
    const runner = new RecordingRunner();
    const { manager, definition, config } = await linuxFixture(runner, {
      beforeDefinitionPublish: async () => {
        const definitionBytes = renderServiceDefinition({
          platform: "linux",
          uid: 501,
          nodePath: "/opt/toss/node/bin/node",
          cliPath: "/opt/toss/bin/toss-runtime.js",
          configPath: config,
          environment: {},
        });
        await writeFile(definition, definitionBytes, { mode: 0o600 });
        await chmod(definition, 0o600);
      },
    });

    await expect(manager.install()).resolves.toMatchObject({ installed: true, enabled: true });
    expect(runner.calls).toEqual([
      { file: "/usr/bin/systemctl", args: ["--user", "daemon-reload"] },
      { file: "/usr/bin/systemctl", args: ["--user", "enable", "toss-agent-runtime.service"] },
    ]);
    expect(await readFile(definition, "utf8")).toBe(
      renderServiceDefinition({
        platform: "linux",
        uid: 501,
        nodePath: "/opt/toss/node/bin/node",
        cliPath: "/opt/toss/bin/toss-runtime.js",
        configPath: config,
        environment: {},
      }),
    );
  });

  it("does not accept unrelated idempotent-looking Linux or Darwin manager failures", async () => {
    const linuxRunner = new RecordingRunner([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "Unit unrelated.service not loaded" },
    ]);
    const { manager: linuxManager } = await linuxFixture(linuxRunner);
    await linuxManager.install();
    await expect(linuxManager.stop()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_MANAGER_FAILED",
    });

    const darwinRunner = new RecordingRunner([
      { exitCode: 1, stdout: "", stderr: "Could not find service gui/501/unrelated" },
    ]);
    const { manager: darwinManager } = await darwinFixture(darwinRunner);
    await darwinManager.install();
    await expect(darwinManager.stop()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_MANAGER_FAILED",
    });
  });

  it.each([
    ["bootstrap", "start", "service software.toss.agent-runtime.helper already loaded"],
    ["bootout", "stop", "Could not find service gui/501/software.toss.agent-runtime-helper"],
    ["print", "status", "Could not find service gui/501/software.toss.agent-runtime.helper"],
  ] as const)(
    "does not accept a Darwin %s failure for a target-prefix service identity",
    async (_operation, action, stderr) => {
      const runner = new RecordingRunner([{ exitCode: 1, stdout: "", stderr }]);
      const { manager } = await darwinFixture(runner);
      await manager.install();

      await expect(manager[action]()).rejects.toMatchObject({
        code: "RUNTIME_SERVICE_MANAGER_FAILED",
      });
    },
  );

  it.each([
    ["bootstrap service-first", "start", "service evilsoftware.toss.agent-runtime already loaded"],
    ["bootstrap loaded-first", "start", "already loaded evilsoftware.toss.agent-runtime"],
    ["bootout", "stop", "Could not find service evilgui/501/software.toss.agent-runtime"],
    ["print", "status", "Could not find service evilgui/501/software.toss.agent-runtime"],
  ] as const)(
    "does not accept a Darwin %s failure for a leading-prefix service identity",
    async (_operation, action, stderr) => {
      const runner = new RecordingRunner([{ exitCode: 1, stdout: "", stderr }]);
      const { manager } = await darwinFixture(runner);
      await manager.install();

      await expect(manager[action]()).rejects.toMatchObject({
        code: "RUNTIME_SERVICE_MANAGER_FAILED",
      });
    },
  );

  it.each(["linux", "darwin"] as const)(
    "returns absent without native mutation for missing %s definitions",
    async (platform) => {
      const runner = new RecordingRunner();
      const fixtureForPlatform = platform === "linux" ? linuxFixture : darwinFixture;
      const { manager } = await fixtureForPlatform(runner);

      await expect(manager.start()).resolves.toMatchObject({ installed: false, enabled: false });
      await expect(manager.stop()).resolves.toMatchObject({ installed: false, enabled: false });
      await expect(manager.restart()).resolves.toMatchObject({ installed: false, enabled: false });
      await expect(manager.uninstall()).resolves.toMatchObject({
        installed: false,
        enabled: false,
      });
      expect(runner.calls).toEqual([]);
    },
  );
});
