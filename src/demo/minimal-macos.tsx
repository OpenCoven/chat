import { type CSSProperties, useEffect, useRef, useState } from 'react';

import { canUseTauriCommands } from '../lib/desktop-host';
import { Icon, type IconName } from './minimal-icons';
import {
  type AgentId,
  type ApprovalOutcome,
  COMPOSER_MODE_LABELS,
  type ComposerMode,
  chatInScope,
  type MessageAction,
  MINIMAL_ACTIVITY,
  MINIMAL_AGENTS,
  MINIMAL_APPROVAL,
  MINIMAL_CHATS,
  MINIMAL_STARTERS,
  type MinimalAgent,
  type MinimalChat,
  type MinimalMessage,
  minimalTranscript,
  type PermissionState,
  type ProjectScope,
  projectsOf,
  SHORT_REPLY_ACTIONS,
} from './minimal-mock';

/**
 * The Minimal (macOS) surface.
 *
 * An implementation of the approved design of the same name: one window, a
 * sidebar of chats and familiars, a transcript, and a composer, with the
 * activity panel, the approval sheet, the familiar sheet and settings layered
 * over it. Driven entirely by local fixtures — it connects to nothing, and the
 * Phase 0 scaffold is still what the app is. This renders at `?demo=minimal`.
 *
 * Two things the design is arguing, which the code has to keep rather than
 * merely display:
 *
 * Anything irreversible stops and asks. The push in `c1` is not a progress bar
 * that happens to pause; the transcript's last line changes to say what was
 * decided, and it says "nothing left this machine" when the answer was no.
 *
 * A familiar is accountable. The sheet leads with who it is, what it may do
 * here, and which of those wait for you — before anything about the model.
 */

type SheetName = 'approval' | 'familiar' | 'settings';
type SettingsTab = 'appearance' | 'connection' | 'familiars' | 'general';

type Preferences = {
  appearance: 'dark' | 'light';
  confirmActions: boolean;
  launchAtLogin: boolean;
  notify: boolean;
  reduceMotion: boolean;
};

type ZoomedImage = { alt: string; caption: string; hue: number };

/** Milliseconds a toast stays up. Long enough to read, short enough to ignore. */
const TOAST_MS = 2600;

/**
 * The pause before a mock reply appears.
 *
 * A reply that lands instantly reads as a lookup rather than as a response,
 * and the typing dots need something to be waiting for.
 */
const REPLY_MS = 900;

/** Hue for a generated image, seeded off the prompt so it stays stable. */
function hueFor(prompt: string): number {
  let seed = 0;

  for (const character of prompt) {
    seed += character.charCodeAt(0);
  }

  return seed % 360;
}

/** The colour a permission's state is announced in, alongside its word. */
function permissionTone(state: PermissionState): string {
  if (state === 'Asks you') {
    return 'asks';
  }

  return state === 'Off' ? 'off' : 'allowed';
}

/**
 * How each mode presents itself in the composer.
 *
 * The order is the amount of rope the familiar gets, left to right: plan
 * before acting, answer without acting, go ahead and act. The colours follow
 * from that rather than from decoration -- amber is already this file's
 * warning colour, and "Go ahead" is the mode that needs one.
 *
 * `short` is the word on the chip; COMPOSER_MODE_LABELS stays the full phrase
 * and is what gets announced, because "Build" does not tell you that the
 * familiar is about to act without checking first.
 */
const MODE_PRESENTATION: Readonly<Record<ComposerMode, { icon: IconName; short: string }>> = {
  plan: { icon: 'squares-four', short: 'Plan' },
  ask: { icon: 'globe', short: 'Explore' },
  do: { icon: 'flask', short: 'Build' },
};

const MODE_ORDER: ReadonlyArray<ComposerMode> = ['plan', 'ask', 'do'];

function statusLabel(agent: MinimalAgent): string {
  if (agent.status === 'working') {
    return 'Working';
  }

  return agent.status === 'offline' ? 'Offline' : 'Ready';
}

// ── Chrome ──────────────────────────────────────────────────────────────────

/**
 * The three window buttons.
 *
 * Decorative here: this is a demo of a window, not a window, and nothing
 * behind them would close anything. So they are `aria-hidden` rather than
 * three unlabelled buttons a screen reader has to read past.
 */
function TrafficLights() {
  return (
    <span className="mm-lights" aria-hidden="true">
      <span className="mm-light mm-light--close" />
      <span className="mm-light mm-light--min" />
      <span className="mm-light mm-light--zoom" />
    </span>
  );
}

function Mark({ agent, size }: { agent: MinimalAgent; size: number }) {
  return (
    <span
      className="mm-mark"
      aria-hidden="true"
      style={{ '--mm-hue': String(agent.hue), '--mm-mark-size': `${size}px` } as CSSProperties}
    >
      {agent.initial}
    </span>
  );
}

/** How a scope selection names itself on the button. */
function scopeLabel(scope: ProjectScope, hasProjects: boolean): string {
  if (!hasProjects) {
    return 'No projects';
  }

  if (scope.size === 0) {
    return 'All projects';
  }

  if (scope.size === 1) {
    const [only] = [...scope];

    return only ?? 'Quick chats';
  }

  // Not "N projects": one of them may be the quick chats, which is not one.
  return `${scope.size} selected`;
}

