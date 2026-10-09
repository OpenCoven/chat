import { expect, it, vi } from 'vitest';
import { observeCompanionRuns } from './companion-runs';

it('subscribes before reading and ignores a stale active-run snapshot', async () => {
  let deliver: (event: { payload: unknown }) => void = () => {};
  let resolve: (value: unknown) => void = () => {};
  const invoke = vi.fn(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const received = vi.fn();
  const dispose = vi.fn();
  const promise = observeCompanionRuns(received, {
    available: () => true,
    invoke,
    listen: async (_name, callback) => {
      deliver = callback;
      return dispose;
    },
  });
  await Promise.resolve();
  deliver({ payload: { runId: 'one', familiarId: 'astra', status: 'completed' } });
  resolve({ runId: 'one', familiarId: 'astra', status: 'running' });
  const stop = await promise;
  expect(received).toHaveBeenCalledTimes(1);
  expect(received.mock.calls[0]?.[0].status).toBe('completed');
  stop();
  expect(dispose).toHaveBeenCalledOnce();
});
it('accepts native terminal events with a null event payload', async () => {
  let deliver: (event: { payload: unknown }) => void = () => {};
  const received = vi.fn();
  const stop = await observeCompanionRuns(received, {
    available: () => true,
    invoke: async () => null,
    listen: async (_name, callback) => {
      deliver = callback;
      return () => {};
    },
  });
  deliver({ payload: { runId: 'one', familiarId: 'astra', status: 'completed', event: null } });
  expect(received).toHaveBeenCalledOnce();
  stop();
});
