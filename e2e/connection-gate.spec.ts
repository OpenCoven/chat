import { expect, test } from '@playwright/test';

test('browser preview gate does not render chat controls before Cave is available', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('status', { name: 'Connection state' })).toContainText(
    'Cave connection requires the desktop app.',
  );
  await expect(page.getByText('Read-only chat')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pair with Cave' })).toHaveCount(0);
});
