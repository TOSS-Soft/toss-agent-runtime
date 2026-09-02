import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import {
  ReadBuffer,
  SdkError,
  SdkErrorCode,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/client";

import type { SecretReference, RuntimeMode } from "../../config/types.js";
import { canonicalJson, deepFreezeJson, parseJsonBytes } from "../../protocol/json.js";
import { RuntimeToolError } from "../errors.js";
import type { McpStdioBinding } from "../types.js";
import { createToolSdkClientFactory } from "./sdk-client.js";
import type {
  ToolSdkClientFactory,
  ToolTransportAdapter,
  ToolTransportConnectRequest,
  ToolTransportConnection,
} from "./types.js";

const STDERR_CAP_BYTES = 8_192;
const MAX_STDIO_FRAME_BYTES = 4 * 1024 * 1024;
const FIXED_ENVIRONMENT_KEYS = new Set([
  "TOSS_MCP_PROTOCOL_REVISION",
  "TOSS_MCP_TRANSPORT",
  "TOSS_RUNTIME_PROTOCOL_VERSION",
]);
const SECRET_NAME = /(?:secret|token|password|credential|api[_-]?key|authorization)/iu;

export interface StdioSecretLease {
  readonly value: string;
  readonly expires_at: string;
}

export interface StdioSecretProvider {
  resolve(
    reference: SecretReference,
    options: {
      readonly signal: AbortSignal;
      readonly minimum_validity_ms: number;
    },
  ): Promise<unknown>;
}

export type StdioLifecycleObservation =
  | Readonly<{
      event: "spawn";
      command: string;
      args_count: number;
      cwd: string;
      environment_keys: readonly string[];
      shell: false;
    }>
  | Readonly<{
      event: "stderr-summary";
      bytes: number;
      truncated: boolean;
      classification: "empty" | "present" | "authentication";
    }>
  | Readonly<{ event: "signal"; signal: "SIGTERM" | "SIGKILL" }>
  | Readonly<{
      event: "exit";
      code: number | null;
      signal: NodeJS.Signals | null;
    }>;

export interface StdioClock {
  now(): Date;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

interface StdioSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
}

export type StdioSpawn = (
  command: string,
  args: readonly string[],
  options: StdioSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface CreateStdioToolTransportOptions {
  readonly binding: McpStdioBinding;
  readonly mode: RuntimeMode;
  readonly secret_references: Readonly<Record<string, SecretReference>>;
  readonly secret_provider: StdioSecretProvider;
  readonly session_lifetime_ms: number;
  readonly graceful_close_ms?: number;
  readonly terminate_ms?: number;
  readonly lease_safety_ms?: number;
  readonly sdk_client_factory?: ToolSdkClientFactory;
  readonly spawn?: StdioSpawn;
  readonly clock?: StdioClock;
  readonly on_lifecycle?: (observation: StdioLifecycleObservation) => void;
}

const defaultClock: StdioClock = Object.freeze({
  now: () => new Date(),
  setTimeout: (callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> =>
    setTimeout(callback, milliseconds),
  clearTimeout: (handle: ReturnType<typeof setTimeout>): void => clearTimeout(handle),
});

const defaultSpawn: StdioSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    shell: options.shell,
    windowsHide: options.windowsHide,
    stdio: [...options.stdio],
  });

function emit(
  observer: CreateStdioToolTransportOptions["on_lifecycle"],
  observation: StdioLifecycleObservation,
): void {
  try {
    observer?.(Object.freeze(observation));
  } catch {
    // Observation is deliberately best-effort and cannot affect transport state.
  }
}

function unrefTimer(handle: ReturnType<typeof setTimeout>): void {
  if (typeof handle === "object" && "unref" in handle) handle.unref();
}

function validDuration(value: number, maximum = 900_000): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function normalizedAbsolute(candidate: string): boolean {
  return (
    path.isAbsolute(candidate) &&
    path.normalize(candidate) === candidate &&
    !/[\u0000-\u001f\u007f]/u.test(candidate)
  );
}

function invalid(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_INVALID");
}

function captureBinding(binding: McpStdioBinding): McpStdioBinding {
  try {
    return deepFreezeJson(parseJsonBytes(canonicalJson(binding))) as unknown as McpStdioBinding;
  } catch {
    invalid();
  }
}

function validateBinding(binding: McpStdioBinding, mode: RuntimeMode): void {
  if (
    binding.transport !== "stdio" ||
    !normalizedAbsolute(binding.command) ||
    !normalizedAbsolute(binding.cwd) ||
    binding.args.length > 128 ||
    binding.args.some(
      (argument) =>
        typeof argument !== "string" ||
        Buffer.byteLength(argument) > 4_096 ||
        /[\u0000-\u001f\u007f]/u.test(argument),
    )
  ) {
    invalid();
  }
  for (const [name, value] of Object.entries(binding.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || FIXED_ENVIRONMENT_KEYS.has(name)) {
      invalid();
    }
    if (value.kind === "literal") {
      if (
        Buffer.byteLength(value.value) > 4_096 ||
        value.value.includes("\u0000") ||
        (mode === "production" && SECRET_NAME.test(name))
      ) {
        invalid();
      }
    }
  }
}

function currentMilliseconds(clock: StdioClock): number {
  let date: Date;
  try {
    date = clock.now();
  } catch {
    invalid();
  }
  const milliseconds = date instanceof Date ? date.getTime() : Number.NaN;
  if (!Number.isFinite(milliseconds)) invalid();
  return milliseconds;
}

function normalizeLease(value: unknown): StdioSecretLease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
  }
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    throw new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).sort().join("\u0000") !== "expires_at\u0000value"
  ) {
    throw new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
    }
  }
  const secret: unknown = descriptors.value?.value;
  const expiresAt: unknown = descriptors.expires_at?.value;
  if (
    typeof secret !== "string" ||
    Buffer.byteLength(secret) < 1 ||
    Buffer.byteLength(secret) > 8_192 ||
    secret.includes("\u0000") ||
    typeof expiresAt !== "string"
  ) {
    throw new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
  }
  const expiresMilliseconds = Date.parse(expiresAt);
  if (
    !Number.isFinite(expiresMilliseconds) ||
    new Date(expiresMilliseconds).toISOString() !== expiresAt
  ) {
    throw new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
  }
  return Object.freeze({ value: secret, expires_at: expiresAt });
}

