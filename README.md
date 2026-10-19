<p align="center"><img src="assets/brand/chat-app-icon-rounded.svg" width="96" height="96" alt="OpenCoven Chat logo: the OpenCoven crown inside a speech bubble"></p>

# OpenCoven Chat

OpenCoven Chat is a desktop app for chatting with your familiars through the Coven CLI installed
on your computer. Each familiar has one ongoing chat, and the window shows real runs as they
happen. You don't need Cave, a Cave pairing, or a separate demo build.

To build and run it from this repository:

```bash
coven --version
corepack pnpm install:clean
corepack pnpm app:dev
```

Chat finds a Coven CLI installed with `npm install -g @opencoven/cli` in npm's default folder (on
macOS, Linux, and Windows), in any nvm-managed Node, or under an npm prefix on your `PATH`. It also
looks in `~/.local/bin`, `~/.cargo/bin`, and your `PATH`, so a launch from Finder or the Start menu
doesn't depend on your shell setup.

## The window

The desktop window opens at `/` with the familiar list, the transcript, the composer, and the
familiar inspector. Old `?demo=` links no longer select different applications, and
`VITE_DEFAULT_DEMO` and `app:build:demo` have been removed.

The app frame stays inside the window and doesn't scroll as a whole. Conversation history, the
rails, and long drafts scroll inside their own regions, so a long reply or a short window doesn't
push the composer off the page. The conversation region can take keyboard focus, so you can scroll
it with the arrow and page keys without focusing a control inside it.

The interface follows your system's light or dark appearance. Both palettes hold all visible text
to WCAG AA contrast, checked on the rendered app in each scheme.

The window title names the familiar you're viewing, such as `Astra — OpenCoven Chat`. When runs
have ended in other chats you haven't opened yet, the title leads with a count, so a window in the
background shows that a reply is waiting.

Closed rails stay on screen as 28px full-height tabs: **Familiars** on the left and the selected
familiar's name on the right. Click anywhere along a tab to reopen its rail. The tabs reserve their
own space instead of covering chat content, with opaque smoky surfaces, subtle depth, and visible
keyboard focus.

Replies and the composer share a responsive reading column up to 1200px wide (36% wider than the
previous 880px limit), while the app frame stays still. The window can shrink to 480×520:

- above 1100px, both rails stay in the grid;
- below that, the inspector folds into a drawer;
- at 760px or less, both rails become drawers that open one at a time.

While both rails are in the grid, the inspector can be resized. Drag its left edge, or Tab to the
**Resize inspector** handle on that edge and press **Left** or **Right** (16px a step; the keys
mirror in a right-to-left layout), or **Home** and **End** for the ends. It ranges from 280px to
600px, and the conversation column always keeps at least 440px, so a narrower window or an open
familiars list can hold the inspector under your choice for a while; the width you chose comes back
when there is room. The default is 360px, and Settings → General shows the current width with a
**Reset**. Only that number is remembered on this device. In the drawer layouts there is no
handle; drawers keep their own width.

## Keyboard shortcuts

| Shortcut | What it does |
| --- | --- |
| **Cmd/Ctrl+\\** | Show or hide the familiar list |
| **Cmd/Ctrl+Shift+\\** | Show or hide the inspector |
| **Cmd/Ctrl+K** | Go to the familiar search, opening the list if it's closed |
| **Cmd/Ctrl+[** and **Cmd/Ctrl+]** | Step to the previous or next familiar, in the list's own order and filter |
| **Cmd/Ctrl+F** | Open a find bar over the conversation that counts the messages and tool calls containing your text |

In the find bar, **Enter** and **Shift+Enter** step through the matches, scrolling each into view,
and **Escape** closes it.

These shortcuts work while you're composing and leave your text unchanged. They stay quiet while a
dialog or menu is open, and the rail buttons show shortcut hints. Modal dialogs and input-method
composition don't trigger them.

Typing a letter while nothing editable has focus starts a message: the keystroke moves to the
composer and lands there, unless the composer can't send or a dialog or menu is open.

## Referring to familiars and projects

