# Agent Skills Host and Superpowers Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production-wired, fail-closed Agent Skills host that discovers only authorized immutable packages, executes audited Superpowers phases, persists real approval pauses, and emits exact skill evidence.

**Architecture:** A metadata-only catalog resolves configured private roots and audited bundled packages into exact descriptor identities. A secure loader publishes complete content-addressed snapshots into private state; a bounded context assembler and finite built-in phase engine use those snapshots without executing package scripts. Approval transitions are bound to the existing run journal and authenticated local control socket, while a separate hash-chained phase history records non-run-state phase progress and evidence.

**Tech Stack:** TypeScript ESM, Node.js latest LTS on macOS, JSON Schema 2020-12, Ajv, canonical JSON/SHA-256, private filesystem stores, Unix-domain socket control, Vitest, npm package acceptance.

**Spec:** `docs/superpowers/specs/2026-08-30-agent-skills-superpowers-design.md`

## Global Constraints

- Test only on the automatically advancing latest Node.js LTS; CI remains one macOS `lts/*` job with `check-latest: true` and no version matrix.
- Production sources are exactly explicitly configured private per-user skill roots plus audited bundled Superpowers packages.
- Configured package directories are current-user mode `0700`; configured regular files are current-user mode `0600` with one link.
- Bundled files are regular, not group/world writable, and must match the installed bundled manifest.
- Project-local `.agents/skills` is never auto-discovered; development receives no implicit or script-execution bypass.
- Discovery reads only name, description, version, source identity, package identity, counts, and declared dependencies.
- Full `SKILL.md`, references, assets, and scripts load only after exact allowed selection.
- Relative paths, symlinks, traversal, mutation, cross-owner content, unbounded input, and ambiguous duplicate identity fail closed.
- External skill scripts are hashed package content but are never executed, imported, evaluated, or spawned in v1.0.0.
- Implicit selection is allowlist-only, resolves one exact version/hash, and blocks on ambiguity.
- Human approval arrives only through the private local control socket and is bound to run, journal head, phase, skill version/hash, approval hash, and operation ID.
- Missing required capability produces `BLOCKED_SUPERPOWERS_MISSING`; the runtime never imitates the missing skill.
- Public APIs return recursively frozen values and never expose absolute package paths, secret values, internal store hooks, or native filesystem objects.
- Keep package version `0.0.0-development`; Issue #15 owns the `1.0.0` version, tag, GitHub Release, and npm publication.

## File and interface map

The implementation uses these focused units:

- `src/skills/types.ts`: public immutable contracts and host interfaces.
- `src/skills/contracts.ts`: five schema parsers, semantic validation, canonical hashes, and catalog hash.
- `src/skills/errors.ts`: closed safe skill error table.
- `src/skills/paths.ts`: lexical/canonical resource-name validation and source-root policy.
- `src/skills/catalog.ts`: metadata-only configured/bundled discovery and exact selection.
- `src/skills/private-store.ts`: content-addressed package objects and append-only phase histories.
- `src/skills/loader.ts`: full post-selection package snapshot and publication.
- `src/skills/context.ts`: deterministic phase-scoped progressive disclosure and accounting.
- `src/skills/phases.ts`: immutable built-in handler policy and handler hashes.
- `src/skills/engine.ts`: phase ordering, phase history, journal pause, completion, recovery, and shutdown.
- `src/skills/approval.ts`: exact approval challenge/decision derivation and replay.
- `src/skills/evidence.ts`: bounded canonical skill evidence handoff.
- `src/skills/index.ts`: self-contained public factory and safe exports only.
- `skills/bundled/**`: audited data-only `SKILL.md` packages and exact bundled manifest; no scripts.

The stable public surface introduced by this plan is:

```ts
export type SuperpowersPhaseName =
  "BRAINSTORMING" | "TEST_DESIGN" | "RED" | "GREEN" | "DEBUGGING" | "REVIEW" | "VERIFICATION";

export interface CreateSkillsHostOptions {
  readonly statePath: string;
  readonly configuredRoots: readonly string[];
  readonly journal: RunJournalStore;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly hasServiceListener: () => Promise<"present" | "absent" | "unknown">;
}

export interface SkillDescriptorReference {
  readonly name: string;
  readonly version: string;
  readonly source: Readonly<{ kind: SkillSourceKind; identity: string }>;
  readonly package_hash: `sha256:${string}`;
  readonly document_hash: `sha256:${string}`;
}

export interface SkillDiscoveryRequest {
  readonly query: string | null;
  readonly allowed_capabilities: readonly string[];
}

export interface SkillCatalogSnapshot {
  readonly catalog_hash: `sha256:${string}`;
  readonly descriptors: readonly SkillDescriptorV1[];
}

export interface SkillSelection {
  readonly catalog_hash: `sha256:${string}`;
  readonly descriptor: SkillDescriptorReference;
  readonly selection_hash: `sha256:${string}`;
}

export interface SkillContextRequest {
  readonly selection: SkillSelection;
  readonly snapshot_hash: `sha256:${string}`;
  readonly phase: SuperpowersPhaseName;
  readonly max_bytes: number;
  readonly max_tokens: number;
}

export interface SkillContextSegment {
  readonly path: string;
  readonly role: "skill" | "reference" | "asset";
  readonly source_hash: `sha256:${string}`;
  readonly included_hash: `sha256:${string}`;
  readonly original_bytes: number;
  readonly included_bytes: number;
  readonly conservative_tokens: number;
  readonly content: string;
}

export interface SkillContext {
  readonly snapshot_hash: `sha256:${string}`;
  readonly phase: SuperpowersPhaseName;
  readonly segments: readonly SkillContextSegment[];
  readonly omitted_resource_hashes: readonly `sha256:${string}`[];
  readonly truncations: readonly Readonly<{
    path: string;
    original_bytes: number;
    included_bytes: number;
  }>[];
  readonly total_bytes: number;
  readonly total_tokens: number;
  readonly remaining_bytes: number;
  readonly remaining_tokens: number;
  readonly context_hash: `sha256:${string}`;
}

export interface StartSuperpowersPhaseRequest {
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly execution_request_hash: `sha256:${string}`;
  readonly selection: SkillSelection;
  readonly phase: SuperpowersPhaseName;
  readonly input: Uint8Array;
  readonly operation_id: string;
  readonly trace: TraceContext;
}

export interface CompleteSuperpowersPhaseRequest {
  readonly run_id: string;
  readonly expected_phase_revision: number;
  readonly expected_phase_head_hash: `sha256:${string}`;
  readonly phase: SuperpowersPhaseName;
  readonly skill_snapshot_hash: `sha256:${string}`;
  readonly operation_id: string;
  readonly outcome: "COMPLETED" | "FAILED" | "BLOCKED";
  readonly output: Uint8Array;
  readonly trace: TraceContext;
}

export interface ResumeSuperpowersApprovalRequest {
  readonly run_id: string;
  readonly expected_journal_head: JournalHead;
  readonly phase: SuperpowersPhaseName;
  readonly skill_name: string;
  readonly skill_version: string;
  readonly skill_snapshot_hash: `sha256:${string}`;
  readonly approval_request_hash: `sha256:${string}`;
  readonly operation_id: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly trace: TraceContext;
}

export interface SuperpowersPhaseOutcome {
  readonly state: "RUNNING" | "APPROVAL_PENDING" | "BLOCKED";
  readonly phase: SuperpowersPhaseV1;
  readonly journal_head: JournalHead;
  readonly approval: SuperpowersApprovalV1 | null;
  readonly replayed: boolean;
}

export interface SkillsHost {
  recover(): Promise<void>;
  discover(request: SkillDiscoveryRequest): Promise<SkillCatalogSnapshot>;
  select(request: SkillSelectionRequest): Promise<SkillSelection>;
  load(selection: SkillSelection): Promise<SkillSnapshotV1>;
  assembleContext(request: SkillContextRequest): Promise<SkillContext>;
  startPhase(request: StartSuperpowersPhaseRequest): Promise<SuperpowersPhaseOutcome>;
  completePhase(request: CompleteSuperpowersPhaseRequest): Promise<SuperpowersPhaseOutcome>;
  resumeApproval(request: ResumeSuperpowersApprovalRequest): Promise<SuperpowersPhaseOutcome>;
  evidence(runId: string): Promise<SkillExecutionEvidenceV1 | null>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
}
```

