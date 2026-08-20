# Immutable Run Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build issue #1's immutable, hash-linked run journal, fail-closed resumable state machine, side-effect idempotency ledger, recovery path, and production supervisor interruption recorder.

**Architecture:** Add a focused `journal` subsystem whose canonical `run-journal-entry.v1` records are appended as private `0600` JSONL beneath `<state>/journals/<run-id>/events.jsonl`. Pure record and transition modules validate hashes, optimistic heads, legal state changes, idempotent command replay, and side-effect intent/completion; a filesystem store serializes each run, synchronizes every publication, recovers only a partial final line, and blocks corrupt complete history. The service supervisor consumes the journal through existing `RecoveryParticipant` and `InterruptionRecorder` interfaces, so shutdown persists `INTERRUPTED` before socket/lock teardown without letting service code inspect journal files directly.

**Tech Stack:** TypeScript 6 ESM, Node.js `node:fs/promises` with no-follow/private-path checks and file/directory `fsync`, canonical JSON and SHA-256 from the existing protocol module, JSON Schema 2020-12/Ajv, Vitest 4, npm 11.18.0, Node.js 22.23.1 and 24.19.0 on macOS.

**Spec:** `docs/superpowers/specs/2026-08-19-durable-local-service-design.md` (sections “Immutable run journal and state machine”, “Stable failures and recovery policy”, and “Testing and CI”), narrowed by `docs/superpowers/specs/2026-08-20-v1-release-program-design.md`.

## Global Constraints

- The issue branch is exactly `issue/1-immutable-run-journal`; its single PR targets `release/v1.0.0`.
- v1.0.0 supports macOS only; no issue #1 change may reintroduce a Linux release claim.
- Supported Node lines are Node.js 22 with a floor of 22.23.0 and Node.js 24.
- TOSS CLI owns governance, approval authority, and acceptance; journal contents are execution evidence only.
- Published entries are immutable canonical bytes; no snapshot, cache, retry, resume, or recovery operation may overwrite an accepted entry.
- Sequence and journal revision begin at `1`; the initial previous hash is exactly `sha256:` followed by 64 zeroes.
- Every transition supplies the exact expected journal revision and head hash; stale or illegal input appends no bytes.
- Every external side effect requires a durable intent first; unresolved intent is exposed for reconciliation and is never automatically repeated.
- State, journal, quarantine, and run directories are private current-user `0700`; journal and quarantine files are private current-user regular `0600`; symlinks, cross-owner entries, and group/world permissions fail closed.
- A partial final line is unpublished and may be quarantined before restoring the byte-identical valid prefix; an invalid complete line or broken interior chain blocks only that run.
- Service shutdown records active runs as `INTERRUPTED` before control-socket close, instance-lock release, and umask restoration.
- Stage only explicitly named files; never use `git add .`, `git add -A`, or `git add --all`.
- Do not merge to `main`, tag, publish npm `1.0.0`, create a GitHub Release, or close epic #16 in this issue.

---

### Task 1: Publish the issue plan and open the dedicated draft PR

**Files:**

- Create: `docs/superpowers/plans/2026-08-20-immutable-run-journal.md`
- Modify: GitHub issue #1 comment stream
- Modify: GitHub epic #16 comment stream

**Interfaces:**

- Consumes: approved v1 release program, durable service design, issue #1 acceptance criteria, branch `issue/1-immutable-run-journal`
- Produces: one committed execution plan, one remote issue branch, and one draft PR based on `release/v1.0.0`

- [ ] **Step 1: Verify the plan structure, formatting, and placeholder hygiene**

Run:

```bash
./node_modules/.bin/prettier --check docs/superpowers/plans/2026-08-20-immutable-run-journal.md
rg -n 'T[B]D|T[O]DO|implement[[:space:]]+later|fill[[:space:]]+in[[:space:]]+details|Similar[[:space:]]+to[[:space:]]+Task' docs/superpowers/plans/2026-08-20-immutable-run-journal.md
```

Expected: Prettier exits `0`; `rg` exits `1` with no matches.

- [ ] **Step 2: Commit only the issue plan**

Run:

```bash
git add -- docs/superpowers/plans/2026-08-20-immutable-run-journal.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: plan immutable run journal"
```

Expected: the staged list contains exactly the new plan and the commit succeeds.

- [ ] **Step 3: Push the branch and create at most one draft PR**

Run:

```bash
git push origin issue/1-immutable-run-journal
gh pr list --repo TOSS-Soft/toss-agent-runtime --head issue/1-immutable-run-journal --base release/v1.0.0 --state all --json number,url,state,isDraft
gh pr create --repo TOSS-Soft/toss-agent-runtime --base release/v1.0.0 --head issue/1-immutable-run-journal --draft --title "feat: implement immutable run journal" --body-file /tmp/toss-runtime-issue-1-pr.md
```

The PR body file must contain this exact acceptance map before creation:

```markdown
Closes #1 after the dedicated PR is acceptance-complete and green.

## Scope

- immutable canonical run-journal entries and hash-chain verification
- exact-head transition state machine and idempotent command replay
- durable side-effect intent/completion reconciliation
- partial-tail recovery and corrupt-interior fail-closed behavior
- production supervisor interruption persistence

## Acceptance checklist

- [ ] Published entry/revision cannot be overwritten
- [ ] Every transition binds the exact previous entry hash
- [ ] Illegal and stale transitions fail closed
- [ ] Approval pending survives process loss and resumes idempotently
- [ ] Retry never blindly duplicates provider/tool effects
- [ ] Partial/corrupt journals are not loaded as valid state
- [ ] State matrix, interruption, and recovery tests pass
```

Expected: the preflight list is empty, GitHub creates exactly one draft PR, and the PR base/head are exact.

- [ ] **Step 4: Link the branch and draft PR from issue #1 and epic #16**

Run:

```bash
gh issue comment 1 --repo TOSS-Soft/toss-agent-runtime --body "Implementation is active on \`issue/1-immutable-run-journal\`; the dedicated draft PR targets \`release/v1.0.0\`. The committed plan maps immutable publication, exact hash/revision transitions, approval resume, side-effect reconciliation, corruption recovery, and supervisor interruption persistence to TDD gates."
gh issue comment 16 --repo TOSS-Soft/toss-agent-runtime --body "Wave 1 issue #1 implementation is active in its dedicated branch/PR. Integration remains unchecked until that PR is acceptance-complete, green, and merged into \`release/v1.0.0\`."
```

Expected: both comments are published; issue #1 remains open and `In progress`.

### Task 2: Define and validate the canonical journal entry contract

**Files:**

- Create: `contracts/runtime/run-journal-entry.v1.schema.json`
- Create: `src/journal/types.ts`
- Create: `src/journal/errors.ts`
- Create: `src/journal/entry.ts`
- Create: `test/journal-entry.test.ts`
- Modify: `src/protocol/validator.ts`

**Interfaces:**

- Consumes: `canonicalJson(value: unknown): string`, `sha256(value: unknown): \`sha256:${string}\``, `parseJsonBytes(input): JsonValue`, `deepFreezeJson(value): JsonValue`, `sensitiveMetadataIssues(value, path)`
- Produces: `RunState`, `RunJournalEntryV1`, `HashableRunJournalEntryV1`, `JournalHead`, `SideEffectRecord`, `ZERO_JOURNAL_HASH`, `hashRunJournalEntry(entry)`, `parseRunJournalEntry(input)`, `RuntimeJournalError`, and stable `RuntimeJournalErrorCode`

- [ ] **Step 1: Write the failing contract tests**

Add tests using hand-authored literals; the production change each test catches is a parser/hash path that accepts mutation, secrets, unknown fields, or non-canonical linkage:

```ts
const hashable = {
  protocol_version: "runtime-contract.v1",
  schema_version: "run-journal-entry.v1",
  document_type: "run-journal-entry",
  run_id: "run-1",
  journal_revision: 1,
  run_attempt: 1,
  sequence: 1,
  previous_entry_hash: ZERO_JOURNAL_HASH,
  command_id: "command-1",
  command_input_hash: `sha256:${"1".repeat(64)}`,
  operation_id: null,
  side_effect: null,
  previous_state: null,
  state: "CREATED",
  reason_code: "RUN_CREATED",
  timestamp: "2026-08-20T12:00:00.000Z",
  trace: { trace_id: "1".repeat(32), span_id: "2".repeat(16), trace_flags: 1 },
  metadata: {},
} as const;
const entry = { ...hashable, entry_hash: hashRunJournalEntry(hashable) };

expect(parseRunJournalEntry(canonicalJson(entry))).toEqual({ ok: true, value: entry });
expect(parseRunJournalEntry(canonicalJson({ ...entry, state: "RUNNING" }))).toMatchObject({
  ok: false,
  code: "RUNTIME_DOCUMENT_INVALID",
});
expect(
  parseRunJournalEntry(canonicalJson({ ...entry, metadata: { apiTokenValue: "x" } })),
).toMatchObject({
  ok: false,
  code: "RUNTIME_DOCUMENT_INVALID",
});
```

