# Delivery roadmap and consolidation audit

Audited 2026-09-07 against Chat `origin/main` at
`c4332b07969966fbf1d5fbfb0ea7231b896a8fc6`. This is a dated delivery snapshot;
refresh GitHub runs and branch heads before acting on it.

The [program register](superpowers/plans/2026-08-15-opencoven-chat-program-tracking.md)
remains the Beads dependency index. Its initial counts and ready lanes describe
program creation, not verified current completion. No phase gate is closed by
this audit. GitHub Projects membership and current Beads state remain unverified.

## Delivery order

| Priority | Work | Current evidence | Completion requirement |
| --- | --- | --- | --- |
| 1 | Protected Phase 1 conformance | [Main run 34074618490](https://github.com/OpenCoven/chat/actions/runs/34074618490): macOS succeeded; Linux and Windows failed; validation, attestation, and aggregation skipped | Successful frozen three-platform real-authority records, validation, attestation, and aggregation; record exact revisions in the phase gate |
| 2 | Disconnected familiar reads | [PR #138](https://github.com/OpenCoven/chat/pull/138), draft at `f3962b4`; [CI passed](https://github.com/OpenCoven/chat/actions/runs/34074123879); [issue #90](https://github.com/OpenCoven/chat/issues/90) remains open | Review regression coverage, finish PR review and delivery, verify issue closure after merge |
| 3 | Familiar contract and analytics source | [PR #86](https://github.com/OpenCoven/chat/pull/86), parked draft at `e5aeec8`; PR reports SDK release and lock re-pin dependencies | Verify current producer release readiness, consume verified packed artifacts, re-pin canaries, pass native and real-authority checks before delivery |
| 4 | Tracking reconciliation | [Familiars plan](superpowers/plans/2026-09-02-familiars-integration.md) and program register contain unchecked/historical work | Reconcile each deliverable with merged code and acceptance evidence; update Beads and the actual linked GitHub Project without inventing completion |

Normal [main CI](https://github.com/OpenCoven/chat/actions/runs/34074060314)
passed at the audited revision. It does not establish protected conformance or
release readiness. The applicable workflow is
[client-v1-conformance.yml](../.github/workflows/client-v1-conformance.yml), with
its evidence contract in [phase1-conformance.md](phase1-conformance.md).

## Local branch and worktree disposition

The initial inventory contained 10 worktrees, including the primary checkout.
One clean secondary worktree, `protected-local-clone-safe-directory`, was
removed after its exact tip `0215d18` was proven reachable from refreshed
`origin/main`. Its local branch was deleted with `git branch -d`.

| Branch | Disposition and next action |
| --- | --- |
| `fix/protected-matrix-v15` | Preserve active work: five commits beyond audited main, modified documentation/test files, and a live heavy-test process observed during audit. Recover terminal test evidence and review the exact final diff before committing or publishing. |
| `feat/familiars-source-stage1` | Preserve for PR #86 and its release dependency. |
| `fix/issue-90-disconnected-copy` | Preserve for PR #138 until delivered. |
| `fix/protected-cleanup-diagnostics-v10` | All branch patches have equivalents in main according to `git cherry`; exact tip is not an ancestor. Preserve ref pending final-tree reconciliation and safe deletion eligibility. |
| `fix/rebind-merged-conformance-authority` | All branch patches have equivalents in main according to `git cherry`; exact tip is not an ancestor. Preserve ref pending final-tree reconciliation and safe deletion eligibility. |
| `fix/protected-root-fixes-v12` | [PR #134](https://github.com/OpenCoven/chat/pull/134) closed without merge; seven patches lack equivalents in main. Reconcile against later protected-checkout fixes before retirement. |
| `fix/protected-conformance-runtime-followup` | Three patches lack equivalents in main; missing upstream is insufficient retirement evidence. |
| `fix/phase1-diagnostic-collapse` | Four patches lack equivalents in main; review final behavior and authority pins before retirement. |
| `fix/direct-protected-cave-build` | No checkout; three patches lack equivalents in main. Compare with delivered PR #119 before retirement. |
| `fix/direct-protected-cave-build-final` | No checkout; one patch lacks an equivalent in main. Review the authority pin before retirement. |
| `chore/clean-release-warnings` | No checkout; three patches lack equivalents in main. Reconcile release warnings and familiar empty-state behavior before retirement. |

Patch equivalence is a triage signal, not proof that later main changes retain
the behavior. No dirty checkout, unmerged branch, or remote branch was deleted.
The documentation branch for this audit uses the primary checkout and adds no
worktree. The minimum remaining checkout set is not yet proven: active and
unreconciled work must be resolved first.

## Audit follow-through

- Recover v15 test results from the existing process; do not start another run
  merely because its output is temporarily unavailable.
- Review final diffs of older branches against their replacement PRs, including
  workflow authority and lockfile changes. Preserve unique work before cleanup.
- Revalidate clean status, branch identity, reachability, and process ownership
  immediately before each additional worktree removal.
- Refresh the canonical Beads program graph and map its open work to the
  actual GitHub Project. The repository Projects REST request returned 404;
  that does not prove no organization Project exists.
- Keep roadmap links, phase plans, PR descriptions, and workflow evidence
  consistent as each item lands. Do not close a gate from unit tests alone.
