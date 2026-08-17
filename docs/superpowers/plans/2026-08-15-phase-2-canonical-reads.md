# Phase 2 Canonical Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display canonical familiars, permitted projects, unified conversations, search results, and selected transcripts in Chat while exposing equivalent bounded SDK/CLI reads for Cave and Coven.

**Architecture:** Cave projects stable client DTOs from its existing familiar, project-permission, session, and conversation authorities. Chat uses `@opencoven/cave-client` plus TanStack Query for replaceable in-memory server state; revision time, revision digest, and request generation prevent stale responses from winning. Coven session/event reads remain independent over `coven.daemon.v1`, and no client writes canonical records to browser storage.

**Tech Stack:** TypeScript 6.0.3, React 19.2.8, TanStack Query 5, Zod 4, Tauri 2.11.x, Rust `coven-client` 0.x, Vitest, Testing Library, Playwright.

**Depends on:** `2026-08-15-phase-1-discovery-pairing.md`

---

## File Map

### Cave repository

- Create `src/lib/server/client-v1/read-model.ts` and test.
- Create routes and colocated tests:
  - `src/app/api/client/v1/familiars/route.ts`
  - `src/app/api/client/v1/projects/route.ts`
  - `src/app/api/client/v1/commands/route.ts`
  - `src/app/api/client/v1/conversations/route.ts`
  - `src/app/api/client/v1/conversations/[id]/route.ts`
  - `src/app/api/client/v1/conversations/search/route.ts`
- Modify `src/app/api/sessions/list/route.ts`.
- Modify `src/app/api/api-contracts.test.ts`, `scripts/run-tests.mjs`, and generated contract files.

### Coven repository

- Modify `crates/coven-client/src/{models,http,lib}.rs`.
- Create `crates/coven-client/tests/{sessions,events}.rs`.
- Extend `crates/coven-client/fixtures/`.
- Modify `crates/coven-cli/src/tui/chat/client.rs`.

### SDK repository

- Modify `packages/cave/src/{client,schemas}.ts`.
- Modify `packages/coven/src/{client,schemas}.ts`.
- Create `packages/core/src/pagination.ts`.
- Modify `packages/cli/src/commands/{cave,coven}.ts`.
- Create `examples/coven-session-observer/*`.
- Create `examples/unified-status/*`.
- Add package, CLI golden, pagination, and packed-example tests.

### Chat repository

- Create styles:
  - `src/styles/{tokens,reset,shell,sidebar,thread,accessibility}.css`
- Create shell:
  - `src/components/shell/app-shell.tsx` and test.
- Create query state:
  - `src/lib/chat/{query-keys,query-client,cache-order}.ts` and tests.
- Create sidebar:
  - `src/components/sidebar/{familiar-filter,conversation-row,conversation-list,sidebar}.tsx`
  - `conversation-list.test.tsx`
- Create transcript:
  - `src/components/thread/{thread-header,message-list,basic-message}.tsx`
  - `thread.test.tsx`
- Modify `src/main.tsx` and `src/app.tsx`.
- Create `tests/canonical-reads.spec.ts`.

## Task 1: Characterize and Extract Cave's Canonical Session Projection

**Files:**
- Create Cave `read-model.ts` and test.
- Modify `src/app/api/sessions/list/route.ts`.

- [ ] **Step 1: Write characterization tests against the current private route**

Lock these behaviors before extraction:

- local conversation files and daemon sessions merge once;
- Cave conversation identity wins over harness-internal session identity;
- archived and pinned state comes from Cave session state;
- familiar attention and running/pending status remain visible;
- daemon failure retains local canonical conversations and marks degradation.

- [ ] **Step 2: Write the failing pure-projection test**

Test an exported dependency-injected function:

```ts
const result = await computeCanonicalSessionList({
  includeArchived: false,
  familiarId: null,
  loadDaemonSessions,
  loadLocalConversations,
  loadCaveState,
});
expect(result.items.map((item) => item.id)).toEqual(["conversation-1"]);
expect(result.degraded).toBe(false);
```

- [ ] **Step 3: Run existing and new tests**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/client-v1/read-model.test.ts \
  src/app/api/sessions/list/route.test.ts
