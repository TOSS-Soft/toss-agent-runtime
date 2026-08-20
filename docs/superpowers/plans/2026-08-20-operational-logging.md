# Issue #30 Operational Logging Implementation Plan

> Scope: macOS v1.0.0, one issue / one branch / one PR. Issue #30 is complete only when its PR checks are green. Integration then targets `release/v1.0.0`.

## Objective

Add a bounded, secret-safe operational event channel that is distinct from immutable execution evidence. The service must durably order operational events, recover a partial final line, rotate and retain only its own files, expose deterministic finite and human follow rendering, and report a sticky degraded state when durability cannot be proved.

## Fixed design

- `operational-event.v1` is a closed canonical JSON document with a UUID event ID, UTC timestamp, service instance ID and sequence, level, component, event name, correlation ID, optional project/job/run IDs, and primitive safe metadata.
- Producers provide an explicit metadata-key allowlist. Secret-shaped keys, unrestricted nested values, and structurally tagged sensitive values are omitted before serialization; the existing normalized sensitive-key scan remains parser defense in depth.
- One process-wide queue per canonical log root serializes writes. Files and directories are current-user private (`0600`/`0700`), opened without symlink following, and revalidated by bigint identity around mutations.
- `operational-current.jsonl` is rotated before a configured byte boundary or UTC-day change. Closed names are `operational-YYYY-MM-DD-NNNNNN.jsonl`; publication is no-overwrite and directory-synchronized.
- Recovery accepts canonical complete lines, truncates only a partial final line after synchronizing the repaired file and directory, and emits one later safe recovery event. Invalid interior lines fail closed.
- Retention considers only exact runtime-owned closed filenames. It deletes closed files older than seven days or outside the aggregate closed-log byte budget, and never traverses state/evidence/project trees or deletes the active file.
- Any write, sync, rotation, or retention failure that prevents a required durability proof sets a shared sticky `RUNTIME_LOGGING_DEGRADED` state. New required events and shutdown flush fail until a successful explicit recovery.
- Finite log reading returns a bounded ordered set. Human rendering and JSON output retain the same event IDs. `--follow` is human-only, verifies a live service first, follows rotation by polling the validated reader, and suppresses duplicate event IDs.
- Operational logs never authorize gates and are not execution evidence.

## Task 1 — Contract, safe metadata, and stable failures

Files:

- Add `contracts/runtime/operational-event.v1.schema.json`
- Add `src/logging/contracts.ts`, `src/logging/types.ts`, `src/logging/errors.ts`
- Update `src/protocol/capabilities.ts`, `contracts/runtime/runtime-capabilities.v1.schema.json`
- Update the contract manifest, examples, package file allowlist, and public exports
- Add `test/operational-log-contracts.test.ts`

RED tests:

- exact canonical event parses and freezes;
- unknown fields, noncanonical UUIDs/timestamps/sequences, unsafe metadata, secret-shaped keys, and oversized documents fail;
- writer sanitization omits tagged secrets, environment/argument/prompt/tool payload keys, and non-allowlisted metadata;
- runtime capabilities advertise `operational-event.v1`.

## Task 2 — Durable writer and recovery

Files:

- Add `src/logging/store.ts`
- Add `test/operational-log-store.test.ts`

RED tests:

- concurrent writes receive one monotonic sequence and exact append order;
- active file is private, canonical, complete-line JSONL and file/directory synchronized before success;
- same-root public store instances share writer order and sticky health;
- partial final line is truncated and later reported once; invalid interior content is preserved and rejected;
- replacement, symlink, wrong owner/mode, size overflow, and write/sync faults fail closed;
- failed durability makes required writes and flush return `RUNTIME_LOGGING_DEGRADED`; successful recovery is the only reset.

## Task 3 — Rotation and retention

Files:

- Extend `src/logging/store.ts`
- Extend `test/operational-log-store.test.ts`

RED tests:

- rotate before size overflow and at a UTC-day boundary without reordering;
- no-overwrite closed-name collision and replacement races fail closed;
- restart continues the next closed-file sequence;
- retention removes only exact private runtime-owned closed logs older than seven days or outside the aggregate budget;
- active, unknown, linked, unsafe, canonical artifact, project, journal, and evidence files are preserved;
- rotation/retention interruption leaves a recoverable bounded grammar.

## Task 4 — Reader, rendering, and follow

Files:

- Add `src/logging/reader.ts`, `src/logging/render.ts`
- Add `test/operational-log-reader.test.ts`

RED tests:

- finite reads are bytewise ordered, bounded, and filter by minimum level/project/run;
- JSON and human rows preserve identical event IDs;
- reader crosses rotations, ignores only a partial active tail, rejects corrupt interior lines, and deduplicates event IDs;
- follow resumes after rotation without replaying an event and stops on abort;
- filters never reflect unsafe input or paths.

## Task 5 — CLI and service lifecycle integration

Files:

- Update `src/cli/grammar.ts`, `src/cli/main.ts`, `src/cli/result.ts`
- Update `src/service/supervisor.ts`, `src/service/contracts.ts`, `src/service/control.ts`
- Update `src/service/errors.ts`
- Update `test/cli.test.ts`, `test/service-supervisor.test.ts`, `test/service-contracts.test.ts`, `test/service-control.test.ts`, `test/serve-smoke.test.ts`

Behavior:

- Add the exact finite/follow grammar from the accepted design; reject `--follow --json`, duplicate filters, invalid UUIDs, and unsafe values without reflection.
- Main services load the configured log root. Finite reads and follow first prove the private service is available, then use the read-only logging interface; they never write logger files.
- Supervisor recovers the logger before readiness, emits safe lifecycle events, includes it in ordered shutdown flush, and reports `health: degraded` after sticky logging failure.
- State-changing service/project operations acknowledge success only after their safe operational event is durable.
- Doctor/status expose only fixed `RUNTIME_LOGGING_DEGRADED` detail.

## Task 6 — Documentation and package acceptance

Files:

- Update `README.md`, `docs/contracts/local-service-control-v1.md`, `docs/contracts/runtime-contract-protocol-v1.md`, `CHANGELOG.md`
- Update `scripts/package-files.json`, `scripts/package-test.mjs`, documentation/package tests

Acceptance:

- document log/evidence separation, grammar, privacy, rotation, retention, recovery, degraded semantics, and macOS-only release scope;
- packaged declarations expose only the intended logger reader/types, contract/example is present, internal filesystem implementation declarations/maps remain private;
- installed supervisor smoke observes safe start/ready/stop events and leaves no process/socket/temp artifact.

## Task 7 — Verification, review, and delivery

Run:

```text
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:package
npm audit --omit=dev
git diff --check
```

Then request an independent read-only review. Push only the Issue #30 branch, make its PR ready after local acceptance, wait for macOS Node 22.23.1 and Node 24 CI, mark the issue/PR project items Done and close Issue #30 when CI is green, merge the PR into `release/v1.0.0`, and update Epic #16.
