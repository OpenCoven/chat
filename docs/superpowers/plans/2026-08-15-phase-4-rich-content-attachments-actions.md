# Phase 4 Rich Content, Attachments, and Privileged Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely render Cave rich semantics and support bounded attachments, attention responses, task handoffs, and explicitly confirmed GitHub mutations through `/api/client/v1`.

**Architecture:** Cave remains authoritative for attachment storage, grants, privileged actions, audit, and idempotency. `@opencoven/cave-client` exposes capability-gated typed methods; Chat parses untrusted markers into a strict non-executable AST and invokes mutations only after a direct user gesture. Attachment bytes cross the native transport and may exist in short-lived object URLs, but never in browser storage or the encrypted read cache.

**Tech Stack:** Cave Next.js 16.2/React 19.2/TypeScript 6.0.3, Chat React 19.2/TypeScript 6.0.3/Tauri 2, Zod 4, Vitest, Testing Library, Playwright, Node 24, Rust.

**Depends on:** Approved Phase 3 canonical send/stream/idempotency, Chat transcript, SDK transport, and Cave Client v1 pairing/read/mutation foundations.

**Repositories:**
- Cave: `/Users/buns/Documents/GitHub/OpenCoven/coven-cave`
- Chat: `/Users/buns/Documents/GitHub/OpenCoven/chat`
- SDK: `/Users/buns/Documents/GitHub/OpenCoven/sdk`

**Boundary:** No Chat or SDK call may use Cave private `/api/chat/*`, `/api/github/*`, `/api/board`, or an arbitrary HTTP escape hatch. Existing private Cave routes continue to work by calling extracted server services.

---

## File Structure

### Cave

- `src/lib/server/client-v1/attachment-record-store.ts` owns temporary credential/conversation attachment bindings.
- `src/lib/server/client-v1/attachment-service.ts` validates multipart input and delegates canonical byte storage.
- `src/lib/server/client-v1/action-service.ts` validates scopes, confirmation, grants, and action inputs.
- `src/lib/server/github-action-service.ts` contains reusable server-side GitHub mutations used by private and Client v1 routes.
- `src/lib/server/chat-task-handoff-service.ts` creates canonical task handoffs without browser-relative fetches.
- `src/app/api/client/v1/attachments/**` exposes bounded upload/download.
- `src/app/api/client/v1/attention/**`, `tasks/**`, and `github/**` expose privileged mutations.

### Chat

- `src/lib/rich-content/` owns the strict AST, parser, sanitizer adapters, and hostile fixtures.
- `src/lib/attachments/` owns client limits, preview preparation, upload lifecycle, and cleanup.
- `src/lib/cave-api/attachments.ts` and `actions.ts` adapt the public SDK to Chat state.
- `src/components/messages/` renders passive semantic blocks.
- `src/components/actions/` owns confirmation and result presentation.

### SDK

- `packages/cave/src/attachments.ts` and `actions.ts` expose typed public operations.
- `packages/cave/src/capabilities.ts` provides `client.supports(capability)`.
- `packages/cli/src/commands/cave.ts` exposes curated commands only.

## Public Contract Decisions

```ts
export const CLIENT_V1_ATTACHMENT_LIMITS = {
  maxFiles: 4,
  maxFileBytes: 10 * 1024 * 1024,
  maxRequestBytes: 25 * 1024 * 1024,
} as const;

export type GitHubActionInput =
  | { kind: "comment"; repo: string; number: number; body: string }
  | { kind: "reply"; repo: string; number: number; body: string }
  | { kind: "resolve"; repo: string; number: number; threadId: string }
  | { kind: "unresolve"; repo: string; number: number; threadId: string }
  | { kind: "issue-create"; repo: string; title: string; body?: string }
  | { kind: "issue-state"; repo: string; number: number; state: "open" | "closed" }
  | { kind: "review"; repo: string; number: number; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string }
  | { kind: "merge"; repo: string; number: number; method: "squash" | "merge" | "rebase" }
  | { kind: "rerun"; repo: string; runId: string }
  | { kind: "dispatch"; repo: string; workflow: string; ref: string };
```

