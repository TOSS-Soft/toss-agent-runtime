import type { SecretReference } from "../config/types.js";
import { RuntimeProviderError } from "../providers/errors.js";
import { parseAgentgatewayCapabilities, parseAgentgatewayHealth } from "./contracts.js";
import { agentgatewayError, classifyAgentgatewayHttpStatus } from "./errors.js";
import type {
  AgentgatewayCapabilitiesV1,
  AgentgatewayClient,
  AgentgatewayClientHealth,
  AgentgatewayFetch,
  AgentgatewayFetchOptions,
  GatewayCredentialCoordinator,
  SelectedAgentgatewayProfile,
} from "./types.js";

const CAPABILITY_BYTES = 512 * 1024;
const HEALTH_BYTES = 64 * 1024;
const JSON_ACCEPT = "application/json";
const UNAVAILABLE_HEALTH: AgentgatewayClientHealth = Object.freeze({ status: "unavailable" });

function endpointBase(endpoint: string): URL {
  const value = new URL(endpoint);
  if (!value.pathname.endsWith("/")) value.pathname = `${value.pathname}/`;
  return value;
}

function fixedHeaders(token: string): Headers {
  const headers = new Headers();
  headers.set("accept", JSON_ACCEPT);
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The caller receives only a stable gateway error.
  }
}

export async function readBoundedAgentgatewayResponse(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch {
        await cancelReader(reader);
        throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE");
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        await cancelReader(reader);
        throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
      }
      total += result.value.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await cancelReader(reader);
        throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function responseStatus(response: Response): number {
  const status = response.status;
  if (!Number.isSafeInteger(status) || status < 200 || status > 599) {
    throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
  }
  return status;
}

function cancelled(): RuntimeProviderError {
  return agentgatewayError("RUNTIME_PROVIDER_CANCELLED");
}

export function createAgentgatewayClient(options: {
  readonly selectedProfile: SelectedAgentgatewayProfile;
  readonly credentialReference: SecretReference;
  readonly credentials: GatewayCredentialCoordinator;
  readonly fetch: AgentgatewayFetch;
  readonly now: () => Date;
}): AgentgatewayClient {
  const base = endpointBase(options.selectedProfile.profile.endpoint);
  const capabilityUrl = new URL("v1/toss/capabilities", base).href;
  const healthUrl = new URL("healthz", base).href;

  async function authenticatedGet(url: string, signal: AbortSignal): Promise<Response> {
    let token: string;
    try {
      token = (await options.credentials.resolve(options.credentialReference, signal)).token;
    } catch {
      if (signal.aborted) throw cancelled();
      throw agentgatewayError("RUNTIME_PROVIDER_AUTHENTICATION");
    }
    const request: AgentgatewayFetchOptions = {
      method: "GET",
      headers: fixedHeaders(token),
      redirect: "error",
      signal,
    };
    try {
      return await options.fetch(url, request);
    } catch {
      if (signal.aborted) throw cancelled();
      throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE");
    }
  }

  return Object.freeze({
    async discover(signal: AbortSignal): Promise<AgentgatewayCapabilitiesV1> {
      if (signal.aborted) throw cancelled();
      let response: Response;
      try {
        response = await authenticatedGet(capabilityUrl, signal);
        const status = responseStatus(response);
        if (status < 200 || status >= 300) throw classifyAgentgatewayHttpStatus(status);
        const parsed = parseAgentgatewayCapabilities(
          await readBoundedAgentgatewayResponse(response, CAPABILITY_BYTES),
          { now: options.now },
        );
        if (!parsed.ok) throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
        return parsed.value;
      } catch (error) {
        if (signal.aborted) throw cancelled();
        if (error instanceof RuntimeProviderError) throw error;
        throw agentgatewayError("RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE");
      }
    },
    async health(): Promise<AgentgatewayClientHealth> {
      const controller = new AbortController();
      try {
        const response = await authenticatedGet(healthUrl, controller.signal);
        const status = responseStatus(response);
        if (status < 200 || status >= 300) return UNAVAILABLE_HEALTH;
        const parsed = parseAgentgatewayHealth(
          await readBoundedAgentgatewayResponse(response, HEALTH_BYTES),
        );
        return parsed.ok ? parsed.value : UNAVAILABLE_HEALTH;
      } catch {
        return UNAVAILABLE_HEALTH;
      }
    },
  });
}
