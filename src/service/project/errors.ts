import type { RuntimeError } from "../../protocol/types.js";

export type RuntimeProjectErrorCode =
  | "RUNTIME_PROJECT_INVALID"
  | "RUNTIME_PROJECT_PATH_UNSAFE"
  | "RUNTIME_PROJECT_NOT_FOUND"
  | "RUNTIME_PROJECT_UNAVAILABLE"
  | "RUNTIME_PROJECT_REGISTRY_CORRUPT"
  | "RUNTIME_PROJECT_INTAKE_CORRUPT";

const ERRORS: Readonly<
  Record<
    RuntimeProjectErrorCode,
    Readonly<{
      category: RuntimeError["category"];
      retryable: boolean;
      safeMessage: string;
    }>
  >
> = {
  RUNTIME_PROJECT_INVALID: {
    category: "invalid-input",
    retryable: false,
    safeMessage: "Project input is invalid",
  },
  RUNTIME_PROJECT_PATH_UNSAFE: {
    category: "integrity",
    retryable: false,
    safeMessage: "Project path is unsafe",
  },
  RUNTIME_PROJECT_NOT_FOUND: {
    category: "invalid-input",
    retryable: false,
    safeMessage: "Project registration was not found",
  },
  RUNTIME_PROJECT_UNAVAILABLE: {
    category: "unavailable",
    retryable: true,
    safeMessage: "Project is unavailable",
  },
  RUNTIME_PROJECT_REGISTRY_CORRUPT: {
    category: "integrity",
    retryable: false,
    safeMessage: "Project registry is corrupt",
  },
  RUNTIME_PROJECT_INTAKE_CORRUPT: {
    category: "integrity",
    retryable: false,
    safeMessage: "Project intake state is corrupt",
  },
};

export class RuntimeProjectError extends Error {
  readonly category: RuntimeError["category"];
  readonly retryable: boolean;
  readonly safe_message: string;

  constructor(readonly code: RuntimeProjectErrorCode) {
    const definition = ERRORS[code];
    super(definition.safeMessage);
    this.name = "RuntimeProjectError";
    this.category = definition.category;
    this.retryable = definition.retryable;
    this.safe_message = definition.safeMessage;
  }
}
