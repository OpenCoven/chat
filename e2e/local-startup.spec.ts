import { expect, type Page, test } from '@playwright/test';

declare global {
  interface Window {
    __legacyStartupHolder?: IDBDatabase;
    __startupOpenCount: number;
    __startupOpenErrors: number;
    __startupClosedConnections: number;
    __startupNativeCalls: number;
  }
}

async function holdLegacyHistory(page: Page) {
  await page.route(
    '**/',
    (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html></html>',
      }),
    { times: 1 },
  );
  await page.goto('/');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('opencoven-chat', 1);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('meta', { keyPath: 'key' }).put({ key: 'schemaVersion', value: 1 });
          const conversations = db.createObjectStore('conversations', { keyPath: 'id' });
          conversations.createIndex('by_updated', ['updatedAt', 'id']);
          const messages = db.createObjectStore('messages', { keyPath: 'id' });
          messages.createIndex('by_conversation', ['conversationId', 'createdAt', 'id']);
          const timestamp = '2026-09-11T00:00:00.000Z';
          conversations.put({
            id: 'saved-parent',
            familiarId: 'local',
            title: 'Retained startup history',
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          messages.put({
            id: 'saved-message',
            conversationId: 'saved-parent',
            parentId: null,
            role: 'user',
            text: 'History must not disappear',
            createdAt: timestamp,
          });
        };
        request.onsuccess = () => {
          window.__legacyStartupHolder = request.result;
          resolve();
        };
      }),
  );
}

async function instrumentOpening(page: Page, failFirst = false) {
  await page.addInitScript((fail) => {
    window.__startupOpenCount = 0;
    window.__startupOpenErrors = 0;
    window.__startupClosedConnections = 0;
    window.__startupNativeCalls = 0;
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: () => {
          window.__startupNativeCalls += 1;
          return Promise.reject(new Error('Unexpected native startup invocation'));
        },
      },
    });
    const open = IDBFactory.prototype.open;
    const close = IDBDatabase.prototype.close;
    IDBFactory.prototype.open = function (...args) {
      window.__startupOpenCount += 1;
      if (fail && window.__startupOpenCount === 1) {
        throw new DOMException('Injected present-factory open denial', 'SecurityError');
      }
      const request = Reflect.apply(open, this, args) as IDBOpenDBRequest;
      request.addEventListener('error', () => {
        window.__startupOpenErrors += 1;
      });
      return request;
    };
    IDBDatabase.prototype.close = function () {
      window.__startupClosedConnections += 1;
      return Reflect.apply(close, this, []);
    };
  }, failFirst);
}

test('a blocked legacy upgrade keeps history, bounds retries and aborts its abandoned open before explicit retry', async ({
  page,
  context,
}) => {
  const holder = await context.newPage();
  await holdLegacyHistory(holder);
  await instrumentOpening(page);
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Local chat storage could not be opened');
  await expect(page.getByRole('button', { name: 'New', exact: true })).toHaveCount(0);
  for (let retry = 0; retry < 3; retry += 1) {
    await page.getByRole('button', { name: 'Retry local storage' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
  }
  expect(await page.evaluate(() => window.__startupOpenCount)).toBe(1);
  await holder.evaluate(() => window.__legacyStartupHolder?.close());
  await expect.poll(() => page.evaluate(() => window.__startupOpenErrors)).toBe(1);
  expect(await page.evaluate(() => window.__startupClosedConnections)).toBe(1);
  const abandoned = await holder.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('opencoven-chat', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['meta', 'conversations', 'messages']);
          const schema = tx.objectStore('meta').get('schemaVersion');
          const message = tx.objectStore('messages').get('saved-message');
          const operations = tx.objectStore('conversations').indexNames.contains('by_operation');
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
          tx.oncomplete = () => {
            resolve({
              version: db.version,
              schema: schema.result.value,
              text: message.result.text,
              operations,
            });
            db.close();
          };
        };
      }),
  );
  expect(abandoned).toEqual({
    version: 1,
    schema: 1,
    text: 'History must not disappear',
    operations: false,
  });
  await expect(page.getByRole('button', { name: 'Retry local storage' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry local storage' }).click();
  await expect(page.getByRole('heading', { name: 'Retained startup history' })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Messages' }).getByText('History must not disappear'),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__startupOpenCount)).toBe(2);
  expect(await page.evaluate(() => window.__startupNativeCalls)).toBe(0);
  await holder.close();
});

test('a present-factory open error uses the retry gate and a successful retry restores retained history without Cave', async ({
  page,
  context,
}) => {
  const holder = await context.newPage();
  await holdLegacyHistory(holder);
  await holder.evaluate(() => window.__legacyStartupHolder?.close());
  await instrumentOpening(page, true);
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Local chat storage could not be opened');
  await expect(page.getByRole('button', { name: 'New', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry local storage' }).click();
  await expect(page.getByRole('heading', { name: 'Retained startup history' })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Messages' }).getByText('History must not disappear'),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__startupOpenCount)).toBe(2);
  expect(await page.evaluate(() => window.__startupNativeCalls)).toBe(0);
  await holder.close();
});

test('a genuinely absent IndexedDB API retains the disclosed memory-only mode', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByText(/these messages are kept in memory only/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry local storage' })).toHaveCount(0);
});
