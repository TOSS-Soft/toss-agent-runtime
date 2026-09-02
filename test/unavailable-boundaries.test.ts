import { describe, expect, it } from "vitest";

import { requireEvidenceEmitter } from "../src/evidence/index.js";
import { requireAgentLoop } from "../src/orchestration/index.js";
import * as routingApi from "../src/routing/index.js";
import { requireSecurityRuntime } from "../src/security/index.js";
import { createToolBroker } from "../src/tools/index.js";
import {
  createAgentgatewayTransport,
  hashAgentgatewayCapabilities,
  parseAgentgatewayCapabilities,
} from "../src/index.js";
import { UnavailableCapabilityError } from "../src/version.js";

describe("future subsystem boundaries", () => {
  it("treats the authenticated agentgateway transport as delivered", () => {
    expect(createAgentgatewayTransport).toBeTypeOf("function");
    expect(parseAgentgatewayCapabilities).toBeTypeOf("function");
    expect(hashAgentgatewayCapabilities).toBeTypeOf("function");
  });

  it("treats governed model routing as delivered", () => {
    expect(routingApi).not.toHaveProperty("requireModelRouter");
    expect(routingApi).toHaveProperty("planModelSelection", expect.any(Function));
    expect(routingApi).toHaveProperty("verifyResolvedRoute", expect.any(Function));
  });

  it("treats the scoped MCP tool broker as delivered", () => {
    expect(createToolBroker).toBeTypeOf("function");
  });

  it.each([
    ["orchestration", requireAgentLoop],
    ["evidence", requireEvidenceEmitter],
    ["security", requireSecurityRuntime],
  ])("fails closed while %s is unavailable", (capability, requireCapability) => {
    expect(requireCapability).toThrowError(new UnavailableCapabilityError(capability));
  });
});
