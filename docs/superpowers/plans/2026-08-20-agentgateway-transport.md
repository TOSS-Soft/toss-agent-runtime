# Authenticated Agentgateway Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an SDK-free, authenticated agentgateway HTTP/SSE transport that propagates exact run/trace correlation, validates gateway capabilities and resolved routes, prevents capability downgrade, and never exposes provider or virtual credentials.

**Architecture:** Extend the normalized provider wire boundary with explicit response/stream wrappers, required correlation, a provider-neutral route requirement, and a closed canonical route identity. Add a focused `src/gateway/` package for profile contracts, capability/health parsing, virtual-token coordination, bounded fetch/SSE transport, attestation, and safe observations. Runtime config selects one named gateway profile in production; routing policy, retry, agent execution, final evidence, and live credential smoke remain in their owning issues.

**Tech Stack:** TypeScript 6 ESM, Node.js 22.23.1/24 native `fetch` and Web Streams, JSON Schema 2020-12/Ajv, canonical JSON/SHA-256, Vitest 4, fake loopback Node HTTP server.

**Spec:** `docs/superpowers/specs/2026-08-20-agentgateway-transport-design.md`

## Global Constraints

- v1.0.0 supports macOS only and CI runs Node.js 22.23.1 and Node.js 24.
- Production provider traffic uses selected `toss-agentgateway.v1`; direct-provider profiles are development-only.
- No OpenAI, agentgateway, tracing, or HTTP client SDK dependency is added.
- Provider credentials never enter runtime memory; virtual tokens are in-memory only and never serialized, logged, reflected, cached to disk, or accepted through CLI arguments.
- Every provider operation requires exact `run_id`, provider `request_id`, and `TraceContext` before effects.
- HTTP redirects and caller-supplied headers are forbidden.
- Capability discovery and response bodies are bounded before allocation/parsing; SSE has total, event, line-buffer, and event-count limits.
- No automatic provider retry or gateway failover is implemented. Gateway-internal failover is accepted only after exact equivalent-capability attestation.
- Each production change follows a witnessed RED then GREEN cycle.
- Stage only named Issue #3 files; preserve unrelated user or concurrent changes.

---

### Task 1: Correlated Provider Wire Envelope and Canonical Route Identity

**Files:**

- Modify: `src/providers/types.ts`
- Modify: `src/providers/adapter.ts`
- Modify: `src/providers/contracts.ts`
- Modify: `src/providers/index.ts`
- Modify: `src/index.ts`
- Modify: `contracts/runtime/provider-event.v1.schema.json`
- Modify: `test/provider-adapter.test.ts`
- Modify: `test/provider-contracts.test.ts`
- Modify: `test/provider-conformance.test.ts`
- Modify: `test/package-metadata.test.ts`

**Interfaces:**

- Produces `ProviderRouteRequirement`, `ProviderRouteIdentity`, `ProviderWireResponse`, and `ProviderWireStream`.
- Changes `ProviderWireTransport.complete()` to return `Promise<ProviderWireResponse>` and `stream()` to return `Promise<ProviderWireStream>`.
- Makes `ProviderExecutionOptions` required and adds `run_id` plus `trace`.
- Adds `run_id`, `trace`, and `requirement` to `ProviderWireContext`.
- Adds `route_identity` to response-start data and `ProviderCompletion`.

- [ ] **Step 1: Write failing provider contract tests**

Add these exact concepts to `test/provider-contracts.test.ts`:

```ts
const routeIdentity: ProviderRouteIdentity = {
  transport: "agentgateway",
  gateway_profile: "gateway-production",
  gateway_revision: 7,
  route_id: "balanced-openai-primary",
  requested_model: "balanced-code",
  resolved_provider: "openai",
  resolved_model: "gpt-5",
  capability_document_hash: `sha256:${"a".repeat(64)}`,
  requirement_hash: `sha256:${"b".repeat(64)}`,
  gateway_request_id: "gw_req_1",
};

it("collects one closed agentgateway route identity", () => {
  const completion = collectProviderEvents([
    event(0, "response-start", { response_id: "resp_1", route_identity: routeIdentity }),
    event(1, "response-completed", { finish_reason: "stop" }),
  ]);
  expect(completion.route_identity).toEqual(routeIdentity);
  expect(Object.isFrozen(completion.route_identity)).toBe(true);
});

it.each(["authorization", "endpoint", "headers", "token"])(
  "rejects route identity native field %s",
  (field) => {
    const candidate = event(0, "response-start", {
      route_identity: { ...routeIdentity, [field]: "must-not-leak" },
    });
    expect(parseProviderEvent(canonicalJson(candidate)).ok).toBe(false);
  },
);
```

Update direct collector expectations to include `route_identity: null`.

- [ ] **Step 2: Write failing correlated adapter tests**

Change the fake transport to return wrappers and record context:

```ts
complete(input: JsonValue, context: ProviderWireContext): Promise<ProviderWireResponse> {
  this.calls.push({ kind: "complete", input, context });
  return Promise.resolve({ payload: this.completeResult, route_identity: null });
}

stream(input: JsonValue, context: ProviderWireContext): Promise<ProviderWireStream> {
  this.calls.push({ kind: "stream", input, context });
  return Promise.resolve({
    route_identity: null,
    events: (async function* () { await Promise.resolve(); })(),
  });
}
```

Use one shared required execution context in every provider test:

```ts
const execution = {
  run_id: "RUN-001",
  trace: {
    trace_id: "1".repeat(32),
    span_id: "2".repeat(16),
    trace_flags: 1,
  },
} satisfies ProviderExecutionOptions;
```

Add tests proving a missing/malformed run or trace rejects before transport,
the wire context receives exact identities, complete and stream wrappers inject
the same route identity, and a mapper cannot see route/header/native wrapper
properties.

- [ ] **Step 3: Run RED**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/provider-contracts.test.ts test/provider-adapter.test.ts test/provider-conformance.test.ts test/package-metadata.test.ts
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run typecheck
```

Expected: failures because route types/wrappers/correlation and schema fields do not exist and transport signatures still return native values.

- [ ] **Step 4: Implement provider-neutral types and schema**

Add these signatures to `src/providers/types.ts`:

```ts
export interface ProviderRouteRequirement {
  readonly schema_version: "gateway-route-requirement.v1";
  readonly alias: string;
  readonly tools: boolean;
  readonly json_schema: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  readonly streaming: boolean;
  readonly max_output_tokens: number;
}

export interface ProviderRouteIdentity {
  readonly transport: "agentgateway";
  readonly gateway_profile: string;
  readonly gateway_revision: number;
  readonly route_id: string;
  readonly requested_model: string;
  readonly resolved_provider: ProviderKind;
  readonly resolved_model: string;
  readonly capability_document_hash: `sha256:${string}`;
  readonly requirement_hash: `sha256:${string}`;
  readonly gateway_request_id: string | null;
}

export interface ProviderWireResponse {
  readonly payload: unknown;
  readonly route_identity: ProviderRouteIdentity | null;
}