Use **Add context** in the composer to make clear which familiar or project you mean. Search by
name, identity, or full path: `@` filters familiars and `#` filters workspaces. Suggestions come
from known familiars and from the selected familiar's declared read and write project access. They
show full identities and paths, so you can tell similar names apart. Picking a suggestion inserts
visible reference text at your cursor. It doesn't switch the recipient, delegate work, or grant
file access.

**Settings › Access** lists that same declared access, write grants first, and says plainly that
Chat neither enforces nor extends it. The **Access** row in the inspector's Overview opens it. When
no access is declared, it says so. When Chat couldn't read the registry or grants, it says that
instead, so an unreadable store never looks like an empty one.

You can also type **`@name`** or **`#project`** directly in your message for inline suggestions.
Use the arrow keys to choose and **Tab** to confirm, or **Escape** to dismiss. The optional
`@{name` / `#{project` opening-brace syntax works too. Completed references use `@{Name}` or
`#{project}` with the full identity or path alongside them, so similarly named choices stay
unambiguous. Email addresses and URL fragments stay ordinary text.

Projects come from the local project registry and the stored direct and group grants that Cave
uses. Chat doesn't infer them from familiar directories or chat history. Read-only and write access
are labeled separately, and only the selected familiar's granted projects appear. Chat reads this
local metadata without needing Cave to run, and it doesn't import conversations or modify
permissions. Without a configured registry and grants, Chat assumes no project access. Choose
**Refresh Coven** after you change grants.

The composer shows the reported chat project, or the familiar workspace when no chat project has
been reported. This is observed context, not a workspace switch or a permission grant. On modern
desktop webviews the reference picker opens above the app, so long paths don't push the composer
out of view.

## While a run is going

Run status and **Stop** stay beside the composer. Until reply text starts to stream, the end of the
thread shows the familiar's avatar with what the run is doing right now: waiting for the familiar,
running a named tool, or stopping. The status counts how long the run has been going. After thirty
seconds without a sign of life, the row says it's still waiting, or still running the tool.

**Jump to latest** returns you to new output after you scroll back, and counts the messages that
arrived while you were reading.

When a run ends, assistive technology announces how: the familiar's outcome and duration, or that
a familiar replied or failed in another chat.

A run belongs to the familiar it was sent to. If you switch to another familiar while it's live:

- that familiar's row in the familiar list reads **Responding…**;
- the status beside the composer names them and says the composer is free once their run finishes
  or is stopped;
- the thread you're viewing doesn't claim the run.

When that run ends, their row reads **New reply** (or **Run failed**) until you open them again. A
run you stop yourself leaves no marker. While the familiar list is collapsed, its tab carries a
count of these runs so you don't miss them.

## Errors and connection details

Connection diagnostics stay collapsed during normal use. The collapsed connection details have a
**Copy** control, for a bug report.

Error notices have **Copy** and dismiss controls. A notice also clears on your next send, when you
switch familiars, or when you refresh. When a chat's history couldn't be read, its notice offers
**Reload chat**, which reads that chat again without refreshing everything.

## Drafts

Unsent drafts are kept per familiar, in memory only. They survive switching familiars but not
closing the window. Conversation content never reaches browser storage (see `SECURITY.md`), and
only the selected familiar and your **Settings** choices are remembered across restarts.

Select a passage inside one message, yours or a reply, and **Quote selection** appears above the
composer, after the conversation in the tab order. Choosing it adds the passage to the end of the
shown familiar's draft as Markdown quote lines (`> `), with a blank line before and after, and puts
the cursor after it. The draft's existing text and attached files stay as they were, and nothing is
sent. A quote is ordinary draft text: edit or delete it before sending like anything else you type.

- A selection that reaches past one message, or into a name, a **Copy** control, a code block's
  language bar, tool activity, a notice or an attachment card, offers no quote.
- A quote, with its `> ` marks and blank lines, can be up to 4,096 bytes, and the message must stay
  within the 32,768-byte limit. Past either, nothing is added and the action says why. A passage is
  never shortened to fit.
- If the passage changed or left the chat, or the familiar or chat changed, before you choose the
  action, nothing is added and the action asks you to select the passage again.
- **Dismiss quote** or Escape closes the action. While a passage waits to be quoted, the
  conversation holds its place instead of following a streaming reply.
- The selection is held in memory only while the action is open, and is never stored.

## When the list is empty

