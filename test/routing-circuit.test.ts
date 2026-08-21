import { describe, expect, it } from "vitest";

import { sha256 } from "../src/protocol/json.js";
import type { ProviderRouteIdentity, ProviderUsage } from "../src/providers/types.js";
import type { RuntimeProviderErrorCode } from "../src/providers/errors.js";
import { nextModelFallback, recordRoutingOutcome } from "../src/routing/circuit.js";
import { hashRoutingState } from "../src/routing/contracts.js";
import { settleRoutingDecision } from "../src/routing/cost.js";
import { RuntimeRoutingError } from "../src/routing/errors.js";
import { planModelSelection } from "../src/routing/selection.js";
import type {
  PlannedModelSelectionPlanV1,
  RecordedRoutingOutcome,
  RoutingAttemptResult,
  RoutingAttemptV1,
  RoutingCircuitV1,
  RoutingOutcomeTransition,
  RoutingStateV1,
} from "../src/routing/types.js";
import { plannedRoutingFixture, type PlannedRoutingFixture } from "./helpers/routing-fixtures.js";

const OCCURRED_AT = "2026-08-21T12:00:30.000Z";
const ALLOWED_OUTCOMES = [
  "RUNTIME_PROVIDER_TIMEOUT",
  "RUNTIME_PROVIDER_TRANSIENT",
  "RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE",
] as const satisfies readonly RuntimeProviderErrorCode[];
const ALL_PROVIDER_OUTCOMES = [
  "RUNTIME_PROVIDER_INVALID",
  "RUNTIME_PROVIDER_UNSUPPORTED",
  "RUNTIME_PROVIDER_ROUTE_NOT_FOUND",
  "RUNTIME_PROVIDER_AUTHENTICATION",
  "RUNTIME_PROVIDER_RATE_LIMIT",
  "RUNTIME_PROVIDER_REFUSAL",
  "RUNTIME_PROVIDER_TIMEOUT",
  "RUNTIME_PROVIDER_CANCELLED",
  "RUNTIME_PROVIDER_TRANSIENT",
  "RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE",
  "RUNTIME_PROVIDER_CAPABILITY_DOWNGRADE",
  "RUNTIME_PROVIDER_GATEWAY_INVALID",
  "RUNTIME_PROVIDER_UNAVAILABLE",
  "RUNTIME_PROVIDER_INTERNAL",
] as const satisfies readonly RuntimeProviderErrorCode[];
const TERMINAL_NON_FALLBACK_OUTCOMES = ALL_PROVIDER_OUTCOMES.filter(
  (outcome) => !ALLOWED_OUTCOMES.includes(outcome as (typeof ALLOWED_OUTCOMES)[number]),
);

function primary(fixture: PlannedRoutingFixture): RoutingAttemptV1 {
  const attempt = fixture.plan.worker_attempts[0];
  if (attempt === undefined) throw new Error("missing primary fixture attempt");
  return attempt;
}

function routeIdentity(
  attempt: RoutingAttemptV1,
  overrides: Partial<ProviderRouteIdentity> = {},
): ProviderRouteIdentity {
  const route = attempt.accepted_routes[0];
  if (route === undefined) throw new Error("missing accepted fixture route");
  return {
    transport: "agentgateway",
    gateway_profile: attempt.gateway_profile,
    gateway_revision: attempt.gateway_revision,
    route_id: route.route_id,
    requested_model: attempt.alias,
    resolved_provider: route.provider,
    resolved_model: route.model,
    capability_document_hash: attempt.capability_document_hash,
    requirement_hash: attempt.requirement_hash,
    gateway_request_id: "gateway-request-circuit-1",
    ...overrides,
  };
}

function attemptResult(
  attempt: RoutingAttemptV1,
  overrides: Partial<RoutingAttemptResult> = {},
): RoutingAttemptResult {
  const usage: ProviderUsage = {
    input_tokens: 1_000,
    output_tokens: 200,
    cached_input_tokens: 100,
    reasoning_tokens: 20,
  };
  return {
    attempt_id: attempt.attempt_id,
    route_identity: routeIdentity(attempt),
    usage,
    duration_ms: 1_000,
    effect_may_have_occurred: true,
    ...overrides,
  };
}

function record(
  fixture: PlannedRoutingFixture,
  outcome: RuntimeProviderErrorCode | "RUNTIME_PROVIDER_SUCCESS",
  state: RoutingStateV1 = fixture.state,
  attempt: RoutingAttemptV1 = primary(fixture),
): RoutingStateV1 {
  return recorded(fixture, outcome, state, attempt).state;
}

function recorded(
  fixture: PlannedRoutingFixture,
  outcome: RuntimeProviderErrorCode | "RUNTIME_PROVIDER_SUCCESS",
  state: RoutingStateV1 = fixture.state,
  attempt: RoutingAttemptV1 = primary(fixture),
  occurredAt: string = OCCURRED_AT,
): RecordedRoutingOutcome {
  return recordRoutingOutcome({
    state,
    plan: fixture.plan,
    policy: fixture.policy,
    attempt_id: attempt.attempt_id,
    outcome,
    occurred_at: occurredAt,
  });
}

