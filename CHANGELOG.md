# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog and the release line follows Semantic Versioning.

## [Unreleased]

### Added

- Runtime Contract Protocol v1 schemas, safe canonical JSON, content hashes, and complete request/event/result chain validation.
- Truthful runtime capability discovery and fail-closed request negotiation.
- Secret-reference-only JSON/YAML configuration with filesystem permission checks.
- `toss-runtime` CLI, diagnostics, and graceful SIGINT/SIGTERM lifecycle shell.
- Deterministic package-content tests and credential-free Node.js 22/24 CI baseline.

### Known limitations

- Providers, routing, skills, MCP, agent execution, review, evidence capture, and the local control socket are intentionally unavailable until later v1 waves.
- The package is not publishable as `1.0.0` until protected live-provider and agentgateway release gates are implemented and pass.
