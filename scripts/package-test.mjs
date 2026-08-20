import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedPackageFiles = JSON.parse(
  await readFile(path.join(root, "scripts", "package-files.json"), "utf8"),
);

const REQUIRED_FILES = Object.freeze([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "bin/toss-runtime.js",
  "contracts/runtime/command-result.v1.schema.json",
  "contracts/runtime/execution-event.v1.schema.json",
  "contracts/runtime/execution-request.v1.schema.json",
  "contracts/runtime/execution-result.v1.schema.json",
  "contracts/runtime/runtime-capabilities.v1.schema.json",
  "contracts/runtime/runtime-common.v1.schema.json",
  "contracts/runtime/runtime-config.v1.schema.json",
  "dist/src/index.d.ts",
  "dist/src/index.js",
  "docs/contracts/runtime-contract-protocol-v1.md",
  "docs/contracts/runtime-contract-v1.manifest.json",
  "docs/contracts/toss-cli-v2.2-compatibility.md",
  "examples/config/runtime.development.yaml",
  "examples/runtime-contract-v1/execution-event.json",
  "examples/runtime-contract-v1/execution-request.json",
  "examples/runtime-contract-v1/execution-result.json",
  "examples/runtime-contract-v1/runtime-capabilities.json",
  "package.json",
]);

