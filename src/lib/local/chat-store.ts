import type { Page } from '@opencoven/sdk-core/browser';

import {
  type ChatBackend,
  type ChatRecords,
  EMPTY_RECORDS,
  type StoredConversation,
  type StoredMessage,
  type StoredMessageRole,
  sanitizeRecords,
} from './chat-records';
import { openIndexedDbChatBackend } from './indexeddb-backend';
import { createMemoryChatBackend } from './memory-backend';

export type ChatStoreChange = Readonly<{ revision: number }>;

export type ChatStore = Readonly<{
  isDurable: () => boolean;
  getRevision: () => number;
  listConversations: (limit: number, cursor?: string) => Page<StoredConversation>;
  getConversation: (conversationId: string) => StoredConversation | undefined;
  listMessages: (conversationId: string, limit: number, cursor?: string) => Page<StoredMessage>;
  createConversation: (title?: string) => Promise<StoredConversation>;
  appendMessage: (
    conversationId: string,
    role: StoredMessageRole,
    text: string,
  ) => Promise<StoredMessage>;
  subscribe: (listener: (change: ChatStoreChange) => void) => () => void;
  dispose: () => void;
}>;

export type ChatStoreOptions = Readonly<{
  now?: () => number;
  createId?: () => string;
  familiarId: string;
  defaultTitle?: string;
}>;

export class ChatStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChatStoreError';
    this.code = code;
  }
}

export const MAX_MESSAGE_TEXT_LENGTH = 32_000;
export const MAX_TITLE_LENGTH = 200;
const DEFAULT_CONVERSATION_TITLE = 'New conversation';

type SortKey = Readonly<{ t: string; i: string }>;

/**
 * Cursors are keyset, not offset.
 *
 * `createManualPageWalk` aborts a walk the moment a cursor value repeats, and
 * offset cursors repeat as soon as a row is inserted or removed mid-walk. A
 * keyset cursor naming the last row served is strictly forward-moving, so it
 * cannot collide with a cursor already seen in the same walk.
 */
export function encodeCursor(key: SortKey): string {
  const json = JSON.stringify({ v: 1, t: key.t, i: key.i });
  return btoa(json).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function decodeCursor(cursor: string): SortKey {
  const padded = cursor.replaceAll('-', '+').replaceAll('_', '/');
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(padded));
  } catch {
    throw new ChatStoreError('invalid_request', 'The page cursor is malformed.');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { t?: unknown }).t !== 'string' ||
    typeof (parsed as { i?: unknown }).i !== 'string'
  ) {
    throw new ChatStoreError('invalid_request', 'The page cursor is malformed.');
  }

  const record = parsed as { t: string; i: string };
  return Object.freeze({ t: record.t, i: record.i });
}

function compareKeys(left: SortKey, right: SortKey): number {
  if (left.t !== right.t) {
    return left.t < right.t ? -1 : 1;
  }
  if (left.i === right.i) {
    return 0;
  }
  return left.i < right.i ? -1 : 1;
}

function emptyPage<T>(requestedCursor?: string): Page<T> {
  return Object.freeze({
    data: Object.freeze([]) as readonly T[],
    cursor: Object.freeze(
      requestedCursor === undefined
        ? { hasMore: false }
        : { current: requestedCursor, hasMore: false },
    ),
  });
}

/**
 * Builds a page whose cursor satisfies the manual page-walk contract: `current`
 * is echoed back byte-identical to what was requested, and `next` is only
 * emitted when another row actually exists.
 */
function buildPage<T>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => SortKey,
  requestedCursor?: string,
): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);

  const cursor =
    hasMore && last !== undefined
      ? {
          ...(requestedCursor === undefined ? {} : { current: requestedCursor }),
          next: encodeCursor(keyOf(last)),
          hasMore: true,
        }
      : { ...(requestedCursor === undefined ? {} : { current: requestedCursor }), hasMore: false };

  return Object.freeze({
    data: Object.freeze([...data]),
    cursor: Object.freeze(cursor),
  });
}

function normalizeText(value: string, limit: number, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ChatStoreError('invalid_request', `The ${field} is empty.`);
  }
  if (trimmed.length > limit) {
    throw new ChatStoreError('invalid_request', `The ${field} is too long.`);
  }
  return trimmed;
}

