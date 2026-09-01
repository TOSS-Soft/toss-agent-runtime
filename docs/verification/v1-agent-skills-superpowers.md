# v1 Agent Skills and Superpowers Acceptance Evidence

## Scope and commit binding

This record covers the Issue #8 Agent Skills host and built-in Superpowers
execution boundary. It verifies the evidence-free publishable prep commit
`cbd69d301031e9045e56ad9c3ec324baf3657682` on 2026-09-01. That commit was
tracked-clean, contained no `docs/verification/v1-agent-skills-superpowers.md`,
and had no repository tarball, socket, transaction stage, claim, lock, or live
repository process when acceptance began.

The exact release base is
`9978d546e73279d7397bc0ad66459cce7dd9e12d`. The verified prep is its linear
42-commit descendant with zero merge commits. The first Issue #8 commit is
`c57b9255d5f07ae756025d17fa9ec5119b2125a6`; the last prep commit is
`cbd69d301031e9045e56ad9c3ec324baf3657682`.

The direct child of the prep commit containing only this file is the
evidence-only head. Its SHA is intentionally recorded outside this document to
avoid a circular commit identity. This repository evidence is excluded from
the npm package; package content is therefore bound to the evidence-free prep.

No remote CI result, pull request, issue closure, merge, release tag, GitHub
state, or npm publication is claimed here.

## Environment

- Official distribution index resolution: first release with `lts != false`
  was Node `v24.20.0`, codename `Krypton`, bundled npm `11.19.0`.
- Runtime assertions: `process.release.lts === "Krypton"`, Node `v24.20.0`, npm
  `11.19.0`.
- Host: macOS `26.6.1` build `25G76`, arm64.
- Package: `@toss-software/agent-runtime@0.0.0-development`.

Every Node/npm acceptance command used the resolved official Node
`v24.20.0-darwin-arm64` binary directory first in `PATH`. No Node Current,
older LTS, Linux, Windows, or version-matrix lane was run.

## Fresh acceptance from the evidence-free prep

All commands in this section exited `0` against the prep commit.

- `npm ci`: added 138 packages and audited 139 packages from the lockfile; npm
  reported 0 vulnerabilities. Its allow-scripts advisory identified the
  optional macOS dependency `fsevents@2.3.3`; it did not report executing that
  install script.
- `npm run verify`: formatting, ESLint, strict TypeScript checking, the full
  Vitest suite, build, and scripts-enabled installed-package acceptance passed
  without splitting or changing the checked-in worker/timeout configuration.
- Full Vitest result: 67/67 files passed; 2,274 tests passed; one test skipped;
  zero failed. Duration was 82.33 seconds.
- The sole skip was
  `test/service-definition-native.test.ts` — “passes native systemd unit
  validation,” guarded for Linux and inapplicable on this macOS host.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- Exact focused Agent Skills gate: 10/10 files and 334/334 tests passed; zero
  skipped and zero failed. Duration was 56.92 seconds.
- `git diff --check` and `git status --short`: no output after acceptance.

The focused gate was the exact planned set:

```text
test/skill-contracts.test.ts
test/skill-catalog.test.ts
test/skill-private-store.test.ts
test/skill-loader.test.ts
test/skill-context.test.ts
test/skill-phases.test.ts
test/skill-engine.test.ts
test/skill-approval.test.ts
test/skill-evidence.test.ts
test/skill-public-api.test.ts
```

## Package evidence

The full verification ran the real scripts-enabled `npm run test:package`
path. It completed exactly one scripts-enabled outer pack, installed the
tarball into a fresh project with install scripts disabled, and reported:

```text
Verified toss-software-agent-runtime-0.0.0-development.tgz (435 files)
```

A separate fresh scripts-enabled `npm pack --json` used an operation-owned
destination. Its prepack transcript passed exactly this checked-in chain:

1. `npm run format:check`;
2. `npm run lint`;
3. `npm run typecheck`;
4. `npm run build`, including clean and copied assets; and
5. `npm run test:package:contents`.

The nested contents-only probe reported exactly 435 files. npm then emitted
these package facts, and independent `stat`/`shasum` checks agreed with the npm
packed size and SHA-1:

- Filename: `toss-software-agent-runtime-0.0.0-development.tgz`
- File count: 435
- Packed size: 477,236 bytes
- Unpacked size: 2,826,239 bytes
- npm SHA-1: `0327f46fafb5358c522625e2f8d91b84105dd26b`
- SHA-256: `ec412860774fc9434c20195d98fae111f6827a2054ce379e2976fea22acaf549`
- npm SRI:
  `sha512-+yPNfddwBlJdXkijjsuG3iv5ZpSF678yAPM1pj7P3nzHRyoe1CR0PJm3Hf13ikC8/PUzWR5TajUk0sDj5phIYg==`

The installed-package acceptance proved the exact allowlist and required
files; strict TypeScript compilation of the public Agent Skills consumer; the
five bundled skill names; bundled discovery, exact selection, and loading;
parse/hash closure for all five published Agent Skills examples; blocked
private skill deep imports; and a declaration graph without private stores,
hooks, native paths, or test seams. It also exercised installed CLI
help/version/capabilities, canonical contract manifests, executable-mode
enforcement, safe missing-config output, private runtime/socket/lock modes,
duplicate-service rejection, SIGKILL crash-state reclamation and restart,
real socket status, graceful SIGTERM/SIGINT, durable stop logging, cleanup, and
process reaping.

The evidence tarball was moved from its operation-owned directory to the
user's Trash under a collision-safe name. The pack directory, decoy inherited
pack destination, installed-package directory, and all package-test temporary
state were absent after the command.

## Approval, restart, and evidence witnesses

The green full and focused suites include these real behavior witnesses:

- `BRAINSTORMING` reaches a durable `APPROVAL_PENDING` record before returning
  control; it does not report fake completion.
- The authenticated private Unix socket carries one exactly bound approval
  decision, advances exactly one journal transition, rejects a response that
  skips that transition, and byte-replays the completed response.
- Restart reconstructs the byte-identical approval challenge without growing
  phase or journal history. Every tested two-file crash cut converges to the
  same pause or decision and never auto-approves.
- Exact APPROVE/REJECT replay is idempotent; stale heads, changed skill/phase
  identities, changed operation IDs, re-signed conflicting documents, and
  orphan/duplicate journal-to-phase projections fail closed.
- The public evidence builder and independent parser accepted a canonical
  25-approval history containing one complete real durable host approval
  transaction plus 24 additional canonical transactions built through the
  production phase, approval, and journal constructors. The checked-in
  assertion retained exactly 25 projected approvals and the unchanged 2 MiB
  evidence envelope.

## Mutation and fail-closed witnesses

The focused gate passed the checked-in adversarial witnesses for:

- descriptor, manifest, snapshot, phase, approval, context, catalog, journal,
  evidence, and document-hash mutations;
- absolute paths, traversal, symlink ancestry, hard links, ownership/mode/link
  violations, undeclared/missing resources, replacement races, partial stages,
  claims, tombstones, and conflicting recovery artifacts;
- caller mutation after exact selection or context acceptance, including
  top-level fields and a nested snapshot; accepted work retained the captured
  authority while post-stop work failed closed;
- accessor, proxy, hidden/symbol, sparse, cyclic, extra-field, and over-limit
  public configuration authority without invoking active properties;
- an authorized configured package declaring `external-scripts`, and one
  declaring an unknown future runtime capability: repeated context, load, and
  phase requests returned their closed errors before source/state mutation,
  private publication, stage/claim creation, process execution, or loopback
  network activity;
- a script resource without a declared execution dependency remaining inert,
  hash-bound, loadable, context-assemblable, and usable by the built-in phase
  without creating its process witness; and
- private-root and environment sentinels remaining absent from recursively
  frozen public results, with no native handle or private body-store exposure.

The loader test additionally passed its direct process witness that script
resources are hashed but never executed, imported, evaluated, or spawned.

## Capability and authority result

