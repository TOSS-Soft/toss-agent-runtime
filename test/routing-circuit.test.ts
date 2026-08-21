import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/protocol/json.js";
import type { ProviderRouteIdentity, ProviderUsage } from "../src/providers/types.js";
import type { RuntimeProviderErrorCode } from "../src/providers/errors.js";
import { nextModelFallback, recordRoutingOutcome } from "../src/routing/circuit.js";
import { hashRoutingState, parseRoutingState } from "../src/routing/contracts.js";
import { settleRoutingDecision } from "../src/routing/cost.js";
import { RuntimeRoutingError } from "../src/routing/errors.js";
import { planModelSelection } from "../src/routing/selection.js";
import type {
  PlannedModelSelectionPlanV1,
  RoutingAttemptResult,
  RoutingAttemptV1,
  RoutingCircuitV1,
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
  return recordRoutingOutcome({
    state,
    plan: fixture.plan,
    policy: fixture.policy,
    attempt_id: attempt.attempt_id,
    outcome,
    occurred_at: OCCURRED_AT,
  });
}

function fallback(
  fixture: PlannedRoutingFixture,
  input: Readonly<{
    state: RoutingStateV1;
    attempt?: RoutingAttemptV1;
    outcome?: RuntimeProviderErrorCode;
    results?: readonly RoutingAttemptResult[];
    remaining_duration_ms?: number;
  }>,
) {
  const attempt = input.attempt ?? primary(fixture);
  return nextModelFallback({
    state: input.state,
    plan: fixture.plan,
    current_attempt_id: attempt.attempt_id,
    outcome: input.outcome ?? "RUNTIME_PROVIDER_TIMEOUT",
    attempt_results: input.results ?? [attemptResult(attempt)],
    remaining_duration_ms: input.remaining_duration_ms ?? 300_000,
  });
}

function rehashState(state: RoutingStateV1, overrides: Partial<RoutingStateV1>): RoutingStateV1 {
  const candidate = {
    ...state,
    ...overrides,
    document_hash: `sha256:${"0".repeat(64)}`,
  } as RoutingStateV1;
  const withHash = {
    ...candidate,
    document_hash: hashRoutingState(candidate),
  } as RoutingStateV1;
  const parsed = parseRoutingState(canonicalJson(withHash));
  if (!parsed.ok) throw new Error(`invalid changed state: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}

function circuit(state: RoutingStateV1, entryId: string): RoutingCircuitV1 | undefined {
  return state.circuits.find((value) => value.entry_id === entryId);
}

describe("recordRoutingOutcome", () => {
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
    });
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
    const fixture = plannedRoutingFixture();
    const outcomeState = record(fixture, "RUNTIME_PROVIDER_TIMEOUT");
    const nextAttempt = fixture.plan.worker_attempts[1];
    if (nextAttempt === undefined) throw new Error("missing next fixture attempt");
    const changed = rehashState(outcomeState, {
      circuits: [
        ...outcomeState.circuits,
        {
          entry_id: nextAttempt.entry_id,
          status: "open",
          consecutive_failures: 1,
          retry_at: "2026-08-21T12:02:00.000Z",
          probe_decision_id: null,
        } as const,
      ].sort((left, right) =>
        left.entry_id < right.entry_id ? -1 : left.entry_id > right.entry_id ? 1 : 0,
      ),
    });

    expect(fallback(fixture, { state: changed })).toEqual({
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
    for (const attempt of attempts) {
      state = record(fixture, "RUNTIME_PROVIDER_TIMEOUT", state, attempt);
    }
    const results = attempts.map((attempt) => attemptResult(attempt));
    expect(
      fallback(fixture, {
        state,
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
    for (const attempt of attempts) {
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
    expect(() =>
      nextModelFallback({
        state: fixture.prior_state,
        plan: fixture.plan,
        current_attempt_id: primary(fixture).attempt_id,
        outcome: "RUNTIME_PROVIDER_TIMEOUT",
        attempt_results: [attemptResult(primary(fixture))],
        remaining_duration_ms: 300_000,
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ROUTING_STALE_STATE" }));
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
