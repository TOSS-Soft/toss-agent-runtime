import { deepFreezeJson, sha256 } from "../protocol/json.js";
import { SKILL_LIMITS, type SuperpowersPhaseName } from "./types.js";

export type BuiltInSuperpowersCapability =
  | "brainstorming"
  | "test-driven-development"
  | "systematic-debugging"
  | "requesting-code-review"
  | "verification-before-completion";

export type BuiltInSuperpowersPolicy = Readonly<
  Record<BuiltInSuperpowersCapability, readonly SuperpowersPhaseName[]>
>;

export interface BuiltInSuperpowersSemanticDescriptor {
  readonly schema_version: "built-in-superpowers-semantic.v1";
  readonly capability: BuiltInSuperpowersCapability;
  readonly phase: SuperpowersPhaseName;
  readonly version: string;
  readonly predecessors: Readonly<{
    required: readonly SuperpowersPhaseName[];
    conditional_requested: readonly SuperpowersPhaseName[];
  }>;
  readonly context: Readonly<{
    assembler_version: "skill-context.v1";
    max_total_input_bytes: number;
    conservative_bytes_per_token: number;
  }>;
  readonly completion: Readonly<{
    success_status: "COMPLETED";
    success_output: "HASHED";
    unsuccessful_output: "EMPTY";
    approval: "NONE" | "REQUIRED";
  }>;
}

export interface BuiltInSuperpowersHandler {
  readonly capability: BuiltInSuperpowersCapability;
  readonly phase: SuperpowersPhaseName;
  readonly version: string;
  readonly hash: `sha256:${string}`;
  readonly policy_hash: `sha256:${string}`;
  readonly required_predecessors: readonly SuperpowersPhaseName[];
  readonly conditional_requested_predecessors: readonly SuperpowersPhaseName[];
  readonly semantic: BuiltInSuperpowersSemanticDescriptor;
}

export interface CompiledBuiltInSuperpowersSemantics {
  readonly policy: BuiltInSuperpowersPolicy;
  readonly policy_hash: `sha256:${string}`;
  readonly handlers: readonly BuiltInSuperpowersHandler[];
}

export const BUILTIN_SUPERPOWERS_HANDLER_VERSION = "agent-skills.v1";

function descriptor(
  capability: BuiltInSuperpowersCapability,
  phase: SuperpowersPhaseName,
  required: readonly SuperpowersPhaseName[],
  conditionalRequested: readonly SuperpowersPhaseName[],
  approval: "NONE" | "REQUIRED" = "NONE",
): BuiltInSuperpowersSemanticDescriptor {
  return Object.freeze({
    schema_version: "built-in-superpowers-semantic.v1",
    capability,
    phase,
    version: BUILTIN_SUPERPOWERS_HANDLER_VERSION,
    predecessors: Object.freeze({
      required: Object.freeze([...required]),
      conditional_requested: Object.freeze([...conditionalRequested]),
    }),
    context: Object.freeze({
      assembler_version: "skill-context.v1",
      max_total_input_bytes: SKILL_LIMITS.phaseInputBytes,
      conservative_bytes_per_token: 4,
    }),
    completion: Object.freeze({
      success_status: "COMPLETED",
      success_output: "HASHED",
      unsuccessful_output: "EMPTY",
      approval,
    }),
  });
}

export const BUILTIN_SUPERPOWERS_SEMANTICS: readonly BuiltInSuperpowersSemanticDescriptor[] =
  Object.freeze([
    descriptor("brainstorming", "BRAINSTORMING", [], [], "REQUIRED"),
    descriptor("test-driven-development", "TEST_DESIGN", [], []),
    descriptor("test-driven-development", "RED", ["TEST_DESIGN"], []),
    descriptor("test-driven-development", "GREEN", ["RED"], []),
    descriptor("systematic-debugging", "DEBUGGING", ["RED"], []),
    descriptor("requesting-code-review", "REVIEW", ["GREEN"], []),
    descriptor(
      "verification-before-completion",
      "VERIFICATION",
      ["GREEN"],
      ["DEBUGGING", "REVIEW"],
    ),
  ]);

const CAPABILITIES: readonly BuiltInSuperpowersCapability[] = Object.freeze([
  "brainstorming",
  "test-driven-development",
  "systematic-debugging",
  "requesting-code-review",
  "verification-before-completion",
]);

const PHASES: readonly SuperpowersPhaseName[] = Object.freeze([
  "BRAINSTORMING",
  "TEST_DESIGN",
  "RED",
  "GREEN",
  "DEBUGGING",
  "REVIEW",
  "VERIFICATION",
]);

function validateSemantics(semantics: readonly BuiltInSuperpowersSemanticDescriptor[]): void {
  if (semantics.length !== PHASES.length) throw new TypeError("incomplete built-in semantics");
  const seen = new Set<SuperpowersPhaseName>();
  for (const semantic of semantics) {
    if (
      semantic.schema_version !== "built-in-superpowers-semantic.v1" ||
      semantic.version.length === 0 ||
      !CAPABILITIES.includes(semantic.capability) ||
      !PHASES.includes(semantic.phase) ||
      seen.has(semantic.phase) ||
      !Number.isSafeInteger(semantic.context.max_total_input_bytes) ||
      semantic.context.max_total_input_bytes < 0 ||
      semantic.context.assembler_version !== "skill-context.v1" ||
      !Number.isSafeInteger(semantic.context.conservative_bytes_per_token) ||
      semantic.context.conservative_bytes_per_token <= 0 ||
      semantic.completion.success_status !== "COMPLETED" ||
      semantic.completion.success_output !== "HASHED" ||
      semantic.completion.unsuccessful_output !== "EMPTY" ||
      (semantic.completion.approval !== "NONE" && semantic.completion.approval !== "REQUIRED")
    ) {
      throw new TypeError("invalid built-in semantics");
    }
    seen.add(semantic.phase);
    const predecessors = [
      ...semantic.predecessors.required,
      ...semantic.predecessors.conditional_requested,
    ];
    if (
      predecessors.some((phase) => !PHASES.includes(phase) || phase === semantic.phase) ||
      new Set(predecessors).size !== predecessors.length
    ) {
      throw new TypeError("invalid built-in predecessor semantics");
    }
  }
}

