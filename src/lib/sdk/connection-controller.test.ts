import { inspect } from 'node:util';

import type {
  CaveCredentialStatus,
  CaveHealth,
  CavePairingRequest,
  CavePairingScope,
  CavePairingState,
} from '@opencoven/cave-client/managed';
import { CaveClientError } from '@opencoven/cave-client/managed';
import { describe, expect, it, vi } from 'vitest';

import {
  type CaveConnectionClient,
  type CaveConnectionHostPort,
  type CavePairingSessionPort,
  createCaveConnectionController,
} from './connection-controller';

const CAVE_INSTANCE_ID = '00000000-0000-4000-8000-000000000000';
const NEXT_CAVE_INSTANCE_ID = '00000000-0000-4000-8000-000000000002';
const INSTALLATION_ID = '00000000-0000-4000-8000-000000000001';

function health(instanceId = CAVE_INSTANCE_ID): CaveHealth {
  return Object.freeze({
    status: 'ok',
    apiVersion: '1.0',
    minimumClientVersion: '0.1.0',
    capabilities: Object.freeze([]),
    operations: Object.freeze([]),
    instanceId,
    pairingRequired: false,
    releaseVersion: '0.1.0',
  });
}

function validStatus(
  access: Extract<CaveCredentialStatus, { status: 'valid' }>['access'] = 'chat:read',
  instanceId = CAVE_INSTANCE_ID,
): CaveCredentialStatus {
  return Object.freeze({
    status: 'valid',
    access,
    health: health(instanceId),
  });
}

function caveError(code: string, retryable: boolean): CaveClientError {
  return new CaveClientError({
    system: 'cave',
    operation: 'test',
    code,
    retryable,
  });
}

function pairingSession(
  poll: () => Promise<CavePairingState>,
  exchange: () => Promise<void> = async () => undefined,
): CavePairingSessionPort {
  const scopes: CavePairingScope[] = ['chat:read'];

  return Object.freeze({
    requestId: '00000000-0000-4000-8000-000000000003',
    expiresAt: 2_000,
    poll: async () => ({
      id: '00000000-0000-4000-8000-000000000003',
      status: await poll(),
      expiresAt: 2_000,
    }),
    exchange: async () => {
      await exchange();
      return {
        id: '00000000-0000-4000-8000-000000000004',
        appName: 'OpenCoven Chat',
        installationId: INSTALLATION_ID,
        scopes,
        createdAt: 1,
        lastUsedAt: null,
        revokedAt: null,
        revocationReason: null,
      };
    },
  });
}

function client(overrides: Partial<CaveConnectionClient> = {}): CaveConnectionClient {
  return Object.freeze({
    health: async () => health(),
    credentialStatus: async () => validStatus(),
    createPairing: async () => pairingSession(async () => 'pending'),
    forgetCredential: async () => true,
    ...overrides,
  });
}

function host(
  discovered: CaveConnectionClient | Promise<CaveConnectionClient>,
): CaveConnectionHostPort {
  return Object.freeze({
    discover: async () => ({ client: await discovered }),
    launch: async () => undefined,
  });
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return Object.freeze({
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
    reject(reason) {
      rejectPromise?.(reason);
    },
  });
}

function clock(initial = 1_000) {
  let time = initial;
  const sleepers: Array<{ resolve: () => void }> = [];

  return Object.freeze({
    now: () => time,
    sleep: (_milliseconds: number) =>
      new Promise<void>((resolve) => {
        sleepers.push({ resolve });
      }),
    advance(milliseconds: number) {
      time += milliseconds;
      for (const sleeper of sleepers.splice(0)) {
        sleeper.resolve();
      }
    },
    pendingSleeps: () => sleepers.length,
  });
}

