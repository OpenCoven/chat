import { expect, test } from '@playwright/test';
import { installRuntimeFixture } from './fixtures/runtime';

const gptModels = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'];
const claudeModels = [
  'claude-fable-5-2',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
];

for (const harness of ['coven-code', 'codex', 'claude']) {
  test(`${harness} model presets reach the send boundary with the correct IDs`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await installRuntimeFixture(page);
    await page.addInitScript((harness) => {
      localStorage.setItem('opencoven.chat.preferences.v1', JSON.stringify({ harness }));
    }, harness);
    await page.goto('/');
    const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    const picker = dialog.getByRole('combobox', { name: 'Model', exact: true });
    const expected =
      harness === 'coven-code'
        ? [...gptModels.map((id) => `codex/${id}`), ...claudeModels]
        : harness === 'codex'
          ? gptModels
          : claudeModels;
    const selections =
      harness === 'coven-code'
        ? expected
        : harness === 'codex'
          ? expected.slice(2, 3)
          : expected.slice(0, 1);
    for (const id of selections) {
      await page.getByRole('button', { name: 'Open settings', exact: true }).click();
      await dialog.getByRole('button', { name: 'Model', exact: true }).click();
      expect(
        await picker
          .locator('optgroup option')
          .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
      ).toEqual(expected);
      await picker.selectOption(id);
      await expect(picker).toHaveValue(id);
      await expect(picker).toBeInViewport();
      if (id.includes('sol') || id.includes('fable') || harness !== 'coven-code') {
        await page.screenshot({
          path: testInfo.outputPath(`${harness}-${id.replaceAll('/', '-')}.png`),
        });
      }
      await dialog.getByRole('button', { name: 'Close settings' }).click();
      await expect(composer).toBeEnabled();
      await composer.fill(`Use ${id}`);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => window.__covenFixture.inputs?.at(-1)))
        .toMatchObject({ model: id });
      if (harness !== 'coven-code') {
        expect(await page.evaluate(() => window.__covenFixture.inputs?.at(-1))).toMatchObject({
          harness,
        });
      }
      await page.evaluate(() => window.__covenFixture.finish?.());
      await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toHaveCount(0);
    }
  });
}

test('legacy and custom model IDs survive Settings and relaunch; Engine default omits the ID', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 520 });
  await installRuntimeFixture(page);
  await page.addInitScript(() => {
    const key = 'opencoven.chat.preferences.v1';
    if (!localStorage.getItem(key))
      localStorage.setItem(key, JSON.stringify({ model: 'openai/gpt-5.5' }));
  });
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const picker = dialog.getByRole('combobox', { name: 'Model', exact: true });
  const custom = dialog.getByRole('textbox', { name: 'Custom model ID' });
  const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
  for (const id of ['openai/gpt-5.5', 'provider/my-custom-model']) {
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await dialog.getByRole('button', { name: 'Model', exact: true }).click();
    await expect(picker).toHaveValue(':custom');
    await expect(custom).toHaveValue(id);
    await custom.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`custom-${id.replaceAll('/', '-')}.png`) });
    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await expect(composer).toBeEnabled();
    await composer.fill('Keep the saved model');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.__covenFixture.inputs?.at(-1)))
      .toMatchObject({ model: id });
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await dialog.getByRole('button', { name: 'Model', exact: true }).click();
    await custom.fill('provider/my-custom-model');
    await page.reload();
  }
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await dialog.getByRole('button', { name: 'Model', exact: true }).click();
  await picker.selectOption('');
  await expect(picker).toHaveValue('');
  await expect(custom).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(composer).toBeEnabled();
  await composer.fill('Use the engine default');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__covenFixture.inputs?.length)).toBe(3);
  expect(await page.evaluate(() => window.__covenFixture.inputs?.at(-1))).not.toHaveProperty(
    'model',
  );
});
