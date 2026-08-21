# Agent Definition Registry and Provenance-Aware Context Compiler Design

## Status and authority

This document defines the approved Issue #7 design for TOSS Agent Runtime
v1.0.0. It refines the agent-execution boundary in the v1 architecture and
release-program designs without changing their authority model.

TOSS CLI and its authoritative artifacts own task assignment, governance,
approval, and acceptance. The runtime may register and execute an exact agent
definition supplied by that control plane, but it cannot create an agent role,
expand capability, reinterpret repository content as authority, or accept its
own output. Runtime registry and compiler output are execution inputs and
evidence, not governance decisions.

The target remains macOS, Node.js 22.23.0 or newer within Node 22, and Node.js 24. Linux, Windows, remote registries, dynamic agent generation, long-term
memory, semantic summarization, model calls, skills execution, MCP execution,
and the agent loop are outside Issue #7.

## Goals

Issue #7 delivers two independently testable units:

1. An immutable private registry for exact agent definitions and their prompt
   templates.
2. A pure, deterministic compiler that combines only verified canonical inputs
   into a provenance-bearing, hash-bound provider-neutral context.

The implementation must satisfy these properties:

- Agent identity is independent of provider and concrete model identity.
- A new execution can use only the exact active agent revision requested by the
  control plane.
- A resumed run can still resolve the exact retained revision to which the run
  was originally bound.
- Agent or prompt changes publish new immutable revisions and never alter old
  run inputs.
- Every compiled input names its exact source revision and hash.
- Repository and other content inputs remain untrusted data and cannot become
  instructions or authority through ordering, interpolation, or metadata.
- Context overflow follows one deterministic, conservative policy.
- The same semantic inputs produce byte-for-byte identical compiled context and
  the same hash regardless of caller object or input-array ordering.

## Non-goals and downstream ownership

Issue #7 does not discover or execute Agent Skills; Issue #8 owns skill package
loading, Superpowers phases, approval pauses, and skill evidence. It does not
discover or invoke MCP tools; Issue #9 owns tool brokering, approvals, and side
effect idempotency. It does not call providers or run a turn loop; Issue #10
owns provider-neutral execution, structured output, pause/resume, and terminal
status.

Issue #7 therefore keeps `skills`, `mcp`, `agent_loop`, `review`, and `evidence`
capability availability unchanged. It may advertise only the document schemas
that it actually parses and produces.

## Considered approaches

### Selected: immutable registry plus pure compiler

Canonical definition/template objects are stored once by content identity and
an append-only registry records lifecycle state. A pure compiler consumes
resolved, verified values and has no filesystem, network, provider, skill, or
tool dependency. This provides exact replay, clear trust boundaries, and
isolated tests.

### Rejected: stateless file resolution per execution

Re-reading mutable files for every run is simpler but cannot prove that an old
run resumes with the same bytes. It also turns path state into authority and
makes crash recovery ambiguous.

### Rejected: repository-local agent definitions

Allowing a repository to define or override roles and instructions would let
untrusted project content mint authority. Repository files may be compiled only
as explicitly referenced untrusted content.

## Contract set

Issue #7 adds four closed JSON Schema 2020-12 documents under the existing
Runtime Contract Protocol v1 namespace.

### `prompt-template.v1`

A prompt template is a canonical immutable control-plane artifact. It contains:

- protocol, schema, and document type;
- stable template ID and positive revision;
- an ordered non-empty list of bounded static instruction blocks;
- a lowercase SHA-256 `document_hash` computed with only that field omitted.

Templates have no arbitrary interpolation syntax. They cannot name environment
variables, filesystem paths, secret references, repository fields, or dynamic
tool/model values. Dynamic inputs are appended later as separately typed
context segments, so untrusted text cannot occupy a system-instruction slot.

### `agent-definition.v1`

An agent definition contains:

- stable agent ID, positive revision, display name, and exact role;
- exact `prompt-template` artifact reference;
- one or more exact allowed Task Contract references;
- logical model class and required model capabilities, never a provider, route,
  endpoint, or concrete model name;
- required and allowed Superpowers capability names;
- exact allowed MCP profile references;
- a budget class plus hard ceilings for input tokens, output tokens, cost,
  duration, and turns;
- exact allowed output-schema references;
- a closed context policy containing allowed input document types, priority,
  per-document byte ceiling, total untrusted byte ceiling, and the fixed
  truncation policy identifier;
- a lowercase SHA-256 `document_hash` computed with only that field omitted.

Sets are canonicalized in ASCII order and reject duplicates. Exact artifact
references use the existing Runtime Contract Protocol tuple. An execution
request matches a definition only when role, Task Contract, logical class,
required model capabilities, required Superpowers capabilities, MCP profile,
budget ceilings, and output schema are all within the definition's closed
allowlists. Matching may remove authority but cannot add it.

