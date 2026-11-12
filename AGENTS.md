# AGENTS.md: OpenCoven Chat

The entry point for every agent working in this repo: Claude Code, Codex, Copilot, or a familiar
driven through Chat itself. It says what to read next, where current work lives, and how to work
next to the other agents that are usually running here at the same time.

## Read in this order

1. **This file.**
2. **`CLAUDE.md`**: the directory map, the commands, and the conventions that bite. It applies to
   every agent, not only Claude.
3. **`README.md`**: the product-behavior contract. Read the part you're about to change before you
   change anything a user can see.
4. **`CONTRIBUTING.md`**: pull request expectations, verification, and commit signing.
5. **`docs/agents/working-here.md`**: what earlier sessions learned the hard way. GitHub API
   habits, the `ci:full` label gap, known flaky CI rows, and local test failures that aren't
   yours.

`docs/agent-notes.md` explains the chat transport's continuity gap in depth. The
`chat-app-orientation` skill (`.claude/skills/chat-app-orientation/SKILL.md`) is a short version of
this file for Claude Code.

## What this is

`chat` is the **desktop OpenCoven Chat app** (Tauri: a TypeScript/React front end and a Rust
bridge). It drives the **Coven CLI**, which runs each familiar's harness: the bundled
**`coven-code` engine**, Codex, or Claude Code. `coven-code` is **live, not retired**. What was
retired is the demo shell and the Cave-connected app (see README's **Local runtime** section).
Run `coven --version` to see the installed CLI and the engine it pins; on 2026-11-12 it printed
`coven v0.5.0 (engine coven-code 0.9.0, pinned 0.9.0)`.

The engine lives in the `OpenCoven/coven-code` repo, usually a sibling checkout at
`../coven-code` (a Rust workspace whose crates are named `claurst-*`). Engine changes belong
there, not here. `CLAUDE.md` lists the other sibling checkouts that share this vocabulary.

## Where current work lives

- **Open work is in [GitHub issues](https://github.com/OpenCoven/chat/issues).** An issue's body
  and its latest owner comments hold the acceptance criteria. Don't treat a doc in this repo as a
  backlog.
- **Each issue opens with a dated State block** (between `agent-state` comment markers): what's
  done, the next action, and who takes it. When the state changes, edit the block in place
  rather than adding another.
- **When sources disagree, the newest wins, and you re-check.** An owner comment newer than the
  State block overrides it. The State block and labels override the dated snapshot in
  `docs/project-coordination.md`. If something looks contradictory, fix the stale one in the
  same change, or ask on the issue.
- **Labels say who acts next.** Every open issue carries one `area:*` label (`a11y`, `windows`,
  `linux`, `macos`, `release`, `iphone`, `design`, `missions`) and at least one of these:

  | Label | Meaning |
  | --- | --- |
  | `agent-ready` | An agent can take it end to end. Claim it first (below) |
  | `in-progress` | Claimed or has an open PR. Read the claim before touching it |
  | `needs-human` | A person must act: run installers, use a device, provision secrets. Agents prepare, not perform |
  | `needs-decision` | An owner must choose. State the question; don't pick for them |
  | `blocked:engine` | Waits on a coven-code release. Check its releases first |

  To find work:

  ```bash
  gh api 'repos/OpenCoven/chat/issues?labels=agent-ready&state=open' --jq '.[] | "#\(.number) \(.title)"'
  ```

  New agent work uses the **Agent task** issue template (`.github/ISSUE_TEMPLATE/agent-task.md`).
- **Releases:** `gh api repos/OpenCoven/chat/releases`. Another session may have released since
  you last looked, and older issues and plans name versions that have since been renumbered.
  Check before acting on any version number.
- **Dated snapshots, not plans:** `docs/project-coordination.md` (an inventory of worktrees, PRs
  and issue gates taken on 2026-11-12) and `docs/roadmap.md` (a conformance log from September
  2026). Refresh what they say before acting on it.
- **What each doc is for:** `docs/README.md` sorts every page in `docs/` into current reference
  and dated history. `docs/superpowers/README.md` does the same for the old plans and specs.
  Don't follow a plan as a work order unless its status says current.

## Working alongside other agents

Several sessions (Claude Code, Codex, Copilot) usually work in this repo at once, and they all
push as the same GitHub account, so GitHub can't tell you who is doing what. These rules keep
sessions from destroying each other's work:

1. **Work in your own worktree, never the primary checkout.** The primary checkout at the repo
   root may hold someone's uncommitted work or a conflict they are resolving. Start from a fresh
   branch:

   ```bash
   git fetch origin
   git worktree add -b <type>/<issue>-<slug> .worktrees/<issue>-<slug> origin/main
   ```

2. **Run `git worktree list` before any branch surgery.** Don't edit, reset, rebase, check out
   or remove a worktree or branch you didn't create. Some worktrees hold evidence that other work
   depends on, and `docs/project-coordination.md` records which.
3. **Don't touch the shared stash.** `git stash` is shared by every worktree, so a bare
   `git stash pop` can take another session's changes. Set work aside with a WIP commit on your
   own branch instead.
4. **Leave other sessions' PRs alone.** Don't push to, rebase, close or merge a PR you didn't
   open unless the person who owns it asks you to.
5. **Persist your progress to a file** (an ignored path such as `.artifacts/<task>/` in your
   worktree) so a context reset, or the session that picks up after you, doesn't have to
   re-derive it.

### Claim an issue before you start it

GitHub shows every session as the same user, so claims are comments on the issue:

1. **Check first.** Read the issue's latest comments and open PRs. If there is a claim with no
   matching release comment and it isn't stale (step 6), pick other work or ask the claimant on
   the issue.
2. **Pick your names**, so the claim can state them: worktree `.worktrees/<issue>-<slug>` and
   branch `<type>/<issue>-<slug>`. The slug is two to four words from the issue title in
   kebab-case. The type is `fix` for a defect, `feat` for new behavior, `docs`, `test`, `ci`,
   `refactor`, or `chore` for anything else.
3. **Claim.** Post one comment, on a single line:

   ```text
   **Claimed** by <session name> (<Claude Code | Codex | Copilot>) on <YYYY-MM-DD>. Worktree `.worktrees/<issue>-<slug>`, branch `<type>/<issue>-<slug>`. Plan: <one sentence>.
   ```

   The session name is whatever peers can reach you by: the name Claude Code shows other
   sessions, or a Codex task id. If your tool shows none, make up a short tag (tool, date and a
   few random characters) and use it in every comment. Then swap the issue's `agent-ready` label
   for `in-progress`, and edit the State block: today's date, and your session as **Who**.
   `docs/agents/working-here.md` has the REST calls for both.
4. **Create the worktree** with the names you claimed, using the `git worktree add` command at
   the top of this section.
5. **Release.** When you finish, or stop without finishing, post a **Released** comment saying
   what landed (PR links) and what's left, and update the State block. If work remains, put
   `agent-ready` back in place of `in-progress`. Don't make the next agent wait on a silent
   claim.
6. **Stale claims.** A claim is stale when it has no release comment and its branch, PR and issue
   have had no commits, updates or comments for 3 days. Say so in a comment before taking the
   work over.

Work that has no issue gets one first, so there is somewhere to claim it.

### Name worktrees after their issue

Use `.worktrees/<issue>-<slug>` for the worktree and `<type>/<issue>-<slug>` for the branch, for
example `.worktrees/123-example-slug` on `fix/123-example-slug`. Anyone can then match a
worktree to its issue and claim. Record the worktrees your session creates in your progress
file: with one shared account, that file is how you know which ones are yours.

### Find stale worktrees, and remove only your own

Run `git fetch origin` (it moves only `origin/*` refs, so it can't disturb anyone's work), then
`node scripts/agent-worktrees.mjs`. It lists every worktree with its branch, PR state,
uncommitted and unpushed changes, lock, running processes and idle time. It is read-only: it
removes nothing and doesn't even refresh other worktrees' index files. Its verdicts:

| Verdict | Meaning |
| --- | --- |
| `removable` | Work landed (merged, or PR closed), clean, nothing unpushed, unlocked, no process inside, idle 3+ days |
| `check` | Landed, but recently active or named in `docs/project-coordination.md`. Ask before touching it |
| `keep` | Uncommitted or unpushed work, locked, in use, or not landed |
| `prunable` | The directory is gone. `git worktree prune` tidies the record |
| `primary` | The primary checkout. Never remove it |

Remove a worktree yourself (`git worktree remove <path>`) only if your progress file shows you
created it and it is `removable`. Leave everyone else's alone, even a `removable` one. If you're
asked to clean up, post the `removable` rows as a comment on the issue that owns each worktree
(the one in its name or claim). A worktree with no owning issue goes in your report to Val.
There's no need to report `check` or `keep` rows unless someone asks.

## Canonical UI file map

Start here instead of grepping blind. `CLAUDE.md` has the directory-level map.

| Concern | File |
|---|---|
| Composer / input box (an `attachments` prop and an attach hook; the file picker and thread dropzone are wired in `chat-layout.tsx`) | `src/ui/composer.tsx` |
| Attachment card in the composer and transcript | `src/coven/attachment-card.tsx` |
| Vendored fallback chip (the app passes its own card instead) | `src/ui/attachment-chip.tsx` |
| Attachment read/model helper | `src/coven/attachments.ts` |
| Assistant message rendering (Markdown to DOM); where responses' typography starts | `src/coven/formatted-message.tsx` |
| App shell and chat composition | `src/coven/chat-app.tsx`, `src/coven/chat-layout.tsx` |
| Runtime bridge (the TypeScript send path to the CLI) | `src/lib/coven-runtime.ts` |
| Host-side attachment staging (text files sent with `--stream-json-input`, Coven Code familiars only) | `src-tauri/src/chat_attachments.rs` |
| Event and message types | `src/coven/events.ts` |
| Typography and column/layout CSS (readability lives here) | `src/coven/chat-app.css`, `src/design/familiars-shell.css` |

## Known transport failure mode

If you are working *through* the Chat UI with a `coven-code` familiar, each message starts a fresh
engine process. Chat makes up for that by replaying a truncated view of recent turns: message text
only, no tool calls or tool output. So:

1. **Long, tool-heavy turns drop mid-flight.** Keep turns short.
2. **The replay drops your earlier tool output**, which tempts you to re-grep the same files every
   turn, which makes the turn long enough to drop.
3. **Persist findings to a file once, then read that file back** in one call next turn.

Claude Code and Codex familiars resume from their own session stores and skip the replay. The
replay is `build_replay` in `src-tauri/src/coven_runtime.rs`. Root cause and the real fix (engine
work in `coven-code`) are in `docs/agent-notes.md`.

## Write-root guardrail

Edits to this repo need a session whose **primary root is this repo or one of its worktrees** (or
a proven write grant). Before editing, probe with `git -C . rev-parse --show-toplevel` and a
create-then-remove temp-file write. If the write probe is denied once, stop and ask for a relaunch
rooted here rather than burning turns on workarounds.

## Commits

`main` requires signed commits, so sign every commit and confirm the signature is good before you
push. **Commit signing** in `docs/agents/working-here.md` has the exact commands. With an SSH key
(the usual case here) the check needs an allowed signers file; without one it prints "No
signature" even for a correctly signed commit. `CONTRIBUTING.md` has the general setup.
