import { expect, test } from '@playwright/test';

test('local chat is usable in the browser without Cave', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByText('Coven Cave needs the desktop app. Local chat works here.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect to Cave' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Coven Cave' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Local chat', exact: true })).toBeVisible();
});

test('a locally composed message is kept without a fabricated reply', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'New' }).click();
  await expect(page.getByRole('option', { name: /New conversation/ })).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('a note only this device holds');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('a note only this device holds')).toBeVisible();
  await expect(page.getByText(/No familiar is connected|kept in memory only/)).toBeVisible();
});

for (const viewport of [
  { width: 1180, height: 780 },
  { width: 820, height: 600 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
]) {
  test(`keeps chat controls within the ${viewport.width}px viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('LongMessage'.repeat(80));
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('LongMessage'.repeat(80), { exact: true })).toBeVisible();

    const bounds = await page.evaluate(() => {
      const bar = document.querySelector('.app-source-bar')?.getBoundingClientRect();
      const composer = document.querySelector('.chat-composer')?.getBoundingClientRect();
      const input = document.querySelector('.chat-composer__input')?.getBoundingClientRect();
      const send = document.querySelector('.chat-composer__send')?.getBoundingClientRect();
      const thread = document.querySelector('.chat-shell__thread-body');
      if (!bar || !composer || !input || !send || !thread) {
        throw new Error('Chat controls are missing');
      }
      const root = document.documentElement;
      return {
        top: bar.top,
        bottom: composer.bottom,
        height: root.scrollHeight,
        width: root.scrollWidth,
        inputLeft: input.left,
        inputWidth: input.width,
        sendRight: send.right,
        threadHeight: thread.clientHeight,
      };
    });
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(viewport.height);
    expect(bounds.height).toBeLessThanOrEqual(viewport.height);
    expect(bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.inputLeft).toBeGreaterThanOrEqual(0);
    expect(bounds.inputWidth).toBeGreaterThan(0);
    expect(bounds.sendRight).toBeLessThanOrEqual(viewport.width);
    expect(bounds.threadHeight).toBeGreaterThan(0);
  });
}
