import type { CaveConversationMessage } from '@opencoven/cave-client/managed';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  type ContinuityMemory,
  createSideReview,
  sideCreationMemory,
  sideReviewMemory,
} from './lib/chat-continuity';
import type { ChatWriter, WriteResult } from './lib/local/chat-writer';
import type { BringBackInput, SideConversation } from './lib/local/side-conversations';
import { createManualPageWalk } from './lib/sdk/manual-page-walk';

type Props = Readonly<{
  conversationId: string;
  messages: readonly CaveConversationMessage[];
  hasMoreMessages: boolean;
  writer: ChatWriter | null;
  isDurable: boolean;
  onNavigate: (id: string) => void;
  onWritten: () => void;
  memory: ContinuityMemory;
  familiarId: string;
  metadataRevision?: number;
}>;

const failureGuidance = {
  read: 'Local side notes could not be read. Retry the read.',
  create:
    'The side note creation result could not be confirmed. Retry with the same operation key.',
  state: 'The note state change could not be confirmed. Refresh the note before retrying.',
  prepare: 'The local review could not be prepared. Retry when the source is available.',
  review:
    'The import result could not be confirmed. Retry the unchanged review with the same operation key.',
};
const MISSING_REVIEW_NOTICE =
  'The exact parent, side note, or selected message is unavailable. This request did not commit an import. Choose available messages, or copy the excerpt before canceling if the note is unavailable.';

function failure(
  result: Exclude<WriteResult<unknown>, { status: 'ok' }>,
  context: keyof typeof failureGuidance,
): string {
  if (result.status === 'unsupported') return result.reason;
  if (result.code === 'conflict' && context === 'review')
    return 'This operation conflicts with its earlier request. Retry the unchanged review to reconcile, or cancel explicitly.';
  if (result.code === 'not_found')
    return 'The exact parent, side note, or selected message is unavailable.';
  return failureGuidance[context];
}

