# Runtime Contract Protocol v1

## 1. Status and normative language

This document defines `runtime-contract.v1` for communication between the TOSS control plane and TOSS Agent Runtime. “MUST”, “MUST NOT”, “SHOULD”, and “MAY” are normative requirements. The JSON Schemas listed in `runtime-contract-v1.manifest.json` are part of this contract.

The control plane owns governance decisions, authoritative project artifacts, policy selection, and acceptance. The runtime owns execution mechanics and produces a tamper-evident journal and terminal result. Runtime output is execution evidence, not governance authority.

## 2. Envelope and ownership

Every protocol document is a closed JSON object. Unknown fields MUST be rejected. The three discriminators have independent purposes:

| Field              | Meaning                                             |
| ------------------ | --------------------------------------------------- |
| `protocol_version` | Compatibility family; exactly `runtime-contract.v1` |
| `schema_version`   | Exact document schema selected before validation    |
| `document_type`    | Semantic document kind                              |

The control plane creates `execution-request.v1`. A runtime or delegated component creates `execution-event.v1`. The runtime creates `execution-result.v1` and `runtime-capabilities.v1`. A producer identity records origin; it does not grant governance authority.

## 3. Validation and trust boundary

Untrusted input MUST pass these stages in order:

1. Parse bounded UTF-8 JSON with comments and trailing commas disabled. Reject duplicate keys, excessive bytes, excessive depth, excessive members, invalid numbers, accessors, symbols, non-plain prototypes, and sparse arrays.
2. Select the exact registered schema from `schema_version`. Unknown protocol or schema versions fail closed. Validate the closed JSON Schema without coercion, defaults, or removal of unknown fields.
3. Apply semantic validation: time ordering, unique canonical input revisions, content hashes, journal continuity, run/trace identity, terminal linkage, normalized sensitive-metadata keys, coherent capability availability, and exact negotiated profiles.

Successful library parsing returns a deeply frozen value. A caller MUST NOT treat TypeScript types or an unchecked cast as validation.

An artifact reference is the tuple `document_type`, `artifact_id`, positive `revision`, SHA-256 `hash`, and optional repository-relative `location`. It identifies exact content; it does not embed content or delegate authority. A location is a hint within the authorized project boundary and MUST NOT contain an absolute path, backslash, or parent traversal.

## 4. Canonical hashing and journal linkage

Canonical JSON recursively sorts object keys, preserves array order, normalizes negative zero to zero, and emits standard JSON without insignificant whitespace. Hashes have the form `sha256:` followed by 64 lowercase hexadecimal characters.

- `request_hash` is SHA-256 over the complete canonical execution request.
- `event_hash` is SHA-256 over the complete event excluding only `event_hash` itself.
- The first event uses 64 zeroes as `previous_event_hash`; every later event uses the previous event’s `event_hash`.
- `sequence` starts at 1 and increases by one. `run_revision` starts at 1 and increases by one.
- The result’s `journal_head` MUST equal the final event’s sequence, run revision, and hash.

Changing a request, event, or order invalidates the chain. Hash integrity proves linkage, not truth, authorization, or acceptance.

### Durable run-journal entries

`run-journal-entry.v1` is the private durable execution-state record. Each
canonical entry carries contiguous `sequence` and `journal_revision` values,
the exact `previous_entry_hash`, a monotonic run attempt, previous and next
state, command/input identities, safe metadata, and an optional side-effect
intent or completion. The entry hash excludes only `entry_hash`; the first
previous hash is `sha256:` plus 64 zeroes.

Transitions require the exact expected revision and head hash. A stale head
fails as `RUNTIME_STATE_STALE`; a state outside the closed transition matrix
fails as `RUNTIME_STATE_TRANSITION_INVALID`; reusing a command or side-effect
identity with different canonical input fails as `RUNTIME_OPERATION_CONFLICT`.
An exact repeated command returns the already published entry and appends no
bytes. Provider/tool intent is synchronized before the effect, and an
unresolved intent is returned for reconciliation rather than automatically
repeated.

