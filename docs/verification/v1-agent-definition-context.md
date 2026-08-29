# v1 Agent Definition and Context Acceptance Evidence

## Scope and binding

This record covers the immutable agent definition registry and
provenance-aware context compiler for issue #7. It binds the clean,
evidence-free publishable preparation
`34360a178bdc84d128d7d83fbc40b839e16a91eb`, verified on 2026-08-29.
That commit contains the complete approved code, tests, contracts,
documentation, examples, and package surface from
`1b9ece146f790c7973553fe9ecb6a80d36737edc`, but no
`docs/verification/v1-agent-definition-context.md`. Commit `34360a1` differs
from `1b9ece1` only by deleting the stale pre-final-review evidence document.

The whole-branch re-review at `1b9ece1` is **APPROVED** with no remaining or
new Critical, Important, or Minor finding. The evidence-free preparation was
created afterward with the single-purpose commit message
`test: clear stale agent context verification`. This evidence-only commit
therefore binds a non-circular exact head.

This repository evidence is intentionally excluded from the npm package.
Issue #7 remains open pending controller delivery. No push, pull request,
issue update, tag, npm publication, or GitHub release is claimed.

## Environment

| Item               | Verified value                                   |
| ------------------ | ------------------------------------------------ |
| Date               | `2026-08-29`                                     |
| Publishable prep   | `34360a178bdc84d128d7d83fbc40b839e16a91eb`       |
| Approved code head | `1b9ece146f790c7973553fe9ecb6a80d36737edc`       |
| Primary runtime    | Node `v22.23.1`; npm `11.18.0`                   |
| Compatibility run  | Node `v24.19.0`; npm `11.18.0`                   |
| OS/architecture    | macOS `26.6.1` / `arm64`                         |
| Package            | `@toss-software/agent-runtime@0.0.0-development` |

No username, home-directory path, environment value, credential, provider
configuration, secret, socket path, PID, claim owner, or temporary path is
recorded.

## Exact clean-prep verification

The evidence-free preparation was verified using these exact commands:

```sh
npx --yes --package=node@22.23.1 --package=npm@11.18.0 --call 'node --version && npm --version && npm run verify && npm audit --omit=dev'
npx --yes --package=node@24.19.0 --package=npm@11.18.0 --call 'node --version && npm --version && npm run verify && npm audit --omit=dev'
```

Both commands exited `0`.

| Stage                       | Node 22 result                                                  | Node 24 result                                                  |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Runtime identity            | `v22.23.1`; npm `11.18.0`                                       | `v24.19.0`; npm `11.18.0`                                       |
| Format/lint/typecheck       | Passed                                                          | Passed                                                          |
| Full test suite             | 55 files; 1,850 passed; 1 host-conditional skip; 1,851 total    | 55 files; 1,850 passed; 1 host-conditional skip; 1,851 total    |
| Build                       | Passed                                                          | Passed                                                          |
| Scripts-enabled package     | Exact 391-file inventory passed                                 | Exact 391-file inventory passed                                 |
| Installed consumer          | Imports, examples, launcher, service, and cleanup checks passed | Imports, examples, launcher, service, and cleanup checks passed |
| Production dependency audit | 0 vulnerabilities                                               | 0 vulnerabilities                                               |

Two exact Node 22/npm 11.18 focused gates also exited `0`:

- contracts, context, registry, integration, public API, documentation
  integrity, generic protocol validation, and package metadata: 8 files,
  243/243 passed, no skip;
- every `test/agent-*.test.ts` suite: 7 files, 313/313 passed, no skip.

After this evidence document was recreated, the exact Node 22 full command was
run again. Formatting, lint, typecheck, the same 55-file/1,850-pass/one-skip
suite, build, scripts-enabled installed-package acceptance, and the
zero-vulnerability production audit all passed with the document present.

The sole skip in each complete run was
`native service definition validation > passes native systemd unit validation`,
which is guarded by `process.platform === "linux"` and therefore skipped on
this macOS host. The Darwin native validator passed. A focused run also proved
that `durable project candidate intake > serializes casing aliases of the same
intake root` executes and passes on this host. No Issue #7 test skipped.

## Package and installed-consumer evidence

The full verifier's `npm run test:package` path performs a real
scripts-enabled `npm pack`. Its prepack lifecycle runs formatting, lint,
typecheck, build, and contents-only package acceptance exactly once. The
tarball is installed with scripts disabled into a fresh temporary consumer.

