# Agent Definition Registry and Provenance-Aware Context Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an immutable private agent-definition registry and a deterministic provenance-aware context compiler that preserve control-plane authority and provide exact replay inputs for Issues #8–#10.

**Architecture:** Store canonical prompt/definition objects once by content hash and record activation/retirement in an append-only private lifecycle registry. Keep request authority matching and context compilation pure: callers resolve exact artifact bytes, the compiler verifies every reference, separates trusted and untrusted segments structurally, applies a conservative deterministic byte/token budget, and emits one hash-bound `compiled-context.v1` document.

**Tech Stack:** TypeScript 6 ESM, Node.js 22.23.1 and 24 on macOS, JSON Schema 2020-12, Ajv 8, Vitest 4, existing canonical JSON/SHA-256 and private-filesystem patterns, npm exact package allowlist.

**Spec:** `docs/superpowers/specs/2026-08-21-agent-definition-context-design.md`

## Global Constraints

- v1.0.0 supports macOS only; Node.js support is `>=22.23.0 <25`.
- TOSS CLI/control-plane artifacts are the only source of agent, task, approval, and acceptance authority.
- Repository, web, provider, model, skill, and tool content is always untrusted content and never becomes an instruction or authority segment.
- Issue #7 performs no provider, Agent Skill, Superpowers, MCP, tool, review, or agent-loop execution.
- Every JSON document is closed, bounded, canonical, hash-bound, and returned as a deeply frozen plain value.
- Every filesystem mutation uses current-user private ownership/modes, no-follow held descriptors, exact bigint identity checks, file sync, parent-directory sync, and no-overwrite publication.
- Agent/prompt objects and lifecycle entries are immutable; old exact revisions remain available only for run resume.
- Context uses one UTF-8 byte as one conservative token; trusted control segments are never truncated; only the last eligible untrusted segment may be prefix-truncated at a Unicode scalar boundary.
- Do not add runtime dependencies or expose filesystem helpers, claims, coordinators, fixture builders, or raw Ajv validators.
- Run focused tests on exact Node 22.23.1. Before acceptance, run full `npm run verify` and production audit on exact Node 22.23.1 and Node 24.19.0.
- Stage only the files named by the current task; never use broad git staging.

## File Structure

- `src/agents/types.ts`: immutable public domain types and interfaces only.
- `src/agents/contracts.ts`: parsers, semantic validation, canonical hashing, and JSON limits for four agent/context documents.
- `src/agents/errors.ts`: closed safe runtime agent/context errors.
- `src/agents/authority.ts`: pure execution-request-to-definition narrowing checks.
- `src/agents/private-store.ts`: private object/history/claim durability primitives; not exported publicly.
- `src/agents/registry.ts`: lifecycle state, replay, recovery, and public registry factory.
- `src/agents/context.ts`: artifact resolution validation, segment construction, budgeting, truncation, and compilation.
- `src/agents/index.ts`: narrow public module exports.
- `contracts/runtime/{prompt-template,agent-definition,agent-registry-entry,compiled-context}.v1.schema.json`: closed protocol schemas.
- `test/agent-{contracts,authority,private-store,registry,context,integration}.test.ts`: focused behavior and fault-injection suites.

---

### Task 1: Closed Agent and Context Contracts

**Files:**

- Create: `contracts/runtime/prompt-template.v1.schema.json`
- Create: `contracts/runtime/agent-definition.v1.schema.json`
- Create: `contracts/runtime/agent-registry-entry.v1.schema.json`
- Create: `contracts/runtime/compiled-context.v1.schema.json`
- Create: `src/agents/types.ts`
- Create: `src/agents/contracts.ts`
- Create: `src/agents/errors.ts`
- Modify: `src/agents/index.ts`
- Test: `test/agent-contracts.test.ts`

**Interfaces:**

- Consumes: `RuntimeDocument`, `ArtifactReference`, `RuntimeBudget`, `ValidationResult`, `canonicalJson`, `deepFreezeJson`, `parseJsonBytes`, and `sha256` from `src/protocol`.
- Produces: `PromptTemplateV1`, `AgentDefinitionV1`, `AgentRegistryEntryV1`, `CompiledContextV1`, hashable counterparts, `ResolvedAgentBundle`, `RuntimeAgentError`, four parse functions, and four hash functions.

- [ ] **Step 1: Write closed-contract RED tests**

