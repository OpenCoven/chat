# iOS Phase H: Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship OpenCoven Chat for iOS to the App Store — reproducibly built, honestly disclosed, actually reviewable, released in stages that can be stopped.

**Architecture:** No new product code. This phase adds release engineering to `chat-ios` (versioning derived from git, an archive and upload path, a pre-submission audit) and produces the disclosures Apple requires, each derived from a document Phase G2 already wrote rather than composed fresh.

**Tech Stack:** Xcode 17, `xcodebuild`, App Store Connect API, TestFlight, GitHub Actions, macOS runners.

**Depends on:** `2026-08-17-ios-phase-g2-lifecycle-and-hardening.md`. In particular `docs/security-review.md` and `docs/device-matrix.md` are inputs here, not references.

**Boundary:** This phase ends when the app is live at 100% and being watched. It does not include the proof-gate verdict, which by the spec's own terms cannot be evaluated until the app has run in real use through a full release cycle. The last task sets that up and hands it forward.

---

## What an Agent Cannot Do in This Phase

Most of this phase is not code, and a meaningful fraction of it cannot be executed by an agent at all. The program tracker's `needs-human` label exists for exactly this work, and pretending otherwise would produce a plan that reads as complete while nothing shipped.

Steps below marked **[human]** require a person signed in to an Apple account with the right role. An agent can prepare the inputs, write the exact text to paste, verify the result afterward, and record the outcome — but it cannot click the button.

| Requires a human | Why |
|---|---|
| Apple Developer Program membership and role assignment | Legal agreement, payment, identity |
| Creating signing certificates and provisioning profiles | Tied to an Apple ID with an enrolled team |
| Creating the App Store Connect record and bundle ID | Account-scoped, no API for first creation of some fields |
| Answering the App Privacy questionnaire | A legal representation about what the software does |
| Answering export compliance | A legal representation under export regulation |
| Submitting for review and replying to App Review | Account-scoped, and replies are correspondence |
| Starting, pausing, or resuming phased release | Account-scoped rollout control |

Everything else — the archive, the upload, the audits, the disclosures' *content* — is prepared here and verifiable.

**The single most important consequence:** do not mark a `needs-human` step complete because the preparation is done. It is complete when the human action happened and its result was observed.

---

## The Problem That Sinks Companion Apps

This app connects to a server the user runs, over an overlay network the user set up. Out of the box, on a reviewer's device, it does nothing at all. It cannot: there is no OpenCoven-hosted Cave, by design and by the spec's non-goals.

App Review rejects under Guideline 2.1 when a reviewer cannot exercise the functionality. This is the most likely cause of rejection for this submission by a wide margin — far more likely than anything about privacy, content, or design. It is not an edge case; it is the default outcome unless it is solved deliberately.

Task 7 solves it. It is worth reading before Task 1, because a decision there — standing up a reviewable Cave instance with a real, reachable address — has a lead time that the rest of the phase does not.

---

## Working Directories

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git checkout -b feat/ios-phase-h-release
```

---

## Critical Rules

- **A `needs-human` step is done when the human did it**, not when it was prepared.
- **Every disclosure is derived from a document, not written fresh.** The privacy answers come from `docs/security-review.md` and the relay's `PRIVACY.md`. Two documents describing the same behaviour will disagree eventually, and the one Apple sees must not be the one that drifted.
- **No analytics, no crash reporting SDK, no telemetry.** This is a deliberate constraint carried from the design, and Task 12 acknowledges what it costs.
- **Build numbers are monotonic and derived, never typed.** A hand-entered build number that goes backwards is a rejected upload at the worst moment.
- **The GPL gate runs on the shipping artifact**, not only on the dependency graph. App Store distribution is the channel the constraint exists to protect.
- **Nothing is submitted until the device matrix and security review are filled in.** They were the point of G2.
- **Every commit signed.** Pass `-S`. **Do not push.**
- **No emojis** in commits, code, or App Store metadata.

---

## File Map

### chat-ios
- Create `scripts/version.sh`, `scripts/archive.sh`, `scripts/upload.sh`, `scripts/audit-artifact.sh`.
- Create `ExportOptions.plist`.
- Create `docs/releasing.md`, `docs/app-review-notes.md`, `docs/privacy-disclosure.md`, `docs/rollout.md`, `docs/export-compliance.md`.
- Create `app/Resources/Acknowledgements.html` — generated third-party licence notices.
- Modify `project.yml`, `.github/workflows/ci.yml`.
- Create `.github/workflows/release.yml`.

---

## Task 1: Release Identity and Versioning

**Files:** Create `scripts/version.sh`; modify `project.yml`

- [ ] **Step 1: Decide the version scheme and write it down**

- `MARKETING_VERSION` comes from the git tag: `v1.0.0` produces `1.0.0`. An untagged build produces the last tag plus `-dev`, and cannot be uploaded.
- `CURRENT_PROJECT_VERSION` is `git rev-list --count HEAD`. It is monotonic on a linear `main`, requires no state outside the repository, and cannot be typed wrong.

App Store Connect requires the build number to increase within a version train. A rebuild of the same commit produces the same number and will be rejected as a duplicate — which is correct behaviour, because the fix is a new commit, not a new number.

- [ ] **Step 2: Implement**

Create `scripts/version.sh`:

```bash
#!/usr/bin/env bash
# Derives the version and build number from git.
#
# Nothing here is typed by a person. A hand-entered build number that goes
# backwards is an upload rejected at the worst possible moment, and a
# marketing version that disagrees with the tag is a release nobody can find
# the source for later.
set -euo pipefail

