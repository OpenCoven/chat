import { expect, type Page, test } from '@playwright/test';

const AUTHORITY = {
  handle: 'authority:00000000-0000-4000-8000-000000000001',
  generation: 1,
};
const INSTANCE_ID = '00000000-0000-4000-8000-000000000002';
const DIAGNOSTIC_ID = '00000000-0000-4000-8000-000000000009';

async function installTauriMock(page: Page) {
  await page.addInitScript(
    ({ authority, instanceId }: { authority: typeof AUTHORITY; instanceId: string }) => {
      type Callback = (value: unknown) => void;
      type MockWindow = Window & {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
          transformCallback: (callback?: Callback, once?: boolean) => number;
          unregisterCallback: (id: number) => void;
          runCallback: (id: number, value: unknown) => void;
        };
        __TAURI_EVENT_PLUGIN_INTERNALS__: {
          unregisterListener: (event: string, id: number) => void;
        };
        __emitSdkConnectionEvent: (payload: unknown) => void;
      };
      const scope = window as unknown as MockWindow;
      const callbacks = new Map<number, Callback>();
      const listeners = new Map<string, number>();
      let callbackId = 0;
      let credentialPresent = false;
      let conversationPage = 0;

      const envelope = (
        requestId: string,
        capabilities: string[],
        operations: string[],
        data: unknown,
        cursor?: unknown,
      ) => ({
        statusCode: 200,
        payload: {
          apiVersion: '1.0',
          minimumClientVersion: '0.1.0',
          requestId,
          capabilities,
          operations,
          data,
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      const operation = (input: Record<string, unknown>, result: unknown) => ({
        authority: input.authority,
        requestId: input.requestId,
        result,
      });

      scope.__TAURI_INTERNALS__ = {
        async invoke(command, args = {}) {
          if (command === 'plugin:event|listen') {
            listeners.set(String(args.event), Number(args.handler));
            return 1;
          }
          if (command === 'plugin:event|unlisten') {
            listeners.delete(String(args.event));
            return null;
          }
          if (command === 'sdk_discovery_read') {
            return {
              handle: 'discovery:00000000-0000-4000-8000-000000000010',
              snapshot: {
                bytes: JSON.stringify({
                  version: 2,
                  endpoint: 'http://localhost:3020/',
                  pid: 10,
                  nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                  startedAt: '2026-08-28T10:00:00Z',
                  authority: {
                    mechanism: 'hpke-bound-v1',
                    mode: 'enforce',
                    keyId: 'tDE1VahIyqtAoH7mJ7uT3yzaF6EnK70vG9JMvTMCOAM',
                    publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                    suite: { kemId: 32, kdfId: 1, aeadId: 2 },
                  },
                }),
                record: {
                  identity: `sha256:${'a'.repeat(64)}`,
                  device: 1,
                  inode: 2,
                  processAlive: true,
                },
              },
            };
          }
          if (command === 'sdk_authority_establish') {
            return authority;
          }
          if (command === 'sdk_authority_close') {
            return { closed: true };
          }
          if (command === 'sdk_installation_identity') {
            return { installationId: '00000000-0000-4000-8000-000000000003' };
          }
          const input = args.input as Record<string, unknown>;
          const requestId = String(input.requestId);
          if (command === 'cave_health') {
            return operation(
              input,
              envelope(requestId, ['health'], ['health.read'], {
                instanceId,
                pairingRequired: !credentialPresent,
                releaseVersion: '0.1.0',
              }),
            );
          }
          if (command === 'cave_credential_state') {
            return operation(input, { status: credentialPresent ? 'present' : 'missing' });
          }
          if (command === 'cave_managed_pairing_create') {
            return operation(input, {
              requestId: '00000000-0000-4000-8000-000000000005',
              expiresAt: 2_000_000_000_000,
            });
          }
          if (command === 'cave_managed_pairing_poll') {
            return operation(input, {
              id: '00000000-0000-4000-8000-000000000005',
              status: 'approved',
              expiresAt: 2_000_000_000_000,
            });
          }
          if (command === 'cave_managed_pairing_exchange') {
            credentialPresent = true;
            return operation(input, {
              credential: {
                id: '00000000-0000-4000-8000-000000000007',
                appName: 'OpenCoven Chat',
                installationId: '00000000-0000-4000-8000-000000000003',
                scopes: ['chat:read'],
                createdAt: 1,
                lastUsedAt: null,
                revokedAt: null,
                revocationReason: null,
              },
            });
          }
          if (command === 'cave_forget_credential') {
            credentialPresent = false;
            return operation(input, true);
          }
          if (command === 'cave_list_familiars') {
            return operation(
              input,
              envelope(requestId, ['familiars', 'cursors'], ['familiars.list'], {
                familiars: [{ id: 'familiar-1', displayName: 'Astra', role: 'Research' }],
              }),
            );
          }
          if (command === 'cave_list_projects') {
            return operation(
              input,
              envelope(requestId, ['projects', 'cursors'], ['projects.list'], {
                projects: [
                  {
                    id: 'project-1',
                    name: 'OpenCoven',
                    root: 'OpenCoven',
                    createdAt: '2026-08-28T09:00:00Z',
                    updatedAt: '2026-08-28T10:00:00Z',
                  },
                ],
              }),
            );
          }
          if (command === 'cave_list_conversations') {
            conversationPage += 1;
            const second = conversationPage > 1;
            return operation(
              input,
              envelope(
                requestId,
                ['conversations', 'cursors'],
                ['conversations.list'],
                {
                  conversations: [
                    {
                      id: second ? 'conversation-2' : 'conversation-1',
                      familiarId: 'familiar-1',
                      title: second ? 'Second page' : 'Native integration',
                      updatedAt: second ? '2026-08-28T12:00:00Z' : '2026-08-28T11:00:00Z',
                    },
                  ],
                },
                second
                  ? { current: 'Yg', hasMore: false }
                  : { current: 'YQ', next: 'Yg', hasMore: true },
              ),
            );
          }
          if (command === 'cave_get_conversation') {
            return operation(
              input,
              envelope(requestId, ['conversations'], ['conversations.read'], {
                conversation: {
                  id: 'conversation-1',
                  familiarId: 'familiar-1',
                  title: 'Native integration',
                  updatedAt: '2026-08-28T11:00:00Z',
                },
              }),
            );
          }
          if (command === 'cave_list_conversation_messages') {
            return operation(
              input,
              envelope(requestId, ['conversation-messages', 'cursors'], ['messages.list'], {
                messages: [
                  {
                    id: 'message-1',
                    conversationId: 'conversation-1',
                    parentId: null,
                    role: 'assistant',
                    text: 'Canonical message',
                    createdAt: '2026-08-28T11:01:00Z',
                    attachmentCount: 0,
                    toolCount: 0,
                  },
                ],
              }),
            );
          }
          throw new Error(`Unexpected command: ${command}`);
        },
        transformCallback(callback) {
          const id = ++callbackId;
          if (callback !== undefined) {
            callbacks.set(id, callback);
          }
          return id;
        },
        unregisterCallback(id) {
          callbacks.delete(id);
        },
        runCallback(id, value) {
          callbacks.get(id)?.(value);
        },
      };
      scope.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener(event) {
          listeners.delete(event);
        },
      };
      scope.__emitSdkConnectionEvent = (payload) => {
        const id = listeners.get('sdk://connection');
        if (id !== undefined) {
          callbacks.get(id)?.({ event: 'sdk://connection', id: 1, payload });
        }
      };
    },
    { authority: AUTHORITY, instanceId: INSTANCE_ID },
  );
}

test('connects, pairs, reads, paginates, forgets, and handles revocation through mocked Tauri', async ({
  page,
}) => {
  await installTauriMock(page);
  await page.goto('/');

  await expect(page.getByRole('status', { name: 'Connection state' })).toContainText(
    'Approval required',
  );
  await page.getByRole('button', { name: 'Request approval' }).click();
  await expect(page.getByText(/approve this device in Cave/i)).toBeVisible();
  await page.getByRole('button', { name: 'Check approval' }).click();
  await page.getByRole('button', { name: 'Complete connection' }).click();

  await expect(page.getByRole('status', { name: 'Connection state' })).toContainText('Connected');
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toContainText(
    'Native integration',
  );
  await expect(page.getByText('Astra')).toBeVisible();
  const projects = page.getByRole('heading', { name: 'Projects' }).locator('..').locator('..');
  await expect(projects.getByText('OpenCoven', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: /Native integration/i }).click();
  await expect(page.getByText('Canonical message')).toBeVisible();
  await page.getByRole('button', { name: 'Load more conversations' }).click();
  await expect(page.getByText('Second page')).toBeVisible();

  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    indexed: (await indexedDB.databases()).length,
    body: document.body.textContent ?? '',
  }));
  expect(storage).toMatchObject({ local: 0, session: 0, indexed: 0 });
  expect(storage.body).not.toMatch(/Bearer|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/u);

  await page.evaluate(
    ({ authority, diagnosticId }) => {
      (
        window as unknown as {
          __emitSdkConnectionEvent: (payload: unknown) => void;
        }
      ).__emitSdkConnectionEvent({
        version: 1,
        authority,
        kind: 'credential_revoked',
        diagnosticId,
      });
    },
    { authority: AUTHORITY, diagnosticId: DIAGNOSTIC_ID },
  );
  await expect(page.getByRole('status', { name: 'Connection state' })).toContainText(
    'Access revoked',
  );

  await page.getByRole('button', { name: 'Pair again' }).click();
  await expect(page.getByRole('status', { name: 'Connection state' })).toContainText(
    'Approval required',
  );
});