interface ResolvedEnvironment {
  readonly environment: Readonly<Record<string, string>>;
  readonly secret_values: readonly string[];
  readonly deadline_ms: number;
  readonly secret_bounded: boolean;
}

async function resolveEnvironment(
  options: Readonly<{
    secret_references: Readonly<Record<string, SecretReference>>;
    secret_provider: StdioSecretProvider;
    session_lifetime_ms: number;
  }>,
  binding: McpStdioBinding,
  signal: AbortSignal,
  clock: StdioClock,
  leaseSafetyMs: number,
): Promise<ResolvedEnvironment> {
  if (signal.aborted) throw new RuntimeToolError("RUNTIME_TOOL_CANCELLED");
  const environment: Record<string, string> = {};
  const secrets: string[] = [];
  let shortestExpiry = Number.POSITIVE_INFINITY;
  for (const name of Object.keys(binding.environment).sort()) {
    const configured = binding.environment[name]!;
    if (configured.kind === "literal") {
      environment[name] = configured.value;
      continue;
    }
    const reference = options.secret_references[configured.reference];
    if (reference === undefined) throw new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
    let lease: StdioSecretLease;
    try {
      lease = normalizeLease(
        await options.secret_provider.resolve(reference, {
          signal,
          minimum_validity_ms: leaseSafetyMs + 1,
        }),
      );
    } catch {
      throw new RuntimeToolError(
        signal.aborted ? "RUNTIME_TOOL_CANCELLED" : "RUNTIME_TOOL_AUTHENTICATION",
      );
    }
    environment[name] = lease.value;
    secrets.push(lease.value);
    shortestExpiry = Math.min(shortestExpiry, Date.parse(lease.expires_at));
  }
  const now = currentMilliseconds(clock);
  const leaseLifetime = shortestExpiry - now - leaseSafetyMs;
  if (Number.isFinite(shortestExpiry) && leaseLifetime < 1) {
    throw new RuntimeToolError("RUNTIME_TOOL_AUTHENTICATION");
  }
  environment.TOSS_MCP_TRANSPORT = "stdio";
  environment.TOSS_RUNTIME_PROTOCOL_VERSION = "runtime-contract.v1";
  return Object.freeze({
    environment: Object.freeze(environment),
    secret_values: Object.freeze(secrets),
    deadline_ms: Math.min(now + options.session_lifetime_ms, shortestExpiry - leaseSafetyMs),
    secret_bounded: Number.isFinite(shortestExpiry),
  });
}

