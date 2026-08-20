# Real Authority Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the full Phase 1 discovery/pairing flow against packaged Chat and packed SDK artifacts talking to a real isolated Cave, then wire that proof into CI, documentation, and bead/gate closure.

**Architecture:** Extend the existing Chat contract-canary model into a Phase 1 conformance harness. A new immutable lock pins the exact reviewed Chat, SDK, Cave, and Coven revisions; the harness creates process-owned artifact roots, builds/uses packaged artifacts, runs real scenarios, scans retained evidence for secrets, and records only secret-free diagnostics.

**Tech Stack:** Node 24.18.x, pnpm 10.34.0, existing `contract-canary.lock.json`/`scripts/contract-canary.mjs` patterns, Playwright, Tauri build artifacts, packed SDK tarballs, GitHub Actions with SHA-pinned actions, Beads (`bd ready`, `bd show`, `bd close`).

---

## File Map

**Primary repository root:** `/Users/buns/Documents/GitHub/OpenCoven/chat`
**Implementation worktree:** `/Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance`
**Branch:** `phase1d/real-authority-conformance`
**Primary beads:** `cave-0prpu`, `cave-23nmv`, `cave-fz01p`

### Create
- `phase1-conformance.lock.json` — immutable reviewed revision lock for Chat, SDK, Cave, and Coven.
- `scripts/phase1-conformance-lock.mjs` — lock reader, clean-checkout verifier, and exact-head verifier.
- `scripts/process-owned-artifact-root.mjs` — process-created OS-temp roots that compose the existing inode/stamp-checked cleanup helper with exact child-PID tracking.
- `scripts/phase1-artifact-secret-scan.mjs` — retained-artifact scan for pairing secrets, bearers, headers, and keychain values.
- `scripts/phase1-conformance.mjs` — packaged harness that checks out/builds/runs the reviewed artifacts and executes all scenarios.
- `src/phase1-conformance-lock.test.ts` — lock and clean-checkout behavior tests.
- `src/phase1-conformance-artifact-root.test.ts` — process-owned root and cleanup tests.
- `src/phase1-artifact-secret-scan.test.ts` — redaction and scan coverage.
- `docs/phase1-conformance.md` — operator guide for running and reading the conformance harness.

### Modify
- `package.json` — add `test:phase1-conformance`.
- `scripts/contract-canary.mjs`, `scripts/owned-temp-directory.mjs`, and `src/contract-canary-artifact-root.test.ts` — share verified helper logic where it makes the Phase 1 harness safer, without replacing the Phase 0 canary.
- `contract-canary.lock.json` documentation references in `README.md` and `docs/developer-toolchains.md` — explain the relationship between the Phase 0 canary lock and the new Phase 1 lock.
- `.github/workflows/ci.yml` — add the required Phase 1 conformance job with SHA-pinned actions.
- `docs/superpowers/plans/2026-08-15-opencoven-chat-program-tracking.md` — record the new gate evidence path.

### Task 1: Add the immutable Phase 1 lock and exact-checkout verifier

**Files:**
- Create: `phase1-conformance.lock.json`
- Create: `scripts/phase1-conformance-lock.mjs`
- Create: `src/phase1-conformance-lock.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Create a clean Chat worktree for Phase 1d**

Run:

```bash
git -C /Users/buns/Documents/GitHub/OpenCoven/chat fetch origin main
git -C /Users/buns/Documents/GitHub/OpenCoven/chat worktree add /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance -b phase1d/real-authority-conformance origin/main
git -C /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance status --short --branch
git -C /Users/buns/Documents/GitHub/OpenCoven/sdk fetch origin main
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-cave fetch origin main
git -C /Users/buns/Documents/GitHub/OpenCoven/coven fetch origin main
```

Expected: the new worktree is clean, and all Phase 1a/1b/1c implementation PRs are merged before their exact `origin/main` revisions are written into the conformance lock.

- [ ] **Step 2: Write the failing lock tests**

```ts
import { describe, expect, test } from 'vitest';

import {
  assertCleanPhase1Checkouts,
  assertPhase1CheckoutHeads,
  readPhase1ConformanceLock,
} from '../scripts/phase1-conformance-lock.mjs';

describe('phase1 conformance lock', () => {
  test('pins immutable reviewed revisions for chat, sdk, cave, and coven', () => {
    const lock = readPhase1ConformanceLock();
    expect(lock.chat.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.sdk.repository).toBe('OpenCoven/sdk');
    expect(lock.cave.repository).toBe('OpenCoven/coven-cave');
    expect(lock.coven.repository).toBe('OpenCoven/coven');
  });
});
```

- [ ] **Step 3: Run the focused lock tests and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance
pnpm vitest run src/phase1-conformance-lock.test.ts
```

