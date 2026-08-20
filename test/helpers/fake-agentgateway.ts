import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface CapturedGatewayRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: Uint8Array;
}

export interface FakeGatewayResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | readonly (string | Uint8Array)[];
}

export interface FakeAgentgateway {
  readonly endpoint: string;
  readonly requests: readonly CapturedGatewayRequest[];
  setResponse(path: string, response: FakeGatewayResponse): void;
  close(): Promise<void>;
}

async function readRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function sendResponse(response: ServerResponse, fixture: FakeGatewayResponse): void {
  response.writeHead(fixture.status, fixture.headers);
  const chunks = Array.isArray(fixture.body) ? fixture.body : [fixture.body ?? ""];
  for (const chunk of chunks) response.write(chunk);
  response.end();
}

export async function startFakeAgentgateway(): Promise<FakeAgentgateway> {
  const responses = new Map<string, FakeGatewayResponse>();
  const requests: CapturedGatewayRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/";
      requests.push(
        Object.freeze({
          method: request.method ?? "",
          path,
          headers: Object.freeze({ ...request.headers }),
          body: await readRequestBody(request),
        }),
      );
      sendResponse(
        response,
        responses.get(path) ?? {
          status: 404,
          body: "fake agentgateway route missing",
        },
      );
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Fake agentgateway did not publish a TCP address");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/runtime`,
    requests,
    setResponse(path, response) {
      responses.set(path, response);
    },
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}
