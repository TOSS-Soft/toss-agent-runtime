import { describe, expect, it } from "vitest";

import { sha256 } from "../src/protocol/json.js";
import {
  hashModelSelectionPlan,
  hashModelCatalog,
  hashRoutingState,
  hashRoutingPolicy,
  parseModelSelectionPlan,
  parseGovernedRoutingOverride,
  parseModelCatalog,
  parseRoutingPolicy,
  parseRoutingState,
} from "../src/routing/contracts.js";
import { routingRuntimeError } from "../src/routing/errors.js";
import {
  catalogBytes,
  catalogDocumentHash,
  overrideValueHash,
  policyBytes,
  policyDocumentHash,
  routingStateBytes,
  routingStateDocumentHash,
  selectionDecisionHash,
  selectionPlanBytes,
  selectionPlanDocumentHash,
  validCatalog,
  validBlockedSelectionPlan,
  validPlannedSelectionPlan,
  validRoutingOverride,
  validRoutingPolicy,
  validRoutingReservation,
  validRoutingState,
} from "./helpers/routing-fixtures.js";

function parsedCatalog(value: Record<string, unknown>) {
  return parseModelCatalog(catalogBytes(value));
}

function expectInvalid(value: Record<string, unknown>) {
  expect(parsedCatalog(value)).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
}

