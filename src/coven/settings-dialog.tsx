import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import chatIconUrl from '../../assets/brand/chat-app-icon-rounded.svg';
import packageJson from '../../package.json';
import { cx } from '../design/familiars-ui';
import { Icon, type IconName } from '../design/minimal-icons';
import type { CovenProjectAccess, PermissionLogEntry } from '../lib/coven-runtime';
import { CopyButton } from './copy-button';
import { FamiliarAvatar } from './familiar-avatar';
import { INSPECTOR_DEFAULT_WIDTH } from './inspector-width';
import { closeModal, openModal } from './modal';
import {
  HARNESS_LABEL,
  HARNESSES,
  isValidModel,
  MODEL_MAX,
  modelsByHarness,
  type Preferences,
  runOptions,
  SPEED_LABEL,
  SPEEDS,
  TEXT_SCALE,
  TEXT_SIZE_LABEL,
  TEXT_SIZES,
} from './preferences';
import './settings-dialog.css';

export type SettingsSection =
  | 'general'
  | 'model'
  | 'chats'
  | 'access'
  | 'devices'
  | 'shortcuts'
  | 'about';

const SECTIONS: readonly Readonly<{
  id: SettingsSection;
  label: string;
  icon: IconName | '⌘';
  blurb: string;
}>[] = [
  {
    id: 'general',
    label: 'General',
    icon: 'sliders-horizontal',
    blurb: 'How conversations read in this window.',
  },
  {
    id: 'model',
    label: 'Model',
    icon: 'brain',
    blurb: 'What runs the messages you send from this window.',
  },
  { id: 'chats', label: 'Chats', icon: 'chats-circle', blurb: 'What the familiars sidebar lists.' },
  {
    id: 'access',
    label: 'Access',
    icon: 'folder-open',
    blurb: 'Familiar chats run with full access as your user account.',
  },
  { id: 'devices', label: 'Devices', icon: 'monitor', blurb: 'Your iPhone and remote screens.' },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    icon: '⌘',
    blurb: 'Keys that work anywhere in the window.',
  },
  { id: 'about', label: 'About', icon: 'info', blurb: 'This app and the Coven CLI it talks to.' },
];

/** True on Windows, where Chat can't read Coven Cave's project metadata yet (#587). */
export function isWindowsPlatform(): boolean {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return /^Win/.test(nav?.platform ?? '');
}

/** True on Apple platforms, where shortcuts read ⌘ and ⇧ rather than Ctrl and Shift. */
export function isApplePlatform(): boolean {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return /Mac|iPhone|iPad/i.test(nav?.platform || nav?.userAgent || '');
}

/** The window's shortcuts, spelled for the reader's platform. */
export function shortcutList(
  apple: boolean,
): readonly Readonly<{ keys: string[]; label: string }>[] {
  const mod = apple ? '⌘' : 'Ctrl';
  const shift = apple ? '⇧' : 'Shift';
  return [
    { keys: [mod, '\\'], label: 'Show or hide the familiars rail' },
    { keys: [mod, shift, '\\'], label: 'Show or hide the inspector rail' },
    { keys: [mod, 'K'], label: 'Search familiars' },
    { keys: [mod, '['], label: 'Previous familiar' },
    { keys: [mod, ']'], label: 'Next familiar' },
    { keys: [mod, 'F'], label: 'Find in the conversation' },
    { keys: [mod, ','], label: 'Open settings' },
    { keys: ['⏎'], label: 'Send the message' },
    { keys: [shift, '⏎'], label: 'Start a new line' },
    { keys: ['Space'], label: 'Preview a focused attachment' },
    { keys: ['Esc'], label: 'Close a dialog or overlaid rail' },
  ];
}

