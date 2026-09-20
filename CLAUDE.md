# CLAUDE.md — OpenCoven Chat

Tauri desktop app (React 19 + Vite frontend, Rust backend) that talks to the
user's locally installed **Coven CLI**. `README.md` is the product-behaviour
contract; read it before changing user-visible behaviour. This file is the map.

## You are probably in the right repo — verify before wandering

`~/Documents/GitHub/OpenCoven/` holds ~80 sibling checkouts with overlapping
vocabulary (*familiar*, *coven*, *chat*). Agents have burned entire sessions
grepping the wrong one. Disambiguate by product, not by name:

| Checkout | What it is | Not this repo's concern |
| --- | --- | --- |
| **`chat`** (here) | The **Coven Chat** desktop app. Tauri shell, one canonical chat per familiar. | — |
| `coven-cave` | **Cave**, a separate desktop control room. | Chat has no Cave import; Cave history never appears in Chat. |
| `coven-agents` | Next.js SaaS control plane (accounts, billing, Daytona runs). | Not a desktop app at all. |
| `coven` | The Coven CLI/engine this app shells out to. | Owns sessions; Chat only maps them. |

**Fast check:** grep a string you can see in the running UI.
`grep -rn "<visible string>" src/ src-tauri/src/`. The Chat UI's strings live
in `src/coven/` and `src-tauri/src/`. If a string is absent here, it belongs to
a sibling checkout — confirm before assuming, and do not assume the reverse
(shared words like "Select a familiar" appear in several repos).

## Where things are

```
src/coven/          The live chat UI. chat-app.tsx (state) + chat-layout.tsx (render).
src/design/         familiars-ui + familiars-shell.css — the .fr-* design system.
src/ui/             Composer, attachment chips (vendored OpenCoven/ui).
src/lib/            coven-runtime.ts is the only bridge the UI uses. lib/sdk/ is the
                    Cave SDK boundary: unmounted, but run by the protected
                    conformance producer by file name — do not delete or rename.
src-tauri/src/      Rust backend. Every user-facing error string starts here.
docs/               Conformance, release, platform notes.
```

Backend modules worth knowing before touching chat behaviour:

- `chat_canonical.rs` — each familiar maps to exactly one current chat ("head").
  Guards reads and lifecycle changes.
- `chat_lifecycle.rs` — archive / restore / delete, with permanent tombstones.
- `chat_origin.rs` — only app-owned history may become a familiar's head.
- `coven_runtime.rs` — spawns the CLI, streams run events, enforces send rules.

`src/main.tsx` mounts `src/coven/chat-app.tsx` at `/` and nothing else. The
former demo shell, the Cave-connected app, and the IndexedDB chat store were
removed; `?demo=` is gone. If a file is not reachable from `main.tsx`, the
user cannot see it.

## Commands

```bash
corepack pnpm install:clean      # frozen lockfile
corepack pnpm app:dev            # THE desktop app — needed for any runtime work
corepack pnpm dev                # browser only: renders UI, cannot reach the CLI
corepack pnpm typecheck
corepack pnpm exec vitest run <file>   # single file; plain `test` runs the heavy suite too
corepack pnpm lint               # biome; `format` to write
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

`pnpm dev` cannot execute commands or reach a daemon. Anything about runs,
sessions, or attachments must be verified in `app:dev`.

## Conventions that bite

- **User-facing strings carry no internal jargon.** "Canonical head", "origin",
  "tombstone" are precise in code and in `README.md`; they must not reach the
  window. A message the reader cannot act on is a bug — say what changed and
  name the control that fixes it.
- **Empty states must agree with the heading.** Copy is chosen by
  `emptyThreadText(ready, familiarName)` in `chat-layout.tsx`, and the empty
  state does not render while `busy` — it used to stack "Select a familiar"
  under "Chat with Astra" on top of a live run indicator.
- **Rust error strings are asserted in tests** (`coven_runtime.rs` tests match
  on substrings). Change the message and the assertion together.
- **No simulation.** The UI shows real runtime results; unavailable
  capabilities are disclosed, never faked with sample data or timed replies.
- **Conversation content never touches browser storage** (see `SECURITY.md`).
  Drafts are per-familiar and in-memory only.
- **Worktrees:** `git worktree add -b <type>/<name> .worktrees/<short-name>`.
  Several are live and some are `locked` — run `git worktree list` before any
  branch surgery, and see the global concurrent-sessions rule.
- **Commits must be signed** (`git commit -S`). See `~/.claude/CLAUDE.md`.
