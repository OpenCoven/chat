import { expect, test } from '@playwright/test';

import { APP_CONNECTION_SUMMARY, APP_METADATA, APP_SCAFFOLD_STATUS } from '../src/lib/app-metadata';

test('shows the freshly built OpenCoven Chat scaffold identity', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL('http://127.0.0.1:4174/');
  await expect(page.getByRole('heading', { name: 'OpenCoven Chat' })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-scaffold-fingerprint',
    APP_METADATA.fingerprint,
  );
  await expect(page.getByRole('status', { name: 'Connection state' })).toHaveText(
    APP_CONNECTION_SUMMARY,
  );
  await expect(page.getByText(APP_SCAFFOLD_STATUS)).toBeVisible();
  await expect(page.getByText(APP_METADATA.identifier)).toBeVisible();
  await expect(page.getByText(APP_METADATA.phase)).toBeVisible();
});