Create fixtures in the test itself with these exact top-level shapes and assert valid parsing, canonical hashes, deep freeze, unknown-field rejection, duplicate-key rejection, size/member bounds, bad hash rejection, and unsorted/duplicate set rejection:

```ts
const prompt: PromptTemplateV1 = {
  protocol_version: "runtime-contract.v1",
  schema_version: "prompt-template.v1",
  document_type: "prompt-template",
  template_id: TEMPLATE_ID,
  revision: 1,
  instruction_blocks: [{ block_id: "role", content: "Act within the task contract." }],
  document_hash: ZERO_HASH,
};

const definition: AgentDefinitionV1 = {
  protocol_version: "runtime-contract.v1",
  schema_version: "agent-definition.v1",
  document_type: "agent-definition",
  agent_id: AGENT_ID,
  revision: 1,
  name: "implementation-worker",
  role: "worker",
  prompt_template: ref("prompt-template", TEMPLATE_ID, 1, promptHash),
  task_contracts: [ref("task-contract", TASK_ID, 3, TASK_HASH)],
  model: {
    logical_class: "balanced-code",
    required_capabilities: ["text"],
    allowed_capabilities: ["json-schema", "text", "tools"],
  },
  superpowers: {
    required: ["test-driven-development"],
    allowed: ["test-driven-development", "verification-before-completion"],
  },
  mcp_profiles: [ref("mcp-profile", MCP_ID, 2, MCP_HASH)],
  budget_class: "standard",
  budget_ceiling: {
    max_input_tokens: 8000,
    max_output_tokens: 4000,
    max_cost_microusd: 500000,
    max_duration_ms: 600000,
    max_turns: 8,
  },
  output_schemas: [ref("output-schema", OUTPUT_ID, 4, OUTPUT_HASH)],
  context_policy: {
    truncation: "utf8-prefix.v1",
    max_untrusted_bytes: 4096,
    inputs: [{ document_type: "source-artifact", priority: 10, max_bytes: 2048 }],
  },
  document_hash: ZERO_HASH,
};
```

- [ ] **Step 2: Run the RED contract suite**

Run:

```bash
npx --yes --package=node@22.23.1 --package=npm@11.18.0 --call 'npx vitest run test/agent-contracts.test.ts'
```

Expected: FAIL because the schemas, types, parsers, and hashes do not exist.

- [ ] **Step 3: Add exact domain types and safe error table**

Define the public types with readonly fields and these exact error codes:

```ts
export type RuntimeAgentErrorCode =
  | "RUNTIME_AGENT_DEFINITION_INVALID"
  | "RUNTIME_AGENT_DEFINITION_UNSUPPORTED"
  | "RUNTIME_AGENT_NOT_FOUND"
  | "RUNTIME_AGENT_STALE_REVISION"
  | "RUNTIME_AGENT_OPERATION_CONFLICT"
  | "RUNTIME_AGENT_REGISTRY_CORRUPT"
  | "RUNTIME_AGENT_PATH_UNSAFE"
  | "RUNTIME_CONTEXT_REFERENCE_MISMATCH"
  | "RUNTIME_CONTEXT_AUTHORITY_MISMATCH"
  | "RUNTIME_CONTEXT_UNSUPPORTED"
  | "RUNTIME_CONTEXT_OVERFLOW"
  | "RUNTIME_CONTEXT_INTEGRITY";

export class RuntimeAgentError extends Error {
  readonly code: RuntimeAgentErrorCode;
  readonly category: RuntimeError["category"];
  readonly retryable: boolean;
  readonly safe_message: string;
}

export interface AgentDefinitionBundle {
  readonly definition: AgentDefinitionV1;
  readonly prompt_template: PromptTemplateV1;
}

export type ResolvedAgentBundle = AgentDefinitionBundle;

export interface AgentRegistration {
  readonly registry_revision: number;
  readonly definition: ArtifactReference;
  readonly prompt_template: ArtifactReference;
  readonly state: "ACTIVE" | "RETIRED";
  readonly entry_hash: `sha256:${string}`;
}
```

Use a closed descriptor table; no constructor accepts arbitrary messages or metadata.

- [ ] **Step 4: Implement four closed schemas and semantic parsers**

Register bounded JSON parsing in `contracts.ts`. Recompute each document hash with only `document_hash` or `entry_hash` omitted. Enforce ASCII-sorted unique capability arrays and artifact-reference arrays, exact document types, definition-required subsets, unique context-policy document types/priorities, registry hash-chain syntax, segment ordering, byte/token arithmetic, and exact prompt binding.

