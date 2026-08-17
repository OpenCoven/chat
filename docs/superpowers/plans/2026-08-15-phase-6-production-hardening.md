# Phase 6 Security, Accessibility, Performance, and Fault Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert every approved security threat, accessibility rule, performance budget, and fault journey into an executable production gate across Cave, Chat, SDK/CLI, and Coven clients.

**Architecture:** Each authority enforces its own boundary; client-side refusal improves UX but never substitutes for Cave or Coven authorization. Shared hostile and fault fixtures drive deterministic tests without exposing credentials or private content. Performance budgets are executable scripts with fixed fixture sizes, while diagnostics and retained artifacts are redacted at their source.

**Tech Stack:** TypeScript 6.0.3, Node 24, React 19.2, Tauri 2/Rust, Vitest, Testing Library, Playwright, Cave Node test runner, cargo test/clippy, package and secret scanners.

**Depends on:** Phase 5 packaged restart/offline/tooling conformance and completed owner-adjacent `opencoven-coven-client` and `opencoven-cave-client` 0.x implementations.

**Repositories:**
- Cave: `/Users/buns/Documents/GitHub/OpenCoven/coven-cave`
- Chat: `/Users/buns/Documents/GitHub/OpenCoven/chat`
- SDK: `/Users/buns/Documents/GitHub/OpenCoven/sdk`
- Coven: `/Users/buns/Documents/GitHub/OpenCoven/coven`

---

## File Structure

### Shared test intent

Each repository keeps its own executable fixtures; no repository imports another repository’s test internals. Contract fixture digests and named scenario IDs establish correspondence.

### Cave

- `src/lib/server/client-v1/security-matrix.test.ts` covers ingress/auth/rate-limit/path/body threats.
- `idempotency-faults.test.ts` covers collisions, concurrency, and interruption recovery.
- `sse-faults.test.ts` covers frame/cursor/replay failures.
- `scripts/client-v1-conversation-benchmark.mjs` enforces read-route budgets.

### Chat

- `src/lib/rich-content/hostile-fixtures.ts` freezes dangerous content cases.
- `tests/keyboard-a11y.spec.ts` owns the complete keyboard path.
- `tests/fault-injection.spec.ts` owns lifecycle/network fault journeys.
- `scripts/verify-performance.mjs` and `verify-diagnostics.mjs` are release gates.

### SDK and Coven

- Package-level tests cover import purity, paths, secret stores, transports, outputs, and deadlines.
- Owner-adjacent Rust client tests cover Unix socket and Windows named-pipe trust independently.

## Matrix IDs

Use stable IDs in test names and reports:

- Security: `SEC-001` through `SEC-024`
- Accessibility: `A11Y-001` through `A11Y-012`
- Performance: `PERF-001` through `PERF-008`
- Faults: `FAULT-001` through `FAULT-014`

Every matrix row must have exactly one owning repository and may have additional defense-in-depth tests elsewhere.

## Task 1: Freeze Executable Matrix Manifests

**Files — Cave:**
- Create: `src/lib/server/client-v1/security-matrix.ts`
- Create: `src/lib/server/client-v1/security-matrix.test.ts`

**Files — Chat:**
- Create: `src/lib/testing/hardening-matrix.ts`
- Create: `src/lib/testing/hardening-matrix.test.ts`

**Files — SDK:**
- Create: `tests/fixtures/hardening-matrix.json`
- Create: `tests/hardening-matrix.test.ts`

**Files — Coven:**
- Create: `crates/coven-client/tests/hardening_matrix.rs`

- [ ] **Step 1: Write failing completeness tests**

Require every approved threat, accessibility behavior, budget, and fault to have an ID, owner, test path, and expected terminal state.

```ts
expect(new Set(matrix.map((item) => item.id)).size).toBe(matrix.length);
expect(matrix.every((item) => item.testPath.length > 0)).toBe(true);
```

- [ ] **Step 2: Verify the manifests fail completeness checks**

