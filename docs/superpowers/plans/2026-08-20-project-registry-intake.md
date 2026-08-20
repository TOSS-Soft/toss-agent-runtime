# Project Registry and Durable Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build issue #29's explicit project registry, closed watch manifest, root-bounded macOS watcher, deterministic debounce, duplicate-safe durable candidate intake, restart recovery, and `project` CLI.

**Architecture:** Add a focused `src/service/project/` subsystem owned by the single supervised service process. A private append-only registry records stable project identity and manifest revisions; a root-bounded path compiler and injected watcher edge normalize only approved changes; a synchronized pending-window store publishes deduplicated `candidate-job-intent.v1` records before clearing recovery state. CLI mutations travel through the existing private Unix control socket so the daemon remains the only writer.

**Tech Stack:** TypeScript 6 ESM, Node.js 22.23.1 and 24 on macOS, `node:fs/promises`, `node:fs.watch`, YAML 2.9, canonical JSON/SHA-256, JSON Schema 2020-12/Ajv, Vitest 4, npm 11.18.0.

**Spec:** `docs/superpowers/specs/2026-08-19-durable-local-service-design.md` section “Project registry, manifest, and watcher”, constrained by `docs/superpowers/specs/2026-08-20-v1-release-program-design.md` and issue #29.

## Global Constraints

- The issue branch is exactly `issue/29-project-registry-intake`; its single PR targets `release/v1.0.0`.
- v1.0.0 release support is macOS only; Node.js support is `>=22.23.0 <25`.
- Registration is explicit. No home, workspace, repository, or sibling-directory discovery is permitted.
- `.toss/project.yaml` is a closed `project-watch-manifest.v1` document with unique nonempty relative `watch_paths` and optional unique relative `ignore_paths`.
- Absolute paths, empty segments, `.`, `..`, NUL/control characters, final/intermediate symlinks, root escapes, `.git`, `.toss/runtime`, and runtime-owned state paths fail closed or are always ignored as specified.
- Registry, pending windows, and candidate intents are current-user private, canonical, bounded, append-only or atomically replaced as their contracts require, and synchronized before success is returned.
- The daemon is the only registry/intake writer. CLI project commands use the private local control socket and never mutate state files directly.
- Debounce is 200 ms with a hard 2 second maximum. Normalized changes are bytewise sorted; duplicate candidate keys append no second intent.
- Watcher overflow performs only a bounded rescan of declared watch paths. A missing, moved, or replaced root is never relocated and becomes `BLOCKED_PROJECT_UNAVAILABLE`.
- Watchers produce candidate job intents only. They cannot bypass governance, approval, routing, provider, tool, or acceptance gates.
- Stage only explicitly named files; never use `git add .`, `git add -A`, or `git add --all`.
- Do not merge to `main`, tag, publish npm `1.0.0`, create a GitHub Release, or close epic #16 in this issue.

---

### Task 1: Publish the issue plan and open the dedicated draft PR

**Files:**

- Create: `docs/superpowers/plans/2026-08-20-project-registry-intake.md`
- Modify: GitHub issue #29 comment stream and project status
- Modify: GitHub epic #16 comment stream

**Interfaces:**

- Consumes: issue #29 acceptance criteria, approved durable-service spec, branch `issue/29-project-registry-intake`
- Produces: committed plan, one remote issue branch, and one draft PR targeting `release/v1.0.0`

- [ ] **Step 1: Validate the plan artifact**

Run:

```bash
npm exec prettier -- --check docs/superpowers/plans/2026-08-20-project-registry-intake.md
rg -n 'T[B]D|T[O]DO|implement[[:space:]]+later|fill[[:space:]]+in[[:space:]]+details|Similar[[:space:]]+to[[:space:]]+Task' docs/superpowers/plans/2026-08-20-project-registry-intake.md
```

Expected: Prettier exits `0`; `rg` exits `1` with no matches.

- [ ] **Step 2: Commit only the plan**

Run:

```bash
git add -- docs/superpowers/plans/2026-08-20-project-registry-intake.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: plan project registry and intake"
```

Expected: the staged list contains exactly the new plan.

- [ ] **Step 3: Push and create one draft PR**

Create the PR with title `feat: add project registry and durable intake` and this acceptance checklist:

```markdown
- [ ] No uncontrolled workspace scan occurs
- [ ] Unregistered project changes produce no candidate intent
- [ ] Watch and ignore paths cannot escape the canonical project root
- [ ] Bursts coalesce into a deterministic bounded candidate set
- [ ] Runtime-generated and ignored files cannot cause feedback loops
- [ ] Missing or moved roots become BLOCKED_PROJECT_UNAVAILABLE
- [ ] Registry and pending intake recover after restart
- [ ] Rename, symlink, burst, duplicate, overflow, and restart tests pass
```

Expected: exactly one draft PR exists with head `issue/29-project-registry-intake` and base `release/v1.0.0`.

- [ ] **Step 4: Update GitHub tracking**

Move issue #29 and its PR to `In progress`; comment on #29 and epic #16 with the branch, PR, plan path, and statement that epic integration remains unchecked until merge.

### Task 2: Define the closed project, registry, and candidate contracts

**Files:**

- Create: `contracts/runtime/project-watch-manifest.v1.schema.json`
- Create: `contracts/runtime/project-registry-entry.v1.schema.json`
- Create: `contracts/runtime/candidate-job-intent.v1.schema.json`
- Create: `src/service/project/types.ts`
- Create: `src/service/project/errors.ts`
- Create: `src/service/project/contracts.ts`
- Create: `test/project-contracts.test.ts`
- Modify: `docs/contracts/runtime-contract-v1.manifest.json`
- Modify: `test/documentation-integrity.test.ts`

**Interfaces:**

- Consumes: `canonicalJson`, `sha256`, bounded JSON parsing, `yaml.parseDocument`, existing validation-result shapes
- Produces: `ProjectWatchManifestV1`, `ProjectRegistryEntryV1`, `CandidateJobIntentV1`, `ProjectRegistration`, `ProjectChange`, `RuntimeProjectError`, `parseProjectWatchManifest`, `parseProjectRegistryEntry`, `parseCandidateJobIntent`, `hashProjectRegistryEntry`

- [ ] **Step 1: Write failing schema/parser tests**

Use literal YAML and JSON fixtures. The manifest success fixture is:

```yaml
schema_version: project-watch-manifest.v1
watch_paths:
  - src
  - package.json
ignore_paths:
  - dist
  - tmp
```

Assert rejection of unknown keys, YAML aliases/tags/multiple documents, duplicate paths, empty arrays, absolute paths, `.`/`..`/empty/control-character segments, and inputs over 64 KiB. Registry tests must recompute `entry_hash` and reject changed revision, root, state, or manifest hash. Candidate tests must enforce kind `PROJECT_CHANGED`, bytewise-sorted unique changes, exact registry/manifest identity, SHA-256 candidate key, bounded safe file identity strings, and closed metadata.

- [ ] **Step 2: Run the contract test to verify RED**

Run `npm exec vitest -- run test/project-contracts.test.ts`.

Expected: FAIL because the project contract modules and schemas do not exist.

- [ ] **Step 3: Implement exact public types and errors**

Define these stable discriminants:

```ts
export type ProjectRegistryState = "ACTIVE" | "UNREGISTERED" | "BLOCKED_PROJECT_UNAVAILABLE";
export type ProjectChangeKind = "CREATED" | "CHANGED" | "REMOVED";
export type RuntimeProjectErrorCode =
  | "RUNTIME_PROJECT_INVALID"
  | "RUNTIME_PROJECT_PATH_UNSAFE"
  | "RUNTIME_PROJECT_NOT_FOUND"
  | "RUNTIME_PROJECT_UNAVAILABLE"
  | "RUNTIME_PROJECT_REGISTRY_CORRUPT"
  | "RUNTIME_PROJECT_INTAKE_CORRUPT";
```

`RuntimeProjectError` maps invalid/path/not-found to non-retryable `invalid-input` or `integrity`, unavailable to retryable `unavailable`, and corrupt registry/intake to non-retryable `integrity`. No raw filesystem/YAML diagnostics enter safe messages.

- [ ] **Step 4: Implement closed parsing and hashing**

YAML must be parsed with aliases disabled, converted once to plain data, schema-validated, normalized to POSIX relative paths, canonicalized, and deep-frozen. Registry hashes exclude only `entry_hash`; candidate keys are independently recomputed from project ID, registry revision, manifest hash, and the literal normalized change array.

- [ ] **Step 5: Run the focused contract gate and commit**

Run contract tests, documentation-integrity tests, typecheck, lint, and Prettier. Commit exactly the nine files above with `feat: define project intake contracts`.

### Task 3: Implement the private append-only project registry

**Files:**

- Create: `src/service/project/private-files.ts`
- Create: `src/service/project/registry.ts`
- Create: `test/project-registry.test.ts`
- Modify: `src/service/project/types.ts`

