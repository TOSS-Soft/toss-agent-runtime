# v1.0.0 Wave 0 Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the already accepted contract/package baseline and durable macOS service foundation into the shared `release/v1.0.0` branch without changing their accepted behavior.

**Architecture:** Preserve PR #33 and PR #34 as reviewable GitHub merges. Retarget the already accepted PR #33 without changing its historical head, then bind PR #34 to the integrated version branch so its macOS CI evaluates the actual implementation base. Keep issue-delivery status separate from epic integration status, then run the complete installed-package gate on the resulting version branch under Node 22.23.1 and Node 24.19.0.

**Tech Stack:** Git, GitHub CLI, GitHub Actions, TypeScript ESM, npm 11.18.0, Node.js 22.23.1 and 24.19.0, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-v1-release-program-design.md`

## Global Constraints

- The release integration branch is exactly `release/v1.0.0`.
- v1.0.0 supports macOS only.
- PR #33 is the sole historical exception to the one-issue/one-branch/one-PR rule.
- Beginning with issue #28, every issue has one branch and one PR.
- Issue delivery becomes `Done` when an acceptance-complete PR is green; merge status is tracked only in epic #16.
- Do not rewrite, squash, or force-push either accepted implementation history.
- Do not advertise or publish package version `1.0.0` during Wave 0.
- Do not tag, publish npm content, or create a GitHub Release during Wave 0.
- Stage or commit only explicitly named files; existing untracked `dist/` and `node_modules/` directories are never staged.

---

### Task 1: Publish the Wave 0 execution record

**Files:**

- Create: `docs/superpowers/plans/2026-08-20-v1-wave-0-integration.md`
- Modify: GitHub issue #16 comment stream only

**Interfaces:**

- Consumes: approved release program spec at commit `5265fa4049e6791046717ee1c3c6e338a0bc00b3`
- Produces: a committed execution plan and an epic link to the exact plan commit

- [ ] **Step 1: Verify the plan is formatted and contains no placeholders**

Run:

```bash
./node_modules/.bin/prettier --check docs/superpowers/plans/2026-08-20-v1-wave-0-integration.md
rg -n 'T[B]D|T[O]DO|implement[[:space:]]+later|fill[[:space:]]+in[[:space:]]+details' docs/superpowers/plans/2026-08-20-v1-wave-0-integration.md
```

Expected: Prettier exits `0`; `rg` exits `1` with no matches.

- [ ] **Step 2: Commit only the plan**

Run:

```bash
git add -- docs/superpowers/plans/2026-08-20-v1-wave-0-integration.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: plan v1 wave zero integration"
```

Expected: the staged name list contains exactly the new plan file and the commit succeeds.

- [ ] **Step 3: Push the version branch and record the plan on epic #16**

Run:

```bash
git push origin release/v1.0.0
gh issue comment 16 --repo TOSS-Soft/toss-agent-runtime --body "Wave 0 execution started from the committed integration plan on release/v1.0.0."
```

Expected: the remote branch advances to the plan commit and GitHub returns one comment URL.

### Task 2: Retarget PR #33 onto the version branch

**Files:**

- Modify: GitHub PR #33 base/draft state

**Interfaces:**

- Consumes: accepted PR #33 head `3036ba18eb3f3038fff8cdd782fd3f8b656d82e3` and the documentation-only version-branch commits
- Produces: PR #33 directly mergeable into `release/v1.0.0` without changing or re-running its historical Ubuntu workflow

- [ ] **Step 1: Verify both branches and the worktree are safe**

Run:

```bash
git fetch origin --prune
git status --short
git rev-parse origin/agent/v1-contract-baseline
git rev-parse origin/release/v1.0.0
```

Expected: tracked status is clean; the contract branch resolves to `3036ba18eb3f3038fff8cdd782fd3f8b656d82e3` before the integration merge; the version branch resolves to the Wave 0 plan commit.

- [ ] **Step 2: Retarget PR #33 without changing its accepted head**

Run:

```bash
gh pr edit 33 --repo TOSS-Soft/toss-agent-runtime --base release/v1.0.0
gh pr ready 33 --repo TOSS-Soft/toss-agent-runtime
gh pr view 33 --repo TOSS-Soft/toss-agent-runtime --json isDraft,baseRefName,headRefOid
```

Expected: PR #33 is non-draft, its base is `release/v1.0.0`, and its head remains exactly `3036ba18eb3f3038fff8cdd782fd3f8b656d82e3`.

- [ ] **Step 3: Verify the already accepted PR #33 checks**

Run:

```bash
gh pr view 33 --repo TOSS-Soft/toss-agent-runtime --json statusCheckRollup
```

Expected: every check attached to head `3036ba18` is completed with `SUCCESS`. The historical Ubuntu checks are accepted evidence but are not re-run; all new v1 checks are macOS-only.

- [ ] **Step 4: Verify merge readiness**

Run:

```bash
gh pr view 33 --repo TOSS-Soft/toss-agent-runtime --json state,isDraft,baseRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup
```

Expected: PR is non-draft, `MERGEABLE`, and `CLEAN`; the Node 22.23.1/macOS and Node 24/macOS checks are `SUCCESS`.

- [ ] **Step 5: Merge PR #33 without deleting its historical branch**

Run:

```bash
gh pr merge 33 --repo TOSS-Soft/toss-agent-runtime --merge
gh pr view 33 --repo TOSS-Soft/toss-agent-runtime --json state,mergedAt,mergeCommit,baseRefName,headRefName,url
```

Expected: PR state is `MERGED`; base is `release/v1.0.0`; the historical head branch remains available.

- [ ] **Step 6: Update epic #16 integration state**

Edit the epic checklist item from unchecked to checked and add the exact PR merge commit and check URLs.

Expected: issue #2 and #4 remain closed/Done; only the PR #33 integration checkbox changes.

### Task 3: Bind the PR #34 review boundary to the integrated version branch

**Files:**

- Modify: Git history for `agent/v1-durable-local-service-implementation` through a non-destructive merge commit
- Modify: GitHub PR #34 base/draft state

**Interfaces:**

- Consumes: PR #34 head `9544391af7b8f52218787de9b6885e4ddd900773` and the version branch containing merged PR #33
- Produces: a green, directly mergeable PR #34 whose diff is the durable macOS service foundation

- [ ] **Step 1: Fetch and verify the new version-branch head**

Run:

```bash
git fetch origin --prune
git rev-parse origin/release/v1.0.0
gh pr view 33 --repo TOSS-Soft/toss-agent-runtime --json state,mergeCommit
```

Expected: PR #33 is `MERGED` and its merge commit is reachable from `origin/release/v1.0.0`.

- [ ] **Step 2: Merge the version branch into the PR #34 head**

Run:

```bash
git switch agent/v1-durable-local-service-implementation
git merge --no-ff origin/release/v1.0.0 -m "chore: bind service foundation to v1 integration"
git status --short
```

Expected: Git creates one merge commit without content conflicts; tracked status is clean afterward.

- [ ] **Step 3: Push and retarget PR #34**

Run:

```bash
git push origin agent/v1-durable-local-service-implementation
gh pr edit 34 --repo TOSS-Soft/toss-agent-runtime --base release/v1.0.0
gh pr ready 34 --repo TOSS-Soft/toss-agent-runtime
```

Expected: PR #34 is open, non-draft, and based on `release/v1.0.0`; the push triggers the macOS Node matrix on the integrated head.

- [ ] **Step 4: Wait for and verify PR #34 acceptance**

Run:

```bash
gh pr checks 34 --repo TOSS-Soft/toss-agent-runtime --watch --interval 10
gh pr view 34 --repo TOSS-Soft/toss-agent-runtime --json state,isDraft,baseRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup
```

Expected: Node 22.23.1/macOS and Node 24/macOS are `SUCCESS`; PR is non-draft, `MERGEABLE`, and `CLEAN`.

- [ ] **Step 5: Merge PR #34 and preserve issue #28 as In progress**

Run:

```bash
gh pr merge 34 --repo TOSS-Soft/toss-agent-runtime --merge
gh pr view 34 --repo TOSS-Soft/toss-agent-runtime --json state,mergedAt,mergeCommit,baseRefName,headRefName,url
```

Expected: PR state is `MERGED`; issue #28 remains open and `In progress` because durable `INTERRUPTED` state and final macOS login acceptance are not yet complete.

- [ ] **Step 6: Update epic #16 integration state**

Check the PR #34 integration item and attach the exact merge commit and successful check URLs.

Expected: Wave 0 integration records both PR merges while the Wave 1 and #28 final-acceptance items remain open.

### Task 4: Verify the integrated `release/v1.0.0` branch

**Files:**

- Verify only: repository source, tests, package artifact, documentation, and lockfile
- Modify: GitHub issue #16 verification comment only

**Interfaces:**

- Consumes: version branch containing the spec, PR #33, and PR #34
- Produces: exact macOS Node 22/24 integration evidence and the clean base for issue #1

- [ ] **Step 1: Synchronize the local version branch**

Run:

```bash
git fetch origin --prune
git switch release/v1.0.0
git pull --ff-only origin release/v1.0.0
git status --short --branch
```

Expected: tracked status is clean and local HEAD equals `origin/release/v1.0.0`.

- [ ] **Step 2: Install the exact dependency lock under Node 22.23.1**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js ci
```

