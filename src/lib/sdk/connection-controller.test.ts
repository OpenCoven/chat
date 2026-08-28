import { createConnectionController, type SdkConnectionState } from './connection-controller';
import {
  type AuthorityReference,
  type NativeBoundary,
  NativeBoundaryError,
} from './native-boundary';

const AUTHORITY: AuthorityReference = {
  handle: 'authority:00000000-0000-4000-8000-000000000001',
  generation: 1,
};
const NEXT_AUTHORITY: AuthorityReference = {
  handle: 'authority:00000000-0000-4000-8000-000000000002',
  generation: 2,
};
const INSTANCE_ID = '00000000-0000-4000-8000-000000000010';
const NEXT_INSTANCE_ID = '00000000-0000-4000-8000-000000000011';
const DIAGNOSTIC_ID = '00000000-0000-4000-8000-000000000012';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeBoundary(overrides: Partial<NativeBoundary> = {}): NativeBoundary {
  return {
    isAvailable: () => true,
    discover: vi.fn().mockResolvedValue(AUTHORITY),
    close: vi.fn().mockResolvedValue(true),
    installationIdentity: vi.fn().mockResolvedValue({
      installationId: '00000000-0000-4000-8000-000000000020',
    }),
    health: vi.fn().mockResolvedValue({
      status: 'ok',
      apiVersion: '1.0',
      minimumClientVersion: '0.1.0',
      capabilities: ['health'],
      operations: ['health.read'],
      instanceId: INSTANCE_ID,
      pairingRequired: false,
      releaseVersion: '0.1.0',
    }),
    pairingCreate: vi.fn().mockResolvedValue({
      handle: 'pairing:00000000-0000-4000-8000-000000000030',
      requestId: '00000000-0000-4000-8000-000000000031',
      expiresAt: 10_000,
    }),
    pairingPoll: vi.fn().mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000031',
      status: 'pending',
      expiresAt: 10_000,
    }),
    pairingExchange: vi.fn().mockResolvedValue({
      commitHandle: 'commit:00000000-0000-4000-8000-000000000032',
      credential: {
        id: '00000000-0000-4000-8000-000000000033',
        appName: 'OpenCoven Chat',
        installationId: '00000000-0000-4000-8000-000000000020',
        scopes: ['chat:read'],
        createdAt: 1,
        lastUsedAt: null,
        revokedAt: null,
        revocationReason: null,
      },
    }),
    pairingCommit: vi.fn().mockResolvedValue(undefined),
    pairingDiscard: vi.fn().mockResolvedValue('absent'),
    credentialState: vi.fn().mockResolvedValue('present'),
    forgetCredential: vi.fn().mockResolvedValue(true),
    listFamiliars: vi.fn(),
    listProjects: vi.fn(),
    listConversations: vi.fn(),
    getConversation: vi.fn(),
    listConversationMessages: vi.fn(),
    diagnostics: vi.fn().mockResolvedValue({
      version: 1,
      platform: 'macos',
      architecture: 'aarch64',
      checks: [],
    }),
    listenConnectionEvents: vi.fn().mockResolvedValue(vi.fn()),
    ...overrides,
  };
}

async function expectState(
  controller: ReturnType<typeof createConnectionController>,
  expected: SdkConnectionState,
) {
  expect(controller.getState()).toEqual(expected);
}