Private journals are current-user `0600` JSONL beneath current-user `0700`
state directories. Public store instances that resolve to the same canonical
state root share one process-wide per-run writer queue; cross-process journal
writers remain unsupported and the supervised runtime's instance lock excludes
them. Initial publication, append, recovery, and replay require exact private
file and directory-ancestry identities plus successful file and run-directory
durability barriers. Each journal is bounded at 64 MiB; an initial publication
or append that would exceed the bound fails before journal growth. Startup
validates every complete line and the full chain. A nonempty unterminated tail
after at least one complete entry is unpublished: it is copied byte-for-byte
to a private synchronized quarantine artifact before the exact valid prefix is
restored. An unterminated first entry, invalid complete content, or an interior
chain break blocks that run without being skipped or truncated and does not
invalidate unrelated verified runs.

### Project registry and candidate intents

`project-watch-manifest.v1` is the closed, explicit input that selects one or
more project-relative watch paths and optional ignore paths. Registration binds
that manifest hash to a stable project UUID, canonical root, and append-only
`project-registry-entry.v1` revision chain. The runtime MUST NOT discover or
scan unregistered projects. Watch and ignore paths MUST NOT be absolute, escape
the registered root, traverse symlinks, include `.git` or `.toss/runtime`, or
reach runtime-owned state.

Every state-changing registry entry binds one UUID operation ID and the SHA-256
hash of its canonical command input. An exact operation replay returns its
persisted result across daemon restarts without appending a new revision. Reuse
of an operation ID for different input fails closed. This durable replay rule is
independent of the live control socket's bounded request-ID cache.

Normalized file changes are bytewise sorted and recorded in
`candidate-job-intent.v1`. Its `candidate_key` hashes the exact project ID,
registry revision, manifest hash, and normalized changes. Repeating the same
key appends no second candidate. A missing, moved, or identity-replaced root is
recorded as `BLOCKED_PROJECT_UNAVAILABLE`; the runtime MUST NOT relocate it.

A candidate job intent is intake evidence only. It does not authorize
execution, satisfy approval, choose routing or providers, invoke tools, mutate
authoritative project artifacts, or constitute acceptance. Every governance
decision remains with the control plane.

## 5. Capability handshake and compatibility

Before execution, the consumer obtains `runtime-capabilities.v1` and negotiates the request. It MUST confirm the protocol, request schema, logical model class, every required model capability, every required Superpowers capability, an MCP transport, the exact MCP profile identity, and the required execution topology. Every execution-critical feature state MUST be `available`; `blocked` and `unavailable` fail negotiation.

Unknown major protocol versions MUST fail closed. Unknown schema versions MUST fail closed. Additive capability values are usable only after explicit negotiation; absence means unavailable. New optional fields require a new schema version because v1 objects are closed. A breaking field or semantic change requires a new major protocol family.

The baseline capability document truthfully marks later subsystems unavailable. A producer MUST NOT advertise a provider, transport, model class, skill host, MCP transport, topology, or feature before it can satisfy that contract. Availability and resources are bidirectionally coherent: an `available` provider feature requires at least one provider transport; routing requires an available provider plus a model class; skills require a host version and Superpowers capability; MCP requires a transport and the exact requested profile; and agent-loop or review availability requires a topology. Conversely, a subsystem marked `unavailable` cannot advertise its corresponding resources.

## 6. `execution-request.v1`

