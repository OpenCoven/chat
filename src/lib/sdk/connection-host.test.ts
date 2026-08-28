import { describe, expect, it, vi } from 'vitest';

import { createCaveConnectionHost } from './connection-host';
import type { NativeSdkInvoke } from './native-boundary';

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve(value: T) {
      resolve?.(value);
    },
  };
}

function discoveryRecord() {
  return {
    version: 2,
    endpoint: 'http://127.0.0.1:3020',
    pid: 4321,
    nonce: 'gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8',
    startedAt: '2026-08-20T20:20:12.617Z',
    authority: {
      mechanism: 'hpke-bound-v1',
      mode: 'enforce',
      keyId: 'Tq04GMSX5BPPPijzO9pHfQ1lAnna_RQKzL1ncDGl-4g',
      publicKey: 'sfG4QN56MkGwJ0jPmwW3TcjF6EUSmHOIF712qo6-jCs',
      suite: {
        kemId: 32,
        kdfId: 1,
        aeadId: 2,
      },
    },
  };
}

function discoverySnapshot(handle: string) {
  return {
    handle,
    bytes: Array.from(new TextEncoder().encode(JSON.stringify(discoveryRecord()))),
    record: {
      identity: 'owner-record',
      device: 1,
      inode: 2,
      processAlive: true,
    },
  };
}

describe('Cave connection host', () => {
  it('creates a handle-bound managed client only after SDK discovery validation', async () => {
    const invoke = vi.fn<NativeSdkInvoke>().mockResolvedValue({
      handle: 'native-discovery-handle',
      bytes: Array.from(new TextEncoder().encode(JSON.stringify(discoveryRecord()))),
      record: {
        identity: 'owner-record',
        device: 1,
        inode: 2,
        processAlive: true,
      },
    });
    const host = createCaveConnectionHost(invoke);

    const discovered = await host.discover();

    expect(discovered.endpoint.endpoint.url).toBe('http://127.0.0.1:3020');
    await discovered.client.health().catch(() => undefined);
    expect(invoke.mock.calls.at(-1)).toEqual([
      'cave_health',
      {
        handle: 'native-discovery-handle',
        operation: {
          attemptId: expect.any(String),
          timeoutMs: expect.any(Number),
        },
      },
    ]);
  });

  it('resets pairing through the discovered opaque handle and then clears it', async () => {
    const invoke = vi.fn<NativeSdkInvoke>().mockImplementation(async (command) => {
      if (command === 'cave_read_discovery') {
        return {
          handle: 'native-discovery-handle',
          bytes: Array.from(new TextEncoder().encode(JSON.stringify(discoveryRecord()))),
          record: {
            identity: 'owner-record',
            device: 1,
            inode: 2,
            processAlive: true,
          },
        };
      }
      return command === 'cave_reset_pairing' ? { status: 'invalidated' } : { status: 'missing' };
    });
    const host = createCaveConnectionHost(invoke);

    await host.discover();
    await host.resetPairing();

    expect(invoke.mock.calls.at(-1)).toEqual([
      'cave_reset_pairing',
      {
        handle: 'native-discovery-handle',
      },
    ]);
    await expect(host.resetPairing()).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('propagates abort-before-start without installing a discovery handle', async () => {
    const controller = new AbortController();
    controller.abort();
    const invoke = vi.fn<NativeSdkInvoke>().mockImplementation(async (command) => {
      if (command === 'cave_cancel_operation') {
        return { status: 'queued' };
      }
      return discoverySnapshot('stale-handle');
    });
    const host = createCaveConnectionHost(invoke);

    await expect(
      host.discover({ signal: controller.signal, timeoutMs: 100 }),
    ).rejects.toMatchObject({
      code: 'aborted',
    });
    await expect(host.resetPairing()).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(invoke.mock.calls.some(([command]) => command === 'cave_read_discovery')).toBe(false);
  });

  it('aborts an in-flight discovery and ignores its late native completion', async () => {
    const first = deferred<ReturnType<typeof discoverySnapshot>>();
    const controller = new AbortController();
    const resetHandles: unknown[] = [];
    const invoke = vi.fn<NativeSdkInvoke>().mockImplementation(async (command, args) => {
      if (command === 'cave_read_discovery') {
        return await first.promise;
      }
      if (command === 'cave_cancel_operation') {
        return { status: 'cancelled' };
      }
      if (command === 'cave_reset_pairing') {
        resetHandles.push(args?.handle);
        return { status: 'invalidated' };
      }
      throw new Error('unexpected command');
    });
    const host = createCaveConnectionHost(invoke);
    const discovery = host.discover({ signal: controller.signal, timeoutMs: 1_000 });

    await Promise.resolve();
    controller.abort();
    first.resolve(discoverySnapshot('late-handle'));
    await expect(discovery).rejects.toMatchObject({
      code: 'aborted',
    });
    await expect(host.resetPairing()).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(resetHandles).toEqual([]);
  });

  it('times out discovery and prevents an older attempt from overwriting a newer handle', async () => {
    const timed = deferred<ReturnType<typeof discoverySnapshot>>();
    const stale = deferred<ReturnType<typeof discoverySnapshot>>();
    const resetHandles: unknown[] = [];
    let reads = 0;
    const invoke = vi.fn<NativeSdkInvoke>().mockImplementation(async (command, args) => {
      if (command === 'cave_read_discovery') {
        reads += 1;
        if (reads === 1) {
          return await timed.promise;
        }
        if (reads === 2) {
          return await stale.promise;
        }
        return discoverySnapshot('current-handle');
      }
      if (command === 'cave_cancel_operation') {
        return { status: 'cancelled' };
      }
      if (command === 'cave_reset_pairing') {
        resetHandles.push(args?.handle);
        return { status: 'invalidated' };
      }
      throw new Error('unexpected command');
    });
    const host = createCaveConnectionHost(invoke);
    const timedDiscovery = host.discover({ timeoutMs: 10 });
    setTimeout(() => timed.resolve(discoverySnapshot('timed-out-handle')), 30);

    await expect(timedDiscovery).rejects.toMatchObject({
      code: 'timeout',
    });

    const staleDiscovery = host.discover({ timeoutMs: 1_000 });
    await Promise.resolve();
    const current = await host.discover({ timeoutMs: 1_000 });
    expect(current.endpoint.version).toBe(2);
    stale.resolve(discoverySnapshot('stale-handle'));
    await expect(staleDiscovery).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    await host.resetPairing();

    expect(resetHandles).toEqual(['current-handle']);
  });
});
