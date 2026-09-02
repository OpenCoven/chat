import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';

import {
  CAVE_FAMILIAR_ANALYTICS,
  type CaveExecutionWindow,
  formatDuration,
  formatSuccessRate,
} from './minimal-familiar-sdk';
import { Icon, type IconName } from './minimal-icons';
import { contractReport, type MockFamiliar } from './mock-familiars';
import { MOCK_CREDENTIAL, MOCK_HEALTH } from './settings-page';

type InspectorTab = 'overview' | 'access' | 'activity';
type InspectorView = 'agent' | 'app';
type AppTab = 'general' | 'connection';

export type ChatInspectorProps = Readonly<{
  familiar: MockFamiliar | undefined;
  onClose: () => void;
}>;

const TABS: readonly InspectorTab[] = ['overview', 'access', 'activity'];
const APP_TABS: readonly AppTab[] = ['general', 'connection'];
const TAB_ICONS: Record<InspectorTab, IconName> = {
  overview: 'info',
  access: 'hand',
  activity: 'heartbeat',
};

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

function AccessGroup({
  defaultOpen = false,
  icon,
  items,
  label,
  summary,
  tone,
}: {
  defaultOpen?: boolean;
  icon: IconName;
  items: readonly string[];
  label: string;
  summary: string;
  tone: 'safe' | 'review' | 'scope';
}) {
  return (
    <details className={`access-group access-group-${tone}`} open={defaultOpen}>
      <summary>
        <span className="access-group-icon">
          <Icon name={icon} size={17} />
        </span>
        <span className="access-group-copy">
          <strong>{label}</strong>
          <span>{summary}</span>
        </span>
        <span className="access-group-count">{items.length}</span>
        <Icon name="caret-down" size={13} />
      </summary>
      <ul className="access-group-list">
        {items.map((item) => (
          <li key={item}>
            <Icon
              name={
                tone === 'safe' ? 'check-circle-fill' : tone === 'review' ? 'hand' : 'folder-open'
              }
              size={13}
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Access({ familiar }: { familiar: MockFamiliar }) {
  const report = contractReport(familiar);
  const passed = report.every((property) => property.pass);
  const passingChecks = report.filter((property) => property.pass).length;
  const autoCount = familiar.ward.approvalTiers.auto.length;
  const reviewCount = familiar.ward.approvalTiers.humanReview.length;

  return (
    <div className="access-view">
      <div className={`access-hero ${passed ? 'is-met' : 'needs-review'}`}>
        <span className="access-orbit" aria-hidden="true">
          <span className="access-orbit-core">
            <Icon name="hand" size={20} />
          </span>
          <span className="access-orbit-node access-orbit-node-safe" />
          <span className="access-orbit-node access-orbit-node-review" />
          <span className="access-orbit-node access-orbit-node-scope" />
        </span>
        <span className="access-hero-copy">
          <span className="access-status">
            <span aria-hidden="true" />
            Human in control
          </span>
          <strong>Clear boundaries, visible at a glance.</strong>
          <span>
            {familiar.name} can handle routine work, while consequential actions stop for you.
          </span>
        </span>
      </div>

      <section className="access-totals" aria-label="Authority summary">
        <div className="access-total access-total-safe">
          <span>
            <Icon name="sparkle" size={14} />
            Can act
          </span>
          <strong>{autoCount}</strong>
        </div>
        <div className="access-total access-total-review">
          <span>
            <Icon name="hand" size={14} />
            Asks first
          </span>
          <strong>{reviewCount}</strong>
        </div>
      </section>

      <div className="access-groups">
        <AccessGroup
          defaultOpen
          icon="sparkle"
          items={familiar.ward.approvalTiers.auto}
          label="May act"
          summary="Routine actions that can run immediately"
          tone="safe"
        />
        <AccessGroup
          defaultOpen
          icon="hand"
          items={familiar.ward.approvalTiers.humanReview}
          label="Must ask"
          summary="Actions held until you approve them"
          tone="review"
        />
        <AccessGroup
          icon="folder-open"
          items={familiar.ward.editablePaths}
          label="Workspace reach"
          summary="The only paths this familiar may change"
          tone="scope"
        />
      </div>

      <details className={`access-contract ${passed ? 'is-met' : 'needs-review'}`}>
        <summary>
          <span className="access-contract-icon">
            <Icon name={passed ? 'check-circle-fill' : 'warning-circle-fill'} size={17} />
          </span>
          <span className="access-contract-copy">
            <strong>Familiar contract</strong>
            <span>ward.toml {familiar.ward.version}</span>
          </span>
          <span className="access-contract-score">
            {passingChecks}/{report.length}
          </span>
          <Icon name="caret-down" size={13} />
        </summary>
        <div
          className="access-contract-meter"
          role="img"
          aria-label={`${passingChecks} of ${report.length} contract checks met`}
        >
          {report.map((property) => (
            <span
              key={property.property}
              className={property.pass ? 'is-met' : 'needs-review'}
              aria-hidden="true"
            />
          ))}
        </div>
        <ul className="access-contract-list">
          {report.map((property) => (
            <li key={property.property} className={property.pass ? 'is-met' : 'needs-review'}>
              <Icon name={property.pass ? 'check-circle-fill' : 'warning-circle-fill'} size={14} />
              <span>
                <strong>{property.property}</strong>
                <span>{property.note}</span>
              </span>
              <code>{property.file}</code>
            </li>
          ))}
        </ul>
      </details>
    </div>
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
  onClose,
}: {
  familiar: MockFamiliar | undefined;
  onBack: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<AppTab>('general');
  const [notifications, setNotifications] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectTab(next: AppTab) {
    setTab(next);
    tabRefs.current[APP_TABS.indexOf(next)]?.focus();
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
          ? APP_TABS.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + APP_TABS.length) % APP_TABS.length;
    const next = APP_TABS[nextIndex];

    if (next) {
      selectTab(next);
    }
  }

  return (
    <section className="chat-inspector app-settings-view" aria-label="App settings">
      <div className="inspector-app-toolbar">
        <button
          type="button"
          className="inspector-back"
          aria-label={`Back to ${familiar?.name ?? 'agent'}`}
          onClick={onBack}
        >
          <span aria-hidden="true">‹</span>
          <span>{familiar?.name ?? 'Agent'}</span>
        </button>
        <button
          type="button"
          className="glass-control"
          aria-label="Hide agent inspector"
          onClick={onClose}
        >
          ›
        </button>
      </div>
      <header className="inspector-app-header">
        <h2>App settings</h2>
        <p>Device and Cave preferences</p>
      </header>
      <div className="inspector-tabs" role="tablist" aria-label="App settings sections">
        {APP_TABS.map((name, index) => (
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

export function ChatInspector({ familiar, onClose }: ChatInspectorProps) {
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
    return <AppSettings familiar={familiar} onBack={() => setView('agent')} onClose={onClose} />;
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
            <Icon name={TAB_ICONS[name]} size={13} />
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
