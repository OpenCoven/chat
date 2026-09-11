import {
  type ChatBackend,
  type ChatRecords,
  checkPreconditions,
  type StoredConversation,
  type StoredMessage,
} from './chat-records';

export const CHAT_DATABASE_NAME = 'opencoven-chat';
export const CHAT_DATABASE_VERSION = 2;
export const CONVERSATION_STORE = 'conversations';
export const MESSAGE_STORE = 'messages';

/**
 * Written from the first release so a later store (a Tauri/SQLite backend, say)
 * can recognise and migrate this data instead of guessing at its shape.
 */
export const CHAT_SCHEMA_VERSION = 2;

function mutationRevision(record: unknown): number {
  if (
    typeof record !== 'object' ||
    record === null ||
    !('value' in record) ||
    typeof record.value !== 'number' ||
    !Number.isSafeInteger(record.value) ||
    record.value < 0
  ) {
    throw new Error('The chat mutation revision is invalid.');
  }
  return record.value;
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The storage request failed.'));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(CHAT_DATABASE_NAME, CHAT_DATABASE_VERSION);
    let blocked = false;

    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      if (transaction === null) {
        return;
      }
      if (blocked) {
        transaction.abort();
        return;
      }

      const metaStore = database.objectStoreNames.contains('meta')
        ? transaction.objectStore('meta')
        : database.createObjectStore('meta', { keyPath: 'key' });
      metaStore.put({ key: 'schemaVersion', value: CHAT_SCHEMA_VERSION });
      if (event.oldVersion < 2) metaStore.put({ key: 'mutationRevision', value: 0 });

      if (!database.objectStoreNames.contains(CONVERSATION_STORE)) {
        const store = database.createObjectStore(CONVERSATION_STORE, { keyPath: 'id' });
        store.createIndex('by_updated', ['updatedAt', 'id']);
      }
      if (!database.objectStoreNames.contains(MESSAGE_STORE)) {
        const store = database.createObjectStore(MESSAGE_STORE, { keyPath: 'id' });
        store.createIndex('by_conversation', ['conversationId', 'createdAt', 'id']);
      }
      const conversations = transaction.objectStore(CONVERSATION_STORE);
      const messages = transaction.objectStore(MESSAGE_STORE);
      if (!conversations.indexNames.contains('by_operation')) {
        conversations.createIndex('by_operation', 'side.operationKey');
      }
      if (!messages.indexNames.contains('by_operation')) {
        messages.createIndex('by_operation', 'broughtBack.operationKey');
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error('The chat database failed to open.'));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('The chat database is blocked by another tab.'));
    };
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

  async function getMutationRevision(): Promise<number> {
    const transaction = database.transaction('meta', 'readonly');
    return mutationRevision(
      await requestAsPromise(transaction.objectStore('meta').get('mutationRevision')),
    );
  }

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
      const transaction = database.transaction(
        ['meta', CONVERSATION_STORE, MESSAGE_STORE],
        'readwrite',
      );
      let failed = false;
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => {
        failed = true;
        reject(transaction.error ?? new Error('The storage transaction aborted.'));
      };
      transaction.onerror = () => {
        failed = true;
        reject(transaction.error ?? new Error('The storage transaction failed.'));
      };

      const metaStore = transaction.objectStore('meta');
      const conversationStore = transaction.objectStore(CONVERSATION_STORE);
      const messageStore = transaction.objectStore(MESSAGE_STORE);
      const key = change.absentOperationKey;
      void Promise.all([
        requestAsPromise(metaStore.get('mutationRevision')),
        Promise.all(
          (change.expectedConversations ?? []).map((entry) =>
            requestAsPromise<StoredConversation | undefined>(conversationStore.get(entry.id)),
          ),
        ),
        key
          ? requestAsPromise<StoredConversation | undefined>(
              conversationStore.index('by_operation').get(key),
            )
          : undefined,
        key
          ? requestAsPromise<StoredMessage | undefined>(messageStore.index('by_operation').get(key))
          : undefined,
      ])
        .then(([revisionRecord, expected, operationConversation, operationMessage]) => {
          const revision = mutationRevision(revisionRecord);
          if (revision === Number.MAX_SAFE_INTEGER)
            throw new Error('The chat mutation revision is exhausted.');
          checkPreconditions(change, {
            conversations: [
              ...expected.filter((entry) => entry !== undefined),
              ...(operationConversation ? [operationConversation] : []),
            ],
            messages: operationMessage ? [operationMessage] : [],
          });
          for (const entry of change.conversations) conversationStore.put(entry);
          for (const id of change.deletedMessageIds ?? []) messageStore.delete(id);
          for (const entry of change.messages) messageStore.put(entry);
          metaStore.put({ key: 'mutationRevision', value: revision + 1 });
        })
        .catch((error: unknown) => {
          reject(error);
          if (!failed) transaction.abort();
        });
    });
  }

  return Object.freeze({
    isDurable: () => true,
    getMutationRevision,
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