Add table cases for all eleven states, `INTENT|COMPLETED` side-effect phases, exact SHA-256 syntax, safe integer bounds, valid UTC timestamps, closed-object rejection, and input over the bounded JSON size.

- [ ] **Step 2: Run the entry tests to verify RED**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/journal-entry.test.ts
```

Expected: FAIL because `src/journal/entry.ts` and its exports do not exist.

- [ ] **Step 3: Add the closed schema and journal types**

Define these exact public shapes:

```ts
export type RunState =
  | "CREATED"
  | "ROUTED"
  | "RUNNING"
  | "TOOL_PENDING"
  | "APPROVAL_PENDING"
  | "REVIEW_PENDING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED"
  | "INTERRUPTED";

export interface JournalHead {
  readonly journal_revision: number;
  readonly sequence: number;
  readonly entry_hash: `sha256:${string}`;
}

export interface SideEffectRecord {
  readonly identity: string;
  readonly phase: "INTENT" | "COMPLETED";
  readonly input_hash: `sha256:${string}`;
  readonly output_hash: `sha256:${string}` | null;
}
```

`RunJournalEntryV1` must contain exactly the fields exercised by Step 1. The schema must use the existing runtime-common definitions for identifiers, hashes, UTC timestamp, trace, and safe JSON; `operation_id`, `side_effect`, and `previous_state` are nullable closed unions. `entry_hash` is the only field omitted from `HashableRunJournalEntryV1`.

- [ ] **Step 4: Implement stable journal errors and the contract parser**

Use this stable error set:

```ts
export type RuntimeJournalErrorCode =
  | "RUNTIME_STATE_STALE"
  | "RUNTIME_STATE_TRANSITION_INVALID"
  | "RUNTIME_OPERATION_CONFLICT"
  | "RUNTIME_JOURNAL_CORRUPT"
  | "RUNTIME_JOURNAL_PATH_UNSAFE"
  | "RUNTIME_JOURNAL_UNAVAILABLE";
```

`RuntimeJournalError` must expose `code`, `category`, `retryable`, and `safe_message` from this closed table: stale → `stale-revision/false`; illegal transition → `invalid-input/false`; operation conflict → `stale-revision/false`; corruption and unsafe path → `integrity/false`; unavailable → `unavailable/true`. `hashRunJournalEntry` must call existing `sha256`; `parseRunJournalEntry` must validate the schema, reject secret/authority-shaped metadata keys, recompute the hash without `entry_hash`, and deep-freeze successful values.

- [ ] **Step 5: Register the schema and run the focused contract gate**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/journal-entry.test.ts
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run typecheck
```

Expected: journal entry tests pass and TypeScript reports no diagnostics.

- [ ] **Step 6: Commit the contract slice**

Run:

```bash
git add -- contracts/runtime/run-journal-entry.v1.schema.json src/journal/types.ts src/journal/errors.ts src/journal/entry.ts src/protocol/validator.ts test/journal-entry.test.ts
git diff --cached --check
git diff --cached --name-status
git commit -m "feat: define immutable run journal entries"
```

Expected: exactly the six named files are staged and the commit succeeds.

### Task 3: Implement the legal transition and idempotency model

**Files:**

- Create: `src/journal/state-machine.ts`
- Create: `test/journal-state-machine.test.ts`
- Modify: `src/journal/types.ts`

**Interfaces:**

- Consumes: `RunJournalEntryV1`, `RunState`, `JournalHead`, `SideEffectRecord`, `hashRunJournalEntry`, `RuntimeJournalError`
- Produces: `TransitionCommand`, `TransitionDecision`, `decideRunTransition(history, command, now)`, `findUnresolvedSideEffects(history)`, and `RUN_TRANSITION_MATRIX`

- [ ] **Step 1: Write the exhaustive failing transition matrix**

Use a literal matrix independent of production constants:

```ts
const allowed: Readonly<Record<string, readonly RunState[]>> = {
  NONE: ["CREATED"],
  CREATED: ["ROUTED", "BLOCKED", "CANCELLED", "INTERRUPTED"],
  ROUTED: ["RUNNING", "BLOCKED", "CANCELLED", "INTERRUPTED"],
  RUNNING: [
    "TOOL_PENDING",
    "APPROVAL_PENDING",
    "REVIEW_PENDING",
    "COMPLETED",
    "FAILED",
    "BLOCKED",
    "CANCELLED",
    "INTERRUPTED",
  ],
  TOOL_PENDING: ["RUNNING", "FAILED", "BLOCKED", "CANCELLED", "INTERRUPTED"],
  APPROVAL_PENDING: ["RUNNING", "BLOCKED", "CANCELLED", "INTERRUPTED"],
  REVIEW_PENDING: ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "INTERRUPTED"],
  FAILED: ["RUNNING", "CANCELLED"],
  BLOCKED: ["RUNNING", "CANCELLED"],
  INTERRUPTED: ["RUNNING", "BLOCKED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};
```

For every source/target pair, create a valid history and assert allowed pairs return a new entry while every other pair throws `RUNTIME_STATE_TRANSITION_INVALID` without mutating the history.

- [ ] **Step 2: Add failing stale, retry, approval, and duplicate-command tests**

Add real behavior cases proving:

```ts
expect(() => decideRunTransition(history, { ...command, expected_revision: 0 }, now)).toThrowError(
  expect.objectContaining({ code: "RUNTIME_STATE_STALE" }),
);
expect(decideRunTransition(history, command, now).kind).toBe("append");
expect(decideRunTransition([...history, appended], command, later).kind).toBe("replay");
expect(() =>
  decideRunTransition(
    [...history, appended],
    { ...command, metadata: { decision: "different" } },
    later,
  ),
).toThrowError(expect.objectContaining({ code: "RUNTIME_OPERATION_CONFLICT" }));
```

Assert `FAILED|BLOCKED|INTERRUPTED -> RUNNING` increments `run_attempt`; every other legal transition preserves it. Assert `APPROVAL_PENDING` survives serialization/reload and the same resume command replays the exact previously published entry.

- [ ] **Step 3: Run the state-machine tests to verify RED**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/journal-state-machine.test.ts
```

Expected: FAIL because `decideRunTransition` and the transition matrix do not exist.

- [ ] **Step 4: Implement pure transition decisions**

Define the command independently from generated timestamps:

```ts
export interface TransitionCommand {
  readonly run_id: string;
  readonly expected_revision: number;
  readonly expected_head_hash: `sha256:${string}`;
  readonly command_id: string;
  readonly operation_id: string | null;
  readonly next_state: RunState;
  readonly reason_code: string;
  readonly trace: TraceContext;
  readonly metadata: JsonValue;
  readonly side_effect: SideEffectRecord | null;
}

export type TransitionDecision =
  | { readonly kind: "append"; readonly entry: RunJournalEntryV1 }
  | { readonly kind: "replay"; readonly entry: RunJournalEntryV1 };
```

Compute `command_input_hash` from canonical command fields including the expected head but excluding the internally generated timestamp. Search an exact `command_id` before stale-head validation: an equal digest returns `replay`; a different digest throws conflict. For new work, validate exact head, consult the closed matrix, derive revision/sequence/attempt/previous state/hash, then hash and freeze the entry.

- [ ] **Step 5: Implement side-effect ledger reconciliation**

`findUnresolvedSideEffects` must scan verified history by identity. The first record must be `INTENT` with `output_hash: null`; a matching `COMPLETED` must have the same `input_hash` and non-null `output_hash`. Duplicate exact phases replay through command idempotency; changed digest, completion without intent, second intent, or second different completion throws `RUNTIME_OPERATION_CONFLICT`. Return only unresolved intent records and never invoke an external operation.

- [ ] **Step 6: Run focused tests and commit the state-machine slice**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/journal-entry.test.ts test/journal-state-machine.test.ts
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run typecheck
git add -- src/journal/types.ts src/journal/state-machine.ts test/journal-state-machine.test.ts
git diff --cached --check
git commit -m "feat: enforce resumable run transitions"
```

Expected: focused tests and typecheck pass; only the three named files are committed.

### Task 4: Build the private append-only store and recovery path

**Files:**

- Create: `src/journal/filesystem.ts`
- Create: `src/journal/store.ts`
- Create: `test/journal-store.test.ts`
- Create: `test/journal-recovery.test.ts`

**Interfaces:**

