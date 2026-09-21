import { useEffect } from 'react';

export const LEFT_RAIL_SHORTCUT = 'Meta+\\ Control+\\';
export const RIGHT_RAIL_SHORTCUT = 'Meta+Shift+\\ Control+Shift+\\';
export const LEFT_RAIL_HINT = 'Toggle familiars (Cmd/Ctrl+\\)';
export const RIGHT_RAIL_HINT = 'Toggle inspector (Cmd/Ctrl+Shift+\\)';
export const SEARCH_SHORTCUT = 'Meta+K Control+K';
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