const ALLOWED_PATHS = Object.freeze([
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
  /^README\.md$/,
  /^package\.json$/,
  /^bin\/toss-runtime\.js$/,
  /^contracts\/runtime\/[a-z0-9.-]+\.schema\.json$/,
  /^dist\/contracts\/runtime\/[a-z0-9.-]+\.schema\.json$/,
  /^dist\/src\/[a-z0-9_./-]+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/,
  /^docs\/contracts\/[a-z0-9._-]+\.(?:md|json)$/,
  /^examples\/config\/runtime\.development\.yaml$/,
  /^examples\/runtime-contract-v1\/[a-z0-9._-]+\.json$/,
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPackageFiles(files) {
  const paths = files.map((entry) => entry.path).sort();
  assert(
    JSON.stringify(paths) === JSON.stringify(expectedPackageFiles),
    "Published package file list differs from scripts/package-files.json",
  );
  for (const required of REQUIRED_FILES) {
    assert(paths.includes(required), `Published package is missing ${required}`);
  }
  for (const publishedPath of paths) {
    assert(
      ALLOWED_PATHS.some((pattern) => pattern.test(publishedPath)),
      `Published package contains an unapproved path: ${publishedPath}`,
    );
    assert(
      !/(?:^|\/)(?:test|tests|fixtures)(?:\/|$)/i.test(publishedPath),
      `Test material leaked: ${publishedPath}`,
    );
    assert(
      !/(?:^|\/)(?:\.env|id_rsa|id_ed25519)(?:\.|$)/i.test(publishedPath),
      `Credential-shaped file leaked: ${publishedPath}`,
    );
    assert(
      !/(?:^|\/)[^/]*(?:credential|password|private[-_.]?key|token)[^/]*(?:\/|$)/i.test(
        publishedPath,
      ),
      `Secret-shaped file name leaked: ${publishedPath}`,
    );
  }
}

async function assertExecutableSignalShutdown(executable, configPath, signal) {
  const child = spawn(executable, ["serve", "--json", "--config", configPath], {
    cwd: path.dirname(configPath),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const outcome = await new Promise((resolve, reject) => {
    const forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    let ready = false;
    child.once("message", (message) => {
      if (message?.type !== "toss-runtime-ready") return;
      ready = true;
      child.kill(signal);
    });
    child.once("error", (error) => {
      clearTimeout(forceTimer);
      reject(error);
    });
    child.once("close", (code, closeSignal) => {
      clearTimeout(forceTimer);
      resolve({ code, signal: closeSignal, ready });
    });
  });

  assert(
    outcome.ready && outcome.code === 0 && outcome.signal === null,
    `${signal} shutdown was not graceful: ${JSON.stringify(outcome)}; stderr=${JSON.stringify(stderr)}`,
  );
  assert(stderr === "", `${signal} shutdown wrote to stderr`);
  const result = JSON.parse(stdout);
  assert(result.ok === true && result.exit_code === 0, `${signal} result was not successful`);
  if (child.pid !== undefined) {
    try {
      process.kill(child.pid, 0);
      throw new Error(`${signal} process survived terminal close`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code !== "ESRCH") throw error;
    }
  }
}

let temporaryDirectory;
let tarballPath;
try {
  const packed = await execFile(npmCommand, ["pack", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const report = JSON.parse(packed.stdout);
  assert(Array.isArray(report) && report.length === 1, "npm pack returned an unexpected report");
  const packageReport = report[0];
  assert(typeof packageReport.filename === "string", "npm pack did not report a filename");
  assert(Array.isArray(packageReport.files), "npm pack did not report package files");
  tarballPath = path.join(root, packageReport.filename);
  assertPackageFiles(packageReport.files);

  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "toss-runtime-package-"));
  await execFile(npmCommand, ["init", "--yes"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  await execFile(
    npmCommand,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
    { cwd: temporaryDirectory, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );

  await execFile(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { parseExecutionRequest, validateExecutionChain } from "@toss-software/agent-runtime"; if (typeof parseExecutionRequest !== "function" || typeof validateExecutionChain !== "function") process.exit(1);',
    ],
    { cwd: temporaryDirectory, encoding: "utf8" },
  );

  const executable = path.join(
    temporaryDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "toss-runtime.cmd" : "toss-runtime",
  );
  const help = await execFile(executable, ["--help"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  assert(help.stdout.includes("toss-runtime capabilities"), "Installed executable help failed");
  const version = await execFile(executable, ["--version"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  assert(version.stdout.trim() === "0.0.0-development", "Installed executable version failed");
  const capabilities = await execFile(executable, ["capabilities", "--json"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  const capabilityResult = JSON.parse(capabilities.stdout);
  assert(capabilityResult.ok === true, "Installed executable capability command failed");
  assert(
    capabilityResult.data?.schema_version === "runtime-capabilities.v1",
    "Installed executable returned an unexpected capability document",
  );

  const installedRoot = path.join(
    temporaryDirectory,
    "node_modules",
    "@toss-software",
    "agent-runtime",
  );
  const installedConfig = path.join(
    installedRoot,
    "examples",
    "config",
    "runtime.development.yaml",
  );
  await assertExecutableSignalShutdown(executable, installedConfig, "SIGTERM");
  await assertExecutableSignalShutdown(executable, installedConfig, "SIGINT");

  const missingConfigPath = path.join(temporaryDirectory, "missing-runtime.yaml");
  let missingConfigFailure;
  try {
    await execFile(executable, ["serve", "--json", "--config", missingConfigPath], {
      cwd: temporaryDirectory,
      encoding: "utf8",
    });
    throw new Error("Installed executable accepted a missing serve config");
  } catch (error) {
    missingConfigFailure = error;
  }
  assert(missingConfigFailure.code === 5, "Missing serve config returned an unstable exit code");
  assert(missingConfigFailure.stderr === "", "Missing serve config wrote to stderr");
  assert(
    !missingConfigFailure.stdout.includes(missingConfigPath),
    "Missing serve config reflected a local path",
  );
  assert(
    JSON.parse(missingConfigFailure.stdout).error?.code === "RUNTIME_CONFIG_UNAVAILABLE",
    "Missing serve config did not return a safe command result",
  );

  const installedManifest = JSON.parse(
    await readFile(
      path.join(installedRoot, "docs", "contracts", "runtime-contract-v1.manifest.json"),
      "utf8",
    ),
  );
  assert(installedManifest.protocol_version === "runtime-contract.v1", "Installed manifest failed");
  process.stdout.write(
    `Verified ${packageReport.filename} (${packageReport.files.length} files)\n`,
  );
} finally {
  if (temporaryDirectory !== undefined)
    await rm(temporaryDirectory, { recursive: true, force: true });
  if (tarballPath !== undefined) await rm(tarballPath, { force: true });
}
