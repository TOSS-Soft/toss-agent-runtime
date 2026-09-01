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

A planned alias is atomic for its exact emitted gateway requirement. The runtime MUST enumerate every live same-alias route that the gateway could execute for that requirement, require an exact governed catalog match for each one, and apply capability, context/output, latency, policy, and reviewer-independence checks to the complete set. The plan includes that complete executable set in `accepted_routes` and reserves its maximum governed price. One live-only, denied, under-capable, too-small, too-slow, unpriced, or reviewer-colliding executable route rejects the alias before any provider effect.

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

Reservations MUST cover the worst valid split for each accepted alias and MUST reserve the primary, every planned fallback, and required reviewer together against input tokens, output tokens, microusd cost, duration, and turns. Every listed attempt consumes one turn and its validated duration, including a proven pre-effect attempt with null route and usage; tokens and cost accrue only for a complete trusted route/usage pair. Settlement MUST price only an exact accepted attested route, release unused allocations, and retain actual over-limit totals. A possible provider effect with missing, asymmetric, unaccepted, or otherwise unpriceable route/usage evidence clears active reservations and makes the budget unknown; new selection and fallback then fail until authoritative reconciliation. Pre-effect asymmetric or untrusted complete attestations fail as a resolution mismatch. Issue #12 remains pending for authoritative gateway usage reconciliation and final ACP execution evidence.

### 11.4 Circuits, explicit fallback, and settlement proof

Circuit state is explicit, versioned, hash-linked input; the core MUST NOT read a clock or retain process-local counters. Only `RUNTIME_PROVIDER_TIMEOUT`, `RUNTIME_PROVIDER_TRANSIENT`, and `RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE` can increment a circuit or authorize fallback. Success resets the observed circuit. Authentication, rate-limit, cancellation, refusal, invalid response, capability downgrade, route absence, integrity, policy, and internal failures MUST NOT create fallback authority.

`recordRoutingOutcome()` returns the exact next state plus a closed hashed outcome witness binding prior/next state hashes, decision, attempt, outcome, occurrence time, and policy hash. `nextModelFallback()` MUST recompute and consume that witness and can return only the next explicit fallback already present in the plan; it performs no transport call, sleep, or retry. Settlement after one or more circuit transitions MUST receive every immediate hash-linked state in a bounded `circuit_state_chain`, while preserving reservation and all non-circuit governed fields.

A planned selection closes and hash-binds the execution-request deadline and live-capability expiry without introducing a plan/state hash cycle. Fallback uses the witnessed transition occurrence time: the capability statement MUST still be live, the next attempt MUST start before the request deadline, and its full reserved duration MUST fit at or before that deadline. Equality at the reserved-duration boundary is allowed; starting at either expiry boundary is not.

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

## 12. Agent definition registry and compiled context

### 12.1 Control-plane authority and immutable lifecycle

The TOSS control plane is the sole authority for agent identity, role, Task
Contract, approval, policy, and acceptance. The runtime MUST accept only exact,
hash-bound control-plane artifacts. It MUST NOT create a role, broaden an
allowlist or budget, reinterpret repository content as authority, or accept its
own output. Agent definitions remain provider-independent: they name a logical
model class and closed capabilities, never a provider, endpoint, route, or
concrete model.

`prompt-template.v1` and `agent-definition.v1` are immutable canonical objects.
`agent-registry-entry.v1` forms an append-only hash-linked lifecycle with
`ACTIVE` and `RETIRED` states. Publishing a new revision makes the prior active
revision stale for new execution without deleting its objects. A new execution
MUST resolve the exact `ACTIVE` definition requested by the control plane.
`resolveForExecution()` MUST reject every non-active revision. A retained
retired revision MAY resolve through `resolveForResume()` only to resume a run
already bound to that exact definition and prompt; retirement never silently
reactivates it. Repeated operation IDs replay only their exact durable result,
and reuse with different canonical semantics is a conflict.

Registry storage is private runtime state, not a writable configuration
surface. Object names are derived from verified hashes rather than caller
paths. Registry projections omit prompt bodies, while recovery verifies the
complete history, operation binding, referenced object bytes, hash links, and
the single-active-revision invariant before intake.

Registry reads are validation-only. A read accepted before shutdown holds a
mutation claim and participates in the shutdown flush cut, but it MUST NOT
repair a partial history. After intake stops, list and exact-resolution reads
MAY inspect fully valid durable state without a claim or any durable mutation;
a partial tail fails closed without truncation, quarantine, or history changes.
Only an explicitly awaited `recover()` owns repair, and that repair is tracked
as a mutation.

