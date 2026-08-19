import { lstat, readFile } from "node:fs/promises";
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
  return value === undefined || value.length === 0 ? fallback : value;
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

  let metadata;
  try {
    metadata = await lstat(selectedPath);
  } catch (error) {
    if (!required && isMissingFile(error)) {
      return {
        config: defaultConfig(options.platform, options.home, options.env),
        source: "defaults",
      };
    }
    throw new RuntimeConfigError("RUNTIME_CONFIG_UNAVAILABLE", "Configuration file is unavailable");
  }

  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_UNSAFE",
      "Configuration must be a regular non-symlink file",
    );
  }

  let config: RuntimeConfigV1;
  try {
    config = assertConfig(parseConfigBytes(selectedPath, await readFile(selectedPath)));
  } catch (error) {
    if (error instanceof RuntimeConfigError) {
      throw error;
    }
    throw new RuntimeConfigError("RUNTIME_CONFIG_INVALID", "Configuration could not be parsed");
  }

  if (config.mode === "production" && (metadata.mode & 0o022) !== 0) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_UNSAFE",
      "Production configuration cannot be group/world writable",
    );
  }

  return { config, source: selectedPath };
}
