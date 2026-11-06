// Rendered-screen pass for the design-language audit (#533). Not part of the
// e2e suite: the file name avoids `*.spec.ts`, and it runs only with its own
// config. It drives the built UI in WebKit (the engine of the macOS window)
// through the same kind of Tauri IPC fixture as e2e/app.tauri-mock.spec.ts,
// then writes screenshots and measurements to .artifacts/design-review/out/.
// Record of the first run: docs/design-audits/2026-11-05-rendered-pass.md.
//
//   corepack pnpm exec playwright test --config e2e/design-review/playwright.config.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Page, test } from '@playwright/test';

const OUT = process.env.OUT_DIR ?? resolve('.artifacts/design-review/out');
mkdirSync(OUT, { recursive: true });
const record = (name: string, data: unknown) =>
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, null, 2));
const shot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({ path: join(OUT, `${name}.png`), fullPage });

const PROSE = [
  'Here is the release lane as it stands, in the order the work has to happen. The first thing to understand is that the updater cannot prove itself in a single release: the first build that carries it has to be installed by hand, because nothing already on your machine knows how to fetch it. Only the release after that one can be found, downloaded and installed by the app itself, and only then do we learn whether the signature check, the download and the relaunch all behave on a real install rather than in the pipeline.',
  'That makes the two-release proof a calendar problem as much as an engineering one. If the keypair lands this week, the earliest updater release is the next tag, and the proof needs one more tag after it. Each tag carries the usual work: notes from the merged pull requests, a dry run against the previous tag, the checksum and notarization checks once the release is published, and the packaged acceptance dispatch against the published installers. None of that is new, but every step is a place where a flake can push the schedule back by a day, and two releases means two chances for that to happen.',
  'Windows is the lane I would watch most closely. The installer is unsigned today, and the signing workflow is merged but inert until its secrets exist. When they do, the first thing to run is a dry run from main, because a signing failure there costs twelve minutes, while the same failure during a real release costs a re-tag and a second round of checks. I would also keep the shipped-installer question separate from signing: the test installer still drives every acceptance row, and whether the published one should be driven the same way is a decision, not a bug.',
];

const TABLE = [
  '| Lane | Owner | State | Blocked on | Next action | Evidence | Platforms | Updated |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| Updater code | Val, then agent | Off | Signing keypair in the release environment | Rebase the draft, set the public key, repin, dry run | None yet | macOS, Windows, Linux | 2026-11-04 |',
  '| Two-release proof | agent | Not started | The updater code row | Publish the first updater release with its manifest | None yet | macOS, Linux | 2026-11-04 |',
  '| Windows signing | Val | Unsigned | Four signing secrets and the publisher name | Rehearse with a dry run from main | Workflow merged, inert | Windows | 2026-11-04 |',
].join('\n');

const CODE = [
  '```bash',
  'gh api -X POST repos/OpenCoven/chat/actions/workflows/release.yml/dispatches -f ref=main -f "inputs[tag]=v0.0.8" -f "inputs[dry_run]=true" -f "inputs[allow_unsigned]=false"',
  'gh release edit v0.0.9 --notes-file docs/release-notes/v0.0.9.md',
  '```',
].join('\n');

const FIRST_REPLY = `${PROSE[0]}\n\n${PROSE[1]}\n\n## Where each lane stands\n\n${PROSE[2]}\n\n- The first updater release is installed by hand.\n- The second proves the update on each platform actually exercised.\n- Platforms not exercised are named in the record.`;
const SECOND_REPLY = `The checklist matches, with one gap: it does not say to rehearse with \`dry_run\` before the first signed tag.\n\n${TABLE}\n\nThe two commands that matter most:\n\n${CODE}\n\n${PROSE[1]}`;

