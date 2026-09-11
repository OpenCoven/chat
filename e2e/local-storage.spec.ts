import { expect, type Page, test } from '@playwright/test';
import { loseNextWriteAcknowledgement } from './helpers/local-continuity';

declare global {
  interface Window {
    __chatStorageReads: { full: number; writeFull: number; keyed: number; indexed: number };
  }
}

async function seedLegacyHistory(page: Page, count: number) {
  await page.route(
    '**/',
    (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
    { times: 1 },
  );
  await page.goto('/');
  await page.evaluate(async (size) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('opencoven-chat', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('meta', { keyPath: 'key' }).put({ key: 'schemaVersion', value: 1 });
        db.createObjectStore('conversations', { keyPath: 'id' }).createIndex('by_updated', [
          'updatedAt',
          'id',
        ]);
        db.createObjectStore('messages', { keyPath: 'id' }).createIndex('by_conversation', [
          'conversationId',
          'createdAt',
          'id',
        ]);
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['conversations', 'messages'], 'readwrite');
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        const timestamp = '2026-09-01T00:00:00.000Z';
        const base = { familiarId: 'local', createdAt: timestamp, updatedAt: timestamp };
        const conversations = tx.objectStore('conversations');
        conversations.put({ ...base, id: 'parent', title: 'Legacy parent', revision: 1 });
        for (const [id, state] of [
          ['side', 'open'],
          ['history', 'closed'],
          ['discarded', 'discarded'],
        ]) {
          conversations.put({
            ...base,
            id,
            title: `Legacy ${id}`,
            revision: 1,
            side: { parentConversationId: 'parent', operationKey: `create-${id}`, state },
          });
        }
        const messages = tx.objectStore('messages');
        messages.put({
          id: 'source',
          conversationId: 'side',
          parentId: null,
          role: 'user',
          text: 'Legacy source',
          createdAt: timestamp,
        });
        messages.put({
          id: 'imported',
          conversationId: 'parent',
          parentId: null,
          role: 'user',
          text: 'Legacy imported excerpt',
          createdAt: timestamp,
          broughtBack: {
            operationKey: 'legacy-import',
            sideConversationId: 'side',
            sourceMessageIds: ['source'],
          },
        });
        for (let i = 0; i < size; i += 1) {
          messages.put({
            id: `history-${i}`,
            conversationId: 'history',
            parentId: i ? `history-${i - 1}` : null,
            role: 'user',
            text: `Unrelated retained history ${i}`,
            createdAt: new Date(Date.parse(timestamp) + i).toISOString(),
          });
        }
      };
    });
  }, count);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Legacy parent', exact: true })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Messages' }).getByText('Legacy imported excerpt'),
  ).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Messages' }).getByText(text, { exact: true }),
  ).toBeVisible();
}

test('version-one IndexedDB migrates receipts and discard tombstones without rewriting history', async ({
  page,
}) => {
  await seedLegacyHistory(page, 50);
  const result = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('opencoven-chat');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (db.version !== 2) {
            resolve({ version: db.version });
            db.close();
            return;
          }
          const tx = db.transaction(['meta', 'conversations', 'messages']);
          const receipt = tx.objectStore('messages').index('by_operation').get('legacy-import');
          const tombstone = tx
            .objectStore('conversations')
            .index('by_operation')
            .get('create-discarded');
          const count = tx.objectStore('messages').count();
          const schema = tx.objectStore('meta').get('schemaVersion');
          const revision = tx.objectStore('meta').get('mutationRevision');
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
          tx.oncomplete = () => {
            resolve({
              version: db.version,
              receipt: receipt.result,
              tombstone: tombstone.result,
              count: count.result,
              schema: schema.result,
              revision: revision.result,
            });
            db.close();
          };
        };
      }),
  );
  expect(result).toMatchObject({
    version: 2,
    count: 52,
    schema: { value: 2 },
    revision: { value: 0 },
    receipt: {
      id: 'imported',
      text: 'Legacy imported excerpt',
      broughtBack: { operationKey: 'legacy-import' },
    },
    tombstone: { id: 'discarded', side: { state: 'discarded', operationKey: 'create-discarded' } },
  });
  await send(page, 'After migration');
  await page.reload();
  await expect(
    page.getByRole('list', { name: 'Messages' }).getByText('After migration'),
  ).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Messages' }).getByText('Legacy imported excerpt'),
  ).toBeVisible();
});

