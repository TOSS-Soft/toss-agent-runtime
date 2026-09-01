# Scoped MCP Tool Broker and Human Approval Design

**Status:** Approved design for Issue #9  
**Date:** 2026-09-01  
**Base:** `release/v1.0.0` at `6d7d22f`  
**Issue:** `TOSS-Soft/toss-agent-runtime#9`

## Purpose

Issue #9 turns the existing unavailable `src/tools/` boundary into the v1 MCP
tool broker. The broker exposes only tools authorized by the exact Task
Contract, agent role and MCP profile; executes every allowed call through one
policy, approval and journal path; and returns bounded, provenance-carrying
untrusted results.

The delivery supports all three Runtime Contract Protocol v1 MCP transports:

- `stdio` for an explicitly configured local child process;
- `streamable-http` for an explicitly configured remote or development-loopback
  MCP endpoint; and
- `agentgateway` for a gateway-routed MCP endpoint with short-lived virtual
  identity.

The production dependency is the modular official
`@modelcontextprotocol/client` v2 package. SDK values remain private transport
details. Public runtime contracts, errors and results are TOSS-owned closed
types.

## Success criteria

The implementation is complete when all of the following are true:

1. A model sees and can call only the intersection of the exact Task Contract,
   agent role/definition, MCP profile and live discovered server surface.
2. A write or high-impact call pauses in durable `APPROVAL_PENDING` state when
   policy requires approval and cannot execute before an exact human decision.
3. Replaying the same logical call never dispatches the native MCP call twice.
   A crash with an uncertain external effect blocks instead of retrying.
4. Every result is bounded, validated, redacted, marked `untrusted-content` and
   bound to exact server, tool, schema, profile, transport and trace provenance.
5. Raw credentials, headers, child environments, native diagnostics and
   secret-bearing tool fields do not enter public values, journals, logs or
   persisted tool artifacts.
6. Authentication, unavailable dependency, policy, stale approval, schema,
   timeout, cancellation and uncertain-effect failures produce stable safe
   tool findings.
7. Permission, prompt-injection, approval, replay, retry, crash and
   partial-failure suites cover each acceptance boundary across all transports.

## Non-goals

Issue #9 does not implement:

- the model-to-tool agent loop, turn budgeting or tool-result conversation
  continuation owned by Issue #10;
- independent worker/reviewer execution owned by Issue #11;
- final ACP execution evidence, usage reconciliation or OpenTelemetry export
  owned by Issue #12;
- the public operator `run`, `status`, `resume`, `cancel` and evidence CLI or
  protected live-credential smoke owned by Issue #15;
- legacy HTTP+SSE, MCP prompts, resources, sampling, elicitation or roots;
- interactive browser OAuth; or
- execution of commands supplied by a Task Contract, model, tool server or
  untrusted artifact.

The broker accepts only the MCP `tools/list` and `tools/call` surface. Any
server-initiated capability outside that surface is rejected.

## Authority and trust model

Authority precedence remains:

1. runtime safety;
2. exact Task Contract;
3. exact active agent definition and role;
4. exact MCP profile;
5. discovered server surface; and
6. model or other untrusted input.

Lower layers can only remove capability. They cannot create a tool, widen a
schema, lower an operation class, waive mandatory approval, select another
protocol revision or add identity scope.

The existing `matchAgentAuthority()` result proves that the request's Task
Contract, role, agent definition and MCP profile reference are allowed. The
broker repeats the exact profile-reference check at session creation and then
applies each profile tool rule's role and Task Contract restrictions. A
`reviewer` role is additionally limited by runtime safety to `read-only` tools;
later review orchestration cannot widen that boundary.

MCP tool annotations are untrusted hints. The broker never exposes server
titles or descriptions to the model and never uses `readOnlyHint`,
`destructiveHint`, `idempotentHint` or `openWorldHint` to grant permission. A
server annotation that claims more risk than the approved rule creates a
profile/discovery mismatch and excludes the tool. A claim of less risk is
ignored.