### `agent-registry-entry.v1`

The append-only lifecycle record contains:

- registry revision and previous-entry hash;
- canonical operation ID and operation hash;
- exact agent-definition and prompt-template references;
- lifecycle state `ACTIVE` or `RETIRED`;
- canonical occurrence time;
- entry hash computed over all other fields.

At most one definition revision per agent ID is active. Activating a new
revision makes the previously active revision unavailable for new execution
without removing its immutable objects. Retiring the active revision leaves no
active definition for that agent. Repeated operation IDs replay their exact
historical result; reuse with different semantics is a conflict.

### `compiled-context.v1`

The compiler output contains:

- exact execution request hash;
- exact agent definition, prompt template, Task Contract, and output schema
  references;
- the effective logical model class and closed capability/profile/budget view;
- ordered context segments;
- conservative token/byte accounting and remaining input budget;
- an explicit truncation record for every shortened input;
- a document hash computed over all other fields.

Each segment has a stable segment ID, kind, trust class, exact source reference,
original source hash, included content hash, original and included UTF-8 byte
counts, conservative token count, and content. The trust classes are
`trusted-runtime`, `trusted-control`, and `untrusted-content`. Compiled context
does not contain absolute paths, environment values, credentials, secret
references, raw resolver objects, provider values, or governance verdicts.

## Registry architecture

### Object store

The registry lives below the configured private runtime state root. All owned
directories are current-user mode `0700`; files are current-user regular files
mode `0600`. Symlinks, unexpected entries, ownership changes, loose modes,
non-regular objects, identity replacement, and path escape fail closed.

Canonical definition and template bytes are stored in a content-addressed
object namespace keyed by lowercase SHA-256. Publication is no-overwrite:

1. Validate bounded bytes through the exact schema and semantic parser.
2. Recompute document hash and cross-document template binding.
3. Write canonical bytes to an operation-owned private staging file.
4. Sync the held file and revalidate its bytes and identity.
5. Publish without overwriting an existing object.
6. Sync and revalidate the containing directory.
7. Accept an existing object only when its exact bytes and identity match.

The registry never trusts a caller-supplied location. Content-addressed object
paths are derived internally from validated hashes.

### Lifecycle history and recovery

Lifecycle entries form a bounded canonical append-only JSONL hash chain. A
separate bounded operation-result history provides durable idempotent replay
without growing lifecycle state for exact no-ops. File and directory barriers
follow the same held-descriptor, identity-bound durability rules used by the
run journal and project registry.

Startup verifies the complete history, object existence, object bytes, hash
links, operation uniqueness, operation-result binding, legal lifecycle
transitions, and the single-active-revision invariant. A partial final line may
be quarantined byte-for-byte after durable publication of its valid prefix. An
invalid interior record, missing referenced object, conflicting object bytes,
unrecognized artifact, or ambiguous filesystem state blocks the registry.

Process-local coordinators are keyed by canonical real state identity so public
registry instances cannot interleave operations on the same store. Cross-
process mutation is excluded by the existing single-instance service lock;
direct constructors detect an independently held registry mutation claim and
fail closed rather than racing.

### Public registry behavior

The registry exposes a narrow asynchronous interface:

- `recover()` verifies and reconstructs the exact registry head.
- `publish(bundle, operationId)` validates and activates one immutable
  definition/template bundle.
- `retire(definitionReference, operationId)` retires the exact active revision.
- `resolveForExecution(reference)` returns only an exact active revision.
- `resolveForResume(reference)` returns an exact retained active or retired
  revision.
- `list()` returns bounded immutable lifecycle projections without prompt or
  instruction bodies.
- `stopIntake()` rejects new mutations.
- `flush(signal)` completes accepted durability barriers during shutdown.

Returned domain objects are deep-frozen plain values. Registry errors never
include content, paths, prompt text, or conflicting bytes.

## Context compiler architecture

### Resolver boundary

The compiler does not read paths. Callers provide resolved canonical artifacts
through a small interface that returns:

- the exact requested artifact reference;
- bounded canonical bytes or validated UTF-8 text;
- media type;
- sensitivity classification;
- provenance origin.

The compiler recomputes every hash before use. `secret` sensitivity is always
rejected. Unsupported media, malformed UTF-8, duplicate identity, reference
mismatch, oversized source, or mutable resolver output fails before a compiled
document is produced.

Task Contract, prompt template, definition, and output schema are
`trusted-control` only because they arrived through exact control-plane
references and passed their owning validators. Repository, web, model, and tool
content is always `untrusted-content`, even if its text claims to be a system
message, policy, approval, or instruction.

### Precedence and segment construction

