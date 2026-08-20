import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createBaselineCapabilities,
  createRunJournalStore,
  parseExecutionEvent,
  parseExecutionRequest,
  parseExecutionResult,
  parseRuntimeCapabilities,
  validateExecutionChain,
} from "../src/index.js";

interface ContractManifest {
  readonly schema_version: "runtime-contract-manifest.v1";
  readonly schemas: readonly {
    readonly schema_version: string;
    readonly path: string;
    readonly id: string;
  }[];
}

async function readExample(name: string): Promise<Uint8Array> {
  return readFile(`examples/runtime-contract-v1/${name}.json`);
}

describe("published protocol artifacts", () => {
  it("keeps the packaged capability example aligned with baseline schemas", async () => {
    const result = parseRuntimeCapabilities(await readExample("runtime-capabilities"));
    const baseline = createBaselineCapabilities({ os: "linux", arch: "x64", node: "22.23.1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.supported_schemas).toEqual(baseline.supported_schemas);
    }
  });

  it("loads the complete example chain through the public package API", async () => {
    const request = parseExecutionRequest(await readExample("execution-request"));
    const event = parseExecutionEvent(await readExample("execution-event"));
    const result = parseExecutionResult(await readExample("execution-result"));
    const capabilities = parseRuntimeCapabilities(await readExample("runtime-capabilities"));

    expect(request.ok && event.ok && result.ok && capabilities.ok).toBe(true);
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

  it("maps every published schema version to its exact file and identifier", async () => {
    const manifest = JSON.parse(
      await readFile("docs/contracts/runtime-contract-v1.manifest.json", "utf8"),
    ) as ContractManifest;
    expect(manifest.schema_version).toBe("runtime-contract-manifest.v1");
    expect(manifest.schemas.map((entry) => entry.schema_version)).toEqual([
      "command-result.v1",
      "execution-event.v1",
      "execution-request.v1",
      "execution-result.v1",
      "run-journal-entry.v1",
      "runtime-capabilities.v1",
      "runtime-common.v1",
      "runtime-config.v1",
      "service-lock.v1",
      "service-control-request.v1",
      "service-control-response.v1",
    ]);
    for (const entry of manifest.schemas) {
      const schema = JSON.parse(await readFile(entry.path, "utf8")) as { readonly $id?: string };
      expect(schema.$id).toBe(entry.id);
    }
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
});
