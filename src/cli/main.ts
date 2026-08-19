import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  loadConfig as loadRuntimeConfig,
  resolveDefaultConfigPath,
  RuntimeConfigError,
} from "../config/load.js";
import type { LoadedConfig, RuntimeEnvironment } from "../config/types.js";
import type { SignalSource } from "../platform/signals.js";
import { createBaselineCapabilities } from "../protocol/capabilities.js";
import { canonicalJson, type JsonValue } from "../protocol/json.js";
import type { RuntimeError } from "../protocol/types.js";
import { createProcessSignalSource } from "../platform/signals.js";
import {
  createServiceControlServer,
  probeServiceIdentity as probeRuntimeServiceIdentity,
  requestServiceStatus as requestRuntimeServiceStatus,
} from "../service/control.js";
import type { ServiceStatusV1 } from "../service/contracts.js";
import { ensureServiceConfig } from "../service/definition-store.js";
import { RuntimeServiceError } from "../service/errors.js";
import { acquireInstanceLock, type ProcessLiveness } from "../service/instance-lock.js";
import type { ServiceOutcome } from "../service/lifecycle.js";
import {
  createServiceManager,
  type CreateServiceManagerOptions,
  type ServiceManager,
  type ServiceManagerStatus,
} from "../service/manager.js";
import { runSupervisor } from "../service/supervisor.js";
import { PACKAGE_VERSION } from "../version.js";
import { CliUsageError, parseCli, type BaselineCommand, type ServiceAction } from "./grammar.js";
import {
  commandResult,
  renderJson,
  serviceErrorExitCode,
  type CommandResultV1,
  type ExitCode,
} from "./result.js";

const HELP = `Usage: toss-runtime <command> [options]

Commands:
  toss-runtime capabilities [--json]
  toss-runtime doctor [--config <path>] [--json]
  toss-runtime serve [--config <path>] [--json]
  toss-runtime service install [--config <absolute-path>] [--json]
  toss-runtime service start [--json]
  toss-runtime service stop [--json]
  toss-runtime service restart [--json]
  toss-runtime service status [--json]
  toss-runtime service uninstall [--json]
  toss-runtime --version
`;

export interface RuntimePlatform {
  readonly os: string;
  readonly arch: string;
  readonly node: string;
}

export interface CliServices {
  readonly platform: RuntimePlatform;
  readonly loadConfig?: (options: {
    readonly explicitPath?: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly platform: "darwin" | "linux";
    readonly home: string;
  }) => Promise<LoadedConfig>;
  readonly serve?: (options: { readonly configPath?: string }) => Promise<ServiceOutcome>;
  readonly manageService?: (
    action: ServiceAction,
    configPath?: string,
  ) => Promise<ServiceManagerStatus>;
  readonly requestServiceStatus?: () => Promise<ServiceStatusV1>;
  readonly probeServiceIdentity?: () => Promise<string | null>;
}

export interface CliOutput {
  readonly exitCode: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecutableHashOptions {
  readonly nodePath: string;
  readonly cliPath: string;
}

export interface CreateMainServicesOptions {
  readonly platform: RuntimePlatform;
  readonly env: RuntimeEnvironment;
  readonly home: string;
  readonly signals: SignalSource;
  readonly pid: number;
  readonly now: () => Date;
  readonly createServiceInstanceId: () => string;
  readonly resolveExecutableHash: () => Promise<string>;
  readonly sendReady: () => void;
  readonly nodePath?: string;
  readonly cliPath?: string;
  readonly uid?: number;
  readonly randomSuffix?: () => string;
  readonly ensureServiceConfig?: typeof ensureServiceConfig;
  readonly createServiceManager?: (options: CreateServiceManagerOptions) => ServiceManager;
  readonly requestServiceStatus?: typeof requestRuntimeServiceStatus;
  readonly probeServiceIdentity?: typeof probeRuntimeServiceIdentity;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function computeExecutableHash(options: ExecutableHashOptions): Promise<string> {
  try {
    const [nodePath, cliPath] = await Promise.all([
      realpath(options.nodePath),
      realpath(options.cliPath),
    ]);
    const [nodeSha256, cliSha256] = await Promise.all([hashFile(nodePath), hashFile(cliPath)]);
    return createHash("sha256")
      .update(
        canonicalJson({
          node_sha256: nodeSha256,
          cli_sha256: cliSha256,
          package_version: PACKAGE_VERSION,
        }),
        "utf8",
      )
      .digest("hex");
  } catch {
    throw new RuntimeServiceError("RUNTIME_SERVICE_UNAVAILABLE");
  }
}

function processLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
      ? "dead"
      : "unknown";
  }
}

