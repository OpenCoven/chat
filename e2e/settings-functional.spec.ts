import { expect, test } from '@playwright/test';
import { installRuntimeFixture } from './fixtures/runtime';

for (const viewport of [
  { width: 480, height: 520 },
  { width: 900, height: 520 },
]) {
  test(`Settings sections stay reachable and keyboard scrollable at ${viewport.width}px`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize(viewport);
    await installRuntimeFixture(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    for (const name of ['General', 'Model', 'Chats', 'Access', 'Devices', 'Shortcuts', 'About']) {
      await dialog.getByRole('button', { name, exact: true }).click();
      const body = dialog.getByRole('region', { name: 'Settings content', exact: true });
      expect(await body.evaluate((node) => node.scrollTop)).toBe(0);
      await expect(dialog.getByRole('region', { name, exact: true })).toBeVisible();
      expect(await body.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      const overflowing = await body.evaluate((node) => node.scrollHeight > node.clientHeight);
      if (overflowing) {
        await dialog.getByRole('button', { name: 'Close settings' }).focus();
        await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
        await expect(body).toBeFocused();
        await body.press('PageDown');
        await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
      }
      await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeInViewport();
    }
    expect(
      await page.evaluate(() => [
        document.documentElement.scrollWidth <= innerWidth,
        document.documentElement.scrollHeight <= innerHeight,
      ]),
    ).toEqual([true, true]);
  });
}

test('Settings changes persist and project refresh keeps the current draft', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 520 });
  await installRuntimeFixture(page);
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
  await composer.fill('Keep this unsent draft');
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('radio', { name: 'Larger', exact: true }).check();
  await expect(dialog.getByRole('radio', { name: 'Larger', exact: true })).toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Group tool calls' }).uncheck();
  await dialog.getByRole('button', { name: 'Model', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).selectOption(':custom');
  await dialog.getByRole('textbox', { name: 'Custom model ID' }).fill('provider/settings-test');
  await dialog.getByRole('checkbox', { name: 'Think longer' }).check();
  await dialog
    .getByRole('group', { name: 'Speed', exact: true })
    .getByRole('button', { name: 'Thorough' })
    .click();
  await dialog.getByRole('button', { name: 'Access', exact: true }).click();
  await expect(dialog).toContainText('without asking for permission');
  const callsBefore = await page.evaluate(
    () =>
      window.__covenFixture.calls.filter(
        (call) => call === 'coven_runtime_sessions' || call === 'coven_runtime_read',
      ).length,
  );
  // Coven's next registry read includes a grant added outside this window.
  await page.evaluate(() => {
    const boundary = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const invoke = boundary.invoke;
    boundary.invoke = async (command, args) => {
      const result = await invoke(command, args);
      if (command !== 'coven_runtime_familiars') return result;
      return (result as Record<string, unknown>[]).map((familiar) => ({
        ...familiar,
        projectAccess: [{ name: 'New grant', path: '/fixture/new-grant', access: 'write' }],
      }));
    };
  });
  await dialog.getByRole('button', { name: 'Refresh project access' }).click();
  await expect(dialog.getByText('New grant', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Refresh project access' })).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        window.__covenFixture.calls.filter(
          (call) => call === 'coven_runtime_sessions' || call === 'coven_runtime_read',
        ).length,
    ),
  ).toBe(callsBefore);
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(composer).toHaveValue('Keep this unsent draft');
  await page.reload();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: /Larger/ })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Group tool calls' })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Model', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Custom model ID' })).toHaveValue(
    'provider/settings-test',
  );
  await expect(dialog.getByRole('checkbox', { name: 'Think longer' })).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Thorough' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