Supported uploaded MIME types are PNG, JPEG, WebP, GIF, PDF, UTF-8 plain text, MP3, WAV, and M4A. Cave must add a generic canonical byte-storage path for PDF/text rather than pretending the existing image/media helpers support them. SVG, executable formats, archive formats, and extension/MIME disagreement are rejected.

## Task 1: Lock Phase 4 Contract and Capabilities

**Files — Cave:**
- Modify: `src/lib/server/client-v1/contract.ts`
- Modify: `src/lib/server/client-v1/contract.test.ts`
- Modify: `scripts/export-client-v1-contract.mjs`
- Modify: `src/lib/server/client-v1/contract-fixture.json`
- Modify: `scripts/run-tests.mjs`

**Files — SDK:**
- Modify: `packages/cave/src/schemas.ts`
- Create: `packages/cave/src/capabilities.ts`
- Create: `packages/cave/src/capabilities.test.ts`
- Modify: `packages/cave/fixtures/contract-fixture.json`

- [ ] **Step 1: Write failing Cave contract tests**

Assert the exact limits, supported MIME list, action union, `confirmed: true`, capability names, proposed/result distinction, and UUID idempotency requirement.

```ts
assert.deepEqual(CLIENT_V1_ATTACHMENT_LIMITS, {
  maxFiles: 4,
  maxFileBytes: 10 * 1024 * 1024,
  maxRequestBytes: 25 * 1024 * 1024,
});
assert.equal(parseGitHubAction({ confirmed: false }), null);
assert.equal(CLIENT_V1_CAPABILITIES.includes("github-actions"), true);
```

- [ ] **Step 2: Verify the contract test fails**

Run from `coven-cave`:

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/lib/server/client-v1/contract.test.ts
```

Expected: FAIL because the Phase 4 limits, capabilities, and action schemas are absent.

- [ ] **Step 3: Implement strict parsers and deterministic export**

Add `attachments`, `attention`, `task-handoff`, and `github-actions` capability constants. Reject unknown fields, duplicate fields, unsafe repository names, missing confirmation, and unsupported MIME values.

- [ ] **Step 4: Generate and verify identical fixtures**

Run from `coven-cave`, then copy only the generated bytes into the SDK fixture:

```bash
node scripts/export-client-v1-contract.mjs
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/lib/server/client-v1/contract.test.ts
pnpm check:tests-wired
```

Run from `sdk`:

```bash
pnpm exec vitest run packages/cave/src/capabilities.test.ts
node scripts/verify-contracts.mjs
pnpm typecheck
```

Expected: PASS; Cave and SDK fixture digests are identical.

- [ ] **Step 5: Commit checkpoint during execution**

```bash
git add src/lib/server/client-v1 scripts/export-client-v1-contract.mjs scripts/run-tests.mjs
git commit -m "feat(client-v1): define rich content capabilities"
```

## Task 2: Add Canonical Attachment Storage and Ownership

**Files — Cave:**
- Create: `src/lib/server/client-v1/attachment-record-store.ts`
- Create: `src/lib/server/client-v1/attachment-record-store.test.ts`
- Create: `src/lib/server/client-v1/attachment-service.ts`
- Create: `src/lib/server/client-v1/attachment-service.test.ts`
- Modify: `src/lib/chat-attachments.ts`
- Modify: `src/lib/server/chat-attachment-store.ts`
- Modify: `src/lib/server/chat-attachment-store.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write failing storage and validation tests**

Test:

- four accepted files and five rejected files;
- exactly 10 MiB accepted and 10 MiB + 1 byte rejected;
- exactly 25 MiB request accepted and larger request rejected;
- content signature rather than extension controls MIME;
- PDF/text survive canonical reload;
- path-like/control-character filenames are sanitized;
- records are scoped to the uploading credential until bound;
- abandoned unbound records expire;
- symlinks and path traversal cannot steer storage.

- [ ] **Step 2: Verify focused tests fail**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/client-v1/attachment-record-store.test.ts \
  src/lib/server/client-v1/attachment-service.test.ts
