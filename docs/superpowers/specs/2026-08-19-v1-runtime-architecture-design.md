# TOSS Agent Runtime v1.0.0 Architecture Design

## Status and release target

This document defines the approved architecture for the first production-capable
TOSS Agent Runtime release. The repository starts empty. The release is one
public npm package, `@toss-software/agent-runtime@1.0.0`, with the
`toss-runtime` executable, a proprietary TOSS Software license, a signed Git
tag, and a GitHub Release tied to the exact verified commit.

The compatible control plane is `@toss-software/cli` v2.2.0. TOSS CLI owns
governance state, assignment, human authority, and evidence acceptance. The
runtime may execute an exact request and emit evidence, but it cannot approve
its own work, mutate governance state, or widen its authority.

The package supports the automatically resolved latest Node.js LTS on macOS.
Linux, Windows, non-LTS Node releases, and older LTS lines are outside the
v1.0.0 release contract. The source is TypeScript ESM, built and published with
npm.

## Delivery model

The product is published as one package but implemented in six dependency
waves. Every wave has its own detailed design, implementation plan, tests, and
reviewable commits. Main remains packageable after each wave.

1. Runtime protocol and package baseline: issues #2 and #4.
2. Durable local service: issues #28, #1, #29, and #30.
3. Provider transport and routing: issues #5, #3, and #6.
4. Agent execution capabilities: issues #7, #8, #9, and #10.
5. Independent review, evidence, and hardening: issues #11, #12, and #13.
6. Conformance, operator experience, and release: issues #14 and #15; issue
   #16 closes only after every release gate passes.

Project-aware parallel scheduling, remote workers, persistent memory, an
operator dashboard, agent mesh execution, dynamic agents, and quorum review
remain outside v1.0.0.

## Architectural boundaries

The package has one public CLI and a deliberately small programmatic surface.
Internal modules communicate through versioned domain types rather than SDK
objects.

- `protocol`: JSON Schema 2020-12 contracts, compatibility handshake,
  canonicalization, hashes, and semantic validation.
- `config`: closed configuration schema, precedence, secret references, and
  production/development mode selection.
- `platform`: secure per-user paths, atomic filesystem operations, process
  identity, clocks, IDs, and OS service definitions.
- `journal`: append-only run records, hash-chain verification, transition
  policy, recovery, and idempotency reservations.
- `service`: one per-user supervisor, Unix-domain socket RPC, graceful drain,
  project registry, watcher intake, and operational log lifecycle.
- `providers`: normalized provider events plus OpenAI, Anthropic, Gemini, and
  OpenAI-compatible/agentgateway adapters.
- `routing`: immutable model catalog, deterministic selection plans, budgets,
  circuit breakers, and capability-equivalent fallback.
- `agents`: immutable agent definitions and provenance-aware context
  compilation.
- `skills`: Agent Skills discovery/loading and Superpowers phase execution.
- `tools`: scoped MCP sessions, policy evaluation, approval gates,
  idempotency, validation, and redaction.
- `orchestration`: bounded LLM loop and sequential worker-reviewer pipeline.
- `evidence`: execution/review evidence, usage reconciliation, redaction, and
  OpenTelemetry correlation.
- `security`: containment policies, egress checks, secret handling, untrusted
  content labels, and sandbox-driver contracts.
- `cli`: stable command grammar, human rendering, and versioned JSON output.

Dependencies point inward toward protocol and policy interfaces. Provider SDK,
MCP SDK, filesystem, process, network, and telemetry implementations are edge
adapters. Their objects never enter a protocol artifact or canonical journal
event.

## Execution data flow

1. TOSS CLI or an operator submits `execution-request.v1` through the local
   socket or `toss-runtime run --from`. The request binds the exact Task
   Contract, ACP artifact revisions and hashes, agent definition, required
   Superpowers capabilities, model class, MCP profile, budget, and review
   policy.
2. The runtime validates protocol compatibility, closed schemas, semantic
   references, authority limits, and stale input. Rejection happens before a
   provider, skill, or tool can run.
3. The router resolves an immutable selection plan from the exact catalog and
   policy revisions. Required capabilities, budget, and review independence
   are evaluated before model invocation.
4. The context compiler combines only verified canonical inputs. Repository,
   web, model, and tool content is marked untrusted and cannot become system
   authority. Every prompt template and compiled context receives a content
   hash.
