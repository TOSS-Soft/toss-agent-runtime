import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createBaselineCapabilities,
  createProtocolValidator,
  createRunJournalStore,
  decideRunTransition,
  hashAgentDefinition,
  hashAgentRegistryEntry,
  hashCompiledContext,
  hashExecutionRequest,
  hashModelCatalog,
  hashModelSelectionPlan,
  hashPromptTemplate,
  hashRoutingPolicy,
  hashRoutingState,
  hashSkillDescriptor,
  hashSkillExecutionEvidence,
  hashSkillSnapshot,
  hashSuperpowersApproval,
  hashSuperpowersPhase,
  type JsonValue,
  parseAgentDefinition,
  parseAgentRegistryEntry,
  parseCompiledContext,
  parseExecutionEvent,
  parseExecutionRequest,
  parseExecutionResult,
  parseModelCatalog,
  parseModelSelectionPlan,
  parseProviderEvent,
  parsePromptTemplate,
  parseRoutingPolicy,
  parseRoutingState,
  parseRuntimeCapabilities,
  parseSkillDescriptor,
  parseSkillExecutionEvidence,
  parseSkillSnapshot,
  parseSuperpowersApproval,
  parseSuperpowersPhase,
  sha256,
  validateExecutionChain,
  ZERO_JOURNAL_HASH,
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

interface ContractSchemaCandidate {
  readonly schema_version: string;
  readonly path: string;
  readonly id: string;
}

async function readContractManifest(): Promise<ContractManifest> {
  return JSON.parse(
    await readFile("docs/contracts/runtime-contract-v1.manifest.json", "utf8"),
  ) as ContractManifest;
}

