# SDK Showcase Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the Chat reference adapter, SDK starter, and published integration guidance from silently drifting apart.

**Architecture:** Chat owns a deterministic, presentation-only contract manifest; SDK imports an exact copy with a recorded SHA-256 digest. A cross-repository canary compares bytes, compiles both implementations, runs security assertions, and deliberately proves that stale digests fail.

**Tech Stack:** Node.js 24.18.x, TypeScript 6.0.3, pnpm 10.34.0, SHA-256, Vitest 4.1.10.

---

## Prerequisites

- Complete `2026-08-19-chat-reference-adapter.md` through Task 4.
- Complete `2026-08-19-sdk-chat-starter.md` through Task 4.
- Use clean, isolated Chat and SDK worktrees.
- Do not combine this gate with the Phase 0 SDK/Cave `contract-canary.lock.json`.

## File Map

- Create `sdk/examples/chat-starter/reference-app-contract.json`: copied manifest.
- Create `sdk/examples/chat-starter/reference-app-contract.sha256`: copied digest.
- Create `sdk/scripts/sync-chat-reference-contract.mjs`: explicit import/check command.
- Modify `sdk/examples/chat-starter/src/reference-contract.ts`: derive types from the manifest.
- Modify `sdk/package.json`: add sync/check scripts.
- Create `chat/scripts/sdk-showcase-canary.mjs`: clean-worktree cross-repository gate.
- Create `chat/sdk-showcase-canary.lock.json`: exact Chat/SDK revisions and digest.
- Create `chat/src/sdk-showcase-canary.test.ts`: script and stale-digest guards.
- Modify `chat/package.json`: add the canary command.
- Modify both builder guides: document ownership and synchronization.

## Task 1: Import the Chat Contract into the SDK Starter

**Files:**
- Create: `sdk/scripts/sync-chat-reference-contract.mjs`
- Create: `sdk/examples/chat-starter/reference-app-contract.json`
- Create: `sdk/examples/chat-starter/reference-app-contract.sha256`
- Modify: `sdk/examples/chat-starter/src/reference-contract.ts`
- Modify: `sdk/package.json`
- Test: `sdk/tests/chat-reference-contract.spec.ts`

- [ ] **Step 1: Write failing import/check tests**

```ts
it('accepts an exact manifest and digest copied from Chat');
it('rejects a manifest whose bytes do not match its digest');
it('rejects a manifest version unsupported by the starter');
it('does not expose current APIs for preview-only capabilities');
```

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm@10.34.0 test -- tests/chat-reference-contract.spec.ts
```

- [ ] **Step 3: Implement the sync command**

The command requires an explicit Chat root:

```bash
corepack pnpm@10.34.0 reference:sync -- --chat-root ../chat
corepack pnpm@10.34.0 reference:check -- --chat-root ../chat
```

It resolves and validates the root, reads `reference-app-contract.json` and
`.sha256`, verifies the digest before copying, writes atomically, and supports
`--check` without mutation. Reject missing files, dirty source bytes, unknown
manifest versions, and paths outside the provided root.

- [ ] **Step 4: Derive starter discriminants from the manifest**

Use `resolveJsonModule` and `satisfies` to validate the imported manifest. Keep
TypeScript interfaces handwritten and compare all state/action names to the
manifest in tests; do not generate or publish package API from preview data.

- [ ] **Step 5: Sync, verify, and commit in SDK**

```bash
: "${CHAT_ROOT:?set CHAT_ROOT to the clean Chat reference-adapter worktree}"
corepack pnpm@10.34.0 reference:sync -- --chat-root "$CHAT_ROOT"
corepack pnpm@10.34.0 reference:check -- --chat-root "$CHAT_ROOT"
corepack pnpm@10.34.0 test -- tests/chat-reference-contract.spec.ts
git add package.json scripts/sync-chat-reference-contract.mjs \
  tests/chat-reference-contract.spec.ts examples/chat-starter/reference-app-contract.* \
  examples/chat-starter/src/reference-contract.ts
git commit -m "test: pin the Chat reference contract" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 2: Add the Cross-Repository Canary

**Files:**
- Create: `chat/scripts/sdk-showcase-canary.mjs`
- Create: `chat/sdk-showcase-canary.lock.json`
- Create: `chat/src/sdk-showcase-canary.test.ts`
- Modify: `chat/package.json`

- [ ] **Step 1: Write failing canary script tests**

Assert:

