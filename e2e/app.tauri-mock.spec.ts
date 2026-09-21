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
  // When set, these frames replace the single assistant reply so a test can
  // stream the structured tool shapes the runtime documents.
  stream?: Record<string, unknown>[],
) {
  await page.addInitScript(
    ({ ready, reply, population, stream }) => {
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
                  workspace: `/fixture/familiars/${index}/workspace`,
                  projectAccess: index
                    ? [{ name: 'private', path: `/fixture/private/${index}`, access: 'read' }]
                    : [
                        {
                          name: 'workspace',
                          path: '/fixture/familiars/0/workspace',
                          access: 'write',
                        },
                        {
                          name: 'workspace',
                          path: '/fixture/projects/library/workspace',
                          access: 'read',
                        },
                        { name: 'workspace', path: '/fixture/workspace', access: 'write' },
                      ],
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
                  ...(stream
                    ? stream.map((frame) => ({ ...frame, session_id: session.id }))
                    : [
                        {
                          type: 'assistant',
                          session_id: session.id,
                          message: {
                            content: [{ type: 'text', text: reply }],
                          },
                        },
                      ]),
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
    { ready: available, reply, population, stream },
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

test('typing anywhere starts a message with that very letter', async ({ page }) => {
  await installRuntimeFixture(page);
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message Local familiar' });
  await expect(composer).toBeEnabled();
  await page.getByRole('log', { name: 'Messages' }).focus();
  await page.keyboard.type('hey');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('hey');
  // A modifier chord and a field that already has focus are left alone.
  await page.getByRole('searchbox').focus();
  await page.keyboard.type('x');
  await expect(page.getByRole('searchbox')).toHaveValue('x');
  await expect(composer).toHaveValue('hey');
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
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remove retained.md' })).toHaveCount(0);
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
    // With no familiars at all there is nothing to select, so the copy says
    // to configure one rather than pointing at an empty list.
    await expect(
      page.getByText('No familiars are configured in Coven yet. Configure one, then refresh.'),
    ).toBeVisible();
    await expect(page.getByText(/Select a familiar from the sidebar/)).toHaveCount(0);
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

test('clarifies familiar and project references without changing the recipient', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRuntimeFixture(page, true, undefined, 2);
  await page.goto('/');
  const field = page.getByRole('textbox', { name: 'Message Local familiar' });
  await field.fill('Establish project');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
  await page.evaluate(() => window.__covenFixture.finish?.());
  await expect(field).toHaveValue('');
  await field.fill('Discuss ');
  await page.getByRole('button', { name: 'Add context', exact: true }).click();
  const search = page.getByRole('combobox', { name: 'Search familiars and workspaces' });
  await search.fill('@Familiar 1');
  await search.press('Enter');
  await expect(field).toHaveValue('Discuss @{Familiar 1} (id: "fixture-familiar-1") ');
  await expect(field).toBeFocused();
  await page.getByRole('button', { name: 'Add context', exact: true }).click();
  await search.fill('#workspace');
  await expect(page.getByRole('option')).toHaveCount(3);
  await expect(
    page.getByRole('option', { name: 'workspace /fixture/workspace', exact: true }),
  ).toContainText('Write access');
  await page.screenshot({ path: testInfo.outputPath('context-wide.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 480, height: 600 });
  await expect(page.locator('.coven-chat')).toHaveAttribute('data-tier', 'compact');
  await expect(page.locator('.coven-chat')).toHaveAttribute('data-sidebar', 'closed');
  await expect(page.locator('.coven-chat')).toHaveAttribute('data-inspector', 'closed');
  await expect(search).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('context-compact.png'),
    animations: 'disabled',
  });
  await page.getByRole('option', { name: 'workspace /fixture/workspace', exact: true }).click();
  const expected =
    'Discuss @{Familiar 1} (id: "fixture-familiar-1") #{workspace} (path: "/fixture/workspace") ';
  await expect(field).toHaveValue(expected);
  await field.press('Control+Backslash');
  await page.keyboard.press('Escape');
  await expect(field).toHaveValue(expected);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
  expect(await page.evaluate(() => window.__covenFixture.inputs?.at(-1))).toMatchObject({
    familiarId: 'fixture-familiar',
    prompt: expected,
  });
  expect(
    await page.evaluate(() => ({
      width: document.documentElement.scrollWidth <= window.innerWidth,
      height: document.documentElement.scrollHeight <= window.innerHeight,
    })),
  ).toEqual({ width: true, height: true });
  await page.evaluate(() => window.__covenFixture.finish?.());
});

test('prefills only the selected familiar’s configured read and write projects before any chat', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRuntimeFixture(page, true, undefined, 2);
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Message Local familiar' }).fill('#');
  await expect(page.getByRole('option')).toHaveCount(3);
  await expect(
    page.getByRole('option', { name: 'workspace /fixture/projects/library/workspace' }),
  ).toContainText('Read-only access');
  await expect(page.getByRole('option', { name: 'workspace /fixture/workspace' })).toContainText(
    'Write access',
  );
  await page.getByRole('button', { name: 'Familiar 1', exact: true }).click();
  const second = page.getByRole('textbox', { name: 'Message Familiar 1' });
  await second.fill('#');
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toContainText('/fixture/private/1');
  await expect(page.getByRole('option')).toContainText('Read-only access');
  await second.press('Tab');
  await expect(second).toHaveValue('#{private} (path: "/fixture/private/1") ');
  expect(await page.evaluate(() => window.__covenFixture.inputs?.length)).toBe(0);
});

test('autocompletes familiar and project mentions with Tab without sending or switching recipient', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 600 });
  await installRuntimeFixture(page, true, undefined, 2);
  await page.goto('/');
  const field = page.getByRole('textbox', { name: 'Message Local familiar' });
  await field.fill('Establish project');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
  await page.evaluate(() => window.__covenFixture.finish?.());
  await expect(field).toHaveValue('');
  await field.fill('Ask @Familiar 1');
  await expect(page.getByRole('option')).toHaveCount(1);
  await field.press('Tab');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Ask @{Familiar 1} (id: "fixture-familiar-1") ');
  await field.pressSequentially('#work');
  await expect(page.getByRole('option')).toHaveCount(3);
  await field.press('ArrowUp');
  await page.screenshot({
    path: testInfo.outputPath('inline-project-completion.png'),
    animations: 'disabled',
  });
  await field.press('Tab');
  const prompt =
    'Ask @{Familiar 1} (id: "fixture-familiar-1") #{workspace} (path: "/fixture/workspace") ';
  await expect(field).toHaveValue(prompt);
  await expect(field).toBeFocused();
  expect(await page.evaluate(() => window.__covenFixture.inputs?.length)).toBe(1);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
  expect(await page.evaluate(() => window.__covenFixture.inputs?.at(-1))).toMatchObject({
    familiarId: 'fixture-familiar',
    prompt,
  });
  await page.evaluate(() => window.__covenFixture.finish?.());
  expect(
    await page.evaluate(() => [
      document.documentElement.scrollWidth <= innerWidth,
      document.documentElement.scrollHeight <= innerHeight,
    ]),
  ).toEqual([true, true]);
});

test('dismisses inline mentions and keeps literal hashes and email addresses as text', async ({
  page,
}) => {
  await installRuntimeFixture(page);
  await page.goto('/');
  const field = page.getByRole('textbox', { name: 'Message Local familiar' });
  for (const text of ['mail@example.com', 'https://example.com/#anchor', '# Heading']) {
    await field.fill(text);
    await expect(page.getByRole('listbox')).toHaveCount(0);
  }
  await field.fill('Discuss @{Local');
  await expect(page.getByRole('option')).toHaveCount(1);
  await field.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(field).toHaveValue('Discuss @{Local');
  await field.fill('Ask @Local later');
  for (let index = 0; index < 6; index += 1) await field.press('ArrowLeft');
  expect(await field.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(10);
  await expect(page.getByRole('option')).toHaveCount(1);
  await field.press('Tab');
  await expect(field).toHaveValue('Ask @{Local familiar} (id: "fixture-familiar") later');
  expect(await page.evaluate(() => window.__covenFixture.inputs?.length)).toBe(0);
});

test('reserves full-height clickable rail tabs and widens the shared chat column', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await installRuntimeFixture(page);
  await page.goto('/');
  const field = page.getByRole('textbox', { name: 'Message Local familiar' });
  await field.fill('Show the wider chat');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
  await page.evaluate(() => window.__covenFixture.finish?.());
  await expect(field).toHaveValue('');
  await field.press('Control+Backslash');
  await field.press('Control+Shift+Backslash');
  const left = page.getByRole('button', { name: 'Show familiars', exact: true });
  const right = page.getByRole('button', { name: 'Show inspector', exact: true });
  await expect(left).toHaveText(/Familiars/);
  await expect(right).toHaveText(/Local familiar/);
  const geometry = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right };
    };
    return {
      left: bounds('.coven-rail-tab--left'),
      right: bounds('.coven-rail-tab--right'),
      column: bounds('.fr-column'),
      composer: bounds('.fr-composer-inner'),
      thread: bounds('.fr-thread'),
      assistant: bounds('.fr-familiar'),
    };
  });
  expect(geometry.left).toMatchObject({ x: 0, y: 0, width: 28, height: 900 });
  expect(geometry.right).toMatchObject({ right: 1800, y: 0, width: 28, height: 900 });
  expect(geometry.thread.x).toBeGreaterThanOrEqual(geometry.left.right);
  expect(geometry.thread.right).toBeLessThanOrEqual(geometry.right.x);
  expect(geometry.composer.width).toBe(1200);
  expect(geometry.column.width).toBe(geometry.composer.width);
  expect(geometry.column.x).toBe(geometry.composer.x);
  expect(geometry.assistant.width).toBe(geometry.composer.width);
  await page.screenshot({
    path: testInfo.outputPath('luxe-tabs-wide.png'),
    animations: 'disabled',
  });
  for (const y of [5, 450, 895]) {
    await left.click({ position: { x: 14, y } });
    await expect(page.locator('.coven-chat')).toHaveAttribute('data-sidebar', 'open');
    await page.getByRole('button', { name: 'Hide familiars', exact: true }).click();
    await right.click({ position: { x: 14, y } });
    await expect(page.locator('.coven-chat')).toHaveAttribute('data-inspector', 'open');
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  }
  await page.setViewportSize({ width: 360, height: 520 });
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  await left.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.coven-chat')).toHaveAttribute('data-sidebar', 'open');
  await page.keyboard.press('Escape');
  await expect(left).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath('luxe-tabs-compact.png'),
    animations: 'disabled',
  });
  expect(
    await page.evaluate(() => [
      document.documentElement.scrollWidth <= innerWidth,
      document.documentElement.scrollHeight <= innerHeight,
    ]),
  ).toEqual([true, true]);
});

