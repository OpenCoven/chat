import type { ChatBackend } from './chat-records';
import { openChatStore } from './chat-store';
import { createLocalChatWriter } from './chat-writer';
import { createLocalQueryAdapter } from './local-query-adapter';
import { createMemoryChatBackend } from './memory-backend';

test('configured stores fence every root and message query and append across a shared backend', async () => {
  const backend = createMemoryChatBackend();
  const targets = [];
  for (const familiarId of ['alpha', 'beta']) {
    const store = await openChatStore({ familiarId, backend });
    const parent = await store.createConversation(`${familiarId} parent`);
    const side = await store.createSideConversation({
      parentConversationId: parent.id,
      operationKey: `${familiarId}-side`,
    });
    await store.appendMessage(parent.id, 'user', `${familiarId} root text`);
    await store.appendMessage(side.id, 'user', `${familiarId} side text`);
    targets.push({ familiarId, parent, side });
  }
  for (const own of targets) {
    const store = await openChatStore({ familiarId: own.familiarId, backend });
    const adapter = createLocalQueryAdapter(store);
    expect(store.listConversations(50).data.map((entry) => entry.id)).toEqual([own.parent.id]);
    expect(await adapter.listFamiliars()).toMatchObject({
      status: 'ok',
      data: { data: [{ id: own.familiarId }] },
    });
    for (const target of targets) {
      for (const conversation of [target.parent, target.side]) {
        if (target === own) {
          expect(store.getConversation(conversation.id)?.familiarId).toBe(own.familiarId);
          expect(store.listMessages(conversation.id, 50).data).toHaveLength(1);
          expect((await adapter.getConversation(conversation.id)).status).toBe('ok');
        } else {
          const before = await backend.loadAll();
          expect(store.getConversation(conversation.id)).toBeUndefined();
          expect(store.listMessages(conversation.id, 50).data).toEqual([]);
          expect(await adapter.getConversation(conversation.id)).toEqual({
            status: 'error',
            code: 'not_found',
          });
          expect(await adapter.listMessages(conversation.id)).toEqual({
            status: 'error',
            code: 'not_found',
          });
          await expect(
            store.appendMessage(conversation.id, 'user', 'Must not cross familiar scope'),
          ).rejects.toMatchObject({ code: 'not_found' });
          expect(await backend.loadAll()).toEqual(before);
        }
      }
    }
  }
});

async function recoveryFixture(failure: 'refresh' | 'lost-ack' | 'abort') {
  const durable = createMemoryChatBackend();
  let armed = false;
  let failRead = false;
  const backend: ChatBackend = {
    ...durable,
    getMutationRevision: async () => {
      if (failRead) throw new Error('revision read failed');
      return durable.getMutationRevision?.() ?? 0;
    },
    commit: async (change) => {
      if (!armed) return durable.commit(change);
      armed = false;
      if (failure === 'abort') throw new Error('commit aborted before writing');
      await durable.commit(change);
      if (failure === 'lost-ack') throw new Error('commit acknowledgement lost');
      failRead = true;
    },
  };
  const store = await openChatStore({ familiarId: 'local', backend });
  const parent = await store.createConversation('Recovery parent');
  const writer = createLocalChatWriter(store);
  return {
    store,
    writer,
    parent,
    durable,
    arm: () => {
      armed = true;
    },
    allowReads: () => {
      failRead = false;
    },
  };
}