Exact fixed limits used throughout the plan are:

```ts
export const SKILL_LIMITS = Object.freeze({
  roots: 16,
  packagesPerRoot: 256,
  resourcesPerPackage: 256,
  nestingDepth: 8,
  descriptorBytes: 65_536,
  skillMarkdownBytes: 524_288,
  resourceBytes: 2_097_152,
  packageBytes: 16_777_216,
  storedObjectBytes: 25_165_824,
  phaseInputBytes: 2_097_152,
  phaseOutputBytes: 2_097_152,
  evidenceBytes: 2_097_152,
  queryBytes: 512,
});
```

---

### Task 1: Closed skill contracts, hashes, types, and errors

**Files:**

- Create: `contracts/runtime/skill-descriptor.v1.schema.json`
- Create: `contracts/runtime/skill-snapshot.v1.schema.json`
- Create: `contracts/runtime/superpowers-phase.v1.schema.json`
- Create: `contracts/runtime/superpowers-approval.v1.schema.json`
- Create: `contracts/runtime/skill-execution-evidence.v1.schema.json`
- Create: `src/skills/types.ts`
- Create: `src/skills/contracts.ts`
- Create: `src/skills/errors.ts`
- Create: `test/support/skill-fixtures.ts`
- Create: `test/skill-contracts.test.ts`
- Modify: `src/protocol/validator.ts`
- Modify: `docs/contracts/runtime-contract-v1.manifest.json`

**Interfaces:**

- Consumes: `RuntimeDocument`, `TraceContext`, `JournalHead`, `RunJournalStore`, `canonicalJson`, `deepFreezeJson`, `sha256`, and `createProtocolValidator`.
- Produces: `SkillDescriptorV1`, `SkillSnapshotV1`, `SuperpowersPhaseV1`, `SuperpowersApprovalV1`, `SkillExecutionEvidenceV1`, their hashable forms, `RuntimeSkillError`, five parsers, five document hash functions, and `hashSkillCatalog`.

- [ ] **Step 1: Write closed-schema and semantic RED tests**

  Build exact valid fixtures in `test/support/skill-fixtures.ts`, then assert all five public parsers accept canonical bytes and reject unknown keys, duplicate resources, non-ASCII ordering, uppercase hashes, bad document hashes, invalid phase/status combinations, inconsistent byte totals, unbound approval fields, and evidence whose phase/resource hashes are not unique.

  ```ts
  it.each([
    ["descriptor", parseSkillDescriptor, validSkillDescriptor()],
    ["snapshot", parseSkillSnapshot, validSkillSnapshot()],
    ["phase", parseSuperpowersPhase, validSuperpowersPhase()],
    ["approval", parseSuperpowersApproval, validSuperpowersApproval()],
    ["evidence", parseSkillExecutionEvidence, validSkillExecutionEvidence()],
  ])("parses and recursively freezes canonical %s documents", (_name, parse, fixture) => {
    const parsed = parse(canonicalJson(fixture));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.isFrozen(parsed.value)).toBe(true);
  });

  it("rejects an approval whose skill identity changed without a new document hash", () => {
    const original = validSuperpowersApproval();
    const mutated = {
      ...original,
      skill_snapshot_hash: `sha256:${"f".repeat(64)}`,
    };
    expect(parseSuperpowersApproval(canonicalJson(mutated))).toMatchObject({
      ok: false,
      code: "RUNTIME_DOCUMENT_INVALID",
    });
  });
  ```

- [ ] **Step 2: Run the contract test and capture the expected RED**

  Run under a runtime where `process.release.lts` is truthy:

  ```bash
  node -e 'if (!process.release.lts) process.exit(1)'
  npm exec -- vitest run test/skill-contracts.test.ts --maxWorkers=4
  ```

  Expected: FAIL because `src/skills/contracts.js`, types, errors, and five schemas do not exist.

