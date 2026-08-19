/**
 * The familiar surface, shaped exactly as `@opencoven/cave-client` exposes it.
 *
 * These are declarations, not a dependency. Phase 0 documents the typed package
 * boundary without linking to it: `src/lib/cave-client-boundary.ts` records
 * that, and a specification guard fails if `@opencoven/cave-client` appears in
 * package.json. So the shapes live here, and the cross-repository canary
 * compiles a harness against the *packed* SDK that reads every field below. If
 * the SDK renames or drops one, that harness stops compiling and CI says so.
 *
 * That is what makes "mirrors the SDK" a checkable claim rather than a comment.
 *
 * The upstream names are kept exactly -- `CaveFamiliar`, `CaveContractReport`,
 * `CaveFamiliarAnalytics` -- so that when the dependency is finally added, the
 * change is deleting this file and adding an import, not a rename across every
 * call site.
 *
 * Cave serves all of this today:
 *   GET /api/familiars                          the roster
 *   GET /api/familiars/:id/contract             the Familiar Contract report
 *   GET /api/familiars/:id/execution-analytics  run history
 */

/** Mirrors `CaveFamiliar`. Roster fields arrive snake_case; the SDK maps them. */
export type CaveFamiliar = {
  id: string;
  displayName: string;
  role: string;
  description?: string;
  pronouns?: string;
  status?: string;
  lastSeen?: string;
  activeSessions?: number;
  memoryFreshness?: string;
};

/** Mirrors `CAVE_FAMILIAR_PROPERTIES`: the five normative properties, in order. */
export const CAVE_FAMILIAR_PROPERTIES = [
  'Named Identity',
  'Defined Purpose',
  'Bounded Authority',
  'Persistent Memory',
  'Human Belonging',
] as const;

export type CaveContractFile = 'SOUL.md' | 'IDENTITY.md' | 'ward.toml' | 'MEMORY.md' | 'cross-file';

export type CaveContractViolation = {
  file: CaveContractFile;
  field: string;
  message: string;
};

export type CavePropertyCoverage = {
  property: string;
  pass: boolean;
};

/**
 * Mirrors `CaveContractReport`.
 *
 * `pass` is true when there are zero hard violations. Warnings do not fail a
 * contract, which is the whole reason they are a separate list: a familiar that
 * keeps no memory is a real answer to a real question, not a malformed one.
 */
export type CaveContractReport = {
  specVersion: string;
  pass: boolean;
  properties: CavePropertyCoverage[];
  violations: CaveContractViolation[];
  warnings: CaveContractViolation[];
};

/** Mirrors `CAVE_ANALYTICS_WINDOWS`. */
export const CAVE_ANALYTICS_WINDOWS = ['7d', '14d', '8w', 'all'] as const;

export type CaveAnalyticsWindowKey = (typeof CAVE_ANALYTICS_WINDOWS)[number];

export type CaveExecutionSlice = {
  key: string;
  label?: string;
  attempts: number;
  completed: number;
  failed: number;
  cancelled: number;
  successRate: number | null;
  medianDurationMs?: number;
  totalTokens?: number;
  costUsd?: number;
  toolCalls: number;
  toolFailures: number;
};

export type CaveExecutionWindow = {
  attempts: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** Null, not zero, when nothing ran: a rate over no attempts is unknown. */
  successRate: number | null;
  medianDurationMs?: number;
  p95DurationMs?: number;
  totalTokens?: number;
  costUsd?: number;
  toolCalls: number;
  toolFailures: number;
  models: CaveExecutionSlice[];
  harnesses: CaveExecutionSlice[];
};

export type CaveExecutionAttempt = {
  id: string;
  sessionId?: string;
  executionKind: string;
  occurredAt: string;
  harnessId: string;
  requestedModel?: string;
  confirmedModel?: string;
  status: 'completed' | 'failed' | 'cancelled';
  durationMs?: number;
  totalTokens?: number;
  costUsd?: number;
  toolCalls: number;
  toolFailures: number;
};

