# v1 Wave 2 Service Foundation Acceptance Evidence

## Scope and state

This record covers the implemented per-user local service foundation for issue
#28. It verifies publishable fix commit
`eb6bedb9b1968d75372e9dd7e4a07c6bb39aac16` on 2026-08-20 before this
evidence-only document was recreated. The evidence binds that prior clean
commit, which intentionally contained no copy of this file, so its own commit
identity is not circular.

The verified foundation includes deterministic native definitions and command
arrays, the service CLI, private single-instance and local-control boundaries,
direct installed-supervisor smoke, readiness, and ordered bounded shutdown. It
does not install or start a definition in a real launchd/systemd user manager.
Automatic login-session activation and actual native crash-loop observation
remain platform-integration pending. Ordinary local or remote `npm run verify`
syntax/package jobs do not close those gates.

Remote CI, GitHub delivery, and issue closure remain pending; no remote run URL
is claimed. Issue #28 is not closed. Production-durable `INTERRUPTED`
persistence remains pending issue #1 even though the ordering boundary is
verified with a filesystem-backed durable test double. Issues #1, #29, and #30
and npm `1.0.0` remain incomplete.

This repository verification material is intentionally excluded from the npm
package. The packaged public operator/trust contract is
`docs/contracts/local-service-control-v1.md`.

## Environment

| Item               | Verified value                                   |
| ------------------ | ------------------------------------------------ |
| Date               | `2026-08-20`                                     |
| Publishable commit | `eb6bedb9b1968d75372e9dd7e4a07c6bb39aac16`       |
| Node.js            | `v22.23.1`                                       |
| npm                | `11.18.0`                                        |
| OS/architecture    | macOS `26.6.1` / `arm64`                         |
| Package            | `@toss-software/agent-runtime@0.0.0-development` |

No username, home-directory path, environment value, credential, provider
configuration, secret, socket path, config path, PID, or service-instance ID is
recorded.

## TDD and focused regression evidence

The shutdown RED command was:

```sh
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-lifecycle.test.ts test/service-supervisor.test.ts --reporter=verbose'
```

Before the fix it exited `1`: 2 files failed, with 4 failed and 40 passed tests.
The lifecycle result was still unsettled at the deadline, and the deferred
close, permanently pending close, and permanently pending release supervisor
cases each exceeded the test timeout. After the minimal lifecycle/finalizer
change, the same two files passed 44/44. The final focused command, including a
deferred-release ordering case and documentation integrity, passed 48/48
across 3 files.

The supervisor regressions prove that a forced outcome resolves at the exact
fake-timer deadline while close or release is still pending. Release never runs
before close settles, umask restoration never runs before exact-lock release
settles, and resolving the deferred stages produces the exact
socket-close/lock-release/umask-restore order. Permanently pending stages leave
their successors fail-closed. Existing forced-finalizer-error and graceful
primary/finalizer precedence cases remain green.

The former in-memory interruption-order recorder was replaced by a temporary
file test double. It creates an `INTERRUPTED` marker, writes and file-syncs the
bytes, syncs the parent directory publication, and only then publishes its
ordering event. The test reads back the exact `INTERRUPTED\n` bytes and proves
control drain, participant flush, socket close, and lock release follow that
fsync-backed boundary. This is test evidence only and does not define the
future journal schema; production still uses a no-op recorder pending issue #1.

The strengthened documentation/package RED command was:

```sh
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/documentation-integrity.test.ts --reporter=verbose'
```

It exited `1` with 1 failed / 2 passed before the corrected wording and package
scripts were present, then passed 3/3. The test fixes the exact six-command
grammar, only-install `--config`, install-without-current-start behavior, exact
contents-only prepack script, hard-deadline wording, and pending native and
production-durability statements.

## Clean publishable-commit acceptance

The publishable commit was tracked-clean before acceptance. The exact combined
command was:

```sh
npx --yes --package=node@22.23.1 --call 'node --version && npm --version && npm ci && npm run verify && npm audit --omit=dev --audit-level=high && node bin/toss-runtime.js service status --json && node bin/toss-runtime.js doctor --json'
```

It exited `0` with these results:

