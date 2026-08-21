import { afterEach, describe, expect, it } from "vitest";

import type { SecretReference } from "../src/config/types.js";
import { createAgentgatewayTransport } from "../src/gateway/transport.js";
import { canonicalJson } from "../src/protocol/json.js";
import {
  createOpenAIAdapter,
  RuntimeProviderError,
  type ProviderRequest,
  type ProviderRouteIdentity,
} from "../src/providers/index.js";
import { hashRoutingState } from "../src/routing/contracts.js";
import { RuntimeRoutingError } from "../src/routing/errors.js";
import { verifyResolvedRoute } from "../src/routing/resolution.js";
import type { RoutingStateV1 } from "../src/routing/types.js";
import { startFakeAgentgateway, type FakeAgentgateway } from "./helpers/fake-agentgateway.js";
import {
  plannedRouteIdentity,
  plannedRoutingFixture,
  providerCapabilities,
  type PlannedRoutingFixture,
} from "./helpers/routing-fixtures.js";

const activeGateways: FakeAgentgateway[] = [];
const resolutionError = new RuntimeRoutingError("RUNTIME_ROUTING_RESOLUTION_MISMATCH");
const credentialReference: SecretReference = {
  source: "command",
  key: "TOSS_AGENTGATEWAY_TOKEN",
};

afterEach(async () => {
  await Promise.all(activeGateways.splice(0).map(async (gateway) => gateway.close()));
});

function immutableIdentity(
  identity: ProviderRouteIdentity,
  mutation: Readonly<Record<string, unknown>>,
): ProviderRouteIdentity {
  return Object.freeze({ ...identity, ...mutation });
}

function rehashedState(
  state: RoutingStateV1,
  mutation: (candidate: Record<string, unknown>) => void,
): RoutingStateV1 {
  const candidate = structuredClone(state) as unknown as Record<string, unknown>;
  mutation(candidate);
  candidate.document_hash = hashRoutingState(candidate as unknown as RoutingStateV1);
  return candidate as unknown as RoutingStateV1;
}

function assertResolutionMismatch(operation: () => unknown, nativeDetail: string): void {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toEqual(resolutionError);
  expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(nativeDetail);
}