| Field                         | Required semantics                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `protocol_version`            | Exactly `runtime-contract.v1`                                                                      |
| `schema_version`              | Exactly `execution-request.v1`                                                                     |
| `document_type`               | Exactly `execution-request`                                                                        |
| `request_id`                  | Stable request correlation identifier                                                              |
| `run_id`                      | Stable identity shared by the complete chain                                                       |
| `created_at`                  | UTC request creation time                                                                          |
| `deadline`                    | UTC time strictly later than `created_at`                                                          |
| `task_contract`               | Exact authoritative Task Contract reference                                                        |
| `input_artifacts`             | Ordered, exact ACP input references; artifact ID/revision pairs are unique across canonical inputs |
| `agent.definition`            | Exact Agent Definition reference                                                                   |
| `agent.role`                  | Requested role interpreted under referenced policy                                                 |
| `model.logical_class`         | Logical class, not a raw provider model override                                                   |
| `model.required_capabilities` | Capabilities that all must be negotiated                                                           |
| `superpowers.required`        | Superpowers capabilities that all must be negotiated                                               |
| `mcp.profile`                 | Exact MCP profile reference; not an arbitrary server configuration                                 |
| `budget`                      | Maximum input/output tokens, cost in micro-USD, duration, and turns                                |
| `review_policy`               | Exact Review Policy reference                                                                      |
| `output.schema`               | Exact required output-schema reference                                                             |
| `trace`                       | Trace ID, span ID, flags, and optional trace state                                                 |

Request references constrain execution. They MUST NOT be interpreted as permission to revise policies, accept outputs, alter authoritative artifacts, expand filesystem scope, change egress rules, or obtain secrets outside referenced profiles.

## 7. `execution-event.v1`

| Field                 | Required semantics                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `protocol_version`    | Exactly `runtime-contract.v1`                                                                        |
| `schema_version`      | Exactly `execution-event.v1`                                                                         |
| `document_type`       | Exactly `execution-event`                                                                            |
| `run_id`              | Matches the request run identity                                                                     |
| `request_hash`        | Matches the canonical request hash                                                                   |
| `sequence`            | Contiguous one-based journal position                                                                |
| `run_revision`        | Contiguous one-based optimistic revision                                                             |
| `previous_event_hash` | Zero hash for the first event; otherwise previous event hash                                         |
| `event_hash`          | Hash of canonical event content excluding this field                                                 |
| `event_type`          | One member of the v1 event vocabulary                                                                |
| `timestamp`           | UTC event production time                                                                            |
| `producer`            | Component kind, name, version, and optional exact revision/hash                                      |
| `trace`               | Same trace identity as the request, with event span context                                          |
| `input_reference`     | Exact input whose handling produced the event                                                        |
| `payload`             | Bounded canonical JSON; the producer must apply event-specific allowlisting and structural redaction |

The event vocabulary is `CREATED`, `ROUTED`, `RUNNING`, `MODEL_STARTED`, `MODEL_DELTA`, `MODEL_COMPLETED`, `TOOL_PENDING`, `APPROVAL_PENDING`, `APPROVAL_RECORDED`, `TOOL_COMPLETED`, `REVIEW_PENDING`, `REVIEW_COMPLETED`, `COMPLETED`, `FAILED`, `BLOCKED`, `CANCELLED`, and `INTERRUPTED`. A valid event schema does not by itself prove a legal state transition; the versioned transition policy supplies that rule.

## 8. `execution-result.v1`

| Field              | Required semantics                                                        |
| ------------------ | ------------------------------------------------------------------------- |
| `protocol_version` | Exactly `runtime-contract.v1`                                             |
| `schema_version`   | Exactly `execution-result.v1`                                             |
| `document_type`    | Exactly `execution-result`                                                |
| `run_id`           | Matches request and event run identity                                    |
| `request_hash`     | Matches the canonical request hash                                        |
| `journal_head`     | Exact final event sequence, revision, and hash                            |
| `status`           | `COMPLETED`, `FAILED`, `BLOCKED`, `CANCELLED`, or `INTERRUPTED`           |
| `finished_at`      | UTC time not earlier than the final event                                 |
| `outputs`          | Exact references to produced artifacts; never implicit acceptance         |
| `error`            | Normalized safe error or `null`                                           |
| `usage`            | Input/output tokens, nullable micro-USD cost, elapsed duration, and turns |
| `evidence`         | Exact evidence artifact references                                        |
| `trace`            | Same trace identity as the request                                        |

For a successful completion, `error` is `null`. Failure details use a stable code, category, retryability flag, safe message, and optional canonical JSON metadata. Error metadata MUST NOT contain secrets, raw provider bodies, or unrestricted environment data. The producer, not JSON Schema, is responsible for classifying values before persistence.

