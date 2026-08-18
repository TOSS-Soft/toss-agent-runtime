# Runtime Protocol and Package Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a cleanly installable TypeScript package baseline with Runtime Contract Protocol v1, safe configuration, truthful CLI capabilities, a graceful daemon shell, and credential-free CI.

**Architecture:** Keep protocol, configuration, platform, CLI, and service lifecycle as independent modules behind typed interfaces. Parse and validate untrusted documents before canonicalizing them, expose only frozen domain values, and keep all future provider/tool boundaries present but unavailable until their delivery waves.

**Tech Stack:** Node.js 22/24 LTS, TypeScript 6.0.3 ESM, npm, Ajv 8.20.0, ajv-formats 3.0.1, jsonc-parser 3.3.1, yaml 2.9.0, Vitest 4.1.11, ESLint 10.8.1, typescript-eslint 8.67.0, Prettier 3.9.6.

**Spec:** `docs/superpowers/specs/2026-08-19-contract-baseline-design.md`

## Global Constraints

- Publish one proprietary package named `@toss-software/agent-runtime`; keep its development version at `0.0.0-development` until the final release wave.
- Expose the executable as `toss-runtime`; package installation must never install or start a background service.
- Support only Node.js 22 and 24 LTS on macOS and Linux; set `engines.node` to `>=22.23.0 <25` and test both LTS majors.
- Use ESM, strict TypeScript, exact optional properties, unchecked-index protection, and committed exact dependency versions.
- Runtime Protocol v1 documents are closed JSON Schema 2020-12 objects with stable `https://toss.software/schemas/runtime/v1/` identifiers.
- Runtime output is execution evidence and cannot express governance approval, acceptance, assignment, or authority escalation.
- Secret values, raw tokens, credentials, and unrestricted environment maps have no persisted schema representation and no CLI option.
- JSON mode writes one versioned result to stdout; routed JSON failures leave stderr empty and retain the documented nonzero exit.
- CI is credential-free. Live provider and gateway tests belong to the protected final release wave.

---

## File map

- `package.json`, `package-lock.json`: exact package, script, dependency, publication, and engine contract.
- `tsconfig.json`, `tsconfig.build.json`: strict editor/test and declaration-producing build configurations.
- `eslint.config.js`, `.prettierrc.json`, `.gitignore`, `.npmignore`: repository hygiene and deterministic formatting/publication.
- `bin/toss-runtime.js`: tiny executable that imports the compiled CLI.
- `src/index.ts`: deliberately small programmatic API.
- `src/protocol/json.ts`: bounded duplicate-safe JSON parsing, plain-data checks, canonical JSON, SHA-256, and deep freezing.
- `src/protocol/types.ts`: document and common domain types.
- `src/protocol/validator.ts`: Ajv registry, schema selection, semantic checks, and typed parse results.
- `src/protocol/capabilities.ts`: truthful baseline capability document.
- `src/config/types.ts`, `src/config/load.ts`: closed configuration and deterministic precedence.
- `src/platform/runtime.ts`, `src/platform/signals.ts`: platform identity, clock/ID injection, and one-shot signal handling.
- `src/cli/grammar.ts`, `src/cli/result.ts`, `src/cli/main.ts`: fixed command grammar, output envelope, dispatch, and rendering.
- `src/service/lifecycle.ts`: abort-driven daemon lifecycle shell.
- `src/*/index.ts`: future subsystem boundaries with typed unavailable-capability exports only.
- `contracts/runtime/*.schema.json`: common, request, event, result, capabilities, config, and CLI-result schemas.
- `docs/contracts/runtime-contract-protocol-v1.md`: normative protocol, trust boundary, compatibility, and error behavior.
- `examples/runtime-contract-v1/*.json`: one complete secret-free request/event/result/capabilities chain.
- `test/*.test.ts`, `test/fixtures/**`: unit, contract, CLI, lifecycle, and package tests.
- `scripts/copy-assets.mjs`, `scripts/package-test.mjs`: deterministic build asset copying and tarball verification.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`: credential-free CI and a disabled-by-gates publication skeleton.

### Task 1: Package and module skeleton

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.gitignore`
- Create: `bin/toss-runtime.js`
- Create: `scripts/clean.mjs`
- Create: `scripts/copy-assets.mjs`
- Create: `src/version.ts`
- Create: `src/index.ts`
- Create: `src/providers/index.ts`
- Create: `src/routing/index.ts`
- Create: `src/agents/index.ts`
- Create: `src/skills/index.ts`
- Create: `src/tools/index.ts`
- Create: `src/orchestration/index.ts`
- Create: `src/evidence/index.ts`
- Create: `src/security/index.ts`
- Test: `test/package-metadata.test.ts`

**Interfaces:**

- Consumes: no earlier task.
- Produces: `PACKAGE_NAME`, `PACKAGE_VERSION`, `PROTOCOL_VERSION`, and `UnavailableCapabilityError` for all later tasks.

- [ ] **Step 1: Create the package/toolchain files and install exact dependencies**

Use this package contract and then run the exact install commands:

```json
{
  "name": "@toss-software/agent-runtime",
  "version": "0.0.0-development",
  "description": "Governed provider-neutral agent execution runtime for TOSS",
  "type": "module",
  "bin": { "toss-runtime": "bin/toss-runtime.js" },
  "exports": {
    ".": { "types": "./dist/src/index.d.ts", "import": "./dist/src/index.js" }
  },
  "files": [
    "bin",
    "dist",
    "contracts",
    "docs/contracts",
    "examples",
    "README.md",
    "CHANGELOG.md",
    "LICENSE"
  ],
  "engines": { "node": ">=22.23.0 <25" },
  "os": ["darwin", "linux"],
  "scripts": {
    "clean": "node scripts/clean.mjs",
    "build": "npm run clean && tsc -p tsconfig.build.json && node scripts/copy-assets.mjs",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:package": "node scripts/package-test.mjs",
    "verify": "npm run format:check && npm run lint && npm run typecheck && npm test && npm run build && npm run test:package",
    "prepack": "npm run verify"
  },
  "publishConfig": { "access": "public", "provenance": true },
  "license": "SEE LICENSE IN LICENSE"
}
```

```bash
npm install --save-exact ajv@8.20.0 ajv-formats@3.0.1 jsonc-parser@3.3.1 yaml@2.9.0
npm install --save-dev --save-exact typescript@6.0.3 @types/node@22.20.1 vitest@4.1.11 eslint@10.8.1 typescript-eslint@8.67.0 prettier@3.9.6
```

Configure TypeScript with `module` and `moduleResolution` set to `NodeNext`,
`target` set to `ES2023`, and enable `strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `useUnknownInCatchVariables`,
`verbatimModuleSyntax`, declarations, declaration maps, and source maps.
`scripts/clean.mjs` removes only the repository-local `dist` directory after
resolving and checking its exact path. `scripts/copy-assets.mjs` creates
`dist/contracts/runtime` and copies only regular schema files without following
symlinks.

- [ ] **Step 2: Write the failing metadata test**

```ts
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION, PROTOCOL_VERSION } from "../src/index.js";

describe("package metadata", () => {
  it("exports the frozen development identity", () => {
    expect(PACKAGE_NAME).toBe("@toss-software/agent-runtime");
    expect(PACKAGE_VERSION).toBe("0.0.0-development");
    expect(PROTOCOL_VERSION).toBe("runtime-contract.v1");
  });
});
```

- [ ] **Step 3: Run the metadata test and observe the missing exports**

Run: `npx vitest run test/package-metadata.test.ts`

Expected: FAIL because `src/index.ts` or the named exports do not exist.

- [ ] **Step 4: Implement metadata and explicit unavailable boundaries**

```ts
// src/version.ts
export const PACKAGE_NAME = "@toss-software/agent-runtime" as const;
export const PACKAGE_VERSION = "0.0.0-development" as const;
export const PROTOCOL_VERSION = "runtime-contract.v1" as const;

export class UnavailableCapabilityError extends Error {
  readonly code = "RUNTIME_CAPABILITY_UNAVAILABLE";
  constructor(readonly capability: string) {
    super(`Capability is unavailable in this build: ${capability}`);
    this.name = "UnavailableCapabilityError";
  }
}
```

Each future boundary exports its capability name and a function that throws
`UnavailableCapabilityError`; it must not contain a mock implementation or a
success-shaped return value. Re-export only version constants, protocol parse
functions added later, and the error class from `src/index.ts`.

- [ ] **Step 5: Run baseline checks and commit**

Run: `npm run format && npm run lint && npm run typecheck && npx vitest run test/package-metadata.test.ts`

Expected: all commands exit 0 and the metadata test passes.

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json eslint.config.js .prettierrc.json .gitignore bin scripts/clean.mjs scripts/copy-assets.mjs src test/package-metadata.test.ts
git commit -m "chore: bootstrap runtime package boundaries"
```

### Task 2: Safe JSON, canonicalization, and hashing

**Files:**

- Create: `src/protocol/json.ts`
- Create: `src/protocol/errors.ts`
- Test: `test/protocol-json.test.ts`

**Interfaces:**

- Consumes: Node `crypto`, `jsonc-parser`, and the package error conventions.
- Produces: `parseJsonBytes(input, limits)`, `assertPlainJson(value)`, `canonicalJson(value)`, `sha256(value)`, and `deepFreezeJson(value)`.

- [ ] **Step 1: Write failing parser and canonicalization tests**

```ts
import { describe, expect, it } from "vitest";
import { canonicalJson, parseJsonBytes, sha256 } from "../src/protocol/json.js";

describe("protocol JSON", () => {
  it("rejects duplicate keys before object construction", () => {
    expect(() => parseJsonBytes('{"run_id":"a","run_id":"b"}')).toThrow(/duplicate object key/i);
  });

  it("canonicalizes nested object keys and preserves array order", () => {
    expect(canonicalJson({ z: 1, a: [{ y: true, x: null }] })).toBe(
      '{"a":[{"x":null,"y":true}],"z":1}',
    );
  });

  it("rejects accessors without invoking them", () => {
    let invoked = false;
    const value = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        invoked = true;
        return "x";
      },
    });
    expect(() => canonicalJson(value)).toThrow(/accessor/i);
    expect(invoked).toBe(false);
  });

  it("hashes canonical UTF-8 bytes", () => {
    expect(sha256({ b: 2, a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sha256({ b: 2, a: 1 })).toBe(sha256({ a: 1, b: 2 }));
  });
});
```