## Architecture

The implementation is a layered broker:

```text
Task Contract + Agent Definition + MCP Profile
                     |
              profile registry
                     |
          scoped virtual MCP session
                     |
      discovery snapshot + schema match
                     |
                policy engine
                     |
       approval coordinator (when needed)
                     |
         durable tool-call executor
                     |
 stdio | streamable-http | agentgateway adapters
                     |
    normalized untrusted result + provenance
```

### 1. Contracts and profile registry

The profile registry parses closed `mcp-profile.v1` documents, verifies their
document hashes, derives exact artifact references and matches them to runtime
transport bindings. It rejects duplicate identities, aliases, bindings, schema
hashes or semantically invalid policy combinations before discovery.

The runtime configuration embeds each non-secret profile document beside its
machine-local server bindings. This keeps the authoritative profile hash exact
while separating it from endpoints, commands and secret references. Runtime
bindings are connectivity, not authority: they must match every profile
`binding_name` exactly, may omit a binding and thereby block a profile, and may
not introduce an extra server or tool.

`runtime-config.v1.mcp_profiles` changes from a string array to a closed map:

```yaml
mcp_profiles:
  engineering-readwrite:
    profile: <mcp-profile.v1 document>
    servers:
      github:
        transport: agentgateway
        gateway_profile: production-gateway
      local-files:
        transport: stdio
        command: /absolute/path/to/server
        args: ["--stdio"]
        cwd: /approved/private/root
        environment: {}
      knowledge:
        transport: streamable-http
        endpoint: https://mcp.example.test/mcp
        credential_reference: knowledge-mcp-token
```

Profile documents contain no endpoint, command, native path or credential
value. Server bindings contain no tool allowlist or operation class.

The package is still `0.0.0-development`, so this delivery deliberately updates
the default and example configuration from `mcp_profiles: []` to
`mcp_profiles: {}`. The obsolete array form is rejected rather than silently
migrated or interpreted with weaker semantics.

### 2. Transport adapters

`src/tools/transports/` owns the only official MCP SDK imports. A private SDK
adapter translates `connect`, `listTools`, `callTool`, cancellation and errors
into TOSS-owned transport interfaces. It never returns an SDK client, transport,
error or schema type.

All adapters receive an `AbortSignal`, monotonic deadline, exact protocol
revision, bounded identity and injected clock/credential/network/process seams.
They do not retry a native `tools/call` automatically.

### 3. Scoped virtual session

A virtual session is created for one `run_id` and one exact MCP profile. It owns
one connection per profile server, never pools connections across runs and
closes every connection during session close, cancellation or supervisor
drain. A resumed process reconstructs the session from the profile and persisted
discovery snapshot; it never treats an old live SDK object as durable state.

Discovery paginates every server's `tools/list` response under explicit page,
tool, schema-byte and duration limits. The broker persists a
`mcp-discovery-snapshot.v1` before exposing a tool view. Discovery and native
calls are serialized per server so a tool-list refresh cannot replace schema
metadata while a call is in flight.

The profile supplies the model-facing name, description and JSON Schemas. The
server supplies only a native tool name and live matching evidence. A tool is
exposed only when the native name and canonical input/output schema bytes equal
the profile rule. Explicit profile aliases avoid multi-server name collisions.

A `tools/list_changed` notification marks the snapshot stale. No new call uses
a stale snapshot. In-flight calls retain their frozen snapshot, and the next
call requires bounded rediscovery. An approval tied to an expired or stale
snapshot is stale and must be requested again.

### 4. Policy engine

Policy receives immutable captured values only. For one candidate call it
checks, in order:

1. run, request and trace identities;
2. exact Task Contract, agent definition, role and MCP profile references;
3. active virtual session and unexpired discovery snapshot;
4. exact model alias to server/native-tool mapping;
5. role and Task Contract membership in the tool rule;
6. canonical schema identity;
7. bounded arguments and input-schema validation;
8. prohibited secret-shaped input fields;
9. operation class and approval rule; and
10. call timeout, result and session ceilings.

