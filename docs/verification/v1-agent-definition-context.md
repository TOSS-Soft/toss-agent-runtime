# v1 Agent Definition and Context Acceptance Evidence

## Scope and binding

This record covers the immutable agent definition registry and provenance-aware
context compiler for issue #7. It binds the clean, evidence-free publishable
prep commit `80d3c9870dd752520ed5096920a4afee466e69b0`, verified on
2026-08-29. That commit did not contain
`docs/verification/v1-agent-definition-context.md`; this evidence-only commit
therefore does not make a circular claim about its own identity.

The final preparation topology is:

1. `cf3204bc952c63bb192e798ae64201f2febb667f` — test-only acceptance-gap
   coverage;
2. `80d3c9870dd752520ed5096920a4afee466e69b0` — the narrow two-file fix and
   real-filesystem coverage that reject special permission bits at private
   agent storage boundaries.

No evidence document was present at either preparation commit. The second
commit was independently reviewed against the original Task 3 review and
approved with no Critical, Important, or Minor findings.

This record is internal repository evidence and is intentionally excluded from
the npm package. Issue #7 remains open pending controller delivery. No push,
pull request, issue update, tag, npm publication, or GitHub release is claimed.

## Environment

| Item               | Verified value                                   |
| ------------------ | ------------------------------------------------ |
| Date               | `2026-08-29`                                     |
| Publishable commit | `80d3c9870dd752520ed5096920a4afee466e69b0`       |
| Primary runtime    | Node `v22.23.1`; npm `11.18.0`                   |
| Compatibility run  | Node `v24.19.0`; npm `11.18.0`                   |
| OS/architecture    | macOS `26.6.1` / `arm64`                         |
| Package            | `@toss-software/agent-runtime@0.0.0-development` |

No username, home-directory path, environment value, credential, provider
configuration, secret, socket path, PID, claim owner, or temporary path is
recorded.

## Exact verification commands

The clean publishable commit was verified with these exact command forms:

```sh
npx --yes --package=node@22.23.1 --package=npm@11.18.0 --call 'node --version && npm --version && npm run verify && npm audit --omit=dev'
npx --yes --package=node@24.19.0 --package=npm@11.18.0 --call 'node --version && npm --version && npm run verify && npm audit --omit=dev'
```

Both commands exited `0`.

| Stage                       | Node 22 result                                                  | Node 24 result                                                  |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Runtime identity            | `v22.23.1`; npm `11.18.0`                                       | `v24.19.0`; npm `11.18.0`                                       |
| Format/lint/typecheck       | Passed                                                          | Passed                                                          |
| Full test suite             | 55 files; 1,791 passed; 1 host-conditional skip; 1,792 total    | 55 files; 1,791 passed; 1 host-conditional skip; 1,792 total    |
| Build                       | Passed                                                          | Passed                                                          |
| Scripts-enabled package     | Exact 391-file inventory passed                                 | Exact 391-file inventory passed                                 |
| Installed consumer          | Imports, examples, launcher, service, and cleanup checks passed | Imports, examples, launcher, service, and cleanup checks passed |
| Production dependency audit | 0 vulnerabilities                                               | 0 vulnerabilities                                               |

The focused Issue #7 command used Node `v22.23.1` and npm `11.18.0`:

```sh
node ./node_modules/vitest/vitest.mjs run test/agent-contracts.test.ts test/agent-authority.test.ts test/agent-private-store.test.ts test/agent-registry.test.ts test/agent-context.test.ts test/agent-integration.test.ts
```

It exited `0`: 6 files and 249/249 tests passed with no skip.

The sole skip in each full run was
`native service definition validation > passes native systemd unit validation`,
which is guarded by `process.platform === "linux"` and therefore skipped on
this macOS host. The Darwin native validator passed. A focused run also proved
that the case-alias intake test executes on this host; it did not account for
the full-suite skip. No agent definition, authority, private-store, registry,
context, or integration acceptance test was skipped.

## Package and installed-consumer evidence