```bash
# coven-cave
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/lib/server/client-v1/security-matrix.test.ts

# chat
pnpm test -- src/lib/testing/hardening-matrix.test.ts

# sdk
pnpm exec vitest run tests/hardening-matrix.test.ts

# coven
cargo test -p opencoven-coven-client --test hardening_matrix --locked
```

Expected: FAIL until all approved rows are represented.

- [ ] **Step 3: Add the complete manifests**

Include forged local marker, forwarded ingress, non-loopback host, unsafe content type, bearer states, scope states, request floods, replay, path traversal, redirects, oversized JSON/SSE, malformed SSE/cursors, XSS markers, unsafe opener, filenames, idempotency failures, profile/socket/pipe attacks, CLI injection, output leaks, unsafe scaffold overwrite, full keyboard path, budgets, and fourteen approved faults.

- [ ] **Step 4: Run completeness tests**

Run the four commands above. Expected: PASS.

## Task 2: Harden Cave Ingress, Authentication, and Rate Limits

**Files — Cave:**
- Modify: `src/proxy.ts`
- Modify: `src/proxy-helpers.ts`
- Modify: `src/lib/server/client-v1/auth.ts`
- Modify: `src/lib/server/client-v1/auth.test.ts`
- Modify: `src/lib/server/client-v1/rate-limit.ts`
- Modify: `src/lib/server/client-v1/rate-limit.test.ts`
- Modify: `src/lib/server/api-security.ts`
- Create: `src/app/api/client/v1/security-routes.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write failing `SEC-001`–`SEC-009` tests**

Test forged marker, forwarded headers, non-loopback host, unsafe content type, missing/invalid/wrong-scope/revoked bearer, pairing flood, authenticated flood, and constant-time token comparison.

- [ ] **Step 2: Verify focused failure**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/client-v1/auth.test.ts \
  src/lib/server/client-v1/rate-limit.test.ts \
  src/app/api/client/v1/security-routes.test.ts
```

- [ ] **Step 3: Implement fail-closed gates**

Client v1 non-admin traffic requires a server-stamped direct-loopback marker. Authenticated buckets key on credential ID, not raw token. Pairing buckets key on direct peer plus installation identity and have bounded storage.

- [ ] **Step 4: Run security and private-route regressions**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/client-v1/auth.test.ts \
  src/lib/server/client-v1/rate-limit.test.ts \
  src/app/api/client/v1/security-routes.test.ts \
  src/proxy.test.ts
pnpm check:tests-wired
```

Expected: PASS.

## Task 3: Harden Cave Paths, Attachments, SSE, and Idempotency

**Files — Cave:**
- Modify: `src/lib/server/client-v1/attachment-service.ts`
- Modify: `src/lib/server/client-v1/attachment-service.test.ts`
- Modify: `src/lib/server/client-v1/idempotency-store.ts`
- Create: `src/lib/server/client-v1/idempotency-faults.test.ts`
- Modify: `src/lib/server/client-v1/sse.ts`
- Create: `src/lib/server/client-v1/sse-faults.test.ts`
- Modify: `src/lib/server/client-v1/action-service.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write failing `SEC-010`–`SEC-018` tests**

Cover traversal, encoded slash, redirect, oversized JSON/frame, malformed SSE, invalid cursor, malicious filename, body mismatch on reused idempotency key, concurrent claim, and interruption between claim/completion.

- [ ] **Step 2: Verify failure**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/client-v1/attachment-service.test.ts \
  src/lib/server/client-v1/idempotency-faults.test.ts \
  src/lib/server/client-v1/sse-faults.test.ts
```

- [ ] **Step 3: Implement bounded recovery**

Idempotency records bind method, canonical path, credential, and body digest. A mismatched replay returns conflict. Incomplete claims become explicitly recoverable or failed after the documented lease; they never execute twice.

- [ ] **Step 4: Run Cave hardening tests**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/client-v1/attachment-service.test.ts \
  src/lib/server/client-v1/idempotency-store.test.ts \
  src/lib/server/client-v1/idempotency-faults.test.ts \
  src/lib/server/client-v1/sse-faults.test.ts \
  src/lib/server/client-v1/action-service.test.ts
```

