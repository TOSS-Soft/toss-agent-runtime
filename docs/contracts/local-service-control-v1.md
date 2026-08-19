# Local Service Control v1

## Status and scope

This document is the normative operator and trust-boundary contract for the
implemented issue #28 per-user service foundation. It covers macOS launchd and
Linux `systemd --user`, explicit service lifecycle commands, the single-instance
lock, the private local status socket, readiness, and bounded shutdown. Windows,
remote control, provider/tool execution, project watching, and operational log
management are outside this contract.

This foundation does not complete Wave 2. Production-durable `INTERRUPTED`
journal persistence remains pending issue #1, and issue #28 remains open until
that integration passes. Issues #1, #29, and #30 and npm `1.0.0` remain
incomplete.

## Operator grammar and activation boundary

The complete service grammar is:

```text
toss-runtime service install [--config <absolute-path>] [--json]
toss-runtime service start [--json]
toss-runtime service stop [--json]
toss-runtime service restart [--json]
toss-runtime service status [--json]
toss-runtime service uninstall [--json]
```

Only `service install` accepts `--config`. All six commands accept `--json`.
Unknown actions, positional values, missing option values, duplicate options,
and `--config` on another service action fail as usage with exit `2`; diagnostics
do not reflect positional or inline secret-looking values.

Installing the npm package or running its `prepack` lifecycle does not write a
native definition, enable login startup, or start a service. Those package
operations have no service-manager side effect. Only the explicit
`toss-runtime service install` command may create and enable a definition.
`prepack` runs only non-service format, lint, typecheck, build, and
package-content acceptance. Its contents-only package path must not reach the
installed-supervisor smoke or start `serve`; the full smoke runs only during an
explicit `npm run verify` or its CI equivalent.

`service install` validates an explicit configuration, uses an existing
selected configuration, or creates the platform default as a current-user
regular file with mode `0600`. It publishes a compatible native definition and
enables automatic startup at the next login. It does not start the service in
the current session. It does not issue launchd bootstrap or systemd start.
`service start` is the explicit current-session activation.

`service status` is read-only and returns exit `0` with `installed: false` when
the definition/service is absent. Backoff and stopped state are status data, not
command transport failures. Absent `stop` and `uninstall` are idempotent exit-0
operations; absent `start` and `restart` return
`RUNTIME_SERVICE_UNAVAILABLE` with exit `69`.

## Native definitions and manager commands

Definitions contain one absolute argument vector: the current absolute Node
executable, the absolute installed CLI entry, `serve`, `--config`, and the
absolute selected configuration path. Native management uses an `execFile`-style
absolute executable plus argument array and never invokes a shell or constructs
a command string.

| Operation  | macOS launchd                                                       | Linux `systemd --user`                                                                                                                                         |
| ---------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definition | `~/Library/LaunchAgents/software.toss.agent-runtime.plist`          | `~/.config/systemd/user/toss-agent-runtime.service`                                                                                                            |
| Install    | Atomically write the definition; no `/bin/launchctl` command        | `/usr/bin/systemctl --user daemon-reload`, then `/usr/bin/systemctl --user enable toss-agent-runtime.service`                                                  |
| Start      | `/bin/launchctl bootstrap gui/<uid> <absolute-definition-path>`     | `/usr/bin/systemctl --user start toss-agent-runtime.service`                                                                                                   |
| Stop       | `/bin/launchctl bootout gui/<uid>/software.toss.agent-runtime`      | `/usr/bin/systemctl --user stop toss-agent-runtime.service`                                                                                                    |
| Restart    | `/bin/launchctl kickstart -k gui/<uid>/software.toss.agent-runtime` | `/usr/bin/systemctl --user restart toss-agent-runtime.service`                                                                                                 |
| Status     | `/bin/launchctl print gui/<uid>/software.toss.agent-runtime`        | `/usr/bin/systemctl --user show toss-agent-runtime.service --property=LoadState,UnitFileState,ActiveState,SubState,Result,NRestarts,ExecMainStatus --no-pager` |
| Uninstall  | Idempotent `bootout`, then remove only the validated definition     | Idempotent `stop`, `disable`, remove only the validated definition, then `daemon-reload`                                                                       |

The launchd definition has label `software.toss.agent-runtime`,
`RunAtLoad=true`, unsuccessful-exit-only `KeepAlive`,
`ThrottleInterval=5`, and `ProcessType=Background`. The Linux unit has
`Restart=on-failure`, `RestartSec=5s`, `StartLimitIntervalSec=60s`,
`StartLimitBurst=5`, and `UMask=0077`. Thus Linux admits a burst of five start
attempts within 60 seconds with five seconds between failure restarts; launchd
throttles restart attempts by five seconds. Manager status exposes whether
backoff is active, the restart count, and the last exit code when the platform
reports them.

