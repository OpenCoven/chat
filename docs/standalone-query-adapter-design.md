# Standalone QueryAdapter design

Status: **draft for approval — no implementation code written against it yet**
Target: `v0.0.1`, release blocker "standalone chat, Cave optional"
Author lane: Kitty (coordination)

---

## 1. Problem

The production app is read-only and **blocks entry until Cave is available**.

`src/app.tsx` renders `<ConnectionGate>` and only reaches `<ChatShell>` once a
Cave connection controller reports `state === 'ready'`. Without Tauri it renders
`BROWSER_PREVIEW_STATE` and nothing else. There is no composer anywhere in
`src/chat-shell.tsx` — no `textarea`, no send handler. Every datum is a read
through `createQueryAdapter` against a `CaveReadClient`.

For v0.0.1 the app must be **standalone-first**: usable with no Cave at all,
persisting conversations locally across restarts, and able to create real
messages. Cave becomes an optional enhancement.

---

## 2. Constraints discovered (evidence, not assumption)

These are load-bearing. Each one is checked against the tree at `a57cc26`.

### C1 — Cave Client v1 has no write operation

`node_modules/@opencoven/sdk-core/dist/index.d.ts:6` declares the complete
operation set:

```
health.read, pairing.create, pairing.poll, pairing.exchange,
pairing.admin.list, pairing.admin.decide, credentials.admin.list,
credentials.admin.revoke, familiars.list, projects.list,
conversations.list, conversations.read, messages.list
```

There is no `messages.create`. `CaveReadClient`
(`src/lib/sdk/connection-controller.ts:34-41`) is `Pick<CaveClient, 'listFamiliars' |
'listProjects' | 'listConversations' | 'getConversation' | 'listConversationMessages'>`.

**Consequence:** writes can never be routed to Cave in v0.0.1. Any design that
puts write methods on the shared `QueryAdapter` type produces a Cave
implementation that can only satisfy them by throwing. We will not do that.

### C2 — `installationId` is a Cave-pairing input, not an app prerequisite

`src/app.tsx` blocks the whole app on `useInstallationBootstrap`. But the value
is consumed in exactly one place — `defaultControllerFactory` passes it as
`pairingIdentity.installationId`. It is not used by `ChatShell`, and not used by
any read.

**Consequence:** `installation_unavailable` must demote from "app cannot start"
to "Cave pairing unavailable". This is the single highest-value change in the
gate demotion, and it is provably safe.

### C3 — `ChatShell` is coupled to the `QueryAdapter` *type*, not to Cave

`src/chat-shell.tsx:230` takes `{ queryAdapter, onReconcile, onForgetCredential }`.
It maps `QueryResult` → its own view state in `toListState` /
`toRootListState`. It never imports the Cave client or the controller. Its
domain types (`CaveConversation`, `CaveConversationMessage`, `CaveProject`,
`CaveCanonicalFamiliar`) are structural interfaces.

**Consequence:** if a local implementation satisfies the existing `QueryAdapter`
interface and returns the same domain shapes, `ChatShell` renders local data
**with no changes to its read path**. This is the cheapest correct route and it
is the one this design takes.

### C4 — Pagination has a strict, testable cursor contract

`src/lib/sdk/manual-page-walk.ts:22-55` enforces:

- follow-up page: `page.cursor.current` **must equal exactly** the requested cursor
- root page: `current` may be `undefined`, `null`, or a non-empty string
- when `hasMore`: `next` must be a non-empty string, `!== current`, and **never
  previously seen in the walk** (cursor reuse aborts the walk)
- hard ceiling of `MAX_MANUAL_PAGE_WALK_PAGES` pages

**Consequence:** the local cursor must echo `current` verbatim and must be
strictly forward-moving. Offset cursors that can repeat a value are unsafe.
Keyset cursors are the correct choice.

### C5 — The conformance lock pins Rust and scripts, not the web layer

`phase1-conformance.lock.json` `chatAuthority.files` pins only `src-tauri/**`
(`Cargo.toml`, `Cargo.lock`, `src/bin/phase1-native-rpc.rs`, `conformance.rs`,
`coven.rs`, `keyring.rs`, `lib.rs`). `harnessAuthority.files` pins `scripts/**`
plus `.github/workflows/ci.yml` and `client-v1-conformance.yml`.

`src/**` (except as it is exercised by tests) is **not** hash-pinned.

**Consequence:** this lane can freely change `src/`, and must not touch
`src-tauri/`, `scripts/`, or workflows. `APP_PHASE` is duplicated in
`src-tauri/src/metadata.rs:5` as `"phase-1-read-only-production"` — that string
is inside a lock-pinned file, so **this lane does not change it**; see §9.

