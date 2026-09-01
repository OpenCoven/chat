import { useId, useState } from 'react';

import type { ChatWriter } from './lib/local/chat-writer';

export type ChatComposerProps = Readonly<{
  writer: ChatWriter;
  conversationId: string | null;
  isDurable: boolean;
  onWritten: () => void;
}>;

type ComposerStatus =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'sending' }>
  | Readonly<{ status: 'error'; message: string }>;

const IDLE: ComposerStatus = Object.freeze({ status: 'idle' } as const);
const SENDING: ComposerStatus = Object.freeze({ status: 'sending' } as const);

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

export function ChatComposer({ writer, conversationId, isDurable, onWritten }: ChatComposerProps) {
  const [draft, setDraft] = useState('');
  const [composerStatus, setComposerStatus] = useState<ComposerStatus>(IDLE);
  const inputId = useId();

  const canSend =
    conversationId !== null && draft.trim().length > 0 && composerStatus.status !== 'sending';

async function send() {
  if (conversationId === null || draft.trim().length === 0) {
    return;
  }

  setComposerStatus(SENDING);
  try {
    const result = await writer.sendMessage(conversationId, draft);

    if (result.status === 'ok') {
      setDraft('');
      setComposerStatus(IDLE);
      onWritten();
      return;
    }

    setComposerStatus(
      Object.freeze({
        status: 'error',
        message: result.status === 'unsupported' ? result.reason : messageForCode(result.code),
      }),
    );
  } catch {
    setComposerStatus(Object.freeze({ status: 'error', message: messageForCode('service_unavailable') }));
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
          disabled={conversationId === null || composerStatus.status === 'sending'}
          onChange={(event) => {
            setDraft(event.target.value);
            if (composerStatus.status === 'error') {
              setComposerStatus(IDLE);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button className="chat-composer__send" type="submit" disabled={!canSend}>
          {composerStatus.status === 'sending' ? 'Saving…' : 'Send'}
        </button>
      </div>
      <p className="chat-composer__note" role="note">
        {isDurable
          ? 'Saved on this device. No familiar is connected, so no reply will arrive.'
          : 'This device has no available storage, so these messages are kept in memory only and will be lost when the app closes.'}
      </p>
      {composerStatus.status === 'error' ? (
        <output className="chat-composer__error" aria-live="polite" role="alert">
          {composerStatus.message}
        </output>
      ) : null}
    </form>
  );
}
