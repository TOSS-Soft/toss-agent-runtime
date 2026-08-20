# TOSS Agent Runtime v1.0.0 Release Program Design

## Status and authority

This document records the approved delivery and release design for TOSS Agent
Runtime v1.0.0. It complements the normative runtime architecture in
`2026-08-19-v1-runtime-architecture-design.md` and overrides that document only
where this program design narrows the platform scope or defines GitHub delivery
mechanics.

The target is the public npm package
`@toss-software/agent-runtime@1.0.0`, the `toss-runtime` executable, a signed
`v1.0.0` Git tag, and a non-draft GitHub Release. The compatible control plane
is `@toss-software/cli` v2.2.0. Runtime execution never grants governance or
acceptance authority; those decisions remain with TOSS CLI.

## Approved release boundary

- v1.0.0 supports macOS only.
- Supported Node lines are Node.js 22 with a floor of 22.23.0 and Node.js 24.
- Linux, Windows, Kubernetes, authenticated remote control, parallel local
  scheduling, distributed workers, durable memory, operator UI, and agent mesh
  execution are outside v1.0.0.
- Production provider traffic uses agentgateway. Direct-provider mode exists
  for explicitly configured development and protected conformance tests.
- The supported providers are OpenAI, Anthropic, Gemini, and
  OpenAI-compatible agentgateway transport.
- Execution topology is one sequential worker followed by an independent
  reviewer when policy requires review.

The package metadata, documentation, CI, service definitions, and release
claims must not advertise Linux support for v1.0.0. Linux service support is a
separate later-release deliverable.

## Version integration branch

The shared integration branch is `release/v1.0.0`, created from `main` before
any v1 implementation PR is integrated.

1. PR #33 is integrated first.
2. PR #34 is integrated second after its base is aligned with the version
   branch.
3. Every remaining issue uses one branch and one PR whose base is
   `release/v1.0.0`.
4. Each accepted PR is merged into `release/v1.0.0` only after its own checks
   are green and the version branch remains green after integration.
5. `main` receives no incomplete v1 implementation. The only implementation
   merge to `main` is the final `release/v1.0.0` PR after every release gate
   passes.

PR #33 is the sole historical exception to the one-issue/one-branch/one-PR
rule: it covers the coupled #2 contract and #4 package-baseline deliveries.
Beginning with #28, the rule has no exception.

## GitHub status contract

GitHub Project status and issue state reflect delivery acceptance, while the
v1 epic separately reflects version-branch integration.

- `Todo`: implementation has not started.
- `In progress`: the issue branch or PR is active, or required acceptance
  criteria remain unmet.
- `Done`: the issue's dedicated PR covers every acceptance criterion and all
  required PR checks are successful.
- A `Done` issue is closed without waiting for its PR to merge.
- A green PR does not make an issue `Done` if the PR explicitly leaves an
  acceptance criterion or dependency incomplete.
- Epic #16 records whether every accepted PR is integrated into
  `release/v1.0.0` and whether the final branch is merged to `main`.

At issue start, the project item moves to `In progress` and receives a comment
linking its branch and intended PR. During work, material design decisions,
blockers, acceptance changes, and verification evidence are added to the issue.
After green acceptance, the issue moves to `Done`, closes, and epic #16 is
updated. After merge, only epic #16's integration checklist changes.

## Dependency waves

The release is implemented in ordered dependency waves. A later wave may be
designed while the current wave is running, but implementation cannot bypass a
required predecessor.

### Wave 0: integrate accepted foundations

- Integrate PR #33 for issues #2 and #4.
- Integrate PR #34 as the existing #28 service-foundation PR.
- Re-run the complete macOS Node 22/24 version-branch gate.
- Keep #28 `In progress` until durable `INTERRUPTED` state and the remaining
  macOS login/service acceptance are proven.

### Wave 1: durable service state

