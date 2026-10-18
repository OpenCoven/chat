# Agent notes: the continuity gap

Long, tool-heavy turns in OpenCoven Chat can stop mid-reply. This note records why, so
you don't have to re-diagnose it from scratch.

## Symptom

While working *through* the OpenCoven Chat UI, the assistant sometimes "stops replying"
mid-turn, or earlier turns appear truncated on replay. It happens most often right after
a turn fans out a long chain of tool calls (many `grep`/`Read` calls in a row).

## Root cause (split between the engine and this app)

The bundled `coven-code` engine **cold-starts each message**. It never saves print-mode
turns, so `coven run coven-code --continue <id>` starts with no context. To make up for
that, Chat itself **replays the most recent turns, truncated**, from its own saved
transcript. The replay carries message text only (no tool calls or tool output), newest
turns first, capped at 24 KiB per turn and 4 KiB per message. There is no threaded
session with a rolling summary.

The replay code is in this repo: `REPLAY_HARNESSES`, `REPLAY_LIMIT`, and
`REPLAY_MESSAGE_LIMIT` in `src-tauri/src/coven_runtime.rs` (the comment above them
explains why), plus `build_replay` in the same file. It applies only to `coven-code`
familiars. Claude Code and Codex familiars resume from their own session stores. Two
effects follow:

1. Long, tool-heavy turns are the fragile ones on this transport and can drop before the
   model finishes its reply. Short turns survive.
2. Because the replay leaves out earlier tool output, you're tempted to re-grep and
   re-read the same files every turn to "re-ground". That lengthens the turn and makes
   the drop more likely, so the loop reinforces itself.

## Mitigation for agents (works today, no engine change)

- Keep turns short; don't batch ten tool calls before replying.
- **Persist findings to a file once**, then read that file back in a single call next turn.
  Don't re-derive what's already recorded. (See `AGENTS.md` and the
  `chat-app-orientation` skill.)

## The real fix (engine work)

The fix belongs in `coven-code` (the `OpenCoven/coven-code` repo, usually a sibling
checkout at `../coven-code`), not in this app: a threaded, persisted session plus a
rolling summary, so the model gets real continuity instead of a truncating replay. That's
a separate program from Chat product work and shouldn't block it.
