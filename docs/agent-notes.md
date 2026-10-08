# Agent notes — continuity gap

A short record so no future agent re-diagnoses this from scratch.

## Symptom

While working *through* the Coven Chat UI, the assistant sometimes "stops replying"
mid-turn, or earlier turns appear truncated on replay. It is most likely right after a
turn fans out a long chain of tool calls (many `grep`/`Read` in a row).

## Root cause (engine side, not this app)

The `coven-code` engine **cold-starts each message** and does not thread this chat's
sessions in its own session store. To give the model recent context it **replays the most
recent turns, truncated**, rather than maintaining a persistent threaded session with a
rolling summary. Two effects follow:

1. Long, tool-heavy turns are the fragile ones on this transport and can drop before the
   model finishes its reply. Short turns survive.
2. Because the replay truncates earlier tool output, an agent is tempted to re-grep/re-read
   the same files every turn to "re-ground" — which lengthens the turn and makes the drop
   more likely. A self-reinforcing loop.

## Mitigation for agents (works today, no engine change)

- Keep turns short; don't batch ten tool calls before replying.
- **Persist findings to a file once**, then read that file back in a single call next turn.
  Do not re-derive what's already recorded. (See `AGENTS.md` and the
  `chat-app-orientation` skill.)

## The real fix (tracked as engine work)

Belongs in `coven-code` (`/Users/buns/Documents/GitHub/OpenCoven/coven-code`), not in this
app: a threaded, persisted session plus a rolling summary so the model gets real continuity
instead of a truncating replay. That is a separate program from the two `chat` product
improvements (attachments; readability) and should not block them.
