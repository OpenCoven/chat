import { useEffect, useState } from 'react';

import {
  APP_CONNECTION_STATE,
  APP_CONNECTION_STATE_SLUG,
  APP_CONNECTION_SUMMARY,
  APP_DISPLAY_NAME,
  APP_METADATA,
  APP_SCAFFOLD_STATUS,
} from './lib/app-metadata';
import { CAVE_CLIENT_BOUNDARY } from './lib/cave-client-boundary';
import { type DesktopHost, desktopHost } from './lib/desktop-host';
import { normalizeRejectionMessage } from './lib/rejection-message';

const BROWSER_PREVIEW_SOURCE = 'Browser preview fallback';
const DESKTOP_IDENTITY_SOURCE = 'Native app_identity command';
const DESKTOP_IDENTITY_UNAVAILABLE = 'Unavailable';
const BROWSER_PREVIEW_STATUS =
  'Browser preview fallback active. Desktop identity is available only inside Tauri.';

type DesktopIdentityView = Readonly<{
  identity: {
    name: string;
    identifier: string;
    phase: string;
  } | null;
  source: string;
  statusTone: 'info' | 'error' | null;
  statusMessage: string | null;
}>;

function previewIdentityView(host: DesktopHost): DesktopIdentityView {
  return {
    identity: host.previewAppIdentity(),
    source: BROWSER_PREVIEW_SOURCE,
    statusTone: 'info',
    statusMessage: BROWSER_PREVIEW_STATUS,
  };
}

function nativeIdentityLoadingView(): DesktopIdentityView {
  return {
    identity: null,
    source: 'Loading native app_identity…',
    statusTone: 'info',
    statusMessage: 'Loading desktop identity from the native host…',
  };
}

function nativeIdentityFailureView(error: unknown): DesktopIdentityView {
  const detail = normalizeRejectionMessage(error, 'The native app_identity command failed.');

  return {
    identity: null,
    source: DESKTOP_IDENTITY_UNAVAILABLE,
    statusTone: 'error',
    statusMessage: `Desktop identity unavailable. ${detail}`,
  };
}

function nativeIdentityView(identity: DesktopIdentityView['identity']): DesktopIdentityView {
  return {
    identity,
    source: DESKTOP_IDENTITY_SOURCE,
    statusTone: null,
    statusMessage: null,
  };
}

type AppProps = Readonly<{
  desktopIdentityHost?: DesktopHost;
}>;

export function App({ desktopIdentityHost = desktopHost }: AppProps) {
  const usesTauriCommands = desktopIdentityHost.canUseTauriCommands();
  const [desktopIdentity, setDesktopIdentity] = useState<DesktopIdentityView>(() =>
    usesTauriCommands ? nativeIdentityLoadingView() : previewIdentityView(desktopIdentityHost),
  );

  useEffect(() => {
    if (!usesTauriCommands) {
      return;
    }

    let isCurrent = true;
    setDesktopIdentity(nativeIdentityLoadingView());

    void desktopIdentityHost
      .readAppIdentity()
      .then((identity) => {
        if (isCurrent) {
          setDesktopIdentity(nativeIdentityView(identity));
        }
      })
      .catch((error) => {
        if (isCurrent) {
          setDesktopIdentity(nativeIdentityFailureView(error));
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [desktopIdentityHost, usesTauriCommands]);

  return (
    <div className="app-shell" data-scaffold-fingerprint={APP_METADATA.fingerprint}>
      <header className="app-header">
        <p className="eyebrow">Phase 0 desktop scaffold</p>
        <h1>{desktopIdentity.identity?.name ?? APP_DISPLAY_NAME}</h1>
        <p className="lede">Production scaffolding for the future OpenCoven desktop chat client.</p>
      </header>

      <main className="app-main">
        <section className="panel" aria-labelledby="connection-state-heading">
          <div className="panel-heading">
            <h2 id="connection-state-heading">Connection state</h2>
            {/*
              Decorative. The accessible state is the output below, so the dot
              reinforces a word that is already there rather than carrying the
              meaning on colour alone.
            */}
            <span
              className="state-badge"
              data-connection-state={APP_CONNECTION_STATE_SLUG}
              aria-hidden="true"
            >
              <span className="state-dot" />
              {APP_CONNECTION_STATE}
            </span>
          </div>
          <output className="connection-summary" aria-label="Connection state" aria-live="polite">
            {APP_CONNECTION_SUMMARY}
          </output>
        </section>

        <section className="panel" aria-labelledby="scaffold-status-heading">
          <h2 id="scaffold-status-heading">Scaffold status</h2>
          <output aria-live="polite">{APP_SCAFFOLD_STATUS}</output>
        </section>

        <section className="panel" aria-labelledby="integration-boundary-heading">
          <h2 id="integration-boundary-heading">Integration boundary</h2>
          <p>
            Future Cave integration must import only from{' '}
            <code>{CAVE_CLIENT_BOUNDARY.packageName}</code>.
          </p>
          <p>{CAVE_CLIENT_BOUNDARY.note}</p>
          <p>{CAVE_CLIENT_BOUNDARY.verification}</p>
        </section>

        <aside className="panel" aria-labelledby="desktop-identity-heading">
          <h2 id="desktop-identity-heading">Desktop identity</h2>
          {desktopIdentity.statusMessage !== null ? (
            <output
              className={`desktop-identity-status desktop-identity-status--${desktopIdentity.statusTone}`}
              aria-label="Desktop identity status"
              role={desktopIdentity.statusTone === 'error' ? 'alert' : 'status'}
              aria-live={desktopIdentity.statusTone === 'error' ? 'assertive' : 'polite'}
            >
              {desktopIdentity.statusMessage}
            </output>
          ) : null}
          <dl className="identity-list">
            <div>
              <dt>Source</dt>
              <dd>{desktopIdentity.source}</dd>
            </div>
            <div>
              <dt>Bundle identifier</dt>
              <dd>{desktopIdentity.identity?.identifier ?? DESKTOP_IDENTITY_UNAVAILABLE}</dd>
            </div>
            <div>
              <dt>Phase</dt>
              <dd>{desktopIdentity.identity?.phase ?? DESKTOP_IDENTITY_UNAVAILABLE}</dd>
            </div>
          </dl>
        </aside>
      </main>
    </div>
  );
}
