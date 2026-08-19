# v1 Wave 1 Acceptance Evidence

## Scope and state

This record covers Runtime Contract Protocol v1 (#2) and the package/CLI/daemon/CI baseline (#4). It verifies commit `78b446db6f1be47caa0bf63ea08b6932c23db3f1` on 2026-08-19 before this evidence-only commit was added.

Local acceptance is complete. The GitHub branch and required Node 22/24 macOS/Linux CI matrix remain pending; issues MUST NOT close until that remote evidence is green. This record is internal repository evidence and is intentionally excluded from the npm package; public contract documentation remains under `docs/contracts`.

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
| `npm run verify`                               | Formatting, lint, strict typecheck, 11 test files / 75 tests, build, and installed-package test passed                |
| `npm audit --audit-level=high`                 | 0 vulnerabilities                                                                                                     |
| `node bin/toss-runtime.js --version`           | `0.0.0-development`                                                                                                   |
| `node bin/toss-runtime.js capabilities --json` | Valid `command-result.v1`; protocol v1 advertised and all future subsystems truthfully `unavailable`                  |
| `node bin/toss-runtime.js doctor --json`       | Package, Node/OS, and default config passed; unavailable execution features reported as a warning; no secrets emitted |

CI defines the same locked verification plus production dependency audit for Node `22.23.1` and Node `24` on Ubuntu and macOS in `.github/workflows/ci.yml`.

## Package evidence

| Item          | Value                                                              |
| ------------- | ------------------------------------------------------------------ |
| Filename      | `toss-software-agent-runtime-0.0.0-development.tgz`                |
| Packed files  | 127                                                                |
| Packed size   | 42,988 bytes                                                       |
| Unpacked size | 212,809 bytes                                                      |
| SHA-256       | `e341098c751a47bf447a03649325b93477046e6c7d5ab3557dd4de5053e89023` |

`scripts/package-test.mjs` independently creates the tarball, applies a closed path allowlist, rejects test/fixture/credential-shaped paths, installs into a new temporary project, imports the public API, runs help/version/capabilities from the installed executable, reads the installed manifest, and removes its temporary artifacts.

## Issue #2 acceptance map

- [x] Normative Runtime Contract Protocol v1 document and JSON Schemas exist: `docs/contracts/runtime-contract-protocol-v1.md`, `docs/contracts/runtime-contract-v1.manifest.json`, `contracts/runtime/*.schema.json`, and `test/documentation-integrity.test.ts`.
- [x] Every request carries exact Task Contract and ACP artifact references: `contracts/runtime/execution-request.v1.schema.json`, `src/protocol/request.ts`, `test/execution-request.test.ts`, and `examples/runtime-contract-v1/execution-request.json`.
- [x] The runtime can produce execution evidence but cannot change TOSS authority/acceptance state: normative trust boundary sections in `docs/contracts/runtime-contract-protocol-v1.md`, compatibility/acceptance handling in `docs/contracts/toss-cli-v2.2-compatibility.md`, and the authority-shaped rejection fixture `test/fixtures/protocol/invalid/request-authority.json`.
- [x] Unknown protocol, schema, and model capability fail closed: `src/protocol/validator.ts`, `src/protocol/capabilities.ts`, `test/protocol-validator.test.ts`, and `test/execution-chain.test.ts`.
- [x] Secrets, credentials, and raw provider tokens cannot enter artifacts: closed schemas, the secret exclusion section in the normative document, `test/fixtures/protocol/invalid/request-secret.json`, `test/execution-request.test.ts`, and secret-reference-only config/CLI tests.
- [x] A compatibility matrix and complete example chain exist: `docs/contracts/toss-cli-v2.2-compatibility.md`, `examples/runtime-contract-v1/*.json`, and `test/documentation-integrity.test.ts`.
- [x] Valid and invalid contract fixtures are tested: `test/fixtures/protocol`, `test/protocol-json.test.ts`, `test/protocol-validator.test.ts`, `test/execution-request.test.ts`, and `test/execution-chain.test.ts`.

## Issue #4 acceptance map

- [x] Supported Node versions and package contract are documented: `package.json`, `README.md`, and `test/package-metadata.test.ts`.
- [x] CLI version/health and daemon lifecycle work: `test/cli.test.ts`, `test/service-lifecycle.test.ts`, `test/serve-smoke.test.ts`, plus the installed executable checks in `scripts/package-test.mjs`.
- [x] CI runs lint, typecheck, tests, package integrity, and dependency audit: `.github/workflows/ci.yml` and the `verify` script in `package.json`.
- [x] Provider, skills, tools, orchestration, and evidence source boundaries are separated: corresponding `src/*/index.ts` modules and `test/unavailable-boundaries.test.ts`.
- [x] Secrets do not enter the repository contract or command-line diagnostics: `.gitignore`, `.npmignore`, closed schemas, `src/config/load.ts`, CLI redaction coverage in `test/cli.test.ts`, config security coverage in `test/config.test.ts`, and package leak checks in `scripts/package-test.mjs`.
- [x] The baseline smoke test passes in a clean environment: temporary tarball installation/import/CLI checks in `scripts/package-test.mjs` and process-signal smoke coverage in `test/serve-smoke.test.ts`.
- [x] The SemVer release path is documented and guarded: `CHANGELOG.md`, version/publish metadata in `package.json`, baseline status in `README.md`, and the non-publishing guard in `.github/workflows/release.yml`.

## Handoff gate

The dependency wave is ready to push for review. After the required remote CI matrix is green, #2 and #4 may be closed and later waves may treat `runtime-contract.v1` as their frozen input boundary. This is not authorization to publish npm version `1.0.0`, create a GitHub release, or close the v1 epic.
