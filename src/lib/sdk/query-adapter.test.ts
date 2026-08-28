import {
  type AuthorityReference,
  type NativeBoundary,
  NativeBoundaryError,
} from './native-boundary';
import { createQueryAdapter } from './query-adapter';

const AUTHORITY: AuthorityReference = {
  handle: 'authority:00000000-0000-4000-8000-000000000001',
  generation: 1,
};
const NEXT_AUTHORITY: AuthorityReference = {
  handle: 'authority:00000000-0000-4000-8000-000000000002',
  generation: 2,
};
const DIAGNOSTIC_ID = '00000000-0000-4000-8000-000000000003';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeReads(overrides: Partial<NativeBoundary> = {}): NativeBoundary {
  return {
    isAvailable: () => true,
    discover: vi.fn(),
    close: vi.fn(),
    installationIdentity: vi.fn(),
    health: vi.fn(),
    pairingCreate: vi.fn(),
    pairingPoll: vi.fn(),
    pairingExchange: vi.fn(),
    credentialState: vi.fn(),
    forgetCredential: vi.fn(),
    listFamiliars: vi.fn().mockResolvedValue({ data: [] }),
    listProjects: vi.fn().mockResolvedValue({ data: [] }),
    listConversations: vi.fn().mockResolvedValue({ data: [] }),
    getConversation: vi.fn(),
    listConversationMessages: vi.fn().mockResolvedValue({ data: [] }),
    diagnostics: vi.fn(),
    listenConnectionEvents: vi.fn(),
    ...overrides,
  };
}

