import { expect, test } from '@playwright/test';

test('archives and restores across reload, confirms app-local delete, and never lists tombstones', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const session = {
      id: 'lifecycle-owned',
      title: 'Lifecycle conversation',
      harness: 'coven-code',
      status: 'completed',
      updatedAt: '2026-09-14',
      projectRoot: '/fixture',
    };
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        async invoke(command: string, args: { lifecycle?: string } = {}) {
          const state = localStorage.getItem('fixture-lifecycle') ?? 'active';
          switch (command) {
            case 'coven_runtime_status':
              return { available: true, version: 'fixture' };
            case 'coven_runtime_familiars':
              return [];
            case 'coven_runtime_sessions':
              return state === 'deleted' ? [] : [{ ...session, archived: state === 'archived' }];
            case 'coven_runtime_read':
              if (state === 'deleted') throw new Error('Deleted from Chat');
              return {
                session,
                events: [
                  {
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: 'Retained local history.' }] },
                  },
                ],
              };
            case 'coven_runtime_chat_lifecycle':
              if (!args.lifecycle) throw new Error('Missing lifecycle');
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
  await expect(page.getByText('Retained local history.')).toBeVisible();
  await page.getByRole('button', { name: 'Archive chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Lifecycle conversation' })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Archived chats', exact: true }).click();
  await page.getByRole('button', { name: 'Lifecycle conversation' }).click();
  await expect(page.getByRole('textbox')).toBeDisabled();
  await page.getByRole('button', { name: 'Restore chat' }).click();
  await page.getByRole('button', { name: 'Active chats', exact: true }).click();
  await page.getByRole('button', { name: 'Lifecycle conversation' }).click();
  await expect(page.getByRole('textbox')).toBeEnabled();
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete chat from this app?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Original CLI/Cave history is untouched.');
  await expect(dialog.getByRole('button', { name: 'Keep chat' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Delete from Chat' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('fixture-lifecycle'))).toBe('active');
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete from Chat' }).click();
  await expect(page.getByRole('button', { name: 'Lifecycle conversation' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Refresh Coven' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Lifecycle conversation' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived chats', exact: true }).click();
  await expect(page.getByText('No archived chats.')).toBeVisible();
});
