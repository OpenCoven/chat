# iOS Phase G2: Lifecycle and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app correct when nobody is watching it — in the background, on a bad network, after a force-quit, with VoiceOver on, with a full disk — and prove the security posture the spec claimed rather than asserting it.

**Architecture:** No new subsystems. Background refresh reuses the read path the notification extension already uses. Reconciliation reuses Phase E's outbox and Phase F's action journal. The accessibility and security work is auditing and fixing what six phases built, with tests that keep the fixes fixed.

**Tech Stack:** Swift 6, SwiftUI, BackgroundTasks, XCTest, XCUITest, Rust 1.95.0, Node 24.

**Depends on:** `2026-08-17-ios-phase-g1-doorbell-relay-and-delivery.md`.

**Boundary:** No TestFlight, no App Store submission, no staged rollout. Phase H owns release. This phase ends with an app that is ready to be submitted, not one that has been.

---

## What This Phase Is Actually For

The previous six phases each ended with a feature working. This one ends with nothing new visible, and that is the point: it is where the claims made along the way get checked.

Three specific debts are being paid.

**The background is not the foreground.** Every phase so far tested behaviour with the app open and a person watching. The outbox drains because a view appeared. Ambiguous actions reconcile because someone opened a conversation. If the user never opens the app, none of it happens. Phase E's durable outbox and Phase F's action journal were built to survive termination; nothing yet exercises them across one.

**Accessibility was per-view, not per-app.** Each renderer got labels and Dynamic Type as it was written. Nobody has yet swiped through an entire transcript with VoiceOver, or set text to the largest accessibility size and looked at the composer, or turned off colour and asked whether a failed message still reads as failed.

**The security posture is documented, not demonstrated.** The spec says the bearer is excluded from backups, that TLS is pinned, that credentials never reach a log. Those are testable claims and none of them have been tested against an adversary rather than against a happy path.

---

## Working Directories

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git checkout -b feat/ios-phase-g2

cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git worktree add -b feat/ios-phase-g2-sdk .worktrees/ios-phase-g2-sdk feat/ios-phase-f-sdk
```

---

## Critical Rules

- **Background work is opportunistic and must be idempotent.** iOS decides when, whether, and for how long. Any code that assumes it ran is wrong.
- **No background path resubmits an ambiguous operation.** The rule from Phases E and F holds with nobody watching, which is when it matters most.
- **A fix without a test is not a fix.** Every accessibility and security finding in this phase lands with something that fails if it regresses.
- **Findings are recorded even when not fixed.** A known, written-down gap is a decision. A silently dropped one is a defect waiting to be rediscovered by a user.
- **Every commit signed.** Pass `-S`. **Do not push.**
- **No emojis** in commits or code.

---

## File Map

### chat-ios
- Create `app/Sources/Support/BackgroundScheduler.swift`, `BackgroundWork.swift`, `Diagnostics.swift`.
- Create `app/Sources/Views/DiagnosticsView.swift`.
- Modify `app/Sources/ChatApp.swift`, `Support/CaveStore.swift`, `ThreadModel.swift`, `Info.plist`, `project.yml`.
- Create `app/Tests/BackgroundWorkTests.swift`, `ReconciliationTests.swift`, `RedactionTests.swift`, `AccessibilityTests.swift`.
- Create `UITests/AccessibilityUITests.swift`, `UITests/DeviceMatrixUITests.swift`.
- Create `docs/security-review.md`, `docs/device-matrix.md`.
- Modify `.github/workflows/ci.yml`.

### sdk
- Modify `crates/cave-core/src/client.rs`, `crates/coven-transport/src/tls.rs` — pin failure observability.
- Create `crates/cave-core/tests/redaction.rs`.

---

## Task 1: Background Task Registration

**Files:** Create `app/Sources/Support/BackgroundScheduler.swift`; modify `Info.plist`, `ChatApp.swift`

- [ ] **Step 1: Declare the identifiers**

Add to `Info.plist`:

```xml
<key>BGTaskSchedulerPermittedIdentifiers</key>
<array>
    <string>ai.opencoven.chat.refresh</string>
    <string>ai.opencoven.chat.maintenance</string>
</array>
<key>UIBackgroundModes</key>
<array>
    <string>fetch</string>
    <string>remote-notification</string>
</array>
```

Two identifiers, because they are two different bargains with the system. `refresh` is short and frequent: drain the outbox, reconcile, refresh the list. `maintenance` is long and rare: evict the media cache, compact the read cache, and anything else that can wait for a charger.

- [ ] **Step 2: Write the failing tests**

Create `app/Tests/BackgroundWorkTests.swift`:

```swift
import BackgroundTasks
import XCTest
@testable import ChatIOS

