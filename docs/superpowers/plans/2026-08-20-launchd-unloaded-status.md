# Installed-but-unloaded LaunchAgent status plan

## Goal

Make the macOS service manager recognize the exact native `launchctl print`
response for a compatible definition that has not been bootstrapped in the
current login session. Report that state as installed and stopped, while
keeping unrelated or ambiguous native failures fail-closed.

## Scope

- Issue #40 and its dedicated PR only.
- macOS launchd status parsing and CLI/doctor coverage.
- No Linux/systemd behavior change.
- Real native acceptance remains owned by Issue #28 after integration.

## Implementation

1. Add RED manager tests for the observed exit-113 output:
   `Could not find service "software.toss.agent-runtime" in domain for user
   gui: <uid>`.
2. Assert a verified installed definition returns
   `installed=true`, `enabled=true`, `active=false`, rather than an absent or
   failed status.
3. Add negative fixtures for wrong UID, wrong label, prefix/suffix identities,
   malformed domains, and unrelated failures.
4. Add a composed Darwin manager + CLI doctor regression that expects the
   fixed development `installed but stopped` warning and no raw native output.
5. Extend the bounded idempotent parser with exact native identity matching;
   retain the existing synthetic form for compatibility.
6. Run focused tests, typecheck/lint/format, full Node 22.23.1 and Node 24
   verification, package acceptance, and production dependency audit.
7. Publish the branch and PR, mark Issue/PR Done when required macOS CI is
   green, integrate into `release/v1.0.0`, then resume real Issue #28 launchd
   acceptance.