async function readContractSchemaCandidates(): Promise<readonly ContractSchemaCandidate[]> {
  const suffix = ".schema.json";
  const filenames = (await readdir("contracts/runtime"))
    .filter((filename) => filename.endsWith(suffix))
    .sort();

  return Promise.all(
    filenames.map(async (filename) => {
      const path = `contracts/runtime/${filename}`;
      const schema = JSON.parse(await readFile(path, "utf8")) as ContractSchema;
      if (schema.$id === undefined) {
        throw new Error(`Contract schema has no identifier: ${path}`);
      }
      return {
        schema_version: filename.slice(0, -suffix.length),
        path,
        id: schema.$id,
      };
    }),
  );
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

  it("keeps every advertised and generically registered schema coherent with the manifest", async () => {
    const manifest = await readContractManifest();
    const validator = createProtocolValidator();
    const candidates = await readContractSchemaCandidates();

    for (const candidate of candidates) {
      const probe = validator.parse(
        JSON.stringify({
          schema_version: candidate.schema_version,
          document_type: "manifest-probe",
        }),
        "manifest-probe",
      );
      if (!probe.ok && probe.code === "RUNTIME_DOCUMENT_UNSUPPORTED") {
        continue;
      }

      const matches = manifest.schemas.filter(
        (entry) => entry.schema_version === candidate.schema_version,
      );
      expect(matches, candidate.schema_version).toEqual([candidate]);
    }

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
      "skill-descriptor.v1",
      "skill-execution-evidence.v1",
      "skill-snapshot.v1",
      "superpowers-approval.v1",
      "superpowers-phase.v1",
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

  it("loads all five Agent Skills examples through their public hash-bound parsers", async () => {
    const descriptor = parseSkillDescriptor(await readExample("skill-descriptor"));
    const snapshot = parseSkillSnapshot(await readExample("skill-snapshot"));
    const phase = parseSuperpowersPhase(await readExample("superpowers-phase"));
    const approval = parseSuperpowersApproval(await readExample("superpowers-approval"));
    const evidence = parseSkillExecutionEvidence(await readExample("skill-execution-evidence"));

    expect(descriptor.ok && snapshot.ok && phase.ok && approval.ok && evidence.ok).toBe(true);
    if (descriptor.ok && snapshot.ok && phase.ok && approval.ok && evidence.ok) {
      expect(hashSkillDescriptor(descriptor.value)).toBe(descriptor.value.document_hash);
      expect(hashSkillSnapshot(snapshot.value)).toBe(snapshot.value.document_hash);
      expect(hashSuperpowersPhase(phase.value)).toBe(phase.value.document_hash);
      expect(hashSuperpowersApproval(approval.value)).toBe(approval.value.document_hash);
      expect(hashSkillExecutionEvidence(evidence.value)).toBe(evidence.value.document_hash);
      expect(snapshot.value.descriptor).toEqual(descriptor.value);
      expect(evidence.value.journal_path).toHaveLength(3);
    }
  });

  it("links the approval example to one canonical pending brainstorming transaction", async () => {
    const phase = parseSuperpowersPhase(await readExample("superpowers-phase"));
    const approval = parseSuperpowersApproval(await readExample("superpowers-approval"));
    expect(phase.ok && approval.ok).toBe(true);
    if (!phase.ok || !approval.ok) return;

    expect(phase.value.status).toBe("APPROVAL_PENDING");
    expect(approval.value).toMatchObject({
      kind: "REQUEST",
      run_id: phase.value.run_id,
      phase_document_hash: phase.value.document_hash,
      phase: phase.value.phase,
      skill_name: phase.value.skill.name,
      skill_version: phase.value.skill.version,
      skill_snapshot_hash: phase.value.skill.snapshot_hash,
      phase_operation_id: phase.value.operation_id,
      decision: null,
      trace: phase.value.trace,
    });

    const history = [];
    for (const state of ["CREATED", "ROUTED", "RUNNING"] as const) {
      const previous = history.at(-1);
      const transition = decideRunTransition(
        history,
        {
          run_id: phase.value.run_id,
          expected_revision: previous?.journal_revision ?? 0,
          expected_head_hash: previous?.entry_hash ?? ZERO_JOURNAL_HASH,
          command_id: `approval-example-${state.toLowerCase()}`,
          operation_id: null,
          next_state: state,
          reason_code: `EXAMPLE_${state}`,
          trace: phase.value.trace,
          metadata: {},
          side_effect: null,
        },
        () => new Date(phase.value.occurred_at),
      );
      expect(transition.kind).toBe("append");
      if (transition.kind !== "append") return;
      history.push(transition.entry);
    }
    const running = history.at(-1)!;
    expect(phase.value.observed_journal_head).toEqual({
      journal_revision: running.journal_revision,
      sequence: running.sequence,
      entry_hash: running.entry_hash,
    });

    const operationHash = sha256({
      kind: "superpowers-approval-pending",
      run_id: phase.value.run_id,
      operation_id: phase.value.operation_id,
    });
    const pending = decideRunTransition(
      history,
      {
        run_id: phase.value.run_id,
        expected_revision: phase.value.observed_journal_head.journal_revision,
        expected_head_hash: phase.value.observed_journal_head.entry_hash,
        command_id: `approval-pending:${operationHash}`,
        operation_id: phase.value.operation_id,
        next_state: "APPROVAL_PENDING",
        reason_code: "SUPERPOWERS_APPROVAL_REQUIRED",
        trace: phase.value.trace,
        metadata: {
          kind: "superpowers-approval-pending",
          phase: phase.value as unknown as JsonValue,
        },
        side_effect: null,
      },
      () => new Date(phase.value.occurred_at),
    );
    expect(pending.kind).toBe("append");
    if (pending.kind !== "append") return;
    expect(pending.entry.state).toBe("APPROVAL_PENDING");
    expect(approval.value.pending_journal_head).toEqual({
      journal_revision: pending.entry.journal_revision,
      sequence: pending.entry.sequence,
      entry_hash: pending.entry.entry_hash,
    });
  });

  it("loads the accepted agent-context examples through the package-root parsers with exact bindings", async () => {
    const request = parseExecutionRequest(await readExample("agent-context-execution-request"));
    const prompt = parsePromptTemplate(await readExample("prompt-template"));
    const definition = parseAgentDefinition(await readExample("agent-definition"));
    const registryEntry = parseAgentRegistryEntry(await readExample("agent-registry-entry"));
    const context = parseCompiledContext(await readExample("compiled-context"));

    expect(request.ok && prompt.ok && definition.ok && registryEntry.ok && context.ok).toBe(true);
    if (request.ok && prompt.ok && definition.ok && registryEntry.ok && context.ok) {
      expect(hashExecutionRequest(request.value)).toBe(
        "sha256:1b36f5f38a4f2ac2b89381a1847ded1e3ebc5d9539e6f11d190bfe0568f5de30",
      );
      expect(hashPromptTemplate(prompt.value)).toBe(prompt.value.document_hash);
      expect(hashAgentDefinition(definition.value)).toBe(definition.value.document_hash);
      expect(hashAgentRegistryEntry(registryEntry.value)).toBe(registryEntry.value.entry_hash);
      expect(hashCompiledContext(context.value)).toBe(context.value.document_hash);

      const promptReference = {
        document_type: "prompt-template",
        artifact_id: prompt.value.template_id,
        revision: prompt.value.revision,
        hash: prompt.value.document_hash,
      } as const;
      const definitionReference = {
        document_type: "agent-definition",
        artifact_id: definition.value.agent_id,
        revision: definition.value.revision,
        hash: definition.value.document_hash,
      } as const;

      expect(prompt.value.document_hash).toBe(
        "sha256:be559a32cd3dc45c9652b9c2f6505842f757067d67de26a7f192d429628f1f3b",
      );
      expect(definition.value.document_hash).toBe(
        "sha256:dcbb6bf855f06ab5e183773287e71565b26305bfdf646649a3fec92be1854f7c",
      );
      expect(registryEntry.value.entry_hash).toBe(
        "sha256:3c13d4027e25aa78a1df9a042b78635ed8c212a4838b500d07b47e25837f1a58",
      );
      expect(context.value.document_hash).toBe(
        "sha256:cf59f980a71a31958daf9d386c5d26b6536d87de3e87aead121c4c8e9f22b5ef",
      );
      expect(definition.value.prompt_template).toEqual(promptReference);
      expect(registryEntry.value.definition).toEqual(definitionReference);
      expect(registryEntry.value.prompt_template).toEqual(promptReference);
      expect(context.value.definition).toEqual(definitionReference);
      expect(context.value.prompt_template).toEqual(promptReference);
      expect(context.value.request_hash).toBe(hashExecutionRequest(request.value));
      expect(request.value.agent.definition).toEqual(definitionReference);
      expect(request.value.agent.definition).toEqual(context.value.definition);
      expect(request.value.agent.role).toBe(definition.value.role);
      expect(request.value.task_contract).toEqual(definition.value.task_contracts[0]);
      expect(context.value.task_contract).toEqual(definition.value.task_contracts[0]);
      expect(request.value.task_contract).toEqual(context.value.task_contract);
      expect(request.value.output.schema).toEqual(definition.value.output_schemas[0]);
      expect(context.value.output_schema).toEqual(definition.value.output_schemas[0]);
      expect(request.value.output.schema).toEqual(context.value.output_schema);
      expect(request.value.model.logical_class).toBe(definition.value.model.logical_class);
      expect(context.value.authority.logical_class).toBe(definition.value.model.logical_class);
      expect(context.value.authority.logical_class).toBe(request.value.model.logical_class);
      expect(request.value.model.required_capabilities).toEqual(["text", "tools"]);
      expect(context.value.authority.model_capabilities).toEqual(
        request.value.model.required_capabilities,
      );
      for (const capability of definition.value.model.required_capabilities) {
        expect(request.value.model.required_capabilities).toContain(capability);
      }
      for (const capability of request.value.model.required_capabilities) {
        expect(definition.value.model.allowed_capabilities).toContain(capability);
      }
      expect(request.value.superpowers.required).toEqual(definition.value.superpowers.required);
      expect(context.value.authority.superpowers).toEqual(request.value.superpowers.required);
      expect(request.value.mcp.profile).toEqual(definition.value.mcp_profiles[0]);
      expect(context.value.authority.mcp_profile).toEqual(definition.value.mcp_profiles[0]);
      expect(context.value.authority.mcp_profile).toEqual(request.value.mcp.profile);
      expect(request.value.budget).toEqual({
        max_input_tokens: 24_000,
        max_output_tokens: 3_000,
        max_cost_microusd: 400_000,
        max_duration_ms: 500_000,
        max_turns: 7,
      });
      expect(definition.value.budget_ceiling).toEqual({
        max_input_tokens: 32_000,
        max_output_tokens: 4_000,
        max_cost_microusd: 500_000,
        max_duration_ms: 600_000,
        max_turns: 8,
      });
      expect(context.value.authority.budget).toEqual(request.value.budget);
      for (const budgetKey of Object.keys(
        request.value.budget,
      ) as readonly (keyof typeof request.value.budget)[]) {
        expect(request.value.budget[budgetKey]).toBeLessThanOrEqual(
          definition.value.budget_ceiling[budgetKey],
        );
      }
      expect(request.value.input_artifacts).toEqual([
        {
          document_type: "source-artifact",
          artifact_id: "SOURCE-ONE",
          revision: 1,
          hash: "sha256:b73e73471433d1c2262f913cbc7eef547cfe3bd191fbb5f1a90382bd2f611863",
        },
        {
          document_type: "source-artifact",
          artifact_id: "SOURCE-TWO",
          revision: 2,
          hash: "sha256:d1051d2b34615a0756d304a9e0744f9021c59196c446795503210321d172bd3c",
        },
      ]);
      expect(
        context.value.segments
          .filter((segment) => segment.kind === "input-artifact")
          .map((segment) => segment.source),
      ).toEqual(request.value.input_artifacts);
    }
  });

  it("documents the normative agent authority, lifecycle, compiler, and downstream boundaries", async () => {
    const readme = await readFile("README.md", "utf8");
    const protocolContract = await readFile(
      "docs/contracts/runtime-contract-protocol-v1.md",
      "utf8",
    );
    const changelog = await readFile("CHANGELOG.md", "utf8");
    const combined = `${readme}\n${protocolContract}\n${changelog}`;
    const protocolProse = protocolContract.replaceAll(/\s+/gu, " ");
    const combinedProse = combined.replaceAll(/\s+/gu, " ");

    expect(protocolContract).toContain("Agent definition registry and compiled context");
    expect(combinedProse).toMatch(/TOSS control plane.*?(?:sole|only).*?authority/iu);
    expect(protocolProse).toMatch(/ACTIVE.*?new execution/iu);
    expect(protocolProse).toMatch(/retained.*?(?:retired )?revision.*?resume/iu);
    expect(protocolContract).toContain("`trusted-runtime`");
    expect(protocolContract).toContain("`trusted-control`");
    expect(protocolContract).toContain("`untrusted-content`");
    expect(protocolProse).toMatch(
      /runtime safety.*?Task Contract.*?prompt-template.*?output contract.*?input artifacts/iu,
    );
    expect(protocolProse).toMatch(/one UTF-8 byte.*?one conservative input token/iu);
    expect(protocolProse).toMatch(/trusted.*?never truncated/iu);
    expect(protocolProse).toMatch(/final eligible untrusted segment.*?Unicode scalar boundary/iu);
    expect(combinedProse).toMatch(/illustrative.*?not writable (?:local )?configuration/iu);
    expect(combinedProse).toMatch(/Issue #7.*?advertises.*?schemas only/iu);
    for (const boundary of [
      "Agent Skills",
      "Superpowers",
      "MCP tools",
      "providers",
      "agent loop",
    ]) {
      expect(combinedProse).toMatch(
        new RegExp(`Issue #7.*?(?:does not|MUST NOT).*?${boundary}`, "iu"),
      );
    }
    expect(combinedProse).toMatch(/Issue #8.*?owns.*?(?:Agent Skills|skill)/iu);
    expect(combinedProse).toMatch(/Issue #9.*?owns.*?(?:MCP|tool)/iu);
    expect(combinedProse).toMatch(/Issue #10.*?owns.*?(?:provider|agent loop)/iu);
  });

  it("documents the complete Agent Skills trust, approval, evidence, and release boundary", async () => {
    const protocol = await readFile("docs/contracts/runtime-contract-protocol-v1.md", "utf8");
    const control = await readFile("docs/contracts/local-service-control-v1.md", "utf8");
    const compatibility = await readFile("docs/contracts/toss-cli-v2.2-compatibility.md", "utf8");
    const architecture = await readFile(
      "docs/superpowers/specs/2026-08-19-v1-runtime-architecture-design.md",
      "utf8",
    );
    const readme = await readFile("README.md", "utf8");
    const changelog = await readFile("CHANGELOG.md", "utf8");
    const combined = [protocol, control, compatibility, architecture, readme, changelog]
      .join("\n")
      .replaceAll(/\s+/gu, " ");

    for (const requirement of [
      /metadata-only discovery/iu,
      /explicit(?:ly configured)? private per-user skill roots/iu,
      /project-local `?\.agents\/skills`?.*?(?:never|not).*?auto-discover/iu,
      /full `?SKILL\.md`?.*?only after.*?exact.*?selection/iu,
      /canonical.*?containment/iu,
      /private same-user.*?local.*?socket.*?exact.*?binding/iu,
      /restart.*?replay/iu,
      /skill scripts.*?(?:never executed|not executed)/iu,
      /BLOCKED_SUPERPOWERS_MISSING/u,
      /journal_path.*?catalog.*?snapshot.*?phase.*?approval/iu,
      /latest Node\.js LTS.*?macOS/iu,
    ]) {
      expect(combined).toMatch(requirement);
    }
    expect(architecture).not.toMatch(/Development execution may use an[\s\S]*?allowlist/iu);
    expect(changelog).not.toContain(
      "Agent Skills and Superpowers execution remain pending Issue #8",
    );
    const releaseDocs = [architecture, readme, changelog].join("\n").replaceAll(/\s+/gu, " ");
    expect(releaseDocs).not.toMatch(
      /\bNode(?:\.js)?\s*22\s*(?:\/|and|,)\s*(?:Node(?:\.js)?\s*)?24\b/iu,
    );
    expect(releaseDocs).not.toMatch(
      /(?:\b(?:Node(?:\.js)? Current|Current Node(?:\.js)?)\b.{0,80}\b(?:CI|lane|matrix|release)\b|\b(?:CI|lane|matrix|release)\b.{0,80}\b(?:Node(?:\.js)? Current|Current Node(?:\.js)?)\b)/iu,
    );
    expect(releaseDocs).not.toMatch(
      /(?:\b(?:Ubuntu|Linux)\b.{0,80}\b(?:active|mandatory|release|CI)\s+(?:CI\s+)?(?:lane|matrix)\b|\b(?:active|mandatory|release|CI)\s+(?:CI\s+)?(?:lane|matrix)\b.{0,80}\b(?:Ubuntu|Linux)\b)/iu,
    );
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
