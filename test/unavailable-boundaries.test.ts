import { describe, expect, it } from "vitest";

import { requireAgentRegistry } from "../src/agents/index.js";
import { requireEvidenceEmitter } from "../src/evidence/index.js";
import { requireAgentLoop } from "../src/orchestration/index.js";
import { requireProviderRuntime } from "../src/providers/index.js";
import { requireModelRouter } from "../src/routing/index.js";
import { requireSecurityRuntime } from "../src/security/index.js";
import { requireSkillsHost } from "../src/skills/index.js";
import { requireToolBroker } from "../src/tools/index.js";
import { UnavailableCapabilityError } from "../src/version.js";

describe("future subsystem boundaries", () => {
  it.each([
    ["providers", requireProviderRuntime],
    ["routing", requireModelRouter],
    ["agents", requireAgentRegistry],
    ["skills", requireSkillsHost],
    ["tools", requireToolBroker],
    ["orchestration", requireAgentLoop],
    ["evidence", requireEvidenceEmitter],
    ["security", requireSecurityRuntime],
  ])("fails closed while %s is unavailable", (capability, requireCapability) => {
    expect(requireCapability).toThrowError(new UnavailableCapabilityError(capability));
  });
});
