# Phase 3 Send, Stream, and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the canonical create → send → stream → stop → retry → disconnect → resume → reconcile journey without duplicate execution.

**Architecture:** Cave owns persistent idempotency, canonical conversation mutations, harness execution, stop semantics, and stream replay. The client-v1 facade delegates to the existing send pipeline and `chat-stream-buffer`; it does not create a second executor or buffer. Chat generates one operation UUID per explicit action, reduces monotonic stream events, never automatically replays an ambiguous send, and reloads canonical history after a replay gap. TypeScript packages remain transport-neutral; the owner-adjacent Chat Rust `cave-client` crate remains `0.x` and exposes constrained client-v1 operations rather than arbitrary HTTP.

**Tech Stack:** Cave TypeScript 6.0.3/Node 24; SDK TypeScript 6.0.3/Zod 4; Chat React 19.2.8/TanStack Query/Tauri 2.11.x/Rust; SSE; OS-keychain-backed AES-256-GCM drafts; Vitest, Node tests, Cargo tests, Playwright.

**Depends on:** `2026-08-15-phase-2-canonical-reads.md`

---

## File Map

### Cave repository

- Create `src/lib/server/client-v1/idempotency-store.ts` and test.
- Create `src/lib/server/client-v1/chat-service.ts` and test.
- Create `src/lib/server/client-v1/sse.ts` and test.
- Create `src/lib/server/chat-send-service.ts` and characterization test.
- Create `src/lib/server/conversation-create.ts` and test.
- Modify `src/lib/server/voice-chat-create.ts`.
- Modify `src/app/api/chat/send/route.ts`.
- Create/modify client-v1 routes and colocated tests:
  - `conversations`
  - `conversations/[id]`
  - `messages/send`
  - `runs/[id]/stream`
  - `runs/[id]/stop`
  - `runs/[id]/retry`
- Modify `scripts/run-tests.mjs` and generated contract artifacts.

### SDK repository

- Modify `packages/cave/src/{client,schemas}.ts`.
- Create `packages/cave/src/stream.ts`.
- Modify `packages/cli/src/commands/cave.ts`.
- Create `examples/cave-chat/*`.
- Create shared stream-conformance fixtures/tests.

### Chat repository

- Create `src/components/thread/new-conversation.tsx` and test.
- Create `src/lib/chat/{stream-reducer,stream-controller,draft-store,slash-commands}.ts` and tests.
- Create `src/components/thread/{composer,streaming-message}.tsx` and tests.
- Modify `src/components/thread/message-list.tsx`.
- Create `src-tauri/src/{secure_store,drafts}.rs`.
- Create owner-adjacent crate:
  - `src-tauri/crates/cave-client/Cargo.toml` version `0.1.0`
  - `src-tauri/crates/cave-client/src/{lib,error,http,sse,types}.rs`
- Modify `src-tauri/Cargo.toml`.
- Modify `src-tauri/src/{lib,transport,commands}.rs`.
- Create:
  - `tests/send-stream-resume.spec.ts`
  - `tests/idempotency.spec.ts`
  - `tests/offline-reconcile.spec.ts`

## Task 1: Implement Persistent Cave Mutation Idempotency

**Files:**
- Cave `idempotency-store.ts` and test.
- Modify `scripts/run-tests.mjs`.

- [ ] **Step 1: Write failing claim/replay/conflict tests**

Use:

```ts
const first = await claimOperation({
  key,
  credentialId: "client-a",
  route: "messages/send",
  requestHash: "aaa",
});
expect(first.kind).toBe("claimed");

await completeOperation(key, {
  status: 202,
  body: { ok: true, runId: "run-1", conversationId: "conversation-1" },
});

expect((await claimOperation(sameInput)).kind).toBe("replay");
expect((await claimOperation({ ...sameInput, requestHash: "bbb" })).kind).toBe("conflict");
```

- [ ] **Step 2: Write failing restart, expiry, and privacy tests**