With a connected CLI but no familiars configured, the empty thread and the composer say so instead
of asking you to select from an empty list. The empty thread and the empty familiar list each
offer **Check for familiars**, which refreshes Coven.

Without a connected CLI, the empty familiar list says to connect rather than to configure a
familiar, and the empty thread and list offer **Check again** instead. When the Coven CLI or its
engine isn't installed, the empty thread also shows the one command that installs it
(`npm install -g @opencoven/cli` or `coven engine install`) with a **Copy** control. Chat never
runs it for you: run it in a terminal, then choose **Check again**.

## Settings

Open **Settings** with the gear above the familiar list or in the thread header,
or press **Cmd/Ctrl+,**. It has six sections:

- **General:** text size and **Group tool calls**.
- **Chats:** **Show archived chats**.
- **Access:** the projects Coven declares for the selected familiar.
- **Devices:** the **iPhone companion**.
- **Shortcuts:** every keyboard shortcut.
- **About:** the app version, whether Chat reached the Coven CLI, and what the
  window stores.

## First-run setup

Before the chat opens, Chat checks what it needs:

- **Coven:** the Coven CLI is installed.
- **Engine:** the Coven engine is installed.
- **Sign-in:** a model provider is signed in, through the engine's own sign-in, a Claude
  subscription in Claude Code, or ChatGPT.
- **Familiar:** at least one familiar exists.

When everything is in place, you see no setup screen and the chat opens as usual. Otherwise
**Set up Coven Chat** lists each step, and Chat can complete the first two itself.

**Install Coven:**

1. Chat downloads Coven's pinned release for this computer from `github.com/OpenCoven/coven`.
2. Before unpacking, it checks the download against a SHA-256 built into Chat.
3. It installs only the release's own executables, into `~/.local/bin` on macOS and Linux, or
   `%LOCALAPPDATA%\Programs\OpenCoven\Coven` on Windows. Chat already looks for Coven in both.
4. It then goes straight on to install the engine.

**Install the engine:** Chat runs `coven engine install`, which downloads and verifies the engine
itself, and shows its output as it goes.

**Controls:**

- Each install shows its progress; choose **Cancel** to stop it.
- A failed step says why and offers **Try again**.
- **Install it in a terminal instead** shows the command for each step, if you'd rather run it
  yourself.

**Sign in:** sign-in uses accounts you already have.

- **Sign in with Claude:** with Claude Code installed, this runs Claude Code's own browser sign-in
  for your Claude subscription. Without Claude Code, setup shows Anthropic's installer command
  instead.
- **Sign in with ChatGPT:** once the engine is installed, this runs the engine's ChatGPT sign-in.
- **Fallback link:** both tools open your browser themselves. If one prints a link instead, setup
  shows it with a **Copy** control.
- **Finder launches:** Chat tells the engine where Claude Code is, so runs started from a Chat
  opened in Finder still reach it.

**A familiar:** once Coven is installed, name your first familiar and choose **Create familiar**.
Coven adds it to its list of familiars and creates its workspace, and the chat opens when every
step is done. If the name is already taken, or has no letters or numbers, setup explains why in
plain words and changes nothing. **Check again** re-runs every check, and the chat opens as soon as
they pass.

Coven and its engine are required. When only sign-in or a familiar is missing, **Continue to Chat**
opens the chat anyway. That way a sign-in the check can't see, such as an API key in the
environment, never blocks a working setup.

The checks start Coven, the engine, and Claude Code only to ask their status. Chat installs
something only when you choose **Install Coven** or **Install the engine**. Sign-in always happens
in your browser, with the provider; Chat never sees your password or keys.

## Local runtime

The desktop host owns access to Coven. The browser doesn't execute commands, receive credentials,
or connect directly to a daemon. `pnpm dev` and `pnpm preview` render the same interface but can't
reach your installed CLI. Use the desktop app for runtime operations.

The interface shows actual runtime results, not sample familiars, fabricated activity, or timed
assistant replies. When a capability is unavailable, Chat says so instead of simulating it.
Installing Coven doesn't configure a model provider, so complete any provider setup your CLI needs
before you start a run.