- [ ] **Step 3: Implement the exact document types and hash rules**

  Use closed discriminated documents with these identities:

  ```ts
  export type SkillSourceKind = "configured" | "bundled";
  export type SkillResourceRole = "reference" | "asset" | "script";
  export type SuperpowersPhaseStatus =
    "STARTED" | "APPROVAL_PENDING" | "COMPLETED" | "FAILED" | "BLOCKED";

  export interface SkillDescriptorV1 extends RuntimeDocument {
    readonly protocol_version: "runtime-contract.v1";
    readonly schema_version: "skill-descriptor.v1";
    readonly document_type: "skill-descriptor";
    readonly name: string;
    readonly description: string;
    readonly version: string;
    readonly source: Readonly<{ kind: SkillSourceKind; identity: string }>;
    readonly package_hash: `sha256:${string}`;
    readonly resource_count: number;
    readonly total_bytes: number;
    readonly required_runtime_capabilities: readonly string[];
    readonly document_hash: `sha256:${string}`;
  }

  export interface SkillResourceV1 {
    readonly path: string;
    readonly role: SkillResourceRole;
    readonly media_type: string;
    readonly bytes: number;
    readonly hash: `sha256:${string}`;
  }

  export interface SkillSnapshotV1 extends RuntimeDocument {
    readonly protocol_version: "runtime-contract.v1";
    readonly schema_version: "skill-snapshot.v1";
    readonly document_type: "skill-snapshot";
    readonly descriptor: SkillDescriptorV1;
    readonly skill_markdown_hash: `sha256:${string}`;
    readonly skill_markdown_bytes: number;
    readonly resources: readonly SkillResourceV1[];
    readonly package_hash: `sha256:${string}`;
    readonly total_bytes: number;
    readonly document_hash: `sha256:${string}`;
  }

  export interface SuperpowersPhaseV1 extends RuntimeDocument {
    readonly protocol_version: "runtime-contract.v1";
    readonly schema_version: "superpowers-phase.v1";
    readonly document_type: "superpowers-phase";
    readonly run_id: string;
    readonly phase_revision: number;
    readonly previous_phase_hash: `sha256:${string}`;
    readonly execution_request_hash: `sha256:${string}`;
    readonly observed_journal_head: JournalHead;
    readonly skill: Readonly<{
      name: string;
      version: string;
      snapshot_hash: `sha256:${string}`;
    }>;
    readonly phase: SuperpowersPhaseName;
    readonly handler: Readonly<{ version: string; hash: `sha256:${string}` }>;
    readonly operation_id: string;
    readonly status: SuperpowersPhaseStatus;
    readonly input_hash: `sha256:${string}`;
    readonly output_hash: `sha256:${string}` | null;
    readonly occurred_at: string;
    readonly trace: TraceContext;
    readonly document_hash: `sha256:${string}`;
  }

  export type SuperpowersApprovalV1 = SuperpowersApprovalRequestV1 | SuperpowersApprovalDecisionV1;

  export interface SuperpowersApprovalRequestV1 extends RuntimeDocument {
    readonly protocol_version: "runtime-contract.v1";
    readonly schema_version: "superpowers-approval.v1";
    readonly document_type: "superpowers-approval";
    readonly kind: "REQUEST";
    readonly run_id: string;
    readonly pending_journal_head: JournalHead;
    readonly phase_document_hash: `sha256:${string}`;
    readonly phase: SuperpowersPhaseName;
    readonly skill_name: string;
    readonly skill_version: string;
    readonly skill_snapshot_hash: `sha256:${string}`;
    readonly phase_operation_id: string;
    readonly decision: null;
    readonly trace: TraceContext;
    readonly document_hash: `sha256:${string}`;
  }

  export interface SuperpowersApprovalDecisionV1 extends RuntimeDocument {
    readonly protocol_version: "runtime-contract.v1";
    readonly schema_version: "superpowers-approval.v1";
    readonly document_type: "superpowers-approval";
    readonly kind: "DECISION";
    readonly run_id: string;
    readonly pending_journal_head: JournalHead;
    readonly phase_document_hash: `sha256:${string}`;
    readonly phase: SuperpowersPhaseName;
    readonly skill_name: string;
    readonly skill_version: string;
    readonly skill_snapshot_hash: `sha256:${string}`;
    readonly phase_operation_id: string;
    readonly approval_request_hash: `sha256:${string}`;
    readonly operation_id: string;
    readonly decision: "APPROVE" | "REJECT";
    readonly trace: TraceContext;
    readonly document_hash: `sha256:${string}`;
  }

  export interface SkillExecutionEvidenceV1 extends RuntimeDocument {
    readonly protocol_version: "runtime-contract.v1";
    readonly schema_version: "skill-execution-evidence.v1";
    readonly document_type: "skill-execution-evidence";
    readonly run_id: string;
    readonly catalog_hash: `sha256:${string}`;
    readonly skill: SkillDescriptorReference & Readonly<{ snapshot_hash: `sha256:${string}` }>;
    readonly resource_hashes: readonly `sha256:${string}`[];
    readonly phases: readonly Readonly<{
      phase: SuperpowersPhaseName;
      handler_hash: `sha256:${string}`;
      phase_hash: `sha256:${string}`;
      input_hash: `sha256:${string}`;
      output_hash: `sha256:${string}` | null;
    }>[];
    readonly approvals: readonly Readonly<{
      request_hash: `sha256:${string}`;
      decision_hash: `sha256:${string}` | null;
      journal_head: JournalHead;
    }>[];
    readonly context_hashes: readonly `sha256:${string}`[];
    readonly handoff_hash: `sha256:${string}`;
    readonly terminal_code: RuntimeSkillErrorCode | null;
    readonly document_hash: `sha256:${string}`;
  }
  ```

  `package_hash` is SHA-256 over intrinsic package metadata (`name`, `description`, `version`, required runtime capabilities, exact `SKILL.md` bytes/hash metadata) plus the ordered `{path, role, media_type, bytes, hash}` resource manifest; it excludes source identity and both derived hashes, so identical package bytes retain one content identity across authorized roots. `document_hash` is SHA-256 over the finished document with only `document_hash` omitted. Every parser re-computes its document hash; the snapshot parser additionally re-computes package hash and aggregate accounting from its descriptor, `skill_markdown_bytes`, `skill_markdown_hash`, and resources. Parsers require ASCII ordering, reject duplicates, apply `SKILL_LIMITS`, and return deep-frozen data.

  Add the closed safe error table:

  ```ts
  export type RuntimeSkillErrorCode =
    | "BLOCKED_SUPERPOWERS_MISSING"
    | "RUNTIME_SKILL_INVALID"
    | "RUNTIME_SKILL_PATH_UNSAFE"
    | "RUNTIME_SKILL_INTEGRITY"
    | "RUNTIME_SKILL_LIMIT_EXCEEDED"
    | "RUNTIME_SKILL_CONTEXT_OVERFLOW"
    | "RUNTIME_SKILL_SCRIPT_UNAVAILABLE"
    | "RUNTIME_SKILL_STALE_STATE"
    | "RUNTIME_SKILL_OPERATION_CONFLICT"
    | "RUNTIME_SKILL_UNAVAILABLE";
  ```

- [ ] **Step 4: Register every schema and prove manifest completeness**

  Import and add the five schemas in `src/protocol/validator.ts`, add exact version-to-`$id` mappings to `REGISTERED_SCHEMAS`, and insert the five ASCII-sorted entries in `runtime-contract-v1.manifest.json`. Extend the test to enumerate `contracts/runtime` and prove no new schema is unregistered.

- [ ] **Step 5: Run focused GREEN gates**

  ```bash
  npm exec -- vitest run test/skill-contracts.test.ts test/protocol-validator.test.ts test/documentation-integrity.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  ```

  Expected: all tests pass with no TypeScript or ESLint diagnostics.

- [ ] **Step 6: Commit Task 1**

  ```bash
  git add contracts/runtime/skill-descriptor.v1.schema.json contracts/runtime/skill-snapshot.v1.schema.json contracts/runtime/superpowers-phase.v1.schema.json contracts/runtime/superpowers-approval.v1.schema.json contracts/runtime/skill-execution-evidence.v1.schema.json src/skills/types.ts src/skills/contracts.ts src/skills/errors.ts src/protocol/validator.ts test/support/skill-fixtures.ts test/skill-contracts.test.ts docs/contracts/runtime-contract-v1.manifest.json
  git commit -m "feat: define agent skill contracts"
  ```

### Task 2: Explicit skill-root configuration and source policy

**Files:**

- Create: `src/skills/paths.ts`
- Create: `test/skill-paths.test.ts`
- Modify: `contracts/runtime/runtime-config.v1.schema.json`
- Modify: `src/config/types.ts`
- Modify: `src/config/load.ts`
- Modify: `test/config.test.ts`
- Modify: `examples/config/runtime.development.yaml`

**Interfaces:**

- Consumes: `RuntimeConfigV1`, platform path rules, `SKILL_LIMITS.roots`, and `RuntimeSkillError`.
- Produces: `config.skill_roots: readonly string[]`, `assertConfiguredSkillRootPath(path)`, `assertSkillRelativePath(path)`, and `portableSkillPath(path)`.

- [ ] **Step 1: Write configuration and lexical-path RED tests**

  Cover empty defaults, ASCII-sorted unique absolute roots, more than 16 roots, relative roots, control characters, normalization aliases, root overlap, `..`, absolute resource names, empty components, backslash aliases, depth greater than eight, and reserved internal names.

  ```ts
  it("defaults to bundled skills without scanning a user or project root", () => {
    expect(defaultConfig("darwin", "/Users/test").skill_roots).toEqual([]);
  });

  it.each(["../escape", "/absolute", "refs//x", "refs/./x", "refs/a/../../x"])(
    "rejects unsafe resource path %s",
    (candidate) => {
      expect(() => assertSkillRelativePath(candidate)).toThrowError(
        new RuntimeSkillError("RUNTIME_SKILL_PATH_UNSAFE"),
      );
    },
  );
  ```

