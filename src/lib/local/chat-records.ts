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
}>;

export type StoredMessageRole = 'user' | 'assistant';

export type StoredMessage = Readonly<{
  id: string;
  conversationId: string;
  parentId: string | null;
  role: StoredMessageRole;
  text: string;
  createdAt: string;
}>;

export type ChatRecords = Readonly<{
  conversations: readonly StoredConversation[];
  messages: readonly StoredMessage[];
}>;

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

export function isStoredConversation(value: unknown): value is StoredConversation {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.familiarId === 'string' &&
    value.familiarId.length > 0 &&
    typeof value.title === 'string' &&
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
