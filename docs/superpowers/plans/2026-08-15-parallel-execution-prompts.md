# OpenCoven Chat v1 Parallel Execution Prompts

## Coordinator Prompt

Copy this prompt into the coordinating agent session:

```text
Execute the OpenCoven Chat v1 program from the centralized Cave Beads graph.

Program root: cave-k0aqq
Tracker repository: /Users/buns/Documents/GitHub/OpenCoven/coven-cave
Chat plans: /Users/buns/Documents/GitHub/OpenCoven/chat/docs/superpowers/plans
Tracking index: 2026-08-15-opencoven-chat-program-tracking.md

Rules:
1. Query `bd ready --json --limit 0` and select only open implementation beads
   carrying `program:chat-v1`. Ignore tracking epics as executable work.
2. Launch at most one worker per repository-owned lane:
   - Cave authority/API
   - Coven Rust client
   - TypeScript SDK/opencoven CLI
   - Chat native/frontend
   - Cross-repository E2E/conformance, only after its blockers close
3. Give every worker one explicit bead ID, its exact repository, the linked
   phase plan, complete acceptance criteria, and a bounded file ownership scope.
4. Require a dedicated ignored worktree named `<bead-id>-<short-slug>`.
   Preserve dirty main checkouts and unrelated changes.
5. Workers must atomically claim their bead, write focused failing tests before
   implementation, run repository-local gates, and append verification evidence
   to the bead. They must not close phase gates.
6. Do not allow overlapping files between concurrent workers. If two ready beads
   need the same files, serialize them and record the dependency.
7. Authority contracts and generated fixtures merge before dependent consumers.
   Consumers may scaffold concurrently but must not invent or hand-edit authority
   fixture bytes.
8. Do not push, merge, Dolt-push, publish, sign, or roll out automatically.
   Local commits are allowed only when the operator explicitly sets
   `ALLOW_LOCAL_COMMITS=true`.
9. Stop a worker that discovers authority-boundary drift, an undocumented
   required-field contract change, secret exposure, duplicate execution risk, or
   an unclean baseline. Surface the blocker instead of working around it.
10. After every worker reports, verify its stated commands, inspect its handoff,
    update Beads notes/status, and start the conformance bead only when every
    blocker is genuinely complete.

Required worker handoff:
- bead ID and final status
- repository, branch, and worktree
- files changed
- tests written first
- verification commands and results
- counterpart contract SHA/release
- security/secret findings
- commit/push state
- remaining blocker or next ready bead
```

## Phase 0 Parallel Launch Prompt

Use this prompt to start the currently ready lanes:

```text
Run Phase 0 of OpenCoven Chat v1 as four independent workers. Do not start the
cross-repository canary until all four handoffs pass review.

Lane A — Cave authority
- Bead: cave-g6x6k
- Repository: /Users/buns/Documents/GitHub/OpenCoven/coven-cave
- Plan: OpenCoven/chat/docs/superpowers/plans/2026-08-15-phase-0-baseline-contracts.md
- Scope: Client v1 contract types, stable envelopes, capability/limit constants,
  deterministic fixture exporter, focused tests, test wiring, and CI path rules.
- Do not expose routes or refactor unrelated private APIs.

Lane B — Coven Rust client
- Bead: cave-48uuf
- Repository: /Users/buns/Documents/GitHub/OpenCoven/coven
- Plan: OpenCoven/chat/docs/superpowers/plans/2026-08-15-phase-0-baseline-contracts.md
- Scope: extract health negotiation and structured daemon errors into
  crates/coven-client; compose coven-cli over it without behavior changes.
- Keep coven-agents independent.

Lane C — TypeScript SDK and developer CLI
- Bead: cave-o2bqs
- Repository: /Users/buns/Documents/GitHub/OpenCoven/sdk
- Plan: OpenCoven/chat/docs/superpowers/plans/2026-08-15-phase-0-baseline-contracts.md
- Scope: workspace/package scaffolds, declared exports, normalized errors,
  compatibility primitives, CLI help/JSON tests, packed-package checks, and
  compiling examples.
- Preserve existing @opencoven/cli, @opencoven/coven, and coven binary ownership.

Lane D — Chat native/frontend scaffold
- Bead: cave-5n20h
- Repository: /Users/buns/Documents/GitHub/OpenCoven/chat
- Plan: OpenCoven/chat/docs/superpowers/plans/2026-08-15-phase-0-baseline-contracts.md
- Scope: pinned React/Vite/Vitest/Playwright/Tauri scaffold, baseline scripts,
  app identity smoke, Rust command-registration smoke, and least-privilege
  capabilities.
- Consume Cave schemas only through @opencoven/cave-client.

For every lane:
1. Confirm the bead is ready, then claim it.
2. Create and report a dedicated ignored worktree.
3. Verify the repository baseline before editing. If it fails, stop and report.
4. Follow test-driven development and the exact phase-plan verification commands.
5. Do not touch another lane's repository or files.
6. Do not push, merge, publish, or close the Phase 0 gate.
7. Return the standard worker handoff.

After all four handoffs are accepted:
- Run cave-u0oli for the fixture/package conformance canary.
- Run cave-bt9wx only after the canary and all repository-local checks pass.
```

