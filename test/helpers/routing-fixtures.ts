import {
  hashAgentgatewayCapabilities,
  parseAgentgatewayCapabilities,
  type AgentgatewayCapabilitiesV1,
} from "../../src/gateway/index.js";
import { canonicalJson, sha256 } from "../../src/protocol/json.js";
import {
  hashExecutionRequest,
  parseExecutionRequest,
  type ExecutionRequestV1,
} from "../../src/protocol/request.js";
import type {
  ProviderAdapterCapabilities,
  ProviderKind,
  ProviderRouteIdentity,
} from "../../src/providers/types.js";
import {
  parseModelCatalog,
  parseRoutingPolicy,
  parseRoutingState,
} from "../../src/routing/contracts.js";
import type {
  CatalogRouteV1,
  ModelCatalogEntryV1,
  ModelCatalogV1,
  PlanModelSelectionInput,
  PlannedModelSelectionPlanV1,
  RoutingCircuitV1,
  RoutingPolicyV1,
  RoutingStateV1,
} from "../../src/routing/types.js";

export function providerCapabilities(provider: ProviderKind): ProviderAdapterCapabilities {
  return {
    provider,
    tools: true,
    json_schema: true,
    vision: false,
    reasoning: true,
    streaming: true,
    max_context_tokens: 200_000,
    max_output_tokens: 16_384,
  };
}

export function pricing(
  input: number,
  cachedInput: number,
  output: number,
  reasoningOutput: number,
) {
  return {
    input_microusd_per_million: input,
    cached_input_microusd_per_million: cachedInput,
    output_microusd_per_million: output,
    reasoning_output_microusd_per_million: reasoningOutput,
  };
}

export function catalogDocumentHash(value: Record<string, unknown>): `sha256:${string}` {
  const hashable = { ...value };
  delete hashable.document_hash;
  return sha256(hashable);
}

export function catalogBytes(value: Record<string, unknown>): string {
  return canonicalJson({ ...value, document_hash: catalogDocumentHash(value) });
}

export function policyDocumentHash(value: Record<string, unknown>): `sha256:${string}` {
  const hashable = { ...value };
  delete hashable.document_hash;
  return sha256(hashable);
}

export function policyBytes(value: Record<string, unknown>): string {
  return canonicalJson({ ...value, document_hash: policyDocumentHash(value) });
}

export function overrideValueHash(value: Record<string, unknown>): `sha256:${string}` {
  return sha256(value);
}

export function validCatalog(): Record<string, unknown> {
  return {
    protocol_version: "runtime-contract.v1",
    schema_version: "model-catalog.v1",
    document_type: "model-catalog",
    catalog_id: "catalog-production",
    revision: 7,
    entries: [
      {
        entry_id: "balanced-primary",
        logical_classes: ["balanced-code", "economy"],
        route_alias: "balanced-code",
        priority: 10,
        routes: [
          {
            route_id: "balanced-anthropic",
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            capabilities: providerCapabilities("anthropic"),
            latency_class: "standard",
            pricing: pricing(3_000_000, 300_000, 15_000_000, 15_000_000),
          },
          {
            route_id: "balanced-openai",
            provider: "openai",
            model: "gpt-5",
            capabilities: providerCapabilities("openai"),
            latency_class: "standard",
            pricing: pricing(2_000_000, 200_000, 10_000_000, 12_000_000),
          },
        ],
      },
    ],
  };
}

export function validRoutingPolicy(): Record<string, unknown> {
  return {
    protocol_version: "runtime-contract.v1",
    schema_version: "routing-policy.v1",
    document_type: "routing-policy",
    policy_id: "routing-production",
    revision: 3,
    rules: [
      {
        rule_id: "non-risk-default",
        priority: 10,
        match: { phase: "*", complexity: "*", risks: [] },
        worker_class_preference: ["balanced-code", "economy"],
        required_capabilities: ["json-schema", "text"],
        max_latency_class: "standard",
        review: "none",
        max_fallbacks: 2,
        circuit: { consecutive_failure_threshold: 3, cooldown_ms: 60_000 },
      },
      {
        rule_id: "security-review",
        priority: 5,
        match: { phase: "implementation", complexity: "high", risks: ["security"] },
        worker_class_preference: ["deep-reasoning"],
        required_capabilities: ["reasoning", "tools"],
        max_latency_class: "extended",
        review: "independent",
        max_fallbacks: 1,
        circuit: { consecutive_failure_threshold: 2, cooldown_ms: 120_000 },
      },
      {
        rule_id: "risk-default",
        priority: 20,
        match: { phase: "*", complexity: "*", risks: "*" },
        worker_class_preference: ["deep-reasoning", "balanced-code"],
        required_capabilities: ["reasoning"],
        max_latency_class: "extended",
        review: "independent",
        max_fallbacks: 3,
        circuit: { consecutive_failure_threshold: 3, cooldown_ms: 60_000 },
      },
    ],
  };
}