**Interfaces:**

- Consumes: project contract parsers/hashes, current-user path classification, canonical filesystem identity, `statePath`, injected clock/UUID
- Produces: `ProjectRegistry`, `createProjectRegistry(options)`, `register(root)`, `unregister(projectId)`, `list()`, `get(projectId)`, `recover()`, `stopIntake()`, `flush(signal)`

- [ ] **Step 1: Write failing real-filesystem registration tests**

Create real private `/tmp` projects and manifests. Assert first registration returns a generated stable ID/revision `1`; exact repeated root+manifest returns the same active registration without file growth; a changed manifest appends revision `2` for the same project ID; unregister appends a tombstone and leaves every project file untouched.

- [ ] **Step 2: Add failing root and corruption tests**

Assert fail-closed behavior for relative/nonexistent roots, final/intermediate symlinks, cross-owner modeled roots, unreadable roots, nonregular manifest, changed root identity during manifest read, wrong-mode registry paths, partial first record, partial final record, invalid complete record, broken hash/revision chain, duplicate project IDs, and two public registry instances racing the same root.

- [ ] **Step 3: Verify RED**

Run `npm exec vitest -- run test/project-registry.test.ts`.

Expected: FAIL because `createProjectRegistry` does not exist.

- [ ] **Step 4: Implement root binding and append-only publication**

Use a process-wide queue keyed by canonical state root. Open and retain descriptor identities for the canonical project root and `.toss/project.yaml`; reject symlinks and replacements before and after every async read. Publish canonical `0600` JSONL below private `0700` `<state>/projects/registry/`, synchronize file and directory, and enforce a 16 MiB bound before growth.

- [ ] **Step 5: Implement deterministic replay and recovery**

Rebuild active registrations only from a verified contiguous chain. A partial tail after at least one complete entry is quarantined and the exact prefix restored; a partial first record or invalid complete content blocks registry startup. Re-registration compares canonical root plus manifest hash; changed manifests append, exact repeats replay.

- [ ] **Step 6: Run focused/full journal regressions and commit**

Run project-registry tests, all `test/journal-*.test.ts`, typecheck, lint, and format. Commit the four files with `feat: add append-only project registry`.

### Task 4: Compile root-bounded watch and ignore scopes

**Files:**

- Create: `src/service/project/paths.ts`
- Create: `test/project-paths.test.ts`
- Modify: `src/service/project/contracts.ts`

**Interfaces:**

- Consumes: canonical root identity, normalized manifest paths, runtime state path
- Produces: `CompiledProjectScope`, `compileProjectScope(options)`, `classifyProjectChange(scope, absolutePath)`, `scanDeclaredScope(scope)`

- [ ] **Step 1: Write failing literal path-table tests**

For every watch/ignore path, name the production break: accepting a root escape, following a symlink, including `.git`, including `.toss/runtime`, including configured runtime state, or emitting a path outside a declared watch root. Include Unicode and separator edge cases; expected normalized paths are hand-authored POSIX literals.

- [ ] **Step 2: Write failing real-tree scope tests**

Build a project tree containing watched files, ignored globs, `.git`, `.toss/runtime`, an internal safe symlink, and a symlink escaping the root. Assert only regular files/directories reached without symlink traversal appear in the bytewise-sorted bounded scan; overflow never scans a sibling directory.

- [ ] **Step 3: Verify RED and implement the scope compiler**

Run the focused test, then implement descriptor-bound traversal with `lstat`, no-follow opens, canonical root-relative normalization, built-in ignores, manifest ignores, a 100,000-entry/256 MiB metadata scan ceiling, and exact root identity checks before and after scan.

- [ ] **Step 4: Run tests and commit**

Run project contract/registry/path tests and typecheck. Commit the three files with `feat: enforce project watch boundaries`.

### Task 5: Persist debounce windows and deduplicated candidate intents

**Files:**

- Create: `src/service/project/intake.ts`
- Create: `test/project-intake.test.ts`
- Modify: `src/service/project/types.ts`

**Interfaces:**

- Consumes: active registration, compiled scope, normalized `ProjectChange`, injected clock/timer/UUID
- Produces: `ProjectIntake`, `createProjectIntake(options)`, `record(change)`, `recover(registrations)`, `stopIntake()`, `flush(signal)`, `listCandidates()`

- [ ] **Step 1: Write failing debounce and key tests**

