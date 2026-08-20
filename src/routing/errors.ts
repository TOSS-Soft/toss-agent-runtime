import type { RuntimeError } from "../protocol/types.js";

const ROUTING_ERROR_DETAILS = {
  RUNTIME_ROUTING_INVALID: {
    category: "invalid-input",
    retryable: false,
    safe_message: "Routing input is invalid",
  },
  RUNTIME_ROUTING_BUDGET_EXCEEDED: {
    category: "policy-denied",
    retryable: false,
    safe_message: "Routing budget is exceeded",
  },
  RUNTIME_ROUTING_NO_CAPABLE_ROUTE: {
    category: "unsupported-capability",
    retryable: false,
    safe_message: "No capable route is available",
  },
  RUNTIME_ROUTING_REVIEW_UNAVAILABLE: {
    category: "unsupported-capability",
    retryable: false,
    safe_message: "Independent review is unavailable",
  },
  RUNTIME_ROUTING_POLICY_DENIED: {
    category: "policy-denied",
    retryable: false,
    safe_message: "Routing policy denied the request",
  },
  RUNTIME_ROUTING_CIRCUIT_OPEN: {
    category: "unavailable",
    retryable: true,
    safe_message: "Routing circuit is open",
  },
  RUNTIME_ROUTING_STALE_STATE: {
    category: "stale-revision",
    retryable: false,
    safe_message: "Routing state is stale",
  },
  RUNTIME_ROUTING_USAGE_UNKNOWN: {
    category: "integrity",
    retryable: false,
    safe_message: "Routing usage is unknown",
  },
  RUNTIME_ROUTING_RESOLUTION_MISMATCH: {
    category: "integrity",
    retryable: false,
    safe_message: "Resolved route does not match the plan",
  },
} as const satisfies Record<
  string,
  Readonly<Pick<RuntimeError, "category" | "retryable" | "safe_message">>
>;

export type RuntimeRoutingErrorCode = keyof typeof ROUTING_ERROR_DETAILS;

export class RuntimeRoutingError extends Error implements RuntimeError {
  readonly category: RuntimeError["category"];
  readonly retryable: boolean;
  readonly safe_message: string;

  constructor(readonly code: RuntimeRoutingErrorCode) {
    const details = ROUTING_ERROR_DETAILS[code];
    super(details.safe_message);
    this.name = "RuntimeRoutingError";
    this.category = details.category;
    this.retryable = details.retryable;
    this.safe_message = details.safe_message;
  }
}

export function routingRuntimeError(code: RuntimeRoutingErrorCode): RuntimeError {
  const error = new RuntimeRoutingError(code);
  return Object.freeze({
    code: error.code,
    category: error.category,
    retryable: error.retryable,
    safe_message: error.safe_message,
  });
}
