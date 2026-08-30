# Grok-Inspired Agent Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the chat demo's right-side inspector as an OpenCoven-branded, Grok-inspired profile stack with a stable identity hero, derived metrics, contextual cards, and a compact settings footer.

**Architecture:** Keep `ChatInspector` as the local state owner and extract small presentation components inside the same file for the hero, metrics, and semantic card groups. Move the agent view to a three-row shell with one scrolling profile region, while leaving the existing App settings secondary view and shell-level responsive behavior intact.

**Tech Stack:** React 19, TypeScript 6, CSS, Vitest 4, Testing Library, Playwright

---

## File Map

| File | Responsibility |
| --- | --- |
| `src/demo/chat-inspector.tsx` | Render the profile hero, derived snapshot metrics, semantic Overview/Access/Activity cards, tabs, and App settings navigation |
| `src/demo/chat-inspector.test.tsx` | Verify profile content, derived values, tab stability, keyboard behavior, and missing-data states |
| `src/demo/chat-demo.css` | Implement the three-row profile layout, ward orbit, cards, responsive compression, focus states, and reduced-motion behavior |
| `src/demo/chat-shell.test.tsx` | Guard the inspector's structural CSS, compact footer, narrow layout, and reduced-motion rules |

## Execution Prerequisite

The current branch may contain separate in-progress left-sidebar work in
`src/demo/chat-demo.tsx`, `src/demo/chat-demo.css`,
`src/demo/chat-shell.test.tsx`, `e2e/app.smoke.spec.ts`, `package.json`, and
`pnpm-lock.yaml`. Do not discard or accidentally include that work in an
inspector commit. Execute this plan in a dedicated worktree after the
left-sidebar changes are committed, or wait until their owner has completed
them and confirm `git status --short` is clean before starting Task 1.

### Task 1: Add the Stable Profile Hero and Snapshot

**Files:**
- Modify: `src/demo/chat-inspector.test.tsx:1-65`
- Modify: `src/demo/chat-inspector.tsx:21-389`

- [ ] **Step 1: Write failing profile and metric tests**

Update the Testing Library import, add the Echo fixture, and add these tests near the top of the `ChatInspector` suite:

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';

import { ChatInspector } from './chat-inspector';
import { MOCK_FAMILIARS } from './mock-familiars';

const astra = MOCK_FAMILIARS.find((familiar) => familiar.id === 'astra');
const echo = MOCK_FAMILIARS.find((familiar) => familiar.id === 'echo');

