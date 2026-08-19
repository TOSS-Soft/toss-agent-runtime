import path from "node:path";

import { SERVICE_LABEL } from "./paths.js";

type ServiceEnvironmentKey = "LANG" | "LC_ALL" | "TZ";

const ENVIRONMENT_KEYS: readonly ServiceEnvironmentKey[] = ["LANG", "LC_ALL", "TZ"];
const LOCALE_PATTERN =
  /^(?:C|POSIX|[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)?(?:\.[A-Za-z0-9_-]+)?(?:@[A-Za-z0-9_-]+)?)$/;
const TIMEZONE_PATTERN = /^(?:UTC|GMT|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z][A-Za-z0-9_+-]*)+)$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export interface ServiceDefinitionInput {
  readonly platform: "darwin" | "linux";
  readonly uid: number;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly configPath: string;
  readonly environment: Readonly<Partial<Record<ServiceEnvironmentKey, string>>>;
}

function invalidDefinition(): never {
  throw new Error("Invalid service definition input");
}

function assertAbsoluteDefinitionPath(value: string): void {
  if (!path.isAbsolute(value) || CONTROL_CHARACTER_PATTERN.test(value)) {
    invalidDefinition();
  }
}

function assertInput(input: ServiceDefinitionInput): void {
  if (
    !Number.isSafeInteger(input.uid) ||
    input.uid < 0 ||
    (input.platform !== "darwin" && input.platform !== "linux")
  ) {
    invalidDefinition();
  }
  assertAbsoluteDefinitionPath(input.nodePath);
  assertAbsoluteDefinitionPath(input.cliPath);
  assertAbsoluteDefinitionPath(input.configPath);
}

function isAllowedEnvironmentKey(key: string): key is ServiceEnvironmentKey {
  return ENVIRONMENT_KEYS.includes(key as ServiceEnvironmentKey);
}

function validateEnvironmentValue(key: ServiceEnvironmentKey, value: string): void {
  if (
    Buffer.byteLength(value, "utf8") > 128 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !/^[\x20-\x7e]*$/.test(value) ||
    (key === "TZ" ? !TIMEZONE_PATTERN.test(value) : !LOCALE_PATTERN.test(value))
  ) {
    invalidDefinition();
  }
}

function environmentEntries(
  environment: ServiceDefinitionInput["environment"],
): readonly (readonly [ServiceEnvironmentKey, string])[] {
  const entries: [ServiceEnvironmentKey, string][] = [];
  for (const [key, value] of Object.entries(environment)) {
    if (!isAllowedEnvironmentKey(key) || typeof value !== "string") invalidDefinition();
    validateEnvironmentValue(key, value);
    entries.push([key, value]);
  }
  return entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeSystemdArgument(value: string): string {
  return value
    .replaceAll("$", () => "$$")
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
}

function systemdArgument(value: string): string {
  return `"${escapeSystemdArgument(value)}"`;
}

export function renderLaunchAgent(input: ServiceDefinitionInput): string {
  assertInput(input);
  const environment = environmentEntries(input.environment);
  const programArguments = [input.nodePath, input.cliPath, "serve", "--config", input.configPath]
    .map((argument) => `\t\t<string>${escapeXmlText(argument)}</string>`)
    .join("\n");
  const environmentVariables =
    environment.length === 0
      ? ""
      : `\n\t<key>EnvironmentVariables</key>\n\t<dict>\n${environment
          .map(
            ([key, value]) => `\t\t<key>${key}</key>\n\t\t<string>${escapeXmlText(value)}</string>`,
          )
          .join("\n")}\n\t</dict>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${SERVICE_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${programArguments}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>5</integer>
\t<key>ProcessType</key>
\t<string>Background</string>${environmentVariables}
</dict>
</plist>
`;
}

export function renderSystemdUserUnit(input: ServiceDefinitionInput): string {
  assertInput(input);
  const environment = environmentEntries(input.environment);
  const execStart = [input.nodePath, input.cliPath, "serve", "--config", input.configPath]
    .map(systemdArgument)
    .join(" ");
  const environmentLines = environment
    .map(([key, value]) => `Environment=${systemdArgument(`${key}=${value}`)}`)
    .join("\n");
  const serviceEnvironment = environmentLines.length === 0 ? "" : `\n${environmentLines}`;

  return `[Unit]
Description=TOSS Agent Runtime
StartLimitIntervalSec=60s
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5s
UMask=0077${serviceEnvironment}

[Install]
WantedBy=default.target
`;
}

export function renderServiceDefinition(input: ServiceDefinitionInput): string {
  if (input.platform === "darwin") return renderLaunchAgent(input);
  if (input.platform === "linux") return renderSystemdUserUnit(input);
  return invalidDefinition();
}
