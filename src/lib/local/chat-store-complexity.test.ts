import { performance } from 'node:perf_hooks';
import type { ChatRecords } from './chat-records';
import { createChatStore, openChatStore } from './chat-store';
import { createMemoryChatBackend } from './memory-backend';

function retainedHistory(count = 20_000): ChatRecords {
  const timestamp = '2026-09-09T00:00:00.000Z';
  const parent = {
    id: 'parent',
    familiarId: 'local',
    title: 'Parent',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    conversations: [
      parent,
      {
        ...parent,
        id: 'long',
        side: { parentConversationId: parent.id, operationKey: 'retained', state: 'open' },
      },
      { ...parent, id: 'empty', title: 'Empty destination' },
    ],
    messages: Array.from({ length: count }, (_, index) => ({
      id: `m-${String(index).padStart(6, '0')}`,
      conversationId: 'long',
      parentId: index ? `m-${String(index - 1).padStart(6, '0')}` : null,
      role: 'user' as const,
      text: 'short message',
      createdAt: new Date(Date.parse(timestamp) + index).toISOString(),
    })),
  };
}

test('refresh sorts a 20,000-message retained bucket at most once per write', async () => {
  const records = retainedHistory();
  const backend = createMemoryChatBackend(records);
  const store = createChatStore(backend, records, { familiarId: 'local' });
  const original = Array.prototype.sort;
  let largeBucketSorts = 0;
  const sort = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (
    this: unknown[],
    compare,
  ) {
    if (this.length >= 1_000) largeBucketSorts += 1;
    return original.call(this, compare);
  });
  try {
    const saved = await store.appendMessage('empty', 'user', 'new note');
    expect(saved.parentId).toBeNull();
    expect(store.listMessages('long', 1).data[0]?.id).toBe('m-000000');
    expect(largeBucketSorts).toBeLessThanOrEqual(1);
  } finally {
    sort.mockRestore();
  }
}, 30_000);

test.each([false, true])(
  'shared revisions avoid reloads and expose external writers (async=%s)',
  async (asynchronous) => {
    const records = retainedHistory(50);
    const backend = createMemoryChatBackend(records);
    const loadAll = vi.fn(backend.loadAll);
    const getRevision = backend.getMutationRevision;
    if (!getRevision) throw new Error('Missing shared backend revision');
    const tracked = {
      ...backend,
      loadAll,
      getMutationRevision: () => (asynchronous ? Promise.resolve(getRevision()) : getRevision()),
    };
    const first = createChatStore(tracked, records, { familiarId: 'local' });
    const second = createChatStore(tracked, records, { familiarId: 'local' });
    const one = await first.appendMessage('empty', 'user', 'one');
    const reads = loadAll.mock.calls.length;
    const two = await first.appendMessage('empty', 'user', 'two');
    expect(loadAll.mock.calls.length).toBe(reads);
    expect(two.parentId).toBe(one.id);
    const other = await second.appendMessage('empty', 'user', 'other window');
    expect(other.parentId).toBe(two.id);
    const three = await first.appendMessage('empty', 'user', 'three');
    expect(three.parentId).toBe(other.id);
  },
);

test('import operation lookup does not flatten retained history during admission, replay or rehydration', async () => {
  const records = retainedHistory();
  const backend = createMemoryChatBackend(records);
  const store = createChatStore(backend, records, { familiarId: 'local' });
  const input = {
    parentConversationId: 'parent',
    sideConversationId: 'long',
    sourceMessageIds: ['m-000000'],
    operationKey: 'indexed-import',
    excerpt: 'reviewed excerpt',
  };
  await store.prepareBringBack(input);
  const flat = vi.spyOn(Array.prototype, 'flat');
  try {
    const saved = await store.bringBack(input);
    expect((await store.bringBack(input)).id).toBe(saved.id);
    const reloaded = await openChatStore({ backend, familiarId: 'local' });
    expect((await reloaded.bringBack(input)).id).toBe(saved.id);
    await reloaded.setSideState(input, 'discarded');
    expect((await reloaded.bringBack(input)).id).toBe(saved.id);
    expect((await store.bringBack(input)).id).toBe(saved.id);
    expect(flat).not.toHaveBeenCalled();
    expect(reloaded.listMessages('parent', 50).data).toHaveLength(1);
  } finally {
    flat.mockRestore();
  }
});

test.skipIf(process.env.CHAT_APPEND_BENCHMARK !== '1')(
  'reports 20k retained-history append samples excluding initialization',
  async () => {
    const records = retainedHistory();
    const backend = createMemoryChatBackend(records);
    const store = createChatStore(backend, records, { familiarId: 'local' });
    const milliseconds: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const start = performance.now();
      await store.appendMessage('empty', 'user', `sample ${index}`);
      milliseconds.push(Number((performance.now() - start).toFixed(3)));
    }
    console.info(
      JSON.stringify({
        benchmark: '20k-retained-append',
        backend: 'memory',
        initializationExcluded: true,
        milliseconds,
      }),
    );
    expect(store.listMessages('empty', 10).data).toHaveLength(3);
  },
  30_000,
);
