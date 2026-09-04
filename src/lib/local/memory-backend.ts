import {
  type ChatBackend,
  type ChatRecords,
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
  let closed = false;

  return Object.freeze({
    isDurable: () => false,
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
      for (const entry of change.conversations) {
        conversations.set(entry.id, entry);
      }
      for (const entry of change.messages) {
        messages.set(entry.id, entry);
      }
      return Promise.resolve();
    },
    close: () => {
      closed = true;
    },
  });
}