---

## 3. Core decision: three ports, not one

We introduce **three** narrow ports and keep the existing `QueryAdapter`
interface byte-identical.

```
                 ┌─────────────────────────────┐
                 │        ChatShell (UI)       │
                 │  reads via QueryAdapter     │
                 │  writes via ChatWriter      │
                 └───────┬─────────────┬───────┘
                         │ reads       │ writes
              ┌──────────┴───┐     ┌───┴────────────┐
              │ QueryAdapter │     │   ChatWriter   │   ← new, local-only
              │  (unchanged) │     └───┬────────────┘
              └───┬──────┬───┘         │
     cave-backed  │      │ local-backed│
   createQuery-   │      │   ┌─────────┴─────────┐
   Adapter(...)   │      └───│     ChatStore     │   ← new persistence port
   (existing)     │          └─────────┬─────────┘
                  │                    │
           CaveReadClient      IndexedDB | memory fallback
```

**Rationale for splitting reads and writes:** C1. Cave physically cannot accept
a write. A single fat interface would force a lying implementation. Two ports
make "Cave is read-only" a fact expressed in the type system rather than a
runtime `throw`.

**Rationale for reusing `QueryAdapter` verbatim:** C3. `ChatShell`'s entire read
path, its cursor walking, its error/reconcile handling and its existing test
suite keep working unchanged and get reused for local data for free.

---

## 4. New types

### 4.1 `ChatStore` — the persistence port

`src/lib/local/chat-store.ts`

```ts
export type StoredConversation = Readonly<{
  id: string;
  familiarId: string;
  title?: string;
  createdAt: string;   // ISO 8601 UTC
  updatedAt: string;   // ISO 8601 UTC
}>;

export type StoredMessage = Readonly<{
  id: string;
  conversationId: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;   // ISO 8601 UTC
}>;

export type ChatStoreChange = Readonly<{ revision: number }>;

export type ChatStore = Readonly<{
  isDurable(): boolean;
  listConversations(limit: number, after?: ConversationKey): Promise<readonly StoredConversation[]>;
  getConversation(id: string): Promise<StoredConversation | undefined>;
  listMessages(conversationId: string, limit: number, after?: MessageKey): Promise<readonly StoredMessage[]>;
  createConversation(input: NewConversation): Promise<StoredConversation>;
  appendMessage(input: NewMessage): Promise<StoredMessage>;
  subscribe(listener: (change: ChatStoreChange) => void): () => void;
  dispose(): void;
}>;
```

Note the store reads take `limit + 1` internally to compute `hasMore` without a
second count query.

### 4.2 `ChatWriter` — the write port

`src/lib/local/chat-writer.ts`

```ts
export type WriteResult<T> =
  | Readonly<{ status: 'ok'; data: T }>
  | Readonly<{ status: 'error'; code: string }>
  | Readonly<{ status: 'unsupported' }>;   // returned by any Cave-backed source

export type ChatWriter = Readonly<{
  createConversation(title?: string): Promise<WriteResult<CaveConversation>>;
  sendMessage(conversationId: string, text: string): Promise<WriteResult<CaveConversationMessage>>;
}>;
```

`'unsupported'` is a first-class result, not an exception. When the active
source is Cave, the composer is disabled and explains why — honestly, per C1.

### 4.3 `ChatSource` — what the app selects

`src/lib/local/chat-source.ts`

```ts
export type ChatSourceKind = 'local' | 'cave';

export type ChatSource = Readonly<{
  kind: ChatSourceKind;
  label: string;
  adapter: QueryAdapter;
  writer: ChatWriter | null;   // null ⇒ read-only source
}>;
```

The app holds a local source **always**, and a Cave source **when connected**.
Switching source is a UI affordance, not a gate.

---

## 5. `createLocalQueryAdapter` semantics

`src/lib/local/local-query-adapter.ts`

```ts
export function createLocalQueryAdapter(
  store: ChatStore,
  options?: QueryAdapterOptions,
): QueryAdapter;
```

It returns the **existing** `QueryAdapter` type. Per-method behaviour:

| Method | Local behaviour |
| --- | --- |
| `listFamiliars` | single synthetic local familiar (§6), always one page |
| `listProjects` | empty page — v0.0.1 has no local project concept |
| `listConversations` | keyset page, ordered `updatedAt DESC, id DESC` |
| `getConversation` | `not_found` error code when absent |
| `listMessages` | keyset page, ordered `createdAt ASC, id ASC` (chat order) |
| `invalidate` | drops cache, bumps epoch — same contract as Cave adapter |
| `dispose` | idempotent, unsubscribes from store |

