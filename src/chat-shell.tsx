import type {
  CaveCanonicalFamiliar,
  CaveConversation,
  CaveConversationMessage,
  CaveProject,
} from '@opencoven/cave-client/managed';
import type { Page } from '@opencoven/sdk-core/browser';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { QueryAdapter, QueryResult } from './lib/sdk/query-adapter';

type WithId = Readonly<{ id: string }>;

type ResourceState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'not_ready' }
  | { status: 'reconcile_required' }
  | { status: 'error'; code: string }
  | { status: 'ready'; data: T };

type ListResourceState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'not_ready' }
  | { status: 'reconcile_required' }
  | { status: 'error'; code: string }
  | { status: 'ready'; items: readonly T[]; cursor: string | undefined; hasMore: boolean };

type LoadMoreState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'reconcile_required' }
  | { status: 'error'; code: string };

type RepairableState = Readonly<{ status: string; code?: string }>;

type ChatShellProps = Readonly<{
  queryAdapter: QueryAdapter;
  onReconcile?: () => void;
  onForgetCredential?: () => void;
}>;

type StatusAction = Readonly<{
  label: string;
  onClick: () => void;
}>;

const AUTH_REPAIR_CODES = new Set([
  'unauthorized',
  'credential_unavailable',
  'credential_update_in_progress',
]);

function toListState<T>(result: QueryResult<Page<T>>): ListResourceState<T> {
  switch (result.status) {
    case 'not_ready':
      return { status: 'not_ready' };
    case 'loading':
      return { status: 'loading' };
    case 'reconcile_required':
      return { status: 'reconcile_required' };
    case 'error':
      return { status: 'error', code: result.code };
    case 'stale':
      return { status: 'loading' };
    case 'ok':
      return {
        status: 'ready',
        items: result.data.data,
        cursor: result.data.cursor?.next,
        hasMore: result.data.cursor?.hasMore ?? false,
      };
  }
}

function mergeListState<T extends WithId>(
  previous: ListResourceState<T>,
  page: Page<T>,
): ListResourceState<T> {
  const previousItems = previous.status === 'ready' ? previous.items : [];
  const merged = new Map<string, T>();
  for (const item of previousItems) {
    merged.set(item.id, item);
  }
  for (const item of page.data) {
    merged.set(item.id, item);
  }

  return {
    status: 'ready',
    items: [...merged.values()],
    cursor: page.cursor?.next,
    hasMore: page.cursor?.hasMore ?? false,
  };
}

function itemState<T>(result: QueryResult<T>): ResourceState<T> {
  switch (result.status) {
    case 'not_ready':
      return { status: 'not_ready' };
    case 'loading':
      return { status: 'loading' };
    case 'reconcile_required':
      return { status: 'reconcile_required' };
    case 'error':
      return { status: 'error', code: result.code };
    case 'stale':
      return { status: 'loading' };
    case 'ok':
      return { status: 'ready', data: result.data };
  }
}

function titleForConversation(conversation: Pick<CaveConversation, 'id' | 'title'>): string {
  return conversation.title?.trim() || `Conversation ${conversation.id.slice(0, 8)}`;
}

function formatTimestamp(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return 'Unknown time';
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return 'Unknown time';
  }

  return timestamp.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatError(code: string): string {
  switch (code) {
    case 'scope_denied':
      return 'Cave denied the chat:read scope for this installation.';
    case 'unauthorized':
      return 'Cave access is no longer authorized for this installation.';
    case 'credential_unavailable':
      return 'Cave access is unavailable and needs to be repaired.';
    case 'credential_update_in_progress':
      return 'Cave is still updating access for this installation.';
    case 'service_unavailable':
      return 'Cave is currently unavailable.';
    default:
      return `Cave returned ${code.replaceAll('_', ' ')}.`;
  }
}

function repairAction(
  states: readonly RepairableState[],
  callbacks: Readonly<{
    onForgetCredential: (() => void) | undefined;
    onReconcile: (() => void) | undefined;
  }>,
): StatusAction | undefined {
  if (
    states.some((state) => state.status === 'error' && state.code === 'scope_denied') &&
    callbacks.onForgetCredential !== undefined
  ) {
    return {
      label: 'Forget access',
      onClick: callbacks.onForgetCredential,
    };
  }

  if (
    (states.some((state) => state.status === 'reconcile_required') ||
      states.some(
        (state) => state.status === 'error' && AUTH_REPAIR_CODES.has(state.code ?? ''),
      )) &&
    callbacks.onReconcile !== undefined
  ) {
    return {
      label: 'Repair Cave access',
      onClick: callbacks.onReconcile,
    };
  }

  return undefined;
}

