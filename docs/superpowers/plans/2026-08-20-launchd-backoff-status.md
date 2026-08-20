# Issue #38 Native launchd Backoff Status Plan

## Objective

Close the macOS-native status gap found during Issue #28 acceptance: a repeatedly failing launchd `KeepAlive` job reports `state = spawn scheduled`, an increasing `runs` count, and a non-zero `last exit code`. The runtime must classify that bounded native retry state as backoff so `doctor` returns its existing fixed actionable failure.

## Fixed interpretation

- `running` remains active and not backoff.
- `spawn scheduled` is backoff only when the bounded native output proves both repeated launches (`runs > 1`) and a non-zero last exit code.
- A first scheduled launch, a zero/absent exit code, malformed/overflow numbers, and clean stopped output are not backoff.
- Linux/systemd parsing and every native command remain unchanged.
- Native output stays bounded and is never reflected in CLI diagnostics.

## TDD steps

1. Add focused Darwin manager fixtures for the observed real output and false-positive boundaries.
2. Add a CLI/doctor regression proving the observed status becomes the existing fixed backoff FAIL.
3. Update only the Darwin status classifier.
4. Run focused manager/CLI tests, typecheck, lint, and formatting.
5. Run full Node 22.23.1 and Node 24 verification, package acceptance, and production audit.
6. Push the dedicated branch/PR, wait for both macOS checks, mark Issue #38 Done, merge to `release/v1.0.0`, and rerun Issue #28 native acceptance.
