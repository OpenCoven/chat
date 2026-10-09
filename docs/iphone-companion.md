# iPhone companion

The SwiftUI companion in `apps/ios/ChatCompanion` connects to a running Mac Chat
app on the same private IPv4 network. Coven runs on the Mac, with the same
read-only permissions and single-run guard used by the desktop. Cave is not
required. This replaces the August Cave-dependent iOS implementation plans.

## Connect

1. In Chat on the Mac, open **Sidebar options** (⋯), then **iPhone companion**.
2. Choose **Turn on companion**. If macOS asks, allow Chat to accept incoming
   connections. The listener binds only to the selected private LAN address.
3. On iPhone, choose **Pair with your Mac** and scan the QR, or copy and paste
   the private pairing link. Choose **Connect**.

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

Select a familiar to read its recent Chat history. Send text and watch replies
arrive, or stop an active run. A run started on either device occupies the same
runtime; a second send cannot bypass it. Archived chats are readable; restore
one on the Mac before sending. Attachments, write approvals, remote shell and
push notifications are not part of this version.

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
builds. To install on a physical device, open the generated Xcode project and
select the appropriate Apple development team. Distribution needs a registered
bundle ID, signing profiles, app record and App Store Connect upload; an unsigned
Release build does not prove any of those.
