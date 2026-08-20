import type { RuntimeDocument, ValidationResult } from "../protocol/types.js";
import type { SecretReference } from "../config/types.js";
import type { ProviderAdapterCapabilities, ProviderKind } from "../providers/types.js";

export type AgentgatewayBodyObservability = "off" | "redacted-metadata";

export interface AgentgatewayProfileV1 {
  readonly protocol: "toss-agentgateway.v1";
  readonly endpoint: string;
  readonly credential_reference: string;
  readonly body_observability: AgentgatewayBodyObservability;
}

export interface AgentgatewayRouteV1 {
  readonly alias: string;
  readonly route_id: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly capabilities: ProviderAdapterCapabilities;
}

export interface AgentgatewayCapabilitiesV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "agentgateway-capabilities.v1";
  readonly document_type: "agentgateway-capabilities";
  readonly gateway: Readonly<{
    name: string;
    version: string;
    revision: number;
  }>;
  readonly generated_at: string;
  readonly expires_at: string;
  readonly routes: readonly AgentgatewayRouteV1[];
  readonly document_hash: `sha256:${string}`;
}

export interface AgentgatewayHealth {
  readonly status: "healthy" | "degraded" | "unavailable";
  readonly revision: number;
}

export interface SelectedAgentgatewayProfile {
  readonly name: string;
  readonly profile: AgentgatewayProfileV1;
}

export interface GatewayCredentialLease {
  readonly scheme: "Bearer";
  readonly token: string;
  readonly expires_at: string;
}

export interface GatewayCredentialProvider {
  resolve(
    reference: SecretReference,
    options: {
      readonly signal: AbortSignal;
      readonly minimum_validity_ms: 30_000;
    },
  ): Promise<unknown>;
}

export interface GatewayCredentialCoordinator {
  resolve(reference: SecretReference, signal: AbortSignal): Promise<GatewayCredentialLease>;
  clear(): void;
}

export interface AgentgatewayFetchOptions {
  readonly method: "GET" | "POST";
  readonly headers: Headers;
  readonly redirect: "error";
  readonly signal: AbortSignal;
  readonly body?: string;
}

export type AgentgatewayFetch = (
  input: string,
  options: AgentgatewayFetchOptions,
) => Promise<Response>;

export type AgentgatewayClientHealth = AgentgatewayHealth | Readonly<{ status: "unavailable" }>;

export interface AgentgatewayClient {
  discover(signal: AbortSignal): Promise<AgentgatewayCapabilitiesV1>;
  health(): Promise<AgentgatewayClientHealth>;
}

export type GatewayObservationStatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "network";

export interface GatewayObservation {
  readonly run_id: string;
  readonly request_id: string;
  readonly route_id: string | null;
  readonly streaming: boolean;
  readonly request_bytes: number;
  readonly response_bytes: number;
  readonly message_count: number;
  readonly content_block_count: number;
  readonly tool_count: number;
  readonly status_class: GatewayObservationStatusClass;
  readonly duration_ms: number;
}

export interface CreateAgentgatewayTransportOptions {
  readonly selectedProfile: SelectedAgentgatewayProfile;
  readonly credentialReference: SecretReference;
  readonly credentialProvider: GatewayCredentialProvider;
  readonly fetch: AgentgatewayFetch;
  readonly now: () => Date;
  readonly monotonicNow: () => number;
  readonly onObservation?: (observation: GatewayObservation) => void;
}

export interface ParseAgentgatewayCapabilitiesOptions {
  readonly now: () => Date;
}

export type AgentgatewayCapabilitiesValidationResult = ValidationResult<AgentgatewayCapabilitiesV1>;
export type AgentgatewayHealthValidationResult = ValidationResult<AgentgatewayHealth>;
