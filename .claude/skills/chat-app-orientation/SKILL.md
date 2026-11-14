---
name: chat-app-orientation
description: Orientation for agents working in the OpenCoven `chat` desktop app. Load on entry to this repo to get the UI file map, the rules for working beside other sessions, and the transport failure mode (long tool-heavy turns drop; persist findings, don't re-grep) before touching code.
---

# Chat app orientation

You are in `OpenCoven/chat`, the **desktop OpenCoven Chat app** (Tauri: TS/React front end
and a Rust bridge). It drives the Coven CLI, whose harnesses include the **live `coven-code`
engine** (not retired; `coven --version` shows the pinned engine). This skill is the short
version of `AGENTS.md`, which is the source of truth.

## First moves (in order)

1. Read `AGENTS.md` at the repo root: what to read next, where current work lives, the rules
   for working beside other sessions, and the canonical UI file map.
2. Read `CLAUDE.md` for the directory map, commands, and conventions that bite.
3. Only then open source, starting from the file map in `AGENTS.md`.

## Before you change anything

- **Use your own worktree.** Never work in the primary checkout, and never touch another
  session's worktree, branch, PR, or stash entry. Run `git worktree list` first.
- **Check releases** (`gh api repos/OpenCoven/chat/releases`) before trusting any version
  number in an issue or plan.
- **Probe the write root** (see `AGENTS.md` → Write-root guardrail).
- **Sign every commit** (`git commit -S`), and check `git log -1 --show-signature`.

## The one habit that keeps you alive on the coven-code transport

When you work *through* the Chat UI with a `coven-code` familiar, each message starts a fresh
engine process and Chat replays only a truncated, text-only view of recent turns. So:

- **Work in short turns.** Long, tool-heavy turns drop mid-flight on this transport.
- **Persist findings to a file, then read that file back** next turn in one call. Do not
  re-grep what you already recorded.

`docs/agent-notes.md` has the root cause. The real fix is engine work in the
`OpenCoven/coven-code` repo (usually `../coven-code`), not in this app.
