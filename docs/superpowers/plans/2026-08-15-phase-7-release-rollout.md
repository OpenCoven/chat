# Phase 7 Packaging, Compatibility, Publishing, and Production Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish signed OpenCoven Chat installers and public SDK/CLI packages with proven Cave/Coven compatibility ranges, staged rollout, diagnostics, and rollback.

**Architecture:** Cave and Coven releases advertise stable compatibility metadata; Chat, SDK, CLI, and owner-adjacent 0.x Rust clients test minimum, latest, and authority `main`. Signed-tag workflows produce immutable installers, checksums, updater signatures, npm provenance, and crate packages. Rollback changes distribution metadata or package versions only and never rewrites Cave or Coven authority state.

**Tech Stack:** Tauri 2, Rust, GitHub Actions, macOS codesign/notarization, Windows code signing/MSI, Linux AppImage, Tauri updater, npm trusted publishing/OIDC provenance, crates.io dry-run/publishing, pnpm 10, Node 24, TypeScript 6.0.3.

**Depends on:** Phase 6 full hardening and artifact privacy gates.

**Repositories:**
- Cave: `/Users/buns/Documents/GitHub/OpenCoven/coven-cave`
- Chat: `/Users/buns/Documents/GitHub/OpenCoven/chat`
- SDK: `/Users/buns/Documents/GitHub/OpenCoven/sdk`
- Coven: `/Users/buns/Documents/GitHub/OpenCoven/coven`

**Published npm packages:**
- `@opencoven/sdk-core`
- `@opencoven/cave-client`
- `@opencoven/coven-client`
- `@opencoven/sdk`
- `@opencoven/dev-cli`

`@opencoven/dev-cli` alone maps the `opencoven` binary. Existing `@opencoven/cli` and the `coven` binary remain owned by Coven and are not renamed or replaced.

**Rust packages:** `opencoven-coven-client` remains in `OpenCoven/coven`; `opencoven-cave-client` remains in `OpenCoven/chat`. Both remain owner-adjacent and pre-1.0.

---

## File Structure

### Cave

- Client v1 health/contract files carry API and minimum-client compatibility.
- `scripts/client-v1-release-smoke.mjs` proves pair/read/revoke behavior in release mode.
- Existing release workflow gains Client v1 gates without replacing Cave’s current desktop/mobile release process.

### Chat

- `scripts/verify-package.mjs` asserts product identity, CSP, capabilities, protocols, icons, updater metadata, and forbidden permissions.
- CI, compatibility, and release workflows are separate.
- `docs/releasing.md` and `docs/rollback.md` define signed release and recovery procedures.

### SDK

- `compatibility/manifest.json` is the machine-readable version/capability/deprecation source.
- `scripts/verify-package.mjs` checks all npm tarballs and binary ownership.
- Trusted publishing uses repository/workflow identity and provenance.

### Coven

- `crates/coven-client/` packages `opencoven-coven-client` independently while remaining a workspace member.
- Existing npm release workflow remains responsible only for `@opencoven/cli` and platform binaries.

## Compatibility Manifest Shape

```json
{
  "schemaVersion": 1,
  "packages": {
    "@opencoven/cave-client": {
      "minimumCave": "0.0.0",
      "testedLatestCave": "0.0.0",
      "requiredCapabilities": ["chat-read"]
    },
    "@opencoven/coven-client": {
      "minimumCoven": "0.0.0",
      "testedLatestCoven": "0.0.0",
      "apiContract": "coven.daemon.v1"
    }
  },
  "deprecations": []
}
```

Release execution replaces `0.0.0` through the signed release tooling; committed package source versions may remain placeholders only where the owning repository’s established release process already stamps them.

## Task 1: Lock Cave Release Compatibility Metadata

