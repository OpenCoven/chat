# OpenCoven Chat Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a usable Tauri desktop client that discovers and pairs with Cave, reads canonical familiar conversations, sends messages, and recovers resumable streams without duplicate execution.

**Architecture:** React renders a two-pane messaging application over a typed
Cave v1 client. A small state-machine layer owns connection and stream
lifecycles; TanStack Query owns replaceable server-state caching, while Tauri
commands own trusted discovery, managed Cave launch, native HTTP/SSE transport,
keychain access, and encrypted local storage. The bearer token never enters the
webview JavaScript runtime. Cave remains the only durable conversation and
execution authority.

**Tech Stack:** React 19, TypeScript 6, Vite 7, TanStack Query 5, Tauri 2, Rust, `keyring`, `aes-gcm`, Vitest, Testing Library, Playwright.

**Depends on:** `2026-08-10-cave-client-v1-api.md`

**Repository:** `/Users/buns/Documents/GitHub/OpenCoven/chat`

**Commit policy:** Every commit step is a proposed checkpoint. Do not execute it without Val's explicit approval.

---

## File Structure

- `src/lib/cave-api/` owns contract parsing and a typed transport interface.
- `src/lib/connection/` owns the explicit connection state machine and reconnect policy.
- `src/lib/chat/` owns canonical query keys, stream reduction, reconciliation, and draft state.
- `src/components/shell/` owns desktop layout and global states.
- `src/components/sidebar/` owns familiar filters, search, and canonical conversation rows.
- `src/components/thread/` owns the header, transcript, basic messages, and composer.
- `src/styles/` owns Coven tokens, reset, shell, sidebar, thread, and accessibility styles.
- `src-tauri/src/` owns discovery, launch, keychain, encrypted cache, and command registration.

### Task 1: Scaffold the React, test, and Tauri application

**Files:**
- Create: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`
- Create: `index.html`, `src/main.tsx`, `src/app.tsx`, `src/test/setup.ts`
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`
- Modify: `README.md`

- [ ] **Step 1: Create the test-first package manifest**

Use scripts:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc -b --pretty false",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "tauri": "tauri",
    "dev:app": "tauri dev",
    "build:app": "tauri build"
  }
}
```

Use Node `>=24.18.0 <25`, `pnpm@10.34.0`, and these exact initial versions:

```json
{
  "dependencies": {
    "@tanstack/react-query": "5.101.4",
    "@tauri-apps/api": "2.11.1",
    "dompurify": "3.4.13",
    "marked": "18.0.9",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@playwright/test": "1.62.1",
    "@tauri-apps/cli": "2.11.4",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.2",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "@vitejs/plugin-react": "6.0.5",
    "jsdom": "30.0.1",
    "typescript": "7.0.2",
    "vite": "8.2.1",
    "vitest": "4.1.10"
  }
}
```

Use this Rust baseline:

```toml
[build-dependencies]
tauri-build = { version = "2.6.2", features = [] }

[dependencies]
aes-gcm = "0.10.3"
base64 = "0.22.1"
keyring = "3.6.3"
rand = "0.8.5"
reqwest = { version = "0.12.28", default-features = false, features = ["json", "rustls-tls", "stream"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
sha2 = "0.10.9"
tauri = { version = "2.11.2", features = [] }
thiserror = "2.0.18"
url = "2.5.8"
zeroize = "1.8.2"
```

- [ ] **Step 2: Write a failing shell smoke test**

```tsx
it("renders the OpenCoven Chat identity", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "OpenCoven Chat" })).toBeVisible();
});
```

Run: `pnpm test -- src/app.test.tsx`

Expected: FAIL because `App` is absent.

- [ ] **Step 3: Add the minimal React and Tauri shells**

`App` renders the product heading and a `Connection unavailable` placeholder.
`src-tauri/src/lib.rs` contains:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running OpenCoven Chat");
}
```

Set product name `OpenCoven Chat`, identifier `ai.opencoven.chat`, minimum window
size 820x600, default 1180x780, and a strict CSP.

- [ ] **Step 4: Install and run baseline gates**

Run: `pnpm install && pnpm test -- src/app.test.tsx && pnpm typecheck && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 5: Commit the scaffold checkpoint**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vite.config.ts vitest.config.ts \
  index.html src src-tauri README.md
git commit -m "feat: scaffold OpenCoven Chat desktop app"
```

### Task 2: Implement runtime contract parsing and the transport-neutral client

**Files:**
- Create: `src/lib/cave-api/types.ts`
- Create: `src/lib/cave-api/schemas.ts`
- Create: `src/lib/cave-api/transport.ts`
- Create: `src/lib/cave-api/client.ts`
- Create: `src/lib/cave-api/client.test.ts`
- Create: `src/lib/cave-api/contract-fixture.json`

