import { homedir } from "node:os";

import { loadConfig as loadRuntimeConfig, type RuntimeConfigError } from "../config/load.js";
import type { LoadedConfig } from "../config/types.js";
import { createBaselineCapabilities } from "../protocol/capabilities.js";
import type { JsonValue } from "../protocol/json.js";
import type { RuntimeError } from "../protocol/types.js";
import { PACKAGE_VERSION } from "../version.js";
import { CliUsageError, parseCli, type BaselineCommand } from "./grammar.js";
import { commandResult, renderJson, type CommandResultV1, type ExitCode } from "./result.js";

const HELP = `Usage: toss-runtime <command> [options]

Commands:
  toss-runtime capabilities [--json]
  toss-runtime doctor [--config <path>] [--json]
  toss-runtime serve [--config <path>] [--json]
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
  readonly serve?: (options: { readonly configPath?: string }) => Promise<void>;
}

export interface CliOutput {
  readonly exitCode: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
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

async function doctor(
  command: Extract<BaselineCommand, { name: "doctor" }>,
  services: CliServices,
): Promise<CliOutput> {
  const checks: { id: string; status: "PASS" | "WARN" | "FAIL"; message: string }[] = [];
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
  await services.serve(command.configPath === undefined ? {} : { configPath: command.configPath });
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
  return serve(command, services);
}

export async function main(argv: readonly string[]): Promise<number> {
  const output = await runCli(argv, {
    platform: { os: process.platform, arch: process.arch, node: process.versions.node },
  });
  if (output.stdout.length > 0) process.stdout.write(output.stdout);
  if (output.stderr.length > 0) process.stderr.write(output.stderr);
  return output.exitCode;
}
