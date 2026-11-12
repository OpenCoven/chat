# Coven mobile experience upgrade

Status: approved by Val in this session on 2026-11-12, including the recommended Mac-hosted architecture and native persistence choices. Service operator/deployment/APNs provisioning remain release dependencies. This document is not a claim that the features below exist or that a mobile build has shipped.

Owner: this Codex session. Baseline: Chat `f7649d94f5b077acdd8ab95876532b49e472ef5f`, inspected 2026-11-12. Worktree: `/Users/buns/.codex/worktrees/9d79/chat`, created by the task's managed worktree tool. The primary checkout contains unrelated changes and a runtime merge conflict and remains untouched.

## Intent and scope

Make Coven on iPhone feel like a capable everyday assistant: open quickly, retain work, accept voice and media, stay reachable away from home, and bring the person back when work finishes. The reference to Grok describes the convenience and mobile interaction quality, not a request to copy its branding or personality. The user authorized proceeding with the recommendations; specific architecture and privacy choices below are proposals by this agent.

The first release includes secure off-LAN access, persistent drafts and bounded recent history, attachments including real photo input, and completion alerts. Later increments cover dedicated dictation and interruptible live voice, mobile conversation/familiar management and search, then Siri/Action Button, Live Activities, computer handoff, routines, and optional calendar/reminder actions. None of those later increments are silently removed from the roadmap.

## Current behavior and constraints

The SwiftUI companion targets iOS 18 and later. Its source marketing version is 0.3.0; that number alone says nothing about TestFlight availability. Desktop v0.1.1 did not upload an updated companion binary. Existing companions use the desktop's common runtime and receive the host's current full-access behavior when connected.

Today pairing is private IPv4 HTTPS with a pinned host certificate and one host-wide bearer token. Bonjour supplies candidates, never trust. The listener is opt-in and starts disabled. `Pairing.validEndpoint` rejects public endpoints and 100.64/10 tailnet addresses. Adding a public URL or suggesting a VPN is not an implementation of remote access.

`CompanionModel` retains drafts only in memory by familiar. The host retains canonical history. A send has a UUID and expected session; the durable host receipt must be reconciled after an uncertain response. The companion must never automatically replay a send or mint another UUID to resolve an uncertain result. The shared host runtime admits one run, and either device can Stop it.

The companion currently passes an empty attachments vector. The desktop's attachment adapter accepts four UTF-8 text/code files of at most 64 KiB each and only the Coven Code harness. Coven Code contains real image content blocks and provider image serialization, but this does not establish that the bundled headless CLI path accepts them. That path must be qualified or extended in the engine repository before mobile photos ship.

The Coven repository contains an opaque WebSocket rendezvous broker and authenticated endpoint transport with Noise/P-256 bindings, revocation checks, durable reconnect counters and migration tests. That transport serves Coven's mobile-memory gateway; Chat's bearer/certificate pairing is not interchangeable with its grants or request signatures. Reuse requires an explicit adapter and pairing upgrade. The broker provides no offline queue and no APNs notification service. Existing broker tests explicitly do not establish physical-network or independent security acceptance.

## Approaches

| Approach | User experience and tradeoff | Recommendation |
| --- | --- | --- |
| Mac-hosted execution with an end-to-end encrypted Coven relay | Existing familiars, files, history and Stop remain on the Mac; phone works over cellular while the Mac is awake and Chat is running. Requires relay integration and a small push service. | Approved first architecture. |
| Separate always-on Coven execution service | Works when the Mac is off; requires another runtime, credentials, workspace synchronization, hosting and explicit ownership of those costs and data. | Separate architecture decision and project; do not assume this service already exists. |
| Direct LAN/private VPN only | Least transport work, but VPN setup and current endpoint restrictions make it a poor default for the requested everyday mobile experience. | Keep LAN as a fast path, not the release's remote-access completion gate. |

No paid service or new cloud account is provisioned by this proposal. A deployment destination and operator-managed secrets must be identified before the remotely reachable release can be called complete. Code that runs only against a local test broker is intermediate work.

## First-release behavior

Opening the app shows the last selected familiar and cached recent conversation immediately after device unlock, with a clear last-updated/offline state. It refreshes against the Mac before enabling Send. A compact status states whether the Mac is reachable and whether work is active. When offline, the person can read retained content and compose a draft; Send stays unavailable and nothing is silently queued for execution.

The composer has text, attachment, and later microphone controls within thumb reach. Files and photos show removable preview cards and upload/error state. The person explicitly sends the composed message. A selected familiar that cannot consume an attachment explains the limitation before submission; it does not receive an image filename as a substitute for image content.

