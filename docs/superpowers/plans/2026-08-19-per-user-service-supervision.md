# Per-User Service Supervision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the service-manager, single-instance, private socket, and
bounded shutdown foundation of issue #28; keep #28 open until issue #1 supplies
and passes the production `INTERRUPTED` journal integration.

**Architecture:** Keep native service definition/manager operations, instance locking, local control transport, and supervisor orchestration behind typed injected interfaces. The CLI remains the only operator entry point; `serve` becomes the supervised process, while package installation remains side-effect free. All files and messages are bounded, secret-free, current-user-owned, and fail closed.

**Tech Stack:** TypeScript 6, Node.js 22.23.1/24 ESM, Node `fs`/`net`/`child_process`, Ajv 2020, Vitest, launchd, systemd user units.

**Spec:** `docs/superpowers/specs/2026-08-19-durable-local-service-design.md`

## Global Constraints

- Supported runtime platforms are exactly macOS and Linux; Windows remains out of scope.
- Supported Node versions remain `>=22.23.0 <25`; acceptance runs with Node `22.23.1` and `24`.
- Package installation and `prepack` MUST NOT install, enable, or start a service.
- `service install` writes and enables a definition but MUST NOT start it in the current session.
- The service runtime directory is `0700`; lock owner and definition files are `0600`; the Unix socket is `0600`.
- Native commands use `execFile`-style argument arrays only; never invoke a shell or construct a command string.
- Definitions may contain only absolute Node/CLI/config paths and allowlisted `LANG`, `LC_ALL`, and `TZ`; they never contain secrets or arbitrary environment.
- The socket accepts at most 64 KiB of newline-delimited canonical JSON and never echoes rejected content.
- Stale resources are reclaimed only after ownership, permissions, liveness, and listener checks; ambiguous live PIDs fail closed.
- Uninstall preserves configuration, journals, project registry, pending intake, operational logs, and canonical artifacts.
- Normal CI remains credential-free and read-only outside temporary test roots.
- Every implementation task follows red-green-refactor TDD and ends in a focused commit.
- Issue #28 MUST remain open after this plan because its durable interruption criterion is completed by the immediately following issue #1 journal plan; this plan proves the ordered `InterruptionRecorder` boundary with a durable test double.
- Run project checks through Node 22.23.1 with `npx --yes --package=node@22.23.1 --call '<command>'` because the host Node line is intentionally unsupported.

---

## File and responsibility map

- `contracts/runtime/service-lock.v1.schema.json`: closed persisted instance-lock owner document.
- `contracts/runtime/service-control-request.v1.schema.json`: closed local status request envelope.
- `contracts/runtime/service-control-response.v1.schema.json`: closed local status/error response envelope.
- `src/service/errors.ts`: stable service error codes and safe messages.
- `src/service/contracts.ts`: typed lock/control values and bounded schema parsers.
- `src/service/paths.ts`: deterministic definition, config, state, runtime, lock, and socket paths.
- `src/service/definition.ts`: deterministic launchd plist and systemd user-unit rendering.
- `src/platform/commands.ts`: injected shell-free command runner.
- `src/service/definition-store.ts`: no-follow atomic definition/config writes and safe removal.
- `src/service/manager.ts`: install/start/stop/restart/status/uninstall behavior.
- `src/service/instance-lock.ts`: exclusive lock acquisition, stale validation/recovery, and ownership-safe release.
- `src/service/control.ts`: private Unix socket server/client, request cache, status handshake, and bounds.
- `src/service/supervisor.ts`: startup/recovery/readiness and ordered bounded shutdown.
- `src/cli/grammar.ts`: `service` command grammar.
- `src/cli/main.ts`: command routing, safe result mapping, supervisor startup, and doctor integration.
- `src/index.ts`: intentional public service types/parsers only.
- `test/service-contracts.test.ts`: schemas, bounds, duplicate keys, and safe failures.
- `test/service-definition.test.ts`: deterministic and secret-free native definitions.
- `test/service-definition-store.test.ts`: atomic/no-follow/private writes and preservation.
- `test/service-manager.test.ts`: exact manager command arrays and idempotency.
- `test/service-instance-lock.test.ts`: duplicate/stale/ambiguous lock behavior.
- `test/service-control.test.ts`: real Unix socket permissions, framing, limits, and duplicate IDs.
- `test/service-supervisor.test.ts`: startup/shutdown order, cleanup, readiness, and timeouts.
- `test/service-definition-native.test.ts`: `plutil`/`systemd-analyze` syntax validation on matching CI platforms.
- `test/cli.test.ts`, `test/serve-smoke.test.ts`: operator grammar/result and lifecycle integration.
- `scripts/package-test.mjs`: installed-package single-instance/socket/signal smoke.
- `scripts/package-files.json`: exact new source build/schema package paths.
- `docs/contracts/local-service-control-v1.md`: public local-service contract and trust boundary.
- `docs/verification/v1-wave-2-service.md`: commit-bound #28 acceptance evidence.

### Task 1: Define the closed service contracts and stable errors

**Files:**

- Create: `contracts/runtime/service-lock.v1.schema.json`
- Create: `contracts/runtime/service-control-request.v1.schema.json`
- Create: `contracts/runtime/service-control-response.v1.schema.json`
- Create: `src/service/errors.ts`
- Create: `src/service/contracts.ts`
- Create: `test/service-contracts.test.ts`
- Modify: `docs/contracts/runtime-contract-v1.manifest.json`
- Modify: `src/protocol/capabilities.ts`
- Modify: `test/documentation-integrity.test.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Consumes: `canonicalJson`, `deepFreezeJson`, `parseJsonBytes`, `sensitiveMetadataIssues`, `ValidationResult`, `RuntimeError`, package/runtime identity.
- Produces: `ServiceLockV1`, `ServiceControlRequestV1`, `ServiceControlResponseV1`, `ServiceStatusV1`, `RuntimeServiceError`, `parseServiceLock`, `parseServiceControlRequest`, `parseServiceControlResponse`, and `MAX_CONTROL_MESSAGE_BYTES`.

- [ ] **Step 1: Write the failing schema/parser tests**

```ts
import { describe, expect, it } from "vitest";