tag="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || echo '')"
if [ -z "$tag" ]; then
  echo "error: no v* tag found; tag a release before archiving" >&2
  exit 1
fi

marketing="${tag#v}"
exact="$(git tag --points-at HEAD --list 'v[0-9]*' | head -n1)"
if [ -z "$exact" ]; then
  marketing="${marketing}-dev"
fi

build="$(git rev-list --count HEAD)"

case "${1:-both}" in
  marketing) echo "$marketing" ;;
  build) echo "$build" ;;
  *) echo "MARKETING_VERSION=$marketing"; echo "CURRENT_PROJECT_VERSION=$build" ;;
esac
```

- [ ] **Step 3: Add the guard**

Add to `scripts/archive.sh` (Task 2) a refusal to archive a `-dev` version. A build that cannot say which tag it is has no business being uploaded.

- [ ] **Step 4: Test and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git tag -s v0.1.0 -m "Pre-release for pipeline testing"
./scripts/version.sh
git tag -d v0.1.0
git add scripts/ project.yml
git commit -S -m "Derive the version and build number from git

The build number is the commit count, so it is monotonic and cannot be
typed wrong. An untagged build is marked -dev and refuses to archive."
```

---

## Task 2: Distribution Signing and the Archive

**Files:** Create `scripts/archive.sh`, `ExportOptions.plist`; modify `project.yml`

- [ ] **Step 1 [human]: Create the signing assets**

In the Apple Developer portal:

1. Confirm the team is enrolled and the account has the Admin or App Manager role.
2. Register the bundle identifiers: `ai.opencoven.chat` and `ai.opencoven.chat.NotificationService`.
3. Enable the capabilities the app actually uses: Push Notifications, Background Modes, Keychain Sharing (the access group the extension and app share).
4. Create an **Apple Distribution** certificate and an **App Store** provisioning profile for each bundle id.

Record the Team ID. It goes in `project.yml` and in `ExportOptions.plist`, and it must match the `APNS_TEAM_ID` secret the relay uses — if those two disagree, pushes silently fail with `InvalidProviderToken` and the cause is not obvious.

- [ ] **Step 2: Wire the team into the project**

Set `DEVELOPMENT_TEAM` in `project.yml`, which D1 deliberately left empty. Keep `CODE_SIGN_STYLE: Automatic` for local development, and pass manual signing on the command line for release builds so a developer's Xcode state cannot influence what ships.

Add to `project.yml` the extension target's capabilities and the app's entitlements file, and confirm the shared Keychain access group matches the one G1's `PushRegistrar` and the notification extension use. A mismatch here means the extension cannot read the bearer, and the symptom is every notification falling back to the placeholder — which looks like a network problem and is not.

- [ ] **Step 3: Write the export options**

Create `ExportOptions.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>REPLACE_WITH_TEAM_ID</string>
    <key>uploadSymbols</key>
    <true/>
    <key>manageAppVersionAndBuildNumber</key>
    <!-- False on purpose. The version comes from git via version.sh; letting
         Xcode manage it would silently disagree with the tag. -->
    <false/>
</dict>
</plist>
```

- [ ] **Step 4: Write the archive script**

Create `scripts/archive.sh`:

```bash
#!/usr/bin/env bash
# Produces a signed .ipa from a clean tree.
set -euo pipefail

cd "$(dirname "$0")/.."

marketing="$(./scripts/version.sh marketing)"
build="$(./scripts/version.sh build)"

case "$marketing" in
  *-dev)
    echo "error: refusing to archive an untagged build ($marketing)" >&2
    exit 1
    ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "error: refusing to archive a dirty tree" >&2
  exit 1
fi

# A release build starts from nothing. A stale XCFramework or a leftover
# generated binding is exactly the sort of thing that ships once and is
# impossible to reproduce afterward.
rm -rf build app/Sources/Generated rust/target
./scripts/build-xcframework.sh
xcodegen generate

xcodebuild archive \
  -project ChatIOS.xcodeproj \
  -scheme ChatIOS \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath build/ChatIOS.xcarchive \
  MARKETING_VERSION="$marketing" \
  CURRENT_PROJECT_VERSION="$build" \
  CODE_SIGN_STYLE=Manual

xcodebuild -exportArchive \
  -archivePath build/ChatIOS.xcarchive \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export

echo "archived $marketing ($build) -> build/export/ChatIOS.ipa"
```

- [ ] **Step 5: Verify the archive**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
./scripts/archive.sh
unzip -l build/export/ChatIOS.ipa | head -30
codesign -dv --verbose=4 build/ChatIOS.xcarchive/Products/Applications/ChatIOS.app 2>&1 | grep -E 'Authority|TeamIdentifier'
```

Confirm the authority is Apple Distribution and the team identifier matches. Confirm the notification extension is present inside `PlugIns/` and separately signed.

- [ ] **Step 6: Commit**

```bash
git add scripts/ ExportOptions.plist project.yml
git commit -S -m "Add distribution signing and the archive script

A release build starts from a clean tree with the framework rebuilt,
because a stale artifact that ships once cannot be reproduced later."
```

---

## Task 3: The Upload Path

**Files:** Create `scripts/upload.sh`, `.github/workflows/release.yml`

- [ ] **Step 1 [human]: Create an App Store Connect API key**

In App Store Connect under Users and Access, Integrations, create an API key with the **App Manager** role. Download the `.p8` exactly once — it cannot be downloaded again. Record the Key ID and Issuer ID.

Store all three as repository secrets: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`. The `.p8` never enters the repository:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
grep -q '\*.p8' .gitignore || echo '*.p8' >> .gitignore
```

- [ ] **Step 2: Verify the upload tool before depending on it**

Apple's upload tooling has changed names and deprecation status several times. **Do not trust this document about the invocation.** Check what the installed Xcode actually offers before writing the script around it:

```bash
xcrun altool --help 2>&1 | head -40
xcrun notarytool --help 2>&1 | head -10
ls /Applications/Transporter.app 2>/dev/null && echo "Transporter present"
```

Write the script around whichever path the installed toolchain supports, and record which one in `docs/releasing.md` with the Xcode version. If `altool` prints a deprecation warning, note it and the replacement rather than ignoring it — the next person to run this will hit whatever it becomes.

- [ ] **Step 3: Write the upload script**

Create `scripts/upload.sh`, taking the API key from the environment, validating before uploading, and refusing to proceed if validation reports anything:

```bash
#!/usr/bin/env bash
# Validates and uploads the archive to App Store Connect.
set -euo pipefail

: "${ASC_KEY_ID:?set ASC_KEY_ID}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}"

ipa="build/export/ChatIOS.ipa"
[ -f "$ipa" ] || { echo "error: no archive at $ipa; run archive.sh" >&2; exit 1; }

# Validate first. An upload that fails validation after transfer wastes the
# build number, and build numbers only go forward.
xcrun altool --validate-app -f "$ipa" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

xcrun altool --upload-app -f "$ipa" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
```

The private key must be at `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8` for `altool` to find it; the workflow writes it there from the secret and removes it afterward.

- [ ] **Step 4: Add the release workflow**

Create `.github/workflows/release.yml`, triggered on a `v*` tag, running the full CI suite first and only then archiving and uploading. A release that skips the tests to save fifteen minutes is a release that ships something the tests would have caught.

Include the GPL gate in the release workflow explicitly, not by assuming CI ran it on the same commit.

- [ ] **Step 5: Commit**

```bash
git add scripts/ .github/ .gitignore docs/
git commit -S -m "Add the App Store Connect upload path

