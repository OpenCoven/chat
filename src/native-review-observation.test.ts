import { expect, test } from 'vitest';

const path = '../scripts/native-acceptance/rows.mjs';
const rows = await import(path);

test('review diagnostics distinguish observed dismissal from absence without guessing missed clicks', async () => {
  expect(typeof rows.ReviewTrace).toBe('function');
  let visible = false;
  const app = {
    snapshot: async () => ({
      role: 'document',
      children: visible ? [{ role: 'dialog', name: rows.REVIEW, children: [] }] : [],
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

test('an unavailable accessibility tree cannot count as a dismissed review', async () => {
  expect(typeof rows.ReviewTrace).toBe('function');
  let available = true;
  const app = {
    snapshot: async () => (available ? { role: 'dialog', name: rows.REVIEW, children: [] } : null),
  };
  const trace = new rows.ReviewTrace(app, { note() {} });
  await trace.sample('held-open');
  available = false;
  await expect(trace.sample('after-completion')).rejects.toThrow(/accessible tree/);
  expect(trace.outcome).toBe('open');
});
