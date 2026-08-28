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
  resetPairing?: NativeResponse;
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
          version: 2,
          endpoint,
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
      case 'cave_reset_pairing':
        return responses.resetPairing === undefined
          ? { status: 'invalidated' }
          : responses.resetPairing(args);
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
  resetPairing: CaveConnectionHost['resetPairing'] = async () => undefined,
): CaveConnectionHostPort {
  return Object.freeze({
    discover,
    launch,
    resetPairing,
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
  const sleepers: Array<{
    dueAt: number;
    resolve: () => void;
    reject: () => void;
  }> = [];
  let aborts = 0;

  return Object.freeze({
    now: () => time,
    sleep: (milliseconds: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => {
          aborts += 1;
          const index = sleepers.findIndex((sleeper) => sleeper.reject === rejectSleep);
          if (index !== -1) {
            sleepers.splice(index, 1);
          }
          reject(Object.freeze({ code: 'aborted' }));
        };
        const resolveSleep = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const rejectSleep = () => {
          signal?.removeEventListener('abort', abort);
          reject(Object.freeze({ code: 'aborted' }));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        sleepers.push({
          dueAt: time + milliseconds,
          resolve: resolveSleep,
          reject: rejectSleep,
        });
      }),
    advance(milliseconds: number) {
      time += milliseconds;
      const due = sleepers.filter((sleeper) => sleeper.dueAt <= time);
      for (const sleeper of due) {
        const index = sleepers.indexOf(sleeper);
        if (index !== -1) {
          sleepers.splice(index, 1);
        }
        sleeper.resolve();
      }
    },
    pendingSleeps: () => sleepers.length,
    aborts: () => aborts,
  });
}

function controller(
  caveHost: CaveConnectionHostPort,
  testClock = clock(),
  pollIntervalMs = 10,
  operationTimeoutMs?: number,
) {
  return createCaveConnectionController({
    host: caveHost,
    pairingIdentity: {
      appName: 'OpenCoven Chat',
      installationId: INSTALLATION_ID,
    },
    now: testClock.now,
    sleep: testClock.sleep,
    pollIntervalMs,
    ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }),
  });
}

async function settle() {
  for (let index = 0; index < 16; index += 1) {
    await Promise.resolve();
  }
}

