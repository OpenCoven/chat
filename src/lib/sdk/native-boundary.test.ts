import { createConnectionController } from './connection-controller';
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
const DISCOVERY_HANDLE = 'discovery:00000000-0000-4000-8000-000000000002';
const REQUEST_ID = 'request:1';
const INSTANCE_ID = '00000000-0000-4000-8000-000000000003';
const PAIRING_ID = '00000000-0000-4000-8000-000000000004';
const DIAGNOSTIC_ID = '00000000-0000-4000-8000-000000000005';
const PUBLIC_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_ID = 'tDE1VahIyqtAoH7mJ7uT3yzaF6EnK70vG9JMvTMCOAM';

function discoveryRecord(replacement: Record<string, unknown> = {}) {
  return {
    version: 2,
    endpoint: 'http://localhost:3020/',
    pid: 10,
    nonce: PUBLIC_KEY,
    startedAt: '2026-08-28T10:00:00Z',
    authority: {
      mechanism: 'hpke-bound-v1',
      mode: 'enforce',
      keyId: KEY_ID,
      publicKey: PUBLIC_KEY,
      suite: { kemId: 32, kdfId: 1, aeadId: 2 },
    },
    ...replacement,
  };
}

function discoveryOutput(replacement: Record<string, unknown> = {}) {
  return {
    handle: DISCOVERY_HANDLE,
    snapshot: {
      bytes: JSON.stringify(discoveryRecord(replacement)),
      record: {
        identity: `sha256:${'a'.repeat(64)}`,
        device: 1,
        inode: 2,
        processAlive: true,
      },
    },
  };
}

