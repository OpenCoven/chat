import { ChatConflictError, type StoredConversation, type StoredMessage } from './chat-records';
import { createMemoryChatBackend } from './memory-backend';

const conversation = (id: string, key?: string): StoredConversation => ({
  id,
  familiarId: 'local',
  title: id,
  createdAt: '2026-09-11T00:00:00Z',
  updatedAt: '2026-09-11T00:00:00Z',
  ...(key ? { side: { parentConversationId: 'parent', operationKey: key, state: 'open' } } : {}),
});
const message = (id: string, key?: string): StoredMessage => ({
  id,
  conversationId: 'parent',
  parentId: null,
  role: 'user',
  text: id,
  createdAt: '2026-09-11T00:00:00Z',
  ...(key
    ? {
        broughtBack: {
          operationKey: key,
          sideConversationId: 'side',
          sourceMessageIds: ['source'],
        },
      }
    : {}),
});

test('memory admission uses bounded lookups with 20000 conversations and messages', async () => {
  const parent = conversation('parent');
  const backend = createMemoryChatBackend({
    conversations: [
      parent,
      ...Array.from({ length: 20000 }, (_, i) => conversation(`c-${i}`, `create-${i}`)),
    ],
    messages: Array.from({ length: 20000 }, (_, i) => message(`m-${i}`, `import-${i}`)),
  });
  let largeEnumerations = 0;
  const original = Map.prototype.values;
  const values = vi.spyOn(Map.prototype, 'values').mockImplementation(function (
    this: Map<unknown, unknown>,
  ) {
    if (this.size >= 20000) largeEnumerations += 1;
    return original.call(this);
  });
  try {
    await backend.commit({
      conversations: [parent],
      messages: [message('fresh', 'fresh-key')],
      expectedConversations: [parent],
      absentOperationKey: 'fresh-key',
    });
    await expect(async () =>
      backend.commit({
        conversations: [],
        messages: [message('duplicate', 'fresh-key')],
        absentOperationKey: 'fresh-key',
      }),
    ).rejects.toBeInstanceOf(ChatConflictError);
    expect(largeEnumerations).toBe(0);
  } finally {
    values.mockRestore();
  }
});

test('memory operation counts track duplicate legacy keys, overwrites, deletes and discarded tombstones', async () => {
  const a = conversation('side-a', 'shared');
  const b = conversation('side-b', 'shared');
  const backend = createMemoryChatBackend({
    conversations: [conversation('parent'), a, b],
    messages: [message('one', 'shared'), message('two', 'shared')],
  });
  const assertReserved = async () => {
    const before = await backend.loadAll();
    const revision = backend.getMutationRevision?.();
    await expect(async () =>
      backend.commit({
        conversations: [conversation('must-not-exist')],
        messages: [message('rejected', 'shared')],
        deletedMessageIds: ['two'],
        absentOperationKey: 'shared',
      }),
    ).rejects.toBeInstanceOf(ChatConflictError);
    expect(await backend.loadAll()).toEqual(before);
    expect(backend.getMutationRevision?.()).toBe(revision);
  };
  await assertReserved();
  await backend.commit({
    conversations: [conversation('side-a')],
    messages: [],
    deletedMessageIds: ['one', 'two'],
  });
  await assertReserved();
  await backend.commit({
    conversations: [
      {
        ...b,
        side: { parentConversationId: 'parent', operationKey: 'shared', state: 'discarded' },
      },
    ],
    messages: [],
  });
  await assertReserved();
  await backend.commit({ conversations: [conversation('side-b')], messages: [] });
  await backend.commit({
    conversations: [],
    messages: [message('replacement', 'shared')],
    absentOperationKey: 'shared',
  });
  await backend.commit({ conversations: [], messages: [message('replacement', 'new-key')] });
  await backend.commit({
    conversations: [],
    messages: [message('reused', 'shared')],
    absentOperationKey: 'shared',
  });
  await backend.commit({
    conversations: [],
    messages: [message('replacement', 'third-key')],
    deletedMessageIds: ['replacement'],
  });
  await backend.commit({
    conversations: [],
    messages: [message('released', 'new-key')],
    absentOperationKey: 'new-key',
  });
});

test('memory exact-record conflicts roll back content and operation admission together', async () => {
  const parent = conversation('parent');
  const backend = createMemoryChatBackend({
    conversations: [parent],
    messages: [message('old', 'old-key')],
  });
  const before = await backend.loadAll();
  await expect(async () =>
    backend.commit({
      conversations: [{ ...parent, title: 'changed' }],
      messages: [message('new', 'new-key')],
      deletedMessageIds: ['old'],
      expectedConversations: [{ ...parent, title: 'wrong precondition' }],
      absentOperationKey: 'new-key',
    }),
  ).rejects.toBeInstanceOf(ChatConflictError);
  expect(await backend.loadAll()).toEqual(before);
  expect(backend.getMutationRevision?.()).toBe(0);
  await backend.commit({
    conversations: [],
    messages: [message('new', 'new-key')],
    absentOperationKey: 'new-key',
  });
});