1. #1 immutable run journal and resumable state machine.
2. #29 explicit project registry, bounded watcher, and debounced intake.
3. #30 operational JSONL logs, redaction, rotation, retention, and rendering.
4. #28 final acceptance against the durable journal and real macOS service
   lifecycle.

The journal is a predecessor for any provider, tool, approval, or review side
effect. Watcher intake can create only candidate work and cannot cross an
authority gate.

### Wave 2: provider transport and governed routing

1. #5 normalized provider adapter contract and provider conformance.
2. #3 authenticated agentgateway transport and trace propagation.
3. #6 deterministic model catalog, budgets, fallback, and circuit breakers.

The router consumes normalized capabilities and health; it never imports a
provider SDK object or accepts model self-escalation.

### Wave 3: agent execution

1. #7 immutable agent registry and provenance-aware context compiler.
2. #8 Agent Skills host and Superpowers execution phases.
3. #9 scoped MCP broker, approval gates, and idempotent tool calls.
4. #10 bounded structured-output LLM loop with pause, resume, and cancel.

Every model and tool turn is durable before the next irreversible action. A
missing skill, denied tool, stale approval, exhausted budget, or invalid output
terminates or pauses with a stable fail-closed result.

### Wave 4: independent review, evidence, and security

1. #11 sequential worker/reviewer orchestration and independence policy.
2. #12 ACP-compatible evidence, usage reconciliation, and trace correlation.
3. #13 containment, secret, egress, SSRF, sandbox, and injection hardening.

Review findings cannot mutate worker artifacts. Evidence binds the request,
journal head, result, exact provider/model route, tools, approvals, skills,
usage, and traces without persisting secrets.

### Wave 5: conformance and release

1. #14 conformance, adversarial, reliability, recovery, and cost suites.
2. #15 operator CLI, documentation, package metadata, and release automation.
3. #16 epic closes only after all issue and release gates are complete.

## Runtime component boundaries

- `protocol` owns closed schemas, canonical JSON, hashes, compatibility, and
  trust-boundary validation.
- `journal` owns append-only records, legal transitions, recovery, and
  idempotency reservations. It is the canonical execution-state source.
- `service` owns the macOS per-user supervisor, private local RPC, project
  registry, intake, and operational-log lifecycle.
- `providers` owns normalized streams and provider/gateway edge adapters.
- `routing` owns immutable catalogs, selection plans, budgets, fallback, and
  health-derived circuit state.
- `agents` owns immutable agent definitions and context provenance.
- `skills` owns content-addressed Agent Skills loading and Superpowers phases.
- `tools` owns MCP discovery, policy, approval, validation, redaction, and
  side-effect idempotency.
- `orchestration` owns the bounded agent loop and sequential worker/reviewer
  pipeline.
- `evidence` owns execution/review evidence, usage reconciliation, and trace
  identities.
- `security` owns secret, filesystem, process, sandbox, and egress policies.
- `cli` owns stable grammar, versioned JSON output, and human rendering.

Filesystem, process, network, provider SDK, MCP SDK, telemetry, and macOS
service-manager implementations are edge adapters. Native values never become
canonical protocol, journal, or evidence values.

## Execution and recovery flow

1. Parse bounded input and reject unsupported schema, authority, secret-shaped
   content, stale references, and unavailable capabilities before effects.
2. Create or load the exact run journal and verify its complete hash chain.
3. Resolve a deterministic route from exact catalog, policy, health, and budget
   revisions.
4. Compile context only from verified inputs; mark repository, web, model, and
   tool content as untrusted.
5. Persist the intended provider or tool operation and its idempotency identity.
6. Perform the edge call and append normalized events without SDK leakage.
7. Persist approval, pause, cancel, interruption, or completion before exposing
   the new terminal state.
8. Run independent review when policy requires it.
9. Emit result and evidence bound to the request hash and journal head.
10. Let TOSS CLI independently decide governance or acceptance consequences.