export function validRoutingOverride(): Record<string, unknown> {
  return {
    version: "routing-override.v1",
    override_id: "override-incident-1",
    issued_at: "2026-08-21T12:00:00.000Z",
    catalog_hash: `sha256:${"a".repeat(64)}`,
    policy_hash: `sha256:${"b".repeat(64)}`,
    target_entry_id: "balanced-primary",
    reason_code: "incident-mitigation",
  };
}

export function routingStateDocumentHash(value: Record<string, unknown>): `sha256:${string}` {
  const { document_hash: _documentHash, ...hashable } = value;
  void _documentHash;
  return sha256(hashable);
}

export function routingStateBytes(value: Record<string, unknown>): string {
  return canonicalJson({ ...value, document_hash: routingStateDocumentHash(value) });
}

export function validRoutingState(): Record<string, unknown> {
  return {
    protocol_version: "runtime-contract.v1",
    schema_version: "routing-state.v1",
    document_type: "routing-state",
    state_id: "routing-run-1",
    revision: 1,
    previous_state_hash: null,
    run_id: "run-1",
    request_hash: `sha256:${"1".repeat(64)}`,
    catalog_hash: `sha256:${"2".repeat(64)}`,
    policy_hash: `sha256:${"3".repeat(64)}`,
    budget: {
      max_input_tokens: 200_000,
      max_output_tokens: 32_768,
      max_cost_microusd: 5_000_000,
      max_duration_ms: 900_000,
      max_turns: 16,
    },
    settled: {
      input_tokens: 0,
      output_tokens: 0,
      cost_microusd: 0,
      duration_ms: 0,
      turns: 0,
    },
    budget_status: "known",
    reservations: [],
    circuits: [],
  };
}

export function validRoutingReservation(): Record<string, unknown> {
  return {
    decision_id: "decision-1",
    decision_hash: `sha256:${"4".repeat(64)}`,
    request_id: "request-1",
    allocations: [
      {
        attempt_id: "attempt-worker-0",
        entry_id: "balanced-primary",
        role: "worker",
        input_tokens: 20_000,
        output_tokens: 4_000,
        cost_microusd: 100_000,
        duration_ms: 120_000,
        turns: 1,
      },
    ],
    created_at: "2026-08-21T12:00:00.000Z",
  };
}

export function selectionPlanDocumentHash(value: Record<string, unknown>): `sha256:${string}` {
  const { document_hash: _documentHash, ...hashable } = value;
  void _documentHash;
  return sha256(hashable);
}

export function selectionDecisionHash(value: Record<string, unknown>): `sha256:${string}` {
  const {
    document_hash: _documentHash,
    next_state_revision: _nextStateRevision,
    next_state_hash: _nextStateHash,
    reservation,
    ...decision
  } = value;
  void _documentHash;
  void _nextStateRevision;
  void _nextStateHash;
  const { decision_hash: _decisionHash, ...reservationWithoutDecisionHash } = reservation as Record<
    string,
    unknown
  >;
  void _decisionHash;
  return sha256({ ...decision, reservation: reservationWithoutDecisionHash });
}

export function selectionPlanBytes(value: Record<string, unknown>): string {
  return canonicalJson({ ...value, document_hash: selectionPlanDocumentHash(value) });
}