The installed consumer proves package-root imports and private deep-import
exclusion; parses and hash-checks the canonical definition, request, and final
compiled-context examples; checks the executable mode, help, version,
capabilities, and installed manifest; exercises private service state,
control, duplicate serve, SIGKILL recovery/restart, SIGTERM and SIGINT
shutdown, and safe missing-config failure; then reaps its processes and
artifacts.

Fresh scripts-enabled metadata captures on both exact runtimes produced
byte-identical tarballs:

| Item             | Exact value                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Filename         | `toss-software-agent-runtime-0.0.0-development.tgz`                                               |
| Packed files     | 391                                                                                               |
| Packed size      | 374,531 bytes                                                                                     |
| Unpacked size    | 2,186,173 bytes                                                                                   |
| npm SHA-1 shasum | `7d1d30455702e4ac8e67d9fcd17636929144df65`                                                        |
| SHA-256          | `b0ecef0d174c5a2f118efc586dafe025a93dcea3353127e0b7b4a21137eca9c6`                                |
| npm integrity    | `sha512-N4wMba+v9lNTvctiDdvDuFlu8EhDVkcBs9K9bMlTgbGXO0WKp0KAuqkV1lyKTg5XMKBjOEjDgRmdZQtii2LMsw==` |

All paths match `scripts/package-files.json` exactly. After this document was
recreated, documentation integrity, contents-only package acceptance, and a
direct npm report were rerun. The inventory remained exactly 391 files and did
not include `docs/verification/v1-agent-definition-context.md`. A final real
scripts-enabled package after document creation reproduced the exact size,
SHA-1, SHA-256, and SRI values above. Every explicit tarball was created
outside the repository in an operation-owned temporary directory and removed
immediately after hashing.

## Issue #7 acceptance matrix

| Issue #7 acceptance criterion                                                                                    | Exact current test file and title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Result |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Agent definition is separate from model/provider identity.                                                       | `test/agent-contracts.test.ts` — `agent contract documents > rejects provider, route, endpoint, and concrete-model identity in agent definitions`; `test/agent-authority.test.ts` — `execution request authority matching > rejects logical class before any resolver can be called`                                                                                                                                                                                                                                                                                   | Pass   |
| Execution uses only an ACTIVE agent matching the Task Contract and allowed capability envelope.                  | `test/agent-registry.test.ts` — `immutable agent lifecycle registry > activates revision 2, rejects revision 1 for execution, and retains revision 1 for resume`; `test/agent-authority.test.ts` — `execution request authority matching > rejects Task Contract before any resolver can be called`, the exact missing/extra model and Superpowers capability titles, and `execution request authority matching > rejects duplicate requested model and Superpowers capabilities`                                                                                      | Pass   |
| Every canonical context input binds an exact artifact type, ID, revision, hash, content, and producer semantics. | `test/agent-authority.test.ts` — the 16 exact four-component reference titles listed below; `test/agent-context.test.ts` — `provenance-aware agent context compilation > rejects re-signed substituted task-contract content while retaining its exact source`, the corresponding output-schema and input-artifact titles, `provenance-aware agent context compilation > rejects re-signed substitution of every prompt block while retaining the template source`, and `provenance-aware agent context compilation > rejects re-signed arbitrary segment identifiers` | Pass   |
| Untrusted content cannot become instruction or authority.                                                        | `test/agent-contracts.test.ts` — `agent contract documents > rejects a hash-valid context that relabels input content as trusted`; `test/agent-context.test.ts` — `provenance-aware agent context compilation > keeps injection-shaped repository content structurally after every trusted segment`; `test/agent-integration.test.ts` — `agent revision and context integration > keeps shared malicious repository bytes untrusted across worker and reviewer roles`                                                                                                  | Pass   |
| Overflow uses deterministic canonical truncation.                                                                | `test/agent-context.test.ts` — `provenance-aware agent context compilation > truncates ASCII, combining, Turkish, emoji, and four-byte scalars at every byte boundary`; `provenance-aware agent context compilation > produces byte-identical context for 100 caller permutations under truncation`; `provenance-aware agent context compilation > rejects re-signed same-policy input reordering`; `provenance-aware agent context compilation > rejects mixed truncation reasons in one shortened suffix`; and the exact wrong-attribution titles listed below       | Pass   |
| Definition or prompt changes create new revisions and prior runs remain immutable.                               | `test/agent-registry.test.ts` — `immutable agent lifecycle registry > rejects reuse of an agent revision with different canonical bytes`, `immutable agent lifecycle registry > rejects reuse of a prompt revision with different canonical bytes`, and `immutable agent lifecycle registry > persists a separate no-op result for a new operation and rejects conflicting reuse`; `test/agent-integration.test.ts` — `agent revision and context integration > replays revision 1 byte-exact after revision 2 becomes active`                                         | Pass   |
| Cross-role authority/context injection is tested.                                                                | `test/agent-authority.test.ts` — `execution request authority matching > rejects role before any resolver can be called`; `test/agent-integration.test.ts` — `agent revision and context integration > keeps shared malicious repository bytes untrusted across worker and reviewer roles`                                                                                                                                                                                                                                                                             | Pass   |