```

Expected: the new test fails; existing route tests pass.

- [ ] **Step 4: Extract without changing the private route contract**

Move only the side-effect-free merge/projection logic. Keep request parsing,
private response shape, and route-specific caching in the private route.

- [ ] **Step 5: Repeat the focused tests**

Expected: all pass.

## Task 2: Define Stable Cave Read DTOs

**Files:** Cave `read-model.ts`, contract files, and test.

- [ ] **Step 1: Write failing DTO, revision, and redaction tests**

Use:

```ts
export type ClientConversationSummary = {
  id: string;
  familiarId: string;
  title: string;
  preview: string;
  projectId: string | null;
  projectRoot: string | null;
  status: "idle" | "running" | "failed" | "attention";
  pinned: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: string;
  revisionTime: number;
};
```

Test deterministic SHA-256 revision, `Date.parse(updatedAt)` revision time,
project grant filtering, root redaction, canonical familiar identity, explicit
degraded flags, and additive source fields ignored by the serializer.

- [ ] **Step 2: Write failing cursor tests**

Encode the final `(updatedAt,id)` tuple as base64url. Reject malformed cursors,
sort by descending `updatedAt` then stable `id`, and return no duplicates across
pages.

- [ ] **Step 3: Run the read-model test**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/lib/server/client-v1/read-model.test.ts
```

- [ ] **Step 4: Implement the DTO builders**

Reuse `loadConversation`, `listConversations`, `searchConversations`,
`loadVisibleFamiliarRoster`, `loadProjects`, `listAccessibleProjects`, project
permission filters, session state, and `SLASH_COMMANDS`. Do not expose private
route payloads or filesystem-only configuration.

- [ ] **Step 5: Run the read-model test**

Expected: pass.

## Task 3: Expose Cave Canonical Read Routes

**Files:** Cave client-v1 read routes/tests and contract artifacts.

- [ ] **Step 1: Write failing route tests**

Cover:

- bearer and `chat:read` enforcement;
- familiar roster projection;
- permitted projects only;
- safe standalone command projection;
- bounded conversation pages;
- detail pagination;
- search minimum length, cap, and cancellation-safe response;
- ETag equal to the returned canonical revision;
- 404, invalid cursor, degraded source, and malformed query envelopes.

- [ ] **Step 2: Run route tests**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/app/api/client/v1/familiars/route.test.ts \
  src/app/api/client/v1/projects/route.test.ts \
  src/app/api/client/v1/commands/route.test.ts \
  src/app/api/client/v1/conversations/route.test.ts \
  src/app/api/client/v1/conversations/[id]/route.test.ts \
  src/app/api/client/v1/conversations/search/route.test.ts
