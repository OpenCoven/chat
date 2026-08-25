import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import {
  createCaveManagedCredentialTransport,
  createCaveManagedDiscoveryBinding,
  createCaveManagedDiscoverySource,
  type NativeSdkInvoke,
} from './native-boundary';

const opaqueResponse = Object.freeze({
  statusCode: 200,
  payload: Object.freeze({ safe: true }),
});

describe('Cave managed native boundary', () => {
  it('maps each SDK-managed operation to its narrow native command', async () => {
    const invoke = vi.fn<NativeSdkInvoke>().mockResolvedValue(opaqueResponse);
    const transport = createCaveManagedCredentialTransport(invoke, 'native-discovery-handle');

    await transport.health();
    await transport.managedPairingCreate({
      appName: 'OpenCoven Chat',
      installationId: '00000000-0000-4000-8000-000000000001',
      scopes: ['chat:read'],
    });
    await transport.managedPairingPoll('request-1');
    await transport.managedPairingExchange('request-1');
    await transport.managedCredentialStatus();
    await transport.managedForgetCredential();
    await transport.listFamiliars?.({ limit: 20 });
    await transport.listProjects?.({ limit: 20 });
    await transport.listConversations?.({ limit: 20 });
    await transport.getConversation?.('conversation-1');
    await transport.listConversationMessages?.('conversation-1', { limit: 20 });

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'cave_health',
      'cave_pairing_create',
      'cave_pairing_poll',
      'cave_pairing_exchange',
      'cave_credential_status',
      'cave_forget_credential',
      'cave_list_familiars',
      'cave_list_projects',
      'cave_list_conversations',
      'cave_get_conversation',
      'cave_list_conversation_messages',
    ]);
  });

  it('exposes owner-checked discovery bytes without an endpoint command', async () => {
    const discovery = Object.freeze({
      handle: 'native-discovery-handle',
      bytes: [123, 125],
      record: {
        identity: 'owner-record',
        device: 1,
        inode: 2,
        processAlive: true,
      },
    });
    const invoke = vi.fn<NativeSdkInvoke>().mockResolvedValue(discovery);

    await expect(createCaveManagedDiscoverySource(invoke).read()).resolves.toEqual({
      bytes: discovery.bytes,
      record: discovery.record,
    });
    expect(invoke).toHaveBeenCalledWith('cave_read_discovery');
  });

  it('binds every managed transport command to an opaque discovery handle', async () => {
    const invoke = vi.fn<NativeSdkInvoke>().mockResolvedValue(opaqueResponse);
    const transport = createCaveManagedCredentialTransport(invoke, 'native-discovery-handle');

    await transport.health();
    await transport.managedPairingPoll('request-1');
    await transport.listFamiliars?.({ limit: 20 });

    expect(invoke.mock.calls).toEqual([
      ['cave_health', { handle: 'native-discovery-handle' }],
      ['cave_pairing_poll', { handle: 'native-discovery-handle', requestId: 'request-1' }],
      ['cave_list_familiars', { handle: 'native-discovery-handle', page: { limit: 20 } }],
    ]);
  });

  it('retains a handle only until the SDK discovery source has consumed its matching bytes', async () => {
    const invoke = vi.fn<NativeSdkInvoke>().mockResolvedValue({
      handle: 'native-discovery-handle',
      bytes: [123, 125],
      record: {
        identity: 'owner-record',
        device: 1,
        inode: 2,
        processAlive: true,
      },
    });
    const binding = createCaveManagedDiscoveryBinding(invoke);

    await binding.source.read();

    expect(binding.takeHandle()).toBe('native-discovery-handle');
    expect(() => binding.takeHandle()).toThrow('Cave service was unavailable.');
  });

  it('never places secret canaries in managed command arguments or results', async () => {
    const secret = 'secret-pairing-or-bearer-canary';
    const invoke = vi.fn<NativeSdkInvoke>().mockResolvedValue(opaqueResponse);
    const transport = createCaveManagedCredentialTransport(invoke, 'native-discovery-handle');

    await transport.managedPairingPoll('opaque-handle');
    await transport.managedPairingExchange('opaque-handle');

    expect(JSON.stringify(invoke.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(await transport.managedCredentialStatus())).not.toContain(secret);
  });

  it('returns a fresh frozen native snapshot and rejects forbidden native fields', async () => {
    const native = Object.freeze({ status: 'missing' });
    const transport = createCaveManagedCredentialTransport(
      vi.fn<NativeSdkInvoke>().mockResolvedValue(native),
      'native-discovery-handle',
    );

    const snapshot = await transport.managedCredentialStatus();
    expect(snapshot).toEqual(native);
    expect(snapshot).not.toBe(native);
    expect(Object.isFrozen(snapshot as object)).toBe(true);

    const forbidden = createCaveManagedCredentialTransport(
      vi.fn<NativeSdkInvoke>().mockResolvedValue({
        status: 'missing',
        cause: { path: 'native-path-secret-canary' },
      }),
      'native-discovery-handle',
    );
    await expect(forbidden.managedCredentialStatus()).rejects.toEqual({
      code: 'invalid_response',
      retryable: false,
      message: 'Cave response was invalid.',
    });
  });

  it('replaces hostile native rejection objects with a fresh redacted diagnostic', async () => {
    const secret = 'native-rejection-secret-canary';
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(hostile, {
      code: { enumerable: true, value: 'attacker_code' },
      retryable: { enumerable: true, value: false },
      message: { enumerable: true, value: secret },
      cause: { enumerable: true, value: { secret } },
      details: {
        enumerable: true,
        get() {
          return { token: secret };
        },
      },
    });
    const invoke = vi.fn<NativeSdkInvoke>().mockRejectedValue(hostile);
    const transport = createCaveManagedCredentialTransport(invoke, 'native-discovery-handle');

    const error = await transport.health().catch((rejection) => rejection);
    const snapshots = [
      String(error),
      JSON.stringify(error),
      inspect(error),
      JSON.stringify({ connectionState: { diagnostic: error } }),
    ];

    expect(error).toEqual({
      code: 'service_unavailable',
      retryable: true,
      message: 'Cave service was unavailable.',
    });
    for (const snapshot of snapshots) {
      expect(snapshot).not.toContain(secret);
    }
  });
});
