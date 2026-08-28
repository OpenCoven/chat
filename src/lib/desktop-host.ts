import { invoke } from '@tauri-apps/api/core';

import { type AppIdentity, PREVIEW_APP_IDENTITY } from './app-metadata';

export type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type DesktopHost = Readonly<{
  canUseTauriCommands: () => boolean;
  readAppIdentity: () => Promise<AppIdentity>;
  readInstallationId: () => Promise<string>;
  previewAppIdentity: () => AppIdentity;
}>;

const APP_IDENTITY_COMMAND = 'app_identity';
const APP_INSTALLATION_ID_COMMAND = 'app_installation_id';
const INSTALLATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

export function isInstallationId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && INSTALLATION_ID_PATTERN.test(value);
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

export async function readInstallationId(
  invokeCommand: InvokeCommand = invoke as InvokeCommand,
): Promise<string> {
  const installationId = await invokeCommand(APP_INSTALLATION_ID_COMMAND);

  if (!isInstallationId(installationId)) {
    throw new Error('The app_installation_id command returned an invalid result.');
  }

  return installationId;
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
  readInstallationId,
  previewAppIdentity,
});
