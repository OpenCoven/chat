import { expect, type Page, test } from '@playwright/test';

declare global {
  interface Window {
    __covenFixture: { calls: string[]; inputs?: unknown[]; finish?: () => void };
  }
}

async function installRuntimeFixture(
  page: Page,
  available = true,
  reply = 'Streamed through the Coven boundary.',
  population = 1,
) {
  await page.addInitScript(
    ({ ready, reply, population }) => {
      const portrait = document.createElement('canvas');
      portrait.width = 2;
      portrait.height = 2;
      const paint = portrait.getContext('2d');
      if (!paint) throw new Error('Cannot create the PNG avatar fixture.');
      paint.fillStyle = '#9386d0';
      paint.fillRect(0, 0, 2, 2);
      const avatarUrl = portrait.toDataURL('image/png');
      const callbacks = new Map<number, (data: unknown) => void>();
      let callbackId = 0;
      let completed = false;
      let rejectRun: ((error: Error) => void) | undefined;
      const session = {
        id: 'fixture-session',
        title: 'A real runtime boundary fixture',
        harness: 'coven-code',
        status: 'completed',
        familiarId: 'fixture-familiar',
        updatedAt: '2026-09-15T00:00:00Z',
        projectRoot: '/fixture/workspace',
      };
      const crowdedSessions = Array.from({ length: population }, (_, index) => ({
        ...session,
        id: `fixture-session-${index}`,
        title: `Conversation ${index}`,
      }));
      let events: Record<string, unknown>[] = [];
      const importedId = `cave-import-${'a'.repeat(64)}`;
      const importedSession = {
        ...session,
        id: importedId,
        title: 'Imported Cave discussion',
        harness: 'cave-import',
        status: 'imported',
        projectRoot: '',
      };
      let imported = false;
      window.__covenFixture = { calls: [], inputs: [] };
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        value: {
          transformCallback(callback: (data: unknown) => void) {
            callbacks.set(++callbackId, callback);
            return callbackId;
          },
          unregisterCallback(id: number) {
            callbacks.delete(id);
          },
          async invoke(command: string, args: Record<string, unknown> = {}) {
            window.__covenFixture.calls.push(command);
            switch (command) {
              case 'coven_runtime_status':
                return ready
                  ? {
                      available: true,
                      version: 'fixture',
                      transport: 'cli',
                      sdkHealth: 'unavailable',
                    }
                  : {
                      available: false,
                      error: 'Coven CLI is not installed. Install Coven CLI, then retry.',
                    };
              case 'coven_runtime_familiars':
                return Array.from({ length: population }, (_, index) => ({
                  id: index ? `fixture-familiar-${index}` : 'fixture-familiar',
                  name: 'fixture',
                  displayName: index ? `Familiar ${index}` : 'Local familiar',
                  description:
                    population > 1
                      ? 'A detailed familiar purpose. '.repeat(100)
                      : 'Native-boundary browser fixture',
                  avatarUrl,
                }));
              case 'coven_runtime_sessions':
                return [
                  ...(completed ? [session] : population > 1 ? crowdedSessions : []),
                  ...(imported ? [importedSession] : []),
                ];
              case 'coven_runtime_import_cave':
                if (typeof args.source !== 'string') throw new Error('Missing Cave source.');
                imported = true;
                return { session: importedSession };
              case 'coven_runtime_read': {
                if (args.id === importedId && imported)
                  return {
                    session: importedSession,
                    events: [
                      {
                        type: 'assistant',
                        message: {
                          content: [
                            { type: 'text', text: '## Imported history\n\nRetained Cave reply.' },
                          ],
                        },
                      },
                    ],
                  };
                const selected =
                  args.id === session.id
                    ? session
                    : crowdedSessions.find((item) => item.id === args.id);
                if (!selected) throw new Error('Unexpected session read.');
                return { session: selected, events };
              }
              case 'coven_runtime_send': {
                const input = args.input;
                window.__covenFixture.inputs?.push(input);
                const channel = args.onEvent;
                if (
                  typeof input !== 'object' ||
                  !input ||
                  !('prompt' in input) ||
                  !('runId' in input) ||
                  typeof input.prompt !== 'string' ||
                  typeof channel !== 'object' ||
                  !channel ||
                  !('id' in channel) ||
                  typeof channel.id !== 'number'
                )
                  throw new Error('Invalid send boundary.');
                const callback = callbacks.get(channel.id);
                if (!callback) throw new Error('Stream callback not registered.');
                events = [
                  { type: 'system', subtype: 'init', session_id: session.id },
                  {
                    type: 'user',
                    session_id: session.id,
                    attachments:
                      'attachments' in input && Array.isArray(input.attachments)
                        ? input.attachments.map((file: { name: string; bytes: number[] }) => ({
                            name: file.name,
                            size: file.bytes.length,
                          }))
                        : [],
                    message: { content: [{ type: 'text', text: input.prompt }] },
                  },
                  {
                    type: 'assistant',
                    session_id: session.id,
                    message: {
                      content: [{ type: 'text', text: reply }],
                    },
                  },
                ];
                events.forEach((message, index) => {
                  callback({ index, message });
                });
                return new Promise((resolve, reject) => {
                  rejectRun = reject;
                  window.__covenFixture.finish = () => {
                    completed = true;
                    events.push({ type: 'result', session_id: session.id, is_error: false });
                    callback({ index: events.length - 1, message: events[events.length - 1] });
                    callback({ index: events.length, end: true });
                    resolve({ runId: input.runId, events });
                  };
                });
              }
              case 'coven_runtime_cancel':
                rejectRun?.(new Error('Coven run was cancelled.'));
                return null;
              default:
                throw new Error(`Unexpected native command: ${command}`);
            }
          },
        },
      });
    },
    { ready: available, reply, population },
  );
}

