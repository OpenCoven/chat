import { afterEach, expect, test, vi } from 'vitest';

const driverPath = '../scripts/native-acceptance/driver.mjs';
const { App } = await import(driverPath);

afterEach(() => vi.useRealTimers());

function harness(y = 400, scrollY = 400) {
  let position = { x: 400, y, w: 100, h: 20 };
  const clicks: unknown[] = [];
  const commands: { cmd: string; at?: number[] }[] = [];
  const target = () => ({ role: 'link', name: 'Named login', frame: { ...position } });
  const native = {
    async must(command: { cmd: string; at?: number[] }) {
      commands.push(command);
      if (command.cmd === 'scroll') position = { ...position, y: scrollY };
      if (command.cmd === 'click') clicks.push(command.at);
      return { ok: true };
    },
    async call(command: { cmd: string; at?: number[] }) {
      commands.push(command);
      return {
        ok: false,
        error: 'Point is covered by Message Astra',
        receipt: { clicked: false },
        before: { name: 'before' },
        after: { name: 'after' },
      };
    },
  };
  const app = new App(native, 123);
  app.viewport = async () => ({ top: 100, bottom: 900, left: 0, right: 1200 });
  app.snapshot = async () => ({
    children: [
      { name: 'Messages', role: 'log', frame: { x: 0, y: 150, w: 1200, h: 600 }, children: [] },
      {
        name: 'Message Astra',
        role: 'textbox',
        frame: { x: 0, y: 780, w: 1200, h: 100 },
        children: [],
      },
    ],
  });
  return {
    app,
    clicks,
    commands,
    target,
    move: (x: number) => {
      position = { ...position, x };
    },
  };
}

async function run(pending: Promise<unknown>) {
  const settled = pending.then(
    () => null,
    (error: Error) => error,
  );
  await vi.runAllTimersAsync();
  return settled;
}

test('link preparation scrolls a composer-covered point into the safe transcript band before one click', async () => {
  vi.useFakeTimers();
  const h = harness(800);
  const error = await run(h.app.click(h.target(), { find: async () => h.target() }));
  expect(error).toBeNull();
  expect(h.clicks).toEqual([[450, 410]]);
  expect(h.commands.some((command) => command.cmd === 'scroll')).toBe(true);
});

test('link preparation reacquires coordinates changed during the window read', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.app.viewport = async () => {
    h.move(600);
    return { top: 100, bottom: 900, left: 0, right: 1200 };
  };
  const error = await run(h.app.click(h.target(), { find: async () => h.target() }));
  expect(error).toBeNull();
  expect(h.clicks).toEqual([[650, 410]]);
});

test('an unstable target fails within a bound without sending a click', async () => {
  vi.useFakeTimers();
  const h = harness();
  let reads = 0;
  const find = async () => {
    h.move(++reads % 2 ? 400 : 600);
    return h.target();
  };
  const error = await run(h.app.click(h.target(), { find }));
  expect(error?.message).toMatch(/stable/);
  expect(h.clicks).toEqual([]);
  expect(reads).toBeLessThan(30);
});

test('a stable target gets exactly one native click', async () => {
  vi.useFakeTimers();
  const h = harness();
  expect(await run(h.app.click(h.target(), { find: async () => h.target() }))).toBeNull();
  expect(h.clicks).toEqual([[450, 410]]);
});

test('a failed native hit test preserves the receipt and cannot fall back to an unverified click', async () => {
  vi.useFakeTimers();
  const h = harness();
  const receipts: unknown[] = [];
  const error = await run(
    h.app.click(h.target(), {
      find: async () => h.target(),
      verifyLink: 'Named login',
      receipt: (value: unknown) => receipts.push(value),
    }),
  );
  expect(error?.message).toContain('covered');
  expect(h.clicks).toEqual([]);
  expect(h.commands.filter((command) => command.cmd === 'clickLink')).toHaveLength(1);
  expect(receipts).toEqual([
    expect.objectContaining({
      at: [450, 410],
      answer: expect.objectContaining({
        receipt: { clicked: false },
        before: { name: 'before' },
        after: { name: 'after' },
      }),
    }),
  ]);
});

test('a tall composer cannot cover a target accepted by the outer window middle band', async () => {
  vi.useFakeTimers();
  const h = harness(500, 250);
  h.app.snapshot = async () => ({
    children: [
      { name: 'Messages', role: 'log', frame: { x: 0, y: 150, w: 1200, h: 250 }, children: [] },
      {
        name: 'Message Astra',
        role: 'textbox',
        frame: { x: 0, y: 400, w: 1200, h: 480 },
        children: [],
      },
    ],
  });
  expect(await run(h.app.click(h.target(), { find: async () => h.target() }))).toBeNull();
  expect(h.clicks).toEqual([[450, 260]]);
});

test('a stable link may straddle the middle band edge while remaining fully inside Messages', async () => {
  vi.useFakeTimers();
  const h = harness(495);
  expect(await run(h.app.click(h.target(), { find: async () => h.target() }))).toBeNull();
  expect(h.clicks).toEqual([[450, 505]]);
});
