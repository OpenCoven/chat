# Mission records: storage design

Status (2026-10-19): **approved by Val, as written.** Chat persists mission records
only as this document describes. Issue: #155. Contract:
[OpenCoven/coven#1313](https://github.com/OpenCoven/coven/issues/1313), as built on
Coven `main` at `1450f97f`.

`SECURITY.md` lists everything Chat keeps on disk, and says conversation bodies
never reach browser storage. A mission adds one more thing Chat has to keep across
restarts: the keys that let it learn what happened to a mission it sent. This
document proposes what that record holds, where it lives, and when it goes away.
The implementation PR adds the matching entry to `SECURITY.md`.

## Why Chat has to keep anything

A mission is submitted with an **adoption key**, and Coven derives the mission's id
from it (`mission-` and the first 32 hex digits of its SHA-256). The key is the only
way to resolve a submit whose answer never arrived:

- `coven missions submit` exits 3 when the request may have been applied and no
  answer proved it. Sending the same key again returns the first commit
  (`replayed`), or the same refusal, and never launches twice.
- After a restart, `coven missions get <missionId>` says whether the mission exists.
  Coven refuses a submit once its `validUntil` has passed (at most 15 minutes after
  it was sent), so a `NOT_FOUND` after that instant means it was never committed and
  nothing ran.

If Chat forgot the key, an unanswered submit would become "nothing happened", which
#155 forbids. A cancel works the same way: its own adoption key makes a repeated
cancel return the same cancellation instead of a second one.

## What a record holds

One record per mission Chat submitted:

| Field | Value | Why |
| --- | --- | --- |
| `adoptionKey` | `chat-mission:<UUID v4>`, made by the native side | Resend or read an unanswered submit |
| `missionId` | Derived from the key; checked against the derivation on every load | Read the mission's view |
| `familiar` | `{ familiarId, rootId, revisionId }`: Chat's roster id and the exact ledger revision the user reviewed | Show the record only under that familiar, and drop any view that names another |
| `principalId` | `null` until Coven's first answer names it, then that value (`principal:coven-local-owner:<hex>`) | Drop any view for another owner. Chat never invents it. |
| `phase` | `sending`, `committed` or `terminal` | Decide what to do after a restart |
| `validUntil` | The submit's `validUntil`, 10 minutes after Chat sent it | Know when a `NOT_FOUND` is final |
| `cancelKey` | `null`, or `chat-mission-cancel:<UUID v4>` once the user asks to cancel | Resend an unanswered cancel |
| `createdAt` | When Chat made the record | Order the list, and prune |

It holds **no task body**: no statement, prompt, project path, report, artifact or
usage. Those stay in Coven, and Chat reads them back with `mission.get` when it shows
the mission. A record is a few hundred bytes.

## Where it lives

- `missions-v1.json` in a private `coven-missions/` folder inside Chat's local app
  data folder (`~/Library/Application Support/ai.opencoven.chat` on macOS). The
  folder is mode 0700 and the file 0600 on macOS and Linux, like `iphone-companion/`.
- It is written the way `chat-lifecycle-v1.json` is (`chat_lifecycle::persist`): a
  new temporary file, `sync_all`, a rename into place, then a sync of the folder.
  Writes are serialized by an in-process lock.
- It is read with `symlink_metadata` first, and refused if it is not a regular file.
  It is bounded to 64 KiB and 100 records, and each id is validated.
- It is native-only. **The webview never receives an adoption key or a cancel key.**
  It names a mission by `missionId`, and the native side looks up the keys. No
  mission field goes to `localStorage`, `sessionStorage` or IndexedDB, and the
  iPhone companion cannot read the file.

## When it changes

| Moment | Record |
| --- | --- |
| Before `coven missions submit` runs | Written with `phase: "sending"`. If the write fails, nothing is sent. |
| The submit is `committed` or `replayed` | `phase: "committed"`, and `principalId` from the view |
| The submit is refused, or exit 1 proves it was never sent | Removed. Nothing was created. |
| The submit exits 3 | Kept as `sending`. The window shows the mission as being checked, and Chat resends with the same key and the same payload while it still has the payload in memory. |
| Chat restarts with a `sending` record | Chat reads the mission. If it exists, the record becomes `committed`. If the answer is `NOT_FOUND` and `validUntil` has passed, Chat says the mission never reached Coven and nothing ran, and removes the record. Before `validUntil`, Chat keeps checking. |
| A view is terminal | `phase: "terminal"`. The record stays, so the user can see the result after a restart. |
| The user asks to cancel | `cancelKey` is written before `coven missions cancel` runs. An unanswered cancel is resent with it. |
| The user removes a finished mission | Removed. Only terminal records can be removed. |
| Over 100 records | The oldest terminal records are removed first. Chat never drops a record that isn't terminal. If every record is still open, a new submit is refused with a message saying why. |

## When a view doesn't match

Each view Coven returns names its `missionId`, the familiar's `rootId` and
`revisionId`, and the principal. Chat shows a view only when all of them match the
record. When one doesn't match (M-11 b), or a view arrives late for a familiar the
user has moved away from, Chat drops the view and changes nothing.

If Coven answers `NOT_FOUND` for a `committed` record, for example because Chat is
now pointed at a different Coven home (M-11 a), Chat says Coven no longer has the
mission, and offers to remove the record.

## When the file can't be read

If the file is unreadable, too large or malformed, Chat says it can't read its
mission list and leaves the file as it is. The keys in it may be the only way to
learn what happened to a mission, so Chat never overwrites or resets them. It
refuses new submits until the file is readable or the user removes it.

## The `SECURITY.md` entry the implementation adds

> - **Missions.** For each mission you send from Chat, a private `coven-missions/`
>   folder keeps the keys Chat needs to learn its outcome after a restart: the
>   mission's id, the familiar it was sent to and that familiar's revision, and the
>   Coven owner that accepted it. It keeps no statement, prompt, project path or
>   result; Chat reads those from Coven. On macOS and Linux only your user account can
>   read it. Removing a finished mission removes its record.

## Not decided here

- Sending a mission and showing it, which the native-commands and UI PRs cover.
- Chat's own release, and the Coven release that brings `coven missions` (ask Val).
- Anything that would need the task body on disk. That needs its own design.
