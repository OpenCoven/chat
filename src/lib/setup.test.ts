import { describe, expect, it, vi } from 'vitest';
import { chatReachable, createSetup, type SetupReport, setupComplete } from './setup';

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
});
