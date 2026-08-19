import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderServiceDefinition, type ServiceDefinitionInput } from "../src/service/definition.js";

const temporaryDirectories: string[] = [];
const NATIVE_VALIDATION_TIMEOUT_MS = 5_000;

interface NativeCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "toss-runtime-native-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function rendererInput(platform: "darwin" | "linux"): Promise<ServiceDefinitionInput> {
  const root = await temporaryDirectory();
  const cliPath = path.join(root, "toss-runtime.js");
  const configPath = path.join(root, "runtime.development.yaml");
  await writeFile(cliPath, "#!/usr/bin/env node\n", { mode: 0o700 });
  await writeFile(configPath, "mode: development\n", { mode: 0o600 });
  return {
    platform,
    uid: typeof process.getuid === "function" ? process.getuid() : 501,
    nodePath: process.execPath,
    cliPath,
    configPath,
    environment: { LANG: "C", TZ: "UTC" },
  };
}

function runWithInput(
  file: string,
  args: readonly string[],
  input?: string,
): Promise<NativeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), NATIVE_VALIDATION_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function runFile(file: string, args: readonly string[]): Promise<NativeCommandResult> {
  return runWithInput(file, args);
}

async function writeTemporaryUnit(content: string): Promise<string> {
  const root = await temporaryDirectory();
  const unit = path.join(root, "toss-agent-runtime.service");
  await writeFile(unit, content, { mode: 0o600 });
  return unit;
}

describe("native service definition validation", () => {
  it.runIf(process.platform === "darwin")("passes native launchd plist validation", async () => {
    const definition = renderServiceDefinition(await rendererInput("darwin"));
    const result = await runWithInput("/usr/bin/plutil", ["-lint", "-"], definition);

    expect(result, `${result.stdout}\n${result.stderr}`).toMatchObject({
      exitCode: 0,
      signal: null,
    });
  });

  it.runIf(process.platform === "linux")("passes native systemd unit validation", async () => {
    const definition = renderServiceDefinition(await rendererInput("linux"));
    const unit = await writeTemporaryUnit(definition);
    const result = await runFile("/usr/bin/systemd-analyze", ["verify", unit]);

    expect(result, `${result.stdout}\n${result.stderr}`).toMatchObject({
      exitCode: 0,
      signal: null,
    });
  });
});
