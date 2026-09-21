# OpenCoven Chat

OpenCoven Chat uses one desktop interface: the Familiars Redesign, connected
to your installed Coven CLI. You don't need Cave, pairing, or a separate demo
build.

```bash
coven --version
corepack pnpm install:clean
corepack pnpm app:dev
```

The desktop window opens the familiar list, transcript, composer, and
familiar inspector at `/`. Old `?demo=` links no longer select different
applications. `VITE_DEFAULT_DEMO` and `app:build:demo` are removed.

The application frame stays within the window and does not scroll globally.
Conversation history, rails, and long drafts scroll inside their own regions,
so a long reply or a short window does not push the composer off the page.

Toggle the familiar list with **Cmd/Ctrl+\\** and the inspector with
**Cmd/Ctrl+Shift+\\**. These shortcuts work while composing without changing
your text. Rail buttons include shortcut hints; modal dialogs and input-method
composition do not trigger the shortcuts.

Closed rails remain as 28px full-height tabs: **Familiars** on the left and the
selected familiar's name on the right. Click anywhere along a tab to reopen
its rail. The tabs reserve their own space instead of covering chat content,
with opaque smoky surfaces, subtle depth, and visible keyboard focus.

Use **Add context** in the composer to clarify which familiar or project you
mean. Search by name, identity, or full path (`@` filters familiars; `#` filters
workspaces). Suggestions come from known familiars and the selected familiar's
declared read/write project access,
with full identities and paths to distinguish similar names. Selection inserts
visible reference text at your cursor; it does not switch the recipient,
delegate work, or grant file access.

You can also type **`@name`** or **`#project`** directly in your message for
inline suggestions. Use the arrow keys to choose and **Tab** to confirm, or
**Escape** to dismiss. The optional `@{name` / `#{project` opening-brace syntax
works too. Completed references use `@{Name}` or `#{project}` with the full
identity or path alongside them, so similarly named choices remain unambiguous.
Projects come from the local project registry and stored direct/group grants
used by Cave, not inferred familiar directories or chat history. Read-only and
write access are labeled separately; only the selected familiar's granted
projects appear. This reads local metadata without requiring Cave to run,
importing conversations, or modifying permissions. Without a configured
registry/grants, no project access is assumed. Use **Refresh Coven** after
changing grants. Email addresses and URL fragments remain ordinary text.

The composer shows the reported chat project, or the familiar workspace when
no chat project has been reported. This is observed context, not a workspace
switch or permission grant. The reference picker opens above the app on modern
desktop webviews so long paths do not push the composer out of view.

Connection diagnostics are collapsed during normal use. Run status and Stop
stay beside the composer, and the end of the thread shows the familiar's
avatar with what the run is doing right now (waiting for the familiar, running
a named tool, or stopping) until reply text starts to stream. **Jump to
latest** returns to new output after you scroll back and counts the messages
that arrived while you were reading. Error notices carry a dismiss control; a
notice also clears on the next send, familiar switch, or refresh. Replies and the composer share a responsive reading column up to
1200px wide (36% wider than the previous 880px limit), while
the application frame remains stationary.
The window can shrink to 480×520: above 1100px every rail stays in the grid,
below it the inspector folds into a drawer, and at 760px or less both rails
become drawers that open one at a time.

Unsent drafts are kept per familiar in memory only. They survive switching
familiars but not closing the window: conversation content never reaches
browser storage (see `SECURITY.md`), and only the selected familiar is
remembered across restarts.

## Local runtime

The desktop host owns access to Coven. The browser does not execute commands,
receive credentials, or connect directly to a daemon. `pnpm dev` and `pnpm
preview` render the same interface, but cannot access your installed CLI.
Use the desktop app for runtime operations.

The interface shows actual runtime results, not sample familiars, fabricated
activity, or timed assistant replies. Unavailable capabilities are disclosed
rather than simulated. Installing Coven does not configure a model provider:
complete any provider setup required by your CLI before starting a run.

Runs use Coven's bundled `coven-code` engine with explicit read-only
permissions. Chat does not grant write access or simulate approval controls.
The native runtime currently supports macOS and Linux. Windows displays an
unavailable notice until equivalent process-tree containment is implemented.

The frozen SDK artifacts remain pinned. Their existing health and conformance
contracts are not expanded into undocumented chat methods, and the standalone
runtime does not fall back to Cave.

## Persistent familiar chats

The sidebar is an agent list: each familiar has one canonical, persistent Chat
conversation. Select a familiar to return to that thread. There is no separate
familiar selector or new-conversation chooser. Rows are ordered by the most
recent activity Coven reports, each captioned with how long ago that was
(hover for the full timestamp); familiars whose chats carry no readable
timestamp keep the CLI's order after them. From the search box, **Enter**
opens the first match, **Escape** clears the filter, and the arrow keys move
into and along the list.

