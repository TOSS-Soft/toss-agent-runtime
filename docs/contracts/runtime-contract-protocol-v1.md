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

## 11. Stable failures

Library validation returns `RUNTIME_DOCUMENT_INVALID` for malformed content and `RUNTIME_DOCUMENT_UNSUPPORTED` for a recognized envelope requiring an unimplemented version or capability. Issues contain a JSON Pointer-like path, stable keyword, and safe message in deterministic order.

CLI JSON mode returns one `command-result.v1` document. Exit codes are `0` success, `2` usage, `3` invalid input, `4` policy/blocked, `5` validation, `6` conflict/stale revision, `69` unavailable, and `70` internal. Failure output MUST be safe to persist and MUST NOT echo secret-shaped option values.

## 12. Reference artifacts

The schema manifest maps every exact version to a stable `$id`. The `examples/runtime-contract-v1` directory contains a complete request, event, result, and baseline capabilities set. Package verification loads these examples through the public API and validates the full hash-linked chain.
