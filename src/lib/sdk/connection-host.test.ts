import { describe, expect, it, vi } from 'vitest';

import { createCaveConnectionHost } from './connection-host';
import type { NativeSdkInvoke } from './native-boundary';

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
      { handle: 'native-discovery-handle' },
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
});
