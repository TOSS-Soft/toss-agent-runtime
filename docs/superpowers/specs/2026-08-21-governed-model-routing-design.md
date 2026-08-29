# Governed model catalog, routing, budgets, and failover design

## Status and authority

This document defines the approved Issue #6 design for TOSS Agent Runtime
v1.0.0. It builds on Runtime Contract Protocol v1, the normalized provider
contract from Issue #5, the authenticated agentgateway transport from Issue
#3, and the v1 release-program design. Where this document is more specific
about model catalogs, task routing, budget accounting, circuit state,
fallback, review requirements, and route-resolution checks, it is
authoritative for Issue #6.

The catalog and policy authority remains the TOSS control plane. Agentgateway
supplies a fresh, bounded statement of live route availability and capability;
it does not become the policy authority. Runtime output is a deterministic
plan and state transition, never permission to revise governance inputs.

## Goals

- Select logical model classes from required capability, task phase,
  complexity, risk, latency, and budget inputs rather than marketing names.
- Produce the same canonical selection plan for the same catalog, policy,
  state, task, live-capability, override, and decision-time inputs.
- Make the primary worker, capability-equivalent fallbacks, required reviewer,
  budget reservations, eliminated alternatives, and exact governing hashes
  auditable.
- Prevent an agent, prompt, provider, or gateway from increasing model, budget,
  review, or tool authority.
- Reject fallback that weakens any required capability, limit, route
  restriction, review rule, or budget boundary.
- Account for input, output, cached-input, and reasoning token costs with exact
  integer microusd arithmetic.
- Keep circuit state explicit, versioned, replayable, and free of hidden daemon
  counters.
- Bind the gateway's exact attested route identity back to the accepted plan.

## Non-goals and owning issues

- Agent definitions and context compilation belong to Issue #7.
- Skill selection and Superpowers execution belong to Issue #8.
- Governed MCP tool execution and approval propagation belong to Issue #9.
- Executing worker turns and consuming the fallback plan belong to Issue #10.
- Independent worker/reviewer orchestration and its execution proof belong to
  Issue #11.
- Final ACP execution evidence and authoritative gateway usage reconciliation
  belong to Issue #12.
- Full secret, egress, prompt-injection, and sandbox hardening belongs to Issue
  #13.
- Protected live-provider routing smoke and release guidance belong to Issue
  #15.

Issue #6 supplies pure planning, budget, circuit, and resolution-verification
boundaries for those consumers. It opens no network connection, invokes no
provider, persists no state, and performs no automatic retry.

## Architectural choice

The runtime implements a pure deterministic routing core. Every value that can
change a decision is an explicit, immutable input: catalog, policy, run-scoped
routing state, execution request, task profile, per-call ceilings, live gateway
capabilities, optional governed override, and canonical decision time. The core
returns a canonical selection plan and, when a call is reserved, the exact next
routing-state revision.

The rejected alternatives are:

- A stateful router with process-local budgets or circuit counters would make
  restart, replay, concurrency, and exact-input determinism ambiguous.
- Delegating governed routing to agentgateway would move control-plane policy,
  review, budget, and explanation authority into an edge transport.
- Selecting raw provider model names directly from the execution request would
  bind governance to provider branding and bypass logical capability classes.

## Core documents and inputs

Issue #6 adds four canonical Runtime Contract Protocol documents:

- `model-catalog.v1` is the control-plane-approved catalog.
- `routing-policy.v1` contains phase, complexity, risk, review, fallback, and
  circuit policy.
- `routing-state.v1` contains the exact run budget and circuit head.
- `model-selection-plan.v1` records either a planned selection or an explicit
  blocked result.

An optional governed override is a closed canonical record carried with its
exact authoritative artifact reference. It is not a fifth source of policy:
it can only select an entry already permitted by the referenced policy and
catalog revisions.

All four documents contain `protocol_version`, `schema_version`,
`document_type`, a safe stable identity, a nonnegative safe-integer revision,
and `document_hash`. The hash is lowercase SHA-256 of canonical JSON with the
`document_hash` member omitted. Unknown properties, duplicate JSON keys,
unsafe identifiers, noncanonical timestamps, invalid hashes, and unsupported
versions fail closed.

### Model catalog

`model-catalog.v1` contains 1 to 1,024 entries and is at most 2 MiB. A catalog
entry has this conceptual shape:

```ts
type LogicalModelClass =
  "economy" | "balanced-code" | "deep-reasoning" | "long-context" | "vision" | "independent-review";

interface ModelCatalogEntryV1 {
  readonly entry_id: string;
  readonly logical_classes: readonly LogicalModelClass[];
  readonly route_alias: string;
  readonly priority: number;
  readonly routes: readonly CatalogRouteV1[];
}

interface CatalogRouteV1 {
  readonly route_id: string;
  readonly provider: "openai" | "anthropic" | "gemini";
  readonly model: string;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly latency_class: "interactive" | "standard" | "extended";
  readonly pricing: {
    readonly input_microusd_per_million: number;
    readonly cached_input_microusd_per_million: number;
    readonly output_microusd_per_million: number;
    readonly reasoning_output_microusd_per_million: number;
  };
}
```

Entry IDs and exact route IDs are unique. Logical classes are sorted and
unique. `priority` is a nonnegative safe integer; lower values are preferred.
Every price is a nonnegative safe integer. Catalog capabilities are governance
ceilings, not claims that a route is currently live. A route is selectable only
when an exact route ID, alias, provider, model, and capability-compatible entry
also appears in the fresh agentgateway capability document.

Every selectable production route must contain all four price fields. A route
whose price is absent, unknown, or cannot be represented safely is not eligible;
the router never substitutes a zero price or an estimate.

Multiple exact routes may share one alias because agentgateway can perform
equivalent internal failover. The router treats the alias entry as one attempt,
records the exact accepted route set, and reserves the greatest possible cost
and latency among that set. The gateway's eventual attestation must identify
one exact accepted route. A catalog route missing from the live document is not
eligible, and a live route missing from the catalog never gains authority.

### Routing policy

`routing-policy.v1` contains 1 to 256 ordered rules and is at most 512 KiB.
Each rule has a unique ID and priority, closed match criteria for task phase,
complexity, and risk, an ordered worker-class preference, latency ceiling,
review requirement, maximum fallback count, and fixed circuit settings. The
task vocabulary is:

```ts
type TaskPhase = "analysis" | "implementation" | "review";
type TaskComplexity = "low" | "medium" | "high" | "critical";
type TaskRisk = "security" | "architecture" | "irreversible";
```

Rules are matched by ascending priority and then stable rule ID. Semantic
validation rejects ambiguous rules with the same priority and overlapping
match space. One explicit catch-all rule is required. A rule can strengthen
the execution request's logical class or required capabilities but cannot
remove either.

Any task containing `security`, `architecture`, or `irreversible` risk must
produce a reviewer requirement with logical class `independent-review`. The
reviewer entry must be route-independent from the worker: every accepted
reviewer route must have both a provider and model identity different from
every accepted worker route. If no such pair fits capability and total budget,
the decision is blocked. Issue #11 later proves that the two planned roles were
actually executed independently.

Circuit policy contains a consecutive-failure threshold, cooldown duration,
and maximum number of fallbacks. Only the stable outcomes
`RUNTIME_PROVIDER_TIMEOUT`, `RUNTIME_PROVIDER_TRANSIENT`, and
`RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE` affect circuit state or permit
automatic fallback consumption. Authentication, rate-limit, cancellation,
refusal, invalid response, capability downgrade, integrity, policy, and
internal failures cannot be used to bypass a route or organization control.

### Routing state

`routing-state.v1` is run-scoped, at most 2 MiB, and bound to exact catalog and
policy hashes. It contains:

- the run ID and exact execution-request hash;
- the original `RuntimeBudget` limits;
- settled input/output tokens, microusd, duration, and turns;
- active reservations keyed by deterministic decision ID;
- budget status `known` or `unknown`;
- one circuit record per catalog entry that has observed a relevant outcome;
- the exact prior revision and document hash.

A circuit record is `closed`, `open`, or `probe-reserved`, with consecutive
failure count and canonical `retry_at` where applicable. When decision time is
at or after `retry_at`, an open entry can become the single half-open probe only
by creating a reservation against the exact state head. Persisting that next
state with existing exact-head journal semantics prevents two callers from
claiming the same probe.

No wall clock is read inside the routing core. Canonical `decision_at` and
outcome timestamps are explicit inputs and are included in output hashes.

### Governed task and override inputs

The router consumes an already validated `ExecutionRequestV1` plus a closed
task profile bound to its exact task-contract artifact reference:

```ts
interface RoutingTaskProfile {
  readonly task_contract: ArtifactReference;
  readonly phase: TaskPhase;
  readonly complexity: TaskComplexity;
  readonly risks: readonly TaskRisk[];
  readonly max_latency_class: "interactive" | "standard" | "extended";
}

interface RoutingCallCeilings {
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly max_duration_ms: number;
}
```

The task profile is control-plane input. The runtime never derives risk,
complexity, authority, or override from prompt text, provider output,
repository content, or agent messages.

The accepted routing-capability vocabulary is closed to `text`, `tools`,
`json-schema`, `vision`, `reasoning`, `streaming`, `long-context`, and
`independent-review`. `text` is the base provider capability; the five native
feature names map to the corresponding catalog/live capability intersection;
`long-context` and `independent-review` additionally require their exact
logical class. Numeric context and output ceilings are enforced independently
for every route. An unknown capability name is policy-invalid, not a marketing
model selector.

An optional override contains an authoritative artifact reference, target
catalog entry ID, exact catalog and policy hashes, canonical issuance time, and
one closed reason code. Its canonical content hash must equal the artifact
reference hash. It may select only an otherwise eligible entry. It cannot add
capabilities, increase any budget or tool boundary, weaken review, reopen a
circuit, exceed latency policy, or target a stale catalog/policy revision.
An override issued after the explicit decision time is invalid.

## Selection algorithm

`planModelSelection()` performs these steps in exact order:

1. Validate and freeze every document and input before any state transition.
2. Require state catalog/policy/request bindings to equal the supplied hashes.
3. Match exactly one policy rule from phase, complexity, and sorted risk set.
4. Combine execution-request logical class and capabilities with all stronger
   rule requirements; never subtract a request requirement.
5. For each candidate alias, enumerate the complete set of live routes the
   gateway could execute for the exact emitted requirement and require an exact
   catalog alias, route ID, provider, and model match for every route.
6. Reject the whole alias when any executable route is live-only, denied,
   under-capable, too small, too slow, unpriced, reviewer-colliding, circuit
   blocked, or over budget. Include the complete safe set in `accepted_routes`
   and reserve its maximum governed price.
7. Sort eligible entries by rule class preference, catalog priority,
   worst-case microusd cost, worst latency class, and stable entry ID.
8. Apply a valid governed override by narrowing the already eligible set to its
   exact entry. Reject an ineligible or stale override; never ignore it.
9. Select one worker alias and at most the policy fallback limit. Every
   fallback must independently satisfy the complete worker requirement.
10. If review is required, select an independent reviewer. Atomically reserve
    the primary worker, every planned fallback, and reviewer ceilings together.
    No partial plan is returned.
11. Return a canonical `model-selection-plan.v1` and exact next routing state,
    or a canonical blocked plan with no state mutation.

The router sorts semantic sets and candidate arrays with fixed ASCII ordering
before evaluation. Reordering and rehashing an authoritative catalog or live
capability document cannot change the selected entries, attempts, or
elimination reasons, but the plan hash still changes as required to bind the
new exact input hash. Object insertion order and host locale never affect the
result. Comparisons use fixed ASCII/code-unit ordering, not the host locale.

## Selection plan

`model-selection-plan.v1` is at most 2 MiB and has `status: "planned"` or
`status: "blocked"`.

A planned document contains:

- deterministic decision ID and plan hash;
- run, request, task-contract, catalog, policy, state, live-capability, and
  optional override identities and hashes;
- matched policy rule and safe reason codes;
- worker primary and ordered fallback attempts;
- every attempt's entry ID, alias, exact accepted route identities, complete
  capability requirement, worst-case cost, and latency class;
- independent reviewer selection where required;
- one combined budget reservation;
- the closed, hash-bound request deadline and live-capability expiry;
- all eliminated catalog entries with one stable allowlisted reason code;
- prior and reserved next-state revisions/hashes.

Elimination records never contain provider error strings, prompts, endpoints,
headers, credentials, arbitrary metadata, or native objects. They are bounded
to the catalog entry count and sorted by entry ID.

A blocked document contains no executable attempt and one of:

- `RUNTIME_ROUTING_BUDGET_EXCEEDED`;
- `RUNTIME_ROUTING_NO_CAPABLE_ROUTE`;
- `RUNTIME_ROUTING_REVIEW_UNAVAILABLE`;
- `RUNTIME_ROUTING_POLICY_DENIED`;
- `RUNTIME_ROUTING_CIRCUIT_OPEN`;
- `RUNTIME_ROUTING_STALE_STATE`;
- `RUNTIME_ROUTING_USAGE_UNKNOWN`.