export function createMainServices(options: CreateMainServicesOptions): CliServices {
  const serviceManager = async (configPath: string): Promise<ServiceManager> => {
    if (!isSupportedPlatform(options.platform)) {
      throw new RuntimeServiceError("RUNTIME_SERVICE_UNAVAILABLE");
    }
    let cliPath: string;
    try {
      cliPath = await realpath(
        options.cliPath ?? process.argv[1] ?? fileURLToPath(import.meta.url),
      );
    } catch {
      throw new RuntimeServiceError("RUNTIME_SERVICE_PATH_UNSAFE");
    }
    const uid =
      options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    if (uid === undefined) throw new RuntimeServiceError("RUNTIME_SERVICE_MANAGER_UNAVAILABLE");
    return (options.createServiceManager ?? createServiceManager)({
      platform: options.platform.os,
      home: options.home,
      env: options.env,
      uid,
      nodePath: options.nodePath ?? process.execPath,
      cliPath,
      configPath,
      randomSuffix: options.randomSuffix ?? randomUUID,
    });
  };

  const defaultServiceConfigPath = (): string => {
    if (!isSupportedPlatform(options.platform)) {
      throw new RuntimeServiceError("RUNTIME_SERVICE_UNAVAILABLE");
    }
    return resolveDefaultConfigPath(options.platform.os, options.home, options.env);
  };

  const installedServiceConfigPath = async (): Promise<string> => {
    const defaultPath = defaultServiceConfigPath();
    const manager = await serviceManager(defaultPath);
    return (await manager.installedConfigPath()) ?? defaultPath;
  };

  const serviceSocketPath = async (): Promise<string> => {
    if (!isSupportedPlatform(options.platform)) {
      throw new RuntimeServiceError("RUNTIME_SERVICE_UNAVAILABLE");
    }
    const configPath = await installedServiceConfigPath();
    const loaded = await loadRuntimeConfig({
      explicitPath: configPath,
      env: options.env,
      platform: options.platform.os,
      home: options.home,
    });
    return loaded.config.paths.socket;
  };

  return {
    platform: options.platform,
    manageService: async (action, configPath) => {
      if (!isSupportedPlatform(options.platform)) {
        throw new RuntimeServiceError("RUNTIME_SERVICE_UNAVAILABLE");
      }
      const selectedConfigPath =
        action === "install"
          ? await (options.ensureServiceConfig ?? ensureServiceConfig)({
              ...(configPath === undefined ? {} : { explicitPath: configPath }),
              platform: options.platform.os,
              home: options.home,
              env: options.env,
              randomSuffix: options.randomSuffix ?? randomUUID,
            })
          : defaultServiceConfigPath();
      const manager = await serviceManager(selectedConfigPath);
      return manager[action]();
    },
    requestServiceStatus: async () =>
      (options.requestServiceStatus ?? requestRuntimeServiceStatus)({
        socketPath: await serviceSocketPath(),
      }),
    probeServiceIdentity: async () =>
      (options.probeServiceIdentity ?? probeRuntimeServiceIdentity)({
        socketPath: await serviceSocketPath(),
      }),
    serve: async ({ configPath }) => {
      if (!isSupportedPlatform(options.platform)) {
        throw new RuntimeServiceError("RUNTIME_SERVICE_UNAVAILABLE");
      }
      const loaded = await loadRuntimeConfig({
        ...(configPath === undefined ? {} : { explicitPath: configPath }),
        env: options.env,
        platform: options.platform.os,
        home: options.home,
      });
      const executableHash = await options.resolveExecutableHash();
      return runSupervisor({
        loaded,
        signals: options.signals,
        pid: options.pid,
        now: options.now,
        createServiceInstanceId: options.createServiceInstanceId,
        executableHash,
        processProbe: { liveness: processLiveness },
        socketProbe: {
          identify: (socketPath) => probeRuntimeServiceIdentity({ socketPath }),
        },
        recoveryParticipants: [
          {
            recover: () => Promise.resolve(),
            stopIntake: () => undefined,
            flush: () => Promise.resolve(),
          },
        ],
        // Durable interruption recording is introduced by the run-journal issue.
        interruptionRecorder: { interruptActive: () => Promise.resolve() },
        acquireLock: acquireInstanceLock,
        createControlServer: createServiceControlServer,
        onReady: () => {
          try {
            options.sendReady();
          } catch {
            // Readiness diagnostics cannot affect the supervised lifecycle.
          }
        },
      });
    },
  };
}

