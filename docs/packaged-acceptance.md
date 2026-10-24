# Packaged acceptance

`.github/workflows/packaged-acceptance.yml` installs the built OpenCoven Chat app and drives its
window through [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/): WebKitGTK on Linux
(`.deb` and AppImage) and WebView2 on Windows (MSI). It records what each row it can prove
observed, as **automated packaged** evidence. It never records a hand-run result.

The browser suite in `e2e/` runs the web build in Chromium with the native side mocked. This suite
is the only automated check that runs the shipped binary.

## When it runs

- **CI** calls it after *Desktop build*, with the Linux bundles that job just built. The Windows
  lane builds its own MSI, so it runs on `main` and on pull requests labelled `ci:full`, like the
  other Windows jobs.
- **By hand**, from the Actions tab: *Packaged acceptance* → *Run workflow*, with a published tag
  such as `v0.0.6`. The workflow downloads that release's installers and checks them against its
  `SHA256SUMS` before installing anything.

Each lane uploads `results.md`, `results.json`, the system browser's log (`opened.jsonl`), the
model endpoint's request log, `tauri-driver.log` and a final screenshot.

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
| 1 Link gestures, copy, review | Click, middle-click and Ctrl-click each open *Open this link?*; no live `http` anchor in the transcript; **Copy address** puts the exact address on the system clipboard; right-click opens neither the review nor the browser | Which items the native context menu offers |
| 2 Modality, focus | Focus starts on **Cancel**; Tab cycles the three controls; a click on the composer behind the review does nothing; Escape returns focus to the link | The screen reader's announcement |
| 3 Quote selection | Quote across a paragraph break and a list, and from one table cell; Tab reaches the action; held Enter quotes once and sends nothing (the model endpoint sees no request); nothing offered across two messages | A real drag-selection; IME |
| 4 Chat-switch isolation | A pointer click on another familiar with a passage, the sheet and a review open; all three close and the other chat's draft is kept | |
| 5 Tables at 480×520, Larger text | The sheet fits and scrolls across; both **Copy table Markdown** buttons put the exact source on the clipboard; the review opens above the sheet; Escape closes the review, then the sheet; focus returns to the link, then **Expand table** | |
| 6 Inspector resize | Arrow keys step 16px; Home and End reach the ends; Settings → General shows the width and **Reset**; 600px survives a trip to 1000px wide; an in-window drag | Pointer capture through a drag that leaves the window; the separator read aloud |
| 7 Quote through a cancelled run | | All of it |
| 8 Preference-only storage | Local storage holds only `opencoven.chat.preferences.v1` with a numeric `inspectorWidth`; nothing in session storage or IndexedDB; no address, table or passage text anywhere | |
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
