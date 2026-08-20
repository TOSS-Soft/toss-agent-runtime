import type { AgentgatewayProfileV1 } from "../gateway/types.js";

export type RuntimePlatform = "darwin" | "linux";
export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type RuntimeMode = "development" | "production";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SecretReference {
  readonly source: "env" | "command";
  readonly key: string;
}

export interface RuntimeConfigV1 {
  readonly schema_version: "runtime-config.v1";
  readonly document_type: "runtime-config";
  readonly mode: RuntimeMode;
  readonly paths: Readonly<{ state: string; logs: string; socket: string }>;
  readonly shutdown_timeout_ms: number;
  readonly logs: Readonly<{
    level: LogLevel;
    retention_days: 7;
    max_bytes: 104857600;
  }>;
  readonly gateway_profile: string | null;
  readonly gateway_profiles: Readonly<Record<string, AgentgatewayProfileV1>>;
  readonly provider_profiles: readonly string[];
  readonly mcp_profiles: readonly string[];
  readonly secret_references: Readonly<Record<string, SecretReference>>;
}

export interface LoadedConfig {
  readonly config: RuntimeConfigV1;
  readonly source: string;
}
