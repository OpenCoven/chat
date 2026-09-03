import { CaveClientError } from '@opencoven/cave-client/managed';
import { describe, expect, it, vi } from 'vitest';

import type { CaveReadClient } from './connection-controller';
import { createQueryAdapter } from './query-adapter';

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

function caveError(code: string, retryable = false) {
  return new CaveClientError(
    {
      system: 'cave',
      operation: 'familiars.list',
      code,
      retryable,
    },
    undefined,
  );
}

function createReadClient(overrides: Partial<CaveReadClient> = {}): CaveReadClient {
  return {
    listFamiliars: vi.fn().mockResolvedValue({
      data: [{ id: 'familiar-1', displayName: 'Mara', role: 'Guide' }],
      cursor: { current: 'cursor-1', hasMore: false },
    }),
    listProjects: vi.fn().mockResolvedValue({
      data: [
        {
          id: 'project-1',
          name: 'OpenCoven Chat',
          root: '/workspace/chat',
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
      cursor: { current: 'cursor-projects', hasMore: false },
    }),
    listConversations: vi.fn().mockResolvedValue({
      data: [
        {
          id: 'conversation-1',
          familiarId: 'familiar-1',
          title: 'Read-only check-in',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
      cursor: { current: 'cursor-conversations', hasMore: false },
    }),
    getConversation: vi.fn().mockResolvedValue({
      id: 'conversation-1',
      familiarId: 'familiar-1',
      title: 'Read-only check-in',
      updatedAt: '2026-08-25T00:00:00.000Z',
    }),
    listConversationMessages: vi.fn().mockResolvedValue({
      data: [
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
      ],
      cursor: { current: 'cursor-messages', hasMore: false },
    }),
    familiarContract: vi.fn().mockResolvedValue({
      id: 'familiar-1',
      present: { soul: true, identity: true, ward: true, memory: true },
      report: { specVersion: '1.0', pass: true, properties: [], violations: [], warnings: [] },
    }),
    familiarAnalytics: vi.fn().mockResolvedValue({
      generatedAt: '2026-08-25T00:00:00.000Z',
      windows: {},
      recentAttempts: [],
      backfill: { state: 'complete', imported: 0 },
    }),
    ...overrides,
  };
}

describe('createQueryAdapter', () => {
  it('returns not_ready when no ready client is available', async () => {
    const adapter = createQueryAdapter(() => null);

    await expect(adapter.listFamiliars()).resolves.toEqual({ status: 'not_ready' });
  });

  it('allows independent list reads to resolve in parallel without making each other stale', async () => {
    const familiars = deferred<Awaited<ReturnType<CaveReadClient['listFamiliars']>>>();
    const projects = deferred<Awaited<ReturnType<CaveReadClient['listProjects']>>>();
    const client = createReadClient({
      listFamiliars: vi.fn().mockImplementation(() => familiars.promise),
      listProjects: vi.fn().mockImplementation(() => projects.promise),
    });
    const adapter = createQueryAdapter(() => client);

    const familiarResult = adapter.listFamiliars();
    const projectResult = adapter.listProjects();

    projects.resolve({
      data: [
        {
          id: 'project-1',
          name: 'OpenCoven Chat',
          root: '/workspace/chat',
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
    });
    familiars.resolve({
      data: [{ id: 'familiar-1', displayName: 'Mara', role: 'Guide' }],
    });

    await expect(projectResult).resolves.toEqual({
      status: 'ok',
      data: {
        data: [
          {
            id: 'project-1',
            name: 'OpenCoven Chat',
            root: '/workspace/chat',
            createdAt: '2026-08-25T00:00:00.000Z',
            updatedAt: '2026-08-25T00:00:00.000Z',
          },
        ],
      },
    });
    await expect(familiarResult).resolves.toEqual({
      status: 'ok',
      data: {
        data: [{ id: 'familiar-1', displayName: 'Mara', role: 'Guide' }],
      },
    });
  });

  it('marks an older request in the same channel stale', async () => {
    const firstConversation = deferred<Awaited<ReturnType<CaveReadClient['getConversation']>>>();
    const client = createReadClient({
      getConversation: vi
        .fn()
        .mockImplementationOnce(() => firstConversation.promise)
        .mockResolvedValueOnce({
          id: 'conversation-2',
          familiarId: 'familiar-1',
          title: 'Second thread',
          updatedAt: '2026-08-25T00:05:00.000Z',
        }),
    });
    const adapter = createQueryAdapter(() => client);

    const first = adapter.getConversation('conversation-1');
    const second = adapter.getConversation('conversation-2');
    firstConversation.resolve({
      id: 'conversation-1',
      familiarId: 'familiar-1',
      title: 'First thread',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });

    await expect(second).resolves.toMatchObject({
      status: 'ok',
      data: { id: 'conversation-2' },
    });
    await expect(first).resolves.toEqual({ status: 'stale' });
  });

  it('uses a cached selection to supersede an older request in the same channel', async () => {
    const firstConversation = deferred<Awaited<ReturnType<CaveReadClient['getConversation']>>>();
    const client = createReadClient({
      getConversation: vi.fn().mockImplementation((conversationId: string) => {
        if (conversationId === 'conversation-1') {
          return firstConversation.promise;
        }
        return Promise.resolve({
          id: 'conversation-2',
          familiarId: 'familiar-1',
          title: 'Second thread',
          updatedAt: '2026-08-25T00:05:00.000Z',
        });
      }),
    });
    const adapter = createQueryAdapter(() => client);

    await adapter.getConversation('conversation-2');
    const first = adapter.getConversation('conversation-1');
    const cachedSecond = adapter.getConversation('conversation-2');
    firstConversation.resolve({
      id: 'conversation-1',
      familiarId: 'familiar-1',
      title: 'First thread',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });

    await expect(cachedSecond).resolves.toMatchObject({
      status: 'ok',
      data: { id: 'conversation-2' },
    });
    await expect(first).resolves.toEqual({ status: 'stale' });
    expect(client.getConversation).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh request when a stale in-flight selection is reselected', async () => {
    const firstA = deferred<Awaited<ReturnType<CaveReadClient['getConversation']>>>();
    const secondA = deferred<Awaited<ReturnType<CaveReadClient['getConversation']>>>();
    const client = createReadClient({
      getConversation: vi
        .fn()
        .mockImplementationOnce(() => firstA.promise)
        .mockResolvedValueOnce({
          id: 'conversation-b',
          familiarId: 'familiar-1',
          title: 'Thread B',
          updatedAt: '2026-08-25T00:05:00.000Z',
        })
        .mockImplementationOnce(() => secondA.promise),
    });
    const adapter = createQueryAdapter(() => client);

    const staleA = adapter.getConversation('conversation-a');
    const selectedB = adapter.getConversation('conversation-b');
    const selectedA = adapter.getConversation('conversation-a');

    firstA.resolve({
      id: 'conversation-a',
      familiarId: 'familiar-1',
      title: 'Old thread A',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });
    secondA.resolve({
      id: 'conversation-a',
      familiarId: 'familiar-1',
      title: 'Current thread A',
      updatedAt: '2026-08-25T00:10:00.000Z',
    });

    await expect(staleA).resolves.toEqual({ status: 'stale' });
    await expect(selectedB).resolves.toEqual({ status: 'stale' });
    await expect(selectedA).resolves.toMatchObject({
      status: 'ok',
      data: { id: 'conversation-a', title: 'Current thread A' },
    });
    expect(client.getConversation).toHaveBeenCalledTimes(3);
  });

  it('aborts superseded in-flight requests in the same channel', async () => {
    const first = deferred<Awaited<ReturnType<CaveReadClient['getConversation']>>>();
    let firstSignal: AbortSignal | undefined;
    const client = createReadClient({
      getConversation: vi
        .fn()
        .mockImplementationOnce((_conversationId, options) => {
          firstSignal = options?.signal;
          return first.promise;
        })
        .mockResolvedValueOnce({
          id: 'conversation-b',
          familiarId: 'familiar-1',
          title: 'Thread B',
          updatedAt: '2026-08-25T00:05:00.000Z',
        }),
    });
    const adapter = createQueryAdapter(() => client);

    const superseded = adapter.getConversation('conversation-a');
    const selected = adapter.getConversation('conversation-b');

    expect(firstSignal?.aborted).toBe(true);
    first.resolve({
      id: 'conversation-a',
      familiarId: 'familiar-1',
      title: 'Thread A',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });

    await expect(superseded).resolves.toEqual({ status: 'stale' });
    await expect(selected).resolves.toMatchObject({
      status: 'ok',
      data: { id: 'conversation-b' },
    });
  });

  it('coalesces identical concurrent reads into a single SDK call', async () => {
    const pending = deferred<Awaited<ReturnType<CaveReadClient['listConversations']>>>();
    const client = createReadClient({
      listConversations: vi.fn().mockImplementation(() => pending.promise),
    });
    const adapter = createQueryAdapter(() => client);

    const first = adapter.listConversations({ limit: 50 });
    const _second = adapter.listConversations({ limit: 50 });

    expect(client.listConversations).toHaveBeenCalledTimes(1);

    pending.resolve({
      data: [
        {
          id: 'conversation-1',
          familiarId: 'familiar-1',
          title: 'Read-only check-in',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
    });

    await expect(first).resolves.toEqual({
      status: 'ok',
      data: {
        data: [
          {
            id: 'conversation-1',
            familiarId: 'familiar-1',
            title: 'Read-only check-in',
            updatedAt: '2026-08-25T00:00:00.000Z',
          },
        ],
      },
    });
  });

  it('serves cached results until the ttl expires', async () => {
    let now = 1_000;
    const client = createReadClient();
    const adapter = createQueryAdapter(() => client, {
      now: () => now,
    });

    const first = await adapter.listProjects();
    const second = await adapter.listProjects();

    expect(client.listProjects).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    now += 5_001;
    await adapter.listProjects();

    expect(client.listProjects).toHaveBeenCalledTimes(2);
  });

  it('defaults list limits to 50 and passes the max valid limit of 100 through unchanged, preserving valid cursors', async () => {
    const client = createReadClient();
    const adapter = createQueryAdapter(() => client);
    const cursor = 'Y3Vyc29yLTE';

    await adapter.listFamiliars();
    await adapter.listConversations({ limit: 100, cursor });
    await adapter.listMessages('conversation-1', { limit: 100, cursor });

    expect(client.listFamiliars).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 50,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(client.listConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100,
        cursor,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(client.listConversationMessages).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        limit: 100,
        cursor,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('rejects malformed pagination instead of silently reading another page', async () => {
    const client = createReadClient();
    const adapter = createQueryAdapter(() => client);

    await expect(adapter.listFamiliars({ cursor: '../not-a-cursor' })).resolves.toEqual({
      status: 'error',
      code: 'invalid_request',
    });
    await expect(adapter.listProjects({ limit: 0 })).resolves.toEqual({
      status: 'error',
      code: 'invalid_request',
    });
    expect(client.listFamiliars).not.toHaveBeenCalled();
    expect(client.listProjects).not.toHaveBeenCalled();
  });

  it('rejects limits above the maximum of 100 instead of clamping them', async () => {
    const client = createReadClient();
    const adapter = createQueryAdapter(() => client);

    await expect(adapter.listConversations({ limit: 999 })).resolves.toEqual({
      status: 'error',
      code: 'invalid_request',
    });
    await expect(adapter.listMessages('conversation-1', { limit: 101 })).resolves.toEqual({
      status: 'error',
      code: 'invalid_request',
    });
    expect(client.listConversations).not.toHaveBeenCalled();
    expect(client.listConversationMessages).not.toHaveBeenCalled();
  });

  it('marks an in-flight completion stale when the controller leaves ready', async () => {
    const pending = deferred<Awaited<ReturnType<CaveReadClient['listFamiliars']>>>();
    let currentClient: CaveReadClient | null = createReadClient({
      listFamiliars: vi.fn().mockImplementation(() => pending.promise),
    });
    const adapter = createQueryAdapter(() => currentClient);

    const result = adapter.listFamiliars();
    currentClient = null;
    pending.resolve({
      data: [{ id: 'familiar-1', displayName: 'Mara', role: 'Guide' }],
    });

    await expect(result).resolves.toEqual({ status: 'stale' });
  });

  it('marks old completions stale after the ready client identity changes', async () => {
    const oldRead = deferred<Awaited<ReturnType<CaveReadClient['listFamiliars']>>>();
    const oldClient = createReadClient({
      listFamiliars: vi.fn().mockImplementation(() => oldRead.promise),
    });
    const newClient = createReadClient({
      listFamiliars: vi.fn().mockResolvedValue({
        data: [{ id: 'familiar-2', displayName: 'Sable', role: 'Archivist' }],
      }),
    });
    let currentClient: CaveReadClient | null = oldClient;
    const adapter = createQueryAdapter(() => currentClient);

    const oldResult = adapter.listFamiliars();
    currentClient = newClient;
    oldRead.resolve({
      data: [{ id: 'familiar-1', displayName: 'Mara', role: 'Guide' }],
    });

    await expect(oldResult).resolves.toEqual({ status: 'stale' });
    await expect(adapter.listFamiliars()).resolves.toEqual({
      status: 'ok',
      data: {
        data: [{ id: 'familiar-2', displayName: 'Sable', role: 'Archivist' }],
      },
    });
  });

  it('invalidates in-flight reads, clears cache, and still allows future reads', async () => {
    const pending = deferred<Awaited<ReturnType<CaveReadClient['listProjects']>>>();
    let abortSignal: AbortSignal | undefined;
    const client = createReadClient({
      listProjects: vi
        .fn()
        .mockImplementationOnce((options) => {
          abortSignal = options?.signal;
          return pending.promise;
        })
        .mockResolvedValue({
          data: [
            {
              id: 'project-1',
              name: 'OpenCoven Chat',
              root: '/workspace/chat',
              createdAt: '2026-08-25T00:00:00.000Z',
              updatedAt: '2026-08-25T00:00:00.000Z',
            },
          ],
          cursor: { current: 'cursor-projects', hasMore: false },
        }),
    });
    const adapter = createQueryAdapter(() => client);

    const first = adapter.listProjects();
    adapter.invalidate();

    expect(abortSignal?.aborted).toBe(true);
    pending.reject(caveError('aborted'));
    await expect(first).resolves.toEqual({ status: 'stale' });

    await expect(adapter.listProjects()).resolves.toEqual({
      status: 'ok',
      data: {
        data: [
          {
            id: 'project-1',
            name: 'OpenCoven Chat',
            root: '/workspace/chat',
            createdAt: '2026-08-25T00:00:00.000Z',
            updatedAt: '2026-08-25T00:00:00.000Z',
          },
        ],
        cursor: { current: 'cursor-projects', hasMore: false },
      },
    });
    expect(client.listProjects).toHaveBeenCalledTimes(2);
  });

  it('disposes permanently and returns not_ready after aborting in-flight reads', async () => {
    const pending = deferred<Awaited<ReturnType<CaveReadClient['listProjects']>>>();
    const client = createReadClient({
      listProjects: vi.fn().mockImplementation(() => pending.promise),
    });
    const adapter = createQueryAdapter(() => client);

    const first = adapter.listProjects();
    adapter.dispose();
    pending.reject(caveError('aborted'));

    await expect(first).resolves.toEqual({ status: 'not_ready' });
    await expect(adapter.listProjects()).resolves.toEqual({ status: 'not_ready' });
  });

  it('surfaces reconcile_required separately from generic errors', async () => {
    const client = createReadClient({
      listProjects: vi.fn().mockRejectedValue(caveError('reconcile_required')),
    });
    const adapter = createQueryAdapter(() => client);

    await expect(adapter.listProjects()).resolves.toEqual({ status: 'reconcile_required' });
  });

  it('never touches browser persistence APIs', async () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem');
    const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    const cachesDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches');

    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get() {
        throw new Error('indexedDB should not be accessed');
      },
    });
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      get() {
        throw new Error('Cache API should not be accessed');
      },
    });

    try {
      const client = createReadClient();
      const adapter = createQueryAdapter(() => client);

      await adapter.listProjects();
      await adapter.listMessages('conversation-1');

      expect(getItemSpy).not.toHaveBeenCalled();
      expect(setItemSpy).not.toHaveBeenCalled();
      expect(removeItemSpy).not.toHaveBeenCalled();
    } finally {
      if (indexedDbDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, 'indexedDB');
      } else {
        Object.defineProperty(globalThis, 'indexedDB', indexedDbDescriptor);
      }

      if (cachesDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, 'caches');
      } else {
        Object.defineProperty(globalThis, 'caches', cachesDescriptor);
      }
    }
  });

  it('returns frozen immutable snapshots for successful reads and result objects', async () => {
    const source = {
      data: [{ id: 'familiar-1', displayName: 'Mara', role: 'Guide' }],
      cursor: { current: 'cursor-1', hasMore: false },
    };
    const client = createReadClient({
      listFamiliars: vi.fn().mockResolvedValue(source),
    });
    const adapter = createQueryAdapter(() => client);
    const result = await adapter.listFamiliars();

    expect(Object.isFrozen(result)).toBe(true);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }

    expect(Object.isFrozen(result.data)).toBe(true);
    expect(Object.isFrozen(result.data.data)).toBe(true);
    expect(Object.isFrozen(result.data.data[0])).toBe(true);
    expect(Object.isFrozen(result.data.cursor ?? null)).toBe(true);
    expect(result.data).not.toBe(source);
    expect(result.data.data).not.toBe(source.data);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.data)).toBe(false);
  });
});
