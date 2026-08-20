export {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  UnavailableCapabilityError,
} from "./version.js";
export {
  createBaselineCapabilities,
  negotiateRequest,
  parseRuntimeCapabilities,
  type Availability,
  type RuntimeCapabilitiesV1,
} from "./protocol/capabilities.js";
export {
  hashExecutionEvent,
  parseExecutionEvent,
  type ExecutionEventType,
  type ExecutionEventV1,
  type HashableExecutionEventV1,
} from "./protocol/event.js";
export {
  assertPlainJson,
  canonicalJson,
  deepFreezeJson,
  DEFAULT_JSON_LIMITS,
  parseJsonBytes,
  sha256,
  type JsonLimits,
  type JsonPrimitive,
  type JsonValue,
} from "./protocol/json.js";
export {
  hashExecutionRequest,
  parseExecutionRequest,
  type ExecutionRequestV1,
} from "./protocol/request.js";
export {
  parseExecutionResult,
  validateExecutionChain,
  type ExecutionResultV1,
  type TerminalStatus,
} from "./protocol/result.js";
export type {
  ArtifactReference,
  ProducerIdentity,
  RuntimeBudget,
  RuntimeDocument,
  RuntimeError,
  TraceContext,
  UsageSummary,
  ValidationFailure,
  ValidationIssue,
  ValidationResult,
  ValidationSuccess,
} from "./protocol/types.js";
export {
  createProtocolValidator,
  type FragmentName,
  type ProtocolValidator,
} from "./protocol/validator.js";