function validAttempt(): Record<string, unknown> {
  const requirement = {
    schema_version: "gateway-route-requirement.v1",
    alias: "balanced-code",
    tools: true,
    json_schema: true,
    vision: false,
    reasoning: true,
    streaming: true,
    max_output_tokens: 4_000,
  };
  return {
    attempt_id: "attempt-worker-0",
    role: "worker",
    fallback_index: 0,
    entry_id: "balanced-primary",
    alias: "balanced-code",
    gateway_profile: "gateway-primary",
    gateway_revision: 11,
    capability_document_hash: `sha256:${"5".repeat(64)}`,
    latency_class: "standard",
    requirement,
    requirement_hash: sha256(requirement),
    accepted_routes: [
      {
        route_id: "balanced-anthropic",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        pricing: pricing(3_000_000, 300_000, 15_000_000, 15_000_000),
      },
      {
        route_id: "balanced-openai",
        provider: "openai",
        model: "gpt-5",
        pricing: pricing(2_000_000, 200_000, 10_000_000, 12_000_000),
      },
    ],
    reserved_cost_microusd: 100_000,
  };
}

function planBindings(): Record<string, unknown> {
  return {
    protocol_version: "runtime-contract.v1",
    schema_version: "model-selection-plan.v1",
    document_type: "model-selection-plan",
    decision_id: "decision-1",
    revision: 1,
    run_id: "run-1",
    request_id: "request-1",
    request_hash: `sha256:${"1".repeat(64)}`,
    task_contract: {
      document_type: "task-contract",
      artifact_id: "task-1",
      revision: 2,
      hash: `sha256:${"6".repeat(64)}`,
    },
    catalog_id: "catalog-production",
    catalog_revision: 7,
    catalog_hash: `sha256:${"2".repeat(64)}`,
    policy_id: "routing-production",
    policy_revision: 3,
    policy_hash: `sha256:${"3".repeat(64)}`,
    prior_state_id: "routing-run-1",
    prior_state_revision: 1,
    prior_state_hash: `sha256:${"7".repeat(64)}`,
    gateway_profile: "gateway-primary",
    gateway_revision: 11,
    capability_document_hash: `sha256:${"5".repeat(64)}`,
    override: null,
    decision_at: "2026-08-21T12:00:00.000Z",
    matched_rule_id: "non-risk-default",
    eliminations: [{ entry_id: "economy-secondary", reason: "latency" }],
  };
}

export function validPlannedSelectionPlan(): Record<string, unknown> {
  const attempt = validAttempt();
  const allocation = (validRoutingReservation().allocations as unknown[])[0];
  const reservation = {
    ...validRoutingReservation(),
    allocations: [allocation],
    decision_hash: `sha256:${"0".repeat(64)}`,
  };
  const plan = {
    ...planBindings(),
    status: "planned",
    request_deadline: "2026-08-21T13:00:00.000Z",
    live_expires_at: "2026-08-21T12:04:00.000Z",
    worker_attempts: [attempt],
    reviewer_attempt: null,
    reservation,
    next_state_revision: 2,
    next_state_hash: `sha256:${"8".repeat(64)}`,
  };
  reservation.decision_hash = selectionDecisionHash(plan);
  return plan;
}

export function validBlockedSelectionPlan(): Record<string, unknown> {
  return {
    ...planBindings(),
    status: "blocked",
    block_code: "RUNTIME_ROUTING_CIRCUIT_OPEN",
    retryable: true,
    next_retry_at: "2026-08-21T12:01:00.000Z",
  };
}

export interface RoutingInputFixture {
  readonly input: PlanModelSelectionInput;
  readonly catalog: ModelCatalogV1;
  readonly policy: RoutingPolicyV1;
  readonly prior_state: RoutingStateV1;
}

export interface PlannedRoutingFixture extends RoutingInputFixture {
  readonly plan: PlannedModelSelectionPlanV1;
  readonly state: RoutingStateV1;
}

export function plannedRouteIdentity(
  fixture: PlannedRoutingFixture,
  attemptId: string = fixture.plan.worker_attempts[0]?.attempt_id ?? "",
): ProviderRouteIdentity {
  const attempts = [
    ...fixture.plan.worker_attempts,
    ...(fixture.plan.reviewer_attempt === null ? [] : [fixture.plan.reviewer_attempt]),
  ];
  const attempt = attempts.find((candidate) => candidate.attempt_id === attemptId);
  const route = attempt?.accepted_routes[0];
  if (attempt === undefined || route === undefined) {
    throw new Error("planned route identity fixture requires one accepted route");
  }
  return Object.freeze({
    transport: "agentgateway",
    gateway_profile: attempt.gateway_profile,
    gateway_revision: attempt.gateway_revision,
    route_id: route.route_id,
    requested_model: attempt.alias,
    resolved_provider: route.provider,
    resolved_model: route.model,
    capability_document_hash: attempt.capability_document_hash,
    requirement_hash: attempt.requirement_hash,
    gateway_request_id: "gateway-planned-route-1",
  });
}