Expected: the new lock and verifier module do not exist yet, so the run fails.

- [ ] **Step 4: Implement the minimal immutable lock and verifier**

```js
export function readPhase1ConformanceLock(lockPath = resolve(root, 'phase1-conformance.lock.json')) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  return {
    version: expectVersion(lock.version),
    chat: validateLockEntry(lock.chat, 'OpenCoven/chat'),
    sdk: validateLockEntry(lock.sdk, 'OpenCoven/sdk'),
    cave: validateLockEntry(lock.cave, 'OpenCoven/coven-cave'),
    coven: validateLockEntry(lock.coven, 'OpenCoven/coven'),
  };
}
```

Implementation requirements:
- reject non-40-character SHAs;
- require clean exact checkouts for the locked Chat/SDK/Cave/Coven roots;
- add `test:phase1-conformance` to `package.json`, but do not remove or repurpose `test:contract-canary`.

- [ ] **Step 5: Run the focused lock tests again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance
pnpm vitest run src/phase1-conformance-lock.test.ts src/specification-guards.test.ts
```

Expected: the lock tests pass and the repository still honors the existing specification guards.

- [ ] **Step 6: Commit the lock foundation**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance
git add phase1-conformance.lock.json scripts/phase1-conformance-lock.mjs src/phase1-conformance-lock.test.ts package.json
git commit -m "feat: pin Phase 1 conformance revisions" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Replace ad hoc temp handling with process-owned artifact roots and exact child cleanup

**Files:**
- Create: `scripts/process-owned-artifact-root.mjs`
- Create: `src/phase1-conformance-artifact-root.test.ts`
- Modify: `scripts/owned-temp-directory.mjs`
- Modify: `src/contract-canary-artifact-root.test.ts`

- [ ] **Step 1: Write the failing artifact-root tests**

```ts
it('creates mode-0700 process-owned roots below the real OS temp directory', () => {
  const root = createProcessOwnedArtifactRoot({ prefix: 'phase1-conformance' });
  expect(root.rootPath.startsWith(realpathSync(tmpdir()))).toBe(true);
  expect(lstatSync(root.rootPath).mode & 0o777).toBe(0o700);
  expect(root.ownerPid).toBe(process.pid);
});

it('kills only tracked child pids during cleanup', async () => {
  const root = createProcessOwnedArtifactRoot({ prefix: 'phase1-conformance' });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await root.trackChild(child.pid!);
  await root.cleanup();
  expect(root.cleanedChildren).toContain(child.pid);
});
```

- [ ] **Step 2: Run the focused artifact-root tests and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance
pnpm vitest run src/phase1-conformance-artifact-root.test.ts src/contract-canary-artifact-root.test.ts
```

Expected: the process-owned helper does not exist yet, so the focused run fails.

- [ ] **Step 3: Implement the minimal process-owned root helper**

```js
import { cleanupOwnedTempRoot, createOwnedTempDirectory } from './owned-temp-directory.mjs';

export function createProcessOwnedArtifactRoot({ prefix }) {
  const owned = createOwnedTempDirectory({ prefix: `${prefix}-${process.pid}` });
  const trackedChildren = new Set();
  const cleanedChildren = [];
  return {
    rootPath: owned.rootPath,
    ownerPid: process.pid,
    cleanedChildren,
    trackChild(pid) {
      trackedChildren.add(pid);
    },
    async cleanup() {
      for (const pid of trackedChildren) {
        process.kill(pid, 'SIGTERM');
        cleanedChildren.push(pid);
      }
      cleanupOwnedTempRoot(owned);
    },
  };
}
```

Implementation requirements:
- execution roots come only from `createOwnedTempDirectory`, beneath the real OS temp directory; callers cannot supply a cleanup path;
- cleanup retains the existing device, inode, random-stamp, realpath, atomic-rename, and non-symlink-following guarantees;
- cleanup tracks and terminates only exact child PIDs that the harness started;
- copy only a completed, secret-scanned JSON report to the caller-selected retained-evidence file; never recursively pre-delete or clean a repository-local `test-results` directory;
- update the existing contract-canary artifact-root tests only where the shared safety logic truly overlaps.

