# Chat Native Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the production Chat route into a blocking native Cave connection gate that discovers or launches Cave, pairs through Rust-owned secure storage, reconnects after restart, and preserves the existing preview demos.

**Architecture:** Extend the current Tauri seam instead of replacing it. Rust owns discovery, exact-path launch, keychain, constrained transport, and all secret-bearing operations; TypeScript gets a fakeable typed bridge plus a reducer/controller pair that drives the blocking gate while leaving `?demo=chat` and `?demo=minimal` as preview-only fixtures.

**Tech Stack:** React 19.2.8, TypeScript 6.0.3, Vite 8.2.1, Vitest 4.1.10, Playwright 1.62.1, Tauri 2.11.x, Rust 1.95.0, existing contract canary and specification guards.

---

## File Map

**Repository root:** `/Users/buns/Documents/GitHub/OpenCoven/chat`
**Implementation worktree:** `/Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection`
**Branch:** `phase1c/chat-native-connection`
**Primary bead:** `cave-tsvfj`
**Current-state rules to preserve:** `?demo=chat` and `?demo=minimal` stay intact; `playwright.config.ts` remains preview-only; `commands.rs`, `src/lib/desktop-host.ts`, `src-tauri/capabilities/default.json`, `src/specification-guards.test.ts`, and the current tests are extended rather than replaced.

### Create
- `src-tauri/src/discovery.rs` — validated discovery-file loading and candidate selection.
- `src-tauri/src/cave_process.rs` — exact executable-path launch and readiness wait loop.
- `src-tauri/src/keychain.rs` — installation-id and bearer storage/delete through native secure storage.
- `src-tauri/src/pairing.rs` — mutex-protected pending request secrets with non-consuming `get` for polling, single-use `take` for exchange, and expiry cleanup.
- `src-tauri/src/transport.rs` — constrained `/api/client/v1` transport with redirect and size limits.
- `src-tauri/src/test_support.rs` — deterministic fake discovery, process, keychain, and transport helpers for Rust tests.
- `src/lib/native/cave.ts` — typed TypeScript wrappers over the new Tauri commands.
- `src/lib/connection/types.ts` — discriminated connection state and diagnostic types.
- `src/lib/connection/reducer.ts` — pure state transitions.
- `src/lib/connection/controller.ts` — effectful orchestration with retry/cancel/stale-attempt guards.
- `src/lib/connection/reducer.test.ts`
- `src/lib/connection/controller.test.ts`
- `src/components/shell/connection-gate.tsx` — blocking production-route gate.
- `src/components/shell/connection-gate.test.tsx`
- `playwright.native.config.ts` — native-only E2E harness config.
- `e2e/native-connection.spec.ts` — Tauri/native connection-gate flow coverage.

### Modify
- `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` — register the new commands and correct `devUrl` from `?demo=chat` to the production route.
- `src-tauri/capabilities/default.json` and `src/specification-guards.test.ts` — widen only to the reviewed command list, not to shell/filesystem/network defaults.
- `src/app.tsx`, `src/app.test.tsx`, and `src/main.tsx` — render the blocking gate by default while preserving the preview queries.
- `src/lib/desktop-host.ts` and `src/lib/desktop-host.test.ts` — grow from `app_identity` only to the full typed non-secret native bridge.
- `playwright.config.ts` and `e2e/app.spec.ts` — keep preview-only coverage honest once `devUrl` points to `/`.
- `package.json`, `README.md`, `docs/developer-toolchains.md`, and `.github/workflows/ci.yml` — add the native harness script and documentation without removing preview coverage.

### Task 1: Extend the Rust host with discovery, launch, keychain, and constrained transport

**Files:**
- Create: `src-tauri/src/discovery.rs`
- Create: `src-tauri/src/cave_process.rs`
- Create: `src-tauri/src/keychain.rs`
- Create: `src-tauri/src/pairing.rs`
- Create: `src-tauri/src/transport.rs`
- Create: `src-tauri/src/test_support.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src/specification-guards.test.ts`

