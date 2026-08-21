import { describe, expect, it } from "vitest";

import {
  hashAgentgatewayCapabilities,
  parseAgentgatewayCapabilities,
  type AgentgatewayCapabilitiesV1,
} from "../src/gateway/index.js";
import { canonicalJson } from "../src/protocol/json.js";
import {
  hashExecutionRequest,
  parseExecutionRequest,
  type ExecutionRequestV1,
} from "../src/protocol/request.js";
import {
  parseModelCatalog,
  parseModelSelectionPlan,
  parseRoutingPolicy,
  parseRoutingState,
} from "../src/routing/contracts.js";
import { planModelSelection, type PlanModelSelectionInput } from "../src/routing/selection.js";
import { RuntimeRoutingError } from "../src/routing/errors.js";
import type {
  BlockedModelSelectionPlanV1,
  CatalogRouteV1,
  ModelCatalogEntryV1,
  ModelCatalogV1,
  PlannedModelSelectionPlanV1,
  RoutingCircuitV1,
  RoutingPolicyV1,
  RoutingStateV1,
  RoutingTaskProfile,
  TaskComplexity,
  TaskPhase,
  TaskRisk,
} from "../src/routing/types.js";
import {
  catalogBytes,
  policyBytes,
  pricing,
  providerCapabilities,
  routingStateBytes,
  validRoutingPolicy,
  validRoutingState,
} from "./helpers/routing-fixtures.js";

const DECISION_AT = "2026-08-21T12:00:00.000Z";
const SAFE_HASH = `sha256:${"a".repeat(64)}` as const;

function route(
  routeId: string,
  provider: "openai" | "anthropic" | "gemini",
  model: string,
  overrides: Partial<CatalogRouteV1> = {},
): CatalogRouteV1 {
  return {
    route_id: routeId,
    provider,
    model,
    capabilities: providerCapabilities(provider),
    latency_class: "standard",
    pricing: pricing(2_000_000, 200_000, 10_000_000, 12_000_000),
    ...overrides,
  };
}

function entry(
  entryId: string,
  alias: string,
  priority: number,
  routes: readonly CatalogRouteV1[],
  overrides: Partial<ModelCatalogEntryV1> = {},
): ModelCatalogEntryV1 {
  return {
    entry_id: entryId,
    logical_classes: ["balanced-code", "economy"],
    route_alias: alias,
    priority,
    routes,
    ...overrides,
  };
}

function defaultEntries(): readonly ModelCatalogEntryV1[] {
  return [
    entry("balanced-primary", "balanced-primary", 10, [
      route("route-primary-z", "openai", "gpt-5"),
      route("route-primary-a", "anthropic", "claude-sonnet-4-5", {
        pricing: pricing(3_000_000, 300_000, 15_000_000, 15_000_000),
      }),
    ]),
    entry("balanced-fallback-a", "balanced-fallback-a", 20, [
      route("route-fallback-a", "gemini", "gemini-2.5-pro"),
    ]),
    entry("balanced-fallback-b", "balanced-fallback-b", 30, [
      route("route-fallback-b", "anthropic", "claude-haiku-4-5"),
    ]),
    entry("economy-only", "economy-only", 1, [route("route-economy", "openai", "gpt-5-mini")], {
      logical_classes: ["economy"],
    }),
  ];
}

