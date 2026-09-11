import type { ChatRecords } from './chat-records';
import { openChatStore } from './chat-store';
import { createLocalChatWriter } from './chat-writer';
import { createMemoryChatBackend } from './memory-backend';

async function fixture() {
  const durable = createMemoryChatBackend();
  const { getMutationRevision: _revision, ...unversioned } = durable;
  let delayed: ChatRecords | undefined;
  const commit = vi.fn(async (change: ChatRecords) => {
    delayed = change;
    throw new Error('The acknowledgement failed while the commit is still pending');
  });
  const store = await openChatStore({
    familiarId: 'local',
    backend: { ...unversioned, commit },
  });
  return {
    durable,
    store,
    commit,
    writer: createLocalChatWriter(store),
    finish: async () => {
      if (!delayed) throw new Error('No delayed commit');
      await durable.commit(delayed);
    },
  };
}

test.each(['conversation', 'message'] as const)(
  'unversioned %s absence stays unresolved until the exact delayed commit becomes visible',
  async (kind) => {
    const current = await fixture();
    const parent = {
      id: 'parent',
      familiarId: 'local',
      title: 'Parent',
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    };
    await current.durable.commit({ conversations: [parent], messages: [] });
    const write = () =>
      kind === 'conversation'
        ? current.writer.createConversation('Exact pending creation')
        : current.writer.sendMessage(parent.id, 'Exact pending message');
    const result = await write();
    if (result.status !== 'reconcile_required') throw new Error('Missing pending receipt');
    expect(await current.writer.reconcileWrite?.(result.recovery.receipt.id)).toEqual({
      status: 'error',
      code: 'absence_unproven',
    });
    expect(await write()).toEqual(result);
    expect(current.commit).toHaveBeenCalledOnce();
    await current.finish();
    expect(await current.writer.reconcileWrite?.(result.recovery.receipt.id)).toMatchObject({
      status: 'ok',
      data: { outcome: 'committed', availability: 'present', receipt: result.recovery.receipt },
    });
    expect(current.commit).toHaveBeenCalledOnce();
    const records = await current.durable.loadAll();
    expect(
      kind === 'conversation'
        ? records.conversations.filter((row) => row.title === 'Exact pending creation')
        : records.messages,
    ).toHaveLength(1);
    if (kind === 'message') {
      await current.durable.commit({
        conversations: [],
        messages: [],
        deletedMessageIds: [result.recovery.receipt.id],
      });
      expect(await current.store.reconcileWrite(result.recovery.receipt.id)).toMatchObject({
        outcome: 'committed',
        availability: 'unavailable',
      });
    }
  },
);

test('known confirmed missing content stays committed/unavailable without a backend revision', async () => {
  const durable = createMemoryChatBackend();
  const { getMutationRevision: _revision, ...backend } = durable;
  const store = await openChatStore({ familiarId: 'local', backend });
  const parent = await store.createConversation('Parent');
  const unsubscribe = store.subscribe(() => {
    throw new Error('Observer failed after commit');
  });
  const result = await createLocalChatWriter(store).sendMessage(parent.id, 'Known committed text');
  if (result.status !== 'reconcile_required') throw new Error('Missing confirmed receipt');
  expect(result.recovery.commit).toBe('confirmed');
  unsubscribe();
  await durable.commit({
    conversations: [],
    messages: [],
    deletedMessageIds: [result.recovery.receipt.id],
  });
  expect(await store.reconcileWrite(result.recovery.receipt.id)).toMatchObject({
    outcome: 'committed',
    availability: 'unavailable',
    receipt: result.recovery.receipt,
  });
});