export interface ProviderWireStream {
  readonly events: AsyncIterable<unknown>;
  readonly route_identity: ProviderRouteIdentity | null;
}
```

Make `ProviderExecutionOptions` contain required `run_id` and `trace`; make adapter options non-optional. Derive `ProviderRouteRequirement` in `adapter.ts` from the normalized request and stream flag. Validate run/trace with the protocol validator before creating the deadline scope. Race `transport.stream()` itself against abort, retain its iterator, and call iterator return in `finally` when consumption stops early.

Inject only the validated `route_identity` into the first response-start template. `collectProviderEvents()` stores that identity and returns `null` for direct transports. Extend the schema with a closed `$defs/route_identity` and allow it only in `$defs/start`.

- [ ] **Step 5: Update every fixture transport and call site**

Update `test/provider-conformance.test.ts`, package tests, and all adapter calls to pass `execution` and use wire wrappers. Direct fixture transports always return `route_identity: null`. Do not add optional legacy overloads.

- [ ] **Step 6: Run GREEN and commit**

Run the RED command again plus:

```bash
npm run lint
npx prettier --check src/providers contracts/runtime/provider-event.v1.schema.json test/provider-*.test.ts test/package-metadata.test.ts
```

Expected: provider tests, strict typecheck, lint, and scoped formatting pass.

Commit exact Task 1 files:

```bash
git add -- contracts/runtime/provider-event.v1.schema.json src/providers/types.ts src/providers/adapter.ts src/providers/contracts.ts src/providers/index.ts src/index.ts test/provider-adapter.test.ts test/provider-contracts.test.ts test/provider-conformance.test.ts test/package-metadata.test.ts
git diff --cached --check
git commit -m "feat: correlate provider wire responses"
```

---

### Task 2: Closed Gateway Capabilities and Production Profile Configuration

**Files:**

- Create: `contracts/runtime/agentgateway-capabilities.v1.schema.json`
- Create: `src/gateway/types.ts`
- Create: `src/gateway/contracts.ts`
- Create: `src/gateway/index.ts`
- Modify: `src/config/types.ts`
- Modify: `src/config/load.ts`
- Modify: `contracts/runtime/runtime-config.v1.schema.json`
- Modify: `src/protocol/validator.ts`
- Modify: `src/protocol/capabilities.ts`
- Modify: `contracts/runtime/runtime-capabilities.v1.schema.json`
- Modify: `docs/contracts/runtime-contract-v1.manifest.json`
- Modify: `examples/config/runtime.development.yaml`
- Create: `test/agentgateway-contracts.test.ts`
- Modify: `test/config.test.ts`
- Modify: `test/service-definition-store.test.ts`
- Modify: `test/service-supervisor.test.ts`
- Modify: `test/documentation-integrity.test.ts`
- Modify: `test/execution-chain.test.ts`

**Interfaces:**

- Produces `AgentgatewayProfileV1`, `AgentgatewayCapabilitiesV1`, `AgentgatewayRouteV1`, `AgentgatewayHealth`, `parseAgentgatewayCapabilities()`, `parseAgentgatewayHealth()`, `hashAgentgatewayCapabilities()`, and `selectedAgentgatewayProfile()`.
- Adds `gateway_profiles` to `RuntimeConfigV1` and baseline transport `agentgateway`.

- [ ] **Step 1: Write failing capability parser tests**

Create hand-authored capability bytes with two routes sharing alias `balanced-code`, one OpenAI and one Anthropic, canonical timestamps, revision 7, and a recomputed hash. Tests must assert:

```ts
const result = parseAgentgatewayCapabilities(bytes, { now });
expect(result.ok).toBe(true);
if (result.ok) {
  expect(result.value.routes).toHaveLength(2);
  expect(Object.isFrozen(result.value.routes[0]?.capabilities)).toBe(true);
}
```

Table-drive unknown fields, duplicate JSON keys, >512 KiB bytes, empty/>256 routes, duplicate route IDs, provider/capability mismatch, invalid chronology, expiry over five minutes, expired documents, negative/unsafe limits, unsupported provider, and hash mismatch. Add closed health parser cases for exact `{status, revision}` and reject native diagnostics/extra fields.

- [ ] **Step 2: Write failing production/development config tests**

Update the shared YAML builder to include:

```yaml
gateway_profiles: {}
```

Add explicit tests for:

- production selected HTTPS profile + command credential succeeds;
- selected profile missing, credential ref missing, env credential, HTTP, userinfo, query, fragment, and nonempty `provider_profiles` reject;
- development exact `127.0.0.1`, `[::1]`, and `localhost` HTTP succeed;
- development non-loopback HTTP rejects;
- defaults contain frozen empty `gateway_profiles`.

- [ ] **Step 3: Run RED**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/agentgateway-contracts.test.ts test/config.test.ts test/documentation-integrity.test.ts test/execution-chain.test.ts
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run typecheck
```

