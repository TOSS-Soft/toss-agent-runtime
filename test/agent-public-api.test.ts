import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, expectTypeOf, it } from "vitest";

import * as agentApi from "../src/agents/index.js";
import * as packageApi from "../src/index.js";
import type {
  AgentArtifactReference,
  AgentBudgetClass,
  AgentCapability,
  AgentContextPolicyV1,
  AgentDefinitionBundle,
  AgentDefinitionReference,
  AgentDefinitionV1,
  AgentLogicalModelClass,
  AgentRegistration,
  AgentRegistry,
  AgentRegistryEntryV1,
  AgentRole,
  CompiledContextSegmentV1,
  CompiledContextV1,
  CompileAgentContextInput,
  ContextArtifactResolver,
  CreateAgentRegistryOptions,
  EffectiveAgentAuthority,
  HashableAgentDefinitionV1,
  HashableAgentRegistryEntryV1,
  HashableCompiledContextV1,
  HashablePromptTemplateV1,
  InputArtifactSegmentV1,
  McpProfileReference,
  OutputSchemaReference,
  OutputSchemaSegmentV1,
  PromptTemplateReference,
  PromptTemplateSegmentV1,
  PromptTemplateV1,
  ResolvedAgentBundle,
  ResolvedContextArtifact,
  RuntimeAgentErrorCode,
  RuntimeSafetySegmentV1,
  TaskContractReference,
  TaskContractSegmentV1,
} from "../src/index.js";

const PUBLIC_AGENT_VALUES = [
  "RuntimeAgentError",
  "compileAgentContext",
  "createAgentRegistry",
  "hashAgentDefinition",
  "hashAgentRegistryEntry",
  "hashCompiledContext",
  "hashPromptTemplate",
  "matchAgentAuthority",
  "parseAgentDefinition",
  "parseAgentRegistryEntry",
  "parseCompiledContext",
  "parsePromptTemplate",
] as const;

const PRIVATE_AGENT_NAMES = [
  "AGENT_DOCUMENT_LIMITS",
  "AgentRegistryInternalDependencies",
  "AgentRegistryOperationHooks",
  "COMPILED_CONTEXT_RUNTIME_POLICY_V1",
  "CreatePrivateAgentStoreOptions",
  "MAX_PRIVATE_OBJECT_BYTES",
  "PrivateAgentStore",
  "PrivateAgentStoreOperationHooks",
  "PrivateFileIdentity",
  "PrivateMutationClaim",
  "PrivateObjectSnapshot",
  "PrivateStoreListenerState",
  "PrivateStoreProcessLiveness",
  "agentDefinitionValidator",
  "agentRegistryEntryValidator",
  "compiledContextValidator",
  "createAgentRegistryForTest",
  "createPrivateAgentStore",
  "fixtureAgentDefinition",
  "fixtureCompiledContext",
  "fixturePromptTemplate",
  "promptTemplateValidator",
  "requireAgentRegistry",
] as const;

type PublicAgentTypeSurface = readonly [
  AgentArtifactReference<string>,
  AgentBudgetClass,
  AgentCapability,
  AgentContextPolicyV1,
  AgentDefinitionBundle,
  AgentDefinitionReference,
  AgentDefinitionV1,
  AgentLogicalModelClass,
  AgentRegistration,
  AgentRegistry,
  AgentRegistryEntryV1,
  AgentRole,
  CompiledContextSegmentV1,
  CompiledContextV1,
  CompileAgentContextInput,
  ContextArtifactResolver,
  CreateAgentRegistryOptions,
  EffectiveAgentAuthority,
  HashableAgentDefinitionV1,
  HashableAgentRegistryEntryV1,
  HashableCompiledContextV1,
  HashablePromptTemplateV1,
  InputArtifactSegmentV1,
  McpProfileReference,
  OutputSchemaReference,
  OutputSchemaSegmentV1,
  PromptTemplateReference,
  PromptTemplateSegmentV1,
  PromptTemplateV1,
  ResolvedAgentBundle,
  ResolvedContextArtifact,
  RuntimeAgentErrorCode,
  RuntimeSafetySegmentV1,
  TaskContractReference,
  TaskContractSegmentV1,
];

describe("agent package public API", () => {
  it("publishes exactly the safe agent runtime values at the package top level", () => {
    expect(Object.keys(agentApi).sort()).toEqual([...PUBLIC_AGENT_VALUES].sort());
    for (const name of PUBLIC_AGENT_VALUES) {
      expect(packageApi[name]).toBe(agentApi[name]);
    }
  });

  it("publishes the immutable agent domain type surface", () => {
    expectTypeOf<PublicAgentTypeSurface>().toMatchTypeOf<readonly unknown[]>();
  });

  it("keeps private storage, claims, validators, policy internals, and test helpers absent", () => {
    for (const privateName of PRIVATE_AGENT_NAMES) {
      expect(agentApi).not.toHaveProperty(privateName);
      expect(packageApi).not.toHaveProperty(privateName);
    }
  });

  it("keeps private agent modules blocked by the package export boundary", () => {
    expect(() => import.meta.resolve("@toss-software/agent-runtime/agents/private-store")).toThrow(
      expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
    );
    expect(() =>
      import.meta.resolve("@toss-software/agent-runtime/src/agents/private-store.js"),
    ).toThrow(expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }));
  });

  it(
    "emits a public declaration graph without private agent dependencies",
    { timeout: 30_000 },
    () => {
      const declarationRoot = mkdtempSync(path.join(tmpdir(), "toss-agent-public-api-"));
      try {
        execFileSync(
          process.execPath,
          [
            "node_modules/typescript/bin/tsc",
            "-p",
            "tsconfig.build.json",
            "--emitDeclarationOnly",
            "--declarationMap",
            "false",
            "--outDir",
            declarationRoot,
          ],
          { cwd: process.cwd(), stdio: "pipe" },
        );

        const publicDeclarations = ["src/index.d.ts", "src/agents/index.d.ts"]
          .map((candidate) => readFileSync(path.join(declarationRoot, candidate), "utf8"))
          .join("\n");

        for (const privateName of PRIVATE_AGENT_NAMES) {
          expect(publicDeclarations).not.toContain(privateName);
        }
        const registryDeclaration = readFileSync(
          path.join(declarationRoot, "src/agents/registry.d.ts"),
          "utf8",
        );
        expect(registryDeclaration).not.toContain("./private-store.js");
        expect(registryDeclaration).not.toContain("PrivateAgentStore");
        expect(registryDeclaration).not.toContain("PrivateMutationClaim");
      } finally {
        rmSync(declarationRoot, { recursive: true, force: true });
      }
    },
  );
});
