import type { RuntimeError } from "../protocol/types.js";

const JOURNAL_ERROR_DETAILS = {
  RUNTIME_STATE_STALE: {
    category: "stale-revision",
    retryable: false,
    safe_message: "Run journal state is stale",
  },
  RUNTIME_STATE_TRANSITION_INVALID: {
    category: "invalid-input",
    retryable: false,
    safe_message: "Run state transition is invalid",
  },
  RUNTIME_OPERATION_CONFLICT: {
    category: "stale-revision",
    retryable: false,
    safe_message: "Run operation conflicts with an existing operation",
  },
  RUNTIME_JOURNAL_CORRUPT: {
    category: "integrity",
    retryable: false,
    safe_message: "Run journal integrity verification failed",
  },
  RUNTIME_JOURNAL_PATH_UNSAFE: {
    category: "integrity",
    retryable: false,
    safe_message: "Run journal path is unsafe",
  },
  RUNTIME_JOURNAL_UNAVAILABLE: {
    category: "unavailable",
    retryable: true,
    safe_message: "Run journal is unavailable",
  },
} as const satisfies Record<
  string,
  Readonly<Pick<RuntimeError, "category" | "retryable" | "safe_message">>
>;

export type RuntimeJournalErrorCode = keyof typeof JOURNAL_ERROR_DETAILS;

export class RuntimeJournalError extends Error implements RuntimeError {
  readonly category: RuntimeError["category"];
  readonly retryable: boolean;
  readonly safe_message: string;

  constructor(readonly code: RuntimeJournalErrorCode) {
    const details = JOURNAL_ERROR_DETAILS[code];
    super(details.safe_message);
    this.name = "RuntimeJournalError";
    this.category = details.category;
    this.retryable = details.retryable;
    this.safe_message = details.safe_message;
  }
}
