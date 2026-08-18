import { useMemo, useState } from 'react';

import {
  contractReport,
  FAMILIAR_TEMPLATES,
  MOCK_FAMILIARS,
  type MockFamiliar,
} from './mock-familiars';

/**
 * Familiars surface: browse on the left, detail on the right.
 *
 * The detail panel leads with contract compliance rather than with settings,
 * because the Familiar Contract is what makes a familiar a familiar. A card
 * that showed a name and an avatar and nothing else would be a contacts list.
 */

type Tab = 'contract' | 'identity' | 'authority';

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
        background: `linear-gradient(140deg, hsl(${hue} 70% 30%), hsl(${(hue + 60) % 360} 65% 22%))`,
        borderColor: `hsl(${hue} 70% 45%)`,
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
  const checks = selected ? contractReport(selected) : [];
  const passing = checks.filter((check) => check.pass).length;

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
            const report = contractReport(familiar);
            const passes = report.filter((check) => check.pass).length;

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
                    <span className={`fam-pill ${passes === 5 ? 'is-pass' : 'is-warn'}`}>
                      {passes}/5 contract
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
                <span className={`fam-pill ${passing === 5 ? 'is-pass' : 'is-warn'}`}>
                  {passing}/5 properties
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
              {(['contract', 'identity', 'authority'] as const).map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`fam-tab ${tab === name ? 'is-active' : ''}`}
                  onClick={() => setTab(name)}
                >
                  {name === 'contract'
                    ? 'Contract'
                    : name === 'identity'
                      ? 'Identity'
                      : 'Authority'}
                </button>
              ))}
            </nav>

            <div className="fam-body">
              {tab === 'contract' ? <ContractTab familiar={selected} /> : null}
              {tab === 'identity' ? (
                <IdentityTab familiar={selected} editing={editing} onChange={applyEdit} />
              ) : null}
              {tab === 'authority' ? <AuthorityTab familiar={selected} /> : null}
            </div>
          </>
        ) : (
          <p className="fam-empty">No familiar selected.</p>
        )}
      </section>
    </div>
  );
}

/** The five properties, each with the file that carries its evidence. */
function ContractTab({ familiar }: { familiar: MockFamiliar }) {
  const checks = contractReport(familiar);

  return (
    <div className="fam-section">
      <p className="fam-lede">
        The Familiar Contract defines five normative properties. Each is derived from this
        familiar's own files, not stored as a badge.
      </p>

      <ul className="fam-checks">
        {checks.map((check) => (
          <li key={check.property} className={check.pass ? 'is-pass' : 'is-fail'}>
            <span className="fam-check-mark" aria-hidden="true">
              {check.pass ? '✓' : '⚠'}
            </span>
            <span className="fam-check-body">
              <span className="fam-check-title">
                {check.property}
                <span className="fam-check-file">{check.file}</span>
              </span>
              <span className="fam-check-note">{check.note}</span>
            </span>
          </li>
        ))}
      </ul>

      {checks.some((check) => !check.pass) ? (
        <p className="fam-warn">
          A failing property does not disable the familiar. It means the contract cannot vouch for
          that property, and the reason is stated above rather than hidden behind a score.
        </p>
      ) : null}
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
