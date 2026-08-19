import path from "node:path";

import {
  ProcessCommandRunner,
  type CommandResult,
  type CommandRunner,
} from "../platform/commands.js";
import type { RuntimeEnvironment, RuntimePlatform } from "../config/types.js";
import { renderServiceDefinition } from "./definition.js";
import {
  readPrivateRegularFile,
  removeOwnedDefinition,
  writePrivateAtomic,
} from "./definition-store.js";
import { RuntimeServiceError } from "./errors.js";
import { resolveServicePaths, SERVICE_LABEL, SYSTEMD_UNIT } from "./paths.js";

export interface ServiceManagerStatus {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly backoff: boolean;
  readonly restartCount: number;
  readonly lastExitCode: number | null;
}

export interface ServiceManager {
  install(): Promise<ServiceManagerStatus>;
  start(): Promise<ServiceManagerStatus>;
  stop(): Promise<ServiceManagerStatus>;
  restart(): Promise<ServiceManagerStatus>;
  status(): Promise<ServiceManagerStatus>;
  uninstall(): Promise<ServiceManagerStatus>;
}

export interface CreateServiceManagerOptions {
  readonly platform: RuntimePlatform;
  readonly home: string;
  readonly env: RuntimeEnvironment;
  readonly uid: number;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly configPath: string;
  readonly randomSuffix: () => string;
  readonly runner?: CommandRunner;
}

const EMPTY_STATUS: ServiceManagerStatus = {
  installed: false,
  enabled: false,
  active: false,
  backoff: false,
  restartCount: 0,
  lastExitCode: null,
};

const LINUX_EXECUTABLE = "/usr/bin/systemctl";
const DARWIN_EXECUTABLE = "/bin/launchctl";
const MAX_STATUS_OUTPUT_CHARS = 65_536;

function definitionUnsafe(): never {
  throw new RuntimeServiceError("RUNTIME_SERVICE_DEFINITION_UNSAFE");
}

function definitionError(error: unknown): never {
  if (error instanceof RuntimeServiceError) definitionUnsafe();
  definitionUnsafe();
}

function fixedStatus(installed: boolean, enabled: boolean, active: boolean): ServiceManagerStatus {
  return { installed, enabled, active, backoff: false, restartCount: 0, lastExitCode: null };
}

function nativeIdentity(uid: number): string {
  return `gui/${uid}/${SERVICE_LABEL}`;
}

