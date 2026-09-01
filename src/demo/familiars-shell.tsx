import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { type CompletionCommand, Composer, type ComposerAttachment } from '../ui';
import './familiars-shell.css';
import {
  clockLabel,
  FAM_COMMANDS,
  FAM_CONVERSATIONS,
  FAM_DOCS,
  FAM_MESSAGES,
  type FamConversation,
  type FamMessage,
  type HoldState,
  holdMessage,
  matchTrigger,
  mentionedFamiliars,
  mentionQuery,
  pendingHolds,
  randomName,
  summonFamiliar,
  TEMPLATE_NAMES,
  TEMPLATE_WARDS,
} from './familiars-data';
import { type DocRequest, FamiliarInspector } from './familiars-inspector';
import { EvidenceMap, MessageRow, ThinkingRow } from './familiars-messages';
import {
  type AccessGroupKey,
  type ActivityKey,
  Avatar,
  cx,
  type DemoEmpty,
  FamButton,
  FamIconButton,
  type InspectorTab,
} from './familiars-ui';
import { Icon } from './minimal-icons';
import { FAMILIAR_TEMPLATES, MOCK_FAMILIARS, type MockFamiliar } from './mock-familiars';

/**
 * The Familiars Redesign v2 surface.
 *
 * Conversations on the left, the thread in the middle, the familiar's ward
 * on the right. What the design adds over the other demos is the boundary
 * made visible: held actions in the thread, a "Needs you" section above the
 * conversations, and a composer that warns before a draft crosses into the
 * must-ask tier.
 *
 * Mock throughout. Replies, decisions, and memory updates are timers.
 */

export type FamiliarsShellProps = Readonly<{
  initialConversation?: string;
  initialTab?: InspectorTab;
  /** Render one of the design board's empty states. */
  demoEmpty?: DemoEmpty;
  /** Force the active conversation's hold into a decided state. */
  holdOverride?: HoldState;
  inspectorWidth?: 'narrow' | 'compact' | 'comfortable';
  /** Open every access group, contract included. */
  accessGroups?: 'default' | 'all';
  sidebarOpen?: boolean;
  inspectorOpen?: boolean;
}>;

const INSPECTOR_WIDTHS = { narrow: 320, compact: 360, comfortable: 400 } as const;
const SIDEBAR_WIDTH = 300;
const REPLY_DELAY = 1200;
const DECISION_DELAY = 1400;
const GUEST_DELAY = 900;
const UPLOAD_STEP = 240;

/** What the paperclip attaches, in order; the third fails so the chip's failed state has a home. */
const MOCK_FILES: readonly Readonly<{ name: string; meta: string; fails?: true }>[] = [
  { name: 'vendor-a.md', meta: '12 KB' },
  { name: 'evidence-map.png', meta: '418 KB' },
  { name: 'q3-deck.key', meta: '212 MB', fails: true },
  { name: 'ledger.md', meta: '9 KB' },
];

type FamCard = Readonly<{ x: number; y: number; familiarId: string }>;

/** `suggested` marks a name the dialog chose, which a template change may replace. */
type SummonDraft = Readonly<{ templateId: string; name: string; suggested: boolean }>;

type ShellState = Readonly<{
  conversationId: string;
  tab: InspectorTab;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  switcherOpen: boolean;
  slashOpen: boolean;
  searchOpen: boolean;
  searchQuery: string;
  draft: string;
  holds: Readonly<Record<string, HoldState | undefined>>;
  decidedAt: string;
  extra: Readonly<Record<string, readonly FamMessage[] | undefined>>;
  thinking: boolean;
  activityOpen: ActivityKey | null;
  groups: Readonly<Partial<Record<AccessGroupKey, boolean>>>;
  lightbox: number | null;
  famCard: FamCard | null;
  doc: DocRequest | null;
  headerHidden: boolean;
  recentAll: boolean;
  /** Everything summoned this session sits alongside the shipped familiars. */
  familiars: readonly MockFamiliar[];
  conversations: readonly FamConversation[];
  summon: SummonDraft | null;
  /** The familiar's screen: the panel, and the full watch view over it. */
  screenOpen: boolean;
  watching: boolean;
  /** Files attached to the current draft, with their (mock) upload state. */
  attachments: readonly ComposerAttachment[];
}>;

type ShellAction =
  | { type: 'patch'; patch: Partial<ShellState> }
  | { type: 'select-conversation'; id: string }
  | { type: 'decide'; conversationId: string; state: HoldState; at: string }
  | { type: 'send'; conversationId: string; message: FamMessage }
  | { type: 'reply'; conversationId: string; message: FamMessage }
  | { type: 'toggle-activity'; key: ActivityKey }
  | { type: 'attachment'; attachment: ComposerAttachment }
  | { type: 'remove-attachment'; id: string }
  | { type: 'summon'; familiar: MockFamiliar; conversation: FamConversation }
  | { type: 'escape' };

function append(
  extra: ShellState['extra'],
  conversationId: string,
  message: FamMessage,
): ShellState['extra'] {
  return { ...extra, [conversationId]: [...(extra[conversationId] ?? []), message] };
}

function reduce(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.patch };
    case 'select-conversation':
      return {
        ...state,
        conversationId: action.id,
        switcherOpen: false,
        slashOpen: false,
        searchOpen: false,
        famCard: null,
        thinking: false,
        attachments: [],
      };
    case 'decide':
      return {
        ...state,
        holds: { ...state.holds, [action.conversationId]: action.state },
        decidedAt: action.at,
        thinking: true,
      };
    case 'send':
      return {
        ...state,
        draft: '',
        slashOpen: false,
        thinking: true,
        attachments: [],
        extra: append(state.extra, action.conversationId, action.message),
      };
    case 'attachment': {
      const present = state.attachments.some((item) => item.id === action.attachment.id);

      return {
        ...state,
        attachments: present
          ? state.attachments.map((item) =>
              item.id === action.attachment.id ? action.attachment : item,
            )
          : [...state.attachments, action.attachment],
      };
    }
    case 'remove-attachment':
      return {
        ...state,
        attachments: state.attachments.filter((item) => item.id !== action.id),
      };
    case 'reply':
      return {
        ...state,
        thinking: false,
        extra: append(state.extra, action.conversationId, action.message),
      };
    case 'toggle-activity':
      return { ...state, activityOpen: state.activityOpen === action.key ? null : action.key };
    case 'summon':
      return {
        ...state,
        familiars: [...state.familiars, action.familiar],
        conversations: [action.conversation, ...state.conversations],
        conversationId: action.conversation.id,
        summon: null,
        switcherOpen: false,
        inspectorOpen: true,
        tab: 'access',
        thinking: false,
      };
    case 'escape':
      return {
        ...state,
        switcherOpen: false,
        slashOpen: false,
        activityOpen: null,
        searchOpen: false,
        lightbox: null,
        famCard: null,
        doc: null,
        summon: null,
        screenOpen: false,
        watching: false,
      };
    default:
      return state;
  }
}

