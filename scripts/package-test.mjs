import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const CONTENTS_ONLY_ARGUMENT = "--contents-only";
const PREPACK_PROBE_ENV = "TOSS_RUNTIME_PREPACK_PROBE";
const PACK_DESTINATION_ENV = "npm_config_pack_destination";
const contentsOnly = process.argv.slice(2).includes(CONTENTS_ONLY_ARGUMENT);
assertArguments();
const inheritedPath = process.env.PATH ?? "";
const installedLauncherEnvironment = Object.freeze({
  ...process.env,
  PATH:
    inheritedPath.length === 0
      ? path.dirname(process.execPath)
      : `${path.dirname(process.execPath)}${path.delimiter}${inheritedPath}`,
});
const expectedPackageFiles = JSON.parse(
  await readFile(path.join(root, "scripts", "package-files.json"), "utf8"),
);

const REQUIRED_FILES = Object.freeze([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "bin/toss-runtime.js",
  "contracts/runtime/command-result.v1.schema.json",
  "contracts/runtime/candidate-job-intent.v1.schema.json",
  "contracts/runtime/execution-event.v1.schema.json",
  "contracts/runtime/execution-request.v1.schema.json",
  "contracts/runtime/execution-result.v1.schema.json",
  "contracts/runtime/project-registry-entry.v1.schema.json",
  "contracts/runtime/project-watch-manifest.v1.schema.json",
  "contracts/runtime/runtime-capabilities.v1.schema.json",
  "contracts/runtime/runtime-common.v1.schema.json",
  "contracts/runtime/runtime-config.v1.schema.json",
  "contracts/runtime/service-control-request.v1.schema.json",
  "contracts/runtime/service-control-response.v1.schema.json",
  "contracts/runtime/service-lock.v1.schema.json",
  "dist/contracts/runtime/candidate-job-intent.v1.schema.json",
  "dist/contracts/runtime/project-registry-entry.v1.schema.json",
  "dist/contracts/runtime/project-watch-manifest.v1.schema.json",
  "dist/contracts/runtime/service-control-request.v1.schema.json",
  "dist/contracts/runtime/service-control-response.v1.schema.json",
  "dist/contracts/runtime/service-lock.v1.schema.json",
  "dist/src/service/project/contracts.d.ts",
  "dist/src/service/project/contracts.js",
  "dist/src/service/project/errors.d.ts",
  "dist/src/service/project/errors.js",
  "dist/src/service/project/index.js",
  "dist/src/service/project/intake.js",
  "dist/src/service/project/interfaces.d.ts",
  "dist/src/service/project/interfaces.js",
  "dist/src/service/project/paths.js",
  "dist/src/service/project/private-files.js",
  "dist/src/service/project/registry.js",
  "dist/src/service/project/types.d.ts",
  "dist/src/service/project/types.js",
  "dist/src/service/project/watcher.js",
  "dist/src/index.d.ts",
  "dist/src/index.js",
  "dist/src/platform/commands.d.ts",
  "dist/src/platform/commands.js",
  "dist/src/service/contracts.d.ts",
  "dist/src/service/contracts.js",
  "dist/src/service/control.d.ts",
  "dist/src/service/control.js",
  "dist/src/service/definition-store.d.ts",
  "dist/src/service/definition-store.js",
  "dist/src/service/definition.d.ts",
  "dist/src/service/definition.js",
  "dist/src/service/errors.d.ts",
  "dist/src/service/errors.js",
  "dist/src/service/instance-lock.d.ts",
  "dist/src/service/instance-lock.js",
  "dist/src/service/lifecycle.d.ts",
  "dist/src/service/lifecycle.js",
  "dist/src/service/manager.d.ts",
  "dist/src/service/manager.js",
  "dist/src/service/paths.d.ts",
  "dist/src/service/paths.js",
  "dist/src/service/supervisor.d.ts",
  "dist/src/service/supervisor.js",
  "docs/contracts/local-service-control-v1.md",
  "docs/contracts/runtime-contract-protocol-v1.md",
  "docs/contracts/runtime-contract-v1.manifest.json",
  "docs/contracts/toss-cli-v2.2-compatibility.md",
  "examples/config/runtime.development.yaml",
  "examples/runtime-contract-v1/agent-context-execution-request.json",
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

const SAFE_SECRET_SHAPED_CODE_PATHS = new Set([
  "dist/src/gateway/credentials.d.ts",
  "dist/src/gateway/credentials.d.ts.map",
  "dist/src/gateway/credentials.js",
  "dist/src/gateway/credentials.js.map",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertArguments() {
  const argumentsAfterScript = process.argv.slice(2);
  const expected = contentsOnly ? [CONTENTS_ONLY_ARGUMENT] : [];
  assert(
    JSON.stringify(argumentsAfterScript) === JSON.stringify(expected),
    "Package acceptance received an unsupported mode",
  );
}

function assertServiceSmokeAllowed(label) {
  assert(!contentsOnly, `Contents-only package acceptance reached service smoke: ${label}`);
}

function normalizedNpmEnvironmentKey(key) {
  return key.toLowerCase().replaceAll("-", "_");
}

function isolatedPackEnvironment(inheritedPackDestination, prepackProbe) {
  const candidate = {
    ...process.env,
    npm_config_pack_destination: inheritedPackDestination,
    NPM_CONFIG_PACK_DESTINATION: inheritedPackDestination,
    "npm_config_pack-destination": inheritedPackDestination,
  };
  const environment = Object.fromEntries(
    Object.entries(candidate).filter(
      ([key]) => normalizedNpmEnvironmentKey(key) !== PACK_DESTINATION_ENV,
    ),
  );
  if (prepackProbe !== undefined) environment[PREPACK_PROBE_ENV] = prepackProbe;
  assert(
    Object.keys(environment).every(
      (key) => normalizedNpmEnvironmentKey(key) !== PACK_DESTINATION_ENV,
    ),
    "Pack environment retained an inherited pack destination",
  );
  return environment;
}

function parsePackReport(output) {
  const lines = output.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== "[") continue;
    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch {
      // Lifecycle output can precede npm's final JSON report; keep looking.
    }
  }
  throw new Error("npm pack did not emit a trailing JSON report");
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
      SAFE_SECRET_SHAPED_CODE_PATHS.has(publishedPath) ||
        !/(?:^|\/)[^/]*(?:credential|password|private[-_.]?key|token)[^/]*(?:\/|$)/i.test(
          publishedPath,
        ),
      `Secret-shaped file name leaked: ${publishedPath}`,
    );
    assert(
      !/^dist\/src\/service\/project\/.*\.(?:js|d\.ts)\.map$/u.test(publishedPath),
      `Project source map leaked: ${publishedPath}`,
    );
    assert(
      !/^dist\/src\/service\/project\/(?:index|intake|paths|private-files|registry|watcher)\.d\.ts$/u.test(
        publishedPath,
      ),
      `Private project declaration leaked: ${publishedPath}`,
    );
  }
}