- Consumes: `parseRunJournalEntry`, `decideRunTransition`, `findUnresolvedSideEffects`, `RuntimeJournalError`, Node file handles
- Produces: `RunJournalStore`, `RunJournalSnapshot`, `TransitionResult`, `CreateRunJournalStoreOptions`, `createRunJournalStore(options)`, plus `RecoveryParticipant`-compatible `recover()` and `flush(signal)` methods

- [ ] **Step 1: Write failing real-filesystem publication tests**

Using a real `/tmp` fixture with private directories, assert:

```ts
const store = createRunJournalStore({ statePath, now, randomId });
const created = await store.transition(createCommand);
const bytesAfterCreate = await readFile(path.join(statePath, "journals", "run-1", "events.jsonl"));
const routed = await store.transition(routeCommand(created.head));
expect(
  Buffer.from(bytesAfterCreate).equals(
    (await readFile(eventsPath)).subarray(0, bytesAfterCreate.length),
  ),
).toBe(true);
expect(routed.head).toMatchObject({ journal_revision: 2, sequence: 2 });
expect((await lstat(eventsPath)).mode & 0o777).toBe(0o600);
```

Add cases for concurrent calls to the same run (one exact head wins; the other gets stale), parallel calls to different runs, same-command replay without file growth, sync failure without successful return, symlink/nonregular/wrong-mode/cross-owner modeled paths, invalid run IDs, and bounded file size.

- [ ] **Step 2: Write failing recovery and corruption tests**

Use literal bytes to cover:

- valid lines plus an unterminated final fragment: fragment copied byte-for-byte to one private quarantine artifact; events file restored to the byte-identical valid prefix and synchronized;
- an invalid newline-terminated final record: `RUNTIME_JOURNAL_CORRUPT`, no truncation or quarantine cleanup;
- a broken interior hash, skipped revision, changed run ID, illegal transition, or side-effect conflict: corrupt and preserved;
- crash leftovers from the exact recovery-stage namespace: exact private stage is reclaimed, unknown/wrong-type entries fail closed;
- abort before an interruption append: no later append begins; an append already synchronized remains observable.

- [ ] **Step 3: Run the store/recovery tests to verify RED**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/journal-store.test.ts test/journal-recovery.test.ts
```

Expected: FAIL because `createRunJournalStore` and private journal filesystem operations do not exist.

- [ ] **Step 4: Implement path validation and durable append**

`filesystem.ts` must:

- validate absolute state ancestry without following symlinks;
- create/validate `state`, `journals`, each run directory, and `quarantine` as current-user `0700`;
- accept only the basename `events.jsonl` and the exact recovery stage pattern `.events-recovery.<uuid>.stage`;
- open journals with `O_CREAT|O_APPEND|O_WRONLY|O_NOFOLLOW` and mode `0600`;
- compare bigint device/inode identities before and after every asynchronous boundary that precedes mutation;
- write exactly `Buffer.from(canonicalJson(entry) + "\n", "utf8")`, call file `sync()`, and return only after sync succeeds;
- serialize operations per run through an internal promise queue without swallowing rejection.

- [ ] **Step 5: Implement full-chain loading and partial-tail recovery**

Read through a held `O_RDONLY|O_NOFOLLOW` file descriptor under a fixed 64 MiB per-run v1 limit. Split only on byte `0x0a`. Parse and validate every complete line, then independently verify contiguous sequence/revision, run ID, previous hash, legal transition, command uniqueness, and side-effect ledger. If a nonempty unterminated suffix follows an otherwise valid prefix, write it to a create-only quarantine file, fsync it and its parent, write the exact prefix to a private recovery stage, fsync stage, atomically rename stage over the journal, fsync the run directory, and re-open/revalidate the result. Never recover an invalid complete line.

- [ ] **Step 6: Implement the public store surface**

Use these exact result and store shapes:

```ts
export interface TransitionResult {
  readonly entry: RunJournalEntryV1;
  readonly head: JournalHead;
  readonly replayed: boolean;
}

export interface RunJournalSnapshot {
  readonly run_id: string;
  readonly state: RunState;
  readonly head: JournalHead;
  readonly entries: readonly RunJournalEntryV1[];
  readonly unresolved_side_effects: readonly SideEffectRecord[];
}

