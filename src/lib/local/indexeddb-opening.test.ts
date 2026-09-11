import { openIndexedDbChatBackend } from './indexeddb-backend';

class OpeningRequest {
  onblocked: unknown;
  onupgradeneeded: unknown;
  onerror: unknown;
  onsuccess: unknown;
  error = new DOMException('Opening failed', 'AbortError');
  result = { close: vi.fn() };
  transaction = { abort: vi.fn() };

  emit(type: string) {
    const handler: unknown = Reflect.get(this, `on${type}`);
    if (typeof handler !== 'function') throw new Error(`Missing ${type} handler`);
    Reflect.apply(handler, this, [new Event(type)]);
  }
}

test.each(['synchronous', 'request'] as const)(
  'a present IndexedDB factory propagates its %s opening failure rather than returning a memory fallback',
  async (kind) => {
    const request = new OpeningRequest();
    const error = new DOMException('Access denied', 'SecurityError');
    const factory = {
      open: () => {
        if (kind === 'synchronous') throw error;
        return request;
      },
    };
    const pending = Reflect.apply(openIndexedDbChatBackend, undefined, [factory]);
    const rejected = expect(pending).rejects.toBe(kind === 'synchronous' ? error : request.error);
    if (kind === 'request') request.emit('error');
    await rejected;
  },
);

test('blocked opening retains one abandoned request, aborts its eventual upgrade, closes it and permits a fresh retry', async () => {
  const blocked = new OpeningRequest();
  const retried = new OpeningRequest();
  const open = vi.fn().mockReturnValueOnce(blocked).mockReturnValueOnce(retried);
  const factory = { open };
  const first = Reflect.apply(openIndexedDbChatBackend, undefined, [factory]);
  const rejected = expect(first).rejects.toThrow('blocked');
  blocked.emit('blocked');
  await rejected;
  for (let retry = 0; retry < 3; retry += 1) {
    await expect(Reflect.apply(openIndexedDbChatBackend, undefined, [factory])).rejects.toThrow(
      'blocked',
    );
  }
  expect(open).toHaveBeenCalledOnce();
  blocked.emit('upgradeneeded');
  expect(blocked.transaction.abort).toHaveBeenCalledOnce();
  expect(blocked.result.close).toHaveBeenCalledOnce();
  blocked.emit('error');
  const retry = Reflect.apply(openIndexedDbChatBackend, undefined, [factory]);
  retried.emit('success');
  const backend = await retry;
  expect(open).toHaveBeenCalledTimes(2);
  expect(retried.result.close).not.toHaveBeenCalled();
  backend.close();
  expect(retried.result.close).toHaveBeenCalledOnce();
});
