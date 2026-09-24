import { getCurrentWindow } from '@tauri-apps/api/window';

import { canUseTauriCommands } from './desktop-host';

/** The window's own name, as `tauri.conf.json` gives it. */
export const APP_TITLE = 'OpenCoven Chat';

export type SetWindowTitle = (title: string) => void;

/**
 * The window title: the familiar being shown, after a count of runs that
 * ended elsewhere and have not been looked at, so a window in the background
 * says a reply is waiting.
 */
export function windowTitle(familiarName: string | undefined, finished: number): string {
  const count = finished > 0 ? `(${finished}) ` : '';
  return familiarName ? `${count}${familiarName} — ${APP_TITLE}` : `${count}${APP_TITLE}`;
}

const logFailure = (failure: unknown) => console.error('Could not set the window title:', failure);

/**
 * Sets the title on the document and, inside the desktop host, on the native
 * window. The title is cosmetic: a host that refuses it is logged, never
 * thrown, since `getCurrentWindow` itself throws when the host has not
 * described the window.
 */
export const setWindowTitle: SetWindowTitle = (title) => {
  if (typeof document !== 'undefined') document.title = title;
  if (!canUseTauriCommands()) return;
  try {
    void getCurrentWindow().setTitle(title).catch(logFailure);
  } catch (failure) {
    logFailure(failure);
  }
};
