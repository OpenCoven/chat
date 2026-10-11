import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/**
 * Display preferences the reader sets in Settings. They describe how this
 * window looks, never what was said, so they may live in browser storage
 * (SECURITY.md keeps conversation content out of it).
 */
export type TextSize = 'compact' | 'default' | 'large' | 'larger';

export type Preferences = Readonly<{
  textSize: TextSize;
  /** Fold consecutive tool calls into one summary line. */
  groupTools: boolean;
}>;

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

export const DEFAULT_PREFERENCES: Preferences = { textSize: 'default', groupTools: true };

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