```

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement the minimal canonical service**

Store bytes under server-minted IDs and persist metadata:

```ts
type ClientAttachmentRecord = {
  id: string;
  credentialId: string;
  conversationId: string | null;
  name: string;
  mimeType: string;
  byteLength: number;
  createdAt: string;
};
```

Use `Request.formData()`, bounded reads, image metadata validation through existing `sharp`, magic-byte checks for PDF/audio/images, and UTF-8 validation for text. Do not place bytes in conversation JSON.

- [ ] **Step 4: Run storage tests and existing attachment regressions**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/client-v1/attachment-record-store.test.ts \
  src/lib/server/client-v1/attachment-service.test.ts \
  src/lib/server/chat-attachment-store.test.ts \
  src/lib/chat-attachments.test.ts
pnpm check:tests-wired
```

Expected: PASS.

- [ ] **Step 5: Commit checkpoint during execution**

```bash
git add src/lib/server/client-v1/attachment-* src/lib/chat-attachments.ts \
  src/lib/server/chat-attachment-store* scripts/run-tests.mjs
git commit -m "feat(client-v1): add bounded canonical attachments"
```

## Task 3: Expose Attachment Upload and Download Routes

**Files — Cave:**
- Create: `src/app/api/client/v1/attachments/route.ts`
- Create: `src/app/api/client/v1/attachments/route.test.ts`
- Create: `src/app/api/client/v1/attachments/[id]/route.ts`
- Create: `src/app/api/client/v1/attachments/[id]/route.test.ts`
- Modify: `src/lib/server/client-v1/chat-service.ts`
- Modify: `src/lib/server/client-v1/chat-service.test.ts`
- Modify: `src/app/api/api-contracts.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write failing route tests**

Cover missing bearer, missing `attachments:write`, wrong credential, invalid IDs, no redirects, `nosniff`, private cache headers, content disposition, request bounds, and atomic conversation binding before send.

- [ ] **Step 2: Verify route tests fail**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/app/api/client/v1/attachments/route.test.ts \
  src/app/api/client/v1/attachments/[id]/route.test.ts
```

- [ ] **Step 3: Implement narrow route handlers**

Handlers call `authorizeClientV1`, `attachmentService`, and stable response helpers. The send service binds IDs to the target conversation before harness launch and rejects reuse from another credential or conversation.

- [ ] **Step 4: Run route, chat-service, and contract tests**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/app/api/client/v1/attachments/route.test.ts \
  src/app/api/client/v1/attachments/[id]/route.test.ts \
  src/lib/server/client-v1/chat-service.test.ts \
  src/app/api/api-contracts.test.ts
pnpm check:tests-wired
```

Expected: PASS.

## Task 4: Extract and Delegate Privileged Cave Actions

**Files — Cave:**
- Create: `src/lib/server/github-action-service.ts`
- Create: `src/lib/server/client-v1/action-service.ts`
- Create: `src/lib/server/client-v1/action-service.test.ts`
- Create: `src/lib/server/chat-task-handoff-service.ts`
- Create: `src/lib/server/chat-task-handoff-service.test.ts`
- Modify: `src/lib/chat-task-handoff.ts`
- Modify: `src/app/api/github/comment/route.ts`
- Modify: `src/app/api/github/review/route.ts`
- Modify: `src/app/api/github/merge/route.ts`
- Modify: `src/app/api/github/rerun/route.ts`
- Modify: `src/app/api/github/dispatch/route.ts`
- Modify: `src/app/api/github/issue/route.ts`
- Modify: `src/app/api/github/resolve-thread/route.ts`
- Create: missing colocated private-route characterization tests
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Characterize existing private-route behavior**

Write tests proving current success/error payloads, GitHub credential resolution, repository validation, and no duplicate network mutation.

- [ ] **Step 2: Run characterization tests**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/app/api/github/comment/route.test.ts \
  src/app/api/github/review/route.test.ts \
  src/app/api/github/merge/route.test.ts
```

Expected: PASS before extraction.

- [ ] **Step 3: Write failing Client v1 action tests**

Test all action kinds, `confirmed: true`, exact repository/project grants, scopes, body bounds, UUID idempotency, concurrent duplicate claims, rejection, and zero domain calls on validation failure. Attention response must reuse the canonical send service. Task handoff must use a server service, not `fetch("/api/board")`.

- [ ] **Step 4: Implement reusable server services**

Private routes and `action-service.ts` call the same extracted functions. Preserve proposed, pending, completed, rejected, and failed as distinct states.

