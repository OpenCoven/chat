import { Channel, invoke } from '@tauri-apps/api/core';
import { canUseTauriCommands, type InvokeCommand } from './desktop-host';

/**
 * The window's side of the mission commands (#155). Coven decides every
 * state; the host checks each answer is about the mission, familiar and owner
 * it asked about. Adoption keys never reach the window: a mission is named by
 * its id only.
 */

export type MissionUnavailableReason =
  | 'update-coven'
  | 'coven-not-ready'
  | 'no-read-envelope'
  | 'familiar-unregistered'
  | 'familiar-inactive'
  | 'ledger-unreadable';

export type MissionPreparation =
  | {
      status: 'ready';
      familiarId: string;
      rootId: string;
      revisionId: string;
      envelopeId: 'r0-read.1';
      envelopeDigest: string;
    }
  | { status: 'unavailable'; reason: MissionUnavailableReason; detail: string };

export type MissionState =
  | 'queued'
  | 'running'
  | 'needs_approval'
  | 'cancelling'
  | 'reconciling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'revoked'
  | 'unavailable';

export type MissionReason =
  | 'timeout'
  | 'harness_failed'
  | 'familiar_revision_stale'
  | 'familiar_revision_revoked'
  | 'grant_revoked'
  | 'envelope_unsupported'
  | 'expired_before_dispatch'
  | 'authority_unavailable'
  | 'runtime_unavailable'
  | 'ambiguous_execution';

export type MissionUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
};

export type MissionView = {
  missionId: string;
  familiarId: string;
  revision: number;
  state: MissionState;
  terminal: boolean;
  reason?: MissionReason;
  rootId: string;
  revisionId: string;
  principalId: string;
  statement: string;
  projectCwd: string;
  submittedAt: string;
  validUntil: string;
  attempts: number;
  cancellation?: 'cancelled' | 'pending' | 'lost_to_completion' | 'recovery_required';
  result?: {
    outcome: 'completed' | 'failed' | 'cancelled' | 'rejected' | 'revoked' | 'unavailable';
    settledAt: string;
    observation: 'complete' | 'partial' | 'unknown';
    reports: number;
    usage: MissionUsage | null;
  };
};

export type MissionAnswer =
  | { kind: 'view'; mission: MissionView }
  | { kind: 'refused'; code: string; message: string; currentRevisionId?: string }
  | { kind: 'not-sent'; message: string }
  | { kind: 'checking'; missionId: string }
  | { kind: 'never-sent'; missionId: string }
  | { kind: 'gone'; missionId: string }
  | { kind: 'settled'; mission: MissionView }
  | { kind: 'mismatch'; missionId: string };

export type MissionEntry = { missionId: string; phase: 'sending' | 'committed' | 'terminal' };

export type MissionSubmitInput = {
  familiarId: string;
  rootId: string;
  revisionId: string;
  envelopeDigest: string;
  projectCwd: string;
  statement: string;
  prompt: string;
  timeoutMinutes: number;
};

export interface Missions {
  prepare(familiarId: string): Promise<MissionPreparation>;
  list(familiarId: string): Promise<MissionEntry[]>;
  submit(input: MissionSubmitInput): Promise<MissionAnswer>;
  get(missionId: string): Promise<MissionAnswer>;
  cancel(missionId: string): Promise<MissionAnswer>;
  /** Resolves when the watch ends; each changed answer reaches `onAnswer` first. */
  watch(missionId: string, onAnswer: (answer: MissionAnswer) => void): Promise<void>;
  stopWatch(missionId: string): Promise<void>;
}

const STATES: readonly MissionState[] = [
  'queued',
  'running',
  'needs_approval',
  'cancelling',
  'reconciling',
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'revoked',
  'unavailable',
];
const TERMINAL: readonly string[] = [
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'revoked',
  'unavailable',
];
const REASONS: readonly MissionReason[] = [
  'timeout',
  'harness_failed',
  'familiar_revision_stale',
  'familiar_revision_revoked',
  'grant_revoked',
  'envelope_unsupported',
  'expired_before_dispatch',
  'authority_unavailable',
  'runtime_unavailable',
  'ambiguous_execution',
];
const UNAVAILABLE_REASONS: readonly MissionUnavailableReason[] = [
  'update-coven',
  'coven-not-ready',
  'no-read-envelope',
  'familiar-unregistered',
  'familiar-inactive',
  'ledger-unreadable',
];
const MISSION_ID = /^mission-[0-9a-f]{32}$/;
const ROOT_ID = /^familiar:[0-9a-f]{32}$/;
const REVISION_ID = /^familiar-revision:[0-9a-f]{32}:\d{1,12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UNAVAILABLE = 'Missions require the desktop app.';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}
function among<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function optional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value);
}
function missionId(value: unknown): value is string {
  return typeof value === 'string' && MISSION_ID.test(value);
}
function usage(value: unknown): boolean {
  if (value === null) return true;
  if (!record(value)) return false;
  return Object.entries(value).every(([key, figure]) =>
    key === 'costUsd'
      ? typeof figure === 'number' && Number.isFinite(figure) && figure >= 0
      : ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].includes(key) &&
        count(figure),
  );
}

