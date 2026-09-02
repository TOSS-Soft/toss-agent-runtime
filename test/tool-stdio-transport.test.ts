import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { SecretReference } from "../src/config/types.js";
import {
  createStdioToolTransport,
  type StdioLifecycleObservation,
  type StdioSecretProvider,
} from "../src/tools/transports/stdio.js";
import type { McpStdioBinding } from "../src/tools/types.js";

const fixturePath = fileURLToPath(new URL("./fixtures/mcp/stdio-server.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "toss-mcp-stdio-")));
  temporaryDirectories.push(directory);
  return directory;
}

function binding(cwd: string, args: readonly string[] = []): McpStdioBinding {
  return {
    transport: "stdio",
    command: process.execPath,
    args: [fixturePath, ...args],
    cwd,
    environment: {
      FIXED_VALUE: { kind: "literal", value: "configured" },
      MCP_TOKEN: { kind: "secret-reference", reference: "mcp_token" },
    },
  };
}

function secretProvider(expiresInMs = 60_000): StdioSecretProvider {
  return {
    resolve(reference: SecretReference) {
      void reference;
      return Promise.resolve({
        value: "stdio-secret-value-1234",
        expires_at: new Date(Date.now() + expiresInMs).toISOString(),
      });
    },
  };
}

function adapterOptions(
  stdioBinding: McpStdioBinding,
  observations: StdioLifecycleObservation[] = [],
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    binding: stdioBinding,
    mode: "development" as const,
    secret_references: {
      mcp_token: { source: "env", key: "MCP_TOKEN_SOURCE" } as const,
    },
    secret_provider: secretProvider(),
    session_lifetime_ms: 60_000,
    graceful_close_ms: 50,
    terminate_ms: 50,
    lease_safety_ms: 5,
    on_lifecycle: (observation: StdioLifecycleObservation) => observations.push(observation),
    ...overrides,
  };
}

