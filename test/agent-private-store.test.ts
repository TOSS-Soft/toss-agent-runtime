import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeAgentError } from "../src/agents/errors.js";
import {
  createPrivateAgentStore,
  MAX_PRIVATE_OBJECT_BYTES,
  type CreatePrivateAgentStoreOptions,
  type PrivateAgentStoreOperationHooks,
} from "../src/agents/private-store.js";

const roots: string[] = [];

function contentHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture(): Promise<{ readonly root: string; readonly statePath: string }> {
  const root = await mkdtemp(path.join(await realpath("/tmp"), "toss-agent-store-"));
  roots.push(root);
  return { root, statePath: path.join(root, "state") };
}

function options(
  statePath: string,
  overrides: Partial<CreatePrivateAgentStoreOptions> = {},
): CreatePrivateAgentStoreOptions {
  return {
    statePath,
    isProcessAlive: () => "alive",
    hasServiceListener: () => Promise.resolve("absent"),
    ...overrides,
  };
}

async function expectAgentError(
  operation: Promise<unknown>,
  code: "RUNTIME_AGENT_PATH_UNSAFE" | "RUNTIME_AGENT_REGISTRY_CORRUPT",
): Promise<void> {
  try {
    await operation;
    throw new Error("expected private store failure");
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeAgentError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("/tmp/");
  }
}

