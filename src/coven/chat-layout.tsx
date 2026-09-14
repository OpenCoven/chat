import { type CSSProperties, useEffect, useRef, useState } from 'react';
import {
  cx,
  FamButton,
  FamIconButton,
  INSPECTOR_TABS,
  type InspectorTab,
  Segmented,
  ThinkingIndicator,
  titleCase,
} from '../demo/familiars-ui';
import { Icon } from '../demo/minimal-icons';
import type { ChatLifecycle } from '../lib/coven-runtime';
import { AttachmentChip } from '../ui/attachment-chip';
import { Composer } from '../ui/composer';
import { ATTACHMENT_ACCEPT, type ChatAttachment } from './attachments';
import { ChatLifecycleControls } from './chat-lifecycle';
import type { ChatMessage } from './events';
import { FamiliarAvatar } from './familiar-avatar';
import { FormattedMessage } from './formatted-message';
import { useViewportTier } from './viewport';
import '../demo/familiars-shell.css';
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
  readOnly?: boolean;
  archivedFilter?: boolean;
  selectedArchived?: boolean;
  lifecycleBusy?: boolean;
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

export function ChatLayout(props: ChatLayoutProps) {
  const tier = useViewportTier();
  const [sidebar, setSidebar] = useState(() => tier !== 'compact');
  const [inspector, setInspector] = useState(() => tier === 'wide');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<InspectorTab>('overview');
  const drawers = tier === 'compact';
  const inspectorOverlay = tier !== 'wide';
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
    setSidebar(true);
    if (drawers) setInspector(false);
  }
  function openInspector() {
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
      Boolean(props.sessions.find((session) => session.familiarId === item.id)?.archived) ===
        Boolean(props.archivedFilter),
  );
  return (
    <div
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
          {props.onArchivedFilter && (
            <fieldset className="coven-lifecycle-filter" aria-label="Conversation filter">
              <button
                type="button"
                className="fr-btn fr-btn--secondary"
                aria-pressed={!props.archivedFilter}
                disabled={props.lifecycleBusy}
                onClick={() => props.onArchivedFilter?.(false)}
              >
                Active
              </button>
              <button
                type="button"
                className="fr-btn fr-btn--secondary"
                aria-pressed={Boolean(props.archivedFilter)}
                disabled={props.lifecycleBusy}
                onClick={() => props.onArchivedFilter?.(true)}
              >
                Archived
              </button>
            </fieldset>
          )}
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
          <div className="fr-sidebar-foot">Coven CLI</div>
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
              onClick={() => (sidebar ? setSidebar(false) : openSidebar())}
            />
            <button
              type="button"
              className={cx(
                'fr-rail-handle fr-rail-handle--right',
                !inspector && 'fr-rail-handle--closed',
              )}
              aria-label={inspector ? 'Hide inspector' : 'Show inspector'}
              onClick={() => (inspector ? setInspector(false) : openInspector())}
            />
          </>
        )}
        <header className="fr-thread-header">
          <div className="fr-thread-header-lead">
            {!sidebar ? (
              <FamIconButton icon="sidebar-simple" label="Show familiars" onClick={openSidebar} />
            ) : null}
            <FamiliarAvatar name={name} avatarUrl={familiar?.avatarUrl} size={24} />
            <button
              type="button"
              className="fr-thread-title coven-familiar-card-trigger"
              disabled={!familiar}
              onClick={showFamiliarCard}
              aria-label={`Open ${name}'s familiar card`}
            >
              {name}
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
                Boolean(props.lifecycleBusy)
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
            {!props.messages.length && !props.loading ? (
              <div className="fr-thread-empty">
                <FamiliarAvatar name={name} avatarUrl={familiar?.avatarUrl} size={36} ring />
                <span className="fr-thread-empty-title">{`Chat with ${name}`}</span>
                <span className="fr-empty-text">
                  {props.ready
                    ? 'Start a conversation with Coven. A familiar is optional.'
                    : 'Connect to your local Coven CLI to see real conversations here.'}
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
              <p>This familiar chat is archived. Restore it to continue the conversation.</p>
            )}
            {props.busy && composerDisabled && (
              <FamButton onClick={props.onCancel} disabled={props.cancelling}>
                Stop run
              </FamButton>
            )}
            <fieldset className="coven-composer-fieldset" disabled={composerDisabled}>
              <Composer
                className="coven-compact-composer"
                minRows={1}
                attachmentIcon="plus"
                value={props.draft}
                onValueChange={props.onDraft}
                label={`Message ${name}`}
                placeholder={`Message ${name}`}
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
                      ? 'Reading files...'
                      : 'UTF-8 text/code only · 4 files, 64 KiB each. Unsent files stay in this window until removed or sent.'}
                  </p>
                </>
              ) : null}
            </fieldset>
          </div>
        </div>
      </main>
      <aside
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
            <FamiliarAvatar name={name} avatarUrl={familiar?.avatarUrl} size={22} ring />
            <span className="fr-inspector-who">
              <span className="fr-inspector-name">{name}</span>
              <span className="fr-inspector-kind">
                {familiar ? 'Coven familiar' : 'Local Coven CLI'}
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
                        : 'Chat directly with your local Coven CLI. Selecting a familiar is optional.')}
                  </span>
                </div>
                {familiar ? (
                  <div className="fr-card fr-card--lift fr-rows">
                    <div className="fr-row">
                      <span className="fr-row-label">Identity</span>
                      <code className="fr-row-value">{familiar.id}</code>
                    </div>
                    <div className="fr-row">
                      <span className="fr-row-label">Workspace</span>
                      <span className="fr-row-value">{familiar.workspace || 'Not reported'}</span>
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