- [ ] **Step 2: Run the path/config tests and capture RED**

  ```bash
  npm exec -- vitest run test/skill-paths.test.ts test/config.test.ts --maxWorkers=4
  ```

  Expected: FAIL because `skill_roots` and path helpers are absent.

- [ ] **Step 3: Add the closed configuration field**

  Add required `skill_roots` to the schema and type:

  ```ts
  readonly skill_roots: readonly string[];
  ```

  Schema constraints are `maxItems: 16`, `uniqueItems: true`, string length 1–4096. `defaultConfig()` sets `skill_roots: []`. `assertConfig()` requires absolute normalized paths, ASCII order, no duplicates, no ancestor/descendant overlap, and no control characters. Do not infer home, workspace, current-directory, `.agents/skills`, or environment roots.

- [ ] **Step 4: Implement portable relative-path validation**

  `assertSkillRelativePath()` accepts only `/`-separated portable names, rejects `.`/`..`/empty components, NUL/control bytes, leading slash, `\`, more than eight components, and these internal basenames at any level: `.git`, `.toss`, `.superpowers`, `.stage`, `.claim`. Return one normalized string without touching the filesystem.

- [ ] **Step 5: Update the development config example and run GREEN**

  The published example must contain:

  ```yaml
  skill_roots: []
  ```

  Run:

  ```bash
  npm exec -- vitest run test/skill-paths.test.ts test/config.test.ts test/documentation-integrity.test.ts --maxWorkers=4
  npm run typecheck
  ```

- [ ] **Step 6: Commit Task 2**

  ```bash
  git add contracts/runtime/runtime-config.v1.schema.json src/config/types.ts src/config/load.ts src/skills/paths.ts test/skill-paths.test.ts test/config.test.ts examples/config/runtime.development.yaml
  git commit -m "feat: configure explicit skill roots"
  ```

### Task 3: Metadata-only configured and bundled catalog

**Files:**

- Create: `src/skills/catalog.ts`
- Create: `src/skills/bundled.ts`
- Create: `skills/bundled/manifest.json`
- Create: `skills/bundled/brainstorming/SKILL.md`
- Create: `skills/bundled/test-driven-development/SKILL.md`
- Create: `skills/bundled/systematic-debugging/SKILL.md`
- Create: `skills/bundled/requesting-code-review/SKILL.md`
- Create: `skills/bundled/verification-before-completion/SKILL.md`
- Create: `test/skill-catalog.test.ts`

**Interfaces:**

- Consumes: `SkillDescriptorV1`, path policy, explicit roots, bundled manifest, clocks/identity test seams, and the Task 1 parsers.
- Produces: internal `SkillCatalog`, `SkillCatalogSnapshot`, `SkillDiscoveryRequest`, `SkillSelectionRequest`, and `SkillSelection`.

- [ ] **Step 1: Write catalog discovery and selection RED tests**

  Build private real-filesystem fixtures and assert:

  - catalog discovery reads only each `skill.json` package manifest, never `SKILL.md` or resources;
  - configured roots require exact current UID, `0700` directories, `0600` single-link manifest files, no symlink ancestry, and stable bigint identity;
  - bundled files must match `skills/bundled/manifest.json` and cannot be group/world writable;
  - query matching uses bounded normalized name/description metadata only;
  - explicit selection requires the exact reference;
  - implicit selection intersects the caller's allowed capabilities and blocks zero or multiple exact candidates;
  - duplicate semantic name/version/source identities with different bytes are integrity failures;
  - mutation during metadata read and more than 256 packages fail closed.

  ```ts
  it("does not read unselected SKILL.md or resource bytes", async () => {
    const reads: string[] = [];
    const catalog = createSkillCatalogForTest(
      fixtureOptions({ onFileRead: (name) => reads.push(name) }),
    );
    const snapshot = await catalog.discover({
      query: "testing",
      allowed_capabilities: ["test-driven-development"],
    });
    expect(snapshot.descriptors.map((entry) => entry.name)).toEqual(["test-driven-development"]);
    expect(
      reads.every((name) => name.endsWith("skill.json") || name.endsWith("manifest.json")),
    ).toBe(true);
  });
  ```

- [ ] **Step 2: Run catalog tests and capture RED**

  ```bash
  npm exec -- vitest run test/skill-catalog.test.ts --maxWorkers=4
  ```

  Expected: FAIL because catalog, bundled manifest, and packages are absent.

- [ ] **Step 3: Author audited data-only bundled packages**

  Each bundled `SKILL.md` contains bounded TOSS-specific phase intent and explicitly states that it grants no tool, process, filesystem, approval, or governance authority. No bundled directory contains `scripts/`. The manifest records exact relative file path, bytes, media type, SHA-256, package hash, handler capability, and handler policy version. `src/skills/bundled.ts` verifies the installed files against the manifest before advertising them.

- [ ] **Step 4: Implement streaming metadata discovery**

  Define one internal closed `SkillPackageManifest` for `skill.json`: `name`, `description`, `version`, ASCII-sorted `required_runtime_capabilities`, exact `SKILL.md` bytes/hash metadata, complete resource declarations, declared totals, and `package_hash`, with no source/path authority field. Open roots and manifests with no-follow semantics, validate held manifest/path bigint identity before and after reads, check size before allocation, enforce exact modes/source-specific policy, and keep canonical absolute paths only in private catalog entries.

  Construct the public `SkillDescriptorV1` rather than trusting one from disk. For configured packages, compute `source.identity` as SHA-256 of the root and package-directory bigint device/inode identities; for bundled packages, compute it from the verified bundled manifest hash. Neither identity contains an absolute path. Returned descriptors and selections must not contain locations.

  Implement deterministic selection:

  ```ts
  export interface SkillSelectionRequest {
    readonly mode: "explicit" | "implicit";
    readonly capability: string;
    readonly allowed_capabilities: readonly string[];
    readonly query: string | null;
    readonly descriptor: SkillDescriptorReference | null;
  }
  ```

  Explicit mode requires `descriptor` and exact catalog equality. Implicit mode requires `descriptor === null`, the capability in `allowed_capabilities`, and exactly one descriptor whose name equals the capability and whose normalized metadata matches the query. Return `BLOCKED_SUPERPOWERS_MISSING` for no candidate and `RUNTIME_SKILL_INTEGRITY` for ambiguity.

- [ ] **Step 5: Add race, alias, permission, and bounded-enumeration GREEN coverage**

  Use deterministic hooks around manifest open/read/revalidation and tables for symlink, directory, FIFO, hardlink, cross-owner modeled UID, special mode bits, case alias, same inode, overflow, missing bundled file, altered bundled byte, and manifest mutation.

  ```bash
  npm exec -- vitest run test/skill-catalog.test.ts test/skill-contracts.test.ts test/skill-paths.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  ```

- [ ] **Step 6: Commit Task 3**

  ```bash
  git add src/skills/catalog.ts src/skills/bundled.ts skills/bundled test/skill-catalog.test.ts
  git commit -m "feat: discover authorized skill metadata"
  ```

### Task 4: Complete immutable snapshot loading and private publication

**Files:**

- Create: `src/skills/private-store.ts`
- Create: `src/skills/loader.ts`
- Create: `test/skill-private-store.test.ts`
- Create: `test/skill-loader.test.ts`

**Interfaces:**

- Consumes: private catalog selection handles, `SkillSnapshotV1`, `SKILL_LIMITS`, `hasServiceListener`, `now`, `randomId`, and source-specific path policy.
- Produces: internal `SkillPrivateStore`, `SkillLoader`, persisted content-addressed package objects, and `load(selection): Promise<SkillSnapshotV1>`.

- [ ] **Step 1: Write loader and private-store RED tests**

  Cover complete `SKILL.md` plus every declared reference/asset/script, deterministic ASCII manifest ordering, binary asset hashing, missing/extra resources, traversal, symlink, hardlink, devices, wrong owner/mode, invalid text UTF-8, per-file/package/count/growth limits, mutation at every async hook, same-hash replay, conflicting bytes, two host instances, restrictive/permissive umask, and crash recovery around stage write/file sync/link/directory sync/stage cleanup.

  ```ts
  it("hashes scripts but never executes or imports them", async () => {
    const processes: string[] = [];
    const snapshot = await loaderForFixture({
      onProcess: (command) => processes.push(command),
    }).load(selection());
    expect(snapshot.resources.some((resource) => resource.role === "script")).toBe(true);
    expect(processes).toEqual([]);
  });
  ```

- [ ] **Step 2: Run focused tests and capture RED**

  ```bash
  npm exec -- vitest run test/skill-private-store.test.ts test/skill-loader.test.ts --maxWorkers=4
  ```

  Expected: FAIL because loader/store modules are absent.

- [ ] **Step 3: Implement exact full loading**

  Re-open the selected package by the catalog's private canonical identity; do not accept a caller path. Enumerate exactly the declared set. Hold each file descriptor through bounded read and hash; revalidate file, package directory, root chain, and complete entry set after asynchronous hooks. Reject any mismatch without falling through to a second candidate.

  The stored object is one canonical private record under `statePath/skills/objects/<package-hash>.json` containing the public snapshot plus base64 resource bytes. Its maximum serialized size is `SKILL_LIMITS.storedObjectBytes`; decoded resource accounting must equal the snapshot.

- [ ] **Step 4: Implement no-overwrite private publication and recovery**

  Follow the repository's existing held-descriptor pattern: exact `0700` directories, `0600` files, operation-owned stage, file sync, no-overwrite publication, directory sync, identity/bytes revalidation, exact stage cleanup with another directory sync, and mandatory listener probe for mutation-claim recovery. Live/unknown listener, unexpected entries, replacement, or an unrecognized stage fails closed. Reads retry file and parent directory durability barriers before replay.

- [ ] **Step 5: Prove idempotency, concurrency, and restart recovery GREEN**

  Run each crash-hook table three times and include two loaders using canonical path aliases. Assert one object, byte-identical replay, no residual stage/claim, and no process execution.

  ```bash
  npm exec -- vitest run test/skill-private-store.test.ts test/skill-loader.test.ts --maxWorkers=4 --repeat=3
  npm run typecheck
  npm run lint
  ```

- [ ] **Step 6: Commit Task 4**

  ```bash
  git add src/skills/private-store.ts src/skills/loader.ts test/skill-private-store.test.ts test/skill-loader.test.ts
  git commit -m "feat: load immutable skill snapshots"
  ```

### Task 5: Progressive disclosure and deterministic context accounting

**Files:**

- Create: `src/skills/context.ts`
- Create: `test/skill-context.test.ts`

**Interfaces:**

- Consumes: persisted `SkillSnapshotV1`, exact stored resources, `SuperpowersPhaseName`, phase input budget, and the runtime's conservative UTF-8/token accounting rule.
- Produces: `SkillContextRequest`, immutable `SkillContext`, `SkillContextSegment`, and `assembleSkillContext()`.

- [ ] **Step 1: Write progressive-disclosure RED tests**

  Assert discovery contributes no bodies; context always includes complete `SKILL.md`; only references declared for the requested phase are materialized; unused assets/scripts remain hash-only; ordering is deterministic across caller permutations; mandatory overflow fails without truncation; optional content follows priority/path order and emits exact truncation records; Unicode counts UTF-8 bytes; and no absolute source path, environment value, secret-like metadata key, or executable handle appears.

  ```ts
  it("fails before phase execution when mandatory content exceeds its budget", async () => {
    await expect(
      assembleSkillContext({
        snapshot: oversizedMandatorySnapshot(),
        phase: "RED",
        max_bytes: 1024,
        max_tokens: 256,
      }),
    ).rejects.toThrowError(new RuntimeSkillError("RUNTIME_SKILL_CONTEXT_OVERFLOW"));
  });
  ```

- [ ] **Step 2: Run the context test and capture RED**

  ```bash
  npm exec -- vitest run test/skill-context.test.ts --maxWorkers=4
  ```

- [ ] **Step 3: Implement canonical phase resource projection**

  `SkillContext` contains snapshot identity, phase, ordered segments, included/omitted resource hashes, original/included UTF-8 bytes, conservative tokens using `ceil(bytes / 4)`, remaining budgets, truncation records, and a context hash. Mandatory `SKILL.md` and phase-required references must fit in full. Optional references are considered by declared priority then portable path; scripts are never content segments.

- [ ] **Step 4: Add secret/path and permutation mutation witnesses**

  Temporarily disable one production guard at a time to prove tests fail for absolute-location leakage, script inclusion, byte miscount, input-order dependence, and silent mandatory truncation; restore each guard and rerun GREEN.

- [ ] **Step 5: Run focused GREEN gates and commit**

  ```bash
  npm exec -- vitest run test/skill-context.test.ts test/skill-loader.test.ts test/skill-contracts.test.ts --maxWorkers=4
  npm run typecheck
  git add src/skills/context.ts test/skill-context.test.ts
  git commit -m "feat: assemble bounded skill context"
  ```

### Task 6: Built-in phase policy, hash-chained phase history, and engine

**Files:**

- Create: `src/skills/phases.ts`
- Create: `src/skills/engine.ts`
- Create: `test/skill-phases.test.ts`
- Create: `test/skill-engine.test.ts`

**Interfaces:**

- Consumes: catalog, loader, context assembler, private store, `RunJournalStore`, `SuperpowersPhaseV1`, exact journal heads, input/output bytes, clocks, IDs, and trace context.
- Produces: immutable `BUILTIN_SUPERPOWERS_POLICY`, `hashBuiltInPhasePolicy()`, `startPhase()`, `completePhase()`, phase history recovery, and the `SkillsHost` lifecycle skeleton.

- [ ] **Step 1: Write phase-policy and ordering RED tests**

  Lock the mapping and predecessor rules:

  ```ts
  const EXPECTED_PHASES = {
    brainstorming: ["BRAINSTORMING"],
    "test-driven-development": ["TEST_DESIGN", "RED", "GREEN"],
    "systematic-debugging": ["DEBUGGING"],
    "requesting-code-review": ["REVIEW"],
    "verification-before-completion": ["VERIFICATION"],
  } as const;
  ```

  Require `TEST_DESIGN -> RED -> GREEN`, `DEBUGGING` only after exact RED evidence, `REVIEW` after GREEN, and `VERIFICATION` after GREEN plus every requested debugging/review predecessor. Prove one phase cannot be relabeled as another and handler policy mutation changes its hash.

- [ ] **Step 2: Write phase-history durability and lifecycle RED tests**

  Cover first record, previous-record hash, operation replay/conflict, stale journal head, wrong snapshot, wrong handler hash, bounded input/output, crash hooks for append/recovery, partial tail quarantine, two hosts, stop/flush, no post-stop root creation, and restart rebuilding exact state.

- [ ] **Step 3: Run phase tests and capture RED**

  ```bash
  npm exec -- vitest run test/skill-phases.test.ts test/skill-engine.test.ts --maxWorkers=4
  ```

- [ ] **Step 4: Implement immutable built-in handlers and phase history**

  Built-in handlers validate policy/predecessors and build contexts; they do not call models, tools, processes, or governance APIs. Persist `superpowers-phase.v1` records in `statePath/skills/phases/<run-id>.jsonl` with a monotonically increasing phase revision and previous-record hash. Every record binds the exact run journal head observed at phase start, execution-request hash, skill snapshot, handler hash, operation ID, input hash, and bounded output hash/status.

- [ ] **Step 5: Implement start/completion semantics**

  `startPhase()` verifies the run exists and the caller's exact current head, loads the selected snapshot by hash, enforces predecessors, hashes caller-owned input bytes, and appends `STARTED`. `completePhase()` verifies the exact unmatched start and output bytes, then appends `COMPLETED`, `FAILED`, or `BLOCKED`. `BRAINSTORMING` completion does not append `COMPLETED`; it delegates to the approval transaction in Task 7.

- [ ] **Step 6: Run focused GREEN and commit**

  ```bash
  npm exec -- vitest run test/skill-phases.test.ts test/skill-engine.test.ts test/journal-state-machine.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add src/skills/phases.ts src/skills/engine.ts test/skill-phases.test.ts test/skill-engine.test.ts
  git commit -m "feat: execute governed Superpowers phases"
  ```

### Task 7: Durable approval, exact resume, and local control channel

**Files:**

- Create: `src/skills/approval.ts`
- Create: `test/skill-approval.test.ts`
- Modify: `contracts/runtime/service-control-request.v1.schema.json`
- Modify: `contracts/runtime/service-control-response.v1.schema.json`
- Modify: `src/service/contracts.ts`
- Modify: `src/service/control.ts`
- Modify: `src/service/errors.ts`
- Modify: `test/service-contracts.test.ts`
- Modify: `test/service-control.test.ts`

**Interfaces:**

- Consumes: `RunJournalStore`, phase history, exact `JournalHead`, `SuperpowersApprovalV1`, local control request cache, and `RuntimeSkillError`.
- Produces: `ResumeSuperpowersApprovalRequest`, `SuperpowersApprovalDataV1`, `requestSuperpowersApproval()`, `handleSkillRequest`, and approval replay/rejection outcomes.

- [ ] **Step 1: Write approval transaction RED tests**

  Start a real `BRAINSTORMING` phase and assert the host:

  1. durably appends the phase `APPROVAL_PENDING` record;
  2. transitions the main run journal from `RUNNING` to `APPROVAL_PENDING` with the phase record/hash in safe metadata;
  3. returns the challenge only after both barriers;
  4. reconstructs the byte-identical challenge after restart;
  5. accepts only exact approval bindings;
  6. transitions `APPROVE` to `RUNNING` and `REJECT` to `BLOCKED`;
  7. replays an identical operation without file growth;
  8. rejects old head, other run, phase, skill name/version/hash, approval hash, decision, or reused operation ID.

  ```ts
  expect(pending.state).toBe("APPROVAL_PENDING");
  await expect(
    host.resumeApproval({ ...exactApproval, skill_version: "9.9.9" }),
  ).rejects.toThrowError(new RuntimeSkillError("RUNTIME_SKILL_STALE_STATE"));
  expect(await host.resumeApproval(exactApproval)).toMatchObject({
    state: "RUNNING",
    replayed: false,
  });
  expect(await host.resumeApproval(exactApproval)).toMatchObject({
    state: "RUNNING",
    replayed: true,
  });
  ```

- [ ] **Step 2: Write real-socket RED tests**

  Add `superpowers-approve` to the closed request union with exact fields:

  ```ts
  interface ServiceSuperpowersApproveRequestV1 {
    readonly command: "superpowers-approve";
    readonly request_id: string;
    readonly operation_id: string;
    readonly run_id: string;
    readonly expected_journal_revision: number;
    readonly expected_journal_head_hash: `sha256:${string}`;
    readonly phase: SuperpowersPhaseName;
    readonly skill_name: string;
    readonly skill_version: string;
    readonly skill_snapshot_hash: `sha256:${string}`;
    readonly approval_request_hash: `sha256:${string}`;
    readonly decision: "APPROVE" | "REJECT";
  }
  ```

  Through a real private Unix socket, prove canonical request/response, cache replay, cache conflict, stale error mapping, malformed UUID/hash/version rejection, post-stop rejection, connection drain, and no approval through status/project/model/skill text paths.

- [ ] **Step 3: Run approval/control tests and capture RED**

  ```bash
  npm exec -- vitest run test/skill-approval.test.ts test/service-contracts.test.ts test/service-control.test.ts --maxWorkers=4
  ```

- [ ] **Step 4: Implement the phase-first, journal-bound approval transaction**

  Derive the approval challenge from the exact phase pending record and the new `APPROVAL_PENDING` journal head. Put the full validated phase record in the journal transition metadata, then expose the challenge. On resume, reload both histories, recompute the challenge, validate every caller binding, and use the operation ID for journal idempotency. Model output and skill bytes are never accepted as an approval source.

  Recovery classifies the two-file transaction exactly. A phase `APPROVAL_PENDING` record plus the unchanged observed `RUNNING` journal head completes the same idempotent pending transition. The same phase record plus a matching main-journal `APPROVAL_PENDING` entry reconstructs the challenge. A main journal that advanced to any other entry, mismatched metadata, a missing phase predecessor, or an approval entry without its exact phase record is integrity/stale failure and is never auto-repaired into approval.

- [ ] **Step 5: Extend service contracts without widening project handlers**

  Add a distinct `handleSkillRequest` option to `createServiceControlServer`; do not pass skill requests to `handleProjectRequest`. Add `SuperpowersApprovalDataV1` to the response data union and exact `RuntimeSkillError` branches to the closed response schema. `throwControlFailure()` must reconstruct only known skill errors and normalize forged/unknown errors to `RUNTIME_SERVICE_UNAVAILABLE`.

- [ ] **Step 6: Close interruption and recovery boundaries**

  Add hooks around phase append, main-journal pending transition, response publication, approval transition, and phase-history sync. Prove every crash boundary converges to either the same durable pause or the same durable decision, never auto-approval, duplicate phase completion, or false success.

- [ ] **Step 7: Run GREEN gates and commit**

  ```bash
  npm exec -- vitest run test/skill-approval.test.ts test/skill-engine.test.ts test/service-contracts.test.ts test/service-control.test.ts test/journal-store.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add src/skills/approval.ts src/service/contracts.ts src/service/control.ts src/service/errors.ts contracts/runtime/service-control-request.v1.schema.json contracts/runtime/service-control-response.v1.schema.json test/skill-approval.test.ts test/service-contracts.test.ts test/service-control.test.ts
  git commit -m "feat: persist Superpowers approval gates"
  ```

### Task 8: Evidence, public factory, capabilities, and production service wiring

**Files:**

- Create: `src/skills/evidence.ts`
- Create: `test/skill-evidence.test.ts`
- Create: `test/skill-public-api.test.ts`
- Modify: `src/skills/index.ts`
- Modify: `src/index.ts`
- Modify: `src/protocol/capabilities.ts`
- Modify: `contracts/runtime/runtime-capabilities.v1.schema.json`
- Modify: `src/cli/main.ts`
- Modify: `src/service/supervisor.ts`
- Modify: `scripts/copy-assets.mjs`
- Modify: `test/execution-chain.test.ts`
- Modify: `test/unavailable-boundaries.test.ts`
- Modify: `test/serve-smoke.test.ts`
- Modify: `test/service-supervisor.test.ts`
- Modify: `test/fixtures/protocol/valid/runtime-capabilities.v1.json`
- Modify: `examples/runtime-contract-v1/runtime-capabilities.json`

**Interfaces:**

- Consumes: all prior skill units, `createRunJournalStore`, loaded config, supervisor participants, local control server, and runtime capability construction.
- Produces: public `createSkillsHost`, safe parsers/hashes/types, `skill-execution-evidence.v1`, production participant wiring, and truthful skill capabilities.

- [ ] **Step 1: Write evidence RED tests**

  Build a run with selection, progressive disclosure, brainstorming pause/resume, TDD phases, review, and verification. Assert one canonical evidence document binds catalog hash, exact descriptor/package/snapshot/resource hashes, handler policy hashes, input/output hashes, every phase record, approval request/decision, journal heads, context accounting, and downstream handoff hash. Mutating any one binding and re-signing only the outer document must fail semantic parsing.

- [ ] **Step 2: Write public/capability/production RED tests**

  Assert the root package exports `createSkillsHost`, parsers, hashes, `RuntimeSkillError`, and safe immutable types, but not `createSkillCatalogForTest`, store hooks, native paths, stored resource bytes, or bundled filesystem locations. Assert baseline capabilities contain five new schema versions, `skill_host_versions: ["agent-skills.v1"]`, five ASCII-sorted Superpowers capability names, and `features.skills: "available"` while MCP/agent-loop/review/evidence remain unchanged.

  Remove `requireSkillsHost` from unavailable-boundary expectations. In a serve smoke test, assert skills recover before readiness, accept local approval while accepting, stop intake and flush before control close, and leave no skill stage/claim/socket/process.

- [ ] **Step 3: Run evidence/public/integration tests and capture RED**

  ```bash
  npm exec -- vitest run test/skill-evidence.test.ts test/skill-public-api.test.ts test/execution-chain.test.ts test/unavailable-boundaries.test.ts test/serve-smoke.test.ts test/service-supervisor.test.ts --maxWorkers=4
  ```

- [ ] **Step 4: Implement canonical evidence construction**

  Read only verified phase and main-journal histories plus stored public snapshot metadata. Sort phase/resource/approval projections by their protocol order, enforce `SKILL_LIMITS.evidenceBytes`, deep-freeze the result, and validate it through `parseSkillExecutionEvidence()` before returning it. Never include resource bodies or locations.

- [ ] **Step 5: Publish a self-contained safe factory**

  `src/skills/index.ts` wraps the internal implementation exactly as `src/agents/index.ts` does: public `CreateSkillsHostOptions` references only public types, and all test dependencies stay in internal modules. `src/index.ts` exports the factory, safe contracts/hashes/errors/types, and no private module symbol.

  `scripts/copy-assets.mjs` copies source `skills/bundled` to `dist/skills/bundled`. `src/skills/bundled.ts` resolves `../../skills/bundled` relative to `import.meta.url`, which addresses the source directory during Vitest and the copied `dist` directory in the built package without a caller-supplied path.

- [ ] **Step 6: Wire the real host into service startup**

  In `createMainServices().serve`, construct the skills host with `loaded.config.skill_roots`, the existing run journal, private state path, stable clock/IDs, and an exact service-listener probe. Add the host to `recoveryParticipants` before readiness. Pass `handleSkillRequest` through the main control server wrapper. Preserve shutdown order: stop skill intake, flush accepted work, drain control, then interrupt active runs.

- [ ] **Step 7: Advertise only delivered capability**

  Add the five schema versions in ASCII order, exact host/capability values, and semantic coherence tests. The advertised capabilities are:

  ```ts
  skill_host_versions: ["agent-skills.v1"],
  superpowers_capabilities: [
    "brainstorming",
    "requesting-code-review",
    "systematic-debugging",
    "test-driven-development",
    "verification-before-completion",
  ],
  features: { skills: "available" },
  ```

  Do not advertise external script execution or change MCP, agent-loop, review, or final evidence availability.

- [ ] **Step 8: Run integrated GREEN gates and commit**

  ```bash
  npm exec -- vitest run test/skill-evidence.test.ts test/skill-public-api.test.ts test/skill-approval.test.ts test/execution-chain.test.ts test/unavailable-boundaries.test.ts test/serve-smoke.test.ts test/service-supervisor.test.ts test/documentation-integrity.test.ts --maxWorkers=4
  npm run typecheck
  npm run lint
  git add src/skills/evidence.ts src/skills/index.ts src/index.ts src/protocol/capabilities.ts contracts/runtime/runtime-capabilities.v1.schema.json src/cli/main.ts src/service/supervisor.ts scripts/copy-assets.mjs test/skill-evidence.test.ts test/skill-public-api.test.ts test/execution-chain.test.ts test/unavailable-boundaries.test.ts test/serve-smoke.test.ts test/service-supervisor.test.ts test/fixtures/protocol/valid/runtime-capabilities.v1.json examples/runtime-contract-v1/runtime-capabilities.json
  git commit -m "feat: publish the Agent Skills host"
  ```

### Task 9: Contract docs, examples, and exact package boundary

**Files:**

- Create: `examples/runtime-contract-v1/skill-descriptor.json`
- Create: `examples/runtime-contract-v1/skill-snapshot.json`
- Create: `examples/runtime-contract-v1/superpowers-phase.json`
- Create: `examples/runtime-contract-v1/superpowers-approval.json`
- Create: `examples/runtime-contract-v1/skill-execution-evidence.json`
- Modify: `docs/contracts/runtime-contract-protocol-v1.md`
- Modify: `docs/contracts/local-service-control-v1.md`
- Modify: `docs/contracts/toss-cli-v2.2-compatibility.md`
- Modify: `docs/superpowers/specs/2026-08-19-v1-runtime-architecture-design.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `scripts/package-files.json`
- Modify: `test/documentation-integrity.test.ts`
- Modify: `test/package-metadata.test.ts`

