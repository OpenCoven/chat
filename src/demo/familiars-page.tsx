import { useMemo, useState } from 'react';

import './familiars-settings.css';

import {
  backfillNote,
  CAVE_ANALYTICS_WINDOWS,
  CAVE_FAMILIAR_ANALYTICS,
  CAVE_FAMILIAR_CONTRACTS,
  type CaveAnalyticsWindowKey,
  type CaveContractReport,
  type CaveFamiliarAnalytics,
  formatCost,
  formatDuration,
  formatSuccessRate,
  formatTokens,
} from './minimal-familiar-sdk';
import { FAMILIAR_TEMPLATES, MOCK_FAMILIARS, type MockFamiliar } from './mock-familiars';

/**
 * The contract and analytics come from the shapes @opencoven/cave-client
 * exposes, shared with the Minimal surface rather than duplicated: one set of
 * fixtures, one set of types, one thing to change when the SDK moves.
 *
 * The property notes this page used to show have no SDK equivalent. That is
 * not a loss of detail but a relocation of it: the real report explains itself
 * through `violations` and `warnings`, each naming the file it came from, and
 * keeps the two apart because a violation fails a contract and a warning does
 * not.
 */
const EMPTY_REPORT: CaveContractReport = {
  specVersion: '0.1.0',
  pass: false,
  properties: [],
  violations: [],
  warnings: [],
};

function reportFor(id: string): CaveContractReport {
  return CAVE_FAMILIAR_CONTRACTS[id] ?? EMPTY_REPORT;
}

/**
 * Familiars surface: browse on the left, detail on the right.
 *
 * The detail panel leads with contract compliance rather than with settings,
 * because the Familiar Contract is what makes a familiar a familiar. A card
 * that showed a name and an avatar and nothing else would be a contacts list.
 */

type Tab = 'contract' | 'activity' | 'identity' | 'authority';

function StatusDot({ status }: { status: MockFamiliar['status'] }) {
  return <span className={`fam-status fam-status-${status}`} aria-hidden="true" />;
}

/** A familiar's glyph, tinted from its id so the colour is stable. */
function Glyph({ familiar, size }: { familiar: { id: string; emoji: string }; size: number }) {
  const hue = useMemo(() => {
    let total = 0;
    for (const character of familiar.id) {
      total += character.charCodeAt(0);
    }
    return total % 360;
  }, [familiar.id]);

  return (
    <span
      className="fam-glyph"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.5,
        // Flat. A gradient here would be the same rule broken inline that
        // the stylesheet beside it just stopped breaking.
        background: `hsl(${hue} 42% 26%)`,
        borderColor: `hsl(${hue} 46% 42%)`,
      }}
    >
      {familiar.emoji}
    </span>
  );
}

