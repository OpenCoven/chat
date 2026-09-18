import { useEffect } from 'react';

export const LEFT_RAIL_SHORTCUT = 'Meta+\\ Control+\\';
export const RIGHT_RAIL_SHORTCUT = 'Meta+Shift+\\ Control+Shift+\\';
export const LEFT_RAIL_HINT = 'Toggle familiars (Cmd/Ctrl+\\)';
export const RIGHT_RAIL_HINT = 'Toggle inspector (Cmd/Ctrl+Shift+\\)';

export function useRailShortcuts(toggleLeft: () => void, toggleRight: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey) ||
        (event.code !== 'Backslash' && event.key !== '\\') ||
        document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')
      ) {
        return;
      }
      event.preventDefault();
      if (event.shiftKey) toggleRight();
      else toggleLeft();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleLeft, toggleRight]);
}
