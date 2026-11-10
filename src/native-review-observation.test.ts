import { expect, test } from 'vitest';

const path = '../scripts/native-acceptance/rows.mjs';
const rows = await import(path);

test('review diagnostics distinguish observed dismissal from absence without guessing missed clicks', async () => {
  expect(typeof rows.ReviewTrace).toBe('function');
  let visible = false;
  const app = {
    snapshot: async () => ({
      role: 'document',
      children: visible
        ? [{ role: 'dialog', name: rows.REVIEW, children: [] }]
        : [{ role: 'textbox', name: 'Message Astra', children: [] }],
    }),
  };
  const observations: { label: string; value: unknown }[] = [];
  const row = { note: (label: string, value: unknown) => observations.push({ label, value }) };
  const trace = new rows.ReviewTrace(app, row);
  await trace.sample('before-click');
  expect(trace.outcome).toBe('not-observed');
  visible = true;
  await trace.sample('after-click');
  expect(trace.outcome).toBe('open');
  visible = false;
  await trace.sample('after-completion');
  expect(trace.outcome).toBe('opened-then-dismissed');
  for (let i = 0; i < 100; i++) {
    visible = !visible;
    await trace.sample('poll');
  }
  expect(observations.length).toBeLessThanOrEqual(16);
  expect(JSON.stringify(observations)).not.toContain('http');
});

test.each([null, { role: 'document', children: [] }])(
  'an unavailable accessibility tree %j cannot count as a dismissed review',
  async (unavailable) => {
    expect(typeof rows.ReviewTrace).toBe('function');
    let available = true;
    const app = {
      snapshot: async () =>
        available
          ? { role: 'document', children: [{ role: 'dialog', name: rows.REVIEW, children: [] }] }
          : unavailable,
    };
    const trace = new rows.ReviewTrace(app, { note() {} });
    await trace.sample('held-open');
    available = false;
    await expect(trace.sample('after-completion')).rejects.toThrow(/accessible tree/);
    expect(trace.outcome).toBe('open');
  },
);

test('native completion focus requires Messages rather than recording arbitrary focus', async () => {
  expect(typeof rows.verifyCompletionFocus).toBe('function');
  const good = new rows.Row('focus', 'focus');
  await rows.verifyCompletionFocus(
    { focused: async () => ({ role: 'log', name: 'Messages' }) },
    good,
    'mac',
  );
  expect(good.status).toBe('observed');
  const bad = new rows.Row('focus', 'focus');
  await rows.verifyCompletionFocus(
    { focused: async () => ({ role: 'button', name: 'Open settings' }) },
    bad,
    'mac',
  );
  expect(bad.status).toBe('failed');
});

test.each([true, false])(
  'Windows document focus must resume at the first transcript control: %s',
  async (correct) => {
    expect(typeof rows.verifyCompletionFocus).toBe('function');
    let backward = true;
    const keys: unknown[] = [];
    const app = {
      focused: async () =>
        backward
          ? { role: 'document', name: '' }
          : { role: 'button', name: correct ? 'Connection details' : 'Copy message' },
      focusedName: async () => (correct ? 'Connection details' : 'Copy message'),
      one: async () => ({ role: 'button', name: 'Connection details' }),
      key: async (key: string, modifiers: string[] = []) => {
        keys.push([key, modifiers]);
        backward = modifiers.includes('shift');
      },
    };
    const row = new rows.Row('focus', 'focus');
    await rows.verifyCompletionFocus(app, row, 'windows');
    expect(row.status).toBe(correct ? 'observed' : 'failed');
    expect(keys).toEqual([
      ['tab', []],
      ['tab', ['shift']],
      ['tab', []],
    ]);
  },
);
