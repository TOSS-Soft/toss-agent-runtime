# Issue #9 Scoped MCP Tool Broker Verification

## Scope

This record covers the Issue #9 scoped MCP tool broker implemented on branch
`issue/9-scoped-mcp-tools`. The verified working tree was based on Task 14
commit `183d857` and included the Task 15 adversarial acceptance, canonical
examples, documentation, package checks, and verification evidence before the
final Task 15 commit.

No pull request, remote CI result, issue closure, merge, release tag, npm
publication, or protected live-credential result is claimed here.

## Environment and supported policy

- Gate interval: `2026-09-02T08:29:40Z` through `2026-09-02T08:33:24Z`.
- Gate host: macOS/Darwin, arm64.
- Gate runtime: Node.js `v26.6.0`.
- Package policy: Node.js `>=24`, macOS (`darwin`) only.
- Release documentation policy: the official latest Node.js LTS on macOS.
- Package: `@toss-software/agent-runtime@0.0.0-development`.

The protected live-credential test is intentionally absent from ordinary CI
and from this verification. Issue #15 remains responsible for that protected
gate. No live MCP, provider, or gateway credential was used.

## Focused acceptance

The exact focused command exited `0`:

```text
npm exec -- vitest run test/tool-adversarial-acceptance.test.ts test/tool-broker-integration.test.ts test/tool-recovery.test.ts test/documentation-integrity.test.ts test/package-metadata.test.ts --maxWorkers=4
```

Result: 5/5 files passed, 51/51 tests passed, zero skipped, zero failed. The
suite covers all three MCP transports, exact authorization, durable approval,
replay, retry suppression, uncertain-effect recovery and both dispositions,
dynamic capabilities, schema and prompt-injection attacks, redaction, examples,
public declarations, and the package allowlist.

## Complete release gate

The final unsplit gate executed these commands in order, with failure
propagation enabled. Every command exited `0`:

1. `npm run format:check`
2. `npm run lint`
3. `npm run typecheck`
4. `npm test`
5. `npm run build`
6. `npm run test:package`

Full Vitest result: 84/84 files passed; 2,562 tests passed; one test skipped;
zero failed. The sole skip is the existing host-inapplicable native systemd
validation on macOS. The final test command used four workers and the checked-in
15-second default test timeout; the exhaustive byte-prefix recovery test kept
its explicit 45-second limit.

Two prior full-gate attempts exposed timeout-only instability under parallel
filesystem load: the affected tests passed individually in 3.03, 6.62, and
1.13 seconds. The checked-in timeout budgets were raised without changing
production behavior or assertions, after which the complete unsplit gate passed.

## Package evidence

The real scripts-enabled package acceptance performed nested prepack checks,
created an operation-owned tarball, installed it into a fresh project with
install scripts disabled, and exercised the installed public API, five MCP
examples, dynamic capability projection, launcher, private service lifecycle,
crash recovery, status socket, and graceful signal handling.

- Filename: `toss-software-agent-runtime-0.0.0-development.tgz`
- Published file count: 510
- SHA-256:
  `ad975d4b1ca95ee82486c0d0dacbb42fd645e15244183d2ca5997a7ccfed2bfc`

The package scan found none of the MCP endpoint, local-path, credential, raw
secret, stderr, or SDK fixture markers. Public declarations contain no native
MCP SDK, native tool result, SDK client, or private tool-store surface. Private
approval, broker, executor, and tool-store declarations/maps are excluded.
Test fixtures and generated runtime state are not packaged.

The package test moved its operation-owned tarball to Trash and removed its
temporary pack, install, service state, socket, lock, and inherited-destination
directories. No repository-root tarball was created.

## Verified boundary

The accepted implementation provides closed hash-bound MCP profile, discovery,
approval, call, and result documents; exact profile/binding/role/Task Contract
authorization; all-or-nothing discovery; bounded stdio, streamable HTTP, and
agentgateway transports; durable approval; intent-before-dispatch;
at-most-one dispatch; stable replay; conservative uncertain-effect recovery;
bounded untrusted results; structural and generic redaction; dynamic readiness
capabilities; and ordered broker shutdown.

Issue #10 still owns worker and agent-loop execution, Issue #11 independent
review execution proof, Issue #12 aggregate evidence and authoritative
reconciliation, and Issue #15 protected live-credential release acceptance.