```ts
export function hashAgentDefinition(value: HashableAgentDefinitionV1): `sha256:${string}` {
  return sha256(value, AGENT_DOCUMENT_LIMITS);
}

export function parseAgentDefinition(
  input: string | Uint8Array,
): ValidationResult<AgentDefinitionV1> {
  return parseAndValidateAgentDocument(input, validateAgentDefinition, validateDefinitionSemantics);
}
```

- [ ] **Step 5: Run focused contracts, typecheck, and scoped hygiene**

Run:

```bash
npx --yes --package=node@22.23.1 --package=npm@11.18.0 --call 'npx vitest run test/agent-contracts.test.ts && npm run typecheck'
npx eslint src/agents/types.ts src/agents/contracts.ts src/agents/errors.ts src/agents/index.ts test/agent-contracts.test.ts
npx prettier --check contracts/runtime/prompt-template.v1.schema.json contracts/runtime/agent-definition.v1.schema.json contracts/runtime/agent-registry-entry.v1.schema.json contracts/runtime/compiled-context.v1.schema.json src/agents/types.ts src/agents/contracts.ts src/agents/errors.ts src/agents/index.ts test/agent-contracts.test.ts
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add -- contracts/runtime/prompt-template.v1.schema.json contracts/runtime/agent-definition.v1.schema.json contracts/runtime/agent-registry-entry.v1.schema.json contracts/runtime/compiled-context.v1.schema.json src/agents/types.ts src/agents/contracts.ts src/agents/errors.ts src/agents/index.ts test/agent-contracts.test.ts
git commit -m "feat: define immutable agent context contracts"
```

### Task 2: Pure Request Authority Matching

**Files:**

- Create: `src/agents/authority.ts`
- Modify: `src/agents/index.ts`
- Test: `test/agent-authority.test.ts`

**Interfaces:**

- Consumes: `ExecutionRequestV1`, `AgentDefinitionV1`, `ArtifactReference`, and `RuntimeAgentError`.
- Produces: `matchAgentAuthority(request, definition): EffectiveAgentAuthority` and frozen `EffectiveAgentAuthority`.

- [ ] **Step 1: Write the cross-product RED matrix**

Build one valid request/definition pair, then table-test role, definition reference, Task Contract, logical class, missing required model capability, extra disallowed model capability, missing/extra Superpowers capability, MCP profile, every five-dimensional budget ceiling, and output schema. Assert every mismatch throws only `RUNTIME_CONTEXT_AUTHORITY_MISMATCH` before a resolver is called.

```ts
expect(() =>
  matchAgentAuthority(request({ agent: { role: "reviewer" } }), definition),
).toThrowError(expect.objectContaining({ code: "RUNTIME_CONTEXT_AUTHORITY_MISMATCH" }));
```

- [ ] **Step 2: Run the RED authority suite**

Run the exact Node 22 command for `test/agent-authority.test.ts`; expect missing-module/function failure.

- [ ] **Step 3: Implement narrowing-only matching**

Use exact reference equality over `document_type`, `artifact_id`, `revision`, and `hash`; ignore optional location. Sort/copy capability sets before subset checks and return only the effective authority view:

```ts
export interface EffectiveAgentAuthority {
  readonly definition: ArtifactReference;
  readonly role: string;
  readonly task_contract: ArtifactReference;
  readonly logical_class: string;
  readonly model_capabilities: readonly string[];
  readonly superpowers_capabilities: readonly string[];
  readonly mcp_profile: ArtifactReference;
  readonly budget: RuntimeBudget;
  readonly output_schema: ArtifactReference;
}
```

Deep-freeze the result and never mutate request/definition arrays.

- [ ] **Step 4: Verify and commit Task 2**

Run authority + contract tests, typecheck, scoped lint/Prettier, and diff check. Commit only the three named files:

```bash
git add -- src/agents/authority.ts src/agents/index.ts test/agent-authority.test.ts
git commit -m "feat: bind requests to agent authority"
```

### Task 3: Private Content-Addressed Object Store

**Files:**

- Create: `src/agents/private-store.ts`
- Test: `test/agent-private-store.test.ts`

**Interfaces:**

- Consumes: canonical definition/template bytes and `RuntimeAgentError`.
- Produces internal `createPrivateAgentStore(options): PrivateAgentStore`, `PrivateObjectSnapshot`, and fault-injection hooks used by Task 4.

