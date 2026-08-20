# Phase 1 Discovery and Pairing Implementation Plan


> **2026-08-20 plan-of-record note:** The approved spec `docs/superpowers/specs/2026-08-20-phase-1-discovery-pairing-design.md` now supersedes this consolidated 2026-08-15 plan's stale file and command assumptions. Implement Phase 1 from the split plans `docs/superpowers/plans/2026-08-20-phase-1a-cave-pairing-authority.md`, `docs/superpowers/plans/2026-08-20-phase-1b-sdk-discovery-pairing.md`, `docs/superpowers/plans/2026-08-20-phase-1c-chat-native-connection.md`, and `docs/superpowers/plans/2026-08-20-phase-1d-real-authority-conformance.md`. The original goals, dependency waves, and bead mapping (`cave-9pifu`, `cave-p8qkk`, `cave-lf7bu`, `cave-tsvfj`, `cave-0prpu`, `cave-23nmv`, `cave-fz01p`) remain the program record; only the stale implementation details are superseded.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a fresh Chat installation discover or start Cave, negotiate health, request explicit pairing approval, exchange a one-time grant into native keychain storage, reconnect, and recover cleanly after revocation.

**Architecture:** Cave exposes only a loopback `/api/client/v1` bootstrap and stores pairing-secret/token hashes, never raw credentials. Chat's Rust host validates discovery, launches exact installed binaries, performs exchange, and attaches the bearer internally; the webview receives only non-secret metadata. `@opencoven/cave-client` uses a constrained transport and pluggable secret store, while `@opencoven/coven-client` independently negotiates `coven.daemon.v1` over same-user IPC.

**Tech Stack:** Cave Next.js/TypeScript 6.0.3; Chat React/TypeScript 6.0.3/Tauri 2.11.x/Rust; SDK TypeScript 6.0.3/Zod 4; OS keychains; Unix sockets and Windows named pipes.

**Depends on:** `2026-08-15-phase-0-baseline-contracts.md`

---

## File Map

### Cave repository

- Create `src/lib/server/client-v1/{pairing-store,credential-store,auth,rate-limit}.ts` and matching tests.
- Create:
  - `src/app/api/client/v1/health/route.ts`
  - `src/app/api/client/v1/pairing/requests/route.ts`
  - `src/app/api/client/v1/pairing/requests/[id]/route.ts`
  - `src/app/api/client/v1/pairing/requests/[id]/exchange/route.ts`
  - `src/app/api/client/v1/admin/pairing-requests/route.ts`
  - `src/app/api/client/v1/admin/pairing-requests/[id]/decision/route.ts`
  - `src/app/api/client/v1/admin/credentials/route.ts`
  - `src/app/api/client/v1/admin/credentials/[id]/route.ts`
  - colocated route tests.
- Create `src/components/settings-client-access.tsx` and test.
- Create `src/styles/settings-client-access.css`.
- Create `src/client-v1-discovery.test.ts`.
- Modify `server.ts`, `src/proxy.ts`, `src/proxy-helpers.ts`,
  `src/middleware.test.ts`, `src/components/settings-shell.tsx`,
  `src/components/settings-sections.ts`, `src/app/api/api-contracts.test.ts`,
  `scripts/run-tests.mjs`, and generated contract artifacts.

### SDK repository

- Create or implement:
  - `packages/core/src/{discovery,secret-store}.ts`
  - `packages/cave/src/{client,transport,pairing,discovery}.ts`
  - `packages/coven/src/{client,discovery,transport-unix,transport-windows}.ts`
  - `packages/cli/src/credentials.ts`
  - `packages/cli/src/commands/{doctor,discover,cave,coven}.ts`
  - matching unit/golden tests.

### Chat repository

- Create `src-tauri/src/{discovery,cave_process,keychain,transport,commands,test_support}.rs`.
- Modify `src-tauri/Cargo.toml` and `src-tauri/src/lib.rs`.
- Create `src/lib/native/cave.ts`.
- Create `src/lib/connection/{types,reducer,controller}.ts` and tests.
- Create `src/components/shell/connection-gate.tsx` and test.
- Create `scripts/run-cave-e2e.mjs`.
- Create `tests/pairing.spec.ts`.

## Task 1: Implement Cave Pairing and Credential Stores

**Files:**
- Cave `pairing-store`, `credential-store`, and tests.
- Modify `scripts/run-tests.mjs`.

- [ ] **Step 1: Write failing pairing lifecycle tests**

Cover pending read, approve, deny, expiry, secret mismatch, single-use consume,
bounded pruning, and replay:

```ts
const created = createPairingRequest(input, 1_000);
expect(readPairingRequest(created.id, created.secret, 1_001)?.status).toBe("pending");
expect(decidePairingRequest(created.id, "approved", 1_002)).toBe(true);
expect(consumeApprovedPairing(created.id, created.secret, 1_003)?.status).toBe("approved");
expect(consumeApprovedPairing(created.id, created.secret, 1_004)).toBeNull();
```

- [ ] **Step 2: Write failing credential tests**

Assert the persisted file contains a token hash but not the issued bearer,
verification is constant-time, revocation survives restart, and `lastUsedAt`
updates no more than once per minute.

- [ ] **Step 3: Run tests and confirm failure**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/client-v1/pairing-store.test.ts \
  src/lib/server/client-v1/credential-store.test.ts
```

- [ ] **Step 4: Implement atomic secure stores**

Pairing records remain process-local, expire after five minutes, and store only
SHA-256 secret hashes. Credentials persist under Cave home with atomic
replacement and contain only token hashes plus app, installation, scope, and
timestamp metadata.

- [ ] **Step 5: Run lifecycle and test-wiring gates**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/client-v1/pairing-store.test.ts \
  src/lib/server/client-v1/credential-store.test.ts
pnpm check:tests-wired
```

Expected: pass.

## Task 2: Enforce the Cave Loopback and Scope Boundary

**Files:**
- Create Cave `auth.ts`, `rate-limit.ts`, and tests.
- Modify `src/proxy.ts`, `src/proxy-helpers.ts`, `src/middleware.test.ts`.

- [ ] **Step 1: Write failing proxy tests**

Assert caller-supplied client markers are removed, direct local requests are
stamped only by `server.ts`, remote ingress is rejected, admin paths do not use
the client bypass, and safe content-type checks still run.

- [ ] **Step 2: Write failing scope/rate tests**

Test absent bearer, invalid bearer, missing scope, valid scope, revoked bearer,
10 pairing creates/minute, 120 authenticated requests/minute, and bounded
bucket pruning. Invalid tokens must not consume a valid credential's bucket.

- [ ] **Step 3: Run the security tests**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/client-v1/auth.test.ts \
  src/lib/server/client-v1/rate-limit.test.ts \
  src/middleware.test.ts