- [ ] **Step 1: Copy the passing Cave contract fixture**

Copy only the generated public fixture described in the Cave plan. Do not import
Cave source files or create a workspace dependency.

- [ ] **Step 2: Write failing parse and error tests**

Test valid fixture parsing, unknown additive fields, missing required fields,
wrong `apiVersion` major, non-JSON responses, structured API errors, timeout,
401 credential revocation, and request abort.

```ts
await expect(client.health()).resolves.toMatchObject({ service: "coven-cave", apiVersion: "1.0" });
await expect(incompatible.health()).rejects.toMatchObject({ code: "incompatible_version" });
```

- [ ] **Step 3: Implement exact client types and Zod schemas**

Define `CaveApiError`, `Health`, `Familiar`, `Project`,
`ConversationSummary`, `Conversation`, `ChatTurn`, `ClientStreamEvent`, and
paginated response types matching the fixture. `CaveClient` receives a `CaveTransport`:

```ts
export interface CaveTransport {
  request(input: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: `/api/client/v1/${string}`;
    body?: unknown;
    idempotencyKey?: string;
    auth: "public" | "paired" | "admin-never";
  }): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
  startRun(input: {
    body: ClientSendInput;
    idempotencyKey: string;
    signal: AbortSignal;
    onFrame: (frame: { id: number; data: unknown }) => void;
  }): Promise<void>;
  resumeRun(input: {
    runId: string;
    cursor: number;
    signal: AbortSignal;
    onFrame: (frame: { id: number; data: unknown }) => void;
  }): Promise<void>;
}
```

The production transport invokes constrained Tauri commands implemented in
Task 3. Tests provide an in-memory transport. `CaveClient` maps the stable error
envelope and never returns success-shaped defaults.

- [ ] **Step 4: Run focused tests**

Run: `pnpm test -- src/lib/cave-api/client.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the client-contract checkpoint**

```bash
git add src/lib/cave-api
git commit -m "feat: add typed Cave client contract"
```

### Task 3: Add trusted Cave discovery, launch, keychain, and HTTP/SSE transport

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/discovery.rs`
- Create: `src-tauri/src/cave_process.rs`
- Create: `src-tauri/src/keychain.rs`
- Create: `src-tauri/src/transport.rs`
- Create: `src-tauri/src/commands.rs`
- Create: `src-tauri/src/test_support.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: Rust unit tests in each module

- [ ] **Step 1: Write platform-path and validation tests**

Test:

- development endpoint is accepted only with `http://127.0.0.1:<port>`
- `~/.coven/cave/client-v1-discovery.json` must be owned/readable by the current
  user and contain a live PID plus validated loopback endpoint
- endpoints with non-loopback hosts, userinfo, paths, or fragments are rejected
- launch candidates are exact installed Cave locations per platform
- keychain service/account names are stable
- transport paths must begin `/api/client/v1/` with no scheme, authority, `..`,
  encoded slash, or fragment
- paired requests read and attach the bearer token inside Rust
- SSE framing preserves numeric IDs and rejects overlong frames

- [ ] **Step 2: Run and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml discovery keychain cave_process transport`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement Tauri commands**

Expose:

```rust
#[tauri::command]
async fn discover_cave() -> Result<DiscoveredCave, NativeError>;
#[tauri::command]
async fn launch_cave(candidate: LaunchCandidate) -> Result<(), NativeError>;
#[tauri::command]
async fn installation_id() -> Result<String, NativeError>;
#[tauri::command]
async fn credential_status() -> Result<CredentialStatus, NativeError>;
#[tauri::command]
async fn exchange_pairing(input: PairingExchange) -> Result<CredentialStatus, NativeError>;
#[tauri::command]
async fn delete_credential() -> Result<(), NativeError>;
#[tauri::command]
async fn cave_request(input: CaveRequest) -> Result<CaveResponse, NativeError>;
#[tauri::command]
async fn start_run(input: StartRunRequest, channel: tauri::ipc::Channel<StreamFrame>)
    -> Result<(), NativeError>;
#[tauri::command]
async fn resume_run(input: ResumeRunRequest, channel: tauri::ipc::Channel<StreamFrame>)
    -> Result<(), NativeError>;
