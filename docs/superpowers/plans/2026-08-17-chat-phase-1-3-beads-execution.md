# Chat Phase 1-3 Beads Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the Chat-owned Phase 1, Phase 2, and Phase 3 desktop beads in dependency order without bypassing the central cross-repository gates.

**Architecture:** The existing approved Chat design and the three 2026-08-15 phase plans remain the code-level plans of record. This plan adds the exact Beads, branch, worktree, validation, evidence, and stop workflow for the Chat-owned task ranges only.

**Tech Stack:** Beads 1.0.5, Git worktrees, React 19.2.8, TypeScript 6.0.3, Tauri 2.11.x, Rust 1.95.0, Vitest 4.1.10, Testing Library, Playwright 1.62.1, TanStack Query 5, OS keychains, SSE.

---

## Plan of Record

Use these documents together:

- Design: `docs/superpowers/specs/2026-08-10-opencoven-chat-design.md`
- Execution design: `docs/superpowers/specs/2026-08-17-chat-phase-1-3-execution-design.md`
- Phase 1: `docs/superpowers/plans/2026-08-15-phase-1-discovery-pairing.md`
- Phase 2: `docs/superpowers/plans/2026-08-15-phase-2-canonical-reads.md`
- Phase 3: `docs/superpowers/plans/2026-08-15-phase-3-send-stream-recovery.md`

The central tracker is `/Users/buns/Documents/GitHub/OpenCoven/coven-cave`.
Run all `bd` commands there. Run all Chat Git and implementation commands in
the active Chat bead worktree.

## File Map

### Phase 1: `cave-tsvfj`

- Create native modules:
  - `src-tauri/src/discovery.rs`
  - `src-tauri/src/cave_process.rs`
  - `src-tauri/src/keychain.rs`
  - `src-tauri/src/transport.rs`
  - `src-tauri/src/commands.rs`
  - `src-tauri/src/test_support.rs`
- Modify:
  - `src-tauri/Cargo.toml`
  - `src-tauri/src/lib.rs`
- Create webview boundary and state:
  - `src/lib/native/cave.ts`
  - `src/lib/connection/types.ts`
  - `src/lib/connection/reducer.ts`
  - `src/lib/connection/reducer.test.ts`
  - `src/lib/connection/controller.ts`
  - `src/lib/connection/controller.test.ts`
  - `src/components/shell/connection-gate.tsx`
  - `src/components/shell/connection-gate.test.tsx`

### Phase 2: `cave-ff3j6`

- Create styles:
  - `src/styles/tokens.css`
  - `src/styles/reset.css`
  - `src/styles/shell.css`
  - `src/styles/sidebar.css`
  - `src/styles/thread.css`
  - `src/styles/accessibility.css`
- Create shell and query state:
  - `src/components/shell/app-shell.tsx`
  - `src/components/shell/app-shell.test.tsx`
  - `src/lib/chat/query-keys.ts`
  - `src/lib/chat/query-client.ts`
  - `src/lib/chat/cache-order.ts`
  - `src/lib/chat/cache-order.test.ts`
- Create sidebar and transcript:
  - `src/components/sidebar/familiar-filter.tsx`
  - `src/components/sidebar/conversation-row.tsx`
  - `src/components/sidebar/conversation-list.tsx`
  - `src/components/sidebar/conversation-list.test.tsx`
  - `src/components/sidebar/sidebar.tsx`
  - `src/components/thread/thread-header.tsx`
  - `src/components/thread/message-list.tsx`
  - `src/components/thread/basic-message.tsx`
  - `src/components/thread/thread.test.tsx`
- Modify:
  - `src/main.tsx`
  - `src/app.tsx`
- Remove the mock demo only after the canonical shell replaces every default
  development path:
  - `src/demo/`

### Phase 3: `cave-p4ilm`

- Create conversation and composer modules:
  - `src/components/thread/new-conversation.tsx`
  - `src/components/thread/new-conversation.test.tsx`
  - `src/components/thread/composer.tsx`
  - `src/components/thread/composer.test.tsx`
  - `src/components/thread/streaming-message.tsx`
- Create chat execution modules:
  - `src/lib/chat/stream-reducer.ts`
  - `src/lib/chat/stream-reducer.test.ts`
  - `src/lib/chat/stream-controller.ts`
  - `src/lib/chat/stream-controller.test.ts`
  - `src/lib/chat/draft-store.ts`
  - `src/lib/chat/draft-store.test.ts`
  - `src/lib/chat/slash-commands.ts`
  - `src/lib/chat/slash-commands.test.ts`
- Create native secure storage:
  - `src-tauri/src/secure_store.rs`
  - `src-tauri/src/drafts.rs`
