# Native acceptance lane (#504, #515)

Drives the **published** installers of a release with native input and reads
the window back through each platform's accessibility tree and screen reader.
No WebDriver is attached and no script runs in the page, so the bytes driven are
the ones published (this is also why the lane is not blocked by #532).

| Platform | Input | Reading | Screen reader | IME |
| --- | --- | --- | --- | --- |
| macOS (`mac/NativeDriver.swift`) | CGEvent at the HID tap | AX API (WKWebView tree) | VoiceOver, `content of last phrase` | Kotoeri Romaji via TIS |
| Windows (`windows/serve.ps1`) | SendInput | UI Automation | NVDA portable, IO-level speech log | Microsoft IME (ja-JP) |
| Linux (`linux/native_driver.py`) | XTEST (xdotool) | AT-SPI (pyatspi) | Orca debug log | IBus Anthy |

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

- Branch `test/504-native-acceptance`. The lane is written; its first CI run is
  waiting on a push that touches `.github/workflows/`, which needs a token with
  the `workflow` scope.
- macOS role and name mapping checked against the published v0.0.8 setup
  screen's real AX tree; Windows and Linux mappings are first guesses until the
  first run's `first-tree.txt`.