function conversation(sessionId: string) {
  const s = sessionId;
  return [
    { type: 'system', subtype: 'init', session_id: s },
    {
      type: 'user',
      session_id: s,
      attachments: [],
      message: { content: [{ type: 'text', text: 'Walk me through the release lane.' }] },
    },
    {
      type: 'assistant',
      session_id: s,
      message: { content: [{ type: 'text', text: FIRST_REPLY }] },
    },
    { type: 'result', session_id: s, is_error: false },
    {
      type: 'user',
      session_id: s,
      attachments: [{ name: 'release-checklist.md', size: 4812 }],
      message: { content: [{ type: 'text', text: 'Check this against the checklist.' }] },
    },
    {
      type: 'assistant',
      session_id: s,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: {
              command: 'grep -n "signing" release-checklist.md',
              description: 'Find signing steps',
            },
          },
        ],
      },
    },
    {
      type: 'tool_result',
      session_id: s,
      tool_use_id: 'toolu_1',
      content: [
        {
          type: 'text',
          text: '12: Sign the tag\n31: Check the signing secrets\n44: Verify signatures',
        },
      ],
    },
    {
      type: 'assistant',
      session_id: s,
      message: { content: [{ type: 'text', text: SECOND_REPLY }] },
    },
    { type: 'result', session_id: s, is_error: false },
  ];
}

type Fixture = {
  available?: boolean;
  setupComplete?: boolean;
  population?: number;
  seeded?: boolean;
  stream?: Record<string, unknown>[];
  failSend?: string;
  textSize?: 'compact' | 'default' | 'large' | 'larger';
};

async function install(page: Page, f: Fixture = {}) {
  const options = {
    ready: f.available ?? true,
    setupComplete: f.setupComplete ?? f.available ?? true,
    population: f.population ?? 1,
    stream: f.stream ?? null,
    failSend: f.failSend ?? null,
    textSize: f.textSize ?? 'default',
    heads: f.seeded
      ? {
          'fixture-familiar': {
            session: {
              id: 'head-fixture-familiar',
              title: 'Release lane',
              harness: 'coven-code',
              status: 'completed',
              familiarId: 'fixture-familiar',
              updatedAt: '2026-11-04T00:00:00Z',
              projectRoot: '/fixture/workspace',
            },
            events: conversation('head-fixture-familiar'),
          },
        }
      : {},
  };
  await page.addInitScript((o) => {
    localStorage.setItem('opencoven.chat.preferences.v1', JSON.stringify({ textSize: o.textSize }));
    const portrait = document.createElement('canvas');
    portrait.width = 2;
    portrait.height = 2;
    const paint = portrait.getContext('2d');
    if (paint) {
      paint.fillStyle = '#9386d0';
      paint.fillRect(0, 0, 2, 2);
    }
    const avatarUrl = portrait.toDataURL('image/png');
    const callbacks = new Map<number, (data: unknown) => void>();
    let callbackId = 0;
    const heads: Record<string, { session: Record<string, unknown>; events: unknown[] }> = o.heads;
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      value: { unregisterListener() {} },
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback(callback: (data: unknown) => void) {
          callbacks.set(++callbackId, callback);
          return callbackId;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        async invoke(command: string, args: Record<string, unknown> = {}) {
          switch (command) {
            case 'plugin:event|listen':
              return 1;
            case 'plugin:event|unlisten':
            case 'companion_active_run':
            case 'coven_runtime_cancel':
              return null;
            case 'plugin:window|set_title':
              return null;
            case 'setup_check':
              return {
                platform: { ok: true, os: 'macos' },
                coven: o.setupComplete ? { ok: true, version: 'fixture' } : { ok: false },
                engine: { ok: o.setupComplete },
                signIn: {
                  ok: o.setupComplete,
                  engine: o.setupComplete ? 'signed-in' : 'missing',
                  claude: 'missing',
                  chatgpt: 'missing',
                  claudeInstaller: 'curl -fsSL https://claude.ai/install.sh | bash',
                },
                familiar: { ok: o.setupComplete, count: o.setupComplete ? 1 : 0 },
              };
            case 'coven_runtime_status':
              return o.ready
                ? {
                    available: true,
                    version: 'fixture',
                    transport: 'cli',
                    sdkHealth: 'unavailable',
                  }
                : {
                    available: false,
                    error: 'Coven CLI is not installed. Install Coven CLI, then retry.',
                    setup: 'install-cli',
                  };
            case 'coven_runtime_familiars':
              return Array.from({ length: o.population }, (_, index) => ({
                id: index ? `fixture-familiar-${index}` : 'fixture-familiar',
                name: index ? `Familiar ${index}` : 'Astra',
                displayName: index ? `Familiar ${index}` : 'Astra',
                workspace: `/fixture/familiars/${index}/workspace`,
                projectAccess: [
                  {
                    name: 'workspace',
                    path: `/fixture/familiars/${index}/workspace`,
                    access: 'write',
                  },
                ],
                description: 'Release and verification familiar',
                avatarUrl,
              }));
            case 'coven_runtime_sessions':
              return Object.values(heads).map((head) => head.session);
            case 'coven_runtime_read': {
              const selected = Object.values(heads).find((head) => head.session.id === args.id);
              if (!selected) throw new Error('Unexpected session read.');
              return selected;
            }
            case 'coven_runtime_send': {
              const input = args.input as { prompt: string; familiarId: string; runId: string };
              const channel = args.onEvent as { id: number };
              const callback = callbacks.get(channel.id);
              if (!callback) throw new Error('Stream callback not registered.');
              const current = heads[input.familiarId];
              const id = (current?.session.id as string) ?? `head-${input.familiarId}`;
              const events: Record<string, unknown>[] = [
                { type: 'system', subtype: 'init', session_id: id },
                {
                  type: 'user',
                  session_id: id,
                  attachments: [],
                  message: { content: [{ type: 'text', text: input.prompt }] },
                },
                ...(o.stream ?? []).map((frame) => ({ ...frame, session_id: id })),
              ];
              for (const [index, message] of events.entries()) callback({ index, message });
              if (o.failSend) throw new Error(o.failSend);
              // The run stays open: the capture needs its running state.
              return new Promise(() => undefined);
            }
            default:
              throw new Error(`Unexpected native command: ${command}`);
          }
        },
      },
    });
  }, options);
}