for (const size of [50, 20_000]) {
  test(`warm durable writes use bounded reads with ${size} unrelated retained messages`, async ({
    page,
  }) => {
    await seedLegacyHistory(page, size);
    await send(page, 'Warm snapshot');
    await page.evaluate(() => {
      window.__chatStorageReads = { full: 0, writeFull: 0, keyed: 0, indexed: 0 };
      const getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...args) {
        window.__chatStorageReads.full += 1;
        if (this.transaction.mode === 'readwrite') window.__chatStorageReads.writeFull += 1;
        return Reflect.apply(getAll, this, args);
      };
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (...args) {
        window.__chatStorageReads.keyed += 1;
        return Reflect.apply(get, this, args);
      };
      const indexedGet = IDBIndex.prototype.get;
      IDBIndex.prototype.get = function (...args) {
        window.__chatStorageReads.indexed += 1;
        return Reflect.apply(indexedGet, this, args);
      };
    });
    await send(page, 'First bounded append');
    await send(page, 'Second bounded append');
    await page.getByRole('button', { name: /^Legacy side/ }).click();
    await page.getByRole('checkbox', { name: /Legacy source/ }).check();
    await page.getByRole('button', { name: 'Review Bring back', exact: true }).click();
    await page.getByRole('textbox', { name: 'Reviewed excerpt' }).fill('Bounded reviewed import');
    await page.getByRole('button', { name: 'Bring back reviewed excerpt', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Reviewed excerpt' })).toHaveCount(0);
    const reads = await page.evaluate(() => window.__chatStorageReads);
    await test.info().attach('durable-read-counts', {
      body: JSON.stringify({ retainedMessages: size, ...reads }),
      contentType: 'application/json',
    });
    expect(reads.full).toBe(0);
    expect(reads.writeFull).toBe(0);
    expect(reads.indexed).toBe(2);
    expect(reads.keyed).toBe(14);
    await page.getByRole('button', { name: 'Return to parent', exact: true }).click();
    await expect(
      page.getByRole('list', { name: 'Messages' }).getByText('Bounded reviewed import'),
    ).toBeVisible();
  });
}

async function prepareFixedReview(page: Page) {
  await page.getByRole('button', { name: /^Legacy side/ }).click();
  await page.getByRole('checkbox', { name: /Legacy source/ }).check();
  await page.evaluate(() => {
    const original = crypto.randomUUID.bind(crypto);
    let first = true;
    crypto.randomUUID = () => {
      if (!first) return original();
      first = false;
      return '11111111-1111-4111-8111-111111111111';
    };
  });
  await page.getByRole('button', { name: 'Review Bring back', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reviewed excerpt' }).fill('Atomic reviewed excerpt');
}

async function durableSummary(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ count: number; revision: number; imported: number }>((resolve, reject) => {
        const request = indexedDB.open('opencoven-chat');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['meta', 'messages']);
          const count = tx.objectStore('messages').count();
          const revision = tx.objectStore('meta').get('mutationRevision');
          const imported = tx
            .objectStore('messages')
            .index('by_operation')
            .count('11111111-1111-4111-8111-111111111111');
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
          tx.oncomplete = () => {
            resolve({
              count: count.result,
              revision: revision.result.value,
              imported: imported.result,
            });
            db.close();
          };
        };
      }),
  );
}

