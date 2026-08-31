import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
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

function tombstoneName(
  kind: "claim" | "stage" | "recovery-claim" | "recovery-stage",
  ownerPid: number,
  operationId: string,
  artifact: "claim" | "stage",
  bytes: Uint8Array,
): string {
  return `.delete-${kind}-${ownerPid}-${operationId}-${artifact}-${bytes.byteLength}-${rawHash(bytes).slice("sha256:".length)}.tombstone`;
}

function claimBytes(ownerPid: number, operationId: string, bytes: Uint8Array): Uint8Array {
  return Buffer.from(
    canonicalJson({
      schema_version: "skill-store-operation.v1",
      operation_id: operationId,
      owner_pid: ownerPid,
      created_at: "2026-08-30T12:00:00.000Z",
      object_hash: HASH,
      record_bytes: bytes.byteLength,
      record_hash: rawHash(bytes),
    }),
    "utf8",
  );
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

      await expect(failing.publishObject(HASH, bytes)).rejects.toBeInstanceOf(RuntimeSkillError);
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

  it.each(
    (["stage", "claim"] as const).flatMap((targetKind) =>
      (
        [
          "beforeCleanupRename",
          "afterCleanupRename",
          "beforeCleanupParentSync",
          "afterCleanupParentSync",
          "beforeCleanupUnlink",
          "afterCleanupUnlink",
          "beforeCleanupFinalSync",
          "afterCleanupFinalSync",
        ] as const
      ).map((hookName) => [targetKind, hookName] as const),
    ),
  )(
    "recovers a %s cleanup interruption at %s without a tombstone or operation artifact",
    async (targetKind, hookName) => {
      const statePath = await privateTemporaryDirectory("toss-skill-store-");
      const bytes = Buffer.from(`{"cleanup":"${hookName}"}`, "utf8");
      let interrupted = false;
      const operationHooks = {
        [hookName]: (kind: string) => {
          if (kind !== targetKind || interrupted) return Promise.resolve();
          interrupted = true;
          return Promise.reject(new Error("simulated cleanup crash boundary"));
        },
      } as unknown as SkillPrivateStoreOperationHooks;
      const failing = createSkillPrivateStoreForTest(storeOptions(statePath, { operationHooks }));

      await expect(failing.publishObject(HASH, bytes)).rejects.toBeInstanceOf(RuntimeSkillError);
      expect(interrupted).toBe(true);

      const recovering = createSkillPrivateStoreForTest(
        storeOptions(statePath, {
          isProcessAlive: () => "dead",
          hasServiceListener: () => Promise.resolve("absent"),
        }),
      );
      expect(await recovering.publishObject(HASH, bytes)).toEqual(bytes);
      const names = await readdir(path.join(statePath, "skills", "objects"));
      expect(names).toEqual([`${HASH}.json`]);
    },
  );

  it("recovers a dead object transaction explicitly before any object read or publication", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const bytes = Buffer.from('{"recovery":"startup"}', "utf8");
    let interrupted = false;
    const failing = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        operationHooks: {
          afterCleanupRename(kind) {
            if (kind !== "claim" || interrupted) return Promise.resolve();
            interrupted = true;
            return Promise.reject(new Error("simulated startup crash cut"));
          },
        },
      }),
    );
    await expect(failing.publishObject(HASH, bytes)).rejects.toBeInstanceOf(RuntimeSkillError);
    const objectsPath = path.join(statePath, "skills", "objects");
    expect((await readdir(objectsPath)).some((name) => name.endsWith(".tombstone"))).toBe(true);

    const recovering = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        isProcessAlive: () => "dead",
        hasServiceListener: () => Promise.resolve("absent"),
      }),
    );
    await recovering.recover();

    expect(await readdir(objectsPath)).toEqual([`${HASH}.json`]);
  });

  it("rebinds the final object after awaited claim cleanup and preserves a replacement", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const bytes = Buffer.from('{"record":"cleanup-replacement"}', "utf8");
    const finalPath = objectPath(statePath, HASH);
    const preservedPath = `${finalPath}.preserved`;
    let replaced = false;
    const operationHooks: SkillPrivateStoreOperationHooks = {
      afterTombstoneRename(kind) {
        if (kind !== "claim" || replaced) return;
        replaced = true;
        renameSync(finalPath, preservedPath);
        writeFileSync(finalPath, bytes, { mode: 0o600 });
      },
    };
    const store = createSkillPrivateStoreForTest(storeOptions(statePath, { operationHooks }));

    await expect(store.publishObject(HASH, bytes)).rejects.toBeInstanceOf(RuntimeSkillError);
    expect(replaced).toBe(true);
    expect(await readFile(finalPath)).toEqual(bytes);
    expect(await readFile(preservedPath)).toEqual(bytes);
    expect((await lstat(finalPath)).ino).not.toBe((await lstat(preservedPath)).ino);
  });

  it("rebinds a collision object after awaited claim cleanup and preserves a replacement", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const bytes = Buffer.from('{"record":"collision-cleanup-replacement"}', "utf8");
    const finalPath = objectPath(statePath, HASH);
    const preservedPath = `${finalPath}.collision-preserved`;
    let replaced = false;
    const operationHooks: SkillPrivateStoreOperationHooks = {
      afterTombstoneRename(kind) {
        if (kind !== "claim" || replaced) return;
        replaced = true;
        renameSync(finalPath, preservedPath);
        writeFileSync(finalPath, bytes, { mode: 0o600 });
      },
    };
    const store = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        operationHooks,
        linkFile(_stagePath, destination) {
          writeFileSync(destination, bytes, { mode: 0o600, flag: "wx" });
          throw Object.assign(new Error("simulated cross-host collision"), { code: "EEXIST" });
        },
      }),
    );

    await expect(store.publishObject(HASH, bytes)).rejects.toBeInstanceOf(RuntimeSkillError);
    expect(replaced).toBe(true);
    expect(await readFile(finalPath)).toEqual(bytes);
    expect(await readFile(preservedPath)).toEqual(bytes);
    expect((await lstat(finalPath)).ino).not.toBe((await lstat(preservedPath)).ino);
  });

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

  it("preserves a malformed cleanup tombstone and fails closed", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const store = createSkillPrivateStoreForTest(storeOptions(statePath));
    await store.ensureRoots();
    const candidate = path.join(statePath, "skills", "objects", ".delete-malformed.tombstone");
    await writeFile(candidate, "replacement", { mode: 0o600 });

    await expectSkillError(store.publishObject(HASH, Buffer.from("{}", "utf8")));
    expect(await readFile(candidate, "utf8")).toBe("replacement");
  });

  it("preserves a content-rebound cleanup tombstone and fails closed", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const objectsPath = path.join(statePath, "skills", "objects");
    const store = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        isProcessAlive: () => "dead",
        hasServiceListener: () => Promise.resolve("absent"),
      }),
    );
    await store.ensureRoots();
    const expected = Buffer.from("original", "utf8");
    const replacement = Buffer.from("replaced", "utf8");
    const ownerPid = 998877;
    const operationId = "77000000-0000-4000-8000-000000000001";
    const candidate = path.join(
      objectsPath,
      tombstoneName("stage", ownerPid, operationId, "stage", expected),
    );
    await writeFile(
      path.join(objectsPath, `.object-${ownerPid}-${operationId}.claim`),
      claimBytes(ownerPid, operationId, expected),
      { mode: 0o600 },
    );
    await writeFile(candidate, replacement, { mode: 0o600 });

    await expectSkillError(store.publishObject(HASH, Buffer.from("{}", "utf8")));
    expect(await readFile(candidate)).toEqual(replacement);
  });

  it("preserves a replacement made during exact tombstone recovery", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const objectsPath = path.join(statePath, "skills", "objects");
    const bytes = Buffer.from("recoverable-stage", "utf8");
    const ownerPid = 998878;
    const operationId = "77000000-0000-4000-8000-000000000002";
    const candidate = path.join(
      objectsPath,
      tombstoneName("stage", ownerPid, operationId, "stage", bytes),
    );
    const preserved = `${candidate}.preserved`;
    let invoked = false;
    const operationHooks = {
      async beforeTombstoneRecovery(tombstonePath: string) {
        invoked = true;
        await rename(tombstonePath, preserved);
        await writeFile(tombstonePath, bytes, { mode: 0o600 });
      },
    } as unknown as SkillPrivateStoreOperationHooks;
    const store = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        operationHooks,
        isProcessAlive: () => "dead",
        hasServiceListener: () => Promise.resolve("absent"),
      }),
    );
    await store.ensureRoots();
    await writeFile(
      path.join(objectsPath, `.object-${ownerPid}-${operationId}.claim`),
      claimBytes(ownerPid, operationId, bytes),
      { mode: 0o600 },
    );
    await writeFile(candidate, bytes, { mode: 0o600 });

    await expectSkillError(store.publishObject(HASH, Buffer.from("{}", "utf8")));
    expect(invoked).toBe(true);
    expect(await readFile(candidate)).toEqual(bytes);
    expect(await readFile(preserved)).toEqual(bytes);
  });

  it("preserves a claim tombstone when its transaction final conflicts", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const objectsPath = path.join(statePath, "skills", "objects");
    const expected = Buffer.from('{"record":"claim-expected"}', "utf8");
    const conflicting = Buffer.from('{"record":"claim-conflict"}', "utf8");
    const ownerPid = 998879;
    const operationId = "77000000-0000-4000-8000-000000000003";
    const claim = claimBytes(ownerPid, operationId, expected);
    const tombstonePath = path.join(
      objectsPath,
      tombstoneName("claim", ownerPid, operationId, "claim", claim),
    );
    const finalPath = objectPath(statePath, HASH);
    const store = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        isProcessAlive: () => "dead",
        hasServiceListener: () => Promise.resolve("absent"),
      }),
    );
    await store.ensureRoots();
    await writeFile(tombstonePath, claim, { mode: 0o600 });
    await writeFile(finalPath, conflicting, { mode: 0o600 });

    await expectSkillError(store.publishObject(HASH, conflicting));
    expect(await readFile(tombstonePath)).toEqual(claim);
    expect(await readFile(finalPath)).toEqual(conflicting);
  });

  it("preserves a claim tombstone and a conflicting final that reappears during recovery", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const objectsPath = path.join(statePath, "skills", "objects");
    const expected = Buffer.from('{"record":"claim-reappear-expected"}', "utf8");
    const conflicting = Buffer.from('{"record":"claim-reappeared"}', "utf8");
    const ownerPid = 998880;
    const operationId = "77000000-0000-4000-8000-000000000004";
    const claim = claimBytes(ownerPid, operationId, expected);
    const tombstonePath = path.join(
      objectsPath,
      tombstoneName("claim", ownerPid, operationId, "claim", claim),
    );
    const finalPath = objectPath(statePath, HASH);
    let reappeared = false;
    const store = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        isProcessAlive: () => "dead",
        async hasServiceListener() {
          reappeared = true;
          await writeFile(finalPath, conflicting, { mode: 0o600 });
          return "absent";
        },
      }),
    );
    await store.ensureRoots();
    await writeFile(tombstonePath, claim, { mode: 0o600 });

    await expectSkillError(store.publishObject(HASH, expected));
    expect(reappeared).toBe(true);
    expect(await readFile(tombstonePath)).toEqual(claim);
    expect(await readFile(finalPath)).toEqual(conflicting);
  });

  it("preserves a stage tombstone, its claim, and a conflicting transaction final", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const objectsPath = path.join(statePath, "skills", "objects");
    const expected = Buffer.from('{"record":"stage-expected"}', "utf8");
    const conflicting = Buffer.from('{"record":"stage-conflict"}', "utf8");
    const ownerPid = 998881;
    const operationId = "77000000-0000-4000-8000-000000000005";
    const claim = claimBytes(ownerPid, operationId, expected);
    const claimPath = path.join(objectsPath, `.object-${ownerPid}-${operationId}.claim`);
    const tombstonePath = path.join(
      objectsPath,
      tombstoneName("stage", ownerPid, operationId, "stage", expected),
    );
    const finalPath = objectPath(statePath, HASH);
    const store = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        isProcessAlive: () => "dead",
        hasServiceListener: () => Promise.resolve("absent"),
      }),
    );
    await store.ensureRoots();
    await writeFile(claimPath, claim, { mode: 0o600 });
    await writeFile(tombstonePath, expected, { mode: 0o600 });
    await writeFile(finalPath, conflicting, { mode: 0o600 });

    await expectSkillError(store.publishObject(HASH, expected));
    expect(await readFile(claimPath)).toEqual(claim);
    expect(await readFile(tombstonePath)).toEqual(expected);
    expect(await readFile(finalPath)).toEqual(conflicting);
  });

  it("preserves a stage transaction when a conflicting final reappears during recovery", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const objectsPath = path.join(statePath, "skills", "objects");
    const expected = Buffer.from('{"record":"stage-reappear-expected"}', "utf8");
    const conflicting = Buffer.from('{"record":"stage-reappeared"}', "utf8");
    const ownerPid = 998882;
    const operationId = "77000000-0000-4000-8000-000000000006";
    const claim = claimBytes(ownerPid, operationId, expected);
    const claimPath = path.join(objectsPath, `.object-${ownerPid}-${operationId}.claim`);
    const tombstonePath = path.join(
      objectsPath,
      tombstoneName("stage", ownerPid, operationId, "stage", expected),
    );
    const finalPath = objectPath(statePath, HASH);
    let reappeared = false;
    const store = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        isProcessAlive: () => "dead",
        async hasServiceListener() {
          reappeared = true;
          await writeFile(finalPath, conflicting, { mode: 0o600 });
          return "absent";
        },
      }),
    );
    await store.ensureRoots();
    await writeFile(claimPath, claim, { mode: 0o600 });
    await writeFile(tombstonePath, expected, { mode: 0o600 });

    await expectSkillError(store.publishObject(HASH, expected));
    expect(reappeared).toBe(true);
    expect(await readFile(claimPath)).toEqual(claim);
    expect(await readFile(tombstonePath)).toEqual(expected);
    expect(await readFile(finalPath)).toEqual(conflicting);
  });

  it("preserves a stage tombstone, final, and conflicting paired claim", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const objectsPath = path.join(statePath, "skills", "objects");
    const expected = Buffer.from('{"record":"paired-expected"}', "utf8");
    const conflicting = Buffer.from('{"record":"paired-conflict"}', "utf8");
    const ownerPid = 998883;
    const operationId = "77000000-0000-4000-8000-000000000007";
    const conflictingClaim = claimBytes(ownerPid, operationId, conflicting);
    const claimPath = path.join(objectsPath, `.object-${ownerPid}-${operationId}.claim`);
    const tombstonePath = path.join(
      objectsPath,
      tombstoneName("stage", ownerPid, operationId, "stage", expected),
    );
    const finalPath = objectPath(statePath, HASH);
    const store = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        isProcessAlive: () => "dead",
        hasServiceListener: () => Promise.resolve("absent"),
      }),
    );
    await store.ensureRoots();
    await writeFile(claimPath, conflictingClaim, { mode: 0o600 });
    await writeFile(tombstonePath, expected, { mode: 0o600 });
    await writeFile(finalPath, expected, { mode: 0o600 });

    await expectSkillError(store.publishObject(HASH, expected));
    expect(await readFile(claimPath)).toEqual(conflictingClaim);
    expect(await readFile(tombstonePath)).toEqual(expected);
    expect(await readFile(finalPath)).toEqual(expected);
  });

  it("preserves a stage tombstone and a paired claim replaced during recovery", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const objectsPath = path.join(statePath, "skills", "objects");
    const expected = Buffer.from('{"record":"claim-replaced"}', "utf8");
    const ownerPid = 998884;
    const operationId = "77000000-0000-4000-8000-000000000008";
    const claim = claimBytes(ownerPid, operationId, expected);
    const claimPath = path.join(objectsPath, `.object-${ownerPid}-${operationId}.claim`);
    const preservedClaimPath = `${claimPath}.preserved`;
    const tombstonePath = path.join(
      objectsPath,
      tombstoneName("stage", ownerPid, operationId, "stage", expected),
    );
    let replaced = false;
    const store = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        isProcessAlive: () => "dead",
        async hasServiceListener() {
          replaced = true;
          await rename(claimPath, preservedClaimPath);
          await writeFile(claimPath, claim, { mode: 0o600 });
          return "absent";
        },
      }),
    );
    await store.ensureRoots();
    await writeFile(claimPath, claim, { mode: 0o600 });
    await writeFile(tombstonePath, expected, { mode: 0o600 });

    await expectSkillError(store.publishObject(HASH, expected));
    expect(replaced).toBe(true);
    expect(await readFile(claimPath)).toEqual(claim);
    expect(await readFile(preservedClaimPath)).toEqual(claim);
    expect(await readFile(tombstonePath)).toEqual(expected);
  });

  it("preserves a recoverable transaction before rejecting cross-final hard-link aliases", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const objectsPath = path.join(statePath, "skills", "objects");
    const transactionBytes = Buffer.from('{"record":"transaction-preserved"}', "utf8");
    const aliasedBytes = Buffer.from('{"record":"unclaimed-alias"}', "utf8");
    const ownerPid = 998885;
    const operationId = "77000000-0000-4000-8000-000000000009";
    const claim = claimBytes(ownerPid, operationId, transactionBytes);
    const claimPath = path.join(objectsPath, `.object-${ownerPid}-${operationId}.claim`);
    const firstHash = `sha256:${"b".repeat(64)}` as const;
    const secondHash = `sha256:${"c".repeat(64)}` as const;
    const firstFinal = objectPath(statePath, firstHash);
    const secondFinal = objectPath(statePath, secondHash);
    let livenessCalls = 0;
    let listenerCalls = 0;
    const store = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        isProcessAlive() {
          livenessCalls += 1;
          return "dead";
        },
        hasServiceListener() {
          listenerCalls += 1;
          return Promise.resolve("absent");
        },
      }),
    );
    await store.ensureRoots();
    await writeFile(claimPath, claim, { mode: 0o600 });
    await writeFile(firstFinal, aliasedBytes, { mode: 0o600 });
    await link(firstFinal, secondFinal);
    const claimBefore = await lstat(claimPath, { bigint: true });
    const firstBefore = await lstat(firstFinal);
    const secondBefore = await lstat(secondFinal);

    await expectSkillError(
      store.publishObject(HASH, transactionBytes),
      "RUNTIME_SKILL_PATH_UNSAFE",
    );

    expect(livenessCalls).toBe(0);
    expect(listenerCalls).toBe(0);
    expect(await readFile(claimPath)).toEqual(claim);
    expect(await readFile(firstFinal)).toEqual(aliasedBytes);
    expect(await readFile(secondFinal)).toEqual(aliasedBytes);
    const claimAfter = await lstat(claimPath, { bigint: true });
    const firstAfter = await lstat(firstFinal);
    const secondAfter = await lstat(secondFinal);
    expect({ dev: claimAfter.dev, ino: claimAfter.ino, nlink: claimAfter.nlink }).toEqual({
      dev: claimBefore.dev,
      ino: claimBefore.ino,
      nlink: claimBefore.nlink,
    });
    expect({ dev: firstAfter.dev, ino: firstAfter.ino, nlink: firstAfter.nlink }).toEqual({
      dev: firstBefore.dev,
      ino: firstBefore.ino,
      nlink: firstBefore.nlink,
    });
    expect({ dev: secondAfter.dev, ino: secondAfter.ino, nlink: secondAfter.nlink }).toEqual({
      dev: secondBefore.dev,
      ino: secondBefore.ino,
      nlink: secondBefore.nlink,
    });
    expect(firstAfter.ino).toBe(secondAfter.ino);
    expect(firstAfter.nlink).toBe(2);
  });

  it("preserves a recoverable transaction before rejecting an orphan hard-linked final", async () => {
    const statePath = await privateTemporaryDirectory("toss-skill-store-");
    const objectsPath = path.join(statePath, "skills", "objects");
    const transactionBytes = Buffer.from('{"record":"orphan-transaction-preserved"}', "utf8");
    const orphanBytes = Buffer.from('{"record":"orphan-final"}', "utf8");
    const ownerPid = 998886;
    const operationId = "77000000-0000-4000-8000-000000000010";
    const claim = claimBytes(ownerPid, operationId, transactionBytes);
    const claimPath = path.join(objectsPath, `.object-${ownerPid}-${operationId}.claim`);
    const orphanHash = `sha256:${"d".repeat(64)}` as const;
    const finalPath = objectPath(statePath, orphanHash);
    const externalLink = path.join(statePath, "orphan-preserved");
    let livenessCalls = 0;
    let listenerCalls = 0;
    const store = createSkillPrivateStoreForTest(
      storeOptions(statePath, {
        isProcessAlive() {
          livenessCalls += 1;
          return "dead";
        },
        hasServiceListener() {
          listenerCalls += 1;
          return Promise.resolve("absent");
        },
      }),
    );
    await store.ensureRoots();
    await writeFile(claimPath, claim, { mode: 0o600 });
    await writeFile(finalPath, orphanBytes, { mode: 0o600 });
    await link(finalPath, externalLink);
    const claimBefore = await lstat(claimPath, { bigint: true });
    const finalBefore = await lstat(finalPath);
    const externalBefore = await lstat(externalLink);

    await expectSkillError(
      store.publishObject(HASH, transactionBytes),
      "RUNTIME_SKILL_PATH_UNSAFE",
    );

    expect(livenessCalls).toBe(0);
    expect(listenerCalls).toBe(0);
    expect(await readFile(claimPath)).toEqual(claim);
    expect(await readFile(finalPath)).toEqual(orphanBytes);
    expect(await readFile(externalLink)).toEqual(orphanBytes);
    const claimAfter = await lstat(claimPath, { bigint: true });
    const finalAfter = await lstat(finalPath);
    const externalAfter = await lstat(externalLink);
    expect({ dev: claimAfter.dev, ino: claimAfter.ino, nlink: claimAfter.nlink }).toEqual({
      dev: claimBefore.dev,
      ino: claimBefore.ino,
      nlink: claimBefore.nlink,
    });
    expect({ dev: finalAfter.dev, ino: finalAfter.ino, nlink: finalAfter.nlink }).toEqual({
      dev: finalBefore.dev,
      ino: finalBefore.ino,
      nlink: finalBefore.nlink,
    });
    expect({ dev: externalAfter.dev, ino: externalAfter.ino, nlink: externalAfter.nlink }).toEqual({
      dev: externalBefore.dev,
      ino: externalBefore.ino,
      nlink: externalBefore.nlink,
    });
    expect(finalAfter.ino).toBe(externalAfter.ino);
    expect(finalAfter.nlink).toBe(2);
  });
});