function operation(input: Record<string, unknown>, result: unknown) {
  return {
    authority: input.authority,
    requestId: input.requestId,
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

function errorResponse(
  code: string,
  retryable: boolean,
  capabilities: string[],
  operations: string[],
  statusCode: number,
) {
  return {
    statusCode,
    payload: {
      apiVersion: '1.0',
      minimumClientVersion: '0.1.0',
      requestId: REQUEST_ID,
      capabilities,
      operations,
      error: {
        code,
        message: 'Cave operation failed.',
        retryable,
      },
    },
  };
}

function pairingId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function routedInvoke(
  routes: Partial<Record<(typeof NATIVE_COMMANDS)[keyof typeof NATIVE_COMMANDS], unknown>>,
): InvokeCommand {
  return vi.fn(async (command, args = {}) => {
    const route = routes[command as keyof typeof routes];
    if (route instanceof Function) {
      return route(args);
    }
    if (route !== undefined) {
      return route;
    }
    if (command === NATIVE_COMMANDS.authorityEstablish) {
      return AUTHORITY;
    }
    throw new Error(`Unexpected command ${command}`);
  });
}

describe('native boundary with packed managed SDK', () => {
  it('uses only reviewed discovery and operation-specific commands', () => {
    expect(NATIVE_COMMANDS).toEqual({
      discoveryRead: 'sdk_discovery_read',
      authorityEstablish: 'sdk_authority_establish',
      close: 'sdk_authority_close',
      installationIdentity: 'sdk_installation_identity',
      health: 'cave_health',
      pairingCreate: 'cave_managed_pairing_create',
      pairingPoll: 'cave_managed_pairing_poll',
      pairingExchange: 'cave_managed_pairing_exchange',
      credentialState: 'cave_credential_state',
      forgetCredential: 'cave_forget_credential',
      listFamiliars: 'cave_list_familiars',
      listProjects: 'cave_list_projects',
      listConversations: 'cave_list_conversations',
      getConversation: 'cave_get_conversation',
      listConversationMessages: 'cave_list_conversation_messages',
      diagnostics: 'sdk_native_diagnostics',
    });
    expect(Object.values(NATIVE_COMMANDS)).not.toContain('sdk_authority_open');
  });

  it('uses managed discovery before opaque authority establishment', async () => {
    const invokeCommand = routedInvoke({
      [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
    });
    const boundary = createNativeBoundary({
      invoke: invokeCommand,
      requestId: () => REQUEST_ID,
    });

    await expect(boundary.discover()).resolves.toEqual(AUTHORITY);
    expect(invokeCommand).toHaveBeenNthCalledWith(1, NATIVE_COMMANDS.discoveryRead, undefined);
    expect(invokeCommand).toHaveBeenNthCalledWith(2, NATIVE_COMMANDS.authorityEstablish, {
      input: { discoveryHandle: DISCOVERY_HANDLE },
    });
  });

  it('rejects hostile native envelopes without evaluating accessors', async () => {
    let getterRead = false;
    const hostile = Object.defineProperty(
      {
        handle: DISCOVERY_HANDLE,
        snapshot: discoveryOutput().snapshot,
        extra: true,
      },
      'credential',
      {
        enumerable: true,
        get() {
          getterRead = true;
          return 'private';
        },
      },
    );
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: hostile,
      }),
    });

    await expect(boundary.discover()).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(getterRead).toBe(false);
  });

  it('lets the packed SDK reject hostile discovery and canonical DTOs', async () => {
    const hostileDiscovery = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput({
          endpoint: 'https://example.com/',
        }),
      }),
      requestId: () => REQUEST_ID,
    });
    await expect(hostileDiscovery.discover()).rejects.toMatchObject({
      code: 'unsafe_endpoint',
    });

    const invokeCommand = routedInvoke({
      [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
      [NATIVE_COMMANDS.listConversations]: (args: Record<string, unknown>) =>
        operation(
          args.input as Record<string, unknown>,
          response(
            {
              conversations: [
                {
                  id: 'conversation-1',
                  familiarId: 'familiar-1',
                  updatedAt: 42,
                },
              ],
            },
            ['conversations', 'cursors'],
            ['conversations.list'],
          ),
        ),
    });
    const boundary = createNativeBoundary({
      invoke: invokeCommand,
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();

    await expect(
      boundary.listConversations(authority, 'ignored-by-sdk', { limit: 25 }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([401, 429, 500])(
    'rejects success-shaped canonical data carried by HTTP %i',
    async (statusCode) => {
      const boundary = createNativeBoundary({
        invoke: routedInvoke({
          [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
          [NATIVE_COMMANDS.listConversations]: (args: Record<string, unknown>) =>
            operation(
              args.input as Record<string, unknown>,
              response(
                { conversations: [] },
                ['conversations', 'cursors'],
                ['conversations.list'],
                statusCode,
              ),
            ),
        }),
        requestId: () => REQUEST_ID,
      });
      const authority = await boundary.discover();

      await expect(
        boundary.listConversations(authority, 'ignored', { limit: 25 }),
      ).rejects.toMatchObject({
        code: 'invalid_response',
        statusCode,
      });
    },
  );

  it('accepts canonical data carried by the expected success status', async () => {
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.listConversations]: (args: Record<string, unknown>) =>
          operation(
            args.input as Record<string, unknown>,
            response({ conversations: [] }, ['conversations', 'cursors'], ['conversations.list']),
          ),
      }),
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();

    await expect(boundary.listConversations(authority, 'ignored', { limit: 25 })).resolves.toEqual({
      data: [],
    });
  });

  it('preserves credential replacement contention when forgetting', async () => {
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.forgetCredential]: () => {
          throw {
            code: 'credential_update_in_progress',
            retryable: true,
            diagnosticId: DIAGNOSTIC_ID,
          };
        },
      }),
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();

    await expect(boundary.forgetCredential(authority, 'ignored')).rejects.toMatchObject({
      code: 'credential_update_in_progress',
      retryable: true,
    });
  });

  it('preserves retryable pre-mutation credential contention', async () => {
    const pairingCreate = vi.fn((args: Record<string, unknown>) =>
      operation(args.input as Record<string, unknown>, {
        requestId: PAIRING_ID,
        expiresAt: 2_000_000_000_000,
      }),
    );
    const exchange = vi
      .fn()
      .mockImplementationOnce(() => {
        throw {
          code: 'conflict',
          retryable: true,
          diagnosticId: DIAGNOSTIC_ID,
        };
      })
      .mockImplementationOnce((args: Record<string, unknown>) =>
        operation(args.input as Record<string, unknown>, {
          credential: {
            id: '00000000-0000-4000-8000-000000000006',
            appName: 'OpenCoven Chat',
            installationId: '00000000-0000-4000-8000-000000000007',
            scopes: ['chat:read'],
            createdAt: 1,
            lastUsedAt: null,
            revokedAt: null,
            revocationReason: null,
          },
        }),
      );
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.pairingCreate]: pairingCreate,
        [NATIVE_COMMANDS.pairingExchange]: exchange,
      }),
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();
    const pairing = await boundary.pairingCreate(authority, 'ignored', {
      appName: 'OpenCoven Chat',
      installationId: '00000000-0000-4000-8000-000000000007',
      scopes: ['chat:read'],
    });

    await expect(
      boundary.pairingExchange(authority, 'ignored', pairing.handle),
    ).rejects.toMatchObject({
      code: 'conflict',
      retryable: true,
    });
    await expect(
      boundary.pairingExchange(authority, 'ignored', pairing.handle),
    ).resolves.toMatchObject({
      credential: {
        id: '00000000-0000-4000-8000-000000000006',
      },
    });
    expect(exchange).toHaveBeenCalledTimes(2);
    expect(pairingCreate).toHaveBeenCalledOnce();
  });

  it('retries pre-mutation contention end to end without recreating native pairing', async () => {
    let healthCalls = 0;
    let credentialCalls = 0;
    const pairingCreate = vi.fn((args: Record<string, unknown>) =>
      operation(args.input as Record<string, unknown>, {
        requestId: PAIRING_ID,
        expiresAt: 2_000_000_000_000,
      }),
    );
    const pairingExchange = vi
      .fn()
      .mockImplementationOnce(() => {
        throw {
          code: 'conflict',
          retryable: true,
          diagnosticId: DIAGNOSTIC_ID,
        };
      })
      .mockImplementationOnce((args: Record<string, unknown>) =>
        operation(args.input as Record<string, unknown>, {
          credential: {
            id: '00000000-0000-4000-8000-000000000006',
            appName: 'OpenCoven Chat',
            installationId: '00000000-0000-4000-8000-000000000007',
            scopes: ['chat:read'],
            createdAt: 1,
            lastUsedAt: null,
            revokedAt: null,
            revocationReason: null,
          },
        }),
      );
    const boundary = createNativeBoundary({
      available: () => true,
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.installationIdentity]: {
          installationId: '00000000-0000-4000-8000-000000000007',
        },
        [NATIVE_COMMANDS.health]: (args: Record<string, unknown>) => {
          healthCalls += 1;
          return operation(
            args.input as Record<string, unknown>,
            response(
              {
                instanceId: INSTANCE_ID,
                pairingRequired: healthCalls === 1,
                releaseVersion: '0.1.0',
              },
              ['health'],
              ['health.read'],
            ),
          );
        },
        [NATIVE_COMMANDS.credentialState]: (args: Record<string, unknown>) => {
          credentialCalls += 1;
          return operation(args.input as Record<string, unknown>, {
            status: credentialCalls === 1 ? 'missing' : 'present',
          });
        },
        [NATIVE_COMMANDS.pairingCreate]: pairingCreate,
        [NATIVE_COMMANDS.pairingPoll]: (args: Record<string, unknown>) =>
          operation(args.input as Record<string, unknown>, {
            id: PAIRING_ID,
            status: 'approved',
            expiresAt: 2_000_000_000_000,
          }),
        [NATIVE_COMMANDS.pairingExchange]: pairingExchange,
      }),
      requestId: () => REQUEST_ID,
    });
    const controller = createConnectionController(boundary, {
      now: () => 1_000,
      requestId: () => REQUEST_ID,
    });

    await controller.connect();
    await controller.beginPairing();
    await controller.pollApproval();
    await controller.completePairing();
    expect(controller.canRetry()).toBe(true);

    await controller.retry();

    expect(controller.getState()).toEqual({
      state: 'ready',
      caveInstanceId: INSTANCE_ID,
      covenAvailable: false,
    });
    expect(pairingCreate).toHaveBeenCalledOnce();
    expect(pairingExchange).toHaveBeenCalledTimes(2);
  });

  it('rejects hostile error-status declarations without evaluating accessors', async () => {
    let getterRead = false;
    const capabilities: unknown[] = [];
    Object.defineProperty(capabilities, '0', {
      enumerable: true,
      get() {
        getterRead = true;
        return 'conversations';
      },
    });
    capabilities.length = 1;
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.listConversations]: (args: Record<string, unknown>) =>
          operation(args.input as Record<string, unknown>, {
            statusCode: 500,
            payload: {
              apiVersion: '1.0',
              minimumClientVersion: '0.1.0',
              requestId: REQUEST_ID,
              capabilities,
              operations: ['conversations.list'],
              error: {
                code: 'service_unavailable',
                message: 'Cave operation failed.',
                retryable: true,
              },
            },
          }),
      }),
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();

    await expect(
      boundary.listConversations(authority, 'ignored', { limit: 25 }),
    ).rejects.toMatchObject({ code: 'invalid_response', statusCode: 500 });
    expect(getterRead).toBe(false);
  });

  it('rejects an error envelope carried by a success status', async () => {
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.listConversations]: (args: Record<string, unknown>) =>
          operation(
            args.input as Record<string, unknown>,
            errorResponse(
              'unauthorized',
              false,
              ['conversations', 'cursors'],
              ['conversations.list'],
              200,
            ),
          ),
      }),
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();

    await expect(
      boundary.listConversations(authority, 'ignored', { limit: 25 }),
    ).rejects.toMatchObject({ code: 'invalid_response', statusCode: 200 });
  });

  it.each([
    [
      'both branches',
      {
        apiVersion: '1.0',
        minimumClientVersion: '0.1.0',
        requestId: REQUEST_ID,
        capabilities: ['conversations', 'cursors'],
        operations: ['conversations.list'],
        data: { conversations: [] },
        error: {
          code: 'unauthorized',
          message: 'Cave operation failed.',
          retryable: false,
        },
      },
    ],
    [
      'neither branch',
      {
        apiVersion: '1.0',
        minimumClientVersion: '0.1.0',
        requestId: REQUEST_ID,
        capabilities: ['conversations', 'cursors'],
        operations: ['conversations.list'],
      },
    ],
    [
      'an explicit undefined error branch',
      {
        apiVersion: '1.0',
        minimumClientVersion: '0.1.0',
        requestId: REQUEST_ID,
        capabilities: ['conversations', 'cursors'],
        operations: ['conversations.list'],
        data: { conversations: [] },
        error: undefined,
      },
    ],
  ])('rejects a success status with %s', async (_description, payload) => {
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.listConversations]: (args: Record<string, unknown>) =>
          operation(args.input as Record<string, unknown>, {
            statusCode: 200,
            payload,
          }),
      }),
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();

    await expect(
      boundary.listConversations(authority, 'ignored', { limit: 25 }),
    ).rejects.toMatchObject({ code: 'invalid_response', statusCode: 200 });
  });

  it.each([
    [
      'data only',
      {
        apiVersion: '1.0',
        minimumClientVersion: '0.1.0',
        requestId: REQUEST_ID,
        capabilities: ['conversations', 'cursors'],
        operations: ['conversations.list'],
        data: { conversations: [] },
      },
    ],
    [
      'both branches',
      {
        apiVersion: '1.0',
        minimumClientVersion: '0.1.0',
        requestId: REQUEST_ID,
        capabilities: ['conversations', 'cursors'],
        operations: ['conversations.list'],
        data: { conversations: [] },
        error: {
          code: 'service_unavailable',
          message: 'Cave operation failed.',
          retryable: true,
        },
      },
    ],
    [
      'neither branch',
      {
        apiVersion: '1.0',
        minimumClientVersion: '0.1.0',
        requestId: REQUEST_ID,
        capabilities: ['conversations', 'cursors'],
        operations: ['conversations.list'],
      },
    ],
    [
      'an explicit undefined data branch',
      {
        apiVersion: '1.0',
        minimumClientVersion: '0.1.0',
        requestId: REQUEST_ID,
        capabilities: ['conversations', 'cursors'],
        operations: ['conversations.list'],
        data: undefined,
        error: {
          code: 'service_unavailable',
          message: 'Cave operation failed.',
          retryable: true,
        },
      },
    ],
  ])('rejects an error status with %s', async (_description, payload) => {
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.listConversations]: (args: Record<string, unknown>) =>
          operation(args.input as Record<string, unknown>, {
            statusCode: 500,
            payload,
          }),
      }),
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();

    await expect(
      boundary.listConversations(authority, 'ignored', { limit: 25 }),
    ).rejects.toMatchObject({ code: 'invalid_response', statusCode: 500 });
  });

  it.each([
    [401, 'unauthorized', false],
    [429, 'rate_limited', true],
    [500, 'service_unavailable', true],
    [409, 'reconcile_required', false],
    [400, 'incompatible_version', false],
  ] as const)('preserves HTTP %i canonical %s failures', async (statusCode, code, retryable) => {
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.listConversations]: (args: Record<string, unknown>) =>
          operation(
            args.input as Record<string, unknown>,
            errorResponse(
              code,
              retryable,
              ['conversations', 'cursors'],
              ['conversations.list'],
              statusCode,
            ),
          ),
      }),
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();

    await expect(
      boundary.listConversations(authority, 'ignored', { limit: 25 }),
    ).rejects.toMatchObject({
      code,
      retryable,
      statusCode,
    });
  });

  it.each([
    'wrong app',
    'wrong installation',
    'missing chat:read',
    'unrequested privileged scope',
    'revoked credential',
  ])('propagates native rejection for %s metadata without a credential result', async () => {
    const exchange = vi.fn(() => {
      throw {
        code: 'invalid_response',
        retryable: false,
        diagnosticId: DIAGNOSTIC_ID,
      };
    });
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.pairingCreate]: (args: Record<string, unknown>) =>
          operation(args.input as Record<string, unknown>, {
            requestId: PAIRING_ID,
            expiresAt: 2_000_000_000_000,
          }),
        [NATIVE_COMMANDS.pairingExchange]: exchange,
      }),
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();
    const pairing = await boundary.pairingCreate(authority, 'ignored', {
      appName: 'OpenCoven Chat',
      installationId: '00000000-0000-4000-8000-000000000007',
      scopes: ['chat:read'],
    });

    await expect(
      boundary.pairingExchange(authority, 'ignored', pairing.handle),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(exchange).toHaveBeenCalledOnce();
  });

  it('orchestrates health and pairing through the managed client without secret returns', async () => {
    const invokeCommand = routedInvoke({
      [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
      [NATIVE_COMMANDS.health]: (args: Record<string, unknown>) =>
        operation(
          args.input as Record<string, unknown>,
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
      [NATIVE_COMMANDS.pairingCreate]: (args: Record<string, unknown>) =>
        operation(args.input as Record<string, unknown>, {
          requestId: PAIRING_ID,
          expiresAt: 2_000_000_000_000,
        }),
      [NATIVE_COMMANDS.pairingPoll]: (args: Record<string, unknown>) =>
        operation(args.input as Record<string, unknown>, {
          id: PAIRING_ID,
          status: 'approved',
          expiresAt: 2_000_000_000_000,
        }),
      [NATIVE_COMMANDS.pairingExchange]: (args: Record<string, unknown>) =>
        operation(args.input as Record<string, unknown>, {
          credential: {
            id: '00000000-0000-4000-8000-000000000006',
            appName: 'OpenCoven Chat',
            installationId: '00000000-0000-4000-8000-000000000007',
            scopes: ['chat:read'],
            createdAt: 1,
            lastUsedAt: null,
            revokedAt: null,
            revocationReason: null,
          },
        }),
    });
    const boundary = createNativeBoundary({
      invoke: invokeCommand,
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();

    await expect(boundary.health(authority, 'ignored')).resolves.toMatchObject({
      status: 'ok',
      instanceId: INSTANCE_ID,
    });
    const pairing = await boundary.pairingCreate(authority, 'ignored', {
      appName: 'OpenCoven Chat',
      installationId: '00000000-0000-4000-8000-000000000007',
      scopes: ['chat:read'],
    });
    await expect(boundary.pairingPoll(authority, 'ignored', pairing.handle)).resolves.toEqual({
      id: PAIRING_ID,
      status: 'approved',
      expiresAt: 2_000_000_000_000,
    });
    await expect(
      boundary.pairingExchange(authority, 'ignored', pairing.handle),
    ).resolves.toMatchObject({
      credential: {
        id: '00000000-0000-4000-8000-000000000006',
        scopes: ['chat:read'],
      },
    });
    expect(JSON.stringify((invokeCommand as ReturnType<typeof vi.fn>).mock.results)).not.toMatch(
      /pairingSecret|Bearer\s+[A-Za-z0-9_-]+/u,
    );
  });

  it('retains a managed pairing after local poll contention and exchanges after the poll ends', async () => {
    const polled = deferred<unknown>();
    const pairingExchange = vi.fn((args: Record<string, unknown>) =>
      operation(args.input as Record<string, unknown>, {
        credential: {
          id: '00000000-0000-4000-8000-000000000006',
          appName: 'OpenCoven Chat',
          installationId: '00000000-0000-4000-8000-000000000007',
          scopes: ['chat:read'],
          createdAt: 1,
          lastUsedAt: null,
          revokedAt: null,
          revocationReason: null,
        },
      }),
    );
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.pairingCreate]: (args: Record<string, unknown>) =>
          operation(args.input as Record<string, unknown>, {
            requestId: PAIRING_ID,
            expiresAt: 2_000_000_000_000,
          }),
        [NATIVE_COMMANDS.pairingPoll]: () => polled.promise,
        [NATIVE_COMMANDS.pairingExchange]: pairingExchange,
      }),
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();
    const pairing = await boundary.pairingCreate(authority, 'ignored', {
      appName: 'OpenCoven Chat',
      installationId: '00000000-0000-4000-8000-000000000007',
      scopes: ['chat:read'],
    });

    const pendingPoll = boundary.pairingPoll(authority, 'ignored', pairing.handle);
    await Promise.resolve();
    await expect(
      boundary.pairingExchange(authority, 'ignored', pairing.handle),
    ).rejects.toMatchObject({ code: 'operation_in_progress' });
    expect(pairingExchange).not.toHaveBeenCalled();

    polled.resolve(
      operation(
        {
          authority,
          requestId: REQUEST_ID,
        },
        {
          id: PAIRING_ID,
          status: 'approved',
          expiresAt: 2_000_000_000_000,
        },
      ),
    );
    await expect(pendingPoll).resolves.toMatchObject({ status: 'approved' });
    await expect(
      boundary.pairingExchange(authority, 'ignored', pairing.handle),
    ).resolves.toMatchObject({
      credential: {
        id: '00000000-0000-4000-8000-000000000006',
      },
    });
    expect(pairingExchange).toHaveBeenCalledOnce();
  });

  it.each(['denied', 'expired'] as const)(
    'consumes terminal managed pairing sessions after %s status',
    async (status) => {
      const pairingPoll = vi.fn((args: Record<string, unknown>) =>
        operation(args.input as Record<string, unknown>, {
          id: PAIRING_ID,
          status,
          expiresAt: 2_000_000_000_000,
        }),
      );
      const boundary = createNativeBoundary({
        invoke: routedInvoke({
          [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
          [NATIVE_COMMANDS.pairingCreate]: (args: Record<string, unknown>) =>
            operation(args.input as Record<string, unknown>, {
              requestId: PAIRING_ID,
              expiresAt: 2_000_000_000_000,
            }),
          [NATIVE_COMMANDS.pairingPoll]: pairingPoll,
        }),
        requestId: () => REQUEST_ID,
      });
      const authority = await boundary.discover();
      const pairing = await boundary.pairingCreate(authority, 'ignored', {
        appName: 'OpenCoven Chat',
        installationId: '00000000-0000-4000-8000-000000000007',
        scopes: ['chat:read'],
      });

      await expect(
        boundary.pairingPoll(authority, 'ignored', pairing.handle),
      ).resolves.toMatchObject({
        status,
      });
      await expect(
        boundary.pairingPoll(authority, 'ignored', pairing.handle),
      ).rejects.toMatchObject({
        code: 'reconcile_required',
      });
      expect(pairingPoll).toHaveBeenCalledOnce();
    },
  );

  it('rejects a pairing created after its authority was closed during the await', async () => {
    const created = deferred<unknown>();
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.pairingCreate]: () => created.promise,
        [NATIVE_COMMANDS.close]: {
          closed: true,
        },
      }),
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();
    const pendingCreate = boundary.pairingCreate(authority, 'ignored', {
      appName: 'OpenCoven Chat',
      installationId: '00000000-0000-4000-8000-000000000007',
      scopes: ['chat:read'],
    });
    await Promise.resolve();

    await expect(boundary.close(authority)).resolves.toBe(true);
    created.resolve(
      operation(
        {
          authority,
          requestId: REQUEST_ID,
        },
        {
          requestId: PAIRING_ID,
          expiresAt: 2_000_000_000_000,
        },
      ),
    );

    await expect(pendingCreate).rejects.toMatchObject({
      code: 'reconcile_required',
    });
  });

  it('prunes expired sessions and bounds retained managed pairings', async () => {
    let nextPairing = 0;
    const pairingPoll = vi.fn((args: Record<string, unknown>) => {
      const input = args.input as Record<string, unknown>;
      return operation(input, {
        id: input.pairingRequestId,
        status: 'approved',
        expiresAt: 2_000_000_000_000,
      });
    });
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.pairingCreate]: (args: Record<string, unknown>) => {
          nextPairing += 1;
          return operation(args.input as Record<string, unknown>, {
            requestId: pairingId(nextPairing),
            expiresAt: nextPairing === 1 ? 1 : 2_000_000_000_000,
          });
        },
        [NATIVE_COMMANDS.pairingPoll]: pairingPoll,
      }),
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();
    const sessions = [];
    for (let index = 0; index < 65; index += 1) {
      sessions.push(
        await boundary.pairingCreate(authority, 'ignored', {
          appName: 'OpenCoven Chat',
          installationId: '00000000-0000-4000-8000-000000000007',
          scopes: ['chat:read'],
        }),
      );
    }
    await expect(
      boundary.pairingCreate(authority, 'ignored', {
        appName: 'OpenCoven Chat',
        installationId: '00000000-0000-4000-8000-000000000007',
        scopes: ['chat:read'],
      }),
    ).rejects.toMatchObject({ code: 'operation_in_progress' });
    expect(nextPairing).toBe(65);

    await expect(
      boundary.pairingPoll(authority, 'ignored', sessions[0]?.handle ?? ''),
    ).rejects.toMatchObject({ code: 'reconcile_required' });
    await expect(
      boundary.pairingPoll(authority, 'ignored', sessions[1]?.handle ?? ''),
    ).resolves.toMatchObject({ status: 'approved' });
    expect(pairingPoll).toHaveBeenCalledOnce();
  });

  it('rejects managed pairing creation pressure without evicting an active poll', async () => {
    let nextPairing = 0;
    const polled = deferred<unknown>();
    const pairingExchange = vi.fn((args: Record<string, unknown>) =>
      operation(args.input as Record<string, unknown>, {
        credential: {
          id: '00000000-0000-4000-8000-000000000006',
          appName: 'OpenCoven Chat',
          installationId: '00000000-0000-4000-8000-000000000007',
          scopes: ['chat:read'],
          createdAt: 1,
          lastUsedAt: null,
          revokedAt: null,
          revocationReason: null,
        },
      }),
    );
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.pairingCreate]: (args: Record<string, unknown>) => {
          nextPairing += 1;
          return operation(args.input as Record<string, unknown>, {
            requestId: pairingId(nextPairing),
            expiresAt: 2_000_000_000_000,
          });
        },
        [NATIVE_COMMANDS.pairingPoll]: () => polled.promise,
        [NATIVE_COMMANDS.pairingExchange]: pairingExchange,
      }),
      requestId: () => REQUEST_ID,
    });
    const authority = await boundary.discover();
    const sessions = [];
    for (let index = 0; index < 64; index += 1) {
      sessions.push(
        await boundary.pairingCreate(authority, 'ignored', {
          appName: 'OpenCoven Chat',
          installationId: '00000000-0000-4000-8000-000000000007',
          scopes: ['chat:read'],
        }),
      );
    }
    const active = sessions[0];
    if (active === undefined) {
      throw new Error('Expected an active pairing fixture.');
    }
    const pendingPoll = boundary.pairingPoll(authority, 'ignored', active.handle);
    await Promise.resolve();

    await expect(
      boundary.pairingCreate(authority, 'ignored', {
        appName: 'OpenCoven Chat',
        installationId: '00000000-0000-4000-8000-000000000007',
        scopes: ['chat:read'],
      }),
    ).rejects.toMatchObject({ code: 'operation_in_progress' });
    expect(nextPairing).toBe(64);

    polled.resolve(
      operation(
        {
          authority,
          requestId: REQUEST_ID,
        },
        {
          id: active.requestId,
          status: 'approved',
          expiresAt: 2_000_000_000_000,
        },
      ),
    );
    await expect(pendingPoll).resolves.toMatchObject({ status: 'approved' });
    await expect(
      boundary.pairingExchange(authority, 'ignored', active.handle),
    ).resolves.toMatchObject({
      credential: {
        id: '00000000-0000-4000-8000-000000000006',
      },
    });
    expect(pairingExchange).toHaveBeenCalledOnce();
  });

  it('maps only exact native error objects into presentation-safe errors', async () => {
    const boundary = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.authorityEstablish]: () => {
          throw {
            code: 'service_unavailable',
            retryable: true,
            diagnosticId: DIAGNOSTIC_ID,
          };
        },
      }),
    });

    await expect(boundary.discover()).rejects.toEqual(
      new NativeBoundaryError('service_unavailable', true, DIAGNOSTIC_ID),
    );

    const hostile = createNativeBoundary({
      invoke: routedInvoke({
        [NATIVE_COMMANDS.discoveryRead]: discoveryOutput(),
        [NATIVE_COMMANDS.authorityEstablish]: () => {
          throw {
            code: 'service_unavailable',
            retryable: true,
            diagnosticId: DIAGNOSTIC_ID,
            cause: '/Users/person/private/credential',
          };
        },
      }),
    });
    await expect(hostile.discover()).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
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
