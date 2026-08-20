import path from "node:path";

import {
  ProcessCommandRunner,
  type CommandResult,
  type CommandRunner,
} from "../platform/commands.js";
import type { RuntimeEnvironment, RuntimePlatform } from "../config/types.js";
import { renderServiceDefinition } from "./definition.js";
import {
  createPrivateAtomicIfMissing,
  readPrivateRegularFile,
  readPrivateRegularFileSnapshot,
  recoverOwnedDefinitionClaims,
  removeOwnedDefinition,
  type PrivateRegularFileSnapshot,
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
  installedConfigPath(): Promise<string | null>;
}

export interface CreateServiceManagerOptions {
  readonly platform: RuntimePlatform;
  readonly home: string;
  readonly env: RuntimeEnvironment;
  readonly uid: number;
  readonly currentUid?: () => number;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly configPath: string;
  readonly randomSuffix: () => string;
  readonly runner?: CommandRunner;
  readonly beforeDefinitionPublish?: () => Promise<void>;
  readonly isDefinitionCurrentUser?: (userId: number, candidate?: string) => boolean;
  readonly definitionRemovalHooks?: {
    readonly beforeClaim?: () => Promise<void>;
    readonly afterStateStageWrite?: () => Promise<void>;
    readonly afterStateLink?: () => Promise<void>;
    readonly afterStateSync?: () => Promise<void>;
    readonly beforeStateStageUnlink?: () => Promise<void>;
    readonly afterStateStageUnlink?: () => Promise<void>;
    readonly beforeRename?: () => Promise<void>;
    readonly afterRename?: () => Promise<void>;
    readonly afterSync?: () => Promise<void>;
    readonly beforeUnlink?: () => Promise<void>;
    readonly afterUnlink?: () => Promise<void>;
    readonly afterFinalValidationBeforeMove?: () => Promise<void>;
    readonly afterMove?: () => Promise<void>;
    readonly afterMoveSync?: () => Promise<void>;
    readonly afterMovedUnlink?: () => Promise<void>;
    readonly afterCanonicalReappearance?: () => Promise<void>;
  };
  readonly deleteClaimOwnerState?: () => "dead" | "live" | "unknown";
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
const CONFIG_PATH_PLACEHOLDER = "/__TOSS_RUNTIME_CONFIG_PATH_PLACEHOLDER__";

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

function decodeXmlText(value: string): string | undefined {
  if (/&(?!amp;|lt;|gt;|quot;|apos;)/u.test(value)) return undefined;
  return value.replace(/&(?:amp|lt|gt|quot|apos);/gu, (entity) => {
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&quot;") return '"';
    return "'";
  });
}

function decodeSystemdArgument(value: string): string | undefined {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\\") {
      const escaped = value[index + 1];
      if (escaped !== "\\" && escaped !== '"') return undefined;
      decoded += escaped;
      index += 1;
      continue;
    }
    if (character === "$" || character === "%") {
      if (value[index + 1] !== character) return undefined;
      decoded += character;
      index += 1;
      continue;
    }
    if (character === '"') return undefined;
    decoded += character;
  }
  return decoded;
}

function isUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

type IdempotentCommandState =
  | "none"
  | "linux-stop"
  | "linux-disable"
  | "linux-show"
  | "darwin-bootstrap"
  | "darwin-bootout"
  | "darwin-print";

function commandOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.slice(0, MAX_STATUS_OUTPUT_CHARS);
}