- [ ] **Step 1: Create a clean Chat worktree for Phase 1c**

Run:

```bash
git -C /Users/buns/Documents/GitHub/OpenCoven/chat fetch origin main
git -C /Users/buns/Documents/GitHub/OpenCoven/chat worktree add /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection -b phase1c/chat-native-connection origin/main
git -C /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection status --short --branch
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-cave fetch origin main
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-cave show origin/main:src/app/api/client/v1/health/route.ts
```

Expected: the new worktree is clean and the reviewed Phase 1a Cave health contract is already present on Cave `origin/main`.

- [ ] **Step 2: Write the failing Rust and specification-guard tests**

```rust
#[test]
fn discovery_rejects_query_bearing_non_loopback_records() {
    let error = load_discovery_record(sample_record("http://example.com/?token=leak")).unwrap_err();
    assert_eq!(error.code(), "unsafe_discovery_record");
}

#[test]
fn transport_rejects_redirects_and_large_bodies() {
    let transport = test_transport();
    assert!(transport.get_health().is_err());
}
```

```ts
it('points Tauri devUrl at the production route instead of ?demo=chat', () => {
  expect(readText('src-tauri/tauri.conf.json')).toContain('"devUrl": "http://127.0.0.1:4173/"');
});
```

- [ ] **Step 3: Run the focused Rust and guard checks and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
pnpm vitest run src/specification-guards.test.ts
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: the new Rust modules and command registrations are missing, and the guard still sees `?demo=chat` in `devUrl`.

- [ ] **Step 4: Implement the minimal native host surface**

```rust
#[tauri::command]
pub async fn discover_cave(
    state: tauri::State<'_, NativeConnectionState>,
) -> Result<DiscoverySnapshot, NativeConnectionError> {
    state.discovery.discover().await
}

#[tauri::command]
pub async fn create_pairing(
    state: tauri::State<'_, NativeConnectionState>,
) -> Result<PairingSnapshot, NativeConnectionError> {
    let issued = state.transport.create_pairing(state.installation_id()).await?;
    state.pending_pairings.insert(issued.request_id.clone(), issued.secret)?;
    Ok(issued.into_non_secret_snapshot())
}

#[tauri::command]
pub async fn poll_pairing(
    request_id: String,
    state: tauri::State<'_, NativeConnectionState>,
) -> Result<PairingSnapshot, NativeConnectionError> {
    let secret = state.pending_pairings.get(&request_id)?;
    state.transport.poll_pairing(&request_id, &secret).await
}

#[tauri::command]
pub async fn exchange_pairing(
    request_id: String,
    state: tauri::State<'_, NativeConnectionState>,
) -> Result<CredentialMetadata, NativeConnectionError> {
    let secret = state.pending_pairings.take(&request_id)?;
    let grant = state.transport.exchange_pairing(&request_id, &secret).await?;
    state.keychain.store_bearer(&grant.bearer)?;
    Ok(grant.metadata)
}
```

Implementation requirements:
- define `NativeConnectionState` in `src-tauri/src/lib.rs` with injected discovery, process, keychain, constrained transport, installation-id, and in-memory pending-pairing collaborators;
- expose separate typed commands for discovery, launch, health, credential status, create/poll/exchange pairing, retry, and credential deletion; do not add a generic request command;
- launch only exact approved binary candidates; never shell out through `PATH` search;
- keep secrets in Rust only; commands return non-secret metadata and normalized errors; missing secure storage fails closed and never falls back to plaintext files;
- disable redirects, cap JSON bodies at 4 MiB and frames at 1 MiB, and keep the transport limited to reviewed `/api/client/v1` operations;
- extend `default.json` with only the reviewed app command permissions; no Tauri shell/fs/opener/network defaults.

