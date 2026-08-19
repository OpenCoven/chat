/**
 * Mock familiars, shaped by the Familiar Contract rather than invented.
 *
 * The fields below are not a designer's guess at what a familiar has. They come
 * from the contract validator Cave ships (`src/lib/familiar-contract.ts`,
 * spec v0.1.0), which checks four files against five normative properties:
 *
 *   SOUL.md      a declared name, a purpose, Core Work, What I Am Not,
 *                My Boundaries
 *   IDENTITY.md  a name, a Creature declaration, a purpose statement
 *   ward.toml    [meta] version/familiar/person, [protected] files and
 *                invariants, [editable] paths, [approval_tiers] auto and
 *                human_review
 *   MEMORY.md    present (its absence is a warning, not a violation)
 *
 * The read-model fields — role, description, pronouns, status, emoji — mirror
 * what the Cave client v1 familiar record exposes.
 *
 * Editing is designed around one fact from that validator: `familiar.name` and
 * `familiar.person` must be declared invariants in the protected surface. So
 * the edit form shows them as locked rather than offering a field that a
 * compliant familiar may not accept.
 */

/** The five normative properties. Order matches the contract. */
export const CONTRACT_PROPERTIES = [
  'Named Identity',
  'Defined Purpose',
  'Bounded Authority',
  'Persistent Memory',
  'Human Belonging',
] as const;

export type ContractProperty = (typeof CONTRACT_PROPERTIES)[number];

/** The four files the contract evaluates. */
export type ContractFileName = 'SOUL.md' | 'IDENTITY.md' | 'ward.toml' | 'MEMORY.md';

export type ContractCheck = {
  property: ContractProperty;
  pass: boolean;
  /** Which file carries the evidence, for the reader's benefit. */
  file: ContractFileName;
  note: string;
};

export type MockFamiliar = {
  id: string;
  /** Protected invariant. Not editable from this surface. */
  name: string;
  /** The person binding. Protected invariant; Human Belonging depends on it. */
  person: string;
  /** IDENTITY.md requires a creature declaration. */
  creature: string;
  role: string;
  description: string;
  pronouns: string;
  emoji: string;
  status: 'available' | 'working' | 'offline';
  soul: {
    purpose: string;
    coreWork: string[];
    whatIAmNot: string[];
    boundaries: string[];
  };
  ward: {
    version: string;
    protectedFiles: ContractFileName[];
    invariants: string[];
    editablePaths: string[];
    approvalTiers: {
      /** Tier 0. Required to exist, may be empty. */
      auto: string[];
      /** Tier 2. Required. */
      humanReview: string[];
    };
  };
  memory: { entries: number; lastWritten: string } | null;
};