describe("planned agentgateway route resolution", () => {
  it("returns a canonical deeply frozen identity for one exact planned accepted route", () => {
    const fixture = plannedRoutingFixture();
    const attempt = fixture.plan.worker_attempts[0]!;
    const identity = plannedRouteIdentity(fixture, attempt.attempt_id);

    const resolved = verifyResolvedRoute({
      state: fixture.state,
      plan: fixture.plan,
      attempt_id: attempt.attempt_id,
      route_identity: identity,
    });

    expect(resolved).toEqual(identity);
    expect(resolved).not.toBe(identity);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.keys(resolved).sort()).toEqual([
      "capability_document_hash",
      "gateway_profile",
      "gateway_request_id",
      "gateway_revision",
      "requested_model",
      "requirement_hash",
      "resolved_model",
      "resolved_provider",
      "route_id",
      "transport",
    ]);
  });

  it.each([
    ["missing identity", () => null],
    [
      "non-agentgateway identity",
      (identity: ProviderRouteIdentity) =>
        immutableIdentity(identity, { transport: "native-secret-transport" }),
    ],
    [
      "gateway profile",
      (identity: ProviderRouteIdentity) =>
        immutableIdentity(identity, { gateway_profile: "native-secret-profile" }),
    ],
    [
      "gateway revision",
      (identity: ProviderRouteIdentity) => immutableIdentity(identity, { gateway_revision: 12 }),
    ],
    [
      "requested alias",
      (identity: ProviderRouteIdentity) =>
        immutableIdentity(identity, { requested_model: "native-secret-alias" }),
    ],
    [
      "route ID",
      (identity: ProviderRouteIdentity) =>
        immutableIdentity(identity, { route_id: "native-secret-route" }),
    ],
    [
      "provider",
      (identity: ProviderRouteIdentity) =>
        immutableIdentity(identity, { resolved_provider: "anthropic" }),
    ],
    [
      "model",
      (identity: ProviderRouteIdentity) =>
        immutableIdentity(identity, { resolved_model: "native-secret-model" }),
    ],
    [
      "capability document hash",
      (identity: ProviderRouteIdentity) =>
        immutableIdentity(identity, { capability_document_hash: `sha256:${"a".repeat(64)}` }),
    ],
    [
      "requirement hash",
      (identity: ProviderRouteIdentity) =>
        immutableIdentity(identity, { requirement_hash: `sha256:${"b".repeat(64)}` }),
    ],
  ] satisfies readonly (readonly [
    string,
    (identity: ProviderRouteIdentity) => ProviderRouteIdentity | null,
  ])[])("rejects a %s mismatch with one fixed non-reflective error", (_name, mutate) => {
    const fixture = plannedRoutingFixture();
    const attempt = fixture.plan.worker_attempts[0]!;
    const identity = plannedRouteIdentity(fixture, attempt.attempt_id);
    const candidate = mutate(identity);

    assertResolutionMismatch(
      () =>
        verifyResolvedRoute({
          state: fixture.state,
          plan: fixture.plan,
          attempt_id: attempt.attempt_id,
          route_identity: candidate,
        }),
      "native-secret",
    );
  });

  it.each([
    ["state head", (fixture: PlannedRoutingFixture) => fixture.prior_state],
    [
      "catalog hash",
      (fixture: PlannedRoutingFixture) =>
        rehashedState(fixture.state, (state) => {
          state.catalog_hash = `sha256:${"c".repeat(64)}`;
        }),
    ],
    [
      "policy hash",
      (fixture: PlannedRoutingFixture) =>
        rehashedState(fixture.state, (state) => {
          state.policy_hash = `sha256:${"d".repeat(64)}`;
        }),
    ],
    [
      "decision reservation",
      (fixture: PlannedRoutingFixture) =>
        rehashedState(fixture.state, (state) => {
          state.reservations = [];
        }),
    ],
  ] as const)("rejects a mismatched %s", (_name, changeState) => {
    const fixture = plannedRoutingFixture();
    const attempt = fixture.plan.worker_attempts[0]!;

    expect(() =>
      verifyResolvedRoute({
        state: changeState(fixture),
        plan: fixture.plan,
        attempt_id: attempt.attempt_id,
        route_identity: plannedRouteIdentity(fixture, attempt.attempt_id),
      }),
    ).toThrow(resolutionError);
  });

  it("rejects an attempt ID not present exactly once in the plan", () => {
    const fixture = plannedRoutingFixture();

    expect(() =>
      verifyResolvedRoute({
        state: fixture.state,
        plan: fixture.plan,
        attempt_id: "attempt-native-secret-missing",
        route_identity: plannedRouteIdentity(fixture),
      }),
    ).toThrow(resolutionError);
  });

  it("rejects noncanonical identity structure without invoking or reflecting native accessors", () => {
    const fixture = plannedRoutingFixture();
    const attempt = fixture.plan.worker_attempts[0]!;
    const identity = plannedRouteIdentity(fixture, attempt.attempt_id);
    let getterCalls = 0;
    const hostile = { ...identity } as Record<string, unknown>;
    Object.defineProperty(hostile, "native-secret-field", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("native-secret-accessor");
      },
    });
    Object.freeze(hostile);

    assertResolutionMismatch(
      () =>
        verifyResolvedRoute({
          state: fixture.state,
          plan: fixture.plan,
          attempt_id: attempt.attempt_id,
          route_identity: hostile as unknown as ProviderRouteIdentity,
        }),
      "native-secret",
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects a coercive provider identity without invoking conversion hooks", () => {
    const fixture = plannedRoutingFixture();
    const attempt = fixture.plan.worker_attempts[0]!;
    const identity = plannedRouteIdentity(fixture, attempt.attempt_id);
    let toStringCalls = 0;
    let primitiveCalls = 0;
    const nativeDetail = "native-secret-provider-coercion";
    const coerciveProvider = Object.freeze({
      toString() {
        toStringCalls += 1;
        throw new Error(nativeDetail);
      },
      [Symbol.toPrimitive]() {
        primitiveCalls += 1;
        throw new Error(nativeDetail);
      },
    });
    const hostile = immutableIdentity(identity, { resolved_provider: coerciveProvider });

    assertResolutionMismatch(
      () =>
        verifyResolvedRoute({
          state: fixture.state,
          plan: fixture.plan,
          attempt_id: attempt.attempt_id,
          route_identity: hostile,
        }),
      nativeDetail,
    );
    expect(toStringCalls).toBe(0);
    expect(primitiveCalls).toBe(0);
  });
});

