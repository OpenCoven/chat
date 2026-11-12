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
   git worktree add -b <type>/<short-name> .worktrees/<short-name> origin/main
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

`main` requires signed commits. Sign every commit (`git commit -S`); `CONTRIBUTING.md` has the
setup. Before pushing, run `git log -1 --show-signature` and confirm it reports a good signature.
A commit that fails this check can't merge.
