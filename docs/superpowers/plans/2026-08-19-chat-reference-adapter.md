# Chat Reference Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the polished Minimal Chat demo behind a framework-neutral adapter contract and add a discreet, accurate “Build with the OpenCoven SDK” path.

**Architecture:** Domain state and actions move into an `OpenCovenChatAdapter`; React subscribes through `useSyncExternalStore` and retains only ephemeral sheet/input state. The deterministic demo adapter implements the same contract that the Phase 1–3 SDK adapter will implement, without adding a public package or pretending preview APIs are currently released.

**Tech Stack:** React 19.2.8, TypeScript 6.0.3, Vitest 4.1.10, Testing Library, Vite 8.2.1, Tauri 2.11.x.

---

## File Map

- Create `src/reference-app/types.ts`: presentation-safe state and action contract.
- Create `src/reference-app/store.ts`: small observable store used by adapters.
- Create `src/reference-app/store.test.ts`: snapshot/subscription/action invariants.
- Create `src/reference-app/react.ts`: `useOpenCovenChat` hook.
- Create `src/reference-app/demo-adapter.ts`: deterministic demo implementation.
- Create `src/reference-app/demo-adapter.test.ts`: domain action and error-state tests.
- Create `src/reference-app/contract-fixture.ts`: deterministic adapter contract manifest.
- Create `src/reference-app/contract-fixture.test.ts`: stable serialization and preview labels.
- Modify `src/demo/minimal-macos.tsx`: render adapter snapshots and dispatch actions.
- Modify `src/demo/minimal-macos.test.tsx`: run shared UI assertions against injected adapter.
- Modify `src/demo/settings-page.tsx`: add discreet SDK reference links.
- Modify `src/demo/minimal-macos.css`: style product-first SDK attribution.
- Create `docs/build-with-opencoven-sdk.md`: layered product-to-SDK guide.
- Modify `README.md`: identify Chat as the reference implementation.

## Task 1: Define the Presentation-Safe Adapter Contract

**Files:**
- Create: `src/reference-app/types.ts`
- Create: `src/reference-app/store.ts`
- Test: `src/reference-app/store.test.ts`

- [ ] **Step 1: Write the failing store contract tests**

```ts
import { createReferenceStore } from './store';
import type { ChatViewModel } from './types';

const INITIAL: ChatViewModel = {
  connection: { kind: 'demo', label: 'Demo data' },
  navigation: { conversations: [], familiars: [], selectedConversationId: null },
  conversation: {
    title: 'No conversation',
    messages: [],
    readState: 'ready',
    pendingApproval: null,
  },
  composer: { mode: 'plan', disabled: false, status: 'idle' },
};

it('publishes immutable snapshots and notifies once per committed change', () => {
  const store = createReferenceStore(INITIAL);
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);

  store.update((state) => ({
    ...state,
    composer: { ...state.composer, mode: 'do' },
  }));

  expect(listener).toHaveBeenCalledTimes(1);
  expect(store.snapshot().composer.mode).toBe('do');
  expect(store.snapshot()).not.toBe(INITIAL);

  unsubscribe();
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
corepack pnpm@10.34.0 test -- src/reference-app/store.test.ts
```

Expected: failure because `types.ts` and `store.ts` do not exist.

- [ ] **Step 3: Implement the contract types**

```ts
export type ConnectionViewModel =
  | { kind: 'demo'; label: string }
  | { kind: 'locating'; label: string }
  | { kind: 'pairing'; label: string; expiresAt: number }
  | { kind: 'connected'; label: string }
  | { kind: 'incompatible'; label: string; minimumClientVersion: string }
  | { kind: 'revoked'; label: string }
  | { kind: 'unavailable'; label: string; retryable: boolean };

export type ReferenceMessage = {
  id: string;
  author: 'user' | 'familiar' | 'system';
  familiarId?: string;
  text: string;
  state: 'complete' | 'streaming' | 'interrupted' | 'failed';
};

export type ChatViewModel = {
  connection: ConnectionViewModel;
  navigation: {
    conversations: ReadonlyArray<{ id: string; title: string; familiarId: string }>;
    familiars: ReadonlyArray<{ id: string; name: string; role: string; status: string }>;
    selectedConversationId: string | null;
  };
  conversation: {
    title: string;
    messages: ReadonlyArray<ReferenceMessage>;
    readState: 'ready' | 'degraded' | 'reconciling';
    pendingApproval: null | {
      id: string;
      title: string;
      description: string;
      reversible: boolean;
    };
  };
  composer: {
    mode: 'plan' | 'ask' | 'do';
    disabled: boolean;
    status: 'idle' | 'sending' | 'streaming' | 'interrupted' | 'ambiguous';
  };
};

export type CreateConversationInput = {
  familiarId: string;
  projectId: string | null;
};

export type SendMessageInput = {
  text: string;
  mode: ChatViewModel['composer']['mode'];
};

export type ChatActions = {
  connect(): Promise<void>;
  selectConversation(id: string): void;
  createConversation(input: CreateConversationInput): Promise<void>;
  setComposerMode(mode: ChatViewModel['composer']['mode']): void;
  send(input: SendMessageInput): Promise<void>;
  stop(runId: string): Promise<void>;
  retry(turnId: string): Promise<void>;
  resolveApproval(id: string, decision: 'deny' | 'allow-once' | 'allow-project'): void;
};

export type OpenCovenChatAdapter = {
  subscribe(listener: (viewModel: ChatViewModel) => void): () => void;
  snapshot(): ChatViewModel;
  actions: ChatActions;
};
```

