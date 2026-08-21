import { describe, expect, it } from "vitest";

import type { ProviderRouteIdentity, ProviderUsage } from "../src/providers/types.js";
import {
  calculateRoutingCost,
  estimateRoutingAllocation,
  reserveRoutingBudget,
  settleRoutingDecision,
  type RoutingAttemptResult,
} from "../src/routing/cost.js";
import { hashRoutingState, parseRoutingState } from "../src/routing/contracts.js";
import { RuntimeRoutingError, type RuntimeRoutingErrorCode } from "../src/routing/errors.js";
import type {
  CatalogPricingV1,
  PlannedModelSelectionPlanV1,
  RoutingCircuitV1,
  RoutingReservationV1,
  RoutingStateV1,
} from "../src/routing/types.js";
import {
  routingStateBytes,
  selectionDecisionHash,
  selectionPlanDocumentHash,
  validPlannedSelectionPlan,
  validRoutingReservation,
  validRoutingState,
} from "./helpers/routing-fixtures.js";

const BASE_PRICING: CatalogPricingV1 = {
  input_microusd_per_million: 1_000_000,
  cached_input_microusd_per_million: 500_000,
  output_microusd_per_million: 2_000_000,
  reasoning_output_microusd_per_million: 3_000_000,
};

function usage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cached_input_tokens: 4,
    reasoning_tokens: 2,
    ...overrides,
  };
}

function stateFixture(overrides: Record<string, unknown> = {}): RoutingStateV1 {
  const value = { ...validRoutingState(), ...overrides };
  const parsed = parseRoutingState(routingStateBytes(value));
  if (!parsed.ok) throw new Error("invalid routing state test fixture");
  return parsed.value;
}

function reservationFixture(overrides: Partial<RoutingReservationV1> = {}): RoutingReservationV1 {
  return { ...validRoutingReservation(), ...overrides } as RoutingReservationV1;
}

function expectRoutingError(operation: () => unknown, code: RuntimeRoutingErrorCode): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeRoutingError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}

function routeIdentity(plan: PlannedModelSelectionPlanV1): ProviderRouteIdentity {
  const attempt = plan.worker_attempts[0];
  const route = attempt?.accepted_routes[1] ?? attempt?.accepted_routes[0];
  if (attempt === undefined || route === undefined) throw new Error("missing route fixture");
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
    gateway_request_id: "gateway-request-1",
  };
}

function reservedPlanFixture(
  input: {
    readonly state?: RoutingStateV1;
    readonly reservation?: RoutingReservationV1;
  } = {},
): Readonly<{ state: RoutingStateV1; plan: PlannedModelSelectionPlanV1 }> {
  const prior = input.state ?? stateFixture();
  const planValue = validPlannedSelectionPlan();
  planValue.prior_state_id = prior.state_id;
  planValue.prior_state_revision = prior.revision;
  planValue.prior_state_hash = prior.document_hash;
  planValue.run_id = prior.run_id;
  planValue.request_hash = prior.request_hash;
  planValue.catalog_hash = prior.catalog_hash;
  planValue.policy_hash = prior.policy_hash;
  planValue.reservation = input.reservation ?? planValue.reservation;
  (planValue.reservation as Record<string, unknown>).decision_hash =
    selectionDecisionHash(planValue);

  const reservation = planValue.reservation as RoutingReservationV1;
  const state = reserveRoutingBudget({ state: prior, reservation });
  planValue.next_state_revision = state.revision;
  planValue.next_state_hash = state.document_hash;
  planValue.document_hash = selectionPlanDocumentHash(planValue);
  return { state, plan: planValue as unknown as PlannedModelSelectionPlanV1 };
}

function rehashState(value: RoutingStateV1): RoutingStateV1 {
  const candidate = { ...value, document_hash: `sha256:${"0".repeat(64)}` } as RoutingStateV1;
  return { ...candidate, document_hash: hashRoutingState(candidate) };
}

