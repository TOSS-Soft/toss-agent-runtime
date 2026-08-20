import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultConfig,
  loadConfig,
  resolveDefaultConfigPath,
  RuntimeConfigError,
} from "../src/config/load.js";

const temporaryDirectories: string[] = [];
const RUNTIME_CONFIG_BYTE_CAP = 2 * 1024 * 1024;

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "toss-runtime-config-")));
  temporaryDirectories.push(directory);
  return directory;
}

function validYaml(root: string, mode: "development" | "production" = "development"): string {
  return `schema_version: runtime-config.v1
document_type: runtime-config
mode: ${mode}
paths:
  state: ${root}/state
  logs: ${root}/logs
  socket: ${root}/runtime.sock
shutdown_timeout_ms: 30000
logs:
  level: info
  retention_days: 7
  max_bytes: 104857600
gateway_profile: ${mode === "production" ? "gateway-production" : "null"}
provider_profiles: []
mcp_profiles: []
secret_references: {}
`;
}

function linuxConfigRoot(home: string): string {
  return path.join(home, ".config", "toss", "runtime");
}

function linuxStateRoot(home: string): string {
  return path.join(home, ".local", "state", "toss", "runtime");
}

function validConfigWithSize(root: string, extension: "json" | "yaml" | "yml", size: number) {
  const document =
    extension === "json" ? JSON.stringify(defaultConfig("linux", root)) : validYaml(root);
  const encoded = Buffer.from(document, "utf8");
  if (encoded.byteLength > size) throw new Error("test fixture is larger than requested size");
  return Buffer.concat([encoded, Buffer.alloc(size - encoded.byteLength, 0x20)]);
}

