# Familiars Surface Integration Implementation Plan

**Design of record:** `docs/superpowers/specs/2026-09-02-familiars-integration-design.md`  
**Goal:** Move the Familiars Redesign v2 surface from mock data to canonical Cave data in stages ordered by what Cave can serve — reads, then send, then holds — and make it the production chat shell.  
**Architecture:** A typed `FamiliarsSource` seam behind `FamiliarsShell` with a Cave implementation over `QueryAdapter` and a mock implementation for the demo build and tests. Every new capability is one SDK transport method, one Tauri command, one capability permission, one guard entry, and re-cut lock files. Controls are gated on Cave-advertised capabilities.  
**Tech Stack:** Cave TypeScript 6/Node 24; SDK TypeScript 6/Zod 4; Chat React 19.2.8/Tauri 2.11/Rust; Vitest + Testing Library; Playwright; real-authority conformance harness.

## File Map

### Cave repository

- Modify: `src/app/api/client/v1/familiars/[id]/contract/route.ts` (new, promoted from `/api/familiars/[id]/contract`) and test
- Modify: `src/app/api/client/v1/familiars/[id]/analytics/route.ts` (new, promoted from `/api/familiars/[id]/execution-analytics`) and test
- Modify: contract report projection to include a parsed `ward` block and identity fields
- Modify: `contract-fixture.json` — capabilities `familiar-contract`, `familiar-analytics`; operations `familiars.contract.read`, `familiars.analytics.read`
- Stage 2–3: the Phase 3/4 routes as planned, plus `conversations` participants and `attention` list (see design)

### SDK repository

- Modify: `packages/cave-client` managed transport — `familiarContract`, `familiarAnalytics`; Stage 2–3 mutations
- Modify: `packages/sdk-core` `CAVE_CAPABILITIES` / `CAVE_OPERATIONS`
- Cut: new `*-0.1.x.tgz` tarballs and release manifest

### Chat repository

- Create: `src/familiars/source.ts` — `FamiliarsSource` interface and view types
- Create: `src/familiars/cave-source.ts` — `CaveFamiliarsSource` over `QueryAdapter`
- Create: `src/familiars/mock-source.ts` — wraps today's `src/demo/familiars-data.ts`
- Create: `src/familiars/mappers.ts` (+ test) — SDK types → view types
- Create: `src/familiars/capabilities.ts` (+ test) — capability set → control availability
- Move: `src/demo/familiars-{shell,messages,inspector,ui}.tsx` → `src/familiars/` (the demo route keeps importing them with the mock source)
- Modify: `src/lib/sdk/query-adapter.ts` — channels `familiarContract`, `familiarAnalytics`; Stage 2–3 mutations
- Modify: `src/lib/sdk/native-boundary.ts` — new commands in the managed transport
- Modify: `src-tauri/src/commands.rs`, `transport.rs` (`CaveReadPath` variants), `capabilities/default.json`
- Modify: `src/specification-guards.test.ts` — command table, permission list
- Modify: `contract-canary.lock.json`, `phase1-conformance.lock.json`, `vendor/opencoven-sdk/*.tgz`, `package.json`
- Modify: `src/app.tsx` — production route renders `FamiliarsShell` with `CaveFamiliarsSource`
- Delete (end of Stage 1): `src/chat-shell.tsx`, `src/chat-shell.css`, their tests
- Modify: `scripts/phase1-conformance.mjs` scenarios per stage

## Stage 1: Reads

### Task 1: Promote the Contract and Analytics Reads in Cave

**Files:** Cave `src/app/api/client/v1/familiars/[id]/{contract,analytics}/route.ts` and tests; contract projection; `contract-fixture.json`.