/**
 * Whether the history behind these numbers is complete.
 *
 * Rendered rather than hidden. A success rate drawn from a partial import is a
 * different claim from one drawn from all of it, and a reader who cannot tell
 * them apart will believe the wrong one.
 */
export type CaveExecutionBackfill = {
  state: 'complete' | 'partial' | 'not-started';
  imported: number;
  remaining?: number;
};

export type CaveFamiliarAnalytics = {
  generatedAt: string;
  windows: Partial<Record<CaveAnalyticsWindowKey, CaveExecutionWindow>>;
  recentAttempts: CaveExecutionAttempt[];
  backfill: CaveExecutionBackfill;
};

// ── Fixtures ────────────────────────────────────────────────────────────────

function window(
  attempts: number,
  completed: number,
  failed: number,
  cancelled: number,
  extra: Partial<CaveExecutionWindow>,
): CaveExecutionWindow {
  return {
    attempts,
    completed,
    failed,
    cancelled,
    successRate: attempts === 0 ? null : completed / attempts,
    toolCalls: 0,
    toolFailures: 0,
    models: [],
    harnesses: [],
    ...extra,
  };
}

const CODY_ANALYTICS: CaveFamiliarAnalytics = {
  generatedAt: '2026-08-19T07:12:00Z',
  windows: {
    '7d': window(48, 41, 5, 2, {
      medianDurationMs: 42_000,
      p95DurationMs: 186_000,
      totalTokens: 1_284_000,
      costUsd: 4.82,
      toolCalls: 612,
      toolFailures: 19,
      models: [
        {
          key: 'claude-opus-5',
          label: 'Opus 5',
          attempts: 31,
          completed: 28,
          failed: 2,
          cancelled: 1,
          successRate: 28 / 31,
          medianDurationMs: 51_000,
          totalTokens: 940_000,
          costUsd: 3.9,
          toolCalls: 430,
          toolFailures: 12,
        },
        {
          key: 'claude-sonnet-5',
          label: 'Sonnet 5',
          attempts: 17,
          completed: 13,
          failed: 3,
          cancelled: 1,
          successRate: 13 / 17,
          medianDurationMs: 28_000,
          totalTokens: 344_000,
          costUsd: 0.92,
          toolCalls: 182,
          toolFailures: 7,
        },
      ],
      harnesses: [
        {
          key: 'claude-code',
          label: 'Claude Code',
          attempts: 44,
          completed: 39,
          failed: 4,
          cancelled: 1,
          successRate: 39 / 44,
          toolCalls: 588,
          toolFailures: 17,
        },
        {
          key: 'cli',
          label: 'Dev CLI',
          attempts: 4,
          completed: 2,
          failed: 1,
          cancelled: 1,
          successRate: 0.5,
          toolCalls: 24,
          toolFailures: 2,
        },
      ],
    }),
    '14d': window(96, 84, 8, 4, {
      medianDurationMs: 39_000,
      p95DurationMs: 172_000,
      totalTokens: 2_460_000,
      costUsd: 9.1,
      toolCalls: 1_190,
      toolFailures: 34,
    }),
    '8w': window(402, 361, 27, 14, {
      medianDurationMs: 37_500,
      p95DurationMs: 168_000,
      totalTokens: 10_900_000,
      costUsd: 38.44,
      toolCalls: 5_020,
      toolFailures: 131,
    }),
    all: window(917, 826, 61, 30, {
      medianDurationMs: 36_800,
      p95DurationMs: 171_000,
      totalTokens: 24_600_000,
      costUsd: 86.2,
      toolCalls: 11_400,
      toolFailures: 288,
    }),
  },
  recentAttempts: [
    {
      id: 'x9',
      sessionId: 's-4412',
      executionKind: 'assistant-response',
      occurredAt: '2026-08-19T06:58:00Z',
      harnessId: 'claude-code',
      requestedModel: 'claude-opus-5',
      confirmedModel: 'claude-opus-5',
      status: 'completed',
      durationMs: 47_200,
      totalTokens: 38_400,
      costUsd: 0.16,
      toolCalls: 14,
      toolFailures: 0,
    },
    {
      id: 'x8',
      sessionId: 's-4411',
      executionKind: 'assistant-response',
      occurredAt: '2026-08-19T06:31:00Z',
      harnessId: 'claude-code',
      requestedModel: 'claude-sonnet-5',
      confirmedModel: 'claude-sonnet-5',
      status: 'failed',
      durationMs: 12_800,
      totalTokens: 9_100,
      costUsd: 0.02,
      toolCalls: 3,
      toolFailures: 2,
    },
    {
      id: 'x7',
      sessionId: 's-4409',
      executionKind: 'assistant-response',
      occurredAt: '2026-08-19T05:47:00Z',
      harnessId: 'claude-code',
      requestedModel: 'claude-opus-5',
      confirmedModel: 'claude-opus-5',
      status: 'completed',
      durationMs: 88_400,
      totalTokens: 71_200,
      costUsd: 0.31,
      toolCalls: 29,
      toolFailures: 1,
    },
    {
      id: 'x6',
      sessionId: 's-4404',
      executionKind: 'assistant-response',
      occurredAt: '2026-08-19T04:58:00Z',
      harnessId: 'cli',
      requestedModel: 'claude-opus-5',
      status: 'cancelled',
      durationMs: 4_100,
      toolCalls: 1,
      toolFailures: 0,
    },
  ],
  // Deliberately partial, so the surface has to say so.
  backfill: { state: 'partial', imported: 402, remaining: 168 },
};

