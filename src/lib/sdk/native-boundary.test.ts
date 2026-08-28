import { inspect } from 'node:util';
import { createManagedCaveClient } from '@opencoven/cave-client/managed';
import type { OperationContext } from '@opencoven/sdk-core/browser';
import { describe, expect, it, vi } from 'vitest';

import {
  createCaveManagedCredentialTransport,
  createCaveManagedDiscoveryBinding,
  createCaveManagedDiscoverySource,
  invokeNative,
  type NativeSdkInvoke,
} from './native-boundary';

const opaqueResponse = Object.freeze({
  statusCode: 200,
  payload: Object.freeze({ safe: true }),
});
const PAIRING_REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function expectNativeOperation(value: unknown, maximumTimeoutMs = 5_000): void {
  expect(value).toEqual({
    attemptId: expect.stringMatching(ATTEMPT_ID_PATTERN),
    timeoutMs: expect.any(Number),
  });
  const timeoutMs = (value as { timeoutMs: number }).timeoutMs;
  expect(timeoutMs).toBeGreaterThan(0);
  expect(timeoutMs).toBeLessThanOrEqual(maximumTimeoutMs);
}

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
    await transport.managedPairingPoll(PAIRING_REQUEST_ID);
    await transport.managedPairingExchange(PAIRING_REQUEST_ID);
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
    expect(invoke).toHaveBeenCalledWith('cave_read_discovery', {
      operation: expect.any(Object),
    });
    expectNativeOperation(invoke.mock.calls[0]?.[1]?.operation);
  });

  it('binds every managed transport command to an opaque discovery handle', async () => {
    const invoke = vi.fn<NativeSdkInvoke>().mockResolvedValue(opaqueResponse);
    const transport = createCaveManagedCredentialTransport(invoke, 'native-discovery-handle');

    await transport.health();
    await transport.managedPairingPoll(PAIRING_REQUEST_ID);
    await transport.listFamiliars?.({ limit: 20 });

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'cave_health',
      'cave_pairing_poll',
      'cave_list_familiars',
    ]);
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      handle: 'native-discovery-handle',
    });
    expect(invoke.mock.calls[1]?.[1]).toMatchObject({
      handle: 'native-discovery-handle',
      requestId: PAIRING_REQUEST_ID,
    });
    expect(invoke.mock.calls[2]?.[1]).toMatchObject({
      handle: 'native-discovery-handle',
      page: { limit: 20 },
    });
    for (const [, args] of invoke.mock.calls) {
      expectNativeOperation(args?.operation);
    }
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

    await transport.managedPairingPoll(PAIRING_REQUEST_ID);
    await transport.managedPairingExchange(PAIRING_REQUEST_ID);

    expect(JSON.stringify(invoke.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(await transport.managedCredentialStatus())).not.toContain(secret);
  });

  it('preserves bounded native timeout, abort, body-limit, and proof classifications only', async () => {
    const canary = 'native-crypto-cause-secret-canary';

    for (const expected of [
      { code: 'timeout', retryable: true },
      { code: 'aborted', retryable: false },
      { code: 'body_limit', retryable: false },
      { code: 'reconcile_required', retryable: false },
    ]) {
      const rejection = Object.assign(Object.create(null), expected, {
        message: canary,
        cause: { secret: canary },
        headers: { authorization: canary },
      });
      const error = await invokeNative(
        vi.fn<NativeSdkInvoke>().mockRejectedValue(rejection),
        'cave_health',
      ).catch((value) => value);

      expect(error).toMatchObject(expected);
      expect(Object.keys(error as object).sort()).toEqual(['code', 'message', 'retryable']);
      expect(Object.isFrozen(error as object)).toBe(true);
      expect(inspect(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
    }
  });

  it('sends abort-before-start to the narrow cancel command without starting native I/O', async () => {
    const secret = 'abort-before-start-secret-canary';
    const controller = new AbortController();
    controller.abort(new Error(secret));
    const invoke = vi.fn<NativeSdkInvoke>().mockImplementation(async (command) => {
      if (command === 'cave_cancel_operation') {
        return { status: 'queued' };
      }
      return opaqueResponse;
    });
    const transport = createCaveManagedCredentialTransport(invoke, 'native-discovery-handle');

    const error = await transport
      .health({
        signal: controller.signal,
        deadline: performance.now() + 1_000,
      })
      .catch((rejection) => rejection);

    expect(error).toMatchObject({ code: 'aborted', retryable: false });
    expect(invoke.mock.calls).toHaveLength(1);
    expect(invoke.mock.calls[0]?.[0]).toBe('cave_cancel_operation');
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      attemptId: expect.stringMatching(ATTEMPT_ID_PATTERN),
      reason: 'aborted',
    });
    expect(inspect([error, invoke.mock.calls])).not.toContain(secret);
  });

  it('cancels an in-flight native operation by opaque attempt ID and redacts the signal reason', async () => {
    const secret = 'in-flight-abort-secret-canary';
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const invoke = vi.fn<NativeSdkInvoke>().mockImplementation(async (command) => {
      if (command === 'cave_health') {
        markStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error('late native result');
      }
      if (command === 'cave_cancel_operation') {
        return { status: 'cancelled' };
      }
      throw new Error('unexpected command');
    });
    const transport = createCaveManagedCredentialTransport(invoke, 'native-discovery-handle');
    const controller = new AbortController();
    const operation = transport.health({
      signal: controller.signal,
      deadline: performance.now() + 1_000,
    });

    await started;
    controller.abort(new Error(secret));
    const error = await operation.catch((rejection) => rejection);
    const healthCall = invoke.mock.calls.find(([command]) => command === 'cave_health');
    const cancelCall = invoke.mock.calls.find(([command]) => command === 'cave_cancel_operation');
    const nativeOperation = healthCall?.[1]?.operation as
      | { attemptId: string; timeoutMs: number }
      | undefined;

    expect(error).toMatchObject({ code: 'aborted', retryable: false });
    expect(nativeOperation?.attemptId).toMatch(ATTEMPT_ID_PATTERN);
    expect(nativeOperation?.timeoutMs).toBeGreaterThan(0);
    expect(nativeOperation?.timeoutMs).toBeLessThanOrEqual(1_000);
    expect(cancelCall?.[1]).toEqual({
      attemptId: nativeOperation?.attemptId,
      reason: 'aborted',
    });
    expect(JSON.stringify([healthCall, cancelCall, error])).not.toContain(secret);
    expect(healthCall?.[1]).not.toHaveProperty('signal');
    expect(healthCall?.[1]).not.toHaveProperty('deadline');
    expect(healthCall?.[1]).not.toHaveProperty('error');
  });

  it('propagates a managed SDK deadline to native cancellation and caps native duration', async () => {
    const invoke = vi.fn<NativeSdkInvoke>().mockImplementation(async (command) => {
      if (command === 'cave_health') {
        return await new Promise<never>(() => undefined);
      }
      if (command === 'cave_cancel_operation') {
        return { status: 'cancelled' };
      }
      throw new Error('unexpected command');
    });
    const client = createManagedCaveClient({
      transport: createCaveManagedCredentialTransport(invoke, 'native-discovery-handle'),
    });

    await expect(client.health({ timeoutMs: 10 })).rejects.toMatchObject({
      normalized: {
        code: 'timeout',
      },
    });
    const healthCall = invoke.mock.calls.find(([command]) => command === 'cave_health');
    const cancelCall = invoke.mock.calls.find(([command]) => command === 'cave_cancel_operation');
    const operation = healthCall?.[1]?.operation as
      | { attemptId: string; timeoutMs: number }
      | undefined;

    expect(operation?.attemptId).toMatch(ATTEMPT_ID_PATTERN);
    expect(operation?.timeoutMs).toBeGreaterThan(0);
    expect(operation?.timeoutMs).toBeLessThanOrEqual(10);
    expect(cancelCall?.[1]).toEqual({
      attemptId: operation?.attemptId,
      reason: 'timeout',
    });
  });

  it('rejects malformed operation context and caps long deadlines at the Rust maximum', async () => {
    const secret = 'hostile-operation-context-secret-canary';
    const invalidInvoke = vi.fn<NativeSdkInvoke>().mockResolvedValue(opaqueResponse);
    const invalidTransport = createCaveManagedCredentialTransport(
      invalidInvoke,
      'native-discovery-handle',
    );
    await expect(
      invalidTransport.health({
        signal: new AbortController().signal,
        deadline: Number.NaN,
      }),
    ).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
    expect(invalidInvoke).not.toHaveBeenCalled();

    const hostileContext = Object.create(null) as OperationContext;
    Object.defineProperty(hostileContext, 'signal', {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
    const hostileError = await invalidTransport
      .health(hostileContext)
      .catch((rejection) => rejection);
    expect(hostileError).toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
    expect(inspect(hostileError)).not.toContain(secret);
    expect(invalidInvoke).not.toHaveBeenCalled();

    const invoke = vi.fn<NativeSdkInvoke>().mockResolvedValue(opaqueResponse);
    const transport = createCaveManagedCredentialTransport(invoke, 'native-discovery-handle');
    await transport.health({
      signal: new AbortController().signal,
      deadline: performance.now() + 60_000,
    });
    expectNativeOperation(invoke.mock.calls[0]?.[1]?.operation, 5_000);
  });

  it('rejects unbounded pages and non-canonical conversation IDs before native invocation', async () => {
    const invoke = vi.fn<NativeSdkInvoke>().mockResolvedValue(opaqueResponse);
    const transport = createCaveManagedCredentialTransport(invoke, 'native-discovery-handle');

    await expect(transport.listFamiliars?.({ limit: 0 })).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
    await expect(transport.listFamiliars?.({})).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
    await expect(transport.listProjects?.({ limit: 101 })).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
    await expect(transport.listConversations?.({ limit: 20, cursor: 'A' })).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
    await expect(transport.getConversation?.('..')).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
    await expect(
      transport.listConversationMessages?.('conversation/escape', { limit: 20 }),
    ).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
    await expect(
      transport.managedPairingCreate({
        appName: 'OpenCoven Chat',
        installationId: '00000000-0000-4000-8000-000000000001',
        scopes: ['chat:write'],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
    await expect(
      transport.managedPairingCreate({
        appName: 'OpenCoven Chat',
        installationId: '00000000-0000-4000-8000-000000000001',
        scopes: ['chat:read'],
        headers: { authorization: 'forbidden' },
      } as never),
    ).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
    await expect(transport.managedPairingPoll('../request')).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects malformed authority handles before constructing a native transport', () => {
    expect(() =>
      createCaveManagedCredentialTransport(
        vi.fn<NativeSdkInvoke>().mockResolvedValue(opaqueResponse),
        '../authority',
      ),
    ).toThrow();
  });

  it('returns a fresh frozen native snapshot and rejects forbidden native fields', async () => {
    const native = Object.freeze({ status: 'missing', values: Object.freeze(['safe']) });
    const transport = createCaveManagedCredentialTransport(
      vi.fn<NativeSdkInvoke>().mockResolvedValue(native),
      'native-discovery-handle',
    );

    const snapshot = await transport.managedCredentialStatus();
    expect(snapshot).toEqual(native);
    expect(snapshot).not.toBe(native);
    expect(Object.isFrozen(snapshot as object)).toBe(true);
    expect(Object.isFrozen((snapshot as { values: unknown[] }).values)).toBe(true);
    expect((snapshot as { values: unknown[] }).values).not.toBe(native.values);

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

  it('fails closed on hostile native arrays and nested forbidden fields', async () => {
    const overriddenMap = ['safe'];
    Object.setPrototypeOf(
      overriddenMap,
      Object.freeze({
        map() {
          return ['attacker-controlled-map-result'];
        },
      }),
    );

    const sparse = ['safe'] as unknown[];
    sparse.length = 2;

    const accessor = ['safe'];
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get() {
        return 'attacker-controlled-accessor-result';
      },
    });

    const extraKey = ['safe'] as unknown[] & { extra?: string };
    extraKey.extra = 'attacker-controlled-extra-result';

    const customPrototype = ['safe'];
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));

    const proxy = new Proxy(['safe'], {
      ownKeys() {
        throw new Error('attacker-controlled-proxy-trap');
      },
    });

    const nestedForbidden = {
      safe: [{ cause: { path: 'native-path-secret-canary' } }],
    };
    const hostileValues: unknown[] = [
      overriddenMap,
      sparse,
      accessor,
      extraKey,
      customPrototype,
      proxy,
      nestedForbidden,
    ];

    const diagnostics = await Promise.all(
      hostileValues.map(async (hostile) => {
        const diagnostic = await invokeNative(
          vi.fn<NativeSdkInvoke>().mockResolvedValue(hostile),
          'cave_health',
        ).catch((rejection) => rejection);
        expect(diagnostic).toEqual({
          code: 'invalid_response',
          retryable: false,
          message: 'Cave response was invalid.',
        });
        expect(Object.isFrozen(diagnostic as object)).toBe(true);
        expect(diagnostic).not.toBe(hostile);
        return diagnostic;
      }),
    );

    expect(new Set(diagnostics).size).toBe(diagnostics.length);
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
    expect(Object.isFrozen(error as object)).toBe(true);
    expect(error).not.toBe(hostile);
    for (const snapshot of snapshots) {
      expect(snapshot).not.toContain(secret);
    }
  });
});