```

Expected: fail before implementation.

- [ ] **Step 4: Implement the narrow proxy branch**

Only non-admin `/api/client/v1` requests from Cave's trusted direct-loopback
stamp bypass the sidecar bearer. Route-level authentication verifies the stamp,
then the scoped client bearer. No private `/api/chat/*` route becomes public.

- [ ] **Step 5: Run security gates**

Repeat the command from Step 3.

Expected: pass.

## Task 3: Add Cave Health, Pairing, Discovery, and Approval UI

**Files:** Cave route, discovery, settings, contract, and test files from the File Map.

- [ ] **Step 1: Write failing health and route tests**

Health must equal:

```ts
{
  ok: true,
  service: "coven-cave",
  apiVersion: "1.0",
  minimumClientVersion: "0.1.0",
  instanceId,
  pairingRequired: true,
  capabilities: [
    "canonical-conversations",
    "resumable-sse",
    "attachments",
    "attention",
    "task-handoff",
    "github-actions",
  ],
}
```

Pairing tests cover create, poll, approve, deny, expire, exchange, replay,
unknown scope, and rate limiting. Pairing secrets travel only in
`X-Coven-Pairing-Secret`.

- [ ] **Step 2: Write failing discovery lifecycle tests**

The discovery record is
`<caveHome>/client-v1-discovery.json`, mode `0600`, with:

```ts
type ClientV1Discovery = {
  version: 1;
  endpoint: string;
  pid: number;
  nonce: string;
  startedAt: string;
};
```

Test atomic replacement after `server.listen`, validated loopback endpoint, and
shutdown cleanup only when the nonce still matches.

- [ ] **Step 3: Write failing settings tests**

Add a real `client-access` entry to `settings-sections.ts`. Test pending request
details, scopes, expiry, approve/deny announcements, credential metadata,
revocation, loading, empty, and error states.

- [ ] **Step 4: Run focused tests**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/app/api/client/v1/health/route.test.ts \
  src/app/api/client/v1/pairing/requests/route.test.ts \
  src/client-v1-discovery.test.ts
pnpm exec vitest run src/components/settings-client-access.test.tsx
```

Expected: fail before implementation.

- [ ] **Step 5: Implement routes, discovery, and settings**

The bearer appears exactly once in the successful exchange response. Admin
routes remain behind Cave's existing UI authentication and CSRF gates. The
settings component polls pending requests only while visible.

- [ ] **Step 6: Regenerate and verify the contract**

```bash
node scripts/export-client-v1-contract.mjs
node scripts/export-client-v1-contract.mjs --check
pnpm lint
pnpm typecheck
pnpm test:api
pnpm check:tests-wired
```

Expected: pass.

## Task 4: Implement SDK Discovery, Pairing, and Diagnostics

**Files:** SDK files from the File Map.

- [ ] **Step 1: Write failing Cave-client tests**

Test discovery profiles, health major negotiation, pairing create/poll/exchange,
denial, expiry, revocation, secret-store injection, explicit unavailable secure
backend, and secret-free errors.

- [ ] **Step 2: Write failing Coven-client transport tests**

Test Unix socket and Windows named-pipe health negotiation through
`coven.daemon.v1`. The public API accepts a validated local endpoint, never an
arbitrary HTTP URL.

- [ ] **Step 3: Write failing CLI golden tests**

Cover:

```text
opencoven doctor [--json]
opencoven discover [--json]
opencoven cave pair|status|forget [--json]
opencoven coven health [--json]
```

JSON contains no bearer, pairing secret, keychain value, raw environment, or
arbitrary filesystem contents.

- [ ] **Step 4: Run package tests and confirm failure**

```bash
pnpm --filter @opencoven/cave-client test
pnpm --filter @opencoven/coven-client test
pnpm --filter @opencoven/dev-cli test
```

- [ ] **Step 5: Implement constrained clients and credential adapters**

`@opencoven/cave-client` accepts a `CaveTransport`; it does not expose
`fetch(url)`. `@opencoven/coven-client` accepts same-user IPC discovery. CLI
credentials implement `SecretStore`; if a supported OS secure backend is
missing, pairing fails explicitly instead of writing plaintext.

- [ ] **Step 6: Run SDK gates**

```bash
pnpm typecheck
pnpm test
pnpm --recursive build
node scripts/verify-contracts.mjs
node scripts/verify-package.mjs
```

Expected: pass.

## Task 5: Implement Chat Native Discovery and Credential Isolation

**Files:** Chat Rust/native files from the File Map.

- [ ] **Step 1: Write failing Rust discovery tests**

Accept only `http://127.0.0.1:<port>` or equivalent validated loopback discovery
records. Reject non-loopback host, userinfo, path, query, fragment, encoded
slash, stale PID, wrong owner/permissions, symlinked discovery files, and
unsupported versions.

- [ ] **Step 2: Write failing process/keychain tests**

Test exact installed Cave candidates per OS, no shell invocation, stable
installation ID, keychain service `ai.opencoven.chat`, account
`cave-client-v1`, credential metadata, write/read/delete, and no secret return.

- [ ] **Step 3: Write failing transport tests**

Permit only the four contract methods and `/api/client/v1/*` paths. Disable
redirects, cap JSON at 4 MiB, cap SSE frames at 1 MiB, reject arbitrary origins,
and attach the bearer only inside Rust.

- [ ] **Step 4: Run Rust tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml discovery
cargo test --manifest-path src-tauri/Cargo.toml cave_process
cargo test --manifest-path src-tauri/Cargo.toml keychain
cargo test --manifest-path src-tauri/Cargo.toml transport
```

Expected: fail before implementation.

- [ ] **Step 5: Implement Tauri commands**

Expose only:

```rust
discover_cave
launch_cave
installation_id
credential_status
exchange_pairing
delete_credential
cave_request
```

`exchange_pairing` writes the bearer to keychain before returning non-secret
metadata.

- [ ] **Step 6: Run native gates**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: pass.

## Task 6: Implement Chat Connection and Pairing State

**Files:** Chat connection and `ConnectionGate` files from the File Map.

- [ ] **Step 1: Write failing reducer tests**

Use:

```ts
type ConnectionState =
  | { kind: "locating" }
  | { kind: "starting"; endpoint: string }
  | { kind: "waiting"; endpoint: string; attempt: number }
  | { kind: "pairing"; endpoint: string; requestId: string; expiresAt: number }
  | { kind: "connected"; endpoint: string; health: Health }
  | { kind: "incompatible"; endpoint: string; minimumClientVersion: string }
  | { kind: "unavailable"; reason: string; retryable: boolean };
```

Test legal transitions, stale-attempt rejection, denial, expiry, revocation,
re-pairing, and deterministic jitter.

- [ ] **Step 2: Write failing controller tests**

The sequence is discover → health → optional exact launch → readiness →
credential status → paired probe → pairing. Backoff is 250 ms, 500 ms, 1 s,
2 s, 4 s, capped at 5 s with a 30-second startup deadline. Only repeated 401
deletes a credential.

- [ ] **Step 3: Write failing UI tests**

Cover locating, starting, waiting, approval, denied, expired, incompatible,
revoked, unavailable, diagnostics, and retry. The chat shell must not render
before authenticated health succeeds.

- [ ] **Step 4: Run tests**

```bash
pnpm test -- \
  src/lib/connection/reducer.test.ts \
  src/lib/connection/controller.test.ts \
  src/components/shell/connection-gate.test.tsx
```

Expected: fail before implementation.

- [ ] **Step 5: Implement the controller and UI**

Request exactly the approved six scopes. Pairing-secret metadata may cross the
webview boundary; the Cave bearer may not.

- [ ] **Step 6: Run Chat gates**

```bash
pnpm test -- src/lib/connection src/components/shell/connection-gate.test.tsx
pnpm typecheck
pnpm build
```

Expected: pass.

## Task 7: Verify the Real Pairing Journey

**Files:**
- Chat `scripts/run-cave-e2e.mjs`
- Chat `tests/pairing.spec.ts`

- [ ] **Step 1: Build the isolated real-Cave harness**

Start explicit Cave and SDK artifacts, use exact per-run state paths, wait for
client-v1 health, capture sanitized diagnostics, stop exact child PIDs, and
clean only harness-owned paths.

- [ ] **Step 2: Add required scenarios**

Test missing Cave, stopped Cave launch, fresh approval, denial, expiry, restart
reconnect, Cave revocation, wrong major, SDK in-memory pairing, CLI secure-store
pairing, and secret-free `doctor --json`.

- [ ] **Step 3: Run E2E**

```bash
pnpm test:e2e -- tests/pairing.spec.ts
```

Expected: pass against a real isolated Cave process.

## Validation Matrix

```bash
# Cave
pnpm lint
pnpm typecheck
pnpm test:api
pnpm check:tests-wired
node scripts/export-client-v1-contract.mjs --check

# SDK
pnpm typecheck
pnpm test
pnpm --recursive build
node scripts/verify-contracts.mjs
node scripts/verify-package.mjs

# Chat
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e -- tests/pairing.spec.ts
```

## Cross-Repository Merge Order

1. Cave secure pairing/credential stores and auth boundary.
2. Cave health, pairing, discovery record, admin routes, and settings UI.
3. SDK Cave pairing and Coven health transports.
4. SDK `opencoven` diagnostic and credential commands.
5. Chat native discovery, launch, keychain, and constrained transport.
6. Chat connection state and UI.
7. Real-authority pairing/revocation canary.

## Commit Checkpoints

Create checkpoints only after the corresponding focused tests pass:

1. Cave: `feat(client-v1): add secure pairing stores`
2. Cave: `feat(client-v1): enforce scoped local authentication`
3. Cave: `feat(client-v1): add pairing approval and discovery`
4. SDK: `feat: add local discovery and pairing clients`
5. Chat: `feat: add native Cave discovery and credentials`
6. Chat: `feat: manage Cave pairing lifecycle`
7. Chat E2E: `test: verify Cave pairing and revocation`

## Exit Gates

- Pairing secrets and bearers are absent from JavaScript logs, Rust logs,
  Playwright traces, screenshots, and config output.
- Replayed exchanges and revoked credentials fail explicitly.
- Restarted Chat reconnects without pairing again.
- Wrong API major produces an upgrade-required state.
- Packaged Chat and packed SDK/CLI pair against real Cave.
- Neither Chat nor the SDK exposes a raw private-route or arbitrary HTTP client.

## Bead Mapping

| Bead | Title | Depends on |
|---|---|---|
| `chat-v1-p1` | Phase 1: deliver Cave discovery and pairing | Phase 0 canary |
| `chat-v1-p1-cave-security` | Secure Cave client pairing stores | Phase 0 Cave contract |
| `chat-v1-p1-cave-boundary` | Expose Cave health pairing and discovery boundary | Cave security |
| `chat-v1-p1-sdk-pairing` | Implement SDK discovery pairing and doctor commands | SDK baseline, Cave boundary |
| `chat-v1-p1-chat-native` | Implement Chat native Cave discovery and credentials | Cave boundary, SDK pairing |
| `chat-v1-p1-chat-state` | Implement Chat pairing state machine | Chat native |
| `chat-v1-p1-live-e2e` | Verify real Cave pairing and revocation | SDK pairing, Chat state |
