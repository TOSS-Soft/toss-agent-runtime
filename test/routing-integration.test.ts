import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  hashAgentgatewayCapabilities,
  hashModelCatalog,
  hashRoutingState,
  nextModelFallback,
  parseAgentgatewayCapabilities,
  parseModelCatalog,
  parseModelSelectionPlan,
  parseRoutingPolicy,
  parseRoutingState,
  planModelSelection,
  recordRoutingOutcome,
  settleRoutingDecision,
  verifyResolvedRoute,
  type AgentgatewayCapabilitiesV1,
  type CatalogRouteV1,
  type ModelCatalogEntryV1,
  type ModelCatalogV1,
  type PlannedModelSelectionPlanV1,
  type ProviderAdapterCapabilities,
  type ProviderKind,
  type RoutingAttemptResult,
  type RoutingStateV1,
} from "../src/index.js";
import {
  plannedRouteIdentity,
  plannedRoutingFixture,
  pricing,
  providerCapabilities,
} from "./helpers/routing-fixtures.js";

const ROUTING_DOCUMENT_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxMembers: 100_000,
});
const ZERO_SHA256: `sha256:${string}` = `sha256:${"0".repeat(64)}`;

function parsedValue<T>(result: Readonly<{ ok: boolean; value?: T }>, label: string): T {
  if (!result.ok || result.value === undefined) throw new Error(`invalid ${label} fixture`);
  return result.value;
}

async function publishedExample(name: string): Promise<Uint8Array> {
  return readFile(`examples/runtime-contract-v1/${name}.json`);
}

function rehashedCatalog(entries: readonly ModelCatalogEntryV1[]): ModelCatalogV1 {
  const candidate = {
    protocol_version: "runtime-contract.v1",
    schema_version: "model-catalog.v1",
    document_type: "model-catalog",
    catalog_id: "catalog-circuit",
    revision: 1,
    entries,
    document_hash: ZERO_SHA256,
  } as const satisfies ModelCatalogV1;
  return parsedValue(
    parseModelCatalog(
      canonicalJson(
        { ...candidate, document_hash: hashModelCatalog(candidate) },
        ROUTING_DOCUMENT_LIMITS,
      ),
    ),
    "catalog",
  );
}

function rehashedLive(
  template: AgentgatewayCapabilitiesV1,
  routes: AgentgatewayCapabilitiesV1["routes"],
  decisionAt: string,
): AgentgatewayCapabilitiesV1 {
  const candidate = { ...template, routes, document_hash: ZERO_SHA256 };
  return parsedValue(
    parseAgentgatewayCapabilities(
      canonicalJson({
        ...candidate,
        document_hash: hashAgentgatewayCapabilities(candidate),
      }),
      { now: () => new Date(decisionAt) },
    ),
    "live capability",
  );
}

function rehashedState(template: RoutingStateV1, catalogHash: `sha256:${string}`): RoutingStateV1 {
  const candidate = {
    ...template,
    catalog_hash: catalogHash,
    document_hash: ZERO_SHA256,
  };
  return parsedValue(
    parseRoutingState(canonicalJson({ ...candidate, document_hash: hashRoutingState(candidate) })),
    "routing state",
  );
}

function semanticSelection(plan: PlannedModelSelectionPlanV1): unknown {
  return {
    workers: plan.worker_attempts.map((attempt) => ({
      entry_id: attempt.entry_id,
      fallback_index: attempt.fallback_index,
      accepted_routes: attempt.accepted_routes.map((route) => route.route_id),
    })),
    reviewer: plan.reviewer_attempt?.entry_id ?? null,
    eliminations: plan.eliminations,
  };
}

function resultFor(
  fixture: ReturnType<typeof plannedRoutingFixture>,
  attemptId: string,
): RoutingAttemptResult {
  return {
    attempt_id: attemptId,
    route_identity: plannedRouteIdentity(fixture, attemptId),
    usage: {
      input_tokens: 1_000,
      output_tokens: 200,
      cached_input_tokens: 100,
      reasoning_tokens: 20,
    },
    duration_ms: 1_000,
    effect_may_have_occurred: true,
  };
}

