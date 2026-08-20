# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog and the release line follows Semantic Versioning.

## [Unreleased]

### Added

- Runtime Contract Protocol v1 schemas, safe canonical JSON, content hashes, and complete request/event/result chain validation.
- Truthful runtime capability discovery and fail-closed request negotiation.
- Secret-reference-only JSON/YAML configuration with filesystem permission checks.
- `toss-runtime` CLI, diagnostics, and graceful SIGINT/SIGTERM lifecycle shell.
- Explicit macOS launchd and Linux `systemd --user` service lifecycle commands, deterministic login-enablement command arrays, restart/backoff status, and actionable doctor checks (#28 foundation).
- Closed, bounded local status contracts, a private Unix socket, conservative single-instance locking, and ordered bounded supervisor shutdown.
- Immutable, hash-linked run journals with exact-head transitions, idempotent command replay, side-effect intent reconciliation, partial-tail quarantine, corrupt-chain blocking, and production-durable `INTERRUPTED` shutdown records (#1).
- Native launchd/systemd definition validation and installed-package supervision smoke tests for duplicate instances, permissions, status, signals, cleanup, and process reaping.
- Deterministic package-content tests and credential-free Node.js 22/24 CI baseline.
- Commit-bound acceptance evidence for the Runtime Contract Protocol/package baseline (#2 and #4).

### Security

- Reject separator-free, case/camelCase, and uppercase secret- and governance-shaped metadata keys in event/error free-form fields while documenting the producer redaction boundary.
- Require bidirectional coherence between `available` features and their provider, model, skill, MCP, and topology resources during capability parsing and negotiation.
- Preserve JSON/exit-code safety for inline secret options, missing service configuration, failed drains, and forced shutdown.
- Read configuration through one no-follow file descriptor and isolate each production file/path class to its private per-user config, state, log, or runtime root.
- Validate exact npm package contents and readiness-synchronized real installed-process SIGINT/SIGTERM behavior.
- Clean up lifecycle listeners and timers when signal registration, stop-accepting, or drain startup fails synchronously.
- Keep package installation and `prepack` free of service-manager writes, enablement, or startup; only explicit `toss-runtime service install` changes native service state.
- Restrict `prepack` to non-service format, lint, typecheck, build, and contents-only package acceptance while retaining installed-supervisor smoke in explicit verification.
- Restrict runtime and lock directories to `0700` and configuration, definitions, lock owners, and Unix sockets to `0600`; reject unsafe ownership, links, modes, and ambiguous stale state.
- Render secret-free service definitions from absolute command/config paths and the `LANG`, `LC_ALL`, and `TZ` allowlist, with shell-free native command execution.
- Bound local control requests and responses to 64 KiB canonical JSON and return only fixed, non-reflective service failures.
- Return the forced shutdown outcome at its configured deadline even when socket close or lock release never settles, while continuing finalizers in fail-closed socket/lock/umask order.

### Known limitations

- Automatic login-session activation and actual native crash-loop observation remain platform-integration pending; deterministic definitions, syntax lint, exact manager arrays, parsers, doctor checks, and direct supervisor smoke do not replace those gates.
- Issues #29 (project registration/watching) and #30 (structured operational logging) remain incomplete; the current local socket exposes only closed service status.
- Providers, routing, skills, MCP, agent execution, review, and execution evidence capture remain unavailable until later v1 waves.
- The package is not publishable as `1.0.0` until protected live-provider and agentgateway release gates are implemented and pass.