- [ ] **Step 4: Run the focused artifact-root tests again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance
pnpm vitest run src/phase1-conformance-artifact-root.test.ts src/contract-canary-artifact-root.test.ts
```

Expected: both the new Phase 1 tests and the existing contract-canary safety tests pass.

- [ ] **Step 5: Commit the artifact-root safety layer**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance
git add scripts/process-owned-artifact-root.mjs scripts/owned-temp-directory.mjs src/phase1-conformance-artifact-root.test.ts src/contract-canary-artifact-root.test.ts
git commit -m "feat: harden conformance artifact ownership" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Build the packaged Phase 1 harness, scenarios, and retained-artifact secret scan

**Files:**
- Create: `scripts/phase1-artifact-secret-scan.mjs`
- Create: `scripts/phase1-conformance.mjs`
- Create: `src/phase1-artifact-secret-scan.test.ts`
- Modify: `README.md`
- Modify: `docs/developer-toolchains.md`

- [ ] **Step 1: Write the failing scenario and secret-scan tests**

```ts
it('fails when retained artifacts include a bearer, pairing secret, or Authorization header', async () => {
  await expect(scanPhase1Artifacts({ artifactRoot: 'test-results/fixtures/leaky' })).rejects.toThrow(/secret/i);
});

it('reports the full approved scenario matrix', async () => {
  const report = await runPhase1Conformance({ scenario: 'all' });
  expect(report.scenarios.map((scenario) => scenario.name)).toEqual([
    'missing-cave-auto-launch',
    'fresh-approval-exchange',
    'denial',
    'expiry',
    'restart-reconnect',
    'revocation-repair',
    'replay-rejection',
    'api-major-mismatch',
    'minimum-version-upgrade',
    'sdk-memory-pairing',
    'cli-secure-store-pairing',
    'doctor-json-redaction',
  ]);
});
```

- [ ] **Step 2: Run the focused harness tests and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance
pnpm vitest run src/phase1-artifact-secret-scan.test.ts
node ./scripts/phase1-conformance.mjs --lock ./phase1-conformance.lock.json --scenario all --retain-sanitized-report ./test-results/phase1-conformance/manual-review.json
```

Expected: the new scan script and harness do not exist yet, so the tests fail.

- [ ] **Step 3: Implement the packaged harness and secret scan**

```js
export async function runPhase1Conformance(options) {
  const lock = readPhase1ConformanceLock(options.lockPath);
  const artifactRoot = createProcessOwnedArtifactRoot({ prefix: 'phase1-conformance' });
  try {
    const checkouts = await checkoutReviewedRepositories(lock, artifactRoot.rootPath);
    const packaged = await buildPackagedArtifacts(checkouts);
    const report = redactPhase1Report(await runScenarioMatrix(packaged, [
      'missing-cave-auto-launch',
      'fresh-approval-exchange',
      'denial',
      'expiry',
      'restart-reconnect',
      'revocation-repair',
      'replay-rejection',
      'api-major-mismatch',
      'minimum-version-upgrade',
      'sdk-memory-pairing',
      'cli-secure-store-pairing',
      'doctor-json-redaction',
    ]));
    const reportPath = await writeOwnedJsonReport(artifactRoot.rootPath, 'report.json', report);
    await scanPhase1Artifacts({ artifactRoot: artifactRoot.rootPath });
    if (options.retainSanitizedReport) {
      await copySanitizedEvidenceFile(reportPath, options.retainSanitizedReport);
    }
    return report;
  } finally {
    await artifactRoot.cleanup();
  }
}
```

Implementation requirements:
- package Chat, pack SDK/CLI tarballs, and run against a real isolated Cave instance from the locked revisions;
- keep the harness secret-free by construction: redact logs, traces, screenshots, JSON, and retained artifacts before reporting success;
- write retained evidence only after the entire owned root passes the secret scan; copy one exact regular JSON file, reject a symlink destination, and create missing parent directories without deleting existing entries;
- never delete caller-selected paths; cleanup only the harness-owned artifact roots and exact child PIDs it created.

- [ ] **Step 4: Run the full Phase 1 harness locally and confirm it passes**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance
node ./scripts/phase1-conformance.mjs --lock ./phase1-conformance.lock.json --scenario all --retain-sanitized-report ./test-results/phase1-conformance/manual-review.json
pnpm vitest run src/phase1-artifact-secret-scan.test.ts
```

Expected: the scenario matrix passes, and the retained-artifact scan reports no secrets.

- [ ] **Step 5: Commit the harness and secret scan**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance
git add scripts/phase1-artifact-secret-scan.mjs scripts/phase1-conformance.mjs src/phase1-artifact-secret-scan.test.ts README.md docs/developer-toolchains.md
git commit -m "feat: prove Phase 1 against packaged real authorities" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Wire CI, docs, the Phase 1 gate, and Beads closure

**Files:**
- Create: `docs/phase1-conformance.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/superpowers/plans/2026-08-15-opencoven-chat-program-tracking.md`

- [ ] **Step 1: Write the failing CI and documentation assertions**

```ts
it('keeps the new conformance workflow SHA-pinned and required', () => {
  const workflow = readText('.github/workflows/ci.yml');
  expect(workflow).toContain('Phase 1 conformance');
  expect(workflow).toMatch(/uses: actions\/checkout@[0-9a-f]{40}/);
});
```

- [ ] **Step 2: Run the focused CI/doc checks and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance
pnpm vitest run src/specification-guards.test.ts
```

