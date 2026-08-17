# OpenCoven Chat

Phase 0 of OpenCoven Chat is a production-oriented scaffold for the future
desktop client. It intentionally stops at the shell, toolchains, tests, and
least-privilege native host. Pairing, canonical Cave reads, and chat behavior
are not implemented in this phase.

## Security boundaries

- The main window can invoke only the custom `app_identity` Tauri command.
- No direct arbitrary HTTP calls are implemented.
- No credentials, localStorage canonical data, or secret handling ship in Phase 0.
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
- a documented future Cave client boundary
- the desktop bundle identifier and scaffold phase

Anything beyond that is intentionally deferred to later beads.

## Reviewed counterpart lock

`contract-canary.lock.json` pins the reviewed SDK and Cave counterparts with
immutable 40-character commit SHAs. CI reads that tracked lock, checks out those
exact revisions, and verifies the checked-out HEADs before running the canary.

Local explicit-root canary runs still use
`pnpm test:contract-canary -- --sdk-root <sdk-root> --cave-root <cave-root>`,
and the script still rejects roots whose checked-out HEADs do not match the
tracked lock.

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
with fresh checkouts without broadening permissions beyond `allow-app-identity`.
