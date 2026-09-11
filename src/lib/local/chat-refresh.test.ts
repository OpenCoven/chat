import type { ChatRecords } from './chat-records';
import { openChatStore } from './chat-store';
import { createLocalChatWriter } from './chat-writer';
import { createMemoryChatBackend } from './memory-backend';

const parent = {
  id: 'parent',
  familiarId: 'local',
  title: 'Parent',
  createdAt: '2026-09-11T00:00:00.000Z',
  updatedAt: '2026-09-11T00:00:00.000Z',
};

async function racingStore() {
  const backend = createMemoryChatBackend({
    conversations: [
      parent,
      {
        ...parent,
        id: 'side',
        side: { parentConversationId: parent.id, operationKey: 'side-key', state: 'open' },
      },
    ],
    messages: [
      {
        id: 'source',
        conversationId: 'side',
        parentId: null,
        role: 'user',
        text: 'Source',
        createdAt: parent.createdAt,
      },
    ],
  });
  let duringSnapshot = false;
  let keepRacing = false;
  let external = 0;
  const addExternal = async () => {
    external += 1;
    await backend.commit({
      conversations: [{ ...parent, id: `external-${external}`, title: `External ${external}` }],
      messages: [],
    });
  };
  const loadAll = vi.fn(async () => {
    const snapshot = await backend.loadAll();
    if (duringSnapshot) {
      if (!keepRacing) duringSnapshot = false;
      await addExternal();
    }
    return snapshot;
  });
  const commit = vi.fn(async (change: ChatRecords) => {
    await backend.commit(change);
    await addExternal();
    duringSnapshot = true;
  });
  const store = await openChatStore({
    familiarId: 'local',
    backend: { ...backend, loadAll, commit },
  });
  loadAll.mockClear();
  return {
    backend,
    store,
    loadAll,
    commit,
    raceContinuously: () => {
      keepRacing = true;
    },
    raceBeforeWrite: async () => {
      await addExternal();
      duringSnapshot = true;
      keepRacing = true;
    },
    stopRacing: () => {
      keepRacing = false;
      duringSnapshot = false;
    },
  };
}

test.each(['message', 'conversation'] as const)(
  '%s acknowledgement waits for a coherent refresh when another write lands after snapshot capture',
  async (kind) => {
    const { store, loadAll, commit } = await racingStore();
    const snapshots: string[][] = [];
    store.subscribe(() => snapshots.push(store.listConversations(50).data.map((row) => row.id)));
    if (kind === 'message') await store.appendMessage(parent.id, 'user', 'Exactly once');
    else await store.createConversation('Exactly once');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toContain('external-2');
    expect(loadAll).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledOnce();
    if (kind === 'message') expect(store.listMessages(parent.id, 50).data).toHaveLength(1);
    else
      expect(
        store.listConversations(50).data.filter((row) => row.title === 'Exactly once'),
      ).toHaveLength(1);
  },
);

test.each(['message', 'conversation'] as const)(
  '%s refresh stops after three unstable snapshots and reconciles its known commit without resubmitting',
  async (kind) => {
    const { store, backend, loadAll, commit, raceContinuously, stopRacing } = await racingStore();
    raceContinuously();
    const listener = vi.fn();
    store.subscribe(listener);
    const writer = createLocalChatWriter(store);
    const result =
      kind === 'message'
        ? await writer.sendMessage(parent.id, 'Exactly once')
        : await writer.createConversation('Exactly once');
    expect(result.status).toBe('reconcile_required');
    if (result.status !== 'reconcile_required') throw new Error('Missing recovery receipt');
    expect(result.recovery).toMatchObject({ commit: 'confirmed', code: 'refresh_failed' });
    expect(loadAll).toHaveBeenCalledTimes(3);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getConversation('external-1')).toBeUndefined();
    expect(commit).toHaveBeenCalledOnce();
    stopRacing();
    expect(await store.reconcileWrite(result.recovery.receipt.id)).toMatchObject({
      outcome: 'committed',
      availability: 'present',
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    const records = await backend.loadAll();
    expect(
      kind === 'message'
        ? records.messages.filter((row) => row.conversationId === parent.id)
        : records.conversations.filter((row) => row.title === 'Exactly once'),
    ).toHaveLength(1);
  },
);

test.each(['side', 'import'] as const)(
  '%s receipt replay notifies stable observers after an unstable post-commit refresh, without another write',
  async (kind) => {
    const { store, backend, commit, raceContinuously, stopRacing } = await racingStore();
    const target = { parentConversationId: parent.id, sideConversationId: 'side' };
    const input = {
      ...target,
      operationKey: 'keyed-recovery',
      sourceMessageIds: ['source'],
      excerpt: 'Exact reviewed text',
      preconditions: await store.prepareBringBack(target),
    };
    const api = createLocalChatWriter(store).sideConversations;
    if (!api) throw new Error('Missing side capability');
    const listener = vi.fn();
    store.subscribe(listener);
    raceContinuously();
    const invoke = () => (kind === 'side' ? api.create(input) : api.bringBack(input));
    expect(await invoke()).toMatchObject({ status: 'error' });
    expect(listener).not.toHaveBeenCalled();
    stopRacing();
    expect(await invoke()).toMatchObject({ status: 'ok' });
    expect(listener).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    const records = await backend.loadAll();
    expect(
      kind === 'side'
        ? records.conversations.filter((row) => row.side?.operationKey === input.operationKey)
        : records.messages.filter((row) => row.broughtBack?.operationKey === input.operationKey),
    ).toHaveLength(1);
  },
);

test('an unstable prewrite refresh fails boundedly before allocating or committing a root save', async () => {
  const { store, commit, loadAll, raceBeforeWrite, stopRacing } = await racingStore();
  const writer = createLocalChatWriter(store);
  const listener = vi.fn();
  store.subscribe(listener);
  await raceBeforeWrite();
  expect(await writer.sendMessage(parent.id, 'Not yet saved')).toEqual({
    status: 'error',
    code: 'conflict',
  });
  expect(loadAll).toHaveBeenCalledTimes(3);
  expect(commit).not.toHaveBeenCalled();
  expect(listener).not.toHaveBeenCalled();
  expect(store.getConversation('external-1')).toBeUndefined();
  stopRacing();
  expect(await writer.sendMessage(parent.id, 'Not yet saved')).toMatchObject({ status: 'ok' });
  expect(commit).toHaveBeenCalledOnce();
  expect(store.listMessages(parent.id, 50).data).toHaveLength(1);
});
