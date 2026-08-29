import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createBaselineCapabilities,
  createProtocolValidator,
  createRunJournalStore,
  hashModelCatalog,
  hashModelSelectionPlan,
  hashRoutingPolicy,
  hashRoutingState,
  parseExecutionEvent,
  parseExecutionRequest,
  parseExecutionResult,
  parseModelCatalog,
  parseModelSelectionPlan,
  parseProviderEvent,
  parseRoutingPolicy,
  parseRoutingState,
  parseRuntimeCapabilities,
  validateExecutionChain,
} from "../src/index.js";

interface ContractManifest {
  readonly schema_version: "runtime-contract-manifest.v1";
  readonly protocol_version: "runtime-contract.v1";
  readonly schemas: readonly {
    readonly schema_version: string;
    readonly path: string;
    readonly id: string;
  }[];
}

interface ContractSchema {
  readonly $schema?: string;
  readonly $id?: string;
  readonly type?: string;
  readonly additionalProperties?: boolean;
  readonly oneOf?: readonly {
    readonly type?: string;
    readonly unevaluatedProperties?: boolean;
  }[];
  readonly $defs?: Readonly<Record<string, unknown>>;
}

const AGENT_SCHEMA_VERSIONS = [
  "agent-definition.v1",
  "agent-registry-entry.v1",
  "compiled-context.v1",
  "prompt-template.v1",
] as const;

async function readContractManifest(): Promise<ContractManifest> {
  return JSON.parse(
    await readFile("docs/contracts/runtime-contract-v1.manifest.json", "utf8"),
  ) as ContractManifest;
}

async function readExample(name: string): Promise<Uint8Array> {
  return readFile(`examples/runtime-contract-v1/${name}.json`);
}