- [ ] **Step 1: Write filesystem and crash-boundary RED tests**

Use real temporary directories under `/tmp`. Cover `0700` roots, `0600` objects, current ownership, SHA-derived internal paths, no caller path, no overwrite, exact existing-object replay, changed bytes under the same hash, symlink/file/directory/hard-link replacement, ancestry mutation, object growth, bounded reads, restrictive/permissive umask, and injected failures before/after file sync, link publication, parent sync, and staging cleanup.

```ts
const store = createPrivateAgentStore({ statePath, operationHooks });
await store.ensureRoots();
await store.publishObject(hash, canonicalBytes);
expect(await store.readObject(hash)).toEqual(canonicalBytes);
expect(statSync(objectPath).mode & 0o777).toBe(0o600);
```

- [ ] **Step 2: Run the RED private-store suite**

Run exact Node 22 Vitest; expect missing module failure.

- [ ] **Step 3: Implement held-descriptor private roots and bounded reads**

Create only internally derived `agents/objects`, `agents/registry`, and `agents/quarantine` roots. Walk absolute path ancestry with no-follow directory descriptors; require exact private mode at and below the runtime state root. Read only after lstat/fstat bigint identity and size checks, then file sync, parent sync, exact byte/identity revalidation.

- [ ] **Step 4: Implement no-overwrite object publication and mutation claim**

Write an operation-owned `0600` stage through a held descriptor, sync/revalidate it, publish using a no-overwrite hard link, sync/revalidate the object directory, and remove only the exact stage identity. A canonical single registry mutation claim must be `0700`, current-user, identity-bound, liveness-checked, bounded to one claim, and recovered only when its owner is proven dead and no service listener exists.

- [ ] **Step 5: Verify fault matrix and commit Task 3**

Run private-store tests repeatedly (`--repeat=3`), contracts, typecheck, scoped lint/Prettier, and diff check. Commit:

```bash
git add -- src/agents/private-store.ts test/agent-private-store.test.ts
git commit -m "feat: persist private agent objects safely"
```

### Task 4: Immutable Lifecycle Registry and Recovery

**Files:**

- Create: `src/agents/registry.ts`
- Modify: `src/agents/types.ts`
- Modify: `src/agents/index.ts`
- Test: `test/agent-registry.test.ts`

**Interfaces:**

- Consumes: Task 1 parsers/hashes, Task 3 `PrivateAgentStore`, canonical clock/ID inputs.
- Produces: `createAgentRegistry(options): AgentRegistry` with `recover`, `publish`, `retire`, `resolveForExecution`, `resolveForResume`, `list`, `stopIntake`, and `flush`.

- [ ] **Step 1: Write lifecycle/idempotency RED tests**

Cover first publish, same operation replay without history growth, operation-ID conflict, activating revision 2, stale revision 1 for new execution, revision 1 resume, retirement, no active revision, reused `(agent_id, revision)` with different bytes, wrong template binding, list without bodies, stop intake, bounded flush, and immutable/deep-frozen returns.

```ts
const first = await registry.publish({ definition: v1, prompt_template: promptV1 }, OPERATION_ID);
const replay = await registry.publish({ definition: v1, prompt_template: promptV1 }, OPERATION_ID);
expect(replay).toEqual(first);
expect(await registry.resolveForExecution(refV1)).toEqual(first.bundle);
```

- [ ] **Step 2: Write recovery/history RED tests**

Cover canonical append-only hash chain, exact operation-result binding, partial tail quarantine, invalid interior line, duplicate revision, multiple active heads, missing/tampered object, reordered entry, random operation hash, file/directory sync failure then retry, concurrent public instances through canonical path aliases, live/dead/unknown claim owner, and shutdown during accepted mutation.

- [ ] **Step 3: Implement registry state reconstruction and transitions**

Use these public signatures exactly:

```ts
export interface AgentRegistry {
  recover(): Promise<void>;
  publish(bundle: AgentDefinitionBundle, operationId: string): Promise<AgentRegistration>;
  retire(definition: ArtifactReference, operationId: string): Promise<AgentRegistration>;
  resolveForExecution(definition: ArtifactReference): Promise<ResolvedAgentBundle>;
  resolveForResume(definition: ArtifactReference): Promise<ResolvedAgentBundle>;
  list(): Promise<readonly AgentRegistration[]>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}
```

