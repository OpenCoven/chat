import { expect, test } from '@playwright/test';

test('leaves legacy notes, import receipts, and discard tombstones unchanged', async ({ page }) => {
  await page.route(
    '**/',
    (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
    { times: 1 },
  );
  await page.goto('/');
  const original = await page.evaluate(async () => {
    const records = {
      conversations: [
        { id: 'parent', familiarId: 'local', title: 'Private local notes' },
        {
          id: 'discarded',
          familiarId: 'local',
          title: 'Discarded note',
          side: {
            parentConversationId: 'parent',
            operationKey: 'retained-create',
            state: 'discarded',
          },
        },
      ],
      messages: [
        {
          id: 'saved',
          conversationId: 'parent',
          parentId: null,
          role: 'user',
          text: 'Do not submit this note to a model.',
          broughtBack: {
            operationKey: 'reviewed-import',
            sideConversationId: 'discarded',
            sourceMessageIds: ['source'],
          },
        },
      ],
    };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('opencoven-chat', 1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('meta', { keyPath: 'key' }).put({ key: 'schemaVersion', value: 1 });
        const conversations = db.createObjectStore('conversations', { keyPath: 'id' });
        const messages = db.createObjectStore('messages', { keyPath: 'id' });
        for (const row of records.conversations) conversations.put(row);
        for (const row of records.messages) messages.put(row);
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
    return records;
  });

  await page.goto('/');
  await expect(page.locator('.fr-shell')).toBeVisible();
  await expect(page.getByText(/desktop app/i).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText(/desktop app/i).first()).toBeVisible();

  const retained = await page.evaluate(
    () =>
      new Promise<{ version: number; conversations: unknown[]; messages: unknown[] }>(
        (resolve, reject) => {
          const request = indexedDB.open('opencoven-chat');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(['conversations', 'messages'], 'readonly');
            const conversations = tx.objectStore('conversations').getAll();
            const messages = tx.objectStore('messages').getAll();
            tx.onabort = () => {
              db.close();
              reject(tx.error);
            };
            tx.oncomplete = () => {
              resolve({
                version: db.version,
                conversations: conversations.result,
                messages: messages.result,
              });
              db.close();
            };
          };
        },
      ),
  );
  expect(retained.version).toBe(1);
  expect(retained.conversations).toEqual(
    [...original.conversations].sort((a, b) => a.id.localeCompare(b.id)),
  );
  expect(retained.messages).toEqual(original.messages);
  await expect(page.getByText('Do not submit this note to a model.')).toHaveCount(0);
});