const VIEWPORTS = {
  narrow: { width: 480, height: 520 },
  compact: { width: 960, height: 700 },
  wide: { width: 1680, height: 1000 },
} as const;
const SCHEMES = ['dark', 'light'] as const;

async function setRails(page: Page, open: boolean) {
  const hide = page.getByRole('button', { name: 'Hide familiars' });
  const show = page.getByRole('button', { name: /^Show familiars/ });
  if (open) {
    if (await show.isVisible().catch(() => false)) await show.click();
    const inspector = page.getByRole('button', { name: 'Show inspector' });
    if (await inspector.isVisible().catch(() => false)) await inspector.click();
  } else {
    const close = page.getByRole('button', { name: 'Close inspector' });
    if (await close.isVisible().catch(() => false)) await close.click();
    if (await hide.isVisible().catch(() => false)) await hide.click();
  }
  await page.mouse.move(1, 1);
  await page.waitForTimeout(250);
}

/** Characters per line and width in ch for each long prose paragraph. */
async function measureProse(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas').getContext('2d');
    return [...document.querySelectorAll<HTMLElement>('.coven-formatted p')]
      .filter((p) => (p.textContent ?? '').length > 300)
      .map((p) => {
        const style = getComputedStyle(p);
        if (!canvas) return null;
        canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const text = p.textContent ?? '';
        const avg = canvas.measureText(text).width / text.length;
        const zero = canvas.measureText('0').width;
        const range = document.createRange();
        range.selectNodeContents(p);
        const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
        return {
          widthPx: Math.round(p.clientWidth),
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          widthCh: Math.round(p.clientWidth / zero),
          charsPerLine: Math.round(p.clientWidth / avg),
          lines: tops.size,
        };
      })
      .filter(Boolean);
  });
}

/** Every visible text run outside the transcript prose: size, weight and where it is. */
async function inventoryText(page: Page, scope: string) {
  return page.evaluate((scopeSelector) => {
    const root = document.querySelector(scopeSelector) ?? document.body;
    const runs: Record<string, { count: number; samples: string[] }> = {};
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? '').trim();
      const el = node.parentElement;
      if (!text || !el || el.closest('.coven-formatted')) continue;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none')
        continue;
      const key = `${style.fontSize} / ${style.fontWeight}`;
      runs[key] ??= { count: 0, samples: [] };
      runs[key].count++;
      const cls = (el.className && typeof el.className === 'string' ? el.className : el.tagName)
        .split(' ')
        .slice(0, 2)
        .join('.');
      if (runs[key].samples.length < 6) runs[key].samples.push(`${cls}: ${text.slice(0, 48)}`);
    }
    return runs;
  }, scope);
}