- [ ] **Step 2: Run the JSON tests and observe the missing module**

Run: `npx vitest run test/protocol-json.test.ts`

Expected: FAIL because `src/protocol/json.ts` does not exist.

- [ ] **Step 3: Implement bounded duplicate-safe parsing and canonical JSON**

Use `jsonc-parser.parseTree` with comments and trailing commas disabled. Traverse
every object node, compare decoded property names in a `Set`, and throw a
`ProtocolJsonError` with byte offset for duplicates or syntax errors. Reject
inputs over 2 MiB, nesting deeper than 64, arrays/objects over 10,000 members,
non-finite numbers, non-plain prototypes, symbols, functions, `undefined`, and
accessor descriptors.

```ts
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface JsonLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxMembers: number;
}
export const DEFAULT_JSON_LIMITS: JsonLimits = {
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 64,
  maxMembers: 10_000,
};

export function parseJsonBytes(input: string | Uint8Array, limits = DEFAULT_JSON_LIMITS): JsonValue;
export function assertPlainJson(value: unknown, limits?: JsonLimits): asserts value is JsonValue;
export function canonicalJson(value: unknown): string;
export function sha256(value: unknown): `sha256:${string}`;
export function deepFreezeJson<T extends JsonValue>(value: T): T;
```

Canonicalization sorts object keys by UTF-16 code units and serializes validated
data with `JSON.stringify`; arrays retain order. `sha256` hashes canonical UTF-8
bytes through `createHash("sha256")`.

- [ ] **Step 4: Run focused and mutation tests**

Add assertions for empty input, comments, trailing commas, excessive depth,
oversized input, `NaN`, `Infinity`, `-0`, sparse arrays, class instances,
symbol keys, prototype pollution keys as ordinary data, and deep freezing.

Run: `npx vitest run test/protocol-json.test.ts`

Expected: PASS with every invalid value rejected deterministically.

- [ ] **Step 5: Commit the JSON foundation**

```bash
git add src/protocol/json.ts src/protocol/errors.ts test/protocol-json.test.ts
git commit -m "feat: add safe canonical protocol JSON"
```

### Task 3: Common schema registry and typed validation

**Files:**

- Create: `contracts/runtime/runtime-common.v1.schema.json`
- Create: `src/protocol/types.ts`
- Create: `src/protocol/validator.ts`
- Test: `test/protocol-validator.test.ts`

**Interfaces:**

- Consumes: `parseJsonBytes`, `deepFreezeJson`, Ajv 2020, and ajv-formats.
- Produces: `RuntimeDocument`, `ArtifactReference`, `RuntimeError`, `ValidationFailure`, `createProtocolValidator()`, and `parseRuntimeDocument(input, expectedType)`.

- [ ] **Step 1: Write failing common-shape tests**

