import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, PACKAGE_VERSION, PROTOCOL_VERSION } from "../src/index.js";

describe("package metadata", () => {
  it("exports the frozen development identity", () => {
    expect(PACKAGE_NAME).toBe("@toss-software/agent-runtime");
    expect(PACKAGE_VERSION).toBe("0.0.0-development");
    expect(PROTOCOL_VERSION).toBe("runtime-contract.v1");
  });
});