function rehashPlan(value: PlannedModelSelectionPlanV1): PlannedModelSelectionPlanV1 {
  const candidate = {
    ...value,
    document_hash: `sha256:${"0".repeat(64)}`,
  } as PlannedModelSelectionPlanV1;
  return {
    ...candidate,
    document_hash: selectionPlanDocumentHash(candidate as unknown as Record<string, unknown>),
  };
}

function immediateCircuitDescendant(
  reservedState: RoutingStateV1,
  circuits: readonly RoutingCircuitV1[],
  overrides: Partial<RoutingStateV1> = {},
): RoutingStateV1 {
  return rehashState({
    ...reservedState,
    revision: reservedState.revision + 1,
    previous_state_hash: reservedState.document_hash,
    circuits,
    ...overrides,
  });
}

function probeReservedPlanFixture(): Readonly<{
  state: RoutingStateV1;
  plan: PlannedModelSelectionPlanV1;
}> {
  const fixture = reservedPlanFixture();
  const state = rehashState({
    ...fixture.state,
    circuits: [
      {
        entry_id: "balanced-primary",
        status: "probe-reserved",
        consecutive_failures: 1,
        retry_at: "2026-08-21T12:00:00.000Z",
        probe_decision_id: fixture.plan.decision_id,
      },
    ],
  });
  return {
    state,
    plan: rehashPlan({ ...fixture.plan, next_state_hash: state.document_hash }),
  };
}

function successfulAttempt(plan: PlannedModelSelectionPlanV1): RoutingAttemptResult {
  const attempt = plan.worker_attempts[0];
  if (attempt === undefined) throw new Error("missing attempt fixture");
  return {
    attempt_id: attempt.attempt_id,
    route_identity: routeIdentity(plan),
    usage: usage(),
    duration_ms: 1,
    effect_may_have_occurred: true,
  };
}

