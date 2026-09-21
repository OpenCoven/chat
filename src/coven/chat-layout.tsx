import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  cx,
  FamButton,
  FamIconButton,
  INSPECTOR_TABS,
  type InspectorTab,
  Segmented,
  ThinkingIndicator,
  titleCase,
} from '../design/familiars-ui';
import { Icon } from '../design/minimal-icons';
import type { ChatLifecycle, CovenProjectAccess } from '../lib/coven-runtime';
import type { ScreenRelay } from '../lib/screen-relay';
import { AttachmentChip } from '../ui/attachment-chip';
import { Composer } from '../ui/composer';
import { ATTACHMENT_ACCEPT, type ChatAttachment, formatAttachmentSize } from './attachments';
import { ChatLifecycleControls } from './chat-lifecycle';
import { ContextPicker } from './context-picker';
import { CopyButton } from './copy-button';
import type { ChatMessage } from './events';
import { FamiliarAvatar } from './familiar-avatar';
import { FormattedMessage, ToolActivity, type ToolRow } from './formatted-message';
import { useMentionCompletion } from './mention-completion';
import {
  LEFT_RAIL_HINT,
  LEFT_RAIL_SHORTCUT,
  RIGHT_RAIL_HINT,
  RIGHT_RAIL_SHORTCUT,
  SEARCH_HINT,
  SEARCH_SHORTCUT,
  useRailShortcuts,
  useSearchShortcut,
  useTypeToCompose,
} from './rail-shortcuts';
import {
  activityTime,
  formatAbsoluteTime,
  formatElapsed,
  formatRelativeTime,
  formatUpdatedCaption,
} from './relative-time';
import { type LoadRfb, ScreenViewer } from './screen-viewer';
import { useNow } from './use-now';
import { useViewportTier } from './viewport';
import '../design/familiars-shell.css';
import './chat-app.css';
import './attachments.css';

export type ChatLayoutProps = Readonly<{
  familiars: readonly {
    id: string;
    name: string;
    description?: string | undefined;
    workspace?: string | undefined;
    projectAccess?: readonly CovenProjectAccess[] | undefined;
    avatarUrl?: string | undefined;
  }[];
  sessions: readonly {
    id: string;
    title: string;
    familiarId?: string;
    updatedAt?: string;
    archived?: boolean;
    preview?: string;
    projectRoot?: string;
  }[];
  messages: readonly ChatMessage[];
  attachments?: readonly ChatAttachment[];
  attaching?: boolean;
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  familiarId: string;
  sessionId: string;
  draft: string;
  /** Unsent draft text per familiar id, so a row can remind the reader of it. */
  drafts?: Readonly<Record<string, string>>;
  status: string;
  ready: boolean;
  /** Real runtime availability. `ready` also demands a live, non-archived selection. */
  connected: boolean;
  readOnly?: boolean;
  selectedArchived?: boolean;
  archivedFilter?: boolean;
  onArchivedFilter?: (archived: boolean) => void;
  lifecycleBusy?: boolean;
  /** Runtime unavailable: archive/restore/delete must not mutate stale state. */
  lifecycleLocked?: boolean;
  onLifecycle?: (next: ChatLifecycle) => void;
  busy: boolean;
  /**
   * The familiar whose run `busy` reports. Selection can move while a run is
   * live; absent, the run is credited to the shown familiar.
   */
  runFamiliarId?: string;
  /** When the active run started (epoch ms); the status shows how long it has run. */
  runStartedAt?: number;
  /** How the shown familiar's most recent run in this window ended, and how long it took. */
  lastRun?: Readonly<{ ms: number; outcome: 'reply' | 'error' | 'stopped' }>;
  /**
   * Familiars whose run ended while another was shown, by outcome, until they
   * are opened again. Their rows say so.
   */
  finished?: Readonly<Record<string, 'reply' | 'error'>>;
  loading: boolean;
  cancelling: boolean;
  error: string;
  /** Clears the error notice; absent when the host cannot clear it. */
  onDismissError?: () => void;
  /** Sends the restored draft again; present only while a failed run's error shows. */
  onRetry?: () => void;
  /** The host-side VNC relay; absent in the browser, where the pane says so. */
  screen?: ScreenRelay | undefined;
  /** Test seam for the screen viewer's VNC client. */
  screenLoadRfb?: LoadRfb | undefined;
  onFamiliar: (id: string) => void;
  onDraft: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onRefresh: () => void;
}>;

type Rail = 'sidebar' | 'inspector';

/**
 * Closing a rail makes it inert (or unmounts the scrim that was clicked), which
 * throws keyboard focus to the body. Hand it back to whatever opened the rail,
 * or to a surviving control that opens it when the opener itself unmounted.
 */
function useFocusReturn(
  rail: Rail,
  open: boolean,
  opener: RefObject<HTMLElement | null>,
  shell: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
) {
  const wasOpen = useRef(open);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed) return;
    const active = document.activeElement;
    const lost = !active || active === document.body || Boolean(panel.current?.contains(active));
    if (!lost) return;
    const target = opener.current?.isConnected
      ? opener.current
      : shell.current?.querySelector<HTMLElement>(`[data-opens="${rail}"]`);
    target?.focus();
  }, [rail, open, opener, shell, panel]);
}

/**
 * Copy for the empty transcript. The three states are distinct: a disconnected
 * runtime, a connected runtime with no familiar chosen, and a chosen familiar
 * whose thread has no messages yet.
 *
 * `connected` must be real runtime availability, NOT the layout's `ready`.
 * `ready` is `available && familiarId && !changingLifecycle && !archived`, so
 * it is false whenever no familiar is selected -- feeding it here claimed the
 * CLI was disconnected on a perfectly healthy runtime.
 */
export function emptyThreadText(connected: boolean, familiarName?: string, anyFamiliars = true) {
  if (!connected) return 'Connect to your local Coven CLI to see real conversations here.';
  if (!familiarName)
    return anyFamiliars
      ? 'Select a familiar from the sidebar to start a conversation.'
      : 'No familiars are configured in Coven yet. Configure one, then refresh.';
  return `This is the start of your conversation with ${familiarName}. Send the first message below.`;
}