```ts
import { describe, expect, it } from "vitest";
import { createProtocolValidator } from "../src/protocol/validator.js";

describe("runtime common schema", () => {
  it("accepts exact artifact references and rejects unknown fields", () => {
    const validator = createProtocolValidator();
    const valid = {
      document_type: "task-contract",
      artifact_id: "TASK-001",
      revision: 1,
      hash: `sha256:${"a".repeat(64)}`,
      location: "project-management/tasks/TASK-001.json",
    };
    expect(validator.validateFragment("artifact-reference", valid)).toEqual({
      ok: true,
      value: valid,
    });
    expect(
      validator.validateFragment("artifact-reference", { ...valid, accepted: true }),
    ).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: Run the validator test and observe the missing registry**

Run: `npx vitest run test/protocol-validator.test.ts`

Expected: FAIL because the common schema and validator do not exist.

- [ ] **Step 3: Implement common definitions and registry**

Define closed `$defs` for identifiers, UTC timestamps, `sha256:` hashes,
relative artifact locations, artifact references, producer identities, trace
context, positive bounded budgets, normalized errors, usage, and recursive safe
JSON. Explicitly exclude keys named `authority`, `approved`, `accepted`,
`credential`, `secret`, `token`, and `environment` from the generic metadata
definition.

```ts
export type ValidationFailure = Readonly<{
  ok: false;
  code: "RUNTIME_DOCUMENT_INVALID" | "RUNTIME_DOCUMENT_UNSUPPORTED";
  issues: readonly Readonly<{ path: string; keyword: string; message: string }>[];
}>;
export type ValidationSuccess<T> = Readonly<{ ok: true; value: T }>;
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export interface ProtocolValidator {
  validateFragment(
    name: "artifact-reference" | "runtime-error" | "trace-context",
    value: unknown,
  ): ValidationResult<unknown>;
  parse<T extends RuntimeDocument>(
    input: string | Uint8Array,
    expectedType: T["document_type"],
  ): ValidationResult<T>;
}
```

Compile schemas with Ajv 2020 using `strict: true`, `allErrors: true`,
`allowUnionTypes: false`, and no coercion/default/removal. Sort normalized Ajv
issues by instance path, keyword, then message so output is deterministic.

- [ ] **Step 4: Run the common validation matrix**

Add tests for malformed IDs, revision zero, uppercase hashes, absolute and
traversing locations, invalid timestamps, extra producer fields, secret-shaped
metadata, and accessor-bearing input.

Run: `npx vitest run test/protocol-validator.test.ts`

Expected: PASS; validation never mutates or reads accessors from input.

- [ ] **Step 5: Commit the schema registry**

```bash
git add contracts/runtime/runtime-common.v1.schema.json src/protocol/types.ts src/protocol/validator.ts test/protocol-validator.test.ts
git commit -m "feat: define runtime common contract validation"
```

### Task 4: Execution request contract and semantic checks

**Files:**

- Create: `contracts/runtime/execution-request.v1.schema.json`
- Create: `src/protocol/request.ts`
- Create: `test/fixtures/protocol/valid/execution-request.v1.json`
- Create: `test/fixtures/protocol/invalid/request-authority.json`
- Create: `test/fixtures/protocol/invalid/request-secret.json`
- Test: `test/execution-request.test.ts`

**Interfaces:**

- Consumes: the common schema registry and canonical hash functions.
- Produces: `ExecutionRequestV1`, `parseExecutionRequest(input)`, and `hashExecutionRequest(request)`.

- [ ] **Step 1: Write the failing request tests**

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { hashExecutionRequest, parseExecutionRequest } from "../src/protocol/request.js";

describe("execution-request.v1", () => {
  it("accepts and freezes the complete fixture", async () => {
    const bytes = await readFile("test/fixtures/protocol/valid/execution-request.v1.json");
    const result = parseExecutionRequest(bytes);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(hashExecutionRequest(result.value)).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it.each(["request-authority.json", "request-secret.json"])("rejects %s", async (name) => {
    const bytes = await readFile(`test/fixtures/protocol/invalid/${name}`);
    expect(parseExecutionRequest(bytes)).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: Run request tests and observe the missing contract**

Run: `npx vitest run test/execution-request.test.ts`

Expected: FAIL because request schema, fixtures, and parser do not exist.

- [ ] **Step 3: Implement the exact closed request contract**

Require these top-level fields: `protocol_version`, `schema_version`,
`document_type`, `request_id`, `run_id`, `created_at`, `deadline`,
`task_contract`, `input_artifacts`, `agent`, `model`, `superpowers`, `mcp`,
`budget`, `review_policy`, `output`, and `trace`. Set discriminator values to
`runtime-contract.v1`, `execution-request.v1`, and `execution-request`.

```ts
export interface ExecutionRequestV1 extends RuntimeDocument {
  readonly protocol_version: "runtime-contract.v1";
  readonly schema_version: "execution-request.v1";
  readonly document_type: "execution-request";
  readonly request_id: string;
  readonly run_id: string;
  readonly created_at: string;
  readonly deadline: string;
  readonly task_contract: ArtifactReference;
  readonly input_artifacts: readonly ArtifactReference[];
  readonly agent: Readonly<{ definition: ArtifactReference; role: string }>;
  readonly model: Readonly<{ logical_class: string; required_capabilities: readonly string[] }>;
  readonly superpowers: Readonly<{ required: readonly string[] }>;
  readonly mcp: Readonly<{ profile: ArtifactReference }>;
  readonly budget: RuntimeBudget;
  readonly review_policy: ArtifactReference;
  readonly output: Readonly<{ schema: ArtifactReference }>;
  readonly trace: TraceContext;
}
```

Semantic validation requires deadline after creation, unique artifact
`artifact_id`/revision pairs, nonempty unique capability lists, task document
type `task-contract`, positive budgets, and no request field that claims an
approval, acceptance, governance transition, or authority override.

- [ ] **Step 4: Run request fixtures and deterministic hash checks**

Add invalid fixtures for an unsupported protocol, deadline before creation,
duplicate artifacts, duplicate capabilities, zero budget, wrong Task Contract
type, extra key, and raw credential value.

Run: `npx vitest run test/execution-request.test.ts test/protocol-validator.test.ts`

Expected: PASS; all invalid fixtures return sorted normalized issues.

- [ ] **Step 5: Commit the request contract**

```bash
git add contracts/runtime/execution-request.v1.schema.json src/protocol/request.ts test/fixtures/protocol test/execution-request.test.ts
git commit -m "feat: publish execution request v1 contract"
```

### Task 5: Event, result, and capability contracts

**Files:**

- Create: `contracts/runtime/execution-event.v1.schema.json`
- Create: `contracts/runtime/execution-result.v1.schema.json`
- Create: `contracts/runtime/runtime-capabilities.v1.schema.json`
- Create: `src/protocol/event.ts`
- Create: `src/protocol/result.ts`
- Create: `src/protocol/capabilities.ts`
- Create: `test/fixtures/protocol/valid/execution-event.v1.json`
- Create: `test/fixtures/protocol/valid/execution-result.v1.json`
- Create: `test/fixtures/protocol/valid/runtime-capabilities.v1.json`
- Test: `test/execution-chain.test.ts`

**Interfaces:**

- Consumes: request hash, common types, schema registry, and package metadata.
- Produces: `ExecutionEventV1`, `ExecutionResultV1`, `RuntimeCapabilitiesV1`, their parsers, `hashExecutionEvent(eventWithoutHash)`, `createBaselineCapabilities(platform)`, and `negotiateRequest(request, capabilities)`.

- [ ] **Step 1: Write the failing complete-chain test**

```ts
import { describe, expect, it } from "vitest";
import { loadValidChain } from "./support/protocol-fixtures.js";
import { validateExecutionChain } from "../src/protocol/result.js";
import { createBaselineCapabilities } from "../src/protocol/capabilities.js";

