import { useEffect, useMemo, useState } from 'react';

import { availabilityFor, type ControlName } from './capabilities';
import type {
  Capability,
  ConversationSummary,
  FamiliarActivity,
  FamiliarDetail,
  FamiliarSummary,
  FamiliarsSource,
  Page,
  QueryResult,
  ThreadMessage,
} from './source';

/**
 * The Familiars surface's Stage 1 shell: sidebar, thread, and inspector
 * driven entirely by a `FamiliarsSource`, rendering only what Stage 1
 * (`docs/superpowers/plans/2026-09-02-familiars-integration.md`) can
 * honestly serve.
 *
 * This is deliberately a *different*, smaller component from
 * `src/demo/familiars-shell.tsx`. That shell previews the full design --
 * reasoning cards, held actions, image cards, `@`-mentions, summoning, the
 * screen view -- none of which Cave serves yet. Rebuilding those against
 * `FamiliarsSource` today would mean either inventing data Cave does not
 * send or silently downgrading the shipped demo; neither is honest. Every
 * control this shell cannot back with a real read renders a one-line
 * "not available yet" notice instead, per `./capabilities.ts`, and nothing
 * here is a working mock of a control it does not have data for.
 */

export type FamiliarsReadsShellProps = Readonly<{
  source: FamiliarsSource;
  initialConversationId?: string;
}>;

type InspectorTab = 'overview' | 'access' | 'activity';

const INSPECTOR_TABS: readonly InspectorTab[] = ['overview', 'access', 'activity'];
const NOT_READY: QueryResult<never> = { status: 'not_ready' };

function statusMessage(status: QueryResult<unknown>['status']): string | null {
  switch (status) {
    case 'not_ready':
    case 'loading':
      return 'Loading…';
    case 'stale':
      return 'Updating…';
    case 'reconcile_required':
      return 'Reconnect to Cave to continue.';
    default:
      return null;
  }
}

function ResultStatus({ result, label }: { result: QueryResult<unknown>; label: string }) {
  if (result.status === 'ok') {
    return null;
  }
  if (result.status === 'error') {
    return (
      <p className="frs-status frs-status--error" role="alert">
        Couldn’t load {label} ({result.code}).
      </p>
    );
  }
  const message = statusMessage(result.status);
  return message === null ? null : (
    <p className="frs-status" aria-live="polite">
      {message}
    </p>
  );
}

function CapabilityNotice({
  control,
  capabilities,
  label,
}: {
  control: ControlName;
  capabilities: ReadonlySet<Capability>;
  label: string;
}) {
  const availability = availabilityFor(control, capabilities);
  return availability.enabled ? null : (
    <output className="frs-capability-notice">
      {label}: {availability.reason}
    </output>
  );
}

