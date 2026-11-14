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

The model is a stand-in: `fixture.mjs` extends the packaged suite's
deterministic endpoint with a slow streaming reply (rows 7 and 543-1), an
address with a sign-in name (#515), and the packaged suite's approval script,
which asks the real engine to write a real file. Every word the app shows is
synthetic. The asking rows also pair a stand-in phone (`phone.mjs`); see below.

Results are **native OS-level automation** on CI runners. They are never
hand-run results, and a row the lane could not stage is reported as blocked,
not passed. Installer rows stay with #520; this lane only installs in order to
drive the app.

## Status checkpoint

Current full-access candidates and releases use the full-access row. Select `asking=as-built`; the legacy `switched-on` mode is refused before changing or building a full-access candidate. The historical asking modes below apply to builds that still use read-only ordinary turns.

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
- **Asking for permission (#542, #573).** The `asking` input picks the rows.
  `as-built`, the default, reads the build's `ASKING_ENABLED` switch in
  `src-tauri/src/chat_approvals.rs` (this checkout for a candidate, the tag for
  a published release) and drives rows `542-1` to `542-4` when it is on, or
  `asking-off` when it is off. `switched-on` builds a candidate with asking on
  for that run only: `switch-asking.mjs` undoes #562's two switches, the host's
  `ASKING_ENABLED` and the window's permission log in Settings › Access.
  `run.mjs` refuses it for a published release, and the build stays on the
  runner. `rows-on-as-built`
  drives `542-1` to `542-4` whatever the build says, which is how they are seen
  to fail on a build with asking off.
  - `542-1`: **Allow once** lets exactly one write land. The read-only turn's
    file is absent, the allowed turn's holds one write, the next turn has to ask
    again, and the phone allowing the spent request is refused with nothing run.
  - `542-2`: **Decline** in the window, then on the phone, lands nothing and
    runs nothing.
  - `542-3`: sending a new message closes the waiting request, and a late allow
    from the phone is refused.
  - `542-4`: what a paired phone is told matches the window at each step, and
    the permission log reads the same in Settings › Access and to the phone.
  - The companion runs only on macOS and Linux, so on Windows every phone
    check is recorded as blocked, with the window's own reason.
  - The phone is a stand-in. The lane turns the companion on in Settings ›
    Devices, reads the private pairing link from its text box, and calls the
    companion's API with the link's token. It trusts only the certificate in the
    host's `iphone-companion/identity.json`, once that matches the link's
    fingerprint, and checks the fingerprint again in the handshake, so the token
    goes to no other server. A phone pins the fingerprint alone. It shows what
    the Mac tells a paired phone, not what the iPhone app shows; a physical
    iPhone stays a hand row on #573.
  - The engine signs in with an API key against the fixture, so none of these
    rows covers **Sign in with Claude**, and none uses a real model.
- **Row 578 (Windows, MSI).** After every other row, `upgrade.mjs` installs the
  published v0.0.8 MSI (checked against v0.0.8's `SHA256SUMS`) over the build
  under test. In v0.0.8 it types a synthetic phrase into the composer during a
  run, presses Stop run, selects the second familiar and quits. The phrase must
  then be in `EBWebView\Default\Web Data`; if not, the row is blocked. It then
  installs the build under test over v0.0.8, starts it, and quits. No `Web Data`
  file may hold the phrase, the app must reopen on the second familiar (local
  storage kept), and the transcript count must not change. It runs last because
  v0.0.8 shows setup, with no text field, until Coven is installed. v0.0.8 is
  OpenCoven Chat, in `Program Files\OpenCoven Chat`; since #614 the build under
  test is Coven Chat, in `Program Files\Coven Chat`. The row starts each version
  from where its installer put it, and after the upgrade no copy of v0.0.8 may
  be left under either name.
- v0.0.8 results and the issues they produced (#544, #545, #546, #547, #548) are
  recorded in `docs/verification/2026-10-18-rakazo-chat-ux.md`, section
  "Native OS-level automation on the published v0.0.8 installers".
- Known limits: no clipboard refusal is staged; on the macOS runners the
  first choice of Kotoeri often leaves its input method unstarted, so later
  attempts choose it afresh (`rechooseKotoeri` in `rows.mjs`), and the row
  still reports blocked if no attempt composes; Orca runs with no speech
  server, so its words come from its debug log; WebView2's context menu is
  read by what UI Automation reports at a point inside it.