describe("Runtime Contract Protocol v1 chain", () => {
  it("binds event and result to the exact request and journal head", async () => {
    const chain = await loadValidChain();
    expect(validateExecutionChain(chain)).toEqual({ ok: true });
  });

  it("reports future subsystems as unavailable", () => {
    const doc = createBaselineCapabilities({ os: "linux", arch: "x64", node: "22.23.1" });
    expect(doc.execution_topologies).toEqual([]);
    expect(doc.features.providers).toBe("unavailable");
    expect(doc.features.mcp).toBe("unavailable");
    expect(doc.features.skills).toBe("unavailable");
  });
});
```

- [ ] **Step 2: Run chain tests and observe missing schemas**

Run: `npx vitest run test/execution-chain.test.ts`

Expected: FAIL because event/result/capability modules and support fixture do not exist.

- [ ] **Step 3: Implement the three closed documents**

Event fields are discriminators plus `run_id`, `request_hash`, `sequence`,
`run_revision`, `previous_event_hash`, `event_hash`, `event_type`, `timestamp`,
`producer`, `trace`, `input_reference`, and `payload`. Sequence and revision
start at one. The genesis previous hash is exactly `sha256:` followed by 64
zeroes. `event_hash` is computed over the complete event without that field.

Result fields are discriminators plus `run_id`, `request_hash`, `journal_head`,
`status`, `finished_at`, `outputs`, `error`, `usage`, `evidence`, and `trace`.
Status is `COMPLETED|FAILED|BLOCKED|CANCELLED|INTERRUPTED`. `COMPLETED` requires
at least one output and forbids `error`; every other status requires `error` and
forbids success-shaped outputs.

Capability fields are discriminators plus package/runtime identity, platform,
supported protocol/schema lists, provider transports, logical model classes,
skill-host versions, MCP transports, execution topologies, and a closed feature
availability object using `available|unavailable|blocked`.

```ts
export function validateExecutionChain(input: {
  readonly request: ExecutionRequestV1;
  readonly events: readonly ExecutionEventV1[];
  readonly result: ExecutionResultV1;
}): ValidationResult<true>;

export function createBaselineCapabilities(platform: {
  readonly os: "darwin" | "linux";
  readonly arch: string;
  readonly node: string;
}): RuntimeCapabilitiesV1;

export function negotiateRequest(
  request: ExecutionRequestV1,
  capabilities: RuntimeCapabilitiesV1,
): ValidationResult<Readonly<{ protocol: "runtime-contract.v1" }>>;
```

Chain validation enforces request-hash equality, sequence continuity, previous
hash links, run revision continuity, event-hash recalculation, result head
equality, run identity, and trace identity. It does not yet enforce the wave-two
state transition matrix.

Negotiation rejects an unsupported protocol/schema, logical model class,
required model capability, Superpowers capability, MCP transport/profile, or
execution topology before returning a plan. The truthful baseline therefore
rejects all execution requests with code `RUNTIME_CAPABILITY_UNAVAILABLE` while
still validating their protocol documents independently.

- [ ] **Step 4: Test corrupt chains and terminal invariants**

Add table cases for a stale request hash, skipped sequence, broken previous
hash, tampered payload, mismatched result head, completed result with error,
failed result with outputs, unknown status, and a capability document that
claims an unavailable provider. Add negotiation cases for unknown protocol,
model capability, Superpowers capability, MCP profile, and topology.

Run: `npx vitest run test/execution-chain.test.ts`

Expected: PASS; each corruption produces a stable path and keyword.

- [ ] **Step 5: Commit the complete protocol chain**

```bash
git add contracts/runtime src/protocol test/fixtures/protocol/valid test/execution-chain.test.ts test/support/protocol-fixtures.ts
git commit -m "feat: complete runtime contract protocol v1"
```

### Task 6: Closed configuration and secret references

**Files:**

- Create: `contracts/runtime/runtime-config.v1.schema.json`
- Create: `src/config/types.ts`
- Create: `src/config/load.ts`
- Create: `src/platform/runtime.ts`
- Create: `examples/config/runtime.development.yaml`
- Test: `test/config.test.ts`

**Interfaces:**

- Consumes: safe JSON/YAML parsing, protocol validator conventions, and platform facts.
- Produces: `RuntimeConfigV1`, `SecretReference`, `defaultConfig(platform, home)`, and `loadConfig({ explicitPath, env, platform, home })`.

- [ ] **Step 1: Write failing precedence and secret tests**

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";

describe("runtime configuration", () => {
  it("prefers an explicit path over the environment path", async () => {
    const result = await loadConfig({
      explicitPath: "/tmp/explicit.yaml",
      env: { TOSS_RUNTIME_CONFIG: "/tmp/env.yaml" },
      platform: "linux",
      home: "/home/test",
    });
    expect(result.source).toBe("/tmp/explicit.yaml");
  });

  it("rejects inline secret material", async () => {
    await expect(
      loadConfig({
        explicitPath: "test/fixtures/config/inline-secret.yaml",
        env: {},
        platform: "linux",
        home: "/home/test",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_INVALID" });
  });
});
```

