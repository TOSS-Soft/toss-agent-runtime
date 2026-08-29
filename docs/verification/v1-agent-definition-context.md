# v1 Agent Definition and Context Acceptance Evidence

## Scope and binding

This record covers the immutable agent-definition registry and
provenance-aware context compiler for Issue #7. It binds the clean,
evidence-free publishable preparation
`cea399c1726171e5153ed7232f71fa23949700ca`, verified on 2026-08-30.

The preparation follows integrated head
`a5c3cf230d0496405b5a85f887f66ef0238c88d4`, which contains:

- the reviewed macOS Latest Node.js LTS policy merged into
  `release/v1.0.0` as `3359d2966efad0f4d108ab1054aaaad5275d28e0`;
- Issue #50 package declaration verification stabilization;
- Issue #52 context permutation verification stabilization; and
- all previously reviewed Issue #7 implementation and recovery fixes.

Preparation commit `cea399c` deletes only the stale evidence document. The
npm package intentionally excludes this repository evidence. No tag, npm
publication, or GitHub Release is claimed.

## Environment

| Item             | Verified value                                   |
| ---------------- | ------------------------------------------------ |
| Date             | `2026-08-30`                                     |
| Publishable prep | `cea399c1726171e5153ed7232f71fa23949700ca`       |
| Integrated head  | `a5c3cf230d0496405b5a85f887f66ef0238c88d4`       |
| Release policy   | `3359d2966efad0f4d108ab1054aaaad5275d28e0`       |
| Runtime          | Node `v24.20.0` LTS (`Krypton`); npm `11.18.0`   |
| OS/architecture  | macOS `26.6.1` / `arm64`                         |
| Package          | `@toss-software/agent-runtime@0.0.0-development` |

No username, home-directory path, environment value, credential, provider
configuration, secret, socket path, PID, claim owner, or temporary path is
recorded.

## Exact clean-prep verification

The runtime was selected independently of the host default and matches the
repository's automatically advancing `lts/*` plus `check-latest: true` policy.
The exact command form was:

```sh
npm exec --yes --package=node@24.20.0 --package=npm@11.18.0 -- sh -c 'node --version; node -p "process.release.lts"; npm --version; npm ci; npm run verify; npm audit --omit=dev --audit-level=high'
```

It exited `0` with these results:

| Stage                       | Result                                                       |
| --------------------------- | ------------------------------------------------------------ |
| Fresh install               | 138 packages; install audit 0 vulnerabilities                |
| Runtime identity            | Node `v24.20.0`; LTS codename `Krypton`; npm `11.18.0`       |
| Format/lint/typecheck       | Passed                                                       |
| Full test suite             | 56 files; 1,852 passed; 1 host-conditional skip; 1,853 total |
| Build                       | Passed                                                       |
| Scripts-enabled package     | Exact 391-file inventory passed                              |
| Installed consumer          | Imports, examples, CLI, service, and cleanup checks passed   |
| Production dependency audit | 0 vulnerabilities                                            |

The sole full-suite skip was
`native service definition validation > passes native systemd unit validation`,
which is Linux-only and therefore skipped on the supported macOS host. The
Darwin native validator ran in the complete suite. No Issue #7 test skipped.

Two focused Latest-LTS gates also exited `0`:

- authority, context, contracts, integration, registry, public API,
  documentation integrity, generic protocol validation, package metadata, and
  Node policy: 9 collected files, 274/274 passed, no skip;
- all seven `test/agent-*.test.ts` suites: 313/313 passed, no skip.

## CI stabilization and remote acceptance

Issue #50 retains the complete package declaration and dry-pack assertions but
gives that intentional build workload a bounded 30-second test limit. Issue #52
retains all 100 caller permutations and byte-identical assertions with the same
bounded per-test limit. Neither change touches production code.

Issue #52's controlled TDD witness failed under the inherited 5-second default
at 5.009 seconds, then passed the same artificial 6-second workload with the
bounded limit in 7.12 seconds. The artificial delay was removed; the real target
passed 20/20 consecutive Latest-LTS executions and the complete context file
passed 74/74.

The exact integrated stacks passed their sole macOS Latest Node.js LTS PR jobs:

- Issue #52 / PR #55: 3m17s,
  <https://github.com/TOSS-Soft/toss-agent-runtime/actions/runs/33276818181>;
- Issue #50 / PR #51 after #52 integration: 2m06s,
  <https://github.com/TOSS-Soft/toss-agent-runtime/actions/runs/33276991972>.

Both issues and PR project items were marked Done and both issues closed before
their PRs merged, following the v1.0.0 delivery status contract.

## Package and installed-consumer evidence

The complete verifier performs a real scripts-enabled `npm pack`. Its prepack
lifecycle runs formatting, lint, typecheck, build, and contents-only package
acceptance. The tarball is installed with scripts disabled into an owned
temporary consumer.