function runtimeError(
  code: string,
  category: RuntimeError["category"],
  safeMessage: string,
): RuntimeError {
  return { code, category, retryable: false, safe_message: safeMessage };
}

function jsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function outputForResult(result: CommandResultV1, json: boolean, human: string): CliOutput {
  if (json) return { exitCode: result.exit_code, stdout: renderJson(result), stderr: "" };
  return result.ok
    ? { exitCode: result.exit_code, stdout: `${human}\n`, stderr: "" }
    : {
        exitCode: result.exit_code,
        stdout: "",
        stderr: `${result.error?.safe_message ?? "Command failed"}\n`,
      };
}

function isSupportedPlatform(
  platform: RuntimePlatform,
): platform is RuntimePlatform & { os: "darwin" | "linux" } {
  return platform.os === "darwin" || platform.os === "linux";
}

function isSupportedNode(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 24 || (major === 22 && minor >= 23);
}

function capabilities(
  command: Extract<BaselineCommand, { name: "capabilities" }>,
  services: CliServices,
): CliOutput {
  if (!isSupportedPlatform(services.platform)) {
    const result = commandResult({
      command: command.name,
      exitCode: 5,
      error: runtimeError(
        "RUNTIME_PLATFORM_UNSUPPORTED",
        "unsupported-capability",
        "Platform is unsupported",
      ),
    });
    return outputForResult(result, command.json, "");
  }
  const document = createBaselineCapabilities(services.platform);
  const result = commandResult({ command: command.name, exitCode: 0, data: jsonValue(document) });
  return outputForResult(
    result,
    command.json,
    `Runtime ${PACKAGE_VERSION} (${document.protocol_version})`,
  );
}

interface SocketStatusSnapshot {
  readonly socket: ServiceStatusV1 | null;
  readonly identityMatches: boolean | null;
  readonly errorCode: string | null;
}

async function socketStatus(services: CliServices): Promise<SocketStatusSnapshot> {
  if (services.requestServiceStatus === undefined || services.probeServiceIdentity === undefined) {
    return { socket: null, identityMatches: null, errorCode: "RUNTIME_SERVICE_UNAVAILABLE" };
  }
  try {
    const socket = await services.requestServiceStatus();
    const identity = await services.probeServiceIdentity();
    return {
      socket,
      identityMatches: identity === socket.service_instance_id,
      errorCode: null,
    };
  } catch (error) {
    return {
      socket: null,
      identityMatches: null,
      errorCode: error instanceof RuntimeServiceError ? error.code : "RUNTIME_SERVICE_UNAVAILABLE",
    };
  }
}

