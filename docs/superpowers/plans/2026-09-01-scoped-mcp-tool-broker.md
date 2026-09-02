# Scoped MCP Tool Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a fail-closed MCP tool broker that exposes only profile-, Task Contract-, and role-authorized tools; durably pauses high-impact calls for exact human approval; and executes each logical call at most once through `stdio`, Streamable HTTP, or agentgateway.

**Architecture:** A closed MCP profile registry separates policy from machine-local bindings. One run-scoped virtual session captures a persisted discovery snapshot, then immutable policy, approval, durable execution, transport, normalization, and redaction layers produce a TOSS-owned `tool-result.v1`. The existing run journal remains the authoritative state machine and side-effect ledger; a private tool store preserves prepared calls, approvals, results, and uncertain-effect dispositions across process restarts.

**Tech Stack:** TypeScript ESM, Node.js 24+, JSON Schema 2020-12, Ajv, canonical JSON/SHA-256, `@modelcontextprotocol/client@2.0.0`, `@modelcontextprotocol/server@2.0.0` test fixtures, private filesystem stores, Unix-domain socket control, Vitest, npm package acceptance.

**Spec:** `docs/superpowers/specs/2026-09-01-scoped-mcp-tool-broker-design.md`

## Global Constraints

- Preserve authority order: runtime safety, exact Task Contract, exact agent definition and role, exact MCP profile, live discovery, then untrusted model/server content.
- Profiles are the only authority source. Server annotations may tighten or invalidate a rule; they never create or widen permission.
- Support exactly `tools/list` and `tools/call` over `stdio`, `streamable-http`, and `agentgateway`; reject prompts, resources, roots, sampling, elicitation, legacy HTTP+SSE, and server-initiated capability requests.
- Pin each server to exactly `2025-06-18` or `2026-07-28`; never auto-fallback. Persist the negotiated revision in discovery and result provenance.
- Create one virtual session per `run_id` and exact profile. Never pool MCP clients across runs.
- Serialize discovery and calls per server. Persist a complete bounded discovery snapshot before exposing a model-facing tool.
- Derive model names, descriptions, schemas, authority, operation class, approval policy, identity metadata, and headers locally. Ignore untrusted attempts to override them.
- `reviewer` is runtime-limited to `read-only`; `irreversible` always requires approval; unknown or incoherent operation classes deny.
- Do not persist or expose raw credentials, bearer tokens, native headers, child environments, endpoints, commands, stderr, SDK objects, SDK diagnostics, or unredacted native results.
- Every native call first appends a journal side-effect `INTENT`. A matching durable result may complete an interrupted journal transition without redispatch; a possible effect without a result becomes `UNCERTAIN` and blocks.
- A third-party server may ignore the idempotency `_meta`, so the runtime guarantee is at-most-one broker dispatch, not exactly-once external execution.
- Private tool directories are mode `0700`; regular files are current-user mode `0600`, single-link, no-follow, identity-stable, atomically published, directory-synced, bounded, and quarantined on ambiguous recovery.
- Public values are recursively frozen TOSS-owned types. No public declaration imports an MCP SDK or exposes private-store/test seams.
- Keep package version `0.0.0-development`; Issue #15 owns versioning, release, and protected live-credential smoke.

## File and interface map

The implementation uses these focused units:

- `src/tools/types.ts`: five public document types, profile/binding types, public broker requests/outcomes, transport-neutral internal records.
- `src/tools/contracts.ts`: schema parsers, semantic validation, canonical hashes, JSON Schema compilation, and bounded capture.
- `src/tools/errors.ts`: closed safe tool error table and native-error classification.
- `src/tools/profile.ts`: exact profile/binding registry and artifact-reference projection.
- `src/tools/identity.ts`: closed locally derived `_meta`, correlation headers, call identity, and idempotency key.
- `src/tools/redaction.ts`: JSON-pointer and generic-pattern redaction plus result normalization.
- `src/tools/transports/types.ts`: TOSS-owned adapter boundary and injected process/network/credential seams.
- `src/tools/transports/sdk-client.ts`: the only translation layer that exposes official MCP client operations to adapters.
- `src/tools/transports/stdio.ts`: absolute executable, minimal environment, bounded stderr, lease, cancellation, and reaping policy.
- `src/tools/transports/streamable-http.ts`: origin/DNS policy, fixed fetch, per-request credentials, redirects disabled, and correlation headers.
- `src/tools/transports/agentgateway.ts`: derived route, exact gateway attestation, fresh scoped lease, and fixed correlation.
- `src/tools/discovery.ts`: run-scoped virtual sessions, full pagination, schema equality, collision handling, stale snapshots, and per-server serialization.
- `src/tools/policy.ts`: ordered authority, alias, role, Task Contract, schema, input, secret-field, operation, approval, and limit checks.
- `src/tools/private-store.ts`: append-only prepared-call stages, approvals, normalized results, operation log, recovery, and quarantine.
- `src/tools/approval.ts`: approval request/decision construction, exact resume binding, journal transitions, and replay.
- `src/tools/executor.ts`: durable side-effect intent, one native dispatch, result publication, terminal transition, replay, recovery, and uncertain disposition.
- `src/tools/broker.ts`: public orchestration, capability/health projection, lifecycle, and shutdown ordering.
- `src/tools/index.ts`: safe public exports and factory only.

The closed operation and transport vocabulary is:

```ts
export type McpProtocolRevision = "2025-06-18" | "2026-07-28";
export type McpTransportKind = "stdio" | "streamable-http" | "agentgateway";
export type ToolOperationClass = "read-only" | "reversible-write" | "irreversible";
export type ToolApprovalRule = "required" | "not-required";
export type ToolContentKind = "text" | "image" | "audio" | "resource-link" | "embedded-resource";
export type ToolCallStage = "PREPARED" | "COMPLETED" | "FAILED" | "UNCERTAIN";
export type ToolUncertainDisposition = "NO_EFFECT_CONFIRMED" | "EFFECT_CONFIRMED";
```

The profile/config split is:

```ts
export interface McpProfileV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "mcp-profile.v1";
  readonly document_type: "mcp-profile";
  readonly profile_id: string;
  readonly revision: number;
  readonly limits: McpProfileLimitsV1;
  readonly servers: readonly McpProfileServerRuleV1[];
  readonly document_hash: `sha256:${string}`;
}

export interface McpProfileLimitsV1 {
  readonly discovery_pages_per_server: number;
  readonly tools_per_server: number;
  readonly schema_bytes: number;
  readonly arguments_bytes: number;
  readonly result_bytes: number;
  readonly content_blocks: number;
  readonly content_block_bytes: number;
  readonly structured_output_bytes: number;
  readonly discovery_timeout_ms: number;
  readonly call_timeout_ms: number;
  readonly session_lifetime_ms: number;
}

export interface McpProfileToolRuleV1 {
  readonly alias: string;
  readonly description: string;
  readonly native_name: string;
  readonly allowed_roles: readonly ("worker" | "reviewer")[];
  readonly task_contracts: readonly TaskContractReference[];
  readonly input_schema: JsonValue;
  readonly input_schema_hash: `sha256:${string}`;
  readonly output_schema: JsonValue | null;
  readonly output_schema_hash: `sha256:${string}` | null;
  readonly operation_class: ToolOperationClass;
  readonly approval: ToolApprovalRule;
  readonly content_kinds: readonly ToolContentKind[];
  readonly sensitive_output_pointers: readonly string[];
}

export interface McpProfileServerRuleV1 {
  readonly server_id: string;
  readonly binding_name: string;
  readonly protocol_revision: McpProtocolRevision;
  readonly x_mcp_headers: Readonly<Record<string, string>>;
  readonly tools: readonly McpProfileToolRuleV1[];
}

export type McpServerBinding = McpStdioBinding | McpStreamableHttpBinding | McpAgentgatewayBinding;

export type McpEnvironmentValue =
  | Readonly<{ kind: "literal"; value: string }>
  | Readonly<{ kind: "secret-reference"; reference: string }>;

export interface McpProfileConfig {
  readonly profile: McpProfileV1;
  readonly servers: Readonly<Record<string, McpServerBinding>>;
}
```

