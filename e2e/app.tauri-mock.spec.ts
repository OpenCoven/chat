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
      let rejectRun: ((error: Error) => void) | undefined;
      type FixtureHead = {
        session: {
          id: string;
          title: string;
          harness: string;
          status: string;
          familiarId: string;
          updatedAt: string;
          projectRoot: string;
        };
        events: Record<string, unknown>[];
      };
      const saved = localStorage.getItem('coven-browser-fixture');
      const state: {
        heads: Record<string, FixtureHead>;
        calls: string[];
        inputs: unknown[];
      } = saved ? JSON.parse(saved) : { heads: {}, calls: [], inputs: [] };
      const persist = () => localStorage.setItem('coven-browser-fixture', JSON.stringify(state));
      window.__covenFixture = { calls: state.calls, inputs: state.inputs };
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
            persist();
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
                  name: index ? `Familiar ${index}` : 'Local familiar',
                  displayName: index ? `Familiar ${index}` : 'Local familiar',
                  description:
                    population > 1
                      ? 'A detailed familiar purpose. '.repeat(100)
                      : 'Native-boundary browser fixture',
                  avatarUrl,
                }));
              case 'coven_runtime_sessions':
                return Object.values(state.heads).map((head) => head.session);
              case 'coven_runtime_read': {
                const selected = Object.values(state.heads).find(
                  (head) => head.session.id === args.id,
                );
                if (!selected) throw new Error('Unexpected session read.');
                return selected;
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
                  !('familiarId' in input) ||
                  typeof input.familiarId !== 'string' ||
                  typeof input.prompt !== 'string' ||
                  typeof channel !== 'object' ||
                  !channel ||
                  !('id' in channel) ||
                  typeof channel.id !== 'number'
                )
                  throw new Error('Invalid send boundary.');
                const callback = callbacks.get(channel.id);
                if (!callback) throw new Error('Stream callback not registered.');
                const familiarId = input.familiarId;
                const current = state.heads[familiarId];
                if (
                  (current &&
                    (!('sessionId' in input) || input.sessionId !== current.session.id)) ||
                  (!current && 'sessionId' in input && input.sessionId)
                )
                  throw new Error('Send must resume this familiar canonical head.');
                const session = current?.session ?? {
                  id: `head-${input.familiarId}`,
                  title: 'A real runtime boundary fixture',
                  harness: 'coven-code',
                  status: 'completed',
                  familiarId: input.familiarId,
                  updatedAt: '2026-09-15T00:00:00Z',
                  projectRoot: '/fixture/workspace',
                };
                const events: Record<string, unknown>[] = [
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
                state.heads[familiarId] = {
                  session,
                  events: [...(current?.events ?? []), ...events],
                };
                persist();
                events.forEach((message, index) => {
                  callback({ index, message });
                });
                return new Promise((resolve, reject) => {
                  rejectRun = reject;
                  window.__covenFixture.finish = () => {
                    events.push({ type: 'result', session_id: session.id, is_error: false });
                    state.heads[familiarId] = {
                      session,
                      events: [...(current?.events ?? []), ...events],
                    };
                    persist();
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

test('keeps the familiar list and inspector scrollable inside a short window', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 390 });
  await installRuntimeFixture(page, true, undefined, 40);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Local familiar' })).toBeEnabled();
  expect(
    await page.locator('.fr-conv-scroll').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.clientHeight > 0 && element.scrollTop > 0;
    }),
  ).toBe(true);
  const lastFamiliar = page.getByRole('button', { name: 'Familiar 39', exact: true });
  await expect(lastFamiliar).toBeInViewport();
  await lastFamiliar.click();
  await page.getByRole('button', { name: "Open Familiar 39's familiar card" }).click();
  expect(
    await page.locator('.fr-inspector-panel').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.clientHeight > 0 && element.scrollTop > 0;
    }),
  ).toBe(true);
  const inspector = await page.locator('.fr-inspector').boundingBox();
  if (!inspector) throw new Error('The familiar inspector is missing.');
  expect(inspector.y + inspector.height).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page.getByRole('searchbox', { name: 'Search familiars' }).fill('Familiar 39');
  await expect(page.locator('.coven-agent-row')).toHaveCount(1);
  await expect(lastFamiliar).toBeVisible();
  expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
});