Unknown or malformed values deny the call. Policy cannot be overridden by a
model, server annotation, `_meta`, runtime binding or tool output.

Operation classes are:

- `read-only`: profile-authorized calls run without approval;
- `reversible-write`: approval is required unless the profile explicitly says
  `not-required`; and
- `irreversible`: approval is always required and a profile cannot waive it.

Each approval applies to one exact call. v1 has no blanket, session-wide or
tool-wide human approval.

### 5. Approval coordinator

The coordinator follows the durable Superpowers approval pattern but uses
separate tool contracts and metadata kinds. It does not reuse a
`superpowers-approval.v1` document or allow one approval type to satisfy the
other.

Before pausing, the broker durably stores the validated non-secret logical
arguments and appends one `APPROVAL_PENDING` journal entry. The approval request
binds:

- exact run and journal head;
- Task Contract, agent definition and role;
- MCP profile and discovery snapshot hashes;
- server ID, model alias and native tool name;
- input/output schema hashes;
- operation class;
- canonical logical input hash;
- tool-call and idempotency identities;
- bounded redacted human summary; and
- trace identity.

The private service-control socket adds `tool-approve`. A decision supplies the
exact request hash, expected journal head, new operation ID and `APPROVE` or
`REJECT`. Duplicate identical decisions replay. Changed, stale, cross-run,
cross-tool or cross-input decisions fail closed.

An approved resume revalidates the persisted call, current profile binding and
snapshot freshness before moving to execution. Rejection moves the run to
`BLOCKED`. Approval does not express governance acceptance or authorize any
different call.

### 6. Durable executor and private store

Every native tool call, including a read, uses a stable broker call identity.
The idempotency key is the hash of the run, logical call identity, exact tool
identity and canonical non-secret logical input. Supplying the same identity
with different input is an operation conflict.

Execution order is:

1. Persist the validated `tool-call.v1` preparation in the private per-user
   tool store.
2. If approval is required, persist and resolve the approval transaction.
3. Append `TOOL_PENDING` with a journal `side_effect` `INTENT` before dispatch.
4. Resolve short-lived transport credentials at the last responsible boundary.
5. Dispatch `tools/call` exactly once.
6. Validate, normalize and redact the result in memory.
7. Durably publish the `tool-result.v1` under its expected hash.
8. Append the journal `side_effect` `COMPLETED` and return to `RUNNING`.

The private result publication precedes journal completion. Recovery may finish
the journal completion without redispatch only when an exact, fully synced
result document exists for the unresolved intent. A result without its matching
journal intent is quarantined as an orphan.

If the broker can prove the call was not sent, it closes the intent with a safe
retryable failure. If the call might have reached the server but no valid result
was durably published, the effect remains unresolved, the call becomes
`UNCERTAIN`, and the run blocks. It is never retried automatically.

The private socket also adds `tool-dispose` for process-independent recovery of
an uncertain call. An exact human operation may record either
`NO_EFFECT_CONFIRMED` or `EFFECT_CONFIRMED`; neither disposition invokes the
tool. The first closes the journal side-effect ledger with a hashed no-effect
failure and moves `BLOCKED -> RUNNING`, after which a higher layer may create a
new logical call. The second is durably recorded in the tool store's operation
log, deliberately leaves the journal side effect unresolved and leaves the run
`BLOCKED` for higher-level recovery. Disposition is operational evidence, not
governance acceptance.

The exact run-state paths are:

```text
no approval: RUNNING -> TOOL_PENDING -> RUNNING | FAILED | BLOCKED
approval:    RUNNING -> APPROVAL_PENDING -> RUNNING -> TOOL_PENDING
reject:      APPROVAL_PENDING -> BLOCKED
uncertain:   TOOL_PENDING -> BLOCKED
no effect:   BLOCKED -> RUNNING
```

