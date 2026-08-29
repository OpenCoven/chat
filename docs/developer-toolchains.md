# Developer toolchains

## Web toolchain pins

| Tool | Version |
| --- | --- |
| Node.js | `24.18.1` |
| pnpm | `10.34.0` |
| React | `19.2.8` |
| React DOM | `19.2.8` |
| TypeScript | `6.0.3` |
| Vite | `8.2.1` |
| Vitest | `4.1.10` |
| Testing Library React | `16.3.2` |
| Testing Library jest-dom | `7.0.1` |
| Playwright | `1.62.1` |
| Biome | `2.3.2` |

## Native toolchain pins

| Tool | Version |
| --- | --- |
| Rust toolchain | `1.95.0` |
| Tauri CLI | `2.11.4` |
| Tauri crate | `2.11.2` |
| tauri-build | `2.6.2` |
| serde | `1.0.228` |
| serde_json | `1.0.145` |
| base64 | `0.22.1` |
| libc | `0.2.189` |
| sha2 | `0.10.9` |
| uuid | `1.26.0` |
| zeroize | `1.9.0` |

## Deterministic local ports

- Vite dev server: `127.0.0.1:4173`
- Vite preview server: `127.0.0.1:4174`
- Tauri dev URL: `http://127.0.0.1:4173`

## Native boundary notes

- The repository installs unpublished SDK code only from checked-in,
  workspace-independent tarballs under `vendor/sdk/`. `package.json`,
  `pnpm-lock.yaml`, and `contract-canary.lock.json` pin the same bytes; there is
  no OpenCoven registry or workspace fallback.
- Packed-canary schema v2 pins the exact public DTO and managed-native
  signatures used by the webview at SDK
  `acc38488f00860d246c3c553375634d64806eabb`.
- `src/lib/sdk/native-boundary.ts` imports the browser-safe
  `@opencoven/cave-client/managed` entrypoint. Managed discovery and the managed
  client own Client v1 parsing, pairing orchestration, compatibility, error
  normalization, and public DTO identity. The Chat wrapper validates only
  native command envelopes, opaque references, events, and diagnostics.
- `src/lib/sdk/connection-controller.ts` owns the explicit secret-free
  connection state machine. StrictMode bootstrap calls share one in-flight
  generation, and ambiguous pairing create/exchange completion is never
  replayed automatically.
- `src/lib/sdk/query-adapter.ts` owns authenticated in-memory read state. It
  requests 25 records per page, caps each walk at eight pages, rejects cursor
  cycles and stale authority/request generations, and reloads only the affected
  query for `reconcile_required`.
- `src/lib/sdk/diagnostics.ts` maps only allowlisted codes and native checks to
  fixed presentation copy.
- The Tauri host registers only operation-specific native SDK commands. It does
  not expose generic fetch, shell, filesystem, credential-store, or arbitrary
  invoke commands.
- Production credential custody is disabled on macOS, Linux, and Windows and
  diagnostics report `platform_security_unavailable`. No credential helper is
  launched and no Keychain Services, Secret Service, or Credential Manager API
  is called. Native secure-store calls are OS operations that cannot be
  portably canceled after entry; the rejected helper also could not
  independently authenticate the loaded executable image or guarantee
  descendant and pipe reaping. The reviewed response is to start no such
  operation rather than claim a timeout canceled it.
- There is no plaintext, environment, argument, file, public-IPC,
  browser-storage, or memory-persistence fallback. A future production backend
  must prove actual store initialization and use before diagnostics can report
  availability.
- Native discovery returns an owner-checked byte snapshot plus an opaque
  one-time handle. The SDK parses the bytes; the webview can establish an
  authority only with that handle. `sdk_authority_open` is not registered or
  granted to the webview.
- Health and canonical reads return bounded, secret-filtered native snapshots.
  Rust does not duplicate Client v1 envelope, status, error-code, cursor, or DTO
  parsing.
- Pairing commands return only the managed SDK's non-secret request, status,
  and credential metadata shapes. Pairing secrets and staged credential
  handles remain native.
- Prepared credentials use v3 unique record addresses containing only the
  installation UUID and a fresh record UUID. Exact cleanup can address record A
  without targeting replacement record B even if B becomes current between a
  comparison and deletion. Legacy v1/v2 mutable-account records are rejected as
  delete targets and left untouched; production custody performs no migration.
- Credential bytes and parsed bearer strings enter zeroizing owners before
  validation. Invalid JSON, metadata, encoding, and oversized-record paths
  zero the owned allocations before returning.
- An app-state janitor wakes every 250 milliseconds, upgrades only a weak
  reference to transient state, and uses non-blocking locks. It autonomously
  prunes expired ready pairings and pending staged bearers, while active
  operations retain their existing provider deadline. Shutdown signals and
  joins the worker. A scan performs no backend I/O or blocking state
  acquisition and visits only the bounded transient maps. OS scheduling itself
  cannot be given a portable hard deadline, so no cancellation success is
  claimed and no worker is detached.
