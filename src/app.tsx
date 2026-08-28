import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';

import {
  type ConnectionController,
  createConnectionController,
  type SdkConnectionState,
} from './lib/sdk/connection-controller';
import { presentConnectionState, presentErrorCode } from './lib/sdk/diagnostics';
import {
  type CaveConversation,
  type NativeBoundary,
  nativeBoundary,
} from './lib/sdk/native-boundary';
import { createQueryAdapter, type QueryAdapter } from './lib/sdk/query-adapter';

type AppProps = Readonly<{
  nativeHost?: NativeBoundary;
}>;

type Runtime = Readonly<{
  connection: ConnectionController;
  queries: QueryAdapter;
}>;

function createRuntime(host: NativeBoundary): Runtime {
  const connection = createConnectionController(host);
  return {
    connection,
    queries: createQueryAdapter(host, {
      authority: () => connection.getAuthority(),
      onAuthorityFailure: (error) => connection.markAuthorityFailure(error),
    }),
  };
}

function useControllerState(controller: ConnectionController): SdkConnectionState {
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getState(),
  );
}

function connectionDescription(state: SdkConnectionState, nativeAvailable: boolean): string {
  if (!nativeAvailable) {
    return 'The desktop app is required to connect securely. Browser preview cannot provide native trust or credentials.';
  }
  switch (state.state) {
    case 'idle':
      return 'Connect to the local OpenCoven services when you are ready.';
    case 'discovering':
      return 'Looking for the trusted local OpenCoven service.';
    case 'incompatible':
      return 'This Chat build and the local service need compatible versions.';
    case 'pairing_required':
      return 'This device needs your approval before it can read conversations.';
    case 'pairing':
      return 'Approve this device in Cave, then check the approval status here.';
    case 'ready':
      return state.covenAvailable
        ? 'Connected to Cave and Coven.'
        : 'Connected to Cave. Coven availability will appear when its native provider is installed.';
    case 'revoked':
      return 'This device no longer has access. Pair it again to continue.';
    case 'offline':
      return 'The local OpenCoven service is unavailable.';
    case 'error':
      return presentErrorCode(state.code, state.diagnosticId).detail;
  }
}

function ConnectionActions({
  controller,
  state,
  nativeAvailable,
}: {
  controller: ConnectionController;
  state: SdkConnectionState;
  nativeAvailable: boolean;
}) {
  if (!nativeAvailable) {
    return null;
  }
  if (state.state === 'idle') {
    return (
      <button className="primary-action" type="button" onClick={() => void controller.connect()}>
        Connect
      </button>
    );
  }
  if (state.state === 'discovering') {
    return (
      <button className="primary-action" type="button" disabled>
        Connecting…
      </button>
    );
  }
  if (state.state === 'pairing_required') {
    return (
      <>
        <button
          className="primary-action"
          type="button"
          onClick={() => void controller.beginPairing()}
        >
          Request approval
        </button>
        <p className="connection-note">
          Forgetting this device removes its local credential; it does not revoke it on the service.
        </p>
      </>
    );
  }
  if (state.state === 'pairing') {
    return (
      <div className="connection-actions">
        <button
          className="secondary-action"
          type="button"
          onClick={() => void controller.pollApproval()}
        >
          Check approval
        </button>
        <button
          className="primary-action"
          type="button"
          disabled={!controller.canCompletePairing()}
          onClick={() => void controller.completePairing()}
        >
          Complete connection
        </button>
      </div>
    );
  }
  if (state.state === 'ready') {
    return (
      <div className="connection-actions">
        <button
          className="secondary-action"
          type="button"
          onClick={() => void controller.reconnect()}
        >
          Reconnect
        </button>
        <button
          className="text-action"
          type="button"
          onClick={() => void controller.forgetCredential()}
        >
          Forget this device
        </button>
      </div>
    );
  }
  return (
    <div className="connection-actions">
      {controller.canRetry() ? (
        <button className="primary-action" type="button" onClick={() => void controller.retry()}>
          Try again
        </button>
      ) : null}
      <button
        className="secondary-action"
        type="button"
        onClick={() => void controller.reconnect()}
      >
        Reconnect
      </button>
      {state.state === 'revoked' ? (
        <button
          className="text-action"
          type="button"
          onClick={() => void controller.forgetCredential()}
        >
          Pair again
        </button>
      ) : null}
    </div>
  );
}