The stable public broker surface is:

```ts
export interface ToolBroker {
  recover(): Promise<void>;
  openSession(request: OpenToolSessionRequest): Promise<ToolSessionHandle>;
  discover(request: DiscoverToolsRequest): Promise<DiscoveredToolView>;
  invoke(request: InvokeToolRequest): Promise<ToolInvocationOutcome>;
  resumeApproval(request: ResumeToolApprovalRequest): Promise<ToolInvocationOutcome>;
  disposeUncertain(request: DisposeUncertainToolRequest): Promise<ToolDispositionOutcome>;
  result(runId: string, callId: string): Promise<ToolResultV1 | null>;
  trace(runId: string, callId: string): Promise<ToolCallV1 | null>;
  capabilities(): RuntimeCapabilitiesV1;
  health(): readonly ToolProfileHealth[];
  closeSession(runId: string): Promise<void>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}

export interface OpenToolSessionRequest {
  readonly run_id: string;
  readonly execution_request_hash: `sha256:${string}`;
  readonly authority: EffectiveAgentAuthority;
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
}

export interface InvokeToolRequest {
  readonly run_id: string;
  readonly session_id: string;
  readonly expected_journal_head: JournalHead;
  readonly alias: string;
  readonly arguments: JsonValue;
  readonly logical_call_id: string;
  readonly operation_id: string;
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
}

export interface ToolSessionHandle {
  readonly run_id: string;
  readonly session_id: string;
  readonly profile: McpProfileReference;
  readonly expires_at: string;
}

export interface DiscoverToolsRequest {
  readonly run_id: string;
  readonly session_id: string;
  readonly signal: AbortSignal;
}

export interface DiscoveredToolView {
  readonly session_id: string;
  readonly snapshot_hash: `sha256:${string}`;
  readonly tools: readonly Readonly<{
    name: string;
    description: string;
    input_schema: JsonValue;
  }>[];
}

export interface ResumeToolApprovalRequest {
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly call_id: string;
  readonly approval_request_hash: `sha256:${string}`;
  readonly operation_id: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
}

export interface DisposeUncertainToolRequest {
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly call_id: string;
  readonly idempotency_key: `sha256:${string}`;
  readonly operation_id: string;
  readonly disposition: ToolUncertainDisposition;
  readonly trace: TraceContext;
}

export type ToolInvocationOutcome =
  | Readonly<{
      state: "RUNNING";
      call: ToolCallV1;
      result: ToolResultV1;
      journal_head: JournalHead;
      replayed: boolean;
    }>
  | Readonly<{
      state: "APPROVAL_PENDING";
      call: ToolCallV1;
      approval: ToolApprovalV1;
      journal_head: JournalHead;
      replayed: boolean;
    }>
  | Readonly<{
      state: "FAILED" | "BLOCKED";
      call: ToolCallV1;
      error: RuntimeError;
      journal_head: JournalHead;
      replayed: boolean;
    }>;

export interface ToolDispositionOutcome {
  readonly state: "RUNNING" | "BLOCKED";
  readonly call: ToolCallV1;
  readonly journal_head: JournalHead;
  readonly replayed: boolean;
}

export interface ToolProfileHealth {
  readonly profile: McpProfileReference;
  readonly status: "ready" | "blocked" | "unavailable";
  readonly findings: readonly RuntimeError[];
}
```

Transport adapters implement only this TOSS-owned boundary:

```ts
export interface ToolTransportConnection {
  readonly server: ToolServerObservation;
  listTools(cursor: string | null, signal: AbortSignal): Promise<ToolListPage>;
  callTool(request: NativeToolCallRequest, signal: AbortSignal): Promise<NativeToolCallResult>;
  close(signal: AbortSignal): Promise<void>;
}

export interface ToolTransportAdapter {
  readonly kind: McpTransportKind;
  connect(request: ToolTransportConnectRequest): Promise<ToolTransportConnection>;
}
```

Runtime hard ceilings cap, but never widen, profile limits:

```ts
export const TOOL_HARD_LIMITS = Object.freeze({
  profiles: 64,
  serversPerProfile: 32,
  toolsPerServer: 256,
  discoveryPagesPerServer: 64,
  schemaBytes: 262_144,
  argumentsBytes: 1_048_576,
  resultBytes: 4_194_304,
  contentBlocks: 128,
  contentBlockBytes: 1_048_576,
  structuredOutputBytes: 1_048_576,
  approvalSummaryBytes: 2_048,
  discoveryTimeoutMs: 30_000,
  callTimeoutMs: 120_000,
  sessionLifetimeMs: 900_000,
});
```

---

### Task 1: MCP profile contract, semantic authority, types, and errors

**Files:**

- Create: `contracts/runtime/mcp-profile.v1.schema.json`
- Create: `src/tools/types.ts`
- Create: `src/tools/contracts.ts`
- Create: `src/tools/errors.ts`
- Create: `test/support/tool-fixtures.ts`
- Create: `test/tool-profile-contract.test.ts`
- Modify: `src/protocol/validator.ts`
- Modify: `docs/contracts/runtime-contract-v1.manifest.json`
- Modify: `test/documentation-integrity.test.ts`

**Interfaces:**

- Consumes: `RuntimeDocument`, `TaskContractReference`, `JsonValue`, `ValidationResult`, `canonicalJson`, `deepFreezeJson`, `sha256`, and `createProtocolValidator`.
- Produces: `McpProfileV1`, profile rule/limit types, binding types, `TOOL_HARD_LIMITS`, `hashMcpProfile`, `parseMcpProfile`, `RuntimeToolError`, and `RuntimeToolErrorCode`.

- [x] **Step 1: Write profile schema, hash, and semantic RED tests**

  Build one exact valid profile fixture, then reject unknown keys, wrong document hash, unsorted or duplicate servers/tools/roles/Task Contracts/content kinds/pointers, duplicate aliases across servers, remote or cyclic `$ref`, over-deep schemas, secret-shaped input properties, inconsistent schema hashes, and incoherent approval classes.

  ```ts
  it("accepts and recursively freezes one canonical profile", () => {
    const parsed = parseMcpProfile(canonicalJson(validMcpProfile()));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(hashMcpProfile(parsed.value)).toBe(parsed.value.document_hash);
      expect(Object.isFrozen(parsed.value.servers[0]?.tools[0]?.input_schema)).toBe(true);
    }
  });

  it.each([
    ["read-only", "required"],
    ["irreversible", "not-required"],
  ])("rejects incoherent %s/%s policy", (operation_class, approval) => {
    expect(parseMcpProfile(mutatedProfile({ operation_class, approval })).ok).toBe(false);
  });
  ```