for (const interference of ['parent', 'side', 'creation-key', 'import-key'] as const) {
  test(`transaction admission rejects a racing ${interference} change atomically`, async ({
    page,
  }) => {
    await seedLegacyHistory(page, 50);
    await prepareFixedReview(page);
    await page.evaluate((kind) => {
      const original = IDBDatabase.prototype.transaction;
      let first = true;
      IDBDatabase.prototype.transaction = function (...args) {
        if (args[1] === 'readwrite' && first) {
          first = false;
          // Queue the competing writer after UI review/refresh, before admission.
          const competing = Reflect.apply(original, this, args) as IDBTransaction;
          const conversations = competing.objectStore('conversations');
          const key = '11111111-1111-4111-8111-111111111111';
          const get = conversations.get(kind === 'side' ? 'side' : 'parent');
          get.onsuccess = () => {
            if (kind === 'parent' || kind === 'side') {
              conversations.put({ ...get.result, revision: get.result.revision + 1 });
            } else if (kind === 'creation-key') {
              conversations.put({
                ...get.result,
                id: 'competing-creation',
                title: 'Competing discarded note',
                side: { parentConversationId: 'parent', operationKey: key, state: 'discarded' },
              });
            } else {
              conversations.put({
                ...get.result,
                id: 'competing-parent',
                title: 'Competing parent',
              });
              competing.objectStore('messages').put({
                id: 'competing-import',
                conversationId: 'competing-parent',
                parentId: null,
                role: 'user',
                text: 'Another operation payload',
                createdAt: get.result.createdAt,
                broughtBack: {
                  operationKey: key,
                  sideConversationId: 'side',
                  sourceMessageIds: ['source'],
                },
              });
            }
          };
          competing.objectStore('meta').put({ key: 'mutationRevision', value: 1 });
        }
        return Reflect.apply(original, this, args) as IDBTransaction;
      };
    }, interference);
    await page.getByRole('button', { name: 'Bring back reviewed excerpt', exact: true }).click();
    await expect(page.getByText(/conflicts with its earlier request/)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Reviewed excerpt' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Review again', exact: true })).toHaveCount(0);
    expect(await durableSummary(page)).toEqual({
      count: interference === 'import-key' ? 53 : 52,
      revision: 1,
      imported: interference === 'import-key' ? 1 : 0,
    });
    await page.getByRole('button', { name: 'Return to parent', exact: true }).click();
    await expect(
      page.getByRole('list', { name: 'Messages' }).getByText('Atomic reviewed excerpt'),
    ).toHaveCount(0);
  });
}

