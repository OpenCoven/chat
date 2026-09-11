import { expect, test } from '@playwright/test';
import { localContinuityJourney } from './helpers/local-continuity';

test('local retained notes and reviewed import retries survive reload with distinct close and discard', async ({
  page,
}) => {
  await localContinuityJourney({ page });
});

test('a parent changed in another window cannot silently accept an earlier reviewed branch', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'New retained side note' }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Original side text');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('checkbox', { name: /Original side text/ }).check();
  await page.getByRole('button', { name: 'Review Bring back', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reviewed excerpt' }).fill('Earlier reviewed excerpt');

  const other = await context.newPage();
  await other.goto('/');
  await other
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Other window parent edit');
  await other.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(other.getByText('Other window parent edit', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Bring back reviewed excerpt', exact: true }).click();
  await expect(page.getByText(/This operation conflicts with its earlier request/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Reviewed excerpt' })).toBeDisabled();
  await page.getByRole('button', { name: 'Return to parent', exact: true }).click();
  await expect(page.getByText('Other window parent edit', { exact: true })).toBeVisible();
  await expect(page.getByText('Earlier reviewed excerpt', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Other window parent edit', { exact: true })).toBeVisible();
  await expect(page.getByText('Earlier reviewed excerpt', { exact: true })).toHaveCount(0);
});
