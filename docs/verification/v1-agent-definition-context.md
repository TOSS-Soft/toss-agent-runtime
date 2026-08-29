# v1 Agent Definition and Context Acceptance Evidence

## Scope and binding

This record covers the immutable agent-definition registry and
provenance-aware context compiler for Issue #7. It binds the clean,
evidence-free publishable preparation
`95f591be8975c3ba97330e2639e93951a674198a`, verified on 2026-08-29.

The preparation follows normal merge commit
`1a29cf570c843ff67899f127bcff5d56dcddc483`, whose parents are the previous
Issue #7 evidence head `b84f9f9226df0e63bf7203abb2e5a7ede52eabbd`
and `origin/release/v1.0.0` at
`23fbae9d20080c9f8267bc41e3bd3bf8649e953f`. The release parent contains the
reviewed Issue #48 test-only journal readiness fix
`b1270f7523c7b81ed34720fc244fa0f3afc000fa`. Preparation commit
`95f591b` then deletes only the stale evidence document.

The npm package intentionally excludes this repository evidence. No push,
pull request, issue mutation, tag, npm publication, GitHub release, or remote
CI result is claimed.

## Environment

| Item              | Verified value                                   |
| ----------------- | ------------------------------------------------ |
| Date              | `2026-08-29`                                     |
| Publishable prep  | `95f591be8975c3ba97330e2639e93951a674198a`       |
| Merge commit      | `1a29cf570c843ff67899f127bcff5d56dcddc483`       |
| Release parent    | `23fbae9d20080c9f8267bc41e3bd3bf8649e953f`       |
| Primary runtime   | Node `v22.23.1`; npm `11.18.0`                   |
| Compatibility run | Node `v24.19.0`; npm `11.18.0`                   |
| OS/architecture   | macOS `26.6.1` (`25G76`) / `arm64`               |
| Package           | `@toss-software/agent-runtime@0.0.0-development` |

No username, home-directory path, environment value, credential, provider
configuration, secret, socket path, PID, claim owner, or temporary path is
recorded.

## Exact clean-prep verification

Each runtime started with a fresh lockfile install. These exact command forms
were run from the preparation:

```sh
npx --yes --package=node@22.23.1 --package=npm@11.18.0 --call 'node --version && npm --version && npm ci && npm run verify && npm audit --omit=dev'
npx --yes --package=node@24.19.0 --package=npm@11.18.0 --call 'node --version && npm --version && npm ci && npm run verify && npm audit --omit=dev'
```

Both commands exited `0`.

| Stage                       | Node 22 result                                                  | Node 24 result                                                  |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Fresh install               | 138 packages; install audit 0 vulnerabilities                   | 138 packages; install audit 0 vulnerabilities                   |
| Format/lint/typecheck       | Passed                                                          | Passed                                                          |
| Full test suite             | 55 files; 1,850 passed; 1 host-conditional skip; 1,851 total    | 55 files; 1,850 passed; 1 host-conditional skip; 1,851 total    |
| Build                       | Passed                                                          | Passed                                                          |
| Scripts-enabled package     | Exact 391-file inventory passed                                 | Exact 391-file inventory passed                                 |
| Installed consumer          | Imports, examples, launcher, service, and cleanup checks passed | Imports, examples, launcher, service, and cleanup checks passed |
| Production dependency audit | 0 vulnerabilities                                               | 0 vulnerabilities                                               |

The sole full-suite skip was
`native service definition validation > passes native systemd unit validation`,
which is Linux-only and therefore skipped on this macOS host. The Darwin
native validator ran in the complete suite. No Issue #7 test skipped.

Two exact Node 22/npm 11.18 focused gates exited `0`:

- contracts, context, registry, integration, public API, documentation
  integrity, generic protocol validation, and package metadata: 8 files,
  243/243 passed, no skip;
- all seven `test/agent-*.test.ts` suites: 313/313 passed, no skip.

Documentation integrity plus package metadata also passed separately at
21/21. A separate contents-only package check returned exactly 391 files.

## Issue #48 journal readiness confirmation

The merged journal supervisor test
`journal supervisor > durably interrupts a running journal before a graceful serve shutdown completes`
passed in both complete runtime suites. It then passed 20/20 consecutive
focused executions on exact Node 22.23.1/npm 11.18.0. Across these 22 fresh
executions there was no journal readiness timeout or failure. This is local
acceptance evidence for the reviewed readiness fix, not a claim about remote
CI history.

## Mutation-witness coverage

