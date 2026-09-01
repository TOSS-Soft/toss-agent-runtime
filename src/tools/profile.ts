import type { McpProfileReference } from "../agents/types.js";
import type { RuntimeConfigV1 } from "../config/types.js";
import { canonicalJson, deepFreezeJson, parseJsonBytes } from "../protocol/json.js";
import { parseMcpProfile } from "./contracts.js";
import { RuntimeToolError } from "./errors.js";
import type { McpProfileV1, McpServerBinding, McpTransportKind } from "./types.js";

export interface RegisteredMcpProfile {
  readonly reference: McpProfileReference;
  readonly profile: McpProfileV1;
  readonly bindings: Readonly<Record<string, McpServerBinding>>;
  readonly transports: readonly McpTransportKind[];
}

export interface McpProfileRegistry {
  list(): readonly RegisteredMcpProfile[];
  resolve(reference: McpProfileReference): RegisteredMcpProfile;
}

function invalid(): never {
  throw new RuntimeToolError("RUNTIME_TOOL_INVALID");
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function exactReference(left: McpProfileReference, right: McpProfileReference): boolean {
  return (
    left.document_type === right.document_type &&
    left.artifact_id === right.artifact_id &&
    left.revision === right.revision &&
    left.hash === right.hash
  );
}

function copyBindings(
  bindings: Readonly<Record<string, McpServerBinding>>,
): Readonly<Record<string, McpServerBinding>> {
  return deepFreezeJson(parseJsonBytes(canonicalJson(bindings))) as unknown as Readonly<
    Record<string, McpServerBinding>
  >;
}

function registerProfile(
  name: string,
  configured: RuntimeConfigV1["mcp_profiles"][string],
): RegisteredMcpProfile {
  const parsed = parseMcpProfile(canonicalJson(configured.profile));
  if (!parsed.ok || parsed.value.profile_id !== name) invalid();
  const expectedBindings = parsed.value.servers
    .map((server) => server.binding_name)
    .sort(bytewiseCompare);
  const actualBindings = Object.keys(configured.servers);
  if (
    actualBindings.length !== expectedBindings.length ||
    actualBindings.some((binding, index) => binding !== expectedBindings[index])
  ) {
    invalid();
  }
  for (const server of parsed.value.servers) {
    const binding = configured.servers[server.binding_name];
    if (binding === undefined) invalid();
    if (
      Object.keys(server.x_mcp_headers).length > 0 &&
      binding.transport !== "streamable-http" &&
      binding.transport !== "agentgateway"
    ) {
      invalid();
    }
  }

  const reference: McpProfileReference = Object.freeze({
    document_type: "mcp-profile",
    artifact_id: parsed.value.profile_id,
    revision: parsed.value.revision,
    hash: parsed.value.document_hash,
  });
  const transports = Object.freeze(
    [...new Set(Object.values(configured.servers).map((binding) => binding.transport))].sort(
      bytewiseCompare,
    ),
  );
  return Object.freeze({
    reference,
    profile: parsed.value,
    bindings: copyBindings(configured.servers),
    transports,
  });
}

export function createMcpProfileRegistry(config: RuntimeConfigV1): McpProfileRegistry {
  const names = Object.keys(config.mcp_profiles);
  if (!names.every((name, index) => index === 0 || bytewiseCompare(names[index - 1]!, name) < 0)) {
    invalid();
  }
  const profiles = Object.freeze(
    names.map((name) => registerProfile(name, config.mcp_profiles[name]!)),
  );

  return Object.freeze({
    list(): readonly RegisteredMcpProfile[] {
      return profiles;
    },
    resolve(reference: McpProfileReference): RegisteredMcpProfile {
      const profile = profiles.find((candidate) => exactReference(candidate.reference, reference));
      if (profile === undefined) throw new RuntimeToolError("RUNTIME_TOOL_UNAVAILABLE");
      return profile;
    },
  });
}
