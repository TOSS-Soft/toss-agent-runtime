import type { RuntimeError } from "../protocol/types.js";

const LOGGING_ERROR_DETAILS = {
  RUNTIME_LOGGING_CORRUPT: {
    category: "integrity",
    retryable: false,
    safe_message: "Operational log is corrupt",
  },
  RUNTIME_LOGGING_DEGRADED: {
    category: "unavailable",
    retryable: false,
    safe_message: "Operational logging is degraded",
  },
  RUNTIME_LOGGING_INVALID: {
    category: "invalid-input",
    retryable: false,
    safe_message: "Operational log input is invalid",
  },
  RUNTIME_LOGGING_PATH_UNSAFE: {
    category: "integrity",
    retryable: false,
    safe_message: "Operational log path is unsafe",
  },
} as const satisfies Record<
  string,
  Readonly<Pick<RuntimeError, "category" | "retryable" | "safe_message">>
>;

export type RuntimeLoggingErrorCode = keyof typeof LOGGING_ERROR_DETAILS;

export class RuntimeLoggingError extends Error implements RuntimeError {
  readonly category: RuntimeError["category"];
  readonly retryable: boolean;
  readonly safe_message: string;

  constructor(readonly code: RuntimeLoggingErrorCode) {
    const details = LOGGING_ERROR_DETAILS[code];
    super(details.safe_message);
    this.name = "RuntimeLoggingError";
    this.category = details.category;
    this.retryable = details.retryable;
    this.safe_message = details.safe_message;
  }
}