- [ ] **Step 4: Implement the observable store**

```ts
export function createReferenceStore(initial: ChatViewModel) {
  let current = initial;
  const listeners = new Set<(viewModel: ChatViewModel) => void>();

  return {
    snapshot: () => current,
    subscribe(listener: (viewModel: ChatViewModel) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(reducer: (state: ChatViewModel) => ChatViewModel) {
      const next = reducer(current);
      if (Object.is(next, current)) return;
      current = next;
      for (const listener of listeners) listener(current);
    },
  };
}
```

- [ ] **Step 5: Run tests and commit**

```bash
corepack pnpm@10.34.0 test -- src/reference-app/store.test.ts
git add src/reference-app
git commit -m "feat: define the Chat reference adapter contract" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: focused tests pass.

## Task 2: Implement the Deterministic Demo Adapter

**Files:**
- Create: `src/reference-app/demo-adapter.ts`
- Test: `src/reference-app/demo-adapter.test.ts`
- Reuse: `src/demo/minimal-mock.ts`
- Reuse: `src/demo/minimal-familiar-sdk.ts`

- [ ] **Step 1: Write failing adapter action tests**

Cover:

```ts
it('selects a canonical conversation without changing fixture identity');
it('sends exactly one input user message and one mode-shaped familiar response');
it('creates a conversation from a familiar and optional canonical project id');
it('stops a streaming run while preserving its partial output');
it('records approval denial as a system message');
it('records project-scoped approval distinctly from one-time approval');
it('preserves interrupted partial output for retry');
it('represents degraded reads, reconciliation, and ambiguous completion explicitly');
it('labels every snapshot as deterministic demo data');
```

Use fake timers only for the documented response delay and assert that advancing
the timer once cannot create duplicate replies.

- [ ] **Step 2: Run the tests and verify RED**

```bash
corepack pnpm@10.34.0 test -- src/reference-app/demo-adapter.test.ts
```

Expected: failure because `createDemoChatAdapter` does not exist.

- [ ] **Step 3: Implement `createDemoChatAdapter`**

The constructor accepts deterministic dependencies:

```ts
export type DemoAdapterOptions = {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => number;
};

export function createDemoChatAdapter(
  options: DemoAdapterOptions = {},
): OpenCovenChatAdapter;
```

Use `MINIMAL_CHATS`, `minimalTranscript`, and familiar fixtures to build the
initial snapshot. Keep generated IDs deterministic within one adapter instance.
Approval decisions append explicit system messages. `send()` sets `sending`,
appends the user turn, then appends one familiar turn shaped by the selected
mode.

- [ ] **Step 4: Run adapter and existing demo tests**

```bash
corepack pnpm@10.34.0 test -- \
  src/reference-app/demo-adapter.test.ts \
  src/demo/minimal-macos.test.tsx
```

Expected: adapter tests pass; existing UI tests still pass before refactoring.

- [ ] **Step 5: Commit**

```bash
git add src/reference-app/demo-adapter* src/demo/minimal-mock.ts
git commit -m "feat: add a deterministic Chat demo adapter" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 3: Render the Minimal Surface Through the Adapter

**Files:**
- Create: `src/reference-app/react.ts`
- Modify: `src/demo/minimal-macos.tsx`
- Modify: `src/demo/minimal-macos.test.tsx`

- [ ] **Step 1: Write a failing injected-adapter UI test**

