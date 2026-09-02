import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref, useId } from 'react';

import { Icon } from '../demo/minimal-icons';
import { AttachmentChip, type AttachmentState } from './attachment-chip';
import { Button } from './button';
import type { CompletionCommand } from './completion-palette';
import { SendControl } from './send-control';
import { Textarea } from './textarea';
import { cn, type Density } from './utils';

/**
 * Vendored from OpenCoven/ui (`blocks/composer.tsx`), adapted for a chat.
 *
 * Upstream's contract is kept: a controlled draft, attachments with a remove
 * callback, `onSend`, and a `running`/`onStop` pair that swaps the send
 * control for a stop without moving anything. What a chat adds:
 *
 * - a visible label naming who is addressed ("Message Astra");
 * - the keyboard model upstream omits — Enter sends, Shift+Enter breaks a
 *   line, ⌘/Ctrl+Enter also sends — with `onKeyDown` running first so the
 *   host can claim keys for its own menus;
 * - a `warning` slot for the moment a draft crosses a boundary;
 * - a `children` slot above the field for the host's inline `/` and `@` menus;
 * - the options caret opening the command palette.
 *
 * Modes and the model readout are dropped: here the ward, not a mode, decides
 * what a familiar may do.
 */
export type ComposerAttachment = Readonly<{
  id: string;
  name: string;
  meta?: string;
  state?: AttachmentState;
  progress?: number;
}>;

export type ComposerWarning = Readonly<{
  label: string;
  title?: string;
  onClick?: () => void;
}>;

export type ComposerProps = Readonly<{
  value: string;
  onValueChange: (value: string) => void;
  attachments?: readonly ComposerAttachment[];
  onRemoveAttachment?: (id: string) => void;
  onSend?: () => void;
  running?: boolean;
  onStop?: () => void;
  density?: Density;
  className?: string;
  /** Who the draft is addressed to; shown as the field's label. */
  label?: string;
  placeholder?: string;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Runs before the composer's own key handling; call `preventDefault` to claim a key. */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onAttach?: () => void;
  /** Opens the host's inline command menu (the same list the caret offers). */
  onOpenCommands?: () => void;
  commands?: readonly CompletionCommand[];
  onSelectCommand?: (command: CompletionCommand) => void;
  warning?: ComposerWarning | null;
  minRows?: number;
  maxRows?: number;
  children?: ReactNode;
}>;

export function Composer({
  value,
  onValueChange,
  attachments = [],
  onRemoveAttachment,
  onSend,
  running = false,
  onStop,
  density = 'default',
  className,
  label = 'Message',
  placeholder = 'Type a message, or / for commands.',
  textareaRef,
  onKeyDown,
  onAttach,
  onOpenCommands,
  commands,
  onSelectCommand,
  warning,
  minRows = 2,
  maxRows = 8,
  children,
}: ComposerProps) {
  const id = useId();
  const fieldId = `composer-${id}`;
  const ready = value.trim().length > 0;

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (running) {
        return;
      }
      if (ready) {
        onSend?.();
      }
    }
  }

  return (
    <section
      data-slot="composer"
      data-density={density}
      data-tone={warning ? 'warning' : 'default'}
      data-running={running || undefined}
      aria-label="Message composer"
      className={cn('oc-composer', className)}
    >
      {children}
      <div className="oc-composer-bar">
        {onAttach ? (
          <Button
            type="button"
            variant="ghost"
            density="compact"
            size="icon"
            aria-label="Attach file"
            title="Attach"
            onClick={onAttach}
          >
            <Icon name="paperclip" size={15} />
          </Button>
        ) : null}
        {onOpenCommands ? (
          <Button
            type="button"
            variant="ghost"
            density="compact"
            size="icon"
            aria-label="Commands"
            title="Commands  /"
            onClick={onOpenCommands}
          >
            <Icon name="terminal-window" size={15} />
          </Button>
        ) : null}
        <label htmlFor={fieldId} className="oc-composer-label">
          {label}
        </label>
        <span className="oc-composer-spacer" />
        {warning ? (
          <button
            type="button"
            className="oc-composer-warning"
            title={warning.title}
            onClick={warning.onClick}
          >
            <span className="oc-composer-warning-dot" aria-hidden="true" />
            {warning.label}
          </button>
        ) : null}
      </div>
      <Textarea
        id={fieldId}
        ref={textareaRef}
        value={value}
        density={density}
        minRows={minRows}
        maxRows={maxRows}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        className="oc-composer-field"
      />
      {attachments.length > 0 ? (
        <ul className="oc-composer-attachments" aria-label="Attachments">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <AttachmentChip
                name={attachment.name}
                meta={attachment.meta}
                state={attachment.state}
                progress={attachment.progress}
                onRemove={onRemoveAttachment ? () => onRemoveAttachment(attachment.id) : undefined}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <footer className="oc-composer-footer">
        <span className="oc-composer-hint">
          <kbd className="oc-kbd">⏎</kbd> send · <kbd className="oc-kbd">⇧⏎</kbd> newline
        </span>
        <SendControl
          running={running}
          density={density}
          disabled={!running && !ready}
          onSend={onSend}
          onStop={onStop}
          options={commands}
          onSelectOption={onSelectCommand}
        />
      </footer>
    </section>
  );
}
