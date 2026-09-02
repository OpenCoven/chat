import type { CSSProperties } from 'react';

import {
  dayBars,
  FAM_ACTIVITY,
  FAM_PROJECTS,
  type FamActivity,
  type RunRow,
  type RunTone,
  runRow,
} from './familiars-data';
import {
  type AccessGroupKey,
  type ActivityKey,
  cx,
  type DemoEmpty,
  FamButton,
  INSPECTOR_TABS,
  type InspectorTab,
  type Presence,
  Segmented,
  titleCase,
} from './familiars-ui';
import { Icon, type IconName } from './minimal-icons';
import { contractReport, type MockFamiliar } from './mock-familiars';

/**
 * The right rail of the Familiars Redesign v2 surface.
 *
 * Three views of one familiar: who it is, what its ward lets it do, and what
 * it has done lately. The Access tab is the centre of the design — the
 * boundary between "may act" and "must ask" is what the whole surface is
 * organised around, so it is the tab with the hero.
 */

export type DocRequest = Readonly<{ file: string; hl?: string }>;

export type FamiliarInspectorProps = Readonly<{
  familiar: MockFamiliar;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onHide: () => void;
  /** Lower-cased titles of the familiar's holds still waiting on a decision. */
  heldTitles: readonly string[];
  groups: Readonly<Partial<Record<AccessGroupKey, boolean>>>;
  onToggleGroup: (key: AccessGroupKey, open: boolean) => void;
  accessGroups?: 'default' | 'all' | undefined;
  activityOpen: ActivityKey | null;
  onToggleActivity: (key: ActivityKey) => void;
  onOpenDoc: (doc: DocRequest) => void;
  /** Open the summon dialog, from the no-familiar empty state. */
  onSummon?: (() => void) | undefined;
  demoEmpty?: DemoEmpty | undefined;
}>;

const PRESENCE_HINT: Record<Presence, string> = {
  available: 'Available for this chat',
  working: 'Running a task in another chat',
  offline: 'Offline until summoned',
};

export function FamiliarInspector(props: FamiliarInspectorProps) {
  const { familiar, tab, demoEmpty } = props;
  const noFamiliar = demoEmpty === 'familiar';

  return (
    <div className="fr-inspector-inner">
      <button
        type="button"
        className="fr-inspector-head"
        aria-label="Hide inspector"
        title="Hide inspector  ]"
        onClick={props.onHide}
      >
        <span className="fr-inspector-mark">
          <span
            className="fr-avatar fr-avatar--ring"
            style={{ '--size': '22px', '--font': '10px' } as CSSProperties}
            aria-hidden="true"
          >
            {familiar.name[0]}
            <span
              className={cx('fr-presence', familiar.status === 'available' && 'fr-live')}
              data-presence={familiar.status}
              style={{ '--dot': '8px' } as CSSProperties}
            />
          </span>
        </span>
        <span className="fr-inspector-who">
          <span className="fr-inspector-name">{familiar.name}</span>
          <span className="fr-inspector-kind">
            {familiar.creature} · {familiar.pronouns}
          </span>
        </span>
        <span className="fr-muted-icon fr-flip">
          <Icon name="sidebar-simple" size={15} />
        </span>
      </button>
      <div className="fr-tabs">
        <Segmented
          options={INSPECTOR_TABS}
          value={tab}
          onChange={props.onTabChange}
          getLabel={titleCase}
          label="Familiar details"
        />
      </div>
      <section className="fr-inspector-panel" aria-label={titleCase(tab)}>
        {noFamiliar ? (
          <div className="fr-inspector-empty">
            <span className="fr-empty-glyph fr-empty-glyph--lg">
              <Icon name="cat" size={18} />
            </span>
            <span className="fr-inspector-empty-title">No familiar selected</span>
            <span className="fr-inspector-empty-text">
              Choose a conversation, or summon a familiar to see its ward here.
            </span>
            <FamButton variant="secondary" size="sm" leadingIcon="sparkle" onClick={props.onSummon}>
              Summon familiar
            </FamButton>
          </div>
        ) : null}
        {!noFamiliar && tab === 'overview' ? (
          <OverviewTab familiar={familiar} onGoAccess={() => props.onTabChange('access')} />
        ) : null}
        {!noFamiliar && tab === 'access' ? (
          <AccessTab
            familiar={familiar}
            heldTitles={props.heldTitles}
            groups={props.groups}
            allOpen={props.accessGroups === 'all'}
            onToggleGroup={props.onToggleGroup}
            onOpenDoc={props.onOpenDoc}
          />
        ) : null}
        {!noFamiliar && tab === 'activity' ? (
          <ActivityTab
            familiar={familiar}
            activity={demoEmpty === 'runs' ? undefined : FAM_ACTIVITY[familiar.id]}
            open={props.activityOpen}
            onToggle={props.onToggleActivity}
          />
        ) : null}
      </section>
      <button type="button" className="fr-inspector-foot" title="App settings  ⌘,">
        <span className="fr-inspector-foot-label">
          <Icon name="gear-six" size={14} />
          App settings
        </span>
        <kbd className="fr-mono fr-small fr-muted">⌘,</kbd>
      </button>
    </div>
  );
}

