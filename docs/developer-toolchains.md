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
| keyring-core | `1.0.0` |
| Apple native keyring store | `1.0.2` |
| Linux Secret Service keyring store | `1.0.1` |
| Windows native keyring store | `1.1.0` |
| windows-sys | `0.61.2` |
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
- Cave installation identity and credential records use the platform store
  selected at compile time: macOS Keychain Services, Linux Secret Service, or
  Windows Credential Manager. Missing or inaccessible native storage fails
  closed; there is no plaintext, environment, browser-storage, or memory
  persistence fallback.
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
- Credential commits retain a zeroized exact-value rollback token until the
  SDK can no longer request discard. Timeout, late-write, and replacement
  cleanup uses compare-and-delete and reports `absent`, `changed`, or `deleted`
  without deleting a newer credential value.
- Credential writes and compare/delete operations share an OS-visible lock
  across Chat processes. Unix uses an owner-private, no-follow `flock` file
  containing no credential data; Windows uses a current-user-only
  `Global\` named mutex. Lock names are bounded hashes of non-secret user,
  service, and account identity. Contention is bounded and reports retryable
  `credential_update_in_progress` instead of waiting indefinitely.
- Windows credentials are created with explicit non-roaming `Local`
  persistence. Existing `Enterprise` credentials are rewritten under the
  cross-process lock with `Local` persistence: installation UUIDs migrate with
  password encoding, while binary credential records migrate as binary
  secrets. Unsupported persistence classes fail closed.
- Credential bytes and parsed bearer strings enter zeroizing owners before
  validation. Invalid JSON, metadata, encoding, and oversized-record paths
  zero the owned allocations before returning.
- Retryable lock contention preserves externally reachable staged state.
  Managed exchange consumes an unreachable pre-write commit token immediately;
  if an exact rollback remains contended, status recovery retains only one
  active credential copy for that authority before accepting another exchange.
  The web controller never replays an ambiguous mutation and retries only
  health/status confirmation.
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
- Expired and terminal pairing state is consumed eagerly. Active native and
  managed pairing maps retain at most 64 oldest-first entries, and the webview
  wrapper applies the same expiry and count bound without exposing secrets.
- Managed exchange drops committed and safely discarded in-memory credential
  copies immediately. Staged rollback tokens needed for late exact discard
  remain reachable through credential status cleanup; terminal copies are
  retained for at most five minutes and 64 entries.
- Authority replacement and close cleanup are generation-scoped. Interleaved
  transitions cannot clear newer pairing or staged-credential state, and an
  open superseded before completion returns `reconcile_required`.
- All platform-store and cross-process-lock work runs on Tauri's blocking pool.
  Lifecycle mutexes are released before backend I/O so discovery and authority
  replacement remain responsive while storage is unavailable or contended.
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
