import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../design/minimal-icons';
import { formatAttachmentSize } from './attachments';
import { CopyButton } from './copy-button';
import { closeModal, openModal } from './modal';
import './attachment-card.css';

/** How many leading lines the card's miniature page draws. */
const THUMB_LINES = 18;

/** The file's extension as a short badge ("TS", "JSON"), or "TXT" when it has none. */
export function attachmentBadge(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return (ext || 'txt').slice(0, 4).toUpperCase();
}

/** "84 lines": what a reader opening the file is in for. */
export function lineCount(text: string): string {
  const lines = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
  return `${lines} ${lines === 1 ? 'line' : 'lines'}`;
}

export type AttachmentCardProps = Readonly<{
  name: string;
  size: number;
  /**
   * The file's text, when this window still holds it (a draft). Sent files
   * are recorded by name and size only, so their card has no preview.
   */
  text?: string | undefined;
  onRemove?: (() => void) | undefined;
}>;

/**
 * One attached file as a small card: a miniature of its first lines on a
 * paper tile, its type, size and length. A draft's card opens a Quick Look
 * sheet with the whole file (click, or Space while focused, as in Finder).
 */
export function AttachmentCard({ name, size, text, onRemove }: AttachmentCardProps) {
  const [peeking, setPeeking] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const badge = attachmentBadge(name);
  const thumb = useMemo(
    () => (text === undefined ? undefined : text.split('\n').slice(0, THUMB_LINES).join('\n')),
    [text],
  );
  const meta = [formatAttachmentSize(size), text === undefined ? null : lineCount(text)]
    .filter(Boolean)
    .join(' · ');
  const face = (
    <>
      <span className="coven-attachment-paper" aria-hidden="true">
        {thumb ? (
          <pre className="coven-attachment-thumb">{thumb}</pre>
        ) : (
          <span className="coven-attachment-glyph">
            <Icon name="file-text" size={16} />
          </span>
        )}
        <span className="coven-attachment-badge">{badge}</span>
      </span>
      <span className="coven-attachment-copy">
        <span className="coven-attachment-name" title={name}>
          {name}
        </span>
        <span className="coven-attachment-meta">{meta}</span>
      </span>
    </>
  );
  return (
    <span className="coven-attachment-card" data-preview={text === undefined ? undefined : true}>
      {text === undefined ? (
        <span
          className="coven-attachment-face"
          title={`${name} was sent with this message. Chat keeps its name and size, not its contents.`}
        >
          {face}
        </span>
      ) : (
        <button
          ref={opener}
          type="button"
          className="coven-attachment-face"
          aria-label={`Preview ${name}`}
          aria-haspopup="dialog"
          aria-keyshortcuts="Space"
          title="Preview (Space)"
          onClick={() => setPeeking(true)}
        >
          {face}
        </button>
      )}
      {onRemove ? (
        <button
          type="button"
          className="coven-attachment-remove"
          aria-label={`Remove ${name}`}
          title="Remove"
          onClick={onRemove}
        >
          <Icon name="x" size={11} />
        </button>
      ) : null}
      {peeking && text !== undefined ? (
        <AttachmentPeek
          name={name}
          badge={badge}
          meta={meta}
          text={text}
          onRemove={onRemove}
          onClose={() => {
            setPeeking(false);
            opener.current?.focus();
          }}
        />
      ) : null}
    </span>
  );
}

function AttachmentPeek({
  name,
  badge,
  meta,
  text,
  onRemove,
  onClose,
}: Readonly<{
  name: string;
  badge: string;
  meta: string;
  text: string;
  onRemove?: (() => void) | undefined;
  onClose: () => void;
}>) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (node) openModal(node);
    return () => {
      if (node) closeModal(node);
    };
  }, []);
  const lines = text.replace(/\n$/, '').split('\n');
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes; Escape is the keyboard path, handled by the native dialog.
    <dialog
      ref={dialog}
      className="coven-peek"
      aria-labelledby="coven-peek-title"
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself.
        if (event.target === event.currentTarget) closeModal(event.currentTarget);
      }}
    >
      <header className="coven-peek-head">
        <span className="coven-attachment-badge coven-peek-badge">{badge}</span>
        <span className="coven-peek-title-wrap">
          <h2 id="coven-peek-title" className="coven-peek-title">
            {name}
          </h2>
          <span className="coven-peek-meta">{meta}</span>
        </span>
        <CopyButton text={text} label={`Copy ${name}`} />
        {onRemove ? (
          <button
            type="button"
            className="fr-btn fr-btn--secondary coven-peek-remove"
            onClick={() => {
              if (dialog.current) closeModal(dialog.current);
              onRemove();
            }}
          >
            Remove
          </button>
        ) : null}
        <button
          type="button"
          className="coven-peek-close"
          aria-label="Close preview"
          onClick={() => dialog.current && closeModal(dialog.current)}
        >
          <Icon name="x" size={14} />
        </button>
      </header>
      <ol className="coven-peek-body">
        {lines.map((line, index) => (
          // Lines are positional; the file does not change while shown.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional lines
          <li key={index}>{line || ' '}</li>
        ))}
      </ol>
    </dialog>
  );
}
