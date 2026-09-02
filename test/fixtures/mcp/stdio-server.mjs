import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const option = (name) =>
  args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
const observationPath = option("--observe");
const hangInitialize = args.includes("--hang-initialize");
const ignoreClose = args.includes("--ignore-close");
const stderrSecret = args.includes("--emit-stderr-secret")
  ? "stderr-secret-must-not-escape"
  : undefined;
const stderrBytes = Number(option("--stderr-bytes") ?? "0");

if (observationPath !== undefined) {
  writeFileSync(
    observationPath,
    JSON.stringify({
      argv: process.argv.slice(1),
      cwd: process.cwd(),
      env: process.env,
      executable: process.execPath,
    }),
    { mode: 0o600 },
  );
}

if (stderrSecret !== undefined) {
  process.stderr.write(`${stderrSecret}${"x".repeat(Math.max(0, stderrBytes))}\n`);
}

if (ignoreClose) {
  process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 1_000);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (hangInitialize) return;
    respond(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "stdio-fixture", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        {
          name: "echo",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
            properties: { value: { type: "string" } },
          },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    respond(message.id, {
      content: [{ type: "text", text: String(message.params.arguments?.value ?? "") }],
      isError: false,
    });
    return;
  }
  if (message.method === "ping") respond(message.id, {});
});

lines.on("close", () => {
  if (!ignoreClose) process.exit(0);
});
