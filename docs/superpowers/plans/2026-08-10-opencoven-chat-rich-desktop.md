# OpenCoven Chat Rich Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete OpenCoven Chat with safe rich Cave messages, attachments and authorized actions, native shortcuts/notifications/settings, accessibility, visual polish, and cross-platform packaging.

**Architecture:** Rich marker parsing is a pure, strict data transformation separated from rendering and action execution. Renderers receive validated view models; mutation cards require an explicit user gesture and call only scoped Cave endpoints. Native features remain narrow Tauri commands/plugins and cannot grant the webview shell or arbitrary filesystem authority.

**Tech Stack:** React 19, TypeScript 6, sanitized Markdown, Tauri 2 plugins, Vitest/Testing Library, Playwright, Rust platform tests.

**Depends on:** `2026-08-10-opencoven-chat-core.md`

**Repository:** `/Users/buns/Documents/GitHub/OpenCoven/chat`

**Commit policy:** Every commit step is a proposed checkpoint. Do not execute it without Val's explicit approval.

---

## File Structure

- `src/lib/rich-content/` parses markers into strict discriminated unions.
- `src/components/messages/` renders one component per semantic family.
- `src/components/actions/` owns confirmation and Cave mutation calls.
- `src/lib/attachments/` prepares local previews/uploads and validates client limits.
- `src/components/settings/` owns local-only settings and diagnostics.
- `src-tauri/src/desktop.rs` owns shortcut, notification, single-instance, and deep-link commands.

### Task 1: Define a strict rich-content AST

**Files:**
- Create: `src/lib/rich-content/types.ts`
- Create: `src/lib/rich-content/parser.ts`
- Create: `src/lib/rich-content/parser.test.ts`
- Create: `src/lib/rich-content/fixtures.ts`

- [ ] **Step 1: Write parser tests for every supported marker**

Cover `coven:github`, `coven:github-action`, `coven:image`, fenced `spec`,
`coven:skill`, `coven:auto-status`, `coven:attention`, citations, task handoffs,
and tool/progress events. Test malformed quotes, duplicate attributes, unknown
attributes, unsupported kinds, nested markers, script-like values, and markers
inside code fences.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- src/lib/rich-content/parser.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the discriminated union and one-pass parser**

Use:

```ts
export type RichBlock =
  | { type: "markdown"; markdown: string }
  | { type: "image"; src: string; alt: string; caption?: string; group?: string }
  | { type: "github"; kind: "pr" | "issue" | "commit" | "run"; repo: string; ref: string }
  | { type: "github-action"; action: GitHubActionInput }
  | { type: "spec"; title: string; markdown: string }
  | { type: "citation"; index: number; url: string; title: string; summary: string }
  | { type: "skill"; name: string; stage: "loaded" | "running" | "done" | "error"; note?: string }
  | { type: "auto-status"; state: "clarifying" | "working" | "blocked" | "failed" | "done"; note?: string }
  | { type: "attention"; reason: "input" | "approval" | "credentials" | "decision" }
  | { type: "task-handoff"; taskId: string; title: string; status: "proposed" | "created" | "failed" }
  | { type: "progress"; id: string; label: string; detail?: string; status: "pending" | "running" | "done" | "error" }
  | { type: "tool"; id: string; name: string; status: "running" | "done" | "error"; detail?: string }
  | { type: "unsupported"; source: string; reason: string };
```

Do not parse markers inside fenced code. Unknown/malformed markers become
`unsupported`, never executable action models. Accept image sources only for
`https:`, `data:image/*;base64`, and same-origin `/api/`.

- [ ] **Step 4: Run parser tests and typecheck**

Run: `pnpm test -- src/lib/rich-content/parser.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the parser checkpoint**

```bash
git add src/lib/rich-content
git commit -m "feat: parse safe Cave rich content"
```

### Task 2: Render Markdown, code, images, citations, and specifications

**Files:**
- Create: `src/components/messages/rich-message.tsx`
- Create: `src/components/messages/markdown-block.tsx`
- Create: `src/components/messages/code-block.tsx`
- Create: `src/components/messages/image-gallery.tsx`
- Create: `src/components/messages/citation-list.tsx`
- Create: `src/components/messages/spec-card.tsx`
- Create: `src/components/messages/content-renderers.test.tsx`
- Create: `src/styles/messages.css`
- Modify: `src/components/thread/message-list.tsx`

- [ ] **Step 1: Write rendering and safety tests**

Test headings/lists/tables/code, copy feedback, horizontal code scroll, image
carousel grouping, alt text, failed image state, citation URL display, spec
reader dialog focus trap, raw HTML stripping, `javascript:` link rejection, and
unknown-marker source display.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- src/components/messages/content-renderers.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement safe renderers**

Markdown uses the existing sanitized basic renderer. Links add
`rel="noreferrer noopener"` and open through a Tauri external-open command after
URL allowlisting. The spec dialog uses `aria-modal`, focus trap, Escape close,
and focus return. Image groups render one keyboard-navigable carousel.

- [ ] **Step 4: Run renderer and accessibility tests**

Run: `pnpm test -- src/components/messages/content-renderers.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit document/media rendering**

