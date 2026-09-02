import type { RuntimeError } from "../protocol/types.js";

const TOOL_ERROR_DETAILS = {
  RUNTIME_TOOL_INVALID: {
    category: "invalid-input",
    retryable: false,
    safe_message: "Tool input is invalid",
  },
  RUNTIME_TOOL_SCHEMA_MISMATCH: {
    category: "integrity",
    retryable: false,
    safe_message: "Tool schema does not match its profile",
  },
  RUNTIME_TOOL_PROTOCOL_DOWNGRADE: {
    category: "integrity",
    retryable: false,
    safe_message: "Tool protocol revision was downgraded",
  },
  RUNTIME_TOOL_RESULT_INVALID: {
    category: "integrity",
    retryable: false,
    safe_message: "Tool result is invalid",
  },
  RUNTIME_TOOL_POLICY_DENIED: {
    category: "policy-denied",
    retryable: false,
    safe_message: "Tool call is denied by policy",
  },
  RUNTIME_TOOL_UNSUPPORTED: {
    category: "unsupported-capability",
    retryable: false,
    safe_message: "Tool capability is unsupported",
  },
  RUNTIME_TOOL_OPERATION_CONFLICT: {
    category: "stale-revision",
    retryable: false,
    safe_message: "Tool operation conflicts with an existing operation",
  },
  RUNTIME_TOOL_APPROVAL_REQUIRED: {
    category: "approval-required",
    retryable: false,
    safe_message: "Tool call requires human approval",
  },
  RUNTIME_TOOL_APPROVAL_STALE: {
    category: "stale-revision",
    retryable: false,
    safe_message: "Tool approval is stale",
  },
  RUNTIME_TOOL_APPROVAL_REJECTED: {
    category: "policy-denied",
    retryable: false,
    safe_message: "Tool approval was rejected",
  },
  RUNTIME_TOOL_EFFECT_UNCERTAIN: {
    category: "integrity",
    retryable: false,
    safe_message: "Tool effect is uncertain",
  },
  RUNTIME_TOOL_AUTHENTICATION: {
    category: "authentication",
    retryable: false,
    safe_message: "Tool authentication failed",
  },
  RUNTIME_TOOL_UNAVAILABLE: {
    category: "unavailable",
    retryable: true,
    safe_message: "Tool service is unavailable",
  },
  RUNTIME_TOOL_RATE_LIMIT: {
    category: "rate-limit",
    retryable: true,
    safe_message: "Tool rate limit exceeded",
  },
  RUNTIME_TOOL_TIMEOUT: {
    category: "timeout",
    retryable: true,
    safe_message: "Tool call timed out",
  },
  RUNTIME_TOOL_CANCELLED: {
    category: "cancelled",
    retryable: false,
    safe_message: "Tool call was cancelled",
  },
  RUNTIME_TOOL_INTERNAL: {
    category: "internal",
    retryable: false,
    safe_message: "Tool operation failed",
  },
} as const satisfies Record<
  string,
  Readonly<Pick<RuntimeError, "category" | "retryable" | "safe_message">>
>;

export type RuntimeToolErrorCode = keyof typeof TOOL_ERROR_DETAILS;

export function isRuntimeToolErrorCode(value: unknown): value is RuntimeToolErrorCode {
  return typeof value === "string" && Object.hasOwn(TOOL_ERROR_DETAILS, value);
}

export class RuntimeToolError extends Error implements RuntimeError {
  readonly category: RuntimeError["category"];
  readonly retryable: boolean;
  readonly safe_message: string;

  constructor(readonly code: RuntimeToolErrorCode) {
    const details = TOOL_ERROR_DETAILS[code];
    super(details.safe_message);
    this.name = "RuntimeToolError";
    this.category = details.category;
    this.retryable = details.retryable;
    this.safe_message = details.safe_message;
  }
}

export function toolRuntimeError(code: RuntimeToolErrorCode): RuntimeError {
  const error = new RuntimeToolError(code);
  return Object.freeze({
    code: error.code,
    category: error.category,
    retryable: error.retryable,
    safe_message: error.safe_message,
  });
}
