# iPhone Companion Implementation Plan

> **For agentic workers:** Use subagent-driven-development task by task, with spec and quality reviews.

**Goal:** Deliver the native paired Chat iPhone companion described in the October design.
**Architecture:** SwiftUI over pinned local HTTPS to a Rust adapter sharing the existing Chat runtime.
**Tech Stack:** Tauri/Rust, React, SwiftUI, URLSession, Security/Keychain, XcodeGen.

## Execution ledger

- [x] Inspect runtime, prior iOS plans and Modex implementation; isolate branch.
- [x] Record replacement design and exact v1 wire contract.
- [x] Rust host: test protocol/projection/auth/idempotency/lifecycle; implement listener and runtime adapter; run cargo tests and clippy.
- [x] Desktop control: test enable/disable/forget and failures; implement panel, QR/link, IPC guards; run Vitest, typecheck and build.
- [x] iOS app: test pairing validation, pinning, model races and sends; implement Keychain, scanner, transport, model and accessible SwiftUI screens; run native tests and Release build.
- [x] Integration: drive simulator through actual Rust HTTPS fixture; prove send/stream/stop/reconnect/revoke; wire CI and repeat relevant desktop/runtime regressions.
- [x] Review: independent spec then code/security review; resolve all findings.
- [x] Delivery audit: update README/security/build instructions with exact evidence and remaining device/distribution requirements; verify diff and leave a reviewable branch.

## Ownership and verification

Rust task owns `src-tauri/src/companion/`, `coven_runtime.rs` adapter seams,
`lib.rs`, `build.rs`, Cargo manifests/lock and capabilities. Desktop task owns
`src/coven/companion-panel*`, `src/lib/companion*` and the settings insertion.
iOS task owns `apps/ios/ChatCompanion/`, its tests and scripts. Integration owns
`.github/workflows/ios.yml` and test-only fixture executable.

Each component begins with failing behavioral tests, implements the minimal
contract, then runs its focused tests. No commits before verification. Broad gates:
`corepack pnpm typecheck`, `corepack pnpm build`, `corepack pnpm lint`,
`cargo test --manifest-path src-tauri/Cargo.toml --lib`,
`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`,
plus the documented Xcode unit/UI tests and generic iOS Release build.

## Verification receipt — 2026-10-07

- Rust 1.95: 226 library tests passed, 6 existing ignored; all-target/all-feature
  clippy and formatting passed. Independent reviewer reran all 16 companion tests.
- Native contract/package guards: 99 tests passed. Focused desktop UI/IPC tests:
  169 passed, including slow phone-history reads and observer recovery.
- Heavy Vitest suite: 922 passed, 35 skipped. The first broad normal run hit two
  existing process timeouts under concurrent build load; both passed unchanged
  in an isolated rerun. Final normal suite with two workers: 1,208 passed,
  61 skipped across all 67 files, with no timeout changes.
- TypeScript typecheck, Biome lint and Vite production build passed. Existing
  Biome advisory messages and the Vite chunk-size advisory remain.
- `Scripts/test-e2e.sh` passed against the actual Rust HTTPS listener: 13 native
  tests and the native pair/read/send/stream/stop/relaunch/forget UI flow. Correct
  pin accepted, wrong pin rejected, wrong bearer revoked; real Keychain exercised.
  Unsigned generic iOS Release build passed. Result bundle retained under
  `/tmp/chat-companion-signed-sim/Logs/Test/` for this local verification.
- Actual Tauri development executable loaded real Coven familiars and saved
  history and displayed companion IPC status as off. The requested bottom-left
  settings/shortcuts section is absent. Production conversations were not sent;
  send/stream/stop acceptance uses the explicitly synthetic test fixture.
- Rust and Swift spec/security review findings were resolved. Desktop review
  added serialized history reads, stale-result guards, and observer recovery.
- Temporary fixture firewall exception removed after tests; firewall remains on.
  The test listener and its Bonjour process stopped; disposable simulator removed.

Physical iPhone/camera acceptance, hosted CI, signed distribution and TestFlight
have not been performed. The installed desktop app was not replaced. Keep the
feature worktree for integration; this receipt is implementation evidence, not a
release claim.