@MainActor
final class BackgroundWorkTests: XCTestCase {
    func testRegistrationHappensBeforeLaunchCompletes() {
        // BGTaskScheduler throws if register is called after launch finishes.
        // A crash on a user's device at first background is not a thing to
        // discover in the field.
        let scheduler = RecordingScheduler()
        BackgroundScheduler(scheduler: scheduler).registerHandlers()
        XCTAssertEqual(Set(scheduler.registered), Set([
            "ai.opencoven.chat.refresh", "ai.opencoven.chat.maintenance",
        ]))
    }

    func testRefreshReschedulesItselfEvenWhenTheWorkFails() {
        // A task that only reschedules on success stops running forever after
        // one bad network moment.
        let scheduler = RecordingScheduler()
        let work = FailingWork()
        let subject = BackgroundScheduler(scheduler: scheduler, work: work)
        subject.runRefresh(task: FakeRefreshTask())
        XCTAssertEqual(scheduler.submitted.filter { $0 == "ai.opencoven.chat.refresh" }.count, 1)
    }

    func testTheTaskIsCompletedExactlyOnce() {
        let task = FakeRefreshTask()
        BackgroundScheduler(scheduler: RecordingScheduler()).runRefresh(task: task)
        XCTAssertEqual(task.completions.count, 1)
    }

    func testExpirationCompletesTheTaskAndCancelsWork() {
        // Failing to complete before expiry gets the app's background budget
        // cut by the system.
        let task = FakeRefreshTask()
        let work = HangingWork()
        BackgroundScheduler(scheduler: RecordingScheduler(), work: work).runRefresh(task: task)
        task.fireExpiration()
        XCTAssertEqual(task.completions, [false])
        XCTAssertTrue(work.wasCancelled)
    }

    func testMaintenanceRequiresPowerAndNetwork() {
        let scheduler = RecordingScheduler()
        BackgroundScheduler(scheduler: scheduler).scheduleMaintenance()
        let request = scheduler.lastProcessingRequest
        XCTAssertEqual(request?.requiresExternalPower, true)
        XCTAssertEqual(request?.requiresNetworkConnectivity, true)
    }

    func testNothingIsScheduledWhenNotEnrolled() {
        // There is nothing to refresh for an app that has never paired, and
        // asking the system for budget we cannot use spends goodwill.
        let scheduler = RecordingScheduler()
        BackgroundScheduler(scheduler: scheduler, isEnrolled: false).scheduleRefresh()
        XCTAssertTrue(scheduler.submitted.isEmpty)
    }
}
```

- [ ] **Step 3: Implement**

```swift
import BackgroundTasks

/// Owns the app's relationship with `BGTaskScheduler`.
///
/// Two identifiers because they are two different bargains: `refresh` is short
/// and frequent, `maintenance` is long and waits for a charger. Collapsing
/// them would mean either doing cache eviction on a thirty-second budget or
/// waiting for a charger to send a queued message.
@MainActor
final class BackgroundScheduler {
    static let refreshIdentifier = "ai.opencoven.chat.refresh"
    static let maintenanceIdentifier = "ai.opencoven.chat.maintenance"

    /// Earliest the system should consider a refresh. A floor, not a promise:
    /// iOS decides the real cadence from how the person uses the app.
    private static let refreshInterval: TimeInterval = 15 * 60

    private let scheduler: TaskScheduling
    private let work: BackgroundWorking
    private let isEnrolled: () -> Bool

    init(
        scheduler: TaskScheduling = BGTaskScheduler.shared,
        work: BackgroundWorking = BackgroundWork(),
        isEnrolled: @autoclosure @escaping () -> Bool = true
    ) {
        self.scheduler = scheduler
        self.work = work
        self.isEnrolled = isEnrolled
    }

    /// Register handlers. Must run before launch completes.
    func registerHandlers() {
        scheduler.register(identifier: Self.refreshIdentifier) { [weak self] task in
            self?.runRefresh(task: task)
        }
        scheduler.register(identifier: Self.maintenanceIdentifier) { [weak self] task in
            self?.runMaintenance(task: task)
        }
    }