```bash
git add src/components/messages src/styles/messages.css src/components/thread/message-list.tsx
git commit -m "feat: render rich chat documents and media"
```

### Task 3: Render status, tool, progress, attention, and handoff cards

**Files:**
- Create: `src/components/messages/status-card.tsx`
- Create: `src/components/messages/progress-card.tsx`
- Create: `src/components/messages/tool-card.tsx`
- Create: `src/components/messages/attention-card.tsx`
- Create: `src/components/messages/task-handoff-card.tsx`
- Create: `src/components/messages/status-renderers.test.tsx`

- [ ] **Step 1: Write semantic-state tests**

Cover every skill/auto state, progress replacement by stable ID, running
announcement without noisy delta announcements, collapsed tool details,
attention reason labels, task handoff success/failure, and color-independent
icons/text.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- src/components/messages/status-renderers.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement status renderers**

Cards receive validated AST only. Attention and task responses use fresh
idempotency keys, disable while pending/offline, announce outcomes, and show
server errors without switching to a completed visual state.

- [ ] **Step 4: Run status tests**

Run: `pnpm test -- src/components/messages/status-renderers.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit status semantics**

```bash
git add src/components/messages
git commit -m "feat: render Cave status and attention cards"
```

### Task 4: Add GitHub item and explicit action cards

**Files:**
- Create: `src/components/messages/github-card.tsx`
- Create: `src/components/actions/github-action-card.tsx`
- Create: `src/components/actions/action-confirmation.tsx`
- Create: `src/components/actions/github-actions.test.tsx`

- [ ] **Step 1: Write proposal-versus-result tests**

Test PR/issue/commit/run identity, repository validation, confirmation dialog,
cancel, one mutation per click, `confirmed: true`, idempotency header, pending
state, successful result, rejection result, offline disabled state, and no
automatic execution while rendering.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- src/components/actions/github-actions.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement explicit action flow**

Rendering a `github-action` block creates a proposal card only. A user gesture
opens confirmation containing the exact repository, item, action, and body.
Only confirmation calls `/api/client/v1/github/actions`; only a successful Cave
response adds a completed result state.

- [ ] **Step 4: Run action tests**

Run: `pnpm test -- src/components/actions/github-actions.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit authorized GitHub cards**

```bash
git add src/components/messages/github-card.tsx src/components/actions
git commit -m "feat: add confirmed GitHub action cards"
```

### Task 5: Add attachment selection, preparation, upload, paste, and drop

**Files:**
- Create: `src/lib/attachments/types.ts`
- Create: `src/lib/attachments/prepare.ts`
- Create: `src/lib/attachments/prepare.test.ts`
- Create: `src/lib/attachments/upload.ts`
- Create: `src/lib/attachments/upload.test.ts`
- Create: `src/components/thread/attachment-tray.tsx`
- Modify: `src/components/thread/composer.tsx`
- Modify: `src/components/thread/composer.test.tsx`

- [ ] **Step 1: Write preparation and composer tests**

Cover supported MIME types, four-file cap, 10 MiB/file and 25 MiB/request,
filename sanitization, object-URL cleanup, image dimension/thumbnail behavior,
upload progress, cancellation, retry, paste, drag/drop, and send blocked until
uploads complete.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- src/lib/attachments src/components/thread/composer.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement bounded preparation and multipart upload**

Use object URLs only for transient previews. Downscale preview images, not
original upload bytes. Upload to Cave, retain returned attachment IDs in
composer state, and include only IDs in send. Revoke object URLs on remove,
conversation switch, and unmount. Never put base64 attachment data in web
storage or encrypted read cache.

- [ ] **Step 4: Run attachment tests**