All-open circuit output is retryable and may expose only the earliest safe
`next_retry_at`. Other blocked routing results are nonretryable until a new
authoritative input revision is supplied.

## Exact budget accounting

All public costs are integer microusd. Intermediate multiplication and
division use `bigint`; a result outside JavaScript's nonnegative safe-integer
range is invalid. Floating point is never used for money.

For actual usage, cached input is a subset of input and reasoning output is a
subset of output:

```text
uncached_input = input_tokens - cached_input_tokens
ordinary_output = output_tokens - reasoning_tokens
cost = ceil(uncached_input * input_rate / 1_000_000)
     + ceil(cached_input * cached_input_rate / 1_000_000)
     + ceil(ordinary_output * output_rate / 1_000_000)
     + ceil(reasoning_tokens * reasoning_output_rate / 1_000_000)
```

Negative subsets, noninteger usage, or overflow fail closed. A reservation
uses the call's maximum input tokens, the maximum of ordinary/reasoning output
rates for maximum output tokens, maximum duration, and one turn for each
planned attempt. An alias with multiple accepted routes reserves the greatest
cost among them. Primary worker, every planned fallback, and required reviewer
allocations are summed and checked atomically against every remaining run
limit. The reservation retains one immutable allocation per attempt so
settlement can price the exact route actually used.

The reservation also stores a `decision_hash` over the complete planned
decision payload, including bindings, attempts, price snapshots, requirements,
allocations, and eliminations, with `decision_hash`, next-state identity, and
the final document hash omitted. The next state therefore binds the plan
semantics without a plan/state hash cycle. The final plan then binds the exact
next-state hash.

`settleRoutingDecision()` requires the exact reservation, plan hash, attested
routes, and usage for every attempted allocation. Unused allocations are
released; attempted allocations are priced from their exact accepted route and
added to actual input/output, cost, duration, and turn values. If actual
settled usage crosses a run limit, the settlement outcome is `FAILED` and the
new state prevents every later reservation. A decision that may have incurred
provider usage but lacks a trusted complete route or usage record sets budget
status to `unknown`; later routing is blocked with
`RUNTIME_ROUTING_USAGE_UNKNOWN` until Issue #12 supplies an authoritative
reconciliation transition.

Budget exhaustion before a provider effect is `BLOCKED`. Budget exhaustion or
unknown cost after a provider effect is `FAILED`. Issue #10 records that run
outcome; Issue #6 does not mutate the run journal itself.

## Circuit and fallback transitions

`recordRoutingOutcome()` is a pure exact-head transition. It consumes the
prior routing state, decision/attempt identity, stable provider outcome,
canonical timestamp, and whether a provider effect may have occurred.

- Success closes the attempt entry circuit and resets consecutive failures.
- Timeout or upstream transient failure increments the exact entry circuit.
- Gateway unavailable increments the selected gateway-alias entry circuit.
- Reaching the threshold opens the circuit until policy cooldown expires.
- A failed half-open probe reopens it; a successful probe closes it.
- Every other stable failure leaves circuit counters unchanged and does not
  authorize fallback.

Fallback consumption is explicit. `nextModelFallback()` requires the exact
plan, current attempt index, stable allowlisted outcome, current routing-state
head, remaining deadline, and remaining budget. It returns the next preplanned
attempt or a blocked result. Transport code still performs no automatic retry.

## Route-resolution verification

`verifyResolvedRoute()` compares the gateway's frozen
`ProviderRouteIdentity` with the exact current plan attempt. It requires:

- transport `agentgateway` and the selected gateway profile;
- requested alias equal to the attempt alias;
- route ID/provider/model equal to one accepted route;
- gateway revision and capability-document hash equal to the plan;
- requirement hash equal to the attempt requirement;
- no circuit, state, or policy revision change since reservation.

Mismatch produces `RUNTIME_ROUTING_RESOLUTION_MISMATCH`. The provider payload
or completion is not accepted as a successful planned result. The mismatch
cannot silently become a different selection or evidence identity.
`RUNTIME_ROUTING_RESOLUTION_MISMATCH` is a post-plan verification failure, not
a blocked-plan status.

## Public API and component boundaries

`src/routing/` is split by responsibility:

- `types.ts` owns immutable public document and operation types.
- `contracts.ts` parses, semantically validates, hashes, and freezes the four
  protocol documents and governed override fragment.
- `cost.ts` performs exact reservation and settlement arithmetic.
- `selection.ts` implements deterministic eligibility, ordering, planning,
  review pairing, and blocked outcomes.
- `circuit.ts` implements exact-head circuit and fallback transitions.
- `resolution.ts` binds a route attestation to one plan attempt.
- `errors.ts` owns stable safe routing errors and result codes.
- `index.ts` exports only safe parsers, hashes, pure operations, and immutable
  types.

The top-level package exports the public routing surface. It does not export
mutable caches, persistence constructors, filesystem hooks, network clients,
native provider values, arbitrary scoring callbacks, or fake helpers.

When Issue #6 package acceptance is complete, baseline runtime capabilities
advertise routing as available, the six fixed logical classes under
`model_classes`, and all four new schema versions under `supported_schemas`.
Agent loop, skills, MCP, review execution, and evidence remain truthful to
their separate availability states.

## Security and trust boundary

- Catalog, policy, state, plan, task, live capability, and override inputs are
  bounded and validated before selection or state change.
- The control plane owns catalog, policy, task classification, and override
  authority. Runtime and agent output cannot mint or amend them.
- A capability document can remove live options but cannot add catalog or
  policy authority.
- Prompts, response bodies, headers, tokens, endpoints, environment maps,
  provider diagnostics, and tool payloads have no routing-document field.
- Stable errors and elimination reasons are fixed, safe, and non-reflective.
- Exact hashes and revisions prevent silent catalog, policy, state, live-route,
  or override drift between planning, reservation, fallback, and settlement.
- Unknown budget, ambiguous review independence, stale state, arithmetic
  overflow, untrusted route identity, and unsupported capability all fail
  closed.

## Test strategy

### Contract and semantic tests

- valid closed documents parse and freeze;
- duplicate keys, unknown fields, oversize documents, invalid identifiers,
  unsafe numbers, noncanonical times, duplicate IDs, bad hashes, and stale
  cross-references reject safely;
- catalog/policy/state/plan hash round trips are deterministic;
- governed override content is bound to its artifact hash and exact revisions.

### Deterministic selection tests

- permutations of semantically equivalent catalog and live-route arrays yield
  the same selected entries, attempts, and elimination reasons while plan
  hashes remain bound to the exact rehashed authoritative inputs;
- phase, complexity, risk, logical-class, capability, latency, and policy-rule
  matrices select the expected entry;
- marketing names never affect eligibility except as exact attested identity;
- stable tie-breaking covers class preference, priority, cost, latency, and
  entry ID;
- up to 1,024 catalog entries and 256 live routes remain within documented
  time and memory bounds.

### Budget and review tests

- exact microusd rounding, cached/reasoning subsets, overflow, and maximum
  safe-integer cases;
- worker-only and atomic primary-plus-fallback-plus-reviewer reservations;
- reviewer provider/model independence across every accepted route pair;
- pre-effect BLOCKED, post-effect FAILED, unknown-usage blocking, exact
  settlement, duplicate/stale reservation rejection, and remaining-limit
  boundaries;
- stale or authority-expanding overrides reject without silent fallback.

### Circuit, fallback, and attestation tests

- threshold, open, cooldown, single half-open probe, success close, and failed
  probe reopen transitions;
- only timeout, transient, and gateway-unavailable outcomes affect circuits or
  permit fallback;
- fallback preserves every capability, review, deadline, and budget boundary;
- route alias, route ID, provider, model, capability hash, revision, and
  requirement-hash mismatches reject;
- a real loopback agentgateway capability/attestation fixture binds to the
  selected plan without live credentials.

### Repository and delivery gates

- public API includes only safe parsers, hashes, pure operations, and types;
- schema manifest, capability example, routing examples, README, protocol
  docs, changelog, and exact package allowlist agree;
- latest Node.js LTS macOS format, lint, typecheck, full tests, build,
  installed-package acceptance, and production audit pass;
- protected live-provider routing smoke remains explicitly pending Issue #15.

## Delivery and GitHub state

Issue #6 uses branch `issue/6-governed-model-router` and one dedicated PR
against `release/v1.0.0`. The issue and PR project items become Done and the
issue closes when the exact PR head passes the required macOS CI job and all
Issue #6 acceptance criteria. Merge into the version branch is recorded
separately in Epic #16.
