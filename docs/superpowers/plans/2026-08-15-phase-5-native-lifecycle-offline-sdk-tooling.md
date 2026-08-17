# Phase 5 Native Lifecycle, Offline Reads, and SDK Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chat reliable across restart and temporary Cave outages while delivering secret-safe SDK profiles, diagnostics, completions, and compiling TypeScript scaffolds.

**Architecture:** Chat stores only a bounded, replaceable AES-GCM read cache keyed from keychain-held material and scoped by Cave instance ID and resource revision. Desktop lifecycle behavior remains in narrow least-privilege Tauri modules. SDK profiles contain non-secret defaults only; credentials use OS keychain adapters or an injected `SecretStore`, never plaintext configuration.

**Tech Stack:** React 19.2, TypeScript 6.0.3, Tauri 2, Rust, AES-GCM, OS keychains, Zod 4, Vitest, Testing Library, Playwright, Node 24, pnpm 10.

**Depends on:** Phase 4 conformance plus Phase 3 canonical revision ordering, pairing, secure store, drafts, and installed-Cave discovery.

**Repositories:**
- Chat: `/Users/buns/Documents/GitHub/OpenCoven/chat`
- SDK: `/Users/buns/Documents/GitHub/OpenCoven/sdk`

**Boundary:** Offline mode is read-only. There is no offline mutation queue, bearer token in the webview, unrestricted opener, shell execution, arbitrary filesystem grant, or browser-to-local-authority bridge.

---

## File Structure

### Chat

- `src-tauri/src/cache.rs` owns encrypted cache files and atomic replacement.
- `src-tauri/src/desktop.rs` owns shortcuts, notifications, deep links, single-instance focus, and window restoration.
- `src/lib/cache/` owns typed cache hydration and revision ordering.
- `src/lib/preferences/` owns versioned local-only settings.
- `src/lib/native/desktop.ts` is the only webview wrapper for lifecycle commands/events.
- `src/components/settings/` owns settings and sanitized diagnostics.

### SDK

- `packages/core/src/profiles.ts` defines non-secret named profiles.
- `packages/core/src/secret-store.ts` remains the only credential abstraction.
- `packages/core/src/diagnostics.ts` builds redacted diagnostics.
- `packages/cli/src/credentials.ts` implements OS keychain access.
- `packages/cli/src/commands/scaffold.ts` installs fixed templates without overwriting.

## Cache and Preference Contracts

```ts
export type CacheEnvelopeV1 = {
  version: 1;
  caveInstanceId: string;
  writtenAt: string;
  resources: {
    familiars?: { revision: string; value: unknown };
    projects?: { revision: string; value: unknown };
    conversations?: { revision: string; value: unknown };
    transcripts?: Record<string, { revision: string; value: unknown }>;
  };
};

export type PreferencesV1 = {
  version: 1;
  mode: "dark" | "light" | "system";
  reducedMotion: "system" | "reduce" | "allow";
  notifications: boolean;
  launchCave: boolean;
  defaultFamiliarId: string | null;
  defaultProjectId: string | null;
  quickChatShortcut: string;
};
```

The cache excludes tokens, secret-store metadata, drafts, pending mutations, idempotency keys, full event streams, attachment bytes, action payloads, and diagnostics.

## Task 1: Add the Encrypted Native Read Cache

**Files — Chat:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/secure_store.rs`
- Create: `src-tauri/src/cache.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write failing Rust tests**

Test AES-256-GCM round trip, random nonce, tamper rejection, missing key, key rotation, schema mismatch, Cave instance mismatch, size cap, atomic replacement, interrupted replacement, and plaintext absence.

```rust
assert!(!std::fs::read(&cache_path)?.windows(secret.len()).any(|w| w == secret.as_bytes()));
assert!(read_cache_for_instance("other-instance")?.is_none());
```

- [ ] **Step 2: Verify tests fail**

Run from `chat`:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked cache
```

Expected: FAIL because `cache` is absent.

- [ ] **Step 3: Implement cache commands**

Expose:

```rust
#[tauri::command]
async fn read_cache(instance_id: String) -> Result<Option<CacheEnvelope>, NativeError>;
#[tauri::command]
async fn write_cache(instance_id: String, payload: CacheEnvelope) -> Result<(), NativeError>;
#[tauri::command]
async fn clear_cache(instance_id: Option<String>) -> Result<(), NativeError>;
```

Generate the encryption key through `secure_store.rs`. Use owner-only app data, a random nonce per write, authenticated instance/version metadata, a fixed size ceiling, and write-then-rename replacement.

- [ ] **Step 4: Run native tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked cache
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
```

Expected: PASS.

- [ ] **Step 5: Commit checkpoint during execution**