- [ ] **Step 5: Run action and private-route suites**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/lib/server/client-v1/action-service.test.ts \
  src/lib/server/chat-task-handoff-service.test.ts \
  src/app/api/github/comment/route.test.ts \
  src/app/api/github/review/route.test.ts \
  src/app/api/github/merge/route.test.ts \
  src/app/api/github/issue/route.test.ts \
  src/app/api/github/resolve-thread/route.test.ts
```

Expected: PASS.

## Task 5: Expose Attention, Handoff, and GitHub Routes

**Files — Cave:**
- Create: `src/app/api/client/v1/attention/[id]/respond/route.ts`
- Create: `src/app/api/client/v1/attention/[id]/respond/route.test.ts`
- Create: `src/app/api/client/v1/tasks/handoff/route.ts`
- Create: `src/app/api/client/v1/tasks/handoff/route.test.ts`
- Create: `src/app/api/client/v1/github/actions/route.ts`
- Create: `src/app/api/client/v1/github/actions/route.test.ts`
- Modify: `src/app/api/api-contracts.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write failing route tests**

Require bearer, exact scope, `Idempotency-Key`, `confirmed: true` for GitHub, project/repository grant, and stable response envelopes.

- [ ] **Step 2: Verify failure**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/app/api/client/v1/attention/[id]/respond/route.test.ts \
  src/app/api/client/v1/tasks/handoff/route.test.ts \
  src/app/api/client/v1/github/actions/route.test.ts
```

- [ ] **Step 3: Implement routes as thin service adapters**

Do not redirect to private routes. Return canonical action IDs, states, audit timestamps, and diagnostic IDs.

- [ ] **Step 4: Run route and contract gates**

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/app/api/client/v1/attention/[id]/respond/route.test.ts \
  src/app/api/client/v1/tasks/handoff/route.test.ts \
  src/app/api/client/v1/github/actions/route.test.ts \
  src/app/api/api-contracts.test.ts
pnpm check:tests-wired
```

## Task 6: Add Public SDK and Curated CLI Methods

**Files — SDK:**
- Create: `packages/cave/src/attachments.ts`
- Create: `packages/cave/src/attachments.test.ts`
- Create: `packages/cave/src/actions.ts`
- Create: `packages/cave/src/actions.test.ts`
- Modify: `packages/cave/src/client.ts`
- Modify: `packages/cave/src/schemas.ts`
- Modify: `packages/cave/src/index.ts`
- Modify: `packages/cli/src/commands/cave.ts`
- Modify: `packages/cli/src/commands/cave.test.ts`
- Modify: `packages/cli/src/output.ts`
- Modify: `packages/cli/src/output.test.ts`

- [ ] **Step 1: Write failing SDK tests**

Test capability short-circuiting, multipart progress/cancellation, byte download, absent confirmation rejection, generated idempotency keys, caller-supplied idempotency keys, and preservation of Cave errors.

- [ ] **Step 2: Verify failure**

```bash
pnpm exec vitest run \
  packages/cave/src/attachments.test.ts \
  packages/cave/src/actions.test.ts
```

- [ ] **Step 3: Implement typed methods**

Expose methods through `CaveClient`; do not expose generic `request(path)` publicly. `client.supports()` must return false before any unsupported network call.

- [ ] **Step 4: Add CLI confirmation tests**

Interactive commands may prompt. Non-interactive commands must exit non-zero unless `--confirm` is supplied. JSON output records proposal/result states without secrets or attachment bytes.

- [ ] **Step 5: Run package gates**

```bash
pnpm exec vitest run \
  packages/cave/src/attachments.test.ts \
  packages/cave/src/actions.test.ts \
  packages/cli/src/commands/cave.test.ts \
  packages/cli/src/output.test.ts
pnpm typecheck
pnpm --recursive build
```

## Task 7: Parse and Render Passive Rich Content in Chat