test('an aborted import rolls back its message, conversation and shared revision before unchanged-key retry', async ({
  page,
}) => {
  await seedLegacyHistory(page, 50);
  await prepareFixedReview(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let first = true;
    IDBObjectStore.prototype.put = function (...args) {
      const request = Reflect.apply(original, this, args) as IDBRequest;
      if (this.name === 'messages' && first) {
        first = false;
        request.addEventListener('success', () => this.transaction.abort(), { once: true });
      }
      return request;
    };
  });
  await page.getByRole('button', { name: 'Bring back reviewed excerpt', exact: true }).click();
  await expect(page.getByText(/The import result could not be confirmed/)).toBeVisible();
  expect(await durableSummary(page)).toEqual({ count: 52, revision: 0, imported: 0 });
  await expect(page.getByRole('textbox', { name: 'Reviewed excerpt' })).toBeDisabled();
  await page.getByRole('button', { name: 'Bring back reviewed excerpt', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Reviewed excerpt' })).toHaveCount(0);
  expect(await durableSummary(page)).toEqual({ count: 53, revision: 1, imported: 1 });
});

test('two windows racing the same reviewed key converge on one durable import', async ({
  page,
  context,
}) => {
  await seedLegacyHistory(page, 50);
  const other = await context.newPage();
  await other.goto('/');
  await prepareFixedReview(page);
  await prepareFixedReview(other);
  await Promise.all(
    [page, other].map((current) =>
      current.getByRole('button', { name: 'Bring back reviewed excerpt', exact: true }).click(),
    ),
  );
  for (const current of [page, other]) {
    const review = current.getByRole('textbox', { name: 'Reviewed excerpt' });
    await expect
      .poll(
        async () =>
          (await review.count()) === 0 ||
          (await current.getByText(/conflicts with its earlier request/).count()) === 1,
      )
      .toBe(true);
    if (await review.count()) {
      await expect(review).toBeDisabled();
      await current
        .getByRole('button', { name: 'Bring back reviewed excerpt', exact: true })
        .click();
    }
    await expect(review).toHaveCount(0);
  }
  expect(await durableSummary(page)).toEqual({ count: 53, revision: 1, imported: 1 });
});

test('an uncertain conversation create reports confirmation guidance without selecting a phantom result', async ({
  page,
}) => {
  await seedLegacyHistory(page, 50);
  await loseNextWriteAcknowledgement(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(
    page.getByText(/conversation creation result could not be confirmed.*before retrying/),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Legacy parent', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
});

test('a discarded create replay reconciles the old key before allowing a new durable side note', async ({
  page,
  context,
}) => {
  await seedLegacyHistory(page, 50);
  await loseNextWriteAcknowledgement(page);
  await page.getByRole('button', { name: 'New retained side note', exact: true }).click();
  await expect(
    page.getByText(/side note creation result could not be confirmed.*same operation key/),
  ).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  await other.getByRole('button', { name: /^Retained side note/ }).click();
  await other.getByRole('button', { name: 'Discard note', exact: false }).click();
  await other.getByRole('button', { name: 'Discard local messages', exact: true }).click();
  await expect(other.getByRole('heading', { name: 'Legacy parent', exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Retry retained side note creation', exact: true })
    .click();
  await expect(page.getByText(/creation request refers to a discarded note/)).toBeVisible();
  await page.getByRole('button', { name: 'New retained side note', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close note', exact: true })).toBeVisible();
  const creations = await page.evaluate(
    () =>
      new Promise<{ state: string; key: string }[]>((resolve, reject) => {
        const request = indexedDB.open('opencoven-chat');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('conversations');
          const records = tx.objectStore('conversations').getAll();
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
          tx.oncomplete = () => {
            resolve(
              records.result
                .filter((record) => record.title === 'Retained side note')
                .map((record) => ({ state: record.side.state, key: record.side.operationKey })),
            );
            db.close();
          };
        };
      }),
  );
  expect(creations.map((entry) => entry.state).sort()).toEqual(['discarded', 'open']);
  expect(new Set(creations.map((entry) => entry.key)).size).toBe(2);
});

test('uncertain side creation retains its retry identity across real parent navigation', async ({
  page,
}) => {
  await seedLegacyHistory(page, 50);
  await loseNextWriteAcknowledgement(page);
  await page.getByRole('button', { name: 'New retained side note', exact: true }).click();
  await expect(page.getByText(/side note creation result could not be confirmed/)).toBeVisible();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New retained side note', exact: true }),
  ).toBeEnabled();
  await page.getByRole('option', { name: /Legacy parent/ }).click();
  await page
    .getByRole('button', { name: 'Retry retained side note creation', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Close note', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Return to parent', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Retained side note/ })).toHaveCount(1);
});

test('reload exposes a committed uncertain creation for list reconciliation without claiming its retry key survived', async ({
  page,
}) => {
  await seedLegacyHistory(page, 50);
  await loseNextWriteAcknowledgement(page);
  await page.getByRole('button', { name: 'New retained side note', exact: true }).click();
  await expect(page.getByText(/side note creation result could not be confirmed/)).toBeVisible();
  await page.reload();
  await expect(
    page.getByText(
      /Pending creations survive navigation in this app session only, not reload or restart/,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry retained side note creation', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Retained side note/ })).toHaveCount(1);
  await page.getByRole('button', { name: /^Retained side note/ }).click();
  await expect(page.getByRole('button', { name: 'Close note', exact: true })).toBeVisible();
});

for (const timing of ['before', 'after'] as const) {
  test(`a competing write ${timing} our commit is reconciled before the successful UI refresh`, async ({
    page,
  }) => {
    await seedLegacyHistory(page, 50);
    await page.evaluate((when) => {
      const original = IDBDatabase.prototype.transaction;
      let injected = false;
      IDBDatabase.prototype.transaction = function (...args) {
        if (args[1] !== 'readwrite' || injected)
          return Reflect.apply(original, this, args) as IDBTransaction;
        injected = true;
        const own =
          when === 'after' ? (Reflect.apply(original, this, args) as IDBTransaction) : null;
        const competing = Reflect.apply(original, this, args) as IDBTransaction;
        const conversations = competing.objectStore('conversations');
        const messages = competing.objectStore('messages');
        const parent = conversations.get('parent');
        parent.onsuccess = () => {
          if (when === 'before') {
            conversations.put({
              ...parent.result,
              id: 'external-parent',
              title: 'External sidebar thread',
            });
            messages.put({
              id: 'external-message',
              conversationId: 'external-parent',
              parentId: null,
              role: 'user',
              text: 'External transcript',
              createdAt: parent.result.updatedAt,
            });
          } else {
            const turns = messages
              .index('by_conversation')
              .getAll(IDBKeyRange.bound(['parent'], ['parent', []]));
            turns.onsuccess = () => {
              const last = turns.result.at(-1);
              const timestamp = new Date(Date.parse(parent.result.updatedAt) + 1).toISOString();
              messages.put({
                id: 'after-own-commit',
                conversationId: 'parent',
                parentId: last.id,
                role: 'user',
                text: 'External after our commit',
                createdAt: timestamp,
              });
              conversations.put({
                ...parent.result,
                revision: parent.result.revision + 1,
                updatedAt: timestamp,
              });
            };
          }
        };
        const meta = competing.objectStore('meta');
        const revision = meta.get('mutationRevision');
        revision.onsuccess = () =>
          meta.put({ key: 'mutationRevision', value: revision.result.value + 1 });
        return own ?? (Reflect.apply(original, this, args) as IDBTransaction);
      };
    }, timing);
    await send(page, 'Our successful append');
    await expect(
      page
        .getByRole('list', { name: 'Messages' })
        .getByText('Our successful append', { exact: true }),
    ).toHaveCount(1);
    if (timing === 'before') {
      await expect(page.getByRole('option', { name: /External sidebar thread/ })).toBeVisible();
    } else {
      await expect(
        page
          .getByRole('list', { name: 'Messages' })
          .getByText('External after our commit', { exact: true }),
      ).toBeVisible();
    }
    expect((await durableSummary(page)).revision).toBe(2);
  });
}

test('a discarded reviewed source keeps its edited excerpt available for copying and explicit cancellation', async ({
  page,
  context,
}) => {
  await seedLegacyHistory(page, 50);
  await prepareFixedReview(page);
  const other = await context.newPage();
  await other.goto('/');
  await other.getByRole('button', { name: /^Legacy side/ }).click();
  await other.getByRole('button', { name: 'Discard note', exact: false }).click();
  await other.getByRole('button', { name: 'Discard local messages', exact: true }).click();
  await expect(other.getByRole('heading', { name: 'Legacy parent', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Bring back reviewed excerpt', exact: true }).click();
  await page.getByRole('button', { name: 'Review again', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Choose available messages', exact: true }),
  ).toBeVisible();
  const excerpt = page.getByRole('textbox', { name: 'Reviewed excerpt' });
  await expect(excerpt).toHaveValue('Atomic reviewed excerpt');
  await expect(excerpt).toHaveAttribute('readonly', '');
  await expect(excerpt).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Bring back reviewed excerpt', exact: true }),
  ).toBeDisabled();
  expect((await durableSummary(page)).imported).toBe(0);
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click();
  await expect(excerpt).toHaveCount(0);
});
