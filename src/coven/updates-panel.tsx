import { useSyncExternalStore } from 'react';
import { defaultUpdateStore, type UpdateState, type UpdateStore } from '../lib/updater';
import { CopyButton } from './copy-button';

export function useUpdateState(store: UpdateStore = defaultUpdateStore): UpdateState {
  return useSyncExternalStore(store.subscribe, store.state, store.state);
}

type Copy = Readonly<{ label: string; hint: string }>;

function copyFor(state: UpdateState, runActive: boolean): Copy {
  switch (state.kind) {
    case 'idle':
      return { label: 'Updates', hint: 'Chat checks for a new version when it opens.' };
    case 'checking':
      return { label: 'Checking for updates…', hint: 'Asking for the newest release.' };
    case 'current':
      return { label: 'Up to date', hint: `You have the newest version, ${state.version}.` };
    case 'available':
      return {
        label: `Version ${state.version} is available`,
        hint: runActive
          ? 'Finish or stop the current reply first. Restarting would end it.'
          : `You have ${state.currentVersion}. Chat downloads it, checks its signature, and restarts.`,
      };
    case 'installing':
      return {
        label: 'Updating…',
        hint: `Downloading and checking version ${state.version}. Chat restarts when it's done.`,
      };
    case 'failed':
      return {
        label: state.retry === 'install' ? 'The update failed' : "Couldn't check for updates",
        hint: state.message,
      };
  }
}

/**
 * About › Updates. Nothing installs on its own: a check only reports, and
 * **Restart to update** waits until no reply is running (#356).
 */
export function UpdatesPanel({
  runActive,
  store = defaultUpdateStore,
}: Readonly<{ runActive: boolean; store?: UpdateStore }>) {
  const state = useUpdateState(store);
  const copy = copyFor(state, runActive);
  const busy = state.kind === 'checking' || state.kind === 'installing';
  return (
    <div className="coven-settings-row coven-updates" aria-live="polite">
      <span className="coven-settings-row-copy">
        <span className="coven-settings-row-label">{copy.label}</span>
        <span className="coven-settings-row-hint">{copy.hint}</span>
        {state.kind === 'available' && state.notes ? (
          <details className="coven-updates-notes">
            <summary>What's new</summary>
            <p>{state.notes}</p>
          </details>
        ) : null}
      </span>
      <span className="coven-settings-row-control coven-updates-actions">
        {state.kind === 'failed' ? (
          <CopyButton
            className="coven-updates-copy"
            text={state.detail}
            label="Copy update details"
          />
        ) : null}
        {state.kind === 'available' ? (
          <button
            type="button"
            className="fr-btn fr-btn--primary coven-settings-button"
            disabled={runActive}
            onClick={() => void store.install()}
          >
            Restart to update
          </button>
        ) : (
          <button
            type="button"
            className="fr-btn fr-btn--secondary coven-settings-button"
            disabled={busy}
            onClick={() => void store.check()}
          >
            {state.kind === 'failed'
              ? 'Try again'
              : state.kind === 'current'
                ? 'Check again'
                : 'Check for updates'}
          </button>
        )}
      </span>
    </div>
  );
}
