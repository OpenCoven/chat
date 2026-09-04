import type { Page } from '@opencoven/sdk-core/browser';

import { createManualPageWalk, MAX_MANUAL_PAGE_WALK_PAGES } from '../sdk/manual-page-walk';
import type { QueryAdapter } from '../sdk/query-adapter';
import { type ChatRecords, EMPTY_RECORDS, type StoredConversation } from './chat-records';
import {
  ChatStoreError,
  createChatStore,
  decodeCursor,
  encodeCursor,
  openChatStore,
} from './chat-store';
import { createLocalChatWriter, createReadOnlyChatWriter } from './chat-writer';
import { openIndexedDbChatBackend } from './indexeddb-backend';
import { createLocalQueryAdapter, LOCAL_FAMILIAR_ID } from './local-query-adapter';
import { createMemoryChatBackend } from './memory-backend';

const FIXED_START = Date.parse('2026-09-01T00:00:00.000Z');

function createHarness(seed: ChatRecords = EMPTY_RECORDS) {
  let tick = 0;
  let sequence = 0;
  const backend = createMemoryChatBackend(seed);
  const store = createChatStore(backend, seed, {
    familiarId: LOCAL_FAMILIAR_ID,
    now: () => {
      tick += 1;
      return FIXED_START + tick * 1_000;
    },
    createId: () => {
      sequence += 1;
      return `id-${String(sequence).padStart(4, '0')}`;
    },
  });

  return Object.freeze({ backend, store });
}

async function seedConversations(count: number) {
  const harness = createHarness();
  const created: StoredConversation[] = [];
  for (let index = 0; index < count; index += 1) {
    created.push(await harness.store.createConversation(`Conversation ${index + 1}`));
  }
  return Object.freeze({ ...harness, created });
}

describe('local chat store cursors', () => {
  it('round-trips a cursor through base64url without padding', () => {
    const cursor = encodeCursor({ t: '2026-09-01T00:00:01.000Z', i: 'id-0001' });

    expect(cursor).not.toContain('=');
    expect(cursor).not.toContain('+');
    expect(cursor).not.toContain('/');
    expect(decodeCursor(cursor)).toEqual({ t: '2026-09-01T00:00:01.000Z', i: 'id-0001' });
  });

  it('rejects a malformed cursor as invalid_request rather than returning page one', () => {
    const { store } = createHarness();

    expect(() => store.listConversations(10, 'not-a-cursor')).toThrow(ChatStoreError);
    try {
      store.listConversations(10, 'not-a-cursor');
    } catch (error: unknown) {
      expect((error as ChatStoreError).code).toBe('invalid_request');
    }
  });

  it('omits next when there is no further page', async () => {
    const { store } = await seedConversations(2);
    const page = store.listConversations(10);

    expect(page.data).toHaveLength(2);
    expect(page.cursor?.hasMore).toBe(false);
    expect(page.cursor?.next).toBeUndefined();
  });

  it('walks every conversation exactly once under the real page-walk contract', async () => {
    const { store, created } = await seedConversations(7);
    const walk = createManualPageWalk();

    const root = store.listConversations(2);
    expect(walk.acceptRootPage(root)).toBe(true);

    const seen: string[] = root.data.map((entry) => entry.id);
    let cursor = root.cursor?.hasMore === true ? root.cursor.next : undefined;

    while (cursor !== undefined) {
      expect(walk.canFetchNextPage()).toBe(true);
      const page = store.listConversations(2, cursor);
      expect(walk.acceptNextPage(cursor, page)).toBe(true);
      seen.push(...page.data.map((entry) => entry.id));
      cursor = page.cursor?.hasMore === true ? page.cursor.next : undefined;
    }

    expect(seen).toHaveLength(created.length);
    expect(new Set(seen).size).toBe(created.length);
    // Newest first: the last conversation created sorts to the front.
    expect(seen[0]).toBe(created.at(-1)?.id);
  });

  it('echoes the requested cursor back byte-identically', async () => {
    const { store } = await seedConversations(4);
    const root = store.listConversations(1);
    const cursor = root.cursor?.next;

    expect(typeof cursor).toBe('string');
    const second = store.listConversations(1, cursor);
    expect(second.cursor?.current).toBe(cursor);
  });

  it('never reissues a cursor already seen in the same walk', async () => {
    const { store } = await seedConversations(MAX_MANUAL_PAGE_WALK_PAGES);
    const issued = new Set<string>();

    let cursor = store.listConversations(1).cursor?.next;
    while (cursor !== undefined) {
      expect(issued.has(cursor)).toBe(false);
      issued.add(cursor);
      cursor = store.listConversations(1, cursor).cursor?.next;
    }

    expect(issued.size).toBeGreaterThan(0);
  });

  it('pages messages oldest first and keeps them inside their conversation', async () => {
    const { store } = await seedConversations(2);
    const [newest, older] = store.listConversations(10).data;
    if (newest === undefined || older === undefined) {
      throw new Error('expected two conversations');
    }

    await store.appendMessage(newest.id, 'user', 'first');
    await store.appendMessage(newest.id, 'user', 'second');
    await store.appendMessage(older.id, 'user', 'other conversation');

    const page = store.listMessages(newest.id, 10);
    expect(page.data.map((entry) => entry.text)).toEqual(['first', 'second']);
    expect(store.listMessages(older.id, 10).data.map((entry) => entry.text)).toEqual([
      'other conversation',
    ]);
  });
});

