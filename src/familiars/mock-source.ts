import type { Page, PageCursor } from '@opencoven/sdk-core/browser';

import {
  FAM_ACTIVITY,
  FAM_CONVERSATIONS,
  FAM_MESSAGES,
  type FamActivity,
  type FamConversation,
  type FamMessage,
  type FamRun,
  runRow,
} from '../demo/familiars-data';
import { contractReport, MOCK_FAMILIARS, type MockFamiliar } from '../demo/mock-familiars';
import type {
  ActivityAttempt,
  ActivityDay,
  ActivityWindow,
  Capability,
  ConversationSummary,
  FamiliarActivity,
  FamiliarDetail,
  FamiliarPresence,
  FamiliarSummary,
  FamiliarsSource,
  QueryResult,
  ThreadMessage,
} from './source';

/**
 * `FamiliarsSource` over today's demo fixtures (`src/demo/familiars-data.ts`,
 * `src/demo/mock-familiars.ts`).
 *
 * This is the only place mock content lives, per the integration design.
 * Used by the demo build, tests, and the design board states. It always
 * resolves synchronously, and returns `status: 'ok'` for every id the demo
 * fixtures cover; an id they do not cover resolves
 * `{ status: 'error', code: 'not_found' }` rather than throwing.
 *
 * The demo's `FamActivity` is presentation-shaped (`completion: '100%'`,
 * `median: '1m 36s'`) because it was authored to match the design mockup
 * verbatim. Reconstructing the numeric `FamiliarActivity` view type from it
 * is necessarily best-effort -- fields with no honest numeric source
 * (per-attempt harness ids, real calendar dates) are synthesized rather than
 * invented as if real. `CaveFamiliarsSource` (`./cave-source.ts`) gets these
 * fields directly from Cave; only the mock path parses strings.
 */

const STAGE_1_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'familiars',
  'conversations',
  'conversation-messages',
  'familiar-contract',
  'familiar-analytics',
]);

export type MockFamiliarsSourceOptions = Readonly<{
  now?: () => Date;
  capabilities?: ReadonlySet<Capability>;
}>;

function pageOf<T>(data: readonly T[]): Page<T> {
  const cursor: PageCursor = { hasMore: false };
  return { data, cursor };
}

function ok<T>(data: T): QueryResult<T> {
  return { status: 'ok', data };
}

function mockFamiliarSummary(familiar: MockFamiliar): FamiliarSummary {
  return {
    id: familiar.id,
    name: familiar.name,
    role: familiar.role,
    description: familiar.description,
    pronouns: familiar.pronouns,
    status: familiar.status,
  };
}

function mockFamiliarPresence(familiar: MockFamiliar): FamiliarPresence {
  return {
    soul: familiar.soul.purpose.trim().length > 0,
    identity: familiar.name.trim().length > 0 && familiar.creature.trim().length > 0,
    ward: true,
    memory: familiar.memory !== null,
  };
}

function mockFamiliarDetail(familiar: MockFamiliar): FamiliarDetail {
  const checks = contractReport(familiar);

  return {
    id: familiar.id,
    present: mockFamiliarPresence(familiar),
    identity: { name: familiar.name, creature: familiar.creature, person: familiar.person },
    ward: {
      version: familiar.ward.version,
      protectedFiles: familiar.ward.protectedFiles,
      invariants: familiar.ward.invariants,
      editablePaths: familiar.ward.editablePaths,
      approvalTiers: {
        auto: familiar.ward.approvalTiers.auto,
        humanReview: familiar.ward.approvalTiers.humanReview,
      },
    },
    report: {
      specVersion: '0.1.0',
      pass: checks.every((check) => check.pass),
      properties: checks.map((check) => ({ property: check.property, pass: check.pass })),
      violations: checks
        .filter((check) => !check.pass)
        .map((check) => ({ file: check.file, field: check.property, message: check.note })),
      warnings: [],
    },
  };
}

function parsePercent(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value.trim());
  return match?.[1] === undefined ? null : Number(match[1]) / 100;
}

function parseIntLoose(value: string): number {
  const match = /\d+/.exec(value);
  return match === null ? 0 : Number(match[0]);
}