function nativeCompletion(model: string): string {
  return canonicalJson({
    id: "resp_resolution_1",
    model,
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "planned answer" }] }],
    usage: { input_tokens: 3, output_tokens: 2 },
  });
}

async function loopbackCompletion(
  fixture: PlannedRoutingFixture,
  attestation: Readonly<Record<string, string>> = {},
) {
  const attempt = fixture.plan.worker_attempts[0]!;
  const route = attempt.accepted_routes[0]!;
  const gateway = await startFakeAgentgateway();
  activeGateways.push(gateway);
  gateway.configureResolvedRoute({
    capability: fixture.input.live,
    requirement: attempt.requirement,
    route_id: route.route_id,
    body: nativeCompletion(route.model),
    attestation,
  });
  const transport = createAgentgatewayTransport({
    selectedProfile: {
      name: attempt.gateway_profile,
      profile: {
        protocol: "toss-agentgateway.v1",
        endpoint: gateway.endpoint,
        credential_reference: "loopback-placeholder",
        body_observability: "off",
      },
    },
    credentialReference,
    credentialProvider: {
      resolve: () =>
        Promise.resolve({
          scheme: "Bearer" as const,
          token: "loopback-placeholder-token",
          expires_at: "2026-08-21T12:02:00.000Z",
        }),
    },
    fetch: globalThis.fetch,
    now: () => new Date(fixture.input.decision_at),
    monotonicNow: () => 0,
  });
  let event = 0;
  const adapter = createOpenAIAdapter({
    transport,
    capabilities: providerCapabilities("openai"),
    now: () => new Date(fixture.input.decision_at),
    createEventId: () => `018f0f64-7b21-7d4f-8c3d-4a30413d5f4${event++}`,
  });
  const request: ProviderRequest = {
    request_id: "018f0f64-7b21-7d4f-8c3d-4a30413d5f50",
    model: attempt.alias,
    messages: [{ role: "user", content: [{ type: "text", text: "verify planned route" }] }],
    max_output_tokens: attempt.requirement.max_output_tokens,
    timeout_ms: 2_000,
    tools: [
      {
        name: "planned_tool",
        description: "Exercise the planned tools requirement",
        input_schema: { type: "object", additionalProperties: false },
      },
    ],
    response_format: {
      type: "json-schema",
      name: "planned_response",
      schema: { type: "object", additionalProperties: true },
    },
  };
  return adapter.complete(request, {
    run_id: fixture.plan.run_id,
    trace: fixture.input.request.trace,
  });
}

describe("planned route loopback integration", () => {
  it("binds a normalized credential-free loopback completion to the exact reserved plan", async () => {
    const fixture = plannedRoutingFixture();
    const attempt = fixture.plan.worker_attempts[0]!;

    const completion = await loopbackCompletion(fixture);
    const resolved = verifyResolvedRoute({
      state: fixture.state,
      plan: fixture.plan,
      attempt_id: attempt.attempt_id,
      route_identity: completion.route_identity,
    });

    expect(completion.text).toBe("planned answer");
    expect(resolved).toEqual(completion.route_identity);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it("fails closed when the loopback gateway tampers with its requirement attestation", async () => {
    const fixture = plannedRoutingFixture();

    await expect(
      loopbackCompletion(fixture, { requirement_hash: `sha256:${"e".repeat(64)}` }),
    ).rejects.toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_GATEWAY_INVALID"));
  });
});
