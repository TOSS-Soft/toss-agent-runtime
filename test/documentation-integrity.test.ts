import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
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

    expect(readme).toContain("toss-runtime service install");
    expect(readme).toContain("does not start the service");
    expect(contract).toContain("0600");
    expect(contract).toContain("RUNTIME_SERVICE_ALREADY_RUNNING");
    expect(contract).toContain("Uninstall preserves");
  });
});