The compiler emits segments in this fixed precedence order:

1. fixed runtime safety invariants (`trusted-runtime`);
2. exact Task Contract (`trusted-control`);
3. static agent prompt-template blocks (`trusted-control`);
4. exact output contract (`trusted-control`);
5. referenced input artifacts (`untrusted-content`).

Task and runtime safety constraints cannot be overridden by an agent template.
An agent template cannot broaden the Task Contract. Untrusted segments are
delimited structurally and are never concatenated into trusted instruction
blocks.

Input artifact caller order has no semantic effect. Inputs are normalized and
sorted by definition policy priority, document type, artifact ID, revision,
and hash using ASCII comparison. Unknown document types are rejected rather
than silently included.

### Conservative token budgeting

Issue #7 is provider-neutral and does not import a tokenizer or provider SDK.
For v1, one UTF-8 byte counts as one conservative input token. This can reject
some context earlier than a provider tokenizer would, but it never spends more
authority than the deterministic compiler granted.

The effective input ceiling is the minimum of the execution-request input
budget and the agent-definition input ceiling. Fixed runtime framing, Task
Contract, prompt blocks, and output contract are non-truncatable. If they do
not fit, compilation fails with context overflow before any provider effect.

Untrusted inputs consume the remaining budget in normalized order, subject to
their per-document and total-untrusted ceilings. Whole content is preferred.
The final eligible segment may be prefix-truncated only at a valid UTF-8 scalar
boundary. All later segments are omitted. Truncation is never semantic
summarization and never calls a model. The output records original/included
hashes and byte counts plus the fixed reason `input-budget` or
`definition-ceiling`. A fixed trusted-runtime notice states that untrusted
content was truncated; omitted bytes are never hashed as if included.

### Determinism and immutability

Compilation is a pure function over parsed request, resolved registry bundle,
resolved canonical artifacts, and a fixed runtime-policy revision. It does not
read a clock, generate an ID, inspect process state, or mutate input objects.
All output collections and nested objects are deep-frozen.

Permutation tests must prove identical canonical bytes and document hash for
semantically identical inputs. Changes to any source revision, content hash,
runtime-policy revision, prompt template, definition, task, output contract,
context policy, truncation boundary, or effective budget must change the
compiled document hash.

## Request matching

Before compiling, the runtime validates the execution request against the
resolved active definition:

- `request.agent.definition` equals the exact active reference;
- `request.agent.role` equals the definition role;
- `request.task_contract` is an exact allowed Task Contract reference;
- requested logical model class equals the definition class;
- requested model capabilities are a subset of the definition allowlist and
  include every definition-required capability;
- requested Superpowers capabilities are a subset of the definition allowlist
  and include every definition-required capability;
- requested MCP profile equals one exact allowed profile;
- every request budget dimension is at or below the definition ceiling;
- requested output schema equals one exact allowed output reference.

No prompt, repository artifact, provider response, route attestation, skill, or
tool result can modify this effective authority view.

## Errors

Issue #7 adds a closed `RuntimeAgentError` family with safe fixed messages:

- `RUNTIME_AGENT_DEFINITION_INVALID` — closed-schema or semantic failure;
- `RUNTIME_AGENT_DEFINITION_UNSUPPORTED` — unsupported version/capability;
- `RUNTIME_AGENT_NOT_FOUND` — exact definition object is absent;
- `RUNTIME_AGENT_STALE_REVISION` — definition exists but is not active for new
  execution;
- `RUNTIME_AGENT_OPERATION_CONFLICT` — durable operation ID was reused with
  different semantics;
- `RUNTIME_AGENT_REGISTRY_CORRUPT` — history/object integrity failure;
- `RUNTIME_AGENT_PATH_UNSAFE` — ownership, mode, type, ancestry, or replacement
  failure;
- `RUNTIME_CONTEXT_REFERENCE_MISMATCH` — resolved bytes or identity do not
  match the exact reference;
- `RUNTIME_CONTEXT_AUTHORITY_MISMATCH` — request exceeds the definition;
- `RUNTIME_CONTEXT_UNSUPPORTED` — media, sensitivity, or context policy is not
  supported;
- `RUNTIME_CONTEXT_OVERFLOW` — non-truncatable trusted context cannot fit;
- `RUNTIME_CONTEXT_INTEGRITY` — deterministic compilation invariant failed.

Invalid input, stale revision, conflict, unsupported capability, integrity,
and unavailable state retain distinct existing Runtime Contract error
categories. Errors expose no raw content, secret-like metadata, absolute path,
or resolver detail.

## Public and package surface

The package top level exports only immutable agent/context domain types,
parsers, hashes, the registry factory/interface, the pure compiler, and the
closed error type/code. Filesystem helpers, staging/claim formats, mutable
coordinators, raw schema-validator internals, test resolvers, and fixture
builders remain private.