The exact reference-identity titles in `test/agent-authority.test.ts` are:

- `execution request authority matching > rejects definition reference document type mismatch`
- `execution request authority matching > rejects definition reference artifact ID mismatch`
- `execution request authority matching > rejects definition reference revision mismatch`
- `execution request authority matching > rejects definition reference hash mismatch`
- `execution request authority matching > rejects Task Contract reference document type mismatch`
- `execution request authority matching > rejects Task Contract reference artifact ID mismatch`
- `execution request authority matching > rejects Task Contract reference revision mismatch`
- `execution request authority matching > rejects Task Contract reference hash mismatch`
- `execution request authority matching > rejects MCP profile reference document type mismatch`
- `execution request authority matching > rejects MCP profile reference artifact ID mismatch`
- `execution request authority matching > rejects MCP profile reference revision mismatch`
- `execution request authority matching > rejects MCP profile reference hash mismatch`
- `execution request authority matching > rejects output schema reference document type mismatch`
- `execution request authority matching > rejects output schema reference artifact ID mismatch`
- `execution request authority matching > rejects output schema reference revision mismatch`
- `execution request authority matching > rejects output schema reference hash mismatch`

The positive title `execution request authority matching > ignores location
hints for every exact authority reference` proves location is not an authority
component.

The exact capability envelope titles are:

- `execution request authority matching > rejects missing required model capability before any resolver can be called`
- `execution request authority matching > rejects extra disallowed model capability before any resolver can be called`
- `execution request authority matching > rejects missing required Superpowers capability before any resolver can be called`
- `execution request authority matching > rejects extra disallowed Superpowers capability before any resolver can be called`
- `execution request authority matching > rejects duplicate requested model and Superpowers capabilities`

## Final compiled-context closure

The public semantic parser now rejects re-signed content that is not the
content named by its source, even when every derived field and final document
hash is recomputed. Exact current coverage includes:

- `provenance-aware agent context compilation > rejects re-signed substituted task-contract content while retaining its exact source`
- `provenance-aware agent context compilation > rejects re-signed substituted output-schema content while retaining its exact source`
- `provenance-aware agent context compilation > rejects re-signed substituted input-artifact content while retaining its exact source`
- `provenance-aware agent context compilation > rejects re-signed substitution of every prompt block while retaining the template source`
- `provenance-aware agent context compilation > rejects re-signed arbitrary segment identifiers`
- `provenance-aware agent context compilation > rejects re-signed prompt-block reordering`
- `provenance-aware agent context compilation > rejects a re-signed missing prompt block`
- `provenance-aware agent context compilation > rejects a re-signed duplicate prompt block`
- `provenance-aware agent context compilation > rejects re-signed same-policy input reordering`
- `provenance-aware agent context compilation > rejects re-signed cross-policy input reordering`
- `provenance-aware agent context compilation > rejects mixed truncation reasons in one shortened suffix`
- `provenance-aware agent context compilation > rejects a schema-valid input-budget truncation attributed to definition-ceiling`
- `provenance-aware agent context compilation > rejects a schema-valid definition-ceiling truncation attributed to input-budget`

Prompt segments carry canonical block IDs, full prompt blocks reconstruct the
exact referenced prompt projection, every segment ID is recomputed, and the
document hash-binds a closed canonical allocation projection. The standalone
parser can validate the compiled document's internal ordering, allocation,
and truncation semantics. It cannot derive a nested policy projection from a
separately hashed full definition or prove omitted source bytes that are not
present; the mandatory registry/resolver boundary validates those exact full
artifacts before compilation.

## Registry recovery and shutdown closure