const PROCESS_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 5_000;
const PUBLICATION_GUARD_PATTERN = /^\.c[0-9a-f]{64}$/u;
const activeServes = new Set();

function execInstalledLauncher(executable, args, options) {
  return execFile(executable, args, {
    ...options,
    env: installedLauncherEnvironment,
    shell: false,
  });
}

function spawnInstalledLauncher(executable, args, options) {
  assertServiceSmokeAllowed("spawnInstalledLauncher");
  return spawn(executable, args, {
    ...options,
    env: installedLauncherEnvironment,
    shell: false,
  });
}

function parseCanonicalDocument(output, canonicalJson, label) {
  assert(output.endsWith("\n"), `${label} did not end with one newline`);
  const lines = output.split("\n");
  assert(
    lines.length === 2 && lines[0].length > 0 && lines[1] === "",
    `${label} was not one JSON document`,
  );
  const document = JSON.parse(lines[0]);
  assert(output === `${canonicalJson(document)}\n`, `${label} was not canonical JSON`);
  return document;
}

async function assertInstalledAgentContextExample(temporaryDirectory) {
  await execFile(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import assert from "node:assert/strict";
        import { readFile } from "node:fs/promises";
        import path from "node:path";
        import {
          hashAgentDefinition,
          hashCompiledContext,
          hashExecutionRequest,
          parseAgentDefinition,
          parseCompiledContext,
          parseExecutionRequest,
        } from "@toss-software/agent-runtime";

        const exampleDirectory = path.join(
          process.cwd(),
          "node_modules",
          "@toss-software",
          "agent-runtime",
          "examples",
          "runtime-contract-v1",
        );
        const readExample = (name) => readFile(path.join(exampleDirectory, name));
        const requireParsed = (result, label) => {
          assert.equal(result.ok, true, label + " did not parse through the package root");
          return result.value;
        };

        const request = requireParsed(
          parseExecutionRequest(await readExample("agent-context-execution-request.json")),
          "Agent-context execution request",
        );
        const definition = requireParsed(
          parseAgentDefinition(await readExample("agent-definition.json")),
          "Agent definition",
        );
        const context = requireParsed(
          parseCompiledContext(await readExample("compiled-context.json")),
          "Compiled context",
        );

        assert.equal(
          hashExecutionRequest(request),
          "sha256:1b36f5f38a4f2ac2b89381a1847ded1e3ebc5d9539e6f11d190bfe0568f5de30",
        );
        assert.equal(hashExecutionRequest(request), context.request_hash);
        assert.equal(hashAgentDefinition(definition), definition.document_hash);
        assert.equal(hashCompiledContext(context), context.document_hash);
        assert.deepEqual(request.agent.definition, context.definition);
        assert.deepEqual(request.agent.definition, {
          document_type: "agent-definition",
          artifact_id: definition.agent_id,
          revision: definition.revision,
          hash: definition.document_hash,
        });
        assert.equal(request.agent.role, definition.role);
        assert.deepEqual(request.task_contract, definition.task_contracts[0]);
        assert.deepEqual(request.task_contract, context.task_contract);
        assert.deepEqual(request.output.schema, definition.output_schemas[0]);
        assert.deepEqual(request.output.schema, context.output_schema);
        assert.equal(request.model.logical_class, definition.model.logical_class);
        assert.equal(request.model.logical_class, context.authority.logical_class);
        assert.deepEqual(request.model.required_capabilities, ["text", "tools"]);
        assert.deepEqual(
          request.model.required_capabilities,
          context.authority.model_capabilities,
        );
        assert.ok(
          definition.model.required_capabilities.every((capability) =>
            request.model.required_capabilities.includes(capability),
          ),
        );
        assert.ok(
          request.model.required_capabilities.every((capability) =>
            definition.model.allowed_capabilities.includes(capability),
          ),
        );
        assert.deepEqual(request.superpowers.required, definition.superpowers.required);
        assert.deepEqual(request.superpowers.required, context.authority.superpowers);
        assert.deepEqual(request.mcp.profile, definition.mcp_profiles[0]);
        assert.deepEqual(request.mcp.profile, context.authority.mcp_profile);
        assert.deepEqual(request.budget, {
          max_input_tokens: 24000,
          max_output_tokens: 3000,
          max_cost_microusd: 400000,
          max_duration_ms: 500000,
          max_turns: 7,
        });
        assert.deepEqual(definition.budget_ceiling, {
          max_input_tokens: 32000,
          max_output_tokens: 4000,
          max_cost_microusd: 500000,
          max_duration_ms: 600000,
          max_turns: 8,
        });
        assert.deepEqual(request.budget, context.authority.budget);
        for (const budgetKey of Object.keys(request.budget)) {
          assert.ok(request.budget[budgetKey] <= definition.budget_ceiling[budgetKey]);
        }
        assert.deepEqual(request.input_artifacts, [
          {
            document_type: "source-artifact",
            artifact_id: "SOURCE-ONE",
            revision: 1,
            hash: "sha256:b73e73471433d1c2262f913cbc7eef547cfe3bd191fbb5f1a90382bd2f611863",
          },
          {
            document_type: "source-artifact",
            artifact_id: "SOURCE-TWO",
            revision: 2,
            hash: "sha256:d1051d2b34615a0756d304a9e0744f9021c59196c446795503210321d172bd3c",
          },
        ]);
        assert.deepEqual(
          context.segments
            .filter((segment) => segment.kind === "input-artifact")
            .map((segment) => segment.source),
          request.input_artifacts,
        );
      `,
    ],
    { cwd: temporaryDirectory, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
}

function startInstalledServe(executable, configPath) {
  assertServiceSmokeAllowed("startInstalledServe");
  const child = spawnInstalledLauncher(executable, ["serve", "--json", "--config", configPath], {
    cwd: path.dirname(configPath),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const run = {
    child,
    stdout: "",
    stderr: "",
    closed: false,
    spawnError: undefined,
    exit: undefined,
  };
  activeServes.add(run);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    run.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    run.stderr += chunk;
  });
  child.once("error", (error) => {
    run.spawnError = error;
  });
  run.exit = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      run.closed = true;
      activeServes.delete(run);
      resolve({ code, signal });
    });
  });
  return run;
}

function waitForReadiness(run) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Installed serve did not announce readiness before the timeout"));
    }, PROCESS_TIMEOUT_MS);
    const onMessage = (message) => {
      if (message?.type !== "toss-runtime-ready") return;
      cleanup();
      resolve();
    };
    const onClose = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `Installed serve exited before readiness: ${JSON.stringify({ code, signal })}; stdout=${JSON.stringify(run.stdout)}; stderr=${JSON.stringify(run.stderr)}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      run.child.off("message", onMessage);
      run.child.off("close", onClose);
    };
    run.child.on("message", onMessage);
    run.child.once("close", onClose);
  });
}

