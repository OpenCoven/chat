import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatShell } from './chat-shell';
import { continuityMemory, sideReviewMemory } from './lib/chat-continuity';
import { EMPTY_RECORDS } from './lib/local/chat-records';
import { createChatStore } from './lib/local/chat-store';
import {
  type ChatWriter,
  createLocalChatWriter,
  createReadOnlyChatWriter,
} from './lib/local/chat-writer';
import { createLocalQueryAdapter } from './lib/local/local-query-adapter';
import { createMemoryChatBackend } from './lib/local/memory-backend';
import type { BringBackInput, CreateSideInput } from './lib/local/side-conversations';

async function fixture() {
  const backend = createMemoryChatBackend();
  let id = 0;
  const store = createChatStore(backend, EMPTY_RECORDS, {
    familiarId: 'local',
    createId: () => `id-${++id}`,
  });
  const parent = await store.createConversation('Exact local parent');
  const side = await store.createSideConversation({
    parentConversationId: parent.id,
    operationKey: 'create-side',
  });
  await store.appendMessage(side.id, 'user', 'source text');
  return {
    store,
    parent,
    side,
    adapter: createLocalQueryAdapter(store),
    writer: createLocalChatWriter(store),
  };
}

async function openSide() {
  fireEvent.click(await screen.findByRole('button', { name: /Retained side note · open/ }));
  await screen.findByRole('button', { name: 'Return to parent' });
}

test.each(['get', 'list', 'throw'])(
  'side-note %s failures offer a safe load retry',
  async (failure) => {
    const current = await fixture();
    const capability = current.writer.sideConversations;
    if (!capability) throw new Error('Missing side capability');
    const get = vi.fn(capability.get);
    const list = vi.fn(capability.list);
    if (failure === 'get')
      get.mockResolvedValueOnce({ status: 'error', code: 'service_unavailable' });
    if (failure === 'list')
      list.mockResolvedValueOnce({ status: 'error', code: 'service_unavailable' });
    if (failure === 'throw') get.mockRejectedValueOnce(new Error('read failed'));
    const writer = { ...current.writer, sideConversations: { ...capability, get, list } };
    render(<ChatShell queryAdapter={current.adapter} writer={writer} />);
    const retry = await screen.findByRole('button', { name: 'Retry local side notes' });
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be read.*retry/i);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/saved|operation key|moved/);
    expect(
      screen.queryByRole('button', { name: 'New retained side note' }),
    ).not.toBeInTheDocument();
    fireEvent.click(retry);
    expect(await screen.findByRole('button', { name: 'New retained side note' })).toBeVisible();
    expect(await screen.findByRole('button', { name: /Retained side note · open/ })).toBeVisible();
  },
);

test.each(['error', 'throw'])(
  'uncertain create %s keeps its key until discarded replay permits a fresh explicit create',
  async (failure) => {
    const current = await fixture();
    const local = current.writer.sideConversations;
    if (!local) throw new Error('Missing local capability');
    const create = vi.fn(async (input: CreateSideInput) => {
      const result = await local.create(input);
      if (create.mock.calls.length === 1 && result.status === 'ok') {
        await current.store.setSideState(
          {
            parentConversationId: current.parent.id,
            sideConversationId: result.data.id,
          },
          'discarded',
        );
        if (failure === 'throw') throw new Error('lost acknowledgement');
        return { status: 'error' as const, code: 'service_unavailable' };
      }
      return result;
    });
    render(
      <ChatShell
        queryAdapter={current.adapter}
        writer={{ ...current.writer, sideConversations: { ...local, create } }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'New retained side note' }));
    const uncertain = await screen.findByText(/same operation key/i);
    expect(uncertain).toHaveTextContent(/creation result could not be confirmed/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry retained side note creation' }));
    await screen.findByText(/creation request refers to a discarded note/);
    expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
    fireEvent.click(screen.getByRole('button', { name: 'New retained side note' }));
    await screen.findByRole('button', { name: 'Close note' });
    expect(create.mock.calls[2]?.[0].operationKey).not.toBe(create.mock.calls[0]?.[0].operationKey);
  },
);

