---
name: chat-app-orientation
description: Orientation for agents working in the OpenCoven `chat` desktop app. Load on entry to this repo to get the UI file map, the send-path layout, and the transport failure mode (long tool-heavy turns drop; persist findings, don't re-grep) before touching code.
---

# Chat app orientation

You are in `OpenCoven/chat`, the **desktop OpenCoven Chat app** (Tauri: TS/React front end
and a Rust bridge). It drives the Coven CLI, whose harnesses include the **live `coven-code`
engine** (v0.8.0, not retired; see `AGENTS.md`). Use this skill to orient instead of
rediscovering the app by grep.

## First moves (in order)

1. Read `AGENTS.md` at the repo root (the on-entry contract and UI file map).
2. Read `docs/agent-notes.md` for the continuity-gap background, which explains why the
   chat sometimes stops replying mid-turn.
3. Only then open source, starting from the file map below.

## UI file map

- `src/ui/composer.tsx`: composer/input. Accepts an `attachments` prop and an attach hook,
  with the file picker and thread dropzone wired in `src/coven/chat-layout.tsx`.
- `src/coven/attachment-card.tsx`: the attachment card in the composer and transcript. The
  vendored `src/ui/attachment-chip.tsx` is only the composer's fallback.
- `src/coven/attachments.ts`: attachment read/model helper.
- `src/coven/formatted-message.tsx`: assistant message rendering (markdown → DOM); the
  place to tune how responses read.
- `src/coven/chat-app.tsx`, `src/coven/chat-layout.tsx`: app shell and composition.
- `src/lib/coven-runtime.ts`: the TS send path to the CLI. Attachments have shipped: the
  host stages text files (`src-tauri/src/chat_attachments.rs`) and sends them with
  `--stream-json-input`, for Coven Code familiars only.
- `src/coven/events.ts`: event/message types.
- `src/coven/chat-app.css`, `src/design/familiars-shell.css`: typography and layout CSS.
  Readability (`font-size`, `line-height`, readable column width) is tuned here.

## The one habit that keeps you alive on this transport

With the `coven-code` harness, each message starts a fresh engine process. The engine
can't reopen a Chat thread, so Chat replays a **truncated** view of recent turns from its
own transcript (`REPLAY_LIMIT` in `src-tauri/src/coven_runtime.rs`). So:

- **Work in short turns.** Don't fan out ten tool calls before answering: long, tool-heavy
  turns drop mid-flight on this transport.
- **Persist findings to a file, then read that file back** next turn in one call. Do not
  re-grep what you already recorded. Re-grepping is what makes turns long enough to drop.
- Durable planning artifacts belong in the owning repo when it's the primary root;
  otherwise in the author's workspace with the target repo named inside.

## What NOT to do here

- Don't change the engine from this repo. The engine (`coven-code` / `claurst-*`) lives in
  the `OpenCoven/coven-code` repo, usually a sibling checkout at `../coven-code`.
- Don't edit without a verified write root (see `AGENTS.md` → Write-root guardrail).
- Don't commit unsigned. Always use `git commit -S`.