test('sends actual attachment bytes and retains them after cancellation', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 600 });
  await installRuntimeFixture(page);
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
  await expect(composer).toBeEnabled();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach file', exact: true }).click();
  await (await chooser).setFiles({
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
  await expect(page.getByRole('region', { name: 'Message composer' })).toContainText('context.md');
  await expect(page.getByRole('region', { name: 'Message composer' })).toContainText('21 bytes');
  await page.getByRole('button', { name: 'Remove context.md' }).click();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(600);
});

test('streams and reloads CLI chat without any Cave or pairing invocation', async ({ page }) => {
  await installRuntimeFixture(page);
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
  await expect(composer).toBeEnabled();
  await composer.fill('A bounded chat request');
  await page.getByLabel('Select text attachments').setInputFiles({
    name: 'retained.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('Durable attachment bytes.'),
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect(await page.evaluate(() => window.__covenFixture.inputs?.[0])).toMatchObject({
    attachments: [
      {
        name: 'retained.md',
        bytes: Array.from(Buffer.from('Durable attachment bytes.')),
      },
    ],
  });
  await expect(
    page.getByText('Streamed through the Coven boundary.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeVisible();
  await page.evaluate(() => window.__covenFixture.finish?.());
  await expect(page.getByRole('button', { name: 'Local familiar', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(composer).toHaveValue('');
  await page.reload();
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Local familiar', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(page.getByText('A bounded chat request', { exact: true })).toBeVisible();
  const files = page.getByRole('list', { name: 'Message attachments' });
  await expect(files).toContainText('retained.md');
  await expect(files).toContainText('25 bytes');
  await expect(page.getByText('Streamed through the Coven boundary.', { exact: true })).toHaveCount(
    1,
  );
  const commands = await page.evaluate(() => window.__covenFixture.calls);
  expect(commands).toContain('coven_runtime_read');
  expect(commands.every((command) => command.startsWith('coven_runtime_'))).toBe(true);
  expect(commands.some((command) => /cave|import|pair/.test(command))).toBe(false);
});

test('resumes one durable head per familiar and isolates drafts when switching', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRuntimeFixture(page, true, undefined, 2);
  await page.goto('/');
  const first = page.getByRole('textbox', { name: 'Message Local familiar' });
  const second = page.getByRole('textbox', { name: 'Message Familiar 1' });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  for (const prompt of ['First request', 'Second request']) {
    await first.fill(prompt);
    await send.click();
    await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
    await page.evaluate(() => window.__covenFixture.finish?.());
    await expect(first).toHaveValue('');
  }
  await first.fill('Unsent first familiar draft');
  await page.getByRole('button', { name: 'Familiar 1', exact: true }).click();
  await expect(second).toHaveValue('');
  await expect(page.getByText('First request', { exact: true })).toHaveCount(0);
  await second.fill('Other familiar request');
  await send.click();
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
  await page.evaluate(() => window.__covenFixture.finish?.());
  await expect(second).toHaveValue('');
  await second.fill('Unsent second familiar draft');
  await page.getByRole('button', { name: 'Local familiar', exact: true }).click();
  await expect(first).toHaveValue('Unsent first familiar draft');
  await expect(page.getByText('First request', { exact: true })).toBeVisible();
  await expect(page.getByText('Second request', { exact: true })).toBeVisible();
  await expect(page.getByText('Other familiar request', { exact: true })).toHaveCount(0);
  await first.fill('Third request on original head');
  await send.click();
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
  await page.evaluate(() => window.__covenFixture.finish?.());
  await expect(first).toHaveValue('');
  await page.getByRole('button', { name: 'Familiar 1', exact: true }).click();
  await expect(second).toHaveValue('Unsent second familiar draft');
  await page.reload();
  await expect(second).toBeEnabled();
  // Drafts are conversation content: they live in memory only and never reach
  // browser storage, so a reload keeps the selected familiar but not the text.
  await expect(second).toHaveValue('');
  const stored = await page.evaluate(
    () => localStorage.getItem('opencoven.chat.navigation.v1') ?? '',
  );
  expect(stored).not.toContain('Unsent');
  await expect(page.getByText('Other familiar request', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Local familiar', exact: true }).click();
  await expect(page.getByText('Third request on original head', { exact: true })).toBeVisible();
  const inputs = await page.evaluate(() => window.__covenFixture.inputs);
  expect(inputs).toHaveLength(4);
  expect(inputs?.[0]).toMatchObject({ familiarId: 'fixture-familiar', prompt: 'First request' });
  expect(inputs?.[0]).not.toHaveProperty('sessionId');
  expect(inputs?.[1]).toMatchObject({
    familiarId: 'fixture-familiar',
    sessionId: 'head-fixture-familiar',
  });
  expect(inputs?.[2]).toMatchObject({
    familiarId: 'fixture-familiar-1',
    prompt: 'Other familiar request',
  });
  expect(inputs?.[2]).not.toHaveProperty('sessionId');
  expect(inputs?.[3]).toMatchObject({
    familiarId: 'fixture-familiar',
    sessionId: 'head-fixture-familiar',
  });
  expect(
    await page.evaluate(() =>
      Object.keys(JSON.parse(localStorage.getItem('coven-browser-fixture') ?? '{}').heads),
    ),
  ).toHaveLength(2);
  await expect(page.locator('.coven-agent-row')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: /import.*cave|switch familiar|new chat/i }),
  ).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.__covenFixture.calls)).some((command) =>
      /cave|import|pair/.test(command),
    ),
  ).toBe(false);
  await page.getByLabel('Select text attachments').setInputFiles({
    name: 'project-context.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('Project context for the next familiar message.'),
  });
  await expect(page.getByRole('button', { name: 'Remove project-context.md' })).toBeVisible();
  await expect(send).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('canonical-familiar-ui.png') });
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

test('keeps cancellation available after switching to another familiar', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 390 });
  await installRuntimeFixture(page, true, undefined, 2);
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
  await composer.fill('Keep the running familiar draft');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Familiar 1', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Familiar 1' })).toHaveValue('');
  await page.getByRole('button', { name: 'Stop run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Local familiar', exact: true }).click();
  await expect(composer).toHaveValue('Keep the running familiar draft');
  await expect(page.getByRole('alert')).toContainText('cancelled');
  expect(await page.evaluate(() => window.__covenFixture.calls)).toContain('coven_runtime_cancel');
  expect(
    await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      x: window.scrollX,
      y: window.scrollY,
    })),
  ).toEqual({ height: 390, x: 0, y: 0 });
});

