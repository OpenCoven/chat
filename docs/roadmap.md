# Delivery roadmap and consolidation audit

## Image rollout and observation checkpoint, 2026-09-09 UTC

This checkpoint supersedes the active PR, validation, and checkout dispositions
in the older snapshots below. Chat producer
`4cf28daa3017e683ccce76b42c3590919b984c90` is bound by SDK validator
`ac63ef1968c84e2ec1e4ded3356f66579b7b9156`. Both the repository and protected
environment validator variables match that SDK revision. Protected
[run 34395004109](https://github.com/OpenCoven/chat/actions/runs/34395004109)
had completed its Windows supervisor build and was running all three platform
jobs at this audit. It is not accepted release evidence yet.

| Boundary | Verified disposition | Remaining acceptance |
| --- | --- | --- |
| Windows image rollout | [Chat #180](https://github.com/OpenCoven/chat/pull/180) refreshed the image fingerprint; [#181](https://github.com/OpenCoven/chat/pull/181) accepts the two reviewed image/Visual Studio pairs and rejects unknown or crossed pairs. Both pairs match immutable upstream manifests. | A complete protected Windows result, including the workload after image validation. |
| Toolchain and storage | [Chat #183](https://github.com/OpenCoven/chat/pull/183) preserves the resolved Cargo path. [#184](https://github.com/OpenCoven/chat/pull/184) bounds Coven build storage, [#185](https://github.com/OpenCoven/chat/pull/185) scopes Windows disk errno classification, and [#186](https://github.com/OpenCoven/chat/pull/186) releases the completed Coven target before observations and adds bounded observation substages. | Confirm the full workload in the current protected attempt. A wrapper exit code or stage label alone does not identify a root cause. |
| Portable observations and production identity | [SDK #186](https://github.com/OpenCoven/sdk/pull/186), reviewed at `987b885eb05a704434ec24a54a9dd63955f16ec0`, includes both fixture portability changes and production Cave handling of Windows file IDs outside JavaScript's safe integer range. Native path/opened-file identity proof remains required. Its description now reflects that production scope. | Review the changed trust behavior, freeze corrected source and package artifacts, compute fresh fingerprints, and update producer/validator bindings. The prior runtime fingerprint is not proof of the changed source. |
| Local conversation wording | [Chat #182](https://github.com/OpenCoven/chat/pull/182) labels writable local chat accurately. Follow-up `0688d1856196308da48df08d2035eea7d9dac879` fixes the unsupported Testing Library role-query option. Typecheck, Biome, and all six app tests passed locally. | Fresh PR CI and reviewed integration. This wording change does not add familiar replies or remote writes. |

Protected [run 34366415938](https://github.com/OpenCoven/chat/actions/runs/34366415938)
and [run 34386769165](https://github.com/OpenCoven/chat/actions/runs/34386769165)
each passed Darwin and Linux but failed Windows; validation, attestation, and
aggregation were skipped. Retain their exact producer/validator identities.
Do not combine their platform records, or substitute the newer validator
variables for the identity recorded by an earlier attempt.

The frozen SDK candidate remains `6526b56b30c9a9c1c072caf2f0022d3427ae18db`;
it does not contain the pending SDK #186 changes. Publication stays disabled,
and the final release gate `cave-ilh1h` remains blocked.

The completed #175 diagnostic checkout was retired after verifying clean state,
main ancestry, no lock, and no observed process references. Its branch history
is retained. Active repair and feature checkouts, the primary checkout, and
dirty recovery work remain preserved. The minimum working set is not yet
established; the older checkout counts are historical snapshots.

A fresh canonical inventory still contains 68 Beads: 30 closed, one open, and
37 blocked. The previously prepared 21-card text correction and dirty Unix
checkout discard decisions remain pending. No additional Teamwork cards,
board Status fields, or release gates were changed by this checkpoint.

## Current validation and tracking checkpoint, 2026-09-09 UTC

This checkpoint supersedes the pending PRs and worktree counts in earlier
snapshots. The protected evidence below was collected for Chat
`523b49f4e7e512c467483fc4373844dea6c2d077`. The subsequent quota-path repair
[#174](https://github.com/OpenCoven/chat/pull/174) merged at
`09e1b5d33c959be0bece9f8ebf75d7a27945caea`; that changed producer still needs
its own validator binding and protected acceptance.

- [Chat #171](https://github.com/OpenCoven/chat/pull/171) aligned the frozen
  consumer Cave revision with the portable canonical-ID backport. The prior
  three-platform failure occurred before Cave production and does not establish
  whether the repaired assertion passes.
- [Chat #160](https://github.com/OpenCoven/chat/pull/160) merged Vitest 4.1.11
  after applicable CI passed on the refreshed branch.
- [SDK #172](https://github.com/OpenCoven/sdk/pull/172) binds the validator to
  that exact Chat commit. Protected
  [run 34345365355](https://github.com/OpenCoven/chat/actions/runs/34345365355)
  uses validator `711ee26ad817e6bfefb4245da1cfb01cce829872`. The Windows
  supervisor build passed. Linux
  [job 102446252647](https://github.com/OpenCoven/chat/actions/runs/34345365355/job/102446252647)
  passed all 110 Cave, 46 SDK, and 41 Chat assertions with unique IDs and zero
  skips. The repaired `reads.messages-canonical-conversation-id` assertion passed.
  Retained evidence reports both redaction scans passed; downloaded artifact
  SHA-256 matches the upload receipt
  `4b6d2acb5f5eff4bacbfdf20aae98c9cb1a69f0e77b232b1f424d34fbdcd80bb`.
  macOS [job 102446252660](https://github.com/OpenCoven/chat/actions/runs/34345365355/job/102446252660)
  failed with `phase1.packaging.cave-build.phase.next-build.compile.plugin`
  before Cave record assertions. The exact plugin/evaluation cause is unknown.
  Windows [job 102446252710](https://github.com/OpenCoven/chat/actions/runs/34345365355/job/102446252710)
  exceeded the 12 GiB `bootstrap aggregate` directory quota; the responsible
  subtree is not identified. The next investigation requires bounded diagnostics,
  without increasing limits or changing dependency policy. Validation,
  attestation, and aggregation were skipped, so release acceptance remains blocked.
- [Chat #86](https://github.com/OpenCoven/chat/pull/86) remains the parked
  familiar feature draft. [SDK #38](https://github.com/OpenCoven/sdk/issues/38)
  remains open; publishing is disabled and the aggregate evidence record is unset.

The runtime/feature inventory retains five Chat checkouts: the primary checkout, `canary-portable-cave`,
`familiars-source-stage1`, `frozen-consumer-portable-cave`, and
`unix-producer-exit-status`. Preserve the active validation checkouts, the
parked feature, the alternate candidate's unique test changes, and the dirty
Unix diagnostic checkout. The latter has verified backups, but discarding its
superseded edits still requires the pending decision. No dirty work was removed.
Before this documentation branch, the inventory held 17 local branches.
The follow-up inventory observed 10 registered Chat checkouts: the five
preserved baseline checkouts, three review checkouts for #173–#175, and the
concurrent `final-platform-blockers-v3` and `windows-quota-accounting` repairs.
Preserve those active repairs; their owning work has not been retired.
Historical refs preserve divergent commit
identities; reviewed runtime and diagnostic changes are already represented on
main. The minimum working set is not yet established.

PR #175 integrates the quota-path change and this documentation with bounded
Cave plugin exception diagnostics. Preserve the pinned behavior commit in its
merge ancestry. Separately dispatched protected
[run 34347190840](https://github.com/OpenCoven/chat/actions/runs/34347190840)
remained active on the preceding Chat `523b49f` at this checkpoint. Its result
cannot qualify changes introduced by the follow-up PRs.

The canonical `program:chat-v1` inventory contains 68 Beads: 30 closed, one
open, and 37 blocked. The linked program index retains its 57-record creation baseline. Teamwork reconciliation found 21 existing cards with
stale status text. Corrected draft payloads are prepared; the additional write
scope remains pending. Six blocked records use `until` dependencies, which
must remain visible alongside `blocks` dependencies in the projection.

A separate board-field audit found nine closed Beads displayed as Todo or
Started, and blocked `cave-o8gc4` displayed as Done. Card text and the board's
Status field require separate verification. Fourteen closed Beads have no
identity-marker or exact-title match among the 609 returned project items;
archived-item completeness is unproven, so this does not authorize duplicate
cards. No additional cards or board fields were changed by this audit.

The external `chat-consolidation-20260907` recovery set retains the operation
receipts, exact branch dispositions, dirty-state backups, prepared card
corrections, and board-field audit. The program root `cave-k0aqq` and final gate
`cave-ilh1h` remain blocked. Historical phase acceptance does not close the
current protected release gate.

## Platform repair and consolidation checkpoint, 2026-09-09 UTC

This checkpoint supersedes the earlier delivery snapshots below. It was audited
against Chat main `79eab77884245b4f34d8a14b5e1c8cea78b6dabe` after
[#168](https://github.com/OpenCoven/chat/pull/168) and
[#169](https://github.com/OpenCoven/chat/pull/169) merged.

| Work | Verified evidence | Remaining acceptance |
| --- | --- | --- |
| Linux failure classification | Protected [run 34335249644](https://github.com/OpenCoven/chat/actions/runs/34335249644/job/102414260606) emitted `phase1.stage.evidence-authority.build.cave-record.assertions.result`. Record identity, timing, and assertion count passed before that check. | Obtain successful real-authority evidence with the repaired Cave source. |
| Portable canonical conversation ID assertion | Frozen Cave source recorded `skip` for `reads.messages-canonical-conversation-id` when the mixed-case `BRANCHED` lookup returned 404. [Cave #5348](https://github.com/OpenCoven/coven-cave/pull/5348) replaces the filesystem-dependent lookup with a non-case-only alias. Chat pins backport `d20d83c46ba0c32433ce8dc6a358fb14b6bd0e45`; a fresh local run of `node --test scripts/client-v1-conformance.test.mjs` passed all 75 tests with zero skips. | All 110 recorded Cave assertions must pass in protected production. Unit tests do not satisfy this gate. |
| Windows and producer integration | Chat [#166](https://github.com/OpenCoven/chat/pull/166), [#167](https://github.com/OpenCoven/chat/pull/167), [#168](https://github.com/OpenCoven/chat/pull/168), and [#169](https://github.com/OpenCoven/chat/pull/169) merged the pinned pnpm routing and parent PowerShell scope correction with the diagnostic work. | Validate the complete producer in the protected Windows lane. Resource limits, global pnpm installation, and dependency policy were not changed to mask these failures. |
| Exact validator binding | [SDK #170](https://github.com/OpenCoven/sdk/pull/170) merged the binding to Chat `79eab77884245b4f34d8a14b5e1c8cea78b6dabe`. Protected [run 34341625053](https://github.com/OpenCoven/chat/actions/runs/34341625053) at the preceding head `d57677c` was canceled. | The SDK #170 owner dispatched [run 34342544626](https://github.com/OpenCoven/chat/actions/runs/34342544626) at that exact Chat head; it was in progress at this checkpoint. Verify its validator revision, terminal three-platform results, validation, attestation, and aggregation. |
| Remaining Chat PRs | [#86](https://github.com/OpenCoven/chat/pull/86) remains a parked draft dependent on the SDK release. [#160](https://github.com/OpenCoven/chat/pull/160) proposes the Vitest patch update. | Audit #160 independently. Preserve #86 until its packed-artifact and release dependencies are satisfied. |
| Image proposal | [Run 34300089789](https://github.com/OpenCoven/chat/actions/runs/34300089789) passed image build and verification but failed the proposal job after the retry repair landed. [#149](https://github.com/OpenCoven/chat/issues/149) remains open. | Configure and verify the authorized workflow-write credential path, then produce the actual digest-update PR and obtain its CI. |
| Familiar delegation | [#154](https://github.com/OpenCoven/chat/issues/154) and [#155](https://github.com/OpenCoven/chat/issues/155) remain open. | Reconcile implementation and acceptance with those issue contracts before closure. |

The worktree inventory found 17 registered checkouts: 13 clean merged secondary
candidates, the primary checkout, parked #86, an unmerged platform-repair
checkout, and a dirty Unix diagnostic checkout. Four older diagnostic checkouts
were retired after fresh clean-status, exact-tip ancestry, lock, and process
reference checks: `evidence-authority-diagnostics`,
`evidence-build-diagnostic-propagation`, `toolchain-diagnostic-propagation`, and
`toolchain-diagnostics`. `git worktree remove` and `git branch -d` succeeded for
all four; their paths were verified absent. Their four remote branches were
subsequently deleted atomically with exact-tip leases and verified absent.
Every retired tip remains reachable from main.

A subsequent check retired detached `/private/tmp/opencoven-harness-55` and
`/private/tmp/opencoven-producer-714` after verifying clean state, main ancestry,
and no observed process references. Both paths are absent;
`audit/detached-retirement-platform-20260909.json` records the proof. Eleven
registered worktrees remained immediately after retirement. The active
`canary-portable-cave` repair then brought the live count to twelve. Recent platform-repair
checkouts stay available during protected validation; dirty and unmerged work
is preserved. The completed `cave-record-diagnostics` checkout was reused for
this documentation audit. The external `chat-consolidation-20260907` recovery
set holds `audit/platform-repair-refresh-20260909.json` and
`audit/diagnostic-retirement-platform-refresh-20260909.json` with the exact
inventory and local operation receipts.
`audit/diagnostic-remote-retirement-platform-20260909.json` records remote
retirement and read-back verification. The minimum working set is not yet proven.

The [program register](superpowers/plans/2026-08-15-opencoven-chat-program-tracking.md)
and existing [Teamwork mirrors](https://github.com/orgs/OpenCoven/projects/9)
remain the tracking entry points. The canonical program Bead `cave-k0aqq` now includes this checkpoint; read-back
verified the appended note and unchanged blocked status. REST inspection of the
three existing Teamwork mirrors confirmed that `cave-23nmv` and `cave-0prpu`
already show their historical closed acceptance. The `cave-k0aqq` draft card
was synchronized from the exact Beads source notes and verified through REST
read-back. Its identity, title, and project fields were unchanged; no new card
was created.
Preserve historical phase closures and keep the current protected release gate
open until its acceptance evidence exists.

### Protected Linux result after the checkpoint

Linux [job 102437406770](https://github.com/OpenCoven/chat/actions/runs/34342544626/job/102437406770)
failed with `phase1.packaging.frozen-consumer.authority.failed`. The frozen
consumer checks checkout identity before Cave production: the producer's
`phase1-conformance.lock.json` selects Cave `d20d83c`, while
`contract-canary.lock.json` still requires `bc310e9`.
`assertContractCanaryCheckoutHeads` rejects that mismatch. This run therefore
does not yet prove the portable Cave assertion repair passes in protected
production. Reconcile the reviewed Cave canary revision and verify its fixture
hashes before rebinding the producer and validator for another protected run.
The terminal Windows and macOS logs report the same bounded failure. All three
platform lanes failed; validation, attestation, and aggregation were skipped.

## Earlier delivery snapshot — 2026-09-09 UTC

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

### Worktree retirement follow-through

A subsequent ownership check found no live process working in or referencing
four clean merged checkouts: `protected-matrix-v16`, `repin-cave-v0.3.12`,
`windows-chat-history`, and detached `/private/tmp/chat-main-check`. Each exact
tip was revalidated as an ancestor of refreshed main immediately before
`git worktree remove`; all four paths were verified absent afterward.

The three named local branches were deleted with `git branch -d`. Their remote
branches were removed atomically with exact-tip leases, and a fresh remote
listing verified their absence. The maintainer-held recovery set outside this repository records these operations
in `merged-retirement-20260909.json` and
`merged-refs-retirement-20260909.json` within its audit directory. These are local
recovery receipts, not repository files. No force deletion was used.

At the earlier retirement checkpoint, three worktrees remained: main, parked
#86, and v17. The later minimum-checkout checkpoint below supersedes this count. Closed, unmerged #144 was superseded by merged #143, which retains full Chat
history instead of v17's additional shallow-checkout fetch. The current workflow suite passed 59 tests with 19 platform skips;
this is not Windows runtime or protected-matrix acceptance. At that checkpoint, V17's divergent historical authority pins were still
preserved in its branch and checkout; the later checkpoint records checkout
retirement and continued history preservation.

[Issue #149](https://github.com/OpenCoven/chat/issues/149) tracks the CI-image
proposal failure and retry defect. Read-only REST inspection on 2026-09-09 UTC returned no repository or
repository-accessible organization Actions secrets for the authenticated
maintainer. No `CI_IMAGE_BUMP_TOKEN` was visible in either listing at that time. The
image itself already built and passed its verification job. Repairing the
proposal requires both an authorized workflow-file write path and retry logic
that does not confuse an existing branch with a completed update and PR.

### Minimum checkout set and remaining gates

Final cleanup on 2026-09-09 UTC reduced the registered worktrees to two: the
primary checkout and parked PR #86. V17 was clean and had no observed process
ownership. After confirming its repair was superseded by merged #143, its exact
tip `d56e915` was preserved in both its local branch and the verified complete-history
`retired-v17-history.bundle`; only the redundant checkout was removed.
The external recovery set contains `v17-retirement-20260909.json` in its audit
directory, with the absence and retained-ref checks.

The delivered heads of #148, #150, and #151 were compared against their merge
commits for every changed path. Their obsolete remote branches were removed
with exact-tip leases after preserving full histories in
`merged-audit-and-image-repair.bundle`. Local divergent history remains intact;
no force-deletion was used. At this cleanup checkpoint, before the follow-up documentation PR, the remaining
remote branches were main, parked #86, the pre-existing SDK archive, and the
incomplete image proposal tracked in #149.

[#151](https://github.com/OpenCoven/chat/pull/151) delivered the image proposal
repair and credential documentation. Both
[PR CI](https://github.com/OpenCoven/chat/actions/runs/34299445667) and
[rebuilt-image verification](https://github.com/OpenCoven/chat/actions/runs/34299428063)
passed. Issue #149 remains open for credential setup and a successful live
proposal; the operator has been asked to configure the dedicated token.

Protected [run 34299665723](https://github.com/OpenCoven/chat/actions/runs/34299665723)
was verified waiting for named `client-v1-conformance` environment review at
head `dadef69`. The operator was asked to review that existing run; no replacement
was dispatched or approval supplied by this audit. Later documentation and
image-proposal repairs do not change its conformance workflow or pinned inputs.
This remains a pending run, not successful release evidence. PR #86 and the SDK
release remain gated by their actual acceptance requirements.

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
