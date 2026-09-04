import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __mockInvokeCallCounts?: Record<string, number>;
  }
}

test('renders the Phase 1 read-only happy path through the mocked Tauri boundary', async ({
  page,
}) => {
  await page.addInitScript(() => {
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

    const health = {
      apiVersion: '1.0',
      minimumClientVersion: '0.1.0',
      capabilities,
      operations,
      data: {
        instanceId: '00000000-0000-4000-8000-000000000000',
        pairingRequired: false,
        releaseVersion: '0.1.0',
      },
    };
    const discovery = {
      handle: 'mock-native-handle',
      bytes: Array.from(
        new TextEncoder().encode(
          JSON.stringify({
            version: 2,
            endpoint: 'http://127.0.0.1:3020',
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
    const NATIVE_HANDLE = 'mock-native-handle';

    function isPlainObject(value: unknown): value is Record<string, unknown> {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    function deepEqual(a: unknown, b: unknown): boolean {
      if (a === b) {
        return true;
      }
      if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
      }
      if (isPlainObject(a) && isPlainObject(b)) {
        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        return (
          aKeys.length === bKeys.length &&
          aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
        );
      }
      return false;
    }

    // Fails the test (by throwing, which the mock invoke rejects with) the
    // instant a command is invoked with a shape other than exactly what the
    // native boundary is expected to send, catching JS/native regressions.
    function assertExactArgs(command: string, actual: unknown, expected: Record<string, unknown>) {
      if (!deepEqual(actual, expected)) {
        throw new Error(
          `Unexpected args for ${command}: received ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
        );
      }
    }

    function assertOperationArgs(
      command: string,
      actual: unknown,
      expected: Record<string, unknown>,
    ) {
      if (!isPlainObject(actual) || !isPlainObject(actual.operation)) {
        throw new Error(`Missing operation envelope for ${command}`);
      }
      const { operation, ...request } = actual;
      if (!deepEqual(request, expected)) {
        throw new Error(
          `Unexpected args for ${command}: received ${JSON.stringify(request)}, expected ${JSON.stringify(expected)}`,
        );
      }
      if (
        Object.keys(operation).length !== 2 ||
        typeof operation.attemptId !== 'string' ||
        !/^op1-[1-9][0-9]*-[1-9][0-9]*-[0-9a-f]{32}$/u.test(operation.attemptId) ||
        typeof operation.timeoutMs !== 'number' ||
        !Number.isSafeInteger(operation.timeoutMs) ||
        operation.timeoutMs < 1 ||
        operation.timeoutMs > 5_000
      ) {
        throw new Error(`Invalid operation envelope for ${command}`);
      }
      const serialized = JSON.stringify(actual).toLowerCase();
      for (const forbidden of ['authorization', 'bearer', 'pairingsecret', '"url"', '"body"']) {
        if (serialized.includes(forbidden)) {
          throw new Error(`Forbidden native-boundary field for ${command}: ${forbidden}`);
        }
      }
    }

    const callCounts: Record<string, number> = {};
    window.__mockInvokeCallCounts = callCounts;

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke(command: string, args?: unknown) {
          callCounts[command] = (callCounts[command] ?? 0) + 1;

          switch (command) {
            case 'app_installation_id':
              assertExactArgs(command, args, {});
              return Promise.resolve('0b59fec4-5d8e-4d5c-894d-39fcb5f3eef7');
            case 'cave_read_discovery':
              assertOperationArgs(command, args, {});
              return Promise.resolve(discovery);
            case 'cave_health':
              assertOperationArgs(command, args, { handle: NATIVE_HANDLE });
              return Promise.resolve(health);
            case 'cave_credential_status':
              assertOperationArgs(command, args, { handle: NATIVE_HANDLE });
              return Promise.resolve({
                status: 'valid',
                access: 'chat:read',
                health,
              });
            case 'cave_list_familiars':
              assertOperationArgs(command, args, {
                handle: NATIVE_HANDLE,
                page: { limit: 50 },
              });
              return Promise.resolve({
                ...health,
                data: {
                  familiars: [
                    {
                      id: 'familiar-1',
                      displayName: 'Mara',
                      role: 'Guide',
                    },
                  ],
                },
                cursor: {
                  current: 'cursor-familiars',
                  hasMore: false,
                },
              });
            case 'cave_list_projects':
              assertOperationArgs(command, args, {
                handle: NATIVE_HANDLE,
                page: { limit: 50 },
              });
              return Promise.resolve({
                ...health,
                data: {
                  projects: [
                    {
                      id: 'project-1',
                      name: 'OpenCoven Chat',
                      root: '/workspace/chat',
                      createdAt: '2026-08-25T00:00:00.000Z',
                      updatedAt: '2026-08-25T00:00:00.000Z',
                    },
                  ],
                },
                cursor: {
                  current: 'cursor-projects',
                  hasMore: false,
                },
              });
            case 'cave_list_conversations':
              assertOperationArgs(command, args, {
                handle: NATIVE_HANDLE,
                page: { limit: 50 },
              });
              return Promise.resolve({
                ...health,
                data: {
                  conversations: [
                    {
                      id: 'conversation-1',
                      familiarId: 'familiar-1',
                      title: 'Mocked native thread',
                      updatedAt: '2026-08-25T00:00:00.000Z',
                    },
                  ],
                },
                cursor: {
                  current: 'cursor-conversations',
                  hasMore: false,
                },
              });
            case 'cave_get_conversation':
              assertOperationArgs(command, args, {
                handle: NATIVE_HANDLE,
                conversationId: 'conversation-1',
              });
              return Promise.resolve({
                ...health,
                data: {
                  conversation: {
                    id: 'conversation-1',
                    familiarId: 'familiar-1',
                    title: 'Mocked native thread',
                    updatedAt: '2026-08-25T00:00:00.000Z',
                  },
                },
              });
            case 'cave_list_conversation_messages':
              assertOperationArgs(command, args, {
                handle: NATIVE_HANDLE,
                conversationId: 'conversation-1',
                page: { limit: 50 },
              });
              return Promise.resolve({
                ...health,
                data: {
                  messages: [
                    {
                      id: 'message-1',
                      conversationId: 'conversation-1',
                      parentId: null,
                      role: 'assistant',
                      text: 'Hello from mocked Cave.',
                      createdAt: '2026-08-25T00:00:00.000Z',
                      attachmentCount: 0,
                      toolCount: 0,
                    },
                  ],
                },
                cursor: {
                  current: 'cursor-messages',
                  hasMore: false,
                },
              });
            default:
              return Promise.reject(new Error(`Unhandled mock Tauri command: ${command}`));
          }
        },
      },
    });
  });

  await page.goto('/');

  // Cave is opt-in now: the app is already usable before this click.
  await expect(page.getByRole('button', { name: 'This device' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Connect to Cave' }).click();
  await page.getByRole('button', { name: 'Coven Cave' }).click();

  await expect(page.getByRole('heading', { name: 'Mocked native thread' })).toBeVisible();
  await expect(page.getByText('Hello from mocked Cave.')).toBeVisible();
  await expect(page.getByText('OpenCoven Chat', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Familiar' })).toHaveValue('familiar-1');
  await expect(page.locator('.chat-shell__familiar-meta')).toHaveText('Guide');
  await expect(page.getByText('Read-only chat')).toBeVisible();
  await expect(page.getByText('Cave connection requires the desktop app.')).toHaveCount(0);

  const callCounts = await page.evaluate(() => window.__mockInvokeCallCounts ?? {});
  const expectedCommands = [
    'app_installation_id',
    'cave_read_discovery',
    'cave_health',
    'cave_credential_status',
    'cave_list_familiars',
    'cave_list_projects',
    'cave_list_conversations',
    'cave_get_conversation',
    'cave_list_conversation_messages',
  ];
  for (const command of expectedCommands) {
    expect(callCounts[command], `expected ${command} to be invoked exactly once`).toBe(1);
  }
});