export function isMissionView(value: unknown): value is MissionView {
  if (!record(value)) return false;
  const result = value.result;
  const terminal = value.terminal;
  return (
    missionId(value.missionId) &&
    text(value.familiarId, 128) &&
    count(value.revision) &&
    among(value.state, STATES) &&
    typeof terminal === 'boolean' &&
    terminal === TERMINAL.includes(value.state) &&
    optional(value.reason, (reason) => among(reason, REASONS)) &&
    typeof value.rootId === 'string' &&
    ROOT_ID.test(value.rootId) &&
    typeof value.revisionId === 'string' &&
    REVISION_ID.test(value.revisionId) &&
    text(value.principalId, 200) &&
    text(value.statement, 800) &&
    text(value.projectCwd, 4096) &&
    text(value.submittedAt, 40) &&
    text(value.validUntil, 40) &&
    count(value.attempts) &&
    optional(value.cancellation, (outcome) =>
      among(outcome, ['cancelled', 'pending', 'lost_to_completion', 'recovery_required']),
    ) &&
    (result === undefined) === !terminal &&
    optional(
      result,
      (result) =>
        record(result) &&
        result.outcome === value.state &&
        text(result.settledAt, 40) &&
        among(result.observation, ['complete', 'partial', 'unknown']) &&
        count(result.reports) &&
        usage(result.usage),
    )
  );
}

export function isMissionAnswer(value: unknown): value is MissionAnswer {
  if (!record(value)) return false;
  switch (value.kind) {
    case 'view':
    case 'settled':
      return isMissionView(value.mission) && (value.kind === 'view' || value.mission.terminal);
    case 'refused':
      return (
        text(value.code, 64) &&
        typeof value.message === 'string' &&
        value.message.length <= 2048 &&
        optional(
          value.currentRevisionId,
          (revision) => typeof revision === 'string' && REVISION_ID.test(revision),
        )
      );
    case 'not-sent':
      return typeof value.message === 'string' && value.message.length <= 2048;
    case 'checking':
    case 'never-sent':
    case 'gone':
    case 'mismatch':
      return missionId(value.missionId);
    default:
      return false;
  }
}

export function isMissionPreparation(value: unknown): value is MissionPreparation {
  if (!record(value)) return false;
  if (value.status === 'unavailable')
    return (
      among(value.reason, UNAVAILABLE_REASONS) &&
      typeof value.detail === 'string' &&
      value.detail.length <= 2048
    );
  return (
    value.status === 'ready' &&
    text(value.familiarId, 128) &&
    typeof value.rootId === 'string' &&
    ROOT_ID.test(value.rootId) &&
    typeof value.revisionId === 'string' &&
    REVISION_ID.test(value.revisionId) &&
    value.envelopeId === 'r0-read.1' &&
    typeof value.envelopeDigest === 'string' &&
    DIGEST.test(value.envelopeDigest)
  );
}

function entries(value: unknown): value is MissionEntry[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (entry) =>
        record(entry) &&
        missionId(entry.missionId) &&
        among(entry.phase, ['sending', 'committed', 'terminal']),
    )
  );
}

function checked<T>(value: unknown, guard: (value: unknown) => value is T): T {
  if (!guard(value)) throw new Error('Coven returned an invalid mission answer.');
  return value;
}

/** A channel the host streams answers on; injectable so tests need no host. */
export type AnswerChannel = { onmessage: (value: unknown) => void };

export function createMissions(
  options: {
    available?: () => boolean;
    invoke?: InvokeCommand;
    channel?: () => AnswerChannel;
  } = {},
): Missions {
  const available = options.available ?? canUseTauriCommands;
  const invokeCommand = options.invoke ?? invoke;
  async function call(command: string, args: Record<string, unknown>): Promise<unknown> {
    if (!available()) throw new Error(UNAVAILABLE);
    try {
      return await invokeCommand(command, args);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      throw new Error(message.slice(0, 2048) || 'The mission operation failed.');
    }
  }
  return {
    async prepare(familiarId) {
      return checked(await call('mission_prepare', { familiarId }), isMissionPreparation);
    },
    async list(familiarId) {
      return checked(await call('mission_list', { familiarId }), entries);
    },
    async submit(input) {
      return checked(await call('mission_submit', { input }), isMissionAnswer);
    },
    async get(id) {
      return checked(await call('mission_get', { missionId: id }), isMissionAnswer);
    },
    async cancel(id) {
      return checked(await call('mission_cancel', { missionId: id }), isMissionAnswer);
    },
    async watch(id, onAnswer) {
      const channel = options.channel?.() ?? new Channel<unknown>();
      channel.onmessage = (value) => {
        // An answer that fails the guard is dropped, never shown.
        if (isMissionAnswer(value)) onAnswer(value);
      };
      await call('mission_watch', { missionId: id, onEvent: channel });
    },
    async stopWatch(id) {
      await call('mission_watch_stop', { missionId: id });
    },
  };
}

export const defaultMissions = createMissions();
