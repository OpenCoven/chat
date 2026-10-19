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
| #483 tables | PR #487 `feat/markdown-table` @ `35e004e0`, rebased onto `bbdb1108` and retargeted to `main`; `e1b422e3` (the feature) + `35e004e0` (fix: snapshot keeps reference links resolved outside the table's source slice) |
| #484 inspector resize (optional, retained) | PR #489 `feat/inspector-resize` @ `72b6e252`, rebased onto `bbdb1108` (re-authored from `e85c2301`, same tree `5bf07bfb`) |
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
(reproduced by invoking `pwsh` directly, 0.13 s). No PR touches that file; CI's *Web checks* job is the
authority for it. Skipped tests in the `windows-*` files mean "not run here", not passed.

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

CI's *Desktop build* job runs `pnpm app:build` on `ubuntu-latest`; it uploads no artifact and runs
nothing, so a pass proves the tree bundles on Linux, not how it behaves.

## Packaged desktop lanes

None of the three packaged lanes was run on this candidate. Each stays **unverified**, for the reason
given, and nothing above replaces them. The per-feature pending rows are kept on #485
([first set](https://github.com/OpenCoven/chat/issues/485#issuecomment-6258525498),
[additions](https://github.com/OpenCoven/chat/issues/485#issuecomment-6258933027)); the checklist
below is the macOS hand-run version of them for this candidate.

| Lane | State | Why, and what exists instead |
| --- | --- | --- |
| Packaged macOS (WKWebView) | **Blocked, unverified** | No `.app` was built here: the Rust crate cache is incomplete (`cargo fetch --offline` needs the network) and the volume sat at 100% with about 5 GB free while three sessions ran suites, so a release build risked `ENOSPC` for everyone. This terminal also has no Accessibility or Screen Recording grant, by Val's standing decision, so window steps are Val's to run by hand. The checklist below is written for that. |
| Packaged Windows (WebView2) | **Unverified** | No Windows machine in this session. Cross-compilation would not be runtime evidence. |
| Packaged Linux (WebKitGTK) | **Unverified at runtime** | No Linux machine in this session. See "CI on the exact heads" for the Linux bundle result. |

Build provenance that does exist: the frontend the packaged app would embed is the `dist/` from
`corepack pnpm build` at the candidate (digests in the tables above). The native side is
byte-identical to `main`'s, so a packaged `main` build with the candidate's `dist/` would run the same
webview code; no such build was made.

### Hand-run checklist for the packaged macOS candidate (for Val)

Build from `review/candidate-480` at `f77db71c` with the pinned toolchain
(`PATH=$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH corepack pnpm app:build`).
Record the commit, the `codesign -dvvv` CDHash of the app, and the macOS version with each row. Use a
familiar whose replies are synthetic.

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

## Disposition

| Child | Proposed | Implemented on a branch | Merged | Independently verified | Packaged |
| --- | --- | --- | --- | --- | --- |
| #481 link review | yes | #486 | **yes**, `bbdb1108` | source + jsdom + Chromium on the candidate; clipboard defect found and fixed before merge | no |
| #482 quote selection | yes | #488 | **yes**, `cdb98ce3` | source + jsdom + Chromium on the candidate | no |
| #483 tables | yes | #487 @ `35e004e0`, on `main` | no | source + jsdom + Chromium on the candidate | no |
| #484 inspector resize | yes, optional; **retained, not deferred** (PR #489 open) | #489 @ `e85c2301` | no | source + jsdom + Chromium on the candidate | no |
| #485 acceptance | yes | this record + `chat-ux-integration.test.tsx` on `review/candidate-480` | no | unit, browser and diff lanes run; desktop lanes not | no |

Green checks and this record are not merge or release authorization. Merging #487 and #489 is Val's
call; both touch `e2e/app.tauri-mock.spec.ts` and `README.md`, so whichever lands second rebases.