describe("exact routing cost", () => {
  it("rounds each nonzero priced component upward independently", () => {
    expect(
      calculateRoutingCost(
        {
          input_microusd_per_million: 1,
          cached_input_microusd_per_million: 1,
          output_microusd_per_million: 1,
          reasoning_output_microusd_per_million: 1,
        },
        {
          input_tokens: 2,
          output_tokens: 2,
          cached_input_tokens: 1,
          reasoning_tokens: 1,
        },
      ),
    ).toBe(4);
  });

  it("prices cached input and reasoning output as exact subsets", () => {
    expect(calculateRoutingCost(BASE_PRICING, usage())).toBe(20);
  });

  it("charges null subsets at ordinary input and output rates", () => {
    expect(
      calculateRoutingCost(
        BASE_PRICING,
        usage({ cached_input_tokens: null, reasoning_tokens: null }),
      ),
    ).toBe(20);
  });

  it.each([
    ["negative input", usage({ input_tokens: -1 })],
    ["fractional output", usage({ output_tokens: 1.5 })],
    ["cached input above total", usage({ input_tokens: 3, cached_input_tokens: 4 })],
    ["reasoning output above total", usage({ output_tokens: 1, reasoning_tokens: 2 })],
    ["unsafe usage", usage({ input_tokens: Number.MAX_SAFE_INTEGER + 1 })],
  ])("rejects %s", (_name, invalidUsage) => {
    expectRoutingError(
      () => calculateRoutingCost(BASE_PRICING, invalidUsage),
      "RUNTIME_ROUTING_INVALID",
    );
  });

  it("rejects unsafe prices and a cost result above the safe integer range", () => {
    expectRoutingError(
      () =>
        calculateRoutingCost(
          { ...BASE_PRICING, input_microusd_per_million: Number.MAX_SAFE_INTEGER + 1 },
          usage(),
        ),
      "RUNTIME_ROUTING_INVALID",
    );
    expectRoutingError(
      () =>
        calculateRoutingCost(
          {
            ...BASE_PRICING,
            input_microusd_per_million: Number.MAX_SAFE_INTEGER,
          },
          usage({
            input_tokens: Number.MAX_SAFE_INTEGER,
            output_tokens: 0,
            cached_input_tokens: 0,
            reasoning_tokens: 0,
          }),
        ),
      "RUNTIME_ROUTING_INVALID",
    );
  });

  it("estimates worst-case input and the larger ordinary/reasoning output rate", () => {
    expect(
      estimateRoutingAllocation({
        pricing: {
          input_microusd_per_million: 1,
          cached_input_microusd_per_million: 0,
          output_microusd_per_million: 2,
          reasoning_output_microusd_per_million: 3,
        },
        ceilings: { max_input_tokens: 1, max_output_tokens: 1, max_duration_ms: 7 },
      }),
    ).toEqual({
      input_tokens: 1,
      output_tokens: 1,
      cost_microusd: 2,
      duration_ms: 7,
      turns: 1,
    });
  });

  it("bounds four independently rounded components when every unit rate is equal", () => {
    const pricing = {
      input_microusd_per_million: 1,
      cached_input_microusd_per_million: 1,
      output_microusd_per_million: 1,
      reasoning_output_microusd_per_million: 1,
    };
    const allocation = estimateRoutingAllocation({
      pricing,
      ceilings: { max_input_tokens: 2, max_output_tokens: 2, max_duration_ms: 1 },
    });

    expect(allocation.cost_microusd).toBe(4);
    expect(
      calculateRoutingCost(pricing, {
        input_tokens: 2,
        output_tokens: 2,
        cached_input_tokens: 1,
        reasoning_tokens: 1,
      }),
    ).toBeLessThanOrEqual(allocation.cost_microusd);
  });

  it("is an upper bound for every valid cached/reasoning split in a bounded matrix", () => {
    const pricingMatrix: readonly CatalogPricingV1[] = [
      {
        input_microusd_per_million: 1,
        cached_input_microusd_per_million: 1,
        output_microusd_per_million: 1,
        reasoning_output_microusd_per_million: 1,
      },
      {
        input_microusd_per_million: 1,
        cached_input_microusd_per_million: 2_000_000,
        output_microusd_per_million: 3,
        reasoning_output_microusd_per_million: 3_000_000,
      },
      {
        input_microusd_per_million: 999_999,
        cached_input_microusd_per_million: 1_000_001,
        output_microusd_per_million: 999_999,
        reasoning_output_microusd_per_million: 1_000_001,
      },
      {
        input_microusd_per_million: 0,
        cached_input_microusd_per_million: 7,
        output_microusd_per_million: 11,
        reasoning_output_microusd_per_million: 0,
      },
    ];

    for (const pricing of pricingMatrix) {
      for (let inputTokens = 0; inputTokens <= 5; inputTokens += 1) {
        for (let outputTokens = 0; outputTokens <= 5; outputTokens += 1) {
          const estimate = estimateRoutingAllocation({
            pricing,
            ceilings: {
              max_input_tokens: inputTokens,
              max_output_tokens: outputTokens,
              max_duration_ms: 1,
            },
          }).cost_microusd;
          for (
            let cachedInputTokens = 0;
            cachedInputTokens <= inputTokens;
            cachedInputTokens += 1
          ) {
            for (let reasoningTokens = 0; reasoningTokens <= outputTokens; reasoningTokens += 1) {
              expect(
                calculateRoutingCost(pricing, {
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                  cached_input_tokens: cachedInputTokens,
                  reasoning_tokens: reasoningTokens,
                }),
              ).toBeLessThanOrEqual(estimate);
            }
          }
        }
      }
    }
  });
});

