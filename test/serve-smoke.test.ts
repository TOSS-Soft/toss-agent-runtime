import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/main.js";
import { defaultConfig } from "../src/config/load.js";
import { runService } from "../src/service/lifecycle.js";
import { FakeSignals } from "./support/fake-signals.js";

describe("serve command lifecycle integration", () => {
  it("returns one successful terminal JSON result after graceful shutdown", async () => {
    const signals = new FakeSignals();
    const running = runCli(["serve", "--json"], {
      platform: { os: "linux", arch: "x64", node: "22.23.1" },
      loadConfig: () =>
        Promise.resolve({ config: defaultConfig("linux", "/home/test"), source: "defaults" }),
      serve: () =>
        runService({
          signals,
          stopAccepting: () => undefined,
          drain: () => Promise.resolve(),
          shutdownTimeoutMs: 1000,
        }),
    });
    signals.emit("SIGTERM");

    const output = await running;
    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({ command: "serve", ok: true, exit_code: 0 });
  });
});
