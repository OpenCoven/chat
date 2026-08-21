# Chat Contextual Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat demo's redundant surface rail with independently collapsible conversations and a contextual right-side agent inspector styled as restrained dark-grey liquid glass.

**Architecture:** Keep `ChatDemo` as the owner of conversation and shell state, add `familiarId` to the local conversation fixture, and introduce one focused `ChatInspector` component for agent tabs and the secondary app-settings view. CSS grid variables own desktop panel widths; a narrow-window media query turns panels into overlays without changing the DOM or authority boundaries.

**Tech Stack:** React 19, TypeScript 6, CSS, Vitest, Testing Library, Vite 8

---

## File Structure

- Modify `src/demo/mock-data.ts` to bind each mock conversation to a familiar.
- Create `src/demo/chat-inspector.tsx` to render Overview, Access, Activity, and App settings.
- Create `src/demo/chat-inspector.test.tsx` for inspector data, navigation, and empty-state behavior.
- Modify `src/demo/chat-demo.tsx` to remove the surface rail, own panel state, and render `ChatInspector`.
- Modify `src/demo/settings-page.tsx` to export its existing mock health and credential contracts for the compact settings view.
- Create `src/demo/chat-shell.test.tsx` for rail removal and independent collapse behavior.
- Modify `src/demo/chat-demo.css` to implement the graphite palette, glass material, three-column shell, closed states, and narrow overlays.

The existing `familiars-page.tsx` and `settings-page.tsx` remain intact but stop being reachable from `DemoShell`. The separate `minimal-macos` files do not change.

### Task 1: Bind Conversations to Familiar Identity

**Files:**
- Modify: `src/demo/mock-data.ts:42-85`
- Test: `src/demo/chat-shell.test.tsx`

- [ ] **Step 1: Write the failing fixture test**

Create `src/demo/chat-shell.test.tsx` with the binding assertion:

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';

import { DemoShell } from './chat-demo';
import { MOCK_CONVERSATIONS } from './mock-data';
import { MOCK_FAMILIARS } from './mock-familiars';