Expected: missing gateway files/schema/profile fields and baseline advertisement.

- [ ] **Step 4: Implement capability types, hashing, and parsing**

Define schema/type fields exactly as the spec. `hashAgentgatewayCapabilities()` canonicalizes with `document_hash` omitted and returns the existing `sha256:` form. `parseAgentgatewayCapabilities()` must use bounded `parseJsonBytes`, the protocol validator, semantic uniqueness/chronology/hash checks, and injected `now`. All safe messages are fixed and do not contain document values.

Implement health parsing through bounded JSON and exact own-data-property checks; getters, proxies, arrays, extra keys, and non-safe revision values reduce to unavailable at the client layer.

- [ ] **Step 5: Implement config profile semantics**

Add:

```ts
export interface AgentgatewayProfileV1 {
  readonly protocol: "toss-agentgateway.v1";
  readonly endpoint: string;
  readonly credential_reference: string;
  readonly body_observability: "off" | "redacted-metadata";
}
```

`assertConfig()` validates URL semantics after schema validation. Production resolves selected profile and credential reference, requires command source/HTTPS, and rejects direct provider profiles. Development permits HTTP only when `URL.hostname` is exactly `localhost`, `127.0.0.1`, or `::1`. Use `URL` parsing and fixed safe errors; never reflect the endpoint.

- [ ] **Step 6: Register and advertise the contract**

Register the schema/manifest entry, add `agentgateway-capabilities.v1` to supported schema enums/baseline, add `agentgateway` to provider transports, and update capability examples/assertions. Update every service/config fixture with `gateway_profiles: {}` without changing unrelated semantics.

- [ ] **Step 7: Run GREEN and commit**

Run the RED command, config/service-adjacent tests, lint, typecheck, and scoped formatting. Expected: all pass.

Commit exact Task 2 files:

```bash
git add -- contracts/runtime/agentgateway-capabilities.v1.schema.json contracts/runtime/runtime-config.v1.schema.json contracts/runtime/runtime-capabilities.v1.schema.json src/gateway/types.ts src/gateway/contracts.ts src/gateway/index.ts src/config/types.ts src/config/load.ts src/protocol/validator.ts src/protocol/capabilities.ts docs/contracts/runtime-contract-v1.manifest.json examples/config/runtime.development.yaml test/agentgateway-contracts.test.ts test/config.test.ts test/service-definition-store.test.ts test/service-supervisor.test.ts test/documentation-integrity.test.ts test/execution-chain.test.ts
git diff --cached --check
git commit -m "feat: validate agentgateway profiles and capabilities"
```

---

### Task 3: Short-Lived Virtual Credential Coordinator

**Files:**

- Create: `src/gateway/credentials.ts`
- Modify: `src/gateway/types.ts`
- Modify: `src/gateway/index.ts`
- Create: `test/agentgateway-credentials.test.ts`

**Interfaces:**

- Consumes `SecretReference` from config.
- Produces `GatewayCredentialProvider`, `GatewayCredentialLease`, and `createGatewayCredentialCoordinator()`.

- [ ] **Step 1: Write failing lease validation and single-flight tests**

Use fake time and a resolver counter. Cover exact valid reuse, refresh at 29,999 ms remaining, two concurrent callers causing one resolver call, different references using different coordinators, aborted resolution, and resolver rejection.

Table-drive token lengths 15/8193, space, tab, CR, LF, NUL, invalid scheme, malformed/noncanonical timestamp, expired lease, accessor, symbol, and proxy traps. Every rejection must equal `RUNTIME_PROVIDER_AUTHENTICATION` and omit the sentinel token/message.

- [ ] **Step 2: Run RED**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/agentgateway-credentials.test.ts
```

Expected: module/types/factory missing.

- [ ] **Step 3: Implement minimal coordinator**

Use this internal signature:

```ts
export interface GatewayCredentialProvider {
  resolve(
    reference: SecretReference,
    options: { readonly signal: AbortSignal; readonly minimum_validity_ms: 30_000 },
  ): Promise<unknown>;
}