function statusPanel(message: string, role: 'alert' | 'status' = 'status', action?: StatusAction) {
  return (
    <div className="chat-shell__status-panel" role={role} aria-live="polite">
      <p>{message}</p>
      {action !== undefined ? (
        <button className="chat-shell__status-action" type="button" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function loadMoreButton(label: string, onClick: () => void, disabled: boolean) {
  return (
    <button
      className="chat-shell__load-more"
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      {disabled ? 'Loading…' : label}
    </button>
  );
}

export function ChatShell({ queryAdapter, onReconcile, onForgetCredential }: ChatShellProps) {
  const [familiarsState, setFamiliarsState] = useState<ListResourceState<CaveCanonicalFamiliar>>({
    status: 'idle',
  });
  const [familiarsLoadMore, setFamiliarsLoadMore] = useState<LoadMoreState>({ status: 'idle' });
  const [projectsState, setProjectsState] = useState<ListResourceState<CaveProject>>({
    status: 'idle',
  });
  const [projectsLoadMore, setProjectsLoadMore] = useState<LoadMoreState>({ status: 'idle' });
  const [conversationsState, setConversationsState] = useState<ListResourceState<CaveConversation>>(
    { status: 'idle' },
  );
  const [conversationsLoadMore, setConversationsLoadMore] = useState<LoadMoreState>({
    status: 'idle',
  });
  const [conversationState, setConversationState] = useState<ResourceState<CaveConversation>>({
    status: 'idle',
  });
  const [messagesState, setMessagesState] = useState<ListResourceState<CaveConversationMessage>>({
    status: 'idle',
  });
  const [messagesLoadMore, setMessagesLoadMore] = useState<LoadMoreState>({ status: 'idle' });
  const [selectedFamiliarId, setSelectedFamiliarId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const threadHeadingRef = useRef<HTMLHeadingElement>(null);
  const shellRequestRef = useRef(0);
  const threadRequestRef = useRef(0);

  useEffect(() => {
    let active = true;
    shellRequestRef.current += 1;
    const requestId = shellRequestRef.current;

    async function loadShell() {
      setFamiliarsState({ status: 'loading' });
      setProjectsState({ status: 'loading' });
      setConversationsState({ status: 'loading' });
      setFamiliarsLoadMore({ status: 'idle' });
      setProjectsLoadMore({ status: 'idle' });
      setConversationsLoadMore({ status: 'idle' });

      const [familiarsResult, projectsResult, conversationsResult] = await Promise.all([
        queryAdapter.listFamiliars(),
        queryAdapter.listProjects(),
        queryAdapter.listConversations(),
      ]);
      if (
        !active ||
        requestId !== shellRequestRef.current ||
        familiarsResult.status === 'stale' ||
        projectsResult.status === 'stale' ||
        conversationsResult.status === 'stale'
      ) {
        return;
      }
      setFamiliarsState(toListState(familiarsResult));
      setProjectsState(toListState(projectsResult));
      setConversationsState(toListState(conversationsResult));
    }

    void loadShell();

    return () => {
      active = false;
    };
  }, [queryAdapter]);

  function loadMoreFamiliars() {
    if (familiarsState.status !== 'ready' || !familiarsState.hasMore) {
      return;
    }
    const cursor = familiarsState.cursor;
    if (cursor === undefined || familiarsLoadMore.status === 'loading') {
      return;
    }

    const requestId = shellRequestRef.current;
    setFamiliarsLoadMore({ status: 'loading' });

    void queryAdapter.listFamiliars({ cursor }).then((result) => {
      if (requestId !== shellRequestRef.current) {
        return;
      }
      if (result.status === 'stale') {
        setFamiliarsLoadMore({ status: 'idle' });
        return;
      }
      if (result.status === 'ok') {
        setFamiliarsLoadMore({ status: 'idle' });
        setFamiliarsState((previous) => mergeListState(previous, result.data));
        return;
      }
      if (result.status === 'reconcile_required') {
        setFamiliarsLoadMore({ status: 'reconcile_required' });
        return;
      }
      if (result.status === 'error') {
        setFamiliarsLoadMore({ status: 'error', code: result.code });
        return;
      }
      setFamiliarsLoadMore({ status: 'idle' });
    });
  }

  function loadMoreProjects() {
    if (projectsState.status !== 'ready' || !projectsState.hasMore) {
      return;
    }
    const cursor = projectsState.cursor;
    if (cursor === undefined || projectsLoadMore.status === 'loading') {
      return;
    }

    const requestId = shellRequestRef.current;
    setProjectsLoadMore({ status: 'loading' });

    void queryAdapter.listProjects({ cursor }).then((result) => {
      if (requestId !== shellRequestRef.current) {
        return;
      }
      if (result.status === 'stale') {
        setProjectsLoadMore({ status: 'idle' });
        return;
      }
      if (result.status === 'ok') {
        setProjectsLoadMore({ status: 'idle' });
        setProjectsState((previous) => mergeListState(previous, result.data));
        return;
      }
      if (result.status === 'reconcile_required') {
        setProjectsLoadMore({ status: 'reconcile_required' });
        return;
      }
      if (result.status === 'error') {
        setProjectsLoadMore({ status: 'error', code: result.code });
        return;
      }
      setProjectsLoadMore({ status: 'idle' });
    });
  }

  function loadMoreConversations() {
    if (conversationsState.status !== 'ready' || !conversationsState.hasMore) {
      return;
    }
    const cursor = conversationsState.cursor;
    if (cursor === undefined || conversationsLoadMore.status === 'loading') {
      return;
    }

    const requestId = shellRequestRef.current;
    setConversationsLoadMore({ status: 'loading' });

    void queryAdapter.listConversations({ cursor }).then((result) => {
      if (requestId !== shellRequestRef.current) {
        return;
      }
      if (result.status === 'stale') {
        setConversationsLoadMore({ status: 'idle' });
        return;
      }
      if (result.status === 'ok') {
        setConversationsLoadMore({ status: 'idle' });
        setConversationsState((previous) => mergeListState(previous, result.data));
        return;
      }
      if (result.status === 'reconcile_required') {
        setConversationsLoadMore({ status: 'reconcile_required' });
        return;
      }
      if (result.status === 'error') {
        setConversationsLoadMore({ status: 'error', code: result.code });
        return;
      }
      setConversationsLoadMore({ status: 'idle' });
    });
  }

  function loadMoreMessages() {
    if (messagesState.status !== 'ready' || !messagesState.hasMore) {
      return;
    }
    const cursor = messagesState.cursor;
    if (
      cursor === undefined ||
      messagesLoadMore.status === 'loading' ||
      selectedConversationId === null
    ) {
      return;
    }

    const conversationId = selectedConversationId;
    const requestId = threadRequestRef.current;
    setMessagesLoadMore({ status: 'loading' });

    void queryAdapter.listMessages(conversationId, { cursor }).then((result) => {
      if (requestId !== threadRequestRef.current) {
        return;
      }
      if (result.status === 'stale') {
        setMessagesLoadMore({ status: 'idle' });
        return;
      }
      if (result.status === 'ok') {
        setMessagesLoadMore({ status: 'idle' });
        setMessagesState((previous) => mergeListState(previous, result.data));
        return;
      }
      if (result.status === 'reconcile_required') {
        setMessagesLoadMore({ status: 'reconcile_required' });
        return;
      }
      if (result.status === 'error') {
        setMessagesLoadMore({ status: 'error', code: result.code });
        return;
      }
      setMessagesLoadMore({ status: 'idle' });
    });
  }

  const familiars = familiarsState.status === 'ready' ? familiarsState.items : [];
  const projects = projectsState.status === 'ready' ? projectsState.items : [];
  const allConversations = conversationsState.status === 'ready' ? conversationsState.items : [];

  useEffect(() => {
    if (familiars.length === 0) {
      setSelectedFamiliarId(null);
      return;
    }

    setSelectedFamiliarId((current) =>
      current !== null && familiars.some((familiar) => familiar.id === current)
        ? current
        : (familiars[0]?.id ?? null),
    );
  }, [familiars]);

  const filteredConversations = useMemo(() => {
    if (selectedFamiliarId === null) {
      return [];
    }
    return allConversations.filter(
      (conversation) => conversation.familiarId === selectedFamiliarId,
    );
  }, [allConversations, selectedFamiliarId]);

  const selectedConversation = useMemo(
    () =>
      filteredConversations.find((conversation) => conversation.id === selectedConversationId) ??
      null,
    [filteredConversations, selectedConversationId],
  );

  const currentFamiliar = useMemo(
    () => familiars.find((familiar) => familiar.id === selectedFamiliarId) ?? null,
    [familiars, selectedFamiliarId],
  );

  useEffect(() => {
    if (filteredConversations.length === 0) {
      setSelectedConversationId(null);
      return;
    }

    setSelectedConversationId((current) =>
      current !== null && filteredConversations.some((conversation) => conversation.id === current)
        ? current
        : (filteredConversations[0]?.id ?? null),
    );
  }, [filteredConversations]);

  useEffect(() => {
    let active = true;
    threadRequestRef.current += 1;
    const requestId = threadRequestRef.current;

    setMessagesLoadMore({ status: 'idle' });

    if (selectedConversationId === null) {
      setConversationState({ status: 'idle' });
      setMessagesState({ status: 'idle' });
      return () => {
        active = false;
      };
    }

    const conversationId = selectedConversationId;

    async function loadThread() {
      setConversationState({ status: 'loading' });
      setMessagesState({ status: 'loading' });

      const [conversationResult, messagesResult] = await Promise.all([
        queryAdapter.getConversation(conversationId),
        queryAdapter.listMessages(conversationId),
      ]);
      if (
        !active ||
        requestId !== threadRequestRef.current ||
        conversationResult.status === 'stale' ||
        messagesResult.status === 'stale'
      ) {
        return;
      }
      setConversationState(itemState(conversationResult));
      setMessagesState(toListState(messagesResult));
    }

    void loadThread();

    return () => {
      active = false;
    };
  }, [queryAdapter, selectedConversationId]);

  useEffect(() => {
    if (selectedConversationId === null || conversationState.status !== 'ready') {
      return;
    }
    threadHeadingRef.current?.focus();
  }, [conversationState, selectedConversationId]);

  function renderConversationList() {
    const action = repairAction([familiarsState, conversationsState, conversationsLoadMore], {
      onForgetCredential,
      onReconcile,
    });

    if (conversationsState.status === 'loading' || familiarsState.status === 'loading') {
      return statusPanel('Loading conversations…');
    }
    if (
      familiarsState.status === 'reconcile_required' ||
      conversationsState.status === 'reconcile_required'
    ) {
      return statusPanel('Cave access needs to be repaired in the desktop app.', 'alert', action);
    }
    if (familiarsState.status === 'error') {
      return statusPanel(formatError(familiarsState.code), 'alert', action);
    }
    if (conversationsState.status === 'error') {
      return statusPanel(formatError(conversationsState.code), 'alert', action);
    }
    if (familiarsState.status === 'ready' && familiars.length === 0 && !familiarsState.hasMore) {
      return statusPanel('No familiars are available yet.');
    }
    if (conversationsState.status !== 'ready') {
      return statusPanel('No conversations available for the selected familiar.');
    }

    const hasMore = conversationsState.hasMore;
    const loadMoreAction =
      conversationsLoadMore.status === 'reconcile_required'
        ? statusPanel('Cave access needs to be repaired in the desktop app.', 'alert', action)
        : conversationsLoadMore.status === 'error'
          ? statusPanel(formatError(conversationsLoadMore.code), 'alert', action)
          : null;

    if (filteredConversations.length === 0) {
      if (hasMore) {
        return (
          <>
            {statusPanel('More conversations are available. Load more to keep browsing.')}
            {loadMoreAction}
            {loadMoreButton(
              'Load more conversations',
              loadMoreConversations,
              conversationsLoadMore.status === 'loading',
            )}
          </>
        );
      }
      return statusPanel('No conversations available for the selected familiar.');
    }

    return (
      <div className="chat-shell__conversation-list-wrapper">
        <div className="chat-shell__conversation-list" role="listbox" aria-label="Conversations">
          {filteredConversations.map((conversation) => {
            const selected = conversation.id === selectedConversationId;
            return (
              <button
                key={conversation.id}
                className="chat-shell__conversation"
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setSelectedConversationId(conversation.id);
                }}
              >
                <span className="chat-shell__conversation-title">
                  {titleForConversation(conversation)}
                </span>
                <span className="chat-shell__conversation-meta">
                  {conversation.status ?? 'Updated'} · {formatTimestamp(conversation.updatedAt)}
                </span>
              </button>
            );
          })}
        </div>
        {loadMoreAction}
        {hasMore
          ? loadMoreButton(
              'Load more conversations',
              loadMoreConversations,
              conversationsLoadMore.status === 'loading',
            )
          : null}
      </div>
    );
  }

  function renderProjects() {
    const action = repairAction([projectsState, projectsLoadMore], {
      onForgetCredential,
      onReconcile,
    });

    if (projectsState.status === 'loading') {
      return statusPanel('Loading projects…');
    }
    if (projectsState.status === 'reconcile_required') {
      return statusPanel('Projects require Cave access repair.', 'alert', action);
    }
    if (projectsState.status === 'error') {
      return statusPanel(formatError(projectsState.code), 'alert', action);
    }
    if (projectsState.status !== 'ready') {
      return statusPanel('No projects loaded.');
    }

    const hasMore = projectsState.hasMore;
    const loadMoreAction =
      projectsLoadMore.status === 'reconcile_required'
        ? statusPanel('Projects require Cave access repair.', 'alert', action)
        : projectsLoadMore.status === 'error'
          ? statusPanel(formatError(projectsLoadMore.code), 'alert', action)
          : null;

    if (projects.length === 0 && !hasMore) {
      return statusPanel('No projects loaded.');
    }

    return (
      <div className="chat-shell__project-list-wrapper">
        <ul className="chat-shell__project-list" aria-label="Projects">
          {projects.map((project) => (
            <li key={project.id} className="chat-shell__project-pill">
              {project.name}
            </li>
          ))}
        </ul>
        {loadMoreAction}
        {hasMore
          ? loadMoreButton(
              'Load more projects',
              loadMoreProjects,
              projectsLoadMore.status === 'loading',
            )
          : null}
      </div>
    );
  }

  function renderThreadBody() {
    const action = repairAction(
      [familiarsState, conversationsState, conversationState, messagesState, messagesLoadMore],
      {
        onForgetCredential,
        onReconcile,
      },
    );

    if (
      familiarsState.status === 'loading' ||
      conversationsState.status === 'loading' ||
      conversationState.status === 'loading' ||
      messagesState.status === 'loading'
    ) {
      return statusPanel('Loading chat history…');
    }
    if (
      familiarsState.status === 'reconcile_required' ||
      conversationsState.status === 'reconcile_required' ||
      conversationState.status === 'reconcile_required' ||
      messagesState.status === 'reconcile_required'
    ) {
      return statusPanel('Cave access needs to be repaired in the desktop app.', 'alert', action);
    }
    if (familiarsState.status === 'error') {
      return statusPanel(formatError(familiarsState.code), 'alert', action);
    }
    if (conversationsState.status === 'error') {
      return statusPanel(formatError(conversationsState.code), 'alert', action);
    }
    if (conversationState.status === 'error') {
      return statusPanel(formatError(conversationState.code), 'alert', action);
    }
    if (messagesState.status === 'error') {
      return statusPanel(formatError(messagesState.code), 'alert', action);
    }
    if (selectedConversationId === null || selectedConversation === null) {
      return statusPanel('Select a conversation to read the thread.');
    }
    if (messagesState.status !== 'ready') {
      return statusPanel('Select a conversation to read the thread.');
    }

    const hasMore = messagesState.hasMore;
    const loadMoreAction =
      messagesLoadMore.status === 'reconcile_required'
        ? statusPanel('Cave access needs to be repaired in the desktop app.', 'alert', action)
        : messagesLoadMore.status === 'error'
          ? statusPanel(formatError(messagesLoadMore.code), 'alert', action)
          : null;

    if (messagesState.items.length === 0) {
      if (hasMore) {
        return (
          <>
            {statusPanel('More messages are available. Load more to keep reading.')}
            {loadMoreAction}
            {loadMoreButton(
              'Load more messages',
              loadMoreMessages,
              messagesLoadMore.status === 'loading',
            )}
          </>
        );
      }
      return statusPanel('No messages have been stored for this conversation yet.');
    }

    return (
      <div className="chat-shell__message-list-wrapper">
        <ol className="chat-shell__message-list" aria-label="Messages">
          {messagesState.items.map((message) => (
            <li
              key={message.id}
              className={`chat-shell__message chat-shell__message--${message.role}`}
            >
              <article className="chat-shell__message-card">
                <div className="chat-shell__message-header">
                  <span className="chat-shell__message-role">{message.role}</span>
                  <time className="chat-shell__message-time">
                    {formatTimestamp(message.createdAt)}
                  </time>
                </div>
                <p className="chat-shell__message-text">{message.text}</p>
              </article>
            </li>
          ))}
        </ol>
        {loadMoreAction}
        {hasMore
          ? loadMoreButton(
              'Load more messages',
              loadMoreMessages,
              messagesLoadMore.status === 'loading',
            )
          : null}
      </div>
    );
  }

  const threadTitle =
    conversationState.status === 'ready'
      ? titleForConversation(conversationState.data)
      : selectedConversation !== null
        ? titleForConversation(selectedConversation)
        : 'Read-only chat';

  return (
    <div className="chat-shell">
      <aside className="chat-shell__rail" aria-label="Conversation browser">
        <div className="chat-shell__rail-header">
          <label className="chat-shell__switcher">
            <span className="chat-shell__switcher-label">Familiar</span>
            <select
              aria-label="Familiar"
              className="chat-shell__switcher-select"
              disabled={familiars.length === 0}
              value={selectedFamiliarId ?? ''}
              onChange={(event) => {
                setSelectedFamiliarId(event.target.value || null);
              }}
            >
              {familiars.map((familiar) => (
                <option key={familiar.id} value={familiar.id}>
                  {familiar.displayName} — {familiar.role}
                </option>
              ))}
            </select>
          </label>
          {currentFamiliar !== null ? (
            <p className="chat-shell__familiar-meta">
              {currentFamiliar.role}
              {currentFamiliar.status ? ` · ${currentFamiliar.status}` : ''}
            </p>
          ) : null}
          {familiarsState.status === 'ready' && familiarsState.hasMore ? (
            <>
              {familiarsLoadMore.status === 'reconcile_required'
                ? statusPanel(
                    'Cave access needs to be repaired in the desktop app.',
                    'alert',
                    repairAction([familiarsLoadMore], { onForgetCredential, onReconcile }),
                  )
                : null}
              {familiarsLoadMore.status === 'error'
                ? statusPanel(
                    formatError(familiarsLoadMore.code),
                    'alert',
                    repairAction([familiarsLoadMore], { onForgetCredential, onReconcile }),
                  )
                : null}
              {loadMoreButton(
                'Load more familiars',
                loadMoreFamiliars,
                familiarsLoadMore.status === 'loading',
              )}
            </>
          ) : null}
        </div>

        <section className="chat-shell__rail-section">
          <div className="chat-shell__section-heading">
            <h2>Conversations</h2>
            <span className="chat-shell__section-count">{filteredConversations.length}</span>
          </div>
          {renderConversationList()}
        </section>

        <section className="chat-shell__rail-section chat-shell__rail-section--projects">
          <div className="chat-shell__section-heading">
            <h2>Projects</h2>
            <span className="chat-shell__section-count">{projects.length}</span>
          </div>
          {renderProjects()}
        </section>
      </aside>

      <main className="chat-shell__thread">
        <header className="chat-shell__thread-header">
          <div>
            <p className="chat-shell__thread-eyebrow">OpenCoven chat</p>
            <h1 className="chat-shell__thread-title" ref={threadHeadingRef} tabIndex={-1}>
              {threadTitle}
            </h1>
          </div>
          <span className="chat-shell__read-only">Read-only chat</span>
        </header>
        <div className="chat-shell__thread-body">{renderThreadBody()}</div>
      </main>
    </div>
  );
}
