import { type ChatBackend, type ChatRecords, EMPTY_RECORDS } from './chat-records';
import { createChatStore, openChatStore } from './chat-store';
import { createLocalChatWriter, createReadOnlyChatWriter } from './chat-writer';
import { LOCAL_FAMILIAR_ID } from './local-query-adapter';
import { createMemoryChatBackend } from './memory-backend';

async function setup() {
  const backend = createMemoryChatBackend();
  const store = await openChatStore({ familiarId: LOCAL_FAMILIAR_ID, backend });
  const parent = await store.createConversation('Parent');
  const original = await store.appendMessage(parent.id, 'user', 'Parent stays original');
  const side = await store.createSideConversation({
    parentConversationId: parent.id,
    operationKey: 'create-one',
  });
  const message = await store.appendMessage(side.id, 'user', 'Unreviewed text stays here');
  const input = {
    parentConversationId: parent.id,
    sideConversationId: side.id,
    operationKey: 'import-one',
    sourceMessageIds: [message.id],
    excerpt: '  Reviewed edited excerpt\n',
  };
  return { backend, store, parent, original, side, message, input };
}

test('retained side notes use the same store, start empty, and stay out of the parent list', async () => {
  const { store, parent, side } = await setup();
  expect(side.familiarId).toBe('local');
  expect(store.listConversations(50).data.map((record) => record.id)).toEqual([parent.id]);
  expect(store.listSideConversations(parent.id, 20).data.map((record) => record.id)).toEqual([
    side.id,
  ]);
  const empty = await store.createSideConversation({
    parentConversationId: parent.id,
    operationKey: 'create-empty',
  });
  expect(store.listMessages(empty.id, 50).data).toEqual([]);
  expect(store.listMessages(parent.id, 50).data.map((message) => message.text)).toEqual([
    'Parent stays original',
  ]);
});

test('side APIs isolate two familiar stores sharing a backend, including exact-ID metadata', async () => {
  const backend = createMemoryChatBackend();
  const records = [];
  for (const familiarId of ['alpha', 'beta']) {
    const store = await openChatStore({ familiarId, backend });
    const parent = await store.createConversation(`${familiarId} parent`);
    const side = await store.createSideConversation({
      parentConversationId: parent.id,
      operationKey: `${familiarId}-side`,
    });
    records.push({ familiarId, parent, side });
  }
  for (const own of records) {
    const store = await openChatStore({ familiarId: own.familiarId, backend });
    const api = createLocalChatWriter(store).sideConversations;
    if (!api) throw new Error('Missing local side capability');
    expect(store.getSideConversation(own.side.id)).toEqual(own.side);
    expect(await api.get(own.side.id)).toEqual({ status: 'ok', data: own.side });
    expect((await api.list(own.parent.id)).status).toBe('ok');
    for (const foreign of records.filter((entry) => entry !== own)) {
      expect(store.getSideConversation(foreign.side.id)).toBeUndefined();
      expect(await api.get(foreign.side.id)).toEqual({ status: 'ok', data: null });
      expect(await api.get(foreign.parent.id)).toEqual({ status: 'ok', data: null });
      const target = {
        parentConversationId: foreign.parent.id,
        sideConversationId: foreign.side.id,
      };
      const missing = { status: 'error', code: 'not_found' };
      expect(await api.list(foreign.parent.id)).toEqual(missing);
      expect(
        await api.create({ parentConversationId: foreign.parent.id, operationKey: 'foreign' }),
      ).toEqual(missing);
      expect(await api.setState(target, 'closed')).toEqual(missing);
      expect(await api.prepareBringBack(target)).toEqual(missing);
      expect(
        await api.bringBack({
          ...target,
          sourceMessageIds: ['unavailable'],
          excerpt: 'Do not import',
          operationKey: 'foreign-import',
        }),
      ).toEqual(missing);
    }
  }
});

