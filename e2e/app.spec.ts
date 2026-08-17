import { expect, test } from '@playwright/test';

test('renders the OpenCoven Chat scaffold with an unavailable connection state', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'OpenCoven Chat (preview)' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Connection state' })).toContainText('Unavailable');
  await expect(page.getByRole('status', { name: 'Desktop identity status' })).toContainText(
    'Browser preview fallback active.',
  );
});
