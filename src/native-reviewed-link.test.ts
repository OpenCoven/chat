import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../scripts/native-acceptance/driver.mjs', async (original) => ({
  ...(await original<object>()),
  PLATFORM: 'windows',
}));
const driverPath = '../scripts/native-acceptance/driver.mjs';
const rowsPath = '../scripts/native-acceptance/rows.mjs';
const { App } = await import(driverPath);
const { clickReviewedLink, Row, REVIEW } = await import(rowsPath);
afterEach(() => vi.useRealTimers());

test.each(['open', 'refused', 'absent'])(
  'review click %s keeps raw native receipts and never sends a second click',
  async (outcome) => {
    vi.useFakeTimers();
    let inputs = 0;
    const target = {
      role: 'link',
      name: 'Named login',
      children: [],
      frame: { x: 400, y: 400, w: 100, h: 20 },
    };
    const native = {
      async call(command: { cmd: string }) {
        if (command.cmd !== 'clickLink') throw new Error(`Unexpected command ${command.cmd}`);
        inputs++;
        return {
          ok: outcome !== 'refused',
          error: 'Point covered; no click sent',
          receipt: {
            clicked: outcome !== 'refused',
            foregroundPid: 123,
            hit: { name: 'Named login' },
          },
          before: { name: 'native before', frame: { x: 1, y: 2, w: 3, h: 4 } },
          after: { name: 'native after' },
        };
      },
      async must() {
        throw new Error('Unverified click is forbidden');
      },
    };
    const app = new App(native, 123);
    app.viewport = async () => ({ top: 100, bottom: 900, left: 0, right: 1200 });
    app.all = async (role: string) => (role === 'link' ? [target] : []);
    app.snapshot = async () => ({
      raw: { name: 'raw snapshot' },
      children:
        inputs && outcome === 'open'
          ? [{ role: 'dialog', name: REVIEW, children: [] }]
          : [
              {
                role: 'log',
                name: 'Messages',
                frame: { x: 0, y: 150, w: 1200, h: 600 },
                children: [target],
              },
              {
                role: 'textbox',
                name: 'Message Astra',
                frame: { x: 0, y: 780, w: 1200, h: 100 },
                children: [],
              },
            ],
    });
    const row = new Row('515', 'Handoff');
    const files = new Map<string, string>();
    const pending = clickReviewedLink(app, 'Named login', row, (name: string, value: string) =>
      files.set(name, value),
    ).then(
      () => null,
      (error: Error) => error,
    );
    await vi.runAllTimersAsync();
    const error = await pending;
    if (outcome === 'open') expect(error).toBeNull();
    else expect(error?.message).toMatch(outcome === 'refused' ? /covered/ : /Timed out/);
    expect(inputs).toBe(1);
    const action = row.observations.find(
      (observation: { label: string }) => observation.label === 'review click action',
    );
    expect(action.value).toMatchObject({
      at: [450, 410],
      target: { role: 'link', name: 'Named login', frame: target.frame },
      native: { clicked: outcome !== 'refused', foregroundPid: 123 },
    });
    expect(
      JSON.parse(files.get('515-review-click-named-login-native-before.json') ?? 'null'),
    ).toEqual({ name: 'native before', frame: { x: 1, y: 2, w: 3, h: 4 } });
    expect(
      JSON.parse(files.get('515-review-click-named-login-native-after.json') ?? 'null'),
    ).toEqual({ name: 'native after' });
    expect(files.has('515-review-click-named-login-after-click.json')).toBe(true);
  },
);
