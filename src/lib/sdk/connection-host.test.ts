import { describe, expect, it, vi } from 'vitest';

import { createCaveConnectionHost } from './connection-host';
import type { NativeSdkInvoke } from './native-boundary';

describe('Cave connection host', () => {
  it('creates a handle-bound managed client only after SDK discovery validation', async () => {
    const invoke = vi.fn<NativeSdkInvoke>().mockResolvedValue({
      handle: 'native-discovery-handle',
      bytes: Array.from(
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            endpoint: 'http://127.0.0.1:3020',
            pid: 4321,
            nonce: '018f4f1a-77c2-7a31-8a15-55a25aaba003',
            startedAt: '2026-08-20T20:20:12.617Z',
          }),
        ),
      ),
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

  it('cancels only the requested pairing through the discovered opaque handle', async () => {
    const invoke = vi.fn<NativeSdkInvoke>().mockImplementation(async (command) => {
      if (command === 'cave_read_discovery') {
        return {
          handle: 'native-discovery-handle',
          bytes: Array.from(
            new TextEncoder().encode(
              JSON.stringify({
                version: 1,
                endpoint: 'http://127.0.0.1:3020',
                pid: 4321,
                nonce: '018f4f1a-77c2-7a31-8a15-55a25aaba003',
                startedAt: '2026-08-20T20:20:12.617Z',
              }),
            ),
          ),
          record: {
            identity: 'owner-record',
            device: 1,
            inode: 2,
            processAlive: true,
          },
        };
      }
      return { status: 'missing' };
    });
    const host = createCaveConnectionHost(invoke);

    await host.discover();
    await host.cancelPairing('00000000-0000-4000-8000-000000000003');

    expect(invoke.mock.calls.at(-1)).toEqual([
      'cave_cancel_pairing',
      {
        handle: 'native-discovery-handle',
        requestId: '00000000-0000-4000-8000-000000000003',
      },
    ]);
  });
});
