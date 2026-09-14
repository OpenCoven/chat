import { expect, test } from '@playwright/test';

for (const mode of ['chat', 'messages', 'minimal', 'familiars-reads']) {
  test(`an old ${mode} link cannot select a different application`, async ({ page }) => {
    await page.goto(`/?demo=${mode}`);

    await expect(page.locator('.fr-shell')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Familiars sidebar' })).toBeVisible();
    await expect(page.getByText(/desktop app/i).first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Held action' })).toHaveCount(0);
    await expect(page.locator('.mm-desktop')).toHaveCount(0);
    await expect(page.getByText('Q3 pricing evidence map', { exact: true })).toHaveCount(0);
  });
}

for (const width of [820, 1024, 1440]) {
  test(`fits the Familiars layout within a ${width}px desktop viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    await page.goto('/');
    await expect(page.locator('.fr-shell')).toBeVisible();
    await expect(page.getByText(/desktop app/i).first()).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      page: document.documentElement.scrollWidth,
      shell: document.querySelector('.fr-shell')?.getBoundingClientRect().width,
    }));
    expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.shell).toBe(width);
  });
}

test('keeps the familiar rail collapsible in the standalone layout', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByRole('complementary', { name: 'Familiars sidebar' });
  await expect(sidebar).toBeVisible();
  await page.getByRole('button', { name: 'Hide familiars', exact: true }).click();
  await expect(sidebar).toBeHidden();
  await page.getByRole('button', { name: 'Show familiars rail', exact: true }).click();
  await expect(sidebar).toBeVisible();
});
