export const APP_CONNECTION_STATE = 'Unavailable';
export const APP_DISPLAY_NAME = 'OpenCoven Chat';
export const APP_PHASE = 'phase-0-scaffold';
export const APP_VERSION = '0.1.0';

/**
 * Lowercase form of the connection state, used as a styling hook.
 *
 * Derived rather than written twice: a hand-kept duplicate is how the badge
 * ends up styled for a state the app is not in.
 */
export const APP_CONNECTION_STATE_SLUG = APP_CONNECTION_STATE.toLowerCase();

export const APP_CONNECTION_SUMMARY =
  'Unavailable — Phase 0 intentionally does not connect to Cave yet.';

export const APP_SCAFFOLD_STATUS =
  'Application scaffold ready. Pairing, canonical reads, and chat behavior are intentionally not implemented.';

export type AppIdentity = Readonly<{
  name: string;
  identifier: string;
  phase: string;
}>;

export const PREVIEW_APP_IDENTITY: AppIdentity = Object.freeze({
  name: `${APP_DISPLAY_NAME} (preview)`,
  identifier: 'preview-only',
  phase: `${APP_PHASE}-preview`,
});

export const APP_METADATA = Object.freeze({
  name: APP_DISPLAY_NAME,
  version: APP_VERSION,
  fingerprint: 'ai.opencoven.chat:phase-0-scaffold:0.1.0',
});