class BoundedStderr {
  #buffer = Buffer.alloc(0);
  #bytes = 0;
  #truncated = false;
  #secrets: string[];

  constructor(secrets: readonly string[]) {
    this.#secrets = [...secrets];
  }

  append(chunk: Buffer): void {
    this.#bytes += chunk.byteLength;
    let text = chunk.subarray(Math.max(0, chunk.byteLength - STDERR_CAP_BYTES)).toString("utf8");
    for (const secret of this.#secrets) text = text.replaceAll(secret, "[REDACTED]");
    text = text.replace(
      /\b(?:bearer|token|password|secret|api[_-]?key)\b\s*[:=]\s*\S+/giu,
      "[REDACTED]",
    );
    const redacted = Buffer.from(text, "utf8");
    const combined = Buffer.concat([this.#buffer, redacted]);
    if (combined.byteLength > STDERR_CAP_BYTES) {
      this.#truncated = true;
      this.#buffer = combined.subarray(combined.byteLength - STDERR_CAP_BYTES);
    } else {
      this.#buffer = combined;
    }
    if (this.#bytes > STDERR_CAP_BYTES) this.#truncated = true;
  }

  summary(): Extract<StdioLifecycleObservation, { event: "stderr-summary" }> {
    const text = this.#buffer.toString("utf8");
    const classification =
      this.#bytes === 0
        ? "empty"
        : /\b(?:unauthorized|authentication|forbidden)\b/iu.test(text)
          ? "authentication"
          : "present";
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    this.#secrets.fill("");
    this.#secrets = [];
    return Object.freeze({
      event: "stderr-summary",
      bytes: this.#bytes,
      truncated: this.#truncated,
      classification,
    });
  }
}

class HardenedStdioSdkTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly #command: string;
  readonly #args: readonly string[];
  readonly #cwd: string;
  readonly #spawn: StdioSpawn;
  readonly #clock: StdioClock;
  readonly #gracefulCloseMs: number;
  readonly #terminateMs: number;
  readonly #observer: CreateStdioToolTransportOptions["on_lifecycle"];
  readonly #readBuffer = new ReadBuffer({ maxBufferSize: MAX_STDIO_FRAME_BYTES });
  readonly #stderr: BoundedStderr;
  #environment: Readonly<Record<string, string>> | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #exitPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #stderrSummarized = false;

  constructor(options: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly secrets: readonly string[];
    readonly spawn: StdioSpawn;
    readonly clock: StdioClock;
    readonly graceful_close_ms: number;
    readonly terminate_ms: number;
    readonly observer: CreateStdioToolTransportOptions["on_lifecycle"];
  }) {
    this.#command = options.command;
    this.#args = Object.freeze([...options.args]);
    this.#cwd = options.cwd;
    this.#environment = options.environment;
    this.#spawn = options.spawn;
    this.#clock = options.clock;
    this.#gracefulCloseMs = options.graceful_close_ms;
    this.#terminateMs = options.terminate_ms;
    this.#observer = options.observer;
    this.#stderr = new BoundedStderr(options.secrets);
  }

  async start(): Promise<void> {
    if (this.#child !== undefined || this.#environment === undefined) {
      throw new SdkError(SdkErrorCode.AlreadyConnected, "Transport already started");
    }
    const environment = this.#environment;
    this.#environment = undefined;
    const child = this.#spawn(this.#command, this.#args, {
      cwd: this.#cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    this.#exitPromise = new Promise<void>((resolve) => {
      let settled = false;
      const settle = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        this.#summarizeStderr();
        emit(this.#observer, { event: "exit", code, signal });
        resolve();
        this.onclose?.();
      };
      child.once("exit", settle);
      child.once("error", () => settle(null, null));
    });
    child.stdout.on("data", (chunk: Buffer) => this.#read(chunk));
    child.stdout.on("error", (error) => this.onerror?.(error));
    child.stdin.on("error", (error) => {
      if (this.#closePromise === undefined) this.onerror?.(error);
    });
    child.stderr.on("data", (chunk: Buffer) => this.#stderr.append(chunk));
    child.stderr.on("error", (error) => this.onerror?.(error));

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        emit(this.#observer, {
          event: "spawn",
          command: this.#command,
          args_count: this.#args.length,
          cwd: this.#cwd,
          environment_keys: Object.freeze(Object.keys(environment).sort()),
          shell: false,
        });
        resolve();
      });
      child.once("error", (error) => {
        this.onerror?.(error);
        reject(error);
      });
    });
  }

  #read(chunk: Buffer): void {
    try {
      this.#readBuffer.append(chunk);
      while (true) {
        const message = this.#readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error("Invalid stdio frame"));
      void this.close();
    }
  }

  #running(): boolean {
    return (
      this.#child !== undefined && this.#child.exitCode === null && this.#child.signalCode === null
    );
  }

  #summarizeStderr(): void {
    if (this.#stderrSummarized) return;
    this.#stderrSummarized = true;
    emit(this.#observer, this.#stderr.summary());
  }

  async #wait(milliseconds: number): Promise<boolean> {
    if (!this.#running()) return true;
    const exit = this.#exitPromise;
    if (exit === undefined) return true;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      handle = this.#clock.setTimeout(() => resolve(false), milliseconds);
      unrefTimer(handle);
    });
    const exited = await Promise.race([exit.then(() => true), timeout]);
    if (handle !== undefined) this.#clock.clearTimeout(handle);
    return exited;
  }

  async #closeChild(): Promise<void> {
    const child = this.#child;
    if (child === undefined) {
      this.#summarizeStderr();
      return;
    }
    child.stdin.end();
    if (!(await this.#wait(this.#gracefulCloseMs)) && this.#running()) {
      emit(this.#observer, { event: "signal", signal: "SIGTERM" });
      child.kill("SIGTERM");
    }
    if (!(await this.#wait(this.#terminateMs)) && this.#running()) {
      emit(this.#observer, { event: "signal", signal: "SIGKILL" });
      child.kill("SIGKILL");
    }
    await this.#exitPromise;
    this.#readBuffer.clear();
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#closeChild();
    await this.#closePromise;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.#child;
    if (child === undefined || !this.#running()) {
      throw new SdkError(SdkErrorCode.NotConnected, "Transport is not connected");
    }
    const serialized = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        child.stdin.off("drain", onDrain);
        reject(error);
      };
      const onDrain = () => {
        child.stdin.off("error", onError);
        resolve();
      };
      child.stdin.once("error", onError);
      if (child.stdin.write(serialized)) onDrain();
      else child.stdin.once("drain", onDrain);
    });
  }
}