export function FamiliarsPage() {
  const [familiars, setFamiliars] = useState(MOCK_FAMILIARS);
  const [selectedId, setSelectedId] = useState(MOCK_FAMILIARS[0]?.id ?? '');
  const [tab, setTab] = useState<Tab>('contract');
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');

  const selected = familiars.find((familiar) => familiar.id === selectedId);
  const report = selected ? reportFor(selected.id) : EMPTY_REPORT;
  const passing = report.properties.filter((property) => property.pass).length;
  const analytics = selected ? CAVE_FAMILIAR_ANALYTICS[selected.id] : undefined;

  const visible = familiars.filter((familiar) =>
    `${familiar.name} ${familiar.role}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  function applyEdit(change: Partial<MockFamiliar>) {
    if (!selected) {
      return;
    }

    setFamiliars((current) =>
      current.map((familiar) =>
        familiar.id === selected.id ? { ...familiar, ...change } : familiar,
      ),
    );
  }

  return (
    <div className="fam-page">
      <aside className="fam-browse">
        <header className="fam-browse-head">
          <h1>Familiars</h1>
          <input
            className="fam-search"
            type="search"
            placeholder="Search familiars"
            aria-label="Search familiars"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </header>

        <button type="button" className="fam-create">
          <span className="fam-create-mark" aria-hidden="true" />
          Create blank familiar
        </button>

        <ul className="fam-list">
          {visible.map((familiar) => {
            const card = reportFor(familiar.id);
            const passes = card.properties.filter((property) => property.pass).length;

            return (
              <li key={familiar.id}>
                <button
                  type="button"
                  className={`fam-card ${familiar.id === selectedId ? 'is-active' : ''}`}
                  onClick={() => {
                    setSelectedId(familiar.id);
                    setEditing(false);
                  }}
                >
                  <span className="fam-card-head">
                    <Glyph familiar={familiar} size={30} />
                    <span className="fam-card-name">{familiar.name}</span>
                    <StatusDot status={familiar.status} />
                  </span>
                  <span className="fam-card-role">{familiar.role}</span>
                  <span className="fam-card-foot">
                    <span className={`fam-pill ${card.pass ? 'is-pass' : 'is-warn'}`}>
                      {passes}/{card.properties.length} contract
                    </span>
                    <span className="fam-pill">
                      {familiar.ward.approvalTiers.humanReview.length} held
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="fam-templates">
          <p className="fam-templates-label">Start from a template</p>
          {FAMILIAR_TEMPLATES.map((template) => (
            <button key={template.id} type="button" className="fam-template">
              <span className="fam-template-name">{template.name}</span>
              <span className="fam-template-summary">{template.summary}</span>
              <span className="fam-pill">{template.creature}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="fam-detail">
        {selected ? (
          <>
            <header className="fam-detail-head">
              <div className="fam-detail-title">
                <Glyph familiar={selected} size={44} />
                <div>
                  <h2>
                    {selected.name} <span className="fam-pronouns">{selected.pronouns}</span>
                  </h2>
                  <p className="fam-detail-sub">
                    {selected.creature} · {selected.role} · bound to {selected.person}
                  </p>
                </div>
              </div>

              <div className="fam-detail-actions">
                <span className={`fam-pill ${report.pass ? 'is-pass' : 'is-warn'}`}>
                  {passing}/{report.properties.length} properties
                </span>
                <button
                  type="button"
                  className="fam-button"
                  onClick={() => setEditing((current) => !current)}
                >
                  {editing ? 'Done' : 'Edit familiar'}
                </button>
              </div>
            </header>

            <nav className="fam-tabs" aria-label="Familiar detail">
              {(['contract', 'activity', 'identity', 'authority'] as const).map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`fam-tab ${tab === name ? 'is-active' : ''}`}
                  onClick={() => setTab(name)}
                >
                  {name === 'contract'
                    ? 'Contract'
                    : name === 'activity'
                      ? 'Activity'
                      : name === 'identity'
                        ? 'Identity'
                        : 'Authority'}
                </button>
              ))}
            </nav>

            <div className="fam-body">
              {tab === 'contract' ? <ContractTab report={report} /> : null}
              {tab === 'activity' ? <ActivityTab analytics={analytics} /> : null}
              {tab === 'identity' ? (
                <IdentityTab familiar={selected} editing={editing} onChange={applyEdit} />
              ) : null}
              {tab === 'authority' ? <AuthorityTab familiar={selected} /> : null}
            </div>
          </>
        ) : (
          <p className="fam-detail-empty">No familiar selected.</p>
        )}
      </section>
    </div>
  );
}

/**
 * The Familiar Contract report, as the SDK returns it.
 *
 * Violations and warnings are separate lists because they mean different
 * things. Echo keeping no memory is a violation -- it fails the contract --
 * while Astra declaring no automatic tier is a warning that does not. Folding
 * them into one count would make those two familiars look alike.
 */
function ContractTab({ report }: { report: CaveContractReport }) {
  const passed = report.properties.filter((property) => property.pass).length;

  return (
    <div className="fam-section">
      <p className="fam-lede">
        The Familiar Contract defines five normative properties. This report is what Cave evaluated
        from the familiar's own files — spec {report.specVersion} — not a badge stored against it.
      </p>

      <ul className="fam-checks">
        {report.properties.map((property) => (
          <li key={property.property} className={property.pass ? 'is-pass' : 'is-fail'}>
            <span className="fam-check-mark" aria-hidden="true">
              {property.pass ? '✓' : '⚠'}
            </span>
            <span className="fam-check-body">
              <span className="fam-check-title">{property.property}</span>
              <span className="fam-check-note">{property.pass ? 'Met' : 'Not met'}</span>
            </span>
          </li>
        ))}
      </ul>

      <p className="fam-count">
        {passed} of {report.properties.length} met ·{' '}
        {report.pass ? 'contract met' : 'contract not met'}
      </p>

      {report.violations.length > 0 ? (
        <div className="fam-notes">
          <p className="fam-notes-label">What is missing</p>
          {report.violations.map((violation) => (
            <p key={`${violation.file}:${violation.field}`} className="fam-note is-violation">
              <code>{violation.file}</code> {violation.message}
            </p>
          ))}
        </div>
      ) : null}

      {report.warnings.length > 0 ? (
        <div className="fam-notes">
          {/* Named as advice, because a warning does not fail the contract. */}
          <p className="fam-notes-label">Worth knowing</p>
          {report.warnings.map((warning) => (
            <p key={`${warning.file}:${warning.field}`} className="fam-note">
              <code>{warning.file}</code> {warning.message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Execution analytics, from `GET /api/familiars/:id/execution-analytics`.
 *
 * Two things it will not round off: a window with no attempts says so rather
 * than reporting 0%, because a rate over nothing is unknown; and the backfill
 * state is shown, because figures from a partial import are a different claim
 * from figures drawn from the whole history.
 */
function ActivityTab({ analytics }: { analytics: CaveFamiliarAnalytics | undefined }) {
  const [windowKey, setWindowKey] = useState<CaveAnalyticsWindowKey>('7d');

  if (analytics === undefined) {
    return <p className="fam-empty">No run history has been read for this familiar.</p>;
  }

  const active = analytics.windows[windowKey];
  const note = backfillNote(analytics.backfill);
  const ran = (active?.attempts ?? 0) > 0;

  return (
    <div className="fam-section">
      <fieldset className="fam-windows" aria-label="Time window">
        {CAVE_ANALYTICS_WINDOWS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={key === windowKey}
            className={`fam-window ${key === windowKey ? 'is-active' : ''}`}
            onClick={() => setWindowKey(key)}
          >
            {key}
          </button>
        ))}
      </fieldset>

      {note === null ? null : <p className="fam-backfill">{note}</p>}

      {ran ? (
        <div className="fam-metrics">
          <div className="fam-metric">
            <span className="fam-metric-value">{formatSuccessRate(active)}</span>
            <span className="fam-metric-label">Completed</span>
          </div>
          <div className="fam-metric">
            <span className="fam-metric-value">{active?.attempts ?? 0}</span>
            <span className="fam-metric-label">Runs</span>
          </div>
          <div className="fam-metric">
            <span className="fam-metric-value">{formatDuration(active?.medianDurationMs)}</span>
            <span className="fam-metric-label">Median</span>
          </div>
          <div className="fam-metric">
            <span className="fam-metric-value">{formatTokens(active?.totalTokens)}</span>
            <span className="fam-metric-label">Tokens</span>
          </div>
          <div className="fam-metric">
            <span className="fam-metric-value">{formatCost(active?.costUsd)}</span>
            <span className="fam-metric-label">Cost</span>
          </div>
          <div className="fam-metric">
            <span className="fam-metric-value">{active?.toolFailures ?? 0}</span>
            <span className="fam-metric-label">Tool failures</span>
          </div>
        </div>
      ) : (
        <p className="fam-empty">No runs in this window.</p>
      )}
    </div>
  );
}

/**
 * A field row.
 *
 * Renders a <label> only while editing, because a label with no control is not
 * a label -- it is a heading pretending to be one, and assistive technology is
 * told something untrue.
 */
function EditableField({
  id,
  label,
  hint,
  editing,
  control,
  value,
}: {
  id: string;
  label: string;
  hint?: string;
  editing: boolean;
  control: React.ReactNode;
  value: string;
}) {
  return (
    <div className="fam-field">
      {editing ? (
        <label className="fam-field-label" htmlFor={id}>
          {label}
        </label>
      ) : (
        <span className="fam-field-label">{label}</span>
      )}
      {editing ? control : <span className="fam-value">{value}</span>}
      {hint ? <span className="fam-hint">{hint}</span> : null}
    </div>
  );
}

/** SOUL.md and IDENTITY.md, editable except where the ward protects them. */
function IdentityTab({
  familiar,
  editing,
  onChange,
}: {
  familiar: MockFamiliar;
  editing: boolean;
  onChange: (change: Partial<MockFamiliar>) => void;
}) {
  return (
    <div className="fam-section">
      <div className="fam-locked">
        <p className="fam-locked-title">Protected by the ward</p>
        <dl className="fam-locked-list">
          <div>
            <dt>Name</dt>
            <dd>{familiar.name}</dd>
          </div>
          <div>
            <dt>Person</dt>
            <dd>{familiar.person}</dd>
          </div>
        </dl>
        {/* Both are declared invariants in ward.toml. Offering an input here
            would imply an edit the contract does not permit. */}
        <p className="fam-locked-note">
          <code>familiar.name</code> and <code>familiar.person</code> are declared invariants in{' '}
          <code>ward.toml</code>. Changing either is a ward amendment, not a settings edit.
        </p>
      </div>

      <EditableField
        id="familiar-role"
        label="Role"
        editing={editing}
        value={familiar.role}
        control={
          <input
            id="familiar-role"
            className="fam-input"
            value={familiar.role}
            onChange={(event) => onChange({ role: event.target.value })}
          />
        }
      />

      <EditableField
        id="familiar-creature"
        label="Creature"
        hint="IDENTITY.md requires a creature declaration."
        editing={editing}
        value={familiar.creature}
        control={
          <input
            id="familiar-creature"
            className="fam-input"
            value={familiar.creature}
            onChange={(event) => onChange({ creature: event.target.value })}
          />
        }
      />

      <EditableField
        id="familiar-purpose"
        label="Purpose"
        hint="SOUL.md. Defined Purpose fails without it."
        editing={editing}
        value={familiar.soul.purpose}
        control={
          <textarea
            id="familiar-purpose"
            className="fam-input fam-textarea"
            value={familiar.soul.purpose}
            onChange={(event) =>
              onChange({ soul: { ...familiar.soul, purpose: event.target.value } })
            }
          />
        }
      />

      <FieldList label="Core work" hint="SOUL.md, ## Core Work" items={familiar.soul.coreWork} />
      <FieldList
        label="What I am not"
        hint="SOUL.md, ## What I Am Not. A purpose with no boundary is not defined."
        items={familiar.soul.whatIAmNot}
      />
      <FieldList
        label="Boundaries"
        hint="SOUL.md, ## My Boundaries"
        items={familiar.soul.boundaries}
      />
    </div>
  );
}

/** ward.toml: the protected surface, the editable surface, and the tiers. */
function AuthorityTab({ familiar }: { familiar: MockFamiliar }) {
  return (
    <div className="fam-section">
      <p className="fam-lede">
        <code>ward.toml</code> version {familiar.ward.version}. The ward declares what may never
        change, what may, and which actions wait for a person.
      </p>

      <FieldList
        label="Protected files"
        hint="Must include SOUL.md, IDENTITY.md, MEMORY.md and ward.toml."
        items={familiar.ward.protectedFiles}
      />
      <FieldList
        label="Invariants"
        hint="familiar.name and familiar.person are required."
        items={familiar.ward.invariants}
      />
      <FieldList
        label="Editable paths"
        hint="At least one path must be declared, even if minimal."
        items={familiar.ward.editablePaths}
      />

      <div className="fam-tiers">
        <div className="fam-tier">
          <p className="fam-tier-name">
            Tier 0 <span>auto</span>
          </p>
          <ul>
            {familiar.ward.approvalTiers.auto.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
        <div className="fam-tier is-held">
          <p className="fam-tier-name">
            Tier 2 <span>human review</span>
          </p>
          <ul>
            {familiar.ward.approvalTiers.humanReview.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function FieldList({ label, hint, items }: { label: string; hint: string; items: string[] }) {
  return (
    <div className="fam-field">
      <span className="fam-field-label">{label}</span>
      <ul className="fam-items">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <span className="fam-hint">{hint}</span>
    </div>
  );
}