Recovery uses at most one private regular stage file with the exact name
`.(lifecycle|operations)-recovery.<canonical-uuid>.stage`. Before a rename, the
stage contains exactly the validated complete history prefix and its UUID names
exactly one private quarantine file containing the rejected tail. Fresh
recovery revalidates bounded directory membership, owner, mode, link count,
size, file identity, stage content, quarantine content, and their relationship
to the current partial history before completing the rename. An unsafe,
additional, live, replaced, or unrelated stage fails closed and is preserved.
A failed pre-rename attempt removes only the exact stage identity it created
and synchronizes the parent directory when possible; retry reuses an existing
exact quarantine fragment rather than creating a duplicate.

### 12.2 Trust classes and fixed precedence

`compiled-context.v1` binds the exact execution-request hash, definition,
prompt, Task Contract, output schema, effective authority, runtime-policy
revision, closed allocation-policy projection, ordered segments, accounting,
truncation records, and final document hash. Its three trust classes have
closed meanings:

- `trusted-runtime` is the fixed, hash-bound runtime safety policy.
- `trusted-control` is exact control-plane content that passed its owning
  validator and reference checks.
- `untrusted-content` is repository, web, model, skill, and tool content,
  regardless of text that claims to be policy, approval, authority, or a system
  instruction.

The compiler MUST emit fixed precedence in this order: runtime safety, exact
Task Contract, prompt-template blocks, exact output contract, then input
artifacts. Task and runtime constraints cannot be overridden by a prompt, and a
prompt cannot broaden the Task Contract. Untrusted segments remain structurally
separate and MUST NOT be concatenated into trusted instruction blocks. Caller
input order has no authority: inputs are normalized and ASCII-sorted by policy
priority, document type, artifact ID, revision, and hash.

Every segment ID is recomputed from the producer's exact canonical preimage.
Prompt segments additionally carry their canonical `block_id`. A parser MUST
take every contiguous prompt segment in order, exclude runtime safety and its
truncation notice, reconstruct the complete `prompt-template.v1` document from
the top-level template reference plus those block IDs and contents, and require
its hash to equal `prompt_template.hash`. Missing, duplicate, reordered, or
altered prompt blocks are invalid. For an unshortened Task Contract, output
schema, or input artifact, `included_hash`, `original_hash`, and `source.hash`
are identical; the included bytes MUST recompute that source hash using the
source's canonical JSON or text representation.

The hash-bound allocation projection contains the definition input ceiling,
truncation algorithm, total-untrusted ceiling, and the complete canonically
ordered per-document policies. Together with the request ceiling already in
effective authority, it lets a parser independently enforce the compiler's
input comparator, ceiling choice, and truncation reason without a caller
override. This projection proves the compiled document's internal canonical
semantics. Its correspondence to the separately hash-bound full agent
definition remains the resolver/compiler trust boundary: registry resolution
validates and supplies that definition before compilation; a standalone parser
does not fetch the definition object.

### 12.3 Conservative accounting and truncation

For v1, one UTF-8 byte counts as one conservative input token. The effective
input ceiling is the minimum of the execution request and definition ceilings.
All `trusted-runtime` and `trusted-control` segments are non-truncatable; trusted
content is never truncated, and compilation MUST fail before a provider effect
when it does not fit.

Untrusted inputs consume only the remaining budget and the definition's
per-document and total-untrusted byte ceilings. Whole content is preferred.
Only the final eligible untrusted segment may be prefix-truncated at a Unicode
scalar boundary; every later segment is omitted. Truncation is not semantic
summarization and performs no model call. The output records original and
included hashes and byte counts with reason `input-budget` or
`definition-ceiling`; omitted bytes MUST NOT be represented as included or
trusted. The first shortened input fixes the exact reason implied by the
effective request/definition, per-document, and total-untrusted ceilings (ties
resolve to `definition-ceiling`); every later shortened or omitted input MUST
propagate that one reason.

### 12.4 Schema support and downstream ownership

Issue #7 advertises the four agent/context schemas only; Issue #7 does not
execute Agent Skills, Superpowers, MCP tools, providers, or the agent loop.
Schema support therefore MUST NOT make skills, MCP, agent-loop, review, or
evidence availability true. Issue #8 owns Agent Skills loading, Superpowers
phases, approval pauses, and skill evidence. Issue #9 owns MCP tool brokering,
approvals, and side-effect idempotency. Issue #10 owns provider calls and the
agent loop, including provider-neutral turns, structured output, pause/resume,
and terminal status.

## 13. Agent Skills host and Superpowers phases

