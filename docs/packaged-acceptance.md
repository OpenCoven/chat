# Packaged acceptance

`.github/workflows/packaged-acceptance.yml` installs the built OpenCoven Chat app and drives its
window through [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/): WebKitGTK on Linux
(`.deb` and AppImage) and WebView2 on Windows (MSI). It records what each row it can prove
observed, as **automated packaged** evidence. It never records a hand-run result.

The browser suite in `e2e/` runs the web build in Chromium with the native side mocked. This suite
is the only automated check that runs the shipped binary.

## When it runs

- **CI** calls it twice. *Packaged acceptance* runs after *Desktop build* and installs the `.deb`
  and AppImage that job built. *Packaged acceptance (Windows)* builds its own test MSI (see
  below), so it doesn't wait for Desktop build; it runs on `main` and on pull requests labelled
  `ci:full`, like the other Windows jobs.
- **By hand**, from the Actions tab: *Packaged acceptance* → *Run workflow*, with a published tag
  such as `v0.0.6`. The workflow downloads that release's installers and checks them against its
  `SHA256SUMS` before installing anything.

Each lane uploads `results.md`, `results.json`, the system browser's log (`opened.jsonl`), the
model endpoint's request log, `tauri-driver.log`, a screenshot of every failed row and a final
screenshot.

## Windows: a test build, and shipped builds stay blocked

On `windows-2025`, the app's WebView2 runs with exactly the switches wry gives it through
`AdditionalBrowserArguments`, which every Tauri 2 app sets. It ignores
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, the route msedgedriver uses to ask for a debugging port,
and also ignores WebView2's per-user `AdditionalBrowserArguments` policy. A shipped MSI therefore
can't be attached to from outside.

So CI's Windows lane builds a **test MSI** from the tree: the shipped window configuration, with
`--remote-debugging-port=9333` appended to exactly the switches a shipped build runs with. The
suite launches it and attaches msedgedriver by `debuggerAddress`. Its results say "test build".
A dispatch against a published tag still tries the shipped MSI and reports its Windows lane as
**blocked**, not failed. Driving shipped Windows builds needs wry to keep WebView2's own
switches, or a product decision to let Chat accept them.

## Known failures

A row that fails because of a filed product bug is listed in `KNOWN` in
`scripts/packaged-acceptance/run.mjs`. It is reported as "known failure (#issue)" and doesn't
fail the lane. If a listed failure stops reproducing, the lane fails, so the entry is removed once
the bug is fixed. Currently listed:

- [#525](https://github.com/OpenCoven/chat/issues/525): on the AppImage, the setup screen's engine
  install fails. The AppImage's `LD_LIBRARY_PATH` reaches the system `curl`, which then can't
  load. No other row runs on the AppImage until it's fixed.

## What is real, and the one stand-in

Packaged Chat starts with an empty profile, and first-run setup is done through the window:
**Install Coven** runs Chat's pinned installer (Coven 0.4.10, checked against its SHA-256),
**Install the engine** runs `coven engine install`, and **Create familiar** names the first
familiar. Every reply in the suite comes from a real run: Chat starts the installed Coven CLI,
which starts coven-code, and the reply streams back through Chat's own capture.

The stand-in is the model. The engine is pointed at a local, deterministic Anthropic-compatible
endpoint (`scripts/packaged-acceptance/model-fixture.mjs`) through `ANTHROPIC_BASE_URL`, with a
placeholder key. No account or key is used. Model-provider behaviour is not covered.

The system clipboard is read by a separate process (`xclip`, `Get-Clipboard`), never by the page.
**Open** is checked by registering `scripts/packaged-acceptance/record-url.mjs` as the default web
browser. On Linux that is a desktop entry chosen through `mimeapps.list`, reached by `xdg-open`.
On Windows it is a per-user override of the handler `rundll32 url.dll,FileProtocolHandler`
resolves. The recorder logs the exact address the operating system handed it.

On Linux the app runs in the CI container under Xvfb with `APPIMAGE_EXTRACT_AND_RUN=1`, since a
container has no FUSE, and `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`, since it has no user
namespaces for WebKit's web-process sandbox. These settings change how the app is hosted, not
what its window does. CI's bundles are built in the CI image (Ubuntu 24.04), but release bundles
are built on `ubuntu-22.04`. Dispatch against a tag to drive the released bytes.

## Rows

| Row ([#504](https://github.com/OpenCoven/chat/issues/504), [#515](https://github.com/OpenCoven/chat/issues/515)) | Driven here | Still hand-run |
| --- | --- | --- |
| 1 Link gestures, copy, review | Click, middle-click and Ctrl-click each open *Open this link?*; no live `http` anchor in the transcript; **Copy address** puts the exact address on the system clipboard (Windows keeps it with CRLF line ends; the text is compared). Right-click opens neither the review nor the browser on WebView2; on WebKitGTK it is not judged, because WebKitWebDriver follows a right press with a primary click | Which items the native context menu offers; right-click on Linux |
| 2 Modality, focus | Focus starts on **Cancel**; Tab cycles the three controls; a click on the composer behind the review does nothing; Escape returns focus to the link | The screen reader's announcement |
| 3 Quote selection | Quote across a paragraph break and a list, and from one table cell; Tab reaches the action; Enter on it quotes once and sends nothing (the model endpoint sees no request); nothing offered across two messages. Held Enter is recorded, not judged: WebKitWebDriver delivers one key-down and msedgedriver delivers fresh presses (`repeat` false), and the composer rightly sends on a fresh Enter | A real drag-selection; IME; Enter held on the action |
| 4 Chat-switch isolation | With a passage, the sheet and a review open, **Ctrl+]** switches familiars. All three close, and the other chat's draft is kept. The pointer path is recorded: each click on the rail first closes one open layer | |
| 5 Tables at 480×520, Larger text | The sheet fits and scrolls across; both **Copy table Markdown** buttons put the exact source on the clipboard; the review opens above the sheet; Escape closes the review, then the sheet; focus returns to the link, then **Expand table** | |
| 6 Inspector resize | Arrow keys step 16px; Home and End reach the ends; Settings → General shows the width and **Reset**; after a trip to 1000px wide the rail stays folded (widening never forces it open, by design) and **Show inspector** reopens it at the stored 600px; an in-window drag (recorded, not judged) | Pointer capture through a drag that leaves the window; the separator read aloud |
| 7 Quote through a cancelled run | | All of it |
| 8 Preference-only storage | Judged against `SECURITY.md`: local storage holds only `opencoven.chat.preferences.v1` (with a numeric `inspectorWidth`) and `opencoven.chat.navigation.v1` (`familiarId` and `sessionId`). Nothing is in session storage or IndexedDB, and no address, table, passage or draft text is stored anywhere | |
| 9 IPv6 | `https://[::1]:8080/x` shows site `[::1]:8080`; Copy and Open use exactly that address | |
| #515 handoff | **Open** hands the operating system exactly the reviewed address, once, for a query string, a plain address and IPv6 | The browser's own address bar, with the browser closed and with it running |

macOS stays entirely hand-run: WKWebView has no WebDriver.

## Running it locally

On a Linux desktop with the app installed, WebKitWebDriver on `PATH`, `xclip`, and
`cargo install tauri-driver --locked`:

```bash
node scripts/packaged-acceptance/run.mjs --application /usr/bin/opencoven-chat \
  --out /tmp/packaged-acceptance
```

The suite expects an empty profile. It installs Coven into `~/.local/bin`, writes `~/.coven`,
and makes itself the default web browser. Run it under a throwaway user, never against a profile
with real conversations.
