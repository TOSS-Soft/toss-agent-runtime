# Agent Skills Host and Superpowers Execution Design

## Status and authority

This document defines the approved Issue #8 design for TOSS Agent Runtime
v1.0.0. It refines the skills boundary in the v1 architecture without changing
the control-plane authority model.

TOSS CLI and its authoritative artifacts own task assignment, allowed and
required capabilities, human decisions, governance state, and evidence
acceptance. The runtime may discover an allowed skill, load its exact immutable
content, execute a built-in Superpowers phase, persist a pause, and emit
evidence. It cannot grant itself a skill, treat repository content as
authority, approve its own pause, widen an agent definition, or accept its own
output.

The release target is macOS on the automatically advancing latest Node.js LTS.
Linux, Windows, remote skill registries, repository-local automatic discovery,
arbitrary production script execution, user-authored workflow interpreters,
and dynamic installation are outside Issue #8.

## Goals

Issue #8 delivers five independently testable units:

1. A metadata-only catalog over explicitly configured private per-user skill
   roots and audited bundled Superpowers capabilities.
2. A secure loader that snapshots and verifies the complete selected skill
   package without allowing a path or identity escape.
3. A finite built-in phase engine for brainstorming, test design, RED, GREEN,
   debugging, review, and verification.
4. A journal-backed approval coordinator that creates a real durable pause and
   resumes only an exactly bound operation.
5. An evidence builder that binds skill and phase identities to the run.

The implementation must satisfy these properties:

- Discovery reads only bounded name, description, version, and identity data.
- Full `SKILL.md`, reference, asset, and script content is loaded only after an
  allowed exact skill has been selected.
- Explicit and implicit selection are both limited by the agent definition's
  required and allowed capability sets.
- Every selected package and every built-in phase has an exact version and
  lowercase SHA-256 identity.
- Relative resources remain beneath the canonical skill root across every
  filesystem boundary.
- Missing required skill or Superpowers capability produces
  `BLOCKED_SUPERPOWERS_MISSING`; the runtime does not imitate the behavior.
- An approval gate persists `APPROVAL_PENDING` before execution returns control
  and cannot be satisfied by model or skill text.
- Restart and replay preserve the exact selected skill, phase, journal head,
  and approval identity.
- External skill scripts are identity-bound package content but cannot execute
  in v1.0.0 production.

## Non-goals and downstream ownership

Issue #8 does not call a model or own the complete execution loop; Issue #10
owns provider-neutral turn orchestration. It does not discover or invoke MCP
tools; Issue #9 owns tool brokering, tool approvals, and side-effect
idempotency. It does not decide independent review policy or accept findings;
Issue #11 owns worker/reviewer orchestration. It does not define final release
evidence or hardening policy; Issues #12 and #13 consume the skill evidence and
close those release-wide boundaries.

Development script execution and a production sandbox driver are deliberately
deferred. The v1 host may parse, bound, hash, and report script resources, but
every request to execute one returns a stable unsupported-capability failure
before creating a process. Project-local `.agents/skills` content is not
automatically discovered. Development use of any project-local root requires
an explicit configured root and remains subject to the same private-root and
authority checks.

## Considered approaches

### Selected: content-addressed catalog plus built-in phase engine

The runtime separates metadata discovery from full package loading. Selected
content is snapshotted and hashed, then a small finite state machine invokes an
audited built-in phase handler. Approval transitions use the existing durable
run journal. This approach preserves progressive disclosure, permits exact
replay, and keeps executable authority out of skill files.

### Rejected: manifest catalog with eager full loading

Eager loading is simpler but places unrelated skill text into memory and
context before selection. It weakens progressive disclosure, increases the
context and secret-scanning surface, and makes catalog enumeration depend on
the validity of every unselected resource.

### Rejected: general workflow interpreter

A generic interpreter would make skill packages executable policy. It would
expand the v1 attack surface, require a sandbox and a new workflow language,
and obscure the fixed phase and approval invariants. The finite built-in engine
meets the release requirements without that authority expansion.

## Source and trust model

### Allowed sources

