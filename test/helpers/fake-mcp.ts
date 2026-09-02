import { InMemoryTransport, Server } from "@modelcontextprotocol/server";

import type {
  ToolSdkClientCreateOptions,
  ToolSdkClientPort,
  ToolSdkRequestOptions,
} from "../../src/tools/transports/types.js";

export class FakeMcpSdkClient implements ToolSdkClientPort {
  readonly connectedTransports: unknown[] = [];
  readonly listCursors: Array<string | null> = [];
  readonly callRequests: unknown[] = [];
  closeCount = 0;
  negotiatedProtocolVersion = "2025-06-18";
  serverVersion: unknown = { name: "fake-mcp", version: "1.0.0" };
  serverCapabilities: unknown = { tools: { listChanged: true } };
  listResult: unknown = { tools: [] };
  callResult: unknown = { content: [{ type: "text", text: "ok" }] };
  listError: Error | undefined;
  callError: Error | undefined;
  connectError: Error | undefined;

  constructor(readonly options: ToolSdkClientCreateOptions) {}

  connect(transport: unknown, options: ToolSdkRequestOptions): Promise<void> {
    void options;
    this.connectedTransports.push(transport);
    if (this.connectError !== undefined) return Promise.reject(this.connectError);
    return Promise.resolve();
  }

  getNegotiatedProtocolVersion(): string | undefined {
    return this.negotiatedProtocolVersion;
  }

  getServerVersion(): unknown {
    return this.serverVersion;
  }

  getServerCapabilities(): unknown {
    return this.serverCapabilities;
  }

  listToolsPage(cursor: string | null, options: ToolSdkRequestOptions): Promise<unknown> {
    void options;
    this.listCursors.push(cursor);
    if (this.listError !== undefined) return Promise.reject(this.listError);
    return Promise.resolve(this.listResult);
  }

  callTool(request: unknown, options: ToolSdkRequestOptions): Promise<unknown> {
    void options;
    this.callRequests.push(request);
    if (this.callError !== undefined) return Promise.reject(this.callError);
    return Promise.resolve(this.callResult);
  }

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }
}

export function fakeMcpClientFactoryCapture() {
  const clients: FakeMcpSdkClient[] = [];
  return {
    clients,
    createClient: (options: ToolSdkClientCreateOptions): ToolSdkClientPort => {
      const client = new FakeMcpSdkClient(options);
      clients.push(client);
      return client;
    },
  };
}

export async function startOfficialMcpServer() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const calls: Array<Readonly<{ params?: Readonly<{ _meta?: unknown }> }>> = [];
  const firstCursor = "cursor:/next?scope=all&mark=✓";
  const inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: { query: { type: "string" } },
  } as const;
  const server = new Server(
    { name: "official-fixture", version: "2.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler("tools/list", (request) => {
    if (request.params?.cursor === firstCursor) {
      return {
        tools: [{ name: "repo.get", inputSchema }],
      };
    }
    return {
      tools: [
        {
          name: "repo.search",
          description: "Search repositories",
          inputSchema,
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ],
      nextCursor: firstCursor,
    };
  });
  server.setRequestHandler("tools/call", (request) => {
    calls.push(request);
    return Promise.resolve({
      content: [{ type: "text", text: "official result" }],
      structuredContent: { count: 1 },
      isError: false,
    });
  });
  await server.connect(serverTransport);

  return {
    calls,
    clientTransport,
    firstCursor,
    server,
    async close(): Promise<void> {
      await server.close().catch(() => undefined);
    },
  };
}