    /// Ask for a refresh window.
    func scheduleRefresh() {
        guard isEnrolled() else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: Self.refreshInterval)
        try? scheduler.submit(request)
    }

    /// Ask for a maintenance window.
    func scheduleMaintenance() {
        guard isEnrolled() else { return }
        let request = BGProcessingTaskRequest(identifier: Self.maintenanceIdentifier)
        request.requiresExternalPower = true
        request.requiresNetworkConnectivity = true
        request.earliestBeginDate = Date(timeIntervalSinceNow: 6 * 60 * 60)
        try? scheduler.submit(request)
    }

    func runRefresh(task: BackgroundTaskHandle) {
        // Reschedule first. A path that reschedules only after success stops
        // running permanently the first time the network is bad.
        scheduleRefresh()

        let running = Task { await work.refresh() }
        task.expirationHandler = {
            running.cancel()
            task.setTaskCompleted(success: false)
        }
        Task {
            let succeeded = await running.value
            task.setTaskCompleted(success: succeeded)
        }
    }

    func runMaintenance(task: BackgroundTaskHandle) {
        scheduleMaintenance()
        let running = Task { await work.maintain() }
        task.expirationHandler = {
            running.cancel()
            task.setTaskCompleted(success: false)
        }
        Task {
            let succeeded = await running.value
            task.setTaskCompleted(success: succeeded)
        }
    }
}
```

with `TaskScheduling` and `BackgroundTaskHandle` protocols so the tests do not need a real scheduler.

Call `registerHandlers()` from `ChatApp.init`, and `scheduleRefresh()` on every background transition.

- [ ] **Step 4: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
git add app/
git commit -S -m "Register background refresh and maintenance tasks

Rescheduling happens before the work, not after it, so one bad network
moment does not silently end background refresh for good."
```

---

## Task 2: What Background Work Does

**Files:** Create `app/Sources/Support/BackgroundWork.swift`; modify `CaveStore.swift`

- [ ] **Step 1: Write the failing tests**

```swift
@MainActor
final class BackgroundWorkTests_Behaviour: XCTestCase {
    func testRefreshDrainsTheOutbox() async {
        let store = RecordingCaveStore()
        store.pendingOutbox = [.queued(id: "o1")]
        _ = await BackgroundWork(store: store).refresh()
        XCTAssertEqual(store.submittedOperations, ["o1"])
    }

    func testRefreshNeverSubmitsAnAmbiguousEntry() async {
        // The single most important assertion in this phase. Nobody is
        // watching, so a duplicate turn here would be discovered as two
        // identical replies from a familiar, hours later.
        let store = RecordingCaveStore()
        store.pendingOutbox = [.ambiguous(id: "o1")]
        _ = await BackgroundWork(store: store).refresh()
        XCTAssertTrue(store.submittedOperations.isEmpty)
    }

    func testRefreshNeverRetriesAnAmbiguousAction() async {
        let store = RecordingCaveStore()
        store.journal.seed(proposalId: "p1", state: .ambiguous)
        _ = await BackgroundWork(store: store).refresh()
        XCTAssertEqual(store.performedActions, 0)
    }

    func testRefreshReconcilesAmbiguousActionsAgainstCanonicalState() async {
        // Reconciling is a read. It is safe in the background and it is what
        // turns an unknown into a known before the user next looks.
        let store = RecordingCaveStore()
        store.journal.seed(proposalId: "p1", state: .ambiguous)
        store.actionEffectVisible = true
        _ = await BackgroundWork(store: store).refresh()
        XCTAssertEqual(store.journal.entry(proposalId: "p1")?.state, .completed)
    }

    func testRefreshStopsWhenCancelled() async {
        let store = SlowCaveStore()
        let work = BackgroundWork(store: store)
        let running = Task { await work.refresh() }
        running.cancel()
        _ = await running.value
        XCTAssertLessThan(store.completedSteps, store.totalSteps)
    }

    func testRefreshIsIdempotent() async {
        let store = RecordingCaveStore()
        store.pendingOutbox = [.queued(id: "o1")]
        _ = await BackgroundWork(store: store).refresh()
        _ = await BackgroundWork(store: store).refresh()
        XCTAssertEqual(store.submittedOperations, ["o1"], "a second run resubmitted")
    }

    func testMaintenanceEvictsTheMediaCache() async {
        let store = RecordingCaveStore()
        _ = await BackgroundWork(store: store).maintain()
        XCTAssertTrue(store.didEvictMedia)
    }

    func testMaintenanceDoesNotSendAnything() async {
        // Maintenance runs on a charger at three in the morning. It is not a
        // moment to discover that a queued message went out under a stale
        // revision.
        let store = RecordingCaveStore()
        store.pendingOutbox = [.queued(id: "o1")]
        _ = await BackgroundWork(store: store).maintain()
        XCTAssertTrue(store.submittedOperations.isEmpty)
    }

    func testRefreshDoesNothingWhenBackgroundRefreshIsDenied() async {
        let store = RecordingCaveStore()
        let work = BackgroundWork(store: store, refreshStatus: { .denied })
        XCTAssertFalse(await work.refresh())
        XCTAssertTrue(store.submittedOperations.isEmpty)
    }
}
```

