import type { RuntimeError } from "../protocol/types.js";

const ERROR_DETAILS = {
  RUNTIME_AGENT_DEFINITION_INVALID: {
    category: "invalid-input",
    retryable: false,
    safe_message: "Agent definition is invalid",
  },
  RUNTIME_AGENT_DEFINITION_UNSUPPORTED: {
    category: "unsupported-capability",
    retryable: false,
    safe_message: "Agent definition is unsupported",
  },
  RUNTIME_AGENT_NOT_FOUND: {
    category: "unavailable",
    retryable: false,
    safe_message: "Agent definition was not found",
  },
  RUNTIME_AGENT_STALE_REVISION: {
    category: "stale-revision",
    retryable: false,
    safe_message: "Agent definition revision is stale",
  },
  RUNTIME_AGENT_OPERATION_CONFLICT: {
    category: "stale-revision",
    retryable: false,
    safe_message: "Agent operation conflicts with an existing operation",
  },
  RUNTIME_AGENT_REGISTRY_CORRUPT: {
    category: "integrity",
    retryable: false,
    safe_message: "Agent registry is corrupt",
  },
  RUNTIME_AGENT_PATH_UNSAFE: {
    category: "integrity",
    retryable: false,
    safe_message: "Agent registry path is unsafe",
  },
  RUNTIME_CONTEXT_REFERENCE_MISMATCH: {
    category: "integrity",
    retryable: false,
    safe_message: "Context reference does not match resolved content",
  },
  RUNTIME_CONTEXT_AUTHORITY_MISMATCH: {
    category: "policy-denied",
    retryable: false,
    safe_message: "Context request exceeds agent authority",
  },
  RUNTIME_CONTEXT_UNSUPPORTED: {
    category: "unsupported-capability",
    retryable: false,
    safe_message: "Context input is unsupported",
  },
  RUNTIME_CONTEXT_OVERFLOW: {
    category: "policy-denied",
    retryable: false,
    safe_message: "Context exceeds its configured budget",
  },
  RUNTIME_CONTEXT_INTEGRITY: {
    category: "integrity",
    retryable: false,
    safe_message: "Context integrity check failed",
  },
} as const satisfies Record<
  string,
  Readonly<Pick<RuntimeError, "category" | "retryable" | "safe_message">>
>;

export type RuntimeAgentErrorCode = keyof typeof ERROR_DETAILS;

export class RuntimeAgentError extends Error implements RuntimeError {
  readonly category: RuntimeError["category"];
  readonly retryable: boolean;
  readonly safe_message: string;

  constructor(readonly code: RuntimeAgentErrorCode) {
    const details = ERROR_DETAILS[code];
    super(details.safe_message);
    this.name = "RuntimeAgentError";
    this.category = details.category;
    this.retryable = details.retryable;
    this.safe_message = details.safe_message;
  }
}
