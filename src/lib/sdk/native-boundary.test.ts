import { describe, expect, it, vi } from 'vitest';

import {
  createCaveManagedCredentialTransport,
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
    const transport = createCaveManagedCredentialTransport(invoke);

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
      bytes: [123, 125],
      record: {
        identity: 'owner-record',
        device: 1,
        inode: 2,
        processAlive: true,
      },
    });
    const invoke = vi.fn<NativeSdkInvoke>().mockResolvedValue(discovery);

    await expect(createCaveManagedDiscoverySource(invoke).read()).resolves.toEqual(discovery);
    expect(invoke).toHaveBeenCalledWith('cave_read_discovery');
  });

  it('never places secret canaries in managed command arguments or results', async () => {
    const secret = 'secret-pairing-or-bearer-canary';
    const invoke = vi.fn<NativeSdkInvoke>().mockResolvedValue(opaqueResponse);
    const transport = createCaveManagedCredentialTransport(invoke);

    await transport.managedPairingPoll('opaque-handle');
    await transport.managedPairingExchange('opaque-handle');

    expect(JSON.stringify(invoke.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(await transport.managedCredentialStatus())).not.toContain(secret);
  });
});
