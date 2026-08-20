import { RuntimeProviderError, type RuntimeProviderErrorCode } from "../providers/errors.js";

export function agentgatewayError(code: RuntimeProviderErrorCode): RuntimeProviderError {
  return new RuntimeProviderError(code);
}

export function classifyAgentgatewayHttpStatus(status: number): RuntimeProviderError {
  if (status === 401 || status === 403) {
    return agentgatewayError("RUNTIME_PROVIDER_AUTHENTICATION");
  }
  if (status === 404) return agentgatewayError("RUNTIME_PROVIDER_ROUTE_NOT_FOUND");
  if (status === 429) return agentgatewayError("RUNTIME_PROVIDER_RATE_LIMIT");
  if ((status >= 300 && status < 400) || status >= 500) {
    return agentgatewayError("RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE");
  }
  return agentgatewayError("RUNTIME_PROVIDER_GATEWAY_INVALID");
}