describe('canonical query adapter', () => {
  it('loads only one bounded page until the user asks for more', async () => {
    const first = {
      id: 'conversation-1',
      familiarId: 'familiar-1',
      title: 'First',
      updatedAt: '2026-08-28T10:00:00Z',
    };
    const second = {
      id: 'conversation-2',
      familiarId: 'familiar-2',
      title: 'Second',
      updatedAt: '2026-08-28T11:00:00Z',
    };
    const reads = makeReads({
      listConversations: vi
        .fn()
        .mockResolvedValueOnce({
          data: [first],
          cursor: { current: 'YQ', next: 'Yg', hasMore: true },
        })
        .mockResolvedValueOnce({
          data: [second],
          cursor: { current: 'Yg', hasMore: false },
        }),
    });
    const adapter = createQueryAdapter(reads, {
      authority: () => AUTHORITY,
      requestId: (() => {
        let next = 0;
        return () => `request:${++next}`;
      })(),
    });

    await adapter.loadConversations();

    expect(reads.listConversations).toHaveBeenCalledTimes(1);
    expect(reads.listConversations).toHaveBeenCalledWith(AUTHORITY, 'request:1', {
      limit: 25,
    });
    expect(adapter.getState().conversations.data[0]).toBe(first);
    expect(adapter.getState().conversations.hasMore).toBe(true);

    await adapter.loadMoreConversations();

    expect(reads.listConversations).toHaveBeenLastCalledWith(AUTHORITY, 'request:2', {
      limit: 25,
      cursor: 'Yg',
    });
    expect(adapter.getState().conversations.data).toEqual([first, second]);
  });

  it('stops cursor cycles without walking the corpus', async () => {
    const reads = makeReads({
      listConversations: vi
        .fn()
        .mockResolvedValueOnce({
          data: [],
          cursor: { current: 'YQ', next: 'Yg', hasMore: true },
        })
        .mockResolvedValueOnce({
          data: [],
          cursor: { current: 'Yg', next: 'YQ', hasMore: true },
        }),
    });
    const adapter = createQueryAdapter(reads, {
      authority: () => AUTHORITY,
      requestId: () => 'request:1',
    });

    await adapter.loadConversations();
    await adapter.loadMoreConversations();

    expect(adapter.getState().conversations).toMatchObject({
      status: 'error',
      code: 'invalid_response',
      hasMore: false,
    });
    expect(reads.listConversations).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh cursor walk for manual non-append reloads', async () => {
    const firstPage = {
      data: [],
      cursor: { current: 'YQ', next: 'Yg', hasMore: true },
    };
    const secondPage = {
      data: [],
      cursor: { current: 'Yg', hasMore: false },
    };
    const reads = makeReads({
      listConversations: vi
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(secondPage)
        .mockResolvedValueOnce(firstPage),
    });
    const adapter = createQueryAdapter(reads, {
      authority: () => AUTHORITY,
      requestId: () => 'request:1',
    });

    await adapter.loadConversations();
    await adapter.loadMoreConversations();
    await adapter.loadConversations();

    expect(adapter.getState().conversations).toMatchObject({
      status: 'ready',
      hasMore: true,
      nextCursor: 'Yg',
      pageCount: 1,
    });
  });

  it('starts a fresh message cursor walk after reconcile reload', async () => {
    const message = {
      id: 'message-1',
      conversationId: 'conversation-1',
      parentId: null,
      role: 'assistant',
      text: 'Canonical body',
      createdAt: '2026-08-28T11:01:00Z',
      attachmentCount: 0,
      toolCount: 0,
    };
    const reads = makeReads({
      listConversationMessages: vi
        .fn()
        .mockResolvedValueOnce({
          data: [message],
          cursor: { current: 'YQ', next: 'Yg', hasMore: true },
        })
        .mockResolvedValueOnce({
          data: [],
          cursor: { current: 'Yg', hasMore: false },
        })
        .mockRejectedValueOnce(new NativeBoundaryError('reconcile_required', false, DIAGNOSTIC_ID))
        .mockResolvedValueOnce({
          data: [message],
          cursor: { current: 'YQ', next: 'Yg', hasMore: true },
        }),
    });
    const adapter = createQueryAdapter(reads, {
      authority: () => AUTHORITY,
      requestId: () => 'request:1',
    });

    await adapter.loadMessages('conversation-1');
    await adapter.loadMoreMessages('conversation-1');
    await adapter.loadMessages('conversation-1');

    expect(adapter.getMessageState('conversation-1')).toMatchObject({
      status: 'ready',
      hasMore: true,
      nextCursor: 'Yg',
      pageCount: 1,
      reconcileCount: 1,
    });
  });

  it('rejects delayed results after authority and request generations change', async () => {
    let authority = AUTHORITY;
    const oldRequest = deferred<{
      data: readonly {
        id: string;
        familiarId: string;
        updatedAt: string;
      }[];
    }>();
    const current = {
      id: 'conversation-current',
      familiarId: 'familiar-1',
      updatedAt: '2026-08-28T11:00:00Z',
    };
    const reads = makeReads({
      listConversations: vi
        .fn()
        .mockReturnValueOnce(oldRequest.promise)
        .mockResolvedValueOnce({ data: [current] }),
    });
    const adapter = createQueryAdapter(reads, {
      authority: () => authority,
      requestId: (() => {
        let next = 0;
        return () => `request:${++next}`;
      })(),
    });

    const stale = adapter.loadConversations();
    authority = NEXT_AUTHORITY;
    const fresh = adapter.loadConversations();
    await fresh;
    oldRequest.resolve({
      data: [
        {
          id: 'conversation-stale',
          familiarId: 'familiar-1',
          updatedAt: '2026-08-28T09:00:00Z',
        },
      ],
    });
    await stale;

    expect(adapter.getState().conversations.data).toEqual([current]);
    expect(adapter.getState().conversations.authorityGeneration).toBe(2);
  });

  it('reloads only the affected query after reconcile_required', async () => {
    const project = {
      id: 'project-1',
      name: 'OpenCoven',
      root: 'OpenCoven',
      createdAt: '2026-08-28T09:00:00Z',
      updatedAt: '2026-08-28T10:00:00Z',
    };
    const conversation = {
      id: 'conversation-1',
      familiarId: 'familiar-1',
      updatedAt: '2026-08-28T11:00:00Z',
    };
    const reads = makeReads({
      listProjects: vi.fn().mockResolvedValue({ data: [project] }),
      listConversations: vi
        .fn()
        .mockRejectedValueOnce(new NativeBoundaryError('reconcile_required', false, DIAGNOSTIC_ID))
        .mockResolvedValueOnce({ data: [conversation] }),
    });
    const authorityFailure = vi.fn();
    const adapter = createQueryAdapter(reads, {
      authority: () => AUTHORITY,
      requestId: () => 'request:1',
      onAuthorityFailure: authorityFailure,
    });
    await adapter.loadProjects();
    const projectState = adapter.getState().projects;

    await adapter.loadConversations();

    expect(reads.listConversations).toHaveBeenCalledTimes(2);
    expect(adapter.getState().projects).toBe(projectState);
    expect(adapter.getState().conversations).toMatchObject({
      status: 'ready',
      data: [conversation],
      reconcileCount: 1,
    });
    expect(authorityFailure).not.toHaveBeenCalled();
  });

  it('loads one conversation and bounded message pages without remapping DTOs', async () => {
    const conversation = {
      id: 'conversation-1',
      familiarId: 'familiar-1',
      title: 'Canonical title',
      updatedAt: '2026-08-28T11:00:00Z',
    };
    const message = {
      id: 'message-1',
      conversationId: conversation.id,
      parentId: null,
      role: 'assistant',
      text: 'Canonical body',
      createdAt: '2026-08-28T11:01:00Z',
      attachmentCount: 0,
      toolCount: 0,
    };
    const reads = makeReads({
      getConversation: vi.fn().mockResolvedValue(conversation),
      listConversationMessages: vi.fn().mockResolvedValue({ data: [message] }),
    });
    const adapter = createQueryAdapter(reads, {
      authority: () => AUTHORITY,
      requestId: () => 'request:1',
    });

    await adapter.loadConversation(conversation.id);
    await adapter.loadMessages(conversation.id);

    expect(adapter.getConversationState(conversation.id).data).toBe(conversation);
    expect(adapter.getMessageState(conversation.id).data[0]).toBe(message);
    expect(reads.listConversationMessages).toHaveBeenCalledWith(
      AUTHORITY,
      'request:1',
      conversation.id,
      { limit: 25 },
    );
  });
});