- [ ] **Step 2: Run config tests and observe the missing loader**

Run: `npx vitest run test/config.test.ts`

Expected: FAIL because config types and loader do not exist.

- [ ] **Step 3: Implement exact config schema and deterministic defaults**

```ts
export interface SecretReference {
  readonly source: "env" | "command";
  readonly key: string;
}

export interface RuntimeConfigV1 {
  readonly schema_version: "runtime-config.v1";
  readonly document_type: "runtime-config";
  readonly mode: "development" | "production";
  readonly paths: Readonly<{ state: string; logs: string; socket: string }>;
  readonly shutdown_timeout_ms: number;
  readonly logs: Readonly<{
    level: "debug" | "info" | "warn" | "error";
    retention_days: 7;
    max_bytes: 104857600;
  }>;
  readonly gateway_profile: string | null;
  readonly provider_profiles: readonly string[];
  readonly mcp_profiles: readonly string[];
  readonly secret_references: Readonly<Record<string, SecretReference>>;
}
```

Use macOS `~/Library/Application Support/TOSS/runtime` and
`~/Library/Logs/TOSS/runtime`; use Linux XDG config/state/runtime locations with
safe home-based fallbacks except that a production socket requires a private
runtime directory. Parse `.json` with `parseJsonBytes`; parse `.yaml`/`.yml`
with `yaml.parseDocument` using unique keys and a strict core schema. Reject
unknown extensions, symlinked config files, group/world-writable files in
production, inline secret-like keys, relative state/log/socket paths, and
unknown fields.

- [ ] **Step 4: Run configuration security cases**

Add fixtures for duplicates, unknown fields, inline `api_key`, unsafe file
permissions, project-local production path, relative path, invalid mode,
missing production gateway profile, and a valid secret reference.

Run: `npx vitest run test/config.test.ts`

Expected: PASS; error messages contain paths and safe reasons but never values.

- [ ] **Step 5: Commit configuration baseline**

```bash
git add contracts/runtime/runtime-config.v1.schema.json src/config src/platform/runtime.ts examples/config test/config.test.ts test/fixtures/config
git commit -m "feat: add secure runtime configuration"
```

### Task 7: Stable CLI grammar and truthful commands

**Files:**

- Create: `contracts/runtime/command-result.v1.schema.json`
- Create: `src/cli/grammar.ts`
- Create: `src/cli/result.ts`
- Create: `src/cli/main.ts`
- Modify: `bin/toss-runtime.js`
- Test: `test/cli.test.ts`

**Interfaces:**

- Consumes: package metadata, `createBaselineCapabilities`, `loadConfig`, and stable validation errors.
- Produces: `parseCli(argv)`, `runCli(argv, services)`, `CommandResultV1`, `renderHuman(result)`, and executable behavior.

- [ ] **Step 1: Write failing CLI tests**

```ts
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";

describe("baseline CLI", () => {
  it("returns one versioned capabilities document in JSON mode", async () => {
    const output = await runCli(["capabilities", "--json"], {
      platform: { os: "linux", arch: "x64", node: "22.23.1" },
    });
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({
      schema_version: "command-result.v1",
      command: "capabilities",
      ok: true,
    });
    expect(output.stderr).toBe("");
  });

  it("rejects credential-shaped options as usage errors", async () => {
    const output = await runCli(["doctor", "--api-key", "secret"], {
      platform: { os: "linux", arch: "x64", node: "22.23.1" },
    });
    expect(output.exitCode).toBe(2);
    expect(output.stdout).not.toContain("secret");
    expect(output.stderr).not.toContain("secret");
  });
});
```

- [ ] **Step 2: Run CLI tests and observe the missing dispatcher**

Run: `npx vitest run test/cli.test.ts`

Expected: FAIL because CLI modules do not exist.

- [ ] **Step 3: Implement fixed grammar, result schema, and rendering**

