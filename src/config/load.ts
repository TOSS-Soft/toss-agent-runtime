import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import Ajv2020Module from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

import configSchema from "../../contracts/runtime/runtime-config.v1.schema.json" with { type: "json" };
import {
  assertPlainJson,
  DEFAULT_JSON_LIMITS,
  deepFreezeJson,
  parseJsonBytes,
  type JsonValue,
} from "../protocol/json.js";
import type {
  LoadedConfig,
  RuntimeConfigV1,
  RuntimeEnvironment,
  RuntimePlatform,
} from "./types.js";
import { serviceSocketLayoutFits } from "../service/paths.js";

const Ajv2020 = Ajv2020Module.default;
const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
const validateConfig = ajv.compile(configSchema);
const MAX_RUNTIME_CONFIG_BYTES = DEFAULT_JSON_LIMITS.maxBytes;

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

function xdgPath(env: RuntimeEnvironment, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value.length === 0 || !path.isAbsolute(value)
    ? fallback
    : path.normalize(value);
}

function absoluteEnvironmentPath(env: RuntimeEnvironment, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value.length > 0 && path.isAbsolute(value)
    ? path.normalize(value)
    : undefined;
}

export function defaultConfig(
  platform: RuntimePlatform,
  home: string,
  env: RuntimeEnvironment = {},
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
  const runtimeEnvironment =
    platform === "linux" ? absoluteEnvironmentPath(env, "XDG_RUNTIME_DIR") : undefined;
  const runtimeRoot =
    platform === "linux"
      ? runtimeEnvironment === undefined
        ? state
        : path.join(runtimeEnvironment, "toss", "runtime")
      : path.join(home, "Library", "Application Support", "TOSS", "runtime");

  const config: RuntimeConfigV1 = {
    schema_version: "runtime-config.v1",
    document_type: "runtime-config",
    mode: "development",
    paths: { state, logs, socket: path.join(runtimeRoot, "runtime.sock") },
    shutdown_timeout_ms: 30_000,
    logs: { level: "info", retention_days: 7, max_bytes: 104_857_600 },
    gateway_profile: null,
    gateway_profiles: {},
    provider_profiles: [],
    mcp_profiles: [],
    secret_references: {},
  };
  return deepFreezeJson(config as unknown as JsonValue) as unknown as RuntimeConfigV1;
}

export function resolveDefaultConfigPath(
  platform: RuntimePlatform,
  home: string,
  env: RuntimeEnvironment,
): string {
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

function assertServiceSocketLayout(options: {
  readonly socketPath: string;
  readonly platform: RuntimePlatform;
  readonly socketPathByteLimit?: number | undefined;
}): void {
  if (
    !serviceSocketLayoutFits({
      socketPath: options.socketPath,
      platform: options.platform,
      ...(options.socketPathByteLimit === undefined
        ? {}
        : { pathByteLimit: options.socketPathByteLimit }),
    })
  ) {
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      "Configuration service socket path exceeds platform support",
    );
  }
}

function invalidGatewayProfile(): never {
  throw new RuntimeConfigError(
    "RUNTIME_CONFIG_INVALID",
    "Agentgateway profile configuration is invalid",
  );
}

function assertGatewayProfiles(config: RuntimeConfigV1): void {
  for (const profile of Object.values(config.gateway_profiles)) {
    if (
      Buffer.byteLength(profile.endpoint, "utf8") > 2048 ||
      profile.endpoint !== profile.endpoint.trim() ||
      /[\u0000-\u001f\u007f]/u.test(profile.endpoint)
    ) {
      invalidGatewayProfile();
    }
    let endpoint: URL;
    try {
      endpoint = new URL(profile.endpoint);
    } catch {
      invalidGatewayProfile();
    }
    if (
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.search !== "" ||
      endpoint.hash !== ""
    ) {
      invalidGatewayProfile();
    }
    if (endpoint.protocol === "http:") {
      if (
        config.mode !== "development" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
      ) {
        invalidGatewayProfile();
      }
    } else if (endpoint.protocol !== "https:") {
      invalidGatewayProfile();
    }

    const credential = config.secret_references[profile.credential_reference];
    if (
      credential === undefined ||
      (config.mode === "production" && credential.source !== "command")
    ) {
      invalidGatewayProfile();
    }
  }

  if (
    config.gateway_profile !== null &&
    config.gateway_profiles[config.gateway_profile] === undefined
  ) {
    invalidGatewayProfile();
  }
  if (config.mode === "production" && config.provider_profiles.length !== 0) {
    invalidGatewayProfile();
  }
}

