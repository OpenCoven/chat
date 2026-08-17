# OpenCoven Chat for iOS Design

**Status:** Approved design
**Date:** 2026-08-16
**Repositories:** `OpenCoven/chat-ios` (new), `OpenCoven/sdk`, `OpenCoven/coven-cave`, `OpenCoven/coven-pocket`, `OpenCoven/chat-relay` (new)
**Amends:** `2026-08-10-opencoven-chat-design.md`

## Summary

OpenCoven Chat for iOS is a native iOS and iPadOS client for talking with
OpenCoven familiars. It is a companion to the desktop Chat client, not a
replacement: same product, same canonical Cave history, same familiars, same
Familiar Contract.

Cave remains the sole authority for every canonical read and write. The phone is
a presentation surface over a connection layer, exactly as the desktop client
is.

Two facts about a phone drive every decision that follows. First, Cave is not
co-resident — it runs on a Mac or an always-on box somewhere else, behind a
loopback binding the phone cannot cross. Second, Cave is frequently
*unreachable*, because the machine hosting it may be asleep. The desktop design
could treat unreachability as an exception. iOS must treat it as ordinary.

## Goals

- Deliver a native iOS/iPadOS client for the canonical Cave conversation store.
- Reach Cave without weakening Cave's loopback-only network posture.
- Make an overlay-network connection feel automatic after one guided setup.
- Remain useful when Cave is unreachable, without inventing false success.
- Render every v1 rich message type safely on a small screen.
- Preserve the Familiar Contract on every conversation and turn.
- Write the security-critical protocol logic once, in a form desktop can adopt
  later.

## Non-Goals

Inherited from the desktop spec: voice calling or dictation, group chat, canvas
or artifact workspaces, embedded terminals, code inspectors, Cave's board,
Gantt, calendar, marketplace, or administration surfaces, a second conversation
database, and direct harness, shell, filesystem, GitHub, or task-system
authority.

New to iOS:

- no LAN binding and no mDNS/Bonjour discovery
- no watchOS, widget, App Intents, or Live Activity surface
- no iOS-side Cave hosting
- no rendering of message content in a web view
- no OpenCoven-hosted Cave

## Amendment to the Approved Desktop Spec

The desktop design lists "an offline write queue" as a v1 non-goal. Its stated
reasoning was avoiding duplicate turns and misleading success states.

**iOS v1 revises this non-goal for the iOS surface only.** A co-resident desktop
client can treat "Cave is down" as an exception worth refusing to work around. A
phone cannot: the user is away from the Cave host by definition, which is the
entire reason the phone client exists. A read-only phone client is a museum.

The original reasoning is preserved rather than discarded. The Outbox section
below constrains the queue so that neither failure mode it warned about can
occur: nothing is ever rendered as delivered before Cave confirms it, and an
ambiguous outcome on an already-submitted operation still never triggers an
automatic resubmission.

This amendment does not apply to the desktop client, which remains read-only
when disconnected.

## Relationship to Coven Pocket

`OpenCoven/coven-pocket` is an existing OpenCoven iOS application on the same
stack this design selected: SwiftUI over Rust via UniFFI, with an XCFramework
pipeline and CI already in place. Its M2 "Companion mode" milestone is complete
and includes a user-managed overlay transport to a loopback-bound daemon
listener, a versioned pairing handshake, remote attach with live events and
approvals, and bounds-checked familiar roster handling.

Chat iOS does not rebuild any of that, and does not live inside Pocket either.

### What Is Shared

One thing: the **reachability and HTTP transport primitive**. Pocket's
`daemon.rs` resolves, connects, and performs a single short-lived HTTP exchange
under one timeout budget spanning all three phases, classifying failure
precisely — refused, timed out, unresolvable, or failed — rather than
collapsing everything into "error". It caps response bodies at 64 KiB against a
hostile endpoint and extracts JSON tolerantly without slice-panicking on
malformed framing. It carries sixteen tests covering exactly those hazards.

That becomes `coven-transport` in the SDK, and Pocket migrates to consume it.
Pocket's existing test suite passing unchanged is the proof that the extraction
is faithful rather than a fork.

### What Is Not Shared