Final registry coverage proves validation-only post-stop reads, tracked
pre-stop claims, restart-idempotent partial-tail recovery, and exact recovery
participants:

- `agent registry durability and coordination > does not create an absent post-stop registry tree through list` and its exact `resolveForExecution` and `resolveForResume` expansions;
- `agent registry durability and coordination > fails closed through list without recreating a missing agents tree` and the complete 12-case API/missing-directory matrix;
- `agent registry durability and coordination > keeps a gated pre-stop list claim inside the flush cut without repairing history`;
- `agent registry durability and coordination > reads fully valid state after stop without a claim or durable mutation through list` and both resolver expansions;
- `agent registry durability and coordination > fails closed without post-stop mutation when list observes a partial tail` and both resolver expansions;
- `agent registry durability and coordination > retries a partial lifecycle recovery after the recovery-file-sync barrier without quarantine growth` and all five lifecycle barrier expansions;
- `agent registry durability and coordination > completes an exact restart-owned lifecycle recovery stage without duplicate quarantine` and the operations expansion;
- `agent registry durability and coordination > fails closed when the lifecycle new recovery history participant is replaced before rename` and the complete eight-case lifecycle/operations, new/restart, history/quarantine matrix;
- `agent registry durability and coordination > fails closed when the lifecycle new recovery quarantine is replaced after rename` and its complete four-case kind/origin matrix.

The independent approved review expands participant replacement to all 16
history-kind/origin/barrier/participant combinations. Every first recovery
failed closed, preserved the replacement and displaced original, retained one
exact quarantine fragment without stage growth, and converged on fresh retry.
The shutdown matrix covered 27 absent, incomplete, valid, partial, and flush-cut
cases without post-cut creation, chmod, claim, repair, or mutation.

## Private modes and historical mutation witnesses

Private directory validation compares `mode & 0o7777` with exact `0700`, and
private file validation compares the same four-nibble mask with exact `0600`
or `0700`. Twenty-seven real-filesystem regressions reject sticky, setgid, and
setuid bits across the state root, all owned agent directories, objects,
active stages, cleanup tombstones, and mutation claims. Ordinary creation and
umask tests prove exact modes without special bits.

Representative exact titles are
`private agent object store > private state root > rejects sticky special mode bits`,
`private agent object store > rejects an object with sticky special mode bits`,
`private agent object store > rejects a stage with sticky special mode bits`,
`private agent object store > rejects a tombstone with sticky special mode bits`,
and `private agent mutation claim > rejects a mutation claim with sticky
special mode bits`. Each applicable table expands across sticky, setgid, and
setuid; the directory table also expands across state, agents, objects,
registry, and quarantine directories.

The original Task 10 preparation used nine one-at-a-time mutation witnesses
for authority subset, ACTIVE/resume, source hash, trust class, trusted
overflow, Unicode truncation, object identity, operation replay, and final
document hash. Each named focused test failed at its intended assertion; each
mutation was immediately restored and never committed. The final whole-branch
review traced these guards and found no regression. Later strict TDD added the
re-signed compiled-context, recovery-barrier, participant-replacement, and
post-stop filesystem matrices described above before their production fixes.

## Conditional-unlink limitation and delivery boundaries

Node provides no conditional unlink-by-inode primitive. Operation-owned
cleanup therefore atomically moves the exact validated entry to an unguessable
same-directory tombstone, validates device/inode, mode, link count, and source
absence, then performs the final `lstatSync` identity check and `unlinkSync`
consecutively with no hook, callback, promise, or `await` boundary. Normal
writers are serialized by the service lock and mutation claim. Exploiting the
remaining syscall-sized pathname interval requires a same-UID process already
able to mutate the private `0700` namespace. Eliminating it would require an
audited native fd-relative primitive; the approved threat model accepts this
documented limitation.

Linux native systemd syntax was not validated on this macOS host and is the
one exact full-suite skip. No remote CI URL is claimed for this head. Skills,
MCP execution, provider execution, model routing, and later agent-loop/run
orchestration remain separate delivery scopes. The package remains
`0.0.0-development` and unpublished.

## Final hygiene and topology

Before the evidence-only commit, repository and operation-owned temporary
state were checked for tarballs, object/stage/tombstone files, mutation claims,
Unix sockets, service locks, prompt artifacts, package roots, integration
roots, and matching test/service processes. The tracked preparation was clean.
The final `34360a1..evidence-head` diff is required to add exactly this one
file, with no production, schema, test, package, example, or public-contract
change.