```tsx
it('renders a supplied adapter and dispatches through its actions', () => {
  const adapter = createDemoChatAdapter();
  const selectConversation = vi.spyOn(adapter.actions, 'selectConversation');

  render(<MinimalMacOS adapter={adapter} />);
  fireEvent.click(screen.getByRole('button', { name: /^Cody/ }));

  expect(selectConversation).toHaveBeenCalledWith('c1');
});
```

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm@10.34.0 test -- src/demo/minimal-macos.test.tsx
```

Expected: failure because `MinimalMacOS` does not accept an adapter.

- [ ] **Step 3: Add the React subscription hook**

```ts
import { useSyncExternalStore } from 'react';

export function useOpenCovenChat(adapter: OpenCovenChatAdapter): ChatViewModel {
  return useSyncExternalStore(
    (notify) => adapter.subscribe(() => notify()),
    adapter.snapshot,
    adapter.snapshot,
  );
}
```

- [ ] **Step 4: Refactor domain state and actions**

`MinimalMacOS` accepts:

```ts
type MinimalMacOSProps = {
  adapter?: OpenCovenChatAdapter;
};
```

Create the default demo adapter once per component instance. Replace local
conversation, transcript, composer mode, send, stop, retry, creation, and
approval decision state with adapter snapshot/action calls. Keep the unsent
composer draft, sheet visibility, project-picker visibility, image zoom,
toasts, and focus restoration in React because they are ephemeral presentation
state. Pass the draft and selected mode to `actions.send({ text, mode })`.

- [ ] **Step 5: Run the full Minimal surface tests**

```bash
corepack pnpm@10.34.0 test -- \
  src/reference-app \
  src/demo/minimal-macos.test.tsx
corepack pnpm@10.34.0 typecheck
```

Expected: all behavior remains visible and the adapter injection test passes.

- [ ] **Step 6: Commit**

```bash
git add src/reference-app/react.ts src/demo/minimal-macos.tsx \
  src/demo/minimal-macos.test.tsx
git commit -m "refactor: render Chat through the reference adapter" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 4: Export a Checked Reference Contract

**Files:**
- Create: `src/reference-app/contract-fixture.ts`
- Create: `src/reference-app/contract-fixture.test.ts`
- Create: `scripts/export-reference-app-contract.mjs`
- Create: `reference-app-contract.json`
- Create: `reference-app-contract.sha256`
- Modify: `package.json`

- [ ] **Step 1: Write failing deterministic fixture tests**

Assert:

```ts
expect(manifest.version).toBe(1);
expect(manifest.capabilities.current).toEqual(['health']);
expect(manifest.capabilities.preview.phase1).toContain('pairing');
expect(manifest.capabilities.preview.phase2).toContain('canonical-reads');
expect(manifest.capabilities.preview.phase3).toContain('resumable-streams');
expect(exportTwice()).toProduceIdenticalBytes();
expect(staleDigest()).toFailWith('reference app contract digest mismatch');
```

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm@10.34.0 test -- src/reference-app/contract-fixture.test.ts
```

- [ ] **Step 3: Implement the manifest and exporter**

The JSON contains only stable names, state discriminants, action names, current
capabilities, preview capability labels, and fixture IDs. It contains no
messages, secrets, endpoints, local paths, or timestamps.

- [ ] **Step 4: Wire scripts**

```json
{
  "scripts": {
    "reference:export": "node scripts/export-reference-app-contract.mjs",
    "reference:check": "node scripts/export-reference-app-contract.mjs --check"
  }
}
```

- [ ] **Step 5: Generate, test, and commit**

```bash
corepack pnpm@10.34.0 reference:export
corepack pnpm@10.34.0 reference:check
corepack pnpm@10.34.0 test -- src/reference-app/contract-fixture.test.ts
git add package.json scripts/export-reference-app-contract.mjs \
  src/reference-app/contract-fixture* reference-app-contract.*
git commit -m "test: export the Chat reference adapter contract" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 5: Add Product-First SDK Discoverability

**Files:**
- Modify: `src/demo/settings-page.tsx`
- Modify: `src/demo/minimal-macos.tsx`
- Modify: `src/demo/minimal-macos.css`
- Modify: `src/demo/minimal-macos.test.tsx`

- [ ] **Step 1: Write failing discoverability tests**

Assert that Settings/About contains:

```text
Built with OpenCoven SDK
Build your own
```