Runs use Coven's bundled `coven-code` engine with explicit read-only permissions. Chat doesn't
grant write access or simulate approval controls. The native runtime supports macOS, Linux, and
Windows. Every run's process tree is contained (as a process group on macOS and Linux, and as a
kill-on-close job on Windows), so **Stop** ends the Coven CLI together with everything it started.

The frozen SDK artifacts stay pinned. Chat doesn't expand their existing health and conformance
contracts into undocumented chat methods, and the standalone runtime doesn't fall back to Cave.

## Persistent familiar chats

In the familiar list, each familiar has one persistent conversation. Select a familiar to return to
that thread. There's no separate familiar selector or new-conversation chooser.

Rows are ordered by the most recent activity Coven reports, and each row's caption says how long
ago that was. Hover over a caption for the full timestamp; the captions age on their own while the
window stays open. Familiars whose chats carry no readable timestamp come after the rest, in the
CLI's order. Hovering a row shows the familiar's purpose.

The search box matches a familiar's name, identity, or purpose. From the search box, **Enter**
opens the first match, **Escape** clears the filter, and the arrow keys move into and along the
list. A search that matches nothing offers **Clear search**. Choosing a familiar, by click or by
**Enter**, puts the cursor in the composer as soon as their thread is ready. A row whose familiar
has unsent text leads its preview with **Draft:** and that text.

The thread header captions the familiar's name with when their chat last moved (hover for the full
timestamp). An empty thread shows the familiar's purpose under its heading.

The inspector's Overview shows:

- the familiar's purpose, identity, and workspace, each path with its own **Copy** control;
- whether their chat is active, archived, or not yet started;
- the chat's last activity.

Activity reports the run state, and how the most recent run in this window ended and how long it
took. It also counts the messages you sent, the replies, and the tool calls (with failures and a
breakdown by tool) in the loaded transcript. This CLI integration doesn't report tokens, cost, or
timing.

When Chat holds only the most recent part of a chat's history, a quiet line at the top of the
thread says so. Nothing has failed, so it isn't an error notice. **Load earlier turns** reads the
chat again with two, three, and then four times the usual budget of sessions and bytes, and keeps
the transcript on screen, with your place in it, while it loads. Past that, the line points you to
the Coven CLI for the rest. Opening another chat starts again from the usual budget.

Chat and Cave are separate applications. There's no Cave import action or runtime import command,
and Cave history doesn't appear in Chat. Chat doesn't automatically delete previously saved import
files or submit them to a model. Only app-owned history can become a familiar's one Chat thread.

Claude Code and Codex threads continue from the harness's own session store. The bundled Coven
Code engine can't reopen a thread's earlier turns that way. So when you continue a Coven Code chat,
Chat replays the most recent turns from its saved transcript into the new run: newest turns first,
up to 24 KiB, with each message capped at 4 KiB. It also adds a notice to the thread saying how many
turns were replayed and whether older ones were left out. That notice is a quiet line between
messages, not a reply from anyone. The saved transcript keeps only your original message, not the
replayed prompt.

The chat's actions live behind the **Chat actions** control, the ⋯ in the thread header. Focus
returns there after the delete dialog closes. **Archive chat** keeps the saved history and removes
the familiar from the familiar list. An archived chat shows **Restore chat** in the header itself,
since restoring is what lets you send again. The familiar list shows active chats; turn on **Show
archived chats** in **Settings › Chats** to list archived ones instead. Archived history is
preserved, and archive state survives refreshes and app restarts.

**Delete chat** asks for confirmation and is strictly app-local. It removes every saved transcript
the chat is made of (Chat saves one per message you send), the attachments sent in the chat, and
that chat's local draft. Once per launch, Chat also removes what chats deleted in v0.0.5 or
earlier left behind, and staged attachment copies that no saved message names.

What deleting does and doesn't do:

- It doesn't delete the original Coven CLI database records or files, or change Cave history.
- A permanent tombstone prevents rediscovery or restoration of the deleted thread. Deleted
  ancestors aren't replayed through a remaining chat's captured history chain.
- It isn't secure erasure of backups or provider history.
- Lifecycle storage is private, atomically replaced, and bounded to 10,000 entries / 2 MiB. Corrupt
  or full storage reports an error rather than forgetting tombstones.
- Lifecycle actions wait until every active run, including cancellation cleanup, has finished.
  Deleting a chat never cancels an agent.