Chat and Cave are separate applications. There is no Cave import action or
runtime import command, and Cave history does not appear in Chat. Previously
saved import files are not automatically deleted or submitted to a model.
Only app-owned history can become a familiar's canonical Chat thread.

Claude Code and Codex threads continue from the harness's own session store.
The bundled Coven Code engine cannot reopen a thread's earlier turns that way,
so when you continue a Coven Code chat, Chat replays the most recent turns from
its saved transcript into the new run (the newest turns first, up to 24 KiB,
each message capped at 4 KiB) and adds a notice to the thread saying how many
turns were replayed and whether older ones were left out. The saved transcript
keeps only your original message, not the replayed prompt.

**Archive chat** keeps the saved history and hides the familiar from the active list.
This interface only shows active familiar chats: it has no User settings or
archived-chat browser. Archived history is preserved, and archive state survives
refreshes and app restarts.

**Delete chat** requires confirmation and is strictly app-local: it removes the
saved Chat transcript and that chat's local draft. It does
not delete original Coven CLI database records/files or change Cave history.
A permanent tombstone prevents rediscovery or restoration of the deleted
thread; deleted ancestors are not replayed through a remaining chat's captured
history chain. This is not secure erasure of backups, provider history, or CLI
attachment staging. Lifecycle storage is private, atomically replaced, and bounded
to 10,000 entries / 2 MiB; corrupt or full storage reports an error rather than
forgetting tombstones. Lifecycle actions wait until all active runs, including
cancellation cleanup, have finished; deleting a chat never cancels an agent.

## Attachments and formatted replies

Use the compact **+** attachment button beside the message field. Selected files
appear as cards with their filename, size, and a remove control; sent messages
retain file cards in the transcript.

The composer accepts up to four UTF-8 text/code files, each at most 64 KiB.
Selected bytes are validated and passed to Coven as actual file contents, not
just filenames. You can send files with or without an accompanying message.
The installed `coven-code` 0.7.0 engine does not support genuine image/PDF input
through this transport, so binary files are explicitly rejected.

Unsent attachments stay in the current window. Failed or cancelled sends keep
them available for retry or removal; successful sends retain filename/size
metadata in history. Native staging is private and bounded to 64 MiB of
retained files; originals are never modified.

Sending clears the submitted text and attachment cards immediately. You can
compose the next message while the familiar responds. A failed or cancelled
send restores its attachments and restores its text only if you have not
edited the new draft; later edits are never overwritten.

Assistant replies render Markdown headings, lists, emphasis, quotes, code,
tables, and task lists. Wide code and tables scroll inside the message.
Raw HTML is disabled and remote Markdown images are not fetched automatically.
Each reply has a **Copy** control that copies its Markdown source, and each
fenced code block names its language with its own **Copy** control for the
code alone. The control reports "Copied" only after the clipboard accepted
the text and "Copy failed" when it did not.

Tool calls appear as activity rows between the prose, each expanding to the
call's arguments. When the runtime reports a call as data rather than as a
`⚒ Name(args)` line — a `tool_start` frame from the bundled engine, a
`tool_use` block in an assistant message, or a `tool_result` frame — the row
also shows the input (cut at 16 KiB with a note saying so) and, once
reported, the result, and the run status
names the tool that is executing while its row is marked as running. The bundled engine's Claude CLI provider
reports calls as text only, so those rows carry the one-line summary alone.

## Remote screen (VNC)

The **Show screen** button in the thread header opens a viewer pane above the
transcript. Enter the WebSocket address of a VNC server that speaks the noVNC
transport (for example the `websockify` endpoint of a Daytona sandbox, with its
access token in the query string), an optional password, and choose
**Connect**. The desktop appears scaled to fit and starts **view only**; clear
that toggle to send mouse and keyboard input. The status line names the
desktop reported by the server, and a failure names the reason the host saw:
an HTTP status instead of a WebSocket upgrade, a refused or timed-out
connection, a handshake that did not complete, or a server that rejected the
password.

The window never opens the connection itself. The desktop host performs the
WebSocket upgrade, forwards opaque frames both ways, and reports the close;
it adds no credentials or headers, follows no redirects, refuses anything but
`ws://` and `wss://`, caps a message at 16 KiB upstream and 16 MiB
downstream, and holds at most two screens per window. Its error messages
never repeat the address, because the address may carry a token. The address
and password live only in the pane while it is open; closing the pane,
switching away, or closing the window drops the connection, and nothing is
written to browser storage. In the browser (`pnpm dev`) the pane says that
screen viewing needs the desktop app.

