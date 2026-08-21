import { createHash } from "node:crypto";
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
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
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
const servers: Server[] = [];

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
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function listen(socketPath: string): Promise<void> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
}

async function probeListener(socketPath: string): Promise<"present" | "absent" | "unknown"> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    socket.once("connect", () => {
      socket.destroy();
      resolve("present");
    });
    socket.once("error", (error) => {
      resolve(
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
          ? "absent"
          : "unknown",
      );
    });
  });
}

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

  it("snapshots mutable caller bytes synchronously before its first suspension", async () => {
    const { statePath } = await fixture();
    const callerBytes = Buffer.from("entry-snapshot-A", "utf8");
    const entryBytes = Buffer.from(callerBytes);
    const hash = contentHash(entryBytes);
    const store = createPrivateAgentStore(options(statePath));

    const pending = store.publishObject(hash, callerBytes);
    callerBytes.fill("B".charCodeAt(0));
    const published = await pending;

    expect(published.bytes).toEqual(entryBytes);
    expect((await store.readObject(hash))?.bytes).toEqual(entryBytes);
  });

  it("rejects oversized caller bytes before entering private snapshot allocation", async () => {
    const { statePath } = await fixture();
    let snapshotAllocations = 0;
    const operationHooks = {
      beforeSnapshotAllocation: () => {
        snapshotAllocations += 1;
      },
    } as unknown as PrivateAgentStoreOperationHooks;
    const store = createPrivateAgentStore(options(statePath, { operationHooks }));
    const oversized = Buffer.alloc(MAX_PRIVATE_OBJECT_BYTES + 1);

    await expectAgentError(
      store.publishObject(contentHash(oversized), oversized),
      "RUNTIME_AGENT_REGISTRY_CORRUPT",
    );
    expect(snapshotAllocations).toBe(0);

    const bounded = Buffer.from("bounded-snapshot", "utf8");
    await store.publishObject(contentHash(bounded), bounded);
    expect(snapshotAllocations).toBe(1);
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

  it("orders after-stage-cleanup only after the held cleanup-directory barrier", async () => {
    const { statePath } = await fixture();
    const bytes = Buffer.from("cleanup-order", "utf8");
    const order: string[] = [];
    const operationHooks = {
      afterCleanupSync: (kind: string) => {
        if (kind === "stage") order.push("cleanup-synced");
        return Promise.resolve();
      },
      afterStageCleanup: () => {
        order.push("after-cleanup");
        return Promise.resolve();
      },
    } as unknown as PrivateAgentStoreOperationHooks;

    await createPrivateAgentStore(options(statePath, { operationHooks })).publishObject(
      contentHash(bytes),
      bytes,
    );
    expect(order).toEqual(["cleanup-synced", "after-cleanup"]);
  });

  it("runs a cleanup barrier after pre-publication failure and allows exact retry", async () => {
    const { statePath } = await fixture();
    const bytes = Buffer.from("catch-cleanup-barrier", "utf8");
    const hash = contentHash(bytes);
    const order: string[] = [];
    const operationHooks = {
      beforeFileSync: () => {
        order.push("file-fault");
        return Promise.reject(new Error("file sync fault"));
      },
      afterCleanupSync: (kind: string) => {
        if (kind === "stage") order.push("cleanup-synced");
        return Promise.resolve();
      },
    } as unknown as PrivateAgentStoreOperationHooks;
    const failing = createPrivateAgentStore(options(statePath, { operationHooks }));

    await expectAgentError(failing.publishObject(hash, bytes), "RUNTIME_AGENT_REGISTRY_CORRUPT");
    expect(order).toEqual(["file-fault", "cleanup-synced"]);
    await expect(
      createPrivateAgentStore(options(statePath)).publishObject(hash, bytes),
    ).resolves.toMatchObject({
      bytes,
    });
  });

  it("fails replay when its cleanup barrier fails and remains exactly retryable", async () => {
    const { statePath } = await fixture();
    const bytes = Buffer.from("replay-cleanup-barrier", "utf8");
    const hash = contentHash(bytes);
    await createPrivateAgentStore(options(statePath)).publishObject(hash, bytes);
    const operationHooks = {
      beforeCleanupSync: (kind: string) => {
        return kind === "stage"
          ? Promise.reject(new Error("cleanup sync fault"))
          : Promise.resolve();
      },
    } as unknown as PrivateAgentStoreOperationHooks;

    await expectAgentError(
      createPrivateAgentStore(options(statePath, { operationHooks })).publishObject(hash, bytes),
      "RUNTIME_AGENT_REGISTRY_CORRUPT",
    );
    await expect(
      createPrivateAgentStore(options(statePath)).publishObject(hash, bytes),
    ).resolves.toMatchObject({
      bytes,
    });
  });

  it("tombstones a stage replacement after final identity validation without deleting it", async () => {
    const { statePath } = await fixture();
    const bytes = Buffer.from("stage-tombstone-race", "utf8");
    const replacement = Buffer.from("stage-replacement", "utf8");
    let sourcePath = "";
    const operationHooks = {
      afterFinalSourceIdentityValidation: (kind: string, candidate: string) => {
        if (kind !== "stage") return;
        sourcePath = candidate;
        renameSync(candidate, `${candidate}.original`);
        writeFileSync(candidate, replacement, { mode: 0o600 });
      },
    } as unknown as PrivateAgentStoreOperationHooks;
    const store = createPrivateAgentStore(options(statePath, { operationHooks }));

    await expectAgentError(
      store.publishObject(contentHash(bytes), bytes),
      "RUNTIME_AGENT_PATH_UNSAFE",
    );
    await expect(lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    const tombstones = (await readdir(store.objectsPath)).filter((name) =>
      name.endsWith(".tombstone"),
    );
    expect(tombstones).toHaveLength(1);
    expect(await readFile(path.join(store.objectsPath, tombstones[0]!))).toEqual(replacement);
  });

  it("preserves both a tombstoned stage and a source entry that reappears", async () => {
    const { statePath } = await fixture();
    const bytes = Buffer.from("stage-source-reappearance", "utf8");
    const replacement = Buffer.from("reappeared-source", "utf8");
    let sourcePath = "";
    const operationHooks = {
      afterTombstoneRename: (kind: string, candidate: string) => {
        if (kind !== "stage") return;
        sourcePath = candidate;
        writeFileSync(candidate, replacement, { mode: 0o600 });
      },
    } as unknown as PrivateAgentStoreOperationHooks;
    const store = createPrivateAgentStore(options(statePath, { operationHooks }));

    await expectAgentError(
      store.publishObject(contentHash(bytes), bytes),
      "RUNTIME_AGENT_PATH_UNSAFE",
    );
    expect(await readFile(sourcePath)).toEqual(replacement);
    const tombstones = (await readdir(store.objectsPath)).filter((name) =>
      name.endsWith(".tombstone"),
    );
    expect(tombstones).toHaveLength(1);
    expect(await readFile(path.join(store.objectsPath, tombstones[0]!))).toEqual(bytes);
  });

  it("revalidates held ancestry before returning a missing object", async () => {
    const { statePath } = await fixture();
    const agentsPath = path.join(statePath, "agents");
    const operationHooks = {
      afterObjectMissing: async () => {
        await rename(agentsPath, `${agentsPath}.original`);
        await mkdir(agentsPath, { mode: 0o700 });
      },
    } as unknown as PrivateAgentStoreOperationHooks;
    const store = createPrivateAgentStore(options(statePath, { operationHooks }));

    await expectAgentError(
      store.readObject(`sha256:${"a".repeat(64)}`),
      "RUNTIME_AGENT_PATH_UNSAFE",
    );
  });

  it("revalidates the original publication ancestry before exact replay returns", async () => {
    const { statePath } = await fixture();
    const bytes = Buffer.from("replay-ancestry", "utf8");
    const hash = contentHash(bytes);
    const first = createPrivateAgentStore(options(statePath));
    await first.publishObject(hash, bytes);
    const agentsPath = first.agentsPath;
    const operationHooks = {
      afterLinkCollision: async () => {
        await rename(agentsPath, `${agentsPath}.original`);
        await mkdir(agentsPath, { mode: 0o700 });
      },
    } as unknown as PrivateAgentStoreOperationHooks;

    await expectAgentError(
      createPrivateAgentStore(options(statePath, { operationHooks })).publishObject(hash, bytes),
      "RUNTIME_AGENT_PATH_UNSAFE",
    );
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

  it("preserves a stale claim when the authoritative listener is present at a non-default socket", async () => {
    const { root, statePath } = await fixture();
    const socketPath = path.join(root, "custom-control.sock");
    await listen(socketPath);
    const first = createPrivateAgentStore(options(statePath));
    const held = await first.acquireMutationClaim();
    const contender = createPrivateAgentStore(
      options(statePath, {
        isProcessAlive: () => "dead",
        hasServiceListener: () => probeListener(socketPath),
      }),
    );

    await expectAgentError(contender.acquireMutationClaim(), "RUNTIME_AGENT_REGISTRY_CORRUPT");
    expect((await lstat(first.mutationClaimPath)).isFile()).toBe(true);
    await held.release();
  });

  it("never guesses listener absence when the mandatory authoritative probe is omitted", async () => {
    const { root, statePath } = await fixture();
    await listen(path.join(root, "live-non-default.sock"));
    const first = createPrivateAgentStore(options(statePath));
    const held = await first.acquireMutationClaim();
    const contender = createPrivateAgentStore({
      statePath,
      isProcessAlive: () => "dead",
    } as unknown as CreatePrivateAgentStoreOptions);

    const result = await contender.acquireMutationClaim().then(
      (claim) => ({ claim }) as const,
      (error: unknown) => ({ error }) as const,
    );
    if ("claim" in result) {
      await expectAgentError(held.release(), "RUNTIME_AGENT_PATH_UNSAFE");
      await result.claim.release();
      expect.fail("store recovered without an authoritative listener probe");
    }
    expect(result.error).toBeInstanceOf(RuntimeAgentError);
    expect(result.error).toMatchObject({ code: "RUNTIME_AGENT_REGISTRY_CORRUPT" });
    await held.release();
  });

  it("bounds a never-settling authoritative listener probe and fails closed", async () => {
    const { statePath } = await fixture();
    const first = createPrivateAgentStore(options(statePath));
    const held = await first.acquireMutationClaim();
    const contender = createPrivateAgentStore(
      options(statePath, {
        isProcessAlive: () => "dead",
        hasServiceListener: () => new Promise(() => undefined),
      }),
    );

    await expectAgentError(contender.acquireMutationClaim(), "RUNTIME_AGENT_REGISTRY_CORRUPT");
    expect((await lstat(first.mutationClaimPath)).isFile()).toBe(true);
    await held.release();
  }, 2_000);

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

  it("durably cleans a failed claim creation before an exact retry", async () => {
    const { statePath } = await fixture();
    const order: string[] = [];
    const operationHooks = {
      beforeClaimFileSync: () => {
        order.push("claim-fault");
        return Promise.reject(new Error("claim sync fault"));
      },
      afterCleanupSync: (kind: string) => {
        if (kind === "claim") order.push("cleanup-synced");
        return Promise.resolve();
      },
    } as unknown as PrivateAgentStoreOperationHooks;
    const failing = createPrivateAgentStore(options(statePath, { operationHooks }));

    await expectAgentError(failing.acquireMutationClaim(), "RUNTIME_AGENT_REGISTRY_CORRUPT");
    expect(order).toEqual(["claim-fault", "cleanup-synced"]);
    await expect(lstat(failing.mutationClaimPath)).rejects.toMatchObject({ code: "ENOENT" });
    const retry = await createPrivateAgentStore(options(statePath)).acquireMutationClaim();
    await retry.release();
  });

  it("tombstones a claim replacement after final identity validation without deleting it", async () => {
    const { statePath } = await fixture();
    const replacement = Buffer.from(JSON.stringify({ pid: process.pid + 1 }), "utf8");
    let sourcePath = "";
    const operationHooks = {
      afterFinalSourceIdentityValidation: (kind: string, candidate: string) => {
        if (kind !== "claim-release") return;
        sourcePath = candidate;
        renameSync(candidate, `${candidate}.original`);
        writeFileSync(candidate, replacement, { mode: 0o700 });
      },
    } as unknown as PrivateAgentStoreOperationHooks;
    const store = createPrivateAgentStore(options(statePath, { operationHooks }));
    const claim = await store.acquireMutationClaim();

    await expectAgentError(claim.release(), "RUNTIME_AGENT_PATH_UNSAFE");
    await expect(lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    const tombstones = (await readdir(store.registryPath)).filter((name) =>
      name.endsWith(".tombstone"),
    );
    expect(tombstones).toHaveLength(1);
    expect(await readFile(path.join(store.registryPath, tombstones[0]!))).toEqual(replacement);
  });

  it("memoizes normal sequential and concurrent release and closes once", async () => {
    const sequentialStore = createPrivateAgentStore(options((await fixture()).statePath));
    const sequential = await sequentialStore.acquireMutationClaim();
    const firstRelease = sequential.release();
    const secondRelease = sequential.release();
    expect(secondRelease).toBe(firstRelease);
    await Promise.all([firstRelease, secondRelease]);
    expect(sequential.release()).toBe(firstRelease);
    await sequential.release();

    const concurrentStore = createPrivateAgentStore(options((await fixture()).statePath));
    const concurrent = await concurrentStore.acquireMutationClaim();
    await expect(
      Promise.all([concurrent.release(), concurrent.release(), concurrent.release()]),
    ).resolves.toEqual([undefined, undefined, undefined]);
  });

  it("memoizes a cleanup-sync release failure for all concurrent and repeated callers", async () => {
    const { statePath } = await fixture();
    let syncAttempts = 0;
    const operationHooks = {
      beforeCleanupSync: (kind: string) => {
        if (kind !== "claim-release") return Promise.resolve();
        syncAttempts += 1;
        return Promise.reject(new Error("release cleanup sync fault"));
      },
    } as unknown as PrivateAgentStoreOperationHooks;
    const store = createPrivateAgentStore(options(statePath, { operationHooks }));
    const claim = await store.acquireMutationClaim();

    const firstRelease = claim.release();
    const secondRelease = claim.release();
    expect(secondRelease).toBe(firstRelease);
    const results = await Promise.allSettled([firstRelease, secondRelease]);
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("rejected");
    if (results[0]?.status === "rejected" && results[1]?.status === "rejected") {
      expect(results[1].reason).toBe(results[0].reason);
    }
    expect(syncAttempts).toBe(1);
    expect(claim.release()).toBe(firstRelease);
    await expect(claim.release()).rejects.toMatchObject({
      code: "RUNTIME_AGENT_REGISTRY_CORRUPT",
    });
  });
});