export interface RunJournalStore {
  recover(): Promise<void>;
  stopIntake(): void;
  flush(signal: AbortSignal): Promise<void>;
  transition(command: TransitionCommand): Promise<TransitionResult>;
  load(runId: string): Promise<RunJournalSnapshot | null>;
  list(): Promise<readonly RunJournalSnapshot[]>;
  unresolvedSideEffects(runId: string): Promise<readonly SideEffectRecord[]>;
  interruptActive(signal: AbortSignal): Promise<void>;
}
```

`transition` rejects new caller intake after `stopIntake`; the internal shutdown path remains allowed to append interruption records. `flush` waits for already queued work unless aborted; `list` sorts run IDs by UTF-8 byte order and verifies every returned history. `interruptActive` lists verified journals, skips terminal `COMPLETED|CANCELLED|INTERRUPTED`, and appends an `INTERRUPTED` command with deterministic `command_id = shutdown:<journal_revision>:<entry_hash-without-prefix>` using the snapshot's exact head. Stale races reload once and skip only if the new state is terminal; no unresolved side effect is retried.

- [ ] **Step 7: Run focused store gates and commit**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/journal-entry.test.ts test/journal-state-machine.test.ts test/journal-store.test.ts test/journal-recovery.test.ts
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run typecheck
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run lint
git add -- src/journal/filesystem.ts src/journal/store.ts test/journal-store.test.ts test/journal-recovery.test.ts
git diff --cached --check
git commit -m "feat: persist and recover private run journals"
```

Expected: all four journal test files, typecheck, and lint pass; exactly the four named files are committed.

### Task 5: Wire production supervisor interruption persistence

**Files:**

- Create: `src/journal/index.ts`
- Create: `test/journal-supervisor.test.ts`
- Modify: `src/cli/main.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/service-supervisor.test.ts`

**Interfaces:**

- Consumes: `createRunJournalStore`, `RecoveryParticipant`, `InterruptionRecorder`, configured `paths.state`, existing supervisor shutdown order
- Produces: one production store instance registered as recovery participant and interruption recorder; no-op production interruption path is removed

- [ ] **Step 1: Write the failing supervisor integration test**

Create a real journal in `RUNNING`, start the real supervisor with its real journal store, deliver `SIGTERM`, and assert observable ordering:

```ts
expect((await store.load("run-active"))?.state).toBe("RUNNING");
signals.emit("SIGTERM");
await outcome;
expect((await store.load("run-active"))?.state).toBe("INTERRUPTED");
expect(events).toEqual([
  "stop-intake",
  "interrupted-synced",
  "control-drained",
  "journal-flushed",
  "socket-closed",
  "lock-released",
  "umask-restored",
]);
```

Also assert `APPROVAL_PENDING` and `TOOL_PENDING` become `INTERRUPTED`, terminal journals remain byte-identical, an interruption sync error produces a safe service failure, and a forced deadline never reports interruption durability when sync did not finish.

- [ ] **Step 2: Run the integration tests to verify RED**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/journal-supervisor.test.ts test/service-supervisor.test.ts test/cli.test.ts
```

Expected: FAIL because production `createMainServices().serve` still supplies a no-op interruption recorder.

- [ ] **Step 3: Create one production journal store and wire both interfaces**

In `serve`, after loading config, construct exactly one store with `statePath: loaded.config.paths.state`, the injected clock, and the existing UUID source. Supply it as the only issue #1 recovery participant and as `interruptionRecorder`:

```ts
const journal = createRunJournalStore({
  statePath: loaded.config.paths.state,
  now: options.now,
  randomId: options.createServiceInstanceId,
});

return runSupervisor({
  // existing options remain unchanged
  recoveryParticipants: [journal],
  interruptionRecorder: journal,
});
```

Remove the no-op comment and recorder. Journal errors crossing the supervisor boundary must normalize to `RUNTIME_SERVICE_UNAVAILABLE`; their private path/corruption details never reach command JSON or stderr.

- [ ] **Step 4: Run the supervisor, CLI, and journal suites**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/journal-entry.test.ts test/journal-state-machine.test.ts test/journal-store.test.ts test/journal-recovery.test.ts test/journal-supervisor.test.ts test/service-supervisor.test.ts test/cli.test.ts
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run typecheck
```

Expected: all selected tests pass and TypeScript reports no diagnostics.

- [ ] **Step 5: Commit the service integration slice**

Run:

```bash
git add -- src/journal/index.ts src/cli/main.ts test/journal-supervisor.test.ts test/cli.test.ts test/service-supervisor.test.ts
git diff --cached --check
git commit -m "feat: persist active runs before shutdown"
```

Expected: only the five named files are committed.