Serialize mutations on a process-wide coordinator keyed by canonical real state identity. Persist object barriers before lifecycle visibility. Persist exact operation outcomes separately so replay never appends a no-op lifecycle revision.

- [ ] **Step 4: Implement partial-tail recovery and fail-closed validation**

Quarantine only a partial final fragment after publishing and syncing the valid prefix. Verify every entry/object/operation link before exposing state. Interior corruption, ambiguity, unexpected entries, active-state contradiction, or object mismatch throws `RUNTIME_AGENT_REGISTRY_CORRUPT` without cleanup of unowned candidates.

- [ ] **Step 5: Verify and commit Task 4**

Run registry/private-store/contracts tests, typecheck, scoped hygiene, and diff check. Commit only the named files:

```bash
git add -- src/agents/registry.ts src/agents/types.ts src/agents/index.ts test/agent-registry.test.ts
git commit -m "feat: register immutable agent revisions"
```

### Task 5: Provenance-Aware Context Compiler Core

**Files:**

- Create: `src/agents/context.ts`
- Modify: `src/agents/types.ts`
- Modify: `src/agents/index.ts`
- Test: `test/agent-context.test.ts`

**Interfaces:**

- Consumes: `ExecutionRequestV1`, `ResolvedAgentBundle`, `EffectiveAgentAuthority`, Task 1 compiled-context types/hashes.
- Produces: `ResolvedContextArtifact`, `ContextArtifactResolver`, `CompileAgentContextInput`, and `compileAgentContext(input): Promise<CompiledContextV1>`.

- [ ] **Step 1: Write resolver/reference/trust RED tests**

Cover exact hash/revision/type matching, canonical JSON versus UTF-8 text, malformed UTF-8, unsupported media, secret sensitivity, oversized source, duplicate reference, same reference/different bytes, resolver object mutation, absolute-path leakage, and an accessor/proxy value. Assert no compiled output and safe fixed errors.

```ts
export interface ResolvedContextArtifact {
  readonly reference: ArtifactReference;
  readonly media_type: "application/json" | "text/plain";
  readonly sensitivity: "public" | "internal" | "confidential" | "secret";
  readonly origin: "control-plane" | "repository" | "web" | "model" | "skill" | "tool";
  readonly bytes: Uint8Array;
}
```

- [ ] **Step 2: Write precedence/injection RED tests**

Supply repository text containing fake system messages, approvals, role changes, tool grants, secret-like directives, XML/Markdown delimiters, and prompt-template syntax. Assert trusted runtime, Task Contract, prompt blocks, and output contract remain separate immutable segments before every untrusted segment; untrusted text never changes role/authority fields.

- [ ] **Step 3: Implement exact resolver projection and segment construction**

Resolve each unique reference once, copy bytes immediately, verify media/sensitivity/origin, recompute the reference hash, canonicalize JSON documents, and decode text with fatal UTF-8. Build trusted segments first and untrusted segments sorted by `(priority, document_type, artifact_id, revision, hash)` using bytewise ASCII order.

```ts
export async function compileAgentContext(
  input: CompileAgentContextInput,
): Promise<CompiledContextV1> {
  const authority = matchAgentAuthority(input.request, input.bundle.definition);
  const resolved = await resolveExactInputs(input, authority);
  return buildCompiledContext(input.request_hash, authority, input.bundle, resolved);
}
```

- [ ] **Step 4: Bind every segment and the final document hash**

Derive segment IDs from kind/source/included hash, record original/included content hashes and counts, include the fixed runtime-policy revision/hash, reject absolute paths and unsafe metadata, compute `document_hash`, and deep-freeze the complete result.

- [ ] **Step 5: Verify and commit Task 5**

Run context + authority + contracts tests, typecheck, scoped lint/Prettier, and diff check. Commit:

```bash
git add -- src/agents/context.ts src/agents/types.ts src/agents/index.ts test/agent-context.test.ts
git commit -m "feat: compile provenance-aware agent context"
```

### Task 6: Deterministic Budgeting and Unicode-Safe Truncation

**Files:**

- Modify: `src/agents/context.ts`
- Test: `test/agent-context.test.ts`

**Interfaces:**

- Consumes: Task 5 normalized segments and definition context policy.
- Produces exact byte/token accounting and `input-budget` / `definition-ceiling` truncation records in `CompiledContextV1`.