function definitionEnvironment(
  env: RuntimeEnvironment,
): Readonly<Partial<Record<"LANG" | "LC_ALL" | "TZ", string>>> {
  const environment: Partial<Record<"LANG" | "LC_ALL" | "TZ", string>> = {};
  for (const key of ["LANG", "LC_ALL", "TZ"] as const) {
    const value = env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function isUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

type IdempotentCommandState = "none" | "absent" | "already-loaded";

function hasKnownAbsentService(result: CommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`.slice(0, MAX_STATUS_OUTPUT_CHARS);
  return (
    /(?:^|\n)LoadState=not-found(?:\n|$)/.test(output) ||
    /(?:could not find service|unit .* could not be found|service not found|not loaded)/i.test(
      output,
    )
  );
}

function hasAlreadyLoadedService(result: CommandResult): boolean {
  return /service already loaded/i.test(
    `${result.stdout}\n${result.stderr}`.slice(0, MAX_STATUS_OUTPUT_CHARS),
  );
}

function parseProperties(output: string): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  for (const line of output.slice(0, MAX_STATUS_OUTPUT_CHARS).split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) properties.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return properties;
}

function parseNonnegativeInteger(value: string | undefined): number {
  return value !== undefined && /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : 0;
}

function parseExitCode(value: string | undefined): number | null {
  return value !== undefined && /^-?(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : null;
}

function linuxStatus(result: CommandResult): ServiceManagerStatus {
  const properties = parseProperties(result.stdout);
  if (properties.get("LoadState") === "not-found") return EMPTY_STATUS;
  const subState = properties.get("SubState") ?? "";
  return {
    installed: properties.get("LoadState") === "loaded",
    enabled: properties.get("UnitFileState") === "enabled",
    active: properties.get("ActiveState") === "active",
    backoff: subState === "auto-restart" || subState === "start-limit-hit",
    restartCount: parseNonnegativeInteger(properties.get("NRestarts")),
    lastExitCode: parseExitCode(properties.get("ExecMainStatus")),
  };
}

function darwinStatus(result: CommandResult): ServiceManagerStatus {
  const output = result.stdout.slice(0, MAX_STATUS_OUTPUT_CHARS);
  const state = /^\s*state\s*=\s*(.+)$/im.exec(output)?.[1]?.trim();
  const runs = /^\s*runs\s*=\s*([0-9]+)\s*$/im.exec(output)?.[1];
  const exit = /^\s*last exit code\s*=\s*(-?[0-9]+)\s*$/im.exec(output)?.[1];
  return {
    installed: true,
    enabled: true,
    active: state === "running",
    backoff: state === "waiting" && /throttl/i.test(output),
    restartCount: parseNonnegativeInteger(runs),
    lastExitCode: parseExitCode(exit),
  };
}

class NativeServiceManager implements ServiceManager {
  private readonly paths;
  private readonly definition: Uint8Array;

  constructor(private readonly options: CreateServiceManagerOptions) {
    try {
      if (
        !Number.isSafeInteger(options.uid) ||
        options.uid < 0 ||
        !path.isAbsolute(options.home) ||
        !path.isAbsolute(options.nodePath) ||
        !path.isAbsolute(options.cliPath) ||
        !path.isAbsolute(options.configPath)
      ) {
        definitionUnsafe();
      }
      this.paths = resolveServicePaths(options);
      this.definition = new TextEncoder().encode(
        renderServiceDefinition({
          platform: options.platform,
          uid: options.uid,
          nodePath: options.nodePath,
          cliPath: options.cliPath,
          configPath: options.configPath,
          environment: definitionEnvironment(options.env),
        }),
      );
    } catch (error) {
      definitionError(error);
    }
  }

  private get runner(): CommandRunner {
    return this.options.runner ?? new ProcessCommandRunner();
  }

  private async installedDefinition(required: boolean): Promise<boolean> {
    let existing: Uint8Array | undefined;
    try {
      existing = await readPrivateRegularFile(this.paths.definition);
    } catch (error) {
      definitionError(error);
    }
    if (existing === undefined) {
      if (required) definitionUnsafe();
      return false;
    }
    if (!Buffer.from(existing).equals(this.definition)) definitionUnsafe();
    return true;
  }

  private async ensureDefinition(): Promise<void> {
    if (await this.installedDefinition(false)) return;
    try {
      await writePrivateAtomic({
        target: this.paths.definition,
        bytes: this.definition,
        randomSuffix: this.options.randomSuffix,
        parentPolicy: "owned-not-writable",
      });
    } catch (error) {
      definitionError(error);
    }
  }

  private async command(
    file: string,
    args: readonly string[],
    idempotentState: IdempotentCommandState = "none",
  ): Promise<CommandResult | undefined> {
    let result: CommandResult;
    try {
      result = await this.runner.run(file, args);
    } catch (error) {
      if (isUnavailable(error))
        throw new RuntimeServiceError("RUNTIME_SERVICE_MANAGER_UNAVAILABLE");
      throw new RuntimeServiceError("RUNTIME_SERVICE_MANAGER_FAILED");
    }
    if (result.exitCode === 0) return result;
    if (
      (idempotentState === "absent" && hasKnownAbsentService(result)) ||
      (idempotentState === "already-loaded" && hasAlreadyLoadedService(result))
    ) {
      return undefined;
    }
    throw new RuntimeServiceError("RUNTIME_SERVICE_MANAGER_FAILED");
  }

  async install(): Promise<ServiceManagerStatus> {
    await this.ensureDefinition();
    if (this.options.platform === "linux") {
      await this.command(LINUX_EXECUTABLE, ["--user", "daemon-reload"]);
      await this.command(LINUX_EXECUTABLE, ["--user", "enable", SYSTEMD_UNIT]);
    }
    return fixedStatus(true, true, false);
  }

  async start(): Promise<ServiceManagerStatus> {
    await this.installedDefinition(true);
    if (this.options.platform === "linux") {
      await this.command(LINUX_EXECUTABLE, ["--user", "start", SYSTEMD_UNIT]);
    } else {
      await this.command(
        DARWIN_EXECUTABLE,
        ["bootstrap", `gui/${this.options.uid}`, this.paths.definition],
        "already-loaded",
      );
    }
    return fixedStatus(true, true, true);
  }

  async stop(): Promise<ServiceManagerStatus> {
    if (this.options.platform === "linux") {
      await this.command(LINUX_EXECUTABLE, ["--user", "stop", SYSTEMD_UNIT], "absent");
    } else {
      await this.command(
        DARWIN_EXECUTABLE,
        ["bootout", nativeIdentity(this.options.uid)],
        "absent",
      );
    }
    return fixedStatus(true, true, false);
  }

  async restart(): Promise<ServiceManagerStatus> {
    await this.installedDefinition(true);
    if (this.options.platform === "linux") {
      await this.command(LINUX_EXECUTABLE, ["--user", "restart", SYSTEMD_UNIT]);
    } else {
      await this.command(DARWIN_EXECUTABLE, ["kickstart", "-k", nativeIdentity(this.options.uid)]);
    }
    return fixedStatus(true, true, true);
  }

  async status(): Promise<ServiceManagerStatus> {
    if (!(await this.installedDefinition(false))) return EMPTY_STATUS;
    if (this.options.platform === "linux") {
      const result = await this.command(
        LINUX_EXECUTABLE,
        [
          "--user",
          "show",
          SYSTEMD_UNIT,
          "--property=LoadState,UnitFileState,ActiveState,SubState,NRestarts,ExecMainStatus",
          "--no-pager",
        ],
        "absent",
      );
      return result === undefined ? EMPTY_STATUS : linuxStatus(result);
    }
    const result = await this.command(
      DARWIN_EXECUTABLE,
      ["print", nativeIdentity(this.options.uid)],
      "absent",
    );
    return result === undefined ? EMPTY_STATUS : darwinStatus(result);
  }

  async uninstall(): Promise<ServiceManagerStatus> {
    if (this.options.platform === "linux") {
      await this.command(LINUX_EXECUTABLE, ["--user", "stop", SYSTEMD_UNIT], "absent");
      await this.command(LINUX_EXECUTABLE, ["--user", "disable", SYSTEMD_UNIT], "absent");
    } else {
      await this.command(
        DARWIN_EXECUTABLE,
        ["bootout", nativeIdentity(this.options.uid)],
        "absent",
      );
    }
    try {
      await removeOwnedDefinition(this.paths.definition);
    } catch (error) {
      definitionError(error);
    }
    if (this.options.platform === "linux") {
      await this.command(LINUX_EXECUTABLE, ["--user", "daemon-reload"]);
    }
    return EMPTY_STATUS;
  }
}

export function createServiceManager(options: CreateServiceManagerOptions): ServiceManager {
  return new NativeServiceManager(options);
}
