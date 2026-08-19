# v1 Wave 2 Service Foundation Acceptance Evidence

## Scope and state

This record covers the implemented per-user local service foundation for issue
#28. It verifies publishable commit
`d61dd590200e6b36b3362f7f87bc24ccede5c38a` on 2026-08-19 before this
evidence-only document was added. The evidence binds that prior clean commit so
its own commit identity is not circular.

Local macOS acceptance is complete for the implemented foundation. Remote CI,
the Linux native execution branch, GitHub delivery, and issue closure remain
pending; no remote run URL is claimed here. Issue #28 is not closed. Its
production-durable `INTERRUPTED` criterion remains pending issue #1 even though
the supervisor ordering is verified with a durable test double. Issues #1,
#29, and #30 and npm `1.0.0` remain incomplete.

This evidence is repository verification material and is intentionally
excluded from the npm package. The public operator/trust contract is
`docs/contracts/local-service-control-v1.md` and is included in the exact
package manifest.

## Environment

| Item               | Verified value                                   |
| ------------------ | ------------------------------------------------ |
| Date               | `2026-08-19`                                     |
| Publishable commit | `d61dd590200e6b36b3362f7f87bc24ccede5c38a`       |
| Node.js            | `v22.23.1`                                       |
| npm                | `11.18.0`                                        |
| OS/architecture    | macOS `26.6.1` / `arm64`                         |
| Package            | `@toss-software/agent-runtime@0.0.0-development` |

No username, home-directory path, environment value, credential, provider
configuration, secret, socket path, config path, PID, or service-instance ID is
recorded.

## Command evidence

The publishable commit was clean before acceptance. The exact combined command
was:

```sh
npx --yes --package=node@22.23.1 --call 'npm ci && npm run verify && npm audit --omit=dev --audit-level=high && node bin/toss-runtime.js service status --json && node bin/toss-runtime.js doctor --json'
```

It exited `0` with these results:

| Stage                       | Result                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                    | 138 packages added; 139 audited; 0 vulnerabilities. npm also emitted its `allow-scripts` advisory for the optional `fsevents` install script.                                                     |
| Format/lint/typecheck       | Prettier check, ESLint, and strict TypeScript `--noEmit` all exited `0`.                                                                                                                          |
| Vitest                      | 19 files passed; 392 tests passed and 1 platform-conditional test skipped (393 total).                                                                                                            |
| Build/package smoke         | Build exited `0`; the installed-package smoke verified the exact 178-file package, installed launcher, private supervisor/socket/lock, duplicate instance, signals, cleanup, and process reaping. |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` exited `0` with 0 vulnerabilities.                                                                                                                      |
| `service status --json`     | One canonical successful result, exit `0`: absent service reported `installed:false`, `enabled:false`, `active:false`, `backoff:false`, zero restarts, and no socket status.                      |
| `doctor --json`             | One canonical successful result, exit `0`: package/platform/default config passed; absent service and unavailable execution capabilities were development WARN checks; `healthy:true`.            |

The focused documentation TDD cycle used:

```sh
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/documentation-integrity.test.ts'
```

Before the public contract existed, it exited `1` with 1 failed / 2 passed; the
failure was `ENOENT` for `docs/contracts/local-service-control-v1.md`. After the
contract/operator/package documentation was added, the same command exited `0`
with 3/3 passing.

The focused native command was:

```sh
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-definition-native.test.ts --reporter=verbose'
```

It exited `0`: the Darwin branch passed exact `/usr/bin/plutil -lint -`; the
Linux `/usr/bin/systemd-analyze verify` branch was skipped on this macOS host.
The deterministic renderer and manager suites exercise both platforms locally;
native Linux execution remains a remote-matrix requirement.

## Package evidence

The exact package command against the clean publishable commit was:

```sh
npx --yes --package=node@22.23.1 --call 'npm pack --json --ignore-scripts'
shasum -a 256 toss-software-agent-runtime-0.0.0-development.tgz
```

| Item             | Value                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Filename         | `toss-software-agent-runtime-0.0.0-development.tgz`                                               |
| Packed files     | 178                                                                                               |
| Packed size      | 102,838 bytes                                                                                     |
| Unpacked size    | 534,503 bytes                                                                                     |
| npm SHA-1 shasum | `37bec6789db644d501b4d213002fab1b2f2b266b`                                                        |
| npm integrity    | `sha512-pwTg+YmPxwBJBYUqSvc6GCh6xW3Z2VzvbWi5STgCz9U2MoXpSdapgmpgvfojeJMdWit38cW36LvAH7t7sKzJEA==` |
| SHA-256          | `1f05c0eead06870325c8ab4dda76c4e709cfa7c51ed3366890326b708cef0a44`                                |

The 178 paths matched `scripts/package-files.json` exactly and include
`docs/contracts/local-service-control-v1.md`. The package contains no tests,
verification evidence, specs, user paths, service definitions, state, sockets,
or locks. The generated tarball was moved to the user's Trash under a
collision-safe name after hashing; no tarball remained in the worktree.

## Issue #28 acceptance map

| Acceptance criterion                                                                                | Local state                              | Evidence and remaining gate                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service activates only through explicit install/start; package installation alone starts no daemon. | Verified locally                         | Exact manager call-array tests prove install enables login without start/bootstrap. Package/prepack acceptance performs no manager write/enable/start; current-session activation is `service start`. |
| A second supervisor for the same user fails closed.                                                 | Verified locally                         | Real installed-package smoke starts a second `serve`, requires exit `6` and `RUNTIME_SERVICE_ALREADY_RUNNING`, and proves the first instance remains healthy.                                         |
| Other users cannot read or write the socket.                                                        | Verified locally                         | Real filesystem/socket tests and installed-package smoke require current-user ownership, `0700` runtime/lock directories, and `0600` socket/owner files before readiness.                             |
| Automatic startup after login is verified on macOS and Linux.                                       | Local design/host pass; remote pending   | Both deterministic definitions and exact manager enablement are tested; Darwin native plist validation passed. Linux native systemd validation must run in the pending remote Linux job.              |
| Stop/restart drains within the deadline and unfinished work is durably recorded as `INTERRUPTED`.   | Ordering verified; durability pending #1 | Supervisor tests prove whole-drain timeout and ordering through an injected durable `InterruptionRecorder`. Production supplies a no-op recorder until issue #1 adds the journal integration.         |
| Crash loops produce bounded backoff and `doctor` provides actionable diagnosis.                     | Verified locally                         | launchd uses a five-second throttle; systemd uses five-second restart delay and a five-start/60-second limit. Manager parsing and doctor tests require backoff FAIL remediation.                      |
| Uninstall does not delete canonical project/run artifacts.                                          | Verified locally                         | Real temporary-artifact tests prove uninstall removes only compatible manager state/definition while preserving config, journals, registry, pending intake, logs, and canonical artifacts.            |
| launchd/systemd unit tests and platform smoke tests exist.                                          | Local macOS pass; remote Linux pending   | Deterministic tests cover both renderers; `/usr/bin/plutil` passed; installed supervisor smoke passed on macOS. `/usr/bin/systemd-analyze verify` and Linux installed smoke await remote CI.          |

## Implementation acceptance coverage

The local suite and package smoke additionally verify the foundation's security
and lifecycle invariants:

- definitions use absolute Node/CLI/config arguments, only `LANG`, `LC_ALL`,
  and `TZ`, fixed restart policy, `UMask=0077`, and shell-free native argument
  arrays;
- configuration/definitions/lock owner/socket are private as applicable, with
  conservative no-follow publication and conditional stale-resource deletion;
- the local protocol is closed canonical JSON, bounded to 64 KiB plus LF, caps
  live connections at 32, times idle clients out after five seconds, and caches
  256 duplicate request IDs with byte-identical replay or fixed conflict;
- startup reaches readiness only after private roots, lock, recovery, verified
  socket, and stop-handler registration; shutdown stops intake, records the
  interruption boundary, drains, flushes, closes the socket, releases the lock,
  and restores umask within the configured deadline; and
- service JSON output and stable exit mappings do not reflect rejected values,
  manager stderr, local paths, socket errors, environment values, or secrets.

## Pending delivery gates

- Remote Node `22.23.1`/`24` on macOS/Linux has not been run for this head and
  no remote CI URL is recorded.
- GitHub push, draft PR creation, review, merge, and issue updates remain
  pending controller delivery.
- Issue #28 must remain open through the subsequent issue #1 production journal
  integration and its durable `INTERRUPTED` proof.
- Issues #1, #29, and #30 are incomplete. npm `1.0.0` publication and a GitHub
  release are not authorized by this evidence.