function catalog(entries: readonly ModelCatalogEntryV1[] = defaultEntries()): ModelCatalogV1 {
  const parsed = parseModelCatalog(
    catalogBytes({
      protocol_version: "runtime-contract.v1",
      schema_version: "model-catalog.v1",
      document_type: "model-catalog",
      catalog_id: "catalog-production",
      revision: 7,
      entries,
    }),
  );
  if (!parsed.ok) throw new Error(`invalid catalog fixture: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}

function policy(): RoutingPolicyV1 {
  const parsed = parseRoutingPolicy(policyBytes(validRoutingPolicy()));
  if (!parsed.ok) throw new Error(`invalid policy fixture: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}

function request(
  overrides: Partial<ExecutionRequestV1> = {},
  model: Partial<ExecutionRequestV1["model"]> = {},
): ExecutionRequestV1 {
  const value: ExecutionRequestV1 = {
    protocol_version: "runtime-contract.v1",
    schema_version: "execution-request.v1",
    document_type: "execution-request",
    request_id: "request-selection-1",
    run_id: "run-selection-1",
    created_at: "2026-08-21T11:00:00.000Z",
    deadline: "2026-08-21T13:00:00.000Z",
    task_contract: {
      document_type: "task-contract",
      artifact_id: "task-selection-1",
      revision: 1,
      hash: SAFE_HASH,
    },
    input_artifacts: [],
    agent: {
      definition: {
        document_type: "agent-definition",
        artifact_id: "agent-worker",
        revision: 1,
        hash: `sha256:${"b".repeat(64)}`,
      },
      role: "worker",
    },
    model: {
      logical_class: "balanced-code",
      required_capabilities: ["json-schema", "text", "tools"],
      ...model,
    },
    superpowers: { required: ["test-driven-development"] },
    mcp: {
      profile: {
        document_type: "mcp-profile",
        artifact_id: "mcp-readonly",
        revision: 1,
        hash: `sha256:${"c".repeat(64)}`,
      },
    },
    budget: {
      max_input_tokens: 200_000,
      max_output_tokens: 32_768,
      max_cost_microusd: 5_000_000,
      max_duration_ms: 900_000,
      max_turns: 16,
    },
    review_policy: {
      document_type: "review-policy",
      artifact_id: "review-medium",
      revision: 1,
      hash: `sha256:${"d".repeat(64)}`,
    },
    output: {
      schema: {
        document_type: "output-schema",
        artifact_id: "output-selection",
        revision: 1,
        hash: `sha256:${"e".repeat(64)}`,
      },
    },
    trace: {
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      trace_flags: 1,
    },
    ...overrides,
  };
  const parsed = parseExecutionRequest(canonicalJson(value));
  if (!parsed.ok) throw new Error(`invalid request fixture: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}

function live(
  entries: readonly ModelCatalogEntryV1[],
  mutate: (value: AgentgatewayCapabilitiesV1) => AgentgatewayCapabilitiesV1 = (value) => value,
): AgentgatewayCapabilitiesV1 {
  const routes = entries.flatMap((catalogEntry) =>
    catalogEntry.routes.map((catalogRoute) => ({
      alias: catalogEntry.route_alias,
      route_id: catalogRoute.route_id,
      provider: catalogRoute.provider,
      model: catalogRoute.model,
      capabilities: { ...catalogRoute.capabilities },
    })),
  );
  const withoutHash = {
    protocol_version: "runtime-contract.v1",
    schema_version: "agentgateway-capabilities.v1",
    document_type: "agentgateway-capabilities",
    gateway: { name: "agentgateway", version: "0.10.0", revision: 11 },
    generated_at: "2026-08-21T11:59:00.000Z",
    expires_at: "2026-08-21T12:04:00.000Z",
    routes,
  } as const;
  const initial = {
    ...withoutHash,
    document_hash: hashAgentgatewayCapabilities({
      ...withoutHash,
      document_hash: `sha256:${"0".repeat(64)}`,
    }),
  } as AgentgatewayCapabilitiesV1;
  const changed = mutate(structuredClone(initial));
  const candidate = {
    ...changed,
    document_hash: hashAgentgatewayCapabilities(changed),
  } as AgentgatewayCapabilitiesV1;
  const parsed = parseAgentgatewayCapabilities(canonicalJson(candidate), {
    now: () => new Date(DECISION_AT),
  });
  if (!parsed.ok) throw new Error(`invalid live fixture: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}

function state(input: {
  readonly request: ExecutionRequestV1;
  readonly catalog: ModelCatalogV1;
  readonly policy: RoutingPolicyV1;
  readonly circuits?: readonly RoutingCircuitV1[];
  readonly budget?: RoutingStateV1["budget"];
  readonly budget_status?: RoutingStateV1["budget_status"];
}): RoutingStateV1 {
  const base = validRoutingState();
  const budgetStatus = input.budget_status ?? "known";
  const parsed = parseRoutingState(
    routingStateBytes({
      ...base,
      state_id: "routing-selection-1",
      run_id: input.request.run_id,
      request_hash: hashExecutionRequest(input.request),
      catalog_hash: input.catalog.document_hash,
      policy_hash: input.policy.document_hash,
      budget: input.budget ?? input.request.budget,
      budget_status: budgetStatus,
      settled: {
        input_tokens: 0,
        output_tokens: 0,
        cost_microusd: budgetStatus === "known" ? 0 : null,
        duration_ms: 0,
        turns: 0,
      },
      reservations: [],
      circuits: [...(input.circuits ?? [])].sort((left, right) =>
        left.entry_id < right.entry_id ? -1 : left.entry_id > right.entry_id ? 1 : 0,
      ),
    }),
  );
  if (!parsed.ok) throw new Error(`invalid state fixture: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}

function fixture(
  options: {
    readonly entries?: readonly ModelCatalogEntryV1[];
    readonly request?: ExecutionRequestV1;
    readonly task?: Partial<RoutingTaskProfile>;
    readonly circuits?: readonly RoutingCircuitV1[];
    readonly budget?: RoutingStateV1["budget"];
    readonly budget_status?: RoutingStateV1["budget_status"];
    readonly mutateLive?: (value: AgentgatewayCapabilitiesV1) => AgentgatewayCapabilitiesV1;
    readonly decision_at?: string;
  } = {},
): PlanModelSelectionInput {
  const entries = options.entries ?? defaultEntries();
  const selectedRequest =
    options.request ?? request(options.budget === undefined ? {} : { budget: options.budget });
  const selectedCatalog = catalog(entries);
  const selectedPolicy = policy();
  return {
    request: selectedRequest,
    task: {
      task_contract: selectedRequest.task_contract,
      phase: "implementation",
      complexity: "medium",
      risks: [],
      max_latency_class: "standard",
      ...options.task,
    },
    ceilings: {
      max_input_tokens: 20_000,
      max_output_tokens: 4_000,
      max_duration_ms: 120_000,
    },
    catalog: selectedCatalog,
    policy: selectedPolicy,
    state: state({
      request: selectedRequest,
      catalog: selectedCatalog,
      policy: selectedPolicy,
      ...(options.circuits === undefined ? {} : { circuits: options.circuits }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.budget_status === undefined ? {} : { budget_status: options.budget_status }),
    }),
    live: live(entries, options.mutateLive),
    gateway_profile: "gateway-primary",
    decision_at: options.decision_at ?? DECISION_AT,
  };
}

function planned(input: PlanModelSelectionInput): PlannedModelSelectionPlanV1 {
  const result = planModelSelection(input);
  expect(result.status).toBe("planned");
  if (result.status !== "planned")
    throw new Error(`expected planned, got ${result.plan.block_code}`);
  return result.plan;
}

function blocked(input: PlanModelSelectionInput): BlockedModelSelectionPlanV1 {
  const result = planModelSelection(input);
  expect(result.status).toBe("blocked");
  if (result.status !== "blocked") throw new Error("expected blocked plan");
  expect(result.next_state).toBeNull();
  return result.plan;
}

function selectedEntryIds(plan: PlannedModelSelectionPlanV1): readonly string[] {
  return plan.worker_attempts.map((attempt) => attempt.entry_id);
}

describe("deterministic worker selection", () => {
  it("plans the primary and every allowed capability-equivalent fallback atomically", () => {
    const input = fixture();
    const result = planModelSelection(input);
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;

    expect(selectedEntryIds(result.plan)).toEqual([
      "balanced-primary",
      "balanced-fallback-a",
      "balanced-fallback-b",
    ]);
    expect(result.plan.worker_attempts[0]?.accepted_routes.map((value) => value.route_id)).toEqual([
      "route-primary-a",
      "route-primary-z",
    ]);
    expect(result.plan.worker_attempts.map((attempt) => attempt.fallback_index)).toEqual([0, 1, 2]);
    expect(result.plan.reservation.allocations.map((value) => value.attempt_id)).toEqual(
      [...result.plan.reservation.allocations]
        .map((value) => value.attempt_id)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    expect(result.plan.reservation.allocations).toHaveLength(3);
    expect(result.next_state.reservations).toEqual([result.plan.reservation]);
    expect(result.next_state.document_hash).toBe(result.plan.next_state_hash);
    expect(parseModelSelectionPlan(canonicalJson(result.plan))).toEqual({
      ok: true,
      value: result.plan,
    });
    expect(planModelSelection(input)).toEqual(result);
    expect(Object.isFrozen(result.plan)).toBe(true);
  });

  it.each([
    [
      "priority",
      [
        entry("z-entry", "z-entry", 20, [route("route-z", "openai", "gpt-5")]),
        entry("a-entry", "a-entry", 10, [route("route-a", "openai", "gpt-5")]),
      ],
      "a-entry",
    ],
    [
      "cost",
      [
        entry("expensive", "expensive", 10, [
          route("route-expensive", "openai", "gpt-5", {
            pricing: pricing(9_000_000, 9_000_000, 9_000_000, 9_000_000),
          }),
        ]),
        entry("cheap", "cheap", 10, [
          route("route-cheap", "openai", "gpt-5", { pricing: pricing(1, 1, 1, 1) }),
        ]),
      ],
      "cheap",
    ],
    [
      "latency",
      [
        entry("standard", "standard", 10, [route("route-standard", "openai", "gpt-5")]),
        entry("interactive", "interactive", 10, [
          route("route-interactive", "openai", "gpt-5", { latency_class: "interactive" }),
        ]),
      ],
      "interactive",
    ],
    [
      "ASCII entry ID",
      [
        entry("z-entry", "z-entry", 10, [route("route-z", "openai", "gpt-5")]),
        entry("A-entry", "A-entry", 10, [route("route-a", "openai", "gpt-5")]),
      ],
      "A-entry",
    ],
  ] as const)("uses stable %s tie-breaking", (_name, entries, expected) => {
    expect(planned(fixture({ entries })).worker_attempts[0]?.entry_id).toBe(expected);
  });

  it("uses the first matched worker-class preference as the leading sort key", () => {
    const visionRequest = request({}, { logical_class: "vision" });
    const entries = [
      entry(
        "balanced-vision",
        "balanced-vision",
        50,
        [route("route-balanced", "openai", "gpt-5")],
        {
          logical_classes: ["balanced-code", "vision"],
        },
      ),
      entry("economy-vision", "economy-vision", 1, [route("route-economy", "openai", "gpt-5")], {
        logical_classes: ["economy", "vision"],
      }),
    ];
    expect(planned(fixture({ entries, request: visionRequest })).worker_attempts[0]?.entry_id).toBe(
      "balanced-vision",
    );
  });

  it.each([
    ["analysis", "low", []],
    ["review", "critical", []],
    ["implementation", "medium", []],
  ] as readonly [TaskPhase, TaskComplexity, readonly TaskRisk[]][])(
    "matches phase %s, complexity %s, and the exact risk set",
    (phase, complexity, risks) => {
      expect(planned(fixture({ task: { phase, complexity, risks } })).matched_rule_id).toBe(
        "non-risk-default",
      );
    },
  );

  it("matches the exact high-security rule and fails closed until reviewer pairing exists", () => {
    const deepRequest = request({}, { logical_class: "deep-reasoning" });
    const entries = [
      entry("deep-worker", "deep-worker", 1, [route("route-deep", "openai", "gpt-5")], {
        logical_classes: ["deep-reasoning"],
      }),
    ];
    const plan = blocked(
      fixture({
        entries,
        request: deepRequest,
        task: { complexity: "high", risks: ["security"] },
      }),
    );
    expect(plan).toMatchObject({
      matched_rule_id: "security-review",
      block_code: "RUNTIME_ROUTING_REVIEW_UNAVAILABLE",
    });
  });
});

describe("effective catalog/live capability authority", () => {
  it.each([
    [
      "route ID",
      (liveValue: AgentgatewayCapabilitiesV1) => ({
        ...liveValue,
        routes: liveValue.routes.map((value, index) =>
          index === 0 ? { ...value, route_id: "other-route" } : value,
        ),
      }),
    ],
    [
      "provider",
      (liveValue: AgentgatewayCapabilitiesV1) => ({
        ...liveValue,
        routes: liveValue.routes.map((value, index) =>
          index === 0
            ? {
                ...value,
                provider: "openai" as const,
                capabilities: { ...value.capabilities, provider: "openai" as const },
              }
            : value,
        ),
      }),
    ],
    [
      "model",
      (liveValue: AgentgatewayCapabilitiesV1) => ({
        ...liveValue,
        routes: liveValue.routes.map((value, index) =>
          index === 0 ? { ...value, model: "other-model" } : value,
        ),
      }),
    ],
  ] as const)("requires the exact live %s identity", (_name, mutateLive) => {
    const entries = [defaultEntries()[1]!];
    expect(blocked(fixture({ entries, mutateLive })).block_code).toBe(
      "RUNTIME_ROUTING_NO_CAPABLE_ROUTE",
    );
  });

  it.each([
    [
      "tools",
      (capabilities: CatalogRouteV1["capabilities"]) => ({ ...capabilities, tools: false }),
    ],
    [
      "json-schema",
      (capabilities: CatalogRouteV1["capabilities"]) => ({ ...capabilities, json_schema: false }),
    ],
    [
      "output",
      (capabilities: CatalogRouteV1["capabilities"]) => ({
        ...capabilities,
        max_output_tokens: 3_999,
      }),
    ],
    [
      "context",
      (capabilities: CatalogRouteV1["capabilities"]) => ({
        ...capabilities,
        max_context_tokens: 23_999,
      }),
    ],
  ] as const)("allows live authority to remove %s capability but never add it", (_name, weaken) => {
    const entries = [defaultEntries()[1]!];
    const mutateLive = (liveValue: AgentgatewayCapabilitiesV1): AgentgatewayCapabilitiesV1 => ({
      ...liveValue,
      routes: liveValue.routes.map((value) => ({
        ...value,
        capabilities: weaken(value.capabilities),
      })),
    });
    expect(blocked(fixture({ entries, mutateLive })).eliminations).toEqual([
      { entry_id: "balanced-fallback-a", reason: "capability" },
    ]);
  });

  it("does not let a stronger live route restore a capability denied by the catalog", () => {
    const denied = entry("catalog-denied", "catalog-denied", 1, [
      route("route-denied", "openai", "gpt-5", {
        capabilities: { ...providerCapabilities("openai"), tools: false },
      }),
    ]);
    const mutateLive = (liveValue: AgentgatewayCapabilitiesV1): AgentgatewayCapabilitiesV1 => ({
      ...liveValue,
      routes: liveValue.routes.map((value) => ({
        ...value,
        capabilities: { ...value.capabilities, tools: true },
      })),
    });
    expect(blocked(fixture({ entries: [denied], mutateLive })).eliminations).toEqual([
      { entry_id: "catalog-denied", reason: "capability" },
    ]);
  });

  it("enforces the stricter task/policy latency ceiling", () => {
    const slow = entry("slow-entry", "slow-entry", 1, [
      route("route-slow", "openai", "gpt-5", { latency_class: "extended" }),
    ]);
    expect(
      blocked(fixture({ entries: [slow], task: { max_latency_class: "extended" } })).eliminations,
    ).toEqual([{ entry_id: "slow-entry", reason: "latency" }]);
  });

  it.each([
    ["unsupported logical class", request({}, { logical_class: "marketing-ultra" })],
    ["unsupported capability", request({}, { required_capabilities: ["native-secret"] })],
  ])("denies %s without widening authority", (_name, selectedRequest) => {
    expect(blocked(fixture({ request: selectedRequest })).block_code).toBe(
      "RUNTIME_ROUTING_POLICY_DENIED",
    );
  });
});

describe("circuit, budget, and stale-state blocking", () => {
  it("excludes an open primary and selects the next closed candidate", () => {
    const plan = planned(
      fixture({
        circuits: [
          {
            entry_id: "balanced-primary",
            status: "open",
            consecutive_failures: 3,
            retry_at: "2026-08-21T12:01:00.000Z",
            probe_decision_id: null,
          },
        ],
      }),
    );
    expect(plan.worker_attempts[0]?.entry_id).toBe("balanced-fallback-a");
    expect(plan.eliminations).toContainEqual({ entry_id: "balanced-primary", reason: "circuit" });
  });

  it("returns the earliest fixed retry time when every capable circuit is open", () => {
    const entries = defaultEntries().slice(0, 3);
    const circuits: readonly RoutingCircuitV1[] = entries.map((value, index) => ({
      entry_id: value.entry_id,
      status: "open",
      consecutive_failures: 3,
      retry_at: `2026-08-21T12:0${index + 1}:00.000Z`,
      probe_decision_id: null,
    }));
    expect(blocked(fixture({ entries, circuits }))).toMatchObject({
      block_code: "RUNTIME_ROUTING_CIRCUIT_OPEN",
      retryable: true,
      next_retry_at: "2026-08-21T12:01:00.000Z",
    });
  });

  it("does not advertise circuit retry for an open route that lacks required capability", () => {
    const entries = [defaultEntries()[1]!];
    const input = fixture({
      entries,
      circuits: [
        {
          entry_id: "balanced-fallback-a",
          status: "open",
          consecutive_failures: 3,
          retry_at: "2026-08-21T12:01:00.000Z",
          probe_decision_id: null,
        },
      ],
      mutateLive: (value) => ({
        ...value,
        routes: value.routes.map((routeValue) => ({
          ...routeValue,
          capabilities: { ...routeValue.capabilities, tools: false },
        })),
      }),
    });

    expect(blocked(input)).toMatchObject({
      block_code: "RUNTIME_ROUTING_NO_CAPABLE_ROUTE",
      next_retry_at: null,
      eliminations: [{ entry_id: "balanced-fallback-a", reason: "capability" }],
    });
  });

  it("atomically reserves one cooldown-expired primary as the only half-open probe", () => {
    const entries = defaultEntries().slice(0, 3);
    const input = fixture({
      entries,
      circuits: [
        {
          entry_id: "balanced-primary",
          status: "open",
          consecutive_failures: 3,
          retry_at: DECISION_AT,
          probe_decision_id: null,
        },
        {
          entry_id: "balanced-fallback-a",
          status: "open",
          consecutive_failures: 2,
          retry_at: "2026-08-21T11:59:00.000Z",
          probe_decision_id: null,
        },
      ],
    });
    const result = planModelSelection(input);
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(selectedEntryIds(result.plan)).toEqual(["balanced-primary", "balanced-fallback-b"]);
    expect(result.next_state.circuits).toContainEqual({
      entry_id: "balanced-primary",
      status: "probe-reserved",
      consecutive_failures: 3,
      retry_at: DECISION_AT,
      probe_decision_id: result.plan.decision_id,
    });
    expect(result.next_state.circuits).toContainEqual(
      input.state.circuits.find((value) => value.entry_id === "balanced-fallback-a"),
    );
  });

  it("blocks the same probe on the exact reserved head", () => {
    const firstInput = fixture({
      entries: [defaultEntries()[0]!],
      circuits: [
        {
          entry_id: "balanced-primary",
          status: "open",
          consecutive_failures: 3,
          retry_at: DECISION_AT,
          probe_decision_id: null,
        },
      ],
    });
    const first = planModelSelection(firstInput);
    expect(first.status).toBe("planned");
    if (first.status !== "planned") return;
    const second = planModelSelection({ ...firstInput, state: first.next_state });
    expect(second.status).toBe("blocked");
    if (second.status === "blocked")
      expect(second.plan.block_code).toBe("RUNTIME_ROUTING_STALE_STATE");
  });

  it("blocks the full primary-plus-fallback reservation when any budget dimension is exceeded", () => {
    expect(
      blocked(
        fixture({
          entries: defaultEntries().slice(0, 3),
          budget: {
            max_input_tokens: 59_999,
            max_output_tokens: 12_000,
            max_cost_microusd: 5_000_000,
            max_duration_ms: 360_000,
            max_turns: 3,
          },
        }),
      ).block_code,
    ).toBe("RUNTIME_ROUTING_BUDGET_EXCEEDED");
  });

  it("blocks unknown usage without mutating the supplied state", () => {
    const input = fixture({ budget_status: "unknown" });
    const before = canonicalJson(input.state);
    expect(blocked(input).block_code).toBe("RUNTIME_ROUTING_USAGE_UNKNOWN");
    expect(canonicalJson(input.state)).toBe(before);
  });

  it.each([
    [
      "request",
      (input: PlanModelSelectionInput) => ({
        ...input,
        state: { ...input.state, request_hash: `sha256:${"f".repeat(64)}` as const },
      }),
    ],
    [
      "catalog",
      (input: PlanModelSelectionInput) => ({
        ...input,
        state: { ...input.state, catalog_hash: `sha256:${"f".repeat(64)}` as const },
      }),
    ],
    [
      "policy",
      (input: PlanModelSelectionInput) => ({
        ...input,
        state: { ...input.state, policy_hash: `sha256:${"f".repeat(64)}` as const },
      }),
    ],
    [
      "run",
      (input: PlanModelSelectionInput) => ({
        ...input,
        state: { ...input.state, run_id: "other-run" },
      }),
    ],
  ] as const)("returns a non-mutating stale plan for a stale %s binding", (_name, mutate) => {
    const input = fixture();
    const stale = mutate(input) as PlanModelSelectionInput;
    expect(blocked(stale).block_code).toBe("RUNTIME_ROUTING_STALE_STATE");
  });

  it("blocks an expired live document at its half-open boundary", () => {
    expect(blocked(fixture({ decision_at: "2026-08-21T12:04:00.000Z" })).block_code).toBe(
      "RUNTIME_ROUTING_STALE_STATE",
    );
  });

  it("blocks a request at its exact deadline while live capabilities remain fresh", () => {
    const deadlineRequest = request({ deadline: DECISION_AT });
    expect(blocked(fixture({ request: deadlineRequest })).block_code).toBe(
      "RUNTIME_ROUTING_STALE_STATE",
    );
  });
});

describe("canonical explanations and exact authoritative bindings", () => {
  it.each(["task", "ceilings"] as const)("rejects an unknown %s input field", (target) => {
    const input = fixture();
    const operation = () =>
      planModelSelection(
        target === "task"
          ? {
              ...input,
              task: { ...input.task, prompt: "must-not-be-accepted" } as RoutingTaskProfile,
            }
          : {
              ...input,
              ceilings: {
                ...input.ceilings,
                native_limit: 1,
              } as PlanModelSelectionInput["ceilings"],
            },
      );

    expect(operation).toThrowError(RuntimeRoutingError);
    try {
      operation();
    } catch (error) {
      expect(error).toMatchObject({ code: "RUNTIME_ROUTING_INVALID" });
    }
  });

  it("accounts for every catalog entry exactly once as selected or eliminated", () => {
    const plan = planned(fixture());
    const accounted = [
      ...plan.worker_attempts.map((value) => value.entry_id),
      ...plan.eliminations.map((value) => value.entry_id),
    ].sort();
    expect(accounted).toEqual(
      defaultEntries()
        .map((value) => value.entry_id)
        .sort(),
    );
    expect(new Set(accounted).size).toBe(accounted.length);
    expect(plan.eliminations).toEqual(
      [...plan.eliminations].sort((left, right) =>
        left.entry_id < right.entry_id ? -1 : left.entry_id > right.entry_id ? 1 : 0,
      ),
    );
  });

  it("preserves semantic selection across array permutations while rebinding exact hashes", () => {
    const originalEntries = defaultEntries();
    const original = fixture({ entries: originalEntries });
    const originalPlan = planned(original);
    const permutedEntries = [...originalEntries]
      .reverse()
      .map((value) => ({ ...value, routes: [...value.routes].reverse() }));
    const permuted = fixture({
      entries: permutedEntries,
    });
    const permutedPlan = planned(permuted);

    expect(selectedEntryIds(permutedPlan)).toEqual(selectedEntryIds(originalPlan));
    expect(permutedPlan.eliminations).toEqual(originalPlan.eliminations);
    expect(permutedPlan.catalog_hash).not.toBe(originalPlan.catalog_hash);
    expect(permutedPlan.capability_document_hash).not.toBe(originalPlan.capability_document_hash);
    expect(permutedPlan.decision_id).not.toBe(originalPlan.decision_id);
    expect(permutedPlan.document_hash).not.toBe(originalPlan.document_hash);
    expect(permutedPlan.next_state_hash).not.toBe(originalPlan.next_state_hash);
  });

  it("keeps blocked output fixed, bounded, and non-reflective", () => {
    const input = fixture({
      entries: [defaultEntries()[1]!],
      mutateLive: (value) => ({
        ...value,
        routes: value.routes.map((routeValue) => ({
          ...routeValue,
          model: "native-secret-model",
        })),
      }),
    });
    const plan = blocked(input);
    const serialized = JSON.stringify(plan);
    expect(plan).toMatchObject({
      block_code: "RUNTIME_ROUTING_NO_CAPABLE_ROUTE",
      retryable: false,
      next_retry_at: null,
    });
    expect(serialized).not.toContain("native-secret-model");
    expect(serialized).not.toContain("endpoint");
    expect(serialized).not.toContain("header");
    expect(serialized).not.toContain("prompt");
    expect(serialized.length).toBeLessThan(2 * 1024 * 1024);
  });
});
