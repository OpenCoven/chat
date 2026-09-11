# Delivery roadmap and consolidation audit

## Consolidation checkpoint, 2026-09-11 20:05 UTC

Chat [#221](https://github.com/OpenCoven/chat/pull/221) landed as
`0c7bcc2032691c91a98b1e1326d0dc0b4b6781a6`, preserving frozen executable harness
`eda879fa0da04e76289fa977e3e853d9d8696df7`. All ten checks in
[run 34638791505](https://github.com/OpenCoven/chat/actions/runs/34638791505)
passed at the exact PR head; the verified merge retains its tree. Native tests
proved isolated quota reads, byte enforcement, post-disable accounting, private
ACL preservation, disposal behavior, cleanup and the Windows E2E journey.
The earlier intermittent process-termination failure did not recur and remains
unclassified. No process-termination acceptance rule was relaxed.

Chat [#223](https://github.com/OpenCoven/chat/pull/223) delivered extended-path
cleanup and bounded delete context, integrated into #221's tested source.
Chat [#214](https://github.com/OpenCoven/chat/pull/214) also landed. Parked
[#86](https://github.com/OpenCoven/chat/pull/86) remains dependent on SDK 0.1.

SDK [#205](https://github.com/OpenCoven/sdk/pull/205) landed as
`e80625940db64969865a26cb3b17ef50fb341aa8`, binding the exact Chat merge,
workflow, bootstrap hashes and fixtures. Full local verification passed
1,513 tests with two skipped, plus coverage, stress tests and lint. Independent
review checked the merged Git objects; exact-head CI passed. Both repository
and protected-environment validator scopes were rotated and read back to this
revision.

Fresh protected [run 34641974164](https://github.com/OpenCoven/chat/actions/runs/34641974164)
uses these exact revisions. The frozen supervisor build passed, the environment
was approved after scope rechecks, and all three platform jobs started.
Platform records and aggregate acceptance are still pending. Prior successful
Unix records do not establish acceptance for this new binding.

Chat #219, SDK #38 and the final release gate remain open pending the relevant
protected evidence. Chat #211's review-thread disposition remains unverified;
Chat #206 still requires causal process-identity evidence. Beads and the
authorized Teamwork root record the current delivery and remaining gates.

The 19:36 UTC inventory recorded 23 Chat and 25 SDK worktree registrations,
including seven dirty checkouts and one missing temporary Chat checkout.
These are inventory facts, not retirement proof. Active, dirty and
ownership-uncertain worktrees remain preserved; no worktree was removed or
reset during these landings. The minimum working set is not yet established.

## Historical consolidation checkpoint, 2026-09-11 UTC

This checkpoint supersedes the pending landing and validation claims in the
historical snapshots below. The latest terminal protected attempt is
[34611963297](https://github.com/OpenCoven/chat/actions/runs/34611963297), using
Chat producer `37e6984d83835f8994392d35d28fc98813746716` and SDK validator
`7f53b74c1c2be2719c87a1c0592d1c13a6a641cf`. Both validator scopes matched that
revision. Linux and macOS passed; each retained record passed independent ZIP
digest, SDK parser/scanner, exact source identity, Cave timing, and ordered
110 Cave / 46 SDK / 41 Chat assertion checks.

Windows failed with bounded quota-monitor context:

```text
access-denied; root=harness-execution-aggregate; operation=directory-enumeration
```

Cleanup separately reported
`root-delete:win32-3,root-survived:invalid-operation`. Artifact validation,
attestation, and aggregation were skipped. This establishes neither quota
exhaustion nor the identity of the denied descendant.

| Work | Delivered evidence | Remaining work |
| --- | --- | --- |
| Frozen Linux backport adoption | Chat #210 and the prepared #207–#209 follow-ups landed. The production backport remains frozen at `0da8c4749f57e63601b29d66032f80c9bbac1cb5`; subsequent harness bindings retain the reviewed source ancestry. | [#188](https://github.com/OpenCoven/chat/issues/188) remains open for complete protected acceptance and advisory reconciliation. |
| Windows staging and diagnostics | Coven #988 and Chat #211 landed. Chat #216 adds bounded cleanup categories; #218 adds quota-root/operation context. All ten final #218 CI jobs passed, including native Windows tests. | Protected status-staging success remains unproven. [#219](https://github.com/OpenCoven/chat/issues/219) owns the quota enumeration repair and separate cleanup investigation. #211 review-thread disposition remains unverified. |
| Native quota reproduction | [#220](https://github.com/OpenCoven/chat/pull/220) landed as `e0d543217b50d47d1c2b3d552adf9bb3df068dd0`. All ten CI checks passed; the native fixture reproduced terminal/background denial, passed readable/overflow controls and restored/removed its fixture. See [the reproduction contract](windows-quota-reproduction.md). | #219’s isolated-token accounting repair requires its own native execution, frozen-source/SDK rebinding and fresh protected acceptance. The exact protected descendant and separate cleanup failure remain unresolved. |
| SDK binding | [SDK #204](https://github.com/OpenCoven/sdk/pull/204) landed at `7f53b74c1c2be2719c87a1c0592d1c13a6a641cf`, binding the exact #218 producer/workflow/bootstrap bytes. Both scopes were rotated and read back before the protected attempt. | Rebind any subsequent governed source change. [SDK #38](https://github.com/OpenCoven/sdk/issues/38) and the final release gate remain open. |
| Process-identity investigation | Chat #207's bounded test-only diagnostics landed. | [#206](https://github.com/OpenCoven/chat/issues/206) still requires causal evidence; later successful jobs do not classify its original failure. |

Diagnostic [#217](https://github.com/OpenCoven/chat/issues/217) and Bead
`cave-k0aqq.1` are complete on verified protected root/operation disclosure.
Repair Bead `cave-k0aqq.2` is active. The root Bead `cave-k0aqq`, final gate
`cave-ilh1h`, and authorized Teamwork root retain the outstanding release work.

The branch audit inspected 32 previously unattached Chat/SDK branches: 21 have
exact trees retained by merged commits in fetched main. Two additional branches
have no unmatched non-merge patches; that is weaker than complete delivery
proof. SDK PR #90 already delivered the canonicalize change; its local repair
branch's older dependency lock is not missing implementation to restore.
Alternate and unmatched histories still need individual disposition.

No branches or worktrees were removed in this checkpoint. Exact-tree retention
does not establish retirement of active or reserved ownership. Preserve dirty,
active, and ambiguous work, including Chat #214 and parked #86. The minimum
working set remains unestablished. Machine-readable delivery, branch, and
protected-run receipts remain in the external
`chat-consolidation-20260907/audit` directory.

## Historical consolidation checkpoint, 2026-09-10 UTC

This checkpoint supersedes the pending repair and validation claims below.
The latest verified protected attempt is
[run 34441519622](https://github.com/OpenCoven/chat/actions/runs/34441519622),
using Chat `b7986d081db76d80b2d479d151ce9d0f503492d8` and SDK validator
`d1c9ddf2a7514e56fac26e20d571114ca97fe623`. The Linux and Darwin records each passed
all 110 Cave, 46 SDK, and 41 Chat assertions. Their identities, digests, timing
and scans were verified. Windows failed at
`phase1.runtime-observations.coven-rust-tests.status-replacement.assertion.writer-error.apply-owner-only-security.access-denied`.
Validation, attestation, and aggregation were skipped. These records do not
establish acceptance for subsequent source changes.

| Work | Delivered evidence | Remaining work |
| --- | --- | --- |
| Packaged authority | [Chat #203](https://github.com/OpenCoven/chat/pull/203) merged as `cfe8137c07307dfa19f926152a74da83afec49e5`; packaged CI passed after replacing invalid ancestry assumptions with exact independent authority verification and binding harness `c5445941750f5ac232a78f3d7c7dcecf91bd52bc`. | Retain these checks when adopting new frozen sources; ordinary packaged CI does not replace protected acceptance. |
| Linux GLib | [Chat #204](https://github.com/OpenCoven/chat/pull/204) delivered the maintained backport. [#209](https://github.com/OpenCoven/chat/pull/209) validated both frozen sources at `f21b27f`: native run `34498480972` passed 128 production and 158 harness tests, optimized builds, 11 iterator tests per entry, and source consistency. Published production `0da8c4749f57e63601b29d66032f80c9bbac1cb5` and harness `0207b93f4238017764e59eca4916e4c790561f77` contain the backport. [#210](https://github.com/OpenCoven/chat/pull/210) binds both sources; all ten jobs in [run 34504274365](https://github.com/OpenCoven/chat/actions/runs/34504274365) passed at `970fc31`, including packaged conformance and Windows native E2E. Eight vendor tampering cases were rejected. | [#188](https://github.com/OpenCoven/chat/issues/188) remains open. Complete review-thread resolution and merge #210 with an actual merge commit preserving both source ancestors; then rebind the SDK validator and both scopes, obtain fresh protected acceptance, and reconcile the advisory. Ordinary PR CI does not establish protected acceptance. |
| Windows status writer | [Chat #201](https://github.com/OpenCoven/chat/pull/201) merged as `7ca56c5c8c95fc1be4efecf22554cb4f3cc08e22`. Coven diagnostics distinguish requested from granted handle rights under the restricted directory. | [Coven #988](https://github.com/OpenCoven/coven/pull/988) remains draft at `093f278a9c868b78ed50591a83e1167f9f6250cd`: its 72 Windows tests pass, but the replacement fixture uses explicit alternate staging and does not prove the default path, trusted staging directory, safe replacement, or ownership-scoped cleanup. [#984](https://github.com/OpenCoven/coven/issues/984) remains open. |
| Windows process identity | [Chat #207](https://github.com/OpenCoven/chat/pull/207) adds bounded test-only observations for null WTS SIDs; it does not change supervisor acceptance. All ten jobs in [run 34462291567](https://github.com/OpenCoven/chat/actions/runs/34462291567) passed at `fe41e3f07cfe2e95908622d520c8533e2fb30597`, including native Windows diagnostic fixtures. | Complete review-thread resolution and landing. [#206](https://github.com/OpenCoven/chat/issues/206) still needs evidence explaining the original failure; a passing retry alone does not classify it. |
| Current validator configuration | [SDK #200](https://github.com/OpenCoven/sdk/pull/200) merged as `f431cf6a4a61183d95e40adf4b50d36d12f3292e`, binding Chat `7ca56c5`. Both repository and protected-environment scopes were rotated and read back to that SDK merge. This configuration postdates run `34441519622`, which used SDK #197 at `d1c9ddf`; the newer binding has no fresh protected acceptance. | Rebind any subsequent producer changes before a fresh protected run. [SDK #38](https://github.com/OpenCoven/sdk/issues/38) and the final release gate remain open; publishing remains disabled. |

The minimum working set is not yet established. Twelve previously reviewed
merged worktrees were clean and their tips reachable from main, but active or
reserved ownership remains unresolved. Preserve them until that distinction is
established, together with dirty recovery work, unique histories, and active
repair and feature worktrees. Historical counts below are not a current deletion
inventory. Chat and active worktrees remain preserved.

## Historical protected validation checkpoint, 2026-09-10 UTC

[Run 34435223248](https://github.com/OpenCoven/chat/actions/runs/34435223248),
attempt 1, used merged Chat #199 at `724690e64c4be820bdf4e0e1f8c568db516ba490`
and SDK #196 validator `a5c7e38ecc905a6fdb9c9a3e704c6395ec2df02a`. Both validator
scopes matched before protected approval. Coven daemon and observation source
was `705623e9cf2dfa9ee2d52973b2a6eb194a4cf7c4`, including Coven #982's test repair.
The frozen Chat native client remains at Coven `721437b8`.

Linux artifact `10136315804` and Darwin artifact `10136396539` were downloaded
and verified against this attempt: all 110 Cave, 46 SDK, and 41 Chat assertions
passed with matching identities, digests, timing, and clean scans. Windows failed
at `phase1.runtime-observations.coven-rust-tests.status-replacement.assertion.writer-error.access-denied`.
The OS code is now classified as 5, access denied; the failed operation remains
unknown. This supersedes the generic writer-error result from run `34431068139`.

[Coven #984](https://github.com/OpenCoven/coven/issues/984) and diagnostic
[PR #985](https://github.com/OpenCoven/coven/pull/985) add fixed operation labels.
Chat's matching classifier retains strict panic attribution and bounded public
categories. Updated source authority, workflow digests, and an SDK binding must
precede fresh protected validation. No security, privilege, resource-limit, or
dependency change is justified by the current result.

Coven #985 head `367e670a01379799d89b6802e1a00bea7a0e20ef` passed native
Windows CI, including the new failure-path tests. Its Linux retry passed in
[run 34437695364, attempt 2](https://github.com/OpenCoven/coven/actions/runs/34437695364/attempts/2).
The initial Linux failure was SQLite exit-persistence contention, tracked in
[Coven #986](https://github.com/OpenCoven/coven/issues/986); a passing retry does
not establish a persistence fix. Val merged #985 as
`c0c979cdee96327bf24218bc7c7ecb90d719cb27`; its tree matches the reviewed head.
These CI results do not replace protected conformance validation.

The run is terminal failed. Validation, attestation, and aggregation were skipped;
publishing remains disabled and [SDK #38](https://github.com/OpenCoven/sdk/issues/38)
remains open. SDK candidate `1597835325cf3762b51408ff0a565037eeb25f64` and all four
tarballs are unchanged. Chat and active worktrees remain preserved.

## Historical protected validation checkpoint, 2026-09-09 UTC

This checkpoint supersedes the pending PR and validation dispositions in the
older snapshots below. [Chat #191](https://github.com/OpenCoven/chat/pull/191)
merged at `3f2302da7dc2b39adb8042853b64aa58c406de08`.
[SDK #191](https://github.com/OpenCoven/sdk/pull/191) binds that producer at
`0d480eb72e00d5e0f915dbe0cb289ef12cbb9ebd`. Both the repository and protected
environment validator scopes were verified at that revision before
[run 34406621503](https://github.com/OpenCoven/chat/actions/runs/34406621503),
attempt 1.

| Boundary | Verified disposition | Remaining acceptance |
| --- | --- | --- |
| Image and frozen-source bootstrap | The two reviewed Windows image/Visual Studio pairs remain enforced. Chat #191 explicitly fetches frozen source `841a88f8885bc20cac2f9d5b5b6bc2a23a76e657` and preserves it for nested clones. The fresh Windows run passed bootstrap and reached runtime observations. | Full Windows conformance. |
| SDK candidate and observations | Candidate `1597835325cf3762b51408ff0a565037eeb25f64` and all four frozen tarballs remain unchanged. Windows completed the full selected SDK, Chat, and Chat Rust observation suites. | The Coven Rust observation stage failed; the specific test and failure category are unclassified in this run. Bounded diagnostics retain every selected test and existing limit. |
| Linux and macOS evidence | Both platform jobs passed all 110 Cave, 46 SDK, and 41 Chat assertions. Downloaded artifact digests, source identities, scans, and parsing with the committed SDK validator were verified. | One complete accepted attempt; do not mix records from earlier attempts. |
| Final release gate | Validation, attestation, and aggregation were skipped after the Windows failure. [SDK #38](https://github.com/OpenCoven/sdk/issues/38) remains open. | A subsequent verified producer binding and complete protected run. Publishing stays disabled and the aggregate record remains unset. |
| Familiar feature | [Chat #86](https://github.com/OpenCoven/chat/pull/86) remains parked. Local conversation wording is delivered by #182 and #187. | Familiar replies and remote writes remain separate feature acceptance. |

The SDK runtime fingerprint remains
`ba1b822d45e130579209f6da4fa11bdac775b0213c08ffb3af1838448207733f`.
Earlier run `34401360323` passed Linux/macOS but failed Windows at the frozen
Chat checkout. The new run passed that boundary and failed later at
`phase1.runtime-observations.coven-rust-tests.failed`. The stage label does not
justify raising resource limits, reinstalling pnpm globally, or removing tests.

[Chat #188](https://github.com/OpenCoven/chat/issues/188) tracks the native Linux
`glib::VariantStrIter` advisory. The dependency audit establishes `glib 0.18.5`
in Tauri's GTK/WebKit graph; compatible repair and native Linux validation
remain outstanding. Dependency presence alone does not prove API reachability.

Verified merged, unattached local refs for Chat #177, #181, and #189 and SDK
#168 and #181 were retired with `git branch -d`; their commits remain retained.
Active repair and feature worktrees, primary checkouts, and dirty recovery work
remain preserved. The minimum working set is not yet established. Worktree and
branch counts in earlier snapshots are historical.

The root Bead `cave-k0aqq` and final gate `cave-ilh1h` remain blocked. Beads and
the authorized Teamwork root carry the current evidence checkpoint. The prepared
21-card corrections, board Status reconciliation, and dirty Unix discard
remain pending. No additional card or board-field changes are implied by this
checkpoint. The external `chat-consolidation-20260907/audit` directory retains
exact merge, variable-rotation, run, artifact, and local-ref retirement receipts.

## Historical validation and tracking checkpoint, 2026-09-09 UTC

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