```

Use `keyring` service `ai.opencoven.chat`, account `cave-client-v1`. The exchange
command performs the one-time HTTP exchange and writes the returned token
directly to the keychain before returning non-secret credential metadata.
`installation_id` creates one UUID on first run and stores it atomically in the
app config directory; it is stable but not secret.
`cave_request` permits only the four contract methods and validated client-v1
paths, adds `Authorization` internally for `auth: paired`, caps JSON responses
at 4 MiB, and uses `reqwest` with redirects disabled. `start_run` is fixed to
`POST /api/client/v1/messages/send`; `resume_run` is fixed to the run stream GET
path. Both cap each SSE frame at 1 MiB and forward parsed frames over the Tauri
channel. Launch with
`Command::new` and exact candidate paths; never invoke a shell. Readiness polling
remains in TypeScript so UI state is observable.

- [ ] **Step 4: Run Rust tests and checks**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 5: Commit native connection primitives**

```bash
git add src-tauri
git commit -m "feat: add managed Cave discovery and credentials"
```

### Task 4: Implement connection and pairing state machines

**Files:**
- Create: `src/lib/connection/types.ts`
- Create: `src/lib/connection/reducer.ts`
- Create: `src/lib/connection/reducer.test.ts`
- Create: `src/lib/connection/controller.ts`
- Create: `src/lib/connection/controller.test.ts`
- Create: `src/components/shell/connection-gate.tsx`
- Create: `src/components/shell/connection-gate.test.tsx`

- [ ] **Step 1: Write state transition tests**

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

Test legal transitions, rejection of stale async attempts, bounded exponential
backoff with deterministic jitter, pairing denial/expiry, token revocation, and
successful re-pair.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- src/lib/connection/reducer.test.ts src/lib/connection/controller.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the controller**

The controller performs discover -> health -> optional launch -> readiness ->
credential status -> authenticated probe -> pairing. Pairing exchange is a
single native command, so the raw bearer never enters JavaScript. Backoff is 250ms, 500ms, 1s,
2s, 4s, capped at 5s with a 30-second startup deadline. Only repeated 401
responses delete the credential; network and 5xx failures retain it.

Pairing requests exactly:

```ts
{
  appName: "OpenCoven Chat",
  installationId,
  scopes: [
    "chat:read",
    "chat:write",
    "conversations:write",
    "attachments:write",
    "tasks:write",
    "github:write",
  ],
}
```

- [ ] **Step 4: Render and test each connection state**

`ConnectionGate` shows locating, starting, readiness, approval instructions,
incompatible upgrade, unavailable diagnostics, and retry. It never renders the
write-enabled chat shell before authenticated health succeeds.

Run: `pnpm test -- src/lib/connection src/components/shell/connection-gate.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit connection lifecycle**

```bash
git add src/lib/connection src/components/shell/connection-gate*
git commit -m "feat: manage Cave pairing and connection"
```

### Task 5: Establish Coven visual tokens and the responsive application shell

**Files:**
- Create: `src/styles/tokens.css`
- Create: `src/styles/reset.css`
- Create: `src/styles/shell.css`
- Create: `src/styles/accessibility.css`
- Create: `src/components/shell/app-shell.tsx`
- Create: `src/components/shell/app-shell.test.tsx`
- Modify: `src/main.tsx`, `src/app.tsx`

- [ ] **Step 1: Write shell accessibility tests**

Assert named navigation/main landmarks, skip link, visible focus, sidebar toggle
state, keyboard focus restoration, 820px narrow behavior, and no animation when
`prefers-reduced-motion` is set.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- src/components/shell/app-shell.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement Coven tokens and shell**

Port the semantic vocabulary from Cave's
`src/styles/globals/foundations.css`, not its Tailwind classes. Define near-black
panel/base/raised/elevated surfaces, cyan focus/circuit accents, violet presence,
three text tiers, familiar accent custom property, 4px spacing scale, control/
card/panel radii, Inter/EB Garamond/JetBrains Mono stacks, and reduced-motion
overrides.

`AppShell` renders:

```tsx
<div className="app-shell">
  <a className="skip-link" href="#conversation">Skip to conversation</a>
  <aside aria-label="Conversations">{sidebar}</aside>
  <main id="conversation">{thread}</main>
</div>
```

- [ ] **Step 4: Run shell tests and production build**

Run: `pnpm test -- src/components/shell/app-shell.test.tsx && pnpm build`

Expected: PASS.

- [ ] **Step 5: Commit the shell checkpoint**

```bash
git add src/styles src/components/shell src/main.tsx src/app.tsx
git commit -m "feat: add Coven desktop chat shell"
```

### Task 6: Add canonical query state, familiar filters, and conversation list