Reload the store module from disk. Completed results survive restart for 24
hours; abandoned in-progress claims become retryable after ten minutes. The
ledger must not contain prompt text, attachment names, attachment bytes, or
bearer tokens.

- [ ] **Step 3: Run the test**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/lib/server/client-v1/idempotency-store.test.ts
```

Expected: fail.

- [ ] **Step 4: Implement the atomic ledger**

Persist:

```ts
type ClientOperation = {
  key: string;
  credentialId: string;
  route: string;
  requestHash: string;
  status: "in_progress" | "completed";
  createdAt: number;
  updatedAt: number;
  result?: { status: number; body: Record<string, unknown> };
};
```

Hash normalized request bodies before claiming. Serialize writers through one
promise queue and use atomic replacement.

- [ ] **Step 5: Run the focused and wiring tests**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/lib/server/client-v1/idempotency-store.test.ts
pnpm check:tests-wired
```

Expected: pass.

## Task 2: Add Generic Canonical Conversation Creation

**Files:**
- Cave `conversation-create.ts` and test.
- Modify `voice-chat-create.ts`.
- Create/modify client-v1 conversation routes and `chat-service.ts`.

- [ ] **Step 1: Write failing generic creation tests**

Test valid familiar/project grants, unknown familiar, invalid project, denied
grant, atomic save failure, title ownership, and:

```ts
expect(created.conversation.origin).toBe("chat");
expect(created.conversation.runtime).toBe(`local:${projectRoot}`);
```

- [ ] **Step 2: Write voice-regression tests**

Existing voice creation must continue to produce `origin: "call"`. Do not call
`createVoiceChatSession` directly for typed Chat creation.

- [ ] **Step 3: Run tests**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/conversation-create.test.ts \
  src/lib/server/voice-chat-create.test.ts \
  src/lib/server/client-v1/chat-service.test.ts
```

Expected: fail before implementation.

- [ ] **Step 4: Implement generic creation and delegation**

The generic service accepts explicit origin, familiar, project root, harness
binding, title ownership, and persistence dependencies. Voice delegates with
`call`; client-v1 delegates with `chat`.

- [ ] **Step 5: Implement canonical presentation mutations**

Rename uses Cave title ownership. Pin/archive/unarchive use Cave session state,
not `ConversationFile`. Delete uses canonical conversation deletion plus the
same sacrifice/unlink behavior as existing Cave user deletion.

- [ ] **Step 6: Add idempotency to every mutation route**

Identical credential/route/key/body replays the result. Reusing the key with a
different request hash returns `409 conflict`.

- [ ] **Step 7: Run service and route tests**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/conversation-create.test.ts \
  src/lib/server/client-v1/chat-service.test.ts \
  src/app/api/client/v1/conversations/route.test.ts \
  src/app/api/client/v1/conversations/[id]/route.test.ts
```

Expected: pass.

## Task 3: Characterize and Extract the Existing Cave Send Pipeline

**Files:**
- Create Cave `chat-send-service.ts` and characterization test.
- Modify private `src/app/api/chat/send/route.ts`.

- [ ] **Step 1: Write characterization tests before moving code**

Lock request validation, response status/headers, initial session event,
progress/tool/text ordering, terminal event, stub persistence, stop behavior,
and one representative direct runtime path.

- [ ] **Step 2: Run characterization plus current send tests**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/chat-send-service.test.ts \
  src/app/api/chat/send/route-body-validation.test.ts \
  src/app/api/chat/send/chat-send-capabilities.test.ts
