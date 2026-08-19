import { execFile } from "node:child_process";
import path from "node:path";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(file: string, args: readonly string[]): Promise<CommandResult>;
}

const MAX_COMMAND_OUTPUT_BYTES = 65_536;

export class ProcessCommandRunner implements CommandRunner {
  run(file: string, args: readonly string[]): Promise<CommandResult> {
    if (!path.isAbsolute(file)) {
      return Promise.reject(new Error("Native command path must be absolute"));
    }
    return new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        {
          encoding: "utf8",
          maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ exitCode: 0, stdout, stderr });
            return;
          }
          if (typeof error.code === "number") {
            resolve({ exitCode: error.code, stdout, stderr });
            return;
          }
          reject(error instanceof Error ? error : new Error("Native command failed"));
        },
      );
    });
  }
}