function serviceHumanMessage(action: ServiceAction, status: ServiceManagerStatus): string {
  if (action === "install") return "Runtime service installed";
  if (action === "start") return "Runtime service started";
  if (action === "stop") return "Runtime service stopped";
  if (action === "restart") return "Runtime service restarted";
  if (action === "uninstall") return "Runtime service uninstalled";
  if (!status.installed) return "Runtime service is not installed";
  if (!status.active) return "Runtime service is installed but stopped";
  return "Runtime service is active";
}

function serviceFailure(commandName: string, json: boolean, error: unknown): CliOutput {
  if (error instanceof RuntimeConfigError) {
    const safeMessage =
      error.code === "RUNTIME_CONFIG_UNAVAILABLE"
        ? "Runtime configuration is unavailable"
        : "Runtime configuration is invalid or unsafe";
    return outputForResult(
      commandResult({
        command: commandName,
        exitCode: 5,
        error: runtimeError(error.code, "invalid-input", safeMessage),
      }),
      json,
      "",
    );
  }
  if (error instanceof RuntimeServiceError) {
    return outputForResult(
      commandResult({
        command: commandName,
        exitCode: serviceErrorExitCode(error.code),
        error: {
          code: error.code,
          category: error.category,
          retryable: error.retryable,
          safe_message: error.safe_message,
        },
      }),
      json,
      "",
    );
  }
  return outputForResult(
    commandResult({
      command: commandName,
      exitCode: 70,
      error: runtimeError("RUNTIME_SERVICE_FAILED", "internal", "Runtime service command failed"),
    }),
    json,
    "",
  );
}

async function service(
  command: Extract<BaselineCommand, { name: "service" }>,
  services: CliServices,
): Promise<CliOutput> {
  const commandName = `service ${command.action}`;
  if (!isSupportedPlatform(services.platform)) {
    return outputForResult(
      commandResult({
        command: commandName,
        exitCode: 5,
        error: runtimeError(
          "RUNTIME_PLATFORM_UNSUPPORTED",
          "unsupported-capability",
          "Platform is unsupported",
        ),
      }),
      command.json,
      "",
    );
  }
  if (services.manageService === undefined) {
    return serviceFailure(
      commandName,
      command.json,
      new RuntimeServiceError("RUNTIME_SERVICE_MANAGER_UNAVAILABLE"),
    );
  }

  try {
    const manager = await services.manageService(command.action, command.configPath);
    const snapshot =
      command.action === "status" && manager.active
        ? await socketStatus(services)
        : { socket: null, identityMatches: null, errorCode: null };
    const result = commandResult({
      command: commandName,
      exitCode: 0,
      data: jsonValue({
        ...manager,
        socket: snapshot.socket,
        identity_matches: snapshot.identityMatches,
        socket_error: snapshot.errorCode,
      }),
    });
    return outputForResult(result, command.json, serviceHumanMessage(command.action, manager));
  } catch (error) {
    return serviceFailure(commandName, command.json, error);
  }
}

type DoctorCheck = Readonly<{
  id: string;
  status: "PASS" | "WARN" | "FAIL";
  message: string;
}>;