test('keeps crowded rails and the familiar menu scrollable inside a short window', async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 390 });
  await installRuntimeFixture(page, true, undefined, 40);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Local familiar' })).toBeEnabled();
  for (const selector of ['.fr-conv-scroll', '.fr-inspector-panel']) {
    expect(
      await page.locator(selector).evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return element.clientHeight > 0 && element.scrollTop > 0;
      }),
    ).toBe(true);
  }
  await expect(page.getByRole('button', { name: 'Conversation 39', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Switch familiar' }).click();
  const lastFamiliar = page.getByRole('button', {
    name: 'Familiar 39 avatar Familiar 39',
    exact: true,
  });
  await lastFamiliar.scrollIntoViewIfNeeded();
  await expect(lastFamiliar).toBeInViewport();
  const menu = await page.locator('.fr-switcher-menu').boundingBox();
  if (!menu) throw new Error('The familiar menu is missing.');
  expect(menu.y + menu.height).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
});

test('sends actual attachment bytes and retains them after cancellation', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 600 });
  await installRuntimeFixture(page);
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
  await expect(composer).toBeEnabled();
  await page.getByLabel('Select text attachments').setInputFiles({
    name: 'context.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('Actual context bytes.'),
  });
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect(await page.evaluate(() => window.__covenFixture.inputs?.[0])).toMatchObject({
    prompt: '',
    attachments: [{ name: 'context.md', bytes: Array.from(Buffer.from('Actual context bytes.')) }],
  });
  await page.getByRole('button', { name: 'Stop run', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cancelled');
  await page.getByRole('button', { name: 'Remove context.md' }).click();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(600);
});