// The empty transcript is the surface that told a reader to "select a familiar"
// under a "Chat with Astra" heading, on top of a live run. Each state below is
// reached through the real app: driving ChatLayout with synthetic props once
// "verified" a combination (`ready` without a selection) that cannot occur.
test.describe('empty transcript states', () => {
  test('names the missing runtime rather than a familiar choice', async ({ page }) => {
    await installRuntimeFixture(page, false);
    await page.goto('/');
    await expect(
      page.getByText('Connect to your local Coven CLI to see real conversations here.'),
    ).toBeVisible();
    // Top bar, transcript and inspector must agree. Each of these used to read
    // "Coven" -- a portrait and a name for a familiar that does not exist.
    await expect(page.locator('.fr-thread-empty-title')).toHaveText('No familiar selected');
    await expect(page.getByRole('button', { name: 'No familiar selected' })).toBeDisabled();
    await expect(page.locator('.fr-inspector-kind')).toHaveText('No familiar selected');
    await expect(page.locator('.fr-inspector-name')).toHaveText('Coven CLI');
    await expect(page.locator('.fr-thread-empty img')).toHaveCount(0);
    // Transcript and composer must blame the same obstacle.
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveAttribute(
      'placeholder',
      'Connect to your local Coven CLI to send a message.',
    );
  });

  test('asks for a selection when the runtime is healthy and nothing is chosen', async ({
    page,
  }) => {
    await installRuntimeFixture(page, true, 'unused', 0);
    await page.goto('/');
    await expect(
      page.getByText('Select a familiar from the sidebar to start a conversation.'),
    ).toBeVisible();
    // The regression this guards: `ready` is false here because nothing is
    // selected, so keying the copy on it claimed a healthy CLI was unreachable.
    await expect(page.getByText(/Connect to your local Coven CLI/)).toHaveCount(0);
  });

  test('keeps the inspector header on one line with no familiar to portray', async ({ page }) => {
    await installRuntimeFixture(page, true, 'unused', 0);
    await page.goto('/');
    const name = page.locator('.fr-inspector-name');
    await expect(name).toBeVisible();
    // .fr-inspector-head is a 22px/1fr/auto grid. Dropping the avatar without
    // keeping its slot pushed this text into 22px, wrapping it over the close
    // icon -- a break every unit test passed straight through.
    const box = await name.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height).toBeLessThan(24);
  });

  test('greets a selected familiar without contradicting its own heading', async ({ page }) => {
    await installRuntimeFixture(page);
    await page.goto('/');
    await expect(page.getByText('Chat with Local familiar')).toBeVisible();
    await expect(page.getByText(/start of your conversation with Local familiar/)).toBeVisible();
    await expect(page.getByText(/Select a familiar/)).toHaveCount(0);
  });

  test('never shows the empty state beside a running indicator', async ({ page }) => {
    await installRuntimeFixture(page);
    await page.goto('/');
    const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
    await expect(composer).toBeEnabled();
    await composer.fill('Start a run');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeVisible();
    await expect(page.locator('.fr-thread-empty')).toHaveCount(0);
    await page.evaluate(() => window.__covenFixture.finish?.());
  });
});

