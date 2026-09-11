# OpenCoven Chat

OpenCoven Chat opens on local conversations you can write and save on this
device. Local messages persist in IndexedDB when available; the UI reports when
storage falls back to memory. No familiar is connected to local chat, so saving
a message does not produce an AI reply.

The desktop app can also connect or pair with Cave through a least-privilege
native adapter and render bounded, read-only canonical chat data. Explicit demo
routes remain available for design exploration.

## Conversation chapters

Open **Ongoing** in a conversation to navigate UTC-day chapters without
changing its original transcript. This is an exact-conversation view, not a
merge of conversations that share a familiar name. **This device** notes stay
separate, and the Cave source stays read-only.

Switching familiars restores the exact conversation you last selected, including
an available message anchor. References and unsent drafts stay in memory, scoped
to the live source, writer, familiar ID, and conversation ID. Changing sources
never copies a draft. Reloading clears drafts and navigation preferences, not
durably saved local notes. A missing remembered conversation or message shows an
unavailable notice rather than silently choosing a newer conversation.

The installed frozen SDK does not yet expose `listConversationChapters`.
Production Chat says so and offers navigation over already-loaded messages
only, marking partial history rather than prefetching bodies. The additive
DEVELOPMENT read port can consume typed producer headers after a separately
qualified SDK/native capability is admitted. It keeps the eight-page ceiling,
bounded memory-only query cache, revision checks, and source-switch isolation.
Malformed or cross-conversation chapter headers and repeated anchors are rejected.
It does not replace `vendor/opencoven-sdk` bytes or either conformance lock.

## Retained local side notes

You can explore a separate note without changing your parent conversation:

1. Select **This device**, open a conversation, and choose **New retained side note**.
2. Save messages in the empty side note. Your parent draft stays separate.
3. Select individual messages, choose **Review Bring back**, and edit the excerpt.
4. Choose **Bring back reviewed excerpt** to save exactly that text to the original
   local parent as an inert user note.

**Close note** retains its messages. **Reopen note** permits more writing.
**Discard note** requires confirmation and removes the note's local messages;
previously reviewed imports remain in the parent. A minimal creation tombstone
prevents a retried create operation from recreating a discarded note.
An uncertain creation retries with its original key. Once a replay confirms that
the note was discarded, the next explicit **New retained side note** starts a
fresh creation request.
Pending creation keys and acknowledgements survive navigation in exact
source/writer/familiar/parent-scoped session memory. **Retry retained side note
creation** replays that request instead of starting another one. Late
acknowledgements cannot clear a newer request or navigate another parent.
These keys do **not** survive reload or restart: inspect the durable retained-note
list and open any already-created note before choosing to create another.
There is no cross-session exactly-once creation guarantee or durable pending outbox.

An attempted review keeps its operation key, selected message IDs, edited text,
and local branch preconditions in source- and writer-scoped memory. Returning
to the parent or switching sources does not cancel it. After an uncertain save,
retry the unchanged review to reconcile the result before editing again, or
explicitly cancel. Cancellation cannot undo an import that already committed.
If a stale branch is definitively rejected before committing, **Review again**
captures current branch preconditions and a new operation key while retaining
your edited excerpt. An uncertain operation never becomes editable under its
old key. Failed side-note metadata reads offer **Retry local side notes** without
enabling mutations against unknown metadata.
If the exact source is missing, the rejected review stays available as a
read-only, copyable excerpt. **Choose available messages** retains that text
while preparing a new selection with a new key. If the note is gone, copy the
excerpt before explicitly canceling; uncertain acknowledgements still cannot
be edited or reselected.
Fresh or reselected reviews require every selected message to be loaded. If
navigation resets the loaded pages, load the missing page or use **Clear message
selection** to choose a new exact selection; edited excerpts are retained.
Already-captured reviews retry their unchanged payload without requiring the
source page to be loaded again.

**Pending reviews do not survive reload or restart.** Saved imports do. If you
reload after an uncertain save, inspect the parent before starting another import;
the app cannot recover that pending review's key across restarts.

Side notes, lineage, and import receipts use the existing `ChatStore` and
IndexedDB transactions. Repeated operation keys reconcile to the same result;
changed payloads with reused keys are rejected. Competing windows are checked
at commit, and failed imports leave no partial parent record. Imports neither
merge the transcript nor execute instructions, generate replies, copy attachments,
or write to memory services.