- Create the constrained native client:
  - `src-tauri/crates/cave-client/Cargo.toml`
  - `src-tauri/crates/cave-client/src/lib.rs`
  - `src-tauri/crates/cave-client/src/error.rs`
  - `src-tauri/crates/cave-client/src/http.rs`
  - `src-tauri/crates/cave-client/src/sse.rs`
  - `src-tauri/crates/cave-client/src/types.rs`
- Modify:
  - `src/components/thread/message-list.tsx`
  - `src-tauri/Cargo.toml`
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/transport.rs`
  - `src-tauri/src/commands.rs`

## Task 1: Enforce the Phase 0 Readiness Gate

**Files:** None.

- [ ] **Step 1: Read the selected bead and its blocker**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd show cave-tsvfj
bd show cave-bt9wx
```

Expected: `cave-tsvfj` depends on `cave-bt9wx`.

- [ ] **Step 2: Check atomic readiness**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd ready --json --limit 0 |
  jq '[.[] | select(.id == "cave-tsvfj")]'
```

Expected before Phase 0 closes: `[]`.

- [ ] **Step 3: Stop if the bead is not ready**

Do not claim, create a phase worktree, change Chat code, or close another
repository's bead. Record this blocker:

```text
Blocked by cave-bt9wx.
Observed with: bd ready --json --limit 0
No Chat implementation started and no dependency was bypassed.
```

Expected: execution pauses until the central tracker marks `cave-tsvfj` ready.

## Task 2: Claim and Isolate Phase 1

**Files:** None.

- [ ] **Step 1: Update and rebase the clean Chat main checkout**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat
git status --short
git fetch origin
git rebase origin/main
```

Expected: empty status before the rebase and a successful rebase.

- [ ] **Step 2: Claim the ready bead atomically**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd ready --json --limit 0 |
  jq -e '.[] | select(.id == "cave-tsvfj")'
bd update cave-tsvfj --claim
bd show cave-tsvfj
```

Expected: the readiness query succeeds and the bead becomes assigned and
in-progress.

- [ ] **Step 3: Create the dedicated worktree**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat
git worktree add \
  .worktrees/cave-tsvfj-chat-discovery \
  -b cave-tsvfj-chat-discovery \
  origin/main
git -C .worktrees/cave-tsvfj-chat-discovery rebase origin/main
```

Expected: a clean worktree on `cave-tsvfj-chat-discovery`.

## Task 3: Implement Phase 1 Native Discovery and Connection State

**Files:** Phase 1 paths in the File Map.

- [ ] **Step 1: Execute Phase 1 Task 5 test-first**

Follow `2026-08-15-phase-1-discovery-pairing.md`, Task 5, exactly. Write the
Rust discovery, process, keychain, and constrained transport tests before the
implementation.

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml discovery
cargo test --manifest-path src-tauri/Cargo.toml cave_process
cargo test --manifest-path src-tauri/Cargo.toml keychain
cargo test --manifest-path src-tauri/Cargo.toml transport
```

Expected before implementation: failing tests for the missing modules and
commands. Expected after implementation: all four focused suites pass.

- [ ] **Step 2: Commit the native boundary**

```bash
git add src-tauri/Cargo.toml src-tauri/src src/lib/native/cave.ts
git commit -m "feat: add native Cave discovery and credentials" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 3: Execute Phase 1 Task 6 test-first**

Follow the Phase 1 plan, Task 6, exactly. Implement the legal connection
transitions, stale-attempt rejection, deterministic backoff, repeated-401
revocation behavior, pairing UI, diagnostics, and retry behavior.

Run:

```bash
pnpm test -- \
  src/lib/connection/reducer.test.ts \
  src/lib/connection/controller.test.ts \
  src/components/shell/connection-gate.test.tsx
pnpm typecheck
pnpm build
```

Expected: the focused tests, typecheck, and build pass.

- [ ] **Step 4: Commit the connection lifecycle**

