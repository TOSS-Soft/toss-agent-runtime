# Authenticated agentgateway transport and tracing design

## Status and authority

This document defines the approved Issue #3 design for TOSS Agent Runtime
v1.0.0. It builds on the normalized provider contract delivered by Issue #5
and the v1 release program design. Where this document is more specific about
agentgateway transport, credential, trace, capability, and route-attestation
behavior, it is authoritative for Issue #3.

The upstream target is `agentgateway/agentgateway` with its OpenAI-compatible
Responses surface. TOSS adds a deployment profile named
`toss-agentgateway.v1` for capability discovery and route attestation. The
runtime does not depend on an agentgateway or provider SDK.

## Goals

- Carry production provider traffic through one authenticated agentgateway
  transport without exposing upstream provider credentials to the runtime or
  TOSS CLI.
- Bind every provider call to its exact run, request, and W3C trace context.
- Discover a bounded gateway route catalog and verify the actual resolved
  provider/model identity returned for a response.
- Reject gateway failover that does not preserve every required capability and
  limit.
- Keep authentication, rate limiting, route lookup, gateway availability,
  capability downgrade, and malformed attestation distinguishable through
  stable safe failures.
- Make prompt/body observability opt-in and structurally redacted.
- Provide deterministic fake-gateway integration and failure coverage without
  live credentials or external network access in ordinary CI.

## Non-goals and owning issues

- Governed route choice, automatic retry, budgets, circuit breaking, and
  fallback policy belong to Issue #6.
- Agent turn execution belongs to Issue #10.
- Final execution and review evidence documents belong to Issue #12.
- Full secret-provider, egress, SSRF, and containment hardening belongs to
  Issue #13.
- Gateway installation guidance, provider-secret provisioning documentation,
  and protected live-provider/agentgateway release smoke belong to Issue #15.

Issue #3 defines the transport boundary that those later issues consume. It
does not perform an automatic provider retry or deploy agentgateway.

## Architectural choice

The runtime implements an SDK-free HTTP/SSE client through injected `fetch`
and time/identity seams. An OpenAI Responses mapper remains responsible for
provider-native body normalization. The gateway client is responsible only for
profile validation, credential leasing, capability discovery, correlation,
bounded HTTP/SSE transport, safe error classification, and route attestation.

The alternatives were rejected as follows:

- Pointing an OpenAI SDK at the gateway would weaken bounded parsing, header
  control, cancellation ordering, and the no-native-object boundary.
- A generic plugin dialect would add unnecessary extension and lifecycle
  surfaces before v1 has a second gateway protocol.

## Component boundaries

Issue #3 adds a focused `src/gateway/` package:

- `types.ts` owns immutable public profile, capability, requirement, route,
  credential-lease, health, and observation types.
- `errors.ts` owns stable gateway-specific provider error construction and HTTP
  classification.
- `contracts.ts` parses, hashes, semantically validates, and freezes closed
  capability and health documents.
- `credentials.ts` validates and coordinates short-lived virtual-token leases.
- `client.ts` performs capability discovery and health probes through bounded
  HTTP requests.
- `transport.ts` implements the provider wire transport for OpenAI-compatible
  JSON and SSE, correlation headers, route attestation, and observation.
- `index.ts` exposes only safe factories and types.

Provider modules continue to own normalized request translation and native
event mapping. Config modules own profile selection and production/development
mode policy. Logging and evidence modules do not import native gateway values.

The provider wire interface is made explicit so route metadata cannot be
smuggled through a native payload:

```ts
interface ProviderWireResponse {
  readonly payload: unknown;
  readonly route_identity: ProviderRouteIdentity | null;
}

interface ProviderWireStream {
  readonly events: AsyncIterable<unknown>;
  readonly route_identity: ProviderRouteIdentity | null;
}

interface ProviderWireTransport {
  complete(input: JsonValue, context: ProviderWireContext): Promise<ProviderWireResponse>;
  stream(input: JsonValue, context: ProviderWireContext): Promise<ProviderWireStream>;
  cancel?(requestId: string): Promise<void>;
  health?(): Promise<unknown>;
}
```

