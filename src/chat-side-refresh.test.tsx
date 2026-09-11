import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatSideConversations } from './chat-side-conversations';
import { continuityMemory, sideCreationMemory, sideReviewMemory } from './lib/chat-continuity';
import { createLocalChatSource } from './lib/local/chat-source';
import { createMemoryChatBackend } from './lib/local/memory-backend';
import { MAX_MANUAL_PAGE_WALK_PAGES } from './lib/sdk/manual-page-walk';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function fixture() {
  const source = await createLocalChatSource({
    backend: createMemoryChatBackend(),
    familiarId: 'local',
  });
  const parent = await source.store.createConversation('Refresh parent');
  const side = await source.store.createSideConversation({
    parentConversationId: parent.id,
    operationKey: 'initial-side',
  });
  const capability = source.writer.sideConversations;
  if (!capability) throw new Error('Missing local side capability');
  const list = vi.fn(capability.list);
  const create = vi.fn(capability.create);
  const setState = vi.fn(capability.setState);
  const writer = {
    ...source.writer,
    sideConversations: { ...capability, list, create, setState },
  };
  const memory = continuityMemory(source.store, writer);
  const props = {
    conversationId: parent.id,
    familiarId: 'local',
    messages: [],
    hasMoreMessages: false,
    isDurable: false,
    writer,
    memory,
    onNavigate: vi.fn(),
    onWritten: vi.fn(),
  };
  const closed = { ...side, side: { ...side.side, state: 'closed' as const } };
  const root = {
    status: 'ok' as const,
    data: { data: [side], cursor: { hasMore: true, next: 'page-two' } },
  };
  const refreshedRoot = { ...root, data: { ...root.data, data: [closed] } };
  return { source, parent, side, capability, list, create, setState, props, root, refreshedRoot };
}