/**
 * Composer copy, decided the same way as `emptyThreadText` so the two cannot
 * disagree: a missing CLI is not fixed by choosing a familiar, and choosing one
 * is not fixed by reconnecting.
 *
 * `connected`, never `ready` -- `ready` is false for an archived chat that
 * still has a familiar to address, which would drop the name from the field.
 */
export function composerCopy(connected: boolean, familiarName?: string, anyFamiliars = true) {
  if (!connected)
    return { label: 'Message', placeholder: 'Connect to your local Coven CLI to send a message.' };
  if (!familiarName)
    return {
      label: 'Message',
      placeholder: anyFamiliars
        ? 'Select a familiar to send a message.'
        : 'Configure a familiar in Coven to send a message.',
    };
  return {
    label: `Message ${familiarName}`,
    placeholder: `Message ${familiarName} · @ familiar · # project`,
  };
}

/**
 * What the end of the transcript says while a run is active and no prose is
 * arriving. Streaming prose is its own sign of life, so this stays off then.
 */
export function liveRowText(
  familiarName: string,
  cancelling: boolean,
  runningTool: string | undefined,
  long = false,
): string {
  if (cancelling) return 'Stopping…';
  if (runningTool) return long ? `Still running ${runningTool}…` : `Running ${runningTool}…`;
  return long ? `Still waiting for ${familiarName}…` : `Waiting for ${familiarName}…`;
}

/** The host's cap on a prompt, in UTF-8 bytes (see `validate` in coven_runtime.rs). */
export const PROMPT_LIMIT_BYTES = 32 * 1024;

/** After this long without a sign of life, the live row says it is still waiting. */
export const LONG_WAIT_MS = 30_000;

/** The tool turn's header: how many calls it holds and how many failed. */
export function toolTurnSummary(rows: readonly ToolRow[]): string {
  const failed = rows.filter((row) => row.isError).length;
  const calls = `${rows.length} ${rows.length === 1 ? 'call' : 'calls'}`;
  return failed ? `${calls} · ${failed} failed` : calls;
}

/**
 * The composer's run status. A run started from another familiar's chat keeps
 * the composer locked here too (the runtime allows one run at a time), so the
 * line names that familiar and says what frees the composer.
 */
export function runStatusText(
  name: string,
  runName: string,
  runHere: boolean,
  cancelling: boolean,
  runningTool: string | undefined,
): string {
  if (!runHere) {
    return cancelling
      ? `Stopping ${runName}'s run in another chat…`
      : `${runName} is still responding in another chat. Wait for that run to finish or stop it before messaging ${name}.`;
  }
  if (cancelling) return 'Stopping; waiting for Coven…';
  if (runningTool) return `${name} is running ${runningTool}…`;
  return `${name} is responding…`;
}

