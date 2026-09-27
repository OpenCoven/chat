import { useEffect, useRef, useState } from 'react';
import { Icon } from '../design/minimal-icons';
import type { ChatLifecycle } from '../lib/coven-runtime';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
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
  // The menu item that opens the dialog is gone by the time it closes, so
  // focus goes back to the control that opened the menu.
  const trigger = useRef<HTMLButtonElement>(null);
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
      {/* Restoring is what lets the reader send again, so it stays in view;
          the rarer actions wait in the menu. */}
      {archived && (
        <button
          type="button"
          className="fr-btn fr-btn--secondary"
          disabled={disabled}
          onClick={() => onChange('active')}
        >
          Restore chat
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={trigger}
          className="fr-icon-btn fr-icon-btn--sm coven-lifecycle-trigger"
          aria-label="Chat actions"
          title="Chat actions"
          disabled={disabled}
        >
          <Icon name="dots-three" size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!archived && (
            <DropdownMenuItem onClick={() => onChange('archived')}>Archive chat</DropdownMenuItem>
          )}
          <DropdownMenuItem className="coven-lifecycle-danger" onClick={() => setConfirming(true)}>
            Delete chat
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <dialog
        ref={dialog}
        className="coven-delete-dialog"
        aria-labelledby="coven-delete-title"
        aria-describedby="coven-delete-description"
        onClose={() => {
          setConfirming(false);
          trigger.current?.focus();
        }}
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
          This permanently removes this chat and its saved local transcript from Chat. It cannot be
          restored. Original CLI/Cave history is untouched. This does not cancel a running agent.
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