| Stage                       | Result                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime versions            | Node `v22.23.1`; npm `11.18.0`.                                                                                                                                                                                             |
| `npm ci`                    | 138 packages added; 139 audited; 0 vulnerabilities. npm emitted its `allow-scripts` advisory for the optional `fsevents` install script.                                                                                    |
| Format/lint/typecheck       | Prettier check, ESLint, and strict TypeScript `--noEmit` all exited `0`.                                                                                                                                                    |
| Vitest                      | 19 files passed; 395 tests passed and 1 platform-conditional test skipped (396 total).                                                                                                                                      |
| Build/full package smoke    | Build exited `0`; explicit verification exercised the real prepack probe, exact 178-file installed package, executable launcher, private supervisor/socket/lock, duplicate instance, signals, cleanup, and process reaping. |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` exited `0` with 0 vulnerabilities.                                                                                                                                                |
| `service status --json`     | One canonical successful result, exit `0`: absent service reported `installed:false`, `enabled:false`, `active:false`, `backoff:false`, zero restarts, and no socket status.                                                |
| `doctor --json`             | One canonical successful result, exit `0`: package/platform/default config passed; absent service and unavailable execution capabilities were development WARN checks; `healthy:true`.                                      |

The focused native command was:

```sh
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-definition-native.test.ts --reporter=verbose'
```

It exited `0`: the Darwin `/usr/bin/plutil -lint -` branch passed, and the Linux
`/usr/bin/systemd-analyze verify` branch was skipped on this macOS host. Both
platform renderers and exact manager command arrays are covered by deterministic
tests. Linux native syntax still requires the pending Linux job, and neither
syntax branch constitutes real user-manager login or crash-loop integration.

## Prepack boundary and package evidence

The scripts-enabled probe against the clean publishable commit was:

```sh
npx --yes --package=node@22.23.1 --call 'npm pack --json'
```

It exited `0`. Its transcript contained only `format:check`, `lint`,
`typecheck`, `build`, and `test:package:contents` before npm emitted the package
report. The nested contents-only path reported 178 files; it packed and
installed with scripts disabled and checked the installed exports, launcher
mode, help, version, capabilities, and contract manifest. It did not invoke
`npm test`, `serve`, or the installed-supervisor smoke. The package-test runtime
probe passes a unique nonce through the actual scripts-enabled pack, requires
the nested contents-only path to return it, and makes every service-smoke helper
fail if reached in contents-only mode. The full installed-supervisor smoke runs
afterward only in explicit `npm run verify`.

The reproducible evidence pack was then generated without lifecycle scripts:

```sh
npx --yes --package=node@22.23.1 --call 'npm pack --json --ignore-scripts'
shasum -a 256 toss-software-agent-runtime-0.0.0-development.tgz
```

The scripts-enabled probe and ignore-scripts evidence pack reported identical
metrics:

| Item             | Value                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Filename         | `toss-software-agent-runtime-0.0.0-development.tgz`                                               |
| Packed files     | 178                                                                                               |
| Packed size      | 103,665 bytes                                                                                     |
| Unpacked size    | 537,088 bytes                                                                                     |
| npm SHA-1 shasum | `d3818c7a4844f79236d764a3d19375c2e765a8b1`                                                        |
| npm integrity    | `sha512-XQWxp30Zhg2d8r17MCrrb6m8s1dfciFGuDu4eZQkWMI879/q9Ezq60nMSgNwQqVlCRScbJp8pDz1zqcLwEL3Bw==` |
| SHA-256          | `55e7f350a85a4dcb4d360f146f9b077aea70c898485d0bce4fdb8107a15a40f4`                                |

The 178 paths matched `scripts/package-files.json` exactly and include the
public local-service contract. The package contains no tests, verification
evidence, specs, service definitions, state, sockets, or locks. Each explicitly
generated tarball was moved to the user's Trash under a collision-safe name
after its result was recorded; no tarball remained in the worktree.

## Issue #28 acceptance map

| Acceptance criterion                                                                                | Verified foundation state                           | Evidence and remaining gate                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service activates only through explicit install/start; package installation alone starts no daemon. | Deterministic boundary verified; integration open   | Exact call-array tests prove install has no current-session start/bootstrap and start is separate. Real prepack proves its contents-only path. Actual manager enablement/login behavior remains platform-integration pending.                                             |
| A second supervisor for the same user fails closed.                                                 | Verified directly                                   | Installed-package smoke starts a second direct `serve`, requires exit `6` and `RUNTIME_SERVICE_ALREADY_RUNNING`, and proves the first temporary instance remains healthy.                                                                                                 |
| Other users cannot read or write the socket.                                                        | Filesystem boundary verified                        | Real temporary filesystem/socket tests and installed smoke require current-user ownership, `0700` runtime/lock directories, and `0600` socket/owner files before readiness.                                                                                               |
| Automatic startup after login is verified on macOS and Linux.                                       | Platform integration pending                        | Deterministic `RunAtLoad`/enable definitions, exact shell-free commands, and local plist syntax passed. Actual automatic activation in real login sessions has not been observed; Linux native syntax also awaits its pending Linux job.                                  |
| Stop/restart drains within the deadline and unfinished work is durably recorded as `INTERRUPTED`.   | Deadline/order verified; production pending #1      | Permanently pending close/release tests prove the forced outcome deadline and fail-closed ordering. A filesystem-backed test double fsyncs `INTERRUPTED` before later stages. Production persistence remains pending issue #1.                                            |
| Crash loops produce bounded backoff and `doctor` provides actionable diagnosis.                     | Deterministic behavior verified; integration open   | Definitions encode five-second restart delay/throttle and Linux five-start/60-second limit; parser and doctor tests require backoff FAIL remediation. Actual native-manager crash-loop observation remains platform-integration pending.                                  |
| Uninstall does not delete canonical project/run artifacts.                                          | Verified in temporary roots                         | Tests prove uninstall removes only compatible manager state/definition while preserving config, journals, registry, pending intake, logs, and canonical artifacts.                                                                                                        |
| launchd/systemd unit tests and platform smoke tests exist.                                          | Deterministic/local host pass; remaining gates open | Both renderers and command arrays are tested; local `plutil` and direct installed supervisor smoke passed. Linux `systemd-analyze` awaits the pending Linux job. Real launchd/systemd manager activation and crash-loop integration are intentionally not exercised here. |

## Pending delivery gates

- Remote Node `22.23.1`/`24` on macOS/Linux has not been run for this head,
  and no remote CI URL is recorded.
- Automatic login-session activation and actual native crash-loop observation
  remain explicit platform-integration gates; ordinary remote syntax/package
  jobs will not satisfy them.
- GitHub push, draft PR creation, review, merge, and issue updates remain
  pending controller delivery.
- Issue #28 must remain open through the subsequent issue #1 production journal
  integration and its durable `INTERRUPTED` proof.
- Issues #1, #29, and #30 are incomplete. npm `1.0.0` publication and a GitHub
  release are not authorized by this evidence.
