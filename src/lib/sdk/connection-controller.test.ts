import { inspect } from 'node:util';
import {
  type CaveClient,
  type CaveManagedCredentialTransport,
  type CavePairingRequest,
  createManagedCaveClient,
} from '@opencoven/cave-client/managed';
import { describe, expect, it, vi } from 'vitest';
import {
  type CaveConnectionHostPort,
  createCaveConnectionController,
} from './connection-controller';
import type { CaveConnectionHost } from './connection-host';
import { createCaveConnectionHost } from './connection-host';
import { createCaveManagedCredentialTransport, type NativeSdkInvoke } from './native-boundary';

const CAVE_INSTANCE_ID = '00000000-0000-4000-8000-000000000000';
const NEXT_CAVE_INSTANCE_ID = '00000000-0000-4000-8000-000000000002';
const INSTALLATION_ID = '00000000-0000-4000-8000-000000000001';
const PAIRING_REQUEST_ID = '00000000-0000-4000-8000-000000000003';

const capabilities = [
  'health',
  'pairing',
  'credentials',
  'familiars',
  'projects',
  'conversations',
  'conversation-messages',
  'cursors',
];
const operations = [
  'health.read',
  'pairing.create',
  'pairing.poll',
  'pairing.exchange',
  'pairing.admin.list',
  'pairing.admin.decide',
  'credentials.admin.list',
  'credentials.admin.revoke',
  'familiars.list',
  'projects.list',
  'conversations.list',
  'conversations.read',
  'messages.list',
];

type NativeResponse = (args?: Record<string, unknown>) => Promise<unknown>;
type ManagedNativeResponses = Readonly<{
  discovery?: NativeResponse;
  health?: NativeResponse;
  credentialStatus?: NativeResponse;
  pairingCreate?: NativeResponse;
  pairingPoll?: NativeResponse;
  pairingExchange?: NativeResponse;
  forgetCredential?: NativeResponse;
  launch?: NativeResponse;
}>;
type PairingPhase = 'create' | 'poll' | 'exchange';
type RateLimitCalls = {
  pairingRequests: CavePairingRequest[];
  polls: number;
  exchanges: number;
  credentialStatuses: number;
};

function healthEnvelope(instanceId = CAVE_INSTANCE_ID, minimumClientVersion = '0.1.0') {
  return {
    apiVersion: '1.0',
    minimumClientVersion,
    capabilities,
    operations,
    data: {
      instanceId,
      pairingRequired: false,
      releaseVersion: '0.1.0',
    },
  };
}

function errorEnvelope(code: string, retryable: boolean) {
  return {
    ok: false,
    reason: code,
    error: retryable ? 'retryable native test refusal' : 'native test refusal',
  };
}

