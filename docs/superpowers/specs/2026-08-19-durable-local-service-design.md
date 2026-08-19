# Durable Local Runtime Service Design

## Status and scope

This document defines v1 Wave 2 for:

- #28, per-user service installation and supervision;
- #1, immutable run journals and resumable state;
- #29, explicit project registration and bounded file watching; and
- #30, structured operational logging.

It builds on Runtime Contract Protocol v1 and the package/CLI baseline in
pull request #33. It does not add provider calls, tool execution, remote
control, Windows service integration, or governance authority. Watchers create
candidate work only. Runtime results and operational logs never approve or
accept TOSS artifacts.

## Chosen architecture

Wave 2 uses one TypeScript process supervised by native per-user service
managers and one single-writer, file-backed durability layer. macOS uses a
LaunchAgent and Linux uses a `systemd --user` unit. Run state, project registry
changes, pending intake, and operational events remain distinct records under
the configured per-user state and log roots.

The durability layer uses canonical JSON and append-only journals rather than
SQLite. This keeps installation free of native or experimental database
dependencies, makes recovery auditable, and reuses the protocol baseline's
bounded parsing and canonical hashing. A plain mutable JSON state file is not
used because it cannot provide the required history, exact revision checks, or
partial-write recovery.

## Process and module boundaries

The service is decomposed into independently testable units:

- **Service manager:** renders, installs, enables, starts, stops, restarts,
  inspects, and uninstalls launchd/systemd definitions through an injected
  command runner. Installation never starts the service in the current
  session.
- **Supervisor:** owns the instance lock, Unix socket, health state, startup
  recovery, bounded drain, and shutdown ordering.
- **Control transport:** exchanges bounded, closed, secret-free local request
  and response documents over one Unix domain socket. Project and log commands
  require the service; they never bypass the single writer by editing files
  directly. `service status` may still report manager/definition state when
  the socket is unavailable.
- **Journal store:** publishes hash-linked run transitions durably and rebuilds
  state from validated records.
- **Project registry:** persists explicit register/unregister/block events and
  canonical project identities.
- **Watcher and intake:** observes only manifest-approved paths, coalesces
  changes, and durably records deterministic candidate-work keys.
- **Operational logger:** serializes safe versioned JSONL events, rotates and
  retains only its own files, and exposes finite rendering plus human follow.

No unit reads another unit's files directly. Consumers use typed interfaces so
clocks, IDs, file notifications, service-manager commands, and write failures
can be replaced deterministically in tests.

## Per-user layout and permissions

Existing platform config roots remain authoritative. Wave 2 adds the following
children without changing configured root semantics:

```text
<state>/
  journals/<run-id>/events.jsonl
  projects/registry.jsonl
  intake/events.jsonl
  intake/pending/<candidate-key>.json
  quarantine/<journal-kind>-<UTC timestamp>-<content-hash>.bin
<logs>/
  operational-current.jsonl
  operational-<UTC date>-<sequence>.jsonl
<runtime>/
  instance.lock/
    owner.json
  runtime.sock
```

State, log, and runtime directories are owned by the current user and mode
`0700`. Journal, registry, intake, lock-owner, and operational-log files are
mode `0600`. The socket is created with a service-process umask of `0077` and
explicitly set to mode `0600` before readiness is announced. Symlinks,
non-regular files, cross-owner paths, and group/world permissions fail closed
in production.

Uninstall removes only the service-manager definition, enablement link, live
socket, and safely owned stale lock. It preserves journals, project registry,
pending intake, configuration, and canonical artifacts. Operational logs are
also preserved unless a separate future, explicit log-purge command is added.

## Service lifecycle and native supervision

The CLI grammar adds:

```text
toss-runtime service install [--config <absolute-path>] [--json]
toss-runtime service start [--json]
toss-runtime service stop [--json]
toss-runtime service restart [--json]
toss-runtime service status [--json]
toss-runtime service uninstall [--json]
```

`service install` resolves absolute Node, CLI, config, state, log, and runtime
paths; writes a secret-free definition atomically; and enables login startup.
It does not start or bootstrap the service in the current session. Package
installation has no service side effect. `service start` performs the explicit
current-session activation. Repeating install, start, stop, or uninstall is
idempotent when the installed definition is byte-for-byte compatible.

