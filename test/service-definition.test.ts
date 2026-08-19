import { describe, expect, it } from "vitest";

import {
  renderLaunchAgent,
  renderServiceDefinition,
  renderSystemdUserUnit,
  type ServiceDefinitionInput,
} from "../src/service/definition.js";
import { resolveServicePaths } from "../src/service/paths.js";

const common = {
  nodePath: "/opt/node/bin/node",
  cliPath: "/opt/toss/bin/toss-runtime.js",
  configPath: "/home/test/.config/toss/runtime/config.yaml",
  environment: { LANG: "en_US.UTF-8" },
} as const;

describe("native service definitions", () => {
  it("renders the complete login-enabled but not immediately-started Linux unit", () => {
    expect(renderServiceDefinition({ ...common, platform: "linux", uid: 501 })).toBe(
      `[Unit]
Description=TOSS Agent Runtime
StartLimitIntervalSec=60s
StartLimitBurst=5

[Service]
Type=simple
ExecStart="/opt/node/bin/node" "/opt/toss/bin/toss-runtime.js" "serve" "--config" "/home/test/.config/toss/runtime/config.yaml"
Restart=on-failure
RestartSec=5s
UMask=0077
Environment="LANG=en_US.UTF-8"

[Install]
WantedBy=default.target
`,
    );
  });

  it("places definitions and manager identities under exact per-user manager paths", () => {
    expect(resolveServicePaths({ platform: "darwin", home: "/Users/test", env: {} })).toEqual({
      definition: "/Users/test/Library/LaunchAgents/software.toss.agent-runtime.plist",
      managerIdentity: "software.toss.agent-runtime",
    });
    expect(resolveServicePaths({ platform: "linux", home: "/home/test", env: {} })).toEqual({
      definition: "/home/test/.config/systemd/user/toss-agent-runtime.service",
      managerIdentity: "toss-agent-runtime.service",
    });
  });

  it("renders XML text structurally while retaining paths with spaces", () => {
    const definition = renderLaunchAgent({
      platform: "darwin",
      uid: 501,
      nodePath: "/Applications/Node & Tools/bin/node",
      cliPath: "/opt/toss/bin/runtime <stable>.js",
      configPath: "/Users/Test User/Library/Application Support/TOSS/runtime/config&prod.yaml",
      environment: { LANG: "C", TZ: "America/Argentina/Buenos_Aires" },
    });

    expect(definition).toContain("<string>/Applications/Node &amp; Tools/bin/node</string>");
    expect(definition).toContain("<string>/opt/toss/bin/runtime &lt;stable&gt;.js</string>");
    expect(definition).toContain(
      "<string>/Users/Test User/Library/Application Support/TOSS/runtime/config&amp;prod.yaml</string>",
    );
    expect(definition).toContain("<key>LANG</key>\n\t\t<string>C</string>");
  });

  it("renders systemd arguments safely for spaces, quotes, backslashes, and percent", () => {
    const definition = renderSystemdUserUnit({
      platform: "linux",
      uid: 501,
      nodePath: "/opt/Node Tools/bin/node",
      cliPath: '/opt/toss/bin/runtime "stable"\\release.js',
      configPath: "/home/test/configs/100% ready.yaml",
      environment: {},
    });

    expect(definition).toContain(
      'ExecStart="/opt/Node Tools/bin/node" "/opt/toss/bin/runtime \\"stable\\"\\\\release.js" "serve" "--config" "/home/test/configs/100%% ready.yaml"',
    );
  });

  it("sorts the only allowed environment keys deterministically in both formats", () => {
    const input = {
      ...common,
      platform: "linux" as const,
      uid: 501,
      environment: { TZ: "UTC", LANG: "POSIX", LC_ALL: "C" },
    };

    const systemd = renderSystemdUserUnit(input);
    const launchd = renderLaunchAgent({ ...input, platform: "darwin" });

    expect(systemd).toContain(
      'Environment="LANG=POSIX"\nEnvironment="LC_ALL=C"\nEnvironment="TZ=UTC"',
    );
    expect(launchd.indexOf("<key>LANG</key>")).toBeLessThan(launchd.indexOf("<key>LC_ALL</key>"));
    expect(launchd.indexOf("<key>LC_ALL</key>")).toBeLessThan(launchd.indexOf("<key>TZ</key>"));
    expect(renderServiceDefinition(input)).toBe(renderServiceDefinition(input));
  });

  it.each([
    ["relative node path", { ...common, nodePath: "bin/node" }],
    ["relative CLI path", { ...common, cliPath: "bin/toss-runtime.js" }],
    ["relative config path", { ...common, configPath: "config.yaml" }],
    ["path with a NUL", { ...common, configPath: "/home/test/config\u0000.yaml" }],
    ["path with a newline", { ...common, configPath: "/home/test/config\n.yaml" }],
  ])("rejects a %s", (_name, input) => {
    expect(() => renderServiceDefinition({ ...input, platform: "linux", uid: 501 })).toThrow();
  });

  it.each([
    ["non-allowlisted key", { ...common, environment: { API_TOKEN: "must-not-persist" } }],
    ["credential-looking key", { ...common, environment: { credential: "must-not-persist" } }],
    ["locale with a slash", { ...common, environment: { LANG: "en_US/UTF-8" } }],
    ["timezone without an IANA area", { ...common, environment: { TZ: "Europe" } }],
    ["environment NUL", { ...common, environment: { LANG: "C\u0000" } }],
    ["environment newline", { ...common, environment: { TZ: "UTC\n" } }],
  ])("rejects %s without emitting its value", (_name, input) => {
    const rejectedValue = Object.values(input.environment)[0] ?? "";
    let error: unknown;
    try {
      renderServiceDefinition({ ...input, platform: "linux", uid: 501 } as ServiceDefinitionInput);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(rejectedValue);
  });

  it("rejects relative homes and unsupported platforms while resolving manager paths", () => {
    expect(() => resolveServicePaths({ platform: "linux", home: "home/test", env: {} })).toThrow();
    expect(() =>
      resolveServicePaths({ platform: "windows" as "linux", home: "/home/test", env: {} }),
    ).toThrow();
  });
});
