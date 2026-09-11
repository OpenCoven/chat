import { useState } from 'react';
import type { ChatWriter } from './lib/local/chat-writer';
import {
  type RootWriteReconciliation,
  type RootWriteRecovery,
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
  const failed =
    'Local history could not be reconciled. No new write was attempted. Retry reconciliation.';
  async function reconcile() {
    if (pending || !writer.reconcileWrite) return;
    setPending(true);
    setError('');
    try {
      const result = await writer.reconcileWrite(recovery.receipt.id);
      if (result.status === 'ok' && result.data.receipt.id === recovery.receipt.id) {
        onReconciled(result.data);
      } else {
        setError(
          result.status === 'error' && result.code === 'not_found'
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
    <section className="chat-chapters__notice" aria-label="Local save recovery">
      <p role="alert">{writeRecoveryNotice(recovery)}</p>
      <button
        type="button"
        disabled={pending || !writer.reconcileWrite}
        onClick={() => void reconcile()}
      >
        Reconcile local save
      </button>
      {error ? <output role="alert">{error}</output> : null}
    </section>
  );
}
