import { useEffect, useState } from 'react';

import {
  APP_CONNECTION_STATE,
  APP_CONNECTION_STATE_SLUG,
  APP_CONNECTION_SUMMARY,
  APP_METADATA,
  APP_SCAFFOLD_STATUS,
} from './lib/app-metadata';
import { CAVE_CLIENT_BOUNDARY } from './lib/cave-client-boundary';
import { canUseTauriCommands, fallbackAppIdentity, readAppIdentity } from './lib/desktop-host';

export function App() {
  const [appIdentity, setAppIdentity] = useState(fallbackAppIdentity);

  useEffect(() => {
    if (!canUseTauriCommands()) {
      return;
    }

    let isCurrent = true;

    void readAppIdentity()
      .then((identity) => {
        if (isCurrent) {
          setAppIdentity(identity);
        }
      })
      .catch(() => undefined);

    return () => {
      isCurrent = false;
    };
  }, []);

  return (
    <div className="app-shell" data-scaffold-fingerprint={APP_METADATA.fingerprint}>
      <header className="app-header">
        <p className="eyebrow">Phase 0 desktop scaffold</p>
        <h1>{appIdentity.name}</h1>
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
          <dl className="identity-list">
            <div>
              <dt>Bundle identifier</dt>
              <dd>{appIdentity.identifier}</dd>
            </div>
            <div>
              <dt>Phase</dt>
              <dd>{appIdentity.phase}</dd>
            </div>
          </dl>
        </aside>
      </main>
    </div>
  );
}
