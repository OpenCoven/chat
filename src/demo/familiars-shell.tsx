import {
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useReducer,
  useRef,
} from 'react';

import {
  clockLabel,
  conversationById,
  FAM_COMMANDS,
  FAM_CONVERSATIONS,
  FAM_DOCS,
  FAM_MESSAGES,
  type FamConversation,
  type FamMessage,
  familiarById,
  type HoldState,
  holdMessage,
  matchTrigger,
  pendingHolds,
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
import { MOCK_FAMILIARS, type MockFamiliar } from './mock-familiars';

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

type Point = Readonly<{ x: number; y: number }>;

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
  famCard: Point | null;
  doc: DocRequest | null;
  headerHidden: boolean;
  recentAll: boolean;
}>;

type ShellAction =
  | { type: 'patch'; patch: Partial<ShellState> }
  | { type: 'select-conversation'; id: string }
  | { type: 'decide'; conversationId: string; state: HoldState; at: string }
  | { type: 'send'; conversationId: string; message: FamMessage }
  | { type: 'reply'; conversationId: string; message: FamMessage }
  | { type: 'toggle-activity'; key: ActivityKey }
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
        extra: append(state.extra, action.conversationId, action.message),
      };
    case 'reply':
      return {
        ...state,
        thinking: false,
        extra: append(state.extra, action.conversationId, action.message),
      };
    case 'toggle-activity':
      return { ...state, activityOpen: state.activityOpen === action.key ? null : action.key };
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
    conversationById(state.conversationId) ?? (FAM_CONVERSATIONS[0] as FamConversation);
  const familiar = familiarById(conversation.familiarId) ?? (MOCK_FAMILIARS[0] as MockFamiliar);
  const holdState = props.holdOverride ?? state.holds[conversation.id];
  const pendingHere = conversation.held === true && holdState === undefined;
  const messages: readonly FamMessage[] = [
    ...(FAM_MESSAGES[conversation.id] ?? []),
    ...(state.extra[conversation.id] ?? []),
  ];
  const needsYou = pendingHolds(state.holds);
  const recent = FAM_CONVERSATIONS.filter(
    (candidate) =>
      !(candidate.held && !state.holds[candidate.id]) &&
      (state.recentAll || candidate.familiarId === familiar.id),
  );
  const recentEmpty = props.demoEmpty === 'conversations' || recent.length === 0;
  const trigger = matchTrigger(familiar.id, state.draft);
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
    const familiarId = conversationById(conversationId)?.familiarId ?? '';

    if (!text) {
      return;
    }
    const at = clockLabel();
    const crossed = matchTrigger(familiarId, text);

    dispatch({ type: 'send', conversationId, message: { kind: 'user', time: at, text } });
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
              : 'On it. I’ll keep everything inside notes/ and log each step to the ledger.',
          },
        });
      }, REPLY_DELAY),
    );
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
      const active = conversationById(current.conversationId);
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

  function openFamiliarCard(event: ReactMouseEvent<HTMLButtonElement>) {
    const root = rootRef.current;

    if (!root) {
      return;
    }
    const rootBox = root.getBoundingClientRect();
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(box.left - rootBox.left, rootBox.width - 320));
    const y = Math.max(0, Math.min(box.bottom - rootBox.top + 8, rootBox.height - 260));

    patch({ famCard: { x, y } });
  }

  function openSlash() {
    patch({ slashOpen: true, draft: '/' });
    composerRef.current?.focus();
  }

  function pickCommand(name: string) {
    patch({ draft: `${name} `, slashOpen: false });
    composerRef.current?.focus();
  }

  function onComposerKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const first = commands[0];

    if (event.key === 'Tab' && slashOpen && first) {
      event.preventDefault();
      pickCommand(first.name);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (slashOpen && first && /^\/\S*$/.test(state.draft)) {
        pickCommand(first.name);
      } else {
        send();
      }
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

  const rows = Math.min(
    8,
    Math.max(2, state.draft.split('\n').length + (state.draft.length > 90 ? 1 : 0)),
  );
  const ready = state.draft.trim().length > 0;
  const lightboxMessage = state.lightbox === null ? undefined : messages[state.lightbox];
  const lightbox =
    lightboxMessage?.kind === 'image' && lightboxMessage.plot ? lightboxMessage : null;
  const searchQuery = state.searchQuery.trim().toLowerCase();
  const searchResults = FAM_CONVERSATIONS.filter((candidate) => {
    const owner = familiarById(candidate.familiarId);

    return (
      !searchQuery ||
      [candidate.title, candidate.preview, owner?.name ?? '']
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
              <div role="listbox" aria-label="Familiar switcher" className="fr-switcher-menu">
                {MOCK_FAMILIARS.map((candidate) => {
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
                        const first = FAM_CONVERSATIONS.find(
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
          </div>
          <div className="fr-thread-header-actions">
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
                holdState={holdState}
                decidedAt={state.decidedAt || '10:54 PM'}
                onApprove={() => decide('approved')}
                onDecline={() => decide('declined')}
                onOpenFamiliar={openFamiliarCard}
                onOpenImage={(position) => patch({ lightbox: position })}
              />
            ))}
            {state.thinking ? <ThinkingRow familiar={familiar} /> : null}
          </div>
        </div>

        <div className="fr-composer-wrap">
          <div className="fr-composer-inner">
            {slashOpen && commands.length > 0 ? (
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
            <div className={cx('fr-composer', trigger && 'fr-composer--warn')}>
              <div className="fr-composer-bar">
                <FamIconButton icon="paperclip" size="sm" label="Attach file" title="Attach" />
                <FamIconButton
                  icon="terminal-window"
                  size="sm"
                  label="Commands"
                  title="Commands  /"
                  onClick={openSlash}
                />
                <label htmlFor="fr-composer" className="fr-composer-label">
                  Message {familiar.name}
                </label>
                <span className="fr-spacer" />
                {trigger ? (
                  <button
                    type="button"
                    className="fr-hold-warn"
                    title={`“${trigger.action}” is in ${familiar.name}’s must-ask tier`}
                    onClick={goAccess}
                  >
                    <span className="fr-dot" aria-hidden="true" />
                    Held for approval
                  </button>
                ) : null}
              </div>
              <div className="fr-composer-row">
                <textarea
                  id="fr-composer"
                  ref={composerRef}
                  className="fr-textarea"
                  value={state.draft}
                  rows={rows}
                  placeholder="Type a message, or / for commands."
                  aria-label="Message"
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                    patch({ draft: event.target.value, slashOpen: false })
                  }
                  onKeyDown={onComposerKey}
                />
                <button
                  type="button"
                  className={cx('fr-send', ready && 'fr-send--ready')}
                  aria-label="Send"
                  title="Send  ⏎ · newline  ⇧⏎"
                  disabled={!ready}
                  onClick={send}
                >
                  <Icon name="paper-plane-right" size={14} />
                </button>
              </div>
            </div>
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
          demoEmpty={props.demoEmpty}
        />
      </aside>

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
                const owner = familiarById(result.familiarId);
                const dot =
                  result.held && !state.holds[result.id] ? 'warn' : result.failed ? 'danger' : null;

                return (
                  <button
                    key={result.id}
                    type="button"
                    className="fr-search-result"
                    aria-current={index === 0 || undefined}
                    onClick={() => selectConversation(result.id)}
                  >
                    <Avatar initial={owner?.name[0] ?? '?'} size={24} elevated />
                    <span className="fr-search-result-copy">
                      <span className="fr-search-result-head">
                        {dot ? (
                          <span className={cx('fr-dot', `fr-dot--${dot}`)} aria-hidden="true" />
                        ) : null}
                        <span className="fr-search-result-title">{result.title}</span>
                      </span>
                      <span className="fr-search-result-preview">
                        {owner?.name} · {result.preview}
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
            aria-label={`About ${familiar.name}`}
            className="fr-popover"
            style={
              { '--x': `${state.famCard.x}px`, '--y': `${state.famCard.y}px` } as CSSProperties
            }
          >
            <div className="fr-popover-head">
              <Avatar
                initial={familiar.name[0] ?? '?'}
                size={36}
                presence={familiar.status}
                live
                ring
                elevated
                dot={12}
                surface="elevated"
              />
              <span className="fr-popover-copy">
                <span className="fr-popover-name">{familiar.name}</span>
                <span className="fr-popover-role">
                  {familiar.role} · {familiar.creature} · {familiar.pronouns}
                </span>
              </span>
            </div>
            <p className="fr-popover-purpose">{familiar.soul.purpose}</p>
            <div className="fr-popover-stats">
              <div className="fr-popover-stat">
                <span className="fr-fact-label">May act</span>
                <span className="fr-popover-stat-value fr-accent">
                  {familiar.ward.approvalTiers.auto.length}
                </span>
              </div>
              <div className="fr-popover-stat">
                <span className="fr-fact-label">Must ask</span>
                <span className="fr-popover-stat-value fr-warn">
                  {familiar.ward.approvalTiers.humanReview.length}
                </span>
              </div>
              <div className="fr-popover-stat">
                <span className="fr-fact-label">Status</span>
                <span className="fr-popover-stat-value fr-capitalize">{familiar.status}</span>
              </div>
            </div>
            <div className="fr-popover-foot">
              <code className="fr-mono fr-small fr-muted">ward.toml {familiar.ward.version}</code>
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
  active,
  preview,
  onSelect,
}: {
  conversation: FamConversation;
  active: boolean;
  preview: string;
  onSelect: (id: string) => void;
}) {
  const owner = familiarById(conversation.familiarId);

  return (
    <button
      type="button"
      className="fr-conv"
      aria-current={active || undefined}
      onClick={() => onSelect(conversation.id)}
    >
      <Avatar initial={owner?.name[0] ?? '?'} size={24} />
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
            {owner?.name} · {preview}
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
