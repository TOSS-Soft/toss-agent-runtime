import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../src/protocol/json.js";
import type { ServiceLockV1 } from "../src/service/contracts.js";
import { RuntimeServiceError } from "../src/service/errors.js";
import {
  acquireInstanceLock,
  fileIdentityMatches,
  type ProcessLiveness,
} from "../src/service/instance-lock.js";

const oldId = "018f0f64-7b21-7d4f-8c3d-4a30413d5f41";
const newId = "018f0f64-7b21-7d4f-8c3d-4a30413d5f42";
const otherId = "018f0f64-7b21-7d4f-8c3d-4a30413d5f43";
const executableHash = "a".repeat(64);
const otherExecutableHash = "b".repeat(64);
const now = new Date("2026-08-19T12:00:00.000Z");

const temporaryDirectories: string[] = [];
const livenessCalls: number[] = [];

interface Fixture {
  readonly runtimePath: string;
  readonly lockPath: string;
  readonly ownerPath: string;
  readonly socketPath: string;
}

interface FixtureOverrides {
  readonly isAlive?: () => boolean | "unknown";
  readonly livenessForPid?: (pid: number) => ProcessLiveness;
  readonly identifySocket?: () => Promise<string | null>;
  readonly isCurrentUser?: (userId: bigint, candidate?: string) => boolean;
  readonly isRootUser?: (userId: bigint, candidate?: string) => boolean;
  readonly executableHash?: string;
  readonly instanceId?: string;
  readonly now?: () => Date;
  readonly createServiceInstanceId?: () => string;
  readonly operationHooks?: TestOperationHooks;
}

interface TestOperationHooks {
  readonly beforeOwnerClaimRename?: (operation: "reclaim" | "release") => Promise<void>;
  readonly afterOwnerClaimRename?: (operation: "reclaim" | "release") => Promise<void>;
  readonly afterOwnerlessSentinelCreate?: () => Promise<void>;
  readonly afterDocumentStageOpen?: (kind: TestDocumentKind) => Promise<void>;
  readonly afterDocumentStagePartialWrite?: (kind: TestDocumentKind) => Promise<void>;
  readonly afterDocumentStageSync?: (kind: TestDocumentKind) => Promise<void>;
  readonly afterDocumentPublishSync?: (kind: TestDocumentKind) => Promise<void>;
}

type TestDocumentKind = "owner" | "owner-claim" | "ownerless-claim";

let fixture: Fixture;

function serviceOwner(
  overrides: Partial<
    Pick<ServiceLockV1, "pid" | "service_instance_id" | "executable_hash" | "created_at">
  > = {},
): ServiceLockV1 {
  return {
    schema_version: "service-lock.v1",
    document_type: "service-lock",
    service_instance_id: overrides.service_instance_id ?? oldId,
    pid: overrides.pid ?? 4100,
    executable_hash: overrides.executable_hash ?? executableHash,
    created_at: overrides.created_at ?? "2026-08-19T11:00:00.000Z",
  };
}

async function writeOwner(owner: ServiceLockV1 = serviceOwner()): Promise<void> {
  await mkdir(fixture.lockPath, { mode: 0o700 });
  await chmod(fixture.lockPath, 0o700);
  await writeFile(fixture.ownerPath, canonicalJson(owner), { mode: 0o600 });
  await chmod(fixture.ownerPath, 0o600);
}

function options(overrides: FixtureOverrides = {}): Parameters<typeof acquireInstanceLock>[0] {
  return {
    lockPath: fixture.lockPath,
    socketPath: fixture.socketPath,
    pid: 4200,
    now: overrides.now ?? (() => now),
    createServiceInstanceId:
      overrides.createServiceInstanceId ?? (() => overrides.instanceId ?? newId),
    executableHash: overrides.executableHash ?? executableHash,
    processProbe: {
      liveness: (pid): ProcessLiveness => {
        livenessCalls.push(pid);
        if (overrides.livenessForPid !== undefined) return overrides.livenessForPid(pid);
        const liveness = overrides.isAlive?.() ?? false;
        return liveness === "unknown" ? "unknown" : liveness ? "alive" : "dead";
      },
    },
    socketProbe: {
      identify: overrides.identifySocket ?? (() => Promise.resolve(null)),
    },
    isCurrentUser: overrides.isCurrentUser ?? (() => true),
    ...(overrides.isRootUser === undefined ? {} : { isRootUser: overrides.isRootUser }),
    ...(overrides.operationHooks === undefined ? {} : { operationHooks: overrides.operationHooks }),
  };
}

function sensitiveRuntimeError(secret: string): RuntimeServiceError {
  const error = new RuntimeServiceError("RUNTIME_SERVICE_ALREADY_RUNNING");
  error.message = secret;
  return error;
}

async function writePrivate(candidate: string, bytes: string): Promise<void> {
  await writeFile(candidate, bytes, { mode: 0o600 });
  await chmod(candidate, 0o600);
}

async function reacquireAfterMovingCurrentLock(instanceId: string): Promise<void> {
  await rename(fixture.lockPath, `${fixture.lockPath}.displaced`);
  await acquireInstanceLock(options({ instanceId }));
}

