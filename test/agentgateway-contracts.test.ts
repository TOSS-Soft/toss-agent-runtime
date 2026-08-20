import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  hashAgentgatewayCapabilities,
  parseAgentgatewayCapabilities,
  parseAgentgatewayHealth,
  type AgentgatewayCapabilitiesV1,
} from "../src/gateway/index.js";
import { canonicalJson } from "../src/protocol/json.js";

const now = () => new Date("2026-08-20T10:01:00.000Z");

function hashCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function hashableCapabilities() {
  return {
    protocol_version: "runtime-contract.v1",
    schema_version: "agentgateway-capabilities.v1",
    document_type: "agentgateway-capabilities",
    gateway: { name: "agentgateway", version: "0.10.0", revision: 7 },
    generated_at: "2026-08-20T10:00:00.000Z",
    expires_at: "2026-08-20T10:05:00.000Z",
    routes: [
      {
        alias: "balanced-code",
        route_id: "balanced-openai-primary",
        provider: "openai",
        model: "gpt-5",
        capabilities: {
          provider: "openai",
          tools: true,
          json_schema: true,
          vision: true,
          reasoning: true,
          streaming: true,
          max_context_tokens: 200_000,
          max_output_tokens: 16_384,
        },
      },
      {
        alias: "balanced-code",
        route_id: "balanced-anthropic-secondary",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        capabilities: {
          provider: "anthropic",
          tools: true,
          json_schema: true,
          vision: true,
          reasoning: true,
          streaming: true,
          max_context_tokens: 200_000,
          max_output_tokens: 16_384,
        },
      },
    ],
  } as const;
}

function capabilityDocument(
  mutate: (candidate: Record<string, unknown>) => void = () => undefined,
): Record<string, unknown> {
  const candidate = structuredClone(hashableCapabilities()) as unknown as Record<string, unknown>;
  mutate(candidate);
  return { ...candidate, document_hash: hashCanonical(candidate) };
}

function capabilityBytes(
  mutate: (candidate: Record<string, unknown>) => void = () => undefined,
): string {
  return canonicalJson(capabilityDocument(mutate));
}

describe("agentgateway capability contract", () => {
  it("parses, hashes, and deeply freezes one equivalent-route capability document", () => {
    const bytes = capabilityBytes();
    const result = parseAgentgatewayCapabilities(bytes, { now });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.routes).toHaveLength(2);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.routes)).toBe(true);
      expect(Object.isFrozen(result.value.routes[0]?.capabilities)).toBe(true);
      expect(hashAgentgatewayCapabilities(result.value)).toBe(result.value.document_hash);
    }
  });

  it("rejects duplicate JSON keys and capability bytes above 512 KiB", () => {
    const valid = capabilityBytes();
    expect(
      parseAgentgatewayCapabilities(valid.replace("{", '{"protocol_version":"duplicate",'), {
        now,
      }).ok,
    ).toBe(false);
    expect(parseAgentgatewayCapabilities(new Uint8Array(512 * 1024 + 1), { now }).ok).toBe(false);
  });

  it.each([
    [
      "unknown field",
      (value: Record<string, unknown>) => {
        value.native_routes = [];
      },
    ],
    [
      "empty routes",
      (value: Record<string, unknown>) => {
        value.routes = [];
      },
    ],
    [
      "too many routes",
      (value: Record<string, unknown>) => {
        const route = (value.routes as Record<string, unknown>[])[0]!;
        value.routes = Array.from({ length: 257 }, (_, index) => ({
          ...route,
          route_id: `route-${index}`,
        }));
      },
    ],
    [
      "duplicate route IDs",
      (value: Record<string, unknown>) => {
        const routes = value.routes as Record<string, unknown>[];
        routes[1]!.route_id = routes[0]!.route_id;
      },
    ],
    [
      "provider mismatch",
      (value: Record<string, unknown>) => {
        const route = (value.routes as Record<string, unknown>[])[0]!;
        (route.capabilities as Record<string, unknown>).provider = "gemini";
      },
    ],
    [
      "invalid chronology",
      (value: Record<string, unknown>) => {
        value.expires_at = value.generated_at;
      },
    ],
    [
      "overlong lifetime",
      (value: Record<string, unknown>) => {
        value.expires_at = "2026-08-20T10:05:00.001Z";
      },
    ],
    [
      "expired document",
      (value: Record<string, unknown>) => {
        value.expires_at = "2026-08-20T10:00:59.999Z";
      },
    ],
    [
      "negative limit",
      (value: Record<string, unknown>) => {
        const route = (value.routes as Record<string, unknown>[])[0]!;
        (route.capabilities as Record<string, unknown>).max_output_tokens = -1;
      },
    ],
    [
      "unsafe limit",
      (value: Record<string, unknown>) => {
        const route = (value.routes as Record<string, unknown>[])[0]!;
        (route.capabilities as Record<string, unknown>).max_context_tokens = 9_007_199_254_740_992;
      },
    ],
    [
      "unsupported provider",
      (value: Record<string, unknown>) => {
        const route = (value.routes as Record<string, unknown>[])[0]!;
        route.provider = "native-provider";
        (route.capabilities as Record<string, unknown>).provider = "native-provider";
      },
    ],
  ] as const)("rejects %s", (_name, mutate) => {
    expect(parseAgentgatewayCapabilities(capabilityBytes(mutate), { now }).ok).toBe(false);
  });

  it("rejects a document hash that is not bound to the canonical capability bytes", () => {
    const candidate = capabilityDocument() as unknown as AgentgatewayCapabilitiesV1;
    const bytes = canonicalJson({ ...candidate, document_hash: `sha256:${"f".repeat(64)}` });

    expect(parseAgentgatewayCapabilities(bytes, { now }).ok).toBe(false);
  });
});

describe("agentgateway health contract", () => {
  it("parses and freezes the exact closed health document", () => {
    const result = parseAgentgatewayHealth('{"status":"healthy","revision":7}');

    expect(result).toEqual({ ok: true, value: { status: "healthy", revision: 7 } });
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
  });

  it.each([
    '{"status":"healthy","revision":7,"native":"must-not-leak"}',
    '{"status":"native","revision":7}',
    '{"status":"healthy","revision":-1}',
    '{"status":"healthy","revision":9007199254740992}',
    '{"status":{"toString":"native"},"revision":7}',
    '{"status":"healthy","status":"degraded","revision":7}',
    "not-json",
  ])("rejects malformed or native health bytes", (bytes) => {
    const result = parseAgentgatewayHealth(bytes);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });
});
