import { describe, expect, it, vi } from 'vitest';
import { createCompanion } from './companion';

describe('companion native boundary', () => {
  it('does not invoke native commands in the browser', async () => {
    const invoke = vi.fn();
    const client = createCompanion({ available: () => false, invoke });
    await expect(client.status()).rejects.toThrow('desktop app');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('invokes only explicit lifecycle commands', async () => {
    const invoke = vi.fn().mockResolvedValue({ enabled: false });
    const client = createCompanion({ available: () => true, invoke });
    await client.status();
    await client.enable();
    await client.disable();
    await client.forget();
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      'companion_status',
      'companion_enable',
      'companion_disable',
      'companion_forget',
    ]);
  });
  it('rejects malformed native state and never repeats a secret in an error', async () => {
    const client = createCompanion({
      available: () => true,
      invoke: vi.fn().mockResolvedValue({ enabled: 'yes', pairingLink: 'secret' }),
    });
    await expect(client.status()).rejects.toThrow('invalid');
  });
});
