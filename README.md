# OpenCoven Chat

Phase 0 of OpenCoven Chat is a production-oriented scaffold for the future
desktop client. It intentionally stops at the shell, toolchains, tests, and
least-privilege native host. The Tauri process now contains the fail-closed
managed-native lifecycle and credential-custody boundary, but pairing
transport, canonical Cave reads, and chat behavior are not wired into the
webview in this phase.

## Security boundaries

- The main window can invoke only the reviewed operation-specific native
  command table; the current TypeScript bridge still invokes only
  `app_identity`.
- No direct arbitrary HTTP calls are implemented.
- Cave credential values are confined to native platform custody. No bearer,
  pairing secret, raw keychain value, or canonical data enters browser storage
  or command diagnostics.
- Native health and pairing results use operation-specific exact schemas rather
  than generic JSON filtering, and staged credential rollback uses exact-value
  compare-and-delete so a late cleanup cannot delete a replacement credential.
- Credential mutations are serialized across Chat processes with owner-private
  OS locks whose names contain only hashes of non-secret credential identity.
- The protected Cave authority provider fails closed with
  `platform_security_unavailable` until the reviewed native
  `hpke-bound-v1` transport is installed.
- No Tauri shell, filesystem, opener, or network plugin capabilities are granted.
- Future Cave integration must use only the public `@opencoven/cave-client`
  package boundary.
- Until package publication is explicitly approved, the cross-repository canary
  installs packed `@opencoven/cave-client` tarballs into a temporary copy
  instead of adding a source-relative or absolute path dependency.

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
| `pnpm test:contract-canary -- --sdk-root <sdk-root> --cave-root <cave-root>` | Pack reviewed SDK tarballs and verify the Cave authority fixture through the public `@opencoven/cave-client` entry point |
| `pnpm cargo:fmt` | Verify Rust formatting |
| `pnpm cargo:check` | Run Rust compile checks |
| `pnpm cargo:clippy` | Run Rust lint checks with warnings denied |
| `pnpm cargo:test` | Run Rust smoke tests |
| `pnpm app:dev` | Start the Tauri desktop scaffold in development |
| `pnpm app:build` | Build the Tauri desktop scaffold |

## Scaffold scope

The current application renders:

- the OpenCoven Chat product identity
- an explicitly labeled browser preview fallback identity when Tauri is absent
- a visible unavailable Cave connection state
- an accessible placeholder status region
- a typed, non-secret desktop identity seam through the `app_identity` Tauri command, with visible failure reporting if the native invoke breaks
- a dormant native managed-SDK command boundary with opaque authority,
  generation, request, pairing, and commit handles
- a documented future Cave client boundary
- the desktop bundle identifier and scaffold phase

Anything beyond that is intentionally deferred to later beads.

## Proof-of-concept chat demo

`pnpm app:dev` opens the desktop window straight into a mock chat surface, and
`pnpm dev` serves it at <127.0.0.1:4173/?demo=chat>. It previews what Phases 1
through 3 will present: conversations, a transcript, generated images, link
unfurls, `/spec` and `/handoff` artifacts, and a composer.

**It connects to nothing.** No Cave, no network, no persistence. Replies come
from canned strings and a timer, link unfurls invent their metadata from the
hostname rather than fetching the page, and the generated image is a drawn
placeholder whose palette varies by prompt. A refresh resets everything.

Two consequences worth knowing:

- **Dev and production differ deliberately.** `devUrl` carries `?demo=chat`, so
  only `tauri dev` opens the demo. A production build loads `dist/index.html`
  with no query string and still shows the Phase 0 scaffold, which is what the
  app actually is.
- **The scaffold is still the default view.** Without the query flag the app
  renders the scaffold, which is what every unit test and both end-to-end specs
  assert.

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

`contract-canary.lock.json` pins the reviewed SDK and Cave counterparts with
immutable 40-character commit SHAs. CI reads that tracked lock, checks out those
exact revisions, rejects dirty SDK or Cave checkouts, and verifies the
checked-out HEADs before running the canary.

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
with fresh checkouts without granting shell, filesystem, opener, or network
plugin permissions.
