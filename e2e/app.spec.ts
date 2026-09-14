import { expect, test } from '@playwright/test';

test('opens the Familiars layout without Cave and explains browser runtime limits', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.locator('.fr-shell')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Familiars sidebar' })).toBeVisible();
  await expect(page.getByText(/desktop app/i).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'This device', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /pair.*cave|connect.*cave/i })).toHaveCount(0);
  await expect(page.getByText('Q3 pricing evidence map', { exact: true })).toHaveCount(0);
});