**Files:**
- Create: `src/lib/chat/query-keys.ts`
- Create: `src/lib/chat/query-client.ts`
- Create: `src/lib/chat/cache-order.ts`
- Create: `src/lib/chat/cache-order.test.ts`
- Create: `src/components/sidebar/familiar-filter.tsx`
- Create: `src/components/sidebar/conversation-row.tsx`
- Create: `src/components/sidebar/conversation-list.tsx`
- Create: `src/components/sidebar/conversation-list.test.tsx`
- Create: `src/components/sidebar/sidebar.tsx`
- Create: `src/styles/sidebar.css`

- [ ] **Step 1: Write ordering and UI tests**

Test `revisionTime` ordering, request-generation ordering for equal timestamps,
cursor pagination, All Chats default, familiar filter, pinned/recent/archived
sections, search debounce, running/unread/attention labels, row familiar
identity, and selection keyboard navigation.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- src/lib/chat/cache-order.test.ts src/components/sidebar/conversation-list.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement canonical queries**

Use query keys:

```ts
export const chatKeys = {
  familiars: ["familiars"] as const,
  projects: ["projects"] as const,
  conversations: (filter: ConversationFilter) => ["conversations", filter] as const,
  conversation: (id: string) => ["conversation", id] as const,
  search: (query: string) => ["conversation-search", query] as const,
};
```

Merge pages only when an incoming item has a newer `revisionTime`, or the same
time from a later request generation with a different canonical `revision`;
never generate local conversation records. Search executes through Cave after
250ms and cancels obsolete requests.

- [ ] **Step 4: Run sidebar tests**

Run: `pnpm test -- src/lib/chat src/components/sidebar`

Expected: PASS.

- [ ] **Step 5: Commit canonical navigation**

```bash
git add src/lib/chat src/components/sidebar src/styles/sidebar.css
git commit -m "feat: browse canonical familiar conversations"
```

### Task 7: Add new conversation flow and basic transcript

**Files:**
- Create: `src/components/thread/new-conversation.tsx`
- Create: `src/components/thread/new-conversation.test.tsx`
- Create: `src/components/thread/thread-header.tsx`
- Create: `src/components/thread/message-list.tsx`
- Create: `src/components/thread/basic-message.tsx`
- Create: `src/components/thread/thread.test.tsx`
- Create: `src/styles/thread.css`

- [ ] **Step 1: Write creation and identity tests**

Cover familiar selection, permitted project selection, grant error, idempotent
create, immediate canonical selection, familiar identity in every row/header,
rename, pin/unpin, archive/unarchive, delete confirmation, empty state,
user/familiar text, code blocks, copy action, and long content.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- src/components/thread/new-conversation.test.tsx src/components/thread/thread.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement create and basic transcript**

Create uses `crypto.randomUUID()` as `Idempotency-Key`; on success invalidate
conversation summaries and load the returned canonical ID. Render Markdown
through `marked` and sanitize with DOMPurify with raw HTML disabled. Header
mutations use new idempotency keys and update only after Cave success.

- [ ] **Step 4: Run thread tests**

Run: `pnpm test -- src/components/thread`

Expected: PASS.

- [ ] **Step 5: Commit canonical threads**

```bash
git add src/components/thread src/styles/thread.css
git commit -m "feat: create and read familiar chats"
```

### Task 8: Implement composer, stream reduction, stop, retry, and reconciliation

**Files:**
- Create: `src/lib/chat/stream-reducer.ts`
- Create: `src/lib/chat/stream-reducer.test.ts`
- Create: `src/lib/chat/stream-controller.ts`
- Create: `src/lib/chat/stream-controller.test.ts`
- Create: `src/lib/chat/draft-store.ts`
- Create: `src/lib/chat/draft-store.test.ts`
- Create: `src/lib/chat/slash-commands.ts`
- Create: `src/lib/chat/slash-commands.test.ts`
- Create: `src/components/thread/composer.tsx`
- Create: `src/components/thread/composer.test.tsx`
- Create: `src/components/thread/streaming-message.tsx`
- Create: `src-tauri/src/secure_store.rs`
- Create: `src-tauri/src/drafts.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/components/thread/message-list.tsx`

- [ ] **Step 1: Write reducer and controller tests**

Cover monotonic cursor acceptance, duplicate no-op, delta concatenation, tool/
progress replacement by ID, terminal completion, interruption, resume from last
cursor, `reconcile_required`, canonical reload, and no automatic send replay.

- [ ] **Step 2: Write composer behavior tests**

Cover Enter send, Shift+Enter newline, disabled writes offline, preserved
encrypted draft, send/stop state, empty prompt, operation UUID, stop request,
retry using a new operation ID plus `retryOfTurnId`, slash discovery from
Cave's command projection, arrow-key selection, Escape dismissal, and no locally
invented commands.