function fallback(
  fixture: PlannedRoutingFixture,
  input: Readonly<{
    state: RoutingStateV1;
    attempt?: RoutingAttemptV1;
    outcome?: RuntimeProviderErrorCode;
    previous_state?: RoutingStateV1;
    policy?: PlannedRoutingFixture["policy"];
    transition?: RoutingOutcomeTransition;
    occurred_at?: string;
    results?: readonly RoutingAttemptResult[];
    remaining_duration_ms?: number;
  }>,
) {
  const attempt = input.attempt ?? primary(fixture);
  const outcome = input.outcome ?? "RUNTIME_PROVIDER_TIMEOUT";
  const previousState = input.previous_state ?? fixture.state;
  const occurredAt = input.occurred_at ?? OCCURRED_AT;
  const transition =
    input.transition ?? recorded(fixture, outcome, previousState, attempt, occurredAt).transition;
  return nextModelFallback({
    state: input.state,
    previous_state: previousState,
    plan: fixture.plan,
    policy: input.policy ?? fixture.policy,
    transition,
    current_attempt_id: attempt.attempt_id,
    outcome,
    occurred_at: occurredAt,
    attempt_results: input.results ?? [attemptResult(attempt)],
    remaining_duration_ms: input.remaining_duration_ms ?? 300_000,
  });
}

function circuit(state: RoutingStateV1, entryId: string): RoutingCircuitV1 | undefined {
  return state.circuits.find((value) => value.entry_id === entryId);
}