The two apps target different authorities. Pocket speaks `coven.daemon.v1` to
the Coven daemon. Chat speaks `/api/client/v1` to Cave. Cave's canonical
conversation model, rich message semantics, outbox, and doorbell push are new
work regardless.

**Pairing is also not shared, because Pocket has none.** Pocket sends no
`Authorization` header and holds no credential; its security rests entirely on
the user-managed tunnel, and its roadmap still lists an authenticated remote
listener as upstream design. Cave's pairing — single-use grant, scoped
revocable bearer, Keychain storage, TLS pinning — is built fresh in Phase C
against Cave's authority. No `coven-pairing` crate is created speculatively.

The version-handshake *shape* in `daemon.rs` — classify a health response as
compatible, version-mismatched, or not-our-service — is a useful precedent for
Cave's own compatibility negotiation, but the payloads differ enough that it is
reimplemented rather than abstracted.

### The Licensing Constraint

Coven Pocket is GPL-3.0-only because it links `claurst-*` crates from
coven-code, a GPL-3.0 derivative of upstream Claurst. OpenCoven does not hold
full copyright on that upstream code and cannot unilaterally relicense it.
Pocket's own licensing decision record blocks App Store distribution pending a
GPLv3 §7 additional permission from every copyright holder.

This design targets App Store distribution. Therefore:

**`chat-ios` must link no GPL-licensed code.** It must never depend on
`claurst-*`, on `coven-pocket-ffi`, or on any crate that does. This is a
release-blocking constraint, not a preference, and CI must enforce it rather
than rely on review.

The extraction is clean because the modules being moved import no `claurst`
code and are solely authored by OpenCoven, so OpenCoven may license them under
the SDK's terms. The implementation plan verifies both properties before moving
any file, and records the origin and relicensing grant in a `NOTICE`.

## Product Decisions

| Area | Decision |
| --- | --- |
| Product | Native iOS/iPadOS companion to OpenCoven Chat |
| Runtime | SwiftUI over a shared Rust core via UniFFI |
| Authority | Cave owns canonical history and execution |
| Transport | User-owned overlay network; Cave stays loopback-bound |
| Enrollment | Cave-owned setup wizard, QR handoff, self-healing candidates |
| Offline behavior | Read cached history; durable outbox for sends |
| Notifications | Content-free doorbell relay |
| Action scope | Full parity with desktop v1 |
| Core ownership | `cave-core` serves iOS now; desktop migrates only after proof |
| Shared code | HTTP transport primitive extracted from Coven Pocket; pairing built fresh |
| Licensing | `chat-ios` links no GPL code; extracted crates match SDK terms |

## Transport

### Why an Overlay

Cave binds to loopback and owns every privileged mutation. Three ways exist to
get a phone across that boundary, and the choice was made deliberately:

- **Same-LAN direct** would require Cave to bind a real network interface and
  advertise itself over mDNS. This puts a privileged API on a network any guest
  can join, contradicts the approved security posture, and still fails the
  moment the user leaves home. Rejected.
- **An OpenCoven relay carrying traffic** would be genuinely zero-config, but
  makes OpenCoven operate, secure, and fund production infrastructure that sits
  in the path of every message. Rejected for v1.
- **A user-owned overlay** — WireGuard/Tailscale, or Cloudflare Tunnel — leaves
  Cave completely unchanged and loopback-bound, adds no new network surface, and
  works from anywhere. **Selected.**

Cave's binding, authentication, and authorization behavior are unchanged by this
document. The overlay is the user's, not OpenCoven's.

### Making It Feel Automatic

An overlay's entire cost is first-run friction, so Cave owns the setup rather
than delegating it to documentation:

1. **Probe.** Cave detects whether a supported overlay is installed, running,
   and logged in, or absent.
2. **Guide.** If setup is incomplete, Cave links the installer, waits, and
   states plainly what is still missing.
3. **Verify.** Cave confirms its own address actually resolves and answers
   *before* offering a QR. A user is never handed a code that cannot work.
4. **Hand off.** The QR encodes ordered candidate URLs, the Cave instance ID, a
   certificate fingerprint to pin, and a single-use pairing grant.