describe("routing budget reservation", () => {
  it("accepts every dimension exactly at its remaining limit", () => {
    const reservation = reservationFixture();
    const state = stateFixture({
      budget: {
        max_input_tokens: 20_000,
        max_output_tokens: 4_000,
        max_cost_microusd: 100_000,
        max_duration_ms: 120_000,
        max_turns: 1,
      },
    });

    const reserved = reserveRoutingBudget({ state, reservation });

    expect(reserved).toMatchObject({
      revision: state.revision + 1,
      previous_state_hash: state.document_hash,
      reservations: [reservation],
    });
    expect(reserved.document_hash).toBe(hashRoutingState(reserved));
    expect(Object.isFrozen(reserved)).toBe(true);
    expect(state.reservations).toEqual([]);
  });

  it.each([
    ["input", "max_input_tokens", 19_999],
    ["output", "max_output_tokens", 3_999],
    ["cost", "max_cost_microusd", 99_999],
    ["duration", "max_duration_ms", 119_999],
  ] as const)("rejects a one-unit %s overage atomically", (_name, field, limit) => {
    const baseline = validRoutingState();
    baseline.budget = { ...(baseline.budget as Record<string, unknown>), [field]: limit };
    const state = stateFixture(baseline);

    expectRoutingError(
      () => reserveRoutingBudget({ state, reservation: reservationFixture() }),
      "RUNTIME_ROUTING_BUDGET_EXCEEDED",
    );
    expect(state.reservations).toEqual([]);
    expect(state.revision).toBe(1);
  });

  it("rejects a one-unit turn overage atomically", () => {
    const state = stateFixture({
      budget: {
        max_input_tokens: 200_000,
        max_output_tokens: 32_768,
        max_cost_microusd: 5_000_000,
        max_duration_ms: 900_000,
        max_turns: 1,
      },
      settled: {
        input_tokens: 0,
        output_tokens: 0,
        cost_microusd: 0,
        duration_ms: 0,
        turns: 1,
      },
    });

    expectRoutingError(
      () => reserveRoutingBudget({ state, reservation: reservationFixture() }),
      "RUNTIME_ROUTING_BUDGET_EXCEEDED",
    );
    expect(state.reservations).toEqual([]);
  });

  it("reserves primary, fallback, and reviewer allocations as one atomic total", () => {
    const allocations = [
      {
        attempt_id: "attempt-reviewer",
        entry_id: "independent-reviewer",
        role: "reviewer" as const,
        input_tokens: 7,
        output_tokens: 11,
        cost_microusd: 13,
        duration_ms: 17,
        turns: 1 as const,
      },
      {
        attempt_id: "attempt-worker-0",
        entry_id: "primary",
        role: "worker" as const,
        input_tokens: 19,
        output_tokens: 23,
        cost_microusd: 29,
        duration_ms: 31,
        turns: 1 as const,
      },
      {
        attempt_id: "attempt-worker-1",
        entry_id: "fallback",
        role: "worker" as const,
        input_tokens: 37,
        output_tokens: 41,
        cost_microusd: 43,
        duration_ms: 47,
        turns: 1 as const,
      },
    ];
    const reservation = reservationFixture({ allocations });
    const exactState = stateFixture({
      budget: {
        max_input_tokens: 63,
        max_output_tokens: 75,
        max_cost_microusd: 85,
        max_duration_ms: 95,
        max_turns: 3,
      },
    });
    expect(reserveRoutingBudget({ state: exactState, reservation }).reservations).toHaveLength(1);

    const insufficientState = stateFixture({
      budget: {
        max_input_tokens: 63,
        max_output_tokens: 75,
        max_cost_microusd: 84,
        max_duration_ms: 95,
        max_turns: 3,
      },
    });
    expectRoutingError(
      () => reserveRoutingBudget({ state: insufficientState, reservation }),
      "RUNTIME_ROUTING_BUDGET_EXCEEDED",
    );
    expect(insufficientState.reservations).toHaveLength(0);
  });

  it("accounts for settled usage and every active reservation before accepting another", () => {
    const prior = stateFixture({
      budget: {
        max_input_tokens: 20_001,
        max_output_tokens: 4_001,
        max_cost_microusd: 100_001,
        max_duration_ms: 120_001,
        max_turns: 2,
      },
      settled: {
        input_tokens: 1,
        output_tokens: 1,
        cost_microusd: 1,
        duration_ms: 1,
        turns: 1,
      },
    });
    const active = reserveRoutingBudget({ state: prior, reservation: reservationFixture() });
    const second = reservationFixture({
      decision_id: "decision-2",
      decision_hash: `sha256:${"9".repeat(64)}`,
      request_id: "request-2",
      allocations: [
        {
          attempt_id: "attempt-worker-1",
          entry_id: "balanced-secondary",
          role: "worker",
          input_tokens: 1,
          output_tokens: 1,
          cost_microusd: 1,
          duration_ms: 1,
          turns: 1,
        },
      ],
    });

    expectRoutingError(
      () => reserveRoutingBudget({ state: active, reservation: second }),
      "RUNTIME_ROUTING_BUDGET_EXCEEDED",
    );
    expect(active.reservations).toHaveLength(1);
  });

  it("rejects duplicate decisions, stale state hashes, and unknown usage", () => {
    const reservation = reservationFixture();
    const reserved = reserveRoutingBudget({ state: stateFixture(), reservation });
    expectRoutingError(
      () => reserveRoutingBudget({ state: reserved, reservation }),
      "RUNTIME_ROUTING_STALE_STATE",
    );
    expectRoutingError(
      () =>
        reserveRoutingBudget({
          state: { ...stateFixture(), document_hash: `sha256:${"f".repeat(64)}` },
          reservation,
        }),
      "RUNTIME_ROUTING_STALE_STATE",
    );
    expectRoutingError(
      () =>
        reserveRoutingBudget({
          state: stateFixture({
            budget_status: "unknown",
            settled: {
              input_tokens: 0,
              output_tokens: 0,
              cost_microusd: null,
              duration_ms: 0,
              turns: 0,
            },
          }),
          reservation,
        }),
      "RUNTIME_ROUTING_USAGE_UNKNOWN",
    );
  });
});

