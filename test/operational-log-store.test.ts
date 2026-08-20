import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOperationalEvent, parseOperationalEvent } from "../src/logging/contracts.js";
import { createOperationalLogStore } from "../src/logging/store.js";
import type { OperationalEventV1 } from "../src/logging/types.js";
import { canonicalJson } from "../src/protocol/json.js";

const roots: string[] = [];
const SERVICE_ID = "00000000-0000-4000-8000-000000000001";
const RESTARTED_SERVICE_ID = "00000000-0000-4000-8000-000000000009";
const CORRELATION_ID = "00000000-0000-4000-8000-000000000002";

async function fixture(): Promise<{ readonly root: string; readonly logsPath: string }> {
  const root = await mkdtemp(path.join(await realpath("/tmp"), "toss-operational-log-"));
  roots.push(root);
  return { root, logsPath: path.join(root, "logs") };
}

function ids(): () => string {
  let id = 10;
  return () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
}

function input(event: string) {
  return {
    level: "info" as const,
    component: "supervisor",
    event,
    correlationId: CORRELATION_ID,
    metadata: { status: "safe" },
    allowedMetadataKeys: ["status"],
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function events(logsPath: string): Promise<readonly OperationalEventV1[]> {
  const files = (await readdir(logsPath))
    .filter((name) => /^operational-(?:current|\d{4}-\d{2}-\d{2}-\d{6})\.jsonl$/u.test(name))
    .sort((left, right) => {
      if (left === "operational-current.jsonl") return 1;
      if (right === "operational-current.jsonl") return -1;
      return left.localeCompare(right);
    });
  const result: OperationalEventV1[] = [];
  for (const file of files) {
    const text = await readFile(path.join(logsPath, file), "utf8");
    for (const line of text.trimEnd().split("\n")) {
      if (line.length === 0) continue;
      const parsed = parseOperationalEvent(line);
      if (!parsed.ok) throw new Error("invalid operational event fixture");
      result.push(parsed.value);
    }
  }
  return result;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("durable operational log store", () => {
  it("serializes concurrent complete lines with private metadata and one sequence", async () => {
    const { logsPath } = await fixture();
    const store = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: ids(),
    });

    const written = await Promise.all([
      store.write(input("service.start")),
      store.write(input("service.ready")),
      store.write(input("service.stop")),
    ]);
    await store.flush(signal());

    expect(written.map((event) => event.service_sequence)).toEqual([1, 2, 3]);
    expect((await events(logsPath)).map((event) => event.event)).toEqual([
      "service.start",
      "service.ready",
      "service.stop",
    ]);
    const active = path.join(logsPath, "operational-current.jsonl");
    await expect(
      (await import("node:fs/promises")).lstat(active).then((value) => value.mode & 0o777),
    ).resolves.toBe(0o600);
    for (const event of await events(logsPath)) {
      expect(parseOperationalEvent(JSON.stringify(event))).toMatchObject({ ok: true });
    }
  });

  it("shares ordering across public stores for one canonical log root", async () => {
    const { logsPath } = await fixture();
    const first = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: ids(),
    });
    const second = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => new Date("2026-08-20T12:00:01.000Z"),
      randomId: ids(),
    });

    await Promise.all([first.write(input("service.start")), second.write(input("service.ready"))]);

    expect((await events(logsPath)).map((event) => event.service_sequence)).toEqual([1, 2]);
  });

  it("starts a restarted service instance at sequence one after rotating the prior active log", async () => {
    const { logsPath } = await fixture();
    await mkdir(logsPath, { mode: 0o700 });
    const prior = createOperationalEvent({
      eventId: "00000000-0000-4000-8000-000000000008",
      timestamp: new Date("2026-08-20T11:00:00.000Z"),
      serviceInstanceId: SERVICE_ID,
      serviceSequence: 5,
      input: input("service.ready"),
    });
    await writeFile(path.join(logsPath, "operational-current.jsonl"), `${canonicalJson(prior)}\n`, {
      mode: 0o600,
    });
    const restarted = createOperationalLogStore({
      logsPath,
      serviceInstanceId: RESTARTED_SERVICE_ID,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: ids(),
    });

    await restarted.recover();
    const written = await restarted.write(input("service.recovery-complete"));

    expect(written.service_instance_id).toBe(RESTARTED_SERVICE_ID);
    expect(written.service_sequence).toBe(1);
    expect((await events(logsPath)).map((event) => event.service_sequence)).toEqual([5, 1]);
  });

  it("recovers a partial final line and reports it once on the healthy channel", async () => {
    const { logsPath } = await fixture();
    const first = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: ids(),
    });
    await first.write(input("service.start"));
    const active = path.join(logsPath, "operational-current.jsonl");
    await (await import("node:fs/promises")).appendFile(active, '{"partial":');

    const restarted = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => new Date("2026-08-20T12:00:01.000Z"),
      randomId: ids(),
    });
    await restarted.recover();
    await restarted.recover();

    expect((await events(logsPath)).map((event) => event.event)).toEqual([
      "service.start",
      "logging.partial-tail-recovered",
    ]);
  });

  it("preserves and rejects corrupt interior lines", async () => {
    const { logsPath } = await fixture();
    const store = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: ids(),
    });
    await store.write(input("service.start"));
    const active = path.join(logsPath, "operational-current.jsonl");
    const original = await readFile(active);
    await writeFile(active, Buffer.concat([original, Buffer.from("not-json\n")]), { mode: 0o600 });
    const corrupt = await readFile(active);

    await expect(store.recover()).rejects.toMatchObject({ code: "RUNTIME_LOGGING_CORRUPT" });
    expect(await readFile(active)).toEqual(corrupt);
  });

  it("rejects a duplicate event identity across a closed and active file", async () => {
    const { logsPath } = await fixture();
    let now = new Date("2026-08-20T23:59:59.000Z");
    const store = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => now,
      randomId: ids(),
    });
    const first = await store.write(input("service.start"));
    now = new Date("2026-08-21T00:00:00.000Z");
    await store.write(input("service.ready"));
    const active = path.join(logsPath, "operational-current.jsonl");
    const activeEvent = JSON.parse((await readFile(active, "utf8")).trim()) as OperationalEventV1;
    await writeFile(active, `${canonicalJson({ ...activeEvent, event_id: first.event_id })}\n`, {
      mode: 0o600,
    });

    await expect(store.recover()).rejects.toMatchObject({ code: "RUNTIME_LOGGING_CORRUPT" });
  });

  it("rotates before the byte limit and across a UTC day without reordering", async () => {
    const { logsPath } = await fixture();
    let now = new Date("2026-08-20T23:59:59.000Z");
    const store = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => now,
      randomId: ids(),
      maxBytes: 65_536,
      retentionMaxBytes: 104_857_600,
    });
    const long = "x".repeat(1_000);
    for (let index = 0; index < 55; index += 1) {
      await store.write({
        ...input(`service.batch-${index}`),
        metadata: { status: long },
      });
    }
    now = new Date("2026-08-21T00:00:00.000Z");
    await store.write(input("service.next-day"));

    const names = await readdir(logsPath);
    expect(names.some((name) => /^operational-2026-08-20-\d{6}\.jsonl$/u.test(name))).toBe(true);
    expect((await events(logsPath)).map((event) => event.service_sequence)).toEqual(
      Array.from({ length: 56 }, (_, index) => index + 1),
    );
  });

  it("retains only owned closed logs inside the age and aggregate budget", async () => {
    const { logsPath } = await fixture();
    let now = new Date("2026-08-01T12:00:00.000Z");
    const store = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => now,
      randomId: ids(),
      maxBytes: 65_536,
      retentionDays: 7,
    });
    await store.write(input("service.old"));
    now = new Date("2026-08-09T12:00:00.000Z");
    await store.write(input("service.current"));
    const unrelated = path.join(logsPath, "evidence.jsonl");
    await writeFile(unrelated, "preserve", { mode: 0o600 });
    await store.recover();

    expect((await events(logsPath)).map((event) => event.event)).toEqual(["service.current"]);
    expect(await readFile(unrelated, "utf8")).toBe("preserve");
  });

  it.each(["after-link", "after-directory-sync"] as const)(
    "recovers an interrupted %s rotation without losing or duplicating an event",
    async (boundary) => {
      const { logsPath } = await fixture();
      let now = new Date("2026-08-20T23:59:59.000Z");
      let interrupt = true;
      const options = {
        logsPath,
        serviceInstanceId: SERVICE_ID,
        now: () => now,
        randomId: ids(),
        operationHooks: {
          afterClosedLink: () => {
            if (boundary === "after-link" && interrupt) throw new Error("simulated crash");
          },
          afterRotationDirectorySync: () => {
            if (boundary === "after-directory-sync" && interrupt) {
              throw new Error("simulated crash");
            }
          },
        },
      };
      const first = createOperationalLogStore(options);
      await first.write(input("service.start"));
      now = new Date("2026-08-21T00:00:00.000Z");
      await expect(first.write(input("service.ready"))).rejects.toMatchObject({
        code: "RUNTIME_LOGGING_DEGRADED",
      });

      interrupt = false;
      const restarted = createOperationalLogStore(options);
      await restarted.recover();
      await restarted.write(input("service.ready"));

      expect((await events(logsPath)).map((event) => event.event)).toEqual([
        "service.start",
        "service.ready",
      ]);
      expect((await readdir(logsPath)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);
    },
  );

  it("preserves both the active log and a no-overwrite rotation collision", async () => {
    const { logsPath } = await fixture();
    let now = new Date("2026-08-20T23:59:59.000Z");
    let collisionPath: string | undefined;
    const store = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => now,
      randomId: ids(),
      operationHooks: {
        beforeRotate: (_activePath, closedPath) => {
          collisionPath = closedPath;
          writeFileSync(closedPath, "preserve-collision", { mode: 0o600 });
        },
      },
    });
    await store.write(input("service.start"));
    const active = path.join(logsPath, "operational-current.jsonl");
    const activeBytes = await readFile(active);
    now = new Date("2026-08-21T00:00:00.000Z");

    await expect(store.write(input("service.ready"))).rejects.toMatchObject({
      code: "RUNTIME_LOGGING_DEGRADED",
    });
    expect(await readFile(active)).toEqual(activeBytes);
    expect(await readFile(collisionPath!, "utf8")).toBe("preserve-collision");
  });

  it("preserves an identity replacement after the rotation link boundary", async () => {
    const { logsPath } = await fixture();
    let now = new Date("2026-08-20T23:59:59.000Z");
    let replacementPath: string | undefined;
    const store = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => now,
      randomId: ids(),
      operationHooks: {
        afterClosedLink: (_activePath, closedPath) => {
          replacementPath = closedPath;
          unlinkSync(closedPath);
          writeFileSync(closedPath, "preserve-replacement", { mode: 0o600 });
        },
      },
    });
    await store.write(input("service.start"));
    const active = path.join(logsPath, "operational-current.jsonl");
    const activeBytes = await readFile(active);
    now = new Date("2026-08-21T00:00:00.000Z");

    await expect(store.write(input("service.ready"))).rejects.toMatchObject({
      code: "RUNTIME_LOGGING_PATH_UNSAFE",
    });
    expect(await readFile(active)).toEqual(activeBytes);
    expect(await readFile(replacementPath!, "utf8")).toBe("preserve-replacement");
  });

  it("sets one shared sticky degraded state until explicit recovery succeeds", async () => {
    const { logsPath } = await fixture();
    let fail = true;
    const first = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: ids(),
      operationHooks: {
        beforeFileSync: () => {
          if (fail) throw new Error("simulated disk full");
        },
      },
    });
    const second = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => new Date("2026-08-20T12:00:01.000Z"),
      randomId: ids(),
    });

    await expect(first.write(input("service.start"))).rejects.toMatchObject({
      code: "RUNTIME_LOGGING_DEGRADED",
    });
    await expect(second.write(input("service.ready"))).rejects.toMatchObject({
      code: "RUNTIME_LOGGING_DEGRADED",
    });
    expect(first.isDegraded()).toBe(true);
    fail = false;
    await first.recover();
    await expect(second.write(input("service.ready"))).resolves.toMatchObject({
      event: "service.ready",
    });
  });

  it("fails closed for a nonprivate active file", async () => {
    const { logsPath } = await fixture();
    const store = createOperationalLogStore({
      logsPath,
      serviceInstanceId: SERVICE_ID,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      randomId: ids(),
    });
    await store.write(input("service.start"));
    await chmod(path.join(logsPath, "operational-current.jsonl"), 0o644);

    await expect(store.recover()).rejects.toMatchObject({ code: "RUNTIME_LOGGING_PATH_UNSAFE" });
  });
});
