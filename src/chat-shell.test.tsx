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

function conversation(id: string, title: string) {
  return {
    id,
    familiarId: 'familiar-1',
    title,
    updatedAt: '2026-08-25T00:00:00.000Z',
  };
}

function message(id: string, conversationId: string, text: string) {
  return {
    id,
    conversationId,
    parentId: null,
    role: 'assistant' as const,
    text,
    createdAt: '2026-08-25T00:00:00.000Z',
    attachmentCount: 0,
    toolCount: 0,
  };
}

async function expectInvalidPaginationWithoutCursor(...cursors: readonly string[]) {
  const alerts = await screen.findAllByRole('alert');
  for (const alert of alerts) {
    expect(alert).toHaveTextContent('Cave returned invalid response.');
    for (const cursor of cursors) {
      expect(alert).not.toHaveTextContent(cursor);
    }
  }
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
    familiarContract: vi.fn().mockResolvedValue({ status: 'not_ready' }),
    familiarAnalytics: vi.fn().mockResolvedValue({ status: 'not_ready' }),
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
          current: 'cursor-page-2',
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

  it('rejects an A -> B -> A conversation cursor cycle', async () => {
    const listConversations = vi
      .fn()
      .mockResolvedValueOnce(
        okPage([conversation('conversation-1', 'First thread')], {
          next: 'cursor-a',
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        okPage([conversation('conversation-2', 'Second thread')], {
          current: 'cursor-a',
          next: 'cursor-b',
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        okPage([conversation('conversation-3', 'Third thread')], {
          current: 'cursor-b',
          next: 'cursor-a',
          hasMore: true,
        }),
      );

    render(<ChatShell queryAdapter={makeQueryAdapter({ listConversations })} />);

    await screen.findByRole('option', { name: /First thread/ });
    fireEvent.click(await screen.findByRole('button', { name: 'Load more conversations' }));
    await waitFor(() => {
      expect(listConversations).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: 'Load more conversations' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load more conversations' }));

    await expectInvalidPaginationWithoutCursor('cursor-a', 'cursor-b');
    expect(listConversations).toHaveBeenCalledTimes(3);
    expect(
      screen.queryByRole('button', { name: 'Load more conversations' }),
    ).not.toBeInTheDocument();
  });

  it('rejects a message cursor whose next value equals its current value', async () => {
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce(
        okPage([message('message-1', 'conversation-1', 'First reply')], {
          next: 'messages-a',
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        okPage([message('message-2', 'conversation-1', 'Second reply')], {
          current: 'messages-a',
          next: 'messages-a',
          hasMore: true,
        }),
      );

    render(<ChatShell queryAdapter={makeQueryAdapter({ listMessages })} />);

    await screen.findByText('First reply');
    fireEvent.click(await screen.findByRole('button', { name: 'Load more messages' }));

    await expectInvalidPaginationWithoutCursor('messages-a');
    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Load more messages' })).not.toBeInTheDocument();
  });

  it('rejects a paginated response with hasMore but no next cursor', async () => {
    const listConversations = vi
      .fn()
      .mockResolvedValueOnce(
        okPage([conversation('conversation-1', 'First thread')], {
          next: 'cursor-a',
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        okPage([conversation('conversation-2', 'Second thread')], {
          current: 'cursor-a',
          hasMore: true,
        }),
      );

    render(<ChatShell queryAdapter={makeQueryAdapter({ listConversations })} />);

    await screen.findByRole('option', { name: /First thread/ });
    fireEvent.click(await screen.findByRole('button', { name: 'Load more conversations' }));

    await expectInvalidPaginationWithoutCursor('cursor-a');
    expect(listConversations).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole('button', { name: 'Load more conversations' }),
    ).not.toBeInTheDocument();
  });

  it('rejects a paginated response with hasMore but an empty next cursor', async () => {
    const listConversations = vi
      .fn()
      .mockResolvedValueOnce(
        okPage([conversation('conversation-1', 'First thread')], {
          next: 'cursor-a',
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        okPage([conversation('conversation-2', 'Second thread')], {
          current: 'cursor-a',
          next: '',
          hasMore: true,
        }),
      );

    render(<ChatShell queryAdapter={makeQueryAdapter({ listConversations })} />);

    await screen.findByRole('option', { name: /First thread/ });
    fireEvent.click(await screen.findByRole('button', { name: 'Load more conversations' }));

    await expectInvalidPaginationWithoutCursor('cursor-a');
    expect(listConversations).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole('button', { name: 'Load more conversations' }),
    ).not.toBeInTheDocument();
  });

  it('keeps all four pager happy paths usable with server-issued root current cursors', async () => {
    const listFamiliars = vi
      .fn()
      .mockResolvedValueOnce(
        okPage([{ id: 'familiar-1', displayName: 'Mara', role: 'Guide' }], {
          current: 'ZmFtaWxpYXJzLXJvb3Q',
          next: 'ZmFtaWxpYXJzLXBhZ2UtMg',
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        okPage([{ id: 'familiar-2', displayName: 'Sable', role: 'Archivist' }], {
          current: 'ZmFtaWxpYXJzLXBhZ2UtMg',
          hasMore: false,
        }),
      );
    const listProjects = vi
      .fn()
      .mockResolvedValueOnce(
        okPage(
          [
            {
              id: 'project-1',
              name: 'OpenCoven Chat',
              root: '/workspace/chat',
              createdAt: '2026-08-25T00:00:00.000Z',
              updatedAt: '2026-08-25T00:00:00.000Z',
            },
          ],
          {
            current: 'cHJvamVjdHMtcm9vdA',
            next: 'cHJvamVjdHMtcGFnZS0y',
            hasMore: true,
          },
        ),
      )
      .mockResolvedValueOnce(
        okPage(
          [
            {
              id: 'project-2',
              name: 'Cave Console',
              root: '/workspace/cave',
              createdAt: '2026-08-25T00:00:00.000Z',
              updatedAt: '2026-08-25T00:00:00.000Z',
            },
          ],
          {
            current: 'cHJvamVjdHMtcGFnZS0y',
            hasMore: false,
          },
        ),
      );
    const listConversations = vi
      .fn()
      .mockResolvedValueOnce(
        okPage([conversation('conversation-1', 'First thread')], {
          current: 'Y29udmVyc2F0aW9ucy1yb290',
          next: 'Y29udmVyc2F0aW9ucy1wYWdlLTI',
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        okPage([conversation('conversation-2', 'Second thread')], {
          current: 'Y29udmVyc2F0aW9ucy1wYWdlLTI',
          hasMore: false,
        }),
      );
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce(
        okPage([message('message-1', 'conversation-1', 'First reply')], {
          current: 'bWVzc2FnZXMtcm9vdA',
          next: 'bWVzc2FnZXMtcGFnZS0y',
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        okPage([message('message-2', 'conversation-1', 'Second reply')], {
          current: 'bWVzc2FnZXMtcGFnZS0y',
          hasMore: false,
        }),
      );

    render(
      <ChatShell
        queryAdapter={makeQueryAdapter({
          listFamiliars,
          listProjects,
          listConversations,
          listMessages,
        })}
      />,
    );

    await screen.findByText('First reply');

    fireEvent.click(screen.getByRole('button', { name: 'Load more familiars' }));
    expect(await screen.findByRole('option', { name: /Sable/ })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Load more projects' }));
    expect(await screen.findByText('Cave Console')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Load more conversations' }));
    expect(await screen.findByRole('option', { name: /Second thread/ })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Load more messages' }));
    expect(await screen.findByText('Second reply')).toBeVisible();

    expect(screen.queryByText('Cave returned invalid response.')).not.toBeInTheDocument();
  });

  it('rejects a cursor that cycles back to a server-issued root current cursor', async () => {
    const rootCursor = 'cm9vdC1jdXJyZW50';
    const nextCursor = 'cGFnZS10d28';
    const listConversations = vi
      .fn()
      .mockResolvedValueOnce(
        okPage([conversation('conversation-1', 'First thread')], {
          current: rootCursor,
          next: nextCursor,
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        okPage([conversation('conversation-2', 'Second thread')], {
          current: nextCursor,
          next: rootCursor,
          hasMore: true,
        }),
      );

    render(<ChatShell queryAdapter={makeQueryAdapter({ listConversations })} />);

    await screen.findByRole('option', { name: /First thread/ });
    fireEvent.click(await screen.findByRole('button', { name: 'Load more conversations' }));

    await expectInvalidPaginationWithoutCursor(rootCursor, nextCursor);
    expect(listConversations).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole('button', { name: 'Load more conversations' }),
    ).not.toBeInTheDocument();
  });

  it('rejects a response current cursor that does not match the requested message cursor', async () => {
    const rootCursor = 'cm9vdC1jdXJyZW50';
    const requestedCursor = 'cGFnZS10d28';
    const mismatchedCursor = 'd3JvbmctY3VycmVudA';
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce(
        okPage([message('message-1', 'conversation-1', 'First reply')], {
          current: rootCursor,
          next: requestedCursor,
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        okPage([message('message-2', 'conversation-1', 'Second reply')], {
          current: mismatchedCursor,
          hasMore: false,
        }),
      );

    render(<ChatShell queryAdapter={makeQueryAdapter({ listMessages })} />);

    await screen.findByText('First reply');
    fireEvent.click(await screen.findByRole('button', { name: 'Load more messages' }));

    await expectInvalidPaginationWithoutCursor(rootCursor, requestedCursor, mismatchedCursor);
    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Load more messages' })).not.toBeInTheDocument();
  });

  it('allows eight conversation pages and rejects the ninth before fetching it', async () => {
    const pages = Array.from({ length: 8 }, (_, index) =>
      okPage([conversation(`conversation-${index + 1}`, `Thread ${index + 1}`)], {
        ...(index === 0 ? {} : { current: `cursor-${index}` }),
        next: `cursor-${index + 1}`,
        hasMore: true,
      }),
    );
    const listConversations = vi.fn().mockImplementation(() => {
      const page = pages[listConversations.mock.calls.length - 1];
      if (page === undefined) {
        throw new Error('Unexpected ninth conversation page fetch.');
      }
      return Promise.resolve(page);
    });

    render(<ChatShell queryAdapter={makeQueryAdapter({ listConversations })} />);

    await screen.findByRole('option', { name: /Thread 1/ });
    for (let expectedCalls = 2; expectedCalls <= 8; expectedCalls += 1) {
      fireEvent.click(await screen.findByRole('button', { name: 'Load more conversations' }));
      await waitFor(() => {
        expect(listConversations).toHaveBeenCalledTimes(expectedCalls);
        expect(screen.getByRole('button', { name: 'Load more conversations' })).toBeEnabled();
      });
    }

    fireEvent.click(screen.getByRole('button', { name: 'Load more conversations' }));

    await expectInvalidPaginationWithoutCursor('cursor-8');
    expect(listConversations).toHaveBeenCalledTimes(8);
    expect(
      screen.queryByRole('button', { name: 'Load more conversations' }),
    ).not.toBeInTheDocument();
  });

  it('resets the conversation walk after an explicit reconciliation action', async () => {
    const onReconcile = vi.fn();
    const listConversations = vi
      .fn()
      .mockResolvedValueOnce(
        okPage([conversation('conversation-1', 'First thread')], {
          next: 'cursor-a',
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        okPage([conversation('conversation-2', 'Second thread')], {
          current: 'cursor-a',
          next: 'cursor-b',
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce({ status: 'reconcile_required' as const })
      .mockResolvedValueOnce(
        okPage([conversation('conversation-3', 'After repair')], {
          current: 'cursor-b',
          next: 'cursor-a',
          hasMore: true,
        }),
      );

    render(
      <ChatShell
        queryAdapter={makeQueryAdapter({ listConversations })}
        onReconcile={onReconcile}
      />,
    );

    await screen.findByRole('option', { name: /First thread/ });
    fireEvent.click(await screen.findByRole('button', { name: 'Load more conversations' }));
    await screen.findByRole('option', { name: /Second thread/ });
    fireEvent.click(screen.getByRole('button', { name: 'Load more conversations' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Repair Cave access' }));
    expect(onReconcile).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Load more conversations' }));

    expect(await screen.findByRole('option', { name: /After repair/ })).toBeVisible();
    expect(listConversations).toHaveBeenCalledTimes(4);
    expect(screen.queryByText('Cave returned invalid response.')).not.toBeInTheDocument();
  });

  it('resets the conversation walk when a fresh root load starts', async () => {
    const firstListConversations = vi
      .fn()
      .mockResolvedValueOnce(
        okPage([conversation('conversation-1', 'First root')], {
          next: 'cursor-a',
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        okPage([conversation('conversation-2', 'First page two')], {
          current: 'cursor-a',
          next: 'cursor-b',
          hasMore: true,
        }),
      );
    const secondListConversations = vi
      .fn()
      .mockResolvedValueOnce(
        okPage([conversation('conversation-3', 'Second root')], {
          next: 'cursor-a',
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        okPage([conversation('conversation-4', 'Second page two')], {
          current: 'cursor-a',
          hasMore: false,
        }),
      );
    const { rerender } = render(
      <ChatShell queryAdapter={makeQueryAdapter({ listConversations: firstListConversations })} />,
    );

    await screen.findByRole('option', { name: /First root/ });
    fireEvent.click(await screen.findByRole('button', { name: 'Load more conversations' }));
    await screen.findByRole('option', { name: /First page two/ });

    rerender(
      <ChatShell queryAdapter={makeQueryAdapter({ listConversations: secondListConversations })} />,
    );

    await screen.findByRole('option', { name: /Second root/ });
    fireEvent.click(screen.getByRole('button', { name: 'Load more conversations' }));

    expect(await screen.findByRole('option', { name: /Second page two/ })).toBeVisible();
    expect(secondListConversations).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Cave returned invalid response.')).not.toBeInTheDocument();
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

  it('resets the message walk after the selected conversation changes', async () => {
    const firstConversationRoot = okPage(
      [message('message-1', 'conversation-1', 'First root reply')],
      {
        next: 'messages-a',
        hasMore: true,
      },
    );
    const firstConversationPageTwo = okPage(
      [message('message-2', 'conversation-1', 'First page two reply')],
      {
        current: 'messages-a',
        next: 'messages-b',
        hasMore: true,
      },
    );
    const listMessages = vi.fn().mockImplementation((conversationId: string, options?: object) => {
      if (conversationId === 'conversation-2') {
        return Promise.resolve(
          okPage([message('message-3', 'conversation-2', 'Second conversation reply')]),
        );
      }
      return Promise.resolve(
        options === undefined ? firstConversationRoot : firstConversationPageTwo,
      );
    });
    const adapter = makeQueryAdapter({
      listConversations: vi
        .fn()
        .mockResolvedValue(
          okPage([
            conversation('conversation-1', 'First thread'),
            conversation('conversation-2', 'Second thread'),
          ]),
        ),
      listMessages,
    });

    render(<ChatShell queryAdapter={adapter} />);

    await screen.findByText('First root reply');
    fireEvent.click(screen.getByRole('button', { name: 'Load more messages' }));
    await screen.findByText('First page two reply');

    fireEvent.click(screen.getByRole('option', { name: /Second thread/ }));
    await screen.findByText('Second conversation reply');
    fireEvent.click(screen.getByRole('option', { name: /First thread/ }));
    await screen.findByText('First root reply');
    fireEvent.click(screen.getByRole('button', { name: 'Load more messages' }));

    expect(await screen.findByText('First page two reply')).toBeVisible();
    expect(screen.queryByText('Cave returned invalid response.')).not.toBeInTheDocument();
    expect(listMessages).toHaveBeenCalledTimes(5);
  });
});
