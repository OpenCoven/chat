import { Channel } from '@tauri-apps/api/core';
import { describe, expect, it, vi } from 'vitest';
import { chatReachable, createSetup, type SetupReport, setupComplete } from './setup';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
  },
}));

const complete: SetupReport = {
  platform: { ok: true, os: 'linux' },
  coven: { ok: true, version: 'coven 0.4.9' },
  engine: { ok: true },
  signIn: {
    ok: true,
    engine: 'signed-in',
    claude: 'missing',
    chatgpt: 'unknown',
    claudeInstaller: 'curl -fsSL https://claude.ai/install.sh | bash',
  },
  familiar: { ok: true, count: 1 },
};

describe('setup bridge', () => {
  it('returns null outside the desktop app without invoking anything', async () => {
    const invoke = vi.fn();
    expect(await createSetup({ available: () => false, invoke }).check()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('accepts a well-formed report', async () => {
    const invoke = vi.fn().mockResolvedValue(complete);
    expect(await createSetup({ available: () => true, invoke }).check()).toEqual(complete);
    expect(invoke).toHaveBeenCalledWith('setup_check');
  });

  it.each([
    { ...complete, platform: { ok: true } },
    { ...complete, coven: { ok: 'yes' } },
    { ...complete, signIn: { ...complete.signIn, claude: 'maybe' } },
    { ...complete, familiar: { ok: true, count: -1 } },
    { ...complete, familiar: { ok: true, count: 1.5 } },
    { ...complete, signIn: { ...complete.signIn, claudeInstaller: '' } },
    [],
  ])('rejects a malformed report: %j', async (value) => {
    const invoke = vi.fn().mockResolvedValue(value);
    await expect(createSetup({ available: () => true, invoke }).check()).rejects.toThrow(
      'invalid setup report',
    );
  });

  it('passes a native failure through as its message', async () => {
    const invoke = vi.fn().mockRejectedValue('Local Coven is busy. Retry shortly.');
    await expect(createSetup({ available: () => true, invoke }).check()).rejects.toThrow(
      'Local Coven is busy. Retry shortly.',
    );
  });

  it('requires Coven and the engine before the chat is reachable', () => {
    expect(setupComplete(complete)).toBe(true);
    expect(chatReachable(complete)).toBe(true);
    const noFamiliar = { ...complete, familiar: { ok: false, count: 0 } };
    expect(setupComplete(noFamiliar)).toBe(false);
    expect(chatReachable(noFamiliar)).toBe(true);
    expect(chatReachable({ ...complete, engine: { ok: false } })).toBe(false);
    expect(chatReachable({ ...complete, platform: { ok: false, os: 'freebsd' } })).toBe(false);
  });

  it('runs a step through a channel and forwards only well-formed progress', async () => {
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      if (!(args?.onEvent instanceof Channel)) throw new Error('Missing event channel');
      const channel = args.onEvent as unknown as { onmessage: (event: unknown) => void };
      channel.onmessage({ type: 'progress', stage: 'download', received: 5, total: 10 });
      channel.onmessage({ type: 'progress', stage: 'download', received: -1, total: 10 });
      channel.onmessage({ type: 'progress', stage: 'install' });
      channel.onmessage({ type: 'line', text: 'Engine ready' });
      channel.onmessage({ type: 'line', text: 'x'.repeat(600) });
      channel.onmessage({ type: 'secret', text: 'ignored' });
      channel.onmessage({ type: 'link', url: 'https://claude.ai/login?x=1' });
      channel.onmessage({ type: 'link', url: 'javascript:alert(1)' });
      channel.onmessage({ type: 'link', url: 'not a url' });
      return { installed: true };
    });
    const events: unknown[] = [];
    await createSetup({ available: () => true, invoke }).run?.(
      'setup-1',
      'install_coven',
      (event) => events.push(event),
    );
    expect(invoke).toHaveBeenCalledWith('setup_run', {
      runId: 'setup-1',
      step: 'install_coven',
      onEvent: expect.any(Channel),
    });
    expect(events).toEqual([
      { type: 'progress', stage: 'download', received: 5, total: 10 },
      { type: 'progress', stage: 'install' },
      { type: 'line', text: 'Engine ready' },
      { type: 'link', url: 'https://claude.ai/login?x=1' },
    ]);
  });

  it('passes a failed step and a cancel through', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'setup_run') throw 'The engine could not be installed: offline';
      return null;
    });
    const setup = createSetup({ available: () => true, invoke });
    await expect(setup.run?.('setup-2', 'install_engine', () => {})).rejects.toThrow(
      'The engine could not be installed: offline',
    );
    await setup.cancel?.('setup-2');
    expect(invoke).toHaveBeenLastCalledWith('setup_cancel', { runId: 'setup-2' });
  });
});