`FAILED` is used only when the broker proves the native call was not sent.
`BLOCKED` is used when an external effect may have occurred or approval was
rejected. Existing cancellation, interruption and restart transitions remain
authoritative.

The broker sends the idempotency key in the TOSS-owned MCP request `_meta`.
Agentgateway must enforce it. A third-party stdio or Streamable HTTP server may
ignore it, so the runtime guarantee is deliberately at-most-one broker
dispatch. A call left uncertain is not dispatched a second time.

### 7. Identity propagation

Every `tools/call` carries one closed TOSS-owned `_meta` member derived locally
from the captured execution authority. It contains only run and request IDs,
agent-definition and Task Contract hashes, role, MCP profile and discovery
hashes, server/tool/call identities, idempotency key and W3C trace context. A
model, server or caller cannot supply or override that member.

`stdio` carries the identity only in MCP request `_meta`. Streamable HTTP also
emits a fixed allowlist of equivalent correlation headers through the broker's
fetch wrapper. Agentgateway emits the same correlation plus its scoped virtual
credential. No transport sends prompts, raw Task Contracts, local paths,
credentials or arbitrary metadata as identity.

Server responses cannot attest or change runtime authority. Result provenance
is reconstructed from the local profile, snapshot, call record and transport
observation; conflicting response metadata is ignored or rejected when the
protocol requires equality.

### 8. Result normalization, redaction and trace

`tool-result.v1` contains a bounded subset of MCP result content plus:

- `trust: "untrusted-content"`;
- exact profile and discovery hashes;
- server producer identity and negotiated protocol revision;
- model alias and native tool identity;
- input and output schema hashes;
- transport kind;
- tool-call and idempotency identities;
- result/failure status; and
- trace context.

Structured output is allowed only when the profile declares an output schema
and the discovered schema matches it. The broker validates `structuredContent`
against that schema. A profile without an output schema permits only bounded
unstructured MCP content; unexpected structured output is invalid. Every MCP
content block is validated against a closed supported block union and the
profile's allowed content kinds.

The supported content kinds are exactly `text`, `image`, `audio`,
`resource-link` and `embedded-resource`. Each has independent byte/count limits;
embedded text/blob content is bounded before allocation. Server annotations on
result blocks are dropped rather than interpreted as trust, audience or
priority authority.

The profile declares sensitive structured-output JSON pointers. Those fields
are replaced before persistence or model exposure. Generic secret-pattern
redaction is defense in depth for text. Raw tool input/output never enters
operational logs. Journal and operational events contain only allowlisted
identities, hashes, counts, byte sizes, durations, status classes and stable
codes.

Model-supplied secret-bearing arguments are not supported in v1. Credentials
are transport-level secret references resolved only in memory. A secret-shaped
argument key or a profile rule requiring a secret argument fails closed. This
keeps approval pause/resume durable without persisting secret values.

## Closed contracts

Issue #9 adds exactly five schemas.

### `mcp-profile.v1`

The authoritative non-secret policy document includes:

- `profile_id`, `revision` and `document_hash`;
- bounded discovery/session/call/result limits;
- server rules with `server_id`, `binding_name` and pinned protocol revision;
- tool rules with model alias/description, native name, allowed roles and exact
  Task Contract references;
- authoritative input schema and optional output schema;
- operation class and approval rule;
- allowed MCP content kinds;
- allowed Streamable HTTP `x-mcp-header` parameter mappings, empty by default;
  and
- sensitive output pointers.

Semantic validation requires unique bytewise-sorted identities and aliases,
self-contained JSON Schema 2020-12 documents, no remote `$ref`, no secret-shaped
input property, and policy coherence. `read-only` must be `not-required`,
`irreversible` must be `required`, and `reversible-write` may be either.
Approved `x-mcp-header` mappings must be empty for a `2025-06-18` server rule;
they are available only to an exact `2026-07-28` Streamable HTTP or
agentgateway binding.

### `mcp-discovery-snapshot.v1`

