import type {
  CaveExecutionAttempt,
  CaveExecutionDay,
  CaveExecutionSlice,
  CaveFamiliarAnalytics,
  CaveFamiliarContract,
  CaveFamiliarIdentity,
  CaveFamiliarWard,
} from '@opencoven/cave-client';
import type {
  CaveCanonicalFamiliar,
  CaveConversation,
  CaveConversationMessage,
} from '@opencoven/cave-client/managed';

import type {
  ActivityAttempt,
  ActivityDay,
  ActivityToolUsage,
  ActivityWindow,
  ConversationSummary,
  FamiliarActivity,
  FamiliarDetail,
  FamiliarIdentity,
  FamiliarStatus,
  FamiliarSummary,
  FamiliarWard,
  ThreadMessage,
} from './source';

/**
 * SDK wire types -> the Familiars surface's view types.
 *
 * This is the only module that knows the shape of a `CaveCanonicalFamiliar`,
 * a `CaveFamiliarContract`, or a `CaveExecutionWindow`. Both
 * `CaveFamiliarsSource` and its tests depend on this file rather than
 * reaching into `@opencoven/cave-client` themselves, so a wire change is a
 * type error here and nowhere else.
 */

function normalizeFamiliarStatus(status: string | undefined): FamiliarStatus {
  // Cave's `status` is a bare string today (no reviewed literal union). An
  // unrecognized or missing value defaults to the least-permissive reading
  // rather than a guess at "available".
  return status === 'available' || status === 'working' ? status : 'offline';
}

export function mapFamiliarSummary(familiar: CaveCanonicalFamiliar): FamiliarSummary {
  return {
    id: familiar.id,
    name: familiar.displayName,
    role: familiar.role,
    ...(familiar.description === undefined ? {} : { description: familiar.description }),
    ...(familiar.pronouns === undefined ? {} : { pronouns: familiar.pronouns }),
    status: normalizeFamiliarStatus(familiar.status),
  };
}

function mapFamiliarIdentity(identity: CaveFamiliarIdentity): FamiliarIdentity {
  return {
    ...(identity.name === undefined ? {} : { name: identity.name }),
    ...(identity.creature === undefined ? {} : { creature: identity.creature }),
    ...(identity.person === undefined ? {} : { person: identity.person }),
  };
}

function mapFamiliarWard(ward: CaveFamiliarWard): FamiliarWard {
  return {
    ...(ward.version === undefined ? {} : { version: ward.version }),
    protectedFiles: ward.protectedFiles,
    invariants: ward.invariants,
    editablePaths: ward.editablePaths,
    approvalTiers: {
      auto: ward.approvalTiers.auto,
      humanReview: ward.approvalTiers.humanReview,
    },
  };
}

export function mapFamiliarDetail(contract: CaveFamiliarContract): FamiliarDetail {
  return {
    id: contract.id,
    ...(contract.workspace === undefined ? {} : { workspace: contract.workspace }),
    present: contract.present,
    ...(contract.identity === undefined
      ? {}
      : { identity: mapFamiliarIdentity(contract.identity) }),
    ...(contract.ward === undefined ? {} : { ward: mapFamiliarWard(contract.ward) }),
    report: {
      specVersion: contract.report.specVersion,
      pass: contract.report.pass,
      properties: contract.report.properties,
      violations: contract.report.violations,
      warnings: contract.report.warnings,
    },
  };
}

function mapActivityToolUsage(slice: CaveExecutionSlice): ActivityToolUsage {
  // Cave's Stage 1 analytics contract does not break usage down by literal
  // tool name; a harness slice is the closest available concept.
  return {
    name: slice.label ?? slice.key,
    calls: slice.toolCalls,
    failed: slice.toolFailures,
  };
}

function mapActivityDay(day: CaveExecutionDay): ActivityDay {
  return { date: day.date, completed: day.completed, failed: day.failed, cancelled: day.cancelled };
}

function mapActivityAttempt(attempt: CaveExecutionAttempt): ActivityAttempt {
  return {
    id: attempt.id,
    occurredAt: attempt.occurredAt,
    harnessId: attempt.harnessId,
    status: attempt.status,
    ...(attempt.durationMs === undefined ? {} : { durationMs: attempt.durationMs }),
    toolCalls: attempt.toolCalls,
    toolFailures: attempt.toolFailures,
  };
}

/**
 * Maps one requested window out of `analytics.windows`. Returns `undefined`
 * when Cave did not serve that window (an instance with a shorter history,
 * or a window key the analytics response simply omits).
 */
export function mapFamiliarActivity(
  analytics: CaveFamiliarAnalytics,
  window: ActivityWindow,
): FamiliarActivity | undefined {
  const source = analytics.windows[window];
  if (source === undefined) {
    return undefined;
  }

  return {
    window,
    generatedAt: analytics.generatedAt,
    attempts: source.attempts,
    completed: source.completed,
    failed: source.failed,
    cancelled: source.cancelled,
    completion: source.successRate,
    ...(source.medianDurationMs === undefined ? {} : { medianDurationMs: source.medianDurationMs }),
    ...(source.p95DurationMs === undefined ? {} : { p95DurationMs: source.p95DurationMs }),
    calls: source.toolCalls,
    callFailures: source.toolFailures,
    tools: source.harnesses.map(mapActivityToolUsage),
    ...(source.days === undefined ? {} : { days: source.days.map(mapActivityDay) }),
    recent: analytics.recentAttempts.map(mapActivityAttempt),
    backfillState: analytics.backfill.state,
  };
}

function isConversationFailed(conversation: CaveConversation): boolean {
  if (conversation.status === 'failed' || conversation.status === 'error') {
    return true;
  }
  return typeof conversation.exitCode === 'number' && conversation.exitCode !== 0;
}

export function mapConversationSummary(conversation: CaveConversation): ConversationSummary {
  return {
    id: conversation.id,
    familiarId: conversation.familiarId,
    ...(conversation.title === undefined ? {} : { title: conversation.title }),
    updatedAt: conversation.updatedAt,
    failed: isConversationFailed(conversation),
    pending: conversation.pending === true,
  };
}

export function mapThreadMessage(message: CaveConversationMessage): ThreadMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    parentId: message.parentId,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    attachmentCount: message.attachmentCount,
    toolCount: message.toolCount,
    isError: message.isError === true,
    cancelled: message.cancelled === true,
  };
}
