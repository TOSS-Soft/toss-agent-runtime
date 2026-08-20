import type { SecretReference } from "../config/types.js";
import { canonicalJson, deepFreezeJson, parseJsonBytes, type JsonValue } from "../protocol/json.js";
import { RuntimeProviderError } from "../providers/errors.js";
import type {
  GatewayCredentialCoordinator,
  GatewayCredentialLease,
  GatewayCredentialProvider,
} from "./types.js";

const MINIMUM_VALIDITY_MS = 30_000 as const;
const REFERENCE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

interface CredentialFlight {
  readonly controller: AbortController;
  readonly promise: Promise<GatewayCredentialLease>;
  readonly cancelled: Promise<never>;
  readonly cancel: () => void;
  waiters: number;
}

interface CredentialEntry {
  lease?: GatewayCredentialLease;
  inflight?: CredentialFlight;
}

const providerStates = new WeakMap<GatewayCredentialProvider, Map<string, CredentialEntry>>();

function authentication(): RuntimeProviderError {
  return new RuntimeProviderError("RUNTIME_PROVIDER_AUTHENTICATION");
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedReference(reference: SecretReference): {
  readonly key: string;
  readonly value: SecretReference;
} {
  let parsed: JsonValue;
  try {
    parsed = parseJsonBytes(canonicalJson(reference));
  } catch {
    throw authentication();
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).sort().join("\u0000") !== "key\u0000source" ||
    (parsed.source !== "env" && parsed.source !== "command") ||
    typeof parsed.key !== "string" ||
    !REFERENCE_PATTERN.test(parsed.key)
  ) {
    throw authentication();
  }
  const value = deepFreezeJson({ source: parsed.source, key: parsed.key }) as SecretReference;
  return { key: canonicalJson(value), value };
}

function normalizeLease(value: unknown): GatewayCredentialLease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw authentication();
  }
  let prototype: object | null;
  let symbols: readonly symbol[];
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    symbols = Object.getOwnPropertySymbols(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw authentication();
  }
  if (prototype !== Object.prototype && prototype !== null) throw authentication();
  if (symbols.length !== 0) throw authentication();
  if (Object.keys(descriptors).sort().join("\u0000") !== "expires_at\u0000scheme\u0000token") {
    throw authentication();
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw authentication();
    }
  }
  const scheme: unknown = descriptors.scheme?.value;
  const token: unknown = descriptors.token?.value;
  const expiresAt: unknown = descriptors.expires_at?.value;
  if (
    scheme !== "Bearer" ||
    typeof token !== "string" ||
    Buffer.byteLength(token, "utf8") < 16 ||
    Buffer.byteLength(token, "utf8") > 8192 ||
    /[\s\u0000-\u001f\u007f]/u.test(token) ||
    typeof expiresAt !== "string"
  ) {
    throw authentication();
  }
  const milliseconds = Date.parse(expiresAt);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== expiresAt) {
    throw authentication();
  }
  return Object.freeze({ scheme, token, expires_at: expiresAt });
}

function currentTime(now: () => Date): number {
  let value: Date;
  try {
    value = now();
  } catch {
    throw authentication();
  }
  const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(milliseconds)) throw authentication();
  return milliseconds;
}

function reusable(lease: GatewayCredentialLease, now: () => Date): boolean {
  return Date.parse(lease.expires_at) - currentTime(now) >= MINIMUM_VALIDITY_MS;
}

function stateFor(provider: GatewayCredentialProvider): Map<string, CredentialEntry> {
  let state = providerStates.get(provider);
  if (state === undefined) {
    state = new Map();
    providerStates.set(provider, state);
  }
  return state;
}

function startFlight(options: {
  readonly provider: GatewayCredentialProvider;
  readonly reference: SecretReference;
  readonly key: string;
  readonly state: Map<string, CredentialEntry>;
  readonly entry: CredentialEntry;
}): CredentialFlight {
  const controller = new AbortController();
  let rejectCancelled!: (reason: RuntimeProviderError) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  const promise = Promise.resolve()
    .then(() =>
      options.provider.resolve(options.reference, {
        signal: controller.signal,
        minimum_validity_ms: MINIMUM_VALIDITY_MS,
      }),
    )
    .then(normalizeLease)
    .then((lease) => {
      if (options.state.get(options.key) === options.entry && options.entry.inflight === flight) {
        options.entry.lease = lease;
      }
      return lease;
    })
    .catch(() => {
      throw authentication();
    })
    .finally(() => {
      if (options.entry.inflight === flight) delete options.entry.inflight;
      if (options.entry.lease === undefined && options.entry.inflight === undefined) {
        options.state.delete(options.key);
      }
    });
  const flight: CredentialFlight = {
    controller,
    promise,
    cancelled,
    cancel: () => rejectCancelled(authentication()),
    waiters: 0,
  };
  void promise.catch(() => undefined);
  void cancelled.catch(() => undefined);
  return flight;
}

async function awaitFlight(options: {
  readonly flight: CredentialFlight;
  readonly entry: CredentialEntry;
  readonly signal: AbortSignal;
}): Promise<GatewayCredentialLease> {
  if (!(options.signal instanceof AbortSignal) || options.signal.aborted) {
    throw authentication();
  }
  let rejectAborted!: (reason: RuntimeProviderError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => rejectAborted(authentication());
  options.flight.waiters += 1;
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([options.flight.promise, options.flight.cancelled, aborted]);
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    options.flight.waiters -= 1;
    if (
      options.signal.aborted &&
      options.flight.waiters === 0 &&
      options.entry.inflight === options.flight
    ) {
      options.flight.cancel();
      options.flight.controller.abort();
    }
  }
}

export function createGatewayCredentialCoordinator(options: {
  readonly provider: GatewayCredentialProvider;
  readonly now: () => Date;
}): GatewayCredentialCoordinator {
  const state = stateFor(options.provider);
  return Object.freeze({
    async resolve(reference: SecretReference, signal: AbortSignal) {
      if (!(signal instanceof AbortSignal) || signal.aborted) throw authentication();
      const normalized = normalizedReference(reference);
      let entry = state.get(normalized.key);
      if (entry?.lease !== undefined) {
        if (reusable(entry.lease, options.now)) return entry.lease;
        delete entry.lease;
      }
      if (entry === undefined) {
        entry = {};
        state.set(normalized.key, entry);
      }
      const flight =
        entry.inflight ??
        startFlight({
          provider: options.provider,
          reference: normalized.value,
          key: normalized.key,
          state,
          entry,
        });
      entry.inflight = flight;
      const resolved = await awaitFlight({ flight, entry, signal });
      if (!reusable(resolved, options.now)) {
        if (entry.lease === resolved) delete entry.lease;
        if (entry.inflight === undefined) state.delete(normalized.key);
        throw authentication();
      }
      return resolved;
    },
    clear() {
      for (const entry of state.values()) {
        delete entry.lease;
        entry.inflight?.cancel();
        entry.inflight?.controller.abort();
      }
      state.clear();
    },
  });
}
