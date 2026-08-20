import type { BigIntStats } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPrivateAtomicIfMissing,
  ensureServiceConfig,
  readPrivateRegularFile,
  removeOwnedDefinition,
  writePrivateAtomic,
} from "../src/service/definition-store.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(parent = tmpdir()): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(parent, "toss-runtime-store-")));
  temporaryDirectories.push(directory);
  return directory;
}

async function privateFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function lstatBigInt(
  candidate: Parameters<typeof lstat>[0],
  options: { bigint: true },
): Promise<BigIntStats> {
  return lstat(candidate, options);
}

function validYaml(root: string): string {
  return `schema_version: runtime-config.v1
document_type: runtime-config
mode: development
paths:
  state: ${root}/state
  logs: ${root}/logs
  socket: ${root}/runtime.sock
shutdown_timeout_ms: 30000
logs:
  level: info
  retention_days: 7
  max_bytes: 104857600
gateway_profile: null
provider_profiles: []
mcp_profiles: []
secret_references: {}
`;
}

function modeledRootOwnedOperations(rootOwnedPath: string, permissions: number) {
  return {
    lstat: async (candidate: Parameters<typeof lstat>[0], options: { bigint: true }) => {
      const metadata = await lstat(candidate, options);
      const candidatePath = String(candidate);
      const relative = path.relative(candidatePath, rootOwnedPath);
      const leadingAncestor =
        relative === "" || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`));
      if (!leadingAncestor) return metadata;
      const modeled = Object.create(metadata) as BigIntStats;
      Object.defineProperty(modeled, "uid", { value: 0n });
      if (candidatePath === rootOwnedPath) {
        Object.defineProperty(modeled, "mode", {
          value: (metadata.mode & ~0o7777n) | BigInt(permissions),
        });
      }
      return modeled;
    },
    mkdir,
    open,
    rename,
    unlink,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("private service definition storage", () => {
  it("reports a missing private definition as atomically created", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "manager", "definition.service");

    await expect(
      createPrivateAtomicIfMissing({
        target,
        bytes: new TextEncoder().encode("expected"),
        randomSuffix: () => "fixed",
        parentPolicy: "owned-not-writable",
      }),
    ).resolves.toBe("created");
    expect(await readFile(target, "utf8")).toBe("expected");
  });

  it("reports an atomically raced private definition as existing without replacing it", async () => {
    const root = await temporaryDirectory();
    const parent = path.join(root, "manager");
    const target = path.join(parent, "definition.service");

    await expect(
      createPrivateAtomicIfMissing({
        target,
        bytes: new TextEncoder().encode("expected"),
        randomSuffix: () => "fixed",
        parentPolicy: "owned-not-writable",
        beforePublish: async () => {
          await privateFile(target, "raced-winner");
        },
      }),
    ).resolves.toBe("existing");
    expect(await readFile(target, "utf8")).toBe("raced-winner");
    expect(await readdir(parent)).toEqual(["definition.service"]);
  });

  it("materializes a private validated default config without replacing an existing file", async () => {
    const home = await temporaryDirectory();
    const configPath = await ensureServiceConfig({
      platform: "linux",
      home,
      env: { TOSS_TEST_SECRET: "must-not-persist" },
      randomSuffix: () => "fixed",
    });

    expect(configPath).toBe(path.join(home, ".config", "toss", "runtime", "config.yaml"));
    expect((await lstat(configPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(path.dirname(configPath))).mode & 0o777).toBe(0o700);
    const first = await readFile(configPath, "utf8");
    expect(first).toContain("schema_version: runtime-config.v1");
    expect(first).toContain(`state: ${path.join(home, ".local", "state", "toss", "runtime")}`);
    expect(first).toContain("secret_references: {}");
    expect(first).not.toContain("must-not-persist");

    await ensureServiceConfig({
      platform: "linux",
      home,
      env: { TOSS_TEST_SECRET: "a-different-secret" },
      randomSuffix: () => "fixed-2",
    });
    expect(await readFile(configPath, "utf8")).toBe(first);
  });

  it("refuses to replace a symlinked definition", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "target.service");
    const definition = path.join(root, "definition.service");
    await privateFile(target, "owned");
    await symlink(target, definition);

    await expect(
      writePrivateAtomic({
        target: definition,
        bytes: new TextEncoder().encode("unit"),
        randomSuffix: () => "fixed",
        parentPolicy: "owned-not-writable",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    expect(await readFile(target, "utf8")).toBe("owned");
  });

  it("creates missing private parents as mode 0700 and the file as mode 0600", async () => {
    const root = await temporaryDirectory();
    const parent = path.join(root, "private", "nested");
    const target = path.join(parent, "definition.service");

    await writePrivateAtomic({
      target,
      bytes: new TextEncoder().encode("unit"),
      randomSuffix: () => "fixed",
      parentPolicy: "private",
    });

    expect((await lstat(path.join(root, "private"))).mode & 0o777).toBe(0o700);
    expect((await lstat(parent)).mode & 0o777).toBe(0o700);
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
  });

  it("rejects an existing non-private config parent", async () => {
    const root = await temporaryDirectory();
    const parent = path.join(root, "config");
    await mkdir(parent, { mode: 0o755 });
    await chmod(parent, 0o755);

    await expect(
      writePrivateAtomic({
        target: path.join(parent, "config.yaml"),
        bytes: new TextEncoder().encode("config"),
        randomSuffix: () => "fixed",
        parentPolicy: "private",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
  });

  it("allows a conventional readable manager parent but rejects group-writable parents", async () => {
    const root = await temporaryDirectory();
    const parent = path.join(root, "manager");
    await mkdir(parent, { mode: 0o755 });
    await chmod(parent, 0o755);
    const target = path.join(parent, "definition.service");

    await writePrivateAtomic({
      target,
      bytes: new TextEncoder().encode("unit"),
      randomSuffix: () => "fixed",
      parentPolicy: "owned-not-writable",
    });
    expect(await readFile(target, "utf8")).toBe("unit");

    await writePrivateAtomic({
      target,
      bytes: new TextEncoder().encode("replacement"),
      randomSuffix: () => "fixed-2",
      parentPolicy: "owned-not-writable",
    });
    expect(await readFile(target, "utf8")).toBe("replacement");

    await chmod(parent, 0o775);
    await expect(
      writePrivateAtomic({
        target,
        bytes: new TextEncoder().encode("unsafe-replacement"),
        randomSuffix: () => "fixed-3",
        parentPolicy: "owned-not-writable",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    expect(await readFile(target, "utf8")).toBe("replacement");
  });

  it("rejects a group-writable existing intermediate directory", async () => {
    const root = await temporaryDirectory();
    const intermediate = path.join(root, "unsafe-intermediate");
    const parent = path.join(intermediate, "manager");
    const target = path.join(parent, "definition.service");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(intermediate, 0o770);

    await expect(
      writePrivateAtomic({
        target,
        bytes: new TextEncoder().encode("unit"),
        randomSuffix: () => "fixed",
        parentPolicy: "owned-not-writable",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a modeled root-owned world-writable non-sticky leading ancestor", async () => {
    const root = await temporaryDirectory();
    const rootOwned = path.join(root, "modeled-root-owned");
    const parent = path.join(rootOwned, "user-owned", "manager");
    const target = path.join(parent, "definition.service");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(rootOwned, 0o777);

    await expect(
      writePrivateAtomic({
        target,
        bytes: new TextEncoder().encode("unit"),
        randomSuffix: () => "fixed",
        parentPolicy: "owned-not-writable",
        operations: modeledRootOwnedOperations(rootOwned, 0o777),
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows a modeled root-owned world-writable sticky leading ancestor", async () => {
    const root = await temporaryDirectory();
    const rootOwned = path.join(root, "modeled-root-owned");
    const parent = path.join(rootOwned, "user-owned", "manager");
    const target = path.join(parent, "definition.service");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(rootOwned, 0o777);

    await writePrivateAtomic({
      target,
      bytes: new TextEncoder().encode("unit"),
      randomSuffix: () => "fixed",
      parentPolicy: "owned-not-writable",
      operations: modeledRootOwnedOperations(rootOwned, 0o1777),
    });
    expect(await readFile(target, "utf8")).toBe("unit");
  });

  it("allows a real root-owned world-writable sticky temporary ancestor", async () => {
    const systemTemporaryRoot = await realpath("/tmp");
    const metadata = await lstat(systemTemporaryRoot);
    expect(metadata.uid).toBe(0);
    expect(metadata.mode & 0o022).not.toBe(0);
    expect(metadata.mode & 0o1000).not.toBe(0);
    const root = await temporaryDirectory(systemTemporaryRoot);
    const parent = path.join(root, "manager");
    const target = path.join(parent, "definition.service");

    await writePrivateAtomic({
      target,
      bytes: new TextEncoder().encode("unit"),
      randomSuffix: () => "fixed",
      parentPolicy: "owned-not-writable",
    });

    expect(await readFile(target, "utf8")).toBe("unit");
  });

  it("rejects an existing intermediate directory treated as third-party-owned", async () => {
    const root = await temporaryDirectory();
    const intermediate = path.join(root, "cross-owner-intermediate");
    const parent = path.join(intermediate, "manager");
    const target = path.join(parent, "definition.service");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const injectedOwnership = (_userId: number, candidate?: string): boolean =>
      candidate !== intermediate;

    await expect(
      writePrivateAtomic({
        target,
        bytes: new TextEncoder().encode("unit"),
        randomSuffix: () => "fixed",
        parentPolicy: "owned-not-writable",
        isCurrentUser: injectedOwnership,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a parent or target that is not owned by the current user", async () => {
    const root = await temporaryDirectory();

    await expect(
      writePrivateAtomic({
        target: path.join(root, "definition.service"),
        bytes: new TextEncoder().encode("unit"),
        randomSuffix: () => "fixed",
        parentPolicy: "owned-not-writable",
        isCurrentUser: () => false,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });

    const target = path.join(root, "existing.service");
    await privateFile(target, "old");
    await expect(
      writePrivateAtomic({
        target,
        bytes: new TextEncoder().encode("new"),
        randomSuffix: () => "fixed-2",
        parentPolicy: "owned-not-writable",
        isCurrentUser: (_userId, candidate) => candidate !== target,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    expect(await readFile(target, "utf8")).toBe("old");
  });

  it("rejects non-regular and group-readable destination files", async () => {
    const root = await temporaryDirectory();
    const directoryTarget = path.join(root, "directory.service");
    await mkdir(directoryTarget, { mode: 0o700 });
    await expect(
      writePrivateAtomic({
        target: directoryTarget,
        bytes: new TextEncoder().encode("unit"),
        randomSuffix: () => "fixed",
        parentPolicy: "owned-not-writable",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });

    const readableTarget = path.join(root, "readable.service");
    await writeFile(readableTarget, "old", { mode: 0o644 });
    await chmod(readableTarget, 0o644);
    await expect(
      writePrivateAtomic({
        target: readableTarget,
        bytes: new TextEncoder().encode("unit"),
        randomSuffix: () => "fixed-2",
        parentPolicy: "owned-not-writable",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    expect(await readFile(readableTarget, "utf8")).toBe("old");
  });

  it("writes and syncs a same-directory temporary file before rename, then syncs the parent", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "definition.service");
    const events: string[] = [];

    await writePrivateAtomic({
      target,
      bytes: new TextEncoder().encode("unit"),
      randomSuffix: () => "fixed",
      parentPolicy: "owned-not-writable",
      operations: {
        lstat: lstatBigInt,
        mkdir,
        unlink,
        rename: async (source, destination) => {
          events.push(
            `rename:${path.basename(String(source))}:${path.basename(String(destination))}`,
          );
          await rename(source, destination);
        },
        open: async (filePath, flags, mode) => {
          const handle = await open(filePath, flags, mode);
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            events.push(filePath === root ? "directory-sync" : "file-sync");
            await originalSync();
          };
          return handle;
        },
      },
    });

    expect(events).toEqual([
      "file-sync",
      "rename:.definition.service.fixed.tmp:definition.service",
      "directory-sync",
    ]);
    expect(await readFile(target, "utf8")).toBe("unit");
    expect(await readdir(root)).toEqual(["definition.service"]);
  });

  it("cleans only its private temporary file when publication fails", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "definition.service");
    await privateFile(target, "old");

    await expect(
      writePrivateAtomic({
        target,
        bytes: new TextEncoder().encode("new"),
        randomSuffix: () => "fixed",
        parentPolicy: "owned-not-writable",
        operations: {
          lstat: lstatBigInt,
          mkdir,
          open,
          unlink,
          rename: () => Promise.reject(new Error("injected rename failure")),
        },
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });

    expect(await readFile(target, "utf8")).toBe("old");
    expect(await readdir(root)).toEqual(["definition.service"]);
  });

  it("cleans its exact temporary inode when a restrictive umask prevents mode 0600", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "definition.service");
    await privateFile(target, "preserve");
    const previousUmask = process.umask(0o777);

    try {
      await expect(
        writePrivateAtomic({
          target,
          bytes: new TextEncoder().encode("replacement"),
          randomSuffix: () => "fixed",
          parentPolicy: "owned-not-writable",
        }),
      ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    } finally {
      process.umask(previousUmask);
    }

    expect(await readFile(target, "utf8")).toBe("preserve");
    expect(await readdir(root)).toEqual(["definition.service"]);
  });

  it("does not clean a temporary file when large inode identities differ beyond safe integers", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "definition.service");
    const temporary = path.join(root, ".definition.service.fixed.tmp");
    const createdIdentity = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const replacedIdentity = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    await privateFile(target, "preserve");

    await expect(
      writePrivateAtomic({
        target,
        bytes: new TextEncoder().encode("replacement"),
        randomSuffix: () => "fixed",
        parentPolicy: "owned-not-writable",
        operations: {
          lstat: async (candidate: Parameters<typeof lstat>[0], options: { bigint: true }) => {
            const metadata = await lstat(candidate, options);
            if (String(candidate) !== temporary) return metadata;
            const modeled = Object.create(metadata) as BigIntStats;
            Object.defineProperties(modeled, {
              dev: { value: replacedIdentity },
              ino: { value: replacedIdentity },
            });
            return modeled;
          },
          mkdir,
          open: async (
            filePath: Parameters<typeof open>[0],
            flags: Parameters<typeof open>[1],
            mode: Parameters<typeof open>[2],
          ) => {
            const handle = await open(filePath, flags, mode);
            const stat = handle.stat.bind(handle);
            Object.defineProperty(handle, "stat", {
              value: async (options?: Parameters<typeof handle.stat>[0]) => {
                const metadata =
                  options?.bigint === true ? await stat({ bigint: true }) : await stat();
                if (String(filePath) !== temporary) return metadata;
                const modeled = Object.create(metadata) as BigIntStats;
                Object.defineProperties(modeled, {
                  dev: { value: createdIdentity },
                  ino: { value: createdIdentity },
                });
                return modeled;
              },
            });
            return handle;
          },
          unlink,
          rename: () => Promise.reject(new Error("injected rename failure")),
        },
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });

    expect(await readFile(target, "utf8")).toBe("preserve");
    expect(await readFile(temporary, "utf8")).toBe("replacement");
  });

  it("does not delete a colliding caller-owned temporary path", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "definition.service");
    const collision = path.join(root, ".definition.service.fixed.tmp");
    await privateFile(collision, "preserve");

    await expect(
      writePrivateAtomic({
        target,
        bytes: new TextEncoder().encode("unit"),
        randomSuffix: () => "fixed",
        parentPolicy: "owned-not-writable",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    expect(await readFile(collision, "utf8")).toBe("preserve");
  });

  it("validates an existing standard config and never rewrites invalid contents", async () => {
    const home = await temporaryDirectory();
    const parent = path.join(home, ".config", "toss", "runtime");
    const configPath = path.join(parent, "config.yaml");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    await privateFile(configPath, "schema_version: invalid\nsecret: must-not-persist\n");

    await expect(
      ensureServiceConfig({
        platform: "linux",
        home,
        env: {},
        randomSuffix: () => "fixed",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
    expect(await readFile(configPath, "utf8")).toBe(
      "schema_version: invalid\nsecret: must-not-persist\n",
    );
  });

  it("validates an explicit config without writing or replacing any config", async () => {
    const home = await temporaryDirectory();
    const explicitPath = path.join(home, "explicit.yaml");
    await privateFile(explicitPath, "not: a-runtime-config\n");

    await expect(
      ensureServiceConfig({
        explicitPath,
        platform: "linux",
        home,
        env: {},
        randomSuffix: () => "fixed",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
    expect(await readFile(explicitPath, "utf8")).toBe("not: a-runtime-config\n");
    await expect(lstat(path.join(home, ".config"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves environment-selected config loading semantics", async () => {
    const home = await temporaryDirectory();
    const environmentPath = path.join(home, "environment.yaml");
    await privateFile(environmentPath, validYaml(home));

    await expect(
      ensureServiceConfig({
        platform: "linux",
        home,
        env: { TOSS_RUNTIME_CONFIG: environmentPath },
        randomSuffix: () => "fixed",
      }),
    ).resolves.toBe(environmentPath);
    expect(await readFile(environmentPath, "utf8")).toBe(validYaml(home));
    await expect(lstat(path.join(home, ".config"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reloads a valid config that appears immediately before atomic publication", async () => {
    const home = await temporaryDirectory();
    const configPath = path.join(home, ".config", "toss", "runtime", "config.yaml");
    const competingConfig = validYaml(home).replace("level: info", "level: warn");
    let publicationHooks = 0;

    await expect(
      ensureServiceConfig({
        platform: "linux",
        home,
        env: {},
        randomSuffix: () => "fixed",
        beforeConfigPublish: async () => {
          publicationHooks += 1;
          await privateFile(configPath, competingConfig);
        },
      }),
    ).resolves.toBe(configPath);

    expect(publicationHooks).toBe(1);
    expect(await readFile(configPath, "utf8")).toBe(competingConfig);
    expect(await readdir(path.dirname(configPath))).toEqual(["config.yaml"]);
  });

  it("reads and removes only private owned regular definition files", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "definition.service");
    await privateFile(target, "unit");

    const bytes = await readPrivateRegularFile(target);
    expect(bytes).toBeDefined();
    expect(new TextDecoder().decode(bytes)).toBe("unit");
    await removeOwnedDefinition(target);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(removeOwnedDefinition(target)).resolves.toBeUndefined();

    const preserved = path.join(root, "preserved.service");
    const link = path.join(root, "link.service");
    await privateFile(preserved, "preserve");
    await symlink(preserved, link);
    await expect(removeOwnedDefinition(link)).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
    expect(await readFile(preserved, "utf8")).toBe("preserve");
  });

  it("accepts a private definition of exactly 65,536 bytes", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "definition.service");
    await writeFile(target, new Uint8Array(65_536), { mode: 0o600 });
    await chmod(target, 0o600);

    await expect(readPrivateRegularFile(target)).resolves.toHaveLength(65_536);
  });

  it("rejects a sparse private definition larger than 65,536 bytes", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "definition.service");
    await privateFile(target, "");
    await truncate(target, 65_537);

    await expect(readPrivateRegularFile(target)).rejects.toMatchObject({
      code: "RUNTIME_SERVICE_PATH_UNSAFE",
    });
  });

  it("rejects a private definition that grows after descriptor validation", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "definition.service");
    await writeFile(target, new Uint8Array(65_536), { mode: 0o600 });
    await chmod(target, 0o600);

    await expect(
      readPrivateRegularFile(target, {
        beforeRead: async () => {
          await appendFile(target, new Uint8Array(65_536));
        },
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
  });

  it("refuses to read a definition through a symlinked parent", async () => {
    const root = await temporaryDirectory();
    const actualParent = path.join(root, "actual");
    const linkedParent = path.join(root, "linked");
    await mkdir(actualParent, { mode: 0o700 });
    await privateFile(path.join(actualParent, "definition.service"), "preserve");
    await symlink(actualParent, linkedParent);

    await expect(
      readPrivateRegularFile(path.join(linkedParent, "definition.service")),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
  });

  it("refuses to remove a definition through a symlinked parent", async () => {
    const root = await temporaryDirectory();
    const actualParent = path.join(root, "actual");
    const linkedParent = path.join(root, "linked");
    const actualDefinition = path.join(actualParent, "definition.service");
    await mkdir(actualParent, { mode: 0o700 });
    await privateFile(actualDefinition, "preserve");
    await symlink(actualParent, linkedParent);

    await expect(
      removeOwnedDefinition(path.join(linkedParent, "definition.service")),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    expect(await readFile(actualDefinition, "utf8")).toBe("preserve");
  });

  it("treats a definition beneath a missing parent as already removed", async () => {
    const root = await temporaryDirectory();
    await expect(
      removeOwnedDefinition(path.join(root, "missing", "definition.service")),
    ).resolves.toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects unsafe suffixes without creating files outside the destination parent", async () => {
    const root = await temporaryDirectory();
    await expect(
      writePrivateAtomic({
        target: path.join(root, "definition.service"),
        bytes: new TextEncoder().encode("unit"),
        randomSuffix: () => "../escape",
        parentPolicy: "owned-not-writable",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SERVICE_PATH_UNSAFE" });
    expect(await readdir(root)).toEqual([]);
  });
});
