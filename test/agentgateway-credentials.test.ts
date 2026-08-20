import { describe, expect, it, vi } from "vitest";

import {
  createGatewayCredentialCoordinator,
  type GatewayCredentialLease,
  type GatewayCredentialProvider,
} from "../src/gateway/index.js";
import { RuntimeProviderError } from "../src/providers/index.js";

const reference = { source: "command", key: "TOSS_AGENTGATEWAY_TOKEN" } as const;
const otherReference = { source: "command", key: "TOSS_AGENTGATEWAY_TOKEN_SECONDARY" } as const;
const token = "virtual-token-0123456789";

function lease(expiresAt = "2026-08-20T10:01:00.000Z"): GatewayCredentialLease {
  return { scheme: "Bearer", token, expires_at: expiresAt };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("agentgateway credential coordinator", () => {
  it("reuses a valid lease and refreshes at 29,999 ms remaining", async () => {
    let current = new Date("2026-08-20T10:00:00.000Z");
    const resolve = vi
      .fn<GatewayCredentialProvider["resolve"]>()
      .mockResolvedValueOnce(lease("2026-08-20T10:00:31.000Z"))
      .mockResolvedValueOnce(lease("2026-08-20T10:02:00.000Z"));
    const provider: GatewayCredentialProvider = {
      resolve,
    };
    const coordinator = createGatewayCredentialCoordinator({
      provider,
      now: () => current,
    });

    await expect(coordinator.resolve(reference, new AbortController().signal)).resolves.toEqual(
      lease("2026-08-20T10:00:31.000Z"),
    );
    current = new Date("2026-08-20T10:00:01.000Z");
    await coordinator.resolve(reference, new AbortController().signal);
    expect(resolve).toHaveBeenCalledTimes(1);

    current = new Date("2026-08-20T10:00:01.001Z");
    await expect(coordinator.resolve(reference, new AbortController().signal)).resolves.toEqual(
      lease("2026-08-20T10:02:00.000Z"),
    );
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("single-flights the same exact reference across coordinator instances", async () => {
    const pending = deferred<unknown>();
    const resolve = vi.fn<GatewayCredentialProvider["resolve"]>(() => pending.promise);
    const provider: GatewayCredentialProvider = { resolve };
    const first = createGatewayCredentialCoordinator({
      provider,
      now: () => new Date("2026-08-20T10:00:00.000Z"),
    });
    const second = createGatewayCredentialCoordinator({
      provider,
      now: () => new Date("2026-08-20T10:00:00.000Z"),
    });

    const left = first.resolve(reference, new AbortController().signal);
    const right = second.resolve(reference, new AbortController().signal);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    pending.resolve(lease());

    await expect(Promise.all([left, right])).resolves.toEqual([lease(), lease()]);
    const call = resolve.mock.calls[0];
    expect(call?.[0]).toEqual(reference);
    expect(call?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(call?.[1].minimum_validity_ms).toBe(30_000);
  });

  it("keeps different exact references in independent flights", async () => {
    const resolve = vi.fn<GatewayCredentialProvider["resolve"]>(() => Promise.resolve(lease()));
    const provider: GatewayCredentialProvider = { resolve };
    const first = createGatewayCredentialCoordinator({
      provider,
      now: () => new Date("2026-08-20T10:00:00.000Z"),
    });
    const second = createGatewayCredentialCoordinator({
      provider,
      now: () => new Date("2026-08-20T10:00:00.000Z"),
    });

    await Promise.all([
      first.resolve(reference, new AbortController().signal),
      second.resolve(otherReference, new AbortController().signal),
    ]);

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("aborts the resolver when the final waiting caller is cancelled", async () => {
    let resolverSignal: AbortSignal | undefined;
    const provider: GatewayCredentialProvider = {
      resolve: (_reference, options) => {
        resolverSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("resolver abort sentinel must-not-leak")),
            { once: true },
          );
        });
      },
    };
    const coordinator = createGatewayCredentialCoordinator({
      provider,
      now: () => new Date("2026-08-20T10:00:00.000Z"),
    });
    const controller = new AbortController();
    const operation = coordinator.resolve(reference, controller.signal);

    controller.abort();

    await expect(operation).rejects.toEqual(
      new RuntimeProviderError("RUNTIME_PROVIDER_AUTHENTICATION"),
    );
    expect(resolverSignal?.aborted).toBe(true);
  });

  it("rejects a pre-aborted caller before invoking the credential provider", async () => {
    const resolve = vi.fn<GatewayCredentialProvider["resolve"]>(() => Promise.resolve(lease()));
    const provider: GatewayCredentialProvider = { resolve };
    const coordinator = createGatewayCredentialCoordinator({
      provider,
      now: () => new Date("2026-08-20T10:00:00.000Z"),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(coordinator.resolve(reference, controller.signal)).rejects.toEqual(
      new RuntimeProviderError("RUNTIME_PROVIDER_AUTHENTICATION"),
    );
    await Promise.resolve();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("normalizes resolver rejection without reflecting native detail", async () => {
    const provider: GatewayCredentialProvider = {
      resolve: () => Promise.reject(new Error("resolver secret must-not-leak")),
    };
    const coordinator = createGatewayCredentialCoordinator({
      provider,
      now: () => new Date("2026-08-20T10:00:00.000Z"),
    });

    let error: unknown;
    try {
      await coordinator.resolve(reference, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }

    expect(error).toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_AUTHENTICATION"));
    expect(String(error)).not.toContain("must-not-leak");
  });

  it.each([
    ["short token", { ...lease(), token: "x".repeat(15) }],
    ["long token", { ...lease(), token: "x".repeat(8193) }],
    ["space", { ...lease(), token: "virtual token value" }],
    ["tab", { ...lease(), token: "virtual\ttoken-value" }],
    ["carriage return", { ...lease(), token: "virtual\rtoken-value" }],
    ["line feed", { ...lease(), token: "virtual\ntoken-value" }],
    ["NUL", { ...lease(), token: "virtual\0token-value" }],
    ["scheme", { ...lease(), scheme: "Basic" }],
    ["timestamp", { ...lease(), expires_at: "2026-08-20T10:01:00+00:00" }],
    ["expired", { ...lease(), expires_at: "2026-08-20T10:00:29.999Z" }],
    ["extra field", { ...lease(), authorization: "must-not-leak" }],
  ] as const)("rejects an invalid lease %s", async (_name, candidate) => {
    const provider: GatewayCredentialProvider = { resolve: () => Promise.resolve(candidate) };
    const coordinator = createGatewayCredentialCoordinator({
      provider,
      now: () => new Date("2026-08-20T10:00:00.000Z"),
    });

    let error: unknown;
    try {
      await coordinator.resolve(reference, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }

    expect(error).toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_AUTHENTICATION"));
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain("must-not-leak");
  });

  it.each([
    [
      "accessor",
      () => {
        const value = lease() as unknown as Record<string, unknown>;
        Object.defineProperty(value, "token", {
          enumerable: true,
          get() {
            throw new Error("getter must-not-run");
          },
        });
        return value;
      },
    ],
    ["symbol", () => Object.assign(lease(), { [Symbol("secret")]: "must-not-leak" })],
    [
      "proxy",
      () =>
        new Proxy(lease(), {
          ownKeys() {
            throw new Error("proxy trap must-not-leak");
          },
        }),
    ],
  ] as const)(
    "rejects an untrusted lease %s without invoking or reflecting it",
    async (_name, make) => {
      const provider: GatewayCredentialProvider = { resolve: () => Promise.resolve(make()) };
      const coordinator = createGatewayCredentialCoordinator({
        provider,
        now: () => new Date("2026-08-20T10:00:00.000Z"),
      });

      let error: unknown;
      try {
        await coordinator.resolve(reference, new AbortController().signal);
      } catch (caught) {
        error = caught;
      }

      expect(error).toEqual(new RuntimeProviderError("RUNTIME_PROVIDER_AUTHENTICATION"));
      expect(String(error)).not.toContain("must-not");
    },
  );

  it("clears cached and in-flight references without claiming token zeroization", async () => {
    const pending = deferred<unknown>();
    const resolve = vi.fn<GatewayCredentialProvider["resolve"]>(() => pending.promise);
    const provider: GatewayCredentialProvider = { resolve };
    const coordinator = createGatewayCredentialCoordinator({
      provider,
      now: () => new Date("2026-08-20T10:00:00.000Z"),
    });
    const operation = coordinator.resolve(reference, new AbortController().signal);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));

    coordinator.clear();

    await expect(operation).rejects.toEqual(
      new RuntimeProviderError("RUNTIME_PROVIDER_AUTHENTICATION"),
    );
    pending.resolve(lease());
  });
});