function QueryStatus({
  status,
  empty,
  error,
}: {
  status: 'idle' | 'loading' | 'ready' | 'error';
  empty: boolean;
  error: string | undefined;
}) {
  if (status === 'loading' && empty) {
    return <p className="query-status">Loading…</p>;
  }
  if (status === 'error') {
    return (
      <p className="query-status query-status--error" role="alert">
        {presentErrorCode(error ?? 'invalid_response', 'query').detail}
      </p>
    );
  }
  if (status === 'ready' && empty) {
    return <p className="query-status">Nothing here yet.</p>;
  }
  return null;
}

function conversationTitle(conversation: CaveConversation): string {
  return conversation.title?.trim() || 'Untitled conversation';
}

function ConnectedWorkspace({
  queries,
  selectedId,
  onSelect,
}: {
  queries: QueryAdapter;
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
}) {
  const [, renderQueryChange] = useReducer((value: number) => value + 1, 0);
  const threadHeading = useRef<HTMLHeadingElement>(null);
  const queryState = queries.getState();
  const conversationState = selectedId === null ? null : queries.getConversationState(selectedId);
  const messageState = selectedId === null ? null : queries.getMessageState(selectedId);

  useEffect(() => queries.subscribe(renderQueryChange), [queries]);
  useEffect(() => {
    if (selectedId !== null && conversationState?.status === 'ready') {
      threadHeading.current?.focus();
    }
  }, [conversationState?.status, selectedId]);

  return (
    <main className="workspace">
      <nav className="panel conversation-panel" aria-label="Conversations">
        <div className="panel-heading">
          <h2>Conversations</h2>
          <span className="count-badge">{queryState.conversations.data.length}</span>
        </div>
        <QueryStatus
          status={queryState.conversations.status}
          empty={queryState.conversations.data.length === 0}
          error={queryState.conversations.code}
        />
        <ul className="conversation-list">
          {queryState.conversations.data.map((conversation) => (
            <li key={conversation.id}>
              <button
                className={
                  conversation.id === selectedId
                    ? 'conversation-link is-active'
                    : 'conversation-link'
                }
                type="button"
                aria-current={conversation.id === selectedId ? 'page' : undefined}
                onClick={() => onSelect(conversation.id)}
              >
                <strong>{conversationTitle(conversation)}</strong>
                <span>{conversation.status ?? 'Conversation'}</span>
              </button>
            </li>
          ))}
        </ul>
        {queryState.conversations.hasMore ? (
          <button
            className="secondary-action pagination-action"
            type="button"
            onClick={() => void queries.loadMoreConversations()}
          >
            Load more conversations
          </button>
        ) : null}
      </nav>

      <section className="panel transcript-panel" aria-labelledby="conversation-heading">
        {selectedId === null ? (
          <div className="empty-thread">
            <h2 id="conversation-heading">Choose a conversation</h2>
            <p>Select a conversation to load its details and messages.</p>
          </div>
        ) : (
          <>
            <header className="thread-heading">
              <div>
                <p className="eyebrow">Conversation</p>
                <h2 id="conversation-heading" ref={threadHeading} tabIndex={-1}>
                  {conversationState?.data === null || conversationState?.data === undefined
                    ? 'Loading conversation…'
                    : conversationTitle(conversationState.data)}
                </h2>
              </div>
            </header>
            <QueryStatus
              status={conversationState?.status ?? 'idle'}
              empty={conversationState?.data === null}
              error={conversationState?.code}
            />
            <div className="message-list" role="log" aria-label="Messages" aria-live="polite">
              <QueryStatus
                status={messageState?.status ?? 'idle'}
                empty={(messageState?.data.length ?? 0) === 0}
                error={messageState?.code}
              />
              {messageState?.data.map((message) => (
                <article className="message" data-role={message.role} key={message.id}>
                  <p className="message-role">{message.role}</p>
                  <p>{message.text}</p>
                  <time dateTime={message.createdAt}>{message.createdAt}</time>
                </article>
              ))}
            </div>
            {messageState?.hasMore ? (
              <button
                className="secondary-action pagination-action"
                type="button"
                onClick={() => void queries.loadMoreMessages(selectedId)}
              >
                Load more messages
              </button>
            ) : null}
          </>
        )}
      </section>

      <aside className="context-column" aria-label="Workspace context">
        <section className="panel compact-panel">
          <div className="panel-heading">
            <h2>Familiars</h2>
            <span className="count-badge">{queryState.familiars.data.length}</span>
          </div>
          <QueryStatus
            status={queryState.familiars.status}
            empty={queryState.familiars.data.length === 0}
            error={queryState.familiars.code}
          />
          <ul className="context-list">
            {queryState.familiars.data.map((familiar) => (
              <li key={familiar.id}>
                <strong>{familiar.displayName}</strong>
                <span>{familiar.role}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel compact-panel">
          <div className="panel-heading">
            <h2>Projects</h2>
            <span className="count-badge">{queryState.projects.data.length}</span>
          </div>
          <QueryStatus
            status={queryState.projects.status}
            empty={queryState.projects.data.length === 0}
            error={queryState.projects.code}
          />
          <ul className="context-list">
            {queryState.projects.data.map((project) => (
              <li key={project.id}>
                <strong>{project.name}</strong>
                <span>{project.root}</span>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </main>
  );
}

export function App({ nativeHost = nativeBoundary }: AppProps) {
  const runtime = useMemo(() => createRuntime(nativeHost), [nativeHost]);
  const connectionState = useControllerState(runtime.connection);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const loadedAuthority = useRef<number | null>(null);
  const nativeAvailable = nativeHost.isAvailable();

  useEffect(() => {
    const deactivate = runtime.connection.activate();
    void runtime.connection.bootstrap();
    return deactivate;
  }, [runtime]);

  useEffect(() => {
    if (connectionState.state !== 'ready') {
      loadedAuthority.current = null;
      setSelectedId(null);
      runtime.queries.invalidateAuthority();
      return;
    }
    const generation = runtime.connection.getAuthority()?.generation ?? null;
    if (generation === null || loadedAuthority.current === generation) {
      return;
    }
    loadedAuthority.current = generation;
    void Promise.all([
      runtime.queries.loadFamiliars(),
      runtime.queries.loadProjects(),
      runtime.queries.loadConversations(),
    ]);
  }, [connectionState.state, runtime]);

  const selectConversation = (conversationId: string) => {
    setSelectedId(conversationId);
    void Promise.all([
      runtime.queries.loadConversation(conversationId),
      runtime.queries.loadMessages(conversationId),
    ]);
  };
  const displayState = presentConnectionState(connectionState.state);
  const failure =
    connectionState.state === 'error'
      ? presentErrorCode(connectionState.code, connectionState.diagnosticId)
      : connectionState.state === 'incompatible'
        ? presentErrorCode('incompatible_version', connectionState.diagnosticId)
        : connectionState.state === 'revoked'
          ? presentErrorCode('unauthorized', connectionState.diagnosticId)
          : connectionState.state === 'offline' && nativeAvailable
            ? presentErrorCode('service_unavailable', connectionState.diagnosticId)
            : null;

  return (
    <div className="app-shell" data-connection-state={connectionState.state}>
      <header className="app-header">
        <p className="eyebrow">Private, local-first conversation</p>
        <h1>OpenCoven Chat</h1>
        <p className="lede">
          Read your familiar conversations through the trusted desktop connection.
        </p>
      </header>

      <section className="panel connection-gate" aria-labelledby="connection-heading">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Connection</p>
            <h2 id="connection-heading">Your local OpenCoven</h2>
          </div>
          <span
            className="state-badge"
            data-connection-state={connectionState.state}
            aria-hidden="true"
          >
            <span className="state-dot" />
            {displayState}
          </span>
        </div>
        <output className="connection-summary" aria-label="Connection state" aria-live="polite">
          <strong>{displayState}.</strong> {connectionDescription(connectionState, nativeAvailable)}
        </output>
        {failure === null ? null : (
          <div className="connection-error" role="alert">
            <strong>{failure.title}</strong>
            <span>{failure.detail}</span>
            <small>Reference: {failure.diagnosticId}</small>
          </div>
        )}
        {connectionState.state === 'pairing' ? (
          <p className="pairing-reference">
            Approval reference <strong>{connectionState.requestId}</strong>
          </p>
        ) : null}
        <ConnectionActions
          controller={runtime.connection}
          state={connectionState}
          nativeAvailable={nativeAvailable}
        />
      </section>

      {connectionState.state === 'ready' ? (
        <ConnectedWorkspace
          queries={runtime.queries}
          selectedId={selectedId}
          onSelect={selectConversation}
        />
      ) : (
        <main className="connection-placeholder">
          <section className="panel">
            <h2>Conversations stay private</h2>
            <p>
              Chat requests only read access. Credentials remain in native secure storage, and
              authenticated responses remain in memory.
            </p>
          </section>
          <section className="panel">
            <h2>No browser fallback</h2>
            <p>Browser preview never invents a trusted service, pairing approval, or credential.</p>
          </section>
        </main>
      )}
    </div>
  );
}
