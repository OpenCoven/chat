import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ChatLifecycle,
  type CovenFamiliar,
  type CovenRunEvent,
  type CovenRuntime,
  type CovenSession,
  createCovenRuntime,
} from '../lib/coven-runtime';
import { type ChatAttachment, MAX_ATTACHMENTS, readAttachments } from './attachments';
import { ChatLayout } from './chat-layout';
import { projectEvents } from './events';

const defaultRuntime = createCovenRuntime();
const STORAGE_KEY = 'opencoven.chat.navigation.v1';
/** One transcript update per frame keeps long streams smooth. */
const STREAM_FLUSH_MS = 16;
type Navigation = { familiarId: string; sessionId: string; drafts: Record<string, string> };
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function readNavigation(): {
  navigation: Navigation;
  error: string;
  restored: boolean;
  writable: boolean;
} {
  const empty = { familiarId: '', sessionId: '', drafts: {} };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { navigation: empty, error: '', restored: false, writable: true };
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== 'object' ||
      !value ||
      !('familiarId' in value) ||
      typeof value.familiarId !== 'string' ||
      !('sessionId' in value) ||
      typeof value.sessionId !== 'string'
    ) {
      throw new Error('Saved chat navigation is invalid. The saved value has not been deleted.');
    }
    const navigation = { familiarId: value.familiarId, sessionId: value.sessionId, drafts: {} };
    // Drafts are conversation content and never belong in browser storage
    // (SECURITY.md); overwrite any plaintext left behind by earlier builds.
    if ('drafts' in value) writeNavigation(navigation);
    return { navigation, error: '', restored: true, writable: true };
  } catch (error) {
    return {
      navigation: empty,
      error: `Cannot restore saved navigation: ${errorText(error)}`,
      restored: false,
      writable: false,
    };
  }
}
function writeNavigation(navigation: Navigation) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ familiarId: navigation.familiarId, sessionId: navigation.sessionId }),
  );
}
function draftKey(navigation: Navigation) {
  return JSON.stringify([navigation.familiarId, '']);
}

function selectCanonical(
  previous: Navigation,
  familiars: readonly CovenFamiliar[],
  sessions: readonly CovenSession[],
  archived: boolean,
): Navigation {
  const eligible = familiars.filter(
    (familiar) =>
      Boolean(sessions.find((session) => session.familiarId === familiar.id)?.archived) ===
      archived,
  );
  const familiarId = eligible.some((item) => item.id === previous.familiarId)
    ? previous.familiarId
    : (eligible[0]?.id ?? '');
  const head = sessions.find((session) => session.familiarId === familiarId);
  const next = { ...previous, familiarId, sessionId: head?.id ?? '' };
  const key = draftKey(next);
  const oldKey = JSON.stringify([familiarId, next.sessionId]);
  if (
    next.sessionId &&
    previous.sessionId === next.sessionId &&
    next.drafts[key] === undefined &&
    next.drafts[oldKey] !== undefined
  ) {
    next.drafts = { ...next.drafts, [key]: next.drafts[oldKey] ?? '' };
  }
  return next;
}

