export const APP_CONNECTION_STATE = 'Unavailable';

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

export const APP_IDENTITY: AppIdentity = Object.freeze({
  name: 'OpenCoven Chat',
  identifier: 'ai.opencoven.chat',
  phase: 'phase-0-scaffold',
});

export const APP_METADATA = Object.freeze({
  ...APP_IDENTITY,
  version: '0.1.0',
  fingerprint: 'ai.opencoven.chat:phase-0-scaffold:0.1.0',
});