The snapshot contains run/profile/session identity, creation and expiry, one
entry per server with binding/transport/protocol/server producer identity, and
one entry per discovered tool with native name, canonical schema hashes and
captured risk hints. It contains no endpoint, command, credential, description
or raw SDK value.

### `tool-approval.v1`

The request/decision union mirrors the durable binding discipline of
Superpowers approval while using tool-specific identities. It contains no raw
arguments or output. The request carries a bounded structurally redacted human
summary and exact logical input hash.

### `tool-call.v1`

The private durable call document records `PREPARED`, `COMPLETED`, `FAILED` or
`UNCERTAIN`, the exact authority/discovery/tool identities, bounded non-secret
logical arguments, operation and idempotency identities, approval hash when
applicable, timestamps, result hash and stable terminal code. Its document hash
changes with every stage; stage transitions are append-only private records.

### `tool-result.v1`

The normalized result contains the validated/redacted supported MCP content,
optional validated structured content, untrusted trust label, provenance,
trace, is-error state and document hash. It has explicit total, per-block,
string, binary and structured-JSON bounds.

All five schemas are added to the contract manifest, protocol validator,
runtime capabilities, examples, package allowlist and documentation integrity
tests.

## Protocol revisions

Profiles may explicitly pin `2025-06-18` or `2026-07-28`. The implementation
does not use automatic fallback:

- a 2025 profile selects the SDK's legacy protocol mode and verifies the
  negotiated revision; and
- a 2026 profile uses exact revision pinning and fails if the server does not
  offer it.

The negotiated revision is persisted in discovery and result provenance. A
downgrade, different revision after reconnect or server identity change makes
the profile unavailable until fresh discovery succeeds.

## Transport-specific rules

### stdio

- `command` is an absolute normalized executable path. No shell, PATH lookup,
  command substitution or request-supplied argument is allowed.
- `args` and `cwd` come only from the trusted runtime binding. `cwd` is an
  absolute approved private root.
- The child environment starts empty and includes only fixed safe runtime
  values plus explicitly configured literal values or secret references.
  Production rejects secret-shaped variables configured as literals.
- A secret lease in child environment bounds session lifetime; the child is
  terminated before the lease's usable window expires.
- stderr is bounded, never returned, structurally redacted for observation and
  discarded after a safe status classification.
- Close order is stdin close, bounded graceful termination, `SIGTERM`, then
  `SIGKILL`; cancellation and supervisor drain await reaping.

### Streamable HTTP

- Production requires HTTPS. Development permits exact loopback HTTP only.
- Userinfo, fragments, uncontrolled query parameters, redirects and caller
  headers are forbidden.
- DNS/IP policy is checked at configuration and connection time. Private,
  link-local, metadata and rebinding destinations are denied except an exact
  configured development loopback endpoint.
- The transport uses an injected bounded fetch wrapper with `redirect: error`,
  fixed content negotiation and per-request cancellation.
- A bearer token, when configured, is resolved before each request from a
  secret reference. No automatic 401 refresh/retry is installed.
- `x-mcp-header` schema annotations are rejected unless the exact parameter
  mapping is approved by the profile.

### Agentgateway

- The binding names one existing validated `toss-agentgateway.v1` profile.
- The MCP endpoint is derived, not caller supplied:
  `/v1/toss/mcp/{percent-encoded-server-id}` below the selected gateway origin.
- A fresh virtual bearer lease is resolved for the exact run, agent, Task
  Contract, MCP profile, server and tool scope.
- Only fixed correlation and attestation headers are emitted: W3C trace
  context, run/request identity, profile hash, discovery hash, tool identity
  and idempotency key. Native credentials and arbitrary headers are forbidden.
- Gateway authentication, missing route, capability downgrade and unavailability
  map to tool-domain stable findings. Native provider-domain errors do not leak
  across the tool boundary.

## Public broker surface

`src/tools/index.ts` exports TOSS-owned contracts and a `ToolBroker` interface
with these responsibilities:

- `recover()` and process-independent reconciliation;
- `openSession()` for one run/exact profile;
- `discover()` returning the frozen model-facing tool view and snapshot;
- `invoke()` returning `RUNNING`, `APPROVAL_PENDING`, `BLOCKED` or failed
  outcomes;
- `resumeApproval()` for an exact pending call;
- `disposeUncertain()` without invoking a tool;
- `result()` and `trace()` lookup by exact run/call identity;
- `capabilities()` and `health()`;
- `closeSession()`;
- `stopIntake()`; and
- `flush()`.

Every mutating input is captured into a closed immutable value before reading
mutable state. Journal changes use the official per-run barrier. Public values
are frozen, contain no native SDK object and use only `RuntimeToolError` stable
codes.

## Runtime capabilities

The baseline capability builder remains truthful when no broker configuration
is supplied. A dynamic MCP capability projection lists only structurally valid,
currently discoverable profile artifact references and transports actually
bound by those profiles.

- no configured profile: `features.mcp = unavailable`;
- configured profiles but none ready because of policy, auth or dependency:
  `features.mcp = blocked` and no profile is advertised;
- at least one ready profile: `features.mcp = available`, with only ready exact
  profile references and their implemented transports.

A requested unavailable profile fails normal capability negotiation before a
model or tool runs. Broker discovery and health retain profile-specific safe
findings for later doctor/reporting integration.

## Error model

The tool boundary adds stable safe codes in these groups:

| Group                    | Codes                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid or integrity     | `RUNTIME_TOOL_INVALID`, `RUNTIME_TOOL_SCHEMA_MISMATCH`, `RUNTIME_TOOL_PROTOCOL_DOWNGRADE`, `RUNTIME_TOOL_RESULT_INVALID`                                        |
| Authority and policy     | `RUNTIME_TOOL_POLICY_DENIED`, `RUNTIME_TOOL_UNSUPPORTED`, `RUNTIME_TOOL_OPERATION_CONFLICT`                                                                     |
| Approval and recovery    | `RUNTIME_TOOL_APPROVAL_REQUIRED`, `RUNTIME_TOOL_APPROVAL_STALE`, `RUNTIME_TOOL_APPROVAL_REJECTED`, `RUNTIME_TOOL_EFFECT_UNCERTAIN`                              |
| Dependency and execution | `RUNTIME_TOOL_AUTHENTICATION`, `RUNTIME_TOOL_UNAVAILABLE`, `RUNTIME_TOOL_RATE_LIMIT`, `RUNTIME_TOOL_TIMEOUT`, `RUNTIME_TOOL_CANCELLED`, `RUNTIME_TOOL_INTERNAL` |

Each code has one fixed category, retryability and safe message. Native SDK,
server, process, HTTP and gateway errors are untrusted edge input. Their text,
bodies, paths, endpoints, headers and diagnostics are never reflected. An
authentication or unavailable outcome includes only stable code, server
identity hash, transport, retryability and trace identity.

## Persistence and shutdown

The tool private store lives beneath the existing per-user runtime state root
with directory mode `0700` and files `0600`. It follows existing no-follow,
same-owner, inode-stability, atomic-publication, directory-sync, bounded-recovery
and quarantine patterns.

Recovery order is journal, tool private store, broker reconciliation, then
session readiness. Shutdown order is:

1. stop accepting new tool/session/approval/disposition requests;
2. cancel discovery and read-only calls;
3. allow a bounded in-flight write result publication to finish;
4. classify unresolved dispatched writes as uncertain;
5. close MCP clients and reap stdio children;
6. flush the tool store; and
7. flush the run journal last.

An approval-pending or uncertain call requires no live process. Supervisor
restart never implies approval and never redispatches an unresolved call.

## Testing strategy

Every production change follows a witnessed RED/GREEN cycle.

### Contracts and authority

- Closed-schema, canonical-hash, bounds, duplicate, ordering and semantic tests
  for all five documents.
- Cross-product tests for Task Contract, role, agent definition, profile,
  server, alias, schema and operation class.