```bash
git add src-tauri/Cargo.toml src-tauri/src/cache.rs \
  src-tauri/src/secure_store.rs src-tauri/src/lib.rs
git commit -m "feat: add encrypted offline read cache"
```

## Task 2: Hydrate Cached Reads Without Creating a Second Database

**Files — Chat:**
- Create: `src/lib/cache/types.ts`
- Create: `src/lib/cache/native-cache.ts`
- Create: `src/lib/cache/hydration.ts`
- Create: `src/lib/cache/hydration.test.ts`
- Modify: `src/lib/chat/query-state.ts`
- Modify: `src/lib/chat/query-state.test.ts`
- Create: `src/components/shell/offline-banner.tsx`
- Create: `src/components/shell/offline-banner.test.tsx`
- Modify: `src/components/shell/app-shell.tsx`

- [ ] **Step 1: Write failing hydration tests**

Test immediate stale display, canonical supersession by revision, stale canonical response rejection, instance change purge, corrupt/undecryptable diagnostic, write disabling, draft preservation, and reconnect-before-write refresh.

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- \
  src/lib/cache/hydration.test.ts \
  src/lib/chat/query-state.test.ts \
  src/components/shell/offline-banner.test.tsx
```

- [ ] **Step 3: Implement hydration ordering**

Represent cache state explicitly:

```ts
type ResourceState<T> =
  | { source: "cache"; stale: true; revision: string; value: T }
  | { source: "cave"; stale: false; revision: string; value: T };
```

Every canonical mutation selector must require `connection.state === "ready"` and a completed post-reconnect refresh.

- [ ] **Step 4: Run focused tests**

```bash
pnpm test -- src/lib/cache src/lib/chat src/components/shell/offline-banner.test.tsx
pnpm typecheck
```

Expected: PASS.

## Task 3: Add Versioned Local Preferences

**Files — Chat:**
- Create: `src/lib/preferences/schema.ts`
- Create: `src/lib/preferences/schema.test.ts`
- Create: `src/lib/preferences/store.ts`
- Create: `src/lib/preferences/store.test.ts`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write failing schema and migration tests**

Cover exact V1 fields, unknown-field removal, additive migration, corrupt JSON, reset, atomic writes, shortcut normalization, and absence of token/endpoint-secret fields.

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- src/lib/preferences
```

- [ ] **Step 3: Implement the schema and native-backed store**

Preferences remain editable offline. Corruption produces a visible `preferences_corrupt` diagnostic and explicit reset; it does not silently replace settings.

- [ ] **Step 4: Run preference tests**

```bash
pnpm test -- src/lib/preferences
pnpm typecheck
```

## Task 4: Add Settings and Sanitized Connection Diagnostics

**Files — Chat:**
- Create: `src/components/settings/settings-dialog.tsx`
- Create: `src/components/settings/appearance-settings.tsx`
- Create: `src/components/settings/chat-settings.tsx`
- Create: `src/components/settings/connection-settings.tsx`
- Create: `src/components/settings/settings.test.tsx`
- Create: `src/styles/settings.css`
- Modify: `src/components/shell/app-shell.tsx`
- Modify: `src/lib/connection/controller.ts`

- [ ] **Step 1: Write failing settings tests**

Test appearance, reduced motion, notifications, launch behavior, defaults, shortcut, endpoint display, API/app versions, instance suffix, paired state, re-pair, last successful health, error code, diagnostic ID, copy feedback, focus trap, Escape, and focus return.

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- src/components/settings/settings.test.tsx
```

- [ ] **Step 3: Implement local-only settings**

Diagnostics may display:

```ts
type ConnectionDiagnostic = {
  endpoint: string;
  apiVersion: string | null;
  appVersion: string;
  instanceSuffix: string | null;
  state: string;
  lastHealthyAt: string | null;
  errorCode: string | null;
  diagnosticId: string | null;
};
```

Never render bearer values, pairing secrets, full prompts, event payloads, or attachment names/bytes.

- [ ] **Step 4: Run settings and accessibility tests**

```bash
pnpm test -- src/components/settings src/lib/preferences
pnpm typecheck
```

## Task 5: Add Least-Privilege Native Desktop Lifecycle

**Files — Chat:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`
- Create: `src-tauri/src/desktop.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/lib/native/desktop.ts`
- Create: `src/lib/native/desktop.test.ts`

- [ ] **Step 1: Add failing Rust lifecycle tests**

Cover shortcut registration/re-registration/conflict, exact protocol parsing, single-instance event delivery, focus of the existing window, visible-monitor clamping, notification permission denial, and URL allowlisting.