/** `/Users/name/…` and `/home/name/…` read as `~/…`; the full path stays in the tooltip. */
export function homeRelative(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

export type SettingsFamiliar = Readonly<{
  name: string;
  avatarUrl?: string | undefined;
  projectAccess: readonly CovenProjectAccess[];
  projectAccessUnavailable?: boolean | undefined;
}>;

export type SettingsDialogProps = Readonly<{
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
  preferences: Preferences;
  onPreferences: (patch: Partial<Preferences>) => void;
  chatHarness?: string | undefined;
  archivedFilter?: boolean | undefined;
  onArchivedFilter?: ((archived: boolean) => void) | undefined;
  archivedFilterDisabled?: boolean | undefined;
  /** The selected familiar, with its access already ordered for display. */
  familiar?: SettingsFamiliar | undefined;
  status: string;
  connected: boolean;
  onRefresh: () => void;
  refreshDisabled: boolean;
  onRefreshProjectAccess?: (() => Promise<void>) | undefined;
  /** The iPhone companion's opener, which owns its own dialog. */
  companion?: ReactNode;
  /** Reads the permission log, newest first. */
  onPermissionLog?: (() => Promise<PermissionLogEntry[]>) | undefined;
  /** The name a familiar goes by, for the log's lines. */
  familiarName?: ((id: string) => string) | undefined;
}>;

/**
 * Settings, in one modal: a section rail on the left, the section on the
 * right. Everything here is real: preferences take effect as they change,
 * and Access shows what Coven declares without claiming to enforce it.
 */
export function SettingsDialog(props: SettingsDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const onClose = props.onClose;
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    openModal(node);
    node.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    return () => closeModal(node);
  }, []);
  const active = SECTIONS.find((item) => item.id === props.section) ?? SECTIONS[0];
  const titleId = useId();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes; Escape is the keyboard path, handled by the native dialog.
    <dialog
      ref={dialog}
      className="coven-settings"
      aria-label="Settings"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeModal(event.currentTarget);
      }}
    >
      <div className="coven-settings-frame">
        <nav className="coven-settings-nav" aria-label="Settings sections">
          <div className="coven-settings-brand">
            <span className="coven-settings-eyebrow">Coven Chat</span>
            <span className="coven-settings-heading">Settings</span>
          </div>
          <ul>
            {SECTIONS.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="coven-settings-nav-item"
                  aria-current={item.id === active?.id ? 'page' : undefined}
                  onClick={() => props.onSection(item.id)}
                >
                  <span className="coven-settings-nav-icon" aria-hidden="true">
                    {item.icon === '⌘' ? '⌘' : <Icon name={item.icon} size={15} />}
                  </span>
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <section className="coven-settings-body" aria-labelledby={titleId}>
          <header className="coven-settings-head">
            <div>
              <h2 id={titleId}>{active?.label}</h2>
              <p>{active?.blurb}</p>
            </div>
            <button
              type="button"
              className="coven-settings-close"
              aria-label="Close settings"
              title="Close (Esc)"
              onClick={() => dialog.current && closeModal(dialog.current)}
            >
              <Icon name="x" size={15} />
            </button>
          </header>
          <section
            key={active?.id}
            className="coven-settings-scroll"
            aria-label="Settings content"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll sections that have no controls, such as Shortcuts.
            tabIndex={0}
          >
            {active?.id === 'general' ? <GeneralSection {...props} /> : null}
            {active?.id === 'model' ? <ModelSection {...props} /> : null}
            {active?.id === 'chats' ? <ChatsSection {...props} /> : null}
            {active?.id === 'access' ? <AccessSection {...props} /> : null}
            {active?.id === 'devices' ? <DevicesSection {...props} /> : null}
            {active?.id === 'shortcuts' ? <ShortcutsSection /> : null}
            {active?.id === 'about' ? <AboutSection {...props} /> : null}
          </section>
        </section>
      </div>
    </dialog>
  );
}

function Group({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <div className="coven-settings-group">
      <h3 className="coven-settings-group-title">{title}</h3>
      <div className="coven-settings-card">{children}</div>
    </div>
  );
}

