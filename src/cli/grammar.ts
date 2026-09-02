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
    }>
  | Readonly<{
      name: "tool-approve";
      runId: string;
      expectedJournalRevision: number;
      expectedJournalHeadHash: `sha256:${string}`;
      callId: string;
      approvalRequestHash: `sha256:${string}`;
      decision: "APPROVE" | "REJECT";
      json: boolean;
    }>
  | Readonly<{
      name: "tool-dispose";
      runId: string;
      expectedJournalRevision: number;
      expectedJournalHeadHash: `sha256:${string}`;
      callId: string;
      idempotencyKey: `sha256:${string}`;
      disposition: "NO_EFFECT_CONFIRMED" | "EFFECT_CONFIRMED";
      json: boolean;
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

function toolApproveCommand(
  args: readonly string[],
): Extract<BaselineCommand, { name: "tool-approve" }> {
  const values = new Map<string, string>();
  let json = false;
  const required = ["--run", "--revision", "--head", "--call", "--request", "--decision"];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === "--json") {
      if (json) throw new CliUsageError("Duplicate option: --json");
      json = true;
      continue;
    }
    if (!required.includes(option)) {
      const safeOption = option.startsWith("--") ? option.split("=", 1)[0]! : "<argument>";
      throw new CliUsageError(`Unknown option for tool-approve: ${safeOption}`);
    }
    if (values.has(option)) throw new CliUsageError(`Duplicate option: ${option}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`Missing value for ${option}`);
    }
    values.set(option, value);
    index += 1;
  }
  for (const option of required) {
    if (!values.has(option)) throw new CliUsageError(`Missing option for tool-approve: ${option}`);
  }

  const runId = values.get("--run")!;
  const revisionText = values.get("--revision")!;
  const head = values.get("--head")!;
  const callId = values.get("--call")!;
  const requestHash = values.get("--request")!;
  const decision = values.get("--decision")!;
  const identifier = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
  const hash = /^sha256:[0-9a-f]{64}$/u;
  if (!identifier.test(runId)) throw new CliUsageError("Run ID is invalid");
  if (!identifier.test(callId)) throw new CliUsageError("Tool call ID is invalid");
  if (!/^[1-9][0-9]*$/u.test(revisionText)) {
    throw new CliUsageError("Journal revision must be a positive integer");
  }
  const expectedJournalRevision = Number(revisionText);
  if (!Number.isSafeInteger(expectedJournalRevision)) {
    throw new CliUsageError("Journal revision must be a positive integer");
  }
  if (!hash.test(head)) throw new CliUsageError("Journal head hash is invalid");
  if (!hash.test(requestHash)) throw new CliUsageError("Approval request hash is invalid");
  if (decision !== "APPROVE" && decision !== "REJECT") {
    throw new CliUsageError("Tool decision must be APPROVE or REJECT");
  }
  return {
    name: "tool-approve",
    runId,
    expectedJournalRevision,
    expectedJournalHeadHash: head as `sha256:${string}`,
    callId,
    approvalRequestHash: requestHash as `sha256:${string}`,
    decision,
    json,
  };
}

function toolDisposeCommand(
  args: readonly string[],
): Extract<BaselineCommand, { name: "tool-dispose" }> {
  const values = new Map<string, string>();
  let json = false;
  const required = ["--run", "--revision", "--head", "--call", "--idempotency", "--disposition"];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === "--json") {
      if (json) throw new CliUsageError("Duplicate option: --json");
      json = true;
      continue;
    }
    if (!required.includes(option)) {
      const safeOption = option.startsWith("--") ? option.split("=", 1)[0]! : "<argument>";
      throw new CliUsageError(`Unknown option for tool-dispose: ${safeOption}`);
    }
    if (values.has(option)) throw new CliUsageError(`Duplicate option: ${option}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`Missing value for ${option}`);
    }
    values.set(option, value);
    index += 1;
  }
  for (const option of required) {
    if (!values.has(option)) throw new CliUsageError(`Missing option for tool-dispose: ${option}`);
  }

  const runId = values.get("--run")!;
  const revisionText = values.get("--revision")!;
  const head = values.get("--head")!;
  const callId = values.get("--call")!;
  const idempotencyKey = values.get("--idempotency")!;
  const disposition = values.get("--disposition")!;
  const identifier = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
  const hash = /^sha256:[0-9a-f]{64}$/u;
  if (!identifier.test(runId)) throw new CliUsageError("Run ID is invalid");
  if (!identifier.test(callId)) throw new CliUsageError("Tool call ID is invalid");
  if (!/^[1-9][0-9]*$/u.test(revisionText)) {
    throw new CliUsageError("Journal revision must be a positive integer");
  }
  const expectedJournalRevision = Number(revisionText);
  if (!Number.isSafeInteger(expectedJournalRevision)) {
    throw new CliUsageError("Journal revision must be a positive integer");
  }
  if (!hash.test(head)) throw new CliUsageError("Journal head hash is invalid");
  if (!hash.test(idempotencyKey)) throw new CliUsageError("Tool idempotency key is invalid");
  if (disposition !== "NO_EFFECT_CONFIRMED" && disposition !== "EFFECT_CONFIRMED") {
    throw new CliUsageError("Tool disposition must be NO_EFFECT_CONFIRMED or EFFECT_CONFIRMED");
  }
  return {
    name: "tool-dispose",
    runId,
    expectedJournalRevision,
    expectedJournalHeadHash: head as `sha256:${string}`,
    callId,
    idempotencyKey: idempotencyKey as `sha256:${string}`,
    disposition,
    json,
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
  if (name === "tool-approve") return toolApproveCommand(args);
  if (name === "tool-dispose") return toolDisposeCommand(args);
  throw new CliUsageError("Unknown command");
}