```ts
export type BaselineCommand =
  | Readonly<{ name: "help" }>
  | Readonly<{ name: "version" }>
  | Readonly<{ name: "capabilities"; json: boolean }>
  | Readonly<{ name: "doctor"; json: boolean; configPath?: string }>
  | Readonly<{ name: "serve"; json: boolean; configPath?: string }>;

export interface CommandResultV1 {
  readonly schema_version: "command-result.v1";
  readonly document_type: "command-result";
  readonly command: string;
  readonly ok: boolean;
  readonly exit_code: 0 | 2 | 3 | 4 | 5 | 6 | 69 | 70;
  readonly data: JsonValue | null;
  readonly error: RuntimeError | null;
}
```

Parse arguments without permissive abbreviation. Accept `--json` only on
routed commands and `--config <path>` only on doctor/serve. Redact the token
following any unrecognized option whose name contains `key`, `token`,
`password`, `secret`, or `credential` before building an error. Doctor emits
checks for package, Node/platform support, config parse, private paths, and
future capability availability; unavailable future subsystems are WARN in
development and FAIL in production.

Write `bin/toss-runtime.js` with a shebang, import `main` from
`../dist/src/cli/main.js`, set `process.exitCode`, and catch only the outermost
unexpected failure into safe code 70 output.

- [ ] **Step 4: Run the complete CLI matrix**

Add human/JSON cases for help, version, capabilities, doctor, unknown command,
unknown option, missing option value, unsupported Node/platform injection,
invalid config, and internal failure. Spawn the built binary for shebang and
exit-code verification.

Run: `npx vitest run test/cli.test.ts && npm run build && node bin/toss-runtime.js capabilities --json`

Expected: tests pass and the final command prints one JSON document and exits 0.

- [ ] **Step 5: Commit the baseline CLI**

```bash
git add contracts/runtime/command-result.v1.schema.json src/cli bin/toss-runtime.js test/cli.test.ts
git commit -m "feat: add truthful runtime baseline CLI"
```

### Task 8: Graceful daemon lifecycle shell

**Files:**

- Create: `src/platform/signals.ts`
- Create: `src/service/lifecycle.ts`
- Modify: `src/cli/main.ts`
- Test: `test/service-lifecycle.test.ts`
- Test: `test/serve-smoke.test.ts`

**Interfaces:**

- Consumes: validated config, CLI serve dispatch, and injected clock/signal adapters.
- Produces: `runService(options)`, `ServiceController`, and deterministic signal shutdown.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { runService } from "../src/service/lifecycle.js";

