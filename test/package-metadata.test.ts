import { describe, expect, expectTypeOf, it } from "vitest";

import * as packageApi from "../src/index.js";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  RuntimeProjectError,
  RuntimeProviderError,
  createAnthropicAdapter,
  createGeminiAdapter,
  createOpenAIAdapter,
  parseProviderEvent,
  parseCandidateJobIntent,
  parseProjectRegistryEntry,
  parseProjectWatchManifest,
  type ProjectIntake,
  type ProjectRegistry,
} from "../src/index.js";

describe("package metadata", () => {
  it("exports the frozen development identity", () => {
    expect(PACKAGE_NAME).toBe("@toss-software/agent-runtime");
    expect(PACKAGE_VERSION).toBe("0.0.0-development");
    expect(PROTOCOL_VERSION).toBe("runtime-contract.v1");
  });

  it("exports closed project contracts and safe registry/intake interfaces", () => {
    expect(parseCandidateJobIntent).toBeTypeOf("function");
    expect(parseProjectRegistryEntry).toBeTypeOf("function");
    expect(parseProjectWatchManifest).toBeTypeOf("function");
    expect(new RuntimeProjectError("RUNTIME_PROJECT_INVALID").code).toBe("RUNTIME_PROJECT_INVALID");
    expectTypeOf<ProjectRegistry["register"]>().toBeFunction();
    expectTypeOf<ProjectIntake["record"]>().toBeFunction();

    expect(packageApi).not.toHaveProperty("createProjectRegistry");
    expect(packageApi).not.toHaveProperty("createProjectIntake");
    expect(packageApi).not.toHaveProperty("createProjectWatcher");
  });

  it("exports the normalized provider contract without a native SDK surface", () => {
    expect(parseProviderEvent).toBeTypeOf("function");
    expect(createOpenAIAdapter).toBeTypeOf("function");
    expect(createAnthropicAdapter).toBeTypeOf("function");
    expect(createGeminiAdapter).toBeTypeOf("function");
    expect(new RuntimeProviderError("RUNTIME_PROVIDER_RATE_LIMIT")).toMatchObject({
      category: "rate-limit",
      retryable: true,
    });
    expect(packageApi).not.toHaveProperty("openai");
    expect(packageApi).not.toHaveProperty("anthropic");
    expect(packageApi).not.toHaveProperty("gemini");
  });
});
