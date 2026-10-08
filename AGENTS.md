# AGENTS.md — OpenCoven Chat

On-entry contract for any agent (familiar or human-driven) working in this repo.
Read this first. It exists so you don't get lost rediscovering the app from scratch.

## What this is

`chat` is the **desktop Coven Chat app** (Tauri: TypeScript/React front end + a Rust
bridge). It talks to the **`coven-code` engine**, which is **live, not retired** — v0.8.0
as of release notes `docs/release-notes/v0.0.2.md:17`. What *was* retired was the demo
shell + the Cave-connected app (consolidated to one entrypoint, see
`docs/release-notes/v0.0.2.md:120`). Do not act on the belief that `coven-code` is dead;
the repo's own docs contradict it (`README.md:132`).

The engine lives in a sibling checkout: `/Users/buns/Documents/GitHub/OpenCoven/coven-code`
(Rust workspace, crates codenamed `claurst-*`). Engine changes belong there, not here.

## Canonical UI file map

Start here instead of grepping blind:

| Concern | File |
|---|---|
| Composer / input box (accepts an `attachments` prop + attach hook) | `src/ui/composer.tsx` |
| Selected-attachment chip (render layer, already built) | `src/ui/attachment-chip.tsx` |
| Attachment read/model helper | `src/coven/attachments.ts` |
| Assistant message rendering (markdown → DOM); typography origin | `src/coven/formatted-message.tsx` |
| App shell / chat composition | `src/coven/chat-app.tsx`, `src/coven/chat-layout.tsx` |
| Runtime bridge (TS → engine send path) | `src/lib/coven-runtime.ts` |
| Event/message types | `src/coven/events.ts` |
| Typography + column/layout CSS (readability lives here) | `src/coven/chat-app.css`, `src/design/familiars-shell.css` |

## Known transport failure mode — READ THIS

The chat engine **cold-starts each message** and leans on a **truncating replay** of
recent turns rather than a threaded session with a rolling summary. Practical consequences
for you as an agent working *through* the chat UI:

1. **Long, tool-heavy turns drop mid-flight.** Turns that fan out ten `grep`/`Read` calls
   in a row are the fragile ones; short talky turns survive. Keep turns short.
2. **The replay truncates your earlier reads**, which tempts you to re-grep the same files
   every turn. That makes the turn long, which makes it drop. It's a doom loop.
3. **Fix: persist findings to a file, then stop re-deriving them.** Write once, read the
   file back in one call next turn. Text > brain. Do not re-grep what's already recorded.

This is a `coven-code` continuity gap (session threading + rolling summary), tracked
separately as engine work — see `docs/agent-notes.md`.

## Write-root guardrail

Edits to this repo need a session whose **primary root is this repo** (or a proven
write grant). Before editing, probe: `git -C . rev-parse --show-toplevel` and a
create/remove temp-file write. If the write probe is denied once, stop and ask for a
relaunch rooted here rather than burning turns on workarounds.

## Commits

Sign every commit (`git commit -S …`). Confirm it shows `Good "…" signature` via
`git log -1 --show-signature` before pushing.

## Deeper orientation

See `.claude/skills/chat-app-orientation/SKILL.md` for the self-serve onboarding skill,
and `docs/agent-notes.md` for the continuity-gap background.