Production accepts exactly two source classes:

- explicitly configured private per-user skill roots; and
- audited Superpowers definitions bundled in the installed runtime package.

Configured roots are canonical absolute paths below approved per-user roots.
They and their package directories must be current-user mode `0700`; configured
regular files must be current-user mode `0600` with a single link. The host
never searches the workspace, repository, current working directory, home
directory, or package-manager cache implicitly. Root overlap, duplicate
canonical roots, case aliases, identity replacement, symlink ancestry, loose
permissions, and cross-owner content fail closed.

Bundled capabilities are resolved from an internal manifest generated and
verified at build time. Runtime callers cannot add to or override the bundled
namespace. Bundled resources must be regular package files, cannot be
group/world writable, and must match the installed manifest; they are not
subject to the private configured-root mode because installed npm package files
are intentionally readable. If a configured package and bundled package use
the same logical name, selection requires an exact source and content identity;
precedence is never inferred.

### Authority boundaries

Skill content is instruction data only after the control plane authorizes its
capability identity. Name or description matching may suggest candidates but
cannot activate them. Implicit selection intersects discovered candidates with
the agent definition's allowed capabilities and the execution request's exact
requirements. It then resolves one exact source, version, and content hash.
Ambiguity blocks selection rather than using path order or discovery order.

Model output, prompt text, selected skill text, references, and assets cannot
grant a capability, approve a gate, change phase order, enlarge a budget, or
modify an artifact reference. Unknown fields and versions are rejected.

## Contract set

Issue #8 adds five closed Runtime Contract Protocol v1 documents:

- `skill-descriptor.v1` for metadata-only catalog identity;
- `skill-snapshot.v1` for the complete selected package;
- `superpowers-phase.v1` for phase transitions and results;
- `superpowers-approval.v1` for durable pause and decision binding; and
- `skill-execution-evidence.v1` for the bounded downstream evidence handoff.

Every schema uses the existing protocol envelope, exact document-type/version
mapping, canonical JSON, unknown-field rejection, bounded members and bytes,
and lowercase SHA-256 document identity.

### Skill descriptor

The metadata-only descriptor contains:

- protocol, schema, and document type;
- normalized logical skill name and bounded description;
- canonical semantic version;
- source class and stable source identity;
- package content hash;
- declared resource count and bounded aggregate byte size;
- declared required runtime capabilities;
- descriptor hash computed over every other field.

The descriptor contains no instruction body, resource content, absolute path,
secret, environment value, executable permission, or approval claim. Catalog
ordering is deterministic by logical name, version, source identity, and
content hash. Duplicate semantic identities with different bytes are an
integrity conflict.

### Loaded skill snapshot

The snapshot binds the exact descriptor to:

- complete `SKILL.md` bytes;
- a canonical ordered manifest of every referenced file;
- per-resource media type, role, UTF-8 byte length when applicable, and hash;
- the package aggregate hash and accounting;
- the exact built-in Superpowers capability mapping;
- a flag that records script presence while keeping execution unavailable.

The snapshot stores portable relative resource names, never absolute paths.
All values are recursively immutable. The package hash covers the descriptor,
`SKILL.md`, resource manifest, and every resource byte sequence so any content,
framing, ordering, or resource-set change produces a new identity.

### Phase and approval records

The phase record binds:

- run identity and exact execution-request hash;
- journal sequence and previous head hash;
- selected skill descriptor and snapshot hashes;
- built-in phase name and implementation version/hash;
- phase input hash, bounded output hash, and status;
- operation ID and occurrence time.

An approval-pending record additionally binds the exact run, journal head,
phase, skill version/hash, approval request hash, and operation ID. An approval
decision repeats those bindings and adds the decision. A valid decision is
accepted only through the authenticated local control channel. Replaying the
same operation and decision returns the historical result; changing any bound
value is a conflict or stale-state error.

## Catalog and loading architecture

### Metadata discovery