- [ ] **Step 3: Implement stream controller and composer**

The controller:

1. calls `startRun` once with `operationId`
2. consumes initial SSE and checkpoints each accepted `id`
3. calls `resumeRun` with `{ runId, cursor: lastId }`
4. reconciles the canonical transcript on gap or terminal event
5. never re-POSTs send due to a transport error; an
   `operation_already_started` result attaches to the returned `resumePath`

Add `secure_store.rs` for the keychain-backed AES-256-GCM primitive reused by
drafts and the read cache. `drafts.rs` atomically stores an encrypted map keyed
by canonical conversation ID and exposes `read_draft`, `write_draft`, and
`delete_draft`; plaintext prompt content never enters localStorage or the
canonical read cache. Clear the draft only after Cave accepts the send.

- [ ] **Step 4: Run messaging tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml drafts secure_store && pnpm test -- src/lib/chat/stream-reducer.test.ts src/lib/chat/stream-controller.test.ts src/lib/chat/draft-store.test.ts src/lib/chat/slash-commands.test.ts src/components/thread/composer.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit core messaging**

```bash
git add src/lib/chat/stream-* src/lib/chat/draft-store* src/lib/chat/slash-commands* src/components/thread \
  src-tauri/src/secure_store.rs src-tauri/src/drafts.rs src-tauri/src/lib.rs
git commit -m "feat: send and resume familiar messages"
```

### Task 9: Add encrypted read cache and explicit offline mode

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/cache.rs`
- Create: `src/lib/cache/native-cache.ts`
- Create: `src/lib/cache/hydration.ts`
- Create: `src/lib/cache/hydration.test.ts`
- Create: `src/components/shell/offline-banner.tsx`
- Create: `src/components/shell/offline-banner.test.tsx`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write Rust encryption tests**

Test AES-256-GCM round trip, random nonce, tamper rejection, keychain-generated
master key, missing-key behavior, cache version mismatch, and atomic replacement.
The plaintext fixture must not appear in the file bytes.

- [ ] **Step 2: Implement native cache commands**

Expose:

```rust
#[tauri::command]
async fn read_cache() -> Result<Option<EncryptedCachePayload>, NativeError>;
#[tauri::command]
async fn write_cache(payload: EncryptedCachePayload) -> Result<(), NativeError>;
#[tauri::command]
async fn clear_cache() -> Result<(), NativeError>;
```

Reuse `secure_store.rs` for cache encryption. Cache only roster, project projections, summaries, recently opened
conversations, and revisions. Do not cache bearer tokens, drafts, pending
mutations, or attachment bodies.

- [ ] **Step 3: Write and implement hydration ordering tests**

Hydrate cached reads immediately, mark them stale, then accept Cave data only
when its revision supersedes the hydrated record. Offline mode disables every
canonical mutation but leaves drafts and local preferences editable.

- [ ] **Step 4: Run native and web tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cache && pnpm test -- src/lib/cache src/components/shell/offline-banner.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit offline-read behavior**

```bash
git add src-tauri src/lib/cache src/components/shell/offline-banner*
git commit -m "feat: add encrypted offline read cache"
```

### Task 10: Verify the canonical core end to end

**Files:**
- Create: `tests/fixtures/fake-cave.ts`
- Create: `tests/pairing.spec.ts`
- Create: `tests/canonical-chat.spec.ts`
- Create: `tests/resume.spec.ts`
- Create: `playwright.config.ts`

- [ ] **Step 1: Build a deterministic fake Cave v1 server**

Implement only the published fixture contract, record mutation counts, expose a
controllable SSE disconnect/gap, and reject reused idempotency keys with changed
bodies.

- [ ] **Step 2: Add pair-read-send-resume scenarios**

Test pair -> familiar list -> create -> send -> disconnect -> resume ->
canonical reconcile, and assert the fake Cave observed one send. Test offline
cached reads with all write controls disabled and draft retained.

- [ ] **Step 3: Run complete core gates**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
pnpm test:e2e -- tests/pairing.spec.ts tests/canonical-chat.spec.ts tests/resume.spec.ts
```

Expected: all commands PASS.

- [ ] **Step 4: Run a real Cave smoke test**

With a Cave branch containing Client v1 running locally, pair Chat, open one
existing conversation, send a harmless prompt, interrupt the webview network,
restore it, and confirm Cave and Chat show the same single canonical turn.

- [ ] **Step 5: Commit the completed core client**

```bash
git add tests playwright.config.ts
git commit -m "test: verify canonical Chat lifecycle"
```