Direct development transports return `route_identity: null`. The gateway
transport validates response headers before returning either wrapper. For
streaming, headers are available before the returned `events` iterable is
consumed. Provider mappers see only `payload` or values yielded by `events`;
they never see the route identity, Response object, or header collection. The
generic adapter injects the already-validated route identity into the first
normalized response-start event and completion.

## Runtime configuration

`runtime-config.v1` gains a required closed `gateway_profiles` object. Existing
configs and defaults include an empty object. Each entry has this exact shape:

```ts
interface AgentgatewayProfileV1 {
  readonly protocol: "toss-agentgateway.v1";
  readonly endpoint: string;
  readonly credential_reference: string;
  readonly body_observability: "off" | "redacted-metadata";
}
```

Profile names and credential references use the existing safe profile-name
grammar. `endpoint` is an absolute URL of at most 2,048 UTF-8 bytes. It cannot
contain username, password, query, fragment, control characters, or encoded
authority confusion. Fixed paths are resolved below an optional endpoint path
prefix:

- `GET <base>/healthz`
- `GET <base>/v1/toss/capabilities`
- `POST <base>/v1/responses`

Production configuration must satisfy all of the following:

- `gateway_profile` is non-null and names an exact `gateway_profiles` entry;
- the selected endpoint uses HTTPS;
- its credential reference names an exact `secret_references` entry whose
  source is `command`;
- `provider_profiles` is empty, so production cannot silently bypass the
  gateway.

Development may select no gateway, may use HTTP only for an exact loopback
host, and may resolve a virtual credential through `env` or `command`.
Non-loopback development gateway endpoints still require HTTPS. Direct
provider adapters remain explicitly development-only.

The `command` secret-reference key is a symbolic resolver name, not a shell
string. Issue #3 does not interpolate or execute arbitrary configuration text.

## Virtual credential boundary

The transport consumes this injected interface:

```ts
interface GatewayCredentialProvider {
  resolve(
    reference: SecretReference,
    options: {
      readonly signal: AbortSignal;
      readonly minimum_validity_ms: 30_000;
    },
  ): Promise<GatewayCredentialLease>;
}

interface GatewayCredentialLease {
  readonly scheme: "Bearer";
  readonly token: string;
  readonly expires_at: string;
}
```

Tokens are 16 to 8,192 UTF-8 bytes and cannot contain whitespace controls,
CR, LF, or NUL. Expiration is canonical UTC and must exceed the injected clock
by at least 30 seconds when returned to a call. A process-wide coordinator
per exact credential reference permits at most one concurrent refresh. A
validated lease may be reused only while its remaining validity is at least
30 seconds.

The token exists only in the request-header construction closure and the
in-memory lease coordinator. It has no JSON representation and is never
included in an error, observation, provider event, operational log, journal,
artifact, evidence value, config, cache file, or CLI argument. JavaScript
strings cannot promise physical zeroization; the implementation drops all
references as soon as the lease expires or the process stops and makes no
stronger claim.

Credential resolution failure and missing/expired leases produce the fixed
authentication failure. Error text from a resolver is not reflected.

## Correlation and trace propagation

Provider execution becomes explicitly correlated. `ProviderExecutionOptions`
is required for `complete()` and `stream()` and contains:

```ts
interface ProviderExecutionOptions {
  readonly run_id: string;
  readonly trace: TraceContext;
  readonly signal?: AbortSignal;
}
```

The generic adapter validates the run identity and trace context and copies
them into `ProviderWireContext`. Gateway transport rejects a missing or invalid
correlation context before credential resolution or network effects.

Every Responses request carries only these correlation headers:

- `traceparent: 00-<trace_id>-<span_id>-<two-hex-trace_flags>`;
- `tracestate` when present and valid;
- `x-toss-run-id` with the exact run identity;
- `x-toss-request-id` with the exact provider request UUID.

