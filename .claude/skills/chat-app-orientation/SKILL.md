---
name: chat-app-orientation
description: Orientation for agents working in the OpenCoven `chat` desktop app. Load on entry to this repo to get the UI file map, the send-path layout, and the transport failure mode (long tool-heavy turns drop; persist findings, don't re-grep) before touching code.
---

# Chat App Orientation

You are in `OpenCoven/chat`, the **desktop Coven Chat app** (Tauri: TS/React front end +
Rust bridge) that talks to the **live `coven-code` engine** (v0.8.0; not retired — see
`AGENTS.md`). Use this skill to orient instead of rediscovering the app by grep.

## First moves (in order)

1. Read `AGENTS.md` at the repo root — the on-entry contract and UI file map.
2. Read `docs/agent-notes.md` — the continuity-gap background (why the chat sometimes
   stops replying mid-turn).
3. Only then open source, starting from the file map below.

## UI file map

- `src/ui/composer.tsx` — composer/input. Accepts an `attachments` prop + an attach hook,
  with the file picker and thread dropzone wired in `src/coven/chat-layout.tsx`.
- `src/ui/attachment-chip.tsx` — chip UI for a selected attachment (render layer ready).
- `src/coven/attachments.ts` — attachment read/model helper.
- `src/coven/formatted-message.tsx` — assistant message rendering (markdown → DOM); the
  place to tune how responses read.
- `src/coven/chat-app.tsx`, `src/coven/chat-layout.tsx` — app shell / composition.
- `src/lib/coven-runtime.ts` — TS→engine send path (check whether attachment *bytes* are
  carried to the engine before promising attachment support; that one fact decides whether
  attachments is an afternoon or a week).
- `src/coven/events.ts` — event/message types.
- `src/coven/chat-app.css`, `src/design/familiars-shell.css` — typography + layout CSS;
  readability (font-size, line-height, readable column width) is tuned here.

## The one habit that keeps you alive on this transport

The engine cold-starts each message and replays a **truncated** view of recent turns. So:

- **Work in short turns.** Don't fan out ten tool calls before answering — long tool-heavy
  turns drop mid-flight on this transport.
- **Persist findings to a file, then read that file back** next turn in one call. Do not
  re-grep what you already recorded. Re-grepping is what makes turns long enough to drop.
- Durable planning artifacts belong in the owning repo when it's the primary root;
  otherwise in the author's workspace with the target repo named inside.

## What NOT to do here

- Don't change the engine from this repo. Engine (`coven-code` / `claurst-*`) lives at the
  sibling checkout `/Users/buns/Documents/GitHub/OpenCoven/coven-code`.
- Don't edit without a verified write root (see `AGENTS.md` → Write-root guardrail).
- Don't commit unsigned — always `git commit -S`.
