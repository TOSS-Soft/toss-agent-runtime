import type { RuntimeDocument } from "../protocol/types.js";

export type OperationalLogLevel = "debug" | "info" | "warn" | "error";
export type OperationalMetadataValue = string | number | boolean | null;
export type OperationalMetadata = Readonly<Record<string, OperationalMetadataValue>>;

export interface OperationalEventV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "operational-event.v1";
  readonly document_type: "operational-event";
  readonly event_id: string;
  readonly timestamp: string;
  readonly service_instance_id: string;
  readonly service_sequence: number;
  readonly level: OperationalLogLevel;
  readonly component: string;
  readonly event: string;
  readonly correlation_id: string;
  readonly project_id?: string;
  readonly job_id?: string;
  readonly run_id?: string;
  readonly metadata: OperationalMetadata;
}

export interface SensitiveOperationalValue {
  readonly sensitivity: "secret";
  readonly value: unknown;
}

export type OperationalMetadataInput = Readonly<Record<string, unknown>>;

export interface OperationalEventInput {
  readonly level: OperationalLogLevel;
  readonly component: string;
  readonly event: string;
  readonly correlationId: string;
  readonly projectId?: string;
  readonly jobId?: string;
  readonly runId?: string;
  readonly metadata?: OperationalMetadataInput;
  readonly allowedMetadataKeys?: readonly string[];
}