export function createGatewayCredentialCoordinator(options: {
  readonly provider: GatewayCredentialProvider;
  readonly now: () => Date;
}): {
  resolve(reference: SecretReference, signal: AbortSignal): Promise<GatewayCredentialLease>;
  clear(): void;
};
```

Read untrusted leases only with own data descriptors. Validate through a plain frozen projection. Key the process-wide single-flight/cache by canonical JSON of the exact reference. Do not include token/reference values in errors. `clear()` drops cache/in-flight references and is used during shutdown/tests; it does not claim memory zeroization.

Export the safe `GatewayCredentialProvider` and `GatewayCredentialLease` types from `src/gateway/index.ts`, but do not export `createGatewayCredentialCoordinator()` from the top-level package. `createAgentgatewayTransport()` constructs and owns the coordinator internally.

- [ ] **Step 4: Run GREEN and commit**

Run focused tests, typecheck, lint, and scoped formatting. Commit:

```bash
git add -- src/gateway/credentials.ts src/gateway/types.ts src/gateway/index.ts test/agentgateway-credentials.test.ts
git diff --cached --check
git commit -m "feat: coordinate short-lived gateway credentials"
```

---

### Task 4: Authenticated Capability Discovery and Health Client

**Files:**

- Create: `src/gateway/client.ts`
- Create: `src/gateway/errors.ts`
- Modify: `src/gateway/types.ts`
- Modify: `src/gateway/index.ts`
- Create: `test/agentgateway-client.test.ts`
- Create: `test/helpers/fake-agentgateway.ts`

**Interfaces:**

- Consumes validated profile, selected profile name, credential coordinator, injected `fetch`, and clock.
- Produces `AgentgatewayClient.discover(signal)` and `health()`.
- Establishes shared bounded body and fixed-header helpers later consumed by transport.

- [ ] **Step 1: Write failing real loopback client tests**

The fake server stores captured method/path/headers and returns hand-authored capability/health bytes. Assert exact paths, `Authorization: Bearer virtual-token`, and no caller/native headers. Use the injected fetch seam in a separate test to assert `redirect: "error"`. Assert capability bytes over 512 KiB reject before parsing. Assert redirects, 401/403, 404, 429, 502/503/504, malformed JSON, and connection failure map to stable safe codes without body/token reflection. Health malformed/non-2xx returns `{status:"unavailable"}` and never throws native diagnostics.

- [ ] **Step 2: Run RED**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/agentgateway-client.test.ts
```

Expected: client and fake gateway helper missing.

- [ ] **Step 3: Implement bounded fetch client**

Define an injectable fetch type from the exact parameters used, not the global implementation class. Resolve fixed profile paths with `new URL(relative, normalizedBase)`. Build headers from a new `Headers` instance with only `accept` and `authorization`. Use a `readBoundedResponse(response, maxBytes)` loop over `response.body.getReader()`; cancel on overflow/error. Never call unrestricted `response.text()` or `response.json()`.

Classify status before reading error bodies. Capability success parses through `parseAgentgatewayCapabilities`. Health accepts only the closed health document and returns a frozen status.

- [ ] **Step 4: Run GREEN and commit**

Run focused tests, credential/contract/config regressions, typecheck, lint, formatting. Commit:

```bash
git add -- src/gateway/client.ts src/gateway/errors.ts src/gateway/types.ts src/gateway/index.ts test/agentgateway-client.test.ts test/helpers/fake-agentgateway.ts
git diff --cached --check
git commit -m "feat: discover agentgateway health and routes"
```

---

### Task 5: Correlated Non-Streaming Responses and Route Attestation

**Files:**

- Create: `src/gateway/transport.ts`
- Create: `src/gateway/attestation.ts`
- Modify: `src/gateway/types.ts`
- Modify: `src/gateway/errors.ts`
- Modify: `src/gateway/index.ts`
- Modify: `src/providers/errors.ts`
- Modify: `src/providers/index.ts`
- Modify: `src/index.ts`
- Create: `test/agentgateway-transport.test.ts`
- Modify: `test/helpers/fake-agentgateway.ts`