- [ ] **Step 5: Run the focused Rust and guard checks again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
pnpm vitest run src/specification-guards.test.ts
pnpm cargo:check
pnpm cargo:test
```

Expected: the specification guards and Rust host tests pass.

- [ ] **Step 6: Commit the Rust host wave**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
git add src-tauri/src/discovery.rs src-tauri/src/cave_process.rs src-tauri/src/keychain.rs src-tauri/src/transport.rs src-tauri/src/test_support.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/capabilities/default.json src/specification-guards.test.ts
git commit -m "feat: add native Cave connection host" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Extend the typed desktop bridge and add a fakeable native adapter

**Files:**
- Create: `src/lib/native/cave.ts`
- Modify: `src/lib/desktop-host.ts`
- Modify: `src/lib/desktop-host.test.ts`
- Modify: `src/app.test.tsx`

- [ ] **Step 1: Write the failing bridge tests**

```ts
it('reads connection snapshots and pairing state through typed commands', async () => {
  const invokeCommand = vi.fn()
    .mockResolvedValueOnce({ name: 'OpenCoven Chat', identifier: 'ai.opencoven.chat', phase: 'phase-1' })
    .mockResolvedValueOnce({ kind: 'locating', attemptId: 1 });

  await expect(readConnectionSnapshot(invokeCommand)).resolves.toEqual({ kind: 'locating', attemptId: 1 });
});

it('uses a fake preview host only for non-secret browser preview flows', () => {
  expect(createPreviewDesktopHost().canUseTauriCommands()).toBe(false);
});
```

- [ ] **Step 2: Run the focused bridge tests and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
pnpm vitest run src/lib/desktop-host.test.ts src/app.test.tsx
```

Expected: the new bridge functions and preview adapter are missing, so the run fails.

- [ ] **Step 3: Implement the minimal typed bridge additively**

```ts
export type DesktopHost = Readonly<{
  canUseTauriCommands: () => boolean;
  readAppIdentity: () => Promise<AppIdentity>;
  readConnectionSnapshot: () => Promise<ConnectionState>;
  startPairing: () => Promise<PairingSnapshot>;
  pollPairing: (requestId: string) => Promise<PairingSnapshot>;
  retryConnection: () => Promise<void>;
  forgetCredential: () => Promise<void>;
  previewAppIdentity: () => AppIdentity;
}>;
```

Implementation requirements:
- keep `app_identity` intact and additive;
- route all new native calls through typed wrappers in `src/lib/native/cave.ts` rather than scattering `invoke()` calls across components;
- keep preview mode fakeable and secret-free; browser preview must never pretend to exercise keychain or bearer paths.

- [ ] **Step 4: Run the focused bridge tests again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
pnpm vitest run src/lib/desktop-host.test.ts src/app.test.tsx
```

Expected: the typed bridge tests pass.

- [ ] **Step 5: Commit the bridge layer**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
git add src/lib/native/cave.ts src/lib/desktop-host.ts src/lib/desktop-host.test.ts src/app.test.tsx
git commit -m "feat: add typed Chat native connection bridge" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Implement the reducer and controller exactly as the approved state machine

**Files:**
- Create: `src/lib/connection/types.ts`
- Create: `src/lib/connection/reducer.ts`
- Create: `src/lib/connection/controller.ts`
- Create: `src/lib/connection/reducer.test.ts`
- Create: `src/lib/connection/controller.test.ts`

- [ ] **Step 1: Write the failing reducer and controller tests**

```ts
it('ignores stale attempt results and re-enters pairing only after repeated 401s', async () => {
  const state = reduceConnectionState({ kind: 'connected', endpoint: 'http://127.0.0.1:3020', health, credential }, { type: 'authenticated-health-failed', diagnosticCode: 'unauthorized', repeated: true });
  expect(state).toEqual({ kind: 'locating', attemptId: expect.any(Number), notice: 'revoked_credential' });
});