Expected: PASS.

## Task 4: Harden Coven Client IPC and Error Preservation

**Files — Coven:**
- Modify: `crates/coven-client/src/transport_unix.rs`
- Modify: `crates/coven-client/src/transport_windows.rs`
- Modify: `crates/coven-client/src/discovery.rs`
- Modify: `crates/coven-client/src/errors.rs`
- Modify: `crates/coven-client/src/cursor.rs`
- Create: `crates/coven-client/tests/security.rs`
- Create: `crates/coven-client/tests/faults.rs`
- Modify: `docs/API-CONTRACT.md`
- Modify: `docs/CLIENT-INTEGRATION.md`

- [ ] **Step 1: Write failing owner/path/framing tests**

Test malicious `COVEN_HOME`, symlinked socket parent, forged socket path, wrong owner/mode, Windows named-pipe ownership mismatch, constructed rather than discovered pipe names, oversized headers/body, malformed JSON, unknown fields, and source error preservation.

- [ ] **Step 2: Verify failure**

```bash
cargo test -p opencoven-coven-client --test security --locked
cargo test -p opencoven-coven-client --test faults --locked
```

- [ ] **Step 3: Implement same-user transport validation**

Unix validates the discovered endpoint and owner-only parent. Windows uses only the daemon-reported endpoint and validates owner identity. Errors retain system, operation, code, retryability, and safe details.

- [ ] **Step 4: Run Coven gates**

```bash
cargo fmt --check
cargo clippy -p opencoven-coven-client --all-targets --locked -- -D warnings
cargo test -p opencoven-coven-client --locked
```

Expected: PASS.

## Task 5: Harden SDK Profiles, Transports, CLI, and Scaffolds

**Files — SDK:**
- Create: `packages/core/src/security.test.ts`
- Modify: `packages/core/src/profile-store.ts`
- Modify: `packages/core/src/secret-store.ts`
- Modify: `packages/cave/src/transport-node.ts`
- Modify: `packages/coven/src/discovery.ts`
- Modify: `packages/coven/src/transport-unix.ts`
- Modify: `packages/coven/src/transport-windows.ts`
- Create: `packages/coven/src/security.test.ts`
- Create: `packages/cli/src/argument-security.test.ts`
- Create: `packages/cli/src/output-security.test.ts`
- Modify: `packages/cli/src/output.ts`
- Modify: `packages/cli/src/commands/scaffold.ts`
- Modify: `packages/cli/src/commands/doctor.ts`

- [ ] **Step 1: Write failing `SEC-019`–`SEC-024` tests**

Test malicious profile paths, insecure secret fallback, forged sockets/pipes, argument injection, secret-bearing human/JSON/NDJSON output, symlink/non-empty scaffold destinations, and import-time I/O.

- [ ] **Step 2: Verify failure**

```bash
pnpm exec vitest run \
  packages/core/src/security.test.ts \
  packages/coven/src/security.test.ts \
  packages/cli/src/argument-security.test.ts \
  packages/cli/src/output-security.test.ts
```

- [ ] **Step 3: Implement strict boundaries**

Package imports perform no discovery or I/O. No public client exposes arbitrary HTTP paths. CLI delegation passes argv arrays without shell interpolation. Output redaction runs before format selection.

- [ ] **Step 4: Run SDK security gates**

```bash
pnpm exec vitest run \
  packages/core/src/security.test.ts \
  packages/coven/src/security.test.ts \
  packages/cli/src/argument-security.test.ts \
  packages/cli/src/output-security.test.ts \
  packages/cli/src/commands/scaffold.test.ts
pnpm typecheck
```

Expected: PASS.

## Task 6: Close Chat Hostile-Content and Native-Security Paths

