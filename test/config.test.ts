import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultConfig, loadConfig } from "../src/config/load.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "toss-runtime-config-"));
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
    const configPath = path.join(root, "production.yaml");
    await writeFile(configPath, validYaml(root, "production"), { mode: 0o600 });
    await chmod(configPath, 0o666);
    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home: root }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("rejects group/world-readable production configuration", async () => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, "production-readable.yaml");
    await writeFile(configPath, validYaml(root, "production"), { mode: 0o600 });
    await chmod(configPath, 0o644);
    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home: root }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("rejects production runtime paths outside approved per-user roots", async () => {
    const home = await temporaryDirectory();
    const shared = await temporaryDirectory();
    const configPath = path.join(home, "production-outside.yaml");
    await writeFile(configPath, validYaml(shared, "production"), { mode: 0o600 });
    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("rejects unsafe existing directories in a production runtime path", async () => {
    const home = await temporaryDirectory();
    const shared = path.join(home, "shared");
    await mkdir(shared, { mode: 0o700 });
    await chmod(shared, 0o777);
    const configPath = path.join(home, "production-shared.yaml");
    await writeFile(configPath, validYaml(shared, "production"), { mode: 0o600 });
    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_UNSAFE" });
  });

  it("rejects a production config outside approved per-user roots", async () => {
    const home = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const configPath = path.join(outside, "production.yaml");
    await writeFile(configPath, validYaml(home, "production"), { mode: 0o600 });
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