export function ChatSideConversations({
  conversationId,
  messages,
  hasMoreMessages,
  writer,
  isDurable,
  onNavigate,
  onWritten,
  memory,
  familiarId,
  metadataRevision = 0,
}: Props) {
  const capability = writer?.canWrite() ? writer.sideConversations : undefined;
  const [side, setSide] = useState<SideConversation | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [notes, setNotes] = useState<readonly SideConversation[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [notice, setNotice] = useState('');
  const [operationBusy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const emptyReview = useMemo(createSideReview, []);
  const reviewEntry = side
    ? sideReviewMemory(memory, familiarId, side.side.parentConversationId, side.id)
    : emptyReview;
  const {
    selected,
    review,
    phase,
    notice: reviewNotice,
    writes,
  } = useSyncExternalStore(reviewEntry.subscribe, reviewEntry.getSnapshot);
  const creationEntry = sideCreationMemory(memory, familiarId, conversationId);
  const creation = useSyncExternalStore(creationEntry.subscribe, creationEntry.getSnapshot);
  const creationOwner = useRef(creationEntry);
  creationOwner.current = creationEntry;
  const observedCreation = useRef({ creationEntry, writes: creation.writes });
  useEffect(() => {
    const changed =
      observedCreation.current.creationEntry === creationEntry &&
      observedCreation.current.writes !== creation.writes;
    observedCreation.current = { creationEntry, writes: creation.writes };
    if (changed) onWritten();
  }, [creationEntry, creation.writes, onWritten]);
  const busy = operationBusy || creation.pending || phase === 'preparing' || phase === 'sending';
  const observed = useRef({ reviewEntry, writes });
  useEffect(() => {
    const changed =
      observed.current.reviewEntry === reviewEntry && observed.current.writes !== writes;
    observed.current = { reviewEntry, writes };
    if (changed) onWritten();
  }, [reviewEntry, writes, onWritten]);
  const active = useRef(false);
  const pending = useRef(false);
  const walk = useRef(createManualPageWalk());
  const reviewId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt and metadataRevision explicitly refresh this scoped read.
  useEffect(() => {
    active.current = true;
    setReady(false);
    setLoadError('');
    const alive = { value: true };
    if (!capability)
      return () => {
        active.current = false;
      };
    void (async () => {
      try {
        const info = await capability.get(conversationId);
        if (!alive.value) return;
        if (info.status !== 'ok') {
          setLoadError(failure(info, 'read'));
          return;
        }
        setSide(info.data);
        if (!info.data) {
          const page = await capability.list(conversationId);
          if (!alive.value) return;
          if (page.status !== 'ok') {
            setLoadError(failure(page, 'read'));
            return;
          }
          if (!walk.current.acceptRootPage(page.data)) {
            setLoadError('The side note page is invalid. Retry to refresh.');
            return;
          }
          setNotes(page.data.data);
          setCursor(page.data.cursor?.hasMore ? page.data.cursor.next : undefined);
        }
        setReady(true);
      } catch {
        if (alive.value) setLoadError(failureGuidance.read);
      }
    })();
    return () => {
      alive.value = false;
      active.current = false;
    };
  }, [capability, conversationId, loadAttempt, metadataRevision]);

  async function run<T>(
    context: 'read' | 'state',
    operation: () => Promise<WriteResult<T>>,
    success: (data: T) => void,
  ) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice('');
    try {
      const result = await operation();
      if (!active.current) return;
      if (result.status === 'ok') success(result.data);
      else setNotice(failure(result, context));
    } catch {
      if (active.current) setNotice(failureGuidance[context]);
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function startReview() {
    const snapshot = reviewEntry.getSnapshot();
    if (
      !capability ||
      !side ||
      busy ||
      snapshot.phase === 'preparing' ||
      snapshot.phase === 'sending' ||
      (snapshot.review && snapshot.phase !== 'rejected' && snapshot.phase !== 'reselecting')
    )
      return;
    const previous =
      snapshot.phase === 'rejected' || snapshot.phase === 'reselecting' ? snapshot.review : null;
    const source = messages.filter((message) => snapshot.selected.includes(message.id));
    const loadedIds = new Set(source.map((message) => message.id));
    if (
      (!previous || snapshot.phase === 'reselecting') &&
      (snapshot.selected.length === 0 || snapshot.selected.some((id) => !loadedIds.has(id)))
    ) {
      reviewEntry.update({
        notice: snapshot.selected.length
          ? 'Selected messages are not all loaded. Use Load more messages, or clear the selection and select available messages. Your selection and any edited excerpt are retained.'
          : 'Select messages before preparing a review.',
      });
      return;
    }
    const input: BringBackInput = {
      parentConversationId: side.side.parentConversationId,
      sideConversationId: side.id,
      sourceMessageIds:
        snapshot.phase === 'reselecting'
          ? source.map((message) => message.id)
          : (previous?.sourceMessageIds ?? source.map((message) => message.id)),
      excerpt:
        previous?.excerpt ??
        source
          .map((message) => message.text)
          .join('\n\n')
          .slice(0, 32_000),
      operationKey: crypto.randomUUID(),
    };
    reviewEntry.update({ phase: 'preparing', notice: '', selected: input.sourceMessageIds });
    try {
      const result = await capability.prepareBringBack(input);
      if (result.status === 'ok') {
        reviewEntry.update({ review: { ...input, preconditions: result.data }, phase: 'editing' });
      } else if (previous && result.status === 'error' && result.code === 'not_found') {
        reviewEntry.update({ phase: 'unavailable', notice: MISSING_REVIEW_NOTICE });
      } else {
        reviewEntry.update({
          phase: previous ? snapshot.phase : 'idle',
          notice: failure(result, 'prepare'),
        });
      }
    } catch {
      reviewEntry.update({
        phase: previous ? snapshot.phase : 'idle',
        notice: 'The local branch could not be read. No import was attempted.',
      });
    }
  }

  async function submitReview() {
    const snapshot = reviewEntry.getSnapshot();
    const input = snapshot.review;
    if (
      !capability ||
      !input?.excerpt.trim() ||
      (snapshot.phase !== 'editing' && snapshot.phase !== 'uncertain')
    )
      return;
    reviewEntry.update({ phase: 'sending', notice: '' });
    try {
      const result = await capability.bringBack(input);
      if (result.status === 'ok' && result.data.conversationId === input.parentConversationId) {
        reviewEntry.update({
          review: null,
          selected: [],
          phase: 'idle',
          writes: reviewEntry.getSnapshot().writes + 1,
          notice:
            'Reviewed excerpt saved once to the exact local parent. The side note is still retained.',
        });
      } else if (result.status === 'error' && result.code === 'stale_review') {
        reviewEntry.update({
          phase: 'rejected',
          notice:
            'The reviewed local branch changed. This request did not commit. Review again with a fresh operation key before importing.',
        });
      } else if (result.status === 'error' && result.code === 'not_found') {
        reviewEntry.update({ phase: 'unavailable', notice: MISSING_REVIEW_NOTICE });
      } else {
        reviewEntry.update({
          phase: 'uncertain',
          notice:
            result.status === 'ok'
              ? 'The receipt did not match the exact parent. Retry to reconcile.'
              : failure(result, 'review'),
        });
      }
    } catch {
      reviewEntry.update({
        phase: 'uncertain',
        notice: failureGuidance.review,
      });
    }
  }

  if (!capability) {
    return (
      <p className="chat-chapters__notice" role="note">
        Side chats and Bring back are unavailable for this source. No local fallback or Cave writes.
      </p>
    );
  }

  async function create() {
    const snapshot = creationEntry.getSnapshot();
    if (!capability || snapshot.pending) return;
    const operationKey = snapshot.operationKey ?? crypto.randomUUID();
    creationEntry.update({ operationKey, pending: true, notice: '' });
    let result: WriteResult<SideConversation>;
    try {
      result = await capability.create({ parentConversationId: conversationId, operationKey });
    } catch {
      if (creationEntry.getSnapshot().operationKey === operationKey) {
        creationEntry.update({ pending: false, notice: failureGuidance.create });
      }
      return;
    }
    if (creationEntry.getSnapshot().operationKey !== operationKey) return;
    if (result.status !== 'ok') {
      creationEntry.update({ pending: false, notice: failure(result, 'create') });
      return;
    }
    const writes = creationEntry.getSnapshot().writes + 1;
    const current = active.current && creationOwner.current === creationEntry;
    if (current) observedCreation.current = { creationEntry, writes };
    creationEntry.update({
      operationKey: null,
      pending: false,
      writes,
      notice:
        result.data.side.state === 'discarded'
          ? 'This creation request refers to a discarded note.'
          : 'Retained side note creation confirmed. The note is listed under its exact parent.',
    });
    if (current) {
      onWritten();
      if (result.data.side.state !== 'discarded') onNavigate(result.data.id);
    }
  }

  function changeState(state: 'open' | 'closed' | 'discarded') {
    if (!capability || !side) return;
    void run(
      'state',
      () =>
        capability.setState(
          {
            parentConversationId: side.side.parentConversationId,
            sideConversationId: side.id,
          },
          state,
        ),
      (updated) => {
        setSide(updated);
        onWritten();
        if (state !== 'open') onNavigate(updated.side.parentConversationId);
      },
    );
  }

  return (
    <section className="chat-side" aria-label={side ? 'Retained side note' : 'Local side notes'}>
      <p className="chat-chapters__context">
        Local-only notes · No connected familiar · No model replies
      </p>
      <p className="chat-chapters__notice">
        {isDurable
          ? 'Retained on this device. Closing keeps the note; discard removes its local messages.'
          : 'Storage is unavailable. Notes and imports remain in memory only and are lost when the app closes.'}{' '}
        No network, execution, or memory writeback. Not Cave-backed.
      </p>
      {!ready ? (
        <>
          <output role={loadError ? 'alert' : 'status'}>
            {loadError || 'Loading local side notes…'}
          </output>
          {loadError ? (
            <button type="button" onClick={() => setLoadAttempt((value) => value + 1)}>
              Retry local side notes
            </button>
          ) : null}
        </>
      ) : side ? (
        <>
          <div className="chat-side__actions">
            <button type="button" onClick={() => onNavigate(side.side.parentConversationId)}>
              Return to parent
            </button>
            {side.side.state === 'closed' ? (
              <button type="button" onClick={() => changeState('open')} disabled={busy}>
                Reopen note
              </button>
            ) : (
              <button type="button" onClick={() => changeState('closed')} disabled={busy}>
                Close note
              </button>
            )}
            <button
              type="button"
              onClick={() => setDiscarding(true)}
              disabled={busy || review !== null}
            >
              Discard note…
            </button>
          </div>
          {discarding ? (
            <fieldset aria-label="Confirm discard">
              <p>
                Discard this note’s local messages? Reviewed excerpts already brought back stay in
                the parent.
              </p>
              <button type="button" onClick={() => changeState('discarded')} disabled={busy}>
                Discard local messages
              </button>
              <button type="button" onClick={() => setDiscarding(false)} disabled={busy}>
                Keep note
              </button>
            </fieldset>
          ) : null}
          {messages.length ? (
            <fieldset disabled={busy || (review !== null && phase !== 'reselecting')}>
              <legend>Select messages for a reviewed excerpt</legend>
              {messages.map((message, index) => (
                <label className="chat-side__selection" key={message.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(message.id)}
                    onChange={(event) => {
                      reviewEntry.update({
                        selected: event.target.checked
                          ? [...selected, message.id]
                          : selected.filter((id) => id !== message.id),
                      });
                    }}
                  />
                  Message {index + 1}: {message.text.slice(0, 100)}
                </label>
              ))}
              {hasMoreMessages ? (
                <p>Only loaded messages are selectable. Load more in the transcript below.</p>
              ) : null}
              <button
                type="button"
                disabled={selected.length === 0 || selected.length > 50}
                onClick={() => {
                  void startReview();
                }}
              >
                Review Bring back
              </button>
              {selected.length > 0 && (!review || phase === 'reselecting') ? (
                <button
                  type="button"
                  onClick={() =>
                    reviewEntry.update({
                      selected: [],
                      notice: 'Selection cleared. Choose the messages you want to review.',
                    })
                  }
                >
                  Clear message selection
                </button>
              ) : null}
            </fieldset>
          ) : null}
          {review ? (
            <form
              className="chat-side__review"
              onSubmit={(event) => {
                event.preventDefault();
                void submitReview();
              }}
            >
              <label htmlFor={reviewId}>Reviewed excerpt</label>
              <textarea
                id={reviewId}
                value={review.excerpt}
                rows={4}
                maxLength={32_000}
                disabled={busy || phase === 'uncertain' || phase === 'rejected'}
                readOnly={phase === 'unavailable' || phase === 'reselecting'}
                onChange={(event) =>
                  reviewEntry.update({ review: { ...review, excerpt: event.target.value } })
                }
              />
              <p>
                Only this edited text is added as an inert user note to the exact parent. No full
                transcript merge, model reply, or automatic memory writeback.
              </p>
              <p>
                Pending reviews survive navigation in this app session only, not reload or restart.
                Canceling forgets the retry but cannot undo a committed import.
              </p>
              {phase === 'uncertain' ? (
                <p>
                  Retry this unchanged review to reconcile its result before editing or starting
                  another import.
                </p>
              ) : null}
              <div className="chat-side__actions">
                {phase === 'unavailable' ? (
                  <button
                    type="button"
                    onClick={() =>
                      reviewEntry.update({
                        phase: 'reselecting',
                        selected: [],
                        notice:
                          'Select available messages for a new review. Your edited excerpt is retained.',
                      })
                    }
                  >
                    Choose available messages
                  </button>
                ) : null}
                {phase === 'rejected' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void startReview();
                    }}
                  >
                    Review again
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={
                    busy || (phase !== 'editing' && phase !== 'uncertain') || !review.excerpt.trim()
                  }
                >
                  Bring back reviewed excerpt
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    reviewEntry.update({ review: null, phase: 'idle', notice: '', selected: [] })
                  }
                >
                  Cancel review
                </button>
              </div>
            </form>
          ) : null}
        </>
      ) : (
        <>
          <button type="button" onClick={create} disabled={busy}>
            {creation.operationKey ? 'Retry retained side note creation' : 'New retained side note'}
          </button>
          <p className="chat-chapters__notice">
            Pending creations survive navigation in this app session only, not reload or restart.
            After restarting, inspect the retained note list before creating another note; previous
            retry keys are not recovered.
          </p>
          {creation.pending ? <output>Creating retained side note…</output> : null}
          {creation.notice ? <output aria-live="polite">{creation.notice}</output> : null}
          {notes.length ? (
            <ul className="chat-side__list" aria-label="Retained local side notes">
              {notes.map((note) => (
                <li key={note.id}>
                  <button type="button" disabled={busy} onClick={() => onNavigate(note.id)}>
                    {note.title} · {note.side.state} · {note.createdAt}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {cursor ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!walk.current.canFetchNextPage()) {
                  setNotice('Side note page limit reached. Reopen the parent to refresh.');
                  setCursor(undefined);
                  return;
                }
                void run(
                  'read',
                  () => capability.list(conversationId, { cursor }),
                  (page) => {
                    if (!walk.current.acceptNextPage(cursor, page)) {
                      setNotice('The side note page changed. Reopen the parent to refresh.');
                      setCursor(undefined);
                      return;
                    }
                    setNotes((previous) => [
                      ...new Map(
                        [...previous, ...page.data].map((note) => [note.id, note]),
                      ).values(),
                    ]);
                    setCursor(page.cursor?.hasMore ? page.cursor.next : undefined);
                  },
                );
              }}
            >
              Load more side notes
            </button>
          ) : null}
        </>
      )}
      {ready && notice ? <output aria-live="polite">{notice}</output> : null}
      {ready && reviewNotice ? <output aria-live="polite">{reviewNotice}</output> : null}
    </section>
  );
}