Work continues on the awake Mac when iOS suspends the app. A permitted generic completion notification opens the exact familiar/run and refreshes its authoritative state. Notifications cannot guarantee delivery or keep an iOS process running. A stopped run, failed run and completed run have distinct visible states. Reconnection does not start another run.

## Transport and pairing

Preserve the existing LAN v1 client for old desktop compatibility. Remote access is a separately enabled v2 capability and requires both updated applications. The new phone cannot convert the legacy host-wide bearer into an independently revocable remote identity without enrollment. The Mac shows an explicit remote enrollment ceremony; an existing LAN-paired phone can initiate it only over its pinned connection, and the Mac confirms the particular device. New enrollment uses the same pinned local ceremony rather than trusting a relay-provided key.

Reuse the Coven-owned authenticated mobile channel and its device registry/grant enforcement through a shared library boundary, rather than implementing a second cryptographic protocol in Swift or teaching the broker to decrypt traffic. The implementation plan must pin the reviewed Coven transport revision and expose its bounded connection/request interface to the desktop Rust host and Swift client through a shared Rust mobile library. Chat receives a separate application profile and operation allowlist; a memory-only grant never authorizes Chat execution. No new request router accepts arbitrary CLI arguments or remote shell commands.

The Chat host adapter terminates authenticated application requests and calls the existing companion backend and shared `send_local`/Stop paths. It checks the current per-device Chat grant on admission and before delivering protected responses. Existing canonical session, origin, ownership, lifecycle and tombstone checks remain authoritative. Full-access execution remains the current desktop product policy; it does not grant a phone arbitrary new OS permissions.

Each remotely enrolled phone gets an independent key and grant, notification registration and revocation identity. On the first v2 enrollment, rotate the old shared LAN token and explain that older phones must pair again; do not preserve an old token as a bypass around per-phone revocation. V2 phones use per-device authentication on both LAN and relay and do not receive the replacement legacy token. Old v1 phones may still pair locally using the rotated legacy identity; Forget Phones invalidates all legacy and remote access.

Per-phone revoke invalidates that v2 phone's LAN and relay access, push registration and active/idle channels. Store the admitting device ID with each run; revocation also invokes the shared Stop path for a run admitted by that phone, while leaving a desktop or another phone's run alone. Report cancellation failure honestly; revocation cannot undo actions already performed. The host denies new operations before canceling existing work. Rotated or missing trusted material requires visible re-pairing, never acceptance of keys from discovery. LAN/relay handoff preserves the same pairing and immutable request identity. A candidate channel is authenticated before replacing the current one; a late failure on the old channel cannot clear the newer connection.

Keep explicit bounded request and transfer sizes, cancellation and backpressure through the relay. Chunk media below transport frame/message limits, with sequence, length and digest validation inside the authenticated channel. Partial uploads expire without execution. Relays see routing metadata and timing, not plaintext prompts, files, tokens or transcript contents. Logs redact routing credentials, device tokens and content. Add hostile-broker and stale/revoked-device tests, not just a successful relay demo.

The existing CLI transport is substantial coupled code, so the first engineering checkpoint is a source-backed extraction/interface plan and a real Swift-to-Rust authenticated loopback exchange. If reuse would require changing the accepted protocol or its authority rules, stop that part and bring back the concrete incompatibility; do not silently invent a cryptographic replacement. Engine or CLI changes use their own isolated worktrees and repository contracts.

## Native persistence and send recovery

Persist native iOS drafts, attachment staging, unresolved-send metadata and a bounded recent transcript in Application Support with complete file protection and backup exclusion. This deliberately changes the current memory-only phone policy and requires updating `docs/iphone-companion.md` and `SECURITY.md`. Browser conversation and draft storage remains prohibited. Credentials and device private keys stay in device-only Keychain storage, not in the transcript store.

Agent proposal: protected native persistence is enabled by default for this experience, with Clear Downloaded History and a “Keep conversation text only while open” option in mobile privacy settings. Retain recent history for seven days, up to 20 MiB total, and staged attachments for up to 24 hours within a 32 MiB staging budget. These are implementation defaults to approve, not prior user decisions. At limits, evict oldest cached history; never evict an unresolved operation to enable another send. Storage failures keep the unsent draft visible and refuse submission when durable recovery cannot be established.

The text-only-while-open option removes persistent conversation bodies, draft text and staged attachments, including existing cached copies when enabled. It still keeps device credentials and minimal unresolved-operation metadata: request UUID, payload digest, peer/familiar/session identifiers and submission state, with no prompt or attachment bytes. This exception is stated beside the setting because it prevents duplicate execution after relaunch. In this mode, a killed process cannot recover unsent text or files; after uncertain dispatch it can reconcile the original UUID but cannot reconstruct or resend its body. Switching modes never discards an unresolved UUID.