**Files — Cave:**
- Modify: `src/lib/server/client-v1/contract.ts`
- Modify: `src/lib/server/client-v1/contract.test.ts`
- Modify: `src/app/api/client/v1/health/route.ts`
- Modify: `src/app/api/client/v1/health/route.test.ts`
- Modify: `scripts/export-client-v1-contract.mjs`
- Modify: `src/lib/server/client-v1/contract-fixture.json`
- Create: `scripts/client-v1-release-smoke.mjs`
- Create: `scripts/client-v1-release-smoke.test.mjs`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write failing health and release-smoke tests**

Require `apiVersion`, `minimumClientVersion`, capability list, instance ID, pairing requirement, and release version. The smoke must pair a synthetic client, read one resource, revoke it, and receive 401 on the next read.

- [ ] **Step 2: Verify failure**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/client-v1/contract.test.ts \
  src/app/api/client/v1/health/route.test.ts
node --test scripts/client-v1-release-smoke.test.mjs
```

- [ ] **Step 3: Implement stable release metadata**

The route major remains `/api/client/v1`. Additive fields are allowed. Required-field removal or semantic change is refused by fixture verification.

- [ ] **Step 4: Run Cave compatibility gates**

```bash
node scripts/export-client-v1-contract.mjs
pnpm release:verify
pnpm test:api
pnpm build
node scripts/client-v1-release-smoke.mjs
```

Expected: PASS against a release-mode Cave process.

## Task 2: Document and Wire the Cave Compatibility Release

**Files — Cave:**
- Modify: `.github/workflows/release.yml`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Create: `docs/client-v1-release.md`

- [ ] **Step 1: Write failing workflow contract tests**

Add source-level tests asserting release validation runs fixture verification and the Client v1 release smoke before artifacts publish.

- [ ] **Step 2: Implement release workflow steps**

Preserve existing private UI routes, mobile validation, signed-tag verification, and platform release jobs. Add Client v1 checks to the existing validation stage rather than creating a weaker alternate publisher.

- [ ] **Step 3: Run release workflow tests**

```bash
pnpm release:verify
pnpm test:app
pnpm test:api
node scripts/client-v1-release-smoke.mjs
```

Expected: PASS.

## Task 3: Configure and Verify the Chat Product Package

**Files — Chat:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`
- Create: `src-tauri/icons/32x32.png`
- Create: `src-tauri/icons/128x128.png`
- Create: `src-tauri/icons/128x128@2x.png`
- Create: `src-tauri/icons/icon.icns`
- Create: `src-tauri/icons/icon.ico`
- Create: `scripts/verify-package.mjs`
- Create: `scripts/verify-package.test.mjs`

- [ ] **Step 1: Write failing package assertions**

Assert:

- product name `OpenCoven Chat`;
- identifier `ai.opencoven.chat`;
- minimum 820×600 and default 1180×780 window;
- strict CSP;
- `opencoven-chat` protocol;
- required icons and updater public key;
- installer targets;
- only required Tauri capabilities;
- absence of shell and arbitrary filesystem permissions.

- [ ] **Step 2: Verify failure**

```bash
node --test scripts/verify-package.test.mjs
node scripts/verify-package.mjs
```

- [ ] **Step 3: Implement package configuration**

Configure updater endpoints and signatures but do not publish. Keep the webview token-free and opener URL allowlist narrow.

- [ ] **Step 4: Run local package gates**

```bash
pnpm typecheck
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
node scripts/verify-package.mjs
pnpm build:app
```

Expected: PASS and a local platform bundle is produced.

## Task 4: Add Chat CI and Compatibility Workflows