- [ ] **Step 2: Verify Rust failure**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked desktop
```

- [ ] **Step 3: Add only required Tauri plugins**

Use the Tauri 2 global-shortcut, notification, single-instance, deep-link, opener, and window-state plugins. Grant only the exact commands and URL patterns used by Chat. Do not grant shell execution, arbitrary filesystem reads/writes, or unrestricted opener access.

- [ ] **Step 4: Write failing TypeScript wrapper tests**

Test browser no-op behavior, event validation, malformed conversation IDs, notification redaction, selected-thread suppression, and shortcut error mapping.

- [ ] **Step 5: Implement typed wrappers and run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked desktop
pnpm test -- src/lib/native/desktop.test.ts
pnpm typecheck
```

Expected: PASS.

## Task 6: Integrate Quick Chat, Notifications, Links, and Window State

**Files — Chat:**
- Create: `src/components/shell/quick-chat-controller.tsx`
- Create: `src/components/shell/quick-chat-controller.test.tsx`
- Create: `src/components/shell/notification-controller.tsx`
- Create: `src/components/shell/notification-controller.test.tsx`
- Modify: `src/components/shell/app-shell.tsx`
- Modify: `src/components/thread/new-conversation.tsx`
- Modify: `src/lib/chat/query-state.ts`

- [ ] **Step 1: Write failing integration tests**

Test:

- shortcut focuses the existing app;
- default familiar/project are selected;
- no canonical conversation exists until Send;
- a valid deep link selects exactly one conversation;
- malformed IDs are rejected;
- only background non-selected completion notifies;
- notification contains familiar name/title but no prompt/response body;
- restored bounds remain visible.

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- \
  src/components/shell/quick-chat-controller.test.tsx \
  src/components/shell/notification-controller.test.tsx
```

- [ ] **Step 3: Implement lifecycle controllers**

Keep native event validation in `src/lib/native/desktop.ts`; components receive typed events only.

- [ ] **Step 4: Run integration tests**

```bash
pnpm test -- src/components/shell src/lib/native
pnpm typecheck
```

## Task 7: Add Secret-Safe SDK Profiles

**Files — SDK:**
- Create: `packages/core/src/profiles.ts`
- Create: `packages/core/src/profiles.test.ts`
- Create: `packages/core/src/profile-store.ts`
- Create: `packages/core/src/profile-store.test.ts`
- Modify: `packages/core/src/secret-store.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/cli/src/credentials.ts`
- Create: `packages/cli/src/credentials.test.ts`
- Create: `packages/cli/src/commands/profiles.ts`
- Create: `packages/cli/src/commands/profiles.test.ts`

- [ ] **Step 1: Write failing profile tests**

Test additive migration, corrupt config, explicit reset, default selection, malicious names/paths, permissions, absence of secret fields, keychain unavailable, injected test store, and stable JSON output.

- [ ] **Step 2: Verify failure**

```bash
pnpm exec vitest run \
  packages/core/src/profiles.test.ts \
  packages/core/src/profile-store.test.ts \
  packages/cli/src/credentials.test.ts \
  packages/cli/src/commands/profiles.test.ts
```

- [ ] **Step 3: Implement profiles and credential adapters**

```ts
export type OpenCovenProfile = {
  version: 1;
  name: string;
  caveEndpoint?: string;
  defaultFamiliarId?: string;
  defaultProjectId?: string;
  covenHome?: string;
};
```

Credentials are addressed by profile identity but stored only through `SecretStore`. There is no plaintext default.

- [ ] **Step 4: Run package gates**

```bash
pnpm exec vitest run packages/core/src packages/cli/src/credentials.test.ts \
  packages/cli/src/commands/profiles.test.ts
pnpm typecheck
```

## Task 8: Add Diagnostics, Completions, and Scaffolds

**Files — SDK:**
- Create: `packages/core/src/diagnostics.ts`
- Create: `packages/core/src/diagnostics.test.ts`
- Create: `packages/cli/src/diagnostic-bundle.ts`
- Create: `packages/cli/src/diagnostic-bundle.test.ts`
- Create: `packages/cli/src/commands/completions.ts`
- Create: `packages/cli/src/commands/completions.test.ts`
- Create: `packages/cli/src/commands/scaffold.ts`
- Create: `packages/cli/src/commands/scaffold.test.ts`
- Create: `packages/cli/templates/typescript-cave-chat/package.json`
- Create: `packages/cli/templates/typescript-cave-chat/src/index.ts`
- Create: `packages/cli/templates/typescript-coven-observer/package.json`
- Create: `packages/cli/templates/typescript-coven-observer/src/index.ts`
- Create: `packages/cli/templates/typescript-unified-status/package.json`
- Create: `packages/cli/templates/typescript-unified-status/src/index.ts`
- Create: `tests/scaffolds/cave-chat.test.ts`
- Create: `tests/scaffolds/coven-observer.test.ts`
- Create: `tests/scaffolds/unified-status.test.ts`
- Create: `docs/browser-limitations.md`
- Create: `docs/scaffolding.md`

- [ ] **Step 1: Write failing diagnostic-redaction tests**

Assert bundles contain versions, capabilities, discovery outcomes, sanitized codes, and diagnostic IDs, but no bearer, pairing secret, prompt, attachment bytes/name, or event payload.

- [ ] **Step 2: Write failing completion and scaffold tests**

Lock Bash/Zsh/Fish/PowerShell completions. Verify scaffold refuses non-empty destinations and symlink escapes, writes only known files, imports public packages, and has no raw HTTP client.

- [ ] **Step 3: Verify failure**

```bash
pnpm exec vitest run \
  packages/core/src/diagnostics.test.ts \
  packages/cli/src/diagnostic-bundle.test.ts \
  packages/cli/src/commands/completions.test.ts \
  packages/cli/src/commands/scaffold.test.ts \
  tests/scaffolds
