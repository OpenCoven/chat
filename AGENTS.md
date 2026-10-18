# AGENTS.md: OpenCoven Chat

On-entry contract for any agent (familiar or human-driven) working in this repo.
Read this first. It exists so you don't get lost rediscovering the app from scratch.

## What this is

`chat` is the **desktop OpenCoven Chat app** (Tauri: TypeScript/React front end and a
Rust bridge). It drives the **Coven CLI**, which runs each familiar's harness: the bundled
**`coven-code` engine**, Codex, or Claude Code. `coven-code` is **live, not retired**
(v0.8.0 as of release notes `docs/release-notes/v0.0.2.md:17`). What *was* retired was the
demo shell and the Cave-connected app (consolidated to one entrypoint; see
`docs/release-notes/v0.0.2.md:120`). Do not act on the belief that `coven-code` is dead;
the repo's own docs contradict it (see README's **Local runtime** section).

The engine lives in the `OpenCoven/coven-code` repo, usually a sibling checkout at
`../coven-code` (Rust workspace, crates codenamed `claurst-*`). Engine changes belong
there, not here.

## Canonical UI file map

Start here instead of grepping blind:

| Concern | File |
|---|---|
| Composer / input box (accepts an `attachments` prop + attach hook) | `src/ui/composer.tsx` |
| Attachment card in the composer and transcript | `src/coven/attachment-card.tsx` |
| Vendored fallback chip (the app passes its own card instead) | `src/ui/attachment-chip.tsx` |
| Attachment read/model helper | `src/coven/attachments.ts` |
| Assistant message rendering (markdown → DOM); typography origin | `src/coven/formatted-message.tsx` |
| App shell / chat composition | `src/coven/chat-app.tsx`, `src/coven/chat-layout.tsx` |
| Runtime bridge (TS → engine send path) | `src/lib/coven-runtime.ts` |
| Event/message types | `src/coven/events.ts` |
| Typography + column/layout CSS (readability lives here) | `src/coven/chat-app.css`, `src/design/familiars-shell.css` |

## Known transport failure mode (read this)

With the `coven-code` harness, every message **starts a fresh engine process**. The engine
can't reopen a Chat thread, so Chat does a **truncating replay** of the newest turns from
its own saved transcript instead of resuming a threaded session. The replay carries
message text only, caps each message at 4 KiB and the whole replay at 24 KiB, and drops
older turns. Claude Code and Codex familiars resume from their own session stores and
skip the replay. Practical consequences for you as an agent working *through* the chat UI:

1. **Long, tool-heavy turns drop mid-flight.** Turns that fan out ten `grep`/`Read` calls
   in a row are the fragile ones; short talky turns survive. Keep turns short.
2. **The replay drops your earlier tool output**, which tempts you to re-grep the same files
   every turn. That makes the turn long, which makes it drop. It's a doom loop.
3. **Fix: persist findings to a file, then stop re-deriving them.** Write once, read the
   file back in one call next turn. Text > brain. Do not re-grep what's already recorded.

The replay lives in this repo: `REPLAY_HARNESSES`, `REPLAY_LIMIT`, and `REPLAY_MESSAGE_LIMIT`
in `src-tauri/src/coven_runtime.rs`, with `build_replay` in the same file. Real threaded
sessions with a rolling summary are engine work in `coven-code`. See `docs/agent-notes.md`.

## Write-root guardrail

Edits to this repo need a session whose **primary root is this repo** (or a proven
write grant). Before editing, probe: `git -C . rev-parse --show-toplevel` and a
create/remove temp-file write. If the write probe is denied once, stop and ask for a
relaunch rooted here rather than burning turns on workarounds.

## Commits

Sign every commit (`git commit -S …`). Before pushing, confirm with
`git log -1 --show-signature` that it shows `Good "…" signature`.

## Deeper orientation

See `.claude/skills/chat-app-orientation/SKILL.md` for the self-serve onboarding skill,
and `docs/agent-notes.md` for the continuity-gap background. `CLAUDE.md` has the
directory map, commands, and conventions; `README.md` is the product-behavior contract.
