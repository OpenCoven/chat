# Coven Mobile First Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved Mac-hosted mobile release with secure remote access, protected drafts/history and send recovery, real attachments and completion alerts, followed by the retained voice and native-integration roadmap.

**Architecture:** The Mac remains the execution host and owns canonical history, run admission and Stop. Native iOS persistence is an independently deliverable first milestone; relay, media and push are separate subsystems with their own integration gates. Existing Coven channel authority is reused through a shared library only after source extraction and compatibility are established; no replacement encryption protocol is invented.

**Tech Stack:** SwiftUI, Foundation, CryptoKit and XCTest on iOS 18+; existing Tauri/Rust desktop runtime; Coven-owned Rust transport and opaque WebSocket relay; APNs through an operator-controlled provider service.

**Spec:** [Approved mobile design](../specs/2026-11-12-mobile-first-release-design.md). Tracking issue: [#612](https://github.com/OpenCoven/chat/issues/612). Status: current; Val approved this plan and Native execution on 2026-11-13. The design was approved on 2026-11-12.

## Global Constraints

- The Mac must be awake and Chat running for execution. No always-on cloud runtime is introduced.
- Protected native persistence is enabled by default: history for seven days, up to 20 MiB total; attachment staging up to 24 hours within 32 MiB. Browser conversation/draft storage remains prohibited.
- Minimal unresolved-operation metadata survives the no-text-cache setting; no prompt or attachment bytes persist in that mode.
- Never automatically replay an uncertain send or replace its request UUID. Exact peer/familiar/canonical-session identity and payload digest accompany recovery.
- Media limits: four total attachments, 5 MiB per encoded image, 16 MiB per message and a 2048-pixel maximum image edge; existing text files remain limited to 64 KiB each.
- Preserve current full-access execution, shared run exclusion, canonical ownership, lifecycle/tombstones and Stop. No fake image input, provider keys in clients or release bypasses.
- All work uses owned isolated worktrees and signed commits. Re-read each owning repository's instructions and live claims before cross-repository edits.
- Available TestFlight plus physical iPhone acceptance is the first-release finish line; a completed persistence milestone is not the mobile release.

## Review Focus

- Kill the app after host admission but before the send response: restore the exact UUID and reconcile without a second send (Tasks 2–3).
- Change the canonical head or paired host while a delayed read/write completes: never put old content or a draft into the new destination (Tasks 1–3).
- Lock the phone or fill/corrupt protected storage: preserve visible unsent work and refuse dispatch if recovery cannot be recorded (Tasks 1–3).
- Revoke a phone while its channel/run/push registration is active: refuse subsequent operations and Stop only its admitted run (Task 4).
- Interrupt or maliciously replace image/upload/relay data: reject invalid content and partial uploads without executing a request (Tasks 4–5).

## Delivery boundaries

Tasks 1–3 form the fully specified native persistence milestone below. Tasks 4–7 identify the required remaining subsystems, their interfaces, tests and mandatory readiness checkpoints. Their detailed implementation plans are written in the owning repository after the checkpoint establishes the actual shared-library/engine/service contracts; speculative APIs must not be committed as working implementations. Deployment can remain unprovisioned while independent local engineering continues, but release acceptance cannot.

The recommended execution method is **Native**: this session implements each task, using focused tests and signed commits, followed by a fresh whole-branch review. This avoids repeatedly transferring the persistence model and cross-repository authority constraints between implementers. Subagent-driven execution is also available if the user prefers fresh implementation and review contexts per task. The writing-plans skill requires the user to review this plan and select the method before implementation.

## Task 1: Protected native persistence boundary

**Files:** Create `apps/ios/ChatCompanion/Sources/CompanionPersistence.swift`, `apps/ios/ChatCompanion/Sources/ProtectedCompanionStore.swift`, and `apps/ios/ChatCompanion/Tests/PersistenceTests.swift`. Modify `apps/ios/ChatCompanion/Sources/PairingStore.swift` only if exposing the existing installation identity needs a stable accessor; do not change Keychain access policy incidentally.

**Interfaces:**

- `CacheNamespace: Codable, Equatable` contains `installationID: Data`, `hostFingerprint: String`, and `authorizationID: String`. `init(installationID: Data, pairing: Pairing)` uses SHA-256 of the legacy bearer for `authorizationID`; no raw bearer or endpoint is written to the cache. V2 later supplies its device/grant identity through a separate initializer.
- `DraftBinding: Codable, Equatable` contains `familiarID: String` and `sessionID: String?`; nil is the explicit pre-session slot, not a wildcard.
- `SavedDraft: Codable, Equatable` contains `binding: DraftBinding`, `text: String`, `revision: UUID` and `updatedAt: Date`.
- `CachedConversation: Codable, Equatable` contains `familiarID: String`, `history: History` and `savedAt: Date`. Add `Equatable` to `History` if needed by value assertions.
- `PendingCompanionOperation: Codable, Equatable` contains `requestID: String`, `kind: Kind` (`send` or `allow`), `familiarID: String`, `sessionID: String?`, `payloadDigest: String`, `submittedDraftRevision: UUID?` and `createdAt: Date`. It never contains a prompt or attachment bytes.
- `CompanionSavedState: Codable` contains `version: Int` (1), `namespace: CacheNamespace`, `snapshot: Snapshot?`, `selectedFamiliarID: String?`, `drafts: [SavedDraft]`, `conversations: [CachedConversation]`, `pending: PendingCompanionOperation?` and `cacheConversationText: Bool`.
- `@MainActor protocol CompanionPersistence` defines `load(for: CacheNamespace) throws -> CompanionSavedState?`, `save(_: CompanionSavedState) throws` and `erase(for: CacheNamespace) throws`.
- `@MainActor final class ProtectedCompanionStore` implements that protocol with `init(root: URL, installationID: Data, now: @escaping () -> Date = Date.init)`. Production root is Application Support/CompanionCache. Hashed installation/peer components name private files; validate the decoded namespace before use.

- [x] Write `PersistenceTests.testStateRoundTripsAcrossStoreInstances`, `testDifferentInstallHostOrAuthorizationCannotLoadState`, `testCacheContainsNoBearerOrEndpoint`, `testSevenDayHistoryExpiry`, `testOldestHistoryEvictionAtTwentyMiB`, and `testPendingOperationIsNeverEvicted`. Use temporary directories and a fixed clock, not the real application container.
- [x] Run the targeted XCTest selection and observe failure because the persistence types do not exist. Preserve the first result bundle/log.
- [x] Implement the value types and file store. Use protected atomic file writes, set `isExcludedFromBackup`, reject symlink/non-regular targets and unsupported schema/namespace, bound reads before decoding, and prune expired/oldest history until the serialized state fits 20 MiB. Do not drop unresolved metadata or drafts to fit; throw visibly if they alone exceed the bound. Timestamps implausibly in the future must not grant indefinite retention.
- [x] Add and run `testFilesHaveCompleteProtectionAndBackupExclusion`, `testCorruptOversizedAndUnsupportedStateRefuseWithoutReplacingBytes`, `testSymlinkTargetsRefuseWithoutTouchingDestination`, and `testEraseIsIdempotent`. Use the actual native file-protection attributes on the iOS simulator; physical lock behavior stays a device gate.
- [x] Verify all persistence tests pass, run `git diff --check`, and sign a focused commit for the store and tests.

## Task 2: Recover model state and immutable operation identity

**Files:** Modify `apps/ios/ChatCompanion/Sources/CompanionModel.swift`, `apps/ios/ChatCompanion/Sources/ChatCompanionApp.swift`, `apps/ios/ChatCompanion/Sources/PinnedAPI.swift`, and `apps/ios/ChatCompanion/Tests/ModelTests.swift`; add `apps/ios/ChatCompanion/Sources/CompanionRequestEncoding.swift` and `apps/ios/ChatCompanion/Tests/ModelPersistenceTests.swift`.

**Interfaces:**

- Require `persistence: CompanionPersistence` and `installationID: Data` in the model initializer, preserving existing client/discovery injections. The production app injects the protected store and existing `InstallIdentity.id`; all tests inject an isolated in-memory or temporary-file implementation.
- Expose read-only `cachedAt: Date?`, `persistenceError: String?`, `cacheConversationText: Bool` and `recoveredDrafts: [SavedDraft]` for Task 3. Cache restoration leaves `connected` and `historyReady` false.
- Add `flushPersistence()`, `setCacheConversationText(_ enabled: Bool)`, `clearDownloadedHistory()`, and `restoreDraft(revision: UUID)` on the main actor. Storage errors remain visible; they never silently substitute a non-durable store.
- Draft edits use monotonically new UUID revisions, a 250 ms debounce and an explicit scene-transition flush. Each scheduled save captures the current generation/namespace and refuses to write after pairing/Forget changes.
- `CompanionRequestEncoding.encode<T: Encodable>(_ value: T) throws -> Data` uses `JSONEncoder` with sorted keys. Both `PinnedAPI` and the model use this encoder for send/approval bodies so the CryptoKit SHA-256 digest names the exact dispatched bytes rather than a separately ordered JSON encoding.
- `send()` and `allow(_:)` save their `PendingCompanionOperation` synchronously before invoking the network client. Hash the exact JSON request bytes via CryptoKit SHA-256; future transport adapters must use those same bytes. Reconcile restored operations only with `run(id:)` and authoritative history.

- [x] Add failing tests `testDraftAndCachedHistoryRestoreBeforeNetwork`, `testRelaunchAfterUncertainSendQueriesSameUUIDWithoutSending`, `testPersistenceFailurePreventsNetworkDispatch`, `testUncertainAllowAlsoSurvivesRelaunch`, and `testNewDraftRevisionSurvivesOldSendCompletion`. Extend the fake client with explicit history/receipt values and request-call capture; use continuations to order races, not sleeps.
- [x] Implement hydration, selection retention, draft revisions, cached authoritative reads and pre-dispatch persistence. A confirmed admission clears only the submitted revision. A terminal receipt settles pending metadata; a missing receipt keeps sending blocked until the existing explicit “I checked” action. That action must persist removal before unblocking.
- [x] Add failing tests `testDifferentCanonicalHeadOffersRecoveredDraftWithoutMovingIt`, `testLateHistoryCannotOverwriteNewSelectionOrPairing`, `testOldDebounceCannotRecreateForgottenCache`, `testChangedLegacyBearerCannotReuseCachedState`, and `testCurrentSnapshotRemovesNoLongerVisibleCachedHistory`.
- [x] Implement exact binding behavior. Current v1 history does not expose enough lineage to silently move a draft across a changed head, so place it in `recoveredDrafts`; explicit restore binds it to the currently verified destination without sending. Discard history absent from a complete authoritative snapshot, and clear corresponding loaded transcript state. Never enable Send using cached archive/selection data alone.
- [x] Make Forget/revocation clear the peer store and secure pairing with generation invalidation before delayed tasks can write. If either cleanup fails, keep a visible retryable cleanup state. A missing/reinstalled pairing must not hydrate an old cache; remove old-install cache partitions on protected-store initialization.
- [x] Add and pass `testNoTextCacheStripsDiskBodiesButRetainsPendingIdentity`, `testClearDownloadedHistoryPreservesDraftAndUncertainOperation`, `testForgetAndRevocationPurgeCachedContent`, and `testCleanupFailureRemainsVisibleAndRetryable`.
- [x] Run the entire existing model test class and new model-persistence tests, then sign the integration commit. Existing full-access policy and host receipt semantics must remain unchanged.

## Task 3: Native privacy controls, offline state and recovery UX

**Files:** Modify `apps/ios/ChatCompanion/Sources/CompanionViews.swift`; create `apps/ios/ChatCompanion/Sources/MobilePrivacyViews.swift`; modify `docs/iphone-companion.md`, `SECURITY.md`, and the companion UI tests under `apps/ios/ChatCompanion/UITests/`.

**Interfaces:** `MobilePrivacyView(model: CompanionModel)` calls the Task 2 methods. Add a Privacy entry to the existing connection-options menu. A recovered-draft sheet lists the original familiar/session context, timestamp and editable content; Restore requires a currently verified destination and uses `restoreDraft(revision:)`. It never sends automatically.

- [ ] Add failing UI/model assertions for `mobile-privacy`, `cache-conversation-text`, `clear-downloaded-history`, `cached-history-status` and `recovered-drafts`. Verify controls have accessible labels, show storage errors, and cannot enable offline Send.
- [ ] Implement the privacy sheet with exact choice “Keep conversation text only while open” and explanation that minimal send-recovery metadata and pairing credentials remain. Clearing downloaded history leaves drafts and unresolved operations intact; disabling text caching immediately removes existing persisted bodies and attachment staging while retaining minimal recovery metadata.
- [ ] Show saved/last-updated state with cached history and explain when the Mac is unreachable. Preserve the existing inactive-scene privacy overlay; flush pending edits on scene transition. Do not rely on termination callbacks.
- [ ] Add an installed simulator relaunch test with a deterministic fixture: type a draft, terminate/relaunch, read the recovered draft before network refresh, then simulate an uncertain send and relaunch without dispatching it again. Add a Forget/relaunch test confirming cached text is gone. Keep exact device/runtime, .xcresult and failure receipts.
- [ ] Update the phone storage/privacy contract to describe only the implemented native persistence milestone and remaining LAN-only/attachment/push limitations. State offline deletion/revocation limits honestly. Preserve the browser storage prohibition.
- [ ] Run the iOS native unit/UI checks and unsigned generic-device build; run the repository agent-doc path check and `git diff --check`. Sign a milestone commit. Obtain fresh whole-branch review and resolve findings before calling this milestone ready.

## Native verification commands

Use an owned simulator created for this work, with its UUID recorded in `.artifacts/mobile-first-release/progress.md`; do not boot, erase or delete another session's simulator. Generate the existing project with `xcodegen generate` in `apps/ios/ChatCompanion`. Test with an isolated derived-data path and ad-hoc simulator signing (`CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES DEVELOPMENT_TEAM=LOCALTEST0`).

Baseline/targeted command from the app directory: `xcodebuild -project ChatCompanion.xcodeproj -scheme ChatCompanion -destination 'platform=iOS Simulator,id=<owned UUID>' -derivedDataPath <owned artifacts>/DerivedData -parallel-testing-enabled NO CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES DEVELOPMENT_TEAM=LOCALTEST0 -only-testing:ChatCompanionTests test`. Append `/PersistenceTests` or `/ModelPersistenceTests` to target a test class. A green exit must include an .xcresult and actual executed test counts; the pinned-HTTPS fixture test may skip when deliberately running without the HTTPS fixture and must be recorded as such.

Full companion verification from repo root: `CHAT_IOS_UI_FLOW=1 CHAT_IOS_DERIVED_DATA=<owned artifacts>/FullDerivedData bash apps/ios/ChatCompanion/Scripts/test-e2e.sh`. The script starts the actual Rust HTTPS fixture, creates and owns its own simulator, runs all native tests and the UI flow, then builds an unsigned generic iOS device target. It requires Rust 1.95.0 and XcodeGen. Preserve infrastructure/signing/local-network failures; do not weaken certificate validation or replace real Keychain storage to make it pass.

## Task 4: Shared authenticated remote transport and enrollment

**Files/ownership:** Chat adapter in `src-tauri/src/companion/remote/`, Swift adapter in `apps/ios/ChatCompanion/Sources/RemoteCompanionClient.swift`, and a new shared transport library owned by `OpenCoven/coven`. Work in an independently allocated Coven task worktree after checking current claims and repository allocation limits. Current transport source is inside the binary crate `crates/coven-cli/src/mobile_memory/transport/`; it is not an existing public library dependency.

**Required application interface:** `CompanionClient` remains the Swift request boundary. The shared channel exports open/cancel/exchange/status operations to Swift with opaque handles and bounded owned buffers; its exact ABI is fixed in the extraction checkpoint, alongside the reviewed source revision and XCFramework build targets. The host dispatcher accepts only the companion snapshot/history/send/run/stop/permission routes and explicit v2 enrollment/revoke operations. The broker never receives a plaintext HTTP bearer or model request.

- [ ] Check the actual transport module dependency closure, current-pairing/grant authority calls, device persistence and supported iOS Rust targets. Produce a source-backed extraction plan with exact exported signatures, dependencies, build reproducibility and operation allowlist before editing that library. Preserve the existing Noise/P-256 protocol, possession proofs, durable counters and admission checks. If a separate Chat application profile requires changing accepted authority rules, stop that part and report the specific incompatibility for design revision while continuing independent Tasks 1–3 and 5–6.
- [ ] In the owning repository, write failing tests for one real Rust-host/Swift-client authenticated loopback exchange plus wrong host pin, wrong device/grant, revoked grant, stale generation and malformed record refusal. Extract/reuse the implementation without protocol forks, then pass those tests and existing transport vectors. An in-memory Rust-only fixture does not satisfy Swift integration.
- [ ] Implement the explicit Mac-confirmed v2 enrollment and per-device Chat capability, retaining the pinned local ceremony. First v2 enrollment rotates the legacy token; v2 LAN and relay use per-device authentication. Test legacy token refusal after rotation, old v1 re-pairing, independent v2 revoke, and no conversion of a memory-only grant into Chat execution authority.
- [ ] Implement LAN/relay candidate authentication and commit with immutable application bytes and request UUIDs. Test lost reply, handoff under traffic, old-channel late failure, duplicate request with changed payload, bounded transfer cancellation and a hostile broker unable to read/forge content. Reuse the existing authoritative companion runtime and receipt path, never an arbitrary CLI route.
- [ ] Bind admitting device ID to a run and test revoke during idle, in-flight response and execution: new operations fail, the matching run invokes shared Stop, and desktop/other-phone runs remain intact. Registering, Forget and reinstall must purge the correct remote/push identity.
- [ ] Run all required owning-repository policy/security/native checks. Protected delivery of the shared library and its version pin precedes Chat's production dependency update. Qualify a real remote endpoint on a physical phone in Task 7; controlled broker tests alone remain engineering evidence.

## Task 5: Real text/photo input and share-to-compose

**Files/ownership:** `src-tauri/src/chat_attachments.rs`, `src-tauri/src/companion/{backend,runtime}.rs`, new `apps/ios/ChatCompanion/Sources/CompanionAttachments.swift`, composer views and protocol types. Engine work belongs to `OpenCoven/coven-code`; its current `crates/cli/src/stream_mode.rs` reduces content blocks to text, so TUI image support is not sufficient.

**Required interfaces:** Versioned host capabilities describe supported attachment kinds, limits and selected harness/engine version. Uploaded attachment descriptors carry upload ID, safe display name, validated MIME type, byte count and SHA-256 digest. Immutable send payload identity includes every attachment descriptor/digest and the expected session. A completed upload does not execute until an explicit send is admitted.

- [ ] Add regression tests proving the current headless engine loses image blocks, then implement preservation of real image content through the headless query and provider path in an owned engine issue/worktree. Bound input and validate MIME/content; keep text-only/legacy behavior. Release the qualified engine through its repository's protected process before pinning it in Coven/Chat. Record a real provider image-marker response with the exact installed engine; mock serialization tests alone do not establish model vision.
- [ ] Wire text attachments through existing validation first, then add real PhotosPicker/camera input and host capability negotiation. Test four-file/count, 64 KiB text, 5 MiB image, 16 MiB message, 2048-pixel edge, malformed/oversized image and EXIF-location removal cases. Refuse unsupported PDFs and unsupported harnesses before submission.
- [ ] Add resumable bounded staging with authenticated sequence/length/digest checks and 24-hour/32-MiB cleanup. Test interrupted upload, duplicate chunk, changed digest, revoked device and no execution of partial data. Extend host request deduplication to reject UUID reuse with altered attachment content.
- [ ] Add the App Group share extension and signed entitlements, with an explicit Continue in Coven preview/handoff. Test text/link/file/photo ingestion, unsupported type refusal, size/expiry bounds, destination changes, reinstall cleanup and explicit Send. Do not introduce hidden background sends.
- [ ] Add focused native/Rust tests and execute required full host/iOS lanes. Keep production photo controls unavailable until the selected installed engine's real path is qualified; do not count text-file completion as the full media milestone.

## Task 6: Completion provider service and native notification registration

**Files/ownership:** Coven-owned provider service in `services/mobile-notifications/` under its own implementation issue/plan; Chat terminal-event adapter under `src-tauri/src/companion/notifications/`; Swift notification and deep-link adapter in `apps/ios/ChatCompanion/Sources/CompanionNotifications.swift`. Confirm service repository placement with its contribution/ownership policy before scaffolding.

**Required interfaces:** Installation bootstrap exchanges a one-time expiring code plus fresh signed service challenge for a revocable installation credential. Authenticated per-phone registration binds the device token, APNs environment/topic and Chat grant. `RunNotificationEvent` contains stable event ID, opaque installation/phone/run identifiers, generic terminal kind and expiry; no prompt, filename, path, transcript or secret. Provider and host deduplicate the same event ID across retries.

- [ ] Write service tests for bootstrap expiry/single use/wrong host proof, token-registration ownership, invalid topic/environment, narrow delivery scope, rate/size limits, token rotation, revoke races and provider retry/deduplication. Define the exact HTTP schema and credentials in the service plan before implementation; do not embed a global provider/bootstrap secret in clients.
- [ ] Implement server-held APNs key authentication, bounded 24-hour terminal delivery metadata and invalid-token removal. A service with only a fake APNs adapter is testable engineering work but not deployment/delivery acceptance.
- [ ] Persist terminal host events after authoritative completion and emit only generic permitted notifications. Test failed/stopped/completed distinction, duplicate terminal events, host restart, pending revoke, and that needs-you events require a real actionable state without restoring per-turn prompts.
- [ ] Implement context-sensitive notification permission, authenticated token registration, rotation/unregister and deep-link resynchronization. Test denied permission, stale/foreign link, another selected familiar, locked phone and offline host. Opening a notification never authorizes a new run or bypasses destination checks.
- [ ] Identify the service operator, owned relay/push endpoints and APNs provisioning through secure operator configuration. Keep provisioning pending if unavailable and continue independent engineering. Exercise actual sandbox/production APNs receipt on the correct candidate before release.

## Task 7: Protected release and real-device acceptance

**Files/ownership:** Existing iPhone workflow and `apps/ios/ChatCompanion/Scripts/testflight.sh`; existing desktop protected release path; candidate evidence under the owning issue's receipts. Workflow/signing changes require their own scoped review and repository gates.

- [ ] Verify the final dependency graph, signed source commits, exact desktop candidate, iOS bundle/version/build, relay/provider deployment revision and capability configuration. Run required Swift/Rust/frontend checks for every changed surface; add `ci:full` before calling a Rust-changing PR green and inspect skipped rows.
- [ ] Obtain fresh whole-branch review, resolve findings and use protected PR/main/release delivery. Do not move tags from a topic branch or take over another session's release worktree. A successful no-op TestFlight job does not count as upload.
- [ ] Upload the signed candidate and confirm Apple processing plus tester availability in TestFlight. Record the actual build and installation, separate from unsigned generic-device build evidence.
- [ ] On a physical phone, qualify Wi-Fi/cellular/back, non-home NAT, background/lock/relaunch, Mac sleep/wake, uncertain send recovery, media interruption, shared Stop/full access, push/deep link, Forget/reinstall, per-phone revoke, deletion/cache bounds, VoiceOver and larger text. Record actual versions, every failure and remaining human gates; preserve #465 until its specific observations pass.
- [ ] Publish only the capabilities that passed installed candidate acceptance. The first-release program stays incomplete if remote deployment, actual photo model input, push delivery, TestFlight availability or physical acceptance remains unverified.

## Follow-on program retained after the first release

Dedicated editable dictation, then interruptible live voice; mobile chat/familiar creation, authoritative search and result previews; Siri/Shortcuts/Action Button and Live Activities; canonical computer handoff and real routines; optional permissioned calendar/reminder actions. Each receives a scoped implementation plan against the approved design before product work. Provider credentials/cost choices for voice and phone OS permission grants remain explicit inputs; keyboard dictation, mock actions and static activity previews do not establish these capabilities.

## Plan self-review

- The approved design's native persistence, transport/pairing, media/sharing, notifications and release sections map respectively to Tasks 1–3, 4, 5, 6 and 7. Follow-on capabilities remain explicit above.
- Cross-task persistence signatures and revision/UUID semantics are defined in Tasks 1–2; later adapters preserve those identities rather than substituting a second send path.
- All five Review Focus conditions have named tests or acceptance cases in their owning tasks. Native tests are distinct from real provider, hosted CI, TestFlight and physical phone evidence.
- Source-confirmed compatibility work is a prerequisite to exact cross-repository ABI/schema plans; no nonexistent reusable library, image CLI feature, deployed endpoint or provider credential is assumed.

## Baseline checkpoint

On 2026-11-12, the unchanged companion native unit suite completed on the owned iPhone 16 Pro simulator `CA6ED7EF-7DBC-42F7-AC35-E40698E57AC4`, iOS 27.2, Xcode 27.2 (27B52): 44 passed, one pinned-HTTPS fixture case explicitly skipped because this baseline did not start that fixture, zero failures. `xcodebuild` exited successfully and produced `.artifacts/mobile-first-release/Baseline.xcresult`; the complete log is `.artifacts/mobile-first-release/baseline.log`. This is simulator baseline evidence, not new-feature, full-HTTPS-flow or physical-device acceptance. At that baseline checkpoint, product implementation had not begun while plan review and execution-method selection were pending.
