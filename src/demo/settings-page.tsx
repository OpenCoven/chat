import { useState } from 'react';

import './familiars-settings.css';

import { MOCK_FAMILIARS } from './mock-familiars';
import { MOCK_CREDENTIAL, MOCK_HEALTH } from './mock-settings';

/**
 * Settings.
 *
 * Every row here traces to one of two sources, and nothing is included because
 * it seemed like a setting an app should have.
 *
 * The approved desktop design spec lists exactly what v1 settings contain:
 * appearance and reduced motion, notifications, startup behaviour, the global
 * quick-chat shortcut, default familiar and project, Cave endpoint and
 * connection diagnostics, paired credential state and re-pair, and application
 * and API version information.
 *
 * The values those rows display come from the Cave client v1 surface: the
 * health endpoint reports service identity, API major and minor, minimum
 * supported client, capabilities, instance id, and whether pairing is
 * required; the credential is a scoped, revocable bearer whose scopes the
 * paired-clients surface lists.
 *
 * Capability gating is the reason the API matters here rather than only the
 * spec. A control for something this Cave does not advertise is hidden, not
 * shown-and-broken.
 */

type Row = { label: string; hint: string; control: React.ReactNode };

function Section({ title, source, rows }: { title: string; source: string; rows: Row[] }) {
  return (
    <section className="set-section">
      <header className="set-section-head">
        <h2>{title}</h2>
        {/* Naming the source is what keeps this page from accreting settings
            nobody decided on. */}
        <span className="set-source">{source}</span>
      </header>
      <div className="set-rows">
        {rows.map((row) => (
          <div key={row.label} className="set-row">
            <div className="set-row-text">
              <span className="set-row-label">{row.label}</span>
              <span className="set-row-hint">{row.hint}</span>
            </div>
            <div className="set-row-control">{row.control}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`set-toggle ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="set-knob" aria-hidden="true" />
    </button>
  );
}

export function SettingsPage() {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [defaultFamiliar, setDefaultFamiliar] = useState(MOCK_FAMILIARS[0]?.id ?? '');

  const supports = (capability: string) =>
    (MOCK_HEALTH.capabilities as readonly string[]).includes(capability);

  return (
    <div className="set-page">
      <header className="set-head">
        <h1>Settings</h1>
        <p className="set-lede">
          Every row below comes from the approved v1 settings list or from what this Cave
          advertises. Controls for capabilities it does not advertise are hidden rather than shown
          and broken.
        </p>
      </header>

      <Section
        title="Appearance"
        source="design spec"
        rows={[
          {
            label: 'Reduce motion',
            hint: 'Removes the streaming caret, the typing indicator, and card arrival.',
            control: (
              <Toggle checked={reducedMotion} onChange={setReducedMotion} label="Reduce motion" />
            ),
          },
        ]}
      />

      <Section
        title="Notifications"
        source="design spec"
        rows={[
          {
            label: 'Notify on completion and attention',
            hint: 'A content-free doorbell. The text is fetched by this device, not carried by the push.',
            control: (
              <Toggle checked={notifications} onChange={setNotifications} label="Notifications" />
            ),
          },
        ]}
      />

      <Section
        title="Startup"
        source="design spec"
        rows={[
          {
            label: 'Launch at login',
            hint: 'Starts hidden and waits for the quick-chat shortcut.',
            control: (
              <Toggle checked={launchAtLogin} onChange={setLaunchAtLogin} label="Launch at login" />
            ),
          },
          {
            label: 'Global quick chat',
            hint: 'Opens a composer over whatever is on screen.',
            control: <kbd className="set-kbd">⌥ Space</kbd>,
          },
        ]}
      />

      <Section
        title="Defaults"
        source="design spec"
        rows={[
          {
            label: 'Default familiar',
            hint: 'Used when a conversation is started without choosing one.',
            control: (
              <select
                className="set-select"
                aria-label="Default familiar"
                value={defaultFamiliar}
                onChange={(event) => setDefaultFamiliar(event.target.value)}
              >
                {MOCK_FAMILIARS.map((familiar) => (
                  <option key={familiar.id} value={familiar.id}>
                    {familiar.name} — {familiar.role}
                  </option>
                ))}
              </select>
            ),
          },
          {
            label: 'Default project',
            hint: 'Scopes new conversations to a project the credential can reach.',
            control: <span className="set-value">None</span>,
          },
        ]}
      />

      <Section
        title="Connection"
        source="client v1 health"
        rows={[
          {
            label: 'Cave instance',
            hint: 'Reported by the health endpoint, not configured here.',
            control: <code className="set-code">{MOCK_HEALTH.instanceId}</code>,
          },
          {
            label: 'API version',
            hint: `Minimum supported client ${MOCK_HEALTH.minimumClientVersion}.`,
            control: <code className="set-code">v{MOCK_HEALTH.apiVersion}</code>,
          },
          {
            label: 'Capabilities',
            hint: 'What this Cave advertises. Absent capabilities hide their controls.',
            control: (
              <span className="set-caps">
                {MOCK_HEALTH.capabilities.map((capability) => (
                  <span key={capability} className="set-cap">
                    {capability}
                  </span>
                ))}
              </span>
            ),
          },
          {
            label: 'Diagnostics',
            hint: 'A copyable report with no credential, address, or message content in it.',
            control: (
              <button type="button" className="set-button">
                Copy report
              </button>
            ),
          },
        ]}
      />

      <Section
        title="Paired credential"
        source="client v1 pairing"
        rows={[
          {
            label: MOCK_CREDENTIAL.label,
            hint: `Paired ${MOCK_CREDENTIAL.createdAt} · last used ${MOCK_CREDENTIAL.lastUsed}`,
            control: (
              <button type="button" className="set-button is-danger">
                Revoke
              </button>
            ),
          },
          {
            label: 'Scopes',
            hint: 'Least privilege. Cave refuses anything outside these regardless of the client.',
            control: (
              <span className="set-caps">
                {MOCK_CREDENTIAL.scopes.map((scope) => (
                  <span key={scope} className="set-cap">
                    {scope}
                  </span>
                ))}
              </span>
            ),
          },
        ]}
      />

      {/* Gated on an advertised capability rather than shown unconditionally. */}
      {supports('github-actions') ? (
        <Section
          title="Privileged actions"
          source="capability: github-actions"
          rows={[
            {
              label: 'Confirm every GitHub action',
              hint: 'Always on. A proposal never fires without a gesture, and this is not negotiable from here.',
              control: <span className="set-value">Required</span>,
            },
          ]}
        />
      ) : null}

      <Section
        title="About"
        source="design spec"
        rows={[
          {
            label: 'OpenCoven Chat',
            hint: 'Phase 1 read-only production app plus proof-of-concept demo surfaces.',
            control: <code className="set-code">0.1.0</code>,
          },
        ]}
      />
    </div>
  );
}