### Task 6: Publish the journal API, contract documentation, and exact package contents

**Files:**

- Modify: `src/index.ts`
- Modify: `docs/contracts/runtime-contract-v1.manifest.json`
- Modify: `docs/contracts/runtime-contract-protocol-v1.md`
- Modify: `docs/contracts/toss-cli-v2.2-compatibility.md`
- Modify: `docs/contracts/local-service-control-v1.md`
- Modify: `README.md`
- Modify: `scripts/package-files.json`
- Modify: `test/documentation-integrity.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: completed journal public types/functions and generated `dist/src/journal/*`
- Produces: packaged schema, public TypeScript API, exact npm manifest entries, and documentation that no longer describes issue #1 or production interruption persistence as pending

- [ ] **Step 1: Write failing public/package documentation assertions**

Extend the integrity test so the schema list contains `run-journal-entry.v1` in lexicographic manifest position, the root API exports `createRunJournalStore`, and the README/service contract state that active runs are durably interrupted before owned service resources are removed. Replace the issue #1 pending assertion with an assertion that #28's remaining acceptance is only the real macOS login/native crash-loop gate.

- [ ] **Step 2: Run the integrity and package-content tests to verify RED**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/documentation-integrity.test.ts
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run build
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run test:package:contents
```

Expected: at least the manifest/public export/package file assertions fail because the journal artifacts are not yet listed.

- [ ] **Step 3: Export the narrow journal API and register the contract**

Export `createRunJournalStore`, `hashRunJournalEntry`, `parseRunJournalEntry`, `RuntimeJournalError`, the transition matrix/decision helper, and all public journal types from `src/index.ts`. Add the schema to the validator fragment registry and contract manifest. Do not export filesystem internals, operation hooks, private path inspectors, or recovery-stage names.

- [ ] **Step 4: Update exact package contents**

Add source-generated journal artifacts to `scripts/package-files.json` in sorted location:

```text
dist/src/journal/entry.d.ts
dist/src/journal/entry.d.ts.map
dist/src/journal/entry.js
dist/src/journal/entry.js.map
dist/src/journal/errors.d.ts
dist/src/journal/errors.d.ts.map
dist/src/journal/errors.js
dist/src/journal/errors.js.map
dist/src/journal/filesystem.d.ts
dist/src/journal/filesystem.d.ts.map
dist/src/journal/filesystem.js
dist/src/journal/filesystem.js.map
dist/src/journal/index.d.ts
dist/src/journal/index.d.ts.map
dist/src/journal/index.js
dist/src/journal/index.js.map
dist/src/journal/state-machine.d.ts
dist/src/journal/state-machine.d.ts.map
dist/src/journal/state-machine.js
dist/src/journal/state-machine.js.map
dist/src/journal/store.d.ts
dist/src/journal/store.d.ts.map
dist/src/journal/store.js
dist/src/journal/store.js.map
dist/src/journal/types.d.ts
dist/src/journal/types.d.ts.map
dist/src/journal/types.js
dist/src/journal/types.js.map
```

Also add source and `dist/` schema paths. Do not add tests, superpowers plans/specs, verification evidence, tarballs, temporary files, or journal runtime data.

- [ ] **Step 5: Update operator and protocol documentation**

Document exact-head optimistic concurrency, transition matrix, command replay/conflict, side-effect intent reconciliation, partial-tail quarantine, corrupt-interior blocking, and supervisor shutdown ordering. Remove only claims made true by this PR; keep agents/providers/tools/project watcher/logging, real macOS login lifecycle, npm `1.0.0`, and later issues explicitly pending.

- [ ] **Step 6: Run focused documentation/package gates and commit**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/documentation-integrity.test.ts
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run build
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run test:package:contents
git add -- src/index.ts docs/contracts/runtime-contract-v1.manifest.json docs/contracts/runtime-contract-protocol-v1.md docs/contracts/toss-cli-v2.2-compatibility.md docs/contracts/local-service-control-v1.md README.md scripts/package-files.json test/documentation-integrity.test.ts CHANGELOG.md
git diff --cached --check
git commit -m "docs: publish the run journal contract"
```

Expected: focused tests, build, and exact package contents pass; only the nine named files are committed.

### Task 7: Verify issue #1 acceptance, update GitHub continuously, and integrate only after green

**Files:**

- Modify: GitHub PR for `issue/1-immutable-run-journal`
- Modify: GitHub issue #1 state/project item/comment stream
- Modify: GitHub epic #16 checklist/comment stream
- Modify after merge: local and remote `release/v1.0.0` branch only

**Interfaces:**

- Consumes: all issue #1 commits and acceptance tests
- Produces: green non-draft PR, closed/Done issue #1, merged version-branch integration, and an updated epic integration record

- [ ] **Step 1: Run fresh focused acceptance under Node 22.23.1**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test -- test/journal-entry.test.ts test/journal-state-machine.test.ts test/journal-store.test.ts test/journal-recovery.test.ts test/journal-supervisor.test.ts test/service-supervisor.test.ts test/cli.test.ts test/documentation-integrity.test.ts
```

Expected: every selected test passes with zero failures.

- [ ] **Step 2: Run complete Node 22.23.1 verification and audit**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run verify
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js audit --omit=dev
```

Expected: format, lint, strict typecheck, complete Vitest suite, build, installed-package smoke, exact package manifest, and production audit pass; audit reports zero vulnerabilities.

- [ ] **Step 3: Run complete Node 24.19.0 verification**

Run:

```bash
npm exec --yes --package=node@24.19.0 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run verify
```

Expected: the same macOS suite and installed-package acceptance pass with zero failures except any explicitly named native-host skip already present in the baseline.

- [ ] **Step 4: Verify repository and artifact hygiene before push**

Run:

```bash
git diff --check
git status --short
find . -maxdepth 1 -type f -name '*.tgz' -print
git log --oneline origin/release/v1.0.0..HEAD
```

Expected: no unstaged/staged tracked changes, no root tarball, and the range contains only issue #1 plan/implementation/documentation commits.

- [ ] **Step 5: Push, mark ready, and wait for PR checks**

Run:

```bash
git push origin issue/1-immutable-run-journal
PR_NUMBER=$(gh pr list --repo TOSS-Soft/toss-agent-runtime --head issue/1-immutable-run-journal --base release/v1.0.0 --state open --json number --jq '.[0].number')
test -n "$PR_NUMBER"
gh pr ready "$PR_NUMBER" --repo TOSS-Soft/toss-agent-runtime
gh pr checks "$PR_NUMBER" --repo TOSS-Soft/toss-agent-runtime --watch --interval 10
gh pr view "$PR_NUMBER" --repo TOSS-Soft/toss-agent-runtime --json state,isDraft,baseRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,url
```

Expected: every required macOS Node check is `SUCCESS`; PR is non-draft, based on `release/v1.0.0`, `MERGEABLE`, and `CLEAN`.

- [ ] **Step 6: Record the acceptance map, move issue #1 to Done, and close it before merge**

Post one issue comment containing the exact PR URL/head commit, focused/full commands, Node/npm/macOS versions, test counts, package file count, audit result, and this mapping:

```text
immutable publication -> journal-store prefix/permission/replay tests
exact previous hash -> entry/state-machine/full-chain tests
stale/illegal fail-closed -> exhaustive matrix and no-growth tests
approval persistence/resume -> restart/replay tests
no duplicate side effect -> intent/completion/unresolved recovery tests
partial/corrupt rejection -> recovery and interior-corruption tests
interruption -> real supervisor ordering/persistence tests
```

Then set the project item to `Done` and close issue #1. Expected: issue status reflects acceptance-complete green PR without waiting for merge, matching the approved GitHub status contract.

- [ ] **Step 7: Merge the green PR into the version branch and re-run the integration gate**

Run:

```bash
PR_NUMBER=$(gh pr list --repo TOSS-Soft/toss-agent-runtime --head issue/1-immutable-run-journal --base release/v1.0.0 --state open --json number --jq '.[0].number')
test -n "$PR_NUMBER"
gh pr merge "$PR_NUMBER" --repo TOSS-Soft/toss-agent-runtime --merge
git fetch origin --prune
git switch release/v1.0.0
git merge --ff-only origin/release/v1.0.0
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run verify
npm exec --yes --package=node@24.19.0 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run verify
git status --short
```

Expected: PR is merged, both integration gates pass, and the version-branch worktree is clean.

- [ ] **Step 8: Update epic #16 and start the next dependency issue**

Check only issue #1's acceptance and integration items in epic #16, record the merge commit and green integration evidence, and move issue #29 to `In progress` only when its dedicated branch is created from the new `release/v1.0.0` head. Do not mark issue #28 Done until its separate remaining real macOS service acceptance is proven.
