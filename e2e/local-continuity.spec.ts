import { expect, test } from '@playwright/test';
import { localContinuityJourney } from './helpers/local-continuity';

for (const viewport of [
  { width: 1180, height: 780 },
  { width: 820, height: 600 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
]) {
  test(`local retained notes and reviewed import retries survive reload at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await localContinuityJourney({ page, viewport });
  });
}

test('a parent changed in another window cannot silently accept an earlier reviewed branch', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'New retained side note' }).click();
  await expect(page.getByRole('button', { name: 'Close note', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Original side text');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('checkbox', { name: /Original side text/ }).check();
  await page.getByRole('button', { name: 'Review Bring back', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reviewed excerpt' }).fill('Earlier reviewed excerpt');

  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
  await other
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Other window parent edit');
  await other.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    other
      .getByRole('list', { name: 'Messages' })
      .getByText('Other window parent edit', { exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Bring back reviewed excerpt', exact: true }).click();
  await expect(page.getByText(/The reviewed local branch changed/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review again', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Reviewed excerpt' })).toBeDisabled();
  await page.getByRole('button', { name: 'Return to parent', exact: true }).click();
  await expect(page.getByText('Other window parent edit', { exact: true })).toBeVisible();
  await expect(page.getByText('Earlier reviewed excerpt', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /Retained side note · open/ }).click();
  await page.getByRole('button', { name: 'Review again', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reviewed excerpt' }).fill('Fresh reviewed excerpt');
  await page.getByRole('button', { name: 'Bring back reviewed excerpt', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Reviewed excerpt' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Return to parent', exact: true }).click();
  await expect(
    page
      .getByRole('list', { name: 'Messages' })
      .getByText('Fresh reviewed excerpt', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText('Other window parent edit', { exact: true })).toBeVisible();
  await expect(page.getByText('Earlier reviewed excerpt', { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole('list', { name: 'Messages' })
      .getByText('Fresh reviewed excerpt', { exact: true }),
  ).toHaveCount(1);
});
