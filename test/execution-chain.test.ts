import { describe, expect, it } from "vitest";

import {
  createBaselineCapabilities,
  negotiateRequest,
  parseRuntimeCapabilities,
  type RuntimeCapabilitiesV1,
} from "../src/protocol/capabilities.js";
import {
  hashExecutionEvent,
  parseExecutionEvent,
  type ExecutionEventV1,
  type HashableExecutionEventV1,
} from "../src/protocol/event.js";
import { canonicalJson } from "../src/protocol/json.js";
import { parseExecutionResult, validateExecutionChain } from "../src/protocol/result.js";
import { loadValidChain } from "./support/protocol-fixtures.js";

describe("Runtime Contract Protocol v1 chain", () => {
  function eventWithHash(event: HashableExecutionEventV1): ExecutionEventV1 {
    return { ...event, event_hash: hashExecutionEvent(event) };
  }

  function withoutEventHash(event: ExecutionEventV1): HashableExecutionEventV1 {
    const { event_hash: eventHash, ...hashable } = event;
    void eventHash;
    return hashable;
  }

  it("binds event and result to the exact request and journal head", async () => {
    const chain = await loadValidChain();
    expect(
      validateExecutionChain({
        request: chain.request,
        events: chain.events,
        result: chain.result,
      }),
    ).toEqual({ ok: true, value: true });
  });

  it("reports only the delivered provider subsystem as available in the baseline", () => {
    const document = createBaselineCapabilities({ os: "linux", arch: "x64", node: "22.23.1" });
    expect(document.execution_topologies).toEqual([]);
    expect(document.model_classes).toEqual([]);
    expect(document.mcp_profiles).toEqual([]);
    expect(document.provider_transports).toEqual(["openai", "anthropic", "gemini"]);
    expect(document.features).toEqual({
      providers: "available",
      routing: "unavailable",
      skills: "unavailable",
      mcp: "unavailable",
      agent_loop: "unavailable",
      review: "unavailable",
      evidence: "unavailable",
    });
    expect(parseRuntimeCapabilities(canonicalJson(document))).toMatchObject({ ok: true });
  });

  it("fails request negotiation before execution when capabilities are unavailable", async () => {
    const chain = await loadValidChain();
    const result = negotiateRequest(chain.request, chain.capabilities);
    expect(result).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_UNSUPPORTED",
    });
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.keyword)).toContain("modelClass");
      expect(result.issues.map((issue) => issue.keyword)).toContain("superpowersCapability");
      expect(result.issues.map((issue) => issue.keyword)).toContain("mcpTransport");
      expect(result.issues.map((issue) => issue.keyword)).toContain("executionTopology");
    }
  });

  it("rejects a capability document that advertises unavailable provider resources", () => {
    const baseline = createBaselineCapabilities({ os: "linux", arch: "x64", node: "22.23.1" });
    const contradictory = {
      ...baseline,
      features: { ...baseline.features, providers: "unavailable" },
      model_classes: [{ logical_class: "balanced-code", capabilities: ["tools"] }],
    };
    expect(parseRuntimeCapabilities(canonicalJson(contradictory))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });

  it("requires every execution feature and the exact MCP profile", async () => {
    const chain = await loadValidChain();
    const ready = {
      ...chain.capabilities,
      provider_transports: ["openai"],
      model_classes: [
        {
          logical_class: chain.request.model.logical_class,
          capabilities: [...chain.request.model.required_capabilities],
        },
      ],
      skill_host_versions: ["agent-skills.v1"],
      superpowers_capabilities: [...chain.request.superpowers.required],
      mcp_transports: ["stdio"],
      mcp_profiles: [],
      execution_topologies: ["sequential-worker-reviewer"],
      features: {
        providers: "available",
        routing: "available",
        skills: "available",
        mcp: "available",
        agent_loop: "available",
        review: "available",
        evidence: "available",
      },
    } as unknown as RuntimeCapabilitiesV1;

    const missingProfile = negotiateRequest(chain.request, ready);
    expect(missingProfile).toMatchObject({ ok: false });
    if (!missingProfile.ok) {
      expect(missingProfile.issues.map((issue) => issue.keyword)).toContain("mcpProfile");
    }

    const exactProfile = {
      ...ready,
      mcp_profiles: [chain.request.mcp.profile],
    } as RuntimeCapabilitiesV1;
    expect(negotiateRequest(chain.request, exactProfile)).toEqual({
      ok: true,
      value: { protocol: "runtime-contract.v1" },
    });

    const withoutProviderTransport = {
      ...exactProfile,
      provider_transports: [],
    } as RuntimeCapabilitiesV1;
    expect(parseRuntimeCapabilities(canonicalJson(withoutProviderTransport))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
    const noProviderResult = negotiateRequest(chain.request, withoutProviderTransport);
    expect(noProviderResult).toMatchObject({ ok: false });
    if (!noProviderResult.ok) {
      expect(noProviderResult.issues.map((issue) => issue.keyword)).toContain("providerTransport");
    }

    const withoutSkillHost = {
      ...exactProfile,
      skill_host_versions: [],
    } as RuntimeCapabilitiesV1;
    expect(parseRuntimeCapabilities(canonicalJson(withoutSkillHost))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
    const noSkillHostResult = negotiateRequest(chain.request, withoutSkillHost);
    expect(noSkillHostResult).toMatchObject({ ok: false });
    if (!noSkillHostResult.ok) {
      expect(noSkillHostResult.issues.map((issue) => issue.keyword)).toContain("skillHost");
    }

    const unavailable = {
      ...exactProfile,
      features: { ...exactProfile.features, mcp: "unavailable" },
    } as RuntimeCapabilitiesV1;
    const unavailableResult = negotiateRequest(chain.request, unavailable);
    expect(unavailableResult).toMatchObject({ ok: false });
    if (!unavailableResult.ok) {
      expect(unavailableResult.issues.map((issue) => issue.keyword)).toContain(
        "featureAvailability",
      );
    }
  });

  it("accepts and rejects mixed provider/routing resource states independently", async () => {
    const { capabilities } = await loadValidChain();
    const modelClass = { logical_class: "implementation", capabilities: ["text"] };
    const cases: readonly Readonly<{
      name: string;
      expected: boolean;
      value: RuntimeCapabilitiesV1;
    }>[] = [
      {
        name: "provider available before routing",
        expected: true,
        value: {
          ...capabilities,
          provider_transports: ["openai"],
          features: { ...capabilities.features, providers: "available" },
        },
      },
      {
        name: "provider and routing available with their resources",
        expected: true,
        value: {
          ...capabilities,
          provider_transports: ["openai"],
          model_classes: [modelClass],
          features: {
            ...capabilities.features,
            providers: "available",
            routing: "available",
          },
        },
      },
      {
        name: "unavailable provider advertising a transport",
        expected: false,
        value: { ...capabilities, provider_transports: ["openai"] },
      },
      {
        name: "unavailable routing advertising a model class",
        expected: false,
        value: {
          ...capabilities,
          provider_transports: ["openai"],
          model_classes: [modelClass],
          features: { ...capabilities.features, providers: "available" },
        },
      },
    ];

    for (const entry of cases) {
      expect(parseRuntimeCapabilities(canonicalJson(entry.value)).ok, entry.name).toBe(
        entry.expected,
      );
    }
  });

  it.each([
    "apiKey",
    "APIKey",
    "APIKEY",
    "TOKEN",
    "TOKENVALUE",
    "ACCESSTOKENVALUE",
    "CLIENTTOKENVALUE",
    "clientSecret",
    "CLIENTSECRET",
    "governanceApproval",
    "GOVERNANCEAPPROVAL",
    "acceptedBy",
  ])("rejects sensitive or authority-shaped event metadata key %s", async (key) => {
    const chain = await loadValidChain();
    const hashable = withoutEventHash(chain.events[0]!);
    const event = eventWithHash({ ...hashable, payload: { [key]: "must-not-persist" } });
    expect(parseExecutionEvent(canonicalJson(event))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });

  it.each(["refreshToken", "TOKENVALUE", "ACCESSTOKENVALUE", "CLIENTTOKENVALUE"])(
    "rejects sensitive result error metadata key %s",
    async (key) => {
      const chain = await loadValidChain();
      const result = {
        ...chain.result,
        status: "FAILED",
        outputs: [],
        error: {
          code: "PROVIDER_FAILURE",
          category: "unavailable",
          retryable: false,
          safe_message: "Provider unavailable",
          metadata: { [key]: "must-not-persist" },
        },
      };
      expect(parseExecutionResult(canonicalJson(result))).toMatchObject({
        ok: false,
        code: "RUNTIME_DOCUMENT_INVALID",
      });
    },
  );

  it("requires the final terminal event to match the result status", async () => {
    const chain = await loadValidChain();
    const hashable = withoutEventHash(chain.events[0]!);
    const failed = eventWithHash({
      ...hashable,
      event_type: "FAILED",
      payload: { state: "FAILED" },
    });
    const validation = validateExecutionChain({
      request: chain.request,
      events: [failed],
      result: {
        ...chain.result,
        journal_head: { ...chain.result.journal_head, event_hash: failed.event_hash },
      },
    });
    expect(validation).toMatchObject({ ok: false });
    if (!validation.ok) {
      expect(validation.issues.map((issue) => issue.keyword)).toContain("terminalStatus");
    }
  });

  it("rejects events before request creation or earlier than the previous event", async () => {
    const chain = await loadValidChain();
    const original = withoutEventHash(chain.events[0]!);
    const beforeRequest = eventWithHash({
      ...original,
      timestamp: "2026-08-18T23:59:59.000Z",
    });
    const beforeRequestValidation = validateExecutionChain({
      request: chain.request,
      events: [beforeRequest],
      result: {
        ...chain.result,
        journal_head: { ...chain.result.journal_head, event_hash: beforeRequest.event_hash },
      },
    });
    expect(beforeRequestValidation).toMatchObject({ ok: false });

    const first = eventWithHash({
      ...original,
      event_type: "RUNNING",
      timestamp: "2026-08-19T00:00:50.000Z",
      payload: { state: "RUNNING" },
    });
    const second = eventWithHash({
      ...original,
      sequence: 2,
      run_revision: 2,
      previous_event_hash: first.event_hash,
      timestamp: "2026-08-19T00:00:40.000Z",
    });
    const decreasingValidation = validateExecutionChain({
      request: chain.request,
      events: [first, second],
      result: {
        ...chain.result,
        journal_head: {
          sequence: second.sequence,
          run_revision: second.run_revision,
          event_hash: second.event_hash,
        },
      },
    });
    expect(decreasingValidation).toMatchObject({ ok: false });
    if (!decreasingValidation.ok) {
      expect(decreasingValidation.issues.map((issue) => issue.keyword)).toContain("eventOrdering");
    }
  });

  it.each([
    [
      "stale request hash",
      (chain: Awaited<ReturnType<typeof loadValidChain>>) => ({
        ...chain,
        events: [{ ...chain.events[0]!, request_hash: `sha256:${"9".repeat(64)}` as const }],
      }),
    ],
    [
      "skipped sequence",
      (chain: Awaited<ReturnType<typeof loadValidChain>>) => ({
        ...chain,
        events: [{ ...chain.events[0]!, sequence: 2 }],
      }),
    ],
    [
      "broken previous hash",
      (chain: Awaited<ReturnType<typeof loadValidChain>>) => ({
        ...chain,
        events: [{ ...chain.events[0]!, previous_event_hash: `sha256:${"8".repeat(64)}` as const }],
      }),
    ],
    [
      "tampered payload",
      (chain: Awaited<ReturnType<typeof loadValidChain>>) => ({
        ...chain,
        events: [{ ...chain.events[0]!, payload: { state: "FAILED" } }],
      }),
    ],
    [
      "mismatched result head",
      (chain: Awaited<ReturnType<typeof loadValidChain>>) => ({
        ...chain,
        result: { ...chain.result, journal_head: { ...chain.result.journal_head, sequence: 2 } },
      }),
    ],
    [
      "a result timestamp before the journal head",
      (chain: Awaited<ReturnType<typeof loadValidChain>>) => ({
        ...chain,
        result: { ...chain.result, finished_at: "2026-08-19T00:00:30.000Z" },
      }),
    ],
  ])("rejects a chain with %s", async (_name, mutate) => {
    const chain = mutate(await loadValidChain());
    expect(
      validateExecutionChain({
        request: chain.request,
        events: chain.events,
        result: chain.result,
      }),
    ).toMatchObject({ ok: false });
  });
});