## Attachments and formatted replies

Use the compact **+** attachment button beside the message field, or drag files onto the
conversation. A drop goes through the same checks as the picker, and a file dropped anywhere else
in the window is ignored rather than opened. Selected files appear as cards with their filename,
size (in KiB above a kibibyte), and a remove control. Sent messages keep their file cards in the
transcript.

A message can be up to 32,768 bytes. Past that, the composer warns you before you send, naming the
exact byte count, since Coven would refuse it. The composer accepts up to four UTF-8 text or code
files, each at most 64 KiB. Chat validates the selected bytes and passes them to Coven as actual
file contents, not just filenames. You can send files with or without a message. The `coven-code`
engine doesn't accept image or PDF input through this transport, so Chat rejects binary files.

Unsent attachments stay in the current window. Failed or cancelled sends keep them available to
retry or remove; successful sends keep filename and size metadata in history. Native staging is
private and bounded to 64 MiB of retained files, and your originals are never modified.

Sending clears the submitted text and attachment cards immediately, so you can compose the next
message while the familiar responds. A failed or cancelled send restores its attachments, and
restores its text only if you haven't edited the new draft; later edits are never overwritten.
While a failed run's error notice shows and the restored text or attachments are still in the
composer, the notice offers **Try again**, which sends them once more. What Coven reported about
the failure stays as the last line of the chat, with its own **Copy** control, so it's still there
after you dismiss the notice or reopen the app. When Coven gave no reason, the line says so.

Assistant replies render Markdown headings, lists, emphasis, quotes, code, tables, and task lists.
Wide code and tables scroll inside the message. Raw HTML is disabled, and remote Markdown images
aren't fetched automatically. Only web (`http` and `https`) links and in-page `#` links stay links;
any other destination shows as plain text. Each reply has a **Copy** control that copies its
Markdown source, and so do your own messages. Each fenced code block names its language and has its
own **Copy** control for the code alone. The control reports "Copied" only after the clipboard
accepts the text, and "Copy failed" when it doesn't.

A web link in a reply never opens straight from the message. A click, a middle or modifier click,
or Enter on a focused link first shows **Open this link?**. It names the site on its own line, shows
the full address as plain text, and shows the link's own text when that differs. A Markdown title
never stands in for the address, and when text before an `@` could pass for the site, the review
says which site the link reaches. Chat doesn't rate the site or fetch anything from it.

- **Open** asks the window to open exactly the address shown, once. Chat can't confirm that a page
  opened, so it never says one did. If nothing appears, use **Copy address** and paste it into your
  browser.
- **Copy address** says "Copied the address." only after the clipboard accepts it. When the
  clipboard refuses, the review says so and you can try again.
- **Cancel**, Escape, or a click outside closes the review and returns you to the link.

Switching familiar or chat closes an open review, and so does its message going away; focus then
returns to the conversation. Chat won't open or copy an address over 8,192 bytes once encoded, or
one that isn't a complete web address, and never shortens one to fit; the reply's **Copy** still
copies it as written. Because links in a reply carry no address of their own, the right-click menu
offers only text actions. Chat keeps no address after the review closes.

Each table in a reply has two controls above it. **Copy table Markdown** copies that table's
source exactly as the reply wrote it, escapes, alignment markers, links and inline code included,
and reports "Copied" or "Copy failed" like the other Copy controls. **Expand table** opens the
table in a sheet over the window, labeled as the table as it read when you expanded it: the reply
can keep streaming behind it, but the sheet doesn't change until you close it and expand again.
The sheet scrolls both ways; the conversation and composer stay where they were. Links in the
sheet go through the same **Open this link?** review, and Escape closes only the topmost of the
two. **Close**, Escape or a click outside returns you to the Expand control. Switching familiar or
chat, or the message going away, closes the sheet and returns focus to the conversation. One table
is expanded at a time. Rows stay in the order the reply gave them; there is no sorting, filtering,
editing or file export, and Chat keeps nothing about a table once the sheet closes. Chat offers
the two controls for tables up to 2,000 rows, 64 columns and 256 KB of source, and only when it
can match the table to its exact source in the reply (a table inside a quote, for example, can't
be matched). Past that it says so above the table, which still renders and scrolls, and the
reply's **Copy** still copies everything.