- Reviewer read-only enforcement and attempts by bindings, model input or
  server metadata to widen authority.

### Discovery and injection

- Pagination, page/tool/schema bounds, collisions, duplicate tools, changing
  order, `tools/list_changed`, expiry, reconnect identity and schema drift.
- Tool title/description/schema-description prompt injection and malicious
  annotations never becoming runtime policy.
- Remote `$ref`, recursive/deep schemas, secret-shaped input properties,
  unsafe `x-mcp-header` annotations and malformed output schemas.

### Approval and replay

- Durable pause, process restart, approve, reject and exact replay.
- Stale head, expired discovery, changed input, changed tool, cross-run reuse,
  duplicate/conflicting decision and shutdown intake races.
- Proof that no native call occurs before a durable exact approval decision.

### Executor and partial failure

- Crash/fault injection before intent, after intent, before dispatch, during
  dispatch, after native result, after result sync and before journal
  completion.
- Completed replay returns the persisted result without a second native call.
- Same key with different input conflicts.
- Uncertain effect never auto-retries; both exact dispositions are durable and
  never invoke the tool.
- Invalid, oversized, partial, is-error and structured-output mismatch results.

### Transport conformance

- `stdio`: a real spawned fake server plus hand-authored hostile wire fixtures;
  exact environment/cwd/args, exit, hang, cancellation, stderr, lease expiry
  and process cleanup.
- `streamable-http`: a real loopback server plus injected network seams; JSON
  and SSE, redirects, origin/DNS policy, auth, rate limit, bounds, revision pin,
  cancellation and malformed responses.
- `agentgateway`: a fake gateway; virtual-lease scope, correlation,
  idempotency, route absence, authentication, downgrade, expiry and token
  non-disclosure.
- The official `@modelcontextprotocol/server` v2 package is a development-only
  conformance fixture. Hand-authored fixtures prevent client and server SDKs
  from sharing the same bug unnoticed.

### Redaction, service and packaging

- Sensitive output pointers, generic token patterns, child env, stderr, HTTP
  headers, SDK errors, approval summaries, journal metadata and operational
  events.
- Service-control request/response parsing, private-socket identity, replay
  cache, shutdown and restart recovery for `tool-approve` and `tool-dispose`.
- Public type/API tests proving SDK types and private stores are absent.
- Contract manifest, examples, README, changelog, package file allowlist,
  declaration maps and tarball leak checks.

### Acceptance commands

Focused suites run throughout implementation. Final acceptance runs:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:package
```

The current Node.js 24 package policy remains authoritative. No protected live
credential test is claimed by Issue #9.

## Dependency and package policy

- Add exact production dependency `@modelcontextprotocol/client@2.0.0`.
- Add exact development dependency `@modelcontextprotocol/server@2.0.0` for
  conformance fixtures.
- Do not export either package's types.
- Do not add an MCP server, OAuth UI, browser, process manager, HTTP framework
  or tracing SDK dependency.
- Package only public tool declarations, runtime implementation, five schemas,
  examples and contract documentation; exclude private-store declarations,
  test servers and fixtures.

## Documentation and delivery

The implementation updates the Runtime Contract Protocol document, CLI
compatibility matrix, README, changelog, package manifest, examples and v1
verification evidence. Documentation states the exact profile/binding split,
three transports, protocol pinning, approval behavior, at-most-one dispatch
guarantee, uncertain-effect boundary, secret limitations and downstream issue
ownership.

Issue #9 uses the existing `issue/9-scoped-mcp-tools` branch and one pull
request into `release/v1.0.0`, preserving the program rule of one issue, one
branch and one PR.

## External protocol references

- MCP TypeScript client guide:
  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md>
- MCP TypeScript SDK v2 migration guide:
  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md>
- MCP protocol revision negotiation:
  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md>
- MCP 2026-07-28 Streamable HTTP transport:
  <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx>
- MCP tool safety and annotations:
  <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx>
