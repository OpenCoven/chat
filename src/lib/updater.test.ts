import { describe, expect, it, vi } from 'vitest';
import { createUpdater, createUpdateStore, type Updater } from './updater';

describe('updater native boundary', () => {
  it('does not invoke native commands in the browser', async () => {
    const invoke = vi.fn();
    const updater = createUpdater({ available: () => false, invoke });
    await expect(updater.check()).rejects.toThrow('desktop app');
    await expect(updater.install()).rejects.toThrow('desktop app');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('invokes only the two update commands', async () => {
    const invoke = vi.fn().mockResolvedValue({ available: false, currentVersion: '0.0.5' });
    const updater = createUpdater({ available: () => true, invoke });
    await updater.check();
    await updater.install();
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(['updater_check', 'updater_install']);
  });

  it('accepts a well-formed check and rejects anything else', async () => {
    const check = (value: unknown) =>
      createUpdater({ available: () => true, invoke: vi.fn().mockResolvedValue(value) }).check();
    await expect(
      check({ available: true, currentVersion: '0.0.5', version: '0.0.6', notes: null }),
    ).resolves.toEqual({ available: true, currentVersion: '0.0.5', version: '0.0.6' });
    for (const bad of [
      null,
      { available: true, currentVersion: '0.0.5' },
      { available: true, currentVersion: '0.0.5', version: 'latest' },
      { available: false, currentVersion: '../../x' },
      { available: true, currentVersion: '0.0.5', version: '0.0.6', notes: 'x'.repeat(9000) },
    ])
      await expect(check(bad)).rejects.toThrow('invalid update check');
  });
});

function fakeUpdater(overrides: Partial<Updater> = {}): Updater {
  return {
    check: vi.fn().mockResolvedValue({ available: false, currentVersion: '0.0.5' }),
    install: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('update store', () => {
  it('reports the newest version and installs only an offered update', async () => {
    const updater = fakeUpdater({
      check: vi.fn().mockResolvedValue({
        available: true,
        currentVersion: '0.0.5',
        version: '0.0.6',
        notes: 'Faster replies.',
      }),
    });
    const store = createUpdateStore(updater);
    await store.install();
    expect(updater.install).not.toHaveBeenCalled();
    await store.check();
    expect(store.state()).toEqual({
      kind: 'available',
      currentVersion: '0.0.5',
      version: '0.0.6',
      notes: 'Faster replies.',
    });
    const install = store.install();
    expect(store.state()).toEqual({ kind: 'installing', version: '0.0.6' });
    await install;
    expect(updater.install).toHaveBeenCalledOnce();
  });

  it('shows the first paragraph of a failure and keeps the rest for Copy', async () => {
    const detail =
      "Chat couldn't check for updates. Check your internet connection, then try again.\n\nDetails: dns error";
    const store = createUpdateStore(
      fakeUpdater({ check: vi.fn().mockRejectedValue(new Error(detail)) }),
    );
    await store.check();
    expect(store.state()).toEqual({
      kind: 'failed',
      message: "Chat couldn't check for updates. Check your internet connection, then try again.",
      detail,
      retry: 'check',
    });
  });

  it('leaves no failure behind after a quiet check', async () => {
    const store = createUpdateStore(
      fakeUpdater({ check: vi.fn().mockRejectedValue(new Error('offline')) }),
    );
    await store.check({ quiet: true });
    expect(store.state()).toEqual({ kind: 'idle' });
  });

  it('notifies subscribers and stops after unsubscribing', async () => {
    const store = createUpdateStore(fakeUpdater());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await store.check();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.state()).toEqual({ kind: 'current', version: '0.0.5' });
    unsubscribe();
    await store.check();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('reports a failed install, never a silent one', async () => {
    const store = createUpdateStore(
      fakeUpdater({
        check: vi.fn().mockResolvedValue({
          available: true,
          currentVersion: '0.0.5',
          version: '0.0.6',
        }),
        install: vi
          .fn()
          .mockRejectedValue(
            new Error('Finish or stop the current reply first, then restart to update.'),
          ),
      }),
    );
    await store.check();
    await store.install();
    expect(store.state()).toMatchObject({
      kind: 'failed',
      message: 'Finish or stop the current reply first, then restart to update.',
      retry: 'install',
    });
  });
});