function canonicalPolicy(
  semantics: readonly BuiltInSuperpowersSemanticDescriptor[],
): BuiltInSuperpowersPolicy {
  const phases = Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      Object.freeze(
        semantics
          .filter((semantic) => semantic.capability === capability)
          .map((semantic) => semantic.phase),
      ),
    ]),
  ) as Record<BuiltInSuperpowersCapability, readonly SuperpowersPhaseName[]>;
  return Object.freeze(phases);
}

export function compileBuiltInSuperpowersSemantics(
  semantics: readonly BuiltInSuperpowersSemanticDescriptor[],
): CompiledBuiltInSuperpowersSemantics {
  const normalized = Object.freeze(
    semantics.map(
      (semantic) =>
        deepFreezeJson({
          schema_version: semantic.schema_version,
          capability: semantic.capability,
          phase: semantic.phase,
          version: semantic.version,
          predecessors: {
            required: [...semantic.predecessors.required],
            conditional_requested: [...semantic.predecessors.conditional_requested],
          },
          context: {
            assembler_version: semantic.context.assembler_version,
            max_total_input_bytes: semantic.context.max_total_input_bytes,
            conservative_bytes_per_token: semantic.context.conservative_bytes_per_token,
          },
          completion: {
            success_status: semantic.completion.success_status,
            success_output: semantic.completion.success_output,
            unsuccessful_output: semantic.completion.unsuccessful_output,
            approval: semantic.completion.approval,
          },
        }) as unknown as BuiltInSuperpowersSemanticDescriptor,
    ),
  );
  validateSemantics(normalized);
  const policy = canonicalPolicy(normalized);
  const policyHash = sha256({
    schema_version: "built-in-superpowers-policy.v1",
    capability_phases: policy,
    semantic_descriptors: normalized,
  });
  const handlers = Object.freeze(
    normalized.map((semantic) => {
      const hashable = {
        schema_version: "built-in-superpowers-handler.v1",
        phase: semantic.phase,
        version: semantic.version,
        policy_hash: policyHash,
        semantic,
      };
      return Object.freeze({
        capability: semantic.capability,
        phase: semantic.phase,
        version: semantic.version,
        policy_hash: policyHash,
        required_predecessors: semantic.predecessors.required,
        conditional_requested_predecessors: semantic.predecessors.conditional_requested,
        semantic,
        hash: sha256(hashable),
      });
    }),
  );
  return Object.freeze({
    policy,
    policy_hash: policyHash,
    handlers,
  });
}

const COMPILED = compileBuiltInSuperpowersSemantics(BUILTIN_SUPERPOWERS_SEMANTICS);

export const BUILTIN_SUPERPOWERS_POLICY = COMPILED.policy;
export const BUILTIN_SUPERPOWERS_HANDLERS = COMPILED.handlers;

export function hashBuiltInPhasePolicy(
  policy: BuiltInSuperpowersPolicy = BUILTIN_SUPERPOWERS_POLICY,
): `sha256:${string}` {
  if (policy === BUILTIN_SUPERPOWERS_POLICY) return COMPILED.policy_hash;
  return sha256({
    schema_version: "built-in-superpowers-policy.v1",
    capability_phases: policy,
    semantic_descriptors: BUILTIN_SUPERPOWERS_SEMANTICS,
  });
}

export function builtInSuperpowersHandler(
  phase: SuperpowersPhaseName,
  compiled: CompiledBuiltInSuperpowersSemantics = COMPILED,
): BuiltInSuperpowersHandler {
  const handler = compiled.handlers.find((candidate) => candidate.phase === phase);
  if (handler === undefined) throw new TypeError("unknown built-in Superpowers phase");
  return handler;
}

export function requiredBuiltInPhasePredecessors(
  phase: SuperpowersPhaseName,
  requestedPhases: readonly SuperpowersPhaseName[],
  compiled: CompiledBuiltInSuperpowersSemantics = COMPILED,
): readonly SuperpowersPhaseName[] {
  const semantic = builtInSuperpowersHandler(phase, compiled).semantic;
  const requested = new Set(requestedPhases);
  return Object.freeze([
    ...semantic.predecessors.required,
    ...semantic.predecessors.conditional_requested.filter((candidate) => requested.has(candidate)),
  ]);
}

export function builtInPhaseContextBudget(
  phase: SuperpowersPhaseName,
  inputBytes: number,
  compiled: CompiledBuiltInSuperpowersSemantics = COMPILED,
): Readonly<{ max_bytes: number; max_tokens: number }> {
  const context = builtInSuperpowersHandler(phase, compiled).semantic.context;
  const maxBytes = context.max_total_input_bytes - inputBytes;
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0 || maxBytes < 0) {
    throw new RangeError("phase input exceeds semantic context budget");
  }
  return Object.freeze({
    max_bytes: maxBytes,
    max_tokens: Math.ceil(maxBytes / context.conservative_bytes_per_token),
  });
}