/** The sidebar filter: name, identity, or purpose, case-insensitively. */
export function matchesFamiliar(
  item: Readonly<{ name: string; id: string; description?: string | undefined }>,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [item.name, item.id, item.description ?? ''].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

/** The Activity tab's account of the most recent run: how it ended, and how long it took. */
export function lastRunText(run: Readonly<{ ms: number; outcome: 'reply' | 'error' | 'stopped' }>) {
  const took = formatElapsed(run.ms);
  if (run.outcome === 'reply') return `Replied in ${took}`;
  if (run.outcome === 'error') return `Failed after ${took}`;
  return `Stopped after ${took}`;
}

/** Counts for the inspector's Activity tab, from the loaded transcript alone. */
export function activityCounts(messages: readonly ChatMessage[]) {
  let sent = 0;
  let replies = 0;
  let tools = 0;
  let failed = 0;
  const byName = new Map<string, number>();
  for (const message of messages) {
    if (message.tool) {
      tools += 1;
      if (message.tool.isError) failed += 1;
      byName.set(message.tool.name, (byName.get(message.tool.name) ?? 0) + 1);
    } else if (message.role === 'user') sent += 1;
    else if (message.role === 'assistant' && message.text) replies += 1;
  }
  // Most-used first, then by name, so the hint reads the same on every render.
  const breakdown = [...byName.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name} ${count}`)
    .join(' · ');
  return { sent, replies, tools, failed, breakdown };
}

/** The shell's keys, listed in the sidebar footer. Every entry is wired above. */
export const SHORTCUTS: readonly (readonly [keys: string, action: string])[] = [
  ['Cmd/Ctrl+\\', 'Show or hide the familiar list'],
  ['Cmd/Ctrl+Shift+\\', 'Show or hide the inspector'],
  ['Cmd/Ctrl+K', 'Search familiars'],
  ['↑ ↓ Home End', 'Move through the list; Enter opens, Escape clears the search'],
  ['Enter', 'Send the message; Shift+Enter starts a new line'],
  ['@ or #', 'Mention a familiar or project; Tab confirms, Escape dismisses'],
  ['Any letter', 'Start typing anywhere to message the familiar'],
];

function activeControl(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

export function ChatLayout(props: ChatLayoutProps) {
  const tier = useViewportTier();
  const [sidebar, setSidebar] = useState(() => tier !== 'compact');
  const [inspector, setInspector] = useState(() => tier === 'wide');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<InspectorTab>('overview');
  const [screenOpen, setScreenOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Cmd/Ctrl+K: the sidebar must be open (and no longer inert) before the
  // search box can take focus, so the request is settled after that render.
  const [searchFocus, setSearchFocus] = useState(0);
  useEffect(() => {
    if (searchFocus && sidebar) searchRef.current?.focus();
  }, [searchFocus, sidebar]);
  // Choosing a familiar hands focus to the composer once it can accept it.
  // The request is filed before the host switches, so it waits while the old
  // familiar is still shown and is dropped once a third one is.
  const [composerFocus, setComposerFocus] = useState<{
    id: string;
    from: string;
    n: number;
  } | null>(null);
  const drawers = tier === 'compact';
  const inspectorOverlay = tier !== 'wide';
  const shellRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const sidebarOpener = useRef<HTMLElement | null>(null);
  const inspectorOpener = useRef<HTMLElement | null>(null);
  useFocusReturn('sidebar', sidebar, sidebarOpener, shellRef, sidebarRef);
  useFocusReturn('inspector', inspector, inspectorOpener, shellRef, inspectorRef);
  const scrim = (drawers && (sidebar || inspector)) || (inspectorOverlay && inspector);
  // Narrowing folds rails away; widening never forces them back open.
  const previousTier = useRef(tier);
  useEffect(() => {
    if (previousTier.current === tier) return;
    previousTier.current = tier;
    if (tier !== 'wide') setInspector(false);
    if (tier === 'compact') setSidebar(false);
  }, [tier]);
  useEffect(() => {
    if (!scrim) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (drawers) setSidebar(false);
      setInspector(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scrim, drawers]);
  function openSidebar() {
    sidebarOpener.current = activeControl();
    setSidebar(true);
    if (drawers) setInspector(false);
  }
  function openInspector() {
    inspectorOpener.current = activeControl();
    setInspector(true);
    if (drawers) setSidebar(false);
  }
  function closeDrawers() {
    if (drawers) setSidebar(false);
    setInspector(false);
  }
  function showFamiliarCard() {
    setTab('overview');
    openInspector();
  }
  useRailShortcuts(
    () => (sidebar ? setSidebar(false) : openSidebar()),
    () => (inspector ? setInspector(false) : openInspector()),
  );
  useSearchShortcut(() => {
    if (!sidebar) openSidebar();
    setSearchFocus((n) => n + 1);
  });
  function chooseFamiliar(id: string) {
    props.onFamiliar(id);
    setComposerFocus((previous) => ({
      id,
      from: props.familiarId,
      n: (previous?.n ?? 0) + 1,
    }));
    if (drawers) setSidebar(false);
  }
  const familiar = props.familiars.find((item) => item.id === props.familiarId);
  const session = props.sessions.find((item) => item.id === props.sessionId);
  const name = familiar?.name ?? 'Coven';
  // A run belongs to the familiar it was sent to, not to whichever is shown.
  const runFamiliarId = props.busy ? props.runFamiliarId || props.familiarId : '';
  const runHere = props.busy && runFamiliarId === props.familiarId;
  const runName =
    props.familiars.find((item) => item.id === runFamiliarId)?.name ?? 'Another familiar';
  // Runs that ended elsewhere and have not been looked at; the collapsed
  // familiar tab counts them, since the rows that say so are out of sight.
  const pendingRuns = Object.keys(props.finished ?? {}).filter(
    (id) => id !== runFamiliarId && props.familiars.some((item) => item.id === id),
  ).length;
  const composer = composerCopy(props.connected, familiar?.name, props.familiars.length > 0);
  // The host refuses a prompt over 32 KiB; say so before the send, not after.
  const draftBytes = new TextEncoder().encode(props.draft).length;
  const oversize = draftBytes > PROMPT_LIMIT_BYTES;
  // The familiar's declared access, write grants first so they stand out.
  const projectAccess = [...(familiar?.projectAccess ?? [])].sort(
    (a, b) =>
      Number(b.access === 'write') - Number(a.access === 'write') || a.name.localeCompare(b.name),
  );
  // A run's end is announced to assistive technology, since the status line
  // that reported it simply disappears. Only the busy-to-idle edge speaks.
  // Each completion remounts the text node, so two identical results still
  // mutate the live region; a bare string would be deduplicated by React.
  const [announcement, setAnnouncement] = useState({ text: '', n: 0 });
  const previousRun = useRef({ busy: props.busy, id: runFamiliarId, name: runName });
  useEffect(() => {
    const announce = (text: string) => setAnnouncement((prev) => ({ text, n: prev.n + 1 }));
    const previous = previousRun.current;
    previousRun.current = { busy: props.busy, id: runFamiliarId, name: runName };
    if (!previous.busy || props.busy) return;
    if (previous.id === props.familiarId) {
      announce(
        props.lastRun
          ? `${previous.name}: ${lastRunText(props.lastRun)}`
          : `${previous.name}'s run ended`,
      );
      return;
    }
    const outcome = props.finished?.[previous.id];
    announce(
      outcome === 'reply'
        ? `${previous.name} replied in another chat`
        : outcome === 'error'
          ? `${previous.name}'s run failed in another chat`
          : `${previous.name}'s run ended in another chat`,
    );
  }, [props.busy, runFamiliarId, runName, props.familiarId, props.lastRun, props.finished]);
  // Captions age while the window sits open; a live run counts by the second.
  const now = useNow(props.busy ? 1000 : 60_000);
  const updated = formatUpdatedCaption(session?.updatedAt, now);
  const elapsed = props.busy && props.runStartedAt ? formatElapsed(now - props.runStartedAt) : '';
  const workspace = session?.projectRoot || familiar?.workspace;
  const workspaceLabel = session?.projectRoot ? 'Chat project' : 'Familiar workspace';
  const composerDisabled =
    !props.ready || props.loading || props.cancelling || props.attaching || props.readOnly;
  const transcriptRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Start typing anywhere in the shell and the words go to the familiar. The
  // first letter is appended here rather than left to the browser, so it is
  // neither lost to a controlled field nor delivered twice.
  useTypeToCompose((key) => {
    const field = composerRef.current;
    if (composerDisabled || !field) return false;
    props.onDraft(props.draft + key);
    field.focus();
    const end = props.draft.length + key.length;
    field.setSelectionRange(end, end);
    return true;
  });
  useEffect(() => {
    if (!composerFocus) return;
    if (composerFocus.id !== props.familiarId) {
      if (composerFocus.from !== props.familiarId) setComposerFocus(null);
      return;
    }
    if (composerDisabled) return;
    composerRef.current?.focus();
    setComposerFocus(null);
  }, [composerFocus, props.familiarId, composerDisabled]);
  const mentionCompletion = useMentionCompletion({
    familiars: props.familiars,
    familiarId: props.familiarId,
    value: props.draft,
    onValueChange: props.onDraft,
    textareaRef: composerRef,
    disabled: Boolean(composerDisabled || props.busy),
  });
  const nearBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  // How many messages the reader had when they last sat at the bottom, so the
  // jump control can say how many arrived while they were reading back.
  const seenCount = useRef(props.messages.length);
  const previousSession = useRef(props.sessionId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new messages and the live row change the transcript's scroll height.
  useEffect(() => {
    if (previousSession.current !== props.sessionId) {
      nearBottom.current = true;
      setShowLatest(false);
      previousSession.current = props.sessionId;
    }
    if (nearBottom.current) seenCount.current = props.messages.length;
    const transcript = transcriptRef.current;
    if (transcript && nearBottom.current) transcript.scrollTop = transcript.scrollHeight;
  }, [props.messages, props.sessionId, props.busy]);
  const unseen = showLatest ? Math.max(0, props.messages.length - seenCount.current) : 0;
  // Consecutive tool rows render as one activity list; the transcript is
  // otherwise one element per message.
  const blocks: (
    | Readonly<{ kind: 'message'; message: ChatMessage }>
    | Readonly<{ kind: 'tools'; id: string; rows: ToolRow[] }>
  )[] = [];
  for (const message of props.messages) {
    const last = blocks[blocks.length - 1];
    if (message.tool) {
      const row: ToolRow = {
        name: message.tool.name,
        args: message.tool.args,
        raw: message.tool.raw,
        result: message.tool.result,
        isError: message.tool.isError,
      };
      if (last?.kind === 'tools') last.rows.push(row);
      else blocks.push({ kind: 'tools', id: message.id, rows: [row] });
    } else {
      blocks.push({ kind: 'message', message });
    }
  }
  const lastMessage = props.messages[props.messages.length - 1];
  const counts = activityCounts(props.messages);
  // A run whose newest event is an unfinished tool call is running that tool,
  // and the status says so instead of "responding".
  const runningTool =
    runHere && lastMessage?.tool && lastMessage.tool.result === undefined
      ? lastMessage.tool.name
      : undefined;
  const tail = blocks[blocks.length - 1];
  if (runningTool && tail?.kind === 'tools') {
    const row = tail.rows[tail.rows.length - 1];
    if (row) tail.rows[tail.rows.length - 1] = { ...row, running: true };
  }
  // Streaming prose is its own sign of life; the live row covers every other
  // moment of a run, from the send until the first token or tool.
  const liveRow =
    runHere && !(lastMessage?.role === 'assistant' && lastMessage.text)
      ? liveRowText(
          name,
          props.cancelling,
          runningTool,
          Boolean(props.runStartedAt) && now - (props.runStartedAt ?? 0) >= LONG_WAIT_MS,
        )
      : '';
  const headOf = (familiarId: string) =>
    props.sessions.find((session) => session.familiarId === familiarId);
  // Most recent activity first; familiars without a dated thread keep the
  // CLI's own order after them.
  const agents = props.familiars
    .filter(
      (item) =>
        matchesFamiliar(item, query) &&
        Boolean(headOf(item.id)?.archived) === Boolean(props.archivedFilter),
    )
    .sort((a, b) => activityTime(headOf(b.id)?.updatedAt) - activityTime(headOf(a.id)?.updatedAt));
  const listRef = useRef<HTMLDivElement>(null);
  function rowButtons() {
    return Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('button.coven-agent-row') ?? [],
    );
  }
  function moveRowFocus(event: ReactKeyboardEvent, from: number) {
    const rows = rowButtons();
    if (!rows.length) return;
    let next: number;
    if (event.key === 'ArrowDown') next = Math.min(from + 1, rows.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(from - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else return;
    event.preventDefault();
    rows[next]?.focus();
  }
  return (
    <div
      ref={shellRef}
      className="fr-shell coven-chat"
      data-tier={tier}
      data-sidebar={sidebar ? 'open' : 'closed'}
      data-inspector={inspector ? 'open' : 'closed'}
      style={
        {
          '--coven-sidebar-w': sidebar && !drawers ? '300px' : 'var(--coven-rail-tab-w)',
          '--coven-inspector-w':
            inspector && !inspectorOverlay ? '360px' : 'var(--coven-rail-tab-w)',
        } as CSSProperties
      }
    >
      <div className="fr-grain" aria-hidden="true" />
      {scrim ? (
        <button
          type="button"
          className="coven-scrim"
          aria-label="Close panels"
          onClick={closeDrawers}
        />
      ) : null}
      <button
        type="button"
        className="coven-rail-tab coven-rail-tab--left"
        // While the scrim is up it owns the surface; a reserved tab sitting
        // over it would swallow the dismiss click.
        hidden={sidebar || scrim}
        aria-label={
          pendingRuns
            ? `Show familiars (${pendingRuns} finished ${pendingRuns === 1 ? 'run' : 'runs'})`
            : 'Show familiars'
        }
        aria-controls="coven-familiars-sidebar"
        aria-expanded={false}
        aria-keyshortcuts={LEFT_RAIL_SHORTCUT}
        title={LEFT_RAIL_HINT}
        data-opens="sidebar"
        onClick={openSidebar}
      >
        {pendingRuns ? (
          <span className="coven-rail-tab-badge" aria-hidden="true">
            {pendingRuns}
          </span>
        ) : null}
        <span className="coven-rail-tab-label">Familiars</span>
        <span className="coven-rail-tab-cue" aria-hidden="true">
          ›
        </span>
      </button>
      <button
        type="button"
        className="coven-rail-tab coven-rail-tab--right"
        hidden={inspector || scrim}
        aria-label="Show inspector"
        aria-controls="coven-familiar-inspector"
        aria-expanded={false}
        aria-keyshortcuts={RIGHT_RAIL_SHORTCUT}
        title={RIGHT_RAIL_HINT}
        data-opens="inspector"
        onClick={openInspector}
      >
        <span className="coven-rail-tab-label">{familiar?.name || 'Details'}</span>
        <span className="coven-rail-tab-cue" aria-hidden="true">
          ‹
        </span>
      </button>
      <aside
        ref={sidebarRef}
        id="coven-familiars-sidebar"
        className="fr-sidebar"
        aria-label="Familiars sidebar"
        aria-hidden={!sidebar || undefined}
        inert={!sidebar}
      >
        <div className="fr-sidebar-inner">
          <button
            type="button"
            className="fr-rail-toggle"
            aria-label="Hide familiars"
            aria-keyshortcuts={LEFT_RAIL_SHORTCUT}
            title={LEFT_RAIL_HINT}
            onClick={() => setSidebar(false)}
          >
            <span className="fr-rail-toggle-label">Familiars</span>
            <Icon name="sidebar-simple" size={15} />
          </button>
          <label className="coven-agent-search">
            <Icon name="magnifying-glass" size={14} />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search familiars"
              aria-keyshortcuts={SEARCH_SHORTCUT}
              title={SEARCH_HINT}
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  rowButtons()[0]?.focus();
                } else if (event.key === 'Enter') {
                  const first = agents[0];
                  if (!first || props.lifecycleBusy) return;
                  event.preventDefault();
                  chooseFamiliar(first.id);
                } else if (event.key === 'Escape' && query) {
                  event.preventDefault();
                  setQuery('');
                }
              }}
            />
          </label>
          <div className="fr-conv-scroll">
            <div className="fr-conv-list" ref={listRef}>
              {agents.map((item, index) => {
                const thread = headOf(item.id);
                const when = formatRelativeTime(thread?.updatedAt, now);
                const live = props.busy && item.id === runFamiliarId;
                const draft = props.drafts?.[item.id]?.trim() ?? '';
                const done = live ? undefined : props.finished?.[item.id];
                const doneLabel = done === 'error' ? 'Run failed' : 'New reply';
                return (
                  <button
                    type="button"
                    key={item.id}
                    className="fr-conv coven-agent-row"
                    aria-label={done ? `${item.name} (${doneLabel.toLowerCase()})` : item.name}
                    title={item.description}
                    aria-current={item.id === props.familiarId || undefined}
                    disabled={props.lifecycleBusy}
                    onKeyDown={(event) => moveRowFocus(event, index)}
                    onClick={() => chooseFamiliar(item.id)}
                  >
                    <FamiliarAvatar name={item.name} avatarUrl={item.avatarUrl} size={36} />
                    <span className="coven-agent-copy">
                      <span className="fr-conv-top">
                        <span className="fr-conv-title">{item.name}</span>
                        {live ? (
                          <span className="fr-conv-time coven-agent-live">
                            {props.cancelling ? 'Stopping…' : 'Responding…'}
                          </span>
                        ) : done ? (
                          <span
                            className={`fr-conv-time coven-agent-done${done === 'error' ? ' coven-agent-done--error' : ''}`}
                          >
                            {doneLabel}
                          </span>
                        ) : when ? (
                          <time
                            className="fr-conv-time"
                            dateTime={thread?.updatedAt}
                            title={formatAbsoluteTime(thread?.updatedAt)}
                          >
                            {when}
                          </time>
                        ) : null}
                      </span>
                      <span className="fr-conv-preview">
                        {draft ? (
                          <>
                            <span className="coven-agent-draft">Draft:</span>
                            <span className="fr-conv-preview-text">{draft}</span>
                          </>
                        ) : (
                          thread?.preview ||
                          (thread ? 'Continue your conversation' : 'Start a conversation')
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {!agents.length ? (
              <div className="fr-sidebar-empty">
                <span className="fr-empty-glyph">
                  <Icon name="chats-circle" size={16} />
                </span>
                <span className="fr-empty-text">
                  {!props.connected
                    ? 'Connect to your local Coven CLI to see your familiars.'
                    : query
                      ? 'No matching familiars.'
                      : props.archivedFilter
                        ? 'No archived familiars.'
                        : 'No active familiars available. Configure a familiar in Coven, then refresh.'}
                </span>
                {query ? (
                  <FamButton size="sm" onClick={() => setQuery('')}>
                    Clear search
                  </FamButton>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="fr-sidebar-foot coven-user-settings">
            {props.onArchivedFilter ? (
              <details>
                <summary>User settings</summary>
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(props.archivedFilter)}
                    disabled={props.lifecycleBusy}
                    onChange={(event) => props.onArchivedFilter?.(event.target.checked)}
                  />
                  Show archived chats
                </label>
              </details>
            ) : null}
            <details className="coven-shortcuts">
              <summary>Keyboard shortcuts</summary>
              <dl>
                {SHORTCUTS.map(([keys, action]) => (
                  <div key={keys}>
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{action}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </div>
        </div>
      </aside>
      <main className="fr-thread">
        <output className="coven-sr-only" aria-live="polite" aria-label="Run announcements">
          {announcement.n ? <span key={announcement.n}>{announcement.text}</span> : null}
        </output>
        <header className="fr-thread-header">
          <div className="fr-thread-header-lead">
            {familiar ? (
              <FamiliarAvatar name={name} avatarUrl={familiar.avatarUrl} size={24} />
            ) : null}
            <button
              type="button"
              className="fr-thread-title coven-familiar-card-trigger"
              disabled={!familiar}
              onClick={showFamiliarCard}
              aria-label={familiar ? `Open ${name}'s familiar card` : 'No familiar selected'}
            >
              {familiar ? name : 'No familiar selected'}
            </button>
            {familiar && updated ? (
              <time
                className="fr-thread-familiar coven-thread-updated"
                dateTime={session?.updatedAt}
                title={formatAbsoluteTime(session?.updatedAt)}
              >
                {updated}
              </time>
            ) : null}
          </div>
          {session && props.onLifecycle && (
            <ChatLifecycleControls
              key={session.id}
              id={session.id}
              title={session.title}
              archived={Boolean(props.selectedArchived)}
              disabled={
                props.busy ||
                props.loading ||
                Boolean(props.attaching) ||
                Boolean(props.lifecycleBusy) ||
                Boolean(props.lifecycleLocked)
              }
              pending={Boolean(props.lifecycleBusy)}
              error={props.error}
              onChange={props.onLifecycle}
            />
          )}
          <div className="fr-thread-header-actions">
            <FamIconButton
              icon="squares-four"
              label={screenOpen ? 'Hide screen' : 'Show screen'}
              title={screenOpen ? 'Hide the remote screen' : 'View a remote screen over VNC'}
              aria-pressed={screenOpen}
              aria-controls="coven-screen-viewer"
              onClick={() => setScreenOpen((open) => !open)}
            />
            <FamIconButton
              icon="arrow-clockwise"
              label="Refresh Coven"
              className={props.loading ? 'coven-refreshing' : undefined}
              disabled={props.busy || props.loading || props.lifecycleBusy}
              onClick={props.onRefresh}
            />
          </div>
        </header>
        {screenOpen ? (
          <div id="coven-screen-viewer">
            {/* Keyed by familiar: switching threads unmounts the pane, and its
                teardown closes the host connection and forgets the address. */}
            <ScreenViewer
              key={props.familiarId}
              relay={props.screen}
              familiarName={familiar?.name}
              onClose={() => setScreenOpen(false)}
              {...(props.screenLoadRfb ? { loadRfb: props.screenLoadRfb } : {})}
            />
          </div>
        ) : null}
        <div
          className="fr-transcript"
          ref={transcriptRef}
          role="log"
          aria-label="Messages"
          aria-busy={props.loading}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The transcript scrolls; the keyboard needs a way in.
          tabIndex={0}
          onScroll={(event) => {
            const transcript = event.currentTarget;
            nearBottom.current =
              transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 80;
            setShowLatest(!nearBottom.current);
          }}
        >
          <div className="fr-column">
            {props.status ? (
              <details className="coven-connection" open={!props.ready}>
                <summary>{props.ready ? 'Connection details' : 'Coven setup required'}</summary>
                <output className="coven-status">{props.status}</output>
              </details>
            ) : null}
            {props.error ? (
              <div className="coven-error" role="alert">
                <span className="coven-error-text">{props.error}</span>
                <CopyButton className="coven-error-copy" text={props.error} label="Copy error" />
                {props.onRetry &&
                !composerDisabled &&
                (props.draft.trim() || props.attachments?.length) ? (
                  <FamButton size="sm" className="coven-error-retry" onClick={props.onRetry}>
                    Try again
                  </FamButton>
                ) : null}
                {props.onDismissError ? (
                  <button
                    type="button"
                    className="coven-error-dismiss"
                    aria-label="Dismiss error"
                    title="Dismiss"
                    onClick={props.onDismissError}
                  >
                    <Icon name="x" size={12} />
                  </button>
                ) : null}
              </div>
            ) : null}
            {props.loading ? <ThinkingIndicator label="Loading conversation" /> : null}
            {blocks.map((block) =>
              block.kind === 'tools' ? (
                <div className="fr-familiar fr-msg coven-tool-turn" key={block.id}>
                  <FamiliarAvatar name={name} avatarUrl={familiar?.avatarUrl} size={22} />
                  <div className="fr-familiar-body">
                    <span className="fr-familiar-meta">
                      <span className="fr-familiar-name">Tool activity</span>
                      <span className="coven-tool-turn-count">{toolTurnSummary(block.rows)}</span>
                    </span>
                    <div className="coven-formatted">
                      <ToolActivity rows={block.rows} />
                    </div>
                  </div>
                </div>
              ) : block.message.role === 'output' ? (
                // Raw engine output: text the runtime printed outside the
                // protocol. Shown as it came, attributed to no one.
                <section className="coven-output" key={block.message.id} aria-label="Engine output">
                  <pre>{block.message.text}</pre>
                </section>
              ) : block.message.role === 'notice' ? (
                // Chat's own disclosure (a replayed-history notice): a quiet
                // line between messages, not a reply from anyone.
                <p className="coven-notice" key={block.message.id} role="note">
                  {block.message.text}
                </p>
              ) : block.message.role === 'user' ? (
                <div className="fr-user fr-msg" key={block.message.id}>
                  <div className="fr-user-body">
                    <div className="fr-bubble fr-bubble--user coven-message">
                      {block.message.text}
                    </div>
                    {block.message.text ? (
                      <CopyButton
                        className="coven-message-copy coven-message-copy--user"
                        text={block.message.text}
                        label="Copy message"
                      />
                    ) : null}
                    {block.message.attachments?.length ? (
                      <ul className="coven-history-attachments" aria-label="Message attachments">
                        {block.message.attachments.map((file, index) => (
                          <li key={`${index}-${file.name}`}>
                            <AttachmentChip
                              name={file.name}
                              meta={formatAttachmentSize(file.size)}
                            />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="fr-familiar fr-msg" key={block.message.id}>
                  {block.message.role === 'assistant' && familiar ? (
                    <button
                      type="button"
                      className="coven-familiar-card-trigger"
                      aria-label={`Show ${name}'s familiar card`}
                      aria-controls="coven-familiar-inspector"
                      aria-expanded={inspector && tab === 'overview'}
                      onClick={showFamiliarCard}
                    >
                      <FamiliarAvatar name={name} avatarUrl={familiar.avatarUrl} size={22} />
                    </button>
                  ) : (
                    <FamiliarAvatar name={name} avatarUrl={familiar?.avatarUrl} size={22} />
                  )}
                  <div className="fr-familiar-body">
                    <span className="fr-familiar-meta">
                      {block.message.role === 'assistant' && familiar ? (
                        <button
                          type="button"
                          className="fr-familiar-name coven-familiar-card-trigger"
                          aria-label={`Show ${name}'s familiar card`}
                          aria-controls="coven-familiar-inspector"
                          aria-expanded={inspector && tab === 'overview'}
                          onClick={showFamiliarCard}
                        >
                          {name}
                        </button>
                      ) : (
                        <span className="fr-familiar-name">
                          {block.message.role === 'assistant'
                            ? name
                            : titleCase(block.message.role)}
                        </span>
                      )}
                      {block.message.role === 'assistant' && block.message.text ? (
                        <CopyButton
                          className="coven-message-copy"
                          text={block.message.text}
                          label="Copy reply"
                        />
                      ) : null}
                    </span>
                    <div className="fr-bubble fr-bubble--familiar coven-message">
                      {block.message.role === 'assistant' ? (
                        <FormattedMessage text={block.message.text} />
                      ) : (
                        block.message.text
                      )}
                    </div>
                  </div>
                </div>
              ),
            )}
            {liveRow ? (
              <div className="fr-thinking-row coven-live-row">
                <FamiliarAvatar name={name} avatarUrl={familiar?.avatarUrl} size={22} />
                <ThinkingIndicator label={liveRow} />
              </div>
            ) : null}
            {!props.messages.length && !props.loading && !runHere ? (
              <div className="fr-thread-empty">
                {familiar ? (
                  <FamiliarAvatar name={name} avatarUrl={familiar.avatarUrl} size={36} ring />
                ) : null}
                <span className="fr-thread-empty-title">
                  {familiar ? `Chat with ${name}` : 'No familiar selected'}
                </span>
                {familiar?.description ? (
                  <span className="coven-thread-empty-purpose">{familiar.description}</span>
                ) : null}
                <span className="fr-empty-text">
                  {emptyThreadText(props.connected, familiar?.name, props.familiars.length > 0)}
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="fr-composer-wrap">
          <div className="fr-composer-inner">
            {showLatest && (
              <button
                type="button"
                className="coven-jump-latest"
                onClick={() => {
                  const transcript = transcriptRef.current;
                  if (transcript) transcript.scrollTop = transcript.scrollHeight;
                  nearBottom.current = true;
                  setShowLatest(false);
                }}
              >
                Jump to latest
                {unseen ? (
                  <span className="coven-jump-count">
                    {unseen} new {unseen === 1 ? 'message' : 'messages'}
                  </span>
                ) : null}
              </button>
            )}
            <div className="coven-composer-context" title={workspace}>
              {workspace ? `${workspaceLabel}: ${workspace}` : 'No workspace reported'}
            </div>
            {props.busy && (
              <output className="coven-run-status">
                {runStatusText(name, runName, runHere, props.cancelling, runningTool)}
                {elapsed ? <span className="coven-run-elapsed"> · {elapsed}</span> : null}
              </output>
            )}
            {props.readOnly && (
              <p className="coven-composer-note">
                This familiar chat is archived. Restore it to continue the conversation.
              </p>
            )}
            {props.busy && composerDisabled && (
              <div className="coven-run-actions">
                <FamButton size="sm" onClick={props.onCancel} disabled={props.cancelling}>
                  Stop run
                </FamButton>
              </div>
            )}
            <fieldset className="coven-composer-fieldset" disabled={composerDisabled}>
              <Composer
                textareaRef={composerRef}
                textareaProps={mentionCompletion.textareaProps}
                onKeyDown={mentionCompletion.onKeyDown}
                className="coven-compact-composer"
                minRows={1}
                attachmentIcon="plus"
                value={props.draft}
                onValueChange={props.onDraft}
                label={composer.label}
                placeholder={composer.placeholder}
                onSend={props.onSend}
                {...(oversize
                  ? {
                      warning: {
                        label: `Message is ${formatAttachmentSize(draftBytes)}; Coven accepts up to 32 KiB. Shorten it or attach a file.`,
                      },
                    }
                  : {})}
                running={props.busy && !composerDisabled}
                onStop={props.onCancel}
                allowAttachmentOnly
                attachments={(props.attachments ?? []).map((file) => ({
                  id: file.id,
                  name: file.name,
                  meta: formatAttachmentSize(file.bytes.length),
                }))}
                {...(props.onAttach && !props.busy && !props.attaching
                  ? { onAttach: () => fileInput.current?.click() }
                  : {})}
                {...(!props.busy && props.onRemoveAttachment
                  ? { onRemoveAttachment: props.onRemoveAttachment }
                  : {})}
              >
                {mentionCompletion.suggestions}
                <ContextPicker
                  key={`${props.familiarId}:${props.sessionId}`}
                  familiars={props.familiars}
                  familiarId={props.familiarId}
                  value={props.draft}
                  onValueChange={props.onDraft}
                  textareaRef={composerRef}
                  disabled={composerDisabled || props.busy}
                />
              </Composer>
              {props.onAttach ? (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    aria-label="Select text attachments"
                    accept={ATTACHMENT_ACCEPT}
                    disabled={props.busy || props.attaching}
                    onChange={(event) => {
                      props.onAttach?.(Array.from(event.target.files ?? []));
                      event.target.value = '';
                    }}
                  />
                  {/* The limits matter once a file is in play; until then the
                      line was permanent noise under the composer. */}
                  {props.attaching ? (
                    <p className="coven-attachment-note">Reading files…</p>
                  ) : props.attachments?.length ? (
                    <p className="coven-attachment-note">Text/code · 4 files max · 64 KiB each</p>
                  ) : null}
                </>
              ) : null}
            </fieldset>
          </div>
        </div>
      </main>
      <aside
        ref={inspectorRef}
        id="coven-familiar-inspector"
        className="fr-inspector"
        aria-label="Familiar inspector"
        aria-hidden={!inspector || undefined}
        inert={!inspector}
      >
        <div className="fr-inspector-inner">
          <button
            type="button"
            className="fr-inspector-head"
            onClick={() => setInspector(false)}
            aria-label="Close inspector"
            aria-keyshortcuts={RIGHT_RAIL_SHORTCUT}
            title={RIGHT_RAIL_HINT}
          >
            {familiar ? (
              <FamiliarAvatar name={name} avatarUrl={familiar.avatarUrl} size={22} ring />
            ) : (
              // .fr-inspector-head is a 3-column grid whose first column is a
              // fixed 22px avatar slot; leaving it empty shifts the name into
              // 22px and wraps it over the close icon.
              <span className="fr-inspector-mark" aria-hidden="true" />
            )}
            <span className="fr-inspector-who">
              <span className="fr-inspector-name">{familiar ? name : 'Coven CLI'}</span>
              <span className="fr-inspector-kind">
                {familiar ? 'Coven familiar' : 'No familiar selected'}
              </span>
            </span>
            <Icon name="sidebar-simple" size={15} />
          </button>
          <div className="fr-tabs">
            <Segmented
              options={INSPECTOR_TABS}
              value={tab}
              onChange={setTab}
              getLabel={titleCase}
              label="Familiar details"
            />
          </div>
          <section className="fr-inspector-panel" aria-label={titleCase(tab)}>
            {tab === 'overview' ? (
              <div className="fr-stack">
                <div className="fr-card fr-card--lift fr-overview-purpose">
                  <span className="fr-eyebrow">{familiar ? 'Purpose' : 'Overview'}</span>
                  <span className="fr-purpose">
                    {familiar?.description ||
                      (familiar
                        ? 'No description provided by Coven.'
                        : 'Select a familiar to chat with your local Coven CLI. Every message is sent on its behalf.')}
                  </span>
                </div>
                {familiar ? (
                  <div className="fr-card fr-card--lift fr-rows">
                    <div className="fr-row">
                      <span className="fr-row-label">Identity</span>
                      <span className="coven-row-path">
                        <code className="fr-row-value coven-row-value--path" title={familiar.id}>
                          {familiar.id}
                        </code>
                        <CopyButton
                          className="coven-row-copy"
                          text={familiar.id}
                          label="Copy identity"
                        />
                      </span>
                    </div>
                    <div className="fr-row">
                      <span className="fr-row-label">Workspace</span>
                      {familiar.workspace ? (
                        <span className="coven-row-path">
                          <span
                            className="fr-row-value coven-row-value--path"
                            title={familiar.workspace}
                          >
                            {familiar.workspace}
                          </span>
                          <CopyButton
                            className="coven-row-copy"
                            text={familiar.workspace}
                            label="Copy workspace path"
                          />
                        </span>
                      ) : (
                        <span className="fr-row-value">Not reported</span>
                      )}
                    </div>
                    <div className="fr-row">
                      <span className="fr-row-label">Chat</span>
                      <span className="fr-row-value">
                        {session ? (session.archived ? 'Archived' : 'Active') : 'Not started'}
                      </span>
                    </div>
                    <div className="fr-row">
                      <span className="fr-row-label">Last activity</span>
                      {formatAbsoluteTime(session?.updatedAt) ? (
                        <time
                          className="fr-row-value"
                          dateTime={session?.updatedAt}
                          title={formatAbsoluteTime(session?.updatedAt)}
                        >
                          {formatAbsoluteTime(session?.updatedAt)}
                        </time>
                      ) : (
                        <span className="fr-row-value">Not reported</span>
                      )}
                    </div>
                  </div>
                ) : null}
                <FamButton
                  size="sm"
                  onClick={props.onRefresh}
                  disabled={props.busy || props.loading}
                >
                  Refresh local data
                </FamButton>
              </div>
            ) : null}
            {tab === 'access' ? (
              <div className="fr-stack">
                {familiar ? (
                  <div className="fr-card fr-card--lift coven-access">
                    <span className="fr-eyebrow">Declared project access</span>
                    {projectAccess.length ? (
                      <div className="fr-rows coven-access-rows">
                        {projectAccess.map((project) => (
                          <div className="fr-row" key={`${project.path}:${project.access}`}>
                            <span className="fr-row-copy">
                              <span className="fr-row-label">{project.name}</span>
                              <span className="fr-row-hint" title={project.path}>
                                {project.path}
                              </span>
                            </span>
                            <span
                              className={cx(
                                'fr-row-value',
                                project.access === 'write' && 'fr-row-value--warn',
                              )}
                            >
                              {project.access === 'write' ? 'Read and write' : 'Read only'}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="fr-purpose">
                        {/* The host hands back an empty list both when nothing is
                            declared and when the registry could not be read, so
                            this must not assert absence. */}
                        No declared project access was found for {name}. Coven's local registry and
                        grants may list none, or Chat could not read them.
                      </span>
                    )}
                  </div>
                ) : null}
                <div className="coven-details fr-card fr-card--lift">
                  <h2>Access</h2>
                  <p>
                    Declared access comes from Coven's local project registry and grants; Chat shows
                    it as declared and neither enforces nor extends it. Access rules and approvals
                    are not exposed by this CLI integration.
                  </p>
                  <p>
                    Configure your familiar in Coven. This app does not define or enforce an
                    additional permission boundary.
                  </p>
                  <p>
                    Text and code attachments are sent with your message. Show screen in the thread
                    header opens a remote desktop over VNC; it starts view only. Tool approval
                    controls are unavailable here.
                  </p>
                </div>
              </div>
            ) : null}
            {tab === 'activity' ? (
              <div className="fr-stack">
                <div className="fr-card fr-card--lift fr-rows">
                  <div className="fr-row">
                    <span className="fr-row-label">Run</span>
                    <span className="fr-row-value">
                      {!props.busy
                        ? 'Idle'
                        : !runHere
                          ? `${runName} is responding in another chat`
                          : props.cancelling
                            ? 'Stopping'
                            : runningTool
                              ? `Running ${runningTool}`
                              : `${name} is responding`}
                    </span>
                  </div>
                  {props.lastRun ? (
                    <div className="fr-row">
                      <span className="fr-row-label">Last run</span>
                      <span className="fr-row-value">{lastRunText(props.lastRun)}</span>
                    </div>
                  ) : null}
                  <div className="fr-row">
                    <span className="fr-row-label">Your messages</span>
                    <span className="fr-row-value">{counts.sent}</span>
                  </div>
                  <div className="fr-row">
                    <span className="fr-row-label">Replies</span>
                    <span className="fr-row-value">{counts.replies}</span>
                  </div>
                  <div className="fr-row">
                    <span className="fr-row-copy">
                      <span className="fr-row-label">Tool calls</span>
                      {counts.breakdown ? (
                        <span className="fr-row-hint" title={counts.breakdown}>
                          {counts.breakdown}
                        </span>
                      ) : null}
                    </span>
                    <span className="fr-row-value">
                      {counts.failed ? `${counts.tools} · ${counts.failed} failed` : counts.tools}
                    </span>
                  </div>
                </div>
                <div className="coven-details fr-card fr-card--lift">
                  <p>
                    Counts cover the loaded transcript. Tool activity appears in the conversation;
                    tokens, cost and timing are not reported by this CLI integration.
                  </p>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </aside>
    </div>
  );
}