Expected: npm 11.18.0 installs the locked dependency graph with no lockfile change.

- [ ] **Step 3: Run the full Node 22.23.1 gate**

Run:

```bash
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run verify
npm exec --yes --package=node@22.23.1 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js audit --omit=dev --audit-level=high
```

Expected: formatting, lint, strict type checking, all Vitest files, build, installed-package smoke, exact package contents, and production audit pass with zero failures.

- [ ] **Step 4: Reinstall and run the full Node 24.19.0 gate**

Run:

```bash
npm exec --yes --package=node@24.19.0 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js ci
npm exec --yes --package=node@24.19.0 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run verify
npm exec --yes --package=node@24.19.0 -- node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js audit --omit=dev --audit-level=high
```

Expected: the same gate passes under Node 24.19.0 with zero production vulnerabilities.

- [ ] **Step 5: Verify repository and artifact hygiene**

Run:

```bash
git diff --check
git status --short
find . -maxdepth 1 -name '*.tgz' -print
```

Expected: no tracked changes, no staged changes, and no package tarball remains in the worktree root. Untracked dependency/build directories are ignored by the integrated `.gitignore` and do not appear.

- [ ] **Step 6: Record Wave 0 evidence and open Wave 1**

Comment on epic #16 with the exact version-branch commit, Node/npm versions, test counts, package file count, audit result, and CI URLs. Set issue #1 to `In progress` only when its dedicated branch is created.

Expected: Wave 0 is checked complete; issue #1 remains Todo until branch creation; no release, tag, npm publication, or main merge exists.