Validation runs before transfer, because a failed upload consumes a
build number and build numbers only go forward."
```

---

## Task 4: The App Store Connect Record

- [ ] **Step 1 [human]: Create the app record**

In App Store Connect, create a new iOS app with:

- Bundle ID `ai.opencoven.chat`
- SKU: `opencoven-chat-ios`
- Primary language: English (U.S.)
- Name and subtitle from Step 2

- [ ] **Step 2: Prepare the metadata as text, for a human to paste**

Write the exact strings into `docs/app-store-metadata.md` so they are reviewable in a diff rather than typed into a web form from memory. Include name, subtitle, promotional text, description, keywords, support URL, marketing URL, and the category.

Two constraints the description must satisfy, both learned from how this app actually works:

- **It must say, near the top, that the app requires a Cave instance the user runs.** Burying that is how you collect one-star reviews from people who downloaded a client for a server they do not have, and it is also what makes the 2.1 review conversation shorter.
- **It must not promise anything the app does not do.** No "AI assistant" framing that implies OpenCoven runs a model; the app talks to the user's own Cave and nothing else.

- [ ] **Step 3: Prepare screenshots**

Required sizes for the device families the app supports: 6.9-inch and 6.5-inch iPhone, and 13-inch iPad. Capture from the simulator with real-looking but fabricated conversation content, and confirm no screenshot contains a real hostname, token, QR code that resolves, or third-party name the app does not have permission to show.

A QR code in a screenshot is worth checking specifically. An enrollment QR carries a pairing grant; a screenshot of a live one is a credential in the App Store listing.

- [ ] **Step 4: Commit the metadata**

```bash
git add docs/app-store-metadata.md
git commit -S -m "Add App Store metadata as reviewable text

The listing strings live in a diff rather than being typed into a form,
and the description states up front that the app needs a Cave the user
runs."
```

---

## Task 5: Privacy Disclosure

**Files:** Create `docs/privacy-disclosure.md`

- [ ] **Step 1: Derive the answers rather than composing them**

Read `docs/security-review.md` from G2 and the relay's `PRIVACY.md` from G1, and write `docs/privacy-disclosure.md` mapping each App Privacy category to what those documents already establish.

The substance, which the document must justify rather than assert:

| Apple category | Answer | Because |
|---|---|---|
| Contact info, health, financial, location, contacts, browsing, search, purchases | Not collected | The app has no such surface |
| User content | Not collected **by OpenCoven** | Conversations live on the user's own Cave. The app sends nothing to any OpenCoven service |
| Identifiers — Device ID | **Collected**, not linked to identity, used for App Functionality | The doorbell relay stores an APNs device token. This is OpenCoven-operated, so it is a collection and must be declared |
| Diagnostics | Not collected | No analytics, no crash reporting SDK, no telemetry |
| Tracking | **No** | Nothing is shared with a data broker or used for cross-app advertising |

The Device ID answer is the one that requires care, and it is the one an incautious submission gets wrong in both directions. Declaring nothing would be false: OpenCoven operates the relay and it holds a device token. Declaring it as linked to the user would also be false: the relay cannot associate a token with a person, a Cave, or a conversation, and G1's design is what makes that true.

- [ ] **Step 2: Publish the privacy policy**

App Store Connect requires a reachable privacy policy URL. Host one that covers both the app and the relay, and derive it from the relay's `PRIVACY.md` rather than writing a second description of the same service.

State plainly: the app sends no data to OpenCoven except an APNs device token to the doorbell relay; conversations never leave the user's own infrastructure; there is no analytics; and notifications can be disabled entirely, in which case even the token is not held.

- [ ] **Step 3 [human]: Answer the questionnaire**

Fill in App Privacy in App Store Connect from `docs/privacy-disclosure.md`. Record the date and the answers given, so a future change to the app can be checked against what was declared.

- [ ] **Step 4: Add a drift check**

Add a CI step asserting no analytics or crash-reporting SDK has entered the dependency graph:

```bash
if grep -rniE 'firebase|amplitude|mixpanel|sentry|bugsnag|appcenter|segment|posthog' \
     project.yml rust/Cargo.lock 2>/dev/null; then
  echo "A telemetry SDK entered the build. The privacy disclosure says there is none."
  exit 1
fi
```

- [ ] **Step 5: Commit**

```bash
git add docs/privacy-disclosure.md .github/
git commit -S -m "Derive the App Privacy disclosure from the security review

The Device ID answer is collected-but-not-linked, which is only true
because of how the relay is built; the disclosure cites that rather than
asserting it."
```

---

## Task 6: Export Compliance

- [ ] **Step 1: Establish the facts before answering**

The app uses cryptography in three places, and the answer depends on which category they fall into:

1. TLS to Cave, through the Rust transport, with certificate pinning.
2. HMAC-SHA256 to sign doorbell pings.
3. Keychain storage, which is Apple-provided.

All three use standard, published algorithms for authentication and confidentiality of the app's own traffic. That is ordinarily the exempt case. **But** the TLS stack is the app's own rather than Apple's, which is a distinction the exemption questions ask about directly, and it is why this task exists instead of being a checkbox.

- [ ] **Step 2: Record the determination, and get it confirmed**

Write the analysis into `docs/export-compliance.md`: what algorithms, from which implementation, for what purpose, and which exemption is being claimed. This is a legal representation under U.S. export regulation, not an engineering judgement. **Have a person with authority to make it confirm it**, and record who and when.

If the exemption holds, set in `project.yml`:

```yaml
        INFOPLIST_KEY_ITSAppUsesNonExemptEncryption: NO
