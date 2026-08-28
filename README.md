# OpenCoven Chat

OpenCoven Chat now contains the read-only desktop connection surface for the
reviewed native SDK boundary. The webview can discover an opaque native
authority, guide explicit pairing, reuse or forget the native credential, and
load bounded canonical familiar, project, conversation, and message pages.

The production protected HTTP/HPKE provider is still intentionally fail-closed.
This branch proves the Tauri command boundary, controller, query behavior, and
product journey with focused unit tests and mocked-Tauri Playwright coverage; it
does **not** claim real-authority completion.

## Security boundaries

- The main window can invoke only the reviewed operation-specific native
  command table. `src/lib/sdk/native-boundary.ts` validates exact own-data
  command and event objects before exposing typed non-secret values.
- No direct arbitrary HTTP calls are implemented.
- Cave credential values are confined to native platform custody. No bearer,
  pairing secret, raw keychain value, or canonical data enters browser storage
  or command diagnostics.
- Native health and pairing results use operation-specific exact schemas rather
  than generic JSON filtering, and staged credential rollback uses exact-value
  compare-and-delete so a late cleanup cannot delete a replacement credential.
- Credential mutations are serialized across Chat processes with owner-private
  OS locks whose names contain only hashes of non-secret credential identity.
- Storage work is bounded and dispatched to Tauri's blocking pool; lifecycle
  transitions remain responsive and invalidate transient state by generation.
- Retryable storage contention preserves opaque pairing and commit handles,
  allowing the exact operation to resume without widening authority.
- Partial writes retain an exact rollback-needed token until compare-and-delete
  proves the stored value absent, changed, or deleted.
- Authority replacement and close preserve that token until bounded cleanup
  succeeds, including when an in-flight write completes after close.
- Open and close run as blocking-dispatched async Tauri commands, so cleanup
  contention cannot stall unrelated IPC/runtime work.
- The protected Cave authority provider fails closed with
  `platform_security_unavailable` until the reviewed native
  `hpke-bound-v1` transport is installed.
- No Tauri shell, filesystem, opener, or network plugin capabilities are granted.
- Canonical read commands are operation-specific. There is no generic request,
  route, URL, header, or credential-returning command.
- The connection controller stores only opaque authority references and the
  public states `idle`, `discovering`, `incompatible`, `pairing_required`,
  `pairing`, `ready`, `revoked`, `offline`, and `error`.
- Authenticated responses live only in the in-memory query adapter. Runtime
  source does not use `localStorage`, `sessionStorage`, or IndexedDB.
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
| `corepack pnpm@10.34.0 --ignore-workspace test:contract-canary -- --sdk-root <sdk-root> --cave-root <cave-root>` | Reproduce and verify the locked SDK release manifest, all four packed public packages, Cave contract provenance, and HPKE vector bytes |
| `pnpm cargo:fmt` | Verify Rust formatting |
| `pnpm cargo:check` | Run Rust compile checks |
| `pnpm cargo:clippy` | Run Rust lint checks with warnings denied |
| `pnpm cargo:test` | Run Rust smoke tests |
| `pnpm app:dev` | Start the Tauri desktop scaffold in development |
| `pnpm app:build` | Build the Tauri desktop scaffold |

## Connection and canonical read behavior

The default application surface renders:

- an explicit desktop-only connection gate and browser-unavailable fallback;
- pairing request, approval polling, completion, retry, reconnect, and
  local-forget actions;
- familiar and project summaries after `ready`;
- one bounded conversation page at a time;
- one selected conversation and one bounded message page at a time; and
- accessible loading, empty, error, pagination, focus, mobile, and
  reduced-motion behavior.

The query adapter requests 25 records per page and caps a single query walk at
eight pages. It never prefetches the next page or implicitly walks the corpus.
Authority-generation and request-generation checks discard stale delayed
results. `reconcile_required` resets and reloads only the affected query while
the connection remains `ready`; credential, authority, and transport failures
are handled separately by the connection controller.

