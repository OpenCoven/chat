# iPhone companion

The SwiftUI companion in `apps/ios/ChatCompanion` connects to a running Mac Chat
app on the same private IPv4 network. Coven runs on the Mac, with the same
read-only permissions and single-run guard used by the desktop. Cave is not
required. This replaces the August Cave-dependent iOS implementation plans.

## Connect

1. In Chat on the Mac, open **Sidebar options** (⋯), then **iPhone companion**.
2. Choose **Turn on companion**. If macOS asks, allow Chat to accept incoming
   connections. The listener binds only to the selected private LAN address.
3. On iPhone, choose **Pair with your Mac** and scan the QR; the phone connects as
   soon as it reads the code. To use the private pairing link instead, choose
   **Enter pairing link**, paste it and choose **Connect**. A link opened from
   elsewhere fills the field but still waits for **Connect**.

A link grants access to Chat conversations and read-only agent runs. It contains
an HTTPS endpoint, a random bearer and the SHA-256 fingerprint of the Mac's
certificate. The phone checks the pinned certificate before sending credentials;
Bonjour advertisements supply candidate addresses only. Credentials live in the
phone's non-synchronizing, device-only Keychain. Conversation data and drafts stay
in memory on the phone; Chat continues to save history on the Mac.

**Turn off** closes the listener and its connections without revoking pairing.
Turn it on again to permit saved phones. **Forget paired phones** rotates access
for all phones. **Forget Mac** on iPhone deletes that phone's saved pairing.
The listener starts off when the desktop app launches. Keep the Mac awake and
Chat running. Public URLs, relays and cellular access are not supported.

## Chat

Tap the familiar's name at the top to switch familiars. Each card shows the
familiar's description, its current chat, and whether it is replying or
archived. Send text and watch replies arrive, or stop an active run.

Replies render as Markdown, the way Chat on the Mac shows them:

- headings, lists, task lists, quotes and tables;
- code blocks with a **Copy** button (long blocks fold after 24 lines);
- tool calls fold into one line, such as "Read 2 files and ran 1 command",
  which you tap to see each call. While a reply runs, its last line says what
  the familiar is doing, such as "Running a command…".

Long-press a reply to copy it as text or Markdown, to select part of it, or to
share it. Long-press one of your own messages to copy it or, when the composer
is empty, to edit it as a new message. Pull down to refresh.
**⋯ › Connection Details** shows the Mac's address, the certificate fingerprint
the phone checks, and the app version.

A run started on either device occupies the same runtime; a second send cannot
bypass it. Archived chats are readable; restore one on the Mac before sending.
Attachments, write approvals, remote shell and push notifications are not part
of this version.

A connection failure never automatically sends the message again. The phone
checks the original request receipt after reconnecting. If its outcome remains
uncertain, inspect the conversation on the Mac before dismissing the pending
send. Request receipts persist across desktop restarts. They are bounded and
fail closed when full rather than evicting IDs and allowing duplicate execution.

## Build and verify

Requires Xcode with an iOS 18+ simulator, XcodeGen and the repository's Rust
1.95.0 toolchain. Generate the Xcode project with:

```sh
xcodegen generate --spec apps/ios/ChatCompanion/project.yml
```

Run the real HTTPS fixture, native tests, simulator UI flow and unsigned Release
device build together:

```sh
apps/ios/ChatCompanion/Scripts/test-e2e.sh
```

The script creates and removes its own simulator and temporary pairing state.
`CHAT_IOS_DESTINATION` can select an existing simulator; that simulator is retained.
`CHAT_IOS_FIXTURE_IP=10.255.255.1` binds the fixture to that private-range alias of
the loopback interface (added with `sudo ifconfig lo0 alias` if absent, removed on
exit) instead of the Mac's LAN address; CI sets it because the simulator's
connections to a hosted runner's NAT address drop now and then (#418).
`CHAT_IOS_UI_FLOW=0` runs the native unit tests only; CI sets it on pull requests
without the `ci:full` label, because the simulator UI flow is not deterministic on
hosted runners (#414). Pushes to `main`, labelled pull requests and a manual run
with `ui_flow` on still run the whole flow.
`CHAT_IOS_DERIVED_DATA` selects a persistent directory for Xcode test results.
The fixture uses synthetic chats, is gated behind `companion-fixture`, and is
absent from production builds. macOS Firewall may require permission for this
specific executable before same-LAN verification can run.

Simulator apps use ad-hoc signing so tests exercise the real Keychain. Disabling
signing produces a missing-entitlement error; no plaintext credential fallback
exists. The test suite checks malformed links, incorrect certificates/tokens,
Keychain replacement/deletion, forgotten-client races, uncertain sends, and
pair/send/stream/stop/relaunch/forget through the native UI.

The `iPhone companion` GitHub workflow runs this path. Physical iPhone acceptance
and TestFlight distribution are separate from simulator tests and unsigned device
builds. `project.yml` signs under the Soul Protocol LLC team (`9LR8Z8UQ9X`), where
the bundle ID `ai.opencoven.chat.companion` is registered. To install on a
physical device, sign in to Xcode with an account on that team, open the
generated project and run on the device. `test-e2e.sh` overrides the team and
signing on the `xcodebuild` command line, so tests and CI need no team account.

## TestFlight

`Scripts/testflight.sh` archives the app under the team and uploads it to App
Store Connect. It uses the App Store Connect API key the desktop release
notarizes with ([releasing](releasing.md)), so no Xcode sign-in is needed:

```sh
APPLE_API_KEY=<key id> APPLE_API_ISSUER=<issuer id> apps/ios/ChatCompanion/Scripts/testflight.sh
```

The `.p8` is read from `~/.appstoreconnect/private_keys/AuthKey_<key id>.p8`
unless `APPLE_API_KEY_PATH` names another file. Xcode creates or refreshes the
App Store provisioning profile through the key. The build number defaults to the
commit count of `HEAD`, so upload from `main`; `CHAT_IOS_BUILD_NUMBER` overrides
it. `CHAT_IOS_EXPORT=export` signs an `.ipa` and leaves it in a temporary folder
without uploading.

The upload needs an App Store Connect app record for the bundle ID. The App
Store Connect API cannot create one, so create it once on the website under
**Apps → New App**. A build appears in TestFlight after Apple finishes
processing it; internal testers on the team can then install it from the
TestFlight app. External testers need Beta App Review first. Physical-device
acceptance is tracked in #422; a successful upload does not prove it.