```

Expected: the new characterization import fails; existing tests pass.

- [ ] **Step 3: Rehome the current implementation as one behavior-preserving move**

Export:

```ts
export async function executeChatSend(req: Request): Promise<Response>;
```

The private route retains `dynamic`, `runtime`, and:

```ts
export async function POST(req: Request): Promise<Response> {
  return executeChatSend(req);
}
```

Adjust imports explicitly. Do not rewrite harness routing, persistence, or
stream semantics during extraction.

- [ ] **Step 4: Run all existing send suites**

```bash
pnpm test:api
```

Expected: pass with unchanged private-route behavior.

## Task 4: Add Typed Client-v1 Send and Resumable SSE

**Files:**
- Cave `client-v1/sse.ts` and tests.
- Client-v1 send/run routes and tests.

- [ ] **Step 1: Write failing translation tests**

Translate current `StreamEvent` variants:

```ts
type ClientStreamEvent =
  | { type: "run.started"; runId: string; conversationId: string }
  | { type: "message.delta"; text: string }
  | {
      type: "progress";
      id: string;
      label: string;
      detail?: string;
      status: "pending" | "running" | "done" | "error";
    }
  | { type: "tool"; payload: ToolEvent }
  | { type: "run.completed"; conversationId: string }
  | { type: "run.failed"; code: string; message: string }
  | { type: "reconcile_required"; conversationId: string };
```

Test the same translator for initial and resumed streams.

- [ ] **Step 2: Write failing replay tests**

Cover numeric strictly increasing IDs, duplicate cursor no-op, replay only
`seq > cursor`, completed-buffer replay, heartbeat, unknown run, and an evicted
gap translated to `reconcile_required` rather than the private route's benign
progress event.

- [ ] **Step 3: Write failing send/stop/retry tests**

Test operation claim before execution, duplicate attach metadata, same-key
changed-body conflict, stop through `requestChatStop`, retry only for a
persisted failed/cancelled assistant turn, new operation UUID, and
`retryOfTurnId`.

- [ ] **Step 4: Run focused tests**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/client-v1/sse.test.ts \
  src/app/api/client/v1/messages/send/route.test.ts \
  src/app/api/client/v1/runs/[id]/stream/route.test.ts \
  src/app/api/client/v1/runs/[id]/stop/route.test.ts \
  src/app/api/client/v1/runs/[id]/retry/route.test.ts
```

Expected: fail before implementation.

- [ ] **Step 5: Implement the facade**

Send accepts:

```ts
type ClientSendInput = {
  operationId: string;
  conversationId: string;
  familiarId: string;
  prompt: string;
  attachmentIds: string[];
  projectRoot: string | null;
  model?: string;
  harness?: string;
  retryOfTurnId?: string;
};
```

Map it to `executeChatSend`. Do not expose private request fields or add a
second buffer. An identical in-progress send returns `409 conflict` with
string details for `runId`, `conversationId`, and `resumePath`; it does not add
an unapproved error code.

- [ ] **Step 6: Regenerate contract artifacts and run Cave gates**

```bash
node scripts/export-client-v1-contract.mjs
node scripts/export-client-v1-contract.mjs --check
pnpm typecheck
pnpm test:api
pnpm check:tests-wired
```

Expected: pass.

## Task 5: Add SDK Conversation and Streaming APIs

**Files:** SDK Cave stream/client/schema, CLI, example, and conformance files.

- [ ] **Step 1: Write failing client tests**

Cover `createConversation`, `patchConversation`, `deleteConversation`, `send`,
`stream`, `stop`, and `retry`. Mutation methods generate a UUID unless supplied
and return the operation ID on success and error.

- [ ] **Step 2: Write failing async-iterator tests**

Test initial stream, resume cursor, duplicate suppression, abort closes the
transport, terminal completion, failed run, reconciliation, and no send replay
after ambiguous transport completion.

- [ ] **Step 3: Write failing CLI golden tests**

Cover:

```text
opencoven cave send
opencoven cave tail
opencoven cave tail --json
opencoven cave tail --ndjson
```