type ProjectPickerProps = Readonly<{
  onClear: () => void;
  onToggle: (project: string | null) => void;
  projects: readonly string[];
  scope: ProjectScope;
}>;

/**
 * The project scope, in the strip the traffic lights used to have to
 * themselves.
 *
 * Everything the surface shows is filtered through this, so it sits above the
 * search field rather than beside it: the search looks inside the scope, and
 * putting them on the same line would suggest they were the same kind of
 * narrowing.
 */
function ProjectPicker({ onClear, onToggle, projects, scope }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);

  // Escape closes it, like everything else layered over this surface. Bound
  // only while open, so it cannot swallow an Escape meant for a sheet.
  useEffect(() => {
    if (!open) {
      return;
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    }

    window.addEventListener('keydown', onKey, true);

    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  const hasProjects = projects.length > 0;
  const entries: ReadonlyArray<string | null> = [...projects, null];

  return (
    <div className="mm-picker">
      <button
        type="button"
        className={`mm-picker-button ${scope.size > 0 ? 'is-filtered' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="folder-open" size={13} />
        <span className="mm-picker-name">{scopeLabel(scope, hasProjects)}</span>
        <Icon name="caret-up-down" size={12} />
      </button>

      {open ? (
        <>
          {/* Same reasoning as the sheet backdrop: a real button, so closing
              by clicking away is not a mouse-only secret. */}
          <button
            type="button"
            className="mm-picker-away"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <div className="mm-picker-menu" role="menu">
            {hasProjects ? (
              <>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={scope.size === 0}
                  className={`mm-picker-item ${scope.size === 0 ? 'is-on' : ''}`}
                  onClick={onClear}
                >
                  <span className="mm-picker-check" aria-hidden="true">
                    {scope.size === 0 ? <Icon name="check-circle-fill" size={13} /> : null}
                  </span>
                  All projects
                </button>

                <div className="mm-picker-rule" />

                {entries.map((project) => (
                  <button
                    key={project ?? 'quick'}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={scope.has(project)}
                    className={`mm-picker-item ${scope.has(project) ? 'is-on' : ''}`}
                    onClick={() => onToggle(project)}
                  >
                    <span className="mm-picker-check" aria-hidden="true">
                      {scope.has(project) ? <Icon name="check-circle-fill" size={13} /> : null}
                    </span>
                    {project ?? 'Quick chats'}
                  </button>
                ))}
              </>
            ) : (
              /*
               * Nothing to filter by yet. The selector still appears, so the
               * control does not materialise later in a place the user has
               * never looked -- it says what it is waiting for.
               */
              <p className="mm-picker-empty">
                No projects yet. Chats you start without one stay as quick chats, and are kept for
                seven days.
              </p>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────

type SidebarProps = Readonly<{
  activeChatId: string;
  onClearScope: () => void;
  onToggleScope: (project: string | null) => void;
  projects: readonly string[];
  scope: ProjectScope;
  chats: readonly MinimalChat[];
  familiars: readonly MinimalAgent[];
  onOpenChat: (id: string) => void;
  onOpenFamiliar: (id: AgentId) => void;
  onOpenSettings: () => void;
  onQueryChange: (value: string) => void;
  query: string;
}>;

function Sidebar({
  activeChatId,
  chats,
  familiars,
  onClearScope,
  onToggleScope,
  projects,
  scope,
  onOpenChat,
  onOpenFamiliar,
  onOpenSettings,
  onQueryChange,
  query,
}: SidebarProps) {
  return (
    <aside className="mm-sidebar">
      <div className="mm-sidebar-top">
        <TrafficLights />
        <ProjectPicker
          projects={projects}
          scope={scope}
          onToggle={onToggleScope}
          onClear={onClearScope}
        />
      </div>

      <div className="mm-search-wrap">
        <div className="mm-search">
          <span className="mm-search-icon">
            <Icon name="magnifying-glass" size={13} />
          </span>
          <input
            type="search"
            placeholder="Search"
            aria-label="Search chats and familiars"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      </div>

      <div className="mm-sidebar-list">
        <section className="mm-section">
          <h2 className="mm-section-label">Chats</h2>
          {chats.length === 0 ? <p className="mm-rows-empty">Nothing here in this scope.</p> : null}
          <div className="mm-rows">
            {chats.map((chat) => (
              <button
                key={chat.id}
                type="button"
                className={`mm-row ${chat.id === activeChatId ? 'is-active' : ''}`}
                aria-current={chat.id === activeChatId ? 'page' : undefined}
                onClick={() => onOpenChat(chat.id)}
              >
                <span className={`mm-row-dot mm-row-dot--${chat.badge ?? 'none'}`} />
                <span className="mm-row-label">{chat.title}</span>
                {chat.id === activeChatId ? null : (
                  <span className="mm-row-trailing">{chat.when}</span>
                )}
              </button>
            ))}
          </div>
        </section>

        <section className="mm-section">
          <h2 className="mm-section-label">Familiars</h2>
          <div className="mm-rows">
            {familiars.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="mm-row"
                onClick={() => onOpenFamiliar(agent.id)}
              >
                <Mark agent={agent} size={20} />
                <span className="mm-row-label">{agent.name}</span>
                <span className={`mm-row-trailing mm-status--${agent.status}`}>
                  {statusLabel(agent)}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="mm-sidebar-foot">
        <button type="button" className="mm-foot-button" onClick={onOpenSettings}>
          <Icon name="gear-six" size={14} />
          Settings…
        </button>
      </div>
    </aside>
  );
}

// ── Transcript ──────────────────────────────────────────────────────────────

function ActionRow({
  actions,
  onAct,
}: {
  actions: readonly MessageAction[];
  onAct: (label: string) => void;
}) {
  return (
    <div className="mm-actions">
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className="mm-action"
          title={action.label}
          aria-label={action.label}
          onClick={() => onAct(action.label)}
        >
          <Icon name={action.icon} size={13} />
        </button>
      ))}
    </div>
  );
}

/**
 * Stand-in for a generated image.
 *
 * Inline SVG rather than a file: no binary asset to licence and review, no URL
 * literal in runtime source, and it reads as "an image was generated here"
 * without pretending to be a real model output.
 */
function GeneratedCat({ alt, hue }: { alt: string; hue: number }) {
  return (
    <svg
      viewBox="0 0 600 400"
      role="img"
      aria-label={alt}
      style={{ '--mm-hue': String(hue) } as CSSProperties}
      className="mm-generated"
    >
      <rect width="600" height="400" className="mm-generated-base" />
      <ellipse cx="300" cy="170" rx="190" ry="115" className="mm-generated-glow" />
      <g className="mm-generated-body">
        <ellipse cx="300" cy="252" rx="54" ry="64" />
        <circle cx="300" cy="176" r="43" />
        <path d="M265 146 l-7 -36 l32 21 z" />
        <path d="M335 146 l7 -36 l-32 21 z" />
        <path d="M354 268 q36 26 25 54 q-15 -19 -32 -31 z" />
      </g>
      <g className="mm-generated-eyes">
        <circle cx="286" cy="174" r="5" />
        <circle cx="314" cy="174" r="5" />
      </g>
    </svg>
  );
}

type RunCardProps = Readonly<{
  footnote: string;
  meta: string;
  onStop: () => void;
  onToggle: () => void;
  open: boolean;
  steps: readonly { text: string; took: string; done: boolean | null }[];
  text: string;
}>;

function RunCard({ footnote, meta, onStop, onToggle, open, steps, text }: RunCardProps) {
  return (
    <div className="mm-run">
      <button type="button" className="mm-run-head" aria-expanded={open} onClick={onToggle}>
        <span className="mm-dot mm-dot--running" />
        <span className="mm-run-title">{text}</span>
        <span className="mm-run-meta">{meta}</span>
        <Icon name={open ? 'caret-up' : 'caret-down'} size={12} />
      </button>
      {open ? (
        <div className="mm-run-body">
          {steps.map((step) => (
            <div key={step.text} className="mm-run-step">
              <span
                className={`mm-dot ${step.done === null ? 'mm-dot--running' : 'mm-dot--done'}`}
              />
              <span className="mm-run-step-text">{step.text}</span>
              <span className="mm-run-step-took">{step.took}</span>
            </div>
          ))}
          <div className="mm-run-foot">
            <span className="mm-run-footnote">{footnote}</span>
            <button type="button" className="mm-button" onClick={onStop}>
              Stop
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Sheets ──────────────────────────────────────────────────────────────────

type SettingsRow =
  | Readonly<{
      kind: 'menu';
      label: string;
      hint: string | null;
      value: string;
      onAct: () => void;
    }>
  | Readonly<{
      kind: 'segment';
      label: string;
      hint: string | null;
      value: string;
      options: ReadonlyArray<{ value: string; label: string }>;
      onPick: (value: string) => void;
    }>
  | Readonly<{
      kind: 'toggle';
      label: string;
      hint: string | null;
      on: boolean;
      onToggle: () => void;
    }>
  | Readonly<{ kind: 'value'; label: string; hint: string | null; value: string; mono: boolean }>;

type SettingsGroup = Readonly<{ label: string; rows: readonly SettingsRow[] }>;

const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string; icon: IconName }> = [
  { id: 'general', label: 'General', icon: 'gear-six' },
  { id: 'familiars', label: 'Familiars', icon: 'cat' },
  { id: 'appearance', label: 'Appearance', icon: 'paint-brush' },
  { id: 'connection', label: 'Connection', icon: 'heartbeat' },
];

// ── The surface ─────────────────────────────────────────────────────────────

export function MinimalMacOS() {
  const [chatId, setChatId] = useState('c1');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<ComposerMode>('plan');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activityOpen, setActivityOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [familiarId, setFamiliarId] = useState<AgentId>('cody');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [zoom, setZoom] = useState<ZoomedImage | null>(null);
  const [toast, setToast] = useState('');
  const [approval, setApproval] = useState<ApprovalOutcome>('pending');
  const [prefs, setPrefs] = useState<Preferences>({
    appearance: 'dark',
    confirmActions: true,
    launchAtLogin: false,
    notify: true,
    reduceMotion: false,
  });
  /** Anything sent during the visit, per chat, appended to the fixture. */
  const [sent, setSent] = useState<Record<string, readonly MinimalMessage[]>>({});
  /**
   * Which projects the surface is scoped to. Empty means all of them, so the
   * selector has no dead end: deselecting the last one returns you to
   * everything rather than to a blank list.
   */
  const [scope, setScope] = useState<ReadonlySet<string | null>>(() => new Set());

  const timers = useRef<number[]>([]);
  const toastTimer = useRef<number | null>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  /** Only ever counts up, so every appended message keeps a stable key. */
  const turn = useRef(0);

  const chat = MINIMAL_CHATS.find((entry) => entry.id === chatId) ?? MINIMAL_CHATS[0];
  const agent = chat === undefined ? undefined : MINIMAL_AGENTS[chat.agent];
  const familiar = MINIMAL_AGENTS[familiarId];

  const messages: readonly MinimalMessage[] = [
    ...minimalTranscript(chatId, approval),
    ...(sent[chatId] ?? []),
  ];

  const needle = query.trim().toLowerCase();
  const projects = projectsOf(MINIMAL_CHATS);
  const chats = MINIMAL_CHATS.filter(
    (entry) =>
      entry.title.toLowerCase().includes(needle) &&
      // The chat you are reading stays listed even when the scope would drop
      // it. Filtering the sidebar should not silently contradict the
      // transcript beside it, and it should never take away your place.
      (chatInScope(entry, scope) || entry.id === chatId),
  );
  const familiars = Object.values(MINIMAL_AGENTS).filter((entry) =>
    entry.name.toLowerCase().includes(needle),
  );

  // Escape closes whatever is on top, and the platform shortcut opens
  // settings, because on this platform that is where people reach first.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setSheet(null);
        setZoom(null);
      }

      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        setSheet('settings');
      }
    }

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reads only refs, so it needs no dependencies and cannot go stale.
  useEffect(() => {
    const pending = timers.current;

    return () => {
      for (const id of pending) {
        window.clearTimeout(id);
      }

      if (toastTimer.current !== null) {
        window.clearTimeout(toastTimer.current);
      }
    };
  }, []);

  const messageCount = messages.length;

  useEffect(() => {
    if (messageCount === 0 && !typing) {
      return;
    }

    transcriptEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messageCount, typing]);

  function toggleScope(project: string | null) {
    setScope((current) => {
      const next = new Set(current);

      if (!next.delete(project)) {
        next.add(project);
      }

      return next;
    });
  }

  function flash(text: string) {
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }

    setToast(text);
    toastTimer.current = window.setTimeout(() => setToast(''), TOAST_MS);
  }

  function send() {
    const text = draft.trim();

    if (text === '' || chat === undefined) {
      return;
    }

    const target = chat.id;
    const replier = MINIMAL_AGENTS[chat.agent];
    turn.current += 1;
    const id = turn.current;

    setSent((current) => ({
      ...current,
      [target]: [...(current[target] ?? []), { id: `sent-${id}`, kind: 'user', text }],
    }));
    setDraft('');
    setTyping(true);

    timers.current.push(
      window.setTimeout(() => {
        const reply =
          mode === 'ask'
            ? 'Short answer: yes — the mapper already handles it. Want the details?'
            : 'Got it. I’ll plan it out first and show you the steps before touching anything.';

        setTyping(false);
        setSent((current) => ({
          ...current,
          [target]: [
            ...(current[target] ?? []),
            {
              id: `reply-${id}`,
              kind: 'agent',
              agent: replier.id,
              text: reply,
              actions: SHORT_REPLY_ACTIONS,
            },
          ],
        }));
      }, REPLY_MS),
    );
  }

  function togglePref(key: 'confirmActions' | 'launchAtLogin' | 'notify' | 'reduceMotion') {
    setPrefs((current) => ({ ...current, [key]: !current[key] }));
  }

  const settingsPages: Readonly<
    Record<SettingsTab, { footnote: string; groups: readonly SettingsGroup[] }>
  > = {
    general: {
      footnote: 'Quick chats are kept for 7 days unless you move them into a project.',
      groups: [
        {
          label: 'Chats',
          rows: [
            {
              kind: 'menu',
              label: 'Default project',
              hint: 'Where new chats start.',
              value: 'coven-cave',
              onAct: () => flash('4 projects, or ask every time.'),
            },
            {
              kind: 'menu',
              label: 'Default familiar',
              hint: 'Who answers when you don’t pick.',
              value: 'Cody',
              onAct: () => flash('3 familiars available.'),
            },
          ],
        },
        {
          label: 'Startup',
          rows: [
            {
              kind: 'toggle',
              label: 'Open at login',
              hint: null,
              on: prefs.launchAtLogin,
              onToggle: () => togglePref('launchAtLogin'),
            },
            {
              kind: 'value',
              label: 'Quick chat shortcut',
              hint: null,
              value: '⌥ Space',
              mono: true,
            },
          ],
        },
      ],
    },
    familiars: {
      footnote:
        'Anything that leaves this Mac or can’t be undone asks you first, whatever these say.',
      groups: [
        {
          label: 'New familiars',
          rows: [
            {
              kind: 'toggle',
              label: 'Ask before actions that leave this Mac',
              hint: 'Pushing, sending, publishing.',
              on: prefs.confirmActions,
              onToggle: () => togglePref('confirmActions'),
            },
            {
              kind: 'toggle',
              label: 'Keep memory between chats',
              hint: null,
              on: true,
              onToggle: () => flash('New familiars keep memory per project.'),
            },
          ],
        },
        {
          label: 'Owner',
          rows: [
            {
              kind: 'value',
              label: 'Every familiar belongs to',
              hint: null,
              value: 'You',
              mono: false,
            },
          ],
        },
      ],
    },
    appearance: {
      footnote: 'Follows your Mac’s appearance unless you pick one.',
      groups: [
        {
          label: 'Theme',
          rows: [
            {
              kind: 'segment',
              label: 'Appearance',
              hint: null,
              value: prefs.appearance,
              options: [
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ],
              onPick: (value) => {
                setPrefs((current) => ({
                  ...current,
                  appearance: value === 'light' ? 'light' : 'dark',
                }));

                if (value === 'light') {
                  flash('Light mode ships too — this prototype shows dark.');
                }
              },
            },
            {
              kind: 'toggle',
              label: 'Reduce motion',
              hint: 'Stops the typing dots and the sheet slide.',
              on: prefs.reduceMotion,
              onToggle: () => togglePref('reduceMotion'),
            },
          ],
        },
        {
          label: 'Notifications',
          rows: [
            {
              kind: 'toggle',
              label: 'Notify me when a task finishes',
              hint: 'The alert says a familiar is done, never what it said.',
              on: prefs.notify,
              onToggle: () => togglePref('notify'),
            },
          ],
        },
      ],
    },
    connection: {
      footnote: 'Identifiers and versions live in the technical details, not here.',
      groups: [
        {
          label: 'Workspace',
          rows: [
            { kind: 'value', label: 'Connection', hint: null, value: 'Connected', mono: false },
            { kind: 'value', label: 'Workspace', hint: null, value: 'Val’s desk', mono: true },
            {
              kind: 'menu',
              label: 'Technical details',
              hint: 'Versions and identifiers for a bug report.',
              value: 'Show',
              onAct: () =>
                flash('API v1.4 · min client 1.0 · features: attachments, attention, handoff'),
            },
          ],
        },
        {
          label: 'This Mac',
          rows: [
            {
              kind: 'menu',
              label: 'Signed in',
              hint: 'Since 12 August · limited to chats and attachments.',
              value: 'Sign out',
              onAct: () => flash('Signing out only removes access from this Mac.'),
            },
          ],
        },
      ],
    },
  };

  const page = settingsPages[settingsTab];

  if (chat === undefined || agent === undefined) {
    return null;
  }

  const empty = chatId === 'new' && messages.length === 0;
  const sheetTitle =
    sheet === 'settings' ? 'Settings' : sheet === 'familiar' ? familiar.name : 'Approval needed';

  return (
    <div
      className="mm-desktop"
      // The simulated desktop, window frame and traffic lights below are how
      // this design presents itself on its own. Inside the app the real window
      // already supplies all three, and drawing them again puts a window
      // inside a window at the same size. The frame is dropped there; what is
      // being evaluated is the content, not a picture of a window.
      data-host={canUseTauriCommands() ? 'desktop' : undefined}
      data-reduce-motion={prefs.reduceMotion ? 'true' : undefined}
      data-appearance={prefs.appearance}
    >
      <div className="mm-window">
        {sidebarOpen ? (
          <Sidebar
            activeChatId={chatId}
            chats={chats}
            familiars={familiars}
            query={query}
            onQueryChange={setQuery}
            onOpenChat={(id) => {
              setChatId(id);
              setRunOpen(false);
            }}
            onOpenFamiliar={(id) => {
              setFamiliarId(id);
              setSheet('familiar');
            }}
            onOpenSettings={() => setSheet('settings')}
            projects={projects}
            scope={scope}
            onToggleScope={toggleScope}
            onClearScope={() => setScope(new Set())}
          />
        ) : null}

        <main className="mm-main">
          <header className="mm-header">
            {sidebarOpen ? null : <TrafficLights />}
            <button
              type="button"
              className="mm-icon-button"
              aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              <Icon name="sidebar-simple" size={15} />
            </button>

            <div className="mm-title">
              <p className="mm-title-main">{chat.title}</p>
              <p className="mm-title-sub">
                {chat.project === null
                  ? `No project · ${agent.name} · nothing saved`
                  : `${chat.project} · ${agent.name}`}
              </p>
            </div>

            <span className="mm-spacer" />

            {chatId === 'c1' ? (
              <span className="mm-busy">
                <span className="mm-dot mm-dot--pulse" aria-hidden="true" />
                Working
              </span>
            ) : null}

            {chatId === 'c1' && approval === 'pending' ? (
              <button
                type="button"
                className="mm-approval-pill"
                onClick={() => setSheet('approval')}
              >
                <Icon name="hand" size={12} />
                Needs your approval
              </button>
            ) : null}

            <button
              type="button"
              className={`mm-icon-button ${activityOpen ? 'is-active' : ''}`}
              aria-label="Show activity"
              aria-pressed={activityOpen}
              title="Activity"
              onClick={() => setActivityOpen((open) => !open)}
            >
              <Icon name="waveform" size={15} />
            </button>

            <button
              type="button"
              className="mm-icon-button"
              aria-label="More actions"
              title="More"
              onClick={() => {
                setFamiliarId(chat.agent);
                setSheet('familiar');
              }}
            >
              <Icon name="info" size={15} />
            </button>
          </header>

          <div className="mm-scroll">
            <div className="mm-transcript">
              {messages.map((message) => (
                <div key={message.id} className={`mm-message mm-message--${message.kind}`}>
                  {message.kind === 'user' ? <div className="mm-bubble">{message.text}</div> : null}

                  {message.kind === 'notice' ? <p className="mm-notice">{message.text}</p> : null}

                  {message.kind === 'agent' ? (
                    <div className="mm-reply">
                      <p className="mm-reply-who">
                        {MINIMAL_AGENTS[message.agent].name} · {MINIMAL_AGENTS[message.agent].role}
                      </p>
                      <p className="mm-reply-text">{message.text}</p>
                      {message.code === undefined ? null : (
                        <pre className="mm-code">{message.code}</pre>
                      )}
                      {message.actions === undefined ? null : (
                        <ActionRow
                          actions={message.actions}
                          onAct={(label) => flash(`${label} — done.`)}
                        />
                      )}
                    </div>
                  ) : null}

                  {message.kind === 'image' ? (
                    <div className="mm-image">
                      <p className="mm-reply-who">{MINIMAL_AGENTS[message.agent].name}</p>
                      <button
                        type="button"
                        className="mm-image-button"
                        aria-label="Open image in viewer"
                        onClick={() =>
                          setZoom({
                            alt: message.alt,
                            caption: message.caption,
                            hue: hueFor(message.prompt),
                          })
                        }
                      >
                        <GeneratedCat alt={message.alt} hue={hueFor(message.prompt)} />
                      </button>
                      <p className="mm-image-caption">{message.caption}</p>
                    </div>
                  ) : null}

                  {message.kind === 'run' ? (
                    <RunCard
                      footnote={message.footnote}
                      meta={message.meta}
                      open={runOpen}
                      steps={message.steps}
                      text={message.text}
                      onToggle={() => setRunOpen((open) => !open)}
                      onStop={() => flash('Stopped after step 5. Nothing was pushed.')}
                    />
                  ) : null}
                </div>
              ))}

              {typing ? (
                <div className="mm-typing" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              ) : null}

              {empty ? (
                <div className="mm-empty">
                  <p className="mm-empty-title">What are we doing today?</p>
                  <p className="mm-empty-body">
                    Cody can read coven-cave and run its tests. Pushing waits for you.
                  </p>
                  <div className="mm-starters">
                    {MINIMAL_STARTERS.map((starter) => (
                      <button
                        key={starter.text}
                        type="button"
                        className="mm-starter"
                        onClick={() => {
                          setDraft(starter.text);
                          setMode(starter.mode);
                        }}
                      >
                        {starter.text}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div ref={transcriptEnd} />
            </div>
          </div>

          <div className="mm-composer-wrap">
            <div className="mm-composer">
              <div className={`mm-composer-box is-${mode}`}>
                {/*
                 * Two legends notched into the top edge, naming what the two
                 * halves of the row below are for. Decorative labels, not
                 * controls: the buttons underneath are already named, and a
                 * screen reader reading "Tools" before a group that announces
                 * itself as "How it should respond" would only be in the way.
                 */}
                <span className="mm-notch mm-notch--start" aria-hidden="true">
                  <Icon name="sparkle" size={10} />
                  Tools
                </span>
                <span className="mm-notch mm-notch--end" aria-hidden="true">
                  <Icon name="squares-four" size={10} />
                  Task
                </span>
                <textarea
                  rows={1}
                  placeholder={
                    chat.project === null
                      ? 'Ask anything — nothing is saved…'
                      : `Message ${agent.name}…`
                  }
                  aria-label="Message"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="mm-composer-row">
                  <button
                    type="button"
                    className="mm-round-button"
                    aria-label="Add an attachment"
                    title="Attach"
                    onClick={() => flash('Attachments arrive with the real send path.')}
                  >
                    <Icon name="plus" size={15} />
                  </button>

                  {/*
                   * All three modes are visible at once, with the chosen one
                   * naming itself. Cycling through a single button hid two
                   * thirds of the choice and made "what will this do" a thing
                   * you discovered by clicking.
                   */}
                  <fieldset className="mm-modes" aria-label="How it should respond">
                    {MODE_ORDER.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className={`mm-mode ${mode === name ? 'is-active' : ''}`}
                        aria-pressed={mode === name}
                        aria-label={COMPOSER_MODE_LABELS[name]}
                        title={COMPOSER_MODE_LABELS[name]}
                        onClick={() => setMode(name)}
                      >
                        <Icon name={MODE_PRESENTATION[name].icon} size={14} />
                        {mode === name ? (
                          <span className="mm-mode-name">{MODE_PRESENTATION[name].short}</span>
                        ) : null}
                      </button>
                    ))}
                  </fieldset>

                  <span className="mm-spacer" />

                  {/* Only when there is something to stop. */}
                  {agent.status === 'working' ? (
                    <button
                      type="button"
                      className="mm-stop"
                      onClick={() => flash('Stopping arrives with the real send path.')}
                    >
                      <kbd>esc</kbd>
                      <span aria-hidden="true">·</span>
                      stop
                    </button>
                  ) : null}

                  <button
                    type="button"
                    className="mm-round-button"
                    aria-label="Rewrite this message"
                    title="Rewrite"
                    onClick={() => flash('Rewriting arrives with the real send path.')}
                  >
                    <Icon name="sparkle" size={14} />
                  </button>
                  <button
                    type="button"
                    className="mm-round-button"
                    aria-label="Dictate this message"
                    title="Dictate"
                    onClick={() => flash('Dictation arrives with the real send path.')}
                  >
                    <Icon name="microphone" size={14} />
                  </button>
                  <button
                    type="button"
                    className={`mm-send ${draft.trim() === '' ? '' : 'is-ready'}`}
                    aria-label="Send message"
                    onClick={send}
                  >
                    <Icon name="arrow-up-bold" size={14} />
                  </button>
                </div>
              </div>
              <p className="mm-composer-scope">
                {chat.project === null
                  ? 'No project context — nothing here is saved'
                  : `${agent.name} reads ${chat.project} · anything that leaves this Mac checks with you first`}
              </p>
            </div>
          </div>
        </main>

        {activityOpen ? (
          <aside className="mm-activity" aria-label="Activity">
            <div className="mm-activity-head">
              <p className="mm-activity-title">Activity</p>
              <button
                type="button"
                className="mm-icon-button mm-icon-button--small"
                aria-label="Hide activity"
                onClick={() => setActivityOpen(false)}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
            <div className="mm-activity-body">
              {MINIMAL_ACTIVITY.map((group) => (
                <div key={group.label} className="mm-activity-group">
                  <p className="mm-section-label">{group.label}</p>
                  <div className="mm-activity-rows">
                    {group.rows.map((row) => (
                      <div key={row.text} className="mm-activity-row">
                        <span className={`mm-dot mm-dot--${row.tone}`} />
                        <span className="mm-activity-text">{row.text}</span>
                        <span className="mm-activity-meta">{row.meta}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </aside>
        ) : null}

        {sheet === null ? null : (
          <div className="mm-scrim">
            {/*
             * Clicking the backdrop closes the sheet.
             *
             * A <button> so the handler sits on something that was always
             * clickable, but hidden from assistive technology and out of the
             * tab order: it is full-bleed, so as a tab stop it would be a
             * screen-sized control announcing itself between the dialog and
             * its contents. Escape is the keyboard path, and it is tested.
             */}
            <button
              type="button"
              className="mm-scrim-close"
              tabIndex={-1}
              aria-hidden="true"
              onClick={() => setSheet(null)}
            />
            <div
              className={`mm-sheet mm-sheet--${sheet}`}
              role="dialog"
              aria-modal="true"
              aria-label={sheetTitle}
            >
              {sheet === 'approval' ? (
                <div className="mm-approval">
                  <span className="mm-approval-icon" aria-hidden="true">
                    <Icon name="hand" size={18} />
                  </span>
                  <h2 className="mm-approval-title">{MINIMAL_APPROVAL.title}</h2>
                  <p className="mm-approval-body">{MINIMAL_APPROVAL.body}</p>

                  <div className="mm-facts">
                    {MINIMAL_APPROVAL.facts.map((fact) => (
                      <div key={fact.label} className="mm-fact">
                        <span className="mm-fact-label">{fact.label}</span>
                        <span className={`mm-fact-value ${fact.reassuring ? 'is-good' : ''}`}>
                          {fact.value}
                        </span>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    className="mm-link-button"
                    aria-expanded={detailsOpen}
                    onClick={() => setDetailsOpen((open) => !open)}
                  >
                    {detailsOpen ? 'Hide the changes' : 'Show the 6 changed files'}
                  </button>

                  {detailsOpen ? (
                    <div className="mm-diff">
                      {MINIMAL_APPROVAL.diff.map((entry) => (
                        <p key={entry.path} className="mm-diff-row">
                          <span className="mm-diff-path">{entry.path}</span>
                          <span className="mm-diff-add">{entry.added}</span>
                          <span className="mm-diff-del">{entry.removed}</span>
                        </p>
                      ))}
                    </div>
                  ) : null}

                  <div className="mm-approval-buttons">
                    <button
                      type="button"
                      className="mm-button mm-button--wide"
                      onClick={() => {
                        setSheet(null);
                        setApproval('denied');
                        flash('Not allowed. Cody will suggest another way.');
                      }}
                    >
                      Don't allow
                    </button>
                    <button
                      type="button"
                      className="mm-button mm-button--wide mm-button--primary"
                      onClick={() => {
                        setSheet(null);
                        setApproval('approved');
                        flash('Pushed. Draft PR #412 is open.');
                      }}
                    >
                      Allow once
                    </button>
                  </div>

                  <button
                    type="button"
                    className="mm-quiet-button"
                    onClick={() => {
                      setSheet(null);
                      setApproval('approved');
                      flash('Always allowed in coven-cave — only there.');
                    }}
                  >
                    Always allow in {MINIMAL_APPROVAL.project}
                  </button>
                </div>
              ) : null}

              {sheet === 'familiar' ? (
                <div className="mm-familiar">
                  <div className="mm-familiar-head">
                    <Mark agent={familiar} size={40} />
                    <div className="mm-familiar-who">
                      <p className="mm-familiar-name">
                        {familiar.name} <span className="mm-pronouns">{familiar.pronouns}</span>
                      </p>
                      <p className="mm-familiar-sub">
                        {familiar.kind} · {familiar.role}
                      </p>
                    </div>
                    <span className={`mm-status-pill mm-status--${familiar.status}`}>
                      {statusLabel(familiar)}
                    </span>
                  </div>

                  <p className="mm-familiar-purpose">{familiar.purpose}</p>

                  <div className="mm-familiar-block">
                    <p className="mm-section-label">What it can do here</p>
                    <div className="mm-permissions">
                      {familiar.permissions.map((permission) => (
                        <div key={permission.name} className="mm-permission">
                          <span className="mm-permission-icon">
                            <Icon name={permission.icon} size={13} />
                          </span>
                          <span className="mm-permission-name">{permission.name}</span>
                          <span
                            className={`mm-permission-state mm-permission-state--${permissionTone(permission.state)}`}
                          >
                            {permission.state}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mm-familiar-block">
                    <p className="mm-section-label">Its promises</p>
                    <div className="mm-promises">
                      {familiar.contract.map((promise) => (
                        <div key={promise.title} className="mm-promise">
                          <span
                            className={`mm-promise-icon ${promise.ok ? 'is-good' : 'is-warning'}`}
                          >
                            <Icon
                              name={promise.ok ? 'check-circle-fill' : 'warning-circle-fill'}
                              size={13}
                            />
                          </span>
                          <span className="mm-promise-text">
                            <span className="mm-promise-title">{promise.title}</span> —{' '}
                            {promise.note}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mm-familiar-foot">
                    <span className="mm-familiar-owner">
                      Belongs to you · {familiar.name.toLowerCase()}.familiar
                    </span>
                    <button type="button" className="mm-button" onClick={() => setSheet(null)}>
                      Done
                    </button>
                  </div>
                </div>
              ) : null}

              {sheet === 'settings' ? (
                <div className="mm-settings">
                  <div className="mm-settings-tabs" role="tablist" aria-label="Settings sections">
                    {SETTINGS_TABS.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={settingsTab === tab.id}
                        className={`mm-settings-tab ${settingsTab === tab.id ? 'is-active' : ''}`}
                        onClick={() => setSettingsTab(tab.id)}
                      >
                        <Icon name={tab.icon} size={15} />
                        <span>{tab.label}</span>
                      </button>
                    ))}
                    <span className="mm-spacer" />
                    <button
                      type="button"
                      className="mm-icon-button mm-icon-button--small"
                      aria-label="Close settings"
                      onClick={() => setSheet(null)}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>

                  <div className="mm-settings-body">
                    {page.groups.map((group) => (
                      <div key={group.label} className="mm-settings-group">
                        <p className="mm-section-label">{group.label}</p>
                        <div className="mm-settings-rows">
                          {group.rows.map((row) => (
                            <div key={row.label} className="mm-settings-row">
                              <div className="mm-settings-copy">
                                <p className="mm-settings-label">{row.label}</p>
                                {row.hint === null ? null : (
                                  <p className="mm-settings-hint">{row.hint}</p>
                                )}
                              </div>

                              {row.kind === 'toggle' ? (
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={row.on}
                                  aria-label={row.label}
                                  className={`mm-switch ${row.on ? 'is-on' : ''}`}
                                  onClick={row.onToggle}
                                >
                                  <span className="mm-knob" aria-hidden="true" />
                                </button>
                              ) : null}

                              {/*
                               * A real radio group rather than buttons wearing
                               * radio roles: the arrow keys, the grouping and
                               * the checked state all come free and correct,
                               * and the segmented look is only paint.
                               */}
                              {row.kind === 'segment' ? (
                                <fieldset className="mm-segment">
                                  <legend className="mm-legend">{row.label}</legend>
                                  {row.options.map((option) => (
                                    <label
                                      key={option.value}
                                      className={`mm-segment-option ${row.value === option.value ? 'is-active' : ''}`}
                                    >
                                      <input
                                        type="radio"
                                        name={`mm-segment-${row.label}`}
                                        value={option.value}
                                        checked={row.value === option.value}
                                        onChange={() => row.onPick(option.value)}
                                      />
                                      {option.label}
                                    </label>
                                  ))}
                                </fieldset>
                              ) : null}

                              {row.kind === 'value' ? (
                                <span className={`mm-settings-value ${row.mono ? 'is-mono' : ''}`}>
                                  {row.value}
                                </span>
                              ) : null}

                              {row.kind === 'menu' ? (
                                <button
                                  type="button"
                                  className="mm-menu-button"
                                  onClick={row.onAct}
                                >
                                  {row.value}
                                  <Icon name="caret-up-down" size={10} />
                                </button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    <p className="mm-settings-footnote">{page.footnote}</p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {zoom === null ? null : (
          <button
            type="button"
            className="mm-zoom"
            aria-label={`Close ${zoom.alt}`}
            onClick={() => setZoom(null)}
          >
            <span className="mm-zoom-inner">
              <GeneratedCat alt={zoom.alt} hue={zoom.hue} />
              <span className="mm-zoom-caption">{zoom.caption} · click anywhere to close</span>
            </span>
          </button>
        )}

        {toast === '' ? null : <output className="mm-toast">{toast}</output>}
      </div>
    </div>
  );
}