Tool calls appear as activity rows between the prose. Each row expands to the call's input and,
once reported, its result, with each block labeled and given its own **Copy** control. The turn's
header counts the calls it holds and how many failed, whether or not the list is folded.

The runtime can also report a call as data rather than as a `⚒ Name(args)` line: a `tool_start`
frame from the bundled engine, a `tool_use` block in an assistant message, or a `tool_result`
frame. In that case the row also shows the input (cut at 16 KiB, with a note saying so) and, once
reported, the result (a collapsed row says how many lines it holds). The run status also names the
tool that's executing while its row is marked as running.

A run of more than ten consecutive calls folds to its newest six, behind a control that says how
many earlier calls it hides and how many of those failed. By default, two or more calls in a row
also fold into one summary line, such as "Ran 4 commands and read 2 files". Click it to see each
call, or turn off **Group tool calls** in **Settings › General**. The bundled engine's Claude CLI
provider reports calls as text only, so those rows carry the one-line summary alone.

## Missions

The inspector's **Missions** tab asks the selected familiar to look into something in a project,
without a chat. A mission is read-only: Coven runs it on this computer with tools that can only
read files, so it can't change files, run commands, or use paid cloud services. Chat sends it
through your installed Coven (`coven missions`) and shows only what Coven reports.

1. Give the mission a title, say what to look into, and choose a project folder and a time
   limit. The folder list offers the familiar's declared projects.
2. **Review mission** shows exactly what will be sent: the familiar and the version Coven has on
   record for it, the project, how it runs, and the time limit. Nothing is sent until you choose
   **Send mission**.
3. The mission then shows Coven's state for it, such as *Waiting to start*, *Running*,
   *Finished* or *Couldn't run*, with the reason in plain words. **Cancel mission** stops one
   that hasn't finished.

The current Coven records missions but can't run them yet, so each one ends as *Couldn't run*
with "Nothing ran". Chat says so instead of showing progress that didn't happen.

When Chat can't confirm that Coven received a mission, the mission shows *Checking whether Coven
received this mission* and Chat keeps asking with the same request. It never reports that nothing
happened until Coven confirms it. If the familiar changed after you reviewed a mission, Coven
refuses it, and Chat asks you to review it again.

When the familiar can't take a mission, the tab says why and offers **Try again**. That happens
when Coven is too old to have missions, isn't running, or doesn't know the familiar yet. For the
last case, the tab shows the `coven familiar-ledger register` command to run.

Chat keeps each mission's keys in a private folder, so it shows the mission again after a
restart and can still learn the outcome of one it was sending when it closed (see
`SECURITY.md` and `docs/mission-storage-design.md`). **Remove** forgets a finished mission. The
window never receives those keys, and no mission text reaches browser storage.

## Remote screen (VNC)

The **Show screen** button in the thread header opens a viewer pane above the transcript. Enter the
WebSocket address of a VNC server that speaks the noVNC transport (for example, the `websockify`
endpoint of a Daytona sandbox, with its access token in the query string) and an optional password,
then choose **Connect**. The desktop appears scaled to fit and starts in **view only** mode; clear
that toggle to send mouse and keyboard input. The status line names the desktop the server
reports. A failure names the reason the host saw: an HTTP status instead of a WebSocket upgrade, a
refused or timed-out connection, a handshake that didn't complete, or a server that rejected the
password.

The window never opens the connection itself. The desktop host performs the WebSocket upgrade,
forwards opaque frames both ways, and reports the close. The host:

- adds no credentials or headers and follows no redirects;
- refuses anything but `ws://` and `wss://`;
- caps a message at 64 KiB upstream and 16 MiB downstream;
- holds at most two screens per window.

Its error messages never repeat the address, because the address may carry a token. The address
and password live only in the pane while it's open. Closing the pane, switching away, or closing
the window drops the connection, and nothing is written to browser storage. In the browser
(`pnpm dev`), the pane says that screen viewing needs the desktop app.

