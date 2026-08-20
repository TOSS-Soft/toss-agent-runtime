# Idempotent macOS uninstall-after-stop plan

## Goal

Allow a validated macOS service definition to be uninstalled after the service
has already been stopped, using the exact native launchctl exit and message
observed on the host. Preserve fail-closed handling for every ambiguous or
unrelated native failure.

## Scope

- Issue #42 and its dedicated PR only.
- Darwin bootout idempotency plus manager/CLI regression coverage.
- No change to definition identity, ownership, replacement, or deletion
  protections.
- No Linux/systemd behavior change.
- Real lifecycle completion remains owned by Issue #28 after integration.

## Implementation

1. Add RED manager tests for exit `3` with exact output
   `Boot-out failed: 3: No such process` after an already-successful stop.
2. Prove stop-then-uninstall removes the exact validated definition and returns
   an uninstalled status.
3. Add negative tests showing the message is not accepted for status/print,
   different exit codes, altered numeric codes, additional text, or unrelated
   command failures.
4. Add a composed Darwin manager + CLI regression for a successful uninstall
   after prior stop.
5. Accept the exact bounded result only for `darwin-bootout`; retain all
   existing identity-bearing idempotent forms and deletion safety checks.
6. Run focused tests, formatting, lint, typecheck, full Node 22.23.1 and Node 24
   verification, package acceptance, and production dependency audit.
7. Publish the branch and PR, mark Issue/PR Done after required macOS CI, merge
   into `release/v1.0.0`, then complete real #28 uninstall and hygiene checks.
