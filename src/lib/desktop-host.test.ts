import { APP_DISPLAY_NAME, APP_PHASE } from './app-metadata';
import {
  canUseTauriCommands,
  desktopHost,
  type InvokeCommand,
  isAppIdentity,
  isInstallationId,
  previewAppIdentity,
  readAppIdentity,
  readInstallationId,
} from './desktop-host';

const NATIVE_APP_IDENTITY = Object.freeze({
  name: APP_DISPLAY_NAME,
  identifier: 'ai.opencoven.chat',
  phase: APP_PHASE,
});
const INSTALLATION_ID = '0b59fec4-5d8e-4d5c-894d-39fcb5f3eef7';

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

  it('accepts only canonical lowercase UUID v4 installation IDs', () => {
    expect(isInstallationId(INSTALLATION_ID)).toBe(true);
    expect(isInstallationId('0B59FEC4-5D8E-4D5C-894D-39FCB5F3EEF7')).toBe(false);
    expect(isInstallationId('f47ac10b-58cc-11cf-8f0b-08002be10318')).toBe(false);
    expect(isInstallationId('0b59fec4-5d8e-4d5c-794d-39fcb5f3eef7')).toBe(false);
    expect(isInstallationId({ installationId: INSTALLATION_ID })).toBe(false);
  });

  it('reads the installation ID through only the registered native command', async () => {
    const invokeCommand = vi.fn<InvokeCommand>().mockResolvedValue(INSTALLATION_ID);

    await expect(readInstallationId(invokeCommand)).resolves.toBe(INSTALLATION_ID);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith('app_installation_id');
  });

  it('rejects invalid installation ID command responses without exposing them', async () => {
    const invokeCommand = vi
      .fn<InvokeCommand>()
      .mockResolvedValue('0B59FEC4-5D8E-4D5C-894D-39FCB5F3EEF7');

    await expect(readInstallationId(invokeCommand)).rejects.toThrow(
      'The app_installation_id command returned an invalid result.',
    );
  });

  it('labels the browser preview fallback explicitly', () => {
    expect(previewAppIdentity()).toEqual({
      name: 'OpenCoven Chat (preview)',
      identifier: 'preview-only',
      phase: 'phase-1-read-only-production-preview',
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