describe("routing budget settlement", () => {
  it("rejects a non-array circuit state chain with a safe routing error", () => {
    const fixture = reservedPlanFixture();

    expectRoutingError(
      () =>
        settleRoutingDecision({
          state: fixture.state,
          reserved_state: fixture.state,
          circuit_state_chain: null as unknown as readonly RoutingStateV1[],
          plan: fixture.plan,
          attempts: [successfulAttempt(fixture.plan)],
          settled_at: "2026-08-21T12:00:01.000Z",
        }),
      "RUNTIME_ROUTING_INVALID",
    );
  });

  it("prices the exact accepted route, releases the reservation, and records actual usage", () => {
    const fixture = reservedPlanFixture();
    const attempt = fixture.plan.worker_attempts[0];
    if (attempt === undefined) throw new Error("missing attempt fixture");
    const result: RoutingAttemptResult = {
      attempt_id: attempt.attempt_id,
      route_identity: routeIdentity(fixture.plan),
      usage: usage(),
      duration_ms: 123,
      effect_may_have_occurred: true,
    };

    const settled = settleRoutingDecision({
      state: fixture.state,
      reserved_state: fixture.state,
      circuit_state_chain: [],
      plan: fixture.plan,
      attempts: [result],
      settled_at: "2026-08-21T12:00:01.000Z",
    });

    const exactRoute = attempt.accepted_routes.find(
      (route) => route.route_id === result.route_identity?.route_id,
    );
    if (exactRoute === undefined) throw new Error("missing accepted route fixture");
    expect(settled).toMatchObject({
      status: "SETTLED",
      state: {
        revision: fixture.state.revision + 1,
        previous_state_hash: fixture.state.document_hash,
        budget_status: "known",
        reservations: [],
        settled: {
          input_tokens: 10,
          output_tokens: 5,
          cost_microusd: calculateRoutingCost(exactRoute.pricing, usage()),
          duration_ms: 123,
          turns: 1,
        },
      },
    });
    expect(settled.state.document_hash).toBe(hashRoutingState(settled.state));
    expect(Object.isFrozen(settled.state)).toBe(true);
    expect(fixture.state.reservations).toHaveLength(1);
  });

  it("returns FAILED and preserves over-limit actual totals after a provider effect", () => {
    const prior = stateFixture({
      budget: {
        max_input_tokens: 20_000,
        max_output_tokens: 4_000,
        max_cost_microusd: 5_000_000,
        max_duration_ms: 120_000,
        max_turns: 1,
      },
    });
    const fixture = reservedPlanFixture({ state: prior });
    const attempt = fixture.plan.worker_attempts[0];
    if (attempt === undefined) throw new Error("missing attempt fixture");

    const settled = settleRoutingDecision({
      state: fixture.state,
      reserved_state: fixture.state,
      circuit_state_chain: [],
      plan: fixture.plan,
      attempts: [
        {
          attempt_id: attempt.attempt_id,
          route_identity: routeIdentity(fixture.plan),
          usage: usage({ output_tokens: 4_001, reasoning_tokens: 0 }),
          duration_ms: 120_001,
          effect_may_have_occurred: true,
        },
      ],
      settled_at: "2026-08-21T12:00:01.000Z",
    });

    expect(settled.status).toBe("FAILED");
    expect(settled.state.settled.output_tokens).toBe(4_001);
    expect(settled.state.settled.duration_ms).toBe(120_001);
    expect(settled.state.reservations).toEqual([]);
    expectRoutingError(
      () => reserveRoutingBudget({ state: settled.state, reservation: reservationFixture() }),
      "RUNTIME_ROUTING_BUDGET_EXCEEDED",
    );
  });

  it.each(["route", "usage"] as const)(
    "marks budget unknown when a possible effect lacks trusted %s",
    (missing) => {
      const fixture = reservedPlanFixture();
      const attempt = fixture.plan.worker_attempts[0];
      if (attempt === undefined) throw new Error("missing attempt fixture");

      const settled = settleRoutingDecision({
        state: fixture.state,
        reserved_state: fixture.state,
        circuit_state_chain: [],
        plan: fixture.plan,
        attempts: [
          {
            attempt_id: attempt.attempt_id,
            route_identity: missing === "route" ? null : routeIdentity(fixture.plan),
            usage: missing === "usage" ? null : usage(),
            duration_ms: 25,
            effect_may_have_occurred: true,
          },
        ],
        settled_at: "2026-08-21T12:00:01.000Z",
      });

      expect(settled).toMatchObject({
        status: "FAILED",
        state: {
          budget_status: "unknown",
          settled: { cost_microusd: null },
          reservations: [],
        },
      });
      expectRoutingError(
        () => reserveRoutingBudget({ state: settled.state, reservation: reservationFixture() }),
        "RUNTIME_ROUTING_USAGE_UNKNOWN",
      );
    },
  );

  it("rejects duplicate results, unplanned routes, stale heads, and tampered plans", () => {
    const fixture = reservedPlanFixture();
    const attempt = fixture.plan.worker_attempts[0];
    if (attempt === undefined) throw new Error("missing attempt fixture");
    const result: RoutingAttemptResult = {
      attempt_id: attempt.attempt_id,
      route_identity: routeIdentity(fixture.plan),
      usage: usage(),
      duration_ms: 1,
      effect_may_have_occurred: true,
    };
    const settle = (
      state: RoutingStateV1,
      plan: PlannedModelSelectionPlanV1,
      attempts: readonly RoutingAttemptResult[],
    ) =>
      settleRoutingDecision({
        state,
        reserved_state: fixture.state,
        circuit_state_chain: state === fixture.state ? [] : [state],
        plan,
        attempts,
        settled_at: "2026-08-21T12:00:01.000Z",
      });

    expectRoutingError(
      () => settle(fixture.state, fixture.plan, [result, result]),
      "RUNTIME_ROUTING_INVALID",
    );
    expectRoutingError(
      () =>
        settle(fixture.state, fixture.plan, [
          {
            ...result,
            route_identity: { ...result.route_identity!, route_id: "unplanned-route" },
          },
        ]),
      "RUNTIME_ROUTING_RESOLUTION_MISMATCH",
    );
    expectRoutingError(
      () =>
        settle({ ...fixture.state, document_hash: `sha256:${"e".repeat(64)}` }, fixture.plan, [
          result,
        ]),
      "RUNTIME_ROUTING_STALE_STATE",
    );
    expectRoutingError(
      () =>
        settle(
          fixture.state,
          {
            ...fixture.plan,
            matched_rule_id: "tampered-rule",
          },
          [result],
        ),
      "RUNTIME_ROUTING_INVALID",
    );
  });

  it("accepts a later valid circuit revision that retains the exact reservation and bindings", () => {
    const fixture = reservedPlanFixture();
    const laterValue = {
      ...fixture.state,
      revision: fixture.state.revision + 1,
      previous_state_hash: fixture.state.document_hash,
      circuits: [
        {
          entry_id: "balanced-primary",
          status: "closed",
          consecutive_failures: 0,
          retry_at: null,
          probe_decision_id: null,
        },
      ],
      document_hash: `sha256:${"0".repeat(64)}`,
    } as RoutingStateV1;
    const later = {
      ...laterValue,
      document_hash: hashRoutingState(laterValue),
    } as RoutingStateV1;
    const attempt = fixture.plan.worker_attempts[0];
    if (attempt === undefined) throw new Error("missing attempt fixture");

    const settled = settleRoutingDecision({
      state: later,
      reserved_state: fixture.state,
      circuit_state_chain: [later],
      plan: fixture.plan,
      attempts: [
        {
          attempt_id: attempt.attempt_id,
          route_identity: routeIdentity(fixture.plan),
          usage: usage(),
          duration_ms: 1,
          effect_may_have_occurred: true,
        },
      ],
      settled_at: "2026-08-21T12:00:01.000Z",
    });

    expect(settled.status).toBe("SETTLED");
    expect(settled.state.previous_state_hash).toBe(later.document_hash);
    expect(settled.state.revision).toBe(later.revision + 1);
  });

  it("rejects forks, jumps, and non-circuit drift in a claimed descendant", () => {
    const fixture = reservedPlanFixture();
    const circuits: readonly RoutingCircuitV1[] = [
      {
        entry_id: "balanced-primary",
        status: "closed",
        consecutive_failures: 0,
        retry_at: null,
        probe_decision_id: null,
      },
    ];
    const otherReservation = reservationFixture({
      decision_id: "decision-2",
      decision_hash: `sha256:${"9".repeat(64)}`,
      request_id: "request-2",
      allocations: [
        {
          attempt_id: "attempt-worker-1",
          entry_id: "balanced-secondary",
          role: "worker",
          input_tokens: 1,
          output_tokens: 1,
          cost_microusd: 1,
          duration_ms: 1,
          turns: 1,
        },
      ],
    });
    const cases: readonly [string, RoutingStateV1][] = [
      ["same-revision fork", rehashState({ ...fixture.state, circuits })],
      [
        "wrong predecessor",
        immediateCircuitDescendant(fixture.state, circuits, {
          previous_state_hash: `sha256:${"f".repeat(64)}`,
        }),
      ],
      [
        "revision jump",
        immediateCircuitDescendant(fixture.state, circuits, {
          revision: fixture.state.revision + 2,
        }),
      ],
      [
        "budget drift",
        immediateCircuitDescendant(fixture.state, circuits, {
          budget: { ...fixture.state.budget, max_input_tokens: 200_001 },
        }),
      ],
      [
        "settled drift",
        immediateCircuitDescendant(fixture.state, circuits, {
          settled: { ...fixture.state.settled, input_tokens: 1 },
        }),
      ],
      [
        "reservation drift",
        immediateCircuitDescendant(fixture.state, circuits, {
          reservations: [...fixture.state.reservations, otherReservation],
        }),
      ],
    ];

    for (const [, state] of cases) {
      expectRoutingError(
        () =>
          settleRoutingDecision({
            state,
            reserved_state: fixture.state,
            circuit_state_chain: [state],
            plan: fixture.plan,
            attempts: [successfulAttempt(fixture.plan)],
            settled_at: "2026-08-21T12:00:01.000Z",
          }),
        "RUNTIME_ROUTING_STALE_STATE",
      );
    }
  });

  it("requires the supplied reserved state to match the plan's exact next head", () => {
    const fixture = reservedPlanFixture();
    const driftedReservedState = rehashState({
      ...fixture.state,
      budget: { ...fixture.state.budget, max_input_tokens: 200_001 },
    });

    expectRoutingError(
      () =>
        settleRoutingDecision({
          state: fixture.state,
          reserved_state: driftedReservedState,
          circuit_state_chain: [],
          plan: fixture.plan,
          attempts: [successfulAttempt(fixture.plan)],
          settled_at: "2026-08-21T12:00:01.000Z",
        }),
      "RUNTIME_ROUTING_STALE_STATE",
    );
  });

  it.each(["known", "unknown"] as const)(
    "requires an outcome transition before settling a %s probe reservation",
    (usageStatus) => {
      const fixture = probeReservedPlanFixture();
      const attempt = successfulAttempt(fixture.plan);
      expectRoutingError(
        () =>
          settleRoutingDecision({
            state: fixture.state,
            reserved_state: fixture.state,
            circuit_state_chain: [],
            plan: fixture.plan,
            attempts: [
              usageStatus === "known" ? attempt : { ...attempt, route_identity: null, usage: null },
            ],
            settled_at: "2026-08-21T12:00:01.000Z",
          }),
        "RUNTIME_ROUTING_STALE_STATE",
      );
    },
  );

  it.each(["known", "unknown"] as const)(
    "settles %s probe usage after one immediate circuit descendant resolves the lease",
    (usageStatus) => {
      const fixture = probeReservedPlanFixture();
      const current = immediateCircuitDescendant(fixture.state, [
        {
          entry_id: "balanced-primary",
          status: "closed",
          consecutive_failures: 0,
          retry_at: null,
          probe_decision_id: null,
        },
      ]);
      const attempt = successfulAttempt(fixture.plan);

      const settled = settleRoutingDecision({
        state: current,
        reserved_state: fixture.state,
        circuit_state_chain: [current],
        plan: fixture.plan,
        attempts: [
          usageStatus === "known" ? attempt : { ...attempt, route_identity: null, usage: null },
        ],
        settled_at: "2026-08-21T12:00:01.000Z",
      });

      expect(settled.status).toBe(usageStatus === "known" ? "SETTLED" : "FAILED");
      expect(settled.state.budget_status).toBe(usageStatus);
      expect(settled.state.reservations).toEqual([]);
      expect(settled.state.circuits).toEqual(current.circuits);
    },
  );

  it("rejects unknown settlement that would orphan another active probe lease", () => {
    const otherReservation = reservationFixture({
      decision_id: "decision-0",
      decision_hash: `sha256:${"9".repeat(64)}`,
      request_id: "request-0",
      allocations: [
        {
          attempt_id: "attempt-other-probe",
          entry_id: "other-probe",
          role: "worker",
          input_tokens: 1,
          output_tokens: 1,
          cost_microusd: 1,
          duration_ms: 1,
          turns: 1,
        },
      ],
    });
    const active = reserveRoutingBudget({
      state: stateFixture(),
      reservation: otherReservation,
    });
    const prior = rehashState({
      ...active,
      circuits: [
        {
          entry_id: "other-probe",
          status: "probe-reserved",
          consecutive_failures: 1,
          retry_at: "2026-08-21T12:00:00.000Z",
          probe_decision_id: otherReservation.decision_id,
        },
      ],
    });
    const fixture = reservedPlanFixture({ state: prior });
    const attempt = successfulAttempt(fixture.plan);

    expectRoutingError(
      () =>
        settleRoutingDecision({
          state: fixture.state,
          reserved_state: fixture.state,
          circuit_state_chain: [],
          plan: fixture.plan,
          attempts: [{ ...attempt, route_identity: null, usage: null }],
          settled_at: "2026-08-21T12:00:01.000Z",
        }),
      "RUNTIME_ROUTING_STALE_STATE",
    );
  });
});