**Interfaces:**

- Produces `createAgentgatewayTransport()` implementing `ProviderWireTransport`.
- Produces `hashProviderRouteRequirement()` and internal exact attestation parser.
- Adds gateway stable error codes from the spec.

- [ ] **Step 1: Write failing trace/request/attestation integration**

Configure fake capability alias `balanced-code` and a successful `/v1/responses` response with exact headers. Call the existing OpenAI adapter with gateway transport and assert captured headers:

```ts
expect(captured.headers).toMatchObject({
  traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
  tracestate: "toss=opaque",
  "x-toss-run-id": "RUN-001",
  "x-toss-request-id": request.request_id,
  "x-toss-capability-revision": "7",
  "x-toss-capability-document-sha256": capability.document_hash,
  "x-toss-requirement-sha256": expectedRequirementHash,
});
```

Assert completion route identity exactly matches the attestation and contains no header/URL/token/body object.

- [ ] **Step 2: Write failing attestation mutation matrix**

Table-drive missing/duplicate/control-bearing/oversized headers, revision/hash/requirement mismatch, unknown route, alias mismatch, provider/model mismatch, malformed gateway request ID, and weaker capability. Exact equivalent secondary route must pass. Every failed successful-body case must throw gateway-invalid or capability-downgrade before mapper completion is returned.