```bash
git add src/lib/connection src/components/shell
git commit -m "feat: manage Cave pairing lifecycle" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 5: Run the Phase 1 Chat validation matrix**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

Expected: all commands pass.

## Task 4: Record Phase 1 Evidence and Stop at the Phase 1 Gate

**Files:** None.

- [ ] **Step 1: Collect exact repository evidence**

```bash
git status --short --branch
git rev-parse HEAD
git diff origin/main...HEAD --stat
```

Expected: a clean worktree and the intended Phase 1 changes only.

- [ ] **Step 2: Append Beads evidence**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd update cave-tsvfj --append-notes "$(cat <<'EOF'
Repository: OpenCoven/chat
Branch/worktree: cave-tsvfj-chat-discovery / chat/.worktrees/cave-tsvfj-chat-discovery
Counterpart SHA or release: record the tested Cave and SDK SHAs
Files changed: record git diff --stat output
Tests added first: Rust discovery/process/keychain/transport and connection reducer/controller/UI
Verification commands and results: record exact commands and passing summaries
Live-authority or packaged evidence: pending cross-repository cave-0prpu unless already available
Security/secret review: bearer remained inside Rust/keychain; no secret-bearing JS, logs, traces, or screenshots
Known follow-up or blocker: cave-23nmv must close before Phase 2
Commit/push state: record local commit SHAs and whether they were pushed
EOF
)"
```

- [ ] **Step 3: Request closure only with complete bead evidence**

Do not close `cave-23nmv`. Close or request closure of `cave-tsvfj` according to
the repository's Beads review workflow, then confirm Phase 2 remains blocked:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd show cave-23nmv
bd ready --json --limit 0 |
  jq '[.[] | select(.id == "cave-ff3j6")]'
```

Expected until the cross-repository gate closes: `[]`.

## Task 5: Claim and Isolate Phase 2

**Files:** None.

- [ ] **Step 1: Wait for the exact gate**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd ready --json --limit 0 |
  jq -e '.[] | select(.id == "cave-ff3j6")'
```

Expected: the command succeeds only after `cave-23nmv` closes.

- [ ] **Step 2: Rebase main and claim the bead**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat
git status --short
git switch main
git fetch origin
git rebase origin/main

cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd update cave-ff3j6 --claim
```

- [ ] **Step 3: Create the Phase 2 worktree**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat
git worktree add \
  .worktrees/cave-ff3j6-canonical-reads \
  -b cave-ff3j6-canonical-reads \
  origin/main
git -C .worktrees/cave-ff3j6-canonical-reads rebase origin/main
```

Expected: a clean Phase 2 worktree.

## Task 6: Implement Phase 2 Shell, Reads, and Transcript

**Files:** Phase 2 paths in the File Map.

- [ ] **Step 1: Execute Phase 2 Task 6 test-first**

Follow `2026-08-15-phase-2-canonical-reads.md`, Task 6. Add semantic landmarks,
skip-link behavior, focus restoration, responsive collapse, and reduced-motion
coverage before implementing the shell and styles.

Run:

```bash
pnpm test -- src/components/shell/app-shell.test.tsx
pnpm build
```

Expected: the shell test and build pass.

- [ ] **Step 2: Commit the accessible shell**

```bash
git add src/styles src/components/shell src/main.tsx src/app.tsx
git commit -m "feat: add accessible canonical chat shell" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 3: Execute Phase 2 Task 7 test-first**

Follow the Phase 2 plan, Task 7. Implement revision-time ordering, request
generation tie-breaking, page deduplication, bounded debounced search, abort of
obsolete search, grouping, selection preservation, and keyboard row
navigation.

Run:

```bash
pnpm test -- \
  src/lib/chat/cache-order.test.ts \
  src/components/sidebar/conversation-list.test.tsx
pnpm typecheck
```

Expected: all focused tests and typecheck pass.

- [ ] **Step 4: Execute Phase 2 Task 8 test-first**

Follow the Phase 2 plan, Task 8. Render canonical familiar identity, Markdown
with raw HTML disabled, code blocks, copy behavior, long content, and all
loading, empty, degraded, no-results, and in-memory offline states.

Run:

```bash
pnpm test -- src/components/thread/thread.test.tsx
pnpm typecheck
pnpm build
```

Expected: transcript tests, typecheck, and build pass.

- [ ] **Step 5: Replace the mock development demo**

After the canonical shell covers the development entry path, remove `src/demo/`
and any `?demo=chat` routing. Update `README.md` so development and production
both describe the real connection-gated Chat shell.

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: no imports or runtime paths refer to `src/demo/`, and all commands
pass.

- [ ] **Step 6: Commit canonical reads**

```bash
git add src README.md package.json pnpm-lock.yaml
git commit -m "feat: browse canonical familiar conversations" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 7: Run the Phase 2 Chat validation matrix**

```bash
pnpm lint
pnpm test -- \
  src/lib/chat \
  src/components/shell \
  src/components/sidebar \
  src/components/thread
pnpm typecheck
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: all commands pass.

## Task 7: Record Phase 2 Evidence and Stop at the Phase 2 Gate

**Files:** None.

- [ ] **Step 1: Append the standard evidence template**

Record the Phase 2 branch/worktree, tested counterpart SHA, changed files,
tests-first evidence, exact validation output, accessibility checks, absence of
browser canonical persistence, and commit state in `cave-ff3j6`.

- [ ] **Step 2: Confirm Phase 3 is still gated**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd show cave-8ywi2
bd ready --json --limit 0 |
  jq '[.[] | select(.id == "cave-p4ilm")]'
```

