import { performance } from 'node:perf_hooks';
import type { ChatRecords } from './chat-records';
import { createChatStore, openChatStore } from './chat-store';
import { createLocalChatWriter } from './chat-writer';
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

test.each([50, 20_000])(
  'the first write after opening %s retained messages does not reload the initial snapshot',
  async (size) => {
    const backend = createMemoryChatBackend(retainedHistory(size));
    const loadAll = vi.fn(backend.loadAll);
    const store = await openChatStore({ backend: { ...backend, loadAll }, familiarId: 'local' });
    expect(loadAll).toHaveBeenCalledOnce();
    await store.appendMessage('empty', 'user', 'First write');
    expect(loadAll).toHaveBeenCalledOnce();
    expect(store.listMessages('long', 1).data[0]?.id).toBe('m-000000');
  },
);

test.each(['during', 'after'] as const)(
  'a revision sampled before hydration detects an external commit %s its initial snapshot',
  async (when) => {
    const backend = createMemoryChatBackend(retainedHistory(50));
    const external = {
      id: 'external',
      familiarId: 'local',
      title: 'External root',
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    };
    let first = true;
    const loadAll = vi.fn(async () => {
      const snapshot = await backend.loadAll();
      if (first) {
        first = false;
        if (when === 'during') await backend.commit({ conversations: [external], messages: [] });
      }
      return snapshot;
    });
    const store = await openChatStore({ backend: { ...backend, loadAll }, familiarId: 'local' });
    if (when === 'after') await backend.commit({ conversations: [external], messages: [] });
    await store.appendMessage('empty', 'user', 'First write');
    expect(store.getConversation('external')).toEqual(external);
    expect(loadAll).toHaveBeenCalledTimes(2);
  },
);

test('a backend without revisions still reloads before the first write', async () => {
  const backend = createMemoryChatBackend(retainedHistory(50));
  const { getMutationRevision: _revision, ...withoutRevision } = backend;
  const loadAll = vi.fn(backend.loadAll);
  const store = await openChatStore({
    backend: { ...withoutRevision, loadAll },
    familiarId: 'local',
  });
  await store.appendMessage('empty', 'user', 'First write');
  expect(loadAll).toHaveBeenCalledTimes(2);
});

test('failed initial hydration rejects and retry binds only a successfully loaded snapshot', async () => {
  const backend = createMemoryChatBackend(retainedHistory(50));
  const loadAll = vi.fn(backend.loadAll).mockRejectedValueOnce(new Error('initial read failed'));
  await expect(
    openChatStore({ backend: { ...backend, loadAll }, familiarId: 'local' }),
  ).rejects.toThrow('initial read failed');
  const store = await openChatStore({ backend: { ...backend, loadAll }, familiarId: 'local' });
  await store.appendMessage('empty', 'user', 'First write');
  expect(loadAll).toHaveBeenCalledTimes(2);
  expect(store.listMessages('long', 1).data[0]?.id).toBe('m-000000');
});

test('an initial revision read failure surfaces instead of marking an unchecked snapshot fresh', async () => {
  const backend = createMemoryChatBackend(retainedHistory(50));
  await expect(
    openChatStore({
      backend: {
        ...backend,
        getMutationRevision: () => Promise.reject(new Error('initial revision read failed')),
      },
      familiarId: 'local',
    }),
  ).rejects.toThrow('initial revision read failed');
});

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
  const selection = {
    parentConversationId: 'parent',
    sideConversationId: 'long',
    sourceMessageIds: ['m-000000'],
    operationKey: 'indexed-import',
    excerpt: 'reviewed excerpt',
  };
  const input = { ...selection, preconditions: await store.prepareBringBack(selection) };
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

test.each(['append', 'import', 'create', 'side', 'state'])(
  'successful %s observers see a detected competing commit immediately',
  async (operation) => {
    const records = retainedHistory(10);
    const backend = createMemoryChatBackend(records);
    const parent = records.conversations[0];
    if (!parent) throw new Error('Missing fixture');
    const external = { ...parent, id: 'external', title: 'Other window' };
    const store = createChatStore(
      {
        ...backend,
        async commit(change) {
          await backend.commit({
            conversations: [external],
            messages: [
              {
                id: 'external-message',
                conversationId: external.id,
                parentId: null,
                role: 'user',
                text: 'Other window text',
                createdAt: external.createdAt,
              },
            ],
          });
          await backend.commit(change);
        },
      },
      records,
      { familiarId: 'local' },
    );
    const observed: string[][] = [];
    store.subscribe(() => {
      observed.push(store.listConversations(50).data.map((entry) => entry.id));
      expect(store.listMessages('external', 50).data).toHaveLength(1);
    });
    const side = { parentConversationId: 'parent', sideConversationId: 'long' };
    if (operation === 'append') await store.appendMessage('empty', 'user', 'ours');
    if (operation === 'import')
      await store.bringBack({
        ...side,
        sourceMessageIds: ['m-000000'],
        operationKey: 'ours',
        excerpt: 'ours',
        preconditions: await store.prepareBringBack(side),
      });
    if (operation === 'create') await store.createConversation('ours');
    if (operation === 'side')
      await store.createSideConversation({ parentConversationId: 'parent', operationKey: 'ours' });
    if (operation === 'state') await store.setSideState(side, 'closed');
    expect(observed).toHaveLength(1);
    expect(observed[0]).toContain('external');
    if (operation === 'append') expect(store.listMessages('empty', 50).data).toHaveLength(1);
    if (operation === 'import') expect(store.listMessages('parent', 50).data).toHaveLength(1);
  },
);

