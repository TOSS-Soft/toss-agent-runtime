import {
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeToolError } from "../src/tools/errors.js";
import {
  classifyMcpSdkError,
  createToolSdkClientFactory,
} from "../src/tools/transports/sdk-client.js";
import type { McpProtocolRevision } from "../src/tools/types.js";
import {
  fakeMcpClientFactoryCapture,
  startOfficialMcpServer,
} from "./helpers/fake-mcp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

function connectRequest(protocol_revision: McpProtocolRevision = "2025-06-18") {
  return {
    transport: Object.freeze({ fixture: true }),
    transport_kind: "stdio" as const,
    protocol_revision,
    timeout_ms: 1_000,
    signal: new AbortController().signal,
    on_tools_changed: () => undefined,
  };
}

describe("private MCP SDK client boundary", () => {
  it("uses the official server, preserves pages and trusted metadata, and closes", async () => {
    const fixture = await startOfficialMcpServer();
    cleanups.push(async () => fixture.close());
    let changed = 0;
    const connection = await createToolSdkClientFactory().connect({
      ...connectRequest(),
      transport: fixture.clientTransport,
      on_tools_changed: () => {
        changed += 1;
      },
    });

    expect(connection.server).toMatchObject({
      name: "official-fixture",
      version: "2.0.0",
      protocol_revision: "2025-06-18",
      transport: "stdio",
    });
    const first = await connection.listTools(null, new AbortController().signal);
    expect(first.next_cursor).toBe(fixture.firstCursor);
    expect(first.tools).toHaveLength(1);
    expect(first.tools[0]).toMatchObject({
      name: "repo.search",
      annotations: { read_only_hint: true },
    });
    const second = await connection.listTools(
      first.next_cursor,
      new AbortController().signal,
    );
    expect(second.next_cursor).toBeNull();
    expect(second.tools.map((tool) => tool.name)).toEqual(["repo.get"]);

    const trustedMeta = { toss: { call_id: "call-1" } } as const;
    await expect(
      connection.callTool(
        { name: "repo.search", arguments: { query: "runtime" }, trusted_meta: trustedMeta },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      is_error: false,
      content: [{ type: "text", text: "official result" }],
      structured_content: { count: 1 },
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.params?._meta).toEqual(trustedMeta);

    await fixture.server.sendToolListChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(changed).toBe(1);

    await connection.close(new AbortController().signal);
  });

  it.each([
    ["2025-06-18", "legacy"],
    ["2026-07-28", { pin: "2026-07-28" }],
  ] as const)("pins %s without fallback", async (revision, negotiation) => {
    const capture = fakeMcpClientFactoryCapture();
    const factory = createToolSdkClientFactory({ createClient: capture.createClient });
    const pending = factory.connect(connectRequest(revision));
    capture.clients[0]!.negotiatedProtocolVersion = revision;
    await pending;

    expect(capture.clients[0]!.options).toMatchObject({
      accepts_server_requests: false,
      auto_fulfill: false,
      client_capabilities: {},
      supported_protocol_versions: [revision],
      version_negotiation: negotiation,
    });
    expect(capture.clients[0]!.options.on_tools_changed).toBeTypeOf("function");
  });

  it("rejects a negotiated revision mismatch and closes the native client", async () => {
    const capture = fakeMcpClientFactoryCapture();
    const factory = createToolSdkClientFactory({ createClient: capture.createClient });
    const pending = factory.connect(connectRequest("2026-07-28"));
    capture.clients[0]!.negotiatedProtocolVersion = "2025-06-18";

    await expect(pending).rejects.toMatchObject({ code: "RUNTIME_TOOL_PROTOCOL_DOWNGRADE" });
    expect(capture.clients[0]!.closeCount).toBe(1);
  });

  it("refuses non-tool server capabilities", async () => {
    const capture = fakeMcpClientFactoryCapture();
    const factory = createToolSdkClientFactory({ createClient: capture.createClient });
    const pending = factory.connect(connectRequest());
    capture.clients[0]!.serverCapabilities = { prompts: {} };

    await expect(pending).rejects.toMatchObject({ code: "RUNTIME_TOOL_UNSUPPORTED" });
    expect(capture.clients[0]!.closeCount).toBe(1);
  });

  it("rejects caller-supplied request metadata and sends an accepted call only once", async () => {
    const capture = fakeMcpClientFactoryCapture();
    const factory = createToolSdkClientFactory({ createClient: capture.createClient });
    const pending = factory.connect(connectRequest());
    const client = capture.clients[0]!;
    const connection = await pending;

    await expect(
      connection.callTool(
        {
          name: "repo.search",
          arguments: {},
          trusted_meta: null,
          _meta: { attacker: true },
        } as never,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_INVALID" });

    client.callError = new Error("native secret must not escape");
    await expect(
      connection.callTool(
        { name: "repo.search", arguments: {}, trusted_meta: null },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_INTERNAL" });
    expect(client.callRequests).toHaveLength(1);
  });

  it("propagates cancellation through listing and close", async () => {
    const capture = fakeMcpClientFactoryCapture();
    const factory = createToolSdkClientFactory({ createClient: capture.createClient });
    const pending = factory.connect(connectRequest());
    const client = capture.clients[0]!;
    const connection = await pending;
    client.listError = new DOMException("native abort detail", "AbortError");

    await expect(
      connection.listTools(null, new AbortController().signal),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_CANCELLED" });
    const controller = new AbortController();
    controller.abort();
    await expect(connection.close(controller.signal)).rejects.toMatchObject({
      code: "RUNTIME_TOOL_CANCELLED",
    });
  });

  it("rejects malformed or oversized native pages before exposing them", async () => {
    const capture = fakeMcpClientFactoryCapture();
    const factory = createToolSdkClientFactory({ createClient: capture.createClient });
    const pending = factory.connect(connectRequest());
    const client = capture.clients[0]!;
    const connection = await pending;

    client.listResult = { tools: [{ name: "bad", inputSchema: null }] };
    await expect(
      connection.listTools(null, new AbortController().signal),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_RESULT_INVALID" });

    client.listResult = { tools: [], nextCursor: "x".repeat(4_097) };
    await expect(
      connection.listTools(null, new AbortController().signal),
    ).rejects.toMatchObject({ code: "RUNTIME_TOOL_RESULT_INVALID" });
  });

  it.each([
    [new SdkError(SdkErrorCode.RequestTimeout, "native timeout secret"), "RUNTIME_TOOL_TIMEOUT"],
    [
      new SdkHttpError(SdkErrorCode.SendFailed, "native rate secret", { status: 429 }),
      "RUNTIME_TOOL_RATE_LIMIT",
    ],
    [new UnauthorizedError("native auth secret"), "RUNTIME_TOOL_AUTHENTICATION"],
    [new DOMException("native abort secret", "AbortError"), "RUNTIME_TOOL_CANCELLED"],
    [new Error("native internal secret"), "RUNTIME_TOOL_INTERNAL"],
  ])("classifies native errors without leaking text", (nativeError, code) => {
    const classified = classifyMcpSdkError(nativeError);
    expect(classified).toBeInstanceOf(RuntimeToolError);
    expect(classified.code).toBe(code);
    expect(classified.message).not.toContain("secret");
  });
});