No baggage, environment values, user identity, prompt fragment, credential
name, config path, or arbitrary metadata is propagated. Redirects are disabled,
so authorization and trace headers never cross an origin through redirect
following.

Issue #9 applies the same run/trace requirement to future tool calls. Issue #3
implements and tests it for provider calls.

## Gateway capability document

`agentgateway-capabilities.v1` is a closed Runtime Contract Protocol document
with these fields:

```ts
interface AgentgatewayCapabilitiesV1 {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "agentgateway-capabilities.v1";
  readonly document_type: "agentgateway-capabilities";
  readonly gateway: {
    readonly name: string;
    readonly version: string;
    readonly revision: number;
  };
  readonly generated_at: string;
  readonly expires_at: string;
  readonly routes: readonly AgentgatewayRouteV1[];
  readonly document_hash: `sha256:${string}`;
}

interface AgentgatewayRouteV1 {
  readonly alias: string;
  readonly route_id: string;
  readonly provider: "openai" | "anthropic" | "gemini";
  readonly model: string;
  readonly capabilities: ProviderAdapterCapabilities;
}
```

The document is at most 512 KiB and contains 1 to 256 routes. Route IDs are
unique. Multiple routes may share one alias to declare gateway-internal
equivalent failover candidates. The descriptor provider must match its route
provider; booleans and limits use the same bounds as the normalized provider
contract.

`generated_at` and `expires_at` are canonical UTC. Expiration must be later
than generation and no more than five minutes later. `document_hash` is the
SHA-256 of canonical JSON with `document_hash` omitted. Unknown fields,
duplicate JSON keys, duplicate route IDs, unsafe identifiers, unsupported
providers, invalid chronology, invalid limits, or hash mismatch fail closed.

The runtime obtains a fresh capability document for each provider operation in
Issue #3. Catalog caching and refresh policy belong to Issue #6. This is
intentionally conservative; a later cache remains safe only if the response
attestation matches the same document revision and hash.

## Required capability identity

Before the Responses call, the transport derives a closed requirement from
the normalized request and stream mode:

```ts
interface GatewayRouteRequirementV1 {
  readonly schema_version: "gateway-route-requirement.v1";
  readonly alias: string;
  readonly tools: boolean;
  readonly json_schema: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  readonly streaming: boolean;
  readonly max_output_tokens: number;
}
```

Its identity is the lowercase SHA-256 of canonical JSON. At least one route in
the fresh capability document must satisfy every required boolean and output
limit before the Responses request is sent. Credential resolution necessarily
precedes the authenticated capability request. Context-window
selection remains Issue #6 because Issue #3 does not tokenize prompt content.

The request sends:

- `x-toss-capability-revision`;
- `x-toss-capability-document-sha256`;
- `x-toss-requirement-sha256`.

The TOSS agentgateway deployment profile treats these as enforcement inputs.
The runtime independently validates the returned route even if gateway policy
is misconfigured.

## Responses request and bounded transport

The gateway transport implements the existing OpenAI Responses wire shape. It
accepts only the deeply frozen plain JSON produced by the OpenAI adapter.
Production code uses injected `fetch`; no OpenAI or agentgateway SDK is added.

All requests use `redirect: "error"`, the exact AbortSignal, and the existing
adapter-owned deadline. Connection errors, redirects, TLS failures, and
unclassified fetch failures become safe gateway-unavailable results. Request
headers are a fixed allowlist. Callers cannot inject extra headers.

Non-stream response bodies are limited to 8 MiB and are read incrementally
before JSON parsing. Streaming uses `text/event-stream`, an 8 MiB total byte
limit, a 1 MiB event limit, 10,000-event limit, UTF-8 fatal decoding, bounded
line buffering, and exact SSE `data:` framing. Unknown SSE fields are ignored
only at the framing layer; the OpenAI mapper still rejects unknown native event
types. A stream ending without a normalized terminal event is invalid.

