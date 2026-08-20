# Provider adapter contract and conformance plan

## Goal

Implement one public, provider-neutral request/event/completion boundary for
OpenAI, Anthropic, and Gemini. Provider-specific wire values are untrusted edge
input and must be projected into closed runtime values before they can reach a
journal, result, evidence producer, or caller.

## Scope

- Issue #5 and one dedicated PR.
- Normalized in-memory requests, streamed events, canonical completions,
  capability preflight, cancellation/timeout behavior, health, and stable
  errors.
- OpenAI Responses-style, Anthropic Messages-style, and Gemini
  generate-content-style request/response adapters over an injected bounded
  wire transport.
- Recorded synthetic fixtures and a deterministic fake transport; no live
  credentials, SDK dependency, secret resolution, retry loop, routing, or
  agentgateway network implementation.
- Issue #3 retains authenticated agentgateway transport and tracing. Issue #6
  retains catalog/routing/budget/fallback policy.

## Public contract

Add `provider-event.v1` as a closed runtime schema and public TypeScript union.
Every event has the runtime protocol/schema/document envelope, canonical UUID
event/request identity, provider, model, nonnegative sequence, UTC timestamp,
closed event type, normalized data, and provenance containing only the native
event type plus sorted names of dropped provider-specific fields. Raw native
objects, headers, endpoints, prompts, credentials, stack traces, and response
bodies have no representation.

The closed event data variants are:

- `response-start`: optional safe provider response identity;
- `content-delta`: text, reasoning, or refusal channel plus index and delta;
- `tool-call-delta`: index, canonical call ID, optional safe name, and JSON
  argument fragment;
- `usage`: input/output plus optional cached-input/reasoning token counts;
- `response-completed`: normalized finish reason and optional structured JSON;
- `response-error`: one stable normalized provider error.

The collector requires request/provider/model identity and contiguous sequence,
permits exactly one start and terminal event, rejects post-terminal events,
assembles text/reasoning/refusal/tool fragments deterministically, parses
complete tool arguments as bounded plain JSON, and yields the same frozen
`ProviderCompletion` for streaming and non-streaming adapter paths.

## Request and capability boundary

Define a bounded normalized request with canonical request ID, selected model,
messages containing text/image-reference/tool-result blocks, optional tools,
optional JSON-schema response format, optional reasoning request, sampling
values, and output-token/timeout bounds. Adapter capability descriptors are
frozen and declare tools, JSON schema, vision, reasoning, streaming, and
context/output limits.

Before calling the wire transport, derive required capabilities and reject
unsupported tools, structured output, images, reasoning, streaming, or token
limits with `RUNTIME_PROVIDER_UNSUPPORTED`. Invalid request shapes fail as
`RUNTIME_PROVIDER_INVALID`. No preflight rejection may call the transport.

## Error and lifecycle boundary

Expose stable provider codes for invalid, unsupported, authentication, rate
limit, refusal, timeout, cancelled, transient/unavailable, and internal
failure. Each code fixes category, retryability, and safe message. Provider
status/code classification consumes an allowlisted scalar descriptor only;
unknown objects and SDK errors become safe internal failures. No raw error
message is reflected.

The injected transport receives only a plain JSON request plus an AbortSignal
and timeout. Abort cancellation maps to cancelled, the adapter-owned deadline
maps to timeout, and no automatic retry occurs. `cancel(requestId)` forwards to
the transport without exposing native handles. Health is reduced to a frozen
`healthy|degraded|unavailable` snapshot with no native diagnostics.

## Adapter mapping

- OpenAI: Responses-style input/output items, output-text/refusal deltas,
  function-call argument fragments, response usage/status, and response errors.
- Anthropic: Messages content blocks, text/thinking/tool-use deltas, message
  usage/stop reason, refusal/error forms.
- Gemini: generate-content contents/parts, text/thought/function-call parts,
  usage metadata, finish/block reasons, and errors.

Each adapter maps both `complete()` and `stream()` through the same normalized
event collector. Fixture tests hand-author the expected canonical completion;
they do not generate expectations from production mapping code.

## Files and tests

- Add provider types, errors, contract parser/collector, shared adapter
  lifecycle, and three provider mappers under `src/providers/`.
- Add the provider event schema, manifest entry, protocol validator fragment,
  capability advertisement, public exports, package contents, documentation,
  example/fixture updates, and remove the obsolete unavailable-provider guard.
- Add contract rejection tests, collector invariant tests, capability preflight
  tests, error/lifecycle tests, per-provider streaming/non-streaming recorded
  fixtures, fake transport tests, SDK-object/prototype leakage tests, and public
  package assertions.

## Verification and delivery

1. Capture RED for the missing public provider API/schema and each provider
   fixture.
2. Implement the smallest closed contract and shared collector.
3. Implement adapters one at a time, keeping focused tests green.
4. Run format, lint, strict typecheck, all tests, build, exact package
   acceptance, production audit, docs integrity, and clean-worktree hygiene on
   Node 22.23.1 and Node 24.
5. Push the issue branch and PR. Mark Issue/PR Done when required macOS CI is
   green, then merge into `release/v1.0.0` and update Issue #5 and Epic #16.
