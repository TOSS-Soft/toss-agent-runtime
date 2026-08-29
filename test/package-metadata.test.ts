import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

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

const execFile = promisify(execFileCallback);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

interface NpmPackReport {
  readonly files: readonly { readonly path: string }[];
}

async function realDryPackPaths(): Promise<readonly string[]> {
  await execFile(npmCommand, ["run", "build"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const packed = await execFile(npmCommand, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const report = JSON.parse(packed.stdout) as readonly NpmPackReport[];
  expect(report).toHaveLength(1);
  return report[0]!.files.map((entry) => entry.path).sort();
}

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

  it("publishes the exact governed routing schemas, examples, and built modules", async () => {
    const packageFiles = JSON.parse(
      await readFile("scripts/package-files.json", "utf8"),
    ) as readonly string[];
    const routingSchemas = [
      "model-catalog.v1",
      "model-selection-plan.v1",
      "routing-policy.v1",
      "routing-state.v1",
    ];
    for (const schema of routingSchemas) {
      expect(packageFiles).toContain(`contracts/runtime/${schema}.schema.json`);
      expect(packageFiles).toContain(`dist/contracts/runtime/${schema}.schema.json`);
    }
    for (const example of [
      "model-catalog",
      "model-selection-plan",
      "routing-policy",
      "routing-state",
    ]) {
      expect(packageFiles).toContain(`examples/runtime-contract-v1/${example}.json`);
    }
    for (const module of [
      "circuit",
      "contracts",
      "cost",
      "errors",
      "index",
      "resolution",
      "selection",
      "types",
    ]) {
      expect(packageFiles).toContain(`dist/src/routing/${module}.js`);
      expect(packageFiles).toContain(`dist/src/routing/${module}.d.ts`);
    }

    expect(packageFiles).toEqual([...packageFiles].sort());
    expect(packageFiles).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/(?:^|\/)\.superpowers(?:\/|$)/u),
        expect.stringMatching(/(?:^|\/)test\/helpers(?:\/|$)/u),
        expect.stringMatching(/release-evidence/iu),
        expect.stringMatching(/(?:^|\/)(?:\.env|id_rsa|id_ed25519)(?:\.|$)/iu),
      ]),
    );
  });

  it("emits a self-contained public agent registry factory declaration", async () => {
    await execFile(npmCommand, ["run", "build"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const declaration = await readFile("dist/src/agents/index.d.ts", "utf8");

    expect(packageApi.createAgentRegistry).toBeTypeOf("function");
    expect(declaration).toContain("export interface CreateAgentRegistryOptions");
    expect(declaration).toMatch(/export declare function createAgentRegistry\(/u);
    expect(declaration).not.toMatch(/from "\.\/registry\.js"/u);
    expect(declaration).not.toMatch(
      /createAgentRegistryForTest|operationHooks|PrivateAgentStore/iu,
    );
  });

  it("matches the exact real dry-pack allowlist and keeps agent internals private", async () => {
    const expectedFiles = JSON.parse(
      await readFile("scripts/package-files.json", "utf8"),
    ) as readonly string[];
    const packedFiles = await realDryPackPaths();

    expect(packedFiles).toEqual(expectedFiles);
    expect(expectedFiles).toEqual([...expectedFiles].sort());

    for (const schema of [
      "agent-definition.v1",
      "agent-registry-entry.v1",
      "compiled-context.v1",
      "prompt-template.v1",
    ]) {
      expect(packedFiles).toContain(`contracts/runtime/${schema}.schema.json`);
      expect(packedFiles).toContain(`dist/contracts/runtime/${schema}.schema.json`);
    }
    for (const example of [
      "agent-definition",
      "agent-registry-entry",
      "compiled-context",
      "prompt-template",
    ]) {
      expect(packedFiles).toContain(`examples/runtime-contract-v1/${example}.json`);
    }
    for (const publicModule of ["authority", "context", "contracts", "errors", "index", "types"]) {
      expect(packedFiles).toContain(`dist/src/agents/${publicModule}.js`);
      expect(packedFiles).toContain(`dist/src/agents/${publicModule}.d.ts`);
    }
    expect(packedFiles).toEqual(
      expect.arrayContaining([
        "docs/contracts/runtime-contract-protocol-v1.md",
        "dist/src/index.d.ts",
        "dist/src/index.js",
        "dist/src/agents/registry.js",
        "dist/src/agents/private-store.js",
        "dist/src/agents/context.d.ts.map",
        "dist/src/agents/context.js.map",
      ]),
    );

    expect(packedFiles).not.toEqual(
      expect.arrayContaining([
        "dist/src/agents/private-store.d.ts",
        "dist/src/agents/private-store.d.ts.map",
        "dist/src/agents/private-store.js.map",
        "dist/src/agents/registry.d.ts",
        "dist/src/agents/registry.d.ts.map",
        "dist/src/agents/registry.js.map",
      ]),
    );
    for (const packedPath of packedFiles) {
      expect(packedPath).not.toMatch(/(?:^|\/)(?:test|tests|fixtures)(?:\/|$)/iu);
      expect(packedPath).not.toMatch(/(?:^|\/)(?:tmp|temp|staging|claims?|objects?)(?:\/|$)/iu);
      expect(packedPath).not.toMatch(/(?:^|\/)(?:history|operations|registry)\.jsonl$/iu);
      if (/prompt/iu.test(packedPath) && !/\.schema\.json$/u.test(packedPath)) {
        expect(packedPath).toBe("examples/runtime-contract-v1/prompt-template.json");
      }
    }

    const publishedDeclarationsAndMaps = packedFiles.filter(
      (packedPath) =>
        packedPath.startsWith("dist/src/agents/") &&
        /(?:\.d\.ts|\.d\.ts\.map|\.js\.map)$/u.test(packedPath),
    );
    for (const packedPath of publishedDeclarationsAndMaps) {
      const contents = await readFile(packedPath, "utf8");
      expect(contents).not.toMatch(
        /createAgentRegistryForTest|operationHooks|PrivateAgentStore|mutation claim/iu,
      );
    }
  }, 30_000);
});