/** Parses a "1h 2m 3s" / "4m 12s" / "58s" duration into milliseconds. */
function parseDurationMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/.exec(value.trim());
  if (
    match === null ||
    (match[1] === undefined && match[2] === undefined && match[3] === undefined)
  ) {
    return undefined;
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

function findSpread(activity: FamActivity, label: string): string | undefined {
  return activity.spread.find(([entryLabel]) => entryLabel === label)?.[1];
}

function outcomeCount(activity: FamActivity, label: string): number {
  return activity.outcomes.find(([entryLabel]) => entryLabel === label)?.[1] ?? 0;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

function mockDayDate(now: Date, index: number, total: number): string {
  const offset = total - 1 - index;
  const date = new Date(now.getTime());
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function mockActivityDay(
  [completed, failed]: readonly [number, number],
  index: number,
  now: Date,
  total: number,
): ActivityDay {
  return { date: mockDayDate(now, index, total), completed, failed, cancelled: 0 };
}

function mockActivityAttempt(run: FamRun, index: number, now: Date): ActivityAttempt {
  const row = runRow(run);
  const durationMs = parseDurationMs(row.dur);

  return {
    id: `${slugify(run.title)}-${index}`,
    occurredAt: new Date(now.getTime() - index * 60 * 60 * 1000).toISOString(),
    harnessId: 'demo-harness',
    status: run.status === 'failed' ? 'failed' : 'completed',
    ...(durationMs === undefined ? {} : { durationMs }),
    toolCalls: parseIntLoose(row.calls),
    toolFailures: run.status === 'failed' ? 1 : 0,
  };
}

function mockFamiliarActivity(
  activity: FamActivity,
  window: ActivityWindow,
  now: Date,
): FamiliarActivity {
  const completed = outcomeCount(activity, 'completed') + outcomeCount(activity, 'held for you');
  const failed = outcomeCount(activity, 'failed');
  const medianDurationMs = parseDurationMs(findSpread(activity, 'p50'));
  const p95DurationMs = parseDurationMs(findSpread(activity, 'p90'));

  return {
    window,
    generatedAt: now.toISOString(),
    attempts: completed + failed,
    completed,
    failed,
    cancelled: 0,
    completion: parsePercent(activity.completion),
    ...(medianDurationMs === undefined ? {} : { medianDurationMs }),
    ...(p95DurationMs === undefined ? {} : { p95DurationMs }),
    calls: parseIntLoose(activity.calls),
    callFailures: activity.tools.reduce((sum, tool) => sum + (tool.failed ?? 0), 0),
    tools: activity.tools.map((tool) => ({
      name: tool.name,
      calls: tool.calls,
      failed: tool.failed ?? 0,
    })),
    days: activity.days.map((day, index) => mockActivityDay(day, index, now, activity.days.length)),
    recent: activity.recent.map((run, index) => mockActivityAttempt(run, index, now)),
    backfillState: 'complete',
  };
}

function mockConversationSummary(
  conversation: FamConversation,
  index: number,
  now: Date,
): ConversationSummary {
  return {
    id: conversation.id,
    familiarId: conversation.familiarId,
    title: conversation.title,
    // The demo carries a display string ("10:52 PM", "Yesterday"), not a
    // timestamp; index-ordered synthesis keeps the list's own order stable.
    updatedAt: new Date(now.getTime() - index * 60_000).toISOString(),
    failed: conversation.failed === true,
    pending: conversation.held === true,
  };
}

/**
 * One `FamMessage` -> zero or one `ThreadMessage`.
 *
 * `divider`, `reasoning`, `image`, `hold`, and `failed` messages have no
 * Stage 1 equivalent (Cave does not serve the rich-content AST, attachments,
 * or attention items yet) and are dropped rather than faked.
 */
function mockThreadMessage(
  conversationId: string,
  message: FamMessage,
  id: string,
  parentId: string | null,
  createdAt: string,
): ThreadMessage | undefined {
  if (message.kind === 'user') {
    return {
      id,
      conversationId,
      parentId,
      role: 'user',
      text: message.text,
      createdAt,
      attachmentCount: message.attachments?.length ?? 0,
      toolCount: 0,
      isError: false,
      cancelled: false,
    };
  }
  if (message.kind === 'familiar') {
    return {
      id,
      conversationId,
      parentId,
      role: 'assistant',
      text: message.text,
      createdAt,
      attachmentCount: 0,
      toolCount: 0,
      isError: false,
      cancelled: false,
    };
  }
  return undefined;
}

function mockThreadMessages(
  conversationId: string,
  messages: readonly FamMessage[],
  now: Date,
): ThreadMessage[] {
  const result: ThreadMessage[] = [];
  let parentId: string | null = null;

  messages.forEach((message, index) => {
    const id = `${conversationId}-${index}`;
    const createdAt = new Date(now.getTime() - (messages.length - index) * 60_000).toISOString();
    const mapped = mockThreadMessage(conversationId, message, id, parentId, createdAt);
    if (mapped !== undefined) {
      result.push(mapped);
      parentId = mapped.id;
    }
  });

  return result;
}

export function createMockFamiliarsSource(
  options: MockFamiliarsSourceOptions = {},
): FamiliarsSource {
  const now = options.now ?? (() => new Date());
  const capabilities = options.capabilities ?? STAGE_1_CAPABILITIES;

  return Object.freeze({
    async familiars(): Promise<QueryResult<Page<FamiliarSummary>>> {
      return ok(pageOf(MOCK_FAMILIARS.map(mockFamiliarSummary)));
    },
    async familiar(id: string): Promise<QueryResult<FamiliarDetail>> {
      const familiar = MOCK_FAMILIARS.find((candidate) => candidate.id === id);
      return familiar === undefined
        ? { status: 'error', code: 'not_found' }
        : ok(mockFamiliarDetail(familiar));
    },
    async activity(
      id: string,
      window: ActivityWindow = '7d',
    ): Promise<QueryResult<FamiliarActivity>> {
      const activity = FAM_ACTIVITY[id];
      return activity === undefined
        ? { status: 'error', code: 'not_found' }
        : ok(mockFamiliarActivity(activity, window, now()));
    },
    async conversations(): Promise<QueryResult<Page<ConversationSummary>>> {
      const current = now();
      return ok(
        pageOf(
          FAM_CONVERSATIONS.map((conversation, index) =>
            mockConversationSummary(conversation, index, current),
          ),
        ),
      );
    },
    async messages(conversationId: string): Promise<QueryResult<Page<ThreadMessage>>> {
      const messages = FAM_MESSAGES[conversationId];
      return messages === undefined
        ? { status: 'error', code: 'not_found' }
        : ok(pageOf(mockThreadMessages(conversationId, messages, now())));
    },
    capabilities(): ReadonlySet<Capability> {
      return capabilities;
    },
  });
}
