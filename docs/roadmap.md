# Delivery roadmap and consolidation audit

## Current delivery snapshot — 2026-09-09 UTC

Verified against `origin/main` at `6fd7c620a4edab491fed2a4daf1e5b63e7e0927a`.
[Main CI passed](https://github.com/OpenCoven/chat/actions/runs/34295829482).
The September 7 audit below is retained as historical evidence; its pending
items and branch counts are superseded by this snapshot.

| Work | Verified state | Next action |
| --- | --- | --- |
| Disconnected familiar reads | [#138](https://github.com/OpenCoven/chat/pull/138) merged; [#90](https://github.com/OpenCoven/chat/issues/90) closed | Delivered |
| Protected diagnostics | [#140](https://github.com/OpenCoven/chat/pull/140) merged; its report-scan review was fixed in [#142](https://github.com/OpenCoven/chat/pull/142), verified on main, and resolved with evidence | Retain the corrected producer authority in subsequent validator bindings |
| Windows checkout and Cave authority | [#143](https://github.com/OpenCoven/chat/pull/143), [#145](https://github.com/OpenCoven/chat/pull/145), and [#146](https://github.com/OpenCoven/chat/pull/146) merged; [#144](https://github.com/OpenCoven/chat/pull/144) closed without merge | Audit the remaining v17 branch before retirement |
| Protected conformance | Latest dispatched [run 34091592534](https://github.com/OpenCoven/chat/actions/runs/34091592534) failed at historical head `ada542f`; no newer protected run was listed | Reconcile SDK validator and current producer pins, then obtain successful three-platform evidence and aggregation |
| Familiar contract and analytics | [#86](https://github.com/OpenCoven/chat/pull/86) is the only open Chat PR and remains draft | SDK `release.config.json` still has `publishingEnabled: false` and no aggregate record; satisfy release dependencies before consuming new artifacts |
| Scheduled CI image | [Run 34107998897](https://github.com/OpenCoven/chat/actions/runs/34107998897) built and verified the image; proposal job failed with HTTP 403, leaving `ci/image-digest-2c64789641a9` at its base commit | Repair the workflow-write authorization and retry logic: an existing branch currently causes an early successful exit without creating the missing update or PR |

The approved September 7 follow-through completed draft readiness for #138/#140
and synchronized the three existing Teamwork mirrors (`cave-k0aqq`,
`cave-23nmv`, `cave-0prpu`). The maintainer-held recovery set contains the
operation receipts and read-back verification. This records those completed
operations, not a claim that every project card is current today. A compatible
isolated Beads executable was built and used to append the audit note; the
global executable and database schema were not replaced.

Seven worktrees were registered in this refresh. All were clean:

- Primary checkout on main.
- `familiars-source-stage1`: preserve for draft #86.
- `protected-matrix-v17`: preserve; its tip is not an ancestor of main.
- `protected-matrix-v16`, `repin-cave-v0.3.12`, `windows-chat-history`, and
  detached `/private/tmp/chat-main-check`: exact tips are ancestors of main.
  These are retirement candidates, subject to fresh ownership checks and the
  operator's instruction to retain active worktrees.

No worktree was removed by this refresh. The machine-readable inventory is in
the maintainer-held `chat-consolidation-20260907` recovery set as
`audit/refresh-20260909.json`. Main CI and merged diagnostic repairs do not
establish protected release acceptance. The program remains incomplete.

## Historical audit — 2026-09-07

Audited 2026-09-07 against Chat `origin/main` at
`c4332b07969966fbf1d5fbfb0ea7231b896a8fc6`. This is a dated delivery snapshot;
refresh GitHub runs and branch heads before acting on it.

The [program register](superpowers/plans/2026-08-15-opencoven-chat-program-tracking.md)
remains the Beads dependency index. Its initial counts and ready lanes describe
program creation, not verified current completion. No phase gate is closed by
this audit. Current Beads and Project reconciliation findings appear below.

## Delivery order

| Priority | Work | Current evidence | Completion requirement |
| --- | --- | --- | --- |
| 1 | Protected three-platform conformance | [Main run 34074618490](https://github.com/OpenCoven/chat/actions/runs/34074618490): macOS succeeded; Linux and Windows failed; validation, attestation, and aggregation skipped | Successful frozen three-platform real-authority records, validation, attestation, and aggregation; record exact revisions in the applicable release gate |
| 2 | Disconnected familiar reads | [PR #138](https://github.com/OpenCoven/chat/pull/138), draft at `f3962b4`; [CI passed](https://github.com/OpenCoven/chat/actions/runs/34074123879); [issue #90](https://github.com/OpenCoven/chat/issues/90) remains open | Review regression coverage, finish PR review and delivery, verify issue closure after merge |
| 3 | Familiar contract and analytics source | [PR #86](https://github.com/OpenCoven/chat/pull/86), parked draft at `e5aeec8`; PR reports SDK release and lock re-pin dependencies | Verify current producer release readiness, consume verified packed artifacts, re-pin canaries, pass native and real-authority checks before delivery |
| 4 | Tracking reconciliation | [Familiars plan](superpowers/plans/2026-09-02-familiars-integration.md) and program register contain unchecked/historical work | Reconcile each deliverable with merged code and acceptance evidence; update Beads and the actual linked GitHub Project without inventing completion |

Normal [main CI](https://github.com/OpenCoven/chat/actions/runs/34074060314)
passed at the audited revision. It does not establish protected conformance or
release readiness. The applicable workflow is
[client-v1-conformance.yml](../.github/workflows/client-v1-conformance.yml), with
its evidence contract in [phase1-conformance.md](phase1-conformance.md).

## Beads and GitHub Project reconciliation

Chat program cards already live in the organization's
[Teamwork project](https://github.com/orgs/OpenCoven/projects/9). These are Beads
visibility mirrors, not independent GitHub issues. Preserve the draft-card
identity and regenerate their content from the authoritative Beads records.

Read-only database inspection on 2026-09-07 found:

| Record | Authoritative state | Mirror / documentation follow-up |
| --- | --- | --- |
| `cave-k0aqq` | Blocked on final release gate `cave-ilh1h`; updated September 5 | Its next-action note still refers to Phase 1 implementation; reconcile against current dependencies before claiming work |
| `cave-23nmv` | Closed August 29, with PRs #30/#31 and run `33250233035` recorded as historical acceptance | Teamwork item `232459304` still says blocked; synchronize from Beads |
| `cave-0prpu` | Closed August 29 with the historical 15/15 matrix recorded | Teamwork item `232459288` still says blocked; synchronize from Beads |

Historical Phase 1 closure explicitly leaves full three-OS authority evidence,
writes, and signed installers to later work. It does not establish success of
the current protected release matrix. Preserve historical acceptance while
tracking today's Linux/Windows failures against the release requirements.

The installed Beads executable understands schema v53 while the database is
v66. Inspection used `bd --readonly --ignore-schema-skew show`; no database
write or migration was attempted. Use a compatible executable for updates.
The repository Projects REST endpoint returned 404, but the organization
Projects V2 REST endpoint successfully located Teamwork. The 404 is not a
tracking blocker or evidence that no project exists.

The organization `.github` repository's profile was also inspected; it is a
general organization overview rather than Chat's delivery tracker. Keep this
roadmap and the existing Teamwork mirrors as the Chat tracking entry points.

## Local branch and worktree disposition

The initial inventory contained 10 worktrees, including the primary checkout.
One clean secondary worktree, `protected-local-clone-safe-directory`, was
removed after its exact tip `0215d18` was proven reachable from refreshed
`origin/main`. Its local branch was deleted with `git branch -d`.

A second clean checkout, `rebind-merged-conformance-authority`, was removed
after its complete Git tree `521e25ba538ddbbd01a8fe1f5b9a58eb90612948` matched
merged replacement `cfde9e854486221f61f0ee7f6a7ecf180184a525` exactly. Its
original commit `06bd063` remains preserved by its local branch. The clean `phase1-diagnostic-collapse` checkout was subsequently retired after
merge-tree inspection showed no functional changes beyond main: the remaining
conflicts are obsolete workflow, documentation, lock, and lock-test authority
bindings. Its original branch and commit `6b457fd` remain intact. The three superseded clean conformance checkouts were also removed after
checking their replacement behavior and confirming no process had them as its
working directory. Their exact tips remain in local branches. Four worktrees
remain: the primary checkout, PR #86, PR #138, and active v15 work.

| Branch | Disposition and next action |
| --- | --- |
| `fix/protected-matrix-v15` | Preserve active work: the branch advanced to `25b3bc6` during this audit, with test execution and further edits observed. Recover terminal test evidence and review the exact final diff before committing or publishing. |
| `feat/familiars-source-stage1` | Preserve for PR #86 and its release dependency. |
| `fix/issue-90-disconnected-copy` | Preserve for PR #138 until delivered. |
| `fix/protected-cleanup-diagnostics-v10` | Equivalent patch landed as `1b3021a`; main retains the cleanup categories and adds finer Unix lock diagnostics. Clean checkout removed; original branch retained. |
| `fix/rebind-merged-conformance-authority` | Complete checkout tree equals merged replacement `cfde9e8`; redundant checkout removed. Original local branch retained because its tip is not an ancestor of main. |
| `fix/protected-root-fixes-v12` | [PR #134](https://github.com/OpenCoven/chat/pull/134) closed without merge; seven patches lack equivalents in main. The old native-lock creation was superseded by supervisor provisioning (`b82c0ef`) and validated projection (`3f4f3a0`); main also normalizes Git null paths. Clean checkout and local/remote branches retired; exact tip `977e016` is preserved in the verified warning/root bundle for historical test and authority bindings. |
| `fix/protected-conformance-runtime-followup` | Main retains the curated checkout environment and adds source-directory trust and protected tag handling. Supervisor and producer merge results add no changes to main. Clean checkout removed; original branch retained. |
| `fix/phase1-diagnostic-collapse` | Functional changes already incorporated in main; clean checkout removed. Original branch retained because obsolete authority bindings prevent an ancestry-based deletion. |
| `fix/direct-protected-cave-build` | No checkout; three patches lack equivalents in main. Compare with delivered PR #119 before retirement. |
| `fix/direct-protected-cave-build-final` | No checkout; one patch lacks an equivalent in main. Review the authority pin before retirement. |
| `chore/clean-release-warnings` | Local branch deleted with `git branch -d`: its clean merge result equals main tree `49d85359d73f00a3dad46c31187b0cb8f096ff6f`. Original tip `5f4b99a` is preserved in the verified warning/root bundle; the redundant remote branch was retired. |

Patch equivalence is a triage signal, not proof that later main changes retain
the behavior. No dirty checkout or unique commit was discarded. Retired divergent remote
refs were preserved in verified complete-history bundles before deletion.
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
- Refresh the canonical Beads program graph with a compatible executable,
  reconcile obsolete next-action notes, and synchronize the existing Teamwork
  draft cards from their source records.
- Keep roadmap links, phase plans, PR descriptions, and workflow evidence
  consistent as each item lands. Do not close a gate from unit tests alone.

## Remote branch closeout

The roadmap audit landed through [PR #139](https://github.com/OpenCoven/chat/pull/139)
at `ded69f2`, after Web checks and Contract canary passed in
[run 34088141426](https://github.com/OpenCoven/chat/actions/runs/34088141426).

The follow-up cleanup removed 21 remote branches whose exact tips were already
reachable from main, plus five superseded branches after preserving their full
histories in verified bundles. The roadmap PR branch was also removed. Every
remote deletion was verified against a fresh remote listing; batch deletions
used exact-tip leases to reject concurrent changes.

Remaining remote branches:

- `main`.
- `feat/familiars-source-stage1`: draft PR #86, blocked on the SDK release.
- `fix/issue-90-disconnected-copy`: draft PR #138; focused tests, typecheck,
  formatting, and applicable CI passed at `f3962b4`.
- `fix/protected-matrix-v15`: [draft PR #140](https://github.com/OpenCoven/chat/pull/140),
  active conformance work; preserve its checkout and revalidate terminal CI.
- `archive/sdk-integration-1140717`: an existing archive, retained deliberately.

Maintainer-held recovery set `chat-consolidation-20260907`, stored outside the
repository, contains the following archives. Its exact location and restore
commands are recorded in the maintainer's local `RESTORE.md`:

- `retired-authority-branches.bundle`: quarantine-authority, CI-gating, and
  Windows-supervisor histories.
- `retired-warning-and-root-branches.bundle`: release-warning and protected-root
  histories, including their exact remote tips.
- Matching JSON manifests, bundle verification receipts, and `audit/` inventories.

Use `git bundle list-heads <bundle>` to inspect preserved refs, then fetch the
chosen ref into a new `restored/` branch. Keep these archives until the historical
work and retention requirements are explicitly resolved. Remaining local
conformance refs have no checkout and preserve divergent authority history;
they were not force-deleted to satisfy a branch-count target.

Delivery remains incomplete: draft PR readiness, Teamwork mirror synchronization,
a compatible Beads write path, protected release conformance, and the SDK release
must still be resolved. Local cleanup is not proof of program completion.