The full verifier's `npm run test:package` path performs a real
scripts-enabled `npm pack`. Its prepack lifecycle runs format, lint, typecheck,
build, and contents-only package acceptance exactly once. The resulting
tarball is installed with scripts disabled into a new temporary consumer.

That installed consumer proved the package-root public API and private export
boundary; parsed and hash-checked the canonical agent definition, execution
request, and compiled-context examples; invoked the executable directly;
checked help, version, capabilities, executable mode, and the installed
contract manifest; exercised private service state, control, duplicate serve,
SIGKILL recovery/restart, SIGTERM and SIGINT shutdown, and safe missing-config
failure; and reaped its processes and artifacts.

Separate scripts-enabled metadata captures on both exact runtimes produced
byte-identical tarballs:

| Item             | Exact value                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Filename         | `toss-software-agent-runtime-0.0.0-development.tgz`                                               |
| Packed files     | 391                                                                                               |
| Packed size      | 367,583 bytes                                                                                     |
| Unpacked size    | 2,142,484 bytes                                                                                   |
| npm SHA-1 shasum | `d9924922512cffc3d0371ff8f5245914a2bc1e00`                                                        |
| SHA-256          | `a8de3d47b1f0c1ac61efcf798cc2d5b01f1c4194c1f70019aa828e851c135c7d`                                |
| npm integrity    | `sha512-pWdGl1kBvufcScqbV+MnkOiQ9QzGO2RpNJGw/gtSrrYT9k1A9JrRly7nb9CdlpJb3UwCItLL4y7wevBYjaJ6MA==` |

All 391 paths match `scripts/package-files.json` exactly. The allowlist
contains only public package material and excludes tests, SDD material,
private declarations/source maps, runtime state, and this verification
document. After this document was created, contents-only package acceptance
and a direct npm package report were rerun; the inventory remained exactly 391
files and did not contain
`docs/verification/v1-agent-definition-context.md`.

Every explicit metadata tarball was created outside the repository in an
operation-owned temporary directory and removed immediately after hashing. No
tarball was written to the repository root.

## Issue #7 acceptance matrix