Expected: the spec guards do not yet mention the new required conformance job or docs.

- [ ] **Step 3: Implement the CI job, operator docs, and gate documentation**

```yaml
  phase1-conformance:
    name: Phase 1 conformance
    runs-on: macos-15
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - run: pnpm install --frozen-lockfile
      - name: Configure isolated test keychain
        shell: bash
        run: |
          keychain="$RUNNER_TEMP/phase1-conformance.keychain-db"
          password="$(openssl rand -hex 32)"
          security create-keychain -p "$password" "$keychain"
          security set-keychain-settings -lut 21600 "$keychain"
          security unlock-keychain -p "$password" "$keychain"
          security default-keychain -d user -s "$keychain"
          security list-keychains -d user -s "$keychain"
          echo "PHASE1_TEST_KEYCHAIN=$keychain" >> "$GITHUB_ENV"
      - run: pnpm test:phase1-conformance
      - name: Remove isolated test keychain
        if: always()
        shell: bash
        run: |
          if [[ -n "${PHASE1_TEST_KEYCHAIN:-}" ]]; then
            security delete-keychain "$PHASE1_TEST_KEYCHAIN"
          fi
```

Implementation requirements:
- keep actions SHA-pinned, matching the current repository convention;
- create, unlock, select, and always delete a dedicated runner-local keychain so native CLI and Tauri secure-store scenarios fail only on real adapter errors, not a locked default keychain;
- document the lock, artifact root, scenario list, secret-scan policy, and failure interpretation in `docs/phase1-conformance.md`;
- update program-tracking docs so the Phase 1 gate closes only after this job and its evidence are green.

- [ ] **Step 4: Run the full Chat + conformance validation matrix**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:e2e
pnpm test:contract-canary -- --sdk-root /Users/buns/Documents/GitHub/OpenCoven/sdk --cave-root /Users/buns/Documents/GitHub/OpenCoven/coven-cave
pnpm cargo:fmt
pnpm cargo:check
pnpm cargo:test
pnpm cargo:clippy
pnpm app:build
pnpm test:phase1-conformance
```

Expected: all commands pass. Do not run any publish or release workflow.

- [ ] **Step 5: Commit, push, open the PR, merge, and close the gate beads**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1d-real-authority-conformance
git add docs/phase1-conformance.md .github/workflows/ci.yml docs/superpowers/plans/2026-08-15-opencoven-chat-program-tracking.md
git commit -m "docs: wire Phase 1 conformance gate" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push -u origin phase1d/real-authority-conformance
gh -R OpenCoven/chat pr create --base main --head phase1d/real-authority-conformance --title "feat: add Phase 1 real-authority conformance gate" --body "## Summary
- pin the reviewed Phase 1 revisions across Chat, SDK, Cave, and Coven
- run a packaged real-authority conformance harness with retained-artifact secret scans
- require the Phase 1 conformance job before closing the gate

## Testing
- pnpm lint
- pnpm typecheck
- pnpm test:unit
- pnpm test:e2e
- pnpm test:contract-canary -- --sdk-root /Users/buns/Documents/GitHub/OpenCoven/sdk --cave-root /Users/buns/Documents/GitHub/OpenCoven/coven-cave
- pnpm cargo:fmt
- pnpm cargo:check
- pnpm cargo:test
- pnpm cargo:clippy
- pnpm app:build
- pnpm test:phase1-conformance"
gh -R OpenCoven/chat pr checks --watch
gh -R OpenCoven/chat pr merge --squash --delete-branch=false
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd ready --json --limit 0
bd show cave-0prpu
bd show cave-23nmv
bd show cave-fz01p
bd close cave-0prpu --reason "Merged phase1d/real-authority-conformance after the full Chat validation matrix and pnpm test:phase1-conformance."
bd close cave-23nmv --reason "Merged phase1d/real-authority-conformance after the full Chat validation matrix and pnpm test:phase1-conformance."
bd close cave-fz01p --reason "All Phase 1 implementation, integration, and conformance PRs merged with green required checks and retained-artifact secret scans."
```

Expected: the Phase 1 gate closes only after the required checks are green and the beads record the merged evidence.