- [ ] **Step 1: Write exact-boundary RED tests**

Test trusted exact fit, trusted one-byte overflow, request ceiling below definition, definition ceiling below request, per-document ceiling, total-untrusted ceiling, 0/1/many omitted artifacts, and deterministic priority ordering. Verify one byte equals one conservative token and arithmetic is safe-integer bounded.

- [ ] **Step 2: Write Unicode and permutation RED tests**

Use ASCII, combining marks, Turkish characters, emoji, and four-byte scalars. For every byte boundary, assert the included prefix decodes with fatal UTF-8, only the final eligible untrusted segment truncates, later segments are omitted, and 100 input permutations produce identical canonical bytes/hash.

- [ ] **Step 3: Implement pure budget allocation**

Count the exact UTF-8 bytes of emitted content plus fixed framing bytes. Reject trusted overflow. Consume untrusted policy ceilings in normalized order; find the largest valid scalar-boundary prefix within the remaining byte budget. Emit a fixed trusted truncation notice only when truncation/omission occurs and include its framing cost before allocating untrusted bytes.

- [ ] **Step 4: Add overflow/adversarial arithmetic tests**

Exercise maximum schema bounds, safe-integer edges, large multibyte input, empty content, repeated identities, and accessor/prototype pollution inputs. Assert deterministic `RUNTIME_CONTEXT_OVERFLOW`, `RUNTIME_CONTEXT_UNSUPPORTED`, or `RUNTIME_CONTEXT_INTEGRITY` without allocation beyond declared limits.

- [ ] **Step 5: Verify and commit Task 6**

Run the context suite with three repeats, all agent-focused tests, typecheck, lint, Prettier, and diff check. Commit only context source/test:

```bash
git add -- src/agents/context.ts test/agent-context.test.ts
git commit -m "feat: bound deterministic agent context"
```

### Task 7: Revision Replay and Cross-Component Integration

**Files:**

- Create: `test/agent-integration.test.ts`
- Modify: `src/agents/registry.ts`
- Modify: `src/agents/context.ts`
- Modify: `src/agents/types.ts`
- Test: `test/agent-registry.test.ts`
- Test: `test/agent-context.test.ts`

**Interfaces:**

- Consumes: complete registry/compiler public interfaces.
- Produces a proven publish → compile → replace → resume flow and shutdown-safe coordination.

- [ ] **Step 1: Write end-to-end revision RED test**

Publish definition/template v1, compile request v1, publish v2 with changed prompt, compile a new request v2, then resolve v1 for resume and recompile. Assert v1 canonical bytes/hash are identical before/after v2; new execution with v1 is stale; v2 differs only through exact rebound definition/template/context identities.

- [ ] **Step 2: Write concurrent shutdown RED tests**

Delay accepted publish after its file barrier, call `stopIntake()` and `flush(signal)`, and assert flush waits for the accepted mutation while new publish is rejected. Delay compile resolution while retiring the definition; compilation must use its already resolved exact immutable bundle or fail stale before resolution, never mix revisions.

- [ ] **Step 3: Write cross-role injection integration test**

Compile worker and reviewer definitions against the same malicious repository artifact. Assert different trusted role/template segments and hashes, identical untrusted source provenance, no reviewer tool/MCP broadening, and no repository text in trusted segments.

- [ ] **Step 4: Implement the smallest coordination fixes exposed by RED**

Keep exact bundle snapshots immutable at operation start, define one linearization point for active resolution, and ensure flush tracks every accepted mutation promise. Do not add provider, skill, MCP, or journal execution.

- [ ] **Step 5: Verify and commit Task 7**

Run all `test/agent-*.test.ts`, adjacent execution-request/routing suites, typecheck, scoped hygiene, and diff check. Commit exact files:

```bash
git add -- src/agents/registry.ts src/agents/context.ts src/agents/types.ts test/agent-registry.test.ts test/agent-context.test.ts test/agent-integration.test.ts
git commit -m "test: prove immutable agent context replay"
```

### Task 8: Public API, Validator, and Capability Advertisement

**Files:**

- Modify: `src/protocol/validator.ts`
- Modify: `src/protocol/capabilities.ts`
- Modify: `contracts/runtime/runtime-capabilities.v1.schema.json`
- Modify: `src/index.ts`
- Modify: `test/fixtures/protocol/valid/runtime-capabilities.v1.json`
- Modify: `test/protocol-validator.test.ts`
- Modify: `test/execution-chain.test.ts`
- Create: `test/agent-public-api.test.ts`