test.each(['ok', 'error', 'throw'] as const)(
  'a late side page %s cannot modify a refreshed root',
  async (result) => {
    const current = await fixture();
    const oldPage = deferred<Awaited<ReturnType<typeof current.list>>>();
    current.list
      .mockResolvedValueOnce(current.root)
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce(current.refreshedRoot);
    const view = render(<ChatSideConversations {...current.props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more side notes' }));
    view.rerender(<ChatSideConversations {...current.props} metadataRevision={1} />);
    await screen.findByRole('button', { name: /Retained side note · closed/ });
    await act(async () => {
      if (result === 'throw') oldPage.reject(new Error('old read failed'));
      else if (result === 'error')
        oldPage.resolve({ status: 'error', code: 'service_unavailable' });
      else
        oldPage.resolve({
          status: 'ok',
          data: {
            data: [current.side],
            cursor: { current: 'page-two', hasMore: false },
          },
        });
    });
    expect(screen.getByRole('button', { name: /Retained side note · closed/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Retained side note · open/ })).toBeNull();
    expect(screen.queryByText(/could not be read|page changed/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Load more side notes' })).toBeEnabled();
  },
);

test('an obsolete page finally cannot release the newer page request busy state', async () => {
  const current = await fixture();
  const oldPage = deferred<Awaited<ReturnType<typeof current.list>>>();
  const newPage = deferred<Awaited<ReturnType<typeof current.list>>>();
  current.list
    .mockResolvedValueOnce(current.root)
    .mockReturnValueOnce(oldPage.promise)
    .mockResolvedValueOnce(current.refreshedRoot)
    .mockReturnValueOnce(newPage.promise);
  const view = render(<ChatSideConversations {...current.props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Load more side notes' }));
  view.rerender(<ChatSideConversations {...current.props} metadataRevision={1} />);
  const more = await screen.findByRole('button', { name: 'Load more side notes' });
  expect(more).toBeEnabled();
  fireEvent.click(more);
  await waitFor(() => expect(current.list).toHaveBeenCalledTimes(4));
  await act(async () => oldPage.reject(new Error('obsolete page error')));
  expect(more).toBeDisabled();
  expect(screen.getByRole('button', { name: 'New retained side note' })).toBeDisabled();
  expect(screen.queryByText(/could not be read/)).toBeNull();
  await act(async () =>
    newPage.resolve({
      status: 'ok',
      data: {
        data: [{ ...current.side, id: 'fresh-page-note', title: 'Fresh page note' }],
        cursor: { current: 'page-two', hasMore: false },
      },
    }),
  );
  expect(screen.getByRole('button', { name: /Fresh page note/ })).toBeEnabled();
  expect(screen.getByRole('button', { name: /Retained side note · closed/ })).toBeVisible();
  expect(screen.getByRole('button', { name: 'New retained side note' })).toBeEnabled();
});

test.each(['changed-page', 'page-limit', 'read-error'] as const)(
  'metadata refresh clears %s guidance without clearing uncertain creation or review state',
  async (notice) => {
    const current = await fixture();
    current.list.mockResolvedValueOnce(current.root);
    if (notice === 'changed-page')
      current.list.mockResolvedValueOnce({
        status: 'ok',
        data: { data: [], cursor: { current: 'different-page', hasMore: false } },
      });
    else if (notice === 'read-error')
      current.list.mockResolvedValueOnce({ status: 'error', code: 'service_unavailable' });
    else {
      for (let page = 1; page < MAX_MANUAL_PAGE_WALK_PAGES; page += 1) {
        current.list.mockResolvedValueOnce({
          status: 'ok',
          data: {
            data: [],
            cursor: {
              current: page === 1 ? 'page-two' : `page-${page}`,
              hasMore: true,
              next: `page-${page + 1}`,
            },
          },
        });
      }
    }
    const creation = sideCreationMemory(current.props.memory, 'local', current.parent.id);
    creation.update({
      operationKey: 'uncertain-create',
      notice: 'Creation still needs reconciliation.',
    });
    const review = sideReviewMemory(
      current.props.memory,
      'local',
      current.parent.id,
      current.side.id,
    );
    review.update({
      phase: 'uncertain',
      notice: 'Import still needs reconciliation.',
      review: {
        parentConversationId: current.parent.id,
        sideConversationId: current.side.id,
        sourceMessageIds: ['captured-source'],
        operationKey: 'uncertain-import',
        excerpt: 'Keep this edited excerpt',
      },
    });
    const capturedReview = review.getSnapshot();
    const capturedCreation = creation.getSnapshot();
    const view = render(<ChatSideConversations {...current.props} />);
    const count = notice === 'page-limit' ? MAX_MANUAL_PAGE_WALK_PAGES : 1;
    for (let page = 0; page < count; page += 1) {
      const more = await screen.findByRole('button', { name: 'Load more side notes' });
      await waitFor(() => expect(more).toBeEnabled());
      fireEvent.click(more);
    }
    const guidance =
      notice === 'changed-page'
        ? /side note page changed/
        : notice === 'page-limit'
          ? /Side note page limit reached/
          : /could not be read/;
    await screen.findByText(guidance);
    current.list.mockResolvedValueOnce(current.refreshedRoot);
    view.rerender(<ChatSideConversations {...current.props} metadataRevision={1} />);
    await screen.findByRole('button', { name: /Retained side note · closed/ });
    expect(screen.queryByText(guidance)).toBeNull();
    expect(screen.getByText('Creation still needs reconciliation.')).toBeVisible();
    expect(review.getSnapshot()).toBe(capturedReview);
    expect(creation.getSnapshot()).toBe(capturedCreation);
  },
);

test.each(['create', 'state'] as const)(
  'metadata refresh after a real %s commit does not drop its acknowledgement or navigation',
  async (kind) => {
    const current = await fixture();
    const committed = deferred<void>();
    const acknowledgement = deferred<void>();
    const props = {
      ...current.props,
      conversationId: kind === 'state' ? current.side.id : current.parent.id,
    };
    if (kind === 'state')
      current.setState.mockImplementation(async (...args) => {
        const result = await current.capability.setState(...args);
        committed.resolve();
        await acknowledgement.promise;
        return result;
      });
    else
      current.create.mockImplementation(async (...args) => {
        const result = await current.capability.create(...args);
        committed.resolve();
        await acknowledgement.promise;
        return result;
      });
    const view = render(<ChatSideConversations {...props} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: kind === 'state' ? 'Close note' : 'New retained side note',
      }),
    );
    await act(async () => committed.promise);
    view.rerender(<ChatSideConversations {...props} metadataRevision={1} />);
    const control = await screen.findByRole('button', {
      name: kind === 'state' ? 'Reopen note' : 'Retry retained side note creation',
    });
    expect(control).toBeDisabled();
    await act(async () => acknowledgement.resolve());
    expect(props.onWritten).toHaveBeenCalledOnce();
    expect(props.onNavigate).toHaveBeenCalledOnce();
    if (kind === 'state') expect(props.onNavigate).toHaveBeenCalledWith(current.parent.id);
    else {
      const result = await current.create.mock.results[0]?.value;
      expect(result?.status).toBe('ok');
      if (result?.status === 'ok') expect(props.onNavigate).toHaveBeenCalledWith(result.data.id);
    }
  },
);
