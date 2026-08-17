import { invoke } from '@tauri-apps/api/core';

import { type AppIdentity, PREVIEW_APP_IDENTITY } from './app-metadata';

export type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type DesktopHost = Readonly<{
  canUseTauriCommands: () => boolean;
  readAppIdentity: () => Promise<AppIdentity>;
  previewAppIdentity: () => AppIdentity;
}>;

const APP_IDENTITY_COMMAND = 'app_identity';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isAppIdentity(value: unknown): value is AppIdentity {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.identifier === 'string' &&
    typeof value.phase === 'string'
  );
}

export async function readAppIdentity(
  invokeCommand: InvokeCommand = invoke as InvokeCommand,
): Promise<AppIdentity> {
  const identity = await invokeCommand(APP_IDENTITY_COMMAND);

  if (!isAppIdentity(identity)) {
    throw new Error('The app_identity command returned an invalid result.');
  }

  return identity;
}

export function canUseTauriCommands() {
  const scope = globalThis as typeof globalThis & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };

  return scope.__TAURI__ !== undefined || scope.__TAURI_INTERNALS__ !== undefined;
}

export function previewAppIdentity(): AppIdentity {
  return PREVIEW_APP_IDENTITY;
}

export const desktopHost: DesktopHost = Object.freeze({
  canUseTauriCommands,
  readAppIdentity,
  previewAppIdentity,
});
