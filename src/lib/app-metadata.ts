export const APP_CONNECTION_STATE = 'Standalone';
export const APP_DISPLAY_NAME = 'OpenCoven Chat';
export const APP_IDENTIFIER = 'ai.opencoven.chat';
/**
 * Mirrors `APP_PHASE` in `src-tauri/src/metadata.rs`, which the conformance lock
 * pins. Changing it here alone would make the TypeScript and native identities
 * disagree, so it moves only alongside a Rust change and a lock repin.
 */
export const APP_PHASE = 'phase-1-read-only-production';
export const APP_VERSION = '0.0.1';

/**
 * Lowercase form of the connection state, used as a styling hook.
 *
 * Derived rather than written twice: a hand-kept duplicate is how the badge
 * ends up styled for a state the app is not in.
 */
export const APP_CONNECTION_STATE_SLUG = APP_CONNECTION_STATE.toLowerCase();

export const APP_CONNECTION_SUMMARY =
  'Standalone — chat is stored on this device. Pair with Cave inside the desktop app to also browse canonical Cave data, read-only.';

export const APP_SCAFFOLD_STATUS =
  'v0.0.1 ships standalone local chat with optional Cave pairing for read-only canonical data. Demo routes remain available at ?demo=chat and ?demo=minimal.';

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
  identifier: APP_IDENTIFIER,
  version: APP_VERSION,
  fingerprint: `${APP_IDENTIFIER}:${APP_PHASE}:${APP_VERSION}`,
});
