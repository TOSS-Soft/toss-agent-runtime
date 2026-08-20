import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createMainServices, runCli, type CliServices } from "../src/cli/main.js";
import { defaultConfig, RuntimeConfigError } from "../src/config/load.js";
import type { ServiceStatusV1 } from "../src/service/contracts.js";
import { RuntimeServiceError, type RuntimeServiceErrorCode } from "../src/service/errors.js";
import { RuntimeProjectError } from "../src/service/project/errors.js";
import { createServiceManager, type ServiceManagerStatus } from "../src/service/manager.js";

const platform = { os: "linux" as const, arch: "x64", node: "22.23.1" };
const RUNTIME_CONFIG_BYTE_CAP = 2 * 1024 * 1024;

function oversizedValidYaml(root: string): Buffer {
  const encoded = Buffer.from(JSON.stringify(defaultConfig("linux", root)), "utf8");
  return Buffer.concat([
    encoded,
    Buffer.alloc(RUNTIME_CONFIG_BYTE_CAP + 1 - encoded.byteLength, 0x20),
  ]);
}

const services = {
  platform,
  loadConfig: () =>
    Promise.resolve({
      config: defaultConfig("linux", "/home/test"),
      source: "defaults",
    }),
};

const absentManagerStatus: ServiceManagerStatus = {
  installed: false,
  enabled: false,
  active: false,
  backoff: false,
  restartCount: 0,
  lastExitCode: null,
};

const activeManagerStatus: ServiceManagerStatus = {
  installed: true,
  enabled: true,
  active: true,
  backoff: false,
  restartCount: 0,
  lastExitCode: 0,
};

const healthySocketStatus: ServiceStatusV1 = {
  package_version: "0.0.0-development",
  service_instance_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f42",
  pid: 4217,
  started_at: "2026-08-19T10:00:00.000Z",
  health: "healthy",
  accepting: true,
};

type ServiceAction = "install" | "start" | "stop" | "restart" | "status" | "uninstall";

function serviceServices(
  options: {
    readonly manager?: ServiceManagerStatus;
    readonly socket?: ServiceStatusV1 | Error;
    readonly identity?: string | null;
    readonly mode?: "development" | "production";
    readonly managerError?: RuntimeServiceErrorCode | Error;
    readonly calls?: { action: ServiceAction; configPath?: string }[];
  } = {},
): CliServices {
  const manager = options.manager ?? activeManagerStatus;
  const socket = options.socket ?? healthySocketStatus;
  return {
    ...services,
    loadConfig: () =>
      Promise.resolve({
        config: { ...defaultConfig("linux", "/home/test"), mode: options.mode ?? "development" },
        source: "defaults",
      }),
    manageService: (action, configPath) => {
      options.calls?.push(configPath === undefined ? { action } : { action, configPath });
      if (options.managerError instanceof Error) return Promise.reject(options.managerError);
      if (options.managerError !== undefined) {
        return Promise.reject(new RuntimeServiceError(options.managerError));
      }
      return Promise.resolve(manager);
    },
    requestServiceStatus: () =>
      socket instanceof Error ? Promise.reject(socket) : Promise.resolve(socket),
    probeServiceIdentity: () =>
      Promise.resolve(
        options.identity === undefined ? healthySocketStatus.service_instance_id : options.identity,
      ),
  };
}

function doctorChecks(output: { readonly stdout: string }): readonly {
  readonly id: string;
  readonly status: string;
  readonly message: string;
}[] {
  const document = JSON.parse(output.stdout) as {
    readonly data: {
      readonly checks: readonly {
        readonly id: string;
        readonly status: string;
        readonly message: string;
      }[];
    };
  };
  return document.data.checks;
}