async function waitForExit(run, label) {
  let timer;
  try {
    return await Promise.race([
      run.exit,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not exit before the timeout`)),
          PROCESS_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function forceReap(run) {
  if (run.closed) return;
  run.child.kill("SIGKILL");
  await waitForExit(run, "Forced installed serve cleanup");
}

async function runCleanupSteps(steps) {
  let firstFailure;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}

async function reapActiveServes() {
  const outcomes = await Promise.allSettled([...activeServes].map((run) => forceReap(run)));
  const firstFailure = outcomes.find((outcome) => outcome.status === "rejected");
  if (firstFailure !== undefined) throw firstFailure.reason;
}

async function assertCleanupContinuesAfterFailure() {
  const attempts = [];
  const firstFailure = new Error("injected reap failure");
  const observed = await runCleanupSteps([
    () => {
      attempts.push("reap");
      return Promise.reject(firstFailure);
    },
    () => {
      attempts.push("temporary-root");
      return Promise.resolve();
    },
    () => {
      attempts.push("tarball");
      return Promise.resolve();
    },
  ]).catch((error) => error);
  assert(observed === firstFailure, "Cleanup did not preserve its first failure");
  assert(
    JSON.stringify(attempts) === JSON.stringify(["reap", "temporary-root", "tarball"]),
    "Cleanup stopped before attempting every independent resource",
  );
}

function assertReaped(pid, label) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
  throw new Error(`${label} process remained alive after it was reaped`);
}

async function assertPrivateRuntime(paths, run, canonicalJson) {
  assertServiceSmokeAllowed("assertPrivateRuntime");
  const stateMetadata = await lstat(paths.state);
  const logsMetadata = await lstat(paths.logs);
  const runtimeMetadata = await lstat(paths.runtime);
  const socketMetadata = await lstat(paths.socket);
  const lockMetadata = await lstat(paths.lock);
  const ownerMetadata = await lstat(paths.owner);
  assert(
    stateMetadata.isDirectory() && (stateMetadata.mode & 0o777) === 0o700,
    "Installed serve state directory was not private",
  );
  assert(
    logsMetadata.isDirectory() && (logsMetadata.mode & 0o777) === 0o700,
    "Installed serve log directory was not private",
  );
  assert(runtimeMetadata.isDirectory(), "Installed serve runtime path was not a directory");
  assert(
    (runtimeMetadata.mode & 0o777) === 0o700,
    "Installed serve runtime directory was not mode 0700",
  );
  assert(socketMetadata.isSocket(), "Installed serve control path was not a Unix socket");
  assert(
    (socketMetadata.mode & 0o777) === 0o600,
    "Installed serve control socket was not mode 0600",
  );
  assert(lockMetadata.isDirectory(), "Installed serve lock path was not a directory");
  assert((lockMetadata.mode & 0o777) === 0o700, "Installed serve lock directory was not mode 0700");
  assert(ownerMetadata.isFile(), "Installed serve lock owner was not a regular file");
  assert((ownerMetadata.mode & 0o777) === 0o600, "Installed serve lock owner was not mode 0600");
  if (typeof process.getuid === "function") {
    const expectedUid = process.getuid();
    for (const metadata of [
      stateMetadata,
      logsMetadata,
      runtimeMetadata,
      socketMetadata,
      lockMetadata,
      ownerMetadata,
    ]) {
      assert(metadata.uid === expectedUid, "Installed serve created a cross-owner runtime path");
    }
  }
  const runtimeEntries = (await readdir(paths.runtime)).sort();
  const stagingGuards = runtimeEntries.filter((entry) => PUBLICATION_GUARD_PATTERN.test(entry));
  assert(
    runtimeEntries.includes("instance.lock") &&
      runtimeEntries.includes("runtime.sock") &&
      stagingGuards.length === 1 &&
      runtimeEntries.length === 3,
    `Installed serve runtime directory contained unexpected entries: ${JSON.stringify(runtimeEntries)}`,
  );
  const stagingGuard = await lstat(path.join(paths.runtime, stagingGuards[0]));
  assert(
    stagingGuard.isDirectory() && (stagingGuard.mode & 0o777) === 0o700,
    "Installed serve socket publication guard was not a private directory",
  );
  assert(
    JSON.stringify(await readdir(paths.lock)) === JSON.stringify(["owner.json"]),
    "Installed serve lock contained unexpected entries",
  );
  const ownerText = await readFile(paths.owner, "utf8");
  const owner = JSON.parse(ownerText);
  assert(ownerText === canonicalJson(owner), "Installed serve lock owner was not canonical JSON");
  assert(owner.pid === run.child.pid, "Installed serve lock owner recorded the wrong pid");
  assert(
    typeof owner.service_instance_id === "string",
    "Installed serve lock owner lacked a service identity",
  );
  const operationalEvents = await readInstalledOperationalEvents(paths.logs, canonicalJson);
  const serviceEvents = operationalEvents.filter(
    (event) => event.service_instance_id === owner.service_instance_id,
  );
  assert(
    serviceEvents.some((event) => event.event === "service.recovery-complete") &&
      serviceEvents.some((event) => event.event === "service.ready"),
    "Installed serve did not durably log recovery and readiness",
  );
  return { owner, publicationGuardName: stagingGuards[0] };
}

async function readInstalledOperationalEvents(logsPath, canonicalJson) {
  const names = (await readdir(logsPath))
    .filter((name) => /^operational-(?:current|\d{4}-\d{2}-\d{2}-\d{6})\.jsonl$/u.test(name))
    .sort((left, right) => {
      if (left === "operational-current.jsonl") return 1;
      if (right === "operational-current.jsonl") return -1;
      return left.localeCompare(right);
    });
  const events = [];
  for (const name of names) {
    const filePath = path.join(logsPath, name);
    const metadata = await lstat(filePath);
    assert(
      metadata.isFile() && (metadata.mode & 0o777) === 0o600,
      "Installed operational log file was not private",
    );
    const text = await readFile(filePath, "utf8");
    for (const line of text.trimEnd().split("\n")) {
      if (line.length === 0) continue;
      const event = JSON.parse(line);
      assert(line === canonicalJson(event), "Installed operational event was not canonical JSON");
      assert(
        event.schema_version === "operational-event.v1" &&
          event.document_type === "operational-event",
        "Installed operational event used the wrong closed envelope",
      );
      events.push(event);
    }
  }
  return events;
}

async function assertMissing(candidate, label) {
  try {
    await lstat(candidate);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} remained after installed serve shutdown`);
}

async function requestInstalledStatus(socketPath, canonicalJson) {
  assertServiceSmokeAllowed("requestInstalledStatus");
  const requestId = randomUUID();
  const request = {
    schema_version: "service-control-request.v1",
    document_type: "service-control-request",
    request_id: requestId,
    command: "status",
  };
  const response = await new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    let output = "";
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      operation(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error("Installed control query timed out")),
      CONTROL_TIMEOUT_MS,
    );
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > 65_537) {
        finish(reject, new Error("Installed control response exceeded its bound"));
      }
    });
    client.once("connect", () => client.end(`${canonicalJson(request)}\n`));
    client.once("end", () => finish(resolve, output));
    client.once("error", (error) => finish(reject, error));
  });
  return { requestId, response };
}

