import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { ComposerTextareaProps } from '../ui/composer';
import {
  type ContextFamiliar,
  type ContextReference,
  contextReferences,
  insertContextReference,
  matchContextReferences,
} from './context-references';
import './mention-completion.css';

type MentionCompletionProps = Readonly<{
  familiars: readonly ContextFamiliar[];
  familiarId: string;
  value: string;
  onValueChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
}>;

function mentionToken(value: string, start: number, end: number) {
  if (start !== end) return null;
  const before = value.slice(0, start);
  const trigger = /(?:^|[\s([{"'])([@#])(\{?)([^@#{}\n]*)$/u.exec(before);
  if (!trigger || /^\s/u.test(trigger[3] ?? '')) return null;
  const marker = trigger[1] ?? '';
  const brace = trigger[2] ?? '';
  const query = trigger[3] ?? '';
  const from = start - marker.length - brace.length - query.length;
  // A finished visible reference is never an autocomplete token, even inside its name.
  if (brace && /^[^{}\n]*\}/u.test(value.slice(start))) return null;
  const tail = /^[^\s{}@#]*/u.exec(value.slice(start))?.[0] ?? '';
  return { start: from, end: start + tail.length, query: `${marker}${query}` };
}

function MentionPanel({
  id,
  textareaRef,
  matches,
  active,
  onSelect,
}: {
  id: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  matches: readonly ContextReference[];
  active: number;
  onSelect: (reference: ContextReference) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const field = textareaRef.current;
    const element = panel.current;
    if (!field || !element) return;
    const anchor = field.closest('[data-slot="composer"]') ?? field;
    const theme = getComputedStyle(field);
    for (const property of [
      '--bg-raised',
      '--text-primary',
      '--text-secondary',
      '--border-strong',
      '--accent-presence',
      '--font-inter',
    ]) {
      element.style.setProperty(property, theme.getPropertyValue(property));
    }
    function position() {
      if (!element) return;
      const bounds = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const availableWidth = Math.max(0, width - 24);
      const panelWidth = Math.min(bounds.width, 560, availableWidth);
      element.style.left = `${Math.max(left + 12, Math.min(bounds.left, left + width - panelWidth - 12))}px`;
      element.style.width = `${panelWidth}px`;
      element.style.bottom = `${window.innerHeight - bounds.top + 8}px`;
      element.style.maxHeight = `${Math.max(0, Math.min(300, bounds.top - top - 20))}px`;
    }
    position();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    observer?.observe(anchor);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [textareaRef]);

  useLayoutEffect(() => {
    const list = options.current;
    const option = selected.current;
    if (!list || !option) return;
    // Scroll only this list, never the page or the conversation behind it.
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  });

  return createPortal(
    <div ref={panel} className="chat-mention-panel">
      <div className="chat-mention-heading">
        <strong>{matches[0]?.kind === 'workspace' ? 'Projects' : 'Familiars'}</strong>
        <span>Tab to insert / Esc to dismiss</span>
      </div>
      <div
        ref={options}
        id={id}
        role="listbox"
        aria-label="Context suggestions"
        className="chat-mention-options"
      >
        {matches.map((reference, index) => (
          <button
            key={reference.key}
            ref={index === active ? selected : undefined}
            id={`${id}-${index}`}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={index === active}
            aria-label={`${reference.label} ${reference.detail}`}
            className="chat-mention-option"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onSelect(reference)}
          >
            <span className="chat-mention-marker" aria-hidden="true">
              {reference.kind === 'workspace' ? '#' : '@'}
            </span>
            <span className="chat-mention-copy">
              <strong>{reference.label}</strong>
              <small>{reference.detail}</small>
              {reference.kind === 'workspace' && <small>{reference.source}</small>}
            </span>
          </button>
        ))}
      </div>
      <div className="chat-mention-note">
        Visible context only; recipient and access stay unchanged.
      </div>
    </div>,
    document.body,
  );
}

export function useMentionCompletion({
  familiars,
  familiarId,
  value,
  onValueChange,
  textareaRef,
  disabled = false,
}: MentionCompletionProps): {
  textareaProps: ComposerTextareaProps;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  suggestions: ReactNode;
} {
  const id = `mention-${useId()}`;
  const [selection, setSelection] = useState({ value, start: 0, end: 0, focused: false });
  const [composing, setComposing] = useState(false);
  const composition = useRef(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [navigation, setNavigation] = useState({ key: '', index: 0 });
  const restoreCaret = useRef<number | null>(null);

  function readSelection() {
    const field = textareaRef.current;
    if (!field) return;
    const next = {
      value: field.value,
      start: field.selectionStart,
      end: field.selectionEnd,
      focused: document.activeElement === field,
    };
    setSelection((previous) =>
      previous.value === next.value &&
      previous.start === next.start &&
      previous.end === next.end &&
      previous.focused === next.focused
        ? previous
        : next,
    );
  }

  useLayoutEffect(() => {
    if (restoreCaret.current !== null) {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(restoreCaret.current, restoreCaret.current);
      restoreCaret.current = null;
    }
    readSelection();
  });

  const token =
    !disabled && !composing && selection.focused && selection.value === value
      ? mentionToken(value, selection.start, selection.end)
      : null;
  const tokenKey = token ? JSON.stringify([token.start, token.end, token.query]) : '';
  const matches = token
    ? matchContextReferences(contextReferences(familiars, familiarId), token.query)
    : [];
  const navigationKey = JSON.stringify([
    value,
    tokenKey,
    matches.map((item) => [item.key, item.text]),
  ]);
  const active = navigation.key === navigationKey ? navigation.index : 0;
  const open = !!token && dismissed !== tokenKey && matches.length > 0;

  useLayoutEffect(() => {
    if (dismissed !== null && dismissed !== tokenKey) setDismissed(null);
  }, [dismissed, tokenKey]);

  function select(reference: ContextReference) {
    if (!token || !open || composition.current) return;
    const inserted = insertContextReference(value, token.start, token.end, reference);
    restoreCaret.current = inserted.caret;
    setDismissed(tokenKey);
    onValueChange(inserted.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composition.current && event.key === 'Enter') event.preventDefault();
    if (composition.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(tokenKey);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setNavigation({
        key: navigationKey,
        index: (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length,
      });
    } else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();
      const reference = matches[active];
      if (reference) select(reference);
    }
  }

  return {
    textareaProps: {
      onSelect: readSelection,
      onFocus: readSelection,
      onBlur: () => setSelection((previous) => ({ ...previous, focused: false })),
      onCompositionStart: () => {
        composition.current = true;
        setComposing(true);
      },
      onCompositionEnd: () => {
        composition.current = false;
        setComposing(false);
        readSelection();
      },
      'aria-controls': open ? id : undefined,
      'aria-expanded': open,
      'aria-autocomplete': 'list',
      'aria-activedescendant': open ? `${id}-${active}` : undefined,
    },
    onKeyDown,
    suggestions: open ? (
      <MentionPanel
        id={id}
        textareaRef={textareaRef}
        matches={matches}
        active={active}
        onSelect={select}
      />
    ) : null,
  };
}
