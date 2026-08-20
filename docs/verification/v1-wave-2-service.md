# v1 Wave 2 Service Foundation Acceptance Evidence

## Scope and binding

This record covers the implemented per-user local service foundation for issue
#28. It verifies evidence-free publishable prep commit
`5b318368384e76a07d66be0da8c7e17c1bc3971e` on 2026-08-20. That commit was
tracked-clean, contained no `docs/verification/v1-wave-2-service.md`, and
tracked no SDD artifact when acceptance began. This document binds that prior
commit so its own commit identity is not circular.

The verified foundation includes deterministic native definitions and command
arrays, the six-command service CLI, bounded configuration loading, private
single-instance and local-control boundaries, direct installed
crash/restart/signal smoke, readiness, and ordered bounded shutdown. It does not
install or start a definition in a real launchd/systemd user manager. Automatic
login-session activation and actual native-manager crash-loop observation
remain platform-integration pending; ordinary local or remote `npm run verify`
jobs do not close those gates.

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
| Publishable commit | `5b318368384e76a07d66be0da8c7e17c1bc3971e`       |
| Primary runtime    | Node `v22.23.1`; npm `11.18.0`                   |
| Compatibility run  | Node `v24.19.0`; npm `11.18.0`                   |
| OS/architecture    | macOS `26.6.1` / `arm64`                         |
| Package            | `@toss-software/agent-runtime@0.0.0-development` |

No username, home-directory path, environment value, credential, provider
configuration, secret, socket path, config path, PID, or service-instance ID is
recorded.

## Clean publishable-commit acceptance

Acceptance used these exact command forms on the clean publishable commit:

```sh
npx --yes --package=node@22.23.1 --call 'node --version && npm --version && npm ci && npm run verify'
npx --yes --package=node@24 --call 'node --version && npm --version && npm run verify'
npx --yes --package=node@22.23.1 --call 'npm audit --omit=dev --audit-level=high'
npx --yes --package=node@22.23.1 --call 'node bin/toss-runtime.js service status --json'
npx --yes --package=node@22.23.1 --call 'node bin/toss-runtime.js doctor --json'
```

Every command exited `0` with these results:

