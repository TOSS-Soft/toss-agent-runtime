import { describe, expect, it } from "vitest";

import {
  createBaselineCapabilities,
  negotiateRequest,
  parseRuntimeCapabilities,
} from "../src/protocol/capabilities.js";
import { canonicalJson } from "../src/protocol/json.js";
import { validateExecutionChain } from "../src/protocol/result.js";
import { loadValidChain } from "./support/protocol-fixtures.js";

describe("Runtime Contract Protocol v1 chain", () => {
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

  it("reports every future subsystem as unavailable in the baseline", () => {
    const document = createBaselineCapabilities({ os: "linux", arch: "x64", node: "22.23.1" });
    expect(document.execution_topologies).toEqual([]);
    expect(document.model_classes).toEqual([]);
    expect(document.features).toEqual({
      providers: "unavailable",
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
