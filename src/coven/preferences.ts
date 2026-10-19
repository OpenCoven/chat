import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { INSPECTOR_DEFAULT_WIDTH, preferredInspectorWidth } from './inspector-width';

/**
 * Preferences the reader sets in Settings: how this window looks, and which
 * harness, model, reasoning and speed its messages ask for. None of them is
 * anything that was said, so they may live in browser storage (SECURITY.md
 * keeps conversation content out of it).
 */
export type TextSize = 'compact' | 'default' | 'large' | 'larger';

/** Harnesses Chat sends to: the ids `coven run <harness>` and the host accept. */
export type Harness = 'coven-code' | 'codex' | 'claude';
/** `coven run --speed`; `default` sends no hint and leaves the harness to choose. */
export type Speed = 'default' | 'fast' | 'balanced' | 'thorough';

export type Preferences = Readonly<{
  textSize: TextSize;
  /** Fold consecutive tool calls into one summary line. */
  groupTools: boolean;
  /** The inspector rail's preferred width in CSS pixels, a number and nothing more. */
  inspectorWidth: number;
  /** The harness a familiar's chat starts on. An existing chat keeps its own. */
  harness: Harness;
  /** Passed as `coven run --model`; empty leaves the harness on its own default. */
  model: string;
  /** Ask for deeper reasoning (`coven run --think`). */
  think: boolean;
  /** Latency and reasoning hint (`coven run --speed`). */
  speed: Speed;
}>;

export const HARNESSES: readonly Harness[] = ['coven-code', 'codex', 'claude'];

export const HARNESS_LABEL: Readonly<Record<Harness, string>> = {
  'coven-code': 'Coven Code',
  codex: 'Codex',
  claude: 'Claude Code',
};

/** A harness id as the reader knows it; an id Chat has no name for is shown as is. */
export function harnessLabel(harness: string): string {
  return HARNESSES.includes(harness as Harness) ? HARNESS_LABEL[harness as Harness] : harness;
}

export const SPEEDS: readonly Speed[] = ['default', 'fast', 'balanced', 'thorough'];

export const SPEED_LABEL: Readonly<Record<Speed, string>> = {
  default: 'Default',
  fast: 'Fast',
  balanced: 'Balanced',
  thorough: 'Thorough',
};

/** The longest model id Chat stores or sends. */
export const MODEL_MAX = 200;

/**
 * A model id is empty (the harness's default) or a token that starts with a
 * letter or digit and holds only the characters a provider-qualified id uses
 * (`openai/gpt-5.5`). Nothing it allows can read as an option. The host checks
 * the same rule (`valid_model` in `src-tauri/src/coven_runtime.rs`).
 */
export function isValidModel(value: string): boolean {
  return value === '' || (value.length <= MODEL_MAX && /^[A-Za-z0-9][\w./:+-]*$/.test(value));
}

export const TEXT_SIZES: readonly TextSize[] = ['compact', 'default', 'large', 'larger'];

export const TEXT_SIZE_LABEL: Readonly<Record<TextSize, string>> = {
  compact: 'Compact',
  default: 'Default',
  large: 'Large',
  larger: 'Larger',
};

/** Transcript scale per size, applied as `--coven-text-scale`. */
export const TEXT_SCALE: Readonly<Record<TextSize, number>> = {
  compact: 0.92,
  default: 1,
  large: 1.1,
  larger: 1.22,
};

export const DEFAULT_PREFERENCES: Preferences = {
  textSize: 'default',
  groupTools: true,
  inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
  harness: 'coven-code',
  model: '',
  think: false,
  speed: 'default',
};

export const PREFERENCES_KEY = 'opencoven.chat.preferences.v1';

/** Stored preferences, each field falling back to its default when absent or malformed. */
export function readPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (raw === null) return DEFAULT_PREFERENCES;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || !value) return DEFAULT_PREFERENCES;
    const record = value as Record<string, unknown>;
    return {
      textSize: TEXT_SIZES.includes(record.textSize as TextSize)
        ? (record.textSize as TextSize)
        : DEFAULT_PREFERENCES.textSize,
      groupTools:
        typeof record.groupTools === 'boolean' ? record.groupTools : DEFAULT_PREFERENCES.groupTools,
      inspectorWidth: preferredInspectorWidth(record.inspectorWidth),
      harness: HARNESSES.includes(record.harness as Harness)
        ? (record.harness as Harness)
        : DEFAULT_PREFERENCES.harness,
      model:
        typeof record.model === 'string' && isValidModel(record.model)
          ? record.model
          : DEFAULT_PREFERENCES.model,
      think: typeof record.think === 'boolean' ? record.think : DEFAULT_PREFERENCES.think,
      speed: SPEEDS.includes(record.speed as Speed)
        ? (record.speed as Speed)
        : DEFAULT_PREFERENCES.speed,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function writePreferences(preferences: Preferences) {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Storage can be unavailable; the choice still holds for this window.
  }
}

/** The window's preferences and a setter that keeps storage in step. */
export function useStoredPreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  // Written only once the reader changes something, so an untouched window
  // leaves storage as it found it.
  const initial = useRef(preferences);
  useEffect(() => {
    if (preferences !== initial.current) writePreferences(preferences);
  }, [preferences]);
  const update = useCallback(
    (patch: Partial<Preferences>) => setPreferences((previous) => ({ ...previous, ...patch })),
    [],
  );
  return [preferences, update] as const;
}

export const PreferencesContext = createContext<Preferences>(DEFAULT_PREFERENCES);

export function usePreferences(): Preferences {
  return useContext(PreferencesContext);
}

/** What the reader asked messages to run with. */
export type RunOptions = Readonly<Pick<Preferences, 'harness' | 'model' | 'think' | 'speed'>>;

export function runOptions(preferences: Preferences): RunOptions {
  const { harness, model, think, speed } = preferences;
  return { harness, model, think, speed };
}

/**
 * Harnesses that honour `--think` and `--speed`. Coven 0.4.10 declares neither
 * for Codex: it ignores both with a warning Chat never sees, so Chat doesn't
 * send them there.
 */
const REASONING_HARNESSES: ReadonlySet<string> = new Set(['coven-code', 'claude']);

/** The harness a message will run on: an existing chat's own, or the preference. */
function runsOn(options: RunOptions, chatHarness?: string): string {
  return chatHarness ?? options.harness;
}

/**
 * The run fields one send carries. The harness is named only when a chat
 * starts, since an existing chat keeps its own. Defaults are left out, so the
 * harness decides. Codex is never sent reasoning or speed.
 */
export function sendOptions(
  options: RunOptions,
  chatHarness?: string,
): { harness?: Harness; model?: string; think?: boolean; speed?: Exclude<Speed, 'default'> } {
  const harness = runsOn(options, chatHarness);
  const reasoning = REASONING_HARNESSES.has(harness);
  return {
    ...(chatHarness === undefined && options.harness !== 'coven-code'
      ? { harness: options.harness }
      : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(reasoning && options.think ? { think: true } : {}),
    ...(reasoning && options.speed !== 'default' ? { speed: options.speed } : {}),
  };
}

/** Only Coven Code takes attached files; the host refuses them for the others. */
export function canAttach(options: RunOptions, chatHarness?: string): boolean {
  return runsOn(options, chatHarness) === 'coven-code';
}