async function assertDuplicateServeFails(executable, configPath, canonicalJson) {
  assertServiceSmokeAllowed("assertDuplicateServeFails");
  let failure;
  try {
    await execInstalledLauncher(executable, ["serve", "--json", "--config", configPath], {
      cwd: path.dirname(configPath),
      encoding: "utf8",
      timeout: PROCESS_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    throw new Error("Second installed serve unexpectedly started");
  } catch (error) {
    failure = error;
  }
  assert(failure.code === 6, "Second installed serve returned an unstable conflict exit code");
  assert(failure.killed !== true, "Second installed serve reached the hard timeout");
  assert(failure.signal == null, "Second installed serve exited from a signal");
  assert(failure.stderr === "", "Second installed serve wrote to stderr");
  const result = parseCanonicalDocument(
    failure.stdout,
    canonicalJson,
    "Second installed serve result",
  );
  assert(result.command === "serve", "Second installed serve returned the wrong command result");
  assert(
    result.ok === false && result.exit_code === 6,
    "Second installed serve did not report a conflict",
  );
  assert(
    result.error?.code === "RUNTIME_SERVICE_ALREADY_RUNNING",
    "Second installed serve returned the wrong stable error code",
  );
}

async function assertInstalledLauncherEnforcesExecuteMode(executable, cwd) {
  const originalMode = (await stat(executable)).mode & 0o777;
  let failure;
  await chmod(executable, originalMode & ~0o111);
  try {
    await execInstalledLauncher(executable, ["--version"], {
      cwd,
      encoding: "utf8",
    });
  } catch (error) {
    failure = error;
  } finally {
    await chmod(executable, originalMode);
  }
  assert(failure?.code === "EACCES", "Installed launcher invocation bypassed its executable mode");
}

async function assertInstalledControl(paths, run, owner, api) {
  const control = await requestInstalledStatus(paths.socket, api.canonicalJson);
  const responseDocument = parseCanonicalDocument(
    control.response,
    api.canonicalJson,
    "Installed control response",
  );
  const parsedResponse = api.parseServiceControlResponse(control.response);
  assert(parsedResponse.ok, "Installed control response failed its packaged schema parser");
  const response = parsedResponse.value;
  assert(
    response.request_id === control.requestId,
    "Installed control response changed the request id",
  );
  assert(
    response.ok === true && response.error === null,
    "Installed control response was not successful",
  );
  assert(
    response.status?.pid === run.child.pid,
    "Installed control response returned the wrong pid",
  );
  assert(
    response.status?.service_instance_id === owner.service_instance_id,
    "Installed control and lock identities differed",
  );
  assert(
    response.status?.package_version === "0.0.0-development",
    "Installed control response returned the wrong package version",
  );
  assert(
    response.status?.health === "healthy" && response.status.accepting === true,
    "Installed control response was not healthy and accepting",
  );
  assert(
    responseDocument.status?.service_instance_id === owner.service_instance_id,
    "Installed control wire response returned the wrong identity",
  );
}

async function stopInstalledServeGracefully(paths, run, signal, canonicalJson) {
  assert(run.child.kill(signal), `${signal} could not be delivered to installed serve`);
  const outcome = await waitForExit(run, `${signal} installed serve shutdown`);
  assert(
    outcome.code === 0 && outcome.signal === null,
    `${signal} shutdown was not graceful: ${JSON.stringify(outcome)}; stderr=${JSON.stringify(run.stderr)}`,
  );
  assert(run.stderr === "", `${signal} shutdown wrote to stderr`);
  const result = parseCanonicalDocument(run.stdout, canonicalJson, `${signal} serve result`);
  assert(
    result.command === "serve" && result.ok === true && result.exit_code === 0,
    `${signal} result was not successful`,
  );
  await assertMissing(paths.socket, `${signal} socket`);
  await assertMissing(paths.lock, `${signal} lock`);
  assert(
    (await readdir(paths.runtime)).length === 0,
    `${signal} left unexpected runtime entries behind`,
  );
  const operationalEvents = await readInstalledOperationalEvents(paths.logs, canonicalJson);
  assert(
    operationalEvents.at(-1)?.event === "service.stopping",
    `${signal} shutdown did not durably flush its stopping event`,
  );
  assertReaped(run.child.pid, signal);
}

async function assertInstalledSupervisionCycle(options) {
  assertServiceSmokeAllowed("assertInstalledSupervisionCycle");
  const { executable, configPath, paths, signal, checkConflict, api } = options;
  const run = startInstalledServe(executable, configPath);
  try {
    await waitForReadiness(run);
    assert(run.spawnError === undefined, "Installed serve emitted a spawn error");
    assert(run.child.pid !== undefined, "Installed serve did not expose a pid");
    const { owner } = await assertPrivateRuntime(paths, run, api.canonicalJson);

    if (checkConflict) {
      await assertDuplicateServeFails(executable, configPath, api.canonicalJson);
      assert(
        run.child.exitCode === null && run.child.signalCode === null,
        "Second installed serve harmed the first instance",
      );
    }

    await assertInstalledControl(paths, run, owner, api);
    await stopInstalledServeGracefully(paths, run, signal, api.canonicalJson);
  } finally {
    await forceReap(run);
  }
}

async function assertInstalledCrashRestartCycle(options) {
  assertServiceSmokeAllowed("assertInstalledCrashRestartCycle");
  const { executable, configPath, paths, api } = options;
  const crashed = startInstalledServe(executable, configPath);
  let restarted;
  try {
    await waitForReadiness(crashed);
    assert(crashed.spawnError === undefined, "Crash-cycle serve emitted a spawn error");
    assert(crashed.child.pid !== undefined, "Crash-cycle serve did not expose a pid");
    const first = await assertPrivateRuntime(paths, crashed, api.canonicalJson);

    assert(crashed.child.kill("SIGKILL"), "SIGKILL could not be delivered to installed serve");
    const crashOutcome = await waitForExit(crashed, "SIGKILL installed serve crash");
    assert(
      crashOutcome.code === null && crashOutcome.signal === "SIGKILL",
      `SIGKILL did not terminate installed serve: ${JSON.stringify(crashOutcome)}`,
    );
    assertReaped(crashed.child.pid, "SIGKILL");
    const crashedEntries = (await readdir(paths.runtime)).sort();
    assert(
      crashedEntries.includes(first.publicationGuardName) &&
        crashedEntries.includes("instance.lock") &&
        crashedEntries.includes("runtime.sock"),
      `SIGKILL did not leave the expected recoverable runtime state: ${JSON.stringify(crashedEntries)}`,
    );

    restarted = startInstalledServe(executable, configPath);
    await waitForReadiness(restarted);
    assert(restarted.spawnError === undefined, "Restarted serve emitted a spawn error");
    assert(restarted.child.pid !== undefined, "Restarted serve did not expose a pid");
    const second = await assertPrivateRuntime(paths, restarted, api.canonicalJson);
    assert(
      second.publicationGuardName !== first.publicationGuardName,
      "Restart reused the crashed service publication guard",
    );
    assert(
      !(await readdir(paths.runtime)).includes(first.publicationGuardName),
      "Restart left the crashed publication guard behind",
    );
    await assertInstalledControl(paths, restarted, second.owner, api);
    await stopInstalledServeGracefully(paths, restarted, "SIGTERM", api.canonicalJson);
  } finally {
    if (restarted !== undefined) await forceReap(restarted);
    await forceReap(crashed);
  }
}

let temporaryDirectory;
let packDirectory;
let inheritedPackDestination;
let tarballPath;
let primaryFailure;
await assertCleanupContinuesAfterFailure();
try {
  const temporaryRoot = await realpath("/tmp");
  packDirectory = await mkdtemp(path.join(temporaryRoot, "toss-runtime-pack-output-"));
  inheritedPackDestination = await mkdtemp(
    path.join(temporaryRoot, "toss-runtime-inherited-pack-output-"),
  );
  const prepackProbe = contentsOnly ? undefined : randomUUID();
  const packArguments = [
    "pack",
    "--json",
    ...(contentsOnly ? ["--ignore-scripts"] : []),
    "--pack-destination",
    packDirectory,
  ];
  const packed = await execFile(npmCommand, packArguments, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: isolatedPackEnvironment(inheritedPackDestination, prepackProbe),
  });
  if (prepackProbe !== undefined) {
    const prepackProbeLine = `Prepack contents-only probe ${prepackProbe}`;
    const prepackProbeOccurrences = `${packed.stdout}\n${packed.stderr}`
      .split("\n")
      .filter((line) => line.trim() === prepackProbeLine);
    assert(
      prepackProbeOccurrences.length === 1,
      "The real npm pack path did not complete exactly one contents-only prepack acceptance",
    );
  }
  const report = parsePackReport(packed.stdout);
  assert(Array.isArray(report) && report.length === 1, "npm pack returned an unexpected report");
  const packageReport = report[0];
  assert(typeof packageReport.filename === "string", "npm pack did not report a filename");
  assert(Array.isArray(packageReport.files), "npm pack did not report package files");
  assert(
    packageReport.filename === path.basename(packageReport.filename),
    "npm pack reported a non-local package filename",
  );
  tarballPath = path.join(packDirectory, packageReport.filename);
  const tarballMetadata = await lstat(tarballPath);
  assert(tarballMetadata.isFile(), "npm pack did not create its operation-owned tarball");
  await assertMissing(
    path.join(root, packageReport.filename),
    "Package tarball in repository root",
  );
  assert(
    (await readdir(inheritedPackDestination)).length === 0,
    "npm pack wrote to the inherited pack destination",
  );
  assertPackageFiles(packageReport.files);

  temporaryDirectory = await mkdtemp(path.join(temporaryRoot, "toss-runtime-package-"));
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
      'import * as api from "@toss-software/agent-runtime"; const required = ["parseExecutionRequest", "validateExecutionChain", "parseCandidateJobIntent", "parseProjectRegistryEntry", "parseProjectWatchManifest", "RuntimeProjectError", "createAgentgatewayTransport", "parseAgentgatewayCapabilities", "hashAgentgatewayCapabilities"]; const forbidden = ["createProjectRegistry", "createProjectIntake", "createProjectWatcher", "createAgentgatewayClient", "createGatewayCredentialCoordinator", "parseAgentgatewayAttestation", "parseBoundedSse", "readBoundedAgentgatewayResponse", "startFakeAgentgateway"]; if (required.some((name) => typeof api[name] !== "function") || forbidden.some((name) => name in api)) process.exit(1);',
    ],
    { cwd: temporaryDirectory, encoding: "utf8" },
  );
  await assertInstalledAgentContextExample(temporaryDirectory);

  const executable = path.join(
    temporaryDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "toss-runtime.cmd" : "toss-runtime",
  );
  const installedRoot = path.join(
    temporaryDirectory,
    "node_modules",
    "@toss-software",
    "agent-runtime",
  );
  const api = await import(pathToFileURL(path.join(installedRoot, "dist", "src", "index.js")).href);
  assert(
    typeof api.createOperationalLogReader === "function" &&
      api.createOperationalLogStore === undefined,
    "Installed public API exposed the wrong operational logging boundary",
  );
  await assertMissing(
    path.join(installedRoot, "dist", "src", "logging", "store.d.ts"),
    "Private operational store declaration",
  );
  const projectInterfaces = await readFile(
    path.join(installedRoot, "dist", "src", "service", "project", "interfaces.d.ts"),
    "utf8",
  );
  assert(
    projectInterfaces.includes("interface ProjectRegistry"),
    "ProjectRegistry declaration missing",
  );
  assert(
    projectInterfaces.includes("interface ProjectIntake"),
    "ProjectIntake declaration missing",
  );
  assert(
    !/operationHooks|statePath|CreateProject/u.test(projectInterfaces),
    "Public project declarations exposed filesystem construction hooks",
  );
  await assertInstalledLauncherEnforcesExecuteMode(executable, temporaryDirectory);
  const help = await execInstalledLauncher(executable, ["--help"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  assert(help.stdout.includes("toss-runtime capabilities"), "Installed executable help failed");
  const version = await execInstalledLauncher(executable, ["--version"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  assert(version.stdout.trim() === "0.0.0-development", "Installed executable version failed");
  const capabilities = await execInstalledLauncher(executable, ["capabilities", "--json"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
  });
  const capabilityResult = JSON.parse(capabilities.stdout);
  assert(capabilityResult.ok === true, "Installed executable capability command failed");
  assert(
    capabilityResult.data?.schema_version === "runtime-capabilities.v1",
    "Installed executable returned an unexpected capability document",
  );

  const installedManifest = JSON.parse(
    await readFile(
      path.join(installedRoot, "docs", "contracts", "runtime-contract-v1.manifest.json"),
      "utf8",
    ),
  );
  assert(installedManifest.protocol_version === "runtime-contract.v1", "Installed manifest failed");

  if (contentsOnly) {
    const prepackProbe = process.env[PREPACK_PROBE_ENV];
    if (prepackProbe !== undefined) {
      assert(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(prepackProbe),
        "Prepack probe was not a UUID",
      );
      process.stdout.write(`Prepack contents-only probe ${prepackProbe}\n`);
    }
    process.stdout.write(
      `Verified ${packageReport.filename} (${packageReport.files.length} files, contents only)\n`,
    );
  } else {
    assertServiceSmokeAllowed("installed supervision block");

    const supervisionPaths = {
      state: path.join(temporaryDirectory, "service-state"),
      logs: path.join(temporaryDirectory, "service-logs"),
      runtime: path.join(temporaryDirectory, "service-runtime"),
    };
    supervisionPaths.socket = path.join(supervisionPaths.runtime, "runtime.sock");
    supervisionPaths.lock = path.join(supervisionPaths.runtime, "instance.lock");
    supervisionPaths.owner = path.join(supervisionPaths.lock, "owner.json");
    const installedConfig = path.join(temporaryDirectory, "runtime.development.json");
    await writeFile(
      installedConfig,
      api.canonicalJson({
        schema_version: "runtime-config.v1",
        document_type: "runtime-config",
        mode: "development",
        paths: {
          state: supervisionPaths.state,
          logs: supervisionPaths.logs,
          socket: supervisionPaths.socket,
        },
        shutdown_timeout_ms: 5_000,
        logs: { level: "info", retention_days: 7, max_bytes: 104_857_600 },
        gateway_profile: null,
        gateway_profiles: {},
        provider_profiles: [],
        mcp_profiles: [],
        secret_references: {},
      }),
      { mode: 0o600 },
    );
    await assertInstalledCrashRestartCycle({
      executable,
      configPath: installedConfig,
      paths: supervisionPaths,
      api,
    });
    await assertInstalledSupervisionCycle({
      executable,
      configPath: installedConfig,
      paths: supervisionPaths,
      signal: "SIGTERM",
      checkConflict: true,
      api,
    });
    await assertInstalledSupervisionCycle({
      executable,
      configPath: installedConfig,
      paths: supervisionPaths,
      signal: "SIGINT",
      checkConflict: false,
      api,
    });

    const missingConfigPath = path.join(temporaryDirectory, "missing-runtime.yaml");
    let missingConfigFailure;
    try {
      await execInstalledLauncher(executable, ["serve", "--json", "--config", missingConfigPath], {
        cwd: temporaryDirectory,
        encoding: "utf8",
        timeout: PROCESS_TIMEOUT_MS,
        killSignal: "SIGKILL",
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

    process.stdout.write(
      `Verified ${packageReport.filename} (${packageReport.files.length} files)\n`,
    );
  }
} catch (error) {
  primaryFailure = error;
}

let cleanupFailure;
try {
  await runCleanupSteps([
    () => reapActiveServes(),
    () =>
      temporaryDirectory === undefined
        ? Promise.resolve()
        : rm(temporaryDirectory, { recursive: true, force: true }),
    () => (tarballPath === undefined ? Promise.resolve() : rm(tarballPath, { force: true })),
    () =>
      packDirectory === undefined
        ? Promise.resolve()
        : rm(packDirectory, { recursive: true, force: true }),
    () =>
      inheritedPackDestination === undefined
        ? Promise.resolve()
        : rm(inheritedPackDestination, { recursive: true, force: true }),
  ]);
} catch (error) {
  cleanupFailure = error;
}

if (primaryFailure !== undefined) {
  if (
    cleanupFailure !== undefined &&
    primaryFailure instanceof Error &&
    primaryFailure.cause === undefined
  ) {
    primaryFailure.cause = cleanupFailure;
  }
  throw primaryFailure;
}
if (cleanupFailure !== undefined) throw cleanupFailure;