function stagePrefix(kind: TestDocumentKind): string {
  if (kind === "owner") return ".owner-stage.";
  if (kind === "owner-claim") return ".owner-claim-stage.";
  return ".ownerless-claim-stage.";
}

async function preparePublication(kind: TestDocumentKind): Promise<void> {
  if (kind === "owner-claim") {
    await writeOwner();
    return;
  }
  if (kind === "ownerless-claim") {
    await mkdir(fixture.lockPath, { mode: 0o700 });
    await chmod(fixture.lockPath, 0o700);
    const stale = new Date(now.getTime() - 30_001);
    await utimes(fixture.lockPath, stale, stale);
  }
}

async function findStage(kind: TestDocumentKind): Promise<string> {
  const entries = await readdir(fixture.lockPath);
  const stages = entries.filter((entry) => entry.startsWith(stagePrefix(kind)));
  expect(stages).toHaveLength(1);
  return stages[0]!;
}

async function missing(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return false;
  } catch (error) {
    return (
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
  }
}

beforeEach(async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "toss-runtime-lock-")));
  temporaryDirectories.push(root);
  await chmod(root, 0o700);
  const runtimePath = path.join(root, "runtime");
  await mkdir(runtimePath, { mode: 0o700 });
  await chmod(runtimePath, 0o700);
  fixture = {
    runtimePath,
    lockPath: path.join(runtimePath, "instance.lock"),
    ownerPath: path.join(runtimePath, "instance.lock", "owner.json"),
    socketPath: path.join(runtimePath, "runtime.sock"),
  };
  livenessCalls.splice(0);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("runtime supervisor instance lock", () => {
  it("rejects a second live owner after probing the recorded pid", async () => {
    const first = await acquireInstanceLock(options({ isAlive: () => true }));

    await expect(acquireInstanceLock(options({ isAlive: () => true }))).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_ALREADY_RUNNING",
    });
    expect(livenessCalls).toEqual([first.owner.pid]);
    expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toEqual(first.owner);

    await first.release();
  });

  it("reclaims a private dead lock only when no socket identifies it", async () => {
    await writeOwner(serviceOwner({ pid: 4100, service_instance_id: oldId }));

    const lock = await acquireInstanceLock(
      options({ isAlive: () => false, identifySocket: () => Promise.resolve(null) }),
    );

    expect(lock.owner.service_instance_id).not.toBe(oldId);
    expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toEqual(lock.owner);
    await lock.release();
  });

  it.each([
    ["alive process with a mismatched executable", "alive", otherExecutableHash],
    ["ambiguous process", "unknown", executableHash],
  ] as const)("fails closed for an %s", async (_name, liveness, recordedHash) => {
    await writeOwner(serviceOwner({ executable_hash: recordedHash }));

    await expect(
      acquireInstanceLock(
        options({
          isAlive: () => (liveness === "alive" ? true : "unknown"),
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toMatchObject({
      service_instance_id: oldId,
    });
  });

  it("creates a private lock directory and canonical private owner document", async () => {
    const lock = await acquireInstanceLock(options());

    expect((await lstat(fixture.runtimePath)).mode & 0o777).toBe(0o700);
    expect((await lstat(fixture.lockPath)).mode & 0o777).toBe(0o700);
    expect((await lstat(fixture.ownerPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(fixture.ownerPath, "utf8")).toBe(canonicalJson(lock.owner));

    await lock.release();
    expect(await missing(fixture.lockPath)).toBe(true);
  });

  it("rejects an uppercase artifact identity before creating lock state", async () => {
    const incompatibleId = newId.toUpperCase();

    const error = await acquireInstanceLock(options({ instanceId: incompatibleId })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    expect(String(error)).not.toContain(incompatibleId);
    expect(await missing(fixture.lockPath)).toBe(true);

    const lock = await acquireInstanceLock(options({ instanceId: otherId }));
    expect(lock.owner.service_instance_id).toBe(otherId);
    await lock.release();
  });

  it("rejects a pre-epoch clock before creating lock state", async () => {
    const preEpoch = new Date(-1);

    await expect(acquireInstanceLock(options({ now: () => preEpoch }))).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS",
    });
    expect(await missing(fixture.lockPath)).toBe(true);

    const lock = await acquireInstanceLock(options({ instanceId: otherId }));
    expect(lock.owner.service_instance_id).toBe(otherId);
    await lock.release();
  });

  it.each([
    ["owner", "open"],
    ["owner", "partial"],
    ["owner-claim", "open"],
    ["owner-claim", "partial"],
    ["ownerless-claim", "open"],
    ["ownerless-claim", "partial"],
  ] as const)(
    "recovers a dead interrupted %s document after its stage %s boundary",
    async (kind, boundary) => {
      await preparePublication(kind);
      const crash = (actual: TestDocumentKind): Promise<void> =>
        actual === kind
          ? Promise.reject(new Error(`simulated-${kind}-${boundary}-crash`))
          : Promise.resolve();

      await expect(
        acquireInstanceLock(
          options({
            operationHooks:
              boundary === "open"
                ? { afterDocumentStageOpen: crash }
                : { afterDocumentStagePartialWrite: crash },
          }),
        ),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });

      const stage = await findStage(kind);
      const stageBytes = await readFile(path.join(fixture.lockPath, stage));
      if (boundary === "open") expect(stageBytes.byteLength).toBe(0);
      else expect(stageBytes.byteLength).toBeGreaterThan(0);

      const recovered = await acquireInstanceLock(
        options({ instanceId: otherId, livenessForPid: () => "dead" }),
      );
      expect(recovered.owner.service_instance_id).toBe(otherId);
      expect(await readFile(fixture.ownerPath, "utf8")).toBe(canonicalJson(recovered.owner));
      await recovered.release();
    },
  );

  it.each(["alive", "unknown"] as const)(
    "preserves an interrupted initial-owner stage whose claimant is %s",
    async (liveness) => {
      await expect(
        acquireInstanceLock(
          options({
            operationHooks: {
              afterDocumentStageOpen: () => Promise.reject(new Error("simulated-owner-crash")),
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
      const stage = await findStage("owner");

      await expect(
        acquireInstanceLock(options({ instanceId: otherId, livenessForPid: () => liveness })),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
      expect(await readdir(fixture.lockPath)).toEqual([stage]);
    },
  );

  it("preserves an interrupted stage when a listener identity conflicts", async () => {
    await expect(
      acquireInstanceLock(
        options({
          operationHooks: {
            afterDocumentStageOpen: () => Promise.reject(new Error("simulated-owner-crash")),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    const stage = await findStage("owner");

    await expect(
      acquireInstanceLock(
        options({
          instanceId: otherId,
          livenessForPid: () => "dead",
          identifySocket: () => Promise.resolve(oldId),
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    expect(await readdir(fixture.lockPath)).toEqual([stage]);
  });

  it("fails closed for malformed interrupted stage bytes", async () => {
    await expect(
      acquireInstanceLock(
        options({
          operationHooks: {
            afterDocumentStagePartialWrite: () =>
              Promise.reject(new Error("simulated-owner-partial-crash")),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    const stage = await findStage("owner");
    const stagePath = path.join(fixture.lockPath, stage);
    await writeFile(stagePath, "not-a-canonical-prefix", { mode: 0o600 });
    await chmod(stagePath, 0o600);

    await expect(
      acquireInstanceLock(options({ instanceId: otherId, livenessForPid: () => "dead" })),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    expect(await readFile(stagePath, "utf8")).toBe("not-a-canonical-prefix");
  });

  it("detects replacement of a stage inode during publication", async () => {
    await expect(
      acquireInstanceLock(
        options({
          operationHooks: {
            afterDocumentStagePartialWrite: async () => {
              const stage = await findStage("owner");
              const stagePath = path.join(fixture.lockPath, stage);
              const replacement = path.join(fixture.lockPath, ".replacement-stage");
              await writePrivate(replacement, await readFile(stagePath, "utf8"));
              await rename(replacement, stagePath);
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    expect(await findStage("owner")).toContain(newId);
  });

  it("fails closed when multiple strict stage artifacts exist", async () => {
    await expect(
      acquireInstanceLock(
        options({
          operationHooks: {
            afterDocumentStageOpen: () => Promise.reject(new Error("simulated-owner-crash")),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    const stage = await findStage("owner");
    const competingStage = stage.replace(newId, otherId);
    await writePrivate(path.join(fixture.lockPath, competingStage), "");

    await expect(
      acquireInstanceLock(options({ instanceId: oldId, livenessForPid: () => "dead" })),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    expect((await readdir(fixture.lockPath)).sort()).toEqual([competingStage, stage].sort());
  });

  it("does not overwrite an owner published while its stage is being synced", async () => {
    const replacementOwner = serviceOwner({ service_instance_id: otherId, pid: 4300 });

    await expect(
      acquireInstanceLock(
        options({
          operationHooks: {
            afterDocumentStageSync: async (kind) => {
              if (kind === "owner")
                await writePrivate(fixture.ownerPath, canonicalJson(replacementOwner));
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toEqual(replacementOwner);
    expect(await findStage("owner")).toContain(newId);
  });

  it.each(["owner", "owner-claim", "ownerless-claim"] as const)(
    "publishes exact canonical %s bytes before the post-directory-sync boundary",
    async (expectedKind) => {
      await preparePublication(expectedKind);
      const events: string[] = [];
      let stagedBytes: string | undefined;
      const finalPath =
        expectedKind === "owner"
          ? fixture.ownerPath
          : path.join(
              fixture.lockPath,
              expectedKind === "owner-claim"
                ? `.owner-claim.${newId}.json`
                : `.ownerless-reclaim.${newId}.json`,
            );

      await expect(
        acquireInstanceLock(
          options({
            operationHooks: {
              afterDocumentStageSync: async (kind) => {
                if (kind !== expectedKind) return;
                events.push("stage-synced");
                const stage = await findStage(expectedKind);
                stagedBytes = await readFile(path.join(fixture.lockPath, stage), "utf8");
                expect(stagedBytes).toBe(canonicalJson(JSON.parse(stagedBytes)));
                expect(await missing(finalPath)).toBe(true);
              },
              afterDocumentPublishSync: async (kind) => {
                if (kind !== expectedKind) return;
                events.push("directory-synced");
                const stage = await findStage(expectedKind);
                const stagePath = path.join(fixture.lockPath, stage);
                expect(await readFile(finalPath, "utf8")).toBe(stagedBytes);
                const [stageIdentity, finalIdentity] = await Promise.all([
                  lstat(stagePath, { bigint: true }),
                  lstat(finalPath, { bigint: true }),
                ]);
                expect(stageIdentity.ino).toBe(finalIdentity.ino);
                throw new Error("simulated-post-publish-crash");
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
      expect(events).toEqual(["stage-synced", "directory-synced"]);

      const recovered = await acquireInstanceLock(
        options({ instanceId: otherId, livenessForPid: () => "dead" }),
      );
      expect(recovered.owner.service_instance_id).toBe(otherId);
      await recovered.release();
    },
  );

  it("rejects claim publication on clock rollback before creating a stage", async () => {
    const futureOwner = serviceOwner({ created_at: "2026-08-19T13:00:00.000Z" });
    await writeOwner(futureOwner);

    await expect(acquireInstanceLock(options())).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS",
    });
    expect(await readdir(fixture.lockPath)).toEqual(["owner.json"]);
    expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toEqual(futureOwner);
  });

  it("rejects a lock target outside the fixed instance.lock deletion scope", async () => {
    const stale = new Date(now.getTime() - 30_001);
    await utimes(fixture.runtimePath, stale, stale);
    const unsafeOptions = {
      ...options(),
      lockPath: fixture.runtimePath,
      socketPath: path.join(path.dirname(fixture.runtimePath), "runtime.sock"),
    };

    await expect(acquireInstanceLock(unsafeOptions)).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect((await lstat(fixture.runtimePath)).isDirectory()).toBe(true);
    expect(await readdir(fixture.runtimePath)).toEqual([]);
  });

  it.each([
    ["runtime directory", "runtime", 0o770],
    ["lock directory", "lock", 0o750],
    ["owner document", "owner", 0o640],
  ] as const)("rejects unsafe permissions on the %s", async (_name, target, mode) => {
    if (target !== "runtime") await writeOwner();
    await chmod(
      target === "runtime"
        ? fixture.runtimePath
        : target === "lock"
          ? fixture.lockPath
          : fixture.ownerPath,
      mode,
    );

    await expect(acquireInstanceLock(options())).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
  });

  it("rejects a modeled root-owned writable ancestor without the sticky bit", async () => {
    const modeledRoot = await mkdtemp(path.join(await realpath("/tmp"), "toss-modeled-root-"));
    temporaryDirectories.push(modeledRoot);
    await chmod(modeledRoot, 0o777);
    const runtimePath = path.join(modeledRoot, "runtime");
    await mkdir(runtimePath, { mode: 0o700 });
    fixture = {
      runtimePath,
      lockPath: path.join(runtimePath, "instance.lock"),
      ownerPath: path.join(runtimePath, "instance.lock", "owner.json"),
      socketPath: path.join(runtimePath, "runtime.sock"),
    };
    const currentUid = BigInt(process.getuid?.() ?? 0);

    await expect(
      acquireInstanceLock(
        options({
          isCurrentUser: (uid, candidate) => uid === currentUid && candidate !== modeledRoot,
          isRootUser: (uid, candidate) => uid === 0n || candidate === modeledRoot,
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
  });

  it("accepts a real sticky directory modeled as a root-owned leading ancestor", async () => {
    const modeledRoot = await mkdtemp(path.join(await realpath("/tmp"), "toss-modeled-root-"));
    temporaryDirectories.push(modeledRoot);
    await chmod(modeledRoot, 0o1777);
    expect((await lstat(modeledRoot)).mode & 0o1777).toBe(0o1777);
    const runtimePath = path.join(modeledRoot, "runtime");
    await mkdir(runtimePath, { mode: 0o700 });
    fixture = {
      runtimePath,
      lockPath: path.join(runtimePath, "instance.lock"),
      ownerPath: path.join(runtimePath, "instance.lock", "owner.json"),
      socketPath: path.join(runtimePath, "runtime.sock"),
    };
    const currentUid = BigInt(process.getuid?.() ?? 0);

    const lock = await acquireInstanceLock(
      options({
        isCurrentUser: (uid, candidate) => uid === currentUid && candidate !== modeledRoot,
        isRootUser: (uid, candidate) => uid === 0n || candidate === modeledRoot,
      }),
    );

    expect(lock.owner.service_instance_id).toBe(newId);
    await lock.release();
  });

  it("keeps bigint filesystem identities distinct above Number.MAX_SAFE_INTEGER", () => {
    const common = 9_007_199_254_740_992n;

    expect(
      fileIdentityMatches(
        { device: common, inode: common },
        { device: common, inode: common + 1n },
      ),
    ).toBe(false);
  });

  it.each(["runtime", "lock", "owner"] as const)(
    "rejects a %s path treated as cross-owner",
    async (target) => {
      if (target !== "runtime") await writeOwner();
      const rejectedPath =
        target === "runtime"
          ? fixture.runtimePath
          : target === "lock"
            ? fixture.lockPath
            : fixture.ownerPath;

      await expect(
        acquireInstanceLock(
          options({
            isCurrentUser: (_userId, candidate) => candidate !== rejectedPath,
          }),
        ),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    },
  );

  it("rejects a symlinked owner without reading or changing its target", async () => {
    const target = path.join(fixture.runtimePath, "outside-owner.json");
    const original = canonicalJson(serviceOwner());
    await writeFile(target, original, { mode: 0o600 });
    await chmod(target, 0o600);
    await mkdir(fixture.lockPath, { mode: 0o700 });
    await chmod(fixture.lockPath, 0o700);
    await symlink(target, fixture.ownerPath);

    await expect(acquireInstanceLock(options())).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await readFile(target, "utf8")).toBe(original);
  });

  it("rejects a non-regular owner document", async () => {
    await mkdir(fixture.lockPath, { mode: 0o700 });
    await chmod(fixture.lockPath, 0o700);
    await mkdir(fixture.ownerPath, { mode: 0o700 });

    await expect(acquireInstanceLock(options())).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
  });

  it.each([
    ["malformed", "{not-json"],
    ["oversized", "x".repeat(65_537)],
  ])("fails closed for a %s owner document", async (_name, bytes) => {
    await mkdir(fixture.lockPath, { mode: 0o700 });
    await chmod(fixture.lockPath, 0o700);
    await writeFile(fixture.ownerPath, bytes, { mode: 0o600 });
    await chmod(fixture.ownerPath, 0o600);

    const error = await acquireInstanceLock(options()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS",
      message: "Runtime service lock state is ambiguous",
    });
    expect(String(error)).not.toContain(fixture.lockPath);
    expect(await readFile(fixture.ownerPath, "utf8")).toBe(bytes);
  });

  it.each([
    [
      "duplicate-key",
      `{"created_at":"2026-08-19T11:00:00.000Z","document_type":"service-lock","executable_hash":"${executableHash}","pid":4100,"pid":4101,"schema_version":"service-lock.v1","service_instance_id":"${oldId}"}`,
    ],
    ["noncanonical", JSON.stringify(serviceOwner(), null, 2)],
  ])("fails closed for a %s owner document without rewriting it", async (_name, bytes) => {
    await mkdir(fixture.lockPath, { mode: 0o700 });
    await chmod(fixture.lockPath, 0o700);
    await writePrivate(fixture.ownerPath, bytes);

    await expect(acquireInstanceLock(options())).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS",
    });
    expect(await readFile(fixture.ownerPath, "utf8")).toBe(bytes);
  });

  it("redacts owner-construction dependency failures before touching the lock path", async () => {
    const secret = "sensitive-id-generator-detail";
    const unsafeOptions = {
      ...options(),
      createServiceInstanceId: (): string => {
        throw new Error(secret);
      },
    };

    const error = await acquireInstanceLock(unsafeOptions).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS",
      message: "Runtime service lock state is ambiguous",
    });
    expect(String(error)).not.toContain(secret);
    expect(await missing(fixture.lockPath)).toBe(true);
  });

  it.each(["id", "clock", "owner"] as const)(
    "normalizes a RuntimeServiceError thrown by the %s dependency",
    async (dependency) => {
      const secret = `sensitive-${dependency}-runtime-error`;
      const thrown = sensitiveRuntimeError(secret);
      let unsafeOptions = options();
      if (dependency === "id") {
        unsafeOptions = {
          ...unsafeOptions,
          createServiceInstanceId: (): string => {
            throw thrown;
          },
        };
      } else if (dependency === "clock") {
        unsafeOptions = {
          ...unsafeOptions,
          now: (): Date => {
            throw thrown;
          },
        };
      } else {
        Object.defineProperty(unsafeOptions, "executableHash", {
          configurable: true,
          enumerable: true,
          get(): string {
            throw thrown;
          },
        });
      }

      const error = await acquireInstanceLock(unsafeOptions).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS",
        message: "Runtime service lock state is ambiguous",
      });
      expect(String(error)).not.toContain(secret);
      expect(await missing(fixture.lockPath)).toBe(true);
    },
  );

  it.each(["plain", "runtime"] as const)(
    "normalizes a %s process-probe exception",
    async (kind) => {
      await writeOwner();
      const secret = `sensitive-${kind}-process-probe-detail`;

      const error = await acquireInstanceLock(
        options({
          isAlive: () => {
            throw kind === "plain" ? new Error(secret) : sensitiveRuntimeError(secret);
          },
        }),
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS",
        message: "Runtime service lock state is ambiguous",
      });
      expect(String(error)).not.toContain(secret);
    },
  );

  it.each(["plain", "runtime"] as const)("normalizes a %s socket-probe exception", async (kind) => {
    await writeOwner();
    const secret = `sensitive-${kind}-socket-probe-detail`;

    const error = await acquireInstanceLock(
      options({
        identifySocket: () =>
          Promise.reject(kind === "plain" ? new Error(secret) : sensitiveRuntimeError(secret)),
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS",
      message: "Runtime service lock state is ambiguous",
    });
    expect(String(error)).not.toContain(secret);
  });

  it("redacts ownership-probe failures before touching the lock path", async () => {
    const secret = "sensitive-ownership-probe-detail";

    const error = await acquireInstanceLock(
      options({
        isCurrentUser: () => {
          throw new Error(secret);
        },
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
      message: "Runtime service path is unsafe",
    });
    expect(String(error)).not.toContain(secret);
    expect(await missing(fixture.lockPath)).toBe(true);
  });

  it("does not reclaim a missing owner younger than 30 seconds", async () => {
    await mkdir(fixture.lockPath, { mode: 0o700 });
    await chmod(fixture.lockPath, 0o700);
    const young = new Date(now.getTime() - 29_999);
    await utimes(fixture.lockPath, young, young);

    await expect(acquireInstanceLock(options())).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS",
    });
    expect(await readdir(fixture.lockPath)).toEqual([]);
  });

  it("reclaims a missing owner older than 30 seconds only with no listener", async () => {
    await mkdir(fixture.lockPath, { mode: 0o700 });
    await chmod(fixture.lockPath, 0o700);
    const stale = new Date(now.getTime() - 30_001);
    await utimes(fixture.lockPath, stale, stale);

    const lock = await acquireInstanceLock(
      options({ identifySocket: () => Promise.resolve(null) }),
    );

    expect(lock.owner.service_instance_id).toBe(newId);
    await lock.release();
  });

  it("cleans its exact ownerless sentinel when a socket listener exists", async () => {
    await mkdir(fixture.lockPath, { mode: 0o700 });
    await chmod(fixture.lockPath, 0o700);
    const stale = new Date(now.getTime() - 30_001);
    await utimes(fixture.lockPath, stale, stale);

    await expect(
      acquireInstanceLock(options({ identifySocket: () => Promise.resolve(otherId) })),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    expect(await readdir(fixture.lockPath)).toEqual([]);
  });

  it("retries an ownerless lock after a listener disappears", async () => {
    await mkdir(fixture.lockPath, { mode: 0o700 });
    await chmod(fixture.lockPath, 0o700);
    const stale = new Date(now.getTime() - 30_001);
    await utimes(fixture.lockPath, stale, stale);

    await expect(
      acquireInstanceLock(options({ identifySocket: () => Promise.resolve(otherId) })),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });

    const later = new Date(now.getTime() + 86_400_000);
    const lock = await acquireInstanceLock(
      options({
        instanceId: otherId,
        now: () => later,
        identifySocket: () => Promise.resolve(null),
      }),
    );
    expect(lock.owner.service_instance_id).toBe(otherId);
    await lock.release();
  });

  it("reports an accepting socket with the recorded identity as already running", async () => {
    await writeOwner();

    await expect(
      acquireInstanceLock(
        options({
          isAlive: () => false,
          identifySocket: () => Promise.resolve(oldId),
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_ALREADY_RUNNING" });
    expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toMatchObject({
      service_instance_id: oldId,
    });
  });

  it("fails closed when a socket listener reports a different service identity", async () => {
    await writeOwner();

    await expect(
      acquireInstanceLock(
        options({
          isAlive: () => false,
          identifySocket: () => Promise.resolve(otherId),
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toMatchObject({
      service_instance_id: oldId,
    });
  });

  it.each(["rewritten", "replaced"] as const)(
    "does not reclaim an owner %s during the asynchronous socket probe",
    async (mutation) => {
      await writeOwner();
      const changedOwner = serviceOwner({ pid: 4101 });

      await expect(
        acquireInstanceLock(
          options({
            identifySocket: async () => {
              if (mutation === "rewritten") {
                await writeFile(fixture.ownerPath, canonicalJson(changedOwner), { mode: 0o600 });
                await chmod(fixture.ownerPath, 0o600);
              } else {
                const replacement = path.join(fixture.lockPath, ".replacement-owner");
                await writePrivate(replacement, canonicalJson(changedOwner));
                await rename(replacement, fixture.ownerPath);
              }
              return null;
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });

      const claim = `.owner-claim.${newId}.json`;
      expect(await readdir(fixture.lockPath)).toEqual([claim, "owner.json"]);
      expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toEqual(changedOwner);
    },
  );

  it("recovers a dead interrupted owner claim after the owner rename", async () => {
    await writeOwner();

    await expect(
      acquireInstanceLock(
        options({
          operationHooks: {
            afterOwnerClaimRename: () =>
              Promise.reject(new Error("simulated-crash-after-owner-rename")),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    expect(await readdir(fixture.lockPath)).toEqual([
      `.owner-claim.${newId}.json`,
      `.owner-claim.${newId}.owner.json`,
    ]);
    expect(
      JSON.parse(await readFile(path.join(fixture.lockPath, `.owner-claim.${newId}.json`), "utf8")),
    ).toMatchObject({
      claim_kind: "owner",
      claimant: {
        service_instance_id: newId,
        pid: 4200,
        executable_hash: executableHash,
        created_at: now.toISOString(),
      },
      original_owner: { service_instance_id: oldId, pid: 4100 },
    });

    const recovered = await acquireInstanceLock(
      options({
        instanceId: otherId,
        livenessForPid: () => "dead",
      }),
    );
    expect(recovered.owner.service_instance_id).toBe(otherId);
    await recovered.release();
  });

  it.each(["alive", "unknown"] as const)(
    "does not recover an interrupted owner claim whose claimant is %s",
    async (claimantLiveness) => {
      await writeOwner();
      await expect(
        acquireInstanceLock(
          options({
            operationHooks: {
              afterOwnerClaimRename: () =>
                Promise.reject(new Error("simulated-crash-after-owner-rename")),
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
      const entries = await readdir(fixture.lockPath);

      await expect(
        acquireInstanceLock(
          options({
            instanceId: otherId,
            livenessForPid: (pid) => (pid === 4200 ? claimantLiveness : "dead"),
          }),
        ),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
      expect(await readdir(fixture.lockPath)).toEqual(entries);
    },
  );

  it("fails closed when the original owner liveness is unknown during claim recovery", async () => {
    await writeOwner();
    await expect(
      acquireInstanceLock(
        options({
          operationHooks: {
            afterOwnerClaimRename: () =>
              Promise.reject(new Error("simulated-crash-after-owner-rename")),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });

    await expect(
      acquireInstanceLock(
        options({
          instanceId: otherId,
          livenessForPid: (pid) => (pid === 4100 ? "unknown" : "dead"),
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
  });

  it.each(["malformed", "replaced", "multiple"] as const)(
    "fails closed when an owned claim is %s after rename",
    async (mutation) => {
      await writeOwner();
      const claimPath = path.join(fixture.lockPath, `.owner-claim.${newId}.json`);

      await expect(
        acquireInstanceLock(
          options({
            operationHooks: {
              afterOwnerClaimRename: async () => {
                if (mutation === "malformed") {
                  await writeFile(claimPath, "{}", { mode: 0o600 });
                } else if (mutation === "replaced") {
                  const replacement = path.join(fixture.lockPath, ".replacement-claim");
                  await writePrivate(replacement, await readFile(claimPath, "utf8"));
                  await rename(replacement, claimPath);
                } else {
                  await writePrivate(path.join(fixture.lockPath, ".unexpected-claim"), "preserve");
                }
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
      expect((await lstat(fixture.lockPath)).isDirectory()).toBe(true);
    },
  );

  it.each(["duplicate-key", "noncanonical"] as const)(
    "fails closed for %s interrupted-claim bytes",
    async (mutation) => {
      await writeOwner();
      await expect(
        acquireInstanceLock(
          options({
            operationHooks: {
              afterOwnerClaimRename: () =>
                Promise.reject(new Error("simulated-crash-after-owner-rename")),
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
      const claimPath = path.join(fixture.lockPath, `.owner-claim.${newId}.json`);
      const claimBytes = await readFile(claimPath, "utf8");
      const changed =
        mutation === "duplicate-key"
          ? claimBytes.replace("{", '{"claim_kind":"owner",')
          : JSON.stringify(JSON.parse(claimBytes), null, 2);
      await writeFile(claimPath, changed, { mode: 0o600 });
      await chmod(claimPath, 0o600);

      await expect(
        acquireInstanceLock(options({ instanceId: otherId, livenessForPid: () => "dead" })),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
      expect(await readFile(claimPath, "utf8")).toBe(changed);
    },
  );

  it("does not delete a new actor that reacquires before stale-owner claim", async () => {
    await writeOwner();

    await expect(
      acquireInstanceLock(
        options({
          operationHooks: {
            beforeOwnerClaimRename: async (operation) => {
              if (operation === "reclaim") await reacquireAfterMovingCurrentLock(otherId);
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });

    expect(await readdir(fixture.lockPath)).toEqual(["owner.json"]);
    expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toMatchObject({
      service_instance_id: otherId,
    });
  });

  it("fails closed when a concurrent reclaimer inserts another owner claim", async () => {
    await writeOwner();
    const competingClaim = path.join(fixture.lockPath, `.owner-claim.${otherId}.json`);

    await expect(
      acquireInstanceLock(
        options({
          operationHooks: {
            beforeOwnerClaimRename: async (operation) => {
              if (operation === "reclaim") {
                await writePrivate(competingClaim, canonicalJson(serviceOwner()));
              }
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });

    expect(await readdir(fixture.lockPath)).toEqual([
      `.owner-claim.${newId}.json`,
      `.owner-claim.${otherId}.json`,
      "owner.json",
    ]);
  });

  it("fails closed when a concurrent reclaimer inserts another ownerless sentinel", async () => {
    await mkdir(fixture.lockPath, { mode: 0o700 });
    await chmod(fixture.lockPath, 0o700);
    const stale = new Date(now.getTime() - 30_001);
    await utimes(fixture.lockPath, stale, stale);
    const competingSentinel = path.join(fixture.lockPath, `.ownerless-reclaim.${otherId}.json`);

    await expect(
      acquireInstanceLock(
        options({
          operationHooks: {
            afterOwnerlessSentinelCreate: async () => {
              await writePrivate(competingSentinel, "");
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });

    expect(await readdir(fixture.lockPath)).toEqual([
      `.ownerless-reclaim.${newId}.json`,
      `.ownerless-reclaim.${otherId}.json`,
    ]);
  });

  it("recovers a dead interrupted ownerless sentinel after creation", async () => {
    await mkdir(fixture.lockPath, { mode: 0o700 });
    await chmod(fixture.lockPath, 0o700);
    const stale = new Date(now.getTime() - 30_001);
    await utimes(fixture.lockPath, stale, stale);

    await expect(
      acquireInstanceLock(
        options({
          operationHooks: {
            afterOwnerlessSentinelCreate: () =>
              Promise.reject(new Error("simulated-crash-after-sentinel-create")),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    expect(await readdir(fixture.lockPath)).toEqual([`.ownerless-reclaim.${newId}.json`]);
    expect(
      JSON.parse(
        await readFile(path.join(fixture.lockPath, `.ownerless-reclaim.${newId}.json`), "utf8"),
      ),
    ).toMatchObject({
      claim_kind: "ownerless",
      claimant: {
        service_instance_id: newId,
        pid: 4200,
        executable_hash: executableHash,
        created_at: now.toISOString(),
      },
      original_owner: null,
    });

    const recovered = await acquireInstanceLock(
      options({ instanceId: otherId, livenessForPid: () => "dead" }),
    );
    expect(recovered.owner.service_instance_id).toBe(otherId);
    await recovered.release();
  });

  it.each(["alive", "unknown"] as const)(
    "does not recover an interrupted ownerless sentinel whose claimant is %s",
    async (claimantLiveness) => {
      await mkdir(fixture.lockPath, { mode: 0o700 });
      await chmod(fixture.lockPath, 0o700);
      const stale = new Date(now.getTime() - 30_001);
      await utimes(fixture.lockPath, stale, stale);
      await expect(
        acquireInstanceLock(
          options({
            operationHooks: {
              afterOwnerlessSentinelCreate: () =>
                Promise.reject(new Error("simulated-crash-after-sentinel-create")),
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });

      await expect(
        acquireInstanceLock(
          options({ instanceId: otherId, livenessForPid: () => claimantLiveness }),
        ),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
      expect(await readdir(fixture.lockPath)).toEqual([`.ownerless-reclaim.${newId}.json`]);
    },
  );

  it("cleans an unmodified ownerless sentinel after a socket-probe failure", async () => {
    await mkdir(fixture.lockPath, { mode: 0o700 });
    await chmod(fixture.lockPath, 0o700);
    const stale = new Date(now.getTime() - 30_001);
    await utimes(fixture.lockPath, stale, stale);

    await expect(
      acquireInstanceLock(
        options({ identifySocket: () => Promise.reject(new Error("sensitive-listener-detail")) }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS" });
    expect(await readdir(fixture.lockPath)).toEqual([]);
  });

  it("does not release a lock whose owner identity was replaced", async () => {
    const lock = await acquireInstanceLock(options());
    await writeFile(fixture.ownerPath, canonicalJson(serviceOwner()), { mode: 0o600 });
    await chmod(fixture.ownerPath, 0o600);

    await lock.release();

    expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toMatchObject({
      service_instance_id: oldId,
    });
    expect((await lstat(fixture.lockPath)).isDirectory()).toBe(true);
  });

  it("does not release an owner document changed in place under the same instance ID", async () => {
    const lock = await acquireInstanceLock(options());
    const changedOwner = { ...lock.owner, pid: lock.owner.pid + 1 };
    await writeFile(fixture.ownerPath, canonicalJson(changedOwner), { mode: 0o600 });
    await chmod(fixture.ownerPath, 0o600);

    await lock.release();

    expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toEqual(changedOwner);
    expect((await lstat(fixture.lockPath)).isDirectory()).toBe(true);
  });

  it("does not delete a new actor that reacquires before release claim", async () => {
    const lock = await acquireInstanceLock(
      options({
        operationHooks: {
          beforeOwnerClaimRename: async (operation) => {
            if (operation === "release") await reacquireAfterMovingCurrentLock(otherId);
          },
        },
      }),
    );

    await expect(lock.release()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS",
    });

    expect(await readdir(fixture.lockPath)).toEqual(["owner.json"]);
    expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toMatchObject({
      service_instance_id: otherId,
    });
  });

  it("reports release failure without partially deleting a non-empty lock", async () => {
    const lock = await acquireInstanceLock(options());
    const unexpected = path.join(fixture.lockPath, "unexpected");
    await writeFile(unexpected, "preserve", { mode: 0o600 });

    await expect(lock.release()).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS",
      message: "Runtime service lock state is ambiguous",
    });
    expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toEqual(lock.owner);
    expect(await readFile(unexpected, "utf8")).toBe("preserve");
  });

  it("never recursively deletes unexpected stale-lock contents", async () => {
    await writeOwner();
    const nested = path.join(fixture.lockPath, "nested");
    await mkdir(nested, { mode: 0o700 });
    await writeFile(path.join(nested, "preserve"), "owned elsewhere", { mode: 0o600 });

    await expect(acquireInstanceLock(options())).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_LOCK_AMBIGUOUS",
    });
    expect(await readFile(path.join(nested, "preserve"), "utf8")).toBe("owned elsewhere");
    expect(JSON.parse(await readFile(fixture.ownerPath, "utf8"))).toMatchObject({
      service_instance_id: oldId,
    });
  });
});
