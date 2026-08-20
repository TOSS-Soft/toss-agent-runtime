import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOperationalLogReader,
  renderOperationalEventHuman,
  renderOperationalEventsJson,
} from "../src/logging/reader.js";
import { createOperationalLogStore } from "../src/logging/store.js";
import type { OperationalEventV1 } from "../src/logging/types.js";
import { canonicalJson } from "../src/protocol/json.js";

const roots: string[] = [];
const SERVICE_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";

async function fixture(): Promise<{ readonly logsPath: string }> {
  const root = await mkdtemp(path.join(await realpath("/tmp"), "toss-log-reader-"));
  roots.push(root);
  return { logsPath: path.join(root, "logs") };
}

function ids(): () => string {
  let value = 100;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("operational log reader", () => {
  it("filters deterministically while human and JSON views preserve event identity", async () => {
    const { logsPath } = await fixture();
    const store = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: ids(),
    });
    await store.write({
      level: "info",
      component: "supervisor",
      event: "service.ready",
      correlationId: ids()(),
      projectId: PROJECT_ID,
      metadata: { status: "ready" },
      allowedMetadataKeys: ["status"],
    });
    const expected = await store.write({
      level: "error",
      component: "worker",
      event: "run.failed",
      correlationId: ids()(),
      projectId: PROJECT_ID,
      runId: RUN_ID,
      metadata: { reason_code: "PROVIDER_TIMEOUT" },
      allowedMetadataKeys: ["reason_code"],
    });

    const reader = createOperationalLogReader({ logsPath });
    const result = reader.read({ level: "warn", projectId: PROJECT_ID, runId: RUN_ID });

    expect(result.events).toEqual([expected]);
    expect(JSON.parse(renderOperationalEventsJson(result.events))).toMatchObject({
      events: [{ event_id: expected.event_id }],
    });
    expect(renderOperationalEventHuman(expected)).toContain(expected.event_id);
    expect(renderOperationalEventHuman(expected)).toContain("run.failed");
  });

  it("follows across rotation without duplicating the hard-linked active event", async () => {
    const { logsPath } = await fixture();
    let now = new Date("2026-08-20T23:59:59.000Z");
    const store = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => now,
      randomId: ids(),
    });
    const first = await store.write({
      level: "info",
      component: "supervisor",
      event: "service.ready",
      correlationId: ids()(),
    });
    const controller = new AbortController();
    const reader = createOperationalLogReader({
      logsPath,
      wait: async () => Promise.resolve(),
    });
    const followed: string[] = [];
    let secondId: string | undefined;

    for await (const event of reader.follow({}, controller.signal)) {
      followed.push(event.event_id);
      if (followed.length === 1) {
        now = new Date("2026-08-21T00:00:00.000Z");
        const second = await store.write({
          level: "info",
          component: "supervisor",
          event: "service.still-ready",
          correlationId: ids()(),
        });
        secondId = second.event_id;
      } else {
        controller.abort();
      }
    }

    expect(followed).toEqual([first.event_id, secondId]);
  });

  it("rejects canonical lines with a service sequence gap", async () => {
    const { logsPath } = await fixture();
    const store = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: ids(),
    });
    await store.write({
      level: "info",
      component: "supervisor",
      event: "service.starting",
      correlationId: ids()(),
    });
    await store.write({
      level: "info",
      component: "supervisor",
      event: "service.ready",
      correlationId: ids()(),
    });
    const active = path.join(logsPath, "operational-current.jsonl");
    const lines = (await readFile(active, "utf8")).trim().split("\n");
    const second = JSON.parse(lines[1]!) as OperationalEventV1;
    await writeFile(active, `${lines[0]}\n${canonicalJson({ ...second, service_sequence: 3 })}\n`, {
      mode: 0o600,
    });

    expect(() => createOperationalLogReader({ logsPath }).read({})).toThrowError(
      expect.objectContaining({ code: "RUNTIME_LOGGING_CORRUPT" }),
    );
  });
});
