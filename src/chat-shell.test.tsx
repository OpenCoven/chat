import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ChatShell } from './chat-shell';
import type { QueryAdapter } from './lib/sdk/query-adapter';

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return Object.freeze({
    promise,
    resolve(value: T) {
      resolvePromise?.(value);
    },
    reject(reason?: unknown) {
      rejectPromise?.(reason);
    },
  });
}

function okPage<T>(
  data: readonly T[],
  cursor?: Readonly<{ current?: string; next?: string; previous?: string; hasMore: boolean }>,
) {
  return {
    status: 'ok' as const,
    data: {
      data: data as T[],
      ...(cursor === undefined ? {} : { cursor }),
    },
  };
}

function firstElement<T>(values: readonly T[], label: string): T {
  const [value] = values;

  if (value === undefined) {
    throw new Error(`Expected at least one ${label}.`);
  }

  return value;
}

function makeQueryAdapter(overrides: Partial<QueryAdapter> = {}): QueryAdapter {
  return {
    listFamiliars: vi
      .fn()
      .mockResolvedValue(okPage([{ id: 'familiar-1', displayName: 'Mara', role: 'Guide' }])),
    listProjects: vi.fn().mockResolvedValue(
      okPage([
        {
          id: 'project-1',
          name: 'OpenCoven Chat',
          root: '/workspace/chat',
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      ]),
    ),
    listConversations: vi.fn().mockResolvedValue(
      okPage([
        {
          id: 'conversation-1',
          familiarId: 'familiar-1',
          title: 'First thread',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      ]),
    ),
    getConversation: vi.fn().mockResolvedValue({
      status: 'ok',
      data: {
        id: 'conversation-1',
        familiarId: 'familiar-1',
        title: 'First thread',
        updatedAt: '2026-08-25T00:00:00.000Z',
      },
    }),
    listMessages: vi.fn().mockResolvedValue(
      okPage([
        {
          id: 'message-1',
          conversationId: 'conversation-1',
          parentId: null,
          role: 'assistant',
          text: 'Hello from Cave.',
          createdAt: '2026-08-25T00:00:00.000Z',
          attachmentCount: 0,
          toolCount: 0,
        },
      ]),
    ),
    invalidate: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

describe('ChatShell', () => {
  it('offers a reconcile action for reconcile_required query states', async () => {
    const onReconcile = vi.fn();
    const adapter = makeQueryAdapter({
      listConversations: vi.fn().mockResolvedValue({ status: 'reconcile_required' }),
    });

    render(<ChatShell queryAdapter={adapter} onReconcile={onReconcile} />);

    const action = firstElement(
      await screen.findAllByRole('button', { name: 'Repair Cave access' }),
      'repair action',
    );
    fireEvent.click(action);

    expect(onReconcile).toHaveBeenCalledTimes(1);
  });

  it('offers forgetting access for scope_denied query failures', async () => {
    const onForgetCredential = vi.fn();
    const adapter = makeQueryAdapter({
      listConversations: vi.fn().mockResolvedValue({
        status: 'error',
        code: 'scope_denied',
      }),
    });

    render(<ChatShell queryAdapter={adapter} onForgetCredential={onForgetCredential} />);

    const action = firstElement(
      await screen.findAllByRole('button', { name: 'Forget access' }),
      'forget action',
    );
    fireEvent.click(action);

    expect(onForgetCredential).toHaveBeenCalledTimes(1);
  });

  it('ignores late thread completions after a rapid conversation switch', async () => {
    const firstConversation = deferred<Awaited<ReturnType<QueryAdapter['getConversation']>>>();
    const firstMessages = deferred<Awaited<ReturnType<QueryAdapter['listMessages']>>>();
    const secondConversation = deferred<Awaited<ReturnType<QueryAdapter['getConversation']>>>();
    const secondMessages = deferred<Awaited<ReturnType<QueryAdapter['listMessages']>>>();
    const adapter = makeQueryAdapter({
      listConversations: vi.fn().mockResolvedValue(
        okPage([
          {
            id: 'conversation-1',
            familiarId: 'familiar-1',
            title: 'First thread',
            updatedAt: '2026-08-25T00:00:00.000Z',
          },
          {
            id: 'conversation-2',
            familiarId: 'familiar-1',
            title: 'Second thread',
            updatedAt: '2026-08-25T00:05:00.000Z',
          },
        ]),
      ),
      getConversation: vi
        .fn()
        .mockImplementation((conversationId: string) =>
          conversationId === 'conversation-1'
            ? firstConversation.promise
            : secondConversation.promise,
        ),
      listMessages: vi
        .fn()
        .mockImplementation((conversationId: string) =>
          conversationId === 'conversation-1' ? firstMessages.promise : secondMessages.promise,
        ),
    });

    render(<ChatShell queryAdapter={adapter} />);

    fireEvent.click(await screen.findByRole('option', { name: /Second thread/ }));

    secondConversation.resolve({
      status: 'ok',
      data: {
        id: 'conversation-2',
        familiarId: 'familiar-1',
        title: 'Second thread',
        updatedAt: '2026-08-25T00:05:00.000Z',
      },
    });
    secondMessages.resolve(
      okPage([
        {
          id: 'message-2',
          conversationId: 'conversation-2',
          parentId: null,
          role: 'assistant',
          text: 'Second reply',
          createdAt: '2026-08-25T00:05:00.000Z',
          attachmentCount: 0,
          toolCount: 0,
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getByText('Second reply')).toBeVisible();
    });

    firstConversation.resolve({
      status: 'ok',
      data: {
        id: 'conversation-1',
        familiarId: 'familiar-1',
        title: 'First thread',
        updatedAt: '2026-08-25T00:00:00.000Z',
      },
    });
    firstMessages.resolve(
      okPage([
        {
          id: 'message-1',
          conversationId: 'conversation-1',
          parentId: null,
          role: 'assistant',
          text: 'First reply',
          createdAt: '2026-08-25T00:00:00.000Z',
          attachmentCount: 0,
          toolCount: 0,
        },
      ]),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByRole('heading', { name: 'Second thread', level: 1 })).toBeVisible();
    expect(screen.getByText('Second reply')).toBeVisible();
    expect(screen.queryByText('First reply')).not.toBeInTheDocument();
  });

  it('offers reconcile for unauthorized query failures', async () => {
    const onReconcile = vi.fn();
    const adapter = makeQueryAdapter({
      getConversation: vi.fn().mockResolvedValue({
        status: 'error',
        code: 'unauthorized',
      }),
      listMessages: vi.fn().mockResolvedValue(okPage([])),
    });

    render(<ChatShell queryAdapter={adapter} onReconcile={onReconcile} />);

    const action = firstElement(
      await screen.findAllByRole('button', { name: 'Repair Cave access' }),
      'repair action',
    );
    fireEvent.click(action);

    expect(onReconcile).toHaveBeenCalledTimes(1);
  });

  it('merges and dedupes conversation load-more pages by canonical id, keeping the newest cursor', async () => {
    const conversationOne = {
      id: 'conversation-1',
      familiarId: 'familiar-1',
      title: 'First thread',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    const conversationTwo = {
      id: 'conversation-2',
      familiarId: 'familiar-1',
      title: 'Second thread',
      updatedAt: '2026-08-25T00:05:00.000Z',
    };
    // A duplicate of conversation-1 arrives on the second page; it must not create a duplicate entry.
    const conversationOneUpdated = {
      ...conversationOne,
      title: 'First thread (updated)',
    };
    const listConversations = vi
      .fn()
      .mockResolvedValueOnce(okPage([conversationOne], { next: 'cursor-page-2', hasMore: true }))
      .mockResolvedValueOnce(
        okPage([conversationOneUpdated, conversationTwo], {
          next: 'cursor-page-3',
          hasMore: false,
        }),
      );
    const adapter = makeQueryAdapter({ listConversations });

    render(<ChatShell queryAdapter={adapter} />);

    await screen.findByRole('option', { name: /First thread/ });
    const conversationList = screen.getByRole('listbox', { name: 'Conversations' });
    expect(within(conversationList).getAllByRole('option')).toHaveLength(1);

    const loadMore = await screen.findByRole('button', { name: 'Load more conversations' });
    fireEvent.click(loadMore);

    await waitFor(() => {
      expect(listConversations).toHaveBeenCalledTimes(2);
    });
    expect(listConversations).toHaveBeenNthCalledWith(2, { cursor: 'cursor-page-2' });

    await waitFor(() => {
      expect(within(conversationList).getAllByRole('option')).toHaveLength(2);
    });
    expect(screen.getByRole('option', { name: /First thread \(updated\)/ })).toBeVisible();
    expect(screen.getByRole('option', { name: /Second thread/ })).toBeVisible();
    // hasMore is now false, so the load-more control should disappear.
    expect(
      screen.queryByRole('button', { name: 'Load more conversations' }),
    ).not.toBeInTheDocument();
  });

  it('does not claim there are no conversations when a filtered page is empty but hasMore is true', async () => {
    const adapter = makeQueryAdapter({
      listConversations: vi.fn().mockResolvedValue(
        okPage(
          [
            {
              id: 'conversation-other',
              familiarId: 'familiar-other',
              title: 'Unrelated thread',
              updatedAt: '2026-08-25T00:00:00.000Z',
            },
          ],
          { next: 'cursor-page-2', hasMore: true },
        ),
      ),
    });

    render(<ChatShell queryAdapter={adapter} />);

    await screen.findByText(/More conversations are available/);
    expect(
      screen.queryByText('No conversations available for the selected familiar.'),
    ).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Load more conversations' })).toBeVisible();
  });

  it('offers Load more messages instead of a false empty state when a message page is empty but hasMore is true', async () => {
    const adapter = makeQueryAdapter({
      listMessages: vi
        .fn()
        .mockResolvedValue(okPage([], { next: 'cursor-messages-2', hasMore: true })),
    });

    render(<ChatShell queryAdapter={adapter} />);

    await screen.findByText(/More messages are available/);
    expect(
      screen.queryByText('No messages have been stored for this conversation yet.'),
    ).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Load more messages' })).toBeVisible();
  });

  it('keeps message load-more tied to the selected conversation and ignores stale results after switching', async () => {
    const firstMessagesPageOne = okPage(
      [
        {
          id: 'message-1',
          conversationId: 'conversation-1',
          parentId: null,
          role: 'assistant' as const,
          text: 'First reply',
          createdAt: '2026-08-25T00:00:00.000Z',
          attachmentCount: 0,
          toolCount: 0,
        },
      ],
      { next: 'cursor-first-2', hasMore: true },
    );
    const secondMessagesPageOne = okPage([
      {
        id: 'message-2',
        conversationId: 'conversation-2',
        parentId: null,
        role: 'assistant' as const,
        text: 'Second reply',
        createdAt: '2026-08-25T00:05:00.000Z',
        attachmentCount: 0,
        toolCount: 0,
      },
    ]);
    const firstMessagesPageTwo = deferred<Awaited<ReturnType<QueryAdapter['listMessages']>>>();
    const listMessages = vi.fn().mockImplementation((conversationId: string, options?: object) => {
      if (conversationId === 'conversation-1' && options === undefined) {
        return Promise.resolve(firstMessagesPageOne);
      }
      if (conversationId === 'conversation-1') {
        return firstMessagesPageTwo.promise;
      }
      return Promise.resolve(secondMessagesPageOne);
    });
    const adapter = makeQueryAdapter({
      listConversations: vi.fn().mockResolvedValue(
        okPage([
          {
            id: 'conversation-1',
            familiarId: 'familiar-1',
            title: 'First thread',
            updatedAt: '2026-08-25T00:00:00.000Z',
          },
          {
            id: 'conversation-2',
            familiarId: 'familiar-1',
            title: 'Second thread',
            updatedAt: '2026-08-25T00:05:00.000Z',
          },
        ]),
      ),
      listMessages,
    });

    render(<ChatShell queryAdapter={adapter} />);

    await screen.findByText('First reply');
    const loadMore = await screen.findByRole('button', { name: 'Load more messages' });
    fireEvent.click(loadMore);

    // Switch conversations while the load-more request for conversation-1 is still in flight.
    fireEvent.click(await screen.findByRole('option', { name: /Second thread/ }));
    await screen.findByText('Second reply');

    firstMessagesPageTwo.resolve(
      okPage([
        {
          id: 'message-1b',
          conversationId: 'conversation-1',
          parentId: null,
          role: 'assistant' as const,
          text: 'First reply page two',
          createdAt: '2026-08-25T00:01:00.000Z',
          attachmentCount: 0,
          toolCount: 0,
        },
      ]),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText('Second reply')).toBeVisible();
    expect(screen.queryByText('First reply page two')).not.toBeInTheDocument();
    expect(screen.queryByText('First reply')).not.toBeInTheDocument();
  });
});