NDJSON emits exactly one object per accepted event.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @opencoven/cave-client test
pnpm --filter @opencoven/dev-cli test
```

Expected: fail before implementation.

- [ ] **Step 5: Implement constrained stream transport**

The transport exposes fixed send/resume operations, not arbitrary URLs or raw
private routes. Abort closes only the current read; it never retries the send.

- [ ] **Step 6: Implement and pack the example**

`examples/cave-chat` imports packed `@opencoven/cave-client`, pairs through an
injected secret store, creates a conversation, sends, checkpoints IDs, resumes,
and reconciles.

- [ ] **Step 7: Run SDK gates**

```bash
pnpm typecheck
pnpm test
pnpm --recursive build
node scripts/verify-contracts.mjs
node scripts/verify-package.mjs
```

Expected: pass.

## Task 6: Implement Chat New Conversation and Composer Behavior

**Files:** Chat `new-conversation`, `composer`, draft, slash-command, and native secure-store files.

- [ ] **Step 1: Write failing new-conversation tests**

Cover familiar selection, permitted project selection, grant error, one
idempotency UUID, canonical returned ID selection, no local conversation row,
and repeated response replay.

- [ ] **Step 2: Write failing composer tests**

Cover Enter send, Shift+Enter newline, empty prompt, one operation UUID per
explicit action, double-click suppression, send/stop state, offline disabled
writes, retry with a fresh UUID plus `retryOfTurnId`, and commands only from
Cave's command projection.

- [ ] **Step 3: Write failing encrypted-draft tests**

Test AES-256-GCM round trip, random nonce, tamper rejection, keychain-generated
master key, atomic replacement, per-conversation keys, deletion after accepted
send, and absence of plaintext in browser storage and file bytes.

- [ ] **Step 4: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml secure_store
cargo test --manifest-path src-tauri/Cargo.toml drafts
pnpm test -- \
  src/components/thread/new-conversation.test.tsx \
  src/components/thread/composer.test.tsx \
  src/lib/chat/draft-store.test.ts \
  src/lib/chat/slash-commands.test.ts
```

Expected: fail.

- [ ] **Step 5: Implement UI and native draft storage**

Raw drafts may enter the webview while edited, but never localStorage or the
canonical read cache. Clear a draft only after Cave accepts the operation.

- [ ] **Step 6: Run component/native gates**

Repeat Step 4.

Expected: pass.

## Task 7: Implement Chat Stream Reduction and Recovery

**Files:** Chat stream reducer/controller/streaming-message files.

- [ ] **Step 1: Write failing reducer tests**

Cover monotonic cursor acceptance, duplicate ID no-op, text concatenation,
progress/tool replacement by ID, completion, failure, interruption, retained
partial text, and reconciliation.

- [ ] **Step 2: Write failing controller tests**

The controller:

1. starts a send exactly once;
2. checkpoints every accepted ID;
3. resumes with the last accepted cursor;
4. attaches to conflict-provided run metadata;
5. performs canonical reload after `reconcile_required` or terminal completion;
6. never automatically re-POSTs a send.

- [ ] **Step 3: Run tests**

```bash
pnpm test -- \
  src/lib/chat/stream-reducer.test.ts \
  src/lib/chat/stream-controller.test.ts
```

Expected: fail.

- [ ] **Step 4: Implement reduction and bounded reconnect**

Use deterministic jitter in tests. Preserve partial assistant text on
interruption and represent transport failure as interrupted, never completed.

- [ ] **Step 5: Run Chat messaging gates**

```bash
pnpm test -- src/lib/chat src/components/thread
pnpm typecheck
pnpm build
```

Expected: pass.

## Task 8: Extract the Owner-Adjacent Chat Rust Cave Client

**Files:** Chat `src-tauri/crates/cave-client/*` and Tauri glue files.

- [ ] **Step 1: Write crate-level conformance tests**

Use the same health/error/send/stream fixtures as the TypeScript package. Test
fixed client-v1 paths, body/frame caps, redirects disabled, numeric SSE IDs,
abort, and additive fields.

- [ ] **Step 2: Create the `0.1.0` crate**

The crate owns schemas, constrained HTTP, and SSE parsing. It does not own the
OS keychain, Tauri commands, app lifecycle, or arbitrary request APIs.

- [ ] **Step 3: Replace Tauri-local request/stream parsing**

`src-tauri/src/transport.rs` becomes app composition around the crate.
Credential lookup remains in Chat Rust and the bearer never enters the webview.

- [ ] **Step 4: Run Rust gates**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: pass.

## Task 9: Verify the Complete Real Chat Loop

