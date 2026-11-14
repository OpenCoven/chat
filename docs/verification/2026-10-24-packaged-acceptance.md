# Verification record: automated packaged acceptance, 2026-10-24

Every result here is **automated packaged** evidence from `scripts/packaged-acceptance/`, gathered
by CI on 2026-10-24 (UTC) and tracked on #523. The suite installed each package and drove its
window through tauri-driver. **Nothing here is a hand-run result.** No row of #504 or #515 is
marked passed by this record; the hand-run rows stay open, and the last section lists them.

Suite: `scripts/packaged-acceptance/` at `e9227ac` (PR #524). The model's words came from a
local, deterministic Anthropic-compatible endpoint. Chat, Coven 0.4.10, coven-code 0.8.0, the
runs, the system clipboard and the system's URL opener were all real.

## Runs and packages

| Lane | Run | Package | SHA-256 | Host |
| --- | --- | --- | --- | --- |
| v0.0.6 `.deb` | [40094724130](https://github.com/OpenCoven/chat/actions/runs/40094724130), *Linux (deb)* | published `OpenCoven.Chat_0.0.6_amd64.deb`, checked against `SHA256SUMS` | `4c47a3f8…521f` | Ubuntu 24.04.4 CI image, WebKitGTK 2.52.6, Xvfb |
| v0.0.6 AppImage | 40094724130, *Linux (appimage)* | published `OpenCoven.Chat_0.0.6_amd64.AppImage` | `93241e2e…7385` | same |
| v0.0.6 MSI | 40094724130, *Windows (msi)* | published `OpenCoven.Chat_0.0.6_x64_en-US.msi` | `a474c5ac…6ce6` | `windows-2025`, WebView2 155.0.4283.62 |
| tree `.deb` | [40094727831](https://github.com/OpenCoven/chat/actions/runs/40094727831), *Packaged acceptance / Linux (deb)* | built by Desktop build from #524's head | `018f67b0…fa00` | Ubuntu 24.04.4 CI image, WebKitGTK 2.52.6 |
| tree AppImage | 40094727831, *Packaged acceptance / Linux (appimage)* | same build | `f918fb48…4af9` | same |
| tree MSI (test build) | 40094727831, *Packaged acceptance (Windows)* | built from #524's head with the shipped window configuration plus `--remote-debugging-port=9333` | `f5ba184d…c73b` | `windows-2025`, WebView2 155.0.4283.62 |

App code is identical in v0.0.6 and `main` at `b95a1cb`: `git diff v0.0.6 origin/main -- src
src-tauri/src` is empty. Each lane's `results.md`, `results.json`, browser and model logs and
screenshots are in that job's `packaged-acceptance-*` artifact.

## Results

| Row | v0.0.6 `.deb` | v0.0.6 AppImage | v0.0.6 MSI | tree `.deb` | tree AppImage | tree MSI (test build) |
| --- | --- | --- | --- | --- | --- | --- |
| First-run setup through the window | observed | known failure (#525) | blocked | observed | observed | observed |
| 504-1 Link gestures, copy, review | observed | not run | not run | observed | observed | observed |
| 504-1 right-click (partial) | not judged | not run | not run | not judged | not judged | observed |
| 504-2 Modality and focus return (keyboard) | observed | not run | not run | observed | observed | observed |
| 504-3 Quote selection, Enter on the action (keyboard) | observed | not run | not run | observed | observed | observed |
| 504-4 Chat-switch isolation | observed | not run | not run | observed | observed | observed |
| 504-5 Tables at 480×520 with Larger text | observed | not run | not run | observed | observed | observed |
| 504-6 Inspector resize (keyboard) | observed | not run | not run | failed (see below) | observed | observed |
| 504-8 Preference-only storage | observed | not run | not run | observed | observed | observed |
| 504-9 IPv6 | observed | not run | not run | observed | observed | observed |
| #515 Open hands over the exact address | observed | not run | not run | observed | observed | observed |

"Not run" means setup could not finish, so nothing after it ran. The tree `.deb` lane's row 6
stopped partway. After **Reset**, the **Close settings** click did not close Settings within 15
seconds, a step the row does not judge. The checks before it had passed; the narrowing checks
after it did not run. The suite now falls back to Escape there.

### What was observed

- **Setup.** Starting from an empty profile, **Install Coven** installed Coven 0.4.10 through
  Chat's pinned installer, the engine install followed, and **Create familiar** opened the chat.
- **#515.** On every lane that ran, **Open** handed the operating system exactly the reviewed
  address, once for each address: `https://example.com/handoff-check?x=1`, `http://example.com/`
  and `https://[::1]:8080/x`. The OS opener was `xdg-open` on Linux and `rundll32
  url.dll,FileProtocolHandler` on Windows, which delivered each address to a recorder registered
  as the default browser. A second press on **Open** delivered nothing more.
- **Rows 1 and 9.** Click, middle-click and Ctrl-click opened the review, and no live `http`
  anchor reached the transcript. **Copy address** put the exact address on the system clipboard,
  read by `xclip` or `Get-Clipboard`. The IPv6 review names the site `[::1]:8080`.
- **Row 2.** Focus starts on **Cancel**, and Tab cycles **Copy address**, **Open**, **Cancel**.
  Escape returns focus to the link. A click where the composer sits closes the review, reaches
  nothing behind it, sends nothing, and returns focus to the link.
- **Row 3.** One Enter on **Quote selection** inserts one quote that keeps its line breaks, and
  the model endpoint received no request. A table cell quotes on its own. A selection across two
  messages offers nothing.
- **Row 4.** With a passage captured, the table expanded and a review open over it, the familiar
  switch closes all three, and the other chat's draft is unchanged. See the first #504
  observation below for how the switch is made.
- **Row 5.** At 480×520 with Larger text, the sheet fits and scrolls across. Both **Copy table
  Markdown** buttons put the exact source on the clipboard; Windows stores it with CRLF line
  ends. A link in the sheet opens its review above the sheet, and Escape closes the review, then
  the sheet. Focus returns to the link, then to **Expand table**, and the composer stays
  reachable.
- **Row 6.** Arrow keys step 16 px, and Home and End reach the ends. Settings → General shows the
  width and **Reset** restores 360 px. After the window crosses 1100 px and widens again, the rail
  stays folded, and **Show inspector** reopens it at the stored 600 px.
- **Row 8.** Local storage holds only `opencoven.chat.preferences.v1` (numeric `inspectorWidth`)
  and `opencoven.chat.navigation.v1` (`familiarId`, `sessionId`). Session storage and IndexedDB
  are empty. No address, table, passage or draft text is stored.

## Product findings

- **#525 (filed).** The release AppImage passes its own environment, `LD_LIBRARY_PATH` among it,
  to every process Chat starts. On Ubuntu 24.04 the system `curl` then loads the AppImage's older
  `libnghttp2` and fails, so the engine install from setup fails. That happened in every release
  AppImage run here. An AppImage built in the 24.04 CI image does not show it.
- **Shipped Windows builds cannot be driven.** wry sets WebView2's `AdditionalBrowserArguments`,
  and WebView2 155 then ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, msedgedriver's route, as
  well as the per-user policy. No debugging port opens, so the published MSI lane reports
  **blocked**. This is not a defect in Chat's behaviour. Owner: wry/Tauri upstream, or a product
  decision for Chat (Val).

## Observations for #504's wording

- **Row 4's switch can't be made with everything open.** `Ctrl+[` and `Ctrl+]` are off while a
  dialog is open, by design (`shellChord` in `rail-shortcuts.ts`). On the rail, the first click
  closes the review and the second closes the sheet; the third switches. The passage capture is
  gone by then. Afterwards nothing remains open and the other draft is intact.
- **Row 6.** "Widen again: 600px returns" holds for the stored width but not the open state.
  Widening never forces a rail back open (`chat-layout.tsx`).
- **Row 8.** SECURITY.md also allows the selected familiar in local storage. The row names only
  the preferences key.

## Ruled out

These looked like defects in early runs and are not:

- A resize handle covering **Expand table** at 480×520. That was the rails still collapsing;
  once the layout settled, the inspector was inert and hidden.
- The review opening on right-click on Linux. WebKitWebDriver follows a right press with a
  primary `mouseup` and `click`, which a real release does not do. On WebView2 a right press
  arrives as `mousedown`, `mouseup`, `auxclick` and `contextmenu` for the right button, and the
  review stays closed.
- A held Enter sending on Windows. msedgedriver sends repeated key-downs with `repeat` false,
  which are separate presses, and the composer sends on a fresh Enter by design. WebKitWebDriver
  delivered only one key-down.
- A draft's first letter arriving lowercase. That came from WebDriver's typing, and the row now
  compares the draft with what the composer showed.

## Still hand-run

- Every row on macOS: WKWebView has no WebDriver.
- Row 1: the native context menu's items; right-click at all on WebKitGTK.
- Row 2: the screen reader's announcement (Narrator, Orca, VoiceOver).
- Row 3: a real drag-selection, IME composition after a quote, and Enter held on the action.
- Row 6: pointer capture through a drag that leaves the window; the separator read aloud.
- Row 7: the quote kept through a real cancelled run.
- #515: the browser's own address bar, with the browser closed and with it running.
- Shipped Windows builds, until they can be attached to (see above).
