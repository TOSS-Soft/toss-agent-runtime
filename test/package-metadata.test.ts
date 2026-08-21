import { describe, expect, expectTypeOf, it } from "vitest";

import * as packageApi from "../src/index.js";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  RuntimeProjectError,
  RuntimeProviderError,
  createAgentgatewayTransport,
  createAnthropicAdapter,
  createGeminiAdapter,
  createOpenAIAdapter,
  hashAgentgatewayCapabilities,
  parseAgentgatewayCapabilities,
  parseCandidateJobIntent,
  parseProjectRegistryEntry,
  parseProjectWatchManifest,
  parseProviderEvent,
  type AgentgatewayCapabilitiesV1,
  type AgentgatewayClientHealth,
  type AgentgatewayHealth,
  type AgentgatewayProfileV1,
  type AgentgatewayRouteV1,
  type GatewayCredentialProvider,
  type GatewayObservation,
  type GatewayObservationStatusClass,
  type ProjectIntake,
  type ProjectRegistry,
  type ProviderCompletion,
  type ProviderRouteIdentity,
  type ProviderWireResponse,
  type ProviderWireStream,
} from "../src/index.js";

describe("package metadata", () => {
  it("exports the frozen development identity", () => {
    expect(PACKAGE_NAME).toBe("@toss-software/agent-runtime");
    expect(PACKAGE_VERSION).toBe("0.0.0-development");
    expect(PROTOCOL_VERSION).toBe("runtime-contract.v1");
  });

  it("exports closed project contracts and safe registry/intake interfaces", () => {
    expect(parseCandidateJobIntent).toBeTypeOf("function");
    expect(parseProjectRegistryEntry).toBeTypeOf("function");
    expect(parseProjectWatchManifest).toBeTypeOf("function");
    expect(new RuntimeProjectError("RUNTIME_PROJECT_INVALID").code).toBe("RUNTIME_PROJECT_INVALID");
    expectTypeOf<ProjectRegistry["register"]>().toBeFunction();
    expectTypeOf<ProjectIntake["record"]>().toBeFunction();

    expect(packageApi).not.toHaveProperty("createProjectRegistry");
    expect(packageApi).not.toHaveProperty("createProjectIntake");
    expect(packageApi).not.toHaveProperty("createProjectWatcher");
  });

  it("exports the normalized provider contract without a native SDK surface", () => {
    expect(parseProviderEvent).toBeTypeOf("function");
    expect(createOpenAIAdapter).toBeTypeOf("function");
    expect(createAnthropicAdapter).toBeTypeOf("function");
    expect(createGeminiAdapter).toBeTypeOf("function");
    expect(new RuntimeProviderError("RUNTIME_PROVIDER_RATE_LIMIT")).toMatchObject({
      category: "rate-limit",
      retryable: true,
    });
    expectTypeOf<
      ProviderWireResponse["route_identity"]
    >().toEqualTypeOf<ProviderRouteIdentity | null>();
    expectTypeOf<
      ProviderWireStream["route_identity"]
    >().toEqualTypeOf<ProviderRouteIdentity | null>();
    expectTypeOf<
      ProviderCompletion["route_identity"]
    >().toEqualTypeOf<ProviderRouteIdentity | null>();
    expect(packageApi).not.toHaveProperty("openai");
    expect(packageApi).not.toHaveProperty("anthropic");
    expect(packageApi).not.toHaveProperty("gemini");
  });

  it("exports the safe agentgateway surface without transport internals", () => {
    expect(createAgentgatewayTransport).toBeTypeOf("function");
    expect(parseAgentgatewayCapabilities).toBeTypeOf("function");
    expect(hashAgentgatewayCapabilities).toBeTypeOf("function");

    expectTypeOf<AgentgatewayProfileV1["protocol"]>().toEqualTypeOf<"toss-agentgateway.v1">();
    expectTypeOf<AgentgatewayCapabilitiesV1["routes"]>().toEqualTypeOf<
      readonly AgentgatewayRouteV1[]
    >();
    expectTypeOf<AgentgatewayHealth["status"]>().toEqualTypeOf<
      "healthy" | "degraded" | "unavailable"
    >();
    expectTypeOf<AgentgatewayClientHealth>().toMatchTypeOf<
      AgentgatewayHealth | Readonly<{ status: "unavailable" }>
    >();
    expectTypeOf<GatewayCredentialProvider["resolve"]>().toBeFunction();
    expectTypeOf<
      GatewayObservation["status_class"]
    >().toEqualTypeOf<GatewayObservationStatusClass>();

    for (const internalName of [
      "agentgatewayError",
      "classifyAgentgatewayHttpStatus",
      "createAgentgatewayClient",
      "createGatewayCredentialCoordinator",
      "parseAgentgatewayAttestation",
      "parseBoundedSse",
      "readBoundedAgentgatewayResponse",
      "startFakeAgentgateway",
    ]) {
      expect(packageApi).not.toHaveProperty(internalName);
    }
  });

  it("exports governed routing without stateful or test-only routing internals", () => {
    for (const name of [
      "calculateRoutingCost",
      "estimateRoutingAllocation",
      "nextModelFallback",
      "parseModelCatalog",
      "parseRoutingPolicy",
      "parseRoutingState",
      "parseModelSelectionPlan",
      "planModelSelection",
      "recordRoutingOutcome",
      "reserveRoutingBudget",
      "settleRoutingDecision",
      "verifyResolvedRoute",
    ]) {
      expect(packageApi).toHaveProperty(name, expect.any(Function));
    }

    for (const internalName of [
      "createRoutingStore",
      "modelCatalogValidator",
      "requireModelRouter",
      "routingCache",
      "scoreRoutingCandidates",
      "validCatalog",
    ]) {
      expect(packageApi).not.toHaveProperty(internalName);
    }
  });
});