function validateOptions(options: CreateStdioToolTransportOptions): {
  readonly binding: McpStdioBinding;
  readonly clock: StdioClock;
  readonly spawn: StdioSpawn;
  readonly sdkFactory: ToolSdkClientFactory;
  readonly gracefulCloseMs: number;
  readonly terminateMs: number;
  readonly leaseSafetyMs: number;
  readonly secretReferences: Readonly<Record<string, SecretReference>>;
  readonly secretProvider: StdioSecretProvider;
  readonly sessionLifetimeMs: number;
} {
  const binding = captureBinding(options.binding);
  validateBinding(binding, options.mode);
  const gracefulCloseMs = options.graceful_close_ms ?? 2_000;
  const terminateMs = options.terminate_ms ?? 2_000;
  const leaseSafetyMs = options.lease_safety_ms ?? 1_000;
  if (
    !validDuration(options.session_lifetime_ms) ||
    !validDuration(gracefulCloseMs, 30_000) ||
    !validDuration(terminateMs, 30_000) ||
    !validDuration(leaseSafetyMs, 60_000)
  ) {
    invalid();
  }
  for (const configured of Object.values(binding.environment)) {
    if (
      configured.kind === "secret-reference" &&
      options.secret_references[configured.reference] === undefined
    ) {
      invalid();
    }
  }
  let secretReferences: Readonly<Record<string, SecretReference>>;
  try {
    secretReferences = deepFreezeJson(
      parseJsonBytes(canonicalJson(options.secret_references)),
    ) as unknown as Readonly<Record<string, SecretReference>>;
  } catch {
    invalid();
  }
  return Object.freeze({
    binding,
    clock: options.clock ?? defaultClock,
    spawn: options.spawn ?? defaultSpawn,
    sdkFactory: options.sdk_client_factory ?? createToolSdkClientFactory(),
    gracefulCloseMs,
    terminateMs,
    leaseSafetyMs,
    secretReferences,
    secretProvider: options.secret_provider,
    sessionLifetimeMs: options.session_lifetime_ms,
  });
}