function Row({
  label,
  hint,
  control,
  htmlFor,
  stacked,
}: Readonly<{
  label: string;
  hint?: ReactNode;
  control: ReactNode;
  htmlFor?: string;
  /** Puts a wide control under its label instead of beside it. */
  stacked?: boolean;
}>) {
  return (
    // The copy is paragraphs, not spans: WebKitGTK hands AT-SPI no text for a
    // row drawn only in spans, so Orca had nothing to read here (#548).
    <div className={cx('coven-settings-row', stacked && 'coven-settings-row--stacked')}>
      <div className="coven-settings-row-copy">
        {htmlFor ? (
          <label className="coven-settings-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <p className="coven-settings-row-label">{label}</p>
        )}
        {hint ? <p className="coven-settings-row-hint">{hint}</p> : null}
      </div>
      <div className="coven-settings-row-control">{control}</div>
    </div>
  );
}

/** A native checkbox drawn as a switch, so it keeps the checkbox's semantics. */
function Switch({
  id,
  checked,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  checked: boolean;
  disabled?: boolean | undefined;
  onChange: (value: boolean) => void;
}>) {
  return (
    <input
      id={id}
      type="checkbox"
      className="coven-switch"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function GeneralSection({ preferences, onPreferences }: SettingsDialogProps) {
  const groupId = useId();
  const widthId = useId();
  return (
    <>
      <Group title="Text size">
        <fieldset className="coven-text-sizes" aria-label="Text size">
          {TEXT_SIZES.map((size) => (
            <label
              key={size}
              className="coven-text-size"
              data-checked={preferences.textSize === size || undefined}
            >
              <input
                type="radio"
                name="coven-text-size"
                value={size}
                checked={preferences.textSize === size}
                onChange={() => onPreferences({ textSize: size })}
              />
              <span
                className="coven-text-size-sample"
                aria-hidden="true"
                style={{ fontSize: `${Math.round(17 * TEXT_SCALE[size])}px` }}
              >
                Aa
              </span>
              <span className="coven-text-size-label">{TEXT_SIZE_LABEL[size]}</span>
            </label>
          ))}
        </fieldset>
        <p
          className="coven-text-size-preview"
          style={{ fontSize: `${(16 * TEXT_SCALE[preferences.textSize]).toFixed(1)}px` }}
        >
          Messages in every chat read at this size.
        </p>
      </Group>
      <Group title="Inspector">
        <Row
          label="Inspector width"
          hint="Drag the inspector's left edge, or focus its Resize inspector handle and use the arrow keys, Home and End. The conversation keeps at least 440px."
          control={
            <div className="coven-inspector-width">
              <p id={widthId} className="coven-inspector-width-value">
                {preferences.inspectorWidth}px
              </p>
              <button
                type="button"
                className="fr-btn fr-btn--secondary fr-btn--sm"
                aria-label="Reset inspector width"
                aria-describedby={widthId}
                disabled={preferences.inspectorWidth === INSPECTOR_DEFAULT_WIDTH}
                onClick={() => onPreferences({ inspectorWidth: INSPECTOR_DEFAULT_WIDTH })}
              >
                Reset
              </button>
            </div>
          }
        />
      </Group>
      <Group title="Tool activity">
        <Row
          label="Group tool calls"
          htmlFor={groupId}
          hint="Fold two or more calls in a row into one line, such as “Ran 4 commands and read 2 files”. Click the line to see each call."
          control={
            <Switch
              id={groupId}
              checked={preferences.groupTools}
              onChange={(groupTools) => onPreferences({ groupTools })}
            />
          }
        />
      </Group>
    </>
  );
}

/** A set of mutually exclusive choices drawn as one segmented control. */
function Choices<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: Readonly<{
  label: string;
  options: readonly T[];
  labels: Readonly<Record<T, string>>;
  value: T;
  onChange: (value: T) => void;
}>) {
  return (
    <fieldset className="fr-segmented" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className="fr-segmented-option"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {labels[option]}
        </button>
      ))}
    </fieldset>
  );
}