The macOS definition uses label `software.toss.agent-runtime`, `RunAtLoad`,
`KeepAlive` only after unsuccessful exits, `ThrottleInterval=5`, and an
absolute program argument vector. The Linux user unit uses
`Restart=on-failure`, `RestartSec=5s`, `StartLimitIntervalSec=60s`,
`StartLimitBurst=5`, `UMask=0077`, and absolute `ExecStart` arguments. The
definition may set only `LANG`, `LC_ALL`, and `TZ`; the resolved config path is
an argument, not an environment value. The Wave 2 process does not enumerate
or persist inherited environment. Later secret resolvers may read only the
exact variable names declared by validated secret references at the final use
boundary. Definitions never embed secret values, provider credentials,
arbitrary environment, or shell command strings.

The instance lock is an atomically created directory containing a bounded
`service-lock.v1` owner document with PID, service instance ID, executable
identity, and creation time. A second instance returns
`RUNTIME_SERVICE_ALREADY_RUNNING`. A stale lock is reclaimed only when the
directory is private and current-user-owned, the recorded PID is not alive,
and no socket accepts the recorded service identity. An alive or ambiguous PID
is never killed or reclaimed. A stale socket is removed only after the
supervisor owns the instance lock and has proved no listener accepts it.

Startup order is: validate paths, acquire lock, recover journals/registry/
intake/logs, create and restrict the socket, install signal handlers, then
announce readiness. Shutdown order is: stop control intake, stop watchers,
persist pending debounce windows, drain active commands, append `INTERRUPTED`
for unfinished runs, flush journals/logs, close and remove the socket, and
release the lock. The configured shutdown deadline bounds the whole sequence.

`doctor` reports definition presence, enablement, manager state, socket/lock
coherence, crash-backoff state, recovery quarantine, and degraded logging with
stable safe codes and remediation text.

## Local control transport

The socket accepts newline-delimited canonical JSON documents no larger than
64 KiB. `service-control-request.v1` carries request ID, command, and only the
closed fields required by service status, project registry, logs, and future
run control. `service-control-response.v1` carries the same validated request
ID, stable exit/error semantics, and safe data; failures produced before an ID
can be validated carry `null`. Duplicate request IDs with the same
canonical command return the recorded response; a duplicate ID with different
content fails as a conflict. This request cache is bounded to the live service
instance. Every state-changing command also carries a subsystem operation ID
that is persisted by the journal, registry, or intake store, so restart
idempotency does not depend on the transport cache.

The transport relies on a private `0700` runtime directory and `0600` socket;
it is not a remote or multi-user authentication surface. Messages have the
same bounded JSON, duplicate-key, accessor, and sensitive-key defenses as the
public protocol. Oversized, unknown-version, malformed, or secret-shaped
messages are rejected before dispatch and are never echoed.

## Immutable run journal and state machine

Each `run-journal-entry.v1` contains:

- run ID, monotonic journal revision, and run-attempt revision;
- monotonic sequence, previous entry hash, and entry hash;
- command/operation ID and optional side-effect identity;
- previous and next state;
- safe reason code, timestamp, trace/correlation identity, and safe metadata.

The entry hash is SHA-256 over canonical JSON excluding only `entry_hash`.
Sequence and journal revision begin at 1. The first previous hash is 64 zeroes;
every later entry references the exact preceding hash. A transition command
must provide the expected journal revision and head hash. Any mismatch returns
`RUNTIME_STATE_STALE`; illegal transitions return
`RUNTIME_STATE_TRANSITION_INVALID` without appending.

Legal state transitions are:

| From               | To                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| none               | `CREATED`                                                                                                          |
| `CREATED`          | `ROUTED`, `BLOCKED`, `CANCELLED`, `INTERRUPTED`                                                                    |
| `ROUTED`           | `RUNNING`, `BLOCKED`, `CANCELLED`, `INTERRUPTED`                                                                   |
| `RUNNING`          | `TOOL_PENDING`, `APPROVAL_PENDING`, `REVIEW_PENDING`, `COMPLETED`, `FAILED`, `BLOCKED`, `CANCELLED`, `INTERRUPTED` |
| `TOOL_PENDING`     | `RUNNING`, `FAILED`, `BLOCKED`, `CANCELLED`, `INTERRUPTED`                                                         |
| `APPROVAL_PENDING` | `RUNNING`, `BLOCKED`, `CANCELLED`, `INTERRUPTED`                                                                   |
| `REVIEW_PENDING`   | `COMPLETED`, `FAILED`, `BLOCKED`, `CANCELLED`, `INTERRUPTED`                                                       |
| `FAILED`           | `RUNNING`, `CANCELLED`                                                                                             |
| `BLOCKED`          | `RUNNING`, `CANCELLED`                                                                                             |
| `INTERRUPTED`      | `RUNNING`, `BLOCKED`, `CANCELLED`                                                                                  |
| `COMPLETED`        | none                                                                                                               |
| `CANCELLED`        | none                                                                                                               |