- [x] **Step 2: Run the focused test and witness RED**

  ```bash
  npm exec -- vitest run test/tool-profile-contract.test.ts --maxWorkers=4
  ```

  Expected: FAIL because the profile schema and tool contract modules do not exist.

- [x] **Step 3: Implement the closed profile schema and parser**

  Require ASCII bytewise order, unique exact identities, self-contained JSON Schema 2020-12, local fragment references only, canonical schema hashes, closed JSON objects, exact Task Contract artifact references, and the operation/approval matrix. Require `x_mcp_headers` to be empty for `2025-06-18`; accept only lowercase `x-mcp-*` names with profile-declared schema-property mappings for `2026-07-28`. Apply `TOOL_HARD_LIMITS` before schema compilation and recompute `document_hash` with only that field omitted.

- [x] **Step 4: Add the safe closed error table**

  ```ts
  export type RuntimeToolErrorCode =
    | "RUNTIME_TOOL_INVALID"
    | "RUNTIME_TOOL_SCHEMA_MISMATCH"
    | "RUNTIME_TOOL_PROTOCOL_DOWNGRADE"
    | "RUNTIME_TOOL_RESULT_INVALID"
    | "RUNTIME_TOOL_POLICY_DENIED"
    | "RUNTIME_TOOL_UNSUPPORTED"
    | "RUNTIME_TOOL_OPERATION_CONFLICT"
    | "RUNTIME_TOOL_APPROVAL_REQUIRED"
    | "RUNTIME_TOOL_APPROVAL_STALE"
    | "RUNTIME_TOOL_APPROVAL_REJECTED"
    | "RUNTIME_TOOL_EFFECT_UNCERTAIN"
    | "RUNTIME_TOOL_AUTHENTICATION"
    | "RUNTIME_TOOL_UNAVAILABLE"
    | "RUNTIME_TOOL_RATE_LIMIT"
    | "RUNTIME_TOOL_TIMEOUT"
    | "RUNTIME_TOOL_CANCELLED"
    | "RUNTIME_TOOL_INTERNAL";
  ```

  Give every code one fixed `category`, `retryable`, and `safe_message`. `RuntimeToolError` may carry frozen safe findings `{server_identity_hash, transport, trace_id}` but never native text.

- [x] **Step 5: Register the schema and run GREEN gates**

  Add the schema to `src/protocol/validator.ts` and the ASCII-sorted manifest. Prove schema-directory completeness.

  ```bash
  npm exec -- vitest run test/tool-profile-contract.test.ts test/protocol-validator.test.ts test/documentation-integrity.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  ```

- [x] **Step 6: Commit Task 1**

  ```bash
  git add contracts/runtime/mcp-profile.v1.schema.json src/tools/types.ts src/tools/contracts.ts src/tools/errors.ts src/protocol/validator.ts test/support/tool-fixtures.ts test/tool-profile-contract.test.ts docs/contracts/runtime-contract-v1.manifest.json test/documentation-integrity.test.ts
  git commit -m "feat: define MCP profile authority"
  ```

### Task 2: Discovery, approval, call, and result contracts

**Files:**

- Create: `contracts/runtime/mcp-discovery-snapshot.v1.schema.json`
- Create: `contracts/runtime/tool-approval.v1.schema.json`
- Create: `contracts/runtime/tool-call.v1.schema.json`
- Create: `contracts/runtime/tool-result.v1.schema.json`
- Create: `test/tool-contracts.test.ts`
- Modify: `src/tools/types.ts`
- Modify: `src/tools/contracts.ts`
- Modify: `src/protocol/validator.ts`
- Modify: `docs/contracts/runtime-contract-v1.manifest.json`
- Modify: `test/documentation-integrity.test.ts`

**Interfaces:**

- Consumes: Task 1 profile identities, `JournalHead`, `TraceContext`, `RuntimeError`, and canonical JSON utilities.
- Produces: `McpDiscoverySnapshotV1`, `ToolApprovalV1`, `ToolCallV1`, `ToolResultV1`, their hashable forms, four parsers, four hash functions, and `validateToolArguments`/`validateStructuredToolOutput`.

- [x] **Step 1: Write four-document RED tests**

  Assert canonical accept/freeze/hash behavior and reject unknown keys, bad stage fields, approval decisions not bound to requests, mismatched journal heads, raw arguments in approval, endpoints/commands/credentials in discovery, malformed provenance, unsupported content blocks, result annotations, invalid structured output, duplicate entries, bad order, over-limit bytes, and inconsistent aggregate counts.

  ```ts
  it("keeps tool results explicitly untrusted", () => {
    const parsed = parseToolResult(canonicalJson(validToolResult()));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.trust).toBe("untrusted-content");
  });

  it("rejects structured content without a profile output schema", () => {
    const parsed = parseToolResult(canonicalJson(resultWithoutDeclaredOutputSchema()));
    expect(parsed).toMatchObject({ ok: false, code: "RUNTIME_DOCUMENT_INVALID" });
  });
  ```

- [x] **Step 2: Run RED**

  ```bash
  npm exec -- vitest run test/tool-contracts.test.ts --maxWorkers=4
  ```

  Expected: FAIL because the four schemas and parsers are absent.

- [x] **Step 3: Implement exact durable document shapes**

  `mcp-discovery-snapshot.v1` records run/session/profile hashes, created/expires timestamps, stale flag, server producer/revision/transport, native names, canonical schema hashes, and captured hints only. `tool-approval.v1` is a `REQUEST | DECISION` union binding exact run/head/authority/profile/snapshot/server/tool/schema/class/input/call/idempotency/summary/trace fields. `tool-call.v1` is append-only by revision and permits only coherent `PREPARED | COMPLETED | FAILED | UNCERTAIN` fields. `tool-result.v1` carries the five supported content kinds, optional structured content, `trust: "untrusted-content"`, exact provenance, stable terminal error, trace, size accounting, and document hash.

- [x] **Step 4: Implement bounded schema validation**

  Compile profile input/output schemas with Ajv 2020 in strict mode, no coercion/default/removal, no remote resolution, and a bounded cache keyed by canonical schema hash. Capture and deep-freeze arguments before validation. Return only stable tool-domain failures; never forward Ajv messages to public results.

- [x] **Step 5: Register four schemas and run GREEN**

  ```bash
  npm exec -- vitest run test/tool-contracts.test.ts test/tool-profile-contract.test.ts test/protocol-validator.test.ts test/documentation-integrity.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  ```

- [x] **Step 6: Commit Task 2**

  ```bash
  git add contracts/runtime/mcp-discovery-snapshot.v1.schema.json contracts/runtime/tool-approval.v1.schema.json contracts/runtime/tool-call.v1.schema.json contracts/runtime/tool-result.v1.schema.json src/tools/types.ts src/tools/contracts.ts src/protocol/validator.ts test/support/tool-fixtures.ts test/tool-contracts.test.ts docs/contracts/runtime-contract-v1.manifest.json test/documentation-integrity.test.ts
  git commit -m "feat: define durable tool contracts"
  ```