```ts
it('requires clean Chat and SDK worktrees');
it('requires both HEADs to match the lock');
it('requires byte-identical contract manifests and digests');
it('runs Chat reference checks and SDK packed starter verification');
it('rejects a deliberate stale digest');
```

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm@10.34.0 test -- src/sdk-showcase-canary.test.ts
```

- [ ] **Step 3: Implement the lock**

Generate the lock from clean checked-out revisions:

```bash
: "${SDK_ROOT:?set SDK_ROOT to the clean SDK starter worktree}"
node scripts/sdk-showcase-canary.mjs --write-lock --sdk-root "$SDK_ROOT"
```

The command writes schema version `1`, both 40-character HEAD revisions, and the
64-character lowercase contract SHA-256. The implementation must reject
abbreviated revisions, dirty trees, mismatched HEADs, mismatched manifest bytes,
mismatched digests, and unexpected untracked files.

- [ ] **Step 4: Implement the canary command**

```bash
: "${SDK_ROOT:?set SDK_ROOT to the clean SDK starter worktree}"
corepack pnpm@10.34.0 test:sdk-showcase-canary -- --sdk-root "$SDK_ROOT"
```

Run, in order:

1. Chat `reference:check`;
2. SDK `reference:check -- --chat-root "$CHAT_ROOT"`;
3. Chat reference adapter tests/typecheck/build;
4. SDK starter tests/typecheck/build;
5. SDK packed package verification;
6. stale-digest negative probe in a temporary copied manifest.

Clean the temporary directory in `finally`; never mutate either worktree.

- [ ] **Step 5: Run the canary and commit in Chat**

```bash
corepack pnpm@10.34.0 test -- src/sdk-showcase-canary.test.ts
: "${SDK_ROOT:?set SDK_ROOT to the clean SDK starter worktree}"
corepack pnpm@10.34.0 test:sdk-showcase-canary -- --sdk-root "$SDK_ROOT"
git add package.json scripts/sdk-showcase-canary.mjs \
  src/sdk-showcase-canary.test.ts sdk-showcase-canary.lock.json
git commit -m "test: add the SDK showcase conformance canary" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 3: Document Ownership and Release Order

**Files:**
- Modify: `chat/docs/build-with-opencoven-sdk.md`
- Modify: `sdk/docs/build-a-chat-interface.md`
- Modify: `chat/docs/superpowers/specs/2026-08-19-sdk-showcase-reference-app-design.md`

- [ ] **Step 1: Add failing documentation assertions**

Require:

```text
Chat owns the presentation contract manifest.
The SDK starter consumes an exact checked copy.
Preview contracts are not stable package API.
Merge order: Chat contract, SDK starter sync, Chat canary lock.
```

- [ ] **Step 2: Verify RED in both repositories**

```bash
corepack pnpm@10.34.0 test -- src/specification-guards.test.ts
corepack pnpm@10.34.0 test -- tests/documentation.spec.ts
```

- [ ] **Step 3: Update both guides and the design record**

Document the ownership rule, exact sync/check commands, stale-digest behavior,
and release order. State that a later stable SDK API may replace this
example-level contract only through a separately reviewed design change.

- [ ] **Step 4: Run final gates**

In Chat:

```bash
corepack pnpm@10.34.0 lint
corepack pnpm@10.34.0 typecheck
corepack pnpm@10.34.0 test
corepack pnpm@10.34.0 build
: "${SDK_ROOT:?set SDK_ROOT to the clean SDK starter worktree}"
corepack pnpm@10.34.0 test:sdk-showcase-canary -- --sdk-root "$SDK_ROOT"
```

In SDK:

```bash
corepack pnpm@10.34.0 lint
corepack pnpm@10.34.0 typecheck
corepack pnpm@10.34.0 test
corepack pnpm@10.34.0 build
corepack pnpm@10.34.0 verify:package
```

- [ ] **Step 5: Commit documentation in each repository**

```bash
git add docs/build-with-opencoven-sdk.md \
  docs/superpowers/specs/2026-08-19-sdk-showcase-reference-app-design.md
git commit -m "docs: define SDK showcase contract ownership" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

```bash
git add docs/build-a-chat-interface.md
git commit -m "docs: define Chat starter synchronization" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 4: Publish in Dependency Order and Clean Worktrees

**Files:**
- No source changes unless CI exposes a task-related defect.

- [ ] **Step 1: Publish the Chat adapter branch**

Push and open a PR that references the approved design and reports Chat-local
verification. Do not claim cross-repository conformance yet.

- [ ] **Step 2: Publish the SDK starter branch**

After the Chat contract commit is immutable, sync that exact revision, rerun
packed verification, push, and open the SDK PR.

- [ ] **Step 3: Merge only green dependency PRs**

Merge Chat adapter first, SDK starter second, then update the Chat canary lock
to exact merged revisions and publish the canary PR.

- [ ] **Step 4: Close with Beads evidence**

Record exact merge SHAs, commands, passing counts, packed verification evidence,
and the deliberate stale-digest failure in the owning Bead.

- [ ] **Step 5: Perform safe aggressive cleanup**

For each merged branch:

```bash
git worktree list --porcelain
git status --short
git branch --merged origin/main
git worktree remove /exact/clean/merged/worktree
git branch -d exact-merged-branch
git fetch --prune
git worktree prune
```

Never remove dirty, locked, active, unmerged, protected, or explicitly retained
worktrees/branches. Re-run `git worktree list` and `git branch -vv` to verify
only merged artifacts were removed.