function exactIdentityTokenPattern(identity: string): string {
  const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?<![A-Za-z0-9._-])${escaped}(?![A-Za-z0-9._-])`;
}

function isIdempotentResult(
  idempotentState: IdempotentCommandState,
  result: CommandResult,
  uid: number,
): boolean {
  const output = commandOutput(result);
  if (idempotentState === "linux-show") {
    return /(?:^|\n)LoadState=not-found(?:\n|$)/.test(output);
  }
  if (idempotentState === "linux-stop") {
    return new RegExp(`\\bUnit ${SYSTEMD_UNIT.replace(".", "\\.")} not loaded\\b`).test(output);
  }
  if (idempotentState === "linux-disable") {
    return new RegExp(
      `\\b(?:Unit|Unit file) ${SYSTEMD_UNIT.replace(".", "\\.")} (?:could not be found|does not exist)\\b`,
    ).test(output);
  }
  const serviceLabel = exactIdentityTokenPattern(SERVICE_LABEL);
  const identity = exactIdentityTokenPattern(nativeIdentity(uid));
  if (idempotentState === "darwin-bootstrap") {
    return new RegExp(
      `(?:${serviceLabel}.*already loaded|already loaded.*${serviceLabel})`,
      "i",
    ).test(output);
  }
  if (idempotentState === "darwin-bootout" || idempotentState === "darwin-print") {
    return new RegExp(`could not find service\\s+["']?${identity}`, "i").test(output);
  }
  return false;
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
  const unitResult = properties.get("Result") ?? "";
  return {
    installed: properties.get("LoadState") === "loaded",
    enabled: properties.get("UnitFileState") === "enabled",
    active: properties.get("ActiveState") === "active",
    backoff:
      subState === "auto-restart" ||
      subState === "start-limit-hit" ||
      unitResult === "start-limit-hit",
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
      const currentUid =
        options.currentUid === undefined
          ? typeof process.getuid === "function"
            ? process.getuid()
            : Number.NaN
          : options.currentUid();
      if (
        !Number.isSafeInteger(options.uid) ||
        options.uid < 0 ||
        !Number.isSafeInteger(currentUid) ||
        currentUid < 0 ||
        options.uid !== currentUid ||
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

  private renderDefinition(configPath: string): string {
    return renderServiceDefinition({
      platform: this.options.platform,
      uid: this.options.uid,
      nodePath: this.options.nodePath,
      cliPath: this.options.cliPath,
      configPath,
      environment: definitionEnvironment(this.options.env),
    });
  }

  private recoverConfigPath(existing: Uint8Array): string | undefined {
    const template = this.renderDefinition(CONFIG_PATH_PLACEHOLDER);
    const placeholderIndex = template.lastIndexOf(CONFIG_PATH_PLACEHOLDER);
    if (placeholderIndex < 0) return undefined;
    const prefix = template.slice(0, placeholderIndex);
    const suffix = template.slice(placeholderIndex + CONFIG_PATH_PLACEHOLDER.length);
    const text = Buffer.from(existing).toString("utf8");
    if (!text.startsWith(prefix) || !text.endsWith(suffix)) return undefined;
    const encoded = text.slice(prefix.length, text.length - suffix.length);
    const configPath =
      this.options.platform === "darwin" ? decodeXmlText(encoded) : decodeSystemdArgument(encoded);
    if (configPath === undefined || !path.isAbsolute(configPath)) return undefined;
    try {
      const canonical = Buffer.from(this.renderDefinition(configPath), "utf8");
      return canonical.equals(existing) ? configPath : undefined;
    } catch {
      return undefined;
    }
  }

  private async installedDefinition(
    allowRecoveredConfig = false,
  ): Promise<PrivateRegularFileSnapshot | undefined> {
    let existing: PrivateRegularFileSnapshot | undefined;
    try {
      await recoverOwnedDefinitionClaims(this.paths.definition, {
        ...(this.options.isDefinitionCurrentUser === undefined
          ? {}
          : { isCurrentUser: this.options.isDefinitionCurrentUser }),
        ...(this.options.deleteClaimOwnerState === undefined
          ? {}
          : { claimOwnerState: this.options.deleteClaimOwnerState }),
      });
      existing = await readPrivateRegularFileSnapshot(this.paths.definition, {
        ...(this.options.isDefinitionCurrentUser === undefined
          ? {}
          : { isCurrentUser: this.options.isDefinitionCurrentUser }),
      });
    } catch (error) {
      definitionError(error);
    }
    if (existing === undefined) {
      return undefined;
    }
    if (
      !Buffer.from(existing.bytes).equals(this.definition) &&
      (!allowRecoveredConfig || this.recoverConfigPath(existing.bytes) === undefined)
    ) {
      definitionUnsafe();
    }
    return existing;
  }

  private async ensureDefinition(): Promise<void> {
    if ((await this.installedDefinition()) !== undefined) return;
    let result: "created" | "existing";
    try {
      result = await createPrivateAtomicIfMissing({
        target: this.paths.definition,
        bytes: this.definition,
        randomSuffix: this.options.randomSuffix,
        parentPolicy: "owned-not-writable",
        ...(this.options.isDefinitionCurrentUser === undefined
          ? {}
          : { isCurrentUser: this.options.isDefinitionCurrentUser }),
        ...(this.options.beforeDefinitionPublish === undefined
          ? {}
          : { beforePublish: this.options.beforeDefinitionPublish }),
      });
    } catch (error) {
      definitionError(error);
    }
    if (result === "existing" && (await this.installedDefinition()) === undefined)
      definitionUnsafe();
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
    if (isIdempotentResult(idempotentState, result, this.options.uid)) {
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
    if (!(await this.installedDefinition(true))) return EMPTY_STATUS;
    if (this.options.platform === "linux") {
      await this.command(LINUX_EXECUTABLE, ["--user", "start", SYSTEMD_UNIT]);
    } else {
      await this.command(
        DARWIN_EXECUTABLE,
        ["bootstrap", `gui/${this.options.uid}`, this.paths.definition],
        "darwin-bootstrap",
      );
    }
    return fixedStatus(true, true, true);
  }

  async stop(): Promise<ServiceManagerStatus> {
    if (!(await this.installedDefinition(true))) return EMPTY_STATUS;
    if (this.options.platform === "linux") {
      await this.command(LINUX_EXECUTABLE, ["--user", "stop", SYSTEMD_UNIT], "linux-stop");
    } else {
      await this.command(
        DARWIN_EXECUTABLE,
        ["bootout", nativeIdentity(this.options.uid)],
        "darwin-bootout",
      );
    }
    return fixedStatus(true, true, false);
  }

  async restart(): Promise<ServiceManagerStatus> {
    if (!(await this.installedDefinition(true))) return EMPTY_STATUS;
    if (this.options.platform === "linux") {
      await this.command(LINUX_EXECUTABLE, ["--user", "restart", SYSTEMD_UNIT]);
    } else {
      await this.command(DARWIN_EXECUTABLE, ["kickstart", "-k", nativeIdentity(this.options.uid)]);
    }
    return fixedStatus(true, true, true);
  }

  async status(): Promise<ServiceManagerStatus> {
    if (!(await this.installedDefinition(true))) return EMPTY_STATUS;
    if (this.options.platform === "linux") {
      const result = await this.command(
        LINUX_EXECUTABLE,
        [
          "--user",
          "show",
          SYSTEMD_UNIT,
          "--property=LoadState,UnitFileState,ActiveState,SubState,Result,NRestarts,ExecMainStatus",
          "--no-pager",
        ],
        "linux-show",
      );
      return result === undefined ? EMPTY_STATUS : linuxStatus(result);
    }
    const result = await this.command(
      DARWIN_EXECUTABLE,
      ["print", nativeIdentity(this.options.uid)],
      "darwin-print",
    );
    return result === undefined ? EMPTY_STATUS : darwinStatus(result);
  }

  async uninstall(): Promise<ServiceManagerStatus> {
    const acceptedDefinition = await this.installedDefinition(true);
    if (acceptedDefinition === undefined) return EMPTY_STATUS;
    if (this.options.platform === "linux") {
      await this.command(LINUX_EXECUTABLE, ["--user", "stop", SYSTEMD_UNIT], "linux-stop");
      await this.command(LINUX_EXECUTABLE, ["--user", "disable", SYSTEMD_UNIT], "linux-disable");
    } else {
      await this.command(
        DARWIN_EXECUTABLE,
        ["bootout", nativeIdentity(this.options.uid)],
        "darwin-bootout",
      );
    }
    try {
      await removeOwnedDefinition(this.paths.definition, {
        expectedBytes: acceptedDefinition.bytes,
        expectedIdentity: {
          device: acceptedDefinition.device,
          inode: acceptedDefinition.inode,
        },
        randomSuffix: this.options.randomSuffix,
        ...(this.options.isDefinitionCurrentUser === undefined
          ? {}
          : { isCurrentUser: this.options.isDefinitionCurrentUser }),
        ...(this.options.definitionRemovalHooks === undefined
          ? {}
          : { hooks: this.options.definitionRemovalHooks }),
        ...(this.options.deleteClaimOwnerState === undefined
          ? {}
          : { claimOwnerState: this.options.deleteClaimOwnerState }),
      });
    } catch (error) {
      definitionError(error);
    }
    if (this.options.platform === "linux") {
      await this.command(LINUX_EXECUTABLE, ["--user", "daemon-reload"]);
    }
    return EMPTY_STATUS;
  }

  async installedConfigPath(): Promise<string | null> {
    let existing: Uint8Array | undefined;
    try {
      await recoverOwnedDefinitionClaims(this.paths.definition, {
        ...(this.options.isDefinitionCurrentUser === undefined
          ? {}
          : { isCurrentUser: this.options.isDefinitionCurrentUser }),
        ...(this.options.deleteClaimOwnerState === undefined
          ? {}
          : { claimOwnerState: this.options.deleteClaimOwnerState }),
      });
      existing = await readPrivateRegularFile(this.paths.definition, {
        ...(this.options.isDefinitionCurrentUser === undefined
          ? {}
          : { isCurrentUser: this.options.isDefinitionCurrentUser }),
      });
    } catch (error) {
      definitionError(error);
    }
    if (existing === undefined) return null;
    if (Buffer.from(existing).equals(this.definition)) return this.options.configPath;
    const recovered = this.recoverConfigPath(existing);
    if (recovered === undefined) definitionUnsafe();
    return recovered;
  }
}

export function createServiceManager(options: CreateServiceManagerOptions): ServiceManager {
  return new NativeServiceManager(options);
}