describe('chat demo shell', () => {
  it('binds every conversation to a known familiar', () => {
    const familiarIds = new Set(MOCK_FAMILIARS.map((familiar) => familiar.id));

    expect(MOCK_CONVERSATIONS.every((conversation) => familiarIds.has(conversation.familiarId)))
      .toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the type failure**

Run:

```bash
corepack pnpm exec vitest run src/demo/chat-shell.test.tsx
```

Expected: FAIL because `MockConversation` has no `familiarId`.

- [ ] **Step 3: Add the binding to the type and fixtures**

Update `MockConversation` and both fixtures:

```ts
export type MockConversation = {
  id: string;
  familiarId: string;
  title: string;
  preview: string;
  previewGlyph?: string;
  timestamp: string;
  openedAt: string;
  messages: MockMessage[];
};

// In the first fixture:
id: 'quick-chat',
familiarId: 'astra',
title: 'Quick Chat',

// In the second fixture:
id: 'new-chat',
familiarId: 'cody',
title: 'New Chat',
```

- [ ] **Step 4: Run the focused test**

Run `corepack pnpm exec vitest run src/demo/chat-shell.test.tsx`.

Expected: PASS for `binds every conversation to a known familiar`.

- [ ] **Step 5: Commit the fixture seam**

```bash
git add src/demo/mock-data.ts src/demo/chat-shell.test.tsx
git commit -m "test: bind chat fixtures to familiars"
```

### Task 2: Build the Contextual Agent Inspector

**Files:**
- Create: `src/demo/chat-inspector.tsx`
- Create: `src/demo/chat-inspector.test.tsx`
- Modify: `src/demo/settings-page.tsx:26-43`
- Read: `src/demo/mock-familiars.ts`
- Read: `src/demo/minimal-familiar-sdk.ts`

- [ ] **Step 1: Write failing inspector behavior tests**

Create `src/demo/chat-inspector.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';

import { ChatInspector } from './chat-inspector';
import { MOCK_FAMILIARS } from './mock-familiars';

const astra = MOCK_FAMILIARS.find((familiar) => familiar.id === 'astra');

describe('ChatInspector', () => {
  it('shows the active familiar and its bounded authority', () => {
    render(<ChatInspector familiar={astra} onFamiliarChange={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Astra' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Access' }));
    expect(screen.getByRole('tabpanel', { name: 'Access' })).toHaveTextContent('Must ask');
    expect(screen.getByRole('tabpanel', { name: 'Access' })).toHaveTextContent(
      'publish a finding',
    );
  });

  it('moves between tabs with arrow keys', () => {
    render(<ChatInspector familiar={astra} onFamiliarChange={vi.fn()} onClose={vi.fn()} />);

    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Access' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Access' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens app settings in place and returns to the agent', () => {
    render(<ChatInspector familiar={astra} onFamiliarChange={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'App settings' }));
    expect(screen.getByRole('heading', { name: 'App settings' })).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Notifications' })).toBeChecked();
    fireEvent.click(screen.getByRole('tab', { name: 'Connection' }));
    expect(screen.getByText('cave-7f3a91c2')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy diagnostic report' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Astra' }));
    expect(screen.getByRole('heading', { name: 'Astra' })).toBeVisible();
  });

  it('keeps settings reachable when the familiar is unavailable', () => {
    render(<ChatInspector familiar={undefined} onFamiliarChange={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText('Agent unavailable')).toBeVisible();
    expect(screen.getByRole('button', { name: 'App settings' })).toBeVisible();
  });

  it('reports missing activity as unknown rather than zero percent', () => {
    render(<ChatInspector familiar={undefined} onFamiliarChange={vi.fn()} onClose={vi.fn()} />);

    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the inspector test and confirm the missing-module failure**

Run `corepack pnpm exec vitest run src/demo/chat-inspector.test.tsx`.

Expected: FAIL because `./chat-inspector` does not exist.

- [ ] **Step 3: Create the inspector component and tab contract**

Create `src/demo/chat-inspector.tsx` with these public types and state boundaries:

```tsx
import { type KeyboardEvent, useRef, useState } from 'react';

import {
  CAVE_FAMILIAR_ANALYTICS,
  formatDuration,
  formatSuccessRate,
} from './minimal-familiar-sdk';
import { contractReport, MOCK_FAMILIARS, type MockFamiliar } from './mock-familiars';
import { MOCK_CREDENTIAL, MOCK_HEALTH } from './settings-page';

type InspectorTab = 'overview' | 'access' | 'activity';
type InspectorView = 'agent' | 'app';

export type ChatInspectorProps = Readonly<{
  familiar: MockFamiliar | undefined;
  onClose: () => void;
  onFamiliarChange: (familiarId: string) => void;
}>;

const TABS: readonly InspectorTab[] = ['overview', 'access', 'activity'];

export function ChatInspector({ familiar, onClose, onFamiliarChange }: ChatInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('overview');
  const [view, setView] = useState<InspectorView>('agent');
  const [appTab, setAppTab] = useState<'general' | 'connection'>('general');
  const [notifications, setNotifications] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectTab(next: InspectorTab) {
    setTab(next);
    const index = TABS.indexOf(next);
    tabRefs.current[index]?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? TABS.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    const next = TABS[nextIndex];
    if (next) selectTab(next);
  }

  if (view === 'app') {
    return (
      <section className="chat-inspector app-settings-view" aria-label="App settings">
        <button
          type="button"
          className="inspector-back"
          aria-label={`Back to ${familiar?.name ?? 'agent'}`}
          onClick={() => setView('agent')}
        >
          ‹ <span>{familiar?.name ?? 'Agent'}</span>
        </button>
        <h2>App settings</h2>
        <p className="inspector-subtitle">Device and Cave preferences</p>
        <div className="inspector-tabs" role="tablist" aria-label="App settings sections">
          {(['general', 'connection'] as const).map((name) => (
            <button key={name} type="button" role="tab" aria-selected={appTab === name} onClick={() => setAppTab(name)}>
              {name === 'general' ? 'General' : 'Connection'}
            </button>
          ))}
        </div>
        <div className="inspector-settings" role="tabpanel" aria-label={appTab === 'general' ? 'General' : 'Connection'}>
          {appTab === 'general' ? (
            <>
              <SettingSwitch label="Notifications" checked={notifications} onChange={setNotifications} />
              <SettingSwitch label="Reduce motion" checked={reduceMotion} onChange={setReduceMotion} />
              <SettingSwitch label="Launch at login" checked={launchAtLogin} onChange={setLaunchAtLogin} />
              <SettingRow label="Quick chat" value="⌥ Space" />
              <SettingRow label="Default agent" value={familiar?.name ?? 'Unavailable'} />
            </>
          ) : (
            <>
              <SettingRow label="Cave instance" value={MOCK_HEALTH.instanceId} />
              <SettingRow label="API version" value={`v${MOCK_HEALTH.apiVersion}`} />
              <SettingRow label="Paired client" value={MOCK_CREDENTIAL.label} />
              <button type="button" aria-label="Copy diagnostic report">Copy report</button>
            </>
          )}
        </div>
      </section>
    );
  }

  const analytics = familiar ? CAVE_FAMILIAR_ANALYTICS[familiar.id]?.windows['7d'] : undefined;
  const report = familiar ? contractReport(familiar) : undefined;

  return (
    <section className="chat-inspector" aria-label="Agent inspector">
      <header className="inspector-identity">
        <span className="inspector-mark" aria-hidden="true">{familiar?.emoji ?? '·'}</span>
        <span className="inspector-who">
          <h2>{familiar?.name ?? 'Agent unavailable'}</h2>
          <span>{familiar?.role ?? 'Choose another conversation'}</span>
        </span>
        <button type="button" className="glass-control" aria-label="Hide agent inspector" onClick={onClose}>›</button>
      </header>

      {familiar ? (
        <select
          className="inspector-agent-select"
          aria-label="Agent for this conversation"
          value={familiar.id}
          onChange={(event) => onFamiliarChange(event.target.value)}
        >
          {MOCK_FAMILIARS.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      ) : null}

      <div className="inspector-tabs" role="tablist" aria-label="Agent details">
        {TABS.map((name, index) => (
          <button
            key={name}
            ref={(node) => { tabRefs.current[index] = node; }}
            type="button"
            role="tab"
            aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {name[0]?.toUpperCase()}{name.slice(1)}
          </button>
        ))}
      </div>

      <div className="inspector-panel" role="tabpanel" aria-label={`${tab[0]?.toUpperCase()}${tab.slice(1)}`}>
        {!familiar ? <p className="inspector-empty">Choose a conversation to see its agent.</p> : null}
        {familiar && tab === 'overview' ? <Overview familiar={familiar} /> : null}
        {familiar && tab === 'access' ? <Access familiar={familiar} reportPassed={report?.every((item) => item.pass) ?? false} /> : null}
        {familiar && tab === 'activity' ? <Activity analytics={analytics} /> : null}
      </div>

      <button type="button" className="inspector-app-settings" aria-label="App settings" onClick={() => setView('app')}>
        <span>App settings</span><kbd>⌘,</kbd>
      </button>
    </section>
  );
}
```

In the same file, implement focused `Overview`, `Access`, `Activity`,
`SettingRow`, and `SettingSwitch` components. `Activity` must return `<p>No
recent runs</p>` when `analytics` is absent or `analytics.attempts === 0`;
otherwise it uses `formatSuccessRate(analytics)` and
`formatDuration(analytics.medianDurationMs)`. `Access` renders the exact
`familiar.ward.approvalTiers.auto`, `humanReview`, and `editablePaths` lists so
the assertions above read real fixture data.

Change the two existing constants in `src/demo/settings-page.tsx` from
`const MOCK_HEALTH` and `const MOCK_CREDENTIAL` to `export const MOCK_HEALTH`
and `export const MOCK_CREDENTIAL`. Their values do not change.

- [ ] **Step 4: Run and refine the focused inspector tests**

Run `corepack pnpm exec vitest run src/demo/chat-inspector.test.tsx`.

Expected: all `ChatInspector` tests PASS.

- [ ] **Step 5: Commit the inspector unit**

```bash
git add src/demo/chat-inspector.tsx src/demo/chat-inspector.test.tsx src/demo/settings-page.tsx
git commit -m "feat: add contextual agent inspector"
```

### Task 3: Replace the Surface Rail With the Three-Pane Shell

**Files:**
- Modify: `src/demo/chat-demo.tsx:1-13,350-433,606-832`
- Modify: `src/demo/chat-shell.test.tsx`

- [ ] **Step 1: Add failing shell interaction tests**

Extend `src/demo/chat-shell.test.tsx`:

```tsx
it('keeps Chat as the only primary surface', () => {
  render(<DemoShell />);

  expect(screen.queryByRole('navigation', { name: 'Surfaces' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Familiars' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  expect(screen.getByRole('main')).toBeVisible();
});

it('collapses and restores both side panels independently', () => {
  render(<DemoShell />);

  fireEvent.click(screen.getByRole('button', { name: 'Hide conversations' }));
  expect(screen.queryByRole('complementary', { name: 'Conversations' })).not.toBeVisible();
  expect(screen.getByRole('button', { name: 'Show conversations' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  fireEvent.click(screen.getByRole('button', { name: 'Hide agent inspector' }));
  const header = screen.getByRole('banner');
  expect(within(header).getByRole('button', { name: 'Show conversations' })).toBeVisible();
  expect(within(header).getByRole('button', { name: 'Show agent inspector' })).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: 'Show conversations' }));
  expect(screen.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
});

it('updates the inspector when the active conversation changes agent', () => {
  render(<DemoShell />);

  expect(screen.getByRole('heading', { name: 'Astra' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
  expect(screen.getByRole('heading', { name: 'Cody' })).toBeVisible();
});
```

- [ ] **Step 2: Run the shell tests and confirm the old rail fails them**

Run `corepack pnpm exec vitest run src/demo/chat-shell.test.tsx`.

Expected: FAIL because the rail still renders and panel controls do not exist.

- [ ] **Step 3: Remove surface routing and add shell state**

In `src/demo/chat-demo.tsx`:

- remove imports of `FamiliarsPage` and `SettingsPage`;
- remove `Surface`, `Rail`, and their comments;
- reduce `DemoShell` to `return <ChatDemo />`;
- import `ChatInspector` and `MOCK_FAMILIARS`;
- add `conversationsOpen` and `inspectorOpen` state to `ChatDemo`;
- resolve `activeFamiliar` from `active?.familiarId`;
- add `changeActiveFamiliar` that immutably updates only the active conversation.

Use this outer structure:

```tsx
export function DemoShell() {
  return <ChatDemo />;
}

export function ChatDemo() {
  const [conversations, setConversations] = useState<MockConversation[]>(MOCK_CONVERSATIONS);
  const [conversationsOpen, setConversationsOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  // existing state remains

  const active = conversations.find((conversation) => conversation.id === activeId);
  const activeFamiliar = MOCK_FAMILIARS.find(
    (familiar) => familiar.id === active?.familiarId,
  );

  function changeActiveFamiliar(familiarId: string) {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === activeId ? { ...conversation, familiarId } : conversation,
      ),
    );
  }

  return (
    <div
      className={`chat-demo ${conversationsOpen ? '' : 'is-conversations-closed'} ${
        inspectorOpen ? '' : 'is-inspector-closed'
      }`}
    >
      <aside id="conversation-panel" className="sidebar glass-panel" aria-label="Conversations" hidden={!conversationsOpen}>
        <header className="sidebar-header">
          <h1>Chats</h1>
          <button type="button" className="glass-control" aria-label="Hide conversations" onClick={() => setConversationsOpen(false)}>‹</button>
        </header>
        {/* existing search and conversation list */}
        <button type="button" className="new-conversation">＋ <span>New conversation</span></button>
      </aside>

      <main className="thread">
        <header className="thread-header">
          <button
            type="button"
            className="glass-control"
            aria-label={conversationsOpen ? 'Hide conversations' : 'Show conversations'}
            aria-controls="conversation-panel"
            aria-expanded={conversationsOpen}
            onClick={() => setConversationsOpen((open) => !open)}
          >
            {conversationsOpen ? '‹' : '›'}
          </button>
          <div className="thread-title">
            <Avatar label={activeFamiliar?.name ?? active?.title ?? ''} seed={activeFamiliar?.id ?? active?.id ?? 'none'} size={24} />
            <span>{activeFamiliar?.name ?? 'No agent'}</span>
          </div>
          <button
            type="button"
            className="glass-control"
            aria-label={inspectorOpen ? 'Hide agent inspector' : 'Show agent inspector'}
            aria-controls="agent-inspector"
            aria-expanded={inspectorOpen}
            onClick={() => setInspectorOpen((open) => !open)}
          >
            {inspectorOpen ? '›' : '‹'}
          </button>
        </header>
        {/* existing transcript and composer unchanged */}
      </main>

      <aside id="agent-inspector" aria-label="Agent inspector" hidden={!inspectorOpen}>
        <ChatInspector
          familiar={activeFamiliar}
          onClose={() => setInspectorOpen(false)}
          onFamiliarChange={changeActiveFamiliar}
        />
      </aside>
      {reader ? <DocumentReader document={reader} onClose={() => setReader(null)} /> : null}
    </div>
  );
}
```

Avoid duplicate `Hide conversations` controls while the left panel is open:
the sidebar header owns the expanded-state control, and the thread header left
control renders only while the sidebar is closed. Apply the same rule to the
inspector, whose identity header owns its close control.

- [ ] **Step 4: Run shell and inspector tests**

Run:

```bash
corepack pnpm exec vitest run src/demo/chat-shell.test.tsx src/demo/chat-inspector.test.tsx
```

Expected: both files PASS; existing transcript behavior remains rendered.

- [ ] **Step 5: Commit the shell consolidation**

```bash
git add src/demo/chat-demo.tsx src/demo/chat-shell.test.tsx
git commit -m "feat: consolidate chat navigation into side panels"
```

### Task 4: Apply the Obsidian Lens Visual System

**Files:**
- Modify: `src/demo/chat-demo.css:1-220,850-925`
- Test: `src/demo/chat-shell.test.tsx`

- [ ] **Step 1: Add failing source-contract assertions for material and motion**

Add to `src/demo/chat-shell.test.tsx`:

```tsx
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

it('keeps glass restrained to shell chrome and removes the old rail styles', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/demo/chat-demo.css'), 'utf8');

  expect(css).toContain('--demo-bg: #111216');
  expect(css).toContain('--demo-glass: rgba(37, 38, 44, 0.72)');
  expect(css).toContain('backdrop-filter: blur(24px) saturate(140%)');
  expect(css).toContain('.chat-demo.is-conversations-closed');
  expect(css).toContain('.chat-demo.is-inspector-closed');
  expect(css).toContain('@media (max-width: 820px)');
  expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  expect(css).not.toContain('.rail-button');
});
```

- [ ] **Step 2: Run the source-contract test and confirm it fails**

Run `corepack pnpm exec vitest run src/demo/chat-shell.test.tsx`.

Expected: FAIL on the graphite/glass tokens and old rail selector.

- [ ] **Step 3: Replace the shell and core visual rules**

Update the top-level shell rules in `src/demo/chat-demo.css`:

```css
.chat-demo {
  --demo-bg: #111216;
  --demo-surface: #191a1f;
  --demo-glass: rgba(37, 38, 44, 0.72);
  --demo-selected: rgba(154, 142, 205, 0.14);
  --demo-bubble-theirs: rgba(255, 255, 255, 0.055);
  --demo-bubble-mine: rgba(154, 142, 205, 0.17);
  --demo-violet: #9a8ecd;
  --demo-text: #f4f3f7;
  --demo-muted: #aaa7b0;
  --demo-ready: #82b38e;
  --demo-line: rgba(255, 255, 255, 0.085);
  --demo-conversations-width: minmax(270px, 320px);
  --demo-inspector-width: minmax(300px, 340px);

  display: grid;
  grid-template-columns: var(--demo-conversations-width) minmax(0, 1fr) var(--demo-inspector-width);
  height: 100vh;
  overflow: hidden;
  background: var(--demo-bg);
  color: var(--demo-text);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  font-size: 14px;
  transition: grid-template-columns 200ms cubic-bezier(0.22, 0.72, 0, 1);
}

.chat-demo.is-conversations-closed { --demo-conversations-width: 0px; }
.chat-demo.is-inspector-closed { --demo-inspector-width: 0px; }

.chat-demo .glass-panel,
.chat-demo .chat-inspector,
.chat-demo .composer,
.chat-demo .glass-control {
  border-color: var(--demo-line);
  background: var(--demo-glass);
  backdrop-filter: blur(24px) saturate(140%);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.065);
}

.chat-demo .glass-control {
  position: relative;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--demo-line);
  border-radius: 10px;
  color: #c8c0e6;
}

.chat-demo .sidebar {
  overflow: hidden;
  padding: 12px 10px;
  border-right: 1px solid var(--demo-line);
}

.chat-demo .thread-header {
  display: grid;
  grid-template-columns: 30px 1fr 30px;
  align-items: center;
  padding: 10px 14px;
}

.chat-demo .thread-title { justify-self: center; }

.chat-demo > [aria-label="Agent inspector"] {
  min-width: 0;
  overflow: hidden;
  border-left: 1px solid var(--demo-line);
}
```

Add focused `.chat-inspector`, tab, row, switch, empty-state, and app-settings
rules using the same tokens. Keep message bubbles opaque enough that no
`backdrop-filter` applies to `.bubble`, `.transcript`, `.inspector-panel`, or
`.inspector-row`.

Remove `.demo-shell`, `.demo-surface`, `.rail`, and `.rail-button` rules. Keep
the old `.fam-*` and `.set-*` rules because their components remain in the
repository even though `DemoShell` no longer renders them.

- [ ] **Step 4: Add narrow overlays and reduced motion**

Append:

```css
@media (max-width: 820px) {
  .chat-demo {
    position: relative;
    display: block;
  }

  .chat-demo .thread { height: 100vh; }

  .chat-demo > .sidebar,
  .chat-demo > [aria-label="Agent inspector"] {
    position: absolute;
    z-index: 20;
    top: 0;
    bottom: 0;
    width: min(86vw, 340px);
    box-shadow: 0 22px 64px rgba(0, 0, 0, 0.42);
  }

  .chat-demo > .sidebar { left: 0; }
  .chat-demo > [aria-label="Agent inspector"] { right: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .chat-demo,
  .chat-demo .sidebar,
  .chat-demo .chat-inspector,
  .chat-demo .glass-control {
    transition: none;
  }
}
```

In `ChatDemo`, wrap panel-open setters so `window.matchMedia('(max-width:
820px)').matches` closes the opposite panel before opening one. Add an Escape
effect active only at narrow widths; it closes the visible overlay and leaves
the thread usable.

- [ ] **Step 5: Run focused tests and inspect the live demo**

Run:

```bash
corepack pnpm exec vitest run src/demo/chat-shell.test.tsx src/demo/chat-inspector.test.tsx
```

Then inspect `http://127.0.0.1:4173/?demo=chat` at 1440 x 900, 1024 x 768,
and 760 x 900. Verify both expanded and both closed at desktop width, and each
overlay independently at narrow width.

Expected: tests PASS; no horizontal page scroll; the transcript stays legible;
glass is limited to chrome; the both-closed state leaves only the two restore
controls in the header.

- [ ] **Step 6: Commit the visual system**

```bash
git add src/demo/chat-demo.css src/demo/chat-demo.tsx src/demo/chat-shell.test.tsx
git commit -m "style: refine chat shell with graphite glass"
```

### Task 5: Full Regression and Completion Verification

**Files:**
- Verify: all files changed above

- [ ] **Step 1: Run formatting and lint checks**

Run:

```bash
corepack pnpm format:check
corepack pnpm lint
```

Expected: both commands exit 0. If Biome reports only formatting in changed
files, run `corepack pnpm exec biome format --write` with those explicit file
paths, inspect the diff, and rerun both commands.

- [ ] **Step 2: Run type and unit checks**

Run:

```bash
corepack pnpm typecheck
corepack pnpm test
```

Expected: TypeScript exits 0 and the complete Vitest suite passes.

- [ ] **Step 3: Build the production assets**

Run `corepack pnpm build`.

Expected: Vite exits 0 and emits `dist/` without unresolved imports or CSS
warnings.

- [ ] **Step 4: Perform final visual and accessibility checks**

At `http://127.0.0.1:4173/?demo=chat`:

1. Collapse and restore each panel with pointer and keyboard.
2. Close both panels and verify the thread owns the full width.
3. Switch from Quick Chat to New Chat and verify Astra changes to Cody.
4. Open Access and Activity, then App settings, then return to the agent.
5. At 760 x 900, verify only one overlay opens at a time and Escape closes it.
6. Enable reduced motion and verify the state changes without panel travel.

Expected: every action is visible, keyboard focus remains obvious, no control
is clipped, and `?demo=minimal` remains visually unchanged.

- [ ] **Step 5: Verify the final diff**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~3..HEAD
```

Expected: no whitespace errors, only the planned chat-demo files are changed,
and no unrelated work is present.

- [ ] **Step 6: Commit any verification-only correction**

If verification required a correction, stage only the planned implementation
files that actually changed and commit:

```bash
git add src/demo/mock-data.ts src/demo/chat-inspector.tsx src/demo/chat-inspector.test.tsx src/demo/chat-demo.tsx src/demo/chat-shell.test.tsx src/demo/chat-demo.css src/demo/settings-page.tsx
git commit -m "fix: complete contextual inspector verification"
```

If no correction was needed, do not create an empty commit.