Because reachability is verified before enrollment, a later connection failure
is a meaningful diagnostic rather than an unexplained timeout.

### Candidate Racing

The core races the candidate URLs on first connect and remembers which answered,
keyed by network identity. A known network reconnects without probing; a network
change triggers a silent re-race. After enrollment the user never selects,
types, or thinks about an address again.

## Architecture

### `cave-core`

A Rust crate at `crates/cave-core` in the SDK repository. Phase 7's `cave-563z7`
already anticipates publishing Rust crates from this repository.

It builds on **`coven-transport`**, extracted from Coven Pocket: the
short-lived-connection HTTP strategy suited to a phone that goes quiet in the
background, one timeout budget spanning resolve/connect/exchange, precise
failure classification, response-size capping, and tolerant JSON extraction.

`coven-transport` is authority-agnostic and FFI-agnostic. It contains no UniFFI
derives, so the shared crate stays consumable by non-UniFFI callers — including
the desktop Tauri host if the proof gate ever passes. Each application's FFI
layer defines its own UniFFI types and converts.

Phase B extends `coven-transport` additively with TLS and certificate pinning,
which Pocket does not need (its tunnel provides the encryption) but Cave
requires. Phase B also adds the endpoint candidate model and per-network
selection memory.

`cave-core` itself owns everything that is Cave protocol rather than
presentation:

- contract types validated against the exported v1 fixture
- authenticated HTTP and SSE transport over `coven-transport`
- typed stream reduction: monotonic event IDs, duplicate events as no-ops,
  cursor checkpointing
- resume, replay-gap detection, and fallback to canonical reload
- revision and ETag ordering
- the durable outbox and its state machine
- strict marker parsing into a safe AST
- the stable error envelope mapped to typed domain errors

It owns no UI and no storage. Secret storage, blob storage, persistence, and the
clock are traits the host injects.

**Platform-neutrality is a hard requirement, not a preference.** `cave-core`
carries no UniFFI derives and no platform types; the app's own FFI crate owns
the UniFFI surface and exposes scalars, records, enums, and callback interfaces
only, with no Foundation or UIKit types anywhere. `cave-core` must compile
clean for macOS, Linux, and Windows from the first commit. A core that only works under SwiftUI
would silently decide the desktop migration question in advance. Holding this
line at phase 0 is cheap; retrofitting it is not.

### Chat iOS

The `OpenCoven/chat-ios` repository. A separate repository because the `chat`
repository root is a pnpm/Tauri project, and an Xcode workspace grafted onto it
fights both toolchains and both CI configurations. It is also separate from
`coven-pocket`, which is a different product with a different authority, a
different release cadence, and a GPL license that would block App Store
distribution.

It reuses Pocket's XCFramework and UniFFI bindgen pipeline as a **pattern**,
copied and adapted, not as a dependency.

It owns:

- SwiftUI views, navigation, and scene restoration
- rendering `cave-core`'s AST into native views
- the Keychain adapter implementing `SecretStore`
- the persistence adapter
- camera, photo library, files, and share-sheet ingestion
- APNs registration, notification handling, and background refresh

### Cave Additions

- the overlay setup wizard with reachability self-verification
- QR enrollment payload generation, extending the existing pairing flow
- a push device-registration endpoint
- doorbell emission on run completion, run failure, and attention prompts
- paired-clients settings listing phones alongside desktops

### The Doorbell Relay

The `OpenCoven/chat-relay` repository.

Apple accepts pushes only from a provider holding an auth key tied to
OpenCoven's team ID. That key cannot be distributed to self-hosters without
letting anyone push to any installation, so some OpenCoven-operated component is
unavoidable if the app is to notify at all. It is scoped to the smallest thing
that can work.

The phone registers its APNs token directly with the relay and receives an
opaque `topic_id` and `push_secret`, which it hands to Cave during pairing. Cave
later posts a signed, empty ping to `topic_id`. The relay maps it to a device
token and fires a content-free push. The phone wakes and fetches real content
from Cave directly over the overlay.

The relay never learns which Cave instance called it, never sees a transcript,
familiar name, or preview, and holds nothing but a token map. The worst outcome
of a full relay compromise is an attacker learning that a phone buzzed. Pings
are rate-limited per topic.