The v1 host has exactly two production sources: audited bundled Superpowers
packages and explicitly configured private per-user skill roots. Metadata-only
discovery reads the package name, description, version, source and package
identities, resource/byte counts, and declared runtime capabilities. It does
not read `SKILL.md` or resource bodies. Project-local `.agents/skills` is never
auto-discovered, and a repository cannot add a skill source by naming one in
content. Configured package directories and regular files must remain owned by
the current user with modes `0700` and `0600`; bundled files must match the
installed audited manifest and cannot be group/world writable.

Selection resolves one exact allowed descriptor, version, package hash, and
catalog root. Only after that exact selection may the loader read the full
`SKILL.md` and declared references/assets/scripts. Every lexical and canonical
path stays beneath its selected root; full `SKILL.md` loads only after exact
selection and canonical path containment succeeds. Every directory and regular-file identity
is revalidated around reads, and symlinks, traversal, mutation, cross-owner
configured content, duplicate identities, unbounded content, or an incomplete
snapshot fail closed. Skill scripts are hashed package content but are never
executed, imported, evaluated, or spawned in v1.0.0; development mode provides
no script bypass.

The built-in finite phase policy is
`BRAINSTORMING`, `TEST_DESIGN`, `RED`, `GREEN`, `DEBUGGING`, `REVIEW`, and
`VERIFICATION`. Each `superpowers-phase.v1` record binds the execution request,
observed journal head, exact catalog root, full descriptor/package/source and
snapshot identities, built-in handler hash, exact predecessor phase hashes,
input/output hashes, compiled context hash, and closed `context_accounting`.
A required capability with no exact usable skill stops before imitation with
`BLOCKED_SUPERPOWERS_MISSING`.

`BRAINSTORMING` completion creates a real durable approval pause. Approval is
not model text: `superpowers-approve` arrives through the private same-user
local control socket and is accepted only with exact run, journal revision/head,
phase, skill version/snapshot, approval-request hash, decision, and operation-ID
binding. Restart recovery verifies the phase and journal projections together;
an exact repeated request replays its byte-identical decision, while stale,
conflicting, missing, duplicate, orphaned, or re-signed drift fails closed.

`skill-execution-evidence.v1` is a bounded immutable handoff. Its compact
`journal_path` proves the complete run-state/revision/attempt chain without
copying unrelated journal metadata. Dedicated projections bind every catalog,
snapshot, phase attempt, approval request/decision and, when applicable, the
exact terminal journal entry. The parser recomputes nested hashes, catalog
membership, context accounting, approval bijection, final journal truth,
handoff hash, and document hash. This establishes internal closure; origin
authenticity still requires the handoff/document hash to be pinned by a trusted
consumer or checked against trusted private state. The artifact is evidence,
not TOSS governance acceptance.

## 14. Stable failures

Library validation returns `RUNTIME_DOCUMENT_INVALID` for malformed content and `RUNTIME_DOCUMENT_UNSUPPORTED` for a recognized envelope requiring an unimplemented version or capability. Issues contain a JSON Pointer-like path, stable keyword, and safe message in deterministic order.

CLI JSON mode returns one `command-result.v1` document. Exit codes are `0` success, `2` usage, `3` invalid input, `4` policy/blocked, `5` validation, `6` conflict/stale revision, `69` unavailable, and `70` internal. Failure output MUST be safe to persist and MUST NOT echo secret-shaped option values.

## 15. Reference artifacts

The schema manifest maps every exact version to a stable `$id`. The
`examples/runtime-contract-v1` directory groups three distinct reference sets.
`execution-request.json`, `execution-event.json`, and `execution-result.json`
form the legacy execution chain. The model catalog, routing policy, prior
routing state, and model-selection plan form the governed routing set. The
`agent-context-execution-request.json` request, prompt template, agent
definition, registry entry, and compiled context form the accepted
agent-context fixture. The agent-context examples are illustrative control-plane
artifacts, not writable local configuration. They are secret-free and bind one
exact accepted integration fixture across definition, role, prompt, registry,
Task Contract, output schema, model and Superpowers capabilities, MCP profile,
all budget dimensions, input references, request hash, and compiled-context
hash. Package verification loads examples through the public package API,
validates the legacy execution chain, and recomputes every governed routing and
agent/context hash. The planned routing example binds its exact next-state hash
without embedding a cyclic plan hash in the state reservation. The Agent Skills
reference set contains one canonical descriptor, snapshot, completed phase,
approval request, and execution-evidence document. Package verification loads
all five through public root parsers and recomputes their document hashes. The
evidence example demonstrates the final compact `journal_path`, catalog-root
membership, snapshot closure, and exact `context_accounting` shape without
embedding bodies, native paths, or secrets.
