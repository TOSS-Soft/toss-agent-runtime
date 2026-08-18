# Runtime Protocol and Package Baseline Design

## Scope

This first delivery wave implements issue #2, Runtime Contract Protocol v1,
and issue #4, the publishable TypeScript package, CLI/daemon, and CI baseline.
It establishes interfaces and repository boundaries consumed by every later
wave. It does not yet call a real provider, execute tools, install an OS
service, watch projects, or run the agent loop.

## Package contract

The package is `@toss-software/agent-runtime`, version `0.0.0-development`
until the release wave changes it to `1.0.0`. It is proprietary TOSS Software,
ESM-only, and requires Node.js 22 or 24 on macOS or Linux. npm is the package
manager and the lockfile is committed.

The published artifact contains compiled JavaScript, declarations, source
maps, JSON Schemas, normative protocol documentation, examples, README,
changelog, and license. Tests, local state, credentials, fixtures containing
secrets, and development configuration are excluded. The executable is
`toss-runtime`.

The initial command surface is:

- `toss-runtime --help`
- `toss-runtime --version`
- `toss-runtime capabilities [--json]`
- `toss-runtime doctor [--json]`
- `toss-runtime serve [--config <path>]`

`capabilities` reports the baseline protocol and unavailable future
capabilities honestly. `doctor` validates the runtime, platform, config, and
package without claiming provider, gateway, MCP, or skill readiness before
those waves exist. `serve` starts the lifecycle shell, handles signals, and
exits cleanly; the authenticated socket protocol arrives in the local-service
wave.

## Repository structure

- `src/protocol/`: protocol types, validation, canonical JSON, hashes, and
  compatibility.
- `src/config/`: closed config types and secret-reference-safe loading.
- `src/platform/`: clocks, IDs, filesystem/process abstractions, paths, and
  signal handling.
- `src/cli/`: parsing, command dispatch, exit codes, human/JSON rendering.
- `src/service/`: daemon lifecycle shell.
- `src/providers/`, `src/routing/`, `src/agents/`, `src/skills/`, `src/tools/`,
  `src/orchestration/`, `src/evidence/`, and `src/security/`: public internal
  boundary files with no false implementation claims.
- `contracts/runtime/`: closed JSON Schema 2020-12 documents.
- `docs/contracts/`: normative protocol and compatibility documents.
- `examples/`: secret-free valid request/result chain.
- `test/`: unit, contract, CLI, package, and smoke tests.
- `.github/workflows/`: credential-free CI and protected release workflows.

## Runtime Contract Protocol v1

Every document is a closed object with `protocol_version`, `schema_version`,
and `document_type`. IDs, timestamps, SHA-256 hashes, artifact references,
budgets, policy references, errors, producer identities, and safe JSON values
come from one common definitions schema. Schemas use stable
`https://toss.software/schemas/runtime/v1/` identifiers.

The first wave publishes:

- `execution-request.v1`: request/run IDs, exact Task Contract and ACP input
  references, requested agent definition, required Superpowers capabilities,
  logical model class and required capabilities, MCP profile, budget, review
  policy, output schema reference, deadline, and correlation context.
- `execution-event.v1`: sequence, previous hash, event hash, run revision,
  event type, timestamp, producer, trace context, safe payload, and exact input
  reference. The schema covers the full v1 event vocabulary while semantic
  state legality is enforced by a separate transition policy in wave two.
- `execution-result.v1`: terminal status, exact request and journal-head
  references, output artifact references/hashes, normalized error, usage
  summary, evidence references, and trace context.
- `runtime-capabilities.v1`: runtime/package identity, supported protocol and
  schema versions, platform, provider transports, model classes, skill host,
  MCP transports, topology, and feature availability.

Artifact references require document type, stable ID, positive revision,
SHA-256 hash, and optional repository-relative location. They never contain
artifact bodies. Secret values, raw provider tokens, credential material, and
arbitrary environment maps have no schema representation.

## Validation and trust boundary

Validation has three stages:

1. Parse bytes as bounded JSON and reject duplicate object keys.
2. Validate against the exact closed JSON Schema selected by the declared
   schema version.
3. Apply semantic checks for hash syntax, unique references, budget bounds,
   deadline ordering, protocol/schema compatibility, capability declarations,
   and governance authority.

The library exposes typed parse functions that return a canonical deep-frozen
value or a normalized validation error. It does not expose a `cast` or accept
unknown fields. Canonical JSON is deterministic, rejects unsupported values and
accessors, and feeds SHA-256 hashing.

The normative trust document states that runtime output is execution evidence,
never governance authority or acceptance. Request fields cannot delegate
authority beyond their exact references. Unknown protocol, schema, model
capability, skill capability, or MCP profile is rejected before execution.

## Configuration baseline

Configuration precedence is command-specific explicit path, user config, then
documented defaults. Project files cannot override per-user secret providers,
production mode, egress rules, or security profiles. Environment variables may
name a config path and provide referenced secret values, but generic environment
enumeration is never serialized.

The baseline config schema contains mode, state/log/config paths, shutdown
deadline, log policy, provider/gateway profile names, MCP profile names, and
secret references. A secret reference identifies a source and key; it never
contains a secret. CLI arguments reject token/key/password options.

## CLI and process behavior

The parser has a fixed grammar and rejects unknown commands/options. JSON mode
prints one versioned result document to stdout and leaves stderr empty for
routed failures. Human mode prints concise diagnostics. Exit codes are stable:
`0` success, `2` usage, `3` invalid input, `4` blocked/policy, `5` validation,
`6` conflict/stale revision, `69` unavailable capability, and `70` internal
failure.

The daemon lifecycle owns an abort signal, registers `SIGINT`/`SIGTERM` once,
stops accepting work, waits up to the configured deadline, and returns a
deterministic exit. It never backgrounds itself or installs a service as a
package side effect.

## Testing and CI

Contract fixtures include one complete request-event-result-capabilities chain
plus invalid examples for unknown fields, duplicate keys, bad hashes, stale or
missing references, unsupported versions/capabilities, authority-shaped output,
secret-shaped fields, invalid budgets, and deadline ordering.

CLI tests cover every baseline command in human and JSON modes, stable exits,
unknown arguments, signal shutdown, missing/unsafe config, and secret-bearing
arguments. Package tests inspect `npm pack --json`, install the tarball into a
clean temporary project, run the executable, import the public API, and confirm
that excluded files are absent.

CI runs formatting, lint, strict type checking, tests, `npm audit`, package
validation, and clean-install smoke tests on Node.js 22 and 24. It grants no
provider secrets and no write token beyond checkout. Release workflows exist as
non-publishing validation until the final wave enables the protected live gate
and npm/GitHub publication.

## Completion gate

This wave is complete only when issues #2 and #4 satisfy every acceptance
criterion, the package installs from its tarball, baseline commands work on a
clean macOS/Linux-compatible Node environment, CI is green, and later modules
can depend on the frozen protocol without importing CLI or SDK adapters.