### Task 3: Runtime MCP configuration, profile registry, and static capability truth

**Files:**

- Create: `src/tools/profile.ts`
- Create: `test/tool-profile-registry.test.ts`
- Modify: `contracts/runtime/runtime-config.v1.schema.json`
- Modify: `src/config/types.ts`
- Modify: `src/config/load.ts`
- Modify: `src/protocol/capabilities.ts`
- Modify: `test/config.test.ts`
- Modify: `test/execution-chain.test.ts`
- Modify: `examples/config/runtime.development.yaml`

**Interfaces:**

- Consumes: `RuntimeConfigV1`, `McpProfileV1`, `AgentgatewayProfileV1`, `SecretReference`, and profile parsers.
- Produces: `config.mcp_profiles: Readonly<Record<string, McpProfileConfig>>`, `McpProfileRegistry`, `createMcpProfileRegistry(config)`, and profile artifact references.

- [x] **Step 1: Write configuration and registry RED tests**

  Cover `{}` default, obsolete array rejection, profile key/ID mismatch, hash mismatch, missing/extra binding, transport-specific closed fields, unsafe stdio paths, production HTTP, URL userinfo/query/fragment, missing secret references, missing gateway profiles, duplicated bindings, every 2025 header mapping, a 2026 header mapping on stdio, and a valid instance of each transport.

  ```ts
  it("defaults to no configured MCP authority", () => {
    expect(defaultConfig("darwin", "/Users/test").mcp_profiles).toEqual({});
  });

  it("rejects the obsolete string-array shape", () => {
    expect(() => loadConfigFixture({ mcp_profiles: ["legacy"] })).toThrowError(
      expect.objectContaining({ code: "RUNTIME_CONFIG_INVALID" }),
    );
  });
  ```

- [x] **Step 2: Run RED**

  ```bash
  npm exec -- vitest run test/config.test.ts test/tool-profile-registry.test.ts test/execution-chain.test.ts --maxWorkers=4
  ```

  Expected: FAIL because configuration still declares `mcp_profiles` as a string array.

- [x] **Step 3: Implement the closed binding union and registry**

  Use exact bindings:

  ```ts
  export interface McpStdioBinding {
    readonly transport: "stdio";
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, McpEnvironmentValue>>;
  }

  export interface McpStreamableHttpBinding {
    readonly transport: "streamable-http";
    readonly endpoint: string;
    readonly credential_reference: string | null;
  }

  export interface McpAgentgatewayBinding {
    readonly transport: "agentgateway";
    readonly gateway_profile: string;
  }
  ```

  Match map key to `profile_id`; profile `binding_name` to exactly one binding; reject extras and unsafe/missing dependencies. Return deep-frozen exact artifact references `{document_type:"mcp-profile", artifact_id, revision, hash}`.

- [x] **Step 4: Keep baseline capabilities truthful**

  Add all five schema names to `supported_schemas` while leaving baseline `mcp_transports`, `mcp_profiles`, and `features.mcp` empty/unavailable. Extend capability parsing tests to require no advertised profiles or transports when MCP is unavailable or blocked and exact non-empty transports/profiles when available.

- [x] **Step 5: Run GREEN and commit**

  ```bash
  npm exec -- vitest run test/config.test.ts test/tool-profile-registry.test.ts test/execution-chain.test.ts test/protocol-validator.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add contracts/runtime/runtime-config.v1.schema.json src/config/types.ts src/config/load.ts src/tools/profile.ts src/protocol/capabilities.ts test/config.test.ts test/tool-profile-registry.test.ts test/execution-chain.test.ts examples/config/runtime.development.yaml
  git commit -m "feat: configure MCP profile bindings"
  ```

### Task 4: Transport-neutral SDK boundary and conformance fixtures

**Files:**

