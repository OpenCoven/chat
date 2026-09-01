import type { ChatBackend, ChatRecords, StoredConversation, StoredMessage } from './chat-records';

export const CHAT_DATABASE_NAME = 'opencoven-chat';
export const CHAT_DATABASE_VERSION = 1;
export const CONVERSATION_STORE = 'conversations';
export const MESSAGE_STORE = 'messages';

/**
 * Written from the first release so a later store (a Tauri/SQLite backend, say)
 * can recognise and migrate this data instead of guessing at its shape.
 */
export const CHAT_SCHEMA_VERSION = 1;

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The storage request failed.'));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(CHAT_DATABASE_NAME, CHAT_DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      const transaction = request.transaction;
      if (transaction === null) {
        return;
      }

      const metaStore = database.objectStoreNames.contains('meta')
        ? transaction.objectStore('meta')
        : database.createObjectStore('meta', { keyPath: 'key' });
      metaStore.put({ key: 'schemaVersion', value: CHAT_SCHEMA_VERSION });

      if (!database.objectStoreNames.contains(CONVERSATION_STORE)) {
        const store = database.createObjectStore(CONVERSATION_STORE, { keyPath: 'id' });
        store.createIndex('by_updated', ['updatedAt', 'id']);
      }
      if (!database.objectStoreNames.contains(MESSAGE_STORE)) {
        const store = database.createObjectStore(MESSAGE_STORE, { keyPath: 'id' });
        store.createIndex('by_conversation', ['conversationId', 'createdAt', 'id']);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The chat database failed to open.'));
    request.onblocked = () => reject(new Error('The chat database is blocked by another tab.'));
  });
}

export function resolveIndexedDbFactory(scope: typeof globalThis = globalThis): IDBFactory | null {
  const candidate = (scope as { indexedDB?: IDBFactory }).indexedDB;
  return candidate === undefined || candidate === null ? null : candidate;
}

/**
 * Durable backend over IndexedDB.
 *
 * Chosen over `localStorage` because conversations and messages are separate
 * indexed collections that grow without a ~5 MB ceiling, and because every
 * write here has to be atomic across two stores — which a single `readwrite`
 * transaction gives us and a serialized JSON blob does not.
 */
export function createIndexedDbChatBackend(database: IDBDatabase): ChatBackend {
  let closed = false;

  async function loadAll(): Promise<ChatRecords> {
    const transaction = database.transaction([CONVERSATION_STORE, MESSAGE_STORE], 'readonly');
    const [conversations, messages] = await Promise.all([
      requestAsPromise(transaction.objectStore(CONVERSATION_STORE).getAll()),
      requestAsPromise(transaction.objectStore(MESSAGE_STORE).getAll()),
    ]);

    return Object.freeze({
      conversations: Object.freeze(conversations as StoredConversation[]),
      messages: Object.freeze(messages as StoredMessage[]),
    });
  }

  function commit(change: ChatRecords): Promise<void> {
    if (closed) {
      return Promise.reject(new Error('The chat backend is closed.'));
    }

    return new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([CONVERSATION_STORE, MESSAGE_STORE], 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('The storage transaction aborted.'));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('The storage transaction failed.'));

      const conversationStore = transaction.objectStore(CONVERSATION_STORE);
      for (const entry of change.conversations) {
        conversationStore.put(entry);
      }
      const messageStore = transaction.objectStore(MESSAGE_STORE);
      for (const entry of change.messages) {
        messageStore.put(entry);
      }
    });
  }

  return Object.freeze({
    isDurable: () => true,
    loadAll,
    commit,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      database.close();
    },
  });
}

export async function openIndexedDbChatBackend(
  factory: IDBFactory | null = resolveIndexedDbFactory(),
): Promise<ChatBackend | null> {
  if (factory === null) {
    return null;
  }

  try {
    return createIndexedDbChatBackend(await openDatabase(factory));
  } catch {
    return null;
  }
}
