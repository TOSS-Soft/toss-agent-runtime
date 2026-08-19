import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import Ajv2020Module from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

import configSchema from "../../contracts/runtime/runtime-config.v1.schema.json" with { type: "json" };
import {
  assertPlainJson,
  deepFreezeJson,
  parseJsonBytes,
  type JsonValue,
} from "../protocol/json.js";
import type { LoadedConfig, RuntimeConfigV1 } from "./types.js";

const Ajv2020 = Ajv2020Module.default;
const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
const validateConfig = ajv.compile(configSchema);

export class RuntimeConfigError extends Error {
  constructor(
    readonly code:
      "RUNTIME_CONFIG_INVALID" | "RUNTIME_CONFIG_UNSAFE" | "RUNTIME_CONFIG_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

type PlatformName = "darwin" | "linux";
type Environment = Readonly<Record<string, string | undefined>>;

function xdgPath(env: Environment, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value.length === 0 || !path.isAbsolute(value)
    ? fallback
    : path.normalize(value);
}

export function defaultConfig(
  platform: PlatformName,
  home: string,
  env: Environment = {},
): RuntimeConfigV1 {
  const state =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support", "TOSS", "runtime", "state")
      : path.join(
          xdgPath(env, "XDG_STATE_HOME", path.join(home, ".local", "state")),
          "toss",
          "runtime",
        );
  const logs =
    platform === "darwin"
      ? path.join(home, "Library", "Logs", "TOSS", "runtime")
      : path.join(state, "logs");
  const runtimeRoot =
    platform === "linux"
      ? xdgPath(env, "XDG_RUNTIME_DIR", state)
      : path.join(home, "Library", "Application Support", "TOSS", "runtime");

  const config: RuntimeConfigV1 = {
    schema_version: "runtime-config.v1",
    document_type: "runtime-config",
    mode: "development",
    paths: { state, logs, socket: path.join(runtimeRoot, "runtime.sock") },
    shutdown_timeout_ms: 30_000,
    logs: { level: "info", retention_days: 7, max_bytes: 104_857_600 },
    gateway_profile: null,
    provider_profiles: [],
    mcp_profiles: [],
    secret_references: {},
  };
  return deepFreezeJson(config as unknown as JsonValue) as unknown as RuntimeConfigV1;
}

function defaultConfigPath(platform: PlatformName, home: string, env: Environment): string {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "TOSS", "runtime", "config.yaml");
  }
  return path.join(
    xdgPath(env, "XDG_CONFIG_HOME", path.join(home, ".config")),
    "toss",
    "runtime",
    "config.yaml",
  );
}

function parseConfigBytes(filePath: string, input: Uint8Array): JsonValue {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".json") {
    return parseJsonBytes(input);
  }
  if (extension !== ".yaml" && extension !== ".yml") {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      "Configuration must use .json, .yaml, or .yml",
    );
  }

  const document = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(input), {
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new RuntimeConfigError("RUNTIME_CONFIG_INVALID", "Configuration syntax is invalid");
  }
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  assertPlainJson(value);
  return value;
}

function assertConfig(value: JsonValue): RuntimeConfigV1 {
  if (!validateConfig(value)) {
    const issues = (validateConfig.errors ?? [])
      .map((error) => `${error.instancePath || "/"}: ${error.keyword}`)
      .sort()
      .join(", ");
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      `Configuration failed validation: ${issues}`,
    );
  }
  const config = deepFreezeJson(value) as unknown as RuntimeConfigV1;
  for (const [name, configuredPath] of Object.entries(config.paths)) {
    if (!path.isAbsolute(configuredPath)) {
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_INVALID",
        `Configuration path must be absolute: ${name}`,
      );
    }
  }
  return config;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function approvedRoots(options: {
  readonly env: Environment;
  readonly home: string;
  readonly platform: PlatformName;
}): readonly string[] {
  const roots = [path.normalize(options.home)];
  if (options.platform === "linux") {
    for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) {
      const value = options.env[key];
      if (value !== undefined && path.isAbsolute(value)) roots.push(path.normalize(value));
    }
  }
  return [...new Set(roots)].sort((left, right) => right.length - left.length);
}