**Interfaces:**

- Consumes: final public contracts/capabilities, bundled package manifest, root exports, normal npm pack wrapper, and package allowlist.
- Produces: five parseable examples, normative trust/approval/script documentation, and an installed package containing only required public surfaces and runtime internals.

- [ ] **Step 1: Write documentation and package RED tests**

  Require all examples to parse and hash through the public root API. Require docs to state metadata-only discovery, explicit private roots, no project auto-discovery, full post-selection load, path containment, real approval pause, restart/replay, no script execution, missing-capability status, evidence bindings, and latest-LTS-only CI. Require the real dry pack to include five source/dist schemas, five examples, safe public skill declarations/modules, bundled manifest/packages, and runtime implementation JS.

  Reject `.superpowers`, tests/helpers, local reports, stages/claims, private-store declarations/maps, catalog test seams, absolute paths, secrets, and tarballs.

- [ ] **Step 2: Run docs/package tests and capture RED**

  ```bash
  npm exec -- vitest run test/documentation-integrity.test.ts test/package-metadata.test.ts --maxWorkers=4
  ```

- [ ] **Step 3: Write canonical examples and normative documentation**

  Generate each example through the public hash functions; do not hand-edit hashes. Document that `superpowers-approve` is authenticated by the private same-user local socket and exact request binding, not by model text. Update the architecture's old script paragraph so v1.0.0 has no development bypass. Keep Linux and non-LTS lanes outside the active release contract.