Crash recovery verifies exact revisions and identities. Partial final records
may be quarantined; broken interior chains block the run. Uncertain external
effects are never retried automatically. Supervisor stop persists active runs
as `INTERRUPTED` before completing bounded shutdown.

## Error and safety model

Public failures have stable code, category, retryability, safe message, and
trace identity. Invalid input, stale revision, unsupported capability, policy
denial, approval required, authentication, rate limit, refusal, timeout,
cancellation, unavailable dependency, integrity failure, and internal failure
remain distinguishable.

Unknown schemas, capabilities, transitions, routes, permissions, identities,
or security profiles fail closed. Secret-bearing values are structurally tagged
and redacted before generic metadata reaches logs or evidence. Raw prompt,
provider payload, tool output, environment, credentials, and unrestricted
diagnostics are not operational-log fields.

## Per-issue verification gate

Every issue follows test-driven development:

1. Add an acceptance-focused failing test and record the expected failure.
2. Implement the smallest coherent behavior.
3. Pass focused tests and regression tests for adjacent boundaries.
4. Pass formatting, lint, strict type checking, and package build.
5. Pass the full macOS matrix on Node 22.23.1 and Node 24.
6. Pass installed-package smoke and production dependency audit.
7. Map every issue acceptance criterion to code, test, documentation, or an
   explicit protected integration gate.
8. Record the PR, exact commit, commands, results, skips, and residual gates on
   the issue.

Only then can the issue move to `Done`. After the PR merges into the version
branch, the complete branch gate runs again; a regression reopens or blocks the
owning issue and integration checklist.

## Protected live-provider gate

Final release requires bounded live smoke tests for OpenAI, Anthropic, Gemini,
and agentgateway in a protected GitHub environment. Credentials are injected
only through GitHub environment secrets, never accepted as CLI arguments, and
never written to source, caches, logs, artifacts, evidence, or package output.

Each live test verifies authentication, one bounded completion, streaming
normalization, structured output where supported, usage and resolved-route
evidence, trace correlation, cancellation, and secret absence. Missing secrets,
an unavailable required provider, an unclassified response, or a redaction
failure blocks publication.

## Final release transaction

The final release PR contains the complete integrated implementation, exact
`1.0.0` package and lock metadata, changelog, operator documentation, generated
SBOM/provenance configuration, and release evidence references.

The release sequence is:

1. Run the full hermetic macOS Node 22/24 gate on `release/v1.0.0`.
2. Run the protected live-provider gate.
3. Build one npm tarball from the exact clean commit and record contents,
   integrity, SHA-256, and SBOM.
4. Verify that npm `1.0.0`, tag `v1.0.0`, and the GitHub Release do not already
   exist with different content.
5. Merge the final `release/v1.0.0` PR to `main` without changing verified
   content.
6. Create the signed `v1.0.0` tag on the exact verified main commit.
7. Publish the exact tarball with npm provenance.
8. Publish the non-draft, non-prerelease GitHub Release with checksums, SBOM,
   compatibility, and known scope.
9. Verify npm, tag, GitHub Release, and `main` all identify the same source and
   artifact digest.
10. Mark #15 and #16 `Done`, close the v1.0.0 milestone, and publish the final
    epic status only after step 9 succeeds.

Release automation is resumable. If a later publication surface fails after an
earlier one succeeds, a retry first compares immutable version, tag, commit, and
digest identities. Exact matches continue; mismatches stop without overwrite or
republish.

## Design acceptance

This design is accepted when:

- the macOS-only scope is reflected in GitHub and repository contracts;
- the version branch and one-issue/one-PR status rules are enforced;
- all dependency waves preserve a green, packageable integration branch;
- each issue closes only after its acceptance-complete PR checks are green;
- journal, authority, side-effect, review, evidence, and secret boundaries are
  implemented and independently tested;
- protected live-provider tests pass;
- the final npm package, tag, GitHub Release, and main commit are identical in
  version and provenance.