export function createChatStore(
  backend: ChatBackend,
  initialRecords: ChatRecords,
  options: ChatStoreOptions,
): ChatStore {
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const defaultTitle = options.defaultTitle ?? DEFAULT_CONVERSATION_TITLE;

  const conversations = new Map<string, StoredConversation>();
  const messagesByConversation = new Map<string, StoredMessage[]>();
  const listeners = new Set<(change: ChatStoreChange) => void>();
  let revision = 0;
  let disposed = false;

  function conversationKey(entry: StoredConversation): SortKey {
    return { t: entry.updatedAt, i: entry.id };
  }

  function messageKey(entry: StoredMessage): SortKey {
    return { t: entry.createdAt, i: entry.id };
  }

  function indexMessage(entry: StoredMessage): void {
    const bucket = messagesByConversation.get(entry.conversationId);
    if (bucket === undefined) {
      messagesByConversation.set(entry.conversationId, [entry]);
      return;
    }
    bucket.push(entry);
    bucket.sort((left, right) => compareKeys(messageKey(left), messageKey(right)));
  }

  function hydrate(records: ChatRecords): void {
    const clean = sanitizeRecords(records);
    for (const entry of clean.conversations) {
      conversations.set(entry.id, entry);
    }
    for (const entry of clean.messages) {
      // Drop orphans: a message whose conversation was lost is unreachable and
      // would only skew paging counts.
      if (conversations.has(entry.conversationId)) {
        indexMessage(entry);
      }
    }
  }

  hydrate(initialRecords);

  function announce(): void {
    revision += 1;
    const change = Object.freeze({ revision });
    for (const listener of [...listeners]) {
      listener(change);
    }
  }

  async function commit(change: ChatRecords): Promise<void> {
    if (disposed) {
      throw new ChatStoreError('service_unavailable', 'The chat store is disposed.');
    }
    try {
      await backend.commit(change);
    } catch {
      throw new ChatStoreError('service_unavailable', 'The chat store could not save the change.');
    }
  }

  return Object.freeze({
    isDurable: () => backend.isDurable(),
    getRevision: () => revision,

    listConversations(limit, cursor) {
      const ordered = [...conversations.values()].sort((left, right) =>
        compareKeys(conversationKey(right), conversationKey(left)),
      );
      if (cursor === undefined) {
        return buildPage(ordered.slice(0, limit + 1), limit, conversationKey);
      }

      const after = decodeCursor(cursor);
      const rows = ordered.filter((entry) => compareKeys(conversationKey(entry), after) < 0);
      return buildPage(rows.slice(0, limit + 1), limit, conversationKey, cursor);
    },

    getConversation: (conversationId) => conversations.get(conversationId),

    listMessages(conversationId, limit, cursor) {
      const bucket = messagesByConversation.get(conversationId);
      if (bucket === undefined) {
        return emptyPage<StoredMessage>(cursor);
      }
      if (cursor === undefined) {
        return buildPage(bucket.slice(0, limit + 1), limit, messageKey);
      }

      const after = decodeCursor(cursor);
      const rows = bucket.filter((entry) => compareKeys(messageKey(entry), after) > 0);
      return buildPage(rows.slice(0, limit + 1), limit, messageKey, cursor);
    },

    async createConversation(title) {
      const timestamp = new Date(now()).toISOString();
      const conversation: StoredConversation = Object.freeze({
        id: createId(),
        familiarId: options.familiarId,
        title: title === undefined ? defaultTitle : normalizeText(title, MAX_TITLE_LENGTH, 'title'),
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      await commit({ conversations: [conversation], messages: [] });
      conversations.set(conversation.id, conversation);
      announce();
      return conversation;
    },

    async appendMessage(conversationId, role, text) {
      const conversation = conversations.get(conversationId);
      if (conversation === undefined) {
        throw new ChatStoreError('not_found', 'The conversation does not exist.');
      }

      const body = normalizeText(text, MAX_MESSAGE_TEXT_LENGTH, 'message');
      const timestamp = new Date(now()).toISOString();
      const previous = messagesByConversation.get(conversationId)?.at(-1);
      const message: StoredMessage = Object.freeze({
        id: createId(),
        conversationId,
        parentId: previous?.id ?? null,
        role,
        text: body,
        createdAt: timestamp,
      });
      const touched: StoredConversation = Object.freeze({ ...conversation, updatedAt: timestamp });

      // One commit, so a message can never outlive the updatedAt bump that
      // orders its conversation.
      await commit({ conversations: [touched], messages: [message] });
      conversations.set(touched.id, touched);
      indexMessage(message);
      announce();
      return message;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      listeners.clear();
      backend.close();
    },
  });
}

/**
 * Opens the durable backend when the platform provides one and falls back to a
 * memory backend otherwise. The fallback is never silent: `store.isDurable()`
 * stays false so the UI can say that nothing is being saved.
 */
export async function openChatStore(
  options: ChatStoreOptions & { backend?: ChatBackend },
): Promise<ChatStore> {
  const backend =
    options.backend ?? (await openIndexedDbChatBackend()) ?? createMemoryChatBackend();

  let records: ChatRecords = EMPTY_RECORDS;
  try {
    records = await backend.loadAll();
  } catch {
    records = EMPTY_RECORDS;
  }

  return createChatStore(backend, records, options);
}