const ASTRA_ANALYTICS: CaveFamiliarAnalytics = {
  generatedAt: '2026-08-19T07:12:00Z',
  windows: {
    '7d': window(12, 12, 0, 0, {
      medianDurationMs: 96_000,
      p95DurationMs: 240_000,
      totalTokens: 512_000,
      costUsd: 2.1,
      toolCalls: 148,
      toolFailures: 2,
      harnesses: [
        {
          key: 'claude-code',
          label: 'Claude Code',
          attempts: 12,
          completed: 12,
          failed: 0,
          cancelled: 0,
          successRate: 1,
          toolCalls: 148,
          toolFailures: 2,
        },
      ],
    }),
    '14d': window(21, 20, 1, 0, {
      totalTokens: 880_000,
      costUsd: 3.6,
      toolCalls: 260,
      toolFailures: 4,
    }),
    '8w': window(88, 84, 3, 1, {
      totalTokens: 3_100_000,
      costUsd: 12.9,
      toolCalls: 980,
      toolFailures: 16,
    }),
    all: window(140, 133, 5, 2, {
      totalTokens: 4_800_000,
      costUsd: 19.4,
      toolCalls: 1_510,
      toolFailures: 27,
    }),
  },
  recentAttempts: [
    {
      id: 'a4',
      executionKind: 'assistant-response',
      occurredAt: '2026-08-19T03:12:00Z',
      harnessId: 'claude-code',
      confirmedModel: 'claude-opus-5',
      status: 'completed',
      durationMs: 112_000,
      totalTokens: 84_000,
      costUsd: 0.36,
      toolCalls: 22,
      toolFailures: 0,
    },
  ],
  backfill: { state: 'complete', imported: 140 },
};

/**
 * Echo has never run. Every window is empty, so every rate is null rather than
 * zero -- the surface has to say "no runs yet" instead of "0% success", which
 * would be an accusation rather than a fact.
 */
const ECHO_ANALYTICS: CaveFamiliarAnalytics = {
  generatedAt: '2026-08-19T07:12:00Z',
  windows: {
    '7d': window(0, 0, 0, 0, {}),
    '14d': window(0, 0, 0, 0, {}),
    '8w': window(0, 0, 0, 0, {}),
    all: window(0, 0, 0, 0, {}),
  },
  recentAttempts: [],
  backfill: { state: 'not-started', imported: 0 },
};