describe("service lifecycle", () => {
  it("stops accepting and drains once after SIGTERM", async () => {
    const stopAccepting = vi.fn();
    const drain = vi.fn().mockResolvedValue(undefined);
    const signals = createFakeSignals();
    const running = runService({ signals, stopAccepting, drain, shutdownTimeoutMs: 1000 });
    signals.emit("SIGTERM");
    await expect(running).resolves.toMatchObject({ reason: "SIGTERM", forced: false });
    expect(stopAccepting).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run lifecycle tests and observe the missing service**

Run: `npx vitest run test/service-lifecycle.test.ts test/serve-smoke.test.ts`

Expected: FAIL because lifecycle and signal adapters do not exist.

- [ ] **Step 3: Implement abort-driven one-shot shutdown**

```ts
export interface ServiceController {
  readonly accepting: boolean;
  stop(
    reason: "SIGINT" | "SIGTERM" | "requested",
  ): Promise<Readonly<{ reason: string; forced: boolean }>>;
}

export async function runService(options: {
  readonly signals: SignalSource;
  readonly stopAccepting: () => void;
  readonly drain: (signal: AbortSignal) => Promise<void>;
  readonly shutdownTimeoutMs: number;
}): Promise<Readonly<{ reason: string; forced: boolean }>>;
```

Register SIGINT/SIGTERM listeners once, make concurrent stop calls share one
promise, call `stopAccepting` synchronously, and race drain against an injected
timer. Timeout aborts drain and returns `forced: true`; it never calls
`process.exit`. The CLI maps a forced shutdown to code 70 with a safe message.

- [ ] **Step 4: Verify signals, timeout, and executable behavior**

Add tests for SIGINT, duplicate signals, drain rejection, timeout, pre-aborted
startup, listener cleanup, and a spawned `serve` process that receives SIGTERM
and exits cleanly without forking or leaving a child process.

Run: `npx vitest run test/service-lifecycle.test.ts test/serve-smoke.test.ts`

Expected: PASS with no open-handle warning.

- [ ] **Step 5: Commit daemon lifecycle**

```bash
git add src/platform/signals.ts src/service/lifecycle.ts src/cli/main.ts test/service-lifecycle.test.ts test/serve-smoke.test.ts
git commit -m "feat: add graceful runtime daemon lifecycle"
```

### Task 9: Protocol documentation, package integrity, and CI

**Files:**

- Create: `README.md`
- Create: `LICENSE`
- Create: `CHANGELOG.md`
- Create: `docs/contracts/runtime-contract-protocol-v1.md`
- Create: `docs/contracts/toss-cli-v2.2-compatibility.md`
- Create: `examples/runtime-contract-v1/execution-request.json`
- Create: `examples/runtime-contract-v1/execution-event.json`
- Create: `examples/runtime-contract-v1/execution-result.json`
- Create: `examples/runtime-contract-v1/runtime-capabilities.json`
- Create: `scripts/package-test.mjs`
- Create: `.npmignore`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Test: `test/documentation-integrity.test.ts`

**Interfaces:**

- Consumes: all wave-one schemas, fixtures, CLI, and package scripts.
- Produces: normative published documentation, verified tarball contents, Node 22/24 CI, and a non-publishing release skeleton.

- [ ] **Step 1: Write failing documentation and package-content tests**

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("published protocol documentation", () => {
  it("names every protocol document and the TOSS authority boundary", async () => {
    const text = await readFile("docs/contracts/runtime-contract-protocol-v1.md", "utf8");
    for (const name of [
      "execution-request.v1",
      "execution-event.v1",
      "execution-result.v1",
      "runtime-capabilities.v1",
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("Runtime output is execution evidence, not governance authority");
  });
});
```

- [ ] **Step 2: Run documentation/package tests and observe missing artifacts**

Run: `npx vitest run test/documentation-integrity.test.ts && npm run build && npm pack --json`

Expected: FAIL because published docs, examples, scripts, and copied assets do not exist.

- [ ] **Step 3: Write normative docs, examples, and deterministic scripts**

The protocol document must define ownership, discriminators, validation stages,
trust boundaries, handshake, compatibility, exact reference/hash semantics,
secret exclusions, stable errors/exits, and a field-by-field table for all four
documents. The compatibility document maps every runtime request/result field
to `toss-cli v2.2.0`, states that unknown majors fail closed, and says additive
capabilities require negotiation.

`scripts/copy-assets.mjs` copies schemas into `dist/contracts/runtime` without
following symlinks. `scripts/package-test.mjs` runs `npm pack --json --ignore-scripts`,
checks the exact allowlist, installs the tarball into a temporary directory,
imports the package, runs the executable help/version/capabilities commands,
asserts no secret-like file names or test sources exist, and removes its own
temporary directory in `finally`.

- [ ] **Step 4: Add CI and non-publishing release protection**

`ci.yml` uses `actions/checkout`, `actions/setup-node` with Node 22 and 24 plus
npm cache, `npm ci`, and `npm run verify` on Ubuntu and macOS. Set read-only
contents permission, concurrency cancellation for the same ref, a 20-minute
timeout, and no secrets.

`release.yml` runs only through `workflow_dispatch`, requires a version input,
checks that it is not `1.0.0` during this baseline wave, runs the same verify
job, and exits before any npm authentication, tag, or GitHub Release step. Its
header explains that wave six replaces the guard only after protected live
provider/gateway jobs exist.

- [ ] **Step 5: Run full wave verification**

Run:

```bash
npm run format
npm run verify
npm audit --audit-level=high
git diff --check
```

Expected: all commands exit 0; the tarball installs cleanly, contains every
schema/doc/example, and contains no test, local state, credential, or source
configuration file.

- [ ] **Step 6: Commit the verified baseline**

```bash
git add README.md LICENSE CHANGELOG.md docs/contracts examples scripts .npmignore .github test/documentation-integrity.test.ts
git commit -m "docs: publish runtime protocol baseline"
```

### Task 10: Wave acceptance and issue evidence

**Files:**

- Create: `docs/verification/v1-wave-1.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: issues #2/#4 acceptance criteria and fresh verification output.
- Produces: an exact commit-bound verification record used to close the first dependency wave after push/CI.

- [ ] **Step 1: Run acceptance from a clean checkout state**

Run:

```bash
git status --short
npm ci
npm run verify
npm audit --audit-level=high
node bin/toss-runtime.js --version
node bin/toss-runtime.js capabilities --json
node bin/toss-runtime.js doctor --json
```

Expected: the initial status is clean, all verification commands exit 0, the
version is `0.0.0-development`, capabilities are truthful, and doctor reports no
secret values.

- [ ] **Step 2: Record exact acceptance evidence**

Create `docs/verification/v1-wave-1.md` with the verified commit SHA, Node/npm
versions, command list and exit status, tarball filename/SHA-256, audit result,
and a checklist mapping every criterion from issues #2 and #4 to a test or
document path. Do not copy environment variables, tokens, usernames, absolute
home paths, or provider configuration into the record.

- [ ] **Step 3: Re-run docs/package verification and commit**

Run: `npm run verify && git diff --check`

Expected: both commands exit 0 and the verification record is included in the
validated package documentation only if the package allowlist explicitly names
`docs/verification`.

```bash
git add docs/verification/v1-wave-1.md CHANGELOG.md
git commit -m "test: record runtime baseline verification"
```

- [ ] **Step 4: Confirm wave handoff state**

Run: `git status --short --branch && git log --oneline --decorate -12`

Expected: the working tree is clean and commits are ordered from package
bootstrap through verified protocol baseline. Do not close GitHub issues until
the branch is pushed and required CI is green.
