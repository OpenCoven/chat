import { APP_DISPLAY_NAME, APP_PHASE } from './app-metadata';
import {
  canUseTauriCommands,
  desktopHost,
  type InvokeCommand,
  isAppIdentity,
  previewAppIdentity,
  readAppIdentity,
} from './desktop-host';

const NATIVE_APP_IDENTITY = Object.freeze({
  name: APP_DISPLAY_NAME,
  identifier: 'ai.opencoven.chat',
  phase: APP_PHASE,
});

describe('desktop host bridge', () => {
  it('accepts the typed app_identity payload', () => {
    expect(isAppIdentity(NATIVE_APP_IDENTITY)).toBe(true);
  });

  it('rejects malformed app_identity payloads', () => {
    expect(isAppIdentity(null)).toBe(false);
    expect(isAppIdentity({})).toBe(false);
    expect(isAppIdentity({ ...NATIVE_APP_IDENTITY, phase: 0 })).toBe(false);
  });

  it('reads the non-secret app identity through the single registered command', async () => {
    const invokeCommand = vi.fn<InvokeCommand>().mockResolvedValue(NATIVE_APP_IDENTITY);

    await expect(readAppIdentity(invokeCommand)).resolves.toEqual(NATIVE_APP_IDENTITY);
    expect(invokeCommand).toHaveBeenCalledWith('app_identity');
  });

  it('rejects invalid command responses', async () => {
    const invokeCommand = vi.fn<InvokeCommand>().mockResolvedValue({
      identifier: NATIVE_APP_IDENTITY.identifier,
    });

    await expect(readAppIdentity(invokeCommand)).rejects.toThrow(
      'The app_identity command returned an invalid result.',
    );
  });

  it('labels the browser preview fallback explicitly', () => {
    expect(previewAppIdentity()).toEqual({
      name: 'OpenCoven Chat (preview)',
      identifier: 'preview-only',
      phase: 'phase-0-scaffold-preview',
    });
  });

  it('reports the browser preview as a non-Tauri environment', () => {
    expect(canUseTauriCommands()).toBe(false);
  });

  it('exposes a frozen default desktop host bridge', () => {
    expect(Object.isFrozen(desktopHost)).toBe(true);
    expect(desktopHost.previewAppIdentity()).toEqual(previewAppIdentity());
  });
});