- Create: `src/tools/transports/types.ts`
- Create: `src/tools/transports/sdk-client.ts`
- Create: `test/helpers/fake-mcp.ts`
- Create: `test/tool-sdk-client.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: official MCP client APIs, pinned protocol revision, `AbortSignal`, deadlines, and TOSS-owned request/result records.
- Produces: `ToolTransportAdapter`, `ToolTransportConnection`, `ToolSdkClientFactory`, SDK-to-domain error classification, and official/hand-authored test fixtures.

- [x] **Step 1: Install exact dependencies and write adapter RED tests**

  ```bash
  npm install --save-exact @modelcontextprotocol/client@2.0.0
  npm install --save-dev --save-exact @modelcontextprotocol/server@2.0.0
  ```

  Test exact initialization revision, no fallback, full `nextCursor` preservation, `tools/list_changed`, `_meta` pass-through from trusted input only, cancellation, close, and conversion of native errors to stable safe descriptors. Include one official server fixture and separate hand-authored malformed frames.

- [x] **Step 2: Run RED**

  ```bash
  npm exec -- vitest run test/tool-sdk-client.test.ts --maxWorkers=4
  ```

  Expected: FAIL because the transport-neutral client wrapper is absent.

- [x] **Step 3: Implement the private SDK translation boundary**

  Keep all SDK imports below `src/tools/transports/`. Translate SDK values immediately into closed records. Refuse negotiated revision mismatch, server-request handlers, unsupported capabilities, caller-supplied `_meta`, and automatic call retry. Bound frames and native error inspection before classification.

- [x] **Step 4: Prove no public SDK type leakage and run GREEN**

  ```bash
  npm exec -- vitest run test/tool-sdk-client.test.ts test/package-metadata.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add package.json package-lock.json src/tools/transports/types.ts src/tools/transports/sdk-client.ts test/helpers/fake-mcp.ts test/tool-sdk-client.test.ts
  git commit -m "feat: add private MCP client boundary"
  ```

### Task 5: Hardened stdio transport

**Files:**

- Create: `src/tools/transports/stdio.ts`
- Create: `test/fixtures/mcp/stdio-server.mjs`
- Create: `test/tool-stdio-transport.test.ts`

**Interfaces:**

- Consumes: `McpStdioBinding`, `ToolSdkClientFactory`, scoped secret leases, injected spawn/clock seams, and `ToolTransportConnectRequest`.
- Produces: `createStdioToolTransport(options): ToolTransportAdapter`.

- [x] **Step 1: Write real-child-process RED tests**

  Assert absolute normalized executable, no shell/PATH lookup, trusted fixed args/cwd only, empty/minimal environment, literal secret-name rejection in production, scoped secret injection, no request-derived args, bounded redacted stderr, initialization timeout, lease expiry, cancellation, graceful close, SIGTERM/SIGKILL escalation, and awaited reaping.

  ```ts
  expect(spawnObservation).toMatchObject({
    command: "/usr/bin/node",
    shell: false,
    cwd: privateRoot,
  });
  expect(spawnObservation.env).not.toHaveProperty("PATH");
  expect(publicFailure).not.toContain("stderr-secret");
  ```

- [x] **Step 2: Run RED**

  ```bash
  npm exec -- vitest run test/tool-stdio-transport.test.ts --maxWorkers=4
  ```

- [x] **Step 3: Implement stdio lifecycle policy**

  Capture binding values before spawn, open no shell, supply only fixed runtime keys and explicitly configured values, resolve secrets immediately before launch, cap session lifetime to the shortest lease, and keep stderr in a bounded redacting ring used only for status classification. Close stdin, wait boundedly, send SIGTERM, then SIGKILL, and await `exit` before resolving `close()`.

- [x] **Step 4: Run GREEN and commit**

  ```bash
  npm exec -- vitest run test/tool-stdio-transport.test.ts test/tool-sdk-client.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add src/tools/transports/stdio.ts test/fixtures/mcp/stdio-server.mjs test/tool-stdio-transport.test.ts
  git commit -m "feat: add hardened MCP stdio transport"
  ```

### Task 6: SSRF-safe Streamable HTTP transport

**Files:**

- Create: `src/tools/transports/streamable-http.ts`
- Create: `test/tool-streamable-http-transport.test.ts`

**Interfaces:**

- Consumes: `McpStreamableHttpBinding`, fixed fetch/DNS/socket seams, per-request secret resolver, SDK client factory, and profile-approved header mappings.
- Produces: `createStreamableHttpToolTransport(options): ToolTransportAdapter`.

- [x] **Step 1: Write loopback/network-seam RED tests**

  Cover HTTPS production, exact development loopback HTTP, userinfo/query/fragment rejection, redirects, public-to-private rebinding, private/link-local/metadata IPs, connection-time address mismatch, fixed content negotiation, per-request bearer resolution, no 401 refresh/retry, JSON and SSE replies, timeout/cancellation, revision mismatch, malformed bodies, rate limit classification, and `x-mcp-header` allowlist enforcement.

- [x] **Step 2: Run RED**

  ```bash
  npm exec -- vitest run test/tool-streamable-http-transport.test.ts --maxWorkers=4
  ```

- [x] **Step 3: Implement fixed-origin transport policy**

  Normalize the endpoint once; validate DNS at configuration and connect; bind the actual socket address to the approved resolution; set `redirect: "error"`; construct headers from a closed local allowlist; resolve bearer tokens for each request; and never accept caller headers, uncontrolled query values, response-driven redirects, or automatic auth refresh. Map status/network failures to tool codes without response text.

- [x] **Step 4: Run GREEN and commit**

  ```bash
  npm exec -- vitest run test/tool-streamable-http-transport.test.ts test/tool-sdk-client.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add src/tools/transports/streamable-http.ts test/tool-streamable-http-transport.test.ts
  git commit -m "feat: add safe MCP HTTP transport"
  ```

### Task 7: Scoped agentgateway MCP transport

**Files:**

- Create: `src/tools/transports/agentgateway.ts`
- Create: `test/tool-agentgateway-transport.test.ts`
- Modify: `test/helpers/fake-agentgateway.ts`

**Interfaces:**

- Consumes: validated `AgentgatewayProfileV1`, `GatewayCredentialCoordinator`, gateway fetch/attestation primitives, exact execution authority, and server/profile/tool scope.
- Produces: `createAgentgatewayToolTransport(options): ToolTransportAdapter`.

- [x] **Step 1: Write gateway RED tests**

  Verify derived path `/v1/toss/mcp/{percent-encoded-server-id}`, no caller endpoint, fresh lease per scoped connection/request policy, exact run/agent/Task Contract/profile/server/tool scope, fixed correlation and attestation headers, idempotency propagation, route absence, auth, expiry, capability downgrade, protocol mismatch, cancellation, and token non-disclosure.

- [x] **Step 2: Run RED**

  ```bash
  npm exec -- vitest run test/tool-agentgateway-transport.test.ts --maxWorkers=4
  ```

- [x] **Step 3: Implement derived-route and lease policy**

  Reuse validated gateway origin and credential coordinator, percent-encode only `server_id`, require exact MCP route attestation, and emit only W3C trace, run/request, profile/snapshot, tool/call, and idempotency fields. Translate gateway errors into tool-domain codes and discard provider-domain/native bodies.

- [x] **Step 4: Run GREEN and commit**

  ```bash
  npm exec -- vitest run test/tool-agentgateway-transport.test.ts test/agentgateway-transport.test.ts test/agentgateway-credentials.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add src/tools/transports/agentgateway.ts test/tool-agentgateway-transport.test.ts test/helpers/fake-agentgateway.ts
  git commit -m "feat: route MCP through agentgateway"
  ```

### Task 8: Run-scoped discovery sessions and persisted snapshots

**Files:**

- Create: `src/tools/discovery.ts`
- Create: `test/tool-discovery.test.ts`
- Create: `src/tools/identity.ts`

**Interfaces:**

- Consumes: profile registry, three transport adapters, snapshot contracts, clock/random ID, and a snapshot persistence port.
- Produces: `ToolSessionManager`, `openSession`, `discover`, `markListChanged`, `closeSession`, frozen `DiscoveredToolView`, and persisted `McpDiscoverySnapshotV1`.

- [x] **Step 1: Write discovery RED tests**

  Cover one session per run/profile, no cross-run reuse, full pagination, page/tool/schema/time bounds, changing order normalization, duplicate cursors, native duplicate tools, alias collisions, profile/live schema equality, risky annotation mismatch, harmless less-risky annotations, injected server descriptions ignored, stale notification, expiry, reconnect identity/revision change, partial-server failure, per-server serialization, and persistence before exposure.

  ```ts
  expect(events).toEqual([
    "list:github:page-1",
    "list:github:page-2",
    "persist:snapshot",
    "expose:view",
  ]);
  expect(view.tools[0]?.description).toBe(profile.servers[0]?.tools[0]?.description);
  ```

- [x] **Step 2: Run RED**

  ```bash
  npm exec -- vitest run test/tool-discovery.test.ts --maxWorkers=4
  ```

- [x] **Step 3: Implement virtual-session and discovery state**

  Connect only configured profile servers, paginate to completion under profile/hard limits, canonical-compare native input/output schemas, retain annotations solely as captured mismatch evidence, build explicit alias mappings, persist the complete snapshot, then publish the model view. A list-change event atomically marks the snapshot stale; new calls require bounded rediscovery while already-dispatched calls retain their captured snapshot.

- [x] **Step 4: Run GREEN and commit**

  ```bash
  npm exec -- vitest run test/tool-discovery.test.ts test/tool-contracts.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add src/tools/discovery.ts src/tools/identity.ts test/tool-discovery.test.ts
  git commit -m "feat: persist scoped MCP discovery"
  ```

### Task 9: Ordered policy engine, identity, normalization, and redaction

**Files:**

- Modify: `src/tools/identity.ts`
- Create: `src/tools/policy.ts`
- Create: `src/tools/redaction.ts`
- Create: `test/tool-policy.test.ts`
- Create: `test/tool-redaction.test.ts`

**Interfaces:**

- Consumes: `EffectiveAgentAuthority`, exact execution request hash, active session/snapshot, profile rule, captured arguments, transport observation, and native result.
- Produces: `authorizeToolCall(input): AuthorizedToolCall`, `deriveToolIdentity(input)`, `normalizeToolResult(input): ToolResultV1`, and structural/generic redaction helpers.

- [x] **Step 1: Write authority cross-product RED tests**

  Vary run/request/trace identity, definition, role, Task Contract, profile reference, session, snapshot, alias, server, schema, arguments, secret-shaped keys, operation class, approval, timeout/result limits, and reviewer role one dimension at a time. Prove bindings, model `_meta`, server annotations, descriptions, output, and approved header mappings cannot widen authority.

  ```ts
  it.each(["reversible-write", "irreversible"])(
    "prevents reviewer execution of %s",
    (operation_class) => {
      expect(() =>
        authorizeToolCall(policyFixture({ role: "reviewer", operation_class })),
      ).toThrowError(expect.objectContaining({ code: "RUNTIME_TOOL_POLICY_DENIED" }));
    },
  );
  ```

- [x] **Step 2: Write normalization/redaction RED tests**

  Cover all five supported block kinds, per-block/total bounds, base64 validation, embedded resource bounds, dropped annotations, structured schema match/mismatch, declared JSON-pointer replacement, escaped pointer tokens, generic token/key patterns, invalid/partial/is-error native results, and absence of raw input/output in journal/log metadata.

- [x] **Step 3: Run RED**

  ```bash
  npm exec -- vitest run test/tool-policy.test.ts test/tool-redaction.test.ts --maxWorkers=4
  ```

- [x] **Step 4: Implement the exact policy order and local identity**

  Evaluate the ten checks from the approved spec in order and stop on first denial. Derive a closed `_meta` member from captured authority:

  ```ts
  export interface TossToolMetaV1 {
    readonly run_id: string;
    readonly execution_request_hash: `sha256:${string}`;
    readonly agent_definition_hash: `sha256:${string}`;
    readonly task_contract_hash: `sha256:${string}`;
    readonly role: string;
    readonly mcp_profile_hash: `sha256:${string}`;
    readonly discovery_snapshot_hash: `sha256:${string}`;
    readonly server_id: string;
    readonly tool_alias: string;
    readonly native_tool_name: string;
    readonly call_id: string;
    readonly idempotency_key: `sha256:${string}`;
    readonly trace: TraceContext;
  }
  ```

  Reject caller/model `_meta`; derive stable call/idempotency hashes from run, logical call ID, tool identity, and canonical input hash.

- [x] **Step 5: Implement bounded normalization and run GREEN**

  Validate before allocation where possible, structurally redact declared pointers before persistence, apply generic text/key redaction second, drop annotations, preserve only safe counts/status/provenance, and build/hash/freeze `tool-result.v1`.

  ```bash
  npm exec -- vitest run test/tool-policy.test.ts test/tool-redaction.test.ts test/tool-contracts.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add src/tools/identity.ts src/tools/policy.ts src/tools/redaction.ts test/tool-policy.test.ts test/tool-redaction.test.ts
  git commit -m "feat: enforce MCP tool policy"
  ```

### Task 10: Private durable tool store

**Files:**

- Create: `src/tools/private-store.ts`
- Create: `test/tool-private-store.test.ts`

**Interfaces:**

- Consumes: tool document parsers/hashes, runtime state root, process/listener probes, and injectable crash hooks.
- Produces: internal `ToolPrivateStore`, append-only call revisions, approval/result publication, operation log, exact lookup, recovery, quarantine, stop-intake, and flush.

- [ ] **Step 1: Write filesystem and crash RED tests**

  Cover `0700`/`0600`, current owner, one link, symlink/no-follow denial, ancestor permissions, stable bigint identity, bounded reads, atomic create, file/directory sync, duplicate exact replay, conflicting operation IDs, append-only stages, orphan result quarantine, truncated files, mutation races, dead/live writer recovery, stop-intake races, and every publish hook before/after rename/sync.

- [ ] **Step 2: Run RED**

  ```bash
  npm exec -- vitest run test/tool-private-store.test.ts --maxWorkers=4
  ```

- [ ] **Step 3: Implement the store using existing hardened patterns**

  Adapt the security invariants from `src/skills/private-store.ts` and `src/service/definition-store.ts` without exporting native paths or test hooks. Store prepared arguments only after secret-shape rejection. Key records by run/call identity and document hash; append stage revisions and disposition operations; publish results before terminal call stages; quarantine any object that cannot be proven exact.

- [ ] **Step 4: Run GREEN and commit**

  ```bash
  npm exec -- vitest run test/tool-private-store.test.ts test/skill-private-store.test.ts test/service-definition-store.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add src/tools/private-store.ts test/tool-private-store.test.ts
  git commit -m "feat: persist durable tool calls"
  ```

### Task 11: Durable execution, side-effect intent, replay, and failure classification

**Files:**

- Create: `src/tools/executor.ts`
- Create: `test/tool-executor.test.ts`

**Interfaces:**

- Consumes: journal store/barrier, private store, authorized call, transport connection, result normalizer, clock/random ID, and fault hooks.
- Produces: internal `ToolExecutor.invoke`, result replay, journal commands, exact dispatch count, and safe terminal outcomes.

- [ ] **Step 1: Write executor RED tests**

  Witness crash/fault points before prepared publication, after prepared publication, before intent, after intent, before transport dispatch, during dispatch, after native result, after result sync, and before journal completion. Assert no transport call before `TOOL_PENDING` intent, completed replay returns persisted result with zero redispatch, same key/different input conflicts, proven-unsent failure closes the ledger and reaches `FAILED`, and possible effect reaches `BLOCKED` with unresolved intent.

  ```ts
  expect(events).toEqual([
    "store:PREPARED",
    "journal:TOOL_PENDING:INTENT",
    "transport:call",
    "store:result",
    "store:COMPLETED",
    "journal:RUNNING:COMPLETED",
  ]);
  expect(transport.calls).toHaveLength(1);
  ```

- [ ] **Step 2: Run RED**

  ```bash
  npm exec -- vitest run test/tool-executor.test.ts --maxWorkers=4
  ```

- [ ] **Step 3: Implement one-dispatch execution under the run barrier**

  Capture/freeze input; compute input/call/idempotency hashes; persist `PREPARED`; append side-effect `INTENT`; resolve transport credentials; dispatch exactly once; normalize/redact/validate; publish result; append `COMPLETED` store stage; then append journal side-effect `COMPLETED` and return to `RUNNING`. Do not retry on auth, rate limit, timeout, cancellation, or native failure after possible dispatch.

- [ ] **Step 4: Implement exact failure classification**

  Use `FAILED` only with transport proof that bytes were not sent. Use `UNCERTAIN` plus journal `BLOCKED` whenever delivery/effect is ambiguous. Public outcomes include only stable code, retryability, safe message, hashes, and trace identity.

- [ ] **Step 5: Run GREEN and commit**

  ```bash
  npm exec -- vitest run test/tool-executor.test.ts test/journal-state-machine.test.ts test/journal-store.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add src/tools/executor.ts test/tool-executor.test.ts
  git commit -m "feat: execute MCP calls durably"
  ```

### Task 12: Tool approval pause/resume and authenticated service control

**Files:**

- Create: `src/tools/approval.ts`
- Create: `test/tool-approval.test.ts`
- Modify: `contracts/runtime/service-control-request.v1.schema.json`
- Modify: `contracts/runtime/service-control-response.v1.schema.json`
- Modify: `src/service/contracts.ts`
- Modify: `src/service/control.ts`
- Modify: `src/service/supervisor.ts`
- Modify: `src/cli/grammar.ts`
- Modify: `src/cli/main.ts`
- Modify: `test/service-contracts.test.ts`
- Modify: `test/service-control.test.ts`
- Modify: `test/service-supervisor.test.ts`
- Modify: `test/cli.test.ts`

**Interfaces:**

- Consumes: prepared call, exact pending journal head, snapshot freshness, private store, executor, and authenticated same-user socket.
- Produces: `requestToolApproval`, `resumeToolApproval`, `ServiceToolApproveRequestV1`, `ToolApprovalDataV1`, and internal CLI command `tool-approve`.

- [ ] **Step 1: Write approval lifecycle RED tests**

  Assert reversible default/irreversible pause, reversible explicit waiver, no native call before approval, durable request before `APPROVAL_PENDING`, restart then approve, reject to `BLOCKED`, exact duplicate replay, conflicting decision, stale head, stale/expired snapshot, changed input/tool/schema/profile/role/run, cross-run reuse, operation-ID conflict, bounded redacted summary, and shutdown intake races.

- [ ] **Step 2: Run RED**

  ```bash
  npm exec -- vitest run test/tool-approval.test.ts --maxWorkers=4
  ```

- [ ] **Step 3: Implement exact request/decision binding**

  Persist the prepared call and approval request, then append `APPROVAL_PENDING`. Resume requires all request fields and expected head to match, records a decision once, revalidates profile binding and snapshot freshness, and moves approved calls `APPROVAL_PENDING -> RUNNING` before invoking Task 11. Rejection records the decision and moves to `BLOCKED` without creating side-effect intent.

- [ ] **Step 4: Extend the closed service protocol**

  Add this request branch and matching response data:

  ```ts
  export interface ServiceToolApproveRequestV1 extends ServiceControlRequestBaseV1 {
    readonly command: "tool-approve";
    readonly operation_id: string;
    readonly run_id: string;
    readonly expected_journal_revision: number;
    readonly expected_journal_head_hash: `sha256:${string}`;
    readonly call_id: string;
    readonly approval_request_hash: `sha256:${string}`;
    readonly decision: "APPROVE" | "REJECT";
  }
  ```

  Route only through the existing authenticated local socket; apply request hash/replay cache; expose no model-callable approval API. Add the tool-domain safe error variants to the closed service response schema and add an internal CLI grammar branch that serializes this exact request.

- [ ] **Step 5: Run service and approval GREEN gates**

  ```bash
  npm exec -- vitest run test/tool-approval.test.ts test/service-contracts.test.ts test/service-control.test.ts test/service-supervisor.test.ts test/cli.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add src/tools/approval.ts contracts/runtime/service-control-request.v1.schema.json contracts/runtime/service-control-response.v1.schema.json src/service/contracts.ts src/service/control.ts src/service/supervisor.ts src/cli/grammar.ts src/cli/main.ts test/tool-approval.test.ts test/service-contracts.test.ts test/service-control.test.ts test/service-supervisor.test.ts test/cli.test.ts
  git commit -m "feat: gate MCP writes on approval"
  ```

### Task 13: Restart recovery, uncertain disposition, and shutdown order

**Files:**

- Create: `test/tool-recovery.test.ts`
- Modify: `src/tools/executor.ts`
- Modify: `src/tools/private-store.ts`
- Create: `src/tools/broker.ts`
- Modify: `contracts/runtime/service-control-request.v1.schema.json`
- Modify: `contracts/runtime/service-control-response.v1.schema.json`
- Modify: `src/service/contracts.ts`
- Modify: `src/service/control.ts`
- Modify: `src/service/supervisor.ts`
- Modify: `src/cli/grammar.ts`
- Modify: `src/cli/main.ts`
- Modify: `test/service-contracts.test.ts`
- Modify: `test/service-control.test.ts`
- Modify: `test/service-supervisor.test.ts`
- Modify: `test/cli.test.ts`

**Interfaces:**

- Consumes: journal unresolved side effects, durable calls/results, liveness/listener probes, service recovery participants, and exact human disposition.
- Produces: `recoverToolCalls`, `disposeUncertain`, `ServiceToolDisposeRequestV1`, disposition response data, and ordered broker shutdown.

- [ ] **Step 1: Write recovery/disposition RED tests**

  Cover exact result finishing journal completion without dispatch, orphan result quarantine, prepared-but-no-intent recovery, unresolved intent with proven-unsent evidence, unresolved intent with ambiguous delivery, no automatic retry, duplicate/conflicting dispositions, `NO_EFFECT_CONFIRMED` closing the ledger and `BLOCKED -> RUNNING`, `EFFECT_CONFIRMED` preserving unresolved ledger and `BLOCKED`, and proof neither disposition calls a transport.

- [ ] **Step 2: Write shutdown-order RED tests**

  Assert stop intake; cancel discovery/read; bounded write result publication; uncertain classification; close/reap connections; flush tool store; flush journal last. Approval-pending and uncertain records must survive restart without live clients.

- [ ] **Step 3: Run RED**

  ```bash
  npm exec -- vitest run test/tool-recovery.test.ts test/service-supervisor.test.ts --maxWorkers=4
  ```

- [ ] **Step 4: Implement recovery and disposition**

  Reconcile journal/store under the official per-run barrier. A synced exact result completes the journal; ambiguous dispatch becomes `UNCERTAIN`. Add the authenticated command:

  ```ts
  export interface ServiceToolDisposeRequestV1 extends ServiceControlRequestBaseV1 {
    readonly command: "tool-dispose";
    readonly operation_id: string;
    readonly run_id: string;
    readonly expected_journal_revision: number;
    readonly expected_journal_head_hash: `sha256:${string}`;
    readonly call_id: string;
    readonly idempotency_key: `sha256:${string}`;
    readonly disposition: ToolUncertainDisposition;
  }
  ```

  `NO_EFFECT_CONFIRMED` appends a hashed failure completion and permits a later new logical call. `EFFECT_CONFIRMED` appends only private operational evidence and keeps the run blocked with its intent unresolved.

- [ ] **Step 5: Run GREEN and commit**

  ```bash
  npm exec -- vitest run test/tool-recovery.test.ts test/tool-executor.test.ts test/service-contracts.test.ts test/service-control.test.ts test/service-supervisor.test.ts test/cli.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add src/tools/executor.ts src/tools/private-store.ts src/tools/broker.ts contracts/runtime/service-control-request.v1.schema.json contracts/runtime/service-control-response.v1.schema.json src/service/contracts.ts src/service/control.ts src/service/supervisor.ts src/cli/grammar.ts src/cli/main.ts test/tool-recovery.test.ts test/service-supervisor.test.ts test/cli.test.ts
  git commit -m "feat: recover uncertain tool effects"
  ```

### Task 14: Public broker factory, dynamic capabilities, health, and package-safe API

**Files:**

- Modify: `src/tools/broker.ts`
- Create: `test/tool-broker-integration.test.ts`
- Create: `test/tool-public-api.test.ts`
- Modify: `src/tools/index.ts`
- Modify: `src/index.ts`
- Modify: `src/protocol/capabilities.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/service/supervisor.ts`
- Modify: `test/unavailable-boundaries.test.ts`
- Modify: `test/serve-smoke.test.ts`

**Interfaces:**

- Consumes: loaded config, profile registry, journal, credential/gateway/process/network seams, operational logger, clock/random ID, service listener, and all prior tool layers.
- Produces: `createToolBroker(options): ToolBroker`, safe public exports, dynamic MCP capabilities, profile health findings, and supervisor recovery/flush participation.

- [ ] **Step 1: Write public integration RED tests**

  Run one read-only call on each transport; one approved write; one auth failure; one unavailable server; one malicious result; one stale discovery; completed replay; and uncertain recovery. Assert only exact authorized aliases are visible, results are frozen/untrusted/redacted, and SDK/private types are absent from emitted declarations.

- [ ] **Step 2: Write dynamic capability RED tests**

  Assert no configuration => `unavailable`; configured but none ready => `blocked` with no advertised profiles; one ready => `available` with only its exact artifact reference and bound transports; mixed readiness advertises only ready profiles. Requested blocked/unavailable profiles fail negotiation before tool execution.

- [ ] **Step 3: Run RED**

  ```bash
  npm exec -- vitest run test/tool-broker-integration.test.ts test/tool-public-api.test.ts test/unavailable-boundaries.test.ts test/serve-smoke.test.ts --maxWorkers=4
  ```

- [ ] **Step 4: Wire the production broker and lifecycle**

  Replace `requireToolBroker()` with the factory and closed public exports. Capture all mutating request values before state access, route journal mutations through `withRunJournalBarrier`, register broker recovery before service readiness, and preserve the Task 13 shutdown order. `health()` returns stable profile/server codes and hashes only.

- [ ] **Step 5: Implement dynamic capability projection**

  Build from the immutable baseline plus registry/readiness observations. Sort exact profile references and transports bytewise; never advertise configured-but-unready profiles or infer support from dependencies alone.

- [ ] **Step 6: Run GREEN and commit**

  ```bash
  npm exec -- vitest run test/tool-broker-integration.test.ts test/tool-public-api.test.ts test/unavailable-boundaries.test.ts test/serve-smoke.test.ts test/execution-chain.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add src/tools/broker.ts src/tools/index.ts src/index.ts src/protocol/capabilities.ts src/cli/main.ts src/service/supervisor.ts test/tool-broker-integration.test.ts test/tool-public-api.test.ts test/unavailable-boundaries.test.ts test/serve-smoke.test.ts
  git commit -m "feat: expose scoped MCP tool broker"
  ```

### Task 15: Documentation, examples, packaging, adversarial acceptance, and final verification

**Files:**

- Create: `examples/contracts/mcp-profile.v1.json`
- Create: `examples/contracts/mcp-discovery-snapshot.v1.json`
- Create: `examples/contracts/tool-approval.v1.json`
- Create: `examples/contracts/tool-call.v1.json`
- Create: `examples/contracts/tool-result.v1.json`
- Create: `docs/verification/issue-9-scoped-mcp-tools.md`
- Create: `test/tool-adversarial-acceptance.test.ts`
- Modify: `docs/contracts/runtime-contract-v1.md`
- Modify: `docs/architecture.md`
- Modify: `docs/compatibility.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `scripts/package-files.json`
- Modify: `scripts/package-test.mjs`
- Modify: `test/documentation-integrity.test.ts`
- Modify: `test/package-metadata.test.ts`

