import type { Page, PageCursor } from '@opencoven/sdk-core/browser';

import type { QueryResult } from '../lib/sdk/query-adapter';

export type { Page, PageCursor, QueryResult };

/**
 * The Familiars surface's data-source seam.
 *
 * `FamiliarsShell` reads through this interface rather than module
 * constants. One implementation exists today: `MockFamiliarsSource`
 * (`./mock-source.ts`), wrapping `src/demo/familiars-data.ts` for the demo
 * build and tests. The Cave-backed implementation, and the single mapping
 * from SDK wire types to these view types, land with the SDK bump that
 * exports `CaveFamiliarIdentity`, `CaveFamiliarWard`, and
 * `CaveExecutionDay`; the seam is shaped for it so that arrival is additive.
 *
 * Scoped to Stage 1 (reads only) of
 * `docs/superpowers/plans/2026-09-02-familiars-integration.md`. Send,
 * attention, and mutation members are added by later stages, once Cave
 * serves them.
 */

/** Mirrors `CaveCanonicalFamiliar.status`, defaulted when Cave omits it. */
export type FamiliarStatus = 'available' | 'working' | 'offline';

export type FamiliarSummary = Readonly<{
  id: string;
  name: string;
  role: string;
  description?: string;
  pronouns?: string;
  status: FamiliarStatus;
}>;

/** Which of the four contract files Cave found present. */
export type FamiliarPresence = Readonly<{
  soul: boolean;
  identity: boolean;
  ward: boolean;
  memory: boolean;
}>;

/** IDENTITY.md-derived fields. Absent when Cave withholds or lacks them. */
export type FamiliarIdentity = Readonly<{
  name?: string;
  creature?: string;
  person?: string;
}>;

/** The ward parsed from `ward.toml`. Absent when Cave withholds or lacks it. */
export type FamiliarWard = Readonly<{
  version?: string;
  protectedFiles: readonly string[];
  invariants: readonly string[];
  editablePaths: readonly string[];
  approvalTiers: Readonly<{
    auto: readonly string[];
    humanReview: readonly string[];
  }>;
}>;

export type ContractPropertyCoverage = Readonly<{ property: string; pass: boolean }>;
export type ContractViolation = Readonly<{ file: string; field: string; message: string }>;

/** `pass` is true when there are zero hard violations; warnings never fail it. */
export type ContractReport = Readonly<{
  specVersion: string;
  pass: boolean;
  properties: readonly ContractPropertyCoverage[];
  violations: readonly ContractViolation[];
  warnings: readonly ContractViolation[];
}>;

export type FamiliarDetail = Readonly<{
  id: string;
  workspace?: string;
  present: FamiliarPresence;
  identity?: FamiliarIdentity;
  ward?: FamiliarWard;
  report: ContractReport;
}>;

/** The windows Cave aggregates execution analytics over. */
export type ActivityWindow = '7d' | '14d' | '8w' | 'all';

export type ExecutionOutcome = 'completed' | 'failed' | 'cancelled';

export type ActivityAttempt = Readonly<{
  id: string;
  occurredAt: string;
  harnessId: string;
  status: ExecutionOutcome;
  durationMs?: number;
  toolCalls: number;
  toolFailures: number;
}>;

/** One UTC calendar day of a window's runs-per-day series. */
export type ActivityDay = Readonly<{
  date: string;
  completed: number;
  failed: number;
  cancelled: number;
}>;

/**
 * A tool- or harness-level usage slice.
 *
 * Cave's Stage 1 analytics contract does not break usage down by literal
 * tool name; `mappers.ts` maps this from the window's `harnesses` slices,
 * which is the closest Cave concept to the design's per-tool call counts.
 */
export type ActivityToolUsage = Readonly<{ name: string; calls: number; failed: number }>;

/** Whether the history behind these numbers is complete. */
export type ActivityBackfillState = 'complete' | 'partial' | 'not-started';

export type FamiliarActivity = Readonly<{
  window: ActivityWindow;
  generatedAt: string;
  attempts: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** Null when there were no attempts: a rate over nothing is not zero. */
  completion: number | null;
  medianDurationMs?: number;
  p95DurationMs?: number;
  calls: number;
  callFailures: number;
  tools: readonly ActivityToolUsage[];
  /** Present only on the day-shaped windows (`7d`, `14d`). */
  days?: readonly ActivityDay[];
  recent: readonly ActivityAttempt[];
  backfillState: ActivityBackfillState;
}>;

export type ConversationSummary = Readonly<{
  id: string;
  familiarId: string;
  title?: string;
  updatedAt: string;
  failed: boolean;
  pending: boolean;
}>;

export type ThreadMessage = Readonly<{
  id: string;
  conversationId: string;
  parentId: string | null;
  role: string;
  text: string;
  createdAt: string;
  attachmentCount: number;
  toolCount: number;
  isError: boolean;
  cancelled: boolean;
}>;

/**
 * Capability names a `FamiliarsSource` may advertise, gating which controls
 * the shell renders as enabled. See `./capabilities.ts`.
 */
export type Capability =
  | 'familiars'
  | 'conversations'
  | 'conversation-messages'
  | 'familiar-contract'
  | 'familiar-analytics'
  | 'conversations-write'
  | 'runs'
  | 'conversation-participants'
  | 'attention'
  | 'rich-content'
  | 'attachments'
  | 'familiars-write'
  | 'screen';

/** Stage 1 (reads) of the Familiars surface data-source seam. */
export type FamiliarsSource = Readonly<{
  familiars(): Promise<QueryResult<Page<FamiliarSummary>>>;
  familiar(id: string): Promise<QueryResult<FamiliarDetail>>;
  activity(id: string, window?: ActivityWindow): Promise<QueryResult<FamiliarActivity>>;
  conversations(): Promise<QueryResult<Page<ConversationSummary>>>;
  messages(conversationId: string): Promise<QueryResult<Page<ThreadMessage>>>;
  capabilities(): ReadonlySet<Capability>;
}>;