describe('connection controller', () => {
  it('shares duplicate StrictMode bootstrap and event activation work', async () => {
    const discovery = deferred<AuthorityReference>();
    const boundary = makeBoundary({
      discover: vi.fn().mockReturnValue(discovery.promise),
    });
    const controller = createConnectionController(boundary, {
      requestId: (() => {
        let next = 0;
        return () => `request:${++next}`;
      })(),
    });

    const releaseFirst = controller.activate();
    const first = controller.bootstrap();
    releaseFirst();
    const releaseSecond = controller.activate();
    const second = controller.bootstrap();

    expect(boundary.discover).toHaveBeenCalledTimes(1);
    expect(boundary.listenConnectionEvents).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);

    discovery.resolve(AUTHORITY);
    await Promise.all([first, second]);
    releaseSecond();
    await Promise.resolve();
  });

  it('walks the successful discovery, pairing, and completion states', async () => {
    const boundary = makeBoundary({
      health: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'ok',
          apiVersion: '1.0',
          minimumClientVersion: '0.1.0',
          capabilities: ['health'],
          operations: ['health.read'],
          instanceId: INSTANCE_ID,
          pairingRequired: true,
          releaseVersion: '0.1.0',
        })
        .mockResolvedValue({
          status: 'ok',
          apiVersion: '1.0',
          minimumClientVersion: '0.1.0',
          capabilities: ['health'],
          operations: ['health.read'],
          instanceId: INSTANCE_ID,
          pairingRequired: false,
          releaseVersion: '0.1.0',
        }),
      credentialState: vi.fn().mockResolvedValueOnce('missing').mockResolvedValue('present'),
      pairingPoll: vi.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000031',
        status: 'approved',
        expiresAt: 10_000,
      }),
    });
    const controller = createConnectionController(boundary, {
      now: () => 1_000,
      requestId: () => 'request:1',
    });

    await controller.connect();
    await expectState(controller, { state: 'pairing_required', caveInstanceId: INSTANCE_ID });

    await controller.beginPairing();
    await expectState(controller, {
      state: 'pairing',
      requestId: '00000000-0000-4000-8000-000000000031',
      expiresAt: 10_000,
    });

    await controller.pollApproval();
    expect(controller.canCompletePairing()).toBe(true);

    await controller.completePairing();
    await expectState(controller, {
      state: 'ready',
      caveInstanceId: INSTANCE_ID,
      covenAvailable: false,
    });
    expect(boundary.pairingExchange).toHaveBeenCalledTimes(1);
    expect(boundary.pairingCommit).toHaveBeenCalledTimes(1);
  });

  it('shares duplicate persistent pairing mutations', async () => {
    const created = deferred<{
      handle: string;
      requestId: string;
      expiresAt: number;
    }>();
    const boundary = makeBoundary({
      health: vi.fn().mockResolvedValue({
        status: 'ok',
        apiVersion: '1.0',
        minimumClientVersion: '0.1.0',
        capabilities: ['health'],
        operations: ['health.read'],
        instanceId: INSTANCE_ID,
        pairingRequired: true,
        releaseVersion: '0.1.0',
      }),
      credentialState: vi.fn().mockResolvedValue('missing'),
      pairingCreate: vi.fn().mockReturnValue(created.promise),
    });
    const controller = createConnectionController(boundary, {
      requestId: () => 'request:1',
    });
    await controller.connect();

    const first = controller.beginPairing();
    const second = controller.beginPairing();

    expect(first).toBe(second);
    await Promise.resolve();
    expect(boundary.pairingCreate).toHaveBeenCalledTimes(1);

    created.resolve({
      handle: 'pairing:00000000-0000-4000-8000-000000000030',
      requestId: '00000000-0000-4000-8000-000000000031',
      expiresAt: 10_000,
    });
    await Promise.all([first, second]);
  });

  it.each([
    ['incompatible_version', 'incompatible'],
    ['secure_store_unavailable', 'error'],
    ['platform_security_unavailable', 'error'],
    ['service_unavailable', 'offline'],
    ['timeout', 'offline'],
  ] as const)('maps %s discovery failures to %s', async (code, expectedState) => {
    const boundary = makeBoundary({
      discover: vi
        .fn()
        .mockRejectedValue(
          new NativeBoundaryError(code, code === 'service_unavailable', DIAGNOSTIC_ID),
        ),
    });
    const controller = createConnectionController(boundary);

    await controller.connect();

    expect(controller.getState().state).toBe(expectedState);
    expect(JSON.stringify(controller.getState())).not.toMatch(
      /bearer|pairingSecret|private|\/Users\//iu,
    );
  });

  it.each([
    ['denied', 'pairing_denied'],
    ['expired', 'pairing_expired'],
  ] as const)('maps pairing %s to a safe terminal error', async (status, code) => {
    const boundary = makeBoundary({
      health: vi.fn().mockResolvedValue({
        status: 'ok',
        apiVersion: '1.0',
        minimumClientVersion: '0.1.0',
        capabilities: ['health'],
        operations: ['health.read'],
        instanceId: INSTANCE_ID,
        pairingRequired: true,
        releaseVersion: '0.1.0',
      }),
      credentialState: vi.fn().mockResolvedValue('missing'),
      pairingPoll: vi.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000031',
        status,
        expiresAt: 10_000,
      }),
    });
    const controller = createConnectionController(boundary, {
      now: () => 1_000,
      requestId: () => 'request:1',
    });

    await controller.connect();
    await controller.beginPairing();
    await controller.pollApproval();

    expect(controller.getState()).toEqual({
      state: 'error',
      code,
      diagnosticId: 'pairing-status',
    });
  });

  it('surfaces pairing rate limits without replaying creation', async () => {
    const boundary = makeBoundary({
      health: vi.fn().mockResolvedValue({
        status: 'ok',
        apiVersion: '1.0',
        minimumClientVersion: '0.1.0',
        capabilities: ['health'],
        operations: ['health.read'],
        instanceId: INSTANCE_ID,
        pairingRequired: true,
        releaseVersion: '0.1.0',
      }),
      credentialState: vi.fn().mockResolvedValue('missing'),
      pairingCreate: vi
        .fn()
        .mockRejectedValue(new NativeBoundaryError('rate_limited', true, DIAGNOSTIC_ID)),
    });
    const controller = createConnectionController(boundary, {
      requestId: () => 'request:1',
    });

    await controller.connect();
    await controller.beginPairing();
    await controller.retry();

    expect(controller.getState()).toEqual({
      state: 'error',
      code: 'rate_limited',
      diagnosticId: DIAGNOSTIC_ID,
    });
    expect(boundary.pairingCreate).toHaveBeenCalledTimes(1);
    expect(controller.canRetry()).toBe(false);
  });

  it('never auto-replays an ambiguously failed pairing exchange', async () => {
    const boundary = makeBoundary({
      health: vi.fn().mockResolvedValue({
        status: 'ok',
        apiVersion: '1.0',
        minimumClientVersion: '0.1.0',
        capabilities: ['health'],
        operations: ['health.read'],
        instanceId: INSTANCE_ID,
        pairingRequired: true,
        releaseVersion: '0.1.0',
      }),
      credentialState: vi.fn().mockResolvedValue('missing'),
      pairingPoll: vi.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000031',
        status: 'approved',
        expiresAt: 10_000,
      }),
      pairingExchange: vi
        .fn()
        .mockRejectedValue(new NativeBoundaryError('service_unavailable', true, DIAGNOSTIC_ID)),
    });
    const controller = createConnectionController(boundary, {
      now: () => 1_000,
      requestId: () => 'request:1',
    });

    await controller.connect();
    await controller.beginPairing();
    await controller.pollApproval();
    await controller.completePairing();
    await controller.retry();

    expect(boundary.pairingExchange).toHaveBeenCalledTimes(1);
    expect(controller.canRetry()).toBe(false);
  });

  it('retries only the exact commit after a safe pre-send commit failure', async () => {
    const commit = vi
      .fn()
      .mockRejectedValueOnce(
        new NativeBoundaryError('credential_update_in_progress', true, DIAGNOSTIC_ID),
      )
      .mockResolvedValue(undefined);
    const boundary = makeBoundary({
      health: vi.fn().mockResolvedValue({
        status: 'ok',
        apiVersion: '1.0',
        minimumClientVersion: '0.1.0',
        capabilities: ['health'],
        operations: ['health.read'],
        instanceId: INSTANCE_ID,
        pairingRequired: true,
        releaseVersion: '0.1.0',
      }),
      credentialState: vi.fn().mockResolvedValueOnce('missing').mockResolvedValue('present'),
      pairingPoll: vi.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000031',
        status: 'approved',
        expiresAt: 10_000,
      }),
      pairingCommit: commit,
    });
    const controller = createConnectionController(boundary, {
      now: () => 1_000,
      requestId: () => 'request:1',
    });

    await controller.connect();
    await controller.beginPairing();
    await controller.pollApproval();
    await controller.completePairing();
    expect(controller.canRetry()).toBe(true);

    await controller.retry();

    expect(boundary.pairingExchange).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(controller.getState().state).toBe('ready');
  });

  it('handles revoke, offline, wrong-instance, and local forget without secrets', async () => {
    let event:
      | ((event: {
          version: 1;
          authority: AuthorityReference;
          kind: 'credential_revoked' | 'transport_offline' | 'authority_replaced';
          diagnosticId: string;
        }) => void)
      | undefined;
    const boundary = makeBoundary({
      discover: vi.fn().mockResolvedValueOnce(AUTHORITY).mockResolvedValue(NEXT_AUTHORITY),
      health: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'ok',
          apiVersion: '1.0',
          minimumClientVersion: '0.1.0',
          capabilities: ['health'],
          operations: ['health.read'],
          instanceId: INSTANCE_ID,
          pairingRequired: false,
          releaseVersion: '0.1.0',
        })
        .mockResolvedValue({
          status: 'ok',
          apiVersion: '1.0',
          minimumClientVersion: '0.1.0',
          capabilities: ['health'],
          operations: ['health.read'],
          instanceId: NEXT_INSTANCE_ID,
          pairingRequired: false,
          releaseVersion: '0.1.0',
        }),
      listenConnectionEvents: vi.fn().mockImplementation(async (listener) => {
        event = listener;
        return vi.fn();
      }),
    });
    const controller = createConnectionController(boundary, {
      now: () => 4_000,
      requestId: () => 'request:1',
    });
    controller.activate();
    await controller.connect();

    event?.({
      version: 1,
      authority: AUTHORITY,
      kind: 'transport_offline',
      diagnosticId: DIAGNOSTIC_ID,
    });
    expect(controller.getState()).toEqual({
      state: 'offline',
      lastHealthyAt: 4_000,
      diagnosticId: DIAGNOSTIC_ID,
    });

    await controller.reconnect();
    expect(controller.getState()).toEqual({
      state: 'error',
      code: 'wrong_instance',
      diagnosticId: 'instance-changed',
    });

    event?.({
      version: 1,
      authority: NEXT_AUTHORITY,
      kind: 'credential_revoked',
      diagnosticId: DIAGNOSTIC_ID,
    });
    expect(controller.getState()).toEqual({
      state: 'revoked',
      diagnosticId: DIAGNOSTIC_ID,
    });

    await controller.forgetCredential();
    expect(controller.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: NEXT_INSTANCE_ID,
    });
  });
});
