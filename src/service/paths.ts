import path from "node:path";

export const SERVICE_LABEL = "software.toss.agent-runtime";
export const SYSTEMD_UNIT = "toss-agent-runtime.service";
const UNIX_SOCKET_PATH_BYTE_LIMIT = Object.freeze({ darwin: 104, linux: 107 });
const ACTIVE_INTERNAL_SOCKET_BASENAMES = Object.freeze([".s0000000000", ".x0000000000"] as const);

export type ServiceSocketPlatform = keyof typeof UNIX_SOCKET_PATH_BYTE_LIMIT;

export function isServiceSocketPlatform(value: string): value is ServiceSocketPlatform {
  return value === "darwin" || value === "linux";
}

export function serviceSocketLayoutFits(options: {
  readonly socketPath: string;
  readonly platform: ServiceSocketPlatform;
  /** @internal Deterministic ABI-budget seam for portable tests. */
  readonly pathByteLimit?: number;
}): boolean {
  const pathByteLimit = options.pathByteLimit ?? UNIX_SOCKET_PATH_BYTE_LIMIT[options.platform];
  if (!Number.isSafeInteger(pathByteLimit) || pathByteLimit <= 0) return false;
  const runtimePath = path.dirname(options.socketPath);
  return [
    options.socketPath,
    ...ACTIVE_INTERNAL_SOCKET_BASENAMES.map((basename) => path.join(runtimePath, basename)),
  ].every((candidate) => Buffer.byteLength(candidate, "utf8") <= pathByteLimit);
}

export interface ServicePaths {
  readonly definition: string;
  readonly managerIdentity: string;
}

export interface ResolveServicePathsOptions {
  readonly platform: "darwin" | "linux";
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function assertAbsolutePath(value: string): void {
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Service path must be absolute and free of control characters");
  }
}

export function resolveServicePaths(options: ResolveServicePathsOptions): ServicePaths {
  assertAbsolutePath(options.home);

  if (options.platform === "darwin") {
    return {
      definition: path.join(options.home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
      managerIdentity: SERVICE_LABEL,
    };
  }
  if (options.platform === "linux") {
    return {
      definition: path.join(options.home, ".config", "systemd", "user", SYSTEMD_UNIT),
      managerIdentity: SYSTEMD_UNIT,
    };
  }
  throw new Error("Unsupported service platform");
}