- [ ] **Step 4: Lock the public/private package surface**

  Package the copied `dist/skills/bundled` tree and do not publish the source `skills/bundled` tree twice. Exclude declarations/maps for `catalog`, `private-store`, `loader`, and internal engine/approval test seams while keeping runtime JS required by the public factory. Regenerate `scripts/package-files.json` from one real scripts-enabled pack, sort it exactly, and prove normal prepack invokes one contents-only inner probe without recursion or destination leakage.

- [ ] **Step 5: Install the real tarball and test public behavior**

  In an operation-owned temporary directory, install the exact tarball and compile/run a consumer that imports the root API, loads bundled metadata, creates a private host, parses all five examples, and confirms deep imports of private store/catalog modules are blocked by package exports. Move the generated tarball to Trash and remove operation-owned directories after exact inspection.

- [ ] **Step 6: Run GREEN package gates and commit**

  ```bash
  npm exec -- vitest run test/documentation-integrity.test.ts test/package-metadata.test.ts test/skill-public-api.test.ts --maxWorkers=4
  npm run build
  npm run test:package
  git add examples/runtime-contract-v1 docs/contracts docs/superpowers/specs/2026-08-19-v1-runtime-architecture-design.md README.md CHANGELOG.md package.json scripts/package-files.json test/documentation-integrity.test.ts test/package-metadata.test.ts
  git commit -m "docs: publish the Agent Skills contract"
  ```

