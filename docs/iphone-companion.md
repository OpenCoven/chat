# iPhone companion

The iPhone companion, **Coven Chat** on your home screen (source in
`apps/ios/ChatCompanion`), connects to a running Mac Chat app on the same
private IPv4 network. Coven runs on the Mac, with the same read-only
permissions and the same one-run-at-a-time limit as the desktop. You don't
need Cave. This supersedes earlier plans that routed the phone
through Cave.

## Connect

1. In Chat on the Mac, open **Settings** (the gear icon, or **Cmd+,**), choose
   **Devices**, then **iPhone companion**.
2. Choose **Turn on companion**. If macOS asks, allow Chat to accept incoming
   connections. Chat listens only on the selected private LAN address.
3. On iPhone, choose **Pair with your Mac** and scan the QR code; the phone
   connects as soon as it reads the code. To use the private pairing link instead, choose
   **Enter pairing link**, paste it and choose **Connect**. A link opened from
   elsewhere fills the field but still waits for **Connect**.

A link grants access to Chat conversations and read-only agent runs. It contains
an HTTPS address, a random bearer token and the SHA-256 fingerprint of the Mac's
certificate. Before sending credentials, the phone checks that the Mac presents
that exact certificate. Bonjour (local network discovery) only supplies
addresses to try. Credentials stay in the phone's Keychain on that device alone
and never sync to your other devices. Conversation data and drafts stay in
memory on the phone; Chat continues to save history on the Mac.

**Turn off** closes the listener and its connections without revoking pairing.
Turn it on again to let saved phones back in. **Forget paired phones** rotates
access for all phones. **Forget Mac** on iPhone deletes that phone's saved
pairing.

Deleting the app removes the pairing from the phone too. iOS keeps an app's
Keychain items after the app is deleted, so the app stamps the saved pairing
with an install identifier that iOS removes along with the app. A reinstalled
app deletes any pairing it didn't save and asks you to pair again (#465).
Updating the app keeps the pairing. Deleting the app doesn't change the Mac:
the access it gave the phone stays valid until **Forget paired phones**
rotates it for every phone.

iOS asks for Local Network access the first time the app reaches your Mac. If
the access is off, the app says so instead of reporting an unreachable Mac, and
**Open Settings** goes to Coven Chat's page in Settings, where the switch is.

The listener is off each time the desktop app starts. Keep the Mac awake and
Chat running. Public URLs, relays, and cellular access aren't supported.

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

Both devices share one runtime. While a run is going, whichever device started
it, a second send can't start another. Archived chats are readable; restore one
on the Mac before sending. Attachments, write approvals, remote shell and push
notifications aren't part of this version.

A connection failure never automatically sends the message again. After
reconnecting, the phone checks the Mac's receipt for the original request. If
the outcome is still uncertain, check the conversation on the Mac before you
dismiss the pending send. Receipts survive desktop restarts. The Mac keeps a
limited number of them. When that limit is reached, it refuses new sends from
the phone rather than dropping old receipts, because dropping one could let a
message run twice.

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
These variables change what it does:

- `CHAT_IOS_DESTINATION` selects an existing simulator, which the script keeps.
- `CHAT_IOS_FIXTURE_IP=10.255.255.1` binds the fixture to that private-range
  alias of the loopback interface (added with `sudo ifconfig lo0 alias` if
  absent, removed on exit) instead of the Mac's LAN address. CI sets it because
  the simulator's connections to a hosted runner's NAT address drop now and
  then (#418).
- `CHAT_IOS_UI_FLOW=0` runs the native unit tests only. CI sets it on pull
  requests without the `ci:full` label, because the simulator UI flow isn't
  deterministic on hosted runners (#414). Pushes to `main`, labelled pull
  requests and a manual run with `ui_flow` on still run the whole flow.
- `CHAT_IOS_DERIVED_DATA` selects a persistent directory for Xcode test results.

The fixture uses synthetic chats, is gated behind `companion-fixture`, and is
absent from production builds. You may need to allow this specific executable in
the macOS Firewall before same-LAN verification can run.

Simulator apps use ad-hoc signing so tests exercise the real Keychain. Disabling
signing produces a missing-entitlement error; no plaintext credential fallback
exists. The test suite checks malformed links, incorrect certificates and
tokens, Keychain replacement and deletion, forgotten-client races, uncertain
sends, and pairing, sending, streaming, stopping, relaunching and forgetting
through the native UI.

The `iPhone companion` GitHub workflow runs this path. Simulator tests and
unsigned device builds don't prove physical-device behavior or TestFlight
distribution; see [Device acceptance](#device-acceptance).

`project.yml` signs under the Soul Protocol LLC team (`9LR8Z8UQ9X`), where the
bundle ID `ai.opencoven.chat.companion` is registered. To install on a physical
device, sign in to Xcode with an account on that team, open the generated
project and run on the device. `test-e2e.sh` overrides the team and signing on
the `xcodebuild` command line, so tests and CI need no team account.

## TestFlight

CI sends the companion to TestFlight. Every push to `main` that changes
`apps/ios` runs the `iPhone companion` workflow's **TestFlight** job after the
tests pass. The job runs `Scripts/testflight.sh` and uploads a build numbered by
the commit count, using the App Store Connect key in the `release-signing`
environment. The archive is unsigned, and the export signs it with Apple's
cloud-managed distribution certificate (`CHAT_IOS_UNSIGNED_ARCHIVE=1`), so the
runner needs no certificate.

To prove signing from a branch without uploading, run the workflow by hand with
**testflight** set to `export`. `upload` is refused anywhere but `main`.

The upload needs an App Store Connect app record for the bundle ID. The App
Store Connect API can't create one, so create it once on the website under
**Apps → New App**. A build appears in TestFlight after Apple finishes
processing it. External testers need Beta App Review first.

### Upload from your Mac

`Scripts/testflight.sh` archives the app under the team and uploads it to App
Store Connect. It uses the App Store Connect API key the desktop release
notarizes with ([releasing](releasing.md)), so you don't need to sign in to
Xcode:

```sh
APPLE_API_KEY=<key id> APPLE_API_ISSUER=<issuer id> apps/ios/ChatCompanion/Scripts/testflight.sh
```

The `.p8` is read from `~/.appstoreconnect/private_keys/AuthKey_<key id>.p8`
unless `APPLE_API_KEY_PATH` names another file. Xcode creates or refreshes the
App Store provisioning profile through the key.

The build number defaults to the commit count of `HEAD`, so upload from `main`;
`CHAT_IOS_BUILD_NUMBER` overrides it. `CHAT_IOS_EXPORT=export` signs an `.ipa`
and leaves it in a temporary folder without uploading.

### Install from TestFlight

1. Accept the TestFlight invitation for **Coven Chat** sent to your Apple ID.
   Internal testers are members of the team's *Internal* group, which can see
   every build.
2. On the iPhone, open the **TestFlight** app, choose **Coven Chat** and tap
   **Install** (or **Update**). TestFlight installs the newest build; earlier
   builds are under **Previous Builds**.
3. Open Coven Chat and pair it with your Mac as described in
   [Connect](#connect).

A successful upload doesn't prove the app works on a device; that's what the
device acceptance run below is for.

To tell which build a phone runs, use App Store Connect, not `devicectl`. A
TestFlight install reports `builtByDeveloper: true` in
`xcrun devicectl device info apps`, the same as an Xcode install. A TestFlight
install raises the build's `installCount` in App Store Connect.

## Device acceptance

Accepted on 2026-10-15 on an iPhone 16 Pro Max running iOS 27.0.1, with
TestFlight build 0.2.0 (1454) and the published Chat 0.0.5 on macOS 26.7.1
(#422). On a physical phone, against the shipped desktop app:

- pairing by scanning the QR with the camera, and by **Enter pairing link**;
- reading, sending, streaming and **Stop** over the real Wi-Fi network, through
  the Mac's firewall rule for the shipped app;
- reconnecting by itself after the Mac sleeps and after its Wi-Fi drops;
- keeping the pairing across an app relaunch and a phone restart, and
  removing it with **Forget Mac**;
- recovering a reply after the app spends 30 seconds in the background;
- not sending a message twice when the network drops during the send.

Not proven yet:

- **Local Network permission.** iOS 27.0.1 never asked for it and listed no
  Local Network switch for the app, although the app declares it, browses
  `_coven-chat._tcp` and connects to a LAN address. Apple's
  [TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
  says each of those needs the permission. Apple's iOS 27 and 27.2 release
  notes describe no change to it. The Simulator does not apply Local Network
  privacy, so it cannot stand in for a phone. The app detects a denial in the
  two ways TN3179 describes: a browse waiting with `kDNSServiceErr_PolicyDenied`,
  or a connection whose path reports `localNetworkDenied`. The denied state has
  still not been seen on a phone (#465).
- **A change of the Mac's address while paired.** The Mac kept its address
  when its Wi-Fi was turned off and on.