5. The provider adapter emits normalized streaming events. Every turn is
   appended to the run journal before the next irreversible step.
6. A tool request is exposed only if the assigned MCP profile permits it.
   Write or high-impact calls persist an approval-pending state before returning
   control to the operator. Approved side effects use a stable idempotency key.
7. Completion output is schema-validated. A bounded repair attempt may use the
   same authority and budget; exhaustion fails closed.
8. Required review runs with a separate context and read-only tool profile.
   High-risk policy can require a different provider/model family. A reviewer
   emits findings and a verdict but cannot mutate worker output.
9. The runtime emits `execution-result.v1`, `execution-evidence.v1`, and when
   applicable `review-evidence.v1`, all bound to the request hash, journal head,
   exact outputs, usage, routes, tools, approvals, skills, and trace identities.
10. TOSS CLI independently decides whether evidence changes governance or
    acceptance state.

## Durable state and recovery

Canonical run state is an append-only JSON sequence with monotonically
increasing sequence numbers and SHA-256 links to the exact previous canonical
event. Published events are never updated in place. Snapshot indexes are
rebuildable caches and never replace the journal as evidence.

Appending uses a temporary record, file sync, atomic rename or bounded append
protocol, and directory sync appropriate to the platform. Startup verifies the
complete chain. A partial final write may be quarantined and reported; a broken
interior link or invalid event blocks the run and is never treated as valid
state.

Legal v1 run states are `CREATED`, `ROUTED`, `RUNNING`, `TOOL_PENDING`,
`APPROVAL_PENDING`, `REVIEW_PENDING`, `COMPLETED`, `FAILED`, `BLOCKED`,
`CANCELLED`, and `INTERRUPTED`. Transition functions require the expected
revision and previous hash. Resume, retry, approval, cancellation, and tool
completion are idempotent commands keyed by run, expected revision, operation,
and side-effect identity.

The supervisor owns one same-user Unix socket and one exclusive instance lock.
Socket and state directories are private to the user; the socket mode is
`0600`. Stale resources are reclaimed only after identity and liveness checks.
Service stop drains bounded work, persists interruption, and never publishes a
partial success.

## Project registry, watcher, and operational logs

Projects enter the registry only through an explicit command. Registration
stores a canonical root and stable project identity. Watch paths and ignore
rules come from a validated project manifest and cannot escape the root through
absolute paths, traversal, or symlinks. The runtime never scans unrelated
workspace roots.

Watcher events are debounced, coalesced, and deduplicated into candidate work.
They cannot approve a gate or cause an external mutation. A missing or moved
root becomes `BLOCKED_PROJECT_UNAVAILABLE`; the runtime does not guess a new
root.

Operational logs are separate from immutable execution evidence. They use a
versioned JSONL envelope and safe metadata, default to seven days or 100 MB,
and rotate without deleting canonical artifacts. Human output and JSON output
share the same event identity. Prompt bodies, provider payloads, tool output,
tokens, credentials, and secret values are excluded unless an explicit safe
field policy allows a redacted representation. A logging failure enters an
observable degraded state and cannot silently turn an execution into success.

## Providers, gateway, and routing

`ProviderAdapter` exposes capabilities, a normalized stream, cancellation, and
health. OpenAI, Anthropic, Gemini, and OpenAI-compatible agentgateway adapters
map native messages, tool calls, structured output, refusals, usage, finish
reasons, and failures into the same closed event union. Native payloads may be
attached only as redacted, explicitly non-canonical diagnostic data.

Development mode may resolve direct-provider secret references. Production
mode requires agentgateway and rejects direct provider credentials. Secrets are
resolved immediately before use from environment or a configured secret
provider and are never accepted as command-line values or persisted.

Routing is deterministic for the same request, catalog revision, health view,
and policy revision. It selects by capabilities rather than marketing names,
records considered alternatives and reasons, and permits fallback only when
all required capabilities and independence constraints remain satisfied. An
agent cannot increase its model class, budget, tool profile, or review policy.

## Skills, tools, and security