| Stage                       | Result                                                                                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh locked install        | `npm ci` added 138 packages and audited 139 with 0 vulnerabilities. npm emitted its optional `fsevents` allow-scripts advisory.                                                                                                                                                            |
| Node 22 full verification   | Format, lint, and strict typecheck passed; 19 test files passed with 632 tests passed and 1 host-conditional test skipped (633 total); build and exact 178-file installed-package acceptance passed.                                                                                       |
| Node 24 full verification   | The same format, lint, typecheck, 632-pass/1-skip test result, build, and exact 178-file installed-package acceptance passed.                                                                                                                                                              |
| Installed lifecycle         | The full package acceptance proved launcher execute permissions, exports/help/version/capabilities/manifest, private ownership and modes, canonical control status, duplicate exit `6`, SIGKILL state reclamation and restart, graceful SIGTERM and SIGINT exit `0`, cleanup, and reaping. |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` found 0 vulnerabilities.                                                                                                                                                                                                                         |
| `service status --json`     | One canonical successful result, exit `0`: absent service reported `installed:false`, `enabled:false`, `active:false`, `backoff:false`, zero restarts, and no socket status.                                                                                                               |
| `doctor --json`             | One canonical successful result, exit `0`: package, platform, and default configuration passed; absent service and unavailable execution capabilities were development WARN checks; `healthy:true`.                                                                                        |

The installed lifecycle also proved that SIGKILL leaves exactly the expected
recoverable guard/socket/lock state; the replacement obtains a new full-hash
publication guard, removes the stale state, answers status, and leaves no
process, socket, lock, guard, stage, or claim after graceful stop. The duplicate
serve reports `RUNTIME_SERVICE_ALREADY_RUNNING` without harming the first
instance. A non-executable installed launcher fails with `EACCES`, and a
missing serve config reports stable exit `5` without reflecting its path.

The Linux status regression feeds the exact terminal manager output
`ActiveState=failed`, `SubState=failed`, and `Result=start-limit-hit`. Status
remains a successful data query with `backoff:true`; the service check in
`doctor` is `FAIL` with fixed remediation and doctor exits `5`. The exact
shell-free query includes `Result`:

```text
/usr/bin/systemctl --user show toss-agent-runtime.service --property=LoadState,UnitFileState,ActiveState,SubState,Result,NRestarts,ExecMainStatus --no-pager
```

Documentation integrity passed 4/4 focused tests. The focused native command
was:

```sh
npx --yes --package=node@22.23.1 --call 'node_modules/.bin/vitest run test/service-definition-native.test.ts --reporter=verbose'
```

It exited `0`: the Darwin `/usr/bin/plutil -lint -` branch passed, and the Linux
`/usr/bin/systemd-analyze verify` branch was skipped on this macOS host. Both
platform renderers and exact shell-free manager command arrays are covered by
deterministic tests. Linux native syntax still requires a Linux job, and neither
syntax branch constitutes real user-manager login or crash-loop integration.

No real launchd/systemd user-manager command was executed.

## Explicit prepack transcript

The scripts-enabled command used a fresh operation-owned destination and
foreground lifecycle output:

```sh
npx --yes --package=node@22.23.1 --call 'npm pack --json --foreground-scripts --pack-destination <operation-owned-temp>'
```

It exited `0`. Before npm emitted its package report, the complete lifecycle
transcript contained exactly this prepack chain:

1. `npm run format:check`;
2. `npm run lint`;
3. `npm run typecheck`;
4. `npm run build` (including deterministic clean/copy steps); and
5. `npm run test:package:contents`.

Contents-only acceptance reported 178 exact files. It packed and installed with
scripts disabled and checked the installed exports, launcher mode, help,
version, capabilities, and contract manifest. It did not invoke `npm test`,
`serve`, or an installed-supervisor smoke helper. Full supervisor smoke ran
only through explicit `npm run verify`.

The package-test runtime probe preserves a unique nonce through the actual
scripts-enabled pack while removing inherited case/hyphen-normalized npm
`pack-destination` variables. Both pack modes use explicit fresh destinations,
validate the reported basename, and independently clean the tarball, pack root,
inherited-destination decoy, installed-package root, and any smoke process.

## Reproducible package evidence

The evidence pack used a different fresh operation-owned destination and
disabled lifecycle scripts:

```sh
npx --yes --package=node@22.23.1 --call 'npm pack --json --ignore-scripts --pack-destination <operation-owned-temp>'
shasum -a 256 <operation-owned-temp>/toss-software-agent-runtime-0.0.0-development.tgz
```

The scripts-enabled probe and ignore-scripts evidence pack were byte-for-byte
identical and reported these exact values:

| Item             | Value                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Filename         | `toss-software-agent-runtime-0.0.0-development.tgz`                                               |
| Packed files     | 178                                                                                               |
| Packed size      | 132,466 bytes                                                                                     |
| Unpacked size    | 737,864 bytes                                                                                     |
| npm SHA-1 shasum | `e91aa472aabb990248d1542c10ecb797503ab5cd`                                                        |
| npm integrity    | `sha512-LskaCI61SsA/gzwnlDvlSC72y20bPqqPXVwZEMQtKjdT3mTAvFbV8SlNcZAywuH5dyT0FQ/RLpmMyMv90Loyyg==` |
| SHA-256          | `6a6fa9a9675ff33ebb56eb2764c005c969ad8e280994911cad0d7252ce415ca9`                                |

The 178 paths matched `scripts/package-files.json` exactly and include the
public local-service contract. They exclude tests, SDD material, this
verification document, service definitions, state, sockets, and locks. Each
explicitly generated tarball was moved to a collision-safe Trash name, and its
empty operation-owned destination was removed after recording. No tarball was
written to the repository root.

Final cleanup probes found no stage, definition/owner/ownerless claim,
publication guard or claim, package/supervisor temporary root, `.tgz`, Unix
socket, `instance.lock`, `runtime.sock`, or matching `toss-runtime ... serve`
process. The synced `sources/` reference tree was untouched.

## Current regression map

| Regression                              | Current verified behavior                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete trusted ancestry               | Production config validation walks every existing component from the filesystem root with no-follow metadata. Any symlink or non-directory ancestor is rejected before install/serve effects; root-owned leading ancestors must be non-writable or sticky, and the current-user subtree must stay current-user-owned and non-group/world-writable.                                                        |
| Bounded startup unwind                  | One configured `shutdown_timeout_ms` deadline covers the entire reverse-order recovered-participant startup cleanup. Permanent or late-rejecting flushes observe abort and cannot strand socket close, exact lock release, umask restoration, or the stable primary startup error; later participant stages do not start after the deadline.                                                              |
| Atomic definition move and preservation | Definition removal moves the final pathname atomically into the private claim as fixed `moved`, syncs and revalidates the claim directory and exact grammar, and deletes only a moved inode whose bigint identity and bytes equal the accepted snapshot. Regular, directory, symlink, cross-owner, or canonical replacements are preserved and make later operations fail closed.                         |
| Durable definition claim states         | The bounded private claim permits only fixed stage/state/definition/moved entries. Canonical state bytes are file-synced, published without overwrite by hard link, directory-synced, and identity-revalidated before cleanup. Dead-claimant empty, partial, linked, prepared, and expected-moved states recover; live, unknown, malformed, extra, conflicting, or replacement state remains fail-closed. |
| Identity-bound socket claim recovery    | Crash-left public and recognized staged sockets are atomically moved to an identity-derived `.x` plus 10 lowercase base-36 claim, the runtime directory is synced, and the claimed socket is revalidated and listener-probed. Dead/no-listener exact state recovers; live, unsafe, replacement, source reappearance, multiple, or conflicting state is preserved and fails closed.                        |
| UTF-8 socket path budget                | The complete public/staged/claim layout is checked using UTF-8 bytes, not character count: Darwin permits 104 bytes and Linux 107. The configured public path plus active `.s` + 10-base36 and stale `.x` + 10-base36 siblings must all fit before config/control effects. Native Darwin boundary coverage passed; Linux is covered by deterministic injection and awaits host integration.               |
| Reserved control namespaces             | Public socket basenames reject exactly six frozen patterns: legacy `.c` + 8 hex, current `.c` + 64 hex, `.r` + 64 hex, recovery `.s` + 25 base36, active `.s` + 10 base36, and `.x` + 10 base36. Uppercase, length, alphabet, dot, and multibyte near misses remain accepted. A crash-left public socket named as its exact `.x10` identity claim is preserved and rejected before recovery.              |
| Restart/recovery schedule               | The exported ownerless-lock threshold is exactly 30 seconds. Linux keeps `RestartSec=5s`, `StartLimitIntervalSec=60s`, and `StartLimitBurst=8`, admitting t0, t5, t10, t15, t20, t25, t30, and t35. A deterministic test makes the t30 boundary miss and acquires at t35, retaining one restart interval of margin. Launchd remains unchanged.                                                            |
| Durable lock removal                    | Every retained-directory unlink is followed by fsync on its held lock-directory descriptor and exact revalidation. After `instance.lock` rmdir, the exact runtime parent is opened with both `O_DIRECTORY` and `O_NOFOLLOW`, checked against its saved bigint identity, fsynced, and revalidated before acquire/release returns.                                                                          |
| Bounded runtime configuration           | `.json`, `.yaml`, and `.yml` use one held no-follow regular-file descriptor and a 2 MiB (2,097,152-byte) bound. Exact-cap valid files pass; cap-plus-one initial or growing files fail as `RUNTIME_CONFIG_INVALID` before manager, hashing, signals, readiness, or supervisor effects.                                                                                                                    |
| Canonical lock claims and publication   | Owner and ownerless removal use bounded canonical `service-lock-claim.v1` state. Owner, owner-claim, and ownerless-claim documents are complete and file-synced in claimant-bearing `0600` stages before no-overwrite hard-link publication and directory sync; clocks/UUIDs and chronology are prevalidated. All ownership and identity decisions retain bigint device/inode values.                     |
| Conservative lock recovery              | All owner, ownerless, and stage states recover only with exact private metadata/grammar/identities, compatible chronology, dead required processes, and no accepting listener. Live or unknown liveness, active/conflicting identity, malformed/multiple/replaced state, or ambiguity fails closed and preserves evidence.                                                                                |
| SIGKILL publication reclamation         | Installed smoke reaches readiness, SIGKILLs the first direct supervisor, observes the recoverable guard/socket/lock state, starts a replacement, requires a new full-hash guard and removal of stale state, verifies control status, stops gracefully, and proves both processes and runtime artifacts are gone.                                                                                          |
| Bounded definition/native content       | Definition reads accept exactly 65,536 bytes and reject sparse oversized or growing files before manager mutation. Launchd rejects lone surrogates and `U+FFFE`/`U+FFFF` before XML publication while preserving valid astral Unicode. Restrictive-umask publication failures remove only the exact temporary inode.                                                                                      |
| Hard shutdown and durable test boundary | A forced shutdown result resolves at its configured deadline even with permanently pending close/release. Best-effort finalization remains socket close → exact lock release → umask restore and leaves later resources fail-closed if a predecessor never settles. A temporary test double fsyncs an `INTERRUPTED` marker and its parent publication before later stages; production remains pending #1. |
| Repeated/interleaved control lifecycle  | Repeated and interleaved `stopAccepting`, `drain`, and `close` calls are idempotent, share close completion where applicable, contain detached rejections, preserve replacement-race safety, and leave no owned socket or publication artifact.                                                                                                                                                           |
| Package and capability exactness        | The packaged `runtime-capabilities.v1` example is parsed through the public API against the exact ordered baseline schema list. Package content/destination probes enforce the 178-file manifest, public contract inclusion, evidence exclusion, inherited destination isolation, scripts-disabled installation, and full cleanup.                                                                        |

## Issue #28 acceptance map

| Acceptance criterion                                                                                | Verified foundation state                         | Evidence and remaining gate                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service activates only through explicit install/start; package installation alone starts no daemon. | Deterministic boundary verified; integration open | Exact command-array tests prove install has no current-session start/bootstrap and start is separate. The explicit prepack transcript proves its contents-only path. Actual manager enablement/login behavior remains platform-integration pending.                                          |
| A second supervisor for the same user fails closed.                                                 | Verified directly                                 | Installed-package smoke starts a second direct `serve`, requires exit `6` and `RUNTIME_SERVICE_ALREADY_RUNNING`, and proves the first temporary instance remains healthy. Claim/stage recovery preserves active, unknown, or conflicting ownership.                                          |
| Other users cannot read or write the socket.                                                        | Filesystem boundary verified                      | Real temporary filesystem/socket tests and installed smoke require current-user ownership, `0700` runtime/lock directories, and `0600` socket/owner/claim/stage files before readiness. Complete ancestry and bigint identity checks preserve fail-closed cleanup.                           |
| Automatic startup after login is verified on macOS and Linux.                                       | Platform integration pending                      | Deterministic `RunAtLoad`/enable definitions, exact shell-free commands, and local plist syntax passed. Actual automatic activation in real login sessions has not been observed; Linux native syntax also awaits a Linux job.                                                               |
| Stop/restart drains within the deadline and unfinished work is durably recorded as `INTERRUPTED`.   | Deadline/order verified; production pending #1    | Pending-finalizer and startup-unwind tests prove bounded results and fail-closed order. A filesystem-backed test double fsyncs `INTERRUPTED` before later stages. Production persistence remains pending issue #1.                                                                           |
| Crash loops produce bounded backoff and `doctor` provides actionable diagnosis.                     | Direct restart/status policy verified             | Direct SIGKILL/restart smoke proves stale-runtime reclamation. Linux t0..t35 policy retains one interval after the 30-second threshold; `Result=start-limit-hit` yields `backoff:true` and doctor `FAIL`. Actual native-manager crash-loop observation remains platform-integration pending. |
| Uninstall does not delete canonical project/run artifacts.                                          | Verified in temporary roots                       | Tests prove uninstall removes only compatible manager state/definition while preserving config, journals, registry, pending intake, logs, canonical artifacts, and any untrusted definition replacement.                                                                                     |
| launchd/systemd unit tests and platform smoke tests exist.                                          | Deterministic/local host pass; integration open   | Both renderers and command arrays are tested; local `plutil` and direct installed supervisor crash/restart/signal smoke passed. Linux `systemd-analyze` awaits a Linux job. Real launchd/systemd manager activation and crash-loop integration were not exercised.                           |

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