**Files:** Chat Phase 3 E2E files from the File Map.

- [ ] **Step 1: Add send/resume scenarios**

Create a conversation, receive the first response, send in an existing
conversation, drop transport after deltas, resume from the cursor, inject a
duplicate ID, evict replay history, and reconcile canonical history.

- [ ] **Step 2: Add idempotency and recovery scenarios**

Double-click Send, retry the HTTP request with the same key, reuse the key with
different text, kill/restart Cave mid-run, stop a run, retry a failed turn,
abort an SDK iterator, and pipe CLI NDJSON.

- [ ] **Step 3: Assert canonical outcomes**

One accepted send produces exactly one canonical user turn and one assistant
turn. Ambiguous completion never creates another execution.

- [ ] **Step 4: Run E2E**

```bash
pnpm test:e2e -- \
  tests/send-stream-resume.spec.ts \
  tests/idempotency.spec.ts \
  tests/offline-reconcile.spec.ts
```

Expected: pass against real isolated Cave and packed SDK/CLI artifacts.

## Validation Matrix

```bash
# Cave
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
pnpm test -- src/lib/chat src/components/thread
pnpm typecheck
pnpm build
pnpm test:e2e -- \
  tests/send-stream-resume.spec.ts \
  tests/idempotency.spec.ts \
  tests/offline-reconcile.spec.ts
```

## Cross-Repository Merge Order

1. Cave persistent idempotency.
2. Cave generic typed-chat creation and canonical conversation mutations.
3. Cave behavior-preserving send extraction.
4. Cave typed send/stream/stop/retry facade.
5. SDK conversation/stream clients, CLI, and packed example.
6. Chat conversation/composer/draft behavior.
7. Chat duplicate-safe stream recovery.
8. Chat owner-adjacent Rust `cave-client` extraction.
9. Real-authority complete-loop canary.

## Commit Checkpoints

1. Cave: `feat(client-v1): persist mutation idempotency`
2. Cave: `feat(client-v1): add canonical conversation mutations`
3. Cave: `refactor(chat): extract send service`
4. Cave: `feat(client-v1): expose resumable chat execution`
5. SDK: `feat: add Cave send and stream clients`
6. Chat: `feat: create canonical conversations`
7. Chat: `feat: send and resume familiar messages`
8. Chat Rust: `refactor: extract native Cave client crate`
9. Chat E2E: `test: verify duplicate-safe chat lifecycle`

## Exit Gates

- Pair → read → create → send → disconnect → resume → complete passes against real Cave.
- Double-click and same-key transport retry execute exactly once.
- Same key with a changed body returns conflict.
- Ambiguous completion never triggers automatic resend.
- Stop preserves partial text and canonical cancelled status.
- Retry is a fresh explicit operation tied to the original failed turn.
- Existing Cave private send/stream/stop suites remain green.
- TypeScript and Rust clients pass the same stream conformance fixtures.
- No client exposes private Cave routes, raw bearer access, or arbitrary HTTP.

## Bead Mapping

| Bead | Title | Depends on |
|---|---|---|
| `chat-v1-p3` | Phase 3: deliver duplicate-safe chat execution | Phase 2 E2E |
| `chat-v1-p3-idempotency` | Persist Cave client mutation idempotency | Cave read routes |
| `chat-v1-p3-conversations` | Expose canonical conversation mutations | Idempotency |
| `chat-v1-p3-send-service` | Extract Cave send service without behavior drift | Idempotency |
| `chat-v1-p3-stream-facade` | Expose resumable Cave client streams | Conversation mutations, send service |
| `chat-v1-p3-sdk-streams` | Add SDK send stream and tail clients | Stream facade |
| `chat-v1-p3-chat-recovery` | Implement Chat duplicate-safe stream recovery | SDK streams |
| `chat-v1-p3-rust-client` | Extract reusable Chat Rust Cave client | Chat recovery |
| `chat-v1-p3-live-e2e` | Verify duplicate-safe complete chat loop | SDK streams, Chat recovery, Rust client |
