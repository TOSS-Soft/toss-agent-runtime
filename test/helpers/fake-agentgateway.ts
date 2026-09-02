import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import { hashProviderRouteRequirement } from "../../src/gateway/attestation.js";
import type { AgentgatewayCapabilitiesV1 } from "../../src/gateway/types.js";
import { canonicalJson } from "../../src/protocol/json.js";
import type { ProviderRouteRequirement } from "../../src/providers/types.js";

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

export interface FakeResolvedRouteConfiguration {
  readonly capability: AgentgatewayCapabilitiesV1;
  readonly requirement: ProviderRouteRequirement;
  readonly route_id: string;
  readonly body: string | Uint8Array | readonly (string | Uint8Array)[];
  readonly attestation?: Readonly<
    Partial<{
      route_id: string;
      resolved_provider: string;
      resolved_model: string;
      gateway_revision: string;
      capability_document_hash: string;
      requirement_hash: string;
      gateway_request_id: string;
    }>
  >;
}

export interface FakeMcpRouteConfiguration {
  readonly server_id: string;
  readonly protocol_revision: "2025-06-18" | "2026-07-28";
  readonly capabilities?: string;
  readonly respond: (request: CapturedGatewayRequest) => FakeGatewayResponse;
}

export interface FakeAgentgateway {
  readonly endpoint: string;
  readonly requests: readonly CapturedGatewayRequest[];
  setResponse(path: string, response: FakeGatewayResponse): void;
  configureResolvedRoute(configuration: FakeResolvedRouteConfiguration): void;
  configureMcpRoute(configuration: FakeMcpRouteConfiguration): void;
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

function singleHeader(request: CapturedGatewayRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string") {
    throw new Error(`Fake agentgateway request is missing ${name}`);
  }
  return value;
}

export async function startFakeAgentgateway(): Promise<FakeAgentgateway> {
  const responses = new Map<string, FakeGatewayResponse>();
  const mcpRoutes = new Map<string, FakeMcpRouteConfiguration>();
  const requests: CapturedGatewayRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/";
      const captured = Object.freeze({
        method: request.method ?? "",
        path,
        headers: Object.freeze({ ...request.headers }),
        body: await readRequestBody(request),
      });
      requests.push(captured);
      const mcpRoute = mcpRoutes.get(path);
      const configured = mcpRoute?.respond(captured);
      const fixture =
        mcpRoute === undefined || configured === undefined
          ? responses.get(path)
          : {
              ...configured,
              headers: {
                "x-toss-mcp-scope-sha256": singleHeader(captured, "x-toss-mcp-scope-sha256"),
                "x-toss-mcp-profile-sha256": singleHeader(captured, "x-toss-mcp-profile-sha256"),
                "x-toss-mcp-server-id": mcpRoute.server_id,
                "x-toss-mcp-protocol-version": mcpRoute.protocol_revision,
                "x-toss-mcp-capabilities": mcpRoute.capabilities ?? "tools",
                "x-toss-gateway-request-id": "gateway-mcp-request-1",
                ...configured.headers,
              },
            };
      sendResponse(
        response,
        fixture ?? {
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
    configureResolvedRoute(configuration) {
      const route = configuration.capability.routes.find(
        (candidate) => candidate.route_id === configuration.route_id,
      );
      if (route === undefined || route.alias !== configuration.requirement.alias) {
        throw new Error("Fake agentgateway route configuration is invalid");
      }
      const attestation = configuration.attestation ?? {};
      responses.set("/runtime/v1/toss/capabilities", {
        status: 200,
        headers: { "content-type": "application/json" },
        body: canonicalJson(configuration.capability),
      });
      responses.set("/runtime/v1/responses", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-toss-route-id": attestation.route_id ?? route.route_id,
          "x-toss-resolved-provider": attestation.resolved_provider ?? route.provider,
          "x-toss-resolved-model": attestation.resolved_model ?? route.model,
          "x-toss-capability-revision":
            attestation.gateway_revision ?? String(configuration.capability.gateway.revision),
          "x-toss-capability-document-sha256":
            attestation.capability_document_hash ?? configuration.capability.document_hash,
          "x-toss-requirement-sha256":
            attestation.requirement_hash ?? hashProviderRouteRequirement(configuration.requirement),
          "x-toss-gateway-request-id":
            attestation.gateway_request_id ?? "gateway-loopback-request-1",
        },
        body: configuration.body,
      });
    },
    configureMcpRoute(configuration) {
      mcpRoutes.set(`/v1/toss/mcp/${encodeURIComponent(configuration.server_id)}`, configuration);
    },
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}
