import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __mockInvokeCallCounts?: Record<string, number>;
  }
}

test('renders the Phase 1 read-only happy path with mocked Tauri commands', async ({ page }) => {
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
            version: 1,
            endpoint: 'http://127.0.0.1:3020',
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
    const NATIVE_HANDLE = 'mock-native-handle';

    // The Tauri JS wrapper (`@tauri-apps/api/core`) always forwards a concrete
    // second argument to `window.__TAURI_INTERNALS__.invoke` -- it defaults to
    // `{}` when the caller omits args entirely, it never forwards `undefined`.
    // Both forms are treated as "no meaningful args" below.
    function isEmptyArgs(args: unknown): boolean {
      return (
        args === undefined ||
        (typeof args === 'object' &&
          args !== null &&
          !Array.isArray(args) &&
          Object.keys(args as Record<string, unknown>).length === 0)
      );
    }

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
              if (!isEmptyArgs(args)) {
                throw new Error(
                  `cave_read_discovery must not receive sensitive/native authority args, got ${JSON.stringify(args)}`,
                );
              }
              return Promise.resolve(discovery);
            case 'cave_health':
              assertExactArgs(command, args, { handle: NATIVE_HANDLE });
              return Promise.resolve(health);
            case 'cave_credential_status':
              assertExactArgs(command, args, { handle: NATIVE_HANDLE });
              return Promise.resolve({
                status: 'valid',
                access: 'chat:read',
                health,
              });
            case 'cave_list_familiars':
              assertExactArgs(command, args, {
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
              assertExactArgs(command, args, {
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
              assertExactArgs(command, args, {
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
              assertExactArgs(command, args, {
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
              assertExactArgs(command, args, {
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