## 9. `runtime-capabilities.v1`

| Field                      | Required semantics                                                |
| -------------------------- | ----------------------------------------------------------------- |
| `protocol_version`         | Exactly `runtime-contract.v1`                                     |
| `schema_version`           | Exactly `runtime-capabilities.v1`                                 |
| `document_type`            | Exactly `runtime-capabilities`                                    |
| `runtime`                  | Runtime producer identity                                         |
| `package`                  | Exact package name and running version                            |
| `platform`                 | `darwin` or `linux`, architecture, and Node version               |
| `supported_protocols`      | Protocol families accepted by this runtime                        |
| `supported_schemas`        | Exact document schema versions accepted                           |
| `provider_transports`      | Implemented provider transports                                   |
| `model_classes`            | Logical classes and capabilities offered                          |
| `skill_host_versions`      | Implemented Agent Skills host versions                            |
| `superpowers_capabilities` | Implemented Superpowers capabilities                              |
| `mcp_transports`           | Implemented MCP transports                                        |
| `mcp_profiles`             | Exact MCP profile identities available for negotiation            |
| `execution_topologies`     | Implemented orchestration topologies                              |
| `features`                 | `available`, `unavailable`, or `blocked` state for each subsystem |

`blocked` means the implementation exists but policy or environment prevents its use. `unavailable` means the runtime cannot supply it. Neither state may be treated as success.

Feature state and resource declarations MUST agree in both directions. A consumer rejects an available feature with no usable supporting resource, as well as an unavailable feature that advertises one. Provider and routing state are independent: provider transports correspond to the provider feature, while model classes correspond to routing, so a provider transport may be advertised before routing becomes available.

## 10. Secrets and logging

Dedicated credential fields have no representation for raw provider tokens, passwords, private keys, credential blobs, or arbitrary environment maps. Configuration uses named secret references only. Event payload and error metadata can contain generic JSON strings, so schema validation alone cannot prove that a value under an innocuous key is non-secret.

Before serialization, every producer MUST construct free-form metadata from an event-specific field allowlist, tag secret-bearing values at resolution, and structurally replace or omit them. Parsers additionally normalize case, camelCase, and separators and reject secret- or governance-authority-shaped keys as defense in depth. A consumer MUST NOT interpret successful parsing as proof that an arbitrary string is safe to disclose. Secret resolution occurs at the last responsible boundary and resolved values MUST NOT enter protocol documents, canonical hashes, journals, command results, logs, evidence, or diagnostics.

Operational events use the closed `operational-event.v1` envelope with a canonical event ID, UTC timestamp, service-instance ID and monotonic service sequence, level, component, event name, correlation ID, optional project/job/run IDs, and primitive allowlisted metadata. Operational logs are distinct from run journals and acceptance evidence. One supervised writer appends complete synchronized JSON lines, rotates before the configured 100 MiB or UTC-day boundary, and deletes only recognized closed operational files older than seven days or beyond the 100 MiB aggregate budget.

`toss-runtime logs` reads the same event identities in deterministic human or JSON form. Level is a minimum severity; project and run filters are exact. Follow mode is human-only and deduplicates an inode across active-file rotation. A partial final active line is ignored and reported until recovery; an invalid interior line is corrupt. Storage, synchronization, rotation, or retention failure enters sticky `RUNTIME_LOGGING_DEGRADED` state until an explicit successful recovery. Required state-changing operations MUST NOT acknowledge success when their required log event is not durable.

### Normalized provider boundary

`provider-event.v1` is the only public provider event envelope. It binds a canonical event/request identity, provider, selected model, contiguous sequence, UTC time, closed event type, normalized data, and safe provenance. Event variants are response start, content delta, tool-call delta, usage, completion, and normalized error. Provenance records only the native event type and sorted safe names of provider-specific fields that were deliberately dropped; raw native values are forbidden.