function initialState(props: FamiliarsShellProps): ShellState {
  return {
    conversationId: props.initialConversation ?? FAM_CONVERSATIONS[0]?.id ?? 'pricing',
    tab: props.initialTab ?? 'overview',
    sidebarOpen: props.sidebarOpen ?? true,
    inspectorOpen: props.inspectorOpen ?? true,
    switcherOpen: false,
    slashOpen: false,
    searchOpen: false,
    searchQuery: '',
    draft: '',
    holds: {},
    decidedAt: '',
    extra: {},
    thinking: false,
    activityOpen: null,
    groups: {},
    lightbox: null,
    famCard: null,
    doc: null,
    headerHidden: false,
    recentAll: false,
    familiars: MOCK_FAMILIARS,
    conversations: FAM_CONVERSATIONS,
    summon: null,
    screenOpen: false,
    watching: false,
    attachments: [],
  };
}

function isField(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('textarea,input') !== null;
}

export function FamiliarsShell(props: FamiliarsShellProps) {
  const [state, dispatch] = useReducer(reduce, props, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const timers = useRef<number[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const lastScroll = useRef(0);

  const conversation =
    state.conversations.find((item) => item.id === state.conversationId) ??
    (state.conversations[0] as FamConversation);
  const familiar =
    state.familiars.find((item) => item.id === conversation.familiarId) ??
    (state.familiars[0] as MockFamiliar);
  const nameOf = (familiarId: string) =>
    state.familiars.find((item) => item.id === familiarId)?.name ?? '?';
  // The override is a board-only prop, but it has to read as one fact
  // everywhere: a hold shown as expired in the thread cannot still be waiting
  // in "Needs you" or counted against its familiar in the switcher.
  const holds: ShellState['holds'] = props.holdOverride
    ? { ...state.holds, [conversation.id]: props.holdOverride }
    : state.holds;
  const holdState = holds[conversation.id];
  const pendingHere = conversation.held === true && holdState === undefined;
  const messages: readonly FamMessage[] = [
    ...(FAM_MESSAGES[conversation.id] ?? []),
    ...(state.extra[conversation.id] ?? []),
  ];
  const needsYou = pendingHolds(state.conversations, holds);
  const recent = state.conversations.filter(
    (candidate) =>
      !(candidate.held && !holds[candidate.id]) &&
      (state.recentAll || candidate.familiarId === familiar.id),
  );
  const recentEmpty = props.demoEmpty === 'conversations' || recent.length === 0;
  const trigger = matchTrigger(familiar, state.draft);
  const slashOpen = state.slashOpen || /^\/\S*$/.test(state.draft);
  const commandPrefix = state.draft.split(' ')[0] ?? '';
  const commands = FAM_COMMANDS.filter(
    (command) =>
      !state.draft.startsWith('/') || command.name.startsWith(commandPrefix) || state.slashOpen,
  );
  const heldTitles = needsYou
    .filter((candidate) => candidate.familiarId === familiar.id)
    .map((candidate) => holdMessage(candidate.id)?.title.toLowerCase() ?? '');
  const inspectorWidth = INSPECTOR_WIDTHS[props.inspectorWidth ?? 'compact'];
  const mention = mentionQuery(state.draft);
  const mentionOptions =
    mention === undefined
      ? []
      : state.familiars.filter(
          (candidate) =>
            candidate.id !== familiar.id &&
            candidate.name.toLowerCase().startsWith(mention.toLowerCase()),
        );
  const mentionOpen = mention !== undefined && mentionOptions.length > 0;
  // Familiars who have spoken in this thread after being tagged.
  const participants = state.familiars.filter(
    (candidate) =>
      candidate.id !== familiar.id &&
      messages.some((item) => item.kind === 'familiar' && item.author === candidate.id),
  );
  const cardFamiliar =
    state.familiars.find((item) => item.id === state.famCard?.familiarId) ?? familiar;

  /** Track a timer so every pending callback can be cancelled together. */
  const track = useCallback((id: number) => {
    timers.current.push(id);
  }, []);

  const cancelTimers = useCallback(() => {
    for (const id of timers.current) {
      window.clearTimeout(id);
    }
    timers.current = [];
  }, []);

  useEffect(() => cancelTimers, [cancelTimers]);

  const scrollToEnd = useCallback(() => {
    track(
      window.setTimeout(() => {
        const transcript = transcriptRef.current;
        transcript?.scrollTo?.({ top: transcript.scrollHeight, behavior: 'smooth' });
      }, 50),
    );
  }, [track]);

  const decide = useCallback(
    (verdict: HoldState) => {
      const current = stateRef.current;
      const conversationId = current.conversationId;
      const at = clockLabel();

      dispatch({ type: 'decide', conversationId, state: verdict, at });
      cancelTimers();
      track(
        window.setTimeout(() => {
          const hold = holdMessage(conversationId);

          if (!hold) {
            return;
          }
          dispatch({
            type: 'reply',
            conversationId,
            message: {
              kind: 'familiar',
              time: at,
              text: verdict === 'approved' ? hold.approvedText : hold.declinedText,
              decision: true,
            },
          });
        }, DECISION_DELAY),
      );
    },
    [cancelTimers, track],
  );

  const send = useCallback(() => {
    const current = stateRef.current;
    const text = current.draft.trim();
    const conversationId = current.conversationId;
    const owner = current.conversations.find((item) => item.id === conversationId);
    const author = current.familiars.find((item) => item.id === owner?.familiarId);

    if (!text) {
      return;
    }
    const at = clockLabel();
    const crossed = author ? matchTrigger(author, text) : undefined;
    const guests = author
      ? mentionedFamiliars(text, current.familiars).filter((guest) => guest.id !== author.id)
      : [];
    const guestNames = guests.map((guest) => `@${guest.name}`).join(' and ');

    const attached = current.attachments
      .filter((item) => item.state !== 'failed')
      .map((item) => item.name);

    dispatch({
      type: 'send',
      conversationId,
      message: {
        kind: 'user',
        time: at,
        text,
        ...(attached.length > 0 ? { attachments: attached } : {}),
      },
    });
    cancelTimers();
    track(
      window.setTimeout(() => {
        dispatch({
          type: 'reply',
          conversationId,
          message: {
            kind: 'familiar',
            time: at,
            text: crossed
              ? `I can prepare that, but “${crossed.action}” is in my must-ask tier — I’ll get it ready and hold at the boundary for you.`
              : guests.length > 0
                ? `On it. I’ve brought ${guestNames} in; each of us stays inside our own ward.`
                : 'On it. I’ll keep everything inside notes/ and log each step to the ledger.',
          },
        });
      }, REPLY_DELAY),
    );
    // A tagged familiar answers in its own voice, a beat after the host.
    guests.forEach((guest, position) => {
      track(
        window.setTimeout(
          () => {
            dispatch({
              type: 'reply',
              conversationId,
              message: {
                kind: 'familiar',
                time: at,
                author: guest.id,
                text: `@${author?.name ?? ''} looped me in — I’ll take the ${guest.role.toLowerCase()} side of this and hold at my own boundary if it comes to that.`,
              },
            });
          },
          REPLY_DELAY + GUEST_DELAY * (position + 1),
        ),
      );
    });
    scrollToEnd();
  }, [cancelTimers, scrollToEnd, track]);

  const openSearch = useCallback(() => {
    dispatch({ type: 'patch', patch: { searchOpen: true, searchQuery: '', switcherOpen: false } });
  }, []);

  const selectConversation = useCallback(
    (id: string) => {
      cancelTimers();
      dispatch({ type: 'select-conversation', id });
    },
    [cancelTimers],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      const current = stateRef.current;
      const active = current.conversations.find((item) => item.id === current.conversationId);
      const pending =
        active?.held === true &&
        current.holds[active.id] === undefined &&
        props.holdOverride === undefined;

      if (meta && event.key === 'Enter' && pending) {
        event.preventDefault();
        decide('approved');
      } else if (meta && event.key === 'Backspace' && pending) {
        event.preventDefault();
        decide('declined');
      } else if (event.key === 'Escape') {
        dispatch({ type: 'escape' });
      } else if (event.key === '[' && !isField(event.target)) {
        dispatch({ type: 'patch', patch: { sidebarOpen: !current.sidebarOpen } });
      } else if (event.key === ']' && !isField(event.target)) {
        dispatch({ type: 'patch', patch: { inspectorOpen: !current.inspectorOpen } });
      } else if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
    }

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [decide, openSearch, props.holdOverride]);

  function patch(next: Partial<ShellState>) {
    dispatch({ type: 'patch', patch: next });
  }

  function goAccess() {
    patch({ tab: 'access', inspectorOpen: true, groups: { ...state.groups, review: true } });
  }

  function jumpToHold() {
    const hold = document.getElementById('fr-hold');
    const transcript = transcriptRef.current;

    if (hold && transcript) {
      transcript.scrollTo?.({ top: hold.offsetTop - 40, behavior: 'smooth' });
    }
  }

  function openFamiliarCard(event: ReactMouseEvent<HTMLButtonElement>, familiarId: string) {
    const root = rootRef.current;

    if (!root) {
      return;
    }
    const rootBox = root.getBoundingClientRect();
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(box.left - rootBox.left, rootBox.width - 320));
    const y = Math.max(0, Math.min(box.bottom - rootBox.top + 8, rootBox.height - 260));

    patch({ famCard: { x, y, familiarId } });
  }

  function pickMention(name: string) {
    patch({ draft: state.draft.replace(/@[\p{L}\p{N}_-]*$/u, `@${name} `) });
    composerRef.current?.focus();
  }

  function openSummon() {
    const templateId = FAMILIAR_TEMPLATES[0]?.id ?? 'researcher';

    patch({
      summon: {
        templateId,
        name: randomName(
          templateId,
          state.familiars.map((item) => item.name),
        ),
        suggested: true,
      },
      switcherOpen: false,
    });
  }

  function summon() {
    const draft = state.summon;

    if (!draft) {
      return;
    }
    const created = summonFamiliar(
      draft.templateId,
      draft.name,
      state.familiars.map((item) => item.id),
    );

    if (!created) {
      return;
    }
    cancelTimers();
    dispatch({
      type: 'summon',
      familiar: created,
      conversation: {
        id: `chat-${created.id}`,
        familiarId: created.id,
        title: 'New chat',
        time: 'Now',
        preview: 'Summoned just now',
      },
    });
  }

  /**
   * Attach the next mock file and walk it through the chip's states.
   *
   * There is no file picker in the demo; what matters is the lifecycle the
   * real one will drive — uploading with progress, then ready or failed.
   */
  function attach() {
    const taken = state.attachments.length;
    const file = MOCK_FILES[taken % MOCK_FILES.length];

    if (!file) {
      return;
    }
    const id = `att-${Date.now().toString(36)}-${taken}`;
    const base: ComposerAttachment = { id, name: file.name, meta: file.meta };

    dispatch({ type: 'attachment', attachment: { ...base, state: 'uploading', progress: 0 } });
    [25, 55, 85].forEach((progress, step) => {
      track(
        window.setTimeout(
          () => {
            dispatch({
              type: 'attachment',
              attachment: { ...base, state: 'uploading', progress },
            });
          },
          UPLOAD_STEP * (step + 1),
        ),
      );
    });
    track(
      window.setTimeout(() => {
        dispatch({
          type: 'attachment',
          attachment: file.fails
            ? { ...base, state: 'failed', meta: `Too large — ${file.meta}, 25 MB limit` }
            : { ...base, state: 'ready' },
        });
      }, UPLOAD_STEP * 4),
    );
  }

  const paletteCommands: CompletionCommand[] = FAM_COMMANDS.map((command) => ({
    id: command.name,
    label: command.name,
    description: command.hint,
    meta: command.tier,
    ...(command.tier === 'must ask' ? { metaTone: 'warning' as const } : {}),
  }));

  function openSlash() {
    patch({ slashOpen: true, draft: '/' });
    composerRef.current?.focus();
  }

  function pickCommand(name: string) {
    patch({ draft: `${name} `, slashOpen: false });
    composerRef.current?.focus();
  }

  /**
   * Keys the host claims before the composer's own handling: completing the
   * inline `@` and `/` menus, closing them, and keeping ⌘⏎ from reaching the
   * window's approve shortcut while a draft is being sent.
   */
  function onComposerKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const first = commands[0];
    const firstMention = mentionOptions[0];

    if (mentionOpen && firstMention && (event.key === 'Tab' || event.key === 'Enter')) {
      event.preventDefault();
      pickMention(firstMention.name);
    } else if (mentionOpen && event.key === 'Escape') {
      event.stopPropagation();
      patch({ draft: state.draft.replace(/@[\p{L}\p{N}_-]*$/u, '') });
    } else if (event.key === 'Tab' && slashOpen && first) {
      event.preventDefault();
      pickCommand(first.name);
    } else if (event.key === 'Enter' && !event.shiftKey && slashOpen && first) {
      if (/^\/\S*$/.test(state.draft)) {
        event.preventDefault();
        pickCommand(first.name);
      }
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && state.draft.trim()) {
      event.stopPropagation();
    } else if (event.key === 'Escape' && slashOpen) {
      event.stopPropagation();
      patch({ draft: '', slashOpen: false });
    }
  }

  function onTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const top = event.currentTarget.scrollTop;
    const last = lastScroll.current;
    const down = top > last + 6 && top > 48;
    const up = top < last - 6 || top < 24;

    lastScroll.current = top;
    if (down && !state.headerHidden) {
      patch({ headerHidden: true });
    } else if (up && state.headerHidden) {
      patch({ headerHidden: false });
    }
  }

  const lightboxMessage = state.lightbox === null ? undefined : messages[state.lightbox];
  const lightbox =
    lightboxMessage?.kind === 'image' && lightboxMessage.plot ? lightboxMessage : null;
  const searchQuery = state.searchQuery.trim().toLowerCase();
  const searchResults = state.conversations.filter((candidate) => {
    return (
      !searchQuery ||
      [candidate.title, candidate.preview, nameOf(candidate.familiarId)]
        .join(' ')
        .toLowerCase()
        .includes(searchQuery)
    );
  });
  const layout = {
    '--fr-sidebar-w': `${state.sidebarOpen ? SIDEBAR_WIDTH : 0}px`,
    '--fr-inspector-w': `${state.inspectorOpen ? inspectorWidth : 0}px`,
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={cx('fr-shell', !state.inspectorOpen && 'fr-shell--inspector-closed')}
      style={layout}
    >
      <div className="fr-grain" aria-hidden="true" />

      <aside
        className="fr-sidebar"
        aria-label="Conversations sidebar"
        aria-hidden={!state.sidebarOpen || undefined}
        inert={!state.sidebarOpen || undefined}
      >
        <div className="fr-sidebar-inner">
          <button
            type="button"
            className="fr-rail-toggle"
            aria-label="Hide conversations"
            title="Hide conversations  ["
            onClick={() => patch({ sidebarOpen: false })}
          >
            <span className="fr-rail-toggle-label">Conversations</span>
            <span className="fr-muted-icon">
              <Icon name="sidebar-simple" size={15} />
            </span>
          </button>
          <div className="fr-switcher-wrap">
            <button
              type="button"
              className="fr-switcher"
              aria-haspopup="listbox"
              aria-expanded={state.switcherOpen}
              onClick={() => patch({ switcherOpen: !state.switcherOpen })}
            >
              <Avatar
                initial={familiar.name[0] ?? '?'}
                size={28}
                presence={familiar.status}
                live
                ring
              />
              <span className="fr-switcher-copy">
                <span className="fr-switcher-name">{familiar.name}</span>
                <span className="fr-switcher-role">{familiar.role}</span>
              </span>
              <span className="fr-muted-icon">
                <Icon name="caret-up-down" size={14} />
              </span>
            </button>
            {state.switcherOpen ? (
              <div className="fr-switcher-menu">
                <div role="listbox" aria-label="Familiar switcher" className="fr-switcher-list">
                  {state.familiars.map((candidate) => {
                    const held = needsYou.filter((item) => item.familiarId === candidate.id).length;
                    const active = candidate.id === familiar.id;

                    return (
                      <button
                        key={candidate.id}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className="fr-switcher-option"
                        onClick={() => {
                          const first = state.conversations.find(
                            (item) => item.familiarId === candidate.id,
                          );

                          if (first) {
                            selectConversation(first.id);
                          }
                        }}
                      >
                        <Avatar
                          initial={candidate.name[0] ?? '?'}
                          size={24}
                          presence={candidate.status}
                          ring={active}
                          elevated
                        />
                        <span className="fr-switcher-copy">
                          <span className="fr-switcher-name">{candidate.name}</span>
                          <span className="fr-switcher-role">{candidate.role}</span>
                        </span>
                        <span
                          className={cx('fr-switcher-meta', held > 0 && 'fr-switcher-meta--held')}
                        >
                          {held > 0 ? `${held} held` : candidate.status}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <button type="button" className="fr-switcher-new" onClick={openSummon}>
                  <span className="fr-switcher-new-glyph" aria-hidden="true">
                    <Icon name="sparkle" size={13} />
                  </span>
                  <span className="fr-switcher-copy">
                    <span className="fr-switcher-name">New familiar…</span>
                    <span className="fr-switcher-role">Summon one from a template</span>
                  </span>
                </button>
              </div>
            ) : null}
          </div>
          <div className="fr-sidebar-actions">
            <FamButton variant="secondary" size="md" leadingIcon="plus" fullWidth>
              New chat
            </FamButton>
            <button
              type="button"
              className="fr-btn fr-btn--secondary fr-search-trigger"
              aria-label="Search conversations (⌘K)"
              title="Search  ⌘K"
              onClick={openSearch}
            >
              <Icon name="magnifying-glass" size={15} />
            </button>
          </div>
          <div className="fr-conv-scroll">
            {needsYou.length > 0 ? (
              <section className="fr-needs-you" aria-label="Needs you">
                <div className="fr-section-label">
                  <span className="fr-section-title">
                    <span className="fr-dot" aria-hidden="true" />
                    Needs you
                  </span>
                  <span className="fr-section-count">{needsYou.length}</span>
                </div>
                <div className="fr-conv-list">
                  {needsYou.map((item) => (
                    <ConversationRow
                      key={item.id}
                      conversation={item}
                      ownerName={nameOf(item.familiarId)}
                      active={item.id === conversation.id}
                      preview={item.preview.replace(/ · waiting on you$/, '')}
                      onSelect={selectConversation}
                    />
                  ))}
                </div>
              </section>
            ) : null}
            <div className="fr-section-label fr-section-label--recent">
              <span>
                Recent <span className="fr-recent-count">{recent.length}</span>
              </span>
              <button
                type="button"
                className="fr-recent-filter"
                title="Filter recent conversations"
                onClick={() => patch({ recentAll: !state.recentAll })}
              >
                {state.recentAll ? 'All familiars' : familiar.name}
                <span className="fr-muted-icon">
                  <Icon name="caret-up-down" size={11} />
                </span>
              </button>
            </div>
            {recentEmpty ? (
              <div className="fr-sidebar-empty">
                <span className="fr-empty-glyph">
                  <Icon name="chats-circle" size={16} />
                </span>
                <span className="fr-empty-text">No conversations with {familiar.name} yet.</span>
                <FamButton variant="secondary" size="sm" leadingIcon="plus">
                  New chat
                </FamButton>
              </div>
            ) : (
              <div className="fr-conv-list">
                {recent.map((item) => (
                  <ConversationRow
                    key={item.id}
                    conversation={item}
                    ownerName={nameOf(item.familiarId)}
                    active={item.id === conversation.id}
                    preview={item.preview}
                    onSelect={selectConversation}
                  />
                ))}
              </div>
            )}
          </div>
          <div className="fr-sidebar-foot">Cave connected · v0.3.0</div>
        </div>
      </aside>

      <main className={cx('fr-thread', state.headerHidden && 'fr-thread--header-hidden')}>
        <button
          type="button"
          className={cx(
            'fr-rail-handle fr-rail-handle--left',
            !state.sidebarOpen && 'fr-rail-handle--closed',
          )}
          aria-label={state.sidebarOpen ? 'Hide conversations rail' : 'Show conversations rail'}
          title={state.sidebarOpen ? 'Hide conversations  [' : 'Show conversations  ['}
          onClick={() => patch({ sidebarOpen: !state.sidebarOpen })}
        />
        <button
          type="button"
          className={cx(
            'fr-rail-handle fr-rail-handle--right',
            !state.inspectorOpen && 'fr-rail-handle--closed',
          )}
          aria-label={state.inspectorOpen ? 'Hide inspector rail' : 'Show inspector rail'}
          title={state.inspectorOpen ? 'Hide inspector  ]' : 'Show inspector  ]'}
          onClick={() => patch({ inspectorOpen: !state.inspectorOpen })}
        />
        <header className="fr-thread-header">
          <div className="fr-thread-header-lead">
            {!state.sidebarOpen ? (
              <FamIconButton
                icon="sidebar-simple"
                size="sm"
                label="Show conversations"
                title="Show conversations  ["
                onClick={() => patch({ sidebarOpen: true })}
              />
            ) : null}
            <span className="fr-thread-title">{conversation.title}</span>
            <span className="fr-thread-familiar">{familiar.name}</span>
            {participants.map((guest) => (
              <span key={guest.id} className="fr-participant" title={`${guest.name} was tagged in`}>
                <Avatar initial={guest.name[0] ?? '?'} size={22} presence={guest.status} />
                {guest.name}
              </span>
            ))}
          </div>
          <div className="fr-thread-header-actions">
            <FamIconButton
              icon="monitor"
              size="sm"
              label={`${familiar.name}’s screen`}
              title="Screen"
              aria-pressed={state.screenOpen}
              onClick={() => patch({ screenOpen: !state.screenOpen })}
            />
            {pendingHere ? (
              <button type="button" className="fr-held-jump" onClick={jumpToHold}>
                <span className="fr-dot" aria-hidden="true" />1 held
              </button>
            ) : null}
            <FamIconButton icon="dots-three" size="sm" label="More" />
            {!state.inspectorOpen ? (
              <FamIconButton
                icon="sidebar-simple"
                size="sm"
                flip
                label="Show inspector"
                title="Show inspector  ]"
                onClick={() => patch({ inspectorOpen: true })}
              />
            ) : null}
          </div>
        </header>

        <div className="fr-transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
          <div className="fr-column">
            {messages.map((message, index) => (
              <MessageRow
                // Messages have no ids of their own; position is their identity.
                key={`${conversation.id}-${index}`}
                message={message}
                index={index}
                familiar={familiar}
                familiars={state.familiars}
                holdState={holdState}
                decidedAt={state.decidedAt || '10:54 PM'}
                onApprove={() => decide('approved')}
                onDecline={() => decide('declined')}
                onOpenFamiliar={openFamiliarCard}
                onOpenImage={(position) => patch({ lightbox: position })}
              />
            ))}
            {messages.length === 0 && !state.thinking ? (
              <div className="fr-thread-empty">
                <Avatar
                  initial={familiar.name[0] ?? '?'}
                  size={36}
                  ring
                  presence={familiar.status}
                />
                <span className="fr-thread-empty-title">{familiar.name} is ready.</span>
                <span className="fr-empty-text">
                  Summoned just now as a {familiar.creature.toLowerCase()}. {familiar.soul.purpose}
                </span>
                <span className="fr-empty-text">
                  {familiar.ward.approvalTiers.auto.length} things it may do alone ·{' '}
                  {familiar.ward.approvalTiers.humanReview.length} it must ask about. Say what you
                  need.
                </span>
              </div>
            ) : null}
            {state.thinking ? <ThinkingRow familiar={familiar} /> : null}
          </div>
        </div>

        <div className="fr-composer-wrap">
          <div className="fr-composer-inner">
            <Composer
              value={state.draft}
              onValueChange={(next) => patch({ draft: next, slashOpen: false })}
              label={`Message ${familiar.name}`}
              textareaRef={composerRef}
              onKeyDown={onComposerKey}
              onSend={send}
              running={state.thinking}
              onStop={cancelTimers}
              attachments={state.attachments}
              onRemoveAttachment={(id) => dispatch({ type: 'remove-attachment', id })}
              onAttach={attach}
              onOpenCommands={openSlash}
              commands={paletteCommands}
              onSelectCommand={(command) => pickCommand(command.label)}
              warning={
                trigger
                  ? {
                      label: 'Held for approval',
                      title: `“${trigger.action}” is in ${familiar.name}’s must-ask tier`,
                      onClick: goAccess,
                    }
                  : null
              }
            >
              {mentionOpen ? (
                <div role="listbox" aria-label="Mention a familiar" className="fr-slash">
                  {mentionOptions.map((candidate, index) => (
                    <button
                      key={candidate.id}
                      type="button"
                      role="option"
                      aria-selected={index === 0}
                      className="fr-slash-option fr-mention-option"
                      onClick={() => pickMention(candidate.name)}
                    >
                      <Avatar
                        initial={candidate.name[0] ?? '?'}
                        size={24}
                        presence={candidate.status}
                        elevated
                      />
                      <span className="fr-switcher-copy">
                        <span className="fr-switcher-name">@{candidate.name}</span>
                        <span className="fr-switcher-role">{candidate.role}</span>
                      </span>
                      <span className="fr-slash-tier">{candidate.status}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {slashOpen && commands.length > 0 && !mentionOpen ? (
                <div role="listbox" aria-label="Commands" className="fr-slash">
                  {commands.map((command, index) => (
                    <button
                      key={command.name}
                      type="button"
                      role="option"
                      aria-selected={index === 0}
                      className="fr-slash-option"
                      onClick={() => pickCommand(command.name)}
                    >
                      <code className="fr-slash-name">{command.name}</code>
                      <span className="fr-slash-hint">{command.hint}</span>
                      <span
                        className={cx(
                          'fr-slash-tier',
                          command.tier === 'must ask' && 'fr-slash-tier--ask',
                        )}
                      >
                        {command.tier === 'must ask' ? (
                          <span className="fr-dot" aria-hidden="true" />
                        ) : null}
                        {command.tier}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </Composer>
          </div>
        </div>
      </main>

      <aside
        className="fr-inspector"
        aria-label="Familiar inspector"
        aria-hidden={!state.inspectorOpen || undefined}
        inert={!state.inspectorOpen || undefined}
      >
        <FamiliarInspector
          familiar={familiar}
          tab={state.tab}
          onTabChange={(tab) => patch({ tab })}
          onHide={() => patch({ inspectorOpen: false })}
          heldTitles={heldTitles}
          groups={state.groups}
          onToggleGroup={(key, open) => patch({ groups: { ...state.groups, [key]: open } })}
          accessGroups={props.accessGroups}
          activityOpen={state.activityOpen}
          onToggleActivity={(key) => dispatch({ type: 'toggle-activity', key })}
          onOpenDoc={(request) => patch({ doc: request })}
          onSummon={openSummon}
          demoEmpty={props.demoEmpty}
        />
      </aside>

      {state.screenOpen && !state.watching ? (
        <section className="fr-screen-panel" aria-label={`${familiar.name}’s screen`}>
          <div className="fr-screen-panel-bar">
            <FamIconButton icon="gear-six" size="sm" label="Screen settings" />
            <FamIconButton
              icon="x"
              size="sm"
              label="Close screen"
              onClick={() => patch({ screenOpen: false })}
            />
          </div>
          <button
            type="button"
            className="fr-screen-placeholder"
            aria-label={`Watch ${familiar.name}’s screen`}
            title="Watch"
            onClick={() => patch({ watching: true })}
          >
            <Icon name="monitor" size={28} />
          </button>
          <span className="fr-screen-caption">{familiar.name}’s screen</span>
        </section>
      ) : null}

      {state.watching ? (
        <ScreenWatch familiar={familiar} onClose={() => patch({ watching: false })} />
      ) : null}

      {state.searchOpen ? (
        <div role="dialog" aria-modal="true" aria-label="Search conversations" className="fr-scrim">
          <button
            type="button"
            className="fr-scrim-close"
            aria-label="Close search"
            tabIndex={-1}
            onClick={() => patch({ searchOpen: false })}
          />
          <div className="fr-search">
            <div className="fr-search-head">
              <Icon name="magnifying-glass" size={16} />
              <input
                id="fr-search"
                className="fr-search-input"
                value={state.searchQuery}
                placeholder="Search conversations…"
                aria-label="Search conversations"
                // biome-ignore lint/a11y/noAutofocus: the dialog exists to take typing; focus is the point.
                autoFocus
                onChange={(event) => patch({ searchQuery: event.target.value })}
                onKeyDown={(event) => {
                  const first = searchResults[0];

                  if (event.key === 'Enter' && first) {
                    event.preventDefault();
                    selectConversation(first.id);
                  }
                }}
              />
              <kbd className="fr-kbd-chip">esc</kbd>
            </div>
            <div className="fr-search-list">
              <div className="fr-search-label">
                <span>Conversations</span>
                <span>{searchResults.length}</span>
              </div>
              {searchResults.map((result, index) => {
                const ownerName = nameOf(result.familiarId);
                const dot =
                  result.held && !holds[result.id] ? 'warn' : result.failed ? 'danger' : null;

                return (
                  <button
                    key={result.id}
                    type="button"
                    className="fr-search-result"
                    aria-current={index === 0 || undefined}
                    onClick={() => selectConversation(result.id)}
                  >
                    <Avatar initial={ownerName[0] ?? '?'} size={24} elevated />
                    <span className="fr-search-result-copy">
                      <span className="fr-search-result-head">
                        {dot ? (
                          <span className={cx('fr-dot', `fr-dot--${dot}`)} aria-hidden="true" />
                        ) : null}
                        <span className="fr-search-result-title">{result.title}</span>
                      </span>
                      <span className="fr-search-result-preview">
                        {ownerName} · {result.preview}
                      </span>
                    </span>
                    <span className="fr-search-result-time">{result.time}</span>
                  </button>
                );
              })}
              {searchResults.length === 0 ? (
                <div className="fr-search-empty">No conversations match “{state.searchQuery}”.</div>
              ) : null}
            </div>
            <div className="fr-search-foot">
              <span>↑↓ navigate</span>
              <span>↵ open</span>
              <span>esc close</span>
            </div>
          </div>
        </div>
      ) : null}

      {lightbox ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.alt}
          className="fr-scrim fr-scrim--center fr-scrim--lightbox"
        >
          <button
            type="button"
            className="fr-scrim-close fr-scrim-close--zoom"
            aria-label="Close image"
            tabIndex={-1}
            onClick={() => patch({ lightbox: null })}
          />
          <figure className="fr-lightbox">
            <div className="fr-plot fr-plot--large">
              <EvidenceMap plot={lightbox.plot ?? []} large />
            </div>
            <figcaption className="fr-lightbox-caption">
              <code className="fr-file">{lightbox.file}</code>
              <span className="fr-lightbox-actions">
                <FamButton variant="secondary" size="sm">
                  Save Note
                </FamButton>
                <FamButton variant="ghost" size="sm" onClick={() => patch({ lightbox: null })}>
                  Close
                </FamButton>
                <kbd className="fr-mono fr-small fr-muted">esc</kbd>
              </span>
            </figcaption>
          </figure>
        </div>
      ) : null}

      {state.famCard ? (
        <>
          <button
            type="button"
            className="fr-popover-scrim"
            aria-label="Close familiar card"
            tabIndex={-1}
            onClick={() => patch({ famCard: null })}
          />
          <section
            role="dialog"
            aria-label={`About ${cardFamiliar.name}`}
            className="fr-popover"
            style={
              { '--x': `${state.famCard.x}px`, '--y': `${state.famCard.y}px` } as CSSProperties
            }
          >
            <div className="fr-popover-head">
              <Avatar
                initial={cardFamiliar.name[0] ?? '?'}
                size={36}
                presence={cardFamiliar.status}
                live
                ring
                elevated
                dot={12}
                surface="elevated"
              />
              <span className="fr-popover-copy">
                <span className="fr-popover-name">{cardFamiliar.name}</span>
                <span className="fr-popover-role">
                  {cardFamiliar.role} · {cardFamiliar.creature} · {cardFamiliar.pronouns}
                </span>
              </span>
            </div>
            <p className="fr-popover-purpose">{cardFamiliar.soul.purpose}</p>
            <div className="fr-popover-stats">
              <div className="fr-popover-stat">
                <span className="fr-fact-label">May act</span>
                <span className="fr-popover-stat-value fr-accent">
                  {cardFamiliar.ward.approvalTiers.auto.length}
                </span>
              </div>
              <div className="fr-popover-stat">
                <span className="fr-fact-label">Must ask</span>
                <span className="fr-popover-stat-value fr-warn">
                  {cardFamiliar.ward.approvalTiers.humanReview.length}
                </span>
              </div>
              <div className="fr-popover-stat">
                <span className="fr-fact-label">Status</span>
                <span className="fr-popover-stat-value fr-capitalize">{cardFamiliar.status}</span>
              </div>
            </div>
            <div className="fr-popover-foot">
              <code className="fr-mono fr-small fr-muted">
                ward.toml {cardFamiliar.ward.version}
              </code>
              <FamButton
                variant="secondary"
                size="xs"
                onClick={() => patch({ famCard: null, inspectorOpen: true, tab: 'access' })}
              >
                Open in inspector
              </FamButton>
            </div>
          </section>
        </>
      ) : null}

      {state.summon ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Summon a familiar"
          className="fr-scrim fr-scrim--center fr-scrim--doc"
        >
          <button
            type="button"
            className="fr-scrim-close"
            aria-label="Cancel summoning"
            tabIndex={-1}
            onClick={() => patch({ summon: null })}
          />
          <SummonDialog
            draft={state.summon}
            taken={state.familiars.map((item) => item.name.toLowerCase())}
            onChange={(next) => patch({ summon: next })}
            onCancel={() => patch({ summon: null })}
            onSummon={summon}
          />
        </div>
      ) : null}

      {state.doc ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={state.doc.file}
          className="fr-scrim fr-scrim--center fr-scrim--doc"
        >
          <button
            type="button"
            className="fr-scrim-close"
            aria-label="Close document"
            tabIndex={-1}
            onClick={() => patch({ doc: null })}
          />
          <DocViewer request={state.doc} familiar={familiar} onClose={() => patch({ doc: null })} />
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------- conversation row */

function ConversationRow({
  conversation,
  ownerName,
  active,
  preview,
  onSelect,
}: {
  conversation: FamConversation;
  ownerName: string;
  active: boolean;
  preview: string;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="fr-conv"
      aria-current={active || undefined}
      onClick={() => onSelect(conversation.id)}
    >
      <Avatar initial={ownerName[0] ?? '?'} size={24} />
      <span className="fr-conv-body">
        <span className="fr-conv-top">
          <span className="fr-conv-title">{conversation.title}</span>
          <span className="fr-conv-time">{conversation.time}</span>
        </span>
        <span className="fr-conv-preview">
          {conversation.held ? <span className="fr-dot" aria-hidden="true" /> : null}
          {conversation.failed ? (
            <span className="fr-danger-icon">
              <Icon name="warning-circle-fill" size={11} />
            </span>
          ) : null}
          <span className="fr-conv-preview-text">
            {ownerName} · {preview}
          </span>
        </span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------ doc viewer */

function DocViewer({
  request,
  familiar,
  onClose,
}: {
  request: DocRequest;
  familiar: MockFamiliar;
  onClose: () => void;
}) {
  const source = FAM_DOCS[request.file] ?? { kind: 'File', lines: ['(no preview available)'] };
  const editable = familiar.ward.editablePaths.includes(request.file);
  const icon = request.file.endsWith('/')
    ? 'folder-open'
    : request.file === 'ward.toml'
      ? 'hand'
      : 'file-text';

  return (
    <article className="fr-doc">
      <header className="fr-doc-head">
        <span className="fr-secondary-icon">
          <Icon name={icon} size={15} />
        </span>
        <span className="fr-doc-title">
          <code className="fr-doc-file">{request.file}</code>
          <span className="fr-doc-kind">
            {source.kind} ·{' '}
            {editable ? `${familiar.name} may edit` : `read-only for ${familiar.name}`}
          </span>
        </span>
        <kbd className="fr-kbd-chip">esc</kbd>
      </header>
      <div className="fr-doc-body">
        {source.lines.map((line, position) => {
          const highlighted = request.hl !== undefined && line.includes(request.hl);
          const tone = /^#/.test(line) ? 'heading' : /^\[/.test(line) ? 'section' : 'plain';

          return (
            <div
              // Lines have no identity beyond their number.
              key={`${request.file}-${position}`}
              className={cx('fr-doc-line', highlighted && 'fr-doc-line--hl')}
            >
              <span className="fr-doc-n">{position + 1}</span>
              <span className={cx('fr-doc-text', `fr-doc-text--${tone}`)}>{line || ' '}</span>
            </div>
          );
        })}
      </div>
      <footer className="fr-doc-foot">
        <span>
          {request.hl ? `Rule “${request.hl}” highlighted` : `${source.lines.length} lines`}
        </span>
        <span className="fr-doc-actions">
          <FamButton variant="secondary" size="sm">
            Open in editor
          </FamButton>
          <FamButton variant="ghost" size="sm" onClick={onClose}>
            Close
          </FamButton>
        </span>
      </footer>
    </article>
  );
}

/* ------------------------------------------------------------- summon */

function SummonDialog({
  draft,
  taken,
  onChange,
  onCancel,
  onSummon,
}: {
  draft: SummonDraft;
  /** Lower-cased names already in use, so a duplicate is caught before Summon. */
  taken: readonly string[];
  onChange: (draft: SummonDraft) => void;
  onCancel: () => void;
  onSummon: () => void;
}) {
  const ward = TEMPLATE_WARDS[draft.templateId];
  const name = draft.name.trim();
  const duplicate = taken.includes(name.toLowerCase());
  const ready = name.length > 0 && !duplicate && ward !== undefined;
  const example = TEMPLATE_NAMES[draft.templateId]?.[0] ?? 'Sage';

  return (
    <article className="fr-doc fr-summon">
      <header className="fr-doc-head">
        <span className="fr-accent-icon">
          <Icon name="sparkle" size={15} />
        </span>
        <span className="fr-doc-title">
          <span className="fr-summon-title">Summon a familiar</span>
          <span className="fr-doc-kind">
            Start from a template; the ward comes with it. Bound to Val Alexander.
          </span>
        </span>
        <kbd className="fr-kbd-chip">esc</kbd>
      </header>
      <div className="fr-summon-body">
        <fieldset className="fr-summon-templates" aria-label="Template">
          {FAMILIAR_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className="fr-summon-template"
              aria-pressed={template.id === draft.templateId}
              onClick={() =>
                onChange({
                  templateId: template.id,
                  // A name you typed is yours; a suggested one follows the template.
                  name:
                    draft.suggested || draft.name.trim() === ''
                      ? randomName(template.id, taken)
                      : draft.name,
                  suggested: draft.suggested || draft.name.trim() === '',
                })
              }
            >
              <span className="fr-summon-template-name">{template.name}</span>
              <span className="fr-summon-template-creature">{template.creature}</span>
              <span className="fr-summon-template-summary">{template.summary}</span>
            </button>
          ))}
        </fieldset>
        <div className="fr-summon-field">
          <label htmlFor="fr-summon-name" className="fr-summon-label">
            Name
          </label>
          <div className="fr-summon-name-row">
            <input
              id="fr-summon-name"
              className="fr-summon-input"
              value={draft.name}
              placeholder={`e.g. ${example}`}
              // biome-ignore lint/a11y/noAutofocus: the dialog exists to take a name; focus is the point.
              autoFocus
              onChange={(event) =>
                onChange({ ...draft, name: event.target.value, suggested: false })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter' && ready) {
                  event.preventDefault();
                  onSummon();
                }
              }}
            />
            <FamButton
              variant="secondary"
              size="md"
              leadingIcon="arrow-clockwise"
              title="Suggest a name in the spirit of this template"
              onClick={() =>
                onChange({
                  ...draft,
                  name: randomName(draft.templateId, [...taken, draft.name]),
                  suggested: true,
                })
              }
            >
              Suggest a name
            </FamButton>
          </div>
          {duplicate ? (
            <span className="fr-summon-error">There is already a familiar called {name}.</span>
          ) : null}
        </div>
        {ward ? (
          <section className="fr-summon-ward" aria-label="Ward preview">
            <div className="fr-summon-ward-col fr-summon-ward-col--act">
              <span className="fr-summon-ward-head">
                <span className="fr-summon-ward-glyph">
                  <Icon name="check" size={13} />
                </span>
                May act
                <span className="fr-summon-ward-count">{ward.auto.length}</span>
              </span>
              <span className="fr-summon-ward-hint">Runs on its own, logged</span>
              {ward.auto.map((item) => (
                <span key={item} className="fr-summon-ward-item">
                  <Icon name="check" size={12} />
                  {item}
                </span>
              ))}
            </div>
            <div className="fr-summon-ward-col fr-summon-ward-col--ask">
              <span className="fr-summon-ward-head">
                <span className="fr-summon-ward-glyph">
                  <Icon name="hand" size={13} />
                </span>
                Must ask
                <span className="fr-summon-ward-count">{ward.humanReview.length}</span>
              </span>
              <span className="fr-summon-ward-hint">Stops and waits for you</span>
              {ward.humanReview.map((item) => (
                <span key={item} className="fr-summon-ward-item">
                  <span className="fr-dot" aria-hidden="true" />
                  {item}
                </span>
              ))}
            </div>
            <div className="fr-summon-ward-col fr-summon-ward-col--reach">
              <span className="fr-summon-ward-head">
                <span className="fr-summon-ward-glyph">
                  <Icon name="folder-open" size={13} />
                </span>
                Workspace reach
                <span className="fr-summon-ward-count">{ward.editablePaths.length}</span>
              </span>
              <span className="fr-summon-ward-hint">The only paths it may change</span>
              {ward.editablePaths.map((item) => (
                <span key={item} className="fr-summon-ward-item">
                  <Icon name={item.endsWith('/') ? 'folder-open' : 'file-text'} size={12} />
                  <code className="fr-mono fr-small">{item}</code>
                </span>
              ))}
            </div>
          </section>
        ) : null}
      </div>
      <footer className="fr-doc-foot">
        <span>
          <code className="fr-mono fr-small">ward.toml 0.1.0</code> · MEMORY.md starts empty
        </span>
        <span className="fr-doc-actions">
          <FamButton variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </FamButton>
          <FamButton
            variant="primary"
            size="sm"
            leadingIcon="sparkle"
            disabled={!ready}
            onClick={onSummon}
          >
            Summon
          </FamButton>
        </span>
      </footer>
    </article>
  );
}

/* -------------------------------------------------------------- screen */

/**
 * The familiar's screen, watched.
 *
 * There is no screen to share yet, so this is the frame the real one will
 * arrive in: a titled bar, a running clock, and the shared area bordered in
 * the recording colour so it is never mistaken for the app itself.
 */
function ScreenWatch({ familiar, onClose }: { familiar: MockFamiliar; onClose: () => void }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setElapsed((seconds) => seconds + 1), 1000);

    return () => window.clearInterval(id);
  }, []);

  const minutes = Math.floor(elapsed / 60);
  const seconds = String(elapsed % 60).padStart(2, '0');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${familiar.name}’s screen`}
      className="fr-watch"
    >
      <div className="fr-watch-bar">
        <span className="fr-watch-title">{familiar.name} is watching and learning</span>
        <span className="fr-spacer" />
        <output className="fr-watch-rec" aria-label="Recording">
          <span className="fr-watch-rec-dot" aria-hidden="true" />
          {minutes}:{seconds}
        </output>
        <FamIconButton icon="x" size="sm" label="Stop watching" onClick={onClose} />
      </div>
      <div className="fr-watch-screen">
        <div className="fr-watch-desktop" aria-hidden="true">
          <div className="fr-watch-dock">
            <span className="fr-watch-dock-app">
              <Icon name="globe" size={22} />
            </span>
            <span className="fr-watch-dock-app">
              <Icon name="folder-open" size={22} />
            </span>
            <span className="fr-watch-dock-app">
              <Icon name="terminal-window" size={22} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