function discoverySnapshot(endpoint = 'http://127.0.0.1:3020') {
  return {
    handle: 'native-discovery-handle',
    bytes: Array.from(
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          endpoint,
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

function validCredentialStatus(
  access: 'chat:read' | 'scope_denied' | 'service_unavailable' | 'rate_limited' = 'chat:read',
  instanceId = CAVE_INSTANCE_ID,
) {
  return {
    status: 'valid',
    access,
    health: healthEnvelope(instanceId),
  };
}

function credentialMetadata() {
  return {
    id: '00000000-0000-4000-8000-000000000004',
    appName: 'OpenCoven Chat',
    installationId: INSTALLATION_ID,
    scopes: ['chat:read'],
    createdAt: 1,
    lastUsedAt: null,
    revokedAt: null,
    revocationReason: null,
  };
}

function nativeInvoke(responses: ManagedNativeResponses = {}): NativeSdkInvoke {
  return async (command, args) => {
    switch (command) {
      case 'cave_read_discovery':
        return responses.discovery === undefined ? discoverySnapshot() : responses.discovery(args);
      case 'cave_health':
        return responses.health === undefined ? healthEnvelope() : responses.health(args);
      case 'cave_credential_status':
        return responses.credentialStatus === undefined
          ? validCredentialStatus()
          : responses.credentialStatus(args);
      case 'cave_pairing_create':
        return responses.pairingCreate === undefined
          ? Promise.reject(new Error('unexpected pairing create'))
          : responses.pairingCreate(args);
      case 'cave_pairing_poll':
        return responses.pairingPoll === undefined
          ? Promise.reject(new Error('unexpected pairing poll'))
          : responses.pairingPoll(args);
      case 'cave_pairing_exchange':
        return responses.pairingExchange === undefined
          ? Promise.reject(new Error('unexpected pairing exchange'))
          : responses.pairingExchange(args);
      case 'cave_forget_credential':
        return responses.forgetCredential === undefined
          ? { status: 'deleted' }
          : responses.forgetCredential(args);
      case 'cave_launch':
        return responses.launch === undefined ? undefined : responses.launch(args);
      default:
        throw new Error('unexpected native command');
    }
  };
}

function nativeHost(responses: ManagedNativeResponses = {}): CaveConnectionHost {
  return createCaveConnectionHost(nativeInvoke(responses));
}

function rateLimitedClient(
  phase: PairingPhase,
  fail: () => Promise<never>,
  calls: RateLimitCalls,
  onRateLimit?: () => void,
): CaveClient {
  const transport = createCaveManagedCredentialTransport(
    nativeInvoke({
      credentialStatus: async () => {
        calls.credentialStatuses += 1;
        return { status: 'missing' };
      },
      pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
      pairingPoll: async () => ({
        id: PAIRING_REQUEST_ID,
        status: 'approved',
        expiresAt: 2_000,
      }),
      pairingExchange: async () => ({ credential: credentialMetadata() }),
    }),
    'native-rate-limit-handle',
  );
  const pairingCreate: CaveManagedCredentialTransport['managedPairingCreate'] = async (
    request,
    context,
  ) => {
    calls.pairingRequests.push(request);
    if (phase === 'create') {
      onRateLimit?.();
      return fail();
    }
    return transport.managedPairingCreate(request, context);
  };
  const pairingPoll: CaveManagedCredentialTransport['managedPairingPoll'] = async (
    requestId,
    context,
  ) => {
    calls.polls += 1;
    if (phase === 'poll') {
      onRateLimit?.();
      return fail();
    }
    return transport.managedPairingPoll(requestId, context);
  };
  const pairingExchange: CaveManagedCredentialTransport['managedPairingExchange'] = async (
    requestId,
    context,
  ) => {
    calls.exchanges += 1;
    if (phase === 'exchange') {
      onRateLimit?.();
      return fail();
    }
    return transport.managedPairingExchange(requestId, context);
  };

  return createManagedCaveClient({
    transport: Object.freeze({
      ...transport,
      managedPairingCreate: pairingCreate,
      managedPairingPoll: pairingPoll,
      managedPairingExchange: pairingExchange,
    }),
  });
}

function rateLimitedCalls(): RateLimitCalls {
  return {
    pairingRequests: [],
    polls: 0,
    exchanges: 0,
    credentialStatuses: 0,
  };
}

async function discoveryWithClient(client: CaveClient) {
  const discovered = await nativeHost().discover();
  return Object.freeze({
    ...discovered,
    client,
  });
}

function hostPort(
  discover: CaveConnectionHost['discover'],
  launch: CaveConnectionHost['launch'] = async () => undefined,
): CaveConnectionHostPort {
  return Object.freeze({ discover, launch });
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
  it('classifies no authority as offline and never launches without an explicit call', async () => {
    let launchCalls = 0;
    const subject = controller(
      nativeHost({
        discovery: async () => Promise.reject(new Error('authority unavailable')),
        launch: async () => {
          launchCalls += 1;
          return undefined;
        },
      }),
    );
    await subject.start();

    expect(subject.getState()).toMatchObject({ state: 'offline', lastHealthyAt: null });
    expect(launchCalls).toBe(0);
    await subject.launch();
    expect(launchCalls).toBe(1);
  });

  it('classifies the packed client compatibility result as incompatible', async () => {
    const subject = controller(
      nativeHost({
        health: async () => healthEnvelope(CAVE_INSTANCE_ID, '99.0.0'),
      }),
    );

    await subject.start();

    expect(subject.getState().state).toBe('incompatible');
  });

  it('uses packed managed credential status parsing for missing, ready, and scope denied', async () => {
    const missing = controller(
      nativeHost({
        credentialStatus: async () => ({ status: 'missing' }),
      }),
    );
    const ready = controller(nativeHost());
    const denied = controller(
      nativeHost({
        credentialStatus: async () => validCredentialStatus('scope_denied'),
      }),
    );

    await Promise.all([missing.start(), ready.start(), denied.start()]);

    expect(missing.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });
    expect(ready.getState()).toEqual({
      state: 'ready',
      caveInstanceId: CAVE_INSTANCE_ID,
      covenAvailable: false,
    });
    expect(denied.getState()).toMatchObject({ state: 'error', code: 'scope_denied' });
  });

  it('treats SDK-normalized rate limiting as transient offline after health', async () => {
    const testClock = clock(100);
    const subject = controller(
      nativeHost({
        credentialStatus: async () => validCredentialStatus('rate_limited'),
      }),
      testClock,
    );

    await subject.start();

    expect(subject.getState()).toMatchObject({
      state: 'offline',
      lastHealthyAt: 100,
    });
  });

  it('treats a packed rate-limited connection operation as offline', async () => {
    const subject = controller(
      nativeHost({
        health: async () => errorEnvelope('rate_limited', true),
      }),
    );

    await subject.start();

    expect(subject.getState()).toMatchObject({
      state: 'offline',
      lastHealthyAt: null,
    });
  });

  it('retains lastHealthyAt across a transient packed health failure', async () => {
    const testClock = clock(100);
    const healthy = nativeHost();
    const unavailable = nativeHost({
      health: async () => errorEnvelope('service_unavailable', true),
    });
    const discover = vi
      .fn<CaveConnectionHost['discover']>()
      .mockImplementationOnce(healthy.discover)
      .mockImplementationOnce(unavailable.discover);
    const subject = controller(hostPort(discover), testClock);

    await subject.start();
    testClock.advance(50);
    await subject.retry();

    expect(subject.getState()).toMatchObject({
      state: 'offline',
      lastHealthyAt: 100,
    });
  });

  it('only revokes after a confirmed packed managed credential status', async () => {
    let healthCalls = 0;
    let credentialStatusCalls = 0;
    const subject = controller(
      nativeHost({
        health: async () => {
          healthCalls += 1;
          return healthCalls === 1 ? errorEnvelope('unauthorized', false) : healthEnvelope();
        },
        credentialStatus: async () => {
          credentialStatusCalls += 1;
          return {
            status: 'revoked',
            health: healthEnvelope(),
          };
        },
      }),
    );

    await subject.start();
    expect(subject.getState()).toMatchObject({ state: 'error', code: 'unauthorized' });
    expect(credentialStatusCalls).toBe(0);

    await subject.retry();

    expect(subject.getState().state).toBe('revoked');
    expect(credentialStatusCalls).toBe(1);
  });

  it('uses the packed managed pairing runtime with only chat:read', async () => {
    const requests: Array<Record<string, unknown> | undefined> = [];
    let credentialStatusCalls = 0;
    const subject = controller(
      nativeHost({
        credentialStatus: async () => {
          credentialStatusCalls += 1;
          return credentialStatusCalls === 1 ? { status: 'missing' } : validCredentialStatus();
        },
        pairingCreate: async (args) => {
          requests.push(args);
          return {
            requestId: PAIRING_REQUEST_ID,
            expiresAt: 2_000,
          };
        },
        pairingPoll: async () => ({
          id: PAIRING_REQUEST_ID,
          status: 'approved',
          expiresAt: 2_000,
        }),
        pairingExchange: async () => ({
          credential: credentialMetadata(),
        }),
      }),
    );

    await subject.start();
    await subject.beginPairing();

    expect(requests).toEqual([
      {
        handle: 'native-discovery-handle',
        request: {
          appName: 'OpenCoven Chat',
          installationId: INSTALLATION_ID,
          scopes: ['chat:read'],
        },
      },
    ]);
    expect(subject.getState()).toEqual({
      state: 'ready',
      caveInstanceId: CAVE_INSTANCE_ID,
      covenAvailable: false,
    });
  });

  it('publishes offline for packed rate limits at every pairing phase without retrying', async () => {
    const canary = 'pairing-rate-limit-secret-canary';

    for (const phase of ['create', 'poll', 'exchange'] as const) {
      const calls = rateLimitedCalls();
      const events: unknown[] = [];
      const packedClient = rateLimitedClient(
        phase,
        () =>
          Promise.reject(
            Object.freeze({
              code: 'rate_limited',
              retryable: true,
              cause: {
                path: canary,
                secret: canary,
                url: `https://${canary}.invalid`,
              },
            }),
          ),
        calls,
      );
      const testClock = clock(100);
      const subject = controller(
        hostPort(async () => discoveryWithClient(packedClient)),
        testClock,
      );
      subject.subscribe((state) => {
        events.push(state);
      });

      await subject.start();
      await subject.beginPairing();
      await settle();

      expect(subject.getState()).toMatchObject({
        state: 'offline',
        lastHealthyAt: 100,
      });
      expect(calls.credentialStatuses).toBe(1);
      expect(calls.pairingRequests).toEqual([
        {
          appName: 'OpenCoven Chat',
          installationId: INSTALLATION_ID,
          scopes: ['chat:read'],
        },
      ]);
      expect(calls.polls).toBe(phase === 'create' ? 0 : 1);
      expect(calls.exchanges).toBe(phase === 'exchange' ? 1 : 0);
      for (const value of [...events, subject.getState()]) {
        expect(JSON.stringify(value)).not.toContain(canary);
        expect(inspect(value)).not.toContain(canary);
      }
    }
  });

  it('does not let stale packed pairing rate limits overwrite a retry', async () => {
    const canary = 'stale-pairing-rate-limit-canary';

    for (const phase of ['create', 'poll', 'exchange'] as const) {
      const calls = rateLimitedCalls();
      const rateLimit = deferred<never>();
      const enteredRateLimit = deferred<void>();
      const packedClient = rateLimitedClient(
        phase,
        () => rateLimit.promise,
        calls,
        () => enteredRateLimit.resolve(),
      );
      const replacement = nativeHost({
        health: async () => healthEnvelope(NEXT_CAVE_INSTANCE_ID),
        credentialStatus: async () => validCredentialStatus('chat:read', NEXT_CAVE_INSTANCE_ID),
      });
      const discover = vi
        .fn<CaveConnectionHost['discover']>()
        .mockImplementationOnce(async () => discoveryWithClient(packedClient))
        .mockImplementationOnce(replacement.discover);
      const subject = controller(hostPort(discover));

      await subject.start();
      const pairing = subject.beginPairing();
      await enteredRateLimit.promise;
      await subject.retry();
      rateLimit.reject(
        Object.freeze({
          code: 'rate_limited',
          retryable: true,
          cause: {
            path: canary,
            secret: canary,
            url: `https://${canary}.invalid`,
          },
        }),
      );
      await pairing;

      expect(subject.getState()).toEqual({
        state: 'ready',
        caveInstanceId: NEXT_CAVE_INSTANCE_ID,
        covenAvailable: false,
      });
      expect(calls.pairingRequests).toHaveLength(1);
      expect(calls.polls).toBe(phase === 'create' ? 0 : 1);
      expect(calls.exchanges).toBe(phase === 'exchange' ? 1 : 0);
    }
  });

  it('handles packed pairing denial, expiry, and cancellation without exchange', async () => {
    let deniedExchanges = 0;
    const denied = controller(
      nativeHost({
        credentialStatus: async () => ({ status: 'missing' }),
        pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
        pairingPoll: async () => ({
          id: PAIRING_REQUEST_ID,
          status: 'denied',
          expiresAt: 2_000,
        }),
        pairingExchange: async () => {
          deniedExchanges += 1;
          return { credential: credentialMetadata() };
        },
      }),
    );
    const testClock = clock();
    let expiryCreates = 0;
    const expired = controller(
      nativeHost({
        credentialStatus: async () => ({ status: 'missing' }),
        pairingCreate: async () => {
          expiryCreates += 1;
          return { requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 };
        },
        pairingPoll: async () => ({
          id: PAIRING_REQUEST_ID,
          status: 'pending',
          expiresAt: 2_000,
        }),
      }),
      testClock,
    );
    const approval = deferred<unknown>();
    let cancelledExchanges = 0;
    const cancelled = controller(
      nativeHost({
        credentialStatus: async () => ({ status: 'missing' }),
        pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
        pairingPoll: async () => approval.promise,
        pairingExchange: async () => {
          cancelledExchanges += 1;
          return { credential: credentialMetadata() };
        },
      }),
    );

    await denied.start();
    await denied.beginPairing();
    expect(denied.getState()).toMatchObject({ state: 'error', code: 'pairing_denied' });
    expect(deniedExchanges).toBe(0);

    await expired.start();
    const pendingExpiry = expired.beginPairing();
    await settle();
    expect(expiryCreates).toBe(1);
    testClock.advance(1_000);
    await pendingExpiry;
    expect(expired.getState()).toMatchObject({ state: 'error', code: 'pairing_expired' });

    await cancelled.start();
    const pendingCancellation = cancelled.beginPairing();
    await settle();
    cancelled.cancelPairing();
    approval.resolve({
      id: PAIRING_REQUEST_ID,
      status: 'approved',
      expiresAt: 2_000,
    });
    await pendingCancellation;
    expect(cancelled.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });
    expect(cancelledExchanges).toBe(0);
  });

  it('does not exchange a packed approved response that arrives after expiry', async () => {
    const testClock = clock();
    let exchanges = 0;
    const subject = controller(
      nativeHost({
        credentialStatus: async () => ({ status: 'missing' }),
        pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
        pairingPoll: async () => {
          testClock.advance(1_000);
          return {
            id: PAIRING_REQUEST_ID,
            status: 'approved',
            expiresAt: 2_000,
          };
        },
        pairingExchange: async () => {
          exchanges += 1;
          return { credential: credentialMetadata() };
        },
      }),
      testClock,
    );

    await subject.start();
    await subject.beginPairing();

    expect(subject.getState()).toMatchObject({ state: 'error', code: 'pairing_expired' });
    expect(exchanges).toBe(0);
  });

  it('lets retry supersede old packed discovery and exchange completions', async () => {
    const firstHost = nativeHost({
      credentialStatus: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          return calls === 1 ? { status: 'missing' } : validCredentialStatus();
        };
      })(),
      pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
      pairingPoll: async () => ({
        id: PAIRING_REQUEST_ID,
        status: 'approved',
        expiresAt: 2_000,
      }),
    });
    const oldExchange = deferred<unknown>();
    const exchangeHost = nativeHost({
      credentialStatus: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          return calls === 1 ? { status: 'missing' } : validCredentialStatus();
        };
      })(),
      pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
      pairingPoll: async () => ({
        id: PAIRING_REQUEST_ID,
        status: 'approved',
        expiresAt: 2_000,
      }),
      pairingExchange: async () => oldExchange.promise,
    });
    const replacement = nativeHost({
      health: async () => healthEnvelope(NEXT_CAVE_INSTANCE_ID),
      credentialStatus: async () => validCredentialStatus('chat:read', NEXT_CAVE_INSTANCE_ID),
    });
    const delayedDiscovery = deferred<Awaited<ReturnType<CaveConnectionHost['discover']>>>();
    const discover = vi
      .fn<CaveConnectionHost['discover']>()
      .mockImplementationOnce(() => delayedDiscovery.promise)
      .mockImplementationOnce(exchangeHost.discover)
      .mockImplementationOnce(replacement.discover);
    const subject = controller(hostPort(discover));

    const initial = subject.start();
    await settle();
    await subject.retry();
    delayedDiscovery.resolve(await firstHost.discover());
    await initial;
    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });

    const pairing = subject.beginPairing();
    await settle();
    await subject.retry();
    oldExchange.resolve({ credential: credentialMetadata() });
    await pairing;
    expect(subject.getState()).toEqual({
      state: 'ready',
      caveInstanceId: NEXT_CAVE_INSTANCE_ID,
      covenAvailable: false,
    });
  });

  it('deduplicates StrictMode-like start and pairing calls', async () => {
    let pairingCreates = 0;
    const source = nativeHost({
      credentialStatus: async () => ({ status: 'missing' }),
      pairingCreate: async () => {
        pairingCreates += 1;
        return { requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 };
      },
      pairingPoll: async () => ({
        id: PAIRING_REQUEST_ID,
        status: 'denied',
        expiresAt: 2_000,
      }),
    });
    const delayedDiscovery = deferred<Awaited<ReturnType<CaveConnectionHost['discover']>>>();
    const discover = vi.fn<CaveConnectionHost['discover']>(() => delayedDiscovery.promise);
    const subject = controller(hostPort(discover));

    const firstStart = subject.start();
    const secondStart = subject.start();
    expect(secondStart).toBe(firstStart);
    delayedDiscovery.resolve(await source.discover());
    await firstStart;

    const firstPairing = subject.beginPairing();
    const secondPairing = subject.beginPairing();
    expect(secondPairing).toBe(firstPairing);
    await firstPairing;

    expect(discover).toHaveBeenCalledTimes(1);
    expect(pairingCreates).toBe(1);
  });

  it('disposes safely and forgets a native credential without calling it revoked', async () => {
    const source = nativeHost();
    const delayedDiscovery = deferred<Awaited<ReturnType<CaveConnectionHost['discover']>>>();
    const subject = controller(hostPort(() => delayedDiscovery.promise));
    const listener = vi.fn();
    subject.subscribe(listener);
    const pending = subject.start();
    listener.mockClear();
    subject.dispose();
    delayedDiscovery.resolve(await source.discover());
    await pending;

    expect(subject.getState()).toEqual({ state: 'idle' });
    expect(listener).not.toHaveBeenCalled();

    let forgets = 0;
    const connected = controller(
      nativeHost({
        forgetCredential: async () => {
          forgets += 1;
          return { status: 'deleted' };
        },
      }),
    );
    await connected.start();
    await connected.forgetCredential();
    expect(connected.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });
    expect(forgets).toBe(1);
  });

  it('keeps hostile native rejection data out of public state and subscriber events', async () => {
    const canary = 'secret-cause-path-url-canary';
    const rejection = Object.assign(new Error(canary), {
      cause: { path: canary, url: `https://${canary}.invalid` },
    });
    const events: unknown[] = [];
    const subject = controller(
      nativeHost({
        health: async () => Promise.reject(rejection),
      }),
    );
    subject.subscribe((state) => {
      events.push(state);
    });

    await subject.start();

    for (const value of [...events, subject.getState()]) {
      expect(JSON.stringify(value)).not.toContain(canary);
      expect(inspect(value)).not.toContain(canary);
      expect(JSON.stringify(value)).not.toMatch(
        /bearer|cause|secret|endpoint|path|prompt|attachment|url/iu,
      );
    }
  });
});
