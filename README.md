# TOSS Agent Runtime

`@toss-software/agent-runtime` is the governed, provider-neutral execution runtime for TOSS. This development baseline publishes Runtime Contract Protocol v1, strict configuration loading, a truthful capability handshake, an immutable agent-definition registry and provenance-aware context compiler, authenticated agentgateway transport, deterministic governed model-routing and budget planning, immutable append-only run journals, private structured operational logs, and the explicit per-user `toss-runtime` service-supervision foundation.

> Status: the package remains `0.0.0-development` until all v1 release waves and protected live-provider gates pass. Immutable run-journal persistence, explicit project intake, structured operational logging, the immutable agent registry/context compiler, authenticated agentgateway transport, and the pure governed routing boundary are implemented; issue #28 still requires its separate real macOS login/native crash-loop acceptance, and protected live-provider/agentgateway smoke remains issue #15. npm `1.0.0` remains incomplete. The supervised runtime does not yet execute agents, run tools, or expose remote control.

## Requirements

- Node.js 22.23.0 or newer in the Node 22 line, or Node.js 24
- macOS
- npm

## Install

The public installation command becomes available when the first release is published:

```sh
npm install @toss-software/agent-runtime
```

Package installation and `prepack` have no service-manager side effect: they do not write a launchd/systemd definition, enable login startup, or start a daemon. `prepack` runs only formatting, lint, type checking, build, and contents-only package acceptance; the installed-supervisor smoke remains part of explicit `npm run verify`. Service installation is always the separate, explicit `toss-runtime service install` operation.

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
toss-runtime project register <absolute-root> [--json]
toss-runtime project unregister <project-id> [--json]
toss-runtime project list [--json]
toss-runtime logs [--level <debug|info|warn|error>] [--project <id>] [--run <id>] [--json]
toss-runtime logs --follow [--level <debug|info|warn|error>] [--project <id>] [--run <id>]
```

Only `service install` accepts `--config`. It validates or materializes a private configuration, writes the current user's native service definition, and enables automatic startup at login. It does not start the service in the current session; run `toss-runtime service start` for that explicit activation. `service status` is read-only and returns success with `installed: false` when no compatible definition exists. `service stop` and `service uninstall` are idempotent when absent, while absent `start` or `restart` returns unavailable.

Repository acceptance verifies deterministic launchd/systemd definitions, native syntax lint on the host platform, exact enable/start command arrays, status/backoff parsing, doctor remediation, and a directly started installed-supervisor smoke. It deliberately does not mutate a real user's service manager. Automatic login-session activation and native crash-loop observation remain platform-integration pending; ordinary `npm run verify` jobs do not close those gates.

## Project registration and intake

The service never scans an unregistered project, a home directory, or neighboring workspace roots. Registration is explicit and requires a closed manifest at `<absolute-root>/.toss/project.yaml`:

```yaml
schema_version: project-watch-manifest.v1
watch_paths:
  - src
  - package.json
ignore_paths:
  - dist
  - tmp