describe("hardened stdio MCP transport", () => {
  it("spawns a real child with only fixed trusted arguments and an explicit minimal environment", async () => {
    const root = await temporaryDirectory();
    const observationPath = path.join(root, "child-observation.json");
    const observations: StdioLifecycleObservation[] = [];
    const adapter = createStdioToolTransport(
      adapterOptions(binding(root, [`--observe=${observationPath}`]), observations),
    );
    const connection = await adapter.connect({
      protocol_revision: "2025-06-18",
      timeout_ms: 2_000,
      signal: new AbortController().signal,
      on_tools_changed: () => undefined,
    });

    const child = JSON.parse(await readFile(observationPath, "utf8")) as {
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly executable: string;
    };
    expect(child).toMatchObject({
      cwd: root,
      executable: process.execPath,
      argv: [fixturePath, `--observe=${observationPath}`],
    });
    const expectedEnvironment = {
      FIXED_VALUE: "configured",
      MCP_TOKEN: "stdio-secret-value-1234",
      TOSS_MCP_PROTOCOL_REVISION: "2025-06-18",
      TOSS_MCP_TRANSPORT: "stdio",
      TOSS_RUNTIME_PROTOCOL_VERSION: "runtime-contract.v1",
    };
    expect(child.env).toMatchObject(expectedEnvironment);
    expect(Object.keys(child.env).sort()).toEqual(
      [
        ...Object.keys(expectedEnvironment),
        ...(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : []),
      ].sort(),
    );
    expect(child.env).not.toHaveProperty("PATH");
    expect(observations[0]).toMatchObject({
      event: "spawn",
      command: process.execPath,
      cwd: root,
      shell: false,
    });
    await expect(connection.listTools(null, new AbortController().signal)).resolves.toMatchObject({
      tools: [{ name: "echo" }],
    });

    await connection.close(new AbortController().signal);
    expect(observations.some((observation) => observation.event === "exit")).toBe(true);
    expect(observations.some((observation) => observation.event === "signal")).toBe(false);
  });

  it.each([
    ["relative command", { command: "node" }],
    ["relative cwd", { cwd: "relative" }],
  ])("rejects a %s before spawning", async (_name, change) => {
    const root = await temporaryDirectory();
    expect(() =>
      createStdioToolTransport(adapterOptions({ ...binding(root), ...change })),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_INVALID" }));
  });

  it("rejects secret-shaped literal environment values in production", async () => {
    const root = await temporaryDirectory();
    const configured = binding(root);
    expect(() =>
      createStdioToolTransport({
        ...adapterOptions({
          ...configured,
          environment: { API_TOKEN: { kind: "literal", value: "not-allowed" } },
        }),
        mode: "production",
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_INVALID" }));
  });

  it("bounds and redacts stderr while timing out initialization and reaping the child", async () => {
    const root = await temporaryDirectory();
    const observations: StdioLifecycleObservation[] = [];
    const secret = "stderr-secret-must-not-escape";
    const configured = binding(root, [
      "--hang-initialize",
      "--emit-stderr-secret",
      "--stderr-bytes=20000",
    ]);
    const adapter = createStdioToolTransport(adapterOptions(configured, observations));

    let failure: unknown;
    try {
      await adapter.connect({
        protocol_revision: "2025-06-18",
        timeout_ms: 100,
        signal: new AbortController().signal,
        on_tools_changed: () => undefined,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "RUNTIME_TOOL_TIMEOUT" });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(JSON.stringify(observations)).not.toContain(secret);
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "stderr-summary", truncated: true }),
        expect.objectContaining({ event: "exit" }),
      ]),
    );
  });

  it("expires and closes a session before the shortest secret lease", async () => {
    const root = await temporaryDirectory();
    const observations: StdioLifecycleObservation[] = [];
    const adapter = createStdioToolTransport(
      adapterOptions(binding(root), observations, {
        secret_provider: secretProvider(100),
        session_lifetime_ms: 5_000,
        lease_safety_ms: 20,
      }),
    );
    const connection = await adapter.connect({
      protocol_revision: "2025-06-18",
      timeout_ms: 1_000,
      signal: new AbortController().signal,
      on_tools_changed: () => undefined,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 130));
    await expect(connection.listTools(null, new AbortController().signal)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_AUTHENTICATION",
    });
    expect(observations.some((observation) => observation.event === "exit")).toBe(true);
  });

  it("cancels initialization and awaits child reaping", async () => {
    const root = await temporaryDirectory();
    const observations: StdioLifecycleObservation[] = [];
    const adapter = createStdioToolTransport(
      adapterOptions(binding(root, ["--hang-initialize"]), observations),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    await expect(
      adapter.connect({
        protocol_revision: "2025-06-18",
        timeout_ms: 1_000,
        signal: controller.signal,
        on_tools_changed: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_CANCELLED" });
    expect(observations.at(-1)).toMatchObject({ event: "exit" });
  });

  it("escalates stdin close to SIGTERM and SIGKILL, then awaits exit", async () => {
    const root = await temporaryDirectory();
    const observations: StdioLifecycleObservation[] = [];
    const adapter = createStdioToolTransport(
      adapterOptions(binding(root, ["--ignore-close"]), observations, {
        graceful_close_ms: 25,
        terminate_ms: 25,
      }),
    );
    const connection = await adapter.connect({
      protocol_revision: "2025-06-18",
      timeout_ms: 1_000,
      signal: new AbortController().signal,
      on_tools_changed: () => undefined,
    });

    await connection.close(new AbortController().signal);
    const lifecycle = observations.flatMap((observation) => {
      if (observation.event === "signal") return [`${observation.event}:${observation.signal}`];
      return observation.event === "exit" ? [observation.event] : [];
    });
    expect(lifecycle.slice(-3)).toEqual(["signal:SIGTERM", "signal:SIGKILL", "exit"]);
  });
});