async function serviceDoctorCheck(
  production: boolean,
  services: CliServices,
): Promise<DoctorCheck | null> {
  if (services.manageService === undefined) return null;
  let manager: ServiceManagerStatus;
  try {
    manager = await services.manageService("status");
  } catch (error) {
    return {
      id: "service",
      status: "FAIL",
      message:
        error instanceof RuntimeServiceError
          ? error.safe_message
          : "Runtime service status is unavailable",
    };
  }

  if (manager.backoff) {
    return {
      id: "service",
      status: "FAIL",
      message: "Runtime service restart backoff is active; inspect service status",
    };
  }
  if (!manager.installed) {
    return {
      id: "service",
      status: production ? "FAIL" : "WARN",
      message: "Runtime service is not installed",
    };
  }
  if (!manager.active) {
    return {
      id: "service",
      status: production ? "FAIL" : "WARN",
      message: "Runtime service is installed but stopped",
    };
  }

  const snapshot = await socketStatus(services);
  if (snapshot.socket === null) {
    return {
      id: "service",
      status: "FAIL",
      message:
        snapshot.errorCode === "RUNTIME_SERVICE_PATH_UNSAFE"
          ? "Runtime service path is unsafe"
          : "Runtime service control socket is unavailable",
    };
  }
  if (snapshot.socket.health !== "healthy" || !snapshot.socket.accepting) {
    return {
      id: "service",
      status: "FAIL",
      message: "Runtime service socket health is degraded",
    };
  }
  if (snapshot.identityMatches !== true) {
    return {
      id: "service",
      status: "FAIL",
      message: "Runtime service socket identity does not match",
    };
  }
  return {
    id: "service",
    status: "PASS",
    message: "Runtime service is active and healthy",
  };
}

async function doctor(
  command: Extract<BaselineCommand, { name: "doctor" }>,
  services: CliServices,
): Promise<CliOutput> {
  const checks: DoctorCheck[] = [];
  checks.push({ id: "package", status: "PASS", message: `Runtime package ${PACKAGE_VERSION}` });
  const platformSupported = isSupportedPlatform(services.platform);
  const nodeSupported = isSupportedNode(services.platform.node);
  checks.push({
    id: "platform",
    status: platformSupported && nodeSupported ? "PASS" : "FAIL",
    message:
      platformSupported && nodeSupported
        ? "Supported Node and operating system"
        : "Node or operating system is unsupported",
  });

  let loaded: LoadedConfig | null = null;
  if (platformSupported) {
    try {
      loaded = await (services.loadConfig ?? loadRuntimeConfig)({
        ...(command.configPath === undefined ? {} : { explicitPath: command.configPath }),
        env: process.env,
        platform: services.platform.os,
        home: homedir(),
      });
      checks.push({
        id: "config",
        status: "PASS",
        message: `Configuration source: ${loaded.source}`,
      });
    } catch (error) {
      const code = (error as Partial<RuntimeConfigError>).code;
      checks.push({ id: "config", status: "FAIL", message: code ?? "Configuration is invalid" });
    }
  } else {
    checks.push({
      id: "config",
      status: "FAIL",
      message: "Configuration cannot be evaluated on this platform",
    });
  }

  const production = loaded?.config.mode === "production";
  if (platformSupported && loaded !== null) {
    const serviceCheck = await serviceDoctorCheck(production, services);
    if (serviceCheck !== null) checks.push(serviceCheck);
  }
  checks.push({
    id: "execution-capabilities",
    status: production ? "FAIL" : "WARN",
    message:
      "Execution providers, skills, MCP, and orchestration are not installed in the baseline wave",
  });
  const healthy = checks.every((check) => check.status !== "FAIL");
  const data = jsonValue({ healthy, checks });
  const result = commandResult({
    command: command.name,
    exitCode: healthy ? 0 : 5,
    data,
    ...(healthy
      ? {}
      : {
          error: runtimeError(
            "RUNTIME_DOCTOR_FAILED",
            "unsupported-capability",
            "Runtime doctor found blocking checks",
          ),
        }),
  });
  const human = checks.map((check) => `${check.status} ${check.id}: ${check.message}`).join("\n");
  return outputForResult(result, command.json, human);
}

