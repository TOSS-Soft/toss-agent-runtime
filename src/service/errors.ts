import type { RuntimeError } from "../protocol/types.js";

const SERVICE_ERROR_DETAILS = {
  RUNTIME_SERVICE_ALREADY_RUNNING: {
    category: "unavailable",
    retryable: false,
    safe_message: "Runtime service is already running",
  },
  RUNTIME_SERVICE_LOCK_AMBIGUOUS: {
    category: "integrity",
    retryable: false,
    safe_message: "Runtime service lock state is ambiguous",
  },
  RUNTIME_SERVICE_PATH_UNSAFE: {
    category: "integrity",
    retryable: false,
    safe_message: "Runtime service path is unsafe",
  },
  RUNTIME_SERVICE_DEFINITION_UNSAFE: {
    category: "integrity",
    retryable: false,
    safe_message: "Runtime service definition is unsafe",
  },
  RUNTIME_SERVICE_MANAGER_UNAVAILABLE: {
    category: "unavailable",
    retryable: false,
    safe_message: "Runtime service manager is unavailable",
  },
  RUNTIME_SERVICE_MANAGER_FAILED: {
    category: "unavailable",
    retryable: true,
    safe_message: "Runtime service manager failed",
  },
  RUNTIME_SERVICE_CONTROL_INVALID: {
    category: "invalid-input",
    retryable: false,
    safe_message: "Runtime service control request is invalid",
  },
  RUNTIME_SERVICE_CONTROL_CONFLICT: {
    category: "stale-revision",
    retryable: false,
    safe_message: "Runtime service control request conflicts with an existing request",
  },
  RUNTIME_SERVICE_UNAVAILABLE: {
    category: "unavailable",
    retryable: true,
    safe_message: "Runtime service is unavailable",
  },
} as const satisfies Record<
  string,
  Readonly<Pick<RuntimeError, "category" | "retryable" | "safe_message">>
>;

export type RuntimeServiceErrorCode = keyof typeof SERVICE_ERROR_DETAILS;

export class RuntimeServiceError extends Error implements RuntimeError {
  readonly category: RuntimeError["category"];
  readonly retryable: boolean;
  readonly safe_message: string;

  constructor(readonly code: RuntimeServiceErrorCode) {
    const details = SERVICE_ERROR_DETAILS[code];
    super(details.safe_message);
    this.name = "RuntimeServiceError";
    this.category = details.category;
    this.retryable = details.retryable;
    this.safe_message = details.safe_message;
  }
}
