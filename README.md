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
The conversation region can take keyboard focus, so it scrolls with the
arrow and page keys without a control inside it being focused.

The interface follows your system's light or dark appearance. Both palettes
hold every visible text to WCAG AA contrast, checked on the rendered app in
each scheme.

The window is titled after the familiar you are viewing, such as
"Astra — OpenCoven Chat", and leads with a count when runs have ended in
other chats you have not opened yet, so a window in the background shows
that a reply is waiting.

Toggle the familiar list with **Cmd/Ctrl+\\** and the inspector with
**Cmd/Ctrl+Shift+\\**, and reach the familiar search with **Cmd/Ctrl+K**
(it opens the list if it is closed), and step to the previous or next
familiar with **Cmd/Ctrl+[** and **Cmd/Ctrl+]**, in the list's own order and
filter. **Cmd/Ctrl+F** opens a find bar over the conversation that counts
the messages and tool calls containing your text; **Enter** and
**Shift+Enter** step through them, scrolling each into view, and
**Escape** closes it. These shortcuts work while composing
without changing your text, stay quiet while a dialog or menu is open, and **Keyboard
shortcuts** at the foot of the familiar list lists them all. Typing a letter while nothing editable has
focus starts a message: the keystroke moves to the composer and lands there,
unless the composer cannot send or a dialog or menu is open. Rail buttons include shortcut hints; modal dialogs and input-method
composition do not trigger the shortcuts.

Closed rails remain as 28px full-height tabs: **Familiars** on the left and the
selected familiar's name on the right. Click anywhere along a tab to reopen
its rail. The tabs reserve their own space instead of covering chat content,
with opaque smoky surfaces, subtle depth, and visible keyboard focus.

Use **Add context** in the composer to clarify which familiar or project you
mean. Search by name, identity, or full path (`@` filters familiars; `#` filters
workspaces). Suggestions come from known familiars and the selected familiar's
declared read/write project access,
with full identities and paths to distinguish similar names. The inspector's
Access tab lists that same declared access, write grants first, and says
plainly that Chat neither enforces nor extends it. When none is declared
it says so, and when Chat could not read the registry or grants it says
that instead, so an unreadable store is never shown as an empty one. Selection inserts
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
a named tool, or stopping) until reply text starts to stream, and the status
counts how long the run has been going. After thirty seconds without a sign
of life the row says it is still waiting, or still running the tool. When a run ends, assistive
technology hears how: the familiar's outcome and duration, or that a
familiar replied or failed in another chat. A run belongs to
the familiar it was sent to: if you switch to another familiar while it is
live, that familiar's sidebar row reads **Responding…**, the status beside the
composer names them and says the composer is free once their run finishes or
is stopped, and the thread you are viewing does not claim the run. When that
run ends, their row reads **New reply** (or **Run failed**) until you open
them again; a run you stop yourself leaves no marker. While the familiar list
is collapsed, its tab carries a count of such runs so they are not missed. Without a connected CLI
the empty familiar list says to connect rather than to configure a familiar. **Jump to
latest** returns to new output after you scroll back and counts the messages
that arrived while you were reading. Error notices carry Copy and dismiss controls; a
notice also clears on the next send, familiar switch, or refresh. When a
chat's history could not be read, its notice offers **Reload chat**, which
reads it again without refreshing everything. The collapsed connection
details have a Copy control too, for a bug report. Replies and the composer share a responsive reading column up to
1200px wide (36% wider than the previous 880px limit), while
the application frame remains stationary.
The window can shrink to 480×520: above 1100px every rail stays in the grid,
below it the inspector folds into a drawer, and at 760px or less both rails
become drawers that open one at a time.

Unsent drafts are kept per familiar in memory only. They survive switching
familiars but not closing the window: conversation content never reaches
browser storage (see `SECURITY.md`), and only the selected familiar is
remembered across restarts.

With a connected CLI but no familiars configured, the empty thread and the
composer say so, rather than asking you to select from an empty list, and
the empty thread and the empty familiar list each offer **Check for
familiars**, which refreshes Coven. Without a connected CLI they offer
**Check again** instead.

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
(hover for the full timestamp, and the captions age on their own while the
window stays open); familiars whose chats carry no readable
timestamp keep the CLI's order after them; hovering a row shows the familiar's
purpose. The search box matches a familiar's name, identity, or purpose. From the search box, **Enter**
opens the first match, **Escape** clears the filter, and the arrow keys move
into and along the list. A search that matches nothing offers **Clear search**.
Choosing a familiar, by click or by Enter, puts the cursor in the composer as
soon as their thread is ready. A row whose familiar has unsent text leads its
preview with **Draft:** and that text. The thread header captions the
familiar's name with when their chat last moved (hover for the full
timestamp), and an empty thread shows the familiar's purpose under its
heading.