test.each(['create', 'message'] as const)(
  'known committed %s survives refresh failure without a second mutation',
  async (kind) => {
    const current = await recoveryFixture('refresh');
    const write = () =>
      kind === 'create'
        ? current.writer.createConversation('Created once')
        : current.writer.sendMessage(current.parent.id, 'Sent once');
    current.arm();
    const result = await write();
    expect(result).toMatchObject({
      status: 'reconcile_required',
      recovery: { commit: 'confirmed', code: 'refresh_failed' },
    });
    if (result.status !== 'reconcile_required') throw new Error('Missing recovery receipt');
    const persisted = await current.durable.loadAll();
    current.allowReads();
    expect(await write()).toEqual(result);
    expect(await current.durable.loadAll()).toEqual(persisted);
    const reconciled = await current.writer.reconcileWrite?.(result.recovery.receipt.id);
    expect(reconciled).toMatchObject({ status: 'ok', data: { outcome: 'committed' } });
    const observed = vi.fn();
    current.store.subscribe(observed);
    expect(await current.writer.reconcileWrite?.(result.recovery.receipt.id)).toEqual(reconciled);
    expect(observed).toHaveBeenCalledOnce();
    const foreign = await openChatStore({ familiarId: 'foreign', backend: current.durable });
    await expect(foreign.reconcileWrite(result.recovery.receipt.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await current.durable.loadAll()).toEqual(persisted);
  },
);

test.each(['before', 'after'] as const)(
  'deletion %s the first reconciliation cannot undo a known commit or resurrect its message',
  async (when) => {
    const current = await recoveryFixture('refresh');
    current.arm();
    const result = await current.writer.sendMessage(current.parent.id, 'Historically committed');
    if (result.status !== 'reconcile_required') throw new Error('Missing recovery receipt');
    current.allowReads();
    if (when === 'after')
      expect(await current.store.reconcileWrite(result.recovery.receipt.id)).toMatchObject({
        outcome: 'committed',
        availability: 'present',
      });
    await current.durable.commit({
      conversations: [],
      messages: [],
      deletedMessageIds: [result.recovery.receipt.id],
    });
    const deleted = await current.durable.loadAll();
    expect(await current.store.reconcileWrite(result.recovery.receipt.id)).toMatchObject({
      outcome: 'committed',
      availability: 'unavailable',
      receipt: result.recovery.receipt,
    });
    expect(await current.store.reconcileWrite(result.recovery.receipt.id)).toMatchObject({
      outcome: 'committed',
      availability: 'unavailable',
    });
    expect(await current.durable.loadAll()).toEqual(deleted);
    expect(current.store.listMessages(current.parent.id, 50).data).toEqual([]);
  },
);

test('reconciling an old completed receipt cannot release a newer pending save in the same thread', async () => {
  const current = await recoveryFixture('refresh');
  current.arm();
  const first = await current.writer.sendMessage(current.parent.id, 'First save');
  if (first.status !== 'reconcile_required') throw new Error('Missing first receipt');
  current.allowReads();
  await current.store.reconcileWrite(first.recovery.receipt.id);
  current.arm();
  const next = await current.writer.sendMessage(current.parent.id, 'Second save');
  if (next.status !== 'reconcile_required') throw new Error('Missing second receipt');
  current.allowReads();
  await current.store.reconcileWrite(first.recovery.receipt.id);
  expect(await current.writer.sendMessage(current.parent.id, 'Second save')).toEqual(next);
  expect((await current.durable.loadAll()).messages).toHaveLength(2);
});

test('the local familiar continuation is terminal and echoes the supplied cursor without repeating data', async () => {
  const store = await openChatStore({
    familiarId: 'configured',
    backend: createMemoryChatBackend(),
  });
  const adapter = createLocalQueryAdapter(store);
  expect(await adapter.listFamiliars()).toMatchObject({
    status: 'ok',
    data: { data: [{ id: 'configured' }], cursor: { hasMore: false } },
  });
  expect(await adapter.listFamiliars({ cursor: 'dGVybWluYWwtcGFnZQ' })).toEqual({
    status: 'ok',
    data: { data: [], cursor: { current: 'dGVybWluYWwtcGFnZQ', hasMore: false } },
  });
});

test.each(['lost-ack', 'abort'] as const)(
  'a root message %s is reconciled against its exact allocated ID before retry',
  async (failure) => {
    const current = await recoveryFixture(failure);
    current.arm();
    const result = await current.writer.sendMessage(current.parent.id, 'Exact attempt');
    expect(result).toMatchObject({
      status: 'reconcile_required',
      recovery: { commit: 'unconfirmed', code: 'commit_unconfirmed' },
    });
    if (result.status !== 'reconcile_required') throw new Error('Missing recovery receipt');
    expect(await current.writer.sendMessage(current.parent.id, 'Exact attempt')).toEqual(result);
    const reconciled = await current.writer.reconcileWrite?.(result.recovery.receipt.id);
    expect(reconciled).toMatchObject({
      status: 'ok',
      data: { outcome: failure === 'lost-ack' ? 'committed' : 'not_committed' },
    });
    expect((await current.durable.loadAll()).messages).toHaveLength(failure === 'lost-ack' ? 1 : 0);
    if (failure === 'abort') {
      expect((await current.writer.sendMessage(current.parent.id, 'Exact attempt')).status).toBe(
        'ok',
      );
      expect((await current.durable.loadAll()).messages).toHaveLength(1);
    }
  },
);
