import path from "node:path";

export const SERVICE_LABEL = "software.toss.agent-runtime";
export const SYSTEMD_UNIT = "toss-agent-runtime.service";

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