describe('Cave connection controller', () => {
  it('passes its bounded operation signal and timeout into managed discovery', async () => {
    const native = nativeHost();
    let observed: Parameters<CaveConnectionHost['discover']>[0];
    const subject = controller(
      hostPort(async (options) => {
        observed = options;
        return await native.discover(options);
      }),
    );

    await subject.start();

    expect(observed?.signal).toBeInstanceOf(AbortSignal);
    expect(observed?.timeoutMs).toBe(30_000);
  });

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

  it('bounds a never-settling discovery and suppresses its late completion', async () => {
    const testClock = clock();
    const pendingDiscovery = deferred<Awaited<ReturnType<CaveConnectionHost['discover']>>>();
    const source = nativeHost();
    const subject = controller(
      hostPort(() => pendingDiscovery.promise),
      testClock,
      10,
      50,
    );

    const started = subject.start();
    await settle();
    testClock.advance(50);
    await started;

    expect(subject.getState()).toMatchObject({
      state: 'offline',
      lastHealthyAt: null,
    });
    pendingDiscovery.resolve(await source.discover());
    await settle();
    expect(subject.getState()).toMatchObject({
      state: 'offline',
      lastHealthyAt: null,
    });
  });

  it('bounds a never-settling explicit launch and suppresses its late completion', async () => {
    const testClock = clock(100);
    const pendingLaunch = deferred<void>();
    const subject = controller(
      hostPort(nativeHost().discover, () => pendingLaunch.promise),
      testClock,
      10,
      50,
    );
    await subject.start();

    const launched = subject.launch();
    await settle();
    testClock.advance(50);
    await launched;

    expect(subject.getState()).toMatchObject({
      state: 'offline',
      lastHealthyAt: 100,
    });
    pendingLaunch.resolve();
    await settle();
    expect(subject.getState()).toMatchObject({
      state: 'offline',
      lastHealthyAt: 100,
    });
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

  it('forgets a validated packed scope-denied credential before requiring pairing', async () => {
    let forgets = 0;
    const subject = controller(
      nativeHost({
        credentialStatus: async () => validCredentialStatus('scope_denied'),
        forgetCredential: async () => {
          forgets += 1;
          return { status: 'deleted' };
        },
      }),
    );

    await subject.start();
    await subject.forgetCredential();

    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });
    expect(forgets).toBe(1);
  });

  it('keeps SDK-normalized rate limiting distinct from offline after health', async () => {
    const testClock = clock(100);
    const subject = controller(
      nativeHost({
        credentialStatus: async () => validCredentialStatus('rate_limited'),
      }),
      testClock,
    );

    await subject.start();

    expect(subject.getState()).toMatchObject({
      state: 'error',
      code: 'rate_limited',
    });
  });

  it('keeps a packed rate-limited connection operation distinct from offline', async () => {
    const subject = controller(
      nativeHost({
        health: async () => errorEnvelope('rate_limited', true),
      }),
    );

    await subject.start();

    expect(subject.getState()).toMatchObject({
      state: 'error',
      code: 'rate_limited',
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

  it('keeps authority-proof and temporary transport failures distinct from revocation', async () => {
    const secret = 'proof-cause-secret-canary';
    const proofFailure = controller(
      nativeHost({
        credentialStatus: async () =>
          Promise.reject({
            code: 'reconcile_required',
            retryable: false,
            cause: { secret },
          }),
      }),
    );
    const transportFailure = controller(
      nativeHost({
        credentialStatus: async () =>
          Promise.reject({
            code: 'timeout',
            retryable: true,
            cause: { secret },
          }),
      }),
    );

    await proofFailure.start();
    await transportFailure.start();

    expect(proofFailure.getState()).toMatchObject({
      state: 'error',
      code: 'reconcile_required',
    });
    expect(transportFailure.getState().state).toBe('offline');
    expect(proofFailure.getState().state).not.toBe('revoked');
    expect(transportFailure.getState().state).not.toBe('revoked');
    expect(inspect([proofFailure.getState(), transportFailure.getState()])).not.toContain(secret);
  });

  it('forgets a confirmed revoked credential and returns to pairing required', async () => {
    let forgetCalls = 0;
    const subject = controller(
      nativeHost({
        credentialStatus: async () => ({
          status: 'revoked',
          health: healthEnvelope(),
        }),
        forgetCredential: async () => {
          forgetCalls += 1;
          return { status: 'deleted' };
        },
      }),
    );

    await subject.start();
    expect(subject.getState().state).toBe('revoked');
    expect(subject.getReadyClient()).toBeNull();

    await subject.forgetCredential();

    expect(forgetCalls).toBe(1);
    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });
    expect(subject.getReadyClient()).toBeNull();
  });

  it('withdraws the ready client before native credential deletion completes', async () => {
    const deletion = deferred<{ status: string }>();
    const subject = controller(
      nativeHost({
        forgetCredential: async () => deletion.promise,
      }),
    );

    await subject.start();
    expect(subject.getState().state).toBe('ready');
    expect(subject.getReadyClient()).not.toBeNull();

    const forgetting = subject.forgetCredential();

    expect(subject.getState().state).toBe('discovering');
    expect(subject.getReadyClient()).toBeNull();

    deletion.resolve({ status: 'deleted' });
    await forgetting;

    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });
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

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      handle: 'native-discovery-handle',
      operation: {
        attemptId: expect.any(String),
        timeoutMs: expect.any(Number),
      },
      request: {
        appName: 'OpenCoven Chat',
        installationId: INSTALLATION_ID,
        scopes: ['chat:read'],
      },
    });
    expect(subject.getState()).toEqual({
      state: 'ready',
      caveInstanceId: CAVE_INSTANCE_ID,
      covenAvailable: false,
    });
  });

  it('publishes a rate-limit error at every pairing phase without retrying', async () => {
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
        state: 'error',
        code: 'rate_limited',
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

  it('resets packed SDK timeout errors at every pairing phase before reconciliation', async () => {
    for (const phase of ['create', 'poll', 'exchange'] as const) {
      for (const outcome of ['missing', 'ready'] as const) {
        const calls = rateLimitedCalls();
        const lateNativeMutation = deferred<void>();
        let lateMutationSettled = false;
        const timedOutClient = rateLimitedClient(
          phase,
          () => {
            void lateNativeMutation.promise.then(() => {
              lateMutationSettled = true;
            });
            return Promise.reject(
              Object.freeze({
                code: 'timeout',
                retryable: true,
              }),
            );
          },
          calls,
        );
        const reconciliation = nativeHost({
          credentialStatus: async () =>
            outcome === 'ready' ? validCredentialStatus() : { status: 'missing' },
        });
        const discover = vi
          .fn<CaveConnectionHost['discover']>()
          .mockImplementationOnce(async () => discoveryWithClient(timedOutClient))
          .mockImplementationOnce(reconciliation.discover);
        let resets = 0;
        const events: unknown[] = [];
        const subject = controller(
          hostPort(
            discover,
            async () => undefined,
            async () => {
              resets += 1;
            },
          ),
        );
        subject.subscribe((state) => {
          events.push(state);
        });

        await subject.start();
        await subject.beginPairing();

        const expected =
          outcome === 'ready'
            ? {
                state: 'ready',
                caveInstanceId: CAVE_INSTANCE_ID,
                covenAvailable: false,
              }
            : {
                state: 'pairing_required',
                caveInstanceId: CAVE_INSTANCE_ID,
              };
        expect(resets).toBe(1);
        expect(subject.getState()).toEqual(expected);
        expect(calls.pairingRequests).toHaveLength(1);
        expect(calls.polls).toBe(phase === 'create' ? 0 : 1);
        expect(calls.exchanges).toBe(phase === 'exchange' ? 1 : 0);
        expect(events).not.toContainEqual(
          expect.objectContaining({
            state: 'offline',
          }),
        );
        expect(events).not.toContainEqual(
          expect.objectContaining({
            state: 'error',
            code: 'pairing_expired',
          }),
        );

        lateNativeMutation.resolve();
        await settle();
        expect(lateMutationSettled).toBe(true);
        expect(subject.getState()).toEqual(expected);
      }
    }
  });

  it('does not let stale packed pairing rate limits overwrite cancellation recovery', async () => {
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
      const cancellation = subject.cancelPairing();
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
      await Promise.all([pairing, cancellation]);

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

  it('aborts a never-resolving packed pairing poll on cancellation and dispose', async () => {
    const pendingPoll = deferred<unknown>();
    const cancelPoll = deferred<void>();
    const disposePoll = deferred<void>();
    const pollEntries = [cancelPoll, disposePoll];
    let pollIndex = 0;
    const source = nativeHost({
      credentialStatus: async () => ({ status: 'missing' }),
      pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
      pairingPoll: async () => {
        pollEntries[pollIndex]?.resolve();
        pollIndex += 1;
        return pendingPoll.promise;
      },
    });
    const cancelSubject = controller(source);
    const disposeSubject = controller(source);

    await cancelSubject.start();
    const cancelled = cancelSubject.beginPairing();
    let cancelSettled = false;
    void cancelled.then(() => {
      cancelSettled = true;
    });
    await cancelPoll.promise;
    cancelSubject.cancelPairing();
    await settle();
    expect(cancelSettled).toBe(true);

    await disposeSubject.start();
    const disposed = disposeSubject.beginPairing();
    let disposeSettled = false;
    void disposed.then(() => {
      disposeSettled = true;
    });
    await disposePoll.promise;
    disposeSubject.dispose();
    await settle();
    expect(disposeSettled).toBe(true);

    pendingPoll.resolve({
      id: PAIRING_REQUEST_ID,
      status: 'pending',
      expiresAt: 2_000,
    });
    await Promise.all([cancelled, disposed]);
  });

  it('leaves the active pairing attempt intact when retry is requested', async () => {
    const pollEntered = deferred<void>();
    const pendingPoll = deferred<unknown>();
    let resets = 0;
    const subject = controller(
      nativeHost({
        credentialStatus: async () => ({ status: 'missing' }),
        pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
        pairingPoll: async () => {
          pollEntered.resolve();
          return pendingPoll.promise;
        },
        resetPairing: async () => {
          resets += 1;
          return { status: 'invalidated' };
        },
      }),
    );

    await subject.start();
    const pairing = subject.beginPairing();
    await pollEntered.promise;
    const retried = subject.retry();
    let retrySettled = false;
    void retried.then(() => {
      retrySettled = true;
    });
    await settle();

    expect(subject.getState().state).toBe('pairing');
    expect(resets).toBe(0);
    expect(retrySettled).toBe(false);

    const cancellation = subject.cancelPairing();
    pendingPoll.resolve({
      id: PAIRING_REQUEST_ID,
      status: 'pending',
      expiresAt: 2_000,
    });
    await Promise.all([pairing, retried, cancellation]);
    expect(resets).toBe(1);
    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
      reason: 'cancelled',
    });
  });

  it('resets a pending packed pairing creation before its late result and permits a fresh pairing', async () => {
    const pairingCreateEntered = deferred<void>();
    const pairingCreate = deferred<unknown>();
    let pairingCreates = 0;
    let credentialStatuses = 0;
    const subject = controller(
      nativeHost({
        credentialStatus: async () => {
          credentialStatuses += 1;
          return credentialStatuses < 3 ? { status: 'missing' } : validCredentialStatus();
        },
        pairingCreate: async () => {
          pairingCreates += 1;
          if (pairingCreates === 1) {
            pairingCreateEntered.resolve();
            return pairingCreate.promise;
          }
          return { requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 };
        },
        pairingPoll: async () => ({
          id: PAIRING_REQUEST_ID,
          status: 'approved',
          expiresAt: 2_000,
        }),
        pairingExchange: async () => ({ credential: credentialMetadata() }),
      }),
    );

    await subject.start();
    const pairing = subject.beginPairing();
    let settled = false;
    void pairing.then(() => {
      settled = true;
    });
    await pairingCreateEntered.promise;
    await subject.cancelPairing();
    await settle();

    expect(settled).toBe(true);
    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
      reason: 'cancelled',
    });

    pairingCreate.resolve({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 });
    await pairing;
    await subject.beginPairing();
    expect(subject.getState()).toEqual({
      state: 'ready',
      caveInstanceId: CAVE_INSTANCE_ID,
      covenAvailable: false,
    });
  });

  it('deduplicates reset, rediscovers after a reset failure, and leaks no native details', async () => {
    const canary = 'native-reset-secret-canary';
    const firstPoll = deferred<unknown>();
    const resetCalls: Array<Record<string, unknown> | undefined> = [];
    let credentialStatuses = 0;
    let pairingPolls = 0;
    const subject = controller(
      nativeHost({
        credentialStatus: async () => {
          credentialStatuses += 1;
          return credentialStatuses < 3 ? { status: 'missing' } : validCredentialStatus();
        },
        pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
        pairingPoll: async () => {
          pairingPolls += 1;
          return pairingPolls === 1
            ? firstPoll.promise
            : { id: PAIRING_REQUEST_ID, status: 'approved', expiresAt: 2_000 };
        },
        pairingExchange: async () => ({ credential: credentialMetadata() }),
        resetPairing: async (args) => {
          resetCalls.push(args);
          return Promise.reject(
            Object.freeze({
              cause: { secret: canary, path: canary, url: `https://${canary}.invalid` },
            }),
          );
        },
      }),
    );
    const events: unknown[] = [];
    subject.subscribe((state) => {
      events.push(state);
    });

    await subject.start();
    const pairing = subject.beginPairing();
    await settle();
    const firstCancellation = subject.cancelPairing();
    const secondCancellation = subject.cancelPairing();
    expect(secondCancellation).toBe(firstCancellation);
    await firstCancellation;
    await pairing;

    expect(resetCalls).toEqual([{ handle: 'native-discovery-handle' }]);
    expect(credentialStatuses).toBe(2);
    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
      reason: 'cancelled',
    });

    await subject.beginPairing();
    expect(subject.getState()).toEqual({
      state: 'ready',
      caveInstanceId: CAVE_INSTANCE_ID,
      covenAvailable: false,
    });
    for (const value of [...events, subject.getState()]) {
      expect(JSON.stringify(value)).not.toContain(canary);
      expect(inspect(value)).not.toContain(canary);
    }
  });

  it('does not abort an in-progress deduplicated native reset', async () => {
    const reset = deferred<unknown>();
    const pendingPoll = deferred<unknown>();
    let resetCalls = 0;
    const subject = controller(
      nativeHost({
        credentialStatus: async () => ({ status: 'missing' }),
        pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
        pairingPoll: async () => pendingPoll.promise,
        resetPairing: async () => {
          resetCalls += 1;
          return reset.promise;
        },
      }),
    );

    await subject.start();
    const pairing = subject.beginPairing();
    await settle();
    const firstReset = subject.cancelPairing();
    const duplicateReset = subject.cancelPairing();
    expect(duplicateReset).toBe(firstReset);
    expect(resetCalls).toBe(1);

    reset.resolve({ status: 'invalidated' });
    await Promise.all([pairing, firstReset]);
    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
      reason: 'cancelled',
    });
  });

  it('bounds native reset and invokes it before pairing retry or disposal', async () => {
    const testClock = clock();
    const neverPoll = deferred<unknown>();
    const neverReset = deferred<void>();
    const source = nativeHost({
      credentialStatus: async () => ({ status: 'missing' }),
      pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
      pairingPoll: async () => neverPoll.promise,
    });
    const bounded = controller(
      hostPort(source.discover, source.launch, () => neverReset.promise),
      testClock,
      10,
      50,
    );

    await bounded.start();
    const pairing = bounded.beginPairing();
    await settle();
    const cancellation = bounded.cancelPairing();
    await settle();
    testClock.advance(50);
    await cancellation;
    await pairing;
    expect(bounded.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
      reason: 'cancelled',
    });

    const resetRequests: Array<Record<string, unknown> | undefined> = [];
    let statusCalls = 0;
    const retrySource = nativeHost({
      credentialStatus: async () => {
        statusCalls += 1;
        return statusCalls === 1 ? { status: 'missing' } : validCredentialStatus();
      },
      pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
      pairingPoll: async () => neverPoll.promise,
      resetPairing: async (args) => {
        resetRequests.push(args);
        return { status: 'invalidated' };
      },
    });
    const retried = controller(retrySource);
    await retried.start();
    const retryPairing = retried.beginPairing();
    await settle();
    await retried.retry();
    await retryPairing;

    const disposeReset = deferred<unknown>();
    let disposeDiscoveries = 0;
    const disposeSource = nativeHost({
      discovery: async () => {
        disposeDiscoveries += 1;
        return discoverySnapshot();
      },
      credentialStatus: async () => ({ status: 'missing' }),
      pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
      pairingPoll: async () => neverPoll.promise,
      resetPairing: async (args) => {
        resetRequests.push(args);
        return disposeReset.promise;
      },
    });
    const disposed = controller(disposeSource);
    await disposed.start();
    const disposalPairing = disposed.beginPairing();
    await settle();
    disposed.dispose();
    await settle();
    await disposalPairing;
    expect(disposeDiscoveries).toBe(1);
    disposeReset.resolve({ status: 'invalidated' });
    await settle();
    expect(disposeDiscoveries).toBe(2);

    expect(resetRequests).toEqual([
      { handle: 'native-discovery-handle' },
      { handle: 'native-discovery-handle' },
    ]);
  });

  it('aborts an injected sleeper when pairing is cancelled', async () => {
    const testClock = clock();
    const pollEntered = deferred<void>();
    const subject = controller(
      nativeHost({
        credentialStatus: async () => ({ status: 'missing' }),
        pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
        pairingPoll: async () => {
          pollEntered.resolve();
          return {
            id: PAIRING_REQUEST_ID,
            status: 'pending',
            expiresAt: 2_000,
          };
        },
      }),
      testClock,
    );

    await subject.start();
    const pairing = subject.beginPairing();
    let settled = false;
    void pairing.then(() => {
      settled = true;
    });
    await pollEntered.promise;
    await settle();
    await settle();
    expect(testClock.pendingSleeps()).toBe(1);
    subject.cancelPairing();
    await settle();

    expect(settled).toBe(true);
    expect(testClock.aborts()).toBeGreaterThan(0);
    await pairing;
  });

  it('settles a dispatched packed exchange after retry while suppressing its late result', async () => {
    const exchangeEntered = deferred<void>();
    const exchangeResult = deferred<unknown>();
    const initial = nativeHost({
      credentialStatus: async () => ({ status: 'missing' }),
      pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
      pairingPoll: async () => ({
        id: PAIRING_REQUEST_ID,
        status: 'approved',
        expiresAt: 2_000,
      }),
      pairingExchange: async () => {
        exchangeEntered.resolve();
        return exchangeResult.promise;
      },
    });
    const replacement = nativeHost({
      health: async () => healthEnvelope(NEXT_CAVE_INSTANCE_ID),
      credentialStatus: async () => validCredentialStatus('chat:read', NEXT_CAVE_INSTANCE_ID),
    });
    const discover = vi
      .fn<CaveConnectionHost['discover']>()
      .mockImplementationOnce(initial.discover)
      .mockImplementationOnce(replacement.discover);
    const subject = controller(hostPort(discover));

    await subject.start();
    const pairing = subject.beginPairing();
    let pairingSettled = false;
    void pairing.then(() => {
      pairingSettled = true;
    });
    await exchangeEntered.promise;
    await subject.retry();
    await settle();

    expect(pairingSettled).toBe(true);
    expect(subject.getState()).toEqual({
      state: 'ready',
      caveInstanceId: NEXT_CAVE_INSTANCE_ID,
      covenAvailable: false,
    });

    exchangeResult.resolve({ credential: credentialMetadata() });
    await settle();
    expect(subject.getState()).toEqual({
      state: 'ready',
      caveInstanceId: NEXT_CAVE_INSTANCE_ID,
      covenAvailable: false,
    });
    await pairing;
  });

  it('reconciles reset/exchange races through a fresh packed credential status', async () => {
    for (const outcome of ['missing', 'ready'] as const) {
      const exchangeEntered = deferred<void>();
      const exchange = deferred<unknown>();
      const resetCalls: Array<Record<string, unknown> | undefined> = [];
      let credentialStatuses = 0;
      const subject = controller(
        nativeHost({
          credentialStatus: async () => {
            credentialStatuses += 1;
            if (credentialStatuses === 1 || outcome === 'missing') {
              return { status: 'missing' };
            }
            return validCredentialStatus();
          },
          pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
          pairingPoll: async () => ({
            id: PAIRING_REQUEST_ID,
            status: 'approved',
            expiresAt: 2_000,
          }),
          pairingExchange: async () => {
            exchangeEntered.resolve();
            return exchange.promise;
          },
          resetPairing: async (args) => {
            resetCalls.push(args);
            return { status: 'invalidated' };
          },
        }),
      );

      await subject.start();
      const pairing = subject.beginPairing();
      await exchangeEntered.promise;
      const reset = subject.cancelPairing();
      exchange.resolve({ credential: credentialMetadata() });
      await Promise.all([pairing, reset]);

      expect(resetCalls).toEqual([{ handle: 'native-discovery-handle' }]);
      expect(subject.getState()).toEqual(
        outcome === 'ready'
          ? {
              state: 'ready',
              caveInstanceId: CAVE_INSTANCE_ID,
              covenAvailable: false,
            }
          : {
              state: 'pairing_required',
              caveInstanceId: CAVE_INSTANCE_ID,
              reason: 'cancelled',
            },
      );
    }
  });

  it('does not associate an unvalidated replacement client with the previous instance', async () => {
    let replacementPairings = 0;
    let replacementForgets = 0;
    const healthy = nativeHost();
    const incompatible = nativeHost({
      health: async () => healthEnvelope(CAVE_INSTANCE_ID, '99.0.0'),
      pairingCreate: async () => {
        replacementPairings += 1;
        return { requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 };
      },
      forgetCredential: async () => {
        replacementForgets += 1;
        return { status: 'deleted' };
      },
    });
    const discover = vi
      .fn<CaveConnectionHost['discover']>()
      .mockImplementationOnce(healthy.discover)
      .mockImplementationOnce(incompatible.discover);
    const subject = controller(hostPort(discover));

    await subject.start();
    expect(subject.getState().state).toBe('ready');
    await subject.retry();
    expect(subject.getState().state).toBe('incompatible');
    await subject.beginPairing();
    await subject.forgetCredential();

    expect(replacementPairings).toBe(0);
    expect(replacementForgets).toBe(0);
  });

  it('does not use a failed replacement client for pairing or forgetting', async () => {
    let replacementPairings = 0;
    let replacementForgets = 0;
    const healthy = nativeHost();
    const unavailable = nativeHost({
      health: async () => errorEnvelope('service_unavailable', true),
      pairingCreate: async () => {
        replacementPairings += 1;
        return { requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 };
      },
      forgetCredential: async () => {
        replacementForgets += 1;
        return { status: 'deleted' };
      },
    });
    const discover = vi
      .fn<CaveConnectionHost['discover']>()
      .mockImplementationOnce(healthy.discover)
      .mockImplementationOnce(unavailable.discover);
    const subject = controller(hostPort(discover));

    await subject.start();
    await subject.retry();
    expect(subject.getState().state).toBe('offline');
    await subject.beginPairing();
    await subject.forgetCredential();

    expect(replacementPairings).toBe(0);
    expect(replacementForgets).toBe(0);
  });

  it('isolates throwing and mutating subscribers from controller transitions', async () => {
    const subject = controller(
      nativeHost({
        credentialStatus: async () => ({ status: 'missing' }),
      }),
    );
    const late = vi.fn();
    const second = vi.fn(() => {
      throw new Error('listener-secret-canary');
    });
    const first = vi.fn((state: { state: string }) => {
      if (state.state === 'discovering') {
        removeSecond();
        subject.subscribe(late);
      }
    });
    subject.subscribe(first);
    const removeSecond = subject.subscribe(second);

    await subject.start();

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenLastCalledWith({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });
    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
    });
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
    const approvalPollEntered = deferred<void>();
    let cancelledExchanges = 0;
    const cancelled = controller(
      nativeHost({
        credentialStatus: async () => ({ status: 'missing' }),
        pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 2_000 }),
        pairingPoll: async () => {
          approvalPollEntered.resolve();
          return approval.promise;
        },
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
    expect(expired.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
      reason: 'expired',
    });

    await cancelled.start();
    const pendingCancellation = cancelled.beginPairing();
    await approvalPollEntered.promise;
    await cancelled.cancelPairing();
    approval.resolve({
      id: PAIRING_REQUEST_ID,
      status: 'approved',
      expiresAt: 2_000,
    });
    await pendingCancellation;
    expect(cancelled.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
      reason: 'cancelled',
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

    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
      reason: 'expired',
    });
    expect(exchanges).toBe(0);
  });

  it('uses pairing expiry as the absolute poll deadline rather than operation timeout', async () => {
    const testClock = clock(1_000);
    const neverPolls = deferred<unknown>();
    let exchanges = 0;
    let resets = 0;
    const subject = controller(
      nativeHost({
        credentialStatus: async () => ({ status: 'missing' }),
        pairingCreate: async () => ({ requestId: PAIRING_REQUEST_ID, expiresAt: 1_050 }),
        pairingPoll: async () => neverPolls.promise,
        pairingExchange: async () => {
          exchanges += 1;
          return { credential: credentialMetadata() };
        },
        resetPairing: async () => {
          resets += 1;
          return { status: 'invalidated' };
        },
      }),
      testClock,
      10,
      500,
    );

    await subject.start();
    const pairing = subject.beginPairing();
    await settle();
    testClock.advance(50);
    await pairing;

    expect(subject.getState()).toEqual({
      state: 'pairing_required',
      caveInstanceId: CAVE_INSTANCE_ID,
      reason: 'expired',
    });
    expect(exchanges).toBe(0);
    expect(resets).toBe(1);
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