The accepted package exposes a self-contained safe Agent Skills root API and
the exact built-in phases `BRAINSTORMING`, `TEST_DESIGN`, `RED`, `GREEN`,
`DEBUGGING`, `REVIEW`, and `VERIFICATION`. Production discovery is limited to
explicitly configured private per-user roots and the audited bundled manifest.
Project-local roots are not discovered implicitly. Required unavailable
capabilities fail closed, and external script execution remains unavailable.

TOSS CLI and its authoritative artifacts still own task assignment, allowed
and required capabilities, human decisions, governance state, and acceptance.
The runtime cannot grant itself a skill, approve its own pause, widen an agent
definition, or accept its own output.

## Known non-goals and downstream ownership

- Issue #10 owns the provider-neutral model/turn execution loop.
- Issue #9 owns MCP/tool discovery, tool approvals, and side-effect
  idempotency.
- Issue #11 owns independent worker/reviewer orchestration and findings
  acceptance.
- Issues #12 and #13 own release-wide evidence aggregation and hardening.
- Linux/Windows support, remote skill registries, dynamic installation,
  automatic repository-local discovery, arbitrary skill-script execution, and
  a production script sandbox are outside Issue #8.
- Real launchd/systemd user-manager installation and login-session/crash-loop
  integration are not claimed by this acceptance.
- Package version `0.0.0-development`, tag/release creation, and npm `1.0.0`
  publication remain Issue #15 work.

## Post-write Step 6 integrity

The first exact Step 6 attempt began from the evidence-only head. Evidence
Prettier passed, followed by 2/2 documentation/package-metadata test files and
25/25 tests. The subsequent unsplit `npm run verify` passed repository-wide
formatting, ESLint, and strict TypeScript checking, then had one failure:

```text
test/serve-smoke.test.ts
"composes the production serve service with a real private supervisor"
timed out at 5.013 seconds against the checked-in 5-second boundary
Test Files  1 failed | 66 passed (67)
Tests       1 failed | 2273 passed | 1 skipped (2275)
Duration    94.26s
```

The sole test failure was that timeout. The sole skip remained the allowed
Linux-only native systemd validation on macOS. Teardown then reported
`ENOTEMPTY` on the operation-owned empty temporary state root. Inspection found
no live runtime, npm, or Vitest process and only empty `state/quarantine` and
`state/journals` directories. The exact empty owned directories and their
ancestors were removed with non-recursive `rmdir`; no broad path or unrelated
artifact was removed.

The first command sequence continued after the failed verify and actually ran
`npm audit --omit=dev --audit-level=high`, which reported 0 vulnerabilities.
That audit result did not make the failed attempt an acceptance pass.

Before rerunning, no production, test, package, configuration, timeout, worker,
or evidence content was changed. Tracked status/diff and process, socket,
stage, claim, lock, tarball, and operation-owned temporary-path scans were
clean. After controller authorization and a host lull, the entire exact Step 6
sequence was rerun from evidence Prettier onward with failure propagation
enabled. The unchanged rerun exited `0`:

- Evidence Prettier: passed.
- Documentation/package-metadata gate: 2/2 files and 25/25 tests passed;
  zero failed.
- Unsplit `npm run verify`: repository formatting, ESLint, strict typecheck,
  build, and installed-package acceptance passed.
- Full Vitest result: 67/67 files passed; 2,274 tests passed; the sole
  Linux-only systemd test skipped; zero failed. Duration was 74.97 seconds.
- Installed-package result:
  `Verified toss-software-agent-runtime-0.0.0-development.tgz (435 files)`.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- `git diff --check` and `git status --short`: no output.
- Final process/artifact hygiene: no live repository process, socket, stage,
  claim, tombstone, lock, tarball, or operation-owned task temporary directory.

The failed attempt is diagnostic history distinct from the final acceptance.
Only the complete unchanged green rerun satisfies Step 6.

## Artifact and process hygiene

Before evidence creation and after the final Step 6 rerun, `git diff --check`,
tracked/untracked status, and repository/process scans were clean. No `.tgz`,
socket, skill stage, claim, tombstone, lock, task temporary directory, live
`toss-runtime`, npm pack, Vitest, or verification process remained in the
worktree or operation-owned temporary locations. Ignored SDD reports were
preserved and are not part of this evidence commit.
