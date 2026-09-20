import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const session = {
      id: 'lifecycle-owned',
      title: 'Lifecycle conversation',
      harness: 'coven-code',
      familiarId: 'lifecycle-familiar',
      status: 'completed',
      updatedAt: '2026-09-14',
      projectRoot: '/fixture',
    };
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        async invoke(command: string, args: { id?: string; lifecycle?: string } = {}) {
          const state = localStorage.getItem('fixture-lifecycle') ?? 'active';
          switch (command) {
            case 'coven_runtime_status':
              return { available: true, version: 'fixture' };
            case 'coven_runtime_familiars':
              return [
                {
                  id: 'lifecycle-familiar',
                  name: 'Lifecycle familiar',
                  displayName: 'Lifecycle familiar',
                },
              ];
            case 'coven_runtime_sessions':
              return state === 'deleted' ? [] : [{ ...session, archived: state === 'archived' }];
            case 'coven_runtime_read':
              if (state === 'deleted') throw new Error('Deleted from Chat');
              return {
                session: { ...session, archived: state === 'archived' },
                events: [
                  {
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: 'Retained local history.' }] },
                  },
                ],
              };
            case 'coven_runtime_chat_lifecycle':
              if (!args.lifecycle) throw new Error('Missing lifecycle');
              if (args.id !== session.id) throw new Error('Lifecycle targeted the wrong head');
              localStorage.setItem('fixture-lifecycle', args.lifecycle);
              return null;
            default:
              throw new Error(`Unexpected command: ${command}`);
          }
        },
      },
    });
  });
  await page.goto('/');
});

test('archives and restores across reload through the archived view', async ({ page }) => {
  await expect(page.getByText('Retained local history.')).toBeVisible();
  const archived = page.getByRole('checkbox', { name: 'Show archived chats' });
  // The control lives inside a collapsed User settings disclosure.
  await expect(archived).not.toBeVisible();
  await expect(page.getByRole('button', { name: /^(Active|Archived)$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Archive chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Lifecycle familiar', exact: true })).toHaveCount(
    0,
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Refresh Coven' })).toBeEnabled();
  await expect(archived).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Lifecycle familiar', exact: true })).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => localStorage.getItem('fixture-lifecycle'))).toBe('archived');

  // The archived view is the only route back to an archived chat.
  await page.getByText('User settings', { exact: true }).click();
  await archived.check();
  await page.getByRole('button', { name: 'Lifecycle familiar', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Message Lifecycle familiar/ })).toBeDisabled();
  await expect(page.getByText('Retained local history.')).toBeVisible();
  await page.getByRole('button', { name: 'Restore chat' }).click();
  await archived.uncheck();
  await page.getByRole('button', { name: 'Lifecycle familiar', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('textbox', { name: /^Message Lifecycle familiar/ })).toBeEnabled();
  await expect(page.getByText('Retained local history.')).toBeVisible();
});

test('confirms app-local delete and never lists tombstones', async ({ page }) => {
  await expect(page.getByRole('textbox', { name: 'Message Lifecycle familiar' })).toBeEnabled();
  await expect(page.getByText('Retained local history.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete chat from this app?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/Original CLI.*history is untouched/);
  await expect(dialog.getByRole('button', { name: 'Keep chat' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Delete from Chat' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('fixture-lifecycle'))).toBeNull();
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete from Chat' }).click();
  await expect(page.getByText('Retained local history.')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('fixture-lifecycle'))).toBe('deleted');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Refresh Coven' })).toBeEnabled();
  await expect(page.getByText('Retained local history.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lifecycle familiar', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete chat', exact: true })).toHaveCount(0);
  const archived = page.getByRole('checkbox', { name: 'Show archived chats' });
  await expect(archived).not.toBeVisible();
  await page.getByText('User settings', { exact: true }).click();
  await archived.check();
  await expect(page.getByText('No archived familiars.')).toBeVisible();
});
