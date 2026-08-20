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

export function classifyAgentgatewayResponseStatus(
  status: number,
  errorSource: unknown,
): RuntimeProviderError {
  if (status >= 500 && status <= 599) {
    return errorSource === "provider"
      ? agentgatewayError("RUNTIME_PROVIDER_TRANSIENT")
      : agentgatewayError("RUNTIME_PROVIDER_GATEWAY_UNAVAILABLE");
  }
  return classifyAgentgatewayHttpStatus(status);
}