**Files — Chat:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/compatibility-canary.yml`
- Create: `scripts/verify-compatibility.mjs`
- Create: `scripts/verify-compatibility.test.mjs`
- Create: `tests/compatibility.spec.ts`
- Modify: `scripts/run-cave-e2e.mjs`

- [ ] **Step 1: Write failing workflow/package tests**

Require Linux web/Rust/E2E validation, OS-specific native tests, minimum/latest/main Cave matrix, isolated homes, deterministic fixtures, and scheduled main/main canary.

- [ ] **Step 2: Verify failure**

```bash
node --test scripts/verify-compatibility.test.mjs
pnpm test:e2e -- tests/compatibility.spec.ts
```

- [ ] **Step 3: Implement compatibility resolution**

`scripts/verify-compatibility.mjs` consumes explicit Cave source/release inputs, verifies health metadata and capabilities, and records the tested SHA/version. It does not clone arbitrary user-supplied repositories or call private routes.

- [ ] **Step 4: Run local equivalents**

```bash
node scripts/verify-compatibility.mjs --target minimum
node scripts/verify-compatibility.mjs --target latest
pnpm test:e2e -- tests/compatibility.spec.ts
```

Expected: PASS for minimum and latest; `main` runs in scheduled CI.

## Task 5: Add Signed Chat Release Workflow

**Files — Chat:**
- Create: `.github/workflows/release.yml`
- Create: `scripts/release-context.mjs`
- Create: `scripts/release-context.test.mjs`
- Create: `scripts/release-smoke.mjs`
- Create: `tests/release-smoke.spec.ts`
- Create: `docs/releasing.md`
- Create: `docs/rollback.md`

- [ ] **Step 1: Write failing signed-tag and artifact tests**

Require an annotated cryptographically verified stable tag on `main`, no cancellation of an in-flight release, exact source/version agreement, repository-secret-only signing, and publication only after release gates.

- [ ] **Step 2: Verify failure**

```bash
node --test scripts/release-context.test.mjs
pnpm test:e2e -- tests/release-smoke.spec.ts
```

- [ ] **Step 3: Implement platform jobs**

Produce:

- signed and notarized macOS application/DMG;
- signed Windows MSI;
- Linux AppImage;
- SHA-256 checksums;
- updater signatures and update metadata.

The workflow must fail closed when signing material is absent for a stable release. Diagnostic-only workflow dispatches may build without publishing.

- [ ] **Step 4: Run non-publishing release validation**

```bash
pnpm typecheck
pnpm test
pnpm build
node scripts/verify-package.mjs
node scripts/release-smoke.mjs
pnpm test:e2e -- tests/release-smoke.spec.ts
```

Expected: PASS.

## Task 6: Package the Owner-Adjacent Coven Rust Client

**Files — Coven:**
- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `crates/coven-client/Cargo.toml`
- Modify: `crates/coven-client/src/lib.rs`
- Create: `crates/coven-client/README.md`
- Create: `crates/coven-client/tests/package_contract.rs`
- Create: `.github/workflows/release-crates.yml`
- Create: `scripts/verify-coven-client-package.mjs`
- Create: `docs/reference/coven-client-crate.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write failing package-contract tests**

Require Cargo package name `opencoven-coven-client`, 0.x version, license/repository/readme metadata, public API docs, no CLI/TUI dependency, and included fixtures.

- [ ] **Step 2: Verify failure**

```bash
cargo test -p opencoven-coven-client --test package_contract --locked
node scripts/verify-coven-client-package.mjs
cargo package -p opencoven-coven-client --locked
```

- [ ] **Step 3: Complete owner-adjacent package metadata**

Do not move the crate to the SDK repository. Do not add `coven-agents` as a dependency. Existing `coven-cli` composes over the client crate without behavior changes.

- [ ] **Step 4: Add signed release workflow**

The crate workflow verifies a signed stable crate tag or approved repository release convention, runs full Rust gates, packages, performs `cargo publish --dry-run`, and publishes only with configured crates.io authority.

- [ ] **Step 5: Run Coven gates**

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
cargo package -p opencoven-coven-client --locked
cargo publish -p opencoven-coven-client --locked --dry-run
python3 scripts/check-secrets.py
```

Expected: PASS.

## Task 7: Package the Owner-Adjacent Cave Rust Client

**Files — Chat:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/crates/cave-client/Cargo.toml`
- Modify: `src-tauri/crates/cave-client/src/lib.rs`
- Create: `src-tauri/crates/cave-client/README.md`
- Create: `src-tauri/crates/cave-client/tests/package_contract.rs`
- Create: `scripts/verify-cave-client-crate.mjs`
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Write failing package-contract tests**