**Interfaces:**

- Consumes: Task 1–7 public `src/agents/index.ts` exports.
- Produces top-level package exports and truthful support for four schemas while all downstream execution features remain unavailable.

- [ ] **Step 1: Write public/capability RED tests**

Assert top-level imports expose only parsers, hashes, error, registry factory/interface, compiler, and immutable public types. Assert private-store helpers, mutation claims, raw validators, test hooks, and fixture builders are absent. Assert baseline capabilities add exactly four alphabetically placed schema versions but retain empty skill/MCP/topology arrays and unavailable skills/MCP/agent-loop/review/evidence.

- [ ] **Step 2: Run RED validator/public tests**

Run agent public API, protocol validator, execution chain, and documentation integrity tests; expect missing registrations/exports and stale capability fixture failures.

- [ ] **Step 3: Register schemas and narrow exports**

Import/add all four schemas in `createProtocolValidator`, add exact schema IDs to `REGISTERED_SCHEMAS`, update the closed capability schema enum and baseline list, refresh only affected fixtures, and replace `requireAgentRegistry()` with explicit safe exports from `src/agents/index.ts`.

- [ ] **Step 4: Verify no false feature availability**

Add negative tests proving schema support does not make `negotiateRequest()` succeed while skills/MCP/agent loop/review/evidence remain unavailable. Verify deep imports stay blocked by package exports.

- [ ] **Step 5: Verify and commit Task 8**

Run public/validator/capabilities/execution-chain tests, all agent tests, typecheck, lint, Prettier, and diff check. Commit the eight named files plus the new test:

```bash
git add -- src/protocol/validator.ts src/protocol/capabilities.ts contracts/runtime/runtime-capabilities.v1.schema.json src/index.ts test/fixtures/protocol/valid/runtime-capabilities.v1.json test/protocol-validator.test.ts test/execution-chain.test.ts test/agent-public-api.test.ts
git commit -m "feat: publish agent registry API"
```

### Task 9: Normative Documentation, Examples, and Package Boundary

**Files:**