Nine one-at-a-time mutations were applied to the preparation, each owning test
failed for the intended assertion, and each mutation was immediately restored
with the same test rerun green:

| Witness                | Exact owning test                                                                                                                       | Intended RED                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Authority subset       | `execution request authority matching > rejects extra disallowed model capability before any resolver can be called`                    | Extra capability was accepted.                                              |
| ACTIVE/resume boundary | `immutable agent lifecycle registry > activates revision 2, rejects revision 1 for execution, and retains revision 1 for resume`        | Stale revision resolved for execution.                                      |
| Source hash            | `provenance-aware agent context compilation > rejects resolved content whose canonical hash does not match its exact reference`         | Failure changed from exact reference mismatch to later integrity rejection. |
| Trust class            | `provenance-aware agent context compilation > keeps injection-shaped repository content structurally after every trusted segment`       | Untrusted input was relabeled and compilation failed its closure.           |
| Trusted overflow       | `provenance-aware agent context compilation > accepts trusted content whose UTF-8 bytes exactly fill the request input ceiling`         | Exact fit was incorrectly rejected as overflow.                             |
| Unicode truncation     | `provenance-aware agent context compilation > truncates ASCII, combining, Turkish, emoji, and four-byte scalars at every byte boundary` | The one-byte scalar exact fit truncated to empty.                           |
| Object identity        | `private agent object store > creates only hash-derived private roots and publishes current-user private objects`                       | Captured inode differed from the published file.                            |
| Operation replay       | `immutable agent lifecycle registry > publishes an exact bundle, replays its operation without history growth, and resolves it`         | Exact replay was rejected as a conflict.                                    |
| Final document hash    | `agent contract documents > rejects bad document and entry hashes`                                                                      | A mismatched document hash parsed successfully.                             |

No mutation survives: after the final restored GREEN, `git diff --check`,
`git diff --exit-code`, and `git status --short` were clean.

## Package and installed-consumer evidence

The complete verifier's package path performs a real scripts-enabled
`npm pack`. Its prepack lifecycle runs formatting, lint, typecheck, build, and
contents-only package acceptance. The tarball is installed with scripts
disabled into a fresh temporary consumer.

The installed consumer proves package-root imports and private deep-import
exclusion; parses and hash-checks the canonical definition, request, and final
compiled-context examples; checks executable mode, help, version,
capabilities, and installed manifest; exercises private service state,
control, duplicate serve, SIGKILL recovery/restart, SIGTERM and SIGINT
shutdown, and safe missing-config failure; then reaps its processes and
artifacts.

Fresh scripts-enabled metadata captures on both exact runtimes produced
byte-identical tarballs:

| Item             | Exact value                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Filename         | `toss-software-agent-runtime-0.0.0-development.tgz`                                               |
| Packed files     | 391                                                                                               |
| Packed size      | 374,531 bytes                                                                                     |
| Unpacked size    | 2,186,173 bytes                                                                                   |
| npm SHA-1 shasum | `7d1d30455702e4ac8e67d9fcd17636929144df65`                                                        |
| SHA-256          | `b0ecef0d174c5a2f118efc586dafe025a93dcea3353127e0b7b4a21137eca9c6`                                |
| npm integrity    | `sha512-N4wMba+v9lNTvctiDdvDuFlu8EhDVkcBs9K9bMlTgbGXO0WKp0KAuqkV1lyKTg5XMKBjOEjDgRmdZQtii2LMsw==` |

All paths match `scripts/package-files.json` exactly. The report explicitly
omits `docs/verification/v1-agent-definition-context.md`. Every explicit
tarball was created outside the repository in an operation-owned temporary
directory and removed immediately after hashing.

With this evidence document present, the exact Node 22 full verifier and
production audit were rerun. Formatting, lint, typecheck, the same
55-file/1,850-pass/one-skip suite, build, scripts-enabled installed-package
acceptance, and the zero-vulnerability audit all passed. A final real
scripts-enabled package reproduced the exact file count, sizes, SHA-1,
SHA-256, and SRI above while still excluding this document.

## Issue #7 acceptance matrix