/** Elements whose text is cut off or overflows its box. */
async function clipped(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || !el.textContent?.trim() || el.children.length > 3)
          return false;
        const box = el.getBoundingClientRect();
        if (!box.width) return false;
        const horizontal = el.scrollWidth > el.clientWidth + 1 && style.overflowX !== 'visible';
        return horizontal && style.overflowX !== 'auto' && style.overflowX !== 'scroll';
      })
      .slice(0, 20)
      .map((el) => `${el.className || el.tagName}: ${el.textContent?.trim().slice(0, 60)}`),
  );
}

const textSizes = ['default', 'larger'] as const;

for (const scheme of SCHEMES) {
  test(`onboarding and empty states (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(size);
      await install(page, { available: false, setupComplete: false });
      await page.goto('/');
      await page.waitForTimeout(800);
      await shot(page, `onboarding-${scheme}-${vp}`);
      record(`onboarding-${scheme}-${vp}-text`, await inventoryText(page, 'body'));
      record(`onboarding-${scheme}-${vp}-clipped`, await clipped(page));
    }
  });

  test(`empty chat and disconnected (${scheme})`, async ({ browser }) => {
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      for (const textSize of textSizes) {
        const context = await browser.newContext({ viewport: size, colorScheme: scheme });
        const page = await context.newPage();
        await install(page, { textSize });
        await page.goto('/');
        await page.getByRole('textbox', { name: 'Message Astra' }).waitFor();
        await page.mouse.move(1, 1);
        await shot(page, `empty-${scheme}-${vp}-${textSize}`);
        record(`empty-${scheme}-${vp}-${textSize}-text`, await inventoryText(page, 'body'));
        await context.close();
      }
      const context = await browser.newContext({ viewport: size, colorScheme: scheme });
      const page = await context.newPage();
      await install(page, { available: false, setupComplete: true });
      await page.goto('/');
      await page.waitForTimeout(1200);
      await shot(page, `disconnected-${scheme}-${vp}`);
      await context.close();
    }
  });

  test(`conversation matrix (${scheme})`, async ({ browser }) => {
    test.setTimeout(240_000);
    const results: Record<string, unknown> = {};
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      for (const textSize of textSizes) {
        for (const rails of [true, false]) {
          const context = await browser.newContext({ viewport: size, colorScheme: scheme });
          const page = await context.newPage();
          await install(page, { seeded: true, textSize });
          await page.goto('/');
          await page.getByText('Walk me through the release lane.').waitFor();
          await setRails(page, rails);
          const name = `conv-${scheme}-${vp}-${textSize}-${rails ? 'rails' : 'norails'}`;
          const scroller = page.getByRole('log', { name: 'Messages' });
          await scroller.evaluate((el) => {
            for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement)
              if (
                n.scrollHeight > n.clientHeight + 4 &&
                /auto|scroll/.test(getComputedStyle(n).overflowY)
              ) {
                n.scrollTop = 0;
                break;
              }
          });
          await page.waitForTimeout(150);
          await shot(page, `${name}-top`);
          await scroller.evaluate((el) => {
            for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement)
              if (
                n.scrollHeight > n.clientHeight + 4 &&
                /auto|scroll/.test(getComputedStyle(n).overflowY)
              ) {
                n.scrollTop = n.scrollHeight;
                break;
              }
          });
          await page.waitForTimeout(150);
          await shot(page, `${name}-bottom`);
          results[name] = {
            prose: await measureProse(page),
            column: await page
              .locator('.fr-column')
              .first()
              .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
            pageOverflow: await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            clipped: await clipped(page),
          };
          if (vp === 'wide' && rails && textSize === 'default')
            record(`conv-${scheme}-wide-text`, await inventoryText(page, 'body'));
          await context.close();
        }
      }
    }
    record(`conv-${scheme}-measure`, results);
  });

  test(`running tools, failure and reduced motion (${scheme})`, async ({ browser }) => {
    const stream = [
      { type: 'text_delta', text: 'Checking the release workflow first.' },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_9',
              name: 'Bash',
              input: {
                command: 'gh run list --workflow release.yml --limit 3',
                description: 'Recent runs',
              },
            },
          ],
        },
      },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_9',
        content: [{ type: 'text', text: 'completed success v0.0.8\ncompleted success v0.0.7' }],
      },
      { type: 'tool_start', tool: 'Read' },
    ];
    const motion: Record<string, unknown> = {};
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        const context = await browser.newContext({
          viewport: size,
          colorScheme: scheme,
          reducedMotion,
        });
        const page = await context.newPage();
        await install(page, { stream });
        await page.goto('/');
        const composer = page.getByRole('textbox', { name: 'Message Astra' });
        await composer.fill('Is v0.0.8 fully published?');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await page.getByText(/is running Read/).waitFor();
        await page.mouse.move(1, 1);
        await page.waitForTimeout(300);
        motion[`${vp}-${reducedMotion}`] = await page.evaluate(() =>
          document
            .getAnimations()
            .filter((a) => a.playState === 'running')
            .map((a) => {
              const target = (a.effect as KeyframeEffect | null)?.target as HTMLElement | null;
              return `${(a as CSSAnimation).animationName ?? a.constructor.name} on ${target?.className ?? '?'}`;
            }),
        );
        if (reducedMotion === 'no-preference') await shot(page, `running-${scheme}-${vp}`);
        await context.close();
      }
      const context = await browser.newContext({ viewport: size, colorScheme: scheme });
      const page = await context.newPage();
      await install(page, {
        stream: [
          {
            type: 'result',
            is_error: true,
            result: 'Engine exited with status 1: model quota reached.',
          },
          // What record_run_failure appends on the host (coven_runtime.rs).
          {
            type: 'system',
            subtype: 'notice',
            source: 'chat-diagnostic',
            message: {
              role: 'system',
              content: [
                {
                  type: 'text',
                  text: 'This run failed. Engine exited with status 1: model quota reached.',
                },
              ],
            },
          },
        ],
        failSend:
          "The run failed. Coven's report is the last line of the chat, and Try again resends your message.",
      });
      await page.goto('/');
      await page.getByRole('textbox', { name: 'Message Astra' }).fill('Is v0.0.8 fully published?');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.waitForTimeout(800);
      await page.mouse.move(1, 1);
      await shot(page, `failed-${scheme}-${vp}`);
      await context.close();
    }
    record(`motion-${scheme}`, motion);
  });

  test(`settings (${scheme})`, async ({ browser }) => {
    const out: Record<string, unknown> = {};
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      for (const textSize of textSizes) {
        const context = await browser.newContext({ viewport: size, colorScheme: scheme });
        const page = await context.newPage();
        await install(page, { textSize });
        await page.goto('/');
        await page.getByRole('textbox', { name: 'Message Astra' }).waitFor();
        await page.getByRole('textbox', { name: 'Message Astra' }).click();
        await page.keyboard.press('Meta+Comma');
        const dialog = page.getByRole('dialog', { name: 'Settings' });
        await dialog.waitFor();
        const sections = await page
          .getByRole('navigation', { name: 'Settings sections' })
          .getByRole('button')
          .allTextContents()
          .catch(() => [] as string[]);
        const tabs = page
          .getByRole('navigation', { name: 'Settings sections' })
          .locator('button, a');
        const count = await tabs.count();
        for (let i = 0; i < count; i++) {
          await tabs.nth(i).click();
          await page.waitForTimeout(150);
          const label = ((await tabs.nth(i).textContent()) ?? `s${i}`)
            .trim()
            .toLowerCase()
            .replace(/\W+/g, '-');
          await shot(page, `settings-${scheme}-${vp}-${textSize}-${label}`);
          out[`${vp}-${textSize}-${label}`] = {
            text: await inventoryText(page, 'dialog[aria-label="Settings"]'),
            clipped: await clipped(page),
          };
        }
        out[`${vp}-${textSize}-sections`] = sections;
        await context.close();
      }
    }
    record(`settings-${scheme}`, out);
  });

  test(`mention portal and focus (${scheme})`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: VIEWPORTS.compact, colorScheme: scheme });
    const page = await context.newPage();
    await install(page, { population: 3 });
    await page.goto('/');
    const composer = page.getByRole('textbox', { name: 'Message Astra' });
    await composer.click();
    await composer.pressSequentially('Ask @Fam');
    const panel = page.locator('.chat-mention-panel');
    await panel.waitFor();
    await shot(page, `mention-${scheme}`);
    const portal = await page.evaluate(() => {
      const panelEl = document.querySelector<HTMLElement>('.chat-mention-panel');
      const shell = document.querySelector<HTMLElement>('.fr-shell');
      if (!panelEl || !shell) return null;
      const p = getComputedStyle(panelEl);
      const s = getComputedStyle(shell);
      const vars = ['--bg-raised', '--border-strong', '--text-primary', '--text-secondary'];
      return {
        insideShell: shell.contains(panelEl),
        panel: { background: p.backgroundColor, border: p.borderTopColor, color: p.color },
        panelVars: Object.fromEntries(
          vars.map((v) => [v, p.getPropertyValue(v).trim() || '(unset)']),
        ),
        shellVars: Object.fromEntries(
          vars.map((v) => [v, s.getPropertyValue(v).trim() || '(unset)']),
        ),
        // What the panel would inherit without the copy in mention-completion.tsx.
        bodyVars: Object.fromEntries(
          vars.map((v) => [
            v,
            getComputedStyle(document.body).getPropertyValue(v).trim() || '(unset)',
          ]),
        ),
        shellBackground: s.backgroundColor,
        note: getComputedStyle(panelEl.querySelector('.chat-mention-note') as HTMLElement).color,
      };
    });
    record(`mention-${scheme}`, portal);
    await page.keyboard.press('Escape');

    // Keyboard focus: tab through the window and record whether each stop shows a ring.
    await page.mouse.click(2, 300);
    const stops: string[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        const ring =
          (s.outlineStyle !== 'none' && Number.parseFloat(s.outlineWidth) > 0) ||
          s.boxShadow !== 'none';
        const name =
          el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName;
        return `${ring ? 'ring' : 'NO RING'} | ${el.tagName.toLowerCase()} | ${name} | outline ${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`;
      });
      if (stop) stops.push(stop);
      if (stop?.startsWith('NO RING') && !stops.slice(0, -1).includes(stop))
        await shot(page, `focus-${test.info().project.name}-${scheme}-${i}`);
    }
    record(`focus-${test.info().project.name}-${scheme}`, stops);
    await context.close();
  });
}

// Finding 2 candidates: cap ordinary prose blocks while tables, code, tool rows,
// attachments and the composer keep the documented 1200px column.
const CANDIDATES = {
  current: '',
  cap72ch:
    '.coven-chat .coven-formatted > :is(p, ul:not(.coven-tools), ol, blockquote, h1, h2, h3, h4, h5, h6) { max-width: 72ch; }',
  cap60ch:
    '.coven-chat .coven-formatted > :is(p, ul:not(.coven-tools), ol, blockquote, h1, h2, h3, h4, h5, h6) { max-width: 60ch; }',
} as const;

for (const scheme of SCHEMES) {
  test(`prose measure candidates (${scheme})`, async ({ browser }) => {
    test.setTimeout(240_000);
    const results: Record<string, unknown> = {};
    const views = scheme === 'dark' ? (['compact', 'wide'] as const) : (['wide'] as const);
    for (const vp of views) {
      for (const textSize of textSizes) {
        for (const rails of [true, false]) {
          for (const [candidate, css] of Object.entries(CANDIDATES)) {
            const context = await browser.newContext({
              viewport: VIEWPORTS[vp],
              colorScheme: scheme,
            });
            const page = await context.newPage();
            await install(page, { seeded: true, textSize });
            await page.goto('/');
            await page.getByText('Walk me through the release lane.').waitFor();
            if (css) await page.addStyleTag({ content: css });
            await setRails(page, rails);
            const name = `cand-${scheme}-${vp}-${textSize}-${rails ? 'rails' : 'norails'}-${candidate}`;
            const log = page.getByRole('log', { name: 'Messages' });
            for (const [label, to] of [
              ['top', 0],
              ['bottom', 1],
            ] as const) {
              await log.evaluate((el, end) => {
                for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement)
                  if (
                    n.scrollHeight > n.clientHeight + 4 &&
                    /auto|scroll/.test(getComputedStyle(n).overflowY)
                  ) {
                    n.scrollTop = end ? n.scrollHeight : 0;
                    break;
                  }
              }, to);
              await page.waitForTimeout(150);
              await shot(page, `${name}-${label}`);
            }
            results[name] = {
              prose: await measureProse(page),
              tableWidth: await page.evaluate(() =>
                Math.round(
                  document.querySelector('.coven-formatted table')?.getBoundingClientRect().width ??
                    0,
                ),
              ),
              codeWidth: await page.evaluate(() =>
                Math.round(
                  document.querySelector('.coven-code')?.getBoundingClientRect().width ?? 0,
                ),
              ),
            };
            await context.close();
          }
        }
      }
    }
    record(`cand-${scheme}-measure`, results);
  });

  test(`failure text and narrow larger (${scheme})`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: VIEWPORTS.narrow, colorScheme: scheme });
    const page = await context.newPage();
    await install(page, {
      textSize: 'larger',
      stream: [
        {
          type: 'result',
          is_error: true,
          result: 'Engine exited with status 1: model quota reached.',
        },
        // What record_run_failure appends on the host (coven_runtime.rs).
        {
          type: 'system',
          subtype: 'notice',
          source: 'chat-diagnostic',
          message: {
            role: 'system',
            content: [
              {
                type: 'text',
                text: 'This run failed. Engine exited with status 1: model quota reached.',
              },
            ],
          },
        },
      ],
      failSend:
        "The run failed. Coven's report is the last line of the chat, and Try again resends your message.",
    });
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Message Astra' }).fill('Is v0.0.8 fully published?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForTimeout(800);
    await page.mouse.move(1, 1);
    await shot(page, `failed-${scheme}-narrow-larger`);
    record(`failed-${scheme}-narrow-larger-text`, await inventoryText(page, 'body'));
    await context.close();
  });
}

/** Distinct radii, shadows, blurs and gaps on what is visible now. */
async function depthInventory(page: Page) {
  return page.evaluate(() => {
    const tally: Record<string, Record<string, { n: number; s: string[] }>> = {
      radius: {},
      shadow: {},
      blur: {},
      gap: {},
      background: {},
    };
    const add = (kind: string, value: string, el: Element) => {
      const bucket = tally[kind] ?? {};
      tally[kind] = bucket;
      const t = bucket[value] ?? { n: 0, s: [] };
      bucket[value] = t;
      t.n++;
      const cls = String((el as HTMLElement).className || el.tagName).split(' ')[0] ?? '';
      if (t.s.length < 5 && !t.s.includes(cls)) t.s.push(cls);
    };
    for (const el of document.querySelectorAll('body *')) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden') continue;
      if (s.borderTopLeftRadius !== '0px') add('radius', s.borderTopLeftRadius, el);
      if (s.boxShadow !== 'none') add('shadow', s.boxShadow, el);
      const blur =
        s.backdropFilter || (s as unknown as Record<string, string>).webkitBackdropFilter;
      if (blur && blur !== 'none') add('blur', blur, el);
      if (
        (s.display.includes('flex') || s.display.includes('grid')) &&
        s.rowGap !== 'normal' &&
        s.rowGap !== '0px'
      )
        add('gap', s.rowGap, el);
      if (s.backgroundImage.includes('gradient'))
        add('background', s.backgroundImage.slice(0, 80), el);
    }
    return tally;
  });
}

for (const scheme of SCHEMES) {
  test(`depth and spacing inventory (${scheme})`, async ({ browser }) => {
    const out: Record<string, unknown> = {};
    const context = await browser.newContext({ viewport: VIEWPORTS.wide, colorScheme: scheme });
    const page = await context.newPage();
    await install(page, { seeded: true, population: 3 });
    await page.goto('/');
    await page.getByText('Walk me through the release lane.').waitFor();
    await setRails(page, true);
    out.conversation = await depthInventory(page);
    await shot(page, `depth-${scheme}-conversation`);
    const composer = page.getByRole('textbox', { name: 'Message Astra' });
    await composer.click();
    await composer.pressSequentially('Ask @Fam');
    await page.locator('.chat-mention-panel').waitFor();
    out.mention = await depthInventory(page);
    await page.keyboard.press('Escape');
    await composer.fill('');
    await page.keyboard.press('Meta+Comma');
    await page.locator('dialog[aria-label="Settings"]').waitFor();
    out.settings = await depthInventory(page);
    await context.close();
    const onboarding = await browser.newContext({ viewport: VIEWPORTS.wide, colorScheme: scheme });
    const op = await onboarding.newPage();
    await install(op, { available: false, setupComplete: false });
    await op.goto('/');
    await op.waitForTimeout(800);
    out.onboarding = await depthInventory(op);
    await onboarding.close();
    record(`depth-${scheme}`, out);
  });
}