async function serve(
  command: Extract<BaselineCommand, { name: "serve" }>,
  services: CliServices,
): Promise<CliOutput> {
  if (services.serve === undefined) {
    return outputForResult(
      commandResult({
        command: command.name,
        exitCode: 69,
        error: runtimeError(
          "RUNTIME_SERVE_UNAVAILABLE",
          "unavailable",
          "Runtime service lifecycle is unavailable",
        ),
      }),
      command.json,
      "",
    );
  }
  let outcome: ServiceOutcome;
  try {
    outcome = await services.serve(
      command.configPath === undefined ? {} : { configPath: command.configPath },
    );
  } catch (error) {
    if (error instanceof RuntimeConfigError) {
      const safeMessage =
        error.code === "RUNTIME_CONFIG_UNAVAILABLE"
          ? "Runtime configuration is unavailable"
          : "Runtime configuration is invalid or unsafe";
      return outputForResult(
        commandResult({
          command: command.name,
          exitCode: 5,
          error: runtimeError(error.code, "invalid-input", safeMessage),
        }),
        command.json,
        "",
      );
    }
    if (error instanceof RuntimeServiceError) {
      return serviceFailure(command.name, command.json, error);
    }
    return outputForResult(
      commandResult({
        command: command.name,
        exitCode: 70,
        error: runtimeError(
          "RUNTIME_SERVE_FAILED",
          "internal",
          "Runtime service stopped unexpectedly",
        ),
      }),
      command.json,
      "",
    );
  }
  if (outcome.forced) {
    return outputForResult(
      commandResult({
        command: command.name,
        exitCode: 70,
        error: runtimeError(
          "RUNTIME_SHUTDOWN_TIMEOUT",
          "timeout",
          "Runtime shutdown exceeded its deadline",
        ),
      }),
      command.json,
      "",
    );
  }
  return outputForResult(
    commandResult({ command: command.name, exitCode: 0 }),
    command.json,
    "Runtime stopped",
  );
}

function usageOutput(argv: readonly string[], error: CliUsageError): CliOutput {
  const json = argv.includes("--json");
  const result = commandResult({
    command: "usage",
    exitCode: 2,
    error: runtimeError(error.code, "invalid-input", error.message),
  });
  return outputForResult(result, json, "");
}

export async function runCli(argv: readonly string[], services: CliServices): Promise<CliOutput> {
  let command: BaselineCommand;
  try {
    command = parseCli(argv);
  } catch (error) {
    if (error instanceof CliUsageError) return usageOutput(argv, error);
    throw error;
  }
  if (command.name === "help") return { exitCode: 0, stdout: HELP, stderr: "" };
  if (command.name === "version")
    return { exitCode: 0, stdout: `${PACKAGE_VERSION}\n`, stderr: "" };
  if (command.name === "capabilities") return capabilities(command, services);
  if (command.name === "doctor") return doctor(command, services);
  if (command.name === "service") return service(command, services);
  return serve(command, services);
}

export async function main(argv: readonly string[]): Promise<number> {
  const platform = { os: process.platform, arch: process.arch, node: process.versions.node };
  let output: CliOutput;
  try {
    output = await runCli(
      argv,
      createMainServices({
        platform,
        env: process.env,
        home: homedir(),
        signals: createProcessSignalSource(),
        pid: process.pid,
        now: () => new Date(),
        createServiceInstanceId: randomUUID,
        nodePath: process.execPath,
        cliPath: process.argv[1] ?? fileURLToPath(import.meta.url),
        resolveExecutableHash: () =>
          computeExecutableHash({
            nodePath: process.execPath,
            cliPath: process.argv[1] ?? fileURLToPath(import.meta.url),
          }),
        sendReady: () => {
          if (process.connected && typeof process.send === "function") {
            process.send({ type: "toss-runtime-ready" }, () => undefined);
          }
        },
      }),
    );
  } catch {
    output = outputForResult(
      commandResult({
        command: argv[0] ?? "internal",
        exitCode: 70,
        error: runtimeError("RUNTIME_INTERNAL", "internal", "Runtime command failed internally"),
      }),
      argv.includes("--json"),
      "",
    );
  }
  if (output.stdout.length > 0) process.stdout.write(output.stdout);
  if (output.stderr.length > 0) process.stderr.write(output.stderr);
  return output.exitCode;
}