**Files — Chat:**
- Create: `src/lib/rich-content/hostile-fixtures.ts`
- Modify: `src/lib/rich-content/parser.test.ts`
- Modify: `src/lib/rich-content/markdown.test.ts`
- Modify: `src/lib/native/desktop.ts`
- Modify: `src/lib/native/desktop.test.ts`
- Modify: `src-tauri/src/transport.rs`
- Modify: `src-tauri/src/cache.rs`
- Create: `src-tauri/src/security_tests.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `tests/hostile-content.spec.ts`

- [ ] **Step 1: Write failing hostile-content tests**

Include raw HTML, scripts, event attributes, `javascript:`, `vbscript:`, `file:`, `http:`, protocol-relative URLs, control-character smuggling, authenticated API URL smuggling, oversized inline images, malformed/nested markers, and malicious filenames.

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- src/lib/rich-content src/lib/native/desktop.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --locked security
```

- [ ] **Step 3: Implement allowlists and caps**

External-open accepts only explicitly allowed `https:` targets. Attachment rendering obtains bytes through the native client and uses object URLs. Transport follows no redirects and caps status line, headers, JSON, and SSE frames.

- [ ] **Step 4: Run hostile-content tests**

```bash
pnpm test -- src/lib/rich-content src/lib/native
cargo test --manifest-path src-tauri/Cargo.toml --locked security
pnpm test:e2e -- tests/hostile-content.spec.ts
```

Expected: PASS with zero script execution or unsafe open.

## Task 7: Complete Keyboard and Screen-Reader Coverage

**Files — Chat:**
- Create: `tests/keyboard-a11y.spec.ts`
- Create: `src/styles/accessibility.css`
- Modify: `src/components/shell/app-shell.tsx`
- Modify: `src/components/sidebar/conversation-list.tsx`
- Modify: `src/components/thread/message-list.tsx`
- Modify: `src/components/thread/composer.tsx`
- Modify: `src/components/thread/attachment-tray.tsx`
- Modify: `src/components/actions/action-confirmation.tsx`
- Modify: `src/components/settings/settings-dialog.tsx`
- Modify: `src/components/messages/spec-card.tsx`
- Modify: `src/components/messages/image-gallery.tsx`

- [ ] **Step 1: Write failing `A11Y-001`–`A11Y-012` journeys**

Cover skip link, landmarks, sidebar roving focus, filters/search, new chat, transcript, composer, attachment remove, stop/retry, card confirmation, spec reader, settings, Escape, focus return, visible focus, color-independent states, reduced motion, high contrast, and no repeated token-delta announcements.

- [ ] **Step 2: Verify failure**

```bash
pnpm test:e2e -- tests/keyboard-a11y.spec.ts
```

- [ ] **Step 3: Fix semantic and focus behavior**

Use native elements first. Live regions announce state transitions, not stream deltas. Modal and carousel behavior remains deterministic under reduced motion.

- [ ] **Step 4: Run component and browser accessibility gates**

```bash
pnpm test -- src/components
pnpm test:e2e -- tests/keyboard-a11y.spec.ts
pnpm typecheck
```

Expected: PASS with no keyboard trap.

## Task 8: Enforce Cave and Chat Performance Budgets

**Files — Cave:**
- Create: `scripts/client-v1-conversation-benchmark.mjs`
- Create: `scripts/client-v1-conversation-benchmark.test.mjs`
- Modify: `src/lib/server/client-v1/read-model.ts`
- Modify: `src/lib/server/client-v1/read-model.test.ts`
- Modify: `package.json`

**Files — Chat:**
- Create: `scripts/verify-bundle.mjs`
- Create: `scripts/verify-performance.mjs`
- Create: `scripts/verify-performance.test.mjs`
- Create: `tests/performance.spec.ts`
- Modify: `src/lib/chat/stream-reducer.ts`
- Modify: `src/lib/chat/stream-reducer.test.ts`
- Modify: `src/components/sidebar/conversation-list.tsx`

- [ ] **Step 1: Write failing `PERF-001`–`PERF-006` budgets**