**Status parity.** Local returns only `ok`, `error`, and `not_ready`. It never
returns `stale` (no client-identity race exists locally) and never returns
`loading` — matching `createQueryAdapter`, which also never emits `loading`.
`reconcile_required` is Cave-only and is never emitted locally.

**Error codes** are drawn from the SDK's `SAFE_DIAGNOSTIC_CODES` set so both
sources speak one vocabulary: `not_found` for a missing conversation,
`invalid_request` for bad page options (delegating to `normalizePageOptions`
exactly as the Cave adapter does), `service_unavailable` for a storage fault.

**Caching.** Reuse the existing TTL/LRU/inflight-dedup design. Local reads are
cheap, so TTLs stay short and the store's `subscribe` triggers `invalidate()` on
every committed write. Full invalidation per write is deliberate: it is
obviously correct, and at local latency the extra reads are not worth
channel-scoped invalidation complexity in v0.0.1.

---

## 6. Synthetic local familiar

`CaveConversation.familiarId` is required, and `ChatShell` filters conversations
by selected familiar (`src/chat-shell.tsx:545`). Local data therefore needs one
stable familiar:

```ts
export const LOCAL_FAMILIAR_ID = 'local';
export const LOCAL_FAMILIAR: CaveCanonicalFamiliar = Object.freeze({
  id: LOCAL_FAMILIAR_ID,
  displayName: 'Local',
  role: 'This device',
  description: 'Conversations stored on this device. Not synced to Coven Cave.',
});
```

Its `description` doubles as the honest disclosure that local data is not synced.

---

## 7. Cursor design (satisfies C4)

Keyset, not offset. The cursor encodes the **last row of the page just served**:

```
cursor := base64url(JSON.stringify({ v: 1, t: <sortTimestamp>, i: <lastId> }))
```

- `listConversations` sorts `updatedAt DESC, id DESC` → cursor holds that pair
- `listMessages` sorts `createdAt ASC, id ASC` → cursor holds that pair

Emission rules, mapped directly onto the `manual-page-walk` assertions:

- root page → `cursor.current` omitted (allowed: `current === undefined`)
- follow-up page → `cursor.current` set to the **exact requested cursor string**,
  echoed verbatim rather than re-encoded (re-encoding risks a byte difference
  and an aborted walk)
- `hasMore` computed by over-reading one row (`limit + 1`)
- `next` emitted only when `hasMore`, derived from the last row of the served
  page — strictly forward-moving, so it can never equal `current` and can never
  repeat within a walk
- a malformed or unparseable cursor → `invalid_request`, never a silent reset to
  page one

An unknown-but-well-formed cursor (row since deleted) resolves to "start after
that key", which degrades to an empty page rather than an error.

---

## 8. Storage: IndexedDB, with an honest fallback

**Choice: IndexedDB**, behind `ChatStore`.

- structured, indexable by `conversationId` + sort key — keyset paging is a
  native index range scan, no full deserialize
- async by nature, matching the `Promise`-returning port
- no ~5 MB cliff, unlike `localStorage`, and no main-thread JSON churn
- available in the Tauri webview and in a plain browser, so one implementation
  covers desktop **and** the web build, and C5 keeps us out of `src-tauri/`

Database `opencoven-chat`, version 1:

| Store | Key | Indexes |
| --- | --- | --- |
| `conversations` | `id` | `by_updated` on `[updatedAt, id]` |
| `messages` | `id` | `by_conversation` on `[conversationId, createdAt, id]` |
| `meta` | `key` | — (holds `schemaVersion`) |

`createConversation` and `appendMessage` each run in **one** `readwrite`
transaction spanning both stores, so a message and its parent's `updatedAt` bump
commit atomically. `appendMessage` resolves `parentId` from the current last
message inside that same transaction.

**Fallback.** If IndexedDB is unavailable (private mode, hardened webview,
jsdom), the store degrades to an in-memory implementation and
`isDurable()` returns `false`. The UI must then show a persistent, explicit
"not saved to this device" notice. It must not silently pretend to persist.

**Migration.** `schemaVersion` is written from day one so a later Tauri/SQLite
store can adopt or import the data without guessing.

---

## 9. Gate demotion in `src/app.tsx`

Current: installation bootstrap gate → connection gate → `ChatShell`.

Proposed:

1. `App` mounts the **local source immediately**. No Cave call is on the startup
   path. No Tauri requirement — the browser build gets a real working app, which
   also removes the `BROWSER_PREVIEW_STATE` dead end.
2. Cave connection starts **lazily**, only when the user opens the connect
   surface or a stored credential is already present.
3. `ConnectionGate` is no longer an entry gate. It keeps all its current states
   and rendering, but is presented inside an opt-in "Connect to Cave" surface.
   No deletion of the Cave path — `connection-controller`, `connection-host`,
   `query-adapter` and their tests all stay live.
4. `installation_unavailable` disables **Cave pairing only**, with its retry
   affordance living in that surface (justified by C2).
5. `ChatShell`'s remount `key` moves from `caveInstanceId` to the active source
   identity, so switching source resets view state but local↔local re-renders do
   not thrash.

### Required `ChatShell` changes (deliberately minimal)

- **new optional prop `revision?: number`**, appended to the two fetch effect
  dependency arrays at `src/chat-shell.tsx:334` and `:615`. This is the refetch
  trigger after a write; without it a sent message would not appear until a TTL
  lapse.
- **new optional prop `writer?: ChatWriter | null`** plus a composer rendered
  only when `writer !== null`.
- read path, `toListState`, cursor walking, error handling: **unchanged**.

---

## 10. Message creation semantics

`sendMessage` appends a `role: 'user'` message and bumps the conversation's
`updatedAt`. It returns a `CaveConversationMessage`-shaped record:

```ts
{ id, conversationId, parentId, role: 'user', text,
  createdAt, attachmentCount: 0, toolCount: 0 }
```

`attachmentCount` and `toolCount` are `0` because v0.0.1 has neither.

**No assistant reply is fabricated.** There is no model backend in this lane, and
inventing canned assistant text would misrepresent the product. After a send the
conversation shows the user's message plus an explicit, styled affordance
stating that replies require a connected familiar. Wiring a real backend is
post-v0.0.1.

Validation: reject empty/whitespace-only text and text above a fixed byte
ceiling with `invalid_request`; `id` from `crypto.randomUUID()`.

---

## 11. Test strategy

1. **Shared adapter conformance suite.** One parameterised suite asserting the
   `QueryAdapter` contract — page shape, cursor echo, `hasMore`/`next` rules,
   invalidate/dispose idempotency, post-dispose `not_ready` — run against *both*
   the Cave-backed adapter (fake client) and the local adapter (memory store).
   This is what stops the two sources drifting.
2. **Cursor-contract tests driven through `createManualPageWalk`** — the real
   validator, not a restatement of it. A multi-page local walk must be accepted
   end to end.
3. **Store tests**: durability across a simulated reopen, transaction atomicity
   on `appendMessage`, keyset paging correctness with inserts interleaved
   between pages, memory-fallback flagged non-durable.
4. **Gate demotion tests**: app renders a usable surface with no Tauri; with
   `readInstallationId` rejecting, the app still renders and only Cave pairing is
   disabled. Existing gate tests in `src/app.test.tsx` and
   `src/connection-gate.test.tsx` get **updated to the new intent, not deleted**.
5. `e2e/connection-gate.spec.ts` updated to assert the connect surface rather
   than a blocking gate. Playwright is not run locally (port collisions on this
   machine); CI owns it.

Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit:normal`, `pnpm build`.

---

## 12. Out of scope for this lane / coordinator items

- `src-tauri/src/metadata.rs:5` `APP_PHASE = "phase-1-read-only-production"` is
  inside a lock-pinned file (C5). It becomes inaccurate but **must not** be
  changed here — it needs a Rust change plus a conformance relock. Flagged.
- `src/lib/app-metadata.ts` is *not* lock-pinned, so `APP_CONNECTION_STATE`
  (`'Read-only production'`), `APP_CONNECTION_SUMMARY` and `APP_SCAFFOLD_STATUS`
  are updated in this lane to stop describing the app as read-only.
- Real assistant replies / model backend.
- Syncing local conversations into Cave (impossible under C1).
- Local project records.

---

## 13. Decisions I want confirmed before code

1. **Separate sources, not a merged list.** Local and Cave conversations stay in
   distinct, switchable sources. Merging them into one writable list would imply
   you can reply into a Cave conversation, which C1 forbids. Confirm.
2. **No fabricated assistant replies** in v0.0.1 (§10). Confirm.
3. **IndexedDB over localStorage**, memory fallback surfaced as non-durable (§8).
4. **`ChatShell` gains exactly two optional props** (`revision`, `writer`) and
   otherwise keeps its read path (§9).