### Task 10: Whole-branch review, Latest LTS acceptance, evidence, and PR

**Files:**

- Create: `docs/verification/v1-agent-skills-superpowers.md` only after the publishable prep commit is clean.
- Modify: no production file during evidence generation.

**Interfaces:**

- Consumes: the complete Issue #8 branch, one resolved official latest-LTS macOS runtime, package acceptance scripts, GitHub Issue #8, Project #2, and Epic #16.
- Produces: a reviewed evidence-free prep commit, an evidence-only head commit, one Issue #8 PR, and continuously updated GitHub state.

- [ ] **Step 1: Run an independent whole-branch review before evidence**

  Review the exact `origin/release/v1.0.0..HEAD` diff against every spec section. Probe selection authority, content/hash closure, filesystem races, phase ordering, approval transaction ordering, replay, shutdown cut, script non-execution, evidence binding, package exposure, and capability truthfulness. Fix every Critical/Important/Minor finding through a new RED-to-GREEN commit and repeat review until no finding remains.

- [ ] **Step 2: Create a clean evidence-free prep commit**

  Delete only stale Issue #8 verification evidence if it exists, run `git diff --check`, confirm no `.tgz`, socket, stage, claim, lock, process, or task temp remains, then commit the evidence-free state:

  ```bash
  git add docs/verification/v1-agent-skills-superpowers.md
  git commit -m "test: clear stale Agent Skills acceptance"
  ```

  If the file did not previously exist, designate the current reviewed clean `HEAD` as the prep commit; do not create an empty commit or manufacture an unrelated adjustment.