- [ ] **Step 1:** Write failing route tests: bearer required, `chat:read` scope, unknown familiar → 404 with the canonical error shape, id charset limits, no redirects, private cache headers.
- [ ] **Step 2:** Add the `ward` block to the contract projection, parsed from `ward.toml`: `version`, `protectedFiles`, `invariants`, `editablePaths`, `approvalTiers.auto`, `approvalTiers.humanReview`. Add `creature` and `person` from IDENTITY.md. Keep `report` unchanged.
- [ ] **Step 3:** Add a `days` series (last 7 / 14 days, `{ date, completed, failed }`) to the analytics window so the runs-per-day chart needs no client-side bucketing.
- [ ] **Step 4:** Implement both routes as thin projections of the existing private handlers; register capabilities `familiar-contract`, `familiar-analytics` and operations `familiars.contract.read`, `familiars.analytics.read` in the fixture.
- [ ] **Step 5:** Run the Cave client-v1 suite and the fixture digest test. Commit: `feat(client-v1): serve familiar contract and analytics`.

### Task 2: Add the SDK Managed-Transport Reads

**Files:** SDK `packages/cave-client/src/managed/*`, `packages/sdk-core/src/constants.ts`, tests, release manifest.

- [ ] **Step 1:** Write failing tests that `createCaveManagedCredentialTransport` exposes `familiarContract(id)` and `familiarAnalytics(id, { window, recentLimit })` and refuses when the capability is absent from health.
- [ ] **Step 2:** Implement against the promoted routes; add the capability and operation constants; regenerate `contract-fixture.json` consumers.
- [ ] **Step 3:** Cut tarballs; record sizes and sha256 for the Chat lock. Commit: `feat(cave-client): managed contract and analytics reads`.

### Task 3: Add the Chat Native Commands and Re-cut the Locks

**Files:** `src-tauri/src/commands.rs`, `src-tauri/src/transport.rs`, `src-tauri/capabilities/default.json`, `src/specification-guards.test.ts`, `vendor/opencoven-sdk/*.tgz`, `package.json`, `contract-canary.lock.json`, `phase1-conformance.lock.json`.

- [ ] **Step 1:** Extend the guard arrays first (commands `cave_get_familiar_contract`, `cave_get_familiar_analytics`; permissions `allow-cave-get-familiar-contract`, `allow-cave-get-familiar-analytics`) and watch the suite fail.
- [ ] **Step 2:** Add `CaveReadPath::FamiliarContract { id }` and `::FamiliarAnalytics { id, window, recent_limit }` with the same id charset and bound checks as conversations; add the two commands taking `handle` and `operation`.
- [ ] **Step 3:** Vendor the new tarballs; update `package.json` file deps; run `pnpm test:contract-canary` and re-pin; run `pnpm test:phase1-conformance` and re-pin the harness authority.
- [ ] **Step 4:** `cargo:clippy`, `cargo:test`, `pnpm test:unit`. Commit: `feat(native): familiar contract and analytics reads`.

### Task 4: Introduce the FamiliarsSource Seam

**Files:** `src/familiars/source.ts`, `mock-source.ts`, `cave-source.ts`, `mappers.ts` (+ tests), `src/lib/sdk/query-adapter.ts`, `src/lib/sdk/native-boundary.ts`.

- [ ] **Step 1:** Define the view types the shell already consumes (`FamiliarSummary`, `FamiliarDetail` with `ward`, `FamiliarActivity`, `ConversationSummary`, `ThreadMessage`) and the `FamiliarsSource` interface from the design.
- [ ] **Step 2:** Implement `MockFamiliarsSource` by wrapping `familiars-data.ts`; move `FAM_*` constants behind it. The 46 existing familiars tests must pass unchanged with the mock source injected.
- [ ] **Step 3:** Write mapper tests from SDK fixtures: `CaveCanonicalFamiliar` + contract → `FamiliarDetail`; `CaveExecutionWindow` + attempts → `FamiliarActivity` (completion = `successRate`, median = `medianDurationMs`, calls = `toolCalls`, recent = attempts, days = series); `CaveConversation` → `ConversationSummary` (`failed` from `exitCode`/`status`, `time` from `updatedAt`); messages → `ThreadMessage`.
- [ ] **Step 4:** Add `familiarContract` and `familiarAnalytics` channels to `QueryAdapter` (detail TTL) and the managed-transport methods to `native-boundary.ts`. Implement `CaveFamiliarsSource`.
- [ ] **Step 5:** Implement `capabilities.ts`: `availabilityFor(capabilities)` → per-control `{ enabled, reason }`; test every row of the design's table. Commit: `feat(familiars): data-source seam and mappers`.

