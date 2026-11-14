import { expect, test } from '@playwright/test';
import { installRuntimeFixture } from './fixtures/runtime';

test('an existing Codex chat displays and dispatches its own saved model after reload', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('opencoven.chat.preferences.v1')) {
      localStorage.setItem(
        'opencoven.chat.preferences.v1',
        JSON.stringify({
          harness: 'coven-code',
          model: 'claude-opus-5-5',
          models: { 'coven-code': 'claude-opus-5-5', codex: 'gpt-6.1-sol' },
        }),
      );
      localStorage.setItem(
        'coven-browser-fixture',
        JSON.stringify({
          heads: {
            'fixture-familiar': {
              session: {
                id: 'codex-head',
                title: 'Codex conversation',
                harness: 'codex',
                status: 'completed',
                familiarId: 'fixture-familiar',
                updatedAt: '2026-11-14T00:00:00Z',
                projectRoot: '/fixture/workspace',
              },
              events: [],
            },
          },
          calls: [],
          inputs: [],
        }),
      );
    }
  });
  await installRuntimeFixture(page);
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('group', { name: 'Chat details' })).toContainText('gpt-6.1-sol');
  await page.getByRole('button', { name: 'Model settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'gpt-6.1-sol',
  );
  await settings.getByRole('combobox', { name: 'Model', exact: true }).selectOption('gpt-6-luna');
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await page.reload();
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('group', { name: 'Chat details' })).toContainText('gpt-6-luna');
  await composer.fill('hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__covenFixture.inputs?.length)).toBe(1);
  const input = await page.evaluate(() => window.__covenFixture.inputs?.[0]);
  expect(input).toMatchObject({ sessionId: 'codex-head', model: 'gpt-6-luna', prompt: 'hello' });
  expect(input).not.toHaveProperty('harness');
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('opencoven.chat.preferences.v1') ?? '{}').models[
          'coven-code'
        ],
    ),
  ).toBe('claude-opus-5-5');
});