The four schemas, normative protocol section, secret-free examples, public
declarations, and required runtime JavaScript are present in the exact package
allowlist. Runtime capabilities advertise the four schemas but do not claim
that skills, MCP, agent loop, review, or evidence execution is available.

## Verification design

### Contract and semantic tests

- Closed-schema, duplicate-key, unknown-field, bound, canonical order, document
  hash, and deep-freeze tests for all four documents.
- Cross-field definition tests for required/allowed capabilities, exact
  references, budget ceilings, unique priorities, and prompt binding.
- Request-matching matrices for role, Task Contract, model class/capability,
  Superpowers capability, MCP profile, budget, and output schema.
- Generic secret-, authority-, approval-, and environment-shaped metadata
  rejection where metadata is permitted.

### Registry tests

- Publish, replace-active, retire, exact replay, operation conflict, new-run
  stale rejection, and old-run resume.
- Definition/template hash mismatch, reused revision with different bytes,
  missing object, broken history, partial final line, quarantine, and bounded
  read behavior.
- Current-user `0700`/`0600`, symlink, hard-link/replacement, path ancestry,
  directory/file identity, no-overwrite, and exact cleanup tests.
- File sync, directory sync, publication, append, recovery, shutdown, and every
  injected crash boundary.
- Multiple public instances, canonical-path aliases, stopped intake, bounded
  flush, and mutation-claim conflict tests.

### Compiler tests

- Cross-role and repository prompt-injection attempts remain structurally
  untrusted and cannot alter trusted segments.
- Exact provenance and hash rebinding for every source.
- Caller-array and object permutation produce identical canonical bytes/hash.
- Unicode scalar-boundary truncation, exact fit, one-byte overflow, per-source
  ceiling, total-untrusted ceiling, and trusted overflow.
- Secret sensitivity, malformed UTF-8, unsupported media, duplicate identity,
  resolver mutation, oversized input, and reference mismatch fail closed.
- Parsed and compiled values are deeply frozen; compiler input is not mutated.

### Integration and delivery tests

- Compile a real accepted execution request with an active definition, exact
  Task Contract, prompt, output schema, and multiple untrusted artifacts.
- Prove that a new agent/prompt revision changes only new compilation while an
  old run resolves and recompiles its original exact context.
- Prove Issue #8, #9, and #10 can consume the public types without importing
  private registry/compiler files.
- Update documentation integrity, example parsing, capability coherence,
  public API, declaration graph, and exact `npm pack` contents.
- Pass formatting, lint, strict type checking, build, all tests, installed-
  package acceptance, and production audit on macOS Node 22.23.1 and Node 24.

## Acceptance mapping

- Agent definition is separated from provider identity by logical model class
  and capability-only policy.
- ACTIVE matching is enforced by exact request-to-definition checks before
  compilation.
- Every context input carries exact artifact revision/hash provenance.
- Untrusted content is structurally separated and never interpreted as
  instruction or authority.
- Overflow uses fixed conservative accounting and deterministic truncation.
- Prompt/definition changes create new revisions while retained objects keep
  old runs immutable.
- Cross-role authority, context injection, filesystem integrity, crash,
  concurrency, and package-boundary tests are release-blocking.

## Approved design decisions and cost if wrong

1. **Control-plane-only definition authority.** If wrong, project-local agent
   customization requires a separately governed import/signing workflow rather
   than relaxing this registry.
2. **Exact Task Contract allowlist in each definition.** If too restrictive,
   reusable semantic task selectors require a new closed selector contract and
   migration; v1 chooses safety over implicit matching.
3. **Separate immutable prompt-template artifact.** If unnecessary, it costs
   one extra object/reference per definition but preserves exact prompt
   provenance.
4. **One UTF-8 byte equals one conservative token.** If later provider-neutral
   tokenizer evidence supports a tighter bound, a versioned compiler policy can
   replace it; v1 may reject valid large contexts early.
5. **Only untrusted prefix truncation; no semantic compaction.** If insufficient,
   model-assisted compaction must be introduced later as a separately routed,
   evidenced operation rather than hidden inside compilation.
6. **Retained retired revisions resolve only for resume.** If wrong, operators
   need an explicit reactivation operation; allowing silent reuse would make
   retirement ineffective.

## Completion gate

Issue #7 is complete only when every acceptance criterion maps to passing
tests, exact macOS Node 22/24 PR checks pass, package acceptance and production
audit pass, a fresh whole-branch review has no remaining Critical or Important
finding, and the dedicated PR contains no unfinished downstream execution
claim. Per the v1 delivery contract, the issue then moves to Done and closes
before the accepted PR is merged into `release/v1.0.0`.