Skills are immutable content-addressed packages. Metadata-only discovery reads
only bounded descriptors from audited bundled packages and explicitly
configured private per-user skill roots; project-local `.agents/skills` is
never auto-discovered. Selection binds one exact catalog, descriptor, version,
source and package hash before the full `SKILL.md` and declared resources load.
Every relative/canonical path remains contained beneath that selected root.
Missing required capabilities produce `BLOCKED_SUPERPOWERS_MISSING`. Approval
gates persist a real paused run rather than being simulated in prompt text, and
the private same-user local socket requires exact request binding and durable
restart/replay.

MCP discovery is filtered before tools reach the model. The signed profile and
local binding remain separate across `stdio`, `streamable-http`, and
`agentgateway`; authorization intersects the exact role, Task Contract, server,
alias, schema hashes, protocol revision, and live session. Input and output are
validated against the discovered schemas. Tool output is always untrusted
content with provenance and structural then generic redaction. Policy classifies
operations as read-only, reversible-write, or irreversible/high-impact and
decides whether durable approval is required. Side-effect intent precedes the
at-most-one broker dispatch; uncertain effects are never retried and require an
exact `NO_EFFECT_CONFIRMED` or `EFFECT_CONFIRMED` disposition.

MCP dynamic capabilities include only ready profiles and their exact transports.
The broker owns recovery before readiness and shuts down by stopping intake,
cancelling discovery and reads, settling writes, finishing recovery, closing
connections and the private tool store, then closing the journal. Credentials
are never model input or persisted evidence. Public errors use stable
`RUNTIME_TOOL_*` codes without raw transport or SDK diagnostics.

Skill scripts are package members only for integrity hashing. They are never
executed, imported, evaluated, or spawned in v1.0.0. Development has no script
bypass; a request that depends on external skill-script execution fails closed.

Network endpoints are parsed and resolved against an allowlist. Redirects are
revalidated, loopback/link-local/private destinations are denied unless the
exact local service is explicitly configured, and DNS resolution is checked at
connection time. Secret-bearing values are tagged and redacted structurally
before generic pattern redaction is applied.

## Error model

All public failures have a stable code, category, retryability, safe message,
and trace identity. Categories distinguish invalid input, stale revision,
unsupported capability, policy denial, approval required, authentication,
rate limit, provider refusal, timeout, cancellation, unavailable dependency,
integrity failure, and internal failure.

Unknown versions, schemas, capabilities, transitions, model routes, tool
permissions, or security profiles fail closed. Retry is bounded and restricted
to classified transient failures. An uncertain external side effect is never
retried automatically. Terminal results are deterministic and partial output
cannot be labeled complete.

## Verification and release gates

The mandatory CI lane automatically resolves the latest Node.js LTS and runs on
macOS only. It includes formatting, linting, strict type checking, unit tests,
integration tests, schema and semantic fixtures, package-content validation,
dependency audit, and clean install smoke tests. Deterministic fakes provide
clocks, IDs, providers, gateway, MCP servers, filesystems where necessary, and
fault injection.

Security, state transition, interruption, partial-write, idempotency,
injection, symlink escape, SSRF, redaction, reviewer independence, and
capability downgrade regressions are release blockers. macOS service smoke jobs
validate installation, single-instance behavior, socket permissions, restart,
drain, and uninstall preservation.

Normal CI is credential-free and hermetic. A protected release environment
must additionally pass live smoke tests against OpenAI, Anthropic, Gemini, and
agentgateway. Those tests verify authentication, one bounded completion,
streaming normalization, usage/route evidence, trace correlation, and secret
absence in artifacts and logs.

The release workflow builds once from a clean exact commit, validates the npm
tarball, generates a provenance attestation and SBOM, publishes
`@toss-software/agent-runtime@1.0.0`, creates signed tag `v1.0.0`, and publishes
the GitHub Release from the same commit and checksums. Publishing stops if the
npm version or tag already exists with different content.

## Compatibility and migration

Runtime Protocol v1 is frozen for `toss-cli v2.2.0`. Handshake advertises the
supported protocol, document schemas, providers, logical model classes, skill
host version, MCP transports, and execution topology. Unknown major protocol
versions are rejected. Additive capabilities require explicit negotiation;
they cannot silently alter a v1 request.

State, config, catalog, agent, skill, and evidence records each carry their own
schema and content identity. v1.0.0 performs no destructive automatic state
migration. A future migration must be explicit, resumable, backed up, and
preserve canonical journals and accepted artifacts.