Enforce:

- warm connected shell interactive within 2 seconds;
- cached offline shell visible within 1 second;
- 10,000 summaries without an input block over 100 ms;
- 10,000 events plus duplicate replay with bounded memory;
- explicit Chat web/Tauri size ceilings;
- Cave Client v1 list reads preserve metadata caching and avoid transcript-body rescans.

- [ ] **Step 2: Verify budget failure**

```bash
# coven-cave
node scripts/client-v1-conversation-benchmark.mjs

# chat
node scripts/verify-performance.mjs
pnpm test:e2e -- tests/performance.spec.ts
```

- [ ] **Step 3: Implement bounded list/reducer behavior**

Virtualize or window the 10,000-row list. Bound deduplication/cursor state. Preserve Cave’s metadata cache through Client v1 projections.

- [ ] **Step 4: Run performance gates**

```bash
# coven-cave
node scripts/client-v1-conversation-benchmark.mjs
pnpm build

# chat
pnpm build
node scripts/verify-bundle.mjs
node scripts/verify-performance.mjs
pnpm test:e2e -- tests/performance.spec.ts
```

Expected: PASS with budget and headroom printed.

## Task 9: Enforce SDK Import and Doctor Budgets

**Files — SDK:**
- Create: `packages/cave/src/performance.test.ts`
- Create: `packages/coven/src/performance.test.ts`
- Create: `packages/cli/src/performance.test.ts`
- Create: `scripts/verify-performance.mjs`

- [ ] **Step 1: Write failing `PERF-007` and `PERF-008` tests**

Assert imports perform no discovery, filesystem, socket, named-pipe, HTTP, or keychain work. `opencoven doctor --json` completes within 2 seconds when both authorities are healthy and within explicit bounded deadlines when absent.

- [ ] **Step 2: Verify failure**

```bash
pnpm exec vitest run \
  packages/cave/src/performance.test.ts \
  packages/coven/src/performance.test.ts \
  packages/cli/src/performance.test.ts
```

- [ ] **Step 3: Move all I/O behind explicit methods and add deadlines**

Constructors store configuration only. `connect`, `discover`, `doctor`, and resource methods initiate I/O.

- [ ] **Step 4: Run performance gates**

```bash
pnpm exec vitest run \
  packages/cave/src/performance.test.ts \
  packages/coven/src/performance.test.ts \
  packages/cli/src/performance.test.ts
node scripts/verify-performance.mjs
```

Expected: PASS.

## Task 10: Add Cross-Repository Fault Injection

**Files — Cave:**
- Create: `tests/client-v1-faults.spec.ts`

**Files — Chat:**
- Create: `tests/fault-injection.spec.ts`
- Modify: `scripts/run-cave-e2e.mjs`

**Files — SDK:**
- Create: `tests/live-authorities/faults.test.ts`

**Files — Coven:**
- Create: `crates/coven-client/tests/faults.rs`

- [ ] **Step 1: Implement `FAULT-001`–`FAULT-014` fixtures**

Cover Cave unavailable, slow readiness, crash during pairing/send, restart during stream, replay gap, 500, 429, revocation, incompatible version, corrupt discovery, keychain failure, cache disk-full simulation, and notification denial.

- [ ] **Step 2: Write assertions for honest terminal states**

No failure may become completed, no ambiguous send may replay automatically, and reconnect must refresh canonical revisions before enabling writes.

- [ ] **Step 3: Run fault suites**

```bash
# coven-cave
pnpm exec playwright test tests/client-v1-faults.spec.ts

# chat
pnpm test:e2e -- tests/fault-injection.spec.ts

# sdk
pnpm exec vitest run tests/live-authorities/faults.test.ts

# coven
cargo test -p opencoven-coven-client --test faults --locked
```

Expected: PASS without retries.

## Task 11: Add Artifact Privacy and Full Release Gates

**Files — Chat:**
- Create: `scripts/verify-diagnostics.mjs`
- Create: `scripts/verify-diagnostics.test.mjs`