describe("model catalog contract", () => {
  it("parses the canonical catalog, binds its exact order, and deeply freezes it", () => {
    const catalog = validCatalog();
    const parsed = parsedCatalog(catalog);

    expect(parsed).toMatchObject({
      ok: true,
      value: { document_hash: catalogDocumentHash(catalog) },
    });
    if (!parsed.ok) return;

    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.entries)).toBe(true);
    expect(Object.isFrozen(parsed.value.entries[0]?.routes)).toBe(true);
    expect(hashModelCatalog(parsed.value)).toBe(catalogDocumentHash(catalog));

    const reordered = {
      ...catalog,
      entries: [
        {
          ...((catalog.entries as Record<string, unknown>[])[0] as Record<string, unknown>),
          routes: [
            ...(((catalog.entries as Record<string, unknown>[])[0] as Record<string, unknown>)
              .routes as unknown[]),
          ].reverse(),
        },
      ],
    };
    expect(catalogDocumentHash(reordered)).not.toBe(catalogDocumentHash(catalog));
  });

  it("accepts the six closed logical classes in any order", () => {
    const catalog = validCatalog();
    catalog.entries = [
      {
        ...(catalog.entries as Record<string, unknown>[])[0],
        logical_classes: [
          "vision",
          "independent-review",
          "deep-reasoning",
          "economy",
          "long-context",
          "balanced-code",
        ],
      },
    ];

    expect(parsedCatalog(catalog)).toMatchObject({ ok: true });
  });

  it("rejects a document hash that does not bind canonical catalog content", () => {
    const catalog = validCatalog();
    expect(
      parseModelCatalog(JSON.stringify({ ...catalog, document_hash: `sha256:${"f".repeat(64)}` })),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it("rejects duplicate entry IDs", () => {
    const catalog = validCatalog();
    catalog.entries = [...(catalog.entries as unknown[]), (catalog.entries as unknown[])[0]];
    expectInvalid(catalog);
  });

  it("rejects duplicate route IDs across entries", () => {
    const catalog = validCatalog();
    const entry = (catalog.entries as Record<string, unknown>[])[0] as Record<string, unknown>;
    catalog.entries = [entry, { ...entry, entry_id: "balanced-secondary" }];
    expectInvalid(catalog);
  });

  it("rejects duplicate logical classes in an entry", () => {
    const catalog = validCatalog();
    const entry = (catalog.entries as Record<string, unknown>[])[0] as Record<string, unknown>;
    catalog.entries = [{ ...entry, logical_classes: ["economy", "economy"] }];
    expectInvalid(catalog);
  });

  it("rejects an unsafe route alias", () => {
    const catalog = validCatalog();
    const entry = (catalog.entries as Record<string, unknown>[])[0] as Record<string, unknown>;
    catalog.entries = [{ ...entry, route_alias: "balanced code" }];
    expectInvalid(catalog);
  });

  it("rejects a route with a mismatched capability provider", () => {
    const catalog = validCatalog();
    const entry = (catalog.entries as Record<string, unknown>[])[0] as Record<string, unknown>;
    const route = (entry.routes as Record<string, unknown>[])[0] as Record<string, unknown>;
    catalog.entries = [
      {
        ...entry,
        routes: [
          { ...route, capabilities: { ...(route.capabilities as object), provider: "openai" } },
        ],
      },
    ];
    expectInvalid(catalog);
  });

  it("rejects missing or unsafe price fields", () => {
    const missing = validCatalog();
    const entry = (missing.entries as Record<string, unknown>[])[0] as Record<string, unknown>;
    const route = (entry.routes as Record<string, unknown>[])[0] as Record<string, unknown>;
    const { output_microusd_per_million: _output, ...pricing } = route.pricing as Record<
      string,
      unknown
    >;
    missing.entries = [{ ...entry, routes: [{ ...route, pricing }] }];
    expectInvalid(missing);

    const unsafe = validCatalog();
    const unsafeEntry = (unsafe.entries as Record<string, unknown>[])[0] as Record<string, unknown>;
    const unsafeRoute = (unsafeEntry.routes as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
    unsafe.entries = [
      {
        ...unsafeEntry,
        routes: [
          {
            ...unsafeRoute,
            pricing: {
              ...(unsafeRoute.pricing as object),
              input_microusd_per_million: Number.MAX_SAFE_INTEGER + 1,
            },
          },
        ],
      },
    ];
    expectInvalid(unsafe);
  });

  it("rejects unknown fields and duplicate JSON keys", () => {
    expectInvalid({ ...validCatalog(), unexpected: true });
    const bytes = catalogBytes(validCatalog()).replace(
      '"catalog_id":"catalog-production"',
      '"catalog_id":"catalog-production","catalog_id":"catalog-production"',
    );
    expect(parseModelCatalog(bytes)).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it("rejects more than 1024 entries and input over two MiB", () => {
    const catalog = validCatalog();
    const entry = (catalog.entries as unknown[])[0];
    catalog.entries = Array.from({ length: 1025 }, (_, index) => ({
      ...(entry as Record<string, unknown>),
      entry_id: `entry-${index}`,
      routes: [
        {
          ...((entry as Record<string, unknown>).routes as Record<string, unknown>[])[0],
          route_id: `route-${index}`,
        },
      ],
    }));
    expect(
      parseModelCatalog(JSON.stringify({ ...catalog, document_hash: `sha256:${"0".repeat(64)}` })),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });

    expect(parseModelCatalog(" ".repeat(2 * 1024 * 1024 + 1))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });

  it("returns fixed non-reflective routing errors", () => {
    expect(routingRuntimeError("RUNTIME_ROUTING_CIRCUIT_OPEN")).toEqual({
      code: "RUNTIME_ROUTING_CIRCUIT_OPEN",
      category: "unavailable",
      retryable: true,
      safe_message: "Routing circuit is open",
    });
    expect(routingRuntimeError("RUNTIME_ROUTING_RESOLUTION_MISMATCH")).toEqual({
      code: "RUNTIME_ROUTING_RESOLUTION_MISMATCH",
      category: "integrity",
      retryable: false,
      safe_message: "Resolved route does not match the plan",
    });
  });
});

function parsedPolicy(value: Record<string, unknown>) {
  return parseRoutingPolicy(policyBytes(value));
}

function expectInvalidPolicy(value: Record<string, unknown>) {
  expect(parsedPolicy(value)).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
}

function policyRule(policy: Record<string, unknown>, index: number): Record<string, unknown> {
  return (policy.rules as Record<string, unknown>[])[index] as Record<string, unknown>;
}

describe("routing policy contract", () => {
  it("covers every task profile, preserves semantic ordering, and binds the exact policy hash", () => {
    const policy = validRoutingPolicy();
    const parsed = parsedPolicy(policy);

    expect(parsed).toMatchObject({
      ok: true,
      value: { document_hash: policyDocumentHash(policy) },
    });
    if (!parsed.ok) return;

    expect(hashRoutingPolicy(parsed.value)).toBe(policyDocumentHash(policy));
    expect(Object.isFrozen(parsed.value.rules)).toBe(true);

    const reordered = { ...policy, rules: [...(policy.rules as unknown[])].reverse() };
    expect(policyDocumentHash(reordered)).not.toBe(policyDocumentHash(policy));
  });

  it("accepts disjoint rules at the same priority", () => {
    const policy = validRoutingPolicy();
    const nonRisk = policyRule(policy, 0);
    const security = policyRule(policy, 1);
    policy.rules = [
      { ...nonRisk, priority: 5 },
      { ...security, priority: 5 },
      policyRule(policy, 2),
    ];

    expect(parsedPolicy(policy)).toMatchObject({ ok: true });
  });

  it("rejects a valid policy padded beyond the 512 KiB input ceiling", () => {
    const paddedPolicy = `${policyBytes(validRoutingPolicy())}${" ".repeat(512 * 1024 + 1)}`;

    expect(parseRoutingPolicy(paddedPolicy)).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });

  it.each([
    [
      "duplicate rule IDs",
      (policy: Record<string, unknown>) => {
        const security = policyRule(policy, 1);
        policy.rules = [...(policy.rules as unknown[]), { ...security, priority: 4 }];
      },
    ],
    [
      "same-priority overlap",
      (policy: Record<string, unknown>) => {
        const security = policyRule(policy, 1);
        policy.rules = [...(policy.rules as unknown[]), { ...security, rule_id: "security-copy" }];
      },
    ],
    [
      "no catch-all",
      (policy: Record<string, unknown>) => {
        const riskDefault = policyRule(policy, 2);
        policy.rules = [...(policy.rules as unknown[])].filter((rule) => rule !== riskDefault);
      },
    ],
    [
      "multiple catch-all rules",
      (policy: Record<string, unknown>) => {
        const catchAll = policyRule(policy, 2);
        policy.rules = [
          ...(policy.rules as unknown[]),
          { ...catchAll, rule_id: "second-catch-all", priority: 30 },
        ];
      },
    ],
    [
      "a risk task resolved without independent review",
      (policy: Record<string, unknown>) => {
        const riskDefault = policyRule(policy, 2);
        policy.rules = [
          ...(policy.rules as unknown[]),
          {
            ...riskDefault,
            rule_id: "unsafe-security",
            priority: 1,
            match: { phase: "implementation", complexity: "high", risks: ["security"] },
            review: "none",
          },
        ];
      },
    ],
    [
      "duplicate worker preferences",
      (policy: Record<string, unknown>) => {
        const nonRisk = policyRule(policy, 0);
        policy.rules = [
          { ...nonRisk, worker_class_preference: ["economy", "economy"] },
          ...(policy.rules as unknown[]).slice(1),
        ];
      },
    ],
    [
      "duplicate required capabilities",
      (policy: Record<string, unknown>) => {
        const nonRisk = policyRule(policy, 0);
        policy.rules = [
          { ...nonRisk, required_capabilities: ["text", "text"] },
          ...(policy.rules as unknown[]).slice(1),
        ];
      },
    ],
    [
      "duplicate risk values",
      (policy: Record<string, unknown>) => {
        const nonRisk = policyRule(policy, 0);
        policy.rules = [
          {
            ...nonRisk,
            match: {
              ...(nonRisk.match as Record<string, unknown>),
              risks: ["security", "security"],
            },
          },
          ...(policy.rules as unknown[]).slice(1),
        ];
      },
    ],
    [
      "an unsupported worker class",
      (policy: Record<string, unknown>) => {
        const nonRisk = policyRule(policy, 0);
        policy.rules = [
          { ...nonRisk, worker_class_preference: ["unbounded"] },
          ...(policy.rules as unknown[]).slice(1),
        ];
      },
    ],
    [
      "excessive fallback",
      (policy: Record<string, unknown>) => {
        const nonRisk = policyRule(policy, 0);
        policy.rules = [{ ...nonRisk, max_fallbacks: 16 }, ...(policy.rules as unknown[]).slice(1)];
      },
    ],
    [
      "an unsafe circuit threshold",
      (policy: Record<string, unknown>) => {
        const nonRisk = policyRule(policy, 0);
        policy.rules = [
          { ...nonRisk, circuit: { consecutive_failure_threshold: 101, cooldown_ms: 60_000 } },
          ...(policy.rules as unknown[]).slice(1),
        ];
      },
    ],
    [
      "an unsafe circuit cooldown",
      (policy: Record<string, unknown>) => {
        const nonRisk = policyRule(policy, 0);
        policy.rules = [
          { ...nonRisk, circuit: { consecutive_failure_threshold: 3, cooldown_ms: 86_400_001 } },
          ...(policy.rules as unknown[]).slice(1),
        ];
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const policy = validRoutingPolicy();
    mutate(policy);
    expectInvalidPolicy(policy);
  });
});

function overrideInput(value: Record<string, unknown> = validRoutingOverride()) {
  return {
    artifact: {
      document_type: "routing-override",
      artifact_id: "override-incident-1",
      revision: 1,
      hash: overrideValueHash(value),
    },
    value,
  };
}

describe("routing override contract", () => {
  it("parses a canonical, hash-bound override", () => {
    const input = overrideInput();
    const result = parseGovernedRoutingOverride(input);

    expect(result).toMatchObject({ ok: true, value: input });
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
  });

  it.each([
    [
      "a stale artifact hash",
      () => ({
        ...overrideInput(),
        artifact: {
          ...overrideInput().artifact,
          hash: `sha256:${"f".repeat(64)}` as `sha256:${string}`,
        },
      }),
    ],
    [
      "a missing target entry",
      () => {
        const value = validRoutingOverride();
        const { target_entry_id: _targetEntryId, ...withoutTarget } = value;
        return overrideInput(withoutTarget);
      },
    ],
    [
      "an invalid reason",
      () => {
        const value = { ...validRoutingOverride(), reason_code: "manual" };
        return overrideInput(value);
      },
    ],
    [
      "a non-canonical UTC timestamp",
      () => {
        const value = { ...validRoutingOverride(), issued_at: "2026-08-21T12:00:00Z" };
        return overrideInput(value);
      },
    ],
    [
      "a non-override artifact",
      () => ({
        ...overrideInput(),
        artifact: { ...overrideInput().artifact, document_type: "model-catalog" },
      }),
    ],
  ])("rejects %s", (_name, input) => {
    expect(parseGovernedRoutingOverride(input())).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });
});

function parsedState(value: Record<string, unknown>) {
  return parseRoutingState(routingStateBytes(value));
}

describe("routing state contract", () => {
  it("accepts an empty state, every circuit variant, and a combined reservation", () => {
    const empty = validRoutingState();
    const parsedEmpty = parsedState(empty);
    expect(parsedEmpty).toMatchObject({
      ok: true,
      value: { document_hash: routingStateDocumentHash(empty) },
    });

    const state = validRoutingState();
    state.revision = 2;
    state.previous_state_hash = `sha256:${"9".repeat(64)}`;
    const reservation = validRoutingReservation();
    const workerAllocation = (reservation.allocations as Record<string, unknown>[])[0];
    reservation.allocations = [
      {
        ...workerAllocation,
        attempt_id: "attempt-reviewer",
        entry_id: "review-primary",
        role: "reviewer",
      },
      workerAllocation,
    ];
    state.reservations = [reservation];
    state.circuits = [
      {
        entry_id: "balanced-primary",
        status: "closed",
        consecutive_failures: 0,
        retry_at: null,
        probe_decision_id: null,
      },
      {
        entry_id: "deep-primary",
        status: "open",
        consecutive_failures: 3,
        retry_at: "2026-08-21T12:01:00.000Z",
        probe_decision_id: null,
      },
      {
        entry_id: "review-primary",
        status: "probe-reserved",
        consecutive_failures: 3,
        retry_at: "2026-08-21T12:01:00.000Z",
        probe_decision_id: "decision-1",
      },
    ];

    const parsed = parsedState(state);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.reservations[0]?.allocations)).toBe(true);
    expect(hashRoutingState(parsed.value)).toBe(routingStateDocumentHash(state));
  });

  it("rejects a mismatched document hash and incoherent prior state identity", () => {
    const state = validRoutingState();
    expect(
      parseRoutingState(JSON.stringify({ ...state, document_hash: `sha256:${"f".repeat(64)}` })),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });

    state.revision = 2;
    expect(parsedState(state)).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it.each([
    ["a dangling decision", "balanced-primary", "decision-missing"],
    ["a reservation for another entry", "review-primary", "decision-1"],
  ])("rejects a probe claim backed by %s", (_name, entryId, probeDecisionId) => {
    const state = validRoutingState();
    state.revision = 2;
    state.previous_state_hash = `sha256:${"9".repeat(64)}`;
    state.reservations = [validRoutingReservation()];
    state.circuits = [
      {
        entry_id: entryId,
        status: "probe-reserved",
        consecutive_failures: 3,
        retry_at: "2026-08-21T12:01:00.000Z",
        probe_decision_id: probeDecisionId,
      },
    ];

    expect(parsedState(state)).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });

  it.each([
    [
      "duplicate reservations",
      (state: Record<string, unknown>) => {
        const reservation = validRoutingReservation();
        state.reservations = [reservation, reservation];
      },
    ],
    [
      "duplicate allocation attempt IDs",
      (state: Record<string, unknown>) => {
        const reservation = validRoutingReservation();
        const allocation = (reservation.allocations as unknown[])[0];
        reservation.allocations = [allocation, allocation];
        state.reservations = [reservation];
      },
    ],
    [
      "duplicate circuit entry IDs",
      (state: Record<string, unknown>) => {
        const circuit = {
          entry_id: "balanced-primary",
          status: "closed",
          consecutive_failures: 0,
          retry_at: null,
          probe_decision_id: null,
        };
        state.circuits = [circuit, circuit];
      },
    ],
    [
      "unsorted reservations",
      (state: Record<string, unknown>) => {
        state.reservations = [
          { ...validRoutingReservation(), decision_id: "decision-z" },
          { ...validRoutingReservation(), decision_id: "decision-a" },
        ];
      },
    ],
    [
      "an invalid closed circuit",
      (state: Record<string, unknown>) => {
        state.circuits = [
          {
            entry_id: "balanced-primary",
            status: "closed",
            consecutive_failures: 0,
            retry_at: "2026-08-21T12:01:00.000Z",
            probe_decision_id: null,
          },
        ];
      },
    ],
    [
      "an invalid open circuit",
      (state: Record<string, unknown>) => {
        state.circuits = [
          {
            entry_id: "balanced-primary",
            status: "open",
            consecutive_failures: 2,
            retry_at: null,
            probe_decision_id: null,
          },
        ];
      },
    ],
    [
      "an invalid probe reservation",
      (state: Record<string, unknown>) => {
        state.circuits = [
          {
            entry_id: "balanced-primary",
            status: "probe-reserved",
            consecutive_failures: 2,
            retry_at: "2026-08-21T12:01:00.000Z",
            probe_decision_id: null,
          },
        ];
      },
    ],
    [
      "unknown cost with active reservations",
      (state: Record<string, unknown>) => {
        state.budget_status = "unknown";
        state.settled = { ...(state.settled as object), cost_microusd: null };
        state.reservations = [validRoutingReservation()];
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const state = validRoutingState();
    mutate(state);
    expect(parsedState(state)).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it("rejects input over two MiB", () => {
    expect(parseRoutingState(" ".repeat(2 * 1024 * 1024 + 1))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });
});

function parsedPlan(value: Record<string, unknown>) {
  return parseModelSelectionPlan(selectionPlanBytes(value));
}

describe("selection plan contract", () => {
  it("accepts planned and blocked variants, freezes them, and binds exact hashes", () => {
    const planned = validPlannedSelectionPlan();
    const parsedPlanned = parsedPlan(planned);
    expect(parsedPlanned).toMatchObject({
      ok: true,
      value: { document_hash: selectionPlanDocumentHash(planned) },
    });
    if (parsedPlanned.ok) {
      expect(Object.isFrozen(parsedPlanned.value)).toBe(true);
      expect(Object.isFrozen(parsedPlanned.value.eliminations)).toBe(true);
      expect(hashModelSelectionPlan(parsedPlanned.value)).toBe(selectionPlanDocumentHash(planned));
    }

    expect(parsedPlan(validBlockedSelectionPlan())).toMatchObject({ ok: true });
  });

  it("binds complete decision semantics without a state/plan hash cycle", () => {
    const plan = validPlannedSelectionPlan();
    const originalDecisionHash = selectionDecisionHash(plan);
    const changedNextState = { ...plan, next_state_hash: `sha256:${"a".repeat(64)}` };
    expect(selectionDecisionHash(changedNextState)).toBe(originalDecisionHash);
    expect(selectionPlanDocumentHash(changedNextState)).not.toBe(selectionPlanDocumentHash(plan));

    const semanticSubstitutions = [
      (candidate: Record<string, unknown>) => {
        const attempt = (candidate.worker_attempts as Record<string, unknown>[])[0] as Record<
          string,
          unknown
        >;
        candidate.worker_attempts = [{ ...attempt, latency_class: "extended" }];
      },
      (candidate: Record<string, unknown>) => {
        const attempt = (candidate.worker_attempts as Record<string, unknown>[])[0] as Record<
          string,
          unknown
        >;
        const routes = attempt.accepted_routes as Record<string, unknown>[];
        const route = routes[0] as Record<string, unknown>;
        candidate.worker_attempts = [
          {
            ...attempt,
            accepted_routes: [
              {
                ...route,
                pricing: {
                  ...(route.pricing as object),
                  input_microusd_per_million: 3_000_001,
                },
              },
              routes[1],
            ],
          },
        ];
      },
      (candidate: Record<string, unknown>) => {
        const attempt = (candidate.worker_attempts as Record<string, unknown>[])[0] as Record<
          string,
          unknown
        >;
        const requirement = { ...(attempt.requirement as object), tools: false };
        candidate.worker_attempts = [
          { ...attempt, requirement, requirement_hash: sha256(requirement) },
        ];
      },
      (candidate: Record<string, unknown>) => {
        candidate.eliminations = [{ entry_id: "economy-secondary", reason: "capability" }];
      },
    ];

    for (const mutate of semanticSubstitutions) {
      const substituted = validPlannedSelectionPlan();
      mutate(substituted);
      const result = parsedPlan(substituted);
      expect(result).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
      if (result.ok) continue;
      expect(
        result.issues.some(
          (issue) =>
            issue.path === "/reservation/decision_hash" && issue.keyword === "decisionBinding",
        ),
      ).toBe(true);
    }
  });

  it("rejects a mismatched final document hash", () => {
    const plan = validPlannedSelectionPlan();
    expect(
      parseModelSelectionPlan(
        JSON.stringify({ ...plan, document_hash: `sha256:${"f".repeat(64)}` }),
      ),
    ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it.each([
    [
      "duplicate plan attempt IDs",
      (plan: Record<string, unknown>) => {
        const attempt = (plan.worker_attempts as unknown[])[0];
        plan.worker_attempts = [attempt, { ...(attempt as object), fallback_index: 1 }];
      },
    ],
    [
      "out-of-order worker attempts",
      (plan: Record<string, unknown>) => {
        const attempt = (plan.worker_attempts as Record<string, unknown>[])[0];
        plan.worker_attempts = [
          { ...attempt, attempt_id: "attempt-worker-1", fallback_index: 1 },
          attempt,
        ];
      },
    ],
    [
      "duplicate accepted route IDs",
      (plan: Record<string, unknown>) => {
        const attempt = (plan.worker_attempts as Record<string, unknown>[])[0] as Record<
          string,
          unknown
        >;
        const route = (attempt.accepted_routes as unknown[])[0];
        plan.worker_attempts = [{ ...attempt, accepted_routes: [route, route] }];
      },
    ],
    [
      "duplicate elimination entry IDs",
      (plan: Record<string, unknown>) => {
        const elimination = (plan.eliminations as unknown[])[0];
        plan.eliminations = [elimination, elimination];
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const plan = validPlannedSelectionPlan();
    mutate(plan);
    expect(parsedPlan(plan)).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it("rejects an accepted route ID reused by a different attempt", () => {
    const plan = validPlannedSelectionPlan();
    const primary = (plan.worker_attempts as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
    const duplicateRoute = (primary.accepted_routes as Record<string, unknown>[])[0];
    const fallback = {
      ...primary,
      attempt_id: "attempt-worker-1",
      fallback_index: 1,
      entry_id: "balanced-secondary",
      accepted_routes: [duplicateRoute],
    };
    plan.worker_attempts = [primary, fallback];

    const reservation = plan.reservation as Record<string, unknown>;
    const primaryAllocation = (reservation.allocations as Record<string, unknown>[])[0];
    reservation.allocations = [
      primaryAllocation,
      {
        ...primaryAllocation,
        attempt_id: "attempt-worker-1",
        entry_id: "balanced-secondary",
      },
    ];
    reservation.decision_hash = selectionDecisionHash(plan);

    expect(parsedPlan(plan)).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });

  it("rejects blocked plans carrying attempts and planned plans lacking next state", () => {
    const blocked = validBlockedSelectionPlan();
    blocked.worker_attempts = [];
    expect(parsedPlan(blocked)).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });

    const planned = validPlannedSelectionPlan();
    delete planned.next_state_hash;
    expect(parsedPlan(planned)).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it("rejects unsafe elimination text or metadata", () => {
    const plan = validBlockedSelectionPlan();
    plan.eliminations = [
      {
        entry_id: "economy-secondary",
        reason: "latency",
        message: "provider token leaked",
        metadata: { endpoint: "https://provider.invalid" },
      },
    ];
    expect(parsedPlan(plan)).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });

  it("rejects input over two MiB", () => {
    expect(parseModelSelectionPlan(" ".repeat(2 * 1024 * 1024 + 1))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });
});