## Connection Lifecycle

### States

Each state has a distinct user-facing consequence:

- unpaired
- overlay unavailable
- locating
- unreachable
- connected
- authentication expired or revoked
- incompatible API

Authentication failure clears the unusable credential and returns to enrollment.
Every other failure retains it. Reconnection uses bounded exponential backoff
with jitter.

**`overlay unavailable` and `unreachable` must never be collapsed into one
state.** "Your overlay isn't running" and "your Cave host is asleep" are
completely different instructions to a user standing in a coffee shop, and a
generic "can't connect" serves neither.

### Reads

The app renders from cache immediately and revalidates. A stale response can
never overwrite a newer known revision; that ordering rule lives in the core,
not in individual views.

### Streaming

Backgrounding an iOS app kills its SSE connection. This is normal, not an error.

The core checkpoints the last accepted event ID. The doorbell wakes the app; on
foreground it resumes from the cursor. On a replay gap it reloads canonical
state and reconciles rather than guessing what completed. Duplicate event IDs
are no-ops.

### The Outbox

The outbox is the amended non-goal, so its rules are strict and each one exists
to neutralize a specific failure the original non-goal warned about.

- A message queued while unreachable receives a client operation ID at queue
  time, reused as the idempotency key on every submission attempt, so Cave
  deduplicates.
- Queued messages persist across app termination.
- Queued messages are ordered per conversation and submitted in order. A
  permanent failure **holds** the queue rather than reordering around it.
- The outbox is bounded in count, with the exact limit and the
  over-limit behavior fixed in the implementation plan. Reaching the limit
  disables further queuing with a stated reason; it never silently drops the
  oldest entry.
- Pending is never rendered as delivered. Pending state is visually distinct and
  states why it is pending.
- An **ambiguous** outcome on an already-submitted operation never triggers an
  automatic resubmission. It reconciles by reloading canonical state and
  checking whether that operation ID landed. This rule is inherited from the
  desktop spec and survives the amendment intact.
- A message queued against a conversation that has since advanced requires
  explicit user confirmation before submission, because the context it was
  written for no longer exists.

## Rich Content and Actions

`cave-core` emits a safe AST; Swift renders it with native views.

**Message content never touches a `WKWebView`.** Rendering Markdown in a web
view would reintroduce precisely the script-execution surface the desktop spec
forbids. Unknown or malformed markers render as safe text or a non-interactive
unsupported card, never as executable UI.

Citations and source previews display the domain without auto-loading remote
content, and open in `SFSafariViewController` on an explicit tap. A transcript
must not silently contact a third party.

iOS v1 has full action parity with desktop v1: send, stop, retry, attention
responses, attachments, GitHub actions, task handoffs, and conversation
management. Proposed and completed actions render distinctly. Only a successful
Cave response transitions an action to completed. Every action requires an
explicit user gesture and carries an idempotency key.

Attachments enforce an allowlist by verified content rather than file extension,
transcode HEIC, strip location metadata by default, and stream from disk instead
of holding base64 in memory. Cave re-validates authoritatively regardless of
what the client checked.

## Security

- The bearer token lives in the Keychain as
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, excluded from iCloud sync
  and from backups, so a restored backup cannot resurrect a credential onto a
  different device.
- TLS is pinned to the fingerprint delivered by the QR, which also covers
  overlays terminating with a private CA.
- Scopes remain least-privilege and revocable from Cave's paired-clients
  surface.
- Pairing grants are single-use and short-lived.
- Optional Face ID gate on launch.
- Credentials, attachment bodies, and prompt content are redacted from logs and
  diagnostics.
- Relay pings are signed, content-free, and rate-limited.
- No message content is rendered in a web view and no script executes.
- Rich action markers are data requiring a user gesture and server
  authorization.

## Error Handling

Errors are explicit and state-specific: pairing denied or expired, credential
revoked, overlay unavailable, Cave unreachable, incompatible API, familiar
unavailable, project access denied, invalid attachment, send rejected, stream
interrupted and resumed, stream reconciliation required, action rejected or
failed, push registration failed, and background refresh denied.