### Task 5: Run the Shell on Real Reads

**Files:** `src/familiars/*.tsx` (moved), `src/main.tsx`, `src/app.tsx`, `src/demo/familiars-*` (thin re-exports).

- [ ] **Step 1:** Move the shell modules to `src/familiars/`; `FamiliarsShell` takes `source: FamiliarsSource` and `connection: SdkConnectionState`. The demo route passes the mock source; nothing under `src/demo/` is imported by the production path.
- [ ] **Step 2:** Replace module constants with source reads; render `QueryResult` states per the design (skeletons, stale, reconcile, error). Preview text: page 1 of messages lazily, or `lastMessagePreview` when Cave adds it.
- [ ] **Step 3:** Gate controls on `availabilityFor`: composer send, held actions, summon, screen, and the Activity/Access tabs render their disabled states with reasons when a capability is absent.
- [ ] **Step 4:** Move the auth-repair affordances (`unauthorized`, `credential_unavailable`, `credential_update_in_progress`) from `ChatShell` into the inspector footer.
- [ ] **Step 5:** `src/app.tsx`: the connected production app renders `FamiliarsShell` with `CaveFamiliarsSource`; keep `ConnectionGate` as the blocking gate. Commit: `feat(familiars): production route on canonical reads`.

### Task 6: Reach Parity and Retire ChatShell

- [ ] **Step 1:** Enumerate `chat-shell.test.tsx` and `app.test.tsx` behaviours (pagination, load-more, canonical identity on every row, stale-response ordering, keyboard reach) and port each assertion to the familiars suites against `CaveFamiliarsSource` with the Tauri mock boundary.
- [ ] **Step 2:** Delete `src/chat-shell.tsx`, `src/chat-shell.css`, and their tests; update README's production-route description. Commit: `refactor: retire ChatShell`.

### Task 7: Verify Stage 1 Against Real Authority

- [ ] **Step 1:** Add conformance scenarios: contract and analytics reads for every listed familiar; a familiar without `ward.toml`; an instance without the new capabilities (controls disabled, no errors).
- [ ] **Step 2:** `pnpm test`, `pnpm test:e2e`, `pnpm test:native-e2e`, `pnpm test:phase1-conformance`, `pnpm test:contract-canary`; re-pin locks; PR with evidence.

## Stage 2: Send and Mentions (after Phase 3 gate `cave-e1kfa`)

### Task 8: Contract asks

- [ ] `messages.send` accepts `mentions: familiarId[]`; conversations carry `participants[]`; messages carry `authorFamiliarId?`; `commands.list` returns `{ name, hint, tier }` with tier derived from the ward. Land in Cave and SDK with the Phase 3 tarball cut.

### Task 9: Chat send loop

- [ ] Native `cave_send_message`, `cave_stop_run`, `cave_retry_run`, `cave_stream_run` (mutating, idempotency key generated in Rust); permissions; guards; locks.
- [ ] `FamiliarsSource.send` with optimistic pending bubble reconciled to the canonical id; stream reduction into the familiar bubble; stop button state; retry on the failed-run row.
- [ ] `@`-mention menu lists `participants`-eligible familiars from the roster; sends `mentions`; guest bubbles render from `authorFamiliarId`; participant chips from `participants`.
- [ ] Commands list from `commands.list`; the must-ask warning from the contract's `humanReview` list.
- [ ] Conformance: send, mention, stop, retry, disconnect, resume, reconcile.

## Stage 3: Holds and Rich Content (after Phase 4 gate `cave-gylsl`)

### Task 10: Contract asks

- [ ] `attention.list` (open items with conversation, familiar, title, detail, facts, openedAt, expiresAt, state) and SSE `attention.opened` / `attention.resolved`; `respond` takes `decision` and an idempotency key. Rich-content AST tool-call nodes carry tool name, duration, and failure.

### Task 11: Chat holds

