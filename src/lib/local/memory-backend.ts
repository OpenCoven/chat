import {
  type ChatBackend,
  ChatConflictError,
  type ChatRecords,
  checkPreconditions,
  EMPTY_RECORDS,
  type StoredConversation,
  type StoredMessage,
} from './chat-records';

/**
 * Non-durable backend.
 *
 * Used when IndexedDB is unavailable (hardened webview, private browsing,
 * jsdom). It reports `isDurable() === false` so the UI can say plainly that
 * nothing is being saved, rather than implying persistence it cannot deliver.
 */
export function createMemoryChatBackend(seed: ChatRecords = EMPTY_RECORDS): ChatBackend {
  const conversations = new Map<string, StoredConversation>(
    seed.conversations.map((entry) => [entry.id, entry]),
  );
  const messages = new Map<string, StoredMessage>(seed.messages.map((entry) => [entry.id, entry]));
  const operations = new Map<string, number>();
  function countOperation(key: string | undefined, delta: number) {
    if (!key) return;
    const count = (operations.get(key) ?? 0) + delta;
    if (count === 0) operations.delete(key);
    else operations.set(key, count);
  }
  for (const entry of conversations.values()) countOperation(entry.side?.operationKey, 1);
  for (const entry of messages.values()) countOperation(entry.broughtBack?.operationKey, 1);
  let closed = false;
  let mutationRevision = 0;

  return Object.freeze({
    isDurable: () => false,
    getMutationRevision: () => mutationRevision,
    loadAll: () =>
      Promise.resolve(
        Object.freeze({
          conversations: Object.freeze([...conversations.values()]),
          messages: Object.freeze([...messages.values()]),
        }),
      ),
    commit: (change: ChatRecords) => {
      if (closed) {
        return Promise.reject(new Error('The chat backend is closed.'));
      }
      const { absentOperationKey, ...conditions } = change;
      checkPreconditions(conditions, {
        conversations: (change.expectedConversations ?? []).flatMap((entry) => {
          const actual = conversations.get(entry.id);
          return actual ? [actual] : [];
        }),
        messages: [],
      });
      if (absentOperationKey && operations.has(absentOperationKey)) {
        throw new ChatConflictError('This operation was already committed. Retry to reconcile.');
      }
      for (const entry of change.conversations) {
        countOperation(conversations.get(entry.id)?.side?.operationKey, -1);
        countOperation(entry.side?.operationKey, 1);
        conversations.set(entry.id, entry);
      }
      for (const id of change.deletedMessageIds ?? []) {
        countOperation(messages.get(id)?.broughtBack?.operationKey, -1);
        messages.delete(id);
      }
      for (const entry of change.messages) {
        countOperation(messages.get(entry.id)?.broughtBack?.operationKey, -1);
        countOperation(entry.broughtBack?.operationKey, 1);
        messages.set(entry.id, entry);
      }
      mutationRevision += 1;
      return Promise.resolve();
    },
    close: () => {
      closed = true;
    },
  });
}
