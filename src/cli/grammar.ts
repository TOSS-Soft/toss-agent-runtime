export type BaselineCommand =
  | Readonly<{ name: "help" }>
  | Readonly<{ name: "version" }>
  | Readonly<{ name: "capabilities"; json: boolean }>
  | Readonly<{ name: "doctor"; json: boolean; configPath?: string }>
  | Readonly<{ name: "serve"; json: boolean; configPath?: string }>;

export class CliUsageError extends Error {
  readonly code = "RUNTIME_CLI_USAGE";

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function parseOptions(
  name: "capabilities" | "doctor" | "serve",
  args: readonly string[],
): { readonly json: boolean; readonly configPath?: string } {
  let json = false;
  let configPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      if (json) throw new CliUsageError("Duplicate option: --json");
      json = true;
      continue;
    }
    if (option === "--config") {
      if (name === "capabilities") {
        throw new CliUsageError("Unknown option for capabilities: --config");
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError("Missing value for --config");
      }
      if (configPath !== undefined) throw new CliUsageError("Duplicate option: --config");
      configPath = value;
      index += 1;
      continue;
    }
    const safeOption = option?.startsWith("--") ? option.split("=", 1)[0]! : "<argument>";
    throw new CliUsageError(`Unknown option for ${name}: ${safeOption}`);
  }

  return configPath === undefined ? { json } : { json, configPath };
}

export function parseCli(argv: readonly string[]): BaselineCommand {
  if (argv.length === 0 || (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0]!))) {
    return { name: "help" };
  }
  if (argv.length === 1 && ["--version", "-v", "version"].includes(argv[0]!)) {
    return { name: "version" };
  }

  const [name, ...args] = argv;
  if (name === "capabilities" || name === "doctor" || name === "serve") {
    return { name, ...parseOptions(name, args) };
  }
  throw new CliUsageError("Unknown command");
}