```

so the question is answered once in the build rather than re-answered per submission, where it can be answered differently by accident.

If the determination is that a self-classification report or an annual report is required, record that obligation with its cadence. An obligation nobody wrote down is an obligation that lapses.

- [ ] **Step 3: Commit**

```bash
git add docs/export-compliance.md project.yml
git commit -S -m "Record the export compliance determination

The app ships its own TLS stack rather than using Apple's, which is
exactly what the exemption questions ask about, so the analysis is
written down and confirmed rather than assumed."
```

---

## Task 7: Making the App Reviewable

The problem named at the top of this plan. Solve it before submitting, not after the first rejection.

- [ ] **Step 1: Stand up a review Cave instance**

A reviewer cannot join an overlay network. So the review instance must be reachable the ordinary way: a real hostname, a real certificate, and a Cave that is genuinely running with fabricated but plausible content.

Constraints on that instance:

- It exists for review and is torn down after. It is not a product.
- It contains no real conversation, no real project, and no real credential.
- Its content demonstrates the features a reviewer will look for: a few conversations, a familiar with a name and identity, some rich content, and at least one attachment.
- Its credential is scoped read-and-send, never conversation-delete or GitHub actions. A reviewer does not need to be able to merge a pull request to evaluate the app.
- It is time-boxed. The pairing grant and the credential expire after the review window, and the instance is shut down.

This does not weaken Cave's loopback posture as a product decision. It is one instance, deliberately exposed, for one purpose, temporarily — and the review notes should say so, because a reviewer who understands the architecture asks fewer questions.

- [ ] **Step 2: Write the review notes**

Create `docs/app-review-notes.md`. It gets pasted into the App Review Information field, and it is the single highest-leverage artifact in this phase. It must contain:

1. **One sentence on what the app is:** a client for a server the user runs themselves. No OpenCoven-hosted service exists.
2. **Why there is no account:** there is nothing to sign in to. Access is granted by pairing with the user's own instance.
3. **Exactly how to get in**, in numbered steps a person who has never seen this app can follow: install, tap Enroll, scan the QR image attached below, wait for the connection indicator to go green.
4. **The enrollment QR as an attached image**, plus its contents as text for the case where a reviewer cannot scan from a screen.
5. **What to try**, naming three concrete things: open a conversation, send a message and watch it stream, tap a rich card.
6. **What the notification permission is for:** a content-free doorbell, with one sentence on the relay.
7. **A contact** who will answer within a business day during the review window.

- [ ] **Step 3: Rehearse the review**

Hand a device, the build, and the review notes to someone who has not worked on the app. Watch them follow the notes without helping. Every place they hesitate is a place a reviewer will reject.

Record what you changed as a result. If nothing changed, the rehearsal was not honest.

- [ ] **Step 4: Verify the fallback path**

Confirm enrollment works by pasting the URI as text, not only by scanning, and that the review notes say so. Reviewers frequently work from a second device or a screenshot where a camera scan is not possible, and "the QR would not scan" is a rejection that costs a week.

- [ ] **Step 5: Commit**

```bash
git add docs/app-review-notes.md
git commit -S -m "Prepare App Review access and notes

The app does nothing without a Cave, which is a Guideline 2.1 rejection
by default. A temporary reachable instance and step-by-step notes are
what turn that into a normal review."
```

---

## Task 8: The Pre-Submission Audit

**Files:** Create `scripts/audit-artifact.sh`

- [ ] **Step 1: Audit the built artifact, not the source**

The GPL gate in D1 checks the dependency graph. This checks what actually shipped, because that is the thing being distributed.

Create `scripts/audit-artifact.sh` asserting, against `build/export/ChatIOS.ipa` and the archive:

```bash
#!/usr/bin/env bash
# Audits the shipping artifact. Everything here has a specific failure it
# exists to catch, named in the message.
set -euo pipefail

app="build/ChatIOS.xcarchive/Products/Applications/ChatIOS.app"
binary="$app/ChatIOS"
fail=0

check() {
  if eval "$2"; then
    echo "FAIL: $1"
    fail=1
  else
    echo "ok: $1"
  fi
}

# Debug-only private API used in G2's background-task testing, which belongs
# in lldb and never in a binary.
check "private BGTaskScheduler selector in the binary" \
  "strings '$binary' | grep -q '_simulateLaunchForTaskWithIdentifier'"

# The design forbids message content in a web view. This is the artifact-level
# version of the source-level CI gate.
check "WebKit linked into the app" \
  "otool -L '$binary' | grep -q WebKit"