describe('local chat store writes', () => {
  it('links each message to the previous one in the conversation', async () => {
    const { store } = await seedConversations(1);
    const conversation = store.listConversations(1).data[0];
    if (conversation === undefined) {
      throw new Error('expected a conversation');
    }

    const first = await store.appendMessage(conversation.id, 'user', 'one');
    const second = await store.appendMessage(conversation.id, 'user', 'two');

    expect(first.parentId).toBeNull();
    expect(second.parentId).toBe(first.id);
  });

  it('bumps the conversation timestamp in the same commit as the message', async () => {
    const commits: ChatRecords[] = [];
    const inner = createMemoryChatBackend();
    const recording = Object.freeze({
      isDurable: () => true,
      loadAll: inner.loadAll,
      commit: (change: ChatRecords) => {
        commits.push(change);
        return inner.commit(change);
      },
      close: inner.close,
    });
    const store = createChatStore(recording, EMPTY_RECORDS, { familiarId: LOCAL_FAMILIAR_ID });

    const conversation = await store.createConversation('Atomicity');
    await store.appendMessage(conversation.id, 'user', 'hello');

    const messageCommit = commits.at(-1);
    expect(messageCommit?.messages).toHaveLength(1);
    expect(messageCommit?.conversations).toHaveLength(1);
    expect(messageCommit?.conversations[0]?.updatedAt).toBe(messageCommit?.messages[0]?.createdAt);
  });

  it('leaves the in-memory index untouched when the backend rejects', async () => {
    const failing = Object.freeze({
      isDurable: () => true,
      loadAll: () => Promise.resolve(EMPTY_RECORDS),
      commit: () => Promise.reject(new Error('disk full')),
      close: () => undefined,
    });
    const store = createChatStore(failing, EMPTY_RECORDS, { familiarId: LOCAL_FAMILIAR_ID });

    await expect(store.createConversation('doomed')).rejects.toBeInstanceOf(ChatStoreError);
    expect(store.listConversations(10).data).toHaveLength(0);
    expect(store.getRevision()).toBe(0);
  });

  it('rejects blank and oversized message text', async () => {
    const { store } = await seedConversations(1);
    const conversation = store.listConversations(1).data[0];
    if (conversation === undefined) {
      throw new Error('expected a conversation');
    }

    await expect(store.appendMessage(conversation.id, 'user', '   ')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      store.appendMessage(conversation.id, 'user', 'x'.repeat(40_000)),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('reports a missing conversation as not_found', async () => {
    const { store } = createHarness();

    await expect(store.appendMessage('missing', 'user', 'hi')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('drops corrupt rows on load instead of failing the whole read', () => {
    const seed = {
      conversations: [
        {
          id: 'good',
          familiarId: LOCAL_FAMILIAR_ID,
          title: 'Kept',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
        { id: '', familiarId: '', title: 1, createdAt: 'nope', updatedAt: 'nope' },
      ],
      messages: [{ id: 'orphan', conversationId: 'gone', parentId: null, role: 'user', text: 'x' }],
    } as unknown as ChatRecords;
    const store = createChatStore(createMemoryChatBackend(), seed, {
      familiarId: LOCAL_FAMILIAR_ID,
    });

    expect(store.listConversations(10).data.map((entry) => entry.id)).toEqual(['good']);
    expect(store.listMessages('gone', 10).data).toHaveLength(0);
  });

  it('notifies subscribers once per committed write', async () => {
    const { store } = createHarness();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const conversation = await store.createConversation('Watched');
    await store.appendMessage(conversation.id, 'user', 'hello');
    unsubscribe();
    await store.appendMessage(conversation.id, 'user', 'unheard');

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getRevision()).toBe(3);
  });
});

describe('chat writers', () => {
  it('refuses Cave writes as unsupported rather than as an error', async () => {
    const writer = createReadOnlyChatWriter();

    expect(writer.canWrite()).toBe(false);
    await expect(writer.sendMessage('conversation', 'hi')).resolves.toMatchObject({
      status: 'unsupported',
    });
  });

  it('returns a Cave-shaped message with honest zero counts', async () => {
    const { store } = await seedConversations(1);
    const conversation = store.listConversations(1).data[0];
    if (conversation === undefined) {
      throw new Error('expected a conversation');
    }
    const writer = createLocalChatWriter(store);

    const result = await writer.sendMessage(conversation.id, '  spaced  ');
    expect(result).toMatchObject({
      status: 'ok',
      data: { role: 'user', text: 'spaced', attachmentCount: 0, toolCount: 0 },
    });
  });

  it('surfaces validation failures as error codes', async () => {
    const { store } = await seedConversations(1);
    const conversation = store.listConversations(1).data[0];
    if (conversation === undefined) {
      throw new Error('expected a conversation');
    }

    await expect(createLocalChatWriter(store).sendMessage(conversation.id, '')).resolves.toEqual({
      status: 'error',
      code: 'invalid_request',
    });
  });
});

describe('storage fallback', () => {
  it('reports the store as non-durable when the platform has no IndexedDB', async () => {
    await expect(openIndexedDbChatBackend(null)).resolves.toBeNull();

    const store = await openChatStore({ familiarId: LOCAL_FAMILIAR_ID });
    expect(store.isDurable()).toBe(false);

    // Still fully functional — the fallback loses durability, not the app.
    const conversation = await store.createConversation('In memory');
    expect(store.getConversation(conversation.id)?.title).toBe('In memory');
    store.dispose();
  });

  it('starts empty when the backend cannot be read', async () => {
    const unreadable = Object.freeze({
      isDurable: () => true,
      loadAll: () => Promise.reject(new Error('corrupt')),
      commit: () => Promise.resolve(),
      close: () => undefined,
    });

    const store = await openChatStore({ familiarId: LOCAL_FAMILIAR_ID, backend: unreadable });
    expect(store.listConversations(10).data).toHaveLength(0);
  });
});

/**
 * Runs the same expectations against any `QueryAdapter`, so the local adapter is
 * held to the contract the Cave adapter already satisfies rather than to a
 * private one of its own.
 */
function describeQueryAdapterContract(
  label: string,
  build: () => Promise<Readonly<{ adapter: QueryAdapter; conversationId: string }>>,
) {
  describe(`${label} query adapter contract`, () => {
    it('returns an ok page for every list operation', async () => {
      const { adapter } = await build();

      for (const result of await Promise.all([
        adapter.listFamiliars(),
        adapter.listProjects(),
        adapter.listConversations(),
      ])) {
        expect(result.status).toBe('ok');
        if (result.status === 'ok') {
          expect(Array.isArray((result.data as Page<unknown>).data)).toBe(true);
        }
      }
    });

    it('rejects an out-of-range limit as invalid_request', async () => {
      const { adapter } = await build();

      await expect(adapter.listConversations({ limit: -1 })).resolves.toEqual({
        status: 'error',
        code: 'invalid_request',
      });
    });

    it('reports a missing conversation as not_found', async () => {
      const { adapter } = await build();

      await expect(adapter.getConversation('definitely-missing')).resolves.toEqual({
        status: 'error',
        code: 'not_found',
      });
    });

    it('returns the conversation it lists', async () => {
      const { adapter, conversationId } = await build();

      const result = await adapter.getConversation(conversationId);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.data.id).toBe(conversationId);
      }
    });

    it('stays usable after invalidate and inert after dispose', async () => {
      const { adapter } = await build();

      adapter.invalidate();
      await expect(adapter.listConversations()).resolves.toMatchObject({ status: 'ok' });

      adapter.dispose();
      await expect(adapter.listConversations()).resolves.toEqual({ status: 'not_ready' });
    });
  });
}

describeQueryAdapterContract('local', async () => {
  const { store } = await seedConversations(1);
  const conversation = store.listConversations(1).data[0];
  if (conversation === undefined) {
    throw new Error('expected a conversation');
  }
  return { adapter: createLocalQueryAdapter(store), conversationId: conversation.id };
});

describe('local query adapter surface', () => {
  it('exposes exactly one synthetic familiar so the rail filter stays meaningful', async () => {
    const { store } = createHarness();
    const result = await createLocalQueryAdapter(store).listFamiliars();

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.data).toHaveLength(1);
      expect(result.data.data[0]?.id).toBe(LOCAL_FAMILIAR_ID);
    }
  });

  it('returns an empty project page rather than an error', async () => {
    const { store } = createHarness();
    const result = await createLocalQueryAdapter(store).listProjects();

    expect(result).toMatchObject({ status: 'ok' });
    if (result.status === 'ok') {
      expect(result.data.data).toHaveLength(0);
      expect(result.data.cursor?.hasMore).toBe(false);
    }
  });

  it('reports contract and analytics as unavailable rather than inventing them', async () => {
    const { store } = await seedConversations(1);
    const adapter = createLocalQueryAdapter(store);

    // An empty contract would read as "this familiar is permitted nothing",
    // which is a different claim from "nobody asked Cave".
    await expect(adapter.familiarContract(LOCAL_FAMILIAR_ID)).resolves.toEqual({
      status: 'error',
      code: 'service_unavailable',
    });
    await expect(adapter.familiarAnalytics(LOCAL_FAMILIAR_ID)).resolves.toEqual({
      status: 'error',
      code: 'service_unavailable',
    });
  });

  it('never emits loading, stale, or reconcile_required', async () => {
    const { store } = await seedConversations(1);
    const adapter = createLocalQueryAdapter(store);

    const statuses = (
      await Promise.all([
        adapter.listFamiliars(),
        adapter.listProjects(),
        adapter.listConversations(),
        adapter.getConversation('missing'),
        adapter.listMessages('missing'),
        adapter.familiarContract('missing'),
        adapter.familiarAnalytics('missing'),
      ])
    ).map((result) => result.status);

    expect(statuses.every((status) => status === 'ok' || status === 'error')).toBe(true);
  });
});