Also assert those phrases do not appear in the main conversation landmark or
composer.

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm@10.34.0 test -- src/demo/minimal-macos.test.tsx
```

- [ ] **Step 3: Implement discreet attribution**

Add a final About section in Settings with product version, SDK attribution,
and a normal link to `docs/build-with-opencoven-sdk.md`. Do not add a Builder
Mode, debug rail, schema viewer, or persistent product chrome.

- [ ] **Step 4: Run accessibility and UI tests**

```bash
corepack pnpm@10.34.0 test -- src/demo/minimal-macos.test.tsx
corepack pnpm@10.34.0 typecheck
corepack pnpm@10.34.0 build
```

- [ ] **Step 5: Commit**

```bash
git add src/demo/settings-page.tsx src/demo/minimal-macos.tsx \
  src/demo/minimal-macos.css src/demo/minimal-macos.test.tsx
git commit -m "feat: add a discreet SDK builder path" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 6: Write the Layered Chat Integration Guide

**Files:**
- Create: `docs/build-with-opencoven-sdk.md`
- Modify: `README.md`
- Modify: `src/specification-guards.test.ts`

- [ ] **Step 1: Write failing documentation guard tests**

Check that the guide contains:

```text
Available now
Phase 1 preview
Phase 2 preview
Phase 3 preview
Replace the interface
Security boundary
```

Check every referenced local path exists and every shell command names a real
package script.

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm@10.34.0 test -- src/specification-guards.test.ts
```

- [ ] **Step 3: Write the guide**

Include:

1. five-minute deterministic starter link;
2. authority → SDK client → native port → adapter → UI diagram;
3. exact replace-the-interface steps;
4. React/Tauri and framework-neutral paths;
5. current versus preview badges;
6. normalized error mapping;
7. no bearer/arbitrary URL/canonical browser storage rules;
8. verification commands.

- [ ] **Step 4: Update README**

Lead with Chat as a product. Add one short section identifying it as the
OpenCoven SDK reference implementation and link to the guide.

- [ ] **Step 5: Run docs and repository gates**

```bash
corepack pnpm@10.34.0 test -- src/specification-guards.test.ts
corepack pnpm@10.34.0 lint
corepack pnpm@10.34.0 typecheck
corepack pnpm@10.34.0 test
corepack pnpm@10.34.0 build
cargo test --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 6: Commit**

```bash
git add README.md docs/build-with-opencoven-sdk.md src/specification-guards.test.ts
git commit -m "docs: explain how to remake Chat with the SDK" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 7: Add Keyboard, Reduced-Motion, and Screenshot Coverage

**Files:**
- Create: `e2e/reference-showcase.spec.ts`
- Create: `e2e/__screenshots__/minimal-reference.png`
- Modify: `playwright.config.ts`
- Modify: `src/demo/minimal-macos.css`

- [ ] **Step 1: Write the failing browser checks**

```ts
test.use({ reducedMotion: 'reduce' });

test('keeps the reference surface keyboard reachable and motion-safe', async ({ page }) => {
  await page.goto('/?demo=minimal');
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /All projects|selected/ })).toBeFocused();

  await page.getByRole('button', { name: /Settings/ }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).not.toBeVisible();

  await expect(page.locator('.mm-desktop')).toHaveScreenshot('minimal-reference.png', {
    animations: 'disabled',
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
corepack pnpm@10.34.0 test:e2e -- e2e/reference-showcase.spec.ts
```

Expected: missing snapshot and any undiscovered focus/motion issues fail.

- [ ] **Step 3: Fix only task-related accessibility defects**

Add or correct focus order, dialog names, status live regions, and
`@media (prefers-reduced-motion: reduce)` rules. Do not redesign the surface or
change product behavior to satisfy pixel output.

- [ ] **Step 4: Use a deterministic snapshot path**

Add:

```ts
snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
```

to `playwright.config.ts`, so the committed baseline has one documented path.

- [ ] **Step 5: Generate and verify the screenshot**

```bash
corepack pnpm@10.34.0 test:e2e -- e2e/reference-showcase.spec.ts --update-snapshots
corepack pnpm@10.34.0 test:e2e -- e2e/reference-showcase.spec.ts
```

Expected: keyboard, reduced-motion, accessible-role, and screenshot checks pass.

- [ ] **Step 6: Commit**

```bash
git add e2e/reference-showcase.spec.ts e2e/__screenshots__/minimal-reference.png \
  playwright.config.ts src/demo/minimal-macos.css
git commit -m "test: cover the SDK reference showcase experience" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