Require Cargo package name `opencoven-cave-client`, 0.x version, transport/schema/pairing/streaming exports, no Chat UI dependency, and live-authority conformance.

- [ ] **Step 2: Verify failure**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked \
  -p opencoven-cave-client --test package_contract
node scripts/verify-cave-client-crate.mjs
cargo package --manifest-path src-tauri/Cargo.toml \
  -p opencoven-cave-client --locked
```

- [ ] **Step 3: Complete package metadata and release gate**

Keep the crate in Chat and pre-1.0. Publishing is allowed only after live Cave conformance and explicit maintainer approval; extraction to another repository needs a separate design.

- [ ] **Step 4: Run crate gates**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked \
  -p opencoven-cave-client
cargo clippy --manifest-path src-tauri/Cargo.toml --locked \
  -p opencoven-cave-client -- -D warnings
cargo package --manifest-path src-tauri/Cargo.toml \
  -p opencoven-cave-client --locked
cargo publish --manifest-path src-tauri/Cargo.toml \
  -p opencoven-cave-client --locked --dry-run
```

Expected: PASS.

## Task 8: Prepare SDK npm Packages and Compatibility Manifest

**Files — SDK:**
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/core/package.json`
- Modify: `packages/cave/package.json`
- Modify: `packages/coven/package.json`
- Modify: `packages/sdk/package.json`
- Modify: `packages/cli/package.json`
- Create: `compatibility/manifest.json`
- Create: `compatibility/manifest.schema.json`
- Create: `compatibility/manifest.test.ts`
- Create: `scripts/verify-contracts.mjs`
- Create: `scripts/verify-package.mjs`
- Create: `scripts/verify-package.test.mjs`
- Create: `scripts/verify-compatibility.mjs`

- [ ] **Step 1: Write failing package assertions**

Verify exact package names, exports, ESM/CJS/types where promised, files lists, licenses, repository metadata, no source-checkout imports, and `opencoven` binary ownership only in `@opencoven/dev-cli`.

- [ ] **Step 2: Verify failure**

```bash
pnpm exec vitest run \
  compatibility/manifest.test.ts \
  scripts/verify-package.test.mjs