/* -------------------------------------------------------------- overview */

function OverviewTab({ familiar, onGoAccess }: { familiar: MockFamiliar; onGoAccess: () => void }) {
  const memory = familiar.memory;

  return (
    <div className="fr-stack">
      <div className="fr-card fr-card--lift fr-overview-purpose">
        <span className="fr-eyebrow">Purpose</span>
        <span className="fr-purpose">{familiar.soul.purpose}</span>
        <code className="fr-source">SOUL.md</code>
      </div>
      <div className="fr-card fr-card--lift fr-rows">
        <OverviewRow
          label="Status"
          hint={PRESENCE_HINT[familiar.status]}
          value={familiar.status}
          tone="primary"
          dot={familiar.status}
        />
        <OverviewRow
          label="Project"
          hint="Files and memory scope"
          value={FAM_PROJECTS[familiar.id] ?? 'Quick chats'}
        />
        <OverviewRow
          label="Memory"
          hint={
            memory
              ? `${memory.entries.toLocaleString()} entries · MEMORY.md`
              : 'No MEMORY.md — nothing persists'
          }
          value={memory ? memory.lastWritten : 'off'}
          tone={memory ? 'secondary' : 'warn'}
        />
        <OverviewRow
          label="Belongs to"
          hint="Protected invariant in ward.toml"
          value={familiar.person}
        />
        <button type="button" className="fr-row fr-row-btn" onClick={onGoAccess}>
          <span className="fr-row-copy">
            <span className="fr-row-label">Ward</span>
            <span className="fr-row-hint">
              {familiar.ward.approvalTiers.auto.length} may act ·{' '}
              {familiar.ward.approvalTiers.humanReview.length} must ask ·{' '}
              {familiar.ward.editablePaths.length} paths
            </span>
          </span>
          <span className="fr-muted-icon">
            <Icon name="caret-right" size={14} />
          </span>
        </button>
      </div>
    </div>
  );
}

