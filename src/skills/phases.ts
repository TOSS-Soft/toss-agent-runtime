import { sha256 } from "../protocol/json.js";
import type { SuperpowersPhaseName } from "./types.js";

export type BuiltInSuperpowersCapability =
  | "brainstorming"
  | "test-driven-development"
  | "systematic-debugging"
  | "requesting-code-review"
  | "verification-before-completion";

export type BuiltInSuperpowersPolicy = Readonly<
  Record<BuiltInSuperpowersCapability, readonly SuperpowersPhaseName[]>
>;

export const BUILTIN_SUPERPOWERS_POLICY: BuiltInSuperpowersPolicy = Object.freeze({
  brainstorming: Object.freeze(["BRAINSTORMING"] as const),
  "test-driven-development": Object.freeze(["TEST_DESIGN", "RED", "GREEN"] as const),
  "systematic-debugging": Object.freeze(["DEBUGGING"] as const),
  "requesting-code-review": Object.freeze(["REVIEW"] as const),
  "verification-before-completion": Object.freeze(["VERIFICATION"] as const),
});

export const BUILTIN_SUPERPOWERS_HANDLER_VERSION = "agent-skills.v1";

interface HandlerRule {
  readonly phase: SuperpowersPhaseName;
  readonly required: readonly SuperpowersPhaseName[];
  readonly conditional_requested: readonly SuperpowersPhaseName[];
}

const HANDLER_RULES: readonly HandlerRule[] = Object.freeze([
  Object.freeze({
    phase: "BRAINSTORMING",
    required: Object.freeze([] as const),
    conditional_requested: Object.freeze([] as const),
  }),
  Object.freeze({
    phase: "TEST_DESIGN",
    required: Object.freeze([] as const),
    conditional_requested: Object.freeze([] as const),
  }),
  Object.freeze({
    phase: "RED",
    required: Object.freeze(["TEST_DESIGN"] as const),
    conditional_requested: Object.freeze([] as const),
  }),
  Object.freeze({
    phase: "GREEN",
    required: Object.freeze(["RED"] as const),
    conditional_requested: Object.freeze([] as const),
  }),
  Object.freeze({
    phase: "DEBUGGING",
    required: Object.freeze(["RED"] as const),
    conditional_requested: Object.freeze([] as const),
  }),
  Object.freeze({
    phase: "REVIEW",
    required: Object.freeze(["GREEN"] as const),
    conditional_requested: Object.freeze([] as const),
  }),
  Object.freeze({
    phase: "VERIFICATION",
    required: Object.freeze(["GREEN"] as const),
    conditional_requested: Object.freeze(["DEBUGGING", "REVIEW"] as const),
  }),
]);

export function hashBuiltInPhasePolicy(
  policy: BuiltInSuperpowersPolicy = BUILTIN_SUPERPOWERS_POLICY,
): `sha256:${string}` {
  return sha256({
    schema_version: "built-in-superpowers-policy.v1",
    handler_version: BUILTIN_SUPERPOWERS_HANDLER_VERSION,
    capability_phases: policy,
    handler_rules: HANDLER_RULES,
  });
}

export interface BuiltInSuperpowersHandler {
  readonly phase: SuperpowersPhaseName;
  readonly version: string;
  readonly hash: `sha256:${string}`;
  readonly policy_hash: `sha256:${string}`;
  readonly required_predecessors: readonly SuperpowersPhaseName[];
  readonly conditional_requested_predecessors: readonly SuperpowersPhaseName[];
}

const POLICY_HASH = hashBuiltInPhasePolicy();

export const BUILTIN_SUPERPOWERS_HANDLERS: readonly BuiltInSuperpowersHandler[] = Object.freeze(
  HANDLER_RULES.map((rule) => {
    const hashable = {
      schema_version: "built-in-superpowers-handler.v1",
      phase: rule.phase,
      version: BUILTIN_SUPERPOWERS_HANDLER_VERSION,
      policy_hash: POLICY_HASH,
      required_predecessors: rule.required,
      conditional_requested_predecessors: rule.conditional_requested,
    };
    return Object.freeze({ ...hashable, hash: sha256(hashable) });
  }),
);

const HANDLERS = new Map(
  BUILTIN_SUPERPOWERS_HANDLERS.map((handler) => [handler.phase, handler] as const),
);

export function builtInSuperpowersHandler(phase: SuperpowersPhaseName): BuiltInSuperpowersHandler {
  const handler = HANDLERS.get(phase);
  if (handler === undefined) throw new TypeError("unknown built-in Superpowers phase");
  return handler;
}

export function requiredBuiltInPhasePredecessors(
  phase: SuperpowersPhaseName,
  requestedPhases: readonly SuperpowersPhaseName[],
): readonly SuperpowersPhaseName[] {
  const handler = builtInSuperpowersHandler(phase);
  if (phase !== "VERIFICATION") return handler.required_predecessors;
  const requested = new Set(requestedPhases);
  return Object.freeze([
    ...handler.required_predecessors,
    ...handler.conditional_requested_predecessors.filter((candidate) => requested.has(candidate)),
  ]);
}