A transition from `FAILED`, `BLOCKED`, or `INTERRUPTED` to `RUNNING` is an
explicit retry/resume and increments the run-attempt revision. Approval and
tool-pending states require no live process. Repeating a command with the same
operation ID and canonical input returns the previously published transition.
Reusing the ID with different input fails as `RUNTIME_OPERATION_CONFLICT`.

Before a provider/tool side effect, the caller must durably publish an intent
with a side-effect identity. Completion records the outcome under the same
identity. Recovery exposes unresolved intents for reconciliation; it never
blindly repeats them. Later execution waves must query this ledger before any
external mutation.

The shared journal writer used by run, registry, and intake records is
single-process and opens files with no-follow, append-only semantics and mode
`0600`. Each bounded canonical line is written fully and the file is
synchronized before the record becomes observable. Startup validates every
line and the record-kind-specific sequence, revision, transition, operation
ID, and hash invariants. A partial final line was never published: its bytes
are copied to the private quarantine directory and the byte-identical valid
prefix is restored atomically with file and directory synchronization. Any
invalid complete line or broken interior link blocks that journal; recovery
never skips it or treats a later entry as valid.

## Project registry, manifest, and watcher

The CLI grammar adds:

```text
toss-runtime project register <absolute-root> [--json]
toss-runtime project unregister <project-id> [--json]
toss-runtime project list [--json]
```

Registration resolves the root without following a final symlink, requires a
current-user-owned readable directory, does not rewrite project permissions,
and loads `.toss/project.yaml` as a closed `project-watch-manifest.v1`
document. The manifest contains nonempty, unique relative `watch_paths` and
optional relative `ignore_paths`. Absolute paths, `..`, empty segments, NUL,
symlinks escaping the canonical root, and a watch path beneath the
runtime-owned `.toss/runtime` directory are invalid. Runtime-owned state,
`.git`, and `.toss/runtime` are always ignored even when omitted from the
manifest.

A generated UUID is the stable project ID; the canonical root and manifest
hash are recorded in the append-only registry. Registering the same canonical
root and manifest hash returns the existing active registration. The same root
with a changed manifest appends a new registry revision. Unregister appends a
tombstone and never deletes project files or run artifacts.

The watcher observes only the approved paths. Events are normalized to
canonical project-relative paths, sorted, and collected in a 200 ms debounce
window with a hard 2 second maximum. One candidate key is SHA-256 over project
ID, registry revision, normalized event kind/path set, and safe file identity
metadata. The emitted `candidate-job-intent.v1` has fixed kind
`PROJECT_CHANGED` and carries that key, project/registry/manifest identities,
the sorted safe change set, and creation time. Repeated keys do not create
duplicate intents. Runtime-generated files and ignored paths never enter a
debounce window.

The pending window is written atomically before the in-memory timer is armed.
On restart, pending windows are reloaded, validated against the same project
and manifest revision, and either emitted once or marked stale. A missing,
moved, or replaced root appends `BLOCKED_PROJECT_UNAVAILABLE`; the runtime
does not search for a replacement. A watcher overflow triggers only a bounded
rescan of that project's declared watch paths, never a home/workspace scan.

Candidate intake records intent only. Scheduler and governance layers may
reject, defer, or map a candidate to a run; watcher code cannot approve a gate,
execute a tool, call a provider, or mutate external state.

## Operational JSONL logs

`operational-event.v1` is a closed document containing event ID, UTC timestamp,
service instance sequence, level, component, event name, correlation ID, and
optional project/job/run identities plus safe metadata. Supervisor, journal,
registry, watcher, intake, and future workers all use this envelope. Human and
JSON rendering preserve the same event ID.

Metadata is constructed from per-event field allowlists. Prompt bodies, raw
provider/MCP/tool payloads, unrestricted environment, command arguments,
tokens, credentials, private keys, and secret values have no log field.
Sensitivity tags are structurally omitted or replaced before serialization;
the existing normalized sensitive-key scan remains defense in depth.

The CLI grammar adds:

```text
toss-runtime logs [--level <debug|info|warn|error>] [--project <id>]
                  [--run <id>] [--json]
toss-runtime logs --follow [--level <debug|info|warn|error>]
                  [--project <id>] [--run <id>]
```