function OverviewRow({
  label,
  hint,
  value,
  tone = 'secondary',
  dot,
}: {
  label: string;
  hint: string;
  value: string;
  tone?: 'primary' | 'secondary' | 'warn';
  dot?: Presence;
}) {
  return (
    <div className="fr-row">
      <span className="fr-row-copy">
        <span className="fr-row-label">{label}</span>
        <span className="fr-row-hint">{hint}</span>
      </span>
      <span className={cx('fr-row-value', `fr-row-value--${tone}`)}>
        {dot ? <span className="fr-dot" data-presence={dot} aria-hidden="true" /> : null}
        {value}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- access */

type AccessItem = Readonly<{
  text: string;
  mono?: boolean;
  icon?: IconName;
  warn?: boolean;
  badge?: string;
  note?: string;
  file?: string;
  docTitle: string;
  open: () => void;
}>;

type AccessGroupSpec = Readonly<{
  key: AccessGroupKey;
  icon: IconName;
  label: string;
  summary: string;
  count: string;
  tone: 'secondary' | 'warn';
  items: readonly AccessItem[];
  meter?: readonly boolean[];
}>;

function AccessTab({
  familiar,
  heldTitles,
  groups,
  allOpen,
  onToggleGroup,
  onOpenDoc,
}: {
  familiar: MockFamiliar;
  heldTitles: readonly string[];
  groups: Readonly<Partial<Record<AccessGroupKey, boolean>>>;
  allOpen: boolean;
  onToggleGroup: (key: AccessGroupKey, open: boolean) => void;
  onOpenDoc: (doc: DocRequest) => void;
}) {
  const { ward } = familiar;
  const contract = contractReport(familiar);
  const met = contract.filter((check) => check.pass).length;
  const contractOk = met === contract.length;
  const autoCount = ward.approvalTiers.auto.length;
  const reviewCount = ward.approvalTiers.humanReview.length;
  const pathCount = ward.editablePaths.length;

  const specs: AccessGroupSpec[] = [
    {
      key: 'auto',
      icon: 'check',
      label: 'May act',
      summary: 'Runs immediately, logged to the ledger',
      count: String(autoCount),
      tone: 'secondary',
      items: ward.approvalTiers.auto.map((text) => ({
        text,
        docTitle: 'ward.toml',
        open: () => onOpenDoc({ file: 'ward.toml', hl: text }),
      })),
    },
    {
      key: 'review',
      icon: 'hand',
      label: 'Must ask',
      summary: 'Held until you approve or decline',
      count: String(reviewCount),
      tone: 'warn',
      items: ward.approvalTiers.humanReview.map((text) => ({
        text,
        warn: true,
        ...(heldTitles.includes(text.toLowerCase()) ? { badge: '1 held now' } : {}),
        docTitle: 'ward.toml',
        open: () => onOpenDoc({ file: 'ward.toml', hl: text }),
      })),
    },
    {
      key: 'paths',
      icon: 'folder-open',
      label: 'Workspace reach',
      summary: `The only paths ${familiar.name} may change`,
      count: String(pathCount),
      tone: 'secondary',
      items: ward.editablePaths.map((path) => ({
        text: path,
        mono: true,
        icon: path.endsWith('/') ? 'folder-open' : 'file-text',
        file: path.endsWith('/') ? 'directory' : 'file',
        docTitle: path,
        open: () => onOpenDoc({ file: path }),
      })),
    },
    {
      key: 'contract',
      icon: 'seal-check',
      label: 'Familiar contract',
      summary: `ward.toml ${ward.version} · ${met} of ${contract.length} properties met`,
      count: `${met}/${contract.length}`,
      tone: contractOk ? 'secondary' : 'warn',
      items: contract.map((check) => ({
        text: check.property,
        note: check.note,
        file: check.file,
        warn: !check.pass,
        docTitle: check.file,
        open: () => onOpenDoc({ file: check.file }),
      })),
      meter: contract.map((check) => check.pass),
    },
  ];

  const isOpen = (key: AccessGroupKey) =>
    allOpen || (groups[key] ?? (key === 'contract' ? !contractOk : true));

  return (
    <div className="fr-stack">
      <div className="fr-card fr-card--lift fr-access-hero">
        <span className="fr-access-kicker">
          <span className="fr-accent-icon">
            <Icon name="hand" size={13} />
          </span>
          Human in control
        </span>
        <span className="fr-access-title">Clear boundaries, visible at a glance.</span>
        <span className="fr-access-text">
          {familiar.name} handles routine work. Consequential actions stop for you.
        </span>
        <span className="fr-access-summary">
          <span className="fr-accent">{autoCount} may act</span> ·{' '}
          <span className="fr-warn">{reviewCount} must ask</span> · {pathCount} editable paths ·{' '}
          <code className="fr-mono fr-small">ward.toml {ward.version}</code>
        </span>
      </div>
      {specs.map((group) => {
        const open = isOpen(group.key);

        return (
          <div key={group.key} className="fr-card fr-card--lift fr-access-group">
            <button
              type="button"
              className="fr-group-toggle"
              aria-expanded={open}
              onClick={() => onToggleGroup(group.key, !open)}
            >
              <span className={cx('fr-group-icon', group.tone === 'warn' && 'fr-warn')}>
                <Icon name={group.icon} size={14} />
              </span>
              <span className="fr-group-copy">
                <span className="fr-group-label">{group.label}</span>
                <span className="fr-group-summary">{group.summary}</span>
              </span>
              <span className="fr-group-count">{group.count}</span>
              <span className={cx('fr-caret', open && 'fr-caret--open')}>
                <Icon name="caret-down" size={14} />
              </span>
            </button>
            {open ? (
              <>
                {group.meter ? (
                  <div className="fr-meter" aria-hidden="true">
                    {group.meter.map((pass, position) => (
                      <span
                        // A meter segment has no identity beyond its position.
                        key={`${group.key}-${position}`}
                        className={cx('fr-meter-seg', !pass && 'fr-meter-seg--warn')}
                      />
                    ))}
                  </div>
                ) : null}
                <ul className="fr-group-list">
                  {group.items.map((item) => (
                    <li key={item.text}>
                      <button
                        type="button"
                        className="fr-group-item"
                        title={`Open ${item.docTitle}`}
                        onClick={item.open}
                      >
                        <span className="fr-group-item-copy">
                          <span className="fr-group-item-head">
                            {item.warn ? <span className="fr-dot" aria-hidden="true" /> : null}
                            {item.icon ? (
                              <span className="fr-secondary-icon">
                                <Icon name={item.icon} size={14} />
                              </span>
                            ) : null}
                            <span
                              className={cx(
                                'fr-group-item-text',
                                item.mono && 'fr-group-item-text--mono',
                              )}
                            >
                              {item.text}
                            </span>
                          </span>
                          {item.note ? (
                            <span className="fr-group-item-note">{item.note}</span>
                          ) : null}
                        </span>
                        <span className="fr-group-item-side">
                          {item.badge ? <span className="fr-badge-warn">{item.badge}</span> : null}
                          {item.file ? <code className="fr-file-tag">{item.file}</code> : null}
                        </span>
                        <span className="fr-muted-icon">
                          <Icon name="caret-right" size={12} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- activity */

type Bar = Readonly<{
  label: string;
  value: string;
  width: number;
  fill: 'accent' | 'muted' | 'danger';
}>;

type ActivitySection = Readonly<{
  key: ActivityKey;
  icon: IconName;
  tone: RunTone | 'secondary';
  label: string;
  hint: string;
  value: string;
  mono?: boolean;
  rows?: readonly RunRow[];
  runsTable?: boolean;
  bars?: readonly Bar[];
  note?: string;
}>;

const TONE_COLOR: Record<RunTone | 'secondary', string> = {
  ok: 'var(--text-muted)',
  warn: 'var(--color-warning)',
  bad: 'var(--color-danger)',
  secondary: 'var(--text-secondary)',
};

const TONE_ICON: Record<RunTone, IconName> = {
  ok: 'check',
  warn: 'hand',
  bad: 'warning-circle-fill',
};

function toneStyle(tone: RunTone | 'secondary'): CSSProperties {
  return { '--tone': TONE_COLOR[tone] } as CSSProperties;
}

function sectionsFor(activity: FamActivity): ActivitySection[] {
  const runs = activity.recent.map(runRow);
  const failedRuns = activity.recent.filter((run) => run.tone === 'bad').length;
  const heldRuns = activity.recent.filter((run) => run.tone === 'warn').length;
  const toolMax = Math.max(...activity.tools.map((tool) => tool.calls));
  const totalFails = activity.tools.reduce((sum, tool) => sum + (tool.failed ?? 0), 0);
  const recentHint =
    [heldRuns ? `${heldRuns} held` : null, failedRuns ? `${failedRuns} failed` : null]
      .filter(Boolean)
      .join(' · ') || 'All completed';

  return [
    {
      key: 'completion',
      icon: 'check',
      tone: 'secondary',
      label: 'Completion',
      hint: activity.runs,
      value: activity.completion,
      rows: activity.outcomes.map(([title, count, tone]) => ({
        title,
        dur: '',
        calls: '',
        note: '',
        status: String(count),
        tone: count > 0 ? tone : 'ok',
      })),
      note: 'A held run counts as in progress, not failed. Completion is completed ÷ attempted over the window.',
    },
    {
      key: 'duration',
      icon: 'timer',
      tone: 'secondary',
      label: 'Median duration',
      hint: 'Across completed runs',
      value: activity.median,
      mono: true,
      bars: activity.spread.map(([label, value], position) => ({
        label,
        value,
        width: [28, 52, 84, 100][position] ?? 100,
        fill: position === 1 ? 'accent' : 'muted',
      })),
      note: 'Wall-clock time from first tool call to result, excluding time spent waiting on you.',
    },
    {
      key: 'tools',
      icon: 'wrench',
      tone: totalFails > 0 ? 'bad' : 'secondary',
      label: 'Tool calls',
      hint: activity.failures,
      value: activity.calls,
      bars: activity.tools.map((tool) => ({
        label: tool.name,
        value: tool.failed ? `${tool.calls} · ${tool.failed} failed` : String(tool.calls),
        width: Math.round((tool.calls / toolMax) * 100),
        fill: tool.failed ? 'danger' : 'accent',
      })),
      note: 'Every call ran inside the may-act tier; nothing outside the ward was attempted.',
    },
    {
      key: 'recent',
      icon: 'clock-counter-clockwise',
      tone: failedRuns > 0 ? 'bad' : heldRuns > 0 ? 'warn' : 'secondary',
      label: 'Recent runs',
      hint: recentHint,
      value: String(activity.recent.length),
      rows: runs,
      runsTable: true,
    },
  ];
}

function ActivityTab({
  familiar,
  activity,
  open,
  onToggle,
}: {
  familiar: MockFamiliar;
  activity: FamActivity | undefined;
  open: ActivityKey | null;
  onToggle: (key: ActivityKey) => void;
}) {
  if (!activity) {
    return (
      <div className="fr-inspector-empty fr-inspector-empty--runs">
        <span className="fr-empty-glyph fr-empty-glyph--lg">
          <Icon name="clock-counter-clockwise" size={18} />
        </span>
        <span className="fr-inspector-empty-title">No runs yet</span>
        <span className="fr-inspector-empty-text">
          Activity appears after {familiar.name} completes work in this project.
        </span>
        <FamButton variant="secondary" size="sm">
          Start a task
        </FamButton>
      </div>
    );
  }

  const sections = sectionsFor(activity);
  const days = dayBars(activity.days);
  const total = activity.days.reduce((sum, [ok, fail]) => sum + ok + fail, 0);
  const ok = activity.days.reduce((sum, [done]) => sum + done, 0);
  const fail = total - ok;

  return (
    <div className="fr-activity">
      <div className="fr-activity-head">
        <span>Last 7 days</span>
        <span className="fr-activity-updated">updated {activity.updated}</span>
      </div>
      <div className="fr-activity-body">
        {sections.map((section) => {
          const expanded = open === section.key;

          return (
            <div key={section.key} className="fr-act-item">
              <button
                type="button"
                className="fr-act-section"
                aria-expanded={expanded}
                onClick={() => onToggle(section.key)}
                style={toneStyle(section.tone)}
              >
                <span className="fr-act-icon">
                  <Icon name={section.icon} size={14} />
                </span>
                <span className="fr-act-copy">
                  <span className="fr-act-label">{section.label}</span>
                  <span className="fr-act-hint">{section.hint}</span>
                </span>
                <span className={cx('fr-act-value', section.mono && 'fr-mono')}>
                  {section.value}
                </span>
                <span className={cx('fr-caret fr-act-caret', expanded && 'fr-caret--open')}>
                  <Icon name="caret-down" size={14} />
                </span>
              </button>
              {expanded ? (
                <div className="fr-act-body">
                  {section.rows ? (
                    <RunsTable rows={section.rows} header={section.runsTable === true} />
                  ) : null}
                  {section.bars ? <BarList bars={section.bars} /> : null}
                  {section.note ? <p className="fr-act-note">{section.note}</p> : null}
                </div>
              ) : null}
            </div>
          );
        })}
        <div className="fr-card fr-chart-card">
          <div className="fr-chart-head">
            <span className="fr-chart-title">Runs per day</span>
            <span className="fr-chart-hint">last 7 days</span>
          </div>
          <div className="fr-chart">
            <div className="fr-chart-summary">
              <span className="fr-nowrap">
                <span className="fr-chart-total">{total}</span> runs ·{' '}
                <span className="fr-chart-num">{ok}</span> completed ·{' '}
                <span className={cx('fr-chart-num', fail > 0 && 'fr-chart-num--danger')}>
                  {fail}
                </span>{' '}
                failed
              </span>
              <span className="fr-chart-legend">
                <span className="fr-chart-legend-item">
                  <span className="fr-chart-swatch" />
                  completed
                </span>
                <span className="fr-chart-legend-item">
                  <span className="fr-chart-swatch fr-chart-swatch--fail" />
                  failed
                </span>
              </span>
            </div>
            <div className="fr-chart-plot">
              <div className="fr-chart-grid" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </div>
              <div className="fr-chart-bars">
                {days.map((day, position) => (
                  <div
                    key={day.label}
                    className={cx('fr-chart-day', position === 6 && 'fr-chart-day--today')}
                  >
                    <span className={cx('fr-chart-count', day.count && 'fr-chart-count--on')}>
                      {day.count}
                    </span>
                    <span
                      className="fr-chart-fail"
                      style={{ '--h': `${day.failHeight}px` } as CSSProperties}
                    />
                    <span
                      className={cx('fr-chart-ok', day.failHeight > 0 && 'fr-chart-ok--stacked')}
                      style={{ '--h': `${day.okHeight}px` } as CSSProperties}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="fr-chart-labels">
              {days.map((day, position) => (
                <span key={day.label} className={cx(position === 6 && 'fr-chart-label--today')}>
                  {day.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RunsTable({ rows, header }: { rows: readonly RunRow[]; header?: boolean }) {
  return (
    <div className="fr-runs">
      {header ? (
        <div className="fr-runs-head" aria-hidden="true">
          <span />
          <span>Run</span>
          <span className="fr-right">Time</span>
          <span className="fr-right">Calls</span>
          <span className="fr-right">State</span>
        </div>
      ) : null}
      {rows.map((row) => (
        <div key={row.title} className="fr-run" style={toneStyle(row.tone)}>
          <span className="fr-run-icon">
            <Icon name={TONE_ICON[row.tone]} size={13} />
          </span>
          <span className="fr-run-copy">
            <span className="fr-run-title">{row.title}</span>
            {row.note ? <span className="fr-run-note">{row.note}</span> : null}
          </span>
          <span className="fr-run-dur">{row.dur}</span>
          <span className="fr-run-calls">{row.calls}</span>
          <span className="fr-run-status">{row.status}</span>
        </div>
      ))}
    </div>
  );
}

function BarList({ bars }: { bars: readonly Bar[] }) {
  return (
    <div className="fr-barlist">
      {bars.map((bar) => (
        <div key={bar.label} className="fr-bar">
          <code className="fr-bar-label">{bar.label}</code>
          <span className="fr-bar-track">
            <span
              className={cx('fr-bar-fill', `fr-bar-fill--${bar.fill}`)}
              style={{ '--w': `${bar.width}%` } as CSSProperties}
            />
          </span>
          <span className={cx('fr-bar-value', bar.fill === 'danger' && 'fr-bar-value--danger')}>
            {bar.value}
          </span>
        </div>
      ))}
    </div>
  );
}