it('uses deterministic backoff of 250ms, 500ms, 1s, 2s, 4s capped at 5s', () => {
  expect(connectionBackoffMs(0)).toBe(250);
  expect(connectionBackoffMs(4)).toBe(4000);
  expect(connectionBackoffMs(9)).toBe(5000);
});
```

- [ ] **Step 2: Run the focused reducer/controller tests and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
pnpm vitest run src/lib/connection/reducer.test.ts src/lib/connection/controller.test.ts
```

Expected: the reducer/controller files do not exist yet, so the focused run fails.

- [ ] **Step 3: Implement the minimal reducer/controller pair**

```ts
export type ConnectionState =
  | { kind: 'locating'; attemptId: number; notice?: 'revoked_credential' }
  | { kind: 'starting'; attemptId: number; candidate: string }
  | { kind: 'waiting'; attemptId: number; attempt: number; elapsedMs: number }
  | { kind: 'pairing'; attemptId: number; requestId: string; expiresAt: number; status: 'pending' | 'denied' | 'expired' }
  | { kind: 'connected'; endpoint: string; health: Health; credential: CredentialMetadata }
  | { kind: 'incompatible'; endpoint: string; minimumClientVersion: string; apiVersion: string }
  | { kind: 'unavailable'; reason: string; retryable: boolean; diagnosticCode: string };
```

Implementation requirements:
- the controller sequence is discover → launch if needed → wait/readiness → compatibility → credential probe → pairing create/poll/exchange → connected;
- the controller confirms revocation only after two consecutive authenticated health probes, using the same discovery nonce and credential id, return `401` with a 500 ms delay; any success, non-`401`, discovery change, or credential change resets the counter;
- the second confirmed `401` deletes the keychain entry and restarts pairing; a single ambiguous `401` does not;
- every run carries an attempt id and ignores stale async completions;
- unmount/retry cancellation prevents prior work from mutating the current state.

- [ ] **Step 4: Run the focused reducer/controller tests again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
pnpm vitest run src/lib/connection/reducer.test.ts src/lib/connection/controller.test.ts
pnpm typecheck
```

Expected: the reducer/controller tests and typecheck pass.

- [ ] **Step 5: Commit the connection controller**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
git add src/lib/connection/types.ts src/lib/connection/reducer.ts src/lib/connection/controller.ts src/lib/connection/reducer.test.ts src/lib/connection/controller.test.ts
git commit -m "feat: orchestrate Chat connection state" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Render the blocking gate by default and add a separate native E2E harness

**Files:**
- Create: `src/components/shell/connection-gate.tsx`
- Create: `src/components/shell/connection-gate.test.tsx`
- Create: `playwright.native.config.ts`
- Create: `e2e/native-connection.spec.ts`
- Modify: `src/app.tsx`
- Modify: `src/main.tsx`
- Modify: `playwright.config.ts`
- Modify: `e2e/app.spec.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the failing gate and native-harness tests**

```ts
it('blocks the production route until authenticated Cave health succeeds', async () => {
  render(<ConnectionGate host={host} />);
  expect(screen.getByRole('status', { name: 'Connection state' })).toHaveTextContent('Locating Cave');
  expect(screen.queryByText('Production chat shell')).toBeNull();
});
```

```ts
test('native harness exercises the production route while preview Playwright stays preview-only', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connect to Cave' })).toBeVisible();
});
```

- [ ] **Step 2: Run the focused gate and harness checks and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
pnpm vitest run src/components/shell/connection-gate.test.tsx src/app.test.tsx
pnpm exec playwright test --config playwright.native.config.ts
```

Expected: the gate component and native config are missing, so both commands fail.

- [ ] **Step 3: Implement the minimal blocking gate and harness split**

```tsx
export function App({ desktopIdentityHost = desktopHost }: AppProps) {
  return <ConnectionGate host={desktopIdentityHost} />;
}