export function ChatApp({ runtime = defaultRuntime }: { runtime?: CovenRuntime }) {
  const [saved] = useState(readNavigation);
  const [navigation, setNavigation] = useState(saved.navigation);
  const navigationRef = useRef(navigation);
  const [familiars, setFamiliars] = useState<CovenFamiliar[]>([]);
  const [sessions, setSessions] = useState<CovenSession[]>([]);
  const [events, setEvents] = useState<CovenRunEvent[]>([]);
  const [runOutputs, setRunOutputs] = useState<
    Record<string, { events: CovenRunEvent[]; error: string; sessionId: string }>
  >({});
  const [status, setStatus] = useState('Checking local Coven...');
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(saved.error);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [archived, setArchived] = useState(false);
  const archivedRef = useRef(false);
  const [changingLifecycle, setChangingLifecycle] = useState(false);
  const lifecyclePending = useRef<symbol | null>(null);
  const [attachments, setAttachments] = useState<Record<string, ChatAttachment[]>>({});
  const attachmentRef = useRef(attachments);
  const [attaching, setAttaching] = useState(false);
  const selecting = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const lifetime = useRef(0);
  const readId = useRef(0);
  const activeRun = useRef<{ id: string; cancelRequested: boolean } | null>(null);

  function navigate(next: Navigation) {
    navigationRef.current = next;
    setNavigation(next);
    if (!saved.writable) return;
    try {
      writeNavigation(next);
    } catch (failure) {
      setError(`Navigation is only remembered until this window closes: ${errorText(failure)}`);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly restarts CLI discovery.
  useEffect(() => {
    const life = ++lifetime.current;
    activeRun.current = null;
    lifecyclePending.current = null;
    setChangingLifecycle(false);
    setBusy(false);
    setCancelling(false);
    setLoading(true);
    setAvailable(false);
    setEvents([]);
    setRunOutputs({});
    async function start() {
      try {
        const health = await runtime.status();
        if (lifetime.current !== life) return;
        if (!health.available) {
          setStatus(
            health.error ?? 'Install the Coven CLI, then reopen the desktop app and refresh.',
          );
          setFamiliars([]);
          setSessions([]);
          return;
        }
        const [nextFamiliars, nextSessions] = await Promise.all([
          runtime.listFamiliars(),
          runtime.listSessions(),
        ]);
        if (lifetime.current !== life) return;
        setFamiliars(nextFamiliars);
        setSessions(nextSessions);
        setAvailable(true);
        setStatus(`Coven ${health.version ?? 'CLI'} · local sessions`);
        navigate(
          selectCanonical(navigationRef.current, nextFamiliars, nextSessions, archivedRef.current),
        );
      } catch (failure) {
        if (lifetime.current === life) {
          setError(errorText(failure));
          setStatus(
            'Coven could not be loaded. Check your CLI installation and configuration, then refresh.',
          );
        }
      } finally {
        if (lifetime.current === life) setLoading(false);
      }
    }
    void start();
    return () => {
      ++lifetime.current;
      ++readId.current;
      const run = activeRun.current;
      if (run && !run.cancelRequested) {
        run.cancelRequested = true;
        void runtime
          .cancel(run.id)
          .catch((failure: unknown) =>
            console.error('Coven cancellation on close failed:', failure),
          );
      }
    };
  }, [runtime, refresh]);

  useEffect(() => {
    const request = ++readId.current;
    setEvents([]);
    if (!available || !navigation.sessionId) {
      if (available) setLoading(false);
      return;
    }
    setLoading(true);
    void runtime
      .readSession(navigation.sessionId)
      .then((result) => {
        if (readId.current !== request) return;
        setEvents(result.events);
        setRunOutputs((previous) =>
          Object.fromEntries(
            Object.entries(previous).map(([key, output]) => [
              key,
              output.sessionId === result.session.id ? { ...output, events: [] } : output,
            ]),
          ),
        );
        if (result.hasMore)
          setError(
            'Only part of this session is available. Use the Coven CLI to inspect the full history.',
          );
      })
      .catch((failure: unknown) => {
        if (readId.current === request) setError(errorText(failure));
      })
      .finally(() => {
        if (readId.current === request) setLoading(false);
      });
    return () => {
      ++readId.current;
    };
  }, [runtime, available, navigation.sessionId]);

  async function send() {
    const current = navigationRef.current;
    if (lifecyclePending.current) return;
    if (sessions.some((session) => session.id === current.sessionId && session.archived)) {
      setError('Restore this archived chat before sending a message.');
      return;
    }
    if (!current.familiarId) {
      setError('Select a familiar before sending a message.');
      return;
    }
    const key = draftKey(current);
    const prompt = current.drafts[key] ?? '';
    const selectedFiles = attachmentRef.current[key] ?? [];
    if (
      activeRun.current ||
      selecting.current ||
      !available ||
      loading ||
      (!prompt.trim() && !selectedFiles.length)
    )
      return;
    const run = { id: crypto.randomUUID(), cancelRequested: false };
    activeRun.current = run;
    const life = lifetime.current;
    setBusy(true);
    setError('');
    const previousOutput = runOutputs[key]?.events ?? [];
    let streamed: CovenRunEvent[] = [];
    let streamedSession = '';
    let flush: ReturnType<typeof setTimeout> | null = null;
    function publish(nextEvents: CovenRunEvent[], runError = '', sessionId = streamedSession) {
      if (flush) {
        clearTimeout(flush);
        flush = null;
      }
      if (lifetime.current !== life || activeRun.current !== run) return;
      setRunOutputs((previous) => ({
        ...previous,
        [key]: {
          events: [...previousOutput, ...nextEvents],
          error: runError,
          sessionId: sessionId || current.sessionId,
        },
      }));
    }
    publish([]);
    try {
      const result = await runtime.send(
        {
          runId: run.id,
          prompt,
          ...(selectedFiles.length
            ? { attachments: selectedFiles.map(({ name, bytes }) => ({ name, bytes })) }
            : {}),
          ...(current.sessionId ? { sessionId: current.sessionId } : {}),
          ...(current.familiarId ? { familiarId: current.familiarId } : {}),
        },
        (event) => {
          if (lifetime.current !== life || activeRun.current !== run) return;
          // Append in place and publish a snapshot at most once per frame, so
          // a long stream costs O(n) copying per frame rather than per event.
          streamed.push(event);
          if (
            ((event.type === 'system' && event.subtype === 'init') || event.type === 'result') &&
            typeof event.session_id === 'string'
          )
            streamedSession = event.session_id;
          flush ??= setTimeout(() => {
            flush = null;
            publish(streamed.slice());
          }, STREAM_FLUSH_MS);
        },
      );
      if (lifetime.current !== life) return;
      const projected = projectEvents(result.events);
      if (result.events.length) {
        streamed = result.events;
        streamedSession = projected.sessionId;
      }
      publish(streamed.slice(), projected.error);
      if (projected.error) throw new Error(projected.error);
      if (!run.cancelRequested) {
        const sent = new Set(selectedFiles.map((file) => file.id));
        attachmentRef.current = {
          ...attachmentRef.current,
          [key]: (attachmentRef.current[key] ?? []).filter((file) => !sent.has(file.id)),
        };
        setAttachments(attachmentRef.current);
        const latest = navigationRef.current;
        if (latest.drafts[key] === prompt)
          navigate({ ...latest, drafts: { ...latest.drafts, [key]: '' } });
      }
    } catch (failure) {
      publish(streamed.slice(), errorText(failure));
    } finally {
      if (lifetime.current === life) {
        try {
          // Initialization persists the canonical sibling even if the run fails or is cancelled.
          const nextSessions = await runtime.listSessions();
          if (lifetime.current === life) {
            setSessions(nextSessions);
            navigate(
              selectCanonical(navigationRef.current, familiars, nextSessions, archivedRef.current),
            );
          }
        } catch (failure) {
          if (lifetime.current === life) {
            setError(
              `Could not reload this familiar's chat: ${errorText(failure)}. Reopen the familiar before sending again.`,
            );
            setAvailable(false);
          }
        }
      }
      if (activeRun.current === run) activeRun.current = null;
      if (lifetime.current === life) {
        setBusy(false);
        setCancelling(false);
      }
    }
  }

  async function cancel() {
    const run = activeRun.current;
    if (!run || run.cancelRequested) return;
    run.cancelRequested = true;
    const life = lifetime.current;
    setCancelling(true);
    try {
      await runtime.cancel(run.id);
    } catch (failure) {
      if (lifetime.current === life && activeRun.current === run) {
        run.cancelRequested = false;
        setCancelling(false);
        setError(errorText(failure));
      }
    }
  }

  async function attach(files: File[]) {
    if (lifecyclePending.current || selecting.current || activeRun.current || files.length === 0)
      return;
    const key = draftKey(navigationRef.current);
    selecting.current = true;
    setAttaching(true);
    try {
      const existing = attachmentRef.current[key] ?? [];
      if (existing.length + files.length > MAX_ATTACHMENTS)
        throw new Error('Attach at most 4 files per message.');
      const added = await readAttachments(files);
      attachmentRef.current = { ...attachmentRef.current, [key]: [...existing, ...added] };
      setAttachments(attachmentRef.current);
      setError('');
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      selecting.current = false;
      setAttaching(false);
    }
  }

  async function changeLifecycle(next: ChatLifecycle) {
    const current = navigationRef.current;
    if (
      !available ||
      !current.sessionId ||
      lifecyclePending.current ||
      activeRun.current ||
      selecting.current ||
      loading
    )
      return;
    const operation = Symbol('chat-lifecycle');
    lifecyclePending.current = operation;
    setChangingLifecycle(true);
    const life = lifetime.current;
    ++readId.current;
    setError('');
    try {
      await runtime.changeChatLifecycle(current.sessionId, next);
      if (lifetime.current !== life) return;
      const nextSessions =
        next === 'deleted'
          ? sessions.filter((item) => item.id !== current.sessionId)
          : sessions.map((item) =>
              item.id === current.sessionId ? { ...item, archived: next === 'archived' } : item,
            );
      setSessions(nextSessions);
      const latest = navigationRef.current;
      const drafts = { ...latest.drafts };
      const suffix = `,${JSON.stringify(current.sessionId)}]`;
      if (next === 'deleted') {
        delete drafts[draftKey(current)];
        delete attachmentRef.current[draftKey(current)];
        // Canonical draft keys are [familiarId, sessionId] JSON tuples.
        for (const key of Object.keys(drafts)) {
          if (key.endsWith(suffix)) delete drafts[key];
        }
        for (const key of Object.keys(attachmentRef.current)) {
          if (key.endsWith(suffix)) delete attachmentRef.current[key];
        }
        setAttachments({ ...attachmentRef.current });
      }
      // New-chat runs begin under an empty navigation key; their output still belongs to
      // the eventual native session and must not reappear on the now-empty composer.
      setRunOutputs((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(
            ([key, output]) =>
              key !== draftKey(current) &&
              output.sessionId !== current.sessionId &&
              !key.endsWith(suffix),
          ),
        ),
      );
      setEvents([]);
      navigate(
        selectCanonical({ ...latest, drafts }, familiars, nextSessions, archivedRef.current),
      );
    } catch (failure) {
      if (lifetime.current === life) setError(errorText(failure));
    } finally {
      if (lifecyclePending.current === operation) lifecyclePending.current = null;
      if (lifetime.current === life) setChangingLifecycle(false);
    }
  }

  const liveEvents = runOutputs[draftKey(navigation)]?.events;
  const messages = useMemo(
    () => projectEvents(liveEvents ? [...events, ...liveEvents] : events).messages,
    [events, liveEvents],
  );

  return (
    <ChatLayout
      archivedFilter={archived}
      onArchivedFilter={(value) => {
        if (lifecyclePending.current) return;
        archivedRef.current = value;
        setArchived(value);
        navigate(selectCanonical(navigationRef.current, familiars, sessions, value));
      }}
      selectedArchived={sessions.some((item) => item.id === navigation.sessionId && item.archived)}
      readOnly={sessions.some((item) => item.id === navigation.sessionId && item.archived)}
      lifecycleBusy={changingLifecycle}
      // A failed refresh leaves the last known lists visible for context but
      // never mutable: lifecycle stays locked until the runtime is available.
      lifecycleLocked={!available}
      onLifecycle={(next) => void changeLifecycle(next)}
      attachments={attachments[draftKey(navigation)] ?? []}
      attaching={attaching}
      onAttach={(files) => void attach(files)}
      onRemoveAttachment={(id) => {
        if (activeRun.current || selecting.current || lifecyclePending.current) return;
        const key = draftKey(navigationRef.current);
        attachmentRef.current = {
          ...attachmentRef.current,
          [key]: (attachmentRef.current[key] ?? []).filter((file) => file.id !== id),
        };
        setAttachments(attachmentRef.current);
      }}
      familiars={familiars.map((item) => ({
        id: item.id,
        name: item.displayName || item.name,
        description: item.description,
        workspace: item.workspace,
        avatarUrl:
          'avatarUrl' in item && typeof item.avatarUrl === 'string' ? item.avatarUrl : undefined,
      }))}
      sessions={sessions}
      messages={messages}
      familiarId={navigation.familiarId}
      sessionId={navigation.sessionId}
      draft={navigation.drafts[draftKey(navigation)] ?? ''}
      status={
        saved.writable
          ? status
          : `${status}\nSaved navigation could not be restored and is preserved unchanged. Drafts are memory-only until you recover the saved navigation outside this app and reopen this window.`
      }
      ready={
        available &&
        Boolean(navigation.familiarId) &&
        !changingLifecycle &&
        !sessions.some((item) => item.id === navigation.sessionId && item.archived)
      }
      busy={busy}
      loading={loading}
      cancelling={cancelling}
      error={error || runOutputs[draftKey(navigation)]?.error || ''}
      onFamiliar={(id) => {
        if (lifecyclePending.current) return;
        setError('');
        navigate(
          selectCanonical(
            { ...navigationRef.current, familiarId: id },
            familiars,
            sessions,
            archivedRef.current,
          ),
        );
      }}
      onDraft={(value) => {
        if (lifecyclePending.current) return;
        const latest = navigationRef.current;
        navigate({ ...latest, drafts: { ...latest.drafts, [draftKey(latest)]: value } });
      }}
      onSend={() => void send()}
      onCancel={() => void cancel()}
      onRefresh={() => {
        if (!activeRun.current && !lifecyclePending.current) {
          setError('');
          setRefresh((value) => value + 1);
        }
      }}
    />
  );
}
