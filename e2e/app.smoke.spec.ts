import { expect, test } from '@playwright/test';

test('preserves the local demo routes alongside the default app', async ({ page }) => {
  await page.goto('/?demo=chat');

  await expect(page).toHaveURL('http://127.0.0.1:4174/?demo=chat');
  await expect(page.getByRole('complementary', { name: 'Conversations sidebar' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Held action' })).toBeVisible();
  // Exact: the composer also has a "Send options" caret beside Send.
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send options' })).toBeVisible();

  await page.goto('/?demo=messages');

  await expect(page).toHaveURL('http://127.0.0.1:4174/?demo=messages');
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

  await page.goto('/?demo=minimal');

  await expect(page).toHaveURL('http://127.0.0.1:4174/?demo=minimal');
  await expect(page.getByText('Chats', { exact: true })).toBeVisible();
  await expect(page.getByText('Familiars', { exact: true })).toBeVisible();
});

test('keeps the chat sidebar compact and fully interactive', async ({ page }) => {
  await page.goto('/?demo=messages');

  const sidebar = page.getByRole('complementary', { name: 'Conversations' });
  await expect(sidebar.locator('select')).toHaveCount(0);

  for (const [selector, maximumHeight] of [
    ['.sidebar-header-toggle', 40],
    ['.familiar-switcher', 46],
    ['.new-conversation', 36],
    ['.conversation-search-trigger', 36],
    ['.conversation', 58],
  ] as const) {
    const box = await sidebar.locator(selector).first().boundingBox();
    expect(box?.height).toBeLessThanOrEqual(maximumHeight);
  }

  const familiarBox = await sidebar.locator('.familiar-switcher').boundingBox();
  const newChatBox = await sidebar.locator('.new-conversation').boundingBox();
  expect(familiarBox?.height).toBeGreaterThanOrEqual(42);
  expect(
    (newChatBox?.y ?? 0) - ((familiarBox?.y ?? 0) + (familiarBox?.height ?? 0)),
  ).toBeGreaterThanOrEqual(12);

  await expect(sidebar.getByRole('heading', { name: /Recent/ })).toBeVisible();
  await expect(sidebar.locator('.conversation-status-rail')).toHaveCount(2);
  await expect(sidebar.getByRole('button', { name: 'Start a new chat' })).toContainText('New Chat');
  await expect(sidebar.getByRole('button', { name: 'Search conversations' })).toBeVisible();
  const sparseConversation = await sidebar.locator('.conversation').first().boundingBox();
  expect(sparseConversation?.height).toBeGreaterThanOrEqual(52);

  await page.getByText('Conversations', { exact: true }).click();
  await expect(sidebar).toBeHidden();
  await page.getByRole('button', { name: 'Show conversations' }).click();

  await page.getByRole('button', { name: 'Sidebar familiar: Astra' }).click();
  await expect(page.getByRole('menuitemradio', { name: /Cody/ })).toBeVisible();
  await page.getByRole('menuitemradio', { name: /Cody/ }).click();
  await expect(page.getByRole('button', { name: 'Sidebar familiar: Cody' })).toBeVisible();
});

test('does not reserve a top row for the active familiar', async ({ page }) => {
  await page.goto('/?demo=messages');

  await expect(page.locator('.thread-header')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Active familiar: Astra' })).toHaveCount(0);
});

test('opens conversation command search from the rail and keyboard shortcut', async ({ page }) => {
  await page.goto('/?demo=messages');

  await page.getByRole('button', { name: 'Search conversations' }).click();
  const dialog = page.getByRole('dialog', { name: 'Search conversations' });
  const input = dialog.getByRole('searchbox', { name: 'Search conversations' });
  await expect(input).toBeFocused();

  await input.fill('new');
  await expect(dialog.getByRole('button', { name: /Quick Chat/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: /New Chat/ }).click();
  await expect(page.getByRole('heading', { name: 'Cody' })).toBeVisible();

  await page.keyboard.press('Meta+k');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Meta+k');
  await expect(dialog).toBeHidden();
});

test('resizes both desktop side rails by dragging their inner edges', async ({ page }) => {
  await page.goto('/?demo=messages');

  const conversations = page.getByRole('complementary', { name: 'Conversations' });
  const inspector = page.getByRole('complementary', { name: 'Agent inspector' });
  const conversationsHandle = page.getByRole('separator', {
    name: 'Resize conversations sidebar',
  });
  const inspectorHandle = page.getByRole('separator', { name: 'Resize agent inspector' });

  const conversationsBefore = await conversations.boundingBox();
  const leftHandleBox = await conversationsHandle.boundingBox();
  if (!leftHandleBox) {
    throw new Error('Conversations resize handle is not visible');
  }
  await page.mouse.move(leftHandleBox.x + leftHandleBox.width / 2, leftHandleBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(leftHandleBox.x + 64, leftHandleBox.y + 100);
  await page.mouse.up();
  const conversationsAfter = await conversations.boundingBox();
  expect(conversationsAfter?.width).toBeGreaterThan((conversationsBefore?.width ?? 0) + 40);

  const inspectorBefore = await inspector.boundingBox();
  const rightHandleBox = await inspectorHandle.boundingBox();
  if (!rightHandleBox) {
    throw new Error('Inspector resize handle is not visible');
  }
  await page.mouse.move(rightHandleBox.x + rightHandleBox.width / 2, rightHandleBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(rightHandleBox.x - 64, rightHandleBox.y + 100);
  await page.mouse.up();
  const inspectorAfter = await inspector.boundingBox();
  expect(inspectorAfter?.width).toBeGreaterThan((inspectorBefore?.width ?? 0) + 40);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(conversationsHandle).toBeHidden();
});

test('expands generated images against a focused dark backdrop', async ({ page }) => {
  await page.goto('/?demo=messages');

  const inlineImage = page.getByRole('button', {
    name: 'Expand image: A purple cat in a glowing garden',
  });
  const inlineBox = await inlineImage.boundingBox();
  await inlineImage.click();

  const dialog = page.getByRole('dialog', {
    name: 'Expanded image: A purple cat in a glowing garden',
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.9)');

  const expandedBox = await dialog.locator('.generated').boundingBox();
  expect(expandedBox?.width).toBeGreaterThan((inlineBox?.width ?? 0) * 1.5);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('shows an expandable reasoning summary for the demo response', async ({ page }) => {
  await page.goto('/?demo=messages');

  const reasoning = page.locator('.reasoning-block');
  const toggle = reasoning.getByRole('button');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(reasoning).toContainText('Identified “cat” as the subject');
  await expect(reasoning).toContainText('prompt.parse');
  await expect(reasoning).toContainText('3 tool calls');
  await expect(reasoning.locator('.reasoning-step-icon')).toHaveCount(3);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(reasoning.locator('.reasoning-body')).toHaveAttribute('aria-hidden', 'true');
});