The client calls `ReadableStream.cancel()` or iterator return on consumer
termination, cancellation, timeout, and parse failure. No automatic Responses
retry occurs.

## Route attestation

Every successful JSON or SSE response must carry this fixed header set:

- `x-toss-route-id`;
- `x-toss-resolved-provider`;
- `x-toss-resolved-model`;
- `x-toss-capability-revision`;
- `x-toss-capability-document-sha256`;
- `x-toss-requirement-sha256`;
- optional safe `x-toss-gateway-request-id`.

Header names and values are read through an allowlist. Duplicate, joined,
missing, control-bearing, oversized, or syntactically invalid values are
malformed attestation. Revision, document hash, and requirement hash must equal
the pre-call values. The route ID must exist in the capability document under
the requested alias. Resolved provider/model must exactly equal that route.
The route capabilities must satisfy the full requirement.

An internal gateway failover is accepted only when the attested route passes
all of those checks. A route with any missing capability or smaller output
limit produces capability-downgrade even if the HTTP response body is otherwise
successful. The response is not exposed as a completion.

TLS and the authenticated trusted gateway origin bind the attestation in
transit. This design does not claim that the headers are a standalone signed
artifact. Issue #12 records their validated canonical projection, not the raw
headers.

## Canonical route identity

`provider-event.v1` response-start data gains an optional `route_identity`.
`ProviderCompletion` gains a required `route_identity` whose value is null for
direct development transports and this frozen shape for gateway calls:

```ts
interface ProviderRouteIdentity {
  readonly transport: "agentgateway";
  readonly gateway_profile: string;
  readonly gateway_revision: number;
  readonly route_id: string;
  readonly requested_model: string;
  readonly resolved_provider: "openai" | "anthropic" | "gemini";
  readonly resolved_model: string;
  readonly capability_document_hash: `sha256:${string}`;
  readonly requirement_hash: `sha256:${string}`;
  readonly gateway_request_id: string | null;
}
```

The generic adapter injects a validated route identity only into the first
response-start event and the collected completion. Native gateway headers,
header collections, Response objects, URLs, tokens, and capability documents
never enter provider events. Issue #12 can bind this closed identity to final
evidence without importing gateway internals.

## Health behavior

`GET /healthz` is bounded to 64 KiB and accepts only:

```json
{
  "status": "healthy | degraded | unavailable",
  "revision": 1
}
```

The real schema uses a closed status enum and nonnegative safe-integer
revision. Health never contains native diagnostics. Malformed documents,
network errors, redirects, and non-success status reduce to `unavailable`.
Health is diagnostic and cannot make an unavailable capability executable.

Capability discovery requires authentication. Health may use the same virtual
credential but does not carry a run or prompt.

## Stable failures

The existing provider error family is extended with these exact safe outcomes:

| Condition                                                         | Code                                    | Category                 | Retryable |
| ----------------------------------------------------------------- | --------------------------------------- | ------------------------ | --------- |
| Missing, expired, rejected, HTTP 401/403 credential               | `RUNTIME_PROVIDER_AUTHENTICATION`       | `authentication`         | false     |
| HTTP 429 from gateway or provider                                 | `RUNTIME_PROVIDER_RATE_LIMIT`           | `rate-limit`             | true      |
| Unknown alias/route or HTTP 404                                   | `RUNTIME_PROVIDER_ROUTE_NOT_FOUND`      | `unsupported-capability` | false     |
| Network/TLS/redirect failure or gateway HTTP 502/503/504          | `RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE`  | `unavailable`            | true      |
| Attested route lacks a requirement                                | `RUNTIME_PROVIDER_CAPABILITY_DOWNGRADE` | `integrity`              | false     |
| Invalid capability, health, SSE, response framing, or attestation | `RUNTIME_PROVIDER_GATEWAY_INVALID`      | `integrity`              | false     |

