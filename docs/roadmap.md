# Roadmap

> **Status (2026-11-23):** Current. Checked against the open issues, open PRs and
> releases on 2026-11-23. When this page and an issue disagree, the issue is right. Refresh
> this page when a release ships or an item below changes owner, blocker or next step.

This page is for maintainers and agents. It is the plan: what has shipped, what the next
release is, and what each open item is waiting on. It links each issue instead of copying
it. The September 2026 conformance log that used to live here is archived in
[`archive/2026-09-conformance-log.md`](archive/2026-09-conformance-log.md).

Run the [agent preflight](agents/preflight.md) to refresh issue ownership and PR evidence before selecting work.

## Shipped

The latest release is **v0.1.3** (2026-11-22): the app updates itself from this release
on, and chats signed in with a Claude subscription get full access through Coven's
engine 0.9.1. Every release is listed, with what changed and its verification record, in
[`release-notes/README.md`](release-notes/README.md). The v0.1.3 record is
[`verification/2026-11-22-release-v0.1.3.md`](verification/2026-11-22-release-v0.1.3.md).

## Next release: v0.1.4

[#704](https://github.com/OpenCoven/chat/issues/704): run Chat on Coven 0.5.1. Owner:
coven-cave-c9 (Claude Code), handed over by Val on 2026-11-23. Val tags both releases.

The chain, in order:

1. Coven pins engine 0.9.3, which carries run-budget v1
   ([coven#1816](https://github.com/OpenCoven/coven/pull/1816)), and Val tags Coven v0.5.1
   ([coven#1768](https://github.com/OpenCoven/coven/issues/1768)).
2. Chat repins to Coven 0.5.1, moves its own engine requirement (`ENGINE_VERSION` in
   `src-tauri/src/setup.rs`) from 0.9.1 to 0.9.3, and relands run budgets from
   `chore/704-coven-051` ([#652](https://github.com/OpenCoven/chat/issues/652)). The
   reland must not merge before the repin.
3. The release gates in [`releasing.md`](releasing.md), then Val's v0.1.4 tag.

What else reaches people in v0.1.4. Neither is #704's own work, but both apply to its
build:

- **Signed Windows installers.** The first eSigner-signed release; a release now refuses
  to build unsigned ([#411](https://github.com/OpenCoven/chat/issues/411)).
- **The first update.** v0.1.3 should offer v0.1.4 under **Settings › About**. Proving that
  is step 2 of [#539](https://github.com/OpenCoven/chat/issues/539), checked by a person at
  each installed window.

Possibly, at the call of v0.1.4's owner:

- [#702](https://github.com/OpenCoven/chat/pull/702) (draft, for
  [#700](https://github.com/OpenCoven/chat/issues/700)): open attachments saved in earlier
  messages. Cave asked for it in v0.1.4, and Val approved qualifying Cave against a
  published Chat build that has it. A
  [review on #704](https://github.com/OpenCoven/chat/issues/704#issuecomment-7117117329)
  asks for tests of its refusal paths first.
- Four CodeQL workflow-permission alerts in `ci.yml` (PRs
  [#710](https://github.com/OpenCoven/chat/pull/710),
  [#711](https://github.com/OpenCoven/chat/pull/711),
  [#712](https://github.com/OpenCoven/chat/pull/712); alert 4 has none). `ci.yml` is
  governed by the conformance lock, so they can only land with a repin.

Out of v0.1.4: the iPhone, missions, asking for permission.

## Waiting on a decision from Val

Each issue here has a decision ask with options and a recommendation. The rows without an
issue (alert 5, #716 and #575) say what is being decided.

| Issue | The decision |
| --- | --- |
| [#640](https://github.com/OpenCoven/chat/issues/640), [#665](https://github.com/OpenCoven/chat/issues/665) | May test-only iPhone PRs (#645, #678) merge when the merge uploads a TestFlight build? |
| [#573](https://github.com/OpenCoven/chat/issues/573) | When to run the switched-on qualification of asking: now, or on v0.1.4's engine |
| [#533](https://github.com/OpenCoven/chat/issues/533) | Design audit findings 2, 4 and 5: adopt, decide narrowly, or re-capture first |
| [#154](https://github.com/OpenCoven/chat/issues/154), [#155](https://github.com/OpenCoven/chat/issues/155) | Missions: a remote-execution staging window or local-first; the context-binding proposal |
| [#720](https://github.com/OpenCoven/chat/pull/720) | Turn off CodeQL default setup so the upstream glib copy can be skipped, or dismiss its seven alerts |
| CodeQL alert 5 | Dismiss it as a false positive: `scripts/windows-job-supervisor.cs` writes an already-verified artifact record byte for byte, and the file is lock-governed |
| [#716](https://github.com/OpenCoven/chat/pull/716) (draft, no changes) | Close it: it asks how packaged acceptance drives the Windows MSI, which #532 decided |
| [#575](https://github.com/OpenCoven/chat/pull/575) (draft) | Held by Val since 2026-11-14; keep holding or close |

## Waiting on a person

These need someone at an installed app or a phone. Each issue has a current checklist.

| Issue | What to run |
| --- | --- |
| [#520](https://github.com/OpenCoven/chat/issues/520), [#515](https://github.com/OpenCoven/chat/issues/515), [#539](https://github.com/OpenCoven/chat/issues/539) | The published installers, link review and update check on each desktop, from the v0.1.3 operator plan ([#718](https://github.com/OpenCoven/chat/pull/718)) |
| [#465](https://github.com/OpenCoven/chat/issues/465) | Pairing and Local Network on a physical iPhone, TestFlight 0.3.0 (1910) |
| [#692](https://github.com/OpenCoven/chat/issues/692) | Recovering interrupted research on the paired iPhone (draft PRs #707 and coven-code#613) |

## Open pull requests

Every open PR not listed above, plus #718, #707, #645 and #678, which the rows above name.

| PR | Draft | For | Waiting on |
| --- | --- | --- | --- |
| [#718](https://github.com/OpenCoven/chat/pull/718) | no | [#520](https://github.com/OpenCoven/chat/issues/520), [#515](https://github.com/OpenCoven/chat/issues/515), [#539](https://github.com/OpenCoven/chat/issues/539) | Review and merge: the v0.1.3 operator plan |
| [#707](https://github.com/OpenCoven/chat/pull/707) | yes | [#692](https://github.com/OpenCoven/chat/issues/692) | An engine release with coven-code#613 (also a draft) |
| [#645](https://github.com/OpenCoven/chat/pull/645), [#678](https://github.com/OpenCoven/chat/pull/678) | no | [#640](https://github.com/OpenCoven/chat/issues/640), [#665](https://github.com/OpenCoven/chat/issues/665) | Val's TestFlight decision |

## Later

| Issue | What it is | Waiting on |
| --- | --- | --- |
| [#612](https://github.com/OpenCoven/chat/issues/612) | The mobile experience upgrade: remote access, photos, share-to-compose, alerts | Coven's mobile transport ([coven#1744](https://github.com/OpenCoven/coven/issues/1744)), a relay and APNs operator, a phone check |
| [#154](https://github.com/OpenCoven/chat/issues/154), [#155](https://github.com/OpenCoven/chat/issues/155) | Familiar missions, then optional cloud execution | Coven's mission launch ([coven#1676](https://github.com/OpenCoven/coven/pull/1676)) and Val's decisions |
| [#573](https://github.com/OpenCoven/chat/issues/573) | Asking for permission, back on | Its decision and Val's hand rows |