function controller(caveHost: CaveConnectionHostPort, testClock = clock(), pollIntervalMs = 10) {
  return createCaveConnectionController({
    host: caveHost,
    pairingIdentity: {
      appName: 'OpenCoven Chat',
      installationId: INSTALLATION_ID,
    },
    now: testClock.now,
    sleep: testClock.sleep,
    pollIntervalMs,
  });
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Cave connection controller', () => {
  it('classifies unavailable authority as offline and never launches implicitly', async () => {
    const discover = vi
      .fn<() => Promise<Readonly<{ client: CaveConnectionClient }>>>()
      .mockRejectedValue(new Error('native authority unavailable'));
    const launch = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const caveHost = Object.freeze({ discover, launch });
    const subject = controller(caveHost);

    await subject.start();

    expect(subject.getState()).toMatchObject({ state: 'offline', lastHealthyAt: null });
    expect(launch).not.toHaveBeenCalled();
    await subject.launch();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('classifies SDK compatibility failures as incompatible', async () => {
    const subject = controller(
      host(
        client({
          health: async () => {
            throw caveError('incompatible_version', false);
          },
        }),
      ),
    );

    await subject.start();

    expect(subject.getState().state).toBe('incompatible');
  });

  it('requires pairing when no managed credential exists', async () => {
    const subject = controller(
      host(
        client({
          credentialStatus: async () => ({ status: 'missing' }),
        }),
      ),
    );

    await subject.start();

    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });
  });

  it('publishes ready only for the SDK normalized read-only access status', async () => {
    const subject = controller(host(client()));

    await subject.start();

    expect(subject.getState()).toEqual({
      state: 'ready',
      caveInstanceId: CAVE_INSTANCE_ID,
      covenAvailable: false,
    });
  });

  it('publishes scope denial as an error rather than pairing again', async () => {
    const subject = controller(
      host(
        client({
          credentialStatus: async () => validStatus('scope_denied'),
        }),
      ),
    );

    await subject.start();

    expect(subject.getState()).toMatchObject({ state: 'error', code: 'scope_denied' });
  });

  it('retains the last healthy time across one transient failure', async () => {
    const testClock = clock(100);
    const offlineClient = client({
      health: async () => {
        throw caveError('service_unavailable', true);
      },
    });
    const discover = vi
      .fn<() => Promise<Readonly<{ client: CaveConnectionClient }>>>()
      .mockResolvedValueOnce({ client: client() })
      .mockResolvedValueOnce({ client: offlineClient });
    const subject = controller(
      Object.freeze({ discover, launch: async () => undefined }),
      testClock,
    );

    await subject.start();
    testClock.advance(50);
    await subject.retry();
    expect(subject.getState()).toMatchObject({
      state: 'offline',
      lastHealthyAt: 100,
    });
  });

  it('only publishes revoked from the confirmed normalized credential status', async () => {
    const subject = controller(
      host(
        client({
          credentialStatus: async () => ({
            status: 'revoked',
            health: health(),
          }),
        }),
      ),
    );

    await subject.start();

    expect(subject.getState().state).toBe('revoked');
  });

  it('creates a least-privilege pairing, exchanges after approval, then confirms ready', async () => {
    const testClock = clock();
    const requests: CavePairingRequest[] = [];
    const pairing = pairingSession(async () => 'approved');
    const caveClient = client({
      credentialStatus: vi
        .fn<() => Promise<CaveCredentialStatus>>()
        .mockResolvedValueOnce({ status: 'missing' })
        .mockResolvedValueOnce(validStatus()),
      createPairing: async (request) => {
        requests.push(request);
        return pairing;
      },
    });
    const subject = controller(host(caveClient), testClock);

    await subject.start();
    await subject.beginPairing();

    expect(requests).toEqual([
      {
        appName: 'OpenCoven Chat',
        installationId: INSTALLATION_ID,
        scopes: ['chat:read'],
      },
    ]);
    expect(subject.getState()).toEqual({
      state: 'ready',
      caveInstanceId: CAVE_INSTANCE_ID,
      covenAvailable: false,
    });
  });

  it('handles denied pairing without exchange', async () => {
    const exchange = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const caveClient = client({
      credentialStatus: async () => ({ status: 'missing' }),
      createPairing: async () => pairingSession(async () => 'denied', exchange),
    });
    const subject = controller(host(caveClient));

    await subject.start();
    await subject.beginPairing();

    expect(subject.getState()).toMatchObject({ state: 'error', code: 'pairing_denied' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('expires a pending pairing using the injected monotonic clock', async () => {
    const testClock = clock();
    const caveClient = client({
      credentialStatus: async () => ({ status: 'missing' }),
      createPairing: async () => pairingSession(async () => 'pending'),
    });
    const subject = controller(host(caveClient), testClock);

    await subject.start();
    const pending = subject.beginPairing();
    await settle();
    expect(subject.getState()).toEqual({
      state: 'pairing',
      requestId: '00000000-0000-4000-8000-000000000003',
      expiresAt: 2_000,
    });
    expect(testClock.pendingSleeps()).toBe(1);
    testClock.advance(1_000);
    await pending;

    expect(subject.getState()).toMatchObject({ state: 'error', code: 'pairing_expired' });
  });

  it('does not exchange when approval arrives after expiry', async () => {
    const testClock = clock();
    const exchange = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const caveClient = client({
      credentialStatus: async () => ({ status: 'missing' }),
      createPairing: async () =>
        pairingSession(async () => {
          testClock.advance(1_000);
          return 'approved';
        }, exchange),
    });
    const subject = controller(host(caveClient), testClock);

    await subject.start();
    await subject.beginPairing();

    expect(subject.getState()).toMatchObject({ state: 'error', code: 'pairing_expired' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('handles pairing rate limits without retrying or widening scope', async () => {
    const createPairing = vi.fn<(request: CavePairingRequest) => Promise<CavePairingSessionPort>>(
      async () => {
        throw caveError('rate_limited', true);
      },
    );
    const subject = controller(
      host(
        client({
          credentialStatus: async () => ({ status: 'missing' }),
          createPairing,
        }),
      ),
    );

    await subject.start();
    await subject.beginPairing();

    expect(subject.getState()).toMatchObject({ state: 'error', code: 'rate_limited' });
    expect(createPairing).toHaveBeenCalledTimes(1);
  });

  it('cancels before an approval can exchange a credential', async () => {
    const approval = deferred<CavePairingState>();
    const exchange = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const caveClient = client({
      credentialStatus: async () => ({ status: 'missing' }),
      createPairing: async () => pairingSession(() => approval.promise, exchange),
    });
    const subject = controller(host(caveClient));

    await subject.start();
    const pending = subject.beginPairing();
    await settle();
    subject.cancelPairing();
    approval.resolve('approved');
    await pending;

    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('abandons a pending polling sleep after cancellation', async () => {
    const testClock = clock();
    const poll = vi.fn<() => Promise<CavePairingState>>().mockResolvedValue('pending');
    const caveClient = client({
      credentialStatus: async () => ({ status: 'missing' }),
      createPairing: async () => pairingSession(poll),
    });
    const subject = controller(host(caveClient), testClock);

    await subject.start();
    const pending = subject.beginPairing();
    await settle();
    expect(testClock.pendingSleeps()).toBe(1);
    subject.cancelPairing();
    testClock.advance(10);
    await pending;

    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('lets retry supersede an old discovery completion', async () => {
    const first = deferred<CaveConnectionClient>();
    const second = client({
      credentialStatus: async () => ({ status: 'missing' }),
    });
    const discover = vi
      .fn<() => Promise<Readonly<{ client: CaveConnectionClient }>>>()
      .mockImplementationOnce(async () => ({ client: await first.promise }))
      .mockResolvedValueOnce({ client: second });
    const subject = controller(Object.freeze({ discover, launch: async () => undefined }));

    const initial = subject.start();
    await settle();
    await subject.retry();
    first.resolve(client());
    await initial;

    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });
  });

  it('cannot let an old exchange overwrite a newer retry', async () => {
    const exchange = deferred<void>();
    const firstClient = client({
      credentialStatus: vi
        .fn<() => Promise<CaveCredentialStatus>>()
        .mockResolvedValueOnce({ status: 'missing' })
        .mockResolvedValueOnce(validStatus()),
      createPairing: async () =>
        pairingSession(
          async () => 'approved',
          () => exchange.promise,
        ),
    });
    const secondClient = client({
      credentialStatus: async () => validStatus('chat:read', NEXT_CAVE_INSTANCE_ID),
      health: async () => health(NEXT_CAVE_INSTANCE_ID),
    });
    const discover = vi
      .fn<() => Promise<Readonly<{ client: CaveConnectionClient }>>>()
      .mockResolvedValueOnce({ client: firstClient })
      .mockResolvedValueOnce({ client: secondClient });
    const subject = controller(Object.freeze({ discover, launch: async () => undefined }));

    await subject.start();
    const pendingPairing = subject.beginPairing();
    await settle();
    await subject.retry();
    exchange.resolve();
    await pendingPairing;

    expect(subject.getState()).toEqual({
      state: 'ready',
      caveInstanceId: NEXT_CAVE_INSTANCE_ID,
      covenAvailable: false,
    });
  });

  it('deduplicates StrictMode-like duplicate starts and pairing requests', async () => {
    const discovery = deferred<CaveConnectionClient>();
    const pairing = deferred<CavePairingSessionPort>();
    const discover = vi.fn<() => Promise<Readonly<{ client: CaveConnectionClient }>>>(async () => ({
      client: await discovery.promise,
    }));
    const createPairing = vi
      .fn<(request: CavePairingRequest) => Promise<CavePairingSessionPort>>()
      .mockImplementation(async () => pairing.promise);
    const caveClient = client({
      credentialStatus: async () => ({ status: 'missing' }),
      createPairing,
    });
    const subject = controller(Object.freeze({ discover, launch: async () => undefined }));

    const firstStart = subject.start();
    const secondStart = subject.start();
    expect(secondStart).toBe(firstStart);
    discovery.resolve(caveClient);
    await firstStart;
    const firstPairing = subject.beginPairing();
    const secondPairing = subject.beginPairing();
    expect(secondPairing).toBe(firstPairing);
    pairing.resolve(pairingSession(async () => 'denied'));
    await firstPairing;

    expect(discover).toHaveBeenCalledTimes(1);
    expect(createPairing).toHaveBeenCalledTimes(1);
  });

  it('disposes safely and forgets a credential without calling it revoked', async () => {
    const discovery = deferred<CaveConnectionClient>();
    const subject = controller(host(discovery.promise));
    const listener = vi.fn();
    subject.subscribe(listener);
    const pending = subject.start();
    listener.mockClear();
    subject.dispose();
    discovery.resolve(client());
    await pending;

    expect(subject.getState()).toEqual({ state: 'idle' });
    expect(listener).not.toHaveBeenCalled();

    const forget = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const connected = controller(host(client({ forgetCredential: forget })));
    await connected.start();
    await connected.forgetCredential();
    expect(connected.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it('keeps public state immutable and free of forbidden data', async () => {
    const secretCanary = 'pairing-secret-canary';
    const subject = controller(host(client()));

    await subject.start();
    const state = subject.getState();
    const serialized = JSON.stringify(state);
    const rendered = inspect(state);

    expect(Object.isFrozen(state)).toBe(true);
    expect(serialized).not.toContain(secretCanary);
    expect(rendered).not.toContain(secretCanary);
    expect(serialized).not.toMatch(/bearer|secret|endpoint|path|prompt|attachment/iu);
    expect(rendered).not.toMatch(/bearer|secret|endpoint|path|prompt|attachment/iu);
  });
});