async function writeProductionConfig(
  home: string,
  name: string,
  yaml = validYaml(linuxStateRoot(home), "production"),
): Promise<string> {
  const configRoot = linuxConfigRoot(home);
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  const configPath = path.join(configRoot, name);
  await writeFile(configPath, yaml, { mode: 0o600 });
  return configPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("runtime configuration", () => {
  it("prefers an explicit path over the environment path", async () => {
    const root = await temporaryDirectory();
    const explicitPath = path.join(root, "explicit.yaml");
    const environmentPath = path.join(root, "environment.yaml");
    await writeFile(explicitPath, validYaml(root), { mode: 0o600 });
    await writeFile(environmentPath, validYaml(root), { mode: 0o600 });

    const result = await loadConfig({
      explicitPath,
      env: { TOSS_RUNTIME_CONFIG: environmentPath },
      platform: "linux",
      home: root,
    });

    expect(result.source).toBe(explicitPath);
  });

  it("returns deterministic defaults when the user config does not exist", async () => {
    const root = await temporaryDirectory();
    const result = await loadConfig({ env: {}, platform: "linux", home: root });
    expect(result.source).toBe("defaults");
    expect(result.config.logs).toEqual({ level: "info", retention_days: 7, max_bytes: 104857600 });
    expect(result.config.paths.state).toBe(path.join(root, ".local", "state", "toss", "runtime"));
  });

  it("resolves the standard config path from the platform-specific private root", () => {
    expect(resolveDefaultConfigPath("darwin", "/Users/test", {})).toBe(
      "/Users/test/Library/Application Support/TOSS/runtime/config.yaml",
    );
    expect(
      resolveDefaultConfigPath("linux", "/home/test", {
        XDG_CONFIG_HOME: "/private/config",
      }),
    ).toBe("/private/config/toss/runtime/config.yaml");
    expect(
      resolveDefaultConfigPath("linux", "/home/test", {
        XDG_CONFIG_HOME: "relative-config",
      }),
    ).toBe("/home/test/.config/toss/runtime/config.yaml");
  });

  it("ignores relative XDG roots when constructing defaults", () => {
    const config = defaultConfig("linux", "/home/test", {
      XDG_STATE_HOME: "relative-state",
      XDG_RUNTIME_DIR: "relative-runtime",
    });
    expect(config.paths.state).toBe("/home/test/.local/state/toss/runtime");
    expect(config.paths.logs).toBe("/home/test/.local/state/toss/runtime/logs");
    expect(config.paths.socket).toBe("/home/test/.local/state/toss/runtime/runtime.sock");
  });

  it("rejects inline secret material without echoing the value", async () => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, "inline-secret.yaml");
    await writeFile(configPath, `${validYaml(root)}api_key: must-not-persist\n`, { mode: 0o600 });

    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home: root }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
    try {
      await loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home: root });
    } catch (error) {
      expect(String(error)).not.toContain("must-not-persist");
    }
  });

  it("rejects duplicate YAML keys", async () => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, "duplicate.yaml");
    await writeFile(configPath, `${validYaml(root)}mode: production\n`, { mode: 0o600 });
    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home: root }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
  });

  it.each(["json", "yaml"] as const)(
    "rejects an oversized sparse %s config before reading or parsing it",
    async (extension) => {
      const root = await temporaryDirectory();
      const configPath = path.join(root, `oversized.${extension}`);
      await writeFile(configPath, "", { mode: 0o600 });
      await truncate(configPath, RUNTIME_CONFIG_BYTE_CAP + 1);

      let error: unknown;
      try {
        await loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home: root });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(RuntimeConfigError);
      expect(error).toMatchObject({
        code: "RUNTIME_CONFIG_INVALID",
        message: "Configuration exceeds maximum supported size",
      });
      expect(String(error)).not.toContain(configPath);
      expect(String(error)).not.toContain(String(RUNTIME_CONFIG_BYTE_CAP + 1));
    },
  );

  it.each(["json", "yaml", "yml"] as const)(
    "accepts an exact-cap %s config for parsing",
    async (extension) => {
      const root = await temporaryDirectory();
      const configPath = path.join(root, `exact-cap.${extension}`);
      await writeFile(configPath, validConfigWithSize(root, extension, RUNTIME_CONFIG_BYTE_CAP), {
        mode: 0o600,
      });

      const loaded = await loadConfig({
        explicitPath: configPath,
        env: {},
        platform: "linux",
        home: root,
      });

      expect(loaded.source).toBe(configPath);
      expect(loaded.config.schema_version).toBe("runtime-config.v1");
    },
  );

  it.each(["json", "yaml"] as const)(
    "rejects a %s config that grows beyond the cap after descriptor validation",
    async (extension) => {
      const root = await temporaryDirectory();
      const configPath = path.join(root, `growing.${extension}`);
      await writeFile(configPath, validConfigWithSize(root, extension, 1024), { mode: 0o600 });

      let error: unknown;
      try {
        await loadConfig({
          explicitPath: configPath,
          env: {},
          platform: "linux",
          home: root,
          beforeRead: async () => {
            await appendFile(configPath, Buffer.alloc(RUNTIME_CONFIG_BYTE_CAP, 0x20));
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(RuntimeConfigError);
      expect(error).toMatchObject({
        code: "RUNTIME_CONFIG_INVALID",
        message: "Configuration exceeds maximum supported size",
      });
      expect(String(error)).not.toContain(configPath);
    },
  );

  it("normalizes a config before-read hook failure without reflecting its detail", async () => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, "hook-failure.yaml");
    await writeFile(configPath, validYaml(root), { mode: 0o600 });

    let error: unknown;
    try {
      await loadConfig({
        explicitPath: configPath,
        env: {},
        platform: "linux",
        home: root,
        beforeRead: () => Promise.reject(new Error(`must-not-persist at ${configPath}`)),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RuntimeConfigError);
    expect(error).toMatchObject({
      code: "RUNTIME_CONFIG_INVALID",
      message: "Configuration could not be read safely",
    });
    expect(String(error)).not.toContain("must-not-persist");
    expect(String(error)).not.toContain(configPath);
  });

  it("rejects a symlinked config file", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "target.yaml");
    const link = path.join(root, "link.yaml");
    await writeFile(target, validYaml(root), { mode: 0o600 });
    await symlink(target, link);
    await expect(
      loadConfig({ explicitPath: link, env: {}, platform: "linux", home: root }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("rejects group/world-writable production configuration", async () => {
    const root = await temporaryDirectory();
    const configPath = await writeProductionConfig(root, "production.yaml");
    await chmod(configPath, 0o666);
    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home: root }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("rejects group/world-readable production configuration", async () => {
    const root = await temporaryDirectory();
    const configPath = await writeProductionConfig(root, "production-readable.yaml");
    await chmod(configPath, 0o644);
    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home: root }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("rejects production runtime paths outside approved per-user roots", async () => {
    const home = await temporaryDirectory();
    const shared = await temporaryDirectory();
    const configPath = await writeProductionConfig(
      home,
      "production-outside.yaml",
      validYaml(shared, "production"),
    );
    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("rejects unsafe existing directories in a production runtime path", async () => {
    const home = await temporaryDirectory();
    const stateRoot = linuxStateRoot(home);
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await chmod(stateRoot, 0o777);
    const configPath = await writeProductionConfig(home, "production-shared.yaml");
    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("rejects a symlinked ancestor before the approved production config root", async () => {
    const home = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const configRoot = path.join(outside, "toss", "runtime");
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    await symlink(outside, path.join(home, ".config"));
    const configPath = path.join(home, ".config", "toss", "runtime", "production.yaml");
    await writeFile(configPath, validYaml(linuxStateRoot(home), "production"), { mode: 0o600 });

    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("rejects a symlinked production state ancestor before a missing approved suffix", async () => {
    const home = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink(outside, path.join(home, ".local"));
    const configPath = await writeProductionConfig(home, "production-state-link.yaml");

    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("rejects a symlinked production runtime ancestor before a missing approved suffix", async () => {
    const home = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const runtimeLink = path.join(home, "run");
    await symlink(outside, runtimeLink);
    const socket = path.join(runtimeLink, "toss", "runtime", "runtime.sock");
    const configPath = await writeProductionConfig(
      home,
      "production-runtime-link.yaml",
      validYaml(linuxStateRoot(home), "production").replace(
        `socket: ${linuxStateRoot(home)}/runtime.sock`,
        `socket: ${socket}`,
      ),
    );

    await expect(
      loadConfig({
        explicitPath: configPath,
        env: { XDG_RUNTIME_DIR: runtimeLink },
        platform: "linux",
        home,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("accepts production roots below root-owned non-writable and sticky ancestors", async () => {
    const trustedTemporaryRoot = await realpath("/tmp");
    const metadata = await lstat(trustedTemporaryRoot);
    expect(metadata.uid).toBe(0);
    expect(metadata.mode & 0o1000).toBe(0o1000);
    const home = await realpath(
      await mkdtemp(path.join(trustedTemporaryRoot, "toss-runtime-config-trusted-")),
    );
    temporaryDirectories.push(home);
    const configPath = await writeProductionConfig(home, "production-trusted-ancestors.yaml");

    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home }),
    ).resolves.toMatchObject({ source: configPath, config: { mode: "production" } });
  });

  it("rejects a production config outside approved per-user roots", async () => {
    const home = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const configPath = path.join(outside, "production.yaml");
    await writeFile(configPath, validYaml(linuxStateRoot(home), "production"), { mode: 0o600 });
    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("rejects project-local production config and runtime paths inside home", async () => {
    const home = await temporaryDirectory();
    const project = path.join(home, "project");
    await mkdir(project, { mode: 0o700 });
    const configPath = path.join(project, "runtime.yaml");
    await writeFile(configPath, validYaml(project, "production"), { mode: 0o600 });
    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("accepts private production config and paths under field-specific roots", async () => {
    const home = await temporaryDirectory();
    const configPath = await writeProductionConfig(home, "production-safe.yaml");
    const result = await loadConfig({
      explicitPath: configPath,
      env: {},
      platform: "linux",
      home,
    });
    expect(result.config.mode).toBe("production");
    expect(result.config.paths.state).toBe(path.join(linuxStateRoot(home), "state"));
  });

  it("rejects production logs in a sibling of the dedicated log root", async () => {
    const home = await temporaryDirectory();
    const stateRoot = linuxStateRoot(home);
    const configPath = await writeProductionConfig(
      home,
      "production-log-sibling.yaml",
      validYaml(stateRoot, "production").replace(
        `logs: ${stateRoot}/logs`,
        `logs: ${stateRoot}/not-the-log-root`,
      ),
    );
    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("rejects relative runtime paths", async () => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, "relative.yaml");
    await writeFile(configPath, validYaml(root).replace(`${root}/state`, "relative/state"), {
      mode: 0o600,
    });
    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home: root }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
  });
});