OpenAI, Anthropic, and Gemini adapters accept the same bounded provider-neutral request and expose the same event stream and canonical completion. Capability preflight occurs before the injected wire transport and covers tools, JSON schema, vision, reasoning, streaming, and output limits. The completion collector rejects identity/sequence changes, missing or duplicate terminals, post-terminal events, malformed tool arguments, and inconsistent stable errors. Streaming and non-streaming paths MUST close to the same completion semantics.

The adapter boundary performs no automatic retry and owns no credential lookup. Authentication, rate limit, timeout, cancellation, refusal, transient unavailability, invalid input, and internal failure are distinct stable codes with fixed retryability. Native SDK objects, headers, endpoints, error messages, credentials, stacks, and unrestricted response objects MUST NOT enter provider events, journals, results, operational logs, or evidence. Authenticated agentgateway transport is the separate governed transport layer; the pure governed routing boundary plans attempts and state transitions without invoking either transport or provider.

### Authenticated agentgateway transport

Production configuration MUST select exactly one named HTTPS profile whose protocol is `toss-agentgateway.v1`, MUST resolve that profile through one named command-backed secret reference, and MUST NOT configure direct provider profiles. Development MAY use exact loopback HTTP. The endpoint is a base URL for only `/healthz`, `/v1/toss/capabilities`, and `/v1/responses`. Redirect following is disabled; a redirect, origin change, unsafe endpoint, or unexpected response URL fails closed.

Credential resolution returns a short-lived virtual Bearer lease. A lease is reused only while at least 30 seconds remain. Token values, raw provider credentials, resolver diagnostics, headers, bodies, and credential-cache state MUST NOT enter configuration output, public API values, provider events, journals, logs, errors, observations, or evidence.

Each provider operation obtains a fresh, bounded `agentgateway-capabilities.v1` document, verifies its canonical hash and lifetime, and requires at least one alias route to satisfy tools, JSON Schema, vision, reasoning, streaming, and output-token requirements. The Responses request sends only `Authorization`, `Content-Type`, `Accept`, `traceparent`, optional `tracestate`, `x-toss-run-id`, `x-toss-request-id`, `x-toss-capability-revision`, `x-toss-capability-document-sha256`, and `x-toss-requirement-sha256`. Callers cannot add headers.

Every successful response MUST attest one known route through the allowlisted `x-toss-route-id`, `x-toss-resolved-provider`, `x-toss-resolved-model`, capability revision/hash, requirement hash, and optional gateway request ID fields. The attested route MUST satisfy the original requirement and MUST match the fresh capability document. Unknown, missing, duplicated, mutated, or weaker attestations fail with `RUNTIME_PROVIDER_CAPABILITY_DOWNGRADE` or `RUNTIME_PROVIDER_GATEWAY_INVALID`; they never reach provider normalization.

JSON and SSE responses are bounded to 8 MiB total. SSE additionally permits at most 1 MiB per event and 10,000 events, requires fatal UTF-8 decoding and one terminal event, and rejects trailing data. Cancellation, timeout, consumer termination, malformed content, and overflow close the native response body. The transport never retries automatically.

Body observability is `off` by default. `redacted-metadata` permits only a frozen structural observation containing run/request IDs, route ID, streaming flag, encoded byte totals, message/content/tool counts, status class, and monotonic duration. It MUST NOT contain request/response content, tokens, headers, endpoints, provider diagnostics, or raw status text. Observation callback failure does not alter the provider result.

| Stable code                             | Meaning                                      | Retryable |
| --------------------------------------- | -------------------------------------------- | --------- |
| `RUNTIME_PROVIDER_AUTHENTICATION`       | Credential or gateway authentication failed  | no        |
| `RUNTIME_PROVIDER_ROUTE_NOT_FOUND`      | The requested alias has no route             | no        |
| `RUNTIME_PROVIDER_RATE_LIMIT`           | The gateway returned rate limiting           | yes       |
| `RUNTIME_PROVIDER_TIMEOUT`              | The provider operation timed out             | yes       |
| `RUNTIME_PROVIDER_CANCELLED`            | The operation was cancelled                  | no        |
| `RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE`  | The gateway or transport is unavailable      | yes       |
| `RUNTIME_PROVIDER_TRANSIENT`            | The upstream provider is transiently down    | yes       |
| `RUNTIME_PROVIDER_CAPABILITY_DOWNGRADE` | The selected route is weaker than required   | no        |
| `RUNTIME_PROVIDER_GATEWAY_INVALID`      | The gateway response failed integrity checks | no        |

