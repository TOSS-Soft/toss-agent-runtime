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
- Explicit project registry, closed manifest-controlled macOS watching, bounded debounce, restart-safe pending intake, and deduplicated candidate job intents (#29).
- Closed `operational-event.v1` envelopes, one synchronized writer queue, crash-safe rotation/recovery, bounded retention, deterministic filters and human/JSON/follow rendering, sticky degraded health, and structural metadata redaction (#30).
- Closed `provider-event.v1` normalization, capability preflight, stable provider failures, and recorded-fixture OpenAI/Anthropic/Gemini streaming and non-streaming adapters over injected wire transports (#5).
- Authenticated agentgateway transport with short-lived virtual credentials, fresh capability discovery, required correlation, route attestation, downgrade rejection, bounded JSON/SSE handling, and opt-in redacted structural observations (#3).
- Governed model routing with four closed hash-bound documents, atomic same-alias executable-route validation, deterministic catalog/live capability intersection, atomic primary/fallback/independent-review planning, deadline/live-expiry-bound fallback, exact integer-microusd reservation and conservative settlement, explicit witnessed circuit/fallback transitions, override narrowing, and exact route verification (#6). This pure boundary does not execute a provider or reviewer.
- Immutable agent prompt/definition revisions, an append-only private lifecycle registry, exact active-versus-resume resolution, and a deterministic provenance-aware context compiler with fixed trust precedence, conservative byte/token accounting, and Unicode-safe untrusted truncation (#7). This boundary advertises schemas only and does not execute skills, tools, providers, or an agent loop.
- Metadata-only Agent Skills discovery from explicit private roots and audited bundled packages, immutable post-selection snapshots, bounded progressive context, finite built-in Superpowers phases, durable private-socket approval pause/replay, and closed compact-journal skill evidence (#8). Skill scripts are integrity-hashed but never executed in v1.0.0.
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
- Bind registered projects to exact canonical root and manifest identities; reject symlink/root escapes, uncontrolled scans, unsafe registry state, and watcher feedback paths.
- Keep gateway tokens, raw headers, response bodies, prompts, provider diagnostics, and credential-cache internals out of public values while disabling redirects and automatic retries.
- Keep project-local skills, native paths, bodies, private stores, test seams, and script execution outside the public Agent Skills authority/package surface; bind every phase and approval to exact catalog, snapshot, journal, context, operation, and hash identities.

### Known limitations

- Automatic login-session activation and actual native crash-loop observation remain platform-integration pending; deterministic definitions, syntax lint, exact manager arrays, parsers, doctor checks, and direct supervisor smoke do not replace those gates.
- MCP tool execution remains pending Issue #9. Worker/fallback and agent-loop execution remain pending Issue #10, independent review execution proof remains pending Issue #11, final reconciliation/evidence remains pending Issue #12, full runtime hardening remains pending Issue #13, and protected live-provider routing smoke remains pending Issue #15.
- The package is not publishable as `1.0.0` until protected live-provider and agentgateway release gates are implemented and pass.
