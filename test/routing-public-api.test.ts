import { describe, expect, expectTypeOf, it } from "vitest";

import * as packageApi from "../src/index.js";
import {
  calculateRoutingCost,
  createBaselineCapabilities,
  estimateRoutingAllocation,
  hashModelCatalog,
  hashModelSelectionPlan,
  hashRoutingPolicy,
  hashRoutingState,
  nextModelFallback,
  parseGovernedRoutingOverride,
  parseModelCatalog,
  parseModelSelectionPlan,
  parseRoutingPolicy,
  parseRoutingState,
  planModelSelection,
  recordRoutingOutcome,
  reserveRoutingBudget,
  RuntimeRoutingError,
  settleRoutingDecision,
  verifyResolvedRoute,
  type ModelFallbackDecision,
  type PlanModelSelectionInput,
  type RecordedRoutingOutcome,
  type RoutingDecision,
  type RoutingOutcomeTransition,
  type RoutingStateV1,
} from "../src/index.js";
import { canonicalJson } from "../src/protocol/json.js";
import { parseRuntimeCapabilities } from "../src/protocol/capabilities.js";
import * as routingApi from "../src/routing/index.js";

const PUBLIC_ROUTING_VALUES = [
  "RuntimeRoutingError",
  "calculateRoutingCost",
  "estimateRoutingAllocation",
  "hashModelCatalog",
  "hashModelSelectionPlan",
  "hashRoutingPolicy",
  "hashRoutingState",
  "nextModelFallback",
  "parseGovernedRoutingOverride",
  "parseModelCatalog",
  "parseModelSelectionPlan",
  "parseRoutingPolicy",
  "parseRoutingState",
  "planModelSelection",
  "recordRoutingOutcome",
  "reserveRoutingBudget",
  "settleRoutingDecision",
  "verifyResolvedRoute",
] as const;

const ROUTING_SCHEMAS = [
  "model-catalog.v1",
  "model-selection-plan.v1",
  "routing-policy.v1",
  "routing-state.v1",
] as const;

const MODEL_CLASSES = [
  { logical_class: "economy", capabilities: ["text"] },
  {
    logical_class: "balanced-code",
    capabilities: ["json-schema", "text", "tools"],
  },
  { logical_class: "deep-reasoning", capabilities: ["reasoning", "text"] },
  { logical_class: "long-context", capabilities: ["long-context", "text"] },
  { logical_class: "vision", capabilities: ["text", "vision"] },
  {
    logical_class: "independent-review",
    capabilities: ["independent-review", "reasoning", "text"],
  },
] as const;

describe("governed routing public API", () => {
  it("publishes only the explicit safe routing runtime surface", () => {
    expect(Object.keys(routingApi).sort()).toEqual([...PUBLIC_ROUTING_VALUES].sort());
    for (const name of PUBLIC_ROUTING_VALUES) {
      expect(packageApi[name]).toBe(routingApi[name]);
    }
  });

  it("keeps validators, stateful facilities, scoring hooks, and test helpers private", () => {
    for (const internalName of [
      "candidateForEntry",
      "compareCandidate",
      "createRoutingFilesystem",
      "createRoutingPersistence",
      "createRoutingStore",
      "modelCatalogValidator",
      "plannedDecisionHash",
      "pricing",
      "requireModelRouter",
      "routingCache",
      "routingPolicyValidator",
      "routingRuntimeError",
      "scoreRoutingCandidates",
      "sortedEliminations",
      "validCatalog",
    ]) {
      expect(routingApi).not.toHaveProperty(internalName);
      expect(packageApi).not.toHaveProperty(internalName);
    }
  });

  it("publishes the corrected outcome wrapper and circuit-chain settlement contract", () => {
    expect(calculateRoutingCost).toBeTypeOf("function");
    expect(estimateRoutingAllocation).toBeTypeOf("function");
    expect(hashModelCatalog).toBeTypeOf("function");
    expect(hashModelSelectionPlan).toBeTypeOf("function");
    expect(hashRoutingPolicy).toBeTypeOf("function");
    expect(hashRoutingState).toBeTypeOf("function");
    expect(nextModelFallback).toBeTypeOf("function");
    expect(parseGovernedRoutingOverride).toBeTypeOf("function");
    expect(parseModelCatalog).toBeTypeOf("function");
    expect(parseModelSelectionPlan).toBeTypeOf("function");
    expect(parseRoutingPolicy).toBeTypeOf("function");
    expect(parseRoutingState).toBeTypeOf("function");
    expect(planModelSelection).toBeTypeOf("function");
    expect(recordRoutingOutcome).toBeTypeOf("function");
    expect(reserveRoutingBudget).toBeTypeOf("function");
    expect(settleRoutingDecision).toBeTypeOf("function");
    expect(verifyResolvedRoute).toBeTypeOf("function");
    expect(new RuntimeRoutingError("RUNTIME_ROUTING_INVALID")).toMatchObject({
      code: "RUNTIME_ROUTING_INVALID",
      category: "invalid-input",
      retryable: false,
    });

    expectTypeOf<
      Parameters<typeof planModelSelection>[0]
    >().toEqualTypeOf<PlanModelSelectionInput>();
    expectTypeOf<ReturnType<typeof planModelSelection>>().toEqualTypeOf<RoutingDecision>();
    expectTypeOf<ReturnType<typeof recordRoutingOutcome>>().toEqualTypeOf<RecordedRoutingOutcome>();
    expectTypeOf<RecordedRoutingOutcome["transition"]>().toEqualTypeOf<RoutingOutcomeTransition>();
    expectTypeOf<ReturnType<typeof nextModelFallback>>().toEqualTypeOf<ModelFallbackDecision>();
    expectTypeOf<
      Parameters<typeof settleRoutingDecision>[0]["circuit_state_chain"]
    >().toEqualTypeOf<readonly RoutingStateV1[]>();
  });
});

describe("baseline governed routing capability", () => {
  it("advertises the four routing schemas and fixed logical model classes", () => {
    const capabilities = createBaselineCapabilities({
      os: "darwin",
      arch: "arm64",
      node: "22.23.1",
    });

    expect(
      capabilities.supported_schemas.filter(
        (schema) => schema.startsWith("model-") || schema.startsWith("routing-"),
      ),
    ).toEqual(ROUTING_SCHEMAS);
    expect(capabilities.model_classes).toEqual(MODEL_CLASSES);
    expect(capabilities.features).toEqual({
      providers: "available",
      routing: "available",
      skills: "available",
      mcp: "unavailable",
      agent_loop: "unavailable",
      review: "unavailable",
      evidence: "unavailable",
    });
    expect(capabilities.execution_topologies).toEqual([]);
    expect(parseRuntimeCapabilities(canonicalJson(capabilities))).toMatchObject({ ok: true });
  });
});