The version-2 IndexedDB upgrade preserves existing records and adds operation-key
indexes plus an atomic shared mutation revision. Warm writes read only the exact
conversation preconditions and indexed operation receipts; unchanged history is
not scanned. Initial hydration and refresh after another window's writes still
load history. Close older app windows if they block the database upgrade.
Successful writes recheck the shared revision after their local update and
reconcile detected competing commits before notifying observers. This is not a
continuous subscription to other windows. The memory-only backend also uses
keyed preconditions and operation-key counts, maintained across overwrites,
deletions and discarded-note tombstones. Admission touches only the requested
records and changed rows; loading snapshots and initial hydration still scan
history.
App owns the local store subscription independently of transient panels, so
late committed writes refresh the active local transcript, sidebar and side-note
metadata without another click. These notifications neither navigate another
conversation nor refetch an active Cave source.

These are local-only notes with **no connected familiar**, not Cave-backed side
chats. If durable storage is unavailable, the UI discloses memory-only custody.
There is no Temporary or provider-deletion guarantee. The frozen Cave source
has no side-chat writer, so it shows an unavailable notice rather than an enabled
no-op or a local fallback for canonical content.

The installed Cave SDK omits import provenance. The source-level notice states
that limitation; canonical messages remain read-only text without inferred
import markers or changed roles.

## Security boundaries

- The main window can invoke only the reviewed `app_identity`,
  `app_installation_id`, and SDK-managed Cave adapter commands.
- No browser direct HTTP calls or generic native request command are implemented.
- Managed aborts and deadlines cross the bridge only as single-use opaque
  attempt IDs, a timeout capped at five seconds, and a dedicated narrow cancel
  command; signals and error causes are never serialized.
- Keyring mutations are serialized through a bounded native worker. Cancelled
  or expired queued work is skipped; a mutation already in progress reports a
  non-retryable `credential_update_in_progress` ambiguity until custody is
  coherent.
- Pairing secrets, bearer credentials, headers, and keychain values remain in
  Rust and their transient owners zeroize secret bytes on drop. A random
  canonical UUID v4 pairing identity is stored per installation in the native
  keyring; browser results are bounded non-secret DTOs and diagnostics.
- On Windows, native discovery accepts only the current token's canonical
  `.coven/cave` record after handle-based owner, ACL, identity, and reparse
  validation. Credentials use binary Local persistence, migrate prior
  Enterprise entries and legacy UTF-16 password values, and serialize through
  a bounded current-user-only `Global\` mutex whose owner and DACL are verified
  after creation. During the compatibility window it also acquires the shipped
  session-local mutex in a fixed order. Unix credential mutations use
  owner-private lock files with bounded acquisition.
- No Tauri shell, filesystem, opener, or network plugin capabilities are granted.
- The webview uses frozen packed `@opencoven/cave-client/managed` and
  `@opencoven/sdk-core/browser` artifacts. It never imports SDK workspace
  source or makes repository-relative imports.
- Production Coven health crosses the bounded Tauri operation boundary and
  uses the producer-owned Rust `coven-client` pinned exactly to Coven commit
  `721437b84026c042e431b0882dcd14fdb29ac07d`. Discovery uses explicit
  `COVEN_HOME` when set, otherwise the current account's platform home plus
  `.coven`; the client validates the live connected Unix peer credentials or
  Windows named-pipe ownership and connected identity before health succeeds.
  The direct producer probe runs in the same trusted executable behind one
  fixed internal argument, with null standard streams and an independent
  absolute parent timeout that terminates and reaps only that child. The parent
  consumes only its success or failure status. Missing native trust fails
  closed. There is no pathname, naming, shell, PowerShell, or process-list
  fallback.

### Phase 1 conformance status

The native host now uses the reviewed `hpke-bound-v1` request and response
binding, and production Coven health uses the producer-backed native adapter.
The immutable runtime gate is documented in
[`docs/phase1-conformance.md`](docs/phase1-conformance.md). It emits only
complete SDK #38 platform records and never substitutes mocks for missing
release assertions. Release evidence still requires complete real-authority
runs on the frozen three-platform matrix.

## Delivery tracking

See the [delivery roadmap and consolidation audit](docs/roadmap.md) for current
PR dependencies, protected conformance evidence, and remaining branch cleanup.

## Prerequisites

- Node.js `24.18.1`
- `pnpm` `10.34.0` via Corepack
- Rust toolchain `1.95.0` with `clippy` and `rustfmt`
- Playwright Chromium for local E2E runs

See [`docs/developer-toolchains.md`](docs/developer-toolchains.md) for the full
pin list.

## Developer setup

```bash
corepack enable
pnpm install:clean
pnpm exec playwright install chromium
```

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm install:clean` | Install exactly from `pnpm-lock.yaml` |
| `pnpm dev` | Run the Vite web scaffold on `127.0.0.1:4173` |
| `pnpm build` | Build the production web assets |
| `pnpm typecheck` | Run TypeScript 6.0.3 with `--noEmit` |
| `pnpm lint` | Run Biome checks |
| `pnpm test` / `pnpm test:unit` | Run Vitest + Testing Library smoke tests |
| `pnpm test:e2e` | Run Playwright smoke coverage against a dedicated local preview server on `127.0.0.1:4174` |
| `pnpm test:native-e2e` | Run the feature-gated native RPC subprocess integration tests |
| `pnpm test:contract-canary -- --sdk-root <sdk-root> --cave-root <cave-root>` | Verify reviewed clean checkouts, frozen SDK artifact digests, isolated packed imports, and the Cave authority fixture |
| `/bin/sh scripts/phase1-conformance-launcher.sh "$(command -v node)"` | Exercise the exact locked release through the trusted non-Node launcher and retain one SDK-compatible platform record |
| `pnpm cargo:fmt` | Verify Rust formatting |
| `pnpm cargo:check` | Run Rust compile checks |
| `pnpm cargo:check:windows-gnu` | Check all Rust targets for `x86_64-pc-windows-gnu` |
| `pnpm cargo:clippy` | Run Rust lint checks with warnings denied |
| `pnpm cargo:test` | Run Rust smoke tests |
| `pnpm app:dev` | Start the Tauri desktop scaffold in development |
| `pnpm app:build` | Build the Tauri desktop scaffold |