The installed consumer proves package-root imports and private deep-import
exclusion; parses and hash-checks the canonical definition, request, and final
compiled-context examples; checks executable mode, help, version,
capabilities, and installed manifest; exercises private service state,
control, duplicate serve, SIGKILL recovery/restart, SIGTERM and SIGINT
shutdown, and safe missing-config failure; then reaps its processes and
artifacts.

The scripts-enabled metadata capture produced:

| Item             | Exact value                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Filename         | `toss-software-agent-runtime-0.0.0-development.tgz`                                               |
| Packed files     | 391                                                                                               |
| Packed size      | 374,531 bytes                                                                                     |
| Unpacked size    | 2,186,189 bytes                                                                                   |
| npm SHA-1 shasum | `82c146479bf1b98153e9f42d93744429c47262ff`                                                        |
| SHA-256          | `9ec5543bbdd3a619a441d663a1aa48f409c374fdf47884010c75921da0c57b45`                                |
| npm integrity    | `sha512-NfhKxm71jaHTAvwKjJ7VwkZatnQt/HsjopR+qyvPifW5F7Gt0Y889UxL3GZ8hCl+d6svDGraRsveMZvC4thOwg==` |

All paths match `scripts/package-files.json` exactly. The report explicitly
omits `docs/verification/v1-agent-definition-context.md`. The explicit tarball
was created outside the repository in an operation-owned temporary directory,
hashed, and removed.

## Issue #7 acceptance matrix

| Issue #7 acceptance criterion                                                                                 | Exact current test coverage                                                                                                                                                                             | Result |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Agent definition is separate from model/provider identity.                                                    | `test/agent-contracts.test.ts` provider/route/endpoint/model rejection; `test/agent-authority.test.ts` logical-class authority rejection                                                                | Pass   |
| Execution uses only an ACTIVE agent matching the Task Contract and allowed capability envelope.               | `test/agent-registry.test.ts` active/resume revision boundaries; `test/agent-authority.test.ts` Task Contract and model/Superpowers capability matrices                                                 | Pass   |
| Every canonical context input binds exact artifact type, ID, revision, hash, content, and producer semantics. | `test/agent-authority.test.ts` exact reference-identity matrix; `test/agent-context.test.ts` re-signed Task Contract, output schema, input artifact, prompt block, and segment-ID substitution matrices | Pass   |
| Untrusted content cannot become instruction or authority.                                                     | `test/agent-contracts.test.ts` trust relabel rejection; `test/agent-context.test.ts` injection-shaped repository input structure; `test/agent-integration.test.ts` malicious worker/reviewer inputs     | Pass   |
| Overflow uses deterministic canonical truncation.                                                             | `test/agent-context.test.ts` Unicode boundaries, 100 caller permutations, ordering, mixed-reason, byte accounting, and attribution rejection                                                            | Pass   |
| Definition or prompt changes create new revisions and prior runs remain immutable.                            | `test/agent-registry.test.ts` lifecycle/replay/conflict coverage; `test/agent-integration.test.ts` byte-exact revision-1 replay after revision 2                                                        | Pass   |
| Cross-role authority/context injection is tested.                                                             | `test/agent-authority.test.ts` role rejection; `test/agent-integration.test.ts` shared malicious repository bytes remain untrusted across worker and reviewer roles                                     | Pass   |

The retained mutation-witness tests cover authority subset, ACTIVE/resume,
source hash, trust class, trusted overflow, Unicode truncation, object identity,
operation replay, and final document hash. This refresh did not mutate product
sources; every owning test ran in the fresh complete or focused gates.

## Final context and registry closure

The public compiled-context parser rejects re-signed substitutions of Task
Contract, output schema, input artifact, every prompt block, and arbitrary
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

Node provides no conditional unlink-by-inode primitive. Operation-owned cleanup
therefore atomically moves the exact validated entry to an unguessable
same-directory tombstone, validates identity, and performs final validation plus
`unlinkSync` consecutively with no hook or await boundary. Eliminating the
remaining syscall-sized same-UID pathname interval would require an audited
native fd-relative primitive; the approved threat model retains this documented
limitation.

## Hygiene, topology, and remaining gates

Before writing this evidence, the repository and operation-owned temporary
state were checked for tarballs, objects, stages, tombstones, mutation claims,
Unix sockets, service locks, package roots, and matching service processes. The
tracked preparation was clean.

The required `cea399c..evidence-head` diff adds exactly this one file, with no
production, schema, test, package, example, workflow, or public-contract change.
The package remains `0.0.0-development` and unpublished.

Linux systemd syntax is intentionally outside the macOS v1.0.0 host boundary.
Skills, MCP execution, provider execution, the bounded agent loop, protected
live-provider acceptance, version `1.0.0`, tagging, and publication remain
separate release gates.