Existing timeout, cancellation, refusal, transient provider, invalid request,
unsupported capability, and internal failures remain unchanged. A safe
`x-toss-error-source` value of `gateway` or `provider` may distinguish gateway
5xx from an upstream provider 5xx. Any missing or invalid source on a 5xx is
treated as gateway unavailable. Response bodies and native error text are
never used as public messages.

## Prompt and body observability

`body_observability: "off"` is the default and emits no body-derived
observation. `redacted-metadata` permits only a frozen structural summary:

- request and response UTF-8 byte counts;
- message, content-block, and tool counts;
- streaming flag;
- HTTP status class;
- duration in nonnegative integer milliseconds;
- safe run/request/route identities.

It cannot contain prompt text, tool definitions, tool arguments/results,
structured output, model output, URLs, headers, token values, environment,
arbitrary keys, hashes of content, or native diagnostics. The transport emits
the summary only through an injected `onObservation` callback. Callback
failure cannot change the provider result and is normalized by the owning
operational logging layer. Issue #30 redaction remains a second boundary.

## Production and development separation

Production mode can construct a provider path only from the selected gateway
profile. A direct provider profile, non-HTTPS endpoint, env credential source,
missing profile, missing reference, or profile/reference mismatch makes config
invalid before service readiness.

Development mode may use direct provider transports or an exact loopback fake
gateway. Capability, trace, parsing, attestation, and secret non-reflection
rules remain identical; development relaxes only endpoint TLS and credential
source policy.

## Test strategy

All production behavior is introduced through strict RED-GREEN cycles.

### Contract and config tests

- closed valid capability and health documents parse and freeze;
- duplicate keys, unknown fields, size limits, hashes, chronology, route
  identity, duplicate route IDs, and capability bounds reject safely;
- production requires selected HTTPS gateway, command credential reference,
  and empty direct-provider profiles;
- development accepts exact loopback HTTP and rejects non-loopback HTTP;
- provider events and completions carry only the closed route identity.

### Credential tests

- valid leases are single-flight and reused only above the 30-second floor;
- expired, short, long, control-bearing, accessor/proxy, noncanonical-time, and
  resolver-failure leases normalize to authentication failure;
- concurrent calls do not trigger duplicate refresh;
- tokens never appear in serialized values, observations, errors, or logs.

### Real fake-gateway integration

A real loopback Node HTTP server implements health, capability, Responses JSON,
and Responses SSE. Tests prove:

- exact Authorization, run, request, traceparent, tracestate, capability, and
  requirement headers;
- one non-stream and one SSE completion normalize identically;
- the exact route/provider/model identity reaches the canonical completion;
- auth, rate limit, route not found, gateway unavailable, timeout,
  cancellation, malformed JSON/SSE, and truncated stream are distinct;
- consumer termination closes the native body;
- prompt, response, credential, and upstream provider-secret sentinels are
  absent from all public/runtime values.

### Downgrade and mutation tests

- an equivalent attested route is accepted;
- weaker tools, JSON schema, vision, reasoning, streaming, or output limit is
  rejected;
- unknown route, provider/model change, revision/hash/requirement mismatch,
  duplicate/missing headers, post-discovery catalog mutation, and redirected
  origin fail closed;
- malformed or oversized bodies never reach the OpenAI mapper.

### Repository gates

- focused gateway/provider/config/docs tests;
- format, lint, strict typecheck, complete test suite, build, exact package
  contents, installed package lifecycle, and production audit;
- full macOS Node 22.23.1 and Node 24 CI;
- no live credential or external network requirement in ordinary CI.

Protected live-provider and agentgateway smoke remains an explicit Issue #15
release gate and is not claimed by Issue #3.

## Delivery and GitHub state

Issue #3 uses branch `issue/3-agentgateway-transport` and one dedicated PR
against `release/v1.0.0`. The issue and PR project items become Done and the
issue closes when the exact PR head passes both required macOS CI jobs and all
Issue #3 acceptance criteria. Merge into the version branch is recorded
separately in Epic #16.