test('toggles rails by keyboard while preserving composer focus and text', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRuntimeFixture(page);
  await page.goto('/');
  const field = page.getByRole('textbox', { name: 'Message Local familiar' });
  await expect(field).toBeEnabled();
  await field.fill('Keep the current context');
  const shell = page.locator('.coven-chat');
  await field.press('Control+Backslash');
  await expect(shell).toHaveAttribute('data-sidebar', 'closed');
  await field.press('Meta+Backslash');
  await expect(shell).toHaveAttribute('data-sidebar', 'open');
  await field.press('Control+Shift+Backslash');
  await expect(shell).toHaveAttribute('data-inspector', 'closed');
  await expect(
    page.getByRole('button', { name: 'Show inspector', exact: true }).last(),
  ).toHaveAttribute('title', 'Toggle inspector (Cmd/Ctrl+Shift+\\)');
  await field.press('Meta+Shift+Backslash');
  await expect(shell).toHaveAttribute('data-inspector', 'open');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Keep the current context');

  await page.setViewportSize({ width: 480, height: 600 });
  await expect(shell).toHaveAttribute('data-sidebar', 'closed');
  await field.press('Control+Backslash');
  await expect(shell).toHaveAttribute('data-sidebar', 'open');
  await page.keyboard.press('Control+Shift+Backslash');
  await expect(shell).toHaveAttribute('data-sidebar', 'closed');
  await expect(shell).toHaveAttribute('data-inspector', 'open');
  await page.keyboard.press('Escape');
  await expect(shell).toHaveAttribute('data-inspector', 'closed');
  await expect(field).toHaveValue('Keep the current context');
  expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
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

test('keeps reading position, workspace and run controls clear on large and small screens', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installRuntimeFixture(
    page,
    true,
    'A readable paragraph with useful context.\n\n'.repeat(65),
  );
  await page.goto('/');
  const field = page.getByRole('textbox', { name: 'Message Local familiar' });
  await expect(page.getByText('Familiar workspace: /fixture/familiars/0/workspace')).toBeVisible();
  await expect(page.locator('.coven-status')).not.toBeVisible();
  await page.getByText('Connection details', { exact: true }).click();
  await expect(page.locator('.coven-status')).toBeVisible();
  await page.getByText('Connection details', { exact: true }).click();
  await field.fill('Explain this project');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Local familiar is responding…')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeInViewport();
  const transcript = page.locator('.fr-transcript');
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
  expect(await page.locator('.fr-column').evaluate((el) => el.clientWidth)).toBeLessThanOrEqual(
    1200,
  );
  expect(
    await page.locator('.fr-composer-inner').evaluate((el) => el.clientWidth),
  ).toBeLessThanOrEqual(1200);
  await page.screenshot({
    path: testInfo.outputPath('readability-wide.png'),
    animations: 'disabled',
  });
  await page.evaluate(() => window.__covenFixture.finish?.());
  await expect(field).toHaveValue('');
  await expect(page.getByText('Chat project: /fixture/workspace')).toBeVisible();
  await page.setViewportSize({ width: 480, height: 520 });
  await page.getByRole('button', { name: 'Add context', exact: true }).click();
  await expect(page.getByRole('combobox')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Close context picker' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('context-small.png'), animations: 'disabled' });
  await page.getByRole('combobox').press('Escape');
  await expect(field).toBeFocused();
  await page.getByRole('button', { name: 'Add context', exact: true }).click();
  await page.getByRole('button', { name: "Open Local familiar's familiar card" }).click();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page.getByRole('button', { name: 'Add context', exact: true }).click();
  await expect(page.getByRole('combobox')).toBeFocused();
  await page.getByRole('button', { name: 'Close context picker' }).click();
  expect(
    await page.evaluate(() => [
      document.documentElement.scrollWidth <= innerWidth,
      document.documentElement.scrollHeight <= innerHeight,
    ]),
  ).toEqual([true, true]);
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

test('separates CLI tool summaries from prose and reveals their exact arguments', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 600 });
  const args = 'echo "README (local)" && ls -la';
  await installRuntimeFixture(
    page,
    true,
    `Let me inspect the project.⚒ Bash(${args})\n\nThen I can explain.\n\nExample: \`⚒ Read(not executed)\`.`,
  );
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Message Local familiar' }).fill('Inspect the project');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Tool activity' })).toBeVisible();
  await expect(page.locator('.coven-formatted p').first()).toHaveText(
    'Let me inspect the project.',
  );
  await page.locator('.coven-tool summary').click();
  await expect(page.locator('.coven-tool details')).toHaveAttribute('open', '');
  await expect(page.locator('.coven-tool pre')).toContainText(args);
  await expect(page.locator('.coven-tool')).toHaveCount(1);
  await expect(page.locator('.coven-formatted p code')).toHaveText('⚒ Read(not executed)');
  await page.locator('.coven-tool summary').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.coven-tool details')).not.toHaveAttribute('open');
  await page.keyboard.press('Enter');
  await expect(page.locator('.coven-tool details')).toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('tool-details-small.png'),
    animations: 'disabled',
  });
  await page.evaluate(() => window.__covenFixture.finish?.());
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('renders runtime-reported tool calls as rows with input, result and a running status', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const command = 'ls -la /fixture/workspace';
  await installRuntimeFixture(page, true, 'unused', 1, [
    { type: 'text_delta', text: 'Let me look.' },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command, description: 'List' },
          },
        ],
      },
    },
    { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'README.md' }] },
    { type: 'text_delta', text: 'Now the file.' },
    { type: 'tool_start', tool: 'Read' },
  ]);
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Message Local familiar' }).fill('Inspect the project');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Local familiar is running Read…')).toBeVisible();
  const lists = page.getByRole('list', { name: 'Tool activity' });
  await expect(lists).toHaveCount(2);
  await expect(page.locator('.coven-tool')).toHaveCount(2);
  await expect(page.locator('.coven-formatted p').nth(0)).toHaveText('Let me look.');
  await expect(page.locator('.coven-formatted p').nth(1)).toHaveText('Now the file.');
  const bash = page.locator('.coven-tool').first();
  await expect(bash.locator('.coven-tool-args')).toHaveText(command);
  await bash.locator('summary').click();
  // Exact labels: each block also carries a "Copy <name> result" control,
  // and the block's own text starts with its caption.
  await expect(bash.getByLabel('Bash raw arguments', { exact: true })).toContainText(
    '"description": "List"',
  );
  await expect(bash.getByLabel('Bash result', { exact: true }).locator('pre')).toHaveText(
    'README.md',
  );
  await expect(
    page.locator('.coven-tool').nth(1).getByLabel('Read result', { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.__covenFixture.finish?.());
  await expect(page.getByText(/is running Read/)).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Tool activity' })).toHaveCount(2);
  const commands = await page.evaluate(() => window.__covenFixture.calls);
  expect(commands.every((invoked) => invoked.startsWith('coven_runtime_'))).toBe(true);
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