**Files — Chat:**
- Create: `src/lib/rich-content/types.ts`
- Create: `src/lib/rich-content/parser.ts`
- Create: `src/lib/rich-content/parser.test.ts`
- Create: `src/lib/rich-content/fixtures.ts`
- Create: `src/lib/rich-content/markdown.ts`
- Create: `src/lib/rich-content/markdown.test.ts`
- Create: `src/components/messages/rich-message.tsx`
- Create: `src/components/messages/markdown-block.tsx`
- Create: `src/components/messages/code-block.tsx`
- Create: `src/components/messages/image-gallery.tsx`
- Create: `src/components/messages/citation-list.tsx`
- Create: `src/components/messages/spec-card.tsx`
- Create: `src/components/messages/status-card.tsx`
- Create: `src/components/messages/progress-card.tsx`
- Create: `src/components/messages/tool-card.tsx`
- Create: `src/components/messages/attention-card.tsx`
- Create: `src/components/messages/task-handoff-card.tsx`
- Create: `src/components/messages/github-card.tsx`
- Create: `src/components/messages/content-renderers.test.tsx`
- Create: `src/components/messages/status-renderers.test.tsx`
- Create: `src/styles/messages.css`
- Modify: `src/components/thread/message-list.tsx`

- [ ] **Step 1: Write strict parser tests**

Cover all approved marker families, fenced-code exclusion, duplicate/unknown attributes, partial stream tails, nested markers, control characters, unsafe links, unsupported blocks, and stable progress/tool IDs.

- [ ] **Step 2: Verify parser failure**

```bash
pnpm test -- src/lib/rich-content/parser.test.ts src/lib/rich-content/markdown.test.ts
```

- [ ] **Step 3: Implement a one-pass parser and sanitizer adapter**

Unknown or malformed markers become `{ type: "unsupported", source, reason }`. Image blocks accept `https:`, bounded allowed `data:image/*;base64`, and validated attachment IDs. Authenticated attachment bytes are downloaded through the native transport and displayed with object URLs; bearer-bearing URLs never enter markup.

- [ ] **Step 4: Write and implement renderer tests**

Test semantic headings/lists/tables/code, link allowlisting, copy feedback, horizontal code scroll, carousel keyboard control, alt text, failed media, spec-reader trap/Escape/focus return, status announcements, and color-independent states.

- [ ] **Step 5: Run renderer gates**

```bash
pnpm test -- src/lib/rich-content src/components/messages
pnpm typecheck
```

## Task 8: Add Chat Attachment Composer UX

**Files — Chat:**
- Create: `src/lib/attachments/types.ts`
- Create: `src/lib/attachments/limits.ts`
- Create: `src/lib/attachments/prepare.ts`
- Create: `src/lib/attachments/prepare.test.ts`
- Create: `src/lib/attachments/upload.ts`
- Create: `src/lib/attachments/upload.test.ts`
- Create: `src/lib/cave-api/attachments.ts`
- Create: `src/components/thread/attachment-tray.tsx`
- Modify: `src/components/thread/composer.tsx`
- Modify: `src/components/thread/composer.test.tsx`
- Create: `src/styles/attachments.css`

- [ ] **Step 1: Write failing preparation and composer tests**

Test picker/paste/drop, 4/10/25 limits, MIME filtering, safe names, preview generation, progress, cancellation, retry, upload IDs, and cleanup on remove/conversation switch/unmount.

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- src/lib/attachments src/components/thread/composer.test.tsx
```

- [ ] **Step 3: Implement bounded preparation and SDK uploads**

Keep originals only in memory until upload completes. Downscale previews, not upload bytes. Revoke every object URL exactly once. Send only returned attachment IDs.

- [ ] **Step 4: Run focused tests**

```bash
pnpm test -- src/lib/attachments src/components/thread/composer.test.tsx
pnpm typecheck
```

## Task 9: Add Explicit Privileged Action Cards

**Files — Chat:**
- Create: `src/lib/cave-api/actions.ts`
- Create: `src/components/actions/action-confirmation.tsx`
- Create: `src/components/actions/github-action-card.tsx`
- Create: `src/components/actions/github-actions.test.tsx`
- Create: `src/styles/actions.css`
- Modify: `src/components/messages/rich-message.tsx`

- [ ] **Step 1: Write proposal-versus-result tests**

Test zero calls during render, exact confirmation summary, cancel, one mutation per confirmation, retry with a fresh key only after an explicit click, offline/revoked disabled state, focus return, and rejected/error presentation.

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- src/components/actions/github-actions.test.tsx
```

- [ ] **Step 3: Implement confirmation and result state**

