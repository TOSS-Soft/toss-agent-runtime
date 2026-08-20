export type ServiceAction = "install" | "start" | "stop" | "restart" | "status" | "uninstall";

export type BaselineCommand =
  | Readonly<{ name: "help" }>
  | Readonly<{ name: "version" }>
  | Readonly<{ name: "capabilities"; json: boolean }>
  | Readonly<{ name: "doctor"; json: boolean; configPath?: string }>
  | Readonly<{ name: "serve"; json: boolean; configPath?: string }>
  | Readonly<{
      name: "service";
      action: ServiceAction;
      json: boolean;
      configPath?: string;
    }>;

export class CliUsageError extends Error {
  readonly code = "RUNTIME_CLI_USAGE";

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function parseOptions(
  name: string,
  args: readonly string[],
  allowConfig: boolean,
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
      if (!allowConfig) {
        throw new CliUsageError(`Unknown option for ${name}: --config`);
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

const SERVICE_ACTIONS = new Set<ServiceAction>([
  "install",
  "start",
  "stop",
  "restart",
  "status",
  "uninstall",
]);

function serviceAction(value: string): ServiceAction {
  if (SERVICE_ACTIONS.has(value as ServiceAction)) return value as ServiceAction;
  throw new CliUsageError("Unknown service action");
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
    return { name, ...parseOptions(name, args, name !== "capabilities") };
  }
  if (name === "service") {
    const [rawAction, ...serviceArgs] = args;
    if (rawAction === undefined || rawAction.startsWith("--")) {
      throw new CliUsageError("Missing service action");
    }
    const action = serviceAction(rawAction);
    return {
      name,
      action,
      ...parseOptions(`service ${action}`, serviceArgs, action === "install"),
    };
  }
  throw new CliUsageError("Unknown command");
}
