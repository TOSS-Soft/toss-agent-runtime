# v1 Wave 2 Service Foundation Acceptance Evidence

## Scope and binding

This record covers the implemented per-user local service foundation for issue
#28. It verifies evidence-free publishable prep commit
`4ae673f260c5d49d58f7ffcb5733bffa36af2032` on 2026-08-20. That commit was
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
| Publishable commit | `4ae673f260c5d49d58f7ffcb5733bffa36af2032`       |
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
| Vitest                      | 19 files passed; 470 tests passed and 1 host-conditional test skipped (471 total).                                                                                                                                                                                   |
| Build/full package smoke    | Build exited `0`; exact 178-file package acceptance proved the scripts-enabled contents-only prepack boundary, installed launcher, private socket/lock, duplicate instance, SIGKILL recovery/restart, status, graceful SIGTERM/SIGINT, cleanup, and process reaping. |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` exited `0` with 0 vulnerabilities.                                                                                                                                                                                         |
| `service status --json`     | One canonical successful result, exit `0`: absent service reported `installed:false`, `enabled:false`, `active:false`, `backoff:false`, zero restarts, and no socket status.                                                                                         |
| `doctor --json`             | One canonical successful result, exit `0`: package, platform, and default configuration passed; absent service and unavailable execution capabilities were development WARN checks; `healthy:true`.                                                                  |

The Linux status regression separately feeds the exact terminal manager output
`ActiveState=failed`, `SubState=failed`, and `Result=start-limit-hit`. Status
remains a successful data query with `backoff:true`; the service check in
`doctor` is `FAIL` with safe remediation and doctor exits `5`. The exact
shell-free query includes `Result`:

```text
/usr/bin/systemctl --user show toss-agent-runtime.service --property=LoadState,UnitFileState,ActiveState,SubState,Result,NRestarts,ExecMainStatus --no-pager
```

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
metrics and SHA-256 bytes:

| Item             | Value                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Filename         | `toss-software-agent-runtime-0.0.0-development.tgz`                                               |
| Packed files     | 178                                                                                               |
| Packed size      | 117,795 bytes                                                                                     |
| Unpacked size    | 634,740 bytes                                                                                     |
| npm SHA-1 shasum | `aa5126e84aea78dae08373f0f0a17e56d27680b4`                                                        |
| npm integrity    | `sha512-ZNT+uTdF2HfmS9Km+2HaS0Arq181mKz3j5FPP2YS1f8M5nLeCJc9ymN3vTGmZY4HAxUoRon0tkgEEOub7t6CfQ==` |
| SHA-256          | `ba49a9c7d15b155f7002149c9696077f2b823e60879b7da3f6fa04392855bc3c`                                |

The 178 paths matched `scripts/package-files.json` exactly and include the
public local-service contract. They exclude tests, SDD material, this
verification document, service definitions, state, sockets, and locks. Each
explicitly generated tarball was moved to a collision-safe Trash name and its
empty operation-owned destination was removed after recording. No tarball was
written to the repository root.

Final cleanup probes found no stage, owner/ownerless claim, publication guard
or claim, package/supervisor temporary root, `.tgz`, Unix socket,
`instance.lock`, `runtime.sock`, or matching `toss-runtime ... serve` process.
No launchd/systemd user manager was mutated.

## Current regression map

The acceptance above includes every whole-branch regression added after the
prior evidence binding.

| Regression                                      | Current verified behavior                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restart/recovery schedule                       | The exported ownerless-lock threshold remains exactly 30 seconds. Linux keeps `RestartSec=5s` and `StartLimitIntervalSec=60s` with `StartLimitBurst=8`, admitting attempts at t0, t5, t10, t15, t20, t25, t30, and t35. A deterministic test makes the exact t30 boundary miss and acquires at t35, retaining one complete restart interval of margin. Launchd remains unchanged.                                      |
| Durable lock removal                            | Every unlink whose lock directory remains is followed by fsync on the already held lock-directory descriptor, then removal-context and exact-entry revalidation. After successful `instance.lock` rmdir, the exact runtime parent is opened directory-only and no-follow, compared to its saved bigint identity, fsynced, descriptor/path metadata and identity revalidated, and only then may acquire/release finish. |
| Terminal systemd start-limit result             | The exact status query requests `Result`; `Result=start-limit-hit` sets `backoff:true` even when both active and substate are `failed`. Status returns data successfully, while the doctor service check becomes `FAIL`, emits fixed remediation, and exits `5` without reflecting manager output.                                                                                                                     |
| Bounded runtime configuration                   | `.json`, `.yaml`, and `.yml` use one held, no-follow regular-file descriptor and a fixed 2 MiB (2,097,152-byte) bound. Exact-cap valid files are accepted; an observed or post-validation read of cap plus one byte is rejected as `RUNTIME_CONFIG_INVALID`. Oversized install fails before manager creation/mutation and oversized serve fails before hashing, signal subscription, readiness, or supervisor startup. |
| Canonical bounded lock claims                   | Interrupted owner and ownerless removal uses a private, canonical, closed `service-lock-claim.v1` document bounded by the 64 KiB control-message ceiling. Owner claims bind claimant plus displaced original owner; ownerless claims bind claimant plus the original stale timestamp. Duplicate, noncanonical, malformed, replaced, extra, or conflicting entries remain blocked.                                      |
| Atomic lock-document publication                | Owner, owner-claim, and ownerless-claim documents first occupy a claimant-bearing `0600` stage. Empty, partial, fully synced, and linked-stage states are tested. A final name appears only after complete canonical bytes are file-synced, then published without overwrite by hard link and followed by lock-directory sync; exact stage/final bytes and bigint inode identity are revalidated before cleanup.       |
| Conservative lock recovery                      | Strict stage and final claim states recover only when required claimant/original processes are dead, chronology is compatible, no socket listener accepts, private metadata/entries are exact, and held/path bigint identities remain unchanged. Live or unknown liveness, active/conflicting listener identity, malformed or multiple state, replacement, or ownership ambiguity fails closed and preserves evidence. |
| Lock prevalidation and path trust               | New artifact IDs must use the exact lowercase UUID grammar and clocks must be nonnegative before lock-state creation; owner/claim chronology is checked before staging. Root-owned leading ancestors are accepted only when non-writable or sticky, while writable non-sticky roots are rejected. Runtime, lock, owner, stage, and claim identities use lossless bigint device/inode values.                           |
| SIGKILL publication-guard reclamation/restart   | Installed smoke reaches readiness, kills the first direct supervisor with SIGKILL, observes its recoverable guard/socket/lock state, starts a replacement, requires a new full-hash guard and removal of stale state, verifies status, stops gracefully, and proves both processes and all runtime artifacts are gone.                                                                                                 |
| Safe control-publication claims                 | Startup recognizes legacy guards, full-hash guards, and interrupted claims only after acquiring the lock; it atomically claims and revalidates exact private empty artifacts, preserves replacements, and fails closed on unsafe entries.                                                                                                                                                                              |
| Bounded definition reads                        | Exactly 65,536 definition bytes are accepted. Sparse oversized files and files that grow after descriptor validation are rejected with a stable safe failure before native manager mutation.                                                                                                                                                                                                                           |
| Restrictive-umask temporary cleanup             | If a restrictive umask prevents the definition-store temporary inode from meeting exact mode `0600`, publication fails safely and removes only that exact temporary inode.                                                                                                                                                                                                                                             |
| XML-invalid Unicode                             | Launchd rendering rejects lone high/low surrogates and `U+FFFE`/`U+FFFF` before XML publication, while valid astral Unicode remains encoded and preserved.                                                                                                                                                                                                                                                             |
| Packaged capability example                     | The packaged `runtime-capabilities.v1` example is parsed through the public API and is asserted against the exact ordered baseline schema-version list, preventing omitted or reordered supported schemas.                                                                                                                                                                                                             |
| Hermetic package destination                    | Contents-only and scripts-enabled pack paths strip inherited underscore/hyphen and case variants, use fresh explicit destinations, validate the local basename, and leave the caller destination, repository root, and all operation-owned pack/install roots free of tarballs.                                                                                                                                        |
| Exact bigint control identities                 | Runtime directory, socket, guard, claim, and file-handle comparisons use lossless bigint device/inode values. A regression fails closed for identities that would collapse to the same JavaScript number.                                                                                                                                                                                                              |
| Repeated/interleaved control lifecycle          | Repeated and interleaved `stopAccepting`, `drain`, and `close` calls are idempotent, share close completion as applicable, preserve replacement-race safety, and leave no owned socket/publication artifact.                                                                                                                                                                                                           |
| Hard shutdown outcome and durable test boundary | A forced result resolves at the configured deadline even with pending close/release, while cleanup remains socket-close → exact-lock-release → umask-restore and fail-closed when a predecessor never settles. A temporary `INTERRUPTED` marker and its parent publication are fsynced before later stages in tests; production remains pending #1.                                                                    |

The runtime-parent open in the durable-removal row uses the exact flag pair
`O_DIRECTORY|O_NOFOLLOW` before bigint identity validation and fsync.

## Issue #28 acceptance map

| Acceptance criterion                                                                                | Verified foundation state                           | Evidence and remaining gate                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service activates only through explicit install/start; package installation alone starts no daemon. | Deterministic boundary verified; integration open   | Exact command-array tests prove install has no current-session start/bootstrap and start is separate. The explicit prepack transcript proves its contents-only path. Actual manager enablement/login behavior remains platform-integration pending.                                                                                             |
| A second supervisor for the same user fails closed.                                                 | Verified directly                                   | Installed-package smoke starts a second direct `serve`, requires exit `6` and `RUNTIME_SERVICE_ALREADY_RUNNING`, and proves the first temporary instance remains healthy. The authenticated claim/stage recovery state machine preserves active, unknown, or conflicting ownership.                                                             |
| Other users cannot read or write the socket.                                                        | Filesystem boundary verified                        | Real temporary filesystem/socket tests and installed smoke require current-user ownership, `0700` runtime/lock directories, and `0600` socket/owner/claim/stage files before readiness. Root ancestry policy, exact entry checks, no-follow descriptors, and bigint identity comparison prevent broadened deletion or lossy replacement checks. |
| Automatic startup after login is verified on macOS and Linux.                                       | Platform integration pending                        | Deterministic `RunAtLoad`/enable definitions, exact shell-free commands, and local plist syntax passed. Actual automatic activation in real login sessions has not been observed; Linux native syntax also awaits a Linux job.                                                                                                                  |
| Stop/restart drains within the deadline and unfinished work is durably recorded as `INTERRUPTED`.   | Deadline/order verified; production pending #1      | Pending-finalizer tests prove the forced outcome deadline and fail-closed order. A filesystem-backed test double fsyncs `INTERRUPTED` before later stages. Production persistence remains pending issue #1.                                                                                                                                     |
| Crash loops produce bounded backoff and `doctor` provides actionable diagnosis.                     | Direct restart/status policy verified               | Direct SIGKILL/restart smoke proves stale-runtime reclamation. Linux's bounded t0..t35 policy retains one retry interval after the 30-second empty-lock threshold; terminal `Result=start-limit-hit` yields `backoff:true` and doctor `FAIL`. Actual native-manager crash-loop observation remains platform-integration pending.                |
| Uninstall does not delete canonical project/run artifacts.                                          | Verified in temporary roots                         | Tests prove uninstall removes only compatible manager state/definition while preserving config, journals, registry, pending intake, logs, and canonical artifacts.                                                                                                                                                                              |
| launchd/systemd unit tests and platform smoke tests exist.                                          | Deterministic/local host pass; remaining gates open | Both renderers and command arrays are tested; local `plutil` and direct installed supervisor crash/restart/signal smoke passed. Linux `systemd-analyze` awaits a Linux job. Real launchd/systemd manager activation and crash-loop integration are not exercised here.                                                                          |

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