The VNC client is [noVNC](https://github.com/novnc/noVNC) 1.7.0, vendored
under `src/vendor/novnc` (MPL-2.0); see its `README.md` for provenance.

## Familiar avatars

Your familiar's portrait lives at
`~/.coven/workspaces/familiars/<familiarName>/avatars/<familiarName>.png`.
The verified directory is `avatars`, not `assets`. Chat resolves it from the
workspace reported by Coven rather than assuming your home directory or
ignoring a custom Coven home.

The desktop host creates a small PNG thumbnail for the interface without
changing your original file. It recognizes PNG or JPEG content, including
JPEG portraits saved with a `.png` filename. A familiar without a portrait
keeps its initial as a fallback; the webview never receives general
filesystem access.

Click the familiar's avatar or name beside an assistant reply to open their
overview card in the inspector without leaving the conversation.

## Existing local data

The previous app's IndexedDB database, `opencoven-chat`, is not deleted or
converted into Coven sessions. Local notes and retained side-note receipts
remain separate from CLI-owned history. They are not submitted to a model
automatically. The production application identifier remains
`ai.opencoven.chat`; no demo identity replaces it.

## Developer setup

You need Node.js `24.18.1`, `pnpm` `10.34.0` through Corepack, Rust `1.95.0`
with `clippy` and `rustfmt`, and the platform's Tauri dependencies. See
[`docs/developer-toolchains.md`](docs/developer-toolchains.md) for the full
toolchain list.

```bash
corepack enable
pnpm install:clean
pnpm exec playwright install chromium
pnpm app:dev
```

The default Vite port is `4173`. Browser smoke coverage uses a separate
production preview on `4174`.

| Script | Purpose |
| --- | --- |
| `pnpm dev` | Render the desktop interface in a browser |
| `pnpm build` | Build production web assets |
| `pnpm typecheck` | Run TypeScript with `--noEmit` |
| `pnpm lint` | Run Biome checks |
| `pnpm test:unit` | Run the normal and heavy Vitest suites |
| `pnpm test:e2e` | Run Playwright against the production preview |
| `pnpm cargo:fmt` | Check Rust formatting |
| `pnpm cargo:check` | Compile all Rust targets |
| `pnpm cargo:clippy` | Run Rust lints |
| `pnpm cargo:test` | Run Rust tests |
| `pnpm app:dev` | Start the hot-reloading desktop app |
| `pnpm app:build` | Package the desktop app |

## Native boundaries

Runtime operations cross typed, narrowly scoped Tauri commands. There is no
generic shell, filesystem, or HTTP command exposed to the webview, and no
Tauri shell, filesystem, opener, or network plugin permission is granted.
The main window is allowed to invoke only the seven `coven_runtime_*`
commands the chat interface uses; the Cave adapter and app-identity commands
remain registered for native and conformance coverage but are not reachable
from the webview.

The reviewed Cave adapter remains in the repository for its independent
native and conformance coverage. The single Chat entrypoint does not start
it, pair with it, or require its credentials. Removing the old UI modes does
not rewrite the protected release evidence or broaden existing trust
boundaries.

## Protected conformance

The product UI and the historical Phase 1 release gate are separate.
[`docs/phase1-conformance.md`](docs/phase1-conformance.md) documents the
immutable native gate and real-authority three-platform matrix.

`contract-canary.lock.json` pins reviewed SDK and Cave commits, packed
tarball digests, and the Client v1 authority fixture.
`phase1-conformance.lock.json` independently pins the real-authority release
candidate. Neither lock is changed by the UI migration.

```bash
pnpm test:contract-canary -- --sdk-root <sdk-root> --cave-root <cave-root>
/bin/sh scripts/phase1-conformance-launcher.sh "$(command -v node)"
pnpm test:native-e2e
```

Conformance requires the exact counterpart checkouts and platform authority
described in its guide. A successful local UI build is not evidence of a
successful protected conformance run.

## Delivery and releases

See the [delivery roadmap](docs/roadmap.md) for PR dependencies and
consolidation history. CI runs frontend, browser, Rust, packed-artifact,
and native lifecycle coverage. The heavy Phase 1 Vitest suites test the
conformance scripts rather than the app, so a pull request runs them only
when it changes something outside the chat UI, the browser suite, or prose;
every push to `main` runs them regardless.

Releases are cut from signed `v*` tags through
[`.github/workflows/release.yml`](.github/workflows/release.yml). The
[release guide](docs/releasing.md) covers platform bundles, signing,
checksums, rehearsals, and recovery.
