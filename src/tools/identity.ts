import {
  canonicalJson,
  deepFreezeJson,
  parseJsonBytes,
  sha256,
  type JsonValue,
} from "../protocol/json.js";
import { RuntimeToolError } from "./errors.js";
import type { McpProtocolRevision, McpTransportKind } from "./types.js";
import type { ToolServerObservation } from "./transports/types.js";

export interface ToolIdentityInput {
  readonly run_id: string;
  readonly logical_call_id: string;
  readonly mcp_profile_hash: `sha256:${string}`;
  readonly discovery_snapshot_hash: `sha256:${string}`;
  readonly server_id: string;
  readonly tool_alias: string;
  readonly native_tool_name: string;
  readonly logical_arguments: JsonValue;
}

export interface DerivedToolIdentity {
  readonly logical_input_hash: `sha256:${string}`;
  readonly call_id: string;
  readonly idempotency_key: `sha256:${string}`;
}

function resultInvalid(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_RESULT_INVALID");
}

export function captureToolServerObservation(
  value: ToolServerObservation,
  expected: {
    readonly protocol_revision: McpProtocolRevision;
    readonly transport: McpTransportKind;
  },
): ToolServerObservation {
  let captured: ToolServerObservation;
  try {
    captured = deepFreezeJson(
      parseJsonBytes(canonicalJson(value)),
    ) as unknown as ToolServerObservation;
  } catch {
    resultInvalid();
  }
  if (
    Object.keys(captured).sort().join("\u0000") !==
      "identity_hash\u0000name\u0000protocol_revision\u0000transport\u0000version" ||
    typeof captured.name !== "string" ||
    captured.name.length < 1 ||
    Buffer.byteLength(captured.name) > 128 ||
    typeof captured.version !== "string" ||
    captured.version.length < 1 ||
    Buffer.byteLength(captured.version) > 128 ||
    captured.protocol_revision !== expected.protocol_revision ||
    captured.transport !== expected.transport ||
    captured.identity_hash !==
      sha256({
        name: captured.name,
        protocol_revision: captured.protocol_revision,
        version: captured.version,
      })
  ) {
    throw new RuntimeToolError("RUNTIME_TOOL_PROTOCOL_DOWNGRADE");
  }
  return captured;
}

export function sameToolServerObservation(
  left: ToolServerObservation,
  right: ToolServerObservation,
): boolean {
  return (
    left.identity_hash === right.identity_hash &&
    left.protocol_revision === right.protocol_revision &&
    left.transport === right.transport
  );
}

export function deriveToolIdentity(input: ToolIdentityInput): DerivedToolIdentity {
  const logicalInputHash = sha256(input.logical_arguments);
  const identity = {
    run_id: input.run_id,
    logical_call_id: input.logical_call_id,
    mcp_profile_hash: input.mcp_profile_hash,
    discovery_snapshot_hash: input.discovery_snapshot_hash,
    server_id: input.server_id,
    tool_alias: input.tool_alias,
    native_tool_name: input.native_tool_name,
    logical_input_hash: logicalInputHash,
  };
  const callHash = sha256({ kind: "toss-tool-call.v1", ...identity });
  return Object.freeze({
    logical_input_hash: logicalInputHash,
    call_id: `tool-call-${callHash.slice("sha256:".length, "sha256:".length + 32)}`,
    idempotency_key: sha256({ kind: "toss-tool-idempotency.v1", ...identity }),
  });
}