export type RoutingInputFixtureOptions = Readonly<{
  circuits?: readonly RoutingCircuitV1[];
  cooldown_ms?: number;
  consecutive_failure_threshold?: number;
  decision_at?: string;
  live_expires_at?: string;
  request_deadline?: string;
  review?: boolean;
}>;

export function routingInputFixture(options: RoutingInputFixtureOptions = {}): RoutingInputFixture {
  const decisionAt = options.decision_at ?? "2026-08-21T12:00:00.000Z";
  const review = options.review ?? false;
  const workerEntries: readonly ModelCatalogEntryV1[] = [
    ["worker-primary", 10, "gpt-5"],
    ["worker-fallback-a", 20, "gpt-5-mini"],
    ["worker-fallback-b", 30, "gpt-5-nano"],
  ].map(([entryId, priority, model]) => {
    const routeValue: CatalogRouteV1 = {
      route_id: `route-${entryId}`,
      provider: "openai",
      model: String(model),
      capabilities: providerCapabilities("openai"),
      latency_class: "standard",
      pricing: pricing(2_000_000, 200_000, 10_000_000, 12_000_000),
    };
    return {
      entry_id: String(entryId),
      logical_classes: ["balanced-code", "deep-reasoning", "economy"],
      route_alias: String(entryId),
      priority: Number(priority),
      routes: [routeValue],
    };
  });
  const reviewerEntry: ModelCatalogEntryV1 = {
    entry_id: "reviewer-independent",
    logical_classes: ["independent-review"],
    route_alias: "reviewer-independent",
    priority: 10,
    routes: [
      {
        route_id: "route-reviewer-independent",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        capabilities: providerCapabilities("anthropic"),
        latency_class: "standard",
        pricing: pricing(2_000_000, 200_000, 10_000_000, 12_000_000),
      },
    ],
  };
  const entries = [...workerEntries, ...(review ? [reviewerEntry] : [])];
  const parsedCatalog = parseModelCatalog(
    catalogBytes({
      protocol_version: "runtime-contract.v1",
      schema_version: "model-catalog.v1",
      document_type: "model-catalog",
      catalog_id: "catalog-circuit",
      revision: 1,
      entries,
    }),
  );
  if (!parsedCatalog.ok) {
    throw new Error(`invalid circuit catalog fixture: ${JSON.stringify(parsedCatalog.issues)}`);
  }
  const catalog = parsedCatalog.value;

  const policyValue = validRoutingPolicy();
  const rules = (policyValue.rules as readonly Record<string, unknown>[]).map((rule) => ({
    ...rule,
    circuit: {
      consecutive_failure_threshold: options.consecutive_failure_threshold ?? 3,
      cooldown_ms: options.cooldown_ms ?? 60_000,
    },
  }));
  const parsedPolicy = parseRoutingPolicy(policyBytes({ ...policyValue, rules }));
  if (!parsedPolicy.ok) {
    throw new Error(`invalid circuit policy fixture: ${JSON.stringify(parsedPolicy.issues)}`);
  }
  const policy = parsedPolicy.value;

  const requestValue: ExecutionRequestV1 = {
    protocol_version: "runtime-contract.v1",
    schema_version: "execution-request.v1",
    document_type: "execution-request",
    request_id: "request-circuit-1",
    run_id: "run-circuit-1",
    created_at: "2026-08-21T10:00:00.000Z",
    deadline: options.request_deadline ?? "2026-08-21T14:00:00.000Z",
    task_contract: {
      document_type: "task-contract",
      artifact_id: "task-circuit-1",
      revision: 1,
      hash: `sha256:${"6".repeat(64)}`,
    },
    input_artifacts: [],
    agent: {
      definition: {
        document_type: "agent-definition",
        artifact_id: "agent-worker",
        revision: 1,
        hash: `sha256:${"7".repeat(64)}`,
      },
      role: "worker",
    },
    model: {
      logical_class: review ? "deep-reasoning" : "balanced-code",
      required_capabilities: review
        ? ["reasoning", "text", "tools"]
        : ["json-schema", "text", "tools"],
    },
    superpowers: { required: ["test-driven-development"] },
    mcp: {
      profile: {
        document_type: "mcp-profile",
        artifact_id: "mcp-readonly",
        revision: 1,
        hash: `sha256:${"8".repeat(64)}`,
      },
    },
    budget: {
      max_input_tokens: 200_000,
      max_output_tokens: 50_000,
      max_cost_microusd: 5_000_000,
      max_duration_ms: 900_000,
      max_turns: 16,
    },
    review_policy: {
      document_type: "review-policy",
      artifact_id: "review-medium",
      revision: 1,
      hash: `sha256:${"9".repeat(64)}`,
    },
    output: {
      schema: {
        document_type: "output-schema",
        artifact_id: "output-circuit",
        revision: 1,
        hash: `sha256:${"a".repeat(64)}`,
      },
    },
    trace: {
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      trace_flags: 1,
    },
  };
  const parsedRequest = parseExecutionRequest(canonicalJson(requestValue));
  if (!parsedRequest.ok) {
    throw new Error(`invalid circuit request fixture: ${JSON.stringify(parsedRequest.issues)}`);
  }
  const request = parsedRequest.value;

  const liveWithoutHash = {
    protocol_version: "runtime-contract.v1",
    schema_version: "agentgateway-capabilities.v1",
    document_type: "agentgateway-capabilities",
    gateway: { name: "agentgateway", version: "0.10.0", revision: 11 },
    generated_at: "2026-08-21T11:59:00.000Z",
    expires_at: options.live_expires_at ?? "2026-08-21T12:04:00.000Z",
    routes: entries.flatMap((catalogEntry) =>
      catalogEntry.routes.map((catalogRoute) => ({
        alias: catalogEntry.route_alias,
        route_id: catalogRoute.route_id,
        provider: catalogRoute.provider,
        model: catalogRoute.model,
        capabilities: catalogRoute.capabilities,
      })),
    ),
  } as const;
  const liveCandidate = {
    ...liveWithoutHash,
    document_hash: hashAgentgatewayCapabilities({
      ...liveWithoutHash,
      document_hash: `sha256:${"0".repeat(64)}`,
    }),
  } as AgentgatewayCapabilitiesV1;
  const parsedLive = parseAgentgatewayCapabilities(canonicalJson(liveCandidate), {
    now: () => new Date(decisionAt),
  });
  if (!parsedLive.ok) {
    throw new Error(`invalid circuit live fixture: ${JSON.stringify(parsedLive.issues)}`);
  }

  const parsedState = parseRoutingState(
    routingStateBytes({
      ...validRoutingState(),
      state_id: "routing-circuit-1",
      run_id: request.run_id,
      request_hash: hashExecutionRequest(request),
      catalog_hash: catalog.document_hash,
      policy_hash: policy.document_hash,
      budget: request.budget,
      circuits: [...(options.circuits ?? [])].sort((left, right) =>
        left.entry_id < right.entry_id ? -1 : left.entry_id > right.entry_id ? 1 : 0,
      ),
    }),
  );
  if (!parsedState.ok) {
    throw new Error(`invalid circuit state fixture: ${JSON.stringify(parsedState.issues)}`);
  }
  const priorState = parsedState.value;
  const input: PlanModelSelectionInput = {
    request,
    task: {
      task_contract: request.task_contract,
      phase: "implementation",
      complexity: "medium",
      risks: review ? ["security"] : [],
      max_latency_class: "standard",
    },
    ceilings: {
      max_input_tokens: 20_000,
      max_output_tokens: 4_000,
      max_duration_ms: 120_000,
    },
    catalog,
    policy,
    state: priorState,
    live: parsedLive.value,
    gateway_profile: "gateway-primary",
    decision_at: decisionAt,
  };
  return Object.freeze({
    input,
    catalog,
    policy,
    prior_state: priorState,
  });
}
