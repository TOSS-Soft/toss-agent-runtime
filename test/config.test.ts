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
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultConfig,
  loadConfig,
  resolveDefaultConfigPath,
  RuntimeConfigError,
} from "../src/config/load.js";
import * as servicePaths from "../src/service/paths.js";

const temporaryDirectories: string[] = [];
const RUNTIME_CONFIG_BYTE_CAP = 2 * 1024 * 1024;
const reservedArtifactBasenames = {
  legacyPublicationGuard: ".c1234abcd",
  publicationGuard: `.c${"a".repeat(64)}`,
  publicationClaim: `.r${"a".repeat(64)}`,
  previousStagedSocket: `.s${"a".repeat(25)}`,
  stagedSocket: ".sabcdefghij",
  socketClaim: ".xabcdefghij",
} as const;
const nearMissArtifactBasenames = [
  "xabcdefghij",
  ".xabcdefghi",
  ".xabcdefghijk",
  ".xabcdefghiA",
  ".xabcdefghié",
  ".sabcdefghi",
  ".sabcdefghijk",
  `.s${"a".repeat(24)}`,
  `.s${"a".repeat(26)}`,
  ".cgggggggg",
  `.c${"a".repeat(63)}`,
  `.c${"a".repeat(63)}g`,
  `.r${"a".repeat(63)}`,
  `.r${"a".repeat(63)}g`,
] as const;

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(path.join(await realpath("/tmp"), "toss-runtime-config-")),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function validYaml(root: string, mode: "development" | "production" = "development"): string {
  const gatewayProfiles =
    mode === "production"
      ? `gateway_profiles:
  gateway-production:
    protocol: toss-agentgateway.v1
    endpoint: https://gateway.example.test
    credential_reference: gateway-virtual-token
    body_observability: "off"`
      : "gateway_profiles: {}";
  const secretReferences =
    mode === "production"
      ? `secret_references:
  gateway-virtual-token:
    source: command
    key: TOSS_AGENTGATEWAY_TOKEN`
      : "secret_references: {}";
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
${gatewayProfiles}
provider_profiles: []
mcp_profiles: []
skill_roots: []
${secretReferences}
`;
}

function developmentGatewayYaml(root: string, endpoint: string): string {
  return validYaml(root)
    .replace("gateway_profile: null", "gateway_profile: gateway-development")
    .replace(
      "gateway_profiles: {}",
      `gateway_profiles:
  gateway-development:
    protocol: toss-agentgateway.v1
    endpoint: ${endpoint}
    credential_reference: gateway-virtual-token
    body_observability: "off"`,
    )
    .replace(
      "secret_references: {}",
      `secret_references:
  gateway-virtual-token:
    source: env
    key: TOSS_AGENTGATEWAY_TOKEN`,
    );
}

function validYamlWithSocket(root: string, socket: string): string {
  return validYaml(root).replace(`socket: ${root}/runtime.sock`, `socket: ${socket}`);
}

function validYamlWithSkillRoots(root: string, skillRoots: readonly string[]): string {
  return validYaml(root).replace(
    "skill_roots: []",
    `skill_roots:\n${skillRoots.map((skillRoot) => `  - ${skillRoot}`).join("\n")}`,
  );
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
  it("defaults to bundled skills without scanning a user or project root", () => {
    expect(defaultConfig("darwin", "/Users/test").skill_roots).toEqual([]);
  });

  it("accepts ASCII-sorted unique configured skill roots", async () => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, "config.yaml");
    await writeFile(
      configPath,
      validYamlWithSkillRoots(root, ["/opt/toss/skills-a", "/opt/toss/skills-b"]),
      { mode: 0o600 },
    );

    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home: root }),
    ).resolves.toMatchObject({
      config: { skill_roots: ["/opt/toss/skills-a", "/opt/toss/skills-b"] },
    });
  });

  it("accepts configured skill roots in bytewise UTF-8 order", async () => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, "config.yaml");
    await writeFile(configPath, validYamlWithSkillRoots(root, ["/opt/\uE000", "/opt/😀"]), {
      mode: 0o600,
    });

    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home: root }),
    ).resolves.toMatchObject({ config: { skill_roots: ["/opt/\uE000", "/opt/😀"] } });
  });

  it.each([
    [
      "more than sixteen roots",
      Array.from({ length: 17 }, (_, index) => `/opt/skills-${String(index).padStart(2, "0")}`),
    ],
    ["relative root", ["relative/skills"]],
    ["control character", ["/opt/unsafe\u0000skills"]],
    ["normalization alias", ["/opt/toss/../skills"]],
    ["duplicate root", ["/opt/toss/skills", "/opt/toss/skills"]],
    ["trailing-separator root alias", ["/opt/toss/skills", "/opt/toss/skills/"]],
    ["unsorted roots", ["/opt/toss/skills-b", "/opt/toss/skills-a"]],
    ["reverse bytewise UTF-8 order", ["/opt/😀", "/opt/\uE000"]],
    ["ancestor overlap", ["/opt/toss/skills", "/opt/toss/skills/references"]],
  ] as const)("rejects %s in configured skill roots", async (_name, skillRoots) => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, "config.yaml");
    await writeFile(configPath, validYamlWithSkillRoots(root, skillRoots), { mode: 0o600 });

    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home: root }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
  });

  it("keeps the shared control-artifact registry and scanner predicates in exact parity", () => {
    const pathsModule = servicePaths as typeof servicePaths & {
      readonly SERVICE_CONTROL_ARTIFACT_PATTERNS?: Readonly<Record<string, RegExp>>;
      readonly isServiceControlArtifactBasename?: (candidate: string) => boolean;
      readonly isServiceControlStagedArtifactBasename?: (candidate: string) => boolean;
      readonly isServiceControlSocketClaimBasename?: (candidate: string) => boolean;
    };
    const registry = pathsModule.SERVICE_CONTROL_ARTIFACT_PATTERNS;
    const isArtifact = pathsModule.isServiceControlArtifactBasename;
    const isStaged = pathsModule.isServiceControlStagedArtifactBasename;
    const isSocketClaim = pathsModule.isServiceControlSocketClaimBasename;

    expect(registry).toBeDefined();
    expect(isArtifact).toBeTypeOf("function");
    expect(isStaged).toBeTypeOf("function");
    expect(isSocketClaim).toBeTypeOf("function");
    if (
      registry === undefined ||
      isArtifact === undefined ||
      isStaged === undefined ||
      isSocketClaim === undefined
    ) {
      return;
    }

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.keys(registry).sort()).toEqual(Object.keys(reservedArtifactBasenames).sort());
    for (const [name, basename] of Object.entries(reservedArtifactBasenames)) {
      const pattern = registry[name];
      expect(pattern, name).toBeInstanceOf(RegExp);
      expect(Object.isFrozen(pattern), name).toBe(true);
      expect(pattern!.global, name).toBe(false);
      expect(pattern!.test(basename), name).toBe(true);
      expect(isArtifact(basename), name).toBe(true);
      expect(isStaged(basename), name).toBe(
        ["legacyPublicationGuard", "previousStagedSocket", "stagedSocket"].includes(name),
      );
      expect(isSocketClaim(basename), name).toBe(name === "socketClaim");
    }
  });

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
    expect(result.config.gateway_profiles).toEqual({});
    expect(Object.isFrozen(result.config.gateway_profiles)).toBe(true);
  });

  it("accepts one selected HTTPS production gateway with a command credential", async () => {
    const home = await temporaryDirectory();
    const configPath = await writeProductionConfig(home, "gateway-production.yaml");

    const result = await loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home });

    expect(result.config.gateway_profile).toBe("gateway-production");
    expect(result.config.gateway_profiles["gateway-production"]).toEqual({
      protocol: "toss-agentgateway.v1",
      endpoint: "https://gateway.example.test",
      credential_reference: "gateway-virtual-token",
      body_observability: "off",
    });
  });

  it.each([
    [
      "missing selected profile",
      (yaml: string) =>
        yaml.replace("gateway_profile: gateway-production", "gateway_profile: missing"),
    ],
    [
      "missing credential reference",
      (yaml: string) =>
        yaml.replace(
          "credential_reference: gateway-virtual-token",
          "credential_reference: missing",
        ),
    ],
    ["environment credential", (yaml: string) => yaml.replace("source: command", "source: env")],
    [
      "HTTP endpoint",
      (yaml: string) => yaml.replace("https://gateway.example.test", "http://gateway.example.test"),
    ],
    [
      "endpoint userinfo",
      (yaml: string) =>
        yaml.replace("https://gateway.example.test", "https://user@gateway.example.test"),
    ],
    [
      "endpoint query",
      (yaml: string) =>
        yaml.replace("https://gateway.example.test", "https://gateway.example.test?q=1"),
    ],
    [
      "endpoint fragment",
      (yaml: string) =>
        yaml.replace("https://gateway.example.test", "https://gateway.example.test#x"),
    ],
    [
      "direct provider profile",
      (yaml: string) => yaml.replace("provider_profiles: []", "provider_profiles: [direct-openai]"),
    ],
  ] as const)("rejects production %s without reflecting the endpoint", async (_name, mutate) => {
    const home = await temporaryDirectory();
    const yaml = mutate(validYaml(linuxStateRoot(home), "production"));
    const configPath = await writeProductionConfig(home, "invalid-gateway.yaml", yaml);

    let error: unknown;
    try {
      await loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
    expect(String(error)).not.toContain("gateway.example.test");
  });

  it.each(["http://127.0.0.1:8080", "http://[::1]:8080", "http://localhost:8080/base/"])(
    "accepts development loopback gateway endpoint %s",
    async (endpoint) => {
      const root = await temporaryDirectory();
      const configPath = path.join(root, "development-gateway.yaml");
      await writeFile(configPath, developmentGatewayYaml(root, endpoint), { mode: 0o600 });

      const result = await loadConfig({
        explicitPath: configPath,
        env: {},
        platform: "linux",
        home: root,
      });

      expect(result.config.gateway_profiles["gateway-development"]?.endpoint).toBe(endpoint);
    },
  );

  it("rejects a development non-loopback HTTP gateway", async () => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, "development-non-loopback.yaml");
    await writeFile(configPath, developmentGatewayYaml(root, "http://gateway.example.test"), {
      mode: 0o600,
    });

    await expect(
      loadConfig({ explicitPath: configPath, env: {}, platform: "linux", home: root }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
  });

  it("validates the default socket layout before returning a missing-file fallback", async () => {
    const root = await temporaryDirectory();
    const socket = defaultConfig("darwin", root).paths.socket;

    await expect(
      loadConfig({
        env: {},
        platform: "darwin",
        home: root,
        socketPathByteLimit: Buffer.byteLength(socket) - 1,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
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

  it("rejects a native-fit public socket whose internal siblings exceed an injected budget", async () => {
    const root = await temporaryDirectory();
    const socket = path.join(root, "a");
    const configPath = path.join(root, "short-public.yaml");
    await writeFile(configPath, validYamlWithSocket(root, socket), { mode: 0o600 });
    let error: unknown;

    try {
      await loadConfig({
        explicitPath: configPath,
        env: {},
        platform: "linux",
        home: root,
        socketPathByteLimit: Buffer.byteLength(socket),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RuntimeConfigError);
    expect(error).toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
    expect(String(error)).not.toContain(socket);
    expect(String(error)).not.toContain(String(Buffer.byteLength(socket)));
  });

  it("counts multibyte parent and basename characters as UTF-8 socket-path bytes", async () => {
    const root = await temporaryDirectory();
    const runtime = path.join(root, "🚀");
    const socket = path.join(runtime, "é");
    const internalSibling = path.join(runtime, ".s0123456789");
    const configPath = path.join(root, "multibyte-socket.yaml");
    await writeFile(configPath, validYamlWithSocket(root, socket), { mode: 0o600 });

    await expect(
      loadConfig({
        explicitPath: configPath,
        env: {},
        platform: "linux",
        home: root,
        socketPathByteLimit: Buffer.byteLength(internalSibling) - 1,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
    await expect(lstat(runtime)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts a short public socket when every internal sibling fits the exact injected budget", async () => {
    const root = await temporaryDirectory();
    const socket = path.join(root, "a");
    const internalSibling = path.join(root, ".x0123456789");
    const configPath = path.join(root, "short-public-valid.yaml");
    await writeFile(configPath, validYamlWithSocket(root, socket), { mode: 0o600 });

    const loaded = await loadConfig({
      explicitPath: configPath,
      env: {},
      platform: "linux",
      home: root,
      socketPathByteLimit: Buffer.byteLength(internalSibling),
    });

    expect(loaded.config.paths.socket).toBe(socket);
  });

  it.each(Object.entries(reservedArtifactBasenames))(
    "rejects the reserved %s public socket basename during config validation",
    async (_name, basename) => {
      const root = await temporaryDirectory();
      const socket = path.join(root, basename);
      const configPath = path.join(root, "reserved-socket.yaml");
      await writeFile(configPath, validYamlWithSocket(root, socket), { mode: 0o600 });
      let error: unknown;

      try {
        await loadConfig({
          explicitPath: configPath,
          env: {},
          platform: "linux",
          home: root,
          socketPathByteLimit: 4096,
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(RuntimeConfigError);
      expect(error).toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
      expect(String(error)).not.toContain(basename);
    },
  );

  it.each(nearMissArtifactBasenames)(
    "allows the non-reserved public socket basename %s during config validation",
    async (basename) => {
      const root = await temporaryDirectory();
      const socket = path.join(root, basename);
      const configPath = path.join(root, "near-miss-socket.yaml");
      await writeFile(configPath, validYamlWithSocket(root, socket), { mode: 0o600 });

      const loaded = await loadConfig({
        explicitPath: configPath,
        env: {},
        platform: "linux",
        home: root,
        socketPathByteLimit: 4096,
      });

      expect(loaded.config.paths.socket).toBe(socket);
    },
  );

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