pnpm --recursive pack
node scripts/verify-package.mjs
```

- [ ] **Step 3: Implement manifests and package metadata**

`@opencoven/sdk` coordinates optional Cave/Coven clients but does not merge their authentication, transports, models, or errors.

- [ ] **Step 4: Pack and install every tarball**

```bash
pnpm typecheck
pnpm test
pnpm --recursive build
pnpm --recursive pack
node scripts/verify-contracts.mjs
node scripts/verify-package.mjs
node scripts/verify-compatibility.mjs
```

Expected: PASS.

## Task 9: Add SDK CI, Provenance Release, and Authority Canaries

**Files — SDK:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `.github/workflows/authority-canary.yml`
- Create: `scripts/release-context.mjs`
- Create: `scripts/release-context.test.mjs`
- Create: `docs/releasing.md`
- Create: `CHANGELOG.md`

- [ ] **Step 1: Write failing workflow tests**

Require Node 24/pnpm 10, Unix and Windows transport tests, examples, package dry-runs, signed stable tags, OIDC `id-token: write` only in publish jobs, provenance, and wrapper-last publication order.

- [ ] **Step 2: Implement trusted publishing**

Publish in dependency order:

1. `@opencoven/sdk-core`
2. `@opencoven/cave-client` and `@opencoven/coven-client`
3. `@opencoven/sdk`
4. `@opencoven/dev-cli`

Block stable publication on required-field contract drift or a failing minimum/latest compatibility job.

- [ ] **Step 3: Run local release dry-run**

```bash
pnpm typecheck
pnpm test
pnpm --recursive build
pnpm --recursive pack
node scripts/verify-contracts.mjs
node scripts/verify-package.mjs
node scripts/verify-compatibility.mjs
```

Expected: PASS.

## Task 10: Publish Complete Developer Documentation

**Files — SDK:**
- Create: `docs/typescript.md`
- Create: `docs/rust.md`
- Create: `docs/cli.md`
- Create: `docs/discovery.md`
- Create: `docs/pairing.md`
- Create: `docs/error-codes.md`
- Create: `docs/streaming.md`
- Create: `docs/idempotency.md`
- Create: `docs/testing.md`
- Create: `docs/migration.md`
- Modify: `README.md`
- Modify: `packages/core/README.md`
- Modify: `packages/cave/README.md`
- Modify: `packages/coven/README.md`
- Modify: `packages/sdk/README.md`
- Modify: `packages/cli/README.md`

- [ ] **Step 1: Write failing documentation contract tests**

Assert every public package/export/CLI command/error/compatibility field has one canonical documentation target and examples import only public packages.

- [ ] **Step 2: Write documentation with executable examples**

Document direct local-only connectivity, separate authority boundaries, pairing, capabilities, streaming/resume, idempotency, confirmation, JSON/NDJSON contracts, and migration.

- [ ] **Step 3: Run documentation and example gates**

```bash
pnpm test
pnpm --recursive build
pnpm exec vitest run tests/scaffolds tests/live-authorities
node scripts/verify-package.mjs
```

Expected: PASS.

## Task 11: Add Cross-Repository Compatibility Canaries

**Files — Chat:**
- Modify: `.github/workflows/compatibility-canary.yml`
- Modify: `tests/compatibility.spec.ts`

**Files — SDK:**
- Modify: `.github/workflows/authority-canary.yml`
- Create: `tests/live-authorities/compatibility.test.ts`

**Files — Cave:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Test the matrix**

For Chat and SDK:

- minimum supported Cave release;
- latest Cave release;
- Cave `main`;
- minimum supported Coven release;
- latest Coven release;
- Coven `main`.

- [ ] **Step 2: Assert compatibility behavior**

Additive unknown fields pass. Missing required fields, unsupported major versions, and missing required capabilities fail before dependent calls with explicit diagnostics.

- [ ] **Step 3: Run local minimum/latest checks**

```bash
# chat
node scripts/verify-compatibility.mjs --target minimum
node scripts/verify-compatibility.mjs --target latest
pnpm test:e2e -- tests/compatibility.spec.ts

