# TOSS CLI v2.2.0 Compatibility

## Scope

This document maps the `@toss-software/cli` v2.2.0 control-plane contract to Runtime Contract Protocol v1. TOSS CLI owns governance artifacts, policy selection, approval/acceptance, and project-state mutation. TOSS Agent Runtime validates exact references, executes only negotiated work, and returns execution evidence.

The integration is fail-closed. An unknown protocol major, unknown schema version, missing exact reference, or unadvertised capability stops dispatch. Additive capability values require negotiation before use.

## Dispatch mapping

| Runtime request field         | TOSS CLI v2.2.0 source/meaning                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `protocol_version`            | CLI/runtime compatibility selection; send `runtime-contract.v1` only after discovery                |
| `schema_version`              | Exact request encoder; `execution-request.v1`                                                       |
| `document_type`               | Fixed dispatch kind `execution-request`                                                             |
| `request_id`                  | CLI-created idempotent dispatch correlation ID                                                      |
| `run_id`                      | CLI-created identity for journal/result reconciliation                                              |
| `created_at`                  | UTC dispatch creation time                                                                          |
| `deadline`                    | Effective policy/budget deadline, later than creation                                               |
| `task_contract`               | Exact accepted Task Contract artifact ID, revision, hash, and optional repository-relative location |
| `input_artifacts`             | Exact ACP analysis/context references selected by the Task Contract                                 |
| `agent.definition`            | Exact approved Agent Definition reference                                                           |
| `agent.role`                  | Role selected by the Task Contract/orchestration policy                                             |
| `model.logical_class`         | Governed logical model class; never an unchecked raw provider override                              |
| `model.required_capabilities` | Capabilities derived from the task and output requirements                                          |
| `superpowers.required`        | Required workflow capabilities derived from agent/task policy                                       |
| `mcp.profile`                 | Exact approved MCP profile reference                                                                |
| `budget.max_input_tokens`     | Effective input-token ceiling                                                                       |
| `budget.max_output_tokens`    | Effective output-token ceiling                                                                      |
| `budget.max_cost_microusd`    | Effective cost ceiling converted to integer micro-USD                                               |
| `budget.max_duration_ms`      | Effective wall-clock ceiling                                                                        |
| `budget.max_turns`            | Effective agent-turn ceiling                                                                        |
| `review_policy`               | Exact approved Review Policy reference                                                              |
| `output.schema`               | Exact required output artifact schema reference                                                     |
| `trace.trace_id`              | End-to-end CLI correlation trace ID                                                                 |
| `trace.span_id`               | Dispatch span ID                                                                                    |
| `trace.trace_flags`           | W3C-compatible trace flags                                                                          |
| `trace.trace_state`           | Optional governed trace state                                                                       |

CLI MUST resolve policy precedence before constructing the request. The runtime MUST NOT accept a request field as authority to alter the referenced artifacts or expand filesystem, tool, egress, secret, approval, or acceptance scope.

The runtime persists state in `run-journal-entry.v1` before exposing a new
revision. CLI resume, retry, approval, cancellation, and reconciliation calls
must present the exact observed journal revision and entry hash plus a stable
command identity. Exact duplicate input replays the published entry; changed
input under the same identity fails closed. CLI must reconcile an unresolved
side-effect intent and must not request blind provider/tool repetition.

## Journal consumption mapping

| Runtime event field                 | TOSS CLI v2.2.0 handling                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `run_id`, `request_hash`            | Correlate the event to the exact dispatch                                                          |
| `sequence`, `run_revision`          | Enforce contiguous append/reconciliation                                                           |
| `previous_event_hash`, `event_hash` | Verify the tamper-evident journal link                                                             |
| `event_type`, `timestamp`           | Update observed execution state and timeline under the transition policy                           |
| `producer`                          | Record the exact runtime/delegate origin without granting authority                                |
| `trace`                             | Continue diagnostics correlation                                                                   |
| `input_reference`                   | Attribute work to an exact governed input                                                          |
| `payload`                           | Persist safe execution evidence; never apply it as project truth without validation and acceptance |

## Result mapping