An existing definition must be a private regular file and must round-trip to
the exact expected renderer for the same platform, current UID, Node path, CLI
path, allowed environment, and absolute configuration path. Unsafe, symlinked,
cross-user, or incompatible definitions fail before a native manager mutation.

Repository and ordinary CI acceptance do not install or start a definition in
the real user's launchd or systemd manager. They verify deterministic
definitions, host-native syntax lint, exact shell-free enable/start command
arrays, manager status/backoff parsing, doctor remediation, and direct
installed-supervisor behavior in temporary roots. Automatic login-session
activation and native crash-loop observation remain platform-integration
pending. Ordinary remote `npm run verify` syntax and package jobs do not close
those real-manager integration gates.

## Environment and secret boundary

Definitions may contain only `LANG`, `LC_ALL`, and `TZ`, emitted in stable key
order. `LANG` and `LC_ALL` accept `C`, `POSIX`, or the bounded ASCII locale form
implemented by the renderer; `TZ` accepts `UTC`, `GMT`, or a bounded ASCII
IANA-style slash path. Each value is at most 128 UTF-8 bytes and rejects control
characters. Arbitrary inherited environment, tokens, credentials, secret
values, and shell fragments are not serialized. The configuration path is an
argument, not an environment variable.

## Private paths, lock, and stale recovery

The service establishes a process umask of `0077`. State, log, and runtime
directories are current-user-owned directories with mode `0700`. The
`instance.lock` directory is `0700`; its `owner.json` is a canonical closed
`service-lock.v1` regular file with mode `0600`. Configuration and service
definition files created by this foundation are current-user-owned regular
files with mode `0600`. The Unix socket is current-user-owned and mode `0600`
before readiness is announced.

The owner document contains only a service instance UUID, PID, creation time,
and a lowercase SHA-256 executable identity. The identity is derived from
digests of the resolved Node and CLI file bytes plus package version; paths are
not persisted in the lock.

A second live matching owner fails closed with
`RUNTIME_SERVICE_ALREADY_RUNNING`; the implementation never signals or kills
the recorded process. Unknown liveness, an identity mismatch, malformed or
unsafe lock state, unexpected entries, or another accepting listener fails as
`RUNTIME_SERVICE_LOCK_AMBIGUOUS`. Reclamation requires a private owned lock, a
dead PID, and no accepting socket identity. An ownerless lock must additionally
be at least 30 seconds old. Removal uses operation-owned in-directory claims and
exact identity/entry revalidation; ambiguity remains blocked rather than being
deleted.

The supervisor acquires the instance lock before control-socket publication. A
stale socket is removed only when it is a private current-user `0600` socket,
no listener accepts it, and its filesystem identity is unchanged at removal.
Symlinks, non-sockets, wrong ownership/mode, active listeners, or replacements
are preserved and fail closed.

## Closed local status protocol

The control surface is a Unix domain socket only; there is no TCP or remote
fallback. Its private `0700` runtime directory and `0600` socket are the local
same-user access boundary. The v1 request grammar exposes only `status`.

Each connection carries exactly one newline-delimited canonical JSON request
and one canonical JSON response, then closes. The JSON body is limited to
65,536 bytes (64 KiB), plus one trailing LF. EOF before LF, an extra line,
noncanonical JSON, duplicate keys, unknown versions/fields/commands,
secret-shaped keys, excessive structure, and oversized input are rejected
before dispatch and are never echoed. Connections idle for five seconds are
closed. At most 32 connections are tracked; overflow connections are destroyed
immediately without a structured-response guarantee.

`service-control-request.v1` is a closed object containing only:

- `schema_version: "service-control-request.v1"`;
- `document_type: "service-control-request"`;
- a UUID `request_id`; and
- `command: "status"`.

`service-control-response.v1` is a closed object containing schema/document
identity, the validated request ID or `null`, `ok`, and exactly one of a status
or fixed service error. Status contains package version, service instance UUID,
PID, UTC start time, `healthy|degraded|stopping`, and whether the server is
accepting. A rejection before request-ID validation uses `request_id: null`.

