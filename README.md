# TOSS Agent Runtime

`@toss-software/agent-runtime` is the governed, provider-neutral execution runtime for TOSS. This development baseline publishes Runtime Contract Protocol v1, strict configuration loading, a truthful capability handshake, and the explicit per-user `toss-runtime` service-supervision foundation.

> Status: the package remains `0.0.0-development` until all v1 release waves and protected live-provider gates pass. The issue #28 service foundation is implemented, but #28 remains open until issue #1 supplies production-durable `INTERRUPTED` journal persistence. Issues #1, #29, and #30 and npm `1.0.0` remain incomplete. This baseline does not execute agents, call providers, run tools, or expose remote control.

## Requirements

- Node.js 22.23.0 or newer in the Node 22 line, or Node.js 24
- macOS or Linux
- npm

## Install

The public installation command becomes available when the first release is published:

```sh
npm install @toss-software/agent-runtime
```

Package installation and `prepack` have no service-manager side effect: they do not write a launchd/systemd definition, enable login startup, or start a daemon. Service installation is always the separate, explicit `toss-runtime service install` operation.

For repository development:

```sh
npm ci
npm run verify
```

## CLI

```sh
toss-runtime --help
toss-runtime --version
toss-runtime capabilities --json
toss-runtime doctor --json
toss-runtime serve --config /absolute/path/to/runtime.yaml
toss-runtime service install [--config /absolute/path/to/runtime.yaml] [--json]
toss-runtime service start [--json]
toss-runtime service stop [--json]
toss-runtime service restart [--json]
toss-runtime service status [--json]
toss-runtime service uninstall [--json]
```

Only `service install` accepts `--config`. It validates or materializes a private configuration, writes the current user's native service definition, and enables automatic startup at login. It does not start the service in the current session; run `toss-runtime service start` for that explicit activation. `service status` is read-only and returns success with `installed: false` when no compatible definition exists. `service stop` and `service uninstall` are idempotent when absent, while absent `start` or `restart` returns unavailable.

`doctor` checks package, platform, Node, configuration, native manager state, restart backoff, and private socket health. A healthy active service with a matching socket identity passes the service check. Missing or stopped service state warns in development and fails in production; backoff, unsafe state, unavailable/degraded control, or identity mismatch fails. See the [Local Service Control v1 contract](docs/contracts/local-service-control-v1.md) for exact native commands, permissions, protocol bounds, stable failures, and shutdown ordering.

`capabilities` remains deliberately fail-closed: an empty or unavailable capability is not an implementation promise. The supervised `serve` process owns the single-instance lock and private local status socket, but agent execution and durable run journals are not implemented in this foundation.

Stable exit codes are `0` success, `2` usage, `3` invalid input, `4` blocked/policy, `5` validation, `6` conflict/stale revision, `69` unavailable capability, and `70` internal failure.

## Library API

```ts
import { parseExecutionRequest, validateExecutionChain } from "@toss-software/agent-runtime";

const parsed = parseExecutionRequest(requestBytes);
if (!parsed.ok) {
  console.error(parsed.code, parsed.issues);
}
```

The public parser returns either a validated, deeply frozen domain value or a normalized failure. Input is bounded JSON; duplicate keys, unknown properties, unsupported schema versions, and unsafe JavaScript values are rejected.

## Contracts and examples

- [Runtime Contract Protocol v1](docs/contracts/runtime-contract-protocol-v1.md)
- [Local Service Control v1](docs/contracts/local-service-control-v1.md)
- [TOSS CLI v2.2 compatibility](docs/contracts/toss-cli-v2.2-compatibility.md)
- [Schema manifest](docs/contracts/runtime-contract-v1.manifest.json)
- [Complete example chain](examples/runtime-contract-v1)

Runtime output is execution evidence, not governance authority. Acceptance, policy, and artifact truth remain owned by the TOSS control plane and authoritative project artifacts.

## Security

Protocol fields intended for credentials carry named secret references, never resolved values. Free-form event/error JSON is not proof that a string is non-secret: producers must build it from event-specific allowlists and structurally redact tagged sensitive values before serialization. Parsers reject normalized secret- and governance-shaped metadata keys as defense in depth. Do not put tokens, passwords, private keys, credential blobs, or arbitrary environment maps in requests, results, configuration files, logs, or bug reports. The CLI rejects secret-shaped options and redacts inline or separate values in diagnostics.

Report suspected vulnerabilities privately to the TOSS Software security contact. Do not open a public issue containing sensitive material.

## License

Proprietary TOSS Software. See [LICENSE](LICENSE).