- [ ] **Step 2: Implement**

```swift
import UIKit

/// The work a background window actually does.
///
/// Ordered by what a user would miss most if the window closed early:
/// reconcile first (it makes unknowns known and sends nothing), then drain the
/// outbox (it delivers what the user already asked for), then refresh reads
/// (it is only convenience).
@MainActor
struct BackgroundWork: BackgroundWorking {
    private let store: CaveStoring
    private let refreshStatus: () -> UIBackgroundRefreshStatus

    /// Refresh: reconcile, drain, then read.
    func refresh() async -> Bool {
        guard refreshStatus() == .available else { return false }
        do {
            try await reconcileAmbiguous()
            if Task.isCancelled { return false }
            try await store.drainOutbox()
            if Task.isCancelled { return false }
            try await store.refreshConversations()
            return true
        } catch {
            // A failed background window is not an error to show anyone. The
            // next one will try again, and the user is not here.
            return false
        }
    }

    /// Maintenance: reclaim space. Sends nothing.
    func maintain() async -> Bool {
        do {
            try store.evictMediaCache()
            try store.compactReadCache()
            return true
        } catch {
            return false
        }
    }

    /// Resolve every ambiguous action and outbox entry against canonical
    /// state. Reads only; nothing here submits or resubmits.
    private func reconcileAmbiguous() async throws {
        for entry in store.journal.ambiguous() {
            if Task.isCancelled { return }
            let landed = try await store.actionEffectVisible(entry: entry)
            try store.journal.reconcile(proposalId: entry.proposalId, landed: landed)
        }
        try await store.reconcileOutbox()
    }
}
```

- [ ] **Step 3: Test the real scheduler by hand**

Simulator and device behaviour differ enough that the unit tests above do not settle it. With the app backgrounded and the debugger attached:

```
(lldb) e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"ai.opencoven.chat.refresh"]
```

Then force expiry:

```
(lldb) e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateExpirationForTaskWithIdentifier:@"ai.opencoven.chat.refresh"]
```

Confirm the task completes rather than being killed, and that a queued message is delivered. Record both results.

- [ ] **Step 4: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
git add app/
git commit -S -m "Reconcile, drain, and refresh in the background

Reconciliation runs first because it is a read that turns unknowns into
knowns. Nothing in a background window resubmits an ambiguous operation,
which is the rule that matters most when nobody is watching."
```

---

## Task 3: Reconciliation on Foreground and on Doorbell

Background windows are not guaranteed. The two moments that *are* guaranteed — the user opening the app, and a doorbell arriving — must do the same work.

**Files:** Modify `ChatApp.swift`, `CaveStore.swift`, `NotificationRouter.swift`; create `app/Tests/ReconciliationTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
@MainActor
final class ReconciliationTests: XCTestCase {
    func testForegroundingReconcilesBeforeAnythingIsSent() async {
        let store = RecordingCaveStore()
        store.pendingOutbox = [.ambiguous(id: "o1")]
        await store.applicationDidBecomeActive()
        XCTAssertEqual(store.callOrder.first, "reconcile")
        XCTAssertTrue(store.submittedOperations.isEmpty)
    }

    func testADoorbellReconcilesToo() async {
        let store = RecordingCaveStore()
        store.journal.seed(proposalId: "p1", state: .ambiguous)
        await NotificationRouter(store: store).handleDoorbell(conversationId: "c1")
        XCTAssertGreaterThan(store.reconcileCalls, 0)
    }

    func testReconciliationIsNotRepeatedOnEveryForeground() async {
        // Foregrounding is frequent. Reconciling a hundred entries every time
        // the user glances at the app would spend the battery it saves.
        let store = RecordingCaveStore()
        await store.applicationDidBecomeActive()
        await store.applicationDidBecomeActive()
        XCTAssertEqual(store.reconcileCalls, 1)
    }

