# M0 mission integration: producer and release prerequisites

Checked 2026-10-22 against Chat `69e8901` and Coven
`06899efb7532da9e57a5096f59705a2b2d162ec4` (GitHub main and the clean sibling checkout).
Rechecked the same day against Coven main `418156e2787eb6fa52242f03f5bdd95f2a636fbf`:
the only producer changes since are delegation digests and journaling (#1536, #1537), plus
bootstrap CI and docs. `missions.rs` still settles every submit with
`AUTHORITY_UNAVAILABLE_REASON`, `runner.rs` still selects `BaseV1`, v0.4.10 is still the
latest release, and #1426/#1441/#1455/#1460/#1467/#1471/#1472 are all still open.
This is a continuation checkpoint for [Chat #155][chat], not acceptance of launching M0.

## Current evidence and decision

- [Coven's latest release][release] remains v0.4.10, published 2026-10-14. It predates
  missions. Chat's installer pin lives in `src-tauri/src/coven_install.rs`, including
  four platform archive names, sizes and SHA-256 values; changing only setup text is insufficient.
- [Coven #1313][contract] has merged mission submit/get/cancel, the CLI and vectors.
  `d4911138` (#1368) adds envelope advertisement and typed read refusals. These are
  necessary release contents, but do not establish launch authority.
- On the inspected producer commit, `execute_mission_submit` in
  `crates/coven-cli/src/automations/missions.rs` commits, then immediately settles the
  occurrence failed with `AUTHORITY_UNAVAILABLE_REASON`. Its projection returns
  `unavailable` / `authority_unavailable`. Production `runner.rs` still selects `BaseV1`.
  The implementation notes in `docs/architecture/coven-automations-missions.md` explicitly
  say no launch and no run/attempt receipt at this stage. Its earlier table's description
  of `r0-read.1` as launching is not evidence of an implemented launch path.
- [Coven #1308][proposal] merged as `6b84af6b`, but its scoped-read document still says
  **design for review, not implemented or certified**. The replacement descriptor must
  bind enforced scopes and isolated startup/context ingestion, not merely read-only tool names.
- The [#857 status review][authority] names mission scopes, the `r0-read.2` switch,
  trusted adapter, revocation-fenced responses and launched receipts as outstanding.
  Direct PR API reads confirmed #1426, #1441, #1455, #1460, #1467, #1471 and #1472
  are all open and unmerged. An approved design or an open implementation PR is not a release.
- No overlapping mission PR was open in Chat; the sole open PR was #476 (updater).

Keep the installer at 0.4.10 and Chat's existing `r0-read.1` binding unchanged.
Keep `update-coven`, `coven-not-ready`, and terminal authority-unavailable distinct.
Do not infer permission to launch from `missions envelopes` advertisement alone.
The production consumer calls the CLI; the SDK client is not executed by this path.

## Exact unblock conditions

1. **Coven Runtime Authority owners (#857):** merge the trusted scoped-read launch path,
   mission scope contract, replacement descriptor and admission proof for the exact harness
   version. Prove principal/familiar/revision/project/grant/fence binding, bounded reads,
   exclusion of ambient context, revocation and cancellation enforcement, and terminal evidence.
   Old `r0-read.1` observations must not be relabeled as proof for the replacement.
2. **Coven mission owners (#1313):** reconcile the normative mission contract, CLI wire shapes,
   advertised descriptor digest and vectors with that implemented path. Supply launching cases
   for M-07/M-10/M-12/M-13/M-14; preserve typed `NOT_FOUND`, replay and refusal semantics.
3. **Coven release maintainer (Val):** publish a release containing `d4911138` or its descendants
   plus the proven launching path. Record tag, commit, platform assets, sizes, checksums and
   exact harness admission evidence. A release with only today's missions is still no-launch.
4. **Chat integration owner:** verify the released executable in a scratch profile before
   updating installer assets/digests and both Rust/TypeScript envelope bindings. Decode only
   the released contract. Review any newly required scope input without granting authority in
   Chat. Preserve the approved [native storage design][storage].

## Consumer requirements to carry forward

Reuse `src-tauri/src/chat_missions.rs`, `chat_missions_tests.rs`, `src/lib/missions.ts`,
`src/coven/mission-panel.tsx` and their tests. Keep native-only adoption/cancel keys,
bounded inputs/outputs/watchers, same-key ambiguity reconciliation, restart recovery,
unreadable-store refusal and refusal to remove an active mission.

Exact project binding needs an explicit audit before claiming acceptance: `submit_payload`
canonicalizes the project and sends it to Coven, but `bound` currently compares mission id,
familiar root/revision and the learned principal only. The approved persisted record omits
project paths and task bodies; after restart it relies on the producer's immutable mission.
Prove that producer binding and test mismatched project/envelope responses; do not claim that
existing familiar/owner mismatch tests prove project isolation. If durable binding changes
are necessary, reconcile them with the storage design rather than silently persisting a path.

Follow-up source audit on the same producer commit found the concrete recovery binding:
`store.rs`'s `AUTOMATION_DEFINITIONS_SCHEMA_SQL` stores principal, familiar root/revision,
envelope id/digest, canonical project cwd and request digest together in `automation_missions`.
The `automation_missions_immutable` and `automation_missions_retained` triggers reject updates
and deletes. In `missions.rs`, `claim_in` inserts those fields, `mission_view` reads them by
mission id, and `adopted` rejects a replay with a different command or request digest.
This is source evidence for the intended producer invariant, not proof against a different
Coven home, a malformed CLI answer, or the eventual released launching implementation.

The existing consumer guards were inspected, not executed in this follow-up:

- `an_older_coven_is_never_sent_a_mission_command` asserts one version call and `update-coven`.
- `views_for_another_mission_familiar_or_owner_are_dropped` mutates mission id, root, revision
  and principal; it does not mutate project or envelope.
- `a_mission_coven_is_still_working_on_cannot_be_removed` retains running, reconciling and
  unreadable missions, then removes only after a completed answer.
- `keeps every mission field out of browser storage` exercises composing through the answer
  and checks localStorage/sessionStorage; it does not itself assert IndexedDB behavior.

These coverage boundaries must survive the release integration. Do not turn the test names
into a broader isolation or persistence claim than their assertions support.

The native `MissionResult` currently exposes outcome, settlement, observation, a report count
and usage. Inspect the released result/artifact contract before claiming that a diagnosis report
and artifact metadata are usable in the Missions UI.

Run focused mission tests, then the code-change checks in `CONTRIBUTING.md`. Check any changed
path against `phase1-conformance.lock.json`; a governed-file change follows the maintainer's
two-stage repin procedure after canonical merge. Keep protected conformance evidence separate.
This documentation checkpoint changes no governed producer bytes and requires no repin.

## Required acceptance evidence after unblock

Record exact packaged Chat, released Coven and selected harness revisions, scratch-profile
setup and authoritative observations. Prove a bounded diagnosis executes once, retains the
reviewed familiar/revision/project, exposes its result/usage, recovers across restart/reconnect,
and supports idempotent cancellation with terminal evidence. Test the complete #155 negative
matrix, especially live cancellation races (M-07), queued cancellation (M-08), ambiguous timeout
(M-10), revocation (M-12), expiry (M-13), and restart while running (M-14).

Also cover disconnection before/after submit, duplicate/replay mismatch, stale revision,
unsupported runtime/envelope, unavailable authority, late principal/familiar/project responses,
unreadable records and absence of task bodies in browser storage. No mock, no-launch receipt,
unit test or green CI substitutes for this packaged execution evidence. M1 exec, remote execution
and billing remain outside this M0 work.

## Verification and continuation

This pass read current GitHub issues/comments, release and PR state, matched producer main to
the clean local source, and inspected the existing consumer. The recheck then ran the
consumer's own guards: `cargo test --lib mission` passed 33 tests, including the old-Coven,
coven-not-ready, authority-unavailable, binding and active-removal cases above. One test was
ignored: `installed_coven_missions_round_trip`, which needs a daemon at or after coven#1368
and so cannot run against v0.4.10. `vitest run src/lib/missions.test.ts
src/coven/mission-panel.test.tsx` passed 17 tests. No packaged mission launches were performed. Documentation validation: `git diff --check`, line lengths
and link targets. The release and producer blockers remain; the goal is not complete.
The next useful integration action requires the producer/release evidence above, not another
speculative version bump. Resume from this checkpoint and recheck upstream state first.

[chat]: https://github.com/OpenCoven/chat/issues/155
[release]: https://github.com/OpenCoven/coven/releases/tag/v0.4.10
[contract]: https://github.com/OpenCoven/coven/issues/1313
[proposal]: https://github.com/OpenCoven/coven/pull/1308
[authority]: https://github.com/OpenCoven/coven/issues/857#issuecomment-6348225888
[storage]: mission-storage-design.md