- [ ] **Step 3: Resolve and assert the official latest LTS runtime**

  Use the official Node distribution index to select the first release whose `lts` field is non-false. Run:

  ```bash
  node -e 'if (!process.release.lts) throw new Error("Latest LTS required")'
  node --version
  npm --version
  ```

  Record the resolved version/codename once. Do not run Node Current, an older LTS lane, Linux, or a version matrix.

- [ ] **Step 4: Run fresh acceptance from the evidence-free prep head**

  ```bash
  npm ci
  npm run verify
  npm audit --omit=dev --audit-level=high
  npm exec -- vitest run test/skill-contracts.test.ts test/skill-catalog.test.ts test/skill-private-store.test.ts test/skill-loader.test.ts test/skill-context.test.ts test/skill-phases.test.ts test/skill-engine.test.ts test/skill-approval.test.ts test/skill-evidence.test.ts test/skill-public-api.test.ts --maxWorkers=4
  git diff --check
  git status --short
  ```

  Expected: all gates pass, production audit reports zero vulnerabilities, the sole allowed host skip is the Linux-only native systemd validation on macOS, and the worktree is tracked-clean.

- [ ] **Step 5: Write exact evidence and commit an evidence-only head**

  Record commit topology, resolved LTS/npm/macOS versions, full/focused counts, package filename/count/packed/unpacked sizes/SHA-1/SHA-256/SRI, audit, scripts-enabled prepack transcript, real socket approval/restart result, package installation, mutation witnesses, known non-goals, and artifact/process hygiene. Then:

  ```bash
  git add docs/verification/v1-agent-skills-superpowers.md
  git commit -m "test: verify Agent Skills acceptance"
  git diff --name-status HEAD^..HEAD
  ```

  Expected: the final commit adds or modifies only `docs/verification/v1-agent-skills-superpowers.md`.

- [ ] **Step 6: Re-run post-write integrity**

  ```bash
  npm exec -- prettier --check docs/verification/v1-agent-skills-superpowers.md
  npm exec -- vitest run test/documentation-integrity.test.ts test/package-metadata.test.ts --maxWorkers=4
  npm run verify
  npm audit --omit=dev --audit-level=high
  git diff --check
  git status --short
  ```

- [ ] **Step 7: Push and open the single Issue #8 PR**

  Push `issue/8-agent-skills-superpowers` and open one PR targeting `release/v1.0.0`. The body must summarize architecture, authority/script boundaries, approval behavior, Latest LTS verification, package metrics, and `Tracks #8` without auto-closing before checks.

- [ ] **Step 8: Update GitHub continuously and integrate after green**

  Keep Issue #8 and the PR Project items In progress while checks run. When the sole macOS Latest LTS check passes, set the issue and PR items to Done and close Issue #8 before merge, per the agreed workflow. Merge the PR into `release/v1.0.0`, verify the release-branch Latest LTS run, and update Epic #16 with commit, PR, tests, package, residual non-goals, and remaining v1.0.0 issues.

---

## Plan completion criteria

The plan is complete only when all of the following are true:

- every task has its own RED evidence, GREEN evidence, review, and scoped commit;
- the public daemon and package use the real host rather than an unavailable shim;
- a real brainstorming gate durably pauses and resumes through the private socket;
- no package script can execute in production or development;
- restart preserves exact skill/phase/approval identity;
- capability and package surfaces are mechanically truthful;
- one automatically advancing macOS Latest Node.js LTS lane is green;
- Issue #8/PR Project state follows the agreed Done-before-merge rule;
- the merged release branch remains clean and Epic #16 reflects the integration.