    func testAResolvedEntryStopsBeingReconciled() async {
        let store = RecordingCaveStore()
        store.journal.seed(proposalId: "p1", state: .ambiguous)
        store.actionEffectVisible = false
        await store.reconcileAll()
        await store.reconcileAll()
        XCTAssertEqual(store.actionVisibilityChecks, 1)
    }
}
```

- [ ] **Step 2: Implement and commit**

Add a debounce so reconciliation runs at most once per two minutes unless something changed, and wire it to `scenePhase == .active` and to doorbell handling.

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
git add app/
git commit -S -m "Reconcile on foreground and on doorbell

Background windows are not guaranteed, so the two moments that are
guaranteed do the same work, debounced so a glance at the app is not a
hundred reads."
```

---

## Task 4: The Accessibility Audit

Per-view accessibility landed as each renderer was built. This is the first time anyone traverses the whole app the way a VoiceOver user does.

**Files:** Create `app/Tests/AccessibilityTests.swift`, `UITests/AccessibilityUITests.swift`

- [ ] **Step 1: Do the audit by hand first, and write down what you find**

Automated checks find missing labels. They do not find a transcript that reads its timestamps before its messages, or a confirmation sheet that drops focus into nowhere on dismissal. Go through this list on a device with VoiceOver on, and record every finding in `docs/accessibility-findings.md` with a verdict of fixed, deferred, or not-a-problem:

1. Enroll by scanning a QR with VoiceOver on. Is the camera view usable, and is the manual-entry path discoverable?
2. Swipe through a transcript containing every block type from Phase F. Is the order sensible? Does each card read as one element or fragment into pieces?
3. Read a code block. Does it announce that it is code, and is copying reachable?
4. Read a carousel of four images. Are they navigable, and are unlabelled ones given a positional name?
5. Open an action proposal. Does the confirmation sheet trap focus, and does focus return to the card on cancel?
6. Send a message with the composer. Is the send button labelled and its disabled state explained?
7. Trigger a failed send. Is the failure announced, or only shown?
8. Open a spec document in the reader. Are headings navigable by rotor?
9. Set text to the largest accessibility size. Does the composer still fit? Does any card truncate its only label?
10. Turn on Reduce Motion. Does anything still animate meaningfully?
11. Turn on Differentiate Without Color. Is a failed message distinguishable from a sent one?
12. Turn on Reduce Transparency and Increase Contrast. Does any text drop below 4.5:1?

- [ ] **Step 2: Write the tests that keep the fixes fixed**

```swift
@MainActor
final class AccessibilityTests: XCTestCase {
    func testEveryBlockPresentationHasALabel() {
        for block in BlockFfi.allRepresentativeCases {
            let presentation = BlockPresentation(block: block)
            XCTAssertFalse(presentation.accessibilityLabel.isEmpty, "\(block) has no label")
        }
    }

    func testStatusIsNeverConveyedByColorAlone() {
        for state in OutboxState.allCases {
            let presentation = OutboxPresentation(state: state)
            XCTAssertFalse(presentation.statusWord.isEmpty)
            XCTAssertFalse(presentation.symbolName.isEmpty)
        }
    }

    func testFailuresAreAnnouncedNotOnlyShown() {
        let model = ThreadModel(conversationId: "c1", store: RecordingCaveStore())
        model.recordFailure("Could not send")
        XCTAssertEqual(model.pendingAnnouncement, "Could not send")
    }

    func testEveryInteractiveControlHasALabel() throws {
        // Walks the view hierarchy in a hosted controller and fails on any
        // control that is accessible but unlabelled.
        let unlabelled = try AccessibilityWalker.walk(RootView(store: .preview))
            .filter { $0.isInteractive && $0.label.isEmpty }
        XCTAssertTrue(unlabelled.isEmpty, "unlabelled controls: \(unlabelled.map(\.path))")
    }

    func testContrastMeetsTheThreshold() {
        for pair in Palette.allForegroundBackgroundPairs {
            XCTAssertGreaterThanOrEqual(pair.contrastRatio, 4.5, "\(pair.name) is below 4.5:1")
        }
    }
}
```

Add `UITests/AccessibilityUITests.swift` driving the real app at `UIContentSizeCategory.accessibilityExtraExtraExtraLarge`, asserting the composer's send button remains hittable and no primary label is truncated on the smallest supported device.

- [ ] **Step 3: Fix what the audit found, and record what you did not**

Each fix is its own commit referencing the finding. A deferred finding stays in `docs/accessibility-findings.md` with a reason. An empty findings file at the end of this task means the audit was not done.

- [ ] **Step 4: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOSUITests \
  -destination 'platform=iOS Simulator,name=iPhone SE (3rd generation)' test
git add app/ UITests/ docs/
git commit -S -m "Audit and fix accessibility across the app