```

- [ ] **Step 4: Implement deterministic tooling**

`opencoven scaffold typescript` selects one of the three fixed templates. Browser documentation states that browser applications cannot directly connect to local authorities in v1.

- [ ] **Step 5: Pack, install, and typecheck examples**

```bash
pnpm typecheck
pnpm test
pnpm --recursive build
pnpm --recursive pack
pnpm exec vitest run tests/scaffolds
```

Expected: PASS.

## Task 9: Run Packaged Restart and Offline Conformance

**Files — Chat:**
- Create: `tests/offline-reconcile.spec.ts`
- Create: `tests/native-lifecycle.spec.ts`

**Files — SDK:**
- Create: `tests/live-authorities/phase5.test.ts`

- [ ] **Step 1: Implement the approved journeys**

Cover successful read/Cave stop/Chat restart, same-instance replacement, different-instance isolation, corrupt cache/preferences reset, shortcut focus, deep link, notification suppression, removed-monitor bounds, profile migration, and scaffold execution.

- [ ] **Step 2: Run repository gates**

```bash
# chat
pnpm typecheck
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings

# sdk
pnpm typecheck
pnpm test
pnpm --recursive build
pnpm --recursive pack
```

- [ ] **Step 3: Run packaged and live-authority tests**

```bash
# chat
pnpm test:e2e -- tests/offline-reconcile.spec.ts tests/native-lifecycle.spec.ts

# sdk
pnpm exec vitest run tests/live-authorities/phase5.test.ts
```

Expected: PASS on macOS, Windows, and Linux CI runners.

## Cross-Repository Merge Order

1. SDK profile and secret-store contracts.
2. Chat encrypted cache and explicit offline state.
3. Chat preferences and diagnostics.
4. Chat native lifecycle and controllers.
5. SDK CLI diagnostics, completions, and scaffolds.
6. Packaged/live-authority conformance.

## Exit Gates

- Offline mode issues no write request and never queues a later send.
- Secrets, attachment bytes, pending mutations, and event payloads are absent from cache files and diagnostics.
- Cache data from another Cave instance is never displayed as current.
- Shortcut, notification, deep-link, single-instance, and window tests pass on all three OS runners.
- Packaged Chat discovers an installed Cave release rather than requiring a source checkout.
- Global `@opencoven/dev-cli` exposes the `opencoven` binary without plaintext credentials.
- Every scaffold installs, typechecks, and runs against disposable authorities.

## Bead Mapping

| Title | Type | Priority | Labels | Dependencies |
|---|---|---:|---|---|
| Phase 5: Native lifecycle, offline reads, and SDK tooling | epic | P1 | `program:chat-v1,phase:5,cross-repo` | Phase 4 conformance |
| Chat: add encrypted instance-scoped offline read cache | feature | P1 | `repo:chat,phase:5,offline,cache` | Phase 3 revisions/secure store |
| SDK: add secret-safe profiles and credential adapters | feature | P1 | `repo:sdk,phase:5,profiles,keychain` | Phase 3 SDK pairing |
| Chat: add versioned settings and sanitized connection diagnostics | feature | P1 | `repo:chat,phase:5,settings,diagnostics` | SDK profiles; Chat cache |
| Chat: add shortcut, notifications, deep links, window restore, and single instance | feature | P1 | `repo:chat,phase:5,tauri,lifecycle` | Chat settings |
| CLI: add diagnostics bundles, completions, and TypeScript scaffolds | feature | P2 | `repo:sdk,phase:5,cli,scaffold` | SDK profiles |
| Phase 5: run packaged restart, offline, and tooling conformance | task | P1 | `cross-repo,phase:5,e2e` | all Phase 5 implementation beads |

