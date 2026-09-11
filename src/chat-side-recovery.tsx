import { useId, useMemo, useSyncExternalStore } from 'react';
import { type ContinuityMemory, createSideReview } from './lib/chat-continuity';

export function ChatSideRecovery({
  memory,
  familiarId,
  conversationId,
}: {
  memory: ContinuityMemory;
  familiarId: string;
  conversationId: string;
}) {
  const entry = useMemo(() => {
    for (const [key, review] of memory.sideReviews) {
      const identity: unknown = JSON.parse(key);
      if (
        Array.isArray(identity) &&
        identity.length === 3 &&
        identity[0] === familiarId &&
        identity[2] === conversationId
      )
        return review;
    }
    return createSideReview();
  }, [memory, familiarId, conversationId]);
  const snapshot = useSyncExternalStore(entry.subscribe, entry.getSnapshot);
  const id = useId();
  if (!snapshot.review) return null;
  return (
    <section className="chat-side" aria-label="Unavailable local review">
      <p role="alert">
        This exact local side note is unavailable. The stored review remains copyable, but no import
        can be attempted here.
      </p>
      {snapshot.phase === 'uncertain' ? (
        <p>
          This save may already have committed. Its original retry identity is retained, so
          cancellation is unavailable. You can copy the excerpt or navigate away; no save is undone
          and no reconciliation can be attempted from this unavailable target.
        </p>
      ) : snapshot.notice ? (
        <output>{snapshot.notice}</output>
      ) : null}
      <label htmlFor={id}>Unavailable reviewed excerpt</label>
      <textarea id={id} readOnly value={snapshot.review.excerpt} />
      <button
        type="button"
        disabled={
          snapshot.phase === 'sending' ||
          snapshot.phase === 'preparing' ||
          snapshot.phase === 'uncertain'
        }
        onClick={() => {
          const current = entry.getSnapshot();
          if (
            current.phase === 'editing' ||
            current.phase === 'rejected' ||
            current.phase === 'unavailable' ||
            current.phase === 'reselecting'
          ) {
            entry.update({ review: null, selected: [], phase: 'idle', notice: '' });
          }
        }}
      >
        Cancel unavailable review
      </button>
    </section>
  );
}