function assertConfig(
  value: JsonValue,
  options: {
    readonly platform: RuntimePlatform;
    readonly socketPathByteLimit?: number | undefined;
  },
): RuntimeConfigV1 {
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
  assertServiceSocketLayout({
    socketPath: config.paths.socket,
    platform: options.platform,
    socketPathByteLimit: options.socketPathByteLimit,
  });
  assertGatewayProfiles(config);
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

function configSizeInvalid(): never {
  throw new RuntimeConfigError(
    "RUNTIME_CONFIG_INVALID",
    "Configuration exceeds maximum supported size",
  );
}

async function readBoundedConfig(handle: FileHandle): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(MAX_RUNTIME_CONFIG_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > MAX_RUNTIME_CONFIG_BYTES) configSizeInvalid();
  return bytes.subarray(0, offset);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

interface ProductionRoots {
  readonly config: string;
  readonly state: string;
  readonly logs: string;
  readonly runtime: string;
}

function productionRoots(options: {
  readonly env: RuntimeEnvironment;
  readonly home: string;
  readonly platform: RuntimePlatform;
}): ProductionRoots {
  if (options.platform === "darwin") {
    const runtime = path.join(options.home, "Library", "Application Support", "TOSS", "runtime");
    return {
      config: runtime,
      state: path.join(runtime, "state"),
      logs: path.join(options.home, "Library", "Logs", "TOSS", "runtime"),
      runtime,
    };
  }

  const config = path.join(
    xdgPath(options.env, "XDG_CONFIG_HOME", path.join(options.home, ".config")),
    "toss",
    "runtime",
  );
  const state = path.join(
    xdgPath(options.env, "XDG_STATE_HOME", path.join(options.home, ".local", "state")),
    "toss",
    "runtime",
  );
  const runtimeEnvironment = absoluteEnvironmentPath(options.env, "XDG_RUNTIME_DIR");
  return {
    config,
    state,
    logs: path.join(state, "logs"),
    runtime:
      runtimeEnvironment === undefined ? state : path.join(runtimeEnvironment, "toss", "runtime"),
  };
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
): Promise<void> {
  const root = selectApprovedRoot(candidate, roots);
  const parsed = path.parse(candidate);
  const relative = candidate.slice(parsed.root.length);
  const segments = relative === "" ? [] : relative.split(path.sep);
  const pathsToCheck: string[] = [parsed.root];
  let current = parsed.root;
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_UNSAFE",
        "Production runtime directory could not be inspected safely",
      );
    }
    current = path.join(current, segment);
    pathsToCheck.push(current);
  }

  let reachedCurrentUserDirectory = false;
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
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new RuntimeConfigError(
        "RUNTIME_CONFIG_UNSAFE",
        "Production runtime directories must be private and owned by the current user",
      );
    }
    const ownedByCurrentUser = currentUserOwns(metadata.uid);
    const trustedSystemAncestor = metadata.uid === 0 && !reachedCurrentUserDirectory;
    if (trustedSystemAncestor) {
      const writable = (metadata.mode & 0o022) !== 0;
      const sticky = (metadata.mode & 0o1000) !== 0;
      if (writable && !sticky) {
        throw new RuntimeConfigError(
          "RUNTIME_CONFIG_UNSAFE",
          "Production runtime directories must be private and owned by the current user",
        );
      }
    } else {
      if (!ownedByCurrentUser || (metadata.mode & 0o022) !== 0) {
        throw new RuntimeConfigError(
          "RUNTIME_CONFIG_UNSAFE",
          "Production runtime directories must be private and owned by the current user",
        );
      }
      reachedCurrentUserDirectory = true;
    }
    if (isWithin(root, directoryPath) && (!ownedByCurrentUser || (metadata.mode & 0o077) !== 0)) {
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
  options: {
    readonly env: RuntimeEnvironment;
    readonly home: string;
    readonly platform: RuntimePlatform;
  },
): Promise<void> {
  const roots = productionRoots(options);
  await assertPrivateDirectoryPath(path.dirname(selectedPath), [roots.config]);
  await assertPrivateDirectoryPath(config.paths.state, [roots.state]);
  await assertPrivateDirectoryPath(config.paths.logs, [roots.logs]);
  await assertPrivateDirectoryPath(path.dirname(config.paths.socket), [roots.runtime]);
}

export async function loadConfig(options: {
  readonly explicitPath?: string;
  readonly env: RuntimeEnvironment;
  readonly platform: RuntimePlatform;
  readonly home: string;
  /** @internal Deterministic Unix-socket ABI-budget seam for portable tests. */
  readonly socketPathByteLimit?: number;
  /** @internal Deterministic race hook used only by real-filesystem tests. */
  readonly beforeRead?: () => Promise<void>;
}): Promise<LoadedConfig> {
  const environmentPath = options.env.TOSS_RUNTIME_CONFIG;
  const selectedPath =
    options.explicitPath ??
    (environmentPath === undefined || environmentPath.length === 0
      ? resolveDefaultConfigPath(options.platform, options.home, options.env)
      : environmentPath);
  const required =
    options.explicitPath !== undefined ||
    (environmentPath !== undefined && environmentPath.length > 0);

  let handle;
  try {
    handle = await open(selectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (!required && isMissingFile(error)) {
      const config = defaultConfig(options.platform, options.home, options.env);
      assertServiceSocketLayout({
        socketPath: config.paths.socket,
        platform: options.platform,
        socketPathByteLimit: options.socketPathByteLimit,
      });
      return {
        config,
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

  let metadata: Stats;
  let input: Buffer;
  try {
    try {
      metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new RuntimeConfigError(
          "RUNTIME_CONFIG_UNSAFE",
          "Configuration must be a regular non-symlink file",
        );
      }
      if (metadata.size > MAX_RUNTIME_CONFIG_BYTES) configSizeInvalid();
      try {
        await options.beforeRead?.();
      } catch {
        throw new RuntimeConfigError(
          "RUNTIME_CONFIG_INVALID",
          "Configuration could not be read safely",
        );
      }
      input = await readBoundedConfig(handle);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RuntimeConfigError) throw error;
    throw new RuntimeConfigError(
      "RUNTIME_CONFIG_INVALID",
      "Configuration could not be read safely",
    );
  }

  let config: RuntimeConfigV1;
  try {
    config = assertConfig(parseConfigBytes(selectedPath, input), options);
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
