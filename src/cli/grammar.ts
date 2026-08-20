import path from "node:path";

export type ServiceAction = "install" | "start" | "stop" | "restart" | "status" | "uninstall";
export type ProjectAction = "register" | "unregister" | "list";
export type LogLevel = "debug" | "info" | "warn" | "error";

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
    }>
  | Readonly<{
      name: "project";
      action: "register";
      root: string;
      json: boolean;
    }>
  | Readonly<{
      name: "project";
      action: "unregister";
      projectId: string;
      json: boolean;
    }>
  | Readonly<{
      name: "project";
      action: "list";
      json: boolean;
    }>
  | Readonly<{
      name: "logs";
      json: boolean;
      follow: boolean;
      level?: LogLevel;
      projectId?: string;
      runId?: string;
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

function projectAction(value: string): ProjectAction {
  if (value === "register" || value === "unregister" || value === "list") return value;
  throw new CliUsageError("Unknown project action");
}

function projectCommand(args: readonly string[]): Extract<BaselineCommand, { name: "project" }> {
  const [rawAction, ...projectArgs] = args;
  if (rawAction === undefined || rawAction.startsWith("--")) {
    throw new CliUsageError("Missing project action");
  }
  const action = projectAction(rawAction);
  if (action === "list") {
    return { name: "project", action, ...parseOptions("project list", projectArgs, false) };
  }
  const [argument, ...optionArgs] = projectArgs;
  if (argument === undefined || argument.startsWith("--")) {
    throw new CliUsageError(action === "register" ? "Missing project root" : "Missing project ID");
  }
  const parsed = parseOptions(`project ${action}`, optionArgs, false);
  if (action === "register") {
    if (
      !path.isAbsolute(argument) ||
      path.normalize(argument) !== argument ||
      /[\u0000-\u001f\u007f]/u.test(argument)
    ) {
      throw new CliUsageError("Project root must be absolute");
    }
    return { name: "project", action, root: argument, ...parsed };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(argument)) {
    throw new CliUsageError("Project ID must be a UUID");
  }
  return { name: "project", action, projectId: argument.toLowerCase(), ...parsed };
}

function logCommand(args: readonly string[]): Extract<BaselineCommand, { name: "logs" }> {
  let json = false;
  let follow = false;
  let level: LogLevel | undefined;
  let projectId: string | undefined;
  let runId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      if (json) throw new CliUsageError("Duplicate option: --json");
      json = true;
      continue;
    }
    if (option === "--follow") {
      if (follow) throw new CliUsageError("Duplicate option: --follow");
      follow = true;
      continue;
    }
    if (option !== "--level" && option !== "--project" && option !== "--run") {
      const safeOption = option?.startsWith("--") ? option.split("=", 1)[0]! : "<argument>";
      throw new CliUsageError(`Unknown option for logs: ${safeOption}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`Missing value for ${option}`);
    }
    if (option === "--level") {
      if (level !== undefined) throw new CliUsageError("Duplicate option: --level");
      if (value !== "debug" && value !== "info" && value !== "warn" && value !== "error") {
        throw new CliUsageError("Invalid log level");
      }
      level = value;
    } else {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
        throw new CliUsageError(`${option === "--project" ? "Project" : "Run"} ID must be a UUID`);
      }
      if (option === "--project") {
        if (projectId !== undefined) throw new CliUsageError("Duplicate option: --project");
        projectId = value.toLowerCase();
      } else {
        if (runId !== undefined) throw new CliUsageError("Duplicate option: --run");
        runId = value.toLowerCase();
      }
    }
    index += 1;
  }
  if (json && follow) throw new CliUsageError("--json cannot be combined with --follow");
  return {
    name: "logs",
    json,
    follow,
    ...(level === undefined ? {} : { level }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(runId === undefined ? {} : { runId }),
  };
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
  if (name === "project") return projectCommand(args);
  if (name === "logs") return logCommand(args);
  throw new CliUsageError("Unknown command");
}