```

Expected: fail before implementation.

- [ ] **Step 3: Implement route adapters**

Every handler authorizes scope and delegates to `read-model.ts`. It does not
call another HTTP route, redirect to `/api/chat/*`, or expose the private route
shape.

- [ ] **Step 4: Regenerate the fixture**

```bash
node scripts/export-client-v1-contract.mjs
node scripts/export-client-v1-contract.mjs --check
```

- [ ] **Step 5: Run Cave read gates**

```bash
pnpm typecheck
pnpm test:api
pnpm check:tests-wired
```

Expected: pass.

## Task 4: Extend the Coven Rust Client for Sessions and Events

**Files:** Coven files from the File Map.

- [ ] **Step 1: Write failing session-response tests**

Test both documented current forms:

```json
[]
```

for a legacy request without pagination parameters, and:

```json
{ "sessions": [], "nextCursor": null }
```

for a paginated request. Preserve snake_case authority fields in raw models and
offer typed Rust accessors without changing daemon wire behavior.

- [ ] **Step 2: Write failing event-page tests**

Cover `sessionId`, `afterSeq`, `afterEventId`, limit 1–1000, `nextCursor`,
`hasMore`, ordered `seq`, structured error preservation, and additive fields.

- [ ] **Step 3: Run the crate tests**

```bash
cargo test -p coven-client --locked
```

Expected: fail before implementation.

- [ ] **Step 4: Implement constrained read methods**

Expose `list_sessions_page`, `get_session`, and `list_events_page`. Paths are
constructed from validated IDs and parameters; callers cannot submit arbitrary
paths or switch transports.

- [ ] **Step 5: Update CLI composition and run gates**

```bash
cargo test -p coven-client --locked
cargo test -p coven-cli --locked
cargo fmt --all -- --check
```

Expected: pass.

## Task 5: Add SDK Read Methods, Pagination, CLI Output, and Examples

**Files:** SDK files from the File Map.

- [ ] **Step 1: Write failing Cave schema/client tests**

Test additive fields, missing required fields, ETags, revisions, cursors,
degraded flags, request abort, and all read methods:

```ts
client.listFamiliars()
client.listProjects()
client.listCommands()
client.listConversations({ cursor, limit, familiarId, archived })
client.getConversation(id, { cursor, limit })
client.searchConversations(query, { cursor, limit })
```

- [ ] **Step 2: Write failing Coven client tests**

Test legacy arrays, paged sessions, paged events, capability checks, and
sequence checkpointing.

- [ ] **Step 3: Write failing pagination-helper tests**

Helpers return one page and explicit cursors by default. Iterators require an
explicit `maxPages` or caller abort signal; no method silently downloads an
unbounded collection.

- [ ] **Step 4: Write failing CLI golden tests**

Cover:

```text
opencoven cave familiars|projects|conversations
opencoven coven sessions|events
```

Human, JSON, and NDJSON output must preserve source-system errors and ignore
unknown additive authority fields.

- [ ] **Step 5: Run package tests**

```bash
pnpm --filter @opencoven/cave-client test
pnpm --filter @opencoven/coven-client test
pnpm --filter @opencoven/sdk-core test
pnpm --filter @opencoven/dev-cli test
```

Expected: fail before implementation.

- [ ] **Step 6: Implement clients and examples**

Examples import only packed public packages. `unified-status` keeps Cave and
Coven discovery, authentication, models, and errors separate.

- [ ] **Step 7: Run SDK gates**

```bash
pnpm typecheck
pnpm test
pnpm --recursive build
node scripts/verify-contracts.mjs
node scripts/verify-package.mjs
```

Expected: pass.

## Task 6: Build the Accessible Chat Shell

**Files:** Chat shell/style files from the File Map.

- [ ] **Step 1: Write failing accessibility tests**

Assert named navigation/main landmarks, skip link, visible focus, sidebar toggle
state, focus restoration, minimum 820px desktop layout, narrow collapse, and
reduced-motion behavior.

- [ ] **Step 2: Run the shell test**

```bash
pnpm test -- src/components/shell/app-shell.test.tsx
```

Expected: fail.

- [ ] **Step 3: Implement semantic Coven tokens and shell**

Port semantic vocabulary from Cave foundations, not Tailwind classes or private
components. The shell renders:

```tsx
<div className="app-shell">
  <a className="skip-link" href="#conversation">Skip to conversation</a>
  <aside aria-label="Conversations">{sidebar}</aside>
  <main id="conversation">{thread}</main>
</div>
```

- [ ] **Step 4: Run shell tests and build**

```bash
pnpm test -- src/components/shell/app-shell.test.tsx
pnpm build
```

Expected: pass.

## Task 7: Implement Canonical Query Ordering and Sidebar Reads

**Files:** Chat query/sidebar files from the File Map.

- [ ] **Step 1: Write failing ordering tests**

Test newer `revisionTime`, equal timestamp plus later request generation,
identical revision no-op, page deduplication, and stale delayed response
rejection.

- [ ] **Step 2: Write failing sidebar tests**

Cover All Chats default, familiar filters, pinned/recent/archived groups,
250 ms debounced search, abort of obsolete search, running/attention labels,
canonical familiar identity, cursor loading, selection preservation, arrow-key
navigation, and in-memory offline display.

- [ ] **Step 3: Run tests**

```bash
pnpm test -- \
  src/lib/chat/cache-order.test.ts \
  src/components/sidebar/conversation-list.test.tsx
```

Expected: fail.

- [ ] **Step 4: Implement query keys and ordering**

Use:

```ts
export const chatKeys = {
  familiars: ["familiars"] as const,
  projects: ["projects"] as const,
  conversations: (filter: ConversationFilter) => ["conversations", filter] as const,
  conversation: (id: string) => ["conversation", id] as const,
  search: (query: string) => ["conversation-search", query] as const,
};
```

TanStack Query is an in-memory replaceable cache. Do not persist canonical
messages or summaries in localStorage, IndexedDB, or browser files.

- [ ] **Step 5: Run sidebar gates**

```bash
pnpm test -- src/lib/chat src/components/sidebar
pnpm typecheck
```

Expected: pass.

## Task 8: Render the Canonical Basic Transcript

**Files:** Chat thread files from the File Map.

- [ ] **Step 1: Write failing transcript tests**

Cover canonical familiar identity in header and assistant turns, user and
assistant text, Markdown, code blocks, copy, long content, errors, loading,
empty, degraded, no-results, and in-memory offline states.

- [ ] **Step 2: Run tests**

```bash
pnpm test -- src/components/thread/thread.test.tsx
```

Expected: fail.

- [ ] **Step 3: Implement safe rendering**

Render Markdown with raw HTML disabled and sanitize output. The renderer uses
only `@opencoven/cave-client` DTOs and cannot fetch arbitrary attachment or
private-route URLs.

- [ ] **Step 4: Run thread and build gates**

```bash
pnpm test -- src/components/thread
pnpm typecheck
pnpm build
```

Expected: pass.

## Task 9: Verify Real Canonical Reads

**Files:** Chat `tests/canonical-reads.spec.ts`.

- [ ] **Step 1: Add required scenarios**

Pair and load, select All Chats, filter by familiar, search/cancel, receive a
stale delayed response, open a canonical transcript, lose Cave after a
successful read, paginate SDK results without duplicates, and read Coven
sessions/events through packed examples.

- [ ] **Step 2: Run browser E2E**

```bash
pnpm test:e2e -- tests/canonical-reads.spec.ts
```

Expected: pass against isolated real authorities.

## Validation Matrix

```bash
# Cave
pnpm typecheck
pnpm test:api
pnpm check:tests-wired
node scripts/export-client-v1-contract.mjs --check

# Coven
cargo test -p coven-client --locked
cargo test -p coven-cli --locked

# SDK
pnpm typecheck
pnpm test
pnpm --recursive build
node scripts/verify-package.mjs

# Chat
pnpm test -- src/lib/chat src/components/shell src/components/sidebar src/components/thread
pnpm typecheck
pnpm build
pnpm test:e2e -- tests/canonical-reads.spec.ts
```

## Cross-Repository Merge Order

1. Cave canonical projection and read routes.
2. Coven `coven-client` session/event pages.
3. SDK read clients, CLI commands, and packed examples.
4. Chat accessible shell and canonical query/sidebar reads.
5. Chat basic canonical transcript.
6. Real-authority read-only canary.

## Commit Checkpoints

1. Cave: `refactor(client-v1): extract canonical read model`
2. Cave: `feat(client-v1): expose canonical chat reads`
3. Coven: `feat(client): add session and event pagination`
4. SDK: `feat: add canonical read clients and commands`
5. Chat: `feat: add accessible canonical chat shell`
6. Chat: `feat: browse canonical familiar conversations`
7. Chat: `feat: render canonical conversation transcripts`
8. Chat E2E: `test: verify canonical reads against real authorities`

## Exit Gates

- No canonical conversation or message record is written to browser storage.
- Every visible row and assistant turn shows canonical familiar identity.
- Stale responses cannot replace newer revisions.
- Pagination/search produces no duplicates or unbounded collection loads.
- Keyboard-only navigation reaches search, filters, rows, header, and transcript.
- Real Cave/Coven read E2E and packed examples pass.
- No consumer calls Cave private routes or exposes an arbitrary HTTP client.

## Bead Mapping

| Bead | Title | Depends on |
|---|---|---|
| `chat-v1-p2` | Phase 2: deliver canonical read surfaces | Phase 1 E2E |
| `chat-v1-p2-cave-model` | Project canonical Cave client read models | Cave pairing boundary |
| `chat-v1-p2-cave-routes` | Expose paginated Cave canonical read routes | Cave model |
| `chat-v1-p2-coven-reads` | Add Coven session and event client reads | Coven baseline |
| `chat-v1-p2-sdk-reads` | Add SDK and CLI canonical read commands | Cave routes, Coven reads |
| `chat-v1-p2-chat-shell` | Build Chat canonical messaging shell | SDK reads |
| `chat-v1-p2-chat-transcript` | Render canonical Chat transcripts | Chat shell |
| `chat-v1-p2-live-e2e` | Verify real-authority canonical reads | SDK reads, Chat transcript |