## Phase 1 scope

The current application renders:

- the OpenCoven Chat product identity and exact `#9386d0` Coven violet token
- writable local conversations in both the desktop app and browser, with an
  explicit memory-only notice when durable storage is unavailable
- a typed, non-secret desktop bridge that reads the keyring-backed pairing
  identity through `app_installation_id` before creating the SDK controller
- connection states and actions for discovery, launch, pairing, cancellation,
  retry, revocation, scope repair, and credential removal
- a read-only canonical Chat surface for familiars, projects, conversations,
  conversation detail, and messages
- bounded cursor-driven load-more controls with short in-memory deduplication
  and caching; authenticated bodies are never written to browser storage
- the familiar switcher at the top of the left rail
- explicit `?demo=chat`, `?demo=messages`, and `?demo=minimal` local mock surfaces

Local messages are saved on this device. Sending to Cave or a familiar, and
other remote write operations, remain deferred to later phases.

## Proof-of-concept chat demo

`pnpm app:dev` opens local chat in the desktop app, with an optional Cave
connection. `pnpm dev` serves local chat at <127.0.0.1:4173/> and the mock chat at
<127.0.0.1:4173/?demo=chat>, which implements the **Familiars Redesign v2**
design: the ward at the centre of the chat, with a "Needs you" section, held
actions the familiar stops at until you decide, a composer that warns before a
draft crosses into the must-ask tier, and an inspector for the familiar's
purpose, access, and activity. The design files it was built from are under
`docs/superpowers/specs/2026-09-01-familiars-redesign-v2/`.

<127.0.0.1:4173/?demo=messages> is the earlier Messages-shaped surface it
replaced, kept reachable for side-by-side comparison. It previews generated
images, link unfurls, `/spec` and `/handoff` artifacts, and a composer.

### Demo build

`pnpm app:build:demo` (`VITE_DEFAULT_DEMO=chat tauri build --config
src-tauri/tauri.demo.conf.json`) packages **OpenCoven Chat Demo**
(`ai.opencoven.chat.demo`), which opens on the
familiars surface with no query flag and installs alongside the real app. The
overlay changes only the name, identifier, blurb, and macOS signing identity;
the production build is unaffected because `VITE_DEFAULT_DEMO` stays unset.

**It connects to nothing.** No Cave, no network, no persistence. Replies come
from canned strings and a timer, link unfurls invent their metadata from the
hostname rather than fetching the page, and the generated image is a drawn
placeholder whose palette varies by prompt. A refresh resets everything.

Two consequences worth knowing:

- **The demo is explicit.** `tauri.conf.json` uses the production shell route;
  no demo query is embedded in `devUrl`.
- **Local chat is the default view.** Cave connection and pairing are optional;
  local conversations remain usable while Cave is unavailable.

`src/demo/` is meant to be deleted when the real read and send paths land. Its
mock types are shaped close to the canonical ones so that lands as a change of
data source rather than a rewrite of the view.

### Minimal (macOS) surface

<127.0.0.1:4173/?demo=minimal> implements the approved **Coven Cave Minimal
(macOS)** design: one window, a sidebar of chats and familiars, an activity
panel, and the approval, familiar and settings sheets over the top.

A second surface rather than a revision of the first, because they are two
directions rather than two drafts of one. Keeping both means the choice between
them can be made by looking at them side by side.

