import { canonicalJson, type JsonValue } from "../protocol/json.js";
import type { RuntimeError } from "../protocol/types.js";

export type ExitCode = 0 | 2 | 3 | 4 | 5 | 6 | 69 | 70;

export interface CommandResultV1 {
  readonly schema_version: "command-result.v1";
  readonly document_type: "command-result";
  readonly command: string;
  readonly ok: boolean;
  readonly exit_code: ExitCode;
  readonly data: JsonValue | null;
  readonly error: RuntimeError | null;
}

export function commandResult(options: {
  readonly command: string;
  readonly exitCode: ExitCode;
  readonly data?: JsonValue | null;
  readonly error?: RuntimeError | null;
}): CommandResultV1 {
  return {
    schema_version: "command-result.v1",
    document_type: "command-result",
    command: options.command,
    ok: options.exitCode === 0,
    exit_code: options.exitCode,
    data: options.data ?? null,
    error: options.error ?? null,
  };
}

export function renderJson(result: CommandResultV1): string {
  return `${canonicalJson(result)}\n`;
}