describe("recordRoutingOutcome", () => {
  it("returns a closed hash-bound witness for the exact outcome event", () => {
    const fixture = plannedRoutingFixture();
    const result = recordRoutingOutcome({
      state: fixture.state,
      plan: fixture.plan,
      policy: fixture.policy,
      attempt_id: primary(fixture).attempt_id,
      outcome: "RUNTIME_PROVIDER_TIMEOUT",
      occurred_at: OCCURRED_AT,
    }) as unknown as {
      readonly state: RoutingStateV1;
      readonly transition: Readonly<Record<string, unknown>> &
        Readonly<{ transition_hash: `sha256:${string}` }>;
    };

    const { transition_hash: transitionHash, ...projection } = result.transition;
    expect(Object.keys(result)).toEqual(["state", "transition"]);
    expect(Object.keys(result.transition).sort()).toEqual(
      [
        "attempt_id",
        "decision_id",
        "next_state_hash",
        "occurred_at",
        "outcome",
        "policy_hash",
        "previous_state_hash",
        "transition_hash",
      ].sort(),
    );
    expect(result.transition).toMatchObject({
      previous_state_hash: fixture.state.document_hash,
      next_state_hash: result.state.document_hash,
      decision_id: fixture.plan.decision_id,
      attempt_id: primary(fixture).attempt_id,
      outcome: "RUNTIME_PROVIDER_TIMEOUT",
      occurred_at: OCCURRED_AT,
      policy_hash: fixture.policy.document_hash,
    });
    expect(transitionHash).toBe(sha256(projection));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.transition)).toBe(true);
  });

  it("opens a threshold-one circuit at the exact canonical cooldown timestamp", () => {
    const fixture = plannedRoutingFixture({
      consecutive_failure_threshold: 1,
      cooldown_ms: 90_000,
    });
    const original = structuredClone(fixture.state);

    const next = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");

    expect(circuit(next, primary(fixture).entry_id)).toEqual({
      entry_id: "worker-primary",
      status: "open",
      consecutive_failures: 1,
      retry_at: "2026-08-21T12:02:00.000Z",
      probe_decision_id: null,
    });
    expect(next.revision).toBe(fixture.state.revision + 1);
    expect(next.previous_state_hash).toBe(fixture.state.document_hash);
    expect(next.document_hash).toBe(hashRoutingState(next));
    expect(Object.isFrozen(next)).toBe(true);
    expect(fixture.state).toEqual(original);
  });

  it("accumulates failures across settled decisions before opening", () => {
    const first = plannedRoutingFixture({
      consecutive_failure_threshold: 2,
      cooldown_ms: 60_000,
    });
    const firstOutcome = record(first, "RUNTIME_PROVIDER_TIMEOUT");
    expect(circuit(firstOutcome, "worker-primary")).toMatchObject({
      status: "closed",
      consecutive_failures: 1,
      retry_at: null,
    });
    const settled = settleRoutingDecision({
      state: firstOutcome,
      reserved_state: first.state,
      circuit_state_chain: [firstOutcome],
      plan: first.plan,
      attempts: [
        attemptResult(primary(first), {
          route_identity: null,
          usage: null,
          effect_may_have_occurred: false,
        }),
      ],
      settled_at: "2026-08-21T12:00:31.000Z",
    });
    expect(settled.status).toBe("SETTLED");

    const secondDecision = planModelSelection({
      ...first.input,
      state: settled.state,
      decision_at: "2026-08-21T12:01:00.000Z",
    });
    expect(secondDecision.status).toBe("planned");
    if (secondDecision.status !== "planned") return;
    const second: PlannedRoutingFixture = {
      ...first,
      input: { ...first.input, state: settled.state, decision_at: "2026-08-21T12:01:00.000Z" },
      prior_state: settled.state,
      plan: secondDecision.plan,
      state: secondDecision.next_state,
    };
    const opened = recordRoutingOutcome({
      state: second.state,
      plan: second.plan,
      policy: second.policy,
      attempt_id: primary(second).attempt_id,
      outcome: "RUNTIME_PROVIDER_TRANSIENT",
      occurred_at: "2026-08-21T12:01:30.000Z",
    }).state;
    expect(circuit(opened, "worker-primary")).toEqual({
      entry_id: "worker-primary",
      status: "open",
      consecutive_failures: 2,
      retry_at: "2026-08-21T12:02:30.000Z",
      probe_decision_id: null,
    });
  });

  it("claims an open circuit as one probe exactly at the cooldown boundary and closes on success", () => {
    const fixture = plannedRoutingFixture({
      circuits: [
        {
          entry_id: "worker-primary",
          status: "open",
          consecutive_failures: 3,
          retry_at: "2026-08-21T12:00:00.000Z",
          probe_decision_id: null,
        },
      ],
      decision_at: "2026-08-21T12:00:00.000Z",
    });
    expect(circuit(fixture.state, "worker-primary")).toEqual({
      entry_id: "worker-primary",
      status: "probe-reserved",
      consecutive_failures: 3,
      retry_at: "2026-08-21T12:00:00.000Z",
      probe_decision_id: fixture.plan.decision_id,
    });

    const next = record(fixture, "RUNTIME_PROVIDER_SUCCESS");

    expect(circuit(next, "worker-primary")).toEqual({
      entry_id: "worker-primary",
      status: "closed",
      consecutive_failures: 0,
      retry_at: null,
      probe_decision_id: null,
    });
  });

  it.each(ALLOWED_OUTCOMES)("reopens a failed half-open probe for %s", (outcome) => {
    const fixture = plannedRoutingFixture({
      cooldown_ms: 45_000,
      circuits: [
        {
          entry_id: "worker-primary",
          status: "open",
          consecutive_failures: 2,
          retry_at: "2026-08-21T12:00:00.000Z",
          probe_decision_id: null,
        },
      ],
    });

    const next = record(fixture, outcome);

    expect(circuit(next, "worker-primary")).toEqual({
      entry_id: "worker-primary",
      status: "open",
      consecutive_failures: 3,
      retry_at: "2026-08-21T12:01:15.000Z",
      probe_decision_id: null,
    });
  });

  it.each(TERMINAL_NON_FALLBACK_OUTCOMES)(
    "releases a probe without changing counters for terminal %s",
    (outcome) => {
      const fixture = plannedRoutingFixture({
        circuits: [
          {
            entry_id: "worker-primary",
            status: "open",
            consecutive_failures: 2,
            retry_at: "2026-08-21T12:00:00.000Z",
            probe_decision_id: null,
          },
        ],
      });

      const next = record(fixture, outcome);

      expect(next).not.toBe(fixture.state);
      expect(next.revision).toBe(fixture.state.revision + 1);
      expect(next.previous_state_hash).toBe(fixture.state.document_hash);
      expect(circuit(next, "worker-primary")).toEqual({
        entry_id: "worker-primary",
        status: "open",
        consecutive_failures: 2,
        retry_at: "2026-08-21T12:00:00.000Z",
        probe_decision_id: null,
      });
    },
  );

  it("rejects a concurrent probe head reserved by a different decision", () => {
    const openCircuit = {
      entry_id: "worker-primary",
      status: "open",
      consecutive_failures: 2,
      retry_at: "2026-08-21T12:00:00.000Z",
      probe_decision_id: null,
    } as const;
    const first = plannedRoutingFixture({ circuits: [openCircuit] });
    const concurrent = plannedRoutingFixture({
      circuits: [openCircuit],
      decision_at: "2026-08-21T12:00:01.000Z",
    });

    expect(() =>
      recordRoutingOutcome({
        state: concurrent.state,
        plan: first.plan,
        policy: first.policy,
        attempt_id: primary(first).attempt_id,
        outcome: "RUNTIME_PROVIDER_SUCCESS",
        occurred_at: OCCURRED_AT,
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ROUTING_STALE_STATE" }));
  });

  it("resets an observed closed circuit on success and preserves an already reset state by identity", () => {
    const observed = plannedRoutingFixture({
      circuits: [
        {
          entry_id: "worker-primary",
          status: "closed",
          consecutive_failures: 2,
          retry_at: null,
          probe_decision_id: null,
        },
      ],
    });
    const reset = record(observed, "RUNTIME_PROVIDER_SUCCESS");
    expect(circuit(reset, "worker-primary")).toMatchObject({
      status: "closed",
      consecutive_failures: 0,
    });

    const alreadyReset = plannedRoutingFixture({
      circuits: [
        {
          entry_id: "worker-primary",
          status: "closed",
          consecutive_failures: 0,
          retry_at: null,
          probe_decision_id: null,
        },
      ],
    });
    expect(record(alreadyReset, "RUNTIME_PROVIDER_SUCCESS")).toBe(alreadyReset.state);
  });

  it.each(ALL_PROVIDER_OUTCOMES)(
    "applies the closed circuit/fallback allowlist to %s",
    (outcome) => {
      const fixture = plannedRoutingFixture();
      const allowed = ALLOWED_OUTCOMES.includes(outcome as (typeof ALLOWED_OUTCOMES)[number]);

      const next = record(fixture, outcome);

      if (allowed) {
        expect(next).not.toBe(fixture.state);
        expect(circuit(next, "worker-primary")).toMatchObject({
          status: "closed",
          consecutive_failures: 1,
        });
        const result = fallback(fixture, { state: next, outcome });
        expect(result).toEqual({ status: "ready", attempt: fixture.plan.worker_attempts[1] });
      } else {
        expect(next).toBe(fixture.state);
        const result = fallback(fixture, { state: next, outcome });
        expect(result).toEqual({
          status: "blocked",
          code: "RUNTIME_ROUTING_POLICY_DENIED",
          retryable: false,
        });
      }
    },
  );

  it("keeps circuit records in fixed ASCII order", () => {
    const fixture = plannedRoutingFixture({
      circuits: [
        {
          entry_id: "worker-fallback-b",
          status: "closed",
          consecutive_failures: 1,
          retry_at: null,
          probe_decision_id: null,
        },
      ],
    });
    const next = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");
    expect(next.circuits.map((value) => value.entry_id)).toEqual([
      "worker-fallback-b",
      "worker-primary",
    ]);
  });

  it.each(["2026-08-21T12:00:30Z", "not-a-time", "2026-08-21T11:59:59.999Z"])(
    "rejects noncanonical or pre-decision outcome time %s",
    (occurredAt) => {
      const fixture = plannedRoutingFixture();
      expect(() =>
        recordRoutingOutcome({
          state: fixture.state,
          plan: fixture.plan,
          policy: fixture.policy,
          attempt_id: primary(fixture).attempt_id,
          outcome: "RUNTIME_PROVIDER_TIMEOUT",
          occurred_at: occurredAt,
        }),
      ).toThrowError(expect.objectContaining({ code: "RUNTIME_ROUTING_INVALID" }));
    },
  );

  it("fails closed on stale state, plan, policy, and attempt bindings", () => {
    const fixture = plannedRoutingFixture();
    const otherPolicy = plannedRoutingFixture({ consecutive_failure_threshold: 4 }).policy;
    const tamperedPlan = {
      ...fixture.plan,
      matched_rule_id: "risk-default",
    } as PlannedModelSelectionPlanV1;

    expect(() => record(fixture, "RUNTIME_PROVIDER_TIMEOUT", fixture.prior_state)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_ROUTING_STALE_STATE" }),
    );
    expect(() =>
      recordRoutingOutcome({
        state: fixture.state,
        plan: tamperedPlan,
        policy: fixture.policy,
        attempt_id: primary(fixture).attempt_id,
        outcome: "RUNTIME_PROVIDER_TIMEOUT",
        occurred_at: OCCURRED_AT,
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ROUTING_INVALID" }));
    expect(() =>
      recordRoutingOutcome({
        state: fixture.state,
        plan: fixture.plan,
        policy: otherPolicy,
        attempt_id: primary(fixture).attempt_id,
        outcome: "RUNTIME_PROVIDER_TIMEOUT",
        occurred_at: OCCURRED_AT,
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ROUTING_STALE_STATE" }));
    expect(() =>
      recordRoutingOutcome({
        state: fixture.state,
        plan: fixture.plan,
        policy: fixture.policy,
        attempt_id: "attempt-not-planned",
        outcome: "RUNTIME_PROVIDER_TIMEOUT",
        occurred_at: OCCURRED_AT,
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ROUTING_INVALID" }));
  });
});

describe("nextModelFallback", () => {
  it("binds a below-threshold fallback to the exact outcome occurrence witness", () => {
    const fixture = plannedRoutingFixture();
    const first = recorded(
      fixture,
      "RUNTIME_PROVIDER_TIMEOUT",
      fixture.state,
      primary(fixture),
      "2026-08-21T12:00:30.000Z",
    );
    const differentTime = recorded(
      fixture,
      "RUNTIME_PROVIDER_TIMEOUT",
      fixture.state,
      primary(fixture),
      "2026-08-21T12:00:31.000Z",
    );
    expect(differentTime.state).toEqual(first.state);
    expect(differentTime.transition.transition_hash).not.toBe(first.transition.transition_hash);

    expect(
      nextModelFallback({
        state: first.state,
        previous_state: fixture.state,
        plan: fixture.plan,
        policy: fixture.policy,
        transition: differentTime.transition,
        current_attempt_id: primary(fixture).attempt_id,
        outcome: "RUNTIME_PROVIDER_TIMEOUT",
        occurred_at: "2026-08-21T12:00:30.000Z",
        attempt_results: [attemptResult(primary(fixture))],
        remaining_duration_ms: 300_000,
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_STALE_STATE",
      retryable: false,
    });
  });

  it("rejects an outcome witness recorded for a different planned attempt", () => {
    const fixture = plannedRoutingFixture();
    const otherAttempt = fixture.plan.worker_attempts[1];
    if (otherAttempt === undefined) throw new Error("missing second fixture attempt");
    const other = recorded(fixture, "RUNTIME_PROVIDER_TIMEOUT", fixture.state, otherAttempt);

    expect(
      nextModelFallback({
        state: other.state,
        previous_state: fixture.state,
        plan: fixture.plan,
        policy: fixture.policy,
        transition: other.transition,
        current_attempt_id: primary(fixture).attempt_id,
        outcome: "RUNTIME_PROVIDER_TIMEOUT",
        occurred_at: OCCURRED_AT,
        attempt_results: [attemptResult(primary(fixture))],
        remaining_duration_ms: 300_000,
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_STALE_STATE",
      retryable: false,
    });
  });

  it("rejects an unplanned attempt before it can consume an outcome witness", () => {
    const fixture = plannedRoutingFixture();
    const outcome = recorded(fixture, "RUNTIME_PROVIDER_TIMEOUT");

    expect(() =>
      nextModelFallback({
        state: outcome.state,
        previous_state: fixture.state,
        plan: fixture.plan,
        policy: fixture.policy,
        transition: outcome.transition,
        current_attempt_id: "attempt-not-planned",
        outcome: "RUNTIME_PROVIDER_TIMEOUT",
        occurred_at: OCCURRED_AT,
        attempt_results: [attemptResult(primary(fixture))],
        remaining_duration_ms: 300_000,
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ROUTING_INVALID" }));
  });

  it("rejects a witness bound to the wrong below-threshold outcome", () => {
    const fixture = plannedRoutingFixture();
    const timeout = recorded(fixture, "RUNTIME_PROVIDER_TIMEOUT");
    const transient = recorded(fixture, "RUNTIME_PROVIDER_TRANSIENT");
    expect(transient.state).toEqual(timeout.state);

    expect(
      fallback(fixture, {
        state: timeout.state,
        transition: transient.transition,
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_STALE_STATE",
      retryable: false,
    });
  });

  it("rejects a witness bound to a different previous state", () => {
    const fixture = plannedRoutingFixture();
    const outcome = recorded(fixture, "RUNTIME_PROVIDER_TIMEOUT");

    expect(
      fallback(fixture, {
        state: outcome.state,
        previous_state: outcome.state,
        transition: outcome.transition,
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_STALE_STATE",
      retryable: false,
    });
  });

  it("rejects a witness under a different exact policy", () => {
    const fixture = plannedRoutingFixture();
    const other = plannedRoutingFixture({ consecutive_failure_threshold: 4 });
    const outcome = recorded(fixture, "RUNTIME_PROVIDER_TIMEOUT");

    expect(
      fallback(fixture, {
        state: outcome.state,
        policy: other.policy,
        transition: outcome.transition,
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_STALE_STATE",
      retryable: false,
    });
  });

  it.each([
    [
      "tampered hash",
      (transition: RoutingOutcomeTransition) => ({
        ...transition,
        transition_hash: `sha256:${"f".repeat(64)}`,
      }),
    ],
    [
      "unknown field",
      (transition: RoutingOutcomeTransition) => ({
        ...transition,
        unexpected: true,
      }),
    ],
  ] as const)("rejects a %s on the closed transition type", (_name, mutate) => {
    const fixture = plannedRoutingFixture();
    const outcome = recorded(fixture, "RUNTIME_PROVIDER_TIMEOUT");

    expect(
      fallback(fixture, {
        state: outcome.state,
        transition: mutate(outcome.transition) as RoutingOutcomeTransition,
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_STALE_STATE",
      retryable: false,
    });
  });

  it("returns only the next already planned worker attempt", () => {
    const fixture = plannedRoutingFixture();
    const nextState = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");

    const result = fallback(fixture, { state: nextState });

    expect(result).toEqual({ status: "ready", attempt: fixture.plan.worker_attempts[1] });
    if (result.status === "ready") {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.attempt)).toBe(true);
    }
  });

  it("consumes a unique ordered result prefix ending at the current attempt", () => {
    const fixture = plannedRoutingFixture();
    const first = primary(fixture);
    const second = fixture.plan.worker_attempts[1];
    if (second === undefined) throw new Error("missing second fixture attempt");
    const afterFirst = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");
    const afterSecond = record(fixture, "RUNTIME_PROVIDER_TRANSIENT", afterFirst, second);

    const result = fallback(fixture, {
      state: afterSecond,
      previous_state: afterFirst,
      attempt: second,
      outcome: "RUNTIME_PROVIDER_TRANSIENT",
      results: [attemptResult(first), attemptResult(second)],
    });

    expect(result).toEqual({ status: "ready", attempt: fixture.plan.worker_attempts[2] });
  });

  it.each([
    ["missing prefix", () => []],
    [
      "duplicate result id",
      (fixture: PlannedRoutingFixture) => [
        attemptResult(primary(fixture)),
        attemptResult(primary(fixture)),
      ],
    ],
    [
      "unattempted fallback",
      (fixture: PlannedRoutingFixture) => [
        attemptResult(primary(fixture)),
        attemptResult(fixture.plan.worker_attempts[1]!),
      ],
    ],
  ] as const)("blocks a %s result sequence", (_name, results) => {
    const fixture = plannedRoutingFixture();
    const nextState = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");
    expect(fallback(fixture, { state: nextState, results: results(fixture) })).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_STALE_STATE",
      retryable: false,
    });
  });

  it("rejects a reviewer result from the worker fallback prefix", () => {
    const fixture = plannedRoutingFixture({ review: true });
    const reviewer = fixture.plan.reviewer_attempt;
    if (reviewer === null) throw new Error("missing reviewer fixture attempt");
    const nextState = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");

    expect(
      fallback(fixture, {
        state: nextState,
        results: [attemptResult(reviewer)],
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_STALE_STATE",
      retryable: false,
    });
  });

  it("blocks possible provider effect without complete trusted route and usage", () => {
    const fixture = plannedRoutingFixture();
    const nextState = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");

    expect(
      fallback(fixture, {
        state: nextState,
        results: [
          attemptResult(primary(fixture), {
            route_identity: null,
            usage: null,
            effect_may_have_occurred: true,
          }),
        ],
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_USAGE_UNKNOWN",
      retryable: false,
    });
  });

  it("reports unknown possible effect before denying a non-fallback outcome", () => {
    const fixture = plannedRoutingFixture();
    const nextState = record(fixture, "RUNTIME_PROVIDER_AUTHENTICATION");

    expect(
      fallback(fixture, {
        state: nextState,
        outcome: "RUNTIME_PROVIDER_AUTHENTICATION",
        results: [
          attemptResult(primary(fixture), {
            route_identity: null,
            usage: null,
            effect_may_have_occurred: true,
          }),
        ],
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_USAGE_UNKNOWN",
      retryable: false,
    });
  });

  it("denies a non-fallback outcome after proving no provider effect", () => {
    const fixture = plannedRoutingFixture();
    const nextState = record(fixture, "RUNTIME_PROVIDER_AUTHENTICATION");

    expect(
      fallback(fixture, {
        state: nextState,
        outcome: "RUNTIME_PROVIDER_AUTHENTICATION",
        results: [
          attemptResult(primary(fixture), {
            route_identity: null,
            usage: null,
            effect_may_have_occurred: false,
          }),
        ],
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_POLICY_DENIED",
      retryable: false,
    });
  });

  it("allows a proven pre-effect failure without route or usage while retaining duration and turn", () => {
    const fixture = plannedRoutingFixture();
    const nextState = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");
    const result = fallback(fixture, {
      state: nextState,
      results: [
        attemptResult(primary(fixture), {
          route_identity: null,
          usage: null,
          effect_may_have_occurred: false,
        }),
      ],
    });
    expect(result.status).toBe("ready");
  });

  it("blocks an attestation outside the current attempt accepted route", () => {
    const fixture = plannedRoutingFixture();
    const nextState = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");
    const attempt = primary(fixture);

    expect(
      fallback(fixture, {
        state: nextState,
        results: [
          attemptResult(attempt, {
            route_identity: routeIdentity(attempt, { route_id: "route-unaccepted" }),
          }),
        ],
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_RESOLUTION_MISMATCH",
      retryable: false,
    });
  });

  it.each([
    [
      "input",
      {
        input_tokens: 160_001,
        output_tokens: 0,
        cached_input_tokens: 0,
        reasoning_tokens: 0,
      },
      1_000,
    ],
    [
      "output",
      {
        input_tokens: 0,
        output_tokens: 42_001,
        cached_input_tokens: 0,
        reasoning_tokens: 0,
      },
      1_000,
    ],
    [
      "cost",
      {
        input_tokens: 0,
        output_tokens: 500_001,
        cached_input_tokens: 0,
        reasoning_tokens: 0,
      },
      1_000,
    ],
    [
      "duration",
      {
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        reasoning_tokens: 0,
      },
      660_001,
    ],
  ] as const)(
    "blocks cumulative actual plus remaining reserved %s overage",
    (_name, usage, duration) => {
      const fixture = plannedRoutingFixture();
      const nextState = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");
      expect(
        fallback(fixture, {
          state: nextState,
          results: [attemptResult(primary(fixture), { usage, duration_ms: duration })],
        }),
      ).toEqual({
        status: "blocked",
        code: "RUNTIME_ROUTING_BUDGET_EXCEEDED",
        retryable: false,
      });
    },
  );

  it("retains every unattempted worker and reviewer allocation in the five-dimensional budget proof", () => {
    const fixture = plannedRoutingFixture({ review: true });
    const nextState = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");
    const result = fallback(fixture, {
      state: nextState,
      results: [attemptResult(primary(fixture))],
    });
    expect(result.status).toBe("ready");
  });

  it.each([0, -1, 119_999])(
    "blocks fallback when remaining duration %i cannot contain the preplanned attempt",
    (remainingDurationMs) => {
      const fixture = plannedRoutingFixture();
      const nextState = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");
      expect(
        fallback(fixture, {
          state: nextState,
          remaining_duration_ms: remainingDurationMs,
        }),
      ).toEqual({
        status: "blocked",
        code: "RUNTIME_ROUTING_BUDGET_EXCEEDED",
        retryable: false,
      });
    },
  );

  it("blocks when the next preplanned attempt circuit is newly open", () => {
    const fixture = plannedRoutingFixture({ consecutive_failure_threshold: 1 });
    const nextAttempt = fixture.plan.worker_attempts[1];
    if (nextAttempt === undefined) throw new Error("missing next fixture attempt");
    const priorTransition = recorded(
      fixture,
      "RUNTIME_PROVIDER_TIMEOUT",
      fixture.state,
      nextAttempt,
    );
    const currentTransition = recorded(fixture, "RUNTIME_PROVIDER_TIMEOUT", priorTransition.state);

    expect(
      fallback(fixture, {
        state: currentTransition.state,
        previous_state: priorTransition.state,
        transition: currentTransition.transition,
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_CIRCUIT_OPEN",
      retryable: true,
    });
  });

  it("blocks a dangling probe until recordRoutingOutcome resolves it", () => {
    const fixture = plannedRoutingFixture({
      circuits: [
        {
          entry_id: "worker-primary",
          status: "open",
          consecutive_failures: 2,
          retry_at: "2026-08-21T12:00:00.000Z",
          probe_decision_id: null,
        },
      ],
    });

    expect(fallback(fixture, { state: fixture.state })).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_STALE_STATE",
      retryable: false,
    });
  });

  it("blocks when no later worker attempt remains", () => {
    const fixture = plannedRoutingFixture();
    const attempts = fixture.plan.worker_attempts;
    let state = fixture.state;
    let previousState = state;
    for (const attempt of attempts) {
      previousState = state;
      state = record(fixture, "RUNTIME_PROVIDER_TIMEOUT", state, attempt);
    }
    const results = attempts.map((attempt) => attemptResult(attempt));
    expect(
      fallback(fixture, {
        state,
        previous_state: previousState,
        attempt: attempts.at(-1)!,
        results,
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_NO_CAPABLE_ROUTE",
      retryable: false,
    });
  });

  it("reports unknown provider effect before reporting fallback exhaustion", () => {
    const fixture = plannedRoutingFixture();
    const attempts = fixture.plan.worker_attempts;
    let state = fixture.state;
    let previousState = state;
    for (const attempt of attempts) {
      previousState = state;
      state = record(fixture, "RUNTIME_PROVIDER_TIMEOUT", state, attempt);
    }
    const results = attempts.map((attempt, index) =>
      attemptResult(
        attempt,
        index === attempts.length - 1
          ? {
              route_identity: null,
              usage: null,
              effect_may_have_occurred: true,
            }
          : {},
      ),
    );
    expect(
      fallback(fixture, {
        state,
        previous_state: previousState,
        attempt: attempts.at(-1)!,
        results,
      }),
    ).toEqual({
      status: "blocked",
      code: "RUNTIME_ROUTING_USAGE_UNKNOWN",
      retryable: false,
    });
  });

  it("fails closed on a state without the exact live decision reservation", () => {
    const fixture = plannedRoutingFixture();
    const outcome = recorded(fixture, "RUNTIME_PROVIDER_TIMEOUT");
    expect(() =>
      nextModelFallback({
        state: fixture.prior_state,
        previous_state: fixture.state,
        plan: fixture.plan,
        policy: fixture.policy,
        transition: outcome.transition,
        current_attempt_id: primary(fixture).attempt_id,
        outcome: "RUNTIME_PROVIDER_TIMEOUT",
        occurred_at: OCCURRED_AT,
        attempt_results: [attemptResult(primary(fixture))],
        remaining_duration_ms: 300_000,
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ROUTING_STALE_STATE" }));
  });
});

describe("multi-transition settlement", () => {
  it("settles after two exact allowlisted worker circuit transitions", () => {
    const fixture = plannedRoutingFixture();
    const first = primary(fixture);
    const second = fixture.plan.worker_attempts[1];
    if (second === undefined) throw new Error("missing second fixture attempt");
    const afterFirst = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");
    const afterSecond = record(fixture, "RUNTIME_PROVIDER_TRANSIENT", afterFirst, second);

    const settled = settleRoutingDecision({
      state: afterSecond,
      reserved_state: fixture.state,
      circuit_state_chain: [afterFirst, afterSecond],
      plan: fixture.plan,
      attempts: [attemptResult(first), attemptResult(second)],
      settled_at: "2026-08-21T12:01:00.000Z",
    });

    expect(settled.status).toBe("SETTLED");
    expect(settled.state.previous_state_hash).toBe(afterSecond.document_hash);
    expect(settled.state.circuits).toEqual(afterSecond.circuits);
  });

  it.each(["missing immediate state", "reordered states", "extra state"] as const)(
    "rejects a %s in the exact circuit transition chain",
    (chainKind) => {
      const fixture = plannedRoutingFixture();
      const [first, second, third] = fixture.plan.worker_attempts;
      if (first === undefined || second === undefined || third === undefined) {
        throw new Error("missing fixture attempts");
      }
      const afterFirst = record(fixture, "RUNTIME_PROVIDER_TIMEOUT", fixture.state, first);
      const afterSecond = record(fixture, "RUNTIME_PROVIDER_TRANSIENT", afterFirst, second);
      const afterExtra = record(
        fixture,
        "RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE",
        afterSecond,
        third,
      );
      const chain =
        chainKind === "missing immediate state"
          ? [afterSecond]
          : chainKind === "reordered states"
            ? [afterSecond, afterFirst]
            : [afterFirst, afterSecond, afterExtra];

      expect(() =>
        settleRoutingDecision({
          state: afterSecond,
          reserved_state: fixture.state,
          circuit_state_chain: chain,
          plan: fixture.plan,
          attempts: [attemptResult(first), attemptResult(second)],
          settled_at: "2026-08-21T12:01:00.000Z",
        }),
      ).toThrowError(expect.objectContaining({ code: "RUNTIME_ROUTING_STALE_STATE" }));
    },
  );

  it("rejects a circuit chain longer than the number of planned attempts", () => {
    const fixture = plannedRoutingFixture();
    const [first, second, third] = fixture.plan.worker_attempts;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("missing fixture attempts");
    }
    const afterFirst = record(fixture, "RUNTIME_PROVIDER_TIMEOUT", fixture.state, first);
    const afterSecond = record(fixture, "RUNTIME_PROVIDER_TRANSIENT", afterFirst, second);
    const afterThird = record(fixture, "RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE", afterSecond, third);
    const afterFourth = record(fixture, "RUNTIME_PROVIDER_TIMEOUT", afterThird, third);

    expect(() =>
      settleRoutingDecision({
        state: afterFourth,
        reserved_state: fixture.state,
        circuit_state_chain: [afterFirst, afterSecond, afterThird, afterFourth],
        plan: fixture.plan,
        attempts: [attemptResult(first), attemptResult(second), attemptResult(third)],
        settled_at: "2026-08-21T12:01:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ROUTING_STALE_STATE" }));
  });

  it("settles after later worker and independent reviewer circuits reset", () => {
    const fixture = plannedRoutingFixture({
      review: true,
      circuits: [
        {
          entry_id: "worker-fallback-a",
          status: "closed",
          consecutive_failures: 2,
          retry_at: null,
          probe_decision_id: null,
        },
        {
          entry_id: "reviewer-independent",
          status: "closed",
          consecutive_failures: 1,
          retry_at: null,
          probe_decision_id: null,
        },
      ],
    });
    const worker = fixture.plan.worker_attempts[1];
    const reviewer = fixture.plan.reviewer_attempt;
    if (worker === undefined || reviewer === null)
      throw new Error("missing review fixture attempts");
    const afterWorker = recorded(
      fixture,
      "RUNTIME_PROVIDER_SUCCESS",
      fixture.state,
      worker,
      "2026-08-21T12:00:30.000Z",
    ).state;
    const afterReviewer = recorded(
      fixture,
      "RUNTIME_PROVIDER_SUCCESS",
      afterWorker,
      reviewer,
      "2026-08-21T12:00:31.000Z",
    ).state;

    const settled = settleRoutingDecision({
      state: afterReviewer,
      reserved_state: fixture.state,
      circuit_state_chain: [afterWorker, afterReviewer],
      plan: fixture.plan,
      attempts: [attemptResult(worker), attemptResult(reviewer)],
      settled_at: "2026-08-21T12:01:00.000Z",
    });

    expect(settled.status).toBe("SETTLED");
    expect(circuit(settled.state, worker.entry_id)).toMatchObject({
      status: "closed",
      consecutive_failures: 0,
    });
    expect(circuit(settled.state, reviewer.entry_id)).toMatchObject({
      status: "closed",
      consecutive_failures: 0,
    });
  });

  it("settles after a terminal probe outcome restores the prior open circuit", () => {
    const fixture = plannedRoutingFixture({
      circuits: [
        {
          entry_id: "worker-primary",
          status: "open",
          consecutive_failures: 2,
          retry_at: "2026-08-21T12:00:00.000Z",
          probe_decision_id: null,
        },
      ],
    });
    const released = record(fixture, "RUNTIME_PROVIDER_AUTHENTICATION");

    const settled = settleRoutingDecision({
      state: released,
      reserved_state: fixture.state,
      circuit_state_chain: [released],
      plan: fixture.plan,
      attempts: [
        attemptResult(primary(fixture), {
          route_identity: null,
          usage: null,
          effect_may_have_occurred: false,
        }),
      ],
      settled_at: "2026-08-21T12:01:00.000Z",
    });

    expect(settled.status).toBe("SETTLED");
    expect(circuit(settled.state, "worker-primary")).toEqual({
      entry_id: "worker-primary",
      status: "open",
      consecutive_failures: 2,
      retry_at: "2026-08-21T12:00:00.000Z",
      probe_decision_id: null,
    });
  });
});

describe("safe error shape", () => {
  it("does not reflect native input in routing errors", () => {
    const secret = "provider-secret-native-value";
    const fixture = plannedRoutingFixture();
    let error: unknown;
    try {
      recordRoutingOutcome({
        state: fixture.state,
        plan: fixture.plan,
        policy: fixture.policy,
        attempt_id: secret,
        outcome: "RUNTIME_PROVIDER_TIMEOUT",
        occurred_at: OCCURRED_AT,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RuntimeRoutingError);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
  });
});
