import { expect, test } from '@playwright/test';

test('local chat is usable in the browser without Cave', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByText('Coven Cave needs the desktop app. Local chat works here.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect to Cave' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Coven Cave' })).toBeDisabled();
  await expect(page.getByText('Local chat')).toBeVisible();
});

test('a locally composed message is kept without a fabricated reply', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'New' }).click();
  await expect(page.getByRole('option', { name: /New conversation/ })).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('a note only this device holds');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('a note only this device holds')).toBeVisible();
  await expect(page.getByText(/No familiar is connected|kept in memory only/)).toBeVisible();
});
