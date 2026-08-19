# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog and the release line follows Semantic Versioning.

## [Unreleased]

### Added

- Runtime Contract Protocol v1 schemas, safe canonical JSON, content hashes, and complete request/event/result chain validation.
- Truthful runtime capability discovery and fail-closed request negotiation.
- Secret-reference-only JSON/YAML configuration with filesystem permission checks.
- `toss-runtime` CLI, diagnostics, and graceful SIGINT/SIGTERM lifecycle shell.
- Deterministic package-content tests and credential-free Node.js 22/24 CI baseline.
- Commit-bound acceptance evidence for the Runtime Contract Protocol/package baseline (#2 and #4).

### Security

- Reject separator-free, case/camelCase, and uppercase secret- and governance-shaped metadata keys in event/error free-form fields while documenting the producer redaction boundary.
- Require bidirectional coherence between `available` features and their provider, model, skill, MCP, and topology resources during capability parsing and negotiation.
- Preserve JSON/exit-code safety for inline secret options, missing service configuration, failed drains, and forced shutdown.
- Read configuration through one no-follow file descriptor and isolate each production file/path class to its private per-user config, state, log, or runtime root.
- Validate exact npm package contents and readiness-synchronized real installed-process SIGINT/SIGTERM behavior.
- Clean up lifecycle listeners and timers when signal registration, stop-accepting, or drain startup fails synchronously.

### Known limitations

- Providers, routing, skills, MCP, agent execution, review, evidence capture, and the local control socket are intentionally unavailable until later v1 waves.
- The package is not publishable as `1.0.0` until protected live-provider and agentgateway release gates are implemented and pass.