test('imports a Cave snapshot only on explicit confirmation and keeps it read-only', async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 390 });
  await installRuntimeFixture(page);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Local familiar' })).toBeEnabled();
  await page.getByRole('button', { name: 'Import from Cave', exact: true }).click();
  await page.getByLabel('Cave conversation JSON').setInputFiles({
    name: 'cave-conversation.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  expect(await page.evaluate(() => window.__covenFixture.calls)).not.toContain(
    'coven_runtime_import_cave',
  );
  await page.getByRole('button', { name: 'Import selected conversation' }).click();
  await expect(page.getByRole('heading', { name: 'Imported history' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Imported Cave discussion', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Local familiar' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Local familiar' })).toBeEnabled();
  await page
    .getByRole('textbox', { name: 'Message Local familiar' })
    .fill('Keep cancellation available');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Imported Cave discussion', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Local familiar' })).toBeDisabled();
  await page.getByRole('button', { name: 'Stop run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__covenFixture.calls)).toContain('coven_runtime_cancel');
  const frame = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    y: window.scrollY,
  }));
  expect(frame).toEqual({ height: 390, y: 0 });
  expect(
    (await page.evaluate(() => window.__covenFixture.calls)).every((command) =>
      command.startsWith('coven_runtime_'),
    ),
  ).toBe(true);
});

test('streams and reloads CLI chat without any Cave or pairing invocation', async ({ page }) => {
  await installRuntimeFixture(page);
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
  await expect(composer).toBeEnabled();
  await composer.fill('A bounded chat request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByText('Streamed through the Coven boundary.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeVisible();
  await page.evaluate(() => window.__covenFixture.finish?.());
  await expect(page.getByRole('button', { name: 'A real runtime boundary fixture' })).toBeVisible();
  await expect(composer).toHaveValue('');
  await expect(page.getByText('Streamed through the Coven boundary.', { exact: true })).toHaveCount(
    1,
  );
  const commands = await page.evaluate(() => window.__covenFixture.calls);
  expect(commands).toContain('coven_runtime_read');
  expect(commands.every((command) => command.startsWith('coven_runtime_'))).toBe(true);
});

test('cancellation retains the submitted draft instead of pretending success', async ({ page }) => {
  await installRuntimeFixture(page);
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
  await expect(composer).toBeEnabled();
  await composer.fill('Keep this draft after cancellation');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Stop run', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cancelled');
  await expect(composer).toHaveValue('Keep this draft after cancellation');
  expect(await page.evaluate(() => window.__covenFixture.calls)).toContain('coven_runtime_cancel');
});