**Files — SDK:**
- Create: `scripts/verify-secrets.mjs`
- Create: `scripts/verify-secrets.test.mjs`

- [ ] **Step 1: Write failing artifact scanners**

Scan logs, JSON/NDJSON, screenshots, videos, traces, crash diagnostics, tarballs, crates, examples, and completions for known test tokens, pairing secrets, prompts, and attachment signatures.

- [ ] **Step 2: Verify scanners catch seeded forbidden fixtures**

```bash
# chat
node --test scripts/verify-diagnostics.test.mjs

# sdk
node --test scripts/verify-secrets.test.mjs
```

- [ ] **Step 3: Remove sensitive collection at the source**

Do not rely on a final regex alone. Diagnostic builders accept allowlisted fields, and failure collectors sanitize before writing artifacts.

- [ ] **Step 4: Run complete release gates**

```bash
# coven-cave
pnpm lint
pnpm typecheck
pnpm check:tests-wired
pnpm test:app
pnpm test:api
pnpm test:mobile
pnpm build
pnpm exec playwright test
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib

# chat
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
node scripts/verify-bundle.mjs
node scripts/verify-performance.mjs
node scripts/verify-diagnostics.mjs

# sdk
pnpm typecheck
pnpm test
pnpm --recursive build
pnpm --recursive pack
node scripts/verify-contracts.mjs
node scripts/verify-package.mjs
node scripts/verify-secrets.mjs
node scripts/verify-performance.mjs
pnpm exec vitest run tests/live-authorities

# coven
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
python3 scripts/check-secrets.py
python3 scripts/check-coven-privacy.py --staged
```

Expected: all commands PASS without deterministic retry masking.

## Cross-Repository Merge Order

1. Cave and Coven authority hardening may merge in parallel.
2. SDK transport/CLI hardening after authority error and transport behavior is fixed.
3. Chat native/renderer fault and hostile-content hardening.
4. Chat accessibility fixes.
5. Performance budgets and corrections.
6. Cross-authority fault injection.
7. Artifact privacy and complete release gates.

## Exit Gates

- Every approved matrix row maps to a named executable test and evidence.
- Logs, screenshots, videos, traces, crash diagnostics, tarballs, crates, examples, and completions contain no credentials or private attachment bytes.
- Complete keyboard and screen-reader journeys pass with no traps or token-delta spam.
- All stated performance budgets pass with reference runner context and visible headroom.
- Faults remain explicit and do not trigger duplicate sends or success-shaped fallback.
- Full suites pass without deterministic retries.

## Bead Mapping

| Title | Type | Priority | Labels | Dependencies |
|---|---|---:|---|---|
| Phase 6: Security, accessibility, performance, and fault hardening | epic | P1 | `program:chat-v1,phase:6,cross-repo` | Phase 5 conformance |
| Cave Client v1: enforce ingress, storage, and mutation threat matrix | task | P1 | `repo:coven-cave,phase:6,security,faults` | Phase 4 conformance |
| Coven client: harden IPC discovery, ownership, cursors, and faults | task | P1 | `repo:coven,phase:6,rust-sdk,security` | Coven client extraction |
| SDK and CLI: harden secrets, arguments, transports, output, and scaffolds | task | P1 | `repo:sdk,phase:6,security,cli` | Cave and Coven hardening |
| Chat: close hostile-content, native-security, and fault journeys | task | P1 | `repo:chat,phase:6,security,faults` | Phase 5 conformance; Cave hardening |
| Chat: complete keyboard, screen-reader, contrast, and reduced-motion coverage | task | P1 | `repo:chat,phase:6,a11y` | Chat security/fault work |
| Integrated clients: enforce startup, scale, stream, bundle, and doctor budgets | task | P1 | `cross-repo,phase:6,performance` | SDK hardening; Chat accessibility |
| Phase 6: run full hardening and artifact privacy gates | task | P1 | `cross-repo,phase:6,release-gate` | all Phase 6 implementation beads |