test.each(['foreign-parent', 'foreign-side'] as const)(
  'side metadata and creation replay do not expose persisted %s links',
  async (link) => {
    const { backend, parent, side } = await setup();
    const beta = await openChatStore({ familiarId: 'beta', backend });
    const foreignParent = await beta.createConversation('Foreign parent');
    const mismatched = {
      ...side,
      familiarId: link === 'foreign-side' ? 'beta' : side.familiarId,
      side: {
        ...side.side,
        parentConversationId: link === 'foreign-parent' ? foreignParent.id : parent.id,
      },
    };
    await backend.commit({ conversations: [mismatched], messages: [] });
    const local = await openChatStore({ familiarId: LOCAL_FAMILIAR_ID, backend });
    expect(local.getSideConversation(side.id)).toBeUndefined();
    expect(local.listSideConversations(parent.id, 20).data).toEqual([]);
    await expect(
      local.createSideConversation({
        parentConversationId: parent.id,
        operationKey: side.side.operationKey,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  },
);

test('side state timestamps stay monotonic through rollback, paging and subsequent appends', async () => {
  let clock = Date.parse('2026-09-11T12:00:00Z');
  const store = await openChatStore({
    familiarId: LOCAL_FAMILIAR_ID,
    backend: createMemoryChatBackend(),
    now: () => clock,
  });
  const parent = await store.createConversation('Parent');
  const older = await store.createSideConversation({
    parentConversationId: parent.id,
    operationKey: 'older',
  });
  clock += 1000;
  const newer = await store.createSideConversation({
    parentConversationId: parent.id,
    operationKey: 'newer',
  });
  const target = { parentConversationId: parent.id, sideConversationId: newer.id };
  clock -= 10000;
  const closed = await store.setSideState(target, 'closed');
  expect(Date.parse(closed.updatedAt)).toBeGreaterThan(Date.parse(newer.updatedAt));
  const first = store.listSideConversations(parent.id, 1);
  expect(first.data[0]?.id).toBe(newer.id);
  expect(store.listSideConversations(parent.id, 1, first.cursor?.next).data[0]?.id).toBe(older.id);
  const reopened = await store.setSideState(target, 'open');
  expect(Date.parse(reopened.updatedAt)).toBeGreaterThan(Date.parse(closed.updatedAt));
  await store.appendMessage(newer.id, 'user', 'After reopening');
  expect(Date.parse(store.getConversation(newer.id)?.updatedAt ?? '')).toBeGreaterThan(
    Date.parse(reopened.updatedAt),
  );
  const discarded = await store.setSideState(target, 'discarded');
  expect(Date.parse(discarded.updatedAt)).toBeGreaterThan(Date.parse(reopened.updatedAt));
});

test.each([false, true])(
  'import preserves its parent clock floor and ordering (existing message=%s)',
  async (hasMessage) => {
    let clock = Date.parse('2026-09-11T12:00:00Z');
    const store = await openChatStore({
      familiarId: LOCAL_FAMILIAR_ID,
      backend: createMemoryChatBackend(),
      now: () => clock,
    });
    const parent = await store.createConversation('Future parent');
    if (hasMessage) await store.appendMessage(parent.id, 'user', 'Existing message');
    const floor = store.getConversation(parent.id)?.updatedAt;
    if (!floor) throw new Error('Missing parent timestamp');
    clock -= 1000;
    const other = await store.createConversation('Earlier parent');
    const side = await store.createSideConversation({
      parentConversationId: parent.id,
      operationKey: 'clock-side',
    });
    const source = await store.appendMessage(side.id, 'user', 'Source');
    clock -= 1000;
    const input = {
      parentConversationId: parent.id,
      sideConversationId: side.id,
      sourceMessageIds: [source.id],
      operationKey: 'clock-import',
      excerpt: 'Reviewed',
    };
    const imported = await store.bringBack(input);
    expect(Date.parse(imported.createdAt)).toBeGreaterThan(Date.parse(floor));
    expect(store.getConversation(parent.id)?.updatedAt).toBe(imported.createdAt);
    expect(store.listConversations(50).data.map((record) => record.id)).toEqual([
      parent.id,
      other.id,
    ]);
    expect(await store.bringBack(input)).toEqual(imported);
  },
);

test('side operation replay resolves current records after append, state changes, hydration and external refresh', async () => {
  const { store, backend, parent, side } = await setup();
  const input = { parentConversationId: parent.id, operationKey: 'create-one' };
  expect(await store.createSideConversation(input)).toEqual(store.getSideConversation(side.id));
  const target = { parentConversationId: parent.id, sideConversationId: side.id };
  const closed = await store.setSideState(target, 'closed');
  expect(await store.createSideConversation(input)).toEqual(closed);
  const reloaded = await openChatStore({ familiarId: LOCAL_FAMILIAR_ID, backend });
  expect(await reloaded.createSideConversation(input)).toEqual(closed);
  const reopened = await reloaded.setSideState(target, 'open');
  expect(await store.createSideConversation(input)).toEqual(reopened);
  const discarded = await reloaded.setSideState(target, 'discarded');
  expect(await store.createSideConversation(input)).toEqual(discarded);
  const cold = await openChatStore({ familiarId: LOCAL_FAMILIAR_ID, backend });
  expect(await cold.createSideConversation(input)).toEqual(discarded);
});
test('duplicate create and Bring back requests replay once, including after reload and discard', async () => {
  const { backend, store, parent, original, side, input } = await setup();
  const creates = await Promise.all(
    Array.from({ length: 4 }, () =>
      store.createSideConversation({ parentConversationId: parent.id, operationKey: 'create-one' }),
    ),
  );
  expect(creates.every((created) => created.id === side.id)).toBe(true);
  const imports = await Promise.all(Array.from({ length: 4 }, () => store.bringBack(input)));
  expect(new Set(imports.map((message) => message.id)).size).toBe(1);
  expect(imports[0]?.parentId).toBe(original.id);
  expect(imports[0]?.text).toBe(input.excerpt);
  const reloaded = await openChatStore({ familiarId: LOCAL_FAMILIAR_ID, backend });
  expect((await reloaded.bringBack(input)).id).toBe(imports[0]?.id);
  expect(reloaded.listMessages(parent.id, 50).data).toHaveLength(2);
  await reloaded.setSideState(input, 'closed');
  expect(reloaded.listMessages(side.id, 50).data).toHaveLength(1);
  await reloaded.setSideState(input, 'discarded');
  expect(reloaded.getConversation(side.id)).toBeUndefined();
  expect(
    (await backend.loadAll()).messages.some((message) => message.conversationId === side.id),
  ).toBe(false);
  expect((await reloaded.bringBack(input)).id).toBe(imports[0]?.id);
  expect(
    (
      await reloaded.createSideConversation({
        parentConversationId: parent.id,
        operationKey: 'create-one',
      })
    ).side.state,
  ).toBe('discarded');
});

test('missing source rejection is precommit while an existing receipt survives discarded-note tombstones', async () => {
  const { store, backend, input, parent } = await setup();
  const review = { ...input, preconditions: await store.prepareBringBack(input) };
  const before = await backend.loadAll();
  const revision = backend.getMutationRevision?.();
  await expect(store.bringBack({ ...review, sourceMessageIds: ['missing'] })).rejects.toMatchObject(
    { code: 'not_found' },
  );
  expect(await backend.loadAll()).toEqual(before);
  expect(backend.getMutationRevision?.()).toBe(revision);
  const receipt = await store.bringBack(review);
  await store.setSideState(review, 'discarded');
  expect(await store.bringBack(review)).toEqual(receipt);
  await expect(store.bringBack({ ...review, sourceMessageIds: ['missing'] })).rejects.toMatchObject(
    { code: 'conflict' },
  );
  expect(
    store.listMessages(parent.id, 50).data.filter((message) => message.broughtBack),
  ).toHaveLength(1);
});
test('exact local parent, source message, and operation payload are fenced', async () => {
  const { store, parent, side, input } = await setup();
  const other = await store.createConversation('Other parent');
  await expect(store.bringBack({ ...input, parentConversationId: other.id })).rejects.toMatchObject(
    { code: 'not_found' },
  );
  await expect(store.bringBack({ ...input, sourceMessageIds: ['foreign'] })).rejects.toMatchObject({
    code: 'not_found',
  });
  await expect(
    store.createSideConversation({ parentConversationId: side.id, operationKey: 'nested' }),
  ).rejects.toMatchObject({ code: 'not_found' });
  await expect(
    store.createSideConversation({ parentConversationId: other.id, operationKey: 'create-one' }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await store.bringBack(input);
  await expect(
    store.bringBack({ ...input, excerpt: 'edited retry with reused key' }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(store.listMessages(parent.id, 50).data).toHaveLength(2);
  await store.setSideState(input, 'closed');
  await expect(store.appendMessage(side.id, 'user', 'closed')).rejects.toMatchObject({
    code: 'conflict',
  });
  await store.setSideState(input, 'open');
  expect((await store.appendMessage(side.id, 'user', 'reopened')).conversationId).toBe(side.id);
});

test('competing stores reconcile a duplicate import without two target records', async () => {
  const { backend, store, input, parent } = await setup();
  const other = await openChatStore({ familiarId: LOCAL_FAMILIAR_ID, backend });
  const results = await Promise.allSettled([store.bringBack(input), other.bringBack(input)]);
  const fulfilled = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value.id] : [],
  );
  expect(new Set(fulfilled).size).toBe(1);
  const replay = await other.bringBack(input);
  const records = await backend.loadAll();
  expect(records.messages.filter((entry) => entry.conversationId === parent.id)).toHaveLength(2);
  expect(
    records.messages
      .filter((entry) => entry.broughtBack?.operationKey === input.operationKey)
      .map((entry) => entry.id),
  ).toEqual([replay.id]);
});

test('failed commit leaves no partial import and retries preserve the operation key', async () => {
  const { backend, input, parent } = await setup();
  let fail = true;
  const flaky: ChatBackend = {
    ...backend,
    commit(change) {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('disk full'));
      }
      return backend.commit(change);
    },
  };
  const store = await openChatStore({ familiarId: LOCAL_FAMILIAR_ID, backend: flaky });
  const writer = createLocalChatWriter(store);
  expect(await writer.sideConversations?.bringBack(input)).toEqual({
    status: 'error',
    code: 'service_unavailable',
  });
  expect(store.listMessages(parent.id, 20).data).toHaveLength(1);
  expect((await writer.sideConversations?.bringBack(input))?.status).toBe('ok');
  expect(store.listMessages(parent.id, 20).data).toHaveLength(2);
  expect(createReadOnlyChatWriter().sideConversations).toBeUndefined();
});

test('backward clocks and simultaneous notes remain a single parent-linked sequence', async () => {
  const backend = createMemoryChatBackend();
  let id = 30;
  const store = createChatStore(backend, EMPTY_RECORDS, {
    familiarId: LOCAL_FAMILIAR_ID,
    now: () => 1_000,
    createId: () => String(id--),
  });
  const parent = await store.createConversation('Clock');
  const entries = await Promise.all(
    ['first', 'second', 'third'].map((text) => store.appendMessage(parent.id, 'user', text)),
  );
  expect(store.listMessages(parent.id, 50).data.map((entry) => entry.text)).toEqual([
    'first',
    'second',
    'third',
  ]);
  expect(entries.map((entry) => entry.parentId)).toEqual([null, entries[0]?.id, entries[1]?.id]);
});

test('atomic import includes provenance and a compare-and-set target fence', async () => {
  const { backend, input } = await setup();
  const commits: ChatRecords[] = [];
  const store = await openChatStore({
    familiarId: LOCAL_FAMILIAR_ID,
    backend: {
      ...backend,
      commit(change) {
        commits.push(change);
        return backend.commit(change);
      },
    },
  });

  await store.bringBack(input);
  expect(commits).toHaveLength(1);
  expect(commits[0]?.conversations).toHaveLength(1);
  expect(commits[0]?.messages[0]?.broughtBack?.operationKey).toBe(input.operationKey);
  expect(commits[0]?.expectedConversations).toHaveLength(2);
});

test('discard racing an import cannot restore source messages or admit an import from a discarded note', async () => {
  const { backend, store, input, side, parent } = await setup();
  const other = await openChatStore({ familiarId: LOCAL_FAMILIAR_ID, backend });
  const outcomes = await Promise.allSettled([
    store.setSideState(input, 'discarded'),
    other.bringBack(input),
  ]);
  expect(outcomes[0]?.status).toBe('fulfilled');
  expect(outcomes[1]?.status).toBe('rejected');
  await expect(other.bringBack(input)).rejects.toMatchObject({ code: 'not_found' });
  const records = await backend.loadAll();
  expect(records.messages.some((entry) => entry.conversationId === side.id)).toBe(false);
  expect(records.messages.filter((entry) => entry.conversationId === parent.id)).toHaveLength(1);
});

test('a saved reviewed branch cannot silently retarget after parent or side edits', async () => {
  const { store, input, parent, side } = await setup();
  const preconditions = await store.prepareBringBack(input);
  await store.appendMessage(parent.id, 'user', 'new parent leaf');
  await expect(store.bringBack({ ...input, preconditions })).rejects.toMatchObject({
    code: 'stale_review',
  });
  const next = await store.prepareBringBack(input);
  await store.appendMessage(side.id, 'user', 'new side leaf');
  await expect(store.bringBack({ ...input, preconditions: next })).rejects.toMatchObject({
    code: 'stale_review',
  });
  expect(store.listMessages(parent.id, 10).data.some((message) => message.broughtBack)).toBe(false);
});

test('receipt reconciliation precedes stale reviewed-branch rejection', async () => {
  const { store, input, parent } = await setup();
  const request = { ...input, preconditions: await store.prepareBringBack(input) };
  const committed = await store.bringBack(request);
  await store.appendMessage(parent.id, 'user', 'later parent leaf');
  await store.setSideState(input, 'closed');
  expect((await store.bringBack(request)).id).toBe(committed.id);
  expect(committed.broughtBack?.preconditions).toEqual(request.preconditions);
  await expect(
    store.bringBack({
      ...request,
      preconditions: { ...request.preconditions, parentRevision: 99 },
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
});

test('backends without shared revisions still reject concurrent stale snapshots transactionally', async () => {
  const { backend, input, parent } = await setup();
  const uncached = {
    isDurable: backend.isDurable,
    loadAll: backend.loadAll,
    commit: backend.commit,
    close: backend.close,
  };
  const first = await openChatStore({ familiarId: LOCAL_FAMILIAR_ID, backend: uncached });
  const second = await openChatStore({ familiarId: LOCAL_FAMILIAR_ID, backend: uncached });
  const results = await Promise.allSettled([first.bringBack(input), second.bringBack(input)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  await second.bringBack(input);
  expect(
    (await backend.loadAll()).messages.filter((entry) => entry.conversationId === parent.id),
  ).toHaveLength(2);
});
