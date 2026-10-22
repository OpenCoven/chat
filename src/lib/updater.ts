import { invoke } from '@tauri-apps/api/core';
import { canUseTauriCommands, type InvokeCommand } from './desktop-host';

/** What the desktop reports about the newest published release (#356). */
export type UpdateCheck =
  | Readonly<{ available: false; currentVersion: string }>
  | Readonly<{ available: true; currentVersion: string; version: string; notes?: string }>;

export interface Updater {
  check(): Promise<UpdateCheck>;
  /** Downloads, verifies and installs the update, then restarts Chat. */
  install(): Promise<void>;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NOTES_LIMIT = 8 * 1024;

function isUpdateCheck(value: unknown): value is UpdateCheck {
  if (typeof value !== 'object' || value === null) return false;
  const check = value as Record<string, unknown>;
  if (typeof check.currentVersion !== 'string' || !VERSION.test(check.currentVersion)) return false;
  if (check.available === false) return true;
  return (
    check.available === true &&
    typeof check.version === 'string' &&
    VERSION.test(check.version) &&
    (check.notes === undefined ||
      check.notes === null ||
      (typeof check.notes === 'string' && check.notes.length <= NOTES_LIMIT))
  );
}

export function createUpdater(
  options: { available?: () => boolean; invoke?: InvokeCommand } = {},
): Updater {
  const call = options.invoke ?? (invoke as InvokeCommand);
  function requireDesktop() {
    if (!(options.available ?? canUseTauriCommands)())
      throw new Error('Updates are available in the desktop app.');
  }
  return {
    async check() {
      requireDesktop();
      const value = await call('updater_check');
      if (!isUpdateCheck(value)) throw new Error('The desktop returned an invalid update check.');
      if (value.available && typeof value.notes !== 'string') {
        return {
          available: true,
          currentVersion: value.currentVersion,
          version: value.version,
        };
      }
      return value;
    },
    async install() {
      requireDesktop();
      await call('updater_install');
    },
  };
}

export type UpdateState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'checking' }>
  | Readonly<{ kind: 'current'; version: string }>
  | Readonly<{ kind: 'available'; currentVersion: string; version: string; notes?: string }>
  | Readonly<{ kind: 'installing'; version: string }>
  | Readonly<{ kind: 'failed'; message: string; detail: string; retry: 'check' | 'install' }>;

export interface UpdateStore {
  state(): UpdateState;
  subscribe(listener: () => void): () => void;
  /** A quiet check (the one on launch) leaves no failure behind. */
  check(options?: { quiet?: boolean }): Promise<void>;
  install(): Promise<void>;
}

/** The desktop's errors read "Message.\n\nDetails: cause"; the message is what the window shows. */
function failure(error: unknown, retry: 'check' | 'install'): UpdateState {
  const detail = error instanceof Error ? error.message : String(error);
  const message = detail.split('\n\n')[0] || 'Something went wrong.';
  return { kind: 'failed', message, detail, retry };
}

export function createUpdateStore(updater: Updater): UpdateStore {
  let current: UpdateState = { kind: 'idle' };
  const listeners = new Set<() => void>();
  function set(next: UpdateState) {
    current = next;
    for (const listener of listeners) listener();
  }
  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async check(options = {}) {
      if (current.kind === 'checking' || current.kind === 'installing') return;
      const before = current;
      set({ kind: 'checking' });
      try {
        const result = await updater.check();
        set(
          result.available
            ? {
                kind: 'available',
                currentVersion: result.currentVersion,
                version: result.version,
                ...(result.notes ? { notes: result.notes } : {}),
              }
            : { kind: 'current', version: result.currentVersion },
        );
      } catch (error) {
        set(options.quiet ? before : failure(error, 'check'));
      }
    },
    async install() {
      if (current.kind !== 'available') return;
      const offered = current;
      set({ kind: 'installing', version: offered.version });
      try {
        // On success Chat restarts, so this only returns after a failure.
        await updater.install();
      } catch (error) {
        set(failure(error, 'install'));
      }
    },
  };
}

export const defaultUpdateStore = createUpdateStore(createUpdater());
