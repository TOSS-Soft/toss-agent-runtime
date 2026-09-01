import type { RuntimeError } from "../protocol/types.js";

const ERROR_DETAILS = {
  BLOCKED_SUPERPOWERS_MISSING: {
    category: "unsupported-capability",
    retryable: false,
    safe_message: "Required Superpowers skill is unavailable",
  },
  RUNTIME_SKILL_INVALID: {
    category: "invalid-input",
    retryable: false,
    safe_message: "Skill input is invalid",
  },
  RUNTIME_SKILL_PATH_UNSAFE: {
    category: "integrity",
    retryable: false,
    safe_message: "Skill path is unsafe",
  },
  RUNTIME_SKILL_INTEGRITY: {
    category: "integrity",
    retryable: false,
    safe_message: "Skill integrity check failed",
  },
  RUNTIME_SKILL_LIMIT_EXCEEDED: {
    category: "policy-denied",
    retryable: false,
    safe_message: "Skill limit is exceeded",
  },
  RUNTIME_SKILL_CONTEXT_OVERFLOW: {
    category: "policy-denied",
    retryable: false,
    safe_message: "Skill context exceeds its configured limit",
  },
  RUNTIME_SKILL_APPROVAL_REJECTED: {
    category: "policy-denied",
    retryable: false,
    safe_message: "Skill approval was rejected",
  },
  RUNTIME_SKILL_SCRIPT_UNAVAILABLE: {
    category: "unsupported-capability",
    retryable: false,
    safe_message: "Skill script is unavailable",
  },
  RUNTIME_SKILL_STALE_STATE: {
    category: "stale-revision",
    retryable: false,
    safe_message: "Skill state is stale",
  },
  RUNTIME_SKILL_OPERATION_CONFLICT: {
    category: "stale-revision",
    retryable: false,
    safe_message: "Skill operation conflicts with an existing operation",
  },
  RUNTIME_SKILL_UNAVAILABLE: {
    category: "unavailable",
    retryable: true,
    safe_message: "Skill is unavailable",
  },
} as const satisfies Record<
  string,
  Readonly<Pick<RuntimeError, "category" | "retryable" | "safe_message">>
>;

export type RuntimeSkillErrorCode = keyof typeof ERROR_DETAILS;

export function isRuntimeSkillErrorCode(value: unknown): value is RuntimeSkillErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_DETAILS, value);
}

export class RuntimeSkillError extends Error implements RuntimeError {
  readonly category: RuntimeError["category"];
  readonly retryable: boolean;
  readonly safe_message: string;

  constructor(readonly code: RuntimeSkillErrorCode) {
    const details = ERROR_DETAILS[code];
    super(details.safe_message);
    this.name = "RuntimeSkillError";
    this.category = details.category;
    this.retryable = details.retryable;
    this.safe_message = details.safe_message;
  }
}
