import { useEffect } from 'react';

export const LEFT_RAIL_SHORTCUT = 'Meta+\\ Control+\\';
export const RIGHT_RAIL_SHORTCUT = 'Meta+Shift+\\ Control+Shift+\\';
export const LEFT_RAIL_HINT = 'Toggle familiars (Cmd/Ctrl+\\)';
export const RIGHT_RAIL_HINT = 'Toggle inspector (Cmd/Ctrl+Shift+\\)';
export const SEARCH_SHORTCUT = 'Meta+K Control+K';
export const STEP_SHORTCUT = 'Meta+[ Meta+] Control+[ Control+]';
export const SEARCH_HINT = 'Search familiars (Cmd/Ctrl+K)';

/** A modifier chord the shell owns, ignored while composing text or a dialog is open. */
function shellChord(event: KeyboardEvent, code: string, key: string): boolean {
  return !(
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    event.altKey ||
    !(event.metaKey || event.ctrlKey) ||
    (event.code !== code && event.key.toLowerCase() !== key) ||
    document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')
  );
}

export function useRailShortcuts(toggleLeft: () => void, toggleRight: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shellChord(event, 'Backslash', '\\')) return;
      event.preventDefault();
      if (event.shiftKey) toggleRight();
      else toggleLeft();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleLeft, toggleRight]);
}

/**
 * Typing while nothing editable has focus starts a message: the handler gets
 * the character, puts it in the draft and focuses the composer, and the
 * keystroke's default is suppressed so the letter is not delivered twice.
 * Chords, function keys, and anything inside a dialog or menu are left alone.
 */
export function useTypeToCompose(compose: (key: string) => boolean) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key.length !== 1 ||
        event.key === ' '
      )
        return;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) ||
          active.closest('dialog[open], [role="dialog"], [role="menu"], [role="listbox"]'))
      )
        return;
      if (compose(event.key)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [compose]);
}

/** Cmd/Ctrl+[ and Cmd/Ctrl+] step to the previous or next familiar in the list. */
export function useStepShortcut(step: (direction: -1 | 1) => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.shiftKey) return;
      const direction = shellChord(event, 'BracketLeft', '[')
        ? -1
        : shellChord(event, 'BracketRight', ']')
          ? 1
          : 0;
      if (!direction) return;
      event.preventDefault();
      step(direction);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [step]);
}

/** Cmd/Ctrl+K reaches the familiar search from anywhere in the shell. */
export function useSearchShortcut(focusSearch: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.shiftKey || !shellChord(event, 'KeyK', 'k')) return;
      event.preventDefault();
      focusSearch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusSearch]);
}
