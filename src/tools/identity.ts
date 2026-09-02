import { canonicalJson, deepFreezeJson, parseJsonBytes, sha256 } from "../protocol/json.js";
import { RuntimeToolError } from "./errors.js";
import type { McpProtocolRevision, McpTransportKind } from "./types.js";
import type { ToolServerObservation } from "./transports/types.js";

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
