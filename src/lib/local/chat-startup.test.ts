import { createLocalChatSource } from './chat-source';
import { openIndexedDbChatBackend } from './indexeddb-backend';
import { createMemoryChatBackend } from './memory-backend';

vi.mock('./indexeddb-backend', () => ({ openIndexedDbChatBackend: vi.fn() }));

test.each(['revision', 'snapshot'] as const)(
  'a factory-owned backend closes after an opening %s failure and retry obtains a new connection',
  async (stage) => {
    const memory = createMemoryChatBackend();
    const close = vi.fn(memory.close);
    const error = new Error(`${stage} opening failure`);
    const backend = {
      ...memory,
      close,
      ...(stage === 'revision'
        ? { getMutationRevision: () => Promise.reject(error) }
        : { loadAll: () => Promise.reject(error) }),
    };
    vi.mocked(openIndexedDbChatBackend).mockResolvedValueOnce(backend);
    await expect(createLocalChatSource()).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
    const replacement = createMemoryChatBackend();
    const closeReplacement = vi.fn(replacement.close);
    vi.mocked(openIndexedDbChatBackend).mockResolvedValueOnce({
      ...replacement,
      close: closeReplacement,
    });
    const source = await createLocalChatSource();
    expect(closeReplacement).not.toHaveBeenCalled();
    source.store.dispose();
    expect(closeReplacement).toHaveBeenCalledOnce();
  },
);

test.each(['revision', 'snapshot'] as const)(
  'an injected backend remains caller-owned after an opening %s failure',
  async (stage) => {
    const memory = createMemoryChatBackend();
    const close = vi.fn(memory.close);
    let fail = true;
    const backend = {
      ...memory,
      close,
      getMutationRevision: async () => {
        if (fail && stage === 'revision') throw new Error('revision failed');
        return memory.getMutationRevision?.() ?? 0;
      },
      loadAll: async () => {
        if (fail && stage === 'snapshot') throw new Error('snapshot failed');
        return memory.loadAll();
      },
    };
    await expect(createLocalChatSource({ backend, familiarId: 'local' })).rejects.toThrow('failed');
    expect(close).not.toHaveBeenCalled();
    fail = false;
    const source = await createLocalChatSource({ backend, familiarId: 'local' });
    expect(close).not.toHaveBeenCalled();
    source.store.dispose();
    expect(close).toHaveBeenCalledOnce();
  },
);
