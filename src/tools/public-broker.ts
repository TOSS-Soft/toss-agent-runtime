import type { EffectiveAgentAuthority } from "../agents/authority.js";
import type { McpProfileReference } from "../agents/types.js";
import type { RuntimeConfigV1 } from "../config/types.js";
import type { RunJournalStore } from "../journal/store.js";
import type { JournalHead } from "../journal/types.js";
import type { RuntimeCapabilitiesV1 } from "../protocol/capabilities.js";
import type { JsonValue } from "../protocol/json.js";
import type { RuntimeError, TraceContext } from "../protocol/types.js";
import { createToolBroker as createInternalToolBroker } from "./broker.js";
import type { ToolDiscoverySnapshotStore } from "./discovery.js";
import type { ToolTransportAdapter } from "./transports/types.js";
import type {
  McpProfileV1,
  McpServerBinding,
  ToolApprovalV1,
  ToolCallV1,
  ToolResultV1,
  ToolUncertainDisposition,
} from "./types.js";

export interface ToolSessionHandle {
  readonly run_id: string;
  readonly session_id: string;
  readonly profile: McpProfileReference;
  readonly expires_at: string;
}

export interface OpenToolSessionRequest {
  readonly run_id: string;
  readonly execution_request_hash: `sha256:${string}`;
  readonly authority: EffectiveAgentAuthority;
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
}

export interface DiscoverToolsRequest {
  readonly run_id: string;
  readonly session_id: string;
  readonly signal: AbortSignal;
}

export interface DiscoveredToolView {
  readonly session_id: string;
  readonly snapshot_hash: `sha256:${string}`;
  readonly tools: readonly Readonly<{
    readonly name: string;
    readonly description: string;
    readonly input_schema: JsonValue;
  }>[];
}

export interface InvokeToolRequest {
  readonly run_id: string;
  readonly session_id: string;
  readonly expected_journal_head: JournalHead;
  readonly alias: string;
  readonly arguments: JsonValue;
  readonly logical_call_id: string;
  readonly operation_id: string;
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
}

export interface ResumeToolApprovalRequest {
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly call_id: string;
  readonly approval_request_hash: `sha256:${string}`;
  readonly operation_id: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
}

export interface DisposeUncertainToolRequest {
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly call_id: string;
  readonly idempotency_key: `sha256:${string}`;
  readonly operation_id: string;
  readonly disposition: ToolUncertainDisposition;
  readonly trace: TraceContext;
}

export type ToolInvocationOutcome =
  | Readonly<{
      readonly state: "RUNNING";
      readonly call: ToolCallV1;
      readonly result: ToolResultV1;
      readonly journal_head: JournalHead;
      readonly replayed: boolean;
      readonly approval?: ToolApprovalV1;
    }>
  | Readonly<{
      readonly state: "APPROVAL_PENDING";
      readonly call: ToolCallV1;
      readonly approval: ToolApprovalV1;
      readonly journal_head: JournalHead;
      readonly replayed: boolean;
    }>
  | Readonly<{
      readonly state: "FAILED" | "BLOCKED";
      readonly call: ToolCallV1;
      readonly error: RuntimeError;
      readonly journal_head: JournalHead;
      readonly replayed: boolean;
      readonly approval?: ToolApprovalV1;
    }>;

export interface ToolDispositionOutcome {
  readonly state: "RUNNING" | "BLOCKED";
  readonly journal_head: JournalHead;
  readonly run_id: string;
  readonly call_id: string;
  readonly idempotency_key: `sha256:${string}`;
  readonly disposition: ToolUncertainDisposition;
  readonly operation_hash: `sha256:${string}`;
  readonly replayed: boolean;
  readonly call: ToolCallV1;
}

export interface ToolProfileHealth {
  readonly profile: McpProfileReference;
  readonly status: "ready" | "blocked" | "unavailable";
  readonly findings: readonly RuntimeError[];
}

export interface ToolBrokerAdapterContext {
  readonly run_id: string;
  readonly execution_request_hash: `sha256:${string}`;
  readonly authority: EffectiveAgentAuthority;
  readonly trace: TraceContext;
  readonly profile: McpProfileV1;
  readonly bindings: Readonly<Record<string, McpServerBinding>>;
}

export interface CreateToolBrokerOptions {
  readonly config: RuntimeConfigV1;
  readonly journal_store: RunJournalStore;
  readonly state_path: string;
  readonly platform: Readonly<{
    readonly os: "darwin" | "linux";
    readonly arch: string;
    readonly node: string;
  }>;
  readonly now?: () => Date;
  readonly create_session_id?: () => string;
  readonly create_adapters?: (
    context: ToolBrokerAdapterContext,
  ) => Readonly<Record<string, ToolTransportAdapter>>;
  readonly snapshot_store?: ToolDiscoverySnapshotStore;
  readonly is_process_alive?: (pid: number) => "alive" | "dead" | "unknown";
  readonly has_service_listener?: () => Promise<"present" | "absent" | "unknown">;
}

export interface ToolBroker {
  recover(): Promise<void>;
  openSession(request: OpenToolSessionRequest): Promise<ToolSessionHandle>;
  discover(request: DiscoverToolsRequest): Promise<DiscoveredToolView>;
  invoke(request: InvokeToolRequest): Promise<ToolInvocationOutcome>;
  resumeApproval(request: ResumeToolApprovalRequest): Promise<ToolInvocationOutcome>;
  disposeUncertain(request: DisposeUncertainToolRequest): Promise<ToolDispositionOutcome>;
  result(runId: string, callId: string): Promise<ToolResultV1 | null>;
  trace(runId: string, callId: string): Promise<ToolCallV1 | null>;
  capabilities(): RuntimeCapabilitiesV1;
  health(): readonly ToolProfileHealth[];
  closeSession(runId: string): Promise<void>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}

export function createToolBroker(options: CreateToolBrokerOptions): ToolBroker {
  return createInternalToolBroker(options);
}