- Retryable `conflict` from managed exchange is emitted only before the pairing
  handle is removed or provider exchange starts. The controller retains the
  managed session and retries exchange after contention clears. Because the
  packed SDK spends a session wrapper after any exchange error, the boundary
  rebuilds that local wrapper from the existing non-secret request ID and
  original request without invoking native pairing creation again. Once
  exchange or persistence may have occurred, `credential_update_in_progress`
  keeps confirmation-only recovery and never replays the mutation.
- A potentially partial write whose rollback is contended enters an explicit
  rollback-needed state retaining the zeroized exact expected credential.
  Commit retry or discard must finish compare-and-delete before the handle can
  be consumed, and a replacement credential is reported as `changed`.
- Authority replacement and close run exact rollback-needed cleanup before
  removing stale staged state. Contention leaves the cleanup token recoverable
  and returns `credential_update_in_progress`; in-flight writes retained across
  close are reconciled later. Completed cleanup tokens are removed rather than
  retained in an unreachable disposition cache.
- Pairing exchange validates authority generation and Ready state while the
  pairing map is locked, and removes the handle only after those checks pass.
- Discovery and pairing maps retain at most 64 entries. New discovery is
  rejected before provider work when all 64 handles are live; no unexpired
  handle is inserted and then evicted. Expired handles are pruned and a retry
  can then succeed. Pairing reservations use the same reject-before-create
  capacity rule.
- Managed exchange drops committed and safely discarded in-memory credential
  copies immediately. Staged rollback tokens needed for late exact discard
  remain reachable through credential status cleanup; terminal copies are
  retained for at most five minutes and 64 entries.
- Authority replacement and close cleanup are generation-scoped. Interleaved
  transitions cannot clear newer pairing or staged-credential state, and an
  open superseded before completion returns `reconcile_required`.
- `sdk_authority_establish` and `sdk_authority_close` dispatch blocking
  lifecycle work through Tauri's blocking pool. Establishment accepts only a
  native discovery handle, never an endpoint or authority descriptor from
  JavaScript.
- Public request identifiers remain bounded and reject credential-shaped
  values. Protocol status, error-code, and DTO validation is performed by the
  packed SDK managed client.
- macOS and Linux connected Unix peers are inspected from the live socket
  descriptor. Unix-only types and exports are target-gated so Windows builds do
  not reference `std::os::unix`. Windows pipe ownership and connected-identity
  validation is represented by a fail-closed provider boundary and pure
  identity checks; the reviewed Windows OS inspection backend remains to be
  implemented.
- The protected Cave transport provider is intentionally fail-closed until the
  reviewed native `hpke-bound-v1` HTTP implementation is installed. Health and
  pairing/read dispatch reports `platform_security_unavailable` rather than
  downgrading to plaintext authorization headers.
- Browser preview is explicitly offline. It never fabricates discovery,
  approval, native trust, or credentials.
- Authenticated DTOs are kept in memory only; runtime source does not call
  `localStorage`, `sessionStorage`, or IndexedDB.
- Until publication is explicitly approved, Chat installs the exact reviewed
  Cave and core tarballs from `vendor/sdk/`. The cross-repository canary
  independently rebuilds and byte-verifies the same artifacts.
- Run the local canary from this nested Chat checkout with:
  ```bash
  corepack pnpm@10.34.0 --ignore-workspace test:contract-canary -- \
    --sdk-root /absolute/path/to/sdk-at-the-locked-commit \
    --cave-root /absolute/path/to/coven-cave-at-the-locked-commit
  ```
- `contract-canary.lock.json` schema version 2 pins the exact SDK and Cave
  commits, the generated release-manifest digest, and the ordered four-package
  public release set (`@opencoven/sdk-core`, `@opencoven/cave-client`,
  `@opencoven/coven-client`, and `@opencoven/sdk`) with versions, relative
  tarball paths, stable byte sizes, and SHA-256 digests. `@opencoven/dev-cli`
  remains excluded.
- The lock separately pins the Cave contract fixture digest, digest-file byte
  digest, provenance object and provenance-file byte digest. The provenance
  names the historical Cave commit whose exact fixture and digest bytes must
  appear in the packed Cave client. The HPKE vector and digest-file bytes must
  match the locked Cave HEAD.
- CI checks out the exact reviewed revisions with enough Cave history to read
  the provenance commit, rejects dirty counterpart checkouts, verifies both
  HEADs, runs SDK contract verification, and invokes the SDK release artifact
  producer once.
- The generated `release-manifest.json` and all four tarballs must match the
  lock before installation. The canary warms pnpm once, removes the installed
  tree, then performs a cold offline frozen-lockfile install with workspace
  injection/linking disabled. Every OpenCoven package resolves from a locked
  tarball, installed packages must stay inside the process-owned consumer and
  contain no source tree, and cleanup never writes artifacts into tracked Chat
  paths.
- `src-tauri/gen/schemas/desktop-schema.json` is intentionally kept outside the
  ignore rules so the capability `$schema` can ship with fresh checkouts.
- Tauri capabilities are limited to the reviewed native command permissions
  for the `main` window.
- No shell, filesystem, opener, or network plugin permissions are configured.

## Connection/read validation

From this nested Chat checkout, run:

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

These commands validate the operation-specific boundary and mocked native
journey. They are not real-authority or platform conformance evidence.
