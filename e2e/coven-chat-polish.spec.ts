import { expect, test } from '@playwright/test';

import { contrastFailures } from './contrast';
import { installRuntimeFixture } from './fixtures/runtime';

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`Coven Chat refinement in ${colorScheme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    test('brands the window and clears familiar search without navigating', async ({
      page,
    }, info) => {
      await installRuntimeFixture(page, true, undefined, 4);
      await page.goto('/');
      await expect(page).toHaveTitle('Local familiar — Coven Chat');
      const search = page.getByRole('searchbox', { name: 'Search familiars' });
      await search.fill('Familiar 2');
      await expect(page.getByRole('status', { name: 'Familiar search results' })).toHaveText(
        '1 familiar',
      );
      await expect(page.locator('.coven-agent-row')).toHaveCount(1);
      await page.getByRole('button', { name: 'Clear familiar search' }).click();
      await expect(search).toBeFocused();
      await expect(search).toHaveValue('');
      await expect(page.locator('.coven-agent-row')).toHaveCount(4);
      await expect(page).toHaveTitle('Local familiar — Coven Chat');
      await search.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(page).toHaveTitle('Familiar 1 — Coven Chat');
      await expect(page.getByRole('textbox', { name: 'Message Familiar 1' })).toBeFocused();
      const purpose = page.locator('.coven-thread-empty-purpose');
      expect(
        await purpose.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeLessThanOrEqual(80);
      const failures = await contrastFailures(page);
      expect(failures).toEqual([]);
      await page.screenshot({ path: info.outputPath(`desktop-${colorScheme}.png`) });
    });

    test('keeps Send and Stop reachable and restores the draft after cancellation', async ({
      page,
    }) => {
      await installRuntimeFixture(page);
      await page.goto('/');
      const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
      await expect(composer).toBeEnabled();
      await composer.fill('Keep this message if I stop the run.');
      await composer.press('Enter');
      const stop = page.getByRole('button', { name: 'Stop run', exact: true });
      await expect(stop).toBeVisible();
      await stop.click();
      await expect(composer).toHaveValue('Keep this message if I stop the run.');
      await expect(page.getByRole('alert')).toContainText('cancelled');
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
      expect(await page.evaluate(() => window.__covenFixture.calls)).toContain(
        'coven_runtime_cancel',
      );
    });

    test('opens Settings, reads the desktop brand, and restores keyboard focus on Escape', async ({
      page,
    }, info) => {
      await installRuntimeFixture(page);
      await page.goto('/');
      const trigger = page.getByRole('button', { name: 'Open settings', exact: true });
      await trigger.click();
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await expect(settings.getByText('Coven Chat', { exact: true }).first()).toBeVisible();
      await settings.getByRole('button', { name: 'About', exact: true }).click();
      await expect(settings.getByRole('region', { name: 'About' })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`settings-${colorScheme}.png`) });
      await page.keyboard.press('Escape');
      await expect(settings).not.toBeVisible();
      await expect(trigger).toBeFocused();
    });

    test('fits the minimum window with a long familiar name and accessible drawers', async ({
      page,
    }, info) => {
      await page.setViewportSize({ width: 480, height: 520 });
      await page.addInitScript(() => {
        window.__fixtureFamiliarName = 'A familiar with a long and descriptive display name';
      });
      await installRuntimeFixture(page);
      await page.goto('/');
      const composer = page.getByRole('textbox', { name: /^Message A familiar/ });
      await expect(composer).toBeEnabled();
      await composer.fill('A short message');
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(480);
      await page.getByRole('button', { name: 'Show familiars', exact: true }).click();
      const search = page.getByRole('searchbox', { name: 'Search familiars' });
      await search.fill('not present');
      await page.getByRole('button', { name: 'Clear familiar search' }).click();
      await expect(search).toBeFocused();
      await search.press('Escape');
      await expect(page.locator('.fr-sidebar')).toBeHidden();
      await expect(composer).toHaveValue('A short message');
      await page.screenshot({ path: info.outputPath(`compact-${colorScheme}.png`) });
    });
  });
}