Findings are recorded with a verdict each, including the deferred ones,
so a known gap is a decision rather than something to rediscover."
```

---

## Task 5: The Device Matrix

**Files:** Create `docs/device-matrix.md`, `UITests/DeviceMatrixUITests.swift`

- [ ] **Step 1: Automate what can be automated**

Network condition changes and force-quit cannot be driven from XCUITest alone, but their consequences can be simulated at the store layer. Write tests for: a transport that starts failing mid-drain, a candidate that stops resolving, a disk that reports full on write, and a relaunch with a populated outbox and journal.

```swift
    func testAFullDiskFailsVisiblyRatherThanSilently() async {
        // A cache write that fails silently means a transcript that looks
        // loaded and is not.
        let store = RecordingCaveStore()
        store.diskIsFull = true
        await store.refreshConversations()
        XCTAssertNotNil(store.surfacedError)
        XCTAssertTrue(store.surfacedError!.contains("storage"))
    }

    func testAnOutboxSurvivesRelaunchWithItsStateIntact() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let first = try Outbox(directory: directory.path)
        let entry = try first.enqueue(conversationId: "c1", familiarId: "f1", prompt: "hi", revision: "r1")
        let second = try Outbox(directory: directory.path)
        XCTAssertEqual(second.pending(conversationId: "c1").first?.id, entry.id)
    }
```

- [ ] **Step 2: Run the manual matrix and record every cell**

Create `docs/device-matrix.md` with a table filled in by observation, not by expectation. Every cell gets a date, a device, an OS version, and what actually happened.

| Scenario | Expected | Observed |
|---|---|---|
| Airplane mode, compose and send | Queued, shown as waiting, never as sent | |
| Airplane mode off | Sends exactly once; one turn in Cave | |
| Wi-Fi to cellular mid-stream | Stream resumes from cursor, no duplicate text | |
| Cellular to Wi-Fi with a different candidate | Reconnects without the user choosing an address | |
| Force-quit mid-send, relaunch | Confirmed or requeued, never duplicated | |
| Force-quit with a pending action, relaunch | Not completed unless Cave shows the effect | |
| Low storage (under 200 MB free) | Cache writes fail visibly; app stays usable | |
| Low Power Mode | Background refresh stops; foreground unaffected | |
| Background refresh disabled in Settings | App works; no silent failures | |
| Notification permission denied | App works; no doorbell prompts nag | |
| Locked device, doorbell arrives | Notification resolves or shows placeholder | |
| Overlay down, app opened | Explicit unreachable state; cached reads shown as cached | |
| Credential revoked in Cave | Explicit revoked state; no retry loop | |
| iPad, split view, half width | Layout holds; composer usable | |

Item 5 is the one that matters most, and it is the same item Phase E flagged. Run it three times, not once.

- [ ] **Step 3: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git add UITests/ docs/
git commit -S -m "Add the device matrix with observed results

Every cell records what happened on a real device, with a date and an
OS version, rather than what was expected to happen."
```

---

## Task 6: Diagnostics Without Leaks

The spec promised errors carry "a copyable diagnostic identifier that exposes no secrets." That surface does not exist yet.

**Files:** Create `app/Sources/Support/Diagnostics.swift`, `Views/DiagnosticsView.swift`, `app/Tests/RedactionTests.swift`, `crates/cave-core/tests/redaction.rs`

- [ ] **Step 1: Write the redaction tests first, in both languages**

`crates/cave-core/tests/redaction.rs`:

```rust
//! Nothing in an error message may carry a credential.
//!
//! These tests exist because the failure mode is invisible: an error that
//! includes a bearer works perfectly, reads plausibly, and quietly puts a
//! credential into every log, screenshot, and support ticket it touches.

use cave_core::{CaveError, CaveClient};

const BEARER: &str = "cave_live_supersecretvalue_98765";

#[test]
fn no_error_variant_renders_a_bearer() {
    let errors = vec![
        CaveError::Unreachable { detail: format!("connect failed for {BEARER}") },
        CaveError::Contract { detail: "bad shape".into() },
    ];
    for error in errors {
        let rendered = format!("{error}");
        assert!(!rendered.contains(BEARER), "a bearer reached an error: {rendered}");
    }
}

#[test]
fn the_debug_representation_of_a_client_hides_its_bearer() {
    let client = CaveClient::new(vec![], BEARER.to_string());
    assert!(!format!("{client:?}").contains(BEARER));
}

#[test]
fn prompt_text_never_reaches_an_error() {
    let error = CaveError::Contract { detail: "the model said something private".into() };
    assert!(!format!("{error}").contains("something private"));
}
```

