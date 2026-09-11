import type { CaveConversationMessage } from '@opencoven/cave-client/managed';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { type ContinuityMemory, createSideReview, sideReviewMemory } from './lib/chat-continuity';
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
}>;

function failure(result: Exclude<WriteResult<unknown>, { status: 'ok' }>): string {
  if (result.status === 'unsupported') return result.reason;
  if (result.code === 'conflict')
    return 'This operation conflicts with its earlier request. Nothing new was imported.';
  if (result.code === 'not_found')
    return 'The exact parent, side note, or selected message is unavailable.';
  return 'The local change could not be saved. Retry uses the same operation key.';
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
}: Props) {
  const capability = writer?.canWrite() ? writer.sideConversations : undefined;
  const [side, setSide] = useState<SideConversation | null>(null);
  const [ready, setReady] = useState(false);
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
  const busy = operationBusy || phase === 'preparing' || phase === 'sending';
  const observed = useRef({ reviewEntry, writes });
  useEffect(() => {
    const changed =
      observed.current.reviewEntry === reviewEntry && observed.current.writes !== writes;
    observed.current = { reviewEntry, writes };
    if (changed) onWritten();
  }, [reviewEntry, writes, onWritten]);
  const active = useRef(false);
  const pending = useRef(false);
  const createKey = useRef<string | null>(null);
  const walk = useRef(createManualPageWalk());
  const reviewId = useId();

  useEffect(() => {
    active.current = true;
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
          setNotice(failure(info));
          return;
        }
        setSide(info.data);
        if (!info.data) {
          const page = await capability.list(conversationId);
          if (!alive.value) return;
          if (page.status !== 'ok') {
            setNotice(failure(page));
            return;
          }
          if (!walk.current.acceptRootPage(page.data)) {
            setNotice('The side note page is invalid. Reopen this conversation to refresh.');
            return;
          }
          setNotes(page.data.data);
          setCursor(page.data.cursor?.hasMore ? page.data.cursor.next : undefined);
        }
        setReady(true);
      } catch {
        if (alive.value) setNotice('Local side notes are unavailable. No content was moved.');
      }
    })();
    return () => {
      alive.value = false;
      active.current = false;
    };
  }, [capability, conversationId]);

  async function run<T>(operation: () => Promise<WriteResult<T>>, success: (data: T) => void) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice('');
    try {
      const result = await operation();
      if (!active.current) return;
      if (result.status === 'ok') success(result.data);
      else setNotice(failure(result));
    } catch {
      if (active.current)
        setNotice('The local change could not be saved. Retry uses the same operation key.');
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function startReview() {
    if (!capability || !side || busy || reviewEntry.getSnapshot().review) return;
    const source = messages.filter((message) => selected.includes(message.id));
    const input: BringBackInput = {
      parentConversationId: side.side.parentConversationId,
      sideConversationId: side.id,
      sourceMessageIds: source.map((message) => message.id),
      excerpt: source
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
      } else {
        reviewEntry.update({ phase: 'idle', notice: failure(result) });
      }
    } catch {
      reviewEntry.update({
        phase: 'idle',
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
      snapshot.phase === 'sending' ||
      snapshot.phase === 'preparing'
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
      } else {
        reviewEntry.update({
          phase: 'uncertain',
          notice:
            result.status === 'ok'
              ? 'The receipt did not match the exact parent. Retry to reconcile.'
              : failure(result),
        });
      }
    } catch {
      reviewEntry.update({
        phase: 'uncertain',
        notice: 'The local change could not be saved. Retry uses the same operation key.',
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

  function create() {
    if (!capability) return;
    createKey.current ??= crypto.randomUUID();
    void run(
      () =>
        capability.create({
          parentConversationId: conversationId,
          operationKey: createKey.current ?? '',
        }),
      (created) => {
        if (created.side.state === 'discarded') {
          setNotice('This creation request refers to a discarded note.');
          return;
        }
        onWritten();
        onNavigate(created.id);
      },
    );
  }

  function changeState(state: 'open' | 'closed' | 'discarded') {
    if (!capability || !side) return;
    void run(
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
        <output>{notice || 'Loading local side notes…'}</output>
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
            <fieldset disabled={busy || review !== null}>
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
                disabled={busy || phase === 'uncertain'}
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
                <button type="submit" disabled={busy || !review.excerpt.trim()}>
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
            New retained side note
          </button>
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