The live service keeps a 256-entry LRU cache of request ID, request hash, and
exact response. Repeating an ID with the same canonical request bytes returns
the byte-identical cached response without dispatching status again. Reusing
the ID with different canonical bytes returns
`RUNTIME_SERVICE_CONTROL_CONFLICT` and does not replace the original cache
entry. The cache is in-memory and scoped to one service instance.

## Status, doctor, and stable failures

Every JSON-mode service result is one canonical `command-result.v1` document.
Service errors use fixed safe details and do not include manager stderr, paths,
document content, environment values, socket detail, or stacks.

| Service error                         | Exit | Meaning                                        |
| ------------------------------------- | ---: | ---------------------------------------------- |
| `RUNTIME_SERVICE_ALREADY_RUNNING`     |    6 | A compatible live supervisor already owns it   |
| `RUNTIME_SERVICE_CONTROL_CONFLICT`    |    6 | Request ID was reused with different bytes     |
| `RUNTIME_SERVICE_LOCK_AMBIGUOUS`      |    5 | Lock state cannot be proved safe or stale      |
| `RUNTIME_SERVICE_PATH_UNSAFE`         |    5 | Path type, mode, ownership, or identity failed |
| `RUNTIME_SERVICE_DEFINITION_UNSAFE`   |    5 | Installed definition is incompatible/unsafe    |
| `RUNTIME_SERVICE_CONTROL_INVALID`     |    5 | Local request is malformed or outside v1       |
| `RUNTIME_SERVICE_MANAGER_UNAVAILABLE` |   69 | Required native manager executable is absent   |
| `RUNTIME_SERVICE_UNAVAILABLE`         |   69 | Installed/local service is unavailable         |
| `RUNTIME_SERVICE_MANAGER_FAILED`      |   70 | Native manager operation failed safely         |

Usage failures use exit `2`; successful actions use `0`. Unexpected internal
service failures use `70`. Configuration selection/validation failures and an
unsupported service platform use `5`.

The service check in `doctor` follows these rules:

- `PASS`: the manager is active and the control response is healthy,
  accepting, and matches a fresh socket identity probe;
- `WARN`: the service is absent or installed-but-stopped in development mode;
- `FAIL`: absent/stopped in production; restart backoff; manager/status
  failure; unsafe path/definition; unavailable control; degraded, stopping, or
  non-accepting status; or socket identity mismatch.

`doctor` exits `5` when any check is `FAIL`, otherwise `0`. The independent
execution-capabilities check remains a warning in development and a failure in
production because provider, skill, MCP, and orchestration execution are not
implemented yet.

## Readiness and bounded shutdown

Startup order is fixed:

1. set umask `0077` and validate or create private state, log, and runtime roots;
2. validate the executable identity and acquire the `0700` instance lock;
3. recover every registered participant;
4. create, publish, chmod, and verify the private `0600` control socket;
5. register requested-stop, `SIGINT`, and `SIGTERM` handlers; and
6. announce readiness.

Readiness is never announced before the private socket is listening and its
mode, ownership, type, and identity have been verified.

The configured `shutdown_timeout_ms` bounds the complete drain. Shutdown order
is fixed:

1. stop accepting control requests and mark status `stopping`;
2. stop participant intake/watchers;
3. invoke the `InterruptionRecorder` boundary for active work;
4. drain control connections;
5. flush recovered participants;
6. close and remove the owned socket;
7. release the exact owned lock; and
8. restore the prior umask.

The forced outcome resolves at the configured deadline even if socket close or
lock release never settles. Essential cleanup may continue best-effort after
that return, but it must close the socket, then release the exact lock, then
restore the prior umask. A pending earlier finalizer prevents every later stage,
leaving resources fail-closed for conservative stale reclamation after process
exit. Rejections from detached cleanup are handled. Graceful and other
non-timeout shutdowns await the full sequence and preserve the first stable
primary or finalizer failure.

The supervisor test uses an injected durable `InterruptionRecorder` test double
that creates a temporary `INTERRUPTED` marker, synchronizes its file, and
synchronizes the parent directory publication before control drain,
participant flush, socket close, or lock release can follow. Production
currently supplies a no-op recorder. Production-durable `INTERRUPTED`
persistence remains pending issue #1, and issue #28 remains open until that
integration passes.

## Uninstall preservation

Uninstall preserves configuration, journals, project registry, pending intake,
operational logs, canonical project/run artifacts, and every unrelated state
or log file. It stops/disables the compatible service as applicable, removes
only the validated native definition, and reloads the Linux user manager. The
supervisor's bounded stop path owns socket and lock cleanup; uninstall does not
recursively delete caller or runtime roots.