function selectApprovedRoot(candidate: string, roots: readonly string[]): string {
  const root = roots.find((allowed) => isWithin(allowed, candidate));
  if (root === undefined) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_UNSAFE",
      "Production paths must stay within approved per-user roots",
    );
  }
  return root;
}

function currentUserOwns(userId: number): boolean {
  return typeof process.getuid !== "function" || userId === process.getuid();
}

async function assertPrivateDirectoryPath(
  candidate: string,
  roots: readonly string[],
  home: string,
): Promise<void> {
  const root = selectApprovedRoot(candidate, roots);
  const relative = path.relative(root, candidate);
  const segments = relative === "" ? [] : relative.split(path.sep);
  const pathsToCheck: string[] = [];
  if (root !== path.normalize(home)) pathsToCheck.push(root);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    pathsToCheck.push(current);
  }

  for (const directoryPath of pathsToCheck) {
    let metadata;
    try {
      metadata = await lstat(directoryPath);
    } catch (error) {
      if (isMissingFile(error)) break;
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_UNSAFE",
        "Production runtime directory could not be inspected safely",
      );
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !currentUserOwns(metadata.uid) ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_UNSAFE",
        "Production runtime directories must be private and owned by the current user",
      );
    }
  }
}

async function assertProductionIsolation(
  config: RuntimeConfigV1,
  selectedPath: string,
  options: { readonly env: Environment; readonly home: string; readonly platform: PlatformName },
): Promise<void> {
  const roots = approvedRoots(options);
  await assertPrivateDirectoryPath(path.dirname(selectedPath), roots, options.home);
  await assertPrivateDirectoryPath(config.paths.state, roots, options.home);
  await assertPrivateDirectoryPath(config.paths.logs, roots, options.home);
  await assertPrivateDirectoryPath(path.dirname(config.paths.socket), roots, options.home);
}

export async function loadConfig(options: {
  readonly explicitPath?: string;
  readonly env: Environment;
  readonly platform: PlatformName;
  readonly home: string;
}): Promise<LoadedConfig> {
  const environmentPath = options.env.TOSS_RUNTIME_CONFIG;
  const selectedPath =
    options.explicitPath ??
    (environmentPath === undefined || environmentPath.length === 0
      ? defaultConfigPath(options.platform, options.home, options.env)
      : environmentPath);
  const required =
    options.explicitPath !== undefined ||
    (environmentPath !== undefined && environmentPath.length > 0);

  let handle;
  try {
    handle = await open(selectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (!required && isMissingFile(error)) {
      return {
        config: defaultConfig(options.platform, options.home, options.env),
        source: "defaults",
      };
    }
    if (["ELOOP", "EMLINK"].includes(errorCode(error) ?? "")) {
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_UNSAFE",
        "Configuration must be a regular non-symlink file",
      );
    }
    throw new RuntimeConfigError("RUNTIME_CONFIG_UNAVAILABLE", "Configuration file is unavailable");
  }

  let metadata;
  let input: Buffer;
  try {
    metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_UNSAFE",
        "Configuration must be a regular non-symlink file",
      );
    }
    input = await handle.readFile();
  } finally {
    await handle.close();
  }

  let config: RuntimeConfigV1;
  try {
    config = assertConfig(parseConfigBytes(selectedPath, input));
  } catch (error) {
    if (error instanceof RuntimeConfigError) {
      throw error;
    }
    throw new RuntimeConfigError("RUNTIME_CONFIG_INVALID", "Configuration could not be parsed");
  }

  if (config.mode === "production") {
    if (!currentUserOwns(metadata.uid) || (metadata.mode & 0o077) !== 0) {
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_UNSAFE",
        "Production configuration must be private and owned by the current user",
      );
    }
    await assertProductionIsolation(config, selectedPath, options);
  }

  return { config, source: selectedPath };
}