Finite `--json` returns one deterministic `command-result.v1` containing
ordered events. `--follow` is human streaming output and is intentionally
incompatible with `--json`, preserving the baseline one-document JSON command
contract.

One writer queue orders events. It writes complete bounded lines, synchronizes
at durability boundaries, and rotates before the active file would exceed 100
MB or cross a UTC day. Rotation flushes and closes the active file, atomically
renames it, synchronizes the directory, and opens a private new active file
before accepting more events. Follow continues across inode/filename changes
using event identity and service sequence, without replaying duplicates.

Retention deletes only closed files matching the runtime-owned operational-log
name and older than seven days or beyond the 100 MB aggregate closed-log
budget. It never traverses state/journal/project paths and never deletes the
active file, canonical artifacts, or execution evidence.

A partial final log line is ignored and reported on the next healthy channel;
an invalid interior line is surfaced as corruption. `ENOSPC`, `EDQUOT`, sync,
or rotation failures set a sticky `RUNTIME_LOGGING_DEGRADED` health state.
When logging is required for a state-changing command, that command cannot be
reported as successful until its required safe event is durable. Because the
logger cannot reliably log its own failure, `service status`, `doctor`, and one
bounded stderr diagnostic expose the degraded state.

## Stable failures and recovery policy

Wave 2 adds stable categories for already-running service, unavailable service
manager, unsafe service definition/path, stale state, illegal transition,
operation conflict, corrupt journal, unavailable project, watcher overflow,
control protocol rejection, and degraded logging. Messages contain no paths
outside approved roots, raw document bodies, environment values, or secret
material.

Recovery is fail-closed per affected unit. One corrupt run blocks that run but
does not invalidate unrelated verified journals. A corrupt project registry
blocks watcher startup because its authoritative active set is unknown. A
corrupt intake record is quarantined and cannot become a candidate job. A
logging failure leaves control/status available but blocks commands whose
success contract requires a durable operational event.

## Testing and CI

Implementation is test-driven and uses real temporary filesystem paths plus
injected clocks, IDs, command runners, file notifications, and faulting file
handles. Required coverage includes:

- exhaustive legal/illegal transition matrix, stale revisions, hash linkage,
  idempotent duplicate commands, side-effect intent recovery, interrupted
  shutdown, partial final lines, interior corruption, and sync failures;
- duplicate supervisor startup, stale/ambiguous locks, stale sockets, socket
  mode/ownership, bounded messages, duplicate request IDs, drain deadlines,
  and uninstall preservation;
- exact launchd/systemd rendering, idempotent install/enable/start/stop,
  `plutil -lint` on macOS, `systemd-analyze verify` on Linux, and real packaged
  supervisor SIGINT/SIGTERM smoke tests on both CI operating systems;
- registry idempotency, manifest changes, unregister tombstones, symlink/root
  escape, missing/moved roots, rename races, overflow rescan bounds, burst
  coalescing, duplicate suppression, runtime-file feedback prevention, and
  pending-intake restart recovery;
- sensitive-value redaction across every input boundary, writer ordering,
  concurrent callers, rotation, retention scope, follow across rotation,
  partial/corrupt lines, disk-full degradation, and safe doctor/status output.

Normal CI remains credential-free on Node `22.23.1` and Node `24`, Ubuntu and
macOS. Tests never install definitions into the real user's service-manager
directories; manager integrations render into temporary roots and validate
with native syntax tools. Package smoke tests execute the installed supervisor
and private socket but do not leave a background service behind.

## Delivery order and acceptance

Delivery follows the dependency chain:

1. #28 establishes service definitions, CLI lifecycle, instance lock, socket,
   health, and bounded shutdown.
2. #1 adds the journal record contract, writer/recovery, transition matrix,
   idempotency, and interruption persistence.
3. #29 adds registry, manifest, watcher, debounce, deduplication, and pending
   intake recovery on top of the durable store.
4. #30 adds the shared operational event contract, redaction, rotation,
   retention, rendering, follow, and degraded-health integration.

Each issue has its own implementation plan and ends with focused tests,
package/public API updates, documentation, and reviewable commits. Wave 2 is
accepted only after the full Node/OS matrix, installed-package smoke,
dependency audit, exact package-manifest test, and an independent adversarial
review pass. No Wave 2 result authorizes npm `1.0.0` or closes the v1 epic;
provider, execution, evidence, and release waves still remain.