**Interfaces:**

- Consumes: all five contract hash functions, public broker API, package allowlist, and final test/build artifacts.
- Produces: canonical examples, documented support/limitations, adversarial acceptance evidence, and a leak-free installable package.

- [ ] **Step 1: Add end-to-end adversarial RED tests**

  Cover permission widening by model/binding/server, prompt injection in descriptions/schema descriptions/results, remote `$ref`, deep schemas, secret-shaped input, hostile headers, raw-token/stderr/SDK-error leakage, approval bypass/reuse, idempotency conflict, call/result partial failure, transport downgrade, stale snapshots, replay, retry suppression, and both uncertain dispositions across the three transport fixtures.

- [ ] **Step 2: Run RED**

  ```bash
  npm exec -- vitest run test/tool-adversarial-acceptance.test.ts --maxWorkers=4
  ```

- [ ] **Step 3: Generate canonical examples through public hash functions**

  Produce all five documents from fixtures and parse them back. Examples contain no live endpoint, command, local path, credential, or raw secret. Extend documentation integrity tests to prove hashes, manifest membership, schema registration, and example validity.

- [ ] **Step 4: Update operator and protocol documentation**

  Document profile/binding separation, all three transports, exact protocol pinning, role/Task Contract intersection, durable approval, at-most-one broker dispatch, uncertain-effect recovery, supported result blocks, structural/generic redaction, credential limitations, dynamic capabilities, shutdown order, stable errors, and downstream ownership by Issues #10, #11, #12, and #15.