With a deterministic fake clock, assert first change writes a canonical pending snapshot before arming a timer; changes inside 200 ms coalesce; continuous changes flush at 2 seconds; change order and duplicates produce one bytewise-sorted change set and one hand-computed SHA-256 key.

- [ ] **Step 2: Write failing crash-window tests**

Inject interruption after pending-file sync, after candidate append, and before pending unlink. Restart must emit exactly one candidate or recognize the already appended key and remove only the exact owned pending file. A stale registry/manifest revision marks the window stale without emitting. Partial/unsafe/replaced pending files fail closed.

- [ ] **Step 3: Verify RED and implement atomic pending snapshots**

Pending snapshots use unique `0600` stages, exact-content checks, no-overwrite publication, and parent-directory sync beneath `<state>/projects/pending/`. Replace only an exact operation-owned prior snapshot after binding project/revision/root identity.

- [ ] **Step 4: Implement candidate append/deduplication**

Append canonical candidates beneath `<state>/projects/intake/candidates.jsonl`, synchronizing before success. Build the recovered key set from verified records; the same key appends no second record. Stop intake cancels new timers; flush waits only until the supplied abort signal.

- [ ] **Step 5: Run tests and commit**

Run project intake plus journal durability suites on Node 22. Commit the three files with `feat: persist debounced project intake`.

### Task 6: Add the macOS watcher coordinator and restart behavior

**Files:**

- Create: `src/service/project/watcher.ts`
- Create: `src/service/project/index.ts`
- Create: `test/project-watcher.test.ts`
- Modify: `src/service/supervisor.ts`
- Modify: `test/service-supervisor.test.ts`

**Interfaces:**

- Consumes: registry, scope compiler, intake, injected `WatchAdapter`, supervisor recovery lifecycle
- Produces: `ProjectWatcher`, `createProjectWatcher(options)`, and one `RecoveryParticipant` that owns registry recovery, pending recovery, watches, intake stop, and flush

- [ ] **Step 1: Write failing watcher behavior tests**

Use a deterministic adapter that emits complete real event records rather than asserting mock calls. Prove unregistered roots do nothing; active roots emit normalized changes; ignored/runtime files never open a window; rename maps to removed+created observations; duplicate native events collapse; root identity change appends `BLOCKED_PROJECT_UNAVAILABLE` and closes only that watcher.

- [ ] **Step 2: Write failing overflow and restart tests**

An overflow event must call the real bounded declared-scope scanner and produce changes only for that project. Startup order is registry recovery → pending recovery → scope validation → watch arm; shutdown order is stop watch intake → flush pending/candidates within signal → existing run interruption → socket/lock cleanup.

- [ ] **Step 3: Verify RED and implement the coordinator**

The production adapter uses `fs.watch` only on compiled declared roots with macOS recursive behavior where required. `filename: null`, adapter overflow, or unknown event kind triggers one bounded scope rescan; adapter errors block that project without stopping healthy project watchers.

- [ ] **Step 4: Wire supervisor lifecycle and commit**

Add the composite project participant to existing recovery participants without changing journal interruption precedence. Run project watcher, supervisor, serve smoke, and package tests. Commit the five files with `feat: watch registered project scopes`.

### Task 7: Extend the private control RPC for project operations

**Files:**

- Modify: `contracts/runtime/service-control-request.v1.schema.json`
- Modify: `contracts/runtime/service-control-response.v1.schema.json`
- Modify: `src/service/contracts.ts`
- Modify: `src/service/control.ts`
- Modify: `test/service-contracts.test.ts`
- Modify: `test/service-control.test.ts`

**Interfaces:**

- Consumes: `ProjectRegistry`, existing request-id replay cache, private socket identity checks
- Produces: discriminated `status`, `project-register`, `project-unregister`, and `project-list` requests; `requestProjectOperation(options)`; async server `handleRequest(request)`

- [ ] **Step 1: Write failing request/response contract tests**

Assert closed command-specific shapes: register requires one absolute `root`; unregister requires one UUID `project_id`; list/status accept neither. Successful project responses carry `data` with exact registration/list schema and `status: null`; status retains its existing response shape. Unknown/extra/sensitive-shaped fields fail validation.

- [ ] **Step 2: Write failing real-socket async operation tests**

Send canonical frames over a real private Unix socket. Assert request-id replay returns byte-identical cached output, changed input under the same ID returns conflict, concurrent connections are bounded, handler rejection maps to stable safe project errors, shutdown waits for an in-flight handler, and a replaced socket fails closed.

- [ ] **Step 3: Verify RED and implement async dispatch**