function surfaceFor(name: string | null) {
  if (name === 'chat') return <DemoShell />;
  if (name === 'minimal') return <MinimalMacOS />;
  return <App />;
}
```

Implementation requirements:
- production default renders the blocking gate, not a translucent overlay over the shell;
- `?demo=chat` and `?demo=minimal` remain query-only preview fixtures;
- `playwright.config.ts` stays preview-only and continues to verify the non-native browser preview;
- `playwright.native.config.ts` is the separate harness for native connection-gate behavior.

- [ ] **Step 4: Run the focused gate and harness checks again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
pnpm vitest run src/components/shell/connection-gate.test.tsx src/app.test.tsx src/lib/connection/reducer.test.ts src/lib/connection/controller.test.ts
pnpm exec playwright test
pnpm exec playwright test --config playwright.native.config.ts
```

Expected: preview and native harnesses both pass, each exercising only the route they are meant to cover.

- [ ] **Step 5: Commit the gate and native E2E harness**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
git add src/components/shell/connection-gate.tsx src/components/shell/connection-gate.test.tsx src/app.tsx src/main.tsx playwright.config.ts playwright.native.config.ts e2e/app.spec.ts e2e/native-connection.spec.ts package.json .github/workflows/ci.yml
git commit -m "feat: gate Chat startup on native Cave connection" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Finish docs, validation, PR, merge, and bead evidence

**Files:**
- Modify: `README.md`
- Modify: `docs/developer-toolchains.md`

- [ ] **Step 1: Update the docs for the production gate and the split E2E harnesses**

```md
- Production startup now blocks on authenticated Cave health.
- `?demo=chat` and `?demo=minimal` remain preview-only routes.
- `pnpm test:e2e` stays preview-only; `pnpm test:e2e:native` is the separate native harness.
```

- [ ] **Step 2: Run the full Chat validation matrix**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:e2e
pnpm test:e2e:native
pnpm test:contract-canary -- --sdk-root /Users/buns/Documents/GitHub/OpenCoven/sdk --cave-root /Users/buns/Documents/GitHub/OpenCoven/coven-cave
pnpm cargo:fmt
pnpm cargo:check
pnpm cargo:test
pnpm cargo:clippy
pnpm app:build
```

Expected: every command passes. Do not run release, publish, or updater workflows.

- [ ] **Step 3: Commit the docs and verification sweep**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
git add README.md docs/developer-toolchains.md
git commit -m "docs: describe Chat native connection gate" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 4: Push the branch and open the pull request**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
git push -u origin phase1c/chat-native-connection
gh -R OpenCoven/chat pr create --base main --head phase1c/chat-native-connection --title "feat: add Chat native Cave connection gate" --body "## Summary
- add Rust-owned Cave discovery, launch, keychain, and constrained transport
- add the typed desktop bridge plus reducer/controller state machine
- block the production route on authenticated Cave health and add a native E2E harness

## Testing
- pnpm lint
- pnpm typecheck
- pnpm test:unit
- pnpm test:e2e
- pnpm test:e2e:native
- pnpm test:contract-canary -- --sdk-root /Users/buns/Documents/GitHub/OpenCoven/sdk --cave-root /Users/buns/Documents/GitHub/OpenCoven/coven-cave
- pnpm cargo:fmt
- pnpm cargo:check
- pnpm cargo:test
- pnpm cargo:clippy
- pnpm app:build"
```

- [ ] **Step 5: Wait for checks, merge, and close the bead**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/phase1c-chat-native-connection
gh -R OpenCoven/chat pr checks --watch
gh -R OpenCoven/chat pr merge --squash --delete-branch=false
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd ready --json --limit 0
bd show cave-tsvfj
bd close cave-tsvfj --reason "Merged phase1c/chat-native-connection after pnpm lint, pnpm typecheck, pnpm test:unit, pnpm test:e2e, pnpm test:e2e:native, pnpm test:contract-canary, pnpm cargo:fmt, pnpm cargo:check, pnpm cargo:test, pnpm cargo:clippy, and pnpm app:build."
```

Expected: the PR merges only after required checks pass, and the bead captures the native-gate evidence.