It connects to nothing either, and it carries its own palette — the design
system's tokens, not the scaffold's — scoped under `.mm-desktop` so the two
cannot bleed into each other. Unlike the chat demo it does have test coverage,
in `src/demo/minimal-macos.test.tsx`: what is covered there is the design's
checkable claims, chiefly that an irreversible action stops and asks, and that
the transcript then records which answer it got.

## Reviewed counterpart lock

`contract-canary.lock.json` pins reviewed SDK and Cave commits, the exact SDK
release manifest, all four public tarball paths, sizes, and SHA-256 digests, and
the Cave producer's current Client v1 contract fixture and `hpke-bound-v1`
vectors. CI rejects dirty counterpart checkouts, verifies their immutable
HEADs, regenerates the canonical release artifact set for byte-level digest
comparison, checks packed fixture ancestry and vector byte identity, and
installs the frozen artifacts into an isolated consumer.

Local explicit-root canary runs still use
`pnpm test:contract-canary -- --sdk-root <sdk-root> --cave-root <cave-root>`,
and the script rejects staged, unstaged, or untracked changes before it
verifies that the checked-out HEADs match the tracked lock.

`phase1-conformance.lock.json` independently pins Chat, the SDK package
candidate and evidence authority, Cave, Coven, and the canonical package
metadata for the real-authority gate. The protected
`.github/workflows/client-v1-conformance.yml` schema-v2 producer takes its
separate immutable SDK validator revision as a required dispatch input and
requires it to equal the protected environment's nonsecret
`CLIENT_V1_CONFORMANCE_VALIDATOR_REVISION` variable, avoiding a circular pin
while retaining both the strict schema-v1 gate and canonical schema-v2
platform records. Producer and validator jobs have no OIDC or attestation
authority. A fresh validator job revalidates the immutable uploaded artifacts
and hands only their SHA-256 digests to a separate OIDC job, which downloads
the same artifacts again, compares the digests, and attests without executing
repository or artifact content. Neither replaces or loosens the Phase 0
canary lock.

Before the Windows producer downloads or checks out anything, its trusted
outer supervisor creates a random local non-admin identity with an isolated,
protected profile, temporary directory, and workspace. It protects the
supervisor process and authoritative Job handle from that identity, launches
the complete producer tree suspended with `CreateProcessWithLogonW`, and
assigns it to the query-only nonce-bound Job before resuming it. Every exit
terminates the Job and verifies removal of the ephemeral account, Windows
profile, and bootstrap root.
The macOS and Linux lanes likewise place dependency installation, builds,
candidate/validator/authority execution, and evidence production under a fresh
non-admin UID with isolated home/workspace/temp/tool caches. Linux uses a
trusted cgroup-v2 supervisor and `cgroup.kill`; macOS disables the ephemeral
account and drains every process with its exact UID. Only after a native
zero-process proof does the original runner perform the no-follow,
descriptor-based, create-new artifact handoff.

## CI coverage

`.github/workflows/ci.yml` runs:

- Biome linting
- TypeScript typecheck
- Vitest smoke tests
- Vite production builds for Playwright smoke and `pnpm app:build`
- Playwright smoke coverage
- `pnpm app:build` on Ubuntu with the Linux Tauri system dependencies installed
- the cross-repository packed-tarball contract canary with explicit SDK and Cave checkouts pinned by `contract-canary.lock.json`
- the macOS packaged real-authority matrix with exact counterpart checkouts
  pinned by `phase1-conformance.lock.json`, an isolated keychain, and a
  secret-scanned SDK platform record
- Windows runtime coverage for the cross-user Job supervisor boundary,
  descendant teardown, quotas, membership, and fail-closed account/profile
  cleanup
- native Ubuntu 24.04 and macOS 14 runtime coverage for `setsid`/double-fork
  escape cleanup plus symlink, hardlink, parent-swap, and in-place artifact
  races in the Unix producer supervisor
- Rust `fmt`, `check`, `clippy`, and `test`

The Tauri capability schema at `src-tauri/gen/schemas/desktop-schema.json` is
intentionally kept outside the ignore rules so the capability `$schema` can ship
with fresh checkouts without granting permissions beyond the reviewed app and
Cave adapter commands.

## Releasing

Releases are cut from signed `v*` tags by
[`.github/workflows/release.yml`](.github/workflows/release.yml), which verifies
the tag signature, checks the tag against every version manifest, builds and
smoke-tests bundles for macOS (Apple silicon and Intel), Windows, and Debian
Linux, publishes SHA-256 checksums, and creates the GitHub Release.

The full process, the signing secrets, the dry-run rehearsal path, and the
failure playbook are documented in [`docs/releasing.md`](docs/releasing.md).
