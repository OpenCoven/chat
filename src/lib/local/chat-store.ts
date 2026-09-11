import type { Page } from '@opencoven/sdk-core/browser';

import {
  type ChatBackend,
  ChatConflictError,
  type ChatRecords,
  type StoredConversation,
  type StoredMessage,
  type StoredMessageRole,
  sanitizeRecords,
} from './chat-records';
import { openIndexedDbChatBackend } from './indexeddb-backend';
import { createMemoryChatBackend } from './memory-backend';
import {
  type BringBackInput,
  type BringBackPreconditions,
  type CreateSideInput,
  operationKey,
  reviewedExcerpt,
  type SideConversation,
  type SideTarget,
  sameImport,
} from './side-conversations';
import {
  ChatWriteRecoveryError,
  type RootWriteReceipt,
  type RootWriteReconciliation,
  type RootWriteRecovery,
} from './write-recovery';

export type ChatStoreChange = Readonly<{ revision: number }>;

export type ChatStore = Readonly<{
  isDurable: () => boolean;
  getRevision: () => number;
  getFamiliarId: () => string;
  reconcileWrite: (receiptId: string) => Promise<RootWriteReconciliation>;
  listConversations: (limit: number, cursor?: string) => Page<StoredConversation>;
  getConversation: (conversationId: string) => StoredConversation | undefined;
  listMessages: (conversationId: string, limit: number, cursor?: string) => Page<StoredMessage>;
  createConversation: (title?: string) => Promise<StoredConversation>;
  appendMessage: (
    conversationId: string,
    role: StoredMessageRole,
    text: string,
  ) => Promise<StoredMessage>;
  getSideConversation: (conversationId: string) => SideConversation | undefined;
  listSideConversations: (
    parentConversationId: string,
    limit: number,
    cursor?: string,
  ) => Page<SideConversation>;
  createSideConversation: (input: CreateSideInput) => Promise<SideConversation>;
  setSideState: (
    input: SideTarget,
    state: 'open' | 'closed' | 'discarded',
  ) => Promise<SideConversation>;
  bringBack: (input: BringBackInput) => Promise<StoredMessage>;
  prepareBringBack: (input: SideTarget) => Promise<BringBackPreconditions>;
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
  const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/');
  const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  const padded = base64 + padding;
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
  return createHydratedChatStore(backend, initialRecords, options);
}

