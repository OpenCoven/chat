import { APP_IDENTITY } from './app-metadata';
import {
  canUseTauriCommands,
  type InvokeCommand,
  isAppIdentity,
  readAppIdentity,
} from './desktop-host';

describe('desktop host bridge', () => {
  it('accepts the typed app_identity payload', () => {
    expect(isAppIdentity(APP_IDENTITY)).toBe(true);
  });

  it('rejects malformed app_identity payloads', () => {
    expect(isAppIdentity(null)).toBe(false);
    expect(isAppIdentity({})).toBe(false);
    expect(isAppIdentity({ ...APP_IDENTITY, phase: 0 })).toBe(false);
  });

  it('reads the non-secret app identity through the single registered command', async () => {
    const invokeCommand = vi.fn<InvokeCommand>().mockResolvedValue(APP_IDENTITY);

    await expect(readAppIdentity(invokeCommand)).resolves.toEqual(APP_IDENTITY);
    expect(invokeCommand).toHaveBeenCalledWith('app_identity');
  });

  it('rejects invalid command responses', async () => {
    const invokeCommand = vi.fn<InvokeCommand>().mockResolvedValue({
      identifier: APP_IDENTITY.identifier,
    });

    await expect(readAppIdentity(invokeCommand)).rejects.toThrow(
      'The app_identity command returned an invalid result.',
    );
  });

  it('reports the browser preview as a non-Tauri environment', () => {
    expect(canUseTauriCommands()).toBe(false);
  });
});