Governed catalog, routing, budget, circuit, fallback-planning, and route-verification contracts are defined below. Tool propagation belongs to issue #9, final release evidence to issue #12, and protected live-provider/agentgateway smoke to issue #15. Ordinary credential-free CI MUST NOT claim the protected live gate.

## 11. Governed model routing and budgets

### 11.1 Authority and closed documents

The TOSS control plane authority MUST supply the exact `model-catalog.v1`, `routing-policy.v1`, task profile, and optional governed override. `routing-state.v1` is the exact run-scoped budget/circuit head, and `model-selection-plan.v1` is either a fully reserved plan or a non-executable blocked result. Each of those four protocol documents is closed, bounded, and bound by lowercase SHA-256 over canonical JSON with only `document_hash` omitted.

The runtime and agentgateway MUST NOT become governance authorities. A fresh agentgateway document can only remove a catalog route. Effective boolean capabilities are the catalog AND live capability intersection; effective numeric context/output limits are the minimum of the two declarations. Alias, route ID, provider, and model MUST all match. A prompt, response, repository value, provider, gateway, or agent MUST NOT mint a logical class, capability, task risk, budget, review rule, or override.

### 11.2 Deterministic planning and independent review

For identical request, task, catalog, policy, state, live capabilities, override, gateway profile, and canonical decision time, `planModelSelection()` MUST return identical canonical output. Candidate and semantic-set evaluation uses fixed ASCII deterministic ordering, never locale or object insertion order. Reordered and rehashed catalog/live arrays MUST preserve selected entries, attempt order, and elimination reasons, while the decision, plan, and next-state hashes MUST rebind the changed exact input hashes.

Security, architecture, or irreversible risk requires independent review planning. Every accepted reviewer route MUST differ in both provider and model from every accepted primary and fallback route. The primary, every policy-allowed fallback included in the plan, and the reviewer MUST fit one atomic five-dimensional reservation. This contract proves the reviewer plan; Issue #11 remains pending for independent worker/reviewer orchestration and execution proof.

A governed override is narrowing only. Its artifact/content hash, catalog hash, policy hash, canonical issuance time, and target entry MUST validate exactly. The target MUST already pass normal class, capability, latency, live-route, circuit, review, and budget gates. Override narrowing MUST NOT add capability, increase budget, weaken review, change fallback limits, reopen a circuit, or broaden tool authority.

### 11.3 Exact integer budget

Every public monetary value is nonnegative integer microusd. Products and divisions MUST use `bigint`; floating point MUST NOT be used for money, and any result outside the nonnegative safe-integer range MUST fail closed. Actual cost is the sum of four independently upward-rounded components:

```text
uncached_input = input_tokens - cached_input_tokens
ordinary_output = output_tokens - reasoning_tokens
cost_microusd = ceil(uncached_input * input_rate / 1_000_000)
              + ceil(cached_input_tokens * cached_input_rate / 1_000_000)
              + ceil(ordinary_output * output_rate / 1_000_000)
              + ceil(reasoning_tokens * reasoning_output_rate / 1_000_000)
```

Reservations MUST cover the worst valid split for each accepted alias and MUST reserve the primary, every planned fallback, and required reviewer together against input tokens, output tokens, microusd cost, duration, and turns. Settlement MUST price only an exact accepted attested route, release unused allocations, and retain actual over-limit totals. If a possible provider effect lacks trusted route or usage data, budget state becomes unknown and new selection MUST fail until authoritative reconciliation. Issue #12 remains pending for authoritative gateway usage reconciliation and final ACP execution evidence.

### 11.4 Circuits, explicit fallback, and settlement proof

