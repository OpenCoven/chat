# Verification record: the Rakazo-inspired Chat UX slice (#480 / #485)

Evidence for chat#485, gathered on 2026-10-18 and 2026-10-19 on one exact combined candidate.
Everything here is **source plus browser-engine evidence**. Nothing in this record is desktop,
packaged or released evidence unless a row says so in as many words.

## Candidate

| Fact | Value |
| --- | --- |
| Base | `main` @ `bbdb1108` = `f9e5d423` + #488 squash `cdb98ce3` (quote selection) + #486 squash `bbdb1108` (link review, including the clipboard fix below). Both merged by Val on 2026-10-19 while this record was being gathered. |
| Candidate commit | `9a3ed664cb04859505d3cac7a008c47b70317c5d`, tree `1536f09830b5e5bf5b856ff42e63ae1a9b29b7d5`, branch `review/candidate-480`. The same tree was first built as `f77db71c` (with #489 @ `e85c2301`, an identical tree) under a stray test identity that the repo's shared `.git/config` carried; the merges were redone as `9a3ed664` with the right author. Results taken on `f77db71c` hold for `9a3ed664` because the trees are byte-identical. |
| #481 link review | **merged** as `bbdb1108` (PR #486) |
| #482 quote selection | **merged** as `cdb98ce3` (PR #488) |
| #483 tables | PR #487 `feat/markdown-table` @ `35e004e0` (`e1b422e3` the feature + `35e004e0` fix: snapshot keeps reference links resolved outside the table's source slice). **Merged** by Val as squash `72a64036` at 03:21Z, after this candidate was built; `git diff` of the candidate against that `main` is exactly the #489 files plus this record and the new test, so the merged content is byte-identical to what was verified. |
| #484 inspector resize (optional, retained) | PR #489 `feat/inspector-resize` @ `72b6e252`, rebased onto `bbdb1108` (re-authored from `e85c2301`, same tree `5bf07bfb`). **Merged** as squash `4342d2ad` at 03:45Z; after it, `git diff` of the candidate against `main` is exactly this record and the new test, so every merged child is byte-identical to what was verified. |
| Merge order | `origin/main` → #487 `35e004e0` → #489 `72b6e252`; each a signed `--no-ff` merge; no conflicts |
| Earlier candidate | `46e2e59f` (`f9e5d423` + the four branch heads before the merges). It differs from the final tree only by #487's fix commit (`formatted-message.tsx`, `markdown-table.tsx`, `markdown-table.test.tsx`); the rows below say which candidate each result was taken on. |
| Lockfile | `pnpm-lock.yaml` sha256 prefix `5def67e3d18bbf75`, identical to `main`'s; no dependency change |
| Toolchain | Node 24.18.1, pnpm 10.34.0 (corepack), TypeScript 6.0.3, Vite 8.2.1, Vitest 4.1.11, Biome 2.3.2, Playwright (Chromium) |
| Machine | macOS 26.7.1 (25G241), arm64. The volume sat at 100% with 5–8 GB free and the load average was 35–55 from sibling sessions throughout. |
| Native side | `src-tauri/` unchanged from `main`: tauri 2.11.2, wry 0.55.1 per `src-tauri/Cargo.lock` |

Every commit on the candidate verifies (`git log --format=%G?` from `origin/main` prints `G` for all five).

## Diff and contract review (lane: Diff/contract review)

`git diff --name-only origin/main 9a3ed664`: 15 files, all under `README.md`, `e2e/` and `src/coven/`
(the merged #486/#488 added `src/test/watch-navigation.ts` on `main`). Checked and **absent** from the
candidate's diff over `main`, and from the two squashes over `f9e5d423`: `package.json`,
`pnpm-lock.yaml`, anything under `src-tauri/` (commands, capabilities, CSP, `Cargo.*`), `.github/`,
`src/lib/sdk/`, `vendor/`, `contract-canary.lock.json`, `phase1-conformance.lock.json`, `biome.json`,
`vite.config.ts`, `tsconfig.json`.

Storage: the only new write to browser storage in the whole slice is the numeric `inspectorWidth`
inside the existing `opencoven.chat.preferences.v1` display preference (`src/coven/preferences.ts`,
validated by `preferredInspectorWidth`). No `fetch`, `sendBeacon`, `indexedDB`, `sessionStorage` or
logging of conversation content was added (grep of the added lines in `src/`; the only `Storage`
references are in tests asserting that nothing was stored).

Authority: no new Tauri command, capability or opener. **Open** in the link review is the same
`target="_blank"` anchor hand-off the renderer already used, bound to the reviewed address. Chat still
installs no `on_new_window` handler, so on the pinned wry the request is dropped on all three desktops
(see #486's source trace); the review says it cannot confirm a page opened and offers Copy address.

## Defect found and fixed during this acceptance (owner #481, now on `main`)

**Dishonest copy behind a modal.** `copyText`'s fallback (used when the async clipboard is missing or
refuses) appended a hidden `<textarea>` to `<body>`, selected it and ran `execCommand('copy')`. Behind
an open `<dialog>` the body is inert, so the textarea never took focus, the command copied either
nothing or the reader's own selection, and still returned `true`: the link review said "Copied the
address." and the table sheet's Copy said "Copied" while the clipboard held old text. Found by the
sibling review session in Chromium on `f9e5d423`+#486+#487+#488 with `writeText` stubbed to reject.
Fixed in #486 commit `2de91f1f` (in `bbdb1108`): the target joins the open dialog that holds focus,
and a copy counts only when the target holds focus and all of its text. Regressions:
`src/coven/copy-text.test.ts` (2 cases, red → green) and the e2e case "copies the reviewed address
honestly when the async clipboard refuses" (red → green). #487's sheet inherits the fix; it has no
sheet-specific clipboard regression.

A second fix landed on #487 from another session during the same window (`35e004e0`): the expanded
sheet used to re-parse the table's source slice alone, which lost reference-style link definitions
written elsewhere in the reply; it now retains the parsed table content, with a regression in
`markdown-table.test.tsx`.

## Cross-feature review of the combined journey

Read against the merged source, then pinned by `src/coven/chat-ux-integration.test.tsx` (6 cases,
added on the candidate; see below). Each row names the seam and what holds it.

| Seam | Finding |
| --- | --- |
| Quote + link review | Text inside the review dialog is never a passage: `dialog` is in the quote resolver's chrome list. A link's own text in the reply is quotable. Releasing a selection over a link selects, it does not open the review (`selectionTouches` guard). A capture made before a review opened survives the review's open/close and quotes once. |
| Quote + tables | Cell text in a reply's table quotes; the Expand/Copy bar is `button` chrome (and `user-select: none`) so it never does. Text inside the expanded sheet never quotes (`dialog`). |
| Link review inside the sheet | The review is a DOM descendant of the sheet, so `showModal` stacks it above. Escape closes only the topmost; focus returns to the link, then to Expand. The sheet reacts to `close`/`cancel` only when `event.target === event.currentTarget`, because React carries a nested dialog's events up the component tree although the DOM does not bubble them. |
| Chat switch with everything open | A familiar or chat change (the layout's `LinkReviewContext.key`) closes the review and the sheet, clears a waiting quote, releases the one-sheet-at-a-time token, and focus lands on the new conversation's log. |
| Inspector handle + dialogs | Keys on the separator are ignored while any `dialog[open]` exists; a drag in progress ends on `lostpointercapture` when a modal takes the window. The sheet (`width: min(1200px, 100vw - 32px)`) and review (`min(520px, …)`) size from the viewport, not the rail. |
| Resized rail and the composer | The settled width is `min(preferred, shell − left track − 440)`, never under 280, so the conversation column (transcript and composer) keeps 440px in the wide tier; the handle exists only in that tier. At 480×520 the layout is the compact drawer tier and has no handle. |
| Draft overwrites | `onEditDraft` edits the draft as `navigationRef.current` holds it, only for the same familiar and session, bumps `draftVersions` and clears `retryKey`; a failed or cancelled send cannot restore over a quote. |
| Stale selections | The capture records familiar, session, message id, role, message text, region element and passage, and re-checks all of them at activation; message ids are event indexes that repeat across chats and are never trusted alone. |
| Storage after the journey | `localStorage` holds exactly `opencoven.chat.preferences.v1` = `{textSize, groupTools, inspectorWidth}`; no passage, address, table or draft text; `sessionStorage` empty. |

No new defect beyond the two above was found in the combined source. Known limitations, reported and
left as they are (details in the #481 combined review,
[issuecomment-6258932702](https://github.com/OpenCoven/chat/issues/481#issuecomment-6258932702)):

- An IPv6 literal link (`https://[::1]:8080/x`) is refused, because Markdown percent-encodes the
  brackets and the result does not parse; the refusal wording ("isn't a complete web address") is
  inaccurate for that case. Nothing opens or copies, so it fails closed.
- The review's **Open** control is a real anchor, so a webview's native context menu ("Open Link in
  New Window") can act on it past the one-press guard. It can only ever target the reviewed address.
  Playwright cannot exercise a native menu; this is a packaged row.
- When a reply re-renders and react-markdown recreates the link element, a review's return focus goes
  to the conversation log (the "safe surviving control") rather than the redrawn link.

### The cross-feature regression

`src/coven/chat-ux-integration.test.tsx` renders the real `ChatLayout` with a reply that holds a link,
a table and a link inside the table, and covers the seams above. It passes on the candidate tree. It has
teeth: removing `dialog` from the quote chrome list fails the "no quote from inside the review or the
sheet" case; removing the sheet's `event.target !== event.currentTarget` cancel guard fails the stacked
Escape case; removing the resizer's open-dialog check fails the inspector case (each mutation applied,
run, and reverted).

## Unit and component lane (lane: Unit/component)

Run in `.worktrees/candidate-480`.

| Command | Candidate | Result |
| --- | --- | --- |
| `corepack pnpm typecheck` | `f77db71c` | passed |
| `corepack pnpm lint` | `f77db71c` + the new test file | exit 0 after formatting the new test file; 1 warning + 4 infos, all pre-existing on `main` (`chat-app.css:910` descending specificity, 4× `useTemplate` in `client-v1-conformance-workflow.test.ts`) |
| Targeted: `chat-layout`, `formatted-message`, `external-link-review`, `markdown-table`, `quote-selection`, `quote-action`, `inspector-width`, `chat-app`, `copy-text`, `chat-ux-integration` | `f77db71c` | 10 files, 326 passed |
| `corepack pnpm test:unit:normal` | `9a3ed664` | 76 files: 72 passed, 3 skipped (the `windows-*` files, whose `pwsh` probe failed), **1 failed**: `client-v1-conformance-workflow.test.ts`, 21 cases, every one a `pwsh` spawn that died with the `FileLoadException` below. 1,367 tests passed / 80 skipped / 21 failed. No failure touches a changed file; the same file is green in CI's *Web checks* on #487 `35e004e0` and #489. |
| `corepack pnpm test:unit:heavy` | `9a3ed664` | 4 files: 2 passed, 1 skipped, **1 failed**: `phase1-conformance.test.ts`, the one `pwsh`-spawning case named below. 921 tests passed / 35 skipped / 1 failed. Both conformance lock suites passed. |
| `corepack pnpm build` | `f77db71c` (as e2e's web server step) | passed; `dist/` digest (sha256 over the sorted file digests) `171d8233d52bed74ac3d7a2ddc7053b3a85a948534b5e0b2991b1a06da2ac7d7` |
| `git diff --check origin/main HEAD` | `f77db71c` | clean |
| Earlier, on `46e2e59f`: typecheck passed; lint exit 0 with the 5 pre-existing diagnostics; targeted 9 files 319 passed; normal 76 files, 1398 passed / 61 skipped / 8 failed in 5 files; heavy 920 passed / 35 skipped / 2 failed; build passed, `dist/` digest `c1a28588…`; `git diff --check` clean | `46e2e59f` | The failures were child-process spawns under load average 40+: rerun alone, `connection-controller.test.ts` 40 passed and `windows-supervisor-source.test.ts` 7 passed / 8 skipped. |

**Environment, not candidate:** the Phase 1 harness case "passes Windows Job name and PID as exactly
two PowerShell arguments" fails on this Mac on `main` and on the candidate alike, because the Homebrew
`pwsh` crashes on launch with `System.IO.FileLoadException: The given assembly name was invalid`
(reproduced by invoking `pwsh` directly, 0.13 s). No PR touches those files. CI's *Web checks* job ran
both suites on the exact candidate head `d2c9c8f6` and passed (see "CI on the exact heads"). Skipped
tests in the `windows-*` files mean "not run here", not passed.

## Browser production preview lane (lane: Browser production preview, Chromium)

`corepack pnpm test:e2e` builds the candidate and serves it on 127.0.0.1:4174, then drives Chromium.

| Command | Candidate | Result |
| --- | --- | --- |
| `corepack pnpm test:e2e` | `f77db71c` (tree `1536f098`) | **70 passed** in 25.3 s, exit 0: the 66 cases from `f9e5d423` plus the link review, honest-copy, table sheet and inspector resize cases, and the quote case. Port 4174, no retries. |

Covered there, in Chromium: no page opens until **Open**; only the reviewed address opens and only
once; the fallback copy is refused honestly behind the modal; the sheet fits a 480px window with no page
overflow and the clipboard reads back the exact table source; a link inside the sheet is reviewed above
it; the transcript scroll position survives; the quote appends from pointer and keyboard and never
sends; the inspector resizes by pointer and keyboard within the room the window leaves; contrast and
24px pointer-target rules hold in light and dark.

Chromium is not WKWebView, WebView2 or WebKitGTK. These rows prove the UI logic in one browser engine
and nothing about the desktop webviews.

## CI on the exact heads

Read over REST (`repos/OpenCoven/chat/commits/<sha>/check-runs`) on 2026-10-19 around 03:20Z, while
the GraphQL budget was spent.

| Head | Changed paths | Contract canary | Web checks | E2E | Unix producer supervisor | Desktop build | Rust / Windows / Phase 1 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #487 `35e004e0` | success | success | success | success | success | success | skipped by path filter (no `src-tauri/` or workflow change) |
| #489 `72b6e252` | success | success | success | success | success | in progress at 03:29Z | skipped by path filter |
| `main` `bbdb1108` | the merged #486 and #488 ran their own CI green before Val merged them (every job green on `c976afb0` and `5ef3d5f6`) |
| **candidate** `d2c9c8f6` (tree `1536f098` + this record and the new test; PR #490, run [39194949333](https://github.com/OpenCoven/chat/actions/runs/39194949333)) | success | success | **success** | **success** | success | **success** | skipped by path filter |

The candidate row is the exact tree under review. Its *Web checks* job ran `test:unit:normal` and
`test:unit:heavy` on `ubuntu-latest` and passed, which covers the two files that fail on this Mac
only because its `pwsh` crashes (`client-v1-conformance-workflow.test.ts`, `phase1-conformance.test.ts`).
Its *E2E* job passed the same 70 Chromium cases on Linux. Its *Desktop build* job ran `pnpm app:build`
on `ubuntu-latest` and succeeded, so the exact tree bundles on Linux. That job uploads no artifact and
runs nothing, so it proves the build, not how the app behaves.

## Packaged desktop lanes

No packaged lane's behaviour rows were run on this candidate. The macOS bundle was built here and
launched once as a startup smoke under an isolated identifier; the Linux bundle was built in CI and
never launched; Windows was not built. Each lane's behaviour rows stay **unverified**, for the reason
given, and nothing above replaces them. The per-feature pending rows are kept on #485
([first set](https://github.com/OpenCoven/chat/issues/485#issuecomment-6258525498),
[additions](https://github.com/OpenCoven/chat/issues/485#issuecomment-6258933027)); the checklist
below is the macOS hand-run version of them for this candidate.

| Lane | State | Why, and what exists instead |
| --- | --- | --- |
| Packaged macOS (WKWebView) | **Built locally; launch smoke passed; in-engine probe in the real WKWebView passed the rows it can drive (see below); hand-driven rows unverified**<br>*2026-11-06: the published v0.0.8 DMGs (arm64 and x64) were run by native OS-level automation, not by hand; see [below](#native-os-level-automation-on-the-published-v008-installers-504-2026-11-06).* | A release `.app` of the exact tree was built here once the volume had 16 GB free (see "macOS build provenance"). It was not launched: this terminal has no Accessibility or Screen Recording grant, by Val's standing decision, so window steps are Val's to run by hand, and the built app is the one to run. The checklist below is written for that. |
| Packaged Windows (WebView2) | **Unverified** on this candidate<br>*2026-11-06: the published v0.0.8 MSI was run by native OS-level automation, not by hand; see [below](#native-os-level-automation-on-the-published-v008-installers-504-2026-11-06).* | No Windows machine in this session. Cross-compilation would not be runtime evidence. |
| Packaged Linux (WebKitGTK) | **Built, not run; unverified at runtime**<br>*2026-11-06: the published v0.0.8 `.deb` was run by native OS-level automation, not by hand; see [below](#native-os-level-automation-on-the-published-v008-installers-504-2026-11-06).* | The exact tree bundled on `ubuntu-latest` in CI run 39194949333 (`pnpm app:build`, *Desktop build* job, success). No Linux machine in this session to launch the bundle, and CI keeps no artifact. |

### macOS build provenance

Built 2026-10-19 03:42–03:44Z in `.worktrees/candidate-480` at `c4f6ce87` (tree `3d4c9001`: the
candidate tree `1536f098` plus this record and the new test; `src/` and `src-tauri/` identical to the
candidate), with `node_modules/.bin/tauri build --bundles app` (tauri-cli 2.11.4) and the pinned
toolchain on `PATH` (`rustc 1.95.0 (59807616e 2026-04-14)`, `cargo 1.95.0`). The frontend step
(`corepack pnpm build`, Vite 8.2.1) produced `dist/` with digest
`171d8233d52bed74ac3d7a2ddc7053b3a85a948534b5e0b2991b1a06da2ac7d7`, the same digest the e2e lane
built; its `index-D2bJ8htj.js` contains the slice's strings ("Open this link?", "Quote selection",
"Expand table", "Expanded table", "Copy table Markdown", "Resize inspector", "Couldn't copy the
address"). Tauri embeds that `dist/` compressed, so a plain grep of the binary finds none of them.
Cargo finished the `release` profile in 1 m 47 s from cached crates; `src-tauri/target` is 1.2 GB.

| Fact | Value |
| --- | --- |
| Bundle | `src-tauri/target/release/bundle/macos/OpenCoven Chat.app`, 17 MB, `CFBundleIdentifier` `ai.opencoven.chat`, `CFBundleShortVersionString` 0.0.5, `LSMinimumSystemVersion` 10.15 |
| Binary | `Contents/MacOS/opencoven-chat`, Mach-O 64-bit arm64, 17,317,344 bytes, sha256 `10b099001a60adb370cda4790411f75d8a18130b9a4dfcb6916a4a17c1172cbc` |
| Signature | ad-hoc, linker-signed (`flags=0x20002(adhoc,linker-signed)`), no Team ID, not notarized; CDHash `e21259c4c25e2dfb475efb37531204e901ab6df0`. A release build signs and notarizes in CI; this local build does not, so it runs from this path on this Mac but is not a distributable. |
| Native deps | tauri 2.11.2, wry 0.55.1 (unchanged from `main`) |
| Host | macOS 26.7.1 (25G241), arm64 |
| Launched | **Yes, once, as a smoke under an isolated identifier**, and the same tree ran under `tauri dev` for the in-engine probe. See the two sections below. The `ai.opencoven.chat` bundle itself was not launched. |

### macOS launch smoke (packaged, isolated identifier)

To see whether the packaged candidate starts on this Mac without touching Val's Chat data, the same
tree was bundled once more at 03:49Z with `tauri build --bundles app --config
'{"identifier":"ai.opencoven.chat.acceptance480","productName":"OpenCoven Chat Acceptance"}'`
(binary sha256 `1b4b4b87a4b690e9fae8b419a749aefad0cc6053061a86696a18732f26be585f`, CDHash
`79493d0ae11873ef4d3e3a8eac6b309fbe3234a6`; only the identifier and name differ from the bundle above),
then launched with `open -n` at 03:51:19Z and observed for 25 s from the terminal only.

| Observation | Result |
| --- | --- |
| Process | `opencoven-chat` pid 4470 alive at 25 s, RSS about 167 MB |
| WKWebView | `~/Library/WebKit/ai.opencoven.chat.acceptance480/WebsiteData/` was created with the usual `Default`, `IndexedDB`, `SearchHistory` and salt directories: the webview initialized its data store |
| Browser storage after first launch | no `*.localstorage` database existed, so nothing was written to local storage at startup |
| App storage | no `~/Library/Application Support/ai.opencoven.chat.acceptance480` was created (Chat writes there only once a chat exists) |
| Crash reports | none under `~/Library/Logs/DiagnosticReports` for the process |
| Exit | `SIGTERM` at 03:51:44Z; process gone within 3 s |
| Cleanup | the isolated `WebKit`, `Caches`, `HTTPStorages` and saved-state directories were removed; none remained |
| Not captured | the `runningboardd` "Now tracking" line (the `log show` query returned nothing in the window) and whether any pixels rendered. No Accessibility or Screen Recording grant exists for this terminal, by Val's standing decision, so nothing in the window was observed or operated. |

This proves the packaged candidate launches on macOS 26.7.1 arm64, brings up WKWebView, writes
nothing to browser storage at startup, and exits cleanly. It proves nothing about the eight behaviour
rows in the checklist below; those still need hands on the window.

### macOS in-engine probe (real WKWebView, synthetic input)

Run 2026-10-19 04:00Z and 04:02Z. The candidate tree ran under `tauri dev` with the isolated identifier
`ai.opencoven.chat.acceptance480` (Val's Chat data untouched) and a temporary, uncommitted hook in
`src/main.tsx` that, instead of the app, mounted the real `ChatLayout` with a synthetic reply (a link, a
list, a table holding a link) inside the real webview, drove it with synthetic DOM events, and posted
observations to a `/__probe` endpoint on the dev server. No Tauri IPC, no Coven CLI, no pixels observed,
no OS-level automation. The hook and its Vite config were deleted afterwards; nothing of them is in
this branch. The webview reported `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15`,
`__TAURI_INTERNALS__` present, `showModal`, `setPointerCapture`, `clipboard.writeText` and
`execCommand` all functions, a 1180×748 window, `document.hasFocus()` true. The first run stopped at
the quote step because the probe's own selection swept over the table's Expand/Copy controls, which
the resolver rejects by design; the second run completed every step.

| Row | Observed in WKWebView |
| --- | --- |
| Link review | Click opens *Open this link?*; `dialog.matches(':modal')` true; site `docs.example.test`, full address `https://docs.example.test/start`; initial focus on Cancel; `composer.focus()` while the modal is open does not land (inert background holds); Escape closes it and focus returns to the `span[role=link]`. |
| Open | One press: `aria-disabled="true"`, status "Chat asked to open this address but can't confirm that a page opened…", first button reads Close, still one open dialog. Second press: nothing. `runningboardd` logged **no** browser or other app launch in the window, matching the source trace that the pinned wry drops `target="_blank"`. |
| Copy address, Copy table Markdown, `copyText` | WebKit refused both `navigator.clipboard.writeText` and `execCommand('copy')` for a synthetic click (no user activation). Each time the UI said "Couldn't copy the address" or "Copy failed", never "Copied", and `copyText` returned `false`. None of the probe's texts reached the system pasteboard (`pbpaste` before and after). Whether a real click's copy succeeds is Val's row. |
| Quote across a paragraph and a list | `Selection.toString()` = `"Steps:\n\none\ntwo"`; **Quote selection** offered; draft became `> Steps:\n>\n> one\n> two\n\n`; composer focused after; `onSend` never called. |
| Quote and tables | A table cell alone quotes (`> alpha`). A sweep from the paragraph into the table (`"…two\nField\tLink\nalpha"`) offers no quote, because it covers the Expand/Copy controls. |
| Sheet with a review inside | Sheet `:modal`; review `:modal` and a DOM descendant of the sheet; Escape closes only the review and focuses the inner link; Escape again closes the sheet and focuses Expand. |
| Inspector by keyboard (wide tier) | ArrowLeft 360→376 px; End→440 px (= 1180 − 300 − 440; `aria-valuemax` 440); Home→280 px. The composer's box stayed inside the viewport. Pointer drag was not driven (a synthetic pointer id cannot hold capture). |
| Storage after the journey | `localStorage` keys: `opencoven.chat.navigation.v1` (the pre-existing selected-chat key) and `opencoven.chat.preferences.v1` = `{"textSize":"default","groupTools":true,"inspectorWidth":280}`; `sessionStorage` empty; no IndexedDB databases. |

What this does and does not prove: the real WKWebView engine runs the merged components as the jsdom and
Chromium suites say it should, for the rows above. It does not prove what a real pointer, a real
keyboard, the native context menu, VoiceOver, or a real Coven run do; those are the hand-run rows below.

### Hand-run checklist for the packaged macOS candidate (for Val)

*2026-11-06: these eight rows, with #504's IPv6 row, have since been run by native OS-level automation on the published v0.0.8 installers on all three platforms, not by hand; see the next section. The rows below are kept as written.*

Run the built app above (`open "src-tauri/target/release/bundle/macos/OpenCoven Chat.app"` from
`.worktrees/candidate-480`; it is ad-hoc signed, so Gatekeeper lets a local build run), or rebuild
from `review/candidate-480` with the pinned toolchain
(`PATH=$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH corepack pnpm app:build`).
Record the commit, the `codesign -dvvv` CDHash of the app, and the macOS version with each row. Use a
familiar whose replies are synthetic. The build shares `ai.opencoven.chat` storage with the installed
app; quit the installed Chat first.

1. **Link review.** In a reply with `[docs](https://docs.example.test/start)`: click, middle-click and
   ⌘-click the link. Each must show *Open this link?* and nothing else must open. Right-click: the menu
   must offer text actions only (no "Open Link"). Press **Open** once: note whether a browser opens
   (the source trace predicts it does not), and that the review says it cannot confirm a page opened.
   Press **Copy address**, paste into TextEdit: the exact address. A clipboard refusal is hard to
   stage in WKWebView; record "not staged" if none could be produced rather than marking the row passed.
2. **Dialog modality.** With the review open, the conversation behind it must not scroll or take
   clicks; Escape closes it and focus returns to the link (VoiceOver announces the link).
3. **Quote selection.** Drag-select inside one reply across a paragraph break, a list and a table cell:
   **Quote selection** appears above the composer; the inserted `> ` lines match the selection,
   including line breaks. Tab from the conversation to the action: the capture survives the focus
   move. Hold Enter on the action: one quote, no send. Switch Japanese input and compose after the
   quote: normal IME behaviour. Select across two messages: no action offered.
4. **Chat switch.** Select a passage, open an expanded table and a link review inside it, then switch
   familiars: all three go away, and the new chat's draft is unchanged.
5. **Tables.** **Copy table Markdown** pastes the exact source. **Expand table** opens the sheet; a
   link inside it opens the review above the sheet; Escape closes the review only, then the sheet;
   focus returns to the link, then to **Expand**. Resize the window to 480×520 with Settings → Larger
   text: the sheet fits, scrolls both ways, and the composer is still reachable after closing.
6. **Inspector resize.** In a wide window, drag the inspector's left edge: pointer capture holds while
   the pointer leaves the handle and releases outside the window; no text selects during the drag.
   Tab to the handle: VoiceOver reads a vertical separator with its value; Left/Right step 16px,
   Home/End reach the ends; Settings → General shows the width and **Reset** restores 360px. Narrow the
   window across 1100px with a 600px width stored: the rail becomes a drawer; widen again: 600px
   returns. The composer must be reachable at every width.
7. **Draft restoration against a real run.** Quote a passage during a run, then cancel the run: the
   quote stays and nothing sends twice.
8. **Storage.** After all of the above, the app's WebKit local storage must hold only the preferences
   key with a numeric `inspectorWidth`; no passage, address or table text.

## Native OS-level automation on the published v0.0.8 installers (#504, 2026-11-06)

These are **native OS-level automation** results from fresh GitHub-hosted runners. They are **not hand-run**. They were taken on the published **v0.0.8** release (tag `v0.0.8` → `a8c76390`), not on the candidate above. v0.0.8 contains all four children and #492.

How the lane works (`scripts/native-acceptance/`, added on `test/504-native-acceptance`):

- It downloads each published installer and checks it against the release's `SHA256SUMS` (sha256 `80ab3bd83f0cd203c9fd9eb331fb8ec095426a7bee9e05af6d58ebfc04b8bd28`).
- It installs the app for a runner user that has no prior `ai.opencoven.chat` data, then completes first-run setup through the window. That setup installs the real Coven CLI and engine.
- Input is the platform's own:
  - CGEvent at the HID tap on macOS
  - SendInput on Windows
  - XTEST on Linux
- The window is read back through AX, UI Automation and AT-SPI, and through VoiceOver, NVDA and Orca.
- No WebDriver is attached and no script runs in the page.
- Every word in the chats comes from a local model fixture. The addresses are `example.com`, `example.test` and `[::1]`.

A row is:

- **observed** when every check in it held;
- **failed** when a check did not hold. Each failure has a focused issue, and the row's other checks are listed;
- **blocked** when the lane could not stage that part.

Nothing blocked or unrun is counted as passed.

| Lane | Runner | Installer | Signature | Engine | Screen reader | IME |
| --- | --- | --- | --- | --- | --- | --- |
| macOS arm64 | macOS 15.8.2 (24H232), `macos-15` | `OpenCoven.Chat_0.0.8_aarch64.dmg` `494dad0cb3b9454ca5219c778bedb6ba654d9281f62f80fca97677de4638fc98` | CDHash `798014d38e256731b334bbf8cc20a216594244c7`, team `9LR8Z8UQ9X`; Gatekeeper: accepted, Notarized Developer ID | WebKit 20621.3.11.11.3 | VoiceOver | Kotoeri (Romaji) |
| macOS x64 | macOS 15.7.9 (24G830), `macos-15-intel` | `OpenCoven.Chat_0.0.8_x64.dmg` `51c8734d7445c6aefbffcfd7bd77e259862bed714f5fac3a9f2ae7d0292dcc82` | CDHash `8a281302a153a80b91715801f7142038eb337f74`, team `9LR8Z8UQ9X`; Gatekeeper: accepted, Notarized Developer ID | WebKit 20621.3.11.11.3 | VoiceOver | Kotoeri (Romaji) |
| Windows | Windows Server 2025 Datacenter 10.0.26100, `windows-2025` | `OpenCoven.Chat_0.0.8_x64_en-US.msi` `3e77b955ac6f1d8cf75f9215ff40081b63a56cf4ae5489b5fee24c54bc4f5b0e`; installed `opencoven-chat.exe` `87a4fc112b06b709aa345587ec7febc105c251546832aff7e273a3fe0227f9e3` | Authenticode: `NotSigned` (installer rows stay with #520) | WebView2 156.0.4314.58 | NVDA 2025.3.2 portable | Microsoft IME (ja-JP) |
| Linux | Ubuntu 24.04.5, `ubuntu-24.04` | `OpenCoven.Chat_0.0.8_amd64.deb` `2d168c7df7b400d02d05b2413186a280ff8c61564a7d4f59145c589edb400368` | (none) | WebKitGTK 2.52.6-0ubuntu0.24.04.1 | Orca 46.1 (no audio device: utterances read from its debug log) | Mozc through IBus |

**Runs.**

- **macOS, final harness `e61025e`:** run [42331426944](https://github.com/OpenCoven/chat/actions/runs/42331426944), started 2026-11-07 02:53Z. The jobs are arm64 [128278587577](https://github.com/OpenCoven/chat/actions/runs/42331426944/job/128278587577) and x64 [128278587816](https://github.com/OpenCoven/chat/actions/runs/42331426944/job/128278587816).
  - It ran from the scratch branch `test/504-ime-probe` @ `e973675`, because the lane's own workflow is dispatch-only until it reaches `main`. That commit's `scripts/native-acceptance/` is byte-identical to the lane's `e61025e` (tree `2eaa6b5`), and it only adds a push trigger for the macOS jobs.
  - `e61025e` chooses Kotoeri afresh on later IME attempts, as described under row 3. Every row came out as in run 15, and Japanese input composed on both Macs.
- **Windows and Linux, harness `2688e14`:** run [42327181444](https://github.com/OpenCoven/chat/actions/runs/42327181444), started 2026-11-07 02:02Z. The jobs are Windows [128265055376](https://github.com/OpenCoven/chat/actions/runs/42327181444/job/128265055376) and Linux [128265055594](https://github.com/OpenCoven/chat/actions/runs/42327181444/job/128265055594). `e61025e` changes only the macOS input-method retries, so these results stand for it.
- **The same run's macOS jobs at `2688e14`:**
  - x64 [128265055686](https://github.com/OpenCoven/chat/actions/runs/42327181444/job/128265055686): every row the same as above except IME, which was blocked.
  - arm64 [128265055555](https://github.com/OpenCoven/chat/actions/runs/42327181444/job/128265055555), blocked in its first attempt.
  - The arm64 rerun as attempt 2, [128268345612](https://github.com/OpenCoven/chat/actions/runs/42327181444/job/128268345612), composed.

Runs 11–13 reproduced every finding below on earlier harness commits:

- [42325051126](https://github.com/OpenCoven/chat/actions/runs/42325051126) @ `a744096`
- [42325850882](https://github.com/OpenCoven/chat/actions/runs/42325850882) @ `09ab3e9`
- [42326508590](https://github.com/OpenCoven/chat/actions/runs/42326508590) @ `28cab9b`

Runs 1–9 built the lane, and runs 6, 10 and 14 were cancelled when a newer commit replaced them. Each job uploads its `results.md`, `results.json`, screenshots, the screen reader's log and the runner facts as `native-<lane>` artifacts.

### Results by row

| Row | macOS arm64 | macOS x64 | Windows | Linux |
| --- | --- | --- | --- | --- |
| Setup: first run through the window | observed | observed | observed | observed |
| 1. Link gestures, context menu, exact clipboard | observed | observed | **failed** (#547): page menu on right-click; gestures, no-open menu and exact clipboard observed | **failed** (#547): page menu on right-click; gestures, no-open menu and exact clipboard observed |
| 2. Dialog modality, focus return, screen-reader announcement | observed (VoiceOver) | observed (VoiceOver) | observed (NVDA) | observed (Orca) |
| 3. Quote selection: drag, Tab, held Enter, IME, cell, two messages | **failed** (#544): Tab from the dragged passage; the rest observed, IME included | **failed** (#544): Tab from the dragged passage; the rest observed, IME included | observed | **failed** (#544): Tab from the dragged passage; the rest observed, IME included |
| 4. Chat-switch isolation | observed | observed | observed | observed |
| 5. Tables at 480×520 with Larger text | observed | observed | observed | observed |
| 6. Inspector: pointer capture, separator, keys, Reset, persisted width | **failed** (#545): no value spoken on focus; the rest observed | **failed** (#545): no value spoken on focus; the rest observed | observed (NVDA reads "360") | **failed** (#545, #548): no value spoken on focus; Settings' width is drawn but not exposed to AT-SPI; the rest observed |
| 7. Quote kept through a real cancelled run | observed | observed | observed | observed |
| 8. Preference-only browser storage | observed | observed | **failed** (#546): composer text in WebView2 autofill | observed |
| 9. IPv6 `https://[::1]:8080/x` | observed | observed | observed | observed |
| #515 Open hands the exact address to the default browser (plain `http`: landing only, see below) | observed (Safari) | observed (Safari) | observed (Edge) | observed (Firefox) |

### What each row observed

- **Setup.** On every lane the first screen was setup. **Install Coven** installed Coven, then its engine, and **Create familiar** opened Astra's chat. A second familiar, Sage, was created with the installed CLI. The rail started folded and **Show familiars** opened it.
- **1. Link gestures** (all lanes):
  - Primary click, Cmd/Ctrl-click and middle-click each opened *Open this link?* with site `example.com` and the exact address. No browser process started.
  - Right-click opened neither the review nor a browser. The native menu, read through the platform's accessibility API, offered no way to open the link.
  - **Copy address** reported "Copied the address." Another process then read the exact address from the system clipboard.
  - The menu's items match README only on macOS. Windows and Linux show the web view's page menu (#547).
- **2. Modality** (all lanes):
  - Focus started on **Cancel**. Tab went to **Copy address**, **Open** and **Cancel**, and Shift+Tab went back.
  - While the review was open, the conversation behind it was absent from the accessibility tree, and the thread did not move under it (link y unchanged).
  - A click on the composer behind the review closed the review. The click took nothing and sent nothing.
  - Escape returned focus to the link. Each screen reader announced it:
    - VoiceOver: "dialog pop up link Handoff check list 3 items"
    - NVDA: "… list, with 3 items, Handoff check, opens dialog, link"
    - Orca: "Handoff check link." "opens popup"
- **3. Quote selection.**
  - A real pointer drag from "The plan has three steps." to the list item **Handoff check** selected the two paragraphs and the item. **Quote selection** appeared once. Pressing it inserted `> ` lines with the paragraph break kept.
  - **Tab from the dragged passage:** WebView2 reached the action in 23 presses with the capture kept. On WebKit (both Macs and Linux), the first Tab landed on the link inside the selection and the action went away (#544).
  - **Held Enter** on the action (held about 0.6 s, with key repeats as the keyboard sends them) inserted one quote, sent nothing (model requests unchanged) and left focus in the composer. On Windows this was the dragged passage. On WebKit it was a passage with no control after it ("Done."), which Tab reaches in one press.
  - **IME:** composing "nihonn", Space, Enter after the quote committed Japanese with no romaji left and sent nothing:
    - Kotoeri on macOS x64: 日本 (run 42331426944)
    - Kotoeri on macOS arm64: 🇯🇵, its live-conversion candidate for にほん (run 42331426944; also in runs 11, 12 and 15's attempt 2)
    - Microsoft IME: 日本
    - Mozc: 日本
  - **How Kotoeri was made to compose on macOS.** Choosing Kotoeri through Text Input Sources reports it as current, but on these runners the first choice often leaves its input method unstarted. The keys then arrive Latin, with the かな key as a control character (U+0010). This was seen in every x64 run up to run 15, and on arm64 in run 13 and run 15's first attempt; each reported IME as **blocked**, not judged.
    - A probe on both runners ([run 42331071948](https://github.com/OpenCoven/chat/actions/runs/42331071948)) typed one key into TextEdit after each way of choosing. A fresh choice started the input method: Latin and back with the app in front (Intel, both copies), or an app becoming active with Japanese already chosen (all four copies).
    - From its second attempt, the lane now chooses afresh that way and records which way ran. On x64 the second attempt, "Latin, then Japanese again", composed あ. On arm64 the first attempt did.
    - The probe key decides, as before. Nothing is judged until the composer shows Japanese.
  - **Table cell:** a drag inside one cell (`a | b`) quoted as `> a | b`.
  - **Across messages:** a drag from "[[table]] Show me the table." to the reply "Here it is." offered no action.
- **4. Chat switch** (all lanes):
  - With a passage selected and a link review open above the expanded table, `Cmd/Ctrl+]` left the review where it was.
  - Rail clicks on Sage: the first closed the review, the second closed the sheet, and the third switched.
  - After the switch, no review, sheet or quote action remained. Sage's draft, "Draft kept for later", was unchanged.
- **5. Tables** (all lanes):
  - **Copy table Markdown** put the exact source on the system clipboard, both in the reply and in the sheet.
  - A link in the sheet opened the review above it, with the sheet hidden from assistive technology. Escape closed the review only, then the sheet. Focus returned to **Guide**, then to **Expand table**.
  - At 480×520 inner (WebView2's frame measures 496×559 outside) with **Larger** text (message text grew, e.g. 21→25px on macOS):
    - focus opened on **Close**, and the sheet fit inside the window
    - it scrolled across
    - the composer stayed inside the window and took focus
  - A downward wheel moved the sheet on macOS and Linux. On Windows the rows fit and nothing moved; that was recorded, not judged.
- **6. Inspector resize.**
  - **Pointer drag** of the handle: the width followed the pointer, kept following with the pointer outside the window (360→400px), and stopped on release outside the window. No text was selected.
  - **Keys:** Tab from the composer reached **Resize inspector** in one press. Left/Right stepped 16px (376/360). Home/End reached 280/600, the maximum the separator reports.
  - **Settings and Reset:** Settings → General showed the width on macOS and Windows. On Linux the screenshot shows it drawn ("400px"), but AT-SPI exposes none of the row's text: at that point there is only an empty `filler` (#548). **Reset** restored 360px everywhere.
  - **Persisted width:** with 600px stored, narrowing to 1000px folded the inspector away, and the composer stayed inside the window. Widening again left the rail folded, and **Show inspector** opened it at 600px.
  - **Screen readers:** NVDA read "360, Resize inspector, separator". VoiceOver and Orca read the role and name with no value (#545).
- **7. Quote through a cancelled run** (all lanes): during a slow streaming reply, a passage was quoted. After **Stop run**, the quote stayed in the draft. Exactly one slow run reached the model, and nothing more was sent.
- **8. Storage** (read from disk after the app quit):
  - **macOS and Linux:** the web view's local storage held only `opencoven.chat.preferences.v1` (numeric `inspectorWidth`, 600) and `opencoven.chat.navigation.v1` (ids only). There was no IndexedDB, and no passage, address or table text in any web-view file.
  - **Windows:** the same two keys, but composer text in `Web Data` (#546).
- **9. IPv6** (all lanes): the review showed site `[::1]:8080` and address `https://[::1]:8080/x`. **Copy address** put exactly that on the clipboard, and **Open** gave the default browser exactly that address. The connection error page is expected.
- **#515** (all lanes; default browsers Safari, Edge and Firefox):
  - With the browser closed, **Open** started the default browser at exactly `https://example.com/handoff-check?x=1`, read from its address field or page. The review then said "Sent the address to your browser. If no page opened, use Copy address."
  - On Windows, the screenshot after that first **Open** shows Edge at the address, with no SmartScreen or "How do you want to open this?" prompt. The lane did not search for such a prompt by name.
  - **Open** was then disabled. A second press added no window and no page.
  - Escape returned focus to the link.
  - With the browser running, **Open** on the plain `http://example.com/` brought the browser to `https://example.com/`. Safari, Edge and Firefox upgrade to HTTPS on their own, so the `http://` form Chat handed over can't be read back. The landing is observed; the exact scheme is not.
  - `https://name@example.com/` offered only **Cancel** and **Copy address**, and copied exactly.
  - The lane watched Safari, Chrome, Edge and Firefox processes. None but the default ran at any point.

### Findings filed (owning feature in brackets)

- **#544** [#482]. On WebKit (both Macs and Linux), Tab from a dragged passage that ends on a link moves focus onto that link. WebKit clears the selection, and **Quote selection** goes away after one press. WebView2 keeps the capture and reaches the action in 23 presses. A passage with no control after it ("Done.") reaches the action in one press on every lane.
- **#545** [#484]. VoiceOver and Orca read the **Resize inspector** handle's name and role on focus, but no value. NVDA reads "360". VoiceOver speaks "30%" when the width changes.
- **#546** [storage, `SECURITY.md`]. On Windows, text typed into the composer is stored by Edge's general autofill in the WebView2 profile's `Web Data` (`autofill_edge_field_values.value`). This reproduced in every Windows run that reached row 8. macOS and Linux store only the two allowed keys.
- **#547** [#481]. On Windows and Linux, right-clicking a link shows the web view's page menu:
  - Windows: Back, Refresh, Save as, Print, More tools
  - Linux: Back, Forward, Stop, Reload

  It offers no text actions. On every lane the menu offers no way to open the link.
- **#548** [#484]. On Linux, Settings → General draws **Inspector width**, its hint and the width, but AT-SPI exposes none of that text. At the width's position there is only an empty `filler`. macOS and Windows expose it.

### Not staged by this lane

- A clipboard refusal for **Copy address** (row 1). Recorded as "not staged", as the checklist allows.
- #515's `xdg-open`-missing case. Windows SmartScreen and other installer prompts belong to #520.

### Wording notes from 2026-10-24, still current

The lane checks against these notes as written:

- Row 4: with a review or sheet open, the rail's first clicks close the review, then the sheet; the third click switches. `Cmd/Ctrl+]` leaves an open review where it is.
- Row 6: after the 1100px trip the rail stays folded, and **Show inspector** reopens at the stored 600px.
- Row 8: `opencoven.chat.navigation.v1` (ids only) sits beside the preferences key, which `SECURITY.md` allows.

## Disposition

| Child | Proposed | Implemented on a branch | Merged | Independently verified | Packaged |
| --- | --- | --- | --- | --- | --- |
| #481 link review | yes | #486 | **yes**, `bbdb1108` | source + jsdom + Chromium on the candidate; clipboard defect found and fixed before merge | macOS bundle built and start-smoked (no UI row run); Linux bundle built in CI, not launched; Windows not built |
| #482 quote selection | yes | #488 | **yes**, `cdb98ce3` | source + jsdom + Chromium on the candidate | built, not launched (same bundles) |
| #483 tables | yes | #487 @ `35e004e0` | **yes**, `72a64036` (03:21Z) | source + jsdom + Chromium on the candidate; CI green on the exact head | built, not launched (same bundles) |
| #484 inspector resize | yes, optional; **retained, not deferred** | #489 @ `72b6e252` | **yes**, `4342d2ad` (03:45Z) | source + jsdom + Chromium on the candidate; CI green on the exact head | built, not launched (same bundles) |
| #485 acceptance | yes | this record + `chat-ux-integration.test.tsx` on `review/candidate-480` (PR #490) | no | unit, browser, CI and diff lanes run; macOS bundle built and start-smoked; Linux bundle built; no desktop behaviour row verified | Windows not built; macOS launched once as a smoke only |

Green checks and this record are not merge or release authorization. All four children are on `main`
(`cdb98ce3`, `bbdb1108`, `72a64036`, `4342d2ad`), each with content identical to the verified candidate.
`review/candidate-480` now differs from `main` by this record and the new test only, so PR #490 reduces
to those two files on rebase. Source completion is not "shipped": nothing here is release-approved,
and the desktop runtime rows above are still open.

**2026-11-06.** The *Packaged* column above describes the 2026-10-19 candidate. Since then, the published v0.0.8 installers have been run on macOS (arm64 and x64), Windows and Linux by native OS-level automation, not by hand; the results are in the section above.

- Rows 2, 4, 5, 7 and 9, and #515's hand-off, were observed on every lane.
- Rows 1, 3, 6 and 8 each failed on at least one lane, and each failure has a focused issue, #544–#548, against the owning feature.
- Japanese input was observed on every lane, after the lane learned to start Kotoeri on the macOS runners (row 3).

These results do not authorize a merge or a release. A fix for any of the five issues needs the failed row run again.