The catalog opens and validates configured roots without following symlinks.
It performs a bounded streaming directory walk with fixed limits for package
count, entries per package, individual file size, aggregate bytes, and nesting
depth. Discovery reads only the package descriptor metadata required to build
the catalog. It does not read `SKILL.md` bodies, references, assets, or scripts.

The catalog snapshot is deterministic and content addressed. Enumeration
overflow, an unrecognized entry, malformed descriptor, unsafe path, mutation,
or duplicate identity blocks the affected catalog snapshot. A required skill
cannot disappear into a warning.

### Secure full loading

After selection, the loader opens the canonical package root and its resource
chain with identity-preserving, no-follow filesystem operations. It validates
every relative reference lexically and by canonical ancestry. Absolute paths,
empty components, traversal, symlinks, hard-link identity surprises,
cross-owner files, devices, sockets, FIFOs, loose modes, invalid UTF-8 where
text is required, and undeclared resources are rejected.

The loader holds exact file identities while reading bounded content, checks
size before allocation, hashes the bytes read, and revalidates file and
directory identity after each asynchronous boundary. It verifies the complete
resource set against the descriptor before publishing an immutable snapshot.
Loading failure produces no partial snapshot and cannot fall back to another
candidate silently.

### Progressive disclosure

Discovery contributes only descriptors to candidate selection. A selected
snapshot exposes `SKILL.md` and only the references needed for the current
phase. Assets remain addressable by hash and are materialized into context only
when the built-in handler requests their declared role.

Context accounting is deterministic by UTF-8 bytes and the runtime's existing
conservative token policy. Required content is never silently omitted. If the
complete mandatory phase input does not fit its assigned budget, execution
stops with a bounded context failure before the phase runs. Optional resources
follow one canonical priority and truncation policy recorded in evidence.

## Superpowers phase engine

The engine supports exactly these v1 phases:

- `BRAINSTORMING`
- `TEST_DESIGN`
- `RED`
- `GREEN`
- `DEBUGGING`
- `REVIEW`
- `VERIFICATION`

Each phase is a versioned built-in handler with a closed input and output
contract. A handler may validate prior evidence, assemble bounded context,
request a durable approval pause, or emit its own phase result. It cannot spawn
a skill script, grant tools, mutate governance artifacts, publish acceptance,
or skip a required predecessor.

The engine validates the phase graph against the execution request and exact
journal state. For example, `GREEN` cannot complete without the exact required
`RED` evidence, and completion cannot be claimed without `VERIFICATION` when
that capability is required. Debugging and review remain distinct from TDD;
one phase's output cannot be relabeled as another phase's evidence.

Built-in handler version and hash are part of the transition preimage. A
resume under a different handler identity is blocked as incompatible rather
than silently migrating an active run.

## Durable pause and resume

Before returning an approval-required result, the coordinator appends and
syncs the exact phase transition and `APPROVAL_PENDING` record. Only after the
journal barrier succeeds does the runtime expose the pause. If persistence is
uncertain, the run remains non-successful and cannot proceed.

The local control request must carry the exact run, expected journal head,
phase, skill identity, approval-request hash, operation ID, and decision. The
coordinator validates those values before any next-phase effect. Old heads,
different skill bytes, different phase implementations, mismatched operations,
unknown decisions, model-produced approvals, and skill-produced approvals are
rejected.

Restart reconstructs the pending approval entirely from the verified journal.
It does not re-discover a replacement skill or recompile an approval request
under new bytes. A valid repeated request replays the stored decision. A
conflicting reuse of the operation ID fails closed. Cancellation and shutdown
use existing journal transitions and cannot convert a pending phase into
success.

## Script boundary

Script resources are parsed as declared package content and included in the
resource and package hashes. Their bytes may be inspected by verification and
reported in evidence metadata, subject to safe redaction rules. They are never
executed, imported, evaluated, or used as a command in v1.0.0 production.

The runtime advertises external skill script execution as unavailable. Any
phase or package that requires script execution is rejected before a process,
shell, network connection, or filesystem mutation is created. There is no
development-mode bypass in this issue. A future sandbox feature requires a
separate design, capability version, threat model, and release decision.

## Error model