describe("baseline CLI", () => {
  it("returns one versioned capabilities result in JSON mode", async () => {
    const output = await runCli(["capabilities", "--json"], services);
    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      schema_version: "command-result.v1",
      document_type: "command-result",
      command: "capabilities",
      ok: true,
      exit_code: 0,
      data: { document_type: "runtime-capabilities" },
      error: null,
    });
  });

  it("rejects credential-shaped options without reflecting their values", async () => {
    const output = await runCli(["doctor", "--api-key", "must-not-persist"], services);
    expect(output.exitCode).toBe(2);
    expect(output.stdout).not.toContain("must-not-persist");
    expect(output.stderr).not.toContain("must-not-persist");
    expect(output.stderr).toContain("--api-key");
  });

  it.each([
    ["human", ["doctor", "--api-key=must-not-persist"]],
    ["mixed case", ["doctor", "--ClientSecret=must-not-persist"]],
    ["JSON", ["doctor", "--json", "--access-token=must-not-persist"]],
  ])("redacts inline credential option values in %s mode", async (_name, argv) => {
    const output = await runCli(argv, services);
    expect(output.exitCode).toBe(2);
    expect(output.stdout).not.toContain("must-not-persist");
    expect(output.stderr).not.toContain("must-not-persist");
    expect(`${output.stdout}${output.stderr}`).not.toContain("=");
  });

  it("keeps stderr empty for routed JSON failures", async () => {
    const output = await runCli(["unknown", "--json"], services);
    expect(output.exitCode).toBe(2);
    expect(output.stderr).toBe("");
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, exit_code: 2 });
  });

  it("renders stable human help and version output", async () => {
    const help = await runCli(["--help"], services);
    const version = await runCli(["--version"], services);
    expect(help).toMatchObject({ exitCode: 0, stderr: "" });
    expect(help.stdout).toContain("toss-runtime capabilities [--json]");
    for (const action of ["install", "start", "stop", "restart", "status", "uninstall"]) {
      expect(help.stdout).toContain(`toss-runtime service ${action}`);
    }
    expect(version.stdout.trim()).toBe("0.0.0-development");
  });

  it("reports a healthy development baseline with explicit future warnings", async () => {
    const output = await runCli(["doctor", "--json"], services);
    const document = JSON.parse(output.stdout) as {
      readonly data: {
        readonly healthy: boolean;
        readonly checks: readonly { readonly id: string; readonly status: string }[];
      };
    };
    expect(output.exitCode).toBe(0);
    expect(document.data.healthy).toBe(true);
    expect(document.data.checks).toContainEqual({
      id: "execution-capabilities",
      status: "WARN",
      message:
        "Execution providers, skills, MCP, and orchestration are not installed in the baseline wave",
    });
  });

  it("fails doctor on an unsupported Node line", async () => {
    const output = await runCli(["doctor", "--json"], {
      ...services,
      platform: { ...platform, node: "26.6.0" },
    });
    expect(output.exitCode).toBe(5);
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, exit_code: 5 });
  });

  it("reports serve as unavailable until the lifecycle task is installed", async () => {
    const output = await runCli(["serve", "--json"], services);
    expect(output.exitCode).toBe(69);
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      error: { code: "RUNTIME_SERVE_UNAVAILABLE" },
    });
  });

  it("maps an unavailable serve config to one safe JSON result", async () => {
    const output = await runCli(["serve", "--json"], {
      ...services,
      serve: () =>
        Promise.reject(
          new RuntimeConfigError(
            "RUNTIME_CONFIG_UNAVAILABLE",
            "Configuration file is unavailable at /private/path",
          ),
        ),
    });
    expect(output).toMatchObject({ exitCode: 5, stderr: "" });
    expect(output.stdout).not.toContain("/private/path");
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      exit_code: 5,
      error: { code: "RUNTIME_CONFIG_UNAVAILABLE" },
    });
  });

  it("maps forced and rejected shutdowns to safe internal failures", async () => {
    const forced = await runCli(["serve", "--json"], {
      ...services,
      serve: () => Promise.resolve({ reason: "SIGTERM" as const, forced: true }),
    });
    const rejected = await runCli(["serve", "--json"], {
      ...services,
      serve: () => Promise.reject(new Error("internal path /private/path")),
    });

    for (const output of [forced, rejected]) {
      expect(output).toMatchObject({ exitCode: 70, stderr: "" });
      expect(output.stdout).not.toContain("/private/path");
      expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, exit_code: 70 });
    }
  });

  it.each([
    ["RUNTIME_SERVICE_ALREADY_RUNNING", 6],
    ["RUNTIME_SERVICE_CONTROL_CONFLICT", 6],
    ["RUNTIME_SERVICE_PATH_UNSAFE", 5],
    ["RUNTIME_SERVICE_DEFINITION_UNSAFE", 5],
  ] as const)("maps serve %s to stable exit %i", async (code, exitCode) => {
    const output = await runCli(["serve", "--json"], {
      ...services,
      serve: () => Promise.reject(new RuntimeServiceError(code)),
    });
    expect(output).toMatchObject({ exitCode, stderr: "" });
    expect(JSON.parse(output.stdout)).toMatchObject({
      command: "serve",
      ok: false,
      exit_code: exitCode,
      error: { code },
    });
  });

  it.each([
    [["doctor", "--config"], "Missing value for --config"],
    [["capabilities", "--config", "/tmp/config"], "Unknown option for capabilities: --config"],
    [["doctor", "--unknown"], "Unknown option for doctor: --unknown"],
  ])("rejects malformed grammar %#", async (argv, message) => {
    const output = await runCli(argv, services);
    expect(output.exitCode).toBe(2);
    expect(output.stderr).toContain(message);
  });

  it("routes closed project register, list, and unregister commands", async () => {
    const calls: unknown[] = [];
    const registration = {
      project_id: "00000000-0000-4000-8000-000000000001",
      registry_revision: 1,
      canonical_root: "/private/tmp/project",
      manifest_hash: `sha256:${"a".repeat(64)}` as const,
      state: "ACTIVE" as const,
    };
    const projectServices = {
      ...services,
      requestProjectOperation: (operation: unknown) => {
        calls.push(operation);
        return Promise.resolve(
          (operation as { readonly command: string }).command === "project-list"
            ? { kind: "project-list" as const, registrations: [registration] }
            : { kind: "project-registration" as const, registration },
        );
      },
    };

    const registered = await runCli(
      ["project", "register", "/private/tmp/project", "--json"],
      projectServices,
    );
    const listed = await runCli(["project", "list", "--json"], projectServices);
    const unregistered = await runCli(
      ["project", "unregister", registration.project_id],
      projectServices,
    );

    expect(calls).toEqual([
      { command: "project-register", root: "/private/tmp/project" },
      { command: "project-list" },
      { command: "project-unregister", project_id: registration.project_id },
    ]);
    expect(JSON.parse(registered.stdout)).toMatchObject({
      command: "project register",
      ok: true,
      data: { kind: "project-registration", registration },
    });
    expect(JSON.parse(listed.stdout)).toMatchObject({
      command: "project list",
      ok: true,
      data: { kind: "project-list", registrations: [registration] },
    });
    expect(unregistered).toEqual({
      exitCode: 0,
      stdout: "Project unregistered\n",
      stderr: "",
    });
  });

  it.each([
    [["project"], "Missing project action"],
    [["project", "scan"], "Unknown project action"],
    [["project", "register", "relative/project"], "Project root must be absolute"],
    [["project", "register", "/tmp/project", "extra"], "Unknown option"],
    [["project", "unregister", "not-a-uuid"], "Project ID must be a UUID"],
    [["project", "list", "extra"], "Unknown option"],
    [["project", "list", "--json", "--json"], "Duplicate option: --json"],
  ])("rejects malformed project grammar %# safely", async (argv, message) => {
    const output = await runCli(argv, services);
    expect(output.exitCode).toBe(2);
    expect(`${output.stdout}${output.stderr}`).toContain(message);
  });

  it("maps project failures to fixed safe command results", async () => {
    const output = await runCli(["project", "list", "--json"], {
      ...services,
      requestProjectOperation: () =>
        Promise.reject(new RuntimeProjectError("RUNTIME_PROJECT_REGISTRY_CORRUPT")),
    });

    expect(output).toMatchObject({ exitCode: 5, stderr: "" });
    expect(JSON.parse(output.stdout)).toMatchObject({
      command: "project list",
      ok: false,
      error: {
        code: "RUNTIME_PROJECT_REGISTRY_CORRUPT",
        safe_message: "Project registry is corrupt",
      },
    });
  });

  it.each(["install", "start", "stop", "restart", "status", "uninstall"] as const)(
    "routes service %s with one canonical JSON result",
    async (action) => {
      const output = await runCli(["service", action, "--json"], serviceServices());
      expect(output.stderr).toBe("");
      expect(output.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(output.stdout)).toMatchObject({
        command: `service ${action}`,
        ok: true,
        exit_code: 0,
      });
    },
  );

  it("passes an explicit config only to service install", async () => {
    const calls: { action: ServiceAction; configPath?: string }[] = [];
    const cliServices = serviceServices({ calls });

    await runCli(["service", "install", "--config", "/tmp/runtime.yaml", "--json"], cliServices);
    await runCli(["service", "start", "--json"], cliServices);

    expect(calls).toEqual([
      { action: "install", configPath: "/tmp/runtime.yaml" },
      { action: "start" },
    ]);
  });

  it("builds installed definitions with the real CLI entry and absolute Node executable", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-runtime-cli-service-")));
    const cliTarget = path.join(root, "cli.js");
    const cliLink = path.join(root, "toss-runtime");
    const configPath = path.join(root, "config.yaml");
    await writeFile(cliTarget, "", { mode: 0o600 });
    await symlink(cliTarget, cliLink);
    let managerOptions:
      | { readonly nodePath: string; readonly cliPath: string; readonly configPath: string }
      | undefined;
    try {
      const mainServices = createMainServices({
        platform,
        env: {},
        home: root,
        signals: { subscribe: () => () => undefined },
        pid: 4217,
        now: () => new Date("2026-08-19T10:00:00.000Z"),
        createServiceInstanceId: () => healthySocketStatus.service_instance_id,
        resolveExecutableHash: () => Promise.resolve("a".repeat(64)),
        sendReady: () => undefined,
        nodePath: process.execPath,
        cliPath: cliLink,
        uid: 501,
        ensureServiceConfig: () => Promise.resolve(configPath),
        createServiceManager: (options) => {
          managerOptions = options;
          return {
            install: () => Promise.resolve(activeManagerStatus),
            start: () => Promise.resolve(activeManagerStatus),
            stop: () => Promise.resolve(activeManagerStatus),
            restart: () => Promise.resolve(activeManagerStatus),
            status: () => Promise.resolve(activeManagerStatus),
            uninstall: () => Promise.resolve(absentManagerStatus),
            installedConfigPath: () => Promise.resolve(configPath),
          };
        },
      });

      await mainServices.manageService?.("install", configPath);

      expect(managerOptions).toMatchObject({
        nodePath: process.execPath,
        cliPath: cliTarget,
        configPath,
      });
      expect(path.isAbsolute(managerOptions?.nodePath ?? "")).toBe(true);
      expect(path.isAbsolute(managerOptions?.cliPath ?? "")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an oversized install config before creating or mutating a manager", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-runtime-cli-config-")));
    const configPath = path.join(root, "oversized.yaml");
    const cliPath = path.join(root, "cli.js");
    await writeFile(configPath, oversizedValidYaml(root), { mode: 0o600 });
    await writeFile(cliPath, "", { mode: 0o600 });
    let managerCreations = 0;
    let managerMutations = 0;
    try {
      const mainServices = createMainServices({
        platform,
        env: {},
        home: root,
        signals: { subscribe: () => () => undefined },
        pid: 4217,
        now: () => new Date("2026-08-20T10:00:00.000Z"),
        createServiceInstanceId: () => healthySocketStatus.service_instance_id,
        resolveExecutableHash: () => Promise.resolve("a".repeat(64)),
        sendReady: () => undefined,
        cliPath,
        uid: typeof process.getuid === "function" ? process.getuid() : 501,
        createServiceManager: () => {
          managerCreations += 1;
          return {
            install: () => {
              managerMutations += 1;
              return Promise.resolve(activeManagerStatus);
            },
            start: () => Promise.resolve(activeManagerStatus),
            stop: () => Promise.resolve(activeManagerStatus),
            restart: () => Promise.resolve(activeManagerStatus),
            status: () => Promise.resolve(activeManagerStatus),
            uninstall: () => Promise.resolve(absentManagerStatus),
            installedConfigPath: () => Promise.resolve(configPath),
          };
        },
      });

      const output = await runCli(
        ["service", "install", "--config", configPath, "--json"],
        mainServices,
      );

      expect(output).toMatchObject({ exitCode: 5, stderr: "" });
      expect(JSON.parse(output.stdout)).toMatchObject({
        error: { code: "RUNTIME_CONFIG_INVALID" },
      });
      expect(output.stdout).not.toContain(configPath);
      expect(output.stdout).not.toContain(String(RUNTIME_CONFIG_BYTE_CAP + 1));
      expect(managerCreations).toBe(0);
      expect(managerMutations).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an oversized serve config before supervisor startup", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-runtime-cli-config-")));
    const configPath = path.join(root, "oversized.yaml");
    await writeFile(configPath, oversizedValidYaml(root), { mode: 0o600 });
    let executableHashCalls = 0;
    let signalSubscriptions = 0;
    let readinessCalls = 0;
    try {
      const mainServices = createMainServices({
        platform,
        env: {},
        home: root,
        signals: {
          subscribe: () => {
            signalSubscriptions += 1;
            return () => undefined;
          },
        },
        pid: 4217,
        now: () => new Date("2026-08-20T10:00:00.000Z"),
        createServiceInstanceId: () => healthySocketStatus.service_instance_id,
        resolveExecutableHash: () => {
          executableHashCalls += 1;
          return Promise.reject(new Error("must-not-persist after config load"));
        },
        sendReady: () => {
          readinessCalls += 1;
        },
      });

      const output = await runCli(["serve", "--config", configPath, "--json"], mainServices);

      expect(output).toMatchObject({ exitCode: 5, stderr: "" });
      expect(JSON.parse(output.stdout)).toMatchObject({
        error: { code: "RUNTIME_CONFIG_INVALID" },
      });
      expect(output.stdout).not.toContain(configPath);
      expect(output.stdout).not.toContain("must-not-persist");
      expect(executableHashCalls).toBe(0);
      expect(signalSubscriptions).toBe(0);
      expect(readinessCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds doctor config loading to createMainServices env and home", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-runtime-cli-doctor-")));
    const injectedHome = path.join(root, "injected-home");
    const explicitPath = path.join(root, "operator-config.yaml");
    const calls: unknown[] = [];
    vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "global-config-root"));
    try {
      const mainServices = createMainServices({
        platform,
        env: { XDG_CONFIG_HOME: path.join(root, "injected-config-root") },
        home: injectedHome,
        signals: { subscribe: () => () => undefined },
        pid: 4217,
        now: () => new Date("2026-08-19T10:00:00.000Z"),
        createServiceInstanceId: () => healthySocketStatus.service_instance_id,
        resolveExecutableHash: () => Promise.resolve("a".repeat(64)),
        sendReady: () => undefined,
        loadConfig: (options) => {
          calls.push(options);
          return Promise.resolve({
            config: { ...defaultConfig("linux", injectedHome), mode: "production" },
            source: "injected",
          });
        },
      });

      const output = await runCli(["doctor", "--config", explicitPath, "--json"], mainServices);

      expect(output.exitCode).toBe(5);
      expect(calls).toEqual([
        {
          explicitPath,
          env: { XDG_CONFIG_HOME: path.join(root, "injected-config-root") },
          platform: "linux",
          home: injectedHome,
        },
      ]);
      expect(doctorChecks(output)).toContainEqual({
        id: "config",
        status: "PASS",
        message: "Configuration source: injected",
      });
      expect(doctorChecks(output)).toContainEqual({
        id: "execution-capabilities",
        status: "FAIL",
        message:
          "Execution providers, skills, MCP, and orchestration are not installed in the baseline wave",
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [["service", "--json"], "Missing service action"],
    [["service", "launch", "--json"], "Unknown service action"],
    [["service", "start", "extra", "--json"], "Unknown option for service start: <argument>"],
    [
      ["service", "start", "--config", "/tmp/runtime.yaml", "--json"],
      "Unknown option for service start: --config",
    ],
    [["service", "install", "--config", "--json"], "Missing value for --config"],
    [["service", "install", "--json", "--json"], "Duplicate option: --json"],
    [
      ["service", "install", "--config", "/tmp/one", "--config", "/tmp/two", "--json"],
      "Duplicate option: --config",
    ],
    [
      ["service", "status", "--unknown=must-not-persist", "--json"],
      "Unknown option for service status: --unknown",
    ],
    [
      ["service", "status", "--api-token=must-not-persist", "--json"],
      "Unknown option for service status: --api-token",
    ],
  ])("rejects malformed service grammar %# without reflecting values", async (argv, message) => {
    const output = await runCli(argv, serviceServices());
    expect(output).toMatchObject({ exitCode: 2, stderr: "" });
    expect(output.stdout).toContain(message);
    expect(output.stdout).not.toContain("must-not-persist");
    expect(output.stdout).not.toContain("/tmp/one");
    expect(output.stdout).not.toContain("/tmp/two");
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
  });

  it.each([
    ["human", ["service", "ClientSecret=must-not-persist"]],
    ["JSON", ["service", "api-token=must-not-persist", "--json"]],
  ])(
    "rejects credential-shaped positional service actions safely in %s mode",
    async (_mode, argv) => {
      const output = await runCli(argv, serviceServices());
      expect(output.exitCode).toBe(2);
      expect(`${output.stdout}${output.stderr}`).toContain("Unknown service action");
      expect(`${output.stdout}${output.stderr}`).not.toContain("must-not-persist");
      expect(`${output.stdout}${output.stderr}`).not.toContain("ClientSecret");
      expect(`${output.stdout}${output.stderr}`).not.toContain("api-token");
      expect(`${output.stdout}${output.stderr}`).not.toContain("=");
      if (argv.includes("--json")) {
        expect(output.stderr).toBe("");
        expect(output.stdout.trim().split("\n")).toHaveLength(1);
        expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, exit_code: 2 });
      } else {
        expect(output.stdout).toBe("");
      }
    },
  );

  it("rejects service management on an unsupported platform before calling the manager", async () => {
    const calls: { action: ServiceAction; configPath?: string }[] = [];
    const output = await runCli(["service", "status", "--json"], {
      ...serviceServices({ calls }),
      platform: { os: "win32", arch: "x64", node: "22.23.1" },
    });

    expect(calls).toEqual([]);
    expect(output).toMatchObject({ exitCode: 5, stderr: "" });
    expect(JSON.parse(output.stdout)).toMatchObject({
      command: "service status",
      ok: false,
      error: { code: "RUNTIME_PLATFORM_UNSUPPORTED" },
    });
  });

  it.each([
    ["RUNTIME_SERVICE_ALREADY_RUNNING", 6],
    ["RUNTIME_SERVICE_CONTROL_CONFLICT", 6],
    ["RUNTIME_SERVICE_PATH_UNSAFE", 5],
    ["RUNTIME_SERVICE_DEFINITION_UNSAFE", 5],
    ["RUNTIME_SERVICE_MANAGER_UNAVAILABLE", 69],
  ] as const)("maps %s to stable exit %i", async (code, exitCode) => {
    const output = await runCli(
      ["service", "start", "--json"],
      serviceServices({ managerError: code }),
    );
    expect(output).toMatchObject({ exitCode, stderr: "" });
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      command: "service start",
      ok: false,
      exit_code: exitCode,
      error: { code },
    });
  });

  it("maps unexpected service failures to one safe internal result", async () => {
    const output = await runCli(
      ["service", "restart", "--json"],
      serviceServices({ managerError: new Error("private failure at /home/test") }),
    );
    expect(output).toMatchObject({ exitCode: 70, stderr: "" });
    expect(output.stdout).not.toContain("/home/test");
    expect(JSON.parse(output.stdout)).toMatchObject({
      command: "service restart",
      ok: false,
      error: { code: "RUNTIME_SERVICE_FAILED" },
    });
  });

  it("reports an absent service as successful status data", async () => {
    const output = await runCli(
      ["service", "status", "--json"],
      serviceServices({
        manager: absentManagerStatus,
        socket: new RuntimeServiceError("RUNTIME_SERVICE_UNAVAILABLE"),
        identity: null,
      }),
    );
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: true,
      data: { installed: false, socket: null, identity_matches: null },
    });
  });

  it("fails absent start and restart while keeping stop and uninstall idempotent", async () => {
    const cliServices = serviceServices({ manager: absentManagerStatus });
    const start = await runCli(["service", "start", "--json"], cliServices);
    const restart = await runCli(["service", "restart"], cliServices);
    const stop = await runCli(["service", "stop", "--json"], cliServices);
    const uninstall = await runCli(["service", "uninstall"], cliServices);

    expect(start).toMatchObject({ exitCode: 69, stderr: "" });
    expect(start.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(start.stdout)).toMatchObject({
      command: "service start",
      ok: false,
      exit_code: 69,
      error: {
        code: "RUNTIME_SERVICE_UNAVAILABLE",
        safe_message: "Runtime service is unavailable",
      },
    });
    expect(restart).toEqual({
      exitCode: 69,
      stdout: "",
      stderr: "Runtime service is unavailable\n",
    });
    expect(stop).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stop.stdout)).toMatchObject({ command: "service stop", ok: true });
    expect(uninstall).toMatchObject({
      exitCode: 0,
      stdout: "Runtime service uninstalled\n",
      stderr: "",
    });
  });

  it("reports installed-stopped and crash-backoff as status data, not command failures", async () => {
    for (const manager of [
      { ...activeManagerStatus, active: false },
      { ...activeManagerStatus, active: false, backoff: true, restartCount: 5, lastExitCode: 70 },
    ]) {
      const output = await runCli(
        ["service", "status", "--json"],
        serviceServices({
          manager,
          socket: new RuntimeServiceError("RUNTIME_SERVICE_UNAVAILABLE"),
          identity: null,
        }),
      );
      expect(output.exitCode).toBe(0);
      expect(JSON.parse(output.stdout)).toMatchObject({
        ok: true,
        data: { ...manager, socket: null },
      });
    }
  });

  it("distinguishes an unavailable identity probe from a wrong non-null identity", async () => {
    const unavailableServices = serviceServices({ identity: null });
    const mismatchedServices = serviceServices({
      identity: "018f0f64-7b21-7d4f-8c3d-4a30413d5f99",
    });
    const unavailableStatus = await runCli(["service", "status", "--json"], unavailableServices);
    const mismatchStatus = await runCli(["service", "status", "--json"], mismatchedServices);
    const unavailableDoctor = await runCli(["doctor", "--json"], unavailableServices);
    const mismatchDoctor = await runCli(["doctor", "--json"], mismatchedServices);

    expect(JSON.parse(unavailableStatus.stdout)).toMatchObject({
      ok: true,
      data: {
        identity_matches: null,
        socket_error: "RUNTIME_SERVICE_UNAVAILABLE",
      },
    });
    expect(JSON.parse(mismatchStatus.stdout)).toMatchObject({
      ok: true,
      data: { identity_matches: false, socket_error: null },
    });
    expect(doctorChecks(unavailableDoctor)).toContainEqual({
      id: "service",
      status: "FAIL",
      message: "Runtime service control socket is unavailable",
    });
    expect(doctorChecks(mismatchDoctor)).toContainEqual({
      id: "service",
      status: "FAIL",
      message: "Runtime service socket identity does not match",
    });
  });

  it("renders service success and failure safely in human mode", async () => {
    const success = await runCli(["service", "start"], serviceServices());
    const failure = await runCli(
      ["service", "start"],
      serviceServices({
        managerError: new RuntimeServiceError("RUNTIME_SERVICE_MANAGER_UNAVAILABLE"),
      }),
    );
    expect(success).toMatchObject({ exitCode: 0, stderr: "" });
    expect(success.stdout).toContain("Runtime service started");
    expect(failure).toEqual({
      exitCode: 69,
      stdout: "",
      stderr: "Runtime service manager is unavailable\n",
    });
  });

  it("reports a healthy active matching manager and socket", async () => {
    const output = await runCli(["doctor", "--json"], serviceServices());
    expect(output.exitCode).toBe(0);
    expect(doctorChecks(output)).toContainEqual({
      id: "service",
      status: "PASS",
      message: "Runtime service is active and healthy",
    });
  });

  it("warns for an absent or stopped service in development and fails in production", async () => {
    for (const manager of [absentManagerStatus, { ...activeManagerStatus, active: false }]) {
      const development = await runCli(
        ["doctor", "--json"],
        serviceServices({
          manager,
          socket: new RuntimeServiceError("RUNTIME_SERVICE_UNAVAILABLE"),
          identity: null,
        }),
      );
      const production = await runCli(
        ["doctor", "--json"],
        serviceServices({
          manager,
          socket: new RuntimeServiceError("RUNTIME_SERVICE_UNAVAILABLE"),
          identity: null,
          mode: "production",
        }),
      );
      expect(development.exitCode).toBe(0);
      expect(doctorChecks(development)).toContainEqual({
        id: "service",
        status: "WARN",
        message: manager.installed
          ? "Runtime service is installed but stopped"
          : "Runtime service is not installed",
      });
      expect(production.exitCode).toBe(5);
      expect(doctorChecks(production)).toContainEqual({
        id: "service",
        status: "FAIL",
        message: manager.installed
          ? "Runtime service is installed but stopped"
          : "Runtime service is not installed",
      });
    }
  });

  it("reports crash backoff with safe remediation", async () => {
    const output = await runCli(
      ["doctor", "--json"],
      serviceServices({
        manager: {
          ...activeManagerStatus,
          active: false,
          backoff: true,
          restartCount: 5,
          lastExitCode: 70,
        },
        socket: new RuntimeServiceError("RUNTIME_SERVICE_UNAVAILABLE"),
        identity: null,
      }),
    );
    expect(output.exitCode).toBe(5);
    expect(doctorChecks(output)).toContainEqual({
      id: "service",
      status: "FAIL",
      message: "Runtime service restart backoff is active; inspect service status",
    });
  });

  it("turns terminal systemd start-limit output into a blocking doctor check", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "toss-runtime-cli-start-limit-")),
    );
    const cliPath = path.join(root, "cli.js");
    const configPath = path.join(root, ".config", "toss", "runtime", "config.yaml");
    await writeFile(cliPath, "", { mode: 0o600 });
    const runner = {
      calls: [] as { file: string; args: readonly string[] }[],
      run(file: string, args: readonly string[]) {
        this.calls.push({ file, args: [...args] });
        return Promise.resolve({
          exitCode: 0,
          stdout:
            "LoadState=loaded\nUnitFileState=enabled\nActiveState=failed\nSubState=failed\nResult=start-limit-hit\nNRestarts=5\nExecMainStatus=70\n",
          stderr: "",
        });
      },
    };
    try {
      const installer = createServiceManager({
        platform: "linux",
        home: root,
        env: {},
        uid: 501,
        currentUid: () => 501,
        nodePath: process.execPath,
        cliPath,
        configPath,
        randomSuffix: () => "definition",
        runner,
      });
      await installer.install();
      runner.calls.splice(0);

      const mainServices = createMainServices({
        platform,
        env: {},
        home: root,
        signals: { subscribe: () => () => undefined },
        pid: 4217,
        now: () => new Date("2026-08-20T10:00:00.000Z"),
        createServiceInstanceId: () => healthySocketStatus.service_instance_id,
        resolveExecutableHash: () => Promise.resolve("a".repeat(64)),
        sendReady: () => undefined,
        nodePath: process.execPath,
        cliPath,
        uid: 501,
        loadConfig: () =>
          Promise.resolve({ config: defaultConfig("linux", root), source: "systemd-format-test" }),
        createServiceManager: (options) =>
          createServiceManager({ ...options, currentUid: () => 501, runner }),
      });

      const output = await runCli(["doctor", "--json"], mainServices);

      expect(output.exitCode).toBe(5);
      expect(doctorChecks(output)).toContainEqual({
        id: "service",
        status: "FAIL",
        message: "Runtime service restart backoff is active; inspect service status",
      });
      expect(output.stdout).not.toContain("Result=start-limit-hit");
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders oversized native status integers as safe JSON fallback values", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-runtime-cli-status-")));
    const cliPath = path.join(root, "cli.js");
    const configPath = path.join(root, ".config", "toss", "runtime", "config.yaml");
    const oversized = "9".repeat(400);
    await writeFile(cliPath, "", { mode: 0o600 });
    const runner = {
      run() {
        return Promise.resolve({
          exitCode: 0,
          stdout:
            `LoadState=loaded\nUnitFileState=enabled\nActiveState=inactive\nSubState=dead\n` +
            `Result=success\nNRestarts=${oversized}\nExecMainStatus=${oversized}\n`,
          stderr: "",
        });
      },
    };
    try {
      const installer = createServiceManager({
        platform: "linux",
        home: root,
        env: {},
        uid: 501,
        currentUid: () => 501,
        nodePath: process.execPath,
        cliPath,
        configPath,
        randomSuffix: () => "definition",
        runner,
      });
      await installer.install();
      const mainServices = createMainServices({
        platform,
        env: {},
        home: root,
        signals: { subscribe: () => () => undefined },
        pid: 4217,
        now: () => new Date("2026-08-20T10:00:00.000Z"),
        createServiceInstanceId: () => healthySocketStatus.service_instance_id,
        resolveExecutableHash: () => Promise.resolve("a".repeat(64)),
        sendReady: () => undefined,
        nodePath: process.execPath,
        cliPath,
        uid: 501,
        loadConfig: () =>
          Promise.resolve({ config: defaultConfig("linux", root), source: "status-integer-test" }),
        createServiceManager: (options) =>
          createServiceManager({ ...options, currentUid: () => 501, runner }),
      });

      const output = await runCli(["service", "status", "--json"], mainServices);

      expect(output).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(output.stdout)).toMatchObject({
        command: "service status",
        ok: true,
        data: { restartCount: 0, lastExitCode: null },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "unsafe definition",
      serviceServices({ managerError: "RUNTIME_SERVICE_DEFINITION_UNSAFE" }),
      "Runtime service definition is unsafe",
    ],
    [
      "identity mismatch",
      serviceServices({ identity: "018f0f64-7b21-7d4f-8c3d-4a30413d5f99" }),
      "Runtime service socket identity does not match",
    ],
    [
      "degraded socket",
      serviceServices({ socket: { ...healthySocketStatus, health: "degraded" } }),
      "Runtime service socket health is degraded",
    ],
  ])("fails doctor for %s", async (_name, cliServices, message) => {
    const output = await runCli(["doctor", "--json"], cliServices);
    expect(output.exitCode).toBe(5);
    expect(output.stderr).toBe("");
    expect(doctorChecks(output)).toContainEqual({
      id: "service",
      status: "FAIL",
      message,
    });
  });
});