| Issue #7 acceptance criterion                                                                                 | Exact current test file and title                                                                                                                                                                                                                                                                                                                                                    | Result |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Agent definition is separate from model/provider identity.                                                    | `test/agent-contracts.test.ts` — `agent contract documents > rejects provider, route, endpoint, and concrete-model identity in agent definitions`; `test/agent-authority.test.ts` — `execution request authority matching > rejects logical class before any resolver can be called`                                                                                                 | Pass   |
| Execution uses only an ACTIVE agent matching the Task Contract and allowed capability envelope.               | `test/agent-registry.test.ts` — `immutable agent lifecycle registry > activates revision 2, rejects revision 1 for execution, and retains revision 1 for resume`; `test/agent-authority.test.ts` — Task Contract plus missing/extra model and Superpowers capability tests                                                                                                           | Pass   |
| Every canonical context input binds exact artifact type, ID, revision, hash, content, and producer semantics. | `test/agent-authority.test.ts` — the exact reference-identity matrix; `test/agent-context.test.ts` — re-signed task-contract, output-schema, input-artifact, prompt-block, and segment-ID substitutions                                                                                                                                                                              | Pass   |
| Untrusted content cannot become instruction or authority.                                                     | `test/agent-contracts.test.ts` — `agent contract documents > rejects a hash-valid context that relabels input content as trusted`; `test/agent-context.test.ts` — `provenance-aware agent context compilation > keeps injection-shaped repository content structurally after every trusted segment`; `test/agent-integration.test.ts` — malicious bytes across worker/reviewer roles | Pass   |
| Overflow uses deterministic canonical truncation.                                                             | `test/agent-context.test.ts` — Unicode boundary matrix, 100 truncating permutations, same/cross-policy ordering, mixed-reason rejection, and wrong-attribution rejection                                                                                                                                                                                                             | Pass   |
| Definition or prompt changes create new revisions and prior runs remain immutable.                            | `test/agent-registry.test.ts` — definition/prompt revision reuse and operation replay/conflict tests; `test/agent-integration.test.ts` — `agent revision and context integration > replays revision 1 byte-exact after revision 2 becomes active`                                                                                                                                    | Pass   |
| Cross-role authority/context injection is tested.                                                             | `test/agent-authority.test.ts` — `execution request authority matching > rejects role before any resolver can be called`; `test/agent-integration.test.ts` — `agent revision and context integration > keeps shared malicious repository bytes untrusted across worker and reviewer roles`                                                                                           | Pass   |

The exact authority-reference matrix independently mutates document type,
artifact ID, revision, and hash for definition, Task Contract, MCP profile,
and output-schema references. The positive
`execution request authority matching > ignores location hints for every exact authority reference`
proves location is not an authority component. Capability coverage includes
missing required and extra disallowed model/Superpowers capabilities plus
duplicate requested capabilities.

## Final context and registry closure

The public compiled-context parser rejects re-signed substitutions of Task
Contract, output-schema, input-artifact, every prompt block, and arbitrary
segment identifiers. It also rejects prompt-block and input reordering,
missing/duplicate prompt blocks, mixed truncation reasons, and wrong
input-budget/definition-ceiling attribution. Prompt segments carry canonical
block IDs; every segment ID and the final document hash bind the closed
canonical allocation projection.

Registry tests cover validation-only post-stop reads, non-creating missing-tree
failures, flush-cut inclusion, partial-tail fail-closed behavior, restart-
idempotent lifecycle and operation recovery, exact history/quarantine
participant identity, active/resume lifecycle, replay/conflict, concurrency,
private modes, and shutdown. Real-filesystem coverage rejects sticky, setgid,
and setuid bits across owned directories, objects, stages, tombstones, and
mutation claims.

Node provides no conditional unlink-by-inode primitive. Operation-owned
cleanup therefore atomically moves the exact validated entry to an
unguessable same-directory tombstone, validates identity, and performs final
validation plus `unlinkSync` consecutively with no hook or await boundary.
Eliminating the remaining syscall-sized same-UID pathname interval would
require an audited native fd-relative primitive; the approved threat model
retains this documented limitation.

## Hygiene, topology, and external gates

Before this evidence-only change, repository and operation-owned temporary
state were checked for tarballs, objects, stages, tombstones, mutation claims,
Unix sockets, service locks, prompt artifacts, package roots, integration
roots, and matching test/service processes. The tracked preparation was
clean.

The required `95f591b..evidence-head` diff adds exactly this one file, with no
production, schema, test, package, example, or public-contract change. The
package remains `0.0.0-development` and unpublished.

Linux systemd syntax was not validated on this macOS host. Remote CI,
controller acceptance, issue/PR state changes, tagging, and publication remain
external delivery gates and are not claimed by this record. Skills, MCP
execution, provider execution, model routing, and agent-loop orchestration
remain separate scopes.