No success-shaped fallbacks. Unknown server errors remain errors and carry a
copyable diagnostic identifier that exposes no secrets.

## Testing

### `cave-core`

- property tests on the reducer covering ordering, duplicates, and replay gaps
- fuzzing the marker parser against the hostile-content corpus
- conformance against the exported v1 fixtures

### Conformance, Then Differential Testing

These are two controls that arrive at different times, and conflating them
produces a plan that cannot be executed.

**Conformance comes first.** `cave-core` validates against the exported v1
contract fixture from `cave-g6x6k` as soon as it exists. This needs no second
implementation and is the gate for `cave-core` itself.

**Differential testing begins when a second implementation exists.** The
TypeScript reducer, cursor logic, and marker parser live in the desktop Chat
client, built in desktop phases 2 through 4, which have not started. The
published TypeScript SDK deliberately ships no reducer, so it is not a
differential counterpart either.

Until desktop's reducer lands there is exactly one implementation and nothing
to drift from. Once it lands, the same exported corpus runs through both,
asserting identical reduced state and identical AST — and that harness is the
control that keeps deferring the desktop migration safe rather than merely
postponed.

Ordering consequence: the differential harness is **not** Phase B work. It is
built when desktop Chat's reducer first exists, and its absence before then is
a fact about sequencing rather than a gap.

### Swift

- snapshot tests for every renderer, including malformed and unknown markers
- VoiceOver, Dynamic Type, dark mode, and reduced motion
- outbox state machine behavior across termination

### Integration

Against a live Cave instance: pair, read, send, stream, background and
foreground resume, outbox submit, and revoke.

### Device Matrix

Airplane mode, Wi-Fi-to-cellular switching, force-quit with a pending outbox,
and low storage.

### Push

One test asserts the delivered payload contains no content.

## Program Relationship

Four components exist that the current eight-phase desktop program does not
cover: the extracted `coven-transport` crate, the `cave-core` crate, the
`chat-ios` repository, and the doorbell relay. Cave gains
the setup wizard, QR enrollment, and device registration. Coven Pocket is
modified once, in Phase A, to consume the extracted crates.

### The Proof Gate

Desktop Chat does **not** re-plan onto `cave-core` yet. Phases 2 through 4
proceed in TypeScript exactly as written. Migration is reconsidered only when
every one of these holds:

1. `cave-core` passes the same exported conformance fixtures the TypeScript
   client passes.
2. Its hostile-content corpus and fuzzing pass with no parser findings.
3. The UniFFI build is green in CI on macOS and Linux.
4. iOS has run in real use through at least one full release cycle with no
   correctness defect attributable to the core.

Until all four hold, differential testing is what keeps the two implementations
honest.

## Delivery Sequence

This design spans four new components plus a change to Coven Pocket, and is far
too large for a single
implementation plan. It decomposes into phases that are additive and
independently testable, mirroring how the desktop program is structured. Each
phase gets its own plan document. Cave's existing behavior, the desktop client,
and Coven Pocket all continue working throughout.

### Phase A: Extraction

Verify provenance and engine-independence of the Pocket code being moved.
Create `coven-transport` in the SDK under the SDK's license, with a `NOTICE`
recording origin and relicensing grant. Migrate Coven Pocket to consume it,
keeping Pocket's daemon-specific health parsing and UniFFI types in Pocket.
**Pocket's existing test suite passing unchanged is the phase gate** — it is
what distinguishes an extraction from a fork.

### Phase B: `cave-core` Foundation

Extend `coven-transport` with TLS, certificate pinning, the endpoint candidate
model, and per-network selection memory. Create `cave-core` over it: contract
types validated against the exported v1 fixture, compatibility negotiation, the
error envelope, and typed stream events. Prove both compile for macOS, Linux,
and Windows. Conformance against the fixture is the gate; the differential
harness waits for desktop's reducer to exist.

`cave-core` carries no UniFFI derives, for the same reason `coven-transport`
does not: the UniFFI surface belongs to each application's own FFI crate, which
converts at the boundary. Chat iOS builds its FFI layer in Phase D. This is the
structure Coven Pocket already uses, and it is what keeps a future desktop
Tauri host able to consume `cave-core` without dragging in FFI scaffolding.