The inspector's Overview shows the familiar's purpose, identity and workspace
(each path with its own **Copy** control),
whether their chat is active, archived or not yet started, and its last
activity. Activity reports the run state, how the most recent run in this window
ended and how long it took, and counts the messages you sent, the
replies and the tool calls (with failures, and a breakdown by tool) in the
loaded transcript; tokens,
cost and timing are not reported by this CLI integration.

When Chat holds only the most recent part of a chat's history, a quiet line at
the top of the thread says so; nothing has failed, so it is not an error
notice. **Load earlier turns** reads the chat again with twice, three and then
four times the usual budget of sessions and bytes, keeping the
transcript on screen and your place in it while it loads. Past that the line
points to the Coven CLI for the rest. Opening another chat starts from the
usual budget.

Chat and Cave are separate applications. There is no Cave import action or
runtime import command, and Cave history does not appear in Chat. Previously
saved import files are not automatically deleted or submitted to a model.
Only app-owned history can become a familiar's canonical Chat thread.

Claude Code and Codex threads continue from the harness's own session store.
The bundled Coven Code engine cannot reopen a thread's earlier turns that way,
so when you continue a Coven Code chat, Chat replays the most recent turns from
its saved transcript into the new run (the newest turns first, up to 24 KiB,
each message capped at 4 KiB) and adds a notice to the thread saying how many
turns were replayed and whether older ones were left out. That notice is a
quiet line between messages, not a reply from anyone. The saved transcript
keeps only your original message, not the replayed prompt.

The chat's actions live behind the **Chat actions** control (the ⋯ in the
thread header; focus returns there after the delete dialog closes).
**Archive chat** keeps the saved history and hides the
familiar from the active list; an archived chat shows **Restore chat** in the
header itself, since restoring is what lets you send again.
The familiar list shows active chats; **Show archived chats**, under **User
settings** at the foot of the list, switches it to archived ones. Archived
history is preserved, and archive state survives refreshes and app restarts.

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

Use the compact **+** attachment button beside the message field, or drag
files onto the conversation. A drop goes through the same checks as the
picker, and a file dropped anywhere else in the window is ignored rather
than opened. Selected files
appear as cards with their filename, size (in KiB above a kibibyte), and a
remove control; sent messages retain file cards in the transcript.

A message itself may be up to 32,768 bytes; past that the composer warns
before you send, naming the exact byte count, since Coven would refuse it. The composer accepts up to four UTF-8
text/code files, each at most 64 KiB.
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
edited the new draft; later edits are never overwritten. While a failed run's
error notice shows and the restored text or attachments are still in the
composer, the notice offers **Try again**, which sends them once more.

Assistant replies render Markdown headings, lists, emphasis, quotes, code,
tables, and task lists. Wide code and tables scroll inside the message.
Raw HTML is disabled and remote Markdown images are not fetched automatically.
Links open outside the window, so hovering one shows its address first.
Each reply has a **Copy** control that copies its Markdown source, your own
messages have one too, and each
fenced code block names its language with its own **Copy** control for the
code alone. The control reports "Copied" only after the clipboard accepted
the text and "Copy failed" when it did not.

Tool calls appear as activity rows between the prose, each expanding to the
call's input and, once reported, its result, each block labeled and with its
own **Copy** control. The turn's header counts the calls it holds and how
many failed, whether or not the list is folded. When the runtime reports a call as data rather than as a
`⚒ Name(args)` line — a `tool_start` frame from the bundled engine, a
`tool_use` block in an assistant message, or a `tool_result` frame — the row
also shows the input (cut at 16 KiB with a note saying so) and, once
reported, the result (a collapsed row says how many lines it holds), and the run status
names the tool that is executing while its row is marked as running. A run of
more than ten consecutive calls folds to its newest six, behind a control that
says how many earlier calls it hides and how many of those failed. The bundled engine's Claude CLI provider
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
`ws://` and `wss://`, caps a message at 64 KiB upstream and 16 MiB
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
commands the chat interface uses, the three `coven_screen_*` commands of the
screen relay, and Tauri's permission to set its own window title; the Cave
adapter and app-identity commands remain registered for native and
conformance coverage but are not reachable from the webview.

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