# sdk
node scripts/verify-compatibility.mjs
pnpm exec vitest run tests/live-authorities/compatibility.test.ts
```

Expected: PASS.

## Task 12: Execute Three-OS Acceptance and Rollback Rehearsal

**Files — Chat:**
- Create: `docs/release-acceptance.md`
- Create: `docs/release-acceptance-results/.gitkeep`

- [ ] **Step 1: Build immutable release candidates**

Use signed workflows from exact candidate tags. Record artifact checksums and tested authority/package versions.

- [ ] **Step 2: Execute the acceptance journey on macOS, Windows, and Linux**

For each OS:

1. install supported Cave;
2. install Chat without developer tools;
3. discover/start Cave;
4. pair and approve;
5. load familiar/conversation lists;
6. create/send;
7. disconnect and resume;
8. restart both and verify canonical history;
9. upload and reopen an attachment;
10. confirm one safe action in a test repository;
11. revoke and return to pairing;
12. update Chat and verify preference/keychain/cache migration;
13. install `@opencoven/dev-cli`, run doctor, inspect Coven sessions, send/tail a test conversation, and execute every scaffold.

- [ ] **Step 3: Rehearse rollback**

Restore the prior stable updater metadata without moving tags or overwriting artifacts. Verify npm packages may be deprecated and a patch-forward release installed without changing authority state.

- [ ] **Step 4: Record acceptance**

Record OS, versions, artifact checksums, result, diagnostic IDs, and sanitized notes in the release issue or approved release evidence system. Do not commit credentials or private prompts.

## Task 13: Stage Production Rollout

**Files — Chat:**
- Create: `docs/production-rollout.md`
- Modify: `docs/rollback.md`

- [ ] **Step 1: Define rollout thresholds**

Track crash-free launches, pairing success, read/send/resume/restart/revoke canaries, duplicate-send count, and data-integrity failures. Any auth, duplicate-send, or integrity regression pauses rollout.

- [ ] **Step 2: Run maintainer-only and private beta stages**

Use manual update checks and sanitized diagnostic collection. Do not enable broad automatic updates.

- [ ] **Step 3: Publish low-percentage stable metadata**

Increase rollout only after the approved canaries remain green for the documented observation window.

- [ ] **Step 4: Prove pause and rollback controls**

Pause updates and restore prior metadata using the documented bounded procedure. Never move a signed tag or overwrite a published npm/crate version.

## Cross-Repository Merge and Release Order

1. Cave and Coven compatibility/release tooling.
2. Owner-adjacent Rust client package metadata and dry-runs.
3. SDK package metadata, compatibility manifest, CI, docs, and release workflow.
4. Chat package verification, compatibility CI, installers, and release workflow.
5. Cave Client v1 compatibility release.
6. Compatible Coven release.
7. Stable SDK/CLI package release.
8. Chat private beta.
9. Chat low-percentage stable rollout.
10. Rollout expansion only after canaries pass.

## Exit Gates

- All platform installers install, launch, update, and uninstall cleanly.
- macOS artifacts are signed/notarized, Windows MSI is signed, Linux AppImage is checksummed, and updater metadata is signed.
- The complete acceptance journey passes on macOS, Windows, and Linux.
- Minimum/latest authority compatibility jobs pass; scheduled authority-main canaries are active.
- npm tarballs carry provenance and exact binary ownership.
- Both Rust clients package as owner-adjacent 0.x crates and pass live-authority conformance.
- Prior stable artifacts and rollback metadata exist before rollout begins.
- Package deprecation/rollback does not mutate Cave or Coven authority state.

## Bead Mapping

| Title | Type | Priority | Labels | Dependencies |
|---|---|---:|---|---|
| Phase 7: Packaging, compatibility, publishing, and production rollout | epic | P1 | `program:chat-v1,phase:7,cross-repo` | Phase 6 full gate |
| Cave: publish Client v1 compatibility release | feature | P1 | `repo:coven-cave,phase:7,release,compatibility` | Phase 6 full gate |
| Coven: package and publish owner-adjacent daemon client crate | feature | P1 | `repo:coven,phase:7,rust-sdk,cratesio` | Coven Phase 6 hardening |
| SDK: publish provenance packages, dev CLI, docs, and compatibility manifest | feature | P1 | `repo:sdk,phase:7,npm,provenance` | Cave and Coven release candidates |
| Chat: add verified cross-platform installers and updater metadata | feature | P1 | `repo:chat,phase:7,tauri,signing` | Phase 6 full gate; Cave candidate |
| Cross-repository: add minimum/latest/main compatibility canaries | task | P1 | `cross-repo,phase:7,compatibility,canary` | SDK packages; Chat installers |
| Release: execute three-OS acceptance and rollback rehearsal | task | P1 | `cross-repo,phase:7,acceptance,rollback` | compatibility canaries |
| Release: stage OpenCoven Chat production rollout | task | P1 | `repo:chat,phase:7,production,rollout` | acceptance and rollback rehearsal |

## External Release Prerequisites

These are release blockers rather than code tasks:

- Windows code-signing certificate and repository secrets must exist before stable MSI publication.
- npm trusted publishers must be configured for all five `@opencoven/*` packages.
- crates.io ownership/publishing authority must be configured for both owner-adjacent crates.
- macOS signing/notarization and updater signing secrets must be provisioned.
- The minimum supported Cave and Coven releases must be selected before compatibility metadata is finalized.

