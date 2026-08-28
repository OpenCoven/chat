import { inspect } from 'node:util';

import { createManagedCaveClient, isCaveClientError } from '@opencoven/cave-client/managed';
import { describe, expect, it } from 'vitest';

import { createCaveManagedCredentialTransport, type NativeSdkInvoke } from './native-boundary';

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

function clientV1HealthEnvelope() {
  return {
    apiVersion: '1.0',
    minimumClientVersion: '0.1.0',
    capabilities,
    operations,
    data: {
      instanceId: '00000000-0000-4000-8000-000000000000',
      pairingRequired: true,
      releaseVersion: '0.0.0',
    },
  };
}

function clientV1FamiliarsEnvelope() {
  return {
    apiVersion: '1.0',
    minimumClientVersion: '0.1.0',
    capabilities,
    operations,
    data: {
      familiars: [],
    },
  };
}

function managedClient(invoke: NativeSdkInvoke) {
  return createManagedCaveClient({
    transport: createCaveManagedCredentialTransport(invoke, 'native-authority-handle'),
  });
}

async function publicError(promise: Promise<unknown>) {
  const error = await promise.catch((rejection: unknown) => rejection);
  expect(isCaveClientError(error)).toBe(true);
  return error as { code: string; retryable: boolean };
}

describe('managed credential status native adapter end-to-end', () => {
  it('normalizes missing, revoked, and every valid access state through the packed client', async () => {
    const cases = [
      {
        native: { status: 'missing' },
        expected: { status: 'missing' },
      },
      {
        native: { status: 'revoked', health: clientV1HealthEnvelope() },
        expected: {
          status: 'revoked',
          health: {
            status: 'ok',
            apiVersion: '1.0',
            minimumClientVersion: '0.1.0',
            capabilities,
            operations,
            instanceId: '00000000-0000-4000-8000-000000000000',
            pairingRequired: true,
            releaseVersion: '0.0.0',
          },
        },
      },
      ...(['chat:read', 'scope_denied', 'service_unavailable', 'rate_limited'] as const).map(
        (access) => ({
          native: { status: 'valid', access, health: clientV1HealthEnvelope() },
          expected: {
            status: 'valid',
            access,
            health: {
              status: 'ok',
              apiVersion: '1.0',
              minimumClientVersion: '0.1.0',
              capabilities,
              operations,
              instanceId: '00000000-0000-4000-8000-000000000000',
              pairingRequired: true,
              releaseVersion: '0.0.0',
            },
          },
        }),
      ),
    ];

    for (const testCase of cases) {
      const calls: Array<[string, Record<string, unknown> | undefined]> = [];
      const client = managedClient(async (command, args) => {
        calls.push([command, args]);
        return testCase.native;
      });

      await expect(client.credentialStatus()).resolves.toEqual(testCase.expected);
      expect(calls).toEqual([
        [
          'cave_credential_status',
          {
            handle: 'native-authority-handle',
            operation: {
              attemptId: expect.any(String),
              timeoutMs: expect.any(Number),
            },
          },
        ],
      ]);
    }
  });

  it('uses raw Client v1 bodies for canonical reads and lets the SDK normalize Client v1 errors', async () => {
    const client = managedClient(async (command) => {
      if (command === 'cave_list_familiars') {
        return clientV1FamiliarsEnvelope();
      }
      throw new Error('unexpected command');
    });

    await expect(client.listFamiliars()).resolves.toEqual({ data: [] });

    const denied = managedClient(async () => ({
      apiVersion: '1.0',
      minimumClientVersion: '0.1.0',
      capabilities,
      operations,
      error: {
        code: 'scope_denied',
        message: 'Missing required scope.',
        retryable: false,
      },
    }));

    await expect(publicError(denied.listFamiliars())).resolves.toMatchObject({
      code: 'scope_denied',
      retryable: false,
    });
  });

  it('maps compare-and-delete current, absent, and changed outcomes without extra fields', async () => {
    const outcomes = [
      { native: { status: 'deleted' }, expected: true },
      { native: { status: 'missing' }, expected: false },
    ];

    for (const outcome of outcomes) {
      const client = managedClient(async () => outcome.native);
      await expect(client.forgetCredential()).resolves.toBe(outcome.expected);
    }

    const changed = managedClient(async () => ({ status: 'credential_update_in_progress' }));
    await expect(publicError(changed.forgetCredential())).resolves.toMatchObject({
      code: 'credential_update_in_progress',
      retryable: true,
    });
  });

  it('fails closed on forbidden fields and hostile native values without exposing native data', async () => {
    const secret = 'native-status-secret-canary';
    const hostileValues: unknown[] = [
      { status: 'missing', health: clientV1HealthEnvelope() },
      { status: 'missing', cause: { path: secret } },
      Object.defineProperty({ status: 'missing' }, 'cause', {
        enumerable: true,
        get() {
          throw new Error(secret);
        },
      }),
      new Proxy(
        { status: 'missing' },
        {
          ownKeys() {
            throw new Error(secret);
          },
        },
      ),
    ];

    for (const hostile of hostileValues) {
      const client = managedClient(async () => hostile);
      const error = await publicError(client.credentialStatus());
      expect(error).toMatchObject({ code: 'invalid_response', retryable: false });
      expect(inspect(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it('does not publish a stale native status completion', async () => {
    const secret = 'stale-native-status-secret-canary';
    let rejectStatus: ((reason?: unknown) => void) | undefined;
    const client = managedClient(
      () =>
        new Promise((_, reject) => {
          rejectStatus = reject;
        }),
    );

    const pending = client.credentialStatus();
    await Promise.resolve();
    rejectStatus?.(new Error(secret));

    const error = await publicError(pending);
    expect(error).toMatchObject({ code: 'service_unavailable', retryable: true });
    expect(inspect(error)).not.toContain(secret);
  });
});