test('missing CLI shows actionable setup in the same interface', async ({ page }) => {
  await installRuntimeFixture(page, false);
  await page.goto('/');
  await expect(page.locator('.fr-shell')).toBeVisible();
  await expect(page.getByText(/Coven CLI is not installed/)).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeDisabled();
  // The field names the missing runtime, matching the transcript behind it.
  await expect(composer).toHaveAttribute(
    'placeholder',
    'Connect to your local Coven CLI to send a message.',
  );
  expect(await page.evaluate(() => window.__covenFixture.calls)).toEqual(['coven_runtime_status']);
});

test('renders native PNG avatars in the familiar list, conversation, and inspector', async ({
  page,
}) => {
  await installRuntimeFixture(page);
  await page.goto('/');
  for (const selector of ['.coven-agent-row img', '.fr-thread-empty img', '.fr-inspector img']) {
    const avatar = page.locator(selector);
    await expect(avatar).toBeVisible();
    await expect
      .poll(() =>
        avatar.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
  }
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
  await page.getByRole('button', { name: "Open Local familiar's familiar card" }).click();
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
    await expect(page.locator('.fr-shell')).toHaveAttribute('data-inspector', 'closed');
    if (viewport.width > 760) {
      await page.getByRole('button', { name: 'Hide familiars', exact: true }).click();
    } else {
      await expect(page.locator('.fr-shell')).toHaveAttribute('data-sidebar', 'closed');
      await page.getByRole('button', { name: 'Show familiars', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Local familiar', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Hide familiars', exact: true }).click();
    }
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
