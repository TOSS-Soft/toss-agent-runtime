# v1 Wave 1 Acceptance Evidence

## Scope and state

This record covers Runtime Contract Protocol v1 (#2) and the package/CLI/daemon/CI baseline (#4). It verifies commit `9cd153673d9c8a738d8b27c80c483315e338be4f` on 2026-08-19 before this evidence-only commit was updated.

Local acceptance is complete. GitHub Actions run [32244157742](https://github.com/TOSS-Soft/toss-agent-runtime/actions/runs/32244157742) passed the required Node 22/24 macOS/Linux matrix against evidence head `ce72c39932a23be96a08f4eea0c86a701c40d423`. Issues MUST NOT close until the pull request merges. This record is internal repository evidence and is intentionally excluded from the npm package; public contract documentation remains under `docs/contracts`.

## Environment

| Item            | Verified value                                   |
| --------------- | ------------------------------------------------ |
| Node.js         | `v22.23.1`                                       |
| npm             | `11.18.0`                                        |
| OS/architecture | macOS / arm64                                    |
| Package         | `@toss-software/agent-runtime@0.0.0-development` |

No environment variables, credentials, provider configuration, usernames, or home-directory paths are recorded.

## Command evidence

All commands below exited `0` against the verified commit.

| Command                                        | Result                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `git status --short`                           | Clean before acceptance                                                                                               |
| `npm ci`                                       | 138 packages installed from lockfile; audit reported 0 vulnerabilities                                                |
| `npm run verify`                               | Formatting, lint, strict typecheck, 11 test files / 119 tests, build, and installed-package test passed               |
| `npm audit --audit-level=high`                 | 0 vulnerabilities                                                                                                     |
| `node bin/toss-runtime.js --version`           | `0.0.0-development`                                                                                                   |
| `node bin/toss-runtime.js capabilities --json` | Valid `command-result.v1`; protocol v1 advertised and all future subsystems truthfully `unavailable`                  |
| `node bin/toss-runtime.js doctor --json`       | Package, Node/OS, and default config passed; unavailable execution features reported as a warning; no secrets emitted |

CI defines the same locked verification plus production dependency audit for Node `22.23.1` and Node `24` on Ubuntu and macOS in `.github/workflows/ci.yml`. All four jobs passed in GitHub Actions run `32244157742`.

## Package evidence

| Item          | Value                                                              |
| ------------- | ------------------------------------------------------------------ |
| Filename      | `toss-software-agent-runtime-0.0.0-development.tgz`                |
| Packed files  | 131                                                                |
| Packed size   | 50,133 bytes                                                       |
| Unpacked size | 248,515 bytes                                                      |
| SHA-256       | `f1661a328229f782d7192429e0f7384cbd0e849dfcf385f8a0ed86375bd9943a` |

`scripts/package-test.mjs` independently creates the tarball, compares every path to the committed exact package manifest, rejects test/fixture/credential-shaped paths, installs into a new temporary project, imports the public API, runs help/version/capabilities, waits for explicit readiness before sending real SIGTERM and SIGINT to installed `serve` processes, verifies safe missing-config output, reads the installed contract manifest, and removes its temporary artifacts.

## Issue #2 acceptance map

- [x] Normative Runtime Contract Protocol v1 document and JSON Schemas exist: `docs/contracts/runtime-contract-protocol-v1.md`, `docs/contracts/runtime-contract-v1.manifest.json`, `contracts/runtime/*.schema.json`, and `test/documentation-integrity.test.ts`.
- [x] Every request carries exact Task Contract and ACP artifact references: `contracts/runtime/execution-request.v1.schema.json`, `src/protocol/request.ts`, `test/execution-request.test.ts`, and `examples/runtime-contract-v1/execution-request.json`.
- [x] The runtime can produce execution evidence but cannot change TOSS authority/acceptance state: normative trust boundary sections in `docs/contracts/runtime-contract-protocol-v1.md`, compatibility/acceptance handling in `docs/contracts/toss-cli-v2.2-compatibility.md`, and the authority-shaped rejection fixture `test/fixtures/protocol/invalid/request-authority.json`.
- [x] Unknown protocol, schema, model capability, feature availability, missing supporting provider/skill resources, and exact MCP profile fail closed: `src/protocol/validator.ts`, `src/protocol/capabilities.ts`, `test/protocol-validator.test.ts`, and `test/execution-chain.test.ts`.
- [x] Credential-dedicated fields cannot carry raw provider tokens: closed request/config schemas and secret references enforce that boundary; event/error producers are normatively required to use field allowlists, sensitivity tags, and structural redaction, while `src/protocol/metadata.ts` rejects normalized secret/authority-shaped keys as defense in depth. The normative document explicitly states that generic JSON validation cannot prove an arbitrary string is non-secret. Coverage includes `test/fixtures/protocol/invalid/request-secret.json`, `test/execution-request.test.ts`, `test/execution-chain.test.ts`, and config/CLI secret tests.
- [x] A compatibility matrix and complete example chain exist: `docs/contracts/toss-cli-v2.2-compatibility.md`, `examples/runtime-contract-v1/*.json`, and `test/documentation-integrity.test.ts`.
- [x] Valid and invalid contract fixtures are tested: `test/fixtures/protocol`, `test/protocol-json.test.ts`, `test/protocol-validator.test.ts`, `test/execution-request.test.ts`, and `test/execution-chain.test.ts`.

## Issue #4 acceptance map

- [x] Supported Node versions and package contract are documented: `package.json`, `README.md`, and `test/package-metadata.test.ts`.
- [x] CLI version/health and daemon lifecycle work: `test/cli.test.ts`, `test/service-lifecycle.test.ts`, `test/serve-smoke.test.ts`, plus installed-process SIGTERM/SIGINT and safe-error checks in `scripts/package-test.mjs`.
- [x] CI runs lint, typecheck, tests, package integrity, and dependency audit: `.github/workflows/ci.yml` and the `verify` script in `package.json`.
- [x] Provider, skills, tools, orchestration, and evidence source boundaries are separated: corresponding `src/*/index.ts` modules and `test/unavailable-boundaries.test.ts`.
- [x] Secrets do not enter the repository contract or command-line diagnostics: `.gitignore`, `.npmignore`, closed schemas, `src/config/load.ts`, CLI redaction coverage in `test/cli.test.ts`, config security coverage in `test/config.test.ts`, and package leak checks in `scripts/package-test.mjs`.
- [x] The baseline smoke test passes in a clean environment: temporary tarball installation/import/CLI checks and real installed-process SIGTERM/SIGINT coverage in `scripts/package-test.mjs`, backed by deterministic lifecycle integration in `test/serve-smoke.test.ts`.
- [x] The SemVer release path is documented and guarded: `CHANGELOG.md`, version/publish metadata in `package.json`, baseline status in `README.md`, and the non-publishing guard in `.github/workflows/release.yml`.

## Handoff gate

The first independent review initially returned “not ready” with eight important findings. Commit `1bee569e03b4dfa0a43cc81bdea8ca6076d9a042` closes them with tests for: event/error sensitive metadata keys; safe routed service failures and forced shutdown; inline credential option redaction; coherent feature/exact MCP profile negotiation; terminal/timestamp chain integrity; absolute XDG defaults; no-follow production config/private root isolation; and real installed-process signals. It also replaces category-based package acceptance with `scripts/package-files.json`.

The follow-up review found four remaining gaps. Commit `0d29d714a97e4fc7a90c27d108c77bf3140c4e23` closes them with coverage for compact/uppercase sensitive keys and direct runtime-error fragment validation; bidirectional capability/resource coherence; field-specific production config/state/log/runtime roots; synchronous lifecycle cleanup; and readiness-synchronized installed-process signal tests.

The final adversarial pass found three narrower invariant gaps. Commit `9cd153673d9c8a738d8b27c80c483315e338be4f` closes them with uppercase token-compound coverage across fragments/events/results, a mixed provider/routing capability matrix, and a negative Linux log-root sibling test.

The dependency wave is ready to merge. After pull request #33 merges with its required checks green, #2 and #4 may close and later waves may treat `runtime-contract.v1` as their frozen input boundary. This is not authorization to publish npm version `1.0.0`, create a GitHub release, or close the v1 epic.