Run: `pnpm test -- src/lib/attachments src/components/thread/composer.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit attachment UX**

```bash
git add src/lib/attachments src/components/thread
git commit -m "feat: add secure chat attachments"
```

### Task 6: Add settings and connection diagnostics

**Files:**
- Create: `src/lib/preferences/schema.ts`
- Create: `src/lib/preferences/store.ts`
- Create: `src/lib/preferences/store.test.ts`
- Create: `src/components/settings/settings-dialog.tsx`
- Create: `src/components/settings/appearance-settings.tsx`
- Create: `src/components/settings/chat-settings.tsx`
- Create: `src/components/settings/connection-settings.tsx`
- Create: `src/components/settings/settings.test.tsx`
- Create: `src/styles/settings.css`

- [ ] **Step 1: Write preference migration and settings tests**

Test schema version migration, corrupt preference error/reset, appearance,
reduced motion, notifications, startup behavior, default familiar/project,
diagnostic copy, endpoint display, paired credential state, re-pair, and app/API
versions.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- src/lib/preferences src/components/settings/settings.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement local-only preferences**

Persist only:

```ts
type PreferencesV1 = {
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

Do not expose or render bearer tokens. Diagnostics show endpoint, API version,
instance ID suffix, state, last successful health time, and sanitized error
code/diagnostic ID.

- [ ] **Step 4: Run settings tests**

Run: `pnpm test -- src/lib/preferences src/components/settings/settings.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit settings**

```bash
git add src/lib/preferences src/components/settings src/styles/settings.css
git commit -m "feat: add Chat settings and diagnostics"
```

### Task 7: Add quick-chat shortcut, notifications, deep links, and single instance

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`
- Create: `src-tauri/src/desktop.rs`
- Create: `src/lib/native/desktop.ts`
- Create: `src/lib/native/desktop.test.ts`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write Rust and TypeScript lifecycle tests**

Cover shortcut registration/re-registration/conflict, bringing the existing
window forward, `opencoven-chat://conversation/<id>` validation, notification
permission/disabled state, no notification for the foreground selected thread,
and window-state restoration within visible monitor bounds.

- [ ] **Step 2: Implement least-privilege native plugins**

Register global shortcut, notification, single-instance, deep-link, opener, and
window-state plugins with only required capabilities. Do not grant shell execute,
arbitrary filesystem, or unrestricted URL-open permission.

- [ ] **Step 3: Implement UI integration**

Quick chat focuses/opens the app and selects the default familiar without
creating a canonical conversation until send. Notifications include familiar
name and conversation title but not full sensitive prompt content.

- [ ] **Step 4: Run native lifecycle tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml desktop && pnpm test -- src/lib/native/desktop.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit native desktop behavior**

```bash
git add src-tauri src/lib/native
git commit -m "feat: add native Chat desktop lifecycle"
```

### Task 8: Complete visual, keyboard, accessibility, and resilience coverage

**Files:**
- Create: `tests/visual-states.spec.ts`
- Create: `tests/keyboard-a11y.spec.ts`
- Create: `tests/rich-content.spec.ts`
- Create: `tests/disconnected.spec.ts`
- Modify: component/style files only for discovered defects

- [ ] **Step 1: Add deterministic visual states**

Capture empty, populated, long code, image carousel, all card families,
attachment failure, pairing, incompatible, offline, narrow 820px, light, dark,
high contrast, and reduced-motion states.

- [ ] **Step 2: Add complete keyboard paths**

Test skip link, sidebar row navigation, filter/search, new chat, composer,
attachment remove, stop/retry, card confirmation, spec reader, settings, Escape,
focus return, and no keyboard traps.

- [ ] **Step 3: Add disconnection and hostile-content scenarios**

Test malformed markers, dangerous links, raw HTML, oversized attachment, token
revocation, Cave restart, stream replay gap, server 500, and rejected rich
action. Verify errors stay errors and no card becomes success-shaped.

- [ ] **Step 4: Run web release gates**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e -- tests/visual-states.spec.ts tests/keyboard-a11y.spec.ts tests/rich-content.spec.ts tests/disconnected.spec.ts
```

Expected: all commands PASS with reviewed snapshots.

- [ ] **Step 5: Commit resilience coverage**

```bash
git add src tests
git commit -m "test: cover rich desktop resilience"
```

### Task 9: Package and validate macOS, Windows, and Linux

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `scripts/verify-package.mjs`
- Create: platform icons under `src-tauri/icons/`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `README.md`

- [ ] **Step 1: Add cross-platform CI**

Matrix `macos-latest`, `windows-latest`, and `ubuntu-latest`; install pnpm/Rust/
Tauri prerequisites; run typecheck, unit tests, Rust tests, build, and
`tauri build --no-bundle` before artifact packaging.

- [ ] **Step 2: Add package assertions**

`verify-package.mjs` asserts product identifiers, CSP, minimum window size,
registered protocols, icons, updater metadata shape, and absence of shell/
filesystem capabilities.

- [ ] **Step 3: Configure signed release jobs**

Release workflow consumes repository secrets only through platform signing
steps, emits macOS/Windows/Linux assets plus checksums/update metadata, and never
prints credentials. Keep publishing manual until Val explicitly authorizes a
release.

- [ ] **Step 4: Run local final gates**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
node scripts/verify-package.mjs
pnpm build:app
```

Expected: all commands PASS and the local platform bundle opens, pairs, reads,
sends, resumes, and renders rich cards against the real Cave Client v1 branch.

- [ ] **Step 5: Commit the release-ready desktop app**

```bash
git add .github scripts src-tauri README.md
git commit -m "build: prepare OpenCoven Chat desktop releases"
```

## Completion Boundary

Do not add voice, group chat, canvas, terminal, code-inspector, or offline-write
features while executing this plan. Any such request needs a separate approved
design and implementation plan.
