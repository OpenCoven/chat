import {
  createNativeBoundary,
  type InvokeCommand,
  type ListenCommand,
  NATIVE_COMMANDS,
  NativeBoundaryError,
} from './native-boundary';

const AUTHORITY = Object.freeze({
  handle: 'authority:00000000-0000-4000-8000-000000000001',
  generation: 1,
});
const REQUEST_ID = 'request:1';
const INSTANCE_ID = '00000000-0000-4000-8000-000000000002';
const DIAGNOSTIC_ID = '00000000-0000-4000-8000-000000000003';

function operation(result: unknown, requestId = REQUEST_ID) {
  return {
    authority: AUTHORITY,
    requestId,
    result,
  };
}

function response(data: unknown, capabilities: string[], operations: string[], statusCode = 200) {
  return {
    statusCode,
    payload: {
      apiVersion: '1.0',
      minimumClientVersion: '0.1.0',
      requestId: REQUEST_ID,
      capabilities,
      operations,
      data,
    },
  };
}

describe('native boundary', () => {
  it('uses only the reviewed operation-specific command names', () => {
    expect(NATIVE_COMMANDS).toEqual({
      discover: 'sdk_authority_discover',
      close: 'sdk_authority_close',
      installationIdentity: 'sdk_installation_identity',
      health: 'cave_health',
      pairingCreate: 'cave_pairing_create',
      pairingPoll: 'cave_pairing_poll',
      pairingExchange: 'cave_pairing_exchange',
      pairingCommit: 'cave_pairing_commit',
      pairingDiscard: 'cave_pairing_discard',
      credentialState: 'cave_credential_state',
      forgetCredential: 'cave_forget_credential',
      listFamiliars: 'cave_list_familiars',
      listProjects: 'cave_list_projects',
      listConversations: 'cave_list_conversations',
      getConversation: 'cave_get_conversation',
      listConversationMessages: 'cave_list_conversation_messages',
      diagnostics: 'sdk_native_diagnostics',
    });
  });

  it('validates and unwraps health without exposing the native envelope', async () => {
    const invokeCommand = vi.fn<InvokeCommand>().mockResolvedValue(
      operation(
        response(
          {
            instanceId: INSTANCE_ID,
            pairingRequired: true,
            releaseVersion: '0.1.0',
          },
          ['health'],
          ['health.read'],
        ),
      ),
    );
    const boundary = createNativeBoundary({ invoke: invokeCommand });

    await expect(boundary.health(AUTHORITY, REQUEST_ID)).resolves.toEqual({
      status: 'ok',
      apiVersion: '1.0',
      minimumClientVersion: '0.1.0',
      capabilities: ['health'],
      operations: ['health.read'],
      instanceId: INSTANCE_ID,
      pairingRequired: true,
      releaseVersion: '0.1.0',
    });
    expect(invokeCommand).toHaveBeenCalledWith('cave_health', {
      input: { authority: AUTHORITY, requestId: REQUEST_ID },
    });
  });

  it('rejects extra keys and accessor-backed hostile invoke results without evaluating them', async () => {
    let getterRead = false;
    const hostile = Object.defineProperty(
      {
        handle: AUTHORITY.handle,
        generation: AUTHORITY.generation,
        unexpected: true,
      },
      'secret',
      {
        enumerable: true,
        get() {
          getterRead = true;
          return 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        },
      },
    );
    const boundary = createNativeBoundary({
      invoke: vi.fn<InvokeCommand>().mockResolvedValue(hostile),
    });

    await expect(boundary.discover()).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
    expect(getterRead).toBe(false);
  });

  it('rejects a secret-shaped value in any command result', async () => {
    const boundary = createNativeBoundary({
      invoke: vi.fn<InvokeCommand>().mockResolvedValue({
        ...operation(
          response(
            {
              familiars: [
                {
                  id: 'familiar-1',
                  displayName: 'Astra',
                  role: 'Research',
                  description: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                },
              ],
            },
            ['familiars', 'cursors'],
            ['familiars.list'],
          ),
        ),
        bearer: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    });

    await expect(
      boundary.listFamiliars(AUTHORITY, REQUEST_ID, { limit: 25 }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps only exact native error objects into presentation-safe errors', async () => {
    const boundary = createNativeBoundary({
      invoke: vi.fn<InvokeCommand>().mockRejectedValue({
        code: 'service_unavailable',
        retryable: true,
        diagnosticId: DIAGNOSTIC_ID,
      }),
    });

    await expect(boundary.discover()).rejects.toEqual(
      new NativeBoundaryError('service_unavailable', true, DIAGNOSTIC_ID),
    );

    const hostile = createNativeBoundary({
      invoke: vi.fn<InvokeCommand>().mockRejectedValue({
        code: 'service_unavailable',
        retryable: true,
        diagnosticId: DIAGNOSTIC_ID,
        cause: '/Users/person/private/credential',
      }),
    });
    await expect(hostile.discover()).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
  });

  it('rejects hostile nested authority bindings from pairing exchange', async () => {
    const invokeCommand = vi.fn<InvokeCommand>().mockResolvedValue(
      operation({
        authorityBinding: {
          version: 1,
          instanceId: INSTANCE_ID,
          endpoint: {
            kind: 'http',
            url: 'http://localhost:3020/',
            privatePath: '/Users/person/private',
          },
          record: {
            identity: `sha256:${'a'.repeat(64)}`,
            device: 1,
            inode: 2,
          },
          freshness: {
            pid: 10,
            nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            startedAt: '2026-08-28T10:00:00Z',
          },
        },
        commitHandle: 'commit:00000000-0000-4000-8000-000000000004',
        response: response(
          {
            credential: {
              id: '00000000-0000-4000-8000-000000000005',
              appName: 'OpenCoven Chat',
              installationId: '00000000-0000-4000-8000-000000000006',
              scopes: ['chat:read'],
              createdAt: 1,
              lastUsedAt: null,
              revokedAt: null,
              revocationReason: null,
            },
          },
          ['pairing', 'credentials'],
          ['pairing.exchange'],
        ),
      }),
    );
    const boundary = createNativeBoundary({ invoke: invokeCommand });

    await expect(
      boundary.pairingExchange(
        AUTHORITY,
        REQUEST_ID,
        'pairing:00000000-0000-4000-8000-000000000007',
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('validates exact lifecycle events and drops hostile payloads', async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined;
    const listener = vi.fn<ListenCommand>().mockImplementation(async (_event, next) => {
      handler = next;
      return () => undefined;
    });
    const received: unknown[] = [];
    const boundary = createNativeBoundary({
      invoke: vi.fn<InvokeCommand>(),
      listen: listener,
    });

    await boundary.listenConnectionEvents((event) => received.push(event));
    handler?.({
      payload: {
        version: 1,
        authority: AUTHORITY,
        kind: 'credential_revoked',
        diagnosticId: DIAGNOSTIC_ID,
      },
    });
    handler?.({
      payload: {
        version: 1,
        authority: AUTHORITY,
        kind: 'transport_offline',
        diagnosticId: DIAGNOSTIC_ID,
        cause: 'private path',
      },
    });

    expect(listener).toHaveBeenCalledWith('sdk://connection', expect.any(Function));
    expect(received).toEqual([
      {
        version: 1,
        authority: AUTHORITY,
        kind: 'credential_revoked',
        diagnosticId: DIAGNOSTIC_ID,
      },
    ]);
  });
});
