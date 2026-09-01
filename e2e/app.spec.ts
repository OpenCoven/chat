import { expect, test } from '@playwright/test';

test('mounts the chat shell immediately, with Cave offered rather than required', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('complementary')).toBeVisible();
  await expect(page.getByRole('button', { name: 'This device' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('status', { name: 'Connection state' })).toHaveCount(0);
});