Convert frame handling to one bounded async operation per connection. Cache only completed canonical responses. Stop accepting prevents new dispatch; drain waits for active handlers. Project handler output is parsed again before framing so arbitrary values cannot escape the contract.

- [ ] **Step 4: Add the client and run compatibility tests**

`requestProjectOperation` must reuse exact runtime/socket identity checks, 5 second timeout, 64 KiB frame bound, request-id validation, and canonical response validation. Existing status client/server tests must remain byte compatible.

- [ ] **Step 5: Commit the RPC slice**

Run service contracts/control, project registry, Node 22 typecheck/lint/format, then commit exactly the six files with `feat: expose project registry control RPC`.

### Task 8: Add the `project` CLI and production service wiring

**Files:**

- Modify: `src/cli/grammar.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/service/supervisor.ts`
- Modify: `src/index.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/serve-smoke.test.ts`

**Interfaces:**

- Consumes: `requestProjectOperation`, composite project participant, loaded state/socket paths
- Produces: `toss-runtime project register <absolute-root> [--json]`, `unregister <project-id> [--json]`, and `list [--json]`

- [ ] **Step 1: Write failing grammar/output tests**

Assert exact positional grammar, duplicate/unknown option rejection, absolute-root enforcement, UUID validation, deterministic JSON command results, stable exit codes, and human messages that never echo unsafe paths or raw internal diagnostics.

- [ ] **Step 2: Write failing installed-service flow tests**

Run a real supervisor/control server in a private fixture, register a real project, list it, change its manifest and re-register, unregister it, restart the supervisor, and verify the registry/tombstone state. The CLI must fail safely when the service is absent and must not create state directly.

- [ ] **Step 3: Verify RED and implement CLI dispatch**

Extend `BaselineCommand` with a discriminated project command. Resolve the installed config/socket exactly as service status does; create one UUID request ID per CLI operation; map `RuntimeProjectError` to stable command result categories and exit codes.

- [ ] **Step 4: Wire production project services**

`createMainServices().serve` constructs registry/intake/watcher from the loaded state path, registers the composite recovery participant, and supplies the control request handler. Readiness fires only after registry/pending recovery and all valid watcher scopes are armed.

- [ ] **Step 5: Run integration tests and commit**

Run CLI, supervisor, service-control, serve-smoke, project suites, typecheck, lint, and format. Commit the six files with `feat: add project registry CLI`.

### Task 9: Publish documentation, package acceptance, and GitHub status

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/contracts/runtime-contract-protocol-v1.md`
- Modify: `docs/contracts/runtime-contract-v1.manifest.json`
- Modify: `src/index.ts`
- Modify: `test/package-metadata.test.ts`
- Modify: GitHub issue #29, PR, and epic #16

**Interfaces:**

- Consumes: all issue #29 public contracts and acceptance tests
- Produces: package-visible schemas/types, operator documentation, green macOS PR, Done issue, and tracked release-branch integration

- [ ] **Step 1: Add failing package/public API assertions**

Assert all three schemas and compiled public declarations are included in the tarball, project internals and pending state are not, and top-level exports parse contracts and expose registry/intake interfaces without exposing unsafe filesystem hooks.

- [ ] **Step 2: Update docs and make package tests GREEN**

Document explicit registration, manifest example, built-in ignores, no-scan guarantee, 200 ms/2 second debounce, restart behavior, stable project failures, and the candidate-only governance boundary. Keep v1.0.0 status honest: providers/tools/agent execution remain unavailable.

- [ ] **Step 3: Run final macOS acceptance**

Run on Node 22.23.1 and Node 24:

```bash
npm run verify
npm audit --omit=dev
git diff --check
```

Expected: format, lint, typecheck, all tests, build, exact installed-package smoke, and production audit pass; no state/socket/watcher/process/tarball artifact remains.

- [ ] **Step 4: Request independent review and close every finding**

Review contract closure, path/root identity, symlink handling, append/recovery durability, debounce determinism, duplicate suppression, RPC replay, shutdown ordering, and safe output. Every accepted defect gets a watched RED test, minimal fix, fresh full verification, and another review round until no findings remain.

- [ ] **Step 5: Complete PR/issue/integration workflow**

Push final commits, mark the PR ready, wait for macOS Node 22/24 GitHub checks, check every acceptance item, move issue/PR to Done, close #29 when checks are green, merge its PR into `release/v1.0.0`, and update epic #16 with the exact integration commit. Do not merge `release/v1.0.0` into `main` from this task.