async function publishedFixture(): Promise<{
  readonly bytes: Buffer;
  readonly hash: `sha256:${string}`;
  readonly objectPath: string;
  readonly statePath: string;
}> {
  const { statePath } = await fixture();
  const bytes = Buffer.from('{"agent":"worker","revision":1}\n', "utf8");
  const hash = contentHash(bytes);
  const store = createPrivateAgentStore(options(statePath));
  await store.publishObject(hash, bytes);
  return { bytes, hash, objectPath: path.join(store.objectsPath, hash.slice(7)), statePath };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.sequential("private agent object store", () => {
  it("creates only hash-derived private roots and publishes current-user private objects", async () => {
    const { statePath } = await fixture();
    const bytes = Buffer.from('{"prompt":"trusted"}\n', "utf8");
    const hash = contentHash(bytes);
    const store = createPrivateAgentStore(options(statePath));

    await store.ensureRoots();
    const snapshot = await store.publishObject(hash, bytes);
    const objectPath = path.join(store.objectsPath, hash.slice("sha256:".length));

    expect(await readdir(statePath)).toEqual(["agents"]);
    expect((await readdir(store.agentsPath)).sort()).toEqual(["objects", "quarantine", "registry"]);
    for (const directory of [
      statePath,
      store.agentsPath,
      store.objectsPath,
      store.registryPath,
      store.quarantinePath,
    ]) {
      const metadata = await lstat(directory);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.mode & 0o777).toBe(0o700);
      if (typeof process.getuid === "function") expect(metadata.uid).toBe(process.getuid());
    }
    const metadata = await lstat(objectPath);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.nlink).toBe(1);
    if (typeof process.getuid === "function") expect(metadata.uid).toBe(process.getuid());
    expect(snapshot.bytes).toEqual(bytes);
    expect(snapshot.identity).toEqual({
      device: BigInt(metadata.dev),
      inode: BigInt(metadata.ino),
    });
    expect(await store.readObject(hash)).toEqual(snapshot);
    expect(await readdir(store.objectsPath)).toEqual([hash.slice(7)]);
  });

  it("enforces exact modes under restrictive and permissive umasks", async () => {
    for (const mask of [0o000, 0o777]) {
      const { statePath } = await fixture();
      const previous = process.umask(mask);
      try {
        const bytes = Buffer.from(`umask-${mask}`, "utf8");
        const store = createPrivateAgentStore(options(statePath));
        await store.publishObject(contentHash(bytes), bytes);
        expect((await lstat(statePath)).mode & 0o777).toBe(0o700);
        expect((await lstat(store.objectsPath)).mode & 0o777).toBe(0o700);
        expect(
          (await lstat(path.join(store.objectsPath, contentHash(bytes).slice(7)))).mode & 0o777,
        ).toBe(0o600);
      } finally {
        process.umask(previous);
      }
    }
  });

  it("replays exact existing bytes without overwriting and rejects changed bytes for the hash", async () => {
    const { statePath } = await fixture();
    const bytes = Buffer.from("immutable-agent-object", "utf8");
    const hash = contentHash(bytes);
    const store = createPrivateAgentStore(options(statePath));

    const first = await store.publishObject(hash, bytes);
    const replay = await store.publishObject(hash, Buffer.from(bytes));
    expect(replay).toEqual(first);

    const objectPath = path.join(store.objectsPath, hash.slice(7));
    await writeFile(objectPath, Buffer.from("changed-agent-object", "utf8"), { mode: 0o600 });
    await expectAgentError(store.publishObject(hash, bytes), "RUNTIME_AGENT_REGISTRY_CORRUPT");
    expect(await readFile(objectPath)).toEqual(Buffer.from("changed-agent-object", "utf8"));
  });

  it("rejects malformed hashes, hash mismatches, oversized publication, and non-absolute state paths", async () => {
    const { statePath } = await fixture();
    const store = createPrivateAgentStore(options(statePath));
    const bytes = Buffer.from("bounded", "utf8");

    await expectAgentError(
      store.publishObject("sha256:ABC", bytes),
      "RUNTIME_AGENT_REGISTRY_CORRUPT",
    );
    await expectAgentError(
      store.publishObject(`sha256:${"0".repeat(64)}`, bytes),
      "RUNTIME_AGENT_REGISTRY_CORRUPT",
    );
    await expectAgentError(
      store.publishObject(
        contentHash(Buffer.alloc(MAX_PRIVATE_OBJECT_BYTES + 1)),
        Buffer.alloc(MAX_PRIVATE_OBJECT_BYTES + 1),
      ),
      "RUNTIME_AGENT_REGISTRY_CORRUPT",
    );
    await expectAgentError(
      createPrivateAgentStore(options("relative/state")).ensureRoots(),
      "RUNTIME_AGENT_PATH_UNSAFE",
    );
  });

  it("rejects unsafe root ownership, modes, symlinks, files, and directories", async () => {
    const ownership = await fixture();
    await mkdir(ownership.statePath, { mode: 0o700 });
    await expectAgentError(
      createPrivateAgentStore(
        options(ownership.statePath, { isCurrentUser: () => false }),
      ).ensureRoots(),
      "RUNTIME_AGENT_PATH_UNSAFE",
    );

    const loose = await fixture();
    await mkdir(loose.statePath, { mode: 0o755 });
    await expectAgentError(
      createPrivateAgentStore(options(loose.statePath)).ensureRoots(),
      "RUNTIME_AGENT_PATH_UNSAFE",
    );

    const linked = await fixture();
    const target = path.join(linked.root, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked.statePath);
    await expectAgentError(
      createPrivateAgentStore(options(linked.statePath)).ensureRoots(),
      "RUNTIME_AGENT_PATH_UNSAFE",
    );

    for (const kind of ["file", "directory"] as const) {
      const actual = await fixture();
      const store = createPrivateAgentStore(options(actual.statePath));
      await store.ensureRoots();
      const candidate = path.join(store.objectsPath, "f".repeat(64));
      if (kind === "file") await writeFile(candidate, "wrong", { mode: 0o644 });
      else await mkdir(candidate, { mode: 0o700 });
      await expectAgentError(
        store.readObject(`sha256:${"f".repeat(64)}`),
        "RUNTIME_AGENT_PATH_UNSAFE",
      );
    }
  });

  it.each(["file", "directory", "symlink"] as const)(
    "detects %s replacement after opening an object and preserves the replacement",
    async (replacement) => {
      const published = await publishedFixture();
      const displaced = `${published.objectPath}.displaced`;
      const store = createPrivateAgentStore(
        options(published.statePath, {
          operationHooks: {
            afterObjectOpen: async () => {
              await rename(published.objectPath, displaced);
              if (replacement === "file") {
                await writeFile(published.objectPath, published.bytes, { mode: 0o600 });
              } else if (replacement === "directory") {
                await mkdir(published.objectPath, { mode: 0o700 });
              } else {
                await symlink(displaced, published.objectPath);
              }
            },
          },
        }),
      );

      await expectAgentError(store.readObject(published.hash), "RUNTIME_AGENT_PATH_UNSAFE");
      expect((await lstat(published.objectPath)).isFile()).toBe(replacement === "file");
      expect((await lstat(published.objectPath)).isDirectory()).toBe(replacement === "directory");
      expect((await lstat(published.objectPath)).isSymbolicLink()).toBe(replacement === "symlink");
    },
  );

  it("rejects a hard-linked object and object growth during a bounded read", async () => {
    const hardLinked = await publishedFixture();
    await link(hardLinked.objectPath, `${hardLinked.objectPath}.alias`);
    await expectAgentError(
      createPrivateAgentStore(options(hardLinked.statePath)).readObject(hardLinked.hash),
      "RUNTIME_AGENT_PATH_UNSAFE",
    );

    const growing = await publishedFixture();
    const store = createPrivateAgentStore(
      options(growing.statePath, {
        operationHooks: {
          afterObjectRead: async () => {
            await writeFile(growing.objectPath, Buffer.concat([growing.bytes, Buffer.from("x")]), {
              mode: 0o600,
            });
          },
        },
      }),
    );
    await expectAgentError(store.readObject(growing.hash), "RUNTIME_AGENT_PATH_UNSAFE");
  });

  it("rejects oversized objects before allocating their declared size", async () => {
    const { statePath } = await fixture();
    const hash = `sha256:${"e".repeat(64)}` as const;
    const store = createPrivateAgentStore(options(statePath));
    await store.ensureRoots();
    const objectPath = path.join(store.objectsPath, hash.slice(7));
    await writeFile(objectPath, "", { mode: 0o600 });
    await truncate(objectPath, MAX_PRIVATE_OBJECT_BYTES + 1);

    await expectAgentError(store.readObject(hash), "RUNTIME_AGENT_REGISTRY_CORRUPT");
  });

  it("detects ancestry replacement across the publication barrier", async () => {
    const { statePath } = await fixture();
    const bytes = Buffer.from("ancestry-bound", "utf8");
    const agentsPath = path.join(statePath, "agents");
    const displaced = `${agentsPath}.displaced`;
    let mutated = false;
    const store = createPrivateAgentStore(
      options(statePath, {
        operationHooks: {
          beforeParentSync: async () => {
            if (mutated) return;
            mutated = true;
            await rename(agentsPath, displaced);
            await mkdir(agentsPath, { mode: 0o700 });
          },
        },
      }),
    );

    await expectAgentError(
      store.publishObject(contentHash(bytes), bytes),
      "RUNTIME_AGENT_PATH_UNSAFE",
    );
    expect((await lstat(agentsPath)).isDirectory()).toBe(true);
  });

  it.each([
    ["before file sync", "beforeFileSync", false],
    ["after file sync", "afterFileSync", false],
    ["before link publication", "beforeLinkPublication", false],
    ["after link publication", "afterLinkPublication", true],
    ["before parent sync", "beforeParentSync", true],
    ["after parent sync", "afterParentSync", true],
    ["before staging cleanup", "beforeStageCleanup", true],
    ["after staging cleanup", "afterStageCleanup", true],
  ] as const)(
    "fails closed at %s and leaves an exact retryable publication state",
    async (_name, hookName, published) => {
      const { statePath } = await fixture();
      const bytes = Buffer.from(`fault-${hookName}`, "utf8");
      const hash = contentHash(bytes);
      const fault = (): Promise<void> => Promise.reject(new Error("injected publication fault"));
      const operationHooks = { [hookName]: fault } as PrivateAgentStoreOperationHooks;
      const failing = createPrivateAgentStore(options(statePath, { operationHooks }));

      await expectAgentError(failing.publishObject(hash, bytes), "RUNTIME_AGENT_REGISTRY_CORRUPT");
      const objectPath = path.join(failing.objectsPath, hash.slice(7));
      if (!published) {
        await expect(lstat(objectPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(lstat(objectPath)).resolves.toMatchObject({ nlink: 1 });
        expect(await readFile(objectPath)).toEqual(bytes);
      }
      expect(
        (await readdir(failing.objectsPath)).filter((name) => name.startsWith(".object-")),
      ).toEqual([]);

      const retry = createPrivateAgentStore(options(statePath));
      const snapshot = await retry.publishObject(hash, bytes);
      expect(snapshot.bytes).toEqual(bytes);
    },
  );

  it("never unlinks a replacement installed at the staging cleanup boundary", async () => {
    const { statePath } = await fixture();
    const bytes = Buffer.from("cleanup-identity", "utf8");
    const hash = contentHash(bytes);
    let replacementPath = "";
    const store = createPrivateAgentStore(
      options(statePath, {
        operationHooks: {
          beforeStageCleanup: async (stagePath) => {
            replacementPath = stagePath;
            await rename(stagePath, `${stagePath}.original`);
            await writeFile(stagePath, "replacement", { mode: 0o600 });
          },
        },
      }),
    );

    await expectAgentError(store.publishObject(hash, bytes), "RUNTIME_AGENT_PATH_UNSAFE");
    expect(await readFile(replacementPath)).toEqual(Buffer.from("replacement", "utf8"));
  });
});

describe.sequential("private agent mutation claim", () => {
  it("creates one current-user 0700 identity-bound claim and releases only its own claim", async () => {
    const { statePath } = await fixture();
    const store = createPrivateAgentStore(options(statePath));
    const claim = await store.acquireMutationClaim();
    const metadata = await lstat(store.mutationClaimPath);

    expect(metadata.isFile()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o700);
    expect(metadata.nlink).toBe(1);
    if (typeof process.getuid === "function") expect(metadata.uid).toBe(process.getuid());
    expect(claim.ownerPid).toBe(process.pid);
    await claim.release();
    await expect(lstat(store.mutationClaimPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["alive", "absent"],
    ["unknown", "absent"],
    ["dead", "present"],
    ["dead", "unknown"],
  ] as const)(
    "fails closed for a %s owner with a %s listener result",
    async (liveness, listener) => {
      const { statePath } = await fixture();
      const first = createPrivateAgentStore(options(statePath));
      const held = await first.acquireMutationClaim();
      const contender = createPrivateAgentStore(
        options(statePath, {
          isProcessAlive: () => liveness,
          hasServiceListener: () => Promise.resolve(listener),
        }),
      );

      await expectAgentError(contender.acquireMutationClaim(), "RUNTIME_AGENT_REGISTRY_CORRUPT");
      expect((await lstat(first.mutationClaimPath)).isFile()).toBe(true);
      await held.release();
    },
  );

  it("recovers only a dead-owner claim with a proven absent service listener", async () => {
    const { statePath } = await fixture();
    const first = createPrivateAgentStore(options(statePath));
    const stale = await first.acquireMutationClaim();

    const recovering = createPrivateAgentStore(
      options(statePath, {
        isProcessAlive: () => "dead",
        hasServiceListener: () => Promise.resolve("absent"),
      }),
    );
    const replacement = await recovering.acquireMutationClaim();
    expect(replacement.ownerPid).toBe(process.pid);
    await expectAgentError(stale.release(), "RUNTIME_AGENT_PATH_UNSAFE");
    await replacement.release();
  });

  it("treats an unsafe production socket candidate as unknown and preserves the claim", async () => {
    const { root, statePath } = await fixture();
    const first = createPrivateAgentStore(options(statePath));
    const held = await first.acquireMutationClaim();
    await symlink(path.join(root, "missing.sock"), path.join(root, "runtime.sock"));
    const contender = createPrivateAgentStore({
      statePath,
      isProcessAlive: () => "dead",
    });

    await expectAgentError(contender.acquireMutationClaim(), "RUNTIME_AGENT_REGISTRY_CORRUPT");
    expect((await lstat(first.mutationClaimPath)).isFile()).toBe(true);
    await held.release();
  });

  it.each(["file", "directory", "symlink", "hard-link"] as const)(
    "rejects an unsafe %s mutation-claim candidate without removing it",
    async (kind) => {
      const { statePath, root } = await fixture();
      const store = createPrivateAgentStore(options(statePath));
      await store.ensureRoots();
      const claimPath = store.mutationClaimPath;
      const target = path.join(root, "claim-target");
      if (kind === "file") {
        await writeFile(claimPath, '{"pid":1}\n', { mode: 0o600 });
      } else if (kind === "directory") {
        await mkdir(claimPath, { mode: 0o700 });
      } else {
        await writeFile(target, '{"pid":1}\n', { mode: 0o700 });
        if (kind === "symlink") await symlink(target, claimPath);
        else await link(target, claimPath);
      }

      await expectAgentError(store.acquireMutationClaim(), "RUNTIME_AGENT_PATH_UNSAFE");
      await expect(lstat(claimPath)).resolves.toBeDefined();
    },
  );

  it("does not release a replacement claim after acquisition", async () => {
    const { statePath } = await fixture();
    const store = createPrivateAgentStore(options(statePath));
    const claim = await store.acquireMutationClaim();
    const displaced = `${store.mutationClaimPath}.displaced`;
    await rename(store.mutationClaimPath, displaced);
    await writeFile(store.mutationClaimPath, `${JSON.stringify({ pid: process.pid })}\n`, {
      mode: 0o700,
    });

    await expectAgentError(claim.release(), "RUNTIME_AGENT_PATH_UNSAFE");
    expect((await lstat(store.mutationClaimPath)).isFile()).toBe(true);
  });
});