| Runtime result field        | TOSS CLI v2.2.0 destination/meaning                                                 |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `protocol_version`          | Must remain `runtime-contract.v1`                                                   |
| `schema_version`            | Select exact `execution-result.v1` decoder                                          |
| `document_type`             | Fixed terminal kind `execution-result`                                              |
| `run_id`                    | Locate the matching runtime run                                                     |
| `request_hash`              | Prove the result belongs to the exact request bytes                                 |
| `journal_head.sequence`     | Expected last journal position                                                      |
| `journal_head.run_revision` | Expected last optimistic revision                                                   |
| `journal_head.event_hash`   | Expected last journal content hash                                                  |
| `status`                    | Observed runtime terminal status; not automatic task acceptance                     |
| `finished_at`               | Terminal execution timestamp                                                        |
| `outputs`                   | Candidate output artifact references for schema/policy/review/acceptance validation |
| `error.code`                | Stable machine-readable runtime failure code                                        |
| `error.category`            | CLI retry/escalation classification input                                           |
| `error.retryable`           | Runtime retry hint, still bounded by CLI policy and budget                          |
| `error.safe_message`        | Operator-safe diagnostic text                                                       |
| `error.metadata`            | Optional producer-allowlisted and structurally redacted evidence                    |
| `usage.input_tokens`        | Usage/budget accounting input                                                       |
| `usage.output_tokens`       | Usage/budget accounting output                                                      |
| `usage.cost_microusd`       | Nullable provider-normalized cost accounting                                        |
| `usage.duration_ms`         | Duration accounting                                                                 |
| `usage.turns`               | Turn accounting                                                                     |
| `evidence`                  | Exact evidence artifact references retained for audit/review                        |
| `trace`                     | Complete end-to-end correlation                                                     |

TOSS CLI validates the complete request/event/result chain before consuming any output. It then validates output schemas and policy, runs required review, and records an explicit acceptance/rejection decision. A `COMPLETED` runtime result does not imply accepted governance state.

## Capability mapping

TOSS CLI queries `runtime-capabilities.v1` before dispatch and checks:

- supported protocol and exact request schema;
- logical model class and every required model capability;
- required Superpowers capabilities and Agent Skills host version;
- MCP transport and approved MCP profile support;
- sequential worker-reviewer topology when review is required;
- provider/routing/skills/MCP/agent-loop/review/evidence feature state.

Unknown major versions fail closed. Unknown exact schema versions fail closed. Newly added model classes, transports, skills, topologies, and feature values are additive declarations, but are usable only after explicit negotiation. The runtime must not infer that an omitted requirement is optional, and the CLI must not infer that an omitted capability exists.

Feature availability and supporting resources are checked in both directions. For example, an available provider feature without a provider transport, or an available skill feature without an Agent Skills host and Superpowers capability, fails before dispatch. Provider transports map to provider availability independently of routing; model classes map to routing availability.

## Agent Skills and Superpowers mapping

CLI policy remains the authority for the allowed and required Superpowers
capabilities. The runtime performs metadata-only discovery from audited bundled
packages and explicit private per-user skill roots; it never auto-discovers
project-local `.agents/skills`. CLI selects or permits one exact descriptor,
version, source identity, package hash, and catalog root. Only that exact
post-selection identity may load full `SKILL.md` and declared resources under
canonical path containment. Skill bodies remain untrusted content and skill
scripts are never executed in v1.0.0, including development.

If a required capability has no exact allowed package, the runtime returns
`BLOCKED_SUPERPOWERS_MISSING`; the CLI must not treat a model imitation as the
missing phase. A brainstorming approval is a durable `APPROVAL_PENDING` run,
not text in the transcript. CLI sends the human decision through the private
same-user local socket with exact journal, phase, skill, snapshot, approval hash,
and UUID operation binding, and reconciles stale state before retry. Exact
replay returns the original decision after restart.

CLI validates `skill-execution-evidence.v1` before retaining it. The compact
`journal_path` must reach the advertised exact head/state; catalog roots,
snapshots, phase attempts, context accounting, approvals, and terminal code
must be complete and hash-consistent. The CLI pins the evidence handoff or
document hash as origin evidence and still applies its independent policy,
review, output-schema, and acceptance decisions.

## Error and process mapping

CLI calls that use JSON mode receive one `command-result.v1` object. Runtime exit codes map to CLI behavior as follows:

| Exit | Meaning                 | CLI behavior                                          |
| ---: | ----------------------- | ----------------------------------------------------- |
|  `0` | Success                 | Continue with schema/chain/policy validation          |
|  `2` | Usage                   | Correct invocation; do not retry automatically        |
|  `3` | Invalid input           | Correct source artifact or encoder                    |
|  `4` | Policy denied/blocked   | Escalate according to policy                          |
|  `5` | Validation              | Reject the artifact/result                            |
|  `6` | Conflict/stale revision | Reconcile exact revision before retry                 |
| `69` | Capability unavailable  | Renegotiate or select another runtime                 |
| `70` | Internal failure        | Preserve safe evidence and apply bounded retry policy |

Secret values are resolved outside the protocol. TOSS CLI v2.2.0 must send only approved secret references and must not serialize resolved values into requests, logs, results, evidence, or error metadata. Generic JSON validation cannot classify arbitrary string content; the producing boundary must apply field allowlists, sensitivity tags, and structural redaction before hashing or persistence.
