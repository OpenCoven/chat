import { expect, test } from '@playwright/test';

test('renders the production browser connection gate when Tauri is unavailable', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'OpenCoven Chat' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Connection state' })).toContainText(
    'Cave connection requires the desktop app.',
  );
  await expect(page.getByText('Open in the OpenCoven app to connect.')).toBeVisible();
});
