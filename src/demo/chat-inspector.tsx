import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';

import {
  CAVE_FAMILIAR_ANALYTICS,
  type CaveExecutionWindow,
  formatDuration,
  formatSuccessRate,
} from './minimal-familiar-sdk';
import { contractReport, MOCK_FAMILIARS, type MockFamiliar } from './mock-familiars';
import { MOCK_CREDENTIAL, MOCK_HEALTH } from './settings-page';

type InspectorTab = 'overview' | 'access' | 'activity';
type InspectorView = 'agent' | 'app';
type AppTab = 'general' | 'connection';

export type ChatInspectorProps = Readonly<{
  familiar: MockFamiliar | undefined;
  onClose: () => void;
  onFamiliarChange: (familiarId: string) => void;
}>;

const TABS: readonly InspectorTab[] = ['overview', 'access', 'activity'];

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function SettingRow({ hint, label, value }: { hint?: string; label: string; value: ReactNode }) {
  return (
    <div className="inspector-row">
      <span className="inspector-row-copy">
        <strong>{label}</strong>
        {hint ? <span>{hint}</span> : null}
      </span>
      <span className="inspector-value">{value}</span>
    </div>
  );
}

function SettingSwitch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="inspector-row">
      <span className="inspector-row-copy">
        <strong>{label}</strong>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`inspector-switch ${checked ? 'is-on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}

function Overview({ familiar }: { familiar: MockFamiliar }) {
  return (
    <>
      <p className="inspector-eyebrow">Current context</p>
      <p className="inspector-summary">{familiar.soul.purpose}</p>
      <SettingRow
        label="Status"
        hint="Available for this chat"
        value={titleCase(familiar.status)}
      />
      <SettingRow label="Project" hint="Files and memory scope" value="Quick chats" />
      <SettingRow
        label="Memory"
        hint={
          familiar.memory ? `${familiar.memory.entries.toLocaleString()} entries` : 'No memory file'
        }
        value={familiar.memory?.lastWritten ?? 'Off'}
      />
      <SettingRow
        label="Identity"
        hint={`${familiar.creature} · ${familiar.pronouns}`}
        value="View ›"
      />
    </>
  );
}

function DetailList({ items }: { items: readonly string[] }) {
  if (items.length === 0) {
    return <span className="inspector-value">None</span>;
  }

  return (
    <ul className="inspector-detail-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function Access({ familiar }: { familiar: MockFamiliar }) {
  const report = contractReport(familiar);
  const passed = report.every((property) => property.pass);

  return (
    <>
      <p className="inspector-eyebrow">Bounded authority</p>
      <p className="inspector-summary">
        The ward decides what {familiar.name} may do here and what must wait for you.
      </p>
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
      <SettingRow
        label="Contract"
        hint={`ward.toml ${familiar.ward.version}`}
        value={passed ? 'Met' : 'Review'}
      />
    </>
  );
}

function Activity({ analytics }: { analytics: CaveExecutionWindow | undefined }) {
  if (!analytics || analytics.attempts === 0) {
    return (
      <div className="inspector-empty">
        <strong>No recent runs</strong>
        <span>Activity will appear after this agent completes work.</span>
      </div>
    );
  }

  return (
    <>
      <p className="inspector-eyebrow">Last 7 days</p>
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
    </>
  );
}

function AppSettings({
  familiar,
  onBack,
}: {
  familiar: MockFamiliar | undefined;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<AppTab>('general');
  const [notifications, setNotifications] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);

  return (
    <section className="chat-inspector app-settings-view" aria-label="App settings">
      <button
        type="button"
        className="inspector-back"
        aria-label={`Back to ${familiar?.name ?? 'agent'}`}
        onClick={onBack}
      >
        <span aria-hidden="true">‹</span>
        <span>{familiar?.name ?? 'Agent'}</span>
      </button>
      <header className="inspector-app-header">
        <h2>App settings</h2>
        <p>Device and Cave preferences</p>
      </header>
      <div className="inspector-tabs" role="tablist" aria-label="App settings sections">
        {(['general', 'connection'] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
          >
            {titleCase(name)}
          </button>
        ))}
      </div>
      <div
        className="inspector-panel inspector-settings"
        role="tabpanel"
        aria-label={titleCase(tab)}
      >
        {tab === 'general' ? (
          <>
            <SettingSwitch
              label="Notifications"
              checked={notifications}
              onChange={setNotifications}
            />
            <SettingSwitch
              label="Reduce motion"
              checked={reduceMotion}
              onChange={setReduceMotion}
            />
            <SettingSwitch
              label="Launch at login"
              checked={launchAtLogin}
              onChange={setLaunchAtLogin}
            />
            <SettingRow label="Quick chat" value={<kbd>⌥ Space</kbd>} />
            <SettingRow label="Default agent" value={familiar?.name ?? 'Unavailable'} />
          </>
        ) : (
          <>
            <SettingRow label="Cave instance" value={<code>{MOCK_HEALTH.instanceId}</code>} />
            <SettingRow label="API version" value={<code>v{MOCK_HEALTH.apiVersion}</code>} />
            <SettingRow label="Paired client" value={MOCK_CREDENTIAL.label} />
            <SettingRow label="Last used" value={MOCK_CREDENTIAL.lastUsed} />
            <button type="button" className="inspector-copy" aria-label="Copy diagnostic report">
              Copy report
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export function ChatInspector({ familiar, onClose, onFamiliarChange }: ChatInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('overview');
  const [view, setView] = useState<InspectorView>('agent');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectTab(next: InspectorTab) {
    setTab(next);
    tabRefs.current[TABS.indexOf(next)]?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? TABS.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    const next = TABS[nextIndex];

    if (next) {
      selectTab(next);
    }
  }

  if (view === 'app') {
    return <AppSettings familiar={familiar} onBack={() => setView('agent')} />;
  }

  const analytics = familiar ? CAVE_FAMILIAR_ANALYTICS[familiar.id]?.windows['7d'] : undefined;

  return (
    <section className="chat-inspector" aria-label="Agent inspector details">
      <header className="inspector-identity">
        <span className="inspector-mark" aria-hidden="true">
          {familiar?.emoji ?? '·'}
        </span>
        <span className="inspector-who">
          <h2>{familiar?.name ?? 'Agent unavailable'}</h2>
          <span>{familiar?.role ?? 'Choose another conversation'}</span>
        </span>
        <button
          type="button"
          className="glass-control"
          aria-label="Hide agent inspector"
          onClick={onClose}
        >
          ›
        </button>
      </header>

      {familiar ? (
        <select
          className="inspector-agent-select"
          aria-label="Agent for this conversation"
          value={familiar.id}
          onChange={(event) => onFamiliarChange(event.target.value)}
        >
          {MOCK_FAMILIARS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      ) : null}

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

      <div className="inspector-panel" role="tabpanel" aria-label={titleCase(tab)}>
        {!familiar ? (
          <p className="inspector-empty">Choose a conversation to see its agent.</p>
        ) : null}
        {familiar && tab === 'overview' ? <Overview familiar={familiar} /> : null}
        {familiar && tab === 'access' ? <Access familiar={familiar} /> : null}
        {familiar && tab === 'activity' ? <Activity analytics={analytics} /> : null}
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
}