function createHydratedChatStore(
  backend: ChatBackend,
  initialRecords: ChatRecords,
  options: ChatStoreOptions,
  initialBackendRevision?: number,
): ChatStore {
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const defaultTitle = options.defaultTitle ?? DEFAULT_CONVERSATION_TITLE;

  const conversations = new Map<string, StoredConversation>();
  const messagesByConversation = new Map<string, StoredMessage[]>();
  const importsByOperation = new Map<string, StoredMessage>();
  const sideIdsByOperation = new Map<string, string>();
  const listeners = new Set<(change: ChatStoreChange) => void>();
  const rootRecoveries = new Map<string, RootWriteRecovery>();
  const reconciledRootWrites = new Map<string, RootWriteReconciliation>();
  let revision = 0;
  let disposed = false;
  let writes: Promise<unknown> = Promise.resolve();
  let indexedBackendRevision = initialBackendRevision;

  function serialize<T>(write: () => Promise<T>): Promise<T> {
    const next = writes.then(async () => {
      if (disposed) throw new ChatStoreError('service_unavailable', 'The chat store is disposed.');
      const currentRevision = await backend.getMutationRevision?.();
      // Only a backend-wide revision can skip hydration. Transactional record
      // preconditions still fence competing writes after this revision read.
      if (currentRevision === undefined || currentRevision !== indexedBackendRevision) {
        const current = await backend.loadAll();
        hydrate(current);
        indexedBackendRevision = currentRevision;
      }
      return write();
    });
    writes = next.catch(() => undefined);
    return next;
  }

  function requireParent(id: string): StoredConversation {
    const parent = conversations.get(id);
    if (!parent || parent.side || parent.familiarId !== options.familiarId) {
      throw new ChatStoreError('not_found', 'The exact local parent is unavailable.');
    }
    return parent;
  }

  function visibleConversation(id: string): StoredConversation | undefined {
    const entry = conversations.get(id);
    if (entry?.familiarId !== options.familiarId || entry.side?.state === 'discarded') {
      return undefined;
    }
    if (entry.side) {
      const parent = conversations.get(entry.side.parentConversationId);
      if (parent?.familiarId !== options.familiarId || parent.side) return undefined;
    }
    return entry;
  }

  function recoveryScope(receipt: RootWriteReceipt): string {
    return receipt.kind === 'conversation' ? 'create' : `message:${receipt.conversationId}`;
  }

  function requireNoRecovery(scope: string): void {
    const recovery = rootRecoveries.get(scope);
    if (recovery) throw new ChatWriteRecoveryError(recovery);
  }

  function requireWriteRecovery(
    receipt: RootWriteReceipt,
    commit: RootWriteRecovery['commit'],
    cause: unknown,
  ): never {
    const recovery: RootWriteRecovery = Object.freeze({
      receipt,
      commit,
      code: commit === 'confirmed' ? 'refresh_failed' : 'commit_unconfirmed',
    });
    rootRecoveries.set(recoveryScope(receipt), recovery);
    throw new ChatWriteRecoveryError(recovery, cause);
  }

  function requireSide(input: SideTarget): SideConversation {
    requireParent(input.parentConversationId);
    const side = conversations.get(input.sideConversationId);
    if (
      !side?.side ||
      side.side.parentConversationId !== input.parentConversationId ||
      side.familiarId !== options.familiarId
    ) {
      throw new ChatStoreError('not_found', 'The exact local side note is unavailable.');
    }
    return side as SideConversation;
  }

  function conversationKey(entry: StoredConversation): SortKey {
    return { t: entry.updatedAt, i: entry.id };
  }

  function messageKey(entry: StoredMessage): SortKey {
    return { t: entry.createdAt, i: entry.id };
  }

  function indexMessage(entry: StoredMessage): void {
    if (entry.broughtBack) importsByOperation.set(entry.broughtBack.operationKey, entry);
    const bucket = messagesByConversation.get(entry.conversationId);
    if (bucket === undefined) {
      messagesByConversation.set(entry.conversationId, [entry]);
      return;
    }
    const previous = bucket.at(-1);
    bucket.push(entry);
    if (previous && compareKeys(messageKey(previous), messageKey(entry)) > 0) {
      bucket.sort((left, right) => compareKeys(messageKey(left), messageKey(right)));
    }
  }

  function hydrate(records: ChatRecords): void {
    conversations.clear();
    messagesByConversation.clear();
    importsByOperation.clear();
    sideIdsByOperation.clear();
    const clean = sanitizeRecords(records);
    for (const entry of clean.conversations) {
      conversations.set(entry.id, entry);
      if (entry.side) sideIdsByOperation.set(entry.side.operationKey, entry.id);
    }
    for (const entry of clean.messages) {
      // Drop orphans: a message whose conversation was lost is unreachable and
      // would only skew paging counts.
      if (
        conversations.has(entry.conversationId) &&
        conversations.get(entry.conversationId)?.side?.state !== 'discarded'
      ) {
        if (entry.broughtBack) importsByOperation.set(entry.broughtBack.operationKey, entry);
        const bucket = messagesByConversation.get(entry.conversationId);
        if (bucket) bucket.push(entry);
        else messagesByConversation.set(entry.conversationId, [entry]);
      }
    }
    for (const bucket of messagesByConversation.values()) {
      bucket.sort((left, right) => compareKeys(messageKey(left), messageKey(right)));
    }
  }

  hydrate(initialRecords);

  async function announce(): Promise<void> {
    const currentRevision = await backend.getMutationRevision?.();
    if (currentRevision !== undefined && currentRevision !== indexedBackendRevision) {
      // Our local updates are already applied. Replace them with the shared
      // snapshot before notifying; never append them again after hydration.
      hydrate(await backend.loadAll());
      indexedBackendRevision = currentRevision;
    }
    revision += 1;
    const change = Object.freeze({ revision });
    for (const listener of [...listeners]) {
      listener(change);
    }
  }

  async function commitRoot(change: ChatRecords, receipt: RootWriteReceipt): Promise<void> {
    try {
      await commit(change);
    } catch (error) {
      if (error instanceof ChatStoreError && error.code === 'conflict') throw error;
      requireWriteRecovery(receipt, 'unconfirmed', error);
    }
  }

  async function announceRoot(receipt: RootWriteReceipt): Promise<void> {
    try {
      await announce();
    } catch (error) {
      requireWriteRecovery(receipt, 'confirmed', error);
    }
  }

  async function commit(change: ChatRecords): Promise<void> {
    if (disposed) {
      throw new ChatStoreError('service_unavailable', 'The chat store is disposed.');
    }
    try {
      await backend.commit(change);
      // Count only our own commit; announce reconciles any detected competition
      // after our local update and before exposing it to observers.
      if (indexedBackendRevision !== undefined) indexedBackendRevision += 1;
    } catch (error) {
      if (error instanceof ChatConflictError) throw new ChatStoreError('conflict', error.message);
      throw new ChatStoreError('service_unavailable', 'The chat store could not save the change.');
    }
  }

  return Object.freeze({
    isDurable: () => backend.isDurable(),
    getRevision: () => revision,
    getFamiliarId: () => options.familiarId,

    reconcileWrite(receiptId) {
      return serialize(async () => {
        const reconciled = reconciledRootWrites.get(receiptId);
        const recovery = [...rootRecoveries.values()].find(
          (entry) => entry.receipt.id === receiptId,
        );
        const receipt = reconciled?.receipt ?? recovery?.receipt;
        if (!receipt) throw new ChatStoreError('not_found', 'The save receipt is unavailable.');
        const knownCommitted =
          reconciled?.outcome === 'committed' || recovery?.commit === 'confirmed';
        const before = await backend.getMutationRevision?.();
        const snapshot = await backend.loadAll();
        const after = await backend.getMutationRevision?.();
        if (before !== after) {
          throw new ChatStoreError('conflict', 'Local history changed during reconciliation.');
        }
        hydrate(snapshot);
        indexedBackendRevision = after;
        await announce();
        const record =
          receipt.kind === 'conversation'
            ? visibleConversation(receipt.id)
            : visibleConversation(receipt.conversationId)
              ? messagesByConversation
                  .get(receipt.conversationId)
                  ?.find((message) => message.id === receipt.id)
              : undefined;
        if (
          record &&
          (record.createdAt !== receipt.createdAt ||
            (receipt.kind === 'conversation'
              ? !('title' in record) ||
                record.title !== receipt.title ||
                record.familiarId !== receipt.familiarId
              : !('text' in record) ||
                record.text !== receipt.text ||
                record.conversationId !== receipt.conversationId ||
                record.parentId !== receipt.parentId ||
                record.role !== receipt.role))
        ) {
          throw new ChatStoreError('conflict', 'The saved record does not match this receipt.');
        }
        if (
          !record &&
          !knownCommitted &&
          !reconciled &&
          receipt.kind === 'message' &&
          !visibleConversation(receipt.conversationId)
        ) {
          throw new ChatStoreError(
            'not_found',
            'The note is unavailable; an unconfirmed message may have been removed.',
          );
        }
        const result: RootWriteReconciliation =
          record || knownCommitted
            ? Object.freeze({
                receipt,
                outcome: 'committed',
                availability: record ? 'present' : 'unavailable',
              })
            : Object.freeze({ receipt, outcome: 'not_committed', availability: 'absent' });
        if (recovery && rootRecoveries.get(recoveryScope(receipt)) === recovery)
          rootRecoveries.delete(recoveryScope(receipt));
        reconciledRootWrites.set(receiptId, result);
        return result;
      });
    },

    listConversations(limit, cursor) {
      const ordered = [...conversations.values()]
        .filter((entry) => !entry.side && entry.familiarId === options.familiarId)
        .sort((left, right) => compareKeys(conversationKey(right), conversationKey(left)));
      if (cursor === undefined) {
        return buildPage(ordered.slice(0, limit + 1), limit, conversationKey);
      }

      const after = decodeCursor(cursor);
      const rows = ordered.filter((entry) => compareKeys(conversationKey(entry), after) < 0);
      return buildPage(rows.slice(0, limit + 1), limit, conversationKey, cursor);
    },

    getConversation: visibleConversation,

    listMessages(conversationId, limit, cursor) {
      const bucket = visibleConversation(conversationId)
        ? messagesByConversation.get(conversationId)
        : undefined;
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

    createConversation(title) {
      return serialize(async () => {
        requireNoRecovery('create');
        const timestamp = new Date(now()).toISOString();
        const conversation: StoredConversation = Object.freeze({
          id: createId(),
          familiarId: options.familiarId,
          title:
            title === undefined ? defaultTitle : normalizeText(title, MAX_TITLE_LENGTH, 'title'),
          createdAt: timestamp,
          updatedAt: timestamp,
        });

        const receipt: RootWriteReceipt = Object.freeze({ ...conversation, kind: 'conversation' });
        await commitRoot({ conversations: [conversation], messages: [] }, receipt);
        conversations.set(conversation.id, conversation);
        await announceRoot(receipt);
        return conversation;
      });
    },

    appendMessage(conversationId, role, text) {
      return serialize(async () => {
        requireNoRecovery(`message:${conversationId}`);
        const conversation = visibleConversation(conversationId);
        if (conversation === undefined || conversation.side?.state === 'discarded') {
          throw new ChatStoreError('not_found', 'The conversation does not exist.');
        }
        if (conversation.side && conversation.side.state !== 'open') {
          throw new ChatStoreError('conflict', 'Reopen this retained note before writing.');
        }

        const body = normalizeText(text, MAX_MESSAGE_TEXT_LENGTH, 'message');
        const previous = messagesByConversation.get(conversationId)?.at(-1);
        const timestamp = new Date(
          Math.max(
            now(),
            Date.parse(conversation.updatedAt) + 1,
            previous ? Date.parse(previous.createdAt) + 1 : 0,
          ),
        ).toISOString();
        const message: StoredMessage = Object.freeze({
          id: createId(),
          conversationId,
          parentId: previous?.id ?? null,
          role,
          text: body,
          createdAt: timestamp,
        });
        const touched: StoredConversation = Object.freeze({
          ...conversation,
          updatedAt: timestamp,
          revision: (conversation.revision ?? 0) + 1,
        });

        // One commit, so a message can never outlive the updatedAt bump that
        // orders its conversation.
        const receipt: RootWriteReceipt = Object.freeze({
          ...message,
          kind: 'message',
          familiarId: options.familiarId,
        });
        await commitRoot(
          {
            conversations: [touched],
            messages: [message],
            expectedConversations: [conversation],
          },
          receipt,
        );
        conversations.set(touched.id, touched);
        indexMessage(message);
        await announceRoot(receipt);
        return message;
      });
    },

    getSideConversation(conversationId) {
      const entry = visibleConversation(conversationId);
      return entry?.side ? (entry as SideConversation) : undefined;
    },

    listSideConversations(parentConversationId, limit, cursor) {
      requireParent(parentConversationId);
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      const rows = [...conversations.values()]
        .filter(
          (entry): entry is SideConversation =>
            entry.side?.parentConversationId === parentConversationId &&
            entry.side.state !== 'discarded' &&
            entry.familiarId === options.familiarId,
        )
        .sort((left, right) => compareKeys(conversationKey(right), conversationKey(left)))
        .filter((entry) => after === undefined || compareKeys(conversationKey(entry), after) < 0);
      return buildPage(rows.slice(0, limit + 1), limit, conversationKey, cursor);
    },

    createSideConversation(input) {
      return serialize(async () => {
        const parent = requireParent(input.parentConversationId);
        const key = operationKey(input.operationKey);
        const existingId = sideIdsByOperation.get(key);
        const existing = existingId === undefined ? undefined : conversations.get(existingId);
        if (existing?.side) {
          if (
            existing.side.parentConversationId !== parent.id ||
            existing.familiarId !== options.familiarId
          ) {
            throw new ChatStoreError(
              'conflict',
              'This operation key names a different local side note.',
            );
          }
          return existing as SideConversation;
        }
        const timestamp = new Date(now()).toISOString();
        const side: SideConversation = Object.freeze({
          id: createId(),
          familiarId: options.familiarId,
          title: 'Retained side note',
          createdAt: timestamp,
          updatedAt: timestamp,
          side: Object.freeze({
            parentConversationId: parent.id,
            operationKey: key,
            state: 'open',
          }),
        });
        await commit({
          conversations: [side],
          messages: [],
          expectedConversations: [parent],
          absentOperationKey: key,
        });
        conversations.set(side.id, side);
        sideIdsByOperation.set(key, side.id);
        await announce();
        return side;
      });
    },

    setSideState(input, state) {
      return serialize(async () => {
        const side = requireSide(input);
        if (side.side.state === state) return side;
        if (side.side.state === 'discarded') {
          throw new ChatStoreError('not_found', 'This note has been discarded.');
        }
        const touched: SideConversation = Object.freeze({
          ...side,
          revision: (side.revision ?? 0) + 1,
          updatedAt: new Date(Math.max(now(), Date.parse(side.updatedAt) + 1)).toISOString(),
          side: Object.freeze({ ...side.side, state }),
        });
        const deletedMessageIds =
          state === 'discarded'
            ? (messagesByConversation.get(side.id) ?? []).map((entry) => entry.id)
            : [];
        await commit({
          conversations: [touched],
          messages: [],
          deletedMessageIds,
          expectedConversations: [side],
        });
        conversations.set(side.id, touched);
        if (state === 'discarded') {
          for (const message of messagesByConversation.get(side.id) ?? []) {
            if (message.broughtBack) importsByOperation.delete(message.broughtBack.operationKey);
          }
          messagesByConversation.delete(side.id);
        }
        await announce();
        return touched;
      });
    },

    prepareBringBack(input) {
      return serialize(async () => {
        const parent = requireParent(input.parentConversationId);
        const side = requireSide(input);
        if (side.side.state === 'discarded') {
          throw new ChatStoreError('not_found', 'This note has been discarded.');
        }
        return Object.freeze({
          parentRevision: parent.revision ?? 0,
          parentLeafId: messagesByConversation.get(parent.id)?.at(-1)?.id ?? null,
          sideRevision: side.revision ?? 0,
          sideLeafId: messagesByConversation.get(side.id)?.at(-1)?.id ?? null,
        });
      });
    },

    bringBack(input) {
      return serialize(async () => {
        const parent = requireParent(input.parentConversationId);
        const side = requireSide(input);
        const text = reviewedExcerpt(input);
        const previousImport = importsByOperation.get(input.operationKey);
        if (previousImport) {
          if (!sameImport(previousImport, input)) {
            throw new ChatStoreError(
              'conflict',
              'This operation key names another reviewed import.',
            );
          }
          return previousImport;
        }
        const expected = input.preconditions;
        if (
          expected.parentRevision !== (parent.revision ?? 0) ||
          expected.parentLeafId !== (messagesByConversation.get(parent.id)?.at(-1)?.id ?? null) ||
          expected.sideRevision !== (side.revision ?? 0) ||
          expected.sideLeafId !== (messagesByConversation.get(side.id)?.at(-1)?.id ?? null)
        ) {
          throw new ChatStoreError(
            'stale_review',
            'The reviewed local branch changed. Cancel and review again.',
          );
        }
        if (side.side.state === 'discarded') {
          throw new ChatStoreError('not_found', 'This note has been discarded.');
        }
        const sourceMessages = messagesByConversation.get(side.id) ?? [];
        if (
          !input.sourceMessageIds.every((id) => sourceMessages.some((entry) => entry.id === id))
        ) {
          throw new ChatStoreError('not_found', 'A selected source message is unavailable.');
        }
        const previous = messagesByConversation.get(parent.id)?.at(-1);
        const timestamp = new Date(
          Math.max(
            now(),
            Date.parse(parent.updatedAt) + 1,
            previous ? Date.parse(previous.createdAt) + 1 : 0,
          ),
        ).toISOString();
        const message: StoredMessage = Object.freeze({
          id: createId(),
          conversationId: parent.id,
          parentId: previous?.id ?? null,
          role: 'user',
          text,
          createdAt: timestamp,
          broughtBack: Object.freeze({
            operationKey: input.operationKey,
            sideConversationId: side.id,
            sourceMessageIds: Object.freeze([...input.sourceMessageIds]),
            preconditions: Object.freeze({ ...input.preconditions }),
          }),
        });
        const touched = Object.freeze({
          ...parent,
          updatedAt: timestamp,
          revision: (parent.revision ?? 0) + 1,
        });
        await commit({
          conversations: [touched],
          messages: [message],
          expectedConversations: [parent, side],
          absentOperationKey: input.operationKey,
        });
        conversations.set(parent.id, touched);
        indexMessage(message);
        await announce();
        return message;
      });
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
 * Failed opening closes only internally created backends. Injected backends
 * remain caller-owned on failure. On success, the returned store closes its
 * backend when disposed.
 */
export async function openChatStore(
  options: ChatStoreOptions & { backend?: ChatBackend },
): Promise<ChatStore> {
  const injectedBackend = options.backend;
  const backend =
    injectedBackend ?? (await openIndexedDbChatBackend()) ?? createMemoryChatBackend();
  try {
    // A pre-snapshot bound detects concurrent commits; a later revision could certify stale data.
    const revisionBeforeSnapshot = await backend.getMutationRevision?.();
    const records = await backend.loadAll();
    return createHydratedChatStore(backend, records, options, revisionBeforeSnapshot);
  } catch (error) {
    if (injectedBackend === undefined) backend.close();
    throw error;
  }
}