| Issue #7 acceptance criterion                                                                   | Exact current regression evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Result |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Agent definition is separate from model/provider identity.                                      | `test/agent-contracts.test.ts` — `agent contract documents > rejects provider, route, endpoint, and concrete-model identity in agent definitions`; `test/agent-authority.test.ts` — `execution request authority matching > rejects logical class before any resolver can be called`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Pass   |
| Execution uses only an ACTIVE agent matching the Task Contract and allowed capability envelope. | `test/agent-registry.test.ts` — `immutable agent lifecycle registry > activates revision 2, rejects revision 1 for execution, and retains revision 1 for resume`; `test/agent-authority.test.ts` — `execution request authority matching > rejects Task Contract before any resolver can be called`, `execution request authority matching > rejects missing required model capability before any resolver can be called`, `execution request authority matching > rejects extra disallowed model capability before any resolver can be called`, `execution request authority matching > rejects missing required Superpowers capability before any resolver can be called`, `execution request authority matching > rejects extra disallowed Superpowers capability before any resolver can be called`, and `execution request authority matching > rejects duplicate requested model and Superpowers capabilities` | Pass   |
| Every canonical context input binds an exact artifact type, ID, revision, and hash.             | `test/agent-authority.test.ts` — the 16 exact reference-identity titles listed below; `test/agent-context.test.ts` — `provenance-aware agent context compilation > rejects resolved content whose canonical hash does not match its exact reference`; `test/agent-contracts.test.ts` — `agent contract documents > rejects bad document and entry hashes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Pass   |
| Untrusted content cannot become instruction or authority.                                       | `test/agent-contracts.test.ts` — `agent contract documents > rejects a hash-valid context that relabels input content as trusted`; `test/agent-context.test.ts` — `provenance-aware agent context compilation > keeps injection-shaped repository content structurally after every trusted segment`; `test/agent-integration.test.ts` — `agent revision and context integration > keeps shared malicious repository bytes untrusted across worker and reviewer roles`                                                                                                                                                                                                                                                                                                                                                                                                                                                | Pass   |
| Overflow uses deterministic truncation/compaction.                                              | `test/agent-context.test.ts` — `provenance-aware agent context compilation > accepts trusted content whose UTF-8 bytes exactly fill the request input ceiling`; `provenance-aware agent context compilation > rejects trusted content at one UTF-8 byte above the request input ceiling`; `provenance-aware agent context compilation > uses deterministic policy priority before document and artifact identity`; `provenance-aware agent context compilation > truncates ASCII, combining, Turkish, emoji, and four-byte scalars at every byte boundary`; `provenance-aware agent context compilation > produces byte-identical context for 100 caller permutations under truncation`; `provenance-aware agent context compilation > rejects trusted context overflow without truncating trusted segments`                                                                                                         | Pass   |
| Definition or prompt changes create new revisions and prior runs remain immutable.              | `test/agent-registry.test.ts` — `immutable agent lifecycle registry > rejects reuse of an agent revision with different canonical bytes`; `immutable agent lifecycle registry > rejects reuse of a prompt revision with different canonical bytes`; `immutable agent lifecycle registry > persists a separate no-op result for a new operation and rejects conflicting reuse`; `test/agent-integration.test.ts` — `agent revision and context integration > replays revision 1 byte-exact after revision 2 becomes active`                                                                                                                                                                                                                                                                                                                                                                                           | Pass   |
| Cross-role authority/context injection is tested.                                               | `test/agent-authority.test.ts` — `execution request authority matching > rejects role before any resolver can be called`; `test/agent-integration.test.ts` — `agent revision and context integration > keeps shared malicious repository bytes untrusted across worker and reviewer roles`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Pass   |

The exact reference-identity table in `test/agent-authority.test.ts` expands
across definition, Task Contract, MCP profile, and output schema. Its current
Vitest titles are:

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

`execution request authority matching > ignores location hints for every exact
authority reference` proves that non-authoritative location hints do not alter
the four-component identity comparison.

## Acceptance-gap TDD evidence

The initial audit found test-depth gaps, not untested production failures, in
provider/concrete-model exclusion and exact authority-reference matching. The
test-only preparation commit `cf3204b` closed them. Each addition had an
independent RED witness before restoration:

| Temporary mutation                                                     | Exact failing test/assertion                                                                                                                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed `provider` in the otherwise closed agent model schema.         | `agent contract documents > rejects provider, route, endpoint, and concrete-model identity in agent definitions` failed with `expected true to be false`.                           |
| Reduced exact reference matching to artifact ID only.                  | All 12 new document-type/revision/hash mismatch cases failed because `expected authority mismatch` was not a `RuntimeAgentError`.                                                   |
| Made the non-authoritative `location` hint part of reference equality. | `execution request authority matching > ignores location hints for every exact authority reference` raised `RUNTIME_CONTEXT_AUTHORITY_MISMATCH`.                                    |
| Disabled duplicate capability rejection.                               | `execution request authority matching > rejects duplicate requested model and Superpowers capabilities` failed because `expected authority mismatch` was not a `RuntimeAgentError`. |

The deferred Task 3 special-mode finding was a production defect and was fixed
separately at `80d3c98`. Before its two comparison changes, 27 new
real-filesystem tests failed while the prior 47 private-store tests passed.
They cover sticky, setgid, and setuid bits on the state root and all four owned
agent directories, objects, active stages, cleanup tombstones, and mutation
claims. After the fix, the focused private-store suite passed 74/74, all seven
`agent-*.test.ts` files passed 254/254, and the fresh full verification above
passed on both supported runtime lines. Existing creation and umask assertions
also inspect all four permission nibbles, proving ordinary roots/objects/claims
are created without special bits.

## Reversible mutation witnesses

Nine production/schema mutations were applied one at a time to the publishable
preparation, observed RED, restored immediately, and followed by GREEN plus a
clean production/schema diff. They were never committed.

| Boundary            | Temporary mutation                                                       | Exact failing test and observed assertion                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authority subset    | Bypassed requested-capability subset enforcement.                        | `execution request authority matching > rejects extra disallowed model capability before any resolver can be called`: `expected authority mismatch` was not a `RuntimeAgentError`.                     |
| ACTIVE/resume split | Disabled the ACTIVE guard in execution resolution.                       | `immutable agent lifecycle registry > activates revision 2, rejects revision 1 for execution, and retains revision 1 for resume`: the stale revision promise resolved instead of rejecting.            |
| Source hash         | Disabled resolved-content hash comparison.                               | `provenance-aware agent context compilation > rejects resolved content whose canonical hash does not match its exact reference`: `expected context compilation to fail` was not a `RuntimeAgentError`. |
| Trust class         | Allowed an input segment to claim `trusted-control`.                     | `agent contract documents > rejects a hash-valid context that relabels input content as trusted`: `expected true to be false`.                                                                         |
| Trusted overflow    | Inverted the final trusted input-ceiling condition.                      | `provenance-aware agent context compilation > accepts trusted content whose UTF-8 bytes exactly fill the request input ceiling` raised `RUNTIME_CONTEXT_OVERFLOW`.                                     |
| Unicode truncation  | Advanced the UTF-8 prefix by one code unit instead of a complete scalar. | `provenance-aware agent context compilation > truncates ASCII, combining, Turkish, emoji, and four-byte scalars at every byte boundary`: the 13-byte case produced `Áİış�` instead of `Áİış😀`.        |
| Object identity     | Reduced post-open object identity comparison to device only.             | `private agent object store > detects file replacement after opening an object and preserves the replacement`: the file-replacement case did not raise a `RuntimeAgentError`.                          |
| Operation replay    | Disabled operation UUID/hash conflict rejection.                         | `immutable agent lifecycle registry > persists a separate no-op result for a new operation and rejects conflicting reuse`: conflicting reuse resolved instead of rejecting.                            |
| Final document hash | Disabled compiled-context final semantic hash validation.                | `agent contract documents > rejects bad document and entry hashes`: the altered compiled-context hash parsed, yielding `expected true to be false`.                                                    |

These witnesses complement the committed special-mode RED matrix. No witness
changed a public API, package surface, contract document, or durable artifact.

## Storage integrity and limitations

The previously deferred special-permission-bit limitation is closed at
`80d3c98`: all private directory checks compare `mode & 0o7777` with exact
`0700`, and private file checks compare the same four-nibble mask with exact
`0600` or `0700`. The independent fix review found no remaining severity-rated
finding.

One documented platform limitation remains: Node exposes no conditional
unlink-by-inode primitive. Operation-owned cleanup therefore atomically moves
an entry to an unguessable same-directory tombstone, validates its full
identity, mode, and link count, rechecks source absence, then performs one
final synchronous tombstone validation followed immediately by `unlinkSync`.
There is no hook, promise, callback, or `await` boundary in that final
validation-to-unlink interval. Eliminating the syscall-level pathname interval
would require an audited native fd-relative primitive.

The Linux-only native systemd syntax check was not run on this macOS host; it
is unrelated to the Issue #7 acceptance set and is the one explicitly
identified full-suite skip. No remote CI URL is claimed for this head. Model
routing, provider execution, and later run orchestration remain separate
delivery scopes. The package remains `0.0.0-development` and unpublished.

## Final hygiene

Before the evidence-only commit, repository and operation-owned temporary
state were checked for tarballs, object/stage/tombstone files, mutation claims,
Unix sockets, service locks, prompt artifacts, package roots, integration
roots, and matching test/service processes. The tracked tree was clean at the
publishable prep head. After this file was committed, the previous-head diff
was required to contain exactly this one added path, with no production,
schema, test, package, example, or public-document change.
