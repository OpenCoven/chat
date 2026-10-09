import { invoke } from '@tauri-apps/api/core';
import { canUseTauriCommands, type InvokeCommand } from './desktop-host';

export type CompanionStatus = { enabled: boolean; pairingLink?: string; error?: string };
export interface Companion {
  status(): Promise<CompanionStatus>;
  enable(): Promise<CompanionStatus>;
  disable(): Promise<CompanionStatus>;
  forget(): Promise<CompanionStatus>;
}

export function createCompanion(
  options: { available?: () => boolean; invoke?: InvokeCommand } = {},
): Companion {
  async function call(command: string): Promise<CompanionStatus> {
    if (!(options.available ?? canUseTauriCommands)())
      throw new Error('iPhone pairing requires the desktop app.');
    const value = await (options.invoke ?? invoke)(command);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('enabled' in value) ||
      typeof value.enabled !== 'boolean' ||
      ('pairingLink' in value &&
        (typeof value.pairingLink !== 'string' ||
          value.pairingLink.length > 2048 ||
          !value.pairingLink.startsWith('coven-chat://pair?'))) ||
      ('error' in value && (typeof value.error !== 'string' || value.error.length > 2048))
    )
      throw new Error('The desktop returned an invalid companion status.');
    return value as CompanionStatus;
  }
  return {
    status: () => call('companion_status'),
    enable: () => call('companion_enable'),
    disable: () => call('companion_disable'),
    forget: () => call('companion_forget'),
  };
}
export const defaultCompanion = createCompanion();