const CODEX_MODELS = [
  ['gpt-6-astra', 'GPT-6 Astra'],
  ['gpt-6.1-sol', 'GPT-6.1 Sol'],
  ['gpt-6.1-terra', 'GPT-6.1 Terra'],
  ['gpt-6-luna', 'GPT-6 Luna'],
] as const;
const CLAUDE_MODELS = [
  ['claude-fable-5-2', 'Claude Fable 5.2'],
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5'],
] as const;
const ENGINE_MODEL_GROUPS: Readonly<
  Record<string, readonly { label: string; models: readonly (readonly [string, string])[] }[]>
> = {
  // Coven Code 0.9 routes GPT models through its Codex sign-in provider and
  // strips that prefix before sending. Its direct Anthropic path needs bare IDs.
  'coven-code': [
    {
      label: 'OpenAI (Codex sign-in)',
      models: CODEX_MODELS.map(([id, label]) => [`codex/${id}`, label]),
    },
    { label: 'Anthropic', models: CLAUDE_MODELS },
  ],
  codex: [{ label: 'OpenAI', models: CODEX_MODELS }],
  claude: [{ label: 'Anthropic', models: CLAUDE_MODELS }],
};
const CUSTOM_MODEL = ':custom';

function ModelSection({ preferences, onPreferences, chatHarness }: SettingsDialogProps) {
  const modelId = useId();
  const customId = useId();
  const modelErrorId = useId();
  const thinkId = useId();
  const [editingCustom, setEditingCustom] = useState(false);
  const { harness, model } = runOptions(preferences, chatHarness);
  const validModel = isValidModel(model);
  const groups = ENGINE_MODEL_GROUPS[harness] ?? [];
  const preset = groups.some(({ models }) => models.some(([id]) => id === model));
  const custom = editingCustom || (model !== '' && !preset);
  function chooseModel(model: string) {
    onPreferences({ model, models: { ...modelsByHarness(preferences), [harness]: model } });
  }
  return (
    <>
      <Group title="New chats">
        <Row
          stacked
          label="Runs on"
          hint="A familiar's chat starts on this and keeps it from then on. Only Coven Code takes attached files."
          control={
            <Choices
              label="Runs on"
              options={HARNESSES}
              labels={HARNESS_LABEL}
              value={preferences.harness}
              onChange={(harness) => {
                setEditingCustom(false);
                onPreferences({ harness, models: modelsByHarness(preferences) });
              }}
            />
          }
        />
      </Group>
      <Group title="Every message">
        <Row
          stacked
          label="Model"
          htmlFor={modelId}
          hint={
            validModel ? (
              `Models are saved separately for each engine. This chat uses ${HARNESS_LABEL[harness]}. Choose Engine default or enter an ID for this engine under Custom model.`
            ) : (
              <span id={modelErrorId} className="coven-settings-row-error">
                A model id starts with a letter or digit and uses only letters, digits and _ . / : +
                -. Messages won't send until you correct it or clear it.
              </span>
            )
          }
          control={
            <div className="coven-model-controls">
              <select
                id={modelId}
                className="coven-model-select"
                value={custom ? CUSTOM_MODEL : model}
                onChange={(event) => {
                  const model = event.target.value;
                  setEditingCustom(model === CUSTOM_MODEL);
                  if (model !== CUSTOM_MODEL) chooseModel(model);
                }}
              >
                <option value="">Engine default</option>
                {groups.map(({ label, models }) => (
                  <optgroup key={label} label={label}>
                    {models.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </optgroup>
                ))}
                <option value={CUSTOM_MODEL}>Custom model</option>
              </select>
              {custom ? (
                <>
                  <label className="coven-settings-row-label" htmlFor={customId}>
                    Custom model ID
                  </label>
                  <span className="coven-access-filter coven-model-field">
                    <input
                      id={customId}
                      type="text"
                      placeholder="provider/model"
                      spellCheck={false}
                      autoComplete="off"
                      autoCapitalize="off"
                      maxLength={MODEL_MAX}
                      value={model}
                      aria-invalid={validModel ? undefined : true}
                      aria-describedby={validModel ? undefined : modelErrorId}
                      onChange={(event) => chooseModel(event.target.value.trim())}
                    />
                  </span>
                </>
              ) : null}
            </div>
          }
        />
        <Row
          label="Think longer"
          htmlFor={thinkId}
          hint="Ask for deeper reasoning. Coven Code and Claude Code use it. Codex ignores it, so Chat doesn't send it there."
          control={
            <Switch
              id={thinkId}
              checked={preferences.think}
              onChange={(think) => onPreferences({ think })}
            />
          }
        />
        <Row
          stacked
          label="Speed"
          hint="How long to spend on a reply. Coven Code and Claude Code use it. Codex ignores it, so Chat doesn't send it there."
          control={
            <Choices
              label="Speed"
              options={SPEEDS}
              labels={SPEED_LABEL}
              value={preferences.speed}
              onChange={(speed) => onPreferences({ speed })}
            />
          }
        />
      </Group>
      <p className="coven-settings-footnote">
        These apply to messages you send from this window. Messages sent from your iPhone use the
        engine's defaults.
      </p>
    </>
  );
}

function ChatsSection({
  archivedFilter,
  onArchivedFilter,
  archivedFilterDisabled,
}: SettingsDialogProps) {
  const archivedId = useId();
  return (
    <Group title="Sidebar">
      {onArchivedFilter ? (
        <Row
          label="Show archived chats"
          htmlFor={archivedId}
          hint="List archived chats in the familiars sidebar so you can open and restore them."
          control={
            <Switch
              id={archivedId}
              checked={Boolean(archivedFilter)}
              disabled={archivedFilterDisabled}
              onChange={onArchivedFilter}
            />
          }
        />
      ) : (
        <Row
          label="Archived chats"
          hint="Archiving is not available while Chat cannot reach Coven."
          control={null}
        />
      )}
    </Group>
  );
}

function logLine(entry: PermissionLogEntry, name: string): string {
  const device = entry.device === 'iphone' ? 'iPhone' : 'this computer';
  const summary = entry.summary ?? '';
  switch (entry.event) {
    case 'requested':
      return `${name} asked: ${summary}`;
    case 'allowed':
      return `Allowed on ${device} for ${name}: ${summary}`;
    case 'declined':
      return `Declined on ${device} for ${name}: ${summary}`;
    case 'superseded':
      return `A new message replaced ${name}'s request: ${summary}`;
    case 'action':
      return `${name} used ${entry.tool ?? 'a tool'}${entry.detail ? `: ${entry.detail}` : ''}`;
    case 'finished':
      return `${name}'s allowed turn ${entry.outcome === 'completed' ? 'finished' : (entry.outcome ?? 'ended')}.`;
  }
}

function PermissionLog({ onPermissionLog, familiarName }: SettingsDialogProps) {
  const [log, setLog] = useState<{ entries: PermissionLogEntry[]; error: string } | null>(null);
  useEffect(() => {
    if (!onPermissionLog) return;
    let alive = true;
    onPermissionLog()
      .then((entries) => {
        if (alive) setLog({ entries, error: '' });
      })
      .catch((failure: unknown) => {
        if (alive)
          setLog({
            entries: [],
            error: failure instanceof Error ? failure.message : String(failure),
          });
      });
    return () => {
      alive = false;
    };
  }, [onPermissionLog]);
  return (
    <Group title="Permission log">
      {log === null ? (
        <p className="coven-settings-footnote">Reading the log…</p>
      ) : log.error ? (
        <p className="coven-settings-footnote">{log.error}</p>
      ) : log.entries.length === 0 ? (
        <p className="coven-settings-footnote">
          Nothing yet. When a familiar asks for permission, the request, your answer and each tool
          call Coven reports from the allowed turn appear here.
        </p>
      ) : (
        // WebKit, the window on macOS and Linux, drops the list role from a list
        // drawn without markers unless the role is stated, so VoiceOver and Orca
        // would read the log as loose lines.
        // biome-ignore lint/a11y/useSemanticElements: it is an ol; WebKit needs the role stated too.
        <ol
          className="coven-permission-log"
          // biome-ignore lint/a11y/noRedundantRoles: redundant everywhere but WebKit; see above.
          role="list"
          aria-label="Permission log, newest first"
        >
          {log.entries.map((entry, index) => (
            <li
              key={`${entry.approvalId}-${entry.at}-${index}`}
              className={`coven-permission-log-entry coven-permission-log-entry--${entry.event}`}
            >
              <time dateTime={new Date(entry.at).toISOString()}>
                {new Date(entry.at).toLocaleString()}
              </time>
              <span>{logLine(entry, familiarName?.(entry.familiarId) ?? entry.familiarId)}</span>
            </li>
          ))}
        </ol>
      )}
    </Group>
  );
}

function AccessSection(props: SettingsDialogProps) {
  return (
    <>
      <FamiliarAccess {...props} />
      {props.onPermissionLog ? <PermissionLog {...props} /> : null}
    </>
  );
}

function FamiliarAccess({
  familiar,
  onRefresh,
  onRefreshProjectAccess,
  refreshDisabled,
}: SettingsDialogProps) {
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  async function refreshAccess() {
    if (!onRefreshProjectAccess) {
      onRefresh();
      return;
    }
    setRefreshing(true);
    setRefreshError('');
    try {
      await onRefreshProjectAccess();
    } catch {
      setRefreshError('Could not refresh project access. Try again.');
    } finally {
      setRefreshing(false);
    }
  }
  if (!familiar) {
    return (
      <div className="coven-settings-empty">
        <Icon name="folder-open" size={22} />
        <p>Select a familiar to see the projects Coven declares for it.</p>
      </div>
    );
  }
  const all = familiar.projectAccess;
  const writes = all.filter((project) => project.access === 'write').length;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? all.filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(needle))
    : all;
  return (
    <>
      <div className="coven-access-hero">
        <FamiliarAvatar name={familiar.name} avatarUrl={familiar.avatarUrl} size={36} />
        <div className="coven-access-hero-copy">
          <span className="coven-access-hero-name">{familiar.name}</span>
          <span className="coven-access-hero-hint">
            Declared in Coven's project registry and grants
          </span>
        </div>
        {all.length ? (
          <div className="coven-access-stats">
            <span className="coven-access-stat">
              <strong>{all.length}</strong> {all.length === 1 ? 'project' : 'projects'}
            </span>
            {writes ? (
              <span className="coven-access-stat coven-access-stat--write">
                <strong>{writes}</strong> read and write
              </span>
            ) : null}
            {all.length - writes ? (
              <span className="coven-access-stat">
                <strong>{all.length - writes}</strong> read only
              </span>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className="fr-btn fr-btn--secondary fr-btn--sm"
          disabled={refreshDisabled || refreshing}
          onClick={() => void refreshAccess()}
        >
          {refreshing ? 'Refreshing project access…' : 'Refresh project access'}
        </button>
      </div>
      {refreshError ? (
        <p className="coven-settings-row-error" role="alert">
          {refreshError}
        </p>
      ) : null}
      {all.length ? (
        <>
          {all.length > 6 || query ? (
            <label className="coven-access-filter">
              <Icon name="magnifying-glass" size={13} />
              <input
                type="search"
                aria-label="Filter projects"
                autoComplete="off"
                placeholder="Filter projects"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          ) : null}
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to focus and scroll the project list. */}
          <section className="coven-access-scroll" aria-label="Project access list" tabIndex={0}>
            <ul
              className="coven-access-list"
              aria-label={`${familiar.name}'s declared project access`}
            >
              {shown.map((project) => (
                <li key={`${project.path}:${project.access}`} className="coven-access-item">
                  <span className="coven-access-icon" aria-hidden="true">
                    <Icon name="folder-open" size={14} />
                  </span>
                  <span className="coven-access-name">{project.name}</span>
                  <span
                    className={cx(
                      'coven-access-pill',
                      project.access === 'write' && 'coven-access-pill--write',
                    )}
                  >
                    {project.access === 'write' ? 'Read and write' : 'Read only'}
                  </span>
                  <span className="coven-access-path" title={project.path}>
                    {homeRelative(project.path)}
                  </span>
                  <CopyButton
                    className="coven-access-copy"
                    text={project.path}
                    label={`Copy ${project.name} path`}
                  />
                </li>
              ))}
              {shown.length === 0 ? (
                <li className="coven-access-none">No projects match “{query.trim()}”.</li>
              ) : null}
            </ul>
          </section>
        </>
      ) : (
        <div className="coven-settings-empty">
          <Icon name="folder-open" size={22} />
          <p>
            {familiar.projectAccessUnavailable
              ? isWindowsPlatform()
                ? `Chat can't read Coven Cave's project grants on Windows yet, so ${familiar.name}'s declared access is unknown. See ${familiar.name}'s Projects tab in Coven Cave.`
                : `Chat could not read Coven's project registry or grants, so ${familiar.name}'s declared access is unknown. Check them in Coven, then refresh.`
              : `No project access is declared for ${familiar.name} in Coven's project registry or grants.`}
          </p>
        </div>
      )}
      <p className="coven-settings-footnote">
        {/* On Windows a refresh can't show Cave's grants yet (#587). */}
        {isWindowsPlatform()
          ? "To edit grants, open the familiar's Projects tab in Coven Cave."
          : "To edit grants, open the familiar's Projects tab in Coven Cave, then refresh project access here."}{' '}
        Familiar chats can change files and run commands beyond these projects without asking for
        permission.
      </p>
    </>
  );
}

function DevicesSection({ companion }: SettingsDialogProps) {
  return (
    <>
      <Group title="iPhone">
        <Row
          label="iPhone companion"
          hint="Chat with your familiars from your iPhone. Keep this Mac awake with Chat running, on the same local network."
          control={<span className="coven-settings-companion">{companion}</span>}
        />
      </Group>
      <Group title="Remote screen">
        <Row
          label="Show screen"
          hint="The screen button in a chat's header opens a remote desktop over VNC. It starts view only."
          control={null}
        />
      </Group>
    </>
  );
}

function ShortcutsSection() {
  const shortcuts = shortcutList(isApplePlatform());
  return (
    <div className="coven-settings-card coven-shortcuts">
      {shortcuts.map((shortcut) => (
        <div className="coven-shortcut" key={shortcut.label}>
          <span>{shortcut.label}</span>
          <span className="coven-shortcut-keys">
            {shortcut.keys.map((key) => (
              <kbd key={key} className="coven-keycap">
                {key}
              </kbd>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function AboutSection({ status, connected, onRefresh, refreshDisabled }: SettingsDialogProps) {
  return (
    <>
      <div className="coven-about-hero">
        <img className="coven-about-mark" src={chatIconUrl} alt="" width={44} height={44} />
        <div>
          <span className="coven-about-name">Coven Chat</span>
          <span className="coven-about-version">Version {packageJson.version}</span>
        </div>
      </div>
      <Group title="Coven CLI">
        <Row
          label={connected ? 'Connected' : 'Not connected'}
          hint={status || 'Chat has not reached the Coven CLI yet.'}
          control={
            <button
              type="button"
              className="fr-btn fr-btn--secondary coven-settings-button"
              disabled={refreshDisabled}
              onClick={onRefresh}
            >
              Refresh local data
            </button>
          }
        />
      </Group>
      <Group title="Privacy">
        <Row
          label="What this window stores"
          hint="Your place in the app and these preferences, in local storage. Drafts stay in memory, and message text is never written there."
          control={null}
        />
      </Group>
    </>
  );
}