check "a telemetry framework is linked" \
  "otool -L '$binary' | grep -qiE 'Firebase|Sentry|Bugsnag|AppCenter'"

# A staging or development relay URL shipping to production means devices
# register somewhere that will be torn down.
check "a non-production relay URL in the binary" \
  "strings '$binary' | grep -qE 'chat-relay-staging|localhost:8787|ngrok'"

check "a plaintext http:// Cave default in the binary" \
  "strings '$binary' | grep -qE 'http://[a-z0-9.-]+/api/client'"

# The extension must be present, or every notification falls back to the
# placeholder and the cause is invisible.
check "notification extension missing" \
  "! test -d '$app/PlugIns/ChatIOSNotificationService.appex'"

check "dSYMs missing from the archive" \
  "! test -d build/ChatIOS.xcarchive/dSYMs"

exit "$fail"
```

- [ ] **Step 2: Check the entitlements that shipped**

```bash
codesign -d --entitlements :- build/ChatIOS.xcarchive/Products/Applications/ChatIOS.app
```

Confirm exactly what is expected and nothing more: `aps-environment` set to `production`, the Keychain access group, and background modes. An entitlement nobody can explain is one to remove before submitting, not after.

- [ ] **Step 3: Ship the license acknowledgements**

The MIT election is not free. MIT requires its copyright notice and permission
notice to travel with every distribution, so an app that links `cave-core`,
`coven-transport`, and their permissive transitive crates must carry those
notices — and the App Store binary is a distribution.

Generate the set from the dependency graph rather than curating it by hand,
because a hand-kept list silently goes stale the first time a crate is added:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust
cargo install cargo-about --locked
cargo about generate about.hbs > ../app/Resources/Acknowledgements.html
```

Then confirm three things:

1. Every crate in the graph appears, with its license text, not merely its
   SPDX identifier.
2. The SDK components are listed **under MIT**, which is the arm this app
   elects. If any entry shows AGPL for an OpenCoven crate, the election is not
   being recorded and the spec's licensing constraint is unmet.
3. The acknowledgements are reachable in the shipped app — a Settings row is
   the conventional place — rather than existing only in the repository.

A dual-licensed dependency creates the obligation of whichever arm you take.
Taking MIT and then shipping no notice is the one way this design's licensing
posture can fail at the last step, after every earlier gate has passed.

- [ ] **Step 4: Confirm the G2 documents are complete**

```bash
grep -c "Observed" docs/device-matrix.md
grep -ci "untested" docs/security-review.md
```

A device matrix with empty cells and a security review full of untested claims mean this phase started early. Stop and finish G2.

- [ ] **Step 5: Verify the build on real hardware one more time**

Install the exact archived build — not a debug build — on a physical device and run the G2 overnight test's short form: enroll, read, send, stream, background, foreground, receive a doorbell. A Release configuration differs from Debug in optimization, assertions, and strict-concurrency enforcement, and the differences surface exactly here.

- [ ] **Step 6: Commit**

```bash
git add scripts/audit-artifact.sh
git commit -S -m "Audit the shipping artifact

Checks run against the binary rather than the source, because the binary
is the thing being distributed and a source gate cannot see what the
linker did."
```

---

## Task 9: TestFlight

