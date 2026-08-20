# TOSS Agent Runtime

`@toss-software/agent-runtime` is the governed, provider-neutral execution runtime for TOSS. This development baseline publishes Runtime Contract Protocol v1, strict configuration loading, a truthful capability handshake, and the `toss-runtime` CLI/lifecycle shell.

> Status: the package remains `0.0.0-development` until all v1 release waves and protected live-provider gates pass. This baseline does not execute agents, call providers, run tools, or expose a local control socket.

## Requirements

- Node.js 22.23.0 or newer in the Node 22 line, or Node.js 24
- macOS or Linux
- npm

## Install

The public installation command becomes available when the first release is published:

```sh
npm install @toss-software/agent-runtime
```

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
```

`capabilities` is deliberately fail-closed: an empty or unavailable capability is not an implementation promise. `doctor` checks the package, platform, Node version, and configuration. `serve` currently exercises only graceful process lifecycle and signal handling.

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
- [TOSS CLI v2.2 compatibility](docs/contracts/toss-cli-v2.2-compatibility.md)
- [Schema manifest](docs/contracts/runtime-contract-v1.manifest.json)
- [Complete example chain](examples/runtime-contract-v1)

Runtime output is execution evidence, not governance authority. Acceptance, policy, and artifact truth remain owned by the TOSS control plane and authoritative project artifacts.

## Security

Protocol fields intended for credentials carry named secret references, never resolved values. Free-form event/error JSON is not proof that a string is non-secret: producers must build it from event-specific allowlists and structurally redact tagged sensitive values before serialization. Parsers reject normalized secret- and governance-shaped metadata keys as defense in depth. Do not put tokens, passwords, private keys, credential blobs, or arbitrary environment maps in requests, results, configuration files, logs, or bug reports. The CLI rejects secret-shaped options and redacts inline or separate values in diagnostics.

Report suspected vulnerabilities privately to the TOSS Software security contact. Do not open a public issue containing sensitive material.

## License

Proprietary TOSS Software. See [LICENSE](LICENSE).
