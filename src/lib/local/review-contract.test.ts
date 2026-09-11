import { openChatStore } from './chat-store';
import { createLocalChatWriter } from './chat-writer';
import { createMemoryChatBackend } from './memory-backend';

async function setupReview() {
  const backend = createMemoryChatBackend();
  const store = await openChatStore({ familiarId: 'local', backend });
  const parent = await store.createConversation('Parent');
  const side = await store.createSideConversation({
    parentConversationId: parent.id,
    operationKey: 'create-side',
  });
  const source = await store.appendMessage(side.id, 'user', 'Source');
  const selection = {
    parentConversationId: parent.id,
    sideConversationId: side.id,
    sourceMessageIds: [source.id],
    operationKey: 'reviewed-import',
    excerpt: 'Reviewed excerpt',
  };
  const input = { ...selection, preconditions: await store.prepareBringBack(selection) };
  return { backend, store, parent, side, selection, input };
}

test.each([
  ['missing', {}],
  ['undefined', { preconditions: undefined }],
  ['null', { preconditions: null }],
  ['empty', { preconditions: {} }],
  ['primitive', { preconditions: 'reviewed' }],
  [
    'negative revision',
    {
      preconditions: {
        parentRevision: -1,
        parentLeafId: null,
        sideRevision: 1,
        sideLeafId: 'source',
      },
    },
  ],
  [
    'fractional revision',
    {
      preconditions: {
        parentRevision: 0,
        parentLeafId: null,
        sideRevision: 1.5,
        sideLeafId: 'source',
      },
    },
  ],
  [
    'invalid leaf',
    {
      preconditions: {
        parentRevision: 0,
        parentLeafId: 123,
        sideRevision: 1,
        sideLeafId: 'source',
      },
    },
  ],
])('public Bring back rejects %s preconditions without mutation', async (_label, invalid) => {
  const { backend, store, selection } = await setupReview();
  const before = await backend.loadAll();
  const revision = backend.getMutationRevision?.();
  const listener = vi.fn();
  store.subscribe(listener);
  const request = { ...selection, ...invalid };
  await expect(Reflect.apply(store.bringBack, store, [request])).rejects.toMatchObject({
    code: 'invalid_request',
  });
  const capability = createLocalChatWriter(store).sideConversations;
  if (!capability) throw new Error('Missing side capability');
  expect(await Reflect.apply(capability.bringBack, capability, [request])).toEqual({
    status: 'error',
    code: 'invalid_request',
  });
  expect(await backend.loadAll()).toEqual(before);
  expect(backend.getMutationRevision?.()).toBe(revision);
  expect(listener).not.toHaveBeenCalled();
});

test.each(['parent', 'side'])(
  'a stale %s snapshot is rejected without writing a receipt',
  async (branch) => {
    const { backend, store, parent, side, input } = await setupReview();
    await store.appendMessage(branch === 'parent' ? parent.id : side.id, 'user', 'Later leaf');
    const before = await backend.loadAll();
    const revision = backend.getMutationRevision?.();
    await expect(store.bringBack(input)).rejects.toMatchObject({ code: 'stale_review' });
    expect(await backend.loadAll()).toEqual(before);
    expect(backend.getMutationRevision?.()).toBe(revision);
  },
);

test('identical prepared receipts replay unchanged after advancement, discard and reload', async () => {
  const { backend, store, parent, side, selection, input } = await setupReview();
  const receipt = await store.bringBack(input);
  await store.appendMessage(parent.id, 'user', 'Later parent leaf');
  await store.appendMessage(side.id, 'user', 'Later side leaf');
  expect(await store.bringBack(input)).toEqual(receipt);
  await store.setSideState(selection, 'discarded');
  const reloaded = await openChatStore({ familiarId: 'local', backend });
  const before = await backend.loadAll();
  const revision = backend.getMutationRevision?.();
  expect(await reloaded.bringBack(input)).toEqual(receipt);
  await expect(Reflect.apply(reloaded.bringBack, reloaded, [selection])).rejects.toMatchObject({
    code: 'invalid_request',
  });
  await expect(
    reloaded.bringBack({
      ...input,
      preconditions: { ...input.preconditions, parentRevision: 99 },
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(await backend.loadAll()).toEqual(before);
  expect(backend.getMutationRevision?.()).toBe(revision);
  expect(reloaded.listMessages(parent.id, 50).data.filter((entry) => entry.broughtBack)).toEqual([
    receipt,
  ]);
});

test('legacy persisted receipts without preconditions remain readable after hydration', async () => {
  const { backend, store, parent, input } = await setupReview();
  const receipt = await store.bringBack(input);
  if (!receipt.broughtBack) throw new Error('Missing receipt provenance');
  const { preconditions: _preconditions, ...legacyProvenance } = receipt.broughtBack;
  const legacyReceipt = { ...receipt, broughtBack: legacyProvenance };
  const records = await backend.loadAll();
  const legacyBackend = createMemoryChatBackend({
    ...records,
    messages: records.messages.map((message) =>
      message.id === receipt.id ? legacyReceipt : message,
    ),
  });
  const reloaded = await openChatStore({ familiarId: 'local', backend: legacyBackend });
  expect(reloaded.listMessages(parent.id, 50).data).toEqual([legacyReceipt]);
  expect((await legacyBackend.loadAll()).messages).toContainEqual(legacyReceipt);
});