## Generic Later-Phase Fan-Out Prompt

Replace the bracketed fields from the tracking index and the selected phase plan:

```text
Execute OpenCoven Chat v1 Phase [N] from phase epic [PHASE_EPIC].

Precondition:
- Gate [PREVIOUS_GATE] is closed with evidence.
- `bd ready --json --limit 0` reports the selected implementation beads ready.

Start independent repository lanes:
- Cave: [CAVE_BEAD] — authority services/routes/fixtures only.
- Coven: [COVEN_BEAD or NONE] — coven.daemon.v1 Rust client only.
- SDK/CLI: [SDK_BEAD(S)] — public TypeScript packages and opencoven only.
- Chat: [CHAT_BEAD(S)] — Tauri/native/frontend only.

Use [PHASE_PLAN] as the plan of record. Include the full bead description and
acceptance criteria in each worker prompt. Workers must use dedicated worktrees,
claim exactly one bead, avoid overlapping files, write failing tests first, and
return the standard handoff. They may not push, merge, publish, or close gates.

When repository lanes pass review, start [CONFORMANCE_BEAD]. Its job is to run
the exact real-authority or packaged journeys from the phase plan, not mocked
proxies. Only after that evidence passes may the coordinator verify and close
[PHASE_GATE].

Merge/integration order:
1. Cave authority contract/capability
2. Coven authority client changes, when present
3. TypeScript/Rust public clients and CLI
4. Chat consumer behavior
5. Cross-repository E2E/conformance
6. Phase gate
```

## Worker Prompt Template

```text
Implement Bead [BEAD_ID] in [REPOSITORY].

Read first:
- `bd show [BEAD_ID]`
- [PHASE_PLAN]
- the repository's contributor/agent instructions

Bounded objective:
[PASTE THE BEAD DESCRIPTION, DELIVERABLES, AND ACCEPTANCE CRITERIA]

Execution requirements:
1. Verify the bead is ready and atomically claim it.
2. Create a dedicated ignored worktree named `[BEAD_ID]-[SLUG]`.
3. Run the smallest baseline checks that cover the target area before editing.
   Stop and report pre-existing failures.
4. Write focused failing tests before implementation.
5. Change only this bead's repository and declared file scope.
6. Reuse existing authority services and helpers; do not duplicate canonical
   state or bypass public contracts.
7. Preserve type safety and explicit errors. Never add plaintext secret storage,
   arbitrary transport/filesystem access, silent fallback, or automatic replay
   of ambiguous mutations.
8. Run the exact repository-local verification from the phase plan.
9. Append verification evidence and counterpart SHA/release to the bead.
10. Do not close a release gate, push, merge, publish, or Dolt-push.
    Do not create a local commit unless `ALLOW_LOCAL_COMMITS=true`.

Return only this handoff:
- Outcome
- Bead status
- Repository/branch/worktree
- Files changed
- Tests added first
- Verification results
- Counterpart contract SHA/release
- Security/secret review
- Commit/push state
- Blocker or next dependency
```

