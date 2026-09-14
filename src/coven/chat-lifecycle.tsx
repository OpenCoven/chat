import { useEffect, useRef, useState } from 'react';
import type { ChatLifecycle } from '../lib/coven-runtime';
import './chat-lifecycle.css';

export function ChatLifecycleControls({
  id,
  title,
  archived,
  disabled,
  pending,
  error,
  onChange,
}: {
  id: string;
  title: string;
  archived: boolean;
  disabled: boolean;
  pending: boolean;
  error: string;
  onChange: (next: ChatLifecycle) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (confirming) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [confirming]);
  // A navigation change must never transfer confirmation to another conversation.
  useEffect(() => {
    if (id) setConfirming(false);
  }, [id]);
  return (
    <div className="coven-lifecycle">
      {archived && <span className="coven-archived-label">Archived · restore to send</span>}
      <button
        type="button"
        className="fr-btn fr-btn--secondary"
        disabled={disabled}
        onClick={() => onChange(archived ? 'active' : 'archived')}
      >
        {archived ? 'Restore chat' : 'Archive chat'}
      </button>
      <button
        type="button"
        className="fr-btn fr-btn--secondary"
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        Delete chat
      </button>
      <dialog
        ref={dialog}
        className="coven-delete-dialog"
        aria-labelledby="coven-delete-title"
        aria-describedby="coven-delete-description"
        onClose={() => setConfirming(false)}
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
          );
          const first = buttons[0];
          const last = buttons.at(-1);
          if (!first || !last) {
            event.preventDefault();
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <h2 id="coven-delete-title">Delete chat from this app?</h2>
        <p>{title}</p>
        <p id="coven-delete-description">
          This permanently removes this chat and its saved local transcript or import snapshot from
          Chat. It cannot be restored or re-imported from the same file. Original CLI/Cave history
          is untouched. This does not cancel a running agent.
        </p>
        {confirming && error && <p role="alert">{error}</p>}
        <div className="coven-delete-actions">
          <button
            type="button"
            className="fr-btn fr-btn--secondary"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            Keep chat
          </button>
          <button
            type="button"
            className="fr-btn coven-delete-confirm"
            disabled={disabled}
            onClick={() => onChange('deleted')}
          >
            {pending ? 'Deleting...' : 'Delete from Chat'}
          </button>
        </div>
      </dialog>
    </div>
  );
}