### Phase C: Enrollment Authority

Cave's overlay probe, guided setup, reachability self-verification, QR payload
generation, and push device registration storage.

Depends on the desktop program's Phase 1 (`cave-9pifu` and
`2026-08-15-phase-1-discovery-pairing.md`) having landed, because enrollment
extends that pairing flow rather than reimplementing it. As of 2026-08-16 Cave
has no `/api/client/v1` surface at all, so this phase is blocked until it does.

Overlay detection covers Tailscale plus a manual path where the user supplies a
hostname and Cave verifies it. Detecting every provider is not the value;
proving an address actually reaches this instance is, and the manual path
delivers that for Cloudflare Tunnel and anything else.

The relay service is **not** built here. Nothing sends a ping until Phase G, and
Cave's device-registration endpoint stores an opaque topic and secret without
needing the relay to exist.

### Phase D1: iOS Foundation

The `chat-ios` repository, its `chat-ios-ffi` UniFFI crate over `cave-core` and
`coven-transport`, the XCFramework pipeline, CI including the check that fails
the build on any GPL dependency, and the Keychain adapter. Two additive SDK
changes land here because D1 is the first consumer that needs them: POST support
in `coven-transport`, and the enrollment payload decoder in `cave-core`, whose
round-trip vectors must match Cave's.

Deliverable: an app that builds, links the Rust core, and stores a secret
correctly.

### Phase D2: Enrollment and Canonical Reads

QR scan, the enrollment flow through grant exchange, the connection state
machine, canonical reads, the revision-ordered cache, and the SwiftUI shell.

Deliverable: install, enroll by scanning, and read your canonical history.

### Phase E: Send, Stream, and Recovery

Composer, send, stop, retry, typed SSE, cursor checkpointing, background and
foreground resume, reconciliation, and the durable outbox.

### Phase F: Rich Content and Actions

The marker AST and every native renderer, attachments, attention responses,
GitHub actions, task handoffs, and conversation management.

### Phase G: Notifications, Lifecycle, and Hardening

The doorbell relay service, deployed and rate-limited. Doorbell emission from
Cave and delivery to the device. Background refresh, accessibility, the device
matrix, and the security review.

The relay is the only OpenCoven-operated component in this design, and its
hosting platform is an open decision to be made at the start of this phase.

### Phase H: Release

TestFlight, App Store submission, and staged rollout.

The proof gate is evaluated after Phase H, not before.

Phase D is split into D1 and D2 because it spans a new repository, two additive
SDK changes, a foreign-function bridge, a build pipeline, and a full read path.
Each half produces working, testable software on its own, which a single plan
covering all of it would not.

## Success Criteria

The work is complete when:

- A user completes overlay setup through Cave's wizard and pairs a phone by
  scanning one QR code.
- The app reconnects across network changes without the user selecting an
  address.
- All visible conversations and turns are canonical Cave records, identical to
  those in Cave and desktop Chat.
- Familiar identity remains explicit and contract-correct on every conversation
  and turn.
- A streamed turn survives backgrounding and resumes from its cursor without
  duplicate submission.
- A message composed while unreachable submits exactly once on reconnect, and
  never appears delivered before Cave confirms it.
- A stale queued message requires confirmation before sending.
- Every v1 rich message type renders safely, and actions execute only through
  Cave.
- Push notifications arrive carrying no content.
- `overlay unavailable` and `Cave unreachable` are distinguishable to the user.
- `cave-core` passes conformance against the exported v1 contract fixture.
- Once desktop Chat's TypeScript reducer exists, differential tests show
  identical reduced state and identical AST between it and `cave-core`. If
  desktop phases 2 through 4 have not landed by iOS release, this criterion
  carries forward rather than blocking, because a single implementation cannot
  drift.
- Coven Pocket's test suite passes unchanged against `coven-transport`, and the
  reachability/HTTP primitive exists in exactly one place.
- CI fails the `chat-ios` build if any GPL-licensed crate enters its dependency
  graph.
- Accessibility, contract, integration, and device-matrix gates pass.