- Modify: `docs/contracts/runtime-contract-protocol-v1.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `examples/runtime-contract-v1/prompt-template.json`
- Create: `examples/runtime-contract-v1/agent-definition.json`
- Create: `examples/runtime-contract-v1/agent-registry-entry.json`
- Create: `examples/runtime-contract-v1/compiled-context.json`
- Modify: `scripts/package-files.json`
- Modify: `package.json`
- Modify: `test/documentation-integrity.test.ts`
- Modify: `test/package-metadata.test.ts`

**Interfaces:**

- Consumes: public parsers/hashes and the exact accepted integration fixture.
- Produces packaged canonical examples, normative authority/budget/replay text, and an exact real-tarball allowlist.

- [ ] **Step 1: Write documentation/package RED tests**

Require all four examples to parse and hash through the public API; assert exact cross-reference binding. Require normative text for control-plane authority, lifecycle, resume, trust classes, precedence, byte/token accounting, truncation, and downstream exclusions. Inspect real `npm pack --dry-run --json`; fail on missing required files, private agent `.d.ts`/maps, tests, temp objects, registry state, prompts outside examples, or an allowlist mismatch.

- [ ] **Step 2: Run RED docs/package tests**

Run documentation integrity and package metadata tests; expect missing examples/docs/allowlist entries.

- [ ] **Step 3: Add canonical examples and normative docs**

Generate hashes through public functions, then store fixed secret-free canonical JSON. Document that examples are illustrative control-plane artifacts, not writable local configuration. State that Issue #7 advertises schemas only and does not execute skills, tools, providers, or loops.

- [ ] **Step 4: Update exact package allowlist and private exclusions**

Build, run real dry-pack, add required public runtime files/schemas/docs/examples/declarations to `scripts/package-files.json`, and add narrow `package.json` exclusions for private-store declarations/maps if the compiler emits them. Do not weaken the exact allowlist or broadly exclude all source maps.

- [ ] **Step 5: Verify and commit Task 9**

Run docs/package metadata, all agent tests, build, `npm run test:package:contents`, typecheck, lint, Prettier, and diff check. Commit exact paths:

```bash
git add -- docs/contracts/runtime-contract-protocol-v1.md README.md CHANGELOG.md examples/runtime-contract-v1/prompt-template.json examples/runtime-contract-v1/agent-definition.json examples/runtime-contract-v1/agent-registry-entry.json examples/runtime-contract-v1/compiled-context.json scripts/package-files.json package.json test/documentation-integrity.test.ts test/package-metadata.test.ts
git commit -m "docs: publish agent context contract"
```

### Task 10: Acceptance, Adversarial Coverage, and Delivery Evidence

**Files:**

- Modify only when a demonstrated coverage gap requires it: `test/agent-contracts.test.ts`
- Modify only when a demonstrated coverage gap requires it: `test/agent-authority.test.ts`
- Modify only when a demonstrated coverage gap requires it: `test/agent-private-store.test.ts`
- Modify only when a demonstrated coverage gap requires it: `test/agent-registry.test.ts`
- Modify only when a demonstrated coverage gap requires it: `test/agent-context.test.ts`
- Modify only when a demonstrated coverage gap requires it: `test/agent-integration.test.ts`
- Create: `docs/verification/v1-agent-definition-context.md`

**Interfaces:**

- Consumes: the complete accepted branch behavior.
- Produces an acceptance-criteria matrix and exact reproducible verification evidence; no new public behavior.

- [ ] **Step 1: Audit every Issue #7 criterion against an exact test**

Create a matrix in the evidence document mapping: provider-independent identity; ACTIVE Task Contract/capability matching; exact provenance; untrusted authority isolation; deterministic overflow; immutable prompt/definition revision; cross-role injection. Name the exact test file and test title for each row.

- [ ] **Step 2: Run mutation-witness coverage probes**

Temporarily invert one condition at a time for authority subset, active/resume state, source hash, trust class, trusted overflow, Unicode truncation, object identity, operation replay, and final document hash. Run the owning focused test and record that it fails for the intended assertion; restore the source immediately and rerun GREEN. No mutation survives in the diff.

- [ ] **Step 3: Run exact Node 22.23.1 final verification**

```bash
npx --yes --package=node@22.23.1 --package=npm@11.18.0 --call 'node --version && npm --version && npm run verify && npm audit --omit=dev'
```

Record test file/pass/skip counts, package file count/size/integrity, installed-package result, audit result, and the identity of any skip.

- [ ] **Step 4: Run exact Node 24.19.0 final verification**

```bash
npx --yes --package=node@24.19.0 --package=npm@11.18.0 --call 'node --version && npm --version && npm run verify && npm audit --omit=dev'
```

Require the same behavior and exact package contents. A host-only Linux systemd skip is acceptable on macOS only when its exact test identity is recorded; no agent/context test may skip.

- [ ] **Step 5: Verify clean exact-head evidence and commit Task 10**

Run:

```bash
git diff --check
git status --short
git ls-files '*.tgz'
```

Confirm no tarball, registry object, stage, claim, socket, lock, prompt body, temp root, or process remains. Commit only evidence and any test-only coverage additions whose RED witness was recorded:

```bash
git add -- docs/verification/v1-agent-definition-context.md test/agent-contracts.test.ts test/agent-authority.test.ts test/agent-private-store.test.ts test/agent-registry.test.ts test/agent-context.test.ts test/agent-integration.test.ts
git commit -m "test: verify immutable agent context delivery"
```

If no focused test file changed, omit it from the exact `git add --` command.

## Plan Self-Review Checklist

- Tasks 1–2 cover every closed contract, hash, error, and authority-matching requirement.
- Tasks 3–4 cover private immutable storage, lifecycle, idempotency, concurrency, crash recovery, and old-run resolution.
- Tasks 5–6 cover provenance, trust separation, precedence, deterministic ordering, conservative budgeting, Unicode truncation, and final hash identity.
- Task 7 proves revision replacement/resume and cross-role isolation across real components.
- Task 8 exposes only the intended API and advertises schema support without claiming downstream execution availability.
- Task 9 delivers normative docs, examples, and exact package contents.
- Task 10 maps every Issue #7 acceptance criterion to fresh exact-head Node 22/24 evidence.
- Function/type names are consistent across tasks: `AgentRegistry`, `AgentDefinitionBundle`, `ResolvedAgentBundle`, `EffectiveAgentAuthority`, `ContextArtifactResolver`, `CompileAgentContextInput`, `compileAgentContext`.
- No task introduces provider, skill, MCP, tool, review, agent-loop, dynamic-agent, remote-registry, or long-term-memory behavior.