```

`watch_paths` and `ignore_paths` are project-relative literal paths. Absolute paths, traversal, backslashes, symlinks, root escapes, `.git`, `.toss/runtime`, and runtime-owned state are rejected or always ignored. Registration binds the canonical project root and manifest hash to a stable project ID. `project unregister` stops that watch without deleting project files, registry history, candidates, journals, or logs.

Native changes are normalized and coalesced after 200 ms, with a hard 2 second maximum for a continuous burst. The pending window is synchronized before its timer is armed; after restart it is either completed exactly once or rejected safely. Duplicate normalized change sets append no second record. A missing, moved, or replaced root becomes `BLOCKED_PROJECT_UNAVAILABLE`; the runtime never guesses a replacement root.

The watcher emits only a durable `candidate-job-intent.v1` candidate job intent. A candidate does not authorize execution, approve policy, select a provider, invoke a tool, mutate authoritative project artifacts, or satisfy acceptance. Those governance gates remain owned by the TOSS control plane.

## Operational logs

The supervised process is the only operational-log writer. It appends closed `operational-event.v1` JSON lines under the configured private log root, assigns one service-local sequence, synchronizes each accepted line, rotates before the 100 MiB or UTC-day boundary, and retains only recognized closed operational logs for seven days and a 100 MiB aggregate budget. Run journals and release evidence are separate immutable artifacts and are never retention targets.

`logs --json` returns one deterministic command result. Human and JSON views contain the same event IDs; `--level` is a minimum severity and `--project`/`--run` are exact canonical UUID filters. `--follow` is human-only and follows an active-file rotation without duplicating the hard-linked event. A partial final line is ignored and reported until startup recovery truncates it; invalid interior content fails closed.

Metadata is built from event-specific allowlists. Secret-tagged values, nested payloads, environment/argument maps, provider or MCP payloads, prompts, and tool output are omitted; sensitive-key scanning provides a second rejection boundary. A synchronization, rotation, retention, `ENOSPC`, or `EDQUOT` failure makes logging sticky-degraded. Required project mutations do not report success unless their operational event is durable, and service status/doctor expose degraded logging health.

## Provider adapters

The public library exposes one closed normalized request/event/completion boundary plus OpenAI, Anthropic, and Gemini adapters. Adapters receive an injected wire transport; they do not resolve credentials or open network connections themselves. Capability preflight rejects unsupported tools, JSON schema, vision, reasoning, streaming, and output limits before any transport call. Streaming and non-streaming provider-native fixtures close through the same canonical completion collector.

Provider wire values are untrusted edge input. Only allowlisted scalar/content fields are projected into `provider-event.v1`; raw SDK objects, headers, endpoints, native error messages, credentials, and response bodies have no public runtime representation. Stable provider failures distinguish authentication, rate limit, timeout, cancellation, refusal, transient unavailability, invalid input, and internal failure. Adapters and transports never retry automatically; the governed routing layer only plans and validates explicit attempts and state transitions.

## Authenticated agentgateway transport

For the current v1 contract, production mode is gateway-only: one named HTTPS `toss-agentgateway.v1` profile is required and direct provider profiles are rejected. Development may use an exact loopback HTTP gateway. The transport uses only the fixed relative paths `/healthz`, `/v1/toss/capabilities`, and `/v1/responses`; redirects are disabled and any origin change fails closed.

Credentials are short-lived virtual Bearer leases resolved from a named secret reference at the last responsible boundary. Raw provider credentials, token values, resolver diagnostics, arbitrary headers, and cache access are not public API or runtime evidence. Each provider operation discovers a fresh, closed, hash-verified capability document, proves that at least one alias route satisfies the normalized request, and sends only the allowlisted `traceparent`, optional `tracestate`, `x-toss-run-id`, `x-toss-request-id`, capability revision/hash, and requirement-hash headers.

The response must attest its exact route, provider, model, gateway revision, capability document hash, and requirement hash. Missing, mutated, unknown, or weaker routing is rejected as an integrity failure. JSON and SSE responses are bounded; cancellation and consumer termination close the native response body. Fixed safe errors distinguish authentication, route absence, rate limiting, cancellation, gateway unavailability, upstream transience, invalid gateway output, and capability downgrade. No raw response body, endpoint, header, token, prompt, or provider diagnostic is reflected.

Body observability defaults to `off`. The opt-in `redacted-metadata` mode emits only a frozen structural summary with correlation IDs, selected route ID, streaming flag, byte/count totals, status class, and monotonic duration. It contains no request or response content and observation failures cannot change the provider result. The transport never retries automatically; tool propagation belongs to issue #9, final release evidence to issue #12, and live protected credentials to issue #15. Protected live-provider and agentgateway smoke remains issue #15 and is not claimed by ordinary CI.

## Governed model routing and budgets

The TOSS control plane authority owns the exact `model-catalog.v1`, `routing-policy.v1`, task classification, and any governed override. The runtime parses those bounded, hash-bound inputs together with `routing-state.v1`; fresh agentgateway capabilities may only remove authority. Route eligibility uses an AND capability intersection for boolean features and the minimum catalog/live numeric limit. Prompts, repository content, providers, and the gateway cannot mint a class, capability, budget, review rule, or override.

`planModelSelection()` uses fixed ASCII deterministic ordering over policy preference, catalog priority, worst-case cost, latency, stable entry identity, and normalized task-risk sets. Reordered and rehashed catalog or live-route arrays preserve semantic selection while the plan and next-state hashes rebind the exact authoritative bytes. An emitted alias is accepted only when every same-alias live route executable for the exact gateway requirement has an exact safe governed catalog match; `accepted_routes` contains that complete set and reservation uses its maximum governed price. For security, architecture, or irreversible risk, independent review planning requires a reviewer whose every provider/model pair differs from every accepted primary and fallback route. This is a planning guarantee only; Issue #11 remains pending for independent worker/reviewer execution proof.

Money is nonnegative integer microusd. Each uncached-input, cached-input, ordinary-output, and reasoning-output component is multiplied with `bigint`, divided by one million, and rounded upward independently. The primary, every planned fallback, and the reviewer are reserved atomically against input, output, cost, duration, and turn limits. Every listed attempt settles one turn and its validated duration; tokens and cost settle only from a complete trusted route/usage pair. Missing, asymmetric, unaccepted, or unpriceable evidence after a possible provider effect clears active reservations and makes the budget unknown until Issue #12 remains pending for authoritative usage reconciliation.

Circuit state is explicit and hash-linked. Only timeout, transient-provider, and gateway-unavailable outcomes advance it or authorize an explicit fallback already present in the plan. `recordRoutingOutcome()` returns a hashed outcome witness; `nextModelFallback()` consumes that witness without invoking transport or retrying. The closed plan binds the request deadline and live-capability expiry, and fallback uses the witnessed occurrence time only while the live statement remains fresh and the next attempt's full reserved duration fits the deadline. Settlement proves every intermediate circuit-only revision with a bounded `circuit_state_chain`. Governed override narrowing can choose only an already eligible catalog entry and cannot weaken capability, latency, review, fallback, circuit, or budget policy.

Exact route verification runs against the initially reserved state before any outcome transition. It binds the agentgateway profile/revision, requested alias, exact route/provider/model, capability-document hash, and requirement hash to one accepted attempt. Mismatches and all other operational failures use fixed safe routing errors without reflecting prompts, endpoints, headers, tokens, provider diagnostics, or native values.

Issue #10 remains pending for worker-turn execution and consumption of the explicit fallback plan. Issue #11 remains pending for independent review orchestration and execution proof. Issue #12 remains pending for ACP execution evidence and authoritative gateway usage reconciliation. Issue #13 remains pending for full secret, egress, prompt-injection, and sandbox hardening. Issue #15 remains pending for protected live-provider routing smoke and release guidance. The Issue #6 surface itself performs no network call, provider invocation, filesystem write, persistence, clock read, sleep, or automatic retry.

## Agent definition registry and compiled context

The TOSS control plane is the only authority for agent roles, exact Task
Contracts, capability and budget ceilings, approval, and acceptance. The public
library can publish immutable prompt/definition revisions, resolve an exact
`ACTIVE` revision for new execution, and retain an old active or `RETIRED`
revision only for resume of a run already bound to it. Repository files and all
other non-control-plane inputs remain `untrusted-content`; they cannot mint or
change authority.

`compileAgentContext()` emits one deterministic, provider-neutral,
hash-bound `compiled-context.v1` document. Segment precedence is fixed as
`trusted-runtime` safety, `trusted-control` Task Contract, prompt template and
output contract, then `untrusted-content` input artifacts. Prompt block IDs and
the closed allocation policy are hash-bound so the parser can reconstruct the
exact prompt, recompute every segment ID, and enforce canonical input ordering
and truncation reasons. Unshortened direct-source content retains its exact
source hash. V1 counts one UTF-8 byte as one conservative token. Trusted
segments are never truncated; only the final eligible untrusted segment can be
prefix-truncated at a Unicode scalar boundary, with exact original/included
hashes and byte counts recorded.

Registry list and resolution calls validate but never repair durable history.
Reads accepted before shutdown participate in the flush cut; reads after
shutdown may inspect fully valid state without writing. An explicitly awaited
`recover()` is the only operation that repairs a partial tail, using a bounded,
identity-checked recovery stage and reusing an exact quarantine fragment on
retry.

Issue #7 advertises the four agent/context schemas only; Issue #7 does not
execute Agent Skills, Superpowers, MCP tools, providers, or the agent loop.
Issue #8 owns Agent Skills and Superpowers execution, Issue #9 owns MCP tools,
and Issue #10 owns providers and the agent loop. The packaged examples are
illustrative control-plane artifacts, not writable local configuration, and
contain no credentials or local paths.

`doctor` checks package, platform, Node, configuration, native manager state, restart backoff, and private socket health. A healthy active service with a matching socket identity passes the service check. Missing or stopped service state warns in development and fails in production; backoff, unsafe state, unavailable/degraded control, or identity mismatch fails. See the [Local Service Control v1 contract](docs/contracts/local-service-control-v1.md) for exact native commands, permissions, protocol bounds, stable failures, and shutdown ordering.

`capabilities` advertises the delivered agentgateway and OpenAI, Anthropic, and Gemini normalized adapter transports plus the available pure routing-planning boundary. Skills, MCP, the agent loop, review execution, and evidence remain unavailable. An empty or unavailable capability is not an implementation promise. The supervised `serve` process owns the single-instance lock, private local status socket, and private append-only run-journal store. Active runs are durably recorded as `INTERRUPTED` before graceful shutdown removes the socket or lock. Agent execution remains unavailable until its later v1 waves.

Stable exit codes are `0` success, `2` usage, `3` invalid input, `4` blocked/policy, `5` validation, `6` conflict/stale revision, `69` unavailable capability, and `70` internal failure.

## Library API

```ts
import { randomUUID } from "node:crypto";

import {
  createRunJournalStore,
  parseExecutionRequest,
  validateExecutionChain,
} from "@toss-software/agent-runtime";

const parsed = parseExecutionRequest(requestBytes);
if (!parsed.ok) {
  console.error(parsed.code, parsed.issues);
}

const journal = createRunJournalStore({
  statePath: "/private/runtime-state",
  now: () => new Date(),
  randomId: randomUUID,
});
```

The public parser returns either a validated, deeply frozen domain value or a normalized failure. Input is bounded JSON; duplicate keys, unknown properties, unsupported schema versions, and unsafe JavaScript values are rejected.

The same top-level API exports the closed project manifest, project registry-entry, candidate-intent, agent-definition, prompt-template, agent-registry-entry, compiled-context, provider-event, and agentgateway-capability parsers; the corresponding public agent hashes, registry factory/interface and pure compiler; safe project registry/intake, gateway profile/capability/route/health/credential-provider/observation types; the authenticated agentgateway factory; provider-neutral request/event/completion types; and the three adapter factories. Private agent object-store helpers, mutation claims, test factories, filesystem constructors, native SDK handles, raw fetch/SSE/header parsers, gateway wire clients, credential caches, and operation hooks remain outside the public package surface.

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
