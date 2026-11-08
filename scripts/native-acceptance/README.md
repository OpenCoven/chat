# Native acceptance lane (#504, #515)

Drives the **published** installers of a release with native input and reads
the window back through each platform's accessibility tree and screen reader.
No WebDriver is attached and no script runs in the page, so the bytes driven are
the ones published (this is also why the lane is not blocked by #532).

| Platform | Input | Reading | Screen reader | IME |
| --- | --- | --- | --- | --- |
| macOS (`mac/NativeDriver.swift`) | CGEvent at the HID tap | AX API (WKWebView tree) | VoiceOver, `content of last phrase` | Kotoeri Romaji via TIS, then the かな / 英数 keys |
| Windows (`windows/serve.ps1`) | SendInput | UI Automation | NVDA portable, IO-level speech log | Microsoft IME (ja-JP), IME on/off keys |
| Linux (`linux/native_driver.py`) | XTEST (xdotool) | AT-SPI (pyatspi) | Orca debug log, no speech server | IBus Anthy, or Mozc started in Hiragana |

`lane-*.sh` / `lane-windows.ps1` verify the asset against the release's
`SHA256SUMS`, install it on a fresh runner user (an empty profile), record the
runner, then run `run.mjs`. `.github/workflows/native-acceptance.yml` runs them.

The model is the one stand-in: `fixture.mjs` extends the packaged suite's
deterministic endpoint with a slow streaming reply (row 7) and an address with a
sign-in name (#515). Every word the app shows is synthetic.

Results are **native OS-level automation** on CI runners. They are never
hand-run results, and a row the lane could not stage is reported as blocked,
not passed. Installer rows stay with #520; this lane only installs in order to
drive the app.

## Status checkpoint

- Runs are dispatched for a published tag (`workflow_dispatch`, input
  `release`). While the lane was built, pushes to `test/504-native-acceptance`
  also ran it; that trigger is gone. Each lane uploads `results.md`,
  `results.json`, its screenshots, the reader's log and the runner facts as an
  artifact (`native-macos-<arch>`, `native-windows-msi`, `native-linux-deb`).
- **Candidate runs.** Dispatched with `release` empty, each lane builds the
  dispatched commit on its runner, with the release workflow's toolchain
  (pnpm 10.34.0, Rust 1.95.0) and `tauri build --bundles dmg|msi|deb`, but
  unsigned and on the lane's runner image, then drives that build. There is no
  `SHA256SUMS` to check. Every result names the build "candidate … built from
  `<commit>`, not a published release". A candidate run checks a fix before a
  tag; it never stands in for the published installers, which are driven again
  once the release is out.
- v0.0.8 results and the issues they produced (#544, #545, #546, #547, #548) are
  recorded in `docs/verification/2026-10-18-rakazo-chat-ux.md`, section
  "Native OS-level automation on the published v0.0.8 installers".
- Known limits: no clipboard refusal is staged; on the macOS runners the
  first choice of Kotoeri often leaves its input method unstarted, so later
  attempts choose it afresh (`rechooseKotoeri` in `rows.mjs`), and the row
  still reports blocked if no attempt composes; Orca runs with no speech
  server, so its words come from its debug log; WebView2's context menu is
  read by what UI Automation reports at a point inside it.