- [ ] Native `cave_list_attention`, `cave_respond_attention`; permissions; guards; locks.
- [ ] `FamiliarsSource.attention` channel drives "Needs you", the `held` mark on conversations, the switcher counts, and the held-action card; `respond` with disabled-until-acknowledged and the approved / declined / expired afterlives; `⌘⏎` / `⌘⌫` only with an open item in the active conversation.
- [ ] Reasoning cards from AST tool-call nodes (fold rule unchanged); image cards from attachments via `attachments.read`; the lightbox shows bytes, not a plot.
- [ ] Conformance: open, approve, decline, expire, replay of a decision.

## Stage 4: Summon and Screen (new contracts)

### Task 12: Design specs first

- [ ] `docs/superpowers/specs/…-familiar-creation-design.md`: `familiars.templates.list`, `familiars.create` (scope `familiars:write`, `confirmed: true`), server-side templates scaffolding SOUL.md / IDENTITY.md / ward.toml / MEMORY.md, name uniqueness, audit.
- [ ] `docs/superpowers/specs/…-familiar-screen-design.md`: Coven session screen frames over the event stream, capability `screen`, consent, loopback-only, no persistence, visible recording state.
- [ ] Until both are approved, `summon` and `screen` are enabled only under `MockFamiliarsSource`; the production gate renders them disabled with "not available in this release".

## Validation Matrix

```
# Cave (per stage)
pnpm exec vitest run src/app/api/client/v1/**  &&  fixture digest test
# SDK (per stage)
pnpm exec vitest run packages/cave-client packages/sdk-core  &&  pack + manifest
# Chat
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test            # normal + heavy
pnpm test:e2e && pnpm test:native-e2e
pnpm test:contract-canary && pnpm test:phase1-conformance
pnpm cargo:clippy && pnpm cargo:test
pnpm app:build && pnpm app:build:demo   # both bundles from the same components
```

## Cross-Repository Merge Order

1. Cave: promoted reads and fixture (Task 1).
2. SDK: managed reads and tarballs (Task 2).
3. Chat: native commands, locks, seam, shell, retirement (Tasks 3–7).
4. Stage 2 after the Phase 3 gate; Stage 3 after the Phase 4 gate; Stage 4 after its specs.

## Commit Checkpoints

1. Cave: `feat(client-v1): serve familiar contract and analytics`
2. SDK: `feat(cave-client): managed contract and analytics reads`
3. Chat: `feat(native): familiar contract and analytics reads`
4. Chat: `feat(familiars): data-source seam and mappers`
5. Chat: `feat(familiars): production route on canonical reads`
6. Chat: `refactor: retire ChatShell`
7. Chat: `test(conformance): familiar reads against real authority`

## Exit Gates

- No mock value is reachable on the production route; `src/demo/` is not imported by it.
- Every control is capability-gated and its disabled state is tested.
- Contract and analytics reads pass conformance for every listed familiar, including one without `ward.toml` and one instance without the capabilities.
- The command table, permission list, and both lock files match the shipped SDK and native surface.
- The demo build still passes its smoke test from the same components.
- `ChatShell` is deleted and README describes the production route.

## Bead Mapping

| Bead | Title | Depends on |
|---|---|---|
| `chat-v1-fam-contract-read` | Serve familiar contract with ward block in client-v1 | Phase 2 gate |
| `chat-v1-fam-analytics-read` | Serve familiar analytics with days series in client-v1 | Phase 2 gate |
| `chat-v1-fam-sdk-reads` | Managed-transport contract and analytics reads | Cave reads |
| `chat-v1-fam-native-reads` | Chat native commands, permissions, guards, locks | SDK reads |
| `chat-v1-fam-source` | FamiliarsSource seam, mappers, capability gating | Native reads |
| `chat-v1-fam-shell-reads` | Familiars shell on canonical reads; retire ChatShell | Source |
| `chat-v1-fam-reads-e2e` | Stage 1 real-authority conformance | Shell reads |
| `chat-v1-fam-send` | Send, stream, stop, retry, mentions in the familiars shell | Phase 3 gate |
| `chat-v1-fam-holds` | Attention list, held actions, rich content | Phase 4 gate |
| `chat-v1-fam-summon-design` | Familiar creation contract design | — |
| `chat-v1-fam-screen-design` | Familiar screen contract design | — |