describe("governed routing integration", () => {
  it("publishes the exact canonical fixture used by the end-to-end routing flow", async () => {
    const fixture = plannedRoutingFixture({ review: true });
    const catalog = parsedValue(
      parseModelCatalog(await publishedExample("model-catalog")),
      "catalog",
    );
    const policy = parsedValue(
      parseRoutingPolicy(await publishedExample("routing-policy")),
      "policy",
    );
    const state = parsedValue(parseRoutingState(await publishedExample("routing-state")), "state");
    const plan = parsedValue(
      parseModelSelectionPlan(await publishedExample("model-selection-plan")),
      "plan",
    );

    expect(catalog).toEqual(fixture.catalog);
    expect(policy).toEqual(fixture.policy);
    expect(state).toEqual(fixture.prior_state);
    expect(plan).toEqual(fixture.plan);
    expect(plan.status).toBe("planned");
    if (plan.status === "planned") {
      expect(plan.next_state_hash).toBe(fixture.state.document_hash);
      expect(plan.reservation.decision_hash).toBe(fixture.plan.reservation.decision_hash);
    }
  });

  it("rebinds authoritative hashes across catalog and live permutations without changing selection", () => {
    const fixture = plannedRoutingFixture({ review: true });
    const baseline = semanticSelection(fixture.plan);
    const catalogPermutations = [
      fixture.catalog.entries,
      [...fixture.catalog.entries]
        .reverse()
        .map((entry) => ({ ...entry, routes: [...entry.routes].reverse() })),
    ];
    const livePermutations = [fixture.input.live.routes, [...fixture.input.live.routes].reverse()];

    for (const [catalogIndex, entries] of catalogPermutations.entries()) {
      for (const [liveIndex, routes] of livePermutations.entries()) {
        const catalog = rehashedCatalog(entries);
        const live = rehashedLive(fixture.input.live, routes, fixture.input.decision_at);
        const state = rehashedState(fixture.prior_state, catalog.document_hash);
        const decision = planModelSelection({ ...fixture.input, catalog, live, state });

        expect(decision.status).toBe("planned");
        if (decision.status !== "planned") continue;
        expect(semanticSelection(decision.plan)).toEqual(baseline);
        expect(decision.plan.catalog_hash).toBe(catalog.document_hash);
        expect(decision.plan.capability_document_hash).toBe(live.document_hash);
        if (catalogIndex + liveIndex > 0) {
          expect(decision.plan.document_hash).not.toBe(fixture.plan.document_hash);
          expect(decision.next_state.document_hash).not.toBe(fixture.state.document_hash);
        }
      }
    }
  });

  it("binds route verification, a timeout witness, explicit fallback, and circuit-chain settlement", () => {
    const fixture = plannedRoutingFixture({ review: true });
    const primary = fixture.plan.worker_attempts[0];
    const fallback = fixture.plan.worker_attempts[1];
    if (primary === undefined || fallback === undefined) throw new Error("missing worker attempts");

    const primaryResult = resultFor(fixture, primary.attempt_id);
    expect(
      verifyResolvedRoute({
        state: fixture.state,
        plan: fixture.plan,
        attempt_id: primary.attempt_id,
        route_identity: primaryResult.route_identity,
      }),
    ).toEqual(primaryResult.route_identity);

    const recorded = recordRoutingOutcome({
      state: fixture.state,
      plan: fixture.plan,
      policy: fixture.policy,
      attempt_id: primary.attempt_id,
      outcome: "RUNTIME_PROVIDER_TIMEOUT",
      occurred_at: "2026-08-21T12:00:30.000Z",
    });
    expect(recorded.transition).toMatchObject({
      previous_state_hash: fixture.state.document_hash,
      next_state_hash: recorded.state.document_hash,
      attempt_id: primary.attempt_id,
      outcome: "RUNTIME_PROVIDER_TIMEOUT",
    });

    const next = nextModelFallback({
      state: recorded.state,
      previous_state: fixture.state,
      plan: fixture.plan,
      policy: fixture.policy,
      transition: recorded.transition,
      current_attempt_id: primary.attempt_id,
      outcome: "RUNTIME_PROVIDER_TIMEOUT",
      occurred_at: "2026-08-21T12:00:30.000Z",
      attempt_results: [primaryResult],
      remaining_duration_ms: 300_000,
    });
    expect(next).toMatchObject({ status: "ready", attempt: { entry_id: fallback.entry_id } });

    const fallbackResult = resultFor(fixture, fallback.attempt_id);
    expect(
      verifyResolvedRoute({
        state: fixture.state,
        plan: fixture.plan,
        attempt_id: fallback.attempt_id,
        route_identity: fallbackResult.route_identity,
      }),
    ).toEqual(fallbackResult.route_identity);

    const settlement = settleRoutingDecision({
      state: recorded.state,
      reserved_state: fixture.state,
      circuit_state_chain: [recorded.state],
      plan: fixture.plan,
      attempts: [primaryResult, fallbackResult],
      settled_at: "2026-08-21T12:01:00.000Z",
    });
    expect(settlement.status).toBe("SETTLED");
    expect(settlement.state.reservations).toEqual([]);
    expect(settlement.state.settled).toMatchObject({
      input_tokens: 2_000,
      output_tokens: 400,
      duration_ms: 2_000,
      turns: 2,
    });
  });

  it("plans a 1,024-entry catalog against exactly 256 live routes within five seconds", () => {
    const fixture = plannedRoutingFixture({ review: true });
    const capabilitiesByProvider = new Map<ProviderKind, ProviderAdapterCapabilities>();
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      capabilitiesByProvider.set(provider, providerCapabilities(provider));
    }
    const entries: ModelCatalogEntryV1[] = Array.from({ length: 1_024 }, (_, index) => {
      const identifier = index.toString().padStart(4, "0");
      const provider: ProviderKind =
        index === 2 ? "anthropic" : index % 2 === 0 ? "openai" : "gemini";
      const route: CatalogRouteV1 = {
        route_id: `route-bounded-${identifier}`,
        provider,
        model: `model-bounded-${identifier}`,
        capabilities: capabilitiesByProvider.get(provider)!,
        latency_class: "standard",
        pricing: pricing(2_000_000, 200_000, 10_000_000, 12_000_000),
      };
      return {
        entry_id: `entry-bounded-${identifier}`,
        logical_classes:
          index === 2
            ? ["independent-review"]
            : index < 2
              ? ["balanced-code", "deep-reasoning", "economy"]
              : ["vision"],
        route_alias: `alias-bounded-${identifier}`,
        priority: index,
        routes: [route],
      };
    });
    const catalog = rehashedCatalog(entries);
    const live = rehashedLive(
      fixture.input.live,
      entries.slice(0, 256).map((entry) => {
        const route = entry.routes[0]!;
        return {
          alias: entry.route_alias,
          route_id: route.route_id,
          provider: route.provider,
          model: route.model,
          capabilities: route.capabilities,
        };
      }),
      fixture.input.decision_at,
    );
    const state = rehashedState(fixture.prior_state, catalog.document_hash);

    const startedAt = performance.now();
    const decision = planModelSelection({ ...fixture.input, catalog, live, state });
    const durationMs = performance.now() - startedAt;

    expect(durationMs).toBeLessThan(5_000);
    expect(catalog.entries).toHaveLength(1_024);
    expect(live.routes).toHaveLength(256);
    expect(decision.status).toBe("planned");
    if (decision.status !== "planned") return;
    expect(decision.plan.worker_attempts).toHaveLength(2);
    expect(decision.plan.reviewer_attempt?.entry_id).toBe("entry-bounded-0002");
    expect(decision.plan.reservation.allocations).toHaveLength(3);
    expect(
      Buffer.byteLength(canonicalJson(decision.plan, ROUTING_DOCUMENT_LIMITS), "utf8"),
    ).toBeLessThan(2 * 1024 * 1024);
  }, 5_000);
});