test('missing CLI shows actionable setup in the same interface', async ({ page }) => {
  await installRuntimeFixture(page, false);
  await page.goto('/');
  await expect(page.locator('.fr-shell')).toBeVisible();
  await expect(page.getByText(/Coven CLI is not installed/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Coven', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__covenFixture.calls)).toEqual(['coven_runtime_status']);
});

test('renders native PNG avatars in the switcher, conversation, and inspector', async ({
  page,
}) => {
  await installRuntimeFixture(page);
  await page.goto('/');
  for (const selector of ['.fr-switcher img', '.fr-thread-empty img', '.fr-inspector img']) {
    const avatar = page.locator(selector);
    await expect(avatar).toBeVisible();
    await expect
      .poll(() =>
        avatar.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
  }
  await page.getByRole('button', { name: 'Switch familiar' }).click();
  await expect(page.locator('.fr-switcher-option img')).toBeVisible();
});

test('opens the familiar card from a reply with keyboard and pointer controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 600 });
  await installRuntimeFixture(page);
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
  await expect(composer).toBeEnabled();
  await composer.fill('Show a reply');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  await page.getByRole('button', { name: 'Close inspector' }).click();
  const triggers = page.getByRole('button', { name: "Show Local familiar's familiar card" });
  await triggers.first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Overview' })).toContainText(
    'Native-boundary browser fixture',
  );
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await triggers.last().click();
  await expect(page.getByRole('region', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
  await page.evaluate(() => window.__covenFixture.finish?.());
});

test('formats streamed replies and keeps wide code and tables inside the transcript', async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 780 });
  const reply = [
    '## Structured reply',
    '',
    '**Important** and *readable*.',
    '',
    '1. First item',
    '2. Second item',
    '',
    '```ts',
    `const content = "${'long-value-'.repeat(100)}";`,
    '```',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Content | ${'table-content-'.repeat(80)} |`,
  ].join('\n');
  await installRuntimeFixture(page, true, reply);
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
  await expect(composer).toBeEnabled();
  await composer.fill('Please format the result.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Structured reply', level: 2 })).toBeVisible();
  await expect(page.locator('.coven-formatted strong')).toHaveText('Important');
  await expect(page.getByRole('columnheader', { name: 'Field' })).toBeVisible();
  const bounds = await page.evaluate(() => {
    const code = document.querySelector('.coven-formatted pre');
    const transcript = document.querySelector('.fr-transcript');
    if (!code || !transcript) throw new Error('Formatted transcript is missing.');
    return {
      page: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      codeWidth: code.clientWidth,
      codeScroll: code.scrollWidth,
      codeRight: code.getBoundingClientRect().right,
      transcriptRight: transcript.getBoundingClientRect().right,
    };
  });
  expect(bounds.page).toBeLessThanOrEqual(bounds.viewport);
  expect(bounds.codeScroll).toBeGreaterThan(bounds.codeWidth);
  expect(bounds.codeRight).toBeLessThanOrEqual(bounds.transcriptRight);
  await page.evaluate(() => window.__covenFixture.finish?.());
  await expect(page.getByRole('heading', { name: 'Structured reply' })).toHaveCount(1);
});

for (const viewport of [
  { width: 820, height: 780 },
  { width: 360, height: 390 },
  { width: 300, height: 260 },
]) {
  test(`keeps the app frame stationary at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await installRuntimeFixture(
      page,
      true,
      Array.from({ length: 80 }, (_, index) => `Paragraph ${index}: a long conversation.`).join(
        '\n\n',
      ),
    );
    await page.goto('/');
    const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
    await expect(composer).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        })),
      )
      .toEqual(viewport);
    await page.getByRole('button', { name: 'Hide conversations', exact: true }).click();
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    await composer.fill('A long draft line.\n'.repeat(80));
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(
      page.locator('.fr-familiar.coven-message, .fr-familiar .coven-message'),
    ).toContainText('Paragraph 79');

    const transcript = page.getByRole('log', { name: 'Messages' });
    await expect
      .poll(() =>
        transcript.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          return element.clientHeight > 0 && element.scrollTop > 0;
        }),
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Stop run', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeInViewport();
    const frame = await page.evaluate(() => {
      window.scrollTo(1000, 1000);
      const elements = ['html', 'body', '#root', '.fr-shell', '.fr-thread'].map((selector) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing frame: ${selector}`);
        element.scrollTo(1000, 1000);
        const bounds = element.getBoundingClientRect();
        return {
          selector,
          x: element.scrollLeft,
          y: element.scrollTop,
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
        };
      });
      return {
        elements,
        x: window.scrollX,
        y: window.scrollY,
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        overscroll: getComputedStyle(document.documentElement).overscrollBehavior,
      };
    });
    expect(frame.width).toBeLessThanOrEqual(viewport.width);
    expect(frame.height).toBeLessThanOrEqual(viewport.height);
    expect(frame.x).toBe(0);
    expect(frame.y).toBe(0);
    for (const element of frame.elements) {
      expect(element, element.selector).toMatchObject({ x: 0, y: 0, top: 0 });
      expect(element.left, element.selector).toBeGreaterThanOrEqual(0);
      expect(element.right, element.selector).toBeLessThanOrEqual(viewport.width);
      expect(element.bottom, element.selector).toBeLessThanOrEqual(viewport.height);
    }
    expect(frame.overscroll).toBe('none');
    await transcript.hover();
    await page.mouse.wheel(0, 10000);
    await expect
      .poll(() => page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })))
      .toEqual({ x: 0, y: 0 });
  });
}