- [ ] **Step 3: Run RED**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/agentgateway-transport.test.ts test/provider-adapter.test.ts
```

Expected: transport/attestation/errors missing.

- [ ] **Step 4: Implement stable gateway errors and requirement hash**

Add exact error details:

```ts
RUNTIME_PROVIDER_ROUTE_NOT_FOUND: ["unsupported-capability", false, "Gateway route was not found"];
RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE: ["unavailable", true, "Agentgateway is unavailable"];
RUNTIME_PROVIDER_CAPABILITY_DOWNGRADE: [
  "integrity",
  false,
  "Gateway route capability was downgraded",
];
RUNTIME_PROVIDER_GATEWAY_INVALID: ["integrity", false, "Agentgateway response is invalid"];
```

Derive and canonical-hash `ProviderRouteRequirement`; do not infer from the translated native body.

- [ ] **Step 5: Implement non-stream transport**

Flow in exact order: validate context/profile → resolve credential → discover capabilities → locate at least one satisfying alias route → compute requirement hash → build fixed headers/body → fetch with redirect error/signal → classify HTTP → parse attestation from allowlisted own header values → bounded-read JSON payload → return `{payload, route_identity}`.

Limit JSON response to 8 MiB. Observation is still off in this task. The route identity is a fresh frozen plain object.

- [ ] **Step 6: Run GREEN and commit**

Run focused gateway/provider tests, typecheck, lint, formatting. Commit:

```bash
git add -- src/gateway/transport.ts src/gateway/attestation.ts src/gateway/types.ts src/gateway/errors.ts src/gateway/index.ts src/providers/errors.ts src/providers/index.ts src/index.ts test/agentgateway-transport.test.ts test/helpers/fake-agentgateway.ts
git diff --cached --check
git commit -m "feat: attest agentgateway response routes"
```

---

### Task 6: Bounded SSE Streaming, Cancellation, and Consumer Cleanup

**Files:**

- Create: `src/gateway/sse.ts`
- Modify: `src/gateway/transport.ts`
- Modify: `src/gateway/index.ts`
- Modify: `test/agentgateway-transport.test.ts`
- Modify: `test/helpers/fake-agentgateway.ts`

**Interfaces:**

- Produces internal `parseBoundedSse(body, signal): AsyncIterable<JsonValue>`.
- Completes `ProviderWireTransport.stream()` as `Promise<ProviderWireStream>`.

- [ ] **Step 1: Write failing streaming equivalence test**

The fake server emits OpenAI Responses SSE with CRLF framing, comment/`event:` fields, split UTF-8 chunks, terminal `[DONE]`, and exact attestation headers. Assert stream and complete close to the same canonical completion and route identity.

- [ ] **Step 2: Write failing framing/lifecycle tests**

Cover 8 MiB total+1, 1 MiB event+1, 10,001 events, invalid UTF-8, invalid JSON, truncated line/event, data after `[DONE]`, stream end without normalized terminal, abort while blocked, timeout whose native abort rejection must not win, consumer break after first event, and parser failure. Assert body cancel/reader release/iterator return occurs exactly once and secrets/native body are not reflected.

- [ ] **Step 3: Run RED**

Run the streaming-name target in `test/agentgateway-transport.test.ts`; expected missing SSE stream behavior.

- [ ] **Step 4: Implement SSE parser and stream transport**

Use one fatal streaming `TextDecoder`, byte counters before decode, a bounded string line buffer, SSE blank-line dispatch, concatenated `data:` lines with `\n`, and ignore only `:`, `event:`, `id:`, and `retry:` framing fields. `[DONE]` is terminal and must be last. Each data value is parsed through bounded plain JSON.

Validate response status/content type/attestation before returning `{route_identity, events}`. The iterable owns the body reader and cancels/releases it in `finally`. The generic provider adapter owns the returned iterable and calls return on early consumer termination.

- [ ] **Step 5: Run GREEN and commit**

Run gateway transport plus provider adapter/conformance tests, typecheck, lint, formatting. Commit:

```bash
git add -- src/gateway/sse.ts src/gateway/transport.ts src/gateway/index.ts test/agentgateway-transport.test.ts test/helpers/fake-agentgateway.ts
git diff --cached --check
git commit -m "feat: stream bounded agentgateway events"
```

---

### Task 7: Failure Source Matrix and Redacted Opt-In Observability

**Files:**

- Modify: `src/gateway/errors.ts`
- Modify: `src/gateway/transport.ts`
- Modify: `src/gateway/types.ts`
- Modify: `src/gateway/index.ts`
- Modify: `test/agentgateway-transport.test.ts`
- Create: `test/agentgateway-observability.test.ts`

**Interfaces:**

- Produces closed `GatewayObservation` and `onObservation` option.
- Finalizes HTTP status/source classification without reading native error bodies.

- [ ] **Step 1: Write failing error-source table**

Table-drive 401/403 auth; 404 route; 429 rate; gateway 502/503/504 unavailable; provider-sourced 500 transient; missing/invalid `x-toss-error-source` gateway unavailable; timeout/cancel; and unknown 4xx invalid. Include secret sentinels in body/headers and assert fixed errors contain none.

- [ ] **Step 2: Write failing observation tests**

For `off`, assert callback count zero. For `redacted-metadata`, assert exact frozen keys only:

```ts
{
  run_id,
  request_id,
  route_id,
  streaming,
  request_bytes,
  response_bytes,
  message_count,
  content_block_count,
  tool_count,
  status_class,
  duration_ms,
}
```

Assert absence of prompts, tool names/schema/arguments, model output, URLs, hashes of content, token, authorization, environment, headers, and native error strings. Throwing callback must not change the provider result.

- [ ] **Step 3: Run RED**

Run transport and observability files. Expected missing/failing classification and observation behavior.

- [ ] **Step 4: Implement classification and observation**

Read only allowlisted scalar headers with own-data semantics. Classify status before body. Build request structure counts from the already-normalized plain wire request without copying content strings. Measure bytes from encoded request and bounded response counters. Use injected monotonic millisecond clock for duration. Invoke observation only after result/failure classification inside an isolated try/catch.

- [ ] **Step 5: Run GREEN and commit**

Run all gateway/provider/config tests, typecheck, lint, formatting. Commit:

```bash
git add -- src/gateway/errors.ts src/gateway/transport.ts src/gateway/types.ts src/gateway/index.ts test/agentgateway-transport.test.ts test/agentgateway-observability.test.ts
git diff --cached --check
git commit -m "feat: redact agentgateway observations"
```

---

### Task 8: Public Surface, Documentation, Package Acceptance, and Delivery

**Files:**

- Modify: `src/gateway/index.ts`
- Modify: `src/index.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/contracts/runtime-contract-protocol-v1.md`
- Modify: `docs/contracts/runtime-contract-v1.manifest.json`
- Modify: `examples/config/runtime.development.yaml`
- Modify: `examples/runtime-contract-v1/provider-event.json`
- Modify: `scripts/package-files.json`
- Modify: `test/package-metadata.test.ts`
- Modify: `test/documentation-integrity.test.ts`
- Modify: `test/unavailable-boundaries.test.ts`

**Interfaces:**

- Publicly exports safe gateway profile/capability/route/health/credential-provider/observation types and factories.
- Does not export raw header/SSE/parser/fetch internals or credential coordinator cache access.

- [ ] **Step 1: Write failing public/package/docs assertions**

Assert the top-level package exports `createAgentgatewayTransport`, `parseAgentgatewayCapabilities`, `hashAgentgatewayCapabilities`, and safe types. Assert it does not export internal SSE parser, attestation parser, header reader, credential cache, raw token lease map, or fake gateway helper. Update manifest/example parsing assertions and expected package list only after watching contents-only fail.

- [ ] **Step 2: Run RED package/docs gate**

Run:

```bash
npm run build
npm test -- test/package-metadata.test.ts test/documentation-integrity.test.ts
npm run test:package:contents
```

Expected: public/docs/package assertions fail and new build files differ from `scripts/package-files.json`.

- [ ] **Step 3: Complete docs and exact package allowlist**

Document production gateway-only behavior, fixed paths/headers, virtual-token boundary, correlation, capability discovery, attestation, downgrade rejection, error table, observability policy, no retry, and downstream issue ownership. Keep protected live smoke explicitly pending #15. Add schema/source/declaration/runtime build outputs and no test fixture to `scripts/package-files.json` in sorted order.

- [ ] **Step 4: Run fresh focused acceptance**

Run under Node 22.23.1:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/agentgateway-*.test.ts test/provider-*.test.ts test/config.test.ts test/execution-chain.test.ts test/documentation-integrity.test.ts test/package-metadata.test.ts
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run typecheck
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run lint
```

