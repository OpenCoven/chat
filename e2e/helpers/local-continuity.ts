import { expect, type Page } from '@playwright/test';

export async function localContinuityJourney({
  page,
  visit = true,
  screenshotSuffix = 'local',
  viewport = { width: 390, height: 844 },
}: {
  page: Page;
  visit?: boolean;
  screenshotSuffix?: string;
  viewport?: { width: number; height: number };
}) {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') mutations.push(`${request.method()} ${request.url()}`);
  });
  await page.setViewportSize(viewport);
  if (visit) await page.goto('/');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('unsent parent');
  await page.getByRole('button', { name: 'New retained side note' }).click();
  await expect(page.getByRole('button', { name: 'Close note', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('retained raw source');
  await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
  await page.getByRole('checkbox', { name: /retained raw source/ }).check();
  await page.getByRole('button', { name: 'Review Bring back', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reviewed excerpt' }).fill('Edited excerpt only');
  await expect(
    page.getByText(
      /Pending reviews survive navigation in this app session only, not reload or restart/,
    ),
  ).toBeVisible();
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    let dropNextAcknowledgement = true;
    IDBDatabase.prototype.transaction = function (...args) {
      const transaction = Reflect.apply(original, this, args) as IDBTransaction;
      if (args[1] === 'readwrite' && dropNextAcknowledgement) {
        dropNextAcknowledgement = false;
        // The real IndexedDB commit completes, but its acknowledgement is lost.
        // Only this test-side wrapper turns that completion into a writer error.
        Object.defineProperty(transaction, 'oncomplete', {
          configurable: true,
          set() {
            transaction.addEventListener(
              'complete',
              () => {
                transaction.onerror?.call(transaction, new Event('error'));
              },
              { once: true },
            );
          },
        });
      }
      return transaction;
    };
  });
  await page.getByRole('button', { name: 'Bring back reviewed excerpt' }).click();
  await expect(
    page.getByText('The local change could not be saved. Retry uses the same operation key.'),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Reviewed excerpt' })).toHaveValue(
    'Edited excerpt only',
  );
  const firstReceipt = await importReceipts(page);
  expect(firstReceipt).toHaveLength(1);
  expect(firstReceipt[0]?.text).toBe('Edited excerpt only');
  expect(firstReceipt[0]?.operationKey).toBeTruthy();
  await page.getByRole('button', { name: 'Return to parent', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Retained side note · open/ }).click();
  await expect(page.getByRole('textbox', { name: 'Reviewed excerpt' })).toHaveValue(
    'Edited excerpt only',
  );
  await expect(page.getByRole('checkbox', { name: /retained raw source/ })).toBeChecked();
  const reviewBounds = await page.evaluate(() => {
    const history = document.querySelector('.chat-shell__thread-body');
    const composer = document.querySelector('.chat-composer');
    if (!history || !composer) throw new Error('Local review regions are missing');
    return {
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      historyWidth: history.clientWidth,
      historyScrollWidth: history.scrollWidth,
      historyHeight: history.clientHeight,
      composerBottom: composer.getBoundingClientRect().bottom,
    };
  });
  expect(reviewBounds.documentWidth).toBeLessThanOrEqual(viewport.width);
  expect(reviewBounds.documentHeight).toBeLessThanOrEqual(viewport.height);
  expect(reviewBounds.historyScrollWidth).toBeLessThanOrEqual(reviewBounds.historyWidth);
  expect(reviewBounds.historyHeight).toBeGreaterThan(0);
  expect(reviewBounds.composerBottom).toBeLessThanOrEqual(viewport.height);
  if (process.env.CONTINUITY_SCREENSHOT_PATH) {
    await page.screenshot({
      path: process.env.CONTINUITY_SCREENSHOT_PATH.replace(
        /\.png$/,
        `-${screenshotSuffix}-review-retry-narrow.png`,
      ),
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Bring back reviewed excerpt' }).click();
  await expect(page.getByRole('textbox', { name: 'Reviewed excerpt' })).toHaveCount(0);
  expect(await importReceipts(page)).toEqual(firstReceipt);
  await page.getByRole('button', { name: 'Close note', exact: true }).click();
  await expect(page.getByText('Edited excerpt only', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'unsent parent',
  );
  await page.reload();
  await expect(page.getByText('Edited excerpt only', { exact: true })).toBeVisible();
  expect(await importReceipts(page)).toEqual(firstReceipt);
  // Draft custody is explicitly in-memory, not silently persisted.
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  await expect(page.getByText('retained raw source', { exact: true })).toHaveCount(0);
  const retained = page.getByRole('button', { name: /Retained side note · closed/ });
  await retained.click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reopen note' }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: /Ongoing/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation', { name: 'UTC chapters' })).toBeVisible();
  await page.getByRole('navigation', { name: 'UTC chapters' }).getByRole('button').first().focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Ongoing/ })).toBeFocused();
  await expect(page.getByRole('navigation', { name: 'UTC chapters' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (process.env.CONTINUITY_SCREENSHOT_PATH) {
    await page.screenshot({
      path: process.env.CONTINUITY_SCREENSHOT_PATH.replace(
        /\.png$/,
        `-${screenshotSuffix}-retained-narrow.png`,
      ),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1360, height: 960 });
    await page.screenshot({
      path: process.env.CONTINUITY_SCREENSHOT_PATH.replace(
        /\.png$/,
        `-${screenshotSuffix}-retained-wide.png`,
      ),
      fullPage: true,
    });
    await page.setViewportSize(viewport);
  }
  await page.getByRole('button', { name: 'Discard note…' }).click();
  await page.getByRole('button', { name: 'Discard local messages' }).click();
  await expect(page.getByText('Edited excerpt only', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Edited excerpt only', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Retained side note ·/ })).toHaveCount(0);
  expect(mutations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (process.env.CONTINUITY_SCREENSHOT_PATH) {
    await page.screenshot({
      path: process.env.CONTINUITY_SCREENSHOT_PATH.replace(
        /\.png$/,
        `-${screenshotSuffix}-narrow.png`,
      ),
      fullPage: true,
    });
  }
}

async function importReceipts(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('opencoven-chat');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ id: string; operationKey: string; text: string }[]>(
        (resolve, reject) => {
          const request = database
            .transaction('messages', 'readonly')
            .objectStore('messages')
            .getAll();
          request.onsuccess = () => {
            const rows = request.result as {
              id: string;
              text: string;
              broughtBack?: { operationKey: string };
            }[];
            resolve(
              rows.flatMap((row) =>
                row.broughtBack
                  ? [
                      {
                        id: row.id,
                        operationKey: row.broughtBack.operationKey,
                        text: row.text,
                      },
                    ]
                  : [],
              ),
            );
          };
          request.onerror = () => reject(request.error);
        },
      );
    } finally {
      database.close();
    }
  });
}