- [ ] **Step 1: Upload the first build**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git tag -s v1.0.0 -m "OpenCoven Chat for iOS 1.0.0"
./scripts/archive.sh && ./scripts/audit-artifact.sh && ./scripts/upload.sh
```

- [ ] **Step 2 [human]: Internal testing first**

Add internal testers. Internal builds skip review, so this is where a broken build is discovered cheaply.

Run the full device matrix from G2 against the TestFlight build on at least three device and OS combinations, including the oldest supported. Record the results in `docs/device-matrix.md` as a second column — a build from the release pipeline is not the same artifact as a build from Xcode, and the matrix should say which one it tested.

- [ ] **Step 3 [human]: External testing**

External TestFlight requires Beta App Review, which is a lighter version of the real thing and an excellent rehearsal. Submit with the same review notes from Task 7.

**If Beta App Review cannot get in, App Review will not either.** Treat a beta rejection as the real signal it is, and fix Task 7 before proceeding.

- [ ] **Step 4: Run a real beta**

Recruit testers who run their own Cave, and at least one who does not and will have to set one up. The second group finds everything the first group cannot: unclear enrollment, missing prerequisites, and every assumption the team stopped seeing months ago.

Give it long enough to catch a background-refresh bug, which means days, not hours.

- [ ] **Step 5: Record what beta found**

Write `docs/beta-findings.md` with each report, its disposition, and whether it blocks release. A beta whose findings were not written down did not happen.

---

## Task 10: Submission

- [ ] **Step 1: Pre-flight**

Confirm, and record each:

1. `scripts/audit-artifact.sh` passes on the exact build being submitted.
2. The build number in App Store Connect matches `./scripts/version.sh build` at the tagged commit.
3. Metadata, screenshots, privacy answers, and export compliance are all in place.
4. The review Cave instance is up, and its credential is valid for at least three weeks.
5. Review notes name a contact who is actually available.
6. Phased release is **enabled** — Task 11 depends on it, and it cannot be turned on after the fact.

- [ ] **Step 2 [human]: Submit**

Submit for review. Record the date and build number.

- [ ] **Step 3: Prepare for the likely rejections in advance**

Write the responses before they are needed, in `docs/app-review-playbook.md`. Having the answer ready turns a week of round-trips into a day.

**Guideline 2.1, cannot access functionality.** The most likely. Response: reiterate the enrollment steps, confirm the review instance is up (check it before replying), offer a video of the flow, and offer to be available for a scheduled walkthrough. Do not argue; make it easier.

**Guideline 4.2, minimum functionality.** Response: the app is a full client for a conversation system, not a wrapper. Point at the streaming, the outbox, the rich content, and the offline behaviour. If the reviewer never got in, this is really 2.1 wearing a different number, and the fix is the same.

**Guideline 5.1.1, data collection.** Response: point at the privacy policy and the relay's design. The app collects a device token for notifications and nothing else, and notifications are optional.

**Guideline 2.5.1, private APIs.** Response: Task 8's artifact audit output. If a scanner flagged something, name the symbol and where it comes from.

**Guideline 3.1.1, in-app purchase.** Not applicable, but if raised: the app sells nothing and unlocks nothing.

**Encryption questions.** Response: `docs/export-compliance.md`, verbatim.

- [ ] **Step 4 [human]: Respond within a business day**

Review conversations stall when replies are slow. Every day of delay is a day the release is not out.

- [ ] **Step 5: Commit the playbook**

```bash
git add docs/app-review-playbook.md docs/beta-findings.md
git commit -S -m "Add the App Review playbook

The responses are written before they are needed, because the cost of a
rejection is mostly the round-trip time."
```

---

## Task 11: Phased Release

**Files:** Create `docs/rollout.md`

- [ ] **Step 1: Write down what would stop the rollout, before starting it**

The decision to pause is much harder to make in the moment than in advance. Write `docs/rollout.md` with explicit criteria:

**Pause immediately for:**

- Any report of a duplicated turn. This is the defect the outbox and journal exist to prevent, and it corrupts a user's canonical history rather than merely annoying them.
- Any report of an action showing as completed that Cave did not perform.
- Any crash on launch, on any supported device.
- Any credential appearing anywhere it should not — a log, a screenshot, a diagnostic report.

**Investigate but do not necessarily pause for:**

- Enrollment failures, which are more often overlay configuration than app defect. Distinguish before reacting.
- Notification delivery gaps. A doorbell is not a delivery guarantee, and the app is designed for it to be missed.
- Rendering complaints about specific markers. Phase F's `Unsupported` path means this degrades rather than breaks.

**Not a reason to pause:**

- Low adoption. This app requires a self-hosted server; low install counts are the expected shape, not a signal.

- [ ] **Step 2: Acknowledge what the rollout cannot do**

There is no remote kill switch. The app has no OpenCoven-operated component except the relay, and the relay only sends doorbells — disabling it stops notifications and nothing else. This is a direct consequence of the design's non-goals and is correct, but it means the only levers are:

1. Pause phased release, which stops new users from receiving the update.
2. Ship a fix and request expedited review.

Neither helps a user who already updated. Write that down, because it is the reason the pause criteria above are conservative.

- [ ] **Step 3 [human]: Start the phased release**

Apple's phased release runs over seven days at roughly 1, 2, 5, 10, 20, 50, and 100 percent. Start it, and check the criteria daily rather than at the end.

- [ ] **Step 4: Watch each day and record it**

Append to `docs/rollout.md` a dated line per day: percentage, any reports, and the decision to continue or pause. Seven lines, written the day of, not reconstructed afterward.

- [ ] **Step 5: Commit**

```bash
git add docs/rollout.md
git commit -S -m "Add the rollout plan and pause criteria

