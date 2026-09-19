import { type RefObject, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  type ContextFamiliar,
  type ContextReference,
  contextReferences,
  insertContextReference,
  matchContextReferences,
} from './context-references';
import './context-picker.css';

const supportsPopover =
  typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

export type ContextPickerProps = Readonly<{
  familiars: readonly ContextFamiliar[];
  familiarId: string;
  value: string;
  onValueChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
}>;

export function ContextPicker({
  familiars,
  familiarId,
  value,
  onValueChange,
  textareaRef,
  disabled = false,
}: ContextPickerProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const selection = useRef({ start: 0, end: 0 });
  const restoreCaret = useRef<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const activeOption = useRef<HTMLButtonElement>(null);
  const matches = matchContextReferences(contextReferences(familiars, familiarId), query);
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));

  useLayoutEffect(() => {
    if (open) activeOption.current?.scrollIntoView?.({ block: 'nearest' });
  });

  useLayoutEffect(() => {
    if (disabled) {
      setOpen(false);
      return;
    }
    if (open) {
      panel.current?.showPopover?.();
      input.current?.focus();
    }
    if (!open && restoreCaret.current !== null) {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(restoreCaret.current, restoreCaret.current);
      restoreCaret.current = null;
    }
  }, [open, textareaRef, disabled]);

  function close() {
    setOpen(false);
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(selection.current.start, selection.current.end);
  }

  function select(reference: ContextReference) {
    const inserted = insertContextReference(
      value,
      selection.current.start,
      selection.current.end,
      reference,
    );
    restoreCaret.current = inserted.caret;
    onValueChange(inserted.value);
    setOpen(false);
  }

  return (
    <div className="chat-context">
      <button
        type="button"
        className="chat-context-trigger"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          const field = textareaRef.current;
          selection.current = {
            start: field?.selectionStart ?? value.length,
            end: field?.selectionEnd ?? value.length,
          };
          setQuery('');
          setActive(0);
          setOpen(true);
        }}
      >
        Add context
      </button>
      {open && !disabled ? (
        <section
          ref={panel}
          id={`${id}-panel`}
          className="chat-context-panel"
          popover={supportsPopover ? 'auto' : undefined}
          aria-label="Add chat context"
          onToggle={(event) => {
            if (event.newState === 'closed') setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="chat-context-heading">
            <strong>Which familiar or workspace?</strong>
            <button type="button" onClick={close} aria-label="Close context picker">
              Close
            </button>
          </div>
          <p id={`${id}-hint`}>
            Adds visible text only. Your recipient and file access stay the same.
          </p>
          <input
            ref={input}
            role="combobox"
            aria-label="Search familiars and workspaces"
            aria-describedby={`${id}-hint`}
            aria-expanded="true"
            aria-controls={`${id}-options`}
            aria-autocomplete="list"
            aria-activedescendant={matches.length ? `${id}-option-${activeIndex}` : undefined}
            placeholder="Search name, ID or path; @ familiars, # workspaces"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setActive(
                  matches.length
                    ? (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) %
                        matches.length
                    : 0,
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                const reference = matches[activeIndex];
                if (reference) select(reference);
              }
            }}
          />
          <div
            id={`${id}-options`}
            role="listbox"
            aria-label="Known context"
            className="chat-context-options"
          >
            {(['familiar', 'workspace'] as const).map((kind) => (
              <fieldset key={kind} aria-label={kind === 'familiar' ? 'Familiars' : 'Workspaces'}>
                {matches.some((item) => item.kind === kind) ? (
                  <div className="chat-context-group">
                    {kind === 'familiar' ? 'Familiars' : 'Workspaces'}
                  </div>
                ) : null}
                {matches.map((reference, index) =>
                  reference.kind === kind ? (
                    <button
                      type="button"
                      role="option"
                      id={`${id}-option-${index}`}
                      key={reference.key}
                      ref={index === activeIndex ? activeOption : undefined}
                      aria-selected={index === activeIndex}
                      aria-label={`${reference.label} ${reference.detail}`}
                      className="chat-context-option"
                      onClick={() => select(reference)}
                    >
                      <span>{reference.label}</span>
                      <small>{reference.detail}</small>
                      <small>{reference.source}</small>
                    </button>
                  ) : null,
                )}
              </fieldset>
            ))}
            {!matches.length ? (
              <output>No known context matches. Try a familiar name, ID or workspace path.</output>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