Expected: all focused tests and static checks pass.

- [ ] **Step 5: Run full Node 22 and Node 24 acceptance**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run verify
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js audit --omit=dev --audit-level=high
npm exec --yes --package=node@24.19.0 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run verify
npm exec --yes --package=node@24.19.0 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js audit --omit=dev --audit-level=high
git diff --check
git status --short
```

Expected: format/lint/typecheck/build/all tests/installed package acceptance pass on both Node lines, audits report zero production vulnerabilities, diff check is clean, and only intended Issue #3 changes remain before commit.

- [ ] **Step 6: Commit, push, and complete GitHub delivery**

Commit exact Task 8 files:

```bash
git add -- src/gateway/index.ts src/index.ts README.md CHANGELOG.md docs/contracts/runtime-contract-protocol-v1.md docs/contracts/runtime-contract-v1.manifest.json examples/config/runtime.development.yaml examples/runtime-contract-v1/provider-event.json scripts/package-files.json test/package-metadata.test.ts test/documentation-integrity.test.ts test/unavailable-boundaries.test.ts
git diff --cached --check
git commit -m "docs: publish agentgateway transport contract"
```

Push `issue/3-agentgateway-transport`, mark PR #45 ready, wait for exact-head macOS Node 22.23.1 and Node 24 checks, and inspect any failure rather than rerunning blindly. When both pass and every Issue #3 criterion is evidenced:

1. Check every issue and PR acceptance box and add exact local/CI evidence.
2. Mark the Issue #3 and PR #45 project items Done.
3. Close Issue #3 before merge.
4. Merge PR #45 into `release/v1.0.0` with a merge commit.
5. Update Epic #16 delivery and integration lines with the exact merge commit.
6. Fetch the release branch and verify its remote head equals the PR merge commit.
