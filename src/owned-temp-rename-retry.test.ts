// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { renameWithTransientRetry } from '../scripts/owned-temp-directory.mjs';

const fault = vi.hoisted(() => ({ failures: [] as unknown[], calls: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: () => {
      fault.calls += 1;
      const failure = fault.failures.shift();
      if (failure !== undefined) throw failure;
    },
  };
});

afterEach(() => {
  fault.failures = [];
  fault.calls = 0;
});

function coded(code: string) {
  return Object.assign(new Error(`${code}: rename`), { code });
}

test('retries a transient Windows denial until the rename succeeds', () => {
  fault.failures = [coded('EPERM'), coded('EACCES'), coded('EBUSY')];
  const sleeps: number[] = [];
  renameWithTransientRetry('from', 'to', { platform: 'win32', sleep: (ms) => sleeps.push(ms) });
  expect(fault.calls).toBe(4);
  expect(sleeps).toEqual([100, 200, 400]);
});

test('caps each wait and gives up once the budget is spent', () => {
  const denial = coded('EPERM');
  fault.failures = Array.from({ length: 50 }, () => denial);
  const sleeps: number[] = [];
  expect(() =>
    renameWithTransientRetry('from', 'to', {
      platform: 'win32',
      sleep: (ms) => sleeps.push(ms),
      budgetMs: 10_000,
    }),
  ).toThrow(denial);
  expect(Math.max(...sleeps)).toBe(2_000);
  expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(10_000);
});

test.each(['linux', 'darwin'])('does not retry on %s', (platform) => {
  const denial = coded('EPERM');
  fault.failures = [denial];
  const sleep = vi.fn();
  expect(() => renameWithTransientRetry('from', 'to', { platform, sleep })).toThrow(denial);
  expect(fault.calls).toBe(1);
  expect(sleep).not.toHaveBeenCalled();
});

test.each([
  ['a non-transient code', coded('ENOENT')],
  ['an uncoded error', new Error('private-path-canary')],
])('fails immediately on %s', (_label, failure) => {
  fault.failures = [failure];
  const sleep = vi.fn();
  expect(() => renameWithTransientRetry('from', 'to', { platform: 'win32', sleep })).toThrow(
    failure as Error,
  );
  expect(fault.calls).toBe(1);
  expect(sleep).not.toHaveBeenCalled();
});
