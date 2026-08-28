# OpenCoven Chat

OpenCoven Chat is a production-oriented read-only desktop client with a
least-privilege native adapter for the Cave SDK. The default UI initializes a
keychain-backed installation identity, connects or pairs with Cave, and renders
bounded canonical chat reads. Explicit demo routes remain available for later
write-oriented design exploration.

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
  Rust. A random canonical UUID v4 pairing identity is stored per installation
  in the native keyring; browser results are bounded non-secret DTOs and diagnostics.
- On Windows, native discovery accepts only the current token's canonical
  `.coven/cave` record after handle-based owner, ACL, identity, and reparse
  validation. Native keyring mutations use a current-user named mutex.
- No Tauri shell, filesystem, opener, or network plugin capabilities are granted.
- The webview uses frozen packed `@opencoven/cave-client/managed` and
  `@opencoven/sdk-core/browser` artifacts. It never imports SDK workspace
  source or makes repository-relative imports.

### Current native-host limitation

Client v1 cannot atomically bind a health proof to the later pairing-secret or
bearer request. Production release evidence therefore remains blocked on
[coven-cave#4996](https://github.com/OpenCoven/coven-cave/issues/4996).
This bead does not implement Coven Unix connected-peer or Windows named-pipe
trust adapters; those adapters are deferred to the next reviewed native wave.

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
| `pnpm test:contract-canary -- --sdk-root <sdk-root> --cave-root <cave-root>` | Verify reviewed clean checkouts, frozen SDK artifact digests, isolated packed imports, and the Cave authority fixture |
| `pnpm cargo:fmt` | Verify Rust formatting |
| `pnpm cargo:check` | Run Rust compile checks |
| `pnpm cargo:clippy` | Run Rust lint checks with warnings denied |
| `pnpm cargo:test` | Run Rust smoke tests |
| `pnpm app:dev` | Start the Tauri desktop scaffold in development |
| `pnpm app:build` | Build the Tauri desktop scaffold |

## Phase 1 scope

The current application renders:

- the OpenCoven Chat product identity and exact `#9386d0` Coven violet token
- an explicitly labeled browser fallback when Tauri is absent
- a typed, non-secret desktop bridge that reads the keyring-backed pairing
  identity through `app_installation_id` before creating the SDK controller
- connection states and actions for discovery, launch, pairing, cancellation,
  retry, revocation, scope repair, and credential removal
- a read-only canonical Chat surface for familiars, projects, conversations,
  conversation detail, and messages
- bounded cursor-driven load-more controls with short in-memory deduplication
  and caching; authenticated bodies are never written to browser storage
- the familiar switcher at the top of the left rail
- explicit `?demo=chat` and `?demo=minimal` local mock surfaces

Sending messages and other write operations remain deferred to later phases.

## Proof-of-concept chat demo

`pnpm app:dev` opens the production read-only desktop surface. `pnpm dev`
serves the browser fallback at <127.0.0.1:4173/> and the richer mock chat at
<127.0.0.1:4173/?demo=chat>. The demo previews later write-oriented phases:
generated images, link unfurls, `/spec` and `/handoff` artifacts, and a
composer.

**It connects to nothing.** No Cave, no network, no persistence. Replies come
from canned strings and a timer, link unfurls invent their metadata from the
hostname rather than fetching the page, and the generated image is a drawn
placeholder whose palette varies by prompt. A refresh resets everything.

Two consequences worth knowing:

- **The demo is explicit.** `tauri.conf.json` uses the production shell route;
  no demo query is embedded in `devUrl`.
- **The production gate is the default view.** Without a demo query flag the
  app initializes native installation identity and Cave connection state.

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

`contract-canary.lock.json` pins reviewed SDK and Cave commits plus SHA-256
digests for all four frozen public SDK tarballs and the Cave producer's current
Client v1 contract fixture and `hpke-bound-v1` vectors. CI rejects dirty
counterpart checkouts, verifies their immutable HEADs, rebuilds the SDK
tarballs for digest comparison, checks packed fixture ancestry and vector byte
identity, and installs the frozen artifacts into an isolated consumer.

Local explicit-root canary runs still use
`pnpm test:contract-canary -- --sdk-root <sdk-root> --cave-root <cave-root>`,
and the script rejects staged, unstaged, or untracked changes before it
verifies that the checked-out HEADs match the tracked lock.

## CI coverage

`.github/workflows/ci.yml` runs:

- Biome linting
- TypeScript typecheck
- Vitest smoke tests
- Vite production builds for Playwright smoke and `pnpm app:build`
- Playwright smoke coverage
- `pnpm app:build` on Ubuntu with the Linux Tauri system dependencies installed
- the cross-repository packed-tarball contract canary with explicit SDK and Cave checkouts pinned by `contract-canary.lock.json`
- Rust `fmt`, `check`, `clippy`, and `test`

The Tauri capability schema at `src-tauri/gen/schemas/desktop-schema.json` is
intentionally kept outside the ignore rules so the capability `$schema` can ship
with fresh checkouts without granting permissions beyond the reviewed app and
Cave adapter commands.