export function createStdioToolTransport(
  options: CreateStdioToolTransportOptions,
): ToolTransportAdapter {
  const validated = validateOptions(options);
  const adapter: ToolTransportAdapter = {
    kind: "stdio",
    async connect(request: ToolTransportConnectRequest): Promise<ToolTransportConnection> {
      const resolved = await resolveEnvironment(
        {
          secret_references: validated.secretReferences,
          secret_provider: validated.secretProvider,
          session_lifetime_ms: validated.sessionLifetimeMs,
        },
        validated.binding,
        request.signal,
        validated.clock,
        validated.leaseSafetyMs,
      );
      const environment = Object.freeze({
        ...resolved.environment,
        TOSS_MCP_PROTOCOL_REVISION: request.protocol_revision,
      });
      const transport = new HardenedStdioSdkTransport({
        command: validated.binding.command,
        args: validated.binding.args,
        cwd: validated.binding.cwd,
        environment,
        secrets: resolved.secret_values,
        spawn: validated.spawn,
        clock: validated.clock,
        graceful_close_ms: validated.gracefulCloseMs,
        terminate_ms: validated.terminateMs,
        observer: options.on_lifecycle,
      });
      let inner: ToolTransportConnection;
      try {
        inner = await validated.sdkFactory.connect({
          ...request,
          transport,
          transport_kind: "stdio",
        });
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw error;
      }
      let expired = false;
      let closed = false;
      let closePromise: Promise<void> | undefined;
      const lifetime = Math.floor(resolved.deadline_ms - currentMilliseconds(validated.clock));
      if (lifetime < 1) {
        await inner.close(new AbortController().signal).catch(() => undefined);
        throw new RuntimeToolError(
          resolved.secret_bounded ? "RUNTIME_TOOL_AUTHENTICATION" : "RUNTIME_TOOL_UNAVAILABLE",
        );
      }
      const timer = validated.clock.setTimeout(() => {
        expired = true;
        closePromise ??= inner.close(new AbortController().signal);
        void closePromise.catch(() => undefined);
      }, lifetime);
      unrefTimer(timer);

      const connection: ToolTransportConnection = {
        server: inner.server,
        async listTools(cursor, signal) {
          if (expired) {
            throw new RuntimeToolError(
              resolved.secret_bounded ? "RUNTIME_TOOL_AUTHENTICATION" : "RUNTIME_TOOL_UNAVAILABLE",
            );
          }
          if (closed) throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
          return await inner.listTools(cursor, signal);
        },
        async callTool(call, signal) {
          if (expired) {
            throw new RuntimeToolError(
              resolved.secret_bounded ? "RUNTIME_TOOL_AUTHENTICATION" : "RUNTIME_TOOL_UNAVAILABLE",
            );
          }
          if (closed) throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
          return await inner.callTool(call, signal);
        },
        async close(signal) {
          validated.clock.clearTimeout(timer);
          closed = true;
          closePromise ??= inner.close(signal);
          await closePromise;
        },
      };
      return Object.freeze(connection);
    },
  };
  return Object.freeze(adapter);
}