function formatRelativeTime(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return iso;
  }
  const minutes = Math.round((now.getTime() - then) / 60_000);
  if (minutes < 1) {
    return 'Just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function FamiliarsReadsShell({ source, initialConversationId }: FamiliarsReadsShellProps) {
  const capabilities = useMemo(() => source.capabilities(), [source]);
  const [familiarsResult, setFamiliarsResult] =
    useState<QueryResult<Page<FamiliarSummary>>>(NOT_READY);
  const [conversationsResult, setConversationsResult] =
    useState<QueryResult<Page<ConversationSummary>>>(NOT_READY);
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );
  const [messagesResult, setMessagesResult] = useState<QueryResult<Page<ThreadMessage>>>(NOT_READY);
  const [tab, setTab] = useState<InspectorTab>('overview');
  const [detailResult, setDetailResult] = useState<QueryResult<FamiliarDetail>>(NOT_READY);
  const [activityResult, setActivityResult] = useState<QueryResult<FamiliarActivity>>(NOT_READY);

  useEffect(() => {
    let cancelled = false;
    setFamiliarsResult({ status: 'loading' });
    setConversationsResult({ status: 'loading' });

    void source.familiars().then((result) => {
      if (!cancelled) {
        setFamiliarsResult(result);
      }
    });
    void source.conversations().then((result) => {
      if (cancelled) {
        return;
      }
      setConversationsResult(result);
      if (result.status === 'ok') {
        setConversationId((current) => current ?? result.data.data[0]?.id ?? null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => {
    if (conversationId === null) {
      return;
    }
    let cancelled = false;
    setMessagesResult({ status: 'loading' });
    void source.messages(conversationId).then((result) => {
      if (!cancelled) {
        setMessagesResult(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [source, conversationId]);

  const activeConversation =
    conversationsResult.status === 'ok'
      ? conversationsResult.data.data.find((item) => item.id === conversationId)
      : undefined;
  const activeFamiliarId = activeConversation?.familiarId ?? null;

  useEffect(() => {
    if (activeFamiliarId === null) {
      return;
    }
    let cancelled = false;

    if (tab === 'access' && availabilityFor('access', capabilities).enabled) {
      setDetailResult({ status: 'loading' });
      void source.familiar(activeFamiliarId).then((result) => {
        if (!cancelled) {
          setDetailResult(result);
        }
      });
    }
    if (tab === 'activity' && availabilityFor('activity', capabilities).enabled) {
      setActivityResult({ status: 'loading' });
      void source.activity(activeFamiliarId).then((result) => {
        if (!cancelled) {
          setActivityResult(result);
        }
      });
    }

    return () => {
      cancelled = true;
    };
  }, [source, activeFamiliarId, tab, capabilities]);

  const familiarsById =
    familiarsResult.status === 'ok'
      ? new Map(familiarsResult.data.data.map((item) => [item.id, item]))
      : new Map<string, FamiliarSummary>();
  const activeFamiliar =
    activeFamiliarId === null ? undefined : familiarsById.get(activeFamiliarId);
  const now = new Date();
  const accessAvailability = availabilityFor('access', capabilities);
  const activityAvailability = availabilityFor('activity', capabilities);

  return (
    <div className="frs-shell">
      <aside className="frs-sidebar" aria-label="Conversations sidebar">
        <section aria-label="Familiars">
          <h2 className="frs-heading">Familiars</h2>
          <ResultStatus result={familiarsResult} label="familiars" />
          {familiarsResult.status === 'ok' ? (
            <ul className="frs-familiars-list">
              {familiarsResult.data.data.map((item) => (
                <li key={item.id} className="frs-familiar-row">
                  <span>{item.name}</span>
                  <span className="frs-muted">{item.status}</span>
                </li>
              ))}
              {familiarsResult.data.data.length === 0 ? (
                <li className="frs-status">No familiars yet.</li>
              ) : null}
            </ul>
          ) : null}
        </section>
        <section aria-label="Conversations">
          <h2 className="frs-heading">Conversations</h2>
          <ResultStatus result={conversationsResult} label="conversations" />
          {conversationsResult.status === 'ok' ? (
            <ul className="frs-conv-list">
              {conversationsResult.data.data.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="frs-conv"
                    aria-current={item.id === conversationId || undefined}
                    onClick={() => setConversationId(item.id)}
                  >
                    <span className="frs-conv-title">{item.title ?? item.id}</span>
                    {item.failed ? <span className="frs-conv-flag">failed</span> : null}
                    <span className="frs-conv-time">{formatRelativeTime(item.updatedAt, now)}</span>
                  </button>
                </li>
              ))}
              {conversationsResult.data.data.length === 0 ? (
                <li className="frs-status">No conversations yet.</li>
              ) : null}
            </ul>
          ) : null}
        </section>
      </aside>

      <main className="frs-thread" aria-label="Thread">
        <header className="frs-thread-header">
          <span className="frs-thread-title">
            {activeConversation?.title ?? 'Select a conversation'}
          </span>
          {activeFamiliar ? (
            <span className="frs-thread-familiar">{activeFamiliar.name}</span>
          ) : null}
        </header>
        <div className="frs-transcript">
          <ResultStatus result={messagesResult} label="messages" />
          {messagesResult.status === 'ok' ? (
            <ul className="frs-messages">
              {messagesResult.data.data.map((message) => (
                <li
                  key={message.id}
                  className={`frs-message frs-message--${message.role === 'user' ? 'user' : 'familiar'}`}
                >
                  <span className="frs-message-role">{message.role}</span>
                  <p className="frs-message-text">{message.text}</p>
                </li>
              ))}
              {messagesResult.data.data.length === 0 ? (
                <li className="frs-status">No messages yet.</li>
              ) : null}
            </ul>
          ) : null}
        </div>
        <div className="frs-notices">
          <CapabilityNotice control="composer-send" capabilities={capabilities} label="Sending" />
          <CapabilityNotice control="mentions" capabilities={capabilities} label="@-mentions" />
          <CapabilityNotice
            control="held-actions"
            capabilities={capabilities}
            label="Held actions"
          />
          <CapabilityNotice
            control="reasoning-steps"
            capabilities={capabilities}
            label="Reasoning steps"
          />
          <CapabilityNotice control="image-cards" capabilities={capabilities} label="Images" />
        </div>
      </main>

      <aside className="frs-inspector" aria-label="Familiar inspector">
        <div role="tablist" aria-label="Familiar details" className="frs-tabs">
          {INSPECTOR_TABS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={tab === candidate}
              className="frs-tab"
              onClick={() => setTab(candidate)}
            >
              {candidate}
            </button>
          ))}
        </div>

        {tab === 'overview' ? (
          <div className="frs-inspector-body">
            {activeFamiliar ? (
              <>
                <h3>{activeFamiliar.name}</h3>
                <p>{activeFamiliar.role}</p>
                {activeFamiliar.description ? <p>{activeFamiliar.description}</p> : null}
                {activeFamiliar.pronouns ? (
                  <p className="frs-muted">{activeFamiliar.pronouns}</p>
                ) : null}
                <p className="frs-muted">Status: {activeFamiliar.status}</p>
              </>
            ) : (
              <p className="frs-status">No familiar selected.</p>
            )}
          </div>
        ) : null}

        {tab === 'access' ? (
          <div className="frs-inspector-body">
            <CapabilityNotice control="access" capabilities={capabilities} label="Access" />
            {accessAvailability.enabled ? (
              <>
                <ResultStatus result={detailResult} label="the ward" />
                {detailResult.status === 'ok' ? (
                  <>
                    <section aria-label="May act">
                      <h4>May act ({detailResult.data.ward?.approvalTiers.auto.length ?? 0})</h4>
                      <ul>
                        {(detailResult.data.ward?.approvalTiers.auto ?? []).map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </section>
                    <section aria-label="Must ask">
                      <h4>
                        Must ask ({detailResult.data.ward?.approvalTiers.humanReview.length ?? 0})
                      </h4>
                      <ul>
                        {(detailResult.data.ward?.approvalTiers.humanReview ?? []).map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </section>
                    <p className="frs-muted">
                      Contract: {detailResult.data.report.pass ? 'passing' : 'failing'} (spec{' '}
                      {detailResult.data.report.specVersion})
                    </p>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {tab === 'activity' ? (
          <div className="frs-inspector-body">
            <CapabilityNotice control="activity" capabilities={capabilities} label="Activity" />
            {activityAvailability.enabled ? (
              <>
                <ResultStatus result={activityResult} label="activity" />
                {activityResult.status === 'ok' ? (
                  <>
                    <p>
                      {activityResult.data.completed} of {activityResult.data.attempts} runs
                      completed
                    </p>
                    <p>
                      {activityResult.data.calls} tool calls, {activityResult.data.callFailures}{' '}
                      failed
                    </p>
                    {activityResult.data.medianDurationMs === undefined ? null : (
                      <p>Median duration: {formatDuration(activityResult.data.medianDurationMs)}</p>
                    )}
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        <div className="frs-notices">
          <CapabilityNotice control="summon" capabilities={capabilities} label="Summoning" />
          <CapabilityNotice control="screen" capabilities={capabilities} label="Screen view" />
        </div>
      </aside>
    </div>
  );
}