The third test will fail against a naive implementation, and it should: `Contract { detail }` is a channel through which arbitrary content can reach a log. Fix it by classifying rather than quoting — the detail becomes a fixed description plus a field path, never the value.

`app/Tests/RedactionTests.swift` asserts the same for `ChatError.userFacingMessage`, for the diagnostics bundle, and for anything written with `os_log`.

- [ ] **Step 2: Implement the diagnostics surface**

A diagnostic report contains: app version, build, iOS version, device model, Cave API version, connection state, candidate count (not addresses), last error class, outbox depth, journal depth, and a generated report id. It does not contain: the bearer, any host or address, any conversation, any prompt, any attachment name, or any topic id.

The report id is generated locally and is meaningful only when the user quotes it alongside their own description. It is not a lookup key into anything, because a lookup key into a support system is a thing that has to store what it looks up.

- [ ] **Step 3: Add a CI redaction sweep**

```yaml
      - name: No credential-shaped interpolation in logs or errors
        run: |
          set -euo pipefail
          if grep -rn --include='*.swift' -E '(os_log|print|NSLog).*(bearer|token|secret|pushSecret)' app/ extension/; then
            echo "A credential-named value is interpolated into a log."
            exit 1
          fi
```

- [ ] **Step 4: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-g2-sdk && cargo test -p cave-core
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
git add app/ .github/
git commit -S -m "Add a diagnostics surface that carries no secrets

Error details are classified rather than quoted, because a detail field
that interpolates arbitrary content is a channel for credentials and
prompt text to reach every log that ever sees it."
```

---

## Task 7: The Security Review

Not a checklist to tick. Each item is a claim the spec made, and the task is to try to falsify it.

**Files:** Create `docs/security-review.md`

- [ ] **Step 1: Verify the Keychain posture adversarially**

Claim: the bearer is stored `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, excluded from iCloud sync and from backups, so a restored backup cannot resurrect a credential onto another device.

Test it:

1. Enroll a device. Take an unencrypted local backup with Finder.
2. Restore that backup to a second device.
3. Confirm the second device is unenrolled and cannot read from Cave.
4. Grep the backup for the bearer's first eight characters. Confirm nothing.

Record the result. If the credential survives, the storage attributes are wrong and this is the phase that finds out.

- [ ] **Step 2: Verify TLS pinning adversarially**

Claim: TLS is pinned to the fingerprint delivered by the QR.

Test it: put a proxy with its own CA between the phone and Cave, install that CA as trusted on the device, and attempt to connect. A pinned client must fail. If it succeeds, pinning is not doing anything and every claim resting on it is void.

Also test the honest-failure path: a Cave whose certificate legitimately rotated should produce an explicit pin-mismatch state with a re-enroll path, not a generic network error. A pinning failure that looks like bad Wi-Fi teaches users to retry through an attack.

- [ ] **Step 3: Verify scope enforcement**

Claim: scopes are least-privilege and revocable.

Test it: mint a credential with read-only scope, then attempt a send, an attachment upload, a GitHub action, and a conversation delete. Each must be refused by **Cave**, not merely hidden by the client. Client-side gating is a courtesy; server-side refusal is the control.

Then revoke the credential mid-stream and confirm the app reaches an explicit revoked state without a retry loop.

- [ ] **Step 4: Review the relay as its own trust boundary**

The relay is the only OpenCoven-operated component. Review it as if it were hostile:

- If the relay were compromised, what does it learn? (Per G1: that a device buzzed. Confirm by reading its storage schema, not by trusting the document.)
- Can a compromised relay read a conversation? It has no bearer and no Cave address.
- Can it forge a doorbell? Yes, and that is accepted: the worst case is a spurious buzz whose notification resolves to whatever Cave actually says.
- Can it suppress a doorbell? Yes. A doorbell is not a delivery guarantee, and the app must not treat a missing one as meaning nothing happened.
- Can a third party enumerate topics? Task 4 of G1 answers 401 identically for unknown, bad, stale, and replayed. Confirm by probing the deployed service.

- [ ] **Step 5: Review the parser surface**

Phase F's markup parser consumes untrusted model output. Confirm:

- No `unwrap`, `expect`, or slicing that can panic outside tests.
- Every bound is enforced: input size, marker count, carousel size, document size, nesting depth.
- A fuzz run over the parser survives. Add `cargo-fuzz` or a proptest harness, run it for at least ten minutes, and record the iteration count.