import {
  MAX_CONTROL_MESSAGE_BYTES,
  parseServiceControlRequest,
  parseServiceControlResponse,
  parseServiceLock,
} from "../src/service/contracts.js";
import { canonicalJson } from "../src/protocol/json.js";

const lock = {
  schema_version: "service-lock.v1",
  document_type: "service-lock",
  service_instance_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f41",
  pid: 4217,
  executable_hash: "a".repeat(64),
  created_at: "2026-08-19T10:00:00.000Z",
};

describe("local service contracts", () => {
  it("accepts one closed lock document", () => {
    expect(parseServiceLock(canonicalJson(lock))).toMatchObject({ ok: true });
  });

  it("rejects unknown and sensitive request fields without reflecting values", () => {
    const result = parseServiceControlRequest(
      canonicalJson({
        schema_version: "service-control-request.v1",
        document_type: "service-control-request",
        request_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f42",
        command: "status",
        apiTokenValue: "must-not-persist",
      }),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("must-not-persist");
  });

  it("rejects input larger than the exact transport limit", () => {
    const bytes = new Uint8Array(MAX_CONTROL_MESSAGE_BYTES + 1);
    expect(parseServiceControlResponse(bytes)).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: Run the contract test and observe the missing module failure**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-contracts.test.ts'
```

Expected: FAIL because `src/service/contracts.ts` and the three schemas do not exist.

- [ ] **Step 3: Add the closed schemas and stable TypeScript types**

The schemas use `additionalProperties: false` at every object. Exact document fields are:

- `service-lock.v1`: constants for schema/document type; UUID instance ID; integer PID `>=1`; lowercase 64-hex executable hash; UTC date-time.
- `service-control-request.v1`: constants; UUID request ID; command constant `status`; no payload.
- `service-control-response.v1`: constants; validated request ID or `null` when parsing failed before ID validation; `ok`; optional `status`; optional runtime error; exactly one of success-with-status or failure-with-error. Success requires a nonnull ID.
- `ServiceStatusV1`: package version, instance ID, PID, UTC start time, `healthy|degraded|stopping`, and manager-independent accepting boolean. It never carries filesystem paths or environment.

```ts
export const MAX_CONTROL_MESSAGE_BYTES = 65_536;

export interface ServiceLockV1 {
  readonly schema_version: "service-lock.v1";
  readonly document_type: "service-lock";
  readonly service_instance_id: string;
  readonly pid: number;
  readonly executable_hash: string;
  readonly created_at: string;
}

export interface ServiceControlRequestV1 {
  readonly schema_version: "service-control-request.v1";
  readonly document_type: "service-control-request";
  readonly request_id: string;
  readonly command: "status";
}

export interface ServiceStatusV1 {
  readonly package_version: string;
  readonly service_instance_id: string;
  readonly pid: number;
  readonly started_at: string;
  readonly health: "healthy" | "degraded" | "stopping";
  readonly accepting: boolean;
}

export interface ServiceControlResponseV1 {
  readonly schema_version: "service-control-response.v1";
  readonly document_type: "service-control-response";
  readonly request_id: string | null;
  readonly ok: boolean;
  readonly status: ServiceStatusV1 | null;
  readonly error: RuntimeError | null;
}
```

`RuntimeServiceError` accepts exactly these codes in #28:
`RUNTIME_SERVICE_ALREADY_RUNNING`, `RUNTIME_SERVICE_LOCK_AMBIGUOUS`,
`RUNTIME_SERVICE_PATH_UNSAFE`, `RUNTIME_SERVICE_DEFINITION_UNSAFE`,
`RUNTIME_SERVICE_MANAGER_UNAVAILABLE`, `RUNTIME_SERVICE_MANAGER_FAILED`,
`RUNTIME_SERVICE_CONTROL_INVALID`, `RUNTIME_SERVICE_CONTROL_CONFLICT`, and
`RUNTIME_SERVICE_UNAVAILABLE`. Its constructor stores only a fixed safe
message; underlying path, command stderr, and document content are never placed
in the public error.

Implement a dedicated strict Ajv validator exactly like the existing protocol validator. Parse only byte-bounded JSON, run `sensitiveMetadataIssues` on request/response values, return sorted safe `ValidationIssue` values, and deep-freeze successful documents.

Add these exact manifest versions after `runtime-config.v1`, add them to `createBaselineCapabilities().supported_schemas`, and export the intentional parser/types from `src/index.ts`.

- [ ] **Step 4: Run focused contract and documentation tests**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-contracts.test.ts test/documentation-integrity.test.ts && node_modules/.bin/tsc -p tsconfig.json --noEmit'
```

Expected: PASS; invalid values contain no rejected secret content.

- [ ] **Step 5: Commit the contract boundary**

```bash
git add contracts/runtime/service-*.schema.json src/service/errors.ts src/service/contracts.ts test/service-contracts.test.ts docs/contracts/runtime-contract-v1.manifest.json src/protocol/capabilities.ts test/documentation-integrity.test.ts src/index.ts
git commit -m "feat: define local service control contracts"
```

### Task 2: Render deterministic launchd and systemd definitions

**Files:**

- Create: `src/service/paths.ts`
- Create: `src/service/definition.ts`
- Create: `test/service-definition.test.ts`

**Interfaces:**

- Consumes: supported platform, absolute home/config/Node/CLI paths, UID, optional allowlisted locale values.
- Produces: `ServicePaths`, `resolveServicePaths(options)`, `ServiceDefinitionInput`, `renderLaunchAgent(input)`, `renderSystemdUserUnit(input)`, and `renderServiceDefinition(input)`.

- [ ] **Step 1: Write failing path and definition tests**

```ts
import { describe, expect, it } from "vitest";

import { renderServiceDefinition } from "../src/service/definition.js";
import { resolveServicePaths } from "../src/service/paths.js";

const common = {
  nodePath: "/opt/node/bin/node",
  cliPath: "/opt/toss/bin/toss-runtime.js",
  configPath: "/home/test/.config/toss/runtime/config.yaml",
  environment: { LANG: "en_US.UTF-8" },
};

describe("native service definitions", () => {
  it("renders a login-enabled but not immediately started Linux unit", () => {
    const value = renderServiceDefinition({ ...common, platform: "linux", uid: 501 });
    expect(value).toContain("WantedBy=default.target");
    expect(value).toContain("Restart=on-failure");
    expect(value).toContain("RestartSec=5s");
    expect(value).toContain("StartLimitBurst=5");
    expect(value).toContain("UMask=0077");
    expect(value).not.toContain("must-not-persist");
  });

  it("places definitions under exact per-user manager paths", () => {
    expect(resolveServicePaths({ platform: "darwin", home: "/Users/test", env: {} })).toMatchObject(
      {
        definition: "/Users/test/Library/LaunchAgents/software.toss.agent-runtime.plist",
      },
    );
    expect(resolveServicePaths({ platform: "linux", home: "/home/test", env: {} })).toMatchObject({
      definition: "/home/test/.config/systemd/user/toss-agent-runtime.service",
    });
  });
});
```

Add cases for spaces, XML metacharacters, `%`, backslashes, NUL/control
characters, relative paths, non-allowlisted environment keys, invalid
locale/timezone syntax, duplicate environment keys, deterministic key order,
and no token/credential-looking keys.

- [ ] **Step 2: Run and observe missing renderer failures**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-definition.test.ts'
```

Expected: FAIL because definition/path modules do not exist.

- [ ] **Step 3: Implement exact paths and shell-free renderers**

```ts
export const SERVICE_LABEL = "software.toss.agent-runtime";
export const SYSTEMD_UNIT = "toss-agent-runtime.service";

export interface ServiceDefinitionInput {
  readonly platform: "darwin" | "linux";
  readonly uid: number;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly configPath: string;
  readonly environment: Readonly<Partial<Record<"LANG" | "LC_ALL" | "TZ", string>>>;
}

export interface ServicePaths {
  readonly definition: string;
  readonly managerIdentity: string;
}
```

The launchd output contains this semantic structure in stable order: label; `ProgramArguments` array of absolute Node, CLI, `serve`, `--config`, config path; `RunAtLoad=true`; `KeepAlive.SuccessfulExit=false`; `ThrottleInterval=5`; `ProcessType=Background`; sorted allowlisted environment entries. Escape XML text structurally.

The systemd output contains these exact sections and keys:

```ini
[Unit]
Description=TOSS Agent Runtime
StartLimitIntervalSec=60s
StartLimitBurst=5

[Service]
Type=simple
ExecStart="/absolute/node" "/absolute/cli" "serve" "--config" "/absolute/config"
Restart=on-failure
RestartSec=5s
UMask=0077

[Install]
WantedBy=default.target
```

Implement systemd argument escaping for backslash, double quote, newline
rejection, and `%` doubling. Reject nonabsolute executable/config paths.
`LANG` and `LC_ALL` accept only `C`, `POSIX`, or
`language[_REGION][.codeset][@modifier]` segments made from ASCII letters,
digits, `_`, `.`, `-`, and `@`, up to 128 bytes. `TZ` accepts only `UTC`,
`GMT`, or an ASCII IANA-style `Area/Location` path up to 128 bytes. Every
environment value rejects NUL/newlines.

- [ ] **Step 4: Verify renderer tests and type safety**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-definition.test.ts && node_modules/.bin/tsc -p tsconfig.json --noEmit'
```

Expected: PASS with byte-stable snapshots on repeat rendering.

- [ ] **Step 5: Commit deterministic definitions**

```bash
git add src/service/paths.ts src/service/definition.ts test/service-definition.test.ts
git commit -m "feat: render native user service definitions"
```

### Task 3: Materialize configuration and store definitions safely

**Files:**

- Create: `src/service/definition-store.ts`
- Create: `test/service-definition-store.test.ts`
- Modify: `src/config/load.ts`
- Modify: `src/config/types.ts`
- Modify: `test/config.test.ts`

**Interfaces:**

- Consumes: `defaultConfig`, YAML stringify, per-user config/definition paths, deterministic random suffix injection.
- Produces: `resolveDefaultConfigPath`, `ensureServiceConfig(options)`,
  `writePrivateAtomic(options)`, `readPrivateRegularFile(path)`, and
  `removeOwnedDefinition(path)`.

- [ ] **Step 1: Write failing secure-store tests**

```ts
import { lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { ensureServiceConfig, writePrivateAtomic } from "../src/service/definition-store.js";

it("materializes a private validated default config without replacing an existing file", async () => {
  const home = await temporaryDirectory();
  const path = await ensureServiceConfig({
    platform: "linux",
    home,
    env: {},
    randomSuffix: () => "fixed",
  });
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  const first = await readFile(path, "utf8");
  await ensureServiceConfig({ platform: "linux", home, env: {}, randomSuffix: () => "fixed-2" });
  expect(await readFile(path, "utf8")).toBe(first);
});

it("refuses to replace a symlinked definition", async () => {
  const root = await temporaryDirectory();
  const target = path.join(root, "target.service");
  const definition = path.join(root, "definition.service");
  await writeFile(target, "owned");
  await symlink(target, definition);
  await expect(
    writePrivateAtomic({
      target: definition,
      bytes: new TextEncoder().encode("unit"),
      randomSuffix: () => "fixed",
      parentPolicy: "owned-not-writable",
    }),
  ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
});
```

Add tests for parent modes, wrong owner through injected ownership checks, nonregular targets, private mode, same-directory temp file, file sync before rename, directory sync after rename, cleanup after failure, existing config validation, and no overwrite on incompatible explicit config.

The test file defines `temporaryDirectory()` with `mkdtemp`, registers every
returned root for `afterEach` cleanup, and constructs `home`, `target`, and
`definition` inside each test from that root. It imports all filesystem
functions used in the snippet; no test reads or writes the real home directory.

- [ ] **Step 2: Run and observe missing store/config APIs**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-definition-store.test.ts test/config.test.ts'
```

Expected: FAIL because secure definition/config materialization is not implemented.

- [ ] **Step 3: Implement no-follow atomic storage**

```ts
export async function writePrivateAtomic(options: {
  readonly target: string;
  readonly bytes: Uint8Array;
  readonly randomSuffix: () => string;
  readonly parentPolicy: "private" | "owned-not-writable";
}): Promise<void> {
  const { target, bytes, randomSuffix, parentPolicy } = options;
  const parent = path.dirname(target);
  await ensureOwnedDirectory(parent, parentPolicy);
  await assertReplaceableOwnedRegularFileOrMissing(target);
  const temporary = path.join(parent, `.${path.basename(target)}.${randomSuffix()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  const directory = await open(parent, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
```

Use explicit cleanup of the validated temporary file on error. Never
recursively delete a caller-provided path. `private` requires mode `0700` and
is used for the TOSS config directory. `owned-not-writable` requires
current-user ownership and rejects group/world write while allowing the
conventional readable/executable `~/Library/LaunchAgents` and
`~/.config/systemd/user` parents. Export `resolveDefaultConfigPath` from config
loading. `ensureServiceConfig` validates an explicit config when supplied;
otherwise it returns an existing standard config or writes `defaultConfig` as
deterministic YAML mode `0600`, reloads it through `loadConfig`, and returns
the absolute path.

- [ ] **Step 4: Verify storage/config tests**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-definition-store.test.ts test/config.test.ts && node_modules/.bin/tsc -p tsconfig.json --noEmit'
```

Expected: PASS; fault injection leaves no temp file or changed destination.

- [ ] **Step 5: Commit private storage**

```bash
git add src/service/definition-store.ts test/service-definition-store.test.ts src/config/load.ts src/config/types.ts test/config.test.ts
git commit -m "feat: store service configuration privately"
```

### Task 4: Implement shell-free native service manager operations

**Files:**

- Create: `src/platform/commands.ts`
- Create: `src/service/manager.ts`
- Create: `test/service-manager.test.ts`

**Interfaces:**

- Consumes: service paths/rendering/store, UID, absolute runtime paths, injected `CommandRunner`.
- Produces: `CommandRunner`, `ProcessCommandRunner`, `ServiceManagerStatus`, `ServiceManager`, and `createServiceManager(options)`.

- [ ] **Step 1: Write failing exact-command and preservation tests**

```ts
class RecordingRunner implements CommandRunner {
  readonly calls: { file: string; args: readonly string[] }[] = [];

  run(file: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ file, args: [...args] });
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }
}

it("enables Linux login startup without starting during install", async () => {
  const runner = new RecordingRunner();
  const { manager } = await linuxFixture(runner);
  await manager.install();
  expect(runner.calls).toEqual([
    { file: "/usr/bin/systemctl", args: ["--user", "daemon-reload"] },
    {
      file: "/usr/bin/systemctl",
      args: ["--user", "enable", "toss-agent-runtime.service"],
    },
  ]);
  expect(runner.calls.flatMap((entry) => entry.args)).not.toContain("start");
});

it("uninstall preserves the complete state and log roots", async () => {
  const runner = new RecordingRunner();
  const { manager, canonicalRunArtifact, operationalLog } = await linuxFixture(runner);
  await manager.uninstall();
  expect(await readFile(canonicalRunArtifact, "utf8")).toBe("preserve");
  expect(await readFile(operationalLog, "utf8")).toBe("preserve");
});
```

Cover exact arrays for Darwin and Linux install/start/stop/restart/status/uninstall, repeated operations, manager executable unavailable, nonzero manager exits, installed incompatible definition, status parsing, definition symlink, and uninstall target scope.

The test file defines async `linuxFixture(runner)` and
`darwinFixture(runner)` as complete `createServiceManager` fixture factories
rooted in a fresh temporary home. Each factory creates its config through
`ensureServiceConfig`, supplies fixed absolute Node/CLI paths, fixed UID `501`,
and returns the manager plus its state/log artifact paths.

- [ ] **Step 2: Run and observe missing manager failures**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-manager.test.ts'
```

Expected: FAIL because command runner and service manager do not exist.

- [ ] **Step 3: Implement the manager interfaces and exact operations**

```ts
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(file: string, args: readonly string[]): Promise<CommandResult>;
}

export interface ServiceManagerStatus {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly backoff: boolean;
  readonly restartCount: number;
  readonly lastExitCode: number | null;
}

export interface ServiceManager {
  install(): Promise<ServiceManagerStatus>;
  start(): Promise<ServiceManagerStatus>;
  stop(): Promise<ServiceManagerStatus>;
  restart(): Promise<ServiceManagerStatus>;
  status(): Promise<ServiceManagerStatus>;
  uninstall(): Promise<ServiceManagerStatus>;
}
```

Use these exact native commands, with no shell:

- Darwin uses absolute `/bin/launchctl`. Start arguments are
  `bootstrap gui/<uid> <definition>`; stop:
  `bootout gui/<uid>/software.toss.agent-runtime`; restart:
  `kickstart -k gui/<uid>/software.toss.agent-runtime`; status:
  `print gui/<uid>/software.toss.agent-runtime`.
- Linux uses absolute `/usr/bin/systemctl`. Install after definition write uses
  `--user daemon-reload`, then
  `--user enable toss-agent-runtime.service`; start/stop/restart use the
  corresponding `--user` verb; status uses
  `--user show toss-agent-runtime.service --property=LoadState,UnitFileState,ActiveState,SubState,Result,NRestarts,ExecMainStatus --no-pager`.
- Linux uninstall: idempotent stop, disable, safe definition removal, then daemon-reload. Darwin uninstall: idempotent bootout followed by safe definition removal.

Map command-not-found to `RUNTIME_SERVICE_MANAGER_UNAVAILABLE`; unsafe definition content/path to `RUNTIME_SERVICE_DEFINITION_UNSAFE`; nonzero manager operations to `RUNTIME_SERVICE_MANAGER_FAILED` with no raw stderr reflection. Status treats absent definitions/services as a successful `installed:false` result.

- [ ] **Step 4: Verify manager tests**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-manager.test.ts && node_modules/.bin/tsc -p tsconfig.json --noEmit'
```

Expected: PASS; install never records start/bootstrap/kickstart and uninstall preserves artifacts.

- [ ] **Step 5: Commit manager behavior**

```bash
git add src/platform/commands.ts src/service/manager.ts test/service-manager.test.ts
git commit -m "feat: manage native per-user runtime service"
```

### Task 5: Enforce one supervisor instance and reclaim only proven stale state

**Files:**

- Create: `src/service/instance-lock.ts`
- Create: `test/service-instance-lock.test.ts`

**Interfaces:**

- Consumes: lock schema/parser, private atomic store, injected process/socket probes, injected clock/ID/executable hash.
- Produces: `ProcessProbe`, `SocketIdentityProbe`, `InstanceLock`, and `acquireInstanceLock(options)`.

- [ ] **Step 1: Write failing real-filesystem lock tests**

```ts
it("rejects a second live owner without killing it", async () => {
  const first = await acquireInstanceLock(options({ isAlive: () => true }));
  await expect(acquireInstanceLock(options({ isAlive: () => true }))).rejects.toMatchObject({
    code: "RUNTIME_SERVICE_ALREADY_RUNNING",
  });
  expect(killCalls).toEqual([]);
  await first.release();
});

it("reclaims a private dead lock only when no socket identifies it", async () => {
  await writeOwner({ pid: 4100, service_instance_id: oldId });
  const lock = await acquireInstanceLock(
    options({ isAlive: () => false, identifySocket: () => Promise.resolve(null) }),
  );
  expect(lock.owner.service_instance_id).not.toBe(oldId);
  await lock.release();
});

it("fails closed for an alive or ambiguous recorded pid", async () => {
  await writeOwner({ pid: 4100, service_instance_id: oldId });
  await expect(acquireInstanceLock(options({ isAlive: () => "unknown" }))).rejects.toMatchObject({
    code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS",
  });
});
```

Add cases for lock directory/file modes, wrong owner, symlinked owner, malformed/oversized owner, missing owner younger than 30 seconds, missing owner older than 30 seconds with no listener, service identity mismatch, release by wrong instance ID, release failure, and no recursive deletion.

The lock test fixture defines fixed `oldId`/`newId` UUIDs, a `killCalls` array,
`writeOwner(owner)` that writes a valid private lock under a temporary runtime
root, and `options(overrides)` returning every `acquireInstanceLock` dependency:
fixed clock, IDs, executable hash, process probe, socket probe, ownership probe,
and paths. Overrides replace only the named probe behavior.

- [ ] **Step 2: Run and observe missing lock implementation**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-instance-lock.test.ts'
```

Expected: FAIL because `acquireInstanceLock` does not exist.

- [ ] **Step 3: Implement conservative lock acquisition/release**

```ts
export type ProcessLiveness = "alive" | "dead" | "unknown";

export interface ProcessProbe {
  liveness(pid: number): ProcessLiveness;
}

export interface SocketIdentityProbe {
  identify(socketPath: string): Promise<string | null>;
}

export interface InstanceLock {
  readonly owner: ServiceLockV1;
  release(): Promise<void>;
}
```

Acquire by `mkdir(lockPath, { mode: 0o700 })`; create and sync `owner.json`
mode `0600`; synchronize the parent directory. Compute `executable_hash` as
SHA-256 over canonical JSON containing the real Node path, real CLI path, and
package version; no path is persisted outside that hash. On `EEXIST`, inspect
the directory and owner through no-follow handles. A live/unknown PID or
accepting recorded socket rejects. A dead PID plus no listener permits
explicit unlink of the validated owner and `rmdir` of the validated lock
directory before one retry. An ownerless private lock may be reclaimed only
after 30 seconds and no listener. Release re-reads the owner and removes
exactly `owner.json` and the empty lock directory only when the instance ID
matches.

- [ ] **Step 4: Verify lock tests and leak cleanup**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-instance-lock.test.ts && node_modules/.bin/tsc -p tsconfig.json --noEmit'
```

Expected: PASS; all tests leave no signal/process mutation and no lock owned by another identity removed.

- [ ] **Step 5: Commit exclusive instance locking**

```bash
git add src/service/instance-lock.ts test/service-instance-lock.test.ts
git commit -m "feat: enforce one runtime supervisor instance"
```

### Task 6: Add the bounded private Unix control socket

**Files:**

- Create: `src/service/control.ts`
- Create: `test/service-control.test.ts`

**Interfaces:**

- Consumes: request/response parsers, service status supplier, private runtime/socket paths, clock/ID, service errors.
- Produces: `ServiceControlServer`, `createServiceControlServer(options)`, `requestServiceStatus(options)`, and `probeServiceIdentity(options)`.

- [ ] **Step 1: Write failing real-socket transport tests**

```ts
it("announces listening only after the Unix socket is mode 0600", async () => {
  const server = createServiceControlServer(options);
  await server.listen();
  const metadata = await lstat(socketPath);
  expect(metadata.isSocket()).toBe(true);
  expect(metadata.mode & 0o777).toBe(0o600);
  await server.close();
});

it("returns one cached response for a duplicate canonical request id", async () => {
  const request = statusRequest(fixedRequestId);
  const first = await sendRaw(request);
  const second = await sendRaw(request);
  expect(second).toBe(first);
  expect(statusCalls).toBe(1);
});

it("rejects oversize input without reflecting its bytes", async () => {
  const response = await sendRaw(`${"x".repeat(65_537)}\n`);
  expect(response).not.toContain("x".repeat(64));
  expect(JSON.parse(response)).toMatchObject({ ok: false });
});
```

Add cases for runtime directory `0700`, stale socket, symlink/non-socket target, no newline before EOF, extra line, malformed/duplicate-key JSON, unknown command/version/field, secret-shaped key, request-ID conflict, 32 concurrent connection cap, five-second idle timeout, server close while clients are connected, and socket cleanup.

The control test fixture defines `options` as a complete server option object
under a temporary runtime root, `statusRequest(id)` as canonical
`service-control-request.v1` plus newline, and `sendRaw(bytes)` as a real
`node:net` client that collects one UTF-8 response until close. A fixed status
supplier increments `statusCalls`; fake timers cover timeout/cache behavior.

- [ ] **Step 2: Run and observe missing control transport**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-control.test.ts'
```

Expected: FAIL because control server/client APIs do not exist.

- [ ] **Step 3: Implement one-request-per-connection framing and safe status**

```ts
export interface ServiceControlServer {
  listen(): Promise<void>;
  stopAccepting(): void;
  drain(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export function createServiceControlServer(options: {
  readonly socketPath: string;
  readonly serviceInstanceId: string;
  readonly status: () => ServiceStatusV1;
  readonly idleTimeoutMs: 5_000;
  readonly maxConnections: 32;
  readonly cacheSize: 256;
}): ServiceControlServer;
```

Use `node:net` without TCP fallback. The supervisor establishes process umask
`0077` before constructing the server; the server then explicitly
`chmod(socketPath, 0o600)` and verifies `lstat().isSocket()` before resolving
`listen`. Buffer at most 65,536 bytes plus one newline. Dispatch exactly one
request and end the connection after one canonical response. Store 256 request
ID/hash/response entries in insertion-order LRU. `probeServiceIdentity` sends
a fresh status request and returns only the parsed service instance ID; all
failures return `null` and never expose raw socket errors.

- [ ] **Step 4: Verify transport tests**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-control.test.ts && node_modules/.bin/tsc -p tsconfig.json --noEmit'
```

Expected: PASS; socket is private before readiness and all server resources close under fake-timer tests.

- [ ] **Step 5: Commit private control transport**

```bash
git add src/service/control.ts test/service-control.test.ts
git commit -m "feat: add private runtime control socket"
```

### Task 7: Orchestrate supervisor startup, readiness, and bounded shutdown

**Files:**

- Create: `src/service/supervisor.ts`
- Create: `test/service-supervisor.test.ts`
- Modify: `src/service/lifecycle.ts`
- Modify: `test/service-lifecycle.test.ts`
- Modify: `src/cli/main.ts`
- Modify: `test/serve-smoke.test.ts`

**Interfaces:**

- Consumes: loaded config, signal source, instance lock, control server, recovery/interruption participants, injected readiness callback.
- Produces: `RecoveryParticipant`, `InterruptionRecorder`, `SupervisorOutcome`, and `runSupervisor(options)`.

- [ ] **Step 1: Write failing ordered lifecycle tests**

```ts
it("announces readiness only after lock, recovery, listeners, and private socket", async () => {
  const events: string[] = [];
  const running = runSupervisor(
    options({
      acquireLock: async () => {
        events.push("lock");
        return fakeLock;
      },
      recover: async () => {
        events.push("recover");
      },
      listen: async () => {
        events.push("listen");
      },
      onReady: () => {
        events.push("ready");
      },
    }),
  );
  await readyObserved;
  expect(events).toEqual(["lock", "recover", "listen", "ready"]);
  signals.emit("SIGTERM");
  await running;
});

it("persists interruption before flushing and removing socket/lock", async () => {
  const events: string[] = [];
  const running = runSupervisor(shutdownOptions(events));
  await readyObserved;
  signals.emit("SIGTERM");
  await running;
  expect(events).toEqual([
    "stop-accepting",
    "stop-watchers",
    "interrupt-active",
    "drain-control",
    "flush",
    "close-socket",
    "release-lock",
  ]);
});
```

Add startup failure at every stage, duplicate signals, requested stop, drain timeout/abort, interruption failure, socket close failure, lock release failure, readiness callback failure, no readiness on unsafe paths, and cleanup ordering tests.

The supervisor test fixture defines `options(overrides)` with fixed config,
clock, UUID, executable hash, fake signals, temporary private paths, no-op
participants, injected lock/server factories, and `onReady` promise resolver.
It defines `fakeLock` as an `InstanceLock` with the fixed owner and an async
identity-checked no-op release.
`shutdownOptions(events)` replaces each lifecycle callback with an async or
sync callback that appends exactly the expected event name. `readyObserved` is
the promise resolved only by the fixture's `onReady` callback.

- [ ] **Step 2: Run and observe missing supervisor orchestration**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-supervisor.test.ts test/service-lifecycle.test.ts test/serve-smoke.test.ts'
```

Expected: FAIL because `runSupervisor` and participant interfaces do not exist.

- [ ] **Step 3: Implement the participant boundary and supervisor**

```ts
export interface RecoveryParticipant {
  recover(): Promise<void>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}

export interface InterruptionRecorder {
  interruptActive(signal: AbortSignal): Promise<void>;
}

export interface SupervisorOutcome extends ServiceOutcome {
  readonly serviceInstanceId: string;
}
```

`runSupervisor` performs exact startup order: set process umask `0077` through
an injected umask adapter; validate/create private state/log/runtime
directories; acquire the instance lock; recover participants;
create/listen/verify the control socket; register `SIGINT` and `SIGTERM`;
invoke `onReady`. Exact shutdown order is the test sequence above. Use the
configured deadline for the complete drain and abort remaining work when it
expires. Always attempt socket close and identity-checked lock release in
nested `finally` blocks, then restore the prior umask after every owned file
and socket is closed. Preserve the primary safe error code; cleanup failures
may change health diagnostics but never expose paths/stacks.

Refactor `runService` only enough to support an injected requested-stop callback and whole-drain timeout without changing existing signal outcomes. Replace the baseline `serve` no-op lifecycle in `main` with `runSupervisor` and no-op Wave 3 participants. Keep IPC readiness diagnostic-only, but emit it only from the supervisor `onReady` callback.

- [ ] **Step 4: Verify supervisor and existing lifecycle behavior**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-supervisor.test.ts test/service-lifecycle.test.ts test/serve-smoke.test.ts && node_modules/.bin/tsc -p tsconfig.json --noEmit'
```

Expected: PASS; all old graceful/forced lifecycle behaviors remain stable.

- [ ] **Step 5: Commit supervised serve lifecycle**

```bash
git add src/service/supervisor.ts test/service-supervisor.test.ts src/service/lifecycle.ts test/service-lifecycle.test.ts src/cli/main.ts test/serve-smoke.test.ts
git commit -m "feat: supervise the durable local runtime process"
```

### Task 8: Add operator service commands and actionable doctor status

**Files:**

- Modify: `src/cli/grammar.ts`
- Modify: `src/cli/main.ts`
- Modify: `test/cli.test.ts`
- Modify: `src/cli/result.ts`

**Interfaces:**

- Consumes: `ServiceManager`, `requestServiceStatus`, existing command-result/error rendering.
- Produces: `ServiceAction`, service subcommands in `BaselineCommand`, CLI routing, manager/socket status data, and service doctor check.

- [ ] **Step 1: Write failing grammar/result/doctor tests**

```ts
it.each(["install", "start", "stop", "restart", "status", "uninstall"])(
  "routes service %s with one canonical JSON result",
  async (action) => {
    const output = await runCli(["service", action, "--json"], serviceCliServices);
    expect(output.stderr).toBe("");
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      command: `service ${action}`,
      ok: true,
      exit_code: 0,
    });
  },
);

it("reports crash backoff with safe remediation", async () => {
  const output = await runCli(["doctor", "--json"], servicesWithBackoffStatus);
  expect(output.exitCode).toBe(5);
  expect(JSON.parse(output.stdout).data.checks).toContainEqual({
    id: "service",
    status: "FAIL",
    message: "Runtime service restart backoff is active; inspect service status",
  });
});
```

Add malformed nested grammar, `--config` allowed only on install, duplicate/inline secret options, unsupported platform, manager unavailable, absent status, installed-stopped status, healthy socket identity mismatch, safe human output, and stable exit-code tests.

The CLI test file defines `serviceCliServices` by extending the existing
`services` fixture with a fake `manageService(action, configPath)` that records
the exact action and returns a fixed `ServiceManagerStatus`. It defines
`servicesWithBackoffStatus` with `backoff:true`, restart count `5`, last exit
code `70`, and an unavailable socket probe. These fixtures never call a real
manager or access user paths.

- [ ] **Step 2: Run and observe grammar/routing failures**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/cli.test.ts'
```

Expected: FAIL because the parser rejects `service` and CLI services lack manager operations.

- [ ] **Step 3: Implement fixed nested grammar and safe mapping**

```ts
export type ServiceAction = "install" | "start" | "stop" | "restart" | "status" | "uninstall";

export type BaselineCommand =
  | Readonly<{ name: "help" }>
  | Readonly<{ name: "version" }>
  | Readonly<{ name: "capabilities"; json: boolean }>
  | Readonly<{ name: "doctor"; json: boolean; configPath?: string }>
  | Readonly<{ name: "serve"; json: boolean; configPath?: string }>
  | Readonly<{
      name: "service";
      action: ServiceAction;
      json: boolean;
      configPath?: string;
    }>;
```

Only `service install` accepts `--config`; every action accepts `--json`; positional/unknown/duplicate values fail with code 2 and redact inline values. Map already-running/conflict to 6, unsafe definition/path to 5, manager unavailable to 69, and unexpected internal failure to 70. `service status` returns exit 0 with `installed:false`; unhealthy/backoff is data, not a transport failure.

Doctor rules are exact: active manager plus matching healthy socket is PASS; absent/stopped is WARN in development and FAIL in production; backoff, unsafe definition, identity mismatch, or degraded socket health is FAIL. Keep the existing execution-capability warning.

Update help with all six subcommands. Resolve the executable for install from `realpath(process.argv[1])`, use `process.execPath` for Node, and never depend on `PATH` inside the installed definition.

- [ ] **Step 4: Verify CLI and full focused service suite**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/cli.test.ts test/service-*.test.ts test/serve-smoke.test.ts && node_modules/.bin/tsc -p tsconfig.json --noEmit'
```

Expected: PASS with one JSON document and empty stderr for every routed JSON failure.

- [ ] **Step 5: Commit operator commands**

```bash
git add src/cli/grammar.ts src/cli/main.ts src/cli/result.ts test/cli.test.ts
git commit -m "feat: expose local service lifecycle commands"
```

### Task 9: Validate native definitions and installed-package supervision

**Files:**

- Create: `test/service-definition-native.test.ts`
- Modify: `scripts/package-test.mjs`
- Modify: `scripts/package-files.json`

**Interfaces:**

- Consumes: renderer, built package, installed executable, real temporary Unix socket/config/state roots.
- Produces: platform syntax acceptance and installed single-instance/socket/signal smoke evidence.

- [ ] **Step 1: Write failing platform/package acceptance checks**

```ts
it.runIf(process.platform === "darwin")("passes native launchd plist validation", async () => {
  const definition = renderServiceDefinition(darwinInput);
  const result = await runWithInput("/usr/bin/plutil", ["-lint", "-"], definition);
  expect(result.exitCode).toBe(0);
});

it.runIf(process.platform === "linux")("passes native systemd unit validation", async () => {
  const unit = await writeTemporaryUnit(renderServiceDefinition(linuxInput));
  const result = await runFile("/usr/bin/systemd-analyze", ["verify", unit]);
  expect(result.exitCode).toBe(0);
});
```

Extend the package test to create a development config whose state, log, and
socket paths are all inside the package test's fresh temporary root; never use
the checked-in `/var/tmp` example for a live service. Wait for readiness,
assert the installed socket exists with mode `0600`, start a second installed
`serve` against the same config and require stable conflict exit 6/code
`RUNTIME_SERVICE_ALREADY_RUNNING`, query status over the socket, send
SIGTERM/SIGINT, verify socket/lock cleanup, and verify no child/background
process remains.

The native test defines `runWithInput(file,args,input)` using `spawn` with
pipe-only stdio and no shell, `runFile(file,args)` using the same runner without
stdin, and `writeTemporaryUnit(content)` under an `mkdtemp` root cleaned in
`afterEach`. Renderer inputs use the real `process.execPath` and an existing
temporary CLI file so native validators do not fail on nonexistent paths.

- [ ] **Step 2: Run and observe package-manifest/smoke failures**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'npm run build && node_modules/.bin/vitest run test/service-definition-native.test.ts && npm run test:package'
```

Expected: FAIL because new built service files/schemas are absent from the exact package list and installed supervision assertions are not implemented.

- [ ] **Step 3: Implement platform validation and exact packaging**

Confirm `copy-assets.mjs` already copies every `.schema.json` from
`contracts/runtime` deterministically and leave it unchanged. Extend
`REQUIRED_FILES` with all three service schemas and service public build
entries. Existing allowed-path expressions already cover the exact runtime
contract and built service directories; do not broaden them.

Add every generated `dist/src/service/*.js`, map, declaration, declaration map, `dist/src/platform/commands.*`, and service schema source/dist path to `scripts/package-files.json` in sorted exact order. Do not add tests, specs, verification evidence, user paths, temp files, service definitions, state, sockets, or locks to the tarball.

CI remains unchanged and continues to run `npm run verify`; the conditional
native test executes `/usr/bin/plutil` on macOS and
`/usr/bin/systemd-analyze verify` on Ubuntu. No CI step installs into the real
service-manager directory or starts a persistent manager service.

- [ ] **Step 4: Run the full local acceptance line**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'npm run format && npm run verify && npm audit --omit=dev --audit-level=high'
git diff --check
```

Expected: all checks exit 0; package test reports the new exact file count; audit reports 0 high vulnerabilities.

- [ ] **Step 5: Commit platform/package acceptance**

```bash
git add test/service-definition-native.test.ts scripts/package-test.mjs scripts/package-files.json
git commit -m "test: verify installed service supervision"
```

### Task 10: Publish #28 documentation and commit-bound evidence

**Files:**

- Create: `docs/contracts/local-service-control-v1.md`
- Create: `docs/verification/v1-wave-2-service.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-08-19-durable-local-service-design.md`
- Modify: `test/documentation-integrity.test.ts`
- Modify: `scripts/package-files.json`
- Modify: `scripts/package-test.mjs`

**Interfaces:**

- Consumes: final public CLI/contracts, exact publishable commit SHA, exact pack report/hash, local/native/package verification, remote matrix URL after push.
- Produces: normative local-service contract, operator instructions, an honest
  #28 foundation acceptance/dependency map, and reproducible evidence.

- [ ] **Step 1: Write failing documentation integrity assertions**

```ts
it("documents explicit install and the no-side-effect package boundary", async () => {
  const readme = await readFile("README.md", "utf8");
  const contract = await readFile("docs/contracts/local-service-control-v1.md", "utf8");
  expect(readme).toContain("toss-runtime service install");
  expect(readme).toContain("does not start the service");
  expect(contract).toContain("0600");
  expect(contract).toContain("RUNTIME_SERVICE_ALREADY_RUNNING");
  expect(contract).toContain("Uninstall preserves");
});
```

- [ ] **Step 2: Run and observe missing documentation**

Run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/documentation-integrity.test.ts'
```

Expected: FAIL because the local-service contract/operator sections do not exist.

- [ ] **Step 3: Write normative docs and the pre-evidence publishable commit**

Document exact CLI grammar, manager paths/commands, login enablement without immediate start, restart limits, environment allowlist, socket/lock permissions, request/response bounds, stable errors, doctor states, shutdown order, uninstall preservation, and package-install no-side-effect boundary. Update the Wave 2 design status from approved design to implemented #28 boundary without claiming #1/#29/#30 completion.

Add `docs/contracts/local-service-control-v1.md` to the exact sorted package
manifest and `REQUIRED_FILES`; keep verification evidence excluded. Run
format/documentation/package tests, then commit public code/docs before
calculating evidence:

```bash
git add README.md CHANGELOG.md docs/contracts/local-service-control-v1.md docs/superpowers/specs/2026-08-19-durable-local-service-design.md test/documentation-integrity.test.ts scripts/package-files.json scripts/package-test.mjs
git commit -m "docs: publish per-user service operations"
```

- [ ] **Step 4: Produce exact Node 22/package evidence against the clean publishable commit**

Run:

```bash
git status --short
git rev-parse HEAD
npx --yes --package=node@22.23.1 --call 'npm ci && npm run verify && npm audit --omit=dev --audit-level=high && node bin/toss-runtime.js service status --json && node bin/toss-runtime.js doctor --json'
npx --yes --package=node@22.23.1 --call 'npm pack --json --ignore-scripts'
shasum -a 256 toss-software-agent-runtime-0.0.0-development.tgz
```

Expected: clean before acceptance; all commands exit according to documented absent/healthy service semantics; pack file list matches exactly; record filename, file count, packed/unpacked bytes, integrity, and SHA-256. Move the explicit tarball to Trash after recording it.

- [ ] **Step 5: Add evidence-only commit and run fresh verification**

Write `docs/verification/v1-wave-2-service.md` with:

- verified publishable commit SHA and date;
- Node/npm/OS without username/home/secret values;
- exact commands/results and native syntax checks;
- exact package file count/size/SHA-256;
- acceptance mapping for every #28 criterion, marking production
  `INTERRUPTED` persistence as pending issue #1 while recording the durable
  test-double integration evidence;
- explicit note that remote CI and issue closure remain pending;
- explicit note that #1/#29/#30 and npm `1.0.0` remain incomplete.

Then run:

```bash
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/prettier --write docs/verification/v1-wave-2-service.md && npm run verify && npm audit --omit=dev --audit-level=high'
git diff --check
git add docs/verification/v1-wave-2-service.md
git commit -m "test: record per-user service acceptance"
```

Expected: evidence is the only file changed by the final commit and all checks pass at evidence head.

- [ ] **Step 6: Request adversarial review before remote delivery**

The reviewer must inspect the complete #28 range and reproduce at least:

- package install causes no service-manager write/start;
- install enables login startup but does not start now;
- second supervisor fails closed;
- socket and lock permissions/ownership;
- stale/ambiguous lock and socket behavior;
- command/JSON error safety;
- restart/backoff diagnosis;
- bounded ordered shutdown; and
- uninstall artifact preservation.

Fix every Critical/Important finding with a failing test and repeat
verification/review until the assessment is ready for the issue #1 dependency.

- [ ] **Step 7: Push a draft PR and require the full remote matrix**

Push `agent/v1-durable-local-service`, open a draft PR stacked on the merged
Wave 1 base (or temporarily target `agent/v1-contract-baseline` until #33
merges), and wait for Node `22.23.1`/`24` on Ubuntu/macOS. Record the final
green Actions run in evidence-only documentation. Do not close #28 when this
foundation PR merges; close it only after the subsequent #1 journal PR proves
production interruption persistence. Do not publish npm or create a GitHub
release.