test('post-commit reconciliation cannot duplicate our message or overwrite a newer conversation snapshot', async () => {
  const records = retainedHistory(0);
  const backend = createMemoryChatBackend(records);
  const store = createChatStore(
    {
      ...backend,
      async commit(change) {
        await backend.commit(change);
        const own = change.messages[0];
        const conversation = change.conversations[0];
        if (!own || !conversation) throw new Error('Missing own append');
        const timestamp = new Date(Date.parse(own.createdAt) + 1).toISOString();
        await backend.commit({
          conversations: [
            { ...conversation, updatedAt: timestamp, revision: (conversation.revision ?? 0) + 1 },
          ],
          messages: [
            {
              ...own,
              id: 'after-ours',
              parentId: own.id,
              text: 'other window',
              createdAt: timestamp,
            },
          ],
          expectedConversations: [conversation],
        });
      },
    },
    records,
    { familiarId: 'local' },
  );
  const listener = vi.fn(() => {
    expect(store.listMessages('empty', 50).data.map((entry) => entry.text)).toEqual([
      'ours',
      'other window',
    ]);
    expect(store.getConversation('empty')?.revision).toBe(2);
  });
  store.subscribe(listener);
  await store.appendMessage('empty', 'user', 'ours');
  expect(listener).toHaveBeenCalledOnce();
});
test('side operation admission and replay do not enumerate 20000 unrelated conversations', async () => {
  const parent = retainedHistory(0).conversations[0];
  if (!parent) throw new Error('Missing parent fixture');
  const records: ChatRecords = {
    conversations: [
      parent,
      ...Array.from({ length: 20000 }, (_, index) => ({
        ...parent,
        id: `side-${index}`,
        side: {
          parentConversationId: parent.id,
          operationKey: `key-${index}`,
          state: 'open' as const,
        },
      })),
    ],
    messages: [],
  };
  let revision = 0;
  // Isolate store admission from backend persistence, which has separate real-IDB coverage.
  const backend = {
    isDurable: () => false,
    loadAll: async () => records,
    getMutationRevision: () => revision,
    commit: vi.fn(async () => {
      revision += 1;
    }),
    close: () => undefined,
  };
  const store = createChatStore(backend, records, { familiarId: 'local' });
  await store.prepareBringBack({ parentConversationId: parent.id, sideConversationId: 'side-0' });
  const original = Map.prototype.values;
  let largeEnumerations = 0;
  const values = vi.spyOn(Map.prototype, 'values').mockImplementation(function (
    this: Map<unknown, unknown>,
  ) {
    if (this.size >= 20000) largeEnumerations += 1;
    return original.call(this);
  });
  try {
    expect(
      (
        await store.createSideConversation({
          parentConversationId: parent.id,
          operationKey: 'key-19999',
        })
      ).id,
    ).toBe('side-19999');
    const input = { parentConversationId: parent.id, operationKey: 'fresh-key' };
    const created = await store.createSideConversation(input);
    expect((await store.createSideConversation(input)).id).toBe(created.id);
    expect(backend.commit).toHaveBeenCalledTimes(1);
    expect(largeEnumerations).toBe(0);
  } finally {
    values.mockRestore();
  }
});

test('post-commit revision read failure is uncertain and does not notify success or duplicate a retried import', async () => {
  const records = retainedHistory(1);
  const backend = createMemoryChatBackend(records);
  const getRevision = backend.getMutationRevision;
  if (!getRevision) throw new Error('Missing shared revision');
  let reads = 0;
  const store = createChatStore(
    {
      ...backend,
      getMutationRevision() {
        if (++reads === 3) throw new Error('Revision read failed after commit');
        return getRevision();
      },
    },
    records,
    { familiarId: 'local' },
  );
  const listener = vi.fn();
  store.subscribe(listener);
  const writer = createLocalChatWriter(store).sideConversations;
  if (!writer) throw new Error('Missing side capability');
  const selection = {
    parentConversationId: 'parent',
    sideConversationId: 'long',
    sourceMessageIds: ['m-000000'],
    operationKey: 'uncertain-import',
    excerpt: 'reviewed',
  };
  const input = { ...selection, preconditions: await store.prepareBringBack(selection) };
  expect(await writer.bringBack(input)).toEqual({ status: 'error', code: 'service_unavailable' });
  expect(listener).not.toHaveBeenCalled();
  expect(await writer.bringBack(input)).toMatchObject({ status: 'ok' });
  expect(store.listMessages('parent', 50).data).toHaveLength(1);
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