The criteria are written before the rollout starts, because deciding to
pause is much harder in the moment. There is no remote kill switch, by
design, which is why they are conservative."
```

---

## Task 12: After Release, and the Proof Gate

- [ ] **Step 1: Acknowledge the observability problem honestly**

The app ships no analytics and no crash reporting. That was a deliberate design choice and it remains right — but it means correctness defects reach the team only through user reports and the diagnostic report id from G2.

The consequence for the proof gate is specific and worth stating plainly: **"no correctness defect attributable to the core" will be an absence of reports, not a measurement.** That is weaker evidence than it sounds, and the gate's verdict should say so rather than treating silence as proof.

Two things make the silence more meaningful without adding telemetry:

- Ask beta testers and early adopters directly, once, a few weeks in, with specific questions: did any message appear twice, did any action claim to have happened that had not, did any conversation show something Cave did not have. Specific questions get answers that "how is it going" does not.
- Compare against Cave. A duplicated turn is visible in canonical history. A user willing to look at their own Cave can answer the most important question definitively.

- [ ] **Step 2: Define what "one full release cycle" means**

The spec's proof-gate condition 4 requires that "iOS has run in real use through at least one full release cycle with no correctness defect attributable to the core." That phrase needs a definition before it can be evaluated, and defining it after the fact invites grading one's own homework.

Proposed, to be recorded in `docs/proof-gate.md`: a full release cycle is **1.0.0 reaching 100% phased release, plus a subsequent 1.0.x or 1.1.0 shipped and reaching 100%**, with at least sixty days between the first release and the evaluation. One release proves the app can ship. Two prove it can change without breaking, which is the property desktop would actually be relying on.

- [ ] **Step 3: Evaluate conditions 1 through 3 now**

These are testable today and do not need a release cycle:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
cargo test -p cave-core --test conformance --test markup_vectors
```

1. **`cave-core` passes the same exported conformance fixtures the TypeScript client passes.** Run both and record the fixture digest each consumed. Identical digests, both passing, or the condition fails.
2. **The hostile-content corpus and fuzzing pass with no parser findings.** Run the fuzz harness from G2's Task 7 for a recorded duration and iteration count. "We ran it for a bit" is not a result.
3. **The UniFFI build is green in CI on macOS and Linux.** Link the workflow run.

Record each verdict in `docs/proof-gate.md` with evidence, not assertion.

- [ ] **Step 4: Schedule the condition 4 evaluation**

Condition 4 cannot be evaluated in this phase. Record the date it becomes evaluable, per Step 2's definition, and what evidence will be gathered. Leave the overall gate verdict explicitly **open**.

Writing "gate: open, condition 4 evaluable after <date>" is the honest output of this phase. Writing "gate: passed" would be the failure mode the gate exists to prevent — the whole point of it is that desktop does not migrate onto `cave-core` because the iOS work felt like it went well.

- [ ] **Step 5: Commit**

```bash
git add docs/proof-gate.md
git commit -S -m "Evaluate proof-gate conditions 1 through 3 and schedule 4

Condition 4 needs a release cycle, so the gate verdict stays open with a
date rather than being called passed because the release went well."
```

---

## Phase H Completion

Phase H is done when:

- A tagged commit produces a signed, reproducible archive from a clean tree, with a version and build number derived from git.
- The artifact audit passes on the exact build submitted: no private API, no WebKit, no telemetry framework, no staging relay URL, extension present, dSYMs present.
- Third-party licence acknowledgements ship inside the app, generated from the dependency graph, listing the OpenCoven SDK components under MIT — the arm this app elects.
- App Privacy answers are derived from the security review and the relay's `PRIVACY.md`, and declare the device token honestly as collected-not-linked.
- The export compliance determination is written down and confirmed by someone with authority to make it.
- A reviewer can get into the app, verified by a rehearsal with someone who did not build it.
- Internal and external TestFlight have run, and beta findings are recorded with dispositions.
- The app passed review and reached 100% phased release.
- Rollout was watched daily against criteria written before it started, with a dated line per day.
- Proof-gate conditions 1 through 3 are evaluated with evidence, and condition 4 has a definition and a date.
- Every commit is signed.

**Not in this phase, by design:** the proof-gate verdict, and any decision about migrating desktop onto `cave-core`.

## After Phase H

The iOS program is complete. What remains is the thing it was partly for.

The spec's position is that desktop Chat does not re-plan onto `cave-core` until all four proof-gate conditions hold, and that until then differential testing is what keeps the two implementations honest. Phase H leaves conditions 1 through 3 evaluated and condition 4 dated.

When that date arrives, the evaluation is a small piece of work with a large consequence: a passing gate opens a desktop migration that would delete a TypeScript implementation and put both clients on one core. A failing one means the differential harness keeps earning its cost. Either outcome is useful; treating the question as settled early is the only bad option.

The one thing to carry forward: `crates/cave-core/fixtures/markup-vectors.json` and the exported contract fixture are what make the comparison possible at all. Whatever happens to either client, those files stay shared, and a change to one implementation that does not update them is the change that quietly ends the guarantee.