Circuit state is explicit, versioned, hash-linked input; the core MUST NOT read a clock or retain process-local counters. Only `RUNTIME_PROVIDER_TIMEOUT`, `RUNTIME_PROVIDER_TRANSIENT`, and `RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE` can increment a circuit or authorize fallback. Success resets the observed circuit. Authentication, rate-limit, cancellation, refusal, invalid response, capability downgrade, route absence, integrity, policy, and internal failures MUST NOT create fallback authority.

`recordRoutingOutcome()` returns the exact next state plus a closed hashed outcome witness binding prior/next state hashes, decision, attempt, outcome, occurrence time, and policy hash. `nextModelFallback()` MUST recompute and consume that witness and can return only the next explicit fallback already present in the plan; it performs no transport call, sleep, or retry. Settlement after one or more circuit transitions MUST receive every immediate hash-linked state in a bounded `circuit_state_chain`, while preserving reservation and all non-circuit governed fields.

Issue #10 remains pending for worker-turn execution and consumption of the fallback plan. The Issue #6 operation only decides whether an already planned attempt is ready.

### 11.5 Exact route verification and safe failures

Exact route verification MUST run against the initially reserved state before `recordRoutingOutcome()` changes circuit state. `verifyResolvedRoute()` MUST bind one attempt to transport `agentgateway`, gateway profile and revision, requested alias, route ID, provider, model, capability-document hash, and requirement hash. A mismatch MUST be rejected before provider output is accepted; it MUST NOT silently select another route.

Operational routing failures expose only the following fixed safe routing errors, their fixed category/retryability, and a non-reflective safe message:

| Stable code                           | Category               | Retryable |
| ------------------------------------- | ---------------------- | --------- |
| `RUNTIME_ROUTING_INVALID`             | invalid-input          | no        |
| `RUNTIME_ROUTING_BUDGET_EXCEEDED`     | policy-denied          | no        |
| `RUNTIME_ROUTING_NO_CAPABLE_ROUTE`    | unsupported-capability | no        |
| `RUNTIME_ROUTING_REVIEW_UNAVAILABLE`  | unsupported-capability | no        |
| `RUNTIME_ROUTING_POLICY_DENIED`       | policy-denied          | no        |
| `RUNTIME_ROUTING_CIRCUIT_OPEN`        | unavailable            | yes       |
| `RUNTIME_ROUTING_STALE_STATE`         | stale-revision         | no        |
| `RUNTIME_ROUTING_USAGE_UNKNOWN`       | integrity              | no        |
| `RUNTIME_ROUTING_RESOLUTION_MISMATCH` | integrity              | no        |

Prompts, provider bodies, endpoints, headers, tokens, credentials, diagnostics, stacks, and native values MUST NOT be reflected in a plan, elimination, routing error, journal, log, or evidence value.

Issue #13 remains pending for full secret, egress, prompt-injection, and sandbox hardening. Issue #15 remains pending for protected live-provider routing smoke and release guidance. Ordinary CI validates the pure contract without claiming either gate.

## 12. Stable failures

Library validation returns `RUNTIME_DOCUMENT_INVALID` for malformed content and `RUNTIME_DOCUMENT_UNSUPPORTED` for a recognized envelope requiring an unimplemented version or capability. Issues contain a JSON Pointer-like path, stable keyword, and safe message in deterministic order.

CLI JSON mode returns one `command-result.v1` document. Exit codes are `0` success, `2` usage, `3` invalid input, `4` policy/blocked, `5` validation, `6` conflict/stale revision, `69` unavailable, and `70` internal. Failure output MUST be safe to persist and MUST NOT echo secret-shaped option values.

## 13. Reference artifacts

The schema manifest maps every exact version to a stable `$id`. The `examples/runtime-contract-v1` directory contains a complete request, event, result, baseline capabilities, model catalog, routing policy, prior routing state, and model-selection plan set. Package verification loads the examples through the public API, validates the full execution chain, and recomputes all governed routing hashes. The planned example binds its exact next-state hash without embedding a cyclic plan hash in the state reservation.
