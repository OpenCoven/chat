import { expect, test } from '@playwright/test';

import {
  APP_CONNECTION_SUMMARY,
  APP_METADATA,
  APP_SCAFFOLD_STATUS,
  PREVIEW_APP_IDENTITY,
} from '../src/lib/app-metadata';

test('shows the freshly built OpenCoven Chat scaffold identity', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL('http://127.0.0.1:4174/');
  await expect(page.getByRole('heading', { name: PREVIEW_APP_IDENTITY.name })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-scaffold-fingerprint',
    APP_METADATA.fingerprint,
  );
  await expect(page.getByRole('status', { name: 'Connection state' })).toHaveText(
    APP_CONNECTION_SUMMARY,
  );
  await expect(page.getByText(APP_SCAFFOLD_STATUS)).toBeVisible();
  await expect(page.getByRole('status', { name: 'Desktop identity status' })).toHaveText(
    'Browser preview fallback active. Desktop identity is available only inside Tauri.',
  );
  await expect(page.getByText('Browser preview fallback', { exact: true })).toBeVisible();
  await expect(page.getByText(PREVIEW_APP_IDENTITY.identifier)).toBeVisible();
  await expect(page.getByText(PREVIEW_APP_IDENTITY.phase)).toBeVisible();
});