const CORE_PROTECTED: ContractFileName[] = ['SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'ward.toml'];

export const MOCK_FAMILIARS: MockFamiliar[] = [
  {
    id: 'astra',
    name: 'Astra',
    person: 'Val Alexander',
    creature: 'Cartographer',
    role: 'Research and synthesis',
    description: 'Reads widely, keeps a source ledger, and refuses to assert what it has not read.',
    pronouns: 'she/her',
    emoji: '\u{1F5FA}',
    status: 'available',
    soul: {
      purpose: 'To map unfamiliar territory so a decision can be made on evidence.',
      coreWork: [
        'Gather sources and record where each claim came from',
        'Separate what is established from what is inferred',
        'Write findings that survive being read by a sceptic',
      ],
      whatIAmNot: [
        'Not a summariser that flattens disagreement',
        'Not a source of claims it has not checked',
      ],
      boundaries: [
        'Never presents an inference as a citation',
        'Never edits code outside a research worktree',
      ],
    },
    ward: {
      version: '0.3.1',
      protectedFiles: CORE_PROTECTED,
      invariants: ['familiar.name', 'familiar.person', 'soul.boundaries'],
      editablePaths: ['TOOLS.md', 'HEARTBEAT.md', 'notes/'],
      approvalTiers: {
        auto: ['read files', 'search the web', 'write to notes/'],
        humanReview: ['publish a finding', 'open a pull request'],
      },
    },
    memory: { entries: 412, lastWritten: '2 hours ago' },
  },
  {
    id: 'cody',
    name: 'Cody',
    person: 'Val Alexander',
    creature: 'Artificer',
    role: 'Implementation',
    description: 'Writes and reviews code, and will not claim a thing passes without running it.',
    pronouns: 'he/him',
    emoji: '\u{1F527}',
    status: 'working',
    soul: {
      purpose: 'To turn a decided design into working, verified software.',
      coreWork: [
        'Implement against a written plan',
        'Run the tests before reporting a result',
        'Leave the tree cleaner than it was found',
      ],
      whatIAmNot: ['Not a designer of record', 'Not a reviewer of its own merges'],
      boundaries: [
        'Never reports a passing suite it did not run',
        'Never force-pushes a shared branch',
      ],
    },
    ward: {
      version: '0.4.0',
      protectedFiles: CORE_PROTECTED,
      invariants: ['familiar.name', 'familiar.person'],
      editablePaths: ['TOOLS.md', 'scratch/'],
      approvalTiers: {
        auto: ['run tests', 'read files', 'write to scratch/'],
        humanReview: ['push a branch', 'merge a pull request', 'change CI'],
      },
    },
    memory: { entries: 1_284, lastWritten: '11 minutes ago' },
  },
  {
    id: 'echo',
    name: 'Echo',
    person: 'Val Alexander',
    creature: 'Herald',
    role: 'Correspondence',
    description: 'Drafts and triages written communication, and never sends without a gesture.',
    pronouns: 'they/them',
    emoji: '\u{1F4EC}',
    status: 'offline',
    soul: {
      purpose: 'To keep correspondence answered without answering as the person.',
      coreWork: ['Triage an inbox', 'Draft replies for review', 'Track what is owed and to whom'],
      whatIAmNot: ['Not authorised to speak as the person', 'Not a filter that deletes silently'],
      boundaries: ['Never sends without an explicit gesture', 'Never deletes a message outright'],
    },
    ward: {
      version: '0.2.0',
      protectedFiles: CORE_PROTECTED,
      invariants: ['familiar.name', 'familiar.person'],
      editablePaths: ['TOOLS.md'],
      approvalTiers: { auto: ['read mail', 'draft a reply'], humanReview: ['send', 'archive'] },
    },
    // No MEMORY.md. A warning, not a violation -- and the reason Persistent
    // Memory shows as failing on this one.
    memory: null,
  },
];

/**
 * Evaluate a familiar against the five properties.
 *
 * Mirrors the validator's logic at the level this demo needs: each property
 * passes when the fields that establish it are present. The point is that the
 * verdict is derived from the familiar's own contract data rather than stored
 * as a badge someone set by hand.
 */
export function contractReport(familiar: MockFamiliar): ContractCheck[] {
  const hasInvariant = (name: string) => familiar.ward.invariants.includes(name);

  return [
    {
      property: 'Named Identity',
      file: 'SOUL.md',
      pass: familiar.name.trim().length > 0 && familiar.creature.trim().length > 0,
      note: familiar.creature
        ? `Declared as ${familiar.name}, a ${familiar.creature.toLowerCase()}.`
        : 'No creature declaration in IDENTITY.md.',
    },
    {
      property: 'Defined Purpose',
      file: 'SOUL.md',
      pass:
        familiar.soul.purpose.trim().length > 0 &&
        familiar.soul.coreWork.length > 0 &&
        familiar.soul.whatIAmNot.length > 0,
      note:
        familiar.soul.whatIAmNot.length > 0
          ? `${familiar.soul.coreWork.length} core work items, ${familiar.soul.whatIAmNot.length} explicit non-goals.`
          : 'What I Am Not is empty. Purpose needs a boundary to be defined.',
    },
    {
      property: 'Bounded Authority',
      file: 'ward.toml',
      pass:
        familiar.soul.boundaries.length > 0 &&
        familiar.ward.approvalTiers.humanReview.length > 0 &&
        familiar.ward.editablePaths.length > 0,
      note:
        familiar.ward.approvalTiers.humanReview.length > 0
          ? `${familiar.ward.approvalTiers.humanReview.length} actions held for human review.`
          : 'No human review tier. Tier 2 is required.',
    },
    {
      property: 'Persistent Memory',
      file: 'MEMORY.md',
      pass: familiar.memory !== null,
      note: familiar.memory
        ? `${familiar.memory.entries.toLocaleString()} entries, last written ${familiar.memory.lastWritten}.`
        : 'MEMORY.md is absent. The contract warns rather than fails, but nothing persists.',
    },
    {
      property: 'Human Belonging',
      file: 'ward.toml',
      pass: familiar.person.trim().length > 0 && hasInvariant('familiar.person'),
      note: hasInvariant('familiar.person')
        ? `Bound to ${familiar.person}, declared as a protected invariant.`
        : 'The person binding is not a protected invariant.',
    },
  ];
}

/** Templates offered when creating a familiar, mirroring the browse surface. */
export type FamiliarTemplate = {
  id: string;
  name: string;
  creature: string;
  summary: string;
  /** Count shown on the card, as the reference shows integrations. */
  tierCount: number;
};

export const FAMILIAR_TEMPLATES: FamiliarTemplate[] = [
  {
    id: 'researcher',
    name: 'Researcher',
    creature: 'Cartographer',
    summary: 'Reads sources, keeps a ledger, and separates evidence from inference.',
    tierCount: 2,
  },
  {
    id: 'implementer',
    name: 'Implementer',
    creature: 'Artificer',
    summary: 'Works from a written plan and verifies before reporting.',
    tierCount: 3,
  },
  {
    id: 'correspondent',
    name: 'Correspondent',
    creature: 'Herald',
    summary: 'Triages and drafts, and never sends without an explicit gesture.',
    tierCount: 2,
  },
  {
    id: 'archivist',
    name: 'Archivist',
    creature: 'Keeper',
    summary: 'Curates memory, prunes what is stale, and never rewrites a record.',
    tierCount: 1,
  },
];
