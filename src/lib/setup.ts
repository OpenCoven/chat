import { invoke } from '@tauri-apps/api/core';
import { canUseTauriCommands, type InvokeCommand } from './desktop-host';

/** Whether one route to a model provider is usable. */
export type SignInState = 'signed-in' | 'signed-out' | 'missing' | 'unknown';
/** What a person still needs before Chat can hold a conversation. */
export type SetupReport = {
  platform: { ok: boolean; os: string };
  coven: { ok: boolean; version?: string };
  engine: { ok: boolean };
  /**
   * `engine` is the engine's own sign-in, `claude` a Claude subscription,
   * `chatgpt` ChatGPT. `claudeInstaller` is the command that installs Claude
   * Code on this platform, for the person to run.
   */
  signIn: {
    ok: boolean;
    engine: SignInState;
    claude: SignInState;
    chatgpt: SignInState;
    claudeInstaller: string;
  };
  familiar: { ok: boolean; count: number };
};
export type Setup = {
  /** `null` outside the desktop app, where there is nothing to set up. */
  check(): Promise<SetupReport | null>;
};

const SIGN_IN_STATES: readonly string[] = ['signed-in', 'signed-out', 'missing', 'unknown'];
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function step(value: unknown): value is Record<string, unknown> & { ok: boolean } {
  return record(value) && typeof value.ok === 'boolean';
}
function report(value: unknown): value is SetupReport {
  if (!record(value)) return false;
  const { platform, coven, engine, signIn, familiar } = value;
  return (
    step(platform) &&
    typeof platform.os === 'string' &&
    platform.os.length <= 32 &&
    step(coven) &&
    (coven.version === undefined ||
      (typeof coven.version === 'string' && coven.version.length <= 256)) &&
    step(engine) &&
    step(signIn) &&
    ['engine', 'claude', 'chatgpt'].every(
      (route) => typeof signIn[route] === 'string' && SIGN_IN_STATES.includes(signIn[route]),
    ) &&
    typeof signIn.claudeInstaller === 'string' &&
    signIn.claudeInstaller.length > 0 &&
    signIn.claudeInstaller.length <= 256 &&
    step(familiar) &&
    Number.isSafeInteger(familiar.count) &&
    (familiar.count as number) >= 0
  );
}

/** Every step is done: Chat can open on a conversation. */
export function setupComplete(value: SetupReport): boolean {
  return (
    value.platform.ok && value.coven.ok && value.engine.ok && value.signIn.ok && value.familiar.ok
  );
}

/**
 * Coven and its engine are the hard requirements: without them Chat cannot
 * reach anything. Sign-in and familiars can be finished from inside Chat, and
 * a sign-in this check cannot see (an API key in the environment, say) must
 * not lock a working setup out.
 */
export function chatReachable(value: SetupReport): boolean {
  return value.platform.ok && value.coven.ok && value.engine.ok;
}

export function createSetup(
  options: { available?: () => boolean; invoke?: InvokeCommand } = {},
): Setup {
  const available = options.available ?? canUseTauriCommands;
  const invokeCommand = options.invoke ?? invoke;
  return {
    async check() {
      if (!available()) return null;
      let value: unknown;
      try {
        value = await invokeCommand('setup_check');
      } catch (error) {
        const message =
          error instanceof Error ? error.message : typeof error === 'string' ? error : '';
        throw new Error(message.slice(0, 2048) || 'Chat could not check your setup.');
      }
      if (!report(value)) throw new Error('Chat received an invalid setup report.');
      return value;
    },
  };
}