describe("published protocol artifacts", () => {
  it("keeps the lockfile root platform metadata aligned with the macOS-only package", async () => {
    const packageManifest = JSON.parse(await readFile("package.json", "utf8")) as {
      readonly os: readonly string[];
    };
    const lockfile = JSON.parse(await readFile("package-lock.json", "utf8")) as {
      readonly packages: Readonly<Record<string, { readonly os?: readonly string[] }>>;
    };

    expect(packageManifest.os).toEqual(["darwin"]);
    expect(lockfile.packages[""]?.os).toEqual(packageManifest.os);
  });

  it("keeps the packaged capability example aligned with baseline schemas", async () => {
    const result = parseRuntimeCapabilities(await readExample("runtime-capabilities"));
    const baseline = createBaselineCapabilities({ os: "linux", arch: "x64", node: "22.23.1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.supported_schemas).toEqual(baseline.supported_schemas);
      expect(result.value.model_classes).toEqual(baseline.model_classes);
      expect(result.value.features).toEqual(baseline.features);
      expect(result.value.execution_topologies).toEqual([]);
    }
  });

  it("loads the complete example chain through the public package API", async () => {
    const request = parseExecutionRequest(await readExample("execution-request"));
    const event = parseExecutionEvent(await readExample("execution-event"));
    const providerEvent = parseProviderEvent(await readExample("provider-event"));
    const result = parseExecutionResult(await readExample("execution-result"));
    const capabilities = parseRuntimeCapabilities(await readExample("runtime-capabilities"));

    expect(request.ok && event.ok && providerEvent.ok && result.ok && capabilities.ok).toBe(true);
    if (request.ok && event.ok && result.ok) {
      expect(
        validateExecutionChain({
          request: request.value,
          events: [event.value],
          result: result.value,
        }),
      ).toEqual({ ok: true, value: true });
    }
  });

  it("keeps every advertised and registered agent schema coherent with the manifest", async () => {
    const manifest = await readContractManifest();
    const advertised = createBaselineCapabilities({
      os: "linux",
      arch: "x64",
      node: "22.23.1",
    }).supported_schemas;
    const advertisedManifestVersions = manifest.schemas
      .filter((entry) => advertised.includes(entry.schema_version))
      .map((entry) => entry.schema_version);

    expect(advertisedManifestVersions).toEqual(advertised);
    expect(new Set(advertisedManifestVersions).size).toBe(advertised.length);

    const validator = createProtocolValidator();
    for (const schemaVersion of AGENT_SCHEMA_VERSIONS) {
      expect(advertised).toContain(schemaVersion);
      const matches = manifest.schemas.filter((entry) => entry.schema_version === schemaVersion);
      const expectedPath = `contracts/runtime/${schemaVersion}.schema.json`;
      const expectedId = `https://toss.software/schemas/runtime/v1/${schemaVersion}.schema.json`;
      expect(matches).toEqual([
        { schema_version: schemaVersion, path: expectedPath, id: expectedId },
      ]);

      expect(
        validator.parse(
          JSON.stringify({ schema_version: schemaVersion, document_type: "manifest-probe" }),
          "manifest-probe",
        ),
      ).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
    }
  });

  it("maps every published schema version to its exact file and identifier", async () => {
    const manifest = await readContractManifest();
    expect(manifest.schema_version).toBe("runtime-contract-manifest.v1");
    expect(manifest.protocol_version).toBe("runtime-contract.v1");
    const versions = manifest.schemas.map((entry) => entry.schema_version);
    expect(versions).toEqual([...versions].sort());
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([
      "agent-definition.v1",
      "agent-registry-entry.v1",
      "agentgateway-capabilities.v1",
      "candidate-job-intent.v1",
      "command-result.v1",
      "compiled-context.v1",
      "execution-event.v1",
      "execution-request.v1",
      "execution-result.v1",
      "model-catalog.v1",
      "model-selection-plan.v1",
      "operational-event.v1",
      "project-registry-entry.v1",
      "project-watch-manifest.v1",
      "prompt-template.v1",
      "provider-event.v1",
      "routing-policy.v1",
      "routing-state.v1",
      "run-journal-entry.v1",
      "runtime-capabilities.v1",
      "runtime-common.v1",
      "runtime-config.v1",
      "service-control-request.v1",
      "service-control-response.v1",
      "service-lock.v1",
    ]);
    for (const entry of manifest.schemas) {
      const expectedPath = `contracts/runtime/${entry.schema_version}.schema.json`;
      const expectedId = `https://toss.software/schemas/runtime/v1/${entry.schema_version}.schema.json`;
      expect(entry.path).toBe(expectedPath);
      expect(entry.id).toBe(expectedId);
      const schema = JSON.parse(await readFile(entry.path, "utf8")) as ContractSchema;
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.$id).toBe(expectedId);
      if (entry.schema_version === "runtime-common.v1") {
        expect(schema.$defs).toBeTypeOf("object");
      } else if (schema.type === "object") {
        expect(schema.additionalProperties).toBe(false);
      } else if (schema.oneOf !== undefined) {
        expect(schema.oneOf.length).toBeGreaterThan(0);
        for (const branch of schema.oneOf) {
          expect(branch).toMatchObject({ type: "object", unevaluatedProperties: false });
        }
      } else {
        throw new Error(`Manifest schema is not closed: ${entry.schema_version}`);
      }
    }
  });

  it("loads all four governed routing examples through their public hash-bound parsers", async () => {
    const catalog = parseModelCatalog(await readExample("model-catalog"));
    const policy = parseRoutingPolicy(await readExample("routing-policy"));
    const state = parseRoutingState(await readExample("routing-state"));
    const plan = parseModelSelectionPlan(await readExample("model-selection-plan"));

    expect(catalog.ok && policy.ok && state.ok && plan.ok).toBe(true);
    if (catalog.ok && policy.ok && state.ok && plan.ok) {
      expect(hashModelCatalog(catalog.value)).toBe(catalog.value.document_hash);
      expect(hashRoutingPolicy(policy.value)).toBe(policy.value.document_hash);
      expect(hashRoutingState(state.value)).toBe(state.value.document_hash);
      expect(hashModelSelectionPlan(plan.value)).toBe(plan.value.document_hash);
      expect(plan.value.catalog_hash).toBe(catalog.value.document_hash);
      expect(plan.value.policy_hash).toBe(policy.value.document_hash);
      expect(plan.value.prior_state_hash).toBe(state.value.document_hash);
      expect(plan.value.status).toBe("planned");
    }
  });

  it("documents the complete governed routing boundary without claiming later execution", async () => {
    const readme = await readFile("README.md", "utf8");
    const protocolContract = await readFile(
      "docs/contracts/runtime-contract-protocol-v1.md",
      "utf8",
    );
    const changelog = await readFile("CHANGELOG.md", "utf8");
    const combined = `${readme}\n${protocolContract}\n${changelog}`;

    expect(readme).toContain("## Governed model routing and budgets");
    for (const phrase of [
      "control plane authority",
      "deterministic ordering",
      "capability intersection",
      "independent review planning",
      "integer microusd",
      "circuit_state_chain",
      "outcome witness",
      "explicit fallback",
      "override narrowing",
      "exact route verification",
      "fixed safe routing errors",
    ]) {
      expect(combined.toLowerCase()).toContain(phrase.toLowerCase());
    }
    for (const issue of ["#10", "#11", "#12", "#13", "#15"]) {
      expect(combined).toMatch(new RegExp(`Issue ${issue}[^\\n]*(?:pending|owns|remains)`, "iu"));
    }
    expect(changelog).toContain("Governed model routing");
    expect(changelog).not.toMatch(/Issue #6[^\n]*(?:executes|invokes) (?:a )?provider/iu);
    expect(readme).not.toContain("routing policy and fallback remain later governed layers");
    expect(protocolContract).not.toContain("routing policy and fallback remain later boundaries");
  });

  it("documents explicit service installation and the package side-effect boundary", async () => {
    const readme = await readFile("README.md", "utf8");
    const contract = await readFile("docs/contracts/local-service-control-v1.md", "utf8");
    const packageManifest = JSON.parse(await readFile("package.json", "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const grammar = `toss-runtime service install [--config <absolute-path>] [--json]
toss-runtime service start [--json]
toss-runtime service stop [--json]
toss-runtime service restart [--json]
toss-runtime service status [--json]
toss-runtime service uninstall [--json]`;

    expect(contract).toContain(grammar);
    expect(contract).toContain("Only `service install` accepts `--config`");
    expect(contract).toContain(
      "/usr/bin/systemctl --user show toss-agent-runtime.service --property=LoadState,UnitFileState,ActiveState,SubState,Result,NRestarts,ExecMainStatus --no-pager",
    );
    for (const action of ["start", "stop", "restart", "status", "uninstall"]) {
      expect(grammar).toContain(`toss-runtime service ${action} [--json]`);
      expect(grammar).not.toContain(`service ${action} [--config`);
    }
    expect(readme).toContain("It does not start the service in the current session");
    expect(contract).toMatch(/It does not start the service in\s+the current session/u);

    expect(packageManifest.scripts["test:package:contents"]).toBe(
      "node scripts/package-test.mjs --contents-only",
    );
    expect(packageManifest.scripts.prepack).toBe(
      "npm run format:check && npm run lint && npm run typecheck && npm run build && npm run test:package:contents",
    );
    expect(packageManifest.scripts.prepack).not.toMatch(/\bverify\b|npm test|\bserve\b/u);
    expect(contract).toMatch(
      /`prepack` runs only non-service format, lint, typecheck, build, and\s+package-content acceptance/u,
    );
    expect(contract).toMatch(/must not reach the\s+installed-supervisor smoke or start `serve`/u);

    expect(contract).toMatch(
      /The forced outcome resolves at the configured deadline even if socket close or\s+lock release never settles/u,
    );
    expect(contract).toMatch(
      /close the socket, then release the exact lock, then\s+restore the prior umask/u,
    );
    expect(contract).toMatch(
      /Automatic login-session\s+activation and native crash-loop observation remain platform-integration\s+pending/u,
    );
    expect(contract).toMatch(
      /Production-durable `INTERRUPTED`\s+journal persistence is implemented/u,
    );
    expect(contract).toMatch(/Issue #28 remains open/u);
  });

  it("publishes the durable journal API and removes the issue #1 no-op boundary", async () => {
    const readme = await readFile("README.md", "utf8");
    const serviceContract = await readFile("docs/contracts/local-service-control-v1.md", "utf8");
    const protocolContract = await readFile(
      "docs/contracts/runtime-contract-protocol-v1.md",
      "utf8",
    );
    const changelog = await readFile("CHANGELOG.md", "utf8");

    expect(createRunJournalStore).toBeTypeOf("function");
    expect(readme).toContain("append-only run journals");
    expect(readme).toContain("Active runs are durably recorded as `INTERRUPTED`");
    expect(readme).not.toContain("Issues #1, #29, and #30");
    expect(readme).not.toContain("durable run journals are not implemented");
    expect(serviceContract).toMatch(
      /Production uses the same private run-journal store as both recovery participant\s+and interruption recorder/u,
    );
    expect(serviceContract).not.toContain("Production currently supplies a no-op recorder");
    expect(serviceContract).not.toContain("persistence remains pending issue #1");
    expect(protocolContract).toContain("`run-journal-entry.v1`");
    expect(protocolContract).toContain("RUNTIME_OPERATION_CONFLICT");
    expect(changelog).toContain("Immutable, hash-linked run journals");
    expect(changelog).not.toContain(
      "Production-durable `INTERRUPTED` journal persistence remains pending issue #1",
    );
  });

  it("documents the explicit project intake and candidate-only governance boundary", async () => {
    const readme = await readFile("README.md", "utf8");
    const serviceContract = await readFile("docs/contracts/local-service-control-v1.md", "utf8");
    const protocolContract = await readFile(
      "docs/contracts/runtime-contract-protocol-v1.md",
      "utf8",
    );
    const changelog = await readFile("CHANGELOG.md", "utf8");
    const packageManifest = JSON.parse(await readFile("package.json", "utf8")) as {
      readonly os: readonly string[];
    };

    expect(packageManifest.os).toEqual(["darwin"]);
    expect(readme).toContain("toss-runtime project register <absolute-root> [--json]");
    expect(readme).toContain("schema_version: project-watch-manifest.v1");
    expect(readme).toContain("200 ms");
    expect(readme).toContain("2 second");
    expect(readme).toMatch(/never scans an unregistered project/u);
    expect(readme).toMatch(/candidate job intent/u);
    expect(serviceContract).toContain('`command: "project-register"`');
    expect(serviceContract).toContain("RUNTIME_PROJECT_INTAKE_CORRUPT");
    expect(protocolContract).toContain("`candidate-job-intent.v1`");
    expect(protocolContract).toMatch(/does not authorize\s+execution/u);
    expect(changelog).toContain("Explicit project registry");
  });

  it("publishes the authenticated agentgateway contract and package boundary", async () => {
    const readme = await readFile("README.md", "utf8");
    const protocolContract = await readFile(
      "docs/contracts/runtime-contract-protocol-v1.md",
      "utf8",
    );
    const changelog = await readFile("CHANGELOG.md", "utf8");
    const developmentConfig = await readFile("examples/config/runtime.development.yaml", "utf8");
    const providerEvent = parseProviderEvent(await readExample("provider-event"));
    const expectedPackagedFiles = JSON.parse(
      await readFile("scripts/package-files.json", "utf8"),
    ) as readonly string[];

    expect(readme).toContain("## Authenticated agentgateway transport");
    expect(readme).toContain("production mode is gateway-only");
    expect(readme).toContain("`/healthz`");
    expect(readme).toContain("`/v1/toss/capabilities`");
    expect(readme).toContain("`/v1/responses`");
    expect(readme).toContain("never retries automatically");
    expect(readme).toContain("Protected live-provider and agentgateway smoke remains issue #15");
    expect(protocolContract).toContain("### Authenticated agentgateway transport");
    expect(protocolContract).toContain("x-toss-capability-document-sha256");
    expect(protocolContract).toContain("RUNTIME_PROVIDER_CAPABILITY_DOWNGRADE");
    expect(protocolContract).toContain("redacted-metadata");
    expect(changelog).toContain("Authenticated agentgateway transport");
    expect(changelog).not.toContain("live authenticated provider transport");
    expect(developmentConfig).toContain("protocol: toss-agentgateway.v1");
    expect(developmentConfig).toContain("source: env");
    expect(providerEvent.ok).toBe(true);
    if (providerEvent.ok) {
      expect(providerEvent.value.data).toHaveProperty("route_identity");
    }
    expect(expectedPackagedFiles).toContain(
      "contracts/runtime/agentgateway-capabilities.v1.schema.json",
    );
    expect(expectedPackagedFiles).toContain("dist/src/gateway/transport.js");
    expect(expectedPackagedFiles).not.toContain("test/helpers/fake-agentgateway.js");
  });
});