The VNC client is [noVNC](https://github.com/novnc/noVNC) 1.7.0, vendored
under `src/vendor/novnc` (MPL-2.0); see its `README.md` for provenance.

## Familiar avatars

Your familiar's portrait lives at
`~/.coven/workspaces/familiars/<familiarName>/avatars/<familiarName>.png`.
The verified directory is `avatars`, not `assets`. Chat resolves it from the workspace Coven
reports, rather than assuming your home directory or ignoring a custom Coven home.

The desktop host makes a small PNG thumbnail for the interface without changing your original
file. It recognizes PNG or JPEG content, including JPEG portraits saved with a `.png` filename. A
familiar without a portrait keeps its initial as a fallback, and the webview never receives general
filesystem access.

Click the familiar's avatar or name beside an assistant reply to open their overview card in the
inspector without leaving the conversation.

## Existing local data

Earlier development builds kept chats and notes in an IndexedDB database
named `opencoven-chat`. This app doesn't read, convert, or delete that
database, and never sends its contents to a model. The production application
identifier is still `ai.opencoven.chat`; no demo identity replaces it.

## Developer setup

You need Node.js `24.18.1`, `pnpm` `10.34.0` through Corepack, Rust `1.95.0`
with `clippy` and `rustfmt`, and your platform's Tauri dependencies. See
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

Runtime operations cross typed, narrowly scoped Tauri commands. Chat exposes no generic shell,
filesystem, or HTTP command to the webview, and grants no Tauri shell, filesystem, opener, or
network plugin permission. The main window's capability, `src-tauri/capabilities/default.json`,
lets it invoke only:

- the seven `coven_runtime_*` commands the chat interface uses,
- the eight `mission_*` commands that send one read-only familiar mission, follow it,
  cancel it and remove it (#155), which keep each mission's keys on the native side,
- the four `setup_*` commands of first-run setup,
- the five `companion_*` commands of the opt-in iPhone companion,
- the three `coven_screen_*` commands of the screen relay,
- Tauri's event listen and unlisten, so the window can follow runs started
  from the iPhone,
- Tauri's permission to set its own window title.

The Cave adapter and app-identity commands stay registered for native and conformance coverage,
but the webview can't reach them.

The reviewed Cave adapter stays in the repository for its independent native and conformance
coverage. The single Chat entrypoint doesn't start it, pair with it, or require its credentials.
Removing the old UI modes doesn't rewrite the protected release evidence or broaden existing trust
boundaries.

## Protected conformance

The product UI and the historical Phase 1 release gate are separate.
[`docs/phase1-conformance.md`](docs/phase1-conformance.md) documents the
immutable native gate and real-authority three-platform matrix.

`contract-canary.lock.json` pins reviewed SDK and Cave commits, packed
tarball digests, and the Client v1 authority fixture.
`phase1-conformance.lock.json` independently pins the real-authority release
candidate. Neither lock pins the chat interface in `src/coven/`, so changes
there need no repin.

```bash
pnpm test:contract-canary -- --sdk-root <sdk-root> --cave-root <cave-root>
/bin/sh scripts/phase1-conformance-launcher.sh "$(command -v node)"
pnpm test:native-e2e
```

Conformance requires the exact counterpart checkouts and platform authority
described in its guide.

> **Note:** A successful local UI build is not evidence of a successful protected conformance run.

## Delivery and releases

For open work, see [GitHub issues](https://github.com/OpenCoven/chat/issues).
For shipped changes, see [`docs/release-notes/`](docs/release-notes/).
[`docs/roadmap.md`](docs/roadmap.md) is a dated log of September 2026
conformance and consolidation checkpoints, not a current plan.

CI runs frontend, browser, Rust, packed-artifact, and native lifecycle coverage. The heavy Phase 1
Vitest suites test the conformance scripts rather than the app, so a pull request runs them only
when it changes something outside the chat UI, the browser suite, or prose. Every push to `main`
runs them regardless.

Releases are cut from signed `v*` tags through
[`.github/workflows/release.yml`](.github/workflows/release.yml). The
[release guide](docs/releasing.md) covers platform bundles, signing,
checksums, rehearsals, and recovery.

## iPhone companion

Open **Settings › Devices**, choose **iPhone companion**, then **Turn on companion** to enable
local pairing. The native iPhone app reads your Chat conversations, sends text, streams replies,
and stops runs through the same Coven runtime on your Mac. Keep both devices on the same local
network, with the Mac awake. See [pairing, builds, and verification](docs/iphone-companion.md).
