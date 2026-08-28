import { expect, test } from '@playwright/test';

test('keeps browser preview explicitly offline without native trust', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL('http://127.0.0.1:4174/');
  await expect(page.getByRole('heading', { name: 'OpenCoven Chat' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Connection state' })).toContainText('Offline');
  await expect(page.getByText(/desktop app is required to connect securely/i)).toBeVisible();
  await expect(page.getByText(/browser preview never invents/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect' })).toHaveCount(0);
});
