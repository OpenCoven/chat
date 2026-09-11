import type { BringBackPreconditions } from './side-conversations';

/**
 * Local chat records and the durable backend port.
 *
 * The record shapes are deliberately narrower than the Cave wire types. They
 * hold what this app can actually produce on its own; the adapter widens them
 * into the Cave-shaped values the UI already renders.
 */

export type StoredConversation = Readonly<{
  id: string;
  familiarId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  revision?: number;
  side?: Readonly<{
    parentConversationId: string;
    operationKey: string;
    state: 'open' | 'closed' | 'discarded';
  }>;
}>;

export type StoredMessageRole = 'user' | 'assistant';

export type StoredMessage = Readonly<{
  id: string;
  conversationId: string;
  parentId: string | null;
  role: StoredMessageRole;
  text: string;
  createdAt: string;
  broughtBack?: Readonly<{
    operationKey: string;
    sideConversationId: string;
    sourceMessageIds: readonly string[];
    preconditions?: BringBackPreconditions;
  }>;
}>;

export type ChatRecords = Readonly<{
  conversations: readonly StoredConversation[];
  messages: readonly StoredMessage[];
  deletedMessageIds?: readonly string[];
  expectedConversations?: readonly StoredConversation[];
  absentOperationKey?: string;
}>;

export class ChatConflictError extends Error {
  readonly code = 'conflict';
}

/** Checked inside the same transaction as writes, including across open windows. */
export function checkPreconditions(change: ChatRecords, current: ChatRecords): void {
  for (const expected of change.expectedConversations ?? []) {
    const actual = current.conversations.find((entry) => entry.id === expected.id);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new ChatConflictError('The exact local record changed. Retry after refreshing.');
    }
  }
  const key = change.absentOperationKey;
  if (
    key &&
    (current.conversations.some((entry) => entry.side?.operationKey === key) ||
      current.messages.some((entry) => entry.broughtBack?.operationKey === key))
  ) {
    throw new ChatConflictError('This operation was already committed. Retry to reconcile.');
  }
}

/**
 * Durable storage port.
 *
 * `commit` takes whole records rather than field patches, and must apply every
 * record in the change atomically. Appending a message also bumps its
 * conversation's `updatedAt`; if only one of those two survived a crash the
 * conversation list would sort by a timestamp that no message justifies.
 */
export type ChatBackend = Readonly<{
  isDurable: () => boolean;
  /** Optional shared revision covering every writer sharing this backend.
   * Increments once per successful atomic commit, never on failed commits.
   */
  getMutationRevision?: () => number | Promise<number>;
  loadAll: () => Promise<ChatRecords>;
  commit: (change: ChatRecords) => Promise<void>;
  close: () => void;
}>;

export const EMPTY_RECORDS: ChatRecords = Object.freeze({
  conversations: Object.freeze([]) as readonly StoredConversation[],
  messages: Object.freeze([]) as readonly StoredMessage[],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function isBringBackPreconditions(value: unknown): value is BringBackPreconditions {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.parentRevision) &&
    Number(value.parentRevision) >= 0 &&
    Number.isSafeInteger(value.sideRevision) &&
    Number(value.sideRevision) >= 0 &&
    (value.parentLeafId === null || typeof value.parentLeafId === 'string') &&
    (value.sideLeafId === null || typeof value.sideLeafId === 'string')
  );
}

export function isStoredConversation(value: unknown): value is StoredConversation {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.familiarId === 'string' &&
    value.familiarId.length > 0 &&
    typeof value.title === 'string' &&
    (value.revision === undefined ||
      (Number.isSafeInteger(value.revision) && Number(value.revision) >= 0)) &&
    (value.side === undefined ||
      (isRecord(value.side) &&
        typeof value.side.parentConversationId === 'string' &&
        value.side.parentConversationId.length > 0 &&
        typeof value.side.operationKey === 'string' &&
        value.side.operationKey.length > 0 &&
        ['open', 'closed', 'discarded'].includes(String(value.side.state)))) &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt)
  );
}

export function isStoredMessage(value: unknown): value is StoredMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.conversationId === 'string' &&
    value.conversationId.length > 0 &&
    (value.parentId === null || typeof value.parentId === 'string') &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.text === 'string' &&
    (value.broughtBack === undefined ||
      (isRecord(value.broughtBack) &&
        typeof value.broughtBack.operationKey === 'string' &&
        typeof value.broughtBack.sideConversationId === 'string' &&
        (value.broughtBack.preconditions === undefined ||
          isBringBackPreconditions(value.broughtBack.preconditions)) &&
        Array.isArray(value.broughtBack.sourceMessageIds) &&
        value.broughtBack.sourceMessageIds.every((id) => typeof id === 'string'))) &&
    isIsoTimestamp(value.createdAt)
  );
}

/**
 * Drops records that fail validation instead of rejecting the whole read.
 *
 * A single corrupt row should cost the user that row, not their entire history.
 */
export function sanitizeRecords(value: ChatRecords): ChatRecords {
  return Object.freeze({
    conversations: Object.freeze(value.conversations.filter(isStoredConversation)),
    messages: Object.freeze(value.messages.filter(isStoredMessage)),
  });
}