test.each(['error', 'throw', 'conflict'])(
  'state transition %s does not claim an operation key or an unsaved result',
  async (failure) => {
    const current = await fixture();
    const local = current.writer.sideConversations;
    if (!local) throw new Error('Missing local capability');
    const setState = vi.fn(local.setState);
    if (failure !== 'throw')
      setState.mockResolvedValueOnce({
        status: 'error',
        code: failure === 'conflict' ? 'conflict' : 'service_unavailable',
      });
    else setState.mockRejectedValueOnce(new Error('lost acknowledgement'));
    render(
      <ChatShell
        queryAdapter={current.adapter}
        writer={{ ...current.writer, sideConversations: { ...local, setState } }}
      />,
    );
    await openSide();
    fireEvent.click(screen.getByRole('button', { name: 'Close note' }));
    const notice = await screen.findByText(
      /state change could not be confirmed.*refresh.*before retrying/i,
    );
    expect(notice).not.toHaveTextContent(/operation key|not be saved/);
  },
);

test('side pagination errors describe a retryable read, not an unsaved keyed mutation', async () => {
  const current = await fixture();
  const local = current.writer.sideConversations;
  if (!local) throw new Error('Missing local capability');
  const list = vi
    .fn(local.list)
    .mockResolvedValueOnce({
      status: 'ok',
      data: { data: [current.side], cursor: { hasMore: true, next: 'next-page' } },
    })
    .mockResolvedValueOnce({ status: 'error', code: 'service_unavailable' });
  render(
    <ChatShell
      queryAdapter={current.adapter}
      writer={{ ...current.writer, sideConversations: { ...local, list } }}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Load more side notes' }));
  const notice = await screen.findByText(/could not be read.*retry/i);
  expect(notice).not.toHaveTextContent(/saved|operation key/);
  expect(screen.getByRole('button', { name: 'Load more side notes' })).toBeEnabled();
});

test('a definitively stale review requires a fresh operation key and branch before editing', async () => {
  const current = await fixture();
  const local = current.writer.sideConversations;
  if (!local) throw new Error('Missing local capability');
  const bringBack = vi.fn(local.bringBack);
  const prepareBringBack = vi.fn(local.prepareBringBack);
  const writer = {
    ...current.writer,
    sideConversations: { ...local, bringBack, prepareBringBack },
  };
  render(<ChatShell queryAdapter={current.adapter} writer={writer} />);
  await openSide();
  fireEvent.click(screen.getByRole('checkbox', { name: /source text/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review Bring back' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Reviewed excerpt' }), {
    target: { value: 'keep the reviewed text' },
  });
  await current.store.appendMessage(current.parent.id, 'user', 'another parent edit');
  fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
  const again = await screen.findByRole('button', { name: 'Review again' });
  expect(screen.getByRole('textbox', { name: 'Reviewed excerpt' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Bring back reviewed excerpt' })).toBeDisabled();
  const first = bringBack.mock.calls[0]?.[0];
  expect(current.store.listMessages(current.parent.id, 10).data).toHaveLength(1);
  prepareBringBack.mockResolvedValueOnce({ status: 'error', code: 'service_unavailable' });
  fireEvent.click(again);
  await screen.findByText(/The local review could not be prepared/);
  expect(screen.getByRole('textbox', { name: 'Reviewed excerpt' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Bring back reviewed excerpt' })).toBeDisabled();
  expect(bringBack).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Review again' }));
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Reviewed excerpt' })).toBeEnabled(),
  );
  expect(screen.getByRole('textbox', { name: 'Reviewed excerpt' })).toHaveValue(
    'keep the reviewed text',
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Reviewed excerpt' }), {
    target: { value: 'fresh reviewed text' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
  await waitFor(() =>
    expect(current.store.listMessages(current.parent.id, 10).data).toHaveLength(2),
  );
  expect(bringBack.mock.calls[1]?.[0].operationKey).not.toBe(first?.operationKey);
  expect(bringBack.mock.calls[1]?.[0].preconditions?.parentRevision).toBe(1);
});

test('a generic conflict after a committed import cannot release or edit its operation key', async () => {
  const current = await fixture();
  const local = current.writer.sideConversations;
  if (!local) throw new Error('Missing local capability');
  const attempts: BringBackInput[] = [];
  const writer = {
    ...current.writer,
    sideConversations: {
      ...local,
      async bringBack(input: BringBackInput) {
        attempts.push(input);
        const result = await local.bringBack(input);
        return attempts.length === 1 ? { status: 'error' as const, code: 'conflict' } : result;
      },
    },
  };
  render(<ChatShell queryAdapter={current.adapter} writer={writer} />);
  await openSide();
  fireEvent.click(screen.getByRole('checkbox', { name: /source text/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review Bring back' }));
  await screen.findByRole('textbox', { name: 'Reviewed excerpt' });
  fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
  await screen.findByText(/conflicts with its earlier request/);
  expect(screen.getByRole('textbox', { name: 'Reviewed excerpt' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Review again' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
  await waitFor(() =>
    expect(screen.queryByRole('textbox', { name: 'Reviewed excerpt' })).not.toBeInTheDocument(),
  );
  expect(attempts[1]).toEqual(attempts[0]);
  expect(current.store.listMessages(current.parent.id, 10).data).toHaveLength(1);
});

test('in-flight review survives source unmount and remount without releasing its operation key', async () => {
  const first = await fixture();
  const other = await fixture();
  let release!: () => void;
  const acknowledgement = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempts: BringBackInput[] = [];
  const local = first.writer.sideConversations;
  if (!local) throw new Error('Missing local capability');
  const writer: ChatWriter = {
    ...first.writer,
    sideConversations: {
      ...local,
      async bringBack(input) {
        attempts.push(input);
        const result = await local.bringBack(input);
        if (attempts.length === 1) {
          await acknowledgement;
          return { status: 'error', code: 'service_unavailable' };
        }
        return result;
      },
    },
  };
  const view = render(<ChatShell queryAdapter={first.adapter} writer={writer} />);
  await openSide();
  fireEvent.click(screen.getByRole('checkbox', { name: /source text/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review Bring back' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Reviewed excerpt' }), {
    target: { value: 'exact edited excerpt' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
  await waitFor(() => expect(first.store.listMessages(first.parent.id, 10).data).toHaveLength(1));
  expect(attempts[0]?.preconditions).toEqual({
    parentRevision: 0,
    parentLeafId: null,
    sideRevision: 1,
    sideLeafId: 'id-3',
  });
  view.rerender(<ChatShell queryAdapter={other.adapter} writer={other.writer} />);
  await openSide();
  expect(screen.queryByRole('textbox', { name: 'Reviewed excerpt' })).not.toBeInTheDocument();
  view.rerender(<ChatShell queryAdapter={first.adapter} writer={writer} />);
  await openSide();
  const review = await screen.findByRole('textbox', { name: 'Reviewed excerpt' });
  expect(review).toHaveValue('exact edited excerpt');
  expect(review).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Bring back reviewed excerpt' })).toBeDisabled();
  await act(async () => release());
  expect(
    await screen.findByText(/Retry the unchanged review with the same operation key/),
  ).toBeVisible();
  expect(review).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
  await waitFor(() =>
    expect(screen.queryByRole('textbox', { name: 'Reviewed excerpt' })).not.toBeInTheDocument(),
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(first.store.listMessages(first.parent.id, 10).data).toHaveLength(1);
  expect(other.store.listMessages(other.parent.id, 10).data).toHaveLength(0);
});

test('review references are partitioned by source, writer, familiar, parent and side', () => {
  const source = {};
  const writer = createReadOnlyChatWriter();
  const memory = continuityMemory(source, writer);
  const entry = sideReviewMemory(memory, 'familiar', 'parent', 'side');
  entry.update({
    selected: ['message'],
    review: {
      parentConversationId: 'parent',
      sideConversationId: 'side',
      sourceMessageIds: ['message'],
      operationKey: 'stable-key',
      excerpt: 'edited text',
      preconditions: {
        parentRevision: 4,
        parentLeafId: 'leaf',
        sideRevision: 2,
        sideLeafId: 'message',
      },
    },
    phase: 'uncertain',
  });
  expect(sideReviewMemory(continuityMemory(source, writer), 'familiar', 'parent', 'side')).toBe(
    entry,
  );
  const others = [
    sideReviewMemory(continuityMemory({}, writer), 'familiar', 'parent', 'side'),
    sideReviewMemory(
      continuityMemory(source, createReadOnlyChatWriter()),
      'familiar',
      'parent',
      'side',
    ),
    sideReviewMemory(memory, 'other-familiar', 'parent', 'side'),
    sideReviewMemory(memory, 'familiar', 'other-parent', 'side'),
    sideReviewMemory(memory, 'familiar', 'parent', 'other-side'),
  ];
  for (const other of others) expect(other.getSnapshot().review).toBeNull();
});

test('explicit cancellation clears a review without writing an import', async () => {
  const current = await fixture();
  render(<ChatShell queryAdapter={current.adapter} writer={current.writer} />);
  await openSide();
  fireEvent.click(screen.getByRole('checkbox', { name: /source text/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review Bring back' }));
  await screen.findByRole('textbox', { name: 'Reviewed excerpt' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Return to parent' }));
  await openSide();
  expect(screen.queryByRole('textbox', { name: 'Reviewed excerpt' })).not.toBeInTheDocument();
  expect(current.store.listMessages(current.parent.id, 10).data).toHaveLength(0);
});