Partition every record by installation ID, trusted host identity, remote device identity where applicable, familiar and exact canonical session. Before a first session exists, use an explicit unbound draft slot; moving it to a new canonical head requires matching the captured lineage, otherwise show a recovered draft for the person to place. Do not silently deliver a draft to a replacement familiar or session. Persist atomically on edits with a short debounce and flush on scene transition; do not depend on an app-termination callback. Synchronize model updates and store writes so stale completions cannot overwrite newer edits.

Before network dispatch, atomically persist the request UUID, exact payload digest, host/familiar/session identity and submitted-draft revision. After relaunch, query the host receipt for that same UUID and reconcile canonical history. An absent receipt after an uncertain send is not permission to retry automatically; retain the text for review and explain the uncertainty. Clear only the submitted revision after confirmed admission; edits made while a run is active remain intact. The host idempotency comparison includes attachments and session identity, and rejects UUID reuse with a different payload.

Forget Mac, detected reinstall, or confirmed revocation purges that peer's local history, drafts, attachment staging and operation metadata as well as keys and notification registration. Host deletion/tombstones purge corresponding downloaded history when observed. Offline caches cannot learn about deletion or revocation until reconnection; the seven-day bound and explicit Clear controls must be documented without implying instant remote erasure.

## Media and sharing

Phase the implementation, not the acceptance promise: wire existing validated text files first, then deliver PhotosPicker and camera JPEG/PNG input over the real model image path in the same first-release program. Proposed phone limits are four total attachments, at most 5 MiB per encoded image, 16 MiB per message, and a 2048-pixel maximum image edge. Decode to verify format and dimensions, re-encode to remove location metadata, and validate host-side before staging. Text files retain their current tighter limits. PDFs and unsupported binary types show an explicit unsupported message in this release.

Qualify `--stream-json-input`/the actual installed CLI normalization path using a real image marker and observed model response. If the bundled engine lacks the required image path, implement and release that capability in Coven Code, then update the Chat pin through its normal process. Do not claim TUI image support establishes headless/mobile support. Advertise capabilities by selected familiar, harness and installed engine version. Codex/Claude Code media stays unavailable until its own real path is implemented and qualified.

Share to Coven receives text, links, supported files and images into an App Group inbox with device-protected files and a strict size/expiry budget. The extension offers a destination preview and an explicit Continue in Coven handoff; the main app verifies pairing, canonical destination and capabilities before the person taps Send. This first version is a share-to-compose workflow, not an invisible background send. A later direct-send extension must use the same durable request/receipt protocol and separately qualify its execution lifetime. Extension signing, App Group entitlements and reinstall cleanup are release requirements.

## Completion notifications

Add opt-in iOS notification permission requested in context after the first run, per-phone push registration bound to the authenticated pairing, and terminal run events keyed by stable host/run/event identity. The host records completion before requesting delivery; at-least-once provider retries use the same event ID, bounded expiry and deduplication. Revoke, Forget and token rotation invalidate old registrations. Register/unregister races cannot attach a token to another peer.

A Coven-operated push service holds the APNs provider key in server secret storage. Neither desktop nor phone ships that key, and an App Store Connect upload key is not treated as an APNs credential. For this first rollout, use operator-provisioned registration: the service operator issues a one-time expiring bootstrap code bound to the desktop installation public-key fingerprint, entered in the desktop's remote-access setup. The desktop proves possession against a fresh service challenge and redeems the code once for a revocable installation credential. The operator can provision the release testers without creating a new public account system; arbitrary anonymous service enrollment is not supported. The credential can register only phones with a host-verified Chat grant and send their allowed generic events; it cannot choose arbitrary push tokens or APNs topics. A general public release needs a separately approved onboarding/account policy before expanding enrollment.

The service rate limits registration and delivery, and sends a notification such as “Your familiar finished.” The payload carries an opaque deep-link identifier, no transcript, prompt, file name, path or secret. Lock-screen previews reveal no content by default. The installation credential stays in host-private storage; service credential rotation suspends delivery until re-provisioning without weakening the phone's Chat grant or interrupting LAN execution.

The service stores only registrations, bounded delivery metadata and opaque event identifiers. Proposed retention is until revoke/token expiry for registrations and 24 hours for terminal delivery attempts. Invalid APNs tokens are removed; revoked registrations reject further sends. Completion status comes from the host, never from notification delivery. A needs-you alert is generated only by a real actionable state; this work must not reintroduce per-turn approval prompts into the full-access default.