- [ ] **Step 5: Lock package contents and public declaration safety**

  Include five schemas/examples and public tool declarations/runtime files. Exclude test fixtures, private-store declaration/maps, transport test seams, raw native observations, and generated temporary state. Make `scripts/package-test.mjs` install the tarball, parse all five examples, exercise baseline/dynamic capability APIs, and scan the tarball for credential/endpoint/path fixture markers and SDK types in public declarations.

- [ ] **Step 6: Run focused acceptance GREEN**

  ```bash
  npm exec -- vitest run test/tool-adversarial-acceptance.test.ts test/tool-broker-integration.test.ts test/tool-recovery.test.ts test/documentation-integrity.test.ts test/package-metadata.test.ts --maxWorkers=4
  ```

- [ ] **Step 7: Run the complete release gate**

  ```bash
  npm run format:check
  npm run lint
  npm run typecheck
  npm test
  npm run build
  npm run test:package
  git status --short
  ```

  Expected: every command succeeds and `git status --short` lists only the intended Task 15 documentation/test/package changes before commit.

- [ ] **Step 8: Record verification evidence and commit**

  Record command names, UTC timestamps, exit status, test counts, package filename/hash, supported Node/macOS policy, and the explicit absence of a protected live-credential test in `docs/verification/issue-9-scoped-mcp-tools.md`.

  ```bash
  git add examples/contracts/mcp-profile.v1.json examples/contracts/mcp-discovery-snapshot.v1.json examples/contracts/tool-approval.v1.json examples/contracts/tool-call.v1.json examples/contracts/tool-result.v1.json docs/verification/issue-9-scoped-mcp-tools.md docs/contracts/runtime-contract-v1.md docs/architecture.md docs/compatibility.md README.md CHANGELOG.md scripts/package-files.json scripts/package-test.mjs test/tool-adversarial-acceptance.test.ts test/documentation-integrity.test.ts test/package-metadata.test.ts
  git commit -m "docs: verify scoped MCP tool broker"
  ```

## Completion checklist

- [ ] Exactly five new runtime schemas exist, are registered, manifested, packaged, exemplified, and listed by runtime capabilities.
- [ ] Every implementation task has a witnessed RED failure before production code and focused GREEN evidence after it.
- [ ] All three transports pass official-server conformance and independent hostile-fixture tests.
- [ ] Permission, reviewer, injection, approval, replay, retry suppression, crash, redaction, auth, unavailable, and partial-failure suites pass.
- [ ] No call dispatch occurs before journal intent or required exact approval.
- [ ] Recovery never redispatches a call whose external effect is uncertain.
- [ ] Public package declarations contain no SDK or private-store surface.
- [ ] Full release gate and package installation test pass on the repository's supported Node.js/macOS policy.
- [ ] The branch remains `issue/9-scoped-mcp-tools` and the pull request targets `release/v1.0.0`.
