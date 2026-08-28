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

- The repository intentionally does **not** depend on unpublished
  `@opencoven/cave-client` runtime artifacts yet.
- The placeholder boundary lives in `src/lib/cave-client-boundary.ts`.
- `src/lib/desktop-host.ts` is the only typed webview-to-host bridge and is
  limited to the non-secret `app_identity` command.
- The Tauri host registers only operation-specific native SDK commands. It does
  not expose generic fetch, shell, filesystem, credential-store, or arbitrary
  invoke commands.
- Cave installation identity and credential records use the platform store
  selected at compile time: macOS Keychain Services, Linux Secret Service, or
  Windows Credential Manager. Missing or inaccessible native storage fails
  closed; there is no plaintext, environment, browser-storage, or memory
  persistence fallback.
- Native authority, pairing, and credential command results carry opaque
  handles plus authority generation and request identity. Replacing an
  authority invalidates prior generations and transient pairing material.
- Health and pairing responses are reduced through operation-specific exact
  DTO schemas. Unknown fields, raw causes, private paths, serialized keychain
  records, and prompt or message content are rejected or replaced with fixed
  safe error text before serialization.
- Credential commits retain a zeroized exact-value rollback token until the
  SDK can no longer request discard. Timeout, late-write, and replacement
  cleanup uses compare-and-delete and reports `absent`, `changed`, or `deleted`
  without deleting a newer credential value.
- Credential writes and compare/delete operations share an OS-visible lock
  across Chat processes. Unix uses an owner-private, no-follow `flock` file
  containing no credential data; Windows uses a current-user-owned named
  mutex. Lock names are hashes of non-secret service and account identity.
- Public request identifiers use the Cave envelope's bounded safe identifier
  grammar while rejecting 43-character base64url secret shapes. Native
  diagnostic identifiers are UUIDs, and error status/code pairs are
  allowlisted separately for health, pairing creation, polling, and exchange.
- macOS and Linux connected Unix peers are inspected from the live socket
  descriptor. Unix-only types and exports are target-gated so Windows builds do
  not reference `std::os::unix`. Windows pipe ownership and connected-identity
  validation is represented by a fail-closed provider boundary and pure
  identity checks; the reviewed Windows OS inspection backend remains to be
  implemented.
- The protected Cave transport provider is intentionally fail-closed until the
  reviewed native `hpke-bound-v1` HTTP implementation is installed. Health and
  pairing dispatch report `platform_security_unavailable` rather than
  downgrading to plaintext authorization headers.
- Until publication is explicitly approved, packed `@opencoven/cave-client`
  tarballs are verified by the cross-repository canary in a temporary install
  copy rather than by a source-relative or absolute path dependency.
- Run the local canary with
  `pnpm test:contract-canary -- --sdk-root <sdk-root> --cave-root <cave-root>`.
- CI reads `contract-canary.lock.json`, checks out those exact reviewed SDK and
  Cave revisions, rejects dirty SDK or Cave checkouts, and verifies the
  checked-out HEADs before the canary runs.
- `src-tauri/gen/schemas/desktop-schema.json` is intentionally kept outside the
  ignore rules so the capability `$schema` can ship with fresh checkouts.
- Tauri capabilities are limited to the reviewed native command permissions
  for the `main` window.
- No shell, filesystem, opener, or network plugin permissions are configured.
