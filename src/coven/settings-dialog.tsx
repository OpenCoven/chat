import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import chatIconUrl from '../../assets/brand/chat-app-icon-rounded.svg';
import packageJson from '../../package.json';
import { cx } from '../design/familiars-ui';
import { Icon, type IconName } from '../design/minimal-icons';
import type { CovenProjectAccess } from '../lib/coven-runtime';
import { CopyButton } from './copy-button';
import { FamiliarAvatar } from './familiar-avatar';
import { INSPECTOR_DEFAULT_WIDTH } from './inspector-width';
import { closeModal, openModal } from './modal';
import { type Preferences, TEXT_SCALE, TEXT_SIZE_LABEL, TEXT_SIZES } from './preferences';
import './settings-dialog.css';

export type SettingsSection = 'general' | 'chats' | 'access' | 'devices' | 'shortcuts' | 'about';

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
  { id: 'chats', label: 'Chats', icon: 'chats-circle', blurb: 'What the familiars sidebar lists.' },
  {
    id: 'access',
    label: 'Access',
    icon: 'folder-open',
    blurb: 'Projects Coven declares for the selected familiar.',
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
  archivedFilter?: boolean | undefined;
  onArchivedFilter?: ((archived: boolean) => void) | undefined;
  archivedFilterDisabled?: boolean | undefined;
  /** The selected familiar, with its access already ordered for display. */
  familiar?: SettingsFamiliar | undefined;
  status: string;
  connected: boolean;
  onRefresh: () => void;
  refreshDisabled: boolean;
  /** The iPhone companion's opener, which owns its own dialog. */
  companion?: ReactNode;
  /** About › Updates, which owns its own state (#356). */
  updates?: ReactNode;
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
          <div className="coven-settings-scroll">
            {active?.id === 'general' ? <GeneralSection {...props} /> : null}
            {active?.id === 'chats' ? <ChatsSection {...props} /> : null}
            {active?.id === 'access' ? <AccessSection {...props} /> : null}
            {active?.id === 'devices' ? <DevicesSection {...props} /> : null}
            {active?.id === 'shortcuts' ? <ShortcutsSection /> : null}
            {active?.id === 'about' ? <AboutSection {...props} /> : null}
          </div>
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
}: Readonly<{ label: string; hint?: ReactNode; control: ReactNode; htmlFor?: string }>) {
  return (
    <div className="coven-settings-row">
      <span className="coven-settings-row-copy">
        {htmlFor ? (
          <label className="coven-settings-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="coven-settings-row-label">{label}</span>
        )}
        {hint ? <span className="coven-settings-row-hint">{hint}</span> : null}
      </span>
      <span className="coven-settings-row-control">{control}</span>
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
            <span className="coven-inspector-width">
              <span className="coven-inspector-width-value">{preferences.inspectorWidth}px</span>
              <button
                type="button"
                className="fr-btn fr-btn--secondary fr-btn--sm"
                aria-label="Reset inspector width"
                disabled={preferences.inspectorWidth === INSPECTOR_DEFAULT_WIDTH}
                onClick={() => onPreferences({ inspectorWidth: INSPECTOR_DEFAULT_WIDTH })}
              >
                Reset
              </button>
            </span>
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

function AccessSection({ familiar, onRefresh, refreshDisabled }: SettingsDialogProps) {
  const [query, setQuery] = useState('');
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
      </div>
      {all.length ? (
        <>
          {all.length > 6 ? (
            <label className="coven-access-filter">
              <Icon name="magnifying-glass" size={13} />
              <input
                type="search"
                aria-label="Filter projects"
                placeholder="Filter projects"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          ) : null}
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
        </>
      ) : (
        <div className="coven-settings-empty">
          <Icon name="folder-open" size={22} />
          <p>
            {familiar.projectAccessUnavailable
              ? `Chat could not read Coven's project registry or grants, so ${familiar.name}'s declared access is unknown. Check them in Coven, then refresh.`
              : `No project access is declared for ${familiar.name} in Coven's project registry or grants.`}
          </p>
        </div>
      )}
      <p className="coven-settings-footnote">
        Chat shows access as Coven declares it and neither enforces nor extends it. Change it in
        Coven, then{' '}
        <button
          type="button"
          className="coven-settings-link"
          disabled={refreshDisabled}
          onClick={onRefresh}
        >
          refresh
        </button>
        . Tool approval controls are not available in this app.
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

function AboutSection({
  status,
  connected,
  onRefresh,
  refreshDisabled,
  updates,
}: SettingsDialogProps) {
  return (
    <>
      <div className="coven-about-hero">
        <img className="coven-about-mark" src={chatIconUrl} alt="" width={44} height={44} />
        <div>
          <span className="coven-about-name">Coven Chat</span>
          <span className="coven-about-version">Version {packageJson.version}</span>
        </div>
      </div>
      {updates ? (
        <div className="coven-settings-group">
          <h3 className="coven-settings-group-title">Updates</h3>
          <div className="coven-settings-card">{updates}</div>
        </div>
      ) : null}
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
