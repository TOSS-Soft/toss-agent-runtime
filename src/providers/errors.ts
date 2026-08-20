import type { RuntimeError } from "../protocol/types.js";

const PROVIDER_ERROR_DETAILS = {
  RUNTIME_PROVIDER_INVALID: {
    category: "invalid-input",
    retryable: false,
    safe_message: "Provider request or response is invalid",
  },
  RUNTIME_PROVIDER_UNSUPPORTED: {
    category: "unsupported-capability",
    retryable: false,
    safe_message: "Provider capability is unsupported",
  },
  RUNTIME_PROVIDER_AUTHENTICATION: {
    category: "authentication",
    retryable: false,
    safe_message: "Provider authentication failed",
  },
  RUNTIME_PROVIDER_RATE_LIMIT: {
    category: "rate-limit",
    retryable: true,
    safe_message: "Provider rate limit exceeded",
  },
  RUNTIME_PROVIDER_REFUSAL: {
    category: "refusal",
    retryable: false,
    safe_message: "Provider refused the request",
  },
  RUNTIME_PROVIDER_TIMEOUT: {
    category: "timeout",
    retryable: true,
    safe_message: "Provider request timed out",
  },
  RUNTIME_PROVIDER_CANCELLED: {
    category: "cancelled",
    retryable: false,
    safe_message: "Provider request was cancelled",
  },
  RUNTIME_PROVIDER_TRANSIENT: {
    category: "unavailable",
    retryable: true,
    safe_message: "Provider is temporarily unavailable",
  },
  RUNTIME_PROVIDER_UNAVAILABLE: {
    category: "unavailable",
    retryable: false,
    safe_message: "Provider is unavailable",
  },
  RUNTIME_PROVIDER_INTERNAL: {
    category: "internal",
    retryable: false,
    safe_message: "Provider operation failed",
  },
} as const satisfies Record<
  string,
  Readonly<Pick<RuntimeError, "category" | "retryable" | "safe_message">>
>;

export type RuntimeProviderErrorCode = keyof typeof PROVIDER_ERROR_DETAILS;

export function isRuntimeProviderErrorCode(value: string): value is RuntimeProviderErrorCode {
  return Object.hasOwn(PROVIDER_ERROR_DETAILS, value);
}

export class RuntimeProviderError extends Error implements RuntimeError {
  readonly category: RuntimeError["category"];
  readonly retryable: boolean;
  readonly safe_message: string;

  constructor(readonly code: RuntimeProviderErrorCode) {
    const details = PROVIDER_ERROR_DETAILS[code];
    super(details.safe_message);
    this.name = "RuntimeProviderError";
    this.category = details.category;
    this.retryable = details.retryable;
    this.safe_message = details.safe_message;
  }
}

export function providerRuntimeError(code: RuntimeProviderErrorCode): RuntimeError {
  const error = new RuntimeProviderError(code);
  return Object.freeze({
    code: error.code,
    category: error.category,
    retryable: error.retryable,
    safe_message: error.safe_message,
  });
}
