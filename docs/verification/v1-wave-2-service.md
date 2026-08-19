# v1 Wave 2 Service Foundation Acceptance Evidence

## Scope and binding

This record covers the implemented per-user local service foundation for issue
#28. It verifies evidence-free publishable prep commit
`71987d869212b0f2e44f30be1cfe4c6e03c7a56f` on 2026-08-20. That commit was
tracked-clean, contained no `docs/verification/v1-wave-2-service.md`, and
tracked no SDD artifact when acceptance began. This document binds that prior
commit so its own commit identity is not circular.

The verified foundation includes deterministic native definitions and command
arrays, the six-command service CLI, private single-instance and local-control
boundaries, direct installed crash/restart/signal smoke, readiness, and ordered
bounded shutdown. It does not install or start a definition in a real
launchd/systemd user manager. Automatic login-session activation and actual
native-manager crash-loop observation remain platform-integration pending;
ordinary local or remote `npm run verify` jobs do not close those gates.

Remote CI, GitHub delivery, and issue closure remain pending, and no remote run
URL is claimed. Issue #28 remains open. Production-durable `INTERRUPTED`
persistence remains pending issue #1 even though the ordering boundary is
verified with a filesystem-backed durable test double. Issues #1, #29, and #30
remain incomplete. The package is still `0.0.0-development`; npm `1.0.0` is
unreleased and unauthorized by this evidence.

This repository evidence is intentionally excluded from the npm package. The
packaged public operator/trust contract is
`docs/contracts/local-service-control-v1.md`.

## Environment

| Item               | Verified value                                   |
| ------------------ | ------------------------------------------------ |
| Date               | `2026-08-20`                                     |
| Publishable commit | `71987d869212b0f2e44f30be1cfe4c6e03c7a56f`       |
| Node.js            | `v22.23.1`                                       |
| npm                | `11.18.0`                                        |
| OS/architecture    | macOS `26.6.1` / `arm64`                         |
| Package            | `@toss-software/agent-runtime@0.0.0-development` |

No username, home-directory path, environment value, credential, provider
configuration, secret, socket path, config path, PID, or service-instance ID is
recorded.

## Clean publishable-commit acceptance

The exact combined command was:

```sh
npx --yes --package=node@22.23.1 --call 'node --version && npm --version && npm ci && npm run verify && npm audit --omit=dev --audit-level=high && node bin/toss-runtime.js service status --json && node bin/toss-runtime.js doctor --json'
```

It exited `0` with these results:

| Stage                       | Result                                                                                                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime versions            | Node `v22.23.1`; npm `11.18.0`.                                                                                                                                                                                                                                      |
| Fresh locked install        | `npm ci` added 138 packages and audited 139 with 0 vulnerabilities. npm emitted its optional `fsevents` allow-scripts advisory.                                                                                                                                      |
| Format/lint/typecheck       | Repository Prettier check, ESLint, and strict TypeScript `--noEmit` all exited `0`.                                                                                                                                                                                  |
| Vitest                      | 19 files passed; 419 tests passed and 1 host-conditional test skipped (420 total).                                                                                                                                                                                   |
| Build/full package smoke    | Build exited `0`; exact 178-file package acceptance proved the scripts-enabled contents-only prepack boundary, installed launcher, private socket/lock, duplicate instance, SIGKILL recovery/restart, status, graceful SIGTERM/SIGINT, cleanup, and process reaping. |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` exited `0` with 0 vulnerabilities.                                                                                                                                                                                         |
| `service status --json`     | One canonical successful result, exit `0`: absent service reported `installed:false`, `enabled:false`, `active:false`, `backoff:false`, zero restarts, and no socket status.                                                                                         |
| `doctor --json`             | One canonical successful result, exit `0`: package, platform, and default configuration passed; absent service and unavailable execution capabilities were development WARN checks; `healthy:true`.                                                                  |

The focused native command was:

```sh
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-definition-native.test.ts --reporter=verbose'
```

It exited `0`: the Darwin `/usr/bin/plutil -lint -` branch passed, and the Linux
`/usr/bin/systemd-analyze verify` branch was skipped on this macOS host. Both
platform renderers and exact shell-free manager command arrays are covered by
deterministic tests. Linux native syntax still requires a Linux job, and neither
syntax branch constitutes real user-manager login or crash-loop integration.

## Explicit prepack transcript

The scripts-enabled command used a fresh operation-owned destination:

```sh
npx --yes --package=node@22.23.1 --call 'npm pack --json --pack-destination <operation-owned-temp>'
```

It exited `0`. Before npm emitted its package report, the complete lifecycle
transcript contained exactly this prepack chain:

1. `npm run format:check`;
2. `npm run lint`;
3. `npm run typecheck`;
4. `npm run build` (including its deterministic clean/copy steps); and
5. `npm run test:package:contents`.

Contents-only acceptance reported 178 exact files. It packed and installed with
scripts disabled and checked the installed exports, launcher mode, help,
version, capabilities, and contract manifest. It did not invoke `npm test`,
`serve`, or any installed-supervisor smoke helper. Full supervisor smoke ran
only in the earlier explicit `npm run verify` stage.

The package-test runtime probe preserves a unique nonce through the actual
scripts-enabled pack while removing inherited case/hyphen-normalized npm
`pack-destination` variables. Both pack modes use an explicit fresh destination,
validate the reported basename, and independently clean the tarball, pack root,
inherited-destination decoy, installed-package root, and any smoke process.

## Reproducible package evidence

The evidence pack used a different fresh operation-owned destination and
disabled lifecycle scripts:

```sh
npx --yes --package=node@22.23.1 --call 'npm pack --json --ignore-scripts --pack-destination <operation-owned-temp>'
shasum -a 256 <operation-owned-temp>/toss-software-agent-runtime-0.0.0-development.tgz
```

The scripts-enabled probe and ignore-scripts evidence pack reported identical
metrics:

| Item             | Value                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Filename         | `toss-software-agent-runtime-0.0.0-development.tgz`                                               |
| Packed files     | 178                                                                                               |
| Packed size      | 108,131 bytes                                                                                     |
| Unpacked size    | 564,065 bytes                                                                                     |
| npm SHA-1 shasum | `dcc3607ae94a70041f868ed493f721a601fdf666`                                                        |
| npm integrity    | `sha512-1vhLsGP3g2R3lMDSXKD0S9uC3tf12lOIjYdonPN3u9NiDyQQLSRaUO4pUMwRqL/MQXLvP8udTfhw5CZIKd9niA==` |
| SHA-256          | `b8452f63e3e18736dad283d627ed0d549327b13a60cdd5b8619e4db09b3b82e6`                                |

The 178 paths matched `scripts/package-files.json` exactly and include the
public local-service contract. They exclude tests, SDD material, this
verification document, service definitions, state, sockets, and locks. Each
explicitly generated tarball was moved to a collision-safe Trash name and its
empty operation-owned destination was removed after recording. No tarball was
written to the repository root.

Final cleanup probes found no package/supervisor temporary root, `.tgz`, Unix
socket, `instance.lock`, or `runtime.sock` in the worktree or task-owned temp
scope, and no matching `toss-runtime ... serve` process. No launchd/systemd user
manager was mutated.

## Current regression map

The acceptance above includes every whole-branch regression added after the
prior evidence binding.

| Regression                                      | Current verified behavior                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SIGKILL publication-guard reclamation/restart   | Installed smoke reaches readiness, kills the first direct supervisor with SIGKILL, observes its recoverable guard/socket/lock state, starts a replacement, requires a new full-hash guard and removal of the stale guard, verifies status, stops gracefully, and proves both processes and all runtime artifacts are gone.                          |
| Safe publication claims                         | Startup recognizes legacy guards, full-hash guards, and interrupted claims only after acquiring the lock; it atomically claims and revalidates exact private empty artifacts, preserves replacements, and fails closed on unsafe entries.                                                                                                           |
| Writable root-ancestor policy                   | A modeled or real root-owned writable sticky temporary ancestor remains usable. A root-owned group/world-writable non-sticky leading ancestor is rejected before entering or creating a current-user subtree.                                                                                                                                       |
| Bounded definition reads                        | Exactly 65,536 definition bytes are accepted. Sparse oversized files and files that grow after descriptor validation are rejected with a stable safe failure before native manager mutation.                                                                                                                                                        |
| Restrictive-umask temporary cleanup             | If a restrictive umask prevents the definition-store temporary inode from meeting exact mode `0600`, publication fails safely and removes only that exact temporary inode.                                                                                                                                                                          |
| XML-invalid Unicode                             | Launchd rendering rejects lone high/low surrogates and `U+FFFE`/`U+FFFF` before XML publication, while valid astral Unicode remains encoded and preserved.                                                                                                                                                                                          |
| Packaged capability example                     | The packaged `runtime-capabilities.v1` example is parsed through the public API and is asserted against the exact ordered baseline schema-version list, preventing omitted or reordered supported schemas.                                                                                                                                          |
| Hermetic package destination                    | Contents-only and scripts-enabled pack paths strip inherited underscore/hyphen and case variants, use fresh explicit destinations, validate the local basename, and leave the caller destination, repository root, and all operation-owned pack/install roots free of tarballs.                                                                     |
| Instance-lock liveness evidence                 | The live-owner regression records the exact owner PID supplied to the production liveness probe, requires `RUNTIME_SERVICE_ALREADY_RUNNING`, and proves the canonical owner bytes remain unchanged; no signaling API is introduced.                                                                                                                 |
| Exact bigint control identities                 | Runtime directory, socket, guard, claim, and file-handle comparisons use lossless bigint device/inode values. A regression fails closed for identities that would collapse to the same JavaScript number.                                                                                                                                           |
| Repeated/interleaved control lifecycle          | Repeated and interleaved `stopAccepting`, `drain`, and `close` calls are idempotent, share close completion as applicable, preserve replacement-race safety, and leave no owned socket/publication artifact.                                                                                                                                        |
| Hard shutdown outcome and durable test boundary | A forced result resolves at the configured deadline even with pending close/release, while cleanup remains socket-close → exact-lock-release → umask-restore and fail-closed when a predecessor never settles. A temporary `INTERRUPTED` marker and its parent publication are fsynced before later stages in tests; production remains pending #1. |

## Issue #28 acceptance map

| Acceptance criterion                                                                                | Verified foundation state                           | Evidence and remaining gate                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service activates only through explicit install/start; package installation alone starts no daemon. | Deterministic boundary verified; integration open   | Exact command-array tests prove install has no current-session start/bootstrap and start is separate. The explicit prepack transcript proves its contents-only path. Actual manager enablement/login behavior remains platform-integration pending.                    |
| A second supervisor for the same user fails closed.                                                 | Verified directly                                   | Installed-package smoke starts a second direct `serve`, requires exit `6` and `RUNTIME_SERVICE_ALREADY_RUNNING`, and proves the first temporary instance remains healthy.                                                                                              |
| Other users cannot read or write the socket.                                                        | Filesystem boundary verified                        | Real temporary filesystem/socket tests and installed smoke require current-user ownership, `0700` runtime/lock directories, and `0600` socket/owner files before readiness. Exact bigint identity comparison prevents lossy replacement checks.                        |
| Automatic startup after login is verified on macOS and Linux.                                       | Platform integration pending                        | Deterministic `RunAtLoad`/enable definitions, exact shell-free commands, and local plist syntax passed. Actual automatic activation in real login sessions has not been observed; Linux native syntax also awaits a Linux job.                                         |
| Stop/restart drains within the deadline and unfinished work is durably recorded as `INTERRUPTED`.   | Deadline/order verified; production pending #1      | Pending-finalizer tests prove the forced outcome deadline and fail-closed order. A filesystem-backed test double fsyncs `INTERRUPTED` before later stages. Production persistence remains pending issue #1.                                                            |
| Crash loops produce bounded backoff and `doctor` provides actionable diagnosis.                     | Direct restart/deterministic policy verified        | Direct SIGKILL/restart smoke now proves stale-runtime reclamation. Definitions encode bounded restart policy, while parser and doctor tests require backoff remediation. Actual native-manager crash-loop observation remains platform-integration pending.            |
| Uninstall does not delete canonical project/run artifacts.                                          | Verified in temporary roots                         | Tests prove uninstall removes only compatible manager state/definition while preserving config, journals, registry, pending intake, logs, and canonical artifacts.                                                                                                     |
| launchd/systemd unit tests and platform smoke tests exist.                                          | Deterministic/local host pass; remaining gates open | Both renderers and command arrays are tested; local `plutil` and direct installed supervisor crash/restart/signal smoke passed. Linux `systemd-analyze` awaits a Linux job. Real launchd/systemd manager activation and crash-loop integration are not exercised here. |

## Pending delivery gates

- Remote Node `22.23.1`/`24` on macOS/Linux has not been run for this head,
  and no remote CI URL is recorded.
- Automatic login-session activation and actual native-manager crash-loop
  observation remain explicit platform-integration gates; ordinary remote
  syntax/package jobs will not satisfy them.
- GitHub push, draft PR creation, review, merge, and issue updates remain
  pending controller delivery.
- Issue #28 must remain open through the subsequent issue #1 production journal
  integration and its durable `INTERRUPTED` proof.
- Issues #1, #29, and #30 remain incomplete. npm `1.0.0` publication and a
  GitHub release are not authorized by this evidence.
