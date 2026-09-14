import { expect, type Page, test } from '@playwright/test';

async function shellMetrics(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector('.coven-chat');
    const sidebar = document.querySelector('.fr-sidebar');
    const inspector = document.querySelector('.fr-inspector');
    const composer = document.querySelector('.fr-composer-wrap');
    const thread = document.querySelector('.fr-thread');
    const rect = (node: Element | null) => node?.getBoundingClientRect() ?? null;
    return {
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      tier: shell?.getAttribute('data-tier') ?? null,
      shell: rect(shell),
      sidebar: rect(sidebar),
      inspector: rect(inspector),
      composer: rect(composer),
      thread: rect(thread),
    };
  });
}

test.describe('responsive shell', () => {
  for (const [width, tier] of [
    [390, 'compact'],
    [600, 'compact'],
    [820, 'medium'],
    [1024, 'medium'],
    [1440, 'wide'],
  ] as const) {
    test(`fits a ${width}px viewport as the ${tier} tier without horizontal overflow`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 780 });
      await page.goto('/');
      await expect(page.locator('.coven-chat')).toBeVisible();
      const metrics = await shellMetrics(page);
      expect(metrics.tier).toBe(tier);
      expect(metrics.pageWidth).toBeLessThanOrEqual(metrics.viewport);
      expect(metrics.shell?.width).toBe(width);
      // The thread owns most of the viewport whether or not rails are overlaid.
      expect(metrics.thread?.width ?? 0).toBeGreaterThanOrEqual(Math.min(width, 640) * 0.6);
      // The composer is always reachable inside the viewport.
      expect(metrics.composer).not.toBeNull();
      expect((metrics.composer?.bottom ?? Number.NaN) <= 780).toBe(true);
    });
  }

  test('compact drawers open one at a time and dismiss from the scrim', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto('/');
    const shell = page.locator('.coven-chat');
    await expect(shell).toHaveAttribute('data-tier', 'compact');
    const sidebar = page.locator('.fr-sidebar');
    const inspector = page.locator('.fr-inspector');
    await expect(sidebar).toBeHidden();
    await expect(inspector).toBeHidden();

    await page.getByRole('button', { name: 'Show familiars', exact: true }).click();
    await expect(sidebar).toBeVisible();
    // Wait for the slide-in to settle before measuring.
    await expect.poll(async () => (await shellMetrics(page)).sidebar?.left).toBe(0);
    expect(((await shellMetrics(page)).sidebar?.width ?? 0) < 390).toBe(true);

    // Tap the exposed strip of scrim beside the drawer, as a thumb would.
    await page
      .getByRole('button', { name: 'Close panels' })
      .click({ position: { x: 380, y: 400 } });
    await expect(sidebar).toBeHidden();

    await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
    await expect(inspector).toBeVisible();
    await expect(sidebar).toBeHidden();
    await expect.poll(async () => (await shellMetrics(page)).inspector?.right).toBe(390);

    await page.keyboard.press('Escape');
    await expect(inspector).toBeHidden();
    await expect(page.getByRole('button', { name: 'Close panels' })).toHaveCount(0);
  });

  test('medium screens keep the familiars rail in the grid and overlay the inspector', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 780 });
    await page.goto('/');
    await expect(page.locator('.coven-chat')).toHaveAttribute('data-tier', 'medium');
    await expect(page.locator('.fr-sidebar')).toBeVisible();
    await expect(page.locator('.fr-inspector')).toBeHidden();
    await page.getByRole('button', { name: 'Show inspector', exact: true }).first().click();
    await expect(page.locator('.fr-inspector')).toBeVisible();
    await expect.poll(async () => (await shellMetrics(page)).inspector?.right).toBe(900);
    const metrics = await shellMetrics(page);
    // The rail stays in place beneath the overlay rather than being pushed.
    expect(metrics.sidebar?.left).toBe(0);
    expect(metrics.pageWidth).toBeLessThanOrEqual(900);
  });
});