Public failures use closed safe codes and never include skill bodies, resource
content, absolute paths, or conflicting bytes. The design distinguishes:

- missing required skill or built-in capability:
  `BLOCKED_SUPERPOWERS_MISSING`;
- malformed or ambiguous selection: invalid skill request;
- unsafe root, resource, ownership, permission, or identity mutation: skill
  integrity/path failure;
- bounded catalog, package, or context overflow: deterministic limit failure;
- unsupported script requirement: unsupported capability;
- stale journal head or approval binding: stale state;
- operation ID reuse with different semantics: operation conflict;
- journal durability uncertainty: integrity/unavailable failure.

Unknown codes, schemas, phase names, versions, capability names, state
transitions, or approval decisions fail closed. None is normalized into
`BLOCKED_SUPERPOWERS_MISSING` unless the required capability is genuinely
absent.

## Evidence and capability reporting

Every successful, failed, or blocked skill execution contributes a canonical
evidence projection containing:

- catalog snapshot hash;
- selected source class, skill name, version, descriptor hash, and package
  content hash;
- ordered resource hash manifest without absolute locations;
- built-in phase name, version, and implementation hash;
- phase input/output hashes and journal transition identities;
- approval request and decision bindings when present;
- progressive-disclosure and context-accounting results;
- output and downstream evidence-handoff hashes;
- stable safe failure code when no phase ran or completed.

Runtime capabilities truthfully advertise the skill host version, supported
skill contract versions, and the exact built-in Superpowers phases. Skill
availability becomes available only when the configured catalog can be safely
opened and the required built-in handlers are present. External script
execution remains unavailable. Capability negotiation never claims a phase
that the phase engine cannot execute with its exact version.

## Lifecycle and shutdown

Catalog reads and snapshot loads accepted before intake stops are tracked by
the skills participant. `stopIntake()` rejects new discovery, load, selection,
phase, and approval mutations. `flush()` waits for accepted journal barriers
and snapshot/evidence publication without initiating recovery or creating
roots through a read path after the shutdown cut.

A crash before a durable selection or phase transition produces no accepted
effect. A crash after a durable `APPROVAL_PENDING` record resumes that same
pause. Partial private artifacts follow the repository's existing
identity-bound, bounded recovery patterns; ambiguous mutation or replacement
is preserved and blocks recovery rather than being overwritten.

## Testing and delivery

The implementation plan must use test-driven development and cover at least:

- explicit discovery and allowed implicit matching;
- metadata-only discovery followed by complete post-selection loading;
- configured private roots, bundled definitions, root aliasing, and duplicate
  identities;
- traversal, absolute paths, symlink ancestry, hard links, ownership, modes,
  missing resources, undeclared resources, mutation, and bounded growth;
- progressive disclosure, exact accounting, mandatory-content overflow, and
  deterministic optional truncation;
- real brainstorming pause, exact approval, stale/conflicting approval,
  idempotent replay, cancellation, restart, and shutdown;
- independent TDD, debugging, review, and verification phase evidence;
- missing skill/capability behavior and no-imitation enforcement;
- script presence in hashes plus process-execution rejection;
- skill, resource, phase, approval, and handoff evidence binding;
- truthful capability negotiation and public package fixtures;
- malicious paths, missing resources, permission changes, replacement races,
  sync failures, and retry/recovery boundaries.

CI and release verification use one macOS job on `node-version: lts/*` with
`check-latest: true`; no fixed Node matrix or non-LTS lane is added. Local
acceptance records the resolved latest LTS version. Full formatting, lint,
strict type checking, tests, build, installed-package acceptance, package
allowlist verification, and production dependency audit must pass.

Issue #8 is delivered on `issue/8-agent-skills-superpowers` in one dedicated PR
targeting `release/v1.0.0`. When the PR checks pass, the issue, PR, and Project
item become Done before merge, as tracked by Epic #16. The PR is then merged
into the release branch and the epic integration state is updated. Tagging,
GitHub Release creation, and npm `1.0.0` publication remain Issue #15 work after
all v1.0.0 release issues are complete.
