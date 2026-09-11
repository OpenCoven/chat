import { useId, useState } from 'react';
import type { ChatWriter } from './lib/local/chat-writer';
import {
  type RootWriteReconciliation,
  type RootWriteRecovery,
  sameRootWriteReceipt,
  writeRecoveryNotice,
} from './lib/local/write-recovery';

export function ChatWriteRecovery({
  writer,
  recovery,
  onReconciled,
}: {
  writer: ChatWriter;
  recovery: RootWriteRecovery;
  onReconciled: (result: RootWriteReconciliation) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState<RootWriteReconciliation | null>(null);
  const contentId = useId();
  const failed =
    'Local history could not be reconciled. No new write was attempted. Retry reconciliation.';
  function matchesRecovery(result: RootWriteReconciliation): boolean {
    return (
      sameRootWriteReceipt(recovery.receipt, result.receipt) &&
      ((result.outcome === 'committed' &&
        (result.availability === 'present' || result.availability === 'unavailable')) ||
        (recovery.commit === 'unconfirmed' &&
          result.outcome === 'not_committed' &&
          result.availability === 'absent'))
    );
  }
  async function reconcile() {
    if (pending || !writer.reconcileWrite) return;
    setPending(true);
    setError('');
    try {
      const result = await writer.reconcileWrite(recovery.receipt.id);
      if (result.status === 'ok' && matchesRecovery(result.data)) {
        if (result.data.outcome === 'committed' && result.data.availability === 'unavailable')
          setUnavailable(result.data);
        else onReconciled(result.data);
      } else {
        setError(
          result.status === 'error' && result.code === 'absence_unproven'
            ? 'This storage provider cannot prove that this save is absent. Its outcome remains unresolved; do not resend. Copy the content or check again for the exact saved record.'
            : result.status === 'error' && result.code === 'not_found'
              ? 'The original save or note is unavailable. Its outcome remains unresolved; do not resend it.'
              : failed,
        );
      }
    } catch {
      setError(failed);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="chat-write-recovery chat-chapters__notice" aria-label="Local save recovery">
      <p role="alert">
        {unavailable
          ? 'This save committed, but its record is no longer available. A later deletion or discard does not undo that commit. Copy the saved content before dismissing; nothing will be resubmitted.'
          : writeRecoveryNotice(recovery)}
      </p>
      <label htmlFor={contentId}>
        {unavailable ? 'Unavailable saved content' : 'Unresolved save content'}
      </label>
      <textarea
        id={contentId}
        readOnly
        value={recovery.receipt.kind === 'message' ? recovery.receipt.text : recovery.receipt.title}
      />
      {unavailable ? (
        <button
          type="button"
          onClick={() => {
            if (
              matchesRecovery(unavailable) &&
              unavailable.outcome === 'committed' &&
              unavailable.availability === 'unavailable'
            )
              onReconciled(unavailable);
            else setError(failed);
          }}
        >
          Dismiss unavailable save
        </button>
      ) : (
        <button
          type="button"
          disabled={pending || !writer.reconcileWrite}
          onClick={() => void reconcile()}
        >
          Reconcile local save
        </button>
      )}
      {error ? <output role="alert">{error}</output> : null}
    </section>
  );
}
