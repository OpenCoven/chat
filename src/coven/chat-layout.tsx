import { type CSSProperties, type RefObject, useEffect, useRef, useState } from 'react';
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
import type { ChatLifecycle } from '../lib/coven-runtime';
import { AttachmentChip } from '../ui/attachment-chip';
import { Composer } from '../ui/composer';
import { ATTACHMENT_ACCEPT, type ChatAttachment } from './attachments';
import { ChatLifecycleControls } from './chat-lifecycle';
import type { ChatMessage } from './events';
import { FamiliarAvatar } from './familiar-avatar';
import { FormattedMessage } from './formatted-message';
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
    avatarUrl?: string | undefined;
  }[];
  sessions: readonly {
    id: string;
    title: string;
    familiarId?: string;
    updatedAt?: string;
    archived?: boolean;
    preview?: string;
  }[];
  messages: readonly ChatMessage[];
  attachments?: readonly ChatAttachment[];
  attaching?: boolean;
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  familiarId: string;
  sessionId: string;
  draft: string;
  status: string;
  ready: boolean;
  /** Real runtime availability. `ready` also demands a live, non-archived selection. */
  connected: boolean;
  readOnly?: boolean;
  archivedFilter?: boolean;
  selectedArchived?: boolean;
  lifecycleBusy?: boolean;
  /** Runtime unavailable: archive/restore/delete must not mutate stale state. */
  lifecycleLocked?: boolean;
  onArchivedFilter?: (archived: boolean) => void;
  onLifecycle?: (next: ChatLifecycle) => void;
  busy: boolean;
  loading: boolean;
  cancelling: boolean;
  error: string;
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
export function emptyThreadText(connected: boolean, familiarName?: string) {
  if (!connected) return 'Connect to your local Coven CLI to see real conversations here.';
  if (!familiarName) return 'Select a familiar from the sidebar to start a conversation.';
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
export function composerCopy(connected: boolean, familiarName?: string) {
  if (!connected)
    return { label: 'Message', placeholder: 'Connect to your local Coven CLI to send a message.' };
  if (!familiarName)
    return { label: 'Message', placeholder: 'Select a familiar to send a message.' };
  return { label: `Message ${familiarName}`, placeholder: `Message ${familiarName}` };
}

function activeControl(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

export function ChatLayout(props: ChatLayoutProps) {
  const tier = useViewportTier();
  const [sidebar, setSidebar] = useState(() => tier !== 'compact');
  const [inspector, setInspector] = useState(() => tier === 'wide');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<InspectorTab>('overview');
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
  const familiar = props.familiars.find((item) => item.id === props.familiarId);
  const session = props.sessions.find((item) => item.id === props.sessionId);
  const name = familiar?.name ?? 'Coven';
  const composer = composerCopy(props.connected, familiar?.name);
  const composerDisabled =
    !props.ready || props.loading || props.cancelling || props.attaching || props.readOnly;
  const transcriptRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nearBottom = useRef(true);
  const previousSession = useRef(props.sessionId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new messages change the transcript's scroll height.
  useEffect(() => {
    if (previousSession.current !== props.sessionId) {
      nearBottom.current = true;
      previousSession.current = props.sessionId;
    }
    const transcript = transcriptRef.current;
    if (transcript && nearBottom.current) transcript.scrollTop = transcript.scrollHeight;
  }, [props.messages, props.sessionId]);
  const agents = props.familiars.filter(
    (item) =>
      item.name.toLowerCase().includes(query.toLowerCase()) &&
      props.sessions.some((session) => session.familiarId === item.id && session.archived) ===
        Boolean(props.archivedFilter),
  );
  return (
    <div
      ref={shellRef}
      className="fr-shell coven-chat"
      data-tier={tier}
      data-sidebar={sidebar ? 'open' : 'closed'}
      data-inspector={inspector ? 'open' : 'closed'}
      style={
        {
          '--coven-sidebar-w': sidebar && !drawers ? '300px' : '0px',
          '--coven-inspector-w': inspector && !inspectorOverlay ? '360px' : '0px',
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
      <aside
        ref={sidebarRef}
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
            onClick={() => setSidebar(false)}
          >
            <span className="fr-rail-toggle-label">Familiars</span>
            <Icon name="sidebar-simple" size={15} />
          </button>
          <label className="coven-agent-search">
            <Icon name="magnifying-glass" size={14} />
            <input
              type="search"
              aria-label="Search familiars"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="fr-conv-scroll">
            <div className="fr-conv-list">
              {agents.map((item) => {
                const thread = props.sessions.find((session) => session.familiarId === item.id);
                return (
                  <button
                    type="button"
                    key={item.id}
                    className="fr-conv coven-agent-row"
                    aria-label={item.name}
                    aria-current={item.id === props.familiarId || undefined}
                    disabled={props.lifecycleBusy}
                    onClick={() => props.onFamiliar(item.id)}
                  >
                    <FamiliarAvatar name={item.name} avatarUrl={item.avatarUrl} size={36} />
                    <span className="coven-agent-copy">
                      <span className="fr-conv-title">{item.name}</span>
                      <span className="fr-conv-preview">
                        {thread?.preview ||
                          (thread ? 'Continue your conversation' : 'Start a conversation')}
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
                  {query
                    ? 'No matching familiars.'
                    : props.archivedFilter
                      ? 'No archived familiars.'
                      : 'No familiars available. Configure a familiar in Coven, then refresh.'}
                </span>
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
            ) : (
              'Coven CLI'
            )}
          </div>
        </div>
      </aside>
      <main className="fr-thread">
        {drawers ? null : (
          <>
            <button
              type="button"
              className={cx(
                'fr-rail-handle fr-rail-handle--left',
                !sidebar && 'fr-rail-handle--closed',
              )}
              aria-label={sidebar ? 'Hide familiars rail' : 'Show familiars rail'}
              data-opens="sidebar"
              onClick={() => (sidebar ? setSidebar(false) : openSidebar())}
            />
            <button
              type="button"
              className={cx(
                'fr-rail-handle fr-rail-handle--right',
                !inspector && 'fr-rail-handle--closed',
              )}
              aria-label={inspector ? 'Hide inspector' : 'Show inspector'}
              data-opens="inspector"
              onClick={() => (inspector ? setInspector(false) : openInspector())}
            />
          </>
        )}
        <header className="fr-thread-header">
          <div className="fr-thread-header-lead">
            {!sidebar ? (
              <FamIconButton
                icon="sidebar-simple"
                label="Show familiars"
                data-opens="sidebar"
                onClick={openSidebar}
              />
            ) : null}
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
              icon="arrow-clockwise"
              label="Refresh Coven"
              disabled={props.busy || props.loading || props.lifecycleBusy}
              onClick={props.onRefresh}
            />
            {!inspector ? (
              <FamIconButton
                icon="sidebar-simple"
                flip
                label="Show inspector"
                aria-controls="coven-familiar-inspector"
                data-opens="inspector"
                onClick={openInspector}
              />
            ) : null}
          </div>
        </header>
        <div
          className="fr-transcript"
          ref={transcriptRef}
          role="log"
          aria-label="Messages"
          aria-busy={props.loading}
          onScroll={(event) => {
            const transcript = event.currentTarget;
            nearBottom.current =
              transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 80;
          }}
        >
          <div className="fr-column">
            {props.status ? <output className="coven-status">{props.status}</output> : null}
            {props.error ? (
              <div className="coven-error" role="alert">
                {props.error}
              </div>
            ) : null}
            {props.loading ? <ThinkingIndicator label="Loading conversation" /> : null}
            {props.messages.map((message) =>
              message.role === 'user' ? (
                <div className="fr-user fr-msg" key={message.id}>
                  <div className="fr-user-body">
                    <div className="fr-bubble fr-bubble--user coven-message">{message.text}</div>
                    {message.attachments?.length ? (
                      <ul className="coven-history-attachments" aria-label="Message attachments">
                        {message.attachments.map((file, index) => (
                          <li key={`${index}-${file.name}`}>
                            <AttachmentChip name={file.name} meta={`${file.size} bytes`} />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="fr-familiar fr-msg" key={message.id}>
                  {message.role === 'assistant' && familiar ? (
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
                      {message.role === 'assistant' && familiar ? (
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
                          {message.role === 'assistant' ? name : titleCase(message.role)}
                        </span>
                      )}
                    </span>
                    <div className="fr-bubble fr-bubble--familiar coven-message">
                      {message.role === 'assistant' ? (
                        <FormattedMessage text={message.text} />
                      ) : (
                        message.text
                      )}
                    </div>
                  </div>
                </div>
              ),
            )}
            {!props.messages.length && !props.loading && !props.busy ? (
              <div className="fr-thread-empty">
                {familiar ? (
                  <FamiliarAvatar name={name} avatarUrl={familiar.avatarUrl} size={36} ring />
                ) : null}
                <span className="fr-thread-empty-title">
                  {familiar ? `Chat with ${name}` : 'No familiar selected'}
                </span>
                <span className="fr-empty-text">
                  {emptyThreadText(props.connected, familiar?.name)}
                </span>
              </div>
            ) : null}
            {props.busy ? (
              <ThinkingIndicator
                label={
                  props.cancelling
                    ? 'Cancellation requested; waiting for the process to stop.'
                    : 'Coven is running. Live output appears here as it arrives.'
                }
              />
            ) : null}
          </div>
        </div>
        <div className="fr-composer-wrap">
          <div className="fr-composer-inner">
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
                className="coven-compact-composer"
                minRows={1}
                attachmentIcon="plus"
                value={props.draft}
                onValueChange={props.onDraft}
                label={composer.label}
                placeholder={composer.placeholder}
                onSend={props.onSend}
                running={props.busy && !composerDisabled}
                onStop={props.onCancel}
                allowAttachmentOnly
                attachments={(props.attachments ?? []).map((file) => ({
                  id: file.id,
                  name: file.name,
                  meta: `${file.bytes.length} bytes`,
                }))}
                {...(props.onAttach && !props.busy && !props.attaching
                  ? { onAttach: () => fileInput.current?.click() }
                  : {})}
                {...(!props.busy && props.onRemoveAttachment
                  ? { onRemoveAttachment: props.onRemoveAttachment }
                  : {})}
              />
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
                  <p className="coven-attachment-note">
                    {props.attaching
                      ? 'Reading files…'
                      : 'Text or code files · up to 4, 64 KiB each. Unsent files stay here until removed or sent.'}
                  </p>
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
                      <code className="fr-row-value coven-row-value--path" title={familiar.id}>
                        {familiar.id}
                      </code>
                    </div>
                    <div className="fr-row">
                      <span className="fr-row-label">Workspace</span>
                      {familiar.workspace ? (
                        <span
                          className="fr-row-value coven-row-value--path"
                          title={familiar.workspace}
                        >
                          {familiar.workspace}
                        </span>
                      ) : (
                        <span className="fr-row-value">Not reported</span>
                      )}
                    </div>
                    <div className="fr-row">
                      <span className="fr-row-label">Conversations</span>
                      <span className="fr-row-value">{props.sessions.length}</span>
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
              <div className="coven-details fr-card fr-card--lift">
                <h2>Access</h2>
                <p>Access rules and approvals are not exposed by this CLI integration.</p>
                <p>
                  Configure your familiar in Coven. This app does not define or enforce an
                  additional permission boundary.
                </p>
                <p>Attachments, screen sharing and tool approval controls are unavailable here.</p>
              </div>
            ) : null}
            {tab === 'activity' ? (
              <div className="coven-details fr-card fr-card--lift">
                <h2>Activity</h2>
                <p>
                  {props.busy ? 'A run is active in this app.' : 'No run is active in this app.'}
                </p>
                <p>{props.messages.length} messages loaded in this conversation.</p>
                <p>Run metrics and tool activity are not exposed by this CLI integration.</p>
              </div>
            ) : null}
          </section>
        </div>
      </aside>
    </div>
  );
}