export const CAVE_FAMILIAR_ANALYTICS: Readonly<Record<string, CaveFamiliarAnalytics>> = {
  cody: CODY_ANALYTICS,
  astra: ASTRA_ANALYTICS,
  echo: ECHO_ANALYTICS,
};

/** Contract reports. Echo's fails one property and warns on another. */
export const CAVE_FAMILIAR_CONTRACTS: Readonly<Record<string, CaveContractReport>> = {
  cody: {
    specVersion: '0.1.0',
    pass: true,
    properties: CAVE_FAMILIAR_PROPERTIES.map((property) => ({ property, pass: true })),
    violations: [],
    warnings: [],
  },
  astra: {
    specVersion: '0.1.0',
    pass: true,
    properties: CAVE_FAMILIAR_PROPERTIES.map((property) => ({ property, pass: true })),
    violations: [],
    warnings: [
      {
        file: 'ward.toml',
        field: 'approval_tiers.auto',
        message: 'No automatic tier declared, so every action waits for you.',
      },
    ],
  },
  echo: {
    specVersion: '0.1.0',
    pass: false,
    properties: CAVE_FAMILIAR_PROPERTIES.map((property) => ({
      property,
      pass: property !== 'Persistent Memory',
    })),
    violations: [
      {
        file: 'MEMORY.md',
        field: 'memory',
        message: 'MEMORY.md is absent, so nothing is kept between chats.',
      },
    ],
    warnings: [],
  },
};

/** Roster records, as `GET /api/familiars` would return them once mapped. */
export const CAVE_FAMILIAR_RECORDS: Readonly<Record<string, CaveFamiliar>> = {
  cody: {
    id: 'cody',
    displayName: 'Cody',
    role: 'Implementation',
    pronouns: 'he/him',
    status: 'working',
    lastSeen: '2026-08-19T06:58:00Z',
    activeSessions: 2,
    memoryFreshness: '11 minutes ago',
  },
  astra: {
    id: 'astra',
    displayName: 'Astra',
    role: 'Research',
    pronouns: 'she/her',
    status: 'available',
    lastSeen: '2026-08-19T03:12:00Z',
    activeSessions: 0,
    memoryFreshness: '2 hours ago',
  },
  echo: {
    id: 'echo',
    displayName: 'Echo',
    role: 'Correspondence',
    pronouns: 'they/them',
    status: 'offline',
    lastSeen: '2026-08-17T18:04:00Z',
    activeSessions: 0,
  },
};

// ── Presentation helpers ────────────────────────────────────────────────────

/** A rate, or the reason there isn't one. Never "0%" for "nothing ran". */
export function formatSuccessRate(window: CaveExecutionWindow | undefined): string {
  if (window === undefined || window.successRate === null) {
    return '—';
  }

  return `${Math.round(window.successRate * 100)}%`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return '—';
  }

  if (ms < 1000) {
    return `${ms}ms`;
  }

  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatTokens(total: number | undefined): string {
  if (total === undefined) {
    return '—';
  }

  if (total >= 1_000_000) {
    return `${(total / 1_000_000).toFixed(1)}M`;
  }

  if (total >= 1_000) {
    return `${Math.round(total / 1_000)}k`;
  }

  return String(total);
}

export function formatCost(usd: number | undefined): string {
  return usd === undefined ? '—' : `$${usd.toFixed(2)}`;
}

/** What the backfill state means for the numbers beside it. */
export function backfillNote(backfill: CaveExecutionBackfill): string | null {
  if (backfill.state === 'complete') {
    return null;
  }

  if (backfill.state === 'not-started') {
    return 'No run history has been imported yet, so these windows are empty rather than zero.';
  }

  const remaining = backfill.remaining ?? 0;

  return `Imported ${backfill.imported.toLocaleString()} runs, ${remaining.toLocaleString()} still to read. These figures will move.`;
}
