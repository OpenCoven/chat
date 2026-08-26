import { expect, test } from '@playwright/test';

test('preserves the local demo routes alongside the default app', async ({ page }) => {
  await page.goto('/?demo=chat');

  await expect(page).toHaveURL('http://127.0.0.1:4174/?demo=chat');
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

  await page.goto('/?demo=minimal');

  await expect(page).toHaveURL('http://127.0.0.1:4174/?demo=minimal');
  await expect(page.getByText('Chats', { exact: true })).toBeVisible();
  await expect(page.getByText('Familiars', { exact: true })).toBeVisible();
});