- [ ] **Step 6: Review dependencies**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo deny check licenses advisories
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust && cargo deny check licenses advisories
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay && npm audit --omit=dev
```

Confirm D1's GPL gate still passes, and that no dependency was added in Phases E through G that carries a copyleft obligation into a shipped binary.

- [ ] **Step 7: Write the review**

`docs/security-review.md` records, for each claim: the claim, how it was tested, what was observed, and the verdict. A claim that could not be tested is recorded as untested rather than as passing.

Include a short threat model naming what is explicitly out of scope: a compromised Cave host, a jailbroken device, a malicious familiar with legitimate Cave authority, and a user who approves an action they did not read. Each of those is real, and each is outside what this client can defend against.

- [ ] **Step 8: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git add docs/
git commit -S -m "Record the security review

Each claim was tested by trying to falsify it. An untested claim is
recorded as untested rather than as passing."
```

---

## Task 8: Phase Gate

- [ ] **Step 1: Full clean build and test everywhere**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-g2-sdk && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket/rust && cargo test -p coven-pocket-ffi
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay && npx vitest run && npx tsc --noEmit
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave && pnpm lint && pnpm typecheck && pnpm test:api && pnpm test:app && pnpm check:tests-wired
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
rm -rf build app/Sources/Generated rust/target
./scripts/build-xcframework.sh && xcodegen generate && swiftlint lint --strict
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

- [ ] **Step 2: Confirm no background path can resubmit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
grep -rn "drainOutbox\|performAction\|submit" app/Sources/Support/BackgroundWork.swift
```

Read every match. Confirm the only submission is `drainOutbox`, that it runs after reconciliation, and that nothing in the maintenance path submits anything at all.

- [ ] **Step 3: Confirm the three documents exist and are filled in**

```bash
wc -l docs/accessibility-findings.md docs/device-matrix.md docs/security-review.md
grep -c "Observed" docs/device-matrix.md
```

A device matrix with empty observed cells has not been run. A security review with no verdicts has not been done.

- [ ] **Step 4: The overnight test**

Install a build on a real device. Use it normally for a full day and overnight without opening it deliberately. The next morning, confirm:

1. Messages queued while offline were delivered, exactly once each.
2. No action shows as completed that Cave does not show.
3. No duplicate turns anywhere in any conversation.
4. Battery use attributable to the app is unremarkable in Settings.
5. The media cache is under its budget.

This is the test the whole phase exists for. Everything else is a proxy for it.

- [ ] **Step 5: Verify signatures**

```bash
for repo in chat-relay coven-cave chat-ios sdk; do
  cd "/Users/buns/Documents/GitHub/OpenCoven/$repo"
  echo "== $repo"
  git log --pretty='%H %G?' -40 | awk '$2 != "G" {print "UNSIGNED:", $0}'
done
```

Expected: no output.

---

## Phase G2 Completion

Phase G2 is done when:

- Background refresh reconciles, drains the outbox, and refreshes reads, and reschedules itself whether or not the work succeeded.
- Maintenance evicts the media cache on a charger and sends nothing.
- No background or foreground path resubmits an ambiguous message or action.
- Foregrounding and doorbell arrival reconcile, debounced.
- The accessibility audit has been performed by hand, every finding has a verdict, and tests keep the fixes fixed.
- Text at the largest accessibility size leaves the composer usable and no primary label truncated.
- No status is conveyed by colour alone.
- Every cell of the device matrix has an observed result with a date and an OS version.
- A diagnostic report carries no credential, address, or content, and CI fails if one is interpolated into a log.
- The security review records each claim, how it was falsified, and a verdict — including a backup-restore test and an adversarial pinning test.
- The parser survives a fuzz run, and every dependency licence is clean.
- The overnight test produced no duplicate turn and no false completion.
- Every commit is signed. Nothing is pushed.

**Not in this phase, by design:** TestFlight, App Store submission, and staged rollout.

## Handoff to Phase H

Phase H is release: TestFlight, App Store submission, and staged rollout. The spec's proof gate is evaluated after it, not before.

What G2 hands over:

- `docs/security-review.md` is most of an App Privacy questionnaire. The data-collection answers should be derived from it rather than filled in separately, because two documents describing the same thing will disagree eventually.
- `docs/device-matrix.md` names the devices and OS versions actually tested, which is the honest floor for the minimum-supported-version claim.
- The relay's `PRIVACY.md` is the source for anything the App Store listing says about notifications. It already states what the service can and cannot see.
- The relay is deployed and versioned separately from the app. Phase H's rollout plan needs to say what happens when an old app build meets a new relay, and the answer should be that the relay's `/v1` surface does not change.
