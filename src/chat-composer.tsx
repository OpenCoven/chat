import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react';
import { ChatWriteRecovery } from './chat-write-recovery';
import { createDraft } from './lib/chat-continuity';
import type { ChatWriter } from './lib/local/chat-writer';

export type ChatComposerProps = Readonly<{
  writer: ChatWriter;
  conversationId: string | null;
  isDurable: boolean;
  onWritten: () => void;
  savedDraft?: ReturnType<typeof createDraft> | undefined;
}>;

function messageForCode(code: string): string {
  switch (code) {
    case 'invalid_request':
      return 'That message could not be saved. It may be empty or too long.';
    case 'not_found':
      return 'That conversation no longer exists.';
    default:
      return 'The message could not be saved on this device.';
  }
}

export function ChatComposer({
  writer,
  conversationId,
  isDurable,
  onWritten,
  savedDraft,
}: ChatComposerProps) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing the exact destination resets a standalone composer.
  const localDraft = useMemo(createDraft, [writer, conversationId]);
  const entry = savedDraft ?? localDraft;
  const {
    text: draft,
    pending,
    error,
    writes,
    recovery,
  } = useSyncExternalStore(entry.subscribe, entry.getSnapshot);
  const observed = useRef({ entry, writes });
  useEffect(() => {
    const changed = observed.current.entry === entry && observed.current.writes !== writes;
    observed.current = { entry, writes };
    if (changed) onWritten();
  }, [entry, writes, onWritten]);
  const inputId = useId();

  const canSend =
    writer.canWrite() &&
    conversationId !== null &&
    draft.trim().length > 0 &&
    !pending &&
    !recovery;

  async function send() {
    if (
      conversationId === null ||
      draft.trim().length === 0 ||
      entry.getSnapshot().pending ||
      entry.getSnapshot().recovery ||
      !writer.canWrite()
    ) {
      return;
    }

    entry.update({ pending: true, error: '' });
    try {
      const result = await writer.sendMessage(conversationId, draft);

      if (result.status === 'reconcile_required') {
        entry.update({ pending: false, recovery: result.recovery, error: '' });
        return;
      }
      if (result.status === 'ok') {
        if (result.data.conversationId !== conversationId) {
          entry.update({
            pending: false,
            error: 'The save result did not match this exact conversation. Your draft was kept.',
          });
          return;
        }
        entry.update({
          text: '',
          pending: false,
          error: '',
          writes: entry.getSnapshot().writes + 1,
        });
        return;
      }

      entry.update({
        pending: false,
        error: result.status === 'unsupported' ? result.reason : messageForCode(result.code),
      });
    } catch {
      entry.update({ pending: false, error: messageForCode('service_unavailable') });
    }
  }

  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label className="chat-composer__label" htmlFor={inputId}>
        Message
      </label>
      <div className="chat-composer__row">
        <textarea
          className="chat-composer__input"
          id={inputId}
          rows={2}
          value={draft}
          placeholder={conversationId === null ? 'Start a conversation first' : 'Write a message…'}
          disabled={!writer.canWrite() || conversationId === null || pending || recovery !== null}
          maxLength={32_000}
          onChange={(event) => {
            entry.update({ text: event.target.value, error: '' });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button className="chat-composer__send" type="submit" disabled={!canSend}>
          {pending ? 'Saving…' : 'Send'}
        </button>
      </div>
      <p className="chat-composer__note" role="note">
        {isDurable
          ? 'Saved on this device. No familiar is connected, so no reply will arrive.'
          : 'This device has no available storage, so these messages are kept in memory only and will be lost when the app closes.'}
      </p>
      {error ? (
        <output className="chat-composer__error" aria-live="polite" role="alert">
          {error}
        </output>
      ) : null}
      {recovery ? (
        <ChatWriteRecovery
          key={recovery.receipt.id}
          writer={writer}
          recovery={recovery}
          onReconciled={(result) => {
            const current = entry.getSnapshot();
            if (current.recovery !== recovery) return;
            const matches =
              result.receipt.kind === 'message' &&
              result.receipt.conversationId === conversationId &&
              result.receipt.text === current.text.trim();
            entry.update({
              recovery: null,
              text: result.outcome === 'committed' && matches ? '' : current.text,
              error:
                result.outcome === 'not_committed'
                  ? 'The save did not commit. Your draft is retained and may be sent again.'
                  : '',
              writes: current.writes + 1,
            });
          }}
        />
      ) : null}
    </form>
  );
}