Expected until the cross-repository Phase 2 gate closes: `[]`.

## Task 8: Claim and Isolate Phase 3

**Files:** None.

- [ ] **Step 1: Wait for Phase 3 readiness**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd ready --json --limit 0 |
  jq -e '.[] | select(.id == "cave-p4ilm")'
```

Expected: success only after `cave-8ywi2` closes.

- [ ] **Step 2: Rebase main, claim, and create the worktree**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat
git switch main
git fetch origin
git rebase origin/main

cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd update cave-p4ilm --claim

cd /Users/buns/Documents/GitHub/OpenCoven/chat
git worktree add \
  .worktrees/cave-p4ilm-send-recovery \
  -b cave-p4ilm-send-recovery \
  origin/main
git -C .worktrees/cave-p4ilm-send-recovery rebase origin/main
```

Expected: a clean claimed Phase 3 worktree.

## Task 9: Implement Phase 3 Create, Send, Stream, and Recovery

**Files:** Phase 3 paths in the File Map.

- [ ] **Step 1: Execute Phase 3 Task 6 test-first**

Follow `2026-08-15-phase-3-send-stream-recovery.md`, Task 6. Implement canonical
conversation creation, explicit send/stop/retry actions, command projection,
offline-disabled writes, and encrypted native drafts.

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml secure_store
cargo test --manifest-path src-tauri/Cargo.toml drafts
pnpm test -- \
  src/components/thread/new-conversation.test.tsx \
  src/components/thread/composer.test.tsx \
  src/lib/chat/draft-store.test.ts \
  src/lib/chat/slash-commands.test.ts
```

Expected: all native and webview focused tests pass.

- [ ] **Step 2: Commit conversation and composer behavior**

```bash
git add src/components/thread src/lib/chat/draft-store* \
  src/lib/chat/slash-commands* src-tauri/src/secure_store.rs \
  src-tauri/src/drafts.rs src-tauri/Cargo.toml src-tauri/src/lib.rs
git commit -m "feat: create canonical conversations" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 3: Execute Phase 3 Task 7 test-first**

Follow the Phase 3 plan, Task 7. Implement monotonic event reduction, duplicate
suppression, cursor checkpointing, conflict attachment, bounded reconnect,
partial-output preservation, terminal reconciliation, and the invariant that a
send is never automatically re-posted.

Run:

```bash
pnpm test -- \
  src/lib/chat/stream-reducer.test.ts \
  src/lib/chat/stream-controller.test.ts
pnpm test -- src/lib/chat src/components/thread
pnpm typecheck
pnpm build
```

Expected: all focused and aggregate Chat messaging gates pass.

- [ ] **Step 4: Commit stream recovery**

```bash
git add src/lib/chat/stream-* src/components/thread
git commit -m "feat: send and resume familiar messages" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 5: Execute Phase 3 Task 8 test-first**

Follow the Phase 3 plan, Task 8. Create the `0.1.0` owner-adjacent Rust client
with fixed client-v1 operations, capped bodies and frames, redirects disabled,
numeric SSE IDs, abort handling, additive-field compatibility, and no arbitrary
request API.

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: the crate conformance tests and Tauri integration pass.

- [ ] **Step 6: Commit the native client extraction**

```bash
git add src-tauri
git commit -m "refactor: extract native Cave client crate" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 7: Run the Phase 3 Chat validation matrix**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
pnpm lint
pnpm test -- src/lib/chat src/components/thread
pnpm typecheck
pnpm build
```

Expected: all commands pass.

## Task 10: Record Phase 3 Evidence

**Files:** None.

- [ ] **Step 1: Inspect the completed branch**

```bash
git status --short --branch
git rev-parse HEAD
git diff origin/main...HEAD --stat
```

Expected: clean status and Phase 3-only changes.

- [ ] **Step 2: Append Beads evidence**

Record counterpart SHAs, changed files, tests added first, exact passing
commands, secret-safety review, idempotency/recovery evidence, live-authority
evidence status, and commit/push state in `cave-p4ilm`.

- [ ] **Step 3: Leave cross-repository closure to its owning gates**

Do not close `cave-ixa2o` or `cave-e1kfa` from Chat unit-test evidence. Those
beads require the real-authority send, resume, restart, and reconciliation
journeys defined in the Phase 3 plan.
