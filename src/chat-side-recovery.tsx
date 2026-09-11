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
        can be attempted here. An uncertain save may already have committed; inspect the parent
        before starting another review.
      </p>
      {snapshot.notice ? <output>{snapshot.notice}</output> : null}
      <label htmlFor={id}>Unavailable reviewed excerpt</label>
      <textarea id={id} readOnly value={snapshot.review.excerpt} />
      <button
        type="button"
        disabled={snapshot.phase === 'sending' || snapshot.phase === 'preparing'}
        onClick={() => entry.update({ review: null, selected: [], phase: 'idle', notice: '' })}
      >
        Cancel unavailable review
      </button>
    </section>
  );
}