Every GitHub action kind requires confirmation in Chat, regardless of Cave’s existing private-UI tier. Completed presentation appears only from a successful Cave result.

- [ ] **Step 4: Run action and accessibility tests**

```bash
pnpm test -- src/components/actions src/components/messages
pnpm typecheck
```

## Task 10: Run Phase 4 Real-Authority Conformance

**Files — Cave:**
- Create: `tests/client-v1-rich-actions.spec.ts`

**Files — Chat:**
- Create: `tests/attachments.spec.ts`
- Create: `tests/rich-content.spec.ts`
- Create: `tests/privileged-actions.spec.ts`

**Files — SDK:**
- Create: `tests/live-authorities/phase4.test.ts`

- [ ] **Step 1: Add deterministic transcript and hostile-content fixtures**

Include every rich block, malformed markers, dangerous links, raw HTML, oversized files, revoked scopes, cancellation, rejection, and duplicate confirmation.

- [ ] **Step 2: Run repository-local gates**

```bash
# coven-cave
pnpm lint
pnpm typecheck
pnpm check:tests-wired
pnpm test:api
pnpm test:app
pnpm build

# chat
pnpm typecheck
pnpm test
pnpm build

# sdk
pnpm typecheck
pnpm test
pnpm --recursive build
node scripts/verify-contracts.mjs
```

- [ ] **Step 3: Run real-authority journeys**

```bash
# chat
pnpm test:e2e -- \
  tests/attachments.spec.ts \
  tests/rich-content.spec.ts \
  tests/privileged-actions.spec.ts

# sdk
pnpm exec vitest run tests/live-authorities/phase4.test.ts
```

Expected: all scenarios PASS with no automatic mutation or private-route call.

## Cross-Repository Merge Order

1. Cave attachment/action services and tests.
2. Cave Client v1 routes, fixture export, and capability flags.
3. SDK schema ingestion and typed methods.
4. Chat strict AST and passive renderers.
5. Chat attachment and explicit-action UX.
6. Curated CLI commands.
7. Real-authority conformance.

Chat must hide unsupported controls when connected to an older compatible Cave.

## Exit Gates

- Hostile content causes no script execution, unsafe URL open, arbitrary authenticated GET, or automatic mutation.
- Cave and clients enforce four files, 10 MiB/file, and 25 MiB/request.
- Attachment bytes never enter localStorage, IndexedDB, drafts, diagnostics, or encrypted read cache.
- Reloaded attachments come from canonical Cave storage.
- Scope revocation disables only the affected write feature.
- CLI privileged commands require explicit non-interactive confirmation.
- Dark, light, high-contrast, narrow, and reduced-motion rich-content snapshots pass.

## Bead Mapping

| Title | Type | Priority | Labels | Dependencies |
|---|---|---:|---|---|
| Phase 4: Rich content, attachments, and privileged actions | epic | P1 | `program:chat-v1,phase:4,cross-repo` | Phase 3 completion gate |
| Cave Client v1: add bounded canonical attachment transport | feature | P1 | `repo:coven-cave,phase:4,attachments,security` | Phase 3 Cave mutation ledger |
| Cave Client v1: delegate attention, task, and GitHub actions | feature | P1 | `repo:coven-cave,phase:4,actions,security` | Phase 3 Cave send/idempotency |
| Cave Client v1: export Phase 4 contract fixture | task | P1 | `repo:coven-cave,phase:4,contract` | both Cave Phase 4 features |
| SDK: add capability-gated attachment and privileged-action APIs | feature | P1 | `repo:sdk,phase:4,cave-client,cli` | Phase 4 fixture |
| Chat: implement strict rich-content AST and passive renderers | feature | P1 | `repo:chat,phase:4,rich-content,a11y` | Phase 4 fixture; Phase 3 transcript |
| Chat: add attachment preparation, upload, and composer UX | feature | P1 | `repo:chat,phase:4,attachments` | Cave attachments; SDK methods; Chat AST |
| Chat: add explicitly confirmed privileged action cards | feature | P1 | `repo:chat,phase:4,actions` | Cave actions; SDK methods; Chat AST |
| Phase 4: run rich-content, attachment, and action conformance | task | P1 | `cross-repo,phase:4,e2e` | all Phase 4 implementation beads |

