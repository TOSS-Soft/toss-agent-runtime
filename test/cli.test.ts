import { describe, expect, it } from "vitest";

import { defaultConfig } from "../src/config/load.js";
import { runCli } from "../src/cli/main.js";

const platform = { os: "linux" as const, arch: "x64", node: "22.23.1" };

const services = {
  platform,
  loadConfig: () =>
    Promise.resolve({
      config: defaultConfig("linux", "/home/test"),
      source: "defaults",
    }),
};

describe("baseline CLI", () => {
  it("returns one versioned capabilities result in JSON mode", async () => {
    const output = await runCli(["capabilities", "--json"], services);
    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      schema_version: "command-result.v1",
      document_type: "command-result",
      command: "capabilities",
      ok: true,
      exit_code: 0,
      data: { document_type: "runtime-capabilities" },
      error: null,
    });
  });

  it("rejects credential-shaped options without reflecting their values", async () => {
    const output = await runCli(["doctor", "--api-key", "must-not-persist"], services);
    expect(output.exitCode).toBe(2);
    expect(output.stdout).not.toContain("must-not-persist");
    expect(output.stderr).not.toContain("must-not-persist");
    expect(output.stderr).toContain("--api-key");
  });

  it("keeps stderr empty for routed JSON failures", async () => {
    const output = await runCli(["unknown", "--json"], services);
    expect(output.exitCode).toBe(2);
    expect(output.stderr).toBe("");
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, exit_code: 2 });
  });

  it("renders stable human help and version output", async () => {
    const help = await runCli(["--help"], services);
    const version = await runCli(["--version"], services);
    expect(help).toMatchObject({ exitCode: 0, stderr: "" });
    expect(help.stdout).toContain("toss-runtime capabilities [--json]");
    expect(version.stdout.trim()).toBe("0.0.0-development");
  });

  it("reports a healthy development baseline with explicit future warnings", async () => {
    const output = await runCli(["doctor", "--json"], services);
    const document = JSON.parse(output.stdout) as {
      readonly data: {
        readonly healthy: boolean;
        readonly checks: readonly { readonly id: string; readonly status: string }[];
      };
    };
    expect(output.exitCode).toBe(0);
    expect(document.data.healthy).toBe(true);
    expect(document.data.checks).toContainEqual({
      id: "execution-capabilities",
      status: "WARN",
      message:
        "Execution providers, skills, MCP, and orchestration are not installed in the baseline wave",
    });
  });

  it("fails doctor on an unsupported Node line", async () => {
    const output = await runCli(["doctor", "--json"], {
      ...services,
      platform: { ...platform, node: "26.6.0" },
    });
    expect(output.exitCode).toBe(5);
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, exit_code: 5 });
  });

  it("reports serve as unavailable until the lifecycle task is installed", async () => {
    const output = await runCli(["serve", "--json"], services);
    expect(output.exitCode).toBe(69);
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      error: { code: "RUNTIME_SERVE_UNAVAILABLE" },
    });
  });

  it.each([
    [["doctor", "--config"], "Missing value for --config"],
    [["capabilities", "--config", "/tmp/config"], "Unknown option for capabilities: --config"],
    [["doctor", "--unknown"], "Unknown option for doctor: --unknown"],
  ])("rejects malformed grammar %#", async (argv, message) => {
    const output = await runCli(argv, services);
    expect(output.exitCode).toBe(2);
    expect(output.stderr).toContain(message);
  });
});