Deployment requires an owned relay endpoint, an owned push endpoint, APNs key ID/team/topic and provider key, correct development/production entitlements, retention configuration and an operator rollback path. No currently deployed endpoint or configured APNs provider was established by this audit. The user must identify the service operator and approve the deployment destination before infrastructure provisioning; secrets should be configured through the service's secret store, never pasted into chat. Local implementation can proceed after design approval while that dependency is open, but provisioning and actual phone delivery remain explicit release gates, not stubbed successes.

## Later increments retained in scope

| Increment | Concrete behavior | Completion gate |
| --- | --- | --- |
| Dedicated dictation | App-level microphone control, editable live/final transcription, cancel, permission-denied recovery, explicit Send. | Physical phone microphone/route/privacy acceptance and no submission on cancel. |
| Interruptible live voice | Full-duplex conversation, visible listening/speaking state, interruption, mute, route changes, reconnection and Stop tied to the host run. | Real speech transport/provider qualification, interruption latency and background/interruption checks; provider and any cost selected explicitly before service use. |
| Mobile workflow management | Create chats and familiars, search authoritative history, open archived read-only results, preview supported outputs. | Existing host lifecycle and ownership checks, exact destination assertions, deletion/search synchronization and real phone accessibility. |
| Siri, Shortcuts and Action Button | Authenticated quick entry into dictation/new draft or a chosen familiar; no silent arbitrary execution from a locked phone. | App Intents signing and locked/unlocked device checks. |
| Live Activities | Concise run state and open/Stop action where the OS permits it; authoritative state still on the host. | Actual device activity lifecycle, stale-state expiry, revoke/finish and lock-screen privacy. |
| Computer handoff and routines | Resume the same canonical task on desktop; inspect and edit real scheduled jobs with visible host reachability. | End-to-end ownership, cancellation, schedule identity and no duplicate execution across devices. |
| Calendar/reminder actions | Optional device-native actions with scoped iOS permissions, clear previews and denied/revoked-permission recovery. | Physical device permission/action qualification; desktop full access never substitutes for iOS consent. |

## Delivery sequence and acceptance

1. Architecture and explicit native persistence/privacy choices approved on 2026-11-12. Record the accepted design and create bounded implementation issues, preserving existing #465 ownership and human gates.
2. Establish the shared authenticated transport interface and pairing migration, then LAN/relay handoff using real host requests and durable send receipts. A controlled broker is engineering evidence only.
3. Implement native persistence and recovery, text/media transport, composer and share extension. Update product/privacy documentation with the behavior that actually ships.
4. Implement and deploy the real push registration/provider path with operator-owned credentials, rate limits and revocation. Exercise actual APNs delivery to the release candidate.
5. Run focused Swift and Rust regression tests plus required repository checks. Host Rust changes require full hosted lanes through `ci:full` when a PR is published. Run the companion simulator/unit/UI workflow; preserve the known flaky UI row's first failure rather than hiding it.
6. Produce a signed candidate through protected main/release paths, upload it to TestFlight and confirm Apple processing and tester availability. An archive, exported IPA or successful no-op upload job is insufficient.
7. On a physical iPhone and the exact desktop candidate, qualify Wi-Fi to cellular and back, a non-home network, background/lock/relaunch, Mac sleep/wake, lost send response, attachment interruption, Stop, full-access execution, push/deep link, forget/reinstall, revoke, delete, cache limits, VoiceOver and larger text. Record versions and failures. Retain #465's unresolved physical acceptance separately until observed.
8. Only call the first mobile release complete after the available TestFlight build and physical acceptance pass. Then take the later increments in the table in order, with each capability actually working before announcing it.

The builder may select internal module boundaries, transfer chunk sizes within the stated bounds, UI spacing and test fixtures. They may not substitute a local-only draft feature for the release, fake photos through text/OCR, weaken certificate/grant validation, replay uncertain sends, place provider keys in clients, bypass protected release rules, or represent simulator/local evidence as installed phone acceptance.

## Source pointers and platform references

- Current companion contract: `docs/iphone-companion.md`; phone model and networking: `apps/ios/ChatCompanion/Sources/{CompanionModel,Pairing,PinnedAPI,PairingStore,Protocol}.swift`.
- Host execution and receipt guards: `src-tauri/src/companion/{runtime,backend,credentials}.rs`; attachment staging: `src-tauri/src/chat_attachments.rs`; lifecycle: `src-tauri/src/chat_{canonical,lifecycle,origin}.rs`.
- Coven transport: sibling repository `crates/coven-cli/src/mobile_memory/transport/README.md`; broker: `crates/coven-relay/README.md`. Re-read their current versions in the actual Coven worktree before extraction.
- [Apple: APNs provider token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).
- [Apple: choosing background strategies](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app).
- [Apple: native file protection](https://developer.apple.com/documentation/foundation/fileprotectiontype).