Pairing creation and exchange are never automatically replayed after ambiguous
completion. A retryable credential commit resumes only the exact opaque commit
handle. “Forget this device” deletes the local credential and is not described
as server-side revocation.

The TypeScript DTOs follow the exact public `@opencoven/cave-client` shapes
locked by packed-canary schema v2 at SDK
`c237fdc08b56978f1c7220097cf0acb32e6852cb`. Chat still has no unpublished
runtime package dependency; the packed canary remains the installability and
public-signature proof until package publication is approved.

## Proof-of-concept chat demo

`pnpm app:dev` opens the real connection/read surface. The old visual demo
remains available only at <127.0.0.1:4173/?demo=chat>. It previews what later
write-rich phases may present: conversations, a transcript, generated images, link
unfurls, `/spec` and `/handoff` artifacts, and a composer.

**It connects to nothing.** No Cave, no network, no persistence. Replies come
from canned strings and a timer, link unfurls invent their metadata from the
hostname rather than fetching the page, and the generated image is a drawn
placeholder whose palette varies by prompt. A refresh resets everything.

Two consequences worth knowing:

- **The real surface is the default.** Tauri development, production builds,
  unit tests, and Playwright all enter the connection/read application without
  a query flag.
- **The demo is opt-in.** It remains isolated behind `?demo=chat` and connects
  to nothing.

`src/demo/` is not used by the connection/read application and can be removed
when the later write-rich surface is decided.

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

`contract-canary.lock.json` schema version 2 pins more than source revisions. It
records:

- the exact SDK and Cave commit SHAs;
- the byte digest of the SDK `release-manifest.json`;
- the exact ordered set of four public SDK packages, including each version,
  artifact-relative tarball path, byte size, and SHA-256 digest;
- the packed Cave contract fixture, digest-file bytes, and provenance-file
  bytes, including the historical Cave commit named by that provenance; and
- the packed `hpke-bound-v1` vector and digest-file bytes authoritative at the
  locked Cave HEAD.

`@opencoven/dev-cli` is intentionally outside this release canary. The canary
rejects missing, extra, or reordered package entries, and it does not add any
SDK package to Chat's runtime dependencies.

Run it from this Chat checkout with clean exact counterpart checkouts:

```bash
corepack pnpm@10.34.0 --ignore-workspace test:contract-canary -- \
  --sdk-root /absolute/path/to/sdk-at-the-locked-commit \
  --cave-root /absolute/path/to/coven-cave-at-the-locked-commit
```

The script rejects staged, unstaged, or untracked counterpart changes and wrong
HEADs. It runs SDK contract verification, invokes the SDK release artifact
producer once, and compares the generated manifest and every tarball to the
lock. It then creates a process-owned artifact root, warms the pnpm store,
deletes the warm install, and performs a cold `--offline --frozen-lockfile`
install using only the packed SDK tarballs for OpenCoven packages. Installed
packages must remain inside that isolated consumer and contain no source tree.
The artifact root is removed by its owning process; generated tarballs are never
written into tracked Chat paths.

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

## Validation

Because this Chat checkout is nested under the SDK repository, use the pinned
package manager with workspace discovery disabled:

```bash
corepack pnpm@10.34.0 --ignore-workspace typecheck
corepack pnpm@10.34.0 --ignore-workspace test
corepack pnpm@10.34.0 --ignore-workspace test:e2e
corepack pnpm@10.34.0 --ignore-workspace lint
corepack pnpm@10.34.0 --ignore-workspace cargo:fmt
corepack pnpm@10.34.0 --ignore-workspace cargo:check
corepack pnpm@10.34.0 --ignore-workspace cargo:test
corepack pnpm@10.34.0 --ignore-workspace cargo:clippy
corepack pnpm@10.34.0 --ignore-workspace build
corepack pnpm@10.34.0 --ignore-workspace app:build
git diff --check
```

Real Cave/Coven discovery, protected transport, live peer/pipe validation,
restart reuse, and release-mode conformance remain later provider/evidence
lanes.
