import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../src/protocol/json.js";
import { RuntimeSkillError } from "../src/skills/errors.js";
import {
  createSkillPrivateStoreForTest,
  type SkillPrivateStoreOperationHooks,
} from "../src/skills/private-store.js";

const temporaryDirectories: string[] = [];
const HASH = `sha256:${"a".repeat(64)}` as const;

async function privateTemporaryDirectory(prefix: string): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), prefix));
  const resolved = await realpath(created);
  await chmod(resolved, 0o700);
  temporaryDirectories.push(resolved);
  return resolved;
}

function ids(): () => string {
  let next = 0;
  return () => `71000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}

function storeOptions(
  statePath: string,
  overrides: Partial<Parameters<typeof createSkillPrivateStoreForTest>[0]> = {},
): Parameters<typeof createSkillPrivateStoreForTest>[0] {
  return {
    statePath,
    now: () => new Date("2026-08-30T12:00:00.000Z"),
    randomId: ids(),
    hasServiceListener: () => Promise.resolve("absent"),
    ...overrides,
  };
}

function rawHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function objectPath(statePath: string, hash: `sha256:${string}`): string {
  return path.join(statePath, "skills", "objects", `${hash}.json`);
}

function expectSkillError(
  operation: Promise<unknown>,
  code: ConstructorParameters<typeof RuntimeSkillError>[0] = "RUNTIME_SKILL_INTEGRITY",
): Promise<void> {
  return expect(operation).rejects.toEqual(new RuntimeSkillError(code));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe.sequential("private skill object publication", () => {
  it("publishes one current-user private canonical object and replays exact bytes", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const store = createSkillPrivateStoreForTest(storeOptions(statePath));
    const bytes = Buffer.from(canonicalJson({ record: "one" }), "utf8");

    expect(await store.publishObject(HASH, bytes)).toEqual(bytes);
    expect(await store.publishObject(HASH, Buffer.from(bytes))).toEqual(bytes);
    expect(await store.readObject(HASH)).toEqual(bytes);

    for (const directory of [
      path.join(statePath, "skills"),
      path.join(statePath, "skills", "objects"),
    ]) {
      expect((await lstat(directory)).mode & 0o7777).toBe(0o700);
    }
    const published = objectPath(statePath, HASH);
    const metadata = await lstat(published);
    expect(metadata.mode & 0o7777).toBe(0o600);
    expect(metadata.nlink).toBe(1);
    expect(await readFile(published)).toEqual(bytes);
    expect(await readdir(path.dirname(published))).toEqual([`${HASH}.json`]);
  });

  it("fails closed when the same package hash is rebound to conflicting bytes", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const store = createSkillPrivateStoreForTest(storeOptions(statePath));
    const first = Buffer.from('{"record":"first"}', "utf8");
    const second = Buffer.from('{"record":"second"}', "utf8");
    await store.publishObject(HASH, first);

    await expectSkillError(store.publishObject(HASH, second));
    expect(await readFile(objectPath(statePath, HASH))).toEqual(first);
  });

  it.each([0o077, 0o000] as const)("enforces exact modes under process umask %s", async (mask) => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const original = process.umask(mask);
    try {
      const store = createSkillPrivateStoreForTest(storeOptions(statePath));
      await store.publishObject(HASH, Buffer.from("{}", "utf8"));
      expect((await lstat(path.join(statePath, "skills"))).mode & 0o7777).toBe(0o700);
      expect((await lstat(objectPath(statePath, HASH))).mode & 0o7777).toBe(0o600);
    } finally {
      process.umask(original);
    }
  });

  it.each([
    ["before stage write", "beforeStageWrite", false],
    ["after stage write", "afterStageWrite", false],
    ["before file sync", "beforeFileSync", false],
    ["after file sync", "afterFileSync", false],
    ["before link", "beforeLinkPublication", false],
    ["after link", "afterLinkPublication", true],
    ["before directory sync", "beforeParentSync", true],
    ["after directory sync", "afterParentSync", true],
    ["before stage cleanup", "beforeStageCleanup", true],
    ["after stage cleanup", "afterStageCleanup", true],
  ] as const)(
    "recovers a publication interruption %s without a residual operation artifact",
    async (_label, hookName, published) => {
      const statePath = await privateTemporaryDirectory("toss-skill-store-");
      const bytes = Buffer.from(`{"hook":"${hookName}"}`, "utf8");
      const operationHooks = {
        [hookName]: () => Promise.reject(new Error("simulated crash boundary")),
      } as SkillPrivateStoreOperationHooks;
      const failing = createSkillPrivateStoreForTest(storeOptions(statePath, { operationHooks }));

      await expectSkillError(failing.publishObject(HASH, bytes));
      const objectsPath = path.join(statePath, "skills", "objects");
      const names = await readdir(objectsPath);
      expect(names.filter((name) => name.startsWith(".object-"))).toEqual([]);
      expect(names.includes(`${HASH}.json`)).toBe(published);

      const replay = createSkillPrivateStoreForTest(storeOptions(statePath));
      expect(await replay.publishObject(HASH, bytes)).toEqual(bytes);
      expect((await readdir(objectsPath)).filter((name) => name.startsWith(".object-"))).toEqual(
        [],
      );
    },
  );

  it("revalidates the exact object namespace after every asynchronous publication hook", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    let injected = "";
    const store = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        operationHooks: {
          async afterStageWrite(stagePath) {
            injected = path.join(path.dirname(stagePath), ".unexpected-during-hook");
            await writeFile(injected, "replacement", { mode: 0o600 });
          },
        },
      }),
    );

    await expectSkillError(store.publishObject(HASH, Buffer.from('{"record":"hook"}')));
    expect(await readFile(injected, "utf8")).toBe("replacement");
    await expect(lstat(objectPath(statePath, HASH))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "beforeStageWrite",
    "afterStageWrite",
    "beforeFileSync",
    "afterFileSync",
    "beforeLinkPublication",
    "afterLinkPublication",
    "beforeParentSync",
    "afterParentSync",
    "beforeStageCleanup",
    "afterStageCleanup",
  ] as const)("detects an identity mutation at the %s hook", async (hookName) => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    let stagePath = "";
    const mutate = async (): Promise<void> => {
      if (hookName === "afterStageCleanup") {
        await writeFile(
          path.join(statePath, "skills", "objects", ".unexpected-after-cleanup"),
          "replacement",
          { mode: 0o600 },
        );
        return;
      }
      await chmod(stagePath, 0o640);
    };
    const operationHooks: SkillPrivateStoreOperationHooks = {
      beforeStageWrite(candidate) {
        stagePath = candidate;
        return hookName === "beforeStageWrite" ? mutate() : Promise.resolve();
      },
      ...(hookName === "beforeStageWrite" ? {} : { [hookName]: mutate }),
    };
    const store = createSkillPrivateStoreForTest(storeOptions(statePath, { operationHooks }));

    await expect(
      store.publishObject(HASH, Buffer.from('{"record":"mutation"}')),
    ).rejects.toBeInstanceOf(RuntimeSkillError);
  });

  it.each([
    ["alive", "absent"],
    ["unknown", "absent"],
    ["dead", "present"],
    ["dead", "unknown"],
  ] as const)(
    "preserves a recognized stale operation for a %s owner with a %s listener",
    async (liveness, listener) => {
      const statePath = await privateTemporaryDirectory("toss-skill-store-");
      const objectsPath = path.join(statePath, "skills", "objects");
      await mkdir(path.join(statePath, "skills"), { mode: 0o700 });
      await mkdir(objectsPath, { mode: 0o700 });
      const operationId = "72000000-0000-4000-8000-000000000001";
      const ownerPid = 987654;
      const basename = `.object-${ownerPid}-${operationId}`;
      const bytes = Buffer.from('{"record":"stale"}', "utf8");
      const claim = {
        schema_version: "skill-store-operation.v1",
        operation_id: operationId,
        owner_pid: ownerPid,
        created_at: "2026-08-30T12:00:00.000Z",
        object_hash: HASH,
        record_bytes: bytes.byteLength,
        record_hash: rawHash(bytes),
      };
      await writeFile(path.join(objectsPath, `${basename}.claim`), canonicalJson(claim), {
        mode: 0o600,
      });
      await writeFile(path.join(objectsPath, `${basename}.stage`), bytes, { mode: 0o600 });
      const store = createSkillPrivateStoreForTest(
        storeOptions(statePath, {
          isProcessAlive: () => liveness,
          hasServiceListener: () => Promise.resolve(listener),
        }),
      );

      await expectSkillError(store.publishObject(HASH, bytes));
      expect((await readdir(objectsPath)).sort()).toEqual(
        [`${basename}.claim`, `${basename}.stage`].sort(),
      );
    },
  );

  it("recovers only a dead recognized operation after an exact absent-listener probe", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const objectsPath = path.join(statePath, "skills", "objects");
    await mkdir(path.join(statePath, "skills"), { mode: 0o700 });
    await mkdir(objectsPath, { mode: 0o700 });
    const operationId = "73000000-0000-4000-8000-000000000001";
    const ownerPid = 987655;
    const basename = `.object-${ownerPid}-${operationId}`;
    const bytes = Buffer.from('{"record":"recovered"}', "utf8");
    await writeFile(
      path.join(objectsPath, `${basename}.claim`),
      canonicalJson({
        schema_version: "skill-store-operation.v1",
        operation_id: operationId,
        owner_pid: ownerPid,
        created_at: "2026-08-30T12:00:00.000Z",
        object_hash: HASH,
        record_bytes: bytes.byteLength,
        record_hash: rawHash(bytes),
      }),
      { mode: 0o600 },
    );
    await writeFile(path.join(objectsPath, `${basename}.stage`), bytes.subarray(0, 3), {
      mode: 0o600,
    });
    let probes = 0;
    const store = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        isProcessAlive: () => "dead",
        hasServiceListener: () => {
          probes += 1;
          return Promise.resolve("absent");
        },
      }),
    );

    expect(await store.publishObject(HASH, bytes)).toEqual(bytes);
    expect(probes).toBe(1);
    expect(await readdir(objectsPath)).toEqual([`${HASH}.json`]);
  });

  it.each(["unexpected", "replacement"] as const)(
    "fails closed on an %s operation artifact without deleting it",
    async (kind) => {
      const statePath = await privateTemporaryDirectory("toss-skill-store-");
      const store = createSkillPrivateStoreForTest(storeOptions(statePath));
      await store.ensureRoots();
      const candidate = path.join(
        statePath,
        "skills",
        "objects",
        kind === "unexpected"
          ? ".unknown"
          : ".object-999999-74000000-0000-4000-8000-000000000001.claim",
      );
      await writeFile(candidate, "{}", { mode: 0o600 });

      await expectSkillError(store.publishObject(HASH, Buffer.from("{}", "utf8")));
      await expect(lstat(candidate)).resolves.toBeDefined();
    },
  );
});