describe('ChatInspector', () => {
  it('keeps the active familiar profile and snapshot visible across tabs', () => {
    render(<ChatInspector familiar={astra} onClose={vi.fn()} />);

    const profile = screen.getByLabelText('Astra profile');
    const snapshot = screen.getByLabelText('Agent snapshot');

    expect(within(profile).getByRole('heading', { name: 'Astra' })).toBeVisible();
    expect(profile).toHaveTextContent('Research and synthesis');
    expect(profile).toHaveTextContent('Available');
    expect(profile).toHaveTextContent(
      'To map unfamiliar territory so a decision can be made on evidence.',
    );
    expect(snapshot).toHaveTextContent('100%');
    expect(snapshot).toHaveTextContent('412');
    expect(snapshot).toHaveTextContent('2 hours ago');

    fireEvent.click(screen.getByRole('tab', { name: 'Access' }));

    expect(profile).toBeVisible();
    expect(snapshot).toBeVisible();
    expect(screen.getByRole('tabpanel', { name: 'Access' })).toBeVisible();
  });

  it('uses explicit missing-data labels instead of fabricated metrics', () => {
    render(<ChatInspector familiar={echo} onClose={vi.fn()} />);

    const snapshot = screen.getByLabelText('Agent snapshot');

    expect(snapshot).toHaveTextContent('No runs');
    expect(snapshot).toHaveTextContent('Off');
    expect(snapshot).toHaveTextContent('Unavailable');
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
```

Keep the existing keyboard, App settings, and unavailable-familiar tests below
these new tests.

- [ ] **Step 2: Run the focused tests and confirm the new expectations fail**

Run:

```bash
corepack pnpm@10.34.0 --ignore-workspace exec vitest run src/demo/chat-inspector.test.tsx
```

Expected: FAIL because `Astra profile` and `Agent snapshot` do not exist yet.

- [ ] **Step 3: Add the profile and snapshot components**

Add these components after `SettingSwitch` in
`src/demo/chat-inspector.tsx`:

```tsx
function InspectorHero({ familiar }: { familiar: MockFamiliar | undefined }) {
  if (!familiar) {
    return (
      <section className="inspector-hero is-unavailable" aria-label="Unavailable agent profile">
        <span className="inspector-orbit is-unavailable" aria-hidden="true">
          <span className="inspector-mark">·</span>
        </span>
        <h2>Agent unavailable</h2>
        <p className="inspector-role">Choose another conversation</p>
        <p className="inspector-purpose">Select a conversation to see its attached familiar.</p>
      </section>
    );
  }

  return (
    <section className="inspector-hero" aria-label={`${familiar.name} profile`}>
      <span className={`inspector-orbit is-${familiar.status}`} aria-hidden="true">
        <span className="inspector-mark">{familiar.emoji}</span>
      </span>
      <h2>{familiar.name}</h2>
      <p className="inspector-role">{familiar.role}</p>
      <p className={`inspector-status is-${familiar.status}`}>
        <span aria-hidden="true" />
        {titleCase(familiar.status)}
      </p>
      <p className="inspector-purpose">{familiar.soul.purpose}</p>
    </section>
  );
}

function InspectorMetrics({
  analytics,
  familiar,
}: {
  analytics: CaveExecutionWindow | undefined;
  familiar: MockFamiliar;
}) {
  const metrics = [
    {
      label: 'Completion',
      value: analytics && analytics.attempts > 0 ? formatSuccessRate(analytics) : 'No runs',
    },
    {
      label: 'Memory',
      value: familiar.memory ? familiar.memory.entries.toLocaleString() : 'Off',
    },
    {
      label: 'Last active',
      value: familiar.memory?.lastWritten ?? 'Unavailable',
    },
  ] as const;

  return (
    <dl className="inspector-metrics" aria-label="Agent snapshot">
      {metrics.map((metric) => (
        <div className="inspector-metric" key={metric.label}>
          <dt>{metric.label}</dt>
          <dd>{metric.value}</dd>
        </div>
      ))}
    </dl>
  );
}
```

- [ ] **Step 4: Replace the agent-view shell**

In `ChatInspector`, keep the existing state, tab keyboard logic, App settings
branch, and analytics lookup. Replace only the final agent-view `return` with:

```tsx
  return (
    <section className="chat-inspector" aria-label="Agent inspector details">
      <header className="inspector-toolbar">
        <span>Agent profile</span>
        <button
          type="button"
          className="glass-control"
          aria-label="Hide agent inspector"
          onClick={onClose}
        >
          ›
        </button>
      </header>

      <div className="inspector-scroll">
        <InspectorHero familiar={familiar} />
        {familiar ? <InspectorMetrics familiar={familiar} analytics={analytics} /> : null}

        <div className="inspector-tabs" role="tablist" aria-label="Agent details">
          {TABS.map((name, index) => (
            <button
              key={name}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              aria-selected={tab === name}
              tabIndex={tab === name ? 0 : -1}
              onClick={() => setTab(name)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {titleCase(name)}
            </button>
          ))}
        </div>

        <div
          key={tab}
          className="inspector-panel"
          role="tabpanel"
          aria-label={titleCase(tab)}
        >
          {!familiar ? (
            <p className="inspector-empty">Choose a conversation to see its agent.</p>
          ) : null}
          {familiar && tab === 'overview' ? <Overview familiar={familiar} /> : null}
          {familiar && tab === 'access' ? <Access familiar={familiar} /> : null}
          {familiar && tab === 'activity' ? <Activity analytics={analytics} /> : null}
        </div>
      </div>

      <button
        type="button"
        className="inspector-app-settings"
        aria-label="App settings"
        onClick={() => setView('app')}
      >
        <span>App settings</span>
        <kbd>⌘,</kbd>
      </button>
    </section>
  );
```

- [ ] **Step 5: Run the focused tests**

Run:

```bash
corepack pnpm@10.34.0 --ignore-workspace exec vitest run src/demo/chat-inspector.test.tsx
```

Expected: PASS with all profile, metric, keyboard, App settings, and unavailable
state tests passing.

- [ ] **Step 6: Commit the profile structure**

```bash
git add src/demo/chat-inspector.tsx src/demo/chat-inspector.test.tsx
git commit -m "feat: add agent inspector profile stack" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Group Overview, Access, and Activity Into Context Cards

**Files:**
- Modify: `src/demo/chat-inspector.test.tsx:9-75`
- Modify: `src/demo/chat-inspector.tsx:21-154`

- [ ] **Step 1: Add failing card-structure assertions**

In the first profile test, replace the block beginning with the existing
`fireEvent.click(screen.getByRole('tab', { name: 'Access' }))` through the end
of that test with:

```tsx
    const overview = screen.getByRole('tabpanel', { name: 'Overview' });
    expect(within(overview).getByRole('heading', { name: 'Chat context' })).toBeVisible();
    expect(within(overview).getByRole('heading', { name: 'Contract' })).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: 'Access' }));

    const access = screen.getByRole('tabpanel', { name: 'Access' });
    expect(within(access).getByRole('heading', { name: 'Authority' })).toBeVisible();
    expect(within(access).getByRole('heading', { name: 'Contract' })).toBeVisible();
    expect(profile).toBeVisible();
    expect(snapshot).toBeVisible();
  });
```

Add a separate Activity assertion:

```tsx
  it('groups recent activity into a labeled card', () => {
    render(<ChatInspector familiar={astra} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));

    const activity = screen.getByRole('tabpanel', { name: 'Activity' });
    expect(within(activity).getByRole('heading', { name: 'Last 7 days' })).toBeVisible();
    expect(activity).toHaveTextContent('Median duration');
    expect(activity).toHaveTextContent('Tool calls');
  });
```

- [ ] **Step 2: Run the focused tests and confirm the card headings fail**

Run:

```bash
corepack pnpm@10.34.0 --ignore-workspace exec vitest run src/demo/chat-inspector.test.tsx
```

Expected: FAIL because the current tab panels do not contain the approved card
headings.

- [ ] **Step 3: Add the semantic card wrapper**

Add this helper after `SettingRow`:

```tsx
function InspectorCard({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <section className="inspector-card">
      <h3 className="inspector-card-title">{label}</h3>
      {children}
    </section>
  );
}
```

- [ ] **Step 4: Replace the Overview component**

Replace `Overview` with:

```tsx
function Overview({ familiar }: { familiar: MockFamiliar }) {
  const report = contractReport(familiar);
  const passed = report.every((property) => property.pass);

  return (
    <>
      <InspectorCard label="Chat context">
        <SettingRow label="Project" hint="Files and memory scope" value="Quick chats" />
        <SettingRow
          label="Memory"
          hint={
            familiar.memory
              ? `${familiar.memory.entries.toLocaleString()} entries`
              : 'No memory file'
          }
          value={familiar.memory?.lastWritten ?? 'Off'}
        />
        <SettingRow
          label="Identity"
          hint={`${familiar.creature} · ${familiar.pronouns}`}
          value="View ›"
        />
      </InspectorCard>
      <InspectorCard label="Contract">
        <SettingRow
          label="Bounded authority"
          hint={`ward.toml ${familiar.ward.version}`}
          value={passed ? 'Met' : 'Review'}
        />
      </InspectorCard>
    </>
  );
}
```

- [ ] **Step 5: Replace the Access component**

Replace `Access` with:

```tsx
function Access({ familiar }: { familiar: MockFamiliar }) {
  const report = contractReport(familiar);
  const passed = report.every((property) => property.pass);

  return (
    <>
      <InspectorCard label="Authority">
        <div className="inspector-detail">
          <strong>May do</strong>
          <DetailList items={familiar.ward.approvalTiers.auto} />
        </div>
        <div className="inspector-detail">
          <strong>Must ask</strong>
          <DetailList items={familiar.ward.approvalTiers.humanReview} />
        </div>
        <div className="inspector-detail">
          <strong>Editable paths</strong>
          <DetailList items={familiar.ward.editablePaths} />
        </div>
      </InspectorCard>
      <InspectorCard label="Contract">
        <SettingRow
          label="Bounded authority"
          hint={`ward.toml ${familiar.ward.version}`}
          value={passed ? 'Met' : 'Review'}
        />
      </InspectorCard>
    </>
  );
}
```

- [ ] **Step 6: Replace the Activity component**

Replace `Activity` with:

```tsx
function Activity({ analytics }: { analytics: CaveExecutionWindow | undefined }) {
  if (!analytics || analytics.attempts === 0) {
    return (
      <InspectorCard label="Last 7 days">
        <div className="inspector-empty">
          <strong>No recent runs</strong>
          <span>Activity will appear after this agent completes work.</span>
        </div>
      </InspectorCard>
    );
  }

  return (
    <InspectorCard label="Last 7 days">
      <SettingRow
        label="Completion"
        hint={`${analytics.completed} of ${analytics.attempts} runs`}
        value={formatSuccessRate(analytics)}
      />
      <SettingRow
        label="Median duration"
        hint="Across completed runs"
        value={formatDuration(analytics.medianDurationMs)}
      />
      <SettingRow
        label="Tool calls"
        hint={`${analytics.toolFailures} reported failures`}
        value={analytics.toolCalls.toLocaleString()}
      />
      <SettingRow label="Last active" hint="Memory updated with result" value="Recently" />
    </InspectorCard>
  );
}
```

- [ ] **Step 7: Run the focused tests**

Run:

```bash
corepack pnpm@10.34.0 --ignore-workspace exec vitest run src/demo/chat-inspector.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit the contextual cards**

```bash
git add src/demo/chat-inspector.tsx src/demo/chat-inspector.test.tsx
git commit -m "feat: group inspector context into cards" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Implement the Profile-Stack Visual System

**Files:**
- Modify: `src/demo/chat-shell.test.tsx:130-146`
- Modify: `src/demo/chat-demo.css:1107-1300`

- [ ] **Step 1: Add a failing stylesheet contract test**

Add this test after `keeps liquid glass restrained to shell chrome`:

```tsx
  it('uses a compact three-row profile stack in the agent inspector', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/demo/chat-demo.css'), 'utf8');

    expect(css).toMatch(
      /\.chat-demo \.chat-inspector\s*{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto/s,
    );
    expect(css).toMatch(/\.chat-demo \.inspector-scroll\s*{[^}]*overflow-y: auto/s);
    expect(css).toContain('.chat-demo .inspector-hero');
    expect(css).toContain('.chat-demo .inspector-orbit');
    expect(css).toContain('conic-gradient');
    expect(css).toContain('.chat-demo .inspector-metrics');
    expect(css).toContain('.chat-demo .inspector-card');
    expect(css).toMatch(
      /\.chat-demo \.inspector-app-settings\s*{[^}]*margin: 8px[^}]*padding: 8px 9px/s,
    );
  });
```

- [ ] **Step 2: Run the stylesheet test and confirm it fails**

Run:

```bash
corepack pnpm@10.34.0 --ignore-workspace exec vitest run src/demo/chat-shell.test.tsx
```

Expected: FAIL because the current inspector has no profile-stack classes and
still declares four rows.

- [ ] **Step 3: Replace the agent inspector layout and identity styles**

In the contextual inspector section of `src/demo/chat-demo.css`, replace the
current `.chat-inspector`, `.inspector-identity`, `.inspector-mark`,
`.inspector-who`, heading, and role rules with:

```css
.chat-demo .chat-inspector {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100%;
  min-width: 300px;
  overflow: hidden;
  background: var(--demo-glass);
  box-shadow: inset 1px 0 rgba(255, 255, 255, 0.025);
  backdrop-filter: blur(24px) saturate(140%);
}

.chat-demo .inspector-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 6px;
  color: var(--demo-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.075em;
  text-transform: uppercase;
}

.chat-demo .inspector-scroll {
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding-bottom: 12px;
  background: radial-gradient(
    circle at 50% 0,
    rgba(147, 134, 208, 0.12),
    transparent 220px
  );
}

.chat-demo .inspector-hero {
  display: grid;
  justify-items: center;
  padding: 16px 18px 18px;
  text-align: center;
}

.chat-demo .inspector-orbit {
  display: grid;
  width: 80px;
  height: 80px;
  place-items: center;
  padding: 2px;
  border-radius: 27px;
  background: conic-gradient(
    from -32deg,
    var(--demo-violet) 0 82%,
    rgba(255, 255, 255, 0.1) 82% 100%
  );
  box-shadow: 0 18px 38px rgba(0, 0, 0, 0.28);
  transition:
    opacity 180ms cubic-bezier(0.22, 0.72, 0, 1),
    filter 180ms cubic-bezier(0.22, 0.72, 0, 1);
}

.chat-demo .inspector-orbit.is-available {
  background: conic-gradient(
    from -32deg,
    var(--demo-violet) 0 82%,
    var(--demo-ready) 82% 92%,
    rgba(255, 255, 255, 0.1) 92% 100%
  );
}

.chat-demo .inspector-orbit.is-offline,
.chat-demo .inspector-orbit.is-unavailable {
  background: conic-gradient(
    from -32deg,
    rgba(147, 134, 208, 0.44) 0 76%,
    rgba(255, 255, 255, 0.08) 76% 100%
  );
  filter: saturate(0.7);
}

.chat-demo .inspector-mark {
  display: grid;
  width: 72px;
  height: 72px;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 24px;
  background: #202127;
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.1);
  font-size: 28px;
}

.chat-demo .inspector-hero h2 {
  overflow: hidden;
  max-width: 100%;
  margin: 10px 0 0;
  font-size: 20px;
  font-weight: 680;
  letter-spacing: -0.035em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-demo .inspector-role {
  margin: 2px 0 0;
  color: var(--demo-muted);
  font-size: 11px;
}

.chat-demo .inspector-app-header h2 {
  overflow: hidden;
  margin: 0;
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.015em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-demo .inspector-app-header p {
  overflow: hidden;
  margin: 0;
  color: var(--demo-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-demo .inspector-status {
  display: flex;
  gap: 6px;
  align-items: center;
  margin: 8px 0 0;
  color: rgba(244, 243, 247, 0.82);
  font-size: 10px;
}

.chat-demo .inspector-status > span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--demo-violet);
}

.chat-demo .inspector-status.is-available > span {
  background: var(--demo-ready);
  box-shadow: 0 0 0 4px rgba(130, 179, 142, 0.1);
}

.chat-demo .inspector-status.is-offline > span {
  background: var(--demo-muted);
  box-shadow: none;
}

.chat-demo .inspector-purpose {
  max-width: 270px;
  margin: 11px 0 0;
  color: rgba(244, 243, 247, 0.78);
  font-size: 12px;
  line-height: 1.5;
}
```

- [ ] **Step 4: Add metric, tab-panel, and card styling**

Keep the existing segmented-tab rules, then add or replace the relevant panel,
row, detail, and empty-state rules with:

```css
.chat-demo .inspector-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
  margin: 0 12px 12px;
}

.chat-demo .inspector-metric {
  display: grid;
  gap: 3px;
  min-width: 0;
  padding: 9px 5px;
  border: 1px solid rgba(255, 255, 255, 0.055);
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.035);
  text-align: center;
}

.chat-demo .inspector-metric dt {
  order: 2;
  overflow: hidden;
  color: var(--demo-muted);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-demo .inspector-metric dd {
  order: 1;
  overflow: hidden;
  margin: 0;
  color: var(--demo-text);
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-demo .inspector-panel {
  min-height: 0;
  overflow: visible;
  padding: 10px 12px 4px;
  animation: inspector-panel-in 170ms cubic-bezier(0.22, 0.72, 0, 1);
}

@keyframes inspector-panel-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.chat-demo .inspector-card {
  margin-top: 9px;
  padding: 11px 12px 4px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.032);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.025);
}

.chat-demo .inspector-card:first-child {
  margin-top: 0;
}

.chat-demo .inspector-card-title {
  margin: 0 0 6px;
  color: var(--demo-muted);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.chat-demo .inspector-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  min-height: 42px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.chat-demo .inspector-card .inspector-row:first-of-type,
.chat-demo .inspector-card .inspector-detail:first-of-type {
  border-top: 0;
}

.chat-demo .inspector-row-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.chat-demo .inspector-row-copy strong,
.chat-demo .inspector-detail > strong {
  font-size: 12px;
  font-weight: 590;
}

.chat-demo .inspector-row-copy span {
  overflow: hidden;
  color: var(--demo-muted);
  font-size: 10px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-demo .inspector-value {
  color: #b7b0cc;
  font-size: 11px;
  text-align: right;
}

.chat-demo .inspector-detail {
  display: grid;
  gap: 6px;
  padding: 10px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.chat-demo .inspector-detail-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 17px;
  color: var(--demo-muted);
  font-size: 11px;
  line-height: 1.4;
}

.chat-demo .inspector-empty {
  display: grid;
  gap: 5px;
  margin: 0;
  padding: 12px 0 16px;
  color: var(--demo-muted);
  font-size: 12px;
  line-height: 1.45;
}

.chat-demo .inspector-empty strong {
  color: var(--demo-text);
}

.chat-demo .app-settings-view {
  grid-template-rows: auto auto auto minmax(0, 1fr);
}

.chat-demo .app-settings-view .inspector-panel {
  overflow-y: auto;
  animation: none;
}
```

Keep the current compact `.inspector-app-settings` rule, including `margin:
8px` and `padding: 8px 9px`.

- [ ] **Step 5: Add inspector focus styling**

Add this rule beside the inspector button styles:

```css
.chat-demo .inspector-toolbar button:focus-visible,
.chat-demo .inspector-tabs button:focus-visible,
.chat-demo .inspector-app-settings:focus-visible,
.chat-demo .inspector-back:focus-visible,
.chat-demo .inspector-copy:focus-visible,
.chat-demo .inspector-switch:focus-visible {
  outline: 2px solid var(--demo-violet-line);
  outline-offset: 2px;
}
```

- [ ] **Step 6: Run component and shell tests**

Run:

```bash
corepack pnpm@10.34.0 --ignore-workspace exec vitest run \
  src/demo/chat-inspector.test.tsx \
  src/demo/chat-shell.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit the visual system**

```bash
git add src/demo/chat-demo.css src/demo/chat-shell.test.tsx
git commit -m "feat: style agent inspector profile stack" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Add Narrow-Panel and Reduced-Motion Guards

**Files:**
- Modify: `src/demo/chat-shell.test.tsx:130-170`
- Modify: `src/demo/chat-demo.css:2161-2202`

- [ ] **Step 1: Extend the stylesheet contract for responsive and motion rules**

Add these variables and expectations to the profile-stack stylesheet test:

```tsx
    const narrowStart = css.lastIndexOf('@media (max-width: 820px)');
    const reducedMotionStart = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
    const narrowStyles = css.slice(narrowStart, reducedMotionStart);
    const reducedMotionStyles = css.slice(reducedMotionStart);

    expect(narrowStyles).toContain('.chat-demo .inspector-hero');
    expect(narrowStyles).toContain('.chat-demo .inspector-metrics');
    expect(reducedMotionStyles).toContain('.chat-demo .inspector-panel');
    expect(reducedMotionStyles).toContain('.chat-demo .inspector-orbit');
```

- [ ] **Step 2: Run the shell test and confirm the new assertions fail**

Run:

```bash
corepack pnpm@10.34.0 --ignore-workspace exec vitest run src/demo/chat-shell.test.tsx
```

Expected: FAIL because the new responsive compression and reduced-motion
selectors have not been added.

- [ ] **Step 3: Add narrow-panel compression**

Inside the existing `@media (max-width: 820px)` block, add:

```css
  .chat-demo .inspector-hero {
    padding: 12px 14px 14px;
  }

  .chat-demo .inspector-orbit {
    width: 72px;
    height: 72px;
    border-radius: 24px;
  }

  .chat-demo .inspector-mark {
    width: 64px;
    height: 64px;
    border-radius: 21px;
    font-size: 25px;
  }

  .chat-demo .inspector-metrics {
    gap: 5px;
  }

  .chat-demo .inspector-metric {
    padding-inline: 3px;
  }
```

- [ ] **Step 4: Extend reduced-motion coverage**

Add the new animated inspector elements to the final reduced-motion rule:

```css
@media (prefers-reduced-motion: reduce) {
  .chat-demo,
  .chat-demo .sidebar,
  .chat-demo .chat-inspector,
  .chat-demo .glass-control,
  .chat-demo .inspector-panel,
  .chat-demo .inspector-orbit,
  .chat-demo .inspector-switch > span {
    animation: none;
    transition: none;
  }
}
```

- [ ] **Step 5: Run the focused tests and production build**

Run:

```bash
corepack pnpm@10.34.0 --ignore-workspace exec vitest run \
  src/demo/chat-inspector.test.tsx \
  src/demo/chat-shell.test.tsx &&
corepack pnpm@10.34.0 --ignore-workspace build
```

Expected: all focused tests PASS and Vite reports a successful production
build.

- [ ] **Step 6: Commit responsive and motion support**

```bash
git add src/demo/chat-demo.css src/demo/chat-shell.test.tsx
git commit -m "fix: preserve inspector accessibility across sizes" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Verify Rendered Geometry and Visual States

**Files:**
- Generated and ignored: `.artifacts/inspector-redesign/*.png`

- [ ] **Step 1: Build and start the preview server**

Run in one persistent shell:

```bash
mkdir -p .artifacts/inspector-redesign
corepack pnpm@10.34.0 --ignore-workspace build
corepack pnpm@10.34.0 --ignore-workspace preview \
  --host 127.0.0.1 \
  --port 4174 \
  --strictPort \
  > .artifacts/inspector-redesign/preview.log 2>&1 &
PREVIEW_PID=$!
echo "$PREVIEW_PID" > .artifacts/inspector-redesign/preview.pid
```

Expected: the preview server remains running at `http://127.0.0.1:4174`.

- [ ] **Step 2: Capture desktop, compact desktop, and narrow overlay states**

Run from the same persistent shell:

```bash
node --input-type=module <<'EOF'
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

await mkdir('.artifacts/inspector-redesign', { recursive: true });

const browser = await chromium.launch({ headless: true });
const states = [
  { name: 'desktop', width: 1440, height: 900, openInspector: false },
  { name: 'compact-desktop', width: 1024, height: 768, openInspector: false },
  { name: 'narrow-overlay', width: 760, height: 900, openInspector: true },
];

try {
  for (const state of states) {
    const page = await browser.newPage({
      viewport: { width: state.width, height: state.height },
    });
    await page.goto('http://127.0.0.1:4174/?demo=chat');

    if (state.openInspector) {
      await page.getByRole('button', { name: 'Show agent inspector' }).click();
    }

    const inspector = page.locator('.chat-inspector');
    const footer = page.getByRole('button', { name: 'App settings' });
    const hero = page.getByLabel('Astra profile');

    await inspector.waitFor();
    await hero.waitFor();

    const geometry = await page.evaluate(() => {
      const inspectorElement = document.querySelector('.chat-inspector');
      const footerElement = document.querySelector('.inspector-app-settings');
      const scrollElement = document.querySelector('.inspector-scroll');

      if (
        !(inspectorElement instanceof HTMLElement) ||
        !(footerElement instanceof HTMLElement) ||
        !(scrollElement instanceof HTMLElement)
      ) {
        throw new Error('Inspector geometry elements are missing');
      }

      const inspectorRect = inspectorElement.getBoundingClientRect();
      const footerRect = footerElement.getBoundingClientRect();

      return {
        footerHeight: footerRect.height,
        footerBottomGap: inspectorRect.bottom - footerRect.bottom,
        horizontalOverflow: scrollElement.scrollWidth > scrollElement.clientWidth,
      };
    });

    if (
      geometry.footerHeight > 48 ||
      geometry.footerBottomGap > 12 ||
      geometry.horizontalOverflow
    ) {
      throw new Error(`${state.name} geometry failed: ${JSON.stringify(geometry)}`);
    }

    await page.screenshot({
      path: `.artifacts/inspector-redesign/${state.name}.png`,
      fullPage: true,
    });

    await page.getByRole('tab', { name: 'Access' }).click();
    await page.screenshot({
      path: `.artifacts/inspector-redesign/${state.name}-access.png`,
      fullPage: true,
    });

    await page.close();
  }
} finally {
  await browser.close();
}
EOF
```

Expected: six screenshots are created, the App settings footer stays under 48
pixels tall and within 12 pixels of the panel bottom, and no profile scroll
region has horizontal overflow.

- [ ] **Step 3: Inspect the screenshots**

Open:

```bash
open .artifacts/inspector-redesign/desktop.png
open .artifacts/inspector-redesign/desktop-access.png
open .artifacts/inspector-redesign/compact-desktop.png
open .artifacts/inspector-redesign/compact-desktop-access.png
open .artifacts/inspector-redesign/narrow-overlay.png
open .artifacts/inspector-redesign/narrow-overlay-access.png
```

Confirm:

- the ward orbit is the only dominant decorative element;
- the hero, purpose, metrics, tabs, and first card are visible at 1440 x 900;
- the profile remains readable at 1024 x 768;
- the narrow overlay has no clipped metrics or controls;
- Access content scrolls vertically without moving the footer;
- long authority items wrap inside their card.

- [ ] **Step 4: Stop the preview server**

Run from the same persistent shell:

```bash
kill "$PREVIEW_PID"
wait "$PREVIEW_PID" 2>/dev/null || true
```

Expected: the preview process exits.

### Task 6: Run the Complete Repository Validation

**Files:**
- Verify only; no planned source changes

- [ ] **Step 1: Run the complete required checks**

Run:

```bash
corepack pnpm@10.34.0 --ignore-workspace test &&
corepack pnpm@10.34.0 --ignore-workspace typecheck &&
corepack pnpm@10.34.0 --ignore-workspace lint &&
corepack pnpm@10.34.0 --ignore-workspace build &&
git diff --check
```

Expected: all unit suites pass, TypeScript reports no errors, Biome reports no
violations, Vite builds successfully, and `git diff --check` prints no output.

- [ ] **Step 2: Confirm the final change set is scoped**

Run:

```bash
git --no-pager status --short
git --no-pager diff --stat HEAD~4..HEAD
```

Expected: implementation changes are limited to
`src/demo/chat-inspector.tsx`, `src/demo/chat-inspector.test.tsx`,
`src/demo/chat-demo.css`, and `src/demo/chat-shell.test.tsx`; ignored visual
artifacts do not appear in status.
